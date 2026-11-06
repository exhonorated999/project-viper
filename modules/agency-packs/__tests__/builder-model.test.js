'use strict';
// Tests for modules/agency-packs/builder-model.js — config and rules are SYNTHETIC.
// Run: node modules/agency-packs/__tests__/builder-model.test.js
const B = require('../builder-model.js');

let pass = 0, fail = 0;
function ok(c, label) { if (c) pass++; else { fail++; console.error('FAIL:', label); } }
function eq(a, b, label) {
  const A = JSON.stringify(a), E = JSON.stringify(b);
  ok(A === E, label + ' — got ' + A + ', want ' + E);
}

// ---- Synthetic pack --------------------------------------------------------------------------
const T_ACME = 'Warrants/Acme/Acme_Template.docx';
const T_BETA = 'Warrants/Beta Co/Beta.Co Warrant_Template.docx';
const T_PRES = 'Letters/Gamma Preservation Letter_Template.docx';
const T_RULE = 'Warrants/Rule 41.1 Thing_Template.docx';
const T_CNTY = 'Arrest/County/County Arrest Warrant_Template.docx';
const T_MUNI = 'Arrest/Municipal/Municipal Arrest Warrant_Template.docx';

const ph = (name, extra) => Object.assign({ name, customTitle: name, customTag: B.sanitizeTag(name), type: 'text', choices: [] }, extra || {});
const map = (tid, name) => ({ templateId: tid, placeholderName: name });

const config = {
  globalFields: [
    { id: 'g_case', name: 'Case Number', tag: 'case_number', mappings: [map(T_ACME, 'case number'), map(T_BETA, 'Case #'), map(T_CNTY, 'case number'), map(T_MUNI, 'case number'), map(T_RULE, 'case number')] },
    { id: 'g_badge', name: 'detective, badge', tag: 'detective__badge', mappings: [map(T_ACME, 'detective, badge'), map(T_BETA, 'detective, badge')] },
    { id: 'g_bg', name: 'background of affiant', tag: 'bg', mappings: [map(T_ACME, 'background of affiant'), map(T_BETA, 'background of affiant')] },
    { id: 'g_chief', name: 'Chief/Senior', tag: 'chief', mappings: [map(T_ACME, 'Chief/Senior'), map(T_BETA, 'Chief/Senior')] },
    { id: 'g_jd', name: 'Judicial District', tag: 'jd', type: 'dropdown', choices: ['9th', '10th'], defaultValue: '9th', mappings: [map(T_ACME, '9th'), map(T_BETA, '9th'), map(T_CNTY, '9th')] },
    { id: 'g_cty', name: 'county', tag: 'county', type: 'dropdown', choices: ['NORTH', 'SOUTH'], mappings: [map(T_CNTY, 'NORTH/SOUTH'), map(T_MUNI, 'NORTH/SOUTH')] },
    { id: 'g_start', name: 'start date', tag: 'start_date', mappings: [map(T_ACME, 'start date'), map(T_BETA, 'start date')] },
    { id: 'g_pc', name: 'statement of probable cause', tag: 'pc', mappings: [map(T_ACME, 'statement of probable cause'), map(T_CNTY, 'probable cause statement')] },
    { id: 'g_hair', name: 'hair color', tag: 'hair', type: 'dropdown', choices: ['Brown', 'Black', 'Blonde'], mappings: [map(T_CNTY, 'Brown/Black/Blonde'), map(T_MUNI, 'Brown/Black/Blonde')] },
    { id: 'g_dname', name: 'Defendant Name', tag: 'dname', mappings: [map(T_CNTY, 'defendant name'), map(T_MUNI, 'defendant name')] },
    { id: 'g_dob', name: 'Defendant DOB', tag: 'ddob', mappings: [map(T_CNTY, 'defendant dob'), map(T_MUNI, 'defendant dob')] },
    { id: 'g_solo', name: 'date of offense', tag: 'doo', mappings: [map(T_ACME, 'date of offense(s)')] },
  ],
  unbracketedFields: [{ id: 'u1', search: 'NINTH', title: 'judicial district', tag: 'judicial_district' }],
  filenameSuffixFields: { [T_ACME]: ['account', 'account', 'phone model'], [T_BETA]: 'account' },
  templatesConfig: {
    [T_ACME]: { category: 'Search Warrant', placeholders: [
      ph('case number'), ph('detective, badge'), ph('background of affiant'), ph('Chief/Senior'), ph('9th'), ph('start date'),
      ph('statement of probable cause'), ph('date of offense(s)'), ph('account'), ph('phone model'), ph('red/green/blue', { customTitle: '', customTag: '', type: '' }),
      ph('date range of historical records'), ph('start date and time - UTC', { customTitle: 'start date and time - UTC' }), ph('end date/time'),
      ph('detective name'), ph('very long field name '.repeat(5).trim()),
    ] },
    [T_BETA]: { category: 'Search Warrant', placeholders: [ph('Case #'), ph('detective, badge'), ph('background of affiant'), ph('Chief/Senior'), ph('9th'), ph('start date'), ph('account')] },
    [T_PRES]: { category: 'Preservation Request', placeholders: [ph('account'), ph('case number')] },
    [T_RULE]: { category: 'Search Warrant', placeholders: [ph('case number')] },
    [T_CNTY]: { category: 'Arrest Warrant', placeholders: [ph('case number'), ph('9th'), ph('NORTH/SOUTH', { customTitle: 'county' }), ph('probable cause statement'), ph('Brown/Black/Blonde', { customTitle: 'hair color' }), ph('defendant name'), ph('defendant dob'), ph('height')] },
    [T_MUNI]: { category: 'Arrest Warrant', placeholders: [ph('case number'), ph('NORTH/SOUTH', { customTitle: 'county' }), ph('Brown/Black/Blonde'), ph('defendant name'), ph('defendant dob'), ph('M/F', { customTitle: 'sex', type: 'dropdown', choices: ['Male', 'Female'] }), ph('his/her', { customTitle: 'pronoun', type: 'dropdown', choices: ['his', 'her'] }), ph('date of offense')] },
  },
};
const rules = {
  counties: [
    { label: 'North County', countyValue: 'NORTH', judicialDistrict: '9th', removeDaApproval: false },
    { label: 'South County', countyValue: 'SOUTH', judicialDistrict: '10th', removeDaApproval: true },
  ],
  judicialDistrictFieldNames: ['judicial district'],
  hiddenFields: ['chief/senior'],
  hideCountyFieldsFor: ['Arrest Warrant'],
  typeTokens: { 'Search Warrant': 'SW', 'Arrest Warrant': 'AW', 'Preservation Request': 'PRES LETTER' },
  venueCategories: ['Arrest Warrant'],
  localTimezone: { value: 'ZT', label: 'Zone Time' },
  timezones: [{ value: 'UTC', label: 'UTC' }],
};
const b = B.createBuilder(config, rules);
const ALL = [T_ACME, T_BETA, T_PRES, T_RULE, T_CNTY, T_MUNI];

// ---- Defaults carry nothing agency-specific --------------------------------------------------
eq(B.DEFAULT_RULES.counties, [], 'no default counties');
eq(B.DEFAULT_RULES.typeTokens, {}, 'no default type tokens');
eq(B.DEFAULT_RULES.hiddenFields, [], 'no default hidden fields');

// ---- Pure helpers ----------------------------------------------------------------------------
eq(B.sanitizeTag('detective, badge'), 'detective__badge', 'sanitizeTag');
eq(B.sanitizeTag('9th'), 'field_9th', 'sanitizeTag leading digit');
eq(B.sanitizeTag('__'), 'field_', 'sanitizeTag empty');
eq(B.detectDropdownChoices('red/green/blue'), ['red', 'green', 'blue'], 'detect slash choices');
eq(B.detectDropdownChoices('apples, pears'), ['apples', 'pears'], 'detect comma choices');
eq(B.detectDropdownChoices('detective, badge'), null, 'badge never a dropdown');
eq(B.detectDropdownChoices('start date/time'), null, 'date never a dropdown');
eq(B.displayName(T_ACME), 'Acme', 'displayName strips _Template');
eq(B.displayName(T_BETA), 'Beta Co Warrant', 'displayName dots/underscores');
eq(B.displayName(T_RULE), 'Rule 41.1 Thing', 'displayName keeps numeric dot');
eq(B.formatDate('2026-01-05'), '01/05/2026', 'formatDate');
eq(B.formatDate('soon'), 'soon', 'formatDate passthrough');
eq(B.formatDateRange('2026-01-05', '2026-02-06'), '01/05/2026 to 02/06/2026', 'date range');
eq(B.formatDateRange('', '2026-02-06'), '02/06/2026', 'date range half');
eq(B.sanitizeFilenamePart('a\nb: c/d?. '), 'a b cd', 'filename part');
eq(B.sanitizeFilenamePart('x'.repeat(70)).length, 60, 'filename part capped');
eq(B.guardReservedFilename('CON'), 'CON_', 'reserved guard');
eq(B.guardReservedFilename('CONX'), 'CONX', 'reserved guard only exact');
eq(B.toIsoDate('3/4/1990'), '1990-03-04', 'toIsoDate US');
eq(B.toIsoDate('1990-03-04T00:00:00Z'), '1990-03-04', 'toIsoDate ISO');
eq(B.toIsoDate('nope'), '', 'toIsoDate invalid');
eq(B.textToBlocks('a\r\n\r\n b '), [{ type: 'paragraph', runs: [{ text: 'a' }] }, { type: 'paragraph', runs: [{ text: 'b' }] }], 'textToBlocks');

