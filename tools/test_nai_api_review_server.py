import json
import tempfile
import unittest
from pathlib import Path

from tools.nai_api_review_server import ReviewState


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


class ReviewStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.batch = Path(self.temporary.name)
        self.plan = {
            "createdAt": "2026-07-20T00:00:00+08:00",
            "templateSha256": "template",
            "codexSha256": "codex",
            "templateSource": "NovelAI Diffusion V4.5",
            "nSamples": 2,
            "entryCount": 2,
            "candidateImageCount": 4,
            "entries": [
                {
                    "id": "entry-1",
                    "title": "词条一",
                    "path": ["场景"],
                    "tags": "1girl, outdoors",
                },
                {
                    "id": "entry-2",
                    "title": "词条二",
                    "path": ["服装"],
                    "tags": "1girl, dress",
                },
            ],
        }
        write_json(self.batch / "plan.json", self.plan)
        entry_dir = self.batch / "entries" / "entry-1"
        entry_dir.mkdir(parents=True)
        (entry_dir / "entry-1-01.png").write_bytes(b"candidate-one")
        (entry_dir / "entry-1-02.png").write_bytes(b"candidate-two")
        write_json(
            self.batch / "manifest.json",
            {
                "entryCount": 2,
                "results": {
                    "entry-1": {
                        "id": "entry-1",
                        "status": "verified",
                        "seed": 123,
                        "attempts": [{"status": "success"}],
                        "images": [
                            {"file": "entry-1-01.png", "issues": []},
                            {"file": "entry-1-02.png", "issues": []},
                        ],
                    }
                },
            },
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_defaults_snapshot_and_persisted_choice(self) -> None:
        state = ReviewState(self.batch)
        snapshot = state.snapshot()
        self.assertEqual(snapshot["counts"]["total"], 2)
        self.assertEqual(snapshot["counts"]["generatedEntries"], 1)
        self.assertEqual(snapshot["counts"]["generatedImages"], 2)
        self.assertEqual(snapshot["counts"]["reviewed"], 0)
        self.assertEqual(snapshot["counts"]["choiceOne"], 2)

        saved = state.select("entry-1", 2)
        self.assertTrue(saved["reviewed"])
        snapshot = state.snapshot()
        self.assertEqual(snapshot["counts"]["reviewed"], 1)
        self.assertEqual(snapshot["counts"]["choiceTwo"], 1)
        selection = load_selection(self.batch, "entry-1")
        self.assertEqual(selection["choice"], 2)
        self.assertTrue(selection["reviewed"])

        resumed = ReviewState(self.batch).snapshot()
        self.assertEqual(resumed["counts"]["reviewed"], 1)
        self.assertEqual(resumed["counts"]["choiceTwo"], 1)

    def test_pending_entry_cannot_be_selected(self) -> None:
        state = ReviewState(self.batch)
        with self.assertRaisesRegex(ValueError, "no reviewable"):
            state.select("entry-2", 1)

    def test_only_registered_image_paths_are_served(self) -> None:
        state = ReviewState(self.batch)
        path = state.image_path("entry-1", "entry-1-01.png")
        self.assertEqual(path.read_bytes(), b"candidate-one")
        with self.assertRaisesRegex(ValueError, "invalid image filename"):
            state.image_path("entry-1", "../plan.json")
        with self.assertRaisesRegex(ValueError, "not registered"):
            state.image_path("entry-1", "unlisted.png")


def load_selection(batch: Path, entry_id: str) -> dict:
    document = json.loads((batch / "selections.json").read_text(encoding="utf-8"))
    return document["selections"][entry_id]


if __name__ == "__main__":
    unittest.main()
