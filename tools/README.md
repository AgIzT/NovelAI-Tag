# tools 目录台账

> 本文件是维护工具的**状态与副作用唯一台账**，不是操作教程。`tools/` 根目录每个 `.py` / `.mjs` 工具都必须按原文件名登记；子目录里的可执行钩子和归档工具也要登记。实际参数以脚本 `--help` 为准，重复任务的完整流程从本地私有文档 `docs/经验/README.md` 按需进入。

## 怎么使用本台账

1. 日常动作优先双击 `单项工具/<动作>.bat`；这里查它最终调用的脚本、默认副作用和限制。
2. AI 或维护者准备直接运行脚本时，先搜索**完整文件名**并读所在行。
3. 任何 `import_*` / `migrate_*` 都必须先确认状态；涉及 `type:"pack"` 的任务还必须读本地私有文档 `docs/经验/统一图包类导入规范.md`。
4. `--apply`、上传、第三方 API、生产 binding、删除输出等有副作用动作，仍需服从项目授权规则；“现役”不等于已获授权。

状态含义：**现役** = 仍在维护链路中；**⚠ 条件** = 只有具名模式安全；**🔒 已用完** = 历史一次性工具，禁止直接重跑；**库文件** = 只供其它工具导入；**🧪 测试** = 对应回归。

## 现役 · 主链路

| 文件 | 用途 | 默认副作用 |
| --- | --- | --- |
| `convert.py` | `法典源/*.docx` → `site/data/*.json`；`--archive-sources` 转换成功后归档源文件 | 默认重写法典 JSON / 总索引；处理梦神内嵌图时还写 `originals/`、`site/images/`，并可能创建或删除待复核 TXT；`--archive-sources` 再移动源 DOCX，源文件被锁定时改为复制并写归档清单 |
| `codex_update_match.py` | 新旧法典增量匹配、基线回放与门禁应用；流程见本地私有文档 `docs/经验/Word法典增量更新.md` | 默认不改正式数据，但会创建或覆盖 `output/` 匹配报告；`--apply` 才另写正式数据 |
| `suozhang_r18_merge_match.py` | 所长色色上下册先合并、再全局匹配的专用流程；流程同上 | 默认不改正式数据，但会创建或覆盖 `output/` 合并快照与匹配报告；`--apply` 才另写正式数据 |
| `import_docx_codex.py` | 导入结构特殊、带内嵌图片的 Word 法典（解构原典用） | 默认只出报告；`--apply` 才写 |
| `import_excel_images.py` | 从 Excel 内嵌图片导入词条配图（通用） | 默认只预览；`--apply` 才写 |
| `sync_r2.py` | `site/images/` + `originals/` → R2，维护 media 配置；**只上传不删除**。⚠ 单独跑只是半步（正式站读指针锁定的 release，新图不显示），日常走 `单项工具/发布数据.bat` | 默认会回写本地法典 JSON / `media.json`、读取并上传 R2、更新同步清单；`--metadata-only` 只写本地元数据；严格本地不写只能用 `--dry-run`，但配置完整时它仍会向 R2 发只读列举请求；`--check-only` 虽不上传，仍会回写本地 JSON / `media.json`，不是只读模式；当前退出码只对法典对象缺失闭合，仅 strings 对象缺失或变化时仍可能为 0，必须同时检查 `remote sync` 与 `strings sync` 两段的 `upload` / `fail` |
| `publish_data_r2.py` | 把本机 Git-ignored 的 `site/data/**/*.json` 发布为不可变 R2 release，发布前校验索引↔分书↔分享分片自洽，校验后最后更新 `data/current.json`；支持检查、指定版本激活和回滚；**只上传不删除** | 默认只生成计划；`--publish`/`--activate-release`/`--rollback` 才写 R2 |
| `build_updates_index.py` | 重建跨书更新索引 `site/data/updates.json`（顶栏动态气泡与「公告/更新/反馈」面板的更新页签读它）。判定规则与前端 `data.js` 的 `updateFilterDefinitions`/`entryMatchesUpdateFilter` 逐条对齐，改一侧必须同步另一侧；发布数据链自动跑，也可 `--dry-run` / `--report` 单独看结果 | 只写 `site/data/updates.json` |
| `build_share_index.py` | 重建分享卡索引 `site/data/share*`（数据/配图变更后；发布数据链自动跑，程序链不碰数据）。安全本里的门控词条只入词条名；整本 NSFW 的书连词条名都不出（开关 `TITLE_ONLY_NSFW_BOOKS`，默认关） | 会改 share 索引 |
| `check_cache_buster.py` | 守卫：确认 JS/CSS 无 `?v=` 缓存号残留（改 JS/CSS 后必跑） | 只读 |
| `preview_server.py` | 本地预览 `site/`（带 no-store + `/originals/` 映射；`/share/` 深链只发 App 外壳，验 OG 卡片请用 wrangler pages dev） | 只读网络服务 |
| `verify_ui.py` | 浏览器 UI 冒烟/视觉回归（报告在 `output/ui-regression/`） | 只读，写测试输出 |
| `benchmark_search_v1.mjs` | 搜索 V1 与旧匹配逻辑的本地中位耗时对比；数据缺失时明确 SKIP | 只读 |
| `sd_metadata_inspector.py` | 读图片生成参数 + 审计法典 tag 覆盖率；**图片参数解析的唯一公共入口**，格式与审计流程见下方“操作说明去向” | 只读；审计写 CSV |
| `cleanup_output.py` | 按保留策略清理 `output/`（详见文件头；`单项工具/清理输出.bat` 的内核） | 默认 dry-run；`--apply` 才删 |

