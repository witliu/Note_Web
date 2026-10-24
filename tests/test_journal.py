import sqlite3
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.run import lan_addresses


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / 'journal.sqlite3')) as client:
        yield client


def record(**changes):
    return {'id': str(uuid4()), 'body': '一起吃晚饭', 'date': '2026-10-24', **changes}


def post_entry(client, **changes):
    response = client.post('/api/entries', json=record(**changes))
    assert response.status_code == 200, response.text
    return response.json()


def test_restart_and_independent_client_read_same_database(tmp_path):
    path = tmp_path / 'shared.sqlite3'
    with TestClient(create_app(path)) as first:
        saved = post_entry(first, tags=['日常', '日常'], place='在家')
        with TestClient(create_app(path)) as second:
            assert second.get('/api/entries').json()['items'][0]['id'] == saved['id']
    with TestClient(create_app(path)) as restarted:
        loaded = restarted.get('/api/entries/' + saved['id']).json()
        assert loaded['body'] == '一起吃晚饭'
        assert loaded['tags'] == ['日常']


def test_validation_and_no_attachments_silently_discarded(client):
    for change in [{'body': '   ', 'title': '只有标题'}, {'date': '2026-02-30'},
                   {'attachments': [{'url': 'blob:unsaved'}]}, {'story': 'not-a-uuid'}]:
        assert client.post('/api/entries', json=record(**change)).status_code == 422
    assert client.get('/api/entries?page_size=1000').status_code == 422
    assert client.get('/api/entries?month=13').status_code == 422
    assert client.get('/api/entries').json()['total'] == 0


def test_date_order_search_paging_filters_and_edit_order(client):
    old = post_entry(client, date='2025-12-01', body='补录旅行', tags=['旅行'])
    new = post_entry(client, date='2026-10-01', body='今天的日常', tags=['日常'])
    post_entry(client, date='2026-09-01', body='100% 快乐_')
    page1 = client.get('/api/entries?page_size=2').json()
    page2 = client.get('/api/entries?page_size=2&page=2').json()
    assert page1['total'] == 3 and page1['has_more'] is True
    assert page1['items'][0]['id'] == new['id']
    assert page2['items'][0]['id'] == old['id']
    assert set(i['id'] for i in page1['items']).isdisjoint(i['id'] for i in page2['items'])
    assert client.get('/api/entries?year=2025&month=12&tag=旅行&q=补录').json()['total'] == 1
    assert client.get('/api/entries', params={'q': '%'}).json()['total'] == 1
    assert client.get('/api/entries', params={'q': '_'}).json()['total'] == 1
    post_entry(client, id=old['id'], date=old['date'], revision=old['revision'], body='修改旧事')
    assert client.get('/api/entries').json()['items'][-1]['id'] == old['id']


def test_history_conflicts_and_restoration(client):
    entry = post_entry(client, title='第一版', body='正文一')
    changed = post_entry(client, id=entry['id'], revision=1, title='第二版', body='正文二')
    stale = client.post('/api/entries', json=record(id=entry['id'], revision=1, body='覆盖别人的文字'))
    assert stale.status_code == 409
    history = client.get(f"/api/entries/{entry['id']}/history").json()
    assert history['total'] == 1
    response = client.post(f"/api/entries/{entry['id']}/history/{history['items'][0]['id']}/restore",
                           json={'revision': changed['revision']})
    assert response.status_code == 200
    assert response.json()['body'] == '正文一'
    assert response.json()['date'] == entry['date']
    assert response.json()['history_count'] == 2


def test_story_delete_unclassifies_without_losing_records(client):
    story = client.post('/api/stories', json={'name': '山间旅行'}).json()
    later = post_entry(client, story=story['id'], date='2026-10-24')
    earlier = post_entry(client, story=story['id'], date='2026-10-01')
    items = client.get('/api/entries', params={'story': story['id'], 'order': 'asc'}).json()['items']
    assert [i['id'] for i in items] == [earlier['id'], later['id']]
    assert client.post(f"/api/stories/{story['id']}/trash", json={'revision': 1}).status_code == 200
    assert client.get('/api/stories').json()['total'] == 0
    assert client.get('/api/entries').json()['total'] == 2
    assert all(i['story'] is None for i in client.get('/api/entries').json()['items'])
    assert client.post('/api/entries', json=record(story=story['id'])).status_code == 404


def test_trash_restore_preserves_history_and_original_date(client):
    entry = post_entry(client, date='2025-08-17', body='旧事')
    entry = post_entry(client, id=entry['id'], revision=1, date=entry['date'], body='旧事补充')
    assert client.post(f"/api/entries/{entry['id']}/trash", json={'revision': 1}).status_code == 409
    assert client.post(f"/api/entries/{entry['id']}/trash", json={'revision': 2}).status_code == 200
    assert client.get('/api/entries').json()['total'] == 0
    trash = client.get('/api/trash').json()['items'][0]
    assert client.post(f"/api/trash/entry/{entry['id']}/restore", json={'revision': trash['revision']}).status_code == 200
    restored = client.get('/api/entries/' + entry['id']).json()
    assert restored['date'] == '2025-08-17' and restored['history_count'] == 1
    # There is no permanent-deletion endpoint, including guessed routes.
    assert client.delete('/api/trash/entry/' + entry['id'], headers={'Content-Type': 'application/json'}).status_code == 404


