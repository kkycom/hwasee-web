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
];

// 미디어쿼리 안에 있어서 위 방식으로는 안 잡히는 것들 — 규칙 텍스트를 그대로 찾는다.
const MEDIA_SNIPPETS = [
  '.tab { padding: 8px 4px; font-size: 11px; }',
  '.nav-right { gap: 4px; }',
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
  for (const snip of MEDIA_SNIPPETS) {
    const idx = css.indexOf(snip);
    if (idx === -1) { missing.push('(media) ' + snip); continue; }
    parts.push('@media (max-width: 480px) {\n  ' + snip + '\n}');
  }

  return { css: parts.join('\n\n') + '\n', missing };
}

module.exports = { extract, RULES, MEDIA_SNIPPETS, KO_HTML };
