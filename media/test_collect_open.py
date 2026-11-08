import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
from email.message import Message


def importer():
    spec = importlib.util.spec_from_file_location('open_media', Path(__file__).with_name('collect-open.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OpenMediaTest(unittest.TestCase):
    def test_license_gate_requires_an_explicit_supported_grant(self):
        m = importer()
        def metadata(name, url='', copyrighted='True'):
            return {'LicenseShortName': {'value': name}, 'LicenseUrl': {'value': url}, 'Copyrighted': {'value': copyrighted}}
        self.assertIsNotNone(m.approved(metadata('CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/')))
        self.assertIsNotNone(m.approved(metadata('Public domain', copyrighted='False')))
        for name, url in [('YouTube standard license', ''), ('CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'), ('CC BY-NC 4.0', ''), ('CC BY-ND 4.0', ''), ('CC BY 4.0', 'https://example.com/license')]:
            self.assertIsNone(m.approved(metadata(name, url)))
        self.assertIsNone(m.approved(metadata('Public domain')))

    def test_wikimedia_requests_require_operator_contact(self):
        m = importer()
        m.CONTACT = ''
        with patch.object(m.urllib.request, 'urlopen') as network:
            with self.assertRaisesRegex(ValueError, 'MEDIA_CONTACT'):
                m.request('https://upload.wikimedia.org/file.webm')
            network.assert_not_called()

    def test_primary_youtube_license_and_recording_are_checked(self):
        m = importer()
        clip = {'durationSec': 300}
        m.validate_primary(clip, {'license': 'Creative Commons Attribution license (reuse allowed)', 'duration': 300})
        for license in ['Standard YouTube License', 'CC BY-NC 4.0', 'CC BY-SA 4.0', '']:
            with self.assertRaises(ValueError):
                m.validate_primary(clip, {'license': license, 'duration': 300})
        with self.assertRaises(ValueError):
            m.validate_primary(clip, {'license': 'Creative Commons Attribution license (reuse allowed)', 'duration': 270})

    def test_server_cooldown_is_honored_after_a_process_restart(self):
        with tempfile.TemporaryDirectory() as d:
            m = importer()
            m.CACHE = Path(d)
            m.CONTACT = 'https://example.org/dataset'
            headers = Message()
            headers['Retry-After'] = '600'
            error = urllib.error.HTTPError('https://upload.wikimedia.org/test', 429, 'rate limited', headers, None)
            with patch.object(m.time, 'time', return_value=100), patch.object(m.urllib.request, 'urlopen', side_effect=error):
                with self.assertRaises(urllib.error.HTTPError):
                    m.request('https://upload.wikimedia.org/test')
            self.assertEqual(json.loads((Path(d) / 'network-cooldowns.json').read_text())['upload.wikimedia.org'], 700)
            # A new import represents a restarted downloader: in-memory scheduling is empty.
            restarted = importer()
            restarted.CACHE = Path(d)
            restarted.CONTACT = 'https://example.org/dataset'
            now = [100]
            def sleep(seconds):
                now[0] += seconds
            def fetch(*args, **kwargs):
                self.assertGreaterEqual(now[0], 700)
                return type('Response', (), {'close': lambda self: None})()
            with patch.object(restarted.time, 'time', side_effect=lambda: now[0]), patch.object(restarted.time, 'sleep', side_effect=sleep), patch.object(restarted.urllib.request, 'urlopen', side_effect=fetch):
                with restarted.request('https://upload.wikimedia.org/test') as response:
                    self.assertIsNotNone(response)


if __name__ == '__main__':
    unittest.main()
