# 主站前端模块地图

本文件是 `site/assets/app.js`、`site/assets/data-source.js` 与 `site/assets/app/*.js` 的导航表，回答四件事：模块负责什么、持有哪些模块级状态、静态依赖谁、哪些能力通过注入或动态加载接线。

代码仍是实现现状的最终依据；本表只记录稳定边界，不复制交互尺寸、动画时长、迁移经过或完整算法。改动模块职责、静态 `import`、公开出口或动作注入时，应在同一提交更新本表。

## 怎么按需读

1. 已知文件名：在本文搜索精确文件名，只读对应行，再进入源码。
2. 只知道功能：先看下面的分组；跨模块链路再看“必须保持的接线约束”。
3. 要了解整站关系或设计理由：转到本地私有文档 `docs/architecture.md`、`docs/decisions/README.md` 或 `docs/经验/README.md`，不要从本表反推历史。

字段口径：

- “主要出口”只列供其他模块使用的代表性导出，不代替源码里的完整 `export` 清单。
- “模块状态”只列影响生命周期或缓存一致性的可变状态；常量和函数内局部变量不展开。
- “直接依赖”只列静态 `import`，重复导入按一个文件计算；`—` 表示没有静态依赖。
- “注入 / 边界”记录动作注入、动态 `import`、跨页面复用或不得打破的方向约束。

## 入口与基础能力

| 模块 | 职责 / 主要出口 | 模块状态 | 直接依赖 | 注入 / 边界 |
| --- | --- | --- | --- | --- |
| `../app.js` | 主站组合根；`init`、`loadCodex`、`openRelatedDirectory`、收藏 / 全站搜索视图、筛选与搜索编排 | 法典加载序号、收藏备份绑定标记、目录选项缓存 | `state.js`、`utils.js`、`feedback.js`、`access.js`、`data.js`、`search.js`、`search-directories.js`、`search-ui.js`、`media.js`、`favorites.js`、`favorites-backup-core.js`、`favorites-backup.js`、`fav-codex.js`、`site-search.js`、`masonry.js`、`lightbox.js`、`copy.js`、`report.js`、`router.js`、`codex-route-compat.js`、`path-code.js`、`codex-ui.js`、`history.js`、`ui.js`、`onboarding.js`、`intro.js`、`resume-prompt.js`、`browser-history.js`、`tag-relay.js` | 把 `q + f` 编译为统一搜索计划，先做权限过滤再统计结果 / 目录；全部 `set*Actions(...)` 先于 `init()`，本地编辑器满足探测条件后才动态导入 `edit.js` |
| `../data-source.js` | 选择并读取 R2、同源代理或本地数据；`initializeDataSource`、`fetchDataJson*`、`getDataSource` | 初始化 Promise、当前数据源与 release 上下文 | — | 主站与共创广场共享；同一批引导数据必须来自同一 release，失败时整批切换来源 |
| `state.js` | 全局运行态、存储键、密度和搜索范围规范化 | 共享 `state` 对象，含规范搜索草稿 / 筛选 / 语法问题 / 计划、相关目录及总数 | — | 只放跨模块运行态；模块私有状态留在所属模块 |
| `utils.js` | DOM 查询、转义、安全 URL、路径比较、动效偏好、滚动与数值工具 | — | — | 无业务状态的通用工具层 |
| `path-code.js` | `encodePathCode`、`pathFromCode`；目录路径与地址栏短码互转 | — | — | 编码是纯函数；解码需要法典树，分类改名后旧短码回退到可解析位置 |
| `codex-route-compat.js` | `normalizeRoutePath`、`normalizeCodexRoutePath`；并册、改名、迁移后的旧路径兼容 | — | — | 保留只读迁移表；加载、历史恢复与最近浏览共用同一归一逻辑 |
| `access.js` | 法典级与词条级 NSFW / R18G 判定、锁定提示 | — | `state.js`、`feedback.js` | 所有内容分级入口的单一判断层；调用方不得自行拼另一套门控 |
| `media.js` | 图片能力判断、资源路径、版本参数、缩略图与原图 URL | — | `state.js` | 只解决资源定位，不判断“用户是否有权看原图” |
| `nai-sd.js` | `naiToSd`、`fmtSdWeight`、`formatCopyText` | — | — | 无 DOM 的格式转换层，主站和共创广场可复用 |
| `sd-mode.js` | SD 模式的 localStorage 读写契约 | — | — | 共创广场通过同一存储契约同步，不导入主站 `state` |
| `local-ownership.js` | 读取、记录和枚举本地拥有的反馈 / 投稿记录 | — | — | 有界且会过期的本地标记；不充当服务端权限证明 |
| `clipboard.js` | `writeClipboardText`；统一返回 Clipboard API、旧式复制或手动复制结果 | — | — | 无 UI 的能力层；失败后的面板由调用方交给 `clipboard-fallback.js` |
| `clipboard-fallback.js` | 手动复制面板的显示、关闭与敏感文本清除 | 延迟创建的面板实例 | `modal.js` | 撤销分级权限时必须清空 DOM 中残留的待复制文本 |
| `ui-motion.js` | 局部界面动效的启动 / 取消与偏好门控；`animateUi`、`cancelUiMotion` | 按元素保存的动画句柄 | `utils.js` | 只取消自身持有的动画，结束释放合成样式；不持有业务状态 |
| `modal.js` | 遮罩开关、焦点陷阱、历史层登记；`bindBackdropDismiss` / `bindOutsideDismiss` | 遮罩计时器、焦点返回点与各关闭绑定的指针起终点 | `utils.js`、`browser-history.js` | 外部点击关闭统一检查同次指针的起终点；保留键盘 click，绑定返回解绑函数；各弹层复用遮罩 / 焦点机制 |
| `browser-history.js` | 页面无关的路由记录、`beginLayeredSearch`、覆盖层栈、恢复令牌与滚动检查点 | 当前记录、恢复状态、待返回操作、层注册表与计时器 | — | 页面通过 `configureBrowserHistory` 注入 `captureRoute`、`urlForRoute`、`applyRoute`、`restoreScroll`、`isEmptySearchRoute` |
| `feedback.js` | 加载态、骨架屏与可操作 toast | 骨架屏和 toast 的计时 / 焦点状态 | `utils.js` | 只提供反馈表面，不拥有业务提交 |
| `feedback-progress.js` | 反馈状态元数据、关闭态判断与公开进度流 | — | — | 浏览器与管理端共享的纯数据契约 |

