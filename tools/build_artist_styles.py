# -*- coding: utf-8 -*-
"""Build versioned v5 artist-style data from reviewed local inputs.

The default run only validates and prints a plan. Add --apply to write site/data.
--snapshot accepts an existing reviewed root plus its versioned neighbor shards;
--config rebuilds from local research/recognition caches, with no API requests.
--reorder-specimens changes only the existing root's example/cover order.

Examples:
  python tools/build_artist_styles.py --check
  python tools/build_artist_styles.py --reorder-specimens --apply
  python tools/build_artist_styles.py --snapshot <reviewed-root.json>
  python tools/build_artist_styles.py --config <local-config.json> --apply

The ignored default config is output/artist-styles-build-config.json. It has
book, tableDir (data.js/table.json), pilotDir (feat, feat_others, kalo,
kalo_others and models), research (siteRoster JSON), postLookupDir, and names
(reviewed label overlay) path strings. Relative paths resolve beside the config.
integrityKeys.book and integrityKeys.research identify the original path keys
in the post-lookup inputIntegrity evidence. Keep this config and input caches
outside site/data; they are local build inputs, never release data.
"""

import argparse
import collections
import copy
import hashlib
import json
import re
import uuid
from pathlib import Path

try:
    from .artist_style_labels import apply_labels, routes, short_code
    from .nai_default_tags import strip_nai_default_suffix
except ImportError:
    from artist_style_labels import apply_labels, routes, short_code
    from nai_default_tags import strip_nai_default_suffix

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
BOOK_ID = 'artist_nai5_personal'
ID_PREFIX = BOOK_ID + '_'
SECTION = '单画师词典'
DEFAULT_OUT = REPO / 'site' / 'data' / 'artist_styles.json'
DEFAULT_BOOK = REPO / 'site' / 'data' / (BOOK_ID + '.json')
DEFAULT_CONFIG = REPO / 'output' / 'artist-styles-build-config.json'
NEAR = 20
NEAR_SHARD = 512
SHOWCASE = 8
REPS = 4
SPECIMEN_SOURCE_ORDER = ('花枝鱼', 'AgIzT', '九七', '雨燕', 'MayRain', 'wwuumm')


def norm_name(text):
    text = re.sub(r'\s+', ' ', text.lower().replace('_', ' ')).strip()
    return re.sub(r'\s*\(', ' (', text)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def load_table(inputs):
    text = (inputs['tableDir'] / 'data.js').read_text(encoding='utf-8')
    return json.loads(text[text.index('{'):text.rindex('}') + 1])


def wd_safe(inputs):
    safe = {}
    for folder in ('feat', 'feat_others'):
        meta = read_json(inputs['pilotDir'] / folder / 'meta.json')
        flags = np.load(inputs['pilotDir'] / folder / 'safe.npy')
        assert len(meta) == len(flags), folder
        safe.update((row['id'], bool(ok)) for row, ok in zip(meta, flags))
    return safe


def v5_recognition(entries, inputs):
    """读取 v5 词条封面的分类结果。名次针对该图原来的 NAI 画师写法。"""
    labels = read_json(inputs['pilotDir'] / 'models' / 'kaloscope3-web' / 'labels_v3.json')
    classes = {norm_name(str(name)): i for i, name in enumerate(labels)}
    scores = {}
    evaluated = set()
    for folder in ('kalo', 'kalo_others'):
        path = inputs['pilotDir'] / folder
        meta = read_json(path / 'meta.json')
        ranks = np.load(path / 'own.npy')
        top = np.load(path / 'top_idx.npy')
        assert len(meta) == len(ranks) == len(top) == int((path / 'done.txt').read_text()), folder
        for row, rank_row, top_row in zip(meta, ranks, top):
            assert row['id'].startswith(ID_PREFIX) and row['id'] not in evaluated, row
            evaluated.add(row['id'])
            entry = entries[row['id']]
            tags = entry.get('tags', '')
            original_name = (tags.split('artist:', 1)[1] if 'artist:' in tags else tags).split(',')[0].strip()
            assert entry['path'][:2] == ['单画师词典', row['source']], row
            assert entry['image'] == row['image'] and row['name'] == original_name, row
            assert row['cls'] == classes.get(norm_name(original_name), -1), row
            rank = int(rank_row[0])
            assert rank == rank_row[0] and (1 <= rank <= len(labels) if row['cls'] >= 0 else rank == -1), row
            first = int(top_row[0])
            assert 0 <= first < len(labels), row
            if rank > 0:
                scores[row['id']] = (rank, str(labels[first]))
    expected = {entry_id for entry_id, entry in entries.items()
                if entry.get('path', [])[:1] == ['单画师词典'] and entry.get('image')}
    assert evaluated == expected, (len(evaluated), len(expected))
    return scores


def apply_confirmed_names(roster, entries, chosen, keys, inputs):
    """按冻结的词条 ID 对齐已确认的站内原名，待核与近似候选留在原处。"""
    lookup = read_json(inputs['postLookupDir'] / '补查结果.json')
    for label in ('book', 'research'):
        path = inputs[label]
        key = inputs['integrityKeys'][label]
        expected = lookup['inputIntegrity'][key]['afterSha256']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, path

    by_key = {key: i for i, key in enumerate(keys)}
    canonical = {row['canonical']: by_key[norm_name(row['canonical'])]
                 for row in roster if row.get('canonical')}
    by_entry = {entry_id: i for i, ids in chosen.items() for entry_id in ids}
    renamed_to = {}
    post_counts = {}

    def record(source, tag, count):
        target = canonical.get(tag, source)
        assert renamed_to.setdefault(source, target) == target, (source, tag)
        assert post_counts.setdefault(target, count) == count, (tag, count)

    for row in lookup['postCountResults']:
        if row['status'] not in ('positiveCount', 'zeroCountTag'):
            continue
        method = row['matchedBy']
        assert method in ('officialNameOrAlias', 'officialArtistOtherName', 'exactZeroCount'), method
        ids = row.get('entriesByBook', {}).get(BOOK_ID, [])
        if not ids:
            continue
        assert all(entry_id in entries and entry_id in by_entry for entry_id in ids), row
        sources = {by_entry[entry_id] for entry_id in ids}
        assert len(sources) == 1, row
        source, = sources
        if method == 'exactZeroCount':
            # 精确零计数只更新该画师，不凭零计数或相似名称合并。
            assert row['postCount'] == 0
            post_counts[source] = 0
        else:
            assert row['postCount'] > 0, row
            record(source, row['canonical'], row['postCount'])

    gap = read_json(inputs['postLookupDir'] / '换名画师补查.json')
    assert gap['complete']
    for row in gap['gapRenames']:
        source = canonical[row['sourceName']]
        if source not in chosen:
            continue
        tag = row['tag']
        assert row['method'] == 'officialTagAlias' and tag['name'] == row['canonical'], row
        assert tag['category'] == 1 and tag['post_count'] > 0, row
        record(source, row['canonical'], tag['post_count'])

    # 当前快照的补查目标是最终规范名；若未来证据新增了链式改名，先核对身份与计数冲突。
    assert all(renamed_to.get(target, target) == target for target in renamed_to.values())
    return renamed_to, post_counts


def distinct_near(old_indices, new_index, own_index):
    near = []
    seen = {own_index}
    for old in old_indices:
        i = new_index.get(old)
        if i is None or i in seen:
            continue
        near.append(i)
        seen.add(i)
        if len(near) == NEAR:
            break
    return near


def build_data(inputs):
    # Snapshot migration has no NumPy dependency. Full rebuild uses existing local arrays.
    global np
    import numpy as np
    table = load_table(inputs)
    artists = table['artists']
    book = read_json(inputs['book'])
    entries = {entry['id']: entry for entry in book['entries']}
    safe = wd_safe(inputs)
    scores = v5_recognition(entries, inputs)
    roster = read_json(inputs['research'])['siteRoster']

    # 画师表按规范化名称排序。核对原分组成员身份，避免只有行数相同的错位表。
    existing = collections.defaultdict(set)
    for row in roster:
        key = norm_name(row.get('canonical') or row['name'])
        existing[key].update(row.get('entriesByBook', {}).get(BOOK_ID, []))
    keys = sorted(existing)
    assert len(keys) == len(artists)
    table_groups = read_json(inputs['tableDir'] / 'table.json')['groups']
    membership = collections.defaultdict(set)
    for key, artist in zip(keys, artists):
        membership[artist['g']].add(key)
    assert all(membership[g] == set(group['members']) for g, group in enumerate(table_groups))

    def cover_order(entry_id):
        entry = entries[entry_id]
        mayrain = entry['path'][1] == 'MayRain'
        general = entry.get('rating', 'safe') == 'safe' and safe.get(entry_id, False)
        return (not mayrain, not general, entry_id)

    chosen = {}
    for i, key in enumerate(keys):
        ids = sorted((entry_id for entry_id in existing[key] if entries.get(entry_id, {}).get('image')),
                     key=cover_order)
        if ids and artists[i]['g'] >= 0:
            chosen[i] = ids
    assigned = {entry_id for ids in chosen.values() for entry_id in ids}
    assert len(assigned) == sum(map(len, chosen.values()))

    renamed_to, post_counts = apply_confirmed_names(roster, entries, chosen, keys, inputs)
    components = collections.defaultdict(list)
    for i in chosen:
        components[renamed_to.get(i, i)].append(i)

    # 同一人原规范名的行优先，避免移动既有大类／小组。评分仍复用原选图顺序，展示首图稍后统一重排。
    owner_of = {}
    for target, group in components.items():
        owner = target if target in chosen else group[0]
        owner_of.update((i, owner) for i in group)
    owners = sorted(set(owner_of.values()))
    owner_indices = {old: i for i, old in enumerate(owners)}
    new_index = {old: owner_indices[owner] for old, owner in owner_of.items()}

    out_artists = []
    near = []
    for old in owners:
        artist = artists[old]
        target = renamed_to.get(old, old)
        peers = components[target]
        representative = chosen[old][0]
        specimens = [representative] + sorted(
            (entry_id for peer in peers for entry_id in chosen[peer] if entry_id != representative),
            key=cover_order,
        )
        item = {
            'e': representative.removeprefix(ID_PREFIX),
            'p': post_counts.get(target, artist.get('p')),
            'r': None,
            'g': artist['g'],
            'o': artist.get('o', 0),
        }
        if len(specimens) > 1:
            item['x'] = [entry_id.removeprefix(ID_PREFIX) for entry_id in specimens[1:]]
        # 优先比较已评分的 MayRain 封面，其余来源只比较 v5 封面。同档平局按代表图次序。
        ranked = [entry_id for entry_id in specimens if entry_id in scores]
        if ranked:
            sample = min(ranked, key=lambda entry_id: (
                entries[entry_id]['path'][1] != 'MayRain', scores[entry_id][0], specimens.index(entry_id),
            ))
            item['s'] = sample.removeprefix(ID_PREFIX)
            item['r'], item['t'] = scores[sample]
        out_artists.append(item)
        near.append(distinct_near(artist.get('nr', []), new_index, new_index[old]))

    size = collections.Counter(item['g'] for item in out_artists)
    order_in_group = collections.defaultdict(list)
    for i, item in enumerate(out_artists):
        order_in_group[item['g']].append(i)
    out_groups = []
    for g, group in enumerate(table['groups']):
        members = sorted(order_in_group[g], key=lambda i: out_artists[i]['o'])
        members_set = set(members)

        def old_choices(key):
            return list(dict.fromkeys(new_index[j] for j in group.get(key, [])
                                      if j in new_index and new_index[j] in members_set))

        reps = [i for i in old_choices('reps') if out_artists[i]['e'].startswith('baolong_')][:REPS]
        out_groups.append({'name': group['name'], 'desc': group.get('desc', ''), 'tags': group.get('tags', []),
                           'parent': group['parent'], 'size': size[g], 'reps': reps or members[:REPS],
                           'famous': [i for i in old_choices('famous') if out_artists[i]['r'] == 1]})

    def showcase_ok(i, strict):
        item = out_artists[i]
        entry_id = ID_PREFIX + item['e']
        entry = entries[entry_id]
        ok = item['e'].startswith('baolong_') and entry.get('rating', 'safe') == 'safe' and safe.get(entry_id, False)
        return ok and (item['r'] == 1 if strict else True)

    def showcase_of(parent):
        picked = []
        for strict in (True, False):
            pools = [sorted((i for i in order_in_group[g] if showcase_ok(i, strict) and i not in picked),
                            key=lambda i: -(out_artists[i]['p'] or 0)) for g in parent['groups']]
            while len(picked) < SHOWCASE and any(pools):
                for pool in pools:
                    if pool and len(picked) < SHOWCASE:
                        picked.append(pool.pop(0))
            if len(picked) >= SHOWCASE:
                break
        return picked

    out_parents = [{'name': p['name'], 'desc': p.get('desc', ''), 'groups': p['groups'],
                    'size': sum(size[g] for g in p['groups']), 'showcase': showcase_of(p)} for p in table['parents']]
    mapped = [ID_PREFIX + entry_id for item in out_artists for entry_id in [item['e'], *item.get('x', [])]]
    assert len(mapped) == len(set(mapped)) and assigned == set(mapped)
    assert all(item['s'] in [item['e'], *item.get('x', [])] for item in out_artists if 's' in item)

    data = {'schema': 2, 'codexId': BOOK_ID, 'idPrefix': ID_PREFIX, 'nearShard': NEAR_SHARD,
            'rankModel': 'Kaloscope 3.0 Preview (web ONNX)',
            'parents': out_parents, 'groups': out_groups, 'artists': out_artists}
    return reorder_specimens(data, book), near


def require(condition, message):
    if not condition:
        raise ValueError(message)


def index(value, limit):
    return type(value) is int and 0 <= value < limit


def validate_data(data, near, book):
    """Reject broken references before publishing an index-based snapshot."""
    require(data.get('schema') in (2, 3) and data.get('codexId') == BOOK_ID
            and data.get('idPrefix') == ID_PREFIX, 'Unexpected artist-style schema or book')
    parents, groups, artists = (data.get(key) for key in ('parents', 'groups', 'artists'))
    require(all(isinstance(rows, list) and rows for rows in (parents, groups, artists)),
            'Parents, groups and artists must be nonempty arrays')
    require(type(data.get('nearShard')) is int and 1 <= data['nearShard'] <= 4096,
            'Invalid neighbor shard size')
    require(isinstance(book.get('entries'), list), 'Book entries must be an array')
    entries = {row['id']: row for row in book['entries']}
    require(len(entries) == len(book['entries']), 'Duplicate source entry ID')
    names = [row.get('name') for rows in (parents, groups) for row in rows]
    require(all(isinstance(row.get('desc', ''), str) for rows in (parents, groups) for row in rows),
            'Category descriptions must be strings')
    require(all(isinstance(row.get('tags', []), list)
                and all(isinstance(tag, str) for tag in row.get('tags', [])) for row in groups),
            'Group tags must be arrays of strings')
    require(all(isinstance(name, str) and name and name.strip() == name for name in names)
            and len(names) == len(set(names)), 'Invalid or duplicate category name')
    require(all(index(group.get('parent'), len(parents)) for group in groups), 'Invalid parent index')
    membership = []
    for p, parent in enumerate(parents):
        require(isinstance(parent.get('groups'), list) and parent['groups'], 'Empty parent group')
        for g in parent['groups']:
            require(index(g, len(groups)) and groups[g].get('parent') == p,
                    'Parent/group references disagree')
            membership.append(g)
    require(sorted(membership) == list(range(len(groups))), 'Groups must belong to exactly one parent')
    used = set()
    sizes = collections.Counter()
    for row in artists:
        require(index(row.get('g'), len(groups)), 'Invalid artist group')
        sizes[row['g']] += 1
        suffixes = [row.get('e'), *row.get('x', [])]
        require(all(isinstance(value, str) and value for value in suffixes), 'Invalid artist entry ID')
        require(len(set(suffixes)) == len(suffixes), 'Repeated specimen in artist')
        require('c' not in row or row['c'] in suffixes, 'Invalid canonical artist entry')
        for suffix in suffixes:
            entry_id = ID_PREFIX + suffix
            require(entry_id not in used, 'A specimen belongs to multiple artists')
            used.add(entry_id)
            entry = entries.get(entry_id)
            require(entry is not None and entry.get('path', [])[:1] == [SECTION] and entry_cover(entry),
                    'Missing or unrelated source specimen: ' + entry_id)
        rank = row.get('r')
        require(rank is None or type(rank) is int and rank > 0, 'Invalid recognition rank')
        if rank is not None:
            require(row.get('s') in suffixes and isinstance(row.get('t'), str) and row['t'],
                    'Recognition rank lacks its exact v5 specimen')
        else:
            require('s' not in row and 't' not in row, 'Unscored artist has recognition metadata')
        post = row.get('p')
        require(post is None or type(post) is int and post >= 0, 'Invalid post count')
    for g, group in enumerate(groups):
        require(type(group.get('size')) is int and group['size'] == sizes[g], 'Group size mismatch')
        for key in ('reps', 'famous'):
            choices = group.get(key, [])
            require(isinstance(choices, list) and len(choices) == len(set(choices))
                    and all(index(i, len(artists)) and artists[i]['g'] == g for i in choices),
                    'Invalid group representative')
    for p, parent in enumerate(parents):
        require(type(parent.get('size')) is int and parent['size'] == sum(sizes[g] for g in parent['groups']),
                'Parent size mismatch')
        choices = parent.get('showcase', [])
        require(isinstance(choices, list) and len(choices) == len(set(choices))
                and all(index(i, len(artists)) and groups[artists[i]['g']]['parent'] == p for i in choices),
                'Invalid parent representative')
    if near is not None:
        require(isinstance(near, list) and len(near) == len(artists), 'Neighbor row count mismatch')
        for own, neighbors in enumerate(near):
            require(isinstance(neighbors, list) and len(neighbors) <= NEAR
                    and all(index(i, len(artists)) and i != own for i in neighbors)
                    and len(neighbors) == len(set(neighbors)), 'Invalid neighbor indices')
    current_paths = set(routes(data).values())
    aliases = data.get('pathAliases', [])
    require(isinstance(aliases, list), 'Path aliases must be an array')
    alias_map = {}
    codes = {}
    for path in [(SECTION,), (SECTION, '未归类'), *current_paths]:
        require(codes.setdefault(short_code(path), path) == path, 'Category short-code collision')
    for alias in aliases:
        old, new = alias.get('from'), alias.get('to')
        require(isinstance(old, list) and isinstance(new, list) and len(old) in (2, 3)
                and len(old) == len(new) and old[0] == SECTION
                and all(isinstance(part, str) and part and part.strip() == part for part in old + new),
                'Malformed old category alias')
        old, new = tuple(old), tuple(new)
        require(new in current_paths and alias_map.setdefault(old, new) == new, 'Invalid alias destination')
        require(codes.setdefault(short_code(old), new) == new, 'Old category short-code collision')
    return used


