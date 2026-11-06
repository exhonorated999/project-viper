/**
 * ViperAgencyBuilder — the form logic of a partner agency's warrant Builder, driven entirely by
 * an installed agency pack (its config.json + the `builder` rules in its manifest).
 *
 * Ported from the partner agency's own Builder client so a packet made in VIPER matches one made
 * in their tool: the same field titles/tags handed to the docx engine, the same shared-vs-per-
 * template form layout and ordering, the same profile autofill, the same date formatting and
 * the same output filenames. Nothing agency-specific lives in this file — county names, court
 * districts, filename type tokens, hidden fields and the local timezone all come from the pack.
 * The templates and their config are never part of this repository.
 *
 * Pure (no DOM, no fs). `values` is a plain object the UI owns, keyed by fieldKey*():
 *   'global:<globalFieldId>'          a field linked to a pack Global Field
 *   'tpl:<templateId>:<placeholder>'  an unlinked per-template placeholder
 *   key + '::rangeStart' / '::rangeEnd' / '::datetime' / '::tz'  for the compound pickers.
 * Dates are stored ISO (YYYY-MM-DD, or YYYY-MM-DDTHH:MM for date+time) and only formatted for
 * the document at resolve time. Rich-text (PC statement) fields hold an array of content blocks
 * in the shape docx-form-engine's richtextBlocks expects.
 *
 * Renderer UMD: `module` IS defined in the renderer, so assign both module.exports and
 * root.ViperAgencyBuilder.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.ViperAgencyBuilder = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
    'use strict';

    const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();

    // ---- Default rules (generic field-name heuristics; a pack may override any of them) -------
    const DEFAULT_RULES = Object.freeze({
        // [{ label, countyValue, judicialDistrict, removeDaApproval }]
        counties: [],
        countyFieldNames: ['county'],
        judicialDistrictFieldNames: ['judicial district'],
        // Field names never shown in the form (still emitted as blank controls in the document).
        hiddenFields: [],
        // Categories where county / judicial-district fields are hidden because the county picker
        // is the only thing that sets them.
        hideCountyFieldsFor: [],
        // { category: 'TOKEN' } — document-type token after the case number in filenames.
        typeTokens: {},
        // Categories whose filename "name slot" is the venue rather than the template name.
        venueCategories: [],
        municipalPattern: '\\bmunicipal\\b',
        municipalLabel: 'Muni',
        localTimezone: { value: 'LOCAL', label: 'Local time' },
        timezones: [{ value: 'UTC', label: 'UTC' }],
        priority: [
            ['case number'],
            ['detective, badge', 'name, badge'],
            ['background of affiant', 'affiant background', 'background of officer', 'background of your affiant'],
            ['signature'],
            ['defendant name'],
            ['defendant dob'],
            ['height'],
            ['weight'],
            ['start date'],
            ['end date'],
            ['explain your basic reasoning for choosing the above listed start and end dates'],
            ['list offense', 'list of offense(s)'],
            ['probable cause statement', 'statement of probable cause'],
            ['affiant signature', 'affiant printed name'],
        ],
        dateFields: ['start date', 'end date', 'date of offense', 'date', 'original date',
            'date first signal was received from tracker'],
        dateRangeFields: ['date range of historical records', 'list date range only for historical records',
            'start date to end date'],
        dateTimeFields: ['date/time of admission', 'date and time - utc', 'end date and time', 'end date, time',
            'end date/time', 'exact date and time', 'start date and time', 'start date, time', 'start date/time'],
        richTextPatterns: ['probable cause', 'pc statement'],
        longNarrativeNameLength: 80,
        // Profile field -> list of form field names it answers.
        profileFields: {
            nameBadge: ['detective, badge', 'name, badge'],
            bareName: ['detective name'],
            email: ['detective email'],
            phone: ['detective phone number'],
            signatureText: ['signature', 'affiant printed name', 'affiant signature'],
            backgroundOfAffiant: ['background of affiant', 'affiant background', 'background of officer',
                'background of your affiant'],
            title: ['detective title'],
            agency: ['law enforcement agency', 'name of agency', 'list agency'],
            address: ['detective address'],
        },
        // VIPER case fact -> list of form field names it answers.
        caseFields: {
            caseNumber: ['case number'],
            suspectName: ['defendant name', 'subject name'],
            suspectDob: ['defendant dob', 'dob', 'subject date of birth'],
            suspectHeight: ['height'],
            suspectWeight: ['weight'],
            suspectHair: ['hair color'],
            suspectEye: ['eye color'],
            suspectSex: ['sex'],
            suspectRace: ['race'],
            suspectPronoun: ['pronoun'],
            suspectAddress: ['subject address', 'last known address'],
            suspectPhone: ['subject phone number'],
            suspectEmail: ['subject email'],
            offenses: ['list offense', 'list of offense(s)'],
            offenseDate: ['date of offense'],
        },
        packetSuffix: 'Warrant_Packet.zip',
        filenamePartMax: 60,
        filenameSuffixSlots: 4,
    });

    function mergeRules(rules) {
        const r = Object.assign({}, DEFAULT_RULES, rules || {});
        r.profileFields = Object.assign({}, DEFAULT_RULES.profileFields, (rules && rules.profileFields) || {});
        r.caseFields = Object.assign({}, DEFAULT_RULES.caseFields, (rules && rules.caseFields) || {});
        return r;
    }

    // ---- Small pure helpers (exact ports) ---------------------------------------------------
    function sanitizeTag(name) {
        let tag = String(name || '').replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '');
        if (!tag || /^[0-9]/.test(tag)) tag = 'field_' + tag;
        return tag;
    }

    function detectDropdownChoices(name) {
        name = String(name || '');
        const lower = name.toLowerCase();
        if (['badge', 'phone', 'date', 'time', 'name'].some(k => lower.includes(k))) return null;
        if (name.includes('/')) {
            const parts = name.split('/').map(s => s.trim()).filter(Boolean);
            if (parts.length >= 2 && parts.every(s => s.length < 30)) return parts;
        }
        if (name.includes(',') && !name.includes('name,') && !name.includes('detective,')) {
            const parts = name.split(',').map(s => s.trim()).filter(Boolean);
            if (parts.length >= 2 && parts.every(s => s.length < 30)) return parts;
        }
        return null;
    }

    function displayName(filename) {
        const base = String(filename || '').split('/').pop();
        let name = base.replace(/\.docx$/i, '');
        name = name.replace(/[_.]+Template$/i, '');
        name = name.replace(/(?<!\d)\.(?!\d)/g, ' ').replace(/_/g, ' ');
        name = name.replace(/\s+/g, ' ').trim();
        return name || base;
    }

    function formatDate(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
        if (!m) return iso || '';
        return `${m[2]}/${m[3]}/${m[1]}`;
    }

    function formatDateRange(startIso, endIso) {
        const a = formatDate(startIso), b = formatDate(endIso);
        if (a && b) return `${a} to ${b}`;
        return a || b || '';
    }

    function sanitizeFilenamePart(value, max) {
        max = max || DEFAULT_RULES.filenamePartMax;
        let out = String(value == null ? '' : value)
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/[<>:"/\\|?*]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^[.\s]+|[.\s]+$/g, '');
        if (out.length > max) out = out.slice(0, max).trim().replace(/[.\s]+$/, '');
        return out;
    }

    const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    function guardReservedFilename(stem) {
        return RESERVED_DEVICE_NAME.test(stem) ? stem + '_' : stem;
    }

    // Accepts ISO (YYYY-MM-DD[T...]) or US (M/D/YYYY); returns ISO date or ''.
    function toIsoDate(v) {
        const s = String(v == null ? '' : v).trim();
        let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
        if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
        m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
        if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
        return '';
    }

    // Plain text -> content blocks (one paragraph per non-empty line).
    function textToBlocks(text) {
        return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
            .map(s => s.trim()).filter(Boolean)
            .map(s => ({ type: 'paragraph', runs: [{ text: s }] }));
    }

    // ---- Builder ---------------------------------------------------------------------------
    function createBuilder(config, rules) {
        config = config || {};
        const R = mergeRules(rules);
        const globals = Array.isArray(config.globalFields) ? config.globalFields : [];
        const tc = config.templatesConfig || {};
        const suffixCfg = config.filenameSuffixFields || {};

        const set = (arr) => new Set((arr || []).map(lc));
        const HIDDEN = set(R.hiddenFields);
        const HIDE_COUNTY_FOR = new Set(R.hideCountyFieldsFor || []);
        const COUNTY_NAMES = set(R.countyFieldNames);
        const JD_NAMES = set(R.judicialDistrictFieldNames);
        const DATE = set(R.dateFields), RANGE = set(R.dateRangeFields), DATETIME = set(R.dateTimeFields);
        const RICH = (R.richTextPatterns || []).map(lc);
        const PRIORITY = (R.priority || []).map(g => g.map(lc));
        const VENUE_CATS = new Set(R.venueCategories || []);
        const MUNI = new RegExp(R.municipalPattern || '(?!)', 'i');
        const localTz = (R.localTimezone && R.localTimezone.value) || 'LOCAL';
        const tzValues = new Set([localTz].concat((R.timezones || []).map(t => t.value)));
        const counties = Array.isArray(R.counties) ? R.counties : [];
        // Judicial-district fields are also known by the district values themselves ("17th").
        counties.forEach(c => { if (c && c.judicialDistrict) JD_NAMES.add(lc(c.judicialDistrict)); });

        const profileByName = new Map();
        Object.keys(R.profileFields).forEach(k => (R.profileFields[k] || []).forEach(n => profileByName.set(lc(n), k)));
        const caseByName = new Map();
        Object.keys(R.caseFields).forEach(k => (R.caseFields[k] || []).forEach(n => caseByName.set(lc(n), k)));

        const templates = Object.keys(tc).map(rel => {
            const t = tc[rel] || {};
            const lowerPath = rel.toLowerCase();
            const guessed = (lowerPath.includes('preservation') || lowerPath.includes('letter'))
                ? 'Preservation Request' : 'Search Warrant';
            return {
                id: rel,
                filename: rel,
                displayName: displayName(rel),
                category: t.category || guessed,
                placeholders: Array.isArray(t.placeholders) ? t.placeholders : [],
            };
        });
        const byId = new Map(templates.map(t => [t.id, t]));
        const getTemplate = (id) => byId.get(id) || null;
        const selected = (ids) => (ids || []).map(getTemplate).filter(Boolean);

        // Global-field lookup is hot (every placeholder of every template); index it once.
        const globalIndex = new Map();
        globals.forEach(g => (g.mappings || []).forEach(m => {
            const k = m.templateId + '\u0000' + m.placeholderName;
            if (!globalIndex.has(k)) globalIndex.set(k, g);
        }));
        const globalFor = (t, p) => globalIndex.get(t.id + '\u0000' + p.name) || null;

        const keyShared = (id) => 'global:' + id;
        const keyTemplate = (tid, name) => 'tpl:' + tid + ':' + name;
        const keyFor = (t, p) => { const g = globalFor(t, p); return g ? keyShared(g.id) : keyTemplate(t.id, p.name); };
        const keyForModelField = (tid, f) => f.isSoloShared ? keyShared(f.globalFieldId) : keyTemplate(tid, f.name);

        const isCountyField = (n) => COUNTY_NAMES.has(lc(n));
        const isJudicialDistrictField = (n) => JD_NAMES.has(lc(n));
        const isHidden = (name, category) => {
            const l = lc(name);
            if (HIDDEN.has(l)) return true;
            return HIDE_COUNTY_FOR.has(category) && (isJudicialDistrictField(l) || isCountyField(l));
        };
        const priorityRank = (name) => {
            const l = lc(name);
            for (let i = 0; i < PRIORITY.length; i++) if (PRIORITY[i].includes(l)) return i;
            return PRIORITY.length;
        };
        const isRichText = (n) => { const l = lc(n); return RICH.some(p => l.includes(p)); };
        const isDateField = (n) => DATE.has(lc(n));
        const isDateRangeField = (n) => RANGE.has(lc(n));
        const isDateTimeField = (n) => DATETIME.has(lc(n));
        const isLongNarrative = (n) => {
            const t = String(n || '').trim();
            return profileByName.get(t.toLowerCase()) === 'backgroundOfAffiant' || t.length > R.longNarrativeNameLength;
        };
        const defaultTimezone = (n) => (lc(n).includes('utc') ? 'UTC' : localTz);

        function formatDateTime(local, tz) {
            const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local || '');
            if (!m) return '';
            const h = Number(m[4]);
            const h12 = h % 12 === 0 ? 12 : h % 12;
            const label = tz && tzValues.has(tz) ? tz : localTz;
            return `${m[2]}/${m[3]}/${m[1]} at ${h12}:${m[5]} ${h < 12 ? 'AM' : 'PM'} ${label}`;
        }

        // Kind of input a field gets, by the name the form shows.
        function fieldKind(name, type) {
            if (isRichText(name)) return 'richtext';
            if (isDateRangeField(name)) return 'daterange';
            if (isDateTimeField(name)) return 'datetime';
            if (isDateField(name)) return 'date';
            if (type === 'dropdown') return 'dropdown';
            if (isLongNarrative(name)) return 'long';
            return 'text';
        }

        // Field definitions handed to the docx engine (buildPlaceholderMapping).
        function placeholderMapping(t) {
            if (typeof t === 'string') t = getTemplate(t);
            const out = {};
            if (!t) return out;
            for (const p of t.placeholders) {
                const g = globalFor(t, p);
                const detected = detectDropdownChoices(p.name);
                const ownType = g ? g.type : p.type;
                const ownChoices = g ? g.choices : p.choices;
                out[p.name] = {
                    title: g ? g.name : (p.customTitle || p.name),
                    tag: g ? g.tag : (p.customTag || sanitizeTag(p.name)),
                    type: ownType || (detected ? 'dropdown' : 'text'),
                    choices: (ownChoices && ownChoices.length) ? ownChoices : (detected || []),
                };
            }
            return out;
        }

        // Shared fields (Global Fields used by 2+ selected templates) + per-template sections.
        function formModel(ids) {
            const sel = selected(ids);
            const candidates = new Map();
            const locals = new Map();
            sel.forEach(t => {
                const mine = [];
                t.placeholders.forEach(p => {
                    const g = globalFor(t, p);
                    if (isHidden(g ? g.name : p.name, t.category)) return;
                    if (g) {
                        if (!candidates.has(g.id)) candidates.set(g.id, { field: g, appliesTo: [] });
                        candidates.get(g.id).appliesTo.push({ templateId: t.id, displayName: t.displayName, placeholderName: p.name });
                    } else {
                        mine.push(Object.assign({}, p, { key: keyTemplate(t.id, p.name) }));
                    }
                });
                locals.set(t.id, mine);
            });
            const sharedFields = [];
            const solo = new Map();
            candidates.forEach(({ field, appliesTo }) => {
                if (new Set(appliesTo.map(a => a.templateId)).size >= 2) {
                    sharedFields.push({ field, appliesTo, key: keyShared(field.id) });
                } else {
                    const only = appliesTo[0];
                    if (!solo.has(only.templateId)) solo.set(only.templateId, []);
                    solo.get(only.templateId).push({
                        name: only.placeholderName, customTitle: field.name, type: field.type, choices: field.choices,
                        isSoloShared: true, globalFieldId: field.id, key: keyShared(field.id),
                    });
                }
            });
            sharedFields.sort((a, b) => priorityRank(a.field.name) - priorityRank(b.field.name)
                || a.field.name.localeCompare(b.field.name));
            const label = (f) => f.customTitle || f.name;
            const perTemplateSections = sel.map(t => ({
                templateId: t.id,
                displayName: t.displayName,
                category: t.category,
                fields: locals.get(t.id).concat(solo.get(t.id) || [])
                    .sort((a, b) => priorityRank(label(a)) - priorityRank(label(b)) || label(a).localeCompare(label(b))),
            })).sort((a, b) => a.displayName.localeCompare(b.displayName));
            return { sharedFields, perTemplateSections };
        }

        // ---- Autofill ------------------------------------------------------------------------
        function profileValue(fieldName, profile) {
            const p = profile || {};
            const bare = String(p.name || '').replace(/^(det\.?|detective)\s+/i, '');
            switch (profileByName.get(lc(fieldName))) {
                case 'nameBadge': return [bare, p.badge ? '#' + p.badge : ''].filter(Boolean).join(' ');
                case 'bareName': return bare;
                case 'email': return p.email || '';
                case 'phone': return p.phone || '';
                case 'signatureText': return p.signatureText || '';
                case 'backgroundOfAffiant': return p.backgroundOfAffiant || '';
                case 'title': return p.title || '';
                case 'agency': return p.agency || '';
                case 'address': return p.address || '';
                default: return '';
            }
        }

        // Walks the form model's fields: fn(key, displayName, field) for every visible field.
        function eachModelField(model, fn) {
            model.sharedFields.forEach(({ field, key }) => fn(key, field.name, { type: field.type, choices: field.choices, global: field }));
            model.perTemplateSections.forEach(s => s.fields.forEach(f => fn(keyForModelField(s.templateId, f), f.customTitle || f.name, f)));
        }

        const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

        // Profile first, then a shared Global Field's defaultValue. Only fills empty slots.
        function applyProfile(model, values, profile) {
            model.sharedFields.forEach(({ field, key }) => {
                if (!isEmpty(values[key])) return;
                const v = profileValue(field.name, profile) || field.defaultValue;
                if (v) values[key] = v;
            });
            model.perTemplateSections.forEach(s => s.fields.forEach(f => {
                const key = keyForModelField(s.templateId, f);
                if (!isEmpty(values[key])) return;
                const v = profileValue(f.customTitle || f.name, profile);
                if (v) values[key] = v;
            }));
            return values;
        }

        function matchChoice(value, choices) {
            const v = lc(value);
            if (!v) return '';
            const list = (choices || []).map(String);
            return list.find(c => lc(c) === v)
                || list.find(c => lc(c).startsWith(v) || v.startsWith(lc(c)))
                || '';
        }

        // VIPER case facts -> empty form fields. facts: { caseNumber, suspectName, suspectDob,
        // suspectHeight, suspectWeight, suspectHair, suspectEye, suspectSex, suspectRace,
        // suspectPronoun, suspectAddress, suspectPhone, suspectEmail, offenses, offenseDate,
        // pcText | pcBlocks }. suspectPronoun defaults from suspectSex. Only fills empty slots.
        function applyCaseFacts(model, values, facts) {
            facts = Object.assign({}, facts || {});
            if (!facts.suspectPronoun) {
                const s = lc(facts.suspectSex);
                facts.suspectPronoun = s.startsWith('f') ? 'her' : (s.startsWith('m') ? 'his' : '');
            }
            eachModelField(model, (key, name, f) => {
                if (!isEmpty(values[key])) return;
                const kind = fieldKind(name, f.type);
                if (kind === 'richtext') {
                    const blocks = Array.isArray(facts.pcBlocks) && facts.pcBlocks.length ? facts.pcBlocks : textToBlocks(facts.pcText);
                    if (blocks.length) values[key] = blocks;
                    return;
                }
                const fact = caseByName.get(lc(name));
                if (!fact) return;
                let v = facts[fact];
                if (Array.isArray(v)) v = v.filter(Boolean).join(', ');
                v = String(v == null ? '' : v).trim();
                if (!v) return;
                if (kind === 'date') { v = toIsoDate(v); if (!v) return; }
                else if (fact === 'suspectDob') { const iso = toIsoDate(v); if (iso) v = formatDate(iso); }
                if (f.type === 'dropdown' && f.choices && f.choices.length) { v = matchChoice(v, f.choices); if (!v) return; }
                values[key] = v;
            });
            return values;
        }

        // ---- County picker -------------------------------------------------------------------
        const countyRule = (label) => counties.find(c => c && c.label === label) || null;
        function dependentCountyValue(label, fieldName) {
            const c = countyRule(label);
            if (!c) return '';
            if (isJudicialDistrictField(fieldName)) return c.judicialDistrict || '';
            if (isCountyField(fieldName)) return c.countyValue || '';
            return '';
        }
        // Deliberate pick: overwrites (unlike autofill).
        function applyCounty(label, ids, values) {
            if (!countyRule(label)) return values;
            globals.forEach(g => {
                const v = dependentCountyValue(label, g.name);
                if (v) values[keyShared(g.id)] = v;
            });
            selected(ids).forEach(t => t.placeholders.forEach(p => {
                if (globalFor(t, p)) return;
                const v = dependentCountyValue(label, p.customTitle || p.name) || dependentCountyValue(label, p.name);
                if (v) values[keyTemplate(t.id, p.name)] = v;
            }));
            return values;
        }
        const removeDaApproval = (label) => !!(countyRule(label) && countyRule(label).removeDaApproval);

        // ---- Resolution ----------------------------------------------------------------------
        function resolveValues(t, values) {
            if (typeof t === 'string') t = getTemplate(t);
            const out = {}, rich = {};
            if (!t) return { values: out, richtextBlocks: rich };
            values = values || {};
            t.placeholders.forEach(p => {
                const g = globalFor(t, p);
                const key = g ? keyShared(g.id) : keyTemplate(t.id, p.name);
                const name = g ? g.name : p.name;
                if (isRichText(name)) {
                    const b = values[key];
                    if (Array.isArray(b) && b.length) rich[p.name] = b;
                    else if (typeof b === 'string' && b.trim()) rich[p.name] = textToBlocks(b);
                    return;
                }
                let v;
                if (isDateRangeField(name)) v = formatDateRange(values[key + '::rangeStart'], values[key + '::rangeEnd']);
                else if (isDateTimeField(name)) {
                    const dt = values[key + '::datetime'];
                    v = dt ? formatDateTime(dt, values[key + '::tz'] || defaultTimezone(name)) : '';
                } else {
                    v = String(values[key] == null ? '' : values[key]).trim();
                    if (v && isDateField(name)) v = formatDate(v);
                }
                if (v) out[p.name] = v;
            });
            return { values: out, richtextBlocks: rich };
        }

        // ---- Filenames -----------------------------------------------------------------------
        const part = (v) => sanitizeFilenamePart(v, R.filenamePartMax);

        function caseNumberForFilename(ids, values) {
            values = values || {};
            let raw = '';
            globals.forEach(g => { if (!raw && lc(g.name) === 'case number') raw = values[keyShared(g.id)] || ''; });
            if (!raw) selected(ids).forEach(t => t.placeholders.forEach(p => {
                if (!raw && lc(p.customTitle || p.name) === 'case number') raw = values[keyTemplate(t.id, p.name)] || '';
            }));
            return String(raw).replace(/[^A-Za-z0-9]/g, '');
        }

        function suffixFieldsFor(t) {
            const raw = suffixCfg[t.id];
            if (!raw) return [];
            return (Array.isArray(raw) ? raw : [raw]).slice(0, R.filenameSuffixSlots);
        }

        function documentName(t) {
            const base = part(t.displayName) || 'Warrant';
            return base.replace(/[\s_-]*\b(preservation\s+(letter|request)|warrant)\s*$/i, '').trim() || base;
        }

        function countyForFilename(t, resolved, countyLabel) {
            let raw = '';
            t.placeholders.forEach(p => {
                if (raw) return;
                const g = globalFor(t, p);
                if (isCountyField(g ? g.name : (p.customTitle || p.name))) raw = resolved[p.name] || '';
            });
            if (!raw) raw = countyLabel || '';
            const bare = String(raw).replace(/\s*county\s*$/i, '').trim();
            if (!bare) return '';
            return part(bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase() + ' County');
        }

        // ctx: { ids, values, county }. `resolved` = resolveValues(t, values).values
        function autoOutputFilename(t, resolved, ctx) {
            if (typeof t === 'string') t = getTemplate(t);
            ctx = ctx || {};
            resolved = resolved || {};
            const seen = new Set(), suffixes = [];
            suffixFieldsFor(t).forEach(fieldName => {
                if (!fieldName) return;
                const s = part(resolved[fieldName]);
                if (!s || seen.has(s.toLowerCase())) return;
                seen.add(s.toLowerCase());
                suffixes.push(s);
            });
            const head = [];
            const caseNo = caseNumberForFilename(ctx.ids || [t.id], ctx.values);
            if (caseNo) head.push(caseNo);
            const token = R.typeTokens[t.category] || '';
            if (token) head.push(token);
            const nameSlot = VENUE_CATS.has(t.category)
                ? (MUNI.test(t.displayName) ? R.municipalLabel : countyForFilename(t, resolved, ctx.county))
                : documentName(t);
            if (nameSlot) head.push(nameSlot);
            return guardReservedFilename([head.join(' ')].concat(suffixes).join('_')) + '.docx';
        }

        function outputFilename(t, resolved, ctx, override) {
            const o = part(override);
            if (!o) return autoOutputFilename(t, resolved, ctx);
            return guardReservedFilename(o.replace(/\.docx$/i, '')) + '.docx';
        }

        function packetFilename(ids, values) {
            const c = caseNumberForFilename(ids, values);
            return (c ? c + '_' : '') + R.packetSuffix;
        }

        // Everything the main process needs to build the documents (bytes are added there).
        // opts: { county, overrides: { templateId: filename } }
        function packetRequest(ids, values, opts) {
            opts = opts || {};
            const ctx = { ids, values, county: opts.county };
            const items = selected(ids).map(t => {
                const r = resolveValues(t, values);
                return {
                    templateId: t.id,
                    placeholders: placeholderMapping(t),
                    values: r.values,
                    richtextBlocks: r.richtextBlocks,
                    outFilename: outputFilename(t, r.values, ctx, (opts.overrides || {})[t.id]),
                };
            });
            return {
                templates: items,
                unbracketedFields: Array.isArray(config.unbracketedFields) ? config.unbracketedFields : [],
                removeDaApprovalSection: removeDaApproval(opts.county),
                packetFilename: packetFilename(ids, values),
            };
        }

        const categories = () => Array.from(new Set(templates.map(t => t.category)));

        return {
            rules: R,
            templates, categories, getTemplate, globalFor,
            fieldKeyShared: keyShared, fieldKeyTemplate: keyTemplate, fieldKey: keyFor, fieldKeyForModelField: keyForModelField,
            placeholderMapping, formModel, fieldKind, isHidden, priorityRank,
            isRichText, isDateField, isDateRangeField, isDateTimeField, isLongNarrative, defaultTimezone,
            isCountyField, isJudicialDistrictField,
            profileValue, applyProfile, applyCaseFacts,
            counties: () => counties.slice(), countyRule, applyCounty, removeDaApproval,
            resolveValues, formatDateTime,
            caseNumberForFilename, autoOutputFilename, outputFilename, packetFilename, packetRequest,
            timezones: () => [R.localTimezone].concat(R.timezones || []).filter(Boolean),
        };
    }

    return {
        createBuilder, DEFAULT_RULES, mergeRules,
        sanitizeTag, detectDropdownChoices, displayName, formatDate, formatDateRange,
        sanitizeFilenamePart, guardReservedFilename, toIsoDate, textToBlocks,
    };
});
