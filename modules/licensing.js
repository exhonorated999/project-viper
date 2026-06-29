/**
 * Licensing module for V.I.P.E.R.
 * Communicates with the Intellect Unified Dashboard API.
 */
const PRODUCT_SLUG = "project-viper";
const STORAGE_PREFIX = "viper_";
const API_BASE = "https://intellect-unified-dashboard-production.up.railway.app";
const DEMO_DAYS = 60;
let APP_VERSION = "0.0.0"; // populated at runtime from Electron app.getVersion()

// Fetch version from Electron main process (package.json)
(async () => {
  try {
    if (window.electronAPI && window.electronAPI.getAppVersion) {
      APP_VERSION = await window.electronAPI.getAppVersion();
    }
  } catch { /* fallback stays 0.0.0 */ }
})();

/* ---------- helpers ---------- */
function _get(key) { return localStorage.getItem(STORAGE_PREFIX + key); }
function _set(key, v) { localStorage.setItem(STORAGE_PREFIX + key, v); }
function _remove(key) { localStorage.removeItem(STORAGE_PREFIX + key); }

function _daysBetween(a, b) {
  return Math.floor((b - a) / 86400000);
}

// Dev-build detection (cached synchronously at module load).  Unpackaged
// builds launched via `npm start` (electron .) unlock ALL features so the
// team can test without a demo/license — production packaged builds are
// unaffected.
const _IS_DEV_BUILD = (() => {
  try {
    return !!(typeof window !== 'undefined' && window.electronAPI &&
      typeof window.electronAPI.isDevBuild === 'function' && window.electronAPI.isDevBuild());
  } catch { return false; }
})();

/* ---------- status ---------- */
function getLicenseStatus() {
  // Dev build: fully unlocked, no demo/expiry gating.
  if (_IS_DEV_BUILD) {
    return { registered: true, status: "licensed", licenseType: "dev", daysLeft: Infinity, canCreate: true, devBuild: true };
  }

  const licenseKey = _get("license_key");
  const licenseType = _get("license_type");
  const registeredAt = _get("registered_at");
  const expiresAt = _get("expires_at");

  if (!registeredAt) {
    return { registered: false, status: "unregistered", daysLeft: 0, canCreate: false };
  }

  // Has a paid license
  if (licenseKey && licenseType && licenseType !== "demo") {
    const expired = expiresAt ? new Date(expiresAt) < new Date() : false;
    return {
      registered: true,
      status: expired ? "expired" : "licensed",
      licenseType,
      daysLeft: expiresAt ? _daysBetween(new Date(), new Date(expiresAt)) : Infinity,
      canCreate: !expired,
    };
  }

  // Demo
  const start = new Date(registeredAt);
  const demoEnd = new Date(start.getTime() + DEMO_DAYS * 86400000);
  const daysLeft = _daysBetween(new Date(), demoEnd);
  const expired = daysLeft < 0;

  return {
    registered: true,
    status: expired ? "demo_expired" : "demo",
    licenseType: "demo",
    daysLeft: Math.max(daysLeft, 0),
    canCreate: !expired,
  };
}

function canCreateCases() {
  return getLicenseStatus().canCreate;
}

/* ---------- registration ---------- */
async function registerDemo(data) {
  const body = {
    product_slug: PRODUCT_SLUG,
    name: data.name,
    contact_email: data.email,
    agency: data.agency || "",
    address: data.address || "",
  };

  const res = await fetch(`${API_BASE}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = Array.isArray(err.detail) ? err.detail.map(e => e.msg).join(", ") : err.detail;
    throw new Error(detail || "Registration failed");
  }

  const json = await res.json();
  _set("registered_at", new Date().toISOString());
  _set("api_key", json.api_key);
  _set("customer_name", data.name);
  _set("contact_email", data.email);
  if (data.agency) _set("agency", data.agency);
  return json;
}

/* ---------- activation ---------- */
async function activateLicense(licenseKey) {
  const apiKey = _get("api_key");
  if (!apiKey) throw new Error("Not registered — register first.");

  const res = await fetch(`${API_BASE}/api/license/activate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ license_key: licenseKey, product_slug: PRODUCT_SLUG }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = Array.isArray(err.detail) ? err.detail.map(e => e.msg).join(", ") : err.detail;
    throw new Error(detail || "Activation failed");
  }

  const json = await res.json();
  if (!json.valid) {
    throw new Error(json.message || "Activation failed");
  }
  _set("license_key", licenseKey);
  _set("license_type", json.license_type || "standard");
  if (json.expires_at) _set("expires_at", json.expires_at);
  // Audit: license activation. Fire-and-forget; failures here must
  // never break activation. window.electronAPI may not exist in a
  // test/jsdom environment.
  try {
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.auditLogWrite) {
      window.electronAPI.auditLogWrite({
        event: 'license_activated',
        data: {
          license_type: json.license_type || 'standard',
          expires_at: json.expires_at || null,
          product_slug: PRODUCT_SLUG,
        }
      });
    }
  } catch (_) {}
  return json;
}