// ---- Templates ------------------------------------------------------------------------------
eq(b.templates.length, 6, 'templates loaded');
eq(b.getTemplate(T_PRES).category, 'Preservation Request', 'category from config');
eq(B.createBuilder({ templatesConfig: { 'x/Some Letter.docx': {} } }).templates[0].category, 'Preservation Request', 'category guessed from path');
eq(b.categories().sort(), ['Arrest Warrant', 'Preservation Request', 'Search Warrant'], 'categories');

// ---- Placeholder mapping ---------------------------------------------------------------------
const mA = b.placeholderMapping(T_ACME);
eq(mA['case number'], { title: 'Case Number', tag: 'case_number', type: 'text', choices: [] }, 'mapping global');
eq(mA['9th'], { title: 'Judicial District', tag: 'jd', type: 'dropdown', choices: ['9th', '10th'] }, 'mapping global dropdown');
eq(mA['account'], { title: 'account', tag: 'account', type: 'text', choices: [] }, 'mapping own');
eq(mA['red/green/blue'], { title: 'red/green/blue', tag: 'red_green_blue', type: 'dropdown', choices: ['red', 'green', 'blue'] }, 'mapping detected dropdown + fallback tag');
eq(b.placeholderMapping(T_ACME)['account'].type, 'text', 'own type wins over detection');
eq(b.placeholderMapping(T_BETA)['Case #'].title, 'Case Number', 'mapping differently-worded placeholder');
eq(b.placeholderMapping('nope'), {}, 'mapping unknown template');

// ---- Form model -------------------------------------------------------------------------------
const model = b.formModel([T_ACME, T_BETA]);
const sharedNames = model.sharedFields.map(s => s.field.name);
eq(sharedNames, ['Case Number', 'detective, badge', 'background of affiant', 'start date', 'Judicial District'], 'shared fields in priority order, hidden dropped');
ok(!sharedNames.includes('date of offense'), 'solo global not shared');
const acmeSec = model.perTemplateSections.find(s => s.templateId === T_ACME);
const solo = acmeSec.fields.find(f => f.isSoloShared && f.globalFieldId === 'g_solo');
eq(solo && solo.name, 'date of offense(s)', 'solo shared keeps its placeholder name');
eq(solo && solo.key, 'global:g_solo', 'solo shared keeps global key');
eq(b.fieldKeyForModelField(T_ACME, solo), 'global:g_solo', 'fieldKeyForModelField solo');
ok(!acmeSec.fields.some(f => /chief/i.test(f.name)), 'chief hidden in sections');
eq(acmeSec.fields[0].name, 'statement of probable cause', 'section ordered by priority');
eq(model.perTemplateSections.map(s => s.displayName), ['Acme', 'Beta Co Warrant'], 'sections sorted by name');
const aModel = b.formModel([T_CNTY, T_MUNI]);
ok(!aModel.sharedFields.some(s => /county|judicial/i.test(s.field.name)), 'county/district hidden on arrest warrants');
ok(model.sharedFields.some(s => s.field.name === 'Judicial District'), 'district visible on search warrants');
eq(b.formModel([T_ACME]).sharedFields.length, 0, 'single template has no shared');

// ---- Field kinds -----------------------------------------------------------------------------
eq(b.fieldKind('statement of probable cause'), 'richtext', 'kind richtext');
eq(b.fieldKind('start date'), 'date', 'kind date');
eq(b.fieldKind('date range of historical records'), 'daterange', 'kind range');
eq(b.fieldKind('end date/time'), 'datetime', 'kind datetime');
eq(b.fieldKind('hair color', 'dropdown'), 'dropdown', 'kind dropdown');
eq(b.fieldKind('Background of Your Affiant'), 'long', 'kind long by profile');
eq(b.fieldKind('x'.repeat(81)), 'long', 'kind long by length');
eq(b.fieldKind('account'), 'text', 'kind text');
eq(b.defaultTimezone('date and time - UTC'), 'UTC', 'tz utc');
eq(b.defaultTimezone('end date/time'), 'ZT', 'tz local from rules');

