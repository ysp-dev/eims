@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "PORT=7000"
set "FOUND="

echo Hostname:
hostname
echo.
echo Checking TCP port %PORT%...
echo.

netstat -ano -p tcp | findstr /C:":%PORT%"

echo.
echo Stopping processes that own LISTENING sockets on port %PORT%...

for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /C:":%PORT%" ^| findstr /I "LISTENING"') do (
    set "FOUND=1"
    echo Stopping PID %%P
    taskkill /F /PID %%P
)

if not defined FOUND (
    echo No LISTENING process was found on port %PORT% on this PC.
    echo If clients can still connect, they may be connecting to another PC/IP,
    echo or to a cached page without reaching this server.
)

echo.
echo Rechecking TCP port %PORT%...
netstat -ano -p tcp | findstr /C:":%PORT%"

echo.
echo Done. Press any key to close this window.
pause >nul

endlocal
