/*
 * Seeded fake localStorage for the Case Status Report tests and the sample
 * PDF. Deterministic (fixed PRNG + fixed "now") so the numbers never drift.
 *
 *   const { makeStore } = require('./csr-fixture');
 *   const store = makeStore({ cases: 45, now: '2026-10-23T15:00:00' });
 *   build({ getItem: store.getItem, now: store.now, opts: {...} })
 */
'use strict';

function rng(seed) {
    let s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function isoDay(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function daysAgo(now, n, hour) { const d = new Date(now.getTime()); d.setDate(d.getDate() - n); d.setHours(hour || 10, 15, 0, 0); return d; }

const OFFENSES = [
    ['PC 288(a) Lewd Acts w/ Minor', 'Felony'], ['PC 311.11 Possession of CSAM', 'Felony'],
    ['PC 288.3 Contact Minor for Sexual Offense', 'Felony'], ['PC 530.5 Identity Theft', 'Felony'],
    ['PC 646.9 Stalking', 'Felony'], ['PC 487 Grand Theft', 'Felony'], ['PC 422 Criminal Threats', 'Felony'],
    ['PC 653m Annoying Phone Calls', 'Misdemeanor'], ['PC 502 Computer Access / Fraud', 'Felony'],
    ['PC 261.5 Unlawful Sex w/ Minor', 'Felony'], ['PC 459 Burglary', 'Felony'], ['PC 211 Robbery', 'Felony']
];
const PROVIDERS = [['Google', 'Search Warrant'], ['Meta', 'Search Warrant'], ['Snapchat', 'Search Warrant'],
    ['T-Mobile', 'Search Warrant'], ['Verizon', 'Search Warrant'], ['Apple', 'Search Warrant'], ['Discord', 'Preservation'],
    ['Kik', 'Search Warrant'], ['AT&T', 'Search Warrant'], ['Microsoft', 'Subpoena']];
const NOTE_TITLES = ['Victim interview', 'CyberTip review', 'Warrant drafted', 'Called provider LE portal', 'Forensic interview scheduled',
    'Follow-up with DA', 'Device extraction complete', 'Reviewed return data', 'Surveillance', 'Spoke with RP', 'Lab request submitted', 'Suspect ID'];
const NOTE_BODIES = [
    'Met with the reporting party at the station. RP provided screenshots of the messages and the account username. Screenshots booked into evidence.',
    'Reviewed the NCMEC CyberTip. Two uploads flagged by the ESP; IP address resolves to a residential provider in the county. Drafted a warrant for subscriber info.',
    'Submitted the warrant through the provider LE portal. Confirmation number logged. Provider estimates 10–14 business days for production.',
    'Return received and parsed in VIPER. Login IPs match the subscriber address. Identified two additional associated accounts.',
    'Spoke with the DDA regarding filing. DDA requested the forensic extraction report before review.',
    'Phone extraction completed with Cellebrite. Report exported and attached. Reviewing chats for relevant content.'
];
const TASKS = ['Serve preservation letter', 'Follow up on warrant return', 'Schedule forensic interview', 'Submit lab request',
    'Write supplemental report', 'Contact DA', 'Re-interview witness', 'Draft arrest warrant', 'Review extraction report', 'Check DMV / CLETS'];
const NAMES = ['John Doe', 'Michael Reyes', 'Kevin Tran', 'Daniel Ortiz', 'Brian Walsh', 'Unknown Subject', 'Chris Molina', 'Anthony Park'];

function makeStore(o) {
    o = o || {};
    const now = new Date(o.now || '2026-10-23T15:00:00');
    const N = o.cases || 45;
    const r = rng(o.seed || 7);
    const pick = a => a[Math.floor(r() * a.length)];
    const data = {};
    const cases = [], notes = {}, evidence = {}, warrants = {}, reports = {}, tasks = [];

    for (let i = 0; i < N; i++) {
        const age = i < 3 ? 400 + i * 60 : Math.floor(r() < 0.25 ? r() * 30 : 25 + r() * r() * 420);
        const assigned = daysAgo(now, age, 9);
        const off = pick(OFFENSES);
        const num = '26-' + pad(Math.floor(r() * 90) + 10) + String(1000 + i * 37 + Math.floor(r() * 30)).padStart(4, '0');
        const id = 'case_' + (1000 + i);
        const status = i === 40 ? 'closed' : (i === 41 ? 'closed-arrest' : (i === 5 ? 'pending-da' : 'active'));
        const c = {
            id, caseNumber: num, dateAssigned: i % 11 === 4 ? null : isoDay(assigned), createdAt: assigned.toISOString(),
            lastModified: daysAgo(now, Math.floor(r() * Math.min(age, 60)), 14).toISOString(),
            status, primaryOffense: off[0], offenseType: off[1], category: 'Investigation',
            synopsis: '<p>' + pick(NOTE_BODIES) + ' ' + pick(NOTE_BODIES) + '</p>',
            priority: Math.floor(r() * 4), caseRole: i % 13 === 7 ? 'assist' : 'primary', icac: i % 3 === 0,
            dateClosed: status.indexOf('closed') === 0 ? isoDay(daysAgo(now, 6)) : null
        };
        cases.push(c);

        // Activity density: a third of cases idle.
        const busy = r() > 0.33;
        const nNotes = busy ? 1 + Math.floor(r() * 7) : Math.floor(r() * 2);
        notes[num] = [];
        for (let k = 0; k < nNotes; k++) {
            const when = daysAgo(now, Math.floor(r() * Math.max(1, busy ? Math.min(age, 70) : age)), 11);
            notes[num].push({ id: 'n' + i + '_' + k, title: k % 3 === 2 ? '' : pick(NOTE_TITLES), contentHtml: '<p>' + pick(NOTE_BODIES) + '</p>', createdAt: when.toISOString() });
        }
        const nW = Math.floor(r() * 5);
        warrants[num] = [];
        for (let k = 0; k < nW; k++) {
            const pv = pick(PROVIDERS);
            const issued = daysAgo(now, Math.floor(r() * Math.max(1, age)), 13);
            const returned = r() > 0.5;
            const due = new Date(issued.getTime()); due.setDate(due.getDate() + 10);
            warrants[num].push({ id: 'w' + i + '_' + k, issuedTo: pv[0], type: pv[1], referenceNumber: 'SW-' + (2600 + i * 5 + k),
                createdAt: issued.toISOString(), dueDate: isoDay(due), returnReceived: returned,
                returnReceivedAt: returned ? daysAgo(now, Math.max(0, Math.floor((now - issued) / 86400000) - 12), 9).toISOString() : null });
        }
        evidence[num] = [];
        for (let k = 0; k < Math.floor(r() * 6); k++) evidence[num].push({ id: 'e' + i + k, title: pick(['Phone extraction', 'Screenshots', 'iCloud return', 'Laptop image', 'Body cam']), createdAt: daysAgo(now, Math.floor(r() * age), 10).toISOString() });
        const nT = Math.floor(r() * 6);
        for (let k = 0; k < nT; k++) {
            const done = r() > 0.5;
            tasks.push({ id: 't' + i + '_' + k, caseId: num, title: pick(TASKS), date: isoDay(daysAgo(now, Math.floor(r() * 40) - 15)),
                completed: done, completedAt: done ? daysAgo(now, Math.floor(r() * 45), 16).toISOString() : null,
                createdAt: daysAgo(now, Math.floor(r() * Math.max(1, age)), 8).toISOString() });
        }
        if (r() > 0.55) {
            const arrested = r() > 0.6;
            data['suspects_' + id] = JSON.stringify([{ id: 's' + i, name: pick(NAMES), createdAt: daysAgo(now, Math.floor(r() * age), 12).toISOString(),
                arrested, arrestDate: arrested ? isoDay(daysAgo(now, Math.floor(r() * 50))) : null }]);
        }
        if (busy && r() > 0.5) data['fieldwork_' + id] = JSON.stringify([{ id: 'f' + i, presetLabel: pick(['Knock and talk', 'Surveillance', 'Search warrant service']), occurredAt: daysAgo(now, Math.floor(r() * 35), 7).toISOString() }]);
        if (r() > 0.6) reports[num] = { lastSaved: daysAgo(now, Math.floor(r() * age), 17).toISOString() };
    }

    data.viperCases = JSON.stringify(cases);
    data.viperCaseNotes = JSON.stringify(notes);
    data.viperCaseEvidence = JSON.stringify(evidence);
    data.viperCaseWarrants = JSON.stringify(warrants);
    data.viperCaseReports = JSON.stringify(reports);
    data.viperTasks = JSON.stringify(tasks);
    data.viperCustomStatuses = JSON.stringify([{ id: 'pending-da', label: 'Pending DA', color: '#f472b6', category: 'active' }]);
    data.viper_customer_name = 'Det. Sample Investigator';
    data.viper_agency = 'Sample Police Department';
    data.viperUserInfo = JSON.stringify({ badgeNumber: '1234' });
    data.viperAgencyProfile = JSON.stringify({ affiantRank: 'Detective' });
    if (o.history) {
        data.viperCaseStatusReports = JSON.stringify([
            { id: 'h1', generatedAt: daysAgo(now, 30, 9).toISOString(), totals: { overThreshold: 31, openCases: 40 },
              caseUpdates: { [cases[0].caseNumber]: { update: 'Awaiting Google return. Followed up via portal.', nextSteps: 'Review return, ID suspect.', blockers: ['warrant'], targetDate: '' } } },
            { id: 'h2', generatedAt: daysAgo(now, 61, 9).toISOString(), totals: { overThreshold: 34, openCases: 42 }, caseUpdates: {} }
        ]);
    }

    const store = {
        now: now.toISOString(),
        data,
        getItem: k => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: k => { delete data[k]; }
    };
    return store;
}

module.exports = { makeStore };
