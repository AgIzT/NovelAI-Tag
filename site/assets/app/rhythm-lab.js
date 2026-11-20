/* 统一节奏原型的调节面板：只在地址带 ?rhythm 时由 index.html 动态加载，正常访问不加载。
   改的是 tokens.css 里的节奏变量（写在 <html> 的行内样式上），「原来」模式给 <html> 挂 rhythm-orig，
   让各处 var(--dur-x, 原值) 回落到原值。选择存在 localStorage，刷新后还在。 */

const STORE_KEY = 'fadian-rhythm-lab-v1';

const TIERS = [
  { id: 'fast', label: '快', hint: '悬停、按下、颜色', min: 60, max: 300, def: 140 },
  { id: 'short', label: '短', hint: '菜单、提示、下拉', min: 100, max: 400, def: 200 },
  { id: 'medium', label: '中', hint: '面板、开关、展开', min: 150, max: 600, def: 300 },
  { id: 'long', label: '长', hint: '抽屉、横幅', min: 250, max: 900, def: 450 },
  { id: 'story', label: '情节', hint: '生日等', min: 400, max: 1400, def: 700 },
];

const OUT_CURVES = [
  ['cubic-bezier(.22,1,.36,1)', '减速（现用）'],
  ['cubic-bezier(.16,1,.3,1)', '更长的减速'],
  ['cubic-bezier(.2,0,0,1)', '利落减速'],
  ['cubic-bezier(.34,1.3,.64,1)', '轻微回弹'],
  ['ease', '浏览器默认'],
];
const SPRING_CURVES = [
  ['cubic-bezier(.34,1.56,.64,1)', '回弹（现用）'],
  ['cubic-bezier(.34,1.25,.64,1)', '弱回弹'],
  ['cubic-bezier(.34,1.8,.64,1)', '强回弹'],
  ['cubic-bezier(.22,1,.36,1)', '不回弹'],
];

const DEFAULTS = {
  mode: 'unified',
  scale: 1,
  base: Object.fromEntries(TIERS.map(tier => [tier.id, tier.def])),
  easeOut: OUT_CURVES[0][0],
  easeSpring: SPRING_CURVES[0][0],
  collapsed: false,
};

