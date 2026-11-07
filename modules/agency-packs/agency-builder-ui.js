/*
 * modules/agency-packs/agency-builder-ui.js
 *
 * The agency Builder screen (Warrant Author tab → "Agency Templates"). Fills an
 * installed agency pack's own Word templates so the output is the agency's form,
 * word for word, with the officer's answers in it.
 *
 * The tab opens on a list of the case's agency warrants (warrant-list.js); each
 * one is a saved form that can be reopened. "Create Word documents" writes the
 * filled .docx files into Downloads and marks the warrant created; it stays in
 * the list. (Status after that — served, returned — is tracked in the Warrants tab.)
 *
 *   ViperAgencyBuilderUI.cachedAvailable()      → bool (a Builder pack was installed, last we knew)
 *   ViperAgencyBuilderUI.refreshAvailability()  → Promise<packs[]>, updates the cached flag
 *   ViperAgencyBuilderUI.mount(el, ctx)         → renders into el
 *       ctx: { caseId, caseNumber, currentCase, suspects[], getPcText(), offenseDescription, offenseDate, toast(msg, kind) }
 *   ViperAgencyBuilderUI.newWarrant()           → opens an empty form (the tab's "New Warrant" button)
 *   ViperAgencyBuilderUI.showList()             → back to the list
 *
 * Field layout, autofill, county rules and filenames come from builder-model
 * (window.ViperAgencyBuilder); the documents themselves are built in the main
 * process from the installed pack (agencyPackBuild) — the renderer only sends
 * which templates, the answers, the county and any filename overrides.
 */
