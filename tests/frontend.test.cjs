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
      addEventListener(type, handler) { this.listeners ||= {}; (this.listeners[type] ||= []).push(handler); },
      add() {}, replaceChildren() {}, focus() {}, reset() {},
      setAttribute(name, value) { this[name] = value; },
      getAttribute(name) { return this[name] ?? null; }, removeAttribute(name) { delete this[name]; },
      showModal() { this.open = true; }, close() { this.open = false; }
    });
    return nodes.get(selector);
  };
  const state = { write: async () => ({ status: 200, body: { revision: 1 } }), read: new Map() };
  const context = vm.createContext({
    console, URLSearchParams, crypto, structuredClone, setTimeout, clearTimeout,
    location: { hash: '#timeline' }, history: { replaceState() {} }, navigator: {},
    window: { addEventListener() {}, matchMedia: () => ({ addEventListener(type, handler) { state.viewportChange = handler; } }) }, Option: function() {},
    document: { querySelector: node, querySelectorAll: selector => state.elements?.get(selector) || [], elementFromPoint: () => state.pointerTarget },
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
      return { ok: result.status < 400, status: result.status, json: async () => {
        if (result.invalidJSON) throw new SyntaxError('Unexpected token <');
        return result.body;
      } };
    }
  });
  vm.runInContext(fs.readFileSync('web/map.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/quizzes.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/media.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/quotes.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/app.js', 'utf8'), context);
  await new Promise(setImmediate);
  const run = source => vm.runInContext(source, context);
  await run('openEditor()');
  // Timers are only used by toast/event handlers, not by these direct save calls.
  return { run, node, state, storage };
}

test('mobile side menu expands and collapses with an accessible toggle', async () => {
  const { node } = await boot();
  await node('#mobileMenuToggle').onclick();
  assert.equal(node('#mobileMenu').open, true);
  assert.equal(node('#mobileMenuToggle').getAttribute('aria-expanded'), 'true');
  await node('#mobileMenuToggle').onclick();
  assert.equal(node('#mobileMenu').open, false);
  assert.equal(node('#mobileMenuToggle').getAttribute('aria-expanded'), 'false');
  await node('#mobileMenuToggle').onclick(); await node('#mobileMenuClose').onclick();
  assert.equal(node('#mobileMenu').open, false);
});

test('selecting a page closes the menu and preserves that pages primary action', async () => {
  const { run, node } = await boot();
  await node('#mobileMenuToggle').onclick(); await run("navigate('quizzes')");
  assert.equal(node('#mobileMenu').open, false);
  assert.equal(node('#mobileMenuToggle').getAttribute('aria-expanded'), 'false');
  assert.equal(node('#composeLabel').textContent, '出一道题');
  await node('#mobileMenuToggle').onclick(); await run("navigate('manage')");
  assert.equal(node('#mobileMenu').open, false);
  assert.equal(node('#compose').hidden, true);
});

test('side menu closes on backdrop or desktop resize and resets state after native dismissal', async () => {
  const { node, state } = await boot();
  const menu = node('#mobileMenu');
  await node('#mobileMenuToggle').onclick();
  menu.listeners.click[0]({ target: node('#mobileMenuTitle') });
  assert.equal(menu.open, true);
  menu.listeners.click[0]({ target: menu });
  assert.equal(menu.open, false);
  await node('#mobileMenuToggle').onclick(); state.viewportChange({ matches: false });
  assert.equal(menu.open, false);
  await node('#mobileMenuToggle').onclick(); menu.close();
  for (const handler of menu.listeners.close) handler();
  assert.equal(node('#mobileMenuToggle').getAttribute('aria-expanded'), 'false');
});

