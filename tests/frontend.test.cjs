// Focused async draft tests in a simulated DOM. These do not replace browser/device QA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

async function boot(storage = new Map(), crypto = webcrypto) {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: 'all', hidden: false, open: false, textContent: '', innerHTML: '', isConnected: true,
      querySelectorAll: () => [], querySelector: () => null, classList: { toggle() {} },
      addEventListener() {}, add() {}, replaceChildren() {}, focus() {}, reset() {},
      setAttribute(name, value) { this[name] = value; },
      showModal() { this.open = true; }, close() { this.open = false; }
    });
    return nodes.get(selector);
  };
  const state = { write: async () => ({ status: 200, body: { revision: 1 } }), read: new Map() };
  const context = vm.createContext({
    console, URLSearchParams, crypto, structuredClone, setTimeout, clearTimeout,
    location: { hash: '#timeline' }, history: { replaceState() {} }, navigator: {},
    window: { addEventListener() {} }, Option: function() {},
    document: { querySelector: node, querySelectorAll: () => [] },
    localStorage: {
      get length() { return storage.size; }, key: i => [...storage.keys()][i],
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)
    },
    fetch: async (path, options = {}) => {
      let result;
      if (options.method === 'PUT') result = await state.write(path, JSON.parse(options.body));
      else if (options.method === 'POST' && state.post) result = await state.post(path, JSON.parse(options.body));
      else if (state.read.has(path)) result = await state.read.get(path)();
      else if (path === '/api/filters') result = { status: 200, body: { years: [], tags: [] } };
      else result = { status: 200, body: { items: [], total: 0, page: 1, page_size: 20 } };
      return { ok: result.status < 400, status: result.status, json: async () => result.body };
    }
  });
  vm.runInContext(fs.readFileSync('web/map.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/quizzes.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/media.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/app.js', 'utf8'), context);
  await new Promise(setImmediate);
  const run = source => vm.runInContext(source, context);
  await run('openEditor()');
  // Timers are only used by toast/event handlers, not by these direct save calls.
  return { run, node, state, storage };
}

test('offline draft survives reopening and can subsequently save to the server', async () => {
  const { run, node, state, storage } = await boot();
  node('#entryBody').value = '断网后仍保留的文字';
  state.write = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(run('saveDraft()'));
  assert.equal([...storage.values()].map(JSON.parse)[0].body, '断网后仍保留的文字');
  state.write = async () => ({ status: 200, body: { revision: 1 } });
  await run('saveDraft()');
  assert.equal(run('draft.revision'), 1);
  const reopened = await boot(storage);
  assert.equal(reopened.run('localDrafts()[0].body'), '断网后仍保留的文字');
});

test('queued saves use the next server revision and preserve typing during a pending request', async () => {
  const { run, node, state, storage } = await boot();
  const requests = [];
  let release;
  state.write = async (path, body) => {
    requests.push(body);
    if (requests.length === 1) await new Promise(resolve => { release = resolve; });
    return { status: 200, body: { revision: requests.length } };
  };
  node('#entryBody').value = '第一句话';
  const first = run('saveDraft()');
  await new Promise(setImmediate);
  node('#entryBody').value = '等待保存时继续写的第二句话';
  const second = run('saveDraft()');
  release();
  await Promise.all([first, second]);
  assert.equal(requests[0].body, '第一句话');
  assert.equal(requests[0].revision, 0);
  assert.equal(requests[1].body, '等待保存时继续写的第二句话');
  assert.equal(requests[1].revision, 1);
  assert.equal([...storage.values()].map(JSON.parse)[0].body, requests[1].body);
  assert.equal(run('draft.revision'), 2);
});

test('version conflict reports failure without clearing local words', async () => {
  const { run, node, state, storage } = await boot();
  node('#entryBody').value = '不能被冲突覆盖的文字';
  state.write = async () => ({ status: 409, body: { detail: '内容已在另一页面修改' } });
  await assert.rejects(run('saveDraft()'));
  assert.equal(node('#editorError').textContent, '内容已在另一页面修改');
  assert.equal([...storage.values()].map(JSON.parse)[0].body, '不能被冲突覆盖的文字');
  assert.equal(node('#editor').open, true);
});

