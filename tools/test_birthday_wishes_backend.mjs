import assert from 'node:assert/strict';
import { SqliteD1, readMigrations } from './sqlite-d1-test-harness.mjs';
import { onRequestGet, onRequestPost } from '../functions/api/birthday-wishes.js';
import {
  addWishes, readWishTotal, wishWindow, WISH_BATCH_LIMIT, WISH_GLOBAL_REQUEST_LIMIT, WISH_IP_LIMIT,
} from '../functions/_birthday_wishes.js';

const migration = await readMigrations('0006_birthday_wishes.sql');
const previous = await readMigrations('0001_community_likes.sql', '0002_engagement_tombstones.sql',
  '0003_favorites_pickup.sql', '0004_submission_guards.sql', '0005_site_metrics.sql');

// 追加迁移只新建两张表，不碰既有表
const upgraded = new SqliteD1(previous);
const schemaOf = db => db.rows("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'birthday_wish%' ORDER BY name");
const before = schemaOf(upgraded);
upgraded.sqlite.exec(migration);
assert.deepEqual(schemaOf(upgraded), before);

// 生日窗口：UTC+14 进入 27 日起，到 UTC−12 走完 29 日止
const at = iso => Date.parse(iso);
assert.deepEqual(wishWindow(at('2026-10-26T09:59:59.999Z')), { year: '2026', open: false });
assert.deepEqual(wishWindow(at('2026-10-26T10:00:00Z')), { year: '2026', open: true });
assert.deepEqual(wishWindow(at('2026-10-30T11:59:59.999Z')), { year: '2026', open: true });
assert.deepEqual(wishWindow(at('2026-10-30T12:00:00Z')), { year: '2026', open: false });
assert.equal(wishWindow(at('2027-10-28T00:00:00Z')).year, '2027');

const origin = 'https://wishes.example.test';
const now = at('2026-10-28T03:04:05Z');
const request = (ip = '203.0.113.7') => new Request(`${origin}/api/birthday-wishes`, { headers: { 'cf-connecting-ip': ip } });

// 没绑定、没建表：一律 enabled:false
assert.deepEqual(await readWishTotal({}, now), { enabled: false });
assert.deepEqual(await readWishTotal({ COMMUNITY_DB: new SqliteD1('') }, now), { enabled: false });
assert.deepEqual(await addWishes({ COMMUNITY_DB: new SqliteD1('') }, request(), 1, now), { enabled: false });

const db = new SqliteD1(migration);
const env = { COMMUNITY_DB: db, RATE_LIMIT_SALT: 'test-only-salt' };
assert.deepEqual(await readWishTotal(env, now), { enabled: true, open: true, total: 0 });

// 窗口外不收、不写
assert.deepEqual(await addWishes(env, request(), 5, at('2026-11-01T00:00:00Z')), { enabled: true, open: false });
assert.equal(db.rows('SELECT * FROM birthday_wishes').length, 0);

// 累加：同一 UTC 日合一行，跨日分行，总数按年合计
let result = await addWishes(env, request(), 3, now);
assert.equal(result.accepted, true);
assert.equal(result.total, 3);
result = await addWishes(env, request('198.51.100.2'), 5, now + 1000);
assert.equal(result.total, 8);
result = await addWishes(env, request(), 2, at('2026-10-29T01:00:00Z'));
assert.equal(result.total, 10);
assert.deepEqual(db.rows('SELECT day, wish_count FROM birthday_wishes ORDER BY day'),
  [{ day: '2026-10-28', wish_count: 8 }, { day: '2026-10-29', wish_count: 2 }]);
assert.deepEqual(await readWishTotal(env, now), { enabled: true, open: true, total: 10 });
assert.equal((await readWishTotal(env, at('2027-10-28T00:00:00Z'))).total, 0, 'every year starts from zero');

// 限额桶里只有加盐摘要，没有明文 IP
assert.ok(db.rows('SELECT bucket FROM birthday_wish_rate').every(row => !row.bucket.includes('203.0.113.7')));

// 单个 IP 每分钟 WISH_IP_LIMIT 份，超出的那批整批不计；别的 IP 不受影响
const ipDb = new SqliteD1(migration);
const ipEnv = { COMMUNITY_DB: ipDb, RATE_LIMIT_SALT: 'test-only-salt' };
const minute = at('2026-10-28T05:00:00Z');
for (let sent = 0; sent < WISH_IP_LIMIT; sent += WISH_BATCH_LIMIT) {
  assert.equal((await addWishes(ipEnv, request(), WISH_BATCH_LIMIT, minute)).accepted, true);
}
result = await addWishes(ipEnv, request(), 1, minute + 10);
assert.equal(result.accepted, false);
assert.equal(result.total, WISH_IP_LIMIT);
assert.equal((await addWishes(ipEnv, request('198.51.100.9'), 1, minute + 20)).accepted, true);
assert.equal((await addWishes(ipEnv, request(), 1, minute + 60_000)).accepted, true, 'next minute is a fresh bucket');
assert.equal(ipDb.rows('SELECT * FROM birthday_wish_rate WHERE window_start = ?', minute).length, 3);
await addWishes(ipEnv, request(), 1, minute + 120_000);
assert.equal(ipDb.rows('SELECT * FROM birthday_wish_rate WHERE window_start = ?', minute).length, 0, 'buckets are swept two minutes on');

// 全站每分钟 WISH_GLOBAL_REQUEST_LIMIT 个请求；没配盐时只有这一道
const globalDb = new SqliteD1(migration);
const globalEnv = { COMMUNITY_DB: globalDb };
for (let i = 0; i < WISH_GLOBAL_REQUEST_LIMIT; i++) {
  assert.equal((await addWishes(globalEnv, request(`192.0.2.${i % 250}`), 1, minute)).accepted, true);
}
result = await addWishes(globalEnv, request(), 1, minute + 1);
assert.equal(result.accepted, false);
assert.equal(result.retryAfter, 60);
assert.equal(result.total, WISH_GLOBAL_REQUEST_LIMIT);

// HTTP 外壳：同源 JSON、只收 {"count": 1–100}
const post = (body, headers = {}) => onRequestPost({
  env,
  request: new Request(`${origin}/api/birthday-wishes`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }),
});
assert.equal((await post({ count: 1 }, { origin: 'https://other.example.test' })).status, 403);
assert.equal((await post({ count: 1 }, { 'sec-fetch-site': 'cross-site' })).status, 403);
assert.equal((await post({ count: 1 }, { 'content-type': 'text/plain' })).status, 415);
for (const invalid of [{}, { count: 0 }, { count: WISH_BATCH_LIMIT + 1 }, { count: 1.5 }, { count: '3' },
  { count: 1, visitor: 'x' }, [1], '{']) {
  assert.equal((await post(invalid)).status, 400, JSON.stringify(invalid));
}
assert.equal((await post(`{"count":1${' '.repeat(80)}}`)).status, 413);
assert.equal((await post({ count: 1 }, { 'content-length': '9999' })).status, 413);
const disabledGet = await onRequestGet({ env: {} });
assert.deepEqual(await disabledGet.json(), { enabled: false });
assert.equal(disabledGet.headers.get('cache-control'), 'no-store');
const live = await (await onRequestGet({ env })).json();
assert.equal(live.enabled, true);
assert.equal(typeof live.total, 'number');

console.log('PASS birthday wishes backend: additive migration, UTC window, yearly totals, salted per-IP and global limits, strict request shape');
