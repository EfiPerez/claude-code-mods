# keep-awake.ps1 - started by the cache-monitor mod ($.process.spawn) while a chat is working,
# waiting on the user's answer, or waiting on background work. It asks Windows to keep the
# system running (ES_SYSTEM_REQUIRED): the screen still turns off and locks on its normal
# timer, but Modern Standby no longer freezes the mod's timer or cuts the network, so the
# cache keep-alive and the idle handoff can still run. On one test laptop, screen off + held
# used ~19%/h of battery vs ~11-12%/h in normal standby.
#
# Battery guard: on battery below -MinCharge percent the request is released (the process
# keeps running so the mod can see it) and taken again once the charge or the charger is back.
# It prints one line every 30 s; the mod ends it by leaving its read loop, which kills it.
# -MaxMinutes is a last-resort cap in case the mod never ends it.
param([int]$MinCharge = 30, [int]$MaxMinutes = 180)

$ErrorActionPreference = 'Stop'
Add-Type -Namespace CacheMonitor -Name Power -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
'@
Add-Type -AssemblyName System.Windows.Forms

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1

function Test-PowerOk {
    $p = [System.Windows.Forms.SystemInformation]::PowerStatus
    if ($p.PowerLineStatus -eq [System.Windows.Forms.PowerLineStatus]::Online) { return $true }
    # BatteryLifePercent is 0..1; 255 (shown as > 1) means unknown, e.g. no battery
    if ($p.BatteryLifePercent -gt 1) { return $true }
    return ($p.BatteryLifePercent * 100) -ge $MinCharge
}

$end = (Get-Date).AddMinutes($MaxMinutes)
$holding = $null
try {
    while ((Get-Date) -lt $end) {
        $ok = Test-PowerOk
        if ($ok -ne $holding) {
            if ($ok) { [void][CacheMonitor.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) }
            else { [void][CacheMonitor.Power]::SetThreadExecutionState($ES_CONTINUOUS) }
            $holding = $ok
        }
        if ($holding) { [Console]::Out.WriteLine('hold') } else { [Console]::Out.WriteLine('release: battery low') }
        [Console]::Out.Flush()
        Start-Sleep -Seconds 30
    }
} finally {
    [void][CacheMonitor.Power]::SetThreadExecutionState($ES_CONTINUOUS)
}
