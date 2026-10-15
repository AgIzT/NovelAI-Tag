import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import codex_update_match as match
import import_suozhang as imp
import suozhang_r18_merge_match as merge


def card(title, path, tags, **extra):
    return {'title': title, 'path': list(path), 'tags': tags, 'isNew': False, **extra}


ARTIST = ['编纂者杂项', '编纂者常用画师组']
OC = ['编纂者杂项', '编纂者OC']


class NamingTests(unittest.TestCase):
    def test_part_names(self):
        self.assertEqual(imp.part_key('N4.5所长色色NovelAI个人法典（卷三）（2026.9.25版）.docx'), 'N4.5-v3')
        self.assertEqual(imp.part_key('N4.5所长色色NovelAI个人法典（卷十二）（2026.12.1版）.docx'), 'N4.5-v12')
        self.assertEqual(imp.part_key('N5所长色色NovelAI个人法典（下）（2026.9.25版）.docx'), 'N5-lower')
        self.assertEqual(imp.part_key('N5所长常规NovelAI个人法典（2026.9.25版）.docx'), 'N5-regular')
        with self.assertRaises(ValueError):
            imp.part_key('所长色色NovelAI个人法典（卷一）.docx')

    def test_word_lock_files_are_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ('N5所长常规NovelAI个人法典（2026.10.13版）.docx', '~$所长常规NovelAI个人法典（2026.10.13版）.docx'):
                (Path(folder) / name).write_bytes(b'')
            self.assertEqual(list(imp.source_files(folder)), ['N5-regular'])

    def test_version_comes_from_file_names(self):
        names = ['N5所长常规NovelAI个人法典（2026.10.13版，一般所长整理）.docx',
                 'N4.5所长常规NovelAI个人法典（2026.10.13版，一般所长整理）.docx']
        self.assertEqual(imp.source_version(names), '2026.10.13')
        self.assertEqual(imp.version_slug('2026.10.3'), '20261003')
        with self.assertRaises(ValueError):
            imp.source_version(names + ['N5所长色色（上）（2026.9.25版）.docx'])

    def test_volume_kinds_cannot_mix(self):
        with self.assertRaises(ValueError):
            imp.ordered_parts({'N4.5-v1': {}, 'N4.5-upper': {}}, 'suozhang_r18')
        self.assertEqual(imp.ordered_parts({'N4.5-v10': {}, 'N4.5-v2': {}}, 'suozhang_r18'), ['N4.5-v2', 'N4.5-v10'])


@mock.patch.object(merge, 'KNOWN_SOURCE_TITLE_CORRECTIONS', ())
class AssembleTests(unittest.TestCase):
    def config(self, parts):
        return {'parts': parts, 'duplicateBlocks': []}

    def test_repeated_front_matter_is_removed_only_when_proven(self):
        regular = {'N4.5-regular': [card('风景', ['场景'], 'sky,')], 'N5-regular': [card('风景', ['场景'], 'sky,')],
                   'N5-upper': [card('甲', ['场景'], 'a,')], 'N5-lower': [card('乙', ['场景'], 'b,')]}
        v1 = [card('NAI5时期', ARTIST, 'artist:a,', negative='logo,'), card('NAI4.5时期：2', ARTIST, 'artist:b,'),
              card('编纂者OC(1)', OC, 'girl,'), card('林间', ['场景'], 'walk,')]
        v2 = [card('NAI4.5时期：2', ARTIST, 'artist:b,'), card('编纂者OC(1)', OC, 'girl,'), card('夜景', ['场景'], 'night,')]
        v3 = [card('NAI4.5时期：2', ARTIST, 'artist:b,'), card('编纂者OC(1)', ['编纂者杂项', '编纂者oc二则'], 'boy,'),
              card('雨天', ['场景'], 'rain,')]
        parts = {**regular, 'N4.5-v1': v1, 'N4.5-v2': v2, 'N4.5-v3': v3}
        config = self.config({'N4.5-regular': {'half': None}, 'N5-regular': {'half': None},
                              'N5-upper': {'half': 'upper'}, 'N5-lower': {'half': 'lower'},
                              'N4.5-v1': {'half': 'upper'}, 'N4.5-v2': {'half': 'upper'}, 'N4.5-v3': {'half': 'lower'}})
        formal = {'suozhang_r18': {'entries': []}}
        sources, stats = imp.assemble(config, {}, parts, formal)
        titles = [e['title'] for e in sources['suozhang_r18']]
        self.assertEqual(titles, ['NAI5时期', 'NAI4.5时期：2', '编纂者OC(1)', '林间', '夜景', '编纂者OC(1)', '雨天'])
        self.assertTrue(stats['suozhang_r18']['frontMatter']['N4.5-v3']['ocKeptAsOwnGroup'])

        changed = {**parts, 'N4.5-v2': [card('NAI5时期', ARTIST, 'artist:a,', negative='text,')]}
        with self.assertRaises(ValueError):
            imp.assemble(config, {}, changed, formal)

    def test_upper_volumes_must_come_first(self):
        parts = {'N4.5-regular': [], 'N5-regular': [], 'N5-upper': [], 'N5-lower': [],
                 'N4.5-v1': [], 'N4.5-v2': []}
        config = self.config({'N4.5-regular': {'half': None}, 'N5-regular': {'half': None},
                              'N5-upper': {'half': 'upper'}, 'N5-lower': {'half': 'lower'},
                              'N4.5-v1': {'half': 'lower'}, 'N4.5-v2': {'half': 'upper'}})
        with self.assertRaises(ValueError):
            imp.assemble(config, {}, parts, {'suozhang_r18': {'entries': []}})


