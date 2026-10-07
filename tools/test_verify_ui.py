# -*- coding: utf-8 -*-
"""UI 测试驱动的 beforeunload 消息顺序回归；不启动浏览器。"""
import json
import unittest
from unittest import mock

from tools import verify_ui as ui


DIALOG_EVENT = {"method": "Page.javascriptDialogOpening", "params": {"type": "beforeunload"}}


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


if __name__ == "__main__":
    unittest.main()
