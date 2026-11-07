/**
 * Settings → Warrant Authoring → "Agency template packs".
 *
 * Install a .viperpack (an agency's own Word templates plus its form rules),
 * see what is installed, re-check it, or remove it. The pack itself never
 * ships with VIPER; the officer installs the file the agency gave them.
 *
 * Mounts into #agencyPacksMount. Keeps localStorage.viperAgencyPackInstalled
 * current so case pages know to offer the Warrant Author tab.
 */
(function () {
    'use strict';

    const LS_FLAG = 'viperAgencyPackInstalled';
    // create: null, or the "Create a pack" form's values while it is open.
    const state = { packs: [], drafts: [], pending: null, busy: false, verify: {}, create: null };
    let mountEl = null;

    const api = () => (typeof window !== 'undefined' && window.electronAPI) || {};
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const toast = (msg, kind) => {
        try { if (window.viperToast) return window.viperToast(msg, kind || 'info'); } catch (_) { /* fall through */ }
        try { console.log('[agency-packs]', msg); } catch (_) { /* ignore */ }
    };
    const confirmBox = async (msg, opts) => {
        // viperConfirm shows its message as HTML; pack names come from shared pack files.
        try { if (window.viperConfirm) return await window.viperConfirm(esc(msg).replace(/\n/g, '<br>'), opts); } catch (_) { /* fall through */ }
        return window.confirm(msg);
    };

    function setFlag(packs) {
        const any = (packs || []).some(p => p && !p.error && p.kind === 'warrant-builder');
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
    function categoryText(cats) {
        const e = Object.entries(cats || {});
        if (!e.length) return '';
        return e.map(([k, v]) => `${esc(k)} (${v})`).join(' · ');
    }

    async function refresh() {
        const fn = api().agencyPackList;
        if (typeof fn !== 'function') { state.packs = []; render(); return; }
        try {
            const r = await fn();
            state.packs = (r && r.success && Array.isArray(r.packs)) ? r.packs : [];
            if (r && !r.success) toast(r.error || 'Could not list agency packs', 'error');
        } catch (e) {
            state.packs = [];
        }
        try {
            const d = typeof api().agencyPackDrafts === 'function' ? await api().agencyPackDrafts() : null;
            state.drafts = (d && d.success && Array.isArray(d.drafts)) ? d.drafts : [];
        } catch (_) {
            state.drafts = [];
        }
        setFlag(state.packs);
        render();
    }

    // ---- Making and editing packs ------------------------------------------------------------
    const editorReady = () => !!(window.ViperPackEditor && typeof api().agencyPackDraftCreate === 'function');

    function openEditor(opts) {
        if (!editorReady()) return toast('The pack editor is not available in this build', 'error');
        window.ViperPackEditor.open(Object.assign({}, opts, { onClose: () => refresh() }));
    }

    async function createPack() {
        if (state.busy || !mountEl) return;
        const val = (k) => {
            const el = mountEl.querySelector(`[data-ap-new="${k}"]`);
            return el ? el.value.trim() : '';
        };
        state.create = { name: val('name'), agency: val('agency'), description: val('description') };
        if (!state.create.name) {
            toast('Give the pack a name', 'error');
            const el = mountEl.querySelector('[data-ap-new="name"]');
            if (el) el.focus();
            return;
        }
        state.busy = true; render();
        try {
            const r = await api().agencyPackDraftCreate(state.create);
            if (!r || !r.success) return toast((r && r.error) || 'Could not start the pack', 'error');
            state.create = null;
            openEditor({ id: r.draft.id, mode: 'resume', view: r.draft, tab: 'templates' });
        } catch (e) {
            toast('Could not start the pack: ' + (e && e.message || e), 'error');
        } finally {
            state.busy = false;
            await refresh();
        }
    }

    async function exportPack(id) {
        if (state.busy) return;
        const fn = api().agencyPackExport;
        if (typeof fn !== 'function') return toast('Export is not available in this build', 'error');
        state.busy = true; render();
        try {
            const r = await fn(id);
            if (!r || r.canceled) return;
            if (!r.success) return toast(r.error || 'Export failed', 'error');
            toast(`Exported version ${r.packVersion} to ${r.filePath}`, 'success');
        } catch (e) {
            toast('Export failed: ' + (e && e.message || e), 'error');
        } finally {
            state.busy = false; render();
        }
    }

    async function discardDraft(id) {
        if (state.busy) return;
        const d = (state.drafts || []).find(x => x.id === id) || { id };
        const msg = d.installed
            ? `Throw away the unsaved changes to "${d.name || id}"?\n\nThe installed pack stays as it was.`
            : `Delete "${d.name || id}"?\n\nThis pack was never saved, so its templates and settings are deleted from this computer.`;
        const ok = await confirmBox(msg, { danger: true, okText: d.installed ? 'Throw away changes' : 'Delete' });
        if (!ok) return;
        state.busy = true; render();
        try {
            const r = await api().agencyPackDraftDiscard(id);
            if (!r || !r.success) toast((r && r.error) || 'Could not delete it', 'error');
        } catch (e) {
            toast('Could not delete it: ' + (e && e.message || e), 'error');
        } finally {
            state.busy = false;
            await refresh();
        }
    }

    async function choose() {
        if (state.busy) return;
        const fn = api().agencyPackChoose;
        if (typeof fn !== 'function') return toast('Agency packs are not available in this build', 'error');
        state.busy = true; render();
        try {
            const r = await fn();
            if (!r || r.canceled) return;
            if (!r.success) return toast(r.error || 'That file is not a valid agency pack', 'error');
            state.pending = { filePath: r.filePath, summary: r.summary || {} };
        } catch (e) {
            toast('Could not read that pack: ' + (e && e.message || e), 'error');
        } finally {
            state.busy = false; render();
        }
    }

    async function install() {
        if (state.busy || !state.pending) return;
        state.busy = true; render();
        try {
            const r = await api().agencyPackInstall(state.pending.filePath);
            if (!r || !r.success) return toast((r && r.error) || 'Install failed', 'error');
            const p = r.pack || {};
            const verb = p.previousVersion ? `updated (was ${p.previousVersion})` : 'installed';
            toast(`${p.name || 'Agency pack'} ${verb}: ${p.templateCount || 0} templates`, 'success');
            state.pending = null;
            delete state.verify[p.id];
        } catch (e) {
            toast('Install failed: ' + (e && e.message || e), 'error');
        } finally {
            state.busy = false;
            await refresh();
        }
    }

    async function verify(id) {
        if (state.busy) return;
        state.busy = true; state.verify[id] = { running: true }; render();
        try {
            const r = await api().agencyPackVerify(id);
            if (!r || !r.success) state.verify[id] = { ok: false, problems: [(r && r.error) || 'Check failed'] };
            else state.verify[id] = { ok: !!r.ok, problems: r.problems || [], fileCount: r.fileCount };
        } catch (e) {
            state.verify[id] = { ok: false, problems: [String(e && e.message || e)] };
        } finally {
            state.busy = false; render();
        }
    }

    async function remove(id) {
        if (state.busy) return;
        const p = state.packs.find(x => x.id === id) || { id };
        const ok = await confirmBox(
            `Remove "${p.name || id}"?\n\nIts templates are deleted from this computer. Documents you already made stay in your cases. You can install the pack again later.`,
            { danger: true, okText: 'Remove pack' });
        if (!ok) return;
        state.busy = true; render();
        try {
            const r = await api().agencyPackRemove(id);
            if (!r || !r.success) toast((r && r.error) || 'Remove failed', 'error');
            else toast(`${p.name || id} removed`, 'success');
            delete state.verify[id];
        } catch (e) {
            toast('Remove failed: ' + (e && e.message || e), 'error');
        } finally {
            state.busy = false;
            await refresh();
        }
    }

    function renderPending() {
        const pd = state.pending;
        if (!pd) return '';
        const s = pd.summary || {};
        let note = '';
        if (s.installedVersion && s.installedVersion === s.packVersion) {
            note = `<p class="text-[11px] text-amber-300 mt-2">Version ${esc(s.packVersion)} is already installed. Installing again replaces it with this copy.</p>`;
        } else if (s.installedVersion) {
            note = `<p class="text-[11px] text-viper-cyan mt-2">Replaces installed version ${esc(s.installedVersion)}.</p>`;
        }
        const counties = Array.isArray(s.counties) && s.counties.length
            ? `<div><span class="text-gray-500">Counties:</span> ${s.counties.map(esc).join(', ')}</div>` : '';
        return `
            <div class="mt-3 p-3 rounded-lg border border-viper-cyan/40 bg-viper-cyan/5" data-ap-pending>
                <div class="text-sm text-white font-semibold">${esc(s.name || s.id)} <span class="text-gray-400 font-normal">v${esc(s.packVersion)}</span></div>
                ${s.agency ? `<div class="text-xs text-gray-300">${esc(s.agency)}</div>` : ''}
                ${s.description ? `<div class="text-xs text-gray-400 mt-1">${esc(s.description)}</div>` : ''}
                <div class="text-xs text-gray-300 mt-2 space-y-0.5">
                    <div><span class="text-gray-500">Templates:</span> ${esc(s.templateCount || 0)}${s.sizeBytes ? ` · ${esc(fmtSize(s.sizeBytes))}` : ''}</div>
                    ${categoryText(s.categories) ? `<div><span class="text-gray-500">Categories:</span> ${categoryText(s.categories)}</div>` : ''}
                    ${counties}
                </div>
                ${note}
                <div class="flex gap-2 mt-3">
                    <button type="button" data-ap-act="install" ${state.busy ? 'disabled' : ''}
                        class="px-3 py-1.5 text-xs rounded-lg bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan text-viper-cyan disabled:opacity-50">Install</button>
                    <button type="button" data-ap-act="cancel" ${state.busy ? 'disabled' : ''}
                        class="px-3 py-1.5 text-xs rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-700/40">Cancel</button>
                </div>
            </div>`;
    }

    function renderVerify(id) {
        const v = state.verify[id];
        if (!v) return '';
        if (v.running) return '<div class="text-[11px] text-gray-400 mt-1">Checking every file…</div>';
        if (v.ok) return `<div class="text-[11px] text-emerald-400 mt-1">✓ All ${esc(v.fileCount || '')} files match the pack.</div>`;
        const list = (v.problems || []).slice(0, 5).map(p => `<li>${esc(p)}</li>`).join('');
        const more = (v.problems || []).length > 5 ? `<li>…and ${v.problems.length - 5} more</li>` : '';
        return `<div class="text-[11px] text-rose-300 mt-1">✗ Problems found — reinstall the pack:<ul class="list-disc ml-5">${list}${more}</ul></div>`;
    }

    function renderPack(p) {
        if (p.error) {
            return `
                <div class="p-3 rounded-lg border border-rose-500/40 bg-rose-500/5">
                    <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                            <div class="text-sm text-white">${esc(p.id)}</div>
                            <div class="text-[11px] text-rose-300">${esc(p.error)}</div>
                        </div>
                        <button type="button" data-ap-act="remove" data-ap-id="${esc(p.id)}" ${state.busy ? 'disabled' : ''}
                            class="px-2.5 py-1 text-xs rounded border border-rose-500/50 text-rose-300 hover:bg-rose-500/10">Remove</button>
                    </div>
                </div>`;
        }
        const meta = [
            `v${esc(p.packVersion)}`,
            `${esc(p.templateCount || 0)} templates`,
            p.installedAt ? `installed ${esc(fmtDate(p.installedAt))}` : '',
        ].filter(Boolean).join(' · ');
        return `
            <div class="p-3 rounded-lg border border-gray-700/60 bg-viper-dark/40" data-ap-pack="${esc(p.id)}">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-sm text-white font-semibold">${esc(p.name || p.id)}</div>
                        ${p.agency ? `<div class="text-xs text-gray-300">${esc(p.agency)}</div>` : ''}
                        <div class="text-[11px] text-gray-400 mt-0.5">${meta}</div>
                        ${categoryText(p.categories) ? `<div class="text-[11px] text-gray-500 mt-0.5">${categoryText(p.categories)}</div>` : ''}
                    </div>
                    <div class="flex flex-wrap justify-end gap-2 shrink-0">
                        ${editorReady() ? `<button type="button" data-ap-act="edit" data-ap-id="${esc(p.id)}" ${state.busy ? 'disabled' : ''}
                            class="px-2.5 py-1 text-xs rounded border border-viper-cyan/60 text-viper-cyan hover:bg-viper-cyan/10 disabled:opacity-50">Edit</button>` : ''}
                        ${typeof api().agencyPackExport === 'function' ? `<button type="button" data-ap-act="export" data-ap-id="${esc(p.id)}" ${state.busy ? 'disabled' : ''}
                            class="px-2.5 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700/40 disabled:opacity-50" title="Save a copy of this pack as a .viperpack file to give to other officers">Export…</button>` : ''}
                        <button type="button" data-ap-act="verify" data-ap-id="${esc(p.id)}" ${state.busy ? 'disabled' : ''}
                            class="px-2.5 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700/40 disabled:opacity-50">Check files</button>
                        <button type="button" data-ap-act="remove" data-ap-id="${esc(p.id)}" ${state.busy ? 'disabled' : ''}
                            class="px-2.5 py-1 text-xs rounded border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 disabled:opacity-50">Remove</button>
                    </div>
                </div>
                ${renderVerify(p.id)}
                ${renderUnsaved(p.id)}
            </div>`;
    }

    // An installed pack with edits that were never saved.
    function renderUnsaved(id) {
        const d = (state.drafts || []).find(x => x.id === id && x.installed && x.dirty && !x.error);
        if (!d || !editorReady()) return '';
        return `
                <div class="mt-2 flex items-center justify-between gap-3 text-[11px] text-amber-300" data-ap-unsaved="${esc(id)}">
                    <span>Unsaved changes${d.updatedAt ? ` from ${esc(fmtDate(d.updatedAt))}` : ''}. They are not in the pack yet — open Edit and Save pack to use them.</span>
                    <button type="button" data-ap-act="discard" data-ap-id="${esc(id)}" ${state.busy ? 'disabled' : ''}
                        class="shrink-0 px-2 py-0.5 rounded border border-amber-500/40 hover:bg-amber-500/10 disabled:opacity-50">Throw away</button>
                </div>`;
    }

    // Packs started here that were never saved.
    function renderDrafts() {
        const list = (state.drafts || []).filter(d => !d.installed);
        if (!list.length || !editorReady()) return '';
        const row = (d) => d.error ? `
                <div class="p-3 rounded-lg border border-rose-500/40 bg-rose-500/5 flex items-center justify-between gap-3">
                    <div class="min-w-0"><div class="text-sm text-white">${esc(d.id)}</div><div class="text-[11px] text-rose-300">${esc(d.error)}</div></div>
                    <button type="button" data-ap-act="discard" data-ap-id="${esc(d.id)}" ${state.busy ? 'disabled' : ''}
                        class="px-2.5 py-1 text-xs rounded border border-rose-500/50 text-rose-300 hover:bg-rose-500/10">Delete</button>
                </div>` : `
                <div class="p-3 rounded-lg border border-dashed border-gray-600 bg-viper-dark/30 flex items-start justify-between gap-3" data-ap-draft="${esc(d.id)}">
                    <div class="min-w-0">
                        <div class="text-sm text-white font-semibold">${esc(d.name || d.id)} <span class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-normal bg-amber-500/15 text-amber-300 border border-amber-500/30">Not saved yet</span></div>
                        ${d.agency ? `<div class="text-xs text-gray-300">${esc(d.agency)}</div>` : ''}
                        <div class="text-[11px] text-gray-400 mt-0.5">${esc(d.templateCount || 0)} templates${d.updatedAt ? ` · last change ${esc(fmtDate(d.updatedAt))}` : ''}</div>
                    </div>
                    <div class="flex gap-2 shrink-0">
                        <button type="button" data-ap-act="resume" data-ap-id="${esc(d.id)}" ${state.busy ? 'disabled' : ''}
                            class="px-2.5 py-1 text-xs rounded border border-viper-cyan/60 text-viper-cyan hover:bg-viper-cyan/10 disabled:opacity-50">Continue</button>
                        <button type="button" data-ap-act="discard" data-ap-id="${esc(d.id)}" ${state.busy ? 'disabled' : ''}
                            class="px-2.5 py-1 text-xs rounded border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 disabled:opacity-50">Delete</button>
                    </div>
                </div>`;
        return `
                <div class="mt-3 space-y-2" data-ap-drafts>
                    <div class="text-[11px] uppercase tracking-wide text-gray-500">Packs you are making</div>
                    ${list.map(row).join('')}
                </div>`;
    }

    function renderCreate() {
        const c = state.create;
        if (!c) return '';
        const IN = 'w-full px-2.5 py-1.5 text-sm rounded-lg bg-viper-dark border border-gray-600 text-white focus:border-viper-cyan focus:outline-none';
        return `
            <div class="mt-3 p-3 rounded-lg border border-viper-cyan/40 bg-viper-cyan/5" data-ap-create>
                <div class="text-sm text-white font-semibold">Create a pack</div>
                <p class="text-[11px] text-gray-400 mt-0.5">Next you add your agency's Word templates. Mark each blank in Word as <span class="text-gray-200">[Field Name]</span> and highlight it; VIPER turns those into a form.</p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                    <label class="text-[11px] text-gray-400">Pack name
                        <input data-ap-new="name" maxlength="120" value="${esc(c.name)}" placeholder="e.g. Search Warrant Packet" class="${IN} mt-0.5"></label>
                    <label class="text-[11px] text-gray-400">Agency
                        <input data-ap-new="agency" maxlength="120" value="${esc(c.agency)}" placeholder="e.g. Anytown Police Department" class="${IN} mt-0.5"></label>
                    <label class="text-[11px] text-gray-400 md:col-span-2">Description <span class="text-gray-600">(optional)</span>
                        <input data-ap-new="description" maxlength="1000" value="${esc(c.description)}" placeholder="What the pack is for, who keeps it up to date" class="${IN} mt-0.5"></label>
                </div>
                <div class="flex gap-2 mt-3">
                    <button type="button" data-ap-act="create-go" ${state.busy ? 'disabled' : ''}
                        class="px-3 py-1.5 text-xs rounded-lg bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan text-viper-cyan disabled:opacity-50">Create and add templates</button>
                    <button type="button" data-ap-act="create-cancel" ${state.busy ? 'disabled' : ''}
                        class="px-3 py-1.5 text-xs rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-700/40">Cancel</button>
                </div>
            </div>`;
    }

    function render() {
        if (!mountEl) return;
        const packs = state.packs || [];
        mountEl.innerHTML = `
            <div class="p-4 bg-viper-dark/50 rounded-lg border border-gray-700/50">
                <div class="flex items-start justify-between gap-3">
                    <div class="pr-2">
                        <h4 class="text-white font-semibold text-sm">Agency template packs</h4>
                        <p class="text-xs text-gray-400 mt-1">Install the <span class="text-gray-300">.viperpack</span> file your agency gave you to fill its own Word warrant templates from the Warrant Author tab on a case${editorReady() ? `, or create your own pack from your agency's Word templates. Use <span class="text-gray-300">Edit</span> to change an installed pack and <span class="text-gray-300">Export…</span> to give a copy to other officers` : ''}. The templates stay on this computer and are included in VIPER backups.</p>
                    </div>
                    <div class="shrink-0 flex flex-col gap-2 items-stretch">
                        <button type="button" data-ap-act="choose" ${state.busy ? 'disabled' : ''}
                            class="px-3 py-1.5 text-xs rounded-lg bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan text-viper-cyan disabled:opacity-50">Install pack…</button>
                        ${editorReady() ? `<button type="button" data-ap-act="create" ${state.busy || state.create ? 'disabled' : ''}
                            class="px-3 py-1.5 text-xs rounded-lg border border-gray-600 text-gray-200 hover:bg-gray-700/40 disabled:opacity-50">Create a pack…</button>` : ''}
                    </div>
                </div>
                ${renderCreate()}
                ${renderPending()}
                <div class="mt-3 space-y-2">
                    ${packs.length ? packs.map(renderPack).join('') : '<div class="text-xs text-gray-500 italic">No agency packs installed.</div>'}
                </div>
                ${renderDrafts()}
                ${creditHtml()}
            </div>`;
    }

    // Acknowledgement for the officer whose Warrant Builder this feature is built on.
    function creditHtml() {
        return `
                <div class="mt-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 flex items-start gap-2.5" data-ap-credit>
                    <svg class="w-4 h-4 mt-0.5 shrink-0 text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/>
                    </svg>
                    <div class="text-xs text-gray-300 leading-relaxed">
                        <span class="text-amber-200 font-semibold">Thank you, Det. Rob Aron — Westminster Police Department.</span>
                        Agency template packs are built on the Warrant Builder that Det. Aron wrote and generously shared,
                        including the code that turns an agency's Word templates into fillable forms. His work made this
                        feature possible for investigators everywhere.
                    </div>
                </div>`;
    }

    function onClick(e) {
        const b = e.target && e.target.closest && e.target.closest('[data-ap-act]');
        if (!b || b.disabled) return;
        const act = b.getAttribute('data-ap-act');
        const id = b.getAttribute('data-ap-id');
        if (act === 'choose') choose();
        else if (act === 'install') install();
        else if (act === 'cancel') { state.pending = null; render(); }
        else if (act === 'verify') verify(id);
        else if (act === 'remove') remove(id);
        else if (act === 'create') {
            state.create = { name: '', agency: '', description: '' };
            render();
            const el = mountEl && mountEl.querySelector('[data-ap-new="name"]');
            if (el) el.focus();
        }
        else if (act === 'create-go') createPack();
        else if (act === 'create-cancel') { state.create = null; render(); }
        else if (act === 'edit') openEditor({ id, mode: 'edit' });
        else if (act === 'resume') openEditor({ id, mode: 'resume' });
        else if (act === 'export') exportPack(id);
        else if (act === 'discard') discardDraft(id);
    }

    // Keep what is typed in the create form across re-renders; Enter creates.
    function onInput(e) {
        const k = e.target && e.target.getAttribute && e.target.getAttribute('data-ap-new');
        if (k && state.create) state.create[k] = e.target.value;
    }
    function onKeyDown(e) {
        if (e.key === 'Enter' && e.target && e.target.getAttribute && e.target.getAttribute('data-ap-new')) {
            e.preventDefault();
            createPack();
        }
    }

    function mount(el) {
        mountEl = el || document.getElementById('agencyPacksMount');
        if (!mountEl) return;
        if (!mountEl.__apWired) {
            mountEl.__apWired = true;
            mountEl.addEventListener('click', onClick);
            mountEl.addEventListener('input', onInput);
            mountEl.addEventListener('keydown', onKeyDown);
        }
        render();
        refresh();
    }

    const API = { mount, refresh, _state: state };
    if (typeof window !== 'undefined') {
        window.ViperAgencyPacksSettings = API;
        const boot = () => { if (document.getElementById('agencyPacksMount')) mount(); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }
})();
