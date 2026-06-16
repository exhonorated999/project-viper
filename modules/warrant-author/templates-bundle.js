// modules/warrant-author/templates-bundle.js
// AUTO-GENERATED at build time from templates/*.json
// In Node, template-engine auto-loads via fs. In the renderer
// (nodeIntegration:false), this bundle registers them at startup.
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  var TE = window.WarrantAuthorTemplateEngine;
  if (!TE || typeof TE.registerTemplate !== 'function') {
    console.error('[WarrantAuthor] templates-bundle: TemplateEngine missing');
    return;
  }
  var TEMPLATES = [
  {
    "id": "ca-multi-business-esp",
    "name": "California Multi-Business ESP (CalECPA)",
    "jurisdiction": "CA",
    "version": 1,
    "description": "California search warrant addendum template under PC \u00a71546.1 (CalECPA). Implements the 18-block structure documented in plan \u00a75. Use for Electronic Communication Service providers, ISPs, and financial-service ESPs subject to California jurisdiction.",
    "compatibleProviderTypes": [
      "ESP",
      "Phone",
      "Internet",
      "Financial",
      "Other"
    ],
    "blocks": [
      {
        "key": "01-page-label",
        "kind": "label",
        "slot": "addendum.pageLabel"
      },
      {
        "key": "02-search-command",
        "kind": "constant",
        "heading": "",
        "text": "YOU ARE THEREFORE COMMANDED to SEARCH:"
      },
      {
        "key": "03-business-identification",
        "kind": "provider-block",
        "heading": "",
        "fields": [
          "legalEntity",
          "address",
          "custodianAttention",
          "email",
          "phone",
          "portalUrl"
        ],
        "requiredFields": [
          "legalEntity",
          "address"
        ]
      },
      {
        "key": "04-for-the-following",
        "kind": "constant",
        "heading": "",
        "text": "For the FOLLOWING PROPERTY or PERSON(s):"
      },
      {
        "key": "05-target-account",
        "kind": "target-account",
        "heading": "Target Account(s):"
      },
      {
        "key": "06-date-range",
        "kind": "date-range",
        "heading": "Date Range:"
      },
      {
        "key": "07-items-to-seize",
        "kind": "items-to-seize",
        "heading": "The following records, information, documents, and items are to be produced:"
      },
      {
        "key": "08-calecpa-d2",
        "kind": "verbatim-paragraph",
        "heading": "CalECPA \u00a71546.1(d)(2) \u2014 Authenticity Certification",
        "text": "Pursuant to California Penal Code \u00a71546.1(d)(2), the records, information, documents, and items produced in response to this warrant shall be accompanied by an authenticated declaration from the custodian of records or other qualified person stating: (a) that the records are true and accurate copies of business records made at or near the time of the events described by, or from information transmitted by, a person with knowledge; (b) that the records were kept in the course of a regularly conducted business activity; and (c) that the making of the records was a regular practice of that business activity. The declaration shall be executed under penalty of perjury and shall be sufficient to satisfy the foundational requirements of Evidence Code \u00a7\u00a7 1271 and 1561."
      },
      {
        "key": "09-calecpa-d3",
        "kind": "verbatim-paragraph",
        "heading": "CalECPA \u00a71546.1(d)(3) \u2014 Sealing of Returned Records",
        "text": "Pursuant to California Penal Code \u00a71546.1(d)(3), all records, information, documents, and items received in response to this warrant shall be sealed by the affiant and shall not be opened, reviewed, or disclosed to any person other than the affiant, the issuing court, and law-enforcement personnel directly involved in this investigation, except by further order of the court. The affiant shall maintain custody of the sealed return until disposition of the underlying case or further order of this court."
      },
      {
        "key": "10-it-is-further-ordered-verify",
        "kind": "provider-slot-paragraph",
        "heading": "",
        "text": "IT IS FURTHER ORDERED that {{provider.legalEntity}} shall verify the authenticity of all records, information, documents, and items produced in response to this warrant by including the declaration required by Penal Code \u00a71546.1(d)(2) and California Evidence Code \u00a7\u00a7 1271 and 1561. The records shall be delivered to the affiant in a form that preserves their evidentiary integrity."
      },
      {
        "key": "11-ndo-header",
        "kind": "constant",
        "heading": "",
        "text": "90-DAY NON-DISCLOSURE ORDER:"
      },
      {
        "key": "12-ndo-base",
        "kind": "provider-slot-paragraph",
        "heading": "",
        "text": "Pursuant to California Penal Code \u00a71546.2(b), the Court FINDS that there is reason to believe that notification of the existence of this warrant to the subscriber, user, or any third party would result in: (i) endangering the life or physical safety of an individual; (ii) flight from prosecution; (iii) destruction of or tampering with evidence; (iv) intimidation of potential witnesses; or (v) otherwise seriously jeopardizing an investigation or unduly delaying a trial. IT IS THEREFORE ORDERED that {{provider.legalEntity}}, its officers, employees, and agents shall not disclose the existence of this warrant, the records produced in response, or the investigation of which this warrant is a part, to the subscriber, user, or any third party other than counsel for {{provider.legalEntity}}, for a period of ninety (90) days from the date of this order."
      },
      {
        "key": "13-ndo-supporting",
        "kind": "optional-paragraph",
        "guardSlot": "addendum.ndoExtendedJustification",
        "heading": "Information Supporting Non-Disclosure:",
        "text": "{{addendum.ndoExtendedJustification}}"
      },
      {
        "key": "14-appearing-reason",
        "kind": "verbatim-paragraph",
        "heading": "",
        "text": "IT APPEARING that there is reason to believe that notification of the existence of this warrant would seriously jeopardize the investigation described in the affidavit submitted in support of this warrant, including by giving the subscriber or others an opportunity to destroy evidence, change patterns of behavior, intimidate witnesses, or flee prosecution, the Court FINDS that the non-disclosure order set forth above is justified under Penal Code \u00a71546.2(b)."
      },
      {
        "key": "15-ordered-delay",
        "kind": "provider-slot-paragraph",
        "heading": "",
        "text": "IT IS ORDERED that {{provider.legalEntity}} shall delay any notification to the subscriber, user, or any third party of the existence of this warrant or the production of records in response thereto for a period of ninety (90) days from the date of this order. Any extension of this delay-of-notice period shall be sought by separate application to this Court pursuant to Penal Code \u00a71546.2(a)."
      },
      {
        "key": "16-delay-1546-2a",
        "kind": "verbatim-paragraph",
        "heading": "",
        "text": "Pursuant to Penal Code \u00a71546.2(a), the affiant shall serve a copy of this warrant on the subscriber, user, or person whose information was the target of this warrant within three (3) days of the expiration of the ninety-day delay-of-notice period set forth above, unless an extension of the delay period has been granted by this Court."
      },
      {
        "key": "17-order-to-send-header",
        "kind": "constant",
        "heading": "",
        "text": "ORDER TO SEND INFORMATION:"
      },
      {
        "key": "18-affiant-contact",
        "kind": "affiant-contact",
        "heading": "All responsive records, information, documents, and items shall be transmitted to the affiant at the address below:",
        "fields": [
          "affiantName",
          "affiantBadgeId",
          "affiantUnit",
          "agencyName",
          "agencyAddressLine1",
          "agencyAddressCityStateZip",
          "affiantPhone",
          "affiantEmail"
        ],
        "labels": {
          "affiantName": "Affiant",
          "affiantBadgeId": "Badge / ID",
          "affiantUnit": "Unit / Assignment",
          "affiantPhone": "Phone",
          "affiantEmail": "Email",
          "agencyName": "Agency",
          "agencyAddressLine1": "",
          "agencyAddressCityStateZip": ""
        },
        "requiredFields": [
          "affiantName",
          "agencyName",
          "affiantEmail"
        ]
      }
    ]
  },
  {
    "id": "generic-us-multi-business-esp",
    "name": "Generic US Multi-Business ESP (Federal SCA \u00a72703)",
    "jurisdiction": "US-FEDERAL",
    "version": 1,
    "description": "Generic United States search warrant addendum template under the Stored Communications Act, 18 U.S.C. \u00a72703. Use when the target ESP / ISP / financial-service provider is outside California jurisdiction, or when a federal nexus dictates SCA framing. Provides a state-jurisdiction-neutral structure that conforms to the 18-block plan-\u00a75 schema.",
    "compatibleProviderTypes": [
      "ESP",
      "Phone",
      "Internet",
      "Financial",
      "Other"
    ],
    "blocks": [
      {
        "key": "01-page-label",
        "kind": "label",
        "slot": "addendum.pageLabel"
      },
      {
        "key": "02-search-command",
        "kind": "constant",
        "heading": "",
        "text": "YOU ARE THEREFORE COMMANDED to SEARCH:"
      },
      {
        "key": "03-business-identification",
        "kind": "provider-block",
        "heading": "",
        "fields": [
          "legalEntity",
          "address",
          "custodianAttention",
          "email",
          "phone",
          "portalUrl"
        ],
        "requiredFields": [
          "legalEntity",
          "address"
        ]
      },
      {
        "key": "04-for-the-following",
        "kind": "constant",
        "heading": "",
        "text": "For the FOLLOWING PROPERTY or PERSON(s):"
      },
      {
        "key": "05-target-account",
        "kind": "target-account",
        "heading": "Target Account(s):"
      },
      {
        "key": "06-date-range",
        "kind": "date-range",
        "heading": "Date Range:"
      },
      {
        "key": "07-items-to-seize",
        "kind": "items-to-seize",
        "heading": "The following records, information, documents, and items are to be produced:"
      },
      {
        "key": "08-sca-2703-authenticity",
        "kind": "verbatim-paragraph",
        "heading": "Stored Communications Act \u2014 Authentication of Records",
        "text": "Pursuant to 18 U.S.C. \u00a72703 and Federal Rule of Evidence 902(11), the records, information, documents, and items produced in response to this warrant shall be accompanied by a certification of authenticity from the custodian of records or other qualified person. The certification shall state, under penalty of perjury, that: (a) the records were made at or near the time of the events described, by, or from information transmitted by, a person with knowledge of the events; (b) the records were kept in the course of a regularly conducted activity of the business; and (c) the records were made by the regularly conducted business activity as a regular practice. Such certification shall be sufficient to satisfy the authentication requirements of Federal Rule of Evidence 901."
      },
      {
        "key": "09-sca-sealing",
        "kind": "verbatim-paragraph",
        "heading": "Sealing of Returned Records",
        "text": "All records, information, documents, and items received in response to this warrant shall be maintained in a secure manner by the affiant and shall not be disclosed to any person other than the affiant, the issuing court, and law-enforcement personnel directly involved in this investigation, except by further order of the court or as otherwise required by law. The affiant shall maintain custody of the return until disposition of the underlying case or further order of this court."
      },
      {
        "key": "10-it-is-further-ordered-verify",
        "kind": "provider-slot-paragraph",
        "heading": "",
        "text": "IT IS FURTHER ORDERED that {{provider.legalEntity}} shall authenticate all records, information, documents, and items produced in response to this warrant by including the certification required by Federal Rule of Evidence 902(11). The records shall be delivered to the affiant in a form that preserves their evidentiary integrity."
      },
      {
        "key": "11-ndo-header",
        "kind": "constant",
        "heading": "",
        "text": "NON-DISCLOSURE ORDER (18 U.S.C. \u00a72705(b)):"
      },
      {
        "key": "12-ndo-base",
        "kind": "provider-slot-paragraph",
        "heading": "",
        "text": "Pursuant to 18 U.S.C. \u00a72705(b), the Court FINDS that there is reason to believe that notification of the existence of this warrant to the subscriber or customer would result in: (i) endangering the life or physical safety of an individual; (ii) flight from prosecution; (iii) destruction of or tampering with evidence; (iv) intimidation of potential witnesses; or (v) otherwise seriously jeopardizing an investigation or unduly delaying a trial. IT IS THEREFORE ORDERED that {{provider.legalEntity}}, its officers, employees, and agents shall not disclose the existence of this warrant, the records produced in response, or the investigation of which this warrant is a part, to the subscriber, customer, or any third party other than counsel for {{provider.legalEntity}}, for a period of one hundred eighty (180) days from the date of this order."
      },
      {
        "key": "13-ndo-supporting",
        "kind": "optional-paragraph",
        "guardSlot": "addendum.ndoExtendedJustification",
        "heading": "Information Supporting Non-Disclosure:",
        "text": "{{addendum.ndoExtendedJustification}}"
      },
      {
        "key": "14-appearing-reason",
        "kind": "verbatim-paragraph",
        "heading": "",
        "text": "IT APPEARING that there is reason to believe that notification of the existence of this warrant would seriously jeopardize the investigation described in the affidavit submitted in support of this warrant, including by giving the subscriber or others an opportunity to destroy evidence, change patterns of behavior, intimidate witnesses, or flee prosecution, the Court FINDS that the non-disclosure order set forth above is justified under 18 U.S.C. \u00a72705(b)."
      },
      {
        "key": "15-ordered-delay",
        "kind": "provider-slot-paragraph",
        "heading": "",
        "text": "IT IS ORDERED that {{provider.legalEntity}} shall delay any notification to the subscriber, customer, or any third party of the existence of this warrant or the production of records in response thereto for a period of one hundred eighty (180) days from the date of this order. Any extension of this delay-of-notice period shall be sought by separate application to this Court pursuant to 18 U.S.C. \u00a72705(b)."
      },
      {
        "key": "16-delay-notice",
        "kind": "verbatim-paragraph",
        "heading": "",
        "text": "Pursuant to 18 U.S.C. \u00a72705(a), notice to the subscriber or customer may be delayed for a period not to exceed the period authorized above, subject to extension by further order of the Court upon a showing of continuing need."
      },
      {
        "key": "17-order-to-send-header",
        "kind": "constant",
        "heading": "",
        "text": "ORDER TO SEND INFORMATION:"
      },
      {
        "key": "18-affiant-contact",
        "kind": "affiant-contact",
        "heading": "All responsive records, information, documents, and items shall be transmitted to the affiant at the address below:",
        "fields": [
          "affiantName",
          "affiantBadgeId",
          "affiantUnit",
          "agencyName",
          "agencyAddressLine1",
          "agencyAddressCityStateZip",
          "affiantPhone",
          "affiantEmail"
        ],
        "labels": {
          "affiantName": "Affiant",
          "affiantBadgeId": "Badge / ID",
          "affiantUnit": "Unit / Assignment",
          "affiantPhone": "Phone",
          "affiantEmail": "Email",
          "agencyName": "Agency",
          "agencyAddressLine1": "",
          "agencyAddressCityStateZip": ""
        },
        "requiredFields": [
          "affiantName",
          "agencyName",
          "affiantEmail"
        ]
      }
    ]
  },
  {
    "id": "va-multi-business-esp",
    "name": "Virginia Multi-Business ESP (DC-338 / DC-339)",
    "jurisdiction": "VA",
    "version": 1,
    "description": "Virginia search warrant addendum template for Electronic Service Providers under Va. Code \u00a7\u00a7 19.2-53, 19.2-54, 19.2-56, 19.2-70.3. Companion to DC-338 (Affidavit) and DC-339 (Search Warrant). NDO / delay-of-notice clauses cite 18 U.S.C. \u00a7 2705 (federal SCA) because Virginia has no state-law equivalent — this is the standard practice for warrants served on out-of-state ESPs (Snapchat, Google, Meta, etc.). Sealing is by court motion under Va. Code \u00a7\u00a7 17.1-208 / 19.2-265.01.",
    "compatibleProviderTypes": [
      "ESP",
      "Phone",
      "Internet",
      "Financial",
      "Other"
    ],
    "blocks": [
      {
        "key": "01-page-label",
        "kind": "label",
        "slot": "addendum.pageLabel"
      },
      {
        "key": "02-search-command",
        "kind": "constant",
        "heading": "",
        "text": "YOU ARE THEREFORE COMMANDED to SEARCH:"
      },
      {
        "key": "03-business-identification",
        "kind": "provider-block",
        "heading": "",
        "fields": [
          "legalEntity",
          "address",
          "custodianAttention",
          "email",
          "phone",
          "portalUrl"
        ],
        "requiredFields": [
          "legalEntity",
          "address"
        ]
      },
      {
        "key": "04-foreign-corp-recital",
        "kind": "verbatim-paragraph",
        "heading": "Foreign Corporation \u2014 Va. Code \u00a7 19.2-70.3",
        "text": "{{provider.legalEntity}} is a foreign corporation that provides electronic communication service or remote computing service to residents of the Commonwealth of Virginia. Pursuant to Va. Code \u00a7 19.2-70.3, this Court has authority to compel production of records held by {{provider.legalEntity}} relating to a subscriber or customer located within, or whose communications were transmitted to or from, the Commonwealth of Virginia."
      },
      {
        "key": "05-for-the-following",
        "kind": "constant",
        "heading": "",
        "text": "For the FOLLOWING PROPERTY or PERSON(s):"
      },
      {
        "key": "06-target-account",
        "kind": "target-account",
        "heading": "Target Account(s):"
      },
      {
        "key": "07-date-range",
        "kind": "date-range",
        "heading": "Date Range:"
      },
      {
        "key": "08-items-to-seize",
        "kind": "items-to-seize",
        "heading": "The following records, information, documents, and items are to be produced:"
      },
      {
        "key": "09-authenticity",
        "kind": "verbatim-paragraph",
        "heading": "Authentication of Records \u2014 Va. Code \u00a7 8.01-390.3 / FRE 902(11)",
        "text": "Pursuant to Va. Code \u00a7 8.01-390.3 and Federal Rule of Evidence 902(11), the records, information, documents, and items produced in response to this warrant shall be accompanied by a certification of authenticity from the custodian of records or other qualified person. The certification shall state, under penalty of perjury, that: (a) the records were made at or near the time of the events described, by, or from information transmitted by, a person with knowledge; (b) the records were kept in the course of a regularly conducted activity of the business; and (c) the records were made by the regularly conducted business activity as a regular practice."
      },
      {
        "key": "10-it-is-further-ordered-verify",
        "kind": "provider-slot-paragraph",
        "heading": "",
        "text": "IT IS FURTHER ORDERED that {{provider.legalEntity}} shall authenticate all records, information, documents, and items produced in response to this warrant by including the certification required by Va. Code \u00a7 8.01-390.3 and Federal Rule of Evidence 902(11). The records shall be delivered to the affiant in a form that preserves their evidentiary integrity."
      },
      {
        "key": "11-ndo-header",
        "kind": "constant",
        "heading": "",
        "text": "NON-DISCLOSURE ORDER (18 U.S.C. \u00a7 2705(b)):"
      },
      {
        "key": "12-ndo-base",
        "kind": "provider-slot-paragraph",
        "heading": "",
        "text": "Pursuant to 18 U.S.C. \u00a7 2705(b), the Court FINDS that there is reason to believe that notification of the existence of this warrant to the subscriber or customer would result in: (i) endangering the life or physical safety of an individual; (ii) flight from prosecution; (iii) destruction of or tampering with evidence; (iv) intimidation of potential witnesses; or (v) otherwise seriously jeopardizing an investigation or unduly delaying a trial. IT IS THEREFORE ORDERED that {{provider.legalEntity}}, its officers, employees, and agents shall not disclose the existence of this warrant, the records produced in response, or the investigation of which this warrant is a part, to the subscriber, customer, or any third party other than counsel for {{provider.legalEntity}}, for a period of ninety (90) days from the date of this order."
      },
      {
        "key": "13-ndo-supporting",
        "kind": "optional-paragraph",
        "guardSlot": "addendum.ndoExtendedJustification",
        "heading": "Information Supporting Non-Disclosure:",
        "text": "{{addendum.ndoExtendedJustification}}"
      },
      {
        "key": "14-appearing-reason",
        "kind": "verbatim-paragraph",
        "heading": "",
        "text": "IT APPEARING that there is reason to believe that notification of the existence of this warrant would seriously jeopardize the investigation described in the affidavit submitted in support of this warrant, including by giving the subscriber or others an opportunity to destroy evidence, change patterns of behavior, intimidate witnesses, or flee prosecution, the Court FINDS that the non-disclosure order set forth above is justified under 18 U.S.C. \u00a7 2705(b)."
      },
      {
        "key": "15-ordered-delay",
        "kind": "provider-slot-paragraph",
        "heading": "",
        "text": "IT IS ORDERED that {{provider.legalEntity}} shall delay any notification to the subscriber, customer, or any third party of the existence of this warrant or the production of records in response thereto for a period of ninety (90) days from the date of this order. Any extension of this delay-of-notice period shall be sought by separate application to this Court pursuant to 18 U.S.C. \u00a7 2705(b)."
      },
      {
        "key": "16-delay-notice",
        "kind": "verbatim-paragraph",
        "heading": "",
        "text": "Pursuant to 18 U.S.C. \u00a7 2705(a), notice to the subscriber or customer may be delayed for a period not to exceed the period authorized above, subject to extension by further order of the Court upon a showing of continuing need."
      },
      {
        "key": "17-order-to-send-header",
        "kind": "constant",
        "heading": "",
        "text": "ORDER TO SEND INFORMATION:"
      },
      {
        "key": "18-affiant-contact",
        "kind": "affiant-contact",
        "heading": "All responsive records, information, documents, and items shall be transmitted to the affiant at the address below:",
        "fields": [
          "affiantName",
          "affiantBadgeId",
          "affiantUnit",
          "agencyName",
          "agencyAddressLine1",
          "agencyAddressCityStateZip",
          "affiantPhone",
          "affiantEmail"
        ],
        "labels": {
          "affiantName": "Affiant",
          "affiantBadgeId": "Badge / ID",
          "affiantUnit": "Unit / Assignment",
          "affiantPhone": "Phone",
          "affiantEmail": "Email",
          "agencyName": "Agency",
          "agencyAddressLine1": "",
          "agencyAddressCityStateZip": ""
        },
        "requiredFields": [
          "affiantName",
          "agencyName",
          "affiantEmail"
        ]
      }
    ]
  },
  {
    "id": "ca-residential",
    "name": "California Residential Search Warrant",
    "jurisdiction": "CA",
    "version": 1,
    "type": "residential",
    "description": "California combined Search Warrant + Affidavit + Statement of Probable Cause for a residence (San Bernardino County combined format). Selects a crime-type preset (CSAM, Narcotics, Persons Crimes, Property Crimes) which drives default PC \u00a71524 grounds, items-to-seize blocks, training & experience prose, default optional clauses (Hobbs sealing, night service, offsite computer search, authority to duplicate, return extension), and SOPC narrative scaffolding. Premises legal description, suspect identification, and SOPC narrative are author-supplied. Agency / affiant / court / county / judge default from the Warrant Author agency profile (Settings).",
    "supportedCrimePresets": ["csam", "narcotics", "persons", "property"],
    "blocks": [
      { "key": "01-warrant-face-label", "kind": "label", "slot": "face.pageLabel", "text": "SEARCH WARRANT" },
      { "key": "02-people-opener", "kind": "constant", "heading": "", "text": "THE PEOPLE OF THE STATE OF CALIFORNIA, TO ANY PEACE OFFICER IN {{agency.county}} COUNTY:" },
      { "key": "03-affiant-attestation", "kind": "verbatim-paragraph", "heading": "", "text": "Proof, by affidavit, having been this day made before me by {{affiant.rank}} {{affiant.name}} of {{agency.name}}, that there is probable cause to believe that the property and things described in this warrant are located at the premises set forth below, and that the property and things are (1) stolen or embezzled; (2) used as the means of committing a felony; (3) in the possession of a person with the intent to use it as a means of committing a public offense, or in the possession of another to whom he or she may have delivered it for the purpose of concealing it or preventing its discovery; (4) constitute evidence which tends to show that a felony has been committed, or that a particular person has committed a felony; (5) tend to show that sexual exploitation of a child, in violation of Penal Code Section 311.3, or possession of matter depicting sexual conduct of a person under the age of 18 years, in violation of Penal Code Section 311.11, has occurred or is occurring; (6) when the property or things to be seized consists of evidence that tends to show a violation of Section 3700.5 of the Labor Code, or that tends to show that a particular person has violated Section 3700.5 of the Labor Code; or (7) when the property or things to be seized include a firearm or any other deadly weapon at the scene of, or at the premises occupied or under the control of the person arrested in connection with, a domestic violence incident." },
      { "key": "04-pc1524-grounds", "kind": "pc1524-grounds", "heading": "Grounds (Penal Code \u00a71524):", "slot": "residential.pc1524Grounds" },
      { "key": "05-search-command-header", "kind": "constant", "heading": "", "text": "YOU ARE THEREFORE COMMANDED to SEARCH:" },
      { "key": "06-premises-legal", "kind": "premises-legal", "heading": "DESCRIPTION OF PROPERTY TO BE SEARCHED", "slot": "residential.premises", "fields": ["address", "legalDescription"], "requiredFields": ["address", "legalDescription"] },
      { "key": "07-suspect-identification", "kind": "suspect-identification", "heading": "INCLUDING THE PERSON OF:", "slot": "residential.suspects", "fields": ["name", "aliases", "dob", "descriptors", "address"] },
      { "key": "08-seize-header", "kind": "constant", "heading": "", "text": "AND TO SEIZE THE FOLLOWING PROPERTY AND THINGS:" },
      { "key": "09-items-to-seize", "kind": "items-to-seize-blocks", "heading": "DESCRIPTION OF PROPERTY TO BE SEIZED", "slot": "residential.itemsToSeize" },
      { "key": "10-night-service-face", "kind": "optional-checkbox", "heading": "", "slot": "residential.optionalClauses.nightService.enabled", "text": "Good cause having been shown, this warrant may be served at any time of the day or night pursuant to Penal Code \u00a71533." },
      { "key": "11-hobbs-sealing-face", "kind": "optional-checkbox", "heading": "", "slot": "residential.optionalClauses.hobbsSealing.enabled", "text": "The affidavit in support of this warrant is ORDERED SEALED pursuant to People v. Hobbs (1994) 7 Cal.4th 948 and Evidence Code \u00a71041, on the grounds set forth in the affidavit." },
      { "key": "12-magistrate-boilerplate", "kind": "verbatim-paragraph", "heading": "", "text": "GIVEN UNDER MY HAND, and dated this _____ day of ____________, 20___, at _____ a.m./p.m.\n\n_____________________________________\nJUDGE OF THE SUPERIOR COURT\n{{agency.county}} County, California" },
      { "key": "13-affidavit-header", "kind": "section-break", "heading": "AFFIDAVIT / STATEMENT OF PROBABLE CAUSE", "text": "" },
      { "key": "14-affiant-declaration", "kind": "verbatim-paragraph", "heading": "", "text": "I, {{affiant.rank}} {{affiant.name}}, Badge No. {{affiant.badge}}, being first duly sworn, depose and say: that I am a peace officer employed by {{agency.name}}, currently assigned to {{agency.unit}}, and that the facts set forth in this affidavit are true to the best of my knowledge and belief, except for those matters stated on information and belief, and as to those matters, I believe them to be true." },
      { "key": "15-training-experience", "kind": "training-experience", "heading": "IDENTIFICATION AND EXPERIENCE OF AFFIANT", "slot": "residential.trainingExperience" },
      { "key": "16-probable-cause", "kind": "sopc-sections", "heading": "STATEMENT OF PROBABLE CAUSE", "slot": "residential.sopc.sections" },
      { "key": "17-property-to-search-recap", "kind": "premises-legal-recap", "heading": "DESCRIPTION OF PROPERTY TO BE SEARCHED", "slot": "residential.premises" },
      { "key": "18-property-to-seize-recap", "kind": "items-to-seize-recap", "heading": "DESCRIPTION OF PROPERTY TO BE SEIZED", "slot": "residential.itemsToSeize" },
      { "key": "19-offsite-computer", "kind": "optional-clause", "heading": "OFFSITE EXAMINATION OF DIGITAL DEVICES", "slot": "residential.optionalClauses.offsiteComputerSearch", "text": "Your affiant requests the authority to seize and remove from the premises any digital storage devices (including but not limited to computers, mobile telephones, tablets, external hard drives, USB storage media, optical media, and memory cards) for offsite forensic examination at a secure law enforcement facility. The examination of digital devices is a technical process that often requires specialized equipment, training, and significant time, and cannot be reasonably or safely conducted at the scene. Forensic examination will be limited to data falling within the scope of items to be seized as described in this warrant." },
      { "key": "20-authority-to-duplicate", "kind": "optional-clause", "heading": "AUTHORITY TO DUPLICATE", "slot": "residential.optionalClauses.authorityToDuplicate", "text": "Your affiant requests authority to make exact bit-for-bit forensic duplicates of any digital storage media seized pursuant to this warrant, and to retain such duplicates as evidence and for further examination, even after the original media may be returned or otherwise disposed of pursuant to law." },
      { "key": "21-return-extension", "kind": "optional-clause", "heading": "REQUEST FOR EXTENSION OF TIME FOR RETURN", "slot": "residential.optionalClauses.returnExtension", "text": "Your affiant requests that the time for return of this warrant pursuant to Penal Code \u00a71534 be extended to permit completion of forensic examination of any digital storage media seized. Forensic examination of digital media often requires extended time due to encryption, volume of data, queue at the forensic laboratory, and the technical complexity of the analysis." },
      { "key": "22-night-service-justification", "kind": "optional-clause-with-justification", "heading": "REQUEST FOR NIGHT SERVICE (Penal Code \u00a71533)", "slot": "residential.optionalClauses.nightService", "fields": ["enabled", "justification"] },
      { "key": "23-hobbs-sealing-justification", "kind": "optional-clause-with-justification", "heading": "REQUEST TO SEAL AFFIDAVIT (People v. Hobbs)", "slot": "residential.optionalClauses.hobbsSealing", "fields": ["enabled", "justification"] },
      { "key": "24-statutory-grounds-recap", "kind": "optional-clause", "heading": "STATUTORY GROUNDS", "slot": "residential.optionalClauses.statutoryGroundsRecap", "text": "The property and things sought to be seized as described in this warrant constitute evidence of the violation(s) of California law identified in the caption of this affidavit. Issuance of this warrant is authorized under Penal Code \u00a71524 on the grounds specified on the face of the warrant." },
      { "key": "25-executed-at", "kind": "executed-at", "heading": "", "slot": "residential.executedAt", "fields": ["city", "date", "time", "timeAmPm"] },
      { "key": "26-affiant-signature", "kind": "affiant-contact", "heading": "", "fields": ["affiantName", "affiantBadgeId", "affiantUnit", "agencyName", "agencyAddressLine1", "agencyAddressCityStateZip", "affiantPhone", "affiantEmail"], "labels": { "affiantName": "Affiant", "affiantBadgeId": "Badge / ID", "affiantUnit": "Unit / Assignment", "affiantPhone": "Phone", "affiantEmail": "Email", "agencyName": "Agency" }, "requiredFields": ["affiantName", "agencyName"] }
    ]
  }
,
  {
    "id": "co-multi-business-esp",
    "name": "Colorado Multi-Business ESP (Affidavit + Search Warrant)",
    "jurisdiction": "CO",
    "version": 1,
    "description": "Colorado combined Affidavit + Search Warrant and Court Order template for Electronic Service Providers under 18 U.S.C. \u00a72703, CRIM. P. 41, and C.R.S. \u00a716-3-301, \u00a716-3-301.1, \u00a719-2.5-205. NDO under 18 U.S.C. \u00a7\u00a7 2703(b)(1)(A) and 2705(b)(1)-(5) and Crim. P. 41 and \u00a716-3-304(2). The single output document is two pages \u2014 the Affidavit page, then a hard page break, then the Search Warrant and Court Order page. Court caption (COUNTY/DISTRICT COURT, [N]th JUDICIAL DISTRICT, COLORADO) is selected per-warrant from the agency profile's CO Courts list. DA 'Approved as to Form' block prints the agency profile's daName / daTitle / daDeputyLine.",
    "compatibleProviderTypes": [
      "ESP",
      "Phone",
      "Internet",
      "Financial",
      "Other"
    ],
    "supportsMultipleProviders": true,
    "blocks": [
      {
        "key": "01-affidavit-caption",
        "kind": "co-caption",
        "documentTitle": "AFFIDAVIT IN SUPPORT OF SEARCH WARRANT AND COURT ORDER FOR PRODUCTION OF RECORDS PURSUANT TO 18 U.S.C. \u00a72703, CRIM. P. 41, AND C.R.S. \u00a716-3-301, \u00a716-3-301.1, \u00a719-2.5-205"
      },
      {
        "key": "02-affiant-intro",
        "kind": "verbatim-paragraph",
        "text": "I, {{agency.affiantRank}} {{agency.affiantName}}, {{agency.affiantBadge}}, state under oath that I have reason to believe that at the place or business entity known or described as:"
      },
      {
        "key": "03-provider-block",
        "kind": "co-provider-block"
      },
      {
        "key": "04-now-located",
        "kind": "constant",
        "text": "There is now located the following described records, which are in the active or constructive possession of the business entity:"
      },
      {
        "key": "05-records-lead-in",
        "kind": "verbatim-paragraph",
        "text": "The following records pertaining to the account(s) associated with any one or more of the following identifiers:"
      },
      {
        "key": "06-target-account",
        "kind": "target-account"
      },
      {
        "key": "07-date-range-line",
        "kind": "verbatim-paragraph",
        "text": "From the period of {{addendum.dateRange.start}} to {{addendum.dateRange.end}}:"
      },
      {
        "key": "08-items-to-seize",
        "kind": "items-to-seize",
        "style": "semicolons"
      },
      {
        "key": "09-evidence-pertaining",
        "kind": "verbatim-paragraph",
        "text": "*These records will be searched for evidence pertaining the {{case.offenseDescription}} that occurred on {{case.offenseDate}}."
      },
      {
        "key": "10-statutory-grounds",
        "kind": "verbatim-paragraph",
        "text": "For which a search warrant and court order for production of records may be issued upon one or more of the grounds set forth in 18 U.S.C. \u00a72703, C.R.S. \u00a716-3-301, \u00a716-3-301.1, \u00a719-2.5-205, and Crim. P. 41, namely that this property is stolen or embezzled, or is designed or intended for use as a means of committing a criminal offense, or which is or has been used as a means of committing a criminal offense, or the possession of which is illegal, or which would be material evidence in a subsequent criminal prosecution in this State or another state, or in any other state's court action upon a criminal investigation here or elsewhere."
      },
      {
        "key": "11-facts-header",
        "kind": "constant",
        "text": "The facts tending to establish the grounds for issuance of a Search Warrant are as follows:"
      },
      {
        "key": "12-background-of-affiant",
        "kind": "verbatim-paragraph",
        "text": "{{agency.trainingExperienceBoilerplate}}"
      },
      {
        "key": "13-probable-cause",
        "kind": "verbatim-paragraph",
        "text": "{{addendum.probableCause}}"
      },
      {
        "key": "14-date-range-basis-header",
        "kind": "constant",
        "text": "Basis for the Date Range Requested"
      },
      {
        "key": "15-date-range-basis",
        "kind": "verbatim-paragraph",
        "text": "Your affiant recognizes the need to balance the request for records identified as relevant to this investigation with the need for personal privacy. Your affiant has determined that the above listed date range for the records requested is appropriate for the facts of this particular case. The basis for the date range is as follows: {{addendum.dateRangeBasis}}"
      },
      {
        "key": "16-pc-conclusion",
        "kind": "verbatim-paragraph",
        "text": "Based on these facts, Your Affiant believes there exists probable cause to believe that there is material evidence now located in the above-described account that is crucial to the investigation of this case and the offenses described above, and a search warrant is requested pursuant to 18 U.S.C. \u00a72703, the Colorado Rules of Criminal Procedure Rule 41, C.R.S. \u00a716-3-301, \u00a716-3-301.1, and \u00a719-2.5-205."
      },
      {
        "key": "17-further-requests-header",
        "kind": "constant",
        "text": "Further requests:"
      },
      {
        "key": "18-ndo-request",
        "kind": "verbatim-paragraph",
        "text": "FURTHER, pursuant to 18 U.S.C. \u00a72705(b) and 18 U.S.C. \u00a72705(b)(1)-(5), and Crim. P. 41 and \u00a716-3-304(2), Your Affiant requests that business entity be ordered NOT to disclose the existence of this search warrant and court order to the subscriber for a period of one year from receipt of the requested documents, unless otherwise ordered by a court of competent jurisdiction. Based on the information set forth in this affidavit, notification of the warrant may have an adverse result, as defined in 18 USC \u00a72705(b)(1)-(5), i.e., disclosure may endanger the life or physical safety of an individual; allow flight from prosecution; allow destruction of or tampering with evidence; allow intimidation of potential witnesses; and/or would otherwise seriously jeopardize an investigation or unduly delay a trial."
      },
      {
        "key": "19-no-adverse-action-request",
        "kind": "verbatim-paragraph",
        "text": "FURTHER, so as not to disrupt this ongoing investigation, Your Affiant also requests that this Court order business entity NOT to take adverse action against the subject account, such as disabling or terminating the account, because of this warrant."
      },
      {
        "key": "20-penalty-declaration",
        "kind": "verbatim-paragraph",
        "text": "Your Affiant declares under penalty of perjury that the foregoing is true and correct to the best of Your Affiant's knowledge and belief, and that this declaration was executed on the date listed below."
      },
      {
        "key": "21-affiant-signature",
        "kind": "co-affiant-signature"
      },
      {
        "key": "22-judge-oath-affidavit",
        "kind": "co-judge-oath-affidavit"
      },
      {
        "key": "23-page-break",
        "kind": "page-break"
      },
      {
        "key": "24-warrant-caption",
        "kind": "co-caption",
        "documentTitle": "SEARCH WARRANT AND COURT ORDER FOR PRODUCTION OF RECORDS PURSUANT TO 18 U.S.C. \u00a72703, CRIM. P. 41, AND C.R.S. \u00a716-3-301, \u00a716-3-301.1 AND \u00a719-2.5-205"
      },
      {
        "key": "25-warrant-intro",
        "kind": "verbatim-paragraph",
        "text": "The Court, upon review of an affidavit filed by {{agency.affiantRank}} {{agency.affiantName}}, {{agency.affiantBadge}}, which is incorporated by reference, in support of the issuance of this order, hereby orders the production of the following records, for which there is probable cause to believe are in the actual or constructive possession or control of the business entity known or described as:"
      },
      {
        "key": "26-provider-block-warrant",
        "kind": "co-provider-block"
      },
      {
        "key": "27-warrant-pc-finding",
        "kind": "verbatim-paragraph",
        "text": "This Court also finds that there is probable cause to issue this search warrant and court order for production of the following described records or information pursuant to the provisions of 18 U.S.C. \u00a72703, the Colorado Rules of Criminal Procedure Rule 41, C.R.S. \u00a716-3-301, \u00a716-3-301.1, and \u00a719-2.5-205, namely that this property is stolen or embezzled, or is designed or intended for use as a means of committing a criminal offense, or which is or has been used as a means of committing a criminal offense, or the possession of which is illegal, or which would be material evidence in a subsequent criminal prosecution in this State or another state, or in any other state's court action upon a criminal investigation here or elsewhere."
      },
      {
        "key": "28-records-lead-in-warrant",
        "kind": "verbatim-paragraph",
        "text": "The following records pertaining to the account(s) associated with any one or more of the following identifiers:"
      },
      {
        "key": "29-target-account-warrant",
        "kind": "target-account"
      },
      {
        "key": "30-date-range-line-warrant",
        "kind": "verbatim-paragraph",
        "text": "From the period of {{addendum.dateRange.start}} to {{addendum.dateRange.end}}:"
      },
      {
        "key": "31-items-to-seize-warrant",
        "kind": "items-to-seize",
        "style": "semicolons"
      },
      {
        "key": "32-evidence-pertaining-warrant",
        "kind": "verbatim-paragraph",
        "text": "*These records will be searched for evidence pertaining the {{case.offenseDescription}} that occurred on {{case.offenseDate}}."
      },
      {
        "key": "33-14-day-service",
        "kind": "verbatim-paragraph",
        "text": "This warrant and court order for the production of records shall be served upon the business entity to whom it is directed within fourteen days after being signed by the court."
      },
      {
        "key": "34-35-day-production",
        "kind": "verbatim-paragraph",
        "text": "The business entity is ORDERED to produce the above-described records to the affiant or his/her designee within thirty-five (35) days of service."
      },
      {
        "key": "35-records-to-header",
        "kind": "constant",
        "text": "The records should be provided to:"
      },
      {
        "key": "36-affiant-contact",
        "kind": "affiant-contact",
        "fields": [
          "affiantName",
          "affiantEmail",
          "affiantPhone"
        ],
        "labels": {
          "affiantName": "",
          "affiantEmail": "",
          "affiantPhone": ""
        },
        "requiredFields": [
          "affiantName",
          "affiantEmail"
        ]
      },
      {
        "key": "37-attestation-of-accuracy",
        "kind": "verbatim-paragraph",
        "text": "The business entity shall also provide a notarized attestation of accuracy that the records produced represent complete and accurate copies of all records identified in this order that are in the actual or constructive possession or control of the business entity, signed by a custodian of records or other person with personal knowledge of the records produced. If the business entity does not produce all records identified in this order, it shall identify the records not produced. Failure to comply with this order shall support a finding of contempt of court."
      },
      {
        "key": "38-return-and-inventory",
        "kind": "verbatim-paragraph",
        "text": "Upon receiving the records from the business entity, the peace officer named herein shall file a return and inventory with the court indicating the records that have been received and the date and time upon which the records were received. The peace officer named herein may also file the original of the attestation of accuracy with the court."
      },
      {
        "key": "39-it-is-further-ordered-header",
        "kind": "constant",
        "text": "IT IS FURTHER ORDERED:"
      },
      {
        "key": "40-ndo-order",
        "kind": "verbatim-paragraph",
        "text": "Pursuant to 18 U.S.C. \u00a7\u00a7 2703(b)(1)(A) and 2705(b)(1)-(5) that business entity and any of its employees or third-party vendors processing this request not disclose the existence of this search warrant and court order to the subscriber or to any third party for a period of one year from the date of service of this warrant, as such disclosure would seriously jeopardize the investigation by giving the subscriber an opportunity to destroy evidence, change patterns of behavior, intimidate witnesses, flee from prosecution, or otherwise impede the investigation."
      },
      {
        "key": "41-no-adverse-action-order",
        "kind": "verbatim-paragraph",
        "text": "That business entity and any of its employees or third-party vendors processing this request not take adverse action against the subject account because of this warrant, such as shutting it down, so as not to disrupt this ongoing investigation."
      },
      {
        "key": "42-judge-signature",
        "kind": "co-judge-signature"
      },
      {
        "key": "43-da-approval",
        "kind": "co-da-approval"
      }
    ]
  }
];
  for (var i = 0; i < TEMPLATES.length; i++) {
    try { TE.registerTemplate(TEMPLATES[i]); }
    catch (e) { console.error('[WarrantAuthor] template register failed:', TEMPLATES[i] && TEMPLATES[i].id, e); }
  }
  console.log('[WarrantAuthor] templates-bundle: registered', TEMPLATES.length, 'templates');
})();