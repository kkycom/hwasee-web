// 한국판 bang/index.html의 CSS 블록을 **원본 텍스트 그대로** 잘라내는 추출기.
//
// 왜 이렇게 하나: English 에디션 화면은 한국판과 같은 디자인이어야 한다. 값을 손으로
// 옮겨 적으면 어딘가 한 글자가 달라져도 아무도 모른다(실제로 "Step 배지 점 색이
// 달라 보인다"는 의심이 나왔다). 그래서 재타이핑을 없애고, 이 추출기가 한국판
// 소스에서 규칙을 그대로 떼어내 영어판 CSS 파일을 만든다.
//
// 같은 추출기를 검증에도 쓴다(scripts/verify-en-css-sync.js) — 지금 한국판에서
// 추출한 결과와 커밋된 영어판 CSS가 한 글자라도 다르면 빌드를 실패시킨다.
// 한국판 디자인이 바뀌면 그 사실이 즉시 드러난다.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const KO_HTML = path.join(ROOT, 'bang', 'index.html');

// 영어판 화면에 실제로 쓰이는 공통 컴포넌트. 순서가 곧 출력 순서다.
// 셀렉터는 한국판 소스에 나타나는 형태 그대로 적는다.
const RULES = [
  '@font-face',
  ':root',
  '*',
  'body',
  'header',
  '.logo',
  '.nav-right',
  'main',
  '.tabs',
  '.tab',
  '.tab:last-child',
  '.tab.active',
  '.btn',
  '.btn-primary',
  '.btn-sm',
  '.btn-ghost',
  '.card',
  '.story-card',
  '.story-card:hover',
  '.story-card-title',
  '.story-card-footer',
  '.step-pill',
  '.step-dot',
  '.story-status',
  '.spotlight-card-shell',
  // 장르 강제 전환 배너(페넌트 리본) — 영어판 Today 카드의 "지금 장르" 배너가
  // 한국판과 같은 모양이어야 한다. 색 자체는 :root의 --g-* 토큰으로 이미 공유
  // 중이고, 여기서 가져오는 건 리본 모양과 글자 스타일이다.
  // `.genre-headline .n`은 확률 패널(genrePanelHtml) 전용이라 가져오지 않는다 —
  // 영어판엔 장르 확률 기능이 없다(장르가 생성 시점에 확정된 배열이라 확률이 없음).
  '.genre-panel',
  '.genre-row',
  '.genre-headline',
  '.genre-pill-primary',
  '.story-prose',
  '.prose-opening',
  '.prose-line',
  '.prose-sentence',
  '.prose-author',
  '.prose-author.visible',
  '.prose-divider',
  '.prose-divider::before, .prose-divider::after',
  '.form-group',
  'label',
  'input, textarea',
  'input:focus, textarea:focus',
  'textarea',
  '.char-count',
  '.char-count.warn',
  '.char-count.over',
  '.empty',
  '.toast',
  '.toast.show',
  '.toast.err',
  'h2',
  'hr',
  // PC 세로 랭킹 위젯 — 영어판 포인트·업적 순위표가 한국판과 같은 디자인이어야 한다.
  // ⚠️ `.pc-side-rank` 자체는 여기 넣지 않는다. 그 셀렉터는 한국판에 두 번
  // 나오는데(기본 display:none + @media(min-width:1280px)의 display:block),
  // cutRule은 감싼 미디어쿼리를 보존하지 않으므로 둘을 그냥 이어붙이면
  // display:block이 조건 없이 이겨 **모바일에도 위젯이 뜬다**. 두 규칙은
  // 아래 SNIPPETS에서 각자의 조건과 함께 가져온다.
  '.pc-side-rank-card',
  '.pc-side-rank-head',
  '.pc-side-rank-title',
  '.pc-side-rank-arrow',
  '.pc-side-rank-arrow:hover',
  '.pc-side-rank-dots',
  '.pc-side-rank-dot',
  '.pc-side-rank-dot.active',
  '.lb-row',
  '.lb-row:last-child',
  '.lb-rank',
  '.lb-rank.r1',
  '.lb-rank.r2',
  '.lb-rank.r3',
  '.lb-name',
  '.lb-value',
];

