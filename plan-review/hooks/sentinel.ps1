param(
    [Parameter(Mandatory = $true)][string]$PlansFolder,
    [Parameter(Mandatory = $true)][string]$Hash,
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [Parameter(Mandatory = $true)][string]$Owner
)

$ErrorActionPreference = 'Stop'
$sentinelPath = Join-Path $PlansFolder '.codec-reviewed.json'
$lockPath = Join-Path $PlansFolder '.codec-sentinel.lock'
$lock = $null
$created = $false

try {
    try {
        $lock = [IO.File]::Open($lockPath, 'CreateNew', 'Write', 'None')
        $created = $true
    }
    catch [IO.IOException] {
        # An unreadable fresh lock may still be receiving its lease bytes.
        $stale = $false
        try {
            $lease = (Get-Content -LiteralPath $lockPath -Raw -Encoding utf8 | ConvertFrom-Json).lease_until
            if (-not $lease) { throw 'Missing lock lease.' }
            $stale = ([datetime]$lease).ToUniversalTime() -le (Get-Date).ToUniversalTime()
        }
        catch {
            try { $stale = (Get-Item -LiteralPath $lockPath).LastWriteTimeUtc -le (Get-Date).ToUniversalTime().AddMinutes(-2) }
            catch { $stale = $false }
        }
        if (-not $stale) { Write-Output 'skip-locked'; exit 0 }
        try {
            Remove-Item -LiteralPath $lockPath -Force
            $lock = [IO.File]::Open($lockPath, 'CreateNew', 'Write', 'None')
            $created = $true
        }
        catch [IO.IOException] { Write-Output 'skip-locked'; exit 0 }
    }

    $leaseBytes = [Text.Encoding]::UTF8.GetBytes((@{
        pid = $PID
        lease_until = (Get-Date).ToUniversalTime().AddMinutes(2).ToString('o')
    } | ConvertTo-Json))
    $lock.Write($leaseBytes, 0, $leaseBytes.Length)
    $lock.Flush()

    $sentinel = @{}
    if (Test-Path -LiteralPath $sentinelPath) {
        try {
            $existing = Get-Content -LiteralPath $sentinelPath -Raw -Encoding utf8 | ConvertFrom-Json
            if ($null -eq $existing -or $existing -isnot [pscustomobject]) { throw 'Review record must be a JSON object.' }
            foreach ($p in $existing.PSObject.Properties) { $sentinel[$p.Name] = $p.Value }
        }
        catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }
    }

    if ($sentinel.ContainsKey($Hash)) {
        $entry = $sentinel[$Hash]
        if ($entry.state -eq 'reviewed') { Write-Output 'skip-reviewed'; exit 0 }
        $leaseOk = $false
        if ($entry.lease_until) {
            try { $leaseOk = ([datetime]$entry.lease_until).ToUniversalTime() -gt (Get-Date).ToUniversalTime() }
            catch { $leaseOk = $false }
        }
        if ($entry.state -eq 'reviewing' -and $leaseOk) { Write-Output 'skip-in-flight'; exit 0 }
    }

    $sentinel[$Hash] = @{
        state       = 'reviewing'
        owner       = $Owner
        lease_until = (Get-Date).ToUniversalTime().AddMinutes(20).ToString('o')
        paths       = @($PlanPath)
    }
    $tmp = $sentinelPath + '.tmp'
    [IO.File]::WriteAllText($tmp, ($sentinel | ConvertTo-Json -Depth 5),
                          (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $sentinelPath -Force
    Write-Output 'review'
}
finally {
    if ($lock) { $lock.Dispose() }
    if ($created) { Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }
}
