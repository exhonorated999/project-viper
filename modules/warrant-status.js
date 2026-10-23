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
        // Both sides are local midnight, so the gap is whole days ± 1 h when
        // a DST change falls in between — round, don't ceil (ceil gave
        // "11 days remaining" for a 10-day warrant across the November change).
        return Math.round((due - ref) / 86400000);
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

    /* ------------------------------------------------------------------
     * Orders that EXPIRE — Pen Register / Trap & Trace (PRTT)
     * ------------------------------------------------------------------
     * A PRTT order authorises collection for a fixed period and then lapses.
     * What the detective needs is not a production deadline but a warning
     * the day the authority runs out, so it can be renewed or wound down.
     *
     * The date lives in its OWN field, `expirationDate` (bare 'YYYY-MM-DD',
     * date-only like dueDate), and never in dueDate: every overdue site in
     * the app reads dueDate as "production owed by", and an expiry is not
     * that.
     *
     * The alert fires ON the expiration date, not the day after — the
     * officer asked to be told "when that expiration date occurs", and the
     * last day of authority is the day there is still time to act.
     *
     * Acknowledging records WHICH date was acknowledged
     * (`expirationAcknowledgedFor`). An order that is extended gets a new
     * expirationDate, the two no longer match, and the alert comes back on
     * the new date without anyone having to remember to un-acknowledge it.
     *
     * A close-out also silences it: "Close Out" already means "stop the
     * alerts for this one" everywhere else in the warrant module. A received
     * return does NOT — data arriving says nothing about whether the order
     * has lapsed.
     */
    const EXPIRING_TYPES = ['prtt'];

    const TYPE_LABELS = {
        search: 'Search Warrant',
        arrest: 'Arrest Warrant',
        preservation: 'Preservation Request',
        subpoena: 'Subpoena',
        'court-order': 'Court Order',
        prtt: 'PRTT (Pen Register / Trap & Trace)',
        other: 'Other',
    };

    /** Readable name for a warrant type; unknown types come back as stored. */
    function typeLabel(w) {
        const t = String((w && w.type) || '').toLowerCase();
        if (!t) return 'Warrant';
        return TYPE_LABELS[t] || String(w.type);
    }

    /** True for order types that carry an expiration date. */
    function hasExpiration(w) {
        if (!w) return false;
        return EXPIRING_TYPES.indexOf(String(w.type || '').toLowerCase()) !== -1;
    }

    /** Signed whole days to expiry: 0 = expires today, negative = lapsed. */
    function daysUntilExpiration(w, now) {
        if (!hasExpiration(w) || !w.expirationDate) return null;
        const exp = parseDueDate(w.expirationDate);
        if (!exp) return null;
        const ref = now ? new Date(now) : new Date();
        ref.setHours(0, 0, 0, 0);
        return Math.round((exp - ref) / 86400000);
    }

    /** True from the expiration date onward. */
    function isExpired(w, now) {
        const n = daysUntilExpiration(w, now);
        return n !== null && n <= 0;
    }

    /** True when THIS expiration date has been acknowledged. */
    function isExpirationAcknowledged(w) {
        if (!w || !w.expirationAcknowledgedAt || !w.expirationDate) return false;
        return w.expirationAcknowledgedFor === w.expirationDate;
    }

    /** True when the dashboard should be showing an expiration alert. */
    function needsExpirationAlert(w, now) {
        if (!w || w.closedOut) return false;
        return isExpired(w, now) && !isExpirationAcknowledged(w);
    }

    /**
     * Mark the current expiration date acknowledged. Mutates and returns the
     * warrant. Does nothing (returns null) when there is no date to
     * acknowledge, so a stray click can never write a meaningless record.
     */
    function acknowledgeExpiration(w, nowIso) {
        if (!hasExpiration(w) || !w.expirationDate) return null;
        w.expirationAcknowledgedAt = nowIso || new Date().toISOString();
        w.expirationAcknowledgedFor = w.expirationDate;
        return w;
    }

    /** Expiration wording shared by the card, the header chip and reports. */
    function expirationLabel(w, now) {
        const n = daysUntilExpiration(w, now);
        if (n === null) return '';
        if (n === 0) return 'Expires today';
        if (n === -1) return 'Expired 1 day ago';
        if (n < 0) return 'Expired ' + (-n) + ' days ago';
        if (n === 1) return 'Expires tomorrow';
        return 'Expires in ' + n + ' days';
    }

    /**
     * Short human status for lists and reports.  Kept here so the wording is
     * identical in the UI and the DA report.
     */
    function label(w, now) {
        if (!w) return 'Unknown';
        if (w.closedOut && hasExpiration(w)) return 'Closed out';
        if (hasExpiration(w) && w.expirationDate) {
            const lbl = expirationLabel(w, now);
            if (lbl) return lbl;
        }
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
        EXPIRING_TYPES: EXPIRING_TYPES,
        typeLabel: typeLabel,
        hasExpiration: hasExpiration,
        daysUntilExpiration: daysUntilExpiration,
        isExpired: isExpired,
        isExpirationAcknowledged: isExpirationAcknowledged,
        needsExpirationAlert: needsExpirationAlert,
        acknowledgeExpiration: acknowledgeExpiration,
        expirationLabel: expirationLabel,
    };
});
