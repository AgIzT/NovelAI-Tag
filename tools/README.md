# tools 目录台账

这里放维护站点用的本地工具（非前端运行时代码）。**本文件是全量台账：目录里每个工具都必须在下面出现，写明状态。**

> ⚠ **铁律：重跑任何 `import_*` / `migrate_*` 前，先查本台账的状态列**；涉及 `type:"pack"` 图包的还必须先读 `docs/经验/统一图包类导入规范.md`。状态含义：
> **现役** = 随时可跑（注意默认是否改数据）；**⚠ 条件** = 只有特定模式安全，别裸跑 `--apply`；**🔒 已用完** = 历史一次性工具，重跑会复活旧数据/覆盖现状，**禁止直接重跑**；**🧪 测试** = 配套测试。

## 现役 · 主链路

| 文件 | 用途 | 默认是否改数据 |
| --- | --- | --- |
| `convert.py` | `法典源/*.docx` → `site/data/*.json`；`--archive-sources` 转换成功后归档源文件 | 会改 JSON |
| `codex_update_match.py` | 新旧法典增量匹配预演（详见下文） | 只读；报告写 `output/` |
| `suozhang_r18_merge_match.py` | 所长色色上下册合并+全局匹配专用流程（详见下文） | 默认只读；`--apply` 才写 |
| `import_docx_codex.py` | 导入结构特殊、带内嵌图片的 Word 法典（解构原典用） | 默认只出报告；`--apply` 才写 |
| `import_excel_images.py` | 从 Excel 内嵌图片导入词条配图（通用） | 默认只预览；`--apply` 才写 |
| `sync_r2.py` | `site/images/` + `originals/` → R2，维护 media 配置；**只上传不删除**。⚠ 单独跑只是半步（正式站读指针锁定的 release，新图不显示），日常走总控台菜单 4 | 默认上传；`--dry-run`/`--check-only` 只检查 |
| `publish_data_r2.py` | 把本机 Git-ignored 的 `site/data/**/*.json` 发布为不可变 R2 release，发布前校验索引↔分书↔分享分片自洽，校验后最后更新 `data/current.json`；支持检查、指定版本激活和回滚；**只上传不删除** | 默认只生成计划；`--publish`/`--activate-release`/`--rollback` 才写 R2 |
| `build_share_index.py` | 重建分享卡索引 `site/data/share*`（数据/配图变更后；发布数据/发布程序两条链已自动跑） | 会改 share 索引 |
| `check_cache_buster.py` | 守卫：确认 JS/CSS 无 `?v=` 缓存号残留（改 JS/CSS 后必跑） | 只读 |
| `preview_server.py` | 本地预览 site/（:8766，带 no-store + /originals/ 映射） | 只读 |
| `verify_ui.py` | 浏览器 UI 冒烟/视觉回归（报告在 `output/ui-regression/`） | 只读，写测试输出 |
| `sd_metadata_inspector.py` | 读图片生成参数 + 审计法典 tag 覆盖率（详见下文）；**图片参数解析的唯一公共入口** | 只读；审计写 CSV |
| `cleanup_output.py` | 按保留策略清理 `output/`（详见文件头；`单项工具/清理输出.bat` 的内核） | 默认 dry-run；`--apply` 才删 |

## 现役 · 辅助

| 文件 | 用途 | 默认是否改数据 |
| --- | --- | --- |
| `edit_server.py` | `法典编辑器.bat` 背后的本地编辑服务器（:8769）：主站"编辑模式"的写后端，词条/分类/图片编辑，写前自动备份到 `output/edit-backups/`。⚠ 别和配图工具同时开 | 页面操作才写；每次写盘先备份 |
| `imgserver.py` + `pei.html` | `配图工具.bat` 背后的配图编辑器（:8767）。⚠ 别和法典编辑器同时开 | 页面操作才写 |
| `strings_server.py` + `strings_editor.html` | 画师串编辑器（:8768） | 页面操作才写 |
| `build_local_edition.py` | `单项工具/打包本地版.bat` / 总控台菜单 7 的内核：按白名单生成独立本地发行包 + zip（见 docs/decisions/独立本地发行版.md） | 不改仓库数据；默认写 `output/local-edition/` |
| `local_launcher.py` | 本地发行版启动器，被 `build_local_edition.py` 打包成 EXE 随发行包分发 | 仓库内不单独运行 |
| `backfill_pack_character_prompts.py` | 从原图幂等回填两本图包的 NAI V4 角色提示词 | 默认预演；`--apply` 才写 |
| `migrate_suozhang_char_prompts.py` | 把所长两本 `tags` 里内联的 `char1：xxx` 拆进 `characterPrompts`。**幂等，是所长法典更新链路的固定收尾**——每次 `convert.py` / `suozhang_r18_merge_match.py --apply` 之后都要再跑一次，否则角色词回到正面串（详见 `docs/经验/Word法典增量更新.md`） | 默认预演；`--apply` 才写（先自动备份） |

