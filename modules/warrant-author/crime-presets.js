// modules/warrant-author/crime-presets.js
// ─────────────────────────────────────────────────────────────────────────────
// Crime-type presets for the Residential Search Warrant authoring flow.
//
// Each preset packages the **starter content** for one of the four supported
// crime categories (CSAM, Narcotics, Persons Crime, Property Crime). When a
// user picks a crime type while drafting a residential SW, the UI materialises
// the relevant fields from the matching preset into `draft.residential`. The
// user can then freely edit any field; the preset is purely a starting point.
//
// Content origin:
//   • Verbatim Items-to-Seize blocks and SOPC scaffolds derived from the user's
//     San Bernardino exemplar pack (2025-Q4 review).
//   • PC §1524 grounds toggles match the canonical exemplars per crime.
//   • Training & Experience presets contain CRIME-SPECIFIC SPECIALISATION
//     prose only (e.g. ICAC certification, narcotics CI ops). The general
//     law-enforcement-career T&E lives in the agency profile and is rendered
//     ahead of the crime-specific addendum.
//
// Compliance note (mirrors boilerplate-library.js):
//   • Every shipped paragraph carries `lastReviewed`. Agencies MUST review
//     with their DA before serving a warrant generated from a preset.
//
// Pure data + helpers — no I/O, no DOM. Renderer + main process both consume.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

