// modules/warrant-author/boilerplate-library.js
// ─────────────────────────────────────────────────────────────────────────────
// Curated boilerplate library for the Warrant Author. ~50 vetted paragraphs
// covering CalECPA stock clauses, training-and-experience, evidence
// rationales, technical primers, and provider-specific quirks. Pure data —
// no I/O, no DOM. Consumed by:
//   • the authoring UI (P6) to populate the "Insert boilerplate" picker;
//   • the template engine (P4) when a slot wants a clause-by-id; and
//   • the validator (P7) to check "PC narrative is empty / Hobbs requested
//     but no Hobbs justification present".
//
// Paragraph shape:
//   {
//     id:           '<category>.<key>'             // globally unique
//     category:     'stock-clause' | 'training-experience' |
//                   'evidence-rationale' | 'technical-primer' |
//                   'provider-specific' | 'procedural'
//     key:          short-key                       // unique within category
//     title:        UI-facing short label
//     body:         the actual paragraph text (may contain {{slot}} refs)
//     tags:         string[]                        // for filter chips
//     jurisdiction: 'CA' | 'US-FEDERAL' | 'ANY'
//     legalBasis:   citation hint, optional
//     lastReviewed: ISO date the user's exemplar pack last vetted this
//   }
//
// Override storage (renderer-side):
//   localStorage.viperWarrantAuthorBoilerplate = {
//     overrides: { '<id>': { body, title? } },     // per-paragraph deltas
//     custom:    [{ id, category, key, title, body, tags, ... }, ...],
//     hidden:    [ '<id>', ... ]                   // shipped IDs the agency
//                                                  // chose to hide
//   }
//
// Override semantics (mirrors provider-directory.js P2 pattern):
//   • Editing a shipped paragraph stores ONLY changed fields in overrides.
//     Future shipped-content updates flow through for untouched fields.
//   • Hidden shipped paragraphs disappear from listing but are restorable.
//   • Custom paragraphs live independently; IDs must not collide with
//     shipped IDs (the renderer guards this at create-time).
//
// Compliance note:
//   • Per first-run modal: "The shipped boilerplate has not been reviewed
//     by your jurisdiction's prosecutor. Review with your DA before
//     serving any warrant." Every shipped paragraph carries a
//     `lastReviewed` date so agencies can spot stale content.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// IIFE wrapper — coexists with agency-profile / provider-directory /
// items-taxonomy / template-engine in the renderer's shared scope.
(function () {

const SCHEMA_VERSION = 1;

// ─── CATEGORIES ────────────────────────────────────────────────────────────
const CATEGORIES = Object.freeze([
  Object.freeze({ id: 'stock-clause',        label: 'Stock Clauses (CalECPA / NDO)' }),
  Object.freeze({ id: 'training-experience', label: 'Training & Experience' }),
  Object.freeze({ id: 'evidence-rationale',  label: 'Evidence Rationale' }),
  Object.freeze({ id: 'technical-primer',    label: 'Technical Primers' }),
  Object.freeze({ id: 'provider-specific',   label: 'Provider-Specific' }),
  Object.freeze({ id: 'procedural',          label: 'Procedural Clauses' }),
]);

// ─── SHIPPED PARAGRAPHS ────────────────────────────────────────────────────
// All paragraphs are vetted against the user's exemplar pack (2025-Q4).
// Each `body` is plain text with optional {{slot}} placeholders that the
// template engine substitutes at compose time. Slot syntax matches
// template-engine.js: {{path.to.value}} or {{path | upper}}.
const SHIPPED_PARAGRAPHS = Object.freeze([

  // ═══════════════════════════════════════════════════════════════════════
  // stock-clause (5) — VERBATIM CalECPA + NDO clauses
  // These mirror what template-engine ships in the CA addendum template,
  // but live here too so the affidavit narrative can quote them
  // verbatim when needed (e.g. "Section 1546.1(d)(3) requires …").
  // ═══════════════════════════════════════════════════════════════════════

  Object.freeze({
    id: 'stock-clause.calecpa-1546-1-d2',
    category: 'stock-clause',
    key: 'calecpa-1546-1-d2',
    title: 'CalECPA \u00a71546.1(d)(2) — Authenticity Certification',
    body: 'Pursuant to California Penal Code \u00a71546.1(d)(2), the records, information, documents, and items produced in response to this warrant shall be accompanied by an authenticated declaration from the custodian of records or other qualified person stating: (a) that the records are true and accurate copies of business records made at or near the time of the events described by, or from information transmitted by, a person with knowledge; (b) that the records were kept in the course of a regularly conducted business activity; and (c) that the making of the records was a regular practice of that business activity. The declaration shall be executed under penalty of perjury and shall be sufficient to satisfy the foundational requirements of Evidence Code \u00a7\u00a7 1271 and 1561.',
    tags: ['calecpa', 'authenticity', 'verbatim'],
    jurisdiction: 'CA',
    legalBasis: 'Penal Code \u00a71546.1(d)(2); Evidence Code \u00a7\u00a7 1271, 1561',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'stock-clause.calecpa-1546-1-d3',
    category: 'stock-clause',
    key: 'calecpa-1546-1-d3',
    title: 'CalECPA \u00a71546.1(d)(3) — Sealing of Returned Records',
    body: 'Pursuant to California Penal Code \u00a71546.1(d)(3), all records, information, documents, and items received in response to this warrant shall be sealed by the affiant and shall not be opened, reviewed, or disclosed to any person other than the affiant, the issuing court, and law-enforcement personnel directly involved in this investigation, except by further order of the court. The affiant shall maintain custody of the sealed return until disposition of the underlying case or further order of this court.',
    tags: ['calecpa', 'sealing', 'verbatim'],
    jurisdiction: 'CA',
    legalBasis: 'Penal Code \u00a71546.1(d)(3)',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'stock-clause.ndo-base-90-day',
    category: 'stock-clause',
    key: 'ndo-base-90-day',
    title: '90-Day Non-Disclosure Order (NDO base) — Penal Code \u00a71546.2(b)',
    body: 'Pursuant to California Penal Code \u00a71546.2(b), the Court FINDS that there is reason to believe that notification of the existence of this warrant to the subscriber, user, or any third party would result in: (i) endangering the life or physical safety of an individual; (ii) flight from prosecution; (iii) destruction of or tampering with evidence; (iv) intimidation of potential witnesses; or (v) otherwise seriously jeopardizing an investigation or unduly delaying a trial. IT IS THEREFORE ORDERED that {{provider.legalEntity}}, its officers, employees, and agents shall not disclose the existence of this warrant, the records produced in response, or the investigation of which this warrant is a part, to the subscriber, user, or any third party other than counsel for {{provider.legalEntity}}, for a period of ninety (90) days from the date of this order.',
    tags: ['ndo', 'calecpa', 'verbatim'],
    jurisdiction: 'CA',
    legalBasis: 'Penal Code \u00a71546.2(b)',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'stock-clause.ndo-info-support',
    category: 'stock-clause',
    key: 'ndo-info-support',
    title: 'NDO Supporting Information (CSAM / safety extension)',
    body: 'Notification of the subscriber would seriously jeopardize this investigation because the suspect is known to monitor electronic communications, use end-to-end-encrypted channels, and coordinate with co-conspirators who would be alerted by any account-side notification. Premature disclosure would (i) cause immediate deletion of remaining stored content, including content that constitutes evidence of the charged offense; (ii) tip co-offenders who share access to the target account or who communicate with the target user across multiple ESPs; and (iii) in cases involving child victims, materially increase the risk of additional victimization while the investigation is pending. Based on these specific facts, the affiant requests that the non-disclosure period set forth above be ordered.',
    tags: ['ndo', 'csam', 'safety', 'optional'],
    jurisdiction: 'ANY',
    legalBasis: 'Penal Code \u00a71546.2(b); 18 U.S.C. \u00a72705(b)',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'stock-clause.delay-1546-2a',
    category: 'stock-clause',
    key: 'delay-1546-2a',
    title: 'Delay of Notice — Penal Code \u00a71546.2(a)',
    body: 'Pursuant to Penal Code \u00a71546.2(a), the affiant shall serve a copy of this warrant on the subscriber, user, or person whose information was the target of this warrant within three (3) days of the expiration of the ninety-day delay-of-notice period set forth above, unless an extension of the delay period has been granted by this Court.',
    tags: ['calecpa', 'delay-of-notice', 'verbatim'],
    jurisdiction: 'CA',
    legalBasis: 'Penal Code \u00a71546.2(a)',
    lastReviewed: '2025-12-01',
  }),

  // ═══════════════════════════════════════════════════════════════════════
  // training-experience (7) — one paragraph per common case type
  // The affiant snapshot block ships agency-side defaults; these are the
  // case-type-specific add-ons the author selects when the case fits.
  // ═══════════════════════════════════════════════════════════════════════

  Object.freeze({
    id: 'training-experience.icac',
    category: 'training-experience',
    key: 'icac',
    title: 'Training & Experience — ICAC (Internet Crimes Against Children)',
    body: 'Your affiant is assigned to the {{agency.affiantUnit}} and is a sworn peace officer with the {{agency.agencyName}}. In that capacity, your affiant has investigated crimes involving the online exploitation of children, including the production, distribution, and possession of child sexual abuse material (CSAM); the use of social-media platforms, chat applications, and gaming platforms to groom and entice minors; and the use of peer-to-peer file-sharing networks to trade contraband imagery. Your affiant has received training from the Internet Crimes Against Children (ICAC) Task Force Program, including courses on the National Center for Missing & Exploited Children (NCMEC) CyberTipline workflow, investigative response to CSAM, undercover online communications, mobile-device forensics, and electronic-evidence handling. Your affiant has personally executed and assisted in the execution of search warrants on residences, computers, mobile devices, and Electronic Communication Service providers in furtherance of these investigations.',
    tags: ['training', 'icac', 'csam', 'unit-specific'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'training-experience.narcotics',
    category: 'training-experience',
    key: 'narcotics',
    title: 'Training & Experience — Narcotics',
    body: 'Your affiant has investigated narcotics-trafficking offenses including the sale, transportation, and possession for sale of controlled substances. Your affiant has received training in narcotics identification, controlled-substance investigations, undercover purchases, confidential-informant management, and the use of electronic communications by traffickers to coordinate sales, arrange meetings, and launder proceeds. Your affiant knows from training and experience that narcotics traffickers commonly use cellular telephones, encrypted messaging applications, social-media platforms, and peer-to-peer payment services to facilitate their offenses, and that records of such use are preserved by Electronic Communication Service providers and financial institutions.',
    tags: ['training', 'narcotics', 'communications'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'training-experience.robbery',
    category: 'training-experience',
    key: 'robbery',
    title: 'Training & Experience — Robbery / Theft',
    body: 'Your affiant has investigated robbery, burglary, and organized-theft offenses, including takeover robberies of commercial establishments, residential burglaries, and organized retail theft. Your affiant has received training in robbery investigation, suspect identification through surveillance video and digital evidence, the use of cell-site records to corroborate suspect movement, and the use of social-media and peer-to-peer payment records to identify proceeds and co-conspirators. Your affiant knows from training and experience that robbery suspects commonly coordinate offenses by cellular telephone and social media before, during, and after the offense; that they exchange photographs and video of the offense or its proceeds; and that records of such communications are preserved by Electronic Communication Service providers.',
    tags: ['training', 'robbery', 'theft', 'cell-site'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'training-experience.homicide',
    category: 'training-experience',
    key: 'homicide',
    title: 'Training & Experience — Homicide',
    body: 'Your affiant has investigated homicides and assaults causing great bodily injury, including the use of digital evidence to establish suspect identification, motive, opportunity, and the contemporaneous location of the suspect, the victim, and witnesses. Your affiant has received training in homicide investigation, digital-evidence acquisition, the use of cell-site location information and call-detail records, and the use of social-media communications to establish motive and corroborate witness statements. Your affiant knows from training and experience that homicide suspects commonly communicate with co-conspirators, witnesses, or the victim before and after the offense by cellular telephone and electronic messaging; that they research the victim, the offense location, or evasion techniques using internet-search providers; and that such records are preserved by Electronic Communication Service providers.',
    tags: ['training', 'homicide', 'cell-site', 'csli'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'training-experience.fraud',
    category: 'training-experience',
    key: 'fraud',
    title: 'Training & Experience — Fraud / Financial',
    body: 'Your affiant has investigated financial-fraud offenses including identity theft, access-device fraud, wire fraud, romance and confidence-scheme fraud, business email compromise, and money laundering. Your affiant has received training in financial-investigation methodology, tracing of electronic funds, peer-to-peer payment platforms (including Venmo, PayPal, Zelle, and Cash App), bank-record analysis, and the use of cellular and electronic communications by fraud suspects to recruit victims, coordinate co-conspirators, and launder proceeds. Your affiant knows from training and experience that financial-fraud suspects rely heavily on electronic communications and electronic payment systems and that records of those communications and transactions are preserved by Electronic Communication Service providers and financial institutions.',
    tags: ['training', 'fraud', 'financial', 'payments'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'training-experience.missing-person',
    category: 'training-experience',
    key: 'missing-person',
    title: 'Training & Experience — Missing Person / Abduction',
    body: 'Your affiant has investigated missing-person and child-abduction cases including parental abduction, stranger abduction, runaway juveniles at risk, and adult missing persons under suspicious circumstances. Your affiant has received training in missing-person response, AMBER Alert criteria, juvenile-runaway investigation, and the use of digital evidence to establish the missing person\u2019s last known location, contacts, and movements. Your affiant knows from training and experience that missing persons commonly use cellular telephones, social media, and messaging applications to communicate with family, friends, and (in cases of luring or coercion) suspect contacts; that such communications are preserved by Electronic Communication Service providers; and that cell-site location information and IP-history records can establish the last known location of the missing person\u2019s account access.',
    tags: ['training', 'missing-person', 'csli', 'location'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'training-experience.child-exploitation',
    category: 'training-experience',
    key: 'child-exploitation',
    title: 'Training & Experience — Child Exploitation (broader than CSAM)',
    body: 'Your affiant has investigated crimes against children including online enticement, sextortion, sex trafficking of minors, and contact and non-contact sexual offenses against children. Your affiant has received training in child-victim interviewing, forensic interviewing protocols, the dynamics of grooming and sextortion, the trafficking of minors via online platforms, and the role of Electronic Communication Service providers in storing the records that document these offenses. Your affiant knows from training and experience that offenders against children commonly use multiple ESPs in tandem \u2014 e.g., a public-facing social-media platform to identify and groom the victim, followed by a private-messaging or encrypted-chat application to escalate the contact, followed by a peer-to-peer payment platform to extort or to compensate the victim \u2014 and that records of each step are preserved by the relevant providers.',
    tags: ['training', 'child-exploitation', 'csam', 'sextortion'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  // ═══════════════════════════════════════════════════════════════════════
  // evidence-rationale (7) — "why each evidence type matters"
  // These are slotted into the PC narrative just before the
  // items-to-seize list so the magistrate sees the connection between
  // the requested records and the offense under investigation.
  // ═══════════════════════════════════════════════════════════════════════

  Object.freeze({
    id: 'evidence-rationale.content',
    category: 'evidence-rationale',
    key: 'content',
    title: 'Why content (messages, media) matters',
    body: 'Stored communications content — including private messages, direct messages, group chats, voice messages, and uploaded media — is direct evidence of the communications between the suspect and other persons relevant to this investigation. Such content is uniquely capable of establishing the speaker\u2019s identity, the speaker\u2019s knowledge of the offense, the existence of any conspiracy, and the contemporaneous relationship between the suspect and the victim or co-conspirators. Without the content of these communications, the available metadata reveals only that communications occurred; it does not reveal the substance of those communications, which is necessary to corroborate the charged offense.',
    tags: ['evidence', 'content', 'pc-narrative'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'evidence-rationale.metadata',
    category: 'evidence-rationale',
    key: 'metadata',
    title: 'Why metadata (account, login, device) matters',
    body: 'Account metadata \u2014 including subscriber information, account-creation date, account-status history, recovery email and telephone numbers, and stored devices and applications \u2014 is necessary to establish the identity of the person controlling the target account, to distinguish the target user from any other user who may have shared access, and to corroborate independent leads (e.g., a recovery telephone number that matches a known suspect device). Without this metadata, the affiant cannot reliably tie the conduct documented in the account to the suspect.',
    tags: ['evidence', 'metadata', 'subscriber'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'evidence-rationale.location',
    category: 'evidence-rationale',
    key: 'location',
    title: 'Why location data (GPS, geotags) matters',
    body: 'Location data preserved by the provider \u2014 including GPS coordinates embedded in uploaded media, location-history records, check-ins, and IP-derived geolocation \u2014 places the target account, and through it the target user, at specific geographic locations at specific times. This evidence is necessary to corroborate independent witness statements, to disprove alibi, and to establish the suspect\u2019s presence at the offense location at or near the time of the offense. The location records preserved by the provider cannot be obtained from any other source and are not duplicative of records sought from cellular carriers.',
    tags: ['evidence', 'location', 'geolocation', 'gps'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'evidence-rationale.photos',
    category: 'evidence-rationale',
    key: 'photos',
    title: 'Why stored photos and video matter',
    body: 'Photographs and video stored in the target account are necessary because such media frequently depict the offense, its planning, its proceeds, or its aftermath; because such media frequently bear EXIF metadata establishing when and where the media was captured; and because suspects routinely transfer media between devices via cloud-storage and messaging providers in a way that leaves an evidentiary record only at the provider. Without the stored media, the affiant cannot establish the suspect\u2019s knowledge, intent, or possession of contraband.',
    tags: ['evidence', 'media', 'photos', 'exif'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'evidence-rationale.ip-logs',
    category: 'evidence-rationale',
    key: 'ip-logs',
    title: 'Why IP logs matter',
    body: 'Internet Protocol address logs preserved by the provider \u2014 documenting every IP address used to access or authenticate to the target account during the date range, with associated timestamps in UTC \u2014 are necessary to establish the physical location and internet-service-provider account from which the target account was operated. Cross-referencing these IP records with separately-served subscriber records from the relevant internet service provider permits identification of the physical premises (and through it the natural person) responsible for the account activity. This bridging step is foundational to ESP-warrant investigations and cannot be accomplished without the IP records.',
    tags: ['evidence', 'ip', 'subscriber-bridge'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'evidence-rationale.payment',
    category: 'evidence-rationale',
    key: 'payment',
    title: 'Why payment / billing records matter',
    body: 'Payment and billing records associated with the target account \u2014 including credit-card numbers, bank routing and account numbers, peer-to-peer payment accounts, and billing addresses \u2014 are necessary to corroborate the identity of the account holder, to trace the financial proceeds of the charged offense, and to identify additional accounts under the suspect\u2019s control. Payment records frequently bear billing addresses and telephone numbers that match (or contradict) the subscriber information provided by the suspect to other providers, providing a high-confidence basis for cross-platform identification.',
    tags: ['evidence', 'payment', 'billing', 'financial'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'evidence-rationale.multimedia',
    category: 'evidence-rationale',
    key: 'multimedia',
    title: 'Why multimedia metadata (EXIF) matters',
    body: 'Multimedia metadata \u2014 EXIF tags, capture timestamps, GPS coordinates, device-model identifiers, and provider-side content-moderation labels \u2014 is necessary to establish provenance, dating, and location of media stored in the target account. EXIF data frequently establishes that media was captured by a specific physical device (model + serial number) and at a specific time and location. Where the suspect\u2019s device is later seized, the EXIF data preserved by the provider permits cross-validation between the provider\u2019s record and the on-device record, defeating claims of fabrication or tampering.',
    tags: ['evidence', 'metadata', 'exif', 'multimedia'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  // ═══════════════════════════════════════════════════════════════════════
  // technical-primer (5) — magistrate-facing explanations
  // Used in PC narrative when the affidavit relies on a technical concept
  // (CGNAT, Tor, VPN, ESP behavior, encryption).
  // ═══════════════════════════════════════════════════════════════════════

  Object.freeze({
    id: 'technical-primer.ip-cgnat',
    category: 'technical-primer',
    key: 'ip-cgnat',
    title: 'Technical Primer — IP, CGNAT, and ISP records',
    body: 'An Internet Protocol (IP) address is a numeric identifier assigned to a device or network for the purpose of routing internet traffic. Public IP addresses are assigned by internet service providers (ISPs) to subscriber accounts. By comparing the IP address logged by the ESP against the lease records held by the relevant ISP, investigators can identify the subscriber account, and through it the physical premises, from which the ESP account was accessed at a given time. Carrier-Grade Network Address Translation (CGNAT) is a technique used by some carriers (especially mobile carriers) in which many subscribers share a single public IP address simultaneously. Where CGNAT is in use, the public IP alone is insufficient and must be paired with the source port number and a precise timestamp to identify the specific subscriber. The affiant has accordingly requested both the IP address and (where available) the source port for each access event.',
    tags: ['primer', 'ip', 'cgnat', 'isp'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'technical-primer.tor',
    category: 'technical-primer',
    key: 'tor',
    title: 'Technical Primer — The Tor Network',
    body: 'The Tor network ("The Onion Router") is an anonymity overlay network that routes a user\u2019s internet traffic through three randomly-selected relay nodes, with each layer of the connection encrypted such that no single relay knows both the originating user and the destination service. When a user accesses an ESP account through Tor, the public IP address logged by the ESP is the IP of the Tor "exit node" rather than the user\u2019s true IP. The Tor network is operated by volunteers worldwide; exit-node operators do not typically retain records of which user routed which traffic. Where the affiant observes Tor-exit IP addresses in the IP-history of the target account, the affiant has noted that fact and has requested the additional records (e.g., device fingerprints, recovery email/phone) that can identify the user notwithstanding the Tor overlay.',
    tags: ['primer', 'tor', 'anonymity'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'technical-primer.vpn-proxy',
    category: 'technical-primer',
    key: 'vpn-proxy',
    title: 'Technical Primer — VPN and Proxy Services',
    body: 'A Virtual Private Network (VPN) or proxy service is a third-party internet-service provider that routes the user\u2019s traffic through the provider\u2019s servers, such that the public IP address logged by the destination ESP is the VPN/proxy provider\u2019s IP rather than the user\u2019s true IP. Many VPN providers advertise that they retain no logs of user activity; however, even no-logging providers may retain billing records, account-creation records, and IP-address-pool assignments sufficient to identify the user. Where the affiant observes VPN- or proxy-associated IPs in the IP-history of the target account, the affiant has identified the VPN provider and either has separately served records on that provider or has identified the absence of such records as a known investigative limit.',
    tags: ['primer', 'vpn', 'proxy', 'no-logs'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'technical-primer.esp-behavior',
    category: 'technical-primer',
    key: 'esp-behavior',
    title: 'Technical Primer — How ESPs Store Records',
    body: 'Electronic Communication Service (ESP) providers ordinarily retain (a) account-subscriber records for the life of the account plus a defined retention period after closure; (b) communications content for a provider-specific retention period (which may be very short for ephemeral platforms such as Snapchat or Discord, or essentially indefinite for mail providers); (c) IP-history and device-history records for a defined retention period typically measured in months; and (d) billing and payment-instrument records for the life of the account. Many ESPs honor preservation requests served under 18 U.S.C. \u00a72703(f) or California Penal Code \u00a71546.1(c), extending the retention of relevant records during the investigation. The affiant has served such a preservation request on each provider named in this warrant where applicable.',
    tags: ['primer', 'esp', 'retention', 'preservation'],
    jurisdiction: 'ANY',
    legalBasis: '18 U.S.C. \u00a72703(f); Penal Code \u00a71546.1(c)',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'technical-primer.encryption-general',
    category: 'technical-primer',
    key: 'encryption-general',
    title: 'Technical Primer — End-to-End Encryption',
    body: 'End-to-end encryption (E2EE) is a class of cryptographic protocol in which the content of a communication is encrypted on the sending device and decrypted only on the recipient\u2019s device, such that even the provider transporting the message cannot read its contents. Providers offering E2EE chat (e.g., WhatsApp, Signal, iMessage, Discord DM with the encryption setting enabled) typically still retain metadata about the communication \u2014 sender identifier, recipient identifier, timestamp, duration, contact graph, and (in some cases) message size and provider-side moderation labels \u2014 and may retain content for unencrypted backup copies stored in cloud-backup services. The affiant has therefore requested both the metadata directly held by the ESP and (where applicable) the cloud-backup contents held by the operating-system provider.',
    tags: ['primer', 'encryption', 'e2ee', 'metadata'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  // ═══════════════════════════════════════════════════════════════════════
  // provider-specific (6) — quirks worth flagging to the magistrate
  // ═══════════════════════════════════════════════════════════════════════

  Object.freeze({
    id: 'provider-specific.google-geofence',
    category: 'provider-specific',
    key: 'google-geofence',
    title: 'Google Geofence / Location History — Sensorvault',
    body: 'Google LLC retains a granular per-device location history for Android users who have enabled the "Location History" account setting. This history is centralized in a system Google has internally referred to as "Sensorvault" and contains latitude/longitude points sampled at frequent intervals, each tagged with a confidence radius and a source (GPS / Wi-Fi / cell). The affiant has explicitly requested this Location History data for the target account during the date range described above, because it provides a uniquely granular record of the target user\u2019s movements that is not available from any cellular carrier and that materially corroborates the offense conduct described in this affidavit.',
    tags: ['provider', 'google', 'location', 'sensorvault'],
    jurisdiction: 'ANY',
    legalBasis: 'See Carpenter v. United States, 138 S. Ct. 2206 (2018)',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'provider-specific.apple-icloud',
    category: 'provider-specific',
    key: 'apple-icloud',
    title: 'Apple iCloud — Encrypted Backups & Advanced Data Protection',
    body: 'Apple Inc. ordinarily retains, for the target iCloud account, (a) account-subscriber records; (b) iCloud Mail contents; (c) device-backup contents (which include application data for installed apps, including messaging apps); (d) iCloud Photo Library contents; (e) iCloud Drive contents; and (f) Find My device records. Where the target user has enabled "Advanced Data Protection," certain categories of iCloud content are end-to-end encrypted and are not accessible to Apple in plaintext. The affiant has requested all categories of records that Apple can provide for the target account and has separately requested any backups that pre-date the activation of Advanced Data Protection, where applicable.',
    tags: ['provider', 'apple', 'icloud', 'e2ee'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'provider-specific.snapchat-ephemeral',
    category: 'provider-specific',
    key: 'snapchat-ephemeral',
    title: 'Snapchat \u2014 Ephemeral Messaging and Memories Backups',
    body: 'Snap Inc. offers a service ("Snapchat") in which images and short videos called "Snaps" are ordinarily deleted shortly after they are viewed by the recipient. However, Snap Inc. retains records of the metadata of every Snap sent and received \u2014 including sender, recipient, and timestamp \u2014 for a defined retention period. Snap Inc. also retains the full content of any Snap or chat message the user has elected to save to a feature called "Memories" or "My Eyes Only," which functions as a cloud backup. The affiant has requested both the metadata of all Snaps sent and received and the contents of any Memories / My Eyes Only material for the target account.',
    tags: ['provider', 'snapchat', 'ephemeral', 'memories'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'provider-specific.discord-encryption',
    category: 'provider-specific',
    key: 'discord-encryption',
    title: 'Discord \u2014 Server and DM Records',
    body: 'Discord Inc. operates a messaging and voice-chat platform organized around user-created "servers" (in addition to direct messages and group DMs). Discord ordinarily retains, for each target account, (a) subscriber records; (b) the contents of all direct messages and group DMs; (c) the contents of messages posted in any server the user has joined; (d) IP-history records; (e) connected-account records (e.g., linked PayPal, Steam, Spotify); and (f) records of any moderation actions taken against the account. The affiant has requested all of these categories for the target account during the date range described.',
    tags: ['provider', 'discord', 'messaging'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'provider-specific.telecom-csli',
    category: 'provider-specific',
    key: 'telecom-csli',
    title: 'Telecom Carriers \u2014 Cell-Site Location Information (Carpenter)',
    body: 'Cellular service providers retain Cell-Site Location Information (CSLI) consisting of records of the cellular tower (and sector / azimuth) through which each of a subscriber\u2019s incoming and outgoing calls was routed. Because Pursuant to Carpenter v. United States, 138 S. Ct. 2206 (2018), historical CSLI accessing seven days or more requires a warrant, the affiant submits this affidavit in compliance with that warrant requirement and has tailored the request to the date range supported by the specific facts of this investigation.',
    tags: ['provider', 'csli', 'cell-site', 'carpenter'],
    jurisdiction: 'US-FEDERAL',
    legalBasis: 'Carpenter v. United States, 138 S. Ct. 2206 (2018)',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'provider-specific.financial-paypal-venmo',
    category: 'provider-specific',
    key: 'financial-paypal-venmo',
    title: 'PayPal / Venmo \u2014 Peer-to-Peer Payment Records',
    body: 'PayPal, Inc. (which owns Venmo) retains, for each user account, (a) subscriber records; (b) linked bank account, debit-card, and credit-card information; (c) the complete transaction history including counterparty user identifier, amount, currency, memo/note text, timestamp, and IP address at time of transaction; (d) device-fingerprint records for each access; and (e) any user-to-user messaging exchanged inside the Venmo platform. The affiant has requested all of these categories for the target account during the date range described.',
    tags: ['provider', 'paypal', 'venmo', 'p2p'],
    jurisdiction: 'ANY',
    legalBasis: '',
    lastReviewed: '2025-12-01',
  }),

  // ═══════════════════════════════════════════════════════════════════════
  // procedural (5) — Hobbs, night-search, PC 1524 grounds, etc.
  // ═══════════════════════════════════════════════════════════════════════

  Object.freeze({
    id: 'procedural.hobbs-sealing',
    category: 'procedural',
    key: 'hobbs-sealing',
    title: 'Hobbs Sealing Justification (Evidence Code \u00a71040 / People v. Hobbs)',
    body: 'The affiant requests that this affidavit be sealed pursuant to Evidence Code \u00a71040 and People v. Hobbs, 7 Cal.4th 948 (1994), on the ground that disclosure of the affidavit would reveal: (i) the identity of a confidential informant whose identity is privileged under Evidence Code \u00a71041 and whose continued safety depends on continued non-disclosure; (ii) confidential investigative techniques whose disclosure would compromise this and other ongoing investigations; and (iii) the existence of cooperating witnesses whose disclosure would endanger their safety. The affiant requests that the sealed affidavit be made available to the Court for in camera review pursuant to Hobbs and that the redacted public-record version disclose only the conclusory facts necessary to permit defense review of the warrant\u2019s validity.',
    tags: ['procedural', 'hobbs', 'sealing', 'informant'],
    jurisdiction: 'CA',
    legalBasis: 'Evidence Code \u00a71040; People v. Hobbs, 7 Cal.4th 948 (1994)',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'procedural.night-search',
    category: 'procedural',
    key: 'night-search',
    title: 'Night-Search Authorization \u2014 Penal Code \u00a71533',
    body: 'The affiant requests that this warrant authorize service at any hour of the day or night pursuant to Penal Code \u00a71533. The affiant submits that good cause exists for night service based on the following specific facts: the records sought are stored on servers operated by Electronic Communication Service providers; such providers permit electronic service of warrants at any hour through a 24-hour Law Enforcement Response portal; service during overnight hours minimizes the risk that the suspect will be alerted by the provider\u2019s notification systems; and service during overnight hours preserves the affiant\u2019s ability to execute coordinated steps in this investigation, including subsequent physical-premises searches that may immediately follow the provider\u2019s return.',
    tags: ['procedural', 'night-search', '1533'],
    jurisdiction: 'CA',
    legalBasis: 'Penal Code \u00a71533',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'procedural.pc-1524-grounds',
    category: 'procedural',
    key: 'pc-1524-grounds',
    title: 'PC \u00a71524 Grounds \u2014 Property Constituting Evidence',
    body: 'The records, information, documents, and items sought by this warrant constitute property described in Penal Code \u00a71524(a)(4) in that they consist of evidence which tends to show that a felony has been committed and that the persons identified herein have committed the charged offense. The records additionally constitute property described in \u00a71524(a)(2) in that they are or have been used as a means of committing a felony. The affiant respectfully submits that the foregoing facts establish probable cause to believe that the property described in the warrant is presently located at the providers identified herein.',
    tags: ['procedural', '1524', 'grounds', 'pc-narrative'],
    jurisdiction: 'CA',
    legalBasis: 'Penal Code \u00a71524(a)(2), (a)(4)',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'procedural.ten-day-execution',
    category: 'procedural',
    key: 'ten-day-execution',
    title: 'Ten-Day Execution Window \u2014 Penal Code \u00a71534',
    body: 'Pursuant to Penal Code \u00a71534, this warrant shall be executed and returned within ten (10) days after its date of issuance. Where the provider has not produced responsive records within that ten-day period, the affiant may request an extension of the execution period by separate application supported by a showing of continuing diligent effort.',
    tags: ['procedural', '1534', 'execution-window'],
    jurisdiction: 'CA',
    legalBasis: 'Penal Code \u00a71534',
    lastReviewed: '2025-12-01',
  }),

  Object.freeze({
    id: 'procedural.preservation-letter',
    category: 'procedural',
    key: 'preservation-letter',
    title: 'Preservation Letter \u2014 18 U.S.C. \u00a72703(f) / PC \u00a71546.1(c)',
    body: 'On {{addendum.preservationDate}}, the affiant served a preservation request on {{provider.legalEntity}} pursuant to 18 U.S.C. \u00a72703(f) and California Penal Code \u00a71546.1(c), directing the provider to preserve all records and other evidence in its possession pertaining to the target account pending issuance of this warrant. {{provider.legalEntity}} acknowledged receipt of the preservation request and the affiant has been advised that the requested records have been preserved.',
    tags: ['procedural', 'preservation', '2703f'],
    jurisdiction: 'ANY',
    legalBasis: '18 U.S.C. \u00a72703(f); Penal Code \u00a71546.1(c)',
    lastReviewed: '2025-12-01',
  }),

]);

// ─── INDEXES ───────────────────────────────────────────────────────────────
const _BY_ID = (() => {
  const m = Object.create(null);
  for (const p of SHIPPED_PARAGRAPHS) m[p.id] = p;
  return Object.freeze(m);
})();

const _BY_CATEGORY = (() => {
  const m = Object.create(null);
  for (const c of CATEGORIES) m[c.id] = [];
  for (const p of SHIPPED_PARAGRAPHS) {
    if (m[p.category]) m[p.category].push(p);
  }
  // Freeze the per-category arrays.
  for (const k of Object.keys(m)) m[k] = Object.freeze(m[k]);
  return Object.freeze(m);
})();

// ─── HELPERS ───────────────────────────────────────────────────────────────

/** Returns the shipped paragraph for an id, or null. */
function getShippedById(id) {
  return _BY_ID[id] || null;
}

/** Returns the shipped paragraphs for a category, or []. */
function listShippedByCategory(categoryId) {
  return _BY_CATEGORY[categoryId] ? _BY_CATEGORY[categoryId].slice() : [];
}

/** Returns the full shipped catalog (frozen). */
function allShipped() {
  return SHIPPED_PARAGRAPHS;
}

/** Returns the category metadata array (frozen). */
function listCategories() {
  return CATEGORIES;
}

/**
 * Normalize a paragraph record (shipped or custom) — fills defaults so
 * downstream code can rely on stable shape.
 */
function normalizeParagraph(raw) {
  raw = raw || {};
  return {
    id:           raw.id || (raw.category && raw.key ? `${raw.category}.${raw.key}` : ''),
    category:     raw.category || '',
    key:          raw.key || '',
    title:        raw.title || '',
    body:         raw.body || '',
    tags:         Array.isArray(raw.tags) ? raw.tags.slice() : [],
    jurisdiction: raw.jurisdiction || 'ANY',
    legalBasis:   raw.legalBasis || '',
    lastReviewed: raw.lastReviewed || '',
  };
}

/**
 * Merge shipped + custom − hidden + overrides.
 *   stores: { overrides: {<id>: {body, title?}}, custom: [...], hidden: [<id>] }
 * Returns the materialized array, sorted by (category, title).
 * Each entry is tagged `_source` = 'shipped' | 'shipped-override' | 'custom'.
 */
function mergeBoilerplate(stores) {
  stores = stores || {};
  const hidden = new Set(Array.isArray(stores.hidden) ? stores.hidden : []);
  const overrides = (stores.overrides && typeof stores.overrides === 'object') ? stores.overrides : {};
  const customList = Array.isArray(stores.custom) ? stores.custom : [];

  const out = [];
  for (const ship of SHIPPED_PARAGRAPHS) {
    if (hidden.has(ship.id)) continue;
    const ov = overrides[ship.id];
    if (ov && (ov.body || ov.title)) {
      out.push(Object.assign({}, ship, ov, { _source: 'shipped-override' }));
    } else {
      out.push(Object.assign({}, ship, { _source: 'shipped' }));
    }
  }
  for (const c of customList) {
    if (!c || !c.id) continue;
    if (_BY_ID[c.id]) continue;  // never let custom shadow shipped
    out.push(Object.assign({}, normalizeParagraph(c), { _source: 'custom' }));
  }
  out.sort((a, b) => {
    if (a.category !== b.category) return String(a.category).localeCompare(b.category);
    return String(a.title).localeCompare(b.title);
  });
  return out;
}

/** Lookup against the merged set. */
function getByIdMerged(id, stores) {
  const all = mergeBoilerplate(stores);
  return all.find(p => p.id === id) || null;
}

/** Slug a candidate title into a valid `key`. */
function generateParagraphKey(title, existingKeys) {
  const base = String(title || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';
  const taken = new Set(existingKeys || []);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ─── EXPORTS ───────────────────────────────────────────────────────────────
const api = Object.freeze({
  SCHEMA_VERSION,
  CATEGORIES,
  SHIPPED_PARAGRAPHS,
  // lookups
  getShippedById,
  listShippedByCategory,
  allShipped,
  listCategories,
  // override-aware
  normalizeParagraph,
  mergeBoilerplate,
  getByIdMerged,
  generateParagraphKey,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.WarrantAuthorBoilerplateLibrary = api;
}

})();
