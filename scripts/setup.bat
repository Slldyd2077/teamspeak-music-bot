@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title TSMusicBot Setup

:: ============================================================
::  TSMusicBot Setup Script (Windows)
::  - Auto-detect China network, switch to npmmirror
::  - Download native binaries from CDN (避开 GitHub)
::  - 自动修复 PowerShell 环境变量
:: ============================================================

set "SCRIPT_VERSION=2.1"
set "MIN_NODE_MAJOR=20"
set "LOG_FILE=%~dp0..\setup.log"
set "FAILED=0"

:: Resolve project root (one level up from scripts/)
cd /d "%~dp0.." || (
    echo [FATAL] Cannot change to project directory.
    pause
    exit /b 1
)

set "PROJECT_ROOT=%cd%"

:: ---- Initialize log ----
echo. > "%LOG_FILE%"
call :log "============================================"
call :log "  TSMusicBot Setup v%SCRIPT_VERSION%"
call :log "  Started: %date% %time%"
call :log "  Project root: %PROJECT_ROOT%"
call :log "============================================"

echo ============================================
echo   TSMusicBot - First-Time Setup (Windows)
echo   Version %SCRIPT_VERSION%
echo ============================================
echo.
echo Log file: %LOG_FILE%
echo.

:: ============================================================
:: Step 1: Check Node.js
:: ============================================================
call :step "1/7" "Checking Node.js"

where node >nul 2>&1
if not errorlevel 1 goto :check_node_version

:: Node not in PATH — try common install locations
set "NODE_CANDIDATES="
if exist "F:\nodejs\node.exe" set "NODE_CANDIDATES=F:\nodejs"
if exist "C:\Program Files\nodejs\node.exe" set "NODE_CANDIDATES=C:\Program Files\nodejs"
if exist "%LOCALAPPDATA%\fnm\nodejs\current\node.exe" set "NODE_CANDIDATES=%LOCALAPPDATA%\fnm\nodejs\current"
if exist "%USERPROFILE%\AppData\Local\fnm\nodejs\current\node.exe" set "NODE_CANDIDATES=%USERPROFILE%\AppData\Local\fnm\nodejs\current"
if exist "C:\tools\nodejs\node.exe" set "NODE_CANDIDATES=C:\tools\nodejs"

if defined NODE_CANDIDATES (
    set "PATH=%NODE_CANDIDATES%;%PATH%"
    echo [OK] Node.js found at: %NODE_CANDIDATES%
    call :log "Node.js found at: %NODE_CANDIDATES%"
    goto :check_node_version
)

call :error "Node.js not found in PATH."
echo.
echo Please install Node.js %MIN_NODE_MAJOR% LTS or newer from:
echo   https://nodejs.cn/  (China mirror, recommended)
echo.
pause
exit /b 1

:check_node_version
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
for /f "tokens=1 delims=v." %%a in ("%NODE_VER%") do set "NODE_MAJOR=%%a"

call :log "Node.js version: %NODE_VER%"
echo [OK] Node.js found: %NODE_VER%

if %NODE_MAJOR% LSS %MIN_NODE_MAJOR% (
    call :error "Node.js version too old. Need %MIN_NODE_MAJOR%+, found %NODE_VER%."
    pause
    exit /b 1
)
echo.

:: ============================================================
:: Step 2: Check npm
:: ============================================================
call :step "2/7" "Checking npm"

where npm >nul 2>&1
if errorlevel 1 (
    call :error "npm not found."
    pause
    exit /b 1
)

for /f "delims=" %%v in ('npm --version 2^>nul') do set "NPM_VER=%%v"
call :log "npm version: %NPM_VER%"
echo [OK] npm found: %NPM_VER%
echo.

:: ============================================================
:: Step 3: Detect network and configure mirror
:: ============================================================
call :step "3/7" "Checking network"

set "USE_MIRROR=0"
set "MIRROR_REGISTRY=https://registry.npmjs.org"

echo Testing connection to npm registry...
call :log "Testing npm registry connectivity..."

ping -n 1 -w 4000 registry.npmjs.org >nul 2>&1
if errorlevel 1 (
    echo [WARN] Cannot reach npm registry quickly, using China mirror.
    call :log "npm registry unreachable via ping"
    set "USE_MIRROR=1"
) else (
    echo [OK] npm registry reachable.
    call :log "npm registry reachable"
)

if "%USE_MIRROR%"=="1" (
    echo.
    echo [INFO] Using China mirror (npmmirror.com)
    call :log "Switching to npmmirror.com"
    set "MIRROR_REGISTRY=https://registry.npmmirror.com"
    set "CDN_MIRROR=https://cdn.npmmirror.com/binaries"
) else (
    set "CDN_MIRROR="
)
echo.

