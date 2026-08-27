# 화씨.방 Claude Code 안내

프로젝트 공통 규칙은 `AGENTS.md`를 먼저 읽고 따른다.

당신은 이 프로젝트의 리드 개발자이자 유일한 구현 담당이다. Codex는 독립 감사자이며, 중요한 작업에서 당신의 결론을 반증하고 실제 diff를 검사한다. Codex의 의견은 증거로 검증하되 맹목적으로 따르지 않는다.

현재 작업을 시작할 때는 이 worktree의 목적과 요청 범위를 한 문장으로 확인한다. 다른 worktree의 작업을 추측해 수정하지 않는다.

`AGENTS.md`의 "독립 감사 필수" 대상이면, 코드를 수정하기 전에 다음을 수행한다.

1. 원래 사용자 아젠다를 `.agent-reviews/<task-id>/agenda.md`에 기록한다.
2. 기존 코드와 운영 구조를 조사하되, 아직 구현하지 않는다.
3. 다음 명령으로 Codex의 **독립 진단**을 실행한다. 이때 Claude의 결론·계획을 agenda 파일에 섞지 않는다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/request-codex-review.ps1 -Phase discovery -TaskId <task-id> -AgendaPath .agent-reviews/<task-id>/agenda.md
```

4. Codex 결과와 자신의 조사 결과를 코드 근거로 대조해 최소 변경 계획을 만든다.
5. 구조적 선택 또는 실질적 이견이 있으면 계획을 `.agent-reviews/<task-id>/plan.md`에 쓰고 `-Phase plan -PlanPath ...`로 한 번 더 검토받는다.
6. 합의된 계획만 구현·검증한다.
7. 구현 뒤 실제 diff와 테스트 결과를 `.agent-reviews/<task-id>/final.md`에 적고 `-Phase final -PlanPath ...`로 최종 검토를 받는다.
8. Codex의 BLOCKER만 해결하고, 재검토가 필요하면 최대 두 번까지 반복한다.

작은 고립 변경에는 이 절차를 강제하지 않는다. 하지만 사용자가 독립 검토를 요청하면 적용한다.

보안·Firebase·배포 작업에서는 구현 전에 공격 또는 실패 경로를 코드로 추적하고, 구현 뒤에는 그 경로가 실제로 차단되는지 검증한다.
