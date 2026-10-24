"""Versioned development database for text data, never served as static files."""
import sqlite3
from contextlib import contextmanager
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE stories (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE entries (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
    occurred_on TEXT NOT NULL, place TEXT NOT NULL,
    story_id TEXT REFERENCES stories(id), revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX entries_timeline ON entries(deleted_at, occurred_on DESC, id DESC);
CREATE INDEX entries_story ON entries(story_id, deleted_at, occurred_on, id);
CREATE TABLE entry_tags (
    entry_id TEXT NOT NULL REFERENCES entries(id), tag TEXT NOT NULL,
    PRIMARY KEY(entry_id, tag)
);
CREATE INDEX tags_lookup ON entry_tags(tag, entry_id);
CREATE TABLE text_history (
    id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id),
    title TEXT NOT NULL, body TEXT NOT NULL, saved_at TEXT NOT NULL
);
CREATE INDEX history_lookup ON text_history(entry_id, saved_at DESC, id DESC);
CREATE TABLE drafts (
    id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX drafts_updated ON drafts(deleted_at, updated_at DESC, id DESC);
INSERT INTO schema_migrations(version) VALUES(1);
"""

ANNIVERSARIES_SCHEMA = """
CREATE TABLE anniversaries (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    calendar TEXT NOT NULL CHECK(calendar IN ('solar','unconfirmed')),
    month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
    day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31),
    start_year INTEGER, remind_days INTEGER NOT NULL CHECK(remind_days BETWEEN 0 AND 30),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), note TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX anniversaries_active ON anniversaries(deleted_at, month, day, id);
INSERT INTO anniversaries(id,name,kind,calendar,month,day,remind_days,enabled,created_at,updated_at) VALUES
('b11e3050-7db4-4a61-b6fd-a11111111111','在一起纪念日','anniversary','unconfirmed',8,17,7,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('b11e3050-7db4-4a61-b6fd-a22222222222','结婚纪念日','anniversary','unconfirmed',10,4,7,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('b11e3050-7db4-4a61-b6fd-a33333333333','老婆生日','birthday','unconfirmed',9,13,7,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('b11e3050-7db4-4a61-b6fd-a44444444444','小昀生日','birthday','unconfirmed',11,15,7,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO schema_migrations(version) VALUES(2);
"""

CONFIRMED_ANNIVERSARIES_SCHEMA = """
UPDATE anniversaries SET calendar='solar', remind_days=0, revision=revision+1,
updated_at=CURRENT_TIMESTAMP WHERE id IN (
'b11e3050-7db4-4a61-b6fd-a11111111111',
'b11e3050-7db4-4a61-b6fd-a22222222222',
'b11e3050-7db4-4a61-b6fd-a33333333333',
'b11e3050-7db4-4a61-b6fd-a44444444444');
INSERT INTO schema_migrations(version) VALUES(3);
"""

WISHES_SCHEMA = """
CREATE TABLE wishes (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    target_date TEXT, done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
    completed_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    CHECK((done=0 AND completed_at IS NULL) OR (done=1 AND completed_at IS NOT NULL))
);
CREATE INDEX wishes_active ON wishes(deleted_at,done,created_at DESC,id DESC);
INSERT INTO schema_migrations(version) VALUES(4);
"""

FOOTPRINTS_SCHEMA = """
CREATE TABLE footprints (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, province TEXT NOT NULL DEFAULT '',
    longitude REAL NOT NULL CHECK(longitude BETWEEN 72 AND 136),
    latitude REAL NOT NULL CHECK(latitude BETWEEN 2 AND 55),
    coordinate_system TEXT NOT NULL DEFAULT 'datav_geojson' CHECK(coordinate_system='datav_geojson'),
    visited_on TEXT, note TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX footprints_active ON footprints(deleted_at,created_at DESC,id DESC);
CREATE INDEX footprints_viewport ON footprints(deleted_at,longitude,latitude);
INSERT INTO schema_migrations(version) VALUES(5);
"""

QUIZZES_SCHEMA = """
CREATE TABLE users (
    id TEXT PRIMARY KEY, slot INTEGER NOT NULL UNIQUE CHECK(slot IN (1,2)),
    username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_attempts (
    address TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL
);
CREATE TABLE questions (
    id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id),
    recipient_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('single','multiple')),
    body TEXT NOT NULL, options_json TEXT NOT NULL, correct_json TEXT NOT NULL,
    explanation TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    CHECK(author_id != recipient_id)
);
CREATE INDEX questions_recipient ON questions(recipient_id,created_at DESC,id DESC);
CREATE INDEX questions_author ON questions(author_id,created_at DESC,id DESC);
CREATE TABLE quiz_answers (
    id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES questions(id),
    answerer_id TEXT NOT NULL REFERENCES users(id), selections_json TEXT NOT NULL,
    correct INTEGER NOT NULL CHECK(correct IN (0,1)), submitted_at TEXT NOT NULL,
    UNIQUE(question_id,answerer_id)
);
CREATE INDEX answers_history ON quiz_answers(submitted_at DESC,id DESC);
INSERT INTO schema_migrations(version) VALUES(6);
"""

MEDIA_SCHEMA = """
CREATE TABLE media (
    id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id),
    name TEXT NOT NULL, declared_mime TEXT NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    kind TEXT NOT NULL DEFAULT 'document', expected_size INTEGER NOT NULL CHECK(expected_size>=0),
    size INTEGER, sha256 TEXT, status TEXT NOT NULL CHECK(status IN ('pending','receiving','ready','failed')),
    error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    discarded_at TEXT, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX media_draft ON media(draft_id,discarded_at,created_at,id);
CREATE INDEX media_status ON media(status);
CREATE TABLE entry_media (
    id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id), media_id TEXT NOT NULL REFERENCES media(id),
    position INTEGER NOT NULL, deleted_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
    UNIQUE(entry_id,media_id)
);
CREATE INDEX entry_media_order ON entry_media(entry_id,deleted_at,position,id);
INSERT INTO schema_migrations(version) VALUES(7);
"""


class Database:
    def __init__(self, path: Path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS schema_migrations ('
                       'version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
            version = db.execute('SELECT COALESCE(MAX(version), 0) FROM schema_migrations').fetchone()[0]
            if version > 7:
                raise RuntimeError('Database schema is newer than this application')
            if version == 0:
                db.executescript('BEGIN IMMEDIATE;\n' + SCHEMA + '\nCOMMIT;')
                version = 1
            if version < 2:
                db.executescript('BEGIN IMMEDIATE;\n' + ANNIVERSARIES_SCHEMA + '\nCOMMIT;')
                version = 2
            if version < 3:
                db.executescript('BEGIN IMMEDIATE;\n' + CONFIRMED_ANNIVERSARIES_SCHEMA + '\nCOMMIT;')
                version = 3
            if version < 4:
                db.executescript('BEGIN IMMEDIATE;\n' + WISHES_SCHEMA + '\nCOMMIT;')
                version = 4
            if version < 5:
                db.executescript('BEGIN IMMEDIATE;\n' + FOOTPRINTS_SCHEMA + '\nCOMMIT;')
                version = 5
            if version < 6:
                db.executescript('BEGIN IMMEDIATE;\n' + QUIZZES_SCHEMA + '\nCOMMIT;')
                version = 6
            if version < 7:
                db.executescript('BEGIN IMMEDIATE;\n' + MEDIA_SCHEMA + '\nCOMMIT;')
        finally:
            db.close()

    @contextmanager
    def connect(self, write=False):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA busy_timeout=10000')
        try:
            if write:
                db.execute('BEGIN IMMEDIATE')
            else:
                db.execute('BEGIN')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()