## 数据、路由、搜索与收藏

| 模块 | 职责 / 主要出口 | 模块状态 | 直接依赖 | 注入 / 边界 |
| --- | --- | --- | --- | --- |
| `data.js` | 引导数据、法典加载、规范化、目录树、更新筛选和数据状态提示 | — | `state.js`、`utils.js`、`media.js`、`feedback.js`、`../data-source.js` | 下载中的 Promise 先写入 `state.codexCache`，并发调用共享；失败时只清理对应 Promise 以允许重试 |
| `search.js` | `q + f` 查询解析 / 序列化、字段筛选、稳定相关性排序、短语高亮与缓存失效 | 默认文本、字段值、筛选 needle 与目录短码的每词条 `WeakMap` 缓存 | `state.js`、`media.js`、`favorites.js`、`path-code.js` | 默认召回严格限于标题、标签和角色正向提示词；已知非法语法 fail-closed；编辑器原地改词条后必须调用 `invalidateSearchableText` |
| `search-directories.js` | 构建目录选项、相关目录排序与缓存失效 | 按 entries 身份、来源模式、法典身份和权限态缓存目录表 | `state.js`、`access.js`、`path-code.js` | 只生成权限过滤后的真实来源目录；最终同级顺序取真实 tree，最多展示 5 项但保留完整 `totalCount` |
| `search-ui.js` | 中文筛选构造器 / popover、chip、错误 / 零结果状态与相关目录渲染 | 注入动作及委托点击所需的筛选 / 目录引用及条件标签动效 | `ui-motion.js` | 不拥有搜索或历史状态；注入添加 / 删除 / 清空筛选、示例、打开目录和状态动作 |
| `router.js` | URL 读写、规范标题、分享路径、`hasActiveSearchRoute`、`beginAtlasLayeredSearch` 与词条深链 | `routerActions` | `state.js`、`utils.js`、`search.js`、`path-code.js`、`media.js`、`feedback.js`、`access.js`、`browser-history.js` | `q` 保存正向输入，规范筛选用重复 `f`，浏览目录仍用 `p`；首次搜索保留 push，后续变更 replace，移动搜索保留分层 Back；规范地址规则见本地私有文档 `docs/decisions/短链与地址栏规范地址.md` |
| `copy.js` | 词条 / 文本复制、组合提示词、最近记录、复制动效与中转站收入 | 已复制样式的计时器 `WeakMap` | `state.js`、`feedback.js`、`history.js`、`clipboard.js`、`clipboard-fallback.js`、`nai-sd.js`、`copy-fx.js`、`tag-relay-rail.js`、`tag-relay-store.js`、`tag-relay-snapshot.js`、`access.js`、`data.js` | 只有复制成功后才提交最近记录和中转站收入；带来源的复制先冻结并复核分级，无法确认时保持锁定 |
| `favorites.js` | 收藏键、读写、按钮状态、切换收藏 | 动作注入、法典别名缓存、延迟刷新标记 | `state.js`、`feedback.js`、`data.js`、`favorites-backup-core.js`、`favorites-backup.js` | 注入 `applyFilter`、`refreshFavoritesView`；虚拟视图通过 `_srcCodexId` 还原真实归属 |
| `favorites-backup-core.js` | 备份格式、校验、归属归一、恢复计划、双键提交与回滚 | — | — | 浏览器无关的纯逻辑；公开备份契约只在这里定义 |
| `favorites-transfer.js` | 有大小上限的 gzip / base64url 文本传输编解码 | — | — | 使用浏览器原生压缩流，不支持时回退原始 JSON |
| `favorites-origin-migration.js` | 旧 Pages 域收藏迁移 URL、可信消息、标记与恢复桥 | — | `favorites-backup-core.js` | 由收藏备份流程和独立救援页调用；缘由见本地私有文档 `docs/decisions/旧Pages域收藏迁移桥.md` |
| `favorites-backup.js` | 收藏导入导出面板、同页 / 跨页变更通知与旧域迁移入口 | 对话框状态、法典索引 Promise | `modal.js`、`browser-history.js`、`favorites-backup-core.js`、`favorites-origin-migration.js`、`../data-source.js`、`favorites-transfer.js`、`clipboard.js`、`clipboard-fallback.js` | 页面提供法典索引；只广播受影响 scope，各页面自行重读内存收藏 |
| `fav-codex.js` | 构建“全部收藏”虚拟法典 | — | `state.js`、`data.js`、`access.js`、`media.js`、`favorites-backup-core.js` | 不写入 `state.codexes`；给条目补 `_src*`，并暴露各真实来源的 `_sourceDirectoryTrees` 供目录排序 |
| `site-search.js` | 构建并失效“全站搜索”虚拟法典 | 成功结果缓存、在途 Promise、失效代次 | `state.js`、`data.js`、`access.js`、`media.js` | 只缓存完整成功且非降级的结果；编辑后显式失效；条目携带 `_src*`，并按来源顺序暴露 `_sourceDirectoryTrees` |
| `history.js` | 最近复制、浏览快照、恢复、打开历史条目与滚动复位 | `historyActions`、保存计时 / 抑制状态、恢复代次 | `state.js`、`utils.js`、`media.js`、`router.js`、`codex-route-compat.js`、`access.js`、`feedback.js`、`data.js`、`fav-codex.js`、`site-search.js`、`browser-history.js` | 注入 `loadCodex`、两个虚拟视图入口、`openEntryDeepLink`、`renderTree`、`applyFilter`、`updateVirtualCards`；不得反向导入 `copy.js` |