/* ---------- validation ---------- */
async function validateLicense() {
  const apiKey = _get("api_key");
  const licenseKey = _get("license_key");
  if (!apiKey || !licenseKey) return null;

  try {
    const res = await fetch(`${API_BASE}/api/license/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ license_key: licenseKey }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ---------- API key self-heal ---------- */
// Re-syncs viper_api_key when the dashboard reports it invalid/inactive.
//
// Why this exists: the api key and license key both live in localStorage
// (viper_ prefix). A backup/restore after a re-registration can leave the
// LOCAL api key stale — the server rotated the key hash during the
// re-register, but the restore wrote the OLD key back over it. The license
// key keeps working because it's only ever checked locally (lifetime,
// no server validation), but every live /api/* call then 401s with
// "invalid or inactive API key".
//
// Registration is idempotent server-side: POST /api/register matches the
// customer by email, REUSES that row (paid license untouched — it lives on
// a separate License row), and rotates + returns a fresh api key. So we can
// silently re-register with the stored email/name to obtain a valid key.
//
// IMPORTANT: this updates ONLY viper_api_key. It never touches
// license_key / license_type / expires_at / registered_at, so a paid
// lifetime license is never disturbed.
function _looksLikeBadApiKey(msg) {
  return /invalid or inactive api key|missing api key/i.test(String(msg || ''));
}

async function refreshApiKey() {
  const email = _get("contact_email");
  const name  = _get("customer_name");
  if (!email || !name) {
    throw new Error("Cannot refresh API key — no registration email/name on file. Please re-register from Settings.");
  }
  const body = {
    product_slug: PRODUCT_SLUG,
    name,
    contact_email: email,
    agency: _get("agency") || "",
    address: _get("address") || "",
  };
  const res = await fetch(`${API_BASE}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = Array.isArray(err.detail) ? err.detail.map(e => e.msg).join(", ") : err.detail;
    throw new Error(detail || "API key refresh failed");
  }
  const json = await res.json();
  if (!json || !json.api_key) throw new Error("API key refresh returned no key");
  _set("api_key", json.api_key);   // ONLY the api key — license fields left alone
  return json.api_key;
}

/* ---------- parser-submission with api-key self-heal ---------- */
// Wraps the parser-sample submit IPC. If the server rejects the stored
// api key as invalid/inactive, it transparently refreshes the key (see
// refreshApiKey) and retries once. Callers pass the same opts they'd give
// window.electronAPI.parserSampleSubmit, minus apiKey (we inject it).
async function submitParserSample(opts) {
  if (!window.electronAPI || !window.electronAPI.parserSampleSubmit) {
    throw new Error('Submit unavailable in this build');
  }
  let apiKey = _get("api_key");
  if (!apiKey) {
    // No key at all — try to mint one from the stored registration.
    apiKey = await refreshApiKey();
  }
  const call = (key) => window.electronAPI.parserSampleSubmit(Object.assign({}, opts, { apiKey: key }));

  let res = await call(apiKey);
  if (res && res.success === false && _looksLikeBadApiKey(res.error)) {
    // Stale key — self-heal and retry exactly once.
    const fresh = await refreshApiKey();
    res = await call(fresh);
  }
  return res;
}

/* ---------- update checker ---------- */
async function checkForUpdate() {
  try {
    const res = await fetch(
      `${API_BASE}/api/updates/${PRODUCT_SLUG}/latest?current_version=${encodeURIComponent(APP_VERSION)}`
    );
    if (!res.ok) return { updateAvailable: false };
    const body = await res.json();
    return {
      updateAvailable: body.update_available || false,
      latestVersion: body.latest_version,
      changelog: body.changelog,
      downloadUrl: body.download_url ? `${API_BASE}${body.download_url}` : undefined,
    };
  } catch {
    return { updateAvailable: false };
  }
}

/* ---------- exports (global) ---------- */
window.ViperLicensing = {
  PRODUCT_SLUG,
  APP_VERSION,
  DEMO_DAYS,
  getLicenseStatus,
  canCreateCases,
  registerDemo,
  activateLicense,
  validateLicense,
  refreshApiKey,
  submitParserSample,
  checkForUpdate,
};
