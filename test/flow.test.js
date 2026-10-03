'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { createApp, sanitizeQuiz } = require('../server');

let server;
let url;
let dataDir;
const sockets = [];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-test-'));
  server = createApp({ dataDir, password: 'gizli', countdownMs: 50, revealMs: 100 });
  await new Promise((r) => server.httpServer.listen(0, r));
  url = `http://localhost:${server.httpServer.address().port}`;
});

after(() => {
  for (const s of sockets) s.close();
  server.close();
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

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'results.json'), 'utf8'));
  assert.strictEqual(stored[0].id, record.id);
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
