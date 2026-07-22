# tools 目录说明

这里放的是维护站点用的本地工具。它们不是前端运行时代码，主要用于转换法典、导入配图、同步 R2、检查 UI 和审计图片参数。

## 常用工具

| 文件 | 用途 | 默认是否改数据 |
| --- | --- | --- |
| `convert.py` | 把 `法典源/*.docx` 转成 `site/data/*.json`。支持 `--archive-sources` 在转换成功后归档源文件。 | 会改 JSON；带 `--archive-sources` 会移动源文件 |
| `codex_update_match.py` | 新旧法典增量匹配预演：回放旧 Word、区分新增/修改/减少/歧义，并验证稳定 ID/配图不会错位。 | 只读正式数据；报告写入 `output/` |
| `suozhang_r18_merge_match.py` | 所长色色上下册专用流程：先按历史规则逻辑合并，再对合并结果做全局增量匹配；门禁通过后可 `--apply`。 | 默认只读；带 `--apply` 才写正式数据与索引 |
| `import_excel_images.py` | 从 Excel 内嵌图片导入词条配图，生成缩略图和原图引用。 | 默认只预览；带 `--apply` 才写入 |
| `import_docx_codex.py` | 导入结构较特殊、带内嵌图片的 Word 法典。 | 默认只出报告；带 `--apply` 才写入 |
| `sync_r2.py` | 同步 `site/images/` 和 `originals/` 到 Cloudflare R2，并维护媒体配置。 | 默认会上传；`--dry-run` 只检查 |
| `preview_server.py` | 本地预览 `site/`，同时提供 `originals/` 原图缓存。 | 只读 |
| `verify_ui.py` | 启动浏览器做 UI 冒烟/回归检查。 | 只读，会写测试输出 |
| `sd_metadata_inspector.py` | 读取图片生成参数，并用原图参数审计法典 tag 覆盖率。 | 只读；审计会写 CSV 报告 |

## 辅助工具

| 文件 | 用途 | 默认是否改数据 |
| --- | --- | --- |
| `imgserver.py` + `pei.html` | `配图工具.bat` 背后的本地配图编辑器，默认端口 `8767`。 | 通过页面操作才会写入 |
| `strings_server.py` + `strings_editor.html` | 画师串/字符串编辑器，默认端口 `8768`。 | 通过页面操作才会写入 |
| `import_mengshen_pack.py` | 梦神整理图包的历史来源适配器。 | 默认只预览；当前章节迁移态禁止重放 `--apply` |
| `import_community_ai_misc.py` | 导入并验证社区 AI 杂图。 | 默认审计；`--apply` 首次写入；`--validate` 验证现状 |
| `backfill_pack_character_prompts.py` | 从当前两本图包引用的原图幂等回填 NAI V4 角色提示词。 | 默认预演；确认无缺失 / 解析错误后带 `--apply` |
| `__pycache__/` | Python 自动生成缓存。 | 可忽略 |

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

历史合并规则固定为：完整保留上册；仅移除下册与上册重复的「编纂者常用画师组」；保留下册「编纂者oc二则」。工具会先验证下册画师组确实是上册画师组的精确子集，并把两种 OC 标题下没有独立中文标题的本体/服装块拆成独立卡片。最终门禁以合并后的全局报告为准；分册报告只作诊断。默认命令不会改写正式数据；确认报告后给同一命令追加 `--apply`，才会写入 `site/data/suozhang_r18.json` 并只刷新 `codexes.json` 中该书的版本和计数。

## sd_metadata_inspector.py

这个工具用于检查图片原始参数，尤其是“法典词条 tag 是否能在原图 prompt 中找到”。

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

`stealth_pngcomp` 是 Akegarasu/stable-diffusion-inspector 也支持的一类隐藏参数。它不在普通 PNG 文本块里，所以普通元数据读取会显示“没参数”，但 NovelAI 或 inspector 仍可能读得到。

## 安全建议

- 不确定时先跑 `--dry-run` 或不带 `--apply`。
- 跑 `sync_r2.py` 前确认 `r2_config.json` 存在且配置正确。
- 跑会写数据的工具前先看 `git status --short`，避免把自己的手工修改混进工具输出。
- 图片文件通常不进 git；上传到线上需要走 R2 同步流程。
