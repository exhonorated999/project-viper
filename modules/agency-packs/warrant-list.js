/*
 * modules/agency-packs/warrant-list.js
 *
 * The list of agency warrants kept for a case (Warrant Author → Agency Templates).
 * Each warrant is a saved Builder form; the list keeps a small summary of each so it
 * can be shown without loading the forms.
 *
 *   localStorage
 *     agencyBuilderWarrants_<caseId>          [entry, …]  (the list)
 *     agencyBuilderWarrant_<caseId>_<id>      the form (pack, templates, answers, …)
 *     agencyBuilderDraft_<caseId>             the single form of earlier versions (migrated)
 *
 *   entry: { id, packId, packName, templateIds[], templateNames[], county, status: 'draft'|'created',
 *            createdAt, updatedAt, outputs: [{ name, path, at }] }
 *
 * Pictures in a form live in IndexedDB under "<caseId>|<warrantId>|<hash>" (earlier versions
 * used "<caseId>|<hash>"). orphanImageKeys() says which stored pictures nothing uses any more.
 *
 * Pure: storage is handed in ({ getItem, setItem, removeItem }).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ViperAgencyWarrantList = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const IMG_REF = 'abimg:';
    const MAX_OUTPUTS = 20;
    const STATUSES = ['draft', 'created'];

    const indexKey = (caseId) => 'agencyBuilderWarrants_' + caseId;
    const formKey = (caseId, id) => 'agencyBuilderWarrant_' + caseId + '_' + id;
    const legacyKey = (caseId) => 'agencyBuilderDraft_' + caseId;
    const imagePrefix = (caseId, id) => caseId + '|' + id + '|';

    const str = (v) => (typeof v === 'string' ? v : '');
    const strArr = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
    const get = (s, k) => { try { return s.getItem(k); } catch (_) { return null; } };
    const set = (s, k, v) => { try { s.setItem(k, v); return true; } catch (_) { return false; } };
    const del = (s, k) => { try { s.removeItem(k); } catch (_) { /* ignore */ } };
    const parse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; } };

    function newId(now) {
        const t = (typeof now === 'number' ? now : Date.now()).toString(36);
        return 'aw' + t + Math.random().toString(36).slice(2, 8);
    }

    function normalizeEntry(e) {
        if (!e || typeof e !== 'object' || !/^[A-Za-z0-9_-]{1,64}$/.test(str(e.id))) return null;
        const outputs = (Array.isArray(e.outputs) ? e.outputs : [])
            .filter(o => o && typeof o.name === 'string' && o.name)
            .map(o => ({ name: o.name, path: str(o.path), at: str(o.at) }))
            .slice(-MAX_OUTPUTS);
        return {
            id: e.id,
            packId: str(e.packId),
            packName: str(e.packName),
            templateIds: strArr(e.templateIds),
            templateNames: strArr(e.templateNames),
            county: str(e.county),
            status: STATUSES.includes(e.status) ? e.status : 'draft',
            createdAt: str(e.createdAt),
            updatedAt: str(e.updatedAt) || str(e.createdAt),
            outputs,
        };
    }

    function readIndex(storage, caseId) {
        const v = parse(get(storage, indexKey(caseId)));
        return (Array.isArray(v) ? v : []).map(normalizeEntry).filter(Boolean);
    }
    function writeIndex(storage, caseId, list) {
        return set(storage, indexKey(caseId), JSON.stringify(list.map(normalizeEntry).filter(Boolean)));
    }

    // Newest first.
    function sorted(list) {
        return list.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    // Earlier versions kept one form per case. It becomes the first warrant in the list.
    function migrateLegacy(storage, caseId, opts) {
        opts = opts || {};
        const raw = get(storage, legacyKey(caseId));
        if (!raw) return { migrated: false };
        const draft = parse(raw);
        const list = readIndex(storage, caseId);
        const hasContent = draft && typeof draft === 'object'
            && ((Array.isArray(draft.templateIds) && draft.templateIds.length) || (draft.values && Object.keys(draft.values).length));
        if (!hasContent) { del(storage, legacyKey(caseId)); return { migrated: false }; }
        const at = str(draft.savedAt) || new Date(typeof opts.now === 'number' ? opts.now : Date.now()).toISOString();
        const id = opts.id || newId(opts.now);
        const entry = normalizeEntry({
            id, packId: str(draft.packId), packName: str(opts.packName), templateIds: strArr(draft.templateIds),
            templateNames: strArr(opts.templateNames), county: str(draft.county), status: 'draft',
            createdAt: at, updatedAt: at, outputs: [],
        });
        if (!set(storage, formKey(caseId, id), raw)) return { migrated: false };
        list.push(entry);
        if (!writeIndex(storage, caseId, list)) { del(storage, formKey(caseId, id)); return { migrated: false }; }
        del(storage, legacyKey(caseId));
        return { migrated: true, id };
    }

    // Insert or update one entry (by id) and save the list. Returns the saved entry.
    function upsert(storage, caseId, patch) {
        const list = readIndex(storage, caseId);
        const i = list.findIndex(e => e.id === patch.id);
        const merged = normalizeEntry(Object.assign({}, i >= 0 ? list[i] : { createdAt: patch.updatedAt }, patch));
        if (!merged) return null;
        if (i >= 0) list[i] = merged; else list.push(merged);
        writeIndex(storage, caseId, list);
        return merged;
    }

    function addOutputs(storage, caseId, id, files, at) {
        const list = readIndex(storage, caseId);
        const e = list.find(x => x.id === id);
        if (!e) return null;
        (files || []).forEach(f => { if (f && f.name) e.outputs.push({ name: String(f.name), path: str(f.path), at }); });
        e.outputs = e.outputs.slice(-MAX_OUTPUTS);
        e.status = 'created';
        e.updatedAt = at;
        writeIndex(storage, caseId, list);
        return e;
    }

    function remove(storage, caseId, id) {
        const list = readIndex(storage, caseId);
        const next = list.filter(e => e.id !== id);
        del(storage, formKey(caseId, id));
        if (next.length !== list.length) writeIndex(storage, caseId, next);
        return next.length !== list.length;
    }

    function readForm(storage, caseId, id) {
        const v = parse(get(storage, formKey(caseId, id)));
        return v && typeof v === 'object' ? v : null;
    }

    // "Residence Search" / "Residence Search + 2 more" / "Untitled warrant"
    function title(entry) {
        const names = entry.templateNames.length ? entry.templateNames : entry.templateIds.map(baseName);
        if (!names.length) return 'Untitled warrant';
        return names[0] + (names.length > 1 ? ` + ${names.length - 1} more` : '');
    }
    function baseName(id) {
        const s = String(id).split('/').pop();
        return s.replace(/\.docx$/i, '').replace(/[_\s]*template$/i, '');
    }

    // Picture ids referenced by a stored form (as "abimg:<id>").
    function referencedImages(json) {
        const out = [];
        const re = /"abimg:([^"\\]+)"/g;
        let m;
        while ((m = re.exec(String(json || '')))) out.push(m[1]);
        return out;
    }

    // Which stored picture keys of this case nothing uses any more: keys of warrants no longer in
    // the list, and old-style "<caseId>|<hash>" keys no form refers to.
    function orphanImageKeys(keys, caseId, liveIds, referenced) {
        const prefix = caseId + '|';
        const live = new Set(liveIds || []);
        const used = new Set(referenced || []);
        return (keys || []).filter(k => {
            if (typeof k !== 'string' || !k.startsWith(prefix)) return false;
            if (used.has(k)) return false;
            const rest = k.slice(prefix.length).split('|');
            if (rest.length < 2) return true;          // old-style key, unused
            return !live.has(rest[0]);                 // warrant gone
        });
    }

    return {
        IMG_REF, MAX_OUTPUTS, indexKey, formKey, legacyKey, imagePrefix, newId, normalizeEntry,
        readIndex, writeIndex, sorted, migrateLegacy, upsert, addOutputs, remove, readForm, title,
        referencedImages, orphanImageKeys,
    };
});
