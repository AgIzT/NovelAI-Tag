// tray-core.js 纯函数测试（node 直跑）：node tools/test_tray_core.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const coreUrl = pathToFileURL(path.resolve('site/assets/app/tray-core.js')).href;
const {
  TRAY_ITEM_LIMIT, TRAY_BOARD_LIMIT, TRAY_VERSION,
  emptyTray, normalizeTray, normalizeItem, normalizeBlock,
  itemPositive, itemNegative, itemHasCharNegative,
  composeChannel, roughTagCount, addItem, removeItem,
  createBoard, removeBoard, moveSlot, activeBoard, findItem, trayItemKey, boardLabel,
} = await import(coreUrl);

const entry = (id, over = {}) => ({
  codexId: 'suozhang', entryId: id, title: `词条 ${id}`, book: '所长', path: '甲 › 乙',
  pos: `tag-${id}-a,tag-${id}-b,`, neg: '', chars: [], ...over,
});

// ---- 接缝规范化：实测所长那本 96% 的 tag 串以逗号结尾，拼接不能拼出 `,,` ----
{
  assert.equal(normalizeBlock('a,b,'), 'a,b');
  assert.equal(normalizeBlock('  a, b ,  '), 'a, b');
  assert.equal(normalizeBlock(',a,b'), 'a,b');
  assert.equal(normalizeBlock('a，b，'), 'a，b', '中文逗号收尾也要清掉');
  assert.equal(normalizeBlock(''), '');
  assert.equal(normalizeBlock(null), '');
  assert.equal(normalizeBlock(','), '');
  // 权重组自带的 :: 结尾不能被当成标点误伤
  assert.equal(normalizeBlock('0.6::a,b::,'), '0.6::a,b::');
}

// ---- itemPositive：正面 + 角色词正面，角色负面绝不能混进来 ----
{
  const it = normalizeItem(entry('1', {
    pos: 'base,',
    neg: 'bad hands,',
    chars: [
      { label: 'char1', prompt: 'girl,', negative: 'nsfw' },
      { label: 'char2', prompt: '', negative: 'blur' },
    ],
  }));
  assert.equal(itemPositive(it), 'base,\ngirl,');
  assert.ok(!itemPositive(it).includes('nsfw'), '角色负面绝不能进正面');
  assert.ok(!itemPositive(it).includes('blur'));
  assert.equal(itemNegative(it), 'bad hands,');
  assert.equal(itemHasCharNegative(it), true);
  // 只有负面、没有正面的角色词条目也要保留（面板要能提示「含角色负面」）
  assert.equal(it.chars.length, 2);
  assert.equal(it.chars[1].prompt, '');
  assert.equal(it.chars[1].hasNegative, true);
}

// ---- normalizeItem：缺 codexId / entryId 一律判废 ----
{
  assert.equal(normalizeItem(null), null);
  assert.equal(normalizeItem({ codexId: 'a' }), null);
  assert.equal(normalizeItem({ entryId: 'b' }), null);
  const it = normalizeItem({ codexId: 'a', entryId: 'b' });
  assert.equal(it.key, trayItemKey('a', 'b'));
  assert.equal(it.title, 'b', '缺标题回落到 entryId，别显示 undefined');
  assert.equal(typeof it.at, 'number');
}

// ---- addItem / removeItem ----
{
  const tray = emptyTray();
  assert.equal(addItem(tray, entry('1')).ok, true);
  assert.equal(addItem(tray, entry('1')).reason, 'exists', '同一条不重复入站');
  assert.equal(addItem(tray, null).reason, 'invalid');
  assert.equal(tray.items.length, 1);
  assert.equal(activeBoard(tray).slots.length, 1, '入站默认进当前方案');
  assert.equal(addItem(tray, entry('2'), { toBoard: false }).ok, true);
  assert.equal(activeBoard(tray).slots.length, 1);

  // 移出仓库要把所有方案里的槽位一起撤掉，不能留下引用不到词条的空槽
  createBoard(tray);
  activeBoard(tray).slots.push({ key: trayItemKey('suozhang', '1'), on: true });
  assert.equal(removeItem(tray, trayItemKey('suozhang', '1')), true);
  assert.equal(tray.items.length, 1);
  assert.equal(tray.boards.every(b => b.slots.every(s => s.key !== trayItemKey('suozhang', '1'))), true);
  assert.equal(removeItem(tray, '不存在'), false);
}

// ---- 上限 ----
{
  const tray = emptyTray();
  for (let i = 0; i < TRAY_ITEM_LIMIT; i += 1) assert.equal(addItem(tray, entry(String(i))).ok, true);
  assert.equal(addItem(tray, entry('over')).reason, 'full');
  assert.equal(tray.items.length, TRAY_ITEM_LIMIT);

  const boards = emptyTray();
  while (boards.boards.length < TRAY_BOARD_LIMIT) assert.equal(createBoard(boards).ok, true);
  assert.equal(createBoard(boards).reason, 'full');
}

