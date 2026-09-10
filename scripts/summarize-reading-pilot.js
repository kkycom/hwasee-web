// 실데이터 빌드(build-static-stories.js) 후, 생성된 공개 HTML만 정적 검사해서
// 2편 시범 배포 승인 판단용 요약을 reading-pilot-summary.md로 남긴다.
// Firestore 재조회 없음 — 이미 만들어진 bang/story/{id}/index.html만 읽는다.
// 제출·투표·댓글·포인트 변경 없음(순수 읽기).
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'bang', 'story');
const SUMMARY = path.join(__dirname, '..', 'reading-pilot-summary.md');

const V2 = [
  ['078b460e-d9d0-4642-b75d-44571637f787', '이상한 계단', 2],
  ['0a400be4-cd2a-4e74-ba79-b677251c9487', '우물 속 달', 11],
];
const BRANCH = ['0fbdc14a-786d-4831-b4f6-4b3c5da52909', '거짓말의 꽃'];

const out = [];
let fail = 0;
const L = s => out.push(s);
const chk = (name, cond, extra) => { L(`- ${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`); if (!cond) fail++; };
const read = id => {
  const p = path.join(OUT_DIR, id, 'index.html');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

L('# 독립 독서 페이지 시범 — 실데이터 빌드 결과 요약');
L('');
L(`빌드 검사 시각: ${new Date().toISOString()}`);

// ── 시범 2편: V2 셸 ──
for (const [id, title, sentences] of V2) {
  L(`\n## ${title} (\`${id}\`) — V2 독립 셸\n`);
  const h = read(id);
  if (!h) { chk('파일 생성됨', false, `${id}/index.html 없음`); continue; }
  chk('V2 독립 셸(h1.reader-title)', /<h1 class="reader-title">/.test(h));
  chk('앱 셸(main id="app") 잔존 없음', !h.includes('<main id="app">'));
  const t = (h.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  chk('title = 실제 작품명', t === `${title} — 화씨.방`, t);
  const h1 = (h.match(/<h1 class="reader-title">([^<]*)<\/h1>/) || [])[1] || '';
  chk('H1 = 실제 작품명', h1 === title, h1);
  const canon = (h.match(/<link rel="canonical" href="([^"]*)">/) || [])[1] || '';
  chk('canonical = 쿼리 없는 원래 주소', canon === `https://hwasee.me/bang/story/${id}/`, canon);
  const sc = (h.match(/class="prose-sentence"/g) || []).length;
  const oc = (h.match(/class="prose-opening"/g) || []).length;
  chk('본문 문장 수 일치', sc === sentences, `prose-sentence ${sc}개 + opening ${oc} (기대 ${sentences})`);
  chk('robots index,follow', /<meta name="robots" content="index,follow">/.test(h));
  chk('· 完 · (완결 표시)', /reader-theend/.test(h));

  const nav = (h.match(/<div class="reader-nav">([\s\S]*?)<\/div>/) || [])[1] || '';
  const prevM = nav.match(/<a href="\/bang\/story\/([0-9a-f-]{36})\/">← 이전 완결작<\/a>/);
  const nextM = nav.match(/<a href="\/bang\/story\/([0-9a-f-]{36})\/">다음 완결작 →<\/a>/);
  const prevDisabled = /<a class="disabled">← 이전/.test(nav);
  const nextDisabled = /<a class="disabled">다음/.test(nav);
  chk('이전 링크: 실제 story href 또는 disabled', !!prevM || prevDisabled,
    prevM ? prevM[1] : (prevDisabled ? '(첫 작품 — disabled)' : nav.slice(0, 80)));
  chk('다음 링크: 실제 story href 또는 disabled', !!nextM || nextDisabled,
    nextM ? nextM[1] : (nextDisabled ? '(마지막 작품 — disabled)' : nav.slice(0, 80)));

  const part = (h.match(/href="(\/bang\/story\/[0-9a-f-]{36}\/\?write=1)"/) || [])[1] || '';
  chk('참여 링크 = /bang/story/{id}/?write=1', part === `/bang/story/${id}/?write=1`, part);
  const scripts = (h.match(/<script/g) || []).length;
  chk('script 2개(JSON-LD + 인라인)', scripts === 2, `${scripts}개`);

  // 본문 미리보기
  const prose = (h.match(/<div class="story-prose">([\s\S]*?)<\/div>\s*<p class="reader-theend"/)
    || h.match(/<div class="story-prose">([\s\S]*?)<div class="reader-nav"/) || [])[1] || '';
  L('');
  L('<details><summary>본문 미리보기</summary>');
  L('');
  L('```');
  L(prose.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800));
  L('```');
  L('</details>');
}

// ── 분기 작품: 기존 renderStoryPage 유지 ──
{
  const [id, title] = BRANCH;
  L(`\n## ${title} (\`${id}\`) — 분기, 기존 렌더러 유지 확인\n`);
  const h = read(id);
  if (!h) {
    chk('파일 생성됨', false, `${id}/index.html 없음 — 완결작 풀에 없을 수 있음(확인 필요)`);
  } else {
    chk('기존 앱 셸 방식(main id="app")', h.includes('<main id="app">'));
    chk('V2 셸 아님(h1.reader-title 없음)', !/<h1 class="reader-title">/.test(h));
    chk('V2 인라인 스크립트 없음(?write= 리다이렉트 없음)', !h.includes("get('write')"));
    const t = (h.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    chk('title에 작품명 포함', t.includes(title), t);
    const canon = (h.match(/<link rel="canonical" href="([^"]*)">/) || [])[1] || '';
    chk('canonical 유지', canon === `https://hwasee.me/bang/story/${id}/`, canon);
  }
}

L('\n---\n');
L(fail === 0
  ? '**정적 검사 전부 통과.** 아티팩트의 index.html로 이전/다음 대상 작품명을 앱 책장 "최신순"과 육안 대조하세요.'
  : `**❌ ${fail}건 실패 — 위 항목 확인 필요.**`);
L('');
L('로컬에서 확인 불가(실서버 연결 필요, 별도 인프라 추가 안 함):');
L('- 참여 링크 → 앱 에디터 화면 실제 렌더');
L('- 기여 문장 진입 시 해당 문장 스크롤·`mine-flash` 강조');
L('- 앱 책장 카드 클릭이 실제로 `nav(\'story\', id)` 경로를 타는지');

fs.writeFileSync(SUMMARY, out.join('\n') + '\n');
console.log(out.join('\n'));
console.log(`\n→ ${SUMMARY}`);
if (fail > 0) process.exit(1);
