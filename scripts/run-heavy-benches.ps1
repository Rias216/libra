# Launch heavy coding benches with Ultra + Fusion (dual hy3 by default).
# Phase-1: main + peer both reason; phase-2: main compares + executes.
#
# Env overrides:
#   LIBRA_BENCH_MODEL      default tencent/hy3:free
#   LIBRA_BENCH_PROVIDER   default openrouter
#   LIBRA_BENCH_PEER       default openrouter/<model>  (same model = 2x hy3)
#   LIBRA_BENCH_ROOT       default Desktop\libra-bench-heavy
#   LIBRA_BENCH_PARALLEL   1 for parallel, 0 (default) sequential for free-tier
#   LIBRA_BENCH_TIMEOUT_MS default 900000

$ErrorActionPreference = "Continue"
$env:PATH = "C:\Users\rias\.bun\bin;" + $env:PATH
$Libra = "C:\Users\rias\Desktop\libra"
$Root = if ($env:LIBRA_BENCH_ROOT) { $env:LIBRA_BENCH_ROOT } else { "C:\Users\rias\Desktop\libra-bench-heavy" }
$Model = if ($env:LIBRA_BENCH_MODEL) { $env:LIBRA_BENCH_MODEL } else { "tencent/hy3:free" }
$Provider = if ($env:LIBRA_BENCH_PROVIDER) { $env:LIBRA_BENCH_PROVIDER } else { "openrouter" }
$Peer = if ($env:LIBRA_BENCH_PEER) { $env:LIBRA_BENCH_PEER } else { "$Provider/$Model" }
$TimeoutMs = if ($env:LIBRA_BENCH_TIMEOUT_MS) { $env:LIBRA_BENCH_TIMEOUT_MS } else { "900000" }
$Parallel = if ($env:LIBRA_BENCH_PARALLEL) { $env:LIBRA_BENCH_PARALLEL } else { "0" }

$benches = @(
  @{ id = "A-kv-store"; label = "bench-A-kv" },
  @{ id = "B-http-router"; label = "bench-B-router" },
  @{ id = "C-markdown-lint"; label = "bench-C-mdlint" }
)

Write-Host "=== Ultra+Fusion heavy benches ==="
Write-Host "provider=$Provider model=$Model peer=$Peer parallel=$Parallel root=$Root"
if ($Peer -eq "$Provider/$Model") {
  Write-Host "peer == main -> dual-sample 2x hy3 reasoning passes"
}

Write-Host "=== TUI stream layout microbench ==="
Push-Location $Libra
& bun scripts/bench-tui-stream.ts --chars 120000
$layoutExit = $LASTEXITCODE
Pop-Location
if ($layoutExit -ne 0) {
  Write-Host "Layout microbench FAILED - aborting live hy3 runs"
  exit $layoutExit
}

function Launch-Bench {
  param($b)
  $cwd = Join-Path $Root $b.id
  $out = Join-Path $cwd ".bench-run"
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  $prompt = Join-Path $cwd "TASK.md"
  if (-not (Test-Path $prompt)) {
    Write-Host "MISSING $prompt - skip $($b.id)"
    return $null
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
    "bun scripts/debug-live-run.ts --fusion --provider $Provider --model $Model --peer $Peer --cwd '$cwd' --prompt-file '$prompt' --out '$out' --label '$label' --max-steps 56 --timeout-ms $TimeoutMs --subagents 2>&1 | Tee-Object -FilePath '$log'"
  )
  $scriptPath = Join-Path $out "_launch.ps1"
  Set-Content -Path $scriptPath -Value ($lines -join "`n") -Encoding UTF8
  Write-Host "START $($b.id) mode=ultra-fusion main=$Provider/$Model peer=$Peer"
  if ($Parallel -eq "1") {
    return Start-Process -FilePath "powershell.exe" -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $scriptPath
    ) -PassThru -WindowStyle Hidden
  } else {
    # Sequential: better for free-tier rate limits on dual hy3
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath
    return $null
  }
}

$jobs = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
foreach ($b in $benches) {
  # Capture only Process objects — Launch-Bench may emit other pipeline noise
  $p = Launch-Bench $b
  if ($p -is [System.Diagnostics.Process]) {
    [void]$jobs.Add($p)
  }
}

if ($Parallel -eq "1") {
  if ($jobs.Count -eq 0) {
    Write-Host "No benches launched"
    exit 1
  }
  Write-Host ("PIDs: " + (($jobs | ForEach-Object { $_.Id }) -join ", "))
  $jobs | Wait-Process -Timeout 1200 -ErrorAction SilentlyContinue
  foreach ($j in $jobs) {
    if (-not $j.HasExited) {
      Write-Host "KILL hung PID $($j.Id)"
      Stop-Process -Id $j.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "ALL DONE - scoring"
Push-Location $Libra
foreach ($b in $benches) {
  $cwd = Join-Path $Root $b.id
  $out = Join-Path $cwd ".bench-run"
  $meta = Join-Path $out "meta.json"
  if (Test-Path $meta) {
    Write-Host "=== $($b.id) meta ==="
    Get-Content $meta -Raw
    Write-Host "=== $($b.id) score ==="
    & bun scripts/score-bench.ts $out --cwd $cwd
  } else {
    Write-Host "=== $($b.id) NO meta ==="
  }
  $fusion = Join-Path $out "fusion-phase1.json"
  if (Test-Path $fusion) {
    Write-Host "=== $($b.id) fusion phase-1 ==="
    try {
      $fj = Get-Content $fusion -Raw | ConvertFrom-Json
      Write-Host ("phase1Ms={0} mainChars={1} peerChars={2} mainErr={3} peerErr={4}" -f `
        $fj.phase1Ms, $fj.main.chars, $fj.peer.chars, $fj.main.error, $fj.peer.error)
    } catch {
      Write-Host "could not parse fusion-phase1.json"
    }
  }
  $log = Join-Path $out "runner.log"
  if (Test-Path $log) {
    Write-Host "--- $($b.id) log tail ---"
    Get-Content $log -Tail 30
  }
}
Pop-Location
Write-Host "=== heavy benches complete ==="
