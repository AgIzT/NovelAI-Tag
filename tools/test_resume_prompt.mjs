import assert from 'node:assert/strict';

globalThis.window ??= { addEventListener() {} };
globalThis.document ??= { querySelector() { return null; } };
const { isDefaultResumeRoute, shouldOfferResume } = await import('../site/assets/app/resume-prompt.js');

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

console.log('resume prompt tests passed');
