"""Gated local import of the audited 2026.9.25 所长 Word set.

From this version the N4.5 色色 book arrives as 卷一..卷四: 卷一+卷二 continue
the old upper-book ID namespace and 卷三+卷四 the lower one.  Every volume
repeats the compiler front matter; repeats are removed only after they are
proven identical.

Default: strictly replay the 9.13 snapshots, prepare candidates and write a
review plan.  --apply: apply that frozen plan (backup + all-or-nothing replace).
--verify: read-only re-check.  No network, image writes, or publication.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from docx import Document
import convert
import codex_update_match as match
import suozhang_r18_merge_match as merge
import import_suozhang_models as base

ROOT = base.ROOT
VERSION = '2026.9.25'
BASE_VERSION = '2026.9.13'
SOURCE_NAME = '（解压密码：1984）所长NovelAI个人法典（2026.9.25版，一般所长整理）'
DEFAULT_SOURCE = ROOT.parent / '新数据' / SOURCE_NAME / SOURCE_NAME
DEFAULT_OUT = ROOT / 'output' / 'suozhang-20260925-import'
BASELINE_DIR = ROOT / 'output' / 'suozhang-20260913-import'
BOOKS = base.BOOKS
BASELINES = {
    'suozhang': 'regular-source.json',
    'suozhang_r18': 'N4.5-merged-source.json',
    'suozhang_nai5': 'N5-regular-source.json',
    'suozhang_nai5_r18': 'N5-merged-source.json',
}
SOURCE_HASHES = {
    'N4.5-regular': '01168d45c3aa29103f48c105ebed70ea823ae8563a5b20df11de668c639aaa0b',
    'N4.5-v1': 'bb8a656c83a671a97d5df0d662fa7469ed7e72a263c84faf36e42c94aa80dc8a',
    'N4.5-v2': '19a0bf98a405175c0c28bf40ab4d9b9433465b0aa41975c4e4d3ea389f91be30',
    'N4.5-v3': '993b5cd7f118004ec40b563138b253d90fb48866b5efc9a58a78f4db3d38267b',
    'N4.5-v4': 'c1d24a295160dec9337766024138a983b22bf3c9881eb4563174fee1abfe1a83',
    'N5-regular': '61d65e8a8e0d16a9e1d402865dc071116b9f51eaa380324764594ee45092153b',
    'N5-upper': '001f0fbb830d1e5a4e890d469ca80fcd417d96862641811f1e3451430ebed25c',
    'N5-lower': 'c2abff842406abc7e6ea5321b3faf570c51bb566fc7dc7b903155e5a22ec4195',
}
PART_MARKERS = {'卷一': 'v1', '卷二': 'v2', '卷三': 'v3', '卷四': 'v4', '（上）': 'upper', '（下）': 'lower'}
# 卷一/卷二 are the old upper book, 卷三/卷四 the old lower book.
N45_HALVES = {'N4.5-v1': 'upper', 'N4.5-v2': 'upper', 'N4.5-v3': 'lower', 'N4.5-v4': 'lower'}
# Section renames confirmed in 9.25. Used only to compare old entries with the
# new source; formal paths are then taken from the source as usual.
PATH_ALIASES = {
    'suozhang_r18': {
        ('各种涩涩', '2+girl/+1boy系列'): ('各种涩涩', '2+girl/2+boy系列'),
        ('各种涩涩', '随机生成'): ('基础涩涩', '随机生成'),
    },
    'suozhang_nai5_r18': {('群友色色串收录',): ('网络色色串收录',)},
}
# The 9.13 short-prose decisions, relocated in the 9.25 sources. Values are the
# SHA-256 of the exact paragraph text, so prompt prose stays out of the repository.
PROSE_PARAGRAPHS = {
    'N5-regular': {
        459: '5da347a85ef12bb0bd7c787d5edcdcd23e66fe84c11b925b568d2dfe3073d4ac',
        463: '044f283c90d3ae3ee84f6301aa074ef4940cf89e7c8a76b63009215389a29fe8',
    },
    'N5-upper': {
        466: '3c6ca37690485e2968d48d2f8d9966c8b60345fc661ce89312fce7d74add7734',
        990: '6933c6d515f1ef4fade98cab1e77cb58841093a6a14eb656e28e22652e4de511',
        991: 'f18e4aa2ca637a322706407913342f26635c6ba7734692de12674b021bc52261',
        992: 'dc871857eb653516a7ade58a48ae36bb1990cc1a9d0a485cac2c1d33b8aa0f91',
        1497: '6933c6d515f1ef4fade98cab1e77cb58841093a6a14eb656e28e22652e4de511',
        1498: '5a1dc9ece8cffb654526517c5499f3757975b53ea6f6913659039abd672d070c',
        1499: 'e0a45f4ccf925f29017c7f7dd2e37a1df7aa1a97a55824965e1b22a50d194602',
    },
}
FOOD_EMOJI_PARAGRAPH = 6695
# Later volume of a half → first volume whose front matter it repeats.
REPEATED_FRONT_MATTER = {'N4.5-v2': 'N4.5-v1', 'N4.5-v4': 'N4.5-v3', 'N5-lower': 'N5-upper'}
# 卷二 ends with a verbatim copy of 卷三's 多p/轮奸; keep the historical location.
DUPLICATE_BLOCKS = (
    {
        'drop': ('N4.5-v2', ('各种涩涩', '2+girl/2+boy系列', '多p/轮奸')),
        'keep': ('N4.5-v3', ('杂项涩涩', '过激性爱', '多p/轮奸')),
        'rawItems': 134,
    },
)
STYLE_COLLECTION = {
    'part': 'N5-regular',
    'path': ['画风搜集'],
    'hosts': {'画风1': ('负面', '设置'), '画风2': ('负面', '设置', '附带tag'), 'Q版画风1': ('负面', '设置')},
}
# Author dropped the three post-footer appendices and moved four 9.13 cards to N5.
RETIRED_SECTIONS = ('一些个人未能整好的串', '已删除/替换tag留存', '录自某水友文档的r18串')
MOVED_TO_N5 = ('codex_6e699406-6159', 'codex_6e699406-6160', 'codex_6e699406-6161', 'codex_6e699406-6162')
EXPECTED = {
    'suozhang': {'entryCount': 5700, 'newIdCount': 1, 'removedCount': 0},
    'suozhang_r18': {'entryCount': 11971, 'newIdCount': 41, 'removedCount': 173},
    'suozhang_nai5': {'entryCount': 128, 'newIdCount': 59, 'removedCount': 0},
    'suozhang_nai5_r18': {'entryCount': 469, 'newIdCount': 284, 'removedCount': 0},
}


def alias_path(path, aliases):
    for old, new in aliases.items():
        if tuple(path[:len(old)]) == old:
            return list(new) + list(path[len(old):])
    return list(path)


def aliased(entries, cid):
    aliases = PATH_ALIASES.get(cid, {})
    return [dict(entry, path=alias_path(entry.get('path', []), aliases)) for entry in entries]


def part_key(name):
    model = 'N5' if name.startswith('N5') else 'N4.5'
    if '常规' in name:
        return f'{model}-regular'
    hits = [value for marker, value in PART_MARKERS.items() if marker in name]
    if len(hits) != 1:
        raise ValueError(f'Cannot identify source part: {name}')
    return f'{model}-{hits[0]}'


def special_kind(entry):
    if merge.is_artist_group_entry(entry):
        return 'artist'
    if merge.is_compiler_oc_entry(entry):
        return 'oc'
    return None


def drop_repeated_front_matter(first, other, label):
    """Remove repeated compiler cards only when proven identical to ``first``."""
    first_artist = Counter(merge.fingerprint(e) for e in first if special_kind(e) == 'artist')
    other_artist = Counter(merge.fingerprint(e) for e in other if special_kind(e) == 'artist')
    if other_artist - first_artist:
        raise ValueError(f'{label}: repeated artist groups are not an exact subset')
    first_oc = [merge.fingerprint(e) for e in first if special_kind(e) == 'oc']
    other_oc = [merge.fingerprint(e) for e in other if special_kind(e) == 'oc']
    if first_oc != other_oc:
        raise ValueError(f'{label}: repeated compiler OC cards differ')
    kept = [e for e in other if not special_kind(e)]
    return kept, {'artistRemoved': sum(other_artist.values()), 'ocRemoved': len(other_oc)}


def drop_duplicate_block(raw_drop, raw_keep, entries, rule):
    """Drop a copied section after comparing both copies at raw-parse level.

    Normalized forms can differ legitimately: standalone role cards only merge
    where old parent evidence exists, which is the kept location.
    """
    drop_prefix, keep_prefix = rule['drop'][1], rule['keep'][1]

    def block(items, prefix):
        return [(e['title'], e['tags']) for e in items if tuple(e['path'][:len(prefix)]) == prefix]

    dropped_raw, kept_raw = block(raw_drop, drop_prefix), block(raw_keep, keep_prefix)
    if dropped_raw != kept_raw or len(dropped_raw) != rule['rawItems']:
        raise ValueError(f'Duplicate block {drop_prefix} is not a verbatim copy of {keep_prefix}')
    kept = [e for e in entries if tuple(e['path'][:len(drop_prefix)]) != drop_prefix]
    return kept, {'drop': list(drop_prefix), 'keep': list(keep_prefix), 'rawItems': len(dropped_raw),
                  'normalizedDropped': len(entries) - len(kept)}


def fold_style_collection(entries, rule=STYLE_COLLECTION):
    """Fold 负面/设置/附带tag labels into their 画风 card.

    负面 → negative; 设置 → note (shown as 备注, never copied); 附带tag → the
    sample-scene prompt appended to the card, its char lines as role boxes.
    """
    labels = {'负面', '设置', '附带tag'}
    out, seen = [], {}
    for entry in entries:
        if entry.get('path') != rule['path']:
            out.append(dict(entry))
            continue
        if entry['title'] not in labels:
            if entry['title'] not in rule['hosts'] or entry['title'] in seen:
                raise ValueError(f"Unexpected style card: {entry['title']}")
            seen[entry['title']] = []
            out.append(dict(entry))
            continue
        host = out[-1] if out else None
        if not host or host.get('path') != rule['path'] or host['title'] not in seen:
            raise ValueError(f"Style label without host: {entry['title']}")
        if entry['title'] == '负面':
            if host.get('negative') or entry.get('characterPrompts'):
                raise ValueError('Unexpected negative shape')
            host['negative'] = entry['tags']
        elif entry['title'] == '设置':
            if entry.get('characterPrompts'):
                raise ValueError('Unexpected settings shape')
            host['note'] = ' · '.join(re.sub(r'\s+', ' ', line).strip()
                                      for line in entry['tags'].splitlines() if line.strip())
        else:
            if entry['tags']:
                host['tags'] = host['tags'].rstrip() + '\n' + entry['tags']
            if entry.get('characterPrompts'):
                host['characterPrompts'] = list(host.get('characterPrompts') or []) + list(entry['characterPrompts'])
        host['isNew'] = bool(host.get('isNew') or entry.get('isNew'))
        seen[host['title']].append(entry['title'])
    expected = {title: list(parts) for title, parts in rule['hosts'].items()}
    if seen != expected:
        raise ValueError(f'Style collection shape changed: {seen}')
    return out, {title: parts for title, parts in seen.items()}


def name_untitled(entries):
    counts = Counter()
    for entry in entries:
        if entry['title'] == '(未命名)':
            category = entry['path'][-1]
            counts[category] += 1
            entry['title'] = f'{category}（无标题{counts[category]}）'
    return dict(counts)


def replay_baseline(formal):
    summaries = {}
    for cid, filename in BASELINES.items():
        snapshot = base.read_json(BASELINE_DIR / filename)
        if snapshot.get('version') != BASE_VERSION:
            raise ValueError(f'{cid}: baseline snapshot is not {BASE_VERSION}')
        result = match.match_entries(formal[cid]['entries'], snapshot['entries'])
        if not result['summary']['strictReplayPass'] or result['validationIssues']:
            raise ValueError(f'{cid}: strict {BASE_VERSION} replay failed')
        summaries[cid] = result['summary']
    return summaries


def parse_sources(source, formal):
    references = {
        'N4.5-regular': formal['suozhang']['entries'],
        'N4.5': aliased(formal['suozhang_r18']['entries'], 'suozhang_r18'),
        'N5-regular': aliased(formal['suozhang_nai5']['entries'], 'suozhang_nai5'),
        'N5': aliased(formal['suozhang_nai5_r18']['entries'], 'suozhang_nai5_r18'),
    }
    raw_items, parsed, records = {}, {}, {}
    for path in sorted(source.glob('*.docx')):
        key = part_key(path.name)
        model = key.split('-')[0]
        if key in parsed or base.digest(path) != SOURCE_HASHES.get(key):
            raise ValueError(f'Unreviewed or duplicate source: {path.name}')
        structure = match.inspect_docx_package(path)
        if not match.word_structure_safe(structure):
            raise ValueError(f'Unsupported Word structure: {key}')
        doc = Document(path)
        prose = PROSE_PARAGRAPHS.get(key, {})
        for index, text_sha in prose.items():
            if hashlib.sha256(doc.paragraphs[index].text.encode('utf-8')).hexdigest() != text_sha:
                raise ValueError(f'{key}: audited prose paragraph {index} moved')
        overrides = base.restore_food_emoji(doc, FOOD_EMOJI_PARAGRAPH) if key == 'N4.5-regular' else {}
        audit = []
        raw = convert.parse_standard_docx_items(
            doc, suozhang_model=model, kind_overrides={index: 'tag' for index in prose},
            text_overrides=overrides, audit=audit)
        reference = references.get(key) or references[model]
        entries, roles = base.checked_normalize(raw, reference)
        recovered = base.verify_recovered_prose(doc, entries, audit) if model == 'N5' else 0
        style = None
        if key == STYLE_COLLECTION['part']:
            entries, style = fold_style_collection(entries)
        untitled = name_untitled(entries)
        raw_items[key], parsed[key] = raw, entries
        records[key] = {
            'path': str(path), 'sha256': base.digest(path), 'structure': structure,
            'parsed': len(entries), 'classificationChanges': audit,
            'recoveredProseLinesVerified': recovered,
            'artistCards': sum(special_kind(e) == 'artist' for e in entries),
            'ocCards': sum(special_kind(e) == 'oc' for e in entries),
            'roleBoxes': sum(len(e.get('characterPrompts', [])) for e in entries),
            'standaloneRoleCardMerges': len(roles['standaloneRoleCardMerges']),
            'negativeEntries': sum(bool(e.get('negative')) for e in entries),
            'unnamedTitles': untitled, 'styleCollection': style,
            'restoredInlineEmoji': 6 if overrides else 0,
            'highlighted': sum(bool(e.get('isNew')) for e in entries),
        }
        print(json.dumps({'parsed': key, 'count': len(entries)}, ensure_ascii=True), flush=True)
    if set(parsed) != set(SOURCE_HASHES):
        raise ValueError('Expected all eight source documents')
    return raw_items, parsed, records


def assemble(raw_items, parsed, formal):
    parts = {key: list(entries) for key, entries in parsed.items()}
    stats = {'repeatedFrontMatter': {}, 'duplicateBlocks': []}
    for later, first in REPEATED_FRONT_MATTER.items():
        parts[later], stats['repeatedFrontMatter'][later] = drop_repeated_front_matter(parts[first], parts[later], later)
    for rule in DUPLICATE_BLOCKS:
        drop_key, keep_key = rule['drop'][0], rule['keep'][0]
        parts[drop_key], record = drop_duplicate_block(raw_items[drop_key], raw_items[keep_key], parts[drop_key], rule)
        stats['duplicateBlocks'].append(record)
    for key, entries in parts.items():
        leftover = [e['title'] for e in entries if match.STANDALONE_ROLE_TITLE_RE.fullmatch(e['title'])]
        if leftover:
            raise ValueError(f'{key}: standalone role cards survived: {leftover}')

    halves = merge.partition_formal_entries(formal['suozhang_r18']['entries'])
    upper = parts['N4.5-v1'] + parts['N4.5-v2']
    lower = parts['N4.5-v3'] + parts['N4.5-v4']
    upper, corrections = merge.apply_known_source_title_corrections(upper, halves['upper'], half='upper')
    lower, lower_corrections = merge.apply_known_source_title_corrections(lower, halves['lower'], half='lower')
    n45 = merge.merge_source_halves(upper, lower)
    n5 = merge.merge_source_halves(parts['N5-upper'], parts['N5-lower'])
    stats.update({
        'N4.5': {**n45['stats'], **n45['special'], 'titleCorrections': corrections + lower_corrections},
        'N5': {**n5['stats'], **n5['special']},
    })
    sources = {
        'suozhang': parts['N4.5-regular'],
        'suozhang_r18': n45['merged'],
        'suozhang_nai5': parts['N5-regular'],
        'suozhang_nai5_r18': n5['merged'],
    }
    return sources, stats


def check_removals(cid, removed, applied_books):
    if not removed:
        return []
    if cid != 'suozhang_r18':
        raise ValueError(f'{cid}: unexpected removals')
    moved = set(MOVED_TO_N5)
    n5_bodies = {match.norm_prompt_value(e) for e in applied_books['suozhang_nai5_r18']['entries']}
    records = []
    for entry in removed:
        if entry.get('image'):
            raise ValueError(f"Pictured entry would be removed: {entry['id']}")
        if entry['id'] in moved:
            if match.norm_prompt_value(entry) not in n5_bodies:
                raise ValueError(f"{entry['id']} is not present in N5 as audited")
            reason = 'movedToN5'
        elif entry['path'][:1] and entry['path'][0] in RETIRED_SECTIONS:
            reason = 'retiredAppendix'
        else:
            raise ValueError(f"Unaudited removal: {entry['id']}")
        records.append({'id': entry['id'], 'path': entry['path'], 'title': entry['title'], 'reason': reason})
    if {r['id'] for r in records if r['reason'] == 'movedToN5'} != moved:
        raise ValueError('Audited N5 moves are incomplete')
    return records


def prepare(source, out):
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'applied.json').exists():
        raise ValueError('This frozen plan is already applied; use --verify')
    before = base.data_hashes()
    index = base.read_json(ROOT / 'site/data/codexes.json')
    old_index = {e['id']: e for e in index}
    formal = {cid: base.read_json(ROOT / 'site/data' / f'{cid}.json') for cid in BOOKS}
    if any(book['version'] != BASE_VERSION for book in formal.values()):
        raise ValueError(f'This import expects the audited {BASE_VERSION} formal baseline')
    baseline = replay_baseline(formal)
    raw_items, parsed, records = parse_sources(source, formal)
    sources, merges = assemble(raw_items, parsed, formal)

    applied_books, results = {}, {}
    for cid in BOOKS:
        old = formal[cid]
        entries = sources[cid]
        new_overrides = match.apply_audited_source_new_overrides(entries, cid, VERSION)
        result = base.checked_match(aliased(old['entries'], cid), entries)
        builder = merge.build_applied_codex if cid == 'suozhang_r18' else match.build_applied_codex
        reserved = merge.collect_reserved_asset_ids() if cid == 'suozhang_r18' else {
            p.stem for folder in (ROOT / 'site/images' / cid, ROOT / 'originals' / cid)
            if folder.is_dir() for p in folder.iterdir() if p.is_file()}
        applied, stats = builder(old, entries, result, VERSION, reserved_ids=reserved,
                                 previous_update_filters=old_index[cid].get('updateFilters'))
        for entry in applied['entries']:
            entry.pop('sourceHalf', None)
            entry.pop('sourceIndex', None)
        if cid == 'suozhang_r18':
            stats['auditedNewOverrideIds'] = match.apply_audited_new_overrides(applied['entries'], cid, VERSION)
        if sorted(new_overrides) != sorted(stats.get('auditedNewOverrideIds', [])):
            raise ValueError(f'{cid}: audited NEW overrides did not land on their stable IDs')
        base.validate_book(applied)
        actual = {'entryCount': applied['entryCount'], 'newIdCount': stats['newIdCount'],
                  'removedCount': stats['removedCount']}
        if actual != EXPECTED[cid]:
            raise ValueError(f'{cid}: {actual} differs from audited {EXPECTED[cid]}')
        by_id = {e['id']: e for e in applied['entries']}
        for old_entry in old['entries']:
            new_entry = by_id.get(old_entry['id'])
            if new_entry is None:
                continue
            for key, value in old_entry.items():
                if key not in {*match.SOURCE_CONTENT_KEYS, 'updateBatches', 'sourceHalf', 'sourceIndex'}:
                    if new_entry.get(key) != value:
                        raise ValueError(f"{cid}: inherited field drift {old_entry['id']} {key}")
        applied['title'] = base.TITLES[cid]
        applied_books[cid] = applied
        results[cid] = {'match': base.compact_result(result), 'apply': stats,
                        'summary': {**actual, 'imagedCount': applied['imagedCount'],
                                    'latestUpdateBatchCount': stats['latestUpdateBatchCount']}}
        print(json.dumps({'book': cid, **results[cid]['summary']}, ensure_ascii=True), flush=True)

    removals = {}
    for cid in BOOKS:
        removed_ids = set(results[cid]['apply']['removedIds'])
        removed = [e for e in formal[cid]['entries'] if e['id'] in removed_ids]
        removals[cid] = check_removals(cid, removed, applied_books)

    for cid in BOOKS:
        applied = applied_books[cid]
        if cid == 'suozhang_r18':
            index = merge.build_updated_codex_index(index, applied)
        else:
            index = match.build_updated_codex_index(index, applied, cid)
        meta = next(e for e in index if e['id'] == cid)
        if meta['title'] != base.TITLES[cid]:
            raise ValueError(f'{cid}: catalogue title drifted')
        match.validate_update_batch_contract(applied, meta['updateFilters'])
        base.write_json(out / 'candidates' / f'{cid}.json', applied)
    if any(item != next(e for e in index if e['id'] == item['id']) for item in old_index.values() if item['id'] not in BOOKS):
        raise ValueError('Unrelated catalogue entries changed')
    base.write_json(out / 'candidates' / 'codexes.json', index)

    # Next round's replay baselines (same shapes as the 9.13 snapshots).
    base.write_json(out / 'regular-source.json', {'version': VERSION, 'entries': sources['suozhang']})
    base.write_json(out / 'N5-regular-source.json', {'version': VERSION, 'entries': sources['suozhang_nai5']})
    for cid, name in (('suozhang_r18', 'N4.5-merged-source.json'), ('suozhang_nai5_r18', 'N5-merged-source.json')):
        base.write_json(out / name, {'codexId': cid, 'version': VERSION, 'entryCount': len(sources[cid]),
                                     'entries': sources[cid]})

    payloads = {f'site/data/{cid}.json': out / 'candidates' / f'{cid}.json' for cid in (*BOOKS, 'codexes')}
    if base.data_hashes() != before:
        raise ValueError('Formal data changed during planning; re-run against the latest data')
    plan = {
        'version': VERSION, 'baseline': baseline, 'sources': records, 'merges': merges,
        'books': results, 'removals': removals, 'beforeDataHashes': before,
        'targets': {rel: {'candidate': str(path), 'sha256': base.digest(path),
                          'beforeSha256': before.get(str(Path(rel)))} for rel, path in payloads.items()},
    }
    base.write_json(out / 'plan.json', plan)
    print(json.dumps({'plan': str(out / 'plan.json')}, ensure_ascii=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--out-dir', type=Path, default=DEFAULT_OUT)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if args.apply:
        base.apply_plan(args.out_dir)
    elif args.verify:
        base.verify(args.out_dir)
    else:
        prepare(args.source_dir, args.out_dir)


if __name__ == '__main__':
    main()