## 现役 · NAI API 批量例图补全套件

用法与门禁见 `docs/经验/NAI兼容API批量例图补全.md`；密钥不落盘，发往第三方前必须用户明确授权。

| 文件 | 用途 |
| --- | --- |
| `nai_api_test_generate.py` | 小规模试跑（只生成审阅用测试批） |
| `nai_api_batch_generate.py` | 正式批量双候选生成（断点续跑） |
| `nai_api_review_server.py` | 人工二选一审核页（⚠ 也用 :8767，别和配图工具同开） |
| `nai_api_verify_batch.py` | 独立复验暂存批次（重开每张图核对真实 PNG 元数据） |
| `nai_api_apply_selections.py` | 把人工选择正式导入法典（默认 dry-run；`--apply` 才写） |
| `nai_api_verify_applied.py` | 正式导入后的独立复验 |

## ⚠ 条件 · 来源专用图包导入器（改动前先读统一图包类导入规范）

| 文件 | 状态说明 |
| --- | --- |
| `import_mengshen_pack.py` | 梦神图包历史来源适配器。**画风章节已迁出，重放 `--apply` 会被工具主动中止**——别绕过它 |
| `import_community_ai_misc.py` | 社区AI杂图。`--apply` 仅限首次导入；现役安全模式只有 `--validate`（验证现状）和 `--sync-manual-classification-overrides`（幂等同步具名人工分级纠正） |

## 🔒 已用完 · 一次性历史导入（禁止直接重跑）

这些是来源专用的一次性工具，**目标数据后来经过合并/迁移/手工维护，直接重跑会复活旧册或覆盖现状**。确需重导先改造流程（见对应 decisions）。

| 文件 | 当年用途 | 为什么不能重跑 |
| --- | --- | --- |
| `import_artist_excel_strings.py` | 多卷画师 Excel → 旧「Nai4.5Full个人单画师收藏」 | 三册已合并为 `artist_nai45_personal`（见 decisions/合并NovelAI4.5单画师词典.md），重跑会加回独立旧册 |
| `import_wps_artist_excel_strings.py` | WPS DISPIMG 画师工作簿 → 旧「4.5画师收录」 | 同上 |
| `import_wof_artist_strings.py` | W.O.F PNG 元数据 → `artist_nai45_strings` | 该书后来并入了梦神画风合集 258 条，重跑会覆盖合并结果 |
| `import_composition_style_excel.py` | 构图风格工作簿 → `composition_style` | 一次性导入已完成，现状手工维护 |
| `attic/migrate_asset_prefix.py` | suozhang_r18 图片前缀统一迁移 | 已用完（见 decisions/合并版与图片前缀.md），仅留档 |

## 🧪 测试

`test_import_docx_codex.py` · `test_codex_update_match.py` · `test_suozhang_r18_merge_match.py` · `test_suozhang_char_prompts.py` · `test_pack_character_prompts.py` · `test_nai_api_review_server.py` · `test_edit_server.py` · `test_publish_data_r2.py` · `test_favorites_origin_migration_browser.py` · `test_python_tool_safety.py`（Python）；`test_admin_community_backend.mjs` · `test_admin_feedback_backend.mjs` · `test_community_backend_low_risk.mjs` · `test_community_frontend.mjs` · `test_community_frontend_low_risk.mjs` · `test_community_likes_backend.mjs` · `test_community_submit_backend.mjs` · `test_browser_history.mjs` · `test_history_storage.mjs` · `test_data_source.mjs` · `test_data_proxy.mjs` · `test_r2_proxy.mjs` · `test_edit_client.mjs` · `test_share_backend.mjs` · `test_search_data.mjs` · `test_render_ui.mjs` · `test_copy.mjs` · `test_favorites_backup.mjs` · `test_favorites_runtime.mjs` · `test_favorites_origin_migration.mjs` · `test_beta_banner.mjs` · `test_community_router_url.mjs` · `test_favorites_transfer.mjs` · `test_home_shortcut.mjs` · `test_local_ownership.mjs` · `test_resume_prompt.mjs` · `test_tag_relay_access.mjs` · `test_tag_relay_core.mjs` · `test_tag_relay_store.mjs`（Node）。

