import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import codex_update_match as match
import import_suozhang_20260925 as imp


def card(title, path, tags, **extra):
    return {'title': title, 'path': list(path), 'tags': tags, 'isNew': False, **extra}


ARTIST = ['编纂者杂项', '编纂者常用画师组']
OC = ['编纂者杂项', '编纂者OC']


class FrontMatterTests(unittest.TestCase):
    def test_repeated_artist_and_oc_cards_are_removed_only_when_identical(self):
        first = [card('NAI5时期', ARTIST, 'artist:a,', negative='logo,'), card('NAI4.5时期：2', ARTIST, 'artist:b,'),
                 card('编纂者OC(1)', OC, 'girl,'), card('林间散步', ['场景'], 'walk,')]
        later = [card('NAI4.5时期：2', ARTIST, 'artist:b,'), card('编纂者OC(1)', OC, 'girl,'),
                 card('夜景', ['场景'], 'night,')]
        kept, stats = imp.drop_repeated_front_matter(first, later, 'v2')
        self.assertEqual([e['title'] for e in kept], ['夜景'])
        self.assertEqual(stats, {'artistRemoved': 1, 'ocRemoved': 1})

    def test_changed_repeat_blocks_instead_of_guessing(self):
        first = [card('NAI5时期', ARTIST, 'artist:a,', negative='logo,'), card('编纂者OC(1)', OC, 'girl,')]
        with self.assertRaises(ValueError):
            imp.drop_repeated_front_matter(first, [card('NAI5时期', ARTIST, 'artist:a,', negative='text,')], 'v2')
        with self.assertRaises(ValueError):
            imp.drop_repeated_front_matter(first, [card('编纂者OC(1)', OC, 'boy,')], 'v2')


class DuplicateBlockTests(unittest.TestCase):
    RULE = {'drop': ('v2', ('各种涩涩', '多p')), 'keep': ('v3', ('杂项涩涩', '多p')), 'rawItems': 2}

    def test_verbatim_copy_is_dropped_from_the_copy_location(self):
        raw_keep = [card('甲', ['杂项涩涩', '多p'], 'a,'), card('char1', ['杂项涩涩', '多p'], 'girl,')]
        raw_drop = [card('乙', ['各种涩涩', '百合'], 'b,'), card('甲', ['各种涩涩', '多p'], 'a,'),
                    card('char1', ['各种涩涩', '多p'], 'girl,')]
        kept, record = imp.drop_duplicate_block(raw_drop, raw_keep, raw_drop, self.RULE)
        self.assertEqual([e['title'] for e in kept], ['乙'])
        self.assertEqual(record['normalizedDropped'], 2)

    def test_diverged_copy_blocks(self):
        raw_keep = [card('甲', ['杂项涩涩', '多p'], 'a,'), card('丙', ['杂项涩涩', '多p'], 'c,')]
        raw_drop = [card('甲', ['各种涩涩', '多p'], 'a,'), card('丙', ['各种涩涩', '多p'], 'changed,')]
        with self.assertRaises(ValueError):
            imp.drop_duplicate_block(raw_drop, raw_keep, raw_drop, self.RULE)


class StyleCollectionTests(unittest.TestCase):
    RULE = {'part': 'N5-regular', 'path': ['画风搜集'], 'hosts': {'画风1': ('负面', '设置'), '画风2': ('负面', '附带tag')}}

    def test_labels_fold_into_their_style_card(self):
        entries = [
            card('画风1', ['画风搜集'], 'artist:a,\nshiny skin,', isNew=True),
            card('负面', ['画风搜集'], 'lowres,'),
            card('设置', ['画风搜集'], 'Steps:  28\nSampler:  k_euler_ancestral (karras) '),
            card('画风2', ['画风搜集'], 'artist:b,'),
            card('负面', ['画风搜集'], 'blurry,'),
            card('附带tag', ['画风搜集'], 'nsfw,maid,', characterPrompts=[{'label': 'char1', 'prompt': 'girl,'}]),
            card('蛇发异女', ['人外种族'], 'snake,'),
        ]
        folded, record = imp.fold_style_collection(entries, self.RULE)
        self.assertEqual([e['title'] for e in folded], ['画风1', '画风2', '蛇发异女'])
        self.assertEqual(folded[0]['negative'], 'lowres,')
        self.assertEqual(folded[0]['note'], 'Steps: 28 · Sampler: k_euler_ancestral (karras)')
        self.assertEqual(folded[1]['tags'], 'artist:b,\nnsfw,maid,')
        self.assertEqual(folded[1]['characterPrompts'], [{'label': 'char1', 'prompt': 'girl,'}])
        self.assertEqual(record, {'画风1': ['负面', '设置'], '画风2': ['负面', '附带tag']})

    def test_changed_shape_blocks(self):
        entries = [card('画风1', ['画风搜集'], 'artist:a,'), card('负面', ['画风搜集'], 'lowres,')]
        with self.assertRaises(ValueError):
            imp.fold_style_collection(entries, self.RULE)


class AliasTests(unittest.TestCase):
    def test_renamed_section_matches_exactly_without_touching_old_path(self):
        old = [{'id': 'codex_6e699406-0001', 'title': '双人', 'path': ['各种涩涩', '2+girl/+1boy系列', '百合'],
                'tags': 'dup,', 'isNew': False}]
        new = [card('双人', ['各种涩涩', '2+girl/2+boy系列', '百合'], 'dup,')]
        result = match.match_entries(imp.aliased(old, 'suozhang_r18'), new)
        self.assertEqual(result['summary']['methodCounts'], {'exact_fingerprint': 1})
        self.assertEqual(old[0]['path'][1], '2+girl/+1boy系列')

    def test_part_names(self):
        self.assertEqual(imp.part_key('N4.5所长色色NovelAI个人法典（卷三）（2026.9.25版）.docx'), 'N4.5-v3')
        self.assertEqual(imp.part_key('N5所长色色NovelAI个人法典（下）（2026.9.25版）.docx'), 'N5-lower')
        self.assertEqual(imp.part_key('N5所长常规NovelAI个人法典（2026.9.25版）.docx'), 'N5-regular')


if __name__ == '__main__':
    unittest.main()
