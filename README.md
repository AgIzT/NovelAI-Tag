# NAI Prompt · 画师串画廊

[示例站点](https://novelai-tag.pages.dev/)

把大家整理筛选的 NovelAI **画师串**（artist prompt 组合配方）做成图为主的瀑布流画廊——看图选串，一键复制 prompt 到 NovelAI 直接出图。

同时也保留了原有的「法典图鉴」功能，方便萌新和休闲用户照着例图选词、一键复制。

## ✨ 主要特性

### 画师串画廊（`/strings.html` · 主打）
- 🖼️ **瀑布流卡片**：图为主，浏览各画师串的出图效果
- 📋 **一键复制**：点击卡片直接复制完整 prompt，即拿即用
- 🏷️ **标签筛选**：按标签（少女 / 萝莉 / 成女 / NSFW 等）快速过滤
- ❤️ **NSFW 开关**：默认隐藏 NSFW 内容，点击爱心按钮可切换显示
- 🔍 **详情面板**：展开查看完整 prompt、备注说明、多张例图
- 🛠️ **可视化编辑器**：GUI 编辑/新增/删除画廊条目，上传图片，无需手写 JSON

### 法典图鉴（`/index.html` · 保留）
- 🗂️ **法典导航**：顶部切换法典，左侧目录树自动跟随
- 🆕 **新增角标**：自动识别「本次更新新增」标记
- 🔍 **中英实时搜索**、🌙 **深色模式**、📱 响应式、点图放大
- 🧩 **零构建静态站**：纯 HTML/CSS/JS，部署到 Cloudflare Pages

## 🚀 本地使用（Windows 双击即用）

> 前置：本机装好 Python 3，并 `pip install -r requirements.txt`

### 画师串编辑器
| 操作 | 说明 |
|------|------|
| **启动编辑服务** | 双击 `画师串编辑.bat` → 打开 http://localhost:8765 |
| **编辑条目** | GUI 表单编辑标题、prompt、标签、备注、NSFW 标记，拖拽上传图片 |
| **保存** | 点击保存后 JSON 自动写入 `site/data/strings.json`，图片存入 R2 |

### 法典图鉴工具（原有功能）
| 操作 | 说明 |
|------|------|
| **转换法典** | 把 `.docx` 放进 `法典源/` → 双击 `转换法典.bat` |
| **配图** | 双击 `配图工具.bat` → 把图拖到对应词条上（自动压缩、命名） |
| **预览** | 双击 `启动预览.bat` → 打开 http://localhost:8766 |
| **同步图片** | 复制 `r2_config.example.json` 为 `r2_config.json`，填入 R2 密钥 → 双击 `同步R2.bat` |

## ☁️ 部署上线

静态站，无需构建：
- **Cloudflare Pages**（推荐）：连接本仓库，Build command 留空，**Build output directory 填 `site`**
- 根路径自动 302 跳转到 `/strings.html`（画师串画廊）

更新流程：本地编辑 → 双击 `发布.bat`（先同步 R2，再 git push）→ 平台自动重新部署。

> 词条数据存在本仓库；图片发布到 Cloudflare R2，GitHub 仓库不保留图片文件。

## 📁 目录结构

```
site/                  ← 部署的网站本体（无需构建）
  _redirects           根路径 → /strings.html
  strings.html         画师串画廊（主打页面）
  index.html           法典图鉴（保留）
  assets/
    strings.js         画廊逻辑（瀑布流 / 筛选 / NSFW / 详情）
    app.js             法典图鉴逻辑
    styles.css         样式
    favicon.svg
  data/
    strings.json       画师串数据
    codexes.json       法典索引
    codex_*.json       各法典条目数据
    media.json         R2 存储桶配置
  images/
    strings/           画师串 Example 图（来自 R2，本地不保留）

tools/
  strings_editor.html  画师串可视化编辑器
  strings_server.py    编辑器后端服务（保存 JSON + 图片上传）
  convert.py           docx → 网站数据(JSON)
  imgserver.py         本地配图服务
  pei.html             配图工具界面
  sync_r2.py           Cloudflare R2 同步脚本
  preview_server.py    本地预览服务器（法典图鉴用）

画师串编辑.bat / 配图工具.bat / 启动预览.bat / 同步R2.bat / 发布.bat
```

## 🙏 说明与致谢
- 画师串 prompt 内容来自社区分享；本项目提供更好的浏览/复制体验
- 法典 tag 内容版权归各位原整理者所有
- 瀑布流界面参考了 [orilights/PixivCollection](https://github.com/orilights/PixivCollection)
- 代码部分可自由使用、修改
