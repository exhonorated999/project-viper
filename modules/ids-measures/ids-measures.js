/*
 * IDS Measures — the monthly ICAC Data System numbers, added up from the case
 * files instead of from a worksheet.
 *
 * Every ICAC affiliate keys the OJJDP performance measures into IDS once a
 * month. The dashboard's own statistics cover ALL of a detective's work; IDS
 * wants ICAC work only, in its own eight sections and its own vocabulary
 * (State/Local vs Federal, hands-on offenders, on-scene previews...). This
 * file turns what VIPER already holds into that form.
 *
 * Pure and dependency-free: no DOM, no localStorage, no globals. The host
 * reads storage and hands the raw records in; this file only counts. That is
 * what lets every number be pinned by a Node test.
 *
 * TWO RULES GOVERN EVERY COUNT
 *
 *  1. ONLY ICAC CASES COUNT. A case is ICAC when the officer ticked it, or —
 *     if they never touched the box — when it carries a CyberTip. An explicit
 *     untick always wins (a CyberTip that turned out to be an adult, say).
 *
 *  2. THE CASE-LEVEL / WORK-PRODUCT LINE from the dashboard holds here too.
 *     An assist is not an investigation THIS officer opened, so assists are
 *     left out of "investigations opened". Everything they DID on an assist —
 *     the warrant they wrote, the phone they examined, the arrest they made —
 *     is their work product and counts.
 *
 * NOTHING IS GUESSED. An arrest with no date, a device whose storage size
 * can't be read, an ICAC case nobody marked reactive or proactive — these are
 * not silently dropped and not silently assumed. They come back in
 * `notCounted` with the reason, so the PDF can list them and the officer can
 * fix the record before keying the month.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.IdsMeasures = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // ── Vocabulary ──────────────────────────────────────────────────────

    // The dashboard Activity Log. `measure` says which number the entry
    // feeds; `uses` says whether IDS wants the number of EVENTS (count) or
    // the number of PEOPLE, or both.
    var ACTIVITY_KINDS = [
        { value: 'presentation',       label: 'Presentation',                       section: 1, people: 'Est. attendees' },
        { value: 'diversion',          label: 'Diversion activity',                 section: 1, people: 'Est. participants' },
        { value: 'public-event',       label: 'Public event',                       section: 1 },
        { value: 'outreach',           label: 'Other outreach (PSA, media, social)', section: 1 },
        { value: 'citizen-complaint',  label: 'Citizen complaint received',         section: 2 },
        { value: 'referral-received',  label: 'Referral received (not a CyberTip)', section: 2 },
        { value: 'training-conducted', label: 'Training event conducted',           section: 7 },
        { value: 'sent-tf',            label: 'Sent to ICAC Task Force training',   section: 7, peopleOnly: true },
        { value: 'sent-ttaa',          label: 'Sent to OJJDP T&TA provider training', section: 7, peopleOnly: true },
        { value: 'sent-other',         label: 'Sent to other training',             section: 7, peopleOnly: true },
        { value: 'trained-le',         label: 'Law enforcement trained',            section: 7, peopleOnly: true },
        { value: 'trained-prosecutor', label: 'Prosecutors trained',                section: 7, peopleOnly: true },
        { value: 'trained-other',      label: 'Other professionals trained',        section: 7, peopleOnly: true },
        { value: 'technical-assist',   label: 'Technical assist / investigative support', section: 8 }
    ];

    var VICTIM_KINDS = [
        { value: 'rescued',              label: 'Rescued from ongoing abuse' },
        { value: 'identified-images',    label: 'Newly identified — with images' },
        { value: 'identified-no-images', label: 'Newly identified — without images' }
    ];

    var VENUES = [
        { value: 'state',   label: 'State / Local' },
        { value: 'federal', label: 'Federal' }
    ];

    // Forensic device categories VIPER records → the three IDS buckets.
    // gps / iot / other are real exams but IDS has no box for them, so they
    // are listed (not counted) rather than forced into the nearest bucket.
    var DEVICE_BUCKET = { computer: 'computer', phone: 'mobile', tablet: 'mobile', drive: 'storage' };

    // ── Dates ───────────────────────────────────────────────────────────

    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'];

    /*
     * Anything VIPER stores as a date → a Date, or null.
     *   'YYYY-MM-DD'                  → LOCAL midnight (an <input type=date>
     *                                   value; parsing it as UTC would push it
     *                                   into the previous day — and month —
     *                                   for every US time zone)
     *   'MM-DD-YYYY HH:MM:SS UTC'     → that instant (NCMEC's format)
     *   'MM/DD/YYYY [HH:MM[:SS]]'     → local
     *   ISO timestamps, epoch numbers → as-is
     */
    function parseDate(v) {
        if (v === null || v === undefined || v === '') return null;
        if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
        if (typeof v === 'number') { var dn = new Date(v); return isNaN(dn.getTime()) ? null : dn; }
        var s = String(v).trim();
        if (!s) return null;
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (m) return _sameDay(new Date(+m[1], +m[2] - 1, +m[3]), +m[1], +m[2] - 1, +m[3]);
        m = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(UTC|GMT|Z)?$/i.exec(s);
        if (m) {
            var mo = +m[1] - 1, d = +m[2], y = +m[3];
            var hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
            if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
            if (!_sameDay(new Date(y, mo, d), y, mo, d)) return null;
            return _valid(m[7] ? new Date(Date.UTC(y, mo, d, hh, mi, ss))
                               : new Date(y, mo, d, hh, mi, ss));
        }
        // Only hand genuine ISO-ish strings to the Date parser — it accepts
        // a lot of junk ("3", "Sept") and turns it into a confident date.
        if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return _valid(new Date(s));
        return null;
    }
    // new Date(2026, 1, 31) quietly becomes 3 March. A date that does not
    // exist must not be counted in some other month — refuse it.
    function _sameDay(d, y, mo, day) {
        return (d && !isNaN(d.getTime()) && d.getFullYear() === y && d.getMonth() === mo && d.getDate() === day) ? d : null;
    }
    function _valid(d) { return isNaN(d.getTime()) ? null : d; }

    // The first date in the list that parses.
    function firstDate() {
        for (var i = 0; i < arguments.length; i++) {
            var d = parseDate(arguments[i]);
            if (d) return d;
        }
        return null;
    }

    /*
     * A reporting month. `month` is 1-12. Returns a half-open window
     * [start, end) in LOCAL time — the officer's month, not Greenwich's.
     */
    function monthPeriod(year, month) {
        var y = +year, mo = +month;
        if (!(y > 1900) || !(mo >= 1 && mo <= 12)) throw new Error('monthPeriod: bad year/month');
        return {
            year: y, month: mo,
            start: new Date(y, mo - 1, 1),
            end: new Date(y, mo, 1),
            label: MONTHS[mo - 1] + ' ' + y,
            key: y + '-' + (mo < 10 ? '0' : '') + mo
        };
    }

    // IDS is keyed after the month closes, so the sensible default is the
    // month that just ended, not the one in progress.
    function lastFullMonth(now) {
        var n = now ? new Date(now) : new Date();
        var y = n.getFullYear(), mo = n.getMonth(); // 0-based → previous month, 1-based
        if (mo === 0) { y -= 1; mo = 12; }
        return monthPeriod(y, mo);
    }

    function inPeriod(d, period) {
        var dt = parseDate(d);
        return !!dt && dt >= period.start && dt < period.end;
    }

    function fmtDate(d) {
        var dt = parseDate(d);
        if (!dt) return '';
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return p(dt.getMonth() + 1) + '/' + p(dt.getDate()) + '/' + dt.getFullYear();
    }

    // ── Small readers ───────────────────────────────────────────────────

    function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return x && typeof x === 'object'; }) : []; }
    function str(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
    function num(v, dflt) {
        if (v === null || v === undefined || v === '') return dflt;
        var n = Number(v);
        return isFinite(n) && n >= 0 ? Math.round(n) : dflt;
    }
    function venueOf(v) { return str(v).toLowerCase() === 'federal' ? 'federal' : 'state'; }
    function isAssist(c) { return !!c && c.caseRole === 'assist'; }

    function caseLabel(c) {
        return str(c && c.caseNumber) || ('case ' + str(c && c.id));
    }

    /*
     * Is this an ICAC case? The officer's explicit choice wins either way.
     * With no choice recorded, a CyberTip makes it one: a case number typed on
     * the new-case form, or any imported tip.
     */
    function isIcacCase(c, tips) {
        if (!c) return false;
        if (c.icac === true) return true;
        if (c.icac === false) return false;
        return !!str(c.cybertipNumber) || arr(tips).length > 0;
    }

    // The day the investigation landed on this officer.
    function caseOpenedDate(c) {
        return firstDate(c && c.dateAssigned, c && c.createdAt);
    }

    /*
     * Storage size typed by an examiner → gigabytes, or null.
     * Decimal units, the way drives are sold and labelled: 1 TB = 1000 GB.
     * "256 GB", "256GB", "1.5 TB", "512 MB", "2 TB SSD" all read. A bare
     * number with no unit does not — 256 of WHAT is exactly the guess this
     * file refuses to make.
     */
    function parseGb(v) {
        var s = str(v).replace(/,/g, '');
        if (!s) return null;
        var m = /(\d+(?:\.\d+)?)\s*(tb|tib|gb|gib|mb|mib|t|g)\b/i.exec(s);
        if (!m) return null;
        var n = parseFloat(m[1]);
        if (!isFinite(n) || n <= 0) return null;
        var u = m[2].toLowerCase().charAt(0);
        if (u === 't') return n * 1000;
        if (u === 'g') return n;
        return n / 1000;
    }

    // The CyberTips on a case, de-duplicated by report number. A tip typed on
    // the new-case form and later imported as a PDF is ONE referral.
    function caseTips(c, tips) {
        var out = [], seen = {};
        arr(tips).forEach(function (t) {
            var rn = str(t.reportNumber);
            if (rn) { if (seen[rn]) return; seen[rn] = true; }
            out.push({
                reportNumber: rn,
                // The day this agency could have had it. NCMEC's "received"
                // stamp is when the PLATFORM reported it — often weeks before
                // a task force forwards it — so it is the last resort.
                date: firstDate(t.ncmecMadeAvailable, t.importedAt, t.receivedDate),
                source: 'import'
            });
        });
        var typed = str(c && c.cybertipNumber);
        if (typed && !seen[typed]) {
            out.push({ reportNumber: typed, date: caseOpenedDate(c), source: 'case' });
        }
        return out;
    }

    // ── The builder ─────────────────────────────────────────────────────

    /*
     * build({ cases, store, activities, period })
     *
     *   cases      — the viperCases array (null rows tolerated)
     *   store      — { [caseId]: { tips, suspects, warrants, devices,
     *                              prosecution, icac } }   raw records
     *   activities — the viperIdsActivities array
     *   period     — monthPeriod(...) / lastFullMonth()
     *
     * Returns { period, sections, notCounted, warnings, icacCases }.
     * Every row is { key, label, count, detail:[{caseNumber, text}] } —
     * `detail` is what the appendix prints behind the number.
     */
    function build(opts) {
        opts = opts || {};
        var period = opts.period || lastFullMonth();
        var store = opts.store || {};
        var R = {};
        var notCounted = [];
        var warnings = [];

        function row(key, label) { R[key] = { key: key, label: label, count: 0, detail: [] }; return R[key]; }
        function add(key, n, caseNumber, text) {
            R[key].count += n;
            R[key].detail.push({ caseNumber: caseNumber || '', text: text });
        }
        function skip(caseNumber, text, reason) {
            notCounted.push({ caseNumber: caseNumber || '', text: text, reason: reason });
        }

        // Section 1 — Prevention
        row('presentations', 'Presentations');
        row('presentationAttendees', 'Estimated attendees at presentations');
        row('diversion', 'Diversion activities');
        row('diversionParticipants', 'Estimated participants in diversion activities');
        row('publicEvents', 'Public events');
        row('outreach', 'Other outreach (PSAs, billboards, media, social media)');
        // Section 2 — Complaints
        row('citizenComplaints', 'Citizen complaints received');
        row('referralsReceived', 'Referrals received (incl. CyberTips)');
        // Section 3 — Case information
        row('invReactive', 'Reactive investigations opened');
        row('invProactive', 'Proactive investigations opened');
        row('arrests', 'Total arrests');
        row('arrestsHandsOn', 'Arrests of hands-on offenders');
        row('refMadeState', 'Case referrals made — State / Local');
        row('refMadeFederal', 'Case referrals made — Federal');
        row('evidenceNeeded', 'Investigations needing evidence processed');
        row('cvip', 'CVIP submissions');
        // Section 4 — Victims
        row('vicRescued', 'Child victims rescued from ongoing abuse');
        row('vicIdImages', 'Newly identified child victims — with images');
        row('vicIdNoImages', 'Newly identified child victims — without images');
        // Section 5 — Court actions
        row('prosSubState', 'Submitted for prosecution — State / Local');
        row('prosSubFederal', 'Submitted for prosecution — Federal');
        row('prosAccState', 'Accepted for prosecution — State / Local');
        row('prosAccFederal', 'Accepted for prosecution — Federal');
        row('subpoenaState', 'Subpoenas / court orders — State / Local');
        row('subpoenaFederal', 'Subpoenas / court orders — Federal');
        row('swState', 'Search warrants — State / Local');
        row('swFederal', 'Search warrants — Federal');
        // Section 6 — Digital forensics
        row('onScene', 'On-scene forensic previews / exams');
        row('examComputer', 'Forensic exams — computers');
        row('examMobile', 'Forensic exams — mobile devices (phones, tablets)');
        row('examStorage', 'Forensic exams — other data storage devices');
        row('gbExamined', 'Estimated GB examined');
        // Section 7 — Training
        row('trainingConducted', 'Training events conducted');
        row('sentTf', 'Personnel sent to ICAC Task Force training');
        row('sentTtaa', 'Personnel sent to OJJDP T&TA provider training');
        row('sentOther', 'Personnel sent to other training');
        row('trainedLe', 'Law enforcement personnel trained');
        row('trainedProsecutor', 'Prosecutors trained');
        row('trainedOther', 'Other professionals trained');
        // Section 8 — Technical assists
        row('technicalAssists', 'Technical assists / investigative support');

        var gbExact = 0;
        var icacCases = [];

        arr(opts.cases).forEach(function (c) {
            var bag = store[c.id] || {};
            var tips = arr(bag.tips);
            if (!isIcacCase(c, tips)) return;
            var cn = caseLabel(c);
            var assist = isAssist(c);
            var icac = (bag.icac && typeof bag.icac === 'object') ? bag.icac : {};
            icacCases.push({ id: c.id, caseNumber: cn, assist: assist });

            // ── Referrals received: the CyberTips on the case ──
            caseTips(c, tips).forEach(function (t) {
                var label = 'CyberTip' + (t.reportNumber ? ' #' + t.reportNumber : '');
                if (!t.date) { skip(cn, label, 'no date on the tip'); return; }
                if (inPeriod(t.date, period)) add('referralsReceived', 1, cn, label + ' — ' + fmtDate(t.date));
            });

            // ── Investigations opened (CASE-LEVEL: assists excluded) ──
            var opened = caseOpenedDate(c);
            if (!assist && opened && inPeriod(opened, period)) {
                var type = str(icac.investigationType).toLowerCase();
                if (!type && caseTips(c, tips).length) type = 'reactive';
                if (type === 'reactive') add('invReactive', 1, cn, 'Opened ' + fmtDate(opened));
                else if (type === 'proactive') add('invProactive', 1, cn, 'Opened ' + fmtDate(opened));
                else {
                    skip(cn, 'Opened ' + fmtDate(opened), 'not marked reactive or proactive');
                    warnings.push(cn + ' was opened this month but is not marked reactive or proactive.');
                }
            }

            // ── Arrests (WORK PRODUCT) ──
            arr(bag.suspects).forEach(function (s) {
                if (!s.arrested) return;
                var who = str(s.name) || str([s.firstName, s.lastName].filter(Boolean).join(' ')) || 'Suspect';
                var d = firstDate(s.arrestDate, s.dateArrested);
                if (!d) { skip(cn, 'Arrest of ' + who, 'arrest has no date'); return; }
                if (!inPeriod(d, period)) return;
                add('arrests', 1, cn, who + ' — ' + fmtDate(d));
                if (s.handsOnOffender) add('arrestsHandsOn', 1, cn, who + ' — ' + fmtDate(d));
            });

            // ── ICAC card: referrals made, evidence, CVIP, victims ──
            arr(icac.referrals).forEach(function (r) {
                var d = parseDate(r.date);
                var to = str(r.agency) || 'agency not named';
                if (!d) { skip(cn, 'Referral to ' + to, 'referral has no date'); return; }
                if (!inPeriod(d, period)) return;
                add(venueOf(r.venue) === 'federal' ? 'refMadeFederal' : 'refMadeState', 1, cn, to + ' — ' + fmtDate(d));
            });
            if (inPeriod(icac.evidenceNeededDate, period)) add('evidenceNeeded', 1, cn, fmtDate(icac.evidenceNeededDate));
            if (inPeriod(icac.cvipSubmittedDate, period)) add('cvip', 1, cn, fmtDate(icac.cvipSubmittedDate));
            arr(icac.victims).forEach(function (v) {
                var key = v.kind === 'rescued' ? 'vicRescued'
                        : v.kind === 'identified-images' ? 'vicIdImages'
                        : v.kind === 'identified-no-images' ? 'vicIdNoImages' : null;
                if (!key) return;
                var n = num(v.count, 1);
                var d = parseDate(v.date);
                if (!d) { skip(cn, n + ' victim(s)', 'victim entry has no date'); return; }
                if (n > 0 && inPeriod(d, period)) add(key, n, cn, n + ' — ' + fmtDate(d));
            });

            // ── Prosecution submissions ──
            var pros = (bag.prosecution && typeof bag.prosecution === 'object') ? bag.prosecution : {};
            arr(pros.submissions).forEach(function (sub) {
                var fed = venueOf(sub.venue) === 'federal';
                var where = (fed ? 'Federal' : 'State / Local') + (str(sub.office) ? ' (' + str(sub.office) + ')' : '');
                if (inPeriod(sub.submittedDate, period)) add(fed ? 'prosSubFederal' : 'prosSubState', 1, cn, where + ' — submitted ' + fmtDate(sub.submittedDate));
                if (inPeriod(sub.acceptedDate, period)) add(fed ? 'prosAccFederal' : 'prosAccState', 1, cn, where + ' — accepted ' + fmtDate(sub.acceptedDate));
                if (!parseDate(sub.submittedDate)) skip(cn, 'Prosecution submission, ' + where, 'no submitted date');
            });

            // ── Warrants, subpoenas, court orders ──
            arr(bag.warrants).forEach(function (w) {
                var t = str(w.type).toLowerCase();
                var base = (t === 'search') ? 'sw' : (t === 'subpoena' || t === 'court-order') ? 'subpoena' : null;
                if (!base) return; // arrest warrants, preservation letters, other
                var d = firstDate(w.dateSigned, w.createdAt);
                var what = (t === 'search' ? 'Search warrant' : t === 'subpoena' ? 'Subpoena' : 'Court order') +
                           (str(w.issuedTo) ? ' — ' + str(w.issuedTo) : '');
                if (!d) { skip(cn, what, 'no signed date'); return; }
                if (!inPeriod(d, period)) return;
                var fed = venueOf(w.courtLevel) === 'federal';
                add(base + (fed ? 'Federal' : 'State'), 1, cn, what + ' — ' + fmtDate(d));
            });

            // ── Forensic exams ──
            arr(bag.devices).forEach(function (dv) {
                var d = firstDate(dv.acquisitionDate, dv.createdAt);
                if (!d || !inPeriod(d, period)) return;
                var what = (str(dv.makeModel) || str(dv.deviceCategory) || 'Device') + ' — ' + fmtDate(d);
                if (dv.onScene) add('onScene', 1, cn, what);
                var bucket = DEVICE_BUCKET[str(dv.deviceCategory).toLowerCase()];
                if (bucket === 'computer') add('examComputer', 1, cn, what);
                else if (bucket === 'mobile') add('examMobile', 1, cn, what);
                else if (bucket === 'storage') add('examStorage', 1, cn, what);
                else skip(cn, what, 'device type "' + (str(dv.deviceCategory) || 'not set') + '" has no IDS category');
                var gb = parseGb(dv.storageSize);
                if (gb === null) {
                    skip(cn, what, str(dv.storageSize)
                        ? 'storage size "' + str(dv.storageSize) + '" could not be read as GB/TB'
                        : 'no storage size recorded — not in the GB total');
                } else {
                    gbExact += gb;
                    R.gbExamined.detail.push({ caseNumber: cn, text: what + ' — ' + _fmtGb(gb) + ' GB' });
                }
            });
        });

        // IDS asks for a whole number of GB.
        R.gbExamined.count = Math.round(gbExact);

        // ── The dashboard Activity Log ──
        var KMAP = {
            'presentation': ['presentations', 'presentationAttendees'],
            'diversion': ['diversion', 'diversionParticipants'],
            'public-event': ['publicEvents'],
            'outreach': ['outreach'],
            'citizen-complaint': ['citizenComplaints'],
            'referral-received': ['referralsReceived'],
            'training-conducted': ['trainingConducted'],
            'sent-tf': [null, 'sentTf'],
            'sent-ttaa': [null, 'sentTtaa'],
            'sent-other': [null, 'sentOther'],
            'trained-le': [null, 'trainedLe'],
            'trained-prosecutor': [null, 'trainedProsecutor'],
            'trained-other': [null, 'trainedOther'],
            'technical-assist': ['technicalAssists']
        };
        arr(opts.activities).forEach(function (a) {
            var keys = KMAP[a.kind];
            if (!keys) return;
            var d = parseDate(a.date);
            if (!d || !inPeriod(d, period)) return;
            var text = fmtDate(d) + (str(a.notes) ? ' — ' + str(a.notes) : '');
            // The amount leads the detail line, so whoever checks a figure
            // can add the appendix up by eye.
            var c = num(a.count, 1);
            if (keys[0]) add(keys[0], c, '', (c !== 1 ? c + ' — ' : '') + text);
            if (keys[1]) {
                var p = num(a.people, null);
                if (p === null) {
                    if (!keys[0]) skip('', _kindLabel(a.kind) + ' — ' + text, 'number of people not entered');
                } else add(keys[1], p, '', p + (p === 1 ? ' person' : ' people') + ' — ' + text);
            }
        });

        var S = function (title, keys) { return { title: title, rows: keys.map(function (k) { return R[k]; }) }; };
        return {
            period: period,
            icacCases: icacCases,
            sections: [
                S('1. Prevention', ['presentations', 'presentationAttendees', 'diversion', 'diversionParticipants', 'publicEvents', 'outreach']),
                S('2. Complaints', ['citizenComplaints', 'referralsReceived']),
                S('3. Case Information', ['invReactive', 'invProactive', 'arrests', 'arrestsHandsOn', 'refMadeState', 'refMadeFederal', 'evidenceNeeded', 'cvip']),
                S('4. Victims', ['vicRescued', 'vicIdImages', 'vicIdNoImages']),
                S('5. Court Actions', ['prosSubState', 'prosSubFederal', 'prosAccState', 'prosAccFederal', 'subpoenaState', 'subpoenaFederal', 'swState', 'swFederal']),
                S('6. Digital Forensics', ['onScene', 'examComputer', 'examMobile', 'examStorage', 'gbExamined']),
                S('7. Training', ['trainingConducted', 'sentTf', 'sentTtaa', 'sentOther', 'trainedLe', 'trainedProsecutor', 'trainedOther']),
                S('8. Technical Assists', ['technicalAssists'])
            ],
            notCounted: notCounted,
            warnings: warnings
        };
    }

    function _fmtGb(n) { return (Math.round(n * 10) / 10).toString(); }
    function _kindLabel(k) {
        for (var i = 0; i < ACTIVITY_KINDS.length; i++) if (ACTIVITY_KINDS[i].value === k) return ACTIVITY_KINDS[i].label;
        return k;
    }

    return {
        ACTIVITY_KINDS: ACTIVITY_KINDS,
        VICTIM_KINDS: VICTIM_KINDS,
        VENUES: VENUES,
        DEVICE_BUCKET: DEVICE_BUCKET,
        parseDate: parseDate,
        parseGb: parseGb,
        monthPeriod: monthPeriod,
        lastFullMonth: lastFullMonth,
        inPeriod: inPeriod,
        fmtDate: fmtDate,
        isIcacCase: isIcacCase,
        caseOpenedDate: caseOpenedDate,
        caseTips: caseTips,
        build: build
    };
}));
