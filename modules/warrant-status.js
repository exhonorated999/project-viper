/*
 * modules/warrant-status.js
 *
 * ONE definition of "is this warrant still outstanding?".
 *
 * The overdue predicate used to be copy-pasted in five places
 * (case-detail-with-analytics.html sort + card render, and index.html's
 * DA report, checkOverdueWarrants, updateWarrantAlerts and
 * getOverdueWarrantsList).  When preservation-request close-out was added,
 * missing even one of those sites would have left the detective still being
 * nagged about a request that has nothing to receive.  So the rule lives
 * here and every site calls it.
 *
 * A warrant stops generating alerts when EITHER:
 *   - returnReceived  — the provider's production actually came back, or
 *   - closedOut       — the examiner explicitly closed it out.  Used for
 *                       preservation requests, which produce nothing to
 *                       receive; the provider simply holds the data.
 *
 * `closedOut` is deliberately a separate flag from `returnReceived`.
 * Recording "return received" for a preservation request would be a false
 * statement in a case file, and the distinction has to survive into the DA
 * report.
 *
 * Pure: no DOM, no localStorage.  Node-testable.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.WarrantStatus = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
    'use strict';

    /** Warrant types that never have a production to receive. */
    const NO_RETURN_TYPES = ['preservation'];

    /**
     * True when the warrant has been resolved one way or the other and must
     * no longer raise alerts anywhere in the app.
     */
    function isResolved(w) {
        if (!w) return false;
        return !!(w.returnReceived || w.closedOut);
    }

    /** True when the warrant is still awaiting action. */
    function isOpen(w) {
        return !!w && !isResolved(w);
    }

    /**
     * True when an OPEN warrant is past its due date.  Due dates are stored
     * as bare 'YYYY-MM-DD'; parsing them with an explicit 'T00:00:00'
     * forces LOCAL midnight (bare 'YYYY-MM-DD' parses as UTC, which shifts
     * the date by a day for anyone west of Greenwich and would show a
     * warrant as overdue before it actually is).
     */
    function isOverdue(w, now) {
        if (!isOpen(w) || !w.dueDate) return false;
        const due = parseDueDate(w.dueDate);
        if (!due) return false;
        const ref = now ? new Date(now) : new Date();
        ref.setHours(0, 0, 0, 0);
        return due < ref;
    }

    /** Whole days overdue (0 when not overdue). */
    function daysOverdue(w, now) {
        if (!isOverdue(w, now)) return 0;
        const due = parseDueDate(w.dueDate);
        const ref = now ? new Date(now) : new Date();
        ref.setHours(0, 0, 0, 0);
        return Math.round((ref - due) / 86400000);
    }

    /** Signed day delta to the due date: negative = overdue. */
    function daysUntilDue(w, now) {
        if (!w || !w.dueDate) return null;
        const due = parseDueDate(w.dueDate);
        if (!due) return null;
        const ref = now ? new Date(now) : new Date();
        ref.setHours(0, 0, 0, 0);
        return Math.ceil((due - ref) / 86400000);
    }

    function parseDueDate(v) {
        if (!v) return null;
        const s = String(v);
        const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
        if (isNaN(d.getTime())) return null;
        d.setHours(0, 0, 0, 0);
        return d;
    }

    /** True for warrant types with nothing to receive from the provider. */
    function hasNothingToReceive(w) {
        if (!w) return false;
        return NO_RETURN_TYPES.indexOf(String(w.type || '').toLowerCase()) !== -1;
    }

    /**
     * Short human status for lists and reports.  Kept here so the wording is
     * identical in the UI and the DA report.
     */
    function label(w, now) {
        if (!w) return 'Unknown';
        if (w.returnReceived) return 'Return received';
        if (w.closedOut) return hasNothingToReceive(w) ? 'Closed out (no return expected)' : 'Closed out';
        if (isOverdue(w, now)) return daysOverdue(w, now) + ' days overdue';
        const n = daysUntilDue(w, now);
        if (n === null) return 'Pending';
        return n + ' days remaining';
    }

    return {
        NO_RETURN_TYPES: NO_RETURN_TYPES,
        isResolved: isResolved,
        isOpen: isOpen,
        isOverdue: isOverdue,
        daysOverdue: daysOverdue,
        daysUntilDue: daysUntilDue,
        hasNothingToReceive: hasNothingToReceive,
        label: label,
    };
});
