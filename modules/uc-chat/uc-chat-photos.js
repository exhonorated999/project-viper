/**
 * UC Chat Operations — Persona Photo Library.
 *
 * Faithful port of ICAC PULSE's src/main/uc/photos.ts to VIPER's
 * vanilla-JS / better-sqlite3 stack.
 *
 * Each persona has a private photo library used during undercover chats.
 * On import we re-encode through Electron's nativeImage to strip EXIF
 * (OPSEC — no native deps required). All photos are stored at:
 *     <userData>/uc_photos/<persona_id>/<uuid>.<ext>
 *
 * The renderer accesses thumbnails via the custom `uc-photo://` protocol
 * registered in electron-main.js. The DB stores relative paths.
 *
 * VIPER adaptations vs ICAC (sql.js):
 *   - better-sqlite3 returns a real lastInsertRowid — no MAX(id) workaround,
 *     no explicit saveDatabase().
 *   - appendEvent is lazily required from uc-chat-main.js to avoid a
 *     module-load-time circular dependency.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nativeImage, clipboard } = require('electron');
const { getDb, getPhotosRoot } = require('./uc-chat-db');
const { recordEvidenceLog } = require('./uc-chat-evidence');

/** Lazily resolve appendEvent from the main module (breaks require cycle). */
function appendEvent(chatId, kind, payload) {
  try {
    return require('./uc-chat-main').appendEvent(chatId, kind, payload);
  } catch (e) {
    console.warn('[uc-photo] appendEvent unavailable:', e && e.message);
    return null;
  }
}