:: ============================================================
:: Step 4: Install backend dependencies (跳过二进制)
:: ============================================================
call :step "4/7" "Installing backend dependencies"

if exist "node_modules\.package-lock.json" (
    echo Found existing node_modules. Checking integrity...
)

echo Running: npm install --ignore-scripts (跳过 GitHub 二进制下载)
echo.

call npm install --registry=%MIRROR_REGISTRY% --ignore-scripts >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    call :error "Backend npm install failed."
    echo Check the log: %LOG_FILE%
    pause
    exit /b 1
)
echo [OK] Backend dependencies installed.
echo.

:: ============================================================
:: Step 4b: Download native binaries from CDN
:: ============================================================
call :step "4b/7" "Downloading native binaries"

node scripts/download-binaries.mjs %CDN_MIRROR% >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo [WARN] Binary download had issues. Check %LOG_FILE% for details.
) else (
    echo [OK] Native binaries installed.
)
echo.

:: ============================================================
:: Step 5: Install frontend dependencies
:: ============================================================
call :step "5/7" "Installing frontend dependencies"

if not exist "web\package.json" (
    call :error "web\package.json not found."
    pause
    exit /b 1
)

echo Running: npm install (in web/)
echo.

pushd web >nul
call npm install --registry=%MIRROR_REGISTRY% >>"%LOG_FILE%" 2>&1
set "WEB_INSTALL_RESULT=!errorlevel!"
popd >nul

if !WEB_INSTALL_RESULT! neq 0 (
    call :error "Frontend npm install failed."
    pause
    exit /b 1
)
echo [OK] Frontend dependencies installed.
echo.

:: ============================================================
:: Step 6: Build project
:: ============================================================
call :step "6/7" "Building project"

echo Running: npm run build
echo.

call npm run build >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    call :error "Build failed. Check: %LOG_FILE%"
    pause
    exit /b 1
)
echo [OK] Build succeeded.
echo.

:: ============================================================
:: Step 7: Ensure PowerShell in PATH (修复 jdymusic CDN 播放)
:: ============================================================
call :step "7/7" "Checking PowerShell PATH"

where powershell >nul 2>&1
if errorlevel 1 (
    echo [WARN] PowerShell not found in PATH.
    echo Attempting to fix...
    set "POWERSHELL_PATH=C:\Windows\System32\WindowsPowerShell\v1.0"
    if exist "!POWERSHELL_PATH!\powershell.exe" (
        :: 为用户添加永久 PATH 环境变量
        echo [INFO] Adding PowerShell to user PATH...
        call setx PATH "!POWERSHELL_PATH!;%PATH%" >nul 2>&1
        echo [OK] PowerShell added to PATH. Please restart your terminal.
    ) else (
        echo [WARN] Could not find powershell.exe on this system.
        echo        If you encounter playback issues with some NetEase songs,
        echo        run: set PATH=%%PATH%%;C:\Windows\System32\WindowsPowerShell\v1.0\
        echo        before running scripts\start.bat
    )
) else (
    echo [OK] PowerShell found in PATH.
)
echo.

:: ============================================================
:: Verify build outputs
:: ============================================================
echo Verifying build outputs...
set "BUILD_OK=1"

if not exist "dist" (
    call :error "dist/ directory missing after build."
    set "BUILD_OK=0"
)
if not exist "web\dist" (
    call :error "web\dist/ directory missing after build."
    set "BUILD_OK=0"
)

if "!BUILD_OK!"=="0" (
    echo Build completed but expected output is missing.
    pause
    exit /b 1
)
echo [OK] Build outputs verified.
echo.

if not exist "config.json" (
    echo [INFO] config.json will be auto-generated on first launch.
) else (
    echo [OK] config.json already exists.
)
echo.

:: ============================================================
:: Done
:: ============================================================
call :log "Setup completed successfully at %date% %time%"

echo ============================================
echo   Setup Complete!
echo ============================================
echo.
echo Next steps:
echo   1. Run:  scripts\start.bat
echo   2. Open: http://localhost:3000
echo.
echo Setup log: %LOG_FILE%
echo.
pause
exit /b 0

:: ============================================================
:: Subroutines
:: ============================================================
:step
echo ---- Step %~1: %~2 ----
call :log ""
call :log "---- Step %~1: %~2 ----"
goto :eof

:error
echo.
echo [ERROR] %~1
call :log "[ERROR] %~1"
goto :eof

:log
echo [%time%] %~1 >> "%LOG_FILE%"
goto :eof

