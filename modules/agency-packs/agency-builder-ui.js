/*
 * modules/agency-packs/agency-builder-ui.js
 *
 * The agency Builder screen (Warrant Author tab → "Agency Templates"). Fills an
 * installed agency pack's own Word templates so the output is the agency's form,
 * word for word, with the officer's answers in it.
 *
 *   ViperAgencyBuilderUI.cachedAvailable()      → bool (a Builder pack was installed, last we knew)
 *   ViperAgencyBuilderUI.refreshAvailability()  → Promise<packs[]>, updates the cached flag
 *   ViperAgencyBuilderUI.mount(el, ctx)         → renders into el
 *       ctx: { caseId, caseNumber, currentCase, suspects[], getPcText(), offenseDescription, offenseDate, toast(msg, kind) }
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
    const draftKey = (caseId) => 'agencyBuilderDraft_' + caseId;

    const api = () => root.electronAPI || {};
    const RB = () => root.ViperRichBlocks;
    const CF = () => root.ViperAgencyCaseFacts;

    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const lsGet = (k) => { try { return root.localStorage.getItem(k); } catch (_) { return null; } };
    const lsSet = (k, v) => { try { root.localStorage.setItem(k, v); return true; } catch (_) { return false; } };
    const lsJson = (k, d) => { try { const v = JSON.parse(lsGet(k) || 'null'); return v == null ? d : v; } catch (_) { return d; } };
    const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    let S = null;          // state of the mounted Builder
    let saveTimer = null, nameTimer = null, richTimer = null;

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
            + '.ab-rich img{max-width:100%;height:auto}';
        d.head.appendChild(st);
    }

    async function mount(el, ctx) {
        if (!el) return;
        ensureStyles();
        ctx = ctx || {};
        S = {
            el, ctx, packs: [], packId: '', manifest: null, builder: null,
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
        const draft = ctx.caseId ? lsJson(draftKey(ctx.caseId), null) : null;
        const wanted = (draft && draft.packId) || lsGet(LS_LAST_PACK);
        const pick = packs.find(p => p.id === wanted) || packs[0];
        await loadPack(pick.id, draft && draft.packId === pick.id ? draft : null);
    }

    async function loadPack(id, draft) {
        const el = S.el;
        el.innerHTML = `<div class="text-sm text-gray-400 py-8 text-center">Loading agency templates…</div>`;
        const r = await api().agencyPackGet(id);
        if (S.el !== el) return;
        if (!r || !r.success) {
            el.innerHTML = `<div class="p-4 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm">
                Could not open the agency pack: ${esc((r && r.error) || 'unknown error')}.<br>
                <span class="text-gray-400">Reinstall it from Settings → Warrant Authoring → Agency template packs.</span></div>`;
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
            S.templateIds = (draft.templateIds || []).filter(t => known.has(t));
            S.values = draft.values && typeof draft.values === 'object' ? draft.values : {};
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

    function persist() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            if (!S || !S.ctx.caseId || !S.packId) return;
            const ok = lsSet(draftKey(S.ctx.caseId), JSON.stringify({
                packId: S.packId, templateIds: S.templateIds, values: S.values, county: S.county,
                overrides: S.overrides, touched: Array.from(S.touched), suspectIdx: S.suspectIdx, savedAt: new Date().toISOString(),
            }));
            if (!ok) toast('The form is too large to keep between visits (pictures). It will still build.', 'warning');
        }, 400);
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

    function renderAll() {
        const m = S.manifest || {};
        const packSelect = S.packs.length > 1
            ? `<select data-ab-pack class="${INPUT} !w-auto">${S.packs.map(p => `<option value="${esc(p.id)}" ${p.id === S.packId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
            : '';
        S.el.innerHTML = `
            <div class="space-y-4" data-ab-root>
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
            return fieldHtml(sf.key, sf.field.name, pm.type, pm.choices, `Used in ${docs.length} documents: ${docs.join(', ')}`);
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
                        return fieldHtml(B.fieldKeyForModelField(sec.templateId, f), f.customTitle || f.name, meta.type, meta.choices, '');
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
    function fieldHtml(key, label, type, choices, hint) {
        const B = S.builder;
        const kind = B.fieldKind(label, type);
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
        const hasCase = !!S.ctx.caseNumber;
        // Sticky to the top: the case page scrolls inside #tabContent, whose large bottom padding
        // would leave a bottom-sticky bar floating mid-screen. top:-2rem cancels its p-8 so nothing
        // scrolls by above the bar.
        return `<div class="${CARD} flex items-center gap-3 flex-wrap sticky z-20 backdrop-blur bg-viper-dark/90 shadow-lg" style="top:-2rem">
            <button data-ab-act="save-case" class="${BTN_ORANGE}" ${hasCase && !S.busy ? '' : 'disabled'}
                title="Save into this case's Working Documents (Warrants tab), protected like the rest of the case">Save to case</button>
            <button data-ab-act="save-as" class="${BTN_GHOST}" ${S.busy ? 'disabled' : ''} title="Save a copy anywhere (several documents are saved as one ZIP)">Save as…</button>
            <span data-ab-blanks class="text-xs ${blanks ? 'text-amber-300/90' : 'text-gray-500'}">${blanksText(blanks)}</span>
            ${S.busy ? '<span class="text-xs text-viper-cyan">Building…</span>' : ''}
        </div>`;
    }
    const blanksText = (n) => (n ? `${n} field${n === 1 ? '' : 's'} still empty — they stay as fill-in boxes in Word.` : 'Every field has an answer.');

    function countBlanks() {
        if (!S.model) return 0;
        const B = S.builder;
        let n = 0;
        const check = (key, label, type) => {
            const kind = B.fieldKind(label, type);
            if (kind === 'daterange') { if (!S.values[key + '::rangeStart'] && !S.values[key + '::rangeEnd']) n++; return; }
            if (kind === 'datetime') { if (!S.values[key + '::datetime']) n++; return; }
            if (kind === 'richtext') { if (!RB().hasContent(S.values[key])) n++; return; }
            if (isEmpty(S.values[key]) || (typeof S.values[key] === 'string' && !S.values[key].trim())) n++;
        };
        S.model.sharedFields.forEach(sf => check(sf.key, sf.field.name, sf.field.type));
        S.model.perTemplateSections.forEach(sec => sec.fields.forEach(f => check(B.fieldKeyForModelField(sec.templateId, f), f.customTitle || f.name, f.type)));
        return n;
    }

    function resultHtml() {
        const r = S.result;
        if (!r) return '';
        if (r.kind === 'case') {
            return `<div class="${CARD} border-emerald-500/40">
                <div class="text-sm text-emerald-300 font-semibold mb-2">Saved to this case (${r.saved.length}) — Warrants tab → Working Documents</div>
                <div class="space-y-1">${r.saved.map(f => `<div class="flex items-center gap-3 text-sm text-gray-200">
                    <span class="truncate">${esc(f)}</span>
                    <button data-ab-act="open-doc" data-file="${esc(f)}" class="${BTN_GHOST} !py-0.5 ml-auto shrink-0">Open in Word</button></div>`).join('')}</div></div>`;
        }
        if (r.kind === 'file') {
            return `<div class="${CARD} border-emerald-500/40 text-sm text-emerald-300">Saved ${r.count} document${r.count === 1 ? '' : 's'}${r.zipped ? ' as a ZIP' : ''}: <span class="text-gray-200">${esc(r.filePath)}</span></div>`;
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
            const b = e.target.closest('[data-ab-act]');
            if (!b || !S || S.el !== el) return;
            const act = b.getAttribute('data-ab-act');
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
            if (act === 'save-case') { build('case'); return; }
            if (act === 'save-as') { build('saveAs'); return; }
            if (act === 'blank') { build('blank'); return; }
            if (act === 'open-doc') {
                const f = b.getAttribute('data-file');
                Promise.resolve(api().workingDocOpen && api().workingDocOpen(S.ctx.caseNumber, f)).then(r => {
                    if (r && r.success === false) toast(r.error || 'Could not open the document.', 'error');
                });
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
            const files = Array.from(dt.files || []).filter(f => /^image\/(png|jpe?g)$/i.test(f.type));
            const html = dt.getData('text/html');
            if (!html && files.length) {
                e.preventDefault();
                files.forEach(f => {
                    const rd = new root.FileReader();
                    rd.onload = () => { root.document.execCommand('insertHTML', false, `<img src="${esc(rd.result)}" style="max-width:100%">`); captureRich(ed); };
                    rd.readAsDataURL(f);
                });
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
        S.busy = true; S.result = null; rerenderActions();
        let r;
        try {
            r = await fn({
                mode, packId: S.packId, templateIds: S.templateIds.slice(), values: S.values, county: S.county,
                overrides: S.overrides, caseNumber: S.ctx.caseNumber || '',
            });
        } catch (e) { r = { success: false, error: (e && e.message) || String(e) }; }
        S.busy = false;
        if (!r || !r.success) { rerenderActions(); toast((r && r.error) || 'Could not build the documents.', 'error'); return; }
        if (r.canceled) { rerenderActions(); return; }
        if (mode === 'case') {
            S.result = { kind: 'case', saved: r.saved || [] };
            toast(`Saved ${r.saved.length} document${r.saved.length === 1 ? '' : 's'} to the case.`, 'success');
            try { root.dispatchEvent(new root.CustomEvent('working-docs-changed', { detail: { caseNumber: S.ctx.caseNumber } })); } catch (_) { /* ignore */ }
        } else {
            S.result = { kind: 'file', filePath: r.filePath, count: r.count, zipped: r.zipped };
            toast(mode === 'blank' ? 'Blank forms saved.' : 'Documents saved.', 'success');
        }
        rerenderActions();
    }

    function rerenderActions() {
        const form = S.el.querySelector('[data-ab-form]');
        if (!form) return;
        const bar = form.querySelector('[data-ab-act="save-case"]');
        const card = bar && bar.parentElement;
        if (card) card.outerHTML = actionsHtml();
        const res = form.querySelector('[data-ab-result]');
        if (res) res.innerHTML = resultHtml();
        refreshNames();
    }

    root.ViperAgencyBuilderUI = { cachedAvailable, refreshAvailability, mount, _state: () => S };
})(typeof window !== 'undefined' ? window : this);
