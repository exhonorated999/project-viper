/**
 * Cellebrite (Mobile Forensics) — Renderer UI
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1.2 — Device + Apps + Contacts sub-tabs render real data.
 * Phase 1.3 — Calls / SMS / Accounts / Wi-Fi panes render real data
 *             from parsed/{surface}.json.
 *
 *   - Import-list rail (left), with "Import Bundle" button + "Delete" per row
 *   - Sub-tab pill row (Device | Apps | Contacts | Calls | Messages | Accounts | Wi-Fi)
 *   - Sub-tab pane = surface-specific render
 *   - Empty state = bundle picker with explainer
 *
 * Import flow: pick → scan → confirm-modal → import + progress overlay → toast.
 */

class CellebriteUI {
    constructor(mod) {
        this.module = mod;
        // Per-surface in-flight load tokens to avoid race conditions on rapid
        // sub-tab switching.
        this._loadToken = 0;
        // Phase 1.4 — persisted filter state across sub-tab switches.
        // Survives renderActivePane() rebuilds since render() does NOT reset these.
        this._search = { apps: '', contacts: '', calls: '', sms: '', accounts: '', wifi: '', media: '' };
        this._secondaryFilters = { calls: 'all', sms: 'all', media: 'all' };
        // Debounce token per surface — keystrokes coalesce into a single filter pass.
        this._filterDebounce = {};
        // Phase 1.4 — virtualization for calls + sms.
        // _rowCache holds precomputed {searchText, dir/threadId, item} arrays
        // keyed by importId so re-mounts skip the rebuild.
        // _vlists holds the active CellebriteVirtualList instance per surface.
        this._rowCache = { calls: new Map(), sms: new Map() };
        this._vlists = { calls: null, sms: null };
        // Phase 1.4 UI parity — Comms three-pane state (per-instance, persists
        // across pane re-renders; cleared only when active import changes).
        this._comms = { activeKey: '', search: '', dirFilter: 'all', lastImportId: null };
        // Phase 1.4 UI parity — Artifacts facet-filter state.
        this._artifacts = { search: '', type: null, hasGps: false, flaggedOnly: false, lastImportId: null };
    }

    render() {
        const root = document.getElementById(this.module.containerId);
        if (!root) return;

        // Invalidate cached CaseLink phone index every render so new persons
        // in linked cases surface immediately on next pane hydrate.
        this._phoneIndex = null;
        // Reset per-render Case Link match cache (consumed by badge click handlers).
        this._clMatchCache = new Map();

        const imports = this.module.data.imports || [];
        if (imports.length === 0) {
            root.innerHTML = this.renderEmptyState();
            this.wireEmptyStateEvents(root);
            return;
        }

        root.innerHTML = `
            <div class="cellebrite-shell flex flex-col h-full">
                ${this.renderTopBar(imports)}
                ${this.renderSubTabBar()}
                <div class="cellebrite-pane flex-1 overflow-auto p-6" id="cellebritePane">
                    ${this.renderActivePane()}
                </div>
            </div>
        `;
        this.wireMainEvents(root);

        // Kick off lazy load for the active sub-tab.
        this._hydrateActivePane();

        // Render the Insights Coach drawer (if module wired one in) — overlays the shell
        // but lives inside the shell DIV so it scrolls / hides with the tab.
        const shell = root.querySelector('.cellebrite-shell');
        if (this.module.coach && shell) {
            this.module.coach.render(shell);
        }
    }

    // ─── Empty state ─────────────────────────────────────────────────────

    renderEmptyState() {
        return `
            <div class="cellebrite-empty glass-card p-8 rounded-xl max-w-3xl mx-auto mt-8">
                <div class="text-center">
                    <div class="text-5xl mb-4">📱</div>
                    <h2 class="text-2xl font-bold text-white mb-2">Cellebrite (Mobile Forensics)</h2>
                    <p class="text-gray-400 mb-6">
                        Import a UFED raw filesystem extraction (<code class="text-viper-cyan">.ufdx</code> bundle).
                        Surfaces: Device, Installed Apps, Contacts, Call Log, SMS / MMS, Accounts, Wi-Fi.
                    </p>
                    <button id="cellebriteImportBtn"
                            class="px-6 py-3 bg-viper-orange/20 hover:bg-viper-orange/30 border-2 border-viper-orange rounded-lg text-viper-orange font-semibold transition flex items-center gap-2 mx-auto">
                        <span class="text-xl">📂</span>
                        Import Cellebrite Bundle
                    </button>
                    <p class="text-xs text-gray-500 mt-4">
                        Pick the <code>EvidenceCollection.ufdx</code> file. VIPER scans the bundle's
                        FileSystem dump(s) and selectively extracts only the SQLite databases + Wi-Fi config —
                        the 48GB zip is never fully unpacked.
                    </p>
                </div>
            </div>
        `;
    }

    // ─── Per-row flag button helper (used in Phase 1.3 panes) ───────────
    _flagBtn(section, key) {
        const flagged = this.module.isFlagged(section, key);
        const cls = flagged
            ? 'bg-amber-500/25 border-amber-400 text-amber-100'
            : 'bg-viper-card/30 border-gray-700 text-gray-500 hover:border-amber-400 hover:text-amber-300';
        return `<button class="cb-flag-toggle inline-flex items-center justify-center w-7 h-7 rounded border ${cls} transition text-sm"
                       data-cb-flag-section="${this.escape(section)}"
                       data-cb-flag-key="${this.escape(key)}"
                       title="${flagged ? 'Click to unflag' : 'Click to flag this row for evidence bundle'}">
                    ${flagged ? '🚩' : '⚐'}
                </button>`;
    }

    // ─── Phase 1.4 — pane search bar + filter helpers ───────────────────
    /**
     * Search input with persisted value + inline clear (×) button + Esc-to-clear.
     * Surface key is one of: 'apps' | 'contacts' | 'calls' | 'sms' | 'accounts' | 'wifi'.
     */
    _paneSearchBarHtml(surface, placeholder) {
        const v = this._search[surface] || '';
        const showClear = v.length > 0;
        return `
            <div class="relative">
                <input type="text"
                       id="cellebrite${this._cap(surface)}Search"
                       data-cb-search="${this.escape(surface)}"
                       value="${this.escape(v)}"
                       placeholder="${this.escape(placeholder)}"
                       class="pl-3 pr-8 py-2 bg-viper-card/40 border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-viper-cyan w-64" />
                <button type="button"
                        class="cb-search-clear absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded text-gray-400 hover:text-white hover:bg-viper-card/60 transition ${showClear ? '' : 'hidden'}"
                        data-cb-search-clear="${this.escape(surface)}"
                        title="Clear (Esc)">×</button>
            </div>
        `;
    }

    /**
     * "Showing X of Y" indicator. Empty span by default; populated by
     * _applyPaneFilter after every filter pass.
     */
    _paneCountHtml(surface, total) {
        return `<span id="cellebrite${this._cap(surface)}Match"
                      class="text-xs text-gray-400 ml-2"
                      data-cb-count="${this.escape(surface)}"
                      data-total="${total}"></span>`;
    }

    _cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    /**
     * Wrap a wide horizontally-scrolling section with BOTH a top mirror
     * scrollbar AND the natural bottom one — useful for tables that exceed
     * the viewport width when there are many rows (the bottom scrollbar
     * sits past the rows and is unreachable without scrolling-to-bottom).
     *
     * Usage:
     *   ${this._topScrollWrap(`<table ... min-w-[Npx]>...</table>`, 900)}
     *
     * The wrapper itself uses `glass-card rounded-xl` so the caller can
     * drop the same chrome from their own div.
     */
    _topScrollWrap(innerHtml, minWidthPx) {
        const mw = Math.max(0, Number(minWidthPx) || 0);
        return `
            <div class="glass-card rounded-xl overflow-hidden" data-cb-topscroll-wrap>
                <div class="cb-topscroll-top" data-cb-topscroll-top
                     style="overflow-x:auto;overflow-y:hidden;height:14px;border-bottom:1px solid rgba(34,211,238,0.08);">
                    <div data-cb-topscroll-ghost style="height:1px;width:${mw}px;"></div>
                </div>
                <div class="cb-topscroll-bottom" data-cb-topscroll-bottom
                     style="overflow-x:auto;">
                    ${innerHtml}
                </div>
            </div>
        `;
    }

    /**
     * Wire every `[data-cb-topscroll-wrap]` block inside `pane` so the
     * top mirror scrollbar's scrollLeft mirrors the bottom container's,
     * and vice versa. Also installs a ResizeObserver so the ghost width
     * matches the actual scrollable content width even when the table
     * grows/shrinks (e.g. filter changes, virtualization).
     */
    _wireTopScrollSync(pane) {
        if (!pane) return;
        const wraps = pane.querySelectorAll('[data-cb-topscroll-wrap]');
        for (const wrap of wraps) {
            const top    = wrap.querySelector('[data-cb-topscroll-top]');
            const ghost  = wrap.querySelector('[data-cb-topscroll-ghost]');
            const bottom = wrap.querySelector('[data-cb-topscroll-bottom]');
            if (!top || !ghost || !bottom) continue;

            // Avoid re-binding if _hydrateActivePane runs twice on the same pane.
            if (wrap._cbTopScrollBound) continue;
            wrap._cbTopScrollBound = true;

            let syncing = false;
            const onTop = () => {
                if (syncing) return;
                syncing = true;
                bottom.scrollLeft = top.scrollLeft;
                syncing = false;
            };
            const onBottom = () => {
                if (syncing) return;
                syncing = true;
                top.scrollLeft = bottom.scrollLeft;
                syncing = false;
            };
            top.addEventListener('scroll', onTop, { passive: true });
            bottom.addEventListener('scroll', onBottom, { passive: true });

            // Match ghost width to bottom's actual scrollWidth so the top
            // scrollbar's thumb proportions match the content's.
            const measure = () => {
                const w = bottom.scrollWidth || 0;
                if (w && ghost.style.width !== `${w}px`) {
                    ghost.style.width = `${w}px`;
                }
                // Hide the top track when nothing overflows.
                if (w <= bottom.clientWidth + 1) {
                    top.style.display = 'none';
                } else {
                    top.style.display = '';
                }
            };
            measure();

            if (typeof ResizeObserver !== 'undefined') {
                try {
                    const ro = new ResizeObserver(measure);
                    ro.observe(bottom);
                    // Also observe the first child (the table) — its width
                    // changes more reliably than the scroll container's.
                    const inner = bottom.firstElementChild;
                    if (inner) ro.observe(inner);
                    wrap._cbTopScrollRO = ro;
                } catch (_) {}
            } else {
                // Fallback: poll a few times early then settle.
                let n = 0;
                const tick = () => { measure(); if (++n < 10) setTimeout(tick, 100); };
                tick();
            }
        }
    }

