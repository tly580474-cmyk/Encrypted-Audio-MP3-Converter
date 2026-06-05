$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 4317
$url = "http://127.0.0.1:$port"

function Test-AppRunning {
    try {
        Invoke-RestMethod -Uri "$url/api/defaults" -Method Get -TimeoutSec 1 | Out-Null
        return $true
    } catch {
        return $false
    }
}

Set-Location $root

if (-not (Test-AppRunning)) {
    Start-Process -FilePath "node" -ArgumentList "`"$root\app\server.js`"" -WorkingDirectory $root -WindowStyle Minimized
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
        if (Test-AppRunning) { break }
        Start-Sleep -Milliseconds 300
    }
}

Start-Process $url
