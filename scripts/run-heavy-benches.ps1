# Launch 3 parallel headless Libra benches (external parallelism — not Libra subagents)
$ErrorActionPreference = "Continue"
$Libra = "C:\Users\rias\Desktop\libra"
$Root = "C:\Users\rias\Desktop\libra-bench-heavy"
$benches = @(
  @{ id = "A-kv-store"; label = "bench-A-kv" },
  @{ id = "B-http-router"; label = "bench-B-router" },
  @{ id = "C-markdown-lint"; label = "bench-C-mdlint" }
)

$jobs = @()
foreach ($b in $benches) {
  $cwd = Join-Path $Root $b.id
  $out = Join-Path $cwd ".bench-run"
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  $prompt = Join-Path $cwd "TASK.md"
  $log = Join-Path $out "runner.log"
  $dbg = Join-Path $out "harness-debug.log"

  $script = @"
Set-Location '$Libra'
`$env:LIBRA_DEBUG = 'info'
`$env:LIBRA_DEBUG_FILE = '$dbg'
npx tsx scripts/debug-live-run.ts --cwd '$cwd' --prompt-file '$prompt' --out '$out' --label '$($b.label)' --max-steps 48 --timeout-ms 720000 2>&1 | Tee-Object -FilePath '$log'
"@
  $scriptPath = Join-Path $out "_launch.ps1"
  Set-Content -Path $scriptPath -Value $script -Encoding UTF8
  Write-Host "START $($b.id)"
  $jobs += Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath) -PassThru -WindowStyle Hidden
}

Write-Host "PIDs: $($jobs.Id -join ', ')"
# Wait up to 15 minutes
$jobs | Wait-Process -Timeout 900 -ErrorAction SilentlyContinue
foreach ($j in $jobs) {
  if (-not $j.HasExited) {
    Write-Host "KILL hung PID $($j.Id)"
    Stop-Process -Id $j.Id -Force -ErrorAction SilentlyContinue
  }
}
Write-Host "ALL DONE"
foreach ($b in $benches) {
  $meta = Join-Path $Root "$($b.id)\.bench-run\meta.json"
  if (Test-Path $meta) {
    Write-Host "=== $($b.id) meta ==="
    Get-Content $meta -Raw
  } else {
    Write-Host "=== $($b.id) NO meta ==="
  }
}
