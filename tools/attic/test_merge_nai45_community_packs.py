from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import merge_nai45_community_packs as merge  # noqa: E402


def mengshen_book() -> dict:
    return {
        "id": "mengshen_pack",
        "type": "pack",
        "title": "梦神整理社区图包",
        "version": "2026.6.27",
        "author": "梦神整理",
        "source": "梦神整理 · 社区收集原图包",
        "hasOriginal": True,
        "contributors": [
            {"name": "梦神", "role": "图包整理 / 数据来源"},
            {"name": "社区贡献者", "role": "原图与参数收集"},
        ],
        "tree": [{"name": "韩国大舞台", "count": 2, "children": [
            {"name": "常规", "count": 1, "children": []},
            {"name": "R18G", "count": 1, "children": []},
        ]}],
        "entries": [
            {"id": "mengshen_pack-0259", "title": "m1", "path": ["韩国大舞台", "常规"],
             "image": "mengshen_pack-0259.jpg", "rating": "safe"},
            {"id": "mengshen_pack-0260", "title": "m2", "path": ["韩国大舞台", "R18G"],
             "image": "mengshen_pack-0260.jpg", "rating": "r18g"},
        ],
    }


def misc_book() -> dict:
    return {
        "id": "community_ai_misc",
        "type": "pack",
        "title": "社区AI杂图",
        "version": "2026.7.20",
        "author": "社区贡献者",
        "source": "社区贡献者 · AI杂图（带元数据）-N4.5最终版",
        "hasOriginal": True,
        "contributors": [{"name": "社区贡献者", "role": "原图与参数收集 / 人工分类"}],
        "tree": [
            {"name": "常规", "count": 1, "children": []},
            {"name": "NSFW-限制级别", "count": 1, "children": [{"name": "r18", "count": 1, "children": []}]},
        ],
        "entries": [
            {"id": "community_ai_misc-0001", "title": "c1", "path": ["常规"],
             "image": "community_ai_misc-0001.jpg", "rating": "safe"},
            {"id": "community_ai_misc-0002", "title": "c2", "path": ["NSFW-限制级别", "r18"],
             "image": "community_ai_misc-0002.jpg", "rating": "r18"},
        ],
    }


def index_rows() -> list[dict]:
    return [
        {"id": "suozhang", "title": "所长常规"},
        {"id": "mengshen_pack", "type": "pack", "title": "梦神整理社区图包", "version": "2026.6.27",
         "entryCount": 2, "imagedCount": 2, "links": [],
         "cover": "mengshen_pack-0259.jpg", "coverRev": "abc"},
        {"id": "community_ai_misc", "type": "pack", "title": "社区AI杂图", "version": "2026.7.20",
         "entryCount": 2, "imagedCount": 2, "cover": "community_ai_misc-0001.jpg", "coverRev": "def"},
        {"id": "enter_codex", "title": "站长的小仓库"},
    ]


COVERS = {"cover": "mengshen_pack-0259.jpg", "coverRev": "abc", "coverCodexId": "mengshen_pack"}


