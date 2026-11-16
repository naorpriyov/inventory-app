# Registers the Windows scheduled task "InventoryServer" that runs the server in the background (no window).
#   setup-autostart.ps1            -> starts at sign-in to Windows (no admin needed)
#   setup-autostart.ps1 -AlwaysOn  -> starts when the computer turns on, even before anyone signs in (needs admin)
#   setup-autostart.ps1 -Remove    -> removes the auto-start
# server_background.py restarts the server within seconds if it stops; the task also re-checks every 5 minutes.
param([switch]$Remove, [switch]$AlwaysOn, [string]$ForUser, [string]$PythonExe)

$TaskName = "InventoryServer"
$Base = Split-Path -Parent $MyInvocation.MyCommand.Path
$User = if ($ForUser) { $ForUser } else { "$env:USERDOMAIN\$env:USERNAME" }

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Auto-start removed."
    return
}

$python = if ($PythonExe) { $PythonExe } else { (Get-Command python -ErrorAction Stop).Source }
$pythonw = Join-Path (Split-Path -Parent $python) "pythonw.exe"
if (-not (Test-Path $pythonw)) { throw "pythonw.exe not found next to $python" }

$action = New-ScheduledTaskAction -Execute $pythonw -Argument ('"' + (Join-Path $Base "server_background.py") + '"') -WorkingDirectory $Base
# Safety net: every 5 minutes Windows tries to start it again; if it is already running nothing happens
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

if ($AlwaysOn) {
    # Runs as this user without a password and without signing in ("S4U"); starts with the computer
    $triggers = @((New-ScheduledTaskTrigger -AtStartup), $every5)
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
    $desc = "Inventory app server (background, starts with the computer)"
} else {
    $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $User), $every5)
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
    $desc = "Inventory app server (background, starts at sign-in)"
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
    -Description $desc -Force | Out-Null
if ($AlwaysOn) { Write-Output "Done: the server now starts when the computer turns on, even before signing in." }
else { Write-Output "Done: the server starts in the background at every sign-in." }
