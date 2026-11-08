#!/usr/bin/env python3
"""Discover rights-documented Commons sports videos and ingest browser-ready test media.
Standard library only; requires ffmpeg/ffprobe. Never downloads standard-license YouTube.
"""
import argparse
import concurrent.futures
import hashlib
import html
import json
import os
from pathlib import Path
import re
import subprocess
import shutil
import time
import threading
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
DIST = ROOT / 'dist'
CACHE = ROOT / '.cache' / 'open'
MANIFEST = ROOT / 'open-sources.json'
API = 'https://commons.wikimedia.org/w/api.php'
CONTACT = os.environ.get('MEDIA_CONTACT', '').strip()
UA = f'SportlightDatasetBot/1.0 ({CONTACT or "local open sports test collection"})'
NETWORK_LOCK = threading.Lock()
NEXT_REQUEST = {}
HOST_SLOTS = {}
MEDIA_LOCK = threading.Lock()
MEDIA_NEXT = 0.0
YOUTUBE_SLOTS = threading.BoundedSemaphore(3)
QUERIES = {
    'football': ['"football"', '"soccer"'],
    'basketball': ['"basketball"', '"basketball" "game"'],
    'tennis': ['"tennis"', '"Davis Cup"'],
    'motorsport': ['"racing"', '"rally"'],
    'ice-hockey': ['"ice hockey"', '"hockey"'],
    'cycling': ['"cycling"', '"bicycle" "race"'],
    'rugby': ['"rugby"', '"rugby" "match"'],
    'athletics': ['"athletics"', '"track and field"'],
    'chess': ['"chess"', '"chess" "blitz"'],
    'esports': ['"esports"', '"Counter Strike"'],
}


def plain(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub('<[^>]+>', ' ', s or ''))).strip()


class DownloadResponse:
    def __init__(self, response, slot):
        self.response, self.slot = response, slot

    def __enter__(self):
        return self.response

    def __exit__(self, *args):
        try:
            self.response.close()
        finally:
            self.slot.release()


def request(url, headers=None):
    host = urllib.parse.urlparse(url).hostname
    if host and host.endswith('wikimedia.org') and not CONTACT:
        raise ValueError('Set MEDIA_CONTACT to a public project URL or contact email for Wikimedia bulk downloads')
    cooldown_file = CACHE / 'network-cooldowns.json'
    with NETWORK_LOCK:
        limit = 2 if host == 'upload.wikimedia.org' else (1 if host.endswith('wikimedia.org') else 3)
        slot = HOST_SLOTS.setdefault(host, threading.BoundedSemaphore(limit))
    slot.acquire()
    while True:
        with NETWORK_LOCK:
            cooldowns = json.loads(cooldown_file.read_text()) if cooldown_file.exists() else {}
            now = time.time()
            ready_at = max(NEXT_REQUEST.get(host, 0), cooldowns.get(host, 0))
            if now >= ready_at:
                NEXT_REQUEST[host] = now + (10 if host == 'upload.wikimedia.org' else 3)
                break
            delay = ready_at - now
        time.sleep(min(delay, 3))
    try:
        response = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})}), timeout=90)
        return DownloadResponse(response, slot)
    except urllib.error.HTTPError as ex:
        slot.release()
        if ex.code in (429, 503):
            retry = ex.headers.get('Retry-After', '60')
            delay = max(60, int(retry) if retry.isdigit() else 60)
            with NETWORK_LOCK:
                cooldowns = json.loads(cooldown_file.read_text()) if cooldown_file.exists() else {}
                cooldowns[host] = time.time() + delay
                cooldown_file.write_text(json.dumps(cooldowns))
            print(f'[network] {host}: HTTP {ex.code}; backing off {delay}s (preserved across restarts)', flush=True)
        raise
    except BaseException:
        slot.release()
        raise


def pace_media(size):
    # Wikimedia permits at most 25 Mbps over 10-second intervals; keep below that.
    global MEDIA_NEXT
    with MEDIA_LOCK:
        now = time.monotonic()
        delay = max(0, MEDIA_NEXT - now)
        MEDIA_NEXT = max(now, MEDIA_NEXT) + size / (2.5 * 1024 ** 2)
    time.sleep(delay)


