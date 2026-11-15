"""Artist-style data contracts and safe local publication, using synthetic inputs."""

import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_artist_styles as builder
from artist_style_labels import apply_labels, routes


def fixture():
    book = {'entries': [
        {'id': builder.ID_PREFIX + name, 'path': ['单画师词典', source],
         'image': name + '.jpg', 'rating': 'safe'}
        for name, source in [('one', 'MayRain'), ('alias', '雨燕'), ('two', 'MayRain'), ('three', '花枝鱼')]
    ]}
    data = {
        'schema': 3, 'codexId': builder.BOOK_ID, 'idPrefix': builder.ID_PREFIX, 'nearShard': 2,
        'rankModel': 'fixture',
        'parents': [{'name': '日系插画', 'desc': '日系', 'groups': [0], 'size': 2, 'showcase': [0]},
                    {'name': '厚涂插画', 'desc': '厚涂', 'groups': [1], 'size': 1, 'showcase': [2]}],
        'groups': [{'name': '动画平涂', 'desc': '硬边阴影', 'parent': 0, 'size': 2, 'reps': [0], 'famous': [0]},
                   {'name': '半写实厚涂', 'desc': '弱线稿', 'parent': 1, 'size': 1, 'reps': [2], 'famous': []}],
        'artists': [{'e': 'one', 'x': ['alias'], 'p': 10, 'r': 1, 's': 'alias', 't': 'old_name', 'g': 0, 'o': 1},
                    {'e': 'two', 'p': 0, 'r': None, 'g': 0, 'o': 2},
                    {'e': 'three', 'p': None, 'r': 20, 's': 'three', 't': 'another', 'g': 1, 'o': 1}],
        'pathAliases': [{'from': ['单画师词典', '旧日系'], 'to': ['单画师词典', '日系插画']}],
    }
    near = [[1, 2], [0], [0]]
    chunks, revision = builder.chunks_and_revision(data, near)
    data['nearRevision'] = revision
    data['sourceFingerprint'] = builder.fingerprint_book(book)
    return book, data, near, chunks