test('DNG attachments use converted previews while downloads keep original URLs', async () => {
  const { run, node } = await boot();
  const item = { id: 'raw-photo', name: 'IMG_1110.dng', kind: 'image', status: 'ready', size: 12000000,
    url: '/api/media/raw-photo/content', download_url: '/api/media/raw-photo/content?download=1' };
  const html = run(`MediaFeature.attachmentHTML(${JSON.stringify(item)})`);
  assert.match(html, /src="\/api\/media\/raw-photo\/preview"/);
  assert.match(html, /href="\/api\/media\/raw-photo\/content\?download=1"/);
  await run(`MediaFeature.open({draftId:'draft-raw',attachments:[${JSON.stringify(item)}]})`);
  assert.match(node('#attachmentList').innerHTML, /src="\/api\/media\/raw-photo\/preview"/);
  run("MediaFeature.openPreview('raw-photo')");
  assert.equal(node('#mediaPreviewImage').src, '/api/media/raw-photo/preview');
  assert.equal(node('#mediaPreviewDownload').href, item.download_url);
});

test('attachment reordering preserves every file, draft order and immutable download links', async () => {
  const { run, state } = await boot();
  const attachments = ['a', 'b', 'c'].map(id => ({ id, name: id + '.png', kind: 'image', status: 'ready', url: '/'+id, download_url: '/'+id+'?download=1' }));
  await run(`MediaFeature.open({draftId:'draft',attachments:${JSON.stringify(attachments)}})`);
  assert.equal(run("MediaFeature.moveTo('c',0)"), true);
  assert.deepEqual(Array.from(run('MediaFeature.readyIds()')), ['c', 'a', 'b']);
  assert.equal(run("MediaFeature.moveTo('c',2)"), true);
  assert.deepEqual(Array.from(run('MediaFeature.readyIds()')), ['a', 'b', 'c']);
  run('MediaFeature.setLocked(true)');
  assert.equal(run("MediaFeature.moveTo('a',2)"), false);
  run('MediaFeature.setLocked(false)');
  assert.equal(run("MediaFeature.moveTo('a',99)"), false);
  assert.equal(run("MediaFeature.moveTo('a',2)"), true);
  assert.deepEqual(Array.from(run('collect().attachment_ids')), ['b', 'c', 'a']);
  state.read.set('/api/media/drafts/draft', async () => ({ status: 200, body: { items: attachments } }));
  for (const item of attachments) state.read.set('/api/media/' + item.id, async () => ({ status: 200, body: item }));
  await run("MediaFeature.open({draftId:'draft',attachmentIds:['b','c','a']})");
  assert.deepEqual(Array.from(run('MediaFeature.readyIds()')), ['b', 'c', 'a']);
});

test('pointer dragging moves a photo to the drop position and cancellation preserves order', async () => {
  const { run, node, state } = await boot();
  const rows = ['a', 'b', 'c'].map(id => ({ dataset: { uploadRow: id }, classList: { toggle() {} }, getBoundingClientRect: () => ({ top: 100, height: 100 }) }));
  const handle = { dataset: { uploadDrag: 'a' }, closest: () => rows[0], setPointerCapture() {} };
  state.elements = new Map([['[data-upload-row]', rows], ['[data-upload-drag]', [handle]]]);
  const attachments = ['a', 'b', 'c'].map(id => ({ id, name: id+'.png', kind:'image', status:'ready', url:'/'+id, download_url:'/'+id }));
  await run(`MediaFeature.open({draftId:'draft',attachments:${JSON.stringify(attachments)}})`);
  state.pointerTarget = { closest: () => rows[2] };
  handle.onpointerdown({ pointerId: 1, button: 0, preventDefault() {} });
  handle.onpointermove({ pointerId: 1, clientX: 50, clientY: 190 });
  handle.onpointerup({ pointerId: 1 });
  assert.deepEqual(Array.from(run('MediaFeature.readyIds()')), ['b','c','a']);
  assert.match(node('#attachmentSortStatus').textContent, /第 3 项/);
  handle.onpointerdown({ pointerId: 2, button: 0, preventDefault() {} });
  state.pointerTarget = { closest: () => rows[0] };
  handle.onpointermove({ pointerId: 2, clientX: 50, clientY: 110 });
  handle.onpointercancel(); handle.onpointerup({ pointerId: 2 });
  assert.deepEqual(Array.from(run('MediaFeature.readyIds()')), ['b','c','a']);
});

