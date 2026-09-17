# -*- coding: utf-8 -*-

"""起名套用：编号进 serialTitle、名字进 title、可撤销、对不上就整批拒绝。"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import apply_pack_names as apn  # noqa: E402


def book(book_id, entries):
    return {"id": book_id, "entries": entries}


class ApplyPackNames(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data = root / "data"
        self.data.mkdir()
        self.output = root / "output"
        self.originals = (apn.DATA_DIR, apn.OUTPUT_DIR)
        apn.DATA_DIR, apn.OUTPUT_DIR = self.data, self.output
        self.write_book("nai5_community_pack", [
            {"id": "a", "title": "韩网整理 001"},
            {"id": "b", "title": "整理套图 002"},
        ], compact=False)
        self.write_book("nai45_community_pack", [
            {"id": "c", "title": "R18 0001"},
            {"id": "d", "title": "常规 0002"},
        ], compact=True)

    def tearDown(self):
        apn.DATA_DIR, apn.OUTPUT_DIR = self.originals
        self.tmp.cleanup()

    def write_book(self, book_id, entries, compact):
        text = apn.dump_book(book(book_id, entries), compact)
        (self.data / f"{book_id}.json").write_text(text, encoding="utf-8")

    def read_entries(self, book_id):
        data = json.loads((self.data / f"{book_id}.json").read_text(encoding="utf-8"))
        return {entry["id"]: entry for entry in data["entries"]}

    def names(self, rows):
        path = Path(self.tmp.name) / "names.json"
        path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        return path

    def test_plan_does_not_write(self):
        before = (self.data / "nai5_community_pack.json").read_text(encoding="utf-8")
        report = apn.run(self.names([
            {"book": "nai5_community_pack", "id": "a", "oldTitle": "韩网整理 001", "newTitle": "银发御姐·海边"},
        ]), apply=False)
        self.assertFalse(report["written"])
        self.assertEqual(report["books"]["nai5_community_pack"]["titleChanges"], 1)
        self.assertEqual((self.data / "nai5_community_pack.json").read_text(encoding="utf-8"), before)

    def test_apply_moves_serial_and_sets_names_idempotently(self):
        rows = [
            {"book": "nai5_community_pack", "id": "a", "oldTitle": "韩网整理 001", "newTitle": "银发御姐·海边"},
            {"book": "nai45_community_pack", "id": "c", "oldTitle": "R18 0001", "newTitle": "修女·触手拘束"},
            {"book": "nai45_community_pack", "id": "d", "oldTitle": "常规 0002", "newTitle": ""},
        ]
        report = apn.run(self.names(rows), apply=True)
        self.assertTrue(report["written"])
        n5 = self.read_entries("nai5_community_pack")
        self.assertEqual(n5["a"], {"id": "a", "title": "银发御姐·海边", "serialTitle": "韩网整理 001"})
        self.assertEqual(n5["b"], {"id": "b", "title": "整理套图 002", "serialTitle": "整理套图 002"})
        n45 = self.read_entries("nai45_community_pack")
        self.assertEqual(n45["c"]["title"], "修女·触手拘束")
        self.assertEqual(n45["d"]["title"], "常规 0002")
        # 两本书各自保持原来的排版
        self.assertTrue((self.data / "nai45_community_pack.json").read_text(encoding="utf-8").startswith('{"'))
        self.assertTrue((self.data / "nai5_community_pack.json").read_text(encoding="utf-8").startswith("{\n"))
        again = apn.run(self.names(rows), apply=False)
        for item in again["books"].values():
            self.assertEqual((item["titleChanges"], item["serialBackfill"], item["blockers"]), (0, 0, []))

    def test_empty_name_reverts_to_serial(self):
        apn.run(self.names([
            {"book": "nai5_community_pack", "id": "a", "oldTitle": "韩网整理 001", "newTitle": "银发御姐·海边"},
        ]), apply=True)
        apn.run(self.names([
            {"book": "nai5_community_pack", "id": "a", "oldTitle": "韩网整理 001", "newTitle": ""},
        ]), apply=True)
        self.assertEqual(self.read_entries("nai5_community_pack")["a"]["title"], "韩网整理 001")

    def test_mismatched_serial_blocks_whole_batch(self):
        before = (self.data / "nai45_community_pack.json").read_text(encoding="utf-8")
        report = apn.run(self.names([
            {"book": "nai45_community_pack", "id": "c", "oldTitle": "R18 0001", "newTitle": "修女·触手拘束"},
            {"book": "nai45_community_pack", "id": "d", "oldTitle": "常规 0099", "newTitle": "街头·夕阳"},
        ]), apply=True)
        self.assertTrue(report["blocked"])
        self.assertFalse(report["written"])
        self.assertEqual((self.data / "nai45_community_pack.json").read_text(encoding="utf-8"), before)

    def test_missing_entry_and_unknown_serial_block(self):
        self.write_book("nai45_community_pack", [{"id": "c", "title": "已经是名字·无编号"}], compact=True)
        report = apn.run(self.names([
            {"book": "nai45_community_pack", "id": "zzz", "oldTitle": "R18 0003", "newTitle": "某名·某画面"},
        ]), apply=False)
        blockers = report["books"]["nai45_community_pack"]["blockers"]
        self.assertIn("missing entry: zzz", blockers)
        self.assertIn("cannot infer serial title: c", blockers)


if __name__ == "__main__":
    unittest.main()
