/**
 * Tests for modules/storage-guard.js
 * Run: node modules/__tests__/storage-guard.test.js
 *
 * storage-guard.js is a browser module that ends in `window.X = X`, so we
 * load it with vm and set sandbox.window = sandbox, making
 * `window === globalThis` exactly as it is in a real renderer. (Getting
 * this wrong hides scoping bugs - see THE HOST-SCOPING TRAP.)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name); }
}
function eq(a, b, name) {
  ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'storage-guard.js'), 'utf8');

// ── Harness ─────────────────────────────────────────────────────────
function makeLocalStorage(initial, opts) {
  opts = opts || {};
  const store = Object.assign({}, initial);
  const writes = [];
  return {
    _store: store,
    _writes: writes,
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) {
      if (opts.throwOnWrite) throw new Error('QuotaExceededError');
      writes.push(k);
      store[k] = String(v);
    },
    removeItem(k) { delete store[k]; },
  };
}

function makeDom() {
  const appended = [];
  const stub = () => ({
    style: {}, set onclick(v) { this._onclick = v; }, get onclick() { return this._onclick; },
    textContent: '',
  });
  const byId = {};
  return {
    appended,
    byId,
    document: {
      body: { appendChild(el) { appended.push(el); } },
      createElement() {
        return { style: {}, setAttribute() {}, innerHTML: '', id: '' };
      },
      getElementById(id) {
        if (id === 'viperStorageFault') {
          return appended.length ? appended[0] : null;
        }
        if (!byId[id]) byId[id] = stub();
        return byId[id];
      },
      addEventListener() {},
    },
  };
}

function load(opts) {
  opts = opts || {};
  const dom = makeDom();
  const ls = opts.localStorage || makeLocalStorage({});
  const calls = { updateInstallMarker: [], getStorageHealth: 0, getRegistration: 0 };

  const electronAPI = opts.noIpc ? undefined : {
    getStorageHealth: async () => {
      calls.getStorageHealth++;
      if (opts.healthThrows) throw new Error('ipc down');
      return opts.health || { hasInstallMarker: false, marker: null };
    },
    getInstallMarkerRegistration: async () => {
      calls.getRegistration++;
      return opts.markerRegistration || null;
    },
    updateInstallMarker: async (payload) => {
      calls.updateInstallMarker.push(payload);
      return { success: true };
    },
  };

  const sandbox = {
    localStorage: ls,
    document: dom.document,
    location: { reload() { calls.reloaded = true; } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => fn,
  };
  sandbox.window = sandbox;          // window === globalThis, as in Chromium
  if (electronAPI) sandbox.electronAPI = electronAPI;
  sandbox.window.electronAPI = electronAPI;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { guard: sandbox.window.ViperStorageGuard, ls, calls, dom, sandbox };
}

const REGISTERED = {
  viper_registered_at: '2026-05-20T10:00:00.000Z',
  viper_api_key: 'ak_live_123',
  viper_license_key: 'VIPER-STD-ABC',
  viper_license_type: 'standard',
  viper_customer_name: 'Josh Berzanji',
  viper_contact_email: 'josh@example.gov',
  viperCases: JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]),
};

(async function run() {

  // 1. Healthy install -------------------------------------------------
  {
    const { guard, calls } = load({
      localStorage: makeLocalStorage(REGISTERED),
      health: { hasInstallMarker: true, marker: { lastHealthyAt: '2026-09-01' } },
    });
    const r = await guard.run();
    eq(r.verdict, 'ok', 'registered + marker -> ok');
    // markHealthy is fire-and-forget; give the microtask queue a turn.
    await new Promise(res => setTimeout(res, 0));
    ok(calls.updateInstallMarker.length === 1, 'marker refreshed on healthy boot');
    const payload = calls.updateInstallMarker[0] || {};
    eq(payload.caseCount, 3, 'case count mirrored to marker');
    eq(payload.registration.license_key, 'VIPER-STD-ABC', 'license key mirrored');
    eq(payload.registration.api_key, 'ak_live_123', 'api key mirrored');
    ok(!('viperCases' in (payload.registration || {})), 'case data NOT put in the marker');
  }

  // 2. Genuinely new install -------------------------------------------
  {
    const { guard, dom } = load({
      localStorage: makeLocalStorage({}),
      health: { hasInstallMarker: false, marker: null },
    });
    const r = await guard.run();
    eq(r.verdict, 'new-install', 'no marker + empty storage -> new install');
    eq(dom.appended.length, 0, 'no fault screen for a real new install');
  }

  // 3. THE PHANTOM RESET (Josh's incident) ------------------------------
  {
    const ls = makeLocalStorage({});
    const { guard, dom, calls } = load({
      localStorage: ls,
      health: {
        hasInstallMarker: true,
        userDataExistedAtBoot: true,
        localStorageExistedAtBoot: false,
        userDataCloudProvider: 'OneDrive',
        casesCloudProvider: 'OneDrive',
        userDataPath: 'C:\\Users\\josh\\OneDrive\\VIPER',
        casesPath: 'C:\\Users\\josh\\OneDrive\\VIPER Cases',
        marker: {
          lastHealthyAt: '2026-09-14T08:00:00.000Z',
          lastKnownCaseCount: 12,
          hasRegistration: true,
        },
      },
    });
    const r = await guard.run();
    eq(r.verdict, 'storage-fault', 'marker + empty storage -> storage fault');
    eq(dom.appended.length, 1, 'fault screen displayed');
    ok(r.reasons.some(x => /OneDrive/.test(x)), 'reason names the cloud provider');
    ok(r.reasons.some(x => /12 case/.test(x)), 'reason states how many cases existed');
    ok(r.reasons.some(x => /database files were not present/i.test(x)),
       'reason explains the database was missing');

    // SAFETY INVARIANT: during a fault the guard must not persist anything
    // except its transient write-probe. Writing real values into a freshly
    // created empty LevelDB is what would diverge from the user's real data.
    const realWrites = ls._writes.filter(k => k !== '__viper_storage_probe__');
    eq(realWrites.length, 0, 'guard writes NOTHING to localStorage during a fault');
    eq(calls.updateInstallMarker.length, 0, 'guard does not overwrite the marker during a fault');
  }

  // 4. Fail open when IPC is unavailable or broken ----------------------
  {
    const { guard, dom } = load({ localStorage: makeLocalStorage({}), noIpc: true });
    const r = await guard.run();
    eq(r.verdict, 'ok', 'no electronAPI -> fail open (never block on missing IPC)');
    eq(dom.appended.length, 0, 'no fault screen without IPC');
  }
  {
    const { guard } = load({ localStorage: makeLocalStorage({}), healthThrows: true });
    const r = await guard.run();
    eq(r.verdict, 'ok', 'health IPC throwing -> fail open');
  }

  // 5. Registration restore (explicit user action) ----------------------
  {
    const ls = makeLocalStorage({});
    const { guard } = load({
      localStorage: ls,
      health: { hasInstallMarker: true, marker: { hasRegistration: true } },
      markerRegistration: {
        registered_at: '2026-05-20T10:00:00.000Z',
        api_key: 'ak_live_123',
        license_key: 'VIPER-STD-ABC',
        license_type: 'standard',
        bogus_key: 'should-be-ignored',
      },
    });
    const restored = await guard.restoreRegistration();
    eq(restored, true, 'restoreRegistration reports success');
    eq(ls.getItem('viper_license_key'), 'VIPER-STD-ABC', 'license key restored');
    eq(ls.getItem('viper_registered_at'), '2026-05-20T10:00:00.000Z', 'registered_at restored');
    eq(ls.getItem('viper_bogus_key'), null, 'unknown keys are not written');
  }
  {
    const { guard } = load({ localStorage: makeLocalStorage({}), markerRegistration: null });
    eq(await guard.restoreRegistration(), false, 'restore fails cleanly with no marker data');
  }

  // 6. Deliberate reset clears the marker -------------------------------
  {
    const { guard, calls } = load({ localStorage: makeLocalStorage({}) });
    await guard.forget();
    eq(calls.updateInstallMarker.length, 1, 'forget() writes the marker');
    eq(calls.updateInstallMarker[0].registration, null, 'forget() clears registration');
  }

  // 7. markHealthy must not blank a good marker -------------------------
  {
    const { guard, calls } = load({ localStorage: makeLocalStorage({}) });
    const r = await guard.markHealthy();
    eq(r, false, 'markHealthy refuses to run without local registration');
    eq(calls.updateInstallMarker.length, 0, 'no marker write without registration');
  }

  // 8. Unwritable storage is reported -----------------------------------
  {
    const ls = makeLocalStorage({}, { throwOnWrite: true });
    const { guard } = load({
      localStorage: ls,
      health: { hasInstallMarker: true, marker: { lastKnownCaseCount: 4 } },
    });
    const r = await guard.run();
    eq(r.verdict, 'storage-fault', 'unwritable + marker -> fault');
    eq(r.writable, false, 'write probe detects the failure');
    ok(r.reasons.some(x => /not currently writable/i.test(x)), 'reason mentions writability');
  }

  // 9. probeWritable round-trip on healthy storage ----------------------
  {
    const ls = makeLocalStorage({});
    const { guard } = load({ localStorage: ls });
    eq(guard.probeWritable(), true, 'probeWritable true on working storage');
    eq(ls.getItem('__viper_storage_probe__'), null, 'probe key cleaned up');
  }

  console.log(`\nstorage-guard: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
