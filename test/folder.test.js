'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

test('Quiz klasöründeki CSV dosyaları otomatik yüklenir ve değişiklikler izlenir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quizdir-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quizdata-'));
  const csv = (title) => `Ders;Quiz Başlığı;Soru;Seçenek A;Seçenek B;Doğru Cevap\nFizik;${title};1+1?;1;2;B\n`;
  fs.writeFileSync(path.join(dir, 'a.csv'), csv('Klasör Quizi'));

  const srv = createApp({ dataDir, quizDir: dir, scanMs: 50, databaseUrl: null, autoSync: false });
  await srv.ready;
  const wait = async (fn) => {
    for (let i = 0; i < 60; i++) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const titles = async () => (await srv.storage.loadQuizzes()).map((q) => q.title);

  assert.ok(await wait(async () => (await titles()).includes('Klasör Quizi')));
  fs.writeFileSync(path.join(dir, 'b.csv'), csv('İkinci Quiz'));
  assert.ok(await wait(async () => (await titles()).includes('İkinci Quiz')));
  await srv.close();
});
