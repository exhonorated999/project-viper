# VIPER Development Launch Script
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " VIPER with Network Intelligence" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Starting local development server..." -ForegroundColor Yellow
Write-Host "This runs VIPER without browser tracking restrictions" -ForegroundColor Gray
Write-Host ""

# Start HTTP server in background
$serverJob = Start-Job -ScriptBlock {
    Set-Location "C:\Users\JUSTI\VIPER"
    python -m http.server 8000
}

Write-Host "Waiting for server to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 2

# Open browser
$url = "http://localhost:8000/case-detail-with-analytics.html"
Write-Host "Opening VIPER at: $url" -ForegroundColor Green
Start-Process $url

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "VIPER is now running!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press any key to stop the server and exit..." -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

# Stop server
Stop-Job $serverJob
Remove-Job $serverJob
Write-Host "Server stopped." -ForegroundColor Red