function getPersonaDir(personaId) {
  const dir = path.join(getPhotosRoot(), String(personaId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Convert a stored relative path to an absolute path on disk. */
function resolveAbsolutePath(relPath) {
  return path.join(getPhotosRoot(), relPath);
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Re-encode an image through nativeImage to strip EXIF + normalize format.
 * - PNG → PNG (drops ancillary chunks like tEXt/eXIf)
 * - Everything else (jpg/jpeg/gif/webp/heic/bmp/tiff) → quality-92 JPEG
 */
function reencodeStripExif(srcPath) {
  const img = nativeImage.createFromPath(srcPath);
  if (img.isEmpty()) {
    throw new Error(`reencodeStripExif: not a valid image: ${srcPath}`);
  }
  const size = img.getSize(); // { width, height }
  const ext = path.extname(srcPath).toLowerCase();
  if (ext === '.png') {
    return { buffer: img.toPNG(), ext: '.png', mime: 'image/png', width: size.width, height: size.height };
  }
  const buf = img.toJPEG(92);
  return { buffer: buf, ext: '.jpg', mime: 'image/jpeg', width: size.width, height: size.height };
}

/**
 * Add a photo to a persona's library. Re-encodes through nativeImage to
 * strip EXIF.
 * @param {{ personaId: number, srcPath: string, caption?: string }} input
 */
function addPhoto(input) {
  if (!fs.existsSync(input.srcPath)) {
    throw new Error(`addPhoto: source not found: ${input.srcPath}`);
  }
  const db = getDb();
  const personaDir = getPersonaDir(input.personaId);

  const { buffer, ext, mime, width, height } = reencodeStripExif(input.srcPath);
  const uuid = crypto.randomBytes(8).toString('hex');
  const storedName = `${uuid}${ext}`;
  const absDest = path.join(personaDir, storedName);
  fs.writeFileSync(absDest, buffer);

  const relPath = `${input.personaId}/${storedName}`;
  const hash = sha256Buffer(buffer);
  const size = buffer.byteLength;

  // Next sort_order = MAX+1 within this persona's library.
  const ordRow = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM uc_persona_photos WHERE persona_id = ?'
  ).get(input.personaId);
  const sortOrder = (ordRow && ordRow.next) || 1;

  const info = db.prepare(
    `INSERT INTO uc_persona_photos
       (persona_id, file_path, original_filename, caption, mime_type, width, height, sha256, size_bytes, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.personaId,
    relPath,
    path.basename(input.srcPath),
    input.caption ?? null,
    mime,
    width,
    height,
    hash,
    size,
    sortOrder
  );
  const id = Number(info.lastInsertRowid);
  if (!id) throw new Error('addPhoto: failed to resolve new photo id');

  // Chain-of-custody — photo enters the library.
  recordEvidenceLog({
    chatId: null,
    action: 'create',
    filePath: absDest,
    meta: { kind: 'uc_persona_photo', persona_id: input.personaId, stage: 'import' },
  }).catch(e => console.warn('[uc-photo-evlog-import]', e && e.message));

  return getPhoto(id);
}

function decorate(row) {
  // Embed the image as a base64 data: URL. Every page's CSP already allows
  // `data:` in img-src, so this renders reliably regardless of custom-protocol
  // registration. Exposes no absolute path. Falls back to the uc-photo://
  // protocol if the file can't be read.
  let srcUrl = `uc-photo://f/${row.file_path.replace(/\\/g, '/')}`;
  try {
    const abs = resolveAbsolutePath(row.file_path);
    if (fs.existsSync(abs)) {
      const b64 = fs.readFileSync(abs).toString('base64');
      srcUrl = `data:${row.mime_type || 'image/png'};base64,${b64}`;
    }
  } catch (e) {
    console.warn('[uc-photo] decorate data-url failed:', e && e.message);
  }
  return {
    ...row,
    src_url: srcUrl,
  };
}

function getPhoto(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM uc_persona_photos WHERE id = ?').get(id);
  if (!row) return null;
  const stats = db.prepare(
    `SELECT COUNT(*) AS use_count,
            MAX(ts)   AS last_used_at,
            (SELECT chat_id FROM uc_photo_uses WHERE photo_id = ? ORDER BY ts DESC LIMIT 1) AS last_used_chat_id
       FROM uc_photo_uses
      WHERE photo_id = ?`
  ).get(id, id);
  return {
    ...decorate(row),
    use_count: (stats && stats.use_count) ?? 0,
    last_used_at: (stats && stats.last_used_at) ?? null,
    last_used_chat_id: (stats && stats.last_used_chat_id) ?? null,
  };
}

function listPhotos(personaId, includeArchived = false) {
  const db = getDb();
  const sql = includeArchived
    ? 'SELECT * FROM uc_persona_photos WHERE persona_id = ? ORDER BY archived_at IS NULL DESC, sort_order ASC, id ASC'
    : 'SELECT * FROM uc_persona_photos WHERE persona_id = ? AND archived_at IS NULL ORDER BY sort_order ASC, id ASC';
  const rows = db.prepare(sql).all(personaId) || [];
  if (rows.length === 0) return [];

  const idList = rows.map(r => r.id);
  const placeholders = idList.map(() => '?').join(',');
  const usesAgg = db.prepare(
    `SELECT photo_id, COUNT(*) AS use_count, MAX(ts) AS last_used_at
       FROM uc_photo_uses
      WHERE photo_id IN (${placeholders})
      GROUP BY photo_id`
  ).all(...idList);
  const lastChatRows = db.prepare(
    `SELECT u.photo_id, u.chat_id
       FROM uc_photo_uses u
      WHERE u.photo_id IN (${placeholders})
        AND u.ts = (SELECT MAX(ts) FROM uc_photo_uses u2 WHERE u2.photo_id = u.photo_id)`
  ).all(...idList);

  const useMap = new Map(usesAgg.map(r => [r.photo_id, r]));
  const chatMap = new Map(lastChatRows.map(r => [r.photo_id, r.chat_id]));

  return rows.map(r => ({
    ...decorate(r),
    use_count: (useMap.get(r.id) && useMap.get(r.id).use_count) ?? 0,
    last_used_at: (useMap.get(r.id) && useMap.get(r.id).last_used_at) ?? null,
    last_used_chat_id: chatMap.get(r.id) ?? null,
  }));
}

function updatePhoto(id, input) {
  const db = getDb();
  const existing = getPhoto(id);
  if (!existing) throw new Error(`updatePhoto: photo ${id} not found`);
  const fields = [];
  const values = [];
  if (input.caption !== undefined) { fields.push('caption = ?'); values.push(input.caption); }
  if (input.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(input.sort_order); }
  if (fields.length === 0) return existing;
  values.push(id);
  db.prepare(`UPDATE uc_persona_photos SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getPhoto(id);
}

/** Soft-archive — keeps file on disk + DB row for evidence integrity. */
function archivePhoto(id) {
  getDb().prepare('UPDATE uc_persona_photos SET archived_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

function unarchivePhoto(id) {
  getDb().prepare('UPDATE uc_persona_photos SET archived_at = NULL WHERE id = ?').run(id);
}

/** List uses of a photo (audit trail). */
function listPhotoUses(photoId) {
  return getDb().prepare('SELECT * FROM uc_photo_uses WHERE photo_id = ? ORDER BY ts DESC').all(photoId) || [];
}

/**
 * Copy a photo to the clipboard as a native image (so the officer can paste
 * into the social app's compose box). Logs the use + chat event + evidence_log
 * export so chain-of-custody is preserved.
 */
function copyPhotoToClipboard(photoId, chatId) {
  const db = getDb();
  const photo = getPhoto(photoId);
  if (!photo) throw new Error(`copyPhotoToClipboard: photo ${photoId} not found`);
  const abs = resolveAbsolutePath(photo.file_path);
  if (!fs.existsSync(abs)) throw new Error(`copyPhotoToClipboard: file missing: ${abs}`);

  const img = nativeImage.createFromPath(abs);
  if (img.isEmpty()) throw new Error('copyPhotoToClipboard: nativeImage failed to load');
  clipboard.writeImage(img);

  // Log use row.
  db.prepare('INSERT INTO uc_photo_uses (photo_id, chat_id, action, notes) VALUES (?, ?, ?, ?)')
    .run(photoId, chatId, 'copy_to_clipboard', null);

  // Chat event for the chat's timeline.
  try {
    appendEvent(chatId, 'photo_used', {
      photo_id: photoId,
      action: 'copy_to_clipboard',
      file_path: photo.file_path,
      sha256: photo.sha256,
    });
  } catch (e) { console.warn('[uc-photo-use-event]', e && e.message); }

  // Chain-of-custody export entry.
  recordEvidenceLog({
    chatId,
    action: 'export',
    filePath: abs,
    meta: {
      kind: 'uc_persona_photo',
      stage: 'clipboard',
      photo_id: photoId,
      persona_id: photo.persona_id,
    },
  }).catch(e => console.warn('[uc-photo-evlog-export]', e && e.message));

  return { ok: true };
}

module.exports = {
  getPhotosRoot,
  resolveAbsolutePath,
  addPhoto,
  getPhoto,
  listPhotos,
  updatePhoto,
  archivePhoto,
  unarchivePhoto,
  listPhotoUses,
  copyPhotoToClipboard,
};
