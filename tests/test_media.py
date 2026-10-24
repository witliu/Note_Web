import hashlib
import sqlite3
import subprocess
import sys
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.media import CHUNK, ObjectWriter


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / 'journal.sqlite3')) as client:
        yield client


def make_draft(client, entry_id=None, **changes):
    identifier = str(uuid4())
    payload = {'entry_id': entry_id or str(uuid4()), 'date': '2026-10-24', **changes}
    response = client.put('/api/drafts/' + identifier, json=payload)
    assert response.status_code == 200, response.text
    return identifier, payload, response.json()


def upload(client, draft_id, raw, name='照片.png', identifier=None):
    identifier = identifier or str(uuid4())
    meta = {'id': identifier, 'draft_id': draft_id, 'name': name, 'size': len(raw), 'mime': 'image/png'}
    begun = client.post('/api/media', json=meta)
    assert begun.status_code == 200, begun.text
    response = client.put(f'/api/media/{identifier}/content', content=raw, headers={'Content-Type': 'application/octet-stream'})
    assert response.status_code == 200, response.text
    return meta, response.json()


def publish(client, draft_id, payload, media_ids, **changes):
    response = client.post('/api/entries', json={'id': payload['entry_id'], 'date': payload['date'],
                           'draft_id': draft_id, 'draft_revision': 1, 'attachment_ids': media_ids, **changes})
    assert response.status_code == 200, response.text
    return response.json()


