"""Offline Windows OCR; image bytes stay in memory and never enter a cloud API."""
import base64
import json
import os
import re
from pathlib import Path
import subprocess
import threading
import time

from .repository import fail

SCRIPT = Path(__file__).resolve().parent.parent / 'scripts' / 'ocr.ps1'
MAX_OCR_BYTES = 20 * 1024 * 1024
_gate = threading.BoundedSemaphore(1)
_status = None
_checked_at = 0
_CJK = '\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U000323af'
_CHINESE_PUNCTUATION = '，。！？；：、（）【】《》“”‘’…—'
_OCR_SPACES = re.compile(
    rf'(?<=[{_CJK}{_CHINESE_PUNCTUATION}])[^\S\r\n\v\f\x85\u2028\u2029]+(?=[{_CJK}{_CHINESE_PUNCTUATION}])')


def normalize_text(text):
    """Remove OCR-inserted horizontal gaps inside Chinese text, preserving word/line boundaries."""
    return _OCR_SPACES.sub('', text)


def invoke(payload=None):
    command = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT)]
    if payload is None: command.append('-Check')
    result = subprocess.run(command, input=json.dumps(payload).encode('utf-8') if payload else None,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10 if payload is None else 60,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try: data = json.loads(result.stdout.decode('utf-8-sig'))
    except (ValueError, UnicodeError): raise RuntimeError('OCR unavailable')
    if result.returncode or 'error' in data: raise RuntimeError('OCR failed')
    return data


def status():
    global _status, _checked_at
    if _status is not None and time.monotonic() - _checked_at < 300: return _status
    result = {'available': False, 'languages': [], 'engine': 'windows-local'}
    if os.name == 'nt':
        try: result = invoke()
        except (OSError, RuntimeError, subprocess.TimeoutExpired): pass
    _status, _checked_at = result, time.monotonic()
    return result


def recognize(store, identifier):
    item = store.get(identifier)
    if item['status'] != 'ready' or item['discarded']: fail(409, '请先完成图片上传，或恢复已移除的图片')
    if item['kind'] != 'image': fail(422, '文字识别只支持图片')
    if item['size'] > MAX_OCR_BYTES: fail(413, '图片文字识别上限为 20 MiB；可以保留原图并手动填写文字')
    if not _gate.acquire(blocking=False): fail(429, '另一张图片正在识别，请稍后再试')
    try:
        if not status()['available']: fail(503, '主机暂不可用本地文字识别，请手动填写，或安装 Windows OCR 语言包后重试')
        # Check the stored object before reading it; the unchanged original remains in SQLite.
        store.response_info(identifier, None)
        raw = b''.join(store.content(identifier, 0, item['size'] - 1))
        result = invoke({'image': base64.b64encode(raw).decode('ascii')})
        return {**result, 'media_id': str(identifier), 'text': normalize_text(result.get('text', ''))[:100000]}
    except subprocess.TimeoutExpired:
        fail(504, '识别超时，原图和正文已保留；可重新识别或手动填写')
    except (OSError, RuntimeError):
        fail(422, '暂时无法识别这张图片，请尝试清晰的 JPG/PNG 图片或手动填写；原图仍保留')
    finally: _gate.release()
