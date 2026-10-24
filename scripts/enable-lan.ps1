# Run as administrator once. Only TCP 8000 from the local subnet is allowed.
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator access is required. Right-click enable-lan.bat and choose Run as administrator.'
}
$ruleName = 'NoteWeb-LAN-TCP-8000'
$existingRule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($existingRule) {
    Set-NetFirewallRule -Name $ruleName -Enabled True -Direction Inbound -Action Allow -Profile Any -RemoteAddress LocalSubnet -Protocol TCP -LocalPort 8000 -EdgeTraversalPolicy Block | Out-Null
} else {
    New-NetFirewallRule -Name $ruleName -DisplayName 'Note Web - LAN only TCP 8000' -Enabled True -Direction Inbound -Action Allow -Profile Any -RemoteAddress LocalSubnet -Protocol TCP -LocalPort 8000 -EdgeTraversalPolicy Block | Out-Null
}
Write-Output 'Allowed TCP 8000 from the local subnet. The firewall remains enabled.'
