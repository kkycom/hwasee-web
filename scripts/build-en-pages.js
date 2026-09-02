// A-2 (2026-09-02) — 정적 페이지에도 카카오 애드핏 추가. 처음엔 "광고 스크립트
// 없음"이 의도였으나(아래 주석 참고), 실제 목적이 외국인 트래픽 eCPM 수익화라는
// 게 확인돼 방향이 바뀜 — 크롤러/비-JS 방문자가 보는 이 정적 페이지에 광고가
// 하나도 없으면 그 트래픽 전체가 수익화 기회를 놓친다. bang/en/en-app.js(라이브
// 앱)가 이미 쓰는 것과 동일한 유닛(DAN-tFQi1kE1l4fdDOhZ, 320x100)을 재사용 —
// 새 유닛 승인 대기 불필요. 이 페이지들은 SPA처럼 반복 재렌더되지 않는 진짜
// 정적 HTML이라, en-app.js의 "채워졌는지 감시 후 안 채워지면 자리 제거" 로직은
// 필요 없음 — 한국어 SSG 완결작 정적 페이지의 푸터 광고와 동일하게 raw
// <ins>+<script>를 그대로 심어서 일반 파싱 시 자동 실행되게 함.
//
// A-1 — 영어 읽기 전용 정적 발행(/bang/en/).
//
// 기존 scripts/build-static-stories.js(한국어 SSG)와 **별도 스크립트**다.
// bang/index.html(인터랙티브 앱)을 복제하지 않고, 참여 기능이 전혀 없는 가벼운
// 자체 셸로 영어 페이지를 만든다. 색상·폰트 토큰만 공유해서 화씨.방 특유의
// 책·서재 감성은 유지하되 메뉴·로그인·글쓰기·투표 UI는 아예 없다.
//
// ── 발행 게이트 (3중) ──────────────────────────────────────────────────
// 한 작품이 실제로 영어로 공개되려면 다음 세 가지가 전부 참이어야 한다:
//   1) en_publish_approved === true          (관리자가 승인함)
//   2) source_text_hash === 현재 원문 해시     (번역 이후 원문이 안 바뀜)
//   3) approved_source_hash === source_text_hash (승인한 그 번역본이 맞음)
// 3번이 없으면, 이미 승인된 작품을 재번역했을 때 승인이 켜진 채 새 번역이
// 저장돼 관리자가 확인하지 않은 번역문이 자동 공개된다("생성≠공개" 위반).
//
// ── 세 가지 상태 ───────────────────────────────────────────────────────
//   미승인          → 파일을 아예 만들지 않음 → 그 URL은 404
//   승인+해시일치   → 영어 본문 발행, index,follow, sitemap 포함, hreflang 상호 연결
//   승인+해시불일치 → 페이지는 유지하되 **영어 본문을 절대 렌더하지 않음**.
//                     "재확인 중" 안내 + 한국어 원문 링크만. noindex,follow,
//                     sitemap 제외, hreflang 제외.
// (bang/en/은 .gitignore 대상이라 저장소에 남지 않고 매 빌드마다 새로 만들어진다.
//  따라서 대상에서 빠진 작품의 파일은 다음 배포 아티팩트에 아예 존재하지 않는다.)
//
// ⚠️ 알려진 한계: 위 판정은 "다음 성공 빌드"에 반영된다. verify가 실패하면 Pages
// 배포 자체가 중단되고 이전 성공 배포가 라이브에 그대로 남는다. 원문 변경 직후부터
// 다음 성공 빌드까지의 지연(일일 cron 기준 최대 약 24시간)은 이 스크립트로 없앨 수
// 없다. 실제 공개 운영을 시작하기 전에 허용 지연을 별도로 합의해야 한다.

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const canon = require('../functions/lib/canonical-en.js');
// 기존 한국어 SSG의 검증된 정경 구현 — 공용 모듈과 결과가 같은지 대조하는 용도.
// (require해도 main()은 실행되지 않는다: 그 파일은 require.main 가드가 있다.)
const ko = require('./build-static-stories.js');

