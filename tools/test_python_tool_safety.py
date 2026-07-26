import base64
import hashlib
import http.client
import io
import json
import threading
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from tools import imgserver, strings_server, sync_r2


@contextmanager
def running_server(module):
    server = module.Server(("127.0.0.1", 0), module.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@contextmanager
def isolated_server(module):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        site = root / "site"
        data = site / "data"
        data.mkdir(parents=True)
        paths = {"root": root, "site": site, "data": data}
        with ExitStack() as stack:
            stack.enter_context(patch.object(module, "SITE", str(site)))
            stack.enter_context(patch.object(module, "DATA", str(data)))
            if module is imgserver:
                originals = root / "originals"
                index = data / "codexes.json"
                index.write_text("[]", encoding="utf-8")
                paths.update({"originals": originals, "index": index})
                stack.enter_context(patch.object(imgserver, "ORIG", str(originals)))
                stack.enter_context(patch.object(imgserver, "INDEX", str(index)))
            elif module is strings_server:
                index = data / "strings_index.json"
                index.write_text('{"collections":[]}', encoding="utf-8")
                paths["index"] = index
                stack.enter_context(patch.object(strings_server, "STRINGS_INDEX", str(index)))
            with running_server(module) as port:
                yield port, paths


def post(port, path, body, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        request_headers = dict(headers or {})
        request_headers.setdefault("Content-Type", "application/json")
        connection.request("POST", path, body=body, headers=request_headers)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def png_data_url():
    payload = io.BytesIO()
    Image.new("RGB", (2, 2), (255, 0, 0)).save(payload, "PNG")
    encoded = base64.b64encode(payload.getvalue()).decode("ascii")
    return "data:image/png;base64," + encoded


class SyncR2SafetyTests(unittest.TestCase):
    def test_put_file_rejects_same_size_toctou_change_before_upload(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "asset.json"
            planned_body = b'{"value":1}'
            changed_body = b'{"value":2}'
            self.assertEqual(len(planned_body), len(changed_body))
            path.write_bytes(changed_body)
            planned_sha = hashlib.sha256(planned_body).hexdigest()
            client = sync_r2.R2Client({
                "account_id": "test",
                "access_key_id": "test",
                "secret_access_key": "test",
                "bucket": "test",
            })

            with patch.object(client, "put_bytes") as put_bytes:
                with self.assertRaisesRegex(RuntimeError, "file changed during upload"):
                    client.put_file("data/demo.json", path, planned_sha, "no-store")

            put_bytes.assert_not_called()

    def test_codex_files_require_matching_nonempty_id_and_exclude_strings(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            samples = {
                "valid.json": {"id": "valid", "entries": []},
                "wrong.json": {"id": "other", "entries": []},
                "empty.json": {"id": "", "entries": []},
                "missing.json": {"entries": []},
                "strings.json": {"id": "strings", "entries": []},
                "strings_extra.json": {"id": "strings_extra", "entries": []},
                "not-a-codex.json": {"id": "not-a-codex", "entries": {}},
                "codexes.json": [{"id": "valid"}],
                "media.json": {},
            }
            for name, value in samples.items():
                (data_dir / name).write_text(
                    json.dumps(value, ensure_ascii=False), encoding="utf-8"
                )

            with patch.object(sync_r2, "DATA_DIR", data_dir):
                self.assertEqual([path.name for path in sync_r2.codex_files()], ["valid.json"])


class AtomicJsonWriteTests(unittest.TestCase):
    def test_replace_failure_keeps_original_and_cleans_temp_files(self):
        cases = (
            (sync_r2, lambda path: sync_r2.write_json(Path(path), {"new": True}, indent=2)),
            (imgserver, lambda path: imgserver._write_json_like(path, {"id": "new"})),
            (strings_server, lambda path: strings_server._atomic_write_json(path, {"new": True})),
        )
        for module, writer in cases:
            with self.subTest(module=module.__name__), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "data.json"
                original = '{"id":"old"}'
                path.write_text(original, encoding="utf-8")
                with patch.object(module.os, "replace", side_effect=OSError("injected replace failure")):
                    with self.assertRaisesRegex(OSError, "injected replace failure"):
                        writer(str(path))
                self.assertEqual(path.read_text(encoding="utf-8"), original)
                self.assertEqual(list(Path(tmp).glob("data.json.*.tmp")), [])

    def test_atomic_writers_keep_existing_json_layout_and_no_trailing_newline(self):
        value = {"id": "new", "标题": "示例", "values": [1, 2]}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            sync_path = root / "sync.json"
            sync_r2.write_json(sync_path, value, indent=2)
            self.assertEqual(
                sync_path.read_text(encoding="utf-8"),
                json.dumps(value, ensure_ascii=False, indent=2),
            )

            image_path = root / "image.json"
            image_path.write_text('{"id":"old"}', encoding="utf-8")
            imgserver._write_json_like(str(image_path), value)
            self.assertEqual(
                image_path.read_text(encoding="utf-8"),
                json.dumps(value, ensure_ascii=False, separators=(",", ":")),
            )

            strings_path = root / "strings.json"
            strings_server._atomic_write_json(str(strings_path), value)
            self.assertEqual(
                strings_path.read_text(encoding="utf-8"),
                json.dumps(value, ensure_ascii=False, indent=2),
            )


class LocalServerSafetyTests(unittest.TestCase):
    def test_origin_helpers_allow_local_or_missing_and_reject_remote(self):
        for module in (imgserver, strings_server):
            with self.subTest(module=module.__name__):
                self.assertTrue(module._is_loopback_origin(None))
                self.assertTrue(module._is_loopback_origin("http://localhost:8767"))
                self.assertTrue(module._is_loopback_origin("http://127.0.0.1:8768"))
                self.assertTrue(module._is_loopback_origin("http://[::1]:8768"))
                self.assertFalse(module._is_loopback_origin("https://evil.example"))
                self.assertFalse(module._is_loopback_origin("http://localhost.evil.example"))
                self.assertFalse(module._is_loopback_origin("http://[::1"))

    def test_post_endpoints_reject_remote_origin_before_processing(self):
        cases = (
            (imgserver, "/__upload__"),
            (strings_server, "/__strings__?action=save"),
        )
        for module, path in cases:
            with self.subTest(module=module.__name__), isolated_server(module) as (port, _paths):
                status, body = post(
                    port,
                    path,
                    b"{}",
                    {"Origin": "https://evil.example", "Content-Type": "text/plain"},
                )
                self.assertEqual(status, 403)
                self.assertIn("ok", body.decode("utf-8"))

    def test_missing_origin_allows_valid_local_requests_in_temporary_directories(self):
        with isolated_server(imgserver) as (port, paths):
            (paths["data"] / "demo.json").write_text(
                json.dumps({"id": "demo", "entries": [{"id": "entry"}]}),
                encoding="utf-8",
            )
            paths["index"].write_text(
                json.dumps([{
                    "id": "demo",
                    "entryCount": 1,
                    "imagedCount": 0,
                }], ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            body = json.dumps({
                "codexId": "demo",
                "entryId": "entry",
                "dataURL": png_data_url(),
            }).encode("utf-8")
            status, _body = post(port, "/__upload__", body)
            self.assertEqual(status, 200)
            self.assertTrue((paths["originals"] / "demo" / "entry.png").is_file())
            self.assertTrue((paths["site"] / "images" / "demo" / "entry.jpg").is_file())
            index = json.loads(paths["index"].read_text(encoding="utf-8"))
            self.assertEqual(index[0]["entryCount"], 1)
            self.assertEqual(index[0]["imagedCount"], 1)

        with isolated_server(strings_server) as (port, paths):
            payload = json.dumps({"entries": []}).encode("utf-8")
            status, _body = post(port, "/__strings__?action=save", payload)
            self.assertEqual(status, 200)
            self.assertEqual(
                json.loads((paths["data"] / "strings.json").read_text(encoding="utf-8")),
                {"entries": []},
            )

    def test_imgserver_rejects_unsafe_components_and_path_escape(self):
        data_url = png_data_url()
        with self.assertRaisesRegex(ValueError, "invalid codexId"):
            imgserver.save_image("../escape", "entry", data_url)
        with self.assertRaisesRegex(ValueError, "invalid entryId"):
            imgserver.save_image("demo", "../escape", data_url)
        malicious_ext = data_url.replace("image/png", r"image/..\escape", 1)
        with self.assertRaisesRegex(ValueError, "invalid image extension"):
            imgserver.save_image("demo", "entry", malicious_ext)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "invalid output path"):
                imgserver._safe_child_path(tmp, "..", "outside.json")

    def test_strings_collection_paths_are_strictly_limited(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(strings_server, "DATA", tmp):
            self.assertEqual(
                strings_server._collection_path("strings.json"),
                str(Path(tmp) / "strings.json"),
            )
            self.assertEqual(
                strings_server._collection_path("strings_extra-1.json"),
                str(Path(tmp) / "strings_extra-1.json"),
            )
            for filename in (
                "codex.json",
                "strings_index.json",
                "../strings.json",
                "strings/escape.json",
                "strings.json.bak",
            ):
                with self.subTest(filename=filename):
                    with self.assertRaisesRegex(ValueError, "invalid file"):
                        strings_server._collection_path(filename)

    def test_strings_save_and_delete_cannot_touch_codex_json(self):
        with isolated_server(strings_server) as (port, paths):
            codex_path = paths["data"] / "demo.json"
            original = json.dumps({"id": "demo", "entries": []})
            codex_path.write_text(original, encoding="utf-8")
            save_status, _body = post(
                port,
                "/__strings__?action=save&file=demo.json",
                b'{"entries":[]}',
            )
            delete_status, _body = post(
                port,
                "/__strings__?action=delete-collection",
                b'{"file":"demo.json"}',
            )
            self.assertEqual(save_status, 400)
            self.assertEqual(delete_status, 400)
            self.assertEqual(codex_path.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
