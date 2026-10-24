"""Immutable originals in per-object SQLite chunk databases, with recoverable catalog publication."""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import threading
from pathlib import Path
from urllib.parse import quote
from uuid import UUID, uuid4

from .repository import Journal, fail, now, page_result

CHUNK = 1024 * 1024
_locks = {}
_lock_guard = threading.Lock()


def descriptor(row):
    result = {key: row[key] for key in ['id', 'name', 'mime', 'kind', 'size', 'sha256', 'status', 'error', 'expected_size']}
    result['url'] = f"/api/media/{row['id']}/content"
    result['download_url'] = result['url'] + '?download=1'
    result['discarded'] = row['discarded_at'] is not None
    return result


def attachment_rows(db, entry_id):
    return [descriptor(r) for r in db.execute(
        'SELECT m.* FROM entry_media a JOIN media m ON m.id=a.media_id '
        "WHERE a.entry_id=? AND a.deleted_at IS NULL AND m.status='ready' ORDER BY a.position,a.id", (str(entry_id),))]


def validate_attachments(db, identifiers, draft_id=None, entry_id=None):
    for identifier in identifiers:
        row = db.execute('SELECT * FROM media WHERE id=?', (str(identifier),)).fetchone()
        if row is None or row['status'] != 'ready' or row['discarded_at']:
            fail(409, '附件尚未完整入库或已移除，请完成上传后重试')
        existing = entry_id and db.execute('SELECT 1 FROM entry_media WHERE entry_id=? AND media_id=?',
                                          (str(entry_id), str(identifier))).fetchone()
        if row['draft_id'] != str(draft_id) and not existing:
            fail(403, '附件不属于当前草稿或记录')


def sniff(header, name):
    ext = Path(name).suffix.lower()
    if header.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png', 'image'
    if header.startswith(b'\xff\xd8\xff'): return 'image/jpeg', 'image'
    if header[:6] in (b'GIF87a', b'GIF89a'): return 'image/gif', 'image'
    if header[:4] == b'RIFF' and header[8:12] == b'WEBP': return 'image/webp', 'image'
    if header[:4] == b'RIFF' and header[8:12] == b'WAVE': return 'audio/wav', 'audio'
    if header.startswith(b'BM'): return 'image/bmp', 'image'
    if header[:4] in (b'II*\x00', b'MM\x00*'): return 'image/tiff', 'image'
    if len(header) >= 2 and header[0] == 255 and header[1] & 240 == 240 and ext == '.aac': return 'audio/aac', 'audio'
    if header[4:8] in (b'moov', b'mdat', b'wide', b'free') and ext == '.mov': return 'video/quicktime', 'video'
    if header.startswith(b'fLaC'): return 'audio/flac', 'audio'
    if header.startswith(b'ID3') or (len(header) >= 2 and header[0] == 255 and header[1] & 224 == 224 and ext == '.mp3'):
        return 'audio/mpeg', 'audio'
    if header.startswith(b'OggS'): return ('video/ogg', 'video') if ext == '.ogv' else ('audio/ogg', 'audio')
    if header.startswith(b'\x1aE\xdf\xa3'):
        return ('audio/webm', 'audio') if ext == '.weba' else ('video/webm', 'video')
    if header[4:8] == b'ftyp':
        brands = header[8:64]
        if b'avif' in brands or b'avis' in brands: return 'image/avif', 'image'
        if any(b in brands for b in [b'heic', b'heix', b'hevc', b'hevx', b'mif1', b'msf1']): return 'image/heic', 'image'
        if ext in {'.m4a', '.m4b'}: return 'audio/mp4', 'audio'
        return ('video/quicktime', 'video') if b'qt  ' in brands else ('video/mp4', 'video')
    if header.startswith(b'%PDF-'): return 'application/pdf', 'document'
    # Unknown/active formats (including HTML/SVG) are download-only documents.
    return 'application/octet-stream', 'document'


def byte_range(value, size):
    if not value: return 0, size - 1, False
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', value.strip())
    if not match or size == 0 or not any(match.groups()): return None
    first, last = match.groups()
    if first:
        start = int(first); end = min(int(last), size - 1) if last else size - 1
        if start >= size or start > end: return None
    else:
        length = int(last)
        if length <= 0: return None
        start, end = max(0, size - length), size - 1
    return start, end, True


