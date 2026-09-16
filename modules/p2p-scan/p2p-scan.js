/**
 * P2P Activity Check — TorrentAnalytics IP lookup (pure core).
 *
 * Ported from Project Oversight (`src/lib/p2pScan.ts`). Deliberately kept
 * free of DOM and IPC so it can be unit-tested under plain Node — the UI
 * half lives in p2p-scan-ui.js and the BrowserView half in electron-main.js.
 *
 * WHAT THIS SOURCE ACTUALLY SEES
 * ------------------------------
 * TorrentAnalytics monitors the *public BitTorrent DHT and public trackers*.
 * Per their FAQ it cannot see, and does not claim to see:
 *
 *   - Tor / dark web traffic
 *   - Usenet
 *   - HTTPS direct downloads
 *   - Web-based streaming
 *
 * So this must never be presented to an investigator as dark-web or CSAM
 * detection. It detects exactly one thing: an IP address participating in
 * public BitTorrent file sharing. That is worth knowing — P2P software is
 * prohibited outright by most sex-offender probation and parole conditions,
 * and a hit gives an ISP subpoena somewhere to start — but it is a lead,
 * not evidence.
 *
 * Two caveats have to travel with every result, which is why CAVEAT is
 * exported and rendered both on the acknowledgement gate and on the scan
 * window chrome:
 *
 *   1. DHT announcements are spoofable. Anyone can announce any IP on the
 *      DHT. TorrentAnalytics separates "DHT Announcements" from "Direct
 *      Peer Connections" for exactly this reason — peer connections are
 *      the stronger signal.
 *   2. Most residential IPs are dynamic, so an old observation may belong
 *      to a completely different subscriber.
 *
 * VERIFIED 2026-09-01 (Oversight research, carried over):
 *   GET https://torrentanalytics.net/search_ip?ip=<ip>
 *     -> 200, fully populated result page. No login, no POST, no clicking
 *        Search. That is why we never script or scrape their page.
 *   Response headers: `X-Frame-Options: DENY` and
 *   `Content-Security-Policy: ... frame-ancestors 'none'`.
 *     -> An <iframe> or <webview> embed is IMPOSSIBLE. Both the legacy
 *        header and the modern directive forbid framing and it is enforced
 *        by the browser engine. A BrowserView is a top-level navigation and
 *        is unaffected, which is why this reuses the resource-hub BV path.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.P2PScanCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
    'use strict';

    /** Provider slug. Used in evidence tags and file names. */
    const P2P_SOURCE = 'torrentanalytics';

    /** Human label for chrome + toasts. */
    const P2P_LABEL = 'TorrentAnalytics';

    /** Default Evidence subfolder for captured scans. */
    const P2P_EVIDENCE_TAG = 'P2P-Scans';

    /** localStorage flag, matching the other investigative resources. */
    const ENABLED_KEY = 'p2pScanEnabled';

    /** Shown on the gate and on every saved scan. Do not drop this. */
    const CAVEAT =
        'Investigative lead only — not evidence. DHT announcements can be spoofed by ' +
        'third parties, and residential IP assignments change over time. Corroborate ' +
        'before acting. This source monitors public BitTorrent only; it does not see ' +
        'Tor, Usenet, or direct downloads.';

    /**
     * Build the lookup URL. The IP is validated by the caller AND again in
     * main before it ever reaches loadURL — never interpolate raw input.
     */
    function scanUrl(ip) {
        return 'https://torrentanalytics.net/search_ip?ip=' + encodeURIComponent(String(ip == null ? '' : ip).trim());
    }

    function parseIpv4(value) {
        const parts = String(value == null ? '' : value).trim().split('.');
        if (parts.length !== 4) return { ok: false, parts: [] };
        const out = [];
        for (let i = 0; i < 4; i++) {
            const p = parts[i];
            // Reject empty, non-digit, and leading zeros ("076" is octal in
            // some resolvers — an ambiguity we refuse rather than guess at).
            if (!/^\d{1,3}$/.test(p)) return { ok: false, parts: [] };
            if (p.length > 1 && p[0] === '0') return { ok: false, parts: [] };
            const n = Number(p);
            if (n < 0 || n > 255) return { ok: false, parts: [] };
            out.push(n);
        }
        return { ok: true, parts: out };
    }

    /**
     * Publicly routable IPv4 only. Anything that can never appear as a
     * source address on the public internet is rejected, because looking it
     * up would always return nothing and imply a false negative.
     */
    function isRoutableIpv4(value) {
        const r = parseIpv4(value);
        if (!r.ok) return false;
        const a = r.parts[0], b = r.parts[1];

        if (a === 0) return false;                          // "this network"
        if (a === 10) return false;                         // RFC1918 private
        if (a === 127) return false;                        // loopback
        if (a === 169 && b === 254) return false;           // link-local
        if (a === 172 && b >= 16 && b <= 31) return false;  // RFC1918 private
        if (a === 192 && b === 168) return false;           // RFC1918 private
        if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT — carrier shared
        if (a === 192 && b === 0) return false;             // IETF protocol assignments
        if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
        if (a === 203 && b === 0) return false;             // TEST-NET-3 documentation
        if (a === 198 && b === 51) return false;            // TEST-NET-2 documentation
        if (a >= 224) return false;                         // multicast + reserved + broadcast

        return true;
    }

    /**
     * Whether to show the scan button on an identifier row.
     *
     * IPv6 is deliberately excluded: TorrentAnalytics' search page is
     * IPv4-only, so the button would lead to a dead end.
     */
    function isScannable(identifierType, value) {
        if (String(identifierType || '').toLowerCase() !== 'ip') return false;
        return isRoutableIpv4(value);
    }

    /**
     * Why a given address can't be scanned, for the button tooltip.
     * Returns null when it IS scannable.
     */
    function unscannableReason(identifierType, value) {
        if (String(identifierType || '').toLowerCase() !== 'ip') return 'Only IP addresses can be scanned';
        const trimmed = String(value == null ? '' : value).trim();
        if (trimmed.indexOf(':') !== -1) return 'IPv6 is not supported by this data source';
        const r = parseIpv4(trimmed);
        if (!r.ok) return 'Not a valid IPv4 address';
        const a = r.parts[0], b = r.parts[1];
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
            return 'Private network address — never visible on the public internet';
        }
        if (a === 100 && b >= 64 && b <= 127) {
            return 'Carrier-grade NAT address — shared by many subscribers, not attributable';
        }
        if (a === 127) return 'Loopback address';
        if (a === 169 && b === 254) return 'Link-local address';
        if (!isRoutableIpv4(trimmed)) return 'Reserved address range';
        return null;
    }

    /** `torrentanalytics_76.32.67.113_2026-09-01_143022.pdf` */
    function scanFileName(ip, when) {
        const d = when instanceof Date ? when : new Date();
        const p = n => String(n).padStart(2, '0');
        const stamp =
            d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
            '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        return P2P_SOURCE + '_' + String(ip == null ? '' : ip).trim() + '_' + stamp + '.pdf';
    }

    /** Settings gate. Mirrors how resource-hub reads its enabledKeys. */
    function isEnabled() {
        try {
            return typeof localStorage !== 'undefined' &&
                localStorage.getItem(ENABLED_KEY) === 'true';
        } catch (_) { return false; }
    }

    return {
        P2P_SOURCE,
        P2P_LABEL,
        P2P_EVIDENCE_TAG,
        ENABLED_KEY,
        CAVEAT,
        scanUrl,
        isRoutableIpv4,
        isScannable,
        unscannableReason,
        scanFileName,
        isEnabled,
    };
});
