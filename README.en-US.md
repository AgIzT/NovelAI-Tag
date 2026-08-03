

# Codex Gallery · NovelAI Prompt Site
![alt text](image.png)

## 📚 Introduction
[Online Access → novelai.quicktagcloud.com](https://novelai.quicktagcloud.com/)

Transforms community-curated NovelAI prompt "codices" into a **image-first, click-to-copy** web site.
Purpose: **Faithfully recreate** these codices, allowing beginners and casual users to browse example images, pick tags, and copy them to NovelAI with one click.

## ✨ Features
- 🖼️ **Image-first masonry layout**
- 🔍 **Real-time CN/EN search** + lightweight search syntax
- ⚖️ **SD weight conversion**
- 🧩 **Zero-build frontend**: Pure HTML/CSS/JS ES Modules, production site deployed on Cloudflare Pages
- ✏️ **Local editing mode**: Add/remove entries, adjust categories, and manage images directly

## 🚀 Local Usage & Editing (Windows)

1. Go to [GitHub Releases](https://github.com/AgIzT/NovelAI-Tag/releases) and download the latest `NovelAI-Tag-Local-YYYYMMDD.zip`
2. Fully extract the ZIP archive.
3. Double-click `法典图鉴本地版.exe`. If the EXE fails to launch directly, use `启动法典图鉴.bat` in the same directory instead.
4. The browser will open automatically. Editing mode is enabled by default on first launch; toggle between edit and view modes using the pencil button in the top bar. In edit mode, click cards to modify entries and images; click the codex name at the top, then navigate to "Codex Management" at the bottom of the menu to create, modify, or delete codices.
5. Close the command-line window for the local edition to stop the service; simply double-click the same EXE next time.

The distribution package includes a sample codex that can be freely modified or deleted. Codex data is stored in `site/data/`, thumbnails in `site/images/`, original images in `originals/`, and automatic pre-save backups in `output/edit-backups/`. The local edition only listens on localhost, so content will not be automatically uploaded; for migration or backup, it is recommended to copy the entire extracted directory directly.

## ☁️ Deployment
No frontend build step required:
- **Cloudflare Pages**: Connect this repository, leave the **Build command** blank, and set **Build output directory** to `site`

The production site deploys application code to Pages, and publishes versioned codex JSON, thumbnails, and original images to Cloudflare R2. `site/data/` serves as the source of truth for local editor maintenance and is ignored by Git; the production domain prioritizes direct R2 connections, falling back to a same-origin Pages Function to read the same R2 release if Pages Preview or direct public access fails.

All maintenance operations are accessed through the `法典图鉴.bat` master console in the root directory (you can also double-click the corresponding batch file directly in `单项工具/`):

- **Menu 4 Publish Data**: Sync images, generate sharing indexes, and atomically switch the R2 data version; does not commit to Git or trigger a Pages deployment.
- **Menu 5 Publish App**: Publishes the same batch of R2 data first, then commits and pushes to Git, triggering an automatic Pages deployment.
- **Menu 6 Rollback Data**: After confirmation, switches back to the previous R2 release; only changes the pointer, without deleting any versions.

The repository no longer distributes codex JSON files. Self-deployment requires providing your own `site/data/`, or configuring an equivalent R2 data publishing layer and `/data` proxy; cloning the repository and publishing directly to GitHub Pages will not include this site's codex content. The local edition distribution package still includes standalone sample data and remains unaffected.

## 📁 Directory Structure
```
法典源/            Codex .docx source files (maintainer local directory; .docx is ignored by Git and not distributed with the repo)
tools/
  convert.py       docx -> website data (JSON)
  imgserver.py     Local image serving service
  sync_r2.py       Sync images to R2
  publish_data_r2.py  Publish versioned JSON to R2
  preview_server.py  Local preview service
site/              ← Deployed website source
  index.html
  strings.html     Art style string sharing page (community submission library)
  assets/          Styles and scripts (app.js + ES Modules)
  data/            Local editing source (ignored by Git; versioned and published to R2)
  data-source.json R2 data entry point for the production domain
functions/         Cloudflare Pages Functions (R2 data proxy / submissions / feedback / likes backend)
法典图鉴.bat       ← Master console (single entry point, menu only, delegates actions to the following)
单项工具/          Editor / Image pairing / Artist string editor / Convert codex / Publish data / Publish app /
                   Rollback data / Package local edition / Preview / Local backend test / Regression validation / Cleanup / DB migration
originals/ and site/images/ are local image caches, synced to R2.
```

## 📄 License
**Code: MIT**. For other scopes, see the "License Scope Description" in [LICENSE](LICENSE).

| Component | License |
|---|---|
| Frontend code / Styles / Local tools | MIT |
| Original entry text & categories | Belong to the respective **original compilers**; this project has no right to re-license |
| Illustrations | Attributed third-party contributors; AI-generated/curated ones © AgIzT |
| Data compilation structure (schema / taxonomy / stable IDs / directory tree / rating system) | Compilation work © AgIzT, no redistribution without permission |

**Feel free to use this project to build your own tag gallery.**

## 🙏 Notes & Acknowledgments
- Copyright for codex tag content belongs to the respective **original curators**; this project merely faithfully presents their work.
- The masonry layout interface is inspired by [orilights/PixivCollection](https://github.com/orilights/PixivCollection).