class ObjectWriter:
    def __init__(self, store, row):
        self.store, self.row = store, row
        self.stage = store.staging / f"{row['id']}-{uuid4()}.sqlite3"
        self.conn = sqlite3.connect(self.stage, check_same_thread=False)
        self.conn.executescript('CREATE TABLE chunks (position INTEGER PRIMARY KEY, data BLOB NOT NULL);'
                                'CREATE TABLE object_info (id TEXT PRIMARY KEY,size INTEGER,sha256 TEXT,mime TEXT,kind TEXT);')
        self.conn.execute('BEGIN IMMEDIATE')
        self.buffer, self.header = bytearray(), bytearray()
        self.size, self.position, self.hash = 0, 0, hashlib.sha256()
        self.closed = False

    def write(self, data):
        if self.size + len(data) > self.row['expected_size']:
            fail(413, '收到的文件超过声明大小，上传未提交')
        self.size += len(data); self.hash.update(data)
        if len(self.header) < 64: self.header.extend(data[:64-len(self.header)])
        view = memoryview(data)
        while view:
            length = min(CHUNK - len(self.buffer), len(view))
            self.buffer.extend(view[:length]); view = view[length:]
            if len(self.buffer) == CHUNK: self.flush()

    def flush(self):
        if self.buffer:
            self.conn.execute('INSERT INTO chunks VALUES(?,?)', (self.position, bytes(self.buffer)))
            self.position += 1; self.buffer.clear()

    def finish(self):
        if self.size != self.row['expected_size']: fail(422, '文件未完整接收，请重新上传这个文件')
        self.flush()
        mime, kind = sniff(bytes(self.header), self.row['name'])
        digest = self.hash.hexdigest()
        self.conn.execute('INSERT INTO object_info VALUES(?,?,?,?,?)', (self.row['id'], self.size, digest, mime, kind))
        self.conn.commit(); self.conn.close(); self.closed = True
        final = self.store.object_path(self.row['id']); final.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive publication: never replace a previously committed original.
        os.link(self.stage, final)
        self.stage.unlink()
        self.store.activate(self.row['id'], {'size': self.size, 'sha256': digest, 'mime': mime, 'kind': kind})
        return self.store.get(self.row['id'])

    def abort(self):
        if not self.closed:
            self.conn.rollback(); self.conn.close(); self.closed = True
        # Only this request's unacknowledged staging database is cleaned; never an original.
        if self.stage.exists(): self.stage.unlink()


