from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clean_nai_default_tags as cleaner
from nai_default_tags import strip_nai_default_suffix

TRIPLE = 'very aesthetic, masterpiece, no text'


class DefaultTagsTests(unittest.TestCase):
    def test_shared_boundaries_and_idempotence(self):
        fixtures = Path(__file__).parent / 'fixtures/nai_default_tags.json'
        for case in json.loads(fixtures.read_text(encoding='utf-8')):
            with self.subTest(name=case['name']):
                result = strip_nai_default_suffix(case['input'])
                self.assertEqual(result, case['output'])
                self.assertEqual(strip_nai_default_suffix(result), result)

    def make_workspace(self, root):
        data = root / 'site/data'
        data.mkdir(parents=True)
        (data / 'codexes.json').write_text('[{"id":"sample"},{"id":"jiegou_yuandian"}]', encoding='utf-8')
        sample = {'entries': [{'id': 'sample-1', 'tags': 'artist:a, ' + TRIPLE + ', ' + TRIPLE,
            'rawTags': 'artist:a, ' + TRIPLE, 'negative': TRIPLE,
            'characterPrompts': [{'prompt': TRIPLE, 'negative': TRIPLE}],
            'note': TRIPLE, 'images': [{'path': 'a.png', 'rawTag': 'artist:b, ' + TRIPLE,
                                     'rawTags': 'artist:b, ' + TRIPLE, 'negative': TRIPLE}],
            'assetRev': 'unchanged'}], 'note': TRIPLE}
        # BOM, CRLF, escaped Unicode and unusual layout must survive unchanged.
        before = b'\xef\xbb\xbf' + json.dumps(sample, ensure_ascii=True, indent=4).replace('\n', '\r\n').encode('utf-8')
        (data / 'sample.json').write_bytes(before)
        (data / 'jiegou_yuandian.json').write_text(json.dumps({'entries': [
            {'id': 'j-1', 'tags': 'artist:c, ' + TRIPLE}]}), encoding='utf-8')
        source = root / '法典源/解构原典-test.docx'
        source.parent.mkdir()
        source.write_bytes(b'unchanged-docx-source')
        return before, source

    def test_plan_does_not_touch_data_or_docx(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            before, source = self.make_workspace(root)
            result = cleaner.run(root, root / 'output', False)
            self.assertEqual(result['counts']['changed_fields'], 5)
            self.assertEqual((root / 'site/data/sample.json').read_bytes(), before)
            self.assertTrue(source.exists())

    def test_apply_has_exact_inverse_and_preserves_other_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            before, source = self.make_workspace(root)
            result = cleaner.run(root, root / 'output', True)
            manifest = Path(result['backup_manifest'])
            self.assertEqual((manifest.parent / 'sample.json').read_bytes(), before)
            self.assertFalse(source.exists())
            self.assertEqual(cleaner.verify(manifest, root)['fields_verified'], 5)
            current = json.loads((root / 'site/data/sample.json').read_bytes().decode('utf-8-sig'))
            entry = current['entries'][0]
            self.assertEqual(entry['tags'], 'artist:a')
            self.assertEqual(entry['negative'], TRIPLE)
            self.assertEqual(entry['characterPrompts'][0]['prompt'], TRIPLE)
            self.assertEqual(entry['note'], TRIPLE)
            self.assertEqual(entry['assetRev'], 'unchanged')
            self.assertEqual(entry['images'][0]['rawTag'], 'artist:b')
            second = cleaner.run(root, root / 'second-plan', False)
            self.assertEqual(second['counts']['changed_fields'], 0)

    def test_partial_failure_rolls_back_all_written_data_and_moved_docx(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            before, source = self.make_workspace(root)
            other = (root / 'site/data/jiegou_yuandian.json').read_bytes()
            original_write = cleaner.atomic_write
            calls = 0

            def fail_second(path, value):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError('simulated replacement failure')
                return original_write(path, value)

            with mock.patch.object(cleaner, 'atomic_write', side_effect=fail_second):
                with self.assertRaisesRegex(OSError, 'simulated'):
                    cleaner.run(root, root / 'output', True)
            self.assertEqual((root / 'site/data/sample.json').read_bytes(), before)
            self.assertEqual((root / 'site/data/jiegou_yuandian.json').read_bytes(), other)
            self.assertEqual(source.read_bytes(), b'unchanged-docx-source')

    def test_tampering_is_rejected_by_verify(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.make_workspace(root)
            result = cleaner.run(root, root / 'output', True)
            path = root / 'site/data/sample.json'
            path.write_bytes(path.read_bytes() + b' ')
            with self.assertRaisesRegex(ValueError, 'changed since apply'):
                cleaner.verify(Path(result['backup_manifest']), root)

    def test_report_cannot_escape_workspace(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.make_workspace(root)
            with self.assertRaisesRegex(ValueError, 'outside workspace'):
                cleaner.run(root, root.parent / 'outside-default-tags', False)


if __name__ == '__main__':
    unittest.main()
