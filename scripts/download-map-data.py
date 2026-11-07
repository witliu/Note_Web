"""Refresh local GeoAtlas child boundaries without rewriting their geometry."""
import concurrent.futures
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / 'web' / 'map-data'


def download(feature):
    props = feature['properties']
    code = str(props['adcode'])
    target = ROOT / 'provinces' / f'{code}.json'
    if not props.get('childrenNum'):
        return code, 'no children in source'
    for attempt in range(3):
        try:
            with urllib.request.urlopen(
                f'https://geo.datav.aliyun.com/areas_v3/bound/{code}_full.json', timeout=45
            ) as response:
                raw = response.read()
            data = json.loads(raw)
            if data.get('type') != 'FeatureCollection' or not data.get('features'):
                raise ValueError('Empty or invalid GeoJSON')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            return code, len(data['features'])
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1)


if __name__ == '__main__':
    features = json.loads((ROOT / 'china.json').read_bytes())['features']
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for result in pool.map(download, [f for f in features if f['properties'].get('level') == 'province']):
            print(*result, flush=True)
