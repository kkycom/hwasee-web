// 자동 작업(스케줄·트리거) 공용 판정 게이트.
//
// 왜 필요한가: 지금 자동 작업들은 "완결된 이야기 전부", "진행 중 이야기 전부"처럼
// 컬렉션을 통째로 훑는다. 영어 에디션이 생기면 그 작업들이 영어 이야기까지 한국
// 운영 대상으로 취급한다. 특히 완결작 문장 다듬기는 Claude API로 본문을 실제로
// 고쳐 쓰므로, 영어 이야기가 한국어 교정 프롬프트로 수정되고 비용까지 발생한다.
//
// 별도 컬렉션으로 나눈 뒤에는 대부분의 유입이 구조적으로 막히지만, 이 게이트는
// 그 위에 한 겹을 더 둔다 — 작업이 "어떤 에디션을 대상으로 하는지"를 코드에
// 명시하게 만들어서, 새 자동 작업을 추가할 때 그 결정을 빠뜨릴 수 없게 한다.
//
// ⚠️ 비용 장부·쿼터의 전면 통합은 이번 범위가 아니다(사용자 확정). 여기서는 각
// 작업이 이 게이트를 "거치는 구조"만 만든다. 실제 쿼터·킬스위치를 쓰는 것은
// 번역(en-quota.js)뿐이다.

// 각 자동 작업이 어떤 에디션을 대상으로 하는지 한곳에 선언한다.
// 새 자동 작업을 추가하면서 여기 등록하지 않으면 isTaskAllowed가 던지므로,
// "대상 에디션을 정하지 않은 채 배포되는" 일이 생기지 않는다.
const AUTO_TASKS = {
  // 완결작 문장 다듬기 — 한국어 교정 프롬프트를 쓰고 본문을 덮어쓴다. ko 전용.
  ai_review_completed: { editions: ['ko'], mutatesContent: true, costsApi: true },
  // AI 자동참여(문장 생성·투표) — 영어판 AI 참여는 이번 범위가 아니다.
  ai_participate: { editions: ['ko'], mutatesContent: false, costsApi: true },
  // 제목 생성 — 양쪽 다 하되 프롬프트 언어가 다르다.
  generate_title: { editions: ['ko', 'en'], mutatesContent: false, costsApi: true },
  // 장르 분류 — 양쪽 다 하되 라벨 체계가 다르다.
  classify_genre: { editions: ['ko', 'en'], mutatesContent: false, costsApi: true },
  // 방치된 씨앗 정리 — 각자 자기 슬롯만.
  cleanup_abandoned_seeds: { editions: ['ko', 'en'], mutatesContent: false, costsApi: false },
  // Today 슬롯 리필 — 각자 자기 포인터·씨앗만.
  refill_spotlight_slot: { editions: ['ko', 'en'], mutatesContent: false, costsApi: false },
  // 영어 번역 생성 — 한국 완결작을 원본으로 삼는다(번역 대상이 ko라는 뜻).
  translate_to_en: { editions: ['ko'], mutatesContent: false, costsApi: true },
};

function taskSpec(taskName) {
  const spec = AUTO_TASKS[taskName];
  if (!spec) {
    throw new Error(
      `등록되지 않은 자동 작업: ${taskName}. functions/lib/auto-task-gate.js의 AUTO_TASKS에 ` +
      `대상 에디션을 먼저 선언하세요(대상을 정하지 않은 자동 작업은 실행할 수 없습니다).`
    );
  }
  return spec;
}

// 이 자동 작업이 그 에디션을 대상으로 하는가.
function isEditionAllowed(taskName, edition) {
  return taskSpec(taskName).editions.includes(edition);
}

// 개별 이야기 하나가 이 자동 작업의 대상인지 판정한다.
// story는 Firestore 문서 데이터, edition은 그 story가 속한 에디션(컬렉션으로 결정됨).
function shouldProcessStory(taskName, edition, story, opts) {
  const o = opts || {};
  if (!isEditionAllowed(taskName, edition)) {
    return { ok: false, reason: 'edition_not_targeted' };
  }
  if (!story) return { ok: false, reason: 'no_story' };

  // 관리자가 특정 이야기를 자동 처리에서 빼둘 수 있는 탈출구.
  // 자동 작업이 본문을 고치는 종류라면 이 플래그를 반드시 존중해야 한다.
  if (story.auto_tasks_disabled === true) {
    return { ok: false, reason: 'disabled_on_story' };
  }

  if (o.requireStatus && story.status !== o.requireStatus) {
    return { ok: false, reason: `status_is_${story.status}` };
  }
  if (o.excludeModes && o.excludeModes.includes(story.mode)) {
    return { ok: false, reason: `mode_${story.mode}_excluded` };
  }
  return { ok: true };
}

module.exports = { AUTO_TASKS, taskSpec, isEditionAllowed, shouldProcessStory };
