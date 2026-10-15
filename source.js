'use strict';

// Google Drive / Google Sheets bağlantısından quiz dosyası indirir.

const MAX_BYTES = 900 * 1024;

// Paylaşım bağlantısını doğrudan indirme adresine çevirir. Desteklenmeyen adreste Error fırlatır.
function toDownloadUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    throw new Error('Geçerli bir bağlantı girin.');
  }
  if (u.protocol !== 'https:') throw new Error('Bağlantı https ile başlamalı.');

  if (u.hostname === 'docs.google.com') {
    const m = u.pathname.match(/^\/spreadsheets\/d\/([\w-]+)/);
    if (!m) throw new Error('Yalnızca Google E-Tablolar bağlantıları desteklenir.');
    const gid = u.searchParams.get('gid') || (u.hash.match(/gid=(\d+)/) || [])[1];
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
  }
  if (u.hostname === 'drive.google.com') {
    const m = u.pathname.match(/^\/file\/d\/([\w-]+)/) || null;
    const id = m ? m[1] : u.searchParams.get('id');
    if (!id || !/^[\w-]+$/.test(id)) throw new Error('Drive bağlantısında dosya kimliği bulunamadı.');
    return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  throw new Error('Yalnızca Google Drive veya Google E-Tablolar bağlantıları desteklenir.');
}

function decode(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1254').decode(buf);
  }
  return text.replace(/^\uFEFF/, '');
}

async function fetchSource(url) {
  const target = toDownloadUrl(url);
  let res;
  try {
    res = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('Bağlantıya ulaşılamadı.');
  }
  if (!res.ok) {
    throw new Error('Dosya indirilemedi. Paylaşım ayarını "Bağlantıya sahip herkes görüntüleyebilir" yapın.');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('Dosya çok büyük (en fazla 900 KB).');
  const text = decode(buf);
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('Dosya yerine bir web sayfası geldi. Paylaşım ayarını "Bağlantıya sahip herkes görüntüleyebilir" yapın.');
  }
  return { text, filename: 'drive.csv' };
}

function folderIdOf(input) {
  try {
    const u = new URL(String(input || '').trim());
    if (u.protocol !== 'https:' || u.hostname !== 'drive.google.com') return null;
    const m = u.pathname.match(/\/folders\/([\w-]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Bağlantı geçerli mi (dosya veya klasör)? Değilse Error fırlatır.
function validateSource(input) {
  if (folderIdOf(input)) return 'folder';
  toDownloadUrl(input);
  return 'file';
}

const FOLDER_TYPES = new Set([
  'text/csv', 'text/plain', 'application/json', 'application/vnd.ms-excel',
  'application/vnd.google-apps.spreadsheet',
]);

async function readResponse(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('Dosya çok büyük (en fazla 900 KB).');
  return decode(buf);
}

// Herkese açık Drive klasöründeki quiz dosyalarını indirir. Dönen: [{ filename, text, error }]
async function fetchFolder(url, apiKey) {
  const id = folderIdOf(url);
  if (!id) throw new Error('Geçerli bir Drive klasör bağlantısı girin.');
  if (!apiKey) throw new Error('Klasör için GOOGLE_API_KEY ortam değişkeni gerekli.');
  const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=100&key=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(listUrl, { signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('Drive\'a ulaşılamadı.');
  }
  if (!res.ok) {
    throw new Error('Klasör okunamadı. Klasörü "Bağlantıya sahip herkes görüntüleyebilir" yapın ve Drive API anahtarını kontrol edin.');
  }
  const files = ((await res.json()).files || [])
    .filter((f) => FOLDER_TYPES.has(f.mimeType) || /\.(csv|json|txt)$/i.test(f.name))
    .slice(0, 30);
  const out = [];
  for (const f of files) {
    const base = `https://www.googleapis.com/drive/v3/files/${f.id}`;
    const fileUrl = f.mimeType === 'application/vnd.google-apps.spreadsheet'
      ? `${base}/export?mimeType=text/csv&key=${encodeURIComponent(apiKey)}`
      : `${base}?alt=media&key=${encodeURIComponent(apiKey)}`;
    try {
      const r = await fetch(fileUrl, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('indirilemedi');
      out.push({ filename: f.name, text: await readResponse(r) });
    } catch (err) {
      out.push({ filename: f.name, error: err.message });
    }
  }
  return out;
}

module.exports = { fetchSource, fetchFolder, toDownloadUrl, folderIdOf, validateSource, decode };
