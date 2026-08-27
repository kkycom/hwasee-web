[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('discovery', 'plan', 'final')]
  [string]$Phase,

  [Parameter(Mandatory)]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]*$')]
  [string]$TaskId,

  [Parameter(Mandatory)]
  [string]$AgendaPath,

  [string]$PlanPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$agendaFullPath = Join-Path $repoRoot $AgendaPath

if (-not (Test-Path -LiteralPath $agendaFullPath)) {
  throw "Agenda file not found: $AgendaPath"
}

if ($Phase -ne 'discovery' -and [string]::IsNullOrWhiteSpace($PlanPath)) {
  throw "-PlanPath is required for the $Phase review."
}

$reviewDir = Join-Path $repoRoot ".agent-reviews/$TaskId"
New-Item -ItemType Directory -Force -Path $reviewDir | Out-Null
$outputPath = Join-Path $reviewDir "codex-$Phase.md"

$agenda = Get-Content -LiteralPath $agendaFullPath -Raw
$plan = ''
if ($PlanPath) {
  $planFullPath = Join-Path $repoRoot $PlanPath
  if (-not (Test-Path -LiteralPath $planFullPath)) {
    throw "Plan or final-evidence file not found: $PlanPath"
  }
  $plan = Get-Content -LiteralPath $planFullPath -Raw
}

$phaseInstructions = switch ($Phase) {
  'discovery' { @'
Perform an independent, adversarial diagnosis from the original agenda below. Do not assume the lead developer's conclusion, do not edit files, and do not propose a broad redesign without code evidence. Inspect relevant code paths. Return Verdict, then BLOCKER/WARNING/OPTIONAL findings, each with evidence and the smallest safe recommendation. If there is no material issue, say APPROVE and explain what you verified.
'@ }
  'plan' { @'
Review the lead developer's proposed plan against the original agenda and the current repository. Do not edit files. Check whether the root cause is proven, whether existing behavior already solves part of it, and whether the plan causes security, SEO, SSG, data, or deployment regressions. Return Verdict, then BLOCKER/WARNING/OPTIONAL findings with evidence and the smallest safe alternative.
'@ }
  'final' { @'
Review the actual uncommitted implementation, test evidence, and the original agenda. Do not edit files. Inspect the diff yourself; do not trust the summary alone. Return only actionable BLOCKER/WARNING/OPTIONAL findings. Do not turn style preferences or unrelated refactors into blockers. If there are no blockers, state APPROVE.
'@ }
}

$prompt = @"
You are Codex, the independent reviewer for the hwasee-web repository. You are strictly read-only for this run.

$phaseInstructions

## Original user agenda
$agenda
"@

if ($Phase -ne 'discovery') {
  $prompt += @"

## Lead developer material
$plan
"@
}

$codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codex) {
  throw 'Codex CLI was not found on PATH. Configure the Codex command in Orca before running this review.'
}

& $codex.Source -s read-only -a never exec -C $repoRoot -o $outputPath $prompt
if ($LASTEXITCODE -ne 0) {
  throw "Codex $Phase review failed with exit code $LASTEXITCODE."
}

Write-Host "Codex $Phase review saved to $outputPath"
