/**
 * Meta return service — the main-process side of the Meta Warrant module.
 * electron-main.js only forwards IPC calls here; everything that touches the
 * case folder lives in this file so it can be tested headless.
 *
 * No Electron import.  The host passes in what it owns:
 *   casesDir()      -> current cases folder
 *   security()      -> the VIPER vault (or null)
 *   tempDir         -> where vault-encrypted media is decrypted for viewing
 *   issueToken(abs) -> a viper-media:// token for a local file
 *   fingerprint(spec) -> Source Validation fingerprint (may resolve null)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Store = require('./meta-warrant-store');
const { importReturn, isMetaReturn } = require('./meta-warrant-importer');

function createService(host) {
    const inFlight = new Set();          // caseNumber -> one import at a time
    const casesDir = () => host.casesDir();
    const security = () => (host.security ? host.security() : null);

    /** <cases>/<caseNumber>, refusing anything that is not one plain child folder. */
    function caseDirOf(caseNumber) {
        const n = String(caseNumber == null ? '' : caseNumber);
        if (!n.trim() || /[\\/]/.test(n) || n === '.' || n === '..' || n.indexOf('\0') >= 0) {
            throw new Error('Invalid case number');
        }
        const root = path.resolve(casesDir());
        const dir = path.resolve(root, n);
        // The basename test alone already rejects '.', '..' and 'C:x' (drive-
        // relative); the explicit checks above and the dirname test are kept
        // as plain-reading belt and braces (mutation-checked: redundant).
        if (path.dirname(dir) !== root || path.basename(dir) !== n) throw new Error('Invalid case number');
        return dir;
    }

    function storeDirOf(caseNumber, storeKey) {
        return Store.storeDir(caseDirOf(caseNumber), storeKey);
    }

    /** The light record the renderer keeps in localStorage. */
    function lightRecord(res) {
        const m = res.meta || {};
        const idx = res.index || {};
        return {
            storeKey: res.storeKey,
            storeVersion: m.storeVersion,
            service: m.service || '',
            targetId: m.targetId || '',
            accountId: m.accountId || '',
            accountType: m.accountType || '',
            dateRange: m.dateRange || '',
            generated: m.generated || '',
            totals: m.totals || {},
            pages: (idx.pages || []).map(p => ({ name: p.name, kind: p.kind, items: p.items })),
            mediaMissing: (idx.media && idx.media.missing) || 0,
            encrypted: !!(idx.media && idx.media.encrypted)
        };
    }

    return {
        caseDirOf,

        isImporting(caseNumber) { return inFlight.has(String(caseNumber)); },

        /** Meta returns (ZIPs) already sitting in the case folder. */
        async scan(caseNumber) {
            const caseDir = caseDirOf(caseNumber);
            const ownRoot = path.resolve(Store.returnsRoot(caseDir));
            const files = [];
            const walk = async (d, depth) => {
                if (depth > 8) return;
                let entries;
                try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
                for (const e of entries) {
                    const full = path.join(d, e.name);
                    if (e.isDirectory()) {
                        if (path.resolve(full) === ownRoot) continue;
                        await walk(full, depth + 1);
                    } else if (e.isFile() && /\.zip$/i.test(e.name)) {
                        if (await isMetaReturn(full, security())) {
                            let size = 0;
                            try { size = fs.statSync(full).size; } catch (_) {}
                            files.push({ name: e.name, path: full, size });
                        }
                    }
                }
            };
            for (const sub of [['Evidence'], ['Warrants', 'Production']]) {
                const d = path.join(caseDir, ...sub);
                if (fs.existsSync(d)) await walk(d, 0);
            }
            return files;
        },

        /**
         * Import a ZIP or extracted folder into the case's store.
         * One import per case at a time (the importer sweeps leftover staging
         * folders when it starts, which would destroy a running import's).
         */
        async importReturn(req, onProgress) {
            req = req || {};
            const caseNumber = String(req.caseNumber == null ? '' : req.caseNumber);
            const sourcePath = String(req.sourcePath || '');
            const caseDir = caseDirOf(caseNumber);
            if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('The selected return could not be found.');
            if (inFlight.has(caseNumber)) throw new Error('A Meta return is already being imported for this case.');
            inFlight.add(caseNumber);
            try {
                const storeKey = req.storeKey ? Store.safeKey(req.storeKey) : Store.storeKeyFor(sourcePath);
                const fpP = host.fingerprint
                    ? Promise.resolve().then(() => host.fingerprint({ path: sourcePath })).catch(() => null)
                    : Promise.resolve(null);
                const res = await importReturn({
                    sourcePath, caseDir, storeKey,
                    security: security(),
                    meta: { sourcePath, fileName: path.basename(sourcePath), importedAt: new Date().toISOString() },
                    onProgress
                });
                // A re-import replaced the media; drop decrypted copies of the old set.
                if (host.tempDir) {
                    try { fs.rmSync(path.join(host.tempDir, storeKey), { recursive: true, force: true }); } catch (_) {}
                }
                const record = lightRecord(res);
                record.sourceIntegrity = await fpP;
                return record;
            } finally {
                inFlight.delete(caseNumber);
            }
        },

        /** Everything the overview + navigation need, without items or thread lists. */
        overview(caseNumber, storeKey) {
            const dir = storeDirOf(caseNumber, storeKey);
            const index = Store.readIndex(dir);
            if (!index) return null;
            const out = Object.assign({}, index);
            delete out.threads;
            out.threadCount = (index.threads || []).length;
            return out;
        },

        query(caseNumber, storeKey, req) {
            return Store.query(storeDirOf(caseNumber, storeKey), req || {});
        },

        /**
         * A viper-media:// URL for one stored media file (videos stream with
         * byte ranges).  Vault-encrypted files are decrypted into tempDir.
         */
        mediaUrl(caseNumber, storeKey, ref) {
            const dir = storeDirOf(caseNumber, storeKey);
            const hit = Store.mediaPath(dir, String(ref || ''));
            if (!hit) return { found: false };
            if (!fs.existsSync(hit.path)) return { found: false };
            let serve = hit.path;
            if (hit.entry.enc) {
                const sec = security();
                if (!sec || !sec.isUnlocked || !sec.isUnlocked()) {
                    const err = new Error('Unlock VIPER to view this media.');
                    err.code = 'VIPER_LOCKED';
                    throw err;
                }
                const outDir = path.join(host.tempDir, Store.safeKey(storeKey));
                fs.mkdirSync(outDir, { recursive: true });
                serve = path.join(outDir, path.basename(hit.path));
                let fresh = false;
                try { fresh = fs.statSync(serve).size === hit.entry.size; } catch (_) {}
                if (!fresh) {
                    const plain = sec.decryptBuffer(fs.readFileSync(hit.path));
                    fs.writeFileSync(serve, plain);
                }
            }
            return {
                found: true,
                fileUrl: 'viper-media://m/' + host.issueToken(serve),
                mime: hit.entry.mime || 'application/octet-stream',
                kind: hit.entry.kind || 'file',
                size: hit.entry.size || 0,
                name: hit.entry.orig || hit.entry.file,
                sniffed: !!hit.entry.sniffed
            };
        },

        list(caseNumber) {
            return Store.listStores(caseDirOf(caseNumber));
        },

        remove(caseNumber, storeKey) {
            if (inFlight.has(String(caseNumber))) throw new Error('Wait for the running import to finish.');
            const ok = Store.deleteStore(caseDirOf(caseNumber), storeKey);
            if (host.tempDir) {
                try { fs.rmSync(path.join(host.tempDir, Store.safeKey(storeKey)), { recursive: true, force: true }); } catch (_) {}
            }
            return ok;
        },

        /** Drop decrypted copies left from a previous session. */
        clearTemp() {
            if (!host.tempDir) return;
            try { fs.rmSync(host.tempDir, { recursive: true, force: true }); } catch (_) {}
        }
    };
}

module.exports = { createService };
