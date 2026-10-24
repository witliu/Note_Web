import sqlite3
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.database import ANNIVERSARIES_SCHEMA, CONFIRMED_ANNIVERSARIES_SCHEMA, SCHEMA


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / 'wishes.sqlite3')) as client:
        yield client


def payload(**changes):
    return {'id': str(uuid4()), 'title': '一起看海', **changes}


def save(client, **changes):
    response = client.post('/api/wishes', json=payload(**changes))
    assert response.status_code == 200, response.text
    return response.json()


def test_new_list_empty_and_create_with_optional_fields(client):
    assert client.get('/api/wishes').json()['summary'] == {'total': 0, 'done': 0, 'pending': 0}
    wish = save(client, title='  一起看日出  ', note='  带上相机  ', target_date='2027-01-01')
    assert wish['title'] == '一起看日出' and wish['note'] == '带上相机'
    assert wish['target_date'] == '2027-01-01'
    assert wish['done'] is False and wish['completed_at'] is None and wish['revision'] == 1


@pytest.mark.parametrize('changes', [
    {'title': ''}, {'title': '   '}, {'title': 'a' * 101}, {'note': 'a' * 5001},
    {'target_date': '2026-02-30'}, {'done': True}, {'revision': -1}, {'id': 'bad-id'},
])
def test_validation(client, changes):
    assert client.post('/api/wishes', json=payload(**changes)).status_code == 422
    assert client.get('/api/wishes').json()['total'] == 0


def test_complete_edit_and_undo(client):
    wish = save(client)
    done = client.post(f"/api/wishes/{wish['id']}/status", json={'revision': 1, 'done': True}).json()
    assert done['done'] is True and done['completed_at'] is not None and done['revision'] == 2
    assert client.get('/api/wishes?status=done').json()['total'] == 1
    assert client.get('/api/wishes?status=pending').json()['total'] == 0
    assert client.get('/api/wishes').json()['summary'] == {'total': 1, 'done': 1, 'pending': 0}
    edited = save(client, id=wish['id'], revision=2, note='那天的海很美')
    assert edited['completed_at'] == done['completed_at'] and edited['done'] is True
    repeated = client.post(f"/api/wishes/{wish['id']}/status", json={'revision': 3, 'done': True}).json()
    assert repeated['completed_at'] == done['completed_at'] and repeated['revision'] == 3
    undone = client.post(f"/api/wishes/{wish['id']}/status", json={'revision': 3, 'done': False}).json()
    assert undone['done'] is False and undone['completed_at'] is None and undone['revision'] == 4
    assert client.get('/api/wishes').json()['summary']['pending'] == 1


def test_stale_edit_status_and_deleted_wish_are_rejected(client):
    wish = save(client)
    save(client, id=wish['id'], revision=1, title='更新后的期待')
    assert client.post('/api/wishes', json=payload(id=wish['id'], revision=1)).status_code == 409
    assert client.post(f"/api/wishes/{wish['id']}/status", json={'revision': 1, 'done': True}).status_code == 409
    assert client.post(f"/api/wishes/{wish['id']}/trash", json={'revision': 1}).status_code == 409
    assert client.post(f"/api/wishes/{wish['id']}/trash", json={'revision': 2}).status_code == 200
    assert client.post('/api/wishes', json=payload(id=wish['id'], revision=3)).status_code == 409
    assert client.post(f"/api/wishes/{wish['id']}/status", json={'revision': 3, 'done': True}).status_code == 404


def test_search_filters_pagination_summary_and_literal_wildcards(client):
    wishes = [save(client, title=f'愿望{i}', note='100% 一起_去旅行' if i == 0 else '') for i in range(5)]
    client.post(f"/api/wishes/{wishes[0]['id']}/status", json={'revision': 1, 'done': True})
    page1 = client.get('/api/wishes?page_size=2').json()
    page2 = client.get('/api/wishes?page_size=2&page=2').json()
    assert page1['total'] == 5 and page1['has_more'] is True
    assert all(not r['done'] for r in page1['items'])
    assert {r['id'] for r in page1['items']}.isdisjoint(r['id'] for r in page2['items'])
    for query in ['%', '_', '旅行']:
        result = client.get('/api/wishes', params={'q': query, 'status': 'done'}).json()
        assert result['total'] == 1 and result['items'][0]['id'] == wishes[0]['id']
        assert result['summary'] == {'total': 5, 'done': 1, 'pending': 4}
    assert client.get('/api/wishes?status=invalid').status_code == 422
    assert client.get('/api/wishes?page_size=101').status_code == 422
    assert client.get('/api/wishes?page=0').status_code == 422


def test_completed_wish_trash_restore_preserves_content_and_completion(client):
    wish = save(client, note='计划细节', target_date='2026-12-31')
    done = client.post(f"/api/wishes/{wish['id']}/status", json={'revision': 1, 'done': True}).json()
    client.post(f"/api/wishes/{wish['id']}/trash", json={'revision': 2})
    assert client.get('/api/wishes').json()['summary'] == {'total': 0, 'done': 0, 'pending': 0}
    trashed = client.get('/api/trash').json()['items'][0]
    assert trashed['kind'] == 'wish'
    assert client.post(f"/api/trash/wish/{wish['id']}/restore", json={'revision': trashed['revision']}).status_code == 200
    restored = client.get('/api/wishes').json()['items'][0]
    assert restored['note'] == '计划细节' and restored['target_date'] == '2026-12-31'
    assert restored['done'] is True and restored['completed_at'] == done['completed_at']
    assert client.delete(f"/api/wishes/{wish['id']}", headers={'Content-Type': 'application/json'}).status_code == 404


def test_restart_and_second_client_share_same_saved_wishes(tmp_path):
    path = tmp_path / 'shared.sqlite3'
    with TestClient(create_app(path)) as first:
        wish = save(first)
        with TestClient(create_app(path)) as second:
            assert second.get('/api/wishes').json()['items'][0]['id'] == wish['id']
    with TestClient(create_app(path)) as restarted:
        assert restarted.get('/api/wishes').json()['items'][0]['id'] == wish['id']


def test_v3_migration_keeps_anniversaries_and_runs_once(tmp_path):
    path = tmp_path / 'v3.sqlite3'
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA + ANNIVERSARIES_SCHEMA + CONFIRMED_ANNIVERSARIES_SCHEMA)
        db.execute("UPDATE anniversaries SET name='已编辑的纪念日',enabled=0 WHERE month=8")
    with TestClient(create_app(path)) as first:
        anniversary = next(r for r in first.get('/api/anniversaries').json()['items'] if r['month'] == 8)
        assert anniversary['name'] == '已编辑的纪念日' and anniversary['enabled'] is False
        wish = save(first)
    with TestClient(create_app(path)) as restarted:
        assert restarted.get('/api/health').json()['schema_version'] == 7
        assert restarted.get('/api/wishes').json()['total'] == 1
        assert restarted.get('/api/wishes').json()['items'][0]['id'] == wish['id']


def test_failed_write_leaves_original_wish_intact(client):
    wish = save(client)
    with sqlite3.connect(client.app.state.journal.database.path) as db:
        db.execute("CREATE TRIGGER fail_wish_update BEFORE UPDATE ON wishes BEGIN SELECT RAISE(ABORT,'disk error'); END")
    response = client.post('/api/wishes', json=payload(id=wish['id'], revision=1, title='不应提交'))
    assert response.status_code == 503
    loaded = client.get('/api/wishes').json()['items'][0]
    assert loaded['title'] == wish['title'] and loaded['revision'] == 1