test('creating a record celebrates after server success and does not repeat for the same record', async () => {
  const { run, node, state } = await boot();
  node('#entryCelebration').hidden = true;
  node('#entryBody').value = 'A memory to keep';
  const id = run('draft.entry_id');
  state.post = async () => {
    assert.equal(node('#entryCelebration').hidden, true);
    return { status: 200, body: { id } };
  };
  await node('#entryForm').onsubmit({ preventDefault() {} });
  assert.equal(node('#editor').open, false);
  assert.equal(node('#entryCelebration').hidden, false);
  assert.equal(node('#entryCelebrationTitle').textContent, '又收藏了一段美好！');
  assert.equal((node('#entryCelebrationHearts').innerHTML.match(/<span /g) || []).length, 16);
  node('#entryCelebration').hidden = true;
  run(`celebrateNewEntry(${JSON.stringify(id)},'entry')`);
  assert.equal(node('#entryCelebration').hidden, true);
  run('clearTimeout(creationTimer); clearTimeout(toastTimer); clearTimeout(draftTimer)');
});

for (const mode of ['edit', 'failure', 'draft']) test(`${mode} does not celebrate a new record`, async () => {
  const { run, node, state } = await boot();
  node('#entryCelebration').hidden = true;
  if (mode === 'edit') await run(`openEditor({id:'existing',revision:4,title:'',body:'Existing memory',date:'2026-11-08',place:'',tags:[],attachments:[]})`);
  node('#entryBody').value = 'Words to save';
  state.post = async () => mode === 'failure' ? { status: 503, body: { detail: 'Retry later' } } : { status: 200, body: { id: 'existing' } };
  if (mode === 'draft') await run('saveDraft()');
  else await node('#entryForm').onsubmit({ preventDefault() {} });
  assert.equal(node('#entryCelebration').hidden, true);
  run('clearTimeout(creationTimer); clearTimeout(toastTimer); clearTimeout(draftTimer)');
});

test('the top edit action edits the displayed record and is hidden for story details', async () => {
  const { run, node, state } = await boot();
  let focusedHeading = false;
  node('#detailContent').querySelector = selector => selector === 'h2' ? { focus(options) { focusedHeading = options.preventScroll; } } : null;
  const entry = { id:'entry-top',revision:2,title:'Title',body:'Memory',date:'2026-11-08',tags:[],attachments:[],history_count:1 };
  state.read.set('/api/entries/entry-top', async () => ({ status:200,body:entry }));
  await run("openEntry('entry-top')");
  assert.equal(focusedHeading, true);
  assert.match(node('#detailContent').innerHTML, /<h2 tabindex="-1">/);
  assert.equal(node('#editButton').hidden, false);
  assert.doesNotMatch(node('#detailContent').innerHTML, /id="editButton"/);
  await node('#editButton').onclick();
  assert.equal(node('#detail').open, false);
  assert.equal(node('#editor').open, true);
  assert.equal(run('draft.editing_id'), 'entry-top');
  assert.equal(node('#entryBody').value, 'Memory');
  state.read.set('/api/stories/story-top', async () => ({ status:200,body:{id:'story-top',name:'Story',description:'',revision:1} }));
  await run("openStory('story-top')");
  assert.equal(node('#editButton').hidden, true);
  assert.equal(node('#editButton').onclick, null);
});

test('page navigation updates the shared create control and hides it in management', async () => {
  const { run, node } = await boot();
  for (const [view, label] of Object.entries({ timeline: '记下这一刻', album: '记下这一刻', stories: '新建故事',
    anniversaries: '添加纪念日', wishes: '添加愿望', quotes: '记一句话', footprints: '标定地点', quizzes: '出一道题', manage: '' })) {
    await run(`navigate('${view}')`);
    assert.equal(node('#composeLabel').textContent, label);
    assert.equal(node('#compose').hidden, !label);
    assert.equal(node('#compose').getAttribute('aria-label'), label || '新增');
  }
});

