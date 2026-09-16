/**
 * P2P Activity Check — renderer half.
 *
 * Ported from Project Oversight's ScanDisclaimerModal + P2PScanChrome.
 * Requires modules/p2p-scan/p2p-scan.js (pure core) to be loaded first.
 *
 * Three pieces:
 *   1. buttonHtml()  — the scan button rendered on an IP identifier row.
 *   2. The acknowledgement gate. Deliberately NOT dismissible-forever.
 *      The examiner re-reads the limitations on every scan because the
 *      output of that scan can end up in a case file. There is no
 *      "don't show this again" — that is the point.
 *   3. The scan window: a slim chrome bar over a BrowserView.
 *
 * WHY A BROWSERVIEW: torrentanalytics.net sends `X-Frame-Options: DENY`
 * and `frame-ancestors 'none'`. An iframe/webview embed is refused by
 * Chromium itself. The BrowserView lives in main; this file only reports
 * where to put it.
 *
 * "Save to Evidence" does not write anything itself — it asks main for a
 * printToPDF and main emits `rh-download-ready`, which resource-hub's
 * existing destination-picker modal handles. That modal broadcasts
 * `pulse:bv-suspend` first (a native BrowserView renders above ALL DOM
 * regardless of z-index, so the modal would otherwise open *behind* this
 * scan window), which is why this module honours that contract below.
 */
