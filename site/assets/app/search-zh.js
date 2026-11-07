import { fetchDataJsonResult, getDataSource } from '../data-source.js';
import { normalizeSearchMatchText } from './search.js';

const ROOT = 'tag_zh/search-v1';
const HAN = /[\u3005\u3007\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{323af}]/u;
const BUCKETS = 64;
const WAIT_MS = 2000;
const MAX_REQUESTS = 4;

let cachedRelease;
const buckets = new Map();
const queue = [];
let activeRequests = 0;

// CRC32 over UTF-8, identical to the build tool.
export function searchZhBucket(term) {
  let crc = -1;
  for (const byte of new TextEncoder().encode(term)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ -1) & (BUCKETS - 1)).toString(16).padStart(2, '0');
}

function isMissing(error, source) {
  // A v2 object returning HTTP 404 is a failed download, not a missing manifest entry.
  return error.code === 'missing_logical_file' || (!source.v2 && error.status === 404);
}

async function readBucket(bucket, source, signal) {
  let result;
  try {
    result = await fetchDataJsonResult(`${ROOT}/${bucket}.json`, { signal });
  } catch (error) {
    if (!isMissing(error, source)) throw error;
    // Old releases lack the marker too. A missing shard in a new release is retryable.
    try {
      await fetchDataJsonResult(`${ROOT}/meta.json`, { signal });
    } catch (markerError) {
      if (isMissing(markerError, source)) return null;
      throw markerError;
    }
    throw error;
  }
  const { data, release } = result;
  if (release !== source.release || data?.schema !== 1 || data.bucket !== bucket
      || !data.terms || typeof data.terms !== 'object' || Array.isArray(data.terms)) {
    throw new Error('Invalid Chinese search shard');
  }
  for (const originals of Object.values(data.terms)) {
    if (!Array.isArray(originals) || !originals.length
        || originals.some(tag => typeof tag !== 'string' || !tag.trim())) {
      throw new Error('Invalid Chinese search mapping');
    }
  }
  return data.terms;
}

function drainQueue() {
  while (activeRequests < MAX_REQUESTS && queue.length) {
    const request = queue.shift();
    if (request.signal.aborted) continue;
    activeRequests++;
    request.run().finally(() => {
      activeRequests--;
      drainQueue();
    });
  }
}

function loadBucket(bucket, source) {
  const record = { status: 'loading', terms: null, pending: null };
  const controller = new AbortController();
  record.pending = new Promise(resolve => {
    const finish = (status, terms = null) => {
      record.status = status;
      record.terms = terms;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      finish('failed');
      controller.abort();
    }, WAIT_MS);
    queue.push({
      signal: controller.signal,
      run: async () => {
        try {
          const terms = await readBucket(bucket, source, controller.signal);
          if (!controller.signal.aborted) finish(terms === null ? 'unavailable' : 'ready', terms);
        } catch {
          if (!controller.signal.aborted) finish('failed');
        }
      },
    });
    drainQueue();
  });
  buckets.set(bucket, record);
  return record;
}

export function prepareSearchZh(plan, { retry = false } = {}) {
  if (plan.hasErrors) return null;
  const chinese = plan.positiveTerms.filter(term => HAN.test(term));
  if (!chinese.length) return null;
  const source = getDataSource();
  if (source.release !== cachedRelease) {
    cachedRelease = source.release;
    buckets.clear();
  }
  const translated = new Map();
  const pending = new Set();
  let failed = false;
  for (const term of chinese) {
    const bucket = searchZhBucket(term);
    let record = buckets.get(bucket);
    if (!record || (retry && record.status === 'failed')) record = loadBucket(bucket, source);
    if (record.status === 'loading') pending.add(record.pending);
    if (record.status === 'failed') failed = true;
    if (record.terms && Object.hasOwn(record.terms, term)) {
      const originals = record.terms[term].map(normalizeSearchMatchText).filter(Boolean);
      if (originals.length) translated.set(term, [...new Set(originals)]);
    }
  }
  return { translated, failed, pending: pending.size ? Promise.all(pending) : null };
}
