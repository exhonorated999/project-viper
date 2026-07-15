/**
 * UC Chat Operations — database bootstrap (better-sqlite3).
 *
 * Ported from ICAC PULSE (which used sql.js). VIPER already bundles
 * better-sqlite3 (used read-only by Cellebrite/Datapilot parsers); here we
 * open a dedicated *writable* application database at:
 *     <userData>/viper-uc.db
 *
 * Schema is a faithful port of ICAC's uc_* tables. The one adaptation: ICAC
 * referenced an integer `cases(id)` table via FOREIGN KEY. VIPER has no such
 * table — cases are identified by case-number strings (e.g. "66-6666") — so
 * `primary_case_id` / `case_id` are stored as TEXT with no FK to a cases table.
 * Intra-UC foreign keys (persona_id, chat_id, photo_id) are preserved and
 * enforced via PRAGMA foreign_keys = ON.
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let _db = null;

/** Absolute path to the persona avatars directory (<userData>/uc_avatars). */
function getAvatarsDir() {
  const dir = path.join(app.getPath('userData'), 'uc_avatars');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to the persona photo library root (<userData>/uc_photos). */
function getPhotosRoot() {
  const dir = path.join(app.getPath('userData'), 'uc_photos');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SCHEMA = `
-- ====== UC Chat Operations (undercover) ======
CREATE TABLE IF NOT EXISTS uc_personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  real_age INTEGER,
  displayed_age INTEGER,
  gender TEXT,
  hometown TEXT,
  bio TEXT,
  backstory TEXT,
  avatar_path TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  archived_at DATETIME
);

CREATE TABLE IF NOT EXISTS uc_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  platform_url TEXT,
  suspect_handle TEXT,
  suspect_display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  primary_case_id TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  archived_at DATETIME,
  FOREIGN KEY (persona_id) REFERENCES uc_personas(id)
);

CREATE TABLE IF NOT EXISTS uc_chat_case_links (
  chat_id INTEGER NOT NULL,
  case_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'secondary',
  linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, case_id),
  FOREIGN KEY (chat_id) REFERENCES uc_chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uc_chat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL,
  payload_json TEXT,
  FOREIGN KEY (chat_id) REFERENCES uc_chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evidence_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id INTEGER,
  case_id TEXT,
  chat_id INTEGER,
  action TEXT NOT NULL,
  sha256 TEXT,
  file_path TEXT,
  size_bytes INTEGER,
  operator_user_id INTEGER,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS uc_persona_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  original_filename TEXT,
  caption TEXT,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  sha256 TEXT,
  size_bytes INTEGER,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  archived_at DATETIME,
  FOREIGN KEY (persona_id) REFERENCES uc_personas(id)
);

CREATE TABLE IF NOT EXISTS uc_photo_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  action TEXT NOT NULL DEFAULT 'copy_to_clipboard',
  notes TEXT,
  FOREIGN KEY (photo_id) REFERENCES uc_persona_photos(id),
  FOREIGN KEY (chat_id) REFERENCES uc_chats(id)
);

CREATE INDEX IF NOT EXISTS idx_uc_chats_persona_id ON uc_chats(persona_id);
CREATE INDEX IF NOT EXISTS idx_uc_chats_status ON uc_chats(status);
CREATE INDEX IF NOT EXISTS idx_uc_chats_last_activity ON uc_chats(last_activity_at);
CREATE INDEX IF NOT EXISTS idx_uc_chat_case_links_case_id ON uc_chat_case_links(case_id);
CREATE INDEX IF NOT EXISTS idx_uc_chat_events_chat_id ON uc_chat_events(chat_id);
CREATE INDEX IF NOT EXISTS idx_uc_chat_events_ts ON uc_chat_events(ts);
CREATE INDEX IF NOT EXISTS idx_uc_persona_photos_persona_id ON uc_persona_photos(persona_id);
CREATE INDEX IF NOT EXISTS idx_uc_photo_uses_photo_id ON uc_photo_uses(photo_id);
CREATE INDEX IF NOT EXISTS idx_uc_photo_uses_chat_id ON uc_photo_uses(chat_id);
CREATE INDEX IF NOT EXISTS idx_evidence_log_case_id ON evidence_log(case_id);
CREATE INDEX IF NOT EXISTS idx_evidence_log_chat_id ON evidence_log(chat_id);
CREATE INDEX IF NOT EXISTS idx_evidence_log_evidence_id ON evidence_log(evidence_id);
CREATE INDEX IF NOT EXISTS idx_evidence_log_ts ON evidence_log(ts);
`;

/** Open (once) and return the UC database singleton. */
function getDb() {
  if (_db) return _db;
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    const err = new Error(
      'better-sqlite3 is required for UC Chat Operations. Run `npm install` and rebuild against Electron (electron-rebuild).'
    );
    err.cause = e;
    throw err;
  }
  const dbPath = path.join(app.getPath('userData'), 'viper-uc.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);
  return _db;
}

module.exports = { getDb, getAvatarsDir, getPhotosRoot };
