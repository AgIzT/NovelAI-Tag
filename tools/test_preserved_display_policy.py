import tempfile
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image
from pack_import_core import sha256_file, validate_asset, write_asset_from_path


class PreservedDisplayPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.jpg'
        self.thumbs = self.root / 'thumbs'
        self.originals = self.root / 'originals'
        self.thumbs.mkdir()
        self.originals.mkdir()
        Image.new('RGB', (832, 1216), (20, 80, 140)).save(self.source)

    def task(self):
        digest = sha256_file(self.source)
        with Image.open(self.source) as image:
            width, height = image.size
        return {
            'sourcePath': str(self.source), 'entryId': 'sample',
            'thumbDir': str(self.thumbs), 'originalDir': str(self.originals),
            'sha256': digest, 'preserveDisplay': True,
            'displayPolicy': {'mode': 'source-jpeg', 'sha256': digest,
                              'width': width, 'height': height},
        }

    def test_frozen_large_jpeg_keeps_bytes_and_validates(self):
        for size in [(832, 1216), (3328, 4864)]:
            with self.subTest(size=size):
                Image.new('RGB', size, (20, 80, 140)).save(self.source)
                task = self.task()
                asset = write_asset_from_path(task)
                entry = {'id': 'sample', **asset}
                policies = {asset['image']: task['displayPolicy']}
                self.assertEqual(sha256_file(self.thumbs / asset['image']), task['sha256'])
                self.assertEqual(sha256_file(self.originals / asset['original']), task['sha256'])
                self.assertEqual(validate_asset(entry, self.thumbs, self.originals,
                                                display_policies=policies), [])
                self.assertIn('sample:thumb_too_large',
                              validate_asset(entry, self.thumbs, self.originals))

    def test_existing_size_limit_is_unchanged(self):
        task = self.task()
        task.pop('displayPolicy')
        with self.assertRaisesRegex(RuntimeError, 'exceeds 1100px'):
            write_asset_from_path(task)
        task['preserveDisplay'] = False
        asset = write_asset_from_path(task)
        self.assertLessEqual(max(asset['imageWidth'], asset['imageHeight']), 1100)

    def test_wrong_hash_or_dimensions_rejected_before_copy(self):
        for key, value in [('sha256', '0' * 64), ('height', 1200), ('mode', 'anything')]:
            with self.subTest(key=key):
                task = self.task()
                task['displayPolicy'][key] = value
                with self.assertRaises(ValueError):
                    write_asset_from_path(task)
                self.assertEqual(list(self.thumbs.iterdir()), [])
                self.assertEqual(list(self.originals.iterdir()), [])

    def test_orientation_and_non_jpeg_require_normal_pipeline(self):
        exif = Image.Exif()
        exif[274] = 6
        Image.new('RGB', (832, 1216)).save(self.source, exif=exif)
        with self.assertRaisesRegex(ValueError, 'orientation'):
            write_asset_from_path(self.task())
        Image.new('RGB', (832, 1216)).save(self.source, format='PNG')
        with self.assertRaisesRegex(ValueError, 'JPEG'):
            write_asset_from_path(self.task())

    def test_tampered_display_or_original_fails_validation(self):
        task = self.task()
        asset = write_asset_from_path(task)
        entry = {'id': 'sample', **asset}
        policies = {asset['image']: task['displayPolicy']}
        for directory, name in [(self.thumbs, asset['image']),
                                (self.originals, asset['original'])]:
            with self.subTest(directory=directory):
                write_asset_from_path(task)
                Image.new('RGB', (832, 1216), (255, 0, 0)).save(directory / name)
                issues = validate_asset(entry, self.thumbs, self.originals,
                                        display_policies=policies)
                self.assertTrue(any('source hash mismatch' in issue for issue in issues))


if __name__ == '__main__':
    unittest.main()
