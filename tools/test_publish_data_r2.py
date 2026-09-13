import json
import io
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch


from tools.publish_data_r2 import (
    POINTER_CACHE_CONTROL,
    R2DataClient,
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


class FakePublicResponse:
    headers = {"Access-Control-Allow-Origin": "https://novelai.quicktagcloud.com"}

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


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
    write_json(root / "updates.json", {"schema": 1, "batches": []})
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

    def test_manual_activation_still_verifies_the_target_release_files(self):
        """闸门删了，但激活前按 manifest 逐对象核对 size+SHA 的保护必须还在。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            old = build_release_plan(root)
            client = FakeClient()
            publish_release(client, old)
            write_json(root / "codexes.json", [{"id": "demo", "type": "composition"}])
            new = build_release_plan(root)
            publish_release(client, new)
            activate_release(client, "data", old.release)
            self.assertEqual(client.get_json("data/current.json")["release"], old.release)
            activate_release(client, "data", new.release)
            self.assertEqual(client.get_json("data/current.json")["release"], new.release)

    def test_unregistered_codex_type_warns_but_never_blocks(self):
        """维护者 2026-09-01 定案：选择器不认识的类型只提示，不拦发布。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_data(root)
            write_json(root / "codexes.json", [{"id": "demo", "type": "brand-new"}])
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                plan = build_release_plan(root)
            self.assertIn("brand-new", stderr.getvalue())
            client = FakeClient()
            publish_release(client, plan)
            self.assertEqual(client.get_json("data/current.json")["release"], plan.release)


class PublishNetworkRetryTests(unittest.TestCase):
    def check(self, plan, responses):
        with patch("tools.publish_data_r2.urllib.request.urlopen", side_effect=responses) as urlopen,                 patch("tools.publish_data_r2.time.sleep"), redirect_stdout(io.StringIO()) as output:
            try:
                check_public_release("https://assets.quicktagcloud.com", "https://novelai.quicktagcloud.com",
                                     "data", plan)
            finally:
                self.calls, self.output = urlopen.call_count, output.getvalue()

    def test_public_release_check_retries_a_dropped_connection(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_data(Path(tmp))
            plan = build_release_plan(Path(tmp))
        dropped = urllib.error.URLError(ConnectionResetError(10054, "connection reset"))
        self.check(plan, [dropped, FakePublicResponse(plan.manifest_bytes)])
        self.assertEqual(self.calls, 2)
        self.assertIn("public check retry 1/3: connection dropped by network or proxy", self.output)

    def test_public_release_check_fails_at_once_when_the_object_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_data(Path(tmp))
            plan = build_release_plan(Path(tmp))
        refused = urllib.error.HTTPError("https://assets.quicktagcloud.com", 403, "Forbidden", {}, io.BytesIO())
        with self.assertRaisesRegex(RuntimeError, "public release check failed"):
            self.check(plan, [refused, FakePublicResponse(plan.manifest_bytes)])
        self.assertEqual(self.calls, 1)

    def test_release_upload_retries_back_off_with_a_cap(self):
        client = R2DataClient({"account_id": "test", "access_key_id": "test",
                               "secret_access_key": "test", "bucket": "test"})
        upload = Mock(side_effect=urllib.error.URLError(FileNotFoundError(2, "No such file or directory")))
        with patch("tools.publish_data_r2.time.sleep") as sleep, redirect_stdout(io.StringIO()) as output,                 self.assertRaises(urllib.error.URLError):
            client._put_with_retries(upload, "data/releases/r-00000000000000000000/demo.json")
        self.assertEqual(upload.call_count, 7)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2, 4, 8, 10, 10])
        self.assertIn("connection dropped by network or proxy", output.getvalue())


if __name__ == "__main__":
    unittest.main()