class DuplicateBlockTests(unittest.TestCase):
    def rule(self, items=2):
        return {'drop': {'part': 'v2', 'pathSha256': imp.path_sha(['甲', '多人']), 'depth': 2},
                'keep': {'part': 'v3', 'pathSha256': imp.path_sha(['乙', '多人']), 'depth': 2}, 'rawItems': items}

    def test_verbatim_copy_is_dropped_from_the_copy_location(self):
        keep = [card('一', ['乙', '多人'], 'a,'), card('char1', ['乙', '多人'], 'girl,')]
        drop = [card('别处', ['甲', '其它'], 'b,'), card('一', ['甲', '多人'], 'a,'), card('char1', ['甲', '多人'], 'girl,')]
        kept = imp.drop_duplicate_block(drop, keep, drop, self.rule())
        self.assertEqual([e['title'] for e in kept], ['别处'])

    def test_diverged_copy_blocks(self):
        keep = [card('一', ['乙', '多人'], 'a,'), card('二', ['乙', '多人'], 'c,')]
        drop = [card('一', ['甲', '多人'], 'a,'), card('二', ['甲', '多人'], 'changed,')]
        with self.assertRaises(ValueError):
            imp.drop_duplicate_block(drop, keep, drop, self.rule())

    def test_detection_keeps_the_historical_location(self):
        raw = {'v2': [card('一', ['甲', '多人'], 'a,'), card('二', ['甲', '多人'], 'b,')],
               'v3': [card('一', ['乙', '多人'], 'a,'), card('二', ['乙', '多人'], 'b,'), card('三', ['乙', '其它'], 'c,')]}
        loaded = {key: {'raw': items} for key, items in raw.items()}
        formal = [{'id': 'x-1', 'path': ['乙', '多人'], 'title': '一', 'tags': 'a,'}]
        rules = imp.detect_duplicate_blocks(loaded, ['v2', 'v3'], formal, [])
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]['keep']['part'], 'v3')
        self.assertEqual(rules[0]['drop']['part'], 'v2')
        self.assertEqual(rules[0]['rawItems'], 2)


