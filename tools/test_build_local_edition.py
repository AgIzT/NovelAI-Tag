# -*- coding: utf-8 -*-
"""检查真实生成的本地站点边界，不运行 PyInstaller。"""
import json
import re
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
            self.assertIn(f'data-local-title="{builder.PRODUCT_NAME} v{builder.VERSION}"', html)
            self.assertNotIn('rel="manifest"', html)
            self.assertNotIn('<aside class="favorites-migration-banner"', html)
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
                self.assertFalse(path.name.startswith(("admin", "community")), str(path))
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
