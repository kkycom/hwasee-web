// 실데이터 빌드(build-static-stories.js) 후, 생성된 공개 HTML만 정적 검사해서
// 2편 시범 배포 승인 판단용 요약을 reading-pilot-summary.md로 남긴다.
// Firestore 재조회 없음 — 이미 만들어진 bang/story/{id}/index.html만 읽는다.
// 제출·투표·댓글·포인트 변경 없음(순수 읽기).
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'bang', 'story');
const SUMMARY = path.join(__dirname, '..', 'reading-pilot-summary.md');
const EXPECTED = process.env.READING_PILOT_EXPECTED_OUT
  || path.join(__dirname, '..', 'reading-pilot-expected.json');

// 앱 bang/index.html _sortStories(list, 'latest')와 동일 규칙:
//   arr.sort((a, b) => new Date(b.completed_at || b.created_at) - new Date(a.completed_at || a.created_at))
// JS Array.prototype.sort는 stable(ES2019+) — 동률(같은 시각/폴백값)이면 입력
// 순서 유지. 빌드가 덤프한 completed 배열을 그대로 입력으로 쓰므로 빌드의
// completedByBookshelf와 동률 처리까지 일치한다. completed_at 없으면 created_at 폴백.
function sortLatest(list) {
  return [...list].sort((a, b) =>
    new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt));
}

// V2 대상 id의 원천은 scripts/lib/v2-reader-ids.js 하나뿐. 제목·기대 문장수는
// 사람이 읽는 리포트 라벨이라 여기 맵으로 두되, 없으면 생성된 HTML에서 읽는다.
const { V2_TARGET_IDS } = require('./lib/v2-reader-ids.js');
const V2_LABELS = {
  '078b460e-d9d0-4642-b75d-44571637f787': { title: '이상한 계단', sentences: 2 },
  '0a400be4-cd2a-4e74-ba79-b677251c9487': { title: '우물 속 달', sentences: 11 },
};
const V2 = V2_TARGET_IDS.map(id => {
  const lbl = V2_LABELS[id] || {};
  return [id, lbl.title || null, lbl.sentences || null];
});
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

// ── 빌드가 덤프한 completed 데이터에 앱 정렬 기준 적용 → 기대 이전/다음 ──
let expected = null;
try {
  if (fs.existsSync(EXPECTED)) expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
} catch (e) { /* 아래에서 미검증으로 표시 */ }
const expectedNeighbors = id => {
  if (!expected || !Array.isArray(expected.completed)) return null;
  const sorted = sortLatest(expected.completed);
  const i = sorted.findIndex(x => x.id === id);
  if (i < 0) return { notInPool: true };
  return {
    prev: i > 0 ? sorted[i - 1].id : null,            // 정렬상 앞 = 더 최신
    next: i < sorted.length - 1 ? sorted[i + 1].id : null,
    total: sorted.length,
    sameAsBuildDump: JSON.stringify(sorted.map(x => x.id)) === JSON.stringify(expected.completed.map(x => x.id)),
  };
};

