// V2 독립 독서 페이지(renderStoryPageV2) 적용 대상 — 유일한 원천(single source).
//
// 2026-09-13(4번 확대)부터 정적 화이트리스트 배열을 폐지하고 "완결작 기본 포함 +
// 명시적 제외" 규칙으로 바꿨다. build-static-stories.js가 완결작 1차 패스(processed)를
// 계산한 뒤 computeV2TargetIds(processed)를 호출해 이번 빌드의 V2 목표 집합을 구하고,
// 그 결과를 .story-build-manifest.json의 v2_ids에 기록한 뒤 **실제 생성·검증에 성공한
// ID만** bang/index.html의 _V2_READER_IDS 마커에 주입한다. 앱에는 수동 목록이 없다
// (주입 전 커밋본의 값은 사람이 읽을 기본값일 뿐).
//
// verify-static-stories.js는 Firestore 접근이 없는 순수 파일 검사라 completedStories를
// 다시 계산할 수 없다 — 그래서 "이번 빌드가 실제로 무엇을 목표로 삼았는가"를 담은
// 매니페스트의 v2_ids를 설정 원천으로 대조한다. V2_EXCLUDED_IDS는 정적이라 verify가
// "제외 대상인데 생성됐는지"를 직접 재확인할 수 있다.
//
// 운영 적용 대상 확대(이 규칙 자체를 넓히거나 좁히는 것)는 별도 승인 사항.
//
// 2026-09-13: H(24b38dfc, 버그 제보성 완결작)를 여기 넣어 임시 제외했었으나, 사용자가
// "재치 있는 메타 이야기로 판단 — 공개·검색 노출·sitemap 유지, noindex·삭제 안 함"
// 최종 결론을 내려 콘텐츠 판단상 제외 사유가 사라졌다. 기술적으로도 분기·연장 관계가
// 없는 순수 완결작이라 다른 일반 완결작과 동일하게 V2 렌더링 가능함을 확인 후 이
// 목록에서 뺐다(08-ads-and-content-policy.md 갱신 참고).
const V2_EXCLUDED_IDS = new Set([]);

// 완결작(status:'completed')이 기본 대상. 초스피드(mode:'speedrun')는 렌더 방식이
// 근본적으로 달라(step순+삭제문장 표시+포인트 태그, getEpisodeTree 재현 불가) 자동
// 제외 — 완결 0편이라 지금 당장 영향은 없음(bang/build-static-stories.js 4-B 조사
// 참고). 분기(branch_*)·연장(is_continuation) 관계는 여기서 걸러내지 않는다 —
// computeBranchInheritance가 개별 실패(ok:false)시 build-static-stories.js가
// 자동으로 기존 렌더러 폴백(v2Fallback)으로 돌리므로 이중 게이트가 불필요하다.
function computeV2TargetIds(processedStories) {
  return processedStories
    .filter(p => p.isCompleted && p.mode !== 'speedrun' && !V2_EXCLUDED_IDS.has(p.id))
    .map(p => p.id);
}

module.exports = {
  V2_EXCLUDED_IDS,
  computeV2TargetIds,

  // bang/index.html 인라인 스크립트에서 이 정규식에 매치되는 선언 하나를
  // 통째로 치환한다. 매치가 0개거나 2개 이상이면 빌드 실패로 처리한다.
  V2_READER_IDS_DECL_RE: /const _V2_READER_IDS = new Set\(\[[^\]]*\]\);/g,

  // 주입할 선언을 만든다. bang/index.html의 최상위 인라인 스크립트에 있어서
  // ID는 2칸 들여쓰기, 닫는 줄은 0칸(커밋본과 동일 형식).
  buildV2ReaderIdsDecl(ids) {
    if (!ids.length) return 'const _V2_READER_IDS = new Set([]);';
    const body = ids.map(id => `  '${id}',`).join('\n');
    return `const _V2_READER_IDS = new Set([\n${body}\n]);`;
  },
};