test('LAN HTTP without randomUUID can create valid unique record and draft IDs', async () => {
  const { run } = await boot(new Map(), { getRandomValues: bytes => webcrypto.getRandomValues(bytes) });
  const ids = [run('draft.id'), run('draft.entry_id'), run('uid()'), run('uid()')];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

function reminderResult() {
  return { status: 200, body: { today: '2026-10-24', total: 1, has_more: false, items: [
    { name: '<script>example</script>', note: '<b>一句祝福</b>', next_on: '2026-10-24', days_until: 0, years: null }
  ] } };
}

test('reminder waits for an open editor and escapes user text', async () => {
  const { run, node, state } = await boot();
  state.read.set('/api/anniversaries/reminders', async () => reminderResult());
  node('#entryBody').value = '不打断正在写的文字';
  await run('checkAnniversaryReminders()');
  assert.equal(node('#reminderDialog').open, false);
  assert.equal(node('#entryBody').value, '不打断正在写的文字');
  node('#editor').close(); run('presentAnniversaryReminder()');
  assert.equal(node('#reminderDialog').open, true);
  assert.match(node('#reminderItems').innerHTML, /就是今天/);
  assert.match(node('#reminderItems').innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(node('#reminderItems').innerHTML, /<script>/);
});

test('automatic reminder appears once per visit even when two checks race', async () => {
  const { run, node, state } = await boot();
  node('#editor').close();
  let requests = 0;
  state.read.set('/api/anniversaries/reminders', async () => { requests++; return reminderResult(); });
  await Promise.all([run('checkAnniversaryReminders()'), run('checkAnniversaryReminders()')]);
  assert.equal(node('#reminderDialog').open, true);
  assert.equal(run('pendingAnniversaryReminder'), null);
  node('#reminderDialog').close();
  await run('checkAnniversaryReminders()');
  assert.equal(requests, 2);
  assert.equal(node('#reminderDialog').open, false);
});

test('no due anniversaries means no automatic modal', async () => {
  const { run, node, state } = await boot();
  node('#editor').close();
  state.read.set('/api/anniversaries/reminders', async () => ({ status: 200, body: { items: [], total: 0 } }));
  await run('checkAnniversaryReminders()');
  assert.equal(node('#reminderDialog').open, false);
});

test('wish cards escape user text and expose completion state accessibly', async () => {
  const { run } = await boot();
  const html = run(`wishCards([{ title: '<script>unsafe</script>', note: '<img src=x>', done: true,
    completed_at: '2026-10-24T17:00:00Z', target_date: '2026-12-31' }])`);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x>/);
  assert.match(html, /2026\/10\/25/);
});

test('wish save conflict preserves title, note, and the open editor', async () => {
  const { run, node, state } = await boot();
  node('#editor').close();
  run('openWishEditor()');
  node('#wishTitle').value = '等待一起实现的愿望';
  node('#wishNote').value = '还没保存的细节';
  state.post = async () => ({ status: 409, body: { detail: '内容已在另一页面修改' } });
  await node('#wishForm').onsubmit({ preventDefault() {} });
  assert.equal(node('#wishDialog').open, true);
  assert.equal(node('#wishTitle').value, '等待一起实现的愿望');
  assert.equal(node('#wishNote').value, '还没保存的细节');
  assert.equal(node('#wishError').hidden, false);
  assert.equal(run('wishSaving'), false);
});

test('a slow earlier wish request cannot replace a newer filtered list', async () => {
  const { run, node, state } = await boot();
  node('#wishSearch').value = '';
  let release;
  const result = title => ({ status: 200, body: { items: [{ title, note: '', done: false }],
    total: 1, page: 1, page_size: 20, summary: { total: 2, done: 1, pending: 1 } } });
  state.read.set('/api/wishes?page=1&status=pending&q=', async () => {
    await new Promise(resolve => { release = resolve; }); return result('OLD RESULT');
  });
  state.read.set('/api/wishes?page=1&status=done&q=', async () => result('NEW RESULT'));
  const first = run("wishStatus = 'pending'; loadWishes()");
  await new Promise(setImmediate);
  await run("wishStatus = 'done'; loadWishes()");
  release(); await first;
  assert.match(node('#wishList').innerHTML, /NEW RESULT/);
  assert.doesNotMatch(node('#wishList').innerHTML, /OLD RESULT/);
  assert.equal(node('#wishProgress').value, 1);
});

test('map points and viewport clamping use finite valid coordinates', async () => {
  const { run } = await boot();
  assert.equal(run('JournalMap.validPoint({longitude:118,latitude:24})'), true);
  assert.equal(run('JournalMap.validPoint({longitude:200,latitude:24})'), false);
  assert.equal(run('JournalMap.validPoint({longitude:118,latitude:NaN})'), false);
  const bounds = run('JournalMap.boundsQuery({getWest:()=>60,getEast:()=>150,getSouth:()=>-5,getNorth:()=>70})');
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { west: 72, east: 136, south: 2, north: 55 });
});

test('footprint cards escape location names and notes', async () => {
  const { run } = await boot();
  const html = run(`footprintCards([{name:'<script>bad</script>',province:'<b>region</b>',note:'<img src=x>',visited_on:'2026-10-24'}])`);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x>/);
});

test('repositioning a footprint preserves text, ID, and revision', async () => {
  const { run, node } = await boot();
  node('#editor').close();
  run(`openFootprintEditor({id:'point1',revision:3,name:'海边',longitude:118,latitude:24,note:'原来的回忆'})`);
  node('#footprintName').value = '修改后的名字';
  node('#footprintNote').value = '重新选点前正在写的话';
  await node('#repositionFootprint').onclick();
  assert.equal(run('footprintPicking'), true);
  assert.equal(run('footprintEditing.name'), '修改后的名字');
  assert.equal(run('footprintEditing.note'), '重新选点前正在写的话');
  run('openFootprintEditor({...footprintEditing, longitude:120, latitude:30})');
  assert.equal(run('footprintEditing.revision'), 3);
  assert.equal(run('footprintEditing.id'), 'point1');
  assert.equal(node('#footprintName').value, '修改后的名字');
  assert.equal(node('#footprintNote').value, '重新选点前正在写的话');
});

test('footprint save conflict retains words and the selected coordinate', async () => {
  const { run, node, state } = await boot();
  node('#editor').close();
  run(`openFootprintEditor({id:'point1',revision:3,longitude:118,latitude:24,name:'海边'})`);
  node('#footprintNote').value = '不应该丢失';
  state.post = async () => ({ status: 409, body: { detail: '内容已在另一页面修改' } });
  await node('#footprintForm').onsubmit({ preventDefault() {} });
  assert.equal(node('#footprintDialog').open, true);
  assert.equal(node('#footprintNote').value, '不应该丢失');
  assert.equal(run('footprintEditing.longitude'), 118);
  assert.equal(node('#footprintError').hidden, false);
});

function quizItem(changes = {}) {
  return { id: 'q1', kind: 'single', body: '了解对方的小问题', author_name: '出题人', recipient_name: '答题人',
    options: [{ id: 'o1', text: '选项一' }, { id: 'o2', text: '选项二' }], can_answer: true, answered: false, ...changes };
}

test('unanswered choice screen contains no answer key or explanation', async () => {
  const { run } = await boot();
  const item = quizItem();
  const html = run(`QuizFeature.detailHTML(${JSON.stringify(item)})`);
  assert.match(html, /type="submit"/);
  assert.doesNotMatch(html, /正确答案：|正确选项|出题人的话/);
});

test('completed quiz screen preserves selected choices and escapes all text', async () => {
  const { run } = await boot();
  const item = quizItem({ body: '<script>bad</script>', can_answer: false, answered: true,
    options: [{ id: 'o1', text: '<img src=x>' }, { id: 'o2', text: '另一个选项' }],
    correct_option_ids: ['o1'], explanation: '<b>解析</b>',
    answer: { selected_option_ids: ['o2'], correct: false, submitted_at: '2026-10-24T01:00:00Z' } });
  const html = run(`QuizFeature.detailHTML(${JSON.stringify(item)})`);
  assert.match(html, /value="o2" disabled checked/);
  assert.match(html, /正确答案：A/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;b&gt;解析&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x>|type="submit"/);
});

test('author question screen cannot submit an answer', async () => {
  const { run } = await boot();
  const item = quizItem({ can_answer: false, correct_option_ids: ['o1'], explanation: '作者可回看自己的答案' });
  const html = run(`QuizFeature.detailHTML(${JSON.stringify(item)})`);
  assert.match(html, /这是你出的题/);
  assert.doesNotMatch(html, /type="submit"/);
});

test('signed-out quiz page asks for account login without fetching question records', async () => {
  const { run, node, state } = await boot();
  let reads = 0;
  state.read.set('/api/auth/status', async () => ({ status: 200, body: { configured: true, can_setup: false, user: null } }));
  state.read.set('/api/quizzes?tab=pending&page=1', async () => { reads++; throw new Error('must not fetch'); });
  await run('QuizFeature.load()');
  assert.equal(reads, 0);
  assert.match(node('#quizAccountCard').innerHTML, /登录账号/);
  assert.equal(node('#accountAccess').textContent, '账号登录');
});

