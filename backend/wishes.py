"""Shared wish list: short writes, optimistic versions, and paginated reads."""
from .repository import Journal, fail, now, page_result


def wish_row(row):
    result = dict(row)
    result['done'] = bool(result['done'])
    return result


class Wishes:
    def __init__(self, database):
        self.database = database

    def list(self, page, size, status='all', q=''):
        where, args = ['deleted_at IS NULL'], []
        if status != 'all':
            where.append('done=?')
            args.append(int(status == 'done'))
        if q:
            pattern = '%' + q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
            where.append("(title LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')")
            args.extend([pattern, pattern])
        clause = ' AND '.join(where)
        with self.database.connect() as db:
            total = db.execute('SELECT COUNT(*) FROM wishes WHERE ' + clause, args).fetchone()[0]
            rows = db.execute('SELECT * FROM wishes WHERE ' + clause +
                              ' ORDER BY done ASC,CASE WHEN done=1 THEN completed_at ELSE created_at END DESC,'
                              'id DESC LIMIT ? OFFSET ?', [*args, size, (page - 1) * size])
            result = page_result([wish_row(row) for row in rows], total, page, size)
            counts = db.execute('SELECT COUNT(*) AS total,COALESCE(SUM(done),0) AS done '
                                'FROM wishes WHERE deleted_at IS NULL').fetchone()
            result['summary'] = {'total': counts['total'], 'done': counts['done'],
                                 'pending': counts['total'] - counts['done']}
            return result

    def save(self, data):
        identifier, timestamp = str(data.id), now()
        target = data.target_date.isoformat() if data.target_date else None
        with self.database.connect(write=True) as db:
            row = db.execute('SELECT * FROM wishes WHERE id=?', (identifier,)).fetchone()
            if row:
                if row['deleted_at']:
                    fail(409, '这个愿望已进入回收站，请先恢复')
                Journal.check_revision(row, data.revision)
                db.execute('UPDATE wishes SET title=?,note=?,target_date=?,updated_at=?,revision=revision+1 '
                           'WHERE id=?', (data.title, data.note, target, timestamp, identifier))
            else:
                if data.revision:
                    fail(404, '愿望不存在')
                db.execute('INSERT INTO wishes(id,title,note,target_date,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                           (identifier, data.title, data.note, target, timestamp, timestamp))
            return wish_row(Journal.require(db, 'wishes', identifier))

    def set_status(self, identifier, data):
        with self.database.connect(write=True) as db:
            row = Journal.require(db, 'wishes', identifier)
            Journal.check_revision(row, data.revision)
            if bool(row['done']) != data.done:
                timestamp = now()
                db.execute('UPDATE wishes SET done=?,completed_at=?,updated_at=?,revision=revision+1 WHERE id=?',
                           (int(data.done), timestamp if data.done else None, timestamp, str(identifier)))
            return wish_row(Journal.require(db, 'wishes', identifier))
