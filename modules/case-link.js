/* ============================================================================
 * VIPER Case-Link engine
 * ----------------------------------------------------------------------------
 * Matches Suspects / Victims / Witnesses / Missing Persons across cases by
 * canonical name + DOB (with phone/SSN corroboration). Pure data layer — no
 * DOM access. UI consumers should call window.CaseLink.findMatches() and
 * window.CaseLink.getRelatedCases().
 *
 * Storage scanned (both VIPER patterns):
 *   Pattern 1 (object keyed by caseNumber):
 *     viperCaseSuspects, viperCaseVictims, viperCaseWitnesses,
 *     viperCaseMissingPersons
 *   Pattern 2 (per-case keys by case.id):
 *     suspects_<id>, victims_<id>, witnesses_<id>, missingpersons_<id>
 *
 * Field Security: when the user has Field Security locked, localStorage may
 * be empty/stale — buildIndex() simply returns whatever it can read. The UI
 * should treat zero matches as "unknown" rather than "none exist".
 * ========================================================================== */
(function (global) {
    'use strict';

    // ---- Constants ----------------------------------------------------------
    const PATTERN1_KEYS = {
        suspect: 'viperCaseSuspects',
        victim: 'viperCaseVictims',
        witness: 'viperCaseWitnesses',
        missingPerson: 'viperCaseMissingPersons',
    };
    const PATTERN2_PREFIX = {
        suspect: 'suspects_',
        victim: 'victims_',
        witness: 'witnesses_',
        missingPerson: 'missingpersons_',
    };
    const ROLES = ['suspect', 'victim', 'witness', 'missingPerson'];
    const ROLE_LABELS = {
        suspect: 'Suspect',
        victim: 'Victim',
        witness: 'Witness',
        missingPerson: 'Missing Person',
    };

    const TTL_MS = 60 * 1000; // index is good for 60s before auto-rebuild

    // ---- Normalization helpers ---------------------------------------------
    const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
    const digits = (s) => String(s == null ? '' : s).replace(/\D+/g, '');

    function normDob(d) {
        if (!d) return '';
        const s = String(d).trim();
        if (!s) return '';
        // ISO YYYY-MM-DD (or full ISO timestamp)
        let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${m[1]}-${m[2]}-${m[3]}`;
        // MM/DD/YYYY or M/D/YYYY (also accepts 2-digit year w/ pivot at 30)
        m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
        if (m) {
            let [, mo, da, yr] = m;
            yr = yr.length === 2 ? (parseInt(yr, 10) > 30 ? '19' + yr : '20' + yr) : yr;
            return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
        }
        return s;
    }

    /**
     * Pull a normalized person record out of an arbitrary VIPER person blob.
     * Returns null when no usable name is present.
     *
     * Schema variants supported:
     *   - { firstName, lastName, dob, ... }            (RMS imports, identifiers form)
     *   - { first_name / first / fname, ... }          (legacy)
     *   - { name: "Smith, John" | "John Smith", dob }  (default VIPER add-person form)
     */
    function extractPerson(raw) {
        if (!raw || typeof raw !== 'object') return null;
        let first = raw.firstName || raw.first_name || raw.first || raw.fname || '';
        let last  = raw.lastName  || raw.last_name  || raw.last  || raw.lname || '';

        // Fallback: parse single `name` string when split fields aren't present.
        if ((!first || !last) && raw.name && typeof raw.name === 'string') {
            const parts = parseNameString(raw.name);
            if (!first) first = parts.first;
            if (!last)  last  = parts.last;
        }

        const dob = raw.dob || raw.dateOfBirth || raw.date_of_birth || raw.DOB || '';

        const phones = [];
        if (raw.phone)  phones.push(digits(raw.phone));
        if (raw.phone2) phones.push(digits(raw.phone2));
        if (raw.cellPhone) phones.push(digits(raw.cellPhone));
        if (raw.homePhone) phones.push(digits(raw.homePhone));
        if (raw.workPhone) phones.push(digits(raw.workPhone));
        if (raw.employerPhone) phones.push(digits(raw.employerPhone));
        if (Array.isArray(raw.identifiers)) {
            raw.identifiers.forEach(id => {
                if (id && id.type === 'phone' && id.value) phones.push(digits(id.value));
            });
        }

        const ssn = raw.ssn ? digits(raw.ssn) : '';

        const firstN = norm(first);
        const lastN  = norm(last);
        if (!firstN || !lastN) return null;

        return {
            firstName: firstN,
            lastName: lastN,
            dob: normDob(dob),
            phones: Array.from(new Set(phones.filter(p => p && p.length >= 7))),
            ssn,
            raw, // original object retained for "Copy" action
        };
    }

    /**
     * Split a free-form name string into { first, last }.
     * Handles "Last, First [Middle]" and "First [Middle] Last" forms.
     * Drops middle names/initials. Returns empty strings if it can't parse.
     */
    function parseNameString(s) {
        const out = { first: '', last: '' };
        if (!s) return out;
        const t = String(s).trim();
        if (!t) return out;

        // "Last, First Middle"  -> comma form
        if (t.includes(',')) {
            const [lastPart, restPart = ''] = t.split(',', 2);
            const restTokens = restPart.trim().split(/\s+/).filter(Boolean);
            out.last  = lastPart.trim();
            out.first = restTokens[0] || '';
            return out;
        }

        // "First [Middle ...] Last"
        const tokens = t.split(/\s+/).filter(Boolean);
        if (tokens.length === 1) { out.last = tokens[0]; return out; }
        // Strip trailing suffix tokens (Jr, Sr, II, III, IV, "Jr.", etc.)
        const suffixRe = /^(jr|sr|i{1,3}|iv|v|esq)\.?$/i;
        while (tokens.length > 1 && suffixRe.test(tokens[tokens.length - 1])) tokens.pop();
        if (tokens.length === 1) { out.last = tokens[0]; return out; }
        out.first = tokens[0];
        out.last  = tokens[tokens.length - 1];
        return out;
    }

    function canonicalKey(p) {
        if (!p || !p.lastName || !p.firstName) return '';
        return `${p.lastName}|${p.firstName}|${p.dob || ''}`;
    }

    function nameKey(p) {
        if (!p || !p.lastName || !p.firstName) return '';
        return `${p.lastName}|${p.firstName}`;
    }

    // ---- Index --------------------------------------------------------------
    let _index = null;
    let _builtAt = 0;

    /**
     * Build (or refresh) the in-memory person→cases index.
     * @param {boolean} force  bypass TTL cache.
     */
    function buildIndex(force) {
        if (!force && _index && (Date.now() - _builtAt) < TTL_MS) return _index;

        const cases = safeJSON(localStorage.getItem('viperCases'), []);
        const caseLookup = {};
        cases.forEach(c => {
            if (!c) return;
            if (c.id) caseLookup[c.id] = c;
            if (c.caseNumber) caseLookup[c.caseNumber] = c;
        });

        const entries = []; // { role, person, caseId, caseNumber }

        const addEntry = (role, raw, caseId, caseNumber) => {
            const person = extractPerson(raw);
            if (!person) return;
            entries.push({ role, person, caseId, caseNumber });
        };

        // Pattern 1 — keyed by caseNumber
        for (const role of ROLES) {
            const blob = safeJSON(localStorage.getItem(PATTERN1_KEYS[role]), {});
            if (!blob || typeof blob !== 'object') continue;
            for (const caseNumber of Object.keys(blob)) {
                const c = caseLookup[caseNumber];
                if (!c) continue;
                const list = blob[caseNumber];
                if (Array.isArray(list)) list.forEach(p => addEntry(role, p, c.id, caseNumber));
            }
        }

        // Pattern 2 — keyed by case.id
        for (const role of ROLES) {
            const prefix = PATTERN2_PREFIX[role];
            cases.forEach(c => {
                if (!c || !c.id) return;
                const list = safeJSON(localStorage.getItem(prefix + c.id), []);
                if (Array.isArray(list)) list.forEach(p => addEntry(role, p, c.id, c.caseNumber));
            });
        }

        // Build keyed maps
        const byKey  = new Map();
        const byName = new Map();
        entries.forEach(e => {
            const ck = canonicalKey(e.person);
            if (ck) {
                if (!byKey.has(ck)) byKey.set(ck, []);
                byKey.get(ck).push(e);
            }
            const nk = nameKey(e.person);
            if (nk) {
                if (!byName.has(nk)) byName.set(nk, []);
                byName.get(nk).push(e);
            }
        });

        _index = { byKey, byName, entries, caseLookup };
        _builtAt = Date.now();
        return _index;
    }

    function invalidateIndex() {
        _index = null;
        _builtAt = 0;
    }

    function safeJSON(s, fallback) {
        if (s == null) return fallback;
        try { return JSON.parse(s); } catch (_) { return fallback; }
    }

    // ---- Matching -----------------------------------------------------------
    /**
     * Find matches for an in-progress person form.
     * @param {object} query  partial person (firstName, lastName, dob, phone, …)
     * @param {object} opts   { excludeCaseId, role }
     * @returns {Array<{confidence, role, caseId, caseNumber, person, reasons}>}
     *   confidence: 'HIGH' | 'MEDIUM' | 'LOW'
     */
    function findMatches(query, opts) {
        opts = opts || {};
        const q = extractPerson(query || {});
        if (!q) return [];
        const idx = buildIndex();
        const excludeCaseId = opts.excludeCaseId;
        const roleFilter = opts.role;

        const out = [];
        const seen = new Set();

        const considered = new Map(); // entry -> { confidence, reasons[] }

        const score = (entry, confidence, reason) => {
            // Skip self
            if (excludeCaseId && entry.caseId === excludeCaseId) return;
            if (roleFilter && entry.role !== roleFilter) return;
            const dedupKey = `${entry.caseId}|${entry.role}|${canonicalKey(entry.person)}`;
            if (seen.has(dedupKey)) {
                // Promote confidence if higher one fires
                const prev = considered.get(dedupKey);
                if (prev && rank(confidence) < rank(prev.confidence)) {
                    prev.confidence = confidence;
                }
                if (prev && reason && !prev.reasons.includes(reason)) {
                    prev.reasons.push(reason);
                }
                return;
            }
            seen.add(dedupKey);
            const obj = { ...entry, confidence, reasons: reason ? [reason] : [] };
            considered.set(dedupKey, obj);
            out.push(obj);
        };

        // HIGH: same canonical key (last+first+dob)
        if (q.dob) {
            const hits = idx.byKey.get(canonicalKey(q)) || [];
            hits.forEach(h => score(h, 'HIGH', 'Name + DOB match'));
        }

        // MEDIUM/LOW via name match
        const nameHits = idx.byName.get(nameKey(q)) || [];
        nameHits.forEach(h => {
            const phoneOverlap = q.phones.some(p => h.person.phones.includes(p));
            const ssnMatch = q.ssn && h.person.ssn && q.ssn === h.person.ssn;

            if (q.dob && h.person.dob) {
                if (q.dob === h.person.dob) {
                    // Already covered by HIGH path; skip.
                    return;
                }
                // Conflicting DOB — only surface if a strong corroborator exists.
                if (phoneOverlap) score(h, 'MEDIUM', 'Name + phone match (DOB differs)');
                else if (ssnMatch) score(h, 'MEDIUM', 'Name + SSN match (DOB differs)');
                else             score(h, 'LOW',    'Same name, different DOB');
            } else {
                // At least one side has no DOB
                if (phoneOverlap) score(h, 'MEDIUM', 'Name + phone match');
                else if (ssnMatch) score(h, 'MEDIUM', 'Name + SSN match');
                else             score(h, 'MEDIUM', 'Name match (DOB unknown on one side)');
            }
        });

        // Sort: HIGH > MEDIUM > LOW, then newest case first
        out.sort((a, b) => (rank(a.confidence) - rank(b.confidence)) ||
                          String(b.caseNumber || '').localeCompare(String(a.caseNumber || '')));
        return out;
    }

    function rank(c) { return c === 'HIGH' ? 0 : c === 'MEDIUM' ? 1 : 2; }

    function countMatches(query, opts) {
        return findMatches(query, opts).length;
    }

    /**
     * For a given case, return all OTHER cases that share at least one person
     * (suspect/victim/witness/missing) with this one.
     * @returns {Array<{caseId, caseNumber, caseTitle, sharedPersons: [...]}>}
     */
    function getRelatedCases(caseId) {
        if (!caseId) return [];
        const idx = buildIndex();
        const myEntries = idx.entries.filter(e => e.caseId === caseId);
        if (!myEntries.length) return [];

        const related = new Map(); // caseId -> { caseId, caseNumber, sharedPersons[] }
        const personSeen = new Map(); // caseId -> Set(personKey)

        myEntries.forEach(mine => {
            const candidates = [];
            // HIGH match (name+dob)
            if (mine.person.dob) {
                (idx.byKey.get(canonicalKey(mine.person)) || [])
                    .filter(o => o.caseId !== caseId)
                    .forEach(o => candidates.push({ o, confidence: 'HIGH' }));
            }
            // MEDIUM via name+phone or name+ssn (or one side missing DOB)
            (idx.byName.get(nameKey(mine.person)) || [])
                .filter(o => o.caseId !== caseId)
                .forEach(o => {
                    if (mine.person.dob && o.person.dob && mine.person.dob === o.person.dob) return; // HIGH already
                    const phoneOverlap = mine.person.phones.some(p => o.person.phones.includes(p));
                    const ssnMatch = mine.person.ssn && o.person.ssn && mine.person.ssn === o.person.ssn;
                    const oneMissingDob = !mine.person.dob || !o.person.dob;
                    const dobConflict = mine.person.dob && o.person.dob && mine.person.dob !== o.person.dob;
                    if (phoneOverlap || ssnMatch) {
                        candidates.push({ o, confidence: 'MEDIUM' });
                    } else if (oneMissingDob && !dobConflict) {
                        candidates.push({ o, confidence: 'MEDIUM' });
                    }
                    // LOW (same name, conflicting DOB, no corroborator) is intentionally
                    // excluded from getRelatedCases — too noisy for the overview card.
                });

            candidates.forEach(({ o, confidence }) => {
                const r = related.get(o.caseId) || {
                    caseId: o.caseId,
                    caseNumber: o.caseNumber,
                    caseTitle: (idx.caseLookup[o.caseId] || {}).title || '',
                    caseStatus: (idx.caseLookup[o.caseId] || {}).status || '',
                    sharedPersons: [],
                };
                related.set(o.caseId, r);

                const pSet = personSeen.get(o.caseId) || new Set();
                personSeen.set(o.caseId, pSet);
                const pk = canonicalKey(o.person);
                if (pSet.has(pk)) return;
                pSet.add(pk);

                r.sharedPersons.push({
                    name: `${titleCase(o.person.lastName)}, ${titleCase(o.person.firstName)}`,
                    dob: o.person.dob,
                    myRole: mine.role,
                    theirRole: o.role,
                    confidence,
                });
            });
        });

        // ── Manual links ────────────────────────────────────────────────
        // Merge any user-marked manual links into the same shape so the UI
        // can render them inline with auto-detected ones. Manual entries are
        // confidence: 'MANUAL' so the UI can give them a distinct treatment.
        try {
            const manual = getManualLinks(caseId);
            manual.forEach(ml => {
                if (!ml || !ml.otherCaseId) return;
                const other = idx.caseLookup[ml.otherCaseId] || {};
                const r = related.get(ml.otherCaseId) || {
                    caseId: ml.otherCaseId,
                    caseNumber: ml.otherCaseNumber || other.caseNumber || ml.otherCaseId,
                    caseTitle: other.title || '',
                    caseStatus: other.status || '',
                    sharedPersons: [],
                };
                related.set(ml.otherCaseId, r);
                const sp = ml.sharedPerson || {};
                // Avoid duplicating an entry the auto-detector already added
                const dup = r.sharedPersons.some(x =>
                    x.confidence === 'MANUAL' &&
                    String(x.name || '').toUpperCase() === String(sp.name || '').toUpperCase());
                if (dup) return;
                r.sharedPersons.push({
                    name: sp.name || '(manually linked)',
                    dob: sp.dob || '',
                    myRole: sp.role || 'manual',
                    theirRole: sp.role || 'manual',
                    confidence: 'MANUAL',
                    note: ml.note || '',
                    addedAt: ml.addedAt || '',
                    manual: true,
                });
            });
        } catch (_) {}

        const out = Array.from(related.values());
        out.sort((a, b) => b.sharedPersons.length - a.sharedPersons.length ||
                           String(b.caseNumber || '').localeCompare(String(a.caseNumber || '')));
        return out;
    }

    function titleCase(s) {
        return String(s || '').toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
    }

    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // ---- Manual case-to-case links -----------------------------------------
    /*
     * In addition to the auto-detected name+DOB matches surfaced by
     * getRelatedCases(), the user can explicitly mark two cases as linked.
     * Manual links live in localStorage keyed by case.id so they appear in
     * Related Cases on both sides of the link:
     *
     *   viperManualCaseLinks_<caseId> = [
     *     { otherCaseId, otherCaseNumber, sharedPerson: { name, dob, role },
     *       note, addedAt }
     *   ]
     */
    const MANUAL_LINKS_PREFIX = 'viperManualCaseLinks_';

    function getManualLinks(caseId) {
        if (!caseId) return [];
        const arr = safeJSON(localStorage.getItem(MANUAL_LINKS_PREFIX + caseId), []);
        return Array.isArray(arr) ? arr : [];
    }

    function _writeManualLinks(caseId, list) {
        try {
            localStorage.setItem(MANUAL_LINKS_PREFIX + caseId, JSON.stringify(list || []));
        } catch (_) {}
    }

    /**
     * Add a manual link between two cases. Writes BOTH sides so the link
     * appears in Related Cases regardless of which case the user is viewing.
     *
     * @param {object} a   { caseId, caseNumber }  this case
     * @param {object} b   { caseId, caseNumber }  the other case
     * @param {object} sharedPerson  { name, dob, role }   optional context
     * @param {string} note          optional free-text note
     * @returns {boolean} true if a new entry was written, false if duplicate
     */
    function addManualLink(a, b, sharedPerson, note) {
        if (!a || !b || !a.caseId || !b.caseId) return false;
        if (a.caseId === b.caseId) return false;
        const stamp = new Date().toISOString();

        const writeOne = (selfId, selfNumber, otherId, otherNumber) => {
            const list = getManualLinks(selfId);
            const dup = list.some(x => x.otherCaseId === otherId);
            if (dup) return false;
            list.push({
                otherCaseId: otherId,
                otherCaseNumber: otherNumber,
                sharedPerson: sharedPerson || null,
                note: note || '',
                addedAt: stamp,
            });
            _writeManualLinks(selfId, list);
            return true;
        };

        const w1 = writeOne(a.caseId, a.caseNumber, b.caseId, b.caseNumber);
        const w2 = writeOne(b.caseId, b.caseNumber, a.caseId, a.caseNumber);
        invalidateIndex();
        return w1 || w2;
    }

    function removeManualLink(caseId, otherCaseId) {
        const a = getManualLinks(caseId).filter(x => x.otherCaseId !== otherCaseId);
        const b = getManualLinks(otherCaseId).filter(x => x.otherCaseId !== caseId);
        _writeManualLinks(caseId, a);
        _writeManualLinks(otherCaseId, b);
        invalidateIndex();
    }

    // ---- Person finder (All Cases search) ----------------------------------
    /**
     * Group all indexed persons into unique entries (by lastName + firstName +
     * dob) and return a sorted list with the cases each person appears in.
     * Optionally filter by a query string (matches first/last name).
     *
     * @param {string} query    free-text fragment (case-insensitive)
     * @param {object} opts     { limit }
     * @returns {Array<{name, lastName, firstName, dob, count, cases: [{caseId, caseNumber, role}]}>}
     */
    function findPersons(query, opts) {
        opts = opts || {};
        const limit = typeof opts.limit === 'number' ? opts.limit : 100;
        const idx = buildIndex();
        const groups = new Map(); // canonicalKey -> aggregated entry

        const tokens = String(query || '').trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
        const matchesQuery = (p) => {
            if (!tokens.length) return true;
            const haystack = `${p.firstName} ${p.lastName}`.toLowerCase();
            return tokens.every(t => haystack.includes(t));
        };

        idx.entries.forEach(e => {
            const p = e.person;
            if (!matchesQuery(p)) return;
            const key = canonicalKey(p) || nameKey(p);
            if (!key) return;
            let g = groups.get(key);
            if (!g) {
                g = {
                    key,
                    name: `${titleCase(p.lastName)}, ${titleCase(p.firstName)}`,
                    lastName: p.lastName,
                    firstName: p.firstName,
                    dob: p.dob || '',
                    count: 0,
                    cases: [], // {caseId, caseNumber, role}
                    _seenCases: new Set(),
                };
                groups.set(key, g);
            }
            const dedupKey = `${e.caseId}|${e.role}`;
            if (g._seenCases.has(dedupKey)) return;
            g._seenCases.add(dedupKey);
            g.cases.push({
                caseId: e.caseId,
                caseNumber: e.caseNumber,
                role: e.role,
                roleLabel: ROLE_LABELS[e.role] || e.role,
            });
            g.count = g.cases.length;
        });

        const out = Array.from(groups.values());
        // Alphabetical by last name (then first name); ties broken by case count desc.
        // Empty/missing last names sort to the end so real names appear first.
        const lk = s => (s || '').toString().trim().toLowerCase();
        out.sort((a, b) => {
            const al = lk(a.lastName), bl = lk(b.lastName);
            if (!al && bl) return 1;
            if (al && !bl) return -1;
            return al.localeCompare(bl) ||
                   lk(a.firstName).localeCompare(lk(b.firstName)) ||
                   (b.count - a.count);
        });
        out.forEach(g => { delete g._seenCases; });
        return out.slice(0, limit);
    }

    // ---- Inline duplicate-person hints (A-4) -------------------------------
    /**
     * Watches a form's name + dob inputs and renders "this person is already in
     * case X as Y" hint badges. Safe to attach to any add/edit-person modal.
     *
     * @param {HTMLElement} root   form, modal, or container element
     * @param {object} opts
     *   - currentCaseId   (string)  — exclude self from matches
     *   - role            (string)  — current form's role for "you are adding a Suspect" framing
     *   - nameInput       (Element) — explicit input element for the full-name field
     *   - firstInput      (Element) — explicit element for first-name (alternative to nameInput)
     *   - lastInput       (Element) — explicit element for last-name
     *   - dobInput        (Element) — explicit element for date-of-birth
     *   - insertBefore    (Element) — node before which the hint container is inserted
     *                                 (defaults: first child of root)
     *   - hint            (Element) — pre-built container; if supplied, used instead of insertBefore
     *   - debounceMs      (number)  — defaults to 250
     *   - maxBadges       (number)  — defaults to 6
     *   - onClickBadge    (function) — receives match object; default navigates to that case
     */
    function attachInputSuggest(root, opts) {
        if (!root) return;
        opts = opts || {};
        const debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 250;
        const maxBadges  = typeof opts.maxBadges === 'number' ? opts.maxBadges : 6;
        const role       = opts.role || '';
        const excludeCaseId = opts.currentCaseId || null;

        // Resolve inputs — caller may pass elements OR rely on defaults
        const nameInput = opts.nameInput || root.querySelector('input[name="name"]');
        const firstInput = opts.firstInput || null;
        const lastInput  = opts.lastInput  || null;
        const dobInput   = opts.dobInput   || root.querySelector('input[name="dob"]');

        if (!nameInput && !(firstInput || lastInput)) return; // nothing to watch

        // Ensure hint container exists
        let hint = opts.hint;
        if (!hint) {
            hint = document.createElement('div');
            hint.className = 'case-link-suggest hidden mb-4';
            hint.setAttribute('data-case-link-hint', '1');
            const before = opts.insertBefore || root.firstElementChild;
            if (before && before.parentNode) before.parentNode.insertBefore(hint, before);
            else root.insertBefore(hint, root.firstChild);
        }

        const readQuery = () => {
            const q = {};
            if (firstInput || lastInput) {
                if (firstInput) q.firstName = firstInput.value || '';
                if (lastInput)  q.lastName  = lastInput.value  || '';
            }
            if (nameInput && nameInput.value) {
                q.name = nameInput.value;
            }
            if (dobInput && dobInput.value) {
                q.dob = dobInput.value;
            }
            return q;
        };

        const render = (matches) => {
            if (!matches || !matches.length) {
                hint.classList.add('hidden');
                hint.innerHTML = '';
                return;
            }
            hint.classList.remove('hidden');
            const high = matches.filter(m => m.confidence === 'HIGH').length;
            const med  = matches.filter(m => m.confidence === 'MEDIUM').length;
            const headerBits = [];
            if (high) headerBits.push(`<span class="text-amber-300 font-semibold">${high} likely match${high !== 1 ? 'es' : ''}</span>`);
            if (med)  headerBits.push(`<span class="text-amber-200/80">${med} possible</span>`);
            const subhead = headerBits.length ? headerBits.join(' · ') : `${matches.length} potential match${matches.length !== 1 ? 'es' : ''}`;

            const shown = matches.slice(0, maxBadges);
            const more  = Math.max(0, matches.length - shown.length);

            hint.innerHTML = `
                <div class="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                    <div class="flex items-center gap-2 mb-2">
                        <svg class="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        <span class="text-xs font-semibold text-amber-200">This person may already be in your cases —</span>
                        <span class="text-xs text-gray-300">${subhead}</span>
                    </div>
                    <div class="flex flex-wrap gap-1.5" data-cl-badges>
                        ${shown.map((m, i) => {
                            const cn = escHtml(m.caseNumber || '—');
                            const lbl = (ROLE_LABELS[m.role] || m.role);
                            const confCls = m.confidence === 'HIGH'
                                ? 'bg-amber-500/15 text-amber-200 border-amber-500/40'
                                : 'bg-gray-700/40 text-gray-200 border-gray-500/40';
                            const reasons = (m.reasons || []).join(' · ');
                            return `<button type="button" data-cl-idx="${i}"
                                class="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded border ${confCls} hover:bg-amber-500/25 transition"
                                title="${escHtml(m.confidence)} confidence — ${escHtml(reasons || 'name match')}">
                                <span class="font-mono font-semibold">${cn}</span>
                                <span class="text-[10px] opacity-80">(${escHtml(lbl)})</span>
                            </button>`;
                        }).join('')}
                        ${more > 0 ? `<span class="text-[11px] text-gray-400 self-center">+${more} more</span>` : ''}
                    </div>
                </div>`;

            // Wire badge clicks
            const list = hint.querySelectorAll('button[data-cl-idx]');
            list.forEach(btn => {
                btn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const idx = parseInt(btn.getAttribute('data-cl-idx'), 10) || 0;
                    const m = shown[idx];
                    if (!m) return;
                    if (typeof opts.onClickBadge === 'function') {
                        opts.onClickBadge(m, btn);
                    } else if (typeof global.handleCaseLinkBadgeClick === 'function') {
                        // Page-supplied default (e.g. case-detail-with-analytics.html
                        // exposes a richer Import / Link / Open menu).
                        global.handleCaseLinkBadgeClick(m, btn, { role, currentCaseId: excludeCaseId, root });
                    } else {
                        // Bare-bones default: navigate to that case
                        try {
                            window.location.href = 'case-detail-with-analytics.html?case=' + encodeURIComponent(m.caseNumber);
                        } catch (_) {}
                    }
                });
            });
        };

        let timer = null;
        const scheduleUpdate = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                const q = readQuery();
                // Need at least a last name to do anything meaningful
                const tmp = extractPerson(q);
                if (!tmp || !tmp.lastName) {
                    render([]);
                    return;
                }
                let matches = [];
                try {
                    matches = findMatches(q, { excludeCaseId, role: opts.matchRoleFilter || null }) || [];
                } catch (_) { matches = []; }
                // Default: surface only HIGH and MEDIUM (LOW is too noisy live)
                if (!opts.includeLow) matches = matches.filter(m => m.confidence !== 'LOW');
                render(matches);
            }, debounceMs);
        };

        const wire = (el) => {
            if (!el) return;
            el.addEventListener('input',  scheduleUpdate);
            el.addEventListener('change', scheduleUpdate);
            el.addEventListener('blur',   scheduleUpdate);
        };
        wire(nameInput); wire(firstInput); wire(lastInput); wire(dobInput);

        // Initial pass — pre-fill detection if we're editing an existing record
        scheduleUpdate();

        // Return a teardown handle
        return {
            refresh: scheduleUpdate,
            destroy: () => {
                if (timer) clearTimeout(timer);
                if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
            },
        };
    }

    // ---- Public surface -----------------------------------------------------
    global.CaseLink = {
        // Index
        buildIndex,
        invalidateIndex,
        // Matching
        findMatches,
        countMatches,
        // Related cases (Tier B)
        getRelatedCases,
        // Manual links
        getManualLinks,
        addManualLink,
        removeManualLink,
        // Person finder
        findPersons,
        // Inline duplicate-person hints (A-4)
        attachInputSuggest,
        // Helpers exposed for UI / tests
        canonicalKey,
        extractPerson,
        parseNameString,
        ROLE_LABELS,
        ROLES,
        // Diagnostic: returns a quick summary of what the index sees. Run from
        // DevTools console: CaseLink.debug() -> { totalEntries, byRole, sampleNames }.
        debug() {
            const idx = buildIndex(true);
            const byRole = { suspect: 0, victim: 0, witness: 0, missingPerson: 0 };
            const sampleNames = [];
            idx.entries.forEach(e => {
                byRole[e.role] = (byRole[e.role] || 0) + 1;
                if (sampleNames.length < 10) {
                    sampleNames.push(`${e.role}: ${e.person.firstName} ${e.person.lastName} (${e.person.dob || 'no-dob'}) case=${e.caseNumber}`);
                }
            });
            return {
                totalEntries: idx.entries.length,
                byKey: idx.byKey.size,
                byName: idx.byName.size,
                byRole,
                sampleNames,
                cases: Object.keys(idx.caseLookup).length,
            };
        },
        _internals: { normDob, digits, norm, titleCase },
    };
})(typeof window !== 'undefined' ? window : globalThis);
