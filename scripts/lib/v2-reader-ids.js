// V2 독립 독서 페이지(renderStoryPageV2) 적용 대상 — 유일한 원천(single source).
//
// build-static-stories.js가 이 목록을 읽어 빌드에 쓰고, **이번 빌드에서 실제
// V2 페이지 생성·검증에 성공한 ID만** bang/index.html의 _V2_READER_IDS 마커에
// 주입한다. 앱에는 수동 목록이 없다(주입 전 커밋본의 값은 사람이 읽을 기본값일 뿐).
//
// 이 배열을 비우면: renderStoryPageV2가 전혀 안 쓰이고(전량 기존 renderStoryPage),
// 앱에 주입되는 목록도 빈 Set이라 nav() 가드가 기존 동작으로 복귀한다.
//
// 운영 적용 대상 확대는 별도 승인 사항.
// 2026-09-12: 분기 작품 1편(0fbdc14a) 제한적 확대 승인 — computeBranchInheritance가
// 0순위(서버 계산값)로 완전히 재현 가능함을 라이브 hydrate와 대조해 확인한 대상.
// build-static-stories.js가 부모 조회·조립에 실패하면(ok:false) 이 목록에 있어도
// 조용히 기존 renderStoryPage로 폴백한다(설정 대상 미생성 fail이 아님 — 의도된 동작).
module.exports = {
  V2_TARGET_IDS: [
    '078b460e-d9d0-4642-b75d-44571637f787', // 짧은: "이상한 계단" (2문장)
    '0a400be4-cd2a-4e74-ba79-b677251c9487', // 긴: "우물 속 달" (11문장)
    '0fbdc14a-786d-4831-b4f6-4b3c5da52909', // 분기: "거짓말의 꽃" (부모 f3279a4e에서 분기)
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