test('an old account-status response cannot undo a completed login', async () => {
  const { run, node, state } = await boot();
  let release;
  state.read.set('/api/auth/status', async () => {
    await new Promise(resolve => { release = resolve; });
    return { status: 200, body: { configured: true, can_setup: true, user: null } };
  });
  const pending = run('QuizFeature.openAccount()');
  await new Promise(setImmediate);
  state.post = async () => ({ status: 200, body: { user: { id: 'user1', username: 'alpha', display_name: '第一位', partner: { id: 'user2', display_name: '第二位' } } } });
  node('#loginUsername').value = 'alpha'; node('#loginPassword').value = 'test-only-password';
  await node('#authLoginForm').onsubmit({ preventDefault() {} });
  release(); await pending;
  assert.equal(node('#accountAccess').textContent, '第一位');
  assert.equal(node('#authSignedIn').hidden, false);
});

function fakeUploadRuntime(run) {
  run(`globalThis.testUploads = []; globalThis.failUpload = true;
    globalThis.XMLHttpRequest = class {
      constructor(){ this.upload = {}; }
      open(method,url){ this.url=url; }
      setRequestHeader(){}
      abort(){ this.onabort?.(); }
      send(file){
        const id=this.url.split('/')[3]; testUploads.push({id,name:file.name});
        if(file.name==='retry.pdf' && failUpload){this.onerror();return;}
        this.upload.onprogress({loaded:file.size,total:file.size}); this.upload.onload();
        this.status=200; this.response={id,name:file.name,status:'ready',kind:'document',mime:'application/octet-stream',size:file.size,
          url:'/api/media/'+id+'/content',download_url:'/api/media/'+id+'/content?download=1'}; this.onload();
      }
    };`);
}

test('file uploads retry independently and attachment-only publishing includes acknowledged IDs', async () => {
  const { run, node, state } = await boot();
  fakeUploadRuntime(run);
  let published = null;
  state.post = async (path, data) => {
    if (path === '/api/media') return { status: 200, body: { id: data.id, status: 'pending' } };
    if (path === '/api/entries') { published = data; return { status: 200, body: { ok: true } }; }
    return { status: 200, body: { ok: true } };
  };
  run(`MediaFeature.addFiles([{name:'one.pdf',size:10,type:'application/pdf'}, {name:'retry.pdf',size:11,type:'application/pdf'}, {name:'three.pdf',size:12,type:'application/pdf'}])`);
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
  assert.equal(run('MediaFeature.busy()'), false);
  assert.equal(run('MediaFeature.readyIds().length'), 2);
  assert.equal(run('MediaFeature.canPublish()'), false);
  await node('#entryForm').onsubmit({ preventDefault() {} });
  assert.equal(published, null);
  run(`failUpload=false; MediaFeature.retry(testUploads.find(i=>i.name==='retry.pdf').id)`);
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
  assert.equal(run('MediaFeature.canPublish()'), true);
  assert.equal(run('testUploads.filter(i=>i.name==="one.pdf").length'), 1);
  assert.equal(run('testUploads.filter(i=>i.name==="three.pdf").length'), 1);
  await node('#entryForm').onsubmit({ preventDefault() {} });
  assert.equal(published.body, '');
  assert.equal(published.attachment_ids.length, 3);
  assert.equal(node('#editor').open, false);
  run('clearTimeout(toastTimer); clearTimeout(draftTimer)');
});

test('removing a file while upload registration is pending cannot resurrect it', async () => {
  const { run, state } = await boot();
  fakeUploadRuntime(run);
  let release, registered, discarded = false;
  state.post = async (path, data) => {
    if (path === '/api/media') { registered = data.id; await new Promise(resolve => { release = resolve; }); return { status: 200, body: { status: 'pending', id: data.id } }; }
    if (path.endsWith('/discard')) discarded = true;
    return { status: 200, body: { ok: true } };
  };
  run(`MediaFeature.addFiles([{name:'late.pdf',size:10,type:'application/pdf'}])`);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  assert.ok(registered);
  await run(`MediaFeature.remove(${JSON.stringify(registered)})`);
  release();
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  assert.equal(discarded, true);
  assert.equal(run('MediaFeature.readyIds().length'), 0);
  assert.equal(run('testUploads.length'), 0);
  assert.equal(run('MediaFeature.hasItems()'), false);
  run('clearTimeout(draftTimer)');
});

test('document previews remain download-only and filenames are escaped', async () => {
  const { run } = await boot();
  const html = run(`MediaFeature.attachmentHTML({kind:'document',name:'<script>file</script>.html',size:10,
    url:'/api/media/uuid/content',download_url:'/api/media/uuid/content?download=1'})`);
  assert.match(html, /&lt;script&gt;file&lt;\/script&gt;/);
  assert.match(html, /download=1/);
  assert.doesNotMatch(html, /<iframe|<object|<script>|<img/);
});
