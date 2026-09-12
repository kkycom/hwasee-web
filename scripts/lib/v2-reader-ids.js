// V2 독립 독서 페이지(renderStoryPageV2) 적용 대상 — 유일한 원천(single source).
//
// build-static-stories.js가 이 목록을 읽어 빌드에 쓰고, **이번 빌드에서 실제
// V2 페이지 생성·검증에 성공한 ID만** bang/index.html의 _V2_READER_IDS 마커에
// 주입한다. 앱에는 수동 목록이 없다(주입 전 커밋본의 값은 사람이 읽을 기본값일 뿐).
//
// 이 배열을 비우면: renderStoryPageV2가 전혀 안 쓰이고(전량 기존 renderStoryPage),
// 앱에 주입되는 목록도 빈 Set이라 nav() 가드가 기존 동작으로 복귀한다.
//
// 운영 적용 대상 확대는 별도 승인 사항. 지금은 승인된 일반 완결작 2편만.
module.exports = {
  V2_TARGET_IDS: [
    '078b460e-d9d0-4642-b75d-44571637f787', // 짧은: "이상한 계단" (2문장)
    '0a400be4-cd2a-4e74-ba79-b677251c9487', // 긴: "우물 속 달" (11문장)
  ],

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