(function () {
    'use strict';

    const Core = window.P2PScanCore;
    if (!Core) {
        console.error('[p2p-scan] core module missing — load p2p-scan.js first');
        return;
    }

    const OVERLAY_ID = 'p2pScanOverlay';
    const SLOT_ID = 'p2pScanBVSlot';
    const GATE_ID = 'p2pScanGate';

    let open = false;
    let currentIp = '';
    let bvSuspended = false;
    let resizeBound = false;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function toast(msg, kind) {
        try {
            if (typeof window.viperToast === 'function') return window.viperToast(msg, kind || 'info');
            if (typeof window.showToast === 'function') return window.showToast(msg, kind || 'info');
        } catch (_) { /* fall through */ }
        console.log('[p2p-scan]', kind || 'info', msg);
    }

    /* ── 1. Identifier-row button ─────────────────────────────── */

    /**
     * HTML for the button that sits beside an IP identifier.
     * Returns '' when the feature is switched off in Settings, so a
     * department that has not enabled it never sees the affordance.
     *
     * An enabled-but-unscannable address still renders a dimmed button
     * carrying the reason, because "why is there no button on this row?"
     * is a worse question than "why is this one greyed out?".
     */
    function buttonHtml(ip) {
        if (!Core.isEnabled()) return '';
        const value = String(ip == null ? '' : ip).trim();
        if (!value) return '';
        const reason = Core.unscannableReason('ip', value);
        if (reason) {
            return `<button disabled title="${esc(reason)}" class="px-2 py-1 bg-gray-600/10 border border-gray-600/40 rounded text-gray-500 text-xs cursor-not-allowed">🧲 P2P</button>`;
        }
        return `<button onclick="window.P2PScan.scan('${esc(value)}')" title="Check this IP for public BitTorrent activity (TorrentAnalytics)" class="px-2 py-1 bg-fuchsia-500/20 hover:bg-fuchsia-500/30 border border-fuchsia-500/50 rounded text-fuchsia-300 text-xs transition">🧲 P2P</button>`;
    }

    /* ── 2. Acknowledgement gate ──────────────────────────────── */

    function scan(ip) {
        const value = String(ip == null ? '' : ip).trim();
        if (!Core.isEnabled()) {
            toast('P2P Activity Check is disabled. Enable it in Settings → Investigative Resources.', 'warning');
            return;
        }
        const reason = Core.unscannableReason('ip', value);
        if (reason) { toast(reason, 'warning'); return; }

        const existing = document.getElementById(GATE_ID);
        if (existing) existing.remove();

        const gate = document.createElement('div');
        gate.id = GATE_ID;
        gate.className = 'p2p-gate';
        gate.innerHTML = `
            <div class="p2p-gate-card" role="dialog" aria-modal="true" aria-labelledby="p2pGateTitle">
                <div class="p2p-gate-head">
                    <div class="p2p-gate-head-l">
                        <span class="p2p-gate-icon">🛡</span>
                        <h2 id="p2pGateTitle">Before you scan</h2>
                    </div>
                    <button type="button" class="p2p-gate-x" title="Cancel" data-p2p-cancel>&times;</button>
                </div>
                <div class="p2p-gate-body">
                    <div class="p2p-gate-target">
                        <span class="p2p-gate-muted">Looking up</span>
                        <span class="p2p-gate-ip">${esc(value)}</span>
                        <span class="p2p-gate-chip">torrentanalytics</span>
                    </div>
                    <div class="p2p-gate-caveat">${esc(Core.CAVEAT)}</div>
                </div>
                <div class="p2p-gate-foot">
                    <button type="button" class="p2p-btn-ghost" data-p2p-cancel>Cancel</button>
                    <button type="button" class="p2p-btn-go" data-p2p-go>I Understand — Run Scan</button>
                </div>
            </div>`;
        gate.addEventListener('click', e => { if (e.target === gate) gate.remove(); });
        gate.querySelectorAll('[data-p2p-cancel]').forEach(b => b.addEventListener('click', () => gate.remove()));
        gate.querySelector('[data-p2p-go]').addEventListener('click', () => {
            gate.remove();
            openScanWindow(value);
        });
        document.body.appendChild(gate);
        try { gate.querySelector('[data-p2p-go]').focus(); } catch (_) {}
    }

    /* ── 3. Scan window ───────────────────────────────────────── */

    function ensureOverlay() {
        let el = document.getElementById(OVERLAY_ID);
        if (el) return el;
        el = document.createElement('div');
        el.id = OVERLAY_ID;
        el.className = 'p2p-overlay hidden';
        el.innerHTML = `
            <div class="p2p-hairline"></div>
            <div class="p2p-chrome">
                <span class="p2p-brand-dot">◎</span>
                <span class="p2p-brand">TorrentAnalytics</span>
                <span class="p2p-ip" id="p2pScanIpLabel"></span>
                <span class="p2p-spacer"></span>
                <span class="p2p-info" tabindex="0" title="${esc(Core.CAVEAT)}">ⓘ</span>
                <button type="button" class="p2p-chrome-btn" id="p2pScanReloadBtn" title="Reload">⟳</button>
                <button type="button" class="p2p-btn-go p2p-btn-sm" id="p2pScanSaveBtn">Save to Evidence</button>
                <button type="button" class="p2p-chrome-x" id="p2pScanCloseBtn" title="Close">&times;</button>
            </div>
            <div class="p2p-caveat-strip">${esc(Core.CAVEAT)}</div>
            <div class="p2p-bv" id="${SLOT_ID}">
                <span class="p2p-bv-placeholder">Loading TorrentAnalytics…</span>
            </div>`;
        document.body.appendChild(el);

        el.querySelector('#p2pScanCloseBtn').addEventListener('click', close);
        el.querySelector('#p2pScanSaveBtn').addEventListener('click', saveToEvidence);
        el.querySelector('#p2pScanReloadBtn').addEventListener('click', async () => {
            try { await window.electronAPI.p2pScanReload(); } catch (_) {}
        });
        return el;
    }

    /**
     * Report the slot rectangle to main.
     *
     * viper-prefs.js applies CSS `zoom` on <body> for font scaling. In
     * Chromium, getBoundingClientRect inside a zoomed ancestor returns
     * layout-pixel (pre-zoom) coordinates while BrowserView.setBounds
     * wants the window's CSS pixels, so multiply by the live body zoom —
     * same correction resource-hub's positionBV() makes.
     */
    function slotBounds() {
        const slot = document.getElementById(SLOT_ID);
        if (!slot) return null;
        const r = slot.getBoundingClientRect();
        let z = 1;
        try {
            const cz = parseFloat(getComputedStyle(document.body).zoom);
            if (cz && !Number.isNaN(cz) && cz > 0) z = cz;
        } catch (_) { /* ignore */ }
        const b = {
            x: Math.round(r.x * z), y: Math.round(r.y * z),
            width: Math.round(r.width * z), height: Math.round(r.height * z),
        };
        if (b.width < 10 || b.height < 10) return null;
        return b;
    }

    function reposition() {
        if (!open || bvSuspended || !window.electronAPI) return;
        const b = slotBounds();
        if (b) window.electronAPI.p2pScanSetBounds(b);
    }

    async function openScanWindow(ip) {
        if (!window.electronAPI || !window.electronAPI.p2pScanOpen) {
            toast('P2P scan unavailable (electronAPI missing).', 'error');
            return;
        }
        const el = ensureOverlay();
        currentIp = ip;
        el.querySelector('#p2pScanIpLabel').textContent = ip;
        el.classList.remove('hidden');
        open = true;
        bvSuspended = false;
        bindGlobals();

        // The slot has no size until after layout, and a BrowserView
        // attached at 0x0 gets its network I/O suspended by Chromium
        // (ERR_NETWORK_IO_SUSPENDED) — the exact failure the 5.1.5 BV work
        // chased. Wait one frame so the bounds we send are real.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const b = slotBounds();
        if (!b) { toast('Could not size the scan window.', 'error'); closeOverlayOnly(); return; }

        const res = await window.electronAPI.p2pScanOpen({ ip, bounds: b });
        if (!res || !res.success) {
            toast('Scan failed: ' + ((res && res.error) || 'unknown'), 'error');
            closeOverlayOnly();
        }
    }

    async function saveToEvidence() {
        const btn = document.getElementById('p2pScanSaveBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Capturing…'; }
        try {
            const r = await window.electronAPI.p2pScanCapturePdf();
            if (!r || !r.success) {
                toast('Capture failed: ' + ((r && r.error) || 'unknown'), 'error');
            }
            // On success main emits rh-download-ready and resource-hub's
            // destination picker takes over. That modal broadcasts
            // pulse:bv-suspend, which hides this BV so the modal is
            // reachable — see the listener in bindGlobals().
        } catch (e) {
            toast('Capture error: ' + (e.message || e), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Save to Evidence'; }
        }
    }

    function closeOverlayOnly() {
        open = false;
        const el = document.getElementById(OVERLAY_ID);
        if (el) el.classList.add('hidden');
    }

    function close() {
        closeOverlayOnly();
        try {
            if (window.electronAPI && window.electronAPI.p2pScanClose) window.electronAPI.p2pScanClose();
        } catch (_) {}
    }

    function bindGlobals() {
        if (resizeBound) return;
        resizeBound = true;
        window.addEventListener('resize', reposition);
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && open) close();
        });
        // A native BrowserView renders above all DOM, so any module that
        // needs to show a modal asks every BV owner to stand down.
        //
        // Detaching the view is NOT enough here: this overlay's own DOM
        // sits at z-index 10040 with an opaque background, and the
        // resource-hub download router it is standing down for is only
        // z-[10001]. Without hiding the overlay too, the evidence
        // destination picker opens behind it and cannot be reached — the
        // same class of bug one layer down.
        window.addEventListener('pulse:bv-suspend', () => {
            if (!open) return;
            bvSuspended = true;
            const el = document.getElementById(OVERLAY_ID);
            if (el) el.classList.add('hidden');
            try { window.electronAPI.p2pScanClose(); } catch (_) {}
        });
        window.addEventListener('pulse:bv-resume', () => {
            if (!open) return;
            bvSuspended = false;
            const el = document.getElementById(OVERLAY_ID);
            if (el) el.classList.remove('hidden');
            // Re-open rather than just re-bounds: close() detached the view
            // in main, and the same IP short-circuits to the loaded page.
            // slotBounds() reads getBoundingClientRect, which forces layout
            // synchronously, so the un-hide above is already reflected.
            const b = slotBounds();
            if (b && currentIp) {
                try { window.electronAPI.p2pScanOpen({ ip: currentIp, bounds: b }); } catch (_) {}
            }
        });
        // Leaving the page must not strand an attached BrowserView over
        // whatever loads next. Main also detaches on did-start-navigation;
        // this is the renderer-side belt to that braces.
        window.addEventListener('beforeunload', () => {
            if (open) { try { window.electronAPI.p2pScanClose(); } catch (_) {} }
        });
    }

    window.P2PScan = {
        buttonHtml,
        scan,
        close,
        reposition,
        isOpen: () => open,
        CAVEAT: Core.CAVEAT,
    };
})();
