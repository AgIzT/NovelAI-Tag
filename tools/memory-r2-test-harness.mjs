// 内存版 R2：get / head / put / delete / list，支持 onlyIf 对象或 Headers 的 ETag 条件写。
// 条件不满足时 put 返回 null、不写入；if-none-match: * 只允许对象不存在时创建。
// afterGet(key) 钩子在「已读到内容、还没返回给调用方」时执行，用来在测试里制造两个操作交错。
// latencyMs > 0 时每次操作先等一会儿，模拟线上网络往返，让并发请求真的能交错。
export class MemoryR2 {
  constructor({ latencyMs = 0 } = {}) {
    this.latencyMs = latencyMs;
    this.objects = new Map();
    this.etags = new Map();
    this.metas = new Map();
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
    const httpMetadata = this.metas.get(key);
    if (this.afterGet) await this.afterGet(key);
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return { key, etag, body: raw, httpMetadata, json: async () => JSON.parse(text), text: async () => text };
  }

  async head(key) {
    await this.wait();
    return this.objects.has(key) ? { key, etag: this.etags.get(key) } : null;
  }

  // 派生夹具可同步生成内容 ETag；不得在提交完成后再异步替换 token。
  createEtag(raw) {
    return `v${++this.version}`;
  }

  async put(key, value, options = {}) {
    // JSON 记录存字符串，图片等二进制存 Uint8Array
    const raw = typeof value === 'string' ? value
      : value instanceof Uint8Array ? value
        : value instanceof ArrayBuffer ? new Uint8Array(value)
          : await new Response(value).text();
    await this.wait();
    const conditions = options.onlyIf;
    const expected = conditions instanceof Headers ? conditions.get('if-match') ?? undefined : conditions?.etagMatches;
    const excluded = conditions instanceof Headers ? conditions.get('if-none-match') ?? undefined : conditions?.etagDoesNotMatch;
    const exists = this.objects.has(key);
    const current = this.etags.get(key);
    const matches = condition => String(condition).split(',').some(value => {
      const tag = value.trim();
      return tag === '*' || tag === current || tag === `"${current}"`;
    });
    if (expected !== undefined && (!exists || !matches(expected))) return null;
    if (excluded !== undefined && exists && matches(excluded)) return null;
    // 检查条件到实际写入之间不再 await，模拟 R2 原子的比较并写入。
    const etag = this.createEtag(raw);
    this.objects.set(key, raw);
    this.etags.set(key, etag);
    this.metas.set(key, options.httpMetadata);
    return { key, etag };
  }

  async delete(keys) {
    await this.wait();
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
      this.etags.delete(key);
      this.metas.delete(key);
    }
  }

  async list({ prefix }) {
    await this.wait();
    this.listCalls += 1;
    return {
      objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, etag: this.etags.get(key) })),
      truncated: false,
    };
  }
}