const PRESETS = [
  { id: 'near', label: '贴近原样', apply: s => ({ ...s, scale: 1, base: { ...DEFAULTS.base }, easeOut: DEFAULTS.easeOut, easeSpring: DEFAULTS.easeSpring }) },
  { id: 'crisp', label: '利落', apply: s => ({ ...s, scale: .8, base: { ...DEFAULTS.base }, easeOut: 'cubic-bezier(.2,0,0,1)', easeSpring: 'cubic-bezier(.34,1.25,.64,1)' }) },
  { id: 'soft', label: '柔和', apply: s => ({ ...s, scale: 1.25, base: { ...DEFAULTS.base }, easeOut: 'cubic-bezier(.16,1,.3,1)', easeSpring: DEFAULTS.easeSpring }) },
  { id: 'bouncy', label: '弹一点', apply: s => ({ ...s, scale: 1, base: { ...DEFAULTS.base }, easeOut: 'cubic-bezier(.34,1.3,.64,1)', easeSpring: 'cubic-bezier(.34,1.8,.64,1)' }) },
];

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return structuredClone(DEFAULTS);
    return { ...structuredClone(DEFAULTS), ...saved, base: { ...DEFAULTS.base, ...(saved.base || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function save(state) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* 隐私模式写不进就只在本页生效 */ }
}

function applyToRoot(state) {
  const root = document.documentElement;
  root.classList.toggle('rhythm-orig', state.mode === 'orig');
  root.style.setProperty('--motion-scale', String(state.scale));
  for (const tier of TIERS) root.style.setProperty(`--dur-${tier.id}-base`, `${state.base[tier.id]}ms`);
  // 行内样式会压过 html.rhythm-orig 的 initial，所以「原来」模式要把曲线从行内拿掉
  if (state.mode === 'orig') {
    root.style.removeProperty('--ease-out');
    root.style.removeProperty('--ease-spring');
  } else {
    root.style.setProperty('--ease-out', state.easeOut);
    root.style.setProperty('--ease-spring', state.easeSpring);
  }
}

function summary(state) {
  if (state.mode === 'orig') return '原来的节奏（各处原值）';
  const curve = (list, value) => (list.find(([v]) => v === value) || [value, value])[1];
  return [
    `整体速度 ×${state.scale.toFixed(2)}`,
    ...TIERS.map(tier => `${tier.label} ${state.base[tier.id]}ms`),
    `进场曲线：${curve(OUT_CURVES, state.easeOut)} ${state.easeOut}`,
    `回弹曲线：${curve(SPRING_CURVES, state.easeSpring)} ${state.easeSpring}`,
  ].join('\n');
}

const CSS = `
.rhythm-lab{position:fixed;left:14px;bottom:14px;z-index:2147483000;width:292px;max-height:calc(100vh - 28px);overflow:auto;
  padding:12px 12px 10px;border:1px solid var(--line);border-radius:16px;background:var(--panel);color:var(--text);
  box-shadow:var(--popover-shadow);font:400 12px/1.45 var(--font-ui);}
.rhythm-lab[data-collapsed="true"]{width:auto;padding:6px}
.rhythm-lab[data-collapsed="true"] .rl-body{display:none}
.rhythm-lab .rl-head{display:flex;align-items:center;gap:8px}
.rhythm-lab .rl-title{flex:1;font-weight:850;font-size:13px}
.rhythm-lab[data-collapsed="true"] .rl-title{display:none}
.rhythm-lab button{font:inherit;color:inherit;cursor:pointer}
.rhythm-lab .rl-mini{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:3px 10px}
.rhythm-lab .seg-tabs{margin:10px 0 8px}
.rhythm-lab .seg-tabs>button{min-height:30px}
.rhythm-lab .rl-label{margin:10px 0 4px;color:var(--muted);font-weight:700}
.rhythm-lab .rl-presets{display:flex;flex-wrap:wrap;gap:6px}
.rhythm-lab .rl-presets button{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:4px 10px}
.rhythm-lab .rl-presets button[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.rhythm-lab .rl-row{display:grid;grid-template-columns:96px 1fr 48px;align-items:center;gap:6px;margin:4px 0}
.rhythm-lab .rl-row small{display:block;color:var(--muted);font-size:10.5px;line-height:1.2}
.rhythm-lab .rl-row output{text-align:right;font-variant-numeric:tabular-nums}
.rhythm-lab input[type="range"]{width:100%;accent-color:var(--accent)}
.rhythm-lab select{width:100%;font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:3px 6px}
.rhythm-lab .rl-sel{display:grid;grid-template-columns:96px 1fr;align-items:center;gap:6px;margin:4px 0}
.rhythm-lab .rl-foot{display:flex;gap:6px;margin-top:10px}
.rhythm-lab .rl-foot button{flex:1;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:5px 0}
.rhythm-lab .rl-note{margin-top:8px;color:var(--muted);font-size:11px}
.rhythm-lab fieldset{border:0;margin:0;padding:0;min-width:0}
.rhythm-lab fieldset:disabled{opacity:.45}
`;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function mount() {
  let state = load();
  applyToRoot(state);
  save(state); // 站内跳转会去掉地址里的 ?rhythm，存一份让刷新后面板还在

  const style = el('style', { text: CSS });
  document.head.append(style);

  const panel = el('section', { class: 'rhythm-lab', 'aria-label': '节奏原型' });
  const toggleBtn = el('button', { type: 'button', class: 'rl-mini' });
  const modeTabs = el('div', { class: 'seg-tabs', role: 'radiogroup', 'aria-label': '节奏' });
  const modeBtns = [['orig', '原来'], ['unified', '统一后']].map(([mode, label]) =>
    el('button', { type: 'button', role: 'radio', 'data-mode': mode, text: label, onclick: () => update({ mode }) }));
  modeTabs.append(...modeBtns);
  modeTabs.style.setProperty('--seg-count', '2');

  const presetBtns = PRESETS.map(preset =>
    el('button', { type: 'button', 'data-preset': preset.id, text: preset.label, onclick: () => update(preset.apply(state), preset.id) }));

  const scaleInput = el('input', { type: 'range', min: '0.5', max: '2', step: '0.05', 'aria-label': '整体速度倍数' });
  const scaleOut = el('output');
  scaleInput.addEventListener('input', () => update({ scale: Number(scaleInput.value) }));

  const tierRows = TIERS.map(tier => {
    const input = el('input', { type: 'range', min: String(tier.min), max: String(tier.max), step: '10', 'aria-label': `${tier.label}档时长` });
    const out = el('output');
    input.addEventListener('input', () => update({ base: { ...state.base, [tier.id]: Number(input.value) } }));
    return { tier, input, out, row: el('div', { class: 'rl-row' }, [el('span', {}, [tier.label, el('small', { text: tier.hint })]), input, out]) };
  });

  const outSelect = el('select', { 'aria-label': '进场曲线' }, OUT_CURVES.map(([value, label]) => el('option', { value, text: label })));
  const springSelect = el('select', { 'aria-label': '回弹曲线' }, SPRING_CURVES.map(([value, label]) => el('option', { value, text: label })));
  outSelect.addEventListener('change', () => update({ easeOut: outSelect.value }));
  springSelect.addEventListener('change', () => update({ easeSpring: springSelect.value }));

  const copyBtn = el('button', { type: 'button', text: '复制数值' });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(summary(state));
      copyBtn.textContent = '已复制数值';
    } catch {
      copyBtn.textContent = '复制失败';
    }
    setTimeout(() => { copyBtn.textContent = '复制数值'; }, 1600);
  });
  const resetBtn = el('button', { type: 'button', text: '恢复默认', onclick: () => update({ ...structuredClone(DEFAULTS), collapsed: state.collapsed }, 'near') });

  const tunables = el('fieldset', {}, [
    el('div', { class: 'rl-label', text: '预设' }),
    el('div', { class: 'rl-presets' }, presetBtns),
    el('div', { class: 'rl-label', text: '整体速度' }),
    el('div', { class: 'rl-row' }, [el('span', { text: '倍数' }), scaleInput, scaleOut]),
    el('div', { class: 'rl-label', text: '各档时长' }),
    ...tierRows.map(r => r.row),
    el('div', { class: 'rl-label', text: '曲线' }),
    el('div', { class: 'rl-sel' }, [el('span', { text: '进场' }), outSelect]),
    el('div', { class: 'rl-sel' }, [el('span', { text: '回弹' }), springSelect]),
  ]);

  panel.append(
    el('div', { class: 'rl-head' }, [el('div', { class: 'rl-title', text: '节奏原型' }), toggleBtn]),
    el('div', { class: 'rl-body' }, [
      modeTabs,
      tunables,
      el('div', { class: 'rl-foot' }, [copyBtn, resetBtn]),
      el('div', { class: 'rl-note', text: '开场、换书、灯箱飞入、复制芯片、收藏迸发由脚本计时，不随这里变化。' }),
    ]),
  );
  toggleBtn.addEventListener('click', () => update({ collapsed: !state.collapsed }));
  document.body.append(panel);

  let activePreset = null;
  function render() {
    panel.dataset.collapsed = String(state.collapsed);
    toggleBtn.textContent = state.collapsed ? '节奏' : '收起';
    toggleBtn.setAttribute('aria-expanded', String(!state.collapsed));
    modeTabs.style.setProperty('--seg-index', state.mode === 'orig' ? '0' : '1');
    for (const btn of modeBtns) {
      btn.setAttribute('aria-checked', String(btn.dataset.mode === state.mode));
    }
    tunables.disabled = state.mode === 'orig';
    for (const btn of presetBtns) btn.setAttribute('aria-pressed', String(btn.dataset.preset === activePreset));
    scaleInput.value = String(state.scale);
    scaleOut.textContent = `×${state.scale.toFixed(2)}`;
    for (const { tier, input, out } of tierRows) {
      input.value = String(state.base[tier.id]);
      out.textContent = `${Math.round(state.base[tier.id] * state.scale)}ms`;
    }
    outSelect.value = state.easeOut;
    springSelect.value = state.easeSpring;
  }

  function update(patch, presetId = null) {
    state = { ...state, ...patch };
    activePreset = presetId;
    applyToRoot(state);
    save(state);
    render();
  }

  render();
}

if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount, { once: true });