test('the shared create control opens the editor for the current feature', async () => {
  const { run, node } = await boot();
  node('#editor').close();
  await run("navigate('stories')"); await node('#compose').onclick();
  assert.equal(node('#storyDialog').open, true);
  assert.equal(node('#editor').open, false);
  node('#storyDialog').close();
  await run("navigate('wishes')"); await node('#compose').onclick();
  assert.equal(node('#wishDialog').open, true);
  assert.equal(node('#editor').open, false);
  node('#wishDialog').close();
  await run("navigate('anniversaries')"); await node('#compose').onclick();
  assert.equal(node('#anniversaryDialog').open, true);
  node('#anniversaryDialog').close();
  await run("navigate('quotes')"); await node('#compose').onclick();
  assert.equal(run('draft.kind'), 'quote'); node('#editor').close();
  await run("navigate('album')"); await node('#compose').onclick();
  assert.equal(run('draft.kind'), 'entry');
});

test('context create keeps footprint picking and the quiz login requirement', async () => {
  const { run, node, state } = await boot();
  node('#editor').close();
  node('#chinaMap').scrollIntoView = () => {};
  run('footprintMapPromise = Promise.resolve({ invalidate() {} })');
  await run("navigate('footprints')"); await node('#compose').onclick();
  assert.equal(run('footprintPicking'), true);
  assert.equal(run('footprintEditing.revision'), 0);
  assert.equal(node('#editor').open, false);
  state.read.set('/api/auth/status', async () => ({ status: 200, body: { configured: true, can_setup: false, user: null } }));
  await run("navigate('quizzes')"); await node('#compose').onclick();
  assert.equal(node('#authDialog').open, true);
  assert.equal(node('#questionDialog').open, false);
  assert.equal(node('#editor').open, false);
});

test('authenticated create opens the question form and can be used again after closing', async () => {
  const { run, node, state } = await boot();
  node('#editor').close();
  state.read.set('/api/auth/status', async () => ({ status: 200, body: {
    configured: true, can_setup: false, user: { id: 'author', display_name: '我', partner: { display_name: '对方' } }
  } }));
  run("view = 'quizzes'; updatePageAction()");
  for (let attempt = 0; attempt < 2; attempt++) {
    await node('#compose').onclick();
    assert.equal(node('#questionDialog').open, true);
    assert.equal(node('#questionKind').value, 'single');
    assert.match(node('#questionOptions').innerHTML, /data-question-text=/);
    assert.match(node('#questionEditorTitle').textContent, /给对方/);
    assert.equal(node('#editor').open, false);
    node('#questionDialog').close();
  }
});

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

for (const correct of [true, false]) test(`a submitted ${correct ? 'correct' : 'incorrect'} answer ${correct ? 'plays' : 'does not play'} a reward; history never replays it`, async () => {
  const { run, node, state } = await boot();
  let item = quizItem();
  const open = { dataset: { openQuiz: 'q1' } };
  state.elements = new Map([
    ['[data-open-quiz]', [open]],
    ['#quizAnswerForm input[name=quizSelection]:checked', [{ value: 'o1' }]]
  ]);
  state.read.set('/api/auth/status', async () => ({ status: 200, body: { configured: true, user: { id: 'u1', display_name: '答题人' } } }));
  state.read.set('/api/quizzes?tab=pending&page=1', async () => ({ status: 200, body: {
    items: [item], total: 1, page: 1, page_size: 20, summary: { pending: 1, created: 0, history: 0 }
  } }));
  state.read.set('/api/quizzes/q1', async () => ({ status: 200, body: item }));
  await run('QuizFeature.load()'); await open.onclick();
  assert.doesNotMatch(node('#quizDetailContent').innerHTML, /id="quizReward"/);
  state.post = async () => {
    item = quizItem({ can_answer: false, answer: { id: 'a1', correct, selected_option_ids: ['o1'], submitted_at: '2026-11-07T00:00:00Z' }, correct_option_ids: ['o1'] });
    return { status: 200, body: item };
  };
  await node('#quizAnswerForm').onsubmit({ preventDefault() {} });
  assert.equal(node('#quizDetailContent').innerHTML.includes('id="quizReward"'), correct);
  if (correct) assert.match(node('#quizDetailContent').innerHTML, /默契值 \+1/);
  await open.onclick(); // Opening the saved result also clears the animation timer.
  assert.doesNotMatch(node('#quizDetailContent').innerHTML, /id="quizReward"/);
});

