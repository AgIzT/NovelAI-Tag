/* 卡片图片调度：看得见的先下、限并发；屏外的等看得见的都完成后再少量预取。

   原先虚拟化范围（上 0.8 屏、下 1.4 屏）里的卡片一建好就各自发图，一屏 37–44 张同时在飞。慢线路上带宽被
   平分，可见的约 15 张和屏外的一起慢慢涨，12 秒内一张都完不成；滚走时卡片回收又把半截请求取消，字节作废，
   于是一直看到「图片加载中」（2026-11-07 实测）。这里只管「什么时候发图」，DOM 范围、布局与动效不变：

   - 可见带内的图按从上到下的顺序发，最多同时 visibleLimit 张。上限给到一屏常见的可见图数以上：
     屏外的不抢带宽才是慢线路上的主要收益；可见的再限到 6 张，实测不限速时第 7 张可见图要白等 1–2 秒；
   - 「可见」按图片所占的区域判断（卡片顶部 imageHeight），只露出卡片正文的卡不占可见名额；
   - 屏外的图要等可见带里的图都完成（没有排队、也没有在飞）才发，最多同时 prefetchLimit 张，先下方、后上方；
   - 还没发出的图在卡片回收时直接撤队，不花一个字节；已经在飞的照旧取消，所以一次跳转最多浪费
     visibleLimit + prefetchLimit 张的半截字节；
   - 发出后超过 stalledMs 仍未结束的图不再占名额（请求本身不取消），一条卡住的连接拖不住整个队列。
   - 登记不当场分配名额，等同一批卡片都建完（同一任务末尾的微任务，仍在绘制之前）再统一排序分配：
     虚拟列表往下滚时先建的是视口上方的卡，当场分配会让它们在可见卡登记之前抢走预取名额。

   任务对象由调用方提供：{ placement: { top, height, imageHeight, index }, start(), stop() }。
   placement 用 masonry 内部坐标，可随重排替换；图片在卡片顶部，没有 imageHeight 时按整张卡算。
   start() 负责真正赋 src，stop() 负责取消在飞的请求。 */

export const VISIBLE_IMAGE_CONCURRENCY = 12;
export const PREFETCH_IMAGE_CONCURRENCY = 2;
export const STALLED_IMAGE_MS = 15000;

const VISIBLE = 0;
const BELOW = 1;
const ABOVE = 2;

function classify(job, band) {
  const top = Number(job.placement?.top) || 0;
  const bottom = top + (Number(job.placement?.imageHeight) || Number(job.placement?.height) || 0);
  if (bottom > band.top && top < band.bottom) return { tier: VISIBLE, distance: top };
  if (top >= band.bottom) return { tier: BELOW, distance: top - band.bottom };
  return { tier: ABOVE, distance: band.top - bottom };
}

function compareJobs(a, b) {
  return a.rank.tier - b.rank.tier
    || a.rank.distance - b.rank.distance
    || (Number(a.job.placement?.index) || 0) - (Number(b.job.placement?.index) || 0);
}

export function createImageQueue({
  band = () => ({ top: 0, bottom: 0 }),
  visibleLimit = VISIBLE_IMAGE_CONCURRENCY,
  prefetchLimit = PREFETCH_IMAGE_CONCURRENCY,
  stalledMs = STALLED_IMAGE_MS,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = id => globalThis.clearTimeout(id),
  defer = fn => globalThis.queueMicrotask(fn),
} = {}) {
  const waiting = new Set();
  const running = new Map(); // job -> { startedAt, timer }
  let pumpScheduled = false;

  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    defer(() => {
      pumpScheduled = false;
      pump();
    });
  }

  function counts(currentBand) {
    let visible = 0;
    let offscreen = 0;
    const t = now();
    for (const [job, info] of running) {
      if (t - info.startedAt >= stalledMs) continue;
      if (classify(job, currentBand).tier === VISIBLE) visible += 1;
      else offscreen += 1;
    }
    return { visible, offscreen };
  }

  function launch(job) {
    waiting.delete(job);
    const info = { startedAt: now(), timer: 0 };
    running.set(job, info);
    // 到点后它不再计入名额，需要再泵一次把空出的名额分出去
    info.timer = setTimer(() => {
      info.timer = 0;
      if (running.get(job) === info) pump();
    }, stalledMs);
    job.start();
  }

  function pump() {
    if (!waiting.size) return;
    const currentBand = band();
    const ranked = [...waiting].map(job => ({ job, rank: classify(job, currentBand) })).sort(compareJobs);
    const active = counts(currentBand);
    for (const { job, rank } of ranked) {
      if (!waiting.has(job)) continue;
      if (rank.tier === VISIBLE) {
        if (active.visible >= visibleLimit) continue;
        active.visible += 1;
        launch(job);
        continue;
      }
      // 屏外：可见带里还有排队或在飞的图时一张都不发，让可见的独占带宽
      if (active.visible > 0 || ranked.some(item => item.rank.tier === VISIBLE && waiting.has(item.job))) break;
      if (active.offscreen >= prefetchLimit) break;
      active.offscreen += 1;
      launch(job);
    }
  }

  function settle(job) {
    const info = running.get(job);
    if (!info) return false;
    if (info.timer) clearTimer(info.timer);
    running.delete(job);
    return true;
  }

  return {
    /* 登记一张图。immediate：已加载过（命中缓存）或用户点了重试，不排队直接发。 */
    request(job, { immediate = false } = {}) {
      if (!job) return;
      if (running.has(job)) settle(job);
      if (immediate) {
        launch(job);
        return;
      }
      waiting.add(job);
      schedulePump();
    },
    /* 图片 load / error 之后调用，空出名额。 */
    finish(job) {
      if (settle(job)) pump();
    },
    /* 卡片回收：排队的直接撤掉；在飞的取消请求。 */
    cancel(job) {
      if (waiting.delete(job)) return;
      if (settle(job)) {
        job.stop?.();
        pump();
      }
    },
    /* 可见带或排版变了之后调用，按新位置重新分配名额。 */
    pump,
    clear() {
      for (const job of [...running.keys()]) {
        settle(job);
        job.stop?.();
      }
      waiting.clear();
    },
    stats() {
      return { waiting: waiting.size, running: running.size, ...counts(band()) };
    },
  };
}
