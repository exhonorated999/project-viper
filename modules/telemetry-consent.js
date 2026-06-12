/**
 * ViperTelemetryConsent — first-launch consent dialog for demo telemetry.
 *
 * Shows a modal asking the user to opt in to anonymous usage stats.
 * Only appears for demo users who haven't made a decision yet.
 * Escape / click-outside = Decline (default deny).
 */
(function () {
  "use strict";

  var STORAGE_PREFIX = "viper_";
  var CONSENT_KEY    = STORAGE_PREFIX + "telemetry_consent";

  var ViperTelemetryConsent = {
    /**
     * Maybe show the consent dialog.
     * @param {object} opts
     * @param {function} opts.onDecision - called with "granted" or "denied"
     */
    maybeShow: function (opts) {
      try {
        opts = opts || {};
        var onDecision = typeof opts.onDecision === "function" ? opts.onDecision : function () {};

        // Already decided?
        var existing = localStorage.getItem(CONSENT_KEY);
        if (existing === "granted" || existing === "denied") {
          onDecision(existing);
          return;
        }

        // Licensed user? Auto-deny (no telemetry for licensed users).
        var status = "unknown";
        try {
          if (window.ViperLicensing && typeof window.ViperLicensing.getLicenseStatus === "function") {
            var ls = window.ViperLicensing.getLicenseStatus();
            status = ls && ls.status ? ls.status : "unknown";
          }
        } catch (_) {}

        if (status !== "demo") {
          // Not a demo user — deny silently
          try { localStorage.setItem(CONSENT_KEY, "denied"); } catch (_) {}
          onDecision("denied");
          return;
        }

        // Demo user, no decision yet — show the modal
        _showModal(onDecision);
      } catch (_) {
        // On any error, default deny
        try { localStorage.setItem(CONSENT_KEY, "denied"); } catch (_2) {}
        if (opts && typeof opts.onDecision === "function") opts.onDecision("denied");
      }
    },
  };

  function _showModal(onDecision) {
    // Remove any existing consent modal
    var existing = document.getElementById("viperTelemetryConsentModal");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "viperTelemetryConsentModal";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;" +
      "background-color:rgba(0,0,0,0.7);backdrop-filter:blur(5px);";

    var card = document.createElement("div");
    card.style.cssText =
      "background:rgba(26,35,50,0.95);border:1px solid rgba(0,217,255,0.3);" +
      "border-radius:16px;padding:32px;max-width:520px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);" +
      "animation:viperConsentSlideIn 0.3s ease-out;";

    card.innerHTML =
      '<style>' +
        '@keyframes viperConsentSlideIn {' +
          'from { transform:translateY(-30px); opacity:0; }' +
          'to { transform:translateY(0); opacity:1; }' +
        '}' +
      '</style>' +
      '<h3 style="font-size:20px;font-weight:700;color:#fff;margin:0 0 16px 0;font-family:Inter,system-ui,sans-serif;">' +
        'Help us improve V.I.P.E.R.' +
      '</h3>' +
      '<p style="font-size:14px;color:#9ca3af;line-height:1.6;margin:0 0 12px 0;font-family:Inter,system-ui,sans-serif;">' +
        'This 60-day demo can send anonymous usage stats so we can prioritize the features investigators actually use.' +
      '</p>' +
      '<p style="font-size:13px;color:#00d9ff;line-height:1.6;margin:0 0 6px 0;font-family:Inter,system-ui,sans-serif;">' +
        '<strong style="color:#00d9ff;">What we send:</strong> app version, which modules you open, session length, day of demo (1–60), and your registered email so we can support you.' +
      '</p>' +
      '<p style="font-size:13px;color:#f87171;line-height:1.6;margin:0 0 20px 0;font-family:Inter,system-ui,sans-serif;">' +
        '<strong style="color:#f87171;">What we never send:</strong> case content, suspect/victim names, file contents, screenshots, keystrokes, IP addresses, or anything from your case files.' +
      '</p>' +
      '<p style="font-size:12px;color:#6b7280;margin:0 0 24px 0;font-family:Inter,system-ui,sans-serif;">' +
        'You can change this anytime in Settings.' +
      '</p>' +
      '<div style="display:flex;gap:12px;justify-content:flex-end;">' +
        '<button id="viperConsentDecline" style="' +
          'padding:10px 24px;border-radius:8px;border:1px solid rgba(107,114,128,0.5);' +
          'background:transparent;color:#9ca3af;font-size:14px;font-weight:500;cursor:pointer;' +
          'font-family:Inter,system-ui,sans-serif;transition:background 0.2s;">' +
          'Decline' +
        '</button>' +
        '<button id="viperConsentAllow" style="' +
          'padding:10px 24px;border-radius:8px;border:1px solid rgba(0,217,255,0.5);' +
          'background:rgba(0,217,255,0.15);color:#00d9ff;font-size:14px;font-weight:600;cursor:pointer;' +
          'font-family:Inter,system-ui,sans-serif;transition:background 0.2s;">' +
          'Allow' +
        '</button>' +
      '</div>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function decide(value) {
      try { localStorage.setItem(CONSENT_KEY, value); } catch (_) {}
      var el = document.getElementById("viperTelemetryConsentModal");
      if (el) el.remove();
      onDecision(value);
    }

    // Button handlers
    document.getElementById("viperConsentAllow").addEventListener("click", function (e) {
      e.stopPropagation();
      decide("granted");
    });
    document.getElementById("viperConsentDecline").addEventListener("click", function (e) {
      e.stopPropagation();
      decide("denied");
    });

    // Escape key = Decline
    function onKey(e) {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        decide("denied");
      }
    }
    document.addEventListener("keydown", onKey);

    // Click outside card = Decline
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        decide("denied");
      }
    });
  }

  // Expose globally
  window.ViperTelemetryConsent = ViperTelemetryConsent;
})();
