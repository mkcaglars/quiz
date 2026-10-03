'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { createApp, sanitizeQuiz } = require('../server');

// TEST_DATABASE_URL verilirse testler PostgreSQL üzerinde, verilmezse JSON dosyalarıyla çalışır.
// Dikkat: PostgreSQL modunda bu veritabanındaki quizzes/results tabloları silinir.
const databaseUrl = process.env.TEST_DATABASE_URL || null;

let server;
let url;
let dataDir;
const sockets = [];

async function resetDatabase() {
  if (!databaseUrl) return;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query('DROP TABLE IF EXISTS quizzes, results');
  await pool.end();
}

async function startServer() {
  const s = createApp({ dataDir, databaseUrl, password: 'gizli', countdownMs: 50, revealMs: 100 });
  await s.ready;
  await new Promise((r) => s.httpServer.listen(0, r));
  return s;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-test-'));
  await resetDatabase();
  server = await startServer();
  url = `http://localhost:${server.httpServer.address().port}`;
});

after(async () => {
  for (const s of sockets) s.close();
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function client() {
  const s = connect(url, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}
const emit = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const once = (s, ev) => new Promise((r) => s.once(ev, r));

async function teacher() {
  const t = client();
  const res = await emit(t, 'teacher:login', { password: 'gizli' });
  assert.ok(res.ok);
  return { t, res };
}

test('sanitizeQuiz doğrulama yapar', () => {
  assert.throws(() => sanitizeQuiz({ title: '', ders: 'x', questions: [] }), /başlığı/);
  assert.throws(() => sanitizeQuiz({ title: 'a', ders: 'x', questions: [{ text: 'q', options: ['a'], correct: 0 }] }), /2-4/);
  const q = sanitizeQuiz({ title: ' a ', ders: 'Fizik', questions: [{ text: 'q', options: ['a', 'b', '', ''], correct: 1, time: 1 }] });
  assert.deepStrictEqual(q.questions[0].options, ['a', 'b']);
  assert.strictEqual(q.questions[0].time, 5);
});

test('yanlış şifre reddedilir, öğrenci öğretmen olayı çağıramaz', async () => {
  const s = client();
  const bad = await emit(s, 'teacher:login', { password: 'yanlis' });
  assert.strictEqual(bad.ok, false);
  const res = await emit(s, 'teacher:start', { quizId: 'x' });
  assert.strictEqual(res.ok, false);
});

test('tam akış: başlat, cevapla, puanla, otomatik bitir', async () => {
  const { t } = await teacher();
  const saved = await emit(t, 'teacher:saveQuiz', {
    title: 'Test', ders: 'Kimya', questions: [
      { text: 'H2O nedir?', options: ['Su', 'Tuz'], correct: 0, time: 5 },
      { text: 'NaCl nedir?', options: ['Su', 'Tuz'], correct: 1, time: 5 },
    ],
  });
  assert.ok(saved.ok);

  const ali = client();
  const ayse = client();
  const other = client(); // farklı ders, quizi görmemeli
  const joinA = await emit(ali, 'student:join', { name: 'Ali', ders: 'kimya' });
  assert.ok(joinA.ok);
  assert.ok(joinA.quizzes.some((q) => q.title === 'Test' && !q.open));
  await emit(ayse, 'student:join', { name: 'Ayşe', ders: 'Kimya ' });
  await emit(other, 'student:join', { name: 'Veli', ders: 'Tarih' });
  let otherGotQuestion = false;
  other.on('question', () => { otherGotQuestion = true; });

  const startedP = once(ali, 'quiz:started');
  const q1P = once(ali, 'question');
  const q1bP = once(ayse, 'question');
  const start = await emit(t, 'teacher:start', { quizId: saved.quiz.id });
  assert.ok(start.ok);
  // aynı derste ikinci quiz başlatılamaz
  const dup = await emit(t, 'teacher:start', { quizId: saved.quiz.id });
  assert.strictEqual(dup.ok, false);

  await startedP;
  const q1 = await q1P;
  await q1bP;
  assert.strictEqual(q1.index, 0);
  assert.strictEqual(q1.correct, undefined, 'doğru cevap öğrenciye gönderilmemeli');

  const revealP = once(ali, 'reveal');
  assert.ok((await emit(ali, 'student:answer', { choice: 0, index: 0 })).ok);
  const again = await emit(ali, 'student:answer', { choice: 1, index: 0 });
  assert.strictEqual(again.ok, false, 'ikinci cevap kabul edilmemeli');
  assert.ok((await emit(ayse, 'student:answer', { choice: 1, index: 0 })).ok);
  // herkes cevapladı → süre beklenmeden sonuç
  const r1 = await revealP;
  assert.strictEqual(r1.isCorrect, true);
  assert.ok(r1.points >= 500 && r1.points <= 1000);
  assert.strictEqual(r1.rank, 1);

  // reveal süresi sonunda 2. soru otomatik gelir
  const q2 = await once(ali, 'question');
  assert.strictEqual(q2.index, 1);
  const endedP = once(ali, 'quiz:ended');
  const teacherEndedP = once(t, 'teacher:ended');
  await emit(ali, 'student:answer', { choice: 1, index: 1 });
  await emit(ayse, 'student:answer', { choice: 1, index: 1 });

  const ended = await endedP;
  assert.strictEqual(ended.reason, 'completed');
  assert.strictEqual(ended.correct, 2);
  assert.strictEqual(ended.rank, 1);
  const record = await teacherEndedP;
  assert.strictEqual(record.players.length, 2);
  assert.strictEqual(record.players[0].name, 'Ali');
  assert.strictEqual(otherGotQuestion, false);

  // sonuç kalıcı kayda yazıldı mı (yazma arka planda yapılır)
  let stored = [];
  for (let i = 0; i < 20 && !stored.some((r) => r.id === record.id); i++) {
    await new Promise((r) => setTimeout(r, 25));
    stored = await server.storage.listResults(10);
  }
  assert.ok(stored.some((r) => r.id === record.id));
});

test('öğretmen quizi erken bitirebilir; geç gelen öğrenci devam eden soruya katılır', async () => {
  const { t } = await teacher();
  const saved = await emit(t, 'teacher:saveQuiz', {
    title: 'Uzun', ders: 'Biyoloji', questions: [{ text: 'Soru?', options: ['A', 'B', 'C', 'D'], correct: 2, time: 60 }],
  });
  const start = await emit(t, 'teacher:start', { quizId: saved.quiz.id });
  assert.ok(start.ok);
  await new Promise((r) => setTimeout(r, 120)); // geri sayım bitsin

  const late = client();
  const qP = once(late, 'question');
  await emit(late, 'student:join', { name: 'Geç Kalan', ders: 'biyoloji' });
  const q = await qP;
  assert.ok(q.remaining > 50000);

  const endedP = once(late, 'quiz:ended');
  assert.ok((await emit(t, 'teacher:end', { sessionId: start.sessionId })).ok);
  const ended = await endedP;
  assert.strictEqual(ended.reason, 'teacher');
  assert.strictEqual(ended.score, 0);
});

test('toplam süre dolunca quiz otomatik biter', async () => {
  const { t } = await teacher();
  const saved = await emit(t, 'teacher:saveQuiz', {
    title: 'Kısa', ders: 'Coğrafya', durationMin: 0.002, // ~120ms
    questions: [{ text: 'Soru?', options: ['A', 'B'], correct: 0, time: 60 }],
  });
  const s = client();
  await emit(s, 'student:join', { name: 'Zeynep', ders: 'Coğrafya' });
  const endedP = once(s, 'quiz:ended');
  await emit(t, 'teacher:start', { quizId: saved.quiz.id });
  const ended = await endedP;
  assert.strictEqual(ended.reason, 'time');
});

test('quizler ve sonuçlar sunucu yeniden başlayınca kaybolmaz', async () => {
  const { t } = await teacher();
  const saved = await emit(t, 'teacher:saveQuiz', {
    title: 'Kalıcı', ders: 'Edebiyat', questions: [{ text: 'Soru?', options: ['A', 'B'], correct: 0, time: 30 }],
  });
  assert.ok(saved.ok);
  const before = (await emit(t, 'teacher:results')).results.length;
  assert.ok(before >= 1);

  // ikinci bir sunucu aynı kayıt yerine bağlanır (yeniden başlatma gibi)
  const second = await startServer();
  try {
    const t2 = connect(`http://localhost:${second.httpServer.address().port}`, { transports: ['websocket'], forceNew: true });
    sockets.push(t2);
    const res = await emit(t2, 'teacher:login', { password: 'gizli' });
    assert.ok(res.ok);
    assert.ok(res.quizzes.some((q) => q.id === saved.quiz.id && q.title === 'Kalıcı'));
    assert.ok(res.quizzes.some((q) => q.title === 'Örnek Matematik Quizi'), 'örnek quiz bir kez eklenmeli');
    assert.strictEqual(res.quizzes.filter((q) => q.title === 'Örnek Matematik Quizi').length, 1);
    assert.strictEqual(res.results.length, before);

    const del = await emit(t2, 'teacher:deleteResult', { id: res.results[0].id });
    assert.ok(del.ok);
    assert.strictEqual(del.results.length, before - 1);
    assert.ok((await emit(t2, 'teacher:deleteQuiz', { id: saved.quiz.id })).ok);
  } finally {
    await second.close();
  }
  const after = await server.storage.loadQuizzes();
  if (databaseUrl) assert.ok(!after.some((q) => q.id === saved.quiz.id), 'silinen quiz veritabanından da gitmeli');
});
