/**
 * Settings → "Agency Forms".
 *
 * Lists the form sets published in the VIPER form library (plus anything
 * installed from a .viperforms file). Switching a set on downloads and
 * installs it; switching it off removes it from this computer. Forms already
 * filled into cases are never touched.
 *
 * Mounts into #caseFormsMount. Keeps localStorage.viperCaseFormsAvailable
 * current so case pages know to offer the Forms tab.
 */
(function () {
    'use strict';

    const LS_FLAG = 'viperCaseFormsAvailable';
    const state = {
        sets: [], loaded: false, loading: false,
        online: null, libraryError: '', libraryStatus: 0,
        busy: false, busyId: '', pending: null, verify: {}, open: {}, filter: '',
    };
    let mountEl = null;

    const api = () => (typeof window !== 'undefined' && window.electronAPI) || {};
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const toast = (msg, kind) => {
        try { if (window.viperToast) return window.viperToast(msg, kind || 'info'); } catch (_) { /* fall through */ }
        try { console.log('[case-forms]', msg); } catch (_) { /* ignore */ }
    };
    const confirmBox = async (msg, opts) => {
        // viperConfirm shows its message as HTML; set names come from the shared library.
        try { if (window.viperConfirm) return await window.viperConfirm(esc(msg).replace(/\n/g, '<br>'), opts); } catch (_) { /* fall through */ }
        return window.confirm(msg);
    };
    // Library calls carry the registration's API key; ViperLicensing refreshes a stale one.
    const withKey = (fn) => {
        const L = window.ViperLicensing;
        if (L && typeof L.callWithApiKey === 'function') return L.callWithApiKey(fn);
        return fn('');
    };

    const usable = (s) => !!(s && s.installed && !s.installError);
    function setFlag(sets) {
        const any = (sets || []).some(usable);
        try { localStorage.setItem(LS_FLAG, any ? 'true' : 'false'); } catch (_) { /* ignore */ }
    }

    function fmtDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleDateString();
    }
    function fmtSize(n) {
        if (!n && n !== 0) return '';
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        return Math.max(1, Math.round(n / 1024)) + ' KB';
    }
    const LANG_NAMES = { en: 'English', es: 'Spanish' };
    const langName = (l) => LANG_NAMES[String(l || '').slice(0, 2)] || String(l || '').toUpperCase();
    function languagesOf(s) {
        const set = new Set((s.forms || []).map(f => f.language).filter(Boolean));
        (s.languages || []).forEach(l => set.add(l));
        return [...set].sort().map(langName);
    }

    // Rows from case-forms-installed look like library rows that are installed but not listed.
    function fromInstalled(list) {
        return (list || []).map(s => Object.assign({}, s, {
            inLibrary: false, installed: true,
            installedVersion: s.error ? null : s.version,
            installedSource: s.error ? null : s.source,
            installError: s.error || null,
            updateAvailable: false,
        }));
    }

    function libraryProblem() {
        if (state.online !== false) return '';
        const st = state.libraryStatus;
        if (st === 401 || st === 403) return 'VIPER could not confirm this computer\'s registration with the form library. Check Settings → License, then Refresh.';
        return state.libraryError || 'The form library could not be reached.';
    }

    async function refresh() {
        const a = api();
        if (typeof a.caseFormsInstalled !== 'function') { state.loaded = true; render(); return; }
        state.loading = true; render();
        // Installed sets first: instant, works offline.
        try {
            const r = await a.caseFormsInstalled();
            if (r && r.success && !state.loaded) { state.sets = fromInstalled(r.sets); setFlag(state.sets); }
        } catch (_) { /* the library call below reports problems */ }
        render();
        try {
            const r = await withKey((k) => a.caseFormsLibrary({ apiKey: k }));
            if (r && r.success) {
                state.sets = Array.isArray(r.sets) ? r.sets : [];
                state.online = !!r.online;
                state.libraryError = r.libraryError || '';
                state.libraryStatus = r.libraryStatus || 0;
            } else {
                state.online = false;
                state.libraryError = (r && r.error) || 'Could not list form sets';
            }
        } catch (e) {
            state.online = false;
            state.libraryError = String(e && e.message || e);
        } finally {
            state.loading = false;
            state.loaded = true;
            setFlag(state.sets);
            render();
        }
    }

    const find = (id) => state.sets.find(s => s.id === id) || { id };

    async function enable(id, isUpdate) {
        if (state.busy) return;
        const s = find(id);
        if (isUpdate && s.installedSource === 'file' && s.installedVersion) {
            const ok = await confirmBox(
                `"${s.name || id}" was imported from a file (version ${s.installedVersion}).\n\nUpdating replaces it with library version ${s.version}.`,
                { okText: `Update to ${s.version}` });
            if (!ok) return;
        }
        state.busy = true; state.busyId = id; render();
        try {
            const r = await withKey((k) => api().caseFormsEnable({ apiKey: k, id }));
            if (!r || !r.success) return toast((r && r.error) || 'Could not download that form set', 'error');
            const set = r.set || {};
            const verb = set.previousVersion ? `updated to ${set.version} (was ${set.previousVersion})` : 'is on';
            toast(`${set.name || 'Form set'} ${verb}: ${set.formCount || 0} forms`, 'success');
            delete state.verify[id];
        } catch (e) {
            toast('Could not download that form set: ' + (e && e.message || e), 'error');
        } finally {
            state.busy = false; state.busyId = '';
            await refresh();
        }
    }

    async function remove(id) {
        if (state.busy) return;
        const s = find(id);
        const back = s.inLibrary ? ' You can switch it on again later.' : ' It is not in the library, so you would need the .viperforms file to get it back.';
        const ok = await confirmBox(
            `Switch off "${s.name || id}"?\n\nIts blank forms are removed from this computer. Forms already filled into cases stay where they are.${back}`,
            { danger: true, okText: 'Switch off' });
        if (!ok) return;
        state.busy = true; state.busyId = id; render();
        try {
            const r = await api().caseFormsRemove(id);
            if (!r || !r.success) toast((r && r.error) || 'Could not remove that form set', 'error');
            else toast(`${s.name || id} switched off`, 'success');
            delete state.verify[id];
        } catch (e) {
            toast('Could not remove that form set: ' + (e && e.message || e), 'error');
        } finally {
            state.busy = false; state.busyId = '';
            await refresh();
        }
    }

    async function verify(id) {
        if (state.busy) return;
        state.busy = true; state.verify[id] = { running: true }; render();
        try {
            const r = await api().caseFormsVerify(id);
            if (!r || !r.success) state.verify[id] = { ok: false, problems: [(r && r.error) || 'Check failed'] };
            else state.verify[id] = { ok: !!r.ok, problems: r.problems || [], formCount: r.formCount };
        } catch (e) {
            state.verify[id] = { ok: false, problems: [String(e && e.message || e)] };
        } finally {
            state.busy = false; render();
        }
    }

    async function choose() {
        if (state.busy) return;
        const fn = api().caseFormsChooseFile;
        if (typeof fn !== 'function') return toast('Agency forms are not available in this build', 'error');
        state.busy = true; render();
        try {
            const r = await fn();
            if (!r || r.canceled) return;
            if (!r.success) return toast(r.error || 'That file is not a valid form set', 'error');
            state.pending = { filePath: r.filePath, summary: r.summary || {} };
        } catch (e) {
            toast('Could not read that file: ' + (e && e.message || e), 'error');
        } finally {
            state.busy = false; render();
        }
    }

    async function installFile() {
        if (state.busy || !state.pending) return;
        const s = state.pending.summary || {};
        if (s.olderThanInstalled) {
            const ok = await confirmBox(
                `This file is version ${s.version} of "${s.name || s.id}", but version ${s.installedVersion} is already installed.\n\nInstalling it goes back to the older forms. Only do this if your agency asked you to.`,
                { danger: true, okText: `Install older version ${s.version}` });
            if (!ok || !state.pending) return;
        }
        state.busy = true; render();
        try {
            const r = await api().caseFormsInstallFile(state.pending.filePath);
            if (!r || !r.success) return toast((r && r.error) || 'Import failed', 'error');
            const set = r.set || {};
            const verb = set.previousVersion ? `updated (was ${set.previousVersion})` : 'imported';
            toast(`${set.name || 'Form set'} ${verb}: ${set.formCount || 0} forms`, 'success');
            state.pending = null;
            delete state.verify[set.id];
        } catch (e) {
            toast('Import failed: ' + (e && e.message || e), 'error');
        } finally {
            state.busy = false;
            await refresh();
        }
    }

    // ---- Rendering ---------------------------------------------------------------------------
    const BTN = 'px-2.5 py-1 text-xs rounded border disabled:opacity-50';
    const BTN_GREY = `${BTN} border-gray-600 text-gray-300 hover:bg-gray-700/40`;
    const BTN_CYAN = `${BTN} border-viper-cyan/60 text-viper-cyan hover:bg-viper-cyan/10`;
    const BTN_RED = `${BTN} border-rose-500/50 text-rose-300 hover:bg-rose-500/10`;
    const dis = () => (state.busy ? 'disabled' : '');

    function toggleHtml(s) {
        const on = usable(s);
        const working = state.busyId === s.id;
        const title = on ? 'Switch off (removes the blank forms from this computer)' : 'Switch on (downloads the forms)';
        return `<button type="button" role="switch" aria-checked="${on}" data-cf-act="${on ? 'off' : 'on'}" data-cf-id="${esc(s.id)}" ${dis()}
                    title="${esc(title)}" aria-label="${esc((on ? 'Switch off ' : 'Switch on ') + (s.name || s.id))}"
                    class="relative inline-flex items-center h-6 rounded-full w-11 transition-colors focus:outline-none shrink-0 disabled:opacity-60 ${on ? 'bg-viper-cyan' : 'bg-gray-700'}${working ? ' animate-pulse' : ''}">
                    <span class="inline-block w-4 h-4 transform transition-transform bg-white rounded-full ${on ? 'translate-x-6' : 'translate-x-1'}"></span>
                </button>`;
    }

    function renderVerify(id) {
        const v = state.verify[id];
        if (!v) return '';
        if (v.running) return '<div class="text-[11px] text-gray-400 mt-1">Checking every form…</div>';
        if (v.ok) return `<div class="text-[11px] text-emerald-400 mt-1">✓ All ${esc(v.formCount || '')} forms match the set.</div>`;
        const list = (v.problems || []).slice(0, 5).map(p => `<li>${esc(p)}</li>`).join('');
        const more = (v.problems || []).length > 5 ? `<li>…and ${v.problems.length - 5} more</li>` : '';
        return `<div class="text-[11px] text-rose-300 mt-1">✗ Problems found — switch the set off and on again (or re-import the file):<ul class="list-disc ml-5">${list}${more}</ul></div>`;
    }

    function renderForms(s) {
        if (!state.open[s.id]) return '';
        const forms = s.forms || [];
        if (!forms.length) return '';
        const groups = {};
        forms.forEach(f => { const c = f.category || 'Other'; (groups[c] = groups[c] || []).push(f); });
        const html = Object.keys(groups).sort().map(c => `
                    <div class="mt-1.5">
                        <div class="text-[10px] uppercase tracking-wide text-gray-500">${esc(c)}</div>
                        <ul class="ml-3 text-[11px] text-gray-300">${groups[c].map(f =>
                            `<li>${esc(f.title || f.id)}${f.language ? ` <span class="text-gray-500">(${esc(langName(f.language))})</span>` : ''}</li>`).join('')}</ul>
                    </div>`).join('');
        return `<div class="mt-2 pl-2 border-l border-gray-700/60" data-cf-forms="${esc(s.id)}">${html}</div>`;
    }

    function renderSet(s) {
        if (s.installError) {
            return `
                <div class="p-3 rounded-lg border border-rose-500/40 bg-rose-500/5" data-cf-set="${esc(s.id)}">
                    <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                            <div class="text-sm text-white">${esc(s.name || s.id)}</div>
                            <div class="text-[11px] text-rose-300">${esc(s.installError)}</div>
                        </div>
                        <div class="flex gap-2 shrink-0">
                            ${s.inLibrary ? `<button type="button" data-cf-act="update" data-cf-id="${esc(s.id)}" ${dis()} class="${BTN_CYAN}">Download again</button>` : ''}
                            <button type="button" data-cf-act="off" data-cf-id="${esc(s.id)}" ${dis()} class="${BTN_RED}">Remove</button>
                        </div>
                    </div>
                </div>`;
        }
        const on = usable(s);
        const langs = languagesOf(s);
        const shownVersion = on ? s.installedVersion : s.version;
        const meta = [
            shownVersion ? `v${esc(shownVersion)}` : '',
            `${esc(s.formCount || (s.forms || []).length || 0)} forms`,
            langs.length ? esc(langs.join(' / ')) : '',
            !on && s.size ? esc(fmtSize(s.size)) : '',
            on && s.installedAt ? `on since ${esc(fmtDate(s.installedAt))}` : '',
        ].filter(Boolean).join(' · ');
        const badges = [];
        if (on && s.installedSource === 'file') badges.push('<span class="px-1.5 py-0.5 rounded text-[10px] bg-gray-600/30 text-gray-300 border border-gray-600">Imported from file</span>');
        if (on && !s.inLibrary && state.online) badges.push('<span class="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/30">Not in the library</span>');
        if (s.updateAvailable) badges.push(`<span class="px-1.5 py-0.5 rounded text-[10px] bg-viper-cyan/15 text-viper-cyan border border-viper-cyan/30">Update: v${esc(s.version)}</span>`);
        const working = state.busyId === s.id
            ? `<div class="text-[11px] text-gray-400 mt-1">${on ? 'Working…' : 'Downloading and checking the forms…'}</div>` : '';
        return `
            <div class="p-3 rounded-lg border ${on ? 'border-viper-cyan/30 bg-viper-cyan/5' : 'border-gray-700/60 bg-viper-dark/40'}" data-cf-set="${esc(s.id)}">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-sm text-white font-semibold flex flex-wrap items-center gap-1.5">${esc(s.name || s.id)} ${badges.join(' ')}</div>
                        ${s.agency ? `<div class="text-xs text-gray-300">${esc(s.agency)}</div>` : ''}
                        ${s.description ? `<div class="text-[11px] text-gray-400 mt-0.5">${esc(s.description)}</div>` : ''}
                        <div class="text-[11px] text-gray-500 mt-0.5">${meta}</div>
                        <div class="flex flex-wrap gap-2 mt-2">
                            ${(s.forms || []).length ? `<button type="button" data-cf-act="forms" data-cf-id="${esc(s.id)}" class="${BTN_GREY}">${state.open[s.id] ? 'Hide forms' : 'Show forms'}</button>` : ''}
                            ${s.updateAvailable ? `<button type="button" data-cf-act="update" data-cf-id="${esc(s.id)}" ${dis()} class="${BTN_CYAN}">Update to v${esc(s.version)}</button>` : ''}
                            ${on ? `<button type="button" data-cf-act="verify" data-cf-id="${esc(s.id)}" ${dis()} class="${BTN_GREY}">Check files</button>` : ''}
                        </div>
                        ${working}
                        ${renderVerify(s.id)}
                        ${renderForms(s)}
                    </div>
                    ${toggleHtml(s)}
                </div>
            </div>`;
    }

    function renderPending() {
        const pd = state.pending;
        if (!pd) return '';
        const s = pd.summary || {};
        let note = '';
        if (s.olderThanInstalled) {
            note = `<div class="mt-2 p-2 rounded border border-rose-500/50 bg-rose-500/10 text-[11px] text-rose-200" data-cf-older>
                    <span class="font-semibold">Older than what is installed.</span> This file is version ${esc(s.version)}; version ${esc(s.installedVersion)} is installed now.</div>`;
        } else if (s.installedVersion && s.installedVersion === s.version) {
            note = `<p class="text-[11px] text-amber-300 mt-2">Version ${esc(s.version)} is already installed. Importing again replaces it with this copy.</p>`;
        } else if (s.installedVersion) {
            note = `<p class="text-[11px] text-viper-cyan mt-2">Replaces installed version ${esc(s.installedVersion)}.</p>`;
        }
        const langs = languagesOf(s);
        return `
            <div class="mt-3 p-3 rounded-lg border border-viper-cyan/40 bg-viper-cyan/5" data-cf-pending>
                <div class="text-sm text-white font-semibold">${esc(s.name || s.id)} <span class="text-gray-400 font-normal">v${esc(s.version)}</span></div>
                ${s.agency ? `<div class="text-xs text-gray-300">${esc(s.agency)}</div>` : ''}
                ${s.description ? `<div class="text-xs text-gray-400 mt-1">${esc(s.description)}</div>` : ''}
                <div class="text-xs text-gray-300 mt-2">
                    <span class="text-gray-500">Forms:</span> ${esc(s.formCount || 0)}${langs.length ? ` · ${esc(langs.join(' / '))}` : ''}${s.sizeBytes ? ` · ${esc(fmtSize(s.sizeBytes))}` : ''}
                </div>
                ${note}
                <div class="flex gap-2 mt-3">
                    <button type="button" data-cf-act="install" ${dis()}
                        class="px-3 py-1.5 text-xs rounded-lg ${s.olderThanInstalled ? 'bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/60 text-rose-200' : 'bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan text-viper-cyan'} disabled:opacity-50">${s.olderThanInstalled ? 'Import older version…' : 'Import'}</button>
                    <button type="button" data-cf-act="cancel" ${dis()}
                        class="px-3 py-1.5 text-xs rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-700/40">Cancel</button>
                </div>
            </div>`;
    }

    function matches(s, q) {
        if (!q) return true;
        const hay = [s.name, s.agency, s.description, s.id].concat((s.forms || []).map(f => f.title)).join(' ').toLowerCase();
        return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
    }

    function render() {
        if (!mountEl) return;
        // Keep the filter box's focus and caret across re-renders.
        const active = document.activeElement;
        const hadFilterFocus = !!(active && active.getAttribute && active.getAttribute('data-cf-filter') != null && mountEl.contains(active));
        const caret = hadFilterFocus ? active.selectionStart : null;

        const all = state.sets || [];
        const on = all.filter(usable);
        const rest = all.filter(s => !usable(s));
        const q = state.filter.trim();
        const shownOn = on.filter(s => matches(s, q));
        const shownRest = rest.filter(s => matches(s, q));
        const problem = libraryProblem();
        const showFilter = all.length > 5;

        let listHtml;
        if (!state.loaded && !all.length) {
            listHtml = '<div class="text-xs text-gray-500 italic">Loading form sets…</div>';
        } else if (!all.length) {
            listHtml = state.online
                ? '<div class="text-xs text-gray-500 italic">No form sets have been published to the library yet. If your agency gave you a .viperforms file, use Import file….</div>'
                : '<div class="text-xs text-gray-500 italic">No form sets installed.</div>';
        } else {
            const section = (label, rows) => rows.length ? `
                <div class="space-y-2">
                    <div class="text-[11px] uppercase tracking-wide text-gray-500">${label}</div>
                    ${rows.map(renderSet).join('')}
                </div>` : '';
            listHtml = (section('On', shownOn) + section(state.online === false ? 'Not available offline' : 'Available', shownRest))
                || '<div class="text-xs text-gray-500 italic">No form sets match.</div>';
        }

        mountEl.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-start justify-between gap-3">
                    <p class="text-xs text-gray-400 pr-2">Switch on your agency's form set to fill its PDF forms — advisements, consents, checklists — from the <span class="text-gray-300">Forms</span> tab on a case. Switching a set on downloads it from the VIPER form library; the forms stay on this computer and are included in VIPER backups. Filled forms are saved with the case.</p>
                    <div class="shrink-0 flex flex-col gap-2 items-stretch">
                        <button type="button" data-cf-act="refresh" ${state.busy || state.loading ? 'disabled' : ''}
                            class="px-3 py-1.5 text-xs rounded-lg border border-gray-600 text-gray-200 hover:bg-gray-700/40 disabled:opacity-50">${state.loading ? 'Loading…' : 'Refresh'}</button>
                        <button type="button" data-cf-act="choose" ${dis()}
                            class="px-3 py-1.5 text-xs rounded-lg border border-gray-600 text-gray-200 hover:bg-gray-700/40 disabled:opacity-50" title="Install a .viperforms file your agency gave you">Import file…</button>
                    </div>
                </div>
                ${problem ? `<div class="p-2 rounded border border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-200" data-cf-offline>
                    <span class="font-semibold">Form library unavailable.</span> ${esc(problem)} Sets already on this computer still work.</div>` : ''}
                ${renderPending()}
                ${showFilter ? `<input type="search" data-cf-filter value="${esc(state.filter)}" placeholder="Search by agency or form name"
                    class="w-full px-2.5 py-1.5 text-sm rounded-lg bg-viper-dark border border-gray-600 text-white focus:border-viper-cyan focus:outline-none">` : ''}
                <div class="space-y-4">${listHtml}</div>
                <p class="text-[11px] text-gray-500">Filled forms are drafts until signed. Check every value against the case before printing.</p>
            </div>`;

        if (hadFilterFocus) {
            const el = mountEl.querySelector('[data-cf-filter]');
            if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch (_) { /* ignore */ } }
        }
    }

    function onClick(e) {
        const b = e.target && e.target.closest && e.target.closest('[data-cf-act]');
        if (!b || b.disabled) return;
        const act = b.getAttribute('data-cf-act');
        const id = b.getAttribute('data-cf-id');
        if (act === 'on') enable(id, false);
        else if (act === 'update') enable(id, true);
        else if (act === 'off') remove(id);
        else if (act === 'verify') verify(id);
        else if (act === 'forms') { state.open[id] = !state.open[id]; render(); }
        else if (act === 'refresh') refresh();
        else if (act === 'choose') choose();
        else if (act === 'install') installFile();
        else if (act === 'cancel') { state.pending = null; render(); }
    }
    function onInput(e) {
        if (e.target && e.target.getAttribute && e.target.getAttribute('data-cf-filter') != null) {
            state.filter = e.target.value;
            render();
        }
    }

    // Settings page load: installed sets only (keeps the case-tab flag right, no network).
    async function loadInstalled() {
        const fn = api().caseFormsInstalled;
        if (typeof fn !== 'function') return;
        try {
            const r = await fn();
            if (r && r.success && !state.loaded && !state.loading) {
                state.sets = fromInstalled(r.sets);
                setFlag(state.sets);
                render();
            }
        } catch (_) { /* ignore */ }
    }

    // The library is asked the first time the section is opened.
    let refreshed = false;
    function show() {
        if (!mountEl) mount();
        if (!refreshed) { refreshed = true; refresh(); }
    }

    function mount(el) {
        mountEl = el || document.getElementById('caseFormsMount');
        if (!mountEl) return;
        if (!mountEl.__cfWired) {
            mountEl.__cfWired = true;
            mountEl.addEventListener('click', onClick);
            mountEl.addEventListener('input', onInput);
        }
        render();
        loadInstalled();
    }

    const API = { mount, show, refresh, _state: state, _matches: matches, _fromInstalled: fromInstalled };
    if (typeof window !== 'undefined') {
        window.ViperCaseFormsSettings = API;
        const boot = () => { if (document.getElementById('caseFormsMount')) mount(); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }
})();