test('a failed answer submission preserves choices and does not celebrate', async () => {
  const { run, node, state } = await boot();
  const open = { dataset: { openQuiz: 'q1' } };
  state.elements = new Map([['[data-open-quiz]', [open]], ['#quizAnswerForm input[name=quizSelection]:checked', [{ value: 'o1' }]]]);
  state.read.set('/api/auth/status', async () => ({ status: 200, body: { configured: true, user: { id: 'u1', display_name: '答题人' } } }));
  state.read.set('/api/quizzes?tab=pending&page=1', async () => ({ status: 200, body: {
    items: [quizItem()], total: 1, page: 1, page_size: 20, summary: { pending: 1, created: 0, history: 0 }
  } }));
  state.read.set('/api/quizzes/q1', async () => ({ status: 200, body: quizItem() }));
  await run('QuizFeature.load()'); await open.onclick();
  state.post = async () => ({ status: 503, body: { detail: '稍后重试' } });
  await node('#quizAnswerForm').onsubmit({ preventDefault() {} });
  assert.equal(node('#quizAnswerError').textContent, '稍后重试');
  assert.doesNotMatch(node('#quizDetailContent').innerHTML, /id="quizReward"/);
  assert.match(node('#quizDetailContent').innerHTML, /type="submit"/);
});

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
        this.status=200; this.response={id,name:file.name,status:'ready',kind:file.type?.startsWith('image/')?'image':'document',mime:file.type||'application/octet-stream',size:file.size,
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

test('clearing a saved draft updates both the service and device copy', async () => {
  const { run, node, state, storage } = await boot();
  const requests = [];
  state.write = async (path, body) => {
    requests.push(body);
    return { status: 200, body: { revision: requests.length } };
  };
  node('#entryBody').value = 'Remove this text';
  await run('saveDraft()');
  node('#entryBody').value = '';
  await run('saveDraft()');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body, '');
  assert.equal([...storage.values()].map(JSON.parse)[0].body, '');
});

test('clearing text during an initial in-flight save queues the empty update', async () => {
  const { run, node, state, storage } = await boot();
  let release;
  const requests = [];
  state.write = async (path, body) => {
    requests.push(body);
    if (requests.length === 1) await new Promise(resolve => { release = resolve; });
    return { status: 200, body: { revision: requests.length } };
  };
  node('#entryBody').value = 'Temporary text';
  const initial = run('saveDraft()');
  await new Promise(setImmediate);
  node('#entryBody').value = '';
  const cleared = run('saveDraft()');
  release();
  await Promise.all([initial, cleared]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].revision, 1);
  assert.equal(requests[1].body, '');
  assert.equal([...storage.values()].map(JSON.parse)[0].body, '');
});

test('a second submit during draft persistence cannot publish twice', async () => {
  const { node, state, run } = await boot();
  let release, publications = 0;
  state.write = async () => {
    await new Promise(resolve => { release = resolve; });
    return { status: 200, body: { revision: 1 } };
  };
  state.post = async () => { publications++; return { status: 200, body: { ok: true } }; };
  node('#entryBody').value = 'Publish only once';
  const initial = node('#entryForm').onsubmit({ preventDefault() {} });
  await new Promise(setImmediate);
  await node('#entryForm').onsubmit({ preventDefault() {} });
  release();
  await initial;
  assert.equal(publications, 1);
  assert.equal(node('#editor').open, false);
  run('clearTimeout(toastTimer); clearTimeout(draftTimer)');
});

test('a non-JSON service error preserves an understandable message and status', async () => {
  const { run, state } = await boot();
  state.read.set('/api/album', async () => ({ status: 503, invalidJSON: true }));
  await assert.rejects(run("api('/album')"), error => {
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /Unexpected token/);
    assert.ok(error.message.length > 10);
    return true;
  });
});