## 现役 · 辅助

| 文件 | 用途 | 默认副作用 |
| --- | --- | --- |
| `edit_server.py` | `法典编辑器.bat` 背后的本地编辑服务器：主站“编辑模式”的写后端，词条/分类/图片编辑，写前自动备份到 `output/edit-backups/`。⚠ 别和配图工具同时开 | 页面操作才写；每次写盘先备份 |
| `imgserver.py` + `pei.html` | `配图工具.bat` 背后的配图编辑器。⚠ 别和法典编辑器同时开 | 页面操作才写 |
| `strings_server.py` + `strings_editor.html` | `画师串编辑.bat` 背后的画师串编辑器 | 页面操作才写 |
| `takedown_pack_entries.py` | **计划器已纳入版本，执行端未上线**：按稳定词条 ID 生成图包下架计划；设计中的应用步骤会同步收口法典、总索引和本地同步清单，不直接操作 R2 | 默认预演也会写 `output/` 计划；跨文件事务、正式资产隔离与失败回滚门闭合前，`--apply` 被代码硬阻断 |
| `retire_r2_assets.py` | **只读预演已纳入版本，执行端未上线**：消费下架报告中的精确对象键，计划退役或删除已不再被发布数据引用的 R2 资源；无通配删除 | 默认计划会对 R2 发带鉴权的只读 HEAD；历史 release / 激活隔离、clean rollback、失败恢复与逐次授权门闭合前，`--apply` 被代码硬阻断 |
| `pack_import_core.py` | 图片型来源导入的公共内核：清洗、哈希、元数据、目录树、并行处理、原图/展示图写入与校验 | 库文件，不单独运行 |
| `build_local_edition.py` | `单项工具/打包本地版.bat` 的内核：按白名单生成独立本地发行包 + ZIP（见本地私有文档 `docs/decisions/独立本地发行版.md`） | 不改仓库数据；默认写 `output/local-edition/` |
| `local_launcher.py` | 本地发行版启动器，被 `build_local_edition.py` 打包成 EXE 随发行包分发 | 启动即补建发行根目录及缺失的 `codexes.json` / `media.json`，随后开启可写编辑服务并默认打开浏览器；源码直跑会以仓库根为发行根，仓库内禁止日常直接运行 |
| `backfill_pack_character_prompts.py` | 从原图幂等回填图包的 NAI V4 角色提示词（2026-08-31 两本并册后默认只跑合并册；逐条取原图本来就走 `assetCodexId`） | 默认不改正式数据，但会覆盖写 `output/pack_character_prompts/report.json`；`--apply` 才另写正式 JSON |
| `lint_docs.py` | **文档体检**：索引、死链、引用、台账、易漂数字/端口、预算和孤儿文档；流程见本地私有文档 `docs/经验/文档规整.md` | 读取项目；覆盖写 `output/docs-lint-report.txt` |
| `migrate_suozhang_char_prompts.py` | 把所长两本 `tags` 中的内联角色词拆入 `characterPrompts`；是两条 Word 更新链的固定幂等收尾，详见本地私有文档 `docs/经验/Word法典增量更新.md` | 默认不改正式数据，但会覆盖写 `output/` 报告 JSON/TXT；`--apply` 才先备份并另写正式 JSON |
| `githooks/commit-msg` + `githooks/check_commit_msg.py` | Git 提交信息闸门；检查标题/正文体量、禁词和 AI 署名。完整规范见本地私有文档 `docs/经验/提交信息规范.md` | 有 Python 时违规则阻止提交；找不到 Python 会警告并跳过，不能代替人工遵守 |

