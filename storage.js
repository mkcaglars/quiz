'use strict';

// Kalıcı kayıt katmanı: DATABASE_URL varsa PostgreSQL, yoksa data/ altındaki JSON dosyaları.
// Her iki sürüm de aynı arayüzü sunar; tüm metotlar Promise döner.

const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// JSON dosyaları (yerel geliştirme)
// ---------------------------------------------------------------------------

function createFileStorage(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const quizzesFile = path.join(dataDir, 'quizzes.json');
  const resultsFile = path.join(dataDir, 'results.json');
  let quizzes = [];
  let results = [];

  return {
    kind: 'file',
    async init(seedQuizzes) {
      const q = readJson(quizzesFile, null);
      quizzes = Array.isArray(q) ? q : seedQuizzes;
      if (!Array.isArray(q)) writeJson(quizzesFile, quizzes);
      const r = readJson(resultsFile, []);
      results = Array.isArray(r) ? r : [];
    },
    async loadQuizzes() {
      return quizzes.map((x) => ({ ...x }));
    },
    async saveQuiz(quiz) {
      const idx = quizzes.findIndex((x) => x.id === quiz.id);
      if (idx === -1) quizzes.push(quiz);
      else quizzes[idx] = quiz;
      writeJson(quizzesFile, quizzes);
    },
    async deleteQuiz(id) {
      quizzes = quizzes.filter((x) => x.id !== id);
      writeJson(quizzesFile, quizzes);
    },
    async listResults(limit) {
      return results.slice(0, limit);
    },
    async addResult(record) {
      results.unshift(record);
      if (results.length > 500) results.length = 500;
      writeJson(resultsFile, results);
    },
    async deleteResult(id) {
      results = results.filter((x) => x.id !== id);
      writeJson(resultsFile, results);
    },
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL (Neon, Supabase, Render vb.)
// ---------------------------------------------------------------------------

function createPgStorage(databaseUrl, dataDir) {
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(databaseUrl) || databaseUrl.includes('host=/');
  const pool = new Pool({
    connectionString: databaseUrl,
    // Bulut veritabanları SSL ister; yerel test veritabanı istemez
    ssl: local || /sslmode=disable/.test(databaseUrl) ? false : { rejectUnauthorized: false },
    max: 5,
  });

  return {
    kind: 'postgres',
    async init(seedQuizzes) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS quizzes (
          id         TEXT PRIMARY KEY,
          data       JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS results (
          id         TEXT PRIMARY KEY,
          data       JSONB NOT NULL,
          started_at BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS results_started_at_idx ON results (started_at DESC);
      `);

      // İlk kurulumda: data/ klasöründe eski JSON kayıtlar varsa aktar, yoksa örnek quiz ekle
      const { rows: [{ n: quizCount }] } = await pool.query('SELECT count(*)::int AS n FROM quizzes');
      if (quizCount === 0) {
        const fileQuizzes = dataDir ? readJson(path.join(dataDir, 'quizzes.json'), null) : null;
        const toImport = Array.isArray(fileQuizzes) && fileQuizzes.length ? fileQuizzes : seedQuizzes;
        for (const q of toImport) await this.saveQuiz(q);
      }
      const { rows: [{ n: resultCount }] } = await pool.query('SELECT count(*)::int AS n FROM results');
      if (resultCount === 0 && dataDir) {
        const fileResults = readJson(path.join(dataDir, 'results.json'), []);
        if (Array.isArray(fileResults)) for (const r of fileResults) await this.addResult(r);
      }
    },
    async loadQuizzes() {
      const { rows } = await pool.query('SELECT data FROM quizzes ORDER BY updated_at');
      return rows.map((r) => r.data);
    },
    async saveQuiz(quiz) {
      await pool.query(
        `INSERT INTO quizzes (id, data) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [quiz.id, quiz],
      );
    },
    async deleteQuiz(id) {
      await pool.query('DELETE FROM quizzes WHERE id = $1', [id]);
    },
    async listResults(limit) {
      const { rows } = await pool.query('SELECT data FROM results ORDER BY started_at DESC LIMIT $1', [limit]);
      return rows.map((r) => r.data);
    },
    async addResult(record) {
      await pool.query(
        'INSERT INTO results (id, data, started_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [record.id, record, record.startedAt],
      );
    },
    async deleteResult(id) {
      await pool.query('DELETE FROM results WHERE id = $1', [id]);
    },
    async close() {
      await pool.end();
    },
  };
}

function createStorage({ databaseUrl, dataDir }) {
  return databaseUrl ? createPgStorage(databaseUrl, dataDir) : createFileStorage(dataDir);
}

module.exports = { createStorage };
