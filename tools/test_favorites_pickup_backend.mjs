import assert from 'node:assert/strict';

import { SqliteD1, readMigrations } from './sqlite-d1-test-harness.mjs';
import { onRequestPost as createPost } from '../functions/api/favorites-pickup/index.js';
import { onRequestPost as redeemPost } from '../functions/api/favorites-pickup/redeem.js';
import {
  PICKUP_CODE_ALPHABET, PICKUP_MAX_ACTIVE, PICKUP_MAX_PAYLOAD_CHARS, PICKUP_RATE_LIMITS,
  formatPickupCode, generatePickupCode, normalizePickupCode,
} from '../functions/_pickup.js';
import * as frontPickup from '../site/assets/app/favorites-pickup.js';

const MIGRATION = await readMigrations('0001_community_likes.sql', '0002_engagement_tombstones.sql', '0003_favorites_pickup.sql');
const ORIGIN = 'https://pickup.example.test';
const PAYLOAD = 'NAITAG1.H4sIAAAAAAAAA-_example_payload';

function makeEnv(overrides = {}) {
  return {
    FAVORITES_PICKUP_ENABLED: 'true',
    RATE_LIMIT_SALT: 'test-salt',
    COMMUNITY_DB: new SqliteD1(MIGRATION),
    ...overrides,
  };
}

function post(path, body, { origin = ORIGIN, ip = '203.0.113.1', raw } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip };
  if (origin) headers.origin = origin;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: raw ?? JSON.stringify(body),
  });
}

