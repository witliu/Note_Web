"""Disposable JPEG preview cache; immutable originals remain in their chunk databases."""
import hashlib
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading

from .repository import fail
from .preview_worker import MAX_BYTES

_gate = threading.Lock()
VERSION = 1


def decode(data):
    try:
        result = subprocess.run(
            [sys.executable, '-m', 'backend.preview_worker'], input=data, capture_output=True,
            cwd=Path(__file__).resolve().parents[1], timeout=60,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
            env={**os.environ, 'OMP_NUM_THREADS': '2'},
        )
    except subprocess.TimeoutExpired:
        fail(504, 'DNG 预览生成超时，原件可正常下载')
    if result.returncode or not result.stdout.startswith(b'\xff\xd8\xff'):
        fail(422, '此 DNG 暂时无法生成预览，原件可正常下载')
    return result.stdout


def preview(store, identifier):
    item = store.get(identifier)
    if item['status'] != 'ready': fail(409, '文件尚未完整入库')
    if item['discarded']: fail(404, '文件已移入回收站')
    if item['kind'] != 'image' or Path(item['name']).suffix.lower() != '.dng':
        fail(415, '此文件无需 DNG 预览转换')
    if item['size'] > MAX_BYTES: fail(413, 'DNG 预览当前支持 128 MiB 以内的原件，可下载原件查看')
    # Keep cache generation serial and time-bounded; every decoder runs in a child process.
    if not _gate.acquire(timeout=65): fail(503, '预览正在生成，请稍后重试')
    try:
        cache = store.root / 'previews.sqlite3'
        with sqlite3.connect(cache) as db:
            db.execute('CREATE TABLE IF NOT EXISTS previews '
                       '(media_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, version INTEGER NOT NULL, jpeg BLOB NOT NULL)')
            row = db.execute('SELECT jpeg FROM previews WHERE media_id=? AND sha256=? AND version=?',
                             (str(identifier), item['sha256'], VERSION)).fetchone()
            if row:
                return bytes(row[0])
            # Validate object metadata before reading its original chunks.
            store.response_info(identifier, None)
            data = b''.join(store.content(identifier, 0, item['size'] - 1))
            if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                fail(503, '原件数据校验失败，请检查主机存储')
            output = decode(data)
            db.execute('INSERT OR REPLACE INTO previews VALUES(?,?,?,?)',
                       (str(identifier), item['sha256'], VERSION, output))
            return output
    finally:
        _gate.release()
