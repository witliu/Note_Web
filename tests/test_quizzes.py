import sqlite3
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.auth import COOKIE
from backend.database import SCHEMA, ANNIVERSARIES_SCHEMA, CONFIRMED_ANNIVERSARIES_SCHEMA, WISHES_SCHEMA, FOOTPRINTS_SCHEMA

# Synthetic credentials used only with temporary test databases.
PASSWORD = 'Test-Only-Example-42'
ACCOUNTS = {'accounts': [
    {'username': 'alpha', 'display_name': '第一位', 'password': PASSWORD},
    {'username': 'beta', 'display_name': '第二位', 'password': PASSWORD}
]}


@pytest.fixture
def pair(tmp_path):
    app = create_app(tmp_path / 'quizzes.sqlite3')
    with TestClient(app, client=('127.0.0.1', 51000)) as a:
        assert a.post('/api/auth/setup', json=ACCOUNTS).status_code == 200
        with TestClient(app, client=('192.168.1.2', 51001)) as b:
            for client, name in [(a, 'alpha'), (b, 'beta')]:
                assert client.post('/api/auth/login', json={'username': name, 'password': PASSWORD}).status_code == 200
            yield a, b


def question(**changes):
    options = [{'id': str(uuid4()), 'text': text} for text in ['看海', '看山', '散步']]
    return {'id': str(uuid4()), 'body': '最想一起做什么？', 'kind': 'single', 'options': options,
            'correct_option_ids': [options[0]['id']], 'explanation': '我们一起说好的', **changes}


def create(client, data=None):
    data = data or question()
    response = client.post('/api/quizzes', json=data)
    assert response.status_code == 200, response.text
    return data, response.json()


def answer(client, data, selected=None, attempt_id=None):
    return client.post(f"/api/quizzes/{data['id']}/answers", json={
        'id': attempt_id or str(uuid4()), 'selected_option_ids': selected or data['correct_option_ids']})


def test_setup_only_localhost_cannot_be_claimed_from_lan(tmp_path):
    app = create_app(tmp_path / 'setup.sqlite3')
    with TestClient(app, client=('192.168.1.3', 12345)) as remote:
        assert remote.get('/api/auth/status').json()['can_setup'] is False
        assert remote.post('/api/auth/setup', json=ACCOUNTS).status_code == 403
        assert remote.post('/api/auth/setup', json=ACCOUNTS, headers={'Host': 'localhost:8000'}).status_code == 403
    with TestClient(app, client=('127.0.0.1', 12345)) as local:
        assert local.post('/api/auth/setup', json=ACCOUNTS).status_code == 200
        assert local.post('/api/auth/setup', json=ACCOUNTS).status_code == 409
        assert local.get('/api/auth/status').json()['user'] is None


def test_passwords_and_sessions_are_hashed_cookie_http_only_and_logout_revokes(pair):
    a, _ = pair
    response = a.post('/api/auth/login', json={'username': 'ALPHA', 'password': PASSWORD})
    assert response.status_code == 200
    cookie = response.headers['set-cookie'].lower()
    assert 'httponly' in cookie and 'samesite=strict' in cookie
    token = a.cookies.get(COOKIE)
    with sqlite3.connect(a.app.state.journal.database.path) as db:
        hashes = [r[0] for r in db.execute('SELECT password_hash FROM users')]
        assert all(h.startswith('scrypt$') and h != PASSWORD for h in hashes)
        assert hashes[0] != hashes[1]
        assert all(r[0] != token and len(r[0]) == 64 for r in db.execute('SELECT token_hash FROM sessions'))
    assert 'password' not in response.text and 'token' not in response.text
    assert a.post('/api/auth/logout', json={}).status_code == 200
    a.cookies.set(COOKIE, token)
    assert a.get('/api/quizzes').status_code == 401


