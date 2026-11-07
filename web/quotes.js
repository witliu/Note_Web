/* Quotes share persisted entries, drafts and original attachments with the journal. */
globalThis.QuoteFeature = (() => {
  let h, page = 1, request = 0, searchTimer, ocrRequest = 0, working = false;
  function cards(items) {
    return items.map(item => {
      const image = (item.attachments || []).find(a => a.kind === 'image');
      return `<article class="quote-card"><button class="quote-open" data-entry="${item.id}" aria-label="查看语录：${h.esc(item.title || item.body.slice(0, 40))}"><span class="quote-mark" aria-hidden="true">“</span>${item.title ? `<h3>${h.esc(item.title)}</h3>` : ''}<blockquote>${h.esc(item.body.slice(0, 500))}${item.body.length > 500 ? '…' : ''}</blockquote>${item.quote_source ? `<p class="quote-source">—— ${h.esc(item.quote_source)}</p>` : ''}${item.quote_note ? `<p class="quote-note">${h.esc(item.quote_note.slice(0, 160))}</p>` : ''}${image ? `<img src="${h.esc(MediaFeature.imageURL(image))}" alt="${h.esc(image.name)}" loading="lazy">` : ''}<small>${h.esc(item.date)} · 点击查看或编辑</small></button></article>`;
    }).join('');
  }
  async function load() {
    const version = ++request;
    try {
      const params = new URLSearchParams({ kind: 'quote', page, q: h.$('#quoteSearch').value.trim() });
      const result = await h.api('/entries?' + params);
      if (version !== request) return;
      if (!result.items.length && page > 1) { page = Math.max(1, Math.ceil(result.total / result.page_size)); return load(); }
      h.$('#quoteCount').textContent = result.total;
      h.$('#quoteList').innerHTML = result.items.length ? cards(result.items) : h.empty('把心动的一句话留下', '写一段随手记，或上传图片提取文字，校对后收藏。');
      h.bindEntries(h.$('#quoteList'));
      h.pager(h.$('#quotePager'), result, async next => { page = next; await load(); });
    } catch (error) {
      if (version !== request) return;
      h.$('#quoteList').innerHTML = h.empty('语录暂时无法读取', error.message || '请检查主机连接后重试。');
      h.$('#quotePager').replaceChildren();
    }
  }
  async function extract(id) {
    if (working) { h.toast('图片正在识别，请稍候'); return; }
    const owner = h.getDraftId();
    if (!owner || h.isPublishing()) return;
    const version = ++ocrRequest;
    working = true;
    h.$('#ocrText').value = '';
    h.$('#ocrText').disabled = true;
    h.$('#ocrStatus').textContent = '正在主机本地提取文字，原图不会改变…';
    h.$('#ocrAppend').disabled = true; h.$('#ocrReplace').disabled = true;
    h.$('#ocrDialog').showModal();
    try {
      const result = await h.api(`/media/${id}/ocr`, { method: 'POST', body: '{}' });
      if (version !== ocrRequest || owner !== h.getDraftId() || !h.$('#ocrDialog').open) return;
      h.$('#ocrText').value = result.text;
      h.$('#ocrStatus').textContent = result.text ? '识别完成。请检查错字和换行，确认后加入正文。' : '没有识别到文字。可尝试更清晰的图片，或手动填写。';
      h.$('#ocrAppend').disabled = !result.text.trim(); h.$('#ocrReplace').disabled = !result.text.trim();
    } catch (error) {
      if (version === ocrRequest && owner === h.getDraftId()) h.$('#ocrStatus').textContent = error.message;
    } finally {
      working = false;
      if (version === ocrRequest) h.$('#ocrText').disabled = false;
    }
  }
  function apply(mode) {
    const text = h.$('#ocrText').value.trim();
    if (!text || working) return;
    if (!h.applyText(text, mode)) return;
    h.$('#ocrDialog').close();
  }
  function init(helpers) {
    h = helpers;
    h.$('#quoteSearch').oninput = () => {
      clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; load(); }, 250);
    };
    h.$('#ocrAppend').onclick = () => apply('append');
    h.$('#ocrReplace').onclick = () => apply('replace');
    h.$('#ocrText').oninput = () => {
      const disabled = working || !h.$('#ocrText').value.trim();
      h.$('#ocrAppend').disabled = disabled; h.$('#ocrReplace').disabled = disabled;
    };
    h.$('#ocrDialog').addEventListener('close', () => { ocrRequest++; });
  }
  return { init, load, extract, cards, resetPage() { page = 1; } };
})();
