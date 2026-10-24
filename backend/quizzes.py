import json

from .repository import fail, now, page_result


class Quizzes:
    def __init__(self, database):
        self.database = database

    @staticmethod
    def question(db, identifier):
        row = db.execute('SELECT q.*,a.display_name AS author_name,r.display_name AS recipient_name '
                         'FROM questions q JOIN users a ON a.id=q.author_id JOIN users r ON r.id=q.recipient_id '
                         'WHERE q.id=?', (str(identifier),)).fetchone()
        if row is None:
            fail(404, '题目不存在')
        return row

    @staticmethod
    def visible(row, user):
        if user['id'] not in (row['author_id'], row['recipient_id']):
            fail(403, '这道题不属于当前账号')

    @staticmethod
    def detail(db, row, user):
        Quizzes.visible(row, user)
        answer = db.execute('SELECT * FROM quiz_answers WHERE question_id=?', (row['id'],)).fetchone()
        result = {k: row[k] for k in ['id', 'author_id', 'recipient_id', 'author_name', 'recipient_name', 'kind', 'body', 'created_at']}
        result['options'] = json.loads(row['options_json'])
        result['can_answer'] = user['id'] == row['recipient_id'] and answer is None
        result['answered'] = answer is not None
        if answer:
            result['answer'] = {'id': answer['id'], 'answerer_id': answer['answerer_id'],
                                'selected_option_ids': json.loads(answer['selections_json']),
                                'correct': bool(answer['correct']), 'submitted_at': answer['submitted_at']}
        if user['id'] == row['author_id'] or answer:
            result['correct_option_ids'] = json.loads(row['correct_json'])
            result['explanation'] = row['explanation']
        return result

    def get(self, identifier, user):
        with self.database.connect() as db:
            return self.detail(db, self.question(db, identifier), user)

    def create(self, data, user):
        with self.database.connect(write=True) as db:
            partner = db.execute('SELECT id FROM users WHERE id!=?', (user['id'],)).fetchone()
            if partner is None:
                fail(409, '请先设置两个人的账号')
            existing = db.execute('SELECT * FROM questions WHERE id=?', (str(data.id),)).fetchone()
            if existing:
                fail(409, '题目已发布，请刷新列表查看')
            db.execute('INSERT INTO questions VALUES(?,?,?,?,?,?,?,?,?)',
                       (str(data.id), user['id'], partner['id'], data.kind, data.body,
                        json.dumps([o.model_dump(mode='json') for o in data.options], ensure_ascii=False),
                        json.dumps([str(i) for i in data.correct_option_ids]), data.explanation, now()))
            return self.detail(db, self.question(db, data.id), user)

    def answer(self, identifier, data, user):
        with self.database.connect(write=True) as db:
            row = self.question(db, identifier)
            if row['author_id'] == user['id']:
                fail(403, '自己出的题只能由对方回答')
            if row['recipient_id'] != user['id']:
                fail(403, '只有本题指定的另一位用户可以回答')
            existing = db.execute('SELECT * FROM quiz_answers WHERE question_id=?', (str(identifier),)).fetchone()
            selected = [str(i) for i in data.selected_option_ids]
            if existing:
                if existing['id'] == str(data.id) and existing['answerer_id'] == user['id'] and set(json.loads(existing['selections_json'])) == set(selected):
                    return self.detail(db, row, user)
                fail(409, '本题已提交，原答题记录已保留，不能重复作答')
            options = {o['id'] for o in json.loads(row['options_json'])}
            if not set(selected).issubset(options) or (row['kind'] == 'single' and len(selected) != 1):
                fail(422, '请选择本题有效选项；单选题只能选择一项')
            if db.execute('SELECT 1 FROM quiz_answers WHERE id=?', (str(data.id),)).fetchone():
                fail(409, '提交编号已使用，请刷新后重试')
            correct = set(selected) == set(json.loads(row['correct_json']))
            db.execute('INSERT INTO quiz_answers VALUES(?,?,?,?,?,?)',
                       (str(data.id), row['id'], user['id'], json.dumps(selected), int(correct), now()))
            return self.detail(db, row, user)

    def list(self, user, tab, page, size):
        clause = 'q.author_id=?' if tab == 'created' else 'q.recipient_id=?'
        if tab == 'pending':
            clause += ' AND a.id IS NULL'
        elif tab == 'history':
            clause = '(q.author_id=? OR q.recipient_id=?) AND a.id IS NOT NULL'
        args = [user['id'], user['id']] if tab == 'history' else [user['id']]
        base = (' FROM questions q JOIN users u ON u.id=q.author_id JOIN users r ON r.id=q.recipient_id '
                'LEFT JOIN quiz_answers a ON a.question_id=q.id WHERE ' + clause)
        with self.database.connect() as db:
            total = db.execute('SELECT COUNT(*)' + base, args).fetchone()[0]
            rows = db.execute('SELECT q.id,q.body,q.kind,q.created_at,u.display_name AS author_name,'
                              'r.display_name AS recipient_name,a.id AS answer_id,a.correct,a.submitted_at' + base +
                              ' ORDER BY COALESCE(a.submitted_at,q.created_at) DESC,q.id DESC LIMIT ? OFFSET ?',
                              [*args, size, (page - 1) * size])
            result = page_result([dict(row) for row in rows], total, page, size)
            result['summary'] = {
                'pending': db.execute('SELECT COUNT(*) FROM questions q WHERE recipient_id=? '
                                      'AND NOT EXISTS(SELECT 1 FROM quiz_answers a WHERE a.question_id=q.id)', (user['id'],)).fetchone()[0],
                'created': db.execute('SELECT COUNT(*) FROM questions WHERE author_id=?', (user['id'],)).fetchone()[0],
                'history': db.execute('SELECT COUNT(*) FROM quiz_answers a JOIN questions q ON q.id=a.question_id '
                                     'WHERE q.author_id=? OR q.recipient_id=?', (user['id'], user['id'])).fetchone()[0]
            }
            return result