// ---- Profile autofill ------------------------------------------------------------------------
const profile = { name: 'Det. Pat Example', badge: '77', email: 'p@example.invalid', signatureText: '/s/ P. Example', backgroundOfAffiant: 'SYNTHETIC bg' };
eq(b.profileValue('detective, badge', profile), 'Pat Example #77', 'name badge strips Det.');
eq(b.profileValue('Detective Name', profile), 'Pat Example', 'bare name');
eq(b.profileValue('affiant printed name', profile), '/s/ P. Example', 'signature');
eq(b.profileValue('account', profile), '', 'no profile value');
const vals = { 'global:g_bg': 'typed already' };
b.applyProfile(model, vals, profile);
eq(vals['global:g_badge'], 'Pat Example #77', 'applyProfile shared');
eq(vals['global:g_bg'], 'typed already', 'applyProfile never overwrites');
eq(vals['global:g_jd'], '9th', 'applyProfile global defaultValue');
eq(vals['tpl:' + T_ACME + ':detective name'], 'Pat Example', 'applyProfile per-template');

// ---- Case facts ------------------------------------------------------------------------------
const cvals = { 'global:g_dname': 'Kept Name' };
b.applyCaseFacts(aModel, cvals, { caseNumber: '26-0042', suspectName: 'X', suspectDob: '1990-03-04', suspectHair: 'blond', suspectSex: 'F', offenseDate: '3/9/2026', pcText: 'one\ntwo', suspectHeight: '' });
eq(cvals['global:g_case'], '26-0042', 'case number');
eq(cvals['global:g_dname'], 'Kept Name', 'case facts never overwrite');
eq(cvals['global:g_dob'], '03/04/1990', 'dob formatted US');
eq(cvals['global:g_hair'], 'Blonde', 'dropdown matched by prefix');
eq(cvals['tpl:' + T_MUNI + ':M/F'], 'Female', 'sex dropdown');
eq(cvals['tpl:' + T_MUNI + ':his/her'], 'her', 'pronoun from sex');
eq(cvals['tpl:' + T_MUNI + ':date of offense'], '2026-03-09', 'date fact stored ISO');
eq(cvals['global:g_pc'], [{ type: 'paragraph', runs: [{ text: 'one' }] }, { type: 'paragraph', runs: [{ text: 'two' }] }], 'pc text to blocks');
ok(!('tpl:' + T_CNTY + ':height' in cvals), 'empty fact skipped');
const cv2 = {};
b.applyCaseFacts(aModel, cv2, { suspectHair: 'purple', pcBlocks: [{ type: 'bullet', runs: [{ text: 'b' }] }], offenses: ['A', '', 'B'] });
ok(!('global:g_hair' in cv2), 'unmatched dropdown skipped');
eq(cv2['global:g_pc'][0].type, 'bullet', 'pc blocks used as given');

// ---- County picker --------------------------------------------------------------------------
const cty = { 'global:g_jd': '9th' };
b.applyCounty('South County', [T_CNTY, T_MUNI], cty);
eq(cty['global:g_jd'], '10th', 'county sets district (overwrites)');
eq(cty['global:g_cty'], 'SOUTH', 'county sets county value');
const ctyUnlinked = B.createBuilder({ templatesConfig: { 'a.docx': { category: 'Search Warrant', placeholders: [ph('9th', { customTitle: 'judicial district' }), ph('county')] } } }, rules);
const cu = {};
ctyUnlinked.applyCounty('North County', ['a.docx'], cu);
eq(cu, { 'tpl:a.docx:9th': '9th', 'tpl:a.docx:county': 'NORTH' }, 'county reaches unlinked fields');
const none = {};
b.applyCounty('Nowhere', ALL, none);
eq(none, {}, 'unknown county is a no-op');
eq(b.removeDaApproval('South County'), true, 'DA strip from rule');
eq(b.removeDaApproval('North County'), false, 'no DA strip');
eq(b.removeDaApproval(''), false, 'no county no strip');

