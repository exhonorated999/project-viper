# populate-model.ps1 - Build-time: create silent.wav and pre-download the bundled model
# into build\whisper\_models so the shipped app is fully offline.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\whisper\populate-model.ps1 [-Model small]

[CmdletBinding()]
param(
  [string]$Model = 'small',
  [string]$Root  = ''
)

$ErrorActionPreference = 'Continue'
function Log([string]$m){ Write-Host ('[populate-model] ' + $m) }

if ([string]::IsNullOrEmpty($Root)) {
  $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $Root = Join-Path $repoRoot 'build\whisper'
}

$exe    = Join-Path $Root 'faster-whisper-xxl.exe'
$ffmpeg = Join-Path $Root 'ffmpeg.exe'
$models = Join-Path $Root '_models'
$silent = Join-Path $Root 'silent.wav'
$tmpOut = Join-Path $Root '_popout'

if (-not (Test-Path $exe))    { throw ('Engine not found: ' + $exe) }
if (-not (Test-Path $ffmpeg)) { throw ('ffmpeg not found: ' + $ffmpeg) }

New-Item -ItemType Directory -Force -Path $models | Out-Null
New-Item -ItemType Directory -Force -Path $tmpOut | Out-Null

# 1. Generate a 1-second silent 16kHz mono wav (used here + shipped for model downloads)
if (-not (Test-Path $silent)) {
  Log 'Generating silent.wav ...'
  & $ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -y $silent 2>$null
  if (-not (Test-Path $silent)) { throw 'Failed to create silent.wav' }
}

# 2. Trigger the engine to download the model into _models (CPU, quick).
Log ('Pre-downloading model "' + $Model + '" into ' + $models + ' (needs network) ...')
& $exe $silent --model $Model --model_dir $models --output_dir $tmpOut --device cpu --beep_off --output_format txt
$code = $LASTEXITCODE
if (Test-Path $tmpOut) { Remove-Item -Recurse -Force $tmpOut }
if ($code -ne 0) { throw ('Engine exited ' + $code + ' while populating model.') }

Log 'Model dir contents:'
Get-ChildItem -Path $models -Force -Recurse -Depth 1 | Select-Object FullName, Length | Format-Table -AutoSize | Out-String | Write-Host
Log ('DONE. silent.wav + ' + $Model + ' model staged under ' + $Root)
