/**
 * ViperEvidenceFolder — the folder name an evidence item gets under
 * cases/<caseNumber>/Evidence/.
 *
 * Items used to land in "<tag>" or, with no tag, "evidence_<timestamp>",
 * which tells an officer browsing the case folder nothing. The folder now
 * carries the item's description too:
 *
 *     folderName('EVID-001', 'Black iPhone 12 from console')
 *         → 'EVID-001 - Black iPhone 12 from console'
 *     folderName('', 'Black iPhone 12', { now: 1730000000000 })
 *         → 'evidence_1730000000000 - Black iPhone 12'
 *
 * The tag/timestamp stays first so names still sort and stay unique. Only the
 * first line of the description is used, cut at a word boundary. Everything is
 * made Windows-safe (no <>:"/\|?* or control characters, no trailing dot or
 * space, no reserved device names, no "." / "..").
 *
 * safeSegment(name) is the same cleaning for one path segment; the main
 * process runs every incoming evidence folder name through it so a tag or
 * description can never step outside the case's Evidence folder.
 *
 * Renderer UMD: `module` IS defined in the renderer, so assign both
 * module.exports and root.ViperEvidenceFolder.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.ViperEvidenceFolder = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    const MAX_DESC = 60;      // description part
    const MAX_NAME = 120;     // whole folder name (keeps deep evidence paths under MAX_PATH)
    const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

    function _tidy(s) {
        return String(s == null ? '' : s)
            .replace(/[\x00-\x1f\x7f]/g, ' ')
            .replace(/[\\/]/g, '-')
            .replace(/[<>:"|?*]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function _trimEnd(s) {
        return s.replace(/[\s.]+$/, '');
    }

    function _cut(s, max) {
        if (s.length <= max) return s;
        let cut = s.slice(0, max);
        const sp = cut.lastIndexOf(' ');
        if (sp >= Math.floor(max / 2)) cut = cut.slice(0, sp);
        return cut.replace(/[\s.,;:\-–—_]+$/, '');
    }

    /** One Windows-safe path segment, or '' when nothing usable is left. */
    function safeSegment(name, max) {
        let s = _trimEnd(_tidy(name).replace(/^[\s.]+/, ''));
        s = _trimEnd(_cut(s, max || MAX_NAME + 30));
        if (!s || s === '.' || s === '..' || RESERVED.test(s)) return '';
        return s;
    }

    /** First line of the description, cleaned and shortened. */
    function shortDescription(description, max) {
        const first = String(description == null ? '' : description).split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
        return _trimEnd(_cut(_tidy(first), max || MAX_DESC).replace(/^[\s.\-]+/, ''));
    }

    /**
     * Folder name for a new evidence item.
     * opts: { prefix = 'evidence', now = Date.now() } — the fallback base is
     * `${prefix}_${now}` when there is no tag.
     */
    function folderName(tag, description, opts) {
        const o = opts || {};
        const prefix = String(o.prefix == null ? '' : o.prefix).replace(/[^A-Za-z0-9_-]/g, '').replace(/^[-_]+/, '') || 'evidence';
        const base = safeSegment(tag, MAX_NAME) || `${prefix}_${o.now != null ? o.now : Date.now()}`;
        const room = MAX_NAME - base.length - 3;
        if (room < 8) return base;
        const desc = shortDescription(description, Math.min(MAX_DESC, room));
        if (!desc) return base;
        if (base.toLowerCase().includes(desc.toLowerCase())) return base;
        return safeSegment(`${base} - ${desc}`, MAX_NAME) || base;
    }

    return { folderName, safeSegment, shortDescription, MAX_DESC, MAX_NAME };
});
