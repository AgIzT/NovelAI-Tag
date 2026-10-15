# -*- coding: utf-8 -*-
"""检查真实生成的本地站点边界，不运行 PyInstaller。"""
import json
import re
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

from tools import build_local_edition as builder


class LocalEditionBuildTests(unittest.TestCase):
    def test_generated_package_is_local_and_self_contained(self):
        with tempfile.TemporaryDirectory(prefix="atlas-package-test-") as tmp:
            root = Path(tmp)
            product = root / builder.PRODUCT_NAME
            product.mkdir()
            builder.create_local_site(product)
            builder.write_readme(product)
            site = product / "site"
            html = (site / "index.html").read_text(encoding="utf-8")
            self.assertIn(f"本地版 v{builder.VERSION}</title>", html)
            self.assertIn('<body class="local-edition"', html)
            self.assertIn("备份包含本地法典收藏、收藏夹、归类和备注。", html)
            self.assertNotIn('data-favorites-community-stat', html)
            self.assertNotIn('communityCodexActions', html)
            self.assertNotIn('community-actions.css', html)
            self.assertNotIn('data-open-submit', html)
            self.assertNotIn('data-my-submissions-open', html)
            self.assertIn('id="chipRail"', html)
            self.assertNotIn('两处收藏', html)
            local_css = (site / "assets/local-edition.css").read_text(encoding="utf-8")
            self.assertNotIn('.favorites-backup-stats > :nth-child(2)', local_css)
            self.assertIn(f'data-local-title="{builder.PRODUCT_NAME} v{builder.VERSION}"', html)
            self.assertNotIn('rel="manifest"', html)
            self.assertNotIn('<aside class="favorites-migration-banner"', html)
            self.assertNotIn('favorites-pickup-section', html)
            self.assertNotIn('favoritesPickupCreateBtn', html)
            self.assertIn('.favorites-pickup-section', local_css)
            for url in re.findall(r'<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"', html):
                parts = urlsplit(url)
                self.assertFalse(parts.scheme or parts.netloc, url)
                self.assertTrue((site / parts.path).is_file(), url)
            self.assertEqual(
                {p.name for p in (site / "data").iterdir()},
                {"about.json", "announcements.json", "codexes.json", "demo.json",
                 "media.json", "strings_index.json"},
            )
            index = json.loads((site / "data/codexes.json").read_text(encoding="utf-8"))
            self.assertEqual([book["id"] for book in index], ["demo"])
            media = json.loads((site / "data/media.json").read_text(encoding="utf-8"))
            self.assertEqual(media["baseUrl"], "")
            self.assertTrue(media["localFallback"])
            for directory in (site / "images", product / "originals"):
                self.assertEqual({p.name for p in directory.iterdir()}, {"demo"})
            for path in (site / "assets").rglob("*"):
                if path.parent == site / "assets/app" and path.name in builder.LOCAL_COMMUNITY_MODULES:
                    self.assertEqual(path.read_text(encoding="utf-8"), builder.LOCAL_COMMUNITY_MODULES[path.name])
                    continue
                self.assertFalse(path.name.startswith(("admin", "community")), str(path))
            # 静态 import / re-export 必须全部指向包内真实文件；CSS 隐藏不能修复模块图断链。
            imports = re.compile(
                r'''^\s*(?:import|export)\s+(?:[\w$*{},\s]+?\s+from\s*)?["']([^"']+)["']''',
                re.MULTILINE,
            )
            for path in (site / "assets").rglob("*.js"):
                for target in imports.findall(path.read_text(encoding="utf-8")):
                    parts = urlsplit(target)
                    self.assertFalse(parts.scheme or parts.netloc, f"{path}: {target}")
                    self.assertTrue(target.startswith("."), f"{path}: {target}")
                    resolved = (path.parent / parts.path).resolve()
                    self.assertTrue(resolved.is_relative_to(site.resolve()), f"{path}: {target}")
                    self.assertTrue(resolved.is_file(), f"{path}: {target}")
            # 三个显式离线模块可以独立载入，过滤书目且任何在线读取均拒绝，不能发请求。
            check_offline = """
import assert from 'node:assert/strict';
globalThis.fetch = () => { assert.fail('offline adapters must not request online content'); };
const [codex, actions, refresh] = await Promise.all(process.argv.slice(1).map(url => import(url)));
assert.equal(codex.COMMUNITY_CODEX_ID, 'community');
assert.equal(codex.COMMUNITY_META.id, 'community');
assert.ok(codex.COMMUNITY_REFRESH_MS > 0);
const demo = { id: 'demo' };
assert.deepEqual(codex.withCommunityCodex([demo, { id: 'community' }]), [demo]);
assert.deepEqual(codex.withCommunityCodex(null), []);
assert.equal(codex.communitySource.peek(), null);
await assert.rejects(codex.communitySource.load());
actions.initCommunityActions();
assert.equal(actions.createCommunityLikeButton({ communityId: 'example' }), null);
assert.equal(refresh.replaceCommunityEntries(demo, { entries: [] }), demo);
"""
            checked = subprocess.run(
                ["node", "--input-type=module", "-e", check_offline,
                 *((site / "assets/app" / name).as_uri() for name in builder.LOCAL_COMMUNITY_MODULES)],
                capture_output=True, text=True, encoding="utf-8",
            )
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            for path in site.rglob("*"):
                if path.suffix in {".html", ".js", ".css", ".json"}:
                    self.assertNotRegex(
                        path.read_text(encoding="utf-8"),
                        r"assets\.quicktagcloud\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|r2\.cloudflarestorage\.com|\.r2\.dev",
                        str(path),
                    )
            bat = (product / "启动法典图鉴.bat").read_bytes().decode("gbk")
            self.assertIn('cd /d "%~dp0"', bat)
            self.assertIn('法典图鉴本地版.exe', bat)
            self.assertTrue((product / "LICENSE.txt").is_file())
            self.assertIn("18769", (product / "使用说明.txt").read_text(encoding="utf-8-sig"))
            archive_path = root / "release.zip"
            builder.create_zip(product, archive_path)
            with zipfile.ZipFile(archive_path) as archive:
                self.assertIsNone(archive.testzip())
                for info in archive.infolist():
                    path = Path(info.filename)
                    self.assertFalse(path.is_absolute())
                    self.assertNotIn("..", path.parts)
                    self.assertEqual(path.parts[0], builder.PRODUCT_NAME)
                    self.assertEqual(archive.read(info), (root / path).read_bytes())


if __name__ == "__main__":
    unittest.main()
