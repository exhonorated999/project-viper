/**
 * UC Chat Operations — Evidence Log (append-only chain-of-custody).
 *
 * Faithful port of ICAC PULSE's src/main/uc/evidenceLog.ts to VIPER's
 * better-sqlite3 stack. Every evidence file write (UC capture, persona
 * photo import, clipboard export) records a SHA-256 of the file content so
 * the log is queryable for a court-defensible audit + integrity check.
 *
 * VIPER adaptation: ICAC used sql.js (lastInsertRowid always 0, so it
 * queried MAX(id)). better-sqlite3 returns a real lastInsertRowid and needs
 * no explicit save, so we use it directly.
 */

const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('./uc-chat-db');

/** Compute SHA-256 of a file on disk. Streams to handle large files. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`sha256File: file not found: ${filePath}`));
      return;
    }
    const stat = fs.statSync(filePath);
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size: stat.size }));
    stream.on('error', reject);
  });
}

/**
 * Hash the file and insert a row into evidence_log.
 * @param {{ evidenceId?: number|null, caseId?: string|number|null, chatId?: number|null,
 *   action: 'create'|'export'|'hash'|'verify'|'route', filePath: string,
 *   operatorUserId?: number|null, meta?: Record<string, any> }} opts
 * @returns {Promise<{ id: number, sha256: string, size: number }>}
 */
async function recordEvidenceLog(opts) {
  const db = getDb();
  const { sha256, size } = await sha256File(opts.filePath);
  const info = db.prepare(
    `INSERT INTO evidence_log
       (evidence_id, case_id, chat_id, action, sha256, file_path, size_bytes, operator_user_id, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.evidenceId ?? null,
    opts.caseId != null ? String(opts.caseId) : null,
    opts.chatId ?? null,
    opts.action,
    sha256,
    opts.filePath,
    size,
    opts.operatorUserId ?? null,
    opts.meta ? JSON.stringify(opts.meta) : null
  );
  return { id: Number(info.lastInsertRowid), sha256, size };
}

/** Verify a file still matches its recorded hash. */
async function verifyEvidenceLogEntry(rowId) {
  const db = getDb();
  const row = db.prepare('SELECT file_path, sha256 FROM evidence_log WHERE id = ?').get(rowId);
  if (!row || !row.file_path || !row.sha256) {
    return { match: false, expected: (row && row.sha256) || null, actual: null };
  }
  try {
    const { sha256 } = await sha256File(row.file_path);
    return { match: sha256 === row.sha256, expected: row.sha256, actual: sha256 };
  } catch {
    return { match: false, expected: row.sha256, actual: null };
  }
}

/** List evidence_log rows filtered by case/chat. */
function listEvidenceLog(filter = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (filter.caseId != null) { where.push('case_id = ?'); params.push(String(filter.caseId)); }
  if (filter.chatId != null) { where.push('chat_id = ?'); params.push(filter.chatId); }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const limit = filter.limit ?? 500;
  return db.prepare(`SELECT * FROM evidence_log${whereSql} ORDER BY ts DESC LIMIT ?`).all(...params, limit) || [];
}

module.exports = { sha256File, recordEvidenceLog, verifyEvidenceLogEntry, listEvidenceLog };
