import assert from 'node:assert/strict';
import { SqliteD1, readMigrations } from './sqlite-d1-test-harness.mjs';
import { onRequestGet as wallGet, onRequestPost as wallPost } from '../functions/api/birthday-messages.js';
import { onRequestGet as modGet, onRequestPost as modPost } from '../functions/api/birthday-messages/moderate.js';
import { onRequestGet as adminGet, onRequestPost as adminPost } from '../functions/api/admin/birthday-messages.js';
import {
  submitMessage, readWall, listPending, decideMessage, setWall, adminOverview, messageBlocked, messageKey, cleanMessage,
  MESSAGE_IP_LIMIT, MESSAGE_GLOBAL_LIMIT, WALL_LIMIT,
} from '../functions/_birthday_messages.js';

const previous = await readMigrations('0001_community_likes.sql', '0002_engagement_tombstones.sql', '0003_favorites_pickup.sql',
  '0004_submission_guards.sql', '0005_site_metrics.sql', '0006_birthday_wishes.sql');
const migration = await readMigrations('0007_birthday_messages.sql');

// 追加迁移只新建表，不碰既有表
const upgraded = new SqliteD1(previous);
const schemaOf = db => db.rows("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'birthday_messages%' AND name <> 'birthday_settings' ORDER BY name");
const before = schemaOf(upgraded);
upgraded.sqlite.exec(migration);
assert.deepEqual(schemaOf(upgraded), before);

const fresh = () => new SqliteD1(previous + '\n' + migration);
const origin = 'https://wall.example.test';
const now = Date.parse('2026-10-28T03:04:05Z');
const req = (ip = '203.0.113.7') => new Request(`${origin}/api/birthday-messages`, { headers: { 'cf-connecting-ip': ip } });

// 文字清洗与拒收规则
assert.equal(cleanMessage('  生日\n\n快乐\u200b！ ', 60), '生日 快乐 ！', 'stored text keeps full-width punctuation');
assert.equal(cleanMessage('字'.repeat(61), 60), null);
assert.equal(messageKey('生日快乐！！ 所长'), '生日快乐所长');
for (const bad of ['ｗｗｗ．ａｂｃ．ｃｏｍ', 'ＱＱ群', '看这里 https://x.cn', 'www.abc', '加我 vx', 'qq群 12345678', '电话 138 0000 0000', 'a@b', '去 abc.top 看看']) {
  assert.ok(messageBlocked(bad), bad);
}
for (const ok of ['所长生日快乐！', '祝 10.27 生日快乐', '感谢 2 年的法典', '🎂🎂 生日快乐']) assert.ok(!messageBlocked(ok), ok);

const db = fresh();
const env = { COMMUNITY_DB: db, RATE_LIMIT_SALT: 'test-only-salt', BIRTHDAY_MODERATOR_TOKEN: 'm'.repeat(43), ADMIN_TOKEN: 'admin-test-token' };

// 没绑定一律 enabled:false；墙默认开、空的
assert.deepEqual(await readWall({}, now), { enabled: false });
assert.deepEqual(await readWall(env, now), { enabled: true, wall: true, open: true, total: 0, messages: [] });

// 交留言：过长、空白、引流拒收；窗口外拒收；同样的话合并
assert.equal((await submitMessage(env, req(), { body: '字'.repeat(61) }, now)).reason, 'too_long');
assert.equal((await submitMessage(env, req(), { body: '！！ 。。' }, now)).reason, 'empty');
assert.equal((await submitMessage(env, req(), { body: '加我微信' }, now)).reason, 'blocked');
assert.equal((await submitMessage(env, req(), { body: '生日快乐', name: 'qq群12345' }, now)).reason, 'blocked');
assert.equal((await submitMessage(env, req(), { body: '生日快乐' }, Date.parse('2026-11-02T00:00:00Z'))).reason, 'closed');
assert.equal((await submitMessage(env, req(), { body: '所长生日快乐！', name: '小明' }, now)).accepted, true);
assert.equal((await submitMessage(env, req('198.51.100.2'), { body: '所长 生日快乐' }, now + 1)).accepted, true, 'duplicates still say accepted');
assert.equal(db.rows('SELECT * FROM birthday_messages').length, 1);
assert.equal(db.rows('SELECT status FROM birthday_messages')[0].status, 'pending');
assert.deepEqual((await readWall(env, now)).messages, [], 'pending never shows');

// 每个 IP 每 10 分钟 MESSAGE_IP_LIMIT 条；别的 IP 不受影响；下一个 10 分钟恢复
const rateDb = fresh();
const rateEnv = { ...env, COMMUNITY_DB: rateDb };
for (let i = 0; i < MESSAGE_IP_LIMIT; i++) assert.equal((await submitMessage(rateEnv, req(), { body: `祝福 ${'甲乙丙丁戊'[i]}` }, now)).accepted, true);
assert.equal((await submitMessage(rateEnv, req(), { body: '再来一条' }, now + 1000)).reason, 'rate');
assert.equal((await submitMessage(rateEnv, req('198.51.100.3'), { body: '别人的一条' }, now + 1000)).accepted, true);
assert.equal((await submitMessage(rateEnv, req(), { body: '十分钟后' }, now + 10 * 60_000)).accepted, true);
assert.ok(rateDb.rows('SELECT bucket FROM birthday_wish_rate').every(row => !row.bucket.includes('203.0.113.7')), 'no plain IP');

