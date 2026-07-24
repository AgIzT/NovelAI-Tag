import assert from 'node:assert/strict';

import {
  onRequestGet as adminGet,
  onRequestPost as adminPost,
} from '../functions/api/admin/community/[[path]].js';

class MemoryR2 {
  constructor() {
    this.objects = new Map();
    this.communityWrites = 0;
    this.activeStatusLists = 0;
    this.maxActiveStatusLists = 0;
  }

  async get(key) {
    if (!this.objects.has(key)) return null;
    const raw = this.objects.get(key);
    return { json: async () => JSON.parse(raw) };
  }

  async put(key, value) {
    const raw = typeof value === 'string' ? value : await value.text();
    this.objects.set(key, raw);
    if (key === 'community/community.json') this.communityWrites += 1;
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list({ prefix }) {
    const isStatusList = /^community\/(pending|approved|hidden|rejected|deleted)\/$/.test(prefix);
    if (isStatusList) {
      this.activeStatusLists += 1;
      this.maxActiveStatusLists = Math.max(this.maxActiveStatusLists, this.activeStatusLists);
      await new Promise(resolve => setTimeout(resolve, 5));
      this.activeStatusLists -= 1;
    }
    return {
      objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })),
      truncated: false,
    };
  }
}

const bucket = new MemoryR2();
const env = {
  STRINGS_BUCKET: bucket,
  STRINGS_PUBLIC_BASE: 'https://cdn.example.test',
  ADMIN_TOKEN: 'test-token',
};

function record(id, status, fields = {}) {
  return {
    id,
    status,
    title: fields.title || `title-${id}`,
    prompt: fields.prompt || `prompt-${id}`,
    category: fields.category || ['随手分享'],
    images: fields.images || [],
    createdAt: fields.createdAt || Date.now(),
    ...fields,
  };
}

async function seed(id, status, fields) {
  await bucket.put(`community/${status}/${id}.json`, JSON.stringify(record(id, status, fields)));
}

function context(method, path, body) {
  const options = { method, headers: { authorization: 'Bearer test-token' } };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return {
    env,
    params: { path: path ? [path] : [] },
    request: new Request(`https://admin.example.test/api/admin/community/${path || ''}`, options),
  };
}

async function responseJson(response) {
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true, JSON.stringify(data));
  return data;
}

const initial = [
  ['10000001', 'pending'],
  ['10000002', 'approved'],
  ['10000003', 'hidden'],
  ['10000004', 'rejected'],
  ['10000005', 'deleted'],
];
for (const [id, status] of initial) await seed(id, status, { images: [{ key: `community/img/${id}/0.webp` }] });
bucket.communityWrites = 0;

const stats = await responseJson(await adminGet(context('GET', 'stats')));
assert.deepEqual(stats.counts, { pending: 1, approved: 1, hidden: 1, rejected: 1, deleted: 1 });
assert.equal(stats.total, 5);
assert.equal(stats.images, 5);
assert.equal(bucket.maxActiveStatusLists, 5, 'stats should list all five statuses concurrently');

await seed('20000001', 'pending');
await seed('20000002', 'pending');
bucket.communityWrites = 0;
const approved = await responseJson(await adminPost(context('POST', 'batch', {
  action: 'approve',
  ids: ['20000001', '20000002', '2fffffff'],
})));
assert.equal(approved.changed, 2);
assert.deepEqual(approved.succeeded.map(item => item.id), ['20000001', '20000002']);
assert.equal(approved.succeeded[0].action, 'approve');
assert.equal(approved.succeeded[0].item.status, 'approved');
assert.deepEqual(approved.failed, [{
  id: '2fffffff',
  error: '该内容不存在或状态不匹配',
  status: 404,
}]);
assert.deepEqual(approved.errors, [{ id: '2fffffff', error: '该内容不存在或状态不匹配' }]);
assert.equal(bucket.communityWrites, 1, 'batch approve should rebuild once');
assert.equal(bucket.objects.has('community/pending/20000001.json'), false);
assert.equal(bucket.objects.has('community/approved/20000001.json'), true);

bucket.communityWrites = 0;
const movedCategory = await responseJson(await adminPost(context('POST', 'batch', {
  action: 'moveCategory',
  ids: ['20000001', '20000002'],
  status: 'approved',
  category: '场景',
})));
assert.equal(movedCategory.changed, 2);
assert.equal(bucket.communityWrites, 1, 'batch moveCategory on approved items should rebuild once');
const categoryAggregate = JSON.parse(bucket.objects.get('community/community.json'));
assert.deepEqual(
  categoryAggregate.entries.filter(item => ['20000001', '20000002'].includes(item.id)).map(item => item.category),
  [['场景'], ['场景']],
);

bucket.communityWrites = 0;
const updated = await responseJson(await adminPost(context('POST', 'batch', {
  action: 'update',
  ids: ['20000001', '20000002'],
  status: 'approved',
  edits: { comment: 'batch note' },
})));
assert.equal(updated.changed, 2);
assert.equal(bucket.communityWrites, 1, 'batch update on approved items should rebuild once');

bucket.communityWrites = 0;
await responseJson(await adminPost(context('POST', 'update', {
  id: '20000001',
  status: 'approved',
  edits: { comment: 'single note' },
})));
assert.equal(bucket.communityWrites, 1, 'single unified update should still rebuild immediately');

await seed('50000001', 'pending');
bucket.communityWrites = 0;
await responseJson(await adminPost(context('POST', 'approve', { id: '50000001' })));
assert.equal(bucket.communityWrites, 1, 'single unified approve should rebuild exactly once');

bucket.communityWrites = 0;
const unpublished = await responseJson(await adminPost(context('POST', 'batch', {
  action: 'unpublish',
  ids: ['20000001', '20000002'],
})));
assert.equal(unpublished.changed, 2);
assert.equal(bucket.communityWrites, 1, 'batch unpublish should rebuild once');
assert.equal(bucket.objects.has('community/approved/20000001.json'), false);
assert.equal(bucket.objects.has('community/hidden/20000001.json'), true);

await seed('40000001', 'pending');
await seed('40000002', 'pending');
bucket.communityWrites = 0;
const rejected = await responseJson(await adminPost(context('POST', 'batch', {
  action: 'reject',
  ids: ['40000001', '40000002'],
  reason: 'not ready',
})));
assert.equal(rejected.changed, 2);
assert.equal(bucket.communityWrites, 0, 'batch without approved content should not rebuild');

await seed('30000001', 'pending');
bucket.communityWrites = 0;
await responseJson(await adminPost(context('POST', 'approve', { id: '30000001' })));
assert.equal(bucket.communityWrites, 1, 'single approve should rebuild immediately');

bucket.communityWrites = 0;
await responseJson(await adminPost(context('POST', 'unpublish', { id: '30000001' })));
assert.equal(bucket.communityWrites, 1, 'single unpublish should rebuild immediately');

console.log('admin community memory flow: PASS');