test('a slow draft list cannot replace the newly selected backup tab', async () => {
  const { run, node, state } = await boot();
  let release;
  state.read.set('/api/drafts?page=1', async () => {
    await new Promise(resolve => { release = resolve; });
    return { status: 200, body: { items: [], total: 0, page: 1, page_size: 20 } };
  });
  run("manageTab='drafts'");
  const old = run('loadManage()');
  await new Promise(setImmediate);
  run("manageTab='backup'");
  await run('loadManage()');
  const current = node('#manageContent').innerHTML;
  release();
  await old;
  assert.equal(node('#manageContent').innerHTML, current);
});

test('a slow story page cannot replace a more recent page', async () => {
  const { run, node, state } = await boot();
  let release;
  state.read.set('/api/stories?page=1', async () => {
    await new Promise(resolve => { release = resolve; });
    return { status: 200, body: { items: [{ id: 'old', name: 'Old page' }], total: 21, page: 1, page_size: 20 } };
  });
  state.read.set('/api/stories?page=2', async () => ({ status: 200,
    body: { items: [{ id: 'new', name: 'Current page' }], total: 21, page: 2, page_size: 20 } }));
  const old = run('loadStories()');
  await new Promise(setImmediate);
  run('storiesPage=2');
  await run('loadStories()');
  release();
  await old;
  assert.match(node('#storiesGrid').innerHTML, /Current page/);
  assert.doesNotMatch(node('#storiesGrid').innerHTML, /Old page/);
});

test('quote publishing preserves its kind, source, note and device draft', async () => {
  const { run, node, state, storage } = await boot();
  await run("openEditor(null,null,null,'quote')");
  assert.equal(node('#quoteFields').hidden, false);
  node('#entryBody').value = 'A little thought';
  node('#quoteSource').value = 'A book';
  node('#quoteNote').value = 'My reflection';
  await run('saveDraft()');
  const local = [...storage.values()].map(JSON.parse).find(item => item.kind === 'quote');
  assert.equal(local.quote_source, 'A book');
  let publication;
  state.post = async (path, data) => { publication = data; return { status: 200, body: { ok: true } }; };
  await node('#entryForm').onsubmit({ preventDefault() {} });
  assert.equal(publication.kind, 'quote');
  assert.equal(publication.quote_source, 'A book');
  assert.equal(publication.quote_note, 'My reflection');
  run('clearTimeout(toastTimer); clearTimeout(draftTimer)');
});

test('OCR results require an explicit action before changing the existing body', async () => {
  const { run, node, state } = await boot();
  node('#entryBody').value = 'Keep my words';
  state.post = async () => ({ status: 200, body: { text: 'Recognized words' } });
  await run("QuoteFeature.extract('image-id')");
  assert.equal(node('#entryBody').value, 'Keep my words');
  assert.equal(node('#ocrText').value, 'Recognized words');
  node('#ocrText').value = 'Corrected words';
  node('#ocrAppend').onclick();
  assert.equal(node('#entryBody').value, 'Keep my words\n\nCorrected words');
  assert.equal(node('#ocrDialog').open, false);
  run('clearTimeout(draftTimer)');
});

test('a late OCR result cannot modify another draft', async () => {
  const { run, node, state } = await boot();
  let release;
  state.post = async () => {
    await new Promise(resolve => { release = resolve; });
    return { status: 200, body: { text: 'Old image text' } };
  };
  const pending = run("QuoteFeature.extract('image-id')");
  await new Promise(setImmediate);
  node('#ocrDialog').close();
  await run('openEditor()');
  node('#entryBody').value = 'Another draft';
  release(); await pending;
  assert.equal(node('#entryBody').value, 'Another draft');
  assert.equal(node('#ocrText').value, '');
});

test('quote cards escape body, source and reflections', async () => {
  const { run } = await boot();
  const html = run(`QuoteFeature.cards([{id:'quote-id',body:'<script>text</script>',date:'2026-10-24',
    quote_source:'<img src=x>',quote_note:'<svg onload=x>',attachments:[]}])`);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;svg onload=x&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x>|<svg onload=x>/);
});

