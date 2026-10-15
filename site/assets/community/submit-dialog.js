// 投稿表单按需挂载；上传和校验继续由 submit.js 管理。
export function mountSubmitDialog() {
  if (document.getElementById('submitMask')) return;
  const template = document.createElement('template');
  template.innerHTML = `<div id="submitMask" class="community-mask community-action-mask" role="dialog" aria-modal="true" aria-labelledby="submitTitle" hidden>
  <form id="submitForm" class="dialog-panel submit-panel">
    <button class="ui-press dialog-close" type="button" data-close-submit aria-label="关闭投稿弹窗">×</button>
    <h2 id="submitTitle">投稿到共创法典</h2>
    <p class="submit-intro">上传作品，选择最贴近的内容类型。投稿会先由维护者审核，通过后才会出现在共创法典；审核时间视维护情况而定。</p>

    <div class="sub-field">
      <label>作品 *</label>
      <div id="subDrop" class="sub-drop ui-press" role="button" tabindex="0">
        <div>
          <strong>拖入图片，或点击选择</strong>
          <span>1-6 张；PNG 原图带参数时会自动读取正向提示词</span>
        </div>
      </div>
      <input id="subFile" type="file" accept="image/*" multiple hidden>
      <div id="subPreviews" class="sub-previews"></div>
    </div>

    <div class="sub-field">
      <div class="sub-label-row">
        <label for="subPrompt">正向提示词 * <span id="subPromptSrc" class="sub-source sub-source-manual">手动填写</span></label>
        <label class="sub-inline-check"><input id="subNsfw" type="checkbox">包含 NSFW 内容</label>
      </div>
      <textarea id="subPrompt" class="mono" maxlength="2000" required placeholder="artist:xxx, cinematic lighting, dynamic pose, ..."></textarea>
    </div>

    <div class="sub-field">
      <label>分类</label>
      <div id="subCategoryList" class="sub-cat-list"></div>
      <input id="subCategory" type="hidden" value="随手分享">
    </div>

    <div class="sub-row">
      <div class="sub-field">
        <label for="subTitle">标题</label>
        <input id="subTitle" type="text" maxlength="60" placeholder="不填会自动生成">
      </div>
      <div class="sub-field">
        <label for="subName">投稿人名称</label>
        <input id="subName" type="text" maxlength="20" placeholder="匿名">
      </div>
    </div>

    <details id="subMore" class="sub-more">
      <summary class="ui-press">更多（可选）<span>负面提示词 · 说明 · 标签</span></summary>
      <div class="sub-more-body">
        <div class="sub-field">
          <label for="subNegative">负面提示词</label>
          <textarea id="subNegative" class="mono" maxlength="2000" placeholder="lowres, bad anatomy, extra fingers, ..."></textarea>
        </div>
        <div class="sub-field">
          <label for="subComment">说明</label>
          <textarea id="subComment" maxlength="500" placeholder="适合什么题材、推荐权重等"></textarea>
        </div>
        <div class="sub-field">
          <label for="subTags">标签</label>
          <input id="subTags" type="text" maxlength="200" placeholder="暗色, 油画, 高对比">
        </div>
      </div>
    </details>

    <div class="sub-actions">
      <button class="ui-press" id="subGo" type="submit">提交投稿</button>
      <div id="subErr" class="sub-err" aria-live="polite"></div>
    </div>
    <section id="subSuccess" class="submit-success" aria-live="polite" hidden>
      <span aria-hidden="true">✓</span>
      <h3>投稿已提交</h3>
      <p>维护者审核通过后，作品会出现在共创法典。可以在当前浏览器的「我的投稿」里查看是否已经公开。</p>
      <div>
        <button class="ui-press panel-action is-primary" type="button" data-my-submissions-open>查看我的投稿</button>
        <button class="ui-press panel-action" type="button" data-submit-another>再投一条</button>
        <button class="ui-press panel-action" type="button" data-close-submit-success>完成</button>
      </div>
    </section>
  </form>
</div>`;
  document.body.appendChild(template.content);
}
