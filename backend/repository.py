import json
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException

from .database import Database


def now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def fail(status, message):
    raise HTTPException(status, message)


def page_result(items, total, page, size):
    return {'items': items, 'total': total, 'page': page, 'page_size': size,
            'has_more': page * size < total}


class Journal:
    def __init__(self, database: Database):
        self.database = database

    @staticmethod
    def require(db, table, identifier, deleted=False):
        row = db.execute(f'SELECT * FROM {table} WHERE id=? AND deleted_at IS '
                         + ('NOT NULL' if deleted else 'NULL'), (str(identifier),)).fetchone()
        if row is None:
            fail(404, '内容不存在或状态已改变，请刷新后重试')
        return row

    @staticmethod
    def check_revision(row, revision):
        if row['revision'] != revision:
            fail(409, '内容已在另一页面修改。请保留当前文字，刷新后再编辑。')

    @staticmethod
    def entry(db, row):
        result = dict(row)
        result['date'] = result.pop('occurred_on')
        result['story'] = result.pop('story_id')
        result['tags'] = [t[0] for t in db.execute(
            'SELECT tag FROM entry_tags WHERE entry_id=? ORDER BY tag', (row['id'],))]
        from .media import attachment_rows
        result['attachments'] = attachment_rows(db, row['id'])
        result['attachment_ids'] = [a['id'] for a in result['attachments']]
        result['history_count'] = db.execute(
            'SELECT COUNT(*) FROM text_history WHERE entry_id=?', (row['id'],)).fetchone()[0]
        return result

    def list_entries(self, page, size, q='', year=None, month=None, tag='', story=None, asc=False, media_type='all'):
        where, args = ['e.deleted_at IS NULL'], []
        if q:
            # Escape LIKE wildcards so a user's % or _ is searched literally.
            pattern = '%' + q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
            where.append("(e.title LIKE ? ESCAPE '\\' OR e.body LIKE ? ESCAPE '\\' OR e.place LIKE ? ESCAPE '\\' "
                         "OR EXISTS(SELECT 1 FROM entry_media a JOIN media m ON m.id=a.media_id WHERE a.entry_id=e.id "
                         "AND a.deleted_at IS NULL AND m.name LIKE ? ESCAPE '\\'))")
            args.extend([pattern] * 4)
        if media_type == 'text':
            where.append('NOT EXISTS(SELECT 1 FROM entry_media a WHERE a.entry_id=e.id AND a.deleted_at IS NULL)')
        elif media_type != 'all':
            where.append('EXISTS(SELECT 1 FROM entry_media a JOIN media m ON m.id=a.media_id WHERE a.entry_id=e.id '
                         'AND a.deleted_at IS NULL AND m.kind=?)')
            args.append(media_type)
        if year:
            start = f'{year:04d}-{month or 1:02d}-01'
            end = (f'{year + 1:04d}-01-01' if not month or month == 12
                   else f'{year:04d}-{month + 1:02d}-01')
            where.append('e.occurred_on>=? AND e.occurred_on<?')
            args.extend([start, end])
        elif month:
            where.append('substr(e.occurred_on,6,2)=?')
            args.append(f'{month:02d}')
        if tag:
            where.append('EXISTS(SELECT 1 FROM entry_tags t WHERE t.entry_id=e.id AND t.tag=?)')
            args.append(tag)
        if story:
            where.append('e.story_id=? AND EXISTS(SELECT 1 FROM stories s WHERE s.id=e.story_id AND s.deleted_at IS NULL)')
            args.append(str(story))
        clause = ' AND '.join(where)
        order = 'ASC' if asc else 'DESC'
        with self.database.connect() as db:
            total = db.execute('SELECT COUNT(*) FROM entries e WHERE ' + clause, args).fetchone()[0]
            rows = db.execute('SELECT e.* FROM entries e WHERE ' + clause +
                              f' ORDER BY occurred_on {order}, id {order} LIMIT ? OFFSET ?',
                              [*args, size, (page - 1) * size])
            return page_result([self.entry(db, r) for r in rows], total, page, size)

    def get_entry(self, identifier):
        with self.database.connect() as db:
            return self.entry(db, self.require(db, 'entries', identifier))

    def publish(self, data):
        payload = data.model_dump(mode='json')
        identifier, timestamp = str(data.id), now()
        with self.database.connect(write=True) as db:
            row = db.execute('SELECT * FROM entries WHERE id=?', (identifier,)).fetchone()
            if row:
                if row['deleted_at'] is not None:
                    fail(409, '记录已移入回收站，请先恢复')
                self.check_revision(row, data.revision)
            elif data.revision:
                fail(404, '原记录不存在')
            if data.story:
                self.require(db, 'stories', data.story)
            if data.draft_id:
                draft = self.require(db, 'drafts', data.draft_id)
                self.check_revision(draft, data.draft_revision)
                if json.loads(draft['payload'])['entry_id'] != identifier:
                    fail(409, '草稿与记录不匹配，当前修改未提交')
            from .media import validate_attachments
            validate_attachments(db, data.attachment_ids, data.draft_id, identifier)
            if row:
                if row['title'] != data.title or row['body'] != data.body:
                    db.execute('INSERT INTO text_history VALUES(?,?,?,?,?)',
                               (str(uuid4()), identifier, row['title'], row['body'], timestamp))
                db.execute('UPDATE entries SET title=?,body=?,occurred_on=?,place=?,story_id=?, '
                           'revision=revision+1,updated_at=? WHERE id=?',
                           (data.title, data.body, payload['date'], data.place, payload['story'], timestamp, identifier))
                db.execute('DELETE FROM entry_tags WHERE entry_id=?', (identifier,))
            else:
                db.execute('INSERT INTO entries(id,title,body,occurred_on,place,story_id,created_at,updated_at) '
                           'VALUES(?,?,?,?,?,?,?,?)', (identifier, data.title, data.body,
                           payload['date'], data.place, payload['story'], timestamp, timestamp))
            db.executemany('INSERT INTO entry_tags VALUES(?,?)', [(identifier, t) for t in data.tags])
            selected = [str(i) for i in data.attachment_ids]
            for link in db.execute('SELECT id,media_id FROM entry_media WHERE entry_id=? AND deleted_at IS NULL', (identifier,)).fetchall():
                if link['media_id'] not in selected:
                    db.execute('UPDATE entry_media SET deleted_at=?,revision=revision+1 WHERE id=?', (timestamp, link['id']))
            for position, media_id in enumerate(selected):
                link = db.execute('SELECT id FROM entry_media WHERE entry_id=? AND media_id=?', (identifier, media_id)).fetchone()
                if link:
                    db.execute('UPDATE entry_media SET position=?,deleted_at=NULL,revision=revision+1 WHERE id=?', (position, link['id']))
                else:
                    db.execute('INSERT INTO entry_media(id,entry_id,media_id,position) VALUES(?,?,?,?)',
                               (str(uuid4()), identifier, media_id, position))
            if data.draft_id:
                # Retain the published draft as an internal tombstone, so delayed saves cannot recreate it.
                db.execute('UPDATE drafts SET deleted_at=?,revision=revision+1 WHERE id=?',
                           (timestamp, str(data.draft_id)))
            return self.entry(db, self.require(db, 'entries', identifier))

    def history(self, identifier, page, size):
        with self.database.connect() as db:
            self.require(db, 'entries', identifier)
            total = db.execute('SELECT COUNT(*) FROM text_history WHERE entry_id=?', (str(identifier),)).fetchone()[0]
            rows = db.execute('SELECT * FROM text_history WHERE entry_id=? ORDER BY saved_at DESC,id DESC LIMIT ? OFFSET ?',
                              (str(identifier), size, (page - 1) * size))
            return page_result([dict(r) for r in rows], total, page, size)

    def restore_history(self, identifier, history_id, revision):
        with self.database.connect(write=True) as db:
            entry = self.require(db, 'entries', identifier)
            self.check_revision(entry, revision)
            old = db.execute('SELECT * FROM text_history WHERE id=? AND entry_id=?',
                             (str(history_id), str(identifier))).fetchone()
            if old is None:
                fail(404, '历史版本不存在')
            timestamp = now()
            db.execute('INSERT INTO text_history VALUES(?,?,?,?,?)',
                       (str(uuid4()), str(identifier), entry['title'], entry['body'], timestamp))
            db.execute('UPDATE entries SET title=?,body=?,updated_at=?,revision=revision+1 WHERE id=?',
                       (old['title'], old['body'], timestamp, str(identifier)))
            return self.entry(db, self.require(db, 'entries', identifier))

    def list_stories(self, page, size):
        with self.database.connect() as db:
            total = db.execute('SELECT COUNT(*) FROM stories WHERE deleted_at IS NULL').fetchone()[0]
            rows = db.execute('SELECT s.*, (SELECT COUNT(*) FROM entries e WHERE e.story_id=s.id '
                              'AND e.deleted_at IS NULL) AS entry_count FROM stories s WHERE s.deleted_at IS NULL '
                              'ORDER BY s.created_at DESC,s.id DESC LIMIT ? OFFSET ?', (size, (page - 1) * size))
            return page_result([dict(r) for r in rows], total, page, size)

    def create_story(self, data):
        identifier, timestamp = str(uuid4()), now()
        with self.database.connect(write=True) as db:
            db.execute('INSERT INTO stories(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)',
                       (identifier, data.name, data.description, timestamp, timestamp))
            return dict(self.require(db, 'stories', identifier))

    def get_story(self, identifier):
        with self.database.connect() as db:
            return dict(self.require(db, 'stories', identifier))

    def save_draft(self, identifier, data):
        payload = data.model_dump(mode='json', exclude={'revision'})
        with self.database.connect(write=True) as db:
            from .media import validate_attachments
            validate_attachments(db, data.attachment_ids, identifier, data.editing_id)
            row = db.execute('SELECT * FROM drafts WHERE id=?', (str(identifier),)).fetchone()
            if row:
                if row['deleted_at'] is not None:
                    fail(409, '该草稿已经发布。当前文字仍保存在此设备，可另存为新草稿。')
                self.check_revision(row, data.revision)
                revision = row['revision'] + 1
                db.execute('UPDATE drafts SET payload=?,revision=?,updated_at=? WHERE id=?',
                           (json.dumps(payload, ensure_ascii=False), revision, now(), str(identifier)))
            else:
                if data.revision:
                    fail(409, '原草稿不存在，当前文字仍保存在此设备')
                revision = 1
                db.execute('INSERT INTO drafts(id,payload,revision,updated_at) VALUES(?,?,?,?)',
                           (str(identifier), json.dumps(payload, ensure_ascii=False), revision, now()))
            return {'id': str(identifier), **payload, 'revision': revision}

    def list_drafts(self, page, size):
        with self.database.connect() as db:
            total = db.execute('SELECT COUNT(*) FROM drafts WHERE deleted_at IS NULL').fetchone()[0]
            rows = db.execute('SELECT * FROM drafts WHERE deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?',
                              (size, (page - 1) * size))
            from .media import descriptor
            items = []
            for row in rows:
                payload = json.loads(row['payload'])
                attachments = []
                for identifier in payload.get('attachment_ids', []):
                    media = db.execute("SELECT * FROM media WHERE id=? AND status='ready'", (identifier,)).fetchone()
                    if media: attachments.append(descriptor(media))
                items.append({'id': row['id'], 'revision': row['revision'], 'updated_at': row['updated_at'], **payload, 'attachments': attachments})
            return page_result(items, total, page, size)

    def soft_delete(self, kind, identifier, revision):
        table = {'entry': 'entries', 'story': 'stories', 'anniversary': 'anniversaries', 'wish': 'wishes', 'footprint': 'footprints'}[kind]
        with self.database.connect(write=True) as db:
            row = self.require(db, table, identifier)
            self.check_revision(row, revision)
            timestamp = now()
            db.execute(f'UPDATE {table} SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?',
                       (timestamp, timestamp, str(identifier)))
            if kind == 'story':
                # Unclassify active records transactionally; trashed records retain their
                # previous association for restoration if the story is restored first.
                db.execute('UPDATE entries SET story_id=NULL,revision=revision+1,updated_at=? '
                           'WHERE story_id=? AND deleted_at IS NULL', (timestamp, str(identifier)))
            # No record, original, tag, or history is removed.

    def trash(self, page, size):
        query = ("SELECT id, title AS name, deleted_at, revision, 'entry' AS kind FROM entries WHERE deleted_at IS NOT NULL "
                 "UNION ALL SELECT id, name, deleted_at, revision, 'story' AS kind FROM stories WHERE deleted_at IS NOT NULL "
                 "UNION ALL SELECT id, name, deleted_at, revision, 'anniversary' AS kind FROM anniversaries WHERE deleted_at IS NOT NULL "
                 "UNION ALL SELECT id, title AS name, deleted_at, revision, 'wish' AS kind FROM wishes WHERE deleted_at IS NOT NULL "
                 "UNION ALL SELECT id, name, deleted_at, revision, 'footprint' AS kind FROM footprints WHERE deleted_at IS NOT NULL "
                 "UNION ALL SELECT a.id,m.name,a.deleted_at,a.revision,'attachment' AS kind FROM entry_media a "
                 "JOIN media m ON m.id=a.media_id WHERE a.deleted_at IS NOT NULL "
                 "UNION ALL SELECT id,name,discarded_at AS deleted_at,revision,'upload' AS kind FROM media WHERE discarded_at IS NOT NULL")
        with self.database.connect() as db:
            total = db.execute('SELECT COUNT(*) FROM (' + query + ')').fetchone()[0]
            rows = db.execute('SELECT * FROM (' + query + ') ORDER BY deleted_at DESC,id DESC LIMIT ? OFFSET ?',
                              (size, (page - 1) * size))
            return page_result([dict(r) for r in rows], total, page, size)

    def restore(self, kind, identifier, revision):
        if kind in ('attachment', 'upload'):
            return self.restore_media(kind, identifier, revision)
        table = {'entry': 'entries', 'story': 'stories', 'anniversary': 'anniversaries', 'wish': 'wishes', 'footprint': 'footprints'}[kind]
        with self.database.connect(write=True) as db:
            row = self.require(db, table, identifier, deleted=True)
            self.check_revision(row, revision)
            if kind == 'entry' and row['story_id']:
                story = db.execute('SELECT deleted_at FROM stories WHERE id=?', (row['story_id'],)).fetchone()
                if not story or story['deleted_at']:
                    db.execute('UPDATE entries SET story_id=NULL WHERE id=?', (str(identifier),))
            db.execute(f'UPDATE {table} SET deleted_at=NULL,updated_at=?,revision=revision+1 WHERE id=?',
                       (now(), str(identifier)))

    def restore_media(self, kind, identifier, revision):
        with self.database.connect(write=True) as db:
            if kind == 'attachment':
                link = self.require(db, 'entry_media', identifier, deleted=True)
                self.check_revision(link, revision)
                entry_id = link['entry_id']
                self.require(db, 'entries', entry_id)
                count = db.execute('SELECT COUNT(*) FROM entry_media WHERE entry_id=? AND deleted_at IS NULL', (entry_id,)).fetchone()[0]
                if count >= 50: fail(409, '记录已有 50 个附件，请先整理后恢复')
                position = db.execute('SELECT COALESCE(MAX(position),-1)+1 FROM entry_media WHERE entry_id=?', (entry_id,)).fetchone()[0]
                db.execute('UPDATE entry_media SET deleted_at=NULL,position=?,revision=revision+1 WHERE id=?', (position, str(identifier)))
                db.execute('UPDATE entries SET revision=revision+1,updated_at=? WHERE id=?', (now(), entry_id))
            else:
                media = db.execute('SELECT * FROM media WHERE id=? AND discarded_at IS NOT NULL', (str(identifier),)).fetchone()
                if not media: fail(404, '文件不在回收站')
                self.check_revision(media, revision)
                draft = db.execute('SELECT * FROM drafts WHERE id=?', (media['draft_id'],)).fetchone()
                payload = json.loads(draft['payload'])
                if draft['deleted_at'] is None:
                    identifiers = payload.get('attachment_ids', [])
                    if media['id'] not in identifiers and len(identifiers) >= 50: fail(409, '草稿附件已满，请先整理后恢复')
                    if media['status'] == 'ready' and media['id'] not in identifiers: identifiers.append(media['id'])
                    payload['attachment_ids'] = identifiers
                    db.execute('UPDATE drafts SET payload=?,revision=revision+1,updated_at=? WHERE id=?',
                               (json.dumps(payload, ensure_ascii=False), now(), draft['id']))
                else:
                    entry = self.require(db, 'entries', payload['entry_id'])
                    if media['status'] != 'ready': fail(409, '未完成的文件需要在草稿中重新上传')
                    count = db.execute('SELECT COUNT(*) FROM entry_media WHERE entry_id=? AND deleted_at IS NULL', (entry['id'],)).fetchone()[0]
                    if count >= 50: fail(409, '记录附件已满，请先整理后恢复')
                    position = db.execute('SELECT COALESCE(MAX(position),-1)+1 FROM entry_media WHERE entry_id=?', (entry['id'],)).fetchone()[0]
                    db.execute('INSERT INTO entry_media(id,entry_id,media_id,position) VALUES(?,?,?,?)',
                               (str(uuid4()), entry['id'], media['id'], position))
                    db.execute('UPDATE entries SET revision=revision+1,updated_at=? WHERE id=?', (now(), entry['id']))
                db.execute('UPDATE media SET discarded_at=NULL,revision=revision+1 WHERE id=?', (media['id'],))

    def filters(self):
        with self.database.connect() as db:
            years = [r[0] for r in db.execute("SELECT DISTINCT substr(occurred_on,1,4) AS year FROM entries "
                                            'WHERE deleted_at IS NULL ORDER BY year DESC LIMIT 200')]
            tags = [r[0] for r in db.execute('SELECT DISTINCT t.tag FROM entry_tags t JOIN entries e ON e.id=t.entry_id '
                                           'WHERE e.deleted_at IS NULL ORDER BY t.tag LIMIT 200')]
            return {'years': years, 'tags': tags}