async function create(env, payload = PAYLOAD, options) {
  const response = await createPost({ env, request: post('/api/favorites-pickup', { payload }, options) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function redeem(env, code, options) {
  const response = await redeemPost({ env, request: post('/api/favorites-pickup/redeem', { code }, options) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

// 码格式：8 位、去掉易混字符，输入不区分大小写，空格横线可有可无。
{
  assert.equal(PICKUP_CODE_ALPHABET.length, 32);
  assert.doesNotMatch(PICKUP_CODE_ALPHABET, /[01IO]/);
  for (let n = 0; n < 50; n += 1) {
    const code = generatePickupCode();
    assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    assert.equal(normalizePickupCode(formatPickupCode(code).toLowerCase()), code);
  }
  assert.equal(normalizePickupCode(' k7m2 - 9qxa '), 'K7M29QXA');
  assert.equal(normalizePickupCode('K7M2-9QX'), '');
  assert.equal(normalizePickupCode('K7M2-9QX0'), '', '0 不在字母表里');
}

// 前端只做输入整理，规则必须与服务端逐字一致。
{
  assert.equal(frontPickup.PICKUP_CODE_ALPHABET, PICKUP_CODE_ALPHABET);
  assert.equal(frontPickup.PICKUP_MAX_PAYLOAD_CHARS, PICKUP_MAX_PAYLOAD_CHARS);
  for (const sample of ['k7m2-9qxa', ' K7M2 9QXA ', 'K7M29QX0', 'abc', '', null, 'K7M2--9QXA', 'K7M2-9QXAB']) {
    assert.equal(frontPickup.normalizePickupCode(sample), normalizePickupCode(sample), String(sample));
  }
  assert.equal(frontPickup.formatPickupCode('k7m29qxa'), formatPickupCode('K7M29QXA'));
}

// 前端错误翻译：生成时 404 是接口不存在，取件时 404 才是码失效；断网与浏览器不支持压缩各有提示。
{
  const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const message = async promise => { try { await promise; } catch (error) { return error.message; } return ''; };
  assert.match(await message(frontPickup.createPickup(PAYLOAD, { fetch: reply(404, { ok: false }) })), /暂不可用/);
  assert.match(await message(frontPickup.redeemPickup('K7M29QXA', { fetch: reply(404, { ok: false }) })), /已被取用/);
  assert.match(await message(frontPickup.createPickup(PAYLOAD, { fetch: async () => { throw new TypeError('offline'); } })), /网络连接失败/);
  assert.match(await message(frontPickup.createPickup('{"raw":"json"}', { fetch: reply(200, { ok: true }) })), /不能压缩/);
  assert.match(await message(frontPickup.createPickup(PAYLOAD, { fetch: async () => new Response('<html>', { status: 405 }) })), /请求失败/);
  assert.match(await message(frontPickup.redeemPickup('abc', { fetch: reply(200, { ok: true }) })), /8 位/);
}

// 往返：生成 → 取件成功 → 同码再取 404；库里不存明文码，取后即删。
{
  const env = makeEnv();
  const made = await create(env);
  assert.equal(made.status, 200);
  assert.equal(made.body.ok, true);
  assert.match(made.body.code, /^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);
  assert.equal(made.headers.get('cache-control'), 'no-store');
  const stored = env.COMMUNITY_DB.rows('SELECT code_hash, payload, bytes FROM favorites_pickups');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].payload, PAYLOAD);
  assert.equal(stored[0].bytes, PAYLOAD.length);
  const plain = made.body.code.replace('-', '');
  assert.ok(!stored[0].code_hash.includes(plain), '库里不应出现明文取件码');

  const got = await redeem(env, made.body.code.toLowerCase().replace('-', ' '));
  assert.equal(got.status, 200);
  assert.equal(got.body.payload, PAYLOAD);
  assert.equal(env.COMMUNITY_DB.rows('SELECT id FROM favorites_pickups').length, 0);

  const again = await redeem(env, made.body.code);
  assert.equal(again.status, 404);
  assert.match(again.body.error, /已被取用/);
}

// 过期的码取不到，且会在下一次请求时被清掉。
{
  const env = makeEnv();
  const made = await create(env);
  env.COMMUNITY_DB.sqlite.exec('UPDATE favorites_pickups SET expires_at = 1');
  const got = await redeem(env, made.body.code);
  assert.equal(got.status, 404);
  assert.equal(env.COMMUNITY_DB.rows('SELECT id FROM favorites_pickups').length, 0);
}

// 跨源、格式错误、超大、坏 JSON。
{
  const env = makeEnv();
  assert.equal((await create(env, PAYLOAD, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await create(env, PAYLOAD, { origin: null })).status, 403);
  assert.equal((await redeem(env, 'K7M29QXA', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await create(env, '{"format":"raw json"}')).status, 400);
  assert.equal((await create(env, 'NAITAG1.bad+chars')).status, 400);
  assert.equal((await create(env, 12345)).status, 400);
  const huge = await create(env, 'NAITAG1.' + 'a'.repeat(PICKUP_MAX_PAYLOAD_CHARS));
  assert.equal(huge.status, 413);
  const badJson = await createPost({ env, request: post('/api/favorites-pickup', null, { raw: '{not json' }) });
  assert.equal(badJson.status, 400);
  const badCode = await redeem(env, 'abc');
  assert.equal(badCode.status, 400);
  assert.equal(env.COMMUNITY_DB.rows('SELECT id FROM favorites_pickups').length, 0);
}

// 限流按 IP 分动作计数；换 IP 不受影响。
{
  const env = makeEnv();
  for (let n = 0; n < PICKUP_RATE_LIMITS.create; n += 1) {
    assert.equal((await create(env)).status, 200);
  }
  const limited = await create(env);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await create(env, PAYLOAD, { ip: '198.51.100.9' })).status, 200);

  for (let n = 0; n < PICKUP_RATE_LIMITS.redeem; n += 1) {
    assert.equal((await redeem(env, 'ZZZZZZZZ')).status, 404);
  }
  assert.equal((await redeem(env, 'ZZZZZZZZ')).status, 429);
  const buckets = env.COMMUNITY_DB.rows('SELECT identifier_hash FROM pickup_rate_buckets');
  assert.ok(buckets.every(row => !row.identifier_hash.includes('203.0.113.1')), '不存原始 IP');
}

// 全站同时存放达到上限返回 503，过期后恢复。
{
  const env = makeEnv();
  const insert = env.COMMUNITY_DB.sqlite.prepare(
    'INSERT INTO favorites_pickups (code_hash, payload, bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  );
  const future = Date.now() + 60_000;
  for (let n = 0; n < PICKUP_MAX_ACTIVE; n += 1) insert.run(`filler-${n}`, PAYLOAD, PAYLOAD.length, Date.now(), future);
  const busy = await create(env);
  assert.equal(busy.status, 503);
  assert.match(busy.body.error, /繁忙/);
  env.COMMUNITY_DB.sqlite.exec('UPDATE favorites_pickups SET expires_at = 1');
  assert.equal((await create(env)).status, 200);
}

// 开关关闭、缺库、缺盐都返回 503；表缺失（迁移未跑）也只返回 503。
{
  assert.equal((await create(makeEnv({ FAVORITES_PICKUP_ENABLED: 'false' }))).status, 503);
  assert.equal((await create(makeEnv({ COMMUNITY_DB: undefined }))).status, 503);
  assert.equal((await redeem(makeEnv({ RATE_LIMIT_SALT: '' }), 'K7M29QXA')).status, 503);
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const bare = makeEnv({ COMMUNITY_DB: new SqliteD1(await readMigrations('0001_community_likes.sql')) });
    const missing = await create(bare);
    assert.equal(missing.status, 503);
    assert.equal(missing.body.error, '取件码暂不可用');
    assert.equal((await redeem(bare, 'K7M29QXA')).status, 503);
    assert.equal(logged.length, 2);
  } finally {
    console.error = originalError;
  }
}

console.log('favorites pickup backend: PASS');