// ── 시범 2편: V2 셸 ──
for (const [id, title, sentences] of V2) {
  L(`\n## ${title || id} (\`${id}\`) — V2 독립 셸\n`);
  const h = read(id);
  if (!h) { chk('파일 생성됨', false, `${id}/index.html 없음`); continue; }
  chk('V2 독립 셸(h1.reader-title)', /<h1 class="reader-title">/.test(h));
  chk('앱 셸(main id="app") 잔존 없음', !h.includes('<main id="app">'));
  const t = (h.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const h1 = (h.match(/<h1 class="reader-title">([^<]*)<\/h1>/) || [])[1] || '';
  if (title) {
    chk('title = 실제 작품명', t === `${title} — 화씨.방`, t);
    chk('H1 = 실제 작품명', h1 === title, h1);
  } else {
    chk('title 형식 " … — 화씨.방"', / — 화씨\.방$/.test(t), t);
    chk('H1 = title 본문과 일치', !!h1 && t.startsWith(h1), `H1=${h1}`);
  }
  const canon = (h.match(/<link rel="canonical" href="([^"]*)">/) || [])[1] || '';
  chk('canonical = 쿼리 없는 원래 주소', canon === `https://hwasee.me/bang/story/${id}/`, canon);
  const sc = (h.match(/class="prose-sentence"/g) || []).length;
  const oc = (h.match(/class="prose-opening"/g) || []).length;
  if (sentences != null) chk('본문 문장 수 일치', sc === sentences, `prose-sentence ${sc}개 + opening ${oc} (기대 ${sentences})`);
  else chk('본문 문장 존재', sc > 0, `prose-sentence ${sc}개 + opening ${oc}`);
  chk('robots index,follow', /<meta name="robots" content="index,follow">/.test(h));
  chk('· 完 · (완결 표시)', /reader-theend/.test(h));

  // 이전/다음 링크 — ID 형식은 제한하지 않고(이 사이트에 UUID 외 Firestore
  // auto-id도 있음), href에서 뽑은 대상이 실제로 이번 빌드에서 생성됐는지
  // (bang/story/{id}/index.html 존재) 확인. null이면 disabled 앵커.
  const nav = (h.match(/<div class="reader-nav">([\s\S]*?)<\/div>/) || [])[1] || '';
  const built = id2 => fs.existsSync(path.join(OUT_DIR, id2, 'index.html'));
  const actual = {};
  for (const label of ['이전', '다음']) {
    const linkM = nav.match(new RegExp(`<a href="/bang/story/([^/"]+)/">[^<]*${label === '이전' ? '←\\s*이전' : '다음'}[^<]*</a>`));
    const disabled = new RegExp(`<a class="disabled">[^<]*${label === '이전' ? '←\\s*이전' : '다음'}`).test(nav);
    actual[label] = linkM ? linkM[1] : (disabled ? null : '__PARSE_FAIL__');
    if (linkM) {
      chk(`${label} 링크 → 이번 빌드에 실제 생성된 작품`, built(linkM[1]), `${linkM[1]}${built(linkM[1]) ? '' : ' (생성물 없음)'}`);
    } else if (disabled) {
      chk(`${label} 링크 → disabled(정렬상 ${label === '이전' ? '첫' : '마지막'} 작품)`, true);
    } else {
      chk(`${label} 링크 파싱`, false, nav.replace(/\s+/g, ' ').slice(0, 120));
    }
  }

  // 앱 책장 '최신순' 기준을 빌드 데이터에 적용한 기대 이전/다음과 자동 대조
  const exp = expectedNeighbors(id);
  if (!exp) {
    chk('이전/다음 = 앱 책장 최신순 기대값과 일치', false,
      '미검증 — reading-pilot-expected.json 없음(빌드 시 READING_PILOT_EXPECTED_OUT 미설정)');
  } else if (exp.notInPool) {
    chk('이전/다음 = 앱 책장 최신순 기대값과 일치', false, `${id}가 완결작 풀에 없음`);
  } else {
    const norm = v => v == null ? '(끝)' : v;
    chk(`이전 링크 = 기대값(${norm(exp.prev)})`, actual['이전'] === exp.prev,
      `실제=${norm(actual['이전'])}`);
    chk(`다음 링크 = 기대값(${norm(exp.next)})`, actual['다음'] === exp.next,
      `실제=${norm(actual['다음'])}`);
    chk('빌드 정렬 == 검사 재정렬(동률 stable 포함)', exp.sameAsBuildDump !== false);
    L(`  - (참고) 완결작 풀 ${exp.total}편, expected 생성 ${expected.generated_at}`);
  }

  const part = (h.match(/href="(\/bang\/story\/[^/"]+\/\?write=1)"/) || [])[1] || '';
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

// ── 분기 작품: 기존 renderStoryPage 계약 유지 확인 ──
// 기존 renderStoryPage의 <title>은 실제 작품명이 아니라 도입문 앞부분(story.opening
// slice 40) + " — 화씨.방" 이다. 그래서 '작품명 포함'을 요구하면 안 되고, 같은
// 빌드의 다른 비시범·비분기 완결작(참조 R)과 동일한 출력 계약인지로 판정한다.
{
  const [id, title] = BRANCH;
  L(`\n## ${title} (\`${id}\`) — 분기, 기존 렌더러 계약 유지 확인\n`);
  const h = read(id);
  if (!h) {
    chk('파일 생성됨', false, `${id}/index.html 없음 — 완결작 풀에 없을 수 있음(확인 필요)`);
  } else {
    // 참조 R: 시범 2편·분기 자신을 뺀 아무 완결작 하나
    const exclude = new Set([...V2.map(v => v[0]), id]);
    let refId = null, refHtml = null;
    for (const d of (fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : [])) {
      if (exclude.has(d)) continue;
      const rh = read(d);
      if (rh && rh.includes('<main id="app">')) { refId = d; refHtml = rh; break; }
    }
    const contract = s => ({
      appShell: s.includes('<main id="app">'),
      noV2Title: !/<h1 class="reader-title">/.test(s),
      noV2Script: !s.includes("get('write')"),
      noV2Nav: !/class="reader-(nav|participate|share)"/.test(s),
      titleSuffix: / — 화씨\.방<\/title>/.test(s),
    });
    const c = contract(h);
    chk('기존 앱 셸(main id="app")', c.appShell);
    chk('V2 제목 셸 없음(h1.reader-title)', c.noV2Title);
    chk('V2 인라인 스크립트 없음(?write= 리다이렉트)', c.noV2Script);
    chk('V2 네비/참여/공유 블록 없음', c.noV2Nav);
    chk('<title> …" — 화씨.방" 형식(도입문 기반, 작품명 강제 아님)', c.titleSuffix,
      (h.match(/<title>([^<]*)<\/title>/) || [])[1]);
    const canon = (h.match(/<link rel="canonical" href="([^"]*)">/) || [])[1] || '';
    chk('canonical = 자기 URL 유지', canon === `https://hwasee.me/bang/story/${id}/`, canon);
    if (refHtml) {
      const rc = contract(refHtml);
      const same = JSON.stringify(c) === JSON.stringify(rc);
      chk(`다른 비시범 완결작(\`${refId}\`)과 동일한 출력 계약`, same,
        same ? '' : `분기=${JSON.stringify(c)} vs 참조=${JSON.stringify(rc)}`);
    } else {
      chk('참조 완결작 확보', false, '비교 대상 완결작을 못 찾음');
    }
  }
}

L('\n---\n');
L(fail === 0
  ? '**정적 검사 전부 통과.** 이전/다음 링크는 이번 빌드가 본 완결작 데이터에 앱 `_sortStories(\'latest\')` 기준을 재적용한 기대값과 자동 대조 완료(육안 비교 불필요).'
  : `**❌ ${fail}건 실패 — 위 항목 확인 필요.**`);
L('');
L('실서버 연결 필요 — 배포 직후 확인 항목(별도 인프라 추가 안 함):');
L('- 참여 링크 → 앱 에디터 화면 실제 렌더');
L('- 기여 문장 진입 시 해당 문장 스크롤·`mine-flash` 강조');
L('- 앱 책장 카드 클릭이 실제로 `nav(\'story\', id)` 경로를 타는지');

fs.writeFileSync(SUMMARY, out.join('\n') + '\n');
console.log(out.join('\n'));
console.log(`\n→ ${SUMMARY}`);
if (fail > 0) process.exit(1);