(function () {

const SCHEMA_VERSION = 1;
const LAST_REVIEWED = '2026-06-07';

// ─── PC 1524 grounds (used by face-page checklist) ─────────────────────────
// Keys must match draft.pc1524Grounds in draft-store.js.
const PC1524_KEYS = Object.freeze([
  'stolen', 'felonyMeans', 'possessedWithIntent', 'evidenceOfFelony',
  'sexualExploitation', 'arrestWarrant', 'ecspMisdemeanor', 'laborCode',
]);

function _grounds(overrides) {
  const out = {};
  for (const k of PC1524_KEYS) out[k] = false;
  if (overrides) for (const k of Object.keys(overrides)) out[k] = !!overrides[k];
  return out;
}

// ─── CSAM ──────────────────────────────────────────────────────────────────
const CSAM = Object.freeze({
  id: 'csam',
  label: 'CSAM (Child Sexual Abuse Material)',
  legacyAliases: ['cp', 'child pornography'],
  description:
    'Child sexual abuse material possession / distribution / production. ' +
    'Use for ICAC-style investigations originating from NCMEC CyberTips, ' +
    'ESP reports, peer-to-peer investigations, or undercover operations.',
  defaultOffenses: Object.freeze([
    Object.freeze({ code: 'PC 311.11', label: 'Possession of Matter Depicting Sexual Conduct of a Person Under 18' }),
    Object.freeze({ code: 'PC 311.3',  label: 'Sexual Exploitation of a Child' }),
  ]),

  pc1524Grounds: _grounds({
    felonyMeans: true,
    evidenceOfFelony: true,
    sexualExploitation: true,
  }),

  defaultOptionalClauses: Object.freeze({
    offsiteComputerSearch: true,
    authorityToDuplicate: true,
    returnExtension: true,
    nightService:  Object.freeze({ enabled: true, justification:
      'Your affiant requests night service pursuant to Penal Code section 1533. ' +
      'Officers will need to conduct surveillance of the location prior to ' +
      'service to confirm the suspect(s) are present, and the cover of darkness ' +
      'will reduce the likelihood that the suspect(s) detect approach and ' +
      'destroy digital evidence. Subjects involved in the sexual exploitation ' +
      'of children commonly take active steps to destroy or conceal evidence ' +
      'when alerted to law-enforcement presence.' }),
    hobbsSealing:  Object.freeze({ enabled: true, justification:
      'Your affiant requests Hobbs sealing of the Statement of Probable Cause. ' +
      'The affidavit contains identifying information regarding a confidential ' +
      'reporting source, ongoing ICAC investigative techniques, and details of ' +
      'a CyberTipline report whose disclosure would compromise the integrity ' +
      'of the underlying investigation.' }),
    statutoryGroundsRecap: true,
  }),

  // CSAM-specific specialisation appended after the agency-profile T&E.
  // Leaves the user's general law-enforcement career narrative untouched.
  trainingExperiencePreset:
    'Your affiant is a member of the Internet Crimes Against Children ' +
    '(ICAC) Task Force and has received specialised training in the ' +
    'investigation of crimes involving the sexual exploitation of children, ' +
    'including the recognition, identification, and forensic preservation of ' +
    'child sexual abuse material (CSAM). Your affiant has reviewed numerous ' +
    'images and videos depicting CSAM in the course of these investigations ' +
    'and has familiarity with the indicia of production, distribution, and ' +
    'possession offences under California Penal Code sections 311 et seq. ' +
    'Your affiant has received training from, and accesses CyberTipline ' +
    'reports through, the National Center for Missing and Exploited Children ' +
    '(NCMEC), which serves as the national clearinghouse for Electronic ' +
    'Communication Service Providers (ECSPs) reporting suspected CSAM ' +
    'pursuant to 18 U.S.C. \u00a72258A.\n\n' +
    'Your affiant continues to read current and updated information ' +
    'pertaining to the sexual exploitation of children through periodicals, ' +
    'newsletters, and publications including those issued by the Department ' +
    'of Justice, the National District Attorneys Association, the ' +
    'Children\u2019s Bureau, and the National Center for Missing and ' +
    'Exploited Children.',

  itemsToSeize: Object.freeze([
    Object.freeze({
      id: 'csam.electronic-devices',
      label: 'Electronic Devices',
      body:
        'Computers, laptop computers, tablet computers, slate computers, ' +
        'computer servers, internal storage devices, external storage ' +
        'devices, peripheral storage devices, electronic storage devices, ' +
        'flash drives, thumb drives, flash memory cards, magnetic tape ' +
        'storage, hard disk drives, solid state drives, optical disk ' +
        'storage, floppy disks, digital video recorders, digital cameras, ' +
        'camcorders, digital audio recorders and/or players, cellular ' +
        'phones, telephones, global positioning devices, digital reading ' +
        'devices, digital gaming devices, digital home entertainment ' +
        'devices, printers, fax machines, scanners and any other device or ' +
        'media capable of storing electronic data.',
    }),
    Object.freeze({
      id: 'csam.examination-authorization',
      label: 'Examination & Search Authorisation',
      body:
        'Examination and search of all of the above components is for all ' +
        'files, data, images, software, operating systems, deleted files, ' +
        'system configurations, drive and disk configurations, date and ' +
        'time, unallocated and slack space. Any and all computer passwords ' +
        'and other data security devices designed to restrict access to or ' +
        'hide computer software, documentation, or data, consisting of ' +
        'hardware, software, or other programming code.',
    }),
    Object.freeze({
      id: 'csam.dominion-control',
      label: 'Articles of Personal Property (Dominion & Control)',
      body:
        'Articles of personal property which will identify the person or ' +
        'persons in control of the premises and/or areas where the ' +
        'above-named items may be found, including keys to those areas ' +
        'that may be locked, and documents or papers bearing the name(s) ' +
        'and the address to be searched, such as rent receipts, utility ' +
        'bills, cancelled mail, pay-check stubs or other employment ' +
        'records, tax documents, and/or personal identification.',
    }),
    Object.freeze({
      id: 'csam.catchall',
      label: 'Catch-all Evidence Clause',
      body:
        'And any other items believed to show evidence of sexual ' +
        'exploitation of a child, in violation of California Penal Code ' +
        'section 311 et seq.',
    }),
  ]),

  sopcScaffold: Object.freeze([
    Object.freeze({ heading: 'Initial Report (NCMEC CyberTip / ECSP)', body: '' }),
    Object.freeze({ heading: 'Imagery Review and Classification',     body: '' }),
    Object.freeze({ heading: 'IP / Subscriber Attribution',            body: '' }),
    Object.freeze({ heading: 'Suspect Identification',                 body: '' }),
    Object.freeze({ heading: 'Registered Sex Offender / Background',   body: '' }),
    Object.freeze({ heading: 'Premises Nexus',                         body: '' }),
    Object.freeze({ heading: 'Conclusion',                             body: '' }),
  ]),

  lastReviewed: LAST_REVIEWED,
});

// ─── Narcotics ─────────────────────────────────────────────────────────────
const NARCOTICS = Object.freeze({
  id: 'narcotics',
  label: 'Narcotics',
  legacyAliases: ['dope', 'drugs'],
  description:
    'Controlled substance investigations — possession for sale, ' +
    'transportation, manufacturing, or clandestine laboratory activity. ' +
    'Includes methamphetamine, cocaine, heroin, fentanyl, marijuana ' +
    'cultivation/sales, and related conspiracies.',
  defaultOffenses: Object.freeze([
    Object.freeze({ code: 'HS 11378', label: 'Possession for Sale of a Controlled Substance' }),
    Object.freeze({ code: 'HS 11379', label: 'Transportation/Sale of a Controlled Substance' }),
  ]),

  pc1524Grounds: _grounds({
    felonyMeans: true,
    possessedWithIntent: true,
    evidenceOfFelony: true,
  }),

  defaultOptionalClauses: Object.freeze({
    offsiteComputerSearch: false,
    authorityToDuplicate: false,
    returnExtension: false,
    nightService:  Object.freeze({ enabled: true, justification:
      'Your affiant requests night service pursuant to Penal Code section 1533. ' +
      'Based on training and experience, persons engaged in narcotics ' +
      'trafficking commonly destroy evidence (flushing, swallowing, or ' +
      'discarding) when alerted to law-enforcement presence, and are ' +
      'frequently armed for the protection of their narcotics and proceeds. ' +
      'Approach under cover of darkness reduces the risk to officers and ' +
      'the likelihood that evidence is destroyed during entry.' }),
    hobbsSealing:  Object.freeze({ enabled: false, justification: '' }),
    statutoryGroundsRecap: true,
  }),

  trainingExperiencePreset:
    'Your affiant has received specialised training in the investigation of ' +
    'narcotics offences, including the use, packaging, distribution, and ' +
    'manufacture of controlled substances. Your affiant has participated in ' +
    'controlled-purchase operations supervised through confidential informants ' +
    '(CIs), has used presumptive field-test kits (including NIK) to identify ' +
    'suspected controlled substances, and is familiar with the typical ' +
    'methods used by narcotics traffickers to package, conceal, transport, ' +
    'and distribute their product.\n\n' +
    'Based on training and experience, your affiant knows that persons who ' +
    'sell controlled substances commonly maintain at their residences: (a) ' +
    'quantities of the controlled substance held for sale; (b) scales, ' +
    'packaging materials (plastic baggies, balloons), and pay/owe ledgers ' +
    'recording transactions; (c) United States currency representing the ' +
    'proceeds of sales; (d) firearms and ammunition for the protection of ' +
    'their narcotics and proceeds; (e) electronic devices used to ' +
    'communicate with co-conspirators and customers; and (f) ' +
    'indicia of dominion and control over the premises.\n\n' +
    'Your affiant continues to read current and updated information ' +
    'pertaining to narcotics enforcement through periodicals and ' +
    'publications issued by the California Narcotic Officers\u2019 ' +
    'Association, the Department of Justice, and the Drug Enforcement ' +
    'Administration.',

  itemsToSeize: Object.freeze([
    Object.freeze({
      id: 'narc.controlled-substance',
      label: 'Controlled Substance(s)',
      body:
        '{{TARGET_DRUG}} and any other controlled substance, including its ' +
        'salts, isomers, derivatives, precursors, and analogues.',
    }),
    Object.freeze({
      id: 'narc.indicia-of-sales',
      label: 'Indicia of Sales (Scales, Packaging, Pay/Owe Ledgers)',
      body:
        'Scales, books, papers, records of narcotic notations (commonly ' +
        'referred to as pay/owe ledgers), balloons, plastic baggies, and ' +
        'any other items used to package, weigh, divide, or store ' +
        'narcotics for the purpose of sale, as well as items used to ' +
        'ingest narcotics into the human body.',
    }),
    Object.freeze({
      id: 'narc.proceeds',
      label: 'Proceeds (United States Currency)',
      body:
        'All United States currency tending to show the proceeds of ' +
        'narcotics sales or the means to purchase additional narcotics.',
    }),
    Object.freeze({
      id: 'narc.stolen-property',
      label: 'Stolen Property',
      body:
        'Any and all property which is proved to be stolen or which has ' +
        'serial numbers removed, altered, or obliterated.',
    }),
    Object.freeze({
      id: 'narc.weapons',
      label: 'Weapons & Ammunition',
      body:
        'Weapons including but not limited to rifles, shotguns, ' +
        'semi-automatic weapons, assault weapons, revolvers, semi-' +
        'automatic handguns, machine pistols, and any ammunition, ' +
        'holsters, carrying cases, accessories, clips, and magazines for ' +
        'the above-listed items.',
    }),
    Object.freeze({
      id: 'narc.electronic-devices',
      label: 'Electronic Devices (Communications)',
      body:
        'Cellular telephones, smart phones, tablets, computers, and any ' +
        'other electronic devices used to communicate with co-conspirators, ' +
        'customers, suppliers, or otherwise to coordinate the trafficking ' +
        'of controlled substances, including any data, contact lists, ' +
        'text messages, and call records contained therein.',
    }),
    Object.freeze({
      id: 'narc.phone-answer-auth',
      label: 'Authorisation to Answer/Record Phone Calls',
      body:
        'Authorisation to answer and record any narcotic-related ' +
        'transactions at the phone or phones located at the place to be ' +
        'searched during the service of this warrant.',
    }),
    Object.freeze({
      id: 'narc.surveillance-equipment',
      label: 'Counter-Surveillance Equipment',
      body:
        'Cameras, monitors, and all items related to video surveillance ' +
        'equipment used by occupants of the location to monitor activity ' +
        'outside the location.',
    }),
    Object.freeze({
      id: 'narc.dominion-control',
      label: 'Articles of Personal Property (Dominion & Control)',
      body:
        'Articles of personal property tending to establish the identity ' +
        'of persons in control of the premises, vehicles, storage areas, ' +
        'and containers being searched, consisting of but not limited to ' +
        'utility-company receipts, rent receipts, addressed envelopes, ' +
        'and keys.',
    }),
  ]),

  sopcScaffold: Object.freeze([
    Object.freeze({ heading: 'Source of Information / Confidential Informant', body: '' }),
    Object.freeze({ heading: 'Controlled Purchase',                            body: '' }),
    Object.freeze({ heading: 'Presumptive Field Test',                         body: '' }),
    Object.freeze({ heading: 'Surveillance Observations',                      body: '' }),
    Object.freeze({ heading: 'Dealer-Behaviour Opinion Paragraphs',            body: '' }),
    Object.freeze({ heading: 'Premises Nexus',                                 body: '' }),
    Object.freeze({ heading: 'Conclusion',                                     body: '' }),
  ]),

  lastReviewed: LAST_REVIEWED,
});

// ─── Persons Crime ─────────────────────────────────────────────────────────
const PERSONS = Object.freeze({
  id: 'persons',
  label: 'Crimes Against Persons',
  legacyAliases: ['violent', 'pc 187', 'pc 211', 'pc 261', 'pc 664'],
  description:
    'Violent or person-targeted offences: homicide (PC 187), attempted ' +
    'murder (PC 664/187), robbery (PC 211), assault with a deadly weapon ' +
    '(PC 245), sexual assault (PC 261, 288, 289), kidnapping (PC 207). ' +
    'Search targets evidence at the scene + suspect dominion locations.',
  defaultOffenses: Object.freeze([
    Object.freeze({ code: 'PC 187', label: 'Murder' }),
  ]),

  pc1524Grounds: _grounds({
    felonyMeans: true,
    evidenceOfFelony: true,
    possessedWithIntent: true,
  }),

  defaultOptionalClauses: Object.freeze({
    offsiteComputerSearch: true,
    authorityToDuplicate: true,
    returnExtension: false,
    nightService:  Object.freeze({ enabled: true, justification:
      'Your affiant requests night service pursuant to Penal Code section 1533. ' +
      'The investigation is ongoing and the suspect(s) remain outstanding. ' +
      'Delay until daylight materially increases the risk of evidence ' +
      'destruction, flight, or further harm to victims or witnesses.' }),
    hobbsSealing:  Object.freeze({ enabled: false, justification: '' }),
    statutoryGroundsRecap: true,
  }),

  trainingExperiencePreset:
    'Your affiant has received specialised training in the investigation ' +
    'of violent crimes including homicide, attempted homicide, robbery, ' +
    'and aggravated assault. Your affiant is familiar with crime-scene ' +
    'preservation, the documentation of biological and trace evidence, ' +
    'the recovery of firearms and edged weapons, and the use of digital ' +
    'evidence (cellular telephones, social-media communications, mapping ' +
    'data) to identify suspects, establish associations, and corroborate ' +
    'or refute alibis.\n\n' +
    'Based on training and experience, your affiant knows that suspects ' +
    'in violent-crime investigations commonly retain at their residences ' +
    'and on their persons: (a) the clothing worn during the offence, ' +
    'which may bear biological evidence of the victim; (b) weapons or ' +
    'instruments used to commit the offence; (c) cellular telephones and ' +
    'other electronic devices containing communications with co-suspects ' +
    'and location-history relevant to the offence; (d) identification ' +
    'documents and articles of personal property establishing dominion ' +
    'over the premises.',

  itemsToSeize: Object.freeze([
    Object.freeze({
      id: 'persons.identification-evidence',
      label: 'Identification Evidence (Victim / Suspect / Parties)',
      body:
        'Any documents leading to the identification of the victim(s) ' +
        'and/or suspect(s); any documents leading to the identification ' +
        'of the property owner, property manager, renter or lessee; all ' +
        'writings, photographs, or notes that could lead to the identity ' +
        'of suspect(s), victim(s), witness(es), or any involved party.',
    }),
    Object.freeze({
      id: 'persons.communications',
      label: 'Communications Records',
      body:
        'All phone records, all electronic storage media including but ' +
        'not limited to cellular phones, smart phones, tablets, ' +
        'electronic address books, thumb drives, writable storage media, ' +
        'laptop computer(s), and desktop computer(s).',
    }),
    Object.freeze({
      id: 'persons.biological-trace',
      label: 'Biological / Trace Evidence',
      body:
        'Blood and any other form of biological or trace evidence, ' +
        'including but not limited to hair, fibres, fingerprints, and ' +
        'DNA-bearing items.',
    }),
    Object.freeze({
      id: 'persons.weapons-instruments',
      label: 'Weapons / Instruments of the Crime',
      body:
        'Any firearms, ammunition, expended cartridge casings, bullets, ' +
        'knives, and any other instruments that appear to have been used ' +
        'in the commission of the crime.',
    }),
    Object.freeze({
      id: 'persons.latent-evidence',
      label: 'Latent Evidence',
      body:
        'Any latent evidence, including fingerprints, footprints, tool ' +
        'marks, and impression evidence.',
    }),
    Object.freeze({
      id: 'persons.vehicles-clothing',
      label: 'Vehicles & Clothing',
      body:
        'Any vehicles belonging to the suspect(s), victim(s), witness(es) ' +
        'and/or involved party(ies); all clothing associated with the ' +
        'crime.',
    }),
    Object.freeze({
      id: 'persons.catchall',
      label: 'Catch-all Evidence Clause',
      body:
        'Any other evidence associated with or tending to show the ' +
        'commission of the crime(s) under investigation.',
    }),
  ]),

  sopcScaffold: Object.freeze([
    Object.freeze({ heading: 'Initial Report / Dispatch',         body: '' }),
    Object.freeze({ heading: 'On-Scene Observations',             body: '' }),
    Object.freeze({ heading: 'Victim / Witness Statements',       body: '' }),
    Object.freeze({ heading: 'Suspect Identification',            body: '' }),
    Object.freeze({ heading: 'Premises Nexus',                    body: '' }),
    Object.freeze({ heading: 'Conclusion',                        body: '' }),
  ]),

  lastReviewed: LAST_REVIEWED,
});

// ─── Property Crime ────────────────────────────────────────────────────────
const PROPERTY = Object.freeze({
  id: 'property',
  label: 'Property Crime',
  legacyAliases: ['pc 459', 'pc 530', 'pc 470', 'pc 484', 'pc 487', 'pc 496'],
  description:
    'Property and financial offences: residential burglary (PC 459), ' +
    'identity theft (PC 530.5), forgery (PC 470), grand theft (PC 487), ' +
    'receiving stolen property (PC 496), and fraud schemes targeting ' +
    'accounts, cards, or checks.',
  defaultOffenses: Object.freeze([
    Object.freeze({ code: 'PC 530.5', label: 'Identity Theft' }),
  ]),

  pc1524Grounds: _grounds({
    stolen: true,
    felonyMeans: true,
    evidenceOfFelony: true,
  }),

  defaultOptionalClauses: Object.freeze({
    offsiteComputerSearch: true,
    authorityToDuplicate: true,
    returnExtension: false,
    nightService:  Object.freeze({ enabled: false, justification: '' }),
    hobbsSealing:  Object.freeze({ enabled: false, justification: '' }),
    statutoryGroundsRecap: true,
  }),

  trainingExperiencePreset:
    'Your affiant has received specialised training in the investigation ' +
    'of property and financial crimes, including residential burglary, ' +
    'identity theft, forgery, grand theft, and receiving stolen property. ' +
    'Your affiant is familiar with the methods used by suspects to ' +
    'unlawfully obtain victims\u2019 personal identifying information, ' +
    'open or compromise financial accounts, fabricate or alter identity ' +
    'documents, and convert proceeds into property and currency.\n\n' +
    'Based on training and experience, your affiant knows that persons ' +
    'committing identity theft and related fraud offences commonly ' +
    'maintain at their residences: (a) records of victim accounts ' +
    'including statements, correspondence, and account numbers; (b) ' +
    'identification documents (driver\u2019s licences, social-security ' +
    'cards, credit cards) not bearing the names of the parties found at ' +
    'the location; (c) computers, printers, scanners, and software used ' +
    'to fabricate or alter identity and financial documents; (d) checks, ' +
    'receipts, and merchant agreements documenting fraudulent ' +
    'transactions; and (e) property acquired with the proceeds of the ' +
    'fraud.',

  itemsToSeize: Object.freeze([
    Object.freeze({
      id: 'property.account-records',
      label: 'Victim Account Records',
      body:
        'All records pertaining to the victim accounts identified in ' +
        'the Statement of Probable Cause, including but not limited to ' +
        'account statements, correspondence, applications, contracts, ' +
        'and any other records which reveal or are believed to reveal ' +
        'unauthorised use of the victim\u2019s identifying information.',
    }),
    Object.freeze({
      id: 'property.electronic-devices',
      label: 'Electronic Devices',
      body:
        'Any and all computers, laptops, computer towers, modems, ' +
        'storage devices, cellular telephone(s), smart phone(s), ' +
        'computer tablet(s) with a cellular network radio, wireless ' +
        'computer modem device(s) with a cellular network radio, ' +
        'computer(s) with a wireless modem device with a cellular ' +
        'network radio, SIM card(s), and any digital media storage ' +
        'device that is capable of connecting to the previously ' +
        'described devices, either physically or wirelessly.',
    }),
    Object.freeze({
      id: 'property.fake-ids',
      label: 'False Identification / Counterfeit Instruments',
      body:
        'Any documents, checks, credit cards, driver\u2019s licences, or ' +
        'other identification not bearing the true names of the parties ' +
        'found inside the location, and any wallets or purses containing ' +
        'such items. Any and all computers, printers, scanners and their ' +
        'peripherals which may have been used to facilitate the crime.',
    }),
    Object.freeze({
      id: 'property.fraud-records',
      label: 'Fraud-Related Records',
      body:
        'Phone accounts relating to the crime of identity theft, forgery, ' +
        'or grand theft; receipts or copies of transactions or accounts ' +
        'opened in the name of the victim(s); any property acquired by ' +
        'using the victim\u2019s name or account information; credit card ' +
        'invoices or drafts whether blank or filled in, merchant ' +
        'agreements, credit card account numbers in any form, credit card ' +
        'imprinters, and contracts with financial institutions.',
    }),
    Object.freeze({
      id: 'property.proceeds',
      label: 'Proceeds / Acquired Property',
      body:
        'Personal checks and/or receipts showing purchases of vehicles, ' +
        'household items, clothing items, or other personal items. ' +
        'Vehicles, household items, cellular phones, and other personal ' +
        'items obtained with credit cards and/or personal checks not ' +
        'bearing the names or legitimate account numbers of the parties ' +
        'found within the location.',
    }),
    Object.freeze({
      id: 'property.dominion-control',
      label: 'Articles of Personal Property (Dominion & Control)',
      body:
        'Any articles of personal property tending to establish the ' +
        'identity of persons in control of premises, vehicles, storage ' +
        'areas, and containers being searched, consisting of but not ' +
        'limited to utility-company receipts, rent receipts, addressed ' +
        'envelopes, and keys.',
    }),
  ]),

  sopcScaffold: Object.freeze([
    Object.freeze({ heading: 'Initial Victim Report / Loss Report',  body: '' }),
    Object.freeze({ heading: 'Records Pull (Financial Institutions)', body: '' }),
    Object.freeze({ heading: 'IP / Device / Account Attribution',     body: '' }),
    Object.freeze({ heading: 'Suspect Identification',                body: '' }),
    Object.freeze({ heading: 'Premises Nexus',                        body: '' }),
    Object.freeze({ heading: 'Conclusion',                            body: '' }),
  ]),

  lastReviewed: LAST_REVIEWED,
});

// ─── Registry ──────────────────────────────────────────────────────────────
const PRESETS = Object.freeze({
  csam:      CSAM,
  narcotics: NARCOTICS,
  persons:   PERSONS,
  property:  PROPERTY,
});

const PRESET_IDS = Object.freeze(['csam', 'narcotics', 'persons', 'property']);

// ─── Helpers ───────────────────────────────────────────────────────────────

/** True iff `id` is a known crime preset id. Case-insensitive on aliases. */
function isKnownId(id) {
  if (!id || typeof id !== 'string') return false;
  return PRESET_IDS.includes(id);
}

/** Get a preset by id; returns null if unknown. */
function get(id) {
  return PRESETS[id] || null;
}

/** Resolve legacy aliases ('cp' -> 'csam'). */
function resolveAlias(label) {
  if (!label || typeof label !== 'string') return null;
  const lc = label.trim().toLowerCase();
  if (PRESET_IDS.includes(lc)) return lc;
  for (const id of PRESET_IDS) {
    if (PRESETS[id].legacyAliases.some(a => a.toLowerCase() === lc)) return id;
  }
  return null;
}

/** Public list of {id, label, description} for UI dropdowns. */
function listForPicker() {
  return PRESET_IDS.map(id => ({
    id,
    label: PRESETS[id].label,
    description: PRESETS[id].description,
  }));
}

/**
 * Build a deep-cloned `residential` substructure prefilled from the given
 * preset id. Falls back to an empty shell when id is unknown. The returned
 * object is plain-mutable so the caller may immediately overlay user input.
 *
 * Items-to-Seize is materialised as { mode: 'preset', blocks: [{id,label,body}] }
 * so future edits are tracked at the block level without losing the
 * original preset id.
 */
function buildResidentialFromPreset(id) {
  const preset = get(id);
  if (!preset) {
    return {
      crimeType: '',
      crimePresetId: '',
      offenses: [],
      premises: { address: '', legalDescription: '', includeScopeBoilerplate: true },
      suspects: [],
      itemsToSeize: { mode: 'preset', blocks: [] },
      trainingExperience: { mode: 'profile', inlineBody: '' },
      sopc: { sections: [] },
      optionalClauses: {
        offsiteComputerSearch: false,
        authorityToDuplicate: false,
        returnExtension: false,
        nightService: { enabled: false, justification: '' },
        hobbsSealing: { enabled: false, justification: '' },
        statutoryGroundsRecap: true,
      },
      itemsIncorporatedByReference: true,
      executedAt: { city: '', date: '', time: '', timeAmPm: 'PM' },
    };
  }
  return {
    crimeType: preset.id,
    crimePresetId: preset.id,
    offenses: preset.defaultOffenses.map(o => ({ code: o.code, label: o.label })),
    premises: { address: '', legalDescription: '', includeScopeBoilerplate: true },
    suspects: [],
    itemsToSeize: {
      mode: 'preset',
      blocks: preset.itemsToSeize.map(b => ({ id: b.id, label: b.label, body: b.body })),
    },
    trainingExperience: {
      mode: 'profile',
      inlineBody: preset.trainingExperiencePreset,
    },
    sopc: {
      sections: preset.sopcScaffold.map(s => ({ heading: s.heading, body: s.body })),
    },
    optionalClauses: {
      offsiteComputerSearch: !!preset.defaultOptionalClauses.offsiteComputerSearch,
      authorityToDuplicate:  !!preset.defaultOptionalClauses.authorityToDuplicate,
      returnExtension:       !!preset.defaultOptionalClauses.returnExtension,
      nightService: {
        enabled:       !!preset.defaultOptionalClauses.nightService.enabled,
        justification: preset.defaultOptionalClauses.nightService.justification || '',
      },
      hobbsSealing: {
        enabled:       !!preset.defaultOptionalClauses.hobbsSealing.enabled,
        justification: preset.defaultOptionalClauses.hobbsSealing.justification || '',
      },
      statutoryGroundsRecap: !!preset.defaultOptionalClauses.statutoryGroundsRecap,
    },
    itemsIncorporatedByReference: true,
    executedAt: { city: '', date: '', time: '', timeAmPm: 'PM' },
  };
}

/**
 * Returns the PC 1524 grounds toggles a preset suggests. Callers should
 * overlay these onto `draft.pc1524Grounds` when the user picks/changes
 * crime type.
 */
function pc1524GroundsFor(id) {
  const p = get(id);
  if (!p) return _grounds();
  return Object.assign({}, p.pc1524Grounds);
}

// ─── Exports ───────────────────────────────────────────────────────────────

const api = Object.freeze({
  SCHEMA_VERSION,
  LAST_REVIEWED,
  PRESET_IDS,
  PRESETS,
  PC1524_KEYS,
  get,
  isKnownId,
  resolveAlias,
  listForPicker,
  buildResidentialFromPreset,
  pc1524GroundsFor,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.WarrantAuthorCrimePresets = api;
}

})();
