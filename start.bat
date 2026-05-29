@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

title WoozleBox Launcher
color 0A

echo.
echo  ██╗    ██╗ ██████╗  ██████╗ ███████╗██╗     ███████╗██████╗  ██████╗ ██╗  ██╗
echo  ██║    ██║██╔═══██╗██╔═══██╗╚══███╔╝██║     ██╔════╝██╔══██╗██╔═══██╗╚██╗██╔╝
echo  ██║ █╗ ██║██║   ██║██║   ██║  ███╔╝ ██║     █████╗  ██████╔╝██║   ██║ ╚███╔╝ 
echo  ██║███╗██║██║   ██║██║   ██║ ███╔╝  ██║     ██╔══╝  ██╔══██╗██║   ██║ ██╔██╗ 
echo  ╚███╔███╔╝╚██████╔╝╚██████╔╝███████╗███████╗███████╗██████╔╝╚██████╔╝██╔╝ ██╗
echo   ╚══╝╚══╝  ╚═════╝  ╚═════╝ ╚══════╝╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝
echo.
echo  Self-hosted AI toolbox launcher
echo  ============================================================
echo.

:: ── Check we're in the right directory ──────────────────────────────────────
if not exist "docker-compose.yml" (
    echo  [ERROR] docker-compose.yml not found.
    echo  Run this script from the woozlebox repo root directory.
    echo.
    pause
    exit /b 1
)

:: ── Check Docker is available ────────────────────────────────────────────────
echo  [1/4] Checking Docker...
docker info >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Docker is not running or not installed.
    echo  Start Docker Desktop and try again.
    echo.
    pause
    exit /b 1
)
echo        Docker OK

:: ── Check NVIDIA GPU passthrough ────────────────────────────────────────────
echo  [2/4] Checking GPU access...
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo  [WARNING] GPU check failed - NVIDIA Container Toolkit may not be installed.
    echo  See: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
    echo.
    set /p CONT="  Continue anyway? (y/N): "
    if /i "!CONT!" neq "y" exit /b 1
) else (
    echo        GPU OK
)

:: ── Check Orpheus clone ──────────────────────────────────────────────────────
echo  [3/4] Checking Orpheus FastAPI...
if not exist "orpheus\" (
    echo        orpheus\ not found - cloning now...
    git clone https://github.com/Lex-au/Orpheus-FastAPI.git orpheus
    if errorlevel 1 (
        echo  [ERROR] Failed to clone Orpheus FastAPI.
        echo  Check your internet connection or clone manually:
        echo    git clone https://github.com/Lex-au/Orpheus-FastAPI.git orpheus
        echo.
        pause
        exit /b 1
    )
    echo        Orpheus cloned OK
) else (
    echo        Orpheus OK
)

:: ── Start WoozleBox ──────────────────────────────────────────────────────────
echo  [4/4] Starting WoozleBox...
echo.
echo  ============================================================
echo  NOTE: First run downloads ~100 GB of models. This will take
echo  a while. Track the LLM pull with:
echo    docker compose logs -f ollama
echo  ============================================================
echo.

docker compose up -d
if errorlevel 1 (
    echo.
    echo  [ERROR] docker compose up failed. Check the output above.
    pause
    exit /b 1
)

echo.
echo  ============================================================
echo  WoozleBox is starting up!
echo.
echo  Open http://localhost:8080 in your browser.
echo  First visit: admin setup screen to create your account.
echo  Subsequent visits: login screen.
echo.
echo  Useful commands:
echo    docker compose logs -f          (all logs)
echo    docker compose logs -f ollama   (LLM download progress)
echo    docker compose down             (stop everything)
echo  ============================================================
echo.

:: Optionally open browser after a short delay
set /p OPENBROWSER="  Open http://localhost:8080 in browser now? (Y/n): "
if /i "!OPENBROWSER!" neq "n" (
    timeout /t 3 /nobreak >nul
    start http://localhost:8080
)

echo.
echo  Done. Press any key to exit this window.
pause >nul
endlocal