class StyleContract(unittest.TestCase):
    def test_valid_root_and_shards_preserve_all_specimens(self):
        book, data, _, chunks = fixture()
        self.assertEqual(builder.validate_style_data(data, book, chunks), {e['id'] for e in book['entries']})
        self.assertEqual(builder.validate_style_data(data, book), {e['id'] for e in book['entries']})

    def test_book_fingerprint_ignores_entry_order_and_unrelated_sections(self):
        book, data, _, _ = fixture()
        book['entries'].reverse()
        book['entries'].append({'id': 'group', 'path': ['画风组词典'], 'image': 'other.jpg'})
        self.assertEqual(builder.fingerprint_book(book), data['sourceFingerprint'])
        for key, value in [('image', 'changed.jpg'), ('rating', 'explicit'),
                           ('path', ['单画师词典', '新来源']), ('tags', 'artist:changed')]:
            changed = copy.deepcopy(book)
            changed['entries'][0][key] = value
            self.assertNotEqual(builder.fingerprint_book(changed), data['sourceFingerprint'])
            with self.assertRaisesRegex(ValueError, 'different source book'):
                builder.validate_style_data(data, changed)

    def test_fingerprint_uses_normalized_artist_prompt(self):
        book, _, _, _ = fixture()
        entry = book['entries'][0]
        entry['tags'] = 'artist:one'
        expected = builder.fingerprint_book(book)
        entry['tags'] = 'artist:one, very aesthetic, masterpiece, no text'
        self.assertEqual(builder.fingerprint_book(book), expected)
        entry['rawTags'] = 'artist:one, no text, masterpiece, very aesthetic'
        entry['tags'] = ''
        self.assertEqual(builder.fingerprint_book(book), expected)
        entry['tags'] = 'artist:two'
        self.assertNotEqual(builder.fingerprint_book(book), expected)
        entry['tags'] = 'artist:one, masterpiece'
        self.assertNotEqual(builder.fingerprint_book(book), expected, 'Partial quality tails remain significant')

    def test_fingerprint_and_validation_use_normalized_cover(self):
        book, data, _, chunks = fixture()
        entry = book['entries'][0]
        for images in [['one.jpg'], [None, {}, {'path': 'one.jpg'}], [{'image': 'one.jpg'}],
                       [{'url': 'one.jpg'}], [{'src': 'one.jpg'}]]:
            entry['image'] = ''
            entry['images'] = images
            with self.subTest(images=images):
                self.assertEqual(builder.fingerprint_book(book), data['sourceFingerprint'])
                builder.validate_style_data(data, book, chunks)
        entry['image'] = ''
        entry['images'] = []
        entry['original'] = 'one.jpg'
        self.assertEqual(builder.fingerprint_book(book), data['sourceFingerprint'])
        entry['image'] = 'one.jpg'
        entry['images'] = ['different.jpg']
        self.assertEqual(builder.fingerprint_book(book), data['sourceFingerprint'])

    def test_rejects_invalid_identity_rank_group_and_alias(self):
        book, data, _, chunks = fixture()
        mutations = [
            lambda d: d['artists'][1].update(e='one'),
            lambda d: d['artists'][0].update(s='two'),
            lambda d: d['artists'][0].update(c='two'),
            lambda d: d['artists'][0].update(g=99),
            lambda d: d['parents'][0]['groups'].append(1),
            lambda d: d['groups'][0].update(size=4),
            lambda d: d['groups'][0].update(reps=[2]),
            lambda d: d['groups'][1].update(parent=True),
            lambda d: d['pathAliases'][0].update(to=['单画师词典', '不存在']),
            lambda d: d['pathAliases'][0].update(**{'from': ['单画师词典', '旧日系', '多余一级']}),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(data)
            mutate(changed)
            with self.subTest(data=changed):
                with self.assertRaises(ValueError):
                    builder.validate_style_data(changed, book, chunks)

    def test_rejects_missing_wrong_revision_and_bad_neighbor(self):
        book, data, near, chunks = fixture()
        for bad in [chunks[:-1], [b'[[999],[0]]', *chunks[1:]], [b'[[1,2], [0]]', *chunks[1:]]]:
            with self.assertRaises(ValueError):
                builder.validate_style_data(data, book, bad)
        near[0] = [0]
        changed = copy.deepcopy(data)
        invalid_chunks, changed['nearRevision'] = builder.chunks_and_revision(changed, near)
        with self.assertRaisesRegex(ValueError, 'neighbor indices'):
            builder.validate_style_data(changed, book, invalid_chunks)

    def test_schema_two_is_only_a_migration_input(self):
        book, data, _, chunks = fixture()
        data['schema'] = 2
        del data['sourceFingerprint']
        with self.assertRaisesRegex(ValueError, 'schema 3'):
            builder.validate_style_data(data, book, chunks)

    def test_rename_keeps_old_aliases_and_references(self):
        book, data, _, chunks = fixture()
        overlay = {'expectedPaths': {key: list(path) for key, path in routes(data).items()},
                   'parents': [{'id': 'P00', 'name': '细线日系', 'desc': '细线'},
                               {'id': 'P01', 'name': '厚涂画法', 'desc': '厚涂'}],
                   'groups': [{'id': 'G00', 'name': '日系平涂', 'desc': '硬边阴影'},
                              {'id': 'G01', 'name': '写实厚涂', 'desc': '弱线稿'}]}
        updated = apply_labels(data, overlay)
        self.assertEqual(updated['artists'], data['artists'])
        self.assertEqual(updated['sourceFingerprint'], data['sourceFingerprint'])
        self.assertIn({'from': ['单画师词典', '旧日系'], 'to': ['单画师词典', '细线日系']}, updated['pathAliases'])
        builder.validate_style_data(updated, book, chunks)


class SafePublication(unittest.TestCase):
    def test_root_last_reuse_and_immutable_conflict(self):
        _, data, near, _ = fixture()
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'artist_styles.json'
            out.write_bytes(b'{"old":true}')
            with mock.patch.object(Path, 'replace', side_effect=OSError('controlled failure')):
                with self.assertRaises(OSError):
                    builder.write_data(out, data, near)
            self.assertEqual(out.read_bytes(), b'{"old":true}')
            builder.write_data(out, data, near)
            frozen = out.read_bytes()
            builder.write_data(out, data, near)
            self.assertEqual(out.read_bytes(), frozen)
            shard = out.parent / 'artist_styles_near' / data['nearRevision'] / '0.json'
            shard.write_bytes(b'[]')
            with self.assertRaisesRegex(ValueError, 'immutable'):
                builder.write_data(out, data, near)
            self.assertEqual(out.read_bytes(), frozen)

    def test_concurrent_root_change_is_preserved(self):
        _, data, near, _ = fixture()
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'artist_styles.json'
            out.write_bytes(b'{"old":true}')
            count = 0
            def change_input():
                nonlocal count
                count += 1
                if count == 2:
                    out.write_bytes(b'{"concurrent":true}')
            with self.assertRaisesRegex(ValueError, 'root changed'):
                builder.write_data(out, data, near, check_inputs=change_input)
            self.assertEqual(out.read_bytes(), b'{"concurrent":true}')

    def test_snapshot_plan_writes_nothing_and_apply_migrates_only_contract(self):
        book, data, near, _ = fixture()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            snapshot = base / 'source' / 'artist_styles.json'
            legacy = copy.deepcopy(data)
            legacy['schema'] = 2
            del legacy['sourceFingerprint']
            builder.write_data(snapshot, legacy, near)
            before = snapshot.read_bytes()
            book_file = base / 'book.json'
            book_file.write_bytes(builder.json_bytes(book))
            out = base / 'target' / 'artist_styles.json'
            args = ['--snapshot', str(snapshot), '--book', str(book_file), '--out', str(out)]
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(builder.main(args), 0)
            self.assertFalse(out.parent.exists(), 'Default plan must not create output directories')
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(builder.main([*args, '--apply']), 0)
            migrated, actual_near = builder.read_snapshot(out)
            self.assertEqual(migrated, data)
            self.assertEqual(actual_near, near)
            self.assertEqual(snapshot.read_bytes(), before)

    def test_check_missing_is_optional_and_existing_stale_fails(self):
        book, data, near, _ = fixture()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            out = base / 'artist_styles.json'
            with contextlib.redirect_stdout(io.StringIO()) as result:
                self.assertEqual(builder.main(['--check', '--out', str(out)]), 0)
            self.assertEqual(json.loads(result.getvalue())['result'], 'SKIP')
            builder.write_data(out, data, near)
            book['entries'][0]['image'] = 'changed.jpg'
            source = base / 'book.json'
            source.write_bytes(builder.json_bytes(book))
            with self.assertRaisesRegex(ValueError, 'different source book'):
                builder.main(['--check', '--out', str(out), '--book', str(source)])


class SpecimenOrder(unittest.TestCase):
    def test_shared_source_priority_and_suffixes(self):
        shared = json.loads((Path(__file__).resolve().parent / 'fixtures' / 'artist_specimen_order.json').read_text(encoding='utf-8'))
        self.assertEqual(shared['canonicalOrder'], ['花枝鱼', 'AgIzT', '九七', '雨燕', 'MayRain', 'wwuumm'])
        for source, rank in shared['sourceCases']:
            with self.subTest(source=source):
                self.assertEqual(builder.specimen_source_rank({'path': ['单画师词典', source]}), rank)

    def test_reorder_changes_only_specimen_order_and_keeps_scored_sample(self):
        book, data, near, _ = fixture()
        data['artists'][0]['s'] = 'one'
        original = copy.deepcopy(data)
        updated = builder.reorder_specimens(data, book)
        self.assertEqual(data, original, 'Reordering must not mutate its input')
        self.assertEqual(updated['artists'][0]['e'], 'alias', 'Rain source precedes MayRain even when owner had MayRain')
        self.assertEqual(updated['artists'][0]['x'], ['one'])
        self.assertEqual(updated['artists'][0]['c'], 'one', 'The original canonical entry keeps the displayed name')
        self.assertEqual(updated['artists'][0]['s'], 'one', 'Changing the cover must not change the evaluated image')
        for old, new in zip(original['artists'], updated['artists']):
            self.assertEqual({old['e'], *old.get('x', [])}, {new['e'], *new.get('x', [])})
            self.assertEqual({k: v for k, v in old.items() if k not in ('e', 'x', 'c')},
                             {k: v for k, v in new.items() if k not in ('e', 'x', 'c')})
            canonical = old.get('c', old['e'])
            if 'c' in old or new['e'] != canonical:
                self.assertEqual(new['c'], canonical)
            else:
                self.assertNotIn('c', new)
        for key in data:
            if key != 'artists':
                self.assertEqual(updated[key], data[key])
        chunks, updated['nearRevision'] = builder.chunks_and_revision(updated, near)
        self.assertNotEqual(updated['nearRevision'], original['nearRevision'])
        builder.validate_style_data(updated, book, chunks)
        self.assertEqual(builder.reorder_specimens(updated, book), updated, 'Reordering is idempotent')

    def test_existing_canonical_entry_is_retained_and_must_belong_to_artist(self):
        book, data, _, chunks = fixture()
        data['artists'][0]['c'] = 'alias'
        updated = builder.reorder_specimens(data, book)
        self.assertEqual(updated['artists'][0]['c'], 'alias', 'Existing canonical entry is kept even if it becomes the cover')
        self.assertEqual(builder.reorder_specimens(updated, book), updated)
        for invalid in ('two', '', None):
            data['artists'][0]['c'] = invalid
            with self.subTest(c=invalid):
                with self.assertRaisesRegex(ValueError, 'canonical'):
                    builder.validate_style_data(data, book, chunks)

    def test_same_source_order_is_stable_and_unknown_sources_follow_known(self):
        book, data, _, _ = fixture()
        for name, source in [('second', 'MayRain'), ('unknown', '未登记来源')]:
            book['entries'].append({'id': builder.ID_PREFIX + name, 'path': ['单画师词典', source],
                                    'image': name + '.jpg', 'rating': 'safe'})
        data['artists'][0]['e'] = 'unknown'
        data['artists'][0]['x'] = ['second', 'one', 'alias']
        data['sourceFingerprint'] = builder.fingerprint_book(book)
        updated = builder.reorder_specimens(data, book)
        self.assertEqual([updated['artists'][0]['e'], *updated['artists'][0]['x']],
                         ['alias', 'second', 'one', 'unknown'])

    def test_cli_reorder_defaults_to_plan_and_reuses_neighbor_rows(self):
        book, data, near, _ = fixture()
        data['artists'][0]['s'] = 'one'
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'artist_styles.json'
            builder.write_data(root, data, near)
            source = base / 'book.json'
            source.write_bytes(builder.json_bytes(book))
            original_root = root.read_bytes()
            original_shards = {p.relative_to(base): p.read_bytes() for p in base.rglob('*.json')}
            args = ['--reorder-specimens', '--out', str(root), '--book', str(source)]
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(builder.main(args), 0)
            self.assertEqual(root.read_bytes(), original_root)
            self.assertEqual({p.relative_to(base): p.read_bytes() for p in base.rglob('*.json')}, original_shards)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(builder.main([*args, '--apply']), 0)
            updated, after_near = builder.read_snapshot(root)
            self.assertEqual(after_near, near)
            self.assertEqual(updated['artists'][0]['e'], 'alias')
            self.assertEqual(updated['artists'][0]['s'], data['artists'][0]['s'])
            self.assertNotEqual(updated['nearRevision'], data['nearRevision'])
            for path, contents in original_shards.items():
                if path != root.relative_to(base):
                    self.assertEqual((base / path).read_bytes(), contents, 'Existing immutable shards remain untouched')
            builder.validate_style_data(updated, book, builder.chunks_and_revision(updated, near)[0])


if __name__ == '__main__':
    unittest.main()
