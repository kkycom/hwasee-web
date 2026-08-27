[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

# Claude supplies hook input on stdin. A Stop hook that was itself resumed by a
# previous Stop decision must not recursively launch another reviewer.
$hookInput = $null
try {
  $rawInput = [Console]::In.ReadToEnd()
  if ($rawInput) { $hookInput = $rawInput | ConvertFrom-Json }
} catch {
  # The state file is sufficient; input is used only as a recursion safeguard.
}
if ($hookInput -and $hookInput.stop_hook_active) { exit 0 }

$reviewsRoot = Join-Path $repoRoot '.agent-reviews'
if (-not (Test-Path -LiteralPath $reviewsRoot)) { exit 0 }

$pendingState = Get-ChildItem -LiteralPath $reviewsRoot -Filter 'review-state.json' -Recurse -File |
  ForEach-Object {
    try {
      $state = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
      if ($state.status -eq 'pending') {
        [PSCustomObject]@{ Path = $_.FullName; State = $state; Modified = $_.LastWriteTimeUtc }
      }
    } catch { }
  } |
  Sort-Object Modified -Descending |
  Select-Object -First 1

if (-not $pendingState) { exit 0 }

$state = $pendingState.State
$reviewDir = Split-Path -Parent $pendingState.Path
$outputPath = Join-Path $reviewDir "codex-$($state.phase).md"
$requestScript = Join-Path $PSScriptRoot 'request-codex-review.ps1'

try {
  if ($state.phase -eq 'discovery') {
    & $requestScript -Phase discovery -TaskId $state.task_id -AgendaPath $state.agenda_path
  } else {
    & $requestScript -Phase $state.phase -TaskId $state.task_id -AgendaPath $state.agenda_path -PlanPath $state.material_path
  }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath)) {
    throw "The Codex command did not produce $outputPath."
  }
  $newStatus = 'ready'
  $reason = "Codex $($state.phase) review is ready at .agent-reviews/$($state.task_id)/codex-$($state.phase).md. Read it, address only BLOCKER findings, then register the next phase or finish the task."
} catch {
  $newStatus = 'failed'
  $reason = "Codex $($state.phase) review could not run: $($_.Exception.Message). Do not bypass review. Report this exact blocker and request the needed environment fix."
}

$updatedState = [ordered]@{
  task_id = $state.task_id
  phase = $state.phase
  status = $newStatus
  agenda_path = $state.agenda_path
  material_path = $state.material_path
  attempts = ([int]$state.attempts + 1)
}
$updatedState | ConvertTo-Json | Set-Content -LiteralPath $pendingState.Path -Encoding utf8

@{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress
