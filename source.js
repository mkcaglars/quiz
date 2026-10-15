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

module.exports = { fetchSource, toDownloadUrl };
