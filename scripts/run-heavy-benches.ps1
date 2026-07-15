# Launch 3 parallel headless Libra benches on real hy3 (external parallelism)
$ErrorActionPreference = "Continue"
$env:PATH = "C:\Users\rias\.bun\bin;" + $env:PATH
$Libra = "C:\Users\rias\Desktop\libra"
$Root = "C:\Users\rias\Desktop\libra-bench-heavy"
$Model = if ($env:LIBRA_BENCH_MODEL) { $env:LIBRA_BENCH_MODEL } else { "tencent/hy3:free" }
$Provider = if ($env:LIBRA_BENCH_PROVIDER) { $env:LIBRA_BENCH_PROVIDER } else { "openrouter" }

$benches = @(
  @{ id = "A-kv-store"; label = "bench-A-kv" },
  @{ id = "B-http-router"; label = "bench-B-router" },
  @{ id = "C-markdown-lint"; label = "bench-C-mdlint" }
)

Write-Host "=== TUI stream layout microbench ==="
Push-Location $Libra
& bun scripts/bench-tui-stream.ts --chars 120000
$layoutExit = $LASTEXITCODE
Pop-Location
if ($layoutExit -ne 0) {
  Write-Host "Layout microbench FAILED - aborting live hy3 runs"
  exit $layoutExit
}

$jobs = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
foreach ($b in $benches) {
  $cwd = Join-Path $Root $b.id
  $out = Join-Path $cwd ".bench-run"
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  $prompt = Join-Path $cwd "TASK.md"
  if (-not (Test-Path $prompt)) {
    Write-Host "MISSING $prompt - skip $($b.id)"
    continue
  }
  $log = Join-Path $out "runner.log"
  $dbg = Join-Path $out "harness-debug.log"
  $label = $b.label

  $lines = @(
    "`$env:PATH = 'C:\Users\rias\.bun\bin;' + `$env:PATH"
    "Set-Location '$Libra'"
    "`$env:LIBRA_DEBUG = 'info'"
    "`$env:LIBRA_PERF = '1'"
    "`$env:LIBRA_DEBUG_FILE = '$dbg'"
    "bun scripts/debug-live-run.ts --provider $Provider --model $Model --cwd '$cwd' --prompt-file '$prompt' --out '$out' --label '$label' --max-steps 48 --timeout-ms 720000 2>&1 | Tee-Object -FilePath '$log'"
  )
  $scriptPath = Join-Path $out "_launch.ps1"
  Set-Content -Path $scriptPath -Value ($lines -join "`n") -Encoding UTF8
  Write-Host "START $($b.id) model=$Provider/$Model"
  $p = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $scriptPath
  ) -PassThru -WindowStyle Hidden
  $jobs.Add($p) | Out-Null
}

if ($jobs.Count -eq 0) {
  Write-Host "No benches launched"
  exit 1
}

Write-Host ("PIDs: " + (($jobs | ForEach-Object { $_.Id }) -join ", "))
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
  $log = Join-Path $Root "$($b.id)\.bench-run\runner.log"
  if (Test-Path $log) {
    Write-Host "--- $($b.id) perf/phase tail ---"
    Get-Content $log -Tail 40
  }
}
