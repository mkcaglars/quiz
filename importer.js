'use strict';

// Yüklenen quiz dosyalarını (CSV şablonu veya JSON) okur.
// Sonuç: { quizzes: [{ title, ders, durationMin, questions }], errors: ['Satır 4: ...'] }

const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const key = (s) => norm(s).toLocaleLowerCase('tr-TR');

// RFC 4180 uyumlu basit CSV okuyucu (tırnak içi ayraç ve satır sonlarını destekler)
function parseCsv(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === delim) {
      row.push(cell); cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function detectDelimiter(firstLine) {
  const counts = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}

// Başlık satırındaki sütun adlarını tanımak için (büyük/küçük harf ve Türkçe karakter duyarsız)
const simplify = (s) => key(s)
  .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
  .replace(/[^a-z0-9]/g, '');

const COLUMNS = {
  ders: ['ders', 'dersadi', 'lesson', 'course'],
  title: ['quizbasligi', 'baslik', 'quiz', 'quizadi', 'title'],
  text: ['soru', 'sorumetni', 'question'],
  a: ['seceneka', 'a', 'cevapa', 'optiona'],
  b: ['secenekb', 'b', 'cevapb', 'optionb'],
  c: ['secenekc', 'c', 'cevapc', 'optionc'],
  d: ['secenekd', 'd', 'cevapd', 'optiond'],
  correct: ['dogrucevap', 'dogru', 'cevap', 'correct'],
  time: ['suresn', 'sure', 'soresuresi', 'sorusuresi', 'time'],
  durationMin: ['toplamsuredk', 'toplamsure', 'quizsuresi', 'duration'],
};

function mapHeader(header) {
  const map = {};
  const names = header.map(simplify);
  const used = new Set();
  // Önce birebir eşleşme, sonra "Doğru Cevap (A/B/C/D)" gibi uzatılmış başlıklar için önek eşleşmesi
  for (const prefix of [false, true]) {
    names.forEach((s, i) => {
      if (used.has(i) || !s) return;
      for (const [field, aliases] of Object.entries(COLUMNS)) {
        if (map[field] !== undefined) continue;
        if (aliases.some((a) => (prefix ? a.length >= 4 && s.startsWith(a) : s === a))) {
          map[field] = i;
          used.add(i);
          return;
        }
      }
    });
  }
  return map;
}

const LETTERS = ['a', 'b', 'c', 'd'];

function parseCorrect(value, options) {
  const v = key(value);
  if (!v) return { error: 'Doğru cevap boş' };
  let idx = LETTERS.indexOf(v.replace(/[).]/g, ''));
  if (idx === -1 && /^[1-4]$/.test(v)) idx = Number(v) - 1;
  if (idx === -1) idx = options.findIndex((o) => key(o) === v);
  if (idx === -1) return { error: `Doğru cevap "${norm(value)}" anlaşılamadı (A, B, C veya D yazın)` };
  if (!options[idx]) return { error: `Doğru cevap ${LETTERS[idx].toUpperCase()} seçilmiş ama o seçenek boş` };
  return { idx };
}

function parseCsvQuizzes(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const rows = parseCsv(text, detectDelimiter(firstLine));
  const errors = [];
  if (!rows.length) return { quizzes: [], errors: ['Dosya boş.'] };

  const map = mapHeader(rows[0]);
  const missing = ['ders', 'title', 'text', 'a', 'b', 'correct'].filter((f) => map[f] === undefined);
  if (missing.length) {
    return {
      quizzes: [],
      errors: ['İlk satırda şablondaki sütun başlıkları bulunamadı. Şablonu indirip başlık satırını silmeden doldurun.'],
    };
  }

  const groups = new Map();
  let lastDers = '';
  let lastTitle = '';
  const get = (row, field) => (map[field] === undefined ? '' : norm(row[map[field]]));

  rows.slice(1).forEach((row, i) => {
    const line = i + 2;
    if (row.every((c) => !norm(c))) return; // boş satır
    // Ders ve başlık boşsa bir üst satırdakiler geçerli
    const ders = get(row, 'ders') || lastDers;
    const title = get(row, 'title') || lastTitle;
    lastDers = ders;
    lastTitle = title;
    const rowErrors = [];
    if (!ders) rowErrors.push('Ders boş');
    if (!title) rowErrors.push('Quiz başlığı boş');

    const text = get(row, 'text');
    if (!text) rowErrors.push('Soru metni boş');
    const raw = LETTERS.map((l) => get(row, l));
    // Boş seçenekler sondan atılır; arada boşluk olamaz
    const options = raw.slice();
    while (options.length && !options[options.length - 1]) options.pop();
    if (options.length < 2) rowErrors.push('En az 2 seçenek (A ve B) gerekli');
    else if (options.some((o) => !o)) rowErrors.push('Seçenekler arasında boş bırakılan var (C boşsa D de boş olmalı)');

    const correct = parseCorrect(get(row, 'correct'), options);
    if (correct.error) rowErrors.push(correct.error);

    const timeRaw = get(row, 'time');
    let time = 20;
    if (timeRaw) {
      time = Number(timeRaw.replace(',', '.'));
      if (!Number.isFinite(time) || time < 5 || time > 300) {
        rowErrors.push(`Süre "${timeRaw}" geçersiz (5-300 saniye arası bir sayı yazın)`);
      }
    }

    const durRaw = get(row, 'durationMin');
    let durationMin = null;
    if (durRaw) {
      durationMin = Number(durRaw.replace(',', '.'));
      if (!Number.isFinite(durationMin) || durationMin < 0 || durationMin > 600) {
        rowErrors.push(`Toplam süre "${durRaw}" geçersiz (0-600 dakika)`);
      }
    }

    if (rowErrors.length) {
      errors.push(`Satır ${line}: ${rowErrors.join('; ')}.`);
      return;
    }
    const gk = key(ders) + '|' + key(title);
    if (!groups.has(gk)) groups.set(gk, { title, ders, durationMin: 0, questions: [] });
    const g = groups.get(gk);
    if (durationMin != null) g.durationMin = durationMin;
    g.questions.push({ text, options, correct: correct.idx, time: Math.round(time) });
  });

  return { quizzes: [...groups.values()], errors };
}

function parseJsonQuizzes(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { quizzes: [], errors: ['JSON dosyası okunamadı: ' + err.message] };
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.quizzes) ? data.quizzes : [data];
  return {
    quizzes: list.map((q) => ({
      title: q && q.title,
      ders: q && q.ders,
      durationMin: (q && q.durationMin) || 0,
      questions: (q && q.questions) || [],
    })),
    errors: [],
  };
}

function parseQuizFile(text, filename) {
  const clean = String(text || '').replace(/^﻿/, '');
  if (!clean.trim()) return { quizzes: [], errors: ['Dosya boş.'] };
  const isJson = /\.json$/i.test(filename || '') || /^\s*[[{]/.test(clean);
  return isJson ? parseJsonQuizzes(clean) : parseCsvQuizzes(clean);
}

module.exports = { parseQuizFile, parseCsv };