## 页面与交互表面

| 模块 | 职责 / 主要出口 | 模块状态 | 直接依赖 | 注入 / 边界 |
| --- | --- | --- | --- | --- |
| `codex-ui.js` | 法典选择器、目录树、横幅、分类轨、结果 / 空态、随机浏览与归档 UI；`exampleModel` 覆盖书卡 / 横幅的原图状态签；`codexCoverStyle` 共用封面位置与缩放 | 动作注入、访问视图缓存、目录监听、分支动效、提示 / 面板状态 | `state.js`、`utils.js`、`access.js`、`data.js`、`media.js`、`feedback.js`、`browser-history.js`、`modal.js`、`ui-motion.js` | 注入 `loadCodex`、`applySearch`、`applyFilter`、`openLightbox`、`syncUrlState`、`updateVirtualCards`；编辑器可追加 `decorateDoor` |
| `masonry.js` | 虚拟瀑布流、卡片、图片加载、测高、重排与入场动效 | 动作注入、布局缓存、虚拟窗口、重排与动效状态 | `state.js`、`utils.js`、`feedback.js`、`search.js`、`media.js`、`copy.js`、`favorites.js`、`codex-ui.js` | 注入 `openLightbox`、`copyEntry`、`toggleFav`、`reportEntry`；不静态导入 `lightbox.js` 或 `report.js` |
| `lightbox.js` | 灯箱开关、跨词条步进、预载、原图 / 分享 / 收藏 / 反馈与 FLIP 辅助 | 当前序号、关闭计时、焦点与缩略图身份、预载缓存 | `state.js`、`utils.js`、`masonry.js`、`search.js`、`copy.js`、`nai-sd.js`、`history.js`、`router.js`、`data.js`、`media.js`、`original-capability.js`、`access.js`、`report.js`、`browser-history.js`、`favorites.js`、`modal.js` | 原图提示按真实来源的 `exampleModel` 标明模型；背景关闭复用手势门并保留滑图后的 click 抑制；灯箱动效维护方式见本地私有文档 `docs/经验/前端灯箱FLIP动效.md` |
| `report.js` | 反馈提交、上下文打包、公开进度列表和兜底复制 | 当前提交上下文、触发点、公开列表 / 筛选状态与页签动效 | `state.js`、`utils.js`、`feedback.js`、`modal.js`、`media.js`、`original-capability.js`、`feedback-progress.js`、`local-ownership.js`、`clipboard.js`、`clipboard-fallback.js`、`ui-motion.js` | 拥有反馈业务；由瀑布流动作注入调用，不反向依赖瀑布流 |
| `announcements.js` | 动态面板：公告 / 更新 / 反馈三页签切换、公告加载与未读角标 | 公告数据、加载状态与在途 Promise、当前页签与切换动效 | `ui-motion.js`、`utils.js`、`modal.js`、`history.js`、`updates.js`、`../data-source.js` | 数据读取走统一数据源，不自行拼发布路径；只把当前打开的那一栏标记为已读，未翻到的栏保留红点 |
| `updates.js` | 跨书更新时间线：`loadUpdates`、`updatesDigest`、面板列表与顶栏气泡渲染、已读标记、行点击派发 | 批次数据、加载状态与在途 Promise；已读集合存 `localStorage` | `utils.js`、`data.js`、`codex-ui.js`、`../data-source.js` | 注入 `openBatch`（`app.js` 提供：换书 + 落到该批次筛选）。条数口径必须与 `data.js` 的 `updateFilterDefinitions` / `entryMatchesUpdateFilter` 以及 `tools/build_updates_index.py` 三处一致；行点击的 `consumeLayer` 由调用方声明，本模块不推断 |
| `onboarding.js` | 首次引导的设置、判断和手动打开 | 初始路由、步骤与本次提示标记 | `utils.js`、`modal.js` | 初始深链不强插引导；历史行为交给共享模态层 |
| `resume-prompt.js` | 是否提示恢复上次浏览、一次会话提示与永久拒绝 | 当前提示节点与计时器 | `state.js`、`history.js` | 只判断和呈现，真正恢复委托给 `history.js` |
| `intro.js` | 开场显影状态机、数据就绪门、跳过与 settle 事件 | settle / data-ready Promise、计时器、计数动画和跳过绑定 | `utils.js` | 尊重 reduced motion；实现细节见本地私有文档 `docs/经验/前端页面动效.md` |
| `copy-fx.js` | 复制采样提示、收入中转站的抛入反馈 | 单例节点、动画句柄、计时器、代次与最近指针位置 | — | 仅在复制成功后由 `copy.js` 触发；动画数值留在代码和动效经验，不写死在地图 |
| `home-shortcut.js` | 平台 / WebView 判断与添加主屏幕指引 | 延迟创建的指引面板 | `modal.js`、`utils.js` | 只提供快捷方式说明，不承诺离线能力 |
| `original-capability.js` | 还原真实来源法典并判断某张图能否向用户暴露原图 | — | `state.js`、`data.js`、`media.js` | 与“资源有没有原图”分层；调用方不得只看 URL 存在性 |
| `ui.js` | 全局事件绑定、主题 / 密度 / 搜索范围 / 中文筛选 / 分级开关、顶栏动态气泡开合与页面级编排 | `uiActions`、主题图标表、首次搜索历史意图跟踪器 | `state.js`、`utils.js`、`feedback.js`、`access.js`、`codex-ui.js`、`router.js`、`search.js`、`search-ui.js`、`history.js`、`masonry.js`、`lightbox.js`、`clipboard-fallback.js`、`modal.js`、`announcements.js`、`updates.js`、`report.js`、`onboarding.js`、`tag-relay-rail.js`、`tag-relay.js`、`home-shortcut.js`、`resume-prompt.js`、`browser-history.js`、`ui-motion.js` | 注入 `loadCodex`、两个虚拟视图入口、`exitSiteSearchView`、`applySearch`、`applyFilter`、`openRelatedDirectory`；输入法组合期间不解析或写历史 |