const ROOT = path.join(__dirname, '..');
// ⚠️ bang/en/ 아래에는 **영어 앱 소스**(index.html, en-app.js)가 함께 산다.
// 예전처럼 bang/en/을 통째로 지우고 다시 만들면 그 앱이 삭제된다. 그래서 빌드
// 산출물 경로를 story/ · stories/ · sitemap.xml로 한정하고, 앱 파일은 절대
// 건드리지 않는다.
const EN_STORY_OUT = path.join(ROOT, 'bang', 'en', 'story');
const EN_STORY_TMP = path.join(ROOT, 'bang', 'en', '.story-tmp');
const EN_ARCHIVE_DIR = path.join(ROOT, 'bang', 'en', 'stories');
const EN_SITEMAP_OUT = path.join(ROOT, 'bang', 'en', 'sitemap.xml');
const MANIFEST_PATH = path.join(ROOT, '.en-manifest.json');
const SITE_ORIGIN = 'https://hwasee.me';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// JSON-LD <script> 블록 삽입용 — 과거 이 지점에 </script> 이스케이프가 없어
// 저장형 XSS가 발생한 이력이 있다(커밋 0292834). 유저 작성 텍스트가 들어가므로
// 기존 한국어 SSG와 동일하게 '<'를 유니코드 이스케이프한다.
function jsonLdSafe(obj) {
  return JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
}

// ── 영어 전용 경량 셸 ────────────────────────────────────────────────────
// bang/index.html 복제가 아니다. 광고 스크립트 없음, 서비스워커 등록 없음,
// 로그인·메뉴·글쓰기 UI 없음. 색상 토큰은 한국어 정적 허브 페이지와 동일.
// 정적 페이지 공용 카카오 애드핏 — en-app.js AD_UNITS.footer와 같은 유닛.
// raw <ins>+<script>라 브라우저 기본 파싱만으로 자동 실행됨(동적 삽입이 아니므로
// 별도 로더 호출 불필요, 한국어 SSG 완결작 페이지 푸터 광고와 동일한 방식).
function enFooterAdHtml() {
  return `<div style="text-align:center;margin:24px 0">
  <ins class="kakao_ad_area" style="display:none;"
  data-ad-unit = "DAN-tFQi1kE1l4fdDOhZ"
  data-ad-width = "320"
  data-ad-height = "100"></ins>
  <script type="text/javascript" src="//t1.kakaocdn.net/kas/static/ba.min.js" async></script>
</div>`;
}

