(function () {
  const { $, el, fmtTime, toast, REASONS } = window.Q;

  const STATE_LABEL = { countdown: 'Başlıyor', question: 'Soru açık', reveal: 'Cevap gösteriliyor', ended: 'Bitti' };
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');

  const socket = io();
  let quizzes = [];
  let results = [];
  let live = { lobbies: [], sessions: [] };
  let loggedIn = false;
  let editingId = null;
  const openResults = new Set();

  // ------------------------------------------------------------------ giriş

  function login(password, silent) {
    socket.emit('teacher:login', { password }, (res) => {
      if (!res || !res.ok) {
        sessionStorage.removeItem('teacherPw');
        if (!silent) $('#login-error').textContent = (res && res.error) || 'Giriş başarısız.';
        showLogin();
        return;
      }
      sessionStorage.setItem('teacherPw', password);
      loggedIn = true;
      quizzes = res.quizzes;
      results = res.results;
      $('#s-login').classList.add('hidden');
      $('#main').classList.remove('hidden');
      $('#logout').classList.remove('hidden');
      renderQuizzes();
      renderResults();
    });
  }

  function showLogin() {
    loggedIn = false;
    $('#main').classList.add('hidden');
    $('#logout').classList.add('hidden');
    $('#s-login').classList.remove('hidden');
    $('#password').focus();
  }

  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    login($('#password').value, false);
  });

  $('#logout').addEventListener('click', () => {
    sessionStorage.removeItem('teacherPw');
    location.reload();
  });

  socket.on('connect', () => {
    $('#conn').textContent = 'Bağlı';
    const pw = sessionStorage.getItem('teacherPw');
    if (pw) login(pw, true);
    else showLogin();
  });
  socket.on('disconnect', () => { $('#conn').textContent = 'Bağlantı koptu…'; });

  function call(event, payload) {
    return new Promise((resolve) => {
      socket.emit(event, payload, (res) => {
        if (!res || !res.ok) toast((res && res.error) || 'İşlem başarısız.');
        resolve(res || { ok: false });
      });
    });
  }

  // ------------------------------------------------------------------ sekmeler

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    for (const name of ['live', 'quizzes', 'results']) {
      $('#tab-' + name).classList.toggle('hidden', name !== t.dataset.tab);
    }
  }));

  // ------------------------------------------------------------------ canlı

  socket.on('teacher:state', (state) => {
    const now = Date.now();
    for (const s of state.sessions) {
      s.localEnd = now + s.remaining;
      s.localOverallEnd = s.overallRemaining != null ? now + s.overallRemaining : null;
    }
    live = state;
    renderLive();
    renderQuizzes();
  });

  socket.on('teacher:quizzes', (list) => { quizzes = list; renderQuizzes(); renderLive(); });

  socket.on('teacher:error', (msg) => toast(msg));

  socket.on('teacher:ended', (record) => {
    results = [record, ...results.filter((r) => r.id !== record.id)];
    renderResults();
    toast(`"${record.title}" bitti. ${REASONS[record.reason] || ''}`);
  });

  const activeByDers = () => new Map(live.sessions.map((s) => [norm(s.ders), s]));

  function startQuiz(quiz) {
    const students = (live.lobbies.find((l) => l.dersKey === norm(quiz.ders)) || { students: [] }).students.length;
    const msg = students
      ? `"${quiz.title}" quizini ${quiz.ders} dersindeki ${students} öğrenci için başlat?`
      : `${quiz.ders} dersinde şu an bağlı öğrenci yok. Yine de "${quiz.title}" başlatılsın mı? (Sonradan bağlananlar katılabilir.)`;
    if (!confirm(msg)) return;
    call('teacher:start', { quizId: quiz.id }).then((res) => {
      if (res.ok) document.querySelector('.tab[data-tab="live"]').click();
    });
  }

  function renderLive() {
    if (!loggedIn) return;
    const box = $('#sessions');
    box.replaceChildren();
    for (const s of live.sessions) box.append(renderSession(s));

    const lob = $('#lobbies');
    lob.replaceChildren();
    if (!live.lobbies.length) {
      lob.append(el('p', { class: 'muted' }, 'Şu an bağlı öğrenci yok. Öğrenciler bağlantıyla geldiğinde burada görünür.'));
    }
    const active = activeByDers();
    for (const l of live.lobbies) {
      const dersQuizzes = quizzes.filter((q) => norm(q.ders) === l.dersKey);
      const running = active.get(l.dersKey);
      lob.append(el('div', { style: 'border-top:1px solid #e5e5ea;padding:12px 0' },
        el('div', { class: 'row between' },
          el('h3', {}, `${l.ders} · ${l.students.length} öğrenci`),
          running
            ? el('span', { class: 'badge open' }, `Devam ediyor: ${running.title}`)
            : el('div', { class: 'row' },
              dersQuizzes.length
                ? dersQuizzes.map((q) => el('button', { class: 'btn small green', onclick: () => startQuiz(q) }, `▶ ${q.title}`))
                : el('span', { class: 'muted' }, 'Bu ders için quiz yok'))),
        el('div', { class: 'chips' }, l.students.map((n) => el('span', { class: 'chip' }, n)))));
    }
    tick();
  }

  function renderSession(s) {
    const q = s.question;
    const maxCount = Math.max(1, ...s.counts);
    const showCorrect = s.state === 'reveal';
    return el('div', { class: 'panel live' },
      el('div', { class: 'row between' },
        el('div', {},
          el('h2', { style: 'margin:0' }, s.title),
          el('div', { class: 'muted' }, `${s.ders} · ${STATE_LABEL[s.state] || s.state} · Soru ${Math.min(s.qIndex + 1, s.total)}/${s.total}`)),
        el('div', { class: 'row' },
          s.localOverallEnd ? el('span', { class: 'pill', style: 'background:#ede7f6;color:var(--bg)', 'data-overall': s.id }) : null,
          el('div', { class: 'timer', style: 'background:var(--bg);color:#fff', 'data-timer': s.id }, ''),
          el('button', { class: 'btn blue', onclick: () => call('teacher:next', { sessionId: s.id }) },
            s.state === 'question' ? 'Cevabı göster' : s.qIndex + 1 >= s.total && s.state === 'reveal' ? 'Sonuçlar' : 'Sonraki ▶'),
          el('button', {
            class: 'btn red',
            onclick: () => { if (confirm('Quizi şimdi bitirmek istiyor musunuz?')) call('teacher:end', { sessionId: s.id }); },
          }, 'Bitir ■'))),
      q ? el('div', { class: 'q-text', style: 'margin-top:12px' }, q.text) : el('p', { class: 'muted' }, 'Geri sayım…'),
      q ? el('div', { class: 'bars' }, q.options.map((opt, i) => el('div', { class: `bar c${i}` + (showCorrect && i === q.correct ? ' correct' : '') },
        el('span', {}, s.counts[i] || 0),
        el('div', { style: `height:${((s.counts[i] || 0) / maxCount) * 100}%` })))) : null,
      q ? el('div', { class: 'row', style: 'gap:8px' }, q.options.map((opt, i) => el('span', {
        class: 'chip',
        style: `background:var(--${['red', 'blue', 'yellow', 'green'][i]});color:#fff;${showCorrect && i !== q.correct ? 'opacity:.4' : ''}`,
      }, opt))) : null,
      el('p', {}, el('strong', {}, `${s.answered}/${s.players}`), ' öğrenci cevapladı'),
      el('h3', {}, 'Sıralama'),
      s.leaderboard.length
        ? el('ol', { class: 'leaderboard' }, s.leaderboard.slice(0, 10).map((p, i) => el('li', {},
          el('span', {}, el('span', { class: 'rank' }, `${i + 1}.`), p.name),
          el('span', {}, `${p.score} puan · ${p.correct} doğru`))))
        : el('p', { class: 'muted' }, 'Henüz katılımcı yok.'));
  }

  function tick() {
    const now = Date.now();
    for (const s of live.sessions) {
      const t = document.querySelector(`[data-timer="${s.id}"]`);
      if (t) t.textContent = s.state === 'question' || s.state === 'countdown' || s.state === 'reveal' ? fmtTime(s.localEnd - now) : '';
      const o = document.querySelector(`[data-overall="${s.id}"]`);
      if (o && s.localOverallEnd) o.textContent = 'Toplam ⏱ ' + fmtTime(s.localOverallEnd - now);
    }
  }
  setInterval(tick, 250);

  // ------------------------------------------------------------------ quizler

  function studentLink(ders) {
    return `${location.origin}/?isim=AD_SOYAD&ders=${encodeURIComponent(ders)}`;
  }

  function renderQuizzes() {
    if (!loggedIn) return;
    const active = activeByDers();
    const wrap = $('#quiz-table');
    wrap.replaceChildren();
    $('#ders-list').replaceChildren(...[...new Set(quizzes.map((q) => q.ders))].map((d) => el('option', { value: d })));
    if (!quizzes.length) { wrap.append(el('p', { class: 'muted' }, 'Henüz quiz yok.')); return; }
    const sorted = [...quizzes].sort((a, b) => a.ders.localeCompare(b.ders, 'tr') || a.title.localeCompare(b.title, 'tr'));
    wrap.append(el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Ders'), el('th', {}, 'Başlık'), el('th', {}, 'Soru'), el('th', {}, 'Öğrenci bağlantısı'), el('th', {}, ''))),
      el('tbody', {}, sorted.map((q) => {
        const running = active.get(norm(q.ders));
        const isThis = running && running.quizId === q.id;
        return el('tr', {},
          el('td', {}, q.ders),
          el('td', {}, el('strong', {}, q.title), q.durationMin ? el('div', { class: 'muted' }, `Süre sınırı: ${q.durationMin} dk`) : null),
          el('td', {}, q.questions.length),
          el('td', {}, el('div', { class: 'copy' }, studentLink(q.ders))),
          el('td', {}, el('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' },
            isThis
              ? el('span', { class: 'badge open' }, 'Canlı')
              : el('button', { class: 'btn small green', disabled: !!running, title: running ? 'Bu derste başka bir quiz devam ediyor' : '', onclick: () => startQuiz(q) }, '▶ Başlat'),
            el('button', { class: 'btn small ghost', onclick: () => openEditor(q) }, 'Düzenle'),
            el('button', { class: 'btn small ghost', onclick: () => openEditor({ ...q, id: null, title: q.title + ' (kopya)' }) }, 'Kopyala'),
            el('button', {
              class: 'btn small red',
              disabled: !!isThis,
              onclick: () => { if (confirm(`"${q.title}" silinsin mi?`)) call('teacher:deleteQuiz', { id: q.id }); },
            }, 'Sil'))));
      }))));
  }

  function questionEditor(q, index) {
    const opts = [0, 1, 2, 3].map((i) => el('label', { class: `opt c${i}` },
      el('input', { type: 'radio', name: `correct-${index}`, value: i, checked: q.correct === i, title: 'Doğru cevap' }),
      el('input', { type: 'text', class: 'opt-text', maxlength: 200, placeholder: i < 2 ? `Seçenek ${i + 1}` : `Seçenek ${i + 1} (isteğe bağlı)`, value: q.options[i] || '' })));
    const node = el('div', { class: 'q-editor' },
      el('div', { class: 'row between' },
        el('strong', { class: 'q-num' }, `Soru ${index + 1}`),
        el('div', { class: 'row' },
          el('label', {}, 'Süre (sn) ', el('input', { type: 'number', class: 'q-time', min: 5, max: 300, value: q.time || 20, style: 'width:80px;padding:6px' })),
          el('button', { type: 'button', class: 'btn small ghost', onclick: () => { node.remove(); renumber(); } }, 'Sil'))),
      el('div', { class: 'field', style: 'margin-top:8px' }, el('textarea', { class: 'q-text-input', rows: 2, maxlength: 500, placeholder: 'Soru metni' }, q.text || '')),
      el('div', { class: 'opts' }, opts),
      el('div', { class: 'muted', style: 'margin-top:6px;font-size:13px' }, 'Doğru cevabı soldaki daire ile işaretleyin.'));
    return node;
  }

  function renumber() {
    document.querySelectorAll('#questions .q-editor').forEach((n, i) => {
      n.querySelector('.q-num').textContent = `Soru ${i + 1}`;
      n.querySelectorAll('input[type=radio]').forEach((r) => (r.name = `correct-${i}`));
    });
  }

  function openEditor(quiz) {
    editingId = quiz ? quiz.id : null;
    const q = quiz || { title: '', ders: '', durationMin: 0, questions: [] };
    $('#editor-title').textContent = editingId ? 'Quizi düzenle' : 'Yeni quiz';
    $('#q-title').value = q.title;
    $('#q-ders').value = q.ders;
    $('#q-duration').value = q.durationMin || 0;
    $('#editor-error').textContent = '';
    const box = $('#questions');
    box.replaceChildren();
    const qs = q.questions.length ? q.questions : [{ text: '', options: ['', '', '', ''], correct: 0, time: 20 }];
    qs.forEach((item, i) => box.append(questionEditor(item, i)));
    $('#quiz-list-panel').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    $('#q-title').focus();
  }

  function closeEditor() {
    $('#editor').classList.add('hidden');
    $('#quiz-list-panel').classList.remove('hidden');
  }

  $('#new-quiz').addEventListener('click', () => openEditor(null));
  $('#cancel-edit').addEventListener('click', closeEditor);
  $('#add-question').addEventListener('click', () => {
    const box = $('#questions');
    const node = questionEditor({ text: '', options: ['', '', '', ''], correct: 0, time: 20 }, box.children.length);
    box.append(node);
    node.querySelector('textarea').focus();
  });

  $('#quiz-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const questions = [...document.querySelectorAll('#questions .q-editor')].map((n) => {
      const texts = [...n.querySelectorAll('.opt-text')].map((i) => i.value.trim());
      // Boş seçenekleri at, doğru cevap indeksini buna göre kaydır
      const checked = n.querySelector('input[type=radio]:checked');
      const correctOrig = checked ? Number(checked.value) : -1;
      const options = [];
      let correct = -1;
      texts.forEach((t, i) => {
        if (!t) return;
        if (i === correctOrig) correct = options.length;
        options.push(t);
      });
      return { text: n.querySelector('.q-text-input').value, options, correct, time: Number(n.querySelector('.q-time').value) };
    });
    const payload = {
      id: editingId,
      title: $('#q-title').value,
      ders: $('#q-ders').value,
      durationMin: Number($('#q-duration').value) || 0,
      questions,
    };
    socket.emit('teacher:saveQuiz', payload, (res) => {
      if (!res || !res.ok) { $('#editor-error').textContent = (res && res.error) || 'Kaydedilemedi.'; return; }
      toast('Quiz kaydedildi.');
      closeEditor();
    });
  });

  // ------------------------------------------------------------------ sonuçlar

  function csvFor(r) {
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const header = ['Sıra', 'Öğrenci', 'Puan', 'Doğru', ...r.questions.map((_, i) => `S${i + 1}`)];
    const rows = r.players.map((p, i) => [i + 1, p.name, p.score, p.correct,
      ...r.questions.map((q, qi) => {
        const a = p.answers[qi];
        if (!a || a.choice == null) return '-';
        return `${q.options[a.choice]}${a.correct ? ' ✓' : ''}`;
      })]);
    return '﻿' + [header, ...rows].map((row) => row.map(esc).join(';')).join('\r\n');
  }

  function download(r) {
    const blob = new Blob([csvFor(r)], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${r.ders}-${r.title}-${new Date(r.startedAt).toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function renderResults() {
    const box = $('#results');
    box.replaceChildren();
    if (!results.length) { box.append(el('p', { class: 'muted' }, 'Henüz tamamlanmış quiz yok.')); return; }
    for (const r of results) {
      const open = openResults.has(r.id);
      box.append(el('div', { style: 'border-top:1px solid #e5e5ea;padding:12px 0' },
        el('div', { class: 'row between' },
          el('div', {},
            el('strong', {}, `${r.title}`), ` · ${r.ders}`,
            el('div', { class: 'muted' }, `${new Date(r.startedAt).toLocaleString('tr-TR')} · ${r.players.length} öğrenci · ${REASONS[r.reason] || ''}`)),
          el('div', { class: 'row' },
            el('button', { class: 'btn small ghost', onclick: () => { open ? openResults.delete(r.id) : openResults.add(r.id); renderResults(); } }, open ? 'Gizle' : 'Detay'),
            el('button', { class: 'btn small blue', onclick: () => download(r) }, 'CSV indir'),
            el('button', {
              class: 'btn small red',
              onclick: async () => {
                if (!confirm('Bu sonuç silinsin mi?')) return;
                const res = await call('teacher:deleteResult', { id: r.id });
                if (res.ok) { results = res.results; renderResults(); }
              },
            }, 'Sil'))),
        open ? el('div', { style: 'overflow-x:auto;margin-top:8px' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Öğrenci'), el('th', {}, 'Puan'), el('th', {}, 'Doğru'),
            r.questions.map((_, i) => el('th', { title: r.questions[i].text }, `S${i + 1}`)))),
          el('tbody', {}, r.players.map((p, i) => el('tr', {},
            el('td', {}, i + 1), el('td', {}, p.name), el('td', {}, p.score), el('td', {}, `${p.correct}/${r.questions.length}`),
            r.questions.map((q, qi) => {
              const a = p.answers[qi];
              return el('td', { style: a && a.correct ? 'color:var(--green)' : 'color:var(--red)' }, !a || a.choice == null ? '–' : a.correct ? '✓' : '✗');
            })))))) : null));
    }
  }
})();
