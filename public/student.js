(function () {
  const { SHAPES, $, el, fmtTime, toast, countdown, REASONS } = window.Q;

  const params = new URLSearchParams(location.search);
  const pick = (...keys) => keys.map((k) => params.get(k)).find((v) => v && v.trim()) || '';
  let name = pick('isim', 'ad', 'name');
  let ders = pick('ders', 'lesson', 'course');

  const screens = ['s-form', 's-connecting', 's-lobby', 's-countdown', 's-question', 's-answered', 's-reveal', 's-waiting', 's-ended'];
  function show(id) {
    for (const s of screens) $('#' + s).classList.toggle('hidden', s !== id);
    current = id;
  }
  let current = 's-connecting';

  let socket = null;
  let stopTimer = null;
  let stopOverall = null;
  let quizActive = false;
  let currentQuestion = null;

  const stopTimers = () => { if (stopTimer) stopTimer(); stopTimer = null; };

  function setScore(score) {
    const s = $('#score');
    s.textContent = `${score} puan`;
    s.classList.remove('hidden');
  }

  function setOverall(ms) {
    if (stopOverall) stopOverall();
    stopOverall = null;
    const o = $('#overall');
    if (ms == null) { o.classList.add('hidden'); return; }
    o.classList.remove('hidden');
    stopOverall = countdown(ms, (left) => { o.textContent = '⏱ ' + fmtTime(left); });
  }

  function renderQuizList(list) {
    const ul = $('#quiz-list');
    ul.replaceChildren();
    if (!list.length) {
      ul.append(el('li', {}, el('span', { class: 'muted' }, 'Bu ders için henüz quiz yok.')));
      return;
    }
    for (const q of list) {
      ul.append(el('li', {},
        el('span', {}, el('strong', {}, q.title), ` · ${q.questionCount} soru`),
        el('span', { class: 'badge' + (q.open ? ' open' : '') }, q.open ? 'Açık' : 'Kapalı')));
    }
  }

  function renderTop(listEl, top) {
    listEl.replaceChildren();
    top.forEach((p, i) => {
      listEl.append(el('li', { class: p.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr') ? 'me' : '' },
        el('span', {}, el('span', { class: 'rank' }, `${i + 1}.`), p.name),
        el('span', {}, `${p.score}`)));
    });
  }

  function goLobby() {
    quizActive = false;
    stopTimers();
    setOverall(null);
    show('s-lobby');
  }

  // ---------------------------------------------------------------------

  function connect() {
    $('#who-name').textContent = name;
    $('#who-ders').textContent = ders;
    $('#who-name').classList.remove('hidden');
    $('#who-ders').classList.remove('hidden');
    $('#lobby-title').textContent = `Merhaba ${name}!`;
    document.title = `${ders} · Quiz`;
    show('s-connecting');

    socket = io();

    socket.on('connect', () => {
      socket.emit('student:join', { name, ders }, (res) => {
        if (!res || !res.ok) {
          toast((res && res.error) || 'Katılınamadı.');
          show('s-form');
          return;
        }
        renderQuizList(res.quizzes);
        // Aktif bir quiz varsa sunucu hemen ardından durumu gönderir
        if (!quizActive) show('s-lobby');
      });
    });

    socket.on('disconnect', () => {
      stopTimers();
      show('s-connecting');
    });

    socket.on('quizzes', renderQuizList);

    socket.on('quiz:started', (d) => {
      quizActive = true;
      stopTimers();
      setOverall(d.overallRemaining);
      setScore(d.score || 0);
      if (d.countdown > 0) {
        $('#cd-title').textContent = d.title;
        $('#cd-sub').textContent = `${d.total} soru · Hazır ol!`;
        show('s-countdown');
        stopTimer = countdown(d.countdown, (left) => {
          const n = Math.max(1, Math.ceil(left / 1000));
          const node = $('#cd-number');
          if (node.textContent !== String(n)) {
            node.textContent = n;
            node.style.animation = 'none';
            void node.offsetWidth;
            node.style.animation = '';
          }
        });
      } else {
        $('#wait-msg').textContent = 'Quiz devam ediyor, sonraki soru bekleniyor…';
        show('s-waiting');
      }
    });

    socket.on('question', (q) => {
      quizActive = true;
      stopTimers();
      currentQuestion = q;
      $('#q-index').textContent = `Soru ${q.index + 1} / ${q.total}`;
      $('#q-text').textContent = q.text;
      const box = $('#answers');
      box.replaceChildren();
      q.options.forEach((opt, i) => {
        box.append(el('button', {
          class: `answer c${i}`,
          'data-choice': i,
          html: SHAPES[i],
          onclick: () => answer(i),
        }, el('span', {}, opt)));
      });
      if (q.answered != null) { markPicked(q.answered); show('s-answered'); return; }
      show('s-question');
      const timer = $('#q-timer');
      const bar = $('#q-bar');
      const total = q.time * 1000;
      stopTimer = countdown(q.remaining, (left) => {
        timer.textContent = Math.ceil(left / 1000);
        timer.classList.toggle('low', left <= 5000);
        bar.style.width = (left / total) * 100 + '%';
      }, () => {
        if (current === 's-question') {
          box.querySelectorAll('button').forEach((b) => (b.disabled = true));
        }
      });
    });

    socket.on('answered', ({ choice }) => { markPicked(choice); show('s-answered'); });

    socket.on('reveal', (r) => {
      stopTimers();
      const scr = $('#s-reveal');
      scr.classList.remove('correct', 'wrong');
      scr.classList.add(r.isCorrect ? 'correct' : 'wrong');
      $('#r-icon').textContent = r.isCorrect ? '✔' : '✘';
      $('#r-title').textContent = r.isCorrect ? 'Doğru!' : (r.yourChoice == null ? 'Süre doldu!' : 'Yanlış!');
      $('#r-points').textContent = r.isCorrect ? `+${r.points}` : '+0';
      const correctText = currentQuestion ? currentQuestion.options[r.correct] : '';
      $('#r-rank').textContent = `${r.rank}. sıradasın (${r.players} kişi) · Toplam ${r.score} puan` +
        (!r.isCorrect && correctText ? ` · Doğru cevap: ${correctText}` : '');
      renderTop($('#r-top'), r.top);
      setScore(r.score);
      show('s-reveal');
    });

    socket.on('waiting', (d) => {
      $('#wait-msg').textContent = d.message;
      if (d.score != null) setScore(d.score);
      show('s-waiting');
    });

    socket.on('quiz:ended', (d) => {
      stopTimers();
      setOverall(null);
      quizActive = false;
      $('#e-icon').textContent = d.rank === 1 ? '🏆' : d.rank === 2 ? '🥈' : d.rank === 3 ? '🥉' : '🎉';
      $('#e-reason').textContent = REASONS[d.reason] || '';
      $('#e-score').textContent = `${d.score} puan`;
      $('#e-rank').textContent = `${d.players} kişi içinde ${d.rank}. oldun · ${d.correct}/${d.total} doğru`;
      renderTop($('#e-top'), d.top);
      setScore(d.score);
      show('s-ended');
    });

    // Quize hiç katılmamış (ör. cevap vermeden bağlanmış) öğrenciler için
    socket.on('quiz:closed', () => {
      if (current !== 's-ended') goLobby();
    });
  }

  function markPicked(choice) {
    $('#answers').querySelectorAll('button').forEach((b) => {
      b.disabled = true;
      const picked = Number(b.dataset.choice) === choice;
      b.classList.toggle('picked', picked);
      b.classList.toggle('dim', !picked);
    });
  }

  function answer(choice) {
    if (!currentQuestion) return;
    markPicked(choice);
    stopTimers();
    show('s-answered');
    socket.emit('student:answer', { choice, index: currentQuestion.index }, (res) => {
      if (!res || !res.ok) {
        toast((res && res.error) || 'Cevap gönderilemedi.');
      }
    });
  }

  $('#back-lobby').addEventListener('click', goLobby);

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = $('#f-name').value.trim();
    const d = $('#f-ders').value.trim();
    if (!n || !d) { $('#form-error').textContent = 'İsim ve ders gerekli.'; return; }
    params.set('isim', n);
    params.set('ders', d);
    history.replaceState(null, '', '?' + params.toString());
    name = n;
    ders = d;
    if (socket) { socket.disconnect(); socket = null; }
    connect();
  });

  if (name && ders) {
    connect();
  } else {
    $('#f-name').value = name;
    $('#f-ders').value = ders;
    show('s-form');
  }
})();