function enPageShell({ title, description, canonical, robots, bodyHtml, hreflangKo, jsonLd }) {
  const alt = hreflangKo
    ? `<link rel="alternate" hreflang="ko" href="${hreflangKo}">\n`
      + `<link rel="alternate" hreflang="en" href="${canonical}">\n`
      + `<link rel="alternate" hreflang="x-default" href="${hreflangKo}">\n`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- 한국판과 같은 GA4 속성 재사용(G-G7M4WPYHQK) — bang/en/index.html(라이브 앱)과
     동일 태그. pagePath로 필터해서 /bang/en/ 트래픽만 따로 볼 수 있음
     (functions/index.js getGa4EnSourceTrend 참고). -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-G7M4WPYHQK"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-G7M4WPYHQK');
</script>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${canonical}">
${alt}<link rel="icon" type="image/png" href="/bang/hwaseebang_sum.png">
<meta name="theme-color" content="#f0ead8">
<meta property="og:type"        content="article">
<meta property="og:url"         content="${canonical}">
<meta property="og:title"       content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image"       content="https://hwasee.me/bang/hwaseebang_og.png">
<meta property="og:locale"      content="en_US">
<meta name="twitter:card"        content="summary_large_image">
<meta name="twitter:title"       content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f0ead8; --surface: #e6dac8; --card: #ddd0b8; --border: #c4b090;
    --accent: #80978c; --accent2: #c8823a; --text: #1c0e06; --muted: #7a5c40;
    --radius: 12px;
    --font: Georgia, 'Times New Roman', serif;
    --serif: 'Gowun Batang', Georgia, serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--font); line-height: 1.7; }
  header {
    position: sticky; top: 0; z-index: 10; background: rgba(240,234,216,.92); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border); padding: 0 24px; height: 56px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .logo { font-size: 20px; font-weight: 400; letter-spacing: .5px; font-family: var(--serif); color: var(--text); text-decoration: none; }
  .to-ko { font-size: 13px; color: var(--muted); text-decoration: none; }
  main { max-width: 640px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-family: var(--serif); font-size: 25px; font-weight: 700; margin-bottom: 10px; line-height: 1.4; }
  h2 { font-family: var(--serif); font-size: 17px; font-weight: 700; margin: 32px 0 12px; }
  .lead { font-size: 14px; color: var(--muted); margin-bottom: 26px; }
  .prose { margin: 26px 0; }
  .prose p { font-family: var(--serif); font-size: 16px; line-height: 1.95; margin-bottom: 16px; }
  .meta { font-size: 13px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 16px; margin-top: 28px; }
  .meta span { margin-right: 14px; }
  .notice {
    background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: var(--radius); padding: 16px 18px; margin: 26px 0; font-size: 13.5px; color: var(--muted);
  }
  .notice strong { color: var(--text); font-weight: 700; }
  .origin-link { display: inline-block; margin-top: 6px; font-size: 14px; color: var(--accent2); }
  .story-item {
    display: block; text-decoration: none; color: inherit; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; margin-bottom: 12px;
  }
  .story-item-title { font-family: var(--serif); font-size: 16px; font-weight: 700; margin-bottom: 6px; }
  .story-item-teaser { font-size: 13.5px; color: var(--muted); }
  .story-item-meta { font-size: 11.5px; color: var(--accent2); margin-top: 8px; }
  .empty { text-align: center; padding: 40px 0; color: var(--muted); font-size: 14px; }
  .how { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin: 24px 0; }
  .how ol { margin: 0; padding-left: 20px; }
  .how li { font-size: 14px; margin-bottom: 10px; color: var(--muted); }
  .how li strong { color: var(--text); }
  footer { text-align: center; font-size: 12px; color: var(--muted); padding: 26px 20px; border-top: 1px solid var(--border); }
  footer a { color: var(--muted); }
</style>
${jsonLd ? `<script type="application/ld+json">\n${jsonLd}\n</script>\n` : ''}</head>
<body>
<header>
  <a class="logo" href="/bang/en/">Hwasee.bang</a>
  <a class="to-ko" href="/bang/">한국어</a>
</header>
${bodyHtml}
${enFooterAdHtml()}
<footer>
  <p>Hwasee.bang &middot; a Korean relay-fiction community</p>
  <p style="margin-top:6px"><a href="/bang/">Go to the Korean site</a></p>
</footer>
</body>
</html>
`;
}

// "참여 준비 중" 안내 — 클릭 가능한 버튼·입력·폼 요소를 절대 넣지 않는다.
// 실제 참여 기능처럼 보이는 요소가 있으면 안 된다는 것이 명시적 요구사항이다.
const COMING_SOON_NOTICE = `  <div class="notice">
    <strong>Multilingual relay writing is being prepared.</strong><br>
    For now this page is read-only. Participation happens on the Korean site, where each
    sentence is written and voted on by a different person.
  </div>`;

function renderEnStoryPage(item) {
  const url = `${SITE_ORIGIN}/bang/en/story/${item.story_id}/`;
  const koUrl = `${SITE_ORIGIN}/bang/story/${item.story_id}/`;

  if (item.state === 'stale') {
    // 스테일: 영어 번역 본문을 절대 출력하지 않는다. 원문이 바뀌었으므로
    // 저장된 번역은 더 이상 이 이야기의 내용이 아니다.
    const body = `<main>
  <h1>This translation is being re-checked</h1>
  <p class="lead">The Korean original of this story changed after it was translated, so the English
  version has been withdrawn until it is translated again and re-approved.</p>
  <div class="notice">
    <strong>Nothing is shown here on purpose.</strong><br>
    Showing an outdated translation would misrepresent what the authors actually wrote.
    The Korean original is always the source of truth.
    <br><a class="origin-link" href="${koUrl}">Read the Korean original &rarr;</a>
  </div>
