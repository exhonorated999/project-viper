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
  }
];
  for (var i = 0; i < TEMPLATES.length; i++) {
    try { TE.registerTemplate(TEMPLATES[i]); }
    catch (e) { console.error('[WarrantAuthor] template register failed:', TEMPLATES[i] && TEMPLATES[i].id, e); }
  }
  console.log('[WarrantAuthor] templates-bundle: registered', TEMPLATES.length, 'templates');
})();