/* 内测预览横幅 —— 原本只属于预览分支，2026-08-20 维护者改判为**随 main 一起保留**：
 * 正式域命中下面第一个 return，线上永远不会出现它；发预览链接时有个提醒就够了。
 *
 * ⚠ 日后真要撤，**手删三处、别用 `git revert`**（revert 那个提交会冲突并把已删除的
 *   site/tag-relay.html 放回工作树）：本文件 + index.html / strings.html 各 2 行 + site/_headers 里那条 no-store。
 *   注意是「2 处 script + 1 处 _headers」，不是三处 script。
 *
 * 为什么需要它：预览部署跑在 *.pages.dev 的独立 origin 上，收藏（fadian-favs）与中转站
 * （fadian-tag-relay-v1）都存在按 origin 隔离的 localStorage 里，回不到正式域；而且分支一旦
 * 清理，这个 origin 直接消失，连挂救援页的地方都没有（正式域那次还能靠 pages.dev 挂桥，
 * 见 docs/decisions/旧Pages域收藏迁移桥.md）。所以必须让每个进来的人都知道这不是正式站。
 *
 * ⚠ 判定条件写成「只有非正式域才显示」，因此**万一忘了删也不会在正式站上冒出来**——
 *   正式域永远命中第一个 return。到期后横幅升级成全屏拦截，避免留一个长期误导人的活链接。
 */
(function () {
  var CANONICAL_HOST = 'novelai.quicktagcloud.com';
  var CANONICAL_URL = 'https://' + CANONICAL_HOST + '/';
  var EXPIRES = '2026-12-31';          // 内测截止日；改这一行即可延期
  var TEXT = '功能测试版 · 数据不保留 · 点此前往正式站';

  var host = location.hostname;
  if (host === CANONICAL_HOST) return;                                   // 正式站：永不显示
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return;  // 本地开发：别打扰

  function style(css) {
    var tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function mount(build) {
    if (document.body) build();
    else document.addEventListener('DOMContentLoaded', build, { once: true });
  }

  function isExpired() {
    return new Date().toISOString().slice(0, 10) > EXPIRES;
  }

  function mountGate() {
    if (document.getElementById('betaGate')) return;
    document.getElementById('betaBar')?.remove();
    document.documentElement.style.overflow = 'hidden';
    var gate = document.createElement('div');
    gate.id = 'betaGate';
    var box = document.createElement('div');
    var h = document.createElement('h2');
    h.textContent = '这个测试版已经结束了';
    var p = document.createElement('p');
    p.textContent = '它只是一次功能内测，不是法典图鉴的正式地址，数据也不会保留。请改用正式站。';
    var a = document.createElement('a');
    a.href = CANONICAL_URL;
    a.rel = 'noopener';
    a.textContent = '前往法典图鉴正式站';
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(a);
    gate.appendChild(box);
    document.body.appendChild(gate);
  }

  function scheduleGate() {
    /* EXPIRES 是一个 UTC 日期。页面长期挂着时，跨过下一次日期边界也要立即
       关闭预览入口；visibilitychange 用来处理后台标签页定时器被冻结的情况。 */
    function check() {
      if (!isExpired()) return false;
      mountGate();
      return true;
    }
    function schedule() {
      if (check()) return;
      var now = new Date();
      var next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      window.setTimeout(schedule, Math.max(1_000, next.getTime() - now.getTime() + 50));
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) check();
    });
    schedule();
  }

  if (!isExpired()) {
    /* 常驻顶条：不可关闭。真正需要看到它的，正是那个不知道自己在测试版上的人。
       主站顶栏是 position:sticky;top:12px，所以顺手把它压下去，别被横幅盖住。 */
    style([
      'html{--beta-bar-h:32px}',
      'body{padding-top:var(--beta-bar-h)!important}',
      '.topbar{top:calc(12px + var(--beta-bar-h))!important}',
      /* ⚠ 左目录栏与中转站侧栏都按 --topbar-h 定 sticky 顶端和高度；
         只推 body 和 .topbar 而不同步这个变量，两根栏会钻到顶栏底下。 */
      ':root{--topbar-h:calc(80px + var(--beta-bar-h))}',
      '#betaBar{position:fixed;top:0;left:0;right:0;z-index:2147483000;',
      '  display:flex;align-items:center;justify-content:center;gap:8px;',
      '  height:var(--beta-bar-h);padding:0 12px;box-sizing:border-box;',
      '  background:#b3261e;color:#fff;text-decoration:none;',
      '  font:600 12.5px/1.2 "Outfit","PingFang SC","Microsoft YaHei",-apple-system,sans-serif;',
      '  letter-spacing:.3px;text-align:center}',
      '#betaBar:hover{background:#8f1d17}',
      '#betaBar span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#betaBar b{flex:none;font-weight:800;text-decoration:underline;text-underline-offset:2px}',
      '@media(max-width:600px){:root{--topbar-h:calc(64px + var(--beta-bar-h))}.topbar{top:calc(8px + var(--beta-bar-h))!important}}',
      '@media(max-width:520px){#betaBar{font-size:11.5px}#betaBar b{display:none}}',
    ].join('\n'));
    mount(function () {
      var bar = document.createElement('a');
      bar.id = 'betaBar';
      bar.href = CANONICAL_URL;
      bar.rel = 'noopener';
      bar.innerHTML = '<span></span><b></b>';
      bar.firstChild.textContent = TEXT;
      bar.lastChild.textContent = '→';
      document.body.appendChild(bar);
      scheduleGate();
    });
    return;
  }

  /* 过期后不再是提示，而是拦截：留着一个能用的旧版本才是长期误导的来源 */
  style([
    '#betaGate{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;',
    '  padding:24px;background:#111319;color:#f2f3f7;',
    '  font:400 15px/1.8 "Outfit","PingFang SC","Microsoft YaHei",-apple-system,sans-serif}',
    '#betaGate div{max-width:420px;text-align:center}',
    '#betaGate h2{margin:0 0 10px;font-size:20px;font-weight:800;letter-spacing:.5px}',
    '#betaGate p{margin:0 0 20px;color:#a9b0c2;font-size:14px}',
    '#betaGate a{display:inline-block;padding:11px 24px;border-radius:12px;',
    '  background:#6f5cf2;color:#fff;text-decoration:none;font-weight:800;font-size:14px}',
  ].join('\n'));
  mount(mountGate);
})();
