"""Local editor writes: synthetic files only; no credentials, network or real data."""
import base64
from contextlib import ExitStack, contextmanager
import io
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from tools import imgserver, local_file_transaction, strings_server


def image_bytes(color, format="PNG"):
    stream = io.BytesIO()
    Image.new("RGB", (4, 3), color).save(stream, format)
    return stream.getvalue()


@contextmanager
def image_fixture():
    with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
        root = Path(directory)
        paths = {
            "ROOT": root, "SITE": root / "site", "DATA": root / "site/data",
            "ORIG": root / "originals", "INDEX": root / "site/data/codexes.json",
        }
        for name, path in paths.items():
            stack.enter_context(patch.object(imgserver, name, str(path)))
        originals = paths["ORIG"] / "demo/entry.png"
        thumbnail = paths["SITE"] / "images/demo/entry.jpg"
        book = paths["DATA"] / "demo.json"
        for target in (originals, thumbnail, book):
            target.parent.mkdir(parents=True, exist_ok=True)
        originals.write_bytes(image_bytes("red"))
        thumbnail.write_bytes(image_bytes("red", "JPEG"))
        book.write_text(json.dumps({"id": "demo", "entryCount": 1, "imagedCount": 1,
            "entries": [{"id": "entry", "image": "entry.jpg", "original": "entry.png", "assetRev": "old"}]}), encoding="utf-8")
        paths["INDEX"].write_text(json.dumps([{"id": "demo", "entryCount": 1, "imagedCount": 1}], indent=2), encoding="utf-8")
        files = (originals, thumbnail, book, paths["INDEX"])
        before = {p: p.read_bytes() for p in files}
        durl = "data:image/png;base64," + base64.b64encode(image_bytes("blue")).decode("ascii")
        yield root, files, before, durl


class ImageTransactionTests(unittest.TestCase):
    def assert_backup(self, root, result, before):
        backup = root / result["backupDir"]
        manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["files"]), 4)
        for item in manifest["files"]:
            target = root / item["path"]
            self.assertEqual((backup / item["backup"]).read_bytes(), before[target])

    def test_failed_json_write_keeps_old_media_and_metadata(self):
        with image_fixture() as (_root, files, before, durl):
            with patch.object(imgserver, "_write_json_like", side_effect=OSError("injected JSON failure")):
                with self.assertRaises(OSError):
                    imgserver.save_image("demo", "entry", durl)
            self.assertEqual({p: p.read_bytes() for p in files}, before)

    def test_each_media_write_before_and_after_commit_is_compensated(self):
        for index in (0, 1):
            for after_write in (False, True):
                with self.subTest(index=index, after_write=after_write), image_fixture() as (root, files, before, durl):
                    writer = imgserver.atomic_write_bytes
                    def fail(path, payload):
                        if Path(path) == files[index]:
                            if after_write:
                                writer(path, payload)
                            raise OSError("injected media failure")
                        return writer(path, payload)
                    with patch.object(imgserver, "atomic_write_bytes", side_effect=fail):
                        with self.assertRaises(local_file_transaction.TransactionError) as caught:
                            imgserver.save_image("demo", "entry", durl)
                    self.assertEqual({p: p.read_bytes() for p in files}, before)
                    self.assert_backup(root, {"backupDir": caught.exception.backup_dir}, before)

    def test_each_metadata_write_after_commit_is_compensated(self):
        for name in ("_write_json_like", "_update_index_counts"):
            with self.subTest(name=name), image_fixture() as (_root, files, before, durl):
                real = getattr(imgserver, name)
                def fail(*args):
                    real(*args)
                    raise OSError("response after write lost")
                with patch.object(imgserver, name, side_effect=fail):
                    with self.assertRaises(local_file_transaction.TransactionError):
                        imgserver.save_image("demo", "entry", durl)
                self.assertEqual({p: p.read_bytes() for p in files}, before)

    def test_new_media_removed_after_failed_commit(self):
        with image_fixture() as (_root, files, _before, durl):
            for path in files[:2]:
                path.unlink()
            with patch.object(imgserver, "_write_json_like", side_effect=OSError("injected JSON failure")):
                with self.assertRaises(local_file_transaction.TransactionError):
                    imgserver.save_image("demo", "entry", durl)
            self.assertFalse(any(path.exists() for path in files[:2]))

    def test_rollback_failure_keeps_exact_backup_and_reports_it(self):
        with image_fixture() as (root, files, before, durl):
            writer = local_file_transaction.atomic_write_bytes
            def fail_restore(path, payload):
                if Path(path) == files[0]:
                    raise OSError("injected restore failure")
                return writer(path, payload)
            with patch.object(imgserver, "_write_json_like", side_effect=OSError("commit failed")), \
                 patch.object(local_file_transaction, "atomic_write_bytes", side_effect=fail_restore):
                with self.assertRaises(local_file_transaction.TransactionError) as caught:
                    imgserver.save_image("demo", "entry", durl)
            self.assertEqual(len(caught.exception.rollback_errors), 1)
            self.assertIn("originals/demo/entry.png", caught.exception.rollback_errors[0])
            self.assert_backup(root, {"backupDir": caught.exception.backup_dir}, before)

    def test_success_returns_backup_and_lost_http_response_keeps_commit(self):
        with image_fixture() as (root, files, before, durl):
            request = {"codexId": "demo", "entryId": "entry", "dataURL": durl}
            raw = json.dumps(request).encode("utf-8")
            handler = imgserver.Handler.__new__(imgserver.Handler)
            handler.path = "/__upload__"
            handler.headers = {"Content-Length": str(len(raw))}
            handler.rfile = io.BytesIO(raw)
            with patch.object(handler, "_json", side_effect=BrokenPipeError("lost response")) as respond:
                with self.assertRaises(BrokenPipeError):
                    handler.do_POST()
            self.assertEqual(respond.call_count, 1)
            result = respond.call_args.args[0]
            self.assertTrue(result["ok"])
            self.assert_backup(root, result, before)
            self.assertNotEqual(files[0].read_bytes(), before[files[0]])
            self.assertEqual(json.loads(files[2].read_text())["entries"][0]["assetRev"], result["assetRev"])

    def test_encoding_failure_does_not_touch_old_files(self):
        with image_fixture() as (root, files, before, durl):
            with patch.object(Image.Image, "save", side_effect=OSError("encoding failure")):
                with self.assertRaises(OSError):
                    imgserver.save_image("demo", "entry", durl)
            self.assertEqual({p: p.read_bytes() for p in files}, before)
            self.assertFalse((root / "output").exists())

    def test_failed_index_write_keeps_old_media_and_metadata(self):
        with image_fixture() as (_root, files, before, durl):
            with patch.object(imgserver, "_update_index_counts", side_effect=OSError("injected index failure")):
                with self.assertRaises(OSError):
                    imgserver.save_image("demo", "entry", durl)
            self.assertEqual({p: p.read_bytes() for p in files}, before)


