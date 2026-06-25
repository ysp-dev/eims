@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if errorlevel 1 (
    echo Cannot open eims folder.
    pause
    exit /b 1
)

set "PORT=7070"
set "NODE_EXE="
set "FOUND="

echo Hostname:
hostname
echo.
echo eims folder:
echo %CD%
echo.

where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
)

if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
)

if not defined NODE_EXE if exist "%APPDATA%\nvm" (
    for /d %%D in ("%APPDATA%\nvm\v*") do (
        if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
    )
)

if not defined NODE_EXE (
    echo Node.js was not found.
    echo Install Node.js from https://nodejs.org/
    echo Check "Add to PATH" during installation.
    echo Then run start.bat again.
    pause
    exit /b 1
)

if not exist "%CD%\server.js" (
    echo server.js was not found in this folder.
    pause
    exit /b 1
)

if not exist "%CD%\data" mkdir "%CD%\data"
if not exist "%CD%\data\employees.json" echo []> "%CD%\data\employees.json"

if not exist "%CD%\data\auth.json" set "EIMS_PASSWORD=0000"

echo Checking port %PORT% before start...
netstat -ano -p tcp | findstr /C:":%PORT%"
echo.

for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /C:":%PORT%" ^| findstr /I "LISTENING"') do (
    set "FOUND=1"
    echo Server already appears to be running. PID %%P
)

if defined FOUND goto DONE

echo Starting eims server...
echo URL: http://localhost:%PORT%
echo.

powershell -NoProfile -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList '%CD%\server.js' -WorkingDirectory '%CD%' -WindowStyle Hidden"

timeout /t 3 /nobreak >nul

echo Checking port %PORT% after start...
netstat -ano -p tcp | findstr /C:":%PORT%"
echo.

netstat -ano -p tcp | findstr /C:":%PORT%" | findstr /I "LISTENING" >nul
if errorlevel 1 (
    echo Server did not start on port %PORT%.
    echo Try this command manually:
    echo "%NODE_EXE%" "%CD%\server.js"
    echo.
    echo Press any key to close this window.
    pause >nul
    exit /b 1
)

:DONE
echo Done. Press any key to close this window.
pause >nul

endlocal
