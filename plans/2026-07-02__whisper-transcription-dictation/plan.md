# VIPER — Whisper Transcription + Reports Dictation (Plan)

Status: PLANNING (build target: next session). No code written yet.
Author ref tool: github.com/koebbe14/Faster-Whisper-XXL-GUI (wraps Purfview Faster-Whisper-XXL standalone).

## Goal (two distinct features, two engines)

1. **Media transcription** — transcribe audio/video EVIDENCE files on-device, store the
   transcript as a sidecar alongside the media + surface it in the Evidence viewer.
   Engine: **Faster-Whisper-XXL standalone** (batch; excellent fit).
2. **Live dictation** — officer speaks; text streams into the Reports editor (`#reportEditor`).
   Engine: **whisper.cpp streaming** (true real-time). USER DECISION = Option B (streaming).

## Locked decisions (from user)
- Dictation = Option B, true streaming (not record-then-transcribe).
- Media transcription lives in the **Evidence module** (that's where audio/video already live).
- **Ship the model with the installer** (fully offline out-of-the-box, CJIS-friendly).
- On-device only, no cloud (CJIS).

## Open questions to resolve before/at build
- [ ] Model size to bundle. `medium` (~1.5 GB, best accuracy) vs `small` (~0.5 GB, faster, less
      accurate). Recommend bundling `small` as default + allow `medium` as optional download,
      OR bundle `medium` and accept the installer size jump (~130 MB → ~1.6 GB). NEEDS CALL.
- [ ] GPU: CPU-only (works on every LE laptop) vs optional CUDA acceleration if NVIDIA present.
      Faster-Whisper-XXL auto-detects CUDA; recommend CPU-first, GPU auto-on when available.
- [ ] Dictation engine binary: whisper.cpp `stream.exe` (needs its own model .bin, e.g. ggml
      base/small) — do we reuse one shared model or ship a separate ggml model for streaming?
      (Faster-Whisper uses CTranslate2 model format; whisper.cpp uses ggml — DIFFERENT formats,
      so streaming likely needs its own ~150 MB ggml model. Confirm we accept 2 model artifacts.)
- [ ] Licensing sign-off: engine layers (faster-whisper / OpenAI Whisper weights / CTranslate2 /
      whisper.cpp) are all MIT — safe. BUT the **Purfview standalone wrapper** redistribution terms
      must be verified before shipping inside the commercial installer; and AVOID its bundled
      Reverb diarization model (non-commercial). Diarization = out of scope for v1.

## Architecture

### Bundling (both binaries)
- Place standalone folders under `build/whisper/` (Faster-Whisper-XXL) and `build/whisper-stream/`
  (whisper.cpp) + models under `build/whisper-models/`.
- electron-builder: add `extraResources` mapping `build/whisper*` → `resources/whisper*`.
  (Note: current `electron-builder.yml` — confirm/add an `extraResources:` block; today native
  deps rely on asarUnpack `build/**`. extraResources is cleaner for large binaries so they are
  NOT packed into asar.)
- Path resolution in electron-main.js follows existing `iconPath` idiom:
  `app.isPackaged ? path.join(process.resourcesPath, 'whisper', 'faster-whisper-xxl.exe')
                  : path.join(__dirname, 'build', 'whisper', 'faster-whisper-xxl.exe')`.
- Spawn via `child_process.spawn` (existing Cellebrite/Aperture pattern) but with piped stdio to
  capture progress/stdout (NOT `stdio:'ignore'`).

### Feature 1 — Media transcription (Evidence module)  [MAIN + renderer]
Reuse existing evidence plumbing (from explore):
- Evidence store: localStorage `viperCaseEvidence` → `{ [caseNumber]: EvidenceItem[] }`.
  Item shape: `{ id, type, tag, description, files[], metadata?, csamSensitive?, ... }`.
  Extension point = `metadata` (already dispatched in `viewEvidenceInline()`).
- Media viewing already works via `viper-media` streaming protocol (electron-main.js) +
  `renderEvidenceFiles()` (~L9098) which branches on mime (video/audio/image/pdf).
- Per-case files live under the case `Evidence/` dir; IPCs exist: `select-evidence-files`,
  `copy-evidence-file` (~L4105), `save-evidence-file` (~L4132, returns filePath),
  `read-evidence-file` (~L4419).

Plan:
1. **New IPC `whisper-transcribe`** (electron-main.js, `ipcMain.handle`): args
   `{ mediaPath, caseNumber, model, language, formats:['txt','srt','json'] }`.
   - Resolve exe path; spawn `faster-whisper-xxl.exe "<mediaPath>" -m <model> -l <lang>
     -o <sidecarDir> -f txt srt json` (standalone bundles ffmpeg, reads a/v directly).
   - Stream stdout → emit progress events to renderer (`webContents.send('whisper-progress', ...)`).
   - Write outputs as sidecars next to the media file:
     `<Evidence>/transcripts/<mediaBasename>.{txt,srt,json}`.
   - Return `{ success, transcriptTxtPath, transcriptSrtPath, transcriptJsonPath, text }`.
2. **preload.js**: expose `whisperTranscribe(args)` (invoke) + `onWhisperProgress(cb)` listener,
   following the `contextBridge.exposeInMainWorld('electronAPI', {...})` idiom.
3. **Renderer (case-detail-with-analytics.html)**:
   - In `renderEvidenceFiles()` / the inline viewer for audio/video items, add a **"Transcribe"**
     button. On click → `whisperTranscribe(...)`, show progress, then store
     `evidence.metadata.transcriptPath` + `evidence.metadata.transcript` (first ~N chars) back
     into the item, persist to `viperCaseEvidence`.
   - Add a **transcript panel** under the media player (collapsible), rendering the `.txt` (or
     the `.srt`/`.json` with timestamps → click-to-seek the `<video>/<audio>` element).
   - Optional: "Insert transcript into report" button → appends to `#reportEditor`.
4. **Batch option (later)**: a "Transcribe all audio/video" action on the Evidence tab.

### Feature 2 — Live dictation (Reports editor)  [MAIN + renderer]
Target: `#reportEditor` contenteditable (init `initializeReportEditor()` ~L6417; toolbar row ~L6360;
save `saveReport()` ~L6560; autosave 30s). Insert text at caret via `document.execCommand
('insertText', ...)` or a Range.
- whisper.cpp `stream` is real-time and reads from the mic directly on the native side, OR we
  capture mic in the renderer (`getUserMedia`/`MediaRecorder`) and pipe PCM chunks to the main
  process. Decide capture path:
  - **A (native mic):** spawn `stream.exe` which grabs the default mic + emits partial/final text
    on stdout → main forwards to renderer. Simplest to integrate; less control over device pick.
  - **B (renderer mic → main):** `getUserMedia` in renderer, downsample to 16k PCM, stream via IPC
    to a persistent whisper.cpp process on stdin. More control (device selection, VU meter), more
    plumbing. RECOMMEND starting with A, upgrade to B if device selection needed.
- **New IPC**: `dictation-start` / `dictation-stop` (`ipcMain.on` or handle) — spawns/kills the
  persistent `stream.exe`; `webContents.send('dictation-partial', text)` /
  `('dictation-final', text)`.
- **preload.js**: `dictationStart()`, `dictationStop()`, `onDictationPartial(cb)`,
  `onDictationFinal(cb)`.
- **Renderer**: add a mic/**"Dictate"** toggle button to the report toolbar (~L6360). While active:
  show a live "listening" indicator + interim (grey) text; on final, commit text into
  `#reportEditor` at the caret and trigger autosave. Handle punctuation/newline voice commands
  later (v2).

## Phasing
- **Phase 1 (media transcription):** bundle Faster-Whisper-XXL + model, `whisper-transcribe` IPC,
  Evidence "Transcribe" button + transcript panel + sidecars. Highest value, lowest risk.
- **Phase 2 (dictation):** bundle whisper.cpp stream + ggml model, dictation IPCs, toolbar mic
  button + interim/final rendering.
- Ship Phase 1 first (e.g. v3.9.10), Phase 2 in a follow-up (v3.9.11) — de-risks installer-size
  and mic/permission issues from the more mature media feature.

## Risks / notes
- **Installer size**: bundling models can push the installer from ~130 MB to >1.5 GB. Mitigate:
  bundle `small`, offer `medium` as an in-app one-time download to a userData models dir.
- **First-run AV/SmartScreen**: app is UNSIGNED; adding two more unsigned .exe's may add friction.
- **Model format mismatch**: Faster-Whisper (CTranslate2) vs whisper.cpp (ggml) — two model
  artifacts unless we standardize on one engine for both (whisper.cpp can do batch too, but is
  slower than Faster-Whisper on CPU). Keeping two engines is the accuracy/speed-optimal path.
- **Mic permissions** on Windows for the dictation feature (getUserMedia in Electron renderer).
- **CJIS**: everything on-device; no network calls at transcribe time. Verify the standalone makes
  NO outbound calls (it can auto-download models if missing — we pre-bundle to prevent this;
  consider passing a flag / setting the models dir explicitly so it never reaches the network).
- **Licensing**: confirm Purfview standalone redistribution + exclude Reverb model.

## Key code anchors (verified via exploration)
- Reports editor: `case-detail-with-analytics.html` — `#reportEditor` ~L6397, toolbar ~L6360,
  `initializeReportEditor()` ~L6417, `saveReport()` ~L6560, autosave ~L1712.
- Evidence: tab dispatch ~L4274; `renderEvidenceTab()` ~L6720; `renderEvidenceItems()` ~L7025;
  `viewEvidenceInline()` ~L8162 (dispatches on `metadata.kind`); `renderEvidenceFiles()` ~L9098;
  `saveEvidence()` ~L7686; store key `viperCaseEvidence`.
- IPC/media: `viper-media` streaming protocol in electron-main.js; evidence IPCs
  `select-evidence-files` ~L4058, `copy-evidence-file` ~L4105, `save-evidence-file` ~L4132,
  `read-evidence-file` ~L4419. External-binary spawn pattern: Cellebrite ~L5449, Aperture ~L5981.
  Path idiom: `app.isPackaged ? process.resourcesPath : __dirname`.
- Push-to-evidence pattern: `modules/_shared/warrant-flags.js` + `warrant-export-flags-bundle` IPC;
  preload `warrantExportFlagsBundle`, `datapilotCopyToEvidence`.
- Bundling: `electron-builder.yml` (add `extraResources` for `build/whisper*`), postinstall
  electron-rebuild already present for native deps.

## Build/release reminder
- `cd /d C:\Users\JUSTI\Workspace\VIPER && npm run package` (electron-builder 26.x; use
  `terminal_start` background — build exceeds 360s timeouts). Then `gh release create`.
- Bump version when shipping (currently 3.9.9). Commit msgs / notes via %TEMP% file + `git -F`.
