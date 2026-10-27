/* 所长生日「送上祝福」计数（后端 functions/api/birthday-wishes.js）：
   - 总数只在第一次画出生日入口时读一次，之后靠刷新更新；每次发送的回包顺带带回最新总数。
   - 点一下本地立刻 +1；连点先攒着，停手一会儿或攒够一批再发，切走页面时立刻发。
   - 每次打开页面最多计 WISH_PAGE_LIMIT 份，再点只放动效不计数。
   - 后端没开（预览、本地无库）或生日已过：不显示数字，点了照样放动效。
   数字变了就在 document 上派发 birthday:wishes（detail.total），横幅和选择器各自更新。 */

const ENDPOINT = '/api/birthday-wishes';
export const WISH_PAGE_LIMIT = 999;
const BATCH = 100;      // 同后端 WISH_BATCH_LIMIT
const IDLE_MS = 900;

const wishes = {
  loading: null,
  loaded: false,
  enabled: false,
  open: false,
  server: 0,     // 最近一次回包里的全站总数（已含本页送达的）
  pending: 0,    // 已点、还没发
  inflight: 0,   // 正在发
  counted: 0,    // 本页计入的份数
  timer: 0,
  sending: false,
};

/** 当前显示的总数；还没读到或后端没开时为 null */
export function wishTotal() {
  return wishes.enabled ? wishes.server + wishes.pending + wishes.inflight : null;
}

export function formatWishes(n) {
  return Number(n).toLocaleString('en-US');
}

function announce() {
  document.dispatchEvent(new CustomEvent('birthday:wishes', { detail: { total: wishTotal() } }));
}

export function loadWishTotal() {
  if (!wishes.loading) {
    wishes.loading = fetch(ENDPOINT, { cache: 'no-store', credentials: 'same-origin' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        wishes.enabled = data?.enabled === true && Number.isFinite(data.total);
        wishes.open = wishes.enabled && data.open === true;
        if (wishes.enabled) wishes.server = data.total;
      })
      .catch(() => { wishes.enabled = false; wishes.open = false; })
      .finally(() => {
        wishes.loaded = true;
        if (!wishes.open) wishes.pending = 0;
        announce();
        if (wishes.pending) schedule();
      });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flush({ leaving: true });
    });
  }
  return wishes.loading;
}

/** 送一份。返回是否计入（本页送满或生日已过时只放动效） */
export function sendWish() {
  void loadWishTotal();
  // 总数还没读回来时先记着；读回来发现没开，再一起丢掉
  if (wishes.counted >= WISH_PAGE_LIMIT || (wishes.loaded && !wishes.open)) return false;
  wishes.counted += 1;
  wishes.pending += 1;
  announce();
  if (!wishes.open) return true;
  if (wishes.pending >= BATCH) void flush();
  else schedule();
  return true;
}

export function wishPageFull() {
  return wishes.counted >= WISH_PAGE_LIMIT;
}

function schedule(delay = IDLE_MS) {
  window.clearTimeout(wishes.timer);
  wishes.timer = window.setTimeout(() => { void flush(); }, delay);
}

async function flush({ leaving = false } = {}) {
  window.clearTimeout(wishes.timer);
  if (!wishes.open || wishes.sending || !wishes.pending) return;
  const count = Math.min(wishes.pending, BATCH);
  wishes.pending -= count;
  wishes.inflight = count;
  wishes.sending = true;
  let retryAfter = 0;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST', credentials: 'same-origin', keepalive: leaving,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count }),
    });
    const data = await res.json().catch(() => null);
    if (Number.isFinite(data?.total)) wishes.server = data.total;
    if (data?.open === false || data?.enabled === false) {
      wishes.open = false;
      wishes.pending = 0;
    } else if (res.status === 429) {
      // 限额满了：这批放回去，等下一分钟再发
      wishes.pending += count;
      retryAfter = Math.max(1, Number(res.headers.get('retry-after')) || 10) * 1000;
    }
  } catch { /* 断网等：这批作罢，刷新后以服务端为准 */ }
  wishes.inflight = 0;
  wishes.sending = false;
  announce();
  if (wishes.pending && wishes.open) schedule(retryAfter || (wishes.pending >= BATCH ? 0 : IDLE_MS));
}
