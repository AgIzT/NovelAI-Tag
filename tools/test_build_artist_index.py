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

    def test_prompt_artist_weights_separates_adjacent_groups(self):
        cases = [
            ("{{artist:pottsness}}, [[artist:onineko]][[artist:as109]], year 2024",
             [("pottsness", 1.05 ** 2), ("onineko", 1.05 ** -2), ("as109", 1.05 ** -2)]),
            ("{{artist:a}}{{artist:b}}", [("a", 1.05 ** 2), ("b", 1.05 ** 2)]),
            ("[[artist:a]] {{artist:b}}", [("a", 1.05 ** -2), ("b", 1.05 ** 2)]),
            ("{[[artist:a]][artist:b]}", [("a", 1.05 ** -1), ("b", 1)]),
            ("0.4::{artist:a, [[artist:b]][artist:c]}::, artist:d",
             [("a", 0.4 * 1.05), ("b", 0.4 * 1.05 ** -1), ("c", 0.4), ("d", 1)]),
            ("{{smile}}[[artist:a]]{blush}{artist:b}[[blue sky]]",
             [("a", 1.05 ** -2), ("b", 1.05)]),
            ("artist:senji_(tegone_spike){artist:tomose_shunsaku}",
             [("senji (tegone spike)", 1), ("tomose shunsaku", 1.05)]),
            ("[[artist:a]]{{artist:a}}{artist:b}", [("a", 1.05 ** -2), ("b", 1.05)]),
            ("artist:[[a]]{artist:b}", [("[[a", 1.05 ** -2), ("b", 1.05)]),
            ("artist: [ [a]]{{artist:b}}", [("[ [a", 1.05 ** -2), ("b", 1.05 ** 2)]),
            ("artist:{{a}}[[artist:b]]", [("{{a", 1.05 ** 2), ("b", 1.05 ** -2)]),
            ("0.4::{year} 2025::,artist:a", [("a", 1)]),
            ("0.4::{year} 2025::,[[artist:a]][[artist:b]]",
             [("a", 1.05 ** -2), ("b", 1.05 ** -2)]),
            ("0.4::year {2025::},artist:a", [("a", 1)]),
            ("0.4::year [2025::][[artist:a]][[artist:b]]",
             [("a", 1.05 ** -2), ("b", 1.05 ** -2)]),
            ("{{0.5::artist:a::}}{{2::artist:b::}},artist:c",
             [("a", 0.5 * 1.05 ** 2), ("b", 2 * 1.05 ** 2), ("c", 1)]),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(bai.prompt_artist_weights(text), expected)
                self.assertEqual(bai.prompt_artists(text), [name for name, _ in expected])

    def test_build_samples_excludes_adjacent_multi_artist_groups(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            entries = [
                {"id": "group", "image": "group.jpg", "tags": "[[artist:onineko]][[artist:as109]]"},
                {"id": "outside", "image": "outside.jpg",
                 "tags": "artist:ciloranko, artist:[sho (sho lwlw)], artist:[aya shobon]"},
                {"id": "solo", "image": "solo.jpg", "tags": "{artist:solo}"},
            ]
            (data / "artists.json").write_text(json.dumps({"entries": entries}), encoding="utf-8")
            with mock.patch.object(bai, "DATA", data):
                out = bai.build_samples("artists")
        self.assertEqual(out["samples"], {"solo": ["solo", "", "", 0]})

    def test_report_resolves_adjacent_groups_to_individual_samples(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            entries = [{"tags": "[[artist:onineko]][[artist:as109]], {artist:missing}"}]
            (data / "example.json").write_text(json.dumps({"entries": entries}), encoding="utf-8")
            versions = {
                "n45": {"book": "artists45", "samples": {"onineko": []}},
                "n5": {"book": "artists5", "samples": {"as109": []}},
            }
            with mock.patch.object(bai, "DATA", data), mock.patch.object(bai, "REPORT_DIR", data / "report"):
                bai.write_report([{"id": "example", "title": "NovelAI v5 example"}], versions, 0)
            report = (data / "report" / "构建报告.md").read_text(encoding="utf-8")
        self.assertIn("| example | n5 | 1 | 3 | 2 | 67% |", report)
        self.assertIn("| `artist:missing` | 1 | example 1 |", report)
        self.assertNotIn("artist:onineko", report)
        self.assertNotIn("artist:as109", report)

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
