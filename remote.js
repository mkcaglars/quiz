'use strict';

// Başka bir hostingdeki web adresinden quiz dosyalarını okur.
// Adres şunlardan biri olabilir:
//   - tek bir dosya (.csv/.json/.txt)
//   - dosya listesi gösteren klasör sayfası (Apache/nginx "dizin listesi")
//   - dosya adlarını veya { name, url } nesnelerini içeren JSON dizisi

const { decode } = require('./source');

const MAX_BYTES = 900 * 1024;
const MAX_FILES = 30;
const FILE_RE = /\.(csv|json|txt)$/i;

async function get(url) {
  const headers = {
    'user-agent': 'Mozilla/5.0 (compatible; QuizSync/1.0)',
    accept: 'text/csv,text/html,application/json;q=0.9,*/*;q=0.8',
  };
  if (process.env.REMOTE_QUIZ_TOKEN) headers['x-quiz-token'] = process.env.REMOTE_QUIZ_TOKEN;
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', headers, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('adrese ulaşılamadı');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('dosya çok büyük (en fazla 900 KB)');
  return { text: decode(buf), type: res.headers.get('content-type') || '' };
}

function nameOf(u) {
  return decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
}

function linksFromHtml(html, base) {
  const out = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, '&'), base);
      if (u.origin === new URL(base).origin && FILE_RE.test(u.pathname)) out.push(u.href);
    } catch { /* geçersiz bağlantıyı atla */ }
  }
  return out;
}

function linksFromJson(text, base) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('JSON listesi bir dizi olmalı');
  return list.map((item) => {
    const ref = typeof item === 'string' ? item : item && (item.url || item.name);
    return ref ? new URL(ref, base).href : null;
  }).filter((u) => u && FILE_RE.test(new URL(u).pathname));
}

// Dönen: [{ name, url, text, error }]
async function fetchRemote(url) {
  let base;
  try {
    base = new URL(url);
  } catch {
    throw new Error('REMOTE_QUIZ_URL geçerli bir adres değil.');
  }
  if (!/^https?:$/.test(base.protocol)) throw new Error('REMOTE_QUIZ_URL http veya https olmalı.');

  let urls;
  if (FILE_RE.test(base.pathname) && !/\.json$/i.test(base.pathname)) {
    urls = [base.href];
  } else {
    const index = await get(base.href);
    const looksJson = /json/i.test(index.type) || /^\s*[\[{]/.test(index.text);
    if (/\.json$/i.test(base.pathname) && !Array.isArray(safeJson(index.text))) {
      urls = [base.href]; // liste değil, tek bir quiz JSON dosyası
    } else {
      urls = looksJson ? linksFromJson(index.text, base.href) : linksFromHtml(index.text, base.href);
    }
  }
  urls = [...new Set(urls)].slice(0, MAX_FILES);

  const out = [];
  for (const u of urls) {
    try {
      out.push({ name: nameOf(u), url: u, text: (await get(u)).text });
    } catch (err) {
      out.push({ name: nameOf(u), url: u, error: err.message });
    }
  }
  return out;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { fetchRemote, linksFromHtml, linksFromJson };