@contextmanager
def strings_fixture():
    with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
        root = Path(directory)
        data = root / "site/data"
        data.mkdir(parents=True)
        for name, value in {"ROOT": root, "SITE": root / "site", "DATA": data,
                            "STRINGS_INDEX": data / "strings_index.json"}.items():
            stack.enter_context(patch.object(strings_server, name, str(value)))
        target = data / "strings.json"
        target.write_text(json.dumps({"title": "Original", "entries": [{"id": "a", "images": []}]}, indent=2), encoding="utf-8")
        yield root, target


def strings_save(data, revision=None, respond=None):
    raw = json.dumps(data).encode("utf-8")
    handler = strings_server.Handler.__new__(strings_server.Handler)
    handler.path = "/__strings__?action=save&file=strings.json"
    handler.headers = {"Content-Length": str(len(raw))}
    if revision is not None:
        handler.headers["If-Match"] = revision
    handler.rfile = io.BytesIO(raw)
    result = []
    handler._serve_json = respond or (lambda body, code=200: result.append((code, body)))
    handler._handle_save()
    return result[0] if result else None


class StringsSaveTests(unittest.TestCase):
    def test_stale_version_cannot_replace_newer_collection(self):
        with strings_fixture() as (_root, target):
            old_revision = hashlib.sha256(target.read_bytes()).hexdigest()
            target.write_text('{"title":"Other tab saved","entries":[]}', encoding="utf-8")
            before = target.read_bytes()
            status, _body = strings_save({"title": "Stale", "entries": []}, old_revision)
            self.assertEqual(status, 409)
            self.assertEqual(target.read_bytes(), before)

    def test_existing_file_requires_version(self):
        with strings_fixture() as (_root, target):
            before = target.read_bytes()
            status, _body = strings_save({"title": "Unversioned", "entries": []})
            self.assertEqual(status, 428)
            self.assertEqual(target.read_bytes(), before)

    def test_success_has_exact_before_backup(self):
        with strings_fixture() as (root, target):
            before = target.read_bytes()
            status, body = strings_save({"title": "Updated", "entries": []}, hashlib.sha256(before).hexdigest())
            self.assertEqual(status, 200)
            self.assertIn("backupDir", body)
            self.assertEqual((root / body["backupDir"] / "files/site/data/strings.json").read_bytes(), before)

    def test_read_returns_data_and_revision_from_same_bytes(self):
        with strings_fixture() as (_root, target):
            handler = strings_server.Handler.__new__(strings_server.Handler)
            result = []
            handler._serve_json = lambda body, code=200: result.append((code, body))
            handler._handle_read({"file": ["strings.json"]})
            self.assertEqual(result[0][0], 200)
            self.assertEqual(result[0][1]["data"], json.loads(target.read_bytes()))
            self.assertEqual(result[0][1]["revision"], hashlib.sha256(target.read_bytes()).hexdigest())

    def test_failed_write_before_or_after_replace_restores_old_bytes(self):
        for after_write in (False, True):
            with self.subTest(after_write=after_write), strings_fixture() as (root, target):
                before = target.read_bytes()
                writer = strings_server._atomic_write_json
                def fail(*args):
                    if after_write:
                        writer(*args)
                    raise OSError("injected strings failure")
                with patch.object(strings_server, "_atomic_write_json", side_effect=fail):
                    status, body = strings_save({"title": "Updated", "entries": []}, hashlib.sha256(before).hexdigest())
                self.assertEqual(status, 500)
                self.assertEqual(target.read_bytes(), before)
                self.assertEqual((root / body["backupDir"] / "files/site/data/strings.json").read_bytes(), before)

    def test_save_response_loss_can_confirm_same_bytes_without_another_write(self):
        with strings_fixture() as (root, target):
            revision = hashlib.sha256(target.read_bytes()).hexdigest()
            desired = {"title": "Updated", "entries": []}
            def lost(*args):
                raise BrokenPipeError("response lost after commit")
            with self.assertRaises(BrokenPipeError):
                strings_save(desired, revision, lost)
            committed = target.read_bytes()
            backups = list((root / "output/local-tool-backups").iterdir())
            status, body = strings_save(desired, revision)
            self.assertEqual(status, 200)
            self.assertTrue(body["unchanged"])
            self.assertEqual(target.read_bytes(), committed)
            self.assertEqual(list((root / "output/local-tool-backups").iterdir()), backups)

    def test_rollback_failure_reports_backup_and_preserves_original_copy(self):
        with strings_fixture() as (root, target):
            before = target.read_bytes()
            writer = strings_server._atomic_write_json
            restore = local_file_transaction.atomic_write_bytes
            def fail_commit(*args):
                writer(*args)
                raise OSError("commit interrupted")
            def fail_restore(path, payload):
                if Path(path) == target:
                    raise OSError("restore interrupted")
                return restore(path, payload)
            with patch.object(strings_server, "_atomic_write_json", side_effect=fail_commit), \
                 patch.object(local_file_transaction, "atomic_write_bytes", side_effect=fail_restore):
                status, body = strings_save({"title": "Updated", "entries": []}, hashlib.sha256(before).hexdigest())
            self.assertEqual(status, 500)
            self.assertEqual(len(body["rollbackErrors"]), 1)
            self.assertEqual((root / body["backupDir"] / "files/site/data/strings.json").read_bytes(), before)


