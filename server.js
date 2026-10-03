'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { createStorage } = require('./storage');

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

const normalize = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');
const clean = (s, max = 60) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);
const newId = () => crypto.randomBytes(6).toString('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const SAMPLE_QUIZ = {
  title: 'Örnek Matematik Quizi',
  ders: 'Matematik',
  durationMin: 0,
  questions: [
    { text: '7 × 8 kaçtır?', options: ['54', '56', '64', '48'], correct: 1, time: 20 },
    { text: 'Hangisi asal sayıdır?', options: ['21', '27', '29', '33'], correct: 2, time: 20 },
    { text: '144 sayısının karekökü kaçtır?', options: ['12', '14', '11', '16'], correct: 0, time: 15 },
    { text: 'Bir üçgenin iç açıları toplamı kaç derecedir?', options: ['90', '360', '270', '180'], correct: 3, time: 15 },
  ],
};

// Gelen quiz verisini doğrular ve temizler. Hata durumunda Error fırlatır.
function sanitizeQuiz(input) {
  const title = clean(input && input.title, 120);
  const ders = clean(input && input.ders, 60);
  if (!title) throw new Error('Quiz başlığı gerekli.');
  if (!ders) throw new Error('Ders adı gerekli.');
  const durationMin = Math.max(0, Math.min(600, Number(input.durationMin) || 0));
  const raw = Array.isArray(input.questions) ? input.questions : [];
  if (raw.length === 0) throw new Error('En az bir soru ekleyin.');
  if (raw.length > 100) throw new Error('En fazla 100 soru eklenebilir.');
  const questions = raw.map((q, i) => {
    const text = clean(q && q.text, 500);
    if (!text) throw new Error(`${i + 1}. sorunun metni boş.`);
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => clean(o, 200));
    while (options.length && !options[options.length - 1]) options.pop();
    if (options.length < 2 || options.length > 4) throw new Error(`${i + 1}. soru için 2-4 seçenek girin.`);
    if (options.some((o) => !o)) throw new Error(`${i + 1}. sorunun boş seçeneği var.`);
    const correct = Number(q.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
      throw new Error(`${i + 1}. soru için doğru cevabı işaretleyin.`);
    }
    const time = Math.max(5, Math.min(300, Math.round(Number(q.time) || 20)));
    return { text, options, correct, time };
  });
  return { title, ders, durationMin, questions };
}

// ---------------------------------------------------------------------------
// Sunucu
// ---------------------------------------------------------------------------

