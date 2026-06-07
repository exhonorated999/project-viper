// modules/warrant-author/warrant-author-main.js
// Warrant Author — Multi-Business ESP Warrant authoring pipeline.
//
// One affidavit + N per-provider addendums (Multi-Business pattern).
// Drafts are persisted per-case on disk under:
//   cases/{caseNumber}/Warrants/Drafts/{warrantId}/{manifest.json, warrant.pdf, warrant.docx}
//
// localStorage `warrantAuthor_${caseId}` holds the INDEX ONLY
// (warrant list + lifecycle metadata) — large blobs live on disk and
// are loaded lazily via warrant-author-read-draft.
//
// Field Security: manifest.json and any sidecar payloads are written as
// VIPENC blobs when SecurityManager is enabled+unlocked. Same convention
// as Cellebrite + CargoNet. PDF/DOCX outputs are written plaintext (they
// are the deliverable and need to print/serve outside VIPER) BUT live
// only inside the encrypted case folder when Field Security is on.
//
// Phase: P0 — skeleton only. IPC handlers are stubs that return
// { success: false, error: 'not-implemented' } until P1 wires them up.

const fs   = require('fs');
const path = require('path');
const { app, dialog, shell } = require('electron');

// ─── State ────────────────────────────────────────────────────────────
let _security   = null;
let _mainWindow = null;

function setSecurityManager(sm) { _security = sm; }
function setMainWindow(win)     { _mainWindow = win; }
function _isSecActive()         { return !!(_security && _security.isEnabled() && _security.isUnlocked()); }

// ─── Paths ────────────────────────────────────────────────────────────
function _userdataDir() { return path.join(app.getPath('userData'), 'warrant-author'); }
function _draftsDirFor(casePath, warrantId) {
    return path.join(casePath, 'Warrants', 'Drafts', warrantId);
}
function _manifestPath(casePath, warrantId) {
    return path.join(_draftsDirFor(casePath, warrantId), 'manifest.json');
}

// ─── Secure JSON helpers (mirrors cellebrite/cargonet pattern) ────────
function _secureWriteJson(filePath, obj) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const json = JSON.stringify(obj, null, 2);
    if (_isSecActive()) {
        const enc = _security.encryptBuffer(Buffer.from(json, 'utf-8'));
        fs.writeFileSync(filePath, enc);
    } else {
        fs.writeFileSync(filePath, json, 'utf-8');
    }
}

function _secureReadJson(filePath) {
    let raw;
    try { raw = fs.readFileSync(filePath); }
    catch (e) { return { ok: false, error: e.message, missing: e.code === 'ENOENT' }; }
    const isEnc = raw.length >= 6 && raw.subarray(0, 6).equals(Buffer.from('VIPENC'));
    if (!isEnc) {
        try { return { ok: true, data: JSON.parse(raw.toString('utf-8')) }; }
        catch (e) { return { ok: false, error: `parse failed: ${e.message}` }; }
    }
    if (!_security || !_security.isUnlocked()) {
        return { ok: false, locked: true, error: 'Field Security is locked — unlock to view this warrant draft.' };
    }
    try {
        const plain = _security.decryptBuffer(raw);
        return { ok: true, data: JSON.parse(plain.toString('utf-8')) };
    } catch (e) { return { ok: false, error: `decrypt failed: ${e.message}` }; }
}

// ─── Id generation ────────────────────────────────────────────────────
function genWarrantId() {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 8);
    return `wa-${ts}-${rnd}`;
}

// ─── Broadcast helper ─────────────────────────────────────────────────
function _broadcast(channel, payload) {
    if (_mainWindow && !_mainWindow.isDestroyed()) {
        try { _mainWindow.webContents.send(channel, payload); } catch (_) {}
    }
}

