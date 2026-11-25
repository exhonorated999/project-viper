/*
 * modules/case-forms/form-sources.js
 *
 * What a form blank can be filled FROM, and how a binding turns into text.
 *
 * A form set (an agency's own fillable PDFs plus a mapping) never stores case
 * data. It stores BINDINGS: "the field called `Subjects Last Name` takes the
 * last name of whoever fills the `subject` slot". At fill time the officer
 * picks who fills each slot (a suspect, a victim, a witness...), and this file
 * resolves every binding against that context.
 *
 *   binding  { src: 'person.lastName', slot: 'subject', fmt?, upper? }
 *            { src: 'const', value: 'text' | true | false }
 *            { src: 'ask', label? }        — left for the officer to type
 *            (no binding)                  — same as 'ask'
 *
 * Pure: the case page hands in the records, nothing is read from storage here.
 * Runs in the renderer (window.ViperCaseFormSources) and under node (tests).
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.ViperCaseFormSources = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const str = (v) => (v == null ? '' : String(v)).trim();

    function caseFacts() {
        if (root && root.ViperAgencyCaseFacts) return root.ViperAgencyCaseFacts;
        try { return require('../agency-packs/case-facts.js'); } catch (_) { return null; }
    }

    /* ── The catalogue ────────────────────────────────────────────────────
     * `needs` says which kind of slot a source reads from. `type` drives the
     * format choices offered in the mapper.
     */
    const SOURCES = [
        { id: 'case.number', label: 'Case number', group: 'Case' },
        { id: 'case.title', label: 'Case title', group: 'Case' },
        { id: 'case.primaryOffense', label: 'Primary offense', group: 'Case' },
        { id: 'case.offenses', label: 'All offenses', group: 'Case' },
        { id: 'case.offenseDate', label: 'Offense date', group: 'Case', type: 'date' },
        { id: 'case.suspectNames', label: 'All suspect names', group: 'Case' },
        { id: 'case.leadDetective', label: 'Lead detective (assist cases)', group: 'Case' },

        { id: 'officer.name', label: 'Officer name', group: 'Officer' },
        { id: 'officer.rankName', label: 'Officer rank + name', group: 'Officer' },
        { id: 'officer.rank', label: 'Officer rank', group: 'Officer' },
        { id: 'officer.badge', label: 'Officer badge #', group: 'Officer' },
        { id: 'officer.nameBadge', label: 'Officer name + badge', group: 'Officer' },
        { id: 'officer.agency', label: 'Agency name', group: 'Officer' },
        { id: 'officer.agencyAddress', label: 'Agency address', group: 'Officer' },
        { id: 'officer.phone', label: 'Officer phone', group: 'Officer' },
        { id: 'officer.email', label: 'Officer email', group: 'Officer' },

        { id: 'person.fullName', label: 'Full name', group: 'Person', needs: 'person' },
        { id: 'person.lastFirst', label: 'Last, First Middle', group: 'Person', needs: 'person' },
        { id: 'person.lastName', label: 'Last name', group: 'Person', needs: 'person' },
        { id: 'person.firstName', label: 'First name', group: 'Person', needs: 'person' },
        { id: 'person.middleName', label: 'Middle name', group: 'Person', needs: 'person' },
        { id: 'person.middleInitial', label: 'Middle initial', group: 'Person', needs: 'person' },
        { id: 'person.dob', label: 'Date of birth', group: 'Person', needs: 'person', type: 'date' },
        { id: 'person.age', label: 'Age', group: 'Person', needs: 'person' },
        { id: 'person.sex', label: 'Sex', group: 'Person', needs: 'person' },
        { id: 'person.race', label: 'Race', group: 'Person', needs: 'person' },
        { id: 'person.height', label: 'Height', group: 'Person', needs: 'person' },
        { id: 'person.weight', label: 'Weight', group: 'Person', needs: 'person' },
        { id: 'person.hair', label: 'Hair color', group: 'Person', needs: 'person' },
        { id: 'person.eyes', label: 'Eye color', group: 'Person', needs: 'person' },
        { id: 'person.addressFull', label: 'Full address', group: 'Person', needs: 'person' },
        { id: 'person.street', label: 'Street address', group: 'Person', needs: 'person' },
        { id: 'person.city', label: 'City', group: 'Person', needs: 'person' },
        { id: 'person.state', label: 'State', group: 'Person', needs: 'person' },
        { id: 'person.zip', label: 'ZIP', group: 'Person', needs: 'person' },
        { id: 'person.phone', label: 'Phone', group: 'Person', needs: 'person' },
        { id: 'person.email', label: 'Email', group: 'Person', needs: 'person' },
        { id: 'person.dlNumber', label: "Driver's license #", group: 'Person', needs: 'person' },
        { id: 'person.dlState', label: "Driver's license state", group: 'Person', needs: 'person' },

        { id: 'vehicle.year', label: 'Year', group: 'Vehicle', needs: 'vehicle' },
        { id: 'vehicle.make', label: 'Make', group: 'Vehicle', needs: 'vehicle' },
        { id: 'vehicle.model', label: 'Model', group: 'Vehicle', needs: 'vehicle' },
        { id: 'vehicle.makeModel', label: 'Make + model', group: 'Vehicle', needs: 'vehicle' },
        { id: 'vehicle.color', label: 'Color', group: 'Vehicle', needs: 'vehicle' },
        { id: 'vehicle.plate', label: 'License plate', group: 'Vehicle', needs: 'vehicle' },
        { id: 'vehicle.plateState', label: 'Plate state', group: 'Vehicle', needs: 'vehicle' },
        { id: 'vehicle.vin', label: 'VIN', group: 'Vehicle', needs: 'vehicle' },

        { id: 'now.date', label: "Today's date", group: 'Date & time', type: 'date' },
        { id: 'now.time', label: 'Current time', group: 'Date & time', type: 'time' },
        { id: 'now.dateTime', label: 'Date and time', group: 'Date & time', type: 'datetime' },
    ];
    const SOURCE_BY_ID = {};
    SOURCES.forEach(s => { SOURCE_BY_ID[s.id] = s; });

    const DATE_FORMATS = ['MM/DD/YYYY', 'M/D/YYYY', 'YYYY-MM-DD', 'MM-DD-YYYY', 'long'];
    const TIME_FORMATS = ['HH:mm', 'HHmm', 'h:mm A'];
    const PERSON_ROLES = ['suspect', 'victim', 'witness', 'involved'];

    /* ── Dates ──────────────────────────────────────────────────────────── */
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'];
    const pad = (n) => String(n).padStart(2, '0');

    // VIPER stores dates from <input type=date> as YYYY-MM-DD; imports may
    // carry MM/DD/YYYY or a full ISO stamp. Returns {y,m,d} or null.
    function parseDate(v) {
        if (v instanceof Date && !isNaN(v)) return { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate() };
        const s = str(v);
        let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
        if (m) return { y: +m[1], m: +m[2], d: +m[3] };
        m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
        if (m) return { y: +m[3], m: +m[1], d: +m[2] };
        return null;
    }

    function formatDate(v, fmt) {
        const p = parseDate(v);
        if (!p) return str(v);
        switch (fmt || 'MM/DD/YYYY') {
            case 'YYYY-MM-DD': return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
            case 'M/D/YYYY': return `${p.m}/${p.d}/${p.y}`;
            case 'MM-DD-YYYY': return `${pad(p.m)}-${pad(p.d)}-${p.y}`;
            case 'long': return `${MONTHS[p.m - 1] || ''} ${p.d}, ${p.y}`;
            default: return `${pad(p.m)}/${pad(p.d)}/${p.y}`;
        }
    }

    function formatTime(date, fmt) {
        const h = date.getHours(), mi = date.getMinutes();
        switch (fmt || 'HH:mm') {
            case 'HHmm': return pad(h) + pad(mi);
            case 'h:mm A': return `${h % 12 || 12}:${pad(mi)} ${h < 12 ? 'AM' : 'PM'}`;
            default: return `${pad(h)}:${pad(mi)}`;
        }
    }

    function ageOn(dob, ref) {
        const b = parseDate(dob), r = parseDate(ref || new Date());
        if (!b || !r) return '';
        let a = r.y - b.y;
        if (r.m < b.m || (r.m === b.m && r.d < b.d)) a--;
        return a >= 0 && a < 130 ? String(a) : '';
    }

    /* ── Names ──────────────────────────────────────────────────────────── */
    const SUFFIX_RE = /^(jr|sr|ii|iii|iv|v)\.?$/i;

    // VIPER keeps a civilian's name as ONE string. Forms want it in pieces.
    // "Smith, John Paul Jr" and "John Paul Smith Jr" both split the same way;
    // a suffix stays with the last name, which is how a records clerk writes it.
    function splitName(full) {
        const s = str(full).replace(/\s+/g, ' ');
        if (!s) return { first: '', middle: '', last: '' };
        if (s.includes(',')) {
            const [lastPart, ...rest] = s.split(',');
            const tail = rest.join(' ').trim().split(' ').filter(Boolean);
            let suffix = '';
            if (tail.length && SUFFIX_RE.test(tail[tail.length - 1])) suffix = tail.pop();
            return {
                last: [lastPart.trim(), suffix].filter(Boolean).join(' '),
                first: tail[0] || '',
                middle: tail.slice(1).join(' '),
            };
        }
        const t = s.split(' ');
        let suffix = '';
        if (t.length > 2 && SUFFIX_RE.test(t[t.length - 1])) suffix = t.pop();
        if (t.length === 1) return { first: t[0], middle: '', last: suffix };
        return {
            first: t[0],
            middle: t.slice(1, -1).join(' '),
            last: [t[t.length - 1], suffix].filter(Boolean).join(' '),
        };
    }

    /* ── Addresses ──────────────────────────────────────────────────────── */
    // "Springfield, CO 80031", "Springfield CO 80031-1234", "Springfield, Colorado"
    function splitCityStateZip(s) {
        let rest = str(s).replace(/\s+/g, ' ');
        const out = { city: '', state: '', zip: '' };
        if (!rest) return out;
        const z = /[\s,]*(\d{5}(?:-\d{4})?)$/.exec(rest);
        if (z) { out.zip = z[1]; rest = rest.slice(0, z.index).trim(); }
        if (rest.includes(',')) {
            const i = rest.lastIndexOf(',');
            out.city = rest.slice(0, i).trim();
            out.state = rest.slice(i + 1).trim();
        } else {
            const m = /^(.*\S)\s+([A-Za-z]{2})$/.exec(rest);
            if (m) { out.city = m[1]; out.state = m[2].toUpperCase(); } else out.city = rest;
        }
        return out;
    }

    function splitAddress(street, cityStateZip) {
        let st = str(street), csz = str(cityStateZip);
        // Only one box filled with the whole line: "123 Main St, Springfield, CO 80031"
        if (!csz && st.includes(',')) {
            const i = st.indexOf(',');
            csz = st.slice(i + 1).trim();
            st = st.slice(0, i).trim();
        }
        const parts = splitCityStateZip(csz);
        return { street: st, city: parts.city, state: parts.state, zip: parts.zip };
    }

    /* ── Records → flat shapes ─────────────────────────────────────────── */
    function identifier(rec, type) {
        const list = Array.isArray(rec && rec.identifiers) ? rec.identifiers : [];
        const hit = list.find(i => i && str(i.type).toLowerCase() === type && str(i.value));
        return hit ? str(hit.value) : '';
    }

    function normPerson(rec) {
        const r = rec || {};
        const CF = caseFacts();
        let first, middle, last, full;
        if (r.lawEnforcement || (!str(r.name) && (str(r.firstName) || str(r.lastName)))) {
            first = str(r.firstName); last = str(r.lastName); middle = str(r.middleName);
            full = [first, middle, last].filter(Boolean).join(' ');
        } else {
            full = str(r.name).replace(/\s+/g, ' ');
            const sp = splitName(full);
            first = sp.first; middle = sp.middle; last = sp.last;
            if (/,/.test(full)) full = [first, middle, last].filter(Boolean).join(' ');
        }
        const addr = splitAddress(r.address, r.addressCityStateZip);
        return {
            fullName: full,
            firstName: first,
            middleName: middle,
            lastName: last,
            dob: str(r.dob),
            sex: CF ? CF.sexText(r.sex) : str(r.sex),
            race: str(r.race),
            height: CF ? CF.heightText(r.height) : str(r.height),
            weight: CF ? CF.weightText(r.weight) : str(r.weight),
            hair: str(r.hairColor || r.hair),
            eyes: str(r.eyeColor || r.eyes),
            street: addr.street,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            addressFull: [str(r.address), str(r.addressCityStateZip)].filter(Boolean).join(', '),
            phone: str(r.phone) || identifier(r, 'phone') || str(r.agencyPhone),
            email: str(r.email) || identifier(r, 'email'),
            dlNumber: str(r.dlNumber) || identifier(r, 'dl'),
            dlState: str(r.dlState),
        };
    }

    function normVehicle(rec) {
        const r = rec || {};
        let year = str(r.year), make = str(r.make), model = str(r.model);
        let mm = str(r.makeModel);
        if (!make && mm) {
            const y = /^(\d{4})\s+(.*)$/.exec(mm);
            if (y) { if (!year) year = y[1]; mm = y[2]; }
            const t = mm.split(/\s+/);
            make = t[0] || '';
            model = t.slice(1).join(' ');
        }
        return {
            year, make, model,
            makeModel: [make, model].filter(Boolean).join(' ') || mm,
            color: str(r.color),
            plate: str(r.licensePlate || r.plateNumber || r.plate),
            plateState: str(r.plateState || r.licenseState),
            vin: str(r.vin).toUpperCase(),
        };
    }

    function officerFrom(profile, fallbackName) {
        const a = profile || {};
        const name = str(a.affiantName || a.name) || str(fallbackName);
        return {
            name,
            rank: str(a.affiantRank || a.rank || a.title),
            badge: str(a.affiantBadge || a.badge),
            agency: str(a.agencyName || a.agency),
            agencyAddress: str(a.agencyAddress || a.address),
            phone: str(a.affiantPhone || a.phone),
            email: str(a.affiantEmail || a.email),
        };
    }

    /* ── Pick lists for the fill screen ───────────────────────────────── */
    const ROLE_LISTS = [
        ['suspect', 'suspects', 'Suspect'],
        ['victim', 'victims', 'Victim'],
        ['witness', 'witnesses', 'Witness'],
        ['involved', 'involvedPersons', 'Involved'],
    ];

    function peopleFromCase(stores) {
        const s = stores || {};
        const out = [];
        ROLE_LISTS.forEach(([role, key, label]) => {
            (Array.isArray(s[key]) ? s[key] : []).forEach((rec, i) => {
                if (!rec) return;
                const p = normPerson(rec);
                if (!p.fullName) return;
                out.push({
                    key: key + ':' + i, role, roleLabel: label,
                    label: p.fullName + (p.dob ? ' (DOB ' + formatDate(p.dob) + ')' : ''),
                    record: rec,
                });
            });
        });
        return out;
    }

    function vehiclesFromCase(stores) {
        const s = stores || {};
        const out = [];
        const add = (rec, key, owner) => {
            const v = normVehicle(rec);
            const label = [v.year, v.makeModel, v.color].filter(Boolean).join(' ')
                + (v.plate ? ' — ' + v.plate + (v.plateState ? ' ' + v.plateState : '') : '');
            if (!label.trim()) return;
            out.push({ key, label: label.trim() + (owner ? ' (' + owner + ')' : ''), record: rec });
        };
        (Array.isArray(s.recoveredVehicles) ? s.recoveredVehicles : []).forEach((r, i) => r && add(r, 'recoveredVehicles:' + i, ''));
        [['suspects', 'Suspect'], ['victims', 'Victim']].forEach(([key]) => {
            (Array.isArray(s[key]) ? s[key] : []).forEach((p, pi) => {
                (Array.isArray(p && p.vehicles) ? p.vehicles : []).forEach((v, vi) => v && add(v, key + ':' + pi + ':vehicles:' + vi, str(p.name)));
            });
        });
        return out;
    }

    /* ── Context + resolution ─────────────────────────────────────────── */
    /**
     * ctx = buildContext({
     *   currentCase, suspects,          // for case.* (suspect names)
     *   officer,                        // officerFrom(...) result or raw profile
     *   people:   { subject: <record>, guardian: <record> },
     *   vehicles: { vehicle: <record> },
     *   now: Date
     * })
     */
    function buildContext(input) {
        const i = input || {};
        const c = i.currentCase || {};
        const CF = caseFacts();
        const offenses = CF ? CF.offenseList(c, i.offenseDescription) : [str(c.primaryOffense)].filter(Boolean);
        const people = {};
        Object.keys(i.people || {}).forEach(k => { if (i.people[k]) people[k] = normPerson(i.people[k]); });
        const vehicles = {};
        Object.keys(i.vehicles || {}).forEach(k => { if (i.vehicles[k]) vehicles[k] = normVehicle(i.vehicles[k]); });
        // Accepts the Warrant Author agency profile as stored, or an
        // already-flat { name, badge, ... } — officerFrom reads both.
        const officer = officerFrom(i.officer, c.createdBy);
        return {
            case: {
                number: str(c.caseNumber),
                title: str(c.title || c.caseName),
                primaryOffense: offenses[0] || '',
                offenses: offenses.join('; '),
                offenseDate: str(c.offenseDate).slice(0, 10),
                suspectNames: (Array.isArray(i.suspects) ? i.suspects : [])
                    .map(s => normPerson(s).fullName).filter(Boolean).join('; '),
                leadDetective: str(c.leadDetective),
            },
            officer,
            people,
            vehicles,
            now: i.now instanceof Date ? i.now : new Date(),
        };
    }

    function resolve(binding, ctx) {
        const b = binding || {};
        if (!b.src || b.src === 'ask') return '';
        if (b.src === 'const') return b.value == null ? '' : b.value;
        const src = SOURCE_BY_ID[b.src];
        if (!src) return '';
        const [group, key] = b.src.split('.');
        let v = '';
        if (group === 'case') {
            v = ctx.case[key] || '';
            if (src.type === 'date') v = formatDate(v, b.fmt);
        } else if (group === 'officer') {
            const o = ctx.officer || {};
            if (key === 'rankName') v = [o.rank, o.name].filter(Boolean).join(' ');
            else if (key === 'nameBadge') v = [o.name, o.badge ? '#' + String(o.badge).replace(/^#/, '') : ''].filter(Boolean).join(' ');
            else v = o[key] || '';
        } else if (group === 'person') {
            const p = ctx.people[b.slot];
            if (!p) return '';
            if (key === 'lastFirst') v = p.lastName ? p.lastName + (p.firstName ? ', ' + [p.firstName, p.middleName].filter(Boolean).join(' ') : '') : p.fullName;
            else if (key === 'middleInitial') v = p.middleName ? p.middleName.charAt(0).toUpperCase() : '';
            else if (key === 'age') v = ageOn(p.dob, ctx.now);
            else if (key === 'dob') v = formatDate(p.dob, b.fmt);
            else v = p[key] || '';
        } else if (group === 'vehicle') {
            const veh = ctx.vehicles[b.slot];
            v = veh ? (veh[key] || '') : '';
        } else if (group === 'now') {
            if (key === 'date') v = formatDate(ctx.now, b.fmt);
            else if (key === 'time') v = formatTime(ctx.now, b.timeFmt || b.fmt);
            else v = formatDate(ctx.now, b.fmt) + ' ' + formatTime(ctx.now, b.timeFmt);
        }
        v = str(v);
        return b.upper ? v.toUpperCase() : v;
    }

    /** Every binding → { values: {field: value}, empty: [field names with nothing to put in] }. */
    function resolveAll(bindings, ctx) {
        const values = {}, empty = [];
        Object.keys(bindings || {}).forEach(name => {
            const b = bindings[name];
            if (!b || !b.src || b.src === 'ask') return;
            const v = resolve(b, ctx);
            if (v === '' || v == null) empty.push(name);
            else values[name] = v;
        });
        return { values, empty };
    }

    return {
        SOURCES, SOURCE_BY_ID, DATE_FORMATS, TIME_FORMATS, PERSON_ROLES,
        parseDate, formatDate, formatTime, ageOn,
        splitName, splitCityStateZip, splitAddress,
        normPerson, normVehicle, officerFrom,
        peopleFromCase, vehiclesFromCase,
        buildContext, resolve, resolveAll,
    };
}));
