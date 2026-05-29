@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

title WoozleBox Shutdown
color 0C

echo.
echo  ██╗    ██╗ ██████╗  ██████╗ ███████╗██╗     ███████╗██████╗  ██████╗ ██╗  ██╗
echo  ██║    ██║██╔═══██╗██╔═══██╗╚══███╔╝██║     ██╔════╝██╔══██╗██╔═══██╗╚██╗██╔╝
echo  ██║ █╗ ██║██║   ██║██║   ██║  ███╔╝ ██║     █████╗  ██████╔╝██║   ██║ ╚███╔╝
echo  ██║███╗██║██║   ██║██║   ██║ ███╔╝  ██║     ██╔══╝  ██╔══██╗██║   ██║ ██╔██╗
echo  ╚███╔███╔╝╚██████╔╝╚██████╔╝███████╗███████╗███████╗██████╔╝╚██████╔╝██╔╝ ██╗
echo   ╚══╝╚══╝  ╚═════╝  ╚═════╝ ╚══════╝╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝
echo.
echo  Self-hosted AI toolbox shutdown
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

:: ── Stop services ───────────────────────────────────────────────────────────
echo  Stopping WoozleBox services...
echo.

docker compose down
if errorlevel 1 (
    echo.
    echo  [ERROR] docker compose down failed.
    pause
    exit /b 1
)

echo.
echo  ============================================================
echo  WoozleBox has stopped.
echo.
echo  To restart, run:
echo    start.bat
echo.
echo  To remove all data (volumes) as well:
echo    docker compose down -v
echo  ============================================================
echo.

echo  Done. Press any key to exit this window.
pause >nul
endlocal
