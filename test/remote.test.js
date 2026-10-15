'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

const csv = (title) => `Ders;Quiz Başlığı;Soru;Seçenek A;Seçenek B;Doğru Cevap\nKimya;${title};2+2?;3;4;B\n`;

test('Uzak hostingdeki klasör sayfasından CSV dosyaları yüklenir', async () => {
  const files = { '/q/a.csv': csv('Uzak Quiz'), '/q/b.csv': csv('Uzak Quiz 2') };
  const web = http.createServer((req, res) => {
    if (req.url === '/q/') {
      res.setHeader('content-type', 'text/html');
      return res.end('<a href="a.csv">a.csv</a><a href="b.csv">b</a><a href="notlar.pdf">x</a>');
    }
    if (files[req.url]) return res.end(files[req.url]);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => web.listen(0, r));
  const url = `http://127.0.0.1:${web.address().port}/q/`;

  const srv = createApp({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'remote-')),
    quizDir: null, remoteUrl: url, scanMs: 50, databaseUrl: null, autoSync: false,
  });
  await srv.ready;
  const titles = async () => (await srv.storage.loadQuizzes()).map((q) => q.title);
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    const t = await titles();
    ok = t.includes('Uzak Quiz') && t.includes('Uzak Quiz 2');
    if (!ok) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(ok);
  await srv.close();
  web.close();
});