def strings_upload(revision, images=None):
    handler = strings_server.Handler.__new__(strings_server.Handler)
    handler.headers = {"Content-Type": "multipart/form-data; boundary=test", "Content-Length": "0"}
    handler.rfile = io.BytesIO()
    parts = {"image": image_bytes("blue"), "entryId": b"a", "stringsFile": b"strings.json",
             "existingImages": json.dumps(images or []).encode(), "label": b"gallery", "revision": revision.encode()}
    handler._parse_multipart = lambda *_: [{"name": key, "data": value} for key, value in parts.items()]
    result = []
    handler._serve_json = lambda body, code=200: result.append((code, body))
    handler._handle_upload()
    return result[0]


class StringsUploadTests(unittest.TestCase):
    def test_upload_conflict_writes_neither_media_nor_json(self):
        with strings_fixture() as (root, target):
            before = target.read_bytes()
            status, _body = strings_upload("0" * 64)
            self.assertEqual(status, 409)
            self.assertEqual(target.read_bytes(), before)
            self.assertFalse((root / "site/images").exists())

    def test_upload_success_has_revision_and_recoverable_snapshot(self):
        with strings_fixture() as (root, target):
            before = target.read_bytes()
            status, body = strings_upload(hashlib.sha256(before).hexdigest())
            self.assertEqual(status, 200)
            self.assertEqual(body["revision"], hashlib.sha256(target.read_bytes()).hexdigest())
            self.assertTrue((root / "site/images/strings" / body["file"]).exists())
            self.assertEqual((root / body["backupDir"] / "files/site/data/strings.json").read_bytes(), before)
            self.assertEqual(json.loads(target.read_bytes())["title"], "Original")

    def test_failed_upload_restores_json_and_removes_new_media(self):
        with strings_fixture() as (root, target):
            before = target.read_bytes()
            writer = strings_server._atomic_write_json
            def fail(*args):
                writer(*args)
                raise OSError("injected upload failure")
            with patch.object(strings_server, "_atomic_write_json", side_effect=fail):
                status, body = strings_upload(hashlib.sha256(before).hexdigest())
            self.assertEqual(status, 500)
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list((root / "site/images/strings").iterdir()), [])
            self.assertTrue((root / body["backupDir"] / "manifest.json").exists())


class TransactionBoundaryTests(unittest.TestCase):
    def test_parent_escape_stops_before_backup_or_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "workspace"
            root.mkdir()
            with self.assertRaises(ValueError):
                local_file_transaction.run_file_transaction(root, [root / "../outside"], lambda: self.fail("operation ran"), "test")
            self.assertFalse((root / "output").exists())


if __name__ == "__main__":
    unittest.main()