// 全站每分钟 MESSAGE_GLOBAL_LIMIT 条
const globalDb = fresh();
const globalEnv = { COMMUNITY_DB: globalDb };
for (let i = 0; i < MESSAGE_GLOBAL_LIMIT; i++) assert.equal((await submitMessage(globalEnv, req(), { body: `第 ${String.fromCharCode(0x4e00 + i)} 条` }, now)).accepted, true);
assert.equal((await submitMessage(globalEnv, req(), { body: '超出' }, now)).reason, 'rate');

// 审核 agent：只能改 pending；hold 留给维护者、不上墙
const [first] = (await listPending(env)).messages;
assert.equal(first.body, '所长生日快乐！');
assert.equal((await decideMessage(env, first.id, 'hide', 'agent')).invalid, true, 'agent cannot hide');
assert.equal((await decideMessage(env, first.id, 'approve', 'agent', now + 5000)).changed, true);
assert.equal((await decideMessage(env, first.id, 'reject', 'agent')).changed, false, 'agent cannot touch decided ones');
await submitMessage(env, req('198.51.100.4'), { body: '拿不准的一条' }, now + 6000);
const held = (await listPending(env)).messages[0];
assert.equal((await decideMessage(env, held.id, 'hold', 'agent', now + 7000)).changed, true);
let wall = await readWall(env, now);
assert.deepEqual(wall.messages.map(m => [m.body, m.name]), [['所长生日快乐！', '小明']]);
assert.equal(wall.total, 1);

// 墙按通过时间从新到旧，最多 WALL_LIMIT 条
const many = fresh();
const manyEnv = { COMMUNITY_DB: many };
for (let i = 0; i < WALL_LIMIT + 5; i++) {
  many.sqlite.prepare("INSERT INTO birthday_messages VALUES (?, '2026', ?, '', ?, 'approved', ?, ?, 'agent')")
    .run(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `第${i}条`, `k${i}`, now, now + i);
}
wall = await readWall(manyEnv, now);
assert.equal(wall.messages.length, WALL_LIMIT);
assert.equal(wall.messages[0].body, `第${WALL_LIMIT + 4}条`);
assert.equal(wall.total, WALL_LIMIT + 5);

// 维护者：隐藏已上墙的、看到 held 排最前、整面墙开关
assert.equal((await decideMessage(env, first.id, 'hide', 'admin')).changed, true);
assert.deepEqual((await readWall(env, now)).messages, []);
const overview = await adminOverview(env, now);
assert.equal(overview.messages[0].status, 'held');
assert.equal(overview.counts.hidden, 1);
await setWall(env, false);
assert.deepEqual(await readWall(env, now), { enabled: true, wall: false, open: true, messages: [] });
assert.equal((await submitMessage(env, req('198.51.100.5'), { body: '关墙后' }, now)).reason, 'off');
await setWall(env, true);
assert.equal((await readWall(env, now)).wall, true);

// HTTP 外壳：同源、JSON、字段白名单；审核与管理接口各认各的令牌
const post = (body, headers = {}) => wallPost({ env, request: new Request(`${origin}/api/birthday-messages`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
}) });
assert.equal((await post({ body: '跨站' }, { origin: 'https://other.example.test' })).status, 403);
assert.equal((await post({ body: '跨站' }, { 'content-type': 'text/plain' })).status, 415);
for (const invalid of [{}, { body: 1 }, { body: 'x', name: 2 }, { body: 'x', extra: 'y' }]) assert.equal((await post(invalid)).status, 400);
const gbk = await wallPost({ env, request: new Request(`${origin}/api/birthday-messages`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json' },
  body: new Uint8Array([0x7b, 0x22, 0x62, 0x6f, 0x64, 0x79, 0x22, 0x3a, 0x22, 0xc9, 0xfa, 0xc8, 0xd5, 0x22, 0x7d]),
}) });
assert.equal(gbk.status, 400, 'non-UTF-8 bodies are rejected');
assert.equal((await wallGet({ env: {} })).headers.get('cache-control'), 'no-store');
const auth = (token, path, init = {}) => ({ env, request: new Request(`${origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } }) });
assert.equal((await modGet({ env: { ...env, BIRTHDAY_MODERATOR_TOKEN: '' }, request: new Request(`${origin}/x`) })).status, 503);
assert.equal((await modGet(auth('n'.repeat(43), '/api/birthday-messages/moderate'))).status, 401);
assert.equal((await modGet(auth(env.ADMIN_TOKEN, '/api/birthday-messages/moderate'))).status, 401, 'admin token is not a moderator token');
assert.equal((await modGet(auth(env.BIRTHDAY_MODERATOR_TOKEN, '/api/birthday-messages/moderate'))).status, 200);
assert.equal((await adminGet(auth(env.BIRTHDAY_MODERATOR_TOKEN, '/api/admin/birthday-messages'))).status, 401, 'moderator token is not admin');
assert.equal((await adminGet(auth(env.ADMIN_TOKEN, '/api/admin/birthday-messages'))).status, 200);
const toggle = await adminPost(auth(env.ADMIN_TOKEN, '/api/admin/birthday-messages', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'wall', on: false }),
}));
assert.deepEqual(await toggle.json(), { enabled: true, wall: false });
const badDecision = await modPost(auth(env.BIRTHDAY_MODERATOR_TOKEN, '/api/birthday-messages/moderate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: first.id, decision: 'hide' }),
}));
assert.equal(badDecision.status, 400);

console.log('PASS birthday messages backend: additive migration, pre-moderation, blocked links and contacts, dedupe, per-IP and global limits, scoped moderator, admin hide and wall switch');
