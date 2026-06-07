// modules/warrant-author/provider-registry.js
// Provider Registry — 13 shipped ESP providers + per-provider templates.
//
// Phase P0 stub. P1 implements (data sourced from user's exemplars):
//   exhonorated999/Multi Business SW/ → 11 DOCX templates already audited.
//
// Entry shape:
//   {
//     key: 'twitter',                       // stable id
//     displayName: 'Twitter (X Corp)',
//     legalName: 'X Corp.',
//     custodianAttention: 'Custodian of Records',
//     onlineService: 'X / Twitter platform',
//     serviceMethod: 'electronic',          // 'electronic' | 'fax' | 'us-mail'
//     serviceAddress: { line1: '...', city: 'San Francisco', state: 'CA', zip: '94103' },
//     orderToSendVia: 'twittercompliance@x.com',
//     legalNoticePortal: 'https://...',
//     pattern: 'A',                          // A/B/C — items-to-seize taxonomy
//     itemsTemplate: 'pattern-a-twitter',    // → templates/pattern-a-twitter.txt
//     dateFormat: 'UTC',
//     supportsCalecpaSealing: true,
//     supportsNonDisclosure: true,
//     notes: 'X Corp requires court-issued order; informal preservation: ...',
//     copyPasteGuards: ['x corp', 'twitter']
//   }
//
// SHIPPED PROVIDERS (13):
//   twitter, snapchat, tiktok, yahoo, whatsapp, microsoft,
//   charter-spectrum, textnow, venmo, paypal, zscaler,
//   ultimate-internet, sprint
//
// Plus generic 'other' fallback.

const SHIPPED_PROVIDERS = [
    // Populated in P1.
];

function getProvider(/* key */) {
    return null;
}

function listProviders() {
    return SHIPPED_PROVIDERS.slice();
}

module.exports = { getProvider, listProviders, SHIPPED_PROVIDERS };