def entry_cover(entry):
    """Match normalizeEntry's primary image after normalizeImageList."""
    if entry.get('image'):
        return entry['image']
    for image in entry.get('images') or []:
        if isinstance(image, str) and image:
            return image
        if isinstance(image, dict):
            path = image.get('path') or image.get('image') or image.get('url') or image.get('src')
            if path:
                return path
    return entry.get('original') or ''


def fingerprint_book(book):
    rows = [[entry['id'], entry['path'], entry_cover(entry), entry.get('rating') or 'safe',
             strip_nai_default_suffix(entry.get('tags') or entry.get('rawTags') or '')]
            for entry in book['entries'] if entry.get('path', [])[:1] == [SECTION]]
    rows.sort(key=lambda row: row[0])
    return hashlib.sha256(json_bytes(rows)).hexdigest()


def specimen_source_rank(entry):
    path = entry.get('path', [])
    source = path[1] if isinstance(path, list) and len(path) > 1 else ''
    if not isinstance(source, str):
        return len(SPECIMEN_SOURCE_ORDER)
    source = re.sub(r'\s*[（(]无原图[）)]\s*$', '', source.strip()).strip()
    return SPECIMEN_SOURCE_ORDER.index(source) if source in SPECIMEN_SOURCE_ORDER else len(SPECIMEN_SOURCE_ORDER)


def reorder_specimens(data, book):
    """Return e/x in source order; keep canonical names, tied sources and scores.

    The caller recomputes nearRevision with the unchanged neighbor rows before
    writing, because the revision also binds the ordered representative IDs.
    """
    if data.get('schema') == 3:
        validate_style_data(data, book)
    else:
        validate_data(data, None, book)
    entries = {entry['id']: entry for entry in book['entries']}
    updated = copy.deepcopy(data)
    prefix = data['idPrefix']
    for row in updated['artists']:
        canonical = row.get('c', row['e'])
        specimens = [row['e'], *row.get('x', [])]
        specimens.sort(key=lambda suffix: specimen_source_rank(entries[prefix + suffix]))
        row['e'] = specimens[0]
        if len(specimens) > 1 or 'x' in row:
            row['x'] = specimens[1:]
        if 'c' in row or row['e'] != canonical:
            row['c'] = canonical
    return updated


