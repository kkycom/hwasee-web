# 화씨.방 Claude Code 안내

프로젝트 공통 규칙은 `AGENTS.md`를 먼저 읽고 따른다. 당신은 이 프로젝트의 리드
개발자이자 유일한 구현 담당이며, 코드 수정부터 배포·라이브 반영 확인까지 끝까지 맡는다.

작업 시작 시 이 worktree의 목적과 요청 범위를 한 문장으로 확인하고, `AGENTS.md`의
두 메모 인덱스와 관련 메모만 읽는다. 이어서 `AGENTS.md`의 작업 등급 세 가지 중
하나를 고른다.

## 1·2등급 (빠른 / 보통 작업)

- **1등급**: 바로 구현 → 자체 확인 → 커밋·배포 → 라이브 반영 확인 → 보고.
  Codex·worktree·Hook 없이 진행한다.
- **2등급**: 구현·테스트 → Codex `final` 검토 한 번 → BLOCKER만 수정 → 배포·라이브
  확인 → 보고. discovery·plan은 구조가 크게 갈릴 때만 추가한다.
- 두 등급 모두 `bang/index.html`을 바꾸면 `bang/sw.js`의 `CACHE` 버전을 갱신하고
  바뀐 화면의 기본 회귀를 확인한다.

## 3등급 (중요한 작업) — 엄격한 절차 유지

대상은 `AGENTS.md`의 "3등급" 목록(보안·인증·세션·Firestore rules, Cloud Functions·
포인트·결제·외부 API 비용, 데이터 모델·마이그레이션, SSG·canonical·robots·sitemap·
OG·정적 빌드·배포 구조, 개인정보·약관, 글로벌 릴레이·번역 등 비용+UGC 결합 기능,
원인 불명 운영 회귀 버그).

이 경우에만 수정 전에 다음을 수행한다.

1. 최신 main 기반 worktree에서, 원래 사용자 아젠다와 `기존 확정 맥락`(공유 메모에서
   확인한 사실만, 자신의 결론·계획 제외)을 `.agent-reviews/<task-id>/agenda.md`에 적는다.
2. 기존 코드·운영 구조를 조사하되 구현하지 않는다.
3. Codex 독립 진단을 등록한다(Hook이 자동 실행; 없으면 `scripts/request-codex-review.ps1`
   직접 실행). `agenda.md`에 Claude의 결론·계획을 섞지 않는다.

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/start-agent-review.ps1 -TaskId <task-id> -AgendaPath .agent-reviews/<task-id>/agenda.md
   ```

4. `codex-discovery.md`를 읽고 자신의 조사와 코드 근거로 대조해 최소 변경 계획을 만든다.
5. 구조적 선택이나 실질적 이견이 있으면 `plan.md`를 쓰고 계획 검토를 등록한다.

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/request-agent-review.ps1 -TaskId <task-id> -Phase plan -AgendaPath .agent-reviews/<task-id>/agenda.md -MaterialPath .agent-reviews/<task-id>/plan.md
   ```

6. 합의된 계획만 구현·검증한다.
7. 실제 diff와 테스트 결과를 `final.md`에 적고 최종 검토를 등록한다.

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/request-agent-review.ps1 -TaskId <task-id> -Phase final -AgendaPath .agent-reviews/<task-id>/agenda.md -MaterialPath .agent-reviews/<task-id>/final.md
   ```

8. Codex의 BLOCKER만 해결하고 최대 두 번까지 재검토한다. 이후 Claude가 커밋·배포·
   라이브 확인을 한다.

보안·Firebase·배포 작업에서는 구현 전에 공격 또는 실패 경로를 코드로 추적하고,
구현 뒤에는 그 경로가 실제로 차단되는지 검증한다.

## 보고

모든 완료 보고는 `AGENTS.md`의 "완료 보고 방식"을 따른다 — 첫 문장에 `완료됨`/
`배포 완료`, 체감 결과 2~4개 bullet 먼저, 그다음 커밋·배포·라이브 확인 한 줄,
필요한 사용자 확인은 최대 2개. CLI 인증·헤드리스 제한·내부 경로·오류 전문은
요청받을 때만 덧붙인다.