    /**
     * Token-AND substring match across row text. Quote-wrap a multi-word
     * phrase to require contiguity ("john doe").
     */
    _matchesQuery(rowText, q) {
        if (!q) return true;
        const hay = rowText.toLowerCase();
        // Split on whitespace but respect "double-quoted phrases".
        const tokens = [];
        const re = /"([^"]+)"|(\S+)/g;
        let m;
        while ((m = re.exec(q)) !== null) tokens.push((m[1] || m[2]).toLowerCase());
        for (const t of tokens) {
            if (!hay.includes(t)) return false;
        }
        return true;
    }

    /**
     * Apply current search + secondary-filter state to a pane in-place.
     * Single dispatch covers all 6 surfaces. For calls + sms (virtualized),
     * computes filtered absolute-indices and pushes them to the vlist.
     */
    _applyPaneFilter(pane, surface) {
        if (!pane) return;
        const q = (this._search[surface] || '').trim();
        const sec = this._secondaryFilters[surface] || 'all';

        // ── Virtualized path (calls + sms) ──────────────────────────
        if (surface === 'calls' || surface === 'sms') {
            const cache = this._rowCache[surface] && this._activeImportId
                ? this._rowCache[surface].get(this._activeImportId)
                : null;
            const vl = this._vlists[surface];
            if (!cache || !vl) return; // not yet mounted

            const filtered = [];
            for (let i = 0; i < cache.length; i++) {
                const entry = cache[i];
                if (!this._matchesQuery(entry.searchText, q)) continue;
                if (sec !== 'all') {
                    if (surface === 'calls' && entry.dir !== sec) continue;
                    if (surface === 'sms'   && entry.threadId !== sec) continue;
                }
                filtered.push(i);
            }
            vl.setFilteredIndices(filtered);

            const countEl = pane.querySelector(`[data-cb-count="${surface}"]`);
            if (countEl) {
                const filterActive = q.length > 0 || sec !== 'all';
                countEl.textContent = filterActive
                    ? `· showing ${filtered.length.toLocaleString()} of ${cache.length.toLocaleString()}`
                    : '';
                countEl.classList.toggle('text-amber-300', filterActive && filtered.length === 0);
            }
            const clearBtn = pane.querySelector(`[data-cb-search-clear="${surface}"]`);
            if (clearBtn) clearBtn.classList.toggle('hidden', q.length === 0);
            return;
        }

        // ── DOM-walk path (apps / contacts / accounts / wifi / media) ──
        // Media uses card divs, not table rows — handle separately below.
        if (surface === 'media') {
            const host = pane.querySelector('#cellebriteMediaGrid');
            if (!host) return;
            const cards = host.querySelectorAll('.cb-media-card');
            let shown = 0;
            const total = cards.length;
            for (const card of cards) {
                const name = card.dataset.cbMediaSearch || '';
                const cat  = card.dataset.cbMediaCat || '';
                let visible = this._matchesQuery(name, q);
                if (visible && sec !== 'all') visible = (cat === sec);
                card.style.display = visible ? '' : 'none';
                if (visible) shown++;
            }
            const empty = host.querySelector('#cellebriteMediaEmpty');
            if (empty) {
                const filterActive = q.length > 0 || sec !== 'all';
                empty.classList.toggle('hidden', !(total > 0 && shown === 0 && filterActive));
            }
            const countEl = pane.querySelector(`[data-cb-count="${surface}"]`);
            if (countEl) {
                const filterActive = q.length > 0 || sec !== 'all';
                countEl.textContent = filterActive
                    ? `· showing ${shown.toLocaleString()} of ${total.toLocaleString()}`
                    : '';
                countEl.classList.toggle('text-amber-300', filterActive && shown === 0);
            }
            // Toggle "selected" styling on category chips.
            pane.querySelectorAll('[data-cb-secondary="media"]').forEach(btn => {
                const v = btn.dataset.cbSecondaryValue;
                const on = (v === sec);
                btn.classList.toggle('bg-viper-cyan', on);
                btn.classList.toggle('text-viper-dark', on);
                btn.classList.toggle('border-viper-cyan', on);
                btn.classList.toggle('bg-viper-card/40', !on);
                btn.classList.toggle('text-gray-300', !on);
                btn.classList.toggle('border-gray-600/40', !on);
            });
            const clearBtn = pane.querySelector(`[data-cb-search-clear="${surface}"]`);
            if (clearBtn) clearBtn.classList.toggle('hidden', q.length === 0);
            return;
        }

        // ── DOM-walk path (apps / contacts / accounts / wifi) ────────
        const rowSel = ({
            apps: '.cellebrite-app-row',
            contacts: '.cellebrite-contact-row',
            accounts: '.cellebrite-account-row',
            wifi: '.cellebrite-wifi-row',
        })[surface];
        if (!rowSel) return;

        const rows = pane.querySelectorAll(rowSel);
        let shown = 0;
        const total = rows.length;

        for (const tr of rows) {
            const txt = tr.textContent;
            const visible = this._matchesQuery(txt, q);
            tr.style.display = visible ? '' : 'none';
            if (visible) shown++;
        }

        const countEl = pane.querySelector(`[data-cb-count="${surface}"]`);
        if (countEl) {
            const filterActive = q.length > 0;
            countEl.textContent = filterActive
                ? `· showing ${shown.toLocaleString()} of ${total.toLocaleString()}`
                : '';
            countEl.classList.toggle('text-amber-300', filterActive && shown === 0);
        }

        // Empty-state row (one shared per pane, injected lazily on first miss).
        let empty = pane.querySelector('.cb-empty-filter-row');
        const tbody = pane.querySelector('tbody');
        const filterActive = q.length > 0;
        if (total > 0 && shown === 0 && filterActive && tbody) {
            if (!empty) {
                const colCount = pane.querySelectorAll('thead tr th').length || 6;
                const tr = document.createElement('tr');
                tr.className = 'cb-empty-filter-row';
                tr.innerHTML = `<td colspan="${colCount}" class="px-3 py-6 text-center text-sm text-gray-500">
                    No rows match this filter.
                    <button type="button" class="cb-search-clear text-viper-cyan hover:underline ml-1" data-cb-search-clear="${this.escape(surface)}">Clear</button>
                </td>`;
                tbody.appendChild(tr);
            } else {
                empty.style.display = '';
            }
        } else if (empty) {
            empty.style.display = 'none';
        }

        const clearBtn = pane.querySelector(`[data-cb-search-clear="${surface}"]`);
        if (clearBtn && !clearBtn.classList.contains('text-viper-cyan')) {
            clearBtn.classList.toggle('hidden', q.length === 0);
        }
    }

    /**
     * Debounced input → state update → filter pass.
     */
    _scheduleFilter(pane, surface, ms = 60) {
        clearTimeout(this._filterDebounce[surface]);
        this._filterDebounce[surface] = setTimeout(() => this._applyPaneFilter(pane, surface), ms);
    }

    /**
     * Reset search + secondary filter for one surface and re-apply.
     */
    _clearPaneFilter(pane, surface) {
        this._search[surface] = '';
        // Don't auto-reset secondary filters on a search clear — user may want
        // to keep the direction/thread choice. They can change it explicitly.
        const input = pane.querySelector(`[data-cb-search="${surface}"]`);
        if (input) input.value = '';
        this._applyPaneFilter(pane, surface);
    }


    // ─── Case Link integration (live amber badges) ──────────────────────
    /**
     * Build (or reuse) a phone → matching-case-persons index from CaseLink.
     * Cached per render to avoid recomputing for thousands of rows.
     * Returns Map<digitsOnly10, Array<{caseId, caseNumber, role, person}>>.
     */
    _ensurePhoneIndex() {
        if (this._phoneIndex) return this._phoneIndex;
        const m = new Map();
        if (typeof window !== 'undefined' && window.CaseLink && typeof window.CaseLink.buildIndex === 'function') {
            try {
                const idx = window.CaseLink.buildIndex();
                const myCaseId = String(this.module.caseId);
                for (const entry of (idx.entries || [])) {
                    if (String(entry.caseId) === myCaseId) continue; // exclude self
                    for (const p of (entry.person.phones || [])) {
                        const k = String(p);
                        if (k.length < 7) continue;
                        // Index on both full and last-10-digits for US normalization.
                        const last10 = k.slice(-10);
                        if (!m.has(last10)) m.set(last10, []);
                        m.get(last10).push(entry);
                        if (k !== last10 && !m.has(k)) m.set(k, []);
                        if (k !== last10) m.get(k).push(entry);
                    }
                }
            } catch (_) { /* index unavailable — skip badges */ }
        }
        this._phoneIndex = m;
        return m;
    }

    _caseLinkMatchesForPhone(rawPhone) {
        if (!rawPhone) return [];
        const digits = String(rawPhone).replace(/\D+/g, '');
        if (digits.length < 7) return [];
        const idx = this._ensurePhoneIndex();
        const last10 = digits.slice(-10);
        const hits = idx.get(last10) || idx.get(digits) || [];
        // Dedup by caseId|role|name
        const seen = new Set();
        const out = [];
        for (const h of hits) {
            const k = `${h.caseId}|${h.role}|${(h.person.lastName || '')},${(h.person.firstName || '')}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(h);
        }
        return out;
    }

    _caseLinkMatchesForContact(c) {
        if (!c || typeof window === 'undefined' || !window.CaseLink || typeof window.CaseLink.findMatches !== 'function') return [];
        // Split display name (best effort) — fall back to phones.
        const name = (c.displayName || '').trim();
        if (!name && !(c.phones || []).length) return [];
        const matches = window.CaseLink.findMatches({ name }, {
            excludeCaseId: this.module.caseId,
        }) || [];
        // Drop LOW confidence to reduce noise on a busy contacts list.
        return matches.filter(m => m.confidence !== 'LOW');
    }

    _caseLinkBadgeHtml(matches, role) {
        if (!matches || !matches.length) return '';
        // Stash the first match (used by Open/Link actions) in a per-render cache so
        // the click handler can hand the full object to handleCaseLinkBadgeClick.
        if (!this._clMatchCache) this._clMatchCache = new Map();
        const id = `cl-${this._clMatchCache.size}`;
        this._clMatchCache.set(id, { match: matches[0], role: role || matches[0].role, all: matches });
        const top = matches[0];
        const cn = this.escape(top.caseNumber || '—');
        const more = matches.length - 1;
        const lblTip = matches.slice(0, 5).map(m =>
            `${m.caseNumber}: ${(m.person && m.person.lastName) || ''} ${(m.person && m.person.firstName) || ''} (${m.role}, ${m.confidence})`
        ).join('\n');
        return `<button class="cb-caselink-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border bg-amber-500/15 text-amber-200 border-amber-500/40 hover:bg-amber-500/25 transition"
                       data-cb-cl-id="${id}"
                       title="${this.escape(lblTip)}">
                    🔗 ${cn}${more > 0 ? ` <span class="opacity-70">+${more}</span>` : ''}
                </button>`;
    }

    _onCaseLinkBadgeClick(btn) {
        const id = btn.dataset.cbClId;
        if (!id || !this._clMatchCache || !this._clMatchCache.has(id)) return;
        const entry = this._clMatchCache.get(id);
        const match = entry.match;
        const role = entry.role;

        // Try the page-supplied richer handler first (gives Import / Link / Open popover).
        if (typeof window !== 'undefined' && typeof window.handleCaseLinkBadgeClick === 'function') {
            try {
                window.handleCaseLinkBadgeClick(
                    match,
                    btn,
                    { role, currentCaseId: this.module.caseId, root: document.getElementById(this.module.containerId) }
                );
                return;
            } catch (_) { /* fall through to navigation */ }
        }
        // Bare default: navigate to that case.
        try {
            if (match && match.caseNumber) {
                window.location.href = 'case-detail-with-analytics.html?case=' + encodeURIComponent(match.caseNumber);
            }
        } catch (_) {}
    }

    wireEmptyStateEvents(root) {
        const btn = root.querySelector('#cellebriteImportBtn');
        if (btn) btn.addEventListener('click', () => this.onImportClick());
    }

    // ─── Import rail (left side) ─────────────────────────────────────────

    // ─── Top bar (replaces left rail — Datapilot-parity layout) ────────
    renderTopBar(imports) {
        const active = this.module.getActiveImport();
        const total = this.module.flagCount();
        const dev = active ? this._deriveDeviceChip(active) : null;
        const hasActive = !!active;
        const switcherDisabled = imports.length <= 1 ? '' : '';
        return `
            <div class="cb-header flex items-center justify-between gap-3 px-4 py-2.5 border-b border-viper-cyan/20 bg-viper-card/30 flex-shrink-0 flex-wrap">
                <div class="cb-header-left flex items-center gap-2 flex-wrap min-w-0">
                    <span class="text-xs uppercase tracking-wider text-gray-500 pr-1">Import</span>
                    <select id="cellebriteImportSwitcher" class="cb-import-switcher bg-viper-dark/80 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 max-w-xs" ${switcherDisabled}>
                        ${imports.map(i => {
                            const label = `${i.deviceLabel || 'device'} — ${i.evidenceTag || i.id.slice(-6)}`;
                            const sel = active && i.id === active.id ? 'selected' : '';
                            return `<option value="${this.escape(i.id)}" ${sel}>${this.escape(label)}</option>`;
                        }).join('')}
                    </select>
                    ${dev ? `
                        <div class="cb-device-chip inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs text-gray-300 bg-viper-cyan/10 border border-viper-cyan/25">
                            <span class="font-medium text-gray-100">${this.escape(dev.label)}</span>
                            ${dev.tag ? `<span class="text-viper-cyan font-mono text-[11px]">${this.escape(dev.tag)}</span>` : ''}
                            ${dev.status ? `<span class="text-gray-500 text-[11px] uppercase tracking-wider">${this.escape(dev.status)}</span>` : ''}
                            ${dev.size ? `<span class="text-gray-500 text-[11px]">${this.escape(dev.size)}</span>` : ''}
                        </div>
                    ` : ''}
                </div>
                <div class="cb-header-right flex items-center gap-2 flex-shrink-0">
                    <button id="cellebriteCoachBtn"
                            class="cb-btn px-3 py-1.5 rounded text-sm border transition flex items-center gap-1.5 ${hasActive
                                ? 'bg-purple-600/20 hover:bg-purple-600/30 border-purple-500/50 text-purple-200'
                                : 'bg-viper-card/30 border-gray-700 text-gray-500 cursor-not-allowed opacity-60'}"
                            ${hasActive ? '' : 'disabled'}
                            title="Open Insights Coach — dashboards, heatmap, top contacts, GPS clusters">
                        💡 Coach
                    </button>
                    <div class="relative">
                        <button id="cellebriteFlagsBtn"
                                class="cb-btn px-3 py-1.5 rounded text-sm border transition flex items-center gap-1.5 ${hasActive
                                    ? 'bg-viper-card/60 border-amber-500/30 text-amber-200 hover:bg-amber-500/15'
                                    : 'bg-viper-card/30 border-gray-700 text-gray-500 cursor-not-allowed opacity-60'}"
                                ${hasActive ? '' : 'disabled'}
                                title="Show flag summary & push to Evidence">
                            🚩 Flags
                            <span class="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/30 text-amber-100 ml-0.5">${total}</span>
                        </button>
                        <div id="cellebriteFlagsPopover"
                             class="hidden absolute right-0 top-full mt-1 w-72 bg-viper-dark border border-amber-500/40 rounded shadow-lg p-3 z-[60]">
                            ${this._renderFlagsPopoverBody()}
                        </div>
                    </div>
                    <button id="cellebriteImportBtn"
                            class="cb-btn px-3 py-1.5 rounded text-sm bg-viper-orange/20 hover:bg-viper-orange/30 border border-viper-orange text-viper-orange transition flex items-center gap-1.5 font-medium"
                            title="Import another UFDR bundle into this case">
                        + Import
                    </button>
                    <button id="cellebriteDeleteBtn"
                            class="cb-btn px-3 py-1.5 rounded text-sm transition flex items-center gap-1.5 ${hasActive
                                ? 'bg-red-500/15 hover:bg-red-500/30 border border-red-500/40 text-red-300 hover:text-red-200'
                                : 'bg-viper-card/30 border border-gray-700 text-gray-500 cursor-not-allowed opacity-60'}"
                            ${hasActive ? '' : 'disabled'}
                            title="Delete the active import (removes parsed data on disk)">
                        🗑 Delete
                    </button>
                </div>
            </div>
        `;
    }

    _deriveDeviceChip(imp) {
        if (!imp) return null;
        const label = imp.deviceLabel || 'Unknown device';
        const tag = imp.evidenceTag || '';
        const status = imp.status === 'orphaned' ? 'orphaned'
            : imp.status === 'cancelled' ? 'paused'
            : imp.status && imp.status !== 'imported' ? imp.status
            : '';
        const size = imp.bundleSize ? this.fmtBytes(imp.bundleSize) : '';
        return { label, tag, status, size };
    }

    // ─── Flag-to-Evidence popover (replaces rail flag toolbar) ──────────
    _renderFlagsPopoverBody() {
        const imp = this.module.getActiveImport();
        if (!imp) return `<div class="text-xs text-gray-500">No active import.</div>`;
        const total = this.module.flagCount();
        const enabled = total > 0;
        const sections = ['contacts','calls','sms','accounts','wifi','media'];
        const sectionIcons = { contacts: '👤', calls: '📞', sms: '💬', accounts: '🔑', wifi: '📶', media: '🖼️' };
        const chipBits = sections.map(s => {
            const n = this.module.flagCountFor(s);
            if (!n) return '';
            return `<span class="cb-flag-chip text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-200 border border-amber-500/30">${sectionIcons[s]} ${n}</span>`;
        }).filter(Boolean).join('');

        return `
            <div class="space-y-2">
                <div class="flex items-center justify-between">
                    <div class="text-xs text-amber-200 font-semibold flex items-center gap-1.5">
                        <span>🚩</span> <span>Flags on this import</span>
                        <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-100 border border-amber-500/30">${total}</span>
                    </div>
                    <button id="cellebriteFlagClearBtn"
                            class="text-[10px] text-gray-400 hover:text-red-300 transition ${enabled ? '' : 'opacity-40 pointer-events-none'}"
                            title="Clear all flags on this import">clear all</button>
                </div>
                ${chipBits
                    ? `<div class="flex flex-wrap gap-1">${chipBits}</div>`
                    : `<div class="text-[11px] text-gray-500">Click 🚩 on contacts, calls, SMS, etc. to flag items.</div>`}
                <button id="cellebriteFlagPushBtn"
                        class="w-full px-2 py-1.5 rounded text-xs font-semibold transition flex items-center justify-center gap-1.5 ${enabled
                            ? 'bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400 text-amber-100'
                            : 'bg-viper-card/40 border border-gray-700 text-gray-500 cursor-not-allowed'}"
                        ${enabled ? '' : 'disabled'}
                        title="Push flagged items to the case Evidence module as a bundle (CW-001, CW-002, …)">
                    📥 Push to Evidence
                </button>
            </div>
        `;
    }

    _refreshFlagToolbar() {
        // Re-render the Flags pill count + popover body in place.
        const btn = document.getElementById('cellebriteFlagsBtn');
        if (btn) {
            const total = this.module.flagCount();
            const countEl = btn.querySelector('span:last-child');
            if (countEl) countEl.textContent = String(total);
        }
        const pop = document.getElementById('cellebriteFlagsPopover');
        if (pop) {
            pop.innerHTML = this._renderFlagsPopoverBody();
            // Re-wire popover-internal buttons (push + clear).
            this._wirePopoverBody(pop);
        }
    }

    _wirePopoverBody(popRoot) {
        const push = popRoot.querySelector('#cellebriteFlagPushBtn');
        if (push && !push.disabled) {
            push.addEventListener('click', () => this._onPushFlagsClick());
        }
        const clear = popRoot.querySelector('#cellebriteFlagClearBtn');
        if (clear) {
            clear.addEventListener('click', () => this._onClearFlagsClick());
        }
    }

    _wireFlagToolbar(root) {
        // Wire the Flags pill toggle + popover body (deferred — popover starts hidden).
        const pill = root.querySelector('#cellebriteFlagsBtn');
        const pop = root.querySelector('#cellebriteFlagsPopover');
        if (pill && pop) {
            pill.addEventListener('click', (ev) => {
                ev.stopPropagation();
                pop.classList.toggle('hidden');
            });
            // Click-outside dismiss.
            document.addEventListener('click', (ev) => {
                if (pop.classList.contains('hidden')) return;
                if (pop.contains(ev.target) || pill.contains(ev.target)) return;
                pop.classList.add('hidden');
            });
        }
        if (pop) this._wirePopoverBody(pop);
    }

    async _onPushFlagsClick() {
        const total = this.module.flagCount();
        if (total === 0) {
            if (typeof viperToast === 'function') viperToast('No items flagged yet — click 🚩 on rows first.', 'info');
            return;
        }
        const msg = `Push ${total} flagged item${total === 1 ? '' : 's'} to the case Evidence module as a single CW bundle?`;
        const ok = (typeof viperConfirm === 'function')
            ? await viperConfirm(msg, { okText: 'Push', danger: false })
            : confirm(msg);
        if (!ok) return;

        const push = document.getElementById('cellebriteFlagPushBtn');
        if (push) { push.disabled = true; push.textContent = '⏳ Building bundle…'; }
        try {
            const res = await this.module.pushFlagsToEvidence();
            if (res && res.success) {
                // Clear flags + re-render rail toolbar AND active pane (so 🚩 buttons reset visually).
                this.module.clearFlags();
                this.module.render();
            } else if (res && res.error) {
                if (typeof viperToast === 'function') viperToast('Push failed: ' + res.error, 'error');
            }
        } catch (e) {
            if (typeof viperToast === 'function') viperToast('Push failed: ' + e.message, 'error');
        } finally {
            this._refreshFlagToolbar();
        }
    }

    _onClearFlagsClick() {
        if (this.module.flagCount() === 0) return;
        const ok = confirm('Clear all flags on this Cellebrite import?');
        if (!ok) return;
        this.module.clearFlags();
        this.module.render();
    }

    renderImportRow(imp, active) {
        // Legacy rail row — replaced by top-bar dropdown switcher in Phase 1.4 UI parity pass.
        // Retained as a no-op for any external callers; no longer rendered.
        return '';
    }

    totalCount(c) {
        return ['apps','contacts','calls','sms','accounts','wifi','media'].reduce((s, k) => s + (c[k] || 0), 0);
    }

    // ─── Sub-tab bar ─────────────────────────────────────────────────────

    renderSubTabBar() {
        const tabs = [
            { id: 'device',    label: 'Subject',   icon: '🪪' },
            { id: 'comms',     label: 'Comms',     icon: '💬' },
            { id: 'artifacts', label: 'Artifacts', icon: '🗂️' },
            { id: 'apps',      label: 'Apps',      icon: '📦' },
            { id: 'contacts',  label: 'Contacts',  icon: '👤' },
            { id: 'calls',     label: 'Calls',     icon: '📞' },
            { id: 'sms',       label: 'Messages',  icon: '✉️' },
            { id: 'media',     label: 'Media',     icon: '🖼️' },
            { id: 'movement',  label: 'Movement',  icon: '🌍' },
            { id: 'accounts',  label: 'Accounts',  icon: '🔑' },
            { id: 'wifi',      label: 'Wi-Fi',     icon: '📶' },
        ];
        const active = this.module.activeSubTab;
        const imp = this.module.getActiveImport();
        const counts = imp && imp.counts ? imp.counts : {};
        // Phase 1.3: per-section flag count from WarrantFlags shape
        const flagged = (imp && imp.flagged) || {};
        return `
            <div class="cellebrite-subtabs flex gap-1 p-2 border-b border-viper-cyan/20 overflow-x-auto flex-shrink-0 items-center">
                ${tabs.map(t => {
                    const cls = t.id === active
                        ? 'bg-viper-cyan text-viper-dark'
                        : 'bg-viper-card/30 text-gray-300 hover:bg-viper-card/60';
                    const c = counts[t.id];
                    const cnt = (typeof c === 'number' && c > 0) ? `<span class="ml-1 text-xs opacity-70">${c}</span>` : '';
                    const flagsHere = (flagged[t.id] || []).length;
                    const flagChip = flagsHere > 0
                        ? `<span class="ml-1 text-[10px] px-1 py-0.5 rounded bg-amber-500/25 text-amber-100 border border-amber-400/50">🚩${flagsHere}</span>`
                        : '';
                    return `
                        <button class="cellebrite-subtab px-3 py-1.5 rounded text-sm font-medium transition whitespace-nowrap ${cls}" data-subtab="${t.id}">
                            <span>${t.icon}</span> <span>${t.label}</span>${cnt}${flagChip}
                        </button>
                    `;
                }).join('')}
            </div>
        `;
    }

    // ─── Active sub-tab pane ────────────────────────────────────────────

    renderActivePane() {
        const imp = this.module.getActiveImport();
        if (!imp) {
            return `<div class="text-gray-500 text-sm">Pick an import from the dropdown above, or click "+ Import" to add one.</div>`;
        }
        // Orphaned imports came in via .vcase import — the on-disk parsed/*.json
        // files (which contain the actual rows) didn't travel with the package.
        // Show a clear banner and stop here.
        if (imp.status === 'orphaned') {
            const from = imp._transferredFrom ? ` from ${this.escape(imp._transferredFrom)}` : '';
            return `
                <div class="glass-card p-6 rounded-xl border border-amber-500/40 bg-amber-500/5">
                    <div class="flex items-start gap-3">
                        <div class="text-2xl">⚠</div>
                        <div class="flex-1">
                            <h3 class="text-lg font-semibold text-amber-200 mb-1">Bundle data not transferred</h3>
                            <p class="text-sm text-amber-100/80 mb-3">
                                This Cellebrite import was carried over via .vcase package${from}, but the
                                on-disk parsed data (contacts, SMS, calls, media, ...) was NOT included —
                                same convention as Evidence files: large forensic artifacts must transfer separately.
                            </p>
                            <p class="text-sm text-gray-300 mb-3">
                                To restore full data, re-import the original UFDR bundle:
                            </p>
                            <ul class="text-sm text-gray-400 list-disc list-inside space-y-1 mb-3">
                                <li>Device: <span class="text-gray-200">${this.escape(imp.deviceLabel || 'Unknown')}</span></li>
                                <li>Evidence tag: <span class="text-gray-200">${this.escape(imp.evidenceTag || imp.id)}</span></li>
                                <li>Original bundle path: <span class="text-gray-200 font-mono text-xs">${this.escape(imp.ufdxPath || '(not recorded)')}</span></li>
                            </ul>
                            <div class="text-xs text-gray-500">
                                Click <span class="text-viper-cyan">Import Bundle</span> on the rail to re-import,
                                or remove this orphaned entry via the ✕ button.
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }
        const surface = this.module.activeSubTab;
        // Initial render shows a loading placeholder; _hydrateActivePane()
        // loads parsed JSON via IPC then re-renders the pane in place.
        if (['device', 'comms', 'artifacts', 'apps', 'contacts', 'calls', 'sms', 'accounts', 'wifi', 'media', 'movement'].includes(surface)) {
            return `
                <div id="cellebriteSurfacePane" class="space-y-4">
                    <div class="flex items-center gap-2 text-sm text-gray-400">
                        <div class="w-3 h-3 border-2 border-viper-cyan border-t-transparent rounded-full animate-spin"></div>
                        Loading ${this.escape(this.subTabLabel())}...
                    </div>
                </div>
            `;
        }
        return `<div class="text-gray-500 text-sm">Unknown surface: ${this.escape(surface)}</div>`;
    }

    _renderPhase13Placeholder(imp, surface) {
        return `
            <div class="glass-card p-6 rounded-xl">
                <h3 class="text-lg font-semibold text-white mb-2">${this.escape(this.subTabLabel())}</h3>
                <p class="text-sm text-gray-400 mb-4">
                    No data parsed for this surface in this import.
                </p>
            </div>
        `;
    }

    subTabLabel() {
        return {
            device: 'Subject', comms: 'Comms', artifacts: 'Artifacts',
            apps: 'Installed Apps', contacts: 'Contacts',
            calls: 'Call Log', sms: 'SMS / MMS', accounts: 'Accounts', wifi: 'Wi-Fi',
            media: 'Media', movement: 'Movement',
        }[this.module.activeSubTab] || this.module.activeSubTab;
    }

    // ─── Lazy load active surface and re-render the pane in place ───────
    async _hydrateActivePane() {
        const imp = this.module.getActiveImport();
        if (!imp) return;
        // Orphaned imports have no parsed data on disk — renderActivePane()
        // already painted the banner; skip the hydrate roundtrip.
        if (imp.status === 'orphaned') return;
        const surface = this.module.activeSubTab;
        if (!['device', 'comms', 'artifacts', 'apps', 'contacts', 'calls', 'sms', 'accounts', 'wifi', 'media', 'movement'].includes(surface)) return;

        // Tear down any virtualized list from a previous sub-tab to free the
        // scroll/resize listeners — host node is about to be replaced.
        this._destroyVlists();
        // Also tear down the Movement Leaflet map if it was mounted; the host
        // div is about to be discarded by the next innerHTML assignment.
        if (typeof this._destroyMovementMap === 'function') this._destroyMovementMap();
        // Same for the Subject mini geo map.
        if (typeof this._destroySubjectGeoMap === 'function') this._destroySubjectGeoMap();

        const tok = ++this._loadToken;
        // Comms + Artifacts + Movement are synthetic surfaces — they compose other
        // surfaces and have no on-disk parsed/<surface>.json. Skip the
        // primary load for them.
        const synthetic = (surface === 'comms' || surface === 'artifacts' || surface === 'movement');
        const data = synthetic
            ? null
            : await this.module.loadSurface(imp.id, surface);
        if (tok !== this._loadToken) return; // user navigated away

        // Subject + Comms need contacts/calls/sms; Artifacts needs apps + media.
        // Load in parallel; cache hits are free, so this is cheap on revisits.
        let subjectExtras = null;
        let artifactExtras = null;
        if (surface === 'device' || surface === 'comms') {
            try {
                const [contacts, calls, sms, media] = await Promise.all([
                    this.module.loadSurface(imp.id, 'contacts').catch(() => null),
                    this.module.loadSurface(imp.id, 'calls').catch(() => null),
                    this.module.loadSurface(imp.id, 'sms').catch(() => null),
                    // Pull media too so Subject can render the mini geo map.
                    // Comms ignores `media` — overhead is one cached IPC.
                    this.module.loadSurface(imp.id, 'media').catch(() => null),
                ]);
                if (tok !== this._loadToken) return;
                subjectExtras = { contacts, calls, sms, media };
            } catch (_) { /* non-fatal — subject still renders w/o */ }
        }
        if (surface === 'artifacts') {
            try {
                const [apps, media] = await Promise.all([
                    this.module.loadSurface(imp.id, 'apps').catch(() => null),
                    this.module.loadSurface(imp.id, 'media').catch(() => null),
                ]);
                if (tok !== this._loadToken) return;
                artifactExtras = { apps, media };
            } catch (_) { /* non-fatal — empty grid */ }
        }
        let movementExtras = null;
        if (surface === 'movement') {
            try {
                const [media, wifi] = await Promise.all([
                    this.module.loadSurface(imp.id, 'media').catch(() => null),
                    this.module.loadSurface(imp.id, 'wifi').catch(() => null),
                ]);
                if (tok !== this._loadToken) return;
                movementExtras = { media, wifi };
            } catch (_) { /* non-fatal */ }
        }

        const pane = document.getElementById('cellebritePane');
        if (!pane) return;

        // Comms three-pane owns its own internal scroll → strip pane padding + scroll.
        // Artifacts uses sidebar+grid that also owns its own scroll, same treatment.
        // All other surfaces use the default `overflow-auto p-6` layout.
        if (surface === 'comms' || surface === 'artifacts') {
            pane.classList.remove('overflow-auto', 'p-6');
            pane.classList.add('overflow-hidden', 'p-3');
        } else {
            pane.classList.remove('overflow-hidden', 'p-3');
            pane.classList.add('overflow-auto', 'p-6');
        }

        try {
            if      (surface === 'device')    pane.innerHTML = this.renderDevicePane(data, imp, subjectExtras);
            else if (surface === 'comms')     pane.innerHTML = this.renderCommsPane(imp, subjectExtras);
            else if (surface === 'artifacts') pane.innerHTML = this.renderArtifactsPane(imp, artifactExtras);
            else if (surface === 'apps')     pane.innerHTML = this.renderAppsPane(data, imp);
            else if (surface === 'contacts') pane.innerHTML = this.renderContactsPane(data, imp);
            else if (surface === 'calls')    pane.innerHTML = this.renderCallsPane(data, imp);
            else if (surface === 'sms')      pane.innerHTML = this.renderSmsPane(data, imp);
            else if (surface === 'accounts') pane.innerHTML = this.renderAccountsPane(data, imp);
            else if (surface === 'wifi')     pane.innerHTML = this.renderWifiPane(data, imp);
            else if (surface === 'media')    pane.innerHTML = this.renderMediaPane(data, imp);
            else if (surface === 'movement') pane.innerHTML = this.renderMovementPane(imp, movementExtras);
            this._wirePaneEvents(pane, surface);
            // Mirror-scrollbar wiring (top scrollbar that syncs with bottom).
            this._wireTopScrollSync(pane);
            // Mount virtualized lists AFTER pane innerHTML is in the DOM so
            // the scroll host has measurable layout.
            if (surface === 'calls' || surface === 'sms') {
                this._mountVirtualList(pane, surface, data, imp);
            } else if (surface === 'media') {
                this._mountMediaGrid(pane, data, imp);
            } else if (surface === 'artifacts') {
                // Artifacts reuses the media-grid observer for its media tiles.
                this._mountArtifactsMediaThumbs(pane, imp, artifactExtras);
            } else if (surface === 'movement') {
                this._mountMovementMap(pane, imp, movementExtras);
            }
            // Subject pane: mount the mini geo map if media has GPS points.
            if (surface === 'device') {
                this._mountSubjectGeoMap(pane, imp, subjectExtras);
            }
        } catch (e) {
            pane.innerHTML = `<div class="text-red-400 text-sm">Render error: ${this.escape(e.message)}</div>`;
        }
    }

    _destroyVlists() {
        for (const key of Object.keys(this._vlists || {})) {
            const vl = this._vlists[key];
            if (vl && typeof vl.destroy === 'function') {
                try { vl.destroy(); } catch (_) {}
            }
            this._vlists[key] = null;
        }
        // Media grid uses its own lifecycle (IntersectionObserver + blob URLs).
        // Tear it down here too so navigating away frees memory.
        if (typeof this._destroyMediaGrid === 'function') {
            try { this._destroyMediaGrid(); } catch (_) {}
        }
    }

    /**
     * Build a precomputed row cache for a virtualized surface.
     * Cache shape per entry: { item, searchText, dir|threadId }.
     * Memoized per importId so re-mounting a surface (e.g. tab switch and back)
     * skips the rebuild.
     */
    _buildRowCache(surface, data, imp) {
        const bucket = this._rowCache[surface];
        if (!bucket) return [];
        const cached = bucket.get(imp.id);
        if (cached) return cached;

        const out = [];
        if (surface === 'calls') {
            const calls = Array.isArray(data.calls) ? data.calls : [];
            for (const c of calls) {
                const parts = [c.number, c.contactName, c.type, c.simSlot, c.direction].filter(Boolean);
                out.push({
                    item: c,
                    searchText: parts.join(' '),
                    dir: c.direction || '',
                });
            }
        } else if (surface === 'sms') {
            const messages = Array.isArray(data.messages) ? data.messages : [];
            for (const m of messages) {
                const tid = m.threadId == null ? `_${m.address || 'unknown'}` : `t-${m.threadId}`;
                const parts = [m.address, m.body, m.subject, m.kind].filter(Boolean);
                out.push({
                    item: m,
                    searchText: parts.join(' '),
                    threadId: tid,
                });
            }
        }
        bucket.set(imp.id, out);
        return out;
    }

    /**
     * Mount a CellebriteVirtualList into the surface's #cellebrite{Surface}Vlist
     * host. Applies the current filter state via _applyPaneFilter immediately
     * after mount so persisted search/sec filters take effect on first paint.
     */
    _mountVirtualList(pane, surface, data, imp) {
        const hostId = surface === 'calls' ? 'cellebriteCallsVlist'
                     : surface === 'sms'   ? 'cellebriteSmsVlist'
                     : null;
        if (!hostId) return;
        const host = pane.querySelector(`#${hostId}`);
        if (!host) return;
        if (typeof window === 'undefined' || !window.CellebriteVirtualList) {
            console.warn('[Cellebrite] CellebriteVirtualList not loaded — falling back to non-virtual placeholder');
            host.innerHTML = `<div class="p-4 text-gray-500 text-sm">Virtualized list engine unavailable.</div>`;
            return;
        }

        // Build (or reuse) the row cache for this importId.
        this._activeImportId = imp.id;
        const cache = this._buildRowCache(surface, data, imp);

        const grid = surface === 'calls' ? this._callsGridTemplate() : this._smsGridTemplate();
        const rowHeight = surface === 'calls' ? 56 : 92;
        const renderRow = surface === 'calls'
            ? (entry) => this._renderCallRow(entry.item)
            : (entry) => this._renderSmsRow(entry.item);

        const emptyHtml = `<div class="p-6 text-center text-sm text-gray-500">
            No rows match this filter.
            <button type="button" class="cb-search-clear text-viper-cyan hover:underline ml-1"
                    data-cb-search-clear="${this.escape(surface)}">Clear</button>
        </div>`;

        // Destroy any prior instance for the same surface (should already be
        // gone via _destroyVlists, but defensive).
        if (this._vlists[surface]) {
            try { this._vlists[surface].destroy(); } catch (_) {}
            this._vlists[surface] = null;
        }
        this._vlists[surface] = new window.CellebriteVirtualList({
            host,
            rowHeight,
            items: cache,
            gridTemplate: grid,
            renderRow,
            emptyHtml,
            buffer: 6,
        });

        // Apply any persisted filter state immediately.
        this._applyPaneFilter(pane, surface);
    }

    // ─── Device pane ────────────────────────────────────────────────────
    renderDevicePane(data, imp, extras) {
        if (!data) {
            return `<div class="text-gray-500 text-sm">No device data available. Re-import to regenerate.</div>`;
        }
        const dev = data.device || {};
        const ext = data.extraction || {};
        const bp  = data.buildProp || null;
        const src = data.source || {};

        const fbeColor = {
            'unencrypted': 'text-gray-300',
            'native':      'text-amber-300',
            'aware':       'text-cyan-300',
            'unknown':     'text-gray-500',
        }[dev.fbeStatus] || 'text-gray-500';
        const fbeLabel = {
            'unencrypted': 'No FBE',
            'native':      'FBE Native (Android 10+)',
            'aware':       'FBE Aware',
            'unknown':     'Unknown',
        }[dev.fbeStatus] || dev.fbeStatus;

        const kv = (label, value, mono = false) => `
            <div class="cb-kv">
                <div class="cb-kv-label">${this.escape(label)}</div>
                <div class="cb-kv-value ${mono ? 'font-mono text-xs' : ''}">${this.escape(value || '—')}</div>
            </div>
        `;

        const topContacts = this._buildSubjectTopContacts(imp, extras);
        const sparkline   = this._buildSubjectSparkline(imp, extras);

        return `
            <div class="cb-subject space-y-6">
                <!-- Device header banner -->
                <div class="glass-card p-5 rounded-xl">
                    <div class="flex items-start justify-between gap-4 flex-wrap">
                        <div>
                            <div class="text-2xl font-semibold text-white mb-0.5">📱 ${this.escape(dev.model || '(unknown device)')}</div>
                            <div class="text-sm text-gray-400">
                                ${this.escape(dev.make || '')}${dev.make && dev.androidVersion ? ' · ' : ''}${this.escape(dev.androidVersion ? 'Android ' + dev.androidVersion : '')}
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="text-xs text-gray-500 uppercase tracking-wider">FBE Status</div>
                            <div class="text-sm font-semibold ${fbeColor}">${this.escape(fbeLabel)}</div>
                        </div>
                    </div>
                </div>

                <!-- 2-column dashboard grid -->
                <div class="cb-subject-grid grid grid-cols-1 xl:grid-cols-2 gap-6">

                    <!-- LEFT COLUMN -->
                    <div class="space-y-6">
                        <div class="glass-card p-5 rounded-xl">
                            <div class="flex items-center justify-between mb-3">
                                <h4 class="text-sm font-semibold text-white uppercase tracking-wider">Device &amp; Owner</h4>
                            </div>
                            <div class="cb-kv-grid grid grid-cols-2 gap-x-4 gap-y-2">
                                ${kv('Make', dev.make)}
                                ${kv('Model', dev.model)}
                                ${kv('Serial', dev.serial)}
                                ${kv('OS', dev.androidVersion ? 'Android ' + dev.androidVersion : (ext.osVersion || ''))}
                                ${kv('IMEI', (dev.imei || []).join(', '))}
                                ${kv('ICCID', (dev.iccid || []).join(', '))}
                                ${kv('Examiner', ext.examiner)}
                                ${kv('Case Number', ext.caseNumber)}
                                ${kv('Extraction Date', ext.date)}
                                ${kv('Tool', `${ext.tool || ''}${ext.version ? ' ' + ext.version : ''}`.trim())}
                            </div>
                            ${dev.buildFingerprint ? `
                                <div class="mt-3 pt-3 border-t border-gray-700/50">
                                    <div class="text-xs text-gray-500 mb-1">Build Fingerprint</div>
                                    <div class="text-xs font-mono text-viper-cyan break-all">${this.escape(dev.buildFingerprint)}</div>
                                </div>
                            ` : ''}
                        </div>

                        <div class="glass-card p-5 rounded-xl">
                            <div class="flex items-center justify-between mb-3">
                                <h4 class="text-sm font-semibold text-white uppercase tracking-wider">Top Contacts</h4>
                                <span class="text-xs text-gray-500">${topContacts.length ? 'click → open in Messages' : 'no comms data'}</span>
                            </div>
                            ${topContacts.length === 0 ? `
                                <div class="text-xs text-gray-500">No call or SMS activity recorded.</div>
                            ` : `
                                <table class="cb-subject-table w-full text-sm">
                                    <thead>
                                        <tr class="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                                            <th class="text-left py-1.5 pr-2 w-6">#</th>
                                            <th class="text-left py-1.5 pr-2">Contact</th>
                                            <th class="text-left py-1.5 pr-2">Number</th>
                                            <th class="text-right py-1.5 pr-2">Msgs</th>
                                            <th class="text-right py-1.5 pr-2">Calls</th>
                                            <th class="text-right py-1.5">Last</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${topContacts.map((c, i) => `
                                            <tr class="cb-subject-row border-b border-gray-700/30 hover:bg-viper-cyan/5 cursor-pointer transition" data-cb-contact-number="${this.escape(c.number || '')}">
                                                <td class="py-1.5 pr-2 text-gray-500 text-xs">${i + 1}</td>
                                                <td class="py-1.5 pr-2 text-white"><strong>${this.escape(c.name || '(unknown)')}</strong></td>
                                                <td class="py-1.5 pr-2 text-viper-cyan font-mono text-xs">${this.escape(c.number || '—')}</td>
                                                <td class="py-1.5 pr-2 text-right text-gray-300">${c.msgs}</td>
                                                <td class="py-1.5 pr-2 text-right text-gray-300">${c.calls}</td>
                                                <td class="py-1.5 text-right text-gray-400 text-xs">${this.escape(c.lastDate || '—')}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            `}
                        </div>

                        <div class="glass-card p-5 rounded-xl">
                            <h4 class="text-sm font-semibold text-white uppercase tracking-wider mb-3">Source</h4>
                            <div class="cb-kv-grid grid grid-cols-2 gap-x-4 gap-y-2">
                                ${kv('Source Mode', imp.sourceMode || '—')}
                                ${kv('Bundle Size', this.fmtBytes(src.bundleSize || imp.bundleSize || 0))}
                                ${kv('Evidence Tag', imp.evidenceTag)}
                                ${kv('Imported', imp.createdAt ? this._fmtDateShort(imp.createdAt) : '')}
                            </div>
                            ${src.ufdxPath ? `
                                <div class="mt-3 pt-3 border-t border-gray-700/50">
                                    <div class="text-xs text-gray-500 mb-1">.ufdx Path</div>
                                    <div class="text-xs font-mono text-gray-300 break-all">${this.escape(src.ufdxPath)}</div>
                                </div>
                            ` : ''}
                            ${Array.isArray(src.zipPaths) && src.zipPaths.length ? `
                                <details class="mt-3 pt-3 border-t border-gray-700/50">
                                    <summary class="text-xs text-gray-400 cursor-pointer">Inner filesystem zips (${src.zipPaths.length}) ▾</summary>
                                    <div class="mt-2 space-y-0.5">
                                        ${src.zipPaths.map(z => `
                                            <div class="text-xs flex justify-between gap-2 py-1 border-b border-gray-700/30 last:border-0">
                                                <span class="font-mono text-gray-300 truncate">${this.escape(z.name)}</span>
                                                <span class="text-gray-500 flex-shrink-0">${this.fmtBytes(z.size || 0)}</span>
                                            </div>
                                        `).join('')}
                                    </div>
                                </details>
                            ` : ''}
                        </div>
                    </div>

                    <!-- RIGHT COLUMN -->
                    <div class="space-y-6">
                        <div class="glass-card p-5 rounded-xl">
                            <h4 class="text-sm font-semibold text-white uppercase tracking-wider mb-3">Volumes</h4>
                            <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                                ${this._subjectStatTile('apps',     'Apps',     imp.counts && imp.counts.apps,     '📦')}
                                ${this._subjectStatTile('contacts', 'Contacts', imp.counts && imp.counts.contacts, '👤')}
                                ${this._subjectStatTile('calls',    'Calls',    imp.counts && imp.counts.calls,    '📞')}
                                ${this._subjectStatTile('sms',      'Messages', imp.counts && imp.counts.sms,      '💬')}
                                ${this._subjectStatTile('media',    'Media',    imp.counts && imp.counts.media,    '🖼️')}
                                ${this._subjectStatTile('accounts', 'Accounts', imp.counts && imp.counts.accounts, '🔑')}
                                ${this._subjectStatTile('wifi',     'Wi-Fi',    imp.counts && imp.counts.wifi,     '📶')}
                                <div class="cb-stat-tile-total bg-viper-cyan/10 border border-viper-cyan/30 rounded p-3 flex flex-col items-center justify-center text-center">
                                    <div class="text-xs text-viper-cyan uppercase tracking-wider">Total</div>
                                    <div class="text-xl font-semibold text-white mt-0.5">${this.totalCount(imp.counts || {})}</div>
                                </div>
                            </div>
                        </div>

                        <div class="glass-card p-5 rounded-xl">
                            <div class="flex items-center justify-between mb-3">
                                <h4 class="text-sm font-semibold text-white uppercase tracking-wider">Activity (last 90 days)</h4>
                                <span class="text-xs text-gray-500">${sparkline.summary}</span>
                            </div>
                            ${sparkline.html}
                        </div>

                        ${this._renderSubjectGeoCard(imp, extras)}

                        ${bp && bp.keys ? `
                            <details class="glass-card p-4 rounded-xl">
                                <summary class="cursor-pointer text-sm font-semibold text-gray-300">build.prop keys (${bp.totalKeys} total, ${Object.keys(bp.keys).length} interesting) ▾</summary>
                                <div class="mt-3 space-y-1 text-xs font-mono max-h-96 overflow-auto">
                                    ${Object.entries(bp.keys).map(([k, v]) => `
                                        <div class="flex gap-3 border-b border-gray-700/50 py-1">
                                            <span class="text-viper-cyan w-64 flex-shrink-0 truncate">${this.escape(k)}</span>
                                            <span class="text-gray-300 break-all">${this.escape(v)}</span>
                                        </div>
                                    `).join('')}
                                </div>
                            </details>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    _renderSubjectGeoCard(imp, extras) {
        const media = (extras && extras.media && Array.isArray(extras.media.items)) ? extras.media.items : [];
        let n = 0;
        for (const m of media) {
            if (!m.gps) continue;
            const lat = +(m.gps.lat ?? m.gps.latitude);
            const lng = +(m.gps.lng ?? m.gps.longitude ?? m.gps.lon);
            if (isFinite(lat) && isFinite(lng)) n++;
        }
        if (n === 0) {
            return `
                <div class="glass-card p-5 rounded-xl">
                    <div class="flex items-center justify-between mb-3">
                        <h4 class="text-sm font-semibold text-white uppercase tracking-wider">Geo snapshot</h4>
                        <span class="text-xs text-gray-500">no GPS-tagged media</span>
                    </div>
                    <div class="text-xs text-gray-500">
                        Open <span class="text-viper-cyan">Movement</span> for full breakdown.
                    </div>
                </div>
            `;
        }
        return `
            <div class="glass-card p-5 rounded-xl">
                <div class="flex items-center justify-between mb-3">
                    <h4 class="text-sm font-semibold text-white uppercase tracking-wider">Geo snapshot</h4>
                    <button data-cb-subject-stat="movement"
                            class="text-xs text-viper-cyan hover:text-cyan-300">
                        Open Movement →
                    </button>
                </div>
                <div class="text-xs text-gray-400 mb-2">
                    ${n} GPS-tagged item${n === 1 ? '' : 's'} from media EXIF
                </div>
                <div id="cellebriteSubjectGeoMap"
                     style="height: 220px; width: 100%; border-radius: 6px; background: #0a0e14; border: 1px solid rgba(34,211,238,0.2);">
                </div>
            </div>
        `;
    }

    /** Mount mini Leaflet map inside Subject pane Geo Snapshot card. */
    _mountSubjectGeoMap(pane, imp, extras) {
        const host = pane.querySelector('#cellebriteSubjectGeoMap');
        if (!host) return;
        if (typeof L === 'undefined' || typeof L.map !== 'function') return;
        this._destroySubjectGeoMap();

        const media = (extras && extras.media && Array.isArray(extras.media.items)) ? extras.media.items : [];
        const pts = [];
        for (const m of media) {
            if (!m.gps) continue;
            const lat = +(m.gps.lat ?? m.gps.latitude);
            const lng = +(m.gps.lng ?? m.gps.longitude ?? m.gps.lon);
            if (!isFinite(lat) || !isFinite(lng)) continue;
            pts.push({ lat, lng, ref: m });
        }
        if (!pts.length) return;

        const map = L.map(host, {
            zoomControl: false,           // mini-map — keep clean
            attributionControl: false,
            scrollWheelZoom: false,       // avoid hijack while user scrolls Subject pane
            preferCanvas: false,
        }).setView([pts[0].lat, pts[0].lng], 10);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap',
        }).addTo(map);

        const group = (typeof L.markerClusterGroup === 'function')
            ? L.markerClusterGroup({
                showCoverageOnHover: false,
                spiderfyOnMaxZoom: true,
                maxClusterRadius: 40,
            })
            : L.layerGroup();

        for (const p of pts) {
            const m = p.ref;
            const dot = L.circleMarker([p.lat, p.lng], {
                radius: 5,
                color: '#22d3ee',
                weight: 2,
                fillColor: '#22d3ee',
                fillOpacity: 0.7,
            });
            const cap = m.capturedAt || m.createdAt || m.modifiedAt;
            const when = cap ? new Date(typeof cap === 'number' ? cap : Date.parse(cap)).toLocaleString() : '—';
            const safeName = this.escape(m.filename || '(unnamed)');
            dot.bindPopup(`
                <div style="min-width:180px;color:#e5e7eb">
                    <div style="font-weight:600;margin-bottom:3px;word-break:break-all">${safeName}</div>
                    <div style="font-size:11px;color:#9ca3af">📅 ${this.escape(when)}</div>
                </div>
            `, { closeButton: true, autoPan: true });
            dot.on('click', () => dot.openPopup());
            dot.on('mouseover', () => { try { dot.setStyle({ radius: 7 }); } catch (_) {} });
            dot.on('mouseout',  () => { try { dot.setStyle({ radius: 5 }); } catch (_) {} });
            group.addLayer(dot);
        }
        map.addLayer(group);

        try {
            const bounds = group.getBounds && group.getBounds();
            if (bounds && bounds.isValid && bounds.isValid()) {
                if (pts.length === 1) map.setView([pts[0].lat, pts[0].lng], 13);
                else map.fitBounds(bounds.pad(0.15));
            }
        } catch (_) {}

        // Click-to-enable wheel-zoom; click-out disables. Avoids scroll hijack
        // while keeping the map zoomable when the user intends to.
        map.on('click', () => map.scrollWheelZoom.enable());
        map.on('mouseout', () => map.scrollWheelZoom.disable());

        this._subjectGeoMap = map;
        setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 80);
    }

    _destroySubjectGeoMap() {
        if (this._subjectGeoMap) {
            try { this._subjectGeoMap.remove(); } catch (_) {}
            this._subjectGeoMap = null;
        }
    }

    // ─── Subject dashboard helpers ──────────────────────────────────────

    _subjectStatTile(targetTab, label, value, icon) {
        const n = typeof value === 'number' ? value : 0;
        const disabled = n === 0;
        const cls = disabled
            ? 'bg-viper-card/30 border border-gray-700 text-gray-500 cursor-not-allowed opacity-60'
            : 'bg-viper-card/50 border border-gray-700 hover:border-viper-cyan/50 hover:bg-viper-cyan/5 text-gray-200 cursor-pointer';
        return `
            <button class="cb-stat-tile ${cls} rounded p-3 flex flex-col items-center justify-center text-center transition"
                    data-cb-subject-stat="${this.escape(targetTab)}" ${disabled ? 'disabled' : ''}
                    title="${disabled ? 'No items' : 'Open ' + this.escape(label)}">
                <div class="text-lg leading-none mb-1">${icon}</div>
                <div class="text-xs text-gray-400 uppercase tracking-wider">${this.escape(label)}</div>
                <div class="text-xl font-semibold ${disabled ? 'text-gray-600' : 'text-white'} mt-0.5">${n}</div>
            </button>
        `;
    }

    _buildSubjectTopContacts(imp, extras) {
        // Aggregate per-number from calls + sms. Names sourced from contacts
        // (best-effort phone-number → displayName) and from the call/sms rows.
        const calls = (extras && extras.calls && Array.isArray(extras.calls.calls)) ? extras.calls.calls : [];
        const sms   = (extras && extras.sms && Array.isArray(extras.sms.messages)) ? extras.sms.messages : [];
        const contacts = (extras && extras.contacts && Array.isArray(extras.contacts.contacts)) ? extras.contacts.contacts : [];

        // Build phone → contact-name lookup.
        const norm = (s) => String(s || '').replace(/[^0-9+]/g, '').slice(-10);
        const nameByNumber = new Map();
        for (const c of contacts) {
            for (const p of (c.phones || [])) {
                const k = norm(p.number);
                if (k && c.displayName && !nameByNumber.has(k)) nameByNumber.set(k, c.displayName);
            }
        }

        const agg = new Map();
        const touch = (rawNum, name, ts, kind) => {
            const k = norm(rawNum);
            if (!k) return;
            let row = agg.get(k);
            if (!row) {
                row = { key: k, number: rawNum, name: name || nameByNumber.get(k) || '', msgs: 0, calls: 0, lastTs: 0 };
                agg.set(k, row);
            }
            if (!row.name && name) row.name = name;
            if (!row.name && nameByNumber.has(k)) row.name = nameByNumber.get(k);
            if (kind === 'sms') row.msgs += 1;
            else if (kind === 'call') row.calls += 1;
            const t = Number(ts) || 0;
            if (t > row.lastTs) row.lastTs = t;
        };

        for (const c of calls) touch(c.number, c.contactName, c.timestamp, 'call');
        for (const m of sms)   touch(m.address, m.contactName, m.timestamp, 'sms');

        const rows = Array.from(agg.values());
        rows.sort((a, b) => (b.msgs + b.calls) - (a.msgs + a.calls) || (b.lastTs - a.lastTs));
        const top = rows.slice(0, 10);
        for (const r of top) r.lastDate = r.lastTs ? this._fmtDateShort(r.lastTs) : '';
        return top;
    }

    _buildSubjectSparkline(imp, extras) {
        // 90-day daily count of calls + messages, rendered as a div-bar strip.
        const calls = (extras && extras.calls && Array.isArray(extras.calls.calls)) ? extras.calls.calls : [];
        const sms   = (extras && extras.sms && Array.isArray(extras.sms.messages)) ? extras.sms.messages : [];

        if (calls.length === 0 && sms.length === 0) {
            return { html: `<div class="text-xs text-gray-500">No call or message activity recorded.</div>`, summary: '0 events' };
        }

        // Normalize timestamps: Cellebrite stores ms-since-epoch (or 0).
        const tsList = [];
        for (const c of calls) { const t = Number(c.timestamp); if (t > 0) tsList.push(t); }
        for (const m of sms)   { const t = Number(m.timestamp); if (t > 0) tsList.push(t); }
        if (tsList.length === 0) {
            return { html: `<div class="text-xs text-gray-500">No timestamped events.</div>`, summary: '0 events' };
        }

        const maxTs = Math.max(...tsList);
        const oneDay = 86400000;
        const endDay = Math.floor(maxTs / oneDay);
        const startDay = endDay - 89; // 90-day window
        const buckets = new Array(90).fill(0);
        for (const t of tsList) {
            const d = Math.floor(t / oneDay);
            const idx = d - startDay;
            if (idx >= 0 && idx < 90) buckets[idx] += 1;
        }
        const peak = Math.max(...buckets, 1);
        const active = buckets.filter(b => b > 0).length;

        const bars = buckets.map((n, i) => {
            const h = Math.max(2, Math.round((n / peak) * 64));
            const opacity = n > 0 ? 1 : 0.18;
            const dayLabel = new Date((startDay + i) * oneDay).toISOString().slice(0, 10);
            return `<div class="cb-spark-bar" style="height:${h}px; opacity:${opacity};" title="${dayLabel}: ${n} event${n === 1 ? '' : 's'}"></div>`;
        }).join('');

        const startLabel = new Date(startDay * oneDay).toISOString().slice(0, 10);
        const endLabel   = new Date(endDay   * oneDay).toISOString().slice(0, 10);
        return {
            html: `
                <div class="cb-spark-strip flex items-end gap-[2px] h-16 bg-viper-card/30 rounded p-2">${bars}</div>
                <div class="flex justify-between text-[10px] text-gray-500 mt-1 px-1">
                    <span>${startLabel}</span>
                    <span>peak ${peak}/day</span>
                    <span>${endLabel}</span>
                </div>
            `,
            summary: `${tsList.length} events · ${active}/90 active days`,
        };
    }

    _fmtDateShort(ts) {
        const t = (typeof ts === 'number') ? ts : Date.parse(ts);
        if (!t || isNaN(t)) return '';
        try {
            const d = new Date(t);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        } catch { return ''; }
    }

    // ─── Comms pane (Phase 1.4 — three-pane Datapilot parity) ──────────

    renderCommsPane(imp, extras) {
        // Reset selection when import changes (carry-over key would be invalid).
        if (this._comms.lastImportId !== imp.id) {
            this._comms = { activeKey: '', search: '', dirFilter: 'all', lastImportId: imp.id };
        }

        const idx = this._buildCommsIndex(imp, extras);
        const all = idx.contactsWithComms;
        if (all.length === 0) {
            return `
                <div class="glass-card p-6 rounded-xl">
                    <h3 class="text-lg font-semibold text-white mb-1">No communications</h3>
                    <p class="text-sm text-gray-400">No calls or messages were recorded in this extraction.</p>
                </div>
            `;
        }

        // Default to first contact if none selected (or stale).
        if (!this._comms.activeKey || !idx.byKey[this._comms.activeKey]) {
            this._comms.activeKey = all[0].key;
        }
        const active = idx.byKey[this._comms.activeKey];

        // Search filter on rail.
        const s = (this._comms.search || '').toLowerCase().trim();
        const railFiltered = !s ? all : all.filter(c =>
            (c.name || '').toLowerCase().includes(s) ||
            (c.number || '').toLowerCase().includes(s)
        );

        return `
            <div class="cb-comms flex gap-3 h-full min-h-0">
                <!-- LEFT RAIL: contact list -->
                <div class="cb-comms-rail flex flex-col flex-shrink-0 w-72 bg-viper-card/30 rounded border border-gray-700/50">
                    <div class="p-2 border-b border-gray-700/50">
                        <input type="text"
                               id="cellebriteCommsSearch"
                               placeholder="Search name or number"
                               value="${this.escape(this._comms.search)}"
                               class="w-full bg-viper-dark/80 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-viper-cyan/50">
                        <div class="text-[10px] text-gray-500 mt-1 px-0.5">
                            ${railFiltered.length} of ${all.length} contact${all.length === 1 ? '' : 's'}
                        </div>
                    </div>
                    <div class="cb-comms-rail-list flex-1 overflow-y-auto">
                        ${railFiltered.length === 0
                            ? `<div class="p-3 text-xs text-gray-500">No contacts match.</div>`
                            : railFiltered.map(c => this._renderCommsRailRow(c, active)).join('')}
                    </div>
                </div>
                <!-- RIGHT: thread -->
                <div class="cb-comms-thread flex-1 min-w-0 flex flex-col bg-viper-card/20 rounded border border-gray-700/50">
                    ${active ? this._renderCommsThread(active) : `<div class="p-4 text-sm text-gray-500">Select a contact on the left.</div>`}
                </div>
            </div>
        `;
    }

    _renderCommsRailRow(c, active) {
        const isActive = active && c.key === active.key;
        const cls = isActive
            ? 'bg-viper-cyan/15 border-l-2 border-viper-cyan'
            : 'border-l-2 border-transparent hover:bg-viper-cyan/5';
        return `
            <div class="cb-comms-rail-row cursor-pointer px-3 py-2 ${cls} border-b border-gray-700/30 transition"
                 data-cb-comms-key="${this.escape(c.key)}">
                <div class="font-medium text-sm text-white truncate">${this.escape(c.name || '(unknown)')}</div>
                <div class="text-xs text-viper-cyan font-mono truncate">${this.escape(c.number || '—')}</div>
                <div class="flex items-center gap-3 mt-1 text-[11px] text-gray-400">
                    <span title="messages">💬 ${c.msgs.length}</span>
                    <span title="calls">📞 ${c.calls.length}</span>
                    ${c.lastDate ? `<span class="ml-auto text-gray-500">${this.escape(c.lastDate)}</span>` : ''}
                </div>
            </div>
        `;
    }

    _renderCommsThread(active) {
        const filter = this._comms.dirFilter || 'all';

        // Build unified event list (msgs + calls), newest-first like Datapilot.
        let events = [];
        for (const m of active.msgs) {
            events.push({
                kind: 'msg',
                id: m.id != null ? String(m.id) : '',
                dir: m.direction,
                ts: Number(m.timestamp) || 0,
                text: m.body || m.subject || '',
                meta: m.kind || 'sms',
                attach: (m.attachments || []).length || 0,
            });
        }
        for (const c of active.calls) {
            events.push({
                kind: 'call',
                id: c.id != null ? String(c.id) : '',
                dir: c.direction || 'unknown',
                ts: Number(c.timestamp) || 0,
                text: c.type ? `${c.type} call` : 'call',
                meta: c.duration ? this._fmtDuration(c.duration) : '',
            });
        }
        events.sort((a, b) => b.ts - a.ts);

        // Apply pill filter.
        if (filter === 'sent')     events = events.filter(e => /out/i.test(e.dir));
        else if (filter === 'received') events = events.filter(e => /in/i.test(e.dir));
        else if (filter === 'calls') events = events.filter(e => e.kind === 'call');
        else if (filter === 'msgs')  events = events.filter(e => e.kind === 'msg');

        // Group by date (YYYY-MM-DD), newest first.
        const groups = [];
        let currentDate = null;
        for (const ev of events) {
            const dKey = ev.ts ? new Date(ev.ts).toISOString().slice(0, 10) : 'Unknown';
            if (dKey !== currentDate) {
                groups.push({ date: dKey, items: [] });
                currentDate = dKey;
            }
            groups[groups.length - 1].items.push(ev);
        }

        const sentN = active.msgs.filter(m => /out/i.test(m.direction || '')).length;
        const recvN = active.msgs.filter(m => /in/i.test(m.direction || '')).length;
        const totalEvents = active.msgs.length + active.calls.length;
        const visibleN = events.length;
        const isFiltered = filter !== 'all';

        const pill = (id, label) => `
            <button class="cb-comms-pill px-2.5 py-1 rounded text-xs font-medium transition border ${filter === id
                ? 'bg-viper-cyan text-viper-dark border-viper-cyan'
                : 'bg-viper-card/40 text-gray-300 border-gray-700 hover:border-viper-cyan/50 hover:text-white'}"
                    data-cb-comms-filter="${id}">${label}</button>
        `;

        // Cap rendered events to keep DOM light (most-recent 500).
        const CAP = 500;
        const overflow = Math.max(0, events.length - CAP);
        // The newest-first sort means we slice the FIRST CAP, which are the
        // most recent — but for messaging-app feel users expect oldest-at-top.
        // We'll reverse per-group + reverse groups to render oldest→newest
        // while still capping to the most-recent CAP.
        const sliced = events.slice(0, CAP);
        const capGroups = [];
        let cd = null;
        for (const ev of sliced) {
            const dKey = ev.ts ? new Date(ev.ts).toISOString().slice(0, 10) : 'Unknown';
            if (dKey !== cd) { capGroups.push({ date: dKey, items: [] }); cd = dKey; }
            capGroups[capGroups.length - 1].items.push(ev);
        }
        // Render oldest→newest (reverse).
        const rendered = capGroups.slice().reverse().map(g => `
            <div class="cb-comms-date-sep text-center text-[11px] text-gray-500 uppercase tracking-wider py-2 my-2 border-y border-gray-700/30">
                ${this.escape(this._friendlyDate(g.date))}
            </div>
            ${g.items.slice().reverse().map(ev => this._renderCommsEvent(ev)).join('')}
        `).join('');

        const overflowBanner = overflow > 0 ? `
            <div class="text-center text-[11px] text-gray-500 py-2">
                Showing most recent ${CAP} of ${events.length} events — apply a filter to narrow.
            </div>
        ` : '';

        return `
            <div class="cb-comms-thread-head flex flex-col gap-2 p-3 border-b border-gray-700/50 flex-shrink-0">
                <div class="flex items-start justify-between gap-3 flex-wrap">
                    <div class="min-w-0">
                        <div class="text-white font-semibold truncate">${this.escape(active.name || '(unknown)')}</div>
                        <div class="text-xs text-viper-cyan font-mono">${this.escape(active.number || '—')}</div>
                    </div>
                    <div class="flex items-center gap-3 text-xs text-gray-400 flex-wrap">
                        <span><span class="text-gray-200 font-semibold">${sentN}</span> sent</span>
                        <span><span class="text-gray-200 font-semibold">${recvN}</span> received</span>
                        <span><span class="text-gray-200 font-semibold">${active.calls.length}</span> calls</span>
                        ${isFiltered && visibleN !== totalEvents
                            ? `<span class="text-amber-300">showing ${visibleN} of ${totalEvents}</span>`
                            : ''}
                    </div>
                </div>
                <div class="flex items-center gap-1.5 flex-wrap">
                    ${pill('all', 'All')}
                    ${pill('sent', 'Sent')}
                    ${pill('received', 'Received')}
                    ${pill('msgs', 'Messages')}
                    ${pill('calls', 'Calls')}
                </div>
            </div>
            <div class="cb-comms-thread-body flex-1 overflow-y-auto p-3">
                ${overflowBanner}
                ${events.length === 0
                    ? `<div class="text-sm text-gray-500 text-center py-8">No items match this filter.</div>`
                    : rendered}
            </div>
        `;
    }

    _renderCommsEvent(ev) {
        const time = ev.ts ? this._fmtTimeOnly(ev.ts) : '';
        const isOut = /out/i.test(ev.dir);
        const align = isOut ? 'justify-end' : 'justify-start';
        const bubble = isOut
            ? 'bg-viper-cyan/15 border-viper-cyan/40 text-gray-100'
            : 'bg-viper-card/60 border-gray-700 text-gray-200';

        // Section + key for WarrantFlags ('sms' for messages, 'calls' for calls).
        const flagSection = ev.kind === 'call' ? 'calls' : 'sms';
        const flagKey = ev.id || '';
        const flagged = flagKey ? this.module.isFlagged(flagSection, flagKey) : false;

        const flagBtn = flagKey ? `
            <button class="cb-flag-toggle inline-flex items-center justify-center w-5 h-5 rounded text-[11px] leading-none transition ${
                flagged
                    ? 'bg-amber-500/25 border border-amber-400 text-amber-100'
                    : 'bg-transparent border border-gray-600/60 text-gray-500 hover:border-amber-400 hover:text-amber-300'
            }"
                    data-cb-flag-section="${flagSection}"
                    data-cb-flag-key="${this.escape(flagKey)}"
                    title="${flagged ? 'Click to unflag' : 'Flag for evidence bundle'}">
                ${flagged ? '🚩' : '⚐'}
            </button>
        ` : '';

        if (ev.kind === 'call') {
            const icon = isOut ? '📞↗' : (/in/i.test(ev.dir) ? '📞↙' : '📞');
            return `
                <div class="flex ${align} my-1 items-center gap-1.5">
                    <div class="cb-comms-call inline-flex items-center gap-2 px-3 py-1.5 rounded-full border ${bubble} text-xs">
                        <span>${icon}</span>
                        <span>${this.escape(ev.text)}</span>
                        ${ev.meta ? `<span class="text-gray-400">· ${this.escape(ev.meta)}</span>` : ''}
                        <span class="text-gray-500">${this.escape(time)}</span>
                    </div>
                    ${flagBtn}
                </div>
            `;
        }
        // Message bubble — flag button sits adjacent to the bubble on the
        // direction-appropriate side (outside the bubble like iMessage reactions).
        const msgBubble = `
            <div class="cb-comms-msg max-w-[70%] px-3 py-2 rounded-2xl border ${bubble}">
                <div class="text-sm whitespace-pre-wrap break-words">${this.escape(ev.text) || '<em class="text-gray-500">(empty)</em>'}</div>
                <div class="flex items-center gap-2 mt-1 text-[10px] text-gray-500">
                    <span>${this.escape(time)}</span>
                    ${ev.attach ? `<span>📎 ${ev.attach}</span>` : ''}
                    ${ev.meta && ev.meta !== 'sms' ? `<span class="uppercase tracking-wider">${this.escape(ev.meta)}</span>` : ''}
                </div>
            </div>
        `;
        return `
            <div class="flex ${align} my-1 items-center gap-1.5">
                ${isOut ? flagBtn : ''}
                ${msgBubble}
                ${isOut ? '' : flagBtn}
            </div>
        `;
    }

    /**
     * Build the per-contact index for Comms.
     *  - `byKey`: key (normalized number) → bucket {name, number, msgs, calls, lastTs, key}
     *  - `contactsWithComms`: array sorted by lastTs DESC of buckets that have ≥1 msg/call.
     */
    _buildCommsIndex(imp, extras) {
        const calls = (extras && extras.calls && Array.isArray(extras.calls.calls)) ? extras.calls.calls : [];
        const sms   = (extras && extras.sms && Array.isArray(extras.sms.messages)) ? extras.sms.messages : [];
        const contacts = (extras && extras.contacts && Array.isArray(extras.contacts.contacts)) ? extras.contacts.contacts : [];

        const norm = (s) => String(s || '').replace(/[^0-9+]/g, '').slice(-10);
        const nameByNumber = new Map();
        for (const c of contacts) {
            for (const p of (c.phones || [])) {
                const k = norm(p.number);
                if (k && c.displayName && !nameByNumber.has(k)) nameByNumber.set(k, c.displayName);
            }
        }

        const byKey = {};
        const touch = (rawNum, name, ts) => {
            const k = norm(rawNum);
            if (!k) return null;
            let row = byKey[k];
            if (!row) {
                row = { key: k, number: rawNum || '', name: name || nameByNumber.get(k) || '', msgs: [], calls: [], lastTs: 0 };
                byKey[k] = row;
            }
            if (!row.name && name) row.name = name;
            if (!row.name && nameByNumber.has(k)) row.name = nameByNumber.get(k);
            const t = Number(ts) || 0;
            if (t > row.lastTs) row.lastTs = t;
            return row;
        };
        for (const c of calls) {
            const row = touch(c.number, c.contactName, c.timestamp);
            if (row) row.calls.push(c);
        }
        for (const m of sms) {
            const row = touch(m.address, m.contactName, m.timestamp);
            if (row) row.msgs.push(m);
        }

        const all = Object.values(byKey);
        all.sort((a, b) => (b.lastTs - a.lastTs));
        for (const r of all) r.lastDate = r.lastTs ? this._fmtDateShort(r.lastTs) : '';
        return { byKey, contactsWithComms: all };
    }

    _friendlyDate(iso) {
        if (!iso || iso === 'Unknown') return 'Unknown date';
        try {
            const d = new Date(iso + 'T00:00:00');
            if (isNaN(d)) return iso;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const t = new Date(today);
            const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
            const dStr = d.toISOString().slice(0, 10);
            if (dStr === today.toISOString().slice(0, 10)) return 'Today';
            if (dStr === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
            return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
        } catch { return iso; }
    }

    _fmtTimeOnly(ts) {
        const t = Number(ts) || 0;
        if (!t) return '';
        try {
            return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        } catch { return ''; }
    }

    _fmtDuration(secs) {
        const n = Number(secs) || 0;
        if (n < 60) return `${n}s`;
        const m = Math.floor(n / 60);
        const s = n % 60;
        if (m < 60) return `${m}m ${s}s`;
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
    }

    // ─── Artifacts pane (Phase 1.4 UI parity — Datapilot-style facet grid) ──
    //
    // Synthetic surface: unifies Apps + Media into a single card grid with
    // a left facet sidebar (Type + Properties). Reuses _renderMediaCard()
    // for media items so the existing IntersectionObserver thumbnail
    // pipeline (_mediaState + _installMediaObserver + _loadMediaThumb)
    // works without modification — _mountArtifactsMediaThumbs just points
    // the host at our grid and feeds it the media subset.
    renderArtifactsPane(imp, extras) {
        const items = this._allArtifacts(extras);
        const counts = this._facetCounts(items);
        const filtered = this._applyArtifactFilters(items);

        const s = this._artifacts;
        const search = s.search || '';

        return `
            <div class="cb-art-shell flex h-full gap-3" style="min-height: 0;">
                <!-- Facet sidebar -->
                <aside class="cb-art-facets glass-card rounded-xl p-3 flex-shrink-0 overflow-auto"
                       style="width: 240px; min-width: 240px;">
                    <div class="mb-3">
                        <input type="text"
                               id="cellebriteArtSearch"
                               class="w-full bg-viper-card/40 border border-gray-700 rounded px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:border-viper-cyan focus:outline-none"
                               placeholder="Search filename, app id..."
                               value="${this.escape(search)}">
                    </div>

                    <div class="cb-facet-group mb-3">
                        <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 px-1">Type</div>
                        ${this._cbFacetRow('All', null,        counts.total, !s.type,                 'type')}
                        ${this._cbFacetRow('🖼 Photos', 'image', counts.image, s.type === 'image',     'type')}
                        ${this._cbFacetRow('🎬 Videos', 'video', counts.video, s.type === 'video',     'type')}
                        ${this._cbFacetRow('🔊 Audio',  'audio', counts.audio, s.type === 'audio',     'type')}
                        ${this._cbFacetRow('📦 Apps',   'app',   counts.app,   s.type === 'app',       'type')}
                        ${counts.other > 0 ? this._cbFacetRow('📁 Other', 'other', counts.other, s.type === 'other', 'type') : ''}
                    </div>

                    <div class="cb-facet-group mb-3">
                        <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 px-1">Properties</div>
                        ${this._cbFacetToggle('🌍 Has GPS',    counts.hasGps,   s.hasGps,       'hasGps')}
                        ${this._cbFacetToggle('🚩 Flagged only', counts.flagged, s.flaggedOnly, 'flaggedOnly')}
                    </div>

                    <div class="pt-2 border-t border-gray-700/40">
                        <button id="cellebriteArtClear"
                                class="w-full text-xs text-viper-cyan hover:underline py-1">
                            Clear all filters
                        </button>
                    </div>
                </aside>

                <!-- Results area -->
                <div class="cb-art-results flex-1 flex flex-col" style="min-width: 0;">
                    <div class="flex items-center justify-between mb-2 flex-shrink-0">
                        <div class="text-sm text-gray-300">
                            <strong class="text-white">${filtered.length}</strong>
                            ${filtered.length === 1 ? 'item' : 'items'}
                            ${filtered.length !== items.length ? `<span class="text-gray-500">of ${items.length}</span>` : ''}
                        </div>
                        ${filtered.length > 300 ? `<div class="text-xs text-amber-400">Showing first 300 — refine filters to narrow.</div>` : ''}
                    </div>
                    <div id="cellebriteArtGrid"
                         class="glass-card rounded-xl p-3 flex-1 overflow-auto"
                         style="min-height: 0;">
                        ${filtered.length === 0
                            ? `<div class="text-gray-500 text-sm py-12 text-center">No artifacts match the current filters.</div>`
                            : `<div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));">
                                ${filtered.slice(0, 300).map(it => this._renderArtifactCard(it)).join('')}
                               </div>`}
                    </div>
                </div>
            </div>
        `;
    }

    // Unify Apps (data.apps + data.extras) + Media (data.items) into a
    // single artifact list. Each item carries enough metadata for both
    // rendering and facet counting.
    _allArtifacts(extras) {
        const out = [];
        const apps = extras && extras.apps;
        const media = extras && extras.media;

        // Apps — both formal app rows and on-disk-only extras
        if (apps) {
            const list = [...(Array.isArray(apps.apps) ? apps.apps : []),
                          ...(Array.isArray(apps.extras) ? apps.extras : [])];
            for (const a of list) {
                const pkg = a.packageName || '';
                out.push({
                    kind: 'app',
                    type: 'app',
                    id: `app:${pkg}`,
                    flagSection: 'apps',
                    flagKey: pkg,
                    name: a.displayName || pkg || '(unnamed app)',
                    meta: pkg,
                    version: a.version || '',
                    installedAt: a.installedAt || '',
                    updatedAt: a.updatedAt || '',
                    extraOnDisk: !!a.__extraOnDisk,
                    hasDataOnDisk: !!a.hasDataOnDisk,
                    size: 0,
                    hasGps: false,
                    _ref: a,
                });
            }
        }

        // Media — reuse existing item shape (id, filename, type, category,
        // size, ext, mime, gps, capturedAt). _renderMediaCard consumes it
        // directly, so we pass the original ref through `_media`.
        if (media && Array.isArray(media.items)) {
            for (const m of media.items) {
                // m.type is one of 'image'|'video'|'audio'|'other'
                out.push({
                    kind: 'media',
                    type: m.type || 'other',
                    id: m.id,
                    flagSection: 'media',
                    flagKey: m.id,
                    name: m.filename || '(unnamed)',
                    meta: m.category || '',
                    size: m.size || 0,
                    hasGps: !!m.gps,
                    _media: m,
                });
            }
        }
        return out;
    }

    _facetCounts(items) {
        const c = { total: items.length, image: 0, video: 0, audio: 0, app: 0, other: 0, hasGps: 0, flagged: 0 };
        const imp = this.module.getActiveImport();
        const flagged = (imp && imp.flagged) ? imp.flagged : {};
        for (const it of items) {
            if (c[it.type] != null) c[it.type]++; else c.other++;
            if (it.hasGps) c.hasGps++;
            const f = flagged[it.flagSection] || [];
            if (f.includes(it.flagKey)) c.flagged++;
        }
        return c;
    }

    _applyArtifactFilters(items) {
        const s = this._artifacts;
        const q = (s.search || '').toLowerCase().trim();
        const imp = this.module.getActiveImport();
        const flagged = (imp && imp.flagged) ? imp.flagged : {};
        return items.filter(it => {
            if (s.type && it.type !== s.type) return false;
            if (s.hasGps && !it.hasGps) return false;
            if (s.flaggedOnly) {
                const f = flagged[it.flagSection] || [];
                if (!f.includes(it.flagKey)) return false;
            }
            if (q) {
                const hay = `${it.name} ${it.meta || ''} ${it.version || ''}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    }

    _cbFacetRow(label, value, count, active, group) {
        const cls = active
            ? 'bg-viper-cyan/15 text-viper-cyan border-viper-cyan/40'
            : 'text-gray-300 border-transparent hover:bg-viper-card/40';
        return `
            <button type="button"
                    class="cb-art-facet w-full flex items-center justify-between text-left text-xs px-2 py-1.5 rounded border ${cls} transition"
                    data-cb-art-facet="${this.escape(group)}"
                    data-cb-art-facet-value="${value == null ? '' : this.escape(value)}">
                <span>${label}</span>
                <span class="text-[10px] text-gray-500">${count || 0}</span>
            </button>
        `;
    }

    _cbFacetToggle(label, count, active, key) {
        const cls = active
            ? 'bg-amber-500/15 text-amber-200 border-amber-500/40'
            : 'text-gray-300 border-transparent hover:bg-viper-card/40';
        return `
            <button type="button"
                    class="cb-art-facet w-full flex items-center justify-between text-left text-xs px-2 py-1.5 rounded border ${cls} transition"
                    data-cb-art-facet-toggle="${this.escape(key)}">
                <span>${label}</span>
                <span class="text-[10px] text-gray-500">${count || 0}</span>
            </button>
        `;
    }

    // Single-card renderer. Media reuses the existing _renderMediaCard so
    // the IntersectionObserver pipeline can attach via data-cb-media-thumb;
    // apps render as a flat info card with no thumbnail.
    _renderArtifactCard(it) {
        if (it.kind === 'media' && it._media) {
            return this._renderMediaCard(it._media);
        }
        // App card — fixed-height tile to match the media card row visually.
        const flagBtn = this._flagBtn('apps', it.flagKey);
        const stateBadge = it.extraOnDisk
            ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">on-disk only</span>`
            : it.hasDataOnDisk
                ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">data ✓</span>`
                : `<span class="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-300 border border-gray-500/30">summary</span>`;
        return `
            <div class="cb-art-app-card relative rounded-lg border border-viper-cyan/15 bg-viper-card/30 overflow-hidden">
                <div class="absolute top-1 left-1 z-10">${flagBtn}</div>
                <div class="aspect-square bg-black/40 flex items-center justify-center overflow-hidden">
                    <div class="text-5xl opacity-60">📦</div>
                </div>
                <div class="px-2 py-1.5 text-[11px] text-white truncate" title="${this.escape(it.name)}">
                    ${this.escape(it.name)}
                </div>
                <div class="px-2 pb-1 text-[10px] font-mono text-viper-cyan truncate" title="${this.escape(it.meta)}">
                    ${this.escape(it.meta)}
                </div>
                <div class="px-2 pb-2 flex items-center justify-between gap-1 text-[10px]">
                    ${it.version ? `<span class="text-gray-500">v${this.escape(it.version)}</span>` : `<span></span>`}
                    ${stateBadge}
                </div>
            </div>
        `;
    }

    // Mount the IntersectionObserver pipeline against the artifacts grid.
    // We feed _mediaState only the media subset so observer hits map back
    // to real media items in _loadMediaThumb. Card click → modal viewer
    // is already wired by _wireMediaGridEvents on the pane.
    _mountArtifactsMediaThumbs(pane, imp, extras) {
        const host = pane.querySelector('#cellebriteArtGrid');
        if (!host) return;
        const mediaItems = (extras && extras.media && Array.isArray(extras.media.items))
            ? extras.media.items
            : [];

        // Tear down any prior observer / blob URLs from a previous mount.
        this._destroyMediaGrid();

        if (mediaItems.length === 0) {
            // No media in this bundle — no observer needed. Card click
            // wiring still gets installed for any future bundle.
            this._wireMediaGridEvents(pane);
            return;
        }

        this._mediaState = {
            host,
            items: mediaItems,
            imp,
            blobUrls: new Map(),
            observer: null,
            visibleIds: new Set(),
        };

        // _renderMediaCard markup is already in the DOM (via renderArtifactsPane
        // → _renderArtifactCard → _renderMediaCard). Just attach the observer.
        this._installMediaObserver();
        this._wireMediaGridEvents(pane);
    }

    // ─── Apps pane ──────────────────────────────────────────────────────
    renderAppsPane(data, imp) {
        if (!data) return `<div class="text-gray-500 text-sm">No app data available.</div>`;
        const apps  = Array.isArray(data.apps)   ? data.apps   : [];
        const extra = Array.isArray(data.extras) ? data.extras : [];
        const all = [...apps, ...extra];

        if (all.length === 0) {
            return `<div class="text-gray-500 text-sm">No installed apps detected in this bundle.</div>`;
        }

        const rows = all.map((a, i) => {
            const tag = a.__extraOnDisk
                ? `<span class="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">on-disk only</span>`
                : a.hasDataOnDisk
                    ? `<span class="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">data ✓</span>`
                    : `<span class="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-300 border border-gray-500/30">summary</span>`;
            return `
                <tr class="cellebrite-app-row hover:bg-viper-card/30 transition" data-pkg="${this.escape(a.packageName)}">
                    <td class="px-3 py-2 text-sm text-white">${this.escape(a.displayName || a.packageName)}</td>
                    <td class="px-3 py-2 text-xs font-mono text-viper-cyan truncate max-w-xs">${this.escape(a.packageName)}</td>
                    <td class="px-3 py-2 text-xs text-gray-300">${this.escape(a.version || '')}</td>
                    <td class="px-3 py-2 text-xs text-gray-400">${this.escape(a.installedAt || '')}</td>
                    <td class="px-3 py-2 text-xs text-gray-400">${this.escape(a.updatedAt || '')}</td>
                    <td class="px-3 py-2">${tag}</td>
                </tr>
            `;
        }).join('');

        return `
            <div class="space-y-4">
                <div class="flex items-center justify-between">
                    <div>
                        <h3 class="text-lg font-semibold text-white">Installed Apps</h3>
                        <p class="text-sm text-gray-400">${apps.length} listed · ${extra.length} extra on-disk${this._paneCountHtml('apps', all.length)}</p>
                    </div>
                    ${this._paneSearchBarHtml('apps', 'Search package or name...')}
                </div>
                <div class="glass-card rounded-xl overflow-hidden" data-cb-topscroll-wrap>
                    <div class="cb-topscroll-top" data-cb-topscroll-top
                         style="overflow-x:auto;overflow-y:hidden;height:14px;border-bottom:1px solid rgba(34,211,238,0.08);">
                        <div data-cb-topscroll-ghost style="height:1px;width:900px;"></div>
                    </div>
                    <div class="cb-topscroll-bottom" data-cb-topscroll-bottom style="overflow-x:auto;">
                        <table class="w-full text-left min-w-[900px]">
                            <thead class="bg-viper-card/60 text-xs uppercase tracking-wider text-gray-400">
                                <tr>
                                    <th class="px-3 py-2">Display Name</th>
                                    <th class="px-3 py-2">Package</th>
                                    <th class="px-3 py-2">Version</th>
                                    <th class="px-3 py-2">Installed</th>
                                    <th class="px-3 py-2">Updated</th>
                                    <th class="px-3 py-2">State</th>
                                </tr>
                            </thead>
                            <tbody id="cellebriteAppsTbody">${rows}</tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    }

    // ─── Contacts pane ──────────────────────────────────────────────────
    renderContactsPane(data, imp) {
        if (!data) return `<div class="text-gray-500 text-sm">No contact data available.</div>`;
        const contacts = Array.isArray(data.contacts) ? data.contacts : [];
        if (contacts.length === 0) {
            return `
                <div class="text-gray-500 text-sm">
                    No contacts parsed from this bundle.
                    ${data.errors && data.errors.length ? `<div class="mt-2 text-amber-400">Errors: ${data.errors.map(e => this.escape(e)).join(', ')}</div>` : ''}
                </div>
            `;
        }

        const rows = contacts.map(c => {
            const phones = (c.phones || []).map(p =>
                `<div class="text-xs"><span class="text-gray-500">${this.escape(p.type || '')}</span> <span class="font-mono text-viper-cyan">${this.escape(p.number)}</span></div>`
            ).join('') || '<span class="text-xs text-gray-500">—</span>';
            const emails = (c.emails || []).map(e =>
                `<div class="text-xs"><span class="text-gray-500">${this.escape(e.type || '')}</span> <span class="text-gray-300">${this.escape(e.address)}</span></div>`
            ).join('') || '<span class="text-xs text-gray-500">—</span>';
            const star = c.starred ? '<span class="text-amber-400">⭐</span>' : '';
            // Case Link: name match across other cases (HIGH/MEDIUM only).
            const nameMatches = this._caseLinkMatchesForContact(c);
            // Plus phone-based matches from any of the contact's numbers.
            const phoneHits = [];
            for (const p of (c.phones || [])) {
                const hits = this._caseLinkMatchesForPhone(p.number || '');
                for (const h of hits) phoneHits.push({ confidence: 'MEDIUM', caseNumber: h.caseNumber, role: h.role, person: h.person, reasons: ['Phone match'] });
            }
            const allMatches = [...nameMatches, ...phoneHits];
            const clBadge = this._caseLinkBadgeHtml(allMatches, 'contacts');
            return `
                <tr class="cellebrite-contact-row hover:bg-viper-card/30 transition" data-contact-id="${this.escape(c.id)}">
                    <td class="px-3 py-2 align-top">${this._flagBtn('contacts', c.id)}</td>
                    <td class="px-3 py-2 text-sm text-white">
                        ${this.escape(c.displayName || '(no name)')} ${star}
                        ${clBadge ? `<div class="mt-1">${clBadge}</div>` : ''}
                    </td>
                    <td class="px-3 py-2">${phones}</td>
                    <td class="px-3 py-2">${emails}</td>
                    <td class="px-3 py-2 text-xs text-gray-400">${this.escape(c.accountType || '')}</td>
                </tr>
            `;
        }).join('');

        return `
            <div class="space-y-4">
                <div class="flex items-center justify-between">
                    <div>
                        <h3 class="text-lg font-semibold text-white">Contacts</h3>
                        <p class="text-sm text-gray-400">${contacts.length} contact(s)${this._paneCountHtml('contacts', contacts.length)}</p>
                    </div>
                    ${this._paneSearchBarHtml('contacts', 'Search name, phone, email...')}
                </div>
                <div class="glass-card rounded-xl overflow-hidden" data-cb-topscroll-wrap>
                    <div class="cb-topscroll-top" data-cb-topscroll-top
                         style="overflow-x:auto;overflow-y:hidden;height:14px;border-bottom:1px solid rgba(34,211,238,0.08);">
                        <div data-cb-topscroll-ghost style="height:1px;width:820px;"></div>
                    </div>
                    <div class="cb-topscroll-bottom" data-cb-topscroll-bottom style="overflow-x:auto;">
                        <table class="w-full text-left min-w-[820px]">
                            <thead class="bg-viper-card/60 text-xs uppercase tracking-wider text-gray-400">
                                <tr>
                                    <th class="px-3 py-2 w-10">Flag</th>
                                    <th class="px-3 py-2">Name</th>
                                    <th class="px-3 py-2">Phones</th>
                                    <th class="px-3 py-2">Emails</th>
                                    <th class="px-3 py-2">Account</th>
                                </tr>
                            </thead>
                            <tbody id="cellebriteContactsTbody">${rows}</tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    }

    _wirePaneEvents(pane, surface) {
        // ── Universal click delegation (Phase 1.3/1.4): flag toggles + Case Link badges + × clears ──
        if (!pane._cbDelegationWired) {
            pane.addEventListener('click', (ev) => {
                const flagBtn = ev.target.closest('.cb-flag-toggle');
                if (flagBtn) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const sec = flagBtn.dataset.cbFlagSection;
                    const key = flagBtn.dataset.cbFlagKey;
                    if (sec && key) {
                        this.module.toggleFlag(sec, key);
                        const nowFlagged = this.module.isFlagged(sec, key);
                        // Surgical visual swap — preserve all sizing classes
                        // (w-5/h-5 in Comms bubbles, w-7/h-7 in tables, etc.)
                        // by only touching color/state classes via classList.
                        const flaggedClasses = ['bg-amber-500/25', 'border-amber-400', 'text-amber-100'];
                        const unflaggedClasses = ['bg-viper-card/30', 'border-gray-700', 'text-gray-500',
                                                  'hover:border-amber-400', 'hover:text-amber-300',
                                                  'bg-transparent', 'border-gray-600/60'];
                        if (nowFlagged) {
                            unflaggedClasses.forEach(c => flagBtn.classList.remove(c));
                            flaggedClasses.forEach(c => flagBtn.classList.add(c));
                            flagBtn.textContent = '🚩';
                            flagBtn.title = 'Click to unflag';
                        } else {
                            flaggedClasses.forEach(c => flagBtn.classList.remove(c));
                            // Re-apply default unflagged surface — pick the
                            // pair that matches what was rendered.
                            const isCompact = flagBtn.classList.contains('w-5');
                            if (isCompact) {
                                flagBtn.classList.add('bg-transparent', 'border-gray-600/60', 'text-gray-500',
                                                      'hover:border-amber-400', 'hover:text-amber-300');
                            } else {
                                flagBtn.classList.add('bg-viper-card/30', 'border-gray-700', 'text-gray-500',
                                                      'hover:border-amber-400', 'hover:text-amber-300');
                            }
                            flagBtn.textContent = '⚐';
                            flagBtn.title = 'Click to flag this row for evidence bundle';
                        }
                        this._refreshFlagToolbar();
                    }
                    return;
                }
                const clBadge = ev.target.closest('.cb-caselink-badge');
                if (clBadge) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    this._onCaseLinkBadgeClick(clBadge);
                    return;
                }
                // × clear (input-adjacent OR empty-state-row OR vlist-empty).
                const clearBtn = ev.target.closest('[data-cb-search-clear]');
                if (clearBtn) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const targetSurface = clearBtn.dataset.cbSearchClear;
                    if (targetSurface) this._clearPaneFilter(pane, targetSurface);
                    return;
                }
            });
            pane._cbDelegationWired = true;
        }

        // Subject dashboard: stat tiles → switch surface; top-contact rows → jump to Messages with phone filter.
        if (surface === 'device') {
            pane.querySelectorAll('[data-cb-subject-stat]').forEach(btn => {
                if (btn.disabled) return;
                btn.addEventListener('click', () => {
                    const target = btn.dataset.cbSubjectStat;
                    if (target) this.module.setActiveSubTab(target);
                });
            });
            pane.querySelectorAll('[data-cb-contact-number]').forEach(tr => {
                tr.addEventListener('click', () => {
                    const num = tr.dataset.cbContactNumber || '';
                    if (!num) return;
                    // Persist as messages search filter; setActiveSubTab triggers a render
                    // and _applyPaneFilter (via _mountVirtualList) consumes _search.sms.
                    this._search.sms = num;
                    this.module.setActiveSubTab('sms');
                });
            });
            return;
        }

        // Movement pane: only interactive element is the "Open Wi-Fi tab →" jump button.
        if (surface === 'movement') {
            pane.querySelectorAll('[data-cb-jump-tab]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const target = btn.dataset.cbJumpTab;
                    if (target) this.module.setActiveSubTab(target);
                });
            });
            return;
        }

        // Comms three-pane: rail row selects active contact; pills toggle dirFilter;
        // search box filters rail in-place.
        if (surface === 'comms') {
            pane.querySelectorAll('[data-cb-comms-key]').forEach(row => {
                row.addEventListener('click', () => {
                    const key = row.dataset.cbCommsKey;
                    if (!key || key === this._comms.activeKey) return;
                    this._comms.activeKey = key;
                    // Re-render pane in place (cheaper than full module.render()).
                    this._hydrateActivePane();
                });
            });
            pane.querySelectorAll('[data-cb-comms-filter]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const f = btn.dataset.cbCommsFilter;
                    if (!f || f === this._comms.dirFilter) return;
                    this._comms.dirFilter = f;
                    this._hydrateActivePane();
                });
            });
            const search = pane.querySelector('#cellebriteCommsSearch');
            if (search) {
                // Restore focus + caret if user was mid-typing before re-render.
                if (this._comms._searchHadFocus) {
                    try {
                        search.focus();
                        const v = search.value;
                        search.setSelectionRange(v.length, v.length);
                    } catch (_) {}
                    this._comms._searchHadFocus = false;
                }
                let t;
                search.addEventListener('input', (ev) => {
                    clearTimeout(t);
                    this._comms.search = ev.target.value;
                    this._comms._searchHadFocus = true;
                    t = setTimeout(() => this._hydrateActivePane(), 180);
                });
                search.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Escape') {
                        ev.preventDefault();
                        this._comms.search = '';
                        search.value = '';
                        this._hydrateActivePane();
                    }
                });
            }
            return;
        }

        // Artifacts facet sidebar: type rows + property toggles + search.
        // Card-level interactions (flag toggle, media card click) are
        // handled by the universal delegation above + _wireMediaGridEvents.
        if (surface === 'artifacts') {
            pane.querySelectorAll('[data-cb-art-facet]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const grp = btn.dataset.cbArtFacet;
                    const raw = btn.dataset.cbArtFacetValue;
                    const v = (raw === '' || raw == null) ? null : raw;
                    this._artifacts[grp] = v;
                    this._hydrateActivePane();
                });
            });
            pane.querySelectorAll('[data-cb-art-facet-toggle]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const k = btn.dataset.cbArtFacetToggle;
                    this._artifacts[k] = !this._artifacts[k];
                    this._hydrateActivePane();
                });
            });
            const clear = pane.querySelector('#cellebriteArtClear');
            if (clear) {
                clear.addEventListener('click', () => {
                    this._artifacts = { search: '', type: null, hasGps: false, flaggedOnly: false, lastImportId: null };
                    this._hydrateActivePane();
                });
            }
            const search = pane.querySelector('#cellebriteArtSearch');
            if (search) {
                if (this._artifacts._searchHadFocus) {
                    try {
                        search.focus();
                        const v = search.value;
                        search.setSelectionRange(v.length, v.length);
                    } catch (_) {}
                    this._artifacts._searchHadFocus = false;
                }
                let t;
                search.addEventListener('input', (ev) => {
                    clearTimeout(t);
                    this._artifacts.search = ev.target.value;
                    this._artifacts._searchHadFocus = true;
                    t = setTimeout(() => this._hydrateActivePane(), 180);
                });
                search.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Escape') {
                        ev.preventDefault();
                        this._artifacts.search = '';
                        search.value = '';
                        this._hydrateActivePane();
                    }
                });
            }
            return;
        }

        if (surface === 'apps' || surface === 'contacts' || surface === 'calls' ||
            surface === 'sms' || surface === 'accounts' || surface === 'wifi' || surface === 'media') {
            const search = pane.querySelector(`[data-cb-search="${surface}"]`);
            if (search) {
                search.addEventListener('input', () => {
                    this._search[surface] = search.value;
                    this._scheduleFilter(pane, surface);
                });
                search.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Escape') {
                        ev.preventDefault();
                        this._clearPaneFilter(pane, surface);
                    }
                });
            }
            // Secondary control: <select> for calls/sms (single element),
            // chip <button>s for media (multi-element click set).
            if (surface === 'media') {
                pane.querySelectorAll('[data-cb-secondary="media"]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const v = btn.dataset.cbSecondaryValue || 'all';
                        this._secondaryFilters.media = v;
                        this._applyPaneFilter(pane, 'media');
                    });
                });
            } else {
                const sec = pane.querySelector(`[data-cb-secondary="${surface}"]`);
                if (sec) {
                    sec.addEventListener('change', () => {
                        this._secondaryFilters[surface] = sec.value;
                        this._applyPaneFilter(pane, surface);
                    });
                }
            }
            // Initial pass: apply any persisted state from a previous sub-tab visit.
            // For virtualized panes (calls/sms) this is a no-op until _mountVirtualList
            // runs immediately after — which itself calls _applyPaneFilter on completion.
            // Media also defers its initial apply to _mountMediaGrid for the same reason
            // (cards aren't in the DOM yet).
            if (surface !== 'calls' && surface !== 'sms' && surface !== 'media') {
                this._applyPaneFilter(pane, surface);
            }
        }
    }

    // ─── Calls pane ─────────────────────────────────────────────────────
    /** Column layout shared between header row and virtualized rows. */
    _callsGridTemplate() {
        return '48px 220px minmax(140px, 1fr) 70px 110px 90px 170px 60px';
    }

    /** Per-row HTML used by the virtualized renderer. */
    _renderCallRow(c) {
        const dirIcon = c.direction === 'in'
            ? '<span class="text-emerald-300">↙ in</span>'
            : c.direction === 'out'
                ? '<span class="text-viper-cyan">↗ out</span>'
                : '<span class="text-gray-400">·</span>';
        const typeColor = ({
            incoming: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
            outgoing: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
            missed:   'bg-amber-500/20 text-amber-300 border-amber-500/30',
            voicemail:'bg-purple-500/20 text-purple-300 border-purple-500/30',
            rejected: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
            blocked:  'bg-red-500/20 text-red-300 border-red-500/30',
        })[c.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/30';
        const typeBadge = `<span class="text-xs px-2 py-0.5 rounded border ${typeColor}">${this.escape(c.type || '—')}</span>`;

        const clMatches = this._caseLinkMatchesForPhone(c.number);
        const clBadge = clMatches.length ? this._caseLinkBadgeHtml(
            clMatches.map(h => ({ confidence: 'MEDIUM', caseNumber: h.caseNumber, role: h.role, person: h.person, reasons: ['Phone match'] })),
            'calls'
        ) : '';

        // Each child cell is a grid column. align-items:center on the row,
        // so we use plain divs (no padding-y) and rely on row height for spacing.
        return `
            <div class="px-3 flex items-center justify-center">${this._flagBtn('calls', c.id)}</div>
            <div class="px-3 text-sm font-mono text-viper-cyan whitespace-nowrap overflow-hidden text-ellipsis">
                ${this.escape(c.number || '—')}${clBadge ? `<div class="mt-0.5">${clBadge}</div>` : ''}
            </div>
            <div class="px-3 text-sm text-white truncate">${this.escape(c.contactName || '')}</div>
            <div class="px-3 text-xs">${dirIcon}</div>
            <div class="px-3">${typeBadge}</div>
            <div class="px-3 text-xs text-gray-300">${this._fmtDuration(c.duration)}</div>
            <div class="px-3 text-xs text-gray-400 whitespace-nowrap">${this._fmtTimestamp(c.timestamp)}</div>
            <div class="px-3 text-xs text-gray-500 truncate">${this.escape(c.simSlot || '')}</div>
        `;
    }

    renderCallsPane(data, imp) {
        if (!data) return `<div class="text-gray-500 text-sm">No call log data available.</div>`;
        const calls = Array.isArray(data.calls) ? data.calls : [];
        if (calls.length === 0) {
            return `<div class="text-gray-500 text-sm">No calls parsed.${data.errors && data.errors.length ? ` <span class="text-amber-400">(${this.escape(data.errors.join(', '))})</span>` : ''}</div>`;
        }

        const grid = this._callsGridTemplate();
        return `
            <div class="space-y-4 h-full flex flex-col">
                <div class="flex items-center justify-between flex-wrap gap-3 flex-shrink-0">
                    <div>
                        <h3 class="text-lg font-semibold text-white">Call Log</h3>
                        <p class="text-sm text-gray-400">${calls.length} call(s)${this._paneCountHtml('calls', calls.length)}</p>
                    </div>
                    <div class="flex gap-2">
                        <select id="cellebriteCallsFilter"
                                data-cb-secondary="calls"
                                class="px-3 py-2 bg-viper-card/40 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-viper-cyan">
                            <option value="all"${this._secondaryFilters.calls === 'all' ? ' selected' : ''}>All directions</option>
                            <option value="in"${this._secondaryFilters.calls === 'in' ? ' selected' : ''}>Incoming</option>
                            <option value="out"${this._secondaryFilters.calls === 'out' ? ' selected' : ''}>Outgoing</option>
                            <option value="other"${this._secondaryFilters.calls === 'other' ? ' selected' : ''}>Other</option>
                        </select>
                        ${this._paneSearchBarHtml('calls', 'Search number, name...')}
                    </div>
                </div>
                <div class="glass-card rounded-xl overflow-hidden flex-1 flex flex-col" style="min-height: 400px;">
                    <div class="bg-viper-card/60 text-xs uppercase tracking-wider text-gray-400 border-b border-viper-cyan/10 flex-shrink-0"
                         style="display:grid;grid-template-columns:${grid};align-items:center;height:36px;">
                        <div class="px-3">Flag</div>
                        <div class="px-3">Number</div>
                        <div class="px-3">Contact</div>
                        <div class="px-3">Dir</div>
                        <div class="px-3">Type</div>
                        <div class="px-3">Duration</div>
                        <div class="px-3">When</div>
                        <div class="px-3">SIM</div>
                    </div>
                    <div id="cellebriteCallsVlist" class="cb-vlist-host flex-1"
                         style="position:relative;overflow-y:auto;min-height:360px;height:calc(100vh - 360px);"></div>
                </div>
            </div>
        `;
    }

    // ─── SMS / MMS pane ─────────────────────────────────────────────────
    _smsGridTemplate() {
        return '48px 70px 40px 220px minmax(220px, 1fr) 170px';
    }

    /** Per-row HTML used by the virtualized SMS renderer. */
    _renderSmsRow(m) {
        const attCount = (m.attachments || []).length;
        const attTag = attCount ? `<span class="text-xs text-amber-300 ml-1">📎 ${attCount}</span>` : '';
        const body = (m.body || m.subject || '').slice(0, 240);
        const dirIcon = m.direction === 'in' ? '<span class="text-emerald-300">←</span>'
                      : m.direction === 'out' ? '<span class="text-viper-cyan">→</span>'
                      : '<span class="text-gray-400">·</span>';
        const kindBadge = m.kind === 'rcs'
            ? '<span class="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">RCS</span>'
            : m.kind === 'mms'
            ? '<span class="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">MMS</span>'
            : '<span class="text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">SMS</span>';

        const clMatches = this._caseLinkMatchesForPhone(m.address);
        const clBadge = clMatches.length ? this._caseLinkBadgeHtml(
            clMatches.map(h => ({ confidence: 'MEDIUM', caseNumber: h.caseNumber, role: h.role, person: h.person, reasons: ['Phone match'] })),
            'sms'
        ) : '';

        return `
            <div class="px-3 flex items-center justify-center">${this._flagBtn('sms', m.id)}</div>
            <div class="px-3">${kindBadge}</div>
            <div class="px-3 text-center">${dirIcon}</div>
            <div class="px-3 text-sm font-mono text-viper-cyan whitespace-nowrap overflow-hidden text-ellipsis">
                ${this.escape(m.address || '—')}${clBadge ? `<div class="mt-0.5">${clBadge}</div>` : ''}
            </div>
            <div class="px-3 text-sm text-gray-200 overflow-hidden" style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;">${this.escape(body)}${attTag}</div>
            <div class="px-3 text-xs text-gray-400 whitespace-nowrap">${this._fmtTimestamp(m.timestamp)}</div>
        `;
    }

    renderSmsPane(data, imp) {
        if (!data) return `<div class="text-gray-500 text-sm">No message data available.</div>`;
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const threads  = Array.isArray(data.threads)  ? data.threads  : [];
        if (messages.length === 0) {
            const errs = (data.errors && data.errors.length) ? data.errors.join(', ') : '';
            const neitherFound = /no mmssms\.db or bugle_db found/i.test(errs);
            return `
                <div class="space-y-3 text-sm">
                    <div class="text-gray-300 font-medium">No SMS / MMS / RCS messages parsed from this bundle.</div>
                    ${neitherFound ? `
                        <div class="glass-card rounded-lg p-4 border border-amber-500/30 bg-amber-500/5">
                            <div class="text-amber-300 font-medium mb-1">📵 No message databases located</div>
                            <div class="text-gray-300 text-xs leading-relaxed">
                                Neither <span class="font-mono text-viper-cyan">mmssms.db</span> (AOSP Telephony provider) nor
                                <span class="font-mono text-viper-cyan">bugle_db</span> (Google Messages) was present in this UFDR.
                                This usually means the extraction was logical-only or the messaging app was wiped before acquisition.
                            </div>
                        </div>
                    ` : (errs ? `<div class="text-amber-400 text-xs">Errors: ${this.escape(errs)}</div>` : '')}
                </div>
            `;
        }

        const selThread = this._secondaryFilters.sms || 'all';
        const threadOptions = [`<option value="all"${selThread === 'all' ? ' selected' : ''}>All threads</option>`,
            ...threads.map(t => {
                const addrs = (t.addresses || []).slice(0, 2).join(', ') || t.address || `Thread ${t.threadId}`;
                const v = this.escape(t.id);
                const sel = (selThread === t.id) ? ' selected' : '';
                return `<option value="${v}"${sel}>${this.escape(addrs)} (${t.messageCount})</option>`;
            }),
        ].join('');

        const grid = this._smsGridTemplate();
        const rcsCount = messages.filter(m => m.kind === 'rcs').length;
        const mmsCount = messages.filter(m => m.kind === 'mms').length;
        const breakdown = [];
        if (rcsCount) breakdown.push(`<span class="text-emerald-300">${rcsCount} RCS</span>`);
        if (mmsCount) breakdown.push(`<span class="text-purple-300">${mmsCount} MMS</span>`);
        const sources = Array.isArray(data.sources) ? data.sources : [];
        const sourcesHtml = sources.length
            ? ` · <span class="text-gray-500">sources: ${sources.map(s => `<span class="font-mono">${this.escape(s)}</span>`).join(', ')}</span>`
            : '';
        return `
            <div class="space-y-4 h-full flex flex-col">
                <div class="flex items-center justify-between flex-wrap gap-3 flex-shrink-0">
                    <div>
                        <h3 class="text-lg font-semibold text-white">SMS / MMS / RCS</h3>
                        <p class="text-sm text-gray-400">
                            ${messages.length} message(s) across ${threads.length} thread(s)${breakdown.length ? ` · ${breakdown.join(' · ')}` : ''}${sourcesHtml}${this._paneCountHtml('sms', messages.length)}
                        </p>
                    </div>
                    <div class="flex gap-2">
                        <select id="cellebriteSmsThreadFilter"
                                data-cb-secondary="sms"
                                class="px-3 py-2 bg-viper-card/40 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-viper-cyan max-w-xs">
                            ${threadOptions}
                        </select>
                        ${this._paneSearchBarHtml('sms', 'Search body, address...')}
                    </div>
                </div>
                <div class="glass-card rounded-xl overflow-hidden flex-1 flex flex-col" style="min-height: 400px;">
                    <div class="bg-viper-card/60 text-xs uppercase tracking-wider text-gray-400 border-b border-viper-cyan/10 flex-shrink-0"
                         style="display:grid;grid-template-columns:${grid};align-items:center;height:36px;">
                        <div class="px-3">Flag</div>
                        <div class="px-3">Kind</div>
                        <div class="px-3 text-center">Dir</div>
                        <div class="px-3">Address</div>
                        <div class="px-3">Body</div>
                        <div class="px-3">When</div>
                    </div>
                    <div id="cellebriteSmsVlist" class="cb-vlist-host flex-1"
                         style="position:relative;overflow-y:auto;min-height:360px;height:calc(100vh - 360px);"></div>
                </div>
            </div>
        `;
    }

    // ─── Accounts pane ──────────────────────────────────────────────────
    renderAccountsPane(data, imp) {
        if (!data) return `<div class="text-gray-500 text-sm">No account data available.</div>`;
        const accounts = Array.isArray(data.accounts) ? data.accounts : [];
        if (accounts.length === 0) {
            return `<div class="text-gray-500 text-sm">No accounts parsed.${data.errors && data.errors.length ? ` <span class="text-amber-400">(${this.escape(data.errors.join(', '))})</span>` : ''}</div>`;
        }
        // Group by account type for the summary chips.
        const typeCounts = {};
        for (const a of accounts) {
            const t = a.type || '(unknown)';
            typeCounts[t] = (typeCounts[t] || 0) + 1;
        }
        const chips = Object.entries(typeCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([t, c]) =>
                `<span class="text-xs px-2 py-1 rounded bg-viper-card/50 border border-viper-cyan/30 text-viper-cyan">${this.escape(t)} <span class="text-gray-400">${c}</span></span>`
            ).join('');

        const rows = accounts.map(a => `
            <tr class="cellebrite-account-row hover:bg-viper-card/30 transition">
                <td class="px-3 py-2 align-top">${this._flagBtn('accounts', a.id)}</td>
                <td class="px-3 py-2 text-sm text-white break-all">${this.escape(a.name || '(no name)')}</td>
                <td class="px-3 py-2 text-xs font-mono text-viper-cyan break-all">${this.escape(a.type || '')}</td>
                <td class="px-3 py-2">
                    ${a.hasPassword
                        ? '<span class="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">credential present</span>'
                        : '<span class="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-300 border border-gray-500/30">no credential / FBE-locked</span>'
                    }
                </td>
                <td class="px-3 py-2 text-xs text-gray-400">${this.escape(a.previousName || '')}</td>
            </tr>
        `).join('');

        return `
            <div class="space-y-4">
                <div class="flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <h3 class="text-lg font-semibold text-white">Accounts</h3>
                        <p class="text-sm text-gray-400">${accounts.length} account(s)${this._paneCountHtml('accounts', accounts.length)}</p>
                    </div>
                    ${this._paneSearchBarHtml('accounts', 'Search name, type...')}
                </div>
                <div class="flex flex-wrap gap-2">${chips}</div>
                <div class="glass-card rounded-xl overflow-hidden" data-cb-topscroll-wrap>
                    <div class="cb-topscroll-top" data-cb-topscroll-top
                         style="overflow-x:auto;overflow-y:hidden;height:14px;border-bottom:1px solid rgba(34,211,238,0.08);">
                        <div data-cb-topscroll-ghost style="height:1px;width:780px;"></div>
                    </div>
                    <div class="cb-topscroll-bottom" data-cb-topscroll-bottom style="overflow-x:auto;">
                        <table class="w-full text-left min-w-[780px]">
                            <thead class="bg-viper-card/60 text-xs uppercase tracking-wider text-gray-400">
                                <tr>
                                    <th class="px-3 py-2 w-10">Flag</th>
                                    <th class="px-3 py-2">Name</th>
                                    <th class="px-3 py-2">Type</th>
                                    <th class="px-3 py-2">Credential</th>
                                    <th class="px-3 py-2">Previous Name</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </div>
                <div class="text-xs text-gray-500">
                    Credential field reports presence only — passwords are never extracted or displayed.
                </div>
            </div>
        `;
    }

    // ─── Wi-Fi pane ─────────────────────────────────────────────────────
    renderWifiPane(data, imp) {
        if (!data) return `<div class="text-gray-500 text-sm">No Wi-Fi data available.</div>`;
        const networks = Array.isArray(data.networks) ? data.networks : [];
        if (networks.length === 0) {
            return `<div class="text-gray-500 text-sm">No Wi-Fi networks parsed.${data.errors && data.errors.length ? ` <span class="text-amber-400">(${this.escape(data.errors.join(', '))})</span>` : ''}</div>`;
        }
        const secBadge = (s) => {
            const sec = String(s || '').toUpperCase();
            const color = sec.includes('WPA3') ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                       : sec.includes('WPA')   ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
                       : sec === 'NONE'        ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                       : 'bg-gray-500/20 text-gray-300 border-gray-500/30';
            return `<span class="text-xs px-2 py-0.5 rounded border ${color}">${this.escape(s || 'Open/Unknown')}</span>`;
        };
        const rows = networks.map(n => {
            const wifiKey = `${n.ssid || ''}::${n.bssid || ''}`;
            return `
            <tr class="cellebrite-wifi-row hover:bg-viper-card/30 transition">
                <td class="px-3 py-2 align-top">${this._flagBtn('wifi', wifiKey)}</td>
                <td class="px-3 py-2 text-sm text-white">${this.escape(n.ssid || '(empty SSID)')}</td>
                <td class="px-3 py-2 text-xs font-mono text-viper-cyan">${this.escape(n.bssid || '—')}</td>
                <td class="px-3 py-2">${secBadge(n.security)}</td>
                <td class="px-3 py-2 text-xs text-gray-400">${n.hidden === true ? 'hidden' : (n.hidden === false ? 'visible' : '—')}</td>
                <td class="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">${this._fmtTimestamp(n.creationTime)}</td>
                <td class="px-3 py-2 text-xs text-gray-500">${this.escape(n.creatorName || '')}</td>
                <td class="px-3 py-2">
                    ${n.preSharedKeyPresent
                        ? '<span class="text-xs text-amber-300" title="Pre-shared key field present in config — not extractable on Android 11+">PSK ⚠</span>'
                        : '<span class="text-xs text-gray-500">—</span>'
                    }
                </td>
            </tr>
            `;
        }).join('');

        return `
            <div class="space-y-4">
                <div class="flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <h3 class="text-lg font-semibold text-white">Wi-Fi Networks</h3>
                        <p class="text-sm text-gray-400">${networks.length} configured network(s)${this._paneCountHtml('wifi', networks.length)}</p>
                    </div>
                    ${this._paneSearchBarHtml('wifi', 'Search SSID, BSSID...')}
                </div>
                <div class="glass-card rounded-xl overflow-hidden" data-cb-topscroll-wrap>
                    <div class="cb-topscroll-top" data-cb-topscroll-top
                         style="overflow-x:auto;overflow-y:hidden;height:14px;border-bottom:1px solid rgba(34,211,238,0.08);">
                        <div data-cb-topscroll-ghost style="height:1px;width:1100px;"></div>
                    </div>
                    <div class="cb-topscroll-bottom" data-cb-topscroll-bottom style="overflow-x:auto;">
                        <table class="w-full text-left min-w-[1100px]">
                            <thead class="bg-viper-card/60 text-xs uppercase tracking-wider text-gray-400">
                                <tr>
                                    <th class="px-3 py-2 w-10">Flag</th>
                                    <th class="px-3 py-2">SSID</th>
                                    <th class="px-3 py-2">BSSID</th>
                                    <th class="px-3 py-2">Security</th>
                                    <th class="px-3 py-2">Visibility</th>
                                    <th class="px-3 py-2">Created</th>
                                    <th class="px-3 py-2">Creator</th>
                                    <th class="px-3 py-2">PSK</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </div>
                <div class="text-xs text-gray-500">
                    Pre-shared keys are encrypted by FBE on Android 11+ and cannot be extracted from <code>WifiConfigStore.xml</code> alone.
                </div>
            </div>
        `;
    }

    // ─── Media pane (Phase 1.4) ─────────────────────────────────────────
    // Lazy-loaded thumbnails via IntersectionObserver + cellebrite-media-read IPC.
    // Videos & audio show file icon only (no thumbnail extraction in v1).
    // Click card → modal viewer.
    renderMediaPane(data, imp) {
        if (!data) return `<div class="text-gray-500 text-sm">No media data available.</div>`;
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
            const errs = (data.errors && data.errors.length) ? data.errors.map(e => typeof e === 'string' ? e : (e.error || JSON.stringify(e))).join(', ') : '';
            return `
                <div class="space-y-3 text-sm">
                    <div class="text-gray-300 font-medium">No media indexed for this bundle.</div>
                    <div class="text-gray-500 text-xs">
                        We look under <span class="font-mono text-viper-cyan">data/media/0/</span> (DCIM, Pictures, Movies, Download, Recordings, Audio).
                        Cellebrite bundles that drop the media partition won't have entries here.
                    </div>
                    ${errs ? `<div class="text-amber-400 text-xs">Errors: ${this.escape(errs)}</div>` : ''}
                </div>
            `;
        }

        const cats = data.byCategory || {};
        const totalMB = ((data.totalBytes || 0) / (1024 * 1024)).toFixed(1);
        const sel = this._secondaryFilters.media || 'all';

        const catChip = (key, label) => {
            const n = cats[key] || 0;
            if (n === 0 && key !== 'all') return '';
            const active = (sel === key);
            const cls = active
                ? 'bg-viper-cyan text-viper-dark border-viper-cyan'
                : 'bg-viper-card/40 text-gray-300 border-gray-600/40 hover:bg-viper-card/70';
            const count = (key === 'all') ? (data.totalCount || items.length) : n;
            return `<button class="px-3 py-1.5 rounded-lg text-xs font-medium transition border ${cls}"
                            data-cb-secondary="media" data-cb-secondary-value="${key}">
                ${this.escape(label)} <span class="opacity-70 ml-1">${count}</span>
            </button>`;
        };

        return `
            <div class="space-y-4 h-full flex flex-col">
                <div class="flex items-center justify-between flex-wrap gap-3 flex-shrink-0">
                    <div>
                        <h3 class="text-lg font-semibold text-white">Media</h3>
                        <p class="text-sm text-gray-400">${items.length} file(s) · ${totalMB} MB indexed${this._paneCountHtml('media', items.length)}</p>
                    </div>
                    ${this._paneSearchBarHtml('media', 'Search filename...')}
                </div>
                <div class="flex flex-wrap gap-2 flex-shrink-0">
                    ${catChip('all', 'All')}
                    ${catChip('camera', '📷 Camera')}
                    ${catChip('screenshot', '🖥️ Screenshots')}
                    ${catChip('picture', '🖼️ Pictures')}
                    ${catChip('movie', '🎬 Videos')}
                    ${catChip('download', '⬇️ Downloads')}
                    ${catChip('recording', '🎤 Recordings')}
                    ${catChip('voice', '🔊 Audio')}
                </div>
                <div class="text-xs text-gray-500 flex-shrink-0">
                    Thumbnails load on-demand from the original UFDR — no second disk copy. Click any item to preview.
                </div>
                <div id="cellebriteMediaGrid"
                     class="glass-card rounded-xl p-3 flex-1 overflow-auto"
                     style="min-height: 400px;"></div>
            </div>
        `;
    }

    // ─── Movement (synthetic surface) ─────────────────────────────────
    //
    // Cellebrite UFDR bundles do NOT carry a device-level GPS track —
    // there is no equivalent of Android's Location History or iOS's
    // significant-locations DB in the standard reader export. The only
    // geo-tagged data in a typical Cellebrite parse is:
    //   - Media EXIF GPS (per-file lat/lng/captured_at)
    //   - Wi-Fi networks (BSSIDs, no GPS without external lookup)
    //
    // This pane surfaces what we have: a clear honest header, GPS-media
    // cluster table, and a footer pointing at Wi-Fi for BSSID-based
    // physical-network triangulation.
    renderMovementPane(imp, extras) {
        const media = (extras && extras.media && Array.isArray(extras.media.items)) ? extras.media.items : [];
        const wifi  = (extras && extras.wifi  && Array.isArray(extras.wifi.networks)) ? extras.wifi.networks
                    : (extras && extras.wifi  && Array.isArray(extras.wifi.items))    ? extras.wifi.items
                    : [];

        // Extract GPS-bearing media
        const points = [];
        for (const m of media) {
            if (!m.gps) continue;
            const lat = +(m.gps.lat ?? m.gps.latitude);
            const lng = +(m.gps.lng ?? m.gps.longitude ?? m.gps.lon);
            if (!isFinite(lat) || !isFinite(lng)) continue;
            const ts = m.capturedAt || m.createdAt || m.modifiedAt;
            const t = ts ? (typeof ts === 'number' ? ts : Date.parse(ts)) : NaN;
            points.push({ lat, lng, t: isFinite(t) ? t : null, ref: m });
        }

        const hasGps = points.length > 0;

        // Cluster (0.5° ≈ 55 km — coarse top-N for an overview)
        const clusters = hasGps ? this._mvClusterPoints(points, 0.5) : [];

        // Time span for footer
        let lo = Infinity, hi = -Infinity;
        for (const p of points) {
            if (p.t == null) continue;
            if (p.t < lo) lo = p.t;
            if (p.t > hi) hi = p.t;
        }
        const span = (isFinite(lo) && isFinite(hi))
            ? `${new Date(lo).toLocaleDateString()} → ${new Date(hi).toLocaleDateString()}`
            : null;

        return `
            <div class="glass-card p-5 rounded-xl border border-viper-cyan/20 mb-4">
                <div class="flex items-start gap-3">
                    <div class="text-2xl">🌍</div>
                    <div class="flex-1">
                        <h3 class="text-lg font-semibold text-white mb-1">Movement Overview</h3>
                        <p class="text-sm text-gray-400 leading-relaxed">
                            Cellebrite UFDR bundles do not carry a device-level GPS track. The signals below
                            are <span class="text-viper-cyan">media EXIF coordinates</span> (per-photo / per-video lat&nbsp;/&nbsp;lng)
                            and <span class="text-viper-cyan">Wi-Fi BSSIDs</span> (no GPS without external geolocation lookup).
                            For deeper geo-analysis, see <span class="text-purple-300">💡 Coach → Geo</span>.
                        </p>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
                <div class="glass-card p-4 rounded-xl">
                    <div class="text-xs text-gray-400 uppercase tracking-wide mb-1">GPS-tagged media</div>
                    <div class="text-3xl font-bold text-viper-cyan">${points.length}</div>
                </div>
                <div class="glass-card p-4 rounded-xl">
                    <div class="text-xs text-gray-400 uppercase tracking-wide mb-1">Distinct clusters</div>
                    <div class="text-3xl font-bold text-viper-cyan">${clusters.length}</div>
                </div>
                <div class="glass-card p-4 rounded-xl">
                    <div class="text-xs text-gray-400 uppercase tracking-wide mb-1">Time span</div>
                    <div class="text-sm text-gray-200 font-mono mt-2">${this.escape(span || '—')}</div>
                </div>
                <div class="glass-card p-4 rounded-xl">
                    <div class="text-xs text-gray-400 uppercase tracking-wide mb-1">Wi-Fi networks</div>
                    <div class="text-3xl font-bold text-viper-cyan">${wifi.length}</div>
                </div>
            </div>

            ${hasGps ? `
                <div class="glass-card p-3 rounded-xl mb-4">
                    <div class="flex items-center justify-between mb-2 px-2">
                        <h4 class="text-base font-semibold text-white">Interactive map</h4>
                        <div class="text-xs text-gray-400">
                            ${points.length} GPS-tagged item${points.length === 1 ? '' : 's'}
                            · click a dot for details · cluster numbers expand on click
                        </div>
                    </div>
                    <div id="cellebriteMovementMap"
                         style="height: 480px; width: 100%; border-radius: 0.5rem; background: #0a0e14; border: 1px solid rgba(34,211,238,0.2);">
                    </div>
                </div>

                <div class="glass-card p-5 rounded-xl mb-4">
                    <h4 class="text-base font-semibold text-white mb-3">Top GPS clusters (media EXIF)</h4>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead>
                                <tr class="text-left text-xs text-gray-400 uppercase border-b border-viper-cyan/20">
                                    <th class="px-3 py-2">#</th>
                                    <th class="px-3 py-2">Latitude</th>
                                    <th class="px-3 py-2">Longitude</th>
                                    <th class="px-3 py-2">Items</th>
                                    <th class="px-3 py-2">First seen</th>
                                    <th class="px-3 py-2">Last seen</th>
                                    <th class="px-3 py-2">Map</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${clusters.slice(0, 20).map((c, i) => {
                                    let cLo = Infinity, cHi = -Infinity;
                                    for (const r of c.items) {
                                        const t = r.t;
                                        if (t == null) continue;
                                        if (t < cLo) cLo = t;
                                        if (t > cHi) cHi = t;
                                    }
                                    const first = isFinite(cLo) ? new Date(cLo).toLocaleDateString() : '—';
                                    const last  = isFinite(cHi) ? new Date(cHi).toLocaleDateString() : '—';
                                    const url = `https://www.openstreetmap.org/?mlat=${c.lat.toFixed(5)}&mlon=${c.lng.toFixed(5)}#map=12/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`;
                                    return `
                                        <tr class="border-b border-viper-cyan/10 hover:bg-viper-card/30">
                                            <td class="px-3 py-2 text-gray-400">${i + 1}</td>
                                            <td class="px-3 py-2 font-mono text-xs text-gray-200">${c.lat.toFixed(5)}</td>
                                            <td class="px-3 py-2 font-mono text-xs text-gray-200">${c.lng.toFixed(5)}</td>
                                            <td class="px-3 py-2 text-viper-cyan font-semibold">${c.items.length}</td>
                                            <td class="px-3 py-2 text-xs text-gray-400">${first}</td>
                                            <td class="px-3 py-2 text-xs text-gray-400">${last}</td>
                                            <td class="px-3 py-2">
                                                <a href="${url}" target="_blank" rel="noopener"
                                                   class="text-viper-cyan hover:text-cyan-300 text-xs">↗ Open</a>
                                            </td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                    ${clusters.length > 20 ? `<div class="text-xs text-gray-500 mt-2">Showing top 20 of ${clusters.length} clusters.</div>` : ''}
                </div>
            ` : `
                <div class="glass-card p-8 rounded-xl text-center">
                    <div class="text-5xl mb-3 opacity-40">📍</div>
                    <div class="text-base text-gray-300 mb-1">No GPS-tagged media in this import</div>
                    <div class="text-sm text-gray-500">
                        Movement analysis requires EXIF GPS metadata on photos / videos.
                        Many bundles strip this on extraction or the device disabled location tagging.
                    </div>
                </div>
            `}

            <div class="glass-card p-5 rounded-xl">
                <h4 class="text-base font-semibold text-white mb-2">Wi-Fi BSSIDs (physical-network breadcrumbs)</h4>
                <p class="text-sm text-gray-400 mb-3">
                    ${wifi.length === 0
                        ? 'No Wi-Fi networks parsed for this import.'
                        : `${wifi.length} known network${wifi.length === 1 ? '' : 's'} on this device.
                           Each BSSID can be geolocated via external services (WiGLE, Mozilla Location Service) —
                           Cellebrite does not provide coordinates inline.`}
                </p>
                ${wifi.length > 0
                    ? `<button data-cb-jump-tab="wifi"
                               class="px-3 py-1.5 rounded text-sm bg-viper-cyan/20 hover:bg-viper-cyan/30 text-viper-cyan border border-viper-cyan/40">
                           Open Wi-Fi tab →
                       </button>`
                    : ''}
            </div>
        `;
    }

    /** Lightweight clustering for Movement pane — sorted by item count desc. */
    _mvClusterPoints(points, eps) {
        const used = new Array(points.length).fill(false);
        const out = [];
        for (let i = 0; i < points.length; i++) {
            if (used[i]) continue;
            const cluster = { lat: points[i].lat, lng: points[i].lng, items: [points[i]] };
            used[i] = true;
            for (let j = i + 1; j < points.length; j++) {
                if (used[j]) continue;
                if (Math.abs(points[j].lat - cluster.lat) < eps
                 && Math.abs(points[j].lng - cluster.lng) < eps) {
                    cluster.items.push(points[j]);
                    used[j] = true;
                }
            }
            out.push(cluster);
        }
        out.sort((a, b) => b.items.length - a.items.length);
        return out;
    }

    /**
     * Mount an interactive Leaflet map with one marker per GPS-tagged
     * media item, grouped via MarkerCluster. Popups carry filename,
     * captured-at, OSM deep link, and a Flag button that round-trips
     * through the existing flag-toggle delegation (data-cb-flag-section/key).
     */
    _mountMovementMap(pane, imp, extras) {
        const host = pane.querySelector('#cellebriteMovementMap');
        if (!host) return;
        if (typeof L === 'undefined' || typeof L.map !== 'function') {
            host.innerHTML = `<div class="p-4 text-amber-300 text-sm">Leaflet not loaded — map unavailable.</div>`;
            return;
        }
        // Tear down any prior map (sub-tab switch / import switch).
        this._destroyMovementMap();

        const media = (extras && extras.media && Array.isArray(extras.media.items)) ? extras.media.items : [];
        const pts = [];
        for (const m of media) {
            if (!m.gps) continue;
            const lat = +(m.gps.lat ?? m.gps.latitude);
            const lng = +(m.gps.lng ?? m.gps.longitude ?? m.gps.lon);
            if (!isFinite(lat) || !isFinite(lng)) continue;
            pts.push({ lat, lng, ref: m });
        }
        if (!pts.length) return;

        const map = L.map(host, {
            zoomControl: true,
            attributionControl: false,
            preferCanvas: false,
        }).setView([pts[0].lat, pts[0].lng], 10);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap',
        }).addTo(map);

        // Use clustering when available (libs/leaflet.markercluster.js).
        const group = (typeof L.markerClusterGroup === 'function')
            ? L.markerClusterGroup({
                showCoverageOnHover: false,
                spiderfyOnMaxZoom: true,
                maxClusterRadius: 40,
            })
            : L.layerGroup();

        const isFlagged = (key) => this.module.isFlagged('media', key);

        for (const p of pts) {
            const m = p.ref;
            const flagged = isFlagged(m.id);
            const dot = L.circleMarker([p.lat, p.lng], {
                radius: 7,
                color: flagged ? '#f59e0b' : '#22d3ee',
                weight: 2,
                fillColor: flagged ? '#f59e0b' : '#22d3ee',
                fillOpacity: 0.7,
            });

            const cap = m.capturedAt || m.createdAt || m.modifiedAt;
            const when = cap ? new Date(typeof cap === 'number' ? cap : Date.parse(cap)).toLocaleString() : '—';
            const osmUrl = `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(5)}&mlon=${p.lng.toFixed(5)}#map=17/${p.lat.toFixed(5)}/${p.lng.toFixed(5)}`;
            const safeName = this.escape(m.filename || '(unnamed)');
            const safeType = this.escape(m.type || 'other');
            const safeCat  = this.escape(m.category || '');

            // Flag button keeps the standard data-cb-flag-* attrs so the
            // pane-level delegated click handler updates flag state +
            // toolbar count without us re-wiring inside Leaflet's popup.
            const flagBtnClass = flagged
                ? 'cb-flag-toggle inline-flex items-center justify-center w-7 h-7 rounded border bg-amber-500/25 border-amber-400 text-amber-100 transition text-sm'
                : 'cb-flag-toggle inline-flex items-center justify-center w-7 h-7 rounded border bg-viper-card/30 border-gray-700 text-gray-500 hover:border-amber-400 hover:text-amber-300 transition text-sm';

            const popupHtml = `
                <div style="min-width:220px;max-width:280px;color:#e5e7eb">
                    <div style="font-weight:600;margin-bottom:4px;word-break:break-all">${safeName}</div>
                    <div style="font-size:11px;color:#9ca3af;margin-bottom:6px">
                        ${safeType}${safeCat ? ` · ${safeCat}` : ''}
                    </div>
                    <div style="font-size:11px;color:#9ca3af;margin-bottom:6px">📅 ${this.escape(when)}</div>
                    <div style="font-family:monospace;font-size:10px;color:#9ca3af;margin-bottom:8px">
                        ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}
                    </div>
                    <div style="display:flex;gap:6px;align-items:center">
                        <button class="${flagBtnClass}"
                                data-cb-flag-section="media"
                                data-cb-flag-key="${this.escape(m.id)}"
                                title="${flagged ? 'Click to unflag' : 'Flag for evidence bundle'}">
                            ${flagged ? '🚩' : '⚐'}
                        </button>
                        <a href="${osmUrl}" target="_blank" rel="noopener"
                           style="font-size:11px;color:#22d3ee;text-decoration:none">↗ OSM</a>
                    </div>
                </div>
            `;
            dot.bindPopup(popupHtml, { closeButton: true, autoPan: true });
            // Explicit click handler + cursor — defensive against canvas/SVG
            // edge cases where small circle markers occasionally don't surface
            // their click through the cluster group.
            dot.on('click', () => dot.openPopup());
            dot.on('mouseover', () => { try { dot.setStyle({ radius: 9 }); } catch (_) {} });
            dot.on('mouseout',  () => { try { dot.setStyle({ radius: 7 }); } catch (_) {} });
            group.addLayer(dot);
        }

        map.addLayer(group);

        // Fit bounds to all points (1-point case: stay at zoom 13).
        try {
            const bounds = group.getBounds && group.getBounds();
            if (bounds && bounds.isValid && bounds.isValid()) {
                if (pts.length === 1) {
                    map.setView([pts[0].lat, pts[0].lng], 13);
                } else {
                    map.fitBounds(bounds.pad(0.15));
                }
            }
        } catch (_) {}

        this._movementMap = map;

        // Tiles can paint at 0×0 if pane wasn't laid out yet on first render —
        // a deferred invalidateSize() fixes it.
        setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 60);
    }

    _destroyMovementMap() {
        if (this._movementMap) {
            try { this._movementMap.remove(); } catch (_) {}
            this._movementMap = null;
        }
    }


    // Mount the actual grid into #cellebriteMediaGrid AFTER pane innerHTML
    // is in the DOM. Builds lightweight cards (no bytes loaded yet); an
    // IntersectionObserver fetches thumbnails as cards scroll into view.
    _mountMediaGrid(pane, data, imp) {
        const host = pane.querySelector('#cellebriteMediaGrid');
        if (!host) return;
        const items = Array.isArray(data?.items) ? data.items : [];

        // Tear down any previous observer / blob URLs from a prior mount.
        this._destroyMediaGrid();

        this._mediaState = {
            host,
            items,
            imp,
            blobUrls: new Map(),  // id → url (for revoke on destroy)
            observer: null,
            visibleIds: new Set(),
        };

        this._renderMediaGridCards();
        this._applyPaneFilter(pane, 'media');
        this._wireMediaGridEvents(pane);
    }

    _destroyMediaGrid() {
        const s = this._mediaState;
        if (!s) return;
        if (s.observer) { try { s.observer.disconnect(); } catch (_) {} }
        for (const url of s.blobUrls.values()) {
            try { URL.revokeObjectURL(url); } catch (_) {}
        }
        s.blobUrls.clear();
        this._mediaState = null;
    }

    _renderMediaGridCards() {
        const s = this._mediaState;
        if (!s) return;
        const html = s.items.map((it) => this._renderMediaCard(it)).join('');
        s.host.innerHTML = `
            <div class="grid gap-3"
                 style="grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));">
                ${html}
                <div id="cellebriteMediaEmpty" class="hidden col-span-full py-8 text-center text-gray-500 text-sm">
                    No media match the current filters.
                </div>
            </div>
        `;
        this._installMediaObserver();
    }

    _renderMediaCard(it) {
        const isImg = it.type === 'image';
        const isVid = it.type === 'video';
        const isAud = it.type === 'audio';
        const icon = isVid ? '🎬' : isAud ? '🎵' : '📄';
        const sizeKB = ((it.size || 0) / 1024).toFixed(0);
        const flagBtn = this._flagBtn('media', it.id);
        const captured = it.capturedAt ? this._fmtTimestamp(Date.parse(it.capturedAt)) : '';
        const gpsBadge = it.gps
            ? `<span class="text-[10px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" title="${it.gps.lat?.toFixed?.(5)}, ${it.gps.lon?.toFixed?.(5)}">📍 GPS</span>`
            : '';
        return `
            <div class="cb-media-card relative group rounded-lg border border-viper-cyan/15 bg-viper-card/30 hover:border-viper-cyan/50 transition cursor-pointer overflow-hidden"
                 data-cb-media-id="${this.escape(it.id)}"
                 data-cb-media-cat="${this.escape(it.category)}"
                 data-cb-media-search="${this.escape((it.filename || '').toLowerCase())}">
                <div class="absolute top-1 left-1 z-10">${flagBtn}</div>
                <div class="cb-media-thumb-wrap aspect-square bg-black/40 flex items-center justify-center overflow-hidden"
                     data-cb-media-thumb="${this.escape(it.id)}">
                    ${isImg
                        ? `<div class="cb-media-placeholder text-gray-600 text-3xl">🖼️</div>`
                        : `<div class="text-5xl opacity-60">${icon}</div>`}
                </div>
                <div class="px-2 py-1.5 text-[11px] text-gray-300 truncate" title="${this.escape(it.filename)}">
                    ${this.escape(it.filename)}
                </div>
                <div class="px-2 pb-1.5 flex items-center justify-between text-[10px] text-gray-500">
                    <span>${sizeKB} KB</span>
                    <span>${this.escape(it.ext.toUpperCase())}</span>
                </div>
                ${(captured || gpsBadge) ? `
                    <div class="px-2 pb-1.5 flex items-center justify-between gap-1 text-[10px]">
                        <span class="text-gray-500 truncate">${this.escape(captured)}</span>
                        ${gpsBadge}
                    </div>` : ''}
            </div>
        `;
    }

    _installMediaObserver() {
        const s = this._mediaState;
        if (!s || !s.host) return;
        if (typeof IntersectionObserver === 'undefined') return; // graceful: no lazy load

        s.observer = new IntersectionObserver((entries) => {
            for (const en of entries) {
                if (!en.isIntersecting) continue;
                const wrap = en.target;
                const id = wrap.dataset.cbMediaThumb;
                if (!id || s.visibleIds.has(id)) continue;
                s.visibleIds.add(id);
                s.observer.unobserve(wrap);
                this._loadMediaThumb(id, wrap);
            }
        }, { root: s.host, rootMargin: '300px 0px', threshold: 0.01 });

        s.host.querySelectorAll('[data-cb-media-thumb]').forEach(el => {
            s.observer.observe(el);
        });
    }

    async _loadMediaThumb(id, wrap) {
        const s = this._mediaState;
        if (!s) return;
        const item = s.items.find(x => x.id === id);
        if (!item || item.type !== 'image') return;
        // Cap auto-thumb to 8 MB; larger images load only on modal open.
        if ((item.size || 0) > 8 * 1024 * 1024) {
            wrap.innerHTML = `<div class="text-gray-500 text-xs text-center px-2">Click to view<br><span class="text-[10px]">${((item.size||0)/(1024*1024)).toFixed(1)} MB</span></div>`;
            return;
        }
        const api = window.electronAPI;
        if (!api || !api.cellebriteMediaRead) return;

        try {
            const r = await api.cellebriteMediaRead({
                caseNumber: this.module.caseNumber,
                importId: s.imp.id,
                mediaId: id,
            });
            if (!r || !r.success || !r.buffer) {
                wrap.innerHTML = `<div class="text-red-400 text-xs text-center px-2">load failed</div>`;
                return;
            }
            const bin = atob(r.buffer);
            const len = bin.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: r.mime || item.mime });
            const url = URL.createObjectURL(blob);
            s.blobUrls.set(id, url);
            wrap.innerHTML = `<img src="${url}" loading="lazy" class="w-full h-full object-cover" alt="${this.escape(item.filename)}">`;
        } catch (e) {
            wrap.innerHTML = `<div class="text-red-400 text-xs text-center px-2">${this.escape(e.message || String(e))}</div>`;
        }
    }

    _wireMediaGridEvents(pane) {
        if (pane._cbMediaWired) return;
        pane._cbMediaWired = true;
        pane.addEventListener('click', (ev) => {
            const card = ev.target.closest('.cb-media-card');
            if (!card) return;
            // Ignore clicks on the flag button — the global delegate handles it.
            if (ev.target.closest('[data-cb-flag-btn]')) return;
            const id = card.dataset.cbMediaId;
            if (id) this._openMediaModal(id);
        });
    }

    async _openMediaModal(id) {
        const s = this._mediaState;
        if (!s) return;
        const item = s.items.find(x => x.id === id);
        if (!item) return;
        const api = window.electronAPI;

        // Backdrop
        const wrap = document.createElement('div');
        wrap.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-4';
        wrap.innerHTML = `
            <div class="relative max-w-5xl w-full glass-card rounded-xl p-4 flex flex-col gap-3 max-h-[90vh] overflow-hidden">
                <div class="flex items-center justify-between gap-3 flex-shrink-0">
                    <div class="min-w-0">
                        <div class="text-sm text-white truncate" title="${this.escape(item.filename)}">${this.escape(item.filename)}</div>
                        <div class="text-[11px] text-gray-400">${this.escape(item.category)} · ${this.escape(item.mime)} · ${((item.size||0)/1024).toFixed(0)} KB${item.capturedAt ? ` · ${this.escape(this._fmtTimestamp(Date.parse(item.capturedAt)))}` : ''}</div>
                    </div>
                    <button class="text-gray-400 hover:text-white text-xl px-2" data-cb-media-close>✕</button>
                </div>
                <div class="flex-1 overflow-auto flex items-center justify-center" data-cb-media-body>
                    <div class="text-gray-400 text-sm">Loading...</div>
                </div>
                <div class="flex items-center justify-between text-[11px] text-gray-500 flex-shrink-0">
                    <span class="font-mono truncate" title="${this.escape(item.entryPath)}">${this.escape(item.entryPath)}</span>
                    ${item.gps ? `<span class="text-emerald-300">📍 ${item.gps.lat.toFixed(5)}, ${item.gps.lon.toFixed(5)}</span>` : ''}
                </div>
            </div>
        `;
        const close = () => { try { document.body.removeChild(wrap); } catch (_) {} document.removeEventListener('keydown', onEsc); };
        const onEsc = (e) => { if (e.key === 'Escape') close(); };
        wrap.querySelector('[data-cb-media-close]').addEventListener('click', close);
        wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
        document.addEventListener('keydown', onEsc);
        document.body.appendChild(wrap);

        const body = wrap.querySelector('[data-cb-media-body]');
        try {
            const r = await api.cellebriteMediaRead({
                caseNumber: this.module.caseNumber,
                importId: s.imp.id,
                mediaId: id,
            });
            if (!r || !r.success) {
                body.innerHTML = `<div class="text-red-400 text-sm">${this.escape(r?.error || 'failed to read media')}</div>`;
                return;
            }
            const bin = atob(r.buffer);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: r.mime || item.mime });
            const url = URL.createObjectURL(blob);
            // Track for revoke alongside the rest
            s.blobUrls.set(`modal:${id}`, url);

            if (item.type === 'image') {
                body.innerHTML = `<img src="${url}" class="max-w-full max-h-[70vh] object-contain" alt="${this.escape(item.filename)}">`;
            } else if (item.type === 'video') {
                body.innerHTML = `<video src="${url}" controls autoplay class="max-w-full max-h-[70vh]"></video>`;
            } else if (item.type === 'audio') {
                body.innerHTML = `
                    <div class="flex flex-col items-center gap-3 p-6">
                        <div class="text-6xl">🎵</div>
                        <audio src="${url}" controls autoplay class="w-full max-w-md"></audio>
                    </div>
                `;
            } else {
                body.innerHTML = `<a href="${url}" download="${this.escape(item.filename)}" class="text-viper-cyan underline">Download ${this.escape(item.filename)}</a>`;
            }
        } catch (e) {
            body.innerHTML = `<div class="text-red-400 text-sm">${this.escape(e.message || String(e))}</div>`;
        }
    }

    // ─── small formatters used by 1.3 panes ─────────────────────────────
    _fmtTimestamp(ms) {
        if (ms == null || !Number.isFinite(Number(ms))) return '—';
        const n = Number(ms);
        if (n <= 0) return '—';
        // Some stores write seconds — heuristic: anything below year 2001 in ms = seconds.
        const epoch = (n < 1e12) ? n * 1000 : n;
        try {
            const d = new Date(epoch);
            if (isNaN(d.getTime())) return '—';
            const pad = (x) => String(x).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch (_) { return '—'; }
    }

    _fmtDuration(seconds) {
        const s = Number(seconds || 0);
        if (!s) return '0s';
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const r = s % 60;
        if (m < 60) return `${m}m ${r}s`;
        const h = Math.floor(m / 60);
        const rm = m % 60;
        return `${h}h ${rm}m`;
    }

    // ─── Event wiring ────────────────────────────────────────────────────

    wireMainEvents(root) {
        const importBtn = root.querySelector('#cellebriteImportBtn');
        if (importBtn) importBtn.addEventListener('click', () => this.onImportClick());

        // Top-bar Coach button → toggle Insights drawer.
        const coachBtn = root.querySelector('#cellebriteCoachBtn');
        if (coachBtn && !coachBtn.disabled && this.module.coach) {
            coachBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.module.coach.toggle();
            });
        }

        // Top-bar import switcher (dropdown — replaces left-rail row clicks).
        const switcher = root.querySelector('#cellebriteImportSwitcher');
        if (switcher) {
            switcher.addEventListener('change', (ev) => {
                const id = ev.target.value;
                this.module.setActiveImport(id);
            });
        }

        // Top-bar Delete button (replaces rail ✕ and sub-tab-bar Delete Import).
        const deleteBtn = root.querySelector('#cellebriteDeleteBtn');
        if (deleteBtn && !deleteBtn.disabled) {
            deleteBtn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const imp = this.module.getActiveImport();
                if (!imp) return;
                const label = imp.deviceLabel || imp.evidenceTag || imp.id;
                if (!confirm(`Delete "${label}"?\n\nThis removes:\n  • parsed/*.json (contacts, SMS, calls, media index, ...)\n  • extracted SQLite + XML files\n  • manifest.json + log.txt\n  • source/ copy (if 'imported' mode)\n\nThe import will disappear from the dropdown. You can re-import the original UFDR bundle afterward.`)) return;
                await this.module.deleteImport(imp.id);
                if (typeof viperToast === 'function') viperToast('Cellebrite import deleted', 'success');
            });
        }

        // Sub-tab click → switch active surface.
        root.querySelectorAll('.cellebrite-subtab').forEach(el => {
            el.addEventListener('click', () => {
                const tab = el.dataset.subtab;
                this.module.setActiveSubTab(tab);
            });
        });

        // Phase 1.4 UI parity: wire top-bar Flags pill toggle + popover.
        this._wireFlagToolbar(root);
    }

    // ─── Phase 1.2: Full import flow ────────────────────────────────────
    async onImportClick() {
        const picked = await this.module.pickBundle();
        if (!picked) return;

        // Show scanning indicator.
        this._showProgressOverlay({ stage: 'scanning', label: 'Scanning bundle...', current: 0, total: 1 });
        const scan = await this.module.scanBundle(picked.ufdxPath);
        this._hideProgressOverlay();
        if (!scan || !scan.success) {
            if (typeof viperToast === 'function') {
                viperToast('Scan failed: ' + (scan?.error || 'unknown'), 'error');
            }
            return;
        }

        // Confirm modal: show what was found.
        const ok = await this._confirmImport(picked, scan);
        if (!ok) return;
        const sourceMode = ok.sourceMode;
        const evidenceTag = ok.evidenceTag;

        // Run the import.
        this._showProgressOverlay({ stage: 'precheck', label: 'Starting import...', current: 0, total: 1 });
        const r = await this.module.importBundle({
            picked,
            scan,
            sourceMode,
            evidenceTag,
            onProgress: (p) => this._showProgressOverlay(p),
        });
        this._hideProgressOverlay();

        if (!r || !r.success) {
            if (r && r.cancelled) {
                if (typeof viperToast === 'function') viperToast('Import cancelled', 'info');
            } else if (r && r.diskBlocked) {
                alert(`Not enough disk space.\nBundle needs ~${this.fmtBytes(r.required)} but only ${this.fmtBytes(r.free)} free on the target volume.\n\nSwitch to "Reference in place" mode or free up space.`);
            } else {
                if (typeof viperToast === 'function') {
                    viperToast('Import failed: ' + (r?.error || 'unknown'), 'error');
                }
            }
            this.module.render();
            return;
        }

        const c = r.counts || {};
        if (typeof viperToast === 'function') {
            viperToast(`Cellebrite import complete — ${c.apps || 0} apps, ${c.contacts || 0} contacts`, 'success');
        }
        this.module.render();
    }

    // ─── Confirm modal ──────────────────────────────────────────────────
    _confirmImport(picked, scan) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50';
            const deviceModel = scan?.ufds?.[0]?.parsed?.data?.model || 'Unknown device';
            const make        = scan?.ufds?.[0]?.parsed?.data?.make || '';
            const androidVer  = scan?.ufds?.[0]?.parsed?.data?.androidVersion || '';
            const tIdx = scan?.targetIndex || {};
            const targetRows = Object.keys(tIdx).map(k => {
                const total = tIdx[k].reduce((a, t) => a + (t.size || 0), 0);
                return `<div class="flex justify-between text-xs py-1 border-b border-gray-700/50 last:border-0">
                    <span class="font-mono text-viper-cyan">${this.escape(k)}</span>
                    <span class="text-gray-400">${this.fmtBytes(total)}</span>
                </div>`;
            }).join('') || `<div class="text-xs text-amber-400">No targets detected — bundle may be empty or encrypted.</div>`;

            overlay.innerHTML = `
                <div class="glass-card p-6 rounded-xl max-w-xl w-full max-h-[90vh] overflow-auto">
                    <h3 class="text-lg font-bold text-white mb-1">Confirm Cellebrite Import</h3>
                    <p class="text-sm text-gray-400 mb-4">${this.escape(make)} ${this.escape(deviceModel)} ${androidVer ? '· Android ' + this.escape(androidVer) : ''}</p>

                    <div class="text-xs text-gray-500 mb-1">Bundle size: <span class="text-gray-300">${this.fmtBytes(picked.bundleSize)}</span></div>
                    <div class="text-xs text-gray-500 mb-3">Target files to extract:</div>
                    <div class="bg-viper-card/40 rounded p-3 mb-4 max-h-48 overflow-auto">
                        ${targetRows}
                    </div>

                    <label class="block mb-3">
                        <div class="text-xs text-gray-400 mb-1">Evidence tag (optional)</div>
                        <input id="cbConfirmEvidenceTag" type="text" placeholder="e.g. EVID-CELL-001"
                               class="w-full px-3 py-2 bg-viper-card/40 border border-gray-700 rounded text-sm text-white" />
                    </label>

                    <div class="mb-4">
                        <div class="text-xs text-gray-400 mb-2">Source mode</div>
                        <div class="space-y-2">
                            <label class="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-viper-card/30">
                                <input type="radio" name="cbSourceMode" value="referenced" checked class="mt-1" />
                                <div>
                                    <div class="text-sm text-white">Reference in place</div>
                                    <div class="text-xs text-gray-400">Read the bundle from its current location. Smaller case folder, but the bundle must remain accessible.</div>
                                </div>
                            </label>
                            <label class="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-viper-card/30">
                                <input type="radio" name="cbSourceMode" value="imported" class="mt-1" />
                                <div>
                                    <div class="text-sm text-white">Import into case folder</div>
                                    <div class="text-xs text-gray-400">Copy the full bundle (${this.fmtBytes(picked.bundleSize)}) into the case folder. Recommended for chain of custody.</div>
                                </div>
                            </label>
                        </div>
                    </div>

                    <div class="flex justify-end gap-2">
                        <button id="cbConfirmCancel" class="px-4 py-2 bg-viper-card/60 hover:bg-viper-card text-gray-300 rounded text-sm">Cancel</button>
                        <button id="cbConfirmGo" class="px-4 py-2 bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan text-viper-cyan rounded text-sm font-semibold">Start Import</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            overlay.querySelector('#cbConfirmCancel').addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(null);
            });
            overlay.querySelector('#cbConfirmGo').addEventListener('click', () => {
                const sourceMode = overlay.querySelector('input[name="cbSourceMode"]:checked')?.value || 'referenced';
                const evidenceTag = (overlay.querySelector('#cbConfirmEvidenceTag')?.value || '').trim() || null;
                document.body.removeChild(overlay);
                resolve({ sourceMode, evidenceTag });
            });
        });
    }

    // ─── Progress overlay ───────────────────────────────────────────────
    _showProgressOverlay(p) {
        let overlay = document.getElementById('cellebriteProgressOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'cellebriteProgressOverlay';
            overlay.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50';
            overlay.innerHTML = `
                <div class="glass-card p-6 rounded-xl max-w-md w-full">
                    <h3 class="text-lg font-bold text-white mb-2 flex items-center gap-2">
                        <div class="w-4 h-4 border-2 border-viper-cyan border-t-transparent rounded-full animate-spin"></div>
                        Cellebrite Import
                    </h3>
                    <div id="cbProgressStage" class="text-sm text-viper-cyan mb-1">—</div>
                    <div id="cbProgressLabel" class="text-xs text-gray-400 mb-3 truncate">—</div>
                    <div class="w-full bg-viper-card rounded-full h-2 overflow-hidden">
                        <div id="cbProgressBar" class="h-full bg-viper-cyan transition-all duration-200" style="width: 0%"></div>
                    </div>
                    <div id="cbProgressCount" class="text-xs text-gray-500 mt-2 text-right">—</div>
                </div>
            `;
            document.body.appendChild(overlay);
        }
        const stage = String(p.stage || '').replace(/-/g, ' ');
        document.getElementById('cbProgressStage').textContent = stage;
        document.getElementById('cbProgressLabel').textContent = p.label || '';
        const pct = (p.total && p.total > 0) ? Math.min(100, Math.round((p.current / p.total) * 100)) : 0;
        document.getElementById('cbProgressBar').style.width = pct + '%';
        document.getElementById('cbProgressCount').textContent = (p.total && p.total > 0)
            ? `${this._formatProgressNumber(p.current)} / ${this._formatProgressNumber(p.total)}`
            : '';
    }

    _formatProgressNumber(n) {
        if (n > 1024 * 1024) return this.fmtBytes(n);
        return String(n);
    }

    _hideProgressOverlay() {
        const overlay = document.getElementById('cellebriteProgressOverlay');
        if (overlay) overlay.remove();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    escape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    fmtBytes(n) {
        if (!n || n < 0) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0; let v = n;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
    }
}

window.CellebriteUI = CellebriteUI;
