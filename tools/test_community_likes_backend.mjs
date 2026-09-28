import assert from 'node:assert/strict';
import { SqliteD1 as SqliteD1Base, readMigrations } from './sqlite-d1-test-harness.mjs';

import { onRequestGet as communityGet } from '../functions/api/community.js';
import { onRequestPut as likePut, onRequestDelete as likeDelete } from '../functions/api/community-likes/[id].js';
import { onRequestGet as adminGet, onRequestPost as adminPost } from '../functions/api/admin/community/[[path]].js';
import { purgeCommunityLikes } from '../functions/_engagements.js';

const MIGRATION = await readMigrations('0001_community_likes.sql', '0002_engagement_tombstones.sql');
const HTTPS_ORIGIN = 'https://likes.example.test';

class SqliteD1 extends SqliteD1Base {
  constructor() { super(MIGRATION); }
}

class MemoryR2 {
  constructor() { this.objects = new Map(); }
  async get(key) {
    if (!this.objects.has(key)) return null;
    const value = this.objects.get(key);
    const raw = typeof value === 'string' ? value : new TextDecoder().decode(value);
    return {
      json: async () => JSON.parse(raw),
      body: typeof value === 'string' ? new TextEncoder().encode(value) : value,
      httpMetadata: { contentType: key.endsWith('.json') ? 'application/json' : 'image/jpeg' },
    };
  }
  async put(key, value) {
    if (typeof value === 'string') this.objects.set(key, value);
    else this.objects.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
  async list({ prefix }) {
    return {
      objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })),
      truncated: false,
    };
  }
}

function makeFixture() {
  const bucket = new MemoryR2();
  const db = new SqliteD1();
  const env = {
    STRINGS_BUCKET: bucket,
    STRINGS_PUBLIC_BASE: 'https://cdn.example.test',
    ADMIN_TOKEN: 'test-token',
    COMMUNITY_DB: db,
    COMMUNITY_LIKES_ENABLED: 'true',
    ENGAGEMENT_COOKIE_SECRET: 'cookie-secret-for-tests-32-bytes-minimum',
    RATE_LIMIT_SALT: 'rate-limit-salt-for-tests',
  };
  return { bucket, db, env };
}

function record(id, status = 'approved', fields = {}) {
  return {
    id, status, title: fields.title || `投稿 ${id}`, prompt: 'test prompt', category: ['画风'],
    images: fields.images || [], createdAt: Date.now(), updatedAt: Date.now(), ...fields,
  };
}

async function seedRecord(bucket, id, status = 'approved', fields = {}) {
  await bucket.put(`community/${status}/${id}.json`, JSON.stringify(record(id, status, fields)));
}

async function seedAggregate(bucket, ids) {
  const entries = [];
  for (const id of ids) {
    const object = await bucket.get(`community/approved/${id}.json`);
    if (object) entries.push(await object.json());
  }
  await bucket.put('community/community.json', JSON.stringify({ title: '共创广场', entries }));
}

function likeContext(env, method, id, { origin = HTTPS_ORIGIN, cookie = '', ip = '203.0.113.10', base = HTTPS_ORIGIN } = {}) {
  const headers = { accept: 'application/json', 'cf-connecting-ip': ip };
  if (origin != null) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  return {
    env,
    params: { id },
    request: new Request(`${base}/api/community-likes/${id}`, { method, headers }),
  };
}

function communityContext(env, cookie = '') {
  const headers = cookie ? { cookie } : {};
  return { env, request: new Request(`${HTTPS_ORIGIN}/api/community`, { headers }) };
}

function adminContext(env, method, path, body) {
  const options = { method, headers: { authorization: 'Bearer test-token' } };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return {
    env,
    params: { path: path ? [path] : [] },
    request: new Request(`${HTTPS_ORIGIN}/api/admin/community/${path || ''}`, options),
  };
}

async function body(response, expectedStatus = 200) {
  const data = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(data));
  return data;
}

