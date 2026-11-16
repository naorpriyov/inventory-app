# Stops or restarts the background server (task "InventoryServer").
# The server can run before anyone signs in, where a normal user may not end its processes,
# so this leaves a request for the server's own watchdog (server_background.py) to carry out.
param([ValidateSet("stop", "restart")][string]$Action = "restart")

$Base = Split-Path -Parent $MyInvocation.MyCommand.Path
$Request = Join-Path $Base "logs\control.request"
$Port = 8000

function Get-ServerPid { (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }

$before = Get-ServerPid
if (-not $before) {
    if ($Action -eq "stop") { Write-Output "The server is not running."; return }
    Start-ScheduledTask -TaskName InventoryServer
} else {
    New-Item -ItemType Directory -Force (Split-Path $Request) | Out-Null
    Set-Content -Path $Request -Value $Action -Encoding ASCII
}

# wait for the result
$deadline = (Get-Date).AddSeconds(40)
do {
    Start-Sleep -Seconds 1
    $now = Get-ServerPid
    if ($Action -eq "stop" -and -not $now) { break }
    if ($Action -eq "restart" -and $now -and $now -ne $before) { break }
} while ((Get-Date) -lt $deadline)

if ($Action -eq "stop") {
    if (-not (Get-ServerPid)) { Write-Output "Server stopped." }
    else { Write-Output "The server did not stop. See logs\server.log" }
} else {
    if ($now -and $now -ne $before) { Write-Output ("Server restarted: " + (& python (Join-Path $Base "update_link.py") 2>$null)) }
    else { Write-Output "The server did not restart. See logs\server.log" }
}
Remove-Item $Request -ErrorAction SilentlyContinue