def test_original_bytes_chunked_in_database_download_and_range(client):
    draft_id, _, _ = make_draft(client)
    raw = b'\x89PNG\r\n\x1a\n' + bytes(range(256)) * (CHUNK // 128 + 5)
    meta, item = upload(client, draft_id, raw)
    assert item['kind'] == 'image' and item['status'] == 'ready'
    assert item['sha256'] == hashlib.sha256(raw).hexdigest()
    path = client.app.state.media.object_path(meta['id'])
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT COUNT(*) FROM chunks').fetchone()[0] == 3
        assert b''.join(r[0] for r in db.execute('SELECT data FROM chunks ORDER BY position')) == raw
    assert client.get(item['url']).content == raw
    response = client.get(item['url'], headers={'Range': f'bytes={CHUNK-4}-{CHUNK+6}'})
    assert response.status_code == 206 and response.content == raw[CHUNK-4:CHUNK+7]
    assert response.headers['content-range'] == f'bytes {CHUNK-4}-{CHUNK+6}/{len(raw)}'
    assert client.head(item['url']).headers['content-length'] == str(len(raw))
    assert client.get(item['url'], headers={'Range': 'bytes=-8'}).content == raw[-8:]
    assert client.get(item['url'], headers={'Range': 'bytes=999999999-'}).status_code == 416
    assert client.get(item['url'], headers={'Range': 'bytes=0-2,4-7'}).status_code == 416
    assert 'attachment;' in client.get(item['download_url']).headers['content-disposition']


@pytest.mark.parametrize('name,raw,kind', [
    ('movie.mp4', b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42', 'video'),
    ('voice.mp3', b'ID3original-audio', 'audio'),
    ('报告.pdf', b'%PDF-1.7 original bytes', 'document'),
    ('计划.docx', b'PK\x03\x04some office bytes', 'document'),
    ('danger.svg', b'<svg onload="alert(1)"></svg>', 'document'),
    ('fake.png', b'<html><script>alert(1)</script></html>', 'document'),
    ('empty.txt', b'', 'document'),
])
def test_media_categories_and_download_only_documents(client, name, raw, kind):
    draft_id, _, _ = make_draft(client)
    _, item = upload(client, draft_id, raw, name)
    assert item['kind'] == kind
    response = client.get(item['url'])
    assert response.content == raw
    if kind == 'document':
        assert response.headers['content-type'] == 'application/octet-stream'
        assert 'attachment;' in response.headers['content-disposition']
        assert "sandbox" in response.headers['content-security-policy']


def test_attachment_only_record_album_search_edit_trash_and_restore(client):
    draft_id, payload, _ = make_draft(client)
    _, photo = upload(client, draft_id, b'\x89PNG\r\n\x1a\nimage', '海边照片.png')
    _, doc = upload(client, draft_id, b'%PDF-1.7 original', '旅行计划.pdf')
    assert client.get('/api/album').json()['total'] == 0
    entry = publish(client, draft_id, payload, [photo['id'], doc['id']])
    assert [a['id'] for a in entry['attachments']] == [photo['id'], doc['id']]
    assert client.get('/api/album').json()['total'] == 1
    assert client.get('/api/entries', params={'q': '旅行计划'}).json()['total'] == 1
    assert client.get('/api/entries?media_type=document').json()['total'] == 1
    assert client.get('/api/entries?media_type=text').json()['total'] == 0
    edited = client.post('/api/entries', json={'id': entry['id'], 'date': entry['date'], 'revision': 1,
                                             'attachment_ids': [doc['id']]}).json()
    assert [a['id'] for a in edited['attachments']] == [doc['id']]
    assert client.get('/api/album').json()['total'] == 0
    trash = client.get('/api/trash').json()['items'][0]
    assert trash['kind'] == 'attachment'
    assert client.post(f"/api/trash/attachment/{trash['id']}/restore", json={'revision': trash['revision']}).status_code == 200
    restored = client.get('/api/entries/' + entry['id']).json()
    assert len(restored['attachments']) == 2 and client.get('/api/album').json()['total'] == 1
    assert client.get(photo['download_url']).content == b'\x89PNG\r\n\x1a\nimage'


def test_ready_original_not_overwritten_and_other_draft_cannot_attach(client):
    draft_id, payload, _ = make_draft(client)
    meta, item = upload(client, draft_id, b'original-document', 'file.docx')
    assert client.post('/api/media', json=meta).json()['status'] == 'ready'
    assert client.put(item['url'], content=b'changed-document!', headers={'Content-Type': 'application/octet-stream'}).status_code == 409
    assert client.get(item['url']).content == b'original-document'
    other, payload2, _ = make_draft(client)
    response = client.post('/api/entries', json={'id': payload2['entry_id'], 'date': payload2['date'],
                           'draft_id': other, 'draft_revision': 1, 'attachment_ids': [item['id']]})
    assert response.status_code == 403


def test_incomplete_file_not_publishable_and_retry_retains_completed_files(client):
    draft_id, payload, _ = make_draft(client)
    _, success = upload(client, draft_id, b'already-uploaded', 'success.txt')
    identifier = str(uuid4())
    meta = {'id': identifier, 'draft_id': draft_id, 'name': 'retry.txt', 'size': 10}
    assert client.post('/api/media', json=meta).status_code == 200
    assert client.put(f'/api/media/{identifier}/content', content=b'partial',
                      headers={'Content-Type': 'application/octet-stream', 'Content-Length': '10'}).status_code == 422
    assert client.get('/api/media/' + identifier).json()['status'] == 'failed'
    response = client.post('/api/entries', json={'id': payload['entry_id'], 'date': payload['date'],
                           'attachment_ids': [identifier], 'draft_id': draft_id, 'draft_revision': 1})
    assert response.status_code == 409
    assert client.post('/api/media', json=meta).status_code == 200
    assert client.put(f'/api/media/{identifier}/content', content=b'0123456789', headers={'Content-Type': 'application/octet-stream'}).status_code == 200
    assert client.get(success['url']).content == b'already-uploaded'


def test_discarded_uploaded_original_restores_to_draft(client):
    draft_id, _, _ = make_draft(client)
    _, item = upload(client, draft_id, b'keep this original', 'kept.txt')
    assert client.post(f"/api/media/{item['id']}/discard", json={'draft_id': draft_id}).status_code == 200
    assert client.get('/api/media/drafts/' + draft_id).json()['items'] == []
    trash = client.get('/api/trash').json()['items'][0]
    assert trash['kind'] == 'upload'
    assert client.post(f"/api/trash/upload/{item['id']}/restore", json={'revision': trash['revision']}).status_code == 200
    assert client.get('/api/drafts').json()['items'][0]['attachment_ids'] == [item['id']]
    assert client.get(item['url']).content == b'keep this original'


def test_catalog_failure_recovers_committed_object_without_reupload(client, monkeypatch):
    draft_id, _, _ = make_draft(client)
    store = client.app.state.media
    identifier = str(uuid4()); raw = b'committed original bytes'
    meta = {'id': identifier, 'draft_id': draft_id, 'name': 'recover.txt', 'size': len(raw)}
    client.post('/api/media', json=meta)
    activate = store.activate
    def failure(*args): raise sqlite3.OperationalError('simulated catalog failure')
    monkeypatch.setattr(store, 'activate', failure)
    response = client.put(f'/api/media/{identifier}/content', content=raw, headers={'Content-Type': 'application/octet-stream'})
    assert response.status_code == 503 and store.object_path(identifier).exists()
    monkeypatch.setattr(store, 'activate', activate)
    store.recover()
    assert client.post('/api/media', json=meta).json()['status'] == 'ready'
    assert client.get(f'/api/media/{identifier}/content').content == raw


def test_committed_staging_database_is_salvaged_and_partial_upload_is_not(client):
    draft_id, _, _ = make_draft(client)
    store = client.app.state.media
    identifier = str(uuid4()); raw = b'finished before process exit'
    client.post('/api/media', json={'id': identifier, 'draft_id': draft_id, 'name': 'staged.txt', 'size': len(raw)})
    writer = ObjectWriter(store, store.claim(identifier)); writer.write(raw); writer.flush()
    writer.conn.execute('INSERT INTO object_info VALUES(?,?,?,?,?)',
                        (identifier, len(raw), hashlib.sha256(raw).hexdigest(), 'application/octet-stream', 'document'))
    writer.conn.commit(); writer.conn.close(); writer.closed = True
    stage = writer.stage
    store.recover()
    assert not stage.exists() and client.get(f'/api/media/{identifier}/content').content == raw
    partial = str(uuid4())
    client.post('/api/media', json={'id': partial, 'draft_id': draft_id, 'name': 'partial.txt', 'size': 100})
    writer2 = ObjectWriter(store, store.claim(partial)); writer2.write(b'incomplete')
    writer2.conn.rollback(); writer2.conn.close(); writer2.closed = True
    store.recover()
    assert client.get('/api/media/' + partial).json()['status'] == 'failed'
    assert not store.object_path(partial).exists() and not writer2.stage.exists()


def test_upload_limit_and_disk_reserve_fail_without_catalog_objects(client, monkeypatch):
    draft_id, _, _ = make_draft(client)
    store = client.app.state.media
    monkeypatch.setattr(store, 'max_size', 10)
    assert client.post('/api/media', json={'id': str(uuid4()), 'draft_id': draft_id, 'name': 'large', 'size': 11}).status_code == 413
    monkeypatch.setattr('backend.media.shutil.disk_usage', lambda _: SimpleNamespace(free=0))
    assert client.post('/api/media', json={'id': str(uuid4()), 'draft_id': draft_id, 'name': 'small', 'size': 1}).status_code == 507
    assert client.get('/api/media/drafts/' + draft_id).json()['items'] == []


def test_second_service_process_cannot_recover_live_uploads(client):
    store = client.app.state.media
    draft_id, _, _ = make_draft(client)
    identifier = str(uuid4())
    client.post('/api/media', json={'id': identifier, 'draft_id': draft_id, 'name': 'live.txt', 'size': 100})
    store.claim(identifier)
    with TestClient(create_app(store.database.path)) as second:
        assert second.get('/api/media/' + identifier).json()['status'] == 'receiving'
    code = "from pathlib import Path; from backend.database import Database; from backend.media import MediaStore; import sys; s=MediaStore(Database(Path(sys.argv[1]))); s.acquire()"
    result = subprocess.run([sys.executable, '-c', code, str(store.database.path)], capture_output=True, timeout=15)
    assert result.returncode != 0
    assert client.get('/api/media/' + identifier).json()['status'] == 'receiving'
    store.failed(identifier)


def test_restarting_service_preserves_original_database_and_media(client):
    draft_id, payload, _ = make_draft(client)
    _, item = upload(client, draft_id, b'document persisted on server', 'report.docx')
    entry = publish(client, draft_id, payload, [item['id']])
    with TestClient(create_app(client.app.state.journal.database.path)) as second:
        assert second.get('/api/entries/' + entry['id']).json()['attachments'][0]['sha256'] == item['sha256']
        assert second.get(item['url']).content == b'document persisted on server'


def test_entry_deletion_hides_album_then_restore_and_attachment_order_preserved(client):
    draft_id, payload, _ = make_draft(client)
    _, first = upload(client, draft_id, b'\x89PNG\r\n\x1a\nfirst', 'first.png')
    _, second = upload(client, draft_id, b'\x89PNG\r\n\x1a\nsecond', 'second.png')
    entry = publish(client, draft_id, payload, [second['id'], first['id']])
    assert [a['id'] for a in entry['attachments']] == [second['id'], first['id']]
    client.post(f"/api/entries/{entry['id']}/trash", json={'revision': 1})
    assert client.get('/api/album').json()['total'] == 0
    trash = client.get('/api/trash').json()['items'][0]
    client.post(f"/api/trash/entry/{entry['id']}/restore", json={'revision': trash['revision']})
    assert client.get('/api/album').json()['total'] == 2
