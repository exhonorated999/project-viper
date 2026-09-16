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

// ── surface ─────────────────────────────────────────────────────────
console.log('\n-- module surface --');
['isResolved', 'isOpen', 'isOverdue', 'daysOverdue', 'daysUntilDue', 'hasNothingToReceive', 'label']
  .forEach(fn => eq(typeof W[fn], 'function', `exports ${fn}()`));
ok(Array.isArray(W.NO_RETURN_TYPES), 'exports NO_RETURN_TYPES array');
eq(W.NO_RETURN_TYPES.indexOf('preservation') !== -1, true, 'NO_RETURN_TYPES contains preservation');

console.log(`\nwarrant-status: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