class StyleCollectionTests(unittest.TestCase):
    RULE = {'part': 'N5-regular', 'path': ['画风搜集'], 'hosts': {'画风1': ['负面', '设置'], '画风2': ['负面', '附带tag']}}

    def test_labels_fold_into_their_style_card(self):
        entries = [
            card('画风1', ['画风搜集'], 'artist:a,\nshiny skin,', isNew=True),
            card('负面', ['画风搜集'], 'lowres,'),
            card('设置', ['画风搜集'], 'Steps:  28\nSampler:  k_euler_ancestral (karras) '),
            card('画风2', ['画风搜集'], 'artist:b,'),
            card('负面', ['画风搜集'], 'blurry,'),
            card('附带tag', ['画风搜集'], 'maid,', characterPrompts=[{'label': 'char1', 'prompt': 'girl,'}]),
            card('画风3', ['画风搜集'], 'artist:c,'),
        ]
        folded = imp.fold_style_collection(entries, self.RULE)
        self.assertEqual([e['title'] for e in folded], ['画风1', '画风2', '画风3'])
        self.assertEqual(folded[0]['negative'], 'lowres,')
        self.assertEqual(folded[0]['note'], 'Steps: 28 · Sampler: k_euler_ancestral (karras)')
        self.assertEqual(folded[1]['tags'], 'artist:b,\nmaid,')
        self.assertEqual(folded[1]['characterPrompts'], [{'label': 'char1', 'prompt': 'girl,'}])

    def test_changed_shape_blocks(self):
        entries = [card('画风1', ['画风搜集'], 'artist:a,'), card('负面', ['画风搜集'], 'lowres,')]
        with self.assertRaises(ValueError):
            imp.fold_style_collection(entries, self.RULE)

    def test_detection_skips_view_variant_titles(self):
        parts = {'N5-regular': [card('画风1', ['画风搜集'], 'a,'), card('负面', ['画风搜集'], 'b,')],
                 'N4.5-v4': [card('背面', ['收录'], 'back,'), card('正面', ['收录'], 'front,')]}
        rules, orphans = imp.detect_style_collections(parts)
        self.assertEqual(rules, [{'part': 'N5-regular', 'path': ['画风搜集'], 'hosts': {'画风1': ['负面']}}])
        self.assertEqual(orphans, [])


class AliasAndHalfTests(unittest.TestCase):
    def test_renamed_section_is_detected_and_matches_exactly(self):
        old = [{'id': 'codex_6e699406-0001', 'title': '双人', 'path': ['各种', '2+girl/+1boy系列', '百合'], 'tags': 'a,'},
               {'id': 'codex_6e699406-0002', 'title': '三人', 'path': ['各种', '2+girl/+1boy系列', '百合'], 'tags': 'b,'},
               {'id': 'codex_6e699406-0003', 'title': '留下', 'path': ['各种', '1girl系列'], 'tags': 'c,'}]
        new = [card('双人', ['各种', '2+girl/2+boy系列', '百合'], 'a,'), card('三人', ['各种', '2+girl/2+boy系列', '百合'], 'b,'),
               card('留下', ['各种', '1girl系列'], 'c,')]
        pairs = imp.detect_aliases(old, new)
        self.assertEqual(pairs, [(('各种', '2+girl/+1boy系列'), ('各种', '2+girl/2+boy系列'))])
        result = match.match_entries(imp.aliased(old, pairs), new)
        self.assertEqual(result['summary']['methodCounts'], {'exact_fingerprint': 3})
        self.assertEqual(old[0]['path'][1], '2+girl/+1boy系列')

    def test_halves_follow_old_id_namespaces(self):
        formal = {'suozhang_r18': {'entries': [
            {'id': 'codex_6e699406-0001', 'title': '甲', 'path': ['上'], 'tags': 'a,'},
            {'id': 'codex_8489ac52-0001', 'title': '乙', 'path': ['下'], 'tags': 'b,'}]}}
        parts = {'N4.5-v1': [card('甲', ['上'], 'a,')], 'N4.5-v2': [card('乙', ['下'], 'b,')],
                 'N4.5-v3': [card('全新', ['新'], 'z,')]}
        halves, _ = imp.assign_halves('suozhang_r18', ['N4.5-v1', 'N4.5-v2', 'N4.5-v3'], parts, formal)
        self.assertEqual(halves, {'N4.5-v1': 'upper', 'N4.5-v2': 'lower', 'N4.5-v3': None})