// ---- composeChannel：熄灭的槽不参与，接缝用 `,\n` ----
{
  const tray = emptyTray();
  addItem(tray, entry('1'));                                   // 'tag-1-a,tag-1-b,'
  addItem(tray, entry('2', { neg: 'worst quality,' }));         // 'tag-2-a,tag-2-b,'
  const pos = composeChannel(tray, activeBoard(tray), 'pos');
  assert.equal(pos, 'tag-1-a,tag-1-b,\ntag-2-a,tag-2-b');
  assert.ok(!pos.includes(',,'), '接缝不能拼出双逗号');
  assert.ok(!/,\s*$/.test(pos), '整串不能以逗号收尾');
  assert.equal(composeChannel(tray, activeBoard(tray), 'neg'), 'worst quality');

  activeBoard(tray).slots[0].on = false;
  assert.equal(composeChannel(tray, activeBoard(tray), 'pos'), 'tag-2-a,tag-2-b');

  // 空方案 / 全灭 = 空串，不是一堆孤立逗号
  activeBoard(tray).slots.forEach(slot => { slot.on = false; });
  assert.equal(composeChannel(tray, activeBoard(tray), 'pos'), '');
  assert.equal(composeChannel(emptyTray(), undefined, 'pos'), '');
}

// ---- 方案彼此独立 ----
{
  const tray = emptyTray();
  addItem(tray, entry('1'));
  addItem(tray, entry('2'));
  assert.equal(activeBoard(tray).slots.length, 2);
  createBoard(tray);
  assert.equal(tray.active, 1);
  assert.equal(activeBoard(tray).slots.length, 0, '新方案是空画布');
  assert.equal(tray.boards[0].slots.length, 2, '切方案不影响上一套');
  assert.equal(tray.boards[1].name, '方案 B');
  assert.equal(boardLabel(0), 'A');
  assert.equal(boardLabel(25), 'Z');

  assert.equal(removeBoard(tray, 1), true);
  assert.equal(tray.active, 0);
  assert.equal(removeBoard(tray, 0), false, '最后一套方案不能删光');
}

// ---- moveSlot 边界 ----
{
  const slots = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.equal(moveSlot(slots, 0, 2), true);
  assert.deepEqual(slots.map(s => s.key), ['b', 'c', 'a']);
  assert.equal(moveSlot(slots, 1, 1), false);
  assert.equal(moveSlot(slots, -1, 0), false);
  assert.equal(moveSlot(slots, 0, 9), false);
  assert.equal(moveSlot(null, 0, 1), false);
  assert.deepEqual(slots.map(s => s.key), ['b', 'c', 'a'], '非法移动不得改动数组');
}

// ---- normalizeTray：localStorage 里的东西不可信 ----
{
  assert.deepEqual(normalizeTray(null).items, []);
  assert.equal(normalizeTray(undefined).boards.length, 1);
  assert.equal(normalizeTray('坏数据').v, TRAY_VERSION);
  assert.equal(normalizeTray({ boards: [] }).boards.length, 1, '没有方案要补一套空的');

  // 引用不到词条的槽位必须丢掉，否则面板会渲染出空行
  const dirty = {
    v: 1,
    items: [{ codexId: 'a', entryId: '1', title: 'x' }, { codexId: 'a', entryId: '1' }, { entryId: '坏' }],
    boards: [{ id: 'b0', name: '方案 A', slots: [{ key: 'a:1', on: true }, { key: 'a:失踪' }] }],
    active: 99,
  };
  const tray = normalizeTray(dirty);
  assert.equal(tray.items.length, 1, '重复 key 与残缺条目都要去掉');
  assert.equal(tray.boards[0].slots.length, 1);
  assert.equal(tray.active, 0, '越界的 active 回落到 0');
  assert.equal(findItem(tray, 'a:1').title, 'x');

  // on 默认为 true（旧数据没写这个字段时不能当成全灭）
  const legacy = normalizeTray({
    items: [{ codexId: 'a', entryId: '1' }],
    boards: [{ slots: [{ key: 'a:1' }] }],
  });
  assert.equal(legacy.boards[0].slots[0].on, true);

  // 超量条目按上限截断，不能让坏文件撑爆面板
  const flood = normalizeTray({
    items: Array.from({ length: TRAY_ITEM_LIMIT + 20 }, (_, i) => ({ codexId: 'a', entryId: String(i) })),
    boards: [{ slots: [] }],
  });
  assert.equal(flood.items.length, TRAY_ITEM_LIMIT);
}

// ---- roughTagCount 只是量级感，别拿它做去重 ----
{
  assert.equal(roughTagCount('a,b,c'), 3);
  assert.equal(roughTagCount('a,b,'), 2);
  assert.equal(roughTagCount('a\nb'), 2);
  assert.equal(roughTagCount(''), 0);
}

console.log('tray-core pure functions: PASS');
