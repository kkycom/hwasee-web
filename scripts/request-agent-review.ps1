[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]*$')]
  [string]$TaskId,

  [Parameter(Mandatory)]
  [ValidateSet('plan', 'final')]
  [string]$Phase,

  [Parameter(Mandatory)]
  [string]$AgendaPath,

  [Parameter(Mandatory)]
  [string]$MaterialPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$reviewDir = Join-Path $repoRoot ".agent-reviews/$TaskId"
$statePath = Join-Path $reviewDir 'review-state.json'

if (-not (Test-Path -LiteralPath $statePath)) {
  throw "No review state exists for $TaskId. Run start-agent-review.ps1 first."
}

foreach ($relativePath in @($AgendaPath, $MaterialPath)) {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $relativePath))) {
    throw "Review input file not found: $relativePath"
  }
}

$state = [ordered]@{
  task_id = $TaskId
  phase = $Phase
  status = 'pending'
  agenda_path = $AgendaPath
  material_path = $MaterialPath
  attempts = 0
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
Write-Host "Codex $Phase review registered for $TaskId. The Claude Stop Hook will run it automatically."
