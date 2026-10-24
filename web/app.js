'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const paths={sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4L19 5"/>',image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',book:'<path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Zm0 0v15"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/>',heart:'<path d="M20.5 5.5c-2.5-2.5-6-1.5-8.5 1C9.5 4 6 3 3.5 5.5S1.5 11 4 13.5l8 7 8-7c2.5-2.5 3-5.5.5-8Z"/>',map:'<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16"/>',message:'<path d="M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 1 1 19 0Z"/><path d="M8 10h8m-8 4h5"/>',settings:'<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2 4h5l1-3 3-1 3-3-2-2 1-3-3-2-2-4H9Z"/>',arrow:'<path d="M4 12h15m-5-5 5 5-5 5"/>',plus:'<path d="M12 5v14M5 12h14"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',filter:'<path d="M4 6h16M7 12h10m-6 6h2"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',audio:'<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',video:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4V8Z"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',restore:'<path d="M4 10a8 8 0 1 1 0 5m0-12v7h7"/>'};
function icon(name){return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.image}</svg>`}function icons(root=document){root.querySelectorAll('i[data-icon]').forEach(e=>e.innerHTML=icon(e.dataset.icon))}icons();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const uid = () => {
  // randomUUID requires a secure context; LAN HTTP still exposes getRandomValues.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateLabel = value => value.replace(/-/g, '.');
const LOCAL_PREFIX = 'journal-text-draft-v1:';
let view = 'timeline', page = 1, storiesPage = 1, managePage = 1, manageTab = 'drafts';
let tag = '', feedRequest = 0, draft = null, draftTimer, searchTimer, toastTimer;
let saveChain = Promise.resolve(), publishing = false, localReady = true;
let storyChoices = [];
let anniversaryPage = 1, anniversaryItems = [], anniversaryEditing = null;
let pendingAnniversaryReminder = null, anniversaryReminderShown = false;
let wishesPage = 1, wishStatus = 'all', wishItems = [], wishEditing = null, wishRequest = 0, wishSearchTimer, wishSaving = false;
let footprintPage = 1, footprintItems = [], footprintEditing = null, footprintPicking = false, footprintSaving = false;
let footprintMap = null, footprintMapPromise = null, footprintRequest = 0, footprintMarkerRequest = 0, footprintSearchTimer, footprintMarkerTimer;
let albumPage = 1, albumRequest = 0;

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}

function editorError(message = '') {
  $('#editorError').textContent = message;
  $('#editorError').hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch('/api' + path, {
    ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, cache: 'no-store'
  });
  const result = await response.json();
  if (!response.ok) {
    let message = result.detail;
    if (Array.isArray(message)) message = message.map(item => item.msg).join('；');
    const error = new Error(message || '请求失败，请重试');
    error.status = response.status;
    throw error;
  }
  return result;
}

function action(fn) {
  return async event => {
    const button = event?.currentTarget;
    if (button) button.disabled = true;
    try { await fn(event); }
    catch (error) { toast(error.message || '无法连接本机服务，请保留文字后重试'); }
    finally { if (button?.isConnected) button.disabled = false; }
  };
}

function empty(title, body) {
  return `<div class="empty">${icon('book')}<h3>${esc(title)}</h3><p>${esc(body)}</p></div>`;
}

function pager(element, result, callback) {
  element.innerHTML = result.total > result.page_size ?
    `<button data-prev ${result.page === 1 ? 'disabled' : ''}>上一页</button><span>第 ${result.page} 页 · 共 ${result.total} 条</span><button data-next ${result.has_more ? '' : 'disabled'}>下一页</button>` : '';
  const prev = element.querySelector('[data-prev]'), next = element.querySelector('[data-next]');
  if (prev) prev.onclick = action(() => callback(result.page - 1));
  if (next) next.onclick = action(() => callback(result.page + 1));
}

function entryCards(items) {
  return items.map(e => {
    const attachments = e.attachments || [], image = attachments.find(a => a.kind === 'image');
    const cover = image ? `<img class="entry-media" src="${esc(image.url)}" alt="${esc(image.name)}" loading="lazy">` : '';
    return `<article class="entry"><div class="entry-head"><span class="author-icon">爱</span><div><div class="entry-author">我们的生活</div><div class="entry-meta">${esc(dateLabel(e.date))}${e.place ? ' · ' + esc(e.place) : ''}</div></div></div><div class="entry-content" role="button" tabindex="0" data-entry="${e.id}"><h3>${esc(e.title || '平凡又珍贵的一天')}</h3><p>${esc(e.body.slice(0, 160))}${e.body.length > 160 ? '…' : ''}</p>${cover}${attachments.length ? `<p class="muted">${attachments.length} 个附件 · 点击查看</p>` : ''}</div><div class="entry-bottom">${e.tags.map(t => `<span class="tag"># ${esc(t)}</span>`).join('')}</div></article>`;
  }).join('');
}

function bindEntries(root) {
  root.querySelectorAll('[data-entry]').forEach(button => {
    button.onclick = action(() => openEntry(button.dataset.entry));
    button.onkeydown = event => { if (event.key === 'Enter') button.click(); };
  });
}

async function loadFeed() {
  const token = ++feedRequest;
  const params = new URLSearchParams({ page, page_size: 20, q: $('#search').value.trim(), tag, media_type: $('#typeFilter').value });
  for (const [key, selector] of [['year', '#yearFilter'], ['month', '#monthFilter'], ['story', '#storyFilter']]) {
    if ($(selector).value !== 'all') params.set(key, $(selector).value);
  }
  try {
    const result = await api('/entries?' + params);
    if (token !== feedRequest) return;
    $('#recordCount').textContent = result.total;
    $('#demoNote').textContent = '';
    const items = result.items;
    $('#feed').innerHTML = items.length ? entryCards(items) : empty('把第一段生活写在这里', '没有匹配的记录，试着记下今天的一件小事。');
    bindEntries($('#feed'));
    pager($('#feedPager'), result, async next => { page = next; await loadFeed(); });
  } catch (error) {
    if (token !== feedRequest) return;
    $('#demoNote').textContent = '暂时无法连接服务。仍可打开编辑器，文字草稿会先留在此设备。';
    $('#feed').innerHTML = empty('等连接恢复，再翻看回忆', '可点击“记下这一刻”继续写文字草稿。');
    $('#feedPager').replaceChildren();
  }
}

async function refreshFilters() {
  const result = await api('/filters');
  const oldYear = $('#yearFilter').value;
  $('#yearFilter').innerHTML = '<option value="all">全部年份</option>' + result.years.map(y => `<option value="${y}">${y}年</option>`).join('');
  if (result.years.includes(oldYear)) $('#yearFilter').value = oldYear;
  const chips = $('#tagFilters');
  chips.innerHTML = `<button class="chip ${!tag ? 'active' : ''}" data-filter-tag="">全部</button>` +
    result.tags.map(t => `<button class="chip ${t === tag ? 'active' : ''}" data-filter-tag="${esc(t)}"># ${esc(t)}</button>`).join('');
  chips.querySelectorAll('button').forEach(b => b.onclick = action(async () => {
    tag = b.dataset.filterTag; page = 1;
    chips.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    await loadFeed();
  }));
}

