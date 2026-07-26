# 法典图鉴 · NovelAI 提示词站点
![alt text](image.png)

## 📚简介
[在线访问 → novelai.quicktagcloud.com](https://novelai.quicktagcloud.com/)

把社区大佬整理的 NovelAI 提示词「法典」做成 **图为主、点一下就复制** 的网页站点。
定位：**忠实复刻**这些法典，让萌新和休闲用户照着例图选词、一键复制到 NovelAI

## ✨ 特性
- 🖼️ **图为主瀑布流**
- 🔍 **中英实时搜索** + 轻量搜索语法
- ⚖️ **SD 权重转换**
- 🧩 **零构建静态站**：纯 HTML/CSS/JS ES Modules，可直接部署到 Cloudflare Pages / GitHub Pages
- ✏️ **本地编辑模式**：直接增删词条、调整分类和图片

## 🚀 本地使用与编辑（Windows）

1. 前往 [GitHub Releases](https://github.com/AgIzT/NovelAI-Tag/releases)，下载最新的 `法典图鉴本地版-YYYYMMDD.zip`。
2. 完整解压 ZIP。
3. 双击 `法典图鉴本地版.exe`。如果 EXE 无法直接启动，可改用同目录的 `启动法典图鉴.bat`。
4. 浏览器会自动打开，编辑模式首次默认开启；可通过顶栏铅笔按钮切换编辑与展示模式。编辑模式下点击卡片可修改词条和图片；点击顶部法典名称，再从菜单底部进入“法典管理”，即可新建、修改或删除法典。
5. 关闭“法典图鉴本地版”的命令行窗口即可停止服务；下次继续双击同一个 EXE。

发行包内置一本可自由修改或删除的示例法典。法典数据保存在 `site/data/`，缩略图保存在 `site/images/`，原图保存在 `originals/`，保存前的自动备份位于 `output/edit-backups/`。本地版只监听本机地址，内容不会自动上传；迁移或备份时建议直接复制整个解压目录。

## ☁️ 部署上线
静态站，无需构建：
- **Cloudflare Pages**：连接本仓库，Build command 留空，**Build output directory 填 `site`**
- **GitHub Pages**：把 Pages 源指向 `site/` 目录

正式站把应用代码部署到 Pages，把版本化法典 JSON、缩略图和原图发布到 Cloudflare R2；仓库里的 `site/data/` 同时作为本地编辑源、历史快照和故障回退。

维护动作统一从根目录的 `法典图鉴.bat` 总控台进入（也可以直接双击 `单项工具/` 里对应的那一个）：

- **菜单 4 发布数据**：同步图片、生成分享索引并原子切换 R2 数据版本，不提交 Git、不触发 Pages 部署。
- **菜单 5 发布程序**：先发布同一批 R2 数据，再提交并推送 Git，由 Pages 自动部署。
- **菜单 6 回滚数据**：确认后切回上一个 R2 release，只换指针、不删除任何版本。

自行部署时不配置 R2 数据发布层也能跑：站点会直接读随部署带上的 `site/data/`。数据路径相对页面解析，因此部署在域名根目录或子路径（GitHub Pages 项目站）都可以。

## 📁 目录结构
```
法典源/            法典 .docx 源文件
tools/
  convert.py       docx -> 网站数据(JSON)
  imgserver.py     本地配图服务
  sync_r2.py       图片同步到 R2
  publish_data_r2.py  版本化 JSON 发布到 R2
  preview_server.py  本地预览服务
site/              ← 部署的网站本体
  index.html
  strings.html     画风串分享页（社区投稿库）
  assets/          样式与脚本（app.js + ES Modules）
  data/            本地编辑源 + 部署时携带的稳定回退快照
  data-source.json 正式域名的 R2 数据入口
functions/         Cloudflare Pages Functions（投稿 / 反馈 / 喜欢后端）
法典图鉴.bat       ← 总控台（唯一入口，只做菜单，动作都委托给下面这些）
单项工具/          编辑器 / 配图 / 转换法典 / 发布数据 / 发布程序 / 回滚数据 /
                   打包本地版 / 预览 / 本地后端测试 / 回归验证 / 清理 / 数据库迁移
originals/ 与 site/images/ 是本地图片缓存，会同步到 R2。
```

## 📄 授权
**代码 MIT** 其他范围详见 [LICENSE](LICENSE) 的「授权范围说明」。

| 部分 | 授权 |
|---|---|
| 前端代码 / 样式 / 本地工具 | MIT |
| 词条原文与原始分类 | 归各**原编纂者**，本项目无权转授 |
| 配图 | 有标识的第三方贡献者；本项目生成筛选的 © AgIzT |
| 数据汇编结构（schema / 分类体系 / 稳定 ID / 目录树 / 分级） | 汇编作品 © AgIzT，未经许可不得再分发 |

**欢迎用本项目搭你自己的图鉴**

## 🙏 说明与致谢
- 法典 tag 内容版权归各位**原整理者**所有；本项目只忠实呈现其成果。
- 瀑布流界面参考了 [orilights/PixivCollection](https://github.com/orilights/PixivCollection)。
