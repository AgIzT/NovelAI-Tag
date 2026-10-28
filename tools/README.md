# tools 目录台账

> 本文件是维护工具的**状态与副作用唯一台账**，不是操作教程。`tools/` 根目录每个 `.py` / `.mjs` 工具都必须按原文件名登记；子目录里的可执行钩子和归档工具也要登记。实际参数以脚本 `--help` 为准，重复任务的完整流程从本地私有文档 `docs/经验/README.md` 按需进入。

## 怎么使用本台账

1. 日常动作优先双击 `单项工具/<动作>.bat`；这里查它最终调用的脚本、默认副作用和限制。
2. AI 或维护者准备直接运行脚本时，先搜索**完整文件名**并读所在行。
3. 任何 `import_*` / `migrate_*` 都必须先确认状态；涉及 `type:"pack"` 的任务还必须读本地私有文档 `docs/经验/统一图包类导入规范.md`。
4. `--apply`、上传、第三方 API、生产 binding、删除输出等有副作用动作，仍需服从项目授权规则；“现役”不等于已获授权。

状态含义：**现役** = 仍在维护链路中；**⚠ 条件** = 只有具名模式安全；**🔒 已用完** = 历史一次性工具，禁止直接重跑；**库文件** = 只供其它工具导入；**🧪 测试** = 对应回归。

## 本地发布实验与联合验证

| 文件 | 用途 | 默认副作用 |
| --- | --- | --- |
| `verify_r2_platform_s3.py` | **隔离平台验收**：默认只列计划；显式 `--run --resources <清单> --credentials-source <现有凭据入口> --out-dir <新output子目录>`，固定测试桶、账号和 key 范围，验证真实 S3 条件写与 TLS 连接复用 | run 模式读取选定凭据字段，只访问具名独立测试桶，写少量合成对象并保留精确 key；不加载默认生产入口、不删除、不改生产配置，报告不含凭据；运行前先审资源清单与权限 |
| `verify_r2_platform_http.py` | **隔离平台验收**：默认只列计划；run 模式对资源清单内精确 workers.dev URL 验只读旧 URL、ETag/Range/CORS，以及 Bearer 保护的固定合成 fixture / binding 条件写 | 只访问测试 Worker / 测试桶，token 仅从进程环境读取，不落报告；fresh output、拒绝重定向，不访问生产域；不会自动部署、删除或改路由 |
| `test_verify_r2_platform_s3.py`、`test_verify_r2_platform_http.py` | **测试**：平台验收工具的默认零网络、资源/URL/路径边界与凭据保密安全门 | 仅合成夹具和临时目录；不运行实际平台请求 |
| `test_r2_platform_worker.mjs` | **测试**：测试专用 Worker 的鉴权、固定 case、输入边界与合成 binding 流程 | 仅内存 binding，fetch 禁网；可用 `run_project_checks.py --profile r2_platform_safety` 运行新工具安全回归，绝不自动执行远端验收 |
| `workers/r2-platform-test/worker.js` | **隔离测试专用包装器**：原样委托现役只读兼容 Worker，另以进程注入的测试 secret 保护固定测试 case；只绑定资源清单指定的新测试桶 | 部署/执行须显式选择独立配置；仅固定合成内容，不接受任意 bucket/key/body，不删除；不接生产路由，测试结果不能代替真实 assets 域验收 |
| `r2_cas_experiment/`（`protocol.py`、`publisher.py`、`store.py`、`lab.py`、`reader.mjs`） | **实验**：JSON 内容寻址的离线样机；`python -B -m tools.r2_cas_experiment --output-dir output/<新目录>` 默认用合成输入，`--source site/data` 只读冻结真实本地 JSON；比较现行 v1 算法与 v2 的完整逻辑字节、增量写入、无变化和重开后回滚；JS 样机验证跨语言协议和旧 URL 的精确版本解析 | 仅写项目 `output/` 下的新快照、SQLite 假存储与报告；入口阻断 socket、生产配置加载和 R2 客户端构造，不包含远端上传或删除实现；不接现役发布 BAT、前端或 Functions；本地写入计数不等于网络性能、平台并发或兼容层上线验收 |
| `test_r2_cas_experiment.py`、`test_r2_cas_store.py`、`test_r2_cas_reader.mjs` | **测试**：合成输入、持久化和跨进程条件写、故障恢复、清单与正文校验、Python/JS 协议一致性；用 `python -B tools/run_project_checks.py --profile r2_cas` 执行已列明检查 | Python 只写独立 output 夹具；Node 仅用合成字节并启动禁网 Python 子进程；不读私密配置、不联网或操作生产。`--profile r2_cas --list` 只列计划 |
| `verify_r2_cas_integration.py` | **本地验证**：`--source <既有output冻结快照> --out-dir <新的output子目录>` 用现役发布器验证 dual 首发、无变化、单文件增量、历史读取和 CLI 回滚/激活，记录源码/输入哈希与 SQLite 提交计数 | 只读指定离线快照，只写项目 output 副本、SQLite 和报告；封禁 socket、生产客户端和配置加载；拒绝联接及覆盖既有输入/报告，不验证真实 R2 平台 |
| `verify_r2_reading_browser.py` | **本地验证**：Playwright CLI 驱动隔离 Chromium，真实 HTML/ESM 配合合成回环数据验证 v1/v2、锁版降级、WebCrypto、取消恢复及坏正文拒绝 | 仅写 output 中的新报告、截图、临时 CLI 配置；独立 profile、死代理、DNS/CSP/路由白名单限网，不接用户 profile/凭据。HTTPS 直连由路由转给回环夹具；不代替真实 Functions、R2 或公网 CORS 验收 |

## 现役 · 主链路

