import unittest
from unittest.mock import patch

from tools import lint_docs


class MarkdownReferenceTests(unittest.TestCase):
    def test_targets_decode_spaces_and_fully_encoded_chinese(self):
        targets = lint_docs.markdown_link_targets(
            "docs/经验/README.md",
            "[D1](Cloudflare%20D1互动系统.md) "
            "[中文](%E6%B5%8B%E8%AF%95.md) "
            "[外部](https://example.com/readme.md)",
        )

        self.assertEqual(targets, {
            "docs/经验/Cloudflare D1互动系统.md",
            "docs/经验/测试.md",
        })

    def test_orphans_require_a_real_link_to_the_exact_path(self):
        documents = {
            "docs/经验/README.md": (
                "[空格](Cloudflare%20D1互动系统.md)\n"
                "[另一个同名](../other/same.md)\n"
                "普通文本提到 same.md 和 orphan.md，不算链接。"
            ),
            "docs/经验/Cloudflare D1互动系统.md": "# D1",
            "docs/经验/same.md": "# 未被链接的同名文件",
            "docs/经验/orphan.md": "# 真正孤儿",
            "docs/other/same.md": "# 被精确链接",
        }
        captured = []
        with patch.object(lint_docs, "read", side_effect=documents.__getitem__), \
                patch.object(lint_docs, "warns", captured):
            lint_docs.check_orphans(list(documents))

        self.assertCountEqual(captured, [
            "[孤儿] docs/经验/orphan.md 没有被任何文档或索引引用——它实际上永远不会被读到",
            "[孤儿] docs/经验/same.md 没有被任何文档或索引引用——它实际上永远不会被读到",
        ])


if __name__ == "__main__":
    unittest.main()
