import base64
import sqlite3
import subprocess
import sys
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend import database, ocr


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / 'journal.sqlite3')) as client:
        yield client


def quote(**changes):
    return {'id': str(uuid4()), 'kind': 'quote', 'date': '2026-10-24', 'body': '今天也要开心',
            'quote_source': '随手记', 'quote_note': '想留住此刻', **changes}


def image(client, raw=b'\x89PNG\r\n\x1a\noriginal-image', name='quote.png'):
    draft, media = str(uuid4()), str(uuid4())
    payload = {'entry_id': str(uuid4()), 'kind': 'quote', 'date': '2026-10-24', 'body': '已有文字'}
    client.put('/api/drafts/' + draft, json=payload).raise_for_status()
    client.post('/api/media', json={'id': media, 'draft_id': draft, 'name': name,
                                   'size': len(raw)}).raise_for_status()
    client.put(f'/api/media/{media}/content', content=raw,
               headers={'Content-Type': 'application/octet-stream'}).raise_for_status()
    return draft, media, payload


def test_quotes_edit_search_filter_and_restart(tmp_path):
    path = tmp_path / 'journal.sqlite3'
    data = quote()
    with TestClient(create_app(path)) as client:
        saved = client.post('/api/entries', json=data).json()
        client.post('/api/entries', json=quote(id=str(uuid4()), kind='entry')).raise_for_status()
        result = client.get('/api/entries', params={'kind': 'quote', 'q': '随手记'}).json()
        assert result['total'] == 1 and result['items'][0]['id'] == data['id']
        assert client.get('/api/entries', params={'kind': 'quote', 'q': '留住'}).json()['total'] == 1
        assert client.get('/api/entries', params={'kind': 'entry'}).json()['total'] == 1
        data.update(revision=saved['revision'], quote_source='一本书', quote_note='修改后的感想')
        updated = client.post('/api/entries', json=data)
        updated.raise_for_status()
        assert client.post('/api/entries', json=data).status_code == 409
    with TestClient(create_app(path)) as restarted:
        saved = restarted.get('/api/entries/' + data['id']).json()
        assert saved['kind'] == 'quote' and saved['quote_source'] == '一本书'
        assert saved['quote_note'] == '修改后的感想'


