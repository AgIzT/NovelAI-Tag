import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { readPngTextChunks, PARAMS_INFLATE_LIMITS } from '../functions/_params_core.js';

const NativeDecompressionStream = globalThis.DecompressionStream;
const { chunkBytes, totalBytes } = PARAMS_INFLATE_LIMITS;
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  return bytes;
}
function png(chunks) {
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks, chunk('IEND', Buffer.alloc(0))]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
const compressed = (type, name, bytes) => chunk(type, Buffer.concat([
  Buffer.from(type === 'zTXt' ? `${name}\0\0` : `${name}\0\x01\0\0\0`), bytes,
]));
const plain = () => chunk('tEXt', Buffer.from('Software\0NovelAI'));
const cases = [
  ['mirrored parser stays byte identical', async () => {
    assert.deepEqual(readFileSync(new URL('../functions/_params_core.js', import.meta.url)),
      readFileSync(new URL('../site/assets/community/params-core.js', import.meta.url)));
  }],
  ['twelve discarded oversized blocks share actual decompression budget', async () => {
    const output = [];
    globalThis.DecompressionStream = class {
      constructor(format) {
        const index = output.push(0) - 1;
        const stream = new NativeDecompressionStream(format);
        return { writable: stream.writable, readable: stream.readable.pipeThrough(new TransformStream({
          transform(value, controller) { output[index] += value.byteLength; controller.enqueue(value); },
        })) };
      }
    };
    try {
      const zip = deflateSync(Buffer.alloc(chunkBytes + 1, 65));
      const items = await readPngTextChunks(png([...Array.from({ length: 12 }, (_, i) =>
        compressed(i % 2 ? 'iTXt' : 'zTXt', `bomb${i}`, zip)), plain()]));
      assert.deepEqual(items.map(item => item.keyword), ['Software']);
      assert.ok(output.reduce((sum, n) => sum + n, 0) <= totalBytes + 65536,
        `actual discarded output must count: ${JSON.stringify(output)}`);
      assert.ok(output.length <= 2, 'budget exhaustion must skip later compressed blocks before constructing streams');
    } finally { globalThis.DecompressionStream = NativeDecompressionStream; }
  }],
  ['malformed stream output is charged before failure', async () => {
    let streams = 0;
    globalThis.DecompressionStream = class {
      constructor() {
        streams++;
        let read = 0;
        return { writable: new WritableStream(), readable: new ReadableStream({
          pull(controller) {
            if (read++ === 0) controller.enqueue(new Uint8Array(chunkBytes));
            else controller.error(new TypeError('synthetic corrupt stream after partial output'));
          },
        }) };
      }
    };
    try {
      const items = await readPngTextChunks(png([...Array.from({ length: 12 }, (_, i) =>
        compressed('zTXt', `broken${i}`, Buffer.from([0]))), plain()]));
      assert.deepEqual(items.map(item => item.keyword), ['Software']);
      assert.equal(streams, 2, 'bytes discarded after decompression errors consume the same image budget');
    } finally { globalThis.DecompressionStream = NativeDecompressionStream; }
  }],
  ['exact boundaries retain normal compressed metadata and later plain text', async () => {
    const zip = deflateSync(Buffer.alloc(chunkBytes, 65));
    const items = await readPngTextChunks(png([
      compressed('zTXt', 'one', zip), compressed('iTXt', 'two', zip),
      compressed('zTXt', 'three', deflateSync(Buffer.from('no budget'))), plain(),
    ]));
    assert.deepEqual(items.map(item => item.keyword), ['one', 'two', 'Software']);
    assert.equal(items[0].text.length + items[1].text.length, totalBytes);
  }],
  ['failed cancellation still consumes budget and releases reader locks', async () => {
    const streams = [];
    globalThis.DecompressionStream = class {
      constructor() {
        const readable = new ReadableStream({
          pull(controller) { controller.enqueue(new Uint8Array(chunkBytes + 1)); },
          cancel() { throw new Error('synthetic cancellation failure'); },
        });
        streams.push(readable);
        return { writable: new WritableStream(), readable };
      }
    };
    try {
      await readPngTextChunks(png(Array.from({ length: 12 }, (_, i) => compressed('zTXt', `bomb${i}`, Buffer.from([0])))));
      assert.equal(streams.length, 2);
      assert.ok(streams.every(stream => !stream.locked), 'both cancelled readers must release their locks');
    } finally { globalThis.DecompressionStream = NativeDecompressionStream; }
  }],
  ['early compression error and absent API preserve usable metadata', async () => {
    const good = compressed('iTXt', 'Comment', deflateSync(Buffer.from('{"prompt":"normal"}')));
    assert.deepEqual((await readPngTextChunks(png([compressed('zTXt', 'bad', Buffer.from([0])), good]))).map(item => item.keyword), ['Comment']);
    globalThis.DecompressionStream = undefined;
    try { assert.deepEqual((await readPngTextChunks(png([good, plain()]))).map(item => item.keyword), ['Software']); }
    finally { globalThis.DecompressionStream = NativeDecompressionStream; }
  }],
];
let failed = 0;
for (const [name, test] of cases) {
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(`params inflate budget: ${failed ? 'FAIL' : 'PASS'} (${cases.length - failed}/${cases.length})`);
if (failed) process.exitCode = 1;
