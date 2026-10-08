"""build_artist_index.py 的画师名归一：与前端 artist-core.js 共用夹具防漂移。"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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

    def test_directory_order_follows_tree_not_entry_array(self):
        tree = [
            {"name": "单画师词典", "children": [{"name": "雨燕", "children": []}, {"name": "wwuumm", "children": []}]},
            {"name": "画风组词典", "children": [{"name": "梦神", "children": []}]},
        ]
        order = bai.directory_order(tree)
        self.assertLess(order[("单画师词典", "雨燕")], order[("单画师词典", "wwuumm")])
        self.assertLess(order[("单画师词典", "wwuumm")], order[("画风组词典", "梦神")])

    def test_prompt_artist_weights_matches_frontend(self):
        got = bai.prompt_artist_weights(
            "artist:a, 0.4::artist:b, artist:c::, [[artist:d]], {artist:e, smile}, artist:a, year 2024")
        self.assertEqual([(name, bai.round_weight(w)) for name, w in got],
                         [("a", 1), ("b", 0.4), ("c", 0.4), ("d", 0.91), ("e", 1.05)])
        self.assertEqual(bai.round_weight(0.175), 0.18, "进位要和 JS 的 Math.round 一致")

    def test_build_strings_dedupes_sets_and_skips_restricted_reps(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            entries = [
                {"id": "p1", "path": ["R18"], "rating": "r18", "image": "p1.jpg", "tags": "artist:a, artist:b"},
                {"id": "p2", "path": ["常规"], "image": "p2.jpg", "assetRev": "rv", "tags": "0.5::artist:b::, artist:a"},
                {"id": "p3", "path": ["常规"], "image": "p3.png", "tags": "artist:b, artist:a, smile"},
                {"id": "p4", "path": ["常规"], "tags": "artist:c, artist:d"},
                {"id": "p5", "path": ["常规"], "image": "p5.jpg", "tags": "artist:solo"},
            ]
            tree = [{"name": "常规", "count": 4, "children": []}, {"name": "R18", "count": 1, "children": []}]
            (data / "pack5.json").write_text(json.dumps({"entries": entries, "tree": tree}), encoding="utf-8")
            codexes = [{"id": "pack5", "title": "NovelAI v5社区精选图包"}, {"id": "misc", "title": "渡鸦的构图鉴"}]
            with mock.patch.object(bai, "DATA", data):
                out = bai.build_strings(codexes)
        self.assertEqual(out["n45"], {"books": [], "artists": [], "strings": []})
        n5 = out["n5"]
        self.assertEqual(n5["books"], ["pack5"])
        self.assertEqual(n5["artists"], ["b", "a", "c", "d"], "顺序取目录栏里第一条用到它的词条（常规在 R18 前）")
        self.assertEqual(n5["strings"], [
            [[[0, 0.5], 1], 0, "p2", "", "rv", "", 2],
            [[2, 3]],
        ], "同一组画师只记一次；没有常规级配图的只剩成员")

    def test_codex_model_from_title(self):
        self.assertEqual(bai.codex_model({"title": "NovelAI v4.5社区精选图包"}), "n45")
        self.assertEqual(bai.codex_model({"title": "所长N5常规NovelAI个人法典"}), "n5")
        self.assertEqual(bai.codex_model({"title": "NovelAI v5画师词典"}), "n5")
        self.assertEqual(bai.codex_model({"title": "渡鸦的构图鉴"}), "")


if __name__ == "__main__":
    unittest.main()
