"""Yearly reminders evaluated against the service's Asia/Shanghai calendar day."""
from datetime import date, datetime, timedelta, timezone

from .repository import Journal, fail, now, page_result


def shanghai_today():
    return datetime.now(timezone(timedelta(hours=8))).date()


def next_occurrence(month, day, start_year, today):
    first = max(today.year, start_year or today.year)
    # A Feb 29 event next occurs on a genuine leap day; never move it to Feb 28.
    for year in range(first, min(first + 9, 10000)):
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if candidate >= today:
            return candidate.isoformat()
    return None


class Anniversaries:
    def __init__(self, database):
        self.database = database

    @staticmethod
    def decorate(row, today):
        result = dict(row)
        result['enabled'] = bool(result['enabled'])
        next_on = result.get('next_on')
        result['days_until'] = (date.fromisoformat(next_on) - today).days if next_on else None
        result['years'] = (date.fromisoformat(next_on).year - result['start_year']
                           if next_on and result['start_year'] else None)
        return result

    def list(self, page, size, reminders=False):
        today = shanghai_today()
        with self.database.connect() as db:
            db.create_function('anniversary_next', 3,
                               lambda month, day, start: next_occurrence(month, day, start, today))
            query = ("SELECT *, CASE WHEN calendar='solar' THEN anniversary_next(month,day,start_year) "
                     'ELSE NULL END AS next_on FROM anniversaries WHERE deleted_at IS NULL')
            where, args = '', []
            if reminders:
                where = ' WHERE enabled=1 AND next_on IS NOT NULL AND julianday(next_on)-julianday(?) BETWEEN 0 AND remind_days'
                args = [today.isoformat()]
            total = db.execute('SELECT COUNT(*) FROM (' + query + ')' + where, args).fetchone()[0]
            rows = db.execute('SELECT * FROM (' + query + ')' + where +
                              ' ORDER BY next_on IS NULL,next_on,month,day,id LIMIT ? OFFSET ?',
                              [*args, size, (page - 1) * size])
            result = page_result([self.decorate(row, today) for row in rows], total, page, size)
            result.update({'today': today.isoformat(), 'timezone': 'Asia/Shanghai'})
            return result

    def save(self, data):
        identifier, timestamp = str(data.id), now()
        with self.database.connect(write=True) as db:
            row = db.execute('SELECT * FROM anniversaries WHERE id=?', (identifier,)).fetchone()
            if row:
                if row['deleted_at']:
                    fail(409, '该纪念日已进入回收站，请先恢复')
                Journal.check_revision(row, data.revision)
                db.execute('UPDATE anniversaries SET name=?,kind=?,calendar=?,month=?,day=?,start_year=?,'
                           'remind_days=?,enabled=?,note=?,updated_at=?,revision=revision+1 WHERE id=?',
                           (data.name, data.kind, data.calendar, data.month, data.day, data.start_year,
                            data.remind_days, int(data.enabled), data.note, timestamp, identifier))
            else:
                if data.revision:
                    fail(404, '纪念日不存在')
                db.execute('INSERT INTO anniversaries(id,name,kind,calendar,month,day,start_year,remind_days,'
                           'enabled,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                           (identifier, data.name, data.kind, data.calendar, data.month, data.day, data.start_year,
                            data.remind_days, int(data.enabled), data.note, timestamp, timestamp))
            return dict(Journal.require(db, 'anniversaries', identifier))