def test_anonymous_forged_identity_and_expired_session_rejected(pair):
    a, b = pair
    data, _ = create(a)
    token = b.cookies.get(COOKIE)
    b.cookies.clear()
    assert b.get('/api/quizzes', headers={'X-User-ID': a.get('/api/auth/status').json()['user']['id']}).status_code == 401
    assert b.get('/api/quizzes/' + data['id']).status_code == 401
    assert answer(b, data).status_code == 401
    assert b.post('/api/quizzes', json=question()).status_code == 401
    b.cookies.set(COOKIE, 'forged')
    assert b.get('/api/quizzes').status_code == 401
    b.cookies.clear(); b.cookies.set(COOKIE, token)
    with sqlite3.connect(a.app.state.journal.database.path) as db:
        db.execute('UPDATE sessions SET expires_at=0')
    assert b.get('/api/quizzes').status_code == 401


def test_author_cannot_answer_and_recipient_cannot_see_key_before_submission(pair):
    a, b = pair
    data, authored = create(a)
    assert authored['can_answer'] is False and authored['correct_option_ids'] == data['correct_option_ids']
    assert answer(a, data).status_code == 403
    before = b.get('/api/quizzes/' + data['id']).json()
    assert before['can_answer'] is True and before['answered'] is False
    assert 'correct_option_ids' not in before and 'explanation' not in before and 'correct_json' not in before
    assert all('correct' not in o for o in before['options'])
    listing = b.get('/api/quizzes').json()
    assert listing['total'] == 1 and 'correct_option_ids' not in listing['items'][0]
    assert 'explanation' not in listing['items'][0]
    assert a.get('/api/quizzes?tab=pending').json()['total'] == 0


def test_correct_submission_records_both_users_original_options_and_time(pair):
    a, b = pair
    data, _ = create(a)
    response = answer(b, data)
    assert response.status_code == 200
    result = response.json()
    assert result['answer']['correct'] is True and result['can_answer'] is False
    assert result['answer']['answerer_id'] == b.get('/api/auth/status').json()['user']['id']
    assert result['answer']['submitted_at'] and result['options'] == data['options']
    assert result['explanation'] == data['explanation']
    for client in (a, b):
        assert client.get('/api/quizzes?tab=history').json()['total'] == 1
        assert client.get('/api/quizzes/' + data['id']).json()['answer'] == result['answer']
    assert b.get('/api/quizzes?tab=pending').json()['total'] == 0


def test_wrong_answer_immutable_and_retry_idempotent(pair):
    a, b = pair
    data, _ = create(a)
    attempt = str(uuid4())
    wrong = [data['options'][1]['id']]
    first = answer(b, data, wrong, attempt)
    assert first.status_code == 200 and first.json()['answer']['correct'] is False
    repeated = answer(b, data, wrong, attempt)
    assert repeated.status_code == 200 and repeated.json()['answer'] == first.json()['answer']
    assert answer(b, data).status_code == 409
    assert answer(b, data, data['correct_option_ids'], attempt).status_code == 409
    assert b.get('/api/quizzes?tab=history').json()['total'] == 1
    assert b.get('/api/quizzes/' + data['id']).json()['answer']['selected_option_ids'] == wrong


def test_invalid_selection_cannot_create_record(pair):
    a, b = pair
    data, _ = create(a)
    assert answer(b, data, [str(uuid4())]).status_code == 422
    assert answer(b, data, [o['id'] for o in data['options']]).status_code == 422
    assert b.post(f"/api/quizzes/{data['id']}/answers", json={'id': str(uuid4()), 'selected_option_ids': []}).status_code == 422
    assert b.post(f"/api/quizzes/{data['id']}/answers", json={'id': str(uuid4()), 'selected_option_ids': data['correct_option_ids'], 'answerer_id': 'forged'}).status_code == 422
    assert b.get('/api/quizzes?tab=history').json()['total'] == 0


def test_multiple_choice_exact_set_required(pair):
    a, b = pair
    data = question(kind='multiple')
    data['correct_option_ids'] = [o['id'] for o in data['options'][:2]]
    create(a, data)
    assert answer(b, data, [data['options'][0]['id']]).json()['answer']['correct'] is False
    second = question(kind='multiple')
    second['correct_option_ids'] = [o['id'] for o in second['options'][:2]]
    create(a, second)
    assert answer(b, second, list(reversed(second['correct_option_ids']))).json()['answer']['correct'] is True


