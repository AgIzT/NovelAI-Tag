import assert from 'node:assert/strict';

globalThis.window ??= { addEventListener() {} };
globalThis.document ??= { querySelector() { return null; } };
const { isDefaultResumeRoute, isLandingSnapshot, shouldOfferResume } = await import('../site/assets/app/resume-prompt.js');

const memory = (values = {}) => ({
  getItem: key => values[key] || null,
  setItem: (key, value) => { values[key] = String(value); },
});
const now = Date.UTC(2026, 6, 28);
const snapshot = { codexId: 'safe', codexTitle: '安全法典', at: now - 1000, path: [] };

assert.equal(isDefaultResumeRoute({}), true);
assert.equal(isDefaultResumeRoute({ codex: 'safe' }), false);
assert.equal(isDefaultResumeRoute({ entry: 'x' }), false);
assert.equal(isDefaultResumeRoute({ path: ['构图'] }), false);
assert.equal(shouldOfferResume({ snapshot, route: {}, now, sessionStorage: memory(), localStorage: memory() }), true);
assert.equal(
  shouldOfferResume({
    snapshot: { ...snapshot, access: { nsfw: true, r18g: false } },
    route: {}, now, sessionStorage: memory(), localStorage: memory(),
  }),
  false,
  '关闭 NSFW 后首页继续浏览提示不能泄露限制级法典标题或路径',
);
assert.equal(
  shouldOfferResume({
    snapshot: { ...snapshot, access: { nsfw: true, r18g: true } },
    route: {}, now, sessionStorage: memory(), localStorage: memory(),
  }),
  false,
  'R18G 快照同样不能重新出现',
);
assert.equal(shouldOfferResume({ snapshot, route: { q: 'x' }, now, sessionStorage: memory(), localStorage: memory() }), false);
assert.equal(shouldOfferResume({ snapshot, route: {}, now: now + 8 * 24 * 60 * 60 * 1000, sessionStorage: memory(), localStorage: memory() }), false);
assert.equal(shouldOfferResume({ snapshot, route: {}, now, onboardingShown: true, sessionStorage: memory(), localStorage: memory() }), false);
assert.equal(shouldOfferResume({ snapshot, route: {}, now, migrationVisible: true, sessionStorage: memory(), localStorage: memory() }), false);
assert.equal(shouldOfferResume({ snapshot, route: {}, now, sessionStorage: memory({ 'fadian-resume-prompt-shown-v1': '1' }), localStorage: memory() }), false);
assert.equal(shouldOfferResume({ snapshot, route: {}, now, sessionStorage: memory(), localStorage: memory({ 'fadian-resume-prompt-dismissed-v1': '1' }) }), false);
assert.equal(
  shouldOfferResume({ snapshot, route: {}, now, sessionStorage: memory(), localStorage: memory({ 'fadian-resume-prompt-dismissed-v1': '0' }) }),
  true,
  '「浏览记录」里重新打开开关写的是 0，不能还当作已关闭',
);

// 上次就停在这次打开的默认页首屏：继续也是原地，不提示。
const landing = { codexId: 'safe', viewportHeight: 800 };
assert.equal(isLandingSnapshot({ ...snapshot, scrollY: 0 }, landing), true);
assert.equal(shouldOfferResume({ snapshot: { ...snapshot, scrollY: 0 }, route: {}, landing, now, sessionStorage: memory(), localStorage: memory() }), false);
assert.equal(isLandingSnapshot({ ...snapshot, scrollY: 2400 }, landing), false, '同一本书往下翻过很多，仍值得继续');
assert.equal(isLandingSnapshot({ ...snapshot, path: ['构图'] }, landing), false);
assert.equal(isLandingSnapshot({ ...snapshot, q: 'cat' }, landing), false);
assert.equal(isLandingSnapshot({ ...snapshot, entryId: 'safe-1' }, landing), false);
assert.equal(isLandingSnapshot({ ...snapshot, updateFilter: 'latest' }, landing), false);
assert.equal(isLandingSnapshot({ ...snapshot, favoritesView: true }, landing), false);
assert.equal(isLandingSnapshot({ ...snapshot, codexId: 'other' }, landing), false);
assert.equal(isLandingSnapshot(snapshot, {}), false, '没有落地法典时不拦');

console.log('resume prompt tests passed');
