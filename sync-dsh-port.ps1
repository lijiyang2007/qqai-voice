# Sync qq-bridge config.json dsh.baseUrl to the port DSH is actually listening on.
#
# Why: the DSH desktop app picks a random loopback port on every launch
# (observed 19387 -> 63197). The bridge mints its auth cookie bound to
# host:port, so a stale baseUrl means 401 / ECONNREFUSED forever.
# Run this before starting the bridge.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$configPath = Join-Path $PSScriptRoot 'config.json'
if (!(Test-Path $configPath)) { Write-Host '[sync] config.json not found'; exit 1 }

# Identify DSH's own processes so SnowLuma (port 3000 also answers 401) is not mistaken for DSH.
$dshPids = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*DeepSeek Harness*' -or $_.CommandLine -like '*dsh-desktop-host*' -or $_.CommandLine -like '*app.asar*dsh*' } |
    Select-Object -ExpandProperty ProcessId

$candidates = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $dshPids -contains $_.OwningProcess } |
    Select-Object -ExpandProperty LocalPort -Unique

# Confirm with the 401 that DSH returns for unauthenticated requests.
$found = $null
foreach ($port in $candidates) {
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    } catch {
        $resp = $_.Exception.Response
        if ($resp -and [int]$resp.StatusCode -eq 401) { $found = $port; break }
    }
}

if (!$found) {
    Write-Host '[sync] no DSH port detected; keeping existing baseUrl'
    exit 0
}

$text = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8)
$pattern = '("baseUrl"\s*:\s*")http://127\.0\.0\.1:\d+(")'
$replacement = '${1}http://127.0.0.1:' + $found + '${2}'
$new = [regex]::Replace($text, $pattern, $replacement)

if ($new -ne $text) {
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($configPath, $new, $utf8)
    Write-Host "[sync] DSH port set to $found"
} else {
    Write-Host "[sync] DSH port already $found"
}
exit 0
