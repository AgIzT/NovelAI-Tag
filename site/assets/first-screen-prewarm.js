/* 首屏数据预热：与主模块图并行，把 指针 → manifest → 启动 JSON → 首屏那本法典 先拉下来。
   init() 要等 80 多个模块全部下完才开始取数据，慢线路上这段串行等待实测有数秒到十几秒；
   这里只依赖 data-source.js 和两个零依赖小模块，以 async 模块独立执行。应用之后读同一批对象时
   认领已经在飞的请求（data-source.js 的 prewarmDataFiles / loadObjectBytes），不重复下载、照常校验。
   拿不准的情况一律不预热，任何失败都静默放弃，应用照旧自己取。 */
import { prewarmDataFiles } from './data-source.js';
import { pickInitialCodex, requestedCodexFromLocation } from './app/initial-codex.js';
import { isBirthday, BIRTHDAY_CODEX_ID } from './app/birthday.js';
import { NSFW_STORAGE_KEY } from './app/state.js';

// 与 data.js 的 loadBootstrapData 同一批
const BOOTSTRAP_FILES = ['codexes.json', 'media.json', 'about.json'];

function allowNsfw() {
  try {
    return globalThis.localStorage?.getItem(NSFW_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function canPrewarmOpening(codexId, loc = globalThis.location) {
  const pathname = String(loc?.pathname || '');
  if (pathname.startsWith('/share/')) return false;
  const hash = String(loc?.hash || '');
  if (/(^|[#&])entry=/.test(hash)) return false;
  const params = new URLSearchParams(String(loc?.search || ''));
  for (const key of ['q', 'f', 'p', 'path', 'update', 'new', 'fav', 'favorites', 'fd']) {
    if (params.has(key)) return false;
  }
  if (params.get('scope') === 'site') return false;
  if (codexId === 'artist_nai5_personal') {
    try {
      const division = globalThis.localStorage?.getItem('fadian-artist-division');
      if (division && division !== 'style') return false;
    } catch { /* ignore */ }
  }
  return true;
}

async function prewarmFirstScreen() {
  // 内联启动脚本只在可直连公网 R2 的正式域写出 pointerPath；本地版、localhost、Pages 预览都不预热
  const boot = globalThis.__atlasBoot;
  if (!boot) return;
  if (boot.config) await boot.config.catch(() => null);
  if (!boot.pointerPath) return;

  const started = await prewarmDataFiles(BOOTSTRAP_FILES);
  const index = started['codexes.json'];
  if (!index) return;
  const codexes = JSON.parse(new TextDecoder().decode(await index));
  const meta = pickInitialCodex({
    codexes,
    requested: requestedCodexFromLocation(),
    birthdayId: isBirthday() ? BIRTHDAY_CODEX_ID : '',
    // 与 access.js 的 isCodexLocked 同一判断：成人书在未开分级时视为锁定
    isLocked: codex => Boolean(codex?.nsfw) && !allowNsfw(),
  });
  // 外部数据源的书走自己的地址，不在 release 里
  if (!meta?.id || meta.dataUrl) return;
  // 干净默认进站时优先只预热轻量开场包（~10-25 KB），不让整本大 JSON 抢占首屏带宽；
  // 完整词典等开场视图渲染后在后台拉取。旧 release 或小书没有开场包时照旧预热整本。
  if (canPrewarmOpening(meta.id)) {
    const openingPath = `opening/${meta.id}.json`;
    const opening = await prewarmDataFiles([openingPath]);
    if (opening[openingPath]) return;
  }
  await prewarmDataFiles([`${meta.id}.json`]);
}

prewarmFirstScreen().catch(() => {});
