// bang/en/ko-shared.css가 지금의 한국판 bang/index.html에서 잘라낸 것과
// **한 글자라도** 다르면 실패한다.
//
// "같아 보인다"가 아니라 "diff 0줄"로 증명하기 위한 스크립트다. 한국판 디자인이
// 바뀌었는데 영어판에 반영하지 않으면 여기서 걸린다.
//
// 실행: node scripts/verify-en-css-sync.js

const fs = require('fs');
const path = require('path');
const { extract, RULES, MEDIA_SNIPPETS } = require('./lib/extract-ko-css.js');

const SHARED = path.join(__dirname, '..', 'bang', 'en', 'ko-shared.css');

function fail(msg) { console.error('❌ FAIL:', msg); process.exitCode = 1; }

if (!fs.existsSync(SHARED)) {
  fail('bang/en/ko-shared.css가 없습니다. node scripts/sync-en-css.js를 먼저 실행하세요.');
  process.exit(1);
}

const { css: fresh, missing } = extract();
if (missing.length) {
  missing.forEach(m => fail(`한국판에서 규칙을 찾지 못함(셀렉터가 바뀌었을 수 있음): ${m}`));
  process.exit(1);
}

const onDisk = fs.readFileSync(SHARED, 'utf8').replace(/\r\n/g, '\n');
// 파일 상단 안내 주석은 생성물 메타라 비교에서 제외한다(규칙 본문만 대조).
const body = onDisk.slice(onDisk.indexOf('*/') + 2).replace(/^\n+/, '');

const a = body.split('\n');
const b = fresh.replace(/\r\n/g, '\n').split('\n');

let diffs = 0;
const max = Math.max(a.length, b.length);
for (let i = 0; i < max; i++) {
  if (a[i] !== b[i]) {
    if (diffs < 12) {
      console.error(`  line ${i + 1}`);
      console.error(`    ko-shared.css : ${JSON.stringify(a[i])}`);
      console.error(`    한국판 추출본  : ${JSON.stringify(b[i])}`);
    }
    diffs++;
  }
}

// 실제로 대조한 규칙 목록을 출력해 무엇을 검증했는지 남긴다.
console.log('대조한 규칙 ' + (RULES.length + MEDIA_SNIPPETS.length) + '개:');
console.log('  ' + RULES.join(', '));
console.log('  (스니펫) ' + MEDIA_SNIPPETS
  .map(s => (s.query ? '@media ' + s.query + ' ' : '') + s.snippet).join(' / '));
console.log('한국판 추출본 ' + b.length + '줄 vs ko-shared.css ' + a.length + '줄');

if (diffs) {
  fail(`한국판과 영어판 공통 CSS가 ${diffs}줄 다릅니다 — node scripts/sync-en-css.js로 다시 맞추세요.`);
  process.exit(1);
}
console.log('✅ diff 0줄 — 영어판 공통 CSS가 한국판 원본과 한 글자도 다르지 않습니다.');