def test_question_ownership_cannot_be_spoofed_and_published_question_fixed(pair):
    a, b = pair
    data, _ = create(a)
    assert a.post('/api/quizzes', json={**question(), 'author_id': b.get('/api/auth/status').json()['user']['id']}).status_code == 422
    assert a.post('/api/quizzes', json={**question(), 'recipient_id': a.get('/api/auth/status').json()['user']['id']}).status_code == 422
    assert a.post('/api/quizzes', json=data).status_code == 409
    assert a.put('/api/quizzes/' + data['id'], json=data).status_code == 405
    assert a.delete('/api/quizzes/' + data['id'], headers={'Content-Type': 'application/json'}).status_code == 405


def test_both_people_can_set_questions_for_each_other(pair):
    a, b = pair
    from_a, _ = create(a)
    from_b, _ = create(b)
    assert answer(a, from_b).status_code == 200
    assert answer(b, from_a).status_code == 200
    assert a.get('/api/quizzes?tab=history').json()['total'] == 2


def test_validation_and_pagination(pair):
    a, b = pair
    for changes in [{'body': '   '}, {'kind': 'text'}, {'options': []}, {'correct_option_ids': []},
                    {'correct_option_ids': [str(uuid4())]}]:
        assert a.post('/api/quizzes', json=question(**changes)).status_code == 422
    invalid = question(); invalid['options'][1]['text'] = invalid['options'][0]['text']
    assert a.post('/api/quizzes', json=invalid).status_code == 422
    for _ in range(3): create(a)
    first = b.get('/api/quizzes?page_size=2').json()
    second = b.get('/api/quizzes?page_size=2&page=2').json()
    assert first['total'] == 3 and first['has_more'] is True
    assert {r['id'] for r in first['items']}.isdisjoint(r['id'] for r in second['items'])
    assert a.get('/api/quizzes?tab=created').json()['summary']['created'] == 3
    assert a.get('/api/quizzes?page_size=101').status_code == 422


def test_simultaneous_submissions_leave_one_formal_record(pair):
    a, b = pair
    data, _ = create(a)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: answer(b, data), range(2)))
    assert sorted(r.status_code for r in responses) == [200, 409]
    assert a.get('/api/quizzes?tab=history').json()['total'] == 1


def test_record_and_session_survive_restart(pair):
    a, b = pair
    data, _ = create(a)
    original = answer(b, data).json()['answer']
    token = b.cookies.get(COOKIE)
    path = a.app.state.journal.database.path
    with TestClient(create_app(path), cookies={COOKIE: token}) as restarted:
        assert restarted.get('/api/quizzes/' + data['id']).json()['answer'] == original


def test_login_throttle_and_invalid_credentials(pair):
    a, _ = pair
    for _ in range(10):
        assert a.post('/api/auth/login', json={'username': 'missing', 'password': 'wrong'}).status_code == 401
    assert a.post('/api/auth/login', json={'username': 'alpha', 'password': PASSWORD}).status_code == 429


def test_v5_upgrade_retains_existing_wishes_and_no_default_accounts(tmp_path):
    path = tmp_path / 'v5.sqlite3'
    identifier = str(uuid4())
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA + ANNIVERSARIES_SCHEMA + CONFIRMED_ANNIVERSARIES_SCHEMA + WISHES_SCHEMA + FOOTPRINTS_SCHEMA)
        db.execute('INSERT INTO wishes(id,title,created_at,updated_at) VALUES(?,?,?,?)', (identifier, '原愿望', '2026-10-24', '2026-10-24'))
    with TestClient(create_app(path)) as client:
        assert client.get('/api/health').json()['schema_version'] == 7
        assert client.get('/api/wishes').json()['items'][0]['id'] == identifier
        assert client.get('/api/auth/status').json()['configured'] is False
        assert client.get('/api/quizzes').status_code == 401
