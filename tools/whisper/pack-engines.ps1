# ============================================================================
# pack-engines.ps1 - build the distributable VIPER Whisper engine pack (.zip)
# ============================================================================
# The Whisper engines are NO LONGER bundled in the installer (they are multi-GB
# and broke the NSIS build). Instead they are downloaded on demand from
# Settings -> Voice Dictation and Transcription and installed into
#   %APPDATA%\V.I.P.E.R.\engines\  (whisper\ + whisper-stream\)
#
# This script zips the local build\whisper (Faster-Whisper-XXL + model) and
# build\whisper-stream (whisper.cpp live engine + ggml model) into a single
# pack whose top level contains "whisper\" and "whisper-stream\", which the
# in-app installer (electron-main.js whisper-engine-* handlers) extracts.
#
# By default the pack removes only the lazily-loaded GPU libraries that are
# NOT needed for CPU transcription (cuDNN + onnxruntime CUDA/TensorRT
# providers, ~1 GB). This keeps the engine fully working (torch is a CUDA
# build that hard-loads c10_cuda/torch_cuda + cudart/cublas/etc. at import,
# so those MUST stay) while getting the pack under GitHub's 2 GB asset limit.
# Pass -IncludeCuda to keep every GPU library (larger; may exceed 2 GB).
#
# Usage (from repo root, in PowerShell):
#   powershell -ExecutionPolicy Bypass -File tools\whisper\pack-engines.ps1
#   powershell -ExecutionPolicy Bypass -File tools\whisper\pack-engines.ps1 -IncludeCuda
#   powershell -ExecutionPolicy Bypass -File tools\whisper\pack-engines.ps1 -Out C:\path\pack.zip
#
# Upload the resulting zip to the download source referenced by
# WHISPER_ENGINE_PACK_URL in electron-main.js (or point the Settings
# "Advanced: custom download URL" field at it), or hand it to users for the
# offline "Install from file..." path.
# ============================================================================

param(
    [switch]$IncludeCuda,
    [string]$Out
)

$ErrorActionPreference = 'Stop'

# Repo root = two levels up from tools\whisper
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$whisperSrc = Join-Path $repo 'build\whisper'
$streamSrc  = Join-Path $repo 'build\whisper-stream'
$distDir    = Join-Path $repo 'dist'

if (-not (Test-Path $whisperSrc)) {
    throw "build\whisper not found ($whisperSrc). Run tools\whisper\fetch-whisper.ps1 first."
}
if (-not $Out) {
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
    $Out = Join-Path $distDir 'viper-whisper-engines.zip'
}

# Stage into a temp dir so we can trim without touching the real build.
$staging = Join-Path $env:TEMP ("viper-engine-pack-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Write-Host "Staging in $staging"

try {
    Write-Host "Copying build\whisper ..."
    Copy-Item -Path $whisperSrc -Destination (Join-Path $staging 'whisper') -Recurse -Force

    if (Test-Path $streamSrc) {
        Write-Host "Copying build\whisper-stream ..."
        Copy-Item -Path $streamSrc -Destination (Join-Path $staging 'whisper-stream') -Recurse -Force
    } else {
        Write-Warning "build\whisper-stream not found - live dictation engine will NOT be in the pack."
    }

    if (-not $IncludeCuda) {
        $torchLib = Join-Path $staging 'whisper\_xxl_data\torch\lib'
        if (Test-Path $torchLib) {
            Write-Host "Removing lazily-loaded GPU libraries (keeps CPU transcription) ..."
            # IMPORTANT: this torch is a CUDA build. torch\__init__ hard-loads
            # c10_cuda.dll / torch_cuda.dll (and their deps cudart/cublas/cufft/
            # cusolver/cusparse/curand) AT IMPORT TIME. Removing any of those
            # breaks the engine with 'WinError 126: specified module not found'.
            # So we ONLY remove libraries that are dlopen'd on demand and are
            # never needed for CPU transcription:
            #   - cuDNN (GPU convolution)               ~0.85 GB
            #   - onnxruntime CUDA / TensorRT providers ~0.10 GB
            # This keeps the pack a single working file under GitHub's 2 GB limit.
            $cudaPatterns = @( 'cudnn*.dll' )
            $freed = 0
            foreach ($pat in $cudaPatterns) {
                Get-ChildItem -Path $torchLib -Filter $pat -ErrorAction SilentlyContinue | ForEach-Object {
                    $freed += $_.Length
                    Remove-Item $_.FullName -Force
                }
            }
            # Also drop onnxruntime CUDA/TensorRT providers if present (GPU-only).
            $onnx = Join-Path $staging 'whisper\_xxl_data\onnxruntime\capi'
            if (Test-Path $onnx) {
                Get-ChildItem -Path $onnx -Filter 'onnxruntime_providers_cuda*.dll' -ErrorAction SilentlyContinue | ForEach-Object {
                    $freed += $_.Length; Remove-Item $_.FullName -Force
                }
                Get-ChildItem -Path $onnx -Filter 'onnxruntime_providers_tensorrt*.dll' -ErrorAction SilentlyContinue | ForEach-Object {
                    $freed += $_.Length; Remove-Item $_.FullName -Force
                }
            }
            Write-Host ("Removed {0:N1} GB of on-demand GPU libraries." -f ($freed / 1GB))
        } else {
            Write-Warning "torch\lib not found - nothing to strip."
        }
    } else {
        Write-Host "Keeping ALL GPU libraries (-IncludeCuda)."
    }

    # Compress with .NET ZipFile (zip64-capable -> handles >2 GB).
    if (Test-Path $Out) { Remove-Item $Out -Force }
    Write-Host "Compressing to $Out (this can take several minutes) ..."
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $staging, $Out,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )

    $sizeGb = (Get-Item $Out).Length / 1GB
    Write-Host ""
    Write-Host ("DONE  ->  {0}  ({1:N2} GB)" -f $Out, $sizeGb) -ForegroundColor Green
    Write-Host "Upload this zip to your download source, or use it with 'Install from file...'."
}
finally {
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
