"""检查动效时长和曲线是否都用了统一节奏变量（tokens.css 的 --dur-* / --ease-out / --ease-spring）。

用法：
  python tools/check_motion_tokens.py           只检查；有零散数值就列出来并以 1 退出
  python tools/check_motion_tokens.py --apply   把零散数值按分档换成变量后再检查

分档（同 site/assets/app/ui-motion.js）：≤160ms 快、≤240 短、≤380 中、≤560 长、≤1000 情节。
不检查：无限循环、100ms 以下、1 秒以上、延迟与错峰、浏览器默认 ease、linear / steps / ease-in-out，
以及开场、换书这两段由脚本计时编排的规则（EXCLUDE）。确有必要保留原值的新规则，把选择器加进 EXCLUDE 并写明原因。
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'site' / 'assets'
FILES = ('styles.css', 'ui-kit.css', 'tag-relay.css', 'community.css', 'favorites-library.css',
         'content-blocking.css', 'favorites-backup.css', 'artist-pick.css', 'artist-style.css')
TOKENS = ('--dur-fast-base', '--dur-short-base', '--dur-medium-base', '--dur-long-base', '--dur-story-base',
          '--motion-scale', '--ease-out', '--ease-spring')

PROPS = (r'(transition|transition-duration|transition-timing-function|animation|animation-duration|'
         r'animation-timing-function|--ui-control-transition)')
DECL = re.compile(r'^(\s*)' + PROPS + r'(\s*:)', re.S)
TIME = re.compile(r'(?<![\w.#-])(\d*\.?\d+)(ms|s)\b')
EASE = re.compile(r'cubic-bezier\([^)]*\)|\b(?:ease-out|ease-in)\b(?!-)')
FALLBACK = re.compile(r'var\(--(?:dur-(?:fast|short|medium|long|story)|ease-(?:out|spring)),')
# 开场、换书由 JS 计时编排，CSS 时长跟脚本里的常量配套，不进档位
EXCLUDE = re.compile(r'intro-|\.intro\b|codex-switching|switch-landing|switch-noise')

OUT = {'.22,1,.36,1', '0.16,1,0.3,1', '.16,1,.3,1', '.2,.7,.3,1', '.3,.7,.4,1', '.22,.61,.36,1', '.2,.8,.2,1',
       '.2,0,0,1', '.12,.75,.3,1', '.2,.7,.22,1', '.3,.6,.3,1', '.3,.7,.25,1'}
SPRING = {'.34,1.56,.64,1', '.3,1.5,.5,1', '.3,1.4,.5,1', '.34,1.25,.64,1'}


def tier(ms: int) -> str | None:
    if ms < 100 or ms > 1000:
        return None
    for limit, name in ((160, 'fast'), (240, 'short'), (380, 'medium'), (560, 'long')):
        if ms <= limit:
            return name
    return 'story'


def ease_family(token: str) -> str | None:
    compact = re.sub(r'\s+', '', token)
    if compact == 'ease-out':
        return 'out'
    match = re.fullmatch(r'cubic-bezier\((.*)\)', compact)
    if not match:
        return None
    if match.group(1) in OUT:
        return 'out'
    if match.group(1) in SPRING:
        return 'spring'
    return None


def split_top(value: str) -> list[str]:
    parts, depth, start = [], 0, 0
    for index, char in enumerate(value):
        if char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
        elif char == ',' and depth == 0:
            parts.append(value[start:index])
            start = index + 1
    parts.append(value[start:])
    return parts


def depth_map(text: str) -> list[int]:
    depth, out = 0, []
    for char in text:
        if char == '(':
            depth += 1
            out.append(depth)
            continue
        out.append(depth)
        if char == ')':
            depth -= 1
    return out


def fix_part(part: str, prop: str, problems: list[str]) -> str:
    if 'infinite' in part:
        return part
    depths = depth_map(part)
    edits = []
    # 已经写成 var(--dur-*) 的段，剩下的时间都是延迟
    if not prop.endswith('timing-function') and 'var(--dur-' not in part:
        for match in TIME.finditer(part):
            if depths[match.start()] != 0:
                continue
            ms = round(float(match.group(1)) * (1000 if match.group(2) == 's' else 1))
            name = tier(ms)
            if name:
                problems.append(f'duration {match.group(0)} -> --dur-{name}')
                edits.append((match.start(), match.end(), f'var(--dur-{name})'))
            break  # 第一个顶层时间是时长，后面的是延迟
    if not prop.endswith('-duration'):
        for match in EASE.finditer(part):
            if depths[match.start()] != 0:
                continue
            family = ease_family(match.group(0))
            if family:
                problems.append(f'easing {match.group(0)} -> --ease-{family}')
                edits.append((match.start(), match.end(), f'var(--ease-{family})'))
    for start, end, replacement in sorted(edits, reverse=True):
        part = part[:start] + replacement + part[end:]
    return part


def mask_comments(text: str) -> str:
    return re.sub(r'/\*.*?\*/', lambda m: ' ' * len(m.group(0)), text, flags=re.S)


def process(css: str, report: list[tuple[int, str]]) -> str:
    out, stack, seg, i, n = [], [], 0, 0, len(css)

    def handle(chunk: str, header: str, offset: int) -> str:
        masked = mask_comments(chunk)
        match = DECL.match(masked)
        if not match or EXCLUDE.search(mask_comments(header)):
            return chunk
        start = match.end()
        if '/*' in chunk[start:]:
            return chunk
        problems: list[str] = []
        value = ','.join(fix_part(part, match.group(2), problems) for part in split_top(chunk[start:]))
        if FALLBACK.search(chunk[start:]):
            problems.append('token has a fallback value; drop the part after the comma')
        line = css.count('\n', 0, offset + len(match.group(1))) + 1
        report.extend((line, problem) for problem in problems)
        return chunk[:start] + value

    while i < n:
        if css.startswith('/*', i):
            end = css.find('*/', i + 2)
            i = n if end < 0 else end + 2
            continue
        char = css[i]
        if char in '"\'':
            j = i + 1
            while j < n and css[j] != char:
                j += 2 if css[j] == '\\' else 1
            i = j + 1
            continue
        if char in '{};':
            chunk = css[seg:i]
            if char == '{':
                stack.append(chunk)
                out.append(chunk)
            else:
                out.append(handle(chunk, stack[-1] if stack else '', seg))
                if char == '}' and stack:
                    stack.pop()
            out.append(char)
            seg = i + 1
        i += 1
    out.append(css[seg:])
    return ''.join(out)


def main(argv: list[str]) -> int:
    apply = '--apply' in argv
    tokens_css = (ASSETS / 'tokens.css').read_text(encoding='utf-8')
    missing = [name for name in TOKENS if not re.search(re.escape(name) + r'\s*:', tokens_css)]
    failures = [f'site/assets/tokens.css missing {name}' for name in missing]
    for name in FILES:
        path = ASSETS / name
        source = path.read_text(encoding='utf-8')
        report: list[tuple[int, str]] = []
        fixed = process(source, report)
        if apply and fixed != source:
            path.write_text(fixed, encoding='utf-8', newline='')
            report = []
            process(fixed, report)
        failures.extend(f'site/assets/{name}:{line} {problem}' for line, problem in report)
    if failures:
        print('FAIL: motion timing not using rhythm tokens (run with --apply to convert)')
        for item in failures:
            print('  ' + item)
        return 1
    print('OK: motion timing uses rhythm tokens.')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
