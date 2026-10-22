# -*- coding: utf-8 -*-
"""UI 测试驱动的 beforeunload 消息顺序回归；不启动浏览器。"""
import json
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from tools import verify_ui as ui
with mock.patch.dict(sys.modules, {"verify_ui": ui}):
    from tools import verify_frontend_loading_recovery as loading_fixture


DIALOG_EVENT = {"method": "Page.javascriptDialogOpening", "params": {"type": "beforeunload"}}


class LoadingFixtureBoundaryTests(unittest.TestCase):
    """Use the actual HTTP handler with synthetic files; no browser or sockets."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="loading-fixture-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.before = self.root / "before"
        self.asset = self.root / "site/assets/app/demo.js"
        self.asset.parent.mkdir(parents=True)
        self.asset.write_bytes(b"current module")
        (self.root / "private-sentinel.txt").write_bytes(b"private sentinel")

    def handler(self, source="fixed"):
        captured = []
        class Captured(Exception):
            pass
        def capture(_address, handler):
            captured.append(handler)
            raise Captured
        with mock.patch.object(loading_fixture, "ROOT", self.root), \
             mock.patch.object(loading_fixture, "BEFORE", self.before), \
             mock.patch.object(loading_fixture, "ThreadingHTTPServer", capture), \
             mock.patch.object(sys, "argv", ["fixture", "--source", source, "--out-dir", "reports"]):
            with self.assertRaises(Captured):
                loading_fixture.main()
        return captured[0]

    def request(self, path, source="fixed"):
        handler_type = self.handler(source)
        handler = handler_type.__new__(handler_type)
        handler.path = path
        handler.wfile = io.BytesIO()
        responses = []
        handler.send_error = lambda status: responses.append(status)
        handler.send_response = lambda status: responses.append(status)
        handler.send_header = lambda *_args: None
        handler.end_headers = lambda: None
        with mock.patch.object(loading_fixture, "ROOT", self.root), \
             mock.patch.object(loading_fixture, "BEFORE", self.before):
            handler.do_GET()
        return responses, handler.wfile.getvalue()

    def test_windows_backslash_cannot_escape_assets(self):
        responses, body = self.request("/assets/..\\..\\private-sentinel.txt")
        self.assertEqual(responses, [404])
        self.assertNotIn(b"private sentinel", body)

    def test_encoded_and_slash_traversal_are_not_assets(self):
        for path in ("/assets/../../private-sentinel.txt", "/assets/%2e%2e/%2e%2e/private-sentinel.txt",
                     "/assets/..%5c..%5cprivate-sentinel.txt", "/assets/app/../../../private-sentinel.txt"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path), ([404], b""))

    def test_normal_asset_and_before_fallback_keep_actual_bytes(self):
        self.assertEqual(self.request("/assets/app/demo.js"), ([200], b"current module"))
        self.assertEqual(self.request("/assets/app/demo.js", "before"), ([200], b"current module"))
        frozen = self.before / "site/assets/app/demo.js"
        frozen.parent.mkdir(parents=True)
        frozen.write_bytes(b"frozen module")
        self.assertEqual(self.request("/assets/app/demo.js", "before"), ([200], b"frozen module"))

    def test_asset_reparse_point_is_not_read(self):
        original = Path.lstat
        def reparse(path, *args, **kwargs):
            if path == self.asset:
                return type("ReparseStat", (), {"st_mode": 0o100644, "st_file_attributes": 0x400})()
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, "lstat", reparse):
            self.assertEqual(self.request("/assets/app/demo.js"), ([404], b""))


class ScriptedWebSocket:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.sent = []

    def send_text(self, text):
        self.sent.append(json.loads(text))

    def recv_text(self):
        return json.dumps(next(self.messages))

    def close(self):
        pass


class BeforeUnloadNavigationTests(unittest.TestCase):
    def session(self, messages):
        socket = ScriptedWebSocket(messages)
        with mock.patch.object(ui, "WebSocket", return_value=socket):
            cdp = ui.CDP("ws://127.0.0.1/test")
        self.addCleanup(cdp.close)
        return cdp, socket

    def assert_accepted(self, socket):
        self.assertEqual(socket.sent[1], {
            "id": 2, "method": "Page.handleJavaScriptDialog", "params": {"accept": True},
        })

    def test_confirmation_response_before_navigation(self):
        frame_event = {"method": "Page.frameNavigated", "params": {"frame": {"id": "next"}}}
        cdp, socket = self.session([
            DIALOG_EVENT,
            {"id": 2, "result": {}},
            frame_event,
            {"id": 1, "result": {"loaderId": "next"}},
        ])
        self.assertEqual(cdp.command("Page.navigate", {"url": "http://localhost/next"}), {"loaderId": "next"})
        self.assert_accepted(socket)
        self.assertEqual(cdp.events, [DIALOG_EVENT, frame_event])

    def test_navigation_response_before_confirmation_does_not_stall_next_command(self):
        cdp, socket = self.session([
            DIALOG_EVENT,
            {"id": 1, "result": {"loaderId": "next"}},
            {"id": 2, "result": {}},
            {"id": 3, "result": {"result": {"value": "next page ready"}}},
        ])
        self.assertEqual(cdp.command("Page.navigate", {"url": "http://localhost/next"}), {"loaderId": "next"})
        self.assertEqual(cdp.eval("document.title"), "next page ready")
        self.assert_accepted(socket)
        self.assertEqual([message["id"] for message in socket.sent], [1, 2, 3])
        self.assertEqual(cdp.events, [DIALOG_EVENT])

    def test_confirmation_failure_reports_cause(self):
        cdp, socket = self.session([
            DIALOG_EVENT,
            {"id": 2, "error": {"message": "dialog could not close"}},
        ])
        with self.assertRaisesRegex(RuntimeError, "Page.handleJavaScriptDialog failed.*dialog could not close"):
            cdp.command("Page.navigate", {"url": "http://localhost/next"})
        self.assert_accepted(socket)

    def test_reload_waits_for_the_new_document(self):
        cdp = mock.Mock()
        cdp.eval.side_effect = [None, False, True]
        with mock.patch.object(ui.time, "sleep"):
            ui.reload(cdp, ignore_cache=True)
        cdp.command.assert_called_once_with("Page.reload", {"ignoreCache": True}, timeout=10)
        self.assertEqual(cdp.eval.call_args_list[0], mock.call("window.__qaNavigating = true"))
        self.assertEqual(cdp.eval.call_count, 3)
        condition = cdp.eval.call_args_list[1].args[0]
        self.assertIn("!window.__qaNavigating", condition)
        self.assertIn("document.readyState", condition)
        self.assertEqual(condition, cdp.eval.call_args_list[2].args[0])


class ResultStatusTests(unittest.TestCase):
    def run_case(self, detail=None, error=None, **kwargs):
        results = []
        def check():
            if error:
                raise error
            return detail
        with mock.patch.object(ui, "log"):
            ui.run_check(results, "synthetic check", check, **kwargs)
        self.assertEqual(len(results), 1)
        return results[0]

    def test_normal_return_is_pass(self):
        result = self.run_case({"checked": 1})
        self.assertEqual(result["status"], "PASS")
        self.assertTrue(result["ok"])

    def test_legacy_skipped_return_is_not_pass(self):
        result = self.run_case({"skipped": "required fixture absent"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "SKIP")
        self.assertEqual(ui.summarize_results([result])["status"], "BLOCKED")

    def test_missing_required_fixture_is_blocked(self):
        result = self.run_case({"status": "BLOCKED", "reason": "fixture absent"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "BLOCKED")

    def run_actual_case(self, only, cdp):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "site" / "data"
            data.mkdir(parents=True)
            pack = {"entries": [
                {"id": "community_ai_misc-one", "rating": "safe", "characterPrompts": [{"negative": "x"}, {}]},
                {"id": "community_ai_misc-two", "rating": "safe"},
            ]}
            artist = {"entries": [{"id": "synthetic", "assetCodexId": "artist_nai45_strings",
                                    "image": "synthetic.webp", "path": ["画风组词典"]}]}
            (data / "nai45_community_pack.json").write_text(json.dumps(pack), encoding="utf-8")
            (data / "artist_nai45_personal.json").write_text(json.dumps(artist), encoding="utf-8")
            with mock.patch.object(ui, "ROOT", root), mock.patch.object(ui, "log"), \
                    mock.patch.object(ui, "first_imaged_entry_id", return_value="synthetic"), \
                    mock.patch.object(ui, "update_filter_config", return_value=[{"latest": True}, {"latest": False, "newOverlap": False}]), \
                    mock.patch.object(ui, "load_codex_list", return_value=[]):
                return ui.run_suite("http://127.0.0.1/", root, cdp, only=only)

    def test_actual_tag_case_blocks_when_core_is_absent(self):
        cdp = mock.Mock()
        results = self.run_actual_case("tag zh", cdp)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["status"], "BLOCKED")
        self.assertFalse(results[0]["ok"])
        self.assertIn("core.json", results[0]["detail"]["reason"])
        cdp.eval.assert_not_called()

    def test_no_original_ui_status_is_not_a_check_result_status(self):
        detail = {"states": ["无原图"], "statusText": "无原图", "statusState": "unavailable",
                  "button": "无原图", "buttonDisabled": True, "buttonHidden": False,
                  "originalRequests": []}
        cdp = mock.Mock()
        cdp.eval.side_effect = [True, detail, True]
        with mock.patch.object(ui, "clear_errors"), mock.patch.object(ui, "navigate"), \
                mock.patch.object(ui, "wait_for"), mock.patch.object(ui, "settle"), \
                mock.patch.object(ui, "screenshot", return_value="synthetic.png"), \
                mock.patch.object(ui, "check_no_errors"):
            results = self.run_actual_case("no-original", cdp)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["status"], "PASS", results[0])
        self.assertEqual(results[0]["detail"]["original"]["statusText"], "无原图")
        cdp.command.assert_any_call("Page.bringToFront")

    def test_assertion_is_fail(self):
        result = self.run_case(error=AssertionError("wrong value"))
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["error"], "wrong value")

    def test_explicit_fail_is_not_pass(self):
        result = self.run_case({"status": "FAIL", "reason": "wrong value"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "FAIL")

    def test_invalid_status_fails_closed(self):
        result = self.run_case({"status": "MAYBE"})
        self.assertEqual(result["status"], "FAIL")

    def test_conflicting_pass_and_skipped_fails_closed(self):
        result = self.run_case({"status": "PASS", "skipped": "fixture absent"})
        self.assertEqual(result["status"], "FAIL")

    def test_summary_keeps_four_counts_and_required_skip_blocks(self):
        results = [self.run_case({"status": value}) for value in ("PASS", "SKIP", "BLOCKED")]
        summary = ui.summarize_results(results)
        self.assertEqual(summary["counts"], {"PASS": 1, "FAIL": 0, "SKIP": 1, "BLOCKED": 1})
        self.assertEqual((summary["status"], summary["exitCode"], summary["ok"]), ("BLOCKED", 2, False))
        results.append(self.run_case(error=ui.CheckFailed("failed")))
        summary = ui.summarize_results(results)
        self.assertEqual((summary["status"], summary["exitCode"]), ("FAIL", 1))

    def test_zero_checks_cannot_pass(self):
        summary = ui.summarize_results([])
        self.assertEqual((summary["status"], summary["exitCode"]), ("BLOCKED", 2))

    def test_optional_skip_is_separate_and_never_counts_as_pass(self):
        skipped = self.run_case({"skipped": "optional"}, required=False)
        summary = ui.summarize_results([skipped])
        self.assertEqual((summary["status"], summary["exitCode"]), ("SKIP", 2))
        summary = ui.summarize_results([self.run_case(), skipped])
        self.assertEqual(summary["status"], "PASS")
        self.assertEqual(summary["counts"]["PASS"], 1)
        self.assertEqual(summary["counts"]["SKIP"], 1)

    def test_report_preserves_blocked_and_skip(self):
        results = [self.run_case({"skipped": "missing"}), self.run_case({"status": "BLOCKED", "reason": "absent"})]
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            ui.write_report(directory, "http://127.0.0.1/", results)
            report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
            markdown = (directory / "report.md").read_text(encoding="utf-8")
        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "BLOCKED")
        self.assertIn("| SKIP |", markdown)
        self.assertIn("| BLOCKED |", markdown)
        self.assertIn("absent", markdown)

    def test_main_exit_matches_required_result_without_starting_browser(self):
        for status, expected in (("PASS", 0), ("FAIL", 1), ("SKIP", 2), ("BLOCKED", 2)):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temp:
                results = [self.run_case({"status": status})]
                with mock.patch("sys.argv", ["verify_ui.py", "--out-dir", temp]), \
                        mock.patch.object(ui, "start_preview"), mock.patch.object(ui, "find_free_port", return_value=1), \
                        mock.patch.object(ui, "start_chrome"), mock.patch.object(ui, "page_ws_url", return_value="ws://fake"), \
                        mock.patch.object(ui, "CDP"), mock.patch.object(ui, "disable_motion"), \
                        mock.patch.object(ui, "run_suite", return_value=results), mock.patch.object(ui, "log"):
                    self.assertEqual(ui.main(), expected)


if __name__ == "__main__":
    unittest.main()