class MergePacksTests(unittest.TestCase):
    def setUp(self) -> None:
        self.merged = merge.merge_packs([mengshen_book(), misc_book()])

    def test_entries_are_pushed_under_two_source_tops(self) -> None:
        self.assertEqual([e["path"] for e in self.merged["entries"]], [
            ["梦神 · 社区图包", "韩国大舞台", "常规"],
            ["梦神 · 社区图包", "韩国大舞台", "R18G"],
            ["社区 · AI杂图", "常规"],
            ["社区 · AI杂图", "NSFW-限制级别", "r18"],
        ])

    def test_entry_ids_are_untouched(self) -> None:
        self.assertEqual([e["id"] for e in self.merged["entries"]], [
            "mengshen_pack-0259", "mengshen_pack-0260",
            "community_ai_misc-0001", "community_ai_misc-0002",
        ])

    def test_every_entry_gets_routed_back_to_its_own_image_folder(self) -> None:
        by_id = {e["id"]: e for e in self.merged["entries"]}
        self.assertEqual(by_id["mengshen_pack-0259"]["assetCodexId"], "mengshen_pack")
        self.assertEqual(by_id["community_ai_misc-0002"]["assetCodexId"], "community_ai_misc")

    def test_entry_level_ratings_survive(self) -> None:
        self.assertEqual([e.get("rating") for e in self.merged["entries"]], ["safe", "r18g", "safe", "r18"])
        self.assertNotIn("nsfw", self.merged)

    def test_meta_merge(self) -> None:
        self.assertEqual(self.merged["id"], "nai45_community_pack")
        self.assertEqual(self.merged["title"], "NovelAI v4.5社区精选图包")
        self.assertEqual(self.merged["version"], "2026.7.20")
        self.assertEqual(self.merged["type"], "pack")
        self.assertEqual(self.merged["aliases"], ["mengshen_pack", "community_ai_misc"])
        self.assertEqual(self.merged["author"], "梦神整理 / 社区贡献者")
        self.assertEqual(self.merged["entryCount"], 4)
        self.assertEqual(self.merged["imagedCount"], 4)

    def test_same_contributor_is_listed_once_with_the_fuller_role(self) -> None:
        self.assertEqual(self.merged["contributors"], [
            {"name": "梦神", "role": "图包整理 / 数据来源"},
            {"name": "社区贡献者", "role": "原图与参数收集 / 人工分类"},
        ])

    def test_tree_keeps_each_source_second_level(self) -> None:
        names = [(n["name"], n["count"], [c["name"] for c in n["children"]]) for n in self.merged["tree"]]
        self.assertEqual(names, [
            ("梦神 · 社区图包", 2, ["韩国大舞台"]),
            ("社区 · AI杂图", 2, ["常规", "NSFW-限制级别"]),
        ])

    def test_source_books_are_not_mutated(self) -> None:
        book = mengshen_book()
        merge.merge_packs([book, misc_book()])
        self.assertEqual(book["entries"][0]["path"], ["韩国大舞台", "常规"])


class MergeIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.merged = merge.merge_packs([mengshen_book(), misc_book()])
        self.index = merge.merge_index(index_rows(), self.merged, COVERS)

    def test_merged_row_takes_the_first_sources_slot(self) -> None:
        self.assertEqual([c["id"] for c in self.index],
                         ["suozhang", "nai45_community_pack", "enter_codex"])

    def test_cover_is_routed_to_its_source_folder(self) -> None:
        row = self.index[1]
        self.assertEqual(row["cover"], "mengshen_pack-0259.jpg")
        self.assertEqual(row["coverCodexId"], "mengshen_pack")
        self.assertEqual(row["links"], [])  # 原行上的其它字段不丢

    def test_validate_passes_when_images_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for source_id, _ in merge.SOURCES:
                (root / source_id).mkdir(parents=True)
            for entry in self.merged["entries"]:
                (root / entry["assetCodexId"] / entry["image"]).write_bytes(b"x")
            original = merge.IMAGE_ROOT
            merge.IMAGE_ROOT = root
            try:
                self.assertEqual(merge.validate(self.merged, self.index), [])
            finally:
                merge.IMAGE_ROOT = original

    def test_validate_catches_a_missing_image_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for source_id, _ in merge.SOURCES:
                (root / source_id).mkdir(parents=True)
            original = merge.IMAGE_ROOT
            merge.IMAGE_ROOT = root
            try:
                problems = merge.validate(self.merged, self.index)
            finally:
                merge.IMAGE_ROOT = original
        self.assertTrue(any("主图找不到文件" in p for p in problems))

    def test_validate_catches_a_leftover_source_row(self) -> None:
        polluted = [*self.index, {"id": "community_ai_misc"}]
        problems = merge.validate(self.merged, polluted)
        self.assertTrue(any("仍留着来源行" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
