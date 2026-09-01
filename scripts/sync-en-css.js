// 한국판 bang/index.html에서 공통 컴포넌트 CSS를 잘라내 bang/en/ko-shared.css로 쓴다.
//
// 실행: node scripts/sync-en-css.js
// 검증: node scripts/verify-en-css-sync.js  (재추출해서 파일과 diff — 다르면 실패)
//
// 값을 손으로 옮겨 적지 않는다. 한국판 소스가 유일한 원본이고, 이 파일은 그 사본이다.

const fs = require('fs');
const path = require('path');
const { extract, RULES, MEDIA_SNIPPETS } = require('./lib/extract-ko-css.js');

const OUT = path.join(__dirname, '..', 'bang', 'en', 'ko-shared.css');

const HEADER = `/* ═══════════════════════════════════════════════════════════════════════
   이 파일은 손으로 쓴 것이 아니라 **한국판 bang/index.html에서 잘라낸 사본**이다.
   생성: node scripts/sync-en-css.js
   검증: node scripts/verify-en-css-sync.js  (한 글자라도 다르면 실패)

   English 에디션은 한국판과 같은 디자인이어야 한다. 값을 다시 타이핑하면
   어딘가 미묘하게 달라져도 아무도 모르기 때문에, 규칙을 원본 텍스트 그대로
   옮기고 스크립트로 대조한다. 한국판 디자인이 바뀌면 검증이 실패해서 알려준다.

   ⚠️ 이 파일을 직접 수정하지 마세요. 한국판을 고친 뒤 sync 스크립트를 다시 도세요.
   ═══════════════════════════════════════════════════════════════════════ */

`;

const { css, missing } = extract();
if (missing.length) {
  console.error('한국판에서 찾지 못한 규칙이 있습니다 — 셀렉터가 바뀌었을 수 있습니다:');
  missing.forEach(m => console.error('  - ' + m));
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, HEADER + css);
console.log(`bang/en/ko-shared.css 생성 — 규칙 ${RULES.length}개 + 미디어쿼리 ${MEDIA_SNIPPETS.length}개, ${css.length}바이트`);
