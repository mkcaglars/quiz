'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');
const { parseQuizFile, parseCsv } = require('../importer');

const template = fs.readFileSync(path.join(__dirname, '..', 'public', 'sablon.csv'), 'utf8');

test('CSV okuyucu tırnak, ayraç ve satır sonlarını doğru işler', () => {
  const rows = parseCsv('a;"b;c";"d ""e"""\r\n"çok\nsatır";2;3\n', ';');
  assert.deepStrictEqual(rows, [['a', 'b;c', 'd "e"'], ['çok\nsatır', '2', '3']]);
});

test('şablon dosyası hatasız okunur', () => {
  const r = parseQuizFile(template, 'sablon.csv');
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.quizzes.map((q) => [q.ders, q.title, q.questions.length, q.durationMin]), [
    ['Matematik', 'Çarpım Tablosu', 3, 0],
    ['Fen Bilimleri', 'Hücre', 2, 5],
  ]);
  const tf = r.quizzes[0].questions[2];
  assert.deepStrictEqual(tf.options, ['Doğru', 'Yanlış']);
  assert.strictEqual(tf.correct, 0);
  assert.strictEqual(tf.time, 10);
});

test('virgül ayraçlı dosya, boş ders/başlık ve farklı doğru cevap yazımları', () => {
  const csv = 'ders,quiz başlığı,soru,seçenek a,seçenek b,seçenek c,seçenek d,doğru cevap (a/b/c/d),süre (sn)\n'
    + 'Tarih,Osmanlı,İstanbul kaç yılında fethedildi?,1453,1071,1299,1923,a,\n'
    + ',,Kuruluş yılı?,1071,1299,,,2,30\n'
    + ',,Son padişah?,Vahdettin,Abdülmecid,,,Vahdettin,\n';
  const r = parseQuizFile(csv, 'x.csv');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.quizzes.length, 1);
  assert.deepStrictEqual(r.quizzes[0].questions.map((q) => [q.correct, q.time]), [[0, 20], [1, 30], [0, 20]]);
});

test('hatalar satır numarasıyla bildirilir', () => {
  const csv = 'Ders;Quiz Başlığı;Soru;Seçenek A;Seçenek B;Seçenek C;Seçenek D;Doğru Cevap;Süre (sn)\n'
    + 'Fen;Test;;A;B;;;A;20\n'
    + 'Fen;Test;Soru;A;;;;A;20\n'
    + 'Fen;Test;Soru;A;B;;;C;20\n'
    + 'Fen;Test;Soru;A;B;;D;A;20\n'
    + 'Fen;Test;Soru;A;B;;;X;abc\n';
  const r = parseQuizFile(csv, 'x.csv');
  assert.strictEqual(r.quizzes.length, 0);
  assert.match(r.errors[0], /^Satır 2: Soru metni boş/);
  assert.match(r.errors[1], /^Satır 3: En az 2 seçenek/);
  assert.match(r.errors[2], /^Satır 4: .*C seçilmiş ama o seçenek boş/);
  assert.match(r.errors[3], /^Satır 5: Seçenekler arasında boş/);
  assert.match(r.errors[4], /^Satır 6: .*anlaşılamadı.*Süre "abc" geçersiz/);
});

test('başlık satırı yoksa anlaşılır hata verir', () => {
  const r = parseQuizFile('Fen;Test;Soru;A;B;;;A;20\n', 'x.csv');
  assert.match(r.errors[0], /sütun başlıkları bulunamadı/);
});

test('JSON biçimi de kabul edilir', () => {
  const r = parseQuizFile(JSON.stringify([{ title: 'J', ders: 'D', questions: [{ text: 'q', options: ['a', 'b'], correct: 1 }] }]), 'q.json');
  assert.strictEqual(r.quizzes[0].title, 'J');
});

// ---------------------------------------------------------------- sunucu

let server;
let dataDir;
let t;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-import-'));
  server = createApp({ dataDir, databaseUrl: null, password: 'gizli' });
  await server.ready;
  await new Promise((r) => server.httpServer.listen(0, r));
  t = connect(`http://localhost:${server.httpServer.address().port}`, { transports: ['websocket'], forceNew: true });
  const res = await new Promise((r) => t.emit('teacher:login', { password: 'gizli' }, r));
  assert.ok(res.ok);
});

after(async () => {
  t.close();
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const emit = (ev, payload) => new Promise((r) => t.emit(ev, payload, r));

test('önizleme kaydetmez, içe aktarma kaydeder, tekrar yükleme günceller', async () => {
  const before = (await server.storage.loadQuizzes()).length;
  const preview = await emit('teacher:importQuizzes', { text: template, filename: 'sablon.csv', apply: false });
  assert.ok(preview.ok);
  assert.deepStrictEqual(preview.errors, []);
  assert.deepStrictEqual(preview.preview.map((p) => p.action), ['new', 'new']);
  assert.strictEqual((await server.storage.loadQuizzes()).length, before);

  const applied = await emit('teacher:importQuizzes', { text: template, filename: 'sablon.csv', apply: true });
  assert.ok(applied.ok);
  assert.strictEqual((await server.storage.loadQuizzes()).length, before + 2);

  // Aynı ders + başlık (büyük/küçük harf farklı) → güncelleme, yeni quiz eklenmez
  const changed = template.replace('Fen Bilimleri;Hücre;Hücrenin', 'fen bilimleri;HÜCRE;Hücrenin');
  const again = await emit('teacher:importQuizzes', { text: changed.replace(/\r\n[^\r\n]*Kloroplast[^\r\n]*/, ''), filename: 'x.csv', apply: true });
  assert.ok(again.ok);
  assert.deepStrictEqual(again.preview.map((p) => p.action), ['update', 'update']);
  const all = await server.storage.loadQuizzes();
  assert.strictEqual(all.length, before + 2);
  const updated = all.find((q) => q.title === 'HÜCRE');
  assert.ok(updated, 'güncellemede dosyadaki yeni yazım kullanılır');
  assert.strictEqual(updated.ders, 'fen bilimleri');
  assert.strictEqual(updated.questions.length, 1);
});

test('hatalı dosya içe aktarılamaz', async () => {
  const bad = 'Ders;Quiz Başlığı;Soru;Seçenek A;Seçenek B;Seçenek C;Seçenek D;Doğru Cevap\nFen;X;Soru;A;B;;;\n';
  const res = await emit('teacher:importQuizzes', { text: bad, filename: 'x.csv', apply: true });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /hatalar var/);
});

test('öğrenci içe aktarma yapamaz', async () => {
  const s = connect(`http://localhost:${server.httpServer.address().port}`, { transports: ['websocket'], forceNew: true });
  const res = await new Promise((r) => s.emit('teacher:importQuizzes', { text: template, apply: true }, r));
  s.close();
  assert.strictEqual(res.ok, false);
});