(function (root) {
    'use strict';

    const LS_FLAG = 'viperAgencyPackInstalled';
    const LS_PROFILE = 'viperAgencyBuilderProfile';
    const LS_LAST_PACK = 'viperAgencyBuilderLastPack';

    const api = () => root.electronAPI || {};
    const RB = () => root.ViperRichBlocks;
    const CF = () => root.ViperAgencyCaseFacts;
    const WL = () => root.ViperAgencyWarrantList;
    const LS = () => root.localStorage;

    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const lsGet = (k) => { try { return root.localStorage.getItem(k); } catch (_) { return null; } };
    const lsSet = (k, v) => { try { root.localStorage.setItem(k, v); return true; } catch (_) { return false; } };
    const lsJson = (k, d) => { try { const v = JSON.parse(lsGet(k) || 'null'); return v == null ? d : v; } catch (_) { return d; } };
    const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    let S = null;          // state of the mounted Builder
    let saveTimer = null, nameTimer = null, richTimer = null;
    let lastOpen = null;   // { caseId, id } — the warrant to reopen when the tab is shown again

    // ---- Availability ------------------------------------------------------------------------
    function cachedAvailable() { return lsGet(LS_FLAG) === 'true'; }

    async function builderPacks() {
        const fn = api().agencyPackList;
        if (typeof fn !== 'function') return [];
        const r = await fn();
        return (r && r.success && Array.isArray(r.packs) ? r.packs : []).filter(p => p && !p.error && p.kind === 'warrant-builder');
    }

    async function refreshAvailability() {
        // No pack API (older preload) → leave the flag alone rather than hide the tab.
        if (typeof api().agencyPackList !== 'function') return null;
        try {
            const packs = await builderPacks();
            lsSet(LS_FLAG, packs.length ? 'true' : 'false');
            return packs;
        } catch (_) { return []; }
    }

    // ---- Mount / load -------------------------------------------------------------------------
    function ensureStyles() {
        const d = root.document;
        if (!d || d.getElementById('abStyles')) return;
        const st = d.createElement('style');
        st.id = 'abStyles';
        st.textContent = '.ab-rich ul{list-style:disc;padding-left:1.6em;margin:.25em 0}.ab-rich ol{list-style:decimal;padding-left:1.6em;margin:.25em 0}'
            + '.ab-rich p{margin:0 0 .45em}.ab-rich table{border-collapse:collapse;margin:.4em 0}.ab-rich td,.ab-rich th{border:1px solid #4b5563;padding:2px 6px}'
            + '.ab-rich img{max-width:100%;height:auto}'
            + '.ab-rich img{max-height:240px;border-radius:6px;margin:4px 6px 4px 0;cursor:pointer;vertical-align:top}'
            + '.ab-rich img.ab-sel{outline:2px solid #22d3ee;outline-offset:2px}'
            + '.ab-drop-hot{border-color:#22d3ee !important;border-style:solid !important;background:rgba(34,211,238,.07)}'
            + '.ab-photo-ed:empty:before{content:attr(data-placeholder);color:#6b7280;pointer-events:none}';
        d.head.appendChild(st);
    }

    async function mount(el, ctx) {
        if (!el) return;
        ensureStyles();
        ctx = ctx || {};
        clearTimeout(saveTimer);
        S = {
            el, ctx, packs: [], packId: '', manifest: null, builder: null, view: 'list', warrantId: '',
            templateIds: [], values: {}, county: '', overrides: {}, touched: new Set(),
            search: '', openCats: new Set(), suspectIdx: 0, busy: false, result: null,
            pmCache: new Map(), model: null, profile: null,
        };
        wire(el);
        el.innerHTML = `<div class="text-sm text-gray-400 py-8 text-center">Loading agency templates…</div>`;
        let packs = [];
        try { packs = await refreshAvailability(); } catch (_) { packs = []; }
        if (S.el !== el) return;
        S.packs = packs;
        if (!packs.length) { el.innerHTML = emptyState(); return; }
        const caseId = ctx.caseId;
        if (caseId) {
            const legacy = (() => { try { return JSON.parse(LS().getItem(WL().legacyKey(caseId)) || 'null'); } catch (_) { return null; } })();
            const lp = legacy && packs.find(p => p.id === legacy.packId);
            WL().migrateLegacy(LS(), caseId, { packName: lp ? lp.name : '' });
            pruneImages(caseId);
        }
        const reopen = lastOpen && lastOpen.caseId === caseId && WL().readIndex(LS(), caseId).some(e => e.id === lastOpen.id) ? lastOpen.id : '';
        if (reopen) { await openWarrant(reopen); return; }
        showList();
    }

    // ---- The list of agency warrants ----------------------------------------------------------
    function entries() { return S && S.ctx.caseId ? WL().sorted(WL().readIndex(LS(), S.ctx.caseId)) : []; }
    function currentEntry() { return S && S.warrantId ? (WL().readIndex(LS(), S.ctx.caseId).find(e => e.id === S.warrantId) || null) : null; }

    async function showList() {
        if (!S) return;
        await flushPersist();
        S.view = 'list'; S.warrantId = ''; S.result = null; S.busy = false;
        lastOpen = null;
        S.el.innerHTML = listViewHtml();
    }

    async function newWarrant() {
        if (!S || !S.packs.length) return;
        await flushPersist();
        const wanted = lsGet(LS_LAST_PACK);
        const pick = S.packs.find(p => p.id === wanted) || S.packs[0];
        S.warrantId = WL().newId();
        S.view = 'edit'; S.result = null;
        lastOpen = { caseId: S.ctx.caseId, id: S.warrantId };
        await loadPack(pick.id, null);
    }

    async function openWarrant(id) {
        if (!S) return;
        await flushPersist();
        const caseId = S.ctx.caseId;
        const entry = WL().readIndex(LS(), caseId).find(e => e.id === id);
        if (!entry) { toast('That warrant is no longer in the list.', 'warning'); showList(); return; }
        const form = WL().readForm(LS(), caseId, id) || {};
        const packId = form.packId || entry.packId;
        if (!S.packs.some(p => p.id === packId)) {
            toast(`This warrant was made with ${entry.packName ? '“' + entry.packName + '”' : 'an agency pack'}, which is no longer installed. Reinstall it in Settings to open the warrant.`, 'error');
            return;
        }
        S.warrantId = id;
        S.view = 'edit'; S.result = null;
        lastOpen = { caseId, id };
        await loadPack(packId, form);
    }

    async function deleteWarrant(id) {
        if (!S) return;
        const e = WL().readIndex(LS(), S.ctx.caseId).find(x => x.id === id);
        if (!e) return;
        const outs = e.outputs.length ? ' Word documents already created in Downloads are not deleted.' : '';
        if (root.confirm && !root.confirm(`Delete “${WL().title(e)}” from this case?${outs}`)) return;
        WL().remove(LS(), S.ctx.caseId, id);
        try { await ImageStore.removePrefix(WL().imagePrefix(S.ctx.caseId, id)); } catch (_) { /* pruned next visit */ }
        if (lastOpen && lastOpen.id === id) lastOpen = null;
        if (S.view === 'list') S.el.innerHTML = listViewHtml();
        toast('Warrant deleted.', 'success');
    }

    // Drop stored pictures nothing uses any more (deleted warrants, the old one-form-per-case keys).
    async function pruneImages(caseId) {
        try {
            const list = WL().readIndex(LS(), caseId);
            const refs = [];
            list.forEach(e => { refs.push(...WL().referencedImages(LS().getItem(WL().formKey(caseId, e.id)))); });
            const keys = await ImageStore.keys();
            const dead = WL().orphanImageKeys(keys, caseId, list.map(e => e.id), refs);
            if (dead.length) await ImageStore.removeKeys(dead);
        } catch (_) { /* best effort */ }
    }

    async function loadPack(id, draft) {
        const el = S.el;
        el.innerHTML = `<div class="text-sm text-gray-400 py-8 text-center">Loading agency templates…</div>`;
        const r = await api().agencyPackGet(id);
        if (S.el !== el) return;
        if (!r || !r.success) {
            el.innerHTML = `<div class="p-4 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm">
                Could not open the agency pack: ${esc((r && r.error) || 'unknown error')}.<br>
                <span class="text-gray-400">Reinstall it from Settings → Warrant Authoring → Agency template packs.</span>
                <div class="mt-2"><button data-ab-act="back" class="text-xs text-viper-cyan hover:text-white">← All agency warrants</button></div></div>`;
            return;
        }
        const BM = root.ViperAgencyBuilder;
        S.packId = id;
        S.manifest = r.manifest;
        S.builder = BM.createBuilder(r.config, r.manifest.builder || {});
        S.pmCache = new Map();
        lsSet(LS_LAST_PACK, id);
        const known = new Set(S.builder.templates.map(t => t.id));
        if (draft) {
            const hydrated = await hydrateImages(draft.values && typeof draft.values === 'object' ? draft.values : {});
            if (S.el !== el) return;
            S.templateIds = (draft.templateIds || []).filter(t => known.has(t));
            S.values = S.builder.migrateValues(hydrated);
            S.county = typeof draft.county === 'string' ? draft.county : '';
            S.overrides = draft.overrides && typeof draft.overrides === 'object' ? draft.overrides : {};
            S.touched = new Set(Array.isArray(draft.touched) ? draft.touched : []);
            S.suspectIdx = Number.isInteger(draft.suspectIdx) ? draft.suspectIdx : 0;
        } else {
            S.templateIds = []; S.values = {}; S.county = ''; S.overrides = {}; S.touched = new Set(); S.suspectIdx = 0;
        }
        const suspects = S.ctx.suspects || [];
        if (S.suspectIdx >= suspects.length) S.suspectIdx = suspects.length ? 0 : -1;
        S.profile = CF().profileFrom(agencyProfile(), lsJson(LS_PROFILE, {}));
        renderAll();
    }

    function agencyProfile() {
        const raw = lsJson('viperAgencyProfile', {});
        const AP = root.WarrantAuthorAgencyProfile;
        return AP && typeof AP.normalize === 'function' ? AP.normalize(raw) : raw;
    }

    let persistSeq = 0;
    function persist() {
        clearTimeout(saveTimer);
        const st = S;
        saveTimer = setTimeout(() => { saveTimer = null; saveNow(st); }, 400);
    }
    // Write a pending save straight away (before leaving the form or building).
    function flushPersist() {
        if (!saveTimer) return Promise.resolve();
        clearTimeout(saveTimer); saveTimer = null;
        return saveNow(S);
    }

    async function saveNow(st) {
        if (!st || !st.ctx.caseId || !st.packId || !st.warrantId || st.view !== 'edit') return;
        const seq = ++persistSeq;
        const caseId = st.ctx.caseId, id = st.warrantId;
        const draft = {
            packId: st.packId, templateIds: st.templateIds.slice(), values: st.values, county: st.county,
            overrides: st.overrides, touched: Array.from(st.touched), suspectIdx: st.suspectIdx, savedAt: new Date().toISOString(),
        };
        const exists = WL().readIndex(LS(), caseId).some(e => e.id === id);
        // A new warrant joins the list once it has something in it.
        if (!exists && !draft.templateIds.length && !Object.keys(draft.values).length) return;
        // Pictures go to IndexedDB (localStorage is small and shared by the whole app); the
        // draft keeps a reference to each one.
        const prefix = WL().imagePrefix(caseId, id);
        const imgs = {};
        const slim = JSON.stringify(draft, (k, v) => {
            if (k === 'image' && typeof v === 'string' && v.startsWith('data:image/')) { const iid = imageId(prefix, v); imgs[iid] = v; return IMG_REF + iid; }
            return v;
        });
        let json = slim;
        try { await ImageStore.sync(prefix, imgs); } catch (_) { json = JSON.stringify(draft); }
        if (seq !== persistSeq) return;          // a newer save is on its way
        const ok = lsSet(WL().formKey(caseId, id), json);
        if (!ok) toast('The form is too large to keep between visits (pictures). It will still build.', 'warning');
        const B = st.builder;
        WL().upsert(LS(), caseId, {
            id, packId: st.packId, packName: (st.manifest && st.manifest.name) || '', county: st.county,
            templateIds: draft.templateIds,
            templateNames: draft.templateIds.map(t => { const x = B && B.getTemplate(t); return x ? x.displayName : t; }),
            updatedAt: draft.savedAt,
        });
    }

    // ---- Draft pictures (IndexedDB) -------------------------------------------------------------
    const IMG_REF = 'abimg:';
    function imageId(prefix, dataUrl) {
        // Two FNV-1a passes + length: stable per picture, so unchanged pictures aren't rewritten.
        let a = 0x811c9dc5, b = 0x2f8f1a7b;
        for (let i = 0; i < dataUrl.length; i++) {
            const c = dataUrl.charCodeAt(i);
            a = Math.imul(a ^ c, 0x01000193) >>> 0;
            b = Math.imul(b ^ c, 0x01000193 ^ 0x5bd1e995) >>> 0;
        }
        return `${prefix}${dataUrl.length.toString(36)}${a.toString(36)}${b.toString(36)}`;
    }

    const ImageStore = (() => {
        const DB = 'viperAgencyBuilder', STORE = 'draftImages';
        let dbp = null;
        const open = () => {
            if (dbp) return dbp;
            dbp = new Promise((res, rej) => {
                if (!root.indexedDB) { rej(new Error('IndexedDB unavailable')); return; }
                const r = root.indexedDB.open(DB, 1);
                r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error || new Error('IndexedDB open failed'));
            });
            dbp.catch(() => { dbp = null; });
            return dbp;
        };
        const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
            const t = db.transaction(STORE, mode);
            const out = fn(t.objectStore(STORE));
            t.oncomplete = () => res(out && 'result' in out ? out.result : out);
            t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted'));
        }));
        // Store one warrant's pictures and drop the ones its form no longer uses.
        async function sync(prefix, imgs) {
            const keys = await tx('readonly', st => st.getAllKeys());
            const have = new Set((keys || []).filter(k => typeof k === 'string' && k.startsWith(prefix)));
            const want = Object.keys(imgs);
            if (!want.length && !have.size) return;
            await tx('readwrite', st => {
                want.forEach(id => { if (!have.has(id)) st.put(imgs[id], id); });
                have.forEach(id => { if (!(id in imgs)) st.delete(id); });
            });
        }
        async function keys() { return (await tx('readonly', st => st.getAllKeys())) || []; }
        async function removeKeys(list) {
            if (!list.length) return;
            await tx('readwrite', st => { list.forEach(k => st.delete(k)); });
        }
        async function removePrefix(prefix) {
            const all = await keys();
            await removeKeys(all.filter(k => typeof k === 'string' && k.startsWith(prefix)));
        }
        async function getMany(ids) {
            const out = {};
            if (!ids.length) return out;
            await tx('readonly', st => { ids.forEach(id => { const r = st.get(id); r.onsuccess = () => { if (typeof r.result === 'string') out[id] = r.result; }; }); });
            return out;
        }
        return { sync, getMany, keys, removeKeys, removePrefix };
    })();

    // Put the pictures back into a loaded draft's answers (missing ones are dropped).
    async function hydrateImages(values) {
        if (!values || typeof values !== 'object') return {};
        const ids = [];
        JSON.stringify(values, (k, v) => { if (k === 'image' && typeof v === 'string' && v.startsWith(IMG_REF)) ids.push(v.slice(IMG_REF.length)); return v; });
        if (!ids.length) return values;
        let found = {};
        try { found = await ImageStore.getMany(Array.from(new Set(ids))); } catch (_) { found = {}; }
        const drop = (runs) => (Array.isArray(runs) ? runs.filter(r => !(r && r.image === null)) : runs);
        const out = JSON.parse(JSON.stringify(values), (k, v) => {
            if (k === 'image' && typeof v === 'string' && v.startsWith(IMG_REF)) return found[v.slice(IMG_REF.length)] || null;
            if (k === 'runs') return drop(v);
            return v;
        });
        return out;
    }

    function toast(msg, kind) {
        try {
            if (S && S.ctx && typeof S.ctx.toast === 'function') return S.ctx.toast(msg, kind);
            if (typeof root.showToast === 'function') return root.showToast(msg, kind);
        } catch (_) { /* ignore */ }
    }

    // ---- Rendering ---------------------------------------------------------------------------
    const btn = (cls) => `px-3 py-1.5 rounded-lg text-sm border transition disabled:opacity-40 disabled:cursor-not-allowed ${cls}`;
    const BTN_GHOST = btn('border-gray-600 text-gray-300 hover:bg-white/5');
    const BTN_CYAN = btn('border-viper-cyan/60 text-viper-cyan bg-viper-cyan/10 hover:bg-viper-cyan/20');
    const BTN_ORANGE = btn('border-viper-orange text-viper-orange bg-viper-orange/20 hover:bg-viper-orange/30 font-semibold');
    const INPUT = 'w-full bg-viper-dark border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:border-viper-cyan focus:outline-none';
    const CARD = 'rounded-xl border border-gray-700/60 bg-white/[0.02] p-4';

    function emptyState() {
        return `<div class="${CARD} text-center py-10">
            <div class="text-lg font-semibold text-white">No agency template pack installed</div>
            <p class="text-sm text-gray-400 mt-2 max-w-xl mx-auto">If your agency gave you a <span class="text-gray-200">.viperpack</span> file with its own warrant
            templates, install it in <span class="text-gray-200">Settings → Warrant Authoring → Agency template packs</span>. The templates then appear here,
            filled from this case.</p></div>`;
    }

    function shortDate(iso) {
        const d = new Date(iso || '');
        if (isNaN(d.getTime())) return '—';
        const today = new Date();
        if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
    }

    function statusBadge(status) {
        const e = status === 'created'
            ? { txt: 'CREATED', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' }
            : { txt: 'DRAFT', cls: 'bg-slate-500/20 text-slate-300 border-slate-500/40' };
        return `<span class="text-[10px] tracking-wider font-mono px-2 py-0.5 rounded border ${e.cls}">${e.txt}</span>`;
    }

    // Same look as the Warrant Author's own Drafts list.
    function listViewHtml() {
        const list = entries();
        const installed = new Set(S.packs.map(p => p.id));
        const newBtn = (label) => `<button data-ab-act="new-warrant"
            class="px-3 py-1.5 bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan/50 text-viper-cyan rounded text-xs flex items-center gap-1">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
            ${label}</button>`;
        if (!list.length) {
            return `<div class="wa-empty" data-ab-listview>
                <div class="wa-empty-title">No agency warrants yet</div>
                <div class="wa-empty-body">
                    Start a warrant on your agency's own forms. Answers are filled from this case, and the finished
                    warrant is created as a Word document in your Downloads folder.
                    <div class="mt-4 flex justify-center">${newBtn('New agency warrant')}</div>
                </div></div>`;
        }
        const rows = list.map(e => {
            const n = e.templateIds.length;
            const last = e.outputs.length ? e.outputs[e.outputs.length - 1] : null;
            const missing = e.packId && !installed.has(e.packId);
            const packBadge = `<span class="ml-1 px-1.5 py-0 bg-viper-cyan/10 text-viper-cyan border border-viper-cyan/30 rounded text-[10px] font-mono uppercase">Agency</span>`;
            return `
            <div class="wa-draft-row" data-ab-row="${esc(e.id)}">
                <div class="flex-1 min-w-0 cursor-pointer" data-ab-act="open-warrant" data-id="${esc(e.id)}">
                    <div class="flex items-center gap-2 mb-1">
                        ${statusBadge(e.status)}
                        <span class="text-white font-medium truncate">${esc(WL().title(e))}</span>
                        ${e.packName ? `<span class="text-slate-500 text-xs">·</span><span class="text-slate-400 text-xs truncate">${esc(e.packName)}</span>` : ''}
                        ${packBadge}
                        ${missing ? '<span class="text-[10px] text-rose-300">pack not installed</span>' : ''}
                    </div>
                    <div class="flex items-center gap-3 text-xs text-slate-400">
                        <span><span class="text-viper-cyan font-mono">${n}</span> document${n === 1 ? '' : 's'}</span>
                        ${e.county ? `<span class="truncate">${esc(e.county)}</span>` : ''}
                        ${last ? `<span class="truncate" title="${esc(last.name)}">Word: ${esc(last.name)}${e.outputs.length > 1 ? ` (+${e.outputs.length - 1})` : ''}</span>` : ''}
                        <span class="ml-auto text-slate-500 shrink-0">updated ${esc(shortDate(e.updatedAt))}</span>
                    </div>
                </div>
                <div class="flex items-center gap-1 pl-3">
                    <button data-ab-act="open-warrant" data-id="${esc(e.id)}"
                        class="px-2 py-1 text-xs bg-viper-cyan/15 hover:bg-viper-cyan/25 border border-viper-cyan/40 text-viper-cyan rounded">Open</button>
                    <button data-ab-act="delete-warrant" data-id="${esc(e.id)}" class="px-2 py-1 text-xs text-rose-300 hover:text-rose-200" title="Delete">✕</button>
                </div>
            </div>`;
        }).join('');
        return `<div class="space-y-3" data-ab-listview>
            <div class="flex items-center justify-between">
                <div class="text-xs text-slate-400"><span class="text-white font-mono">${list.length}</span> agency warrant${list.length === 1 ? '' : 's'}</div>
                ${newBtn('New agency warrant')}
            </div>
            <div class="space-y-2">${rows}</div>
        </div>`;
    }

    function renderAll() {
        const m = S.manifest || {};
        const packSelect = S.packs.length > 1
            ? `<select data-ab-pack class="${INPUT} !w-auto">${S.packs.map(p => `<option value="${esc(p.id)}" ${p.id === S.packId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
            : '';
        S.el.innerHTML = `
            <div class="space-y-4" data-ab-root>
                <button data-ab-act="back" class="text-xs text-viper-cyan hover:text-white flex items-center gap-1">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
                    All agency warrants</button>
                <div class="flex items-start justify-between flex-wrap gap-3">
                    <div>
                        <div class="text-lg font-semibold text-white">Agency templates</div>
                        <div class="text-xs text-gray-400 mt-0.5">${esc(m.name || '')}${m.packVersion ? ' · version ' + esc(m.packVersion) : ''} · ${S.builder.templates.length} templates.
                            Your agency's own forms, filled from this case. Review every document before it goes to the DA or a judge.</div>
                    </div>
                    <div class="flex items-center gap-2 flex-wrap">
                        ${packSelect}
                        <button data-ab-act="blank" class="${BTN_GHOST}" title="Save the selected templates unfilled">Blank forms…</button>
                        <button data-ab-act="clear" class="${BTN_GHOST}" title="Clear every answer on this form">Clear form</button>
                    </div>
                </div>
                <div class="grid gap-4 items-start" style="grid-template-columns: minmax(250px, 320px) minmax(0, 1fr)">
                    <aside class="${CARD} !p-3 space-y-3 sticky" style="top:-1.5rem; max-height: calc(100vh - 210px); overflow:auto">
                        <input data-ab-search type="search" placeholder="Search templates…" value="${esc(S.search)}" class="${INPUT}">
                        <div data-ab-chosen>${chosenHtml()}</div>
                        <div data-ab-list>${listHtml()}</div>
                    </aside>
                    <section data-ab-form class="space-y-4 min-w-0">${formHtml()}</section>
                </div>
            </div>`;
        refreshNames();
    }

    function chosenHtml() {
        if (!S.templateIds.length) return `<div class="text-xs text-gray-500">Tick the documents you need. Fields they share are asked once.</div>`;
        return `<div class="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Selected (${S.templateIds.length})</div>
            <div class="flex flex-wrap gap-1">${S.templateIds.map(id => {
                const t = S.builder.getTemplate(id);
                return `<span class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-viper-cyan/10 border border-viper-cyan/30 text-viper-cyan">
                    ${esc(t ? t.displayName : id)}<button data-ab-act="remove-tpl" data-tpl="${esc(id)}" class="hover:text-white" title="Remove">×</button></span>`;
            }).join('')}</div>`;
    }

    function listHtml() {
        const q = S.search.trim().toLowerCase();
        const chosen = new Set(S.templateIds);
        const groups = S.builder.categories().sort((a, b) => a.localeCompare(b)).map(cat => {
            const items = S.builder.templates.filter(t => t.category === cat && (!q || t.displayName.toLowerCase().includes(q)))
                .sort((a, b) => a.displayName.localeCompare(b.displayName));
            if (!items.length) return '';
            const picked = items.filter(t => chosen.has(t.id)).length;
            const open = q || S.openCats.has(cat);
            return `<details data-ab-cat="${esc(cat)}" ${open ? 'open' : ''} class="group">
                <summary class="cursor-pointer select-none text-sm text-gray-200 py-1 flex items-center justify-between">
                    <span>${esc(cat)}</span><span class="text-[11px] text-gray-500">${picked ? `<span class="text-viper-cyan">${picked}</span> / ` : ''}${items.length}</span></summary>
                <div class="pl-1 pb-1 space-y-0.5">${items.map(t => `
                    <label class="flex items-start gap-2 text-xs text-gray-300 hover:text-white cursor-pointer py-0.5">
                        <input type="checkbox" data-ab-tpl="${esc(t.id)}" ${chosen.has(t.id) ? 'checked' : ''} class="mt-0.5 accent-cyan-400">
                        <span>${esc(t.displayName)}</span></label>`).join('')}</div></details>`;
        }).join('');
        return groups || `<div class="text-xs text-gray-500">No template matches “${esc(S.search)}”.</div>`;
    }

    function mapping(tid) {
        if (!S.pmCache.has(tid)) S.pmCache.set(tid, S.builder.placeholderMapping(tid));
        return S.pmCache.get(tid);
    }

    function formHtml() {
        if (!S.templateIds.length) {
            return `<div class="${CARD} text-sm text-gray-400 py-10 text-center">Choose one or more templates on the left to start.</div>`;
        }
        const B = S.builder;
        S.model = B.formModel(S.templateIds);
        const shared = S.model.sharedFields.map(sf => {
            const a = sf.appliesTo[0];
            const pm = mapping(a.templateId)[a.placeholderName] || {};
            const docs = Array.from(new Set(sf.appliesTo.map(x => x.displayName)));
            return fieldHtml(sf.key, sf.field.name, pm.type, pm.choices,
                [sf.field.hint, `Used in ${docs.length} documents: ${docs.join(', ')}`].filter(Boolean).join(' — '), sf.field.kind);
        }).join('');
        const sections = S.model.perTemplateSections.map(sec => {
            if (!sec.fields.length) return '';
            const pm = mapping(sec.templateId);
            return `<div class="${CARD}">
                <div class="flex items-center justify-between mb-3"><div class="font-semibold text-white">${esc(sec.displayName)}</div>
                    <span class="text-[11px] text-gray-500">${esc(sec.category)}</span></div>
                <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))">
                    ${sec.fields.map(f => {
                        const meta = pm[f.name] || {};
                        return fieldHtml(B.fieldKeyForModelField(sec.templateId, f), f.customTitle || f.name, meta.type, meta.choices, f.hint || '', f.kind);
                    }).join('')}</div></div>`;
        }).join('');
        return `
            ${actionsHtml()}
            <div data-ab-result>${resultHtml()}</div>
            ${fillBarHtml()}
            ${profileHtml()}
            ${shared ? `<div class="${CARD}"><div class="font-semibold text-white mb-1">Shared details</div>
                <div class="text-xs text-gray-500 mb-3">Answered once, used in every selected document that asks for it.</div>
                <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))">${shared}</div></div>` : ''}
            ${sections}
            ${namesHtml()}`;
    }

    function fillBarHtml() {
        const suspects = S.ctx.suspects || [];
        const counties = S.builder.counties();
        const suspectSel = suspects.length
            ? `<label class="text-xs text-gray-400">Suspect
                <select data-ab-suspect class="${INPUT} mt-1">${suspects.map((s, i) => `<option value="${i}" ${i === S.suspectIdx ? 'selected' : ''}>${esc(CF().suspectLabel(s, i))}</option>`).join('')}
                <option value="-1" ${S.suspectIdx === -1 ? 'selected' : ''}>— none —</option></select></label>`
            : `<div class="text-xs text-gray-500 self-end pb-2">No suspects on this case yet.</div>`;
        const countySel = counties.length
            ? `<label class="text-xs text-gray-400">County / venue
                <select data-ab-county class="${INPUT} mt-1"><option value="">— choose —</option>
                ${counties.map(c => `<option value="${esc(c.label)}" ${c.label === S.county ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>`
            : '';
        const daNote = S.county && S.builder.removeDaApproval(S.county)
            ? `<div class="text-[11px] text-amber-300/90 mt-1">The DA “approved as to form” section is left off for ${esc(S.county)}.</div>` : '';
        return `<div class="${CARD}">
            <div class="grid gap-3 items-end" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))">
                ${suspectSel}
                <div>${countySel}${daNote}</div>
                <div class="flex gap-2"><button data-ab-act="fill" class="${BTN_CYAN}" title="Fill empty fields from the case, the suspect and your details">Fill from case</button></div>
            </div>
            <div class="text-[11px] text-gray-500 mt-2">Filling only ever writes into empty fields — nothing you typed is replaced.</div></div>`;
    }

    const PROFILE_LABELS = {
        name: 'Your name', badge: 'Badge #', title: 'Title / rank', agency: 'Agency', email: 'Email', phone: 'Phone',
        address: 'Agency address', signatureText: 'Signature line (printed name)', backgroundOfAffiant: 'Background of affiant (training & experience)',
    };
    function profileHtml() {
        const p = S.profile || {};
        const missing = ['name', 'badge', 'email', 'phone'].filter(k => !p[k]).length;
        return `<details class="${CARD}" data-ab-profile ${missing ? 'open' : ''}>
            <summary class="cursor-pointer select-none font-semibold text-white">Your details
                <span class="text-xs font-normal text-gray-500 ml-2">${missing ? `${missing} missing — ` : ''}used for the affiant fields; saved on this computer</span></summary>
            <div class="grid gap-3 mt-3" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))">
                ${CF().PROFILE_KEYS.filter(k => k !== 'backgroundOfAffiant').map(k => `<label class="text-xs text-gray-400">${esc(PROFILE_LABELS[k])}
                    <input data-ab-prof="${k}" value="${esc(p[k])}" class="${INPUT} mt-1"></label>`).join('')}
            </div>
            <label class="block text-xs text-gray-400 mt-3">${esc(PROFILE_LABELS.backgroundOfAffiant)}
                <textarea data-ab-prof="backgroundOfAffiant" rows="4" class="${INPUT} mt-1">${esc(p.backgroundOfAffiant)}</textarea></label>
        </details>`;
    }

    let fid = 0;
    function fieldHtml(key, label, type, choices, hint, explicitKind) {
        const B = S.builder;
        const kind = B.fieldKind(label, type, explicitKind);
        const id = 'abf' + (++fid);
        const v = S.values[key];
        const lab = `<label for="${id}" class="block text-xs text-gray-400 mb-1" ${hint ? `title="${esc(hint)}"` : ''}>${esc(label)}${hint ? ' <span class="text-viper-cyan/70">●</span>' : ''}</label>`;
        const k = esc(key);
        switch (kind) {
            case 'richtext': {
                const html = RB().toHtml(Array.isArray(v) ? v : (typeof v === 'string' ? v : []));
                const tb = (cmd, txt, title) => `<button type="button" data-ab-cmd="${cmd}" title="${title}" class="px-2 py-0.5 rounded hover:bg-white/10 text-gray-300">${txt}</button>`;
                return `<div style="grid-column: 1 / -1">${lab}
                    <div class="border border-gray-600 rounded-lg focus-within:border-viper-cyan">
                        <div class="flex gap-1 border-b border-gray-700 px-2 py-1 text-sm">
                            ${tb('bold', '<b>B</b>', 'Bold (Ctrl+B)')}${tb('italic', '<i>I</i>', 'Italic (Ctrl+I)')}${tb('underline', '<u>U</u>', 'Underline (Ctrl+U)')}
                            ${tb('insertUnorderedList', '• List', 'Bulleted list')}${tb('insertOrderedList', '1. List', 'Numbered list')}
                            <span class="ml-auto text-[11px] text-gray-500 self-center">Paste from Word keeps bold, italics, lists and tables; paste pictures on their own</span></div>
                        <div id="${id}" data-ab-rich="${k}" contenteditable="true" spellcheck="true"
                            class="ab-rich px-3 py-2 text-sm text-white min-h-[180px] max-h-[520px] overflow-auto focus:outline-none">${html}</div>
                    </div></div>`;
            }
            case 'photo': {
                const html = RB().toHtml(Array.isArray(v) ? v : (typeof v === 'string' ? v : []));
                return `<div style="grid-column: 1 / -1">${lab}
                    <div data-ab-dropzone class="border border-dashed border-gray-600 rounded-lg focus-within:border-viper-cyan transition-colors">
                        <div class="flex items-center gap-2 border-b border-gray-700 px-2 py-1 text-sm flex-wrap">
                            <button type="button" data-ab-act="add-photo" class="px-2 py-0.5 rounded border border-viper-cyan/40 text-viper-cyan hover:bg-viper-cyan/10">📷 Add photo…</button>
                            <span class="text-[11px] text-gray-500">or drag photos here, or paste one (Ctrl+V). Click a photo, then Delete to remove it.</span></div>
                        <div id="${id}" data-ab-rich="${k}" data-ab-photo contenteditable="true" spellcheck="true"
                            data-placeholder="Photos and/or a description"
                            class="ab-rich ab-photo-ed px-3 py-2 text-sm text-white min-h-[72px] max-h-[560px] overflow-auto focus:outline-none">${html}</div>
                    </div></div>`;
            }
            case 'long':
                return `<div style="grid-column: 1 / -1">${lab}<textarea id="${id}" data-ab-key="${k}" rows="5" class="${INPUT}">${esc(v)}</textarea></div>`;
            case 'date':
                return `<div>${lab}<input id="${id}" type="date" data-ab-key="${k}" value="${esc(v)}" class="${INPUT}"></div>`;
            case 'daterange':
                return `<div style="grid-column: span 2 / span 2">${lab}<div class="flex items-center gap-2">
                    <input id="${id}" type="date" data-ab-key="${k}" data-ab-part="rangeStart" value="${esc(S.values[key + '::rangeStart'])}" class="${INPUT}">
                    <span class="text-gray-500 text-xs">to</span>
                    <input type="date" data-ab-key="${k}" data-ab-part="rangeEnd" value="${esc(S.values[key + '::rangeEnd'])}" class="${INPUT}"></div></div>`;
            case 'datetime': {
                const tz = S.values[key + '::tz'] || B.defaultTimezone(label);
                return `<div>${lab}<div class="flex gap-2">
                    <input id="${id}" type="datetime-local" data-ab-key="${k}" data-ab-part="datetime" value="${esc(S.values[key + '::datetime'])}" class="${INPUT}">
                    <select data-ab-key="${k}" data-ab-part="tz" class="${INPUT} !w-auto">${B.timezones().map(t => `<option value="${esc(t.value)}" ${t.value === tz ? 'selected' : ''}>${esc(t.label || t.value)}</option>`).join('')}</select>
                    </div></div>`;
            }
            case 'dropdown': {
                const list = (choices || []).map(String);
                const cur = v == null ? '' : String(v);
                const extra = cur && !list.includes(cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : '';
                return `<div>${lab}<select id="${id}" data-ab-key="${k}" class="${INPUT}"><option value="">—</option>${extra}
                    ${list.map(c => `<option value="${esc(c)}" ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`;
            }
            default:
                return `<div>${lab}<input id="${id}" type="text" data-ab-key="${k}" value="${esc(v)}" class="${INPUT}"></div>`;
        }
    }

    function namesHtml() {
        return `<div class="${CARD}">
            <div class="font-semibold text-white mb-1">File names</div>
            <div class="text-xs text-gray-500 mb-3">Built from the case number, document type and key answers. Type over one to rename it.</div>
            <div class="space-y-2">${S.templateIds.map(id => {
                const t = S.builder.getTemplate(id);
                return `<div class="grid items-center gap-3" style="grid-template-columns: minmax(140px, 260px) 1fr">
                    <div class="text-xs text-gray-300 truncate" title="${esc(t.displayName)}">${esc(t.displayName)}</div>
                    <input data-ab-override="${esc(id)}" value="${esc(S.overrides[id] || '')}" class="${INPUT}" spellcheck="false"></div>`;
            }).join('')}</div></div>`;
    }

    function actionsHtml() {
        const blanks = countBlanks();
        const n = S.templateIds.length;
        // Sticky to the top: the case page scrolls inside #tabContent, whose large bottom padding
        // would leave a bottom-sticky bar floating mid-screen. top:-2rem cancels its p-8 so nothing
        // scrolls by above the bar.
        return `<div data-ab-actions class="${CARD} flex items-center gap-3 flex-wrap sticky z-20 backdrop-blur bg-viper-dark/90 shadow-lg" style="top:-2rem">
            <button data-ab-act="create" class="${BTN_ORANGE} flex items-center gap-1.5" ${S.busy ? 'disabled' : ''}
                title="Create the filled Word document${n === 1 ? '' : 's'} in your Downloads folder. The warrant stays in this list so you can come back to it.">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                Create Word document${n === 1 ? '' : 's'}</button>
            <span class="text-xs text-gray-500">Saved to Downloads</span>
            <span data-ab-blanks class="text-xs ${blanks ? 'text-amber-300/90' : 'text-gray-500'}">${blanksText(blanks)}</span>
            ${S.busy ? '<span class="text-xs text-viper-cyan">Creating…</span>' : ''}
        </div>`;
    }
    const blanksText = (n) => (n ? `${n} field${n === 1 ? '' : 's'} still empty — they stay as fill-in boxes in Word.` : 'Every field has an answer.');

    function countBlanks() {
        if (!S.model) return 0;
        const B = S.builder;
        let n = 0;
        const check = (key, label, type, explicitKind) => {
            const kind = B.fieldKind(label, type, explicitKind);
            if (kind === 'daterange') { if (!S.values[key + '::rangeStart'] && !S.values[key + '::rangeEnd']) n++; return; }
            if (kind === 'datetime') { if (!S.values[key + '::datetime']) n++; return; }
            if (kind === 'richtext' || kind === 'photo') { if (!RB().hasContent(S.values[key])) n++; return; }
            if (isEmpty(S.values[key]) || (typeof S.values[key] === 'string' && !S.values[key].trim())) n++;
        };
        S.model.sharedFields.forEach(sf => check(sf.key, sf.field.name, sf.field.type, sf.field.kind));
        S.model.perTemplateSections.forEach(sec => sec.fields.forEach(f => check(B.fieldKeyForModelField(sec.templateId, f), f.customTitle || f.name, f.type, f.kind)));
        return n;
    }

    function outputRows(files) {
        return files.map(f => `<div class="flex items-center gap-2 text-sm text-gray-200">
            <svg class="w-4 h-4 text-sky-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            <span class="truncate" title="${esc(f.path || f.name)}">${esc(f.name)}</span>
            <span class="ml-auto flex items-center gap-1 shrink-0">
                <button data-ab-act="open-out" data-path="${esc(f.path)}" class="${BTN_CYAN} !py-0.5 !text-xs" ${f.path ? '' : 'disabled'}>Open in Word</button>
                <button data-ab-act="show-out" data-path="${esc(f.path)}" class="${BTN_GHOST} !py-0.5 !text-xs" ${f.path ? '' : 'disabled'}>Show in folder</button>
            </span></div>`).join('');
    }

    function resultHtml() {
        const r = S.result;
        if (r && r.kind === 'downloads') {
            return `<div class="${CARD} border-emerald-500/40">
                <div class="text-sm text-emerald-300 font-semibold mb-2">Created ${r.files.length} Word document${r.files.length === 1 ? '' : 's'} in Downloads</div>
                <div class="space-y-1.5">${outputRows(r.files)}</div>
                <div class="text-xs text-gray-500 mt-2">The warrant stays in the Agency Templates list — open it again any time to change answers and create new copies.</div></div>`;
        }
        if (r && r.kind === 'file') {
            return `<div class="${CARD} border-emerald-500/40 text-sm text-emerald-300">Saved ${r.count} document${r.count === 1 ? '' : 's'}${r.zipped ? ' as a ZIP' : ''}: <span class="text-gray-200">${esc(r.filePath)}</span></div>`;
        }
        // Coming back to a warrant: show what was created last time.
        const e = currentEntry();
        if (e && e.outputs.length) {
            const lastAt = e.outputs[e.outputs.length - 1].at;
            const batch = e.outputs.filter(o => o.at === lastAt);
            return `<div class="${CARD}">
                <div class="text-xs uppercase tracking-wider text-gray-500 mb-2">Last created ${esc(shortDate(lastAt))}</div>
                <div class="space-y-1.5">${outputRows(batch)}</div></div>`;
        }
        return '';
    }

    function rerenderForm() {
        const host = S.el.querySelector('[data-ab-form]');
        if (host) host.innerHTML = formHtml();
        const chosen = S.el.querySelector('[data-ab-chosen]');
        if (chosen) chosen.innerHTML = chosenHtml();
        refreshNames();
    }
    function rerenderList() {
        const host = S.el.querySelector('[data-ab-list]');
        if (host) host.innerHTML = listHtml();
    }

    // Auto filenames shown as placeholders; recomputed as answers change.
    function refreshNames() {
        if (!S || !S.templateIds.length) return;
        const B = S.builder;
        const ctx = { ids: S.templateIds, values: S.values, county: S.county };
        S.el.querySelectorAll('[data-ab-override]').forEach(inp => {
            const id = inp.getAttribute('data-ab-override');
            const t = B.getTemplate(id);
            if (!t) return;
            try { inp.placeholder = B.autoOutputFilename(t, B.resolveValues(t, S.values).values, ctx); } catch (_) { /* ignore */ }
        });
        const bl = S.el.querySelector('[data-ab-blanks]');
        if (bl) {
            const n = countBlanks();
            bl.textContent = blanksText(n);
            bl.className = 'text-xs ' + (n ? 'text-amber-300/90' : 'text-gray-500');
        }
    }
    const refreshNamesSoon = () => { clearTimeout(nameTimer); nameTimer = setTimeout(refreshNames, 250); };

    // ---- Autofill ----------------------------------------------------------------------------
    function factsFor(idx) {
        const ctx = S.ctx;
        const suspects = ctx.suspects || [];
        let pcText = '';
        try { pcText = typeof ctx.getPcText === 'function' ? (ctx.getPcText() || '') : ''; } catch (_) { pcText = ''; }
        return CF().fromCase({
            currentCase: ctx.currentCase || { caseNumber: ctx.caseNumber },
            suspect: idx >= 0 ? suspects[idx] : null,
            pcText, offenseDescription: ctx.offenseDescription, offenseDate: ctx.offenseDate,
        });
    }

    // Fills empty fields. respectTouched: a field the officer emptied on purpose stays empty.
    function autofill(respectTouched) {
        if (!S.model) S.model = S.builder.formModel(S.templateIds);
        const B = S.builder;
        const held = [];
        if (respectTouched) S.touched.forEach(k => { if (isEmpty(S.values[k])) { S.values[k] = '\u0000held'; held.push(k); } });
        const before = Object.keys(S.values).filter(k => !isEmpty(S.values[k])).length;
        B.applyProfile(S.model, S.values, S.profile || {});
        B.applyCaseFacts(S.model, S.values, factsFor(S.suspectIdx));
        if (S.county) {
            // Venue fields follow the chosen county (only where still empty).
            const tmp = B.applyCounty(S.county, S.templateIds, {});
            Object.keys(tmp).forEach(k => { if (isEmpty(S.values[k])) S.values[k] = tmp[k]; });
        }
        held.forEach(k => { delete S.values[k]; });
        return Object.keys(S.values).filter(k => !isEmpty(S.values[k])).length - before;
    }

    // Switching suspect: answers that came from the previous suspect follow the new one.
    function switchSuspect(idx) {
        const B = S.builder;
        if (!S.model) S.model = B.formModel(S.templateIds);
        const oldVals = B.applyCaseFacts(S.model, {}, factsFor(S.suspectIdx));
        Object.keys(oldVals).forEach(k => { if (same(S.values[k], oldVals[k])) { delete S.values[k]; S.touched.delete(k); } });
        S.suspectIdx = idx;
        autofill(true);
    }

    // ---- Events ------------------------------------------------------------------------------
    function wire(el) {
        if (el.__abWired) return;
        el.__abWired = true;

        el.addEventListener('click', (e) => {
            // Clicking a picture in an editor selects it, so Delete / Backspace removes it.
            const img = e.target && e.target.tagName === 'IMG' && e.target.closest('[data-ab-rich]') ? e.target : null;
            el.querySelectorAll('.ab-rich img.ab-sel').forEach(i => { if (i !== img) i.classList.remove('ab-sel'); });
            if (img) {
                try {
                    const sel = root.getSelection(), r = root.document.createRange();
                    r.selectNode(img); sel.removeAllRanges(); sel.addRange(r);
                } catch (_) { /* ignore */ }
                img.classList.add('ab-sel');
                return;
            }
            const b = e.target.closest('[data-ab-act]');
            if (!b || !S || S.el !== el) return;
            const act = b.getAttribute('data-ab-act');
            if (act === 'add-photo') {
                const zone = b.closest('[data-ab-dropzone]');
                const ed = zone && zone.querySelector('[data-ab-rich]');
                if (ed) pickPhotos(ed);
                return;
            }
            if (act === 'remove-tpl') { setTemplate(b.getAttribute('data-tpl'), false); return; }
            if (act === 'fill') {
                const n = autofill(false);
                rerenderForm(); persist();
                toast(n ? `Filled ${n} field${n === 1 ? '' : 's'} from the case.` : 'Nothing new to fill — the case has no more answers for the empty fields.', n ? 'success' : 'info');
                return;
            }
            if (act === 'clear') {
                if (!root.confirm || root.confirm('Clear every answer on this form? The template selection is kept.')) {
                    S.values = {}; S.overrides = {}; S.touched = new Set(); S.county = ''; S.result = null;
                    rerenderForm(); persist();
                }
                return;
            }
            if (act === 'new-warrant') { newWarrant(); return; }
            if (act === 'open-warrant') { openWarrant(b.getAttribute('data-id')); return; }
            if (act === 'delete-warrant') { deleteWarrant(b.getAttribute('data-id')); return; }
            if (act === 'back') { showList(); return; }
            if (act === 'create') { build('downloads'); return; }
            if (act === 'blank') { build('blank'); return; }
            if (act === 'open-out' || act === 'show-out') {
                const p = b.getAttribute('data-path');
                const fn = api().agencyPackOpenOutput;
                if (!p) return;
                if (typeof fn !== 'function') { toast('Restart VIPER to finish installing the agency Builder.', 'error'); return; }
                Promise.resolve(fn({ path: p, action: act === 'show-out' ? 'show' : 'open' })).then(r => {
                    if (r && r.success === false) toast(r.error || 'Could not open the document.', 'error');
                }, () => toast('Could not open the document.', 'error'));
            }
        });

        el.addEventListener('mousedown', (e) => {
            const b = e.target.closest('[data-ab-cmd]');
            if (!b) return;
            e.preventDefault();     // keep the editor's selection
            try { root.document.execCommand(b.getAttribute('data-ab-cmd'), false, null); } catch (_) { /* ignore */ }
            const ed = b.closest('.border') && b.closest('.border').querySelector('[data-ab-rich]');
            if (ed) captureRich(ed);
        });

        el.addEventListener('input', (e) => {
            if (!S || S.el !== el) return;
            const t = e.target;
            if (t.matches('[data-ab-search]')) { S.search = t.value; rerenderList(); return; }
            if (t.matches('[data-ab-rich]')) { clearTimeout(richTimer); richTimer = setTimeout(() => captureRich(t), 200); return; }
            if (t.matches('[data-ab-override]')) {
                const id = t.getAttribute('data-ab-override');
                if (t.value.trim()) S.overrides[id] = t.value; else delete S.overrides[id];
                persist(); return;
            }
            if (t.matches('[data-ab-prof]')) { setProfile(t.getAttribute('data-ab-prof'), t.value); return; }
            if (t.matches('input[type="text"][data-ab-key], textarea[data-ab-key]')) { setValue(t); }
        });

        el.addEventListener('change', (e) => {
            if (!S || S.el !== el) return;
            const t = e.target;
            if (t.matches('[data-ab-tpl]')) { setTemplate(t.getAttribute('data-ab-tpl'), t.checked); return; }
            if (t.matches('[data-ab-pack]')) { loadPack(t.value, null); return; }
            if (t.matches('[data-ab-suspect]')) { switchSuspect(Number(t.value)); rerenderForm(); persist(); return; }
            if (t.matches('[data-ab-county]')) {
                S.county = t.value;
                if (S.county) S.builder.applyCounty(S.county, S.templateIds, S.values);   // a deliberate pick overwrites
                rerenderForm(); persist(); return;
            }
            if (t.matches('[data-ab-key]')) setValue(t);
        });

        // Remember which categories are open.
        el.addEventListener('toggle', (e) => {
            const d = e.target;
            if (!S || !d || !d.matches || !d.matches('[data-ab-cat]') || S.search.trim()) return;
            const c = d.getAttribute('data-ab-cat');
            if (d.open) S.openCats.add(c); else S.openCats.delete(c);
        }, true);

        // Paste into the rich editor: keep only what Word needs.
        el.addEventListener('paste', (e) => {
            const ed = e.target.closest && e.target.closest('[data-ab-rich]');
            if (!ed) return;
            const dt = e.clipboardData;
            if (!dt) return;
            const files = Array.from(dt.files || []).filter(f => /^image\//i.test(f.type || ''));
            const html = dt.getData('text/html');
            // A copied picture often comes with a bit of HTML wrapping it; with no words in that
            // HTML, the picture itself is what was meant.
            const htmlHasWords = !!html && !!String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|\s+/g, '').length;
            if (files.length && !htmlHasWords) {
                e.preventDefault();
                insertImages(ed, files);
                return;
            }
            if (html) {
                e.preventDefault();
                const doc = new root.DOMParser().parseFromString(html, 'text/html');
                const clean = RB().toHtml(RB().fromNode(doc.body));
                root.document.execCommand('insertHTML', false, clean);
                captureRich(ed);
            }
        });

        // Drag photos onto a field (photo fields and the probable-cause editor).
        const dropTarget = (e) => {
            const t = e.target && e.target.closest ? e.target : null;
            if (!t) return null;
            const zone = t.closest('[data-ab-dropzone]');
            const ed = (zone && zone.querySelector('[data-ab-rich]')) || t.closest('[data-ab-rich]');
            return ed ? { ed, box: zone || ed.closest('.border') || ed } : null;
        };
        const hasFiles = (dt) => !!dt && Array.from(dt.types || []).includes('Files');
        let hot = null;
        const setHot = (box) => { if (hot === box) return; if (hot) hot.classList.remove('ab-drop-hot'); hot = box; if (hot) hot.classList.add('ab-drop-hot'); };
        el.addEventListener('dragover', (e) => {
            if (!hasFiles(e.dataTransfer)) return;
            const d = dropTarget(e);
            if (!d) { setHot(null); return; }
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setHot(d.box);
        });
        el.addEventListener('dragleave', (e) => {
            if (hot && (!e.relatedTarget || !hot.contains(e.relatedTarget))) setHot(null);
        });
        el.addEventListener('drop', (e) => {
            setHot(null);
            if (!hasFiles(e.dataTransfer)) return;
            const d = dropTarget(e);
            if (!d) return;
            e.preventDefault();
            e.stopPropagation();
            const all = Array.from(e.dataTransfer.files || []);
            const imgs = all.filter(f => /^image\//i.test(f.type || '') || /\.(jpe?g|png|gif|bmp|webp)$/i.test(f.name || ''));
            if (!imgs.length) { toast('Only pictures (JPG, PNG and the like) can go in this field.', 'warning'); return; }
            if (imgs.length < all.length) toast(`${all.length - imgs.length} file${all.length - imgs.length === 1 ? ' was' : 's were'} not a picture and ${all.length - imgs.length === 1 ? 'was' : 'were'} skipped.`, 'warning');
            placeCaretAtPoint(d.ed, e.clientX, e.clientY);
            insertImages(d.ed, imgs);
        });
    }

    // ---- Pictures ------------------------------------------------------------------------------
    const MAX_IMAGE_SIDE = 1600;                 // ≈290 dpi at the 5.5in width Word gets
    const KEEP_PNG_BYTES = 1.5 * 1024 * 1024;

    function pickPhotos(ed) {
        const d = root.document;
        const inp = d.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
        inp.style.display = 'none';
        inp.addEventListener('change', () => {
            const files = Array.from(inp.files || []);
            inp.remove();
            if (files.length) insertImages(ed, files);
        });
        d.body.appendChild(inp);
        inp.click();
    }

    function placeCaretAtPoint(ed, x, y) {
        try {
            const d = root.document;
            const r = d.caretRangeFromPoint ? d.caretRangeFromPoint(x, y) : null;
            if (r && ed.contains(r.startContainer)) {
                const sel = root.getSelection(); sel.removeAllRanges(); sel.addRange(r);
            }
        } catch (_) { /* ignore */ }
    }

    const readDataUrl = (file) => new Promise((res, rej) => {
        const rd = new root.FileReader();
        rd.onload = () => res(String(rd.result || ''));
        rd.onerror = () => rej(rd.error || new Error('read failed'));
        rd.readAsDataURL(file);
    });
    const loadImg = (src) => new Promise((res, rej) => {
        const im = new root.Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('not a picture this computer can read'));
        im.src = src;
    });

    // Any picture the browser can read → a PNG/JPEG data URL Word can embed: phone photos are
    // turned upright and shrunk to MAX_IMAGE_SIDE; small PNGs (screenshots) are kept as they are.
    async function normalizeImage(file) {
        const type = String(file.type || '').toLowerCase();
        const src = await readDataUrl(file);
        const im = await loadImg(src);
        const w = im.naturalWidth, h = im.naturalHeight;
        if (!w || !h) throw new Error('empty picture');
        if (type === 'image/png' && Math.max(w, h) <= MAX_IMAGE_SIDE && (file.size || 0) <= KEEP_PNG_BYTES
            && /^data:image\/png;base64,/i.test(src)) return src;
        const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        const c = root.document.createElement('canvas');
        c.width = cw; c.height = ch;
        const g = c.getContext('2d');
        const png = type === 'image/png' || type === 'image/gif' || type === 'image/bmp';
        if (png) {
            g.drawImage(im, 0, 0, cw, ch);
            const out = c.toDataURL('image/png');
            if (out.length <= 3 * 1024 * 1024) return out;
        }
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, cw, ch);   // JPEG has no transparency
        g.drawImage(im, 0, 0, cw, ch);
        return c.toDataURL('image/jpeg', 0.88);
    }

    async function insertImages(ed, files) {
        const list = Array.from(files || []);
        if (!list.length) return;
        const urls = [], bad = [];
        for (const f of list) {
            try { urls.push(await normalizeImage(f)); } catch (_) { bad.push(f.name || 'picture'); }
        }
        if (bad.length) toast(`Could not read ${bad.length === 1 ? `"${bad[0]}"` : bad.length + ' pictures'} — save ${bad.length === 1 ? 'it' : 'them'} as JPG or PNG and try again.`, 'warning');
        if (!urls.length || !ed.isConnected) return;
        insertImageLines(ed, urls);
        captureRich(ed);
        if (urls.length) toast(`Added ${urls.length} photo${urls.length === 1 ? '' : 's'}.`, 'success');
    }

    // Each picture gets a line of its own right after the line the caret is on (end of the field
    // when the caret is elsewhere), so a drop never splits a word. An empty line is reused.
    function insertImageLines(ed, urls) {
        const d = root.document;
        const isBlock = (n) => n && n.nodeType === 1 && /^(P|DIV|UL|OL|TABLE|H[1-6]|BLOCKQUOTE|PRE)$/.test(n.nodeName);
        const isEmptyLine = (n) => isBlock(n) && /^(P|DIV)$/.test(n.nodeName) && !n.textContent.trim() && !n.querySelector('img,table,ul,ol');
        const sel = root.getSelection();
        let anchor = null;
        if (sel && sel.rangeCount && ed.contains(sel.getRangeAt(0).startContainer)) {
            const r = sel.getRangeAt(0);
            if (r.startContainer === ed) anchor = ed.childNodes[Math.max(0, r.startOffset - 1)] || null;
            else { anchor = r.startContainer; while (anchor && anchor.parentNode !== ed) anchor = anchor.parentNode; }
        } else anchor = ed.lastChild;
        if (anchor && !isBlock(anchor)) {   // a bare line of text: walk to its end
            while (anchor.nodeName !== 'BR' && anchor.nextSibling && !isBlock(anchor.nextSibling)) anchor = anchor.nextSibling;
        }
        const lines = urls.map(u => { const p = d.createElement('p'); const im = d.createElement('img'); im.src = u; im.style.maxWidth = '100%'; p.appendChild(im); return p; });
        let first = 0;
        if (anchor && isEmptyLine(anchor)) { anchor.replaceWith(lines[0]); anchor = lines[0]; first = 1; }
        for (let i = first; i < lines.length; i++) {
            if (anchor) anchor.after(lines[i]); else ed.insertBefore(lines[i], ed.firstChild);
            anchor = lines[i];
        }
        try {
            ed.focus();
            const r = d.createRange(); r.setStartAfter(lines[lines.length - 1]); r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
        } catch (_) { /* ignore */ }
    }

    function captureRich(ed) {
        if (!S) return;
        const key = ed.getAttribute('data-ab-rich');
        const blocks = RB().fromNode(ed);
        if (RB().hasContent(blocks)) S.values[key] = blocks; else delete S.values[key];
        S.touched.add(key);
        persist(); refreshNamesSoon();
    }

    function setValue(t) {
        const key = t.getAttribute('data-ab-key');
        const part = t.getAttribute('data-ab-part');
        const k = part ? key + '::' + part : key;
        if (t.value === '' && part !== 'tz') delete S.values[k]; else S.values[k] = t.value;
        S.touched.add(k);
        persist(); refreshNamesSoon();
    }

    function setProfile(k, v) {
        S.profile[k] = v;
        const saved = lsJson(LS_PROFILE, {});
        saved[k] = v;
        lsSet(LS_PROFILE, JSON.stringify(saved));
    }

    function setTemplate(id, on) {
        if (!S.builder.getTemplate(id)) return;
        const has = S.templateIds.includes(id);
        if (on && !has) S.templateIds.push(id);
        if (!on && has) { S.templateIds = S.templateIds.filter(x => x !== id); delete S.overrides[id]; }
        S.result = null;
        S.model = S.templateIds.length ? S.builder.formModel(S.templateIds) : null;
        if (on && S.templateIds.length) autofill(true);
        rerenderForm(); rerenderList(); persist();
    }

    // ---- Build -------------------------------------------------------------------------------
    async function build(mode) {
        if (!S || S.busy) return;
        if (!S.templateIds.length) { toast('Choose at least one template first.', 'warning'); return; }
        const fn = api().agencyPackBuild;
        if (typeof fn !== 'function') { toast('Restart VIPER to finish installing the agency Builder.', 'error'); return; }
        // Take the latest editor contents even if the debounce has not fired yet.
        S.el.querySelectorAll('[data-ab-rich]').forEach(ed => captureRich(ed));
        if (mode !== 'blank') await flushPersist();          // the warrant is in the list before its files exist
        const st = S;
        const warrantRef = { caseId: S.ctx.caseId, id: S.warrantId };
        S.busy = true; S.result = null; rerenderActions();
        let r;
        try {
            r = await fn({
                mode, packId: S.packId, templateIds: S.templateIds.slice(), values: S.values, county: S.county,
                overrides: S.overrides, caseNumber: S.ctx.caseNumber || '',
            });
        } catch (e) { r = { success: false, error: (e && e.message) || String(e) }; }
        // Record the files even if the officer has already gone back to the list.
        if (mode === 'downloads' && r && r.success && !r.canceled && warrantRef.caseId && warrantRef.id) {
            WL().addOutputs(LS(), warrantRef.caseId, warrantRef.id, Array.isArray(r.files) ? r.files : [], new Date().toISOString());
        }
        if (S !== st || S.view !== 'edit' || S.warrantId !== warrantRef.id) {
            if (S === st && S.view === 'list') S.el.innerHTML = listViewHtml();
            return;
        }
        S.busy = false;
        if (!r || !r.success) { rerenderActions(); toast((r && r.error) || 'Could not build the documents.', 'error'); return; }
        if (r.canceled) { rerenderActions(); return; }
        if (mode === 'downloads') {
            const files = Array.isArray(r.files) ? r.files : [];
            S.result = { kind: 'downloads', files };
            toast(`Created ${files.length} Word document${files.length === 1 ? '' : 's'} in Downloads.`, 'success');
        } else {
            S.result = { kind: 'file', filePath: r.filePath, count: r.count, zipped: r.zipped };
            toast(mode === 'blank' ? 'Blank forms saved.' : 'Documents saved.', 'success');
        }
        rerenderActions();
    }

    function rerenderActions() {
        const form = S.el.querySelector('[data-ab-form]');
        if (!form) return;
        const card = form.querySelector('[data-ab-actions]');
        if (card) card.outerHTML = actionsHtml();
        const res = form.querySelector('[data-ab-result]');
        if (res) res.innerHTML = resultHtml();
        refreshNames();
    }

    root.ViperAgencyBuilderUI = { cachedAvailable, refreshAvailability, mount, newWarrant, showList, _state: () => S };
})(typeof window !== 'undefined' ? window : this);
