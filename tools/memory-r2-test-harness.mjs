// 内存版 R2：get / head / put / delete / list，以及 ETag / If-None-Match 条件写：
// 条件不满足（版本变了或对象已不存在）时 put 返回 null、不写入。
// afterGet(key) 钩子在「已读到内容、还没返回给调用方」时执行，用来在测试里制造两个操作交错。
// latencyMs > 0 时每次操作先等一会儿，模拟线上网络往返，让并发请求真的能交错。
export class MemoryR2 {
  constructor({ latencyMs = 0 } = {}) {
    this.latencyMs = latencyMs;
    this.objects = new Map();
    this.etags = new Map();
    this.version = 0;
    this.listCalls = 0;
    this.afterGet = null;
  }

  async wait() {
    if (this.latencyMs > 0) await new Promise(resolve => setTimeout(resolve, this.latencyMs));
  }

  async get(key) {
    await this.wait();
    if (!this.objects.has(key)) return null;
    const raw = this.objects.get(key);
    const etag = this.etags.get(key);
    if (this.afterGet) await this.afterGet(key);
    return { key, etag, json: async () => JSON.parse(raw), text: async () => raw };
  }

  async head(key) {
    await this.wait();
    return this.objects.has(key) ? { key, etag: this.etags.get(key) } : null;
  }

  async put(key, value, options = {}) {
    await this.wait();
    const expected = options.onlyIf && options.onlyIf.etagMatches;
    if (expected !== undefined && (!this.objects.has(key) || this.etags.get(key) !== expected)) return null;
    if (options.onlyIf instanceof Headers
        && options.onlyIf.get('If-None-Match') === '*' && this.objects.has(key)) return null;
    // JSON 记录存字符串，图片等二进制存 Uint8Array
    const raw = typeof value === 'string' ? value
      : value instanceof Uint8Array ? value
        : value instanceof ArrayBuffer ? new Uint8Array(value)
          : await new Response(value).text();
    const etag = `v${++this.version}`;
    this.objects.set(key, raw);
    this.etags.set(key, etag);
    return { key, etag };
  }

  async delete(keys) {
    await this.wait();
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
      this.etags.delete(key);
    }
  }

  async list({ prefix }) {
    await this.wait();
    this.listCalls += 1;
    return {
      objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })),
      truncated: false,
    };
  }
}
