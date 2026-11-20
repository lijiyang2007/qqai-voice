@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stopping old guard windows...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*start.bat*' -and $_.CommandLine -notlike '*restart.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Stopping old bridge processes...
rem NOTE: start.bat launches `node src/bridge.js` with a RELATIVE path, so
rem Win32_Process.CommandLine never contains the repo path -- matching on
rem '*%~dp0src\bridge.js*' can never match (that was the old bug: "restart"
rem just started another instance while the old bridge kept running).
rem We now kill by PID (read from the lock file) plus a '*bridge.js*' fallback.
powershell -NoProfile -Command "$lock = Join-Path '%~dp0' 'state\bridge.lock'; $pids = @(); if (Test-Path $lock) { $raw = (Get-Content $lock -Raw).Trim(); if ($raw -match '^\d+$') { $pids += [int]$raw } }; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' } | ForEach-Object { $pids += $_.ProcessId }; $pids | Sort-Object -Unique | ForEach-Object { Write-Host ('  kill PID ' + $_); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
rem Wait for the old instance to really exit (and release the console port)
rem before deleting the lock; otherwise we get two instances.
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$live = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' }; if ($live) { Write-Host 'bridge still alive:'; $live | ForEach-Object { Write-Host ('  PID ' + $_.ProcessId + '  ' + $_.CommandLine) }; exit 1 } else { exit 0 }"
if errorlevel 1 (
    echo.
    echo Restart aborted: refusing to risk two instances fighting over messages/state.
    echo Kill the PIDs listed above manually, then retry.
    pause
    exit /b 1
)
del state\bridge.lock 2>nul
start "" cmd /c start.bat
echo Guard window started.
