# fetch-whisper-stream.ps1 - Download + stage the whisper.cpp real-time dictation
# engine (stream.exe + SDL2.dll) and a ggml model into build\whisper-stream.
#
# This engine powers LIVE DICTATION in the Reports editor (separate from the
# batch Faster-Whisper-XXL media-transcription engine in build\whisper).
#
#   build\whisper-stream\
#     stream.exe          <- whisper.cpp real-time mic transcriber
#     SDL2.dll            <- required by stream.exe for audio capture
#     _models\ggml-<size>.en.bin
#
# electron-builder.yml copies this folder verbatim to resources\whisper-stream.
# The main process (electron-main.js _whisperStreamPaths / dictation-start)
# spawns resources\whisper-stream\stream.exe -m _models\ggml-*.bin --step 0.
#
# IMPORTANT: whisper.cpp's `stream` example links SDL2 and is NOT always present
# in the default release zip. If this script cannot find stream.exe in the
# downloaded archive it FAILS LOUDLY - point -BinUrl at a build that includes
# stream.exe + SDL2.dll, or build it yourself:
#   cmake -B build -DWHISPER_SDL2=ON ; cmake --build build --config Release --target stream
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\whisper\fetch-whisper-stream.ps1
#   ... -Model small.en           (bundle the larger/more-accurate model)
#   ... -BinUrl <zip-with-stream.exe>

[CmdletBinding()]
param(
  # Windows whisper.cpp binary archive (.zip) that MUST contain stream.exe + SDL2.dll.
  # v1.9.1 whisper-bin-x64.zip verified to include: stream.exe, SDL2.dll, whisper.dll,
  # ggml.dll + ggml-cpu-*.dll variants (all staged automatically).
  [string]$BinUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip',
  # ggml model to bundle: base.en (~142 MB, fast) | small.en (~466 MB, more accurate).
  [ValidateSet('base.en','small.en','base','small','tiny.en','tiny')]
  [string]$Model = 'base.en',
  # Hugging Face host for ggml models (ggerganov/whisper.cpp).
  [string]$ModelBaseUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
function Log([string]$m){ Write-Host ('[fetch-whisper-stream] ' + $m) }

if ([string]::IsNullOrEmpty($Root)) {
  $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $Root = Join-Path $repoRoot 'build\whisper-stream'
}

$dlDir     = Join-Path $Root '_dl'
$stage     = Join-Path $Root '_stage'
$models    = Join-Path $Root '_models'
$archive   = Join-Path $dlDir 'whisper-bin-x64.zip'
$exeFinal  = Join-Path $Root 'whisper-stream.exe'
$modelFile = Join-Path $models ('ggml-' + $Model + '.bin')

New-Item -ItemType Directory -Force -Path $Root   | Out-Null
New-Item -ItemType Directory -Force -Path $dlDir  | Out-Null
New-Item -ItemType Directory -Force -Path $models | Out-Null

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
function Download([string]$url, [string]$out) {
  Log ('Downloading: ' + $url)
  Log ('  -> ' + $out)
  if ($curl) {
    & $curl.Source -L --fail --retry 5 --retry-delay 5 -C - -o $out $url
    if ($LASTEXITCODE -ne 0) { throw ('curl download failed (exit ' + $LASTEXITCODE + '): ' + $url) }
  } else {
    Invoke-WebRequest -Uri $url -OutFile $out
  }
}

# ---- 1. whisper-stream.exe + SDL2.dll ----
if (Test-Path $exeFinal) {
  Log 'whisper-stream.exe already present - skipping engine download/extract.'
} else {
  Download $BinUrl $archive
  $sizeMB = [math]::Round((Get-Item $archive).Length / 1MB, 1)
  Log ('Downloaded engine archive ' + $sizeMB + ' MB.')

  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Log 'Extracting engine archive ...'
  Expand-Archive -Path $archive -DestinationPath $stage -Force

  $streamExe = Get-ChildItem -Path $stage -Recurse -Filter 'whisper-stream.exe' -File | Select-Object -First 1
  if (-not $streamExe) {
    throw ('whisper-stream.exe NOT found in ' + $BinUrl + '. The archive may not include the SDL2 real-time streaming tool. ' +
           'Point -BinUrl at a build that bundles whisper-stream.exe + SDL2.dll, or build it: ' +
           'cmake -B build -DWHISPER_SDL2=ON; cmake --build build --config Release --target whisper-stream')
  }
  $srcDir = $streamExe.Directory.FullName
  Log ('Found whisper-stream.exe in: ' + $srcDir)

  # Stage whisper-stream.exe + every DLL sitting beside it (SDL2.dll, ggml/whisper dlls, etc.)
  # NOTE: the archive also ships a legacy `stream.exe`, but it is only a
  # deprecation stub that prints "use whisper-stream.exe" and exits — we
  # deliberately stage whisper-stream.exe, which is the real streaming engine.
  Copy-Item -Path $streamExe.FullName -Destination $exeFinal -Force
  Get-ChildItem -Path $srcDir -Filter '*.dll' -File | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination (Join-Path $Root $_.Name) -Force
  }

  $sdl = Join-Path $Root 'SDL2.dll'
  if (-not (Test-Path $sdl)) {
    Log 'WARNING: SDL2.dll was not found next to stream.exe. Real-time mic capture will fail without it.'
    Log '         Obtain SDL2.dll (x64) and place it in build\whisper-stream\ before packaging.'
  }

  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
}

# ---- 2. ggml model ----
if (Test-Path $modelFile) {
  Log ('Model already present: ' + $modelFile)
} else {
  $modelUrl = ($ModelBaseUrl.TrimEnd('/')) + '/ggml-' + $Model + '.bin'
  Download $modelUrl $modelFile
  $mMB = [math]::Round((Get-Item $modelFile).Length / 1MB, 1)
  Log ('Downloaded model ' + $Model + ' (' + $mMB + ' MB).')
}

# ---- Cleanup + summary ----
Remove-Item -Force $archive -ErrorAction SilentlyContinue
Log 'Staged whisper-stream contents:'
Get-ChildItem -Path $Root -Force -Recurse -Depth 1 |
  Where-Object { $_.Name -ne '_dl' } |
  Select-Object FullName, @{N='MB';E={[math]::Round($_.Length/1MB,1)}} |
  Format-Table -AutoSize | Out-String | Write-Host

if ((Test-Path $exeFinal) -and (Test-Path $modelFile)) {
  Log ('DONE. Dictation engine ready at ' + $Root)
} else {
  Log 'INCOMPLETE - stream.exe and/or the ggml model are missing (see warnings above).'
  exit 1
}
