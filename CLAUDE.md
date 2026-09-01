# 화씨.방 Claude Code 안내

프로젝트 공통 규칙은 `AGENTS.md`를 먼저 읽고 따른다. 당신은 이 프로젝트의 리드
개발자이자 유일한 구현 담당이며, 코드 수정부터 배포·라이브 반영 확인까지 끝까지 맡는다.

작업 시작 시 이 worktree의 목적과 요청 범위를 한 문장으로 확인하고, `AGENTS.md`의
두 메모 인덱스와 관련 메모만 읽는다. 이어서 `AGENTS.md`의 작업 등급 세 가지 중
하나를 고른다.

## 1·2등급 (빠른 / 보통 작업)

- **1등급**: 바로 구현 → 자체 확인 → 커밋·배포 → 라이브 반영 확인 → 보고.
  Codex·worktree·Hook 없이 진행한다.
- **2등급**: 구현·테스트 → 자체 회귀 확인 → 배포·라이브 확인 → 보고가 기본이다.
  여러 기존 기능의 경계가 실제로 겹치거나 사용자가 독립 검토를 요청한 경우에만 Codex
  `final`을 한 번 받는다. discovery·plan은 사용하지 않는다.
- 두 등급 모두 `bang/index.html`을 바꾸면 `bang/sw.js`의 `CACHE` 버전을 갱신하고
  바뀐 화면의 기본 회귀를 확인한다.

## 3등급 (중요한 작업) — 최소 엄격 절차

대상은 `AGENTS.md`의 "3등급" 목록(보안·인증·세션·Firestore rules, Cloud Functions·
포인트·결제·외부 API 비용, 데이터 모델·마이그레이션, SSG·canonical·robots·sitemap·
OG·정적 빌드·배포 구조, 개인정보·약관, 글로벌 릴레이·번역 등 비용+UGC 결합 기능,
원인 불명 운영 회귀 버그).

이 경우에도 기본값은 **설계 검토 1회**다. 인증·rules·포인트·결제·외부 API 비용·
데이터 마이그레이션·새 서버 쓰기 경로를 실제 변경할 때만 최종 검토를 한 번 더 받는다.
같은 대상을 discovery, plan, final로 세 번 반복 감사하지 않는다. 수정 전에 다음을 수행한다.

1. 최신 main 기반 worktree에서, 원래 사용자 아젠다와 `기존 확정 맥락`(공유 메모에서
   확인한 사실만, 자신의 결론·계획 제외)을 `.agent-reviews/<task-id>/agenda.md`에 적는다.
2. 기존 코드·운영 구조를 조사하고 최소 변경 계획을 만든다. 제품 방향이 미확정이면
   구현 대신 사용자 결정을 먼저 요청한다.
3. Codex에게 설계 검토를 **한 번만** 요청한다. `discovery`와 `plan` 중 하나만 선택하고
   둘 다 실행하지 않는다. 원인이 명확한 단일 수정이면 이 단계를 생략한다.

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/start-agent-review.ps1 -TaskId <task-id> -AgendaPath .agent-reviews/<task-id>/agenda.md
   ```

4. 검토 결과의 BLOCKER만 반영해 계획을 확정한다. WARNING/OPTIONAL 때문에 범위를 넓히거나
   전체 저장소를 다시 조사하지 않는다. **설계 검토 뒤 plan 검토를 추가 등록하지 않는다.**

5. 합의된 계획만 구현·검증한다. 구현 중 제품 방향이 바뀌면 코드를 더 쓰지 말고 작업을
   멈춰 새 계획을 짧게 확정한다.
6. 실제로 인증·rules·포인트·결제·외부 API 비용·데이터 마이그레이션·새 서버 쓰기 경로를
   바꾼 경우에만, 실제 diff와 테스트 결과를 `final.md`에 적고 최종 검토를 한 번 등록한다.
   그 외에는 Claude 자체 테스트·라이브 확인으로 마무리한다. 최종 검토 범위는 실제 diff와
   선언된 신뢰 경계로 한정한다.

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/request-agent-review.ps1 -TaskId <task-id> -Phase final -AgendaPath .agent-reviews/<task-id>/agenda.md -MaterialPath .agent-reviews/<task-id>/final.md
   ```

7. Codex의 BLOCKER만 해결한다. 그 경우에만 바뀐 부분 재검토를 한 번 받는다.
   WARNING·OPTIONAL은 재검토 사유가 아니다. 이후 Claude가 커밋·배포·라이브 확인을 한다.

보안·Firebase·배포 작업에서는 구현 전에 공격 또는 실패 경로를 코드로 추적하고,
구현 뒤에는 그 경로가 실제로 차단되는지 검증한다.

## 보고

모든 완료 보고는 `AGENTS.md`의 "완료 보고 방식"을 따른다 — 첫 문장에 `완료됨`/
`배포 완료`, 체감 결과 2~4개 bullet 먼저, 그다음 커밋·배포·라이브 확인 한 줄,
필요한 사용자 확인은 최대 2개. CLI 인증·헤드리스 제한·내부 경로·오류 전문은
요청받을 때만 덧붙인다.
