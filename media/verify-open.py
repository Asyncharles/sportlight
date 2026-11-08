#!/usr/bin/env python3
"""Verify ingested open sports files, attribution evidence, browser codecs and derivatives."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
DIST = ROOT / 'dist'
catalog = json.loads((DIST / 'catalog.json').read_text())
manifest = {c['id']: c for c in json.loads((ROOT / 'open-sources.json').read_text())['clips']}
clips = [c for c in catalog['clips'] if c.get('dataset') == 'commons-open-v1']
failures = []
for c in clips:
    try:
        video = DIST / c['video']
        with video.open('rb') as f:
            assert hashlib.file_digest(f, 'sha256').hexdigest() == c['provenance']['sha256'], 'MP4 hash mismatch'
        p = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(video)]))
        v = next(s for s in p['streams'] if s['codec_type'] == 'video')
        audio = [s for s in p['streams'] if s['codec_type'] == 'audio']
        assert v['codec_name'] == 'h264' and v['pix_fmt'] == 'yuv420p', 'browser video codec'
        assert not audio or audio[0]['codec_name'] == 'aac', 'browser audio codec'
        assert bool(audio) == c['hasAudio'], 'incorrect audio flag'
        assert abs(float(p['format']['duration']) - c['durationSec']) < 0.1, 'catalog duration'
        assert c['width'] == v['width'] and c['height'] == v['height'], 'catalog dimensions'
        assert (DIST / c['poster']).stat().st_size > 0, 'missing poster'
        template = c['thumbnails']['template']
        assert c['thumbnails']['count'] > 0, 'no thumbnails'
        for index in range(c['thumbnails']['count']):
            assert (DIST / template.replace('{index}', str(index))).stat().st_size > 0, 'missing thumbnail'
        evidence = json.loads((DIST / c['provenance']['evidence']).read_text())
        assert evidence['sourceSha1'] == manifest[c['id']]['sourceSha1'], 'source identity mismatch'
        assert c['credits'][0]['sourceUrl'] == evidence['sourceUrl'], 'source attribution mismatch'
        assert c['credits'][0]['license'] == evidence['license'], 'license attribution mismatch'
        # Decode actual frames at the start and near the end, beyond metadata validation.
        for at in [0, max(0, c['durationSec'] - 2)]:
            subprocess.check_output(['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(at), '-i', str(video), '-frames:v', '1', '-f', 'null', '-'], stderr=subprocess.STDOUT)
    except Exception as ex:
        failures.append({'id': c['id'], 'error': str(ex)})
report = {'verifiedClips': len(clips), 'missingInCatalog': sorted(set(manifest) - {c['id'] for c in clips}), 'failures': failures}
(ROOT / 'open-verification-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
raise SystemExit(bool(failures or (report['missingInCatalog'] and '--partial' not in sys.argv)))
