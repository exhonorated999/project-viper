# fetch-whisper.ps1 - Download + stage Purfview Faster-Whisper-XXL (Windows) into build\whisper.
# 1. Downloads the pinned Faster-Whisper-XXL Windows .7z release asset (resumable).
# 2. Extracts it with 7-Zip into build\whisper (flattening the archive top folder).
# 3. Strips the non-commercial Reverb diarization models (licensing compliance).
# Model population is handled separately by populate-model.ps1.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\whisper\fetch-whisper.ps1

[CmdletBinding()]
param(
  [string]$Url  = 'https://github.com/Purfview/whisper-standalone-win/releases/download/Faster-Whisper-XXL/Faster-Whisper-XXL_r245.4_windows.7z',
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
function Log([string]$m){ Write-Host ('[fetch-whisper] ' + $m) }

if ([string]::IsNullOrEmpty($Root)) {
  $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $Root = Join-Path $repoRoot 'build\whisper'
}

$SevenZip = 'C:\Program Files\7-Zip\7z.exe'
if (-not (Test-Path $SevenZip)) { throw ('7-Zip not found at ' + $SevenZip) }

$dlDir   = Join-Path $Root '_dl'
$stage   = Join-Path $Root '_stage'
$archive = Join-Path $dlDir 'fwxxl_windows.7z'
$exeFinal = Join-Path $Root 'faster-whisper-xxl.exe'

New-Item -ItemType Directory -Force -Path $Root  | Out-Null
New-Item -ItemType Directory -Force -Path $dlDir | Out-Null

# ---- 1. Download (resumable via curl.exe) ----
if (Test-Path $exeFinal) {
  Log 'faster-whisper-xxl.exe already present - skipping download/extract.'
  exit 0
}
Log ('Downloading: ' + $Url)
Log ('  -> ' + $archive)
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curl) {
  & $curl.Source -L --fail --retry 5 --retry-delay 5 -C - -o $archive $Url
  if ($LASTEXITCODE -ne 0) { throw ('curl download failed (exit ' + $LASTEXITCODE + ')') }
} else {
  Invoke-WebRequest -Uri $Url -OutFile $archive
}
$sizeMB = [math]::Round((Get-Item $archive).Length / 1MB, 1)
Log ('Downloaded ' + $sizeMB + ' MB.')

# ---- 2. Extract ----
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Log 'Extracting with 7-Zip ...'
& $SevenZip x $archive ('-o' + $stage) -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw ('7-Zip extraction failed (exit ' + $LASTEXITCODE + ')') }

$exe = Get-ChildItem -Path $stage -Recurse -Filter 'faster-whisper-xxl.exe' -File | Select-Object -First 1
if (-not $exe) { throw 'faster-whisper-xxl.exe not found in extracted archive.' }
$srcDir = $exe.Directory.FullName
Log ('Engine root inside archive: ' + $srcDir)

# Move contents of srcDir up into $Root
Log ('Staging engine into ' + $Root + ' ...')
Get-ChildItem -Path $srcDir -Force | ForEach-Object {
  $dest = Join-Path $Root $_.Name
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item -Path $_.FullName -Destination $dest
}

# ---- 3. Strip non-commercial Reverb diarization models ----
$bad = Get-ChildItem -Path $Root -Recurse -Force -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -match 'reverb' -or $_.Name -match 'diariz' }
foreach ($b in $bad) {
  if (Test-Path $b.FullName) {
    Log ('Removing non-commercial asset: ' + $b.FullName)
    Remove-Item -Recurse -Force $b.FullName -ErrorAction SilentlyContinue
  }
}

# ---- Cleanup ----
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
Log 'Removing downloaded archive to reclaim space ...'
Remove-Item -Force $archive -ErrorAction SilentlyContinue

Log ('DONE. Engine at: ' + $exeFinal)
Get-ChildItem -Path $Root -Force | Select-Object Name, Length | Format-Table -AutoSize | Out-String | Write-Host
