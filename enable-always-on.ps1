# Makes the server start when the computer turns on, even before anyone signs in to Windows.
# Windows asks once for administrator approval (UAC).
$Base = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = (Get-Command python -ErrorAction Stop).Source
$user = "$env:USERDOMAIN\$env:USERNAME"
$script = Join-Path $Base "setup-autostart.ps1"
$log = Join-Path $env:TEMP "inventory-always-on.log"
$cmd = "& { & '$($script.Replace("'","''"))' -AlwaysOn -ForUser '$user' -PythonExe '$($python.Replace("'","''"))' *> '$log' }"
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
Remove-Item $log -ErrorAction SilentlyContinue
try {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $enc
} catch {
    Write-Output "The Windows approval was cancelled. Nothing changed."
    return
}
if (Test-Path $log) { Get-Content $log }