${COMING_SOON_NOTICE}
</main>`;
    return enPageShell({
      title: 'Translation under review — Hwasee.bang',
      description: 'This English translation is being re-checked because the Korean original changed.',
      canonical: url,
      robots: 'noindex,follow',
      bodyHtml: body,
      hreflangKo: null, // 스테일 페이지는 hreflang으로 서로를 광고하지 않는다.
      jsonLd: null,
    });
  }

  const paragraphs = item.lines_en.map(l => `    <p>${esc(l)}</p>`).join('\n');
  const jsonLd = jsonLdSafe({
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: item.title_en,
    description: item.description_en,
    inLanguage: 'en',
    url,
    translationOfWork: { '@type': 'CreativeWork', url: koUrl, inLanguage: 'ko' },
    author: { '@type': 'Organization', name: 'Hwasee.bang community' },
    datePublished: item.lastmod || undefined,
  });

  const body = `<main>
  <h1>${esc(item.title_en)}</h1>
  <p class="lead">${esc(item.description_en)}</p>
  <div class="notice">
    <strong>This story was written one sentence at a time, by many different people.</strong><br>
    Each sentence was submitted separately and chosen by community vote before the next one
    could be written. Nobody knew how it would end.
    <br><a class="origin-link" href="${koUrl}">Read the Korean original &rarr;</a>
  </div>
  <div class="prose">
${paragraphs}
  </div>
  <div class="meta">
    <span>${item.lines_en.length} sentences</span>
    <span>Translated from Korean</span>
  </div>
${COMING_SOON_NOTICE}
</main>`;

  return enPageShell({
    title: `${item.title_en} — Hwasee.bang`,
    description: item.description_en,
    canonical: url,
    robots: 'index,follow',
    bodyHtml: body,
    hreflangKo: koUrl,
    jsonLd,
  });
}

function renderEnIndex(items) {
  const list = items.length
    ? items.map(it => `  <a class="story-item" href="/bang/en/story/${it.story_id}/">
    <div class="story-item-title">${esc(it.title_en)}</div>
    <div class="story-item-teaser">${esc(it.description_en)}</div>
    <div class="story-item-meta">${it.lines_en.length} sentences &middot; written by many hands</div>
  </a>`).join('\n')
    : `  <div class="empty">No English translations have been published yet.<br>
  They are added one at a time, after a human check.</div>`;

  const body = `<main>
  <h1>Stories written one sentence at a time</h1>
  <p class="lead">Hwasee.bang is a Korean relay-fiction community — a collaborative, round-robin way
  of writing fiction where no single author controls the plot. These are finished stories,
  translated into English.</p>

  <div class="how">
    <ol>
      <li><strong>Someone writes the first sentence.</strong> That is all they write.</li>
      <li><strong>Everyone else proposes what comes next.</strong> Several people submit a
      candidate for the very next sentence.</li>
      <li><strong>The community votes.</strong> The winning sentence becomes part of the story,
      permanently. The others are discarded.</li>
      <li><strong>Repeat until someone ends it.</strong> No single author controls the plot, and
      nobody knows the ending in advance.</li>
    </ol>
  </div>

  <h2>Translated stories</h2>
${list}

