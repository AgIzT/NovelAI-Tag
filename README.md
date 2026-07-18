# 法典图鉴 · NovelAI 提示词图鉴
![alt text](image.png)

## 📚简介
[在线访问 → novelai.quicktagcloud.com](https://novelai.quicktagcloud.com/)

把社区大佬整理的 NovelAI 提示词「法典」做成 **图为主、点一下就复制** 的网页图鉴。
定位：**忠实复刻**这些法典，让萌新和休闲用户照着例图选词、一键复制到 NovelAI——而不是又一个 tag 商店。

## ✨ 特性
- 🖼️ **图为主瀑布流**：照图选词，看对眼了点一下就复制整条 prompt
- 📋 **整卡点击复制** + ✓ 提示，复制即用
- 🗂️ **法典 / 目录导航**：顶部切换法典，左侧目录树自动跟随，完整保留作者原结构
- 🔍 **中英实时搜索** + 搜索高亮 + 轻量搜索语法
- 🔗 **URL 深链接**：法典、分类、搜索、词条均可分享
- 🖼️ **沉浸灯箱**：原位展开动画 + 原图查看 + 相邻预加载
- ⚖️ **SD 权重转换**：一键把 NAI 权重转成 SD 格式
- ⭐ **收藏 / 浏览历史**：恢复上次浏览位置、随机探索；可用一个 JSON 文件备份并恢复法典图鉴与共创广场收藏
- 📲 **移动端返回友好**：系统返回键 / 手势逐层关闭浮层与详情、按序回到上一个浏览状态，刷新不丢位置
- 🆕 **本次更新筛选**：法典更新后，结果栏一键只看本批新增词条（含未配图）
- ⌨️ **键盘快捷键**：`/` 搜索、`J/K` 翻卡、`F` 收藏、`?` 查看全部
- 🌙 **深色模式**、📱 响应式、卡片密度可调、骨架屏加载
- 🧩 **零构建静态站**：纯 HTML/CSS/JS ES Modules，可直接部署到 Cloudflare Pages / GitHub Pages
- 🛠️ **配套工具**：docx 一键转换器 + 本地拖拽配图工具 + R2 同步，**全程不用写代码**

## 🚀 本地使用（Windows 双击即用）
> 前置：本机装好 Python 3，并 `pip install -r requirements.txt`

**最省事：双击 `法典图鉴.bat`，一个菜单里选下面所有操作（个别脚本收在 `单项工具\` 里，平时用菜单即可）。**

1. **加法典**：把法典 `.docx` 放进 `法典源/` → 总控台选 `5`（转换法典）
2. **配图**：总控台选 `2`（配图工具）→ 把图拖到对应词条上（自动压缩、命名、写入本地缓存）
3. **预览**：总控台选 `1`（启动预览）→ 打开 http://localhost:8766
4. **同步图片**：复制 `r2_config.example.json` 为 `r2_config.json`，填入 Cloudflare R2 信息 → 总控台选 `3`（同步 R2）
5. **发布**：总控台选 `4`（发布）（先同步 R2，再 git push → Cloudflare 自动部署）

转换器还会生成 `site/data/待复核_*.txt`，列出极少数可能解析有误的词条，供人工复核。

## ☁️ 部署上线
静态站，无需构建：
- **Cloudflare Pages**（推荐，国内更稳）：连接本仓库，Build command 留空，**Build output directory 填 `site`**
- **GitHub Pages**：把 Pages 源指向 `site/` 目录

更新流程：本地配图 / 加法典 → 双击 `发布.bat`（先同步 R2，再 git push）→ 平台自动重新部署，约 1 分钟生效。
词条数据存在本仓库；缩略图和原图发布到 Cloudflare R2，GitHub 仓库不保留图片文件。

## 📁 目录结构
```
法典源/            法典 .docx 源文件（转完自动归档）
tools/
  convert.py       docx -> 网站数据(JSON)
  imgserver.py     本地配图服务
  sync_r2.py       图片同步到 R2
  preview_server.py  本地预览服务
site/              ← 部署的网站本体（无需构建）
  index.html
  strings.html     画风串分享页（社区投稿库）
  assets/          样式与脚本（app.js + ES Modules）
  data/            各法典 JSON + 法典索引
functions/         Cloudflare Pages Functions（投稿 / 反馈 / 喜欢后端）
法典图鉴.bat       ← 总控台（一个菜单整合全部维护脚本，平时双击它即可）
单项工具/          转换法典 / 配图工具 / 启动预览 / 同步R2 / 发布 / 投稿本地测试 / 画师串编辑 / 回归验证 / 互动数据库迁移（拆分脚本，备用）
originals/ 与 site/images/ 是本地图片缓存，会同步到 R2，但不会进入 Git。
```

## 🙏 说明与致谢
- 法典 tag 内容版权归各位**原整理者**所有；本项目只提供更好的浏览/复制体验，忠实呈现其成果。
- 瀑布流界面参考了 [orilights/PixivCollection](https://github.com/orilights/PixivCollection)。
- 代码部分可自由使用、修改。