function cookiePair(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

const fixture = makeFixture();
const { bucket, db, env } = fixture;
const ID_A = '10000001';
const ID_B = '10000002';
const ID_C = '10000003';
const ID_D = '10000004';
await seedRecord(bucket, ID_A, 'approved', { images: [{ key: `community/img/${ID_A}/1.jpg` }] });
await seedRecord(bucket, ID_B);
await seedRecord(bucket, ID_C);
await seedRecord(bucket, ID_D);
await bucket.put(`community/img/${ID_A}/1.jpg`, new Uint8Array([1, 2, 3]));
await seedAggregate(bucket, [ID_A, ID_B, ID_C, ID_D]);

// GET 兼容旧的无 request 调用；字段固定存在，且查询按 entry ids 分块。
{
  const data = await body(await communityGet({ env }));
  assert.equal(data.features.likes, true);
  assert.equal(data.entries[0].likeCount, 0);
  assert.equal(data.entries[0].liked, false);
  assert.equal((await communityGet({ env })).headers.get('cache-control'), 'no-store');
}

// Origin/CSRF：缺失或跨域都拒绝，且绝不签发匿名 Cookie。
{
  const missing = await likePut(likeContext(env, 'PUT', ID_A, { origin: null }));
  assert.equal(missing.status, 403);
  assert.equal(missing.headers.get('set-cookie'), null);
  const cross = await likePut(likeContext(env, 'PUT', ID_A, { origin: 'https://evil.example' }));
  assert.equal(cross.status, 403);
}

// 首次成功 PUT 才签发 Cookie；重复 PUT 幂等，trigger 只为真实关系变化写事件。
let actorCookie;
{
  const first = await likePut(likeContext(env, 'PUT', ID_A));
  const firstData = await body(first);
  assert.deepEqual(firstData, { ok: true, id: ID_A, liked: true, likeCount: 1 });
  const setCookie = first.headers.get('set-cookie') || '';
  actorCookie = cookiePair(first);
  assert.match(actorCookie, /^nat_like_actor=v1\./);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const repeated = await likePut(likeContext(env, 'PUT', ID_A, { cookie: actorCookie }));
  assert.equal((await body(repeated)).likeCount, 1);
  assert.equal(repeated.headers.get('set-cookie'), null);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM engagements')[0].n, 1);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM engagement_events')[0].n, 1);
}

// GET 能恢复本设备 liked；篡改签名只失去设备状态，不影响公开计数。
{
  const own = await body(await communityGet(communityContext(env, actorCookie)));
  const ownEntry = own.entries.find(entry => entry.id === ID_A);
  assert.equal(ownEntry.liked, true);
  assert.equal(ownEntry.likeCount, 1);
  const tampered = `${actorCookie.slice(0, -1)}${actorCookie.endsWith('a') ? 'b' : 'a'}`;
  const stranger = await body(await communityGet(communityContext(env, tampered)));
  assert.equal(stranger.entries.find(entry => entry.id === ID_A).liked, false);
  assert.equal(stranger.entries.find(entry => entry.id === ID_A).likeCount, 1);
}

// 无 Cookie DELETE 不创建身份也不删别人关系；本设备 DELETE 与重复 DELETE 均幂等。
{
  const anonymous = await likeDelete(likeContext(env, 'DELETE', ID_A, { ip: '203.0.113.11' }));
  assert.deepEqual(await body(anonymous), { ok: true, id: ID_A, liked: false, likeCount: 1 });
  assert.equal(anonymous.headers.get('set-cookie'), null);

  assert.equal((await body(await likeDelete(likeContext(env, 'DELETE', ID_A, { cookie: actorCookie })))).likeCount, 0);
  assert.equal((await body(await likeDelete(likeContext(env, 'DELETE', ID_A, { cookie: actorCookie })))).likeCount, 0);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM engagement_events')[0].n, 2);
}

// HTTP 本地开发 Cookie 不带 Secure；成功恢复 A 后供统计与 purge 使用。
{
  const local = await likePut(likeContext(env, 'PUT', ID_B, {
    origin: 'http://localhost:8788', base: 'http://localhost:8788', ip: '127.0.0.1',
  }));
  await body(local);
  assert.doesNotMatch(local.headers.get('set-cookie') || '', /; Secure/i);
  await body(await likePut(likeContext(env, 'PUT', ID_A, { cookie: actorCookie })));
}

// 未发布/不存在投稿不可新增喜欢，失败响应不下发刚生成的 Cookie。
{
  await seedRecord(bucket, '20000001', 'hidden');
  const hidden = await likePut(likeContext(env, 'PUT', '20000001', { ip: '203.0.113.12' }));
  assert.equal(hidden.status, 404);
  assert.equal(hidden.headers.get('set-cookie'), null);
}

// purge tombstone 阻止已经读过 R2 approved 的在途 PUT 在清除后重新制造孤儿关系。
{
  await purgeCommunityLikes(env, ID_D);
  const raced = await likePut(likeContext(env, 'PUT', ID_D, { ip: '203.0.113.13' }));
  assert.equal(raced.status, 404);
  assert.equal(raced.headers.get('set-cookie'), null);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM engagements WHERE item_id = ?', ID_D)[0].n, 0);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM engagement_tombstones WHERE item_id = ?', ID_D)[0].n, 1);
}