def validate_style_data(data, book, near_shards=None):
    """Validate release data; optional shards are raw bytes in numeric order."""
    try:
        require(data.get('schema') == 3, 'Artist-style release data must use schema 3')
        require(data.get('sourceFingerprint') == fingerprint_book(book),
                'Artist styles were built for a different source book; rebuild before publishing')
        revision = data.get('nearRevision', '')
        require(isinstance(revision, str) and re.fullmatch(r'[0-9a-f]{16}', revision),
                'Invalid neighbor revision')
        near = None
        if near_shards is not None:
            size = data['nearShard']
            require(type(size) is int and 1 <= size <= 4096, 'Invalid neighbor shard size')
            count = (len(data['artists']) + size - 1) // size
            require(isinstance(near_shards, (tuple, list)) and len(near_shards) == count,
                    'Missing or unexpected neighbor shard')
            decoded = [json.loads(chunk) for chunk in near_shards]
            require(all(isinstance(chunk, list) for chunk in decoded), 'Neighbor shard must be an array')
            near = [row for chunk in decoded for row in chunk]
            canonical, expected = chunks_and_revision(data, near)
            require(list(near_shards) == canonical and revision == expected,
                    'Neighbor shards do not match this root')
        return validate_data(data, near, book)
    except (KeyError, TypeError, AttributeError, IndexError) as exc:
        raise ValueError('Malformed artist-style data: ' + str(exc)) from None


def chunks_and_revision(data, near):
    size = data['nearShard']
    chunks = [json_bytes(near[start:start + size]) for start in range(0, len(near), size)]
    revision = hashlib.sha256(json_bytes([row['e'] for row in data['artists']]) + b''.join(chunks)).hexdigest()[:16]
    return chunks, revision


def read_snapshot(path):
    data = read_json(path)
    revision = data.get('nearRevision', '')
    require(isinstance(revision, str) and re.fullmatch(r'[0-9a-f]{16}', revision), 'Invalid neighbor revision')
    require(isinstance(data.get('artists'), list) and data['artists'], 'Snapshot has no artists')
    size = data.get('nearShard')
    require(type(size) is int and 1 <= size <= 4096, 'Invalid neighbor shard size')
    count = (len(data['artists']) + size - 1) // size
    folder = path.parent / 'artist_styles_near' / revision
    chunks = [(folder / (str(i) + '.json')).read_bytes() for i in range(count)]
    near = [row for chunk in chunks for row in json.loads(chunk)]
    canonical, expected = chunks_and_revision(data, near)
    require(chunks == canonical and revision == expected, 'Neighbor shards do not match this root')
    return data, near


def load_inputs(path):
    config = read_json(path)
    inputs = {}
    for key in ('book', 'tableDir', 'pilotDir', 'research', 'postLookupDir', 'names'):
        value = config.get(key)
        require(isinstance(value, str) and value.strip(), 'Missing build input: ' + key)
        item = Path(value)
        inputs[key] = item if item.is_absolute() else (path.parent / item).resolve()
    inputs['integrityKeys'] = config.get('integrityKeys', {})
    require(all(isinstance(inputs['integrityKeys'].get(key), str) and inputs['integrityKeys'][key]
                for key in ('book', 'research')), 'Missing frozen input integrity keys')
    return inputs


