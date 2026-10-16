"""Back up and clean complete NAI default tails; default mode is a local plan.

Only positive tags/rawTags and images[].rawTag/rawTags are eligible. Original
JSON formatting and all other bytes are preserved. No network or publication.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    from .nai_default_tags import DEFAULT_TAGS, analyze_nai_default_suffix
except ImportError:
    from nai_default_tags import DEFAULT_TAGS, analyze_nai_default_suffix

ROOT = Path(__file__).resolve().parents[1]
DECODER = json.JSONDecoder()


def local_now():
    return datetime.now(timezone(timedelta(hours=8)))


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))


def within(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError('Path outside workspace: ' + str(path))
    return resolved


def prompt_path(path: tuple) -> bool:
    return (len(path) == 3 and path[0] == 'entries' and path[2] in ('tags', 'rawTags')) or (
        len(path) == 5 and path[0] == 'entries' and path[2] == 'images' and path[4] in ('rawTag', 'rawTags'))


def string_spans(source: str) -> list:
    spans = []

    def space(index):
        while index < len(source) and source[index] in ' \t\r\n':
            index += 1
        return index

    def walk(index, path):
        index = space(index)
        if source[index] == '{':
            index = space(index + 1)
            if source[index] == '}':
                return index + 1
            while True:
                key, end = DECODER.raw_decode(source, index)
                if not isinstance(key, str):
                    raise ValueError('Invalid object key')
                colon = space(end)
                if source[colon] != ':':
                    raise ValueError('Expected colon')
                index = space(walk(colon + 1, path + (key,)))
                if source[index] == '}':
                    return index + 1
                if source[index] != ',':
                    raise ValueError('Expected object comma')
                index = space(index + 1)
        if source[index] == '[':
            index = space(index + 1)
            if source[index] == ']':
                return index + 1
            member = 0
            while True:
                index = space(walk(index, path + (member,)))
                if source[index] == ']':
                    return index + 1
                if source[index] != ',':
                    raise ValueError('Expected array comma')
                member += 1
                index = space(index + 1)
        value, end = DECODER.raw_decode(source, index)
        if isinstance(value, str) and prompt_path(path):
            spans.append((path, index, end, value))
        return end

    if space(walk(0, ())) != len(source):
        raise ValueError('Unexpected JSON suffix')
    return spans


def tail_candidate(text: str) -> bool:
    tail = []
    for token in reversed(text.split(',')):
        token = re.sub(r'\s+', ' ', token.strip()).lower()
        if not token:
            continue
        if token not in DEFAULT_TAGS:
            break
        tail.append(token)
    return DEFAULT_TAGS.issubset(tail)


def replace_spans(source: str, replacements: list, target_key: str) -> str:
    start_key, end_key = ('after_start', 'after_end') if target_key == 'before_literal' else ('start', 'end')
    chunks = []
    position = 0
    for replacement in sorted(replacements, key=lambda value: value[start_key]):
        chunks.extend((source[position:replacement[start_key]], replacement[target_key]))
        position = replacement[end_key]
    chunks.append(source[position:])
    return ''.join(chunks)


def plan_file(path: Path) -> tuple:
    before = path.read_bytes()
    bom = before.startswith(b'\xef\xbb\xbf')
    source = before.decode('utf-8-sig')
    data = json.loads(source)
    replacements = []
    exceptions = []
    ids = [entry['id'] for entry in data['entries']]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate entry ID in ' + path.name)
    for field_path, start, end, text in string_spans(source):
        result = analyze_nai_default_suffix(text)
        entry = data['entries'][field_path[1]]
        if result['status'] == 'changed':
            replacements.append({'id': entry['id'], 'field_path': list(field_path),
                'start': start, 'end': end, 'before': text, 'after': result['text'],
                'before_literal': source[start:end],
                'after_literal': json.dumps(result['text'], ensure_ascii=False),
                'removed_tags': result['removed_tags']})
        elif tail_candidate(text):
            exceptions.append({'id': entry['id'], 'field_path': list(field_path),
                               'reason': result['status'], 'prompt_sha256': sha256(text.encode('utf-8')),
                               'before': text})
    target = replace_spans(source, replacements, 'after_literal')
    after = (b'\xef\xbb\xbf' if bom else b'') + target.encode('utf-8')
    # Calculate new positions, then prove inverse replacement restores exact bytes.
    offset = 0
    for item in sorted(replacements, key=lambda value: value['start']):
        item['after_start'] = item['start'] + offset
        item['after_end'] = item['after_start'] + len(item['after_literal'])
        offset += len(item['after_literal']) - (item['end'] - item['start'])
    restored = replace_spans(target, replacements, 'before_literal')
    if ((b'\xef\xbb\xbf' if bom else b'') + restored.encode('utf-8')) != before:
        raise AssertionError('Inverse byte verification failed: ' + path.name)
    json.loads(target)
    return {'file': path.name, 'before_sha256': sha256(before), 'after_sha256': sha256(after),
            'bom': bom, 'entry_count': len(ids), 'changed_entries': len({item['id'] for item in replacements}),
            'changes': replacements, 'exceptions': exceptions}, before, after


def atomic_write(path: Path, value: bytes) -> None:
    temporary = path.with_name('.' + path.name + '.default-tags-' + secrets.token_hex(6) + '.tmp')
    try:
        temporary.write_bytes(value)
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def verify(manifest_path: Path, root: Path) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    count = Counter()
    for book in manifest['books']:
        current_path = within(root / 'site/data' / book['file'], root)
        backup_path = within(manifest_path.parent / book['backup'], root)
        before = backup_path.read_bytes()
        after = current_path.read_bytes()
        if sha256(before) != book['before_sha256'] or sha256(after) != book['after_sha256']:
            raise ValueError('File changed since apply: ' + book['file'])
        restored = after.decode('utf-8-sig')
        for item in sorted(book['changes'], key=lambda value: value['after_start'], reverse=True):
            if restored[item['after_start']:item['after_end']] != item['after_literal']:
                raise ValueError('Unexpected changed field')
        restored = replace_spans(restored, book['changes'], 'before_literal')
        if ((b'\xef\xbb\xbf' if book['bom'] else b'') + restored.encode('utf-8')) != before:
            raise ValueError('Other JSON bytes changed: ' + book['file'])
        plan, _, _ = plan_file(current_path)
        if plan['changes']:
            raise ValueError('Not idempotent: ' + book['file'])
        count['files_verified'] += 1
        count['fields_verified'] += len(book['changes'])
    for moved in manifest.get('moved_sources', []):
        source = within(root / moved['source'], root)
        target = within(manifest_path.parent / moved['backup'], root)
        if source.exists() or sha256(target.read_bytes()) != moved['sha256']:
            raise ValueError('DOCX source archive changed')
    return dict(count)


def run(root: Path, report_dir: Path, apply: bool = False) -> dict:
    root = root.resolve()
    report_dir = within(report_dir, root)
    report_dir.mkdir(parents=True, exist_ok=True)
    index_path = within(root / 'site/data/codexes.json', root)
    index_bytes = index_path.read_bytes()
    index = json.loads(index_bytes.decode('utf-8-sig'))
    plans = []
    for meta in index:
        path = within(root / 'site/data' / (meta['id'] + '.json'), root)
        plan, before, after = plan_file(path)
        plans.append((path, plan, before, after))
        print(json.dumps({'scan': path.name, 'changes': len(plan['changes']), 'exceptions': len(plan['exceptions'])}), flush=True)
    counts = Counter({key: 0 for key in ('changed_entries', 'exceptions', 'changed_books',
        'changed_fields', 'removed_tags', 'main_fields', 'image_fields', 'empty_after')})
    for _, plan, _, _ in plans:
        counts['changed_entries'] += plan['changed_entries']
        counts['exceptions'] += len(plan['exceptions'])
        if plan['changes']:
            counts['changed_books'] += 1
        for item in plan['changes']:
            counts['changed_fields'] += 1
            counts['removed_tags'] += len(item['removed_tags'])
            counts['main_fields' if len(item['field_path']) == 3 else 'image_fields'] += 1
            if not item['after'].strip():
                counts['empty_after'] += 1
    report = {'mode': 'apply' if apply else 'plan', 'created_at': local_now().isoformat(),
              'index_sha256': sha256(index_bytes), 'counts': dict(counts),
              'books': [plan for _, plan, _, _ in plans]}
    write_json(report_dir / ('apply-plan.json' if apply else 'plan.json'), report)
    if not apply or not counts['changed_fields']:
        return report
    backup_dir = report_dir / ('backup-' + local_now().strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3))
    backup_dir.mkdir()
    changed = [(path, plan, before, after) for path, plan, before, after in plans if plan['changes']]
    manifest = {'counts': dict(counts), 'books': [], 'moved_sources': []}
    for path, plan, before, _after in changed:
        backup_path = backup_dir / path.name
        backup_path.write_bytes(before)
        manifest['books'].append({**plan, 'backup': path.name})
    source_moves = []
    if any(path.stem == 'jiegou_yuandian' for path, _, _, _ in changed):
        source_dir = within(root / '法典源', root)
        for source in sorted(source_dir.glob('解构原典*.docx')):
            source = within(source, source_dir)
            target = within(backup_dir / 'docx' / source.name, root)
            raw = source.read_bytes()
            source_moves.append((source, target, raw))
            manifest['moved_sources'].append({'source': source.relative_to(root).as_posix(),
                'backup': target.relative_to(backup_dir).as_posix(), 'sha256': sha256(raw)})
    # Freeze every recovery path before the first move or data replacement.
    write_json(backup_dir / 'manifest.json', manifest)
    applied = []
    moved = []
    try:
        if index_path.read_bytes() != index_bytes:
            raise ValueError('Book index changed since plan')
        for path, _plan, before, _after in changed:
            if path.read_bytes() != before:
                raise ValueError('Data changed since plan: ' + path.name)
        for source, target, raw in source_moves:
            if source.read_bytes() != raw:
                raise ValueError('DOCX changed since plan: ' + str(source))
            target.parent.mkdir(exist_ok=True)
            source.replace(target)
            moved.append((source, target))
        for path, _plan, before, after in changed:
            if path.read_bytes() != before:
                raise ValueError('Data changed before replacement: ' + path.name)
            atomic_write(path, after)
            applied.append((path, before))
        report['verification'] = verify(backup_dir / 'manifest.json', root)
    except Exception:
        for path, before in reversed(applied):
            atomic_write(path, before)
        for source, target in reversed(moved):
            if source.exists():
                raise RuntimeError('Cannot restore DOCX over a new source: ' + str(source))
            target.replace(source)
        raise
    report['backup_manifest'] = str(backup_dir / 'manifest.json')
    write_json(report_dir / 'applied.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--report-dir', type=Path, default=ROOT / ('output/default-tags-cleanup-' + local_now().strftime('%Y%m%d')))
    parser.add_argument('--verify', type=Path, metavar='MANIFEST')
    args = parser.parse_args()
    if args.verify:
        print(json.dumps(verify(args.verify.resolve(), ROOT)))
        return
    report = run(ROOT, args.report_dir, args.apply)
    print(json.dumps({'mode': report['mode'], 'counts': report['counts'],
                      'backup_manifest': report.get('backup_manifest'),
                      'verification': report.get('verification')}, ensure_ascii=True))


if __name__ == '__main__':
    main()
