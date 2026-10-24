import sqlite3
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.database import SCHEMA, ANNIVERSARIES_SCHEMA, CONFIRMED_ANNIVERSARIES_SCHEMA, WISHES_SCHEMA


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / 'map.sqlite3')) as client:
        yield client


def point(**changes):
    return {'id': str(uuid4()), 'name': '一起看海', 'longitude': 118.08, 'latitude': 24.48, **changes}


def save(client, **changes):
    response = client.post('/api/footprints', json=point(**changes))
    assert response.status_code == 200, response.text
    return response.json()


def test_save_move_and_get_point(client):
    item = save(client, name='  海边  ', province='福建省', visited_on='2026-10-24', note='  听海  ')
    assert item['name'] == '海边' and item['note'] == '听海'
    assert item['coordinate_system'] == 'datav_geojson'
    moved = save(client, id=item['id'], revision=1, name='新的落点', longitude=120.123456, latitude=30.654321)
    assert moved['revision'] == 2
    assert client.get('/api/footprints/' + item['id']).json()['longitude'] == 120.123456
    assert client.get('/api/footprints').json()['total'] == 1


@pytest.mark.parametrize('changes', [
    {'longitude': 71}, {'longitude': 137}, {'latitude': 1}, {'latitude': 56},
    {'longitude': 'NaN'}, {'latitude': 'Infinity'}, {'name': '  '}, {'name': 'a' * 101},
    {'visited_on': '2026-02-30'}, {'note': 'a' * 5001}, {'coordinate_system': 'gcj02'},
])
def test_invalid_points_rejected(client, changes):
    assert client.post('/api/footprints', json=point(**changes)).status_code == 422


def test_viewport_markers_are_bounded_lightweight_and_exclude_deleted_points(client):
    a = save(client, name='南方', longitude=118, latitude=24)
    save(client, name='北方', longitude=116, latitude=40)
    removed = save(client, longitude=118.1, latitude=24.1)
    client.post(f"/api/footprints/{removed['id']}/trash", json={'revision': 1})
    result = client.get('/api/footprints/markers?west=117&south=23&east=119&north=25').json()
    assert [r['id'] for r in result['items']] == [a['id']]
    assert 'note' not in result['items'][0] and result['has_more'] is False
    assert client.get('/api/footprints/markers?limit=1').json()['has_more'] is True
    assert client.get('/api/footprints/markers?west=120&east=110').status_code == 422
    assert client.get('/api/footprints/markers?south=40&north=20').status_code == 422
    assert client.get('/api/footprints/markers?limit=1001').status_code == 422


def test_list_search_and_pagination(client):
    first = save(client, name='100% 期待_', province='福建省', note='海边')
    save(client, name='山间', province='四川省')
    save(client, name='周末散步')
    a = client.get('/api/footprints?page_size=2').json()
    b = client.get('/api/footprints?page_size=2&page=2').json()
    assert a['total'] == 3 and a['has_more'] is True
    assert {r['id'] for r in a['items']}.isdisjoint(r['id'] for r in b['items'])
    for query in ['%', '_', '福建', '海边']:
        result = client.get('/api/footprints', params={'q': query}).json()
        assert result['total'] == 1 and result['items'][0]['id'] == first['id']
        assert client.get('/api/footprints/markers', params={'q': query}).json()['items'][0]['id'] == first['id']


def test_conflicts_trash_and_restore_preserve_coordinates(client):
    item = save(client, visited_on='2020-08-17', note='那天的回忆')
    updated = save(client, id=item['id'], revision=1, visited_on='2020-08-17', note='补充回忆')
    assert client.post('/api/footprints', json=point(id=item['id'], revision=1)).status_code == 409
    assert client.post(f"/api/footprints/{item['id']}/trash", json={'revision': 1}).status_code == 409
    assert client.post(f"/api/footprints/{item['id']}/trash", json={'revision': 2}).status_code == 200
    assert client.get('/api/footprints').json()['total'] == 0
    assert client.get('/api/footprints/' + item['id']).status_code == 404
    assert client.post('/api/footprints', json=point(id=item['id'], revision=3)).status_code == 409
    trash = client.get('/api/trash').json()['items'][0]
    assert trash['kind'] == 'footprint'
    assert client.post(f"/api/trash/footprint/{item['id']}/restore", json={'revision': trash['revision']}).status_code == 200
    loaded = client.get('/api/footprints/' + item['id']).json()
    assert loaded['longitude'] == updated['longitude'] and loaded['latitude'] == updated['latitude']
    assert loaded['visited_on'] == '2020-08-17' and loaded['note'] == '补充回忆'
    assert client.delete('/api/footprints/' + item['id'], headers={'Content-Type': 'application/json'}).status_code == 405


def test_restart_and_separate_client_read_same_marker(tmp_path):
    path = tmp_path / 'shared.sqlite3'
    with TestClient(create_app(path)) as a:
        item = save(a)
        with TestClient(create_app(path)) as b:
            assert b.get('/api/footprints/markers').json()['items'][0]['id'] == item['id']
    with TestClient(create_app(path)) as restarted:
        assert restarted.get('/api/footprints/' + item['id']).json()['longitude'] == item['longitude']


def test_v4_migration_preserves_wishes_and_anniversaries(tmp_path):
    path = tmp_path / 'v4.sqlite3'
    identifier = str(uuid4())
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA + ANNIVERSARIES_SCHEMA + CONFIRMED_ANNIVERSARIES_SCHEMA + WISHES_SCHEMA)
        db.execute('INSERT INTO wishes(id,title,created_at,updated_at) VALUES(?,?,?,?)',
                   (identifier, '升级前的愿望', '2026-10-24', '2026-10-24'))
    with TestClient(create_app(path)) as client:
        assert client.get('/api/wishes').json()['items'][0]['id'] == identifier
        assert client.get('/api/anniversaries').json()['total'] == 4
        assert client.get('/api/health').json()['schema_version'] == 7
        assert client.get('/api/footprints').json()['total'] == 0


def test_local_map_assets_complete_without_remote_runtime_dependencies(client):
    for path in ['/map.js', '/map-data/china.json', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css']:
        assert client.get(path).status_code == 200
    data = client.get('/map-data/china.json').json()
    assert len(data['features']) == 35
    codes = {str(f['properties']['adcode']) for f in data['features']}
    assert {'710000', '810000', '820000', '100000_JD'}.issubset(codes)
    html = client.get('/').text
    assert 'src="https://' not in html and 'href="https://' not in html
    assert client.get('/map-data/../../data/journal.sqlite3').status_code == 404
