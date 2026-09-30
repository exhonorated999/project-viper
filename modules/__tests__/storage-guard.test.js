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
    get length() { return Object.keys(store).length; },
    key(i) { return Object.keys(store)[i] != null ? Object.keys(store)[i] : null; },
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

  // 10. TWO INSTALLS ON ONE COMPUTER ------------------------------------
  // The marker lives outside userData so it survives an unreadable data
  // folder, but that also means a desktop install and a portable drive
  // booted by the same Windows user can see each other's. The marker
  // records the app-data folder it was written for; a mismatch means this
  // is a different install, not the phantom reset.
  const HOST_ROOT = 'C:\\Users\\JUSTI\\AppData\\Roaming\\viper-electron';
  const STICK_ROOT = 'H:\\Project Viper\\V.I.P.E.R\\userdata';

  {
    // A fresh portable drive on a machine that already runs VIPER.
    const { guard, dom } = load({
      localStorage: makeLocalStorage({}),
      health: {
        hasInstallMarker: true,
        userDataPath: STICK_ROOT,
        marker: {
          userDataPath: HOST_ROOT,
          lastHealthyAt: '2026-09-25T13:24:39.180Z',
          lastKnownCaseCount: 21,
        },
      },
    });
    const r = await guard.run();
    eq(r.verdict, 'new-install', 'marker from another install -> new-install, not a fault');
    eq(dom.appended.length, 0, 'a second install is never blocked by the fault screen');
    ok(r.reasons.some(x => /different VIPER install/i.test(x)),
      'reason names the other install');
    ok(!r.reasons.some(x => /21 case/.test(x)),
      'the other install\'s case count is never shown as if it were ours');
  }

  {
    // The Berzanji case: SAME folder, merely unreadable. Must still block.
    const { guard, dom } = load({
      localStorage: makeLocalStorage({}),
      health: {
        hasInstallMarker: true,
        userDataPath: HOST_ROOT,
        userDataExistedAtBoot: true,
        localStorageExistedAtBoot: false,
        marker: { userDataPath: HOST_ROOT, lastHealthyAt: '2026-09-25', lastKnownCaseCount: 21 },
      },
    });
    const r = await guard.run();
    eq(r.verdict, 'storage-fault', 'same data folder + empty storage -> still a fault');
    eq(dom.appended.length, 1, 'phantom-reset protection is unchanged');
  }

  {
    // Same folder written with different case / trailing slash.
    const { guard } = load({
      localStorage: makeLocalStorage({}),
      health: {
        hasInstallMarker: true,
        userDataPath: HOST_ROOT,
        marker: { userDataPath: HOST_ROOT.toUpperCase() + '\\', lastKnownCaseCount: 21 },
      },
    });
    const r = await guard.run();
    eq(r.verdict, 'storage-fault', 'Windows path casing/trailing slash is not a different install');
  }

  {
    // Legacy marker written before the path was recorded: fall back to the
    // old behaviour rather than silently unblocking.
    const { guard } = load({
      localStorage: makeLocalStorage({}),
      health: {
        hasInstallMarker: true,
        userDataPath: HOST_ROOT,
        marker: { lastKnownCaseCount: 21 },
      },
    });
    const r = await guard.run();
    eq(r.verdict, 'storage-fault', 'legacy marker with no recorded path still blocks');
  }

  {
    // Health payload from an older main process: no current path to compare.
    const { guard } = load({
      localStorage: makeLocalStorage({}),
      health: {
        hasInstallMarker: true,
        marker: { userDataPath: HOST_ROOT, lastKnownCaseCount: 21 },
      },
    });
    const r = await guard.run();
    eq(r.verdict, 'storage-fault', 'unknown current path still blocks');
  }

  // 11. samePath ---------------------------------------------------------
  {
    const { guard } = load({ localStorage: makeLocalStorage({}) });
    const sp = guard.samePath;
    eq(sp('C:\\a\\b', 'c:\\A\\B'), true, 'samePath ignores Windows casing');
    eq(sp('C:\\a\\b', 'C:\\a\\b\\'), true, 'samePath ignores a trailing separator');
    eq(sp('C:\\a\\b', 'C:/a/b'), true, 'samePath treats / and \\ alike');
    eq(sp('C:\\a\\b', 'H:\\a\\b'), false, 'samePath separates different drives');
    eq(sp('C:\\a\\b', 'C:\\a\\bb'), false, 'samePath does not prefix-match');
    eq(sp('', 'C:\\a'), false, 'samePath is false when either side is empty');
    eq(sp(null, null), false, 'samePath is false for two unknowns');
  }

  // 12. "Continue anyway" must not leak a licence across installs --------
  // This is the drive-prep hazard: restoring here would write the host
  // machine's api_key / license_key into a drive about to be shipped.
  {
    const ls = makeLocalStorage({});
    const { guard } = load({
      localStorage: ls,
      health: {
        hasInstallMarker: true,
        userDataPath: STICK_ROOT,
        marker: { userDataPath: HOST_ROOT, hasRegistration: true },
      },
      markerRegistration: {
        registered_at: '2026-05-20T10:00:00.000Z',
        api_key: 'ak_live_123',
        license_key: 'VIPER-STD-ABC',
      },
    });
    eq(await guard.restoreRegistration(), false,
      'restoreRegistration refuses across different installs');
    eq(ls.getItem('viper_license_key'), null, 'no licence key written to the other install');
    eq(ls.getItem('viper_api_key'), null, 'no api key written to the other install');
  }

  {
    // Same install: the genuine recovery path still works.
    const ls = makeLocalStorage({});
    const { guard } = load({
      localStorage: ls,
      health: {
        hasInstallMarker: true,
        userDataPath: HOST_ROOT,
        marker: { userDataPath: HOST_ROOT, hasRegistration: true },
      },
      markerRegistration: {
        registered_at: '2026-05-20T10:00:00.000Z',
        license_key: 'VIPER-STD-ABC',
      },
    });
    eq(await guard.restoreRegistration(), true, 'restore still works for our own install');
    eq(ls.getItem('viper_license_key'), 'VIPER-STD-ABC', 'own licence key restored');
  }

  // 13. THE YANKED-DRIVE CASE -------------------------------------------
  // Chromium commits localStorage asynchronously; the main process writes
  // the install marker the instant registration succeeds. Pull an external
  // drive in between and the marker says "registered" while localStorage
  // never got the keys. Storage is perfectly healthy, so Retry can never
  // fix it — but the lost value is in the marker, addressed to this exact
  // install. Repair silently; never block.
  const LIVE_STORAGE = {
    viper_device_id: 'INV-5WCG19-0A18',
    viper_install_id: '68819b36-6883-4833-9987-eeee2f247712',
    viper_telemetry_consent: 'denied',
    viperTaskMode: 'list',
  };

  {
    const ls = makeLocalStorage(LIVE_STORAGE);
    const { guard, dom } = load({
      localStorage: ls,
      health: {
        hasInstallMarker: true,
        userDataPath: STICK_ROOT,
        marker: { userDataPath: STICK_ROOT, hasRegistration: true, lastHealthyAt: '2026-09-25' },
      },
      markerRegistration: {
        registered_at: '2026-09-25T18:11:17.608Z',
        api_key: 'ak_live_123',
        license_key: 'VIPER-STD-ABC',
      },
    });
    const r = await guard.run();
    eq(r.verdict, 'ok', 'healthy storage missing only registration -> repaired to ok');
    eq(r.restoredRegistration, true, 'registration was restored from the marker');
    eq(dom.appended.length, 0, 'the officer is never shown a blocking screen for this');
    eq(ls.getItem('viper_registered_at'), '2026-09-25T18:11:17.608Z', 'registration written back');
    eq(ls.getItem('viper_license_key'), 'VIPER-STD-ABC', 'licence key written back');
  }

  {
    // assess() alone must name the state, without repairing it.
    const { guard } = load({
      localStorage: makeLocalStorage(LIVE_STORAGE),
      health: {
        hasInstallMarker: true,
        userDataPath: STICK_ROOT,
        marker: { userDataPath: STICK_ROOT, hasRegistration: true },
      },
    });
    const a = await guard.assess();
    eq(a.verdict, 'lost-registration', 'assess reports lost-registration');
    eq(a.hasPriorState, true, 'prior state detected');
    ok(a.reasons.some(x => /disconnected before VIPER finished saving/i.test(x)),
      'reason explains the disconnect in plain language');
  }

  {
    // Storage alive, marker present but carrying NO registration (e.g. the
    // blob is DPAPI-locked on a different Windows account). Nothing to
    // restore and nothing wrong with the disk: ask them to register.
    const { guard, dom } = load({
      localStorage: makeLocalStorage(LIVE_STORAGE),
      health: {
        hasInstallMarker: true,
        userDataPath: STICK_ROOT,
        marker: { userDataPath: STICK_ROOT, hasRegistration: false, registrationLocked: true },
      },
    });
    const r = await guard.run();
    eq(r.verdict, 'new-install', 'healthy storage + unusable marker -> register, do not block');
    eq(dom.appended.length, 0, 'still no fault screen');
  }

  {
    // The marker claims a registration but cannot actually hand it over.
    const { guard, dom } = load({
      localStorage: makeLocalStorage(LIVE_STORAGE),
      health: {
        hasInstallMarker: true,
        userDataPath: STICK_ROOT,
        marker: { userDataPath: STICK_ROOT, hasRegistration: true },
      },
      markerRegistration: null,
    });
    const r = await guard.run();
    eq(r.verdict, 'new-install', 'failed restore degrades to registration, not a block');
    eq(r.restoredRegistration, false, 'restore reported as unsuccessful');
    eq(dom.appended.length, 0, 'a failed restore still does not block');
  }

  {
    // THE BERZANJI CASE MUST STILL BLOCK: storage came back completely
    // empty, which is what an unreadable/unsynced data folder looks like.
    const { guard, dom } = load({
      localStorage: makeLocalStorage({}),
      health: {
        hasInstallMarker: true,
        userDataPath: HOST_ROOT,
        userDataCloudProvider: 'OneDrive',
        marker: { userDataPath: HOST_ROOT, hasRegistration: true, lastKnownCaseCount: 21 },
      },
    });
    const r = await guard.run();
    eq(r.verdict, 'storage-fault', 'empty storage is still a fault');
    eq(r.hasPriorState, false, 'no prior state found in an empty database');
    eq(dom.appended.length, 1, 'phantom reset still blocks');
  }

  {
    // Prior state present but storage NOT writable -> the disk is in
    // trouble after all. Block.
    const ls = makeLocalStorage(LIVE_STORAGE, { throwOnWrite: true });
    const { guard, dom } = load({
      localStorage: ls,
      health: {
        hasInstallMarker: true,
        userDataPath: STICK_ROOT,
        marker: { userDataPath: STICK_ROOT, hasRegistration: true },
      },
    });
    const r = await guard.run();
    eq(r.verdict, 'storage-fault', 'prior state but unwritable -> still a fault');
    eq(dom.appended.length, 1, 'unwritable storage blocks');
  }

  // 14. storageHasPriorState ---------------------------------------------
  {
    const { guard } = load({ localStorage: makeLocalStorage({}) });
    eq(guard.storageHasPriorState(), false, 'empty storage has no prior state');
  }
  {
    const { guard } = load({
      localStorage: makeLocalStorage({ viper_registered_at: 'x', viper_api_key: 'y' }),
    });
    eq(guard.storageHasPriorState(), false,
      'registration keys alone do not count as prior state');
  }
  {
    const { guard } = load({ localStorage: makeLocalStorage({ __viper_storage_probe__: '1' }) });
    eq(guard.storageHasPriorState(), false, 'our own probe key does not count');
  }
  {
    const { guard } = load({ localStorage: makeLocalStorage({ viperTaskMode: 'list' }) });
    eq(guard.storageHasPriorState(), true, 'a real VIPER key counts');
  }
  {
    const { guard } = load({ localStorage: makeLocalStorage({ someOtherApp: '1' }) });
    eq(guard.storageHasPriorState(), false, 'another app\'s keys do not count');
  }
  {
    // Older/partial localStorage shims with no enumeration support fall
    // back to the explicit key list rather than reporting "empty".
    const base = makeLocalStorage({ viper_device_id: 'INV-1' });
    const noEnum = {
      getItem: base.getItem, setItem: base.setItem, removeItem: base.removeItem,
    };
    const { guard } = load({ localStorage: noEnum });
    eq(guard.storageHasPriorState(), true, 'falls back to the explicit key list');
  }

  console.log(`\nstorage-guard: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
