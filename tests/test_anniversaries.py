import sqlite3
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.anniversaries import next_occurrence, shanghai_today
from backend.database import ANNIVERSARIES_SCHEMA, SCHEMA


@pytest.fixture
def client(tmp_path):
    with patch('backend.anniversaries.shanghai_today', return_value=date(2026, 10, 24)):
        with TestClient(create_app(tmp_path / 'anniversaries.sqlite3')) as client:
            yield client


def event(**changes):
    return {'id': str(uuid4()), 'name': '特别的一天', 'calendar': 'solar',
            'month': 10, 'day': 24, 'remind_days': 7, **changes}


def save(client, **changes):
    response = client.post('/api/anniversaries', json=event(**changes))
    assert response.status_code == 200, response.text
    return response.json()


def test_confirmed_dates_are_solar_today_only_without_invented_year(client):
    result = client.get('/api/anniversaries').json()
    assert result['total'] == 4
    assert {(r['month'], r['day']) for r in result['items']} == {(8, 17), (10, 4), (9, 13), (11, 15)}
    assert all(r['calendar'] == 'solar' and r['remind_days'] == 0 and r['years'] is None for r in result['items'])
    assert client.get('/api/anniversaries/reminders').json()['total'] == 0


def test_reminders_include_today_and_lead_boundary_not_past_disabled_or_unconfirmed(client):
    today = save(client, name='今天', remind_days=0)
    boundary = save(client, name='提前七天', day=31)
    save(client, name='还有八天', month=11, day=1)
    save(client, name='昨天已过', day=23)
    save(client, name='关闭提醒', enabled=False)
    save(client, name='尚未确认', calendar='unconfirmed')
    result = client.get('/api/anniversaries/reminders').json()
    assert result['today'] == '2026-10-24' and result['timezone'] == 'Asia/Shanghai'
    assert [r['id'] for r in result['items']] == [today['id'], boundary['id']]
    assert [r['days_until'] for r in result['items']] == [0, 7]
    assert client.get('/api/anniversaries/reminders?page_size=1').json()['has_more'] is True


def test_year_wrap_start_year_and_counts():
    assert next_occurrence(1, 1, None, date(2026, 12, 31)) == '2027-01-01'
    assert next_occurrence(8, 17, 2030, date(2026, 10, 24)) == '2030-08-17'


def test_leap_day_not_silently_shifted_and_century_rule():
    assert next_occurrence(2, 29, None, date(2027, 2, 28)) == '2028-02-29'
    assert next_occurrence(2, 29, None, date(2099, 3, 1)) == '2104-02-29'
    assert next_occurrence(2, 29, None, date(2028, 2, 29)) == '2028-02-29'


def test_optional_year_and_reminder_count(client):
    birthday = save(client, kind='birthday', start_year=2000)
    anniversary = save(client, start_year=2020)
    unknown = save(client)
    result = {r['id']: r for r in client.get('/api/anniversaries/reminders').json()['items']}
    assert result[birthday['id']]['years'] == 26
    assert result[anniversary['id']]['years'] == 6
    assert result[unknown['id']]['years'] is None


@pytest.mark.parametrize('changes', [
    {'month': 2, 'day': 30}, {'month': 4, 'day': 31}, {'month': 13}, {'day': 0},
    {'name': '   '}, {'remind_days': -1}, {'remind_days': 31}, {'start_year': 2025, 'month': 2, 'day': 29},
])
def test_invalid_anniversaries_rejected(client, changes):
    assert client.post('/api/anniversaries', json=event(**changes)).status_code == 422


def test_edit_conflict_disable_trash_restore_and_no_permanent_delete(client):
    original = save(client)
    changed = save(client, id=original['id'], revision=1, enabled=False)
    assert changed['revision'] == 2
    assert client.post('/api/anniversaries', json=event(id=original['id'], revision=1)).status_code == 409
    assert client.get('/api/anniversaries/reminders').json()['total'] == 0
    enabled = save(client, id=original['id'], revision=2)
    assert client.post(f"/api/anniversaries/{original['id']}/trash", json={'revision': enabled['revision']}).status_code == 200
    assert client.get('/api/anniversaries/reminders').json()['total'] == 0
    trash = client.get('/api/trash').json()['items'][0]
    assert trash['kind'] == 'anniversary'
    assert client.post(f"/api/trash/anniversary/{original['id']}/restore", json={'revision': trash['revision']}).status_code == 200
    assert client.get('/api/anniversaries/reminders').json()['total'] == 1
    assert client.delete(f"/api/anniversaries/{original['id']}", headers={'Content-Type': 'application/json'}).status_code == 404


def test_v1_database_migrates_without_losing_entries_and_seeds_only_once(tmp_path):
    path = tmp_path / 'old.sqlite3'
    identifier = str(uuid4())
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        db.execute('INSERT INTO entries(id,title,body,occurred_on,place,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                   (identifier, '原记录', '升级前的文字', '2026-01-01', '', '2026-01-01', '2026-01-01'))
    with TestClient(create_app(path)) as first:
        assert first.get('/api/entries/' + identifier).json()['body'] == '升级前的文字'
        assert first.get('/api/anniversaries').json()['total'] == 4
        saved = save(first, name='新增的日子')
    with TestClient(create_app(path)) as restarted:
        assert restarted.get('/api/anniversaries').json()['total'] == 5
        assert saved['id'] in {r['id'] for r in restarted.get('/api/anniversaries').json()['items']}
        assert restarted.get('/api/health').json()['schema_version'] == 7


def test_v2_confirmation_migration_preserves_other_settings_and_does_not_repeat(tmp_path):
    path = tmp_path / 'v2.sqlite3'
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA + ANNIVERSARIES_SCHEMA)
    with TestClient(create_app(path)) as first:
        items = first.get('/api/anniversaries').json()['items']
        assert all(r['calendar'] == 'solar' and r['remind_days'] == 0 for r in items)
        original = items[0]
        changed = save(first, id=original['id'], revision=original['revision'], name=original['name'],
                       month=original['month'], day=original['day'], enabled=False)
    with TestClient(create_app(path)) as second:
        item = next(r for r in second.get('/api/anniversaries').json()['items'] if r['id'] == original['id'])
        assert item['revision'] == changed['revision'] and item['enabled'] is False


def test_new_event_defaults_to_today_only(client):
    data = event()
    del data['remind_days']
    response = client.post('/api/anniversaries', json=data)
    assert response.status_code == 200
    assert response.json()['remind_days'] == 0


def test_shanghai_date_does_not_use_host_timezone():
    class Clock:
        @staticmethod
        def now(tz):
            assert tz.utcoffset(None) == timedelta(hours=8)
            return datetime(2026, 10, 24, 16, 30, tzinfo=timezone.utc).astimezone(tz)
    with patch('backend.anniversaries.datetime', Clock):
        assert shanghai_today() == date(2026, 10, 25)
