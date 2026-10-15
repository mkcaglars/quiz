'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toDownloadUrl } = require('../source');

test('Drive dosya bağlantısı indirme adresine çevrilir', () => {
  assert.strictEqual(
    toDownloadUrl('https://drive.google.com/file/d/abc_123-X/view?usp=sharing'),
    'https://drive.google.com/uc?export=download&id=abc_123-X',
  );
  assert.strictEqual(
    toDownloadUrl('https://drive.google.com/open?id=abc123'),
    'https://drive.google.com/uc?export=download&id=abc123',
  );
});

test('E-Tablolar bağlantısı CSV dışa aktarımına çevrilir', () => {
  assert.strictEqual(
    toDownloadUrl('https://docs.google.com/spreadsheets/d/SID/edit#gid=42'),
    'https://docs.google.com/spreadsheets/d/SID/export?format=csv&gid=42',
  );
});

test('Klasör bağlantısından kimlik çıkarılır', () => {
  const { folderIdOf, validateSource } = require('../source');
  assert.strictEqual(folderIdOf('https://drive.google.com/drive/folders/F_1-x?usp=sharing'), 'F_1-x');
  assert.strictEqual(folderIdOf('https://example.com/drive/folders/abc'), null);
  assert.strictEqual(validateSource('https://drive.google.com/drive/folders/abc'), 'folder');
});

test('Google dışı veya https olmayan adresler reddedilir', () => {
  assert.throws(() => toDownloadUrl('https://example.com/a.csv'));
  assert.throws(() => toDownloadUrl('http://drive.google.com/file/d/x/view'));
  assert.throws(() => toDownloadUrl('not a url'));
});
