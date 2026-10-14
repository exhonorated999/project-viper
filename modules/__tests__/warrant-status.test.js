/**
 * Tests for modules/warrant-status.js
 * Run: node modules/__tests__/warrant-status.test.js
 *
 * This module is the ONLY definition of "is this warrant still outstanding?".
 * Five call sites across index.html and case-detail-with-analytics.html depend
 * on it, so a regression here silently either nags detectives about resolved
 * warrants or hides genuinely overdue ones. Both are bad in different
 * directions, hence the coverage.
 *
 * It is a plain UMD module with no DOM, so a bare require() is enough.
 */
const W = require('../warrant-status.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name); }
}
function eq(a, b, name) {
  ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

/** Local 'YYYY-MM-DD' n days from today — matches how the app stores dueDate. */
function localDate(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + (offsetDays || 0));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── isResolved / isOpen ─────────────────────────────────────────────
console.log('\n-- resolution state --');
eq(W.isOpen({ type: 'search' }), true, 'fresh warrant is open');
eq(W.isResolved({ type: 'search' }), false, 'fresh warrant is not resolved');

eq(W.isResolved({ returnReceived: true }), true, 'returnReceived resolves');
eq(W.isOpen({ returnReceived: true }), false, 'returnReceived closes');

eq(W.isResolved({ closedOut: true }), true, 'closedOut resolves');
eq(W.isOpen({ closedOut: true }), false, 'closedOut closes');

eq(W.isResolved({ returnReceived: true, closedOut: true }), true, 'both flags still resolved');

// Null-safety: every call site iterates arrays straight out of localStorage.
eq(W.isOpen(null), false, 'null is not open');
eq(W.isResolved(null), false, 'null is not resolved');
eq(W.isOpen(undefined), false, 'undefined is not open');
eq(W.isOverdue(null), false, 'null is not overdue');
eq(W.daysOverdue(null), 0, 'null has 0 days overdue');
eq(W.daysUntilDue(null), null, 'null has no due delta');

// Falsy flags must not be mistaken for resolution.
eq(W.isOpen({ returnReceived: false, closedOut: false }), true, 'explicit false flags stay open');
eq(W.isOpen({ returnReceived: null, closedOut: undefined }), true, 'nullish flags stay open');

// ── isOverdue ───────────────────────────────────────────────────────
console.log('\n-- overdue --');
eq(W.isOverdue({ dueDate: localDate(-1) }), true, 'yesterday is overdue');
eq(W.isOverdue({ dueDate: localDate(-30) }), true, '30 days ago is overdue');
eq(W.isOverdue({ dueDate: localDate(0) }), false, 'due TODAY is not yet overdue');
eq(W.isOverdue({ dueDate: localDate(1) }), false, 'tomorrow is not overdue');
eq(W.isOverdue({ dueDate: '' }), false, 'no due date is never overdue');
eq(W.isOverdue({}), false, 'missing due date is never overdue');
eq(W.isOverdue({ dueDate: 'not-a-date' }), false, 'unparseable due date is not overdue');

// THE POINT OF THE WHOLE CHANGE: a resolved warrant never reports overdue,
// no matter how far past due it is.
eq(W.isOverdue({ dueDate: localDate(-90), returnReceived: true }), false,
  'received return is not overdue');
eq(W.isOverdue({ dueDate: localDate(-90), closedOut: true }), false,
  'closed-out warrant is not overdue');
eq(W.isOverdue({ dueDate: localDate(-90), type: 'preservation', closedOut: true }), false,
  'closed-out PRESERVATION is not overdue (the reported bug)');
eq(W.isOverdue({ dueDate: localDate(-90), type: 'preservation' }), true,
  'an OPEN preservation request is still overdue until closed out');

// ── day arithmetic ──────────────────────────────────────────────────
console.log('\n-- day counts --');
eq(W.daysOverdue({ dueDate: localDate(-5) }), 5, '5 days overdue');
eq(W.daysOverdue({ dueDate: localDate(-1) }), 1, '1 day overdue');
eq(W.daysOverdue({ dueDate: localDate(0) }), 0, 'due today: 0 overdue');
eq(W.daysOverdue({ dueDate: localDate(5) }), 0, 'future due date: 0 overdue');
eq(W.daysOverdue({ dueDate: localDate(-5), closedOut: true }), 0, 'closed out: 0 overdue');

eq(W.daysUntilDue({ dueDate: localDate(10) }), 10, '10 days remaining');
eq(W.daysUntilDue({ dueDate: localDate(0) }), 0, 'due today: 0 remaining');
eq(W.daysUntilDue({ dueDate: localDate(-3) }), -3, 'overdue reads negative');
eq(W.daysUntilDue({}), null, 'no due date: null');

// DST guard: a 30-day window that crosses a DST boundary must still be 30
// days, not 29 or 31. Bare 'YYYY-MM-DD' parses as UTC, which is what the
// explicit 'T00:00:00' in the module exists to avoid.
(function dstCheck() {
  const marchRef = new Date(2026, 2, 20, 12, 0, 0);   // after US spring-forward
  const novRef = new Date(2026, 10, 10, 12, 0, 0);    // after US fall-back
  eq(W.daysUntilDue({ dueDate: '2026-04-19' }, marchRef), 30, 'spring: 30-day window intact');
  eq(W.daysUntilDue({ dueDate: '2026-12-10' }, novRef), 30, 'autumn: 30-day window intact');
  eq(W.isOverdue({ dueDate: '2026-03-19' }, marchRef), true, 'spring: day before ref is overdue');
  eq(W.isOverdue({ dueDate: '2026-03-20' }, marchRef), false, 'spring: ref day itself is not overdue');
})();

// Late-in-the-day guard: at 23:00 local, "due today" must still not be
// overdue. A naive UTC comparison flips this for eastern time zones.
(function lateDayCheck() {
  const lateToday = new Date(2026, 5, 15, 23, 0, 0);
  eq(W.isOverdue({ dueDate: '2026-06-15' }, lateToday), false, '11pm on the due date is not overdue');
  eq(W.isOverdue({ dueDate: '2026-06-14' }, lateToday), true, '11pm, due yesterday, is overdue');
})();

// ── hasNothingToReceive ─────────────────────────────────────────────
console.log('\n-- no-return types --');
eq(W.hasNothingToReceive({ type: 'preservation' }), true, 'preservation has nothing to receive');
eq(W.hasNothingToReceive({ type: 'PRESERVATION' }), true, 'type match is case-insensitive');
eq(W.hasNothingToReceive({ type: 'search' }), false, 'search warrant expects a return');
eq(W.hasNothingToReceive({ type: 'subpoena' }), false, 'subpoena expects a return');
eq(W.hasNothingToReceive({ type: 'court-order' }), false, 'court order expects a return');
eq(W.hasNothingToReceive({}), false, 'missing type expects a return');
eq(W.hasNothingToReceive(null), false, 'null has no type');

// ── label ───────────────────────────────────────────────────────────
console.log('\n-- labels --');
eq(W.label({ returnReceived: true }), 'Return received', 'received label');
eq(W.label({ type: 'preservation', closedOut: true }), 'Closed out (no return expected)',
  'preservation close-out label names the reason');
eq(W.label({ type: 'search', closedOut: true }), 'Closed out', 'generic close-out label');
eq(W.label({ dueDate: localDate(-4) }), '4 days overdue', 'overdue label');
eq(W.label({ dueDate: localDate(7) }), '7 days remaining', 'remaining label');
eq(W.label({}), 'Pending', 'no due date reads Pending');
eq(W.label(null), 'Unknown', 'null reads Unknown');

// A closed-out warrant's label must never mention overdue, even when its
// due date is long past — that is exactly the nagging the user reported.
ok(W.label({ type: 'preservation', dueDate: localDate(-120), closedOut: true }).indexOf('overdue') === -1,
  'closed-out preservation label says nothing about overdue');
ok(W.label({ dueDate: localDate(-120), returnReceived: true }).indexOf('overdue') === -1,
  'received-return label says nothing about overdue');

// ── legacy records ──────────────────────────────────────────────────
// Warrants created before this change have no closedOut field at all.
console.log('\n-- legacy records --');
const legacyOpen = { id: 1, type: 'search', dueDate: localDate(-10), returnReceived: false, returnReceivedAt: null };
eq(W.isOpen(legacyOpen), true, 'legacy open warrant still open');
eq(W.isOverdue(legacyOpen), true, 'legacy open warrant still flags overdue');
const legacyDone = { id: 2, type: 'search', dueDate: localDate(-10), returnReceived: true, returnReceivedAt: '2026-01-02T03:04:05.000Z' };
eq(W.isOverdue(legacyDone), false, 'legacy received warrant stays silent');

// ── PRTT: orders that expire ────────────────────────────────────────
console.log('\n-- PRTT expiration --');
const prtt = (offset, extra) => Object.assign({ id: 9, type: 'prtt', expirationDate: localDate(offset) }, extra || {});

eq(W.hasExpiration({ type: 'prtt' }), true, 'prtt carries an expiration');
eq(W.hasExpiration({ type: 'PRTT' }), true, 'expiring type match is case-insensitive');
eq(W.hasExpiration({ type: 'search', expirationDate: localDate(-3) }), false, 'a search warrant never expires, even with a stray date');
eq(W.hasExpiration(null), false, 'null does not expire');
eq(W.hasNothingToReceive({ type: 'prtt' }), false, 'a PRTT still produces data');

eq(W.daysUntilExpiration(prtt(10)), 10, '10 days out');
eq(W.daysUntilExpiration(prtt(0)), 0, 'expires today is 0');
eq(W.daysUntilExpiration(prtt(-4)), -4, 'lapsed 4 days is -4');
eq(W.daysUntilExpiration({ type: 'prtt' }), null, 'no date → null');
eq(W.daysUntilExpiration({ type: 'prtt', expirationDate: 'garbage' }), null, 'unparseable date → null');

// The officer asked to be told WHEN the date occurs — so the alert is live
// on the date itself, not the day after.
eq(W.isExpired(prtt(1)), false, 'tomorrow is not yet expired');
eq(W.isExpired(prtt(0)), true, 'the expiration date itself raises the alert');
eq(W.isExpired(prtt(-30)), true, 'long past is expired');
eq(W.needsExpirationAlert(prtt(0)), true, 'expires today → alert');
eq(W.needsExpirationAlert(prtt(1)), false, 'tomorrow → no alert yet');
eq(W.needsExpirationAlert({ type: 'prtt' }), false, 'no date → never alerts');
eq(W.needsExpirationAlert(null), false, 'null never alerts');

// An explicit "now" is honoured (the dashboard passes none; tests pin it).
const fixedNow = new Date(2026, 9, 14, 15, 30); // 14 Oct 2026, mid-afternoon
eq(W.isExpired({ type: 'prtt', expirationDate: '2026-10-14' }, fixedNow), true, 'afternoon of the expiration date is expired');
eq(W.isExpired({ type: 'prtt', expirationDate: '2026-10-15' }, fixedNow), false, 'day before is not');

// Acknowledgement hides THAT date only.
const ackd = prtt(-2);
eq(W.acknowledgeExpiration(ackd, '2026-10-14T12:00:00.000Z'), ackd, 'acknowledge returns the warrant');
eq(ackd.expirationAcknowledgedAt, '2026-10-14T12:00:00.000Z', 'acknowledged-at recorded');
eq(ackd.expirationAcknowledgedFor, ackd.expirationDate, 'the acknowledged date is recorded');
eq(W.isExpirationAcknowledged(ackd), true, 'reads back as acknowledged');
eq(W.needsExpirationAlert(ackd), false, 'acknowledged → alert hidden');
eq(W.isExpired(ackd), true, 'acknowledging does not pretend the order is still live');

// Extended order: new date, the old acknowledgement no longer applies.
ackd.expirationDate = localDate(0);
eq(W.isExpirationAcknowledged(ackd), false, 'an extended order is no longer acknowledged');
eq(W.needsExpirationAlert(ackd), true, 'and alerts again on its new date');
ackd.expirationDate = localDate(30);
eq(W.needsExpirationAlert(ackd), false, 'extended into the future → quiet until then');

eq(W.acknowledgeExpiration({ type: 'prtt' }), null, 'nothing to acknowledge without a date');
eq(W.acknowledgeExpiration({ type: 'search', expirationDate: localDate(-1) }), null, 'a non-expiring type is never acknowledged');
const noAckWritten = { type: 'prtt' };
W.acknowledgeExpiration(noAckWritten);
eq('expirationAcknowledgedAt' in noAckWritten, false, 'a refused acknowledgement writes nothing');

// Close-out silences it; a received return does not.
eq(W.needsExpirationAlert(prtt(-1, { closedOut: true })), false, 'closed out → no expiration alert');
eq(W.needsExpirationAlert(prtt(-1, { returnReceived: true })), true, 'data received does not mean the order is still running');

// The production-overdue rule is untouched by an expiration date.
eq(W.isOverdue(prtt(-10)), false, 'an expired PRTT is not "overdue" — it has no production deadline');

// Wording.
eq(W.expirationLabel(prtt(0)), 'Expires today', 'today wording');
eq(W.expirationLabel(prtt(1)), 'Expires tomorrow', 'tomorrow wording');
eq(W.expirationLabel(prtt(12)), 'Expires in 12 days', 'future wording');
eq(W.expirationLabel(prtt(-1)), 'Expired 1 day ago', 'singular past wording');
eq(W.expirationLabel(prtt(-5)), 'Expired 5 days ago', 'plural past wording');
eq(W.expirationLabel({ type: 'prtt' }), '', 'no date → no wording');
eq(W.label(prtt(-5)), 'Expired 5 days ago', 'label() uses the expiration wording for a PRTT');
eq(W.label(prtt(12, { returnReceived: true })), 'Expires in 12 days', 'expiry outranks "return received" — it is the live fact');
eq(W.label(prtt(-5, { closedOut: true })), 'Closed out', 'a closed-out PRTT reads Closed out');
eq(W.label({ type: 'prtt' }), 'Pending', 'a PRTT with no date reads Pending');

eq(W.typeLabel({ type: 'prtt' }), 'PRTT (Pen Register / Trap & Trace)', 'PRTT type label');
eq(W.typeLabel({ type: 'court-order' }), 'Court Order', 'court order type label');
eq(W.typeLabel({ type: 'custom-thing' }), 'custom-thing', 'an unknown type comes back as stored');
eq(W.typeLabel({}), 'Warrant', 'no type reads Warrant');

// ── surface ─────────────────────────────────────────────────────────
console.log('\n-- module surface --');
['isResolved', 'isOpen', 'isOverdue', 'daysOverdue', 'daysUntilDue', 'hasNothingToReceive', 'label',
 'typeLabel', 'hasExpiration', 'daysUntilExpiration', 'isExpired', 'isExpirationAcknowledged',
 'needsExpirationAlert', 'acknowledgeExpiration', 'expirationLabel']
  .forEach(fn => eq(typeof W[fn], 'function', `exports ${fn}()`));
ok(Array.isArray(W.EXPIRING_TYPES) && W.EXPIRING_TYPES.indexOf('prtt') !== -1, 'EXPIRING_TYPES contains prtt');
ok(Array.isArray(W.NO_RETURN_TYPES), 'exports NO_RETURN_TYPES array');
eq(W.NO_RETURN_TYPES.indexOf('preservation') !== -1, true, 'NO_RETURN_TYPES contains preservation');

console.log(`\nwarrant-status: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
