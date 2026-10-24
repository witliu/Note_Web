/* Account-backed mutual choice questions. Permissions and marking live on the server. */
globalThis.QuizFeature = (() => {
  let h, currentUser = null, authState = null, tab = 'pending', page = 1, requestVersion = 0, authRequestVersion = 0;
  let authBusy = false, questionBusy = false, answerBusy = false, loginIntent = null;
  let questionId = null, options = [], correctIds = new Set(), answerSubmissionId = null;

  function error(id, message = '') { h.$(id).textContent = message; h.$(id).hidden = !message; }
  function controls(dialog, busy) {
    h.$$(`#${dialog} input,#${dialog} textarea,#${dialog} select,#${dialog} button`).forEach(c => { c.disabled = busy; });
  }
  function updateAccount() {
    h.$('#accountAccess').textContent = currentUser ? currentUser.display_name : '账号登录';
    h.$('#accountAccess').setAttribute('title', currentUser ? `当前账号：${currentUser.display_name}` : '登录自己的账号');
  }
  async function refreshAccount() {
    const version = ++authRequestVersion;
    const state = await h.api('/auth/status');
    if (version === authRequestVersion) { authState = state; currentUser = state.user || null; updateAccount(); }
    return authState || state;
  }
  async function openAccount() {
    const state = await refreshAccount();
    error('#authError');
    h.$('#authSetupForm').hidden = state.configured || !state.can_setup;
    h.$('#authSetupNotice').hidden = state.configured || state.can_setup;
    h.$('#authLoginForm').hidden = !state.configured || !!state.user;
    h.$('#authSignedIn').hidden = !state.user;
    h.$('#authCurrentName').textContent = state.user ? `当前登录：${state.user.display_name}` : '';
    h.$('#authTitle').textContent = state.user ? '我们的账号' : state.configured ? '登录自己的账号' : '设置两人账号';
    if (!h.$('#authDialog').open) h.$('#authDialog').showModal();
    if (state.configured && !state.user) h.$('#loginUsername').focus();
  }
  function accountCard() {
    const root = h.$('#quizAccountCard');
    if (currentUser) {
      root.innerHTML = `<span>当前是 <b>${h.esc(currentUser.display_name)}</b>，题目会交给 <b>${h.esc(currentUser.partner?.display_name || '对方')}</b>。</span><button class="text-button" id="quizAccountButton">管理账号</button>`;
    } else {
      root.innerHTML = `<span>${authState?.configured ? '先登录自己的账号，再给对方出题或回答。' : authState?.can_setup ? '首次使用，请先设置你们两个人的账号。' : '请先在服务主机打开 127.0.0.1:8000 设置两人账号。'}</span><button class="button secondary" id="quizAccountButton">${authState?.configured ? '登录账号' : '设置账号'}</button>`;
    }
    h.$('#quizAccountButton').onclick = h.action(openAccount);
  }
  function cards(items) {
    return items.map(item => `<article class="quiz-card"><span class="anniversary-badge">${item.kind === 'multiple' ? '多选题' : '单选题'}</span><h3>${h.esc(item.body.length > 160 ? item.body.slice(0, 160) + '…' : item.body)}</h3><p class="muted">${h.esc(item.author_name)} 出题给 ${h.esc(item.recipient_name)}</p><p class="quiz-state">${item.answer_id ? item.correct ? '已经答对，默契＋1' : '已留下这次回答' : '等待对方回答'}</p><button class="button secondary" data-open-quiz="${item.id}">${item.answer_id ? '查看答题记录' : tab === 'pending' ? '来回答' : '查看题目'}</button></article>`).join('');
  }
  async function load() {
    const version = ++requestVersion;
    try {
      await refreshAccount();
      if (version !== requestVersion) return;
      accountCard();
      if (!currentUser) {
        h.$('#quizList').innerHTML = h.empty('你来出题，我来猜', '登录后，题目和答题记录会留在你们自己的账号下。');
        h.$('#quizPager').replaceChildren();
        for (const id of ['quizPendingCount', 'quizCreatedCount', 'quizHistoryCount']) h.$('#' + id).textContent = '';
        return;
      }
      const result = await h.api(`/quizzes?tab=${tab}&page=${page}`);
      if (version !== requestVersion) return;
      if (!result.items.length && page > 1) { page = Math.max(1, Math.ceil(result.total / result.page_size)); return load(); }
      h.$('#quizPendingCount').textContent = result.summary.pending;
      h.$('#quizCreatedCount').textContent = result.summary.created;
      h.$('#quizHistoryCount').textContent = result.summary.history;
      h.$('#quizList').innerHTML = result.items.length ? cards(result.items) : h.empty(
        tab === 'pending' ? '暂时没有等你回答的题' : tab === 'created' ? '第一道小考题，等你来写' : '每一次回答，都值得留下',
        tab === 'history' ? '对方提交后，双方都可以在这里回看原题和答题结果。' : '给对方出一道选择题，看看你们有多默契。');
      h.$$('[data-open-quiz]').forEach(button => { button.onclick = h.action(() => openQuestion(button.dataset.openQuiz)); });
      h.pager(h.$('#quizPager'), result, async next => { page = next; await load(); });
    } catch (failure) {
      if (version !== requestVersion) return;
      if (failure.status === 401) { currentUser = null; updateAccount(); accountCard(); }
      h.$('#quizList').innerHTML = h.empty('暂时无法读取题目', failure.message || '请检查服务连接后重试。');
      h.$('#quizPager').replaceChildren();
    }
  }
  function renderOptions() {
    const multiple = h.$('#questionKind').value === 'multiple';
    h.$('#questionOptions').innerHTML = options.map((option, index) => `<div class="question-option-row"><label class="question-answer-pick"><input type="${multiple ? 'checkbox' : 'radio'}" name="questionCorrect" data-question-correct="${option.id}" ${correctIds.has(option.id) ? 'checked' : ''} aria-label="选项 ${String.fromCharCode(65 + index)} 为正确答案"><span>${String.fromCharCode(65 + index)}</span></label><input data-question-text="${option.id}" required maxlength="300" value="${h.esc(option.text)}" aria-label="选项 ${String.fromCharCode(65 + index)} 内容" placeholder="填写选项内容"><button type="button" class="icon-button" data-question-remove="${option.id}" ${options.length <= 2 ? 'disabled' : ''} aria-label="移除选项 ${String.fromCharCode(65 + index)}">×</button></div>`).join('');
    h.$('#addQuestionOption').disabled = options.length >= 6;
    h.$$('[data-question-text]').forEach(input => { input.oninput = () => { options.find(o => o.id === input.dataset.questionText).text = input.value; }; });
    h.$$('[data-question-correct]').forEach(input => { input.onchange = () => {
      if (!multiple) correctIds = new Set([input.dataset.questionCorrect]);
      else if (input.checked) correctIds.add(input.dataset.questionCorrect); else correctIds.delete(input.dataset.questionCorrect);
    }; });
    h.$$('[data-question-remove]').forEach(button => { button.onclick = () => {
      if (options.length <= 2) return;
      options = options.filter(o => o.id !== button.dataset.questionRemove); correctIds.delete(button.dataset.questionRemove); renderOptions();
    }; });
  }
  async function newQuestion() {
    await refreshAccount();
    if (!currentUser) { loginIntent = 'create'; await openAccount(); return; }
    questionId = h.uid(); options = [{ id: h.uid(), text: '' }, { id: h.uid(), text: '' }]; correctIds = new Set();
    h.$('#questionForm').reset(); h.$('#questionKind').value = 'single';
    error('#questionError'); renderOptions();
    h.$('#questionEditorTitle').textContent = `给${currentUser.partner?.display_name || '对方'}出道题`;
    h.$('#questionDialog').showModal(); h.$('#questionBody').focus();
  }
  function detailHTML(item) {
    const chosen = new Set(item.answer?.selected_option_ids || []);
    const correct = new Set(item.correct_option_ids || []);
    const knowsAnswer = Array.isArray(item.correct_option_ids);
    const letters = item.options.filter(o => correct.has(o.id)).map(o => String.fromCharCode(65 + item.options.indexOf(o))).join('、');
    return `<span class="anniversary-badge">${item.kind === 'multiple' ? '多选题 · 全部选对才算正确' : '单选题'}</span><h2 id="quizDetailTitle">${h.esc(item.body)}</h2><p class="muted">${h.esc(item.author_name)} 出题给 ${h.esc(item.recipient_name)}</p><form id="quizAnswerForm"><div class="quiz-answer-options">${item.options.map((option, index) => `<label class="quiz-answer-option ${knowsAnswer && correct.has(option.id) ? 'is-correct' : ''}"><input type="${item.kind === 'multiple' ? 'checkbox' : 'radio'}" name="quizSelection" value="${option.id}" ${item.can_answer ? '' : 'disabled'} ${chosen.has(option.id) ? 'checked' : ''}><span><b>${String.fromCharCode(65 + index)}.</b> ${h.esc(option.text)}</span>${knowsAnswer && correct.has(option.id) ? '<small>正确选项</small>' : ''}</label>`).join('')}</div>${item.answer ? `<div class="quiz-result ${item.answer.correct ? 'is-correct' : ''}"><h3>${item.answer.correct ? '答对了，又懂对方一点。' : '这次的回答，也认真留下了。'}</h3><p>${h.esc(item.recipient_name)} 提交于 ${h.esc(new Date(item.answer.submitted_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</p></div>` : item.can_answer ? '<p class="muted">提交后保留这次正式回答，不可修改。</p>' : '<p class="muted">这是你出的题，等待对方来回答。</p>'}${knowsAnswer ? `<p class="quiz-correct-answer">正确答案：${h.esc(letters)}</p>${item.explanation ? `<div class="quiz-explanation"><b>出题人的话</b><p>${h.esc(item.explanation)}</p></div>` : ''}` : ''}<p id="quizAnswerError" class="form-error" role="alert" hidden></p><button class="text-button" type="button" id="quizAnswerLogin" hidden>登录后继续</button>${item.can_answer ? '<div class="dialog-footer"><button type="submit" class="button primary">提交我的回答</button></div>' : ''}</form>`;
  }
  function showQuestion(item) {
    h.$('#quizDetailContent').innerHTML = detailHTML(item);
    h.$('#quizAnswerLogin').onclick = h.action(openAccount);
    const form = h.$('#quizAnswerForm');
    form.onsubmit = async event => {
      event.preventDefault(); if (answerBusy || !item.can_answer) return;
      const selected = h.$$('#quizAnswerForm input[name=quizSelection]:checked').map(input => input.value);
      if (!selected.length) { error('#quizAnswerError', '先选择你的答案吧'); return; }
      answerBusy = true; controls('quizAnswerDialog', true);
      try {
        const result = await h.api(`/quizzes/${item.id}/answers`, { method: 'POST', body: JSON.stringify({ id: answerSubmissionId, selected_option_ids: selected }) });
        showQuestion(result); if (h.getView() === 'quizzes') await load();
      } catch (failure) {
        error('#quizAnswerError', failure.message);
        h.$('#quizAnswerLogin').hidden = failure.status !== 401;
      } finally { answerBusy = false; controls('quizAnswerDialog', false);
        // A rendered result keeps choices disabled after a successful submission.
        if (!h.$('#quizDetailContent').querySelector('button[type=submit]')) h.$$('#quizAnswerForm input').forEach(c => { c.disabled = true; });
      }
    };
  }
  async function openQuestion(id) {
    const item = await h.api('/quizzes/' + id);
    answerSubmissionId = h.uid(); showQuestion(item);
    if (!h.$('#quizAnswerDialog').open) h.$('#quizAnswerDialog').showModal();
  }
  function init(helpers) {
    h = helpers;
    h.$('#accountAccess').onclick = h.action(openAccount);
    h.$('#newQuestion').onclick = h.action(newQuestion);
    h.$$('[data-quiz-tab]').forEach(button => { button.onclick = h.action(async () => {
      tab = button.dataset.quizTab; page = 1;
      h.$$('[data-quiz-tab]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
      await load();
    }); });
    h.$('#authDialog').addEventListener('cancel', event => { if (authBusy) event.preventDefault(); });
    h.$('#authDialog').addEventListener('close', () => {
      for (const id of ['loginPassword', 'setupPassword1', 'setupPassword2']) h.$('#' + id).value = '';
    });
    h.$('#authSetupForm').onsubmit = async event => {
      event.preventDefault(); if (authBusy) return; authBusy = true; controls('authDialog', true); error('#authError');
      const accounts = [1, 2].map(i => ({ username: h.$('#setupUsername' + i).value,
        display_name: h.$('#setupName' + i).value, password: h.$('#setupPassword' + i).value }));
      try {
        await h.api('/auth/setup', { method: 'POST', body: JSON.stringify({ accounts }) });
        h.$('#authSetupForm').reset(); h.$('#authSetupForm').hidden = true; h.$('#authLoginForm').hidden = false;
        h.$('#authTitle').textContent = '账号已设置，请登录'; h.$('#loginUsername').value = accounts[0].username;
      } catch (failure) { error('#authError', failure.message); }
      finally { authBusy = false; controls('authDialog', false); }
    };
    h.$('#authLoginForm').onsubmit = async event => {
      event.preventDefault(); if (authBusy) return; authBusy = true; controls('authDialog', true); error('#authError');
      try {
        const result = await h.api('/auth/login', { method: 'POST', body: JSON.stringify({ username: h.$('#loginUsername').value, password: h.$('#loginPassword').value }) });
        authRequestVersion++; currentUser = result.user; authState = { ...(authState || {}), configured: true, user: currentUser };
        updateAccount(); h.$('#authDialog').close();
        if (h.getView() === 'quizzes') await load();
        h.onLogin();
        if (loginIntent === 'create') { loginIntent = null; await newQuestion(); }
      } catch (failure) { error('#authError', failure.message); }
      finally { authBusy = false; controls('authDialog', false); }
    };
    h.$('#logoutAccount').onclick = h.action(async () => {
      await h.api('/auth/logout', { method: 'POST', body: '{}' });
      authRequestVersion++; currentUser = null; authState = { ...(authState || {}), configured: true, user: null };
      options = []; correctIds.clear(); questionId = null; loginIntent = null; updateAccount();
      h.$('#questionForm').reset(); h.$('#quizDetailContent').replaceChildren(); h.$('#quizList').replaceChildren();
      h.$('#authDialog').close();
      if (h.getView() === 'quizzes') await load();
    });
    h.$('#addQuestionOption').onclick = () => { if (options.length < 6) { options.push({ id: h.uid(), text: '' }); renderOptions(); } };
    h.$('#questionKind').onchange = () => { if (h.$('#questionKind').value === 'single' && correctIds.size > 1) correctIds = new Set([[...correctIds][0]]); renderOptions(); };
    h.$('#questionDialog').addEventListener('cancel', event => { if (questionBusy) event.preventDefault(); });
    h.$('#quizAnswerDialog').addEventListener('cancel', event => { if (answerBusy) event.preventDefault(); });
    h.$('#questionForm').onsubmit = async event => {
      event.preventDefault(); if (questionBusy) return;
      if (!correctIds.size) { error('#questionError', '请先勾选正确答案'); return; }
      questionBusy = true; controls('questionDialog', true);
      try {
        await h.api('/quizzes', { method: 'POST', body: JSON.stringify({ id: questionId, kind: h.$('#questionKind').value,
          body: h.$('#questionBody').value, options, correct_option_ids: [...correctIds], explanation: h.$('#questionExplanation').value }) });
        h.$('#questionDialog').close(); tab = 'created'; page = 1;
        h.$$('[data-quiz-tab]').forEach(b => { const active = b.dataset.quizTab === tab; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
        await load(); h.toast('题目已交给对方，等一个默契的回答');
      } catch (failure) { error('#questionError', failure.message); }
      finally { questionBusy = false; controls('questionDialog', false); renderOptions(); }
    };
    refreshAccount().catch(() => {});
  }
  return { init, load, openAccount, detailHTML, cards };
})();