def api(params):
    query_cache = CACHE / 'queries'
    query_cache.mkdir(parents=True, exist_ok=True)
    cache_file = query_cache / (hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest() + '.json')
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < 86400:
        return json.loads(cache_file.read_text())
    for attempt in range(8):
        try:
            with request(API + '?' + urllib.parse.urlencode({'format': 'json', **params})) as r:
                data = json.load(r)
            if 'error' in data:
                raise RuntimeError(str(data['error']))
            cache_file.write_text(json.dumps(data))
            time.sleep(4)
            return data
        except ValueError:
            raise
        except Exception as ex:
            if attempt == 7:
                raise
            print(f'[discover] retrying API after {ex}', flush=True)
            time.sleep(min(60, 10 * (attempt + 1)))


def approved(m):
    """Accept explicit CC0, CC BY or public-domain declarations; no NC/ND/SA licenses."""
    name = plain(m.get('LicenseShortName', {}).get('value', ''))
    url = m.get('LicenseUrl', {}).get('value', '')
    if name == 'CC0' and re.match(r'https?://creativecommons.org/publicdomain/zero/1\.0/?$', url):
        return name, url
    if re.fullmatch(r'CC BY (1\.0|2\.0|2\.5|3\.0|4\.0)', name) and re.match(
        r'https?://creativecommons.org/licenses/by/(1\.0|2\.0|2\.5|3\.0|4\.0)/?$', url
    ):
        return name, url
    if name == 'Public domain' and m.get('Copyrighted', {}).get('value') == 'False':
        return name, url or 'https://commons.wikimedia.org/wiki/Commons:Public_domain'
    return None


def discover(per_sport):
    seen = set()
    clips = []
    rejected = []
    for sport, queries in QUERIES.items():
        candidates = []
        for query in queries:
            data = api({'action': 'query', 'generator': 'search', 'gsrsearch': query + ' filetype:video',
                        'gsrnamespace': 6, 'gsrlimit': 50, 'prop': 'imageinfo',
                        'iiprop': 'url|extmetadata|size|sha1', 'maxlag': 5})
            for p in sorted(data.get('query', {}).get('pages', {}).values(), key=lambda p: p.get('index', 0)):
                i = p.get('imageinfo', [{}])[0]
                m = i.get('extmetadata', {})
                license = approved(m)
                reason = None
                if not license:
                    reason = 'license not in CC0 / CC BY / public domain allowlist'
                elif not 20 <= i.get('duration', 0) <= 1800:
                    reason = 'duration outside 20 seconds–30 minutes'
                elif min(i.get('width', 0), i.get('height', 0)) < 360 or i.get('size', 0) > 400 * 1024 ** 2:
                    reason = 'resolution too small or download exceeds 400 MiB'
                elif re.search(r'interview|press conference|speech|ceremony|trailer|anthem|video game|animation|simulation|highlights reel', p['title'], re.I):
                    reason = 'title indicates non-action footage'
                text = plain(p['title'] + ' ' + m.get('ImageDescription', {}).get('value', '')).lower()
                terms = {'football': r'football|soccer', 'basketball': r'basketball', 'tennis': r'tennis|davis cup', 'motorsport': r'formula|rally|motorsport|kart|motor racing|auto racing|car racing|grand prix|motorcycle', 'ice-hockey': r'ice hockey|ice-hockey|hockey', 'cycling': r'cycling|bicycle|cyclist', 'rugby': r'rugby', 'athletics': r'athletic|track and field|sprint|hurdle|relay|marathon|running', 'chess': r'chess', 'esports': r'esport|counter.strike|dota|league of legends|starcraft'}
                if not re.search(terms[sport], text):
                    reason = 'sport not confirmed in title or description'
                if sport == 'football' and re.search(r'american football|nfl|super bowl', text):
                    reason = 'American football is not association football'
                if sport == 'tennis' and re.search(r'table tennis|ping.pong', text):
                    reason = 'table tennis is not court tennis'
                if reason:
                    rejected.append({'title': p['title'], 'sportId': sport, 'reason': reason})
                    continue
                if p['pageid'] in seen:
                    continue
                seen.add(p['pageid'])
                candidates.append({'id': f"open-{sport}-{p['pageid']}", 'sportId': sport,
                                   'title': p['title'][5:], 'pageId': p['pageid'],
                                   'sourceUrl': i['descriptionurl'], 'downloadUrl': i['url'].split('?')[0],
                                   'sourceSha1': i['sha1'], 'sourceBytes': i['size'],
                                   'durationSec': i['duration'], 'width': i['width'], 'height': i['height'],
                                   'author': plain(m.get('Artist', {}).get('value', 'Unknown creator')),
                                   'license': license[0], 'licenseUrl': license[1],
                                   'restrictions': plain(m.get('Restrictions', {}).get('value', '')),
                                   'description': plain(m.get('ImageDescription', {}).get('value', '')),
                                   'metadata': m})
            time.sleep(0.25)
        # Prefer action-length landscape footage, with a mix of independent source files.
        candidates.sort(key=lambda c: (c['width'] >= c['height'], min(c['durationSec'], 300)), reverse=True)
        chosen = candidates[:per_sport]
        clips.extend(chosen)
        print(f"[discover] {sport}: {len(chosen)} selected / {len(candidates)} eligible", flush=True)
    manifest = {'version': 1, 'discoveredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'policy': 'Explicit CC0, CC BY or public domain metadata only. No standard YouTube, NC, ND or SA.',
                'clips': clips, 'rejected': rejected}
    MANIFEST.write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def run(args):
    try:
        return subprocess.check_output(args, stderr=subprocess.PIPE).decode()
    except subprocess.CalledProcessError as ex:
        raise RuntimeError(f'{args[0]} failed: {ex.stderr.decode(errors="replace")[-3000:]}') from ex