function createApp(opts = {}) {
  const dataDir = opts.dataDir || path.join(__dirname, 'data');
  const password = opts.password || process.env.TEACHER_PASSWORD || 'ogretmen123';
  const countdownMs = opts.countdownMs ?? 3000; // quiz başlamadan önceki geri sayım
  const revealMs = opts.revealMs ?? 5000; // cevap gösterildikten sonra sonraki soruya geçiş

  const databaseUrl = opts.databaseUrl !== undefined ? opts.databaseUrl : process.env.DATABASE_URL;
  const storage = createStorage({ databaseUrl, dataDir });

  // Quizler bellekte de tutulur (hızlı erişim için); her değişiklik önce kalıcı kayda yazılır.
  let quizzes = [];
  const ready = storage
    .init([{ id: newId(), createdAt: Date.now(), ...SAMPLE_QUIZ }])
    .then(() => storage.loadQuizzes())
    .then((list) => { quizzes = list; });

  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  app.get(['/ogretmen', '/teacher'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher.html')));
  app.get('/health', (req, res) => res.json({ ok: true }));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  // dersKey -> Map(socketId -> name)   (bekleme salonundaki öğrenciler)
  const lobbies = new Map();
  // dersKey -> oturum (her ders için aynı anda tek aktif quiz)
  const sessions = new Map();

  const dersRoom = (key) => 'ders:' + key;

  // --- Öğretmene gönderilen özetler --------------------------------------

  function lobbySummary() {
    const out = [];
    for (const [key, members] of lobbies) {
      if (members.size === 0) continue;
      const names = [...new Set([...members.values()].map((m) => m.name))].sort((a, b) => a.localeCompare(b, 'tr'));
      out.push({ dersKey: key, ders: [...members.values()][0].ders, students: names });
    }
    return out.sort((a, b) => a.ders.localeCompare(b.ders, 'tr'));
  }

  function leaderboard(session, limit) {
    const list = [...session.players.values()]
      .map((p) => ({ name: p.name, score: p.score, correct: p.correctCount }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'tr'));
    return limit ? list.slice(0, limit) : list;
  }

  function sessionSummary(session) {
    const q = session.quiz.questions[session.qIndex];
    return {
      id: session.id,
      quizId: session.quiz.id,
      title: session.quiz.title,
      ders: session.quiz.ders,
      state: session.state,
      qIndex: session.qIndex,
      total: session.quiz.questions.length,
      question: q && session.state !== 'countdown' ? q : null,
      remaining: session.phaseEndsAt ? Math.max(0, session.phaseEndsAt - Date.now()) : 0,
      overallRemaining: session.endsAt ? Math.max(0, session.endsAt - Date.now()) : null,
      answered: session.answers.size,
      players: session.players.size,
      counts: answerCounts(session),
      leaderboard: leaderboard(session),
    };
  }

  function answerCounts(session) {
    const q = session.quiz.questions[session.qIndex];
    const counts = q ? q.options.map(() => 0) : [];
    for (const a of session.answers.values()) if (counts[a.choice] !== undefined) counts[a.choice]++;
    return counts;
  }

  function pushTeacherState() {
    io.to('teachers').emit('teacher:state', {
      lobbies: lobbySummary(),
      sessions: [...sessions.values()].map(sessionSummary),
    });
  }

  function quizListFor(dersKey) {
    const active = sessions.get(dersKey);
    return quizzes
      .filter((q) => normalize(q.ders) === dersKey)
      .map((q) => ({
        id: q.id,
        title: q.title,
        questionCount: q.questions.length,
        open: !!(active && active.quiz.id === q.id),
      }));
  }

  function pushQuizList(dersKey) {
    io.to(dersRoom(dersKey)).emit('quizzes', quizListFor(dersKey));
  }

  // --- Oturum akışı -------------------------------------------------------

  function clearPhaseTimer(session) {
    if (session.phaseTimer) clearTimeout(session.phaseTimer);
    session.phaseTimer = null;
  }

  function setPhase(session, state, ms, next) {
    clearPhaseTimer(session);
    session.state = state;
    session.phaseEndsAt = ms != null ? Date.now() + ms : null;
    if (ms != null) session.phaseTimer = setTimeout(next, ms);
  }

  function questionPayload(session) {
    const q = session.quiz.questions[session.qIndex];
    return {
      sessionId: session.id,
      index: session.qIndex,
      total: session.quiz.questions.length,
      text: q.text,
      options: q.options,
      time: q.time,
      remaining: Math.max(0, session.phaseEndsAt - Date.now()),
    };
  }

  function startSession(quiz) {
    const dersKey = normalize(quiz.ders);
    const session = {
      id: newId(),
      quiz: JSON.parse(JSON.stringify(quiz)),
      dersKey,
      startedAt: Date.now(),
      endsAt: quiz.durationMin > 0 ? Date.now() + quiz.durationMin * 60000 : null,
      state: 'countdown',
      qIndex: 0,
      players: new Map(),
      answers: new Map(),
      phaseEndsAt: null,
      phaseTimer: null,
      overallTimer: null,
    };
    sessions.set(dersKey, session);

    // Bekleme salonundaki herkes otomatik olarak katılır
    const members = lobbies.get(dersKey);
    if (members) for (const [sid, m] of members) ensurePlayer(session, m.name).sockets.add(sid);

    if (session.endsAt) {
      session.overallTimer = setTimeout(() => endSession(session, 'time'), session.endsAt - Date.now());
    }

    setPhase(session, 'countdown', countdownMs, () => startQuestion(session, 0));
    io.to(dersRoom(dersKey)).emit('quiz:started', {
      sessionId: session.id,
      title: quiz.title,
      total: quiz.questions.length,
      countdown: countdownMs,
      overallRemaining: session.endsAt ? session.endsAt - Date.now() : null,
    });
    pushQuizList(dersKey);
    pushTeacherState();
    return session;
  }

  function startQuestion(session, index) {
    if (session.state === 'ended') return;
    if (index >= session.quiz.questions.length) return endSession(session, 'completed');
    session.qIndex = index;
    session.answers = new Map();
    const q = session.quiz.questions[index];
    setPhase(session, 'question', q.time * 1000, () => reveal(session));
    session.questionStartedAt = Date.now();
    io.to(dersRoom(session.dersKey)).emit('question', questionPayload(session));
    pushTeacherState();
  }

  function reveal(session) {
    if (session.state !== 'question') return;
    const q = session.quiz.questions[session.qIndex];
    const isLast = session.qIndex >= session.quiz.questions.length - 1;
    // Cevap vermeyenler için boş kayıt
    for (const p of session.players.values()) {
      if (!p.answers[session.qIndex]) {
        p.answers[session.qIndex] = { choice: null, correct: false, points: 0, ms: null };
      }
    }
    setPhase(session, 'reveal', revealMs, () => startQuestion(session, session.qIndex + 1));

    const board = leaderboard(session);
    const counts = answerCounts(session);
    for (const p of session.players.values()) {
      const a = p.answers[session.qIndex];
      const rank = board.findIndex((b) => b.name === p.name) + 1;
      for (const sid of p.sockets) {
        io.to(sid).emit('reveal', {
          correct: q.correct,
          counts,
          yourChoice: a.choice,
          isCorrect: a.correct,
          points: a.points,
          score: p.score,
          rank,
          players: board.length,
          top: board.slice(0, 5),
          isLast,
          next: revealMs,
        });
      }
    }
    pushTeacherState();
  }

  function endSession(session, reason) {
    if (session.state === 'ended') return;
    // Soru açıkken bitiyorsa o soruyu değerlendir
    if (session.state === 'question') {
      for (const p of session.players.values()) {
        if (!p.answers[session.qIndex]) p.answers[session.qIndex] = { choice: null, correct: false, points: 0, ms: null };
      }
    }
    clearPhaseTimer(session);
    if (session.overallTimer) clearTimeout(session.overallTimer);
    session.state = 'ended';
    session.phaseEndsAt = null;
    if (sessions.get(session.dersKey) === session) sessions.delete(session.dersKey);

    const board = leaderboard(session);
    const record = {
      id: session.id,
      quizId: session.quiz.id,
      title: session.quiz.title,
      ders: session.quiz.ders,
      startedAt: session.startedAt,
      endedAt: Date.now(),
      reason,
      questions: session.quiz.questions,
      players: board.map((b) => {
        const p = session.players.get(normalize(b.name));
        return { ...b, answers: p ? p.answers : [] };
      }),
    };
    storage.addResult(record).catch((err) => {
      console.error('Sonuç kaydedilemedi:', err);
      io.to('teachers').emit('teacher:error', `"${record.title}" sonucu kaydedilemedi: ${err.message}`);
    });

    for (const p of session.players.values()) {
      const rank = board.findIndex((b) => b.name === p.name) + 1;
      for (const sid of p.sockets) {
        io.to(sid).emit('quiz:ended', {
          reason,
          score: p.score,
          correct: p.correctCount,
          total: session.quiz.questions.length,
          rank,
          players: board.length,
          top: board.slice(0, 5),
        });
      }
    }
    io.to(dersRoom(session.dersKey)).emit('quiz:closed', { sessionId: session.id, reason });
    pushQuizList(session.dersKey);
    io.to('teachers').emit('teacher:ended', record);
    pushTeacherState();
  }

  function ensurePlayer(session, name) {
    const key = normalize(name);
    let p = session.players.get(key);
    if (!p) {
      p = { name, score: 0, correctCount: 0, answers: [], sockets: new Set() };
      session.players.set(key, p);
    }
    return p;
  }

  function attachSocketToSession(socket, session) {
    const p = ensurePlayer(session, socket.data.name);
    p.sockets.add(socket.id);
    return p;
  }

  // Öğrenci bağlandığında / yeniden bağlandığında mevcut duruma senkronize et
  function syncStudent(socket, session) {
    const p = attachSocketToSession(socket, session);
    const base = {
      sessionId: session.id,
      title: session.quiz.title,
      total: session.quiz.questions.length,
      overallRemaining: session.endsAt ? Math.max(0, session.endsAt - Date.now()) : null,
      score: p.score,
    };
    if (session.state === 'countdown') {
      socket.emit('quiz:started', { ...base, countdown: Math.max(0, session.phaseEndsAt - Date.now()) });
    } else if (session.state === 'question') {
      socket.emit('quiz:started', { ...base, countdown: 0 });
      const ans = session.answers.get(normalize(p.name));
      socket.emit('question', { ...questionPayload(session), answered: ans ? ans.choice : null });
    } else if (session.state === 'reveal') {
      socket.emit('quiz:started', { ...base, countdown: 0 });
      socket.emit('waiting', { message: 'Sonraki soru birazdan…', score: p.score });
    }
  }

  // --- Socket olayları -----------------------------------------------------

  io.on('connection', (socket) => {
    socket.on('student:join', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const name = clean(payload && payload.name, 40);
      const ders = clean(payload && payload.ders, 60);
      if (!name || !ders) return reply({ ok: false, error: 'İsim ve ders bilgisi gerekli.' });
      if (socket.data.role) return reply({ ok: false, error: 'Zaten katıldınız.' });

      const dersKey = normalize(ders);
      socket.data = { role: 'student', name, ders, dersKey };
      socket.join(dersRoom(dersKey));
      if (!lobbies.has(dersKey)) lobbies.set(dersKey, new Map());
      lobbies.get(dersKey).set(socket.id, { name, ders });

      reply({ ok: true, name, ders, quizzes: quizListFor(dersKey) });
      const session = sessions.get(dersKey);
      if (session) syncStudent(socket, session);
      pushTeacherState();
    });

    socket.on('student:answer', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (socket.data.role !== 'student') return reply({ ok: false, error: 'Önce katılın.' });
      const session = sessions.get(socket.data.dersKey);
      if (!session || session.state !== 'question') return reply({ ok: false, error: 'Şu an cevap verilemez.' });
      if (payload && payload.index !== undefined && payload.index !== session.qIndex) {
        return reply({ ok: false, error: 'Bu sorunun süresi doldu.' });
      }
      const q = session.quiz.questions[session.qIndex];
      const choice = Number(payload && payload.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) {
        return reply({ ok: false, error: 'Geçersiz seçenek.' });
      }
      const key = normalize(socket.data.name);
      if (session.answers.has(key)) return reply({ ok: false, error: 'Bu soruyu zaten cevapladınız.' });
      const now = Date.now();
      if (now > session.phaseEndsAt) return reply({ ok: false, error: 'Süre doldu.' });

      const p = attachSocketToSession(socket, session);
      const ms = now - session.questionStartedAt;
      const correct = choice === q.correct;
      // Kahoot tarzı puan: doğru cevap 500-1000 arası, hızlı olan daha çok alır
      const points = correct ? Math.round(1000 * (1 - Math.min(1, ms / (q.time * 1000)) / 2)) : 0;
      session.answers.set(key, { choice, ms });
      p.answers[session.qIndex] = { choice, correct, points, ms };
      p.score += points;
      if (correct) p.correctCount++;
      reply({ ok: true });
      // Aynı öğrencinin diğer sekmelerine de bildir
      for (const sid of p.sockets) if (sid !== socket.id) io.to(sid).emit('answered', { choice });

      pushTeacherState();
      // Bağlı tüm katılımcılar cevapladıysa beklemeden sonucu göster
      const connected = [...session.players.entries()].filter(([, pl]) => pl.sockets.size > 0);
      if (connected.length > 0 && connected.every(([k]) => session.answers.has(k))) reveal(session);
    });

    socket.on('teacher:login', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!safeEqual((payload && payload.password) || '', password)) {
        return reply({ ok: false, error: 'Şifre hatalı.' });
      }
      socket.data = { role: 'teacher' };
      socket.join('teachers');
      let results = [];
      try {
        results = await storage.listResults(100);
      } catch (err) {
        console.error('Sonuçlar okunamadı:', err);
      }
      reply({ ok: true, quizzes, results });
      pushTeacherState();
    });

    // Öğretmen yetkisi gerektiren olaylar
    const teacherOnly = (event, handler) => {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (socket.data.role !== 'teacher') return reply({ ok: false, error: 'Yetkisiz.' });
        Promise.resolve()
          .then(() => handler(payload || {}, reply))
          .catch((err) => reply({ ok: false, error: err.message || 'Hata oluştu.' }));
      });
    };

    const broadcastQuizzes = (affectedDers) => {
      io.to('teachers').emit('teacher:quizzes', quizzes);
      for (const d of new Set(affectedDers.map(normalize))) pushQuizList(d);
    };

    teacherOnly('teacher:saveQuiz', async (payload, reply) => {
      const data = sanitizeQuiz(payload);
      let quiz;
      const affected = [data.ders];
      if (payload.id) {
        const old = quizzes.find((q) => q.id === payload.id);
        if (!old) throw new Error('Quiz bulunamadı.');
        affected.push(old.ders);
        quiz = { ...old, ...data, updatedAt: Date.now() };
      } else {
        quiz = { id: newId(), createdAt: Date.now(), ...data };
      }
      await storage.saveQuiz(quiz);
      const idx = quizzes.findIndex((q) => q.id === quiz.id);
      if (idx === -1) quizzes.push(quiz);
      else quizzes[idx] = quiz;
      broadcastQuizzes(affected);
      reply({ ok: true, quiz });
    });

    teacherOnly('teacher:deleteQuiz', async ({ id }, reply) => {
      const removed = quizzes.find((q) => q.id === id);
      if (!removed) throw new Error('Quiz bulunamadı.');
      await storage.deleteQuiz(id);
      quizzes = quizzes.filter((q) => q.id !== id);
      broadcastQuizzes([removed.ders]);
      reply({ ok: true });
    });

    teacherOnly('teacher:start', ({ quizId }, reply) => {
      const quiz = quizzes.find((q) => q.id === quizId);
      if (!quiz) throw new Error('Quiz bulunamadı.');
      const existing = sessions.get(normalize(quiz.ders));
      if (existing) throw new Error(`"${quiz.ders}" dersinde zaten devam eden bir quiz var: ${existing.quiz.title}`);
      const session = startSession(quiz);
      reply({ ok: true, sessionId: session.id });
    });

    const findSession = (id) => [...sessions.values()].find((s) => s.id === id);

    teacherOnly('teacher:next', ({ sessionId }, reply) => {
      const session = findSession(sessionId);
      if (!session) throw new Error('Aktif quiz bulunamadı.');
      if (session.state === 'question') reveal(session);
      else if (session.state === 'reveal') startQuestion(session, session.qIndex + 1);
      else if (session.state === 'countdown') startQuestion(session, 0);
      reply({ ok: true });
    });

    teacherOnly('teacher:end', ({ sessionId }, reply) => {
      const session = findSession(sessionId);
      if (!session) throw new Error('Aktif quiz bulunamadı.');
      endSession(session, 'teacher');
      reply({ ok: true });
    });

    teacherOnly('teacher:results', async (payload, reply) => {
      reply({ ok: true, results: await storage.listResults(100) });
    });

    teacherOnly('teacher:deleteResult', async ({ id }, reply) => {
      await storage.deleteResult(id);
      reply({ ok: true, results: await storage.listResults(100) });
    });

    socket.on('disconnect', () => {
      if (socket.data.role !== 'student') return;
      const { dersKey, name } = socket.data;
      const members = lobbies.get(dersKey);
      if (members) {
        members.delete(socket.id);
        if (members.size === 0) lobbies.delete(dersKey);
      }
      const session = sessions.get(dersKey);
      if (session) {
        const p = session.players.get(normalize(name));
        if (p) p.sockets.delete(socket.id);
      }
      pushTeacherState();
    });
  });

  async function close() {
    for (const s of sessions.values()) {
      clearPhaseTimer(s);
      if (s.overallTimer) clearTimeout(s.overallTimer);
    }
    io.close();
    httpServer.close();
    await storage.close();
  }

  return { app, httpServer, io, ready, storage, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { httpServer, ready, storage } = createApp();
  ready.then(() => httpServer.listen(port, () => {
    console.log(`Quiz sunucusu çalışıyor: http://localhost:${port}`);
    console.log(`Kayıt yeri:             ${storage.kind === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : 'data/ klasöründeki JSON dosyaları'}`);
    console.log(`Öğretmen paneli:        http://localhost:${port}/ogretmen`);
    console.log(`Öğrenci bağlantısı:     http://localhost:${port}/?isim=Ali&ders=Matematik`);
    if (!process.env.TEACHER_PASSWORD) console.log('Uyarı: TEACHER_PASSWORD ayarlanmadı, varsayılan şifre "ogretmen123".');
  })).catch((err) => {
    console.error('Kayıt sistemi başlatılamadı (DATABASE_URL doğru mu?):', err.message);
    process.exit(1);
  });
}

module.exports = { createApp, sanitizeQuiz };