// 규칙 텍스트를 그대로 찾아 옮기는 것들.
// query가 있으면 그 미디어쿼리로 감싸고, null이면 최상위 규칙 그대로 둔다.
// (예전에는 배열이 문자열이고 출력 시 max-width:480px로 하드코딩돼 있었는데,
//  1280px 규칙이 생기면서 조건을 항목별로 들고 있어야 했다.)
const MEDIA_SNIPPETS = [
  { query: '(max-width: 480px)', snippet: '.tab { padding: 8px 4px; font-size: 11px; }' },
  { query: '(max-width: 480px)', snippet: '.nav-right { gap: 4px; }' },
  // 위젯의 기본값(숨김)과 데스크톱 노출 조건을 반드시 **쌍으로** 가져온다.
  // 한국판의 기존 제약을 그대로 유지하는 것이지 새로 만드는 제약이 아니다.
  { query: null, snippet: '.pc-side-rank { display: none; }' },
  {
    query: '(min-width: 1280px)',
    snippet: '.pc-side-rank { display: block; position: fixed; top: 132px; left: calc(50% - 384px - 200px); width: 200px; z-index: 5; }',
  },
  // PC 세로 광고 자리 — 영어판도 랭킹 위젯과 대칭으로 오른쪽에 카카오 애드핏을
  // 붙인다(2026-09-02, 유저 요청). 랭킹 위젯과 같은 쌍(기본 숨김 + 데스크톱
  // 노출 조건)으로 가져온다.
  { query: null, snippet: '.pc-side-ad { display: none; }' },
  {
    query: '(min-width: 1280px)',
    snippet: '.pc-side-ad { display: block; position: fixed; top: 132px; left: calc(50% + 384px); width: 160px; z-index: 5; }',
  },
];

function styleBlock(html) {
  // <style> ... </style> 전부를 이어붙인다(한국판은 여러 개일 수 있다).
  const out = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  if (!out.length) throw new Error('bang/index.html에서 <style> 블록을 찾지 못했습니다.');
  return out.join('\n');
}

// 셀렉터로 시작하는 규칙을 원본 그대로(주석 포함 앞줄까지) 잘라낸다.
function cutRule(css, selector) {
  const results = [];
  // 줄 시작에서 셀렉터가 정확히 오고 그 뒤가 { 또는 , 인 위치만 찾는다.
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^[ \\t]*' + esc + '[ \\t]*\\{', 'gm');
  let m;
  while ((m = re.exec(css))) {
    const start = m.index;
    let i = css.indexOf('{', start);
    let depth = 0;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    // 규칙 바로 앞에 붙은 주석 줄들도 함께 가져온다(설명이 곧 근거라서).
    let head = start;
    const before = css.slice(0, start);
    const lines = before.split('\n');
    let take = 0;
    for (let k = lines.length - 1; k >= 0; k--) {
      const t = lines[k].trim();
      if (t.startsWith('/*') || t.startsWith('*') || t.endsWith('*/') || t.startsWith('//')) take++;
      else break;
    }
    if (take) head = before.length - lines.slice(lines.length - take).join('\n').length - 1;
    results.push(css.slice(Math.max(head, 0), i).replace(/^\n+/, ''));
  }
  return results;
}

function extract() {
  const css = styleBlock(fs.readFileSync(KO_HTML, 'utf8')).replace(/\r\n/g, '\n');
  const parts = [];
  const missing = [];

  for (const sel of RULES) {
    const found = cutRule(css, sel);
    if (!found.length) { missing.push(sel); continue; }
    parts.push(found.join('\n'));
  }
  for (const item of MEDIA_SNIPPETS) {
    const idx = css.indexOf(item.snippet);
    if (idx === -1) { missing.push('(snippet) ' + item.snippet); continue; }
    parts.push(item.query
      ? '@media ' + item.query + ' {\n  ' + item.snippet + '\n}'
      : item.snippet);
  }

  return { css: parts.join('\n\n') + '\n', missing };
}

module.exports = { extract, RULES, MEDIA_SNIPPETS, KO_HTML };