// ---- Resolution -------------------------------------------------------------------------------
const K = (n) => 'tpl:' + T_ACME + ':' + n;
const rv = {
  'global:g_case': ' 26-0042 ', 'global:g_start': '2026-01-02', 'global:g_solo': '2026-01-03', 'global:g_badge': '',
  [K('date range of historical records') + '::rangeStart']: '2026-01-01', [K('date range of historical records') + '::rangeEnd']: '2026-01-31',
  [K('start date and time - UTC') + '::datetime']: '2026-01-02T00:05',
  [K('end date/time') + '::datetime']: '2026-01-02T13:30',
  'global:g_pc': 'plain pc text',
};
const r = b.resolveValues(T_ACME, rv);
eq(r.values['case number'], '26-0042', 'resolve trims');
eq(r.values['start date'], '01/02/2026', 'resolve date');
eq(r.values['date of offense(s)'], '01/03/2026', 'resolve date by global name');
eq(r.values['date range of historical records'], '01/01/2026 to 01/31/2026', 'resolve range');
eq(r.values['start date and time - UTC'], undefined, 'non-exact datetime name stays text');
eq(r.values['end date/time'], '01/02/2026 at 1:30 PM ZT', 'resolve datetime local tz');
ok(!('detective, badge' in r.values), 'empty values omitted');
eq(r.richtextBlocks['statement of probable cause'], [{ type: 'paragraph', runs: [{ text: 'plain pc text' }] }], 'string pc becomes blocks');
eq(b.formatDateTime('2026-01-02T00:05', 'UTC'), '01/02/2026 at 12:05 AM UTC', 'datetime midnight UTC');
eq(b.formatDateTime('2026-01-02T12:00', 'BOGUS'), '01/02/2026 at 12:00 PM ZT', 'unknown tz falls back to local');

// ---- Filenames --------------------------------------------------------------------------------
const fv = { 'global:g_case': '26-0042', [K('account')]: 'user:one', [K('phone model')]: 'USER:ONE' };
const ra = b.resolveValues(T_ACME, fv).values;
eq(b.caseNumberForFilename([T_ACME], fv), '260042', 'case number alnum');
eq(b.autoOutputFilename(T_ACME, ra, { ids: [T_ACME], values: fv }), '260042 SW Acme_userone.docx', 'auto name, suffix de-duped');
eq(b.autoOutputFilename(T_BETA, {}, { ids: [T_BETA], values: fv }), '260042 SW Beta Co.docx', 'trailing Warrant removed, string suffix cfg');
eq(b.autoOutputFilename(T_PRES, {}, { ids: [T_PRES], values: fv }), '260042 PRES LETTER Gamma.docx', 'trailing Preservation Letter removed');
eq(b.autoOutputFilename(T_CNTY, {}, { ids: [T_CNTY], values: fv, county: 'South County' }), '260042 AW South County.docx', 'arrest venue from picker');
eq(b.autoOutputFilename(T_CNTY, { 'NORTH/SOUTH': 'NORTH' }, { ids: [T_CNTY], values: fv, county: 'South County' }), '260042 AW North County.docx', 'arrest venue from county field');
eq(b.autoOutputFilename(T_MUNI, {}, { ids: [T_MUNI], values: fv, county: 'South County' }), '260042 AW Muni.docx', 'municipal venue');
eq(b.autoOutputFilename(T_RULE, {}, { ids: [T_RULE], values: {} }), 'SW Rule 41.1 Thing.docx', 'no case number');
eq(b.outputFilename(T_ACME, ra, { ids: [T_ACME], values: fv }, 'My: name.docx'), 'My name.docx', 'override sanitized');
eq(b.outputFilename(T_ACME, ra, { ids: [T_ACME], values: fv }, 'nul'), 'nul_.docx', 'override reserved');
eq(b.outputFilename(T_ACME, ra, { ids: [T_ACME], values: fv }, '  '), '260042 SW Acme_userone.docx', 'blank override = auto');
eq(b.packetFilename([T_ACME], fv), '260042_Warrant_Packet.zip', 'packet name');
eq(b.packetFilename([T_ACME], {}), 'Warrant_Packet.zip', 'packet name no case');
const noTok = B.createBuilder(config, {});
eq(noTok.autoOutputFilename(T_CNTY, {}, { ids: [T_CNTY], values: fv }), '260042 County Arrest.docx', 'generic rules: no token, template name');

// ---- Packet request ---------------------------------------------------------------------------
const req = b.packetRequest([T_ACME, 'missing', T_CNTY], Object.assign({}, fv, cty), { county: 'South County', overrides: { [T_CNTY]: 'Custom' } });
eq(req.templates.map(t => t.templateId), [T_ACME, T_CNTY], 'packet skips unknown ids');
eq(req.templates[1].outFilename, 'Custom.docx', 'packet override');
eq(req.templates[1].values['9th'], '10th', 'hidden county field still resolved');
eq(req.removeDaApprovalSection, true, 'packet DA strip');
eq(req.packetFilename, '260042_Warrant_Packet.zip', 'packet filename');
eq(req.unbracketedFields.length, 1, 'packet unbracketed');
ok(req.templates[0].placeholders['case number'].tag === 'case_number', 'packet mapping');
eq(b.timezones().map(t => t.value), ['ZT', 'UTC'], 'timezones');

console.log(`builder-model: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