def write_data(out_path, data, near, check_inputs=None):
    """Write immutable shards first and atomically replace the root last."""
    chunks, revision = chunks_and_revision(data, near)
    data = copy.deepcopy(data)
    data['nearRevision'] = revision
    raw = json_bytes(data)
    previous = out_path.read_bytes() if out_path.exists() else None
    if check_inputs:
        check_inputs()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    near_dir = out_path.parent / 'artist_styles_near'
    near_dir.mkdir(exist_ok=True)
    target = near_dir / revision
    staged = near_dir / ('.' + revision + '.' + uuid.uuid4().hex + '.tmp')
    staged.mkdir()
    main_file = out_path.with_name('.' + out_path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        for i, chunk in enumerate(chunks):
            (staged / (str(i) + '.json')).write_bytes(chunk)
        try:
            staged.rename(target)
        except OSError:
            if not target.exists():
                raise
            expected_files = {str(i) + '.json' for i in range(len(chunks))}
            require({p.name for p in target.iterdir()} == expected_files
                    and all((target / (str(i) + '.json')).read_bytes() == chunk for i, chunk in enumerate(chunks)),
                    'Existing immutable neighbor revision has changed')
        with main_file.open('xb') as stream:
            stream.write(raw)
        if check_inputs:
            check_inputs()
        require((out_path.read_bytes() if out_path.exists() else None) == previous,
                'Artist-style root changed while building')
        main_file.replace(out_path)
    finally:
        main_file.unlink(missing_ok=True)
        if staged.exists():
            for i in range(len(chunks)):
                (staged / (str(i) + '.json')).unlink(missing_ok=True)
            staged.rmdir()
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--config', type=Path, help='Local input-path JSON, relative paths resolve beside the config')
    mode.add_argument('--snapshot', type=Path, help='Previously reviewed root plus versioned neighbor directory')
    mode.add_argument('--check', action='store_true', help='Check existing release data; missing root is optional')
    mode.add_argument('--reorder-specimens', action='store_true', help='Reorder examples/covers in the existing --out root')
    parser.add_argument('--book', type=Path, help='v5 source book for snapshot/check/reorder validation')
    parser.add_argument('--names', type=Path, help='Reviewed naming overlay, overrides config names')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--apply', action='store_true', help='Write local data (default: validate/plan only)')
    args = parser.parse_args(argv)
    require(__debug__, 'Run without Python optimization: frozen input checks must be enabled')
    if args.check:
        require(not args.apply and not args.names, '--check cannot rename or write data')
        if not args.out.exists():
            print(json.dumps({'result': 'SKIP', 'reason': 'Artist-style root is absent; legacy release remains supported'}))
            return 0
        data, near = read_snapshot(args.out)
        book = read_json(args.book or DEFAULT_BOOK)
        chunks, _ = chunks_and_revision(data, near)
        used = validate_style_data(data, book, chunks)
        print(json.dumps({'result': 'PASS', 'artists': len(data['artists']), 'entries': len(used),
                          'nearShards': len(chunks), 'sourceFingerprint': data['sourceFingerprint']}))
        return 0
    original_root = None
    before_artists = None
    if args.reorder_specimens:
        require(args.names is None, '--reorder-specimens cannot also rename categories')
        book_path = args.book or DEFAULT_BOOK
        original_book = book_path.read_bytes()
        original_root = args.out.read_bytes()
        data, near = read_snapshot(args.out)
        validate_style_data(data, json.loads(original_book), chunks_and_revision(data, near)[0])
        before_artists = data['artists']
        data = reorder_specimens(data, json.loads(original_book))
        names_path = None
    elif args.snapshot:
        book_path = args.book or DEFAULT_BOOK
        original_book = book_path.read_bytes()
        data, near = read_snapshot(args.snapshot)
        names_path = args.names
    else:
        require(args.book is None, '--book applies only to snapshot mode; set book in the config')
        inputs = load_inputs(args.config or DEFAULT_CONFIG)
        book_path = inputs['book']
        original_book = book_path.read_bytes()
        data, near = build_data(inputs)
        names_path = args.names or inputs['names']
    if names_path:
        data = apply_labels(data, read_json(names_path))
    book = json.loads(original_book)
    if data.get('schema') == 3:
        validate_style_data(data, book)
    else:
        require(data.get('schema') == 2, 'Only reviewed schema 2 or 3 snapshots are supported')
        data['schema'] = 3
        data['sourceFingerprint'] = fingerprint_book(book)
    chunks, revision = chunks_and_revision(data, near)
    data['nearRevision'] = revision
    used = validate_style_data(data, book, chunks)
    def check_book():
        require(book_path.read_bytes() == original_book, 'Source book changed while building')
        if original_root is not None:
            require(args.out.read_bytes() == original_root, 'Artist-style root changed while reordering')
    check_book()
    if args.apply:
        data = write_data(args.out, data, near, check_inputs=check_book)
    else:
        data['nearRevision'] = revision
    summary = {'applied': args.apply, 'artists': len(data['artists']), 'entries': len(used),
        'parents': len(data['parents']), 'groups': len(data['groups']), 'aliases': len(data.get('pathAliases', [])),
        'nearShards': len(chunks), 'nearRevision': revision, 'sha256': hashlib.sha256(json_bytes(data)).hexdigest(),
        'out': str(args.out)}
    if before_artists is not None:
        summary['representativesChanged'] = sum(old['e'] != new['e'] for old, new in zip(before_artists, data['artists']))
        summary['specimensReordered'] = sum(old != new for old, new in zip(before_artists, data['artists']))
    print(json.dumps(summary, ensure_ascii=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, AssertionError, KeyError, TypeError) as exc:
        raise SystemExit('Artist-style build failed: ' + str(exc)) from None
