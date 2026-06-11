'use strict';

/* 画风串投稿弹窗（自包含模块，依赖 strings.js 里的全局 $ / escHtml / toast / isLocal） */
(() => {

// 与后端 functions/_lib.js 的 LIMITS 保持一致
const LIM = { title: 60, prompt: 2000, negative: 2000, comment: 500, submitter: 20, tags: 8, imgMax: 6, imgBytes: 3 * 1024 * 1024 };
const LABELS = [['gallery', '图库'], ['face', '面部'], ['scene', '场景'], ['nsfw', 'NSFW']];

let modal = null;
let files = [];   // {blob, url, label}
let busy = false;

const CSS = `
.sub-field{margin-bottom:14px}
.sub-field>label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:5px}
.sub-field input[type=text],.sub-field textarea{width:100%;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:10px;padding:9px 12px;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box}
.sub-field textarea{resize:vertical;min-height:80px;line-height:1.6}
.sub-field textarea.mono{font-family:var(--font-mono);font-size:12px}
.sub-field input:focus,.sub-field textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.sub-row{display:flex;gap:12px;flex-wrap:wrap}
.sub-row .sub-field{flex:1;min-width:150px}
.sub-drop{border:2px dashed var(--line);border-radius:12px;padding:20px 14px;text-align:center;color:var(--muted);font-size:13px;cursor:pointer;transition:all .15s}
.sub-drop:hover,.sub-drop.over{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.sub-previews{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:10px;margin-top:10px}
.sub-prev{position:relative;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--tagbg)}
.sub-prev img{width:100%;aspect-ratio:1;object-fit:cover;display:block}
.sub-prev select{width:100%;border:none;border-top:1px solid var(--line);background:var(--card);color:var(--text);font-size:11px;padding:4px 6px;font-family:inherit;outline:none}
.sub-prev .rm{position:absolute;top:4px;right:4px;width:22px;height:22px;border:none;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;cursor:pointer;display:grid;place-items:center;line-height:1}
.sub-prev .rm:hover{background:var(--red)}
.sub-check{display:inline-flex;align-items:center;gap:7px;font-size:13px;cursor:pointer;user-select:none;padding:9px 0}
.sub-check input{accent-color:var(--red);width:15px;height:15px}
.sub-actions{display:flex;align-items:center;gap:14px;margin-top:16px;flex-wrap:wrap}
.sub-go{border:none;background:var(--accent);color:#fff;font-weight:700;font-size:14px;padding:11px 32px;border-radius:10px;cursor:pointer;font-family:inherit;transition:filter .15s}
.sub-go:hover{filter:brightness(1.08)}
.sub-go:disabled{opacity:.55;cursor:not-allowed;filter:none}
.sub-err{color:var(--red);font-size:12px;flex:1;min-width:120px}
.sub-note{font-size:11px;color:var(--muted);line-height:1.7;margin-top:6px}
.sub-warn{font-size:12px;color:var(--red);padding:12px;border:1px dashed var(--red);border-radius:10px}
`;

function buildModal() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  modal = document.createElement('div');
  modal.className = 'detail-overlay';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="detail-panel" style="max-width:680px">
      <button class="detail-close" id="subClose">✕</button>
      <div class="detail-body">
        <h2 class="detail-title" style="margin-bottom:4px">投稿画风串</h2>
        <div class="sub-note" style="margin-bottom:18px">分享你常用的画风 prompt 组合。投稿经站长审核后展示，请勿提交与画风无关的内容。</div>

        <div class="sub-field">
          <label>标题 *</label>
          <input type="text" id="subTitle" maxlength="${LIM.title}" placeholder="给这串画风起个名字，如：厚涂暗色油画风">
        </div>

        <div class="sub-field">
          <label>画风串（正向 prompt）*</label>
          <textarea id="subPrompt" class="mono" maxlength="${LIM.prompt}" placeholder="artist:xxx, {{artist:yyy}}, oil painting, impasto, ..."></textarea>
        </div>

        <div class="sub-field">
          <label>负面 prompt（选填）</label>
          <textarea id="subNegative" class="mono" maxlength="${LIM.negative}" placeholder="lowres, bad anatomy, extra fingers, ..."></textarea>
        </div>

        <div class="sub-field">
          <label>例图 *（1–${LIM.imgMax} 张，自动压缩后上传）</label>
          <div class="sub-drop" id="subDrop">点击选择图片，或把图片拖到这里</div>
          <input type="file" id="subFile" accept="image/*" multiple hidden>
          <div class="sub-previews" id="subPreviews"></div>
        </div>

        <div class="sub-row">
          <div class="sub-field">
            <label>分类（选填，可用 / 分级）</label>
            <input type="text" id="subCategory" maxlength="60" placeholder="如：厚涂 或 二次元/赛璐璐">
          </div>
          <div class="sub-field">
            <label>标签（选填，逗号分隔，最多 ${LIM.tags} 个）</label>
            <input type="text" id="subTags" maxlength="200" placeholder="如：暗色, 油画, 高对比">
          </div>
        </div>

        <div class="sub-row">
          <div class="sub-field">
            <label>昵称（选填，展示为投稿人）</label>
            <input type="text" id="subName" maxlength="${LIM.submitter}" placeholder="匿名">
          </div>
          <div class="sub-field">
            <label>&nbsp;</label>
            <label class="sub-check"><input type="checkbox" id="subNsfw">包含 NSFW 内容</label>
          </div>
        </div>

        <div class="sub-field">
          <label>备注 / 使用心得（选填）</label>
          <textarea id="subComment" maxlength="${LIM.comment}" style="min-height:56px" placeholder="适合什么题材、推荐权重等"></textarea>
        </div>

        <div class="sub-actions">
          <button class="sub-go" id="subGo">提交投稿</button>
          <div class="sub-err" id="subErr"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  $('#subClose', modal).onclick = closeModal;

  const drop = $('#subDrop', modal);
  const fileInput = $('#subFile', modal);
  drop.onclick = () => fileInput.click();
  fileInput.onchange = () => { addFiles([...fileInput.files]); fileInput.value = ''; };
  drop.ondragover = ev => { ev.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = ev => {
    ev.preventDefault();
    drop.classList.remove('over');
    addFiles([...(ev.dataTransfer?.files || [])]);
  };

  $('#subGo', modal).onclick = doSubmit;
}

function openModal() {
  if (!modal) buildModal();
  showErr('');
  modal.style.display = '';
}

function closeModal() { modal.style.display = 'none'; }

function showErr(msg) { const el = $('#subErr', modal); if (el) el.textContent = msg || ''; }

/* ---- 图片：浏览器端压缩（长边 ≤1100px JPEG，与站内缩略图规格一致） ---- */
async function compressImage(file) {
  const MAX = 1100;
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error('无法读取图片：' + (file.name || '')); }
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('图片压缩失败');
  if (blob.size > LIM.imgBytes) throw new Error('图片压缩后仍过大');
  return blob;
}

async function addFiles(list) {
  for (const f of list) {
    if (files.length >= LIM.imgMax) { showErr(`例图最多 ${LIM.imgMax} 张`); break; }
    if (!/^image\//.test(f.type)) continue;
    try {
      const blob = await compressImage(f);
      files.push({ blob, url: URL.createObjectURL(blob), label: 'gallery' });
      showErr('');
    } catch (e) {
      showErr(e.message || '图片处理失败');
    }
  }
  renderPreviews();
}

function renderPreviews() {
  const box = $('#subPreviews', modal);
  box.innerHTML = '';
  files.forEach((im, i) => {
    const div = document.createElement('div');
    div.className = 'sub-prev';
    div.innerHTML = `
      <img src="${im.url}" alt="">
      <button class="rm" title="移除">✕</button>
      <select title="这张图属于哪个视图">${LABELS.map(([v, n]) => `<option value="${v}"${im.label === v ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
    div.querySelector('.rm').onclick = () => {
      URL.revokeObjectURL(im.url);
      files.splice(i, 1);
      renderPreviews();
    };
    div.querySelector('select').onchange = ev => { im.label = ev.target.value; };
    box.appendChild(div);
  });
}

function resetForm() {
  ['#subTitle', '#subPrompt', '#subNegative', '#subCategory', '#subTags', '#subName', '#subComment'].forEach(s => { $(s, modal).value = ''; });
  $('#subNsfw', modal).checked = false;
  files.forEach(im => URL.revokeObjectURL(im.url));
  files = [];
  renderPreviews();
}

async function doSubmit() {
  if (busy || !modal) return;
  const title = $('#subTitle', modal).value.trim();
  const prompt = $('#subPrompt', modal).value.trim();
  if (!title) { showErr('请填写标题'); return; }
  if (!prompt) { showErr('请填写画风串内容'); return; }
  if (!files.length) { showErr('请至少添加 1 张例图'); return; }
  const fd = new FormData();
  fd.append('title', title);
  fd.append('prompt', prompt);
  fd.append('negative', $('#subNegative', modal).value.trim());
  fd.append('comment', $('#subComment', modal).value.trim());
  fd.append('category', $('#subCategory', modal).value.trim());
  fd.append('tags', $('#subTags', modal).value.trim());
  fd.append('submitter', $('#subName', modal).value.trim());
  fd.append('nsfw', $('#subNsfw', modal).checked ? '1' : '0');
  files.forEach((im, i) => {
    fd.append('images', im.blob, `${i + 1}.jpg`);
    fd.append('labels', im.label);
  });

  busy = true;
  const btn = $('#subGo', modal);
  btn.disabled = true;
  btn.textContent = '上传中…';
  showErr('');
  try {
    const r = await fetch('/api/submit', { method: 'POST', body: fd });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) {
      resetForm();
      closeModal();
      toast('投稿成功，审核通过后会展示在这里');
    } else {
      showErr(data.error || `提交失败（HTTP ${r.status}）`);
    }
  } catch {
    showErr('网络错误，请稍后重试');
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = '提交投稿';
  }
}

const openBtn = document.getElementById('submitOpenBtn');
if (openBtn) openBtn.onclick = openModal;

})();
