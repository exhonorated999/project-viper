# VIPER — Narcotics Unit Shared, Searchable Case Repository + CI Debriefs

## Context
A narcotics/vice unit wants VIPER cases to be:
1. **Shared** — every case viewable by all authorized unit members (not siloed to one detective's laptop).
2. **Retained in-unit** — when a detective leaves, their cases stay in the unit repository.
3. **Searchable** — a unit-wide "database" search across all cases (fields + notes).
4. **CI debriefs** — confidential-informant debrief notes captured in VIPER and included in search. (Organization PINNED — see below.)

Shift from VIPER's single-user/local model toward a shared unit repository, preserving on-prem, CJIS-conscious, no-cloud posture.

## Current-State Findings (from code exploration)
- **App model:** single-user local Electron app. Data root = `casesDir`.
  - `casesDir` default `<userData>/cases`; **already redirectable** via `storageOverrides.casesPath` (STORAGE_CONFIG in `electron-main.js` ~L168-290). Seam for pointing at a network share.
- **Per-case layout:** folder per case with `.case-snapshot.json` + subfolders (`Evidence/`, `Notes/`, `Warrants/`, `RMS_Reports/`, `Oversight/`, `aperture/`).
- **Encrypted at rest:** `.case-snapshot.json` is a `VIPENC` blob when Field Security on. Master key **per-installation**, PBKDF2 password → key (`modules/security.js` `_deriveKey`/`setup`/`unlock`). Cross-machine share needs a **shared/unit key**.
- **Notes:** text in `localStorage['viperCaseNotes'][caseNumber]` but **serialized into the snapshot** (case-detail L1308) so they travel with the case folder. Attachments in `cases/{case}/Notes/`.
- **Search:** none cross-case. `list-case-snapshots` (electron-main ~L1925) returns only `{caseNumber, mtime, size}`.
- **IPC seam:** `save/load/list-case-snapshot` centralize case IO in main → right place for indexing + shared-store adapter.
- **SQLite precedent:** UC Chat ships `viper-uc.db` (`modules/uc-chat/uc-chat-db.js`).
- **Key-wrap precedent:** `security.js` already wraps one master key with BOTH a password AND a recovery key → extends cleanly to "wrap one UNIT key per member."

## Decisions (from user)
1. **Storage:** unit doesn't yet know what's available — provided an "ask IT" spec (SMB/CIFS share on LAN, AD-group access = unit roster, 500GB–1TB, nightly backup, CJIS boundary check, no consumer cloud). Design works with ANY shared folder path → **Option 1 (Shared Unit Vault) confirmed.**
2. **CI-debrief access:** visible to all authorized unit members. **BUT organization is PINNED — deferred.**
3. **Concurrency:** rarely simultaneous → **soft "in use by" lock is sufficient.**

## PINNED / OPEN
- **CI debriefs organization** — user: "This isnt really what I was hoping for. put a pin in this and we will come back." Revisit before building Phase 3. Do NOT build CI debriefs yet.
- Start point (Phase 1 vs search-first vs all-at-once) — awaiting.
- Unit-vault admin model (supervisor/admin role vs flat vs single admin) — awaiting.

## Chosen Approach — Option 1: Shared Unit Vault
Point every member's VIPER at the same SMB/NAS share via the existing storage-redirect. One **unit master key** encrypts all repo snapshots; it is stored on the share **wrapped once per member** (unwrapped by each member's own password) + a supervisor **recovery wrap** — reusing the `security.js` wrap pattern. Cross-case search = a **local SQLite FTS index** rebuilt on unlock (plaintext index never written to the share). Soft lockfiles for concurrency.

### Repo layout on the share
- `unit.json` (unit id/name/created)
- `keys/` — per-member wrapped unit key + recovery wrap + per-user salts
- `cases/{caseNumber}/` — same per-case folder layout as today
- `locks/{caseNumber}.lock` — `{user, host, ts}` soft lock
- `audit.log` — append-only cross-member access log

### Key / enrollment model (extends security.js)
- Unit master key = random 32 bytes; encrypts all repo snapshots.
- `unit_key_wrapped[userId] = wrap(unitKey, deriveKey(userPassword, saltPerUser))`.
- Recovery wrap held by supervisor (mirrors existing recovery_key).
- Enroll: admin (with vault open) adds a member's wrapped entry.
- Revoke (leaving): remove wrapped entry + IT drops AD-group access. Data untouched → retention automatic. (Full key rotation + re-encrypt = stronger, deferred.)

### Search index
- On unlock: iterate repo snapshots, decrypt in memory, extract searchable text (case #, names, addresses, providers, notes, report/RMS text), write to local **SQLite FTS5** in userData. Incremental update on snapshot save + mtime change.
- New **Unit Search** screen: query box → results (case #, snippet, section, mtime, owner) → open case at section.

### Soft lock
- Open-for-edit writes `locks/{case}.lock`; others open read-only with "In use by Det. X" banner; stale locks auto-expire; cleared on close.

## Build Order (phased)
- **Phase 1 — Unit Repository + unit-key login** (sharing + retention): connect to share, enroll/revoke members, migrate local cases in, open/save from repo.
- **Phase 2 — Unit Search** (searchable DB): SQLite FTS index + Unit Search UI.
- **Phase 3 — CI Debriefs** (DEFERRED / PINNED): structured section flowing into search — build only after organization decision.
- **Phase 4 — Soft lock + shared audit** polish.

## Scope & Non-Goals
- In: shared repo via storage-redirect, unit-key sharing/enroll/revoke, cross-case search UI, soft lock, basic shared audit.
- Deferred: full client-server sync engine, real-time co-editing, cloud hosting, unit-key rotation+re-encrypt, CI debriefs (pinned).

## Verification (draft)
- Two installs pointed at the same share open/search the same case.
- Case authored by "Det. A" stays searchable/openable after A is revoked.
- Enroll new member on install 1 → they unlock repo on install 2 with their own password.
- Soft lock: install 2 sees read-only banner while install 1 edits.