> 本地服务端口以各脚本的 `PORT` / `DEFAULT_PORT` 和工作区 `.claude/launch.json` 为准，不在台账复制第二份数字。配图工具与 NAI 候选审核服务默认可能占用同一端口；启动前确认没有冲突。端口被 Windows 排除时按命中的本地工具 Playbook 排查，不要把 EXIF 字段常量误认成端口。

## 现役 · NAI API 基础兼容工具

完整的多画风批量生成、审核、舍弃重跑、入库和复验套件已迁至仓库外
`D:\program\NOVEL\工具箱\NAI法典批量配图\`；先读其 `AGENTS.md` / `README.md`，再按需读 `使用说明和事项.md`。
项目内只保留同时服务其它维护流程的基础工具。密钥不落盘，发往第三方前必须用户明确授权。

| 文件 | 用途 | 默认副作用 |
| --- | --- | --- |
| `nai_api_test_generate.py` | 小规模试跑与 V4 角色框请求/元数据验证 | 调第三方 API；只写 `output/` 审阅批次 |
| `nai_api_batch_generate.py` | 可恢复批次的计划与候选生成 | `plan` 只写 `output/`；`generate` 调第三方 API 并续写批次 |
| `nai_api_review_server.py` | 1–8 候选人工审核页 | 本地服务；启动时可能初始化或更新批次 `selections.json`，页面操作也会原子写该文件 |
| `nai_api_verify_batch.py` | 独立复验暂存批次，不信任既有 verified 状态 | 只读图片与清单；写复验报告 |
| `nai_api_apply_selections.py` | 把已审核选择导入正式法典 | 默认不改正式数据，但会写批次目录下的 `apply-dry-run.json`；`--apply` 才另写正式 JSON 与图片 |
| `nai_api_verify_applied.py` | 正式导入后的独立复验 | 读取正式数据；写复验报告 |

## ⚠ 条件 · 来源专用图片导入器（图包改动前先读统一图包类导入规范）

| 文件 | 当前用途与边界 | 安全查看 / 实际写入 |
| --- | --- | --- |
| `import_mengshen_pack.py` | 梦神图包历史来源适配器。画风章节已迁出，整片也已并进 `nai45_community_pack`；现行数据不再由它重建 | 默认只出审计；`--apply` 现有两道主动中止，**不得绕过** |
| `import_community_ai_misc.py` | 只维护合并册里 `community_ai_misc-` 前缀那一片；`BOOK_ID` 是数据落点，`CODEX_ID` 是系列身份 | 默认扫描不改正式数据，但会覆盖写 `output/` 审计；`--validate` 只读；⚠ `--sync-manual-classification-overrides` **不需要 `--apply`，会直接写正式 JSON**；裸 `--apply` 只属历史首次导入 |
| `import_nai5_artist_dictionary.py` | N5 四份来源对应 `artist_nai5_personal`；具名 PDF 标签纠错只改登记 ID 的 `title/tags`，见本地私有文档 `docs/decisions/NovelAI5画师词典.md` | 默认审计和 `--correct-existing` 预演不改正式数据，但会覆盖写 `output/` 报告；`--validate` 只读；纠错另加 `--apply` 才先备份并写正式 JSON；首次导入 `--apply` 会拒绝覆盖现状 |
| `import_nai5_community_pack.py` | N5 社区图包；编号所长包走 `--batch-plan/apply/validate`，梦神后续包走 `--dream-plan/apply/validate`，均按原图 hash 保持稳定 ID，见本地私有文档 `docs/decisions/NovelAI5社区精选图包.md` | `--batch-plan` / `--dream-plan` / `--batch-validate` / `--dream-validate` 不改正式数据，但会覆盖写 `output/` 审计或复验报告；`--batch-apply` / `--dream-apply` 会备份并写正式数据；裸 `--apply` 仅属首次导入且拒绝覆盖 |
| `import_mengshen_korean_pack.py` | 韩网图包跨 N5 与 N4.5 两本增量；套图保组并复用 `pack_import_core.py` | 默认计划和 `--validate` 均不改正式数据/资产，但都会覆盖写 `output/` 报告，校验还会写 `validation.json`；`--apply` 会先备份并隔离确认重复源图，再写新增资产、逐个临时替换两本法典与总索引，普通异常时尝试回滚，整体不是崩溃安全的跨文件原子事务 |
| `import_wof_artist_strings.py` | W.O.F 分区写入合并册 `artist_nai45_personal`，系列身份和媒体仍用 `artist_nai45_strings`；只替换 W.O.F 分区 | 默认扫描和 `--update-existing` 预演不改正式数据，但会覆盖写 `output/` 报告；`--validate` 只读；更新另加 `--apply` 才先备份并写正式数据/资产 |

## 🔒 已用完 · 一次性历史导入（禁止直接重跑）

这些是来源专用的一次性工具，**目标数据后来经过合并/迁移/手工维护，直接重跑会复活旧册或覆盖现状**。确需重导先改造流程（见对应 decisions）。

| 文件 | 当年用途 | 为什么不能重跑 |
| --- | --- | --- |
| `import_artist_excel_strings.py` | 多卷画师 Excel → 旧「Nai4.5Full个人单画师收藏」 | 三册已合并为 `artist_nai45_personal`（见本地私有文档 `docs/decisions/合并NovelAI4.5单画师词典.md`），重跑会加回独立旧册 |
| `import_wps_artist_excel_strings.py` | WPS DISPIMG 画师工作簿 → 旧「4.5画师收录」 | 同上 |
| `import_composition_style_excel.py` | 构图风格工作簿 → `composition_style` | 一次性导入已完成，现状手工维护 |
| `attic/migrate_asset_prefix.py` | suozhang_r18 图片前缀统一迁移 | 已用完（见本地私有文档 `docs/decisions/合并版与图片前缀.md`），仅留档 |
| `attic/merge_nai45_artist_books.py` | 画师串词典并入 v4.5 画师词典 | 已用完（见本地私有文档 `docs/decisions/法典重归类.md`），重跑会报「已经合并过」并退出；仅留档 |
| `attic/merge_nai45_community_packs.py` | 两本 4.5 社区图包并成 `nai45_community_pack` | 已用完（同上），重跑自动退出；收藏兼容靠 `ATLAS_FAVORITE_OWNER_MIGRATIONS`，不是 aliases；仅留档 |

## 🧪 测试

测试文件也属于全量台账，按子系统分组；运行组合由被改功能的完成标准或对应 Playbook 决定。

- Python · 导入与数据：`test_import_docx_codex.py`、`test_import_nai5_artist_dictionary.py`、`test_import_nai5_community_pack.py`、`test_import_mengshen_korean_pack.py`、`test_import_wof_artist_strings.py`、`test_pack_import_core.py`、`test_pack_character_prompts.py`、`test_suozhang_char_prompts.py`。
- Python · 匹配与编辑：`test_codex_update_match.py`、`test_suozhang_r18_merge_match.py`、`test_edit_server.py`、`test_nai_api_review_server.py`。
- Python · 发布与安全：`test_build_share_index.py`、`test_publish_data_r2.py`、`test_publish_entrypoints.py`、`test_favorites_origin_migration_browser.py`、`test_python_tool_safety.py`、`test_lint_docs.py`。
- Node · 数据与路由：`test_data_source.mjs`、`test_data_proxy.mjs`、`test_r2_proxy.mjs`、`test_share_backend.mjs`、`test_codex_route_compat.mjs`、`test_path_code.mjs`、`test_404_page.mjs`。
- Node · 共创与后台：`test_admin_community_backend.mjs`、`test_admin_feedback_backend.mjs`、`test_community_backend_low_risk.mjs`、`test_community_frontend.mjs`、`test_community_frontend_low_risk.mjs`、`test_community_likes_backend.mjs`、`test_community_submit_backend.mjs`、`test_community_router_url.mjs`。
- Node · 主站状态与交互：`test_browser_history.mjs`、`test_history_storage.mjs`、`test_edit_client.mjs`、`test_search_data.mjs`、`test_search_directories.mjs`、`test_render_ui.mjs`、`test_copy.mjs`、`test_beta_banner.mjs`、`test_home_shortcut.mjs`、`test_local_ownership.mjs`、`test_resume_prompt.mjs`、`test_masonry_viewport.mjs`、`test_skeleton_transition.mjs`。
- Node · 收藏与中转站：`test_favorites_backup.mjs`、`test_favorites_runtime.mjs`、`test_favorites_origin_migration.mjs`、`test_favorites_transfer.mjs`、`test_tag_relay_access.mjs`、`test_tag_relay_core.mjs`、`test_tag_relay_store.mjs`。

`__pycache__/` 是 Python 缓存，忽略。

## 操作说明去向

- `codex_update_match.py` / `suozhang_r18_merge_match.py` 的基线回放、全局匹配、角色词收尾和应用门禁：读本地私有文档 `docs/经验/Word法典增量更新.md`。
- `sd_metadata_inspector.py` 的支持格式、隐写提取、tag 对照和图包公共契约：一般配图读本地私有文档 `docs/经验/配图与图包导入.md`，图包读 `docs/经验/统一图包类导入规范.md`。
- 其它脚本：先看本台账状态，再运行 `python tools/<脚本>.py --help`；没有对应 Playbook 且风险不明时只做预演或停止确认。

## 安全建议

- 不确定时先查本行的准确边界，再选明确标为只读的模式；不能从文件名、`plan`、`validate`、`check-only` 或“不带 `--apply`”猜默认副作用。
- `sync_r2.py` 的严格本地不写模式只有 `--dry-run`；配置完整时即便 dry-run 也会读取 R2。`--check-only` 只禁止上传与同步清单更新，仍可能回写法典 JSON 和 `media.json`；其退出码目前忽略 `strings_counts["upload"]`，所以仅 strings 图片缺失或变化时可能仍为 0，必须同时检查 `remote sync` 与 `strings sync` 两段的 `upload` / `fail`，不得把 exit 0 当作全部 R2 对象齐全。默认模式会联系并写入 R2；运行前必须核对 `r2_config.json`，生产上传仍需明确授权。
- 写数据前先检查工作树和工具自己的差异报告；`site/data/`、`site/images/`、`originals/` 被 Git 忽略，不能只靠 `git status` 判断是否混入旧改动。
- 一次性导入器即使自带中止保护也不得绕过；需要复用时先把它改造成针对现行 schema 的新流程并重新审核。
- 工具生成 `output/` 不等于正式数据已应用，更不等于 R2 或 Pages 已发布。

> 归档脚本的配套测试跟着脚本一起进了 `tools/attic/`：`attic/test_merge_nai45_artist_books.py`、`attic/test_merge_nai45_community_packs.py`。它们不在上面的现役清单里，必须逐文件运行，不能把通配符当成台账登记。