def test_migration_7_keeps_existing_entries(tmp_path):
    path = tmp_path / 'old.sqlite3'
    identifier = str(uuid4())
    with sqlite3.connect(path) as db:
        for schema in [database.SCHEMA, database.ANNIVERSARIES_SCHEMA, database.CONFIRMED_ANNIVERSARIES_SCHEMA,
                       database.WISHES_SCHEMA, database.FOOTPRINTS_SCHEMA, database.QUIZZES_SCHEMA, database.MEDIA_SCHEMA]:
            db.executescript(schema)
        db.execute("INSERT INTO entries(id,title,body,place,occurred_on,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                   (identifier, '旧记录', '保留内容', '', '2026-01-01', '2026-01-01', '2026-01-01'))
    with TestClient(create_app(path)) as client:
        assert client.get('/api/health').json()['schema_version'] == 8
        saved = client.get('/api/entries/' + identifier).json()
        assert saved['kind'] == 'entry' and saved['body'] == '保留内容'
        assert saved['quote_source'] == saved['quote_note'] == ''


def test_quote_draft_source_and_note_persist(client):
    data = quote()
    data['entry_id'] = data.pop('id')
    identifier = str(uuid4())
    client.put('/api/drafts/' + identifier, json=data).raise_for_status()
    draft = client.get('/api/drafts').json()['items'][0]
    assert draft['kind'] == 'quote' and draft['quote_source'] == data['quote_source']
    assert draft['quote_note'] == data['quote_note']


def test_quote_requires_confirmed_text_and_preserves_image_on_trash_restore(client):
    draft, media, payload = image(client)
    data = quote(id=payload['entry_id'], draft_id=draft, draft_revision=1, attachment_ids=[media], body='')
    assert client.post('/api/entries', json=data).status_code == 422
    data['body'] = '校对后的语录'
    saved = client.post('/api/entries', json=data).json()
    assert saved['attachments'][0]['id'] == media
    client.post(f"/api/entries/{saved['id']}/trash", json={'revision': saved['revision']}).raise_for_status()
    assert client.get('/api/entries?kind=quote').json()['total'] == 0
    trash = client.get('/api/trash').json()['items'][0]
    client.post(f"/api/trash/entry/{saved['id']}/restore", json={'revision': trash['revision']}).raise_for_status()
    restored = client.get('/api/entries/' + saved['id']).json()
    assert restored['kind'] == 'quote' and restored['quote_note'] == data['quote_note']
    assert restored['attachments'][0]['id'] == media


def test_ocr_is_suggestion_only_and_original_stays_unchanged(client, monkeypatch):
    raw = b'\x89PNG\r\n\x1a\nunchanged-source'
    draft, media, _ = image(client, raw)
    monkeypatch.setattr(ocr, 'status', lambda: {'available': True})
    def recognize(payload):
        assert base64.b64decode(payload['image']) == raw
        return {'text': '建 议 文 字', 'language': 'zh-Hans-CN', 'engine': 'windows-local'}
    monkeypatch.setattr(ocr, 'invoke', recognize)
    result = client.post(f'/api/media/{media}/ocr', json={})
    result.raise_for_status()
    assert result.json()['text'] == '建议文字'
    assert client.get('/api/drafts').json()['items'][0]['body'] == '已有文字'
    assert client.get(f'/api/media/{media}/content?download=1').content == raw
    assert client.get('/api/entries?kind=quote').json()['total'] == 0


def test_ocr_unavailable_still_allows_manual_quote(client, monkeypatch):
    _, media, _ = image(client)
    monkeypatch.setattr(ocr, 'status', lambda: {'available': False})
    assert client.post(f'/api/media/{media}/ocr', json={}).status_code == 503
    client.post('/api/entries', json=quote()).raise_for_status()


def test_ocr_limits_busy_and_timeout_keep_original(client, monkeypatch):
    _, media, _ = image(client)
    ocr._gate.acquire()
    try: assert client.post(f'/api/media/{media}/ocr', json={}).status_code == 429
    finally: ocr._gate.release()
    monkeypatch.setattr(ocr, 'MAX_OCR_BYTES', 1)
    assert client.post(f'/api/media/{media}/ocr', json={}).status_code == 413
    monkeypatch.setattr(ocr, 'MAX_OCR_BYTES', 20 * 1024 * 1024)
    monkeypatch.setattr(ocr, 'status', lambda: {'available': True})
    def timeout(payload): raise subprocess.TimeoutExpired('ocr', 60)
    monkeypatch.setattr(ocr, 'invoke', timeout)
    assert client.post(f'/api/media/{media}/ocr', json={}).status_code == 504
    assert client.get(f'/api/media/{media}/content').status_code == 200
    _, document, _ = image(client, b'%PDF-1.7 original', 'quote.pdf')
    assert client.post(f'/api/media/{document}/ocr', json={}).status_code == 422


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows OCR integration')
def test_real_windows_ocr_reads_generated_chinese_text(client):
    if not ocr.status()['available']: pytest.skip('No installed Windows OCR language')
    text = base64.b64encode('今天也要开心 2026'.encode('utf-8')).decode('ascii')
    command = """Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1200,240
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font 'Microsoft YaHei',42
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('""" + text + """'))
$g.DrawString($text,$font,[System.Drawing.Brushes]::Black,30,50)
$stream = New-Object System.IO.MemoryStream
$bmp.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Write([Convert]::ToBase64String($stream.ToArray()))
$g.Dispose(); $font.Dispose(); $bmp.Dispose(); $stream.Dispose()
"""
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                            capture_output=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0
    raw = base64.b64decode(result.stdout)
    _, media, _ = image(client, raw)
    response = client.post(f'/api/media/{media}/ocr', json={})
    response.raise_for_status()
    text = response.json()['text']
    assert '今天' in text and '2026' in text
    assert client.get(f'/api/media/{media}/content').content == raw


@pytest.mark.parametrize('raw,expected', [
    ('今 天 也 要 开 心', '今天也要开心'),
    ('你 好 ， 世 界 ！', '你好，世界！'),
    ('今 天 很 好\n明 天 也 是\r\n  第 三 行', '今天很好\n明天也是\r\n  第三行'),
    ('我 喜 欢 Hello World 和 Python 3.10', '我喜欢 Hello World 和 Python 3.10'),
    ('Hello World\nKeep  two spaces', 'Hello World\nKeep  two spaces'),
    ('第 12 章 2026 年', '第 12 章 2026 年'),
    ('今\u00a0天\u3000也\t要\u2009开 心', '今天也要开心'),
    ('\U00020000 中 文\u2028下 一 行', '\U00020000中文\u2028下一行'),
])
def test_ocr_chinese_spacing_keeps_english_and_line_breaks(raw, expected):
    assert ocr.normalize_text(raw) == expected
