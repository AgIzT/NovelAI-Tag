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


class FourCandidateReviewStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.batch = Path(self.temporary.name)
        templates = [
            {"imageSha256": f"template-{index}"}
            for index in range(1, 5)
        ]
        write_json(
            self.batch / "plan.json",
            {
                "createdAt": "2026-08-16T00:00:00+08:00",
                "codexSha256": "codex-four",
                "templates": templates,
                "nSamples": 4,
                "entryCount": 1,
                "candidateImageCount": 4,
                "entries": [
                    {
                        "id": "entry-four",
                        "title": "four styles",
                        "path": ["test"],
                        "tags": "1girl, outdoors",
                    }
                ],
            },
        )
        entry_dir = self.batch / "entries" / "entry-four"
        entry_dir.mkdir(parents=True)
        images = []
        for index in range(1, 5):
            filename = f"entry-four-{index:02d}.png"
            (entry_dir / filename).write_bytes(f"candidate-{index}".encode())
            images.append(
                {
                    "styleIndex": index,
                    "styleName": f"style-{index}",
                    "file": filename,
                    "issues": [],
                }
            )
        write_json(
            self.batch / "manifest.json",
            {
                "entryCount": 1,
                "results": {
                    "entry-four": {
                        "id": "entry-four",
                        "status": "verified",
                        "images": images,
                    }
                },
            },
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_four_candidates_are_reviewable_and_resumable(self) -> None:
        state = ReviewState(self.batch)
        snapshot = state.snapshot()
        self.assertEqual(snapshot["batch"]["nSamples"], 4)
        self.assertEqual(snapshot["counts"]["generatedImages"], 4)
        self.assertEqual(snapshot["counts"]["choiceCounts"], [1, 0, 0, 0])
        self.assertEqual(
            [image["styleName"] for image in snapshot["entries"][0]["images"]],
            ["style-1", "style-2", "style-3", "style-4"],
        )

        state.select("entry-four", 4)
        resumed = ReviewState(self.batch).snapshot()
        self.assertEqual(resumed["counts"]["choiceCounts"], [0, 0, 0, 1])
        self.assertTrue(resumed["entries"][0]["selection"]["reviewed"])

    def test_choice_above_candidate_count_is_rejected(self) -> None:
        state = ReviewState(self.batch)
        with self.assertRaisesRegex(ValueError, "between 1 and 4"):
            state.select("entry-four", 5)

    def test_reject_all_is_resumable_and_a_later_choice_clears_it(self) -> None:
        state = ReviewState(self.batch)
        rejected = state.reject_all("entry-four")
        self.assertTrue(rejected["rerun"])
        snapshot = ReviewState(self.batch).snapshot()
        self.assertEqual(snapshot["counts"]["rerun"], 1)
        self.assertTrue(snapshot["entries"][0]["selection"]["rerun"])
        self.assertTrue(snapshot["entries"][0]["selection"]["reviewed"])

        selected = ReviewState(self.batch).select("entry-four", 3)
        self.assertFalse(selected["rerun"])
        resumed = ReviewState(self.batch).snapshot()
        self.assertEqual(resumed["counts"]["rerun"], 0)
        self.assertEqual(resumed["entries"][0]["selection"]["choice"], 3)

    def test_style_extension_preserves_old_four_candidate_entry(self) -> None:
        ReviewState(self.batch)
        plan = json.loads((self.batch / "plan.json").read_text(encoding="utf-8"))
        plan["templates"].extend(
            [
                {"imageSha256": "template-5"},
                {"imageSha256": "template-6"},
            ]
        )
        plan["nSamples"] = 6
        plan["entries"][0]["candidateCount"] = 4
        write_json(self.batch / "plan.json", plan)

        resumed_state = ReviewState(self.batch)
        snapshot = resumed_state.snapshot()
        self.assertEqual(snapshot["batch"]["nSamples"], 6)
        self.assertEqual(snapshot["batch"]["minimumCandidates"], 4)
        self.assertEqual(snapshot["entries"][0]["candidateCount"], 4)
        with self.assertRaisesRegex(ValueError, "between 1 and 4"):
            resumed_state.select("entry-four", 5)


def load_selection(batch: Path, entry_id: str) -> dict:
    document = json.loads((batch / "selections.json").read_text(encoding="utf-8"))
    return document["selections"][entry_id]


if __name__ == "__main__":
    unittest.main()
