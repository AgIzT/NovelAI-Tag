/* 所长生日「送上祝福」计数（后端 functions/api/birthday-wishes.js）：
   - 总数在第一次画出生日入口时读一次；之后页面在前台、生日入口在屏幕上时每 POLL_MS 再读一次，
     切到后台就停、回来过了间隔先补一次。每次发送的回包也顺带带回最新总数。总数只增不减，晚到的旧回包不会把数字往回拨。
   - 点一下本地立刻 +1；连点先攒着，停手一会儿或攒够一批再发，切走页面时立刻发。
   - 每次打开页面最多计 WISH_PAGE_LIMIT 份，再点只放动效不计数。
   - 后端没开（预览、本地无库）或生日已过：不显示数字，点了照样放动效。
   数字变了就在 document 上派发 birthday:wishes（detail.total），横幅和选择器各自更新。 */

const ENDPOINT = '/api/birthday-wishes';
export const WISH_PAGE_LIMIT = 999;
const BATCH = 100;      // 同后端 WISH_BATCH_LIMIT
const IDLE_MS = 900;
const POLL_MS = 30_000;

const wishes = {
  loading: null,
  loaded: false,
  enabled: false,
  open: false,
  server: 0,     // 读到过的最大全站总数（已含本页送达的）
  pending: 0,    // 已点、还没发
  inflight: 0,   // 正在发
  counted: 0,    // 本页计入的份数
  timer: 0,
  sending: false,
  lastRead: 0,
  pollTimer: 0,
  onScreen: null, // 生日入口在不在屏幕上，由画入口的一方给
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

function readTotal() {
  wishes.lastRead = Date.now();
  return fetch(ENDPOINT, { cache: 'no-store', credentials: 'same-origin' })
    .then(res => res.ok ? res.json() : null)
    .catch(() => null);
}

function raiseTotal(total) {
  if (Number.isFinite(total)) wishes.server = Math.max(wishes.server, total);
}

export function loadWishTotal() {
  if (!wishes.loading) {
    wishes.loading = readTotal()
      .then(data => {
        wishes.enabled = data?.enabled === true && Number.isFinite(data.total);
        wishes.open = wishes.enabled && data.open === true;
        if (wishes.enabled) raiseTotal(data.total);
      })
      .finally(() => {
        wishes.loaded = true;
        if (!wishes.open) wishes.pending = 0;
        announce();
        if (wishes.pending) schedule();
        if (wishes.enabled) schedulePoll();
      });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        window.clearTimeout(wishes.pollTimer);
        void flush({ leaving: true });
      } else if (wishes.enabled) {
        schedulePoll(Math.max(0, wishes.lastRead + POLL_MS - Date.now()));
      }
    });
  }
  return wishes.loading;
}

/** 画出生日入口的一方告诉这里「入口现在在不在屏幕上」；不在就跳过这一轮，下一轮再看 */
export function watchWishVisibility(onScreen) {
  wishes.onScreen = onScreen;
  void loadWishTotal();
}

function schedulePoll(delay = POLL_MS) {
  window.clearTimeout(wishes.pollTimer);
  wishes.pollTimer = window.setTimeout(() => { void poll(); }, delay);
}

async function poll() {
  if (!wishes.enabled || document.visibilityState === 'hidden') return;
  // 正在发的那批会带回总数，这一轮让给它，免得旧总数加上在途份数重复算一次
  if (!wishes.sending && (wishes.onScreen?.() ?? true)) {
    const data = await readTotal();
    if (data?.enabled === true && !wishes.sending) {
      raiseTotal(data.total);
      if (data.open !== true) { wishes.open = false; wishes.pending = 0; }
      announce();
    }
  }
  if (document.visibilityState !== 'hidden') schedulePoll();
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
    raiseTotal(data?.total);
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
