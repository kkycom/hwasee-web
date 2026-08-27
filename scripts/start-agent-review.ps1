[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]*$')]
  [string]$TaskId,

  [Parameter(Mandatory)]
  [string]$AgendaPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$reviewDir = Join-Path $repoRoot ".agent-reviews/$TaskId"
$agendaFullPath = Join-Path $repoRoot $AgendaPath

if (-not (Test-Path -LiteralPath $agendaFullPath)) {
  throw "Agenda file not found: $AgendaPath"
}

New-Item -ItemType Directory -Force -Path $reviewDir | Out-Null
$statePath = Join-Path $reviewDir 'review-state.json'
if (Test-Path -LiteralPath $statePath) {
  throw "A review state already exists for $TaskId. Use request-agent-review.ps1 for a later phase."
}

$state = [ordered]@{
  task_id = $TaskId
  phase = 'discovery'
  status = 'pending'
  agenda_path = $AgendaPath
  material_path = $null
  attempts = 0
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
Write-Host "Codex discovery registered for $TaskId. The Claude Stop Hook will run it automatically."
