import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { snapshotEntry, snapshotLocked } from '../site/assets/app/tag-relay-snapshot.js';
import { state } from '../site/assets/app/state.js';

// 中转站必须与主站 isR18gEntry 使用同一语义：rating / level 与路径任一命中都锁定。
{
  const base = { id: 'entry-1', title: 'entry', tags: 'tag', path: ['normal'] };
  assert.equal(snapshotEntry({ ...base, rating: 'r18g' }).access.r18g, true);
  assert.equal(snapshotEntry({ ...base, level: 'R18G' }).access.r18g, true);
  assert.equal(snapshotEntry({ ...base, path: ['r18g'] }).access.r18g, true);
  assert.equal(snapshotEntry(base).access.r18g, false);
}

// First-generation relay data may lack access entirely. A retained codexId must
// still inherit its current codex-level NSFW gate.
{
  const previousCodexes = state.codexes;
  const previousNsfw = state.allowNsfw;
  try {
    state.codexes = [{ id: 'legacy-nsfw', nsfw: true }];
    state.allowNsfw = false;
    assert.equal(snapshotLocked({ codexId: 'legacy-nsfw', access: {} }), true);
  } finally {
    state.codexes = previousCodexes;
    state.allowNsfw = previousNsfw;
  }
}

// 权限撤销必须同时清理已打开的编排编辑器和灯箱，敏感操作入口还要在执行时复核。
{
  const [relaySource, composeSource, lightboxSource, uiSource, indexSource] = await Promise.all([
    readFile(new URL('../site/assets/app/tag-relay.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/app/tag-relay-compose.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/app/lightbox.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/assets/app/ui.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/index.html', import.meta.url), 'utf8'),
  ]);

  assert.match(relaySource, /export function refreshRelayAccess\(\)[\s\S]*refreshComposeAccess\(\)/);
  assert.match(composeSource, /export function refreshComposeAccess\(\)[\s\S]*closeInspector\(\)[\s\S]*field\.value = ''/);
  assert.match(composeSource, /refs\.blockSave\.addEventListener[\s\S]*if \(!current \|\| itemLocked\(current\)\)/);
  assert.match(relaySource, /const visibleTitle = locked \? '已锁定的成人内容' : entry\.title/);
  assert.match(composeSource, /const title = itemLocked\(action\.result\) \? '已锁定的成人内容' : action\.result\.title/);
  assert.match(relaySource, /Promise\.resolve\(\)\.then\(\(\) => \{[\s\S]*void loadFavorites\(\)/);

  assert.match(lightboxSource, /function isLightboxEntryAccessBlocked\(entry\)[\s\S]*source\?\.nsfw === true && !state\.allowNsfw/);
  assert.match(lightboxSource, /export function refreshLightboxAccess\(entry = state\.lightbox\?\.entry\)[\s\S]*isLightboxEntryAccessBlocked\(entry\)[\s\S]*closeLightbox\(\{ historyMode: 'none', immediate: true \}\)/);
  assert.match(lightboxSource, /export function renderLightbox\(\)[\s\S]*if \(isLightboxEntryAccessBlocked\(e\)\)/);
  assert.equal(
    (lightboxSource.match(/if \(!refreshLightboxAccess\((?:e|entry)\)\) return;/g) || []).length,
    6,
    '角色、正向、负向、完整、raw tag 与原图入口都必须在执行时复核权限',
  );
  assert.match(
    lightboxSource,
    /#copyRawTag[\s\S]*copyText\(item\.rawTag[\s\S]*accessEntry: e/,
    'raw tag 不入库，但必须把来源词条交给复制层冻结并复核权限',
  );
  assert.equal(
    (uiSource.match(/refreshLightboxAccess\(\);/g) || []).length,
    2,
    'NSFW 与 R18G 两个撤权入口都必须通知灯箱',
  );

  /* 复制历史的写入必须发生在实际复制成功之后，且只持有 safePlan 过滤过的
     快照。历史卡片、恢复与再次复制三处都先执行同一把锁。 */
  assert.match(composeSource, /function historyRecordLocked\(record\)[\s\S]*snapshotComplete !== true/);
  assert.match(composeSource, /const sourcePlan = safePlan\(plan\(\)\);[\s\S]*const result = await copyText\([\s\S]*if \(!result\?\.ok \|\| !historyPlan\) return;[\s\S]*recordCopyHistory\(next, \{/);
  assert.match(composeSource, /plan: historyPlan,[\s\S]*changed: 'history'/);
  assert.match(composeSource, /copyHistoryRecord\(record[\s\S]*historyRecordLocked\(record\)/);
  assert.match(composeSource, /restoreHistoryRecord\(record\)[\s\S]*historyRecordLocked\(record\)/);
  assert.match(indexSource, /id="relayHistoryToggle"[\s\S]*aria-controls="relayCopyHistory"/);
  assert.match(indexSource, /id="relayCopyHistory"[\s\S]*id="relayHistoryList"/);
}

console.log('tag relay access: all tests passed');