def test_restoring_record_respects_story_state(client):
    story = client.post('/api/stories', json={'name': '故事'}).json()
    entry = post_entry(client, story=story['id'])
    client.post(f"/api/entries/{entry['id']}/trash", json={'revision': 1})
    client.post(f"/api/stories/{story['id']}/trash", json={'revision': 1})
    client.post(f"/api/trash/entry/{entry['id']}/restore", json={'revision': 2})
    assert client.get('/api/entries/' + entry['id']).json()['story'] is None


def test_draft_publication_is_atomic_and_delayed_save_cannot_recreate(client):
    draft_id, entry_id = str(uuid4()), str(uuid4())
    data = {'entry_id': entry_id, 'body': '未发布的回忆', 'date': '2026-10-24'}
    draft = client.put('/api/drafts/' + draft_id, json=data).json()
    assert client.put('/api/drafts/' + draft_id, json={**data, 'body': '旧页面'}).status_code == 409
    assert client.get('/api/entries').json()['total'] == 0
    assert client.get('/api/drafts').json()['total'] == 1
    invalid = record(id=entry_id, draft_id=draft_id, draft_revision=99)
    assert client.post('/api/entries', json=invalid).status_code == 409
    assert client.get('/api/entries').json()['total'] == 0
    assert client.get('/api/drafts').json()['total'] == 1
    saved = post_entry(client, id=entry_id, draft_id=draft_id, draft_revision=draft['revision'])
    assert saved['id'] == entry_id
    assert client.get('/api/drafts').json()['total'] == 0
    assert client.put('/api/drafts/' + draft_id, json={**data, 'revision': draft['revision']}).status_code == 409
    assert client.post('/api/entries', json=record(id=entry_id)).status_code == 409
    assert client.get('/api/entries').json()['total'] == 1


def test_transaction_rollback_on_storage_error(client):
    entry = post_entry(client, title='原始标题', tags=['日常'])
    path = client.app.state.journal.database.path
    with sqlite3.connect(path) as db:
        db.execute("CREATE TRIGGER simulate_disk_error BEFORE INSERT ON entry_tags WHEN NEW.tag='失败' "
                   "BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END")
    response = client.post('/api/entries', json=record(id=entry['id'], revision=1, title='不应保存', tags=['失败']))
    assert response.status_code == 503
    loaded = client.get('/api/entries/' + entry['id']).json()
    assert loaded['title'] == '原始标题' and loaded['revision'] == 1
    assert loaded['tags'] == ['日常'] and loaded['history_count'] == 0


def test_large_dataset_pagination(client):
    db_path = client.app.state.journal.database.path
    with sqlite3.connect(db_path) as db:
        db.executemany('INSERT INTO entries(id,title,body,occurred_on,place,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                       [(str(uuid4()), f'记录{i}', '规模检查', '2026-10-24', '', '2026-10-24', '2026-10-24')
                        for i in range(3000)])
    first = client.get('/api/entries?page_size=20').json()
    second = client.get('/api/entries?page_size=20&page=2').json()
    assert first['total'] == 3000 and len(first['items']) == len(second['items']) == 20
    assert set(i['id'] for i in first['items']).isdisjoint(i['id'] for i in second['items'])


def test_local_boundary_and_private_files(client):
    assert client.get('/api/health').json()['schema_version'] == 7
    assert client.get('/api/entries', headers={'Host': 'evil.example'}).status_code == 400
    assert client.post('/api/entries', json=record(), headers={'Origin': 'https://evil.example'}).status_code == 403
    assert client.post('/api/entries', content='{}', headers={'Content-Type': 'text/plain'}).status_code == 415
    assert client.post('/api/entries', content=b'x' * (1024 * 1024 + 1),
                       headers={'Content-Type': 'application/json'}).status_code == 413
    assert client.get('/api/entries').headers['cache-control'] == 'no-store'
    for path in ['/data/journal.sqlite3', '/.git/config', '/backend/app.py', '/requirements.txt']:
        assert client.get(path).status_code == 404
    for path in ['/', '/app.js', '/styles.css', '/server.css', '/sw.js', '/assets/mountain.jpg']:
        assert client.get(path).status_code == 200


def test_simultaneous_edit_has_one_winner(client):
    entry = post_entry(client)
    def edit(text):
        return client.post('/api/entries', json=record(id=entry['id'], revision=1, body=text))
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(edit, ['页面一', '页面二']))
    assert sorted(r.status_code for r in responses) == [200, 409]
    saved = client.get('/api/entries/' + entry['id']).json()
    assert saved['body'] in ['页面一', '页面二']
    assert saved['revision'] == 2 and saved['history_count'] == 1


def test_lan_host_is_explicitly_allowed_and_same_origin_write_works(tmp_path):
    with TestClient(create_app(tmp_path / 'lan.sqlite3', allowed_hosts=['192.168.31.62'])) as client:
        assert client.get('/api/health', headers={'Host': '192.168.31.62:8000'}).status_code == 200
        response = client.post('/api/entries', json=record(),
                               headers={'Host': '192.168.31.62:8000', 'Origin': 'http://192.168.31.62:8000'})
        assert response.status_code == 200
        assert client.post('/api/entries', json=record(),
                           headers={'Host': '192.168.31.62:8000', 'Origin': 'http://evil.example'}).status_code == 403
        assert client.get('/api/health', headers={'Host': 'unknown.example'}).status_code == 400


def test_lan_detection_excludes_loopback_link_local_and_public_addresses():
    addresses = ['127.0.0.1', '169.254.52.225', '192.168.31.62', '192.168.31.62', '8.8.8.8']
    values = [(2, 1, 6, '', (address, 0)) for address in addresses]
    with patch('backend.run.socket.getaddrinfo', return_value=values):
        assert lan_addresses() == ['192.168.31.62']
