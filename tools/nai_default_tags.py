"""Remove the complete unweighted NAI quality tail without rewriting the prefix.

Keep this tail matcher aligned with site/assets/app/nai-default-tags.js. Image
metadata remains source evidence; apply this only to positive copy text.
"""
from __future__ import annotations

import re

DEFAULT_TAGS = frozenset(('very aesthetic', 'masterpiece', 'no text'))
SEPARATORS = re.compile(r'[,，\r\n]')
DEFAULT_TAIL = re.compile(r'(?:^|[,，\r\n])\s*(?:very\s+aesthetic|masterpiece|no\s+text)[\s,，]*$', re.I)


def analyze_nai_default_suffix(text: str) -> dict:
    """Match only the bare default tail; never parse or rewrite earlier weights.

    NAI bare :: can reset emphasis and brackets, so a balanced-bracket parser
    would reject valid prefixes. Weighted/quoted default tags fail the exact
    tail key match on their own; the preceding prompt does not need repair.
    """
    source = str(text or '')
    if not DEFAULT_TAIL.search(source):
        return {'text': source, 'removed_tags': [], 'status': 'unchanged', 'cut': None}
    pieces = []
    start = 0
    separator_before = None
    for match in SEPARATORS.finditer(source):
        index = match.start()
        slashes = 0
        before = index - 1
        while before >= 0 and source[before] == '\\':
            slashes += 1
            before -= 1
        if slashes % 2:
            continue
        pieces.append((start, index, separator_before))
        start = index + 1
        separator_before = index
    pieces.append((start, len(source), separator_before))
    first = len(pieces)
    removed = []
    for index in range(len(pieces) - 1, -1, -1):
        a, b, _separator = pieces[index]
        token = re.sub(r'\s+', ' ', source[a:b].strip()).lower()
        if not token:
            first = index
            continue
        if token not in DEFAULT_TAGS:
            break
        first = index
        removed.append(token)
    if not DEFAULT_TAGS.issubset(removed):
        return {'text': source, 'removed_tags': [], 'status': 'unchanged', 'cut': None}
    separator = pieces[first][2]
    cut = separator if separator is not None else 0
    return {'text': source[:cut], 'removed_tags': list(reversed(removed)),
            'status': 'changed', 'cut': cut}


def strip_nai_default_suffix(text: str) -> str:
    return analyze_nai_default_suffix(text)['text']