async function refreshStoryChoices() {
  // Bounded choices; the story page itself is paginated. More stories can be searched here later.
  const result = await api('/stories?page_size=100');
  storyChoices = result.items;
  const select = $('#storyFilter'), previous = select.value;
  select.innerHTML = '<option value="all">全部故事</option>' + storyChoices.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  if (storyChoices.some(s => s.id === previous)) select.value = previous;
}

async function refresh() {
  await Promise.all([refreshFilters(), refreshStoryChoices()]);
  if (view === 'timeline') await loadFeed();
  if (view === 'album') await loadAlbum();
  if (view === 'stories') await loadStories();
  if (view === 'manage') await loadManage();
  if (view === 'anniversaries') await loadAnniversaries();
  if (view === 'wishes') await loadWishes();
  if (view === 'footprints') await loadFootprints();
  if (view === 'quizzes') await QuizFeature.load();
}

const titles = { timeline: ['把日子，过成故事。', '有你在的每一个平常，都值得被记住。', '生活时间线'], album: ['每一帧，都有回声。', '照片与视频，留给下一阶段慢慢收藏。', '我们的相册'], stories: ['一起走过的章节。', '把独立的日记，收进同一个故事。', '故事集'], manage: ['给回忆，多一份安心。', '草稿和回收站，让每一段文字都有归处。', '整理与管理'] };
titles.album[1] = '发布过的照片与视频，按发生日期慢慢翻看。';
titles.anniversaries = ['每个重要的日子，都记得。', '因为有你，日历也变得温柔。', '纪念日'];
titles.wishes = ['和你一起，把愿望慢慢实现。', '那些想做的小事，会成为我们的大回忆。', '愿望清单'];
titles.footprints = ['和你走过的地方，都有故事。', '在中国地图上，收藏属于我们的坐标。', '地图足迹'];
titles.quizzes = ['你来出题，我来懂你。', '把小小的默契，变成可以回看的记录。', '互相出题'];
async function navigate(target) {
  view = titles[target] ? target : 'timeline';
  const [title, subtitle, crumb] = titles[view];
  $('#pageTitle').textContent = title; $('#pageSubtitle').textContent = subtitle; $('#crumb').textContent = crumb;
  $$('.view').forEach(element => { element.hidden = element.id !== view + 'View'; });
  $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  if (view === 'timeline') await loadFeed();
  if (view === 'album') await loadAlbum();
  if (view === 'stories') await loadStories();
  if (view === 'manage') await loadManage();
  if (view === 'anniversaries') await loadAnniversaries();
  if (view === 'wishes') await loadWishes();
  if (view === 'footprints') await loadFootprints();
  if (view === 'quizzes') await QuizFeature.load();
}

async function loadAlbum() {
  const request = ++albumRequest;
  const result = await api('/album?page=' + albumPage);
  if (request !== albumRequest) return;
  if (!result.items.length && albumPage > 1) { albumPage = Math.max(1, Math.ceil(result.total / result.page_size)); return loadAlbum(); }
  $('#albumGrid').innerHTML = result.items.length ? result.items.map(item => `<button class="album-item" data-album-entry="${item.entry_id}">${item.kind === 'image' ? `<img src="${esc(item.url)}" alt="${esc(item.name)}" loading="lazy">` : `<span class="album-placeholder">${icon('video')}视频 · 点击查看</span>`}<b>${esc(item.entry_title || item.name)}</b><small>${esc(item.date)} · ${esc(item.name)}</small></button>`).join('') : empty('把第一帧心动放进来', '发布记录中的照片和视频会汇集在这里，草稿文件不展示。');
  $$('[data-album-entry]').forEach(button => { button.onclick = action(() => openEntry(button.dataset.albumEntry)); });
  pager($('#albumPager'), result, async next => { albumPage = next; await loadAlbum(); });
}

async function ensureFootprintMap() {
  if (!footprintMapPromise) {
    footprintMapPromise = JournalMap.create('chinaMap', {
      onPick(point) {
        const data = footprintPicking && footprintEditing ? { ...footprintEditing } : { id: uid(), revision: 0 };
        openFootprintEditor({ ...data, ...point });
      },
      onOpen(id) { openSavedFootprint(id).catch(error => toast(error.message)); },
      onOutside() { $('#mapStatus').textContent = '请在当前中国地图覆盖的范围内标定地点。'; },
      onViewport() {
        clearTimeout(footprintMarkerTimer);
        footprintMarkerTimer = setTimeout(() => loadFootprintMarkers(), 150);
      }
    }).then(controller => { footprintMap = controller; return controller; }).catch(error => {
      footprintMapPromise = null; throw error;
    });
  }
  const controller = await footprintMapPromise;
  controller.invalidate();
  return controller;
}

async function loadFootprintMarkers() {
  if (!footprintMap || view !== 'footprints') return;
  const request = ++footprintMarkerRequest;
  try {
    const params = new URLSearchParams({ ...footprintMap.bounds(), q: $('#footprintSearch').value.trim() });
    const result = await api('/footprints/markers?' + params);
    if (request !== footprintMarkerRequest) return;
    footprintMap.setMarkers(result.items);
    $('#mapStatus').textContent = footprintPicking ? '点击地图，选择这个地点的位置。' : result.has_more ?
      '当前区域地点较多，已显示前 500 个，请放大地图查看。' : `当前视野有 ${result.items.length} 个标记。点击地图添加，点击标记编辑。`;
  } catch { if (request === footprintMarkerRequest) $('#mapStatus').textContent = '标记暂时读取失败，请移动地图或刷新后重试。'; }
}