## Tag 中转站

整体取舍和交互约束以本地私有文档 `docs/decisions/Tag中转站.md` 为准；这里仅记录代码分层。

| 模块 | 职责 / 主要出口 | 模块状态 | 直接依赖 | 注入 / 边界 |
| --- | --- | --- | --- | --- |
| `tag-relay-core.js` | 版本化状态、稳定键、方案 CRUD、排序、格式编译、去重明细与复制历史 | — | `nai-sd.js` | 纯计算、无 DOM；负责可序列化不变式，不负责并发写入或分级查询 |
| `tag-relay-snapshot.js` | 活词条转可序列化快照、真实来源键与快照锁定判断 | — | `access.js`、`data.js`、`media.js`、`state.js`、`tag-relay-core.js` | 分级与 `_srcCodexId` 在收入时冻结；锁定判断读当前内存权限，不绕到 localStorage |
| `tag-relay-store.js` | `relayState`、`commitRelay`、复制收入、订阅与跨标签页同步 | 唯一内存副本、订阅表、并发 / 广播状态 | `feedback.js`、`tag-relay-core.js`、`tag-relay-snapshot.js` | 状态的唯一所有者且不导入视图；`commitRelay` 是异步唯一写入口，调用方必须 `await` |
| `tag-relay-action.js` | 侧栏内的命名、确认和取消操作条 | 当前操作、引用与焦点返回点 | — | 轻量内联交互，不另叠浏览器原生 `prompt` / `confirm` |
| `tag-relay-rail.js` | 侧栏外壳、开关、响应式模态判定、分区定位与脏标记 | 外壳 / 背景引用、当前分区、渲染器与脏集合 | `utils.js`、`browser-history.js`、`modal.js`、`tag-relay-action.js` | `setRailPaneRenderers` 注入素材和编排渲染器，避免外壳与内容互相静态导入；停靠态不是历史层 |
| `tag-relay-compose.js` | 方案块编辑、排序、输出预览 / 复制、历史恢复与访问刷新 | DOM 引用、选中项、输出格式、连接方式、拖拽 / 编辑器状态 | `feedback.js`、`copy.js`、`tag-relay-action.js`、`tag-relay-core.js`、`tag-relay-snapshot.js`、`tag-relay-store.js`、`modal.js` | 成品复制关闭再次格式转换且不携带词条来源，避免二次转换和回流收入 |
| `tag-relay.js` | 中转站接线、素材仓库、收藏来源与入口计数 | 绑定标记、素材根、来源模式、收藏缓存 / 加载状态 | `access.js`、`data.js`、`fav-codex.js`、`favorites-backup.js`、`feedback.js`、`media.js`、`tag-relay-action.js`、`tag-relay-core.js`、`tag-relay-rail.js`、`tag-relay-compose.js`、`tag-relay-snapshot.js`、`tag-relay-store.js` | 初始化 store、rail、action、compose，并把 `renderWarehouse` / `renderCompose` 注入外壳；不改写主站共享法典状态 |

