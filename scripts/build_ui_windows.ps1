#!powershell
#
# powershell -ExecutionPolicy Bypass -File .\scripts\build_ui_windows.ps1
#

$ErrorActionPreference = "Continue"

function checkEnv {
    $script:SRC_DIR=$PWD
    $script:ARCH="amd64"
    if ($null -ne $env:ARCH ) {
        $script:ARCH = $env:ARCH
    }
    $script:TARGET_ARCH=$script:ARCH
    $script:DIST_DIR="${script:SRC_DIR}\dist\windows-${script:TARGET_ARCH}"
    
    $inoSetup=(get-item "C:\Program Files*\Inno Setup*\")
    if ($inoSetup.length -gt 0) {
        $script:INNO_SETUP_DIR=$inoSetup[0]
    }

    if (!$env:VERSION) {
        $data=(git describe --tags --first-parent --abbrev=7 --long --dirty --always)
        $pattern="v(.+)"
        if ($data -match $pattern) {
            $script:VERSION=$matches[1]
        }
    } else {
        $script:VERSION=$env:VERSION
    }
    $pattern = "(\d+[.]\d+[.]\d+).*"
    if ($script:VERSION -match $pattern) {
        $script:PKG_VERSION=$matches[1]
    } else {
        $script:PKG_VERSION="0.0.0"
    }

    if ($null -eq $env:SIGN_TOOL) {
        ${script:SignTool}="C:\Program Files (x86)\Windows Kits\8.1\bin\x64\signtool.exe"
    } else {
        ${script:SignTool}=${env:SIGN_TOOL}
    }
    if ("${env:KEY_CONTAINER}" -and (Test-Path "${script:SRC_DIR}\ollama_inc.crt")) {
        ${script:OLLAMA_CERT}=$(resolve-path "${script:SRC_DIR}\ollama_inc.crt")
    }
}

function app {
    Write-Output "Building Ollama App $script:VERSION with package version $script:PKG_VERSION"

    if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Output "npm is not installed. Please install Node.js and npm first:"
        Write-Output "   Visit: https://nodejs.org/"
        exit 1
    }

    if (!(Get-Command tsc -ErrorAction SilentlyContinue)) {
        Write-Output "Installing TypeScript compiler..."
        npm install -g typescript
    }
    if (!(Get-Command tscriptify -ErrorAction SilentlyContinue)) {
        Write-Output "Installing tscriptify..."
        go install github.com/tkrajina/typescriptify-golang-structs/tscriptify@latest
    }
    if (!(Get-Command tscriptify -ErrorAction SilentlyContinue)) {
        $env:PATH="$env:PATH;$(go env GOPATH)\bin"
    }

    Push-Location app/ui/app
    npm install
    if ($LASTEXITCODE -ne 0) { 
        Write-Output "ERROR: npm install failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }

    Write-Output "Building React application..."
    npm run build
    if ($LASTEXITCODE -ne 0) { 
        Write-Output "ERROR: npm run build failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }

    # Check if dist directory exists and has content
    if (!(Test-Path "dist")) {
        Write-Output "ERROR: dist directory was not created by npm run build"
        exit 1
    }

    $distFiles = Get-ChildItem "dist" -Recurse
    if ($distFiles.Count -eq 0) {
        Write-Output "ERROR: dist directory is empty after npm run build"
        exit 1
    }

    Pop-Location

    Write-Output "Running go generate"
    & go generate ./...
    if ($LASTEXITCODE -ne 0) { exit($LASTEXITCODE)}
	& go build -trimpath -ldflags "-s -w -H windowsgui -X=github.com/ollama/ollama/app/version.Version=$script:VERSION" -o .\dist\windows-ollama-app-${script:ARCH}.exe ./app/cmd/app/
    if ($LASTEXITCODE -ne 0) { exit($LASTEXITCODE)}
}

function installer {
    if ($null -eq ${script:INNO_SETUP_DIR}) {
        Write-Output "ERROR: missing Inno Setup installation directory - install from https://jrsoftware.org/isdl.php"
        exit 1
    }
    Write-Output "Building Ollama Installer"
    cd "${script:SRC_DIR}\app"
    $env:PKG_VERSION=$script:PKG_VERSION
    if ("${env:KEY_CONTAINER}") {
        & "${script:INNO_SETUP_DIR}\ISCC.exe" /DARCH=$script:TARGET_ARCH /SMySignTool="${script:SignTool} sign /fd sha256 /t http://timestamp.digicert.com /f ${script:OLLAMA_CERT} /csp `$qGoogle Cloud KMS Provider`$q /kc ${env:KEY_CONTAINER} `$f" .\ollama.iss
    } else {
        & "${script:INNO_SETUP_DIR}\ISCC.exe" /DARCH=$script:TARGET_ARCH .\ollama.iss
    }
    if ($LASTEXITCODE -ne 0) { exit($LASTEXITCODE)}
}

checkEnv
try {
    app
    installer
} catch {
    Write-Error "Build Failed: $($_.Exception.Message)"
    Write-Error "$($_.ScriptStackTrace)"
} finally {
    set-location $script:SRC_DIR
    $env:PKG_VERSION=""
}