test('an empty OCR result still lets the user enter text manually and apply it', async () => {
  const { run, node, state } = await boot();
  state.post = async () => ({ status: 200, body: { text: '' } });
  await run("QuoteFeature.extract('image-id')");
  assert.equal(node('#ocrText').disabled, false);
  assert.equal(node('#ocrAppend').disabled, true);
  node('#ocrText').value = 'Manually transcribed text';
  node('#ocrText').oninput();
  assert.equal(node('#ocrAppend').disabled, false);
  node('#ocrReplace').onclick();
  assert.equal(node('#entryBody').value, 'Manually transcribed text');
  run('clearTimeout(draftTimer)');
});

test('selected images preview immediately, switch to stored originals, and open at full size', async () => {
  const { run, node, state } = await boot();
  fakeUploadRuntime(run);
  run(`globalThis.revokedPreviews=[];globalThis.URL={createObjectURL:()=> 'blob:selected-image',revokeObjectURL:url=>revokedPreviews.push(url)};`);
  let release;
  state.post = async (path, data) => {
    if (path === '/api/media') {
      await new Promise(resolve => { release = resolve; });
      return { status: 200, body: { id: data.id, status: 'pending' } };
    }
    return { status: 200, body: { ok: true } };
  };
  run(`MediaFeature.addFiles([{name:'photo.png',size:10,type:'image/png'}])`);
  assert.match(node('#attachmentList').innerHTML, /<img src="blob:selected-image"/);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  release();
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  const id = run('MediaFeature.readyIds()[0]');
  assert.ok(id);
  assert.match(node('#attachmentList').innerHTML, new RegExp('<img src="/api/media/' + id + '/content"'));
  assert.deepEqual(Array.from(run('revokedPreviews')), ['blob:selected-image']);
  run(`MediaFeature.openPreview(${JSON.stringify(id)})`);
  assert.equal(node('#mediaPreviewDialog').open, true);
  assert.equal(node('#mediaPreviewImage').src, '/api/media/' + id + '/content');
  assert.equal(node('#mediaPreviewDownload').hidden, false);
  await run(`MediaFeature.remove(${JSON.stringify(id)})`);
  assert.equal(node('#mediaPreviewDialog').open, false);
  assert.doesNotMatch(node('#attachmentList').innerHTML, /data-upload-thumbnail/);
  run('clearTimeout(draftTimer)');
});

test('a failed upload keeps its local preview until the file is removed', async () => {
  const { run, node, state } = await boot();
  run(`globalThis.revokedPreviews=[];globalThis.URL={createObjectURL:()=> 'blob:failed-image',revokeObjectURL:url=>revokedPreviews.push(url)};`);
  state.post = async () => ({ status: 503, body: { detail: 'Upload unavailable' } });
  run(`MediaFeature.addFiles([{name:'retry.png',size:10,type:'image/png'}])`);
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  assert.equal(run('MediaFeature.busy()'), false);
  assert.match(node('#attachmentList').innerHTML, /<img src="blob:failed-image"/);
  assert.equal(run('revokedPreviews.length'), 0);
  const id = node('#attachmentList').innerHTML.match(/data-upload-preview="([^"]+)"/)[1];
  await run(`MediaFeature.remove(${JSON.stringify(id)})`);
  assert.deepEqual(Array.from(run('revokedPreviews')), ['blob:failed-image']);
  run('clearTimeout(draftTimer)');
});

test('reopened image attachments preview the original and escape the filename', async () => {
  const { run, node } = await boot();
  await run(`MediaFeature.open({draftId:'draft',editingId:'entry',attachments:[{
    id:'image-id',name:'<img src=x>.png',kind:'image',status:'ready',size:10,
    url:'/api/media/image-id/content',download_url:'/api/media/image-id/content?download=1'}]})`);
  const html = node('#attachmentList').innerHTML;
  assert.match(html, /<img src="\/api\/media\/image-id\/content"/);
  assert.match(html, /&lt;img src=x&gt;\.png/);
  assert.doesNotMatch(html, /<img src=x>/);
  run('MediaFeature.reset()');
  assert.equal(node('#attachmentList').innerHTML, '');
});