class RemovalTests(unittest.TestCase):
    def rows(self):
        sources = {book: [] for book in imp.BOOKS}
        sources['suozhang_r18'] = [card('留', ['基础'], 'keep,')]
        sources['suozhang_nai5_r18'] = [card('搬走', ['百合'], 'moved,')]
        removed = [
            {'id': 'r-1', 'title': '附录', 'path': ['附录栏目'], 'tags': 'x,'},
            {'id': 'r-2', 'title': '搬走', 'path': ['基础'], 'tags': 'moved,'},
            {'id': 'r-3', 'title': '消失', 'path': ['基础'], 'tags': 'gone,'},
            {'id': 'r-4', 'title': '有图', 'path': ['附录栏目'], 'tags': 'y,', 'image': 'r-4.jpg'},
        ]
        return imp.classify_removals('suozhang_r18', removed, sources, [])

    def test_reasons(self):
        reasons = {row['id']: (row['reason'], row['imaged']) for row in self.rows()}
        self.assertEqual(reasons, {'r-1': ('sectionGone', False), 'r-2': ('movedTo', False),
                                   'r-3': ('unexplained', False), 'r-4': ('sectionGone', True)})

    def test_only_approved_removals_pass(self):
        rows = self.rows()
        config = {'removals': {'suozhang_r18': {'retiredSections': ['附录栏目'],
                                                'movedTo': {'suozhang_nai5_r18': ['r-2']}}}}
        with self.assertRaises(ValueError):  # pictured entry needs explicit approval
            imp.check_removals(config, 'suozhang_r18', rows)
        config['removals']['suozhang_r18']['approvedImagedIds'] = ['r-4']
        with self.assertRaises(ValueError):  # unexplained removal
            imp.check_removals(config, 'suozhang_r18', rows)
        config['removals']['suozhang_r18']['approvedIds'] = ['r-3']
        imp.check_removals(config, 'suozhang_r18', rows)


class ManualMatchAndDriftTests(unittest.TestCase):
    def test_manual_match_pins_rewritten_card_to_old_id(self):
        old = [{'id': 'b-0070', 'title': '旧无标题', 'path': ['收录'], 'tags': 'a,b,c,'}]
        new = [card('新标题', ['收录'], 'a,b,c,d,')]
        config = {'manualMatches': {'demo': [{'oldId': 'b-0070',
                                              'newSignatureSha256': match.override_signature_sha256(new[0])}]}}
        forced = imp.resolve_manual_matches(config, 'demo', old, new)
        result = match.match_entries(old, new, forced_pairs=forced)
        self.assertEqual(result['matches'][0]['old']['id'], 'b-0070')
        self.assertEqual(result['summary']['methodCounts'], {'manual_override': 1})
        with self.assertRaises(ValueError):  # source text changed since the decision
            imp.resolve_manual_matches(config, 'demo', old, [card('新标题', ['收录'], 'changed,')])

    def test_only_listed_local_edits_pass_replay(self):
        baseline = {'suozhang_r18': {'summary': {'strictReplayPass': False}, 'unmatchedOld': [], 'unmatchedNew': 0,
                                     'drift': [{'id': 'x-1', 'fields': ['tags']}]}}
        self.assertEqual(imp.replay_failures({}, baseline), ['suozhang_r18'])
        config = {'acceptedDrift': {'suozhang_r18': [{'id': 'x-1', 'fields': ['tags']}]}}
        self.assertEqual(imp.replay_failures(config, baseline), [])
        stale = {'acceptedDrift': {'suozhang_r18': [{'id': 'x-1', 'fields': ['tags']}, {'id': 'x-2', 'fields': ['title']}]}}
        self.assertEqual(imp.replay_failures(stale, baseline), ['suozhang_r18'])


class ConfigTests(unittest.TestCase):
    def write(self, value):
        handle = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8')
        json.dump(value, handle, ensure_ascii=False)
        handle.close()
        return Path(handle.name)

    def test_half_rules(self):
        base = {'version': '2026.1.1', 'historical': True, 'outDir': 'output/x'}
        with self.assertRaises(ValueError):
            imp.load_config(self.write({**base, 'parts': {'N4.5-v1': {'half': None}}}))
        with self.assertRaises(ValueError):
            imp.load_config(self.write({**base, 'parts': {'N5-regular': {'half': 'upper'}}}))
        loaded = imp.load_config(self.write({**base, 'parts': {'N4.5-v1': {'half': 'upper'}}}))
        self.assertEqual(loaded['parts']['N4.5-v1']['half'], 'upper')

    def test_shipped_configs_load(self):
        for path in sorted(imp.VERSIONS_DIR.glob('*.json')):
            config = imp.load_config(path)
            if not config.get('historical'):
                self.assertEqual(set(config['expected']), set(imp.BOOKS))

    def test_overrides_install_without_conflict(self):
        config = {'version': '2099.1.1', 'newOverrides': {'demo': {'demo-0001': {'signatureSha256': 'ab', 'isNew': True}}}}
        imp.install_overrides(config)
        imp.install_overrides(config)
        with self.assertRaises(ValueError):
            imp.install_overrides({**config, 'newOverrides': {'demo': {}}})
        match.AUDITED_NEW_OVERRIDES.pop(('demo', '2099.1.1'))


if __name__ == '__main__':
    unittest.main()