function footprintCards(items) {
  return items.map((item, index) => `<article class="footprint-card"><h3>${esc(item.name)}</h3><p>${esc(item.province || '我们的一个小坐标')}${item.visited_on ? ' · ' + esc(item.visited_on) : ''}</p>${item.note ? `<p>${esc(item.note)}</p>` : ''}<div class="row-actions"><button class="text-button" data-footprint-locate="${index}">在地图上看</button><button class="text-button" data-footprint-edit="${index}">编辑</button><button class="text-button" data-footprint-trash="${index}">移入回收站</button></div></article>`).join('');
}

async function loadFootprints() {
  const request = ++footprintRequest;
  try {
    const params = new URLSearchParams({ page: footprintPage, q: $('#footprintSearch').value.trim() });
    const result = await api('/footprints?' + params);
    if (request !== footprintRequest) return;
    if (!result.items.length && footprintPage > 1) {
      footprintPage = Math.max(1, Math.ceil(result.total / result.page_size)); return loadFootprints();
    }
    footprintItems = result.items; $('#footprintCount').textContent = result.total;
    $('#footprintList').innerHTML = result.items.length ? footprintCards(result.items) : empty('第一枚足迹，等你来放', '点击地图标定地点，或拖动后选择“标定地图中心”。');
    $$('[data-footprint-locate]').forEach(b => b.onclick = action(async () => {
      const item = footprintItems[Number(b.dataset.footprintLocate)];
      const controller = await ensureFootprintMap(); controller.focus(item);
      $('#chinaMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    $$('[data-footprint-edit]').forEach(b => b.onclick = () => openFootprintEditor(footprintItems[Number(b.dataset.footprintEdit)]));
    $$('[data-footprint-trash]').forEach(b => b.onclick = action(async () => {
      const item = footprintItems[Number(b.dataset.footprintTrash)];
      await api(`/footprints/${item.id}/trash`, { method: 'POST', body: JSON.stringify({ revision: item.revision }) });
      await loadFootprints(); toast('地点已移入回收站，可以恢复');
    }));
    pager($('#footprintPager'), result, async next => { footprintPage = next; await loadFootprints(); });
  } catch (error) {
    if (request !== footprintRequest) return;
    $('#footprintList').innerHTML = empty('暂时无法读取足迹', '请检查本机服务连接，已保存的数据会在连接恢复后读取。');
    $('#footprintPager').replaceChildren();
  }
  try { await ensureFootprintMap(); await loadFootprintMarkers(); }
  catch (error) { $('#mapStatus').textContent = error.message; }
}

function openFootprintEditor(item) {
  footprintEditing = { ...item }; footprintPicking = false;
  $('#footprintForm').reset(); $('#footprintEditorTitle').textContent = item.revision ? '编辑这个地点' : '记下这个地点';
  $('#footprintName').value = item.name || ''; $('#footprintProvince').value = item.province || '';
  $('#footprintDate').value = item.visited_on || ''; $('#footprintNote').value = item.note || '';
  $('#footprintCoordinates').textContent = `选定位置：${Number(item.longitude).toFixed(4)}, ${Number(item.latitude).toFixed(4)}`;
  $('#footprintError').hidden = true;
  footprintMap?.preview(item);
  $('#footprintDialog').showModal(); $('#footprintName').focus();
}

async function openSavedFootprint(id) {
  const item = await api('/footprints/' + id);
  openFootprintEditor(item);
}

function wishCards(items) {
  return items.map((item, index) => `<article class="wish-card ${item.done ? 'is-done' : ''}"><div class="wish-card-head"><button class="wish-toggle" data-wish-toggle="${index}" aria-pressed="${item.done}" aria-label="${item.done ? '放回待完成' : '标记完成'}：${esc(item.title)}">${item.done ? '✓' : '♡'}</button><div><span class="wish-state">${item.done ? '一起实现了' : '等待一起实现'}</span><h3>${esc(item.title)}</h3></div></div>${item.note ? `<p class="wish-note">${esc(item.note)}</p>` : ''}${item.target_date ? `<p class="wish-date">想在 ${esc(item.target_date)} 完成</p>` : ''}${item.completed_at ? `<p class="wish-date">实现于 ${esc(new Date(item.completed_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</p>` : ''}<div class="row-actions"><button class="wish-complete" data-wish-toggle="${index}" aria-pressed="${item.done}">${item.done ? '✓ 已实现（点击撤销）' : '标记已实现'}</button><button class="text-button" data-wish-edit="${index}">编辑愿望</button><button class="text-button" data-wish-trash="${index}">移入回收站</button></div></article>`).join('');
}

async function loadWishes() {
  const request = ++wishRequest;
  const params = new URLSearchParams({ page: wishesPage, status: wishStatus, q: $('#wishSearch').value.trim() });
  try {
    const result = await api('/wishes?' + params);
    if (request !== wishRequest) return;
    if (!result.items.length && wishesPage > 1) {
      wishesPage = Math.max(1, Math.ceil(result.total / result.page_size));
      return loadWishes();
    }
    wishItems = result.items;
    $('#wishProgressText').textContent = `已一起实现 ${result.summary.done} 个愿望，还有 ${result.summary.pending} 个期待`;
    $('#wishProgress').max = Math.max(1, result.summary.total);
    $('#wishProgress').value = result.summary.done;
    $('#wishList').innerHTML = result.items.length ? wishCards(result.items) : empty(
      $('#wishSearch').value.trim() ? '还没找到这个愿望' : wishStatus === 'done' ? '第一份实现的喜悦，正在路上' : wishStatus === 'pending' ? '这页期待，等我们继续写' : '许下第一个小愿望吧',
      $('#wishSearch').value.trim() ? '试试其他关键词，或者看看全部愿望。' : '想一起去的地方、想尝试的小事，都值得记下来。');
    $$('[data-wish-edit]').forEach(b => b.onclick = () => openWishEditor(wishItems[Number(b.dataset.wishEdit)]));
    $$('[data-wish-toggle]').forEach(b => b.onclick = action(async () => {
      const item = wishItems[Number(b.dataset.wishToggle)];
      await api(`/wishes/${item.id}/status`, { method: 'POST', body: JSON.stringify({ revision: item.revision, done: !item.done }) });
      wishesPage = 1; await loadWishes();
      toast(item.done ? '愿望已放回待完成，慢慢实现就好' : '又一起实现了一个小愿望');
    }));
    $$('[data-wish-trash]').forEach(b => b.onclick = action(async () => {
      const item = wishItems[Number(b.dataset.wishTrash)];
      await api(`/wishes/${item.id}/trash`, { method: 'POST', body: JSON.stringify({ revision: item.revision }) });
      await loadWishes(); toast('愿望已移入回收站，可以恢复');
    }));
    pager($('#wishPager'), result, async next => { wishesPage = next; await loadWishes(); });
  } catch (error) {
    if (request !== wishRequest) return;
    $('#wishProgressText').textContent = '暂时无法读取愿望清单';
    $('#wishProgress').value = 0;
    $('#wishList').innerHTML = empty('等连接恢复，再一起许愿', '请检查服务连接后重试。') + '<button class="button secondary" id="retryWishes">重新读取</button>';
    $('#wishPager').replaceChildren();
    $('#retryWishes').onclick = action(() => loadWishes());
  }
}

function openWishEditor(item = null) {
  wishEditing = item ? { ...item } : { id: uid(), revision: 0 };
  $('#wishForm').reset();
  $('#wishEditorTitle').textContent = item ? '继续写这个愿望' : '许一个愿望';
  $('#wishTitle').value = item?.title || '';
  $('#wishNote').value = item?.note || '';
  $('#wishTargetDate').value = item?.target_date || '';
  $('#wishError').hidden = true;
  $('#wishDialog').showModal(); $('#wishTitle').focus();
}

function anniversaryCountdown(item) {
  if (item.days_until === null) return '请先确认历法';
  if (item.days_until === 0) return '就是今天';
  if (item.days_until === 1) return '明天就到了';
  return `还有 ${item.days_until} 天`;
}

function anniversaryYears(item) {
  if (!item.years || item.years < 0) return '';
  return item.kind === 'birthday' ? `${item.years} 岁生日` : `第 ${item.years} 周年`;
}

async function loadAnniversaries() {
  const result = await api('/anniversaries?page=' + anniversaryPage);
  anniversaryItems = result.items;
  $('#anniversaryList').innerHTML = result.items.length ? result.items.map((item, index) =>
    `<article class="anniversary-card ${item.days_until === 0 ? 'is-today' : ''}"><span class="anniversary-badge">${item.kind === 'birthday' ? '生日' : item.kind === 'other' ? '特别日子' : '纪念日'}</span><h3>${esc(item.name)}</h3><div class="anniversary-date">${item.calendar === 'solar' ? '公历' : '历法待确认'} · ${item.month} 月 ${item.day} 日${anniversaryYears(item) ? ' · ' + anniversaryYears(item) : ''}</div><div class="anniversary-countdown">${anniversaryCountdown(item)}</div><p class="muted">${item.next_on ? '下一次：' + esc(item.next_on) + ' · ' : ''}${!item.enabled ? '提醒已关闭' : item.calendar === 'unconfirmed' ? '确认公历／农历后再开启日期计算' : item.remind_days === 0 ? '当天进入网站时提醒' : `提前 ${item.remind_days} 天起至当天提醒`}</p>${item.note ? `<p class="anniversary-note">${esc(item.note)}</p>` : ''}<div class="row-actions"><button class="text-button" data-anniversary-edit="${index}">编辑这个日子</button><button class="text-button" data-anniversary-trash="${index}">移入回收站</button></div></article>`
  ).join('') : empty('给重要的日子留一个位置', '添加生日、纪念日，或任何想认真记得的日子。');
  $$('[data-anniversary-edit]').forEach(b => b.onclick = () => openAnniversaryEditor(anniversaryItems[Number(b.dataset.anniversaryEdit)]));
  $$('[data-anniversary-trash]').forEach(b => b.onclick = action(async () => {
    const item = anniversaryItems[Number(b.dataset.anniversaryTrash)];
    await api(`/anniversaries/${item.id}/trash`, { method: 'POST', body: JSON.stringify({ revision: item.revision }) });
    pendingAnniversaryReminder = null;
    await loadAnniversaries(); toast('纪念日已移入回收站，可以恢复');
  }));
  pager($('#anniversaryPager'), result, async next => { anniversaryPage = next; await loadAnniversaries(); });
}

function openAnniversaryEditor(item = null) {
  anniversaryEditing = item ? { ...item } : { id: uid(), revision: 0 };
  $('#anniversaryForm').reset();
  $('#anniversaryEditorTitle').textContent = item ? '编辑这个日子' : '添加纪念日';
  $('#anniversaryName').value = item?.name || '';
  $('#anniversaryKind').value = item?.kind || 'anniversary';
  $('#anniversaryCalendar').value = item?.calendar || 'solar';
  $('#anniversaryMonth').value = item?.month || '';
  $('#anniversaryDay').value = item?.day || '';
  $('#anniversaryYear').value = item?.start_year || '';
  $('#anniversaryLead').value = item?.remind_days ?? 0;
  $('#anniversaryNote').value = item?.note || '';
  $('#anniversaryEnabled').checked = item?.enabled ?? true;
  $('#anniversaryError').hidden = true;
  $('#anniversaryDialog').showModal(); $('#anniversaryName').focus();
}

function presentAnniversaryReminder() {
  if (!pendingAnniversaryReminder) return;
  // Do not cover an editor or interrupt unsaved typing with a second modal.
  if (['editor', 'detail', 'storyDialog', 'anniversaryDialog', 'wishDialog', 'footprintDialog', 'authDialog', 'questionDialog', 'quizAnswerDialog', 'reminderDialog'].some(id => $('#' + id).open)) return;
  const result = pendingAnniversaryReminder;
  pendingAnniversaryReminder = null;
  $('#reminderDate').textContent = `${result.today} · 北京时间 · ${result.total} 个特别日子`;
  $('#reminderItems').innerHTML = result.items.map(item =>
    `<article class="reminder-item"><h3>${esc(item.name)}</h3><b>${anniversaryCountdown(item)}</b><p>${esc(item.next_on)}${anniversaryYears(item) ? ' · ' + anniversaryYears(item) : ''}</p>${item.note ? `<p>${esc(item.note)}</p>` : ''}</article>`
  ).join('');
  $('#reminderMore').hidden = !result.has_more;
  $('#reminderDialog').showModal();
  anniversaryReminderShown = true;
}

async function checkAnniversaryReminders(force = false) {
  if (anniversaryReminderShown && !force) return;
  try {
    const result = await api('/anniversaries/reminders');
    if (anniversaryReminderShown && !force) return;
    if (!result.items.length) {
      if (force) toast('今天没有到期提醒。可在纪念日里确认日期、设置提前天数。');
      return;
    }
    pendingAnniversaryReminder = result;
    presentAnniversaryReminder();
  } catch (error) {
    if (force) throw error;
    // A temporary connection failure must not interrupt entry or draft editing.
  }
}

async function openEntry(id) {
  $$('#detail audio,#detail video').forEach(element => element.pause());
  const e = await api('/entries/' + id);
  const root = $('#detailContent');
  root.innerHTML = `<h2>${esc(e.title || '平凡又珍贵的一天')}</h2><div class="detail-meta">${esc(dateLabel(e.date))}${e.place ? ' · ' + esc(e.place) : ''}</div><div class="detail-body">${esc(e.body)}</div><p>${e.tags.map(t => '# ' + esc(t)).join('　')}</p><div class="record-attachments">${(e.attachments || []).map(MediaFeature.attachmentHTML).join('')}</div><div class="detail-actions"><button class="button secondary" id="historyButton">文字历史 · ${e.history_count}</button><button class="button secondary" id="editButton">编辑记录</button><button class="button secondary" id="deleteButton">移入回收站</button></div><div id="historyPanel" hidden></div>`;
  MediaFeature.bindPreviews(root);
  if (!$('#detail').open) $('#detail').showModal();
  $('#editButton').onclick = action(async () => { $('#detail').close(); await openEditor(e); });
  $('#deleteButton').onclick = action(async () => {
    await api(`/entries/${id}/trash`, { method: 'POST', body: JSON.stringify({ revision: e.revision }) });
    $('#detail').close(); await refresh(); toast('已移入回收站，可以恢复');
  });
  $('#historyButton').onclick = action(async () => {
    const panel = $('#historyPanel'); panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    const load = async next => {
      const result = await api(`/entries/${id}/history?page=${next}`);
      panel.innerHTML = result.items.length ? result.items.map(h => `<div class="history-item"><small>${esc(new Date(h.saved_at).toLocaleString())}</small><p><b>${esc(h.title)}</b></p><p>${esc(h.body)}</p><button class="text-button" data-history="${h.id}">恢复此文字版本</button></div>`).join('') : '<p class="muted">修改正文或标题后，会保留此前的文字版本。</p>';
      panel.querySelectorAll('[data-history]').forEach(b => b.onclick = action(async () => {
        await api(`/entries/${id}/history/${b.dataset.history}/restore`, { method: 'POST', body: JSON.stringify({ revision: e.revision }) });
        await openEntry(id); await refresh(); toast('文字版本已恢复，发生日期保持不变');
      }));
      const pages = document.createElement('div'); pages.className = 'pager'; panel.append(pages);
      pager(pages, result, load);
    };
    await load(1);
  });
}

async function loadStories() {
  const result = await api('/stories?page=' + storiesPage);
  $('#storiesGrid').innerHTML = result.items.length ? result.items.map(s => `<button class="story-card" data-story="${s.id}"><div class="story-cover">${icon('book')}</div><div class="story-card-content"><h3>${esc(s.name)}</h3><p>${esc(s.description || '一起，把这个故事慢慢写完整。')}</p><small>${s.entry_count} 段回忆</small></div></button>`).join('') : empty('新的故事，从这里开始', '旅行、纪念日，或一段想单独珍藏的日常。');
  $$('[data-story]').forEach(b => b.onclick = action(() => openStory(b.dataset.story)));
  pager($('#storiesPager'), result, async next => { storiesPage = next; await loadStories(); });
}

async function openStory(id, selectedPage = 1) {
  const [story, entries] = await Promise.all([api('/stories/' + id), api(`/entries?story=${id}&order=asc&page=${selectedPage}`)]);
  const root = $('#detailContent');
  root.innerHTML = `<h2>${esc(story.name)}</h2><p class="detail-body">${esc(story.description)}</p><div class="detail-meta">${entries.total} 段回忆 · 从旧到新</div><div class="story-detail-list">${entries.items.map(e => `<button data-entry="${e.id}"><small>${esc(e.date)}</small><b>${esc(e.title || '生活片段')}</b></button>`).join('') || '<p>发布或编辑记录时，可以将它收进这个故事。</p>'}</div><div id="storyPager" class="pager"></div><div class="detail-actions"><button class="button secondary" id="deleteStory">删除故事，保留记录</button><button class="button primary" id="addToStory">为故事添一页</button></div>`;
  if (!$('#detail').open) $('#detail').showModal();
  bindEntries(root); pager($('#storyPager'), entries, next => openStory(id, next));
  $('#addToStory').onclick = action(async () => { $('#detail').close(); await openEditor(null, null, story); });
  $('#deleteStory').onclick = action(async () => {
    await api(`/stories/${id}/trash`, { method: 'POST', body: JSON.stringify({ revision: story.revision }) });
    $('#detail').close(); await refresh(); toast('故事已移入回收站，其中的记录仍保留');
  });
}

function localDrafts() {
  const result = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(LOCAL_PREFIX)) {
        try { result.push(JSON.parse(localStorage.getItem(key))); } catch { /* Do not alter unrecognized storage. */ }
      }
    }
  } catch { localReady = false; }
  return result.sort((a, b) => b.local_saved_at.localeCompare(a.local_saved_at));
}

function storeLocal(data) {
  try { localStorage.setItem(LOCAL_PREFIX + data.id, JSON.stringify(data)); localReady = true; }
  catch { localReady = false; editorError('此设备无法保存离线草稿。请保持页面打开，确认服务已保存后再关闭。'); }
}

function collect() {
  return { ...draft, title: $('#entryTitle').value, body: $('#entryBody').value,
    date: $('#entryDate').value || today(), place: $('#entryPlace').value,
    tags: $('#entryTags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean),
    story: $('#entryStory').value || null, attachment_ids: MediaFeature.readyIds(), local_saved_at: new Date().toISOString() };
}

function captureDraft() {
  if (!draft || publishing) return;
  draft = collect();
  if (draft.title.trim() || draft.body.trim() || MediaFeature.hasItems()) storeLocal(draft);
  $('#draftStatus').textContent = localReady ? '文字已暂存此设备，等待保存到服务…' : '此设备暂存不可用';
}

function saveDraft(force = false) {
  clearTimeout(draftTimer);
  if (!draft || publishing) return saveChain;
  captureDraft();
  if (!force && !draft.title.trim() && !draft.body.trim() && !MediaFeature.hasItems()) return saveChain;
  const selected = draft;
  saveChain = saveChain.catch(() => {}).then(async () => {
    // Earlier requests update the version before the next queued save starts.
    const current = draft?.id === selected.id ? draft : selected;
    const { id, local_saved_at, ...payload } = current;
    try {
      const saved = await api('/drafts/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      if (draft?.id === id) {
        draft.revision = saved.revision;
        storeLocal(draft);
        $('#draftStatus').textContent = '草稿已保存到本机服务';
        editorError();
      }
      return saved;
    } catch (error) {
      if (draft?.id === id) {
        $('#draftStatus').textContent = localReady ? '草稿保留在此设备，尚未保存到服务' : '草稿尚未保存，请保持页面打开';
        editorError(error.status === 409 ? error.message : '暂时无法保存到服务。请保留此页或使用此设备草稿继续写。');
      }
      throw error;
    }
  });
  return saveChain;
}

async function openEditor(entry = null, saved = null, story = null) {
  if (MediaFeature.busy()) { toast('请等待上传完成，或先取消正在上传的文件'); return; }
  clearTimeout(draftTimer);
  await saveChain.catch(() => {});
  draft = saved ? structuredClone(saved) : {
    id: uid(), entry_id: entry?.id || uid(), editing_id: entry?.id || null,
    editing_revision: entry?.revision || null, revision: 0,
    title: entry?.title || '', body: entry?.body || '', date: entry?.date || today(),
    place: entry?.place || '', tags: entry?.tags || [], story: story?.id || entry?.story || null,
    attachment_ids: entry?.attachment_ids || [], local_saved_at: new Date().toISOString()
  };
  // Server list metadata is not part of the draft write schema.
  delete draft.updated_at;
  delete draft.attachments;
  draft.local_saved_at ||= new Date().toISOString();
  $('#editorTitle').textContent = draft.editing_id ? '继续写这段生活' : '记下这一刻';
  for (const [id, key] of [['entryTitle', 'title'], ['entryBody', 'body'], ['entryDate', 'date'], ['entryPlace', 'place']]) $('#' + id).value = draft[key];
  $('#entryTags').value = draft.tags.join('，');
  const choices = [...storyChoices];
  if (story && !choices.some(s => s.id === story.id)) choices.push(story);
  if (draft.story && !choices.some(s => s.id === draft.story)) {
    try { choices.push(await api('/stories/' + draft.story)); }
    catch { choices.push({ id: draft.story, name: '原故事（联网后确认）' }); }
  }
  $('#entryStory').innerHTML = '<option value="">暂不收进故事</option>' + choices.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#entryStory').value = draft.story || '';
  await MediaFeature.open({ draftId: draft.id, editingId: draft.editing_id,
    attachmentIds: draft.attachment_ids || [], attachments: saved?.attachments || entry?.attachments || [] });
  draft.attachment_ids = MediaFeature.readyIds();
  editorError(); $('#draftStatus').textContent = '编辑文字会自动保存草稿';
  $('#editor').showModal(); $('#entryTitle').focus();
}

async function closeEditor() {
  if (MediaFeature.busy()) { editorError('文件正在上传，请等待完成，或点击文件旁的“取消并移除”。'); return; }
  const saved = await saveDraft().catch(() => null);
  if (!localReady && !saved && draft && (draft.title.trim() || draft.body.trim() || MediaFeature.hasItems())) {
    editorError('此设备暂存不可用。请确认文字已保存到服务，或复制文字后再关闭。');
    return;
  }
  $('#editor').close(); draft = null; MediaFeature.reset();
  if (view === 'manage') await loadManage();
}

$('#entryForm').onsubmit = async event => {
  event.preventDefault(); clearTimeout(draftTimer);
  if (publishing) return;
  captureDraft();
  if (!MediaFeature.canPublish()) { editorError('请先完成或移除未成功的上传，已上传成功的文件会保留。'); return; }
  if (!draft.body.trim() && !draft.attachment_ids.length) { editorError('写一句话或添加至少一个附件，就可以发布。'); return; }
  const controls = $$('#entryForm input,#entryForm textarea,#entryForm select,#entryForm button');
  MediaFeature.setLocked(true);
  controls.forEach(control => { control.disabled = true; });
  try {
    await saveDraft(); publishing = true;
    const { title, body, date, place, tags, story, attachment_ids, entry_id, editing_revision, id, revision } = draft;
    await api('/entries', { method: 'POST', body: JSON.stringify({ id: entry_id, title, body, date, place, tags, story,
      attachment_ids, revision: editing_revision || 0, draft_id: id, draft_revision: revision }) });
    try { localStorage.removeItem(LOCAL_PREFIX + id); } catch { /* Server data is already committed. */ }
    draft = null; MediaFeature.reset(); $('#editor').close(); page = 1;
    await refresh(); toast('这段生活已保存到本机服务');
  } catch (error) { editorError(error.message || '发布失败，文字草稿仍保留'); }
  finally { publishing = false; MediaFeature.setLocked(false); controls.forEach(control => { control.disabled = false; }); }
};

async function loadManage() {
  const root = $('#manageContent');
  if (manageTab === 'backup') {
    root.innerHTML = '<div class="manage-card"><h3>给回忆，多一份安心</h3><p>完整备份与恢复会在媒体数据库方案落实后一起接入。当前没有完整备份功能。</p><p>文字、草稿、故事和历史版本已由本机数据库保存。请勿删除服务的数据目录。</p></div>';
    return;
  }
  if (manageTab === 'trash') {
    const result = await api('/trash?page=' + managePage);
    root.innerHTML = '<div class="manage-card"><h3>回忆，还在这里</h3><p>删除后可以恢复。永久删除的专用密钥验证尚未接入，当前不提供永久删除。</p>' +
      (result.items.length ? result.items.map(t => `<div class="manage-row"><div><h3>${esc(t.name || '生活片段')}</h3><p>${t.kind === 'entry' ? '生活记录' : t.kind === 'anniversary' ? '纪念日' : t.kind === 'wish' ? '愿望' : t.kind === 'footprint' ? '地图足迹' : ['attachment', 'upload'].includes(t.kind) ? '附件' : '故事'} · ${esc(new Date(t.deleted_at).toLocaleString())}</p></div><button class="button secondary" data-restore="${t.id}" data-kind="${t.kind}" data-revision="${t.revision}">恢复</button></div>`).join('') : empty('回收站还是空的', '删除的记录、附件、故事、纪念日、愿望和地点会出现在这里。')) + '</div><div class="pager" id="managePager"></div>';
    root.querySelectorAll('[data-restore]').forEach(b => b.onclick = action(async () => {
      await api(`/trash/${b.dataset.kind}/${b.dataset.restore}/restore`, { method: 'POST', body: JSON.stringify({ revision: Number(b.dataset.revision) }) });
      await refresh(); toast('已恢复');
    }));
    pager($('#managePager'), result, async next => { managePage = next; await loadManage(); });
    return;
  }
  const local = localDrafts();
  let remote = { items: [], total: 0, page: 1, page_size: 20 }, offline = false;
  try { remote = await api('/drafts?page=' + managePage); } catch { offline = true; }
  const localIds = new Set(local.map(d => d.id));
  const available = [...local, ...remote.items.filter(d => !localIds.has(d.id))];
  root.innerHTML = `<div class="manage-card"><h3>留给下一次的灵感</h3><p>${offline ? '服务暂不可用，当前展示此设备草稿。' : '服务草稿可以在同一个服务中继续编辑；此设备草稿也会保留。'}</p>` +
    (available.length ? available.map((d, index) => `<div class="manage-row"><div><h3>${esc(d.title || d.body.slice(0, 24) || '未命名草稿')}</h3><p>${esc(d.date)} · ${localIds.has(d.id) ? '此设备留存' : '服务草稿'}</p></div><div class="row-actions"><button class="button secondary" data-draft="${index}">继续写</button>${localIds.has(d.id) ? `<button class="text-button" data-copy-draft="${index}">另存文字草稿</button>` : ''}</div></div>`).join('') : empty('还没有没写完的日子', '写记录时，文字会自动存入草稿箱。')) + '</div><div class="pager" id="managePager"></div>';
  root.querySelectorAll('[data-draft]').forEach(b => b.onclick = action(() => openEditor(null, available[Number(b.dataset.draft)])));
  root.querySelectorAll('[data-copy-draft]').forEach(b => b.onclick = action(() => {
    const original = available[Number(b.dataset.copyDraft)];
    const copy = { ...original, id: uid(), entry_id: uid(), revision: 0, editing_id: null, editing_revision: null, attachment_ids: [], attachments: [] };
    return openEditor(null, copy);
  }));
  pager($('#managePager'), remote, async next => { managePage = next; await loadManage(); });
}

$$('[data-view]').forEach(b => b.onclick = action(() => navigate(b.dataset.view)));
window.addEventListener('hashchange', () => { navigate(location.hash.slice(1)).catch(error => toast(error.message)); });
$$('[data-future]').forEach(b => b.onclick = () => toast(b.dataset.future + '已列入后续计划'));
$('#profile').onclick = action(() => QuizFeature.openAccount());
$('#filterToggle').onclick = () => { $('#extraFilters').hidden = !$('#extraFilters').hidden; };
for (let month = 1; month <= 12; month++) $('#monthFilter').add(new Option(month + '月', String(month)));
$('#search').oninput = () => {
  clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; loadFeed(); }, 250);
};
$$('.extra-filters select').forEach(s => s.onchange = action(async () => { page = 1; await loadFeed(); }));
for (const id of ['compose', 'heroCompose', 'mobileCompose']) $('#' + id).onclick = action(() => openEditor());
$('#storyFeature').onclick = action(() => navigate('stories'));
$('#newAnniversary').onclick = () => openAnniversaryEditor();
$('#newWish').onclick = () => openWishEditor();
$('#addFootprint').onclick = action(async () => {
  await ensureFootprintMap(); footprintEditing = { id: uid(), revision: 0 }; footprintPicking = true;
  $('#mapStatus').textContent = '点击地图选一个位置，或拖动地图后点击“标定地图中心”。';
  $('#chinaMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('#resetChinaMap').onclick = action(async () => { (await ensureFootprintMap()).reset(); });
$('#markMapCenter').onclick = action(async () => {
  const controller = await ensureFootprintMap(); const point = controller.center();
  if (!JournalMap.validPoint(point)) { $('#mapStatus').textContent = '请把地图中心移动到中国地图覆盖范围内。'; return; }
  const original = footprintPicking && footprintEditing ? footprintEditing : { id: uid(), revision: 0 };
  openFootprintEditor({ ...original, ...point });
});
$('#footprintSearch').oninput = () => {
  clearTimeout(footprintSearchTimer);
  footprintSearchTimer = setTimeout(() => { footprintPage = 1; loadFootprints(); }, 250);
};
$('#repositionFootprint').onclick = action(async () => {
  footprintEditing = { ...footprintEditing, name: $('#footprintName').value,
    province: $('#footprintProvince').value, visited_on: $('#footprintDate').value || null, note: $('#footprintNote').value };
  footprintPicking = true; $('#footprintDialog').close();
  $('#mapStatus').textContent = '重新点击地图选择位置，已经填写的文字会保留。';
});
$('#footprintDialog').addEventListener('cancel', event => { if (footprintSaving) event.preventDefault(); });
$('#footprintDialog').addEventListener('close', () => {
  if (!footprintPicking) { footprintEditing = null; footprintMap?.preview(null); }
});
$('#footprintForm').onsubmit = async event => {
  event.preventDefault(); if (footprintSaving) return;
  footprintSaving = true;
  const controls = $$('#footprintForm input,#footprintForm textarea,#footprintForm button');
  controls.forEach(control => { control.disabled = true; });
  try {
    await api('/footprints', { method: 'POST', body: JSON.stringify({ id: footprintEditing.id, revision: footprintEditing.revision,
      name: $('#footprintName').value, province: $('#footprintProvince').value, note: $('#footprintNote').value,
      visited_on: $('#footprintDate').value || null, longitude: footprintEditing.longitude, latitude: footprintEditing.latitude }) });
    footprintPicking = false; $('#footprintDialog').close(); footprintPage = 1;
    await loadFootprints(); toast('这个地点已保存到我们的地图');
  } catch (error) { $('#footprintError').textContent = error.message; $('#footprintError').hidden = false; }
  finally { footprintSaving = false; controls.forEach(control => { control.disabled = false; }); }
};
$$('[data-wish-status]').forEach(button => button.onclick = action(async () => {
  wishStatus = button.dataset.wishStatus; wishesPage = 1;
  $$('[data-wish-status]').forEach(item => {
    item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button));
  });
  await loadWishes();
}));
$('#wishSearch').oninput = () => {
  clearTimeout(wishSearchTimer);
  wishSearchTimer = setTimeout(() => { wishesPage = 1; loadWishes(); }, 250);
};
$('#wishDialog').addEventListener('cancel', event => { if (wishSaving) event.preventDefault(); });
$('#wishForm').onsubmit = async event => {
  event.preventDefault();
  if (wishSaving) return;
  wishSaving = true;
  const controls = $$('#wishForm input,#wishForm textarea,#wishForm button');
  controls.forEach(control => { control.disabled = true; });
  try {
    await api('/wishes', { method: 'POST', body: JSON.stringify({ id: wishEditing.id, revision: wishEditing.revision,
      title: $('#wishTitle').value, note: $('#wishNote').value, target_date: $('#wishTargetDate').value || null }) });
    $('#wishDialog').close(); wishesPage = 1;
    await loadWishes(); toast('这个愿望已经记在我们的清单里');
  } catch (error) {
    $('#wishError').textContent = error.message; $('#wishError').hidden = false;
  } finally { wishSaving = false; controls.forEach(control => { control.disabled = false; }); }
};
$('#previewReminders').onclick = action(() => checkAnniversaryReminders(true));
$('#reminderManage').onclick = action(async () => { $('#reminderDialog').close(); await navigate('anniversaries'); });
$('#anniversaryForm').onsubmit = async event => {
  event.preventDefault();
  const controls = $$('#anniversaryForm input,#anniversaryForm textarea,#anniversaryForm select,#anniversaryForm button');
  controls.forEach(control => { control.disabled = true; });
  const data = { id: anniversaryEditing.id, revision: anniversaryEditing.revision,
    name: $('#anniversaryName').value, kind: $('#anniversaryKind').value, calendar: $('#anniversaryCalendar').value,
    month: Number($('#anniversaryMonth').value), day: Number($('#anniversaryDay').value),
    start_year: $('#anniversaryYear').value ? Number($('#anniversaryYear').value) : null,
    remind_days: Number($('#anniversaryLead').value), enabled: $('#anniversaryEnabled').checked,
    note: $('#anniversaryNote').value };
  try {
    await api('/anniversaries', { method: 'POST', body: JSON.stringify(data) });
    pendingAnniversaryReminder = null;
    $('#anniversaryDialog').close(); anniversaryPage = 1;
    await loadAnniversaries(); toast('这个特别的日子，已经记好了');
  } catch (error) {
    $('#anniversaryError').textContent = error.message;
    $('#anniversaryError').hidden = false;
  } finally { controls.forEach(control => { control.disabled = false; }); }
};
for (const id of ['editor', 'detail', 'storyDialog', 'anniversaryDialog', 'wishDialog', 'footprintDialog', 'authDialog', 'questionDialog', 'quizAnswerDialog']) {
  $('#' + id).addEventListener('close', () => { presentAnniversaryReminder(); });
}
// Future authentication can dispatch this event after a successful sign-in.
window.addEventListener('journal:login-success', () => {
  checkAnniversaryReminders();
});
$$('#entryForm input,#entryForm textarea,#entryForm select').forEach(input => input.addEventListener('input', () => {
  if (publishing) return;
  captureDraft(); clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveDraft().catch(() => {}), 700);
}));
$('#saveDraft').onclick = action(async () => { await saveDraft(); toast('草稿已保存到本机服务'); });
$('#editor').addEventListener('cancel', event => { event.preventDefault(); if (!publishing) closeEditor().catch(error => toast(error.message)); });
$$('[data-close]').forEach(b => b.onclick = action(async () => {
  if (b.dataset.close === 'editor') { if (!publishing) await closeEditor(); }
  else $('#' + b.dataset.close).close();
}));
$('#newStory').onclick = () => { $('#storyForm').reset(); $('#storyDialog').showModal(); };
$('#storyForm').onsubmit = async event => {
  event.preventDefault(); const button = $('#storyForm button[type=submit]'); button.disabled = true;
  try {
    await api('/stories', { method: 'POST', body: JSON.stringify({ name: $('#storyName').value, description: $('#storyDescription').value }) });
    $('#storyDialog').close(); storiesPage = 1; await refresh(); toast('新故事已创建');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
};
$$('[data-manage]').forEach(b => b.onclick = action(async () => {
  manageTab = b.dataset.manage; managePage = 1;
  $$('[data-manage]').forEach(x => x.classList.toggle('active', x === b)); await loadManage();
}));
window.addEventListener('online', () => {
  if (draft && $('#editor').open) saveDraft().catch(() => {});
  refresh().catch(() => {});
});
window.addEventListener('pagehide', () => { if ($('#editor').open) captureDraft(); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
$('#detail').addEventListener('close', () => { $$('#detail audio,#detail video').forEach(element => element.pause()); });
MediaFeature.init({ $, $$, api, esc, icon, action, toast, uid,
  changed: () => { if (!draft || publishing) return; captureDraft(); clearTimeout(draftTimer); draftTimer = setTimeout(() => saveDraft().catch(() => {}), 700); },
  ensureDraft: async () => { if (!draft) throw new Error('请先打开记录编辑器'); await saveDraft(true); return draft.id; } });
QuizFeature.init({ $, $$, api, esc, action, empty, pager, toast, uid, getView: () => view,
  onLogin: () => checkAnniversaryReminders() });
Promise.allSettled([refreshFilters(), refreshStoryChoices()])
  .then(() => navigate(location.hash.slice(1) || 'timeline'))
  .then(() => checkAnniversaryReminders())
  .catch(error => toast(error.message));
