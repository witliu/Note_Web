"""Two local accounts and opaque server-side sessions for mutual quiz permissions."""
import hashlib
import hmac
import secrets
import time
from uuid import uuid4

from .repository import fail, now

COOKIE = 'journal_session'
SESSION_SECONDS = 7 * 24 * 3600


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    value = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=32768, r=8, p=1,
                           maxmem=64 * 1024 * 1024, dklen=32)
    return 'scrypt$' + salt.hex() + '$' + value.hex()


def verify_password(password, encoded):
    _, salt, _ = encoded.split('$')
    return hmac.compare_digest(hash_password(password, bytes.fromhex(salt)), encoded)


def token_hash(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


class Auth:
    def __init__(self, database):
        self.database = database

    def configured(self):
        with self.database.connect() as db:
            return db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 2

    @staticmethod
    def public_user(db, user):
        partner = db.execute('SELECT id,display_name FROM users WHERE id!=?', (user['id'],)).fetchone()
        return {'id': user['id'], 'username': user['username'], 'display_name': user['display_name'],
                'partner': dict(partner) if partner else None}

    def user(self, token):
        if not token or len(token) > 200:
            return None
        with self.database.connect() as db:
            row = db.execute('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id '
                             'WHERE s.token_hash=? AND s.expires_at>?', (token_hash(token), int(time.time()))).fetchone()
            return self.public_user(db, row) if row else None

    def require(self, token):
        user = self.user(token)
        if user is None:
            fail(401, '请先登录自己的账号，再进入互相出题')
        return user

    def setup(self, data):
        # No password or raw session token is persisted to logs or source.
        accounts = [(str(uuid4()), i + 1, a.username, a.display_name, hash_password(a.password), now())
                    for i, a in enumerate(data.accounts)]
        with self.database.connect(write=True) as db:
            if db.execute('SELECT COUNT(*) FROM users').fetchone()[0]:
                fail(409, '两人账号已经设置，请直接登录')
            db.executemany('INSERT INTO users VALUES(?,?,?,?,?,?)', accounts)

    def login(self, data, address, previous_token=None):
        timestamp = int(time.time())
        with self.database.connect() as db:
            attempt = db.execute('SELECT * FROM login_attempts WHERE address=?', (address,)).fetchone()
            if attempt and timestamp - attempt['window_start'] < 900 and attempt['failures'] >= 10:
                fail(429, '尝试次数较多，请稍后再登录')
            row = db.execute('SELECT * FROM users WHERE username=?', (data.username.strip().lower(),)).fetchone()
        if row:
            valid = verify_password(data.password, row['password_hash'])
        else:
            hash_password(data.password, bytes(16))
            valid = False
        if not valid:
            with self.database.connect(write=True) as db:
                current = db.execute('SELECT * FROM login_attempts WHERE address=?', (address,)).fetchone()
                if not current or timestamp - current['window_start'] >= 900:
                    db.execute('INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)', (address, 1, timestamp))
                else:
                    db.execute('UPDATE login_attempts SET failures=failures+1 WHERE address=?', (address,))
            fail(401, '登录名或密码不正确')
        token = secrets.token_urlsafe(32)
        with self.database.connect(write=True) as db:
            db.execute('DELETE FROM login_attempts WHERE address=?', (address,))
            db.execute('DELETE FROM sessions WHERE expires_at<=?', (timestamp,))
            if previous_token:
                db.execute('DELETE FROM sessions WHERE token_hash=?', (token_hash(previous_token),))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?)',
                       (token_hash(token), row['id'], timestamp + SESSION_SECONDS, timestamp))
            user = self.public_user(db, row)
        return token, user

    def logout(self, token):
        if token:
            with self.database.connect(write=True) as db:
                db.execute('DELETE FROM sessions WHERE token_hash=?', (token_hash(token),))
