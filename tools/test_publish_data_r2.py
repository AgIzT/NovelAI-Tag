import json
import tempfile
import unittest
from pathlib import Path

from tools.publish_data_r2 import (
    POINTER_CACHE_CONTROL,
    activate_release,
    build_release_plan,
    check_current_release,
    publish_release,
    sha256_bytes,
)


class FakeClient:
    def __init__(self):
        self.objects = {}
        self.operations = []
        self.fail_key = ""

    def head_metadata(self, key):
        item = self.objects.get(key)
        if not item:
            return None
        return {"size": len(item["body"]), "sha256": item["sha256"]}

    def put_file(self, key, item, cache_control):
        if key == self.fail_key:
            raise RuntimeError("injected upload failure")
        body = item.path.read_bytes()
        self.objects[key] = {"body": body, "sha256": item.sha256, "cache": cache_control}
        self.operations.append(("put", key))

    def put_bytes(self, key, body, cache_control):
        if key == self.fail_key:
            raise RuntimeError("injected upload failure")
        self.objects[key] = {"body": body, "sha256": sha256_bytes(body), "cache": cache_control}
        self.operations.append(("put", key))

    def get_json(self, key):
        item = self.objects.get(key)
        return json.loads(item["body"].decode("utf-8")) if item else None


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def make_data(root):
    write_json(root / "codexes.json", [{"id": "demo"}])
    write_json(root / "demo.json", {"id": "demo", "entries": []})
    write_json(root / "about.json", {})
    write_json(root / "announcements.json", [])
    write_json(root / "media.json", {})
    write_json(root / "strings_index.json", {})
    write_json(root / "strings.json", {})
    write_json(root / "share-index.json", {"codexes": {}})
    write_json(root / "share" / "demo.json", {"id": "demo"})


class PublishDataR2Tests(unittest.TestCase):
    def test_release_is_deterministic_and_covers_share_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            write_json(root / "nested" / "extra.json", {"included": True})
            first = build_release_plan(root)
            second = build_release_plan(root)
            self.assertEqual(first.release, second.release)
            self.assertIn("share/demo.json", first.manifest["files"])
            self.assertIn("nested/extra.json", first.manifest["files"])
            self.assertEqual(first.release, first.manifest["release"])

    def test_invalid_codex_reference_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            (root / "demo.json").unlink()
            with self.assertRaisesRegex(ValueError, "codex data file is missing"):
                build_release_plan(root)

    def test_pointer_is_written_last_and_tracks_previous_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            plan = build_release_plan(root)
            client = FakeClient()
            client.objects["data/current.json"] = {
                "body": json.dumps({"release": "r-11111111111111111111"}).encode(),
                "sha256": "",
                "cache": POINTER_CACHE_CONTROL,
            }
            result = publish_release(client, plan)
            self.assertEqual(client.operations[-1], ("put", "data/current.json"))
            self.assertEqual(result["pointer"]["release"], plan.release)
            self.assertEqual(result["pointer"]["previousRelease"], "r-11111111111111111111")
            self.assertEqual(client.objects["data/current.json"]["cache"], POINTER_CACHE_CONTROL)

    def test_failed_release_does_not_update_pointer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            plan = build_release_plan(root)
            client = FakeClient()
            client.fail_key = f"data/releases/{plan.release}/demo.json"
            with self.assertRaisesRegex(RuntimeError, "injected"):
                publish_release(client, plan)
            self.assertNotIn("data/current.json", client.objects)

    def test_check_and_activate_existing_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            plan = build_release_plan(root)
            client = FakeClient()
            publish_release(client, plan)
            pointer, manifest = check_current_release(client)
            self.assertEqual(pointer["release"], plan.release)
            self.assertEqual(manifest["contentHash"], plan.content_hash)
            activated = activate_release(client, "data", plan.release)
            self.assertEqual(activated["release"], plan.release)

    def test_activate_rejects_incomplete_release_before_pointer_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            plan = build_release_plan(root)
            client = FakeClient()
            publish_release(client, plan)
            del client.objects[f"data/releases/{plan.release}/demo.json"]
            client.operations.clear()
            with self.assertRaisesRegex(RuntimeError, "remote verification failed"):
                activate_release(client, "data", plan.release)
            self.assertNotIn(("put", "data/current.json"), client.operations)


if __name__ == "__main__":
    unittest.main()