def probe(path):
    return json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)]))


def ffmpeg(args):
    run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', *map(str, args)])


def validate_primary(c, info):
    if not re.fullmatch(r'Creative Commons Attribution(?: license \(reuse allowed\))?', info.get('license', '').strip(), re.I):
        raise ValueError('Primary YouTube source does not currently declare a Creative Commons license')
    if abs(float(info.get('duration', 0)) - c['durationSec']) > 2:
        raise ValueError('Primary source duration differs from the selected recording')


def ingest(c):
    if not approved(c['metadata']):
        raise ValueError('Source no longer matches license allowlist')
    id = c['id']
    state = DIST / '.state' / (id + '.json')
    key = hashlib.sha256(json.dumps({'sha1': c['sourceSha1'], 'version': 1}, sort_keys=True).encode()).hexdigest()
    if state.exists():
        previous = json.loads(state.read_text())
        e = previous['entry']
        if previous['hash'] == key and all((DIST / e[k]).exists() for k in ['video', 'poster']):
            return e
    disk = os.statvfs(ROOT)
    if disk.f_bavail * disk.f_frsize < 4 * 1024 ** 3 + c['sourceBytes'] * 3:
        raise RuntimeError('Keeping 4 GiB free-space reserve')
    if c.get('youtubeSource'):
        downloader = os.environ.get('YT_DLP') or (str(ROOT / '.tools/bin/yt-dlp') if (ROOT / '.tools/bin/yt-dlp').exists() else shutil.which('yt-dlp'))
        if not downloader:
            raise RuntimeError('This source needs yt-dlp[default]; set YT_DLP or install yt-dlp')
        info_file = CACHE / (id + '.primary.json')
        source = CACHE / (id + '.mp4')
        common = [downloader, '--ignore-config', '--no-playlist', '--js-runtimes', 'node', '--remote-components', 'ejs:github', '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3']
        with YOUTUBE_SLOTS:
            info = json.loads(info_file.read_text()) if info_file.exists() else json.loads(run([*common, '--skip-download', '--dump-single-json', c['youtubeSource']]))
            validate_primary(c, info)
            info_file.write_text(json.dumps(info))
            if not source.exists():
                run([*common, '--format', 'bestvideo[vcodec^=avc1][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]', '--merge-output-format', 'mp4', '--max-filesize', '400M', '--no-progress', '--output', str(CACHE / (id + '.%(ext)s')), c['youtubeSource']])
        c = {**c, 'downloadUrl': c['youtubeSource'], 'alternateSource': c['youtubeSource'], 'primaryLicenseEvidence': {k: info.get(k) for k in ['id', 'title', 'channel', 'uploader', 'license', 'duration', 'webpage_url']}}
    else:
        source = CACHE / (id + Path(urllib.parse.unquote(c['downloadUrl'])).suffix)
    if not source.exists():
        if os.statvfs(ROOT).f_bavail * os.statvfs(ROOT).f_frsize < 4 * 1024 ** 3 + c['sourceBytes'] * 3:
            raise RuntimeError('Keeping 4 GiB free-space reserve')
        temp = source.with_suffix(source.suffix + '.part')
        for attempt in range(4):
            try:
                offset = temp.stat().st_size if temp.exists() else 0
                with request(c['downloadUrl'], {'Range': f'bytes={offset}-'} if offset else {}) as r:
                    mode = 'ab' if offset and r.status == 206 else 'wb'
                    with temp.open(mode) as f:
                        while block := r.read(1024 * 1024):
                            if urllib.parse.urlparse(c['downloadUrl']).hostname == 'upload.wikimedia.org':
                                pace_media(len(block))
                            f.write(block)
                            if f.tell() > 400 * 1024 ** 2:
                                raise ValueError('Download exceeded limit')
                temp.replace(source)
                break
            except Exception as ex:
                if isinstance(ex, ValueError) or attempt == 3:
                    raise
                time.sleep(2 ** attempt)
    # Verify originals against the API SHA-1. Commons derivatives have no published hash;
    # record their own digest and verify duration against the original metadata.
    sha1 = hashlib.sha1()
    with source.open('rb') as f:
        while block := f.read(1024 * 1024):
            sha1.update(block)
    if not c.get('alternateSource') and not c.get('downloadVariant') and sha1.hexdigest() != c['sourceSha1']:
        source.unlink()
        if c.get('commonsDownloadUrl') and c['commonsDownloadUrl'] != c['downloadUrl']:
            print(f'[source] {id}: archive bytes differ; fetching the declared Commons original', flush=True)
            return ingest({**c, 'downloadUrl': c['commonsDownloadUrl']})
        raise ValueError('Source SHA-1 mismatch')
    downloaded_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    original = probe(source)
    if abs(float(original['format']['duration']) - c['durationSec']) > 2:
        raise ValueError('Downloaded duration differs from source metadata')
    video = next(s for s in original['streams'] if s['codec_type'] == 'video')
    audio = any(s['codec_type'] == 'audio' for s in original['streams'])
    name = f'{id}-{key[:10]}.mp4'
    target = DIST / 'videos' / name
    temp = target.with_suffix('.tmp.mp4')
    # Preserve native speed and cadence; cap resolution without upscaling. Real audio only.
    ffmpeg(['-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-vf',
            "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-threads', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', temp])
    result = probe(temp)
    v = next(s for s in result['streams'] if s['codec_type'] == 'video')
    duration = float(result['format']['duration'])
    if abs(duration - float(original['format']['duration'])) > 1:
        raise ValueError('Duration changed during encoding')
    temp.replace(target)
    poster = f'posters/{id}.jpg'
    ffmpeg(['-ss', min(5, duration / 4), '-i', target, '-frames:v', '1', '-vf', 'scale=640:-2', DIST / poster])
    thumbs = DIST / 'thumbs' / id
    thumbs.mkdir(exist_ok=True)
    ffmpeg(['-i', target, '-vf', 'fps=1/10,scale=320:-2', '-start_number', '0', thumbs / '%d.jpg'])
    e = {'id': id, 'sportId': c['sportId'], 'video': 'videos/' + name, 'poster': poster,
         'durationSec': duration, 'width': v['width'], 'height': v['height'], 'fps': v['avg_frame_rate'],
         'hasAudio': audio, 'synthetic': False, 'startOffsetSec': 0, 'dataset': 'commons-open-v1',
         'event': {'title': re.sub(r'\.(webm|ogv|mp4)$', '', c['title'], flags=re.I)[:200],
                   'subtitle': 'Open sports footage · test replay',
                   'broadcaster': {'name': c['author'][:120], 'channel': 'Wikimedia Commons'}},
         'thumbnails': {'template': f'thumbs/{id}/{{index}}.jpg', 'intervalSec': 10, 'count': len(list(thumbs.glob('*.jpg')))},
         'credits': [{k: c[k] for k in ['title', 'author', 'license', 'licenseUrl', 'sourceUrl']}],
         'attributionNotice': 'The appearance of U.S. Department of War (DoW) visual information does not imply or constitute DoW endorsement.' if 'dvidshub.net' in json.dumps(c['metadata']) else '',
         'provenance': {'pageId': c['pageId'], 'sourceSha1': c['sourceSha1'], 'downloadSha256': downloaded_sha256, 'downloadUrl': c['downloadUrl'], 'sourceHashVerified': not bool(c.get('downloadVariant') or c.get('alternateSource')), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                        'restrictions': c['restrictions'], 'changes': 'Transcoded to H.264/AAC MP4; scaled to at most 1280×720; native speed; no trimming.',
                        'evidence': f'rights/{id}.json'}}
    (DIST / 'rights' / (id + '.json')).write_text(json.dumps(c, indent=2) + '\n')
    state.write_text(json.dumps({'hash': key, 'entry': e}, indent=2) + '\n')
    source.unlink()  # output + metadata evidence retained; avoid storing duplicate large originals
    print(f'[ingest] {id}: {duration:.1f}s, {v["width"]}×{v["height"]}, {c["license"]}', flush=True)
    return e


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--discover', action='store_true', help='Refresh the checked-in source manifest')
    parser.add_argument('--discover-only', action='store_true')
    parser.add_argument('--per-sport', type=int, default=12)
    parser.add_argument('--workers', type=int, default=3)
    args = parser.parse_args()
    manifest = discover(args.per_sport) if args.discover or not MANIFEST.exists() else json.loads(MANIFEST.read_text())
    if args.discover_only:
        return
    for d in [CACHE, *(DIST / p for p in ['videos', 'posters', 'thumbs', '.state', 'rights'])]:
        d.mkdir(parents=True, exist_ok=True)
    catalog_path = DIST / 'catalog.json'
    catalog = json.loads(catalog_path.read_text()) if catalog_path.exists() else {'version': 1, 'clips': []}
    entries = {c['id']: c for c in catalog['clips']}
    failures = []
    def publish():
        catalog.update(generatedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), clips=list(entries.values()))
        temp = catalog_path.with_suffix('.tmp')
        temp.write_text(json.dumps(catalog, indent=2) + '\n')
        temp.replace(catalog_path)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(ingest, c): c for c in manifest['clips']}
        for f in concurrent.futures.as_completed(futures):
            c = futures[f]
            try:
                entries[c['id']] = f.result()
                publish()
            except Exception as ex:
                failures.append({'id': c['id'], 'error': str(ex)})
                print(f'[failed] {c["id"]}: {ex}', flush=True)
    credits = ['# Test media credits', '', 'Preserve these credits and license links when reusing footage.',
               'Open collection: CC0, CC BY or source-declared public domain. Other retained legacy clips have their own licenses.',
               'U.S. government public-domain status can differ outside the United States; other rights may apply.', '',
               'The appearance of U.S. Department of War (DoW) visual information does not imply or constitute DoW endorsement.', '']
    for c in entries.values():
        for credit in c['credits']:
            credits.append(f"- {credit['title']} — {credit['author']} — [{credit['license']}]({credit.get('licenseUrl') or credit['sourceUrl']}) — {credit['sourceUrl']}")
        if c.get('provenance'):
            credits.append('  Changes: ' + c['provenance']['changes'])
    (DIST / 'CREDITS.md').write_text('\n'.join(credits) + '\n')
    selected = [c for c in entries.values() if c.get('dataset') == 'commons-open-v1']
    report = {'generatedAt': catalog['generatedAt'], 'totalClips': len(entries), 'openClips': len(selected),
              'openDurationHours': sum(c['durationSec'] for c in selected) / 3600,
              'licenses': {license: sum(c['credits'][0]['license'] == license for c in selected) for license in sorted({c['credits'][0]['license'] for c in selected})},
              'outputGiB': sum((DIST / c['video']).stat().st_size for c in selected) / 1024 ** 3,
              'sports': {s: sum(c.get('sportId') == s for c in selected) for s in QUERIES}, 'failures': failures}
    (ROOT / 'open-dataset-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
