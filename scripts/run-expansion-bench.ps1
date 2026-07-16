# Heavy coding bench that exercises Libra expansion tools end-to-end.
#
# Usage (from libra repo):
#   powershell -NoProfile -File scripts/run-expansion-bench.ps1
#
# Env:
#   LIBRA_BENCH_PROVIDER  default opencode
#   LIBRA_BENCH_MODEL     default deepseek-v4-flash-free
#   LIBRA_BENCH_ROOT      default Desktop\libra-bench-expansion
#   LIBRA_BENCH_TIMEOUT_MS default 900000
#   LIBRA_BENCH_MAX_STEPS  default 56
#   LIBRA_BENCH_CDP_PORT   default 9335 (starts headless Chrome if found)

$ErrorActionPreference = "Continue"
$env:PATH = "C:\Users\rias\.bun\bin;" + $env:PATH
$Libra = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Libra "scripts\debug-live-run.ts"))) {
  $Libra = "C:\Users\rias\Desktop\libra"
}
$Root = if ($env:LIBRA_BENCH_ROOT) { $env:LIBRA_BENCH_ROOT } else { "C:\Users\rias\Desktop\libra-bench-expansion" }
$Provider = if ($env:LIBRA_BENCH_PROVIDER) { $env:LIBRA_BENCH_PROVIDER } else { "opencode" }
$Model = if ($env:LIBRA_BENCH_MODEL) { $env:LIBRA_BENCH_MODEL } else { "deepseek-v4-flash-free" }
$TimeoutMs = if ($env:LIBRA_BENCH_TIMEOUT_MS) { $env:LIBRA_BENCH_TIMEOUT_MS } else { "900000" }
$MaxSteps = if ($env:LIBRA_BENCH_MAX_STEPS) { $env:LIBRA_BENCH_MAX_STEPS } else { "56" }
$CdpPort = if ($env:LIBRA_BENCH_CDP_PORT) { $env:LIBRA_BENCH_CDP_PORT } else { "9335" }
$Scratch = if ($env:GROK_SCRATCH) { $env:GROK_SCRATCH } else { "C:\Users\rias\AppData\Local\Temp\grok-goal-035f9cef2dd1\implementer" }
$Out = Join-Path $Root ".bench-run"
New-Item -ItemType Directory -Force -Path $Out, $Scratch | Out-Null

Write-Host "=== Expansion heavy bench ==="
Write-Host "libra=$Libra"
Write-Host "cwd=$Root provider=$Provider model=$Model maxSteps=$MaxSteps"

# Optional CDP for browser_devtools
$chromeCandidates = @(
  (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
  (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
)
$chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$chromeProc = $null
if ($chrome) {
  $ud = Join-Path $env:TEMP "libra-bench-cdp-$CdpPort"
  New-Item -ItemType Directory -Force -Path $ud | Out-Null
  Get-NetTCPConnection -LocalPort ([int]$CdpPort) -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  $chromeProc = Start-Process -FilePath $chrome -ArgumentList @(
    "--headless=new",
    "--disable-gpu",
    "--remote-debugging-port=$CdpPort",
    "--user-data-dir=$ud",
    "https://example.com"
  ) -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Write-Host "CDP chrome pid=$($chromeProc.Id) port=$CdpPort"
} else {
  Write-Host "No Chrome/Edge found - browser_devtools may fail honestly"
}

$env:LIBRA_DEBUG = "info"
$env:LIBRA_PERF = "1"
$env:LIBRA_DEBUG_FILE = (Join-Path $Out "harness-debug.log")

Push-Location $Libra
try {
  $promptFile = Join-Path $Root "TASK.md"
  $runnerLog = Join-Path $Out "runner.log"
  & bun scripts/debug-live-run.ts `
    --provider $Provider `
    --model $Model `
    --cwd $Root `
    --prompt-file $promptFile `
    --out $Out `
    --label "bench-expansion" `
    --max-steps $MaxSteps `
    --timeout-ms $TimeoutMs `
    2>&1 | Tee-Object -FilePath $runnerLog
} finally {
  Pop-Location
  if ($chromeProc) {
    Stop-Process -Id $chromeProc.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "=== Analyzing agent loop ==="
Push-Location $Libra
$loopReport = Join-Path $Out "LOOP_ANALYSIS.md"
& bun scripts/analyze-agent-loop.ts $Out --write $loopReport
Copy-Item $loopReport (Join-Path $Scratch "expansion-bench-LOOP_ANALYSIS.md") -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Out "meta.json") (Join-Path $Scratch "expansion-bench-meta.json") -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Out "transcript.md") (Join-Path $Scratch "expansion-bench-transcript.md") -Force -ErrorAction SilentlyContinue
Pop-Location

Write-Host "=== Score workspace (tests/typecheck) ==="
if (Test-Path (Join-Path $Root "package.json")) {
  Push-Location $Root
  & bun install 2>&1 | Tee-Object -FilePath (Join-Path $Out "bun-install.log") | Out-Null
  & bun run typecheck 2>&1 | Tee-Object -FilePath (Join-Path $Out "typecheck.log")
  & bun test 2>&1 | Tee-Object -FilePath (Join-Path $Out "test.log")
  Pop-Location
}

Write-Host "DONE out=$Out"
Write-Host "Analysis: $loopReport"