${COMING_SOON_NOTICE}
</main>`;

  return enPageShell({
    title: 'Hwasee.bang — Korean relay fiction, in English',
    description: 'Finished stories from Hwasee.bang, a Korean collaborative round-robin relay-fiction '
      + 'community where each sentence is written by a different person and chosen by vote. Translated into English.',
    canonical: `${SITE_ORIGIN}/bang/en/stories/`,
    robots: 'index,follow',
    bodyHtml: body,
    hreflangKo: `${SITE_ORIGIN}/bang/story/`,
    jsonLd: null,
  });
}

function renderEnSitemap(items) {
  const urls = [
    `  <url><loc>${SITE_ORIGIN}/bang/en/stories/</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`,
    ...items.map(it =>
      `  <url><loc>${SITE_ORIGIN}/bang/en/story/${it.story_id}/</loc>`
      + `${it.lastmod ? `<lastmod>${it.lastmod.slice(0, 10)}</lastmod>` : ''}`
      + `<changefreq>monthly</changefreq><priority>0.6</priority></url>`),
  ].join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

async function fetchStoryData(db, story_id) {
  const [epsSnap, subsSnap] = await Promise.all([
    db.collection('episodes').where('story_id', '==', story_id).get(),
    db.collection('submissions').where('story_id', '==', story_id).get(),
  ]);
  return {
    episodes: epsSnap.docs.map(d => Object.assign({ episode_id: d.id }, d.data())),
    submissions: subsSnap.docs.map(d => Object.assign({ sub_id: d.id }, d.data())),
  };
}

// 공용 모듈과 기존 한국어 SSG 구현이 같은 정경을 뽑는지 대조한다. 두 사본이
// 갈라지면 해시가 어긋나 멀쩡한 번역이 스테일로 처리되므로, 여기서 빌드를 멈춘다.
// 비교는 텍스트만이 아니라 sub_id까지 포함한다(같은 문장이 중복될 때 경로 차이를 놓치지 않으려고).
function assertCanonicalAgreement(story_id, episodes, submissions, sharedSubs) {
  const closedEps = episodes.filter(e => e.status === 'closed');
  const koTree = ko.getEpisodeTree(closedEps, submissions);
  if (!koTree) throw new Error(`정경 대조 실패(${story_id}): 기존 구현이 트리를 만들지 못함`);
  const koPath = ko.buildCanonicalPath(closedEps, submissions);
  const koSubs = ko.collectSubs(koTree, koPath);

  const a = koSubs.map(s => `${s.sub_id} ${s.content}`).join('');
  const b = sharedSubs.map(s => `${s.sub_id} ${s.content}`).join('');
  if (a !== b) {
    throw new Error(
      `정경 대조 실패(${story_id}): 기존 SSG 구현과 functions/lib/canonical-en.js의 결과가 다릅니다. `
      + `두 사본이 갈라졌으므로 원문 해시를 신뢰할 수 없습니다(기존 ${koSubs.length}문장 / 공용 ${sharedSubs.length}문장).`
    );
  }
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

async function main() {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다.');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceAccountRaw)) });
  }
  const db = admin.firestore();

  const transSnap = await db.collection('story_translations').get();
  console.log(`번역 문서 ${transSnap.size}건 발견`);

  const publishable = [];
  const stale = [];
  let skippedUnapproved = 0;

  for (const doc of transSnap.docs) {
    const t = doc.data() || {};
    const story_id = doc.id;

    // 게이트 1: 관리자 승인. 미승인이면 파일 자체를 만들지 않는다(→ 404).
    if (t.en_publish_approved !== true) { skippedUnapproved++; continue; }

    // 게이트 3: 승인한 그 번역본이 맞는지. 재번역 후 재승인 전이면 여기서 걸린다.
    const approvedMatches = t.approved_source_hash && t.approved_source_hash === t.source_text_hash;

    const storySnap = await db.collection('stories').doc(story_id).get();
    if (!storySnap.exists) { console.error(`스킵(이야기 없음): ${story_id}`); continue; }
    const story = storySnap.data() || {};
    if (story.status !== 'completed') { console.error(`스킵(완결 아님): ${story_id}`); continue; }

    const { episodes, submissions } = await fetchStoryData(db, story_id);
    const subs = canon.collectCanonicalSubs(episodes, submissions);
    if (!subs) { console.error(`스킵(채택 문장 없음): ${story_id}`); continue; }

    assertCanonicalAgreement(story_id, episodes, submissions, subs);

    // 게이트 2: 원문이 번역 이후 바뀌지 않았는지.
    const currentHash = canon.hashCanonical(story.opening || '', subs);
    const hashMatches = currentHash === t.source_text_hash;

    const lastmod = episodes.filter(e => e.status === 'closed')
      .reduce((max, e) => (e.closed_at && e.closed_at > max ? e.closed_at : max), '');

    const linesEn = Array.isArray(t.lines_en) ? t.lines_en : [];
    const shapeOk = linesEn.length === subs.length && linesEn.length > 0
      && !!String(t.title_en || '').trim() && !!String(t.description_en || '').trim();

    if (hashMatches && approvedMatches && shapeOk) {
      publishable.push({
        story_id, state: 'ok', lastmod,
        title_en: String(t.title_en).trim(),
        description_en: String(t.description_en).trim(),
        lines_en: linesEn.map(l => String(l == null ? '' : l)),
      });
    } else {
      const why = !hashMatches ? '원문 변경(해시 불일치)'
        : !approvedMatches ? '재번역 후 재승인 안 됨'
        : '번역 데이터 형식 불일치';
      console.log(`재확인 대상(${why}): ${story_id}`);
      stale.push({ story_id, state: 'stale', reason: why });
    }
  }

  console.log(`발행 ${publishable.length}건 / 재확인 ${stale.length}건 / 미승인 스킵 ${skippedUnapproved}건`);

  publishable.sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || ''));

  // 임시 디렉터리에 전부 만든 뒤 한 번에 교체한다 — 중간에 실패해도 부분 생성된
  // 상태가 bang/en/에 남지 않는다.
  // 임시 디렉터리에 전부 만든 뒤 한 번에 교체한다 — 중간에 실패해도 부분 생성된
  // 상태가 배포되지 않는다. 교체 대상은 story/ 하나뿐이라 앱 파일은 안전하다.
  rmrf(EN_STORY_TMP);
  fs.mkdirSync(EN_STORY_TMP, { recursive: true });
  for (const item of publishable.concat(stale)) {
    const dir = path.join(EN_STORY_TMP, item.story_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), renderEnStoryPage(item));
  }
  rmrf(EN_STORY_OUT);
  fs.renameSync(EN_STORY_TMP, EN_STORY_OUT);

  fs.mkdirSync(EN_ARCHIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EN_ARCHIVE_DIR, 'index.html'), renderEnIndex(publishable));
  fs.writeFileSync(EN_SITEMAP_OUT, renderEnSitemap(publishable));

  // manifest: 한국어 빌드가 hreflang을 붙일 대상을 여기서 받아간다(양쪽이 같은
  // 판정을 쓰게 해서 한쪽만 hreflang이 걸리는 일을 막는다). 완료 마커도 겸한다 —
  // verify가 "빌드가 아예 안 돌았음"과 "정상인데 목록이 빔"을 구별하는 근거.
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({
    generated_at: new Date().toISOString(),
    build_completed: true,
    publishable_ids: publishable.map(i => i.story_id),
    stale_ids: stale.map(i => i.story_id),
    skipped_unapproved: skippedUnapproved,
  }, null, 2));

  console.log(`영어 발행 완료 — 작품 ${publishable.length}건, 재확인 ${stale.length}건, sitemap URL ${publishable.length + 1}개(아카이브 포함)`);
}

module.exports = { renderEnStoryPage, renderEnIndex, renderEnSitemap, enPageShell, enFooterAdHtml, esc, jsonLdSafe };

if (require.main === module) {
  main().catch(e => {
    console.error('영어 발행 빌드 실패:', e);
    process.exit(1);
  });
}
