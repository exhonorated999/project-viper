/*
 * modules/agency-packs/case-facts.js
 *
 * Turns what VIPER already knows about a case into the two inputs the agency
 * Builder autofills from (builder-model applyCaseFacts / applyProfile):
 *
 *   fromCase({ currentCase, suspect, pcText, offenseDescription, offenseDate }) → facts
 *   profileFrom(agencyProfile, saved)                                          → profile
 *
 * Pure: the case page hands in the objects, nothing is read here.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ViperAgencyCaseFacts = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const str = (v) => (v == null ? '' : String(v)).trim();

    // Suspect height is entered in inches ("70") or as DMV prints it ("5-10", "510", "5'10").
    function heightText(h) {
        const s = str(h);
        if (!s) return '';
        let m = /^(\d{2})(?:\s*(?:in|inches|"))?$/i.exec(s);
        if (m) {
            const n = Number(m[1]);
            if (n >= 36 && n <= 96) return `${Math.floor(n / 12)}'${String(n % 12).padStart(2, '0')}"`;
            return s;
        }
        m = /^([3-8])\s*(?:-|'|ft\.?|\s)\s*(\d{1,2})\s*(?:"|in\.?|'')?$/i.exec(s) || /^([3-8])(\d{2})$/.exec(s);
        if (m && Number(m[2]) < 12) return `${m[1]}'${String(Number(m[2])).padStart(2, '0')}"`;
        return s;
    }

    function weightText(w) {
        const s = str(w);
        if (/^\d{2,3}$/.test(s)) return s + ' lbs';
        return s;
    }

    const SEX = { m: 'Male', f: 'Female', x: 'X', u: 'Unknown' };
    function sexText(s) {
        const v = str(s);
        if (v.length === 1 && SEX[v.toLowerCase()]) return SEX[v.toLowerCase()];
        return v;
    }

    function identifiers(person, type) {
        const list = Array.isArray(person && person.identifiers) ? person.identifiers : [];
        return list.filter(i => i && str(i.type).toLowerCase() === type && str(i.value)).map(i => str(i.value));
    }

    function addressText(p) {
        return [str(p.address), str(p.addressCityStateZip)].filter(Boolean).join(', ');
    }

    function offenseList(c, offenseDescription) {
        const out = [];
        const add = (v) => { const s = str(v); if (s && !out.includes(s)) out.push(s); };
        if (c) {
            add(c.primaryOffense);
            const extra = Array.isArray(c.additionalOffenses) ? c.additionalOffenses : [];
            extra.forEach(o => add(typeof o === 'string' ? o : o && o.offense));
            if (!out.length && c.charges) String(c.charges).split(/\r?\n/).forEach(add);
        }
        if (!out.length) add(offenseDescription);
        return out;
    }

    function fromCase(input) {
        input = input || {};
        const c = input.currentCase || {};
        const s = input.suspect || {};
        const facts = {
            caseNumber: str(c.caseNumber),
            suspectName: str(s.name),
            suspectDob: str(s.dob),
            suspectHeight: heightText(s.height),
            suspectWeight: weightText(s.weight),
            suspectHair: str(s.hairColor || s.hair),
            suspectEye: str(s.eyeColor || s.eyes),
            suspectSex: sexText(s.sex),
            suspectRace: str(s.race),
            suspectAddress: addressText(s),
            suspectPhone: identifiers(s, 'phone')[0] || str(s.phone),
            suspectEmail: identifiers(s, 'email')[0] || str(s.email),
            offenses: offenseList(c, input.offenseDescription),
            offenseDate: str(c.offenseDate).slice(0, 10) || str(input.offenseDate),
        };
        if (Array.isArray(input.pcBlocks) && input.pcBlocks.length) facts.pcBlocks = input.pcBlocks;
        else facts.pcText = str(input.pcText);
        return facts;
    }

    function suspectLabel(s, i) {
        const name = str(s && s.name) || `Suspect ${i + 1}`;
        const dob = str(s && s.dob);
        return dob ? `${name} (DOB ${dob})` : name;
    }

    // Officer details for the forms. `saved` (the Builder's own copy, edited there) wins over
    // the Warrant Author agency profile it is seeded from.
    const PROFILE_KEYS = ['name', 'badge', 'title', 'agency', 'email', 'phone', 'address', 'signatureText', 'backgroundOfAffiant'];
    function profileFrom(agencyProfile, saved) {
        const a = agencyProfile || {};
        const name = str(a.affiantName);
        const title = str(a.affiantRank);
        const seeded = {
            name,
            badge: str(a.affiantBadge),
            title,
            agency: str(a.agencyName),
            email: str(a.affiantEmail),
            phone: str(a.affiantPhone),
            address: str(a.agencyAddress),
            signatureText: [title, name].filter(Boolean).join(' '),
            backgroundOfAffiant: /^REPLACE THIS/.test(str(a.trainingExperienceBoilerplate)) ? '' : str(a.trainingExperienceBoilerplate),
        };
        const out = {};
        PROFILE_KEYS.forEach(k => {
            const v = saved && typeof saved[k] === 'string' ? saved[k] : null;
            out[k] = v != null && v !== '' ? v : seeded[k];
        });
        return out;
    }

    return { fromCase, profileFrom, heightText, weightText, sexText, suspectLabel, offenseList, PROFILE_KEYS };
});