## 本地编辑器

| 模块 | 职责 / 主要出口 | 模块状态 | 直接依赖 | 注入 / 边界 |
| --- | --- | --- | --- | --- |
| `edit.js` | `initEditMode`；本地词条、目录、法典与图片编辑 UI | 服务端能力、注入动作、启用 / 保存 / 弹层与当前词条状态 | `state.js`、`utils.js`、`feedback.js`、`lightbox.js`、`codex-ui.js`、`modal.js`、`../data-source.js`、`search.js`、`search-directories.js`、`masonry.js`、`site-search.js`、`edit-core.js` | `app.js` 探测同源 `/__edit__/ping` 成功后才动态导入；原地编辑后同时失效词条文本、目录和全站搜索缓存；线上不得静态加载 |
| `edit-core.js` | 路径编解码、目录列表、搜索结果还原、图片名标题、角色提示归一、字段 diff / 校验 / 合并 | — | — | 无 DOM 的纯函数，供 `edit.js` 与 Node 测试复用；维护方式见本地私有文档 `docs/经验/本地嵌入式编辑器.md` |

## 必须保持的接线约束

- `app.js` 是主站唯一组合根：所有 `set*Actions(...)` 必须先于 `init()`；新增跨层回调优先在这里接线。
- `router.js`、`history.js`、`codex-ui.js` 通过注入调用瀑布流，避免反向静态依赖；`masonry.js` 同理通过动作注入打开灯箱和反馈。
- `browser-history.js` 必须保持页面无关。历史层的底层 open / close handler 不得自己改 history；用户动作包装器才决定 push、replace 或 back。完整套路见本地私有文档 `docs/经验/浏览器历史状态管理.md`。
- 内容分级统一经过 `access.js`；快照、历史或虚拟视图无法证明可访问时，保持 fail-closed。
- 收藏和全站搜索是临时虚拟法典，不进入 `state.codexes`；跨法典消费者必须用 `_src*` 回到真实来源。
- 普通搜索默认只召回标题、标签和角色正向提示词；隐藏字段必须由显式筛选访问，路径文字不得把目录内容混入图片结果。
- 搜索地址把正向输入留在 `q`、规范筛选放进重复 `f`；相关目录和精确目录筛选都必须在权限过滤后基于真实来源树生成。
- 旧 typed-syntax `q` 用 `replaceState` 规范化，旧 plain `q` 在没有 `scope` 时仍按当前法典解释；全站异步构建完成后和 View Transition 前都要重验搜索意图。
- 移动搜索使用 layered Back；底层 open / close 不直接写 history，首次搜索的 push 不得被后续 replace 吞掉。
- Tag 中转站保持 core → snapshot / store → rail / compose / wiring 的方向；视图不得绕过异步 `commitRelay` 直接保存。
- `edit.js` 只允许在本地探测成功后动态加载；生产入口不得增加对它的静态 `import`。