| 文件 | 用途 | 默认副作用 |
| --- | --- | --- |
| `publish_data_r2_v2.py`、`r2_data_protocol.py`、`r2_data_snapshot.py` | **库文件**：现役发布器显式 v2/dual 模式的内容寻址协议、冻结输入、条件创建对象及 CAS 指针；稳定协议单 JSON 上限 32 MiB，根 `manifest.json` 保留；dual 先准备两套再依次激活，两个指针不具事务原子性 | 仅由发布器调用；冻结器只写并清理 output 的新临时快照；v2 复用共享对象、无变化零写；dual 部分激活失败后停止，先核两指针，不自动回滚或删除。独立旧实验协议保留原样用于历史复现 |
| `r2_local_client.py` | **库文件**：现役发布器的显式本地 SQLite 适配器 | 仅当 `publish_data_r2.py --local-store <output子目录>` 时使用，不读 R2 配置、不联网；只写本地对象与指针 |
| `r2_http_pool.py` | **库文件**：`sync_r2.R2Client` 默认有界 HTTPS 连接池；16 连接、60 秒闲置淘汰，完整消费正文才复用，支持 HTTP CONNECT 与 bypass | 传输本身零重试；重试仍由原请求/上传层决定，原始 PUT 零重试。`http_pool_enabled:false` 可用 urllib；不支持的代理方案明确回退 urllib，避免绕过代理 |
| `run_project_checks.py` | **现役**：显式白名单工程自检，`--profile quick\|ci\|windows\|baseline\|r2_cas\|r2_integration\|r2_platform_safety\|p1\|p2`；双击 `单项工具/工程自检.bat` 或总菜单 17 跑 quick。命令、输入、运行时与副作用清单以 `--profile <组> --list` 为唯一执行台账；只证明所选检查，不能代替独立审查 | 默认在新的 `output/project-audit/checks/<run>/` 写 JSON/Markdown 报告及日志；Python 测试可写隔离临时文件，不写真实业务数据。`--list` 不执行、不写。`--output-dir` 只接受仓库内未存在、无联接/符号链接的目录。子进程环境清理不是网络/文件系统沙箱，脚本及依赖变化后仍须复核；发布安全测试只在假存储/合成目录调用发布函数，不继承生产凭据。baseline 只读本地私密数据，已知失败/缺模块保持 FAIL/BLOCKED，报告不进公开 CI |
| `convert.py` | `法典源/*.docx` → `site/data/*.json`；`--archive-sources` 转换成功后归档源文件 | 默认重写法典 JSON / 总索引；处理梦神内嵌图时还写 `originals/`、`site/images/`，并可能创建或删除待复核 TXT；`--archive-sources` 再移动源 DOCX，源文件被锁定时改为复制并写归档清单 |
| `codex_update_match.py` | 新旧法典增量匹配、基线回放与门禁应用；流程见本地私有文档 `docs/经验/Word法典增量更新.md` | 默认不改正式数据，但会创建或覆盖 `output/` 匹配报告；`--apply` 才另写正式数据 |
| `suozhang_r18_merge_match.py` | 所长色色上下册先合并、再全局匹配的专用流程；流程同上。9.25 起源稿分四卷，主流程不再适用，只作为合并、勘误与号段分配的公共库被导入 | 默认不改正式数据，但会创建或覆盖 `output/` 合并快照与匹配报告；`--apply` 才另写正式数据 |
| `import_suozhang_models.py` | **⚠ 条件：仅已审计的 2026.9.13 六份 Word**。N4.5 旧书增量及 N5 新书；源哈希锁定短中文续行修正，上下册先合并，8.31 基线严格回放 | 默认仅写统一 `output/suozhang-20260913-import/` 候选与计划；`--apply` 校验冻结计划并备份后写四本 JSON 和书目，失败恢复原文件；`--verify` 只读复验。不写图片、不联网、不发布；以后版本须重新核对源码中的源哈希与段落修正；其公共校验与 `--apply` / `--verify` 由 `import_suozhang.py` 复用；9.13 之后的版本不要再用它导入 |
| `import_suozhang.py` | **现役：所长四本的版本更新通用入口（2026.9.25 起）**。`survey` 只读调研新版 Word 并写出调研报告与配置草稿；`prepare --config tools/suozhang_versions/<版本>.json` 生成冻结候选与计划；`apply` / `verify` 应用与复验；`selfcheck` 用 9.25 存档重放，改过代码后必跑；`preview` 只读预览，另写 `续行去向.md`（每行疑似续行落到了哪张卡）和 `新增与改动.md` / `changes.json`（全部新增与改动的卡，⚑ 标出以往读错过的形状，供盲区检查）；`compare` 把两份配置在同一份底数据上重建逐条比对（演练时对标准答案、以 `--formal-dir` 指导入前数据；平时对改动前的配置，`contentOnlyIn*` 不看编号、直接列出不同的卡），演练起点配置在 `tools/suozhang_versions/rehearsal/`。每版的源哈希、分卷号段、目录改名、续行段落、被误读成正文的标题段落、提示词的中文翻译段落、标题连着提示词的段落、跨卷重复、删除批准、NEW 修正都在版本配置里，代码不再逐版复制；流程见本地私有文档 `docs/经验/所长法典更新手册.md` | `survey` / `prepare` / `selfcheck` 只写 `output/`；`apply` 校验冻结计划并备份后写四本 JSON 和书目，失败恢复原文件。不写图片、不联网、不发布 |
| `import_docx_codex.py` | 导入结构特殊、带内嵌图片的 Word 法典（解构原典用） | 默认只出报告；`--apply` 才写 |
| `import_excel_images.py` | 从 Excel 内嵌图片导入词条配图（通用） | 默认只预览；`--apply` 才写 |
| `sync_r2.py` | `site/images/` + `originals/` → R2，维护 media 配置；远端清单按本地 key 切成约每 1000 个一段、多段同时列出（进度行 `listed N remote objects (k/M ranges)`），任何一段失败都不上传；读取响应中途断开（`IncompleteRead`）会按既有上限与退避重试当前请求，分页成功前不推进游标；本地扫描每个文件只 stat 一次，缩略图尺寸随同步清单记下，文件未变就不再重读；连接 30 秒无进展即重试（请求 8 次、上传 6 次，退避封顶 10 秒），上传请求体分块发送，慢网大文件不会被超时误判；重试行写明断连 / 卡住，不再显示成 `[Errno 2]`，上传进度每 25 个一行；WebP 上传显式使用 `image/webp`，不依赖系统 MIME 表；收集词条及分书/总索引独立封面，按 `coverCodexId` 定位并去重，外链封面不入本地上传队列；本地缺少显式媒体引用时，去重并有界并发读取远端首字节，缺失/不可读/空对象返回 1 阻断；远端可读或未声明原图仍可提示 2；**只上传不删除**。⚠ 单独跑只是半步（正式站读指针锁定的 release，新图不显示），日常走 `单项工具/发布数据.bat` | 默认会回写本地法典 JSON / `media.json`、读取并上传 R2、更新同步清单；`--metadata-only` 只写本地元数据；严格本地不写只能用 `--dry-run`，但配置完整时它仍会向 R2 发只读列举及必需媒体首字节探测请求；`--check-only` 虽不上传，仍会回写本地 JSON / `media.json`，不是只读模式；当前退出码只对法典对象缺失闭合，仅 strings 对象缺失或变化时仍可能为 0，必须同时检查 `remote sync` 与 `strings sync` 两段的 `upload` / `fail` |
| `publish_data_r2.py` | 把本机 Git-ignored 的 `site/data/**/*.json` 发布为不可变 R2 release，发布前校验索引↔分书↔分享分片自洽，校验后最后更新 `data/current.json`；与当前线上版本字节相同的文件用 R2 服务端复制、不重传，复制后另核对缓存头与类型，不符即改为上传；文件多路同时处理，指针按操作开始时的 ETag 条件写；冲突或结果不明不盲目重试，随机 operationId 防止同目标 ABA；其它 R2 请求与上传沿用同步器的超时和重试，公共 release 核验遇断连或可重试状态码重试 3 次；支持检查、指定版本激活和回滚；**只上传不删除** | 默认只生成计划，不加载凭据；`--data-dir` 可指定冻结输入；发布布局由 `--format v1\|v2\|dual` 或 `data_release_format` 选择，默认 v1。`--local-store <output子目录>` 显式改用本地 SQLite 并跳过远端公共检查；不指定时 `--publish`/`--activate-release`/`--rollback` 写 R2，`--check-current` 读 R2。dual 激活/回滚须明确单格式。正式站 v2 由数据源和分享卡开关显式启用；日常维护配置须用 dual 同步旧客户端的 v1 指针 |
| `build_updates_index.py` | 重建跨书更新索引 `site/data/updates.json`（顶栏动态气泡与「公告/更新/反馈」面板的更新页签读它）。判定规则与前端 `data.js` 的 `updateFilterDefinitions`/`entryMatchesUpdateFilter` 逐条对齐，改一侧必须同步另一侧；每本每批另带 `safeCount`（未解锁 NSFW 可见条数）与最多 4 张样图 `samples`，供法典选择器卷头「最近新增」（与书内样张共用默认抽样：按书内顺序均匀取，整本 NSFW 的样图带 nsfw 标记、只给已解锁访客看，其余书只取公开词条，R18G 不收；某一批要单独指定，在 `codexes.json` 该书 `updateFilters` 对应批次写 `samples: [图片文件名…]`，指定成人档样图同样带 nsfw 标记；同处写 `pickerHidden: true` 则这本书这一批不进「最近新增」）与新增分布 `dirs` / `safeDirs`（没图可看时画目录分布）；另出顶层 `previews`（每本书封面外 3 张书内样图，供 4 本卷「样张条」；`codexes.json` 写 `previews: [图片文件名…]` 可单独指定，外部源书不出）；发布数据链自动跑，也可 `--dry-run` / `--report` 单独看结果 | 只写 `site/data/updates.json`；schema/batches/previews 不变且旧时间有效时保留 generatedAt、原始字节和 mtime，不重写 |
| `birthday_moderation.py` | 所长生日祝福墙审核命令行，给审核 agent 用：`pending` 列出待审留言（JSON，访客原文只当数据）、`decide <id> approve\|reject\|hold` 给待审留言下结论、`store-token` 从标准输入把审核令牌存进 Windows 凭据管理器 | 默认请求正式域 `/api/birthday-messages/moderate`，会改动生产的待审留言状态；令牌只能碰待审、碰不到已处理的、墙开关和其它后台；`--base` 可指向本地 pages dev；从不打印令牌 |
| `build_share_index.py` | 重建分享卡索引 `site/data/share*`（数据/配图变更后；发布数据链自动跑，程序链不碰数据）。校验分书与书目 `entryAliases` 一致并为合并词条保留旧分享键（对象 ID 保留规范目标、别名不计数）；安全本里的门控词条默认不入索引（开关 `TITLE_ONLY_GATED_IN_SAFE_BOOKS`，默认关，开了只入词条名）；整本 NSFW 的书连词条名都不出（开关 `TITLE_ONLY_NSFW_BOOKS`，默认关） | 会改 share 索引 |
| `build_tag_zh.py` | **现役（2026-09-18 上线）**：生成灯箱「中文对照」的译名分片 `site/data/tag_zh/`（core + 分书），译名优先级「人工译名 > 社区词库 > AI 译名」，来源表在 Git 忽略的 `tools/data/tag_zh/`；社区词库缺失时从钉死提交的 URL 下载并校验 SHA-256。查表键与前端 `tag-zh-core.js` 共用夹具 `fixtures/tag_zh_keys.json`，改一侧必须同步另一侧。双击入口 `单项工具/生成中文对照.bat`（总控台第 14 项）；发布数据链在分享索引之后自动跑一次 | 重写 `site/data/tag_zh/*.json`（并删除该目录下不再产出的旧分片）；覆盖写 `output/tag-zh/构建报告.md` 与 `待翻译.csv`；词库缺失时写 `tools/data/tag_zh/` 缓存；`--dry-run` 不写 `site/data` |
| `translate_tag_zh.py` | 给中文对照跑 AI 长尾补译，只翻「人工表和词库都没有」的键，断点续跑；渠道配置在 Git 忽略的 `tools/data/tag_zh/ai_config.json`（含密钥，不写日志、不写报告）；命中敏感词组合的键本地先过滤、不送外部接口（渠道对这类组合会整批拒答，送了既白花调用又连累同批）；词表在 Git 忽略的 `tools/data/tag_zh/过滤词.json`，脚本不带内置词表，**文件缺失直接退出**。**跑批节奏与译名取舍由维护者安排，脚本按需调用即可，不需要代为判断收录范围。**模型应答了却给不出译名的键记进负缓存 `tools/data/tag_zh/无译名.csv`，下轮自动跳过、不重复花钱重问（`--retry-empty` 可强制重问，换模型时才用）。跑完必须再跑 `build_tag_zh.py` 才会进分片；双击入口 `单项工具/补译中文对照.bat`（总控台第 15 项）先 dry-run、要输 YES 才发请求、跑完自动重建分片 | **会调用外部 AI 接口并产生费用**；追加写 `tools/data/tag_zh/AI译名.csv` 与负缓存 `无译名.csv`，覆盖写 `output/tag-zh/` 的跑批日志 / 报告 / 失败清单；`--dry-run` 只统计 |
| `build_artist_index.py` | **现役（2026-10-02 上线）**：生成灯箱「画师」一栏的样张索引 `site/data/artist_index.json`，并生成画风实验台用的画风串表 `site/data/artist_strings.json`（实验台页面仍在分支 `feature/style-lab`，未上线；同一组画师只记一次，倍率算法与前端 `artist-core.js` 全站对拍一致）。样张索引取 v4.5 / v5 两本画师词典里「整条 tags 只有一个 artist:」的常规词条，按画师名对到样张图，另按书名推出各书默认版本。画师名归一与前端 `artist-core.js` 共用夹具 `fixtures/artist_keys.json`，改一侧必须同步另一侧；发布数据链在中文对照之后自动跑一次，没有单独的双击入口 | 只写 `site/data/artist_index.json`、`site/data/artist_strings.json`（内容不变时字节不变）与 `output/artist-index/构建报告.md`（覆盖率与「还没有单画师样张」名单） |
| `check_cache_buster.py` | 守卫：确认 JS/CSS 无 `?v=` 缓存号残留（改 JS/CSS 后必跑） | 只读 |
| `preview_server.py` | 本地预览 `site/`（带 no-store + `/originals/` 映射；WebP 在站内与原图路由显式使用 `image/webp`；`/share/` 深链只发 App 外壳，验 OG 卡片请用 wrangler pages dev） | 只读网络服务 |
| `preview_blocking.py` | **🔒 试用已结束**：PR #31 已合并，独立 worktree 与 `fadian-blocking` 配置已清理；原双击入口依赖该配置，后续预览使用主项目 `preview_server.py` 与 `fadian` 配置 | 历史只读预览入口，配置退役后不再使用 |
| `test_content_blocking.mjs` | 屏蔽词边界、角色/套图正向、稳定身份兼容、保存/恢复/暂停与存储异常回归 | 只读，使用内存测试存储 |
| `test_blocking_manager_motion.mjs` | 屏蔽清单节点复用、退场隔离、焦点、快速切页/关闭、跨标签更新与动效兜底回归 | 只读，内存 DOM/动画与存储夹具；真实几何仍须浏览器验证 |
| `verify_ui.py` | 浏览器 UI 冒烟/视觉回归（报告在 `output/ui-regression/`）；使用隔离 Chrome/Edge profile，自动接受测试页的离开确认，导航与刷新都等待新文档，每项开始激活测试页，中转站操作核对草稿落盘；控制台输出 UTF-8。`--only <用例名片段>` 可只跑单项，`--out-dir` 支持相对路径；四态汇总，译名用例缺 core.json 为 BLOCKED，跳过不算通过 | 只读，写测试输出 |
| `verify_history_resume.py` | **本地验证**：完整主站浏览恢复、Back/Forward、收藏上下文、套图图序与中转站断点回归；`--source baseline\|fixed --out-dir <新output目录>`，基线明确指定 Git ref | 只读本工作区源码或具名 Git 字节，内存双书/套图夹具与精确回环白名单；独立 Chromium profile、禁外网，不读真实法典数据，只写新 output 证据并关闭自建进程；不替代真机/生产验收 |
| `verify_favorites_v2.py` | 收藏夹业务集成回归：迁移、归属、撤销、故障、多标签页及性能；关闭动效，含直接模块调用与 DOM 夹具；`--base-url` 指定工作区预览 | 仅接受无凭据的 HTTP localhost / 127.0.0.1；须指向只读 `preview_server.py`，不能连接编辑或生产服务；写隔离 Chrome profile 的测试存储和 `output/favorites-v2-validation/integration/`，`--out-dir` 可指定；不操作用户浏览器数据 |
| `verify_favorites_experience.py` | 收藏夹真实操作链：开启动效，以 CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText` 点击、按键和输入，核对实际命中、焦点、快捷键、断点与菜单几何；区别于上行的业务集成夹具 | 同样只接受无凭据的 HTTP localhost / 127.0.0.1；要求 `preview_server.py` 只读预览已启动，不接管服务生命周期；写独立测试 profile、结果/截图及程序版本哈希到 `output/favorites-experience/`，可用 `--out-dir` 分隔每轮；不使用用户 profile，不替代实体软键盘/读屏器验收 |
| `benchmark_search_v1.mjs` | 搜索当前实现的冷暖交错微基准，每次核对完整排序结果；记录原字节数据摘要、源码与环境。`--baseline-report <报告>` 比较已冻结的成功输出，输入、环境、协议或结果不同为 BLOCKED；可比情况下 median 超过基准 10% 为 FAIL。`--compare-legacy` 仍先核对召回集合，不同或空数据/缺输入为 BLOCKED、退出 2 | 只读本地 JSON；私密输入的输出不可上传公共 CI。冷暖差异是缓存观测，同源码重复测量不证明代码提升/退化；主机调度与负载需另行控制 |
| `verify_frontend_loading_recovery.py` | 隔离 Chrome 验译名、搜索与后台列表恢复；`--source fixed` 用当前源码及内存合成 JSON，`--only-relay` 单验中转站恢复，`before` 只用于本轮冻结夹具复现 | 起停独立回环服务/浏览器 profile，只写指定新输出目录；禁外网，不接用户 profile，不读真实数据/凭据，不进无浏览器 CI |
| `sd_metadata_inspector.py` | 读图片生成参数 + 审计法典 tag 覆盖率；**图片参数解析的唯一公共入口**，格式与审计流程见下方“操作说明去向” | 只读；审计写 CSV |
| `cleanup_output.py` | 按保留策略清理 `output/`（详见文件头；`单项工具/清理输出.bat` 的内核） | 默认 dry-run；`--apply` 才删 |

## 现役 · 辅助

| 文件 | 用途 | 默认副作用 |
| --- | --- | --- |
| `edit_server.py` | `法典编辑器.bat` 背后的本地编辑服务器：主站“编辑模式”的写后端，词条/分类/图片编辑及同级目录上移/下移，顺序独立保存，写前自动备份到 `output/edit-backups/`。⚠ 别和配图工具同时开 | 页面操作才写；每次写盘先备份。删除词条前在同一事务保存本书发号高水位和分隔符，删除全部后仍不复用已发出的本书编号，不重新编号历史词条 |
| `imgserver.py` + `pei.html` | `配图工具.bat` 背后的配图编辑器。⚠ 别和法典编辑器同时开 | 页面保存先完整编码，再备份将修改的原图、缩略图、分书和总索引；单文件原子替换，异常补偿旧字节。返回 `backupDir`，备份不自动清理；强杀或补偿失败需按清单恢复，不保证断电时多文件原子提交 |
| `strings_server.py` + `strings_editor.html` | `画师串编辑.bat` 背后的画师串编辑器；已载入文件身份和请求代次约束异步回写 | 保存/上传核对载入版本，冲突拒写并保留草稿；写前备份、异常补偿，图片使用内容摘要文件名防覆盖。旧版页面缺版本会拒绝覆盖已有合集，重开编辑器后再操作 |
| `local_file_transaction.py` | **库文件**：本地配图与画师串工具共用的修改前备份、原子替换和异常补偿；调用者持有写锁 | 在当前工具根目录 `output/local-tool-backups/` 保存精确修改前文件与 SHA-256 清单；成功和失败均保留备份，原先不存在的文件在补偿时移除。拒绝联接/符号链接路径，不提供跨进程或断电原子性 |
| `takedown_pack_entries.py` | **计划器已纳入版本，执行端未上线**：按稳定词条 ID 生成图包下架计划；设计中的应用步骤会同步收口法典、总索引和本地同步清单，不直接操作 R2 | 默认预演也会写 `output/` 计划；跨文件事务、正式资产隔离与失败回滚门闭合前，`--apply` 被代码硬阻断 |
| `retire_r2_assets.py` | **只读预演已纳入版本，执行端未上线**：消费下架报告中的精确对象键，计划退役或删除已不再被发布数据引用的 R2 资源；无通配删除 | 默认计划会对 R2 发带鉴权的只读 HEAD；历史 release / 激活隔离、clean rollback、失败恢复与逐次授权门闭合前，`--apply` 被代码硬阻断 |
| `pack_import_core.py` | 图片型来源导入的公共内核：清洗、哈希、元数据、目录树、并行处理、原图/展示图写入与校验 | 库文件，不单独运行 |
| `nai_default_tags.py` | 主正向复制文本的 NAI 默认尾段清理；与前端 `nai-default-tags.js` 共用边界夹具，重复组、混序和额外重复单项一并剥离；前文权重、负面、角色词及原图参数不变 | 纯函数库，不单独运行 |
| `clean_nai_default_tags.py` | 按当前书目清理主 `tags/rawTags` 与逐图 `rawTag/rawTags` 的完整默认尾段；双击 `单项工具/清理默认标签.bat`（总控台第 16 项）；脚本默认预演，`--verify <manifest>` 做字节逆向和幂等复验 | 默认只写 `output/default-tags-cleanup-<日期>/` 计划；`--apply` 先备份并冻结恢复清单后原子写数据，必要时移走对应解构 DOCX 防重转覆盖；不联网、不上传、不发布 |
| `build_local_edition.py` | `单项工具/打包本地版.bat` 的内核：按白名单生成独立本地发行包 + ZIP（见本地私有文档 `docs/decisions/独立本地发行版.md`） | 不改仓库数据；默认写 `output/local-edition/` |
| `local_edition_version.py` | 构建器与本地启动器共用的本地版版本号 | 库文件，不单独运行 |
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
| `apply_pack_names.py` | 把名单里的名字套用到两本社区图包（`nai5_community_pack` / `nai45_community_pack`）的词条 `title`，编号标题留在 `serialTitle`，三个图包导入器续号和分级纠正只认它；名单行 `newTitle` 为空即退回编号 | 默认预演只写 `output/pack_names_apply/` 报告；`--apply` 先备份两本书再写正式 JSON，写后自检幂等；名单 `oldTitle` 与现存编号对不上或排版无法原样重写时整批拒绝 |
| `import_nai5_artist_dictionary.py` | N5 四份来源对应 `artist_nai5_personal`；具名 PDF 标签纠错只改登记 ID 的 `title/tags`，见本地私有文档 `docs/decisions/NovelAI5画师词典.md` | 默认审计和 `--correct-existing` 预演不改正式数据，但会覆盖写 `output/` 报告；`--validate` 只读；纠错另加 `--apply` 才先备份并写正式 JSON；首次导入 `--apply` 会拒绝覆盖现状 |
| `import_nai5_single_artist_webp.py` | MayRain NAI5 单画师 WebP 来源的受控增量入口：本批同画师多图合卡，复制纯画师词，目录插入雨燕与无冕之间；参数与媒体复用公共内核 | 默认计划只写 `--report-dir` 下冻结清单；`--apply` 校验冻结输入、备份后追加新媒体并替换分书与书目；`--validate` 只读正式数据和资源并写验证报告；失败会恢复旧 JSON、将本次已移动媒体退回暂存，崩溃后用 `--recover` 恢复冻结事务；不联网、不上传、不发布 |
| `import_nai5_community_pack.py` | N5 社区图包；编号所长包走 `--batch-plan/apply/validate`，梦神后续包走 `--dream-plan/apply/validate`，均按原图 hash 保持稳定 ID，见本地私有文档 `docs/decisions/NovelAI5社区精选图包.md` | `--batch-plan` / `--dream-plan` / `--batch-validate` / `--dream-validate` 不改正式数据，但会覆盖写 `output/` 审计或复验报告；`--batch-apply` / `--dream-apply` 会备份并写正式数据；裸 `--apply` 仅属首次导入且拒绝覆盖 |
| `import_mengshen_korean_pack.py` | 韩网图包跨 N5 与 N4.5 两本增量；套图保组并复用 `pack_import_core.py` | 默认计划和 `--validate` 均不改正式数据/资产，但都会覆盖写 `output/` 报告，校验还会写 `validation.json`；`--apply` 会先备份并隔离确认重复源图，再写新增资产、逐个临时替换两本法典与总索引，普通异常时尝试回滚，整体不是崩溃安全的跨文件原子事务 |
| `backfill_pack_image_prompts.py` | 图包类（`type:"pack"`）法典套图的逐图负面 / 角色词：从原图参数读出，与顶层不同的写进 `images[]`，整组核对过的词条标 `perImagePrompts:true`；封面参数与顶层不符、正向与 `rawTag` 不符或原图读不出的整组跳过并报告；顺带把旧套图备注首行（「……取封面。」）换成现行措辞；不碰画风词典等人工整理书。现行两个图包导入器已直接写这些字段，本工具补改版前的数据，可重跑 | 默认只写计划报告 `output/pack-image-prompts/`；`--apply` 先备份再写 `site/data/<书>.json`，写完复跑须零改动 |
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

- Python · 工程自检：`test_run_project_checks.py` 验零用例、缺输入/运行时、跳过、超时、结果汇总、环境清理、路径及证据边界；使用合成临时文件。`test_project_audit_entrypoints.py` 在 Windows 用假 Python 验工程自检入口的退出码、GBK 恢复与总菜单动作委托；不运行真实发布或生产命令，不代替实体控制台键盘交互。公开 CI 仅运行 runner 的 ci/windows 两组，运行结果和已知基线缺口同时保留；main 默认尾段、公共搜索、渲染契约、统计只读权限、匹配工具与中转站缓存/存储协调回归纳入 ci，VM 模块测试由白名单显式传入所需 Node 参数；待合并社区入口、真实数据采样与旧实现比较单列 baseline，缺模块或不可比较保持 BLOCKED。CI 按 `requirements.txt` 安装项目测试依赖。

- Node · 匿名产品统计：`test_site_analytics.mjs`（显式关闭工厂、DNT/GPC 零发送、内存队列、限频、超时、无重试/标识/持久化）；`test_site_metrics_backend.mjs`（真实内存 SQLite migration、同源、字节上限、严格字段枚举、未迁移 disabled、原子全站限额、保留期与已认证聚合报表）；`test_site_metrics_hooks.mjs`（实际复制/分享/导出/过滤函数体的内存依赖回放，成功时序与取消/失败排除）；`test_site_search_observation.mjs`（800ms 前清空/历史提前返回、导航及结果更新取消、无效回调、新旧代次与三个作用域的有效完成）；`test_site_metrics_production.mjs`（独立只读权限/到期、不能进入管理员接口、保留期清理边界及无关表不变）。只读源码和内存夹具，不联网、不写用户存储或生产；不代替真实 Pages Functions 与浏览器验收。
- Node · 所长生日送祝福：`test_birthday_wishes_backend.mjs`（migration 0006 只新建两张表、UTC 生日窗口边界、按年累计与跨日分行、加盐 IP 与全站每分钟限额、超额整批不计、请求体只收 `{"count":1–100}`）。冻结时钟与内存 SQLite，不联网、不碰生产。
- Node · 所长生日祝福墙：`test_birthday_messages_backend.mjs`（migration 0007 只新建表、先审后发、链接 / 号码 / 引流词拒收、同话合并、非 UTF-8 拒收、加盐 IP 与全站限额、审核令牌只碰待审、维护者隐藏与整面墙开关）。冻结时钟与内存 SQLite，不联网、不碰生产。
- SQL · 匿名统计清理：`site_metrics_maintenance.sql` 只删除过期统计日聚合和全站限频桶，不碰互动/投稿/反馈表；执行即改指定 D1，本地/远端必须显式区分，远端需要另行授权。流程见私密运维文档 `docs/运维/匿名产品统计上线与回滚.md`。
- Worker · `site-metrics-maintenance/worker.js` 与同目录 `wrangler.jsonc`：统计过期清理的独立 Cron Worker；部署会创建或更新具名 Worker/计划，运行会删除目标 D1 的过期统计行，绝不删除社区表；无公开 HTTP 维护接口，不随菜单程序发布自动部署。须核对目标配置并取得生产授权。

- Python · 导入与数据：`test_apply_pack_names.py`、`test_backfill_pack_image_prompts.py`、`test_import_docx_codex.py`、`test_import_nai5_artist_dictionary.py`、`test_import_nai5_single_artist_webp.py`、`test_import_nai5_community_pack.py`、`test_import_mengshen_korean_pack.py`、`test_import_wof_artist_strings.py`、`test_pack_import_core.py`、`test_clean_nai_default_tags.py`、`test_preserved_display_policy.py`、`test_pack_character_prompts.py`、`test_suozhang_char_prompts.py`。
- Node · 默认尾段：`test_nai_default_tags.mjs`；Python/JS 共用 `fixtures/nai_default_tags.json`，覆盖重复尾段、混序、NAI reset、前文原样保留与 main 实际加载；`test_nai_default_tags_community.mjs` 独立验证待合并模块的适配与加载，缺模块为 BLOCKED，不导入空壳。
- Python · 匹配与编辑：`test_codex_update_match.py`、`test_suozhang_r18_merge_match.py`、`test_import_suozhang_models.py`、`test_import_suozhang.py`、`test_edit_server.py`、`test_nai_api_review_server.py`。
- Node · 本地编辑器目录调序：`test_category_order.mjs`（真实节点与图片列表排序、组内原序、实际过滤链接线、收藏 / 全站搜索排序边界、空目录、旧书原序、分级及缓存失效；仅内存夹具，不写用户数据）。
- Python · 本地版：`test_build_local_edition.py`（在临时目录核对生成站点边界，不运行 PyInstaller）。
- Python · UI 测试驱动：`test_verify_ui.py`（CDP 离开确认/刷新新文档等待，以及 PASS/FAIL/SKIP/BLOCKED 汇总、界面状态与结果状态不串用、必需夹具缺失与 CLI 退出码；合成夹具，不启动浏览器）。统计只读回归使用固定时钟，另验 token 到期前后边界；匹配工具测试兼容直接运行与 `python -m unittest`。
- Node · 换书动效中断：`test_render_ui.mjs` 还会回放 `app.js` 的实际过渡函数，验证隐藏文档导致 ready/finished 拒绝时不产生未处理错误、清理 CSS 状态，且正文渲染失败仍向上传递；仅合成 Promise/DOM，不需要浏览器。
- Python · tag 中文对照：`test_build_tag_zh.py`（查表键夹具、别名不串义、译名优先级、分片确定性与旧分片清理）；Node 侧对应 `test_tag_zh.mjs`，两边共用 `fixtures/tag_zh_keys.json`。
- Node · 详情权重上色：`test_prompt_weights.mjs`（NAI `N::…::`、`{}` / `[]` 与 SD `(…:N)` 的标记位置和加权 / 减权方向；tag 名里的圆括号、转义括号与 tag 内数字不当权重）。
- Python · 画师样张索引：`test_build_artist_index.py`（画师名夹具、去重顺序、书名推版本）；Node 侧对应 `test_artist_core.mjs`（倍率、索引归一、拆解兜底与跳过自身），两边共用 `fixtures/artist_keys.json`。
- Python · 更新样图索引：`test_build_updates_index.py`（更新批次与书内样张共用抽样、成人书自动抽图与解锁标记、公开书排除成人词条、指定样图及失效回退、可见计数门控）。
- R2 联合验证：`test_publish_data_r2_v2.py`、`test_r2_connection_pool.py`、`test_data_release.mjs`、`test_r2_data_compat.mjs` 验现役 v2/dual、条件写/ABA/部分激活、连接复用/代理/不完整响应、跨语言协议、旧 URL/Range/CORS 与精确版本读取；`--profile r2_integration` 集中运行相关旧回归和新检查，不联网生产。`workers/r2-data-compat/worker.js` 为只读薄兼容 Worker，仅路由 `/data/*`；`config.example.jsonc` 为占位示例，生产部署配置以 `workers/r2-data-compat/wrangler.jsonc` 为准；独立测试包装器不进入生产 bundle。
- R2 验证工具边界：`test_verify_r2_cas_integration.py`、`test_verify_r2_reading_browser.py` 仅用合成目录验证 fresh output、拒绝复用、外部路径与重解析点，保留旧报告/日志；不启动浏览器、不接生产。
- Python · 发布与安全：`test_build_share_index.py`、`test_sync_r2.py`、`test_publish_data_r2.py`、`test_publish_safety.py`、`test_publish_entrypoints.py`、`test_favorites_origin_migration_browser.py`、`test_python_tool_safety.py`、`test_lint_docs.py`。
- Node · 数据与路由：`test_entry_aliases.mjs`（同书套图合并的收藏、深链及分享门控）、`test_data_source.mjs`、`test_data_proxy.mjs`、`test_r2_proxy.mjs`、`test_share_backend.mjs`、`test_codex_route_compat.mjs`、`test_path_code.mjs`、`test_404_page.mjs`。
- Node · 共创与后台：`test_admin_community_backend.mjs`、`test_admin_feedback_backend.mjs`、`test_community_backend_low_risk.mjs`、`test_community_frontend.mjs`、`test_community_frontend_low_risk.mjs`、`test_community_likes_backend.mjs`、`test_community_submit_backend.mjs`、`test_community_router_url.mjs`。`test_community_rebuild.mjs` 以真实 handler + 内存 R2 的确定性交错验证聚合条件写：已成功下架不被旧快照覆盖、首次创建、同毫秒同内容 ETag、重读重试、冲突耗尽错误传播及分页；纳入 runner 的 ci 组，不联网、不写生产，不替代真实 R2 平台验收。
- Node · 投稿失败恢复：`test_community_submit_recovery.mjs` 用真实 handler、合成内存 R2 与 SQLite 验每个缩略图/原图写入点失败、写入已完成/晚到但响应失败、条件首建冲突、补偿失败、恢复清单失败及待审占位。纳入 ci 组；仅写内存，不扫描或清理历史对象，不联网，不替代真实 R2/D1 平台验收。
- Node · 主站状态与交互：`test_access.mjs`（四态评级 / 显式 NSFW 与 R18G 路径 / 虚拟来源总闸）、`test_atlas_access_runtime.mjs`（撤权清场、在途换书与反馈异步回写）、`test_browser_history.mjs`、`test_history_storage.mjs`、`test_edit_client.mjs`、`test_search_data.mjs`、`test_search_directories.mjs`、`test_render_ui.mjs`、`test_modal_dismiss.mjs`、`test_modal_layers.mjs`（共享模态生命周期、顶层键盘归属、同一事件不连关下层与语义回焦）、`test_select_menu.mjs`（受控值、键盘/Tab、选项重绘回焦、外点、页面隐藏及销毁解绑）、`test_copy.mjs`、`test_beta_banner.mjs`、`test_local_ownership.mjs`、`test_resume_prompt.mjs`、`test_masonry_viewport.mjs`（视口、手机密度、同宽实测与列保留、布局输入失效、容器终态宽度锁／反向接管／收尾去重）、`test_skeleton_transition.mjs`。
- Node · 本机数据 P2：`test_favorites_replace_confirmation.mjs`（锁内精确损失对象、同数量换身份、备注与夹/关系变化、损坏原文门）、`test_settings_storage.mjs`（设置保存先于 UI、读写/属性/静默故障、重试、多键补偿、侧栏历史及撤权不反写）。`verify_local_data_p2.py --source baseline|fixed --baseline <P1提交> --out-dir output/<隔离目录> [--preview]` 用固定 Git 字节与当前程序运行同组 Chrome 断言；只启动回环夹具/只读预览和独立 profile，自起自关，不接管真实用户存储，不调用生产 API。
- Node · 本机数据 P1：`test_community_favorites_store.mjs`（星标最新底本、renderer 屏障、备份协调、失败反馈）、`test_favorites_note_conflicts.mjs`（别名备注双方原文、备份去重、超预算拒写）、`test_tag_relay_compose.mjs`（等待另存时继续输入与重入）、`node --experimental-vm-modules tools/test_tag_relay_cache.mjs`（25/75ms 独立 renderer 缓存、方案/素材及 revision）。`verify_local_data_p1.py --source baseline|fixed --out-dir output/<隔离目录>` 用 Git 基线与当前程序运行相同 Chrome 安全断言；仅回环资产夹具与隔离 profile，自起自关，不读写真实用户浏览器存储或生产接口。
- Node · 中转站保存故障：`test_tag_relay_compose.mjs` 另验仅 store 异常时的副本等待与真实 debounce 回调、未保存提示、尾段与刷新活跃方案一致、对端后续选择及回滚状态操作门；`test_tag_relay_rollback.mjs` 验主键已写后 signal 与补偿均失败、错误元数据、已排队提交、配额裁剪及迁移入口，另有补偿成功对照。`verify_relay_review_fixes.py --source baseline|fixed --out-dir output/<隔离目录> [--preview]` 用固定 Git 基线和当前程序运行同组真实 Chrome 断言；只启动回环夹具、只读预览与独立 profile，自起自关，不接用户存储或生产 API。
- Node · 存储协调兼容与清空：`test_storage_uuid_fallback.mjs` 验 UUID 缺失、方法与属性拒绝在三条锁路径下的真实四类保存及中转站方案/历史 ID；`node --experimental-vm-modules tools/test_storage_fence.mjs` 验双 renderer 清空/删除信号、同页无事件且持有页空闲时恢复，以及外页未传播、读失败、错误 area 与离页清理。两者只用内存夹具；fence 测试的 `--baseline <提交>` 可用固定 Git 字节作红灯对照。
- Node · 收藏与中转站：`test_favorites_backup.mjs`、`test_favorites_runtime.mjs`、`test_favorites_origin_migration.mjs`、`test_favorites_transfer.mjs`、`test_tag_relay_access.mjs`、`test_tag_relay_core.mjs`、`test_tag_relay_store.mjs`。
- 中转站复制与权限：`test_tag_relay_access.mjs` 保留真实模块导入，覆盖正向／负面／全部按钮的剪贴板文本、成品记录和权限守卫；使用内存 DOM、存储及剪贴板探针，不接系统剪贴板。纳入 `run_project_checks.py` 的 quick 与 ci，防止测试注入依赖掩盖生产漏导入。
- Node · 中转站文本编辑：`test_relay_text.mjs`（文本扫描、折叠与禁用守卫、输出去重、权重范围）、`test_prompt_fragments.mjs`（选择 / 输入分隔、权重边界与原文保留）、`test_copy_fragments.mjs`（准确复制范围、成功收录与异步来源快照）、`test_tag_relay_v3.mjs`（保留的旧库迁移、片段身份、编译、历史与备份）、`test_tag_relay_v4.mjs`（三格式 × 两连接迁移逐字节比较、文本持久化、revision、GC、历史与备份）。仅使用内存夹具，不写用户方案存储；旧节点编辑器测试已随实现删除。
- Python · 中转站文本内核：`verify_relay_editor.py`（独立 Chrome profile、回环临时端口只服务内存夹具与真实 `site/assets`，断言镜像 CSS / 几何 / 实际字符落点、原生撤销、选区和拖放；`--only` 筛选用例）。写 `output/relay-plana-editor-20260921/browser-acceptance/` 截图及结果，`--out-dir` 可指定；不接用户浏览器、不写方案库，不替代真实系统输入法或实体手机验收。
- Node · 收藏夹 V2：`test_favorites_library_core.mjs`、`test_favorites_library_store.mjs`、`test_favorites_backup_store.mjs`、`test_favorites_backup_v2.mjs`、`test_favorites_backup_ui.mjs`、`test_favorites_view.mjs`、`test_favorites_route.mjs`；浏览器模块测试加载器为 `favorites-library-test-loader.mjs`。
- Node · 收藏取件码：`test_favorites_pickup_backend.mjs`（后端路由、限流、一次性与前后端防漂移）；D1 用 `sqlite-d1-test-harness.mjs` 以 `node:sqlite` 模拟，喜欢后端测试共用。
- Node · 投稿 / 反馈防护：`test_submission_guards.mjs`（D1 原子限额与待审名额、D1 不可用时退回、公开反馈快照与推送回写的条件写）；R2 用 `memory-r2-test-harness.mjs`（etag、Headers/对象形式的 `onlyIf` 条件写及首次创建 `*`、可选模拟延迟与读后插入钩子），反馈/共创后台测试共用。共享夹具用递增 ETag，聚合交错测试另用内容哈希 ETag 覆盖同内容版本重复；两者均不是生产存储。

`__pycache__/` 是 Python 缓存，忽略。

### 工程风险专项回归

- `test_edit_server.py` 的 `StableEntryIdTest`：导入后删除最高号、删类/全删、计数缺失/落后、分隔符、历史前缀及事务失败的合成数据回归；定向类纳入 ci，完整编辑器回归在 p2 组运行。
- `test_params_inflate_budget.mjs`：两份参数核心镜像、超限丢弃/错误流输出的累计预算、边界与取消/释放；仅合成 PNG 和流，不接媒体或网络。
- `test_feedback_pagination.mjs`、`test_feedback_pagination_ui.mjs`：全局稳定排序、游标版本冲突、旧记录可达、每请求正文预算，以及实际 admin 模块的翻页/刷新/迁移/取消/草稿保护；UI 测试需 `--experimental-vm-modules`，合成存储、DOM 和 fetch。
- `test_history_resume.mjs`、`test_tag_relay_rail.mjs`：实际历史/中转站脚本的完整恢复契约、未决导航、迟到回调、断点焦点和历史所有权；rail 另用实际 `ui-motion.js` 与受控 WAAPI 验证开合完成、取消、快速反向和布局锁释放；只用合成状态与受控时序。
- `run_project_checks.py --profile p2`：上述六项 P2 的定向检查与受影响的编辑器、后台、历史/收藏/模态回归；执行白名单和副作用以 `--profile p2 --list` 为准，新核心检查纳入 ci。
- `test_local_tool_transactions.py`：合成图片/JSON，验证配图各写入点故障、补偿失败、响应丢失、画师串版本冲突与备份；只写临时目录，不读真实数据。
- `test_strings_editor_state.mjs`：实际画师串编辑脚本配合合成 DOM/fetch，控制跨册迟到加载、失败加载、在途保存及后续编辑；不联网，不替代真实浏览器验收。
- `test_pei_editor_state.mjs`：实际配图编辑器脚本配合合成 DOM/FileReader/fetch，验证迟到载入及读取图片/上传期间切册的身份归属；不联网，不写真实图片。
- `test_moderation_concurrency.mjs`：真实投稿/反馈管理 handler 配合内存 R2，控制旧编辑、下架、撤回、索引首建与失败交错；不使用生产 binding，不替代真实 R2 平台并发验收。
- `test_record_store_edges.mjs`：分页合成 R2 核验逾五万历史记录/永久墓碑不阻塞待审、旧 JSON 损坏隔离、权威/I/O 严格失败及索引准备超时；只读写内存，不联网、不迁移生产。纳入 ci/p1/p2。
- `run_project_checks.py --profile p1`：集中运行上述用例及受影响的本地工具、投稿、反馈、喜欢、通知、聚合与列表回归；完整执行白名单与副作用以 `--profile p1 --list` 为准。上述新增核心回归同时纳入 `ci`。
- `test_frontend_loading_recovery.mjs`：实际 ES module 图的译名失败恢复、搜索截止/取消/权限/release、主站和中转站重试接线；中转站另验隐藏/关闭/空白零请求、输入与正负栏按需加载、来源分片及迟到重画。Node 需 `--experimental-vm-modules`，合成 fetch/时钟，不联网；`verify_frontend_loading_recovery.py --only-relay` 用真实页面补验按需请求和故障恢复。
- `test_feedback_list_budget.mjs`、`test_feedback_list_client.mjs`：假 R2 分页、读正文预算、最新排序/版本冲突、加密缓存和 202 有界客户端续载；仅合成对象与口令。
- `test_benchmark_search_v1.mjs`：固定公共语义、数据摘要、采样分布、完整排序结果、冻结报告可比性、10% 回退判定、空数据及旧比较不可比闸门；写临时合成 JSON，不读取私密法典。

本机搜索基准可先把 `node tools/benchmark_search_v1.mjs` 的完整标准输出冻结到新的 `output/` 文件，再运行 `node tools/benchmark_search_v1.mjs --baseline-report <该文件>`。仅接受成功 JSON 或原始成功输出；失败/不完整报告不能充当基线。不同源码允许比较，但必须保留两端源码哈希；同源码重复测量只反映运行波动。比较前应停止并行重负载；失败日志必须保留，不反复重跑挑选绿色结果。历史 `--compare-legacy` 的不可比诊断仍独立保留。
- `test_publish_safety.py`：合成媒体缺失/可选原图、FakeR2 受控发布回滚交错、条件请求签名与未知结果；含隔离数据的默认计划模式，不读取真实配置、上传或激活。


## 永久下架记录

`data/image_takedowns.json` 是 Git 精确忽略的本地私有登记册，不纳入公开仓库；保存已核验的图片下架身份与完整字节 SHA-256，字段及私有备份边界见 `data/README.md`。当前仅登记，尚未接入公共导入、同步、发布与回滚检查，不能据此宣称自动防复入已生效。

## 操作说明去向

- `codex_update_match.py` / `suozhang_r18_merge_match.py` 的基线回放、全局匹配、角色词收尾和应用门禁：读本地私有文档 `docs/经验/Word法典增量更新.md`。
- `sd_metadata_inspector.py` 的支持格式、隐写提取、tag 对照和图包公共契约：一般配图读本地私有文档 `docs/经验/配图与图包导入.md`，图包读 `docs/经验/统一图包类导入规范.md`。
- 其它脚本：先看本台账状态，再运行 `python tools/<脚本>.py --help`；没有对应 Playbook 且风险不明时只做预演或停止确认。

## 安全建议

- 不确定时先查本行的准确边界，再选明确标为只读的模式；不能从文件名、`plan`、`validate`、`check-only` 或“不带 `--apply`”猜默认副作用。
- `sync_r2.py` 的严格本地不写模式只有 `--dry-run`；配置完整时即便 dry-run 也会列举 R2 并探测本地缺失的必需媒体首字节。`--check-only` 只禁止上传与同步清单更新，仍可能回写法典 JSON 和 `media.json`；其退出码目前忽略 `strings_counts["upload"]`，所以仅 strings 图片缺失或变化时可能仍为 0，必须同时检查 `remote sync` 与 `strings sync` 两段的 `upload` / `fail`，不得把 exit 0 当作全部 R2 对象齐全。默认模式会联系并写入 R2；运行前必须核对 `r2_config.json`，生产上传仍需明确授权。
- 写数据前先检查工作树和工具自己的差异报告；`site/data/`、`site/images/`、`originals/` 被 Git 忽略，不能只靠 `git status` 判断是否混入旧改动。
- 一次性导入器即使自带中止保护也不得绕过；需要复用时先把它改造成针对现行 schema 的新流程并重新审核。
- 工具生成 `output/` 不等于正式数据已应用，更不等于 R2 或 Pages 已发布。

> 归档脚本的配套测试跟着脚本一起进了 `tools/attic/`：`attic/test_merge_nai45_artist_books.py`、`attic/test_merge_nai45_community_packs.py`。它们不在上面的现役清单里，必须逐文件运行，不能把通配符当成台账登记。
