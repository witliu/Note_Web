/* Independent per-file uploads. Only acknowledged database objects enter attachment IDs. */
globalThis.MediaFeature = (() => {
  let h, items = [], draftId = null, editingId = null, workers = 0, generation = 0;
  let maximum = 1024 * 1024 * 1024, reselectId = null, locked = false;
  let previewId = null;
  let sorting = null;
  const kindName = kind => ({ image: '照片', video: '视频', audio: '音频', document: '文档' }[kind] || '文件');
  const imageURL = item => item.preview_url || (/\.dng$/i.test(item.name || '') && item.id ? `/api/media/${item.id}/preview` : item.url);
  const sizeLabel = size => size >= 1024 ** 3 ? (size / 1024 ** 3).toFixed(2) + ' GiB' : size >= 1024 ** 2 ? (size / 1024 ** 2).toFixed(1) + ' MiB' : size >= 1024 ? (size / 1024).toFixed(1) + ' KiB' : size + ' B';
  const hasItems = () => items.length > 0;
  const busy = () => workers > 0 || items.some(item => item.removing);
  const readyIds = () => items.filter(item => !item.discarded && ['ready', 'unknown'].includes(item.status)).map(item => item.id);
  const canPublish = () => !busy() && items.every(item => item.status === 'ready' && !item.discarded);
  function releasePreview(item) {
    if (item.previewURL) { globalThis.URL?.revokeObjectURL?.(item.previewURL); delete item.previewURL; }
  }
  function preparePreview(item, file) {
    releasePreview(item);
    if ((/^image\/(jpeg|png|gif|webp|bmp|avif|heic|heif|tiff)$/i.test(file.type || '') || /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|tiff?)$/i.test(file.name)) && globalThis.URL?.createObjectURL) {
      try { item.previewURL = URL.createObjectURL(file); } catch { /* A ready object can still be previewed from the service. */ }
    }
  }
  const previewURL = item => item.previewURL || (item.status === 'ready' && item.kind === 'image' ? imageURL(item) : null);
  function thumbnailHTML(item, previous) {
    const url = previewURL(item);
    if (url && previous.get(item.id)?.querySelector('img')?.getAttribute('src') === url) {
      return `<span data-upload-preview-slot="${item.id}"></span>`;
    }
    return url ? `<button type="button" class="media-upload-thumb" data-upload-preview="${item.id}" aria-label="查看大图：${h.esc(item.name)}"><img src="${h.esc(url)}" alt="${h.esc(item.name)}" loading="lazy" width="96" height="96" data-upload-thumbnail><span class="media-thumb-fallback" hidden>此格式暂不能预览</span><small>点击查看大图</small></button>` : `<div class="media-upload-icon">${h.icon(item.kind === 'document' ? 'book' : item.kind || 'image')}</div>`;
  }
  function refreshPreview() {
    const dialog = h.$('#mediaPreviewDialog');
    if (!dialog.open) return;
    const item = items.find(i => i.id === previewId), url = item && previewURL(item);
    if (!url) { dialog.close(); return; }
    const img = h.$('#mediaPreviewImage');
    if (img.getAttribute('src') !== url) {
      img.hidden = false; h.$('#mediaPreviewError').hidden = true; img.src = url;
    }
    img.alt = item.name;
    h.$('#mediaPreviewTitle').textContent = item.name;
    h.$('#mediaPreviewStatus').textContent = item.status === 'ready' ? '已入库图片预览 · 原件可下载' : '选中图片预览 · 尚未完成上传';
    const download = h.$('#mediaPreviewDownload');
    download.hidden = item.status !== 'ready';
    if (item.status === 'ready') download.href = item.download_url;
  }
  function openPreview(id) {
    const item = items.find(i => i.id === id);
    if (!item || !previewURL(item)) return;
    previewId = id;
    if (!h.$('#mediaPreviewDialog').open) h.$('#mediaPreviewDialog').showModal();
    refreshPreview();
  }
  function changed() { render(); h.changed(); }
  function clearSort() {
    sorting = null;
    h.$$('[data-upload-row]').forEach(row => {
      for (const name of ['is-sorting', 'drop-before', 'drop-after']) row.classList.toggle(name, false);
    });
  }
  function moveTo(id, target) {
    if (locked || busy() || !Number.isInteger(target) || target < 0 || target >= items.length) return false;
    const source = items.findIndex(item => item.id === id);
    if (source < 0 || source === target) return false;
    const [item] = items.splice(source, 1);
    items.splice(target, 0, item);
    changed();
    h.$('#attachmentSortStatus').textContent = `已移到第 ${target + 1} 项，保存记录后按此顺序展示。`;
    return true;
  }
  function bindSorting() {
    h.$$('[data-upload-drag]').forEach(handle => {
      handle.onpointerdown = event => {
        if (locked || busy() || items.length < 2 || event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
        event.preventDefault();
        const source = items.findIndex(item => item.id === handle.dataset.uploadDrag);
        sorting = { id: handle.dataset.uploadDrag, pointerId: event.pointerId, source, target: source };
        handle.setPointerCapture?.(event.pointerId);
        handle.closest('[data-upload-row]')?.classList.toggle('is-sorting', true);
      };
      handle.onpointermove = event => {
        if (!sorting || sorting.pointerId !== event.pointerId) return;
        const editor = h.$('#editor'), edge = editor.getBoundingClientRect?.();
        if (edge && event.clientY < edge.top + 48) editor.scrollBy?.(0, -18);
        else if (edge && event.clientY > edge.bottom - 48) editor.scrollBy?.(0, 18);
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-upload-row]');
        const index = row && items.findIndex(item => item.id === row.dataset.uploadRow);
        if (!row || index < 0) { sorting.target = sorting.source; return; }
        const rect = row.getBoundingClientRect();
        const before = event.clientY < rect.top + rect.height / 2;
        const boundary = index + (before ? 0 : 1);
        sorting.target = boundary > sorting.source ? boundary - 1 : boundary;
        h.$$('[data-upload-row]').forEach(candidate => {
          candidate.classList.toggle('drop-before', candidate === row && before);
          candidate.classList.toggle('drop-after', candidate === row && !before);
        });
      };
      handle.onpointerup = event => {
        if (!sorting || sorting.pointerId !== event.pointerId) return;
        const { id, target } = sorting;
        clearSort(); moveTo(id, target);
      };
      handle.onpointercancel = handle.onlostpointercapture = clearSort;
    });
  }
  function render() {
    clearSort();
    const status = h.$('#attachmentSortStatus');
    status.hidden = items.length < 2;
    status.textContent = busy() ? '文件上传完成后可调整顺序。' : '按住“拖动”调整顺序，也可点击前移、后移；保存后按此顺序展示。';
    // Reuse loaded image elements across progress/status changes, rather than refetching originals.
    const previous = new Map(h.$$('[data-upload-preview]').map(node => [node.dataset.uploadPreview, node]));
    const labels = { queued: '等待上传', preparing: '准备上传', uploading: '上传中', confirming: '正在确认入库', ready: '已完整入库', failed: '上传失败', unknown: '等待读取附件信息', pending: '请重新选择文件', receiving: '上次上传未完成' };
    h.$('#attachmentList').innerHTML = items.map((item, index) => `<div class="media-upload-row" data-upload-row="${item.id}"><button type="button" class="media-sort-handle" data-upload-drag="${item.id}" ${items.length < 2 || busy() || locked ? 'disabled' : ''} aria-label="按住拖动排序：${h.esc(item.name)}"><span aria-hidden="true">&#x283f;</span><small>&#25302;&#21160;</small></button>${thumbnailHTML(item, previous)}<div class="media-upload-content"><small class="media-upload-order">${index + 1} / ${items.length}</small><b>${h.esc(item.name)}</b><small data-upload-status="${item.id}">${sizeLabel(item.size ?? item.expected_size ?? item.file?.size ?? 0)} · ${labels[item.status] || '等待上传'}${item.status === 'uploading' ? ' ' + (item.progress || 0) + '%' : ''}</small>${['uploading', 'preparing', 'confirming', 'queued'].includes(item.status) ? `<progress data-upload-progress="${item.id}" max="100" value="${item.progress || 0}" aria-label="${h.esc(item.name)}上传进度"></progress>` : ''}${item.error ? `<p class="form-error">${h.esc(item.error)}</p>` : ''}</div><div class="media-upload-actions">${item.status === 'ready' ? `<a class="text-button" href="${h.esc(item.download_url)}" download>下载</a>` : ['failed', 'pending', 'receiving', 'unknown'].includes(item.status) ? `<button type="button" class="text-button" data-upload-retry="${item.id}">${item.status === 'unknown' ? '重新读取' : item.file ? '重试' : '重新选文件'}</button>` : ''}${item.status === 'ready' && item.kind === 'image' ? `<button type="button" class="text-button" data-upload-ocr="${item.id}">提取文字</button>` : ''}<button type="button" class="text-button" data-upload-before="${item.id}" ${index === 0 || busy() || locked ? 'disabled' : ''} aria-label="前移${h.esc(item.name)}">前移</button><button type="button" class="text-button" data-upload-after="${item.id}" ${index === items.length - 1 || busy() || locked ? 'disabled' : ''} aria-label="后移：${h.esc(item.name)}">&#21518;&#31227;</button><button type="button" class="text-button" data-upload-remove="${item.id}" ${item.removing ? 'disabled' : ''}>${['uploading', 'preparing', 'confirming', 'queued'].includes(item.status) ? '取消并移除' : '移除'}</button></div></div>`).join('');
    h.$$('[data-upload-preview-slot]').forEach(slot => slot.replaceWith(previous.get(slot.dataset.uploadPreviewSlot)));
    h.$$('[data-upload-remove]').forEach(button => { button.onclick = h.action(() => remove(button.dataset.uploadRemove)); });
    h.$$('[data-upload-before]').forEach(button => { button.onclick = () => moveTo(button.dataset.uploadBefore, items.findIndex(i => i.id === button.dataset.uploadBefore) - 1); });
    h.$$('[data-upload-after]').forEach(button => { button.onclick = () => moveTo(button.dataset.uploadAfter, items.findIndex(i => i.id === button.dataset.uploadAfter) + 1); });
    bindSorting();
    h.$$('[data-upload-retry]').forEach(button => { button.onclick = h.action(() => retry(button.dataset.uploadRetry)); });
    h.$$('[data-upload-ocr]').forEach(button => { button.onclick = h.action(() => h.ocr(button.dataset.uploadOcr)); });
    h.$$('[data-upload-preview]').forEach(button => { button.onclick = () => openPreview(button.dataset.uploadPreview); });
    h.$$('[data-upload-thumbnail]').forEach(img => { img.onerror = () => {
      img.hidden = true;
      const note = img.closest('.media-upload-thumb')?.querySelector('.media-thumb-fallback');
      if (note) note.hidden = false;
    }; });
    refreshPreview();
  }
  async function retry(id) {
      if (locked) return;
      const item = items.find(i => i.id === id);
      if (!item) return;
      if (item.status === 'unknown') {
        const result = await h.api('/media/' + item.id);
        Object.assign(item, result); changed(); return;
      }
      if (item.file) { item.status = 'queued'; item.error = ''; render(); pump(); }
      else { reselectId = item.id; h.$('#mediaReselect').value = ''; h.$('#mediaReselect').click(); }
  }
  async function open(context) {
    const version = ++generation;
    items.forEach(releasePreview);
    h.$('#mediaPreviewDialog').close(); previewId = null;
    draftId = context.draftId; editingId = context.editingId;
    items = (context.attachments || []).filter(a => !a.discarded).map(a => ({ ...a, source: editingId ? 'entry' : 'upload', registered: true }));
    const ids = context.attachmentIds || [];
    for (const id of ids) if (!items.some(item => item.id === id)) {
      items.push({ id, name: '附件（等待读取）', status: 'unknown', source: editingId ? 'entry' : 'upload', registered: true });
    }
    render();
    const current = items;
    await Promise.allSettled(current.filter(i => i.status === 'unknown').map(async item => {
      const result = await h.api('/media/' + item.id);
      if (version === generation) Object.assign(item, result);
    }));
    try {
      const result = await h.api('/media/drafts/' + context.draftId);
      if (version !== generation) return;
      for (const item of result.items) {
        const existing = items.find(i => i.id === item.id);
        if (existing) Object.assign(existing, item, { source: 'upload', registered: true });
        else items.push({ ...item, source: 'upload', registered: true });
      }
    } catch { /* New and offline drafts may not exist on the service yet. */ }
    if (version === generation) { items = items.filter(i => !i.discarded); render(); }
  }
  function sendFile(item) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); item.xhr = xhr;
      xhr.open('PUT', `/api/media/${item.id}/content`);
      xhr.responseType = 'json'; xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = event => {
        item.progress = Math.min(99, Math.floor(event.loaded / Math.max(1, event.total || item.file.size) * 100));
        const status = h.$(`[data-upload-status="${item.id}"]`), progress = h.$(`[data-upload-progress="${item.id}"]`);
        if (status) status.textContent = `${sizeLabel(item.file.size)} · 上传中 ${item.progress}%`;
        if (progress) progress.value = item.progress;
      };
      xhr.upload.onload = () => { item.status = 'confirming'; render(); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response?.status === 'ready') resolve(xhr.response);
        else reject(new Error(typeof xhr.response?.detail === 'string' ? xhr.response.detail : '文件尚未确认入库，请重试'));
      };
      xhr.onerror = () => reject(new Error('网络中断，已成功上传的其他文件会保留'));
      xhr.onabort = () => reject(new Error('已取消上传'));
      xhr.ontimeout = () => reject(new Error('上传超时，请重试这个文件'));
      item.status = 'uploading'; xhr.send(item.file);
    });
  }
  async function upload(item) {
    const selectedDraft = draftId;
    await h.ensureDraft();
    if (item.cancelled) return;
    const result = await h.api('/media', { method: 'POST', body: JSON.stringify({ id: item.id, draft_id: selectedDraft,
      name: item.name, size: item.file.size, mime: item.file.type || 'application/octet-stream' }) });
    item.registered = true;
    if (item.cancelled) {
      await h.api(`/media/${item.id}/discard`, { method: 'POST', body: JSON.stringify({ draft_id: selectedDraft }) }); return;
    }
    const ready = result.status === 'ready' ? result : await sendFile(item);
    if (!item.cancelled) { releasePreview(item); Object.assign(item, ready, { source: 'upload', registered: true, progress: 100, file: null, error: '' }); changed(); }
  }
  function pump() {
    while (workers < 2) {
      const item = items.find(i => i.status === 'queued');
      if (!item) return;
      workers++; item.status = 'preparing'; render();
      upload(item).catch(error => {
        if (!item.cancelled) { item.status = 'failed'; item.error = error.message || '上传失败，请重试'; }
      }).finally(() => { workers--; if (!item.cancelled) changed(); pump(); });
    }
  }
  function addFiles(files) {
    if (locked) { h.toast('正在发布，请等保存完成后再添加文件'); return; }
    for (const file of files) {
      if (file.size > maximum) { h.toast(`“${file.name}”超过单文件 ${sizeLabel(maximum)} 上限`); continue; }
      let item = items.find(i => ['failed', 'pending', 'receiving'].includes(i.status) && !i.file && i.name === file.name && i.expected_size === file.size);
      if (!item) {
        if (items.length >= 50) { h.toast('每条记录最多添加 50 个附件'); break; }
        item = { id: h.uid(), name: file.name, expected_size: file.size, source: 'upload', registered: false }; items.push(item);
      }
      preparePreview(item, file);
      Object.assign(item, { file, status: 'queued', progress: 0, error: '', cancelled: false });
    }
    changed(); pump();
  }
  async function remove(id) {
    if (locked) return;
    const item = items.find(i => i.id === id);
    if (!item) return;
    item.removing = true; item.cancelled = true; item.xhr?.abort(); render();
    try {
      if (item.source === 'upload' && item.registered) {
        await h.api(`/media/${id}/discard`, { method: 'POST', body: JSON.stringify({ draft_id: draftId }) });
      }
      releasePreview(item); items = items.filter(i => i !== item); changed();
    } catch (error) {
      item.cancelled = false; item.error = error.message; item.removing = false;
      if (item.status !== 'ready') item.status = 'failed'; render(); throw error;
    }
  }
  function reset() { if (!busy()) { generation++; items.forEach(releasePreview); items = []; draftId = null; editingId = null; previewId = null; h.$('#mediaPreviewDialog').close(); render(); } }
  function attachmentHTML(item) {
    const url = h.esc(item.kind === 'image' ? imageURL(item) : item.url), name = h.esc(item.name);
    const preview = item.kind === 'image' ? `<img src="${url}" alt="${name}" loading="lazy" data-original-preview>` :
      item.kind === 'video' ? `<video controls playsinline preload="metadata" src="${url}" data-original-preview></video>` :
      item.kind === 'audio' ? `<audio controls preload="metadata" src="${url}" data-original-preview></audio>` : `<span class="document-symbol">${h.icon('book')} 文档</span>`;
    return `<figure class="original-attachment">${preview}<figcaption><b>${name}</b><span>${kindName(item.kind)} · ${sizeLabel(item.size || 0)}</span><a class="text-button" href="${h.esc(item.download_url)}" download>下载原件</a></figcaption><p class="media-feedback muted">${item.kind === 'document' ? '文档保留原格式，下载后使用对应软件打开。' : '浏览器不支持此格式时，可下载原件查看。'}</p></figure>`;
  }
  function bindPreviews(root) {
    root.querySelectorAll('[data-original-preview]').forEach(element => element.addEventListener('error', () => {
      if (element.tagName === 'IMG') element.hidden = true;
      const note = element.closest('.original-attachment')?.querySelector('.media-feedback');
      if (note) note.textContent = '此浏览器暂不能预览该格式，原件已保留，可下载后打开。';
    }));
  }
  function init(helpers) {
    h = helpers;
    h.$('#mediaPreviewImage').onerror = () => { h.$('#mediaPreviewImage').hidden = true; h.$('#mediaPreviewError').hidden = false; };
    h.$('#mediaPreviewDialog').addEventListener('close', () => {
      previewId = null; h.$('#mediaPreviewImage').removeAttribute('src');
    });
    h.$('#mediaDropZone').addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!locked) h.$('#mediaInput').click();
      }
    });
    h.$('#mediaInput').onchange = event => { addFiles([...event.target.files]); event.target.value = ''; };
    h.$('#mediaReselect').onchange = event => {
      const item = items.find(i => i.id === reselectId), file = event.target.files[0];
      if (!item || !file) return;
      if (file.name !== item.name || file.size !== item.expected_size) { h.toast('请选择同名且大小一致的原文件；其他文件可另行添加'); return; }
      preparePreview(item, file);
      Object.assign(item, { file, status: 'queued', error: '', cancelled: false }); render(); pump();
    };
    for (const type of ['dragover', 'dragenter']) h.$('#mediaDropZone').addEventListener(type, event => { event.preventDefault(); h.$('#mediaDropZone').classList.add('dragging'); });
    h.$('#mediaDropZone').addEventListener('dragleave', () => h.$('#mediaDropZone').classList.remove('dragging'));
    h.$('#mediaDropZone').addEventListener('drop', event => { event.preventDefault(); h.$('#mediaDropZone').classList.remove('dragging'); addFiles([...event.dataTransfer.files]); });
    h.api('/media/config').then(config => { if (config.max_file_size) maximum = config.max_file_size; }).catch(() => {});
  }
  return { init, open, reset, hasItems, busy, readyIds, canPublish, addFiles, retry, remove, openPreview, sizeLabel, imageURL, moveTo, attachmentHTML, bindPreviews,
    setLocked(value) { locked = value; } };
})();
