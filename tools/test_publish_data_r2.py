import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.publish_data_r2 import (
    POINTER_CACHE_CONTROL,
    activate_release,
    build_release_plan,
    check_public_release,
    check_current_release,
    publish_release,
    sha256_bytes,
)


ROLLBACK_TARGET = "r-11111111111111111111"


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


def seed_pointer(client, release):
    client.objects["data/current.json"] = {
        "body": json.dumps({"release": release}).encode(),
        "sha256": "",
        "cache": POINTER_CACHE_CONTROL,
    }


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
    write_json(root / "share-index.json", {"codexes": {"demo": {"id": "demo", "shareable": True}}})
    write_json(root / "share" / "demo.json", {"id": "demo"})


class PublishDataR2Tests(unittest.TestCase):
    def test_public_release_check_uses_explicit_user_agent_and_origin(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            plan = build_release_plan(root)

            class FakeResponse:
                headers = {"Access-Control-Allow-Origin": "https://novelai.quicktagcloud.com"}

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

                def read(self):
                    return plan.manifest_bytes

            with patch("tools.publish_data_r2.urllib.request.urlopen", return_value=FakeResponse()) as urlopen:
                check_public_release(
                    "https://assets.quicktagcloud.com",
                    "https://novelai.quicktagcloud.com",
                    "data",
                    plan,
                )

            request = urlopen.call_args.args[0]
            self.assertEqual(request.get_header("Origin"), "https://novelai.quicktagcloud.com")
            self.assertEqual(request.get_header("User-agent"), "NovelAI-Tag-Data-Publisher/1.0")

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

    def test_missing_share_shard_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            (root / "share" / "demo.json").unlink()
            with self.assertRaisesRegex(ValueError, "share shard is missing"):
                build_release_plan(root)

    def test_pointer_is_written_last_and_tracks_previous_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            plan = build_release_plan(root)
            client = FakeClient()
            seed_pointer(client, ROLLBACK_TARGET)
            result = publish_release(client, plan)
            self.assertEqual(client.operations[-1], ("put", "data/current.json"))
            self.assertEqual(result["pointer"]["release"], plan.release)
            self.assertEqual(result["pointer"]["previousRelease"], ROLLBACK_TARGET)
            self.assertEqual(client.objects["data/current.json"]["cache"], POINTER_CACHE_CONTROL)

    def test_republishing_same_data_keeps_the_rollback_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            plan = build_release_plan(root)
            client = FakeClient()
            seed_pointer(client, ROLLBACK_TARGET)
            publish_release(client, plan)
            # 发布数据.bat 之后再跑发布.bat 会重发同一批数据，回滚目标不能被抹掉。
            again = publish_release(client, plan)
            self.assertEqual(again["pointer"]["previousRelease"], ROLLBACK_TARGET)
            self.assertEqual(activate_release(client, "data", plan.release)["previousRelease"], ROLLBACK_TARGET)

    def test_rollback_and_forward_ping_pong(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            first = build_release_plan(root)
            client = FakeClient()
            publish_release(client, first)
            write_json(root / "about.json", {"changed": True})
            second = build_release_plan(root)
            publish_release(client, second)

            back = activate_release(client, "data", client.get_json("data/current.json")["previousRelease"])
            self.assertEqual(back["release"], first.release)
            self.assertEqual(back["previousRelease"], second.release)
            forward = activate_release(client, "data", back["previousRelease"])
            self.assertEqual(forward["release"], second.release)
            self.assertEqual(forward["previousRelease"], first.release)

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
