# Standalone Ollama UI Builder Script (Windows/PowerShell)
# Binds the Angular compiled bundle into a single Go executable using embed

# Since this script lives in the /desktop subfolder, the Angular root is the parent directory
$UI_DIR = Resolve-Path (Join-Path $PSScriptRoot "..")
$DIST_TARGET = Join-Path $PSScriptRoot "dist"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " Building Standalone Ollama Native UI Wrapper" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

# 1. Compile Angular UI
Write-Host "`n[1/3] Building Angular 19 Frontend Assets..." -ForegroundColor Yellow
Push-Location $UI_DIR
try {
    # Check node_modules
    if (-not (Test-Path "node_modules")) {
        Write-Host "node_modules not found, running npm install..." -ForegroundColor DarkYellow
        npm install
    }
    npm run build
} catch {
    Write-Error "Failed to build Angular application: $_"
    Pop-Location
    Exit 1
}
Pop-Location

# 2. Sync files into Go cmd directory
Write-Host "`n[2/3] Syncing static assets to Go embed directory..." -ForegroundColor Yellow
$builtAssets = Join-Path $UI_DIR "dist\angular-ui\browser"
if (-not (Test-Path $builtAssets)) {
    Write-Error "Angular build directory not found at $builtAssets"
    Exit 1
}

# Clear target dist directory
if (Test-Path $DIST_TARGET) {
    Remove-Item -Recurse -Force $DIST_TARGET\*
} else {
    New-Item -ItemType Directory -Path $DIST_TARGET | Out-Null
}

# Copy new assets
Copy-Item -Path "$builtAssets\*" -Destination $DIST_TARGET -Recurse -Force
Write-Host "Assets synced successfully!" -ForegroundColor Green

# 3. Compile Go standalone wrapper
Write-Host "`n[3/3] Compiling Native Go Binary..." -ForegroundColor Yellow
Push-Location $PSScriptRoot
try {
    go build -o ollama-ui.exe
    Write-Host "`n=============================================" -ForegroundColor Green
    Write-Host " SUCCESS! Built standalone wrapper binary:   " -ForegroundColor Green
    Write-Host " $(Join-Path $PSScriptRoot "ollama-ui.exe")   " -ForegroundColor White
    Write-Host "=============================================" -ForegroundColor Green
} catch {
    Write-Error "Failed to compile Go binary: $_"
    Pop-Location
    Exit 1
}
Pop-Location
