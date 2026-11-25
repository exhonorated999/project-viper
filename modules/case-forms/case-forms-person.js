/**
 * modules/case-forms/case-forms-person.js — the "Forms" button on a suspect,
 * victim, witness or involved-person page.
 *
 * Tick the agency forms wanted for this person; VIPER puts the person on each
 * form (in the slot meant for their role), fills the rest from the case the
 * same way the Forms tab does, and opens every filled PDF in the PDF viewer
 * to print or change. Optionally a copy goes into the case's Forms folder.
 *
 *   window.ViperCaseFormsPerson.open({ listKey, index, ctx })
 *     listKey: 'suspects' | 'victims' | 'witnesses' | 'involvedPersons'
 *     ctx: the Forms tab context ({ caseId, caseNumber, currentCase, getStores,
 *          offenseDescription, toast })
 *
 * The pure helpers at the top also load under node for tests.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root && root.document) root.ViperCaseFormsPerson = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const Tab = () => (root && root.ViperCaseFormsTab) || require('./case-forms-tab.js');
    const Sources = () => (root && root.ViperCaseFormSources) || require('./form-sources.js');

    const ROLE_OF = { suspects: 'suspect', victims: 'victim', witnesses: 'witness', involvedPersons: 'involved' };
    const ROLE_LABEL = { suspect: 'suspect', victim: 'victim', witness: 'witness', involved: 'involved person' };
    const NOBODY = '\u0000none';   // a role nobody has

    /* ── Pure helpers ─────────────────────────────────────────────────── */

    const hasRoles = (s) => Array.isArray(s && s.roles) && s.roles.length > 0;

    /** Which person slot this person goes in: one meant for their role, else an open one, else the first. */
    function slotForPerson(slots, role) {
        const list = Array.isArray(slots) ? slots : [];
        const m = list.find(s => hasRoles(s) && s.roles.includes(role));
        if (m) return m.id;
        const o = list.find(s => !hasRoles(s));
        if (o) return o.id;
        return list[0] ? list[0].id : null;
    }

    /**
     * How well a form suits this person:
     *   'match' — a slot is meant for their role
     *   'open'  — a slot takes anybody (consent forms)
     *   'case'  — no person slot (checklists, vehicle forms)
     *   'other' — every slot is meant for some other role
     *   'open' too when the set summary predates slot info.
     */
    function fitFor(form, role) {
        if (!form || !Array.isArray(form.slots)) return 'open';
        if (!form.slots.length) return 'case';
        if (form.slots.some(s => hasRoles(s) && s.roles.includes(role))) return 'match';
        if (form.slots.some(s => !hasRoles(s))) return 'open';
        return 'other';
    }

    const FIT_RANK = { match: 0, open: 1, case: 2, other: 3 };

    /**
     * The checklist for one person: every installed set, its forms grouped
     * like the Forms tab (one entry per language group). Entries meant for
     * this person come first ("suggested"); the rest follow.
     * → [{ setId, setName, agency, entries: [{ key, title, category, forms, fit, suggested, languages }] }]
     */
    function formChoices(sets, role) {
        return (Array.isArray(sets) ? sets : []).filter(s => s && !s.error && Array.isArray(s.forms) && s.forms.length).map(set => {
            const entries = [];
            Tab().formGroups(set.forms).forEach(g => g.entries.forEach(e => {
                const fit = e.forms.map(f => fitFor(f, role)).sort((a, b) => FIT_RANK[a] - FIT_RANK[b])[0];
                const languages = [...new Set(e.forms.map(f => f.language).filter(Boolean))];
                entries.push({ key: e.key, title: e.title, category: e.category, forms: e.forms, fit, suggested: fit === 'match' || fit === 'open', languages });
            }));
            entries.forEach((e, i) => { e._i = i; });
            entries.sort((a, b) => (a.suggested === b.suggested ? a._i - b._i : a.suggested ? -1 : 1));
            entries.forEach(e => { delete e._i; });
            return { setId: set.id, setName: set.name, agency: set.agency || '', entries };
        });
    }

    /** The form to fill for an entry in a language: that language, else English, else the first. */
    function formForLanguage(entry, lang) {
        const forms = (entry && entry.forms) || [];
        return forms.find(f => f.language === lang) || forms.find(f => f.language === 'en') || forms[0] || null;
    }

    /**
     * Who goes on each slot: this person in their slot; every other slot gets
     * the Forms tab's default pick from the rest of the case. Vehicle slots
     * take this person's own vehicles first.
     * form: { slots, vehicleSlots }; people/vehicles from form-sources.
     */
    function picksForPerson(form, personKey, role, people, vehicles) {
        const slots = (form && form.slots) || [];
        const slotId = slotForPerson(slots, role);
        // Keep the tab's "a role-less first slot takes a suspect" rule for the other slots.
        const rest = slots.map((s, i) => Object.assign({}, s, { roles: hasRoles(s) ? s.roles : (i === 0 ? ['suspect'] : [NOBODY]) }))
            .filter(s => s.id !== slotId);
        const others = (people || []).filter(p => p.key !== personKey);
        const own = (vehicles || []).filter(v => String(v.key).startsWith(personKey + ':vehicles:'));
        const ordered = own.concat((vehicles || []).filter(v => !own.includes(v)));
        const def = Tab().defaultPicks(rest, others, (form && form.vehicleSlots) || [], ordered);
        const picks = Object.assign({}, def.people);
        if (slotId) picks[slotId] = personKey;
        return { people: picks, vehicles: def.vehicles, slotId };
    }

    /** "Juvenile: Doe, John · Parent / Guardian: Pat Parent" — who VIPER will put on the form. */
    function picksSummary(form, picks, people, vehicles) {
        const label = (list, key) => { const x = (list || []).find(p => p.key === key); return x ? x.label.replace(/ \(DOB [^)]*\)$/, '') : ''; };
        const parts = [];
        ((form && form.slots) || []).forEach(s => parts.push(`${s.label}: ${label(people, picks.people[s.id]) || '—'}`));
        ((form && form.vehicleSlots) || []).forEach(s => parts.push(`${s.label}: ${label(vehicles, picks.vehicles[s.id]) || '—'}`));
        return parts.join(' · ');
    }

    const helpers = { ROLE_OF, slotForPerson, fitFor, formChoices, formForLanguage, picksForPerson, picksSummary };
    if (!root || !root.document) return helpers;

    /* ── The picker (renderer only) ──────────────────────────────────── */

    const api = () => root.electronAPI || {};
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const SAVE_PREF = 'viperPersonFormsSaveToCase';
    const LANG_PREF = 'viperPersonFormsLanguage';

    let M = null;   // the open picker

    function toast(msg, kind) {
        try { if (M && M.ctx.toast) return M.ctx.toast(msg, kind); } catch (_) { /* fall through */ }
        try { if (root.viperToast) root.viperToast(msg, kind); } catch (_) { /* ignore */ }
    }

    function stores() {
        try { return (M.ctx.getStores && M.ctx.getStores()) || {}; } catch (_) { return {}; }
    }

    function pref(key, fallback) {
        try { const v = root.localStorage.getItem(key); return v == null ? fallback : v; } catch (_) { return fallback; }
    }
    function setPref(key, v) { try { root.localStorage.setItem(key, String(v)); } catch (_) { /* ignore */ } }

    async function open(opts) {
        opts = opts || {};
        const role = ROLE_OF[opts.listKey];
        if (!role) return;
        close();
        M = {
            ctx: opts.ctx || {}, listKey: opts.listKey, index: Number(opts.index), role,
            sets: [], choices: [], checked: new Set(), lang: {}, busy: false, results: null, error: '',
            save: pref(SAVE_PREF, 'true') !== 'false',
            defaultLang: pref(LANG_PREF, 'en'),
        };
        const st = stores();
        const rec = (Array.isArray(st[M.listKey]) ? st[M.listKey] : [])[M.index];
        if (!rec) { toast('Could not find that person in the case', 'error'); M = null; return; }
        M.personKey = M.listKey + ':' + M.index;
        M.name = Sources().normPerson(rec).fullName || 'this ' + ROLE_LABEL[role];

        M.el = root.document.createElement('div');
        M.el.className = 'fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4';
        M.el.setAttribute('data-cfp-modal', '');
        M.el.addEventListener('click', onClick);
        M.el.addEventListener('change', onChange);
        M.onKey = (e) => { if (e.key === 'Escape' && M && !M.busy) close(); };
        root.document.addEventListener('keydown', M.onKey);
        root.document.body.appendChild(M.el);
        M.loading = true;
        render();

        try {
            const fn = api().caseFormsInstalled;
            if (typeof fn !== 'function') throw new Error('Agency forms are not available in this build.');
            const r = await fn();
            if (!r || !r.success) throw new Error((r && r.error) || 'Could not list form sets');
            M.sets = (r.sets || []).filter(s => !s.error);
            M.choices = formChoices(M.sets, role);
        } catch (e) {
            M.error = String(e && e.message || e);
        }
        if (!M) return;
        M.loading = false;
        render();
    }

    function close() {
        if (!M) return;
        try { root.document.removeEventListener('keydown', M.onKey); } catch (_) { /* ignore */ }
        try { M.el.remove(); } catch (_) { /* ignore */ }
        M = null;
    }

    const entryId = (setId, key) => setId + '|' + key;
    function findEntry(id) {
        for (const c of M.choices) for (const e of c.entries) if (entryId(c.setId, e.key) === id) return { set: c, entry: e };
        return null;
    }
    function langFor(id, entry) {
        if (M.lang[id]) return M.lang[id];
        return entry.languages.includes(M.defaultLang) ? M.defaultLang : (entry.languages.includes('en') ? 'en' : (entry.languages[0] || ''));
    }

    function onClick(e) {
        if (e.target === M.el) { if (!M.busy) close(); return; }
        const b = e.target && e.target.closest && e.target.closest('[data-cfp-act]');
        if (!b || b.disabled) return;
        const act = b.getAttribute('data-cfp-act');
        if (act === 'close') { if (!M.busy) close(); }
        else if (act === 'fill') fillChecked();
        else if (act === 'again') { M.results = null; render(); }
        else if (act === 'open-file') openFile(b.getAttribute('data-cfp-arg'));
        else if (act === 'none') { M.checked.clear(); render(); }
        else if (act === 'suggested') {
            M.choices.forEach(c => c.entries.forEach(en => { if (en.suggested) M.checked.add(entryId(c.setId, en.key)); }));
            render();
        }
    }

    function onChange(e) {
        const t = e.target;
        if (!t || !t.getAttribute || M.busy) return;
        if (t.hasAttribute('data-cfp-check')) {
            const id = t.getAttribute('data-cfp-check');
            if (t.checked) M.checked.add(id); else M.checked.delete(id);
            render();
        } else if (t.hasAttribute('data-cfp-lang')) {
            const id = t.getAttribute('data-cfp-lang');
            M.lang[id] = t.value;
            M.defaultLang = t.value; setPref(LANG_PREF, t.value);
            M.checked.add(id);
            render();
        } else if (t.hasAttribute('data-cfp-save')) {
            M.save = !!t.checked; setPref(SAVE_PREF, M.save);
            render();
        }
    }

    // The fill context for one form — same shape as the Forms tab builds.
    function ctxFor(picks, people, vehicles, st) {
        const P = {}, V = {};
        Object.keys(picks.people).forEach(slot => { const p = people.find(x => x.key === picks.people[slot]); if (p) P[slot] = p.record; });
        Object.keys(picks.vehicles).forEach(slot => { const v = vehicles.find(x => x.key === picks.vehicles[slot]); if (v) V[slot] = v.record; });
        let officer = {};
        try { officer = Tab().officerProfile ? Tab().officerProfile() : {}; } catch (_) { officer = {}; }
        return {
            currentCase: M.ctx.currentCase || { caseNumber: M.ctx.caseNumber },
            suspects: Array.isArray(st.suspects) ? st.suspects : [],
            offenseDescription: M.ctx.offenseDescription || '',
            officer, people: P, vehicles: V, now: new Date(),
        };
    }

    async function fillChecked() {
        if (M.busy || !M.checked.size) return;
        const ids = [];
        M.choices.forEach(c => c.entries.forEach(en => { const id = entryId(c.setId, en.key); if (M.checked.has(id)) ids.push(id); }));
        const save = M.save && !!M.ctx.caseNumber;
        M.busy = true; M.results = []; M.progress = 0; M.total = ids.length; render();
        const T = Tab(), S = Sources();
        for (const id of ids) {
            if (!M) return;
            const hit = findEntry(id);
            const form = hit && formForLanguage(hit.entry, langFor(id, hit.entry));
            const res = { id, title: hit ? hit.entry.title : id, language: form && form.language, ok: false };
            M.results.push(res);
            try {
                if (!form) throw new Error('Form not found');
                const spec = await api().caseFormsGetForm({ setId: hit.set.setId, formId: form.id });
                if (!spec || !spec.success) throw new Error((spec && spec.error) || 'Could not open the form');
                const st = stores();
                const people = S.peopleFromCase(st), vehicles = S.vehiclesFromCase(st);
                // A person with no name yet is still this person.
                if (!people.some(p => p.key === M.personKey)) {
                    const rec = (st[M.listKey] || [])[M.index];
                    if (rec) people.push({ key: M.personKey, role: M.role, roleLabel: '', label: M.name, record: rec });
                }
                const picks = picksForPerson(spec.form, M.personKey, M.role, people, vehicles);
                const input = ctxFor(picks, people, vehicles, st);
                const rows = T.computeRows(spec, input, {});
                res.blank = rows.rows.filter(r => r.blank).length;
                res.who = picksSummary(spec.form, picks, people, vehicles);
                const fill = await api().caseFormsFill({
                    setId: spec.set.id, formId: spec.form.id, mode: save ? 'case' : 'open',
                    values: T.collectValues(rows.rows), caseNumber: M.ctx.caseNumber || '', nameHint: T.nameHint(spec, input),
                });
                if (!fill || !fill.success) throw new Error((fill && fill.error) || 'Could not fill the form');
                res.warnings = (fill.warnings || []).filter(w => w.code !== 'missing');
                if (save) {
                    res.fileName = fill.fileName;
                    const o = await api().caseFormsOpen({ caseNumber: M.ctx.caseNumber, fileName: fill.fileName, action: 'open' });
                    if (!o || !o.success) throw new Error('Saved to the case, but could not open it: ' + ((o && o.error) || 'unknown error'));
                }
                res.ok = true;
            } catch (e) {
                res.error = String(e && e.message || e);
            }
            if (!M) return;
            M.progress++;
            render();
        }
        M.busy = false;
        const good = M.results.filter(r => r.ok).length;
        if (good) toast(`${good} form${good === 1 ? '' : 's'} filled for ${M.name}${save ? ' and saved to the case' : ''}`, good === M.results.length ? 'success' : 'warning');
        render();
    }

    async function openFile(fileName) {
        try {
            const r = await api().caseFormsOpen({ caseNumber: M.ctx.caseNumber, fileName, action: 'open' });
            if (!r || !r.success) toast((r && r.error) || 'Could not open that form', 'error');
        } catch (e) { toast('Could not open that form: ' + (e && e.message || e), 'error'); }
    }

    /* ── Rendering ───────────────────────────────────────────────────── */

    const LANG_NAMES = { en: 'English', es: 'Spanish' };
    const langName = (l) => LANG_NAMES[l] || String(l || '').toUpperCase();

    function entryHtml(c, e) {
        const id = entryId(c.setId, e.key);
        const on = M.checked.has(id);
        const lang = langFor(id, e);
        const langSel = e.languages.length > 1
            ? `<select data-cfp-lang="${esc(id)}" class="ml-auto shrink-0 px-1.5 py-0.5 text-xs rounded bg-viper-dark border border-gray-600 text-gray-200" aria-label="Language for ${esc(e.title)}">${e.languages.map(l =>
                `<option value="${esc(l)}" ${l === lang ? 'selected' : ''}>${esc(langName(l))}</option>`).join('')}</select>`
            : (e.languages[0] && e.languages[0] !== 'en' ? `<span class="ml-auto text-[10px] text-gray-500">${esc(langName(e.languages[0]))}</span>` : '');
        return `
            <label class="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border cursor-pointer ${on ? 'border-viper-cyan/60 bg-viper-cyan/10' : 'border-gray-700/60 hover:bg-gray-700/30'}">
                <input type="checkbox" data-cfp-check="${esc(id)}" ${on ? 'checked' : ''} class="w-4 h-4 rounded border-gray-600 text-viper-cyan shrink-0">
                <span class="min-w-0">
                    <span class="block text-sm text-gray-100">${esc(e.title)}</span>
                    <span class="block text-[10px] text-gray-500">${esc(e.category)}${e.fit === 'case' ? ' · case form' : ''}</span>
                </span>
                ${langSel}
            </label>`;
    }

    function listHtml() {
        if (M.loading) return '<div class="text-sm text-gray-400 py-6 text-center">Loading forms…</div>';
        if (M.error) return `<div class="p-3 rounded border border-rose-500/40 bg-rose-500/10 text-sm text-rose-200">${esc(M.error)}</div>`;
        if (!M.choices.length) return '<div class="text-sm text-gray-400 py-4">No agency form set is switched on. Open <span class="text-gray-200">Settings → Agency Forms</span> and switch on your agency\'s set.</div>';
        const many = M.choices.length > 1;
        return M.choices.map(c => {
            const sug = c.entries.filter(e => e.suggested), rest = c.entries.filter(e => !e.suggested);
            return `
                <div class="space-y-2">
                    ${many ? `<div class="text-xs font-semibold text-gray-300">${esc(c.setName)}${c.agency ? ' · ' + esc(c.agency) : ''}</div>` : ''}
                    ${sug.length ? `<div class="text-[10px] uppercase tracking-wide text-gray-500">For this ${esc(ROLE_LABEL[M.role])}</div>
                        <div class="space-y-1.5">${sug.map(e => entryHtml(c, e)).join('')}</div>` : ''}
                    ${rest.length ? `<div class="text-[10px] uppercase tracking-wide text-gray-500 pt-1">${sug.length ? 'Other forms' : 'Forms'}</div>
                        <div class="space-y-1.5">${rest.map(e => entryHtml(c, e)).join('')}</div>` : ''}
                </div>`;
        }).join('<div class="border-t border-gray-700/50 my-3"></div>');
    }

    function resultsHtml() {
        const rows = M.results.map(r => `
            <div class="p-2.5 rounded-lg border ${r.ok ? 'border-emerald-500/30 bg-emerald-500/5' : r.error ? 'border-rose-500/40 bg-rose-500/10' : 'border-gray-700/60'}">
                <div class="flex items-center gap-2">
                    <span class="${r.ok ? 'text-emerald-400' : r.error ? 'text-rose-300' : 'text-gray-400'}">${r.ok ? '✓' : r.error ? '✕' : '…'}</span>
                    <span class="text-sm text-gray-100 min-w-0 flex-1">${esc(r.title)}${r.language && r.language !== 'en' ? ` <span class="text-[10px] text-gray-500">${esc(langName(r.language))}</span>` : ''}</span>
                    ${r.ok && r.fileName ? `<button type="button" data-cfp-act="open-file" data-cfp-arg="${esc(r.fileName)}" class="text-[11px] px-2 py-0.5 rounded border border-gray-600 text-gray-300 hover:bg-gray-700/40">Open again</button>` : ''}
                </div>
                ${r.who ? `<div class="text-[11px] text-gray-400 mt-0.5 ml-6">${esc(r.who)}</div>` : ''}
                ${r.ok ? `<div class="text-[11px] ml-6 ${r.blank ? 'text-amber-300/90' : 'text-gray-500'}">${r.blank ? `${r.blank} box${r.blank === 1 ? '' : 'es'} left blank — fill ${r.blank === 1 ? 'it' : 'them'} in the PDF viewer or by hand` : 'Every box filled'}${r.fileName ? ' · saved as ' + esc(r.fileName) : ''}</div>` : ''}
                ${r.warnings && r.warnings.length ? `<div class="text-[11px] text-amber-300 ml-6">${esc(r.warnings.slice(0, 3).map(w => (w.field ? w.field + ': ' : '') + w.message).join('; '))}</div>` : ''}
                ${r.error ? `<div class="text-[11px] text-rose-200 ml-6">${esc(r.error)}</div>` : ''}
            </div>`).join('');
        return `<div class="space-y-1.5">${rows}</div>`;
    }

    function render() {
        if (!M || !M.el) return;
        const n = M.checked.size;
        const canSave = !!M.ctx.caseNumber;
        const anySuggested = M.choices.some(c => c.entries.some(e => e.suggested));
        const scrollBox = M.el.querySelector('[data-cfp-body]');
        const scroll = scrollBox ? scrollBox.scrollTop : 0;
        const body = M.results ? resultsHtml() : listHtml();
        const footer = M.results
            ? `<div class="text-[11px] text-gray-400 mr-auto">${M.busy ? `Filling ${Math.min(M.progress + 1, M.total)} of ${M.total}…` : 'The filled PDFs open in your PDF viewer — print them or change any box there.'}</div>
               <button type="button" data-cfp-act="again" ${M.busy ? 'disabled' : ''} class="px-3 py-1.5 text-xs rounded-lg border border-gray-600 text-gray-200 hover:bg-gray-700/40 disabled:opacity-50">Pick more</button>
               <button type="button" data-cfp-act="close" ${M.busy ? 'disabled' : ''} class="px-3 py-1.5 text-xs rounded-lg border bg-viper-cyan/20 hover:bg-viper-cyan/30 border-viper-cyan text-viper-cyan disabled:opacity-50">Done</button>`
            : `<label class="text-[11px] text-gray-300 flex items-center gap-1.5 mr-auto ${canSave ? '' : 'opacity-50'}" title="${canSave ? 'Keep a copy of each filled PDF in this case\'s Forms folder' : 'This case has no case number'}">
                    <input type="checkbox" data-cfp-save ${M.save && canSave ? 'checked' : ''} ${canSave ? '' : 'disabled'} class="w-3.5 h-3.5"> Also save to the case's Forms folder</label>
               <button type="button" data-cfp-act="close" class="px-3 py-1.5 text-xs rounded-lg border border-gray-600 text-gray-200 hover:bg-gray-700/40">Cancel</button>
               <button type="button" data-cfp-act="fill" ${n && !M.loading ? '' : 'disabled'} class="px-3 py-1.5 text-xs rounded-lg border bg-viper-cyan/20 hover:bg-viper-cyan/30 border-viper-cyan text-viper-cyan disabled:opacity-50">Fill &amp; open${n ? ` ${n} form${n === 1 ? '' : 's'}` : ''}</button>`;
        M.el.innerHTML = `
            <div class="glass-card rounded-xl p-5 max-w-xl w-full max-h-[85vh] flex flex-col" role="dialog" aria-modal="true" aria-label="Forms for ${esc(M.name)}">
                <div class="flex justify-between items-start gap-3 mb-3">
                    <div class="min-w-0">
                        <h3 class="text-xl font-bold text-white">Forms</h3>
                        <p class="text-xs text-gray-400 truncate">for <span class="text-gray-200">${esc(M.name)}</span> (${esc(ROLE_LABEL[M.role])})</p>
                    </div>
                    <button type="button" data-cfp-act="close" ${M.busy ? 'disabled' : ''} class="text-gray-400 hover:text-white text-xl leading-none px-1" title="Close">×</button>
                </div>
                ${!M.results && !M.loading && !M.error && M.choices.length ? `
                    <div class="flex items-center gap-3 mb-2 text-[11px]">
                        ${anySuggested ? '<button type="button" data-cfp-act="suggested" class="text-gray-400 hover:text-viper-cyan">Tick suggested</button>' : ''}
                        ${n ? '<button type="button" data-cfp-act="none" class="text-gray-400 hover:text-viper-cyan">Clear</button>' : ''}
                    </div>` : ''}
                <div class="overflow-y-auto pr-1 flex-1 min-h-0" data-cfp-body>${body}</div>
                <div class="flex flex-wrap items-center gap-2 pt-3 mt-3 border-t border-gray-700/50">${footer}</div>
            </div>`;
        const box = M.el.querySelector('[data-cfp-body]');
        if (box && scroll) box.scrollTop = scroll;
    }

    return Object.assign({}, helpers, { open, close });
}));
