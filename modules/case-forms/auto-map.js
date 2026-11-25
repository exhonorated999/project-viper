/*
 * modules/case-forms/auto-map.js
 *
 * First-pass mapping of a fillable PDF's fields to VIPER data, from the field
 * NAMES and their reading order. It is a suggestion the mapper screen shows
 * pre-selected; a person always confirms it before a form set is published.
 *
 * Why reading order matters: agency forms reuse bare names. On a juvenile
 * advisement the second "First Name" is the parent's, and the only thing that
 * says so is that it comes after "Parent/Guardian Last Name". So a hint word
 * in a field name ("guardian", "witness", "officer", "juvenile") sets the
 * context for the bare fields that follow it.
 *
 *   suggest(fields) → { bindings: {name: binding}, confidence: {name: 'high'|'low'},
 *                       slots: [{id, label}], vehicleSlots: [{id, label}] }
 *
 * `fields` is pdf-form.inspect().fields — already in reading order.
 * Pure; renderer (window.ViperCaseFormAutoMap) and node.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.ViperCaseFormAutoMap = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Lower-case, accents off, "Date_2" → "date" (+ index 2), punctuation to spaces.
    function norm(name) {
        let s = String(name || '');
        let index = 1;
        const m = /_(\d+)$/.exec(s);
        if (m) { index = +m[1]; s = s.slice(0, m.index); }
        s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase().replace(/[^a-z0-9#]+/g, ' ').replace(/\s+/g, ' ').trim();
        return { text: s, index };
    }

    const has = (t, re) => re.test(t);

    // Which context a field name announces. Order matters: "Relationship to
    // Juvenile" in the parent block is the parent's field, so guardian wins.
    function hintOf(t) {
        if (has(t, /\b(parent|guardian|custodian|parentguardian\w*|padre|tutor)\b/)) return 'guardian';
        if (has(t, /\b(witness|testigo)\b/)) return 'witness';
        if (has(t, /\b(officer|detective|administrator|authorized by|requesting|advising|investigator|notifying|oficial)\b/)) return 'officer';
        if (has(t, /\b(juvenile|juveniles|subject|subjects|consenting party|suspect|defendant|arrestee|individuo)\b/)) return 'subject';
        if (has(t, /\bowner\b/)) return 'subject';
        return null;
    }

    function isVehicleForm(texts) {
        return texts.some(t => /\bvin\b|license plate|plate number/.test(t));
    }

    function subjectLabel(texts, vehicle) {
        const all = texts.join(' | ');
        if (/\bjuvenile/.test(all)) return 'Juvenile';
        if (/consenting party/.test(all)) return 'Consenting party';
        if (vehicle) return 'Registered owner';
        if (/\bwitness\b/.test(all) && !/\bsubject/.test(all)) return 'Witness';
        return 'Subject';
    }

    const SLOT_LABELS = { guardian: 'Parent / guardian', witness: 'Witness' };

    // Person-only field rules, checked in order.
    const PERSON_RULES = [
        [/date of birth|\bdob\b|fecha de nacimiento|birth ?date/, 'person.dob'],
        [/\bage\b|\bedad\b/, 'person.age'],
        [/last name|apellido|surname/, 'person.lastName'],
        [/middle initial/, 'person.middleInitial'],
        [/middle name|segundo nombre/, 'person.middleName'],
        [/first name/, 'person.firstName'],
        [/e ?mail/, 'person.email'],
        [/street|\baddress\b|direccion|domicilio/, 'person.street'],
        [/\bcity\b|ciudad/, 'person.city'],
        [/\bzip\b|postal/, 'person.zip'],
        [/\bstate\b/, 'person.state'],
        [/phone|telefono/, 'person.phone'],
        [/\bsex\b|gender/, 'person.sex'],
        [/\brace\b/, 'person.race'],
        [/height/, 'person.height'],
        [/weight/, 'person.weight'],
        [/driver|\bdl\b|license number/, 'person.dlNumber'],
    ];

    function suggest(fields) {
        const list = Array.isArray(fields) ? fields : [];
        const normed = list.map(f => Object.assign({ f }, norm(f.name)));
        const texts = normed.map(n => n.text);
        const vehicle = isVehicleForm(texts);
        const device = texts.some(t => /lock screen|password|\bpin\b|imei|passcode/.test(t));

        const bindings = {}, confidence = {};
        const usedSlots = new Set();
        let ctx = 'subject';           // current person slot or 'officer'
        let lastPersonSlot = 'subject';
        const seen = {};               // source+slot → count, to spot the 2nd "Date"

        const bind = (name, binding, conf) => {
            bindings[name] = binding;
            confidence[name] = conf;
            if (binding.slot) usedSlots.add(binding.slot);
        };

        normed.forEach(({ f, text: t, index }) => {
            const type = f.type;
            const hint = hintOf(t);
            if (hint) { ctx = hint; if (hint !== 'officer') lastPersonSlot = hint; }
            if (type !== 'text') return;                  // checkboxes, dropdowns, signatures: by hand
            if (f.readOnly) return;

            const key = (src, slot) => {
                const k = src + '|' + (slot || '');
                seen[k] = (seen[k] || 0) + 1;
                return seen[k];
            };
            const once = (src, slot, extra) => {
                const n = key(src, slot);
                bind(f.name, Object.assign({ src }, slot ? { slot } : {}, extra || {}), n === 1 && index === 1 ? 'high' : 'low');
            };

            // 1. Case-level, regardless of context.
            if (/case numbers?|numero de caso|report number|incident number|\bcase #|\bcase no\b/.test(t)) return once('case.number');
            if (/interview you concerning|concerning|\boffenses?\b|\bcharges?\b|\bcrimes?\b/.test(t)) return once('case.offenses');
            if (/def(endant)? names?/.test(t)) return once('case.suspectNames');

            // 2. Vehicles, only on a form that is about a vehicle — an
            // electronic-device consent has "Make" and "Model" too.
            if (vehicle) {
                if (/\bvin\b/.test(t)) return once('vehicle.vin', 'vehicle');
                if (/license plate|plate number/.test(t)) return once('vehicle.plate', 'vehicle');
                if (/(license|plate) state/.test(t)) return once('vehicle.plateState', 'vehicle');
                if (/^year$|vehicle year/.test(t)) return once('vehicle.year', 'vehicle');
                if (/^make$/.test(t)) return once('vehicle.make', 'vehicle');
                if (/^model$/.test(t)) return once('vehicle.model', 'vehicle');
                if (/^colou?r$/.test(t)) {
                    if (index > 1) return;             // second colour box: by hand
                    return once('vehicle.color', 'vehicle');
                }
                if (/license year|^style$/.test(t)) return;
            }

            // 3. Officer. A bare "Last Name" that follows an officer block is
            // NOT the officer's — VIPER has no split officer name — it starts
            // the next person block (the vehicle owner on a hold/release).
            //
            // Device-consent forms are full of "Phone Number", "Application
            // Name", "Username", "Password / PIN" that describe the DEVICE —
            // never the officer or the person. Those are typed by hand.
            if (/application|\bapp\b|user ?name|password|\bpin\b|lock screen|serial|device|imei|account/.test(t)) return;
            const personRuleHit = PERSON_RULES.some(([re]) => re.test(t));
            if (/badge|serial number of officer|\bp ?#|employee (number|#)/.test(t) && !/device|phone/.test(t)) return once('officer.badge');
            if (hint === 'officer' || (ctx === 'officer' && !personRuleHit && /print|name|by\b/.test(t))) {
                if (/print|name|officer|administrator|authorized by|requesting|advising|notifying|oficial/.test(t)
                    && !/observation/.test(t)) return once('officer.name');
                if (!personRuleHit && !/\bdate\b|fecha|\btime\b|hora/.test(t)) return;
            }

            // 4. Dates and times (after officer/person, before generic person).
            const isDob = /date of birth|\bdob\b|fecha de nacimiento|birth ?date/.test(t);
            if (!isDob) {
                if (/date ?time|fecha y hora/.test(t)) return once('now.dateTime');
                if (/\bdate\b|\bfecha\b/.test(t)) return once('now.date');
                if (/\btime\b|\bhora\b/.test(t)) {
                    if (seen['now.time|']) return;     // later times are when the waiver was signed — typed by hand
                    return once('now.time');
                }
            }

            // 5. Person fields, in the current person context.
            const slot = ctx === 'officer' ? lastPersonSlot : ctx;
            for (const [re, src] of PERSON_RULES) {
                if (re.test(t)) {
                    if (src === 'person.state' && /license|plate/.test(t)) return;
                    if (src === 'person.phone' && device) return;   // the phone being searched, not the person's
                    return once(src, slot);
                }
            }
            if (/\bname\b|nombre|printed/.test(t)) return once('person.fullName', slot);
        });

        const slots = [];
        const order = ['subject', 'guardian', 'witness'];
        order.forEach(id => {
            if (usedSlots.has(id)) slots.push({ id, label: id === 'subject' ? subjectLabel(texts, vehicle) : SLOT_LABELS[id], roles: [] });
        });
        const vehicleSlots = usedSlots.has('vehicle') ? [{ id: 'vehicle', label: 'Vehicle' }] : [];
        return { bindings, confidence, slots, vehicleSlots };
    }

    return { suggest, norm, hintOf };
}));