// ─── IPC handlers (P0: stubs only — P1 implements) ────────────────────
function registerIpc(ipcMain) {

    // ── list-drafts: enumerate manifest.json files under case Warrants/Drafts/ ─
    ipcMain.handle('warrant-author-list-drafts', async (_event, { casePath } = {}) => {
        if (!casePath) return { success: false, error: 'casePath required' };
        const draftsRoot = path.join(casePath, 'Warrants', 'Drafts');
        if (!fs.existsSync(draftsRoot)) return { success: true, drafts: [] };
        try {
            const entries = fs.readdirSync(draftsRoot, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
            const drafts = [];
            for (const id of entries) {
                const mp = _manifestPath(casePath, id);
                if (!fs.existsSync(mp)) continue;
                const r = _secureReadJson(mp);
                if (r.ok) {
                    drafts.push({
                        id,
                        status: r.data.status || 'draft',
                        swNumber: r.data.swNumber || '',
                        template: r.data.template || '',
                        type: r.data.type || 'multi-business-esp',
                        addendumCount: Array.isArray(r.data.addendums) ? r.data.addendums.length : 0,
                        createdAt: r.data.createdAt || null,
                        updatedAt: r.data.updatedAt || null,
                    });
                } else if (r.locked) {
                    drafts.push({ id, locked: true });
                }
            }
            drafts.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
            return { success: true, drafts };
        } catch (e) {
            console.error('[WarrantAuthor] list-drafts error:', e);
            return { success: false, error: e.message };
        }
    });

    // ── get-draft: full manifest read ───────────────────────────────────
    ipcMain.handle('warrant-author-get-draft', async (_event, { casePath, warrantId } = {}) => {
        if (!casePath || !warrantId) return { success: false, error: 'casePath + warrantId required' };
        const mp = _manifestPath(casePath, warrantId);
        if (!fs.existsSync(mp)) return { success: false, error: 'draft not found' };
        const r = _secureReadJson(mp);
        if (!r.ok) return { success: false, error: r.error, locked: !!r.locked };
        return { success: true, draft: r.data };
    });

    // ── save-draft: write manifest.json (creates dir if missing) ─────────
    ipcMain.handle('warrant-author-save-draft', async (_event, { casePath, warrantId, draft } = {}) => {
        if (!casePath) return { success: false, error: 'casePath required' };
        if (!draft || typeof draft !== 'object') return { success: false, error: 'draft object required' };
        const id = warrantId || draft.id || genWarrantId();
        const now = new Date().toISOString();
        const toWrite = {
            ...draft,
            id,
            type: draft.type || 'multi-business-esp',
            status: draft.status || 'draft',
            createdAt: draft.createdAt || now,
            updatedAt: now,
        };
        try {
            _secureWriteJson(_manifestPath(casePath, id), toWrite);
            _broadcast('warrant-author-change', { type: 'save', warrantId: id });
            return { success: true, warrantId: id, updatedAt: now };
        } catch (e) {
            console.error('[WarrantAuthor] save-draft error:', e);
            return { success: false, error: e.message };
        }
    });

    // ── delete-draft: rm draft folder ───────────────────────────────────
    ipcMain.handle('warrant-author-delete-draft', async (_event, { casePath, warrantId } = {}) => {
        if (!casePath || !warrantId) return { success: false, error: 'casePath + warrantId required' };
        const dir = _draftsDirFor(casePath, warrantId);
        if (!fs.existsSync(dir)) return { success: true };
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            _broadcast('warrant-author-change', { type: 'delete', warrantId });
            return { success: true };
        } catch (e) {
            console.error('[WarrantAuthor] delete-draft error:', e);
            return { success: false, error: e.message };
        }
    });

    // ── generate: write PDF (renderer-built bytes) + DOCX (main-built) ───
    // Renderer composes the PDF via jsPDF locally, then ships us the
    // ArrayBuffer along with the structured block-stream so we can build
    // the DOCX in main with the `docx` package.
    //
    // Payload:
    //   { casePath, warrantId, draft, blockStream, formats,
    //     pdfBytes: ArrayBuffer (optional — required if formats includes 'pdf'),
    //     agency: {...} }
    // Returns: { success, warrantId, pdfPath?, docxPath?, pageCount?, sizes }
    ipcMain.handle('warrant-author-generate', async (_event, payload = {}) => {
        const { casePath, warrantId, draft, blockStream, formats, pdfBytes, agency } = payload;
        if (!casePath || !warrantId) return { success: false, error: 'casePath + warrantId required' };
        if (!draft || typeof draft !== 'object') return { success: false, error: 'draft object required' };
        const fmts = Array.isArray(formats) && formats.length ? formats : ['pdf', 'docx'];

        const dir = _draftsDirFor(casePath, warrantId);
        try { fs.mkdirSync(dir, { recursive: true }); }
        catch (e) { return { success: false, error: `mkdir failed: ${e.message}` }; }

        const result = { success: true, warrantId, sizes: {} };

        // ── PDF ─────────────────────────────────────────────────────────
        if (fmts.includes('pdf')) {
            if (!pdfBytes) {
                return { success: false, error: 'pdfBytes required when formats includes pdf' };
            }
            try {
                let buf = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);
                const pdfPath = path.join(dir, 'warrant.pdf');
                if (_isSecActive()) {
                    buf = _security.encryptBuffer(buf);
                }
                fs.writeFileSync(pdfPath, buf);
                result.pdfPath = pdfPath;
                result.sizes.pdf = buf.length;
            } catch (e) {
                console.error('[WarrantAuthor] PDF write failed:', e);
                return { success: false, error: `PDF write failed: ${e.message}` };
            }
        }

        // ── DOCX ────────────────────────────────────────────────────────
        if (fmts.includes('docx')) {
            try {
                if (!blockStream || !Array.isArray(blockStream.blocks)) {
                    return { success: false, error: 'blockStream.blocks required for DOCX generation' };
                }
                const docxComposer = require('./docx-composer');
                let buf = await docxComposer.composeDocx({
                    blockStream,
                    draft,
                    agency: agency || {},
                });
                const docxPath = path.join(dir, 'warrant.docx');
                if (_isSecActive()) {
                    buf = _security.encryptBuffer(buf);
                }
                fs.writeFileSync(docxPath, buf);
                result.docxPath = docxPath;
                result.sizes.docx = buf.length;
            } catch (e) {
                console.error('[WarrantAuthor] DOCX compose/write failed:', e);
                return { success: false, error: `DOCX failed: ${e.message}` };
            }
        }

        // Persist generation metadata onto manifest if present
        try {
            const mp = _manifestPath(casePath, warrantId);
            if (fs.existsSync(mp)) {
                const r = _secureReadJson(mp);
                if (r.ok) {
                    const m = r.data;
                    m.generatedAt = new Date().toISOString();
                    if (result.pdfPath)  m.pdfPath  = result.pdfPath;
                    if (result.docxPath) m.docxPath = result.docxPath;
                    m.updatedAt = m.generatedAt;
                    _secureWriteJson(mp, m);
                }
            }
        } catch (_e) { /* non-fatal */ }

        _broadcast('warrant-author-change', { type: 'generate', warrantId });
        return result;
    });

    // ── open-generated: shell open a generated file (PDF or DOCX) ────────
    // Skips decryption — Field-Security-active files are encrypted on disk,
    // so opening would fail; in that case we fall back to opening the dir.
    ipcMain.handle('warrant-author-open-generated', async (_event, { casePath, warrantId, format } = {}) => {
        if (!casePath || !warrantId) return { success: false, error: 'casePath + warrantId required' };
        const fname = format === 'docx' ? 'warrant.docx' : 'warrant.pdf';
        const fpath = path.join(_draftsDirFor(casePath, warrantId), fname);
        if (!fs.existsSync(fpath)) return { success: false, error: 'file not found — generate first' };
        // If Field Security is active, the file on disk is VIPENC-encrypted;
        // opening it in a desktop viewer would fail. Open the folder instead.
        if (_isSecActive()) {
            try { await shell.openPath(_draftsDirFor(casePath, warrantId)); return { success: true, openedDir: true }; }
            catch (e) { return { success: false, error: e.message }; }
        }
        try { await shell.openPath(fpath); return { success: true }; }
        catch (e) { return { success: false, error: e.message }; }
    });

    // ── pick provider dir: dialog for importing custom provider JSON ─────
    ipcMain.handle('warrant-author-pick-provider-dir', async () => {
        try {
            const result = await dialog.showOpenDialog({
                title: 'Select Provider Registry Folder',
                properties: ['openDirectory'],
            });
            if (result.canceled || !result.filePaths?.length) {
                return { success: false, cancelled: true };
            }
            return { success: true, folderPath: result.filePaths[0] };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ── read provider registry: returns shipped + custom providers ───────
    ipcMain.handle('warrant-author-read-provider-registry', async () => {
        // P0 stub — returns empty. P1 loads from ./provider-registry.js + custom dir.
        return { success: true, providers: [], shipped: 0, custom: 0 };
    });

    // ── mark addendum served / returned (lifecycle) ─────────────────────
    ipcMain.handle('warrant-author-mark-addendum-served', async (_event, { casePath, warrantId, addendumId, servedAt } = {}) => {
        if (!casePath || !warrantId || !addendumId) return { success: false, error: 'casePath + warrantId + addendumId required' };
        const mp = _manifestPath(casePath, warrantId);
        const r = _secureReadJson(mp);
        if (!r.ok) return { success: false, error: r.error, locked: !!r.locked };
        const draft = r.data;
        const add = (draft.addendums || []).find(a => a.id === addendumId);
        if (!add) return { success: false, error: 'addendum not found' };
        add.servedAt = servedAt || new Date().toISOString();
        draft.updatedAt = new Date().toISOString();
        _secureWriteJson(mp, draft);
        _broadcast('warrant-author-change', { type: 'served', warrantId, addendumId });
        return { success: true };
    });

    ipcMain.handle('warrant-author-mark-addendum-returned', async (_event, { casePath, warrantId, addendumId, returnedAt, linkedReturnId } = {}) => {
        if (!casePath || !warrantId || !addendumId) return { success: false, error: 'casePath + warrantId + addendumId required' };
        const mp = _manifestPath(casePath, warrantId);
        const r = _secureReadJson(mp);
        if (!r.ok) return { success: false, error: r.error, locked: !!r.locked };
        const draft = r.data;
        const add = (draft.addendums || []).find(a => a.id === addendumId);
        if (!add) return { success: false, error: 'addendum not found' };
        add.returnedAt = returnedAt || new Date().toISOString();
        if (linkedReturnId) {
            add.linkedReturnIds = Array.isArray(add.linkedReturnIds) ? add.linkedReturnIds : [];
            if (!add.linkedReturnIds.includes(linkedReturnId)) add.linkedReturnIds.push(linkedReturnId);
        }
        draft.updatedAt = new Date().toISOString();
        _secureWriteJson(mp, draft);
        _broadcast('warrant-author-change', { type: 'returned', warrantId, addendumId });
        return { success: true };
    });

    // ── boilerplate library (global, userdata-scoped) ────────────────────
    ipcMain.handle('warrant-author-list-boilerplate', async () => {
        const p = path.join(_userdataDir(), 'boilerplate.json');
        if (!fs.existsSync(p)) return { success: true, paragraphs: [], custom: false };
        const r = _secureReadJson(p);
        if (!r.ok) return { success: false, error: r.error, locked: !!r.locked };
        return { success: true, paragraphs: r.data.paragraphs || [], custom: true };
    });

    ipcMain.handle('warrant-author-save-boilerplate', async (_event, { paragraphs } = {}) => {
        if (!Array.isArray(paragraphs)) return { success: false, error: 'paragraphs array required' };
        try {
            _secureWriteJson(path.join(_userdataDir(), 'boilerplate.json'), { paragraphs });
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('warrant-author-reset-boilerplate', async () => {
        const p = path.join(_userdataDir(), 'boilerplate.json');
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    // ── open draft folder in shell (debug + manual file access) ──────────
    ipcMain.handle('warrant-author-open-draft-folder', async (_event, { casePath, warrantId } = {}) => {
        if (!casePath || !warrantId) return { success: false, error: 'casePath + warrantId required' };
        const dir = _draftsDirFor(casePath, warrantId);
        if (!fs.existsSync(dir)) return { success: false, error: 'folder not found' };
        try {
            await shell.openPath(dir);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });
}

module.exports = {
    registerIpc,
    setSecurityManager,
    setMainWindow,
    _internals: { genWarrantId, _secureReadJson, _secureWriteJson, _draftsDirFor, _manifestPath },
};
