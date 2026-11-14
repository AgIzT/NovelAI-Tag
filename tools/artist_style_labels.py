"""Apply a reviewed set of labels to the existing, frozen artist-style taxonomy."""
import copy
import re

SECTION = '单画师词典'
BANNED = re.compile('唯美|抒情|视效|空间氛围|空气感|灵动|鲜活|通透感|高级感|氛围感')
LABEL = re.compile(r'[\u4e00-\u9fff0-9A-Za-z、＋·]+')

def short_code(path):
    value = 0x811C9DC5
    for byte in '\x1f'.join(path).encode('utf-16le'):
        value = ((value ^ byte) * 0x01000193) & 0xffffffff
    return value

def routes(data):
    result = {}
    for i, parent in enumerate(data['parents']):
        root = (SECTION, parent['name'])
        result[f'P{i:02}'] = root
        for g in parent['groups']:
            result[f'G{g:02}'] = (*root, data['groups'][g]['name'])
    return result

def apply_labels(data, overlay):
    if data['schema'] not in (2, 3) or data['codexId'] != 'artist_nai5_personal':
        raise ValueError('Unexpected artist style taxonomy format')
    original = routes(data)
    if overlay['expectedPaths'] != {key: list(value) for key, value in original.items()}:
        raise ValueError('Rename evidence does not match the current taxonomy')
    updated = copy.deepcopy(data)
    names = set()
    for field, prefix in (('parents', 'P'), ('groups', 'G')):
        rows = overlay[field]
        expected = [f'{prefix}{i:02}' for i in range(len(data[field]))]
        if len(rows) != len(expected) or sorted(row['id'] for row in rows) != expected:
            raise ValueError(f'Missing or unexpected {field} ID')
        for row in rows:
            label, desc = row['name'], row['desc']
            if label != label.strip() or not (2 <= len(label) <= 10) or not LABEL.fullmatch(label) or BANNED.search(label):
                raise ValueError(f"Unclear or invalid title {row['id']}: {label!r}")
            if label in names or label == '未归类':
                raise ValueError(f'Duplicate title: {label!r}')
            if not desc.strip() or len(desc.strip()) > 40:
                raise ValueError(f"Invalid description {row['id']}")
            names.add(label)
            target = updated[field][int(row['id'][1:])]
            target['name'] = label
            target['desc'] = desc.strip()

    new_paths = routes(updated)
    by_code = {}
    pairs = {old: new_paths[key] for key, old in original.items()}
    aliases = [(tuple(item['from']), pairs.get(tuple(item['to']), tuple(item['to']))) for item in data.get('pathAliases', [])]
    aliases.extend((old, new) for old, new in pairs.items() if old != new)
    for lookup, destination in [((SECTION,), (SECTION,)), ((SECTION, '未归类'), (SECTION, '未归类')),
                                *((p, p) for p in new_paths.values()), *aliases]:
        code = short_code(lookup)
        if by_code.setdefault(code, destination) != destination:
            raise ValueError(f'Ambiguous old or current short code for {lookup}')
    updated['pathAliases'] = [{'from': list(old), 'to': list(new)} for old, new in dict(aliases).items()]
    return updated