// 后台聚合：当前关系、独立设备、14 日趋势、Top 10；原内容统计保持不变。
{
  const stats = await body(await adminGet(adminContext(env, 'GET', 'stats')));
  assert.equal(stats.counts.approved, 4);
  assert.equal(stats.likes.available, true);
  assert.equal(stats.likes.total, 2);
  assert.equal(stats.likes.uniqueDevices, 2);
  assert.equal(stats.likes.likedEntries, 2);
  assert.equal(stats.likes.trend14d.length, 14);
  assert.equal(stats.likes.trend14d.at(-1).net, 2);
  assert.deepEqual(new Set(stats.likes.top.map(item => item.id)), new Set([ID_A, ID_B]));
}

// D1 查询失败时公开内容与原后台统计 fail-open，只关闭 likes.available。
{
  const brokenDb = {
    prepare: (...args) => db.prepare(...args),
    batch: async () => { throw new Error('simulated D1 outage'); },
  };
  const brokenEnv = { ...env, COMMUNITY_DB: brokenDb };
  const originalError = console.error;
  console.error = () => {};
  try {
    const publicData = await body(await communityGet(communityContext(brokenEnv, actorCookie)));
    assert.equal(publicData.features.likes, false);
    assert.equal(publicData.entries.length, 4);
    assert.equal(publicData.entries[0].likeCount, 0);
    const adminData = await body(await adminGet(adminContext(brokenEnv, 'GET', 'stats')));
    assert.equal(adminData.total, 5); // 四条 approved + 一条 hidden
    assert.equal(adminData.likes.available, false);
  } finally {
    console.error = originalError;
  }
}

// 每设备 30/10min；第 31 次 429，重复 PUT 仍只产生一条 add 事件。
{
  const rate = makeFixture();
  await seedRecord(rate.bucket, '30000001');
  await seedAggregate(rate.bucket, ['30000001']);
  const first = await likePut(likeContext(rate.env, 'PUT', '30000001', { ip: '198.51.100.30' }));
  await body(first);
  const cookie = cookiePair(first);
  for (let count = 2; count <= 30; count += 1) {
    await body(await likePut(likeContext(rate.env, 'PUT', '30000001', { cookie, ip: '198.51.100.30' })));
  }
  const limited = await likePut(likeContext(rate.env, 'PUT', '30000001', { cookie, ip: '198.51.100.30' }));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(rate.db.rows('SELECT COUNT(*) AS n FROM engagement_events')[0].n, 1);
}

// IP 120/10min：无 Cookie DELETE 也受保护，且永不创建 Cookie。
{
  const rate = makeFixture();
  await seedRecord(rate.bucket, '40000001');
  for (let count = 1; count <= 120; count += 1) {
    const response = await likeDelete(likeContext(rate.env, 'DELETE', '40000001', { ip: '198.51.100.40' }));
    await body(response);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const limited = await likeDelete(likeContext(rate.env, 'DELETE', '40000001', { ip: '198.51.100.40' }));
  assert.equal(limited.status, 429);
}

// 永久 purge 先清 D1，再清 R2；D1 失败时必须中止且保留 R2。
{
  const purged = await body(await adminPost(adminContext(env, 'POST', 'purge', { id: ID_A, status: 'approved' })));
  assert.equal(purged.id, ID_A);
  assert.equal(bucket.objects.has(`community/approved/${ID_A}.json`), false);
  assert.equal(bucket.objects.has(`community/img/${ID_A}/1.jpg`), false);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM engagements WHERE item_id = ?', ID_A)[0].n, 0);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM engagement_stats WHERE item_id = ?', ID_A)[0].n, 0);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM engagement_events WHERE item_id = ?', ID_A)[0].n, 0);
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM engagement_tombstones WHERE item_id = ?', ID_A)[0].n, 1);

  const failingEnv = {
    ...env,
    COMMUNITY_DB: {
      prepare: (...args) => db.prepare(...args),
      batch: async () => { throw new Error('simulated purge outage'); },
    },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const failed = await adminPost(adminContext(failingEnv, 'POST', 'purge', { id: ID_C, status: 'approved' }));
    assert.equal(failed.status, 503);
  } finally {
    console.error = originalError;
  }
  assert.equal(bucket.objects.has(`community/approved/${ID_C}.json`), true);
}

// 未配置 D1/开关时仍兼容旧内存测试：内容正常，功能明确关闭。
{
  const legacyData = await body(await communityGet({ env: { STRINGS_BUCKET: bucket } }));
  assert.equal(legacyData.features.likes, false);
  assert.ok(legacyData.entries.every(entry => entry.likeCount === 0 && entry.liked === false));
}

console.log('community likes backend: PASS');
