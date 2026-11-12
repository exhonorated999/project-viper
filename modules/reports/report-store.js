/**
 * ViperReportStore — keeps the case report's PICTURES in the case folder
 * (cases/<case>/Reports/) instead of in browser storage.
 *
 * The report TEXT stays in localStorage `viperCaseReports` (small, vault-
 * encrypted on lock, in every backup). A picture lives there only as a
 * reference:
 *
 *     <img data-vp-img="report-image-….jpg" data-vp-img-kind="reports" src="BLANK">
 *
 * the same shape case notes use (modules/_shared/case-storage.js), written
 * through the allow-listed case-attachment IPC, so the file is encrypted under
 * Field Security and travels with the case folder.
 *
 *   const st = ViperReportStore.create({ api, caseNumber: () => '24-1', cs: VpCaseStorage })
 *   await st.persistDom(editor)    new pictures in the live editor → files; the
 *                                  element keeps its picture and gains the reference
 *   st.lean(html)                  the copy to store: referenced pictures blanked
 *   await st.hydrateDom(editor)    blank references in a live DOM get their picture
 *   await st.hydrateHtml(html)     same for an HTML string (PDF / Export to DA)
 *   await st.dehydrateHtml(html)   migration: inline pictures in stored HTML → files
 *
 * Nothing here throws to the caller. A picture that cannot be written stays
 * inline (the report still saves, just bigger); one that cannot be read keeps
 * its reference so the next load tries again.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ViperReportStore = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const KIND = 'reports';
    const STEM = 'report-image';
    const ATTR = 'data-vp-img';
    const KIND_ATTR = 'data-vp-img-kind';
    const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const DATA_IMG = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;
    const NAME_RE = /^[\w][\w .()-]{0,150}\.(?:png|jpe?g|gif|webp|bmp)$/i;
    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
    const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };

    const validName = (n) => typeof n === 'string' && NAME_RE.test(n);
    const mimeOf = (name) => MIME[String(name).split('.').pop().toLowerCase()] || 'image/png';

    function splitDataUrl(src) {
        const m = DATA_IMG.exec(String(src || ''));
        if (!m) return null;
        const mime = 'image/' + m[1].toLowerCase().replace('jpg', 'jpeg');
        return { mime, base64: String(src).slice(m[0].length).replace(/\s/g, '') };
    }
    const isPicture = (src) => !!src && src !== BLANK && DATA_IMG.test(src);

    function create(opts) {
        const o = opts || {};
        const getApi = typeof o.api === 'function' ? o.api : () => o.api;
        const caseNo = typeof o.caseNumber === 'function' ? o.caseNumber : () => o.caseNumber;
        const cs = o.cs || null;
        const warn = typeof o.warn === 'function' ? o.warn : () => {};
        const cache = new Map();          // caseNumber|file → data URL
        const reading = new Map();        // same key → Promise
        const saving = new WeakMap();     // element → Promise (one file per picture)

        function available() {
            const a = getApi();
            return !!(a && a.caseAttachmentSave && a.caseAttachmentRead && caseNo());
        }

        async function save(src) {
            const a = getApi(), cn = caseNo();
            const parts = splitDataUrl(src);
            if (!a || !a.caseAttachmentSave || !cn || !parts) return null;
            const fileName = STEM + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + (EXT[parts.mime] || '.png');
            try {
                const r = await a.caseAttachmentSave({ caseNumber: cn, kind: KIND, fileName, dataBase64: parts.base64 });
                if (!r || !r.success || !validName(r.fileName)) { warn((r && r.error) || 'The picture could not be saved in the case folder.'); return null; }
                cache.set(cn + '|' + r.fileName, src);
                return r.fileName;
            } catch (e) {
                warn((e && e.message) || String(e));
                return null;
            }
        }

        function read(fileName) {
            const a = getApi(), cn = caseNo();
            if (!validName(fileName) || !a || !a.caseAttachmentRead || !cn) return Promise.resolve(null);
            const key = cn + '|' + fileName;
            if (cache.has(key)) return Promise.resolve(cache.get(key));
            if (reading.has(key)) return reading.get(key);
            const p = Promise.resolve()
                .then(() => a.caseAttachmentRead({ caseNumber: cn, kind: KIND, fileName }))
                .then((r) => {
                    if (!r || !r.success || !r.dataBase64) return null;
                    const url = 'data:' + mimeOf(fileName) + ';base64,' + r.dataBase64;
                    cache.set(key, url);
                    return url;
                })
                .catch(() => null)
                .then((v) => { reading.delete(key); return v; });
            reading.set(key, p);
            return p;
        }

        const refOf = (img) => {
            const n = img.getAttribute(ATTR);
            return validName(n) && (img.getAttribute(KIND_ATTR) || KIND) === KIND ? n : null;
        };

        /** Fill referenced pictures whose bytes are not loaded. → number still missing. */
        async function hydrateDom(rootEl) {
            if (!rootEl || !rootEl.querySelectorAll) return 0;
            const imgs = Array.from(rootEl.querySelectorAll('img[' + ATTR + ']'))
                .filter((img) => refOf(img) && !isPicture(img.getAttribute('src')));
            let missing = 0;
            await Promise.all(imgs.map(async (img) => {
                const name = refOf(img);
                const url = await read(name);
                // Only if the element still points at the same file.
                if (url && img.getAttribute(ATTR) === name && !isPicture(img.getAttribute('src'))) img.setAttribute('src', url);
                else if (!url) missing++;
            }));
            return missing;
        }

        /**
         * Pictures in the live editor that have no file yet are written to the
         * case folder; each keeps its picture on screen and gains the reference.
         * → { moved, failed }
         */
        async function persistDom(rootEl) {
            const res = { moved: 0, failed: 0 };
            if (!rootEl || !rootEl.querySelectorAll || !available()) return res;
            const imgs = Array.from(rootEl.querySelectorAll('img')).filter((img) => {
                if (img.getAttribute(ATTR) && refOf(img)) return false;     // already a file
                if (img.getAttribute(ATTR)) { img.removeAttribute(ATTR); img.removeAttribute(KIND_ATTR); }
                return isPicture(img.getAttribute('src'));
            });
            await Promise.all(imgs.map(async (img) => {
                let job = saving.get(img);
                const src = img.getAttribute('src');
                if (!job || job.src !== src) {
                    job = { src, p: save(src) };
                    saving.set(img, job);
                }
                const name = await job.p;
                if (!name) { res.failed++; return; }
                // A picture swapped while it was being written is new: leave it
                // for the next pass.
                if (img.getAttribute('src') !== job.src || img.getAttribute(ATTR)) return;
                img.setAttribute(ATTR, name);
                img.setAttribute(KIND_ATTR, KIND);
                res.moved++;
            }));
            return res;
        }

        /** The copy to store: referenced pictures carry no bytes. */
        function lean(html) {
            if (cs && cs.blankHydrated) return cs.blankHydrated(html);
            return String(html == null ? '' : html);
        }

        function hydrateHtml(html) {
            if (!cs || !cs.hydrateHtml || typeof html !== 'string' || html.indexOf(ATTR) < 0) return Promise.resolve(html);
            return cs.hydrateHtml(html, (r) => ((r.kind || KIND) === KIND ? read(r.fileName) : null));
        }

        function dehydrateHtml(html) {
            if (!cs || !cs.dehydrateHtml || !available()) return Promise.resolve({ html, moved: 0, failed: 0, bytesFreed: 0 });
            return cs.dehydrateHtml(html, (f) => save('data:' + f.mime + ';base64,' + f.base64), { kind: KIND, stem: STEM });
        }

        function hasInlinePictures(html) {
            return !!(cs && cs.hasInlineImages && cs.hasInlineImages(html));
        }

        return { available, read, save, hydrateDom, persistDom, lean, hydrateHtml, dehydrateHtml, hasInlinePictures, cache };
    }

    return { create, KIND, ATTR, KIND_ATTR, BLANK, validName, splitDataUrl };
});