class MediaStore:
    def __init__(self, database):
        self.database = database
        self.root = database.path.parent / (database.path.stem + '-media')
        self.staging = self.root / 'staging'; self.staging.mkdir(parents=True, exist_ok=True)
        self.max_size = int(os.environ.get('JOURNAL_MAX_UPLOAD_MB', '1024')) * 1024 * 1024
        if self.max_size <= 0: raise ValueError('JOURNAL_MAX_UPLOAD_MB must be positive')

    def acquire(self):
        key = str(self.root.resolve())
        with _lock_guard:
            if key in _locks:
                _locks[key][1] += 1
                return False
            handle = open(self.root / '.service.lock', 'a+b')
            try:
                if handle.seek(0, 2) == 0: handle.write(b'0'); handle.flush()
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (OSError, BlockingIOError):
                handle.close()
                raise RuntimeError('另一个服务进程正在使用此数据目录，请先关闭旧服务')
            _locks[key] = [handle, 1]
            return True

    def release(self):
        key = str(self.root.resolve())
        with _lock_guard:
            handle, count = _locks[key]
            if count > 1: _locks[key][1] -= 1; return
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close(); del _locks[key]

    def object_path(self, identifier):
        value = str(UUID(str(identifier)))
        return self.root / 'objects' / value[:2] / (value + '.sqlite3')

    def space(self, size):
        if shutil.disk_usage(self.root).free < size * 1.15 + 256 * 1024 * 1024:
            fail(507, '磁盘可用空间不足，请先释放空间再上传')

    def inspect(self, identifier):
        return self.inspect_path(self.object_path(identifier), identifier)

    @staticmethod
    def inspect_path(path, identifier, recover=False):
        if not path.exists(): return None
        db = sqlite3.connect(path.as_uri() + ('?mode=rw' if recover else '?mode=ro'), uri=True)
        try:
            db.row_factory = sqlite3.Row
            row = db.execute('SELECT * FROM object_info WHERE id=?', (str(identifier),)).fetchone()
            if not row: return None
            count = db.execute('SELECT COALESCE(SUM(length(data)),0) FROM chunks').fetchone()[0]
            return dict(row) if count == row['size'] else None
        finally: db.close()

    @staticmethod
    def verify(path, info):
        digest = hashlib.sha256()
        db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
        try:
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': return False
            for row in db.execute('SELECT data FROM chunks ORDER BY position'): digest.update(row[0])
            return digest.hexdigest() == info['sha256']
        finally: db.close()

    def activate(self, identifier, info):
        with self.database.connect(write=True) as db:
            db.execute("UPDATE media SET status='ready',size=?,sha256=?,mime=?,kind=?,error='',updated_at=? WHERE id=?",
                       (info['size'], info['sha256'], info['mime'], info['kind'], now(), str(identifier)))

    def recover(self):
        # Run a single service worker. Original DBs commit first; catalog readiness can be replayed.
        with self.database.connect() as db:
            rows = db.execute("SELECT id,expected_size,status FROM media WHERE status!='ready'").fetchall()
        for row in rows:
            info = self.inspect(row['id'])
            if not info:
                for stage in self.staging.glob(f"{row['id']}-*.sqlite3"):
                    try: staged = self.inspect_path(stage, row['id'], recover=True)
                    except sqlite3.Error: staged = None
                    if staged and staged['size'] == row['expected_size'] and self.verify(stage, staged):
                        final = self.object_path(row['id']); final.parent.mkdir(parents=True, exist_ok=True)
                        os.link(stage, final); stage.unlink(); info = staged
                        break
                    # These have never been acknowledged and have no committed object_info.
                    if not staged:
                        for suffix in ['', '-journal', '-wal', '-shm']:
                            path = Path(str(stage) + suffix)
                            if path.exists(): path.unlink()
            if info and info['size'] == row['expected_size'] and self.verify(self.object_path(row['id']), info):
                self.activate(row['id'], info)
            elif row['status'] == 'receiving': self.failed(row['id'])

    def failed(self, identifier):
        with self.database.connect(write=True) as db:
            db.execute("UPDATE media SET status='failed',error='上传中断或未完整入库，请重试',updated_at=? "
                       "WHERE id=? AND status!='ready'", (now(), str(identifier)))

    def init(self, data):
        if data.size > self.max_size: fail(413, f'单个文件上限为 {self.max_size // (1024*1024)} MiB')
        identifier = str(data.id)
        info = self.inspect(identifier)
        with self.database.connect(write=True) as db:
            Journal.require(db, 'drafts', data.draft_id)
            row = db.execute('SELECT * FROM media WHERE id=?', (identifier,)).fetchone()
            if row:
                if row['draft_id'] != str(data.draft_id) or row['name'] != data.name or row['expected_size'] != data.size:
                    fail(409, '上传编号已用于另一个文件')
                if row['discarded_at']: fail(409, '文件已移入回收站，请先恢复')
                if row['status'] == 'ready' and not info: fail(503, '原件数据库暂不可读，请检查主机存储')
                if row['status'] == 'receiving' and not info: fail(409, '这个文件正在上传，请等待完成')
            else:
                count = db.execute('SELECT COUNT(*) FROM media WHERE draft_id=? AND discarded_at IS NULL', (str(data.draft_id),)).fetchone()[0]
                if count >= 50: fail(409, '单个草稿最多保留 50 个上传文件，请先移除不需要的文件')
                self.space(data.size)
                db.execute("INSERT INTO media(id,draft_id,name,declared_mime,expected_size,status,created_at,updated_at) "
                           "VALUES(?,?,?,?,?,'pending',?,?)", (identifier, str(data.draft_id), data.name, data.mime, data.size, now(), now()))
        if info:
            if info['size'] != data.size: fail(409, '已提交原件大小不匹配，请勿覆盖')
            self.activate(identifier, info)
        return self.get(identifier)

    def claim(self, identifier):
        with self.database.connect(write=True) as db:
            row = db.execute('SELECT * FROM media WHERE id=?', (str(identifier),)).fetchone()
            if row is None: fail(404, '请先创建上传任务')
            if row['status'] in ('ready', 'receiving') or row['discarded_at']: fail(409, '文件已完成、正在接收或已移除')
            Journal.require(db, 'drafts', row['draft_id'])
            self.space(row['expected_size'])
            db.execute("UPDATE media SET status='receiving',error='',updated_at=? WHERE id=?", (now(), str(identifier)))
            return dict(row)

    def get(self, identifier):
        with self.database.connect() as db:
            row = db.execute('SELECT * FROM media WHERE id=?', (str(identifier),)).fetchone()
            if row is None: fail(404, '附件不存在')
            return descriptor(row)

    def for_draft(self, identifier):
        with self.database.connect() as db:
            Journal.require(db, 'drafts', identifier)
            return {'items': [descriptor(r) for r in db.execute('SELECT * FROM media WHERE draft_id=? AND discarded_at IS NULL '
                            'ORDER BY created_at,id LIMIT 100', (str(identifier),))]}

    def discard(self, identifier, draft_id):
        with self.database.connect(write=True) as db:
            Journal.require(db, 'drafts', draft_id)
            row = db.execute('SELECT * FROM media WHERE id=? AND draft_id=?', (str(identifier), str(draft_id))).fetchone()
            if row is None: fail(404, '文件不属于当前草稿')
            if db.execute('SELECT 1 FROM entry_media WHERE media_id=?', (str(identifier),)).fetchone():
                fail(409, '已发布附件需通过编辑记录移入回收站')
            if row['discarded_at'] is None:
                db.execute('UPDATE media SET discarded_at=?,revision=revision+1 WHERE id=?', (now(), str(identifier)))

    def response_info(self, identifier, range_header, download=False):
        item = self.get(identifier)
        if item['status'] != 'ready': fail(409, '文件尚未完整入库，不能下载')
        info = self.inspect(identifier)
        if not info or info['sha256'] != item['sha256']: fail(503, '原件数据库缺失或不完整，请检查主机存储')
        selected = byte_range(range_header, item['size'])
        headers = {'Accept-Ranges': 'bytes', 'ETag': '"' + item['sha256'] + '"',
                   'Content-Security-Policy': "sandbox; default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin'}
        if selected is None:
            headers['Content-Range'] = f"bytes */{item['size']}"
            return item, None, headers
        start, end, partial = selected
        headers['Content-Length'] = str(max(0, end - start + 1))
        if partial: headers['Content-Range'] = f"bytes {start}-{end}/{item['size']}"
        disposition = 'attachment' if download or item['kind'] == 'document' else 'inline'
        headers['Content-Disposition'] = f"{disposition}; filename=\"original\"; filename*=UTF-8''{quote(item['name'], safe='')}"
        return item, selected, headers

    def content(self, identifier, start, end):
        if end < start: return
        db = sqlite3.connect(self.object_path(identifier).as_uri() + '?mode=ro', uri=True, check_same_thread=False)
        try:
            for position, raw in db.execute('SELECT position,data FROM chunks WHERE position BETWEEN ? AND ? ORDER BY position',
                                            (start // CHUNK, end // CHUNK)):
                offset = position * CHUNK
                yield raw[max(0, start-offset):min(len(raw), end-offset+1)]
        finally: db.close()

    def album(self, page, size):
        base = (" FROM entry_media a JOIN media m ON m.id=a.media_id JOIN entries e ON e.id=a.entry_id "
                "WHERE a.deleted_at IS NULL AND e.deleted_at IS NULL AND m.status='ready' AND m.kind IN ('image','video')")
        with self.database.connect() as db:
            total = db.execute('SELECT COUNT(*)' + base).fetchone()[0]
            rows = db.execute('SELECT m.*,e.id AS entry_id,e.title AS entry_title,e.occurred_on' + base +
                              ' ORDER BY e.occurred_on DESC,e.id DESC,a.position LIMIT ? OFFSET ?', (size, (page-1)*size))
            return page_result([{**descriptor(r), 'entry_id': r['entry_id'], 'entry_title': r['entry_title'],
                                 'date': r['occurred_on']} for r in rows], total, page, size)