`__pycache__/` 是 Python 缓存，忽略。

---

## 法典增量匹配预演

更新已有 Word 法典前，先用旧版 Word 做回放基线，再审计新版：

```bat
python tools\codex_update_match.py "D:\path\新版本.docx" --codex-id suozhang --baseline-docx "D:\path\旧版本.docx" --out-dir "output\所长常规-匹配测试"
python tools\test_codex_update_match.py
```

报告会把完全一致、tag 修改、标题/目录变动、明确新增、明确减少和待人工复核分开。只有基线完整回放、歧义为 0，才应继续正式转换。新增 ID 永远从历史最大值之后分配，不复用已减少条目的 ID。

### 所长色色合并版

色色版不能分别完成上下册匹配后再拼接；条目可能跨册移动，必须先合并候选，再做一次全局匹配：

```bat
python tools\suozhang_r18_merge_match.py "D:\path\新版上册.docx" "D:\path\新版下册.docx" --baseline-upper "D:\path\旧版上册.docx" --baseline-lower "D:\path\旧版下册.docx" --out-dir "output\所长色色-匹配测试"
python tools\test_suozhang_r18_merge_match.py
```

⚠ 两条链（常规版 `codex_update_match.py` / 合并版 `suozhang_r18_merge_match.py`）**跑完 `--apply` 都要再跑一次 `migrate_suozhang_char_prompts.py --apply`**：Word 会把角色词内联回正面 tag，不拆的话 SD 用户复制出来带 `char1：`。

历史合并规则固定为：完整保留上册；仅移除下册与上册重复的「编纂者常用画师组」；保留下册「编纂者oc二则」。工具会先验证下册画师组确实是上册画师组的精确子集，并把两种 OC 标题下没有独立中文标题的本体/服装块拆成独立卡片。最终门禁以合并后的全局报告为准；分册报告只作诊断。默认命令不会改写正式数据；确认报告后给同一命令追加 `--apply`，才会写入 `site/data/suozhang_r18.json` 并只刷新 `codexes.json` 中该书的版本和计数。

## sd_metadata_inspector.py

这个工具用于检查图片原始参数，尤其是"法典词条 tag 是否能在原图 prompt 中找到"。

示例：

```bat
python tools\sd_metadata_inspector.py inspect originals\suozhang\suozhang-0001.png --json
python tools\sd_metadata_inspector.py audit-codex --codex-id suozhang_r18 --max-coverage 0.35
```

目前支持的读取方式：

- PNG `tEXt` / `iTXt` / `zTXt`
- NovelAI `Description` / `Comment`
- NovelAI v4 `Comment.v4_prompt.caption`
- WebUI `parameters`
- JPG / WebP / AVIF 的 EXIF `UserComment`
- `stealth_pngcomp` 隐写参数：读取 alpha 通道最低位，识别 `stealth_pngcomp` magic，解 gzip JSON

`stealth_pngcomp` 是 Akegarasu/stable-diffusion-inspector 也支持的一类隐藏参数。它不在普通 PNG 文本块里，所以普通元数据读取会显示"没参数"，但 NovelAI 或 inspector 仍可能读得到。

## 安全建议

- 不确定时先跑 `--dry-run` 或不带 `--apply`。
- 跑 `sync_r2.py` 前确认 `r2_config.json` 存在且配置正确。
- 跑会写数据的工具前先看 `git status --short`，避免把自己的手工修改混进工具输出。
- 图片文件通常不进 git；上传到线上需要走 R2 同步流程。
