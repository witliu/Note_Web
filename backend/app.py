"""Development server with explicit local/LAN host allowlists."""
import os
import ipaddress
import sqlite3
import re
import anyio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .database import Database
from .models import AnniversaryInput, DraftInput, PublishInput, Revision, StoryInput, WishInput, WishStatus, FootprintInput
from .anniversaries import Anniversaries
from .wishes import Wishes
from .footprints import Footprints
from .auth import Auth, COOKIE, SESSION_SECONDS
from .quizzes import Quizzes
from .models import AccountSetup, LoginInput, QuestionInput, QuizAnswerInput
from .models import MediaInit, MediaDiscard
from .media import MediaStore, ObjectWriter
from .repository import Journal

ROOT = Path(__file__).resolve().parent.parent


def create_app(db_path=None, allowed_hosts=None):
    path = Path(db_path or os.environ.get('JOURNAL_DB_PATH', ROOT / 'data' / 'journal.sqlite3'))

    @asynccontextmanager
    async def lifespan(app):
        app.state.journal = Journal(Database(path))
        store = MediaStore(app.state.journal.database)
        first = store.acquire()
        app.state.media = store
        try:
            if first: store.recover()
            yield
        finally: store.release()

    app = FastAPI(title='最爱老婆 · 本地开发 API', lifespan=lifespan)
    hosts = ['127.0.0.1', 'localhost', '[::1]', 'testserver']
    hosts.extend(allowed_hosts or [])
    hosts.extend(h.strip() for h in os.environ.get('JOURNAL_ALLOWED_HOSTS', '').split(',') if h.strip())
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(dict.fromkeys(hosts)))

    @app.middleware('http')
    async def local_boundary(request: Request, call_next):
        if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
            origin = request.headers.get('origin')
            if origin and (urlsplit(origin).netloc != request.headers.get('host')
                           or urlsplit(origin).scheme not in {'http', 'https'}):
                return JSONResponse({'detail': '不接受跨站写入请求'}, status_code=403)
            if request.headers.get('sec-fetch-site') == 'cross-site':
                return JSONResponse({'detail': '不接受跨站写入请求'}, status_code=403)
            raw_upload = request.method == 'PUT' and re.fullmatch(r'/api/media/[0-9a-fA-F-]{36}/content', request.url.path)
            if raw_upload and request.headers.get('content-type', '').split(';')[0] != 'application/octet-stream':
                return JSONResponse({'detail': '上传文件请使用 application/octet-stream'}, status_code=415)
            if not raw_upload and not request.headers.get('content-type', '').startswith('application/json'):
                return JSONResponse({'detail': '请使用 JSON 请求'}, status_code=415)
            # Bound actual bytes as well as declared Content-Length (including chunked requests).
            if not raw_upload:
                body = bytearray()
                async for chunk in request.stream():
                    body.extend(chunk)
                    if len(body) > 1024 * 1024:
                        return JSONResponse({'detail': '文字请求超过 1 MiB 限制'}, status_code=413)
                request._body = bytes(body)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.exception_handler(sqlite3.Error)
    async def database_error(request, exc):
        return JSONResponse({'detail': '数据库操作失败，当前修改未提交。请保留文字并检查磁盘或稍后重试。'}, status_code=503)

    def journal():
        return app.state.journal

    def media():
        return app.state.media

    @app.get('/api/media/config')
    def media_config():
        return {'max_file_size': media().max_size, 'max_attachments': 50}

    @app.post('/api/media')
    def init_media(data: MediaInit):
        return media().init(data)

    @app.get('/api/media/drafts/{identifier}')
    def draft_media(identifier: UUID):
        return media().for_draft(identifier)

    @app.get('/api/media/{identifier}')
    def media_metadata(identifier: UUID):
        return media().get(identifier)

    @app.post('/api/media/{identifier}/discard')
    def discard_media(identifier: UUID, data: MediaDiscard):
        media().discard(identifier, data.draft_id)
        return {'ok': True}

    @app.put('/api/media/{identifier}/content')
    async def upload_media(identifier: UUID, request: Request):
        item = await run_in_threadpool(media().get, identifier)
        if request.headers.get('content-length') is not None:
            try: size = int(request.headers['content-length'])
            except ValueError: raise HTTPException(400, '文件长度无效')
            if size != item['expected_size']: raise HTTPException(422, '文件大小与上传任务不一致')
        writer, claimed = None, False
        try:
            row = await run_in_threadpool(media().claim, identifier); claimed = True
            writer = await run_in_threadpool(ObjectWriter, media(), row)
            async for chunk in request.stream():
                if chunk: await run_in_threadpool(writer.write, chunk)
            return await run_in_threadpool(writer.finish)
        except BaseException as exc:
            with anyio.CancelScope(shield=True):
                if writer: await run_in_threadpool(writer.abort)
                if claimed: await run_in_threadpool(media().failed, identifier)
            if isinstance(exc, HTTPException): raise
            if isinstance(exc, ClientDisconnect): raise HTTPException(400, '上传连接中断，请重新上传这个文件')
            if isinstance(exc, OSError): raise HTTPException(507 if exc.errno == 28 else 503, '文件入库失败，请检查磁盘空间后重试')
            raise

    @app.api_route('/api/media/{identifier}/content', methods=['GET', 'HEAD'])
    def media_content(identifier: UUID, request: Request, download: bool = False):
        item, selected, headers = media().response_info(identifier, request.headers.get('range'), download)
        if selected is None: return Response(status_code=416, headers=headers)
        start, end, partial = selected
        status = 206 if partial else 200
        mime = item['mime'] if item['kind'] != 'document' and not download else 'application/octet-stream'
        if request.method == 'HEAD': return Response(status_code=status, headers=headers, media_type=mime)
        return StreamingResponse(media().content(identifier, start, end), status_code=status, headers=headers, media_type=mime)

    @app.get('/api/album')
    def album(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
        return media().album(page, page_size)

    def auth():
        return Auth(journal().database)

    def quiz_user(request):
        return auth().require(request.cookies.get(COOKIE))

    def local_setup(request):
        try:
            return ipaddress.ip_address(request.client.host).is_loopback
        except (ValueError, AttributeError):
            return False

    @app.get('/api/auth/status')
    def auth_status(request: Request):
        return {'configured': auth().configured(), 'can_setup': local_setup(request),
                'user': auth().user(request.cookies.get(COOKIE))}

    @app.post('/api/auth/setup')
    def setup_accounts(data: AccountSetup, request: Request):
        if not local_setup(request):
            return JSONResponse({'detail': '请在服务主机打开 http://127.0.0.1:8000 设置两人账号'}, status_code=403)
        auth().setup(data)
        return {'ok': True}

    @app.post('/api/auth/login')
    def login(data: LoginInput, request: Request, response: Response):
        token, user = auth().login(data, request.client.host if request.client else 'unknown', request.cookies.get(COOKIE))
        response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True,
                            samesite='strict', secure=request.url.scheme == 'https', path='/')
        return {'user': user}

    @app.post('/api/auth/logout')
    def logout(request: Request, response: Response):
        auth().logout(request.cookies.get(COOKIE))
        response.delete_cookie(COOKIE, path='/', httponly=True, samesite='strict')
        return {'ok': True}

    @app.get('/api/quizzes')
    def quizzes(request: Request, tab: Literal['pending', 'created', 'history'] = 'pending',
                page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
        return Quizzes(journal().database).list(quiz_user(request), tab, page, page_size)

    @app.post('/api/quizzes')
    def create_quiz(data: QuestionInput, request: Request):
        return Quizzes(journal().database).create(data, quiz_user(request))

    @app.get('/api/quizzes/{identifier}')
    def quiz(identifier: UUID, request: Request):
        return Quizzes(journal().database).get(identifier, quiz_user(request))

    @app.post('/api/quizzes/{identifier}/answers')
    def answer_quiz(identifier: UUID, data: QuizAnswerInput, request: Request):
        return Quizzes(journal().database).answer(identifier, data, quiz_user(request))

    @app.get('/api/health')
    def health():
        with journal().database.connect() as db:
            version = db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0]
        return {'status': 'ok', 'schema_version': version, 'stage': 'text-development'}

    @app.get('/api/entries')
    def entries(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
                q: str = Query('', max_length=200), year: int | None = Query(None, ge=1, le=9998),
                month: int | None = Query(None, ge=1, le=12), tag: str = Query('', max_length=40),
                story: UUID | None = None, order: Literal['asc', 'desc'] = 'desc',
                media_type: Literal['all', 'text', 'image', 'video', 'audio', 'document'] = 'all'):
        return journal().list_entries(page, page_size, q, year, month, tag, story, order == 'asc', media_type)

    @app.get('/api/entries/{identifier}')
    def entry(identifier: UUID):
        return journal().get_entry(identifier)

    @app.post('/api/entries')
    def publish(data: PublishInput):
        return journal().publish(data)

    @app.post('/api/entries/{identifier}/trash')
    def delete_entry(identifier: UUID, data: Revision):
        journal().soft_delete('entry', identifier, data.revision)
        return {'ok': True}

    @app.get('/api/entries/{identifier}/history')
    def history(identifier: UUID, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
        return journal().history(identifier, page, page_size)

    @app.post('/api/entries/{identifier}/history/{history_id}/restore')
    def restore_history(identifier: UUID, history_id: UUID, data: Revision):
        return journal().restore_history(identifier, history_id, data.revision)

    @app.get('/api/stories')
    def stories(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
        return journal().list_stories(page, page_size)

    @app.get('/api/stories/{identifier}')
    def story(identifier: UUID):
        return journal().get_story(identifier)

    @app.post('/api/stories', status_code=201)
    def new_story(data: StoryInput):
        return journal().create_story(data)

    @app.post('/api/stories/{identifier}/trash')
    def delete_story(identifier: UUID, data: Revision):
        journal().soft_delete('story', identifier, data.revision)
        return {'ok': True}

    @app.get('/api/drafts')
    def drafts(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
        return journal().list_drafts(page, page_size)

    @app.put('/api/drafts/{identifier}')
    def save_draft(identifier: UUID, data: DraftInput):
        return journal().save_draft(identifier, data)

    @app.get('/api/trash')
    def trash(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
        return journal().trash(page, page_size)

    @app.post('/api/trash/{kind}/{identifier}/restore')
    def restore(kind: Literal['entry', 'story', 'anniversary', 'wish', 'footprint', 'attachment', 'upload'], identifier: UUID, data: Revision):
        journal().restore(kind, identifier, data.revision)
        return {'ok': True}

    @app.get('/api/filters')
    def filters():
        return journal().filters()

    @app.get('/api/anniversaries')
    def anniversaries(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
        return Anniversaries(journal().database).list(page, page_size)

    @app.get('/api/anniversaries/reminders')
    def anniversary_reminders(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
        return Anniversaries(journal().database).list(page, page_size, reminders=True)

    @app.post('/api/anniversaries')
    def save_anniversary(data: AnniversaryInput):
        return Anniversaries(journal().database).save(data)

    @app.post('/api/anniversaries/{identifier}/trash')
    def trash_anniversary(identifier: UUID, data: Revision):
        journal().soft_delete('anniversary', identifier, data.revision)
        return {'ok': True}

    @app.get('/api/wishes')
    def wishes(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
               status: Literal['all', 'pending', 'done'] = 'all', q: str = Query('', max_length=200)):
        return Wishes(journal().database).list(page, page_size, status, q.strip())

    @app.post('/api/wishes')
    def save_wish(data: WishInput):
        return Wishes(journal().database).save(data)

    @app.post('/api/wishes/{identifier}/status')
    def wish_status(identifier: UUID, data: WishStatus):
        return Wishes(journal().database).set_status(identifier, data)

    @app.post('/api/wishes/{identifier}/trash')
    def trash_wish(identifier: UUID, data: Revision):
        journal().soft_delete('wish', identifier, data.revision)
        return {'ok': True}

    @app.get('/api/footprints')
    def footprints(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
                   q: str = Query('', max_length=200)):
        return Footprints(journal().database).list(page, page_size, q.strip())

    @app.get('/api/footprints/markers')
    def footprint_markers(west: float = Query(72, ge=-180, le=180), south: float = Query(2, ge=-85, le=85),
                          east: float = Query(136, ge=-180, le=180), north: float = Query(55, ge=-85, le=85),
                          limit: int = Query(500, ge=1, le=1000), q: str = Query('', max_length=200)):
        return Footprints(journal().database).markers(west, south, east, north, limit, q.strip())

    @app.get('/api/footprints/{identifier}')
    def footprint(identifier: UUID):
        return Footprints(journal().database).get(identifier)

    @app.post('/api/footprints')
    def save_footprint(data: FootprintInput):
        return Footprints(journal().database).save(data)

    @app.post('/api/footprints/{identifier}/trash')
    def trash_footprint(identifier: UUID, data: Revision):
        journal().soft_delete('footprint', identifier, data.revision)
        return {'ok': True}

    @app.get('/')
    def index():
        return FileResponse(ROOT / 'web' / 'index.html', headers={'Cache-Control': 'no-cache'})

    @app.get('/app.js')
    def script():
        return FileResponse(ROOT / 'web' / 'app.js', media_type='application/javascript')

    @app.get('/sw.js')
    def worker():
        return FileResponse(ROOT / 'web' / 'sw.js', media_type='application/javascript',
                            headers={'Cache-Control': 'no-cache'})

    @app.get('/styles.css')
    def styles():
        return FileResponse(ROOT / 'couple-journal' / 'styles.css', media_type='text/css')

    @app.get('/server.css')
    def server_styles():
        return FileResponse(ROOT / 'web' / 'server.css', media_type='text/css')

    @app.get('/map.js')
    def map_script():
        return FileResponse(ROOT / 'web' / 'map.js', media_type='application/javascript')

    @app.get('/quizzes.js')
    def quiz_script():
        return FileResponse(ROOT / 'web' / 'quizzes.js', media_type='application/javascript')

    @app.get('/media.js')
    def media_script():
        return FileResponse(ROOT / 'web' / 'media.js', media_type='application/javascript')

    # Serve only public images; project source, .git, data, and backups are never mounted.
    app.mount('/assets', StaticFiles(directory=ROOT / 'couple-journal' / 'assets'), name='assets')
    app.mount('/map-data', StaticFiles(directory=ROOT / 'web' / 'map-data'), name='map-data')
    app.mount('/vendor/leaflet', StaticFiles(directory=ROOT / 'web' / 'vendor' / 'leaflet'), name='leaflet')
    return app


app = create_app()
