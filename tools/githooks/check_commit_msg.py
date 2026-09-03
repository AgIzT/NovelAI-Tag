#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""提交信息闸门：四条纯客观检查（标题字数 / 正文体量 / 禁词表 / AI 署名）。

规则、正反例、正文允许写的三种情况，一律见 AGENTS.md「提交信息规范」。
本脚本只做机器判得准的部分；文风靠规范约束，不在这里用词表猜。

由同目录 commit-msg 调用（`git config core.hooksPath tools/githooks`）。
退出码非 0 = 本次提交被拒。人工确要绕过：git commit --no-verify
"""
import re
import sys
from pathlib import Path

MAX_SUBJECT = 10       # 标题字数上限，常规 4~8
MAX_BODY_LINES = 5     # 正文非空行数上限（规范里最宽的那种情况）
MAX_BODY_LINE = 15     # 正文每行字数上限

SKIP_PREFIXES = ("Merge ", "Revert ", "fixup!", "squash!", "amend!")
SCISSORS = "# ------------------------ >8"

# 连续的英文/数字串整体算一个字：去除Turnstile=3、share短链=3、R2桶地址修改=6
WORD_RUN = re.compile(r"[A-Za-z0-9_.+#/@-]+")

# AI 署名：AGENTS.md 硬约束第一条。纯字符串匹配，属于「机器判得准」的那部分。
# 仓库自己会正常提到 CLAUDE.md / .claude/ / claude版，先摘掉这些再匹配，只认署名痕迹。
AI_ALLOW = re.compile(r"CLAUDE\.md|AGENTS\.md|\.claude/|claude版", re.I)
AI_MARKS = re.compile(r"co-?authored-by|generated with|claude\.ai|claude[- ]code|"
                      r"anthropic|chatgpt|copilot|codex cli|🤖", re.I)


def size(text):
    """规范里的「字数」：汉字逐个数，连续英文数字串算一个，空白不计。"""
    return len([c for c in WORD_RUN.sub("X", text) if not c.isspace()])


def strip_comments(raw):
    lines = []
    for line in raw.splitlines():
        if line.startswith(SCISSORS):
            break
        if line.startswith("#"):
            continue
        lines.append(line.rstrip())
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def load_blocklist(here):
    path = here / "blocklist.local.txt"
    if not path.exists():
        return []
    return [ln.strip() for ln in path.read_text(encoding="utf-8", errors="replace").splitlines()
            if ln.strip() and not ln.startswith("#")]


def check_sensitive(lines, blocklist):
    """禁词表 + AI 署名。合并/回滚这类 git 自动生成的信息也要过这两条。"""
    bad = []
    text = "\n".join(lines)

    hit = [w for w in blocklist if w in text]
    if hit:
        bad.append("命中禁词表 tools/githooks/blocklist.local.txt（%d 处）。"
                   "仓库公开、git 历史不可撤销，换中性说法。" % len(hit))

    if AI_MARKS.search(AI_ALLOW.sub("", text)):
        bad.append("提交信息里有 AI 署名/痕迹。见 AGENTS.md「不能做什么」第一条，"
                   "任何形式一律禁止——删掉那行再提交。")

    return bad


def check(lines, blocklist):
    bad = []
    subject = lines[0]
    body = lines[2:] if len(lines) > 2 else []

    n = size(subject)
    if n > MAX_SUBJECT:
        bad.append("标题 %d 字，超过 %d（汉字逐个数，连续英文数字算一个）。"
                   "先想能不能拆成几个提交；拆不开就停下来问维护者，别自己写长。"
                   % (n, MAX_SUBJECT))

    if len(lines) > 1 and lines[1].strip():
        bad.append("标题和正文之间要空一行。")

    body_lines = [ln for ln in body if ln.strip()]
    if len(body_lines) > MAX_BODY_LINES:
        bad.append("正文 %d 行，超过 %d 行。正文默认不写，能写的三种情况见规范；"
                   "为什么这么改 / 数据 / 测试结果写 docs/日志/，不进 git 历史。"
                   % (len(body_lines), MAX_BODY_LINES))
    for ln in body_lines:
        if size(ln) > MAX_BODY_LINE:
            bad.append("正文这行 %d 字，超过 %d：%s" % (size(ln), MAX_BODY_LINE, ln[:24]))
            break

    bad += check_sensitive(lines, blocklist)

    return bad


def main():
    # 控制台是 GBK（发布.bat）时保持其编码；被管道接走时一律 UTF-8，否则中文乱码
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream.isatty():
                stream.reconfigure(errors="replace")
            else:
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    if len(sys.argv) < 2:
        return 0
    lines = strip_comments(Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace"))
    if not lines:
        return 0

    blocklist = load_blocklist(Path(__file__).resolve().parent)
    # 合并/回滚信息由 git 生成，标题形状不归我们管；禁词与 AI 署名仍要查
    bad = (check_sensitive(lines, blocklist) if lines[0].startswith(SKIP_PREFIXES)
           else check(lines, blocklist))
    if not bad:
        return 0

    out = ["", "提交被拒：提交信息不合规（%d 条）" % len(bad), ""]
    for i, item in enumerate(bad, 1):
        out.append("  %d. %s" % (i, item))
    out += ["",
            "想要的样子：标题一行 4~8 字说清动了哪块，正文通常不写。",
            "  图标修复    动效优化    share短链    法典重分类    去除Turnstile",
            "完整规则与正反例：AGENTS.md「提交信息规范」。",
            "人工确要绕过：git commit --no-verify",
            ""]
    sys.stderr.write("\n".join(out) + "\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
