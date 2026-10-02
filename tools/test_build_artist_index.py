"""build_artist_index.py 的画师名归一：与前端 artist-core.js 共用夹具防漂移。"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_artist_index as bai  # noqa: E402


FIXTURE = Path(__file__).resolve().parent / "fixtures" / "artist_keys.json"


class ArtistKeyTest(unittest.TestCase):
    def test_fixture_matches_frontend_contract(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(bai.artist_key(raw), expected)

    def test_prompt_artists_dedupes_in_order(self):
        self.assertEqual(
            bai.prompt_artists("artist:b, 0.4::artist:a::, [[artist:b]], year 2024"),
            ["b", "a"],
        )

    def test_codex_model_from_title(self):
        self.assertEqual(bai.codex_model({"title": "NovelAI v4.5社区精选图包"}), "n45")
        self.assertEqual(bai.codex_model({"title": "所长N5常规NovelAI个人法典"}), "n5")
        self.assertEqual(bai.codex_model({"title": "NovelAI v5画师词典"}), "n5")
        self.assertEqual(bai.codex_model({"title": "渡鸦的构图鉴"}), "")


if __name__ == "__main__":
    unittest.main()
