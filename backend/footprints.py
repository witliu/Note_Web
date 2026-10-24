from .repository import Journal, fail, now, page_result


class Footprints:
    def __init__(self, database):
        self.database = database

    @staticmethod
    def search(q):
        if not q:
            return '', []
        pattern = '%' + q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        return " AND (name LIKE ? ESCAPE '\\' OR province LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')", [pattern] * 3

    def list(self, page, size, q=''):
        search, args = self.search(q)
        with self.database.connect() as db:
            total = db.execute('SELECT COUNT(*) FROM footprints WHERE deleted_at IS NULL' + search, args).fetchone()[0]
            rows = db.execute('SELECT * FROM footprints WHERE deleted_at IS NULL' + search +
                              ' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?', [*args, size, (page - 1) * size])
            return page_result([dict(row) for row in rows], total, page, size)

    def markers(self, west, south, east, north, limit, q=''):
        if west > east or south > north:
            fail(422, '地图范围无效')
        search, args = self.search(q)
        with self.database.connect() as db:
            rows = db.execute('SELECT id,name,longitude,latitude,province FROM footprints '
                              'WHERE deleted_at IS NULL AND longitude BETWEEN ? AND ? '
                              'AND latitude BETWEEN ? AND ?' + search +
                              ' ORDER BY created_at DESC,id DESC LIMIT ?', [west, east, south, north, *args, limit + 1]).fetchall()
            return {'items': [dict(row) for row in rows[:limit]], 'has_more': len(rows) > limit, 'limit': limit}

    def get(self, identifier):
        with self.database.connect() as db:
            return dict(Journal.require(db, 'footprints', identifier))

    def save(self, data):
        identifier, timestamp = str(data.id), now()
        visited = data.visited_on.isoformat() if data.visited_on else None
        with self.database.connect(write=True) as db:
            row = db.execute('SELECT * FROM footprints WHERE id=?', (identifier,)).fetchone()
            if row:
                if row['deleted_at']:
                    fail(409, '这个地点已进入回收站，请先恢复')
                Journal.check_revision(row, data.revision)
                db.execute('UPDATE footprints SET name=?,province=?,longitude=?,latitude=?,visited_on=?,note=?,'
                           'updated_at=?,revision=revision+1 WHERE id=?',
                           (data.name, data.province, data.longitude, data.latitude, visited, data.note, timestamp, identifier))
            else:
                if data.revision:
                    fail(404, '地点不存在')
                db.execute('INSERT INTO footprints(id,name,province,longitude,latitude,visited_on,note,created_at,updated_at) '
                           'VALUES(?,?,?,?,?,?,?,?,?)', (identifier, data.name, data.province, data.longitude,
                           data.latitude, visited, data.note, timestamp, timestamp))
            return dict(Journal.require(db, 'footprints', identifier))
