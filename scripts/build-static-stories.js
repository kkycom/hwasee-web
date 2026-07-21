// 완결작 정적 발행(SSG) — 애드센스 저가치콘텐츠 반려 대응 2단계.
// GitHub Actions 빌드 시점에 완결된 이야기를 bang/index.html 원본을 복제+주입해서
// bang/story/{id}/index.html로 만듦(진짜 프로그레시브 인핸스먼트 — 크롤러/JS 꺼진
// 브라우저는 정적 본문을, 실제 유저는 그 위에 로드된 앱 JS가 그대로 인터랙티브
// 버전으로 갈아치움. bang/index.html의 parsePath()가 이 URL 패턴을 이미 파싱하므로
// 별도 라우팅 처리 불필요). 상세 배경: project_hwasee_bang_static_prerender_handoff
// 메모리 참고(로컬 세션 밖에서는 무시).

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const ROOT = path.join(__dirname, '..');
const BANG_DIR = path.join(ROOT, 'bang');
const INDEX_HTML_PATH = path.join(BANG_DIR, 'index.html');
const OUT_DIR = path.join(BANG_DIR, 'story');
const SITEMAP_PATH = path.join(BANG_DIR, 'sitemap.xml');
const SITE_ORIGIN = 'https://hwasee.me';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── bang/index.html에서 그대로 포팅한 순수 함수 3개(DOM/전역 의존 없음) ──

function getEpisodeTree(episodes, submissions, pinnedSubs) {
  pinnedSubs = pinnedSubs || {};
  const subToChildEps = {};
  episodes.forEach(ep => {
    if (ep.parent_sub_id) {
      if (!subToChildEps[ep.parent_sub_id]) subToChildEps[ep.parent_sub_id] = [];
      subToChildEps[ep.parent_sub_id].push(ep);
    }
  });
  const rootEp = episodes.find(ep => !ep.parent_sub_id || ep.parent_sub_id === '')
    || (episodes.length ? episodes.reduce((a, b) => Number(a.step) <= Number(b.step) ? a : b) : null);
  if (!rootEp) return null;

  function buildNode(ep) {
    let adoptedSubs = submissions.filter(s =>
      s.episode_id === ep.episode_id && (s.is_adopted === true || s.is_adopted === 'TRUE')
    );
    const pinnedSubId = pinnedSubs[ep.episode_id];
    if (pinnedSubId && !adoptedSubs.some(s => s.sub_id === pinnedSubId)) {
      const pinnedSub = submissions.find(s => s.sub_id === pinnedSubId);
      if (pinnedSub) adoptedSubs = [...adoptedSubs, pinnedSub];
    }
    const children = adoptedSubs.flatMap(sub => (subToChildEps[sub.sub_id] || []).map(buildNode));
    return { ep, adoptedSubs, children };
  }
  return buildNode(rootEp);
}

function buildCanonicalPath(episodes, submissions) {
  const path_ = {};
  let traceSub = submissions.find(s => s.is_closing && s.is_adopted);
  if (!traceSub) {
    const maxStep = Math.max(...episodes.map(e => Number(e.step) || 0));
    const lastEps = new Set(episodes.filter(e => Number(e.step) === maxStep).map(e => e.episode_id));
    traceSub = submissions.find(s => lastEps.has(s.episode_id) && s.is_adopted);
  }
  const seenSubs = new Set();
  while (traceSub && !seenSubs.has(traceSub.sub_id)) {
    seenSubs.add(traceSub.sub_id);
    const ep = episodes.find(e => e.episode_id === traceSub.episode_id);
    if (!ep || !ep.parent_sub_id) break;
    const parentSub = submissions.find(s => s.sub_id === ep.parent_sub_id);
    if (!parentSub) break;
    const parentEp = episodes.find(e => e.episode_id === parentSub.episode_id);
    if (!parentEp) break;
    const parentAdopted = submissions.filter(s => s.episode_id === parentEp.episode_id && s.is_adopted);
    if (parentAdopted.length > 1) path_[parentEp.episode_id] = ep.parent_sub_id;
    traceSub = parentSub;
  }
  return path_;
}

function collectLines(node, choices) {
  if (!node || node.ep.status !== 'closed' || !node.adoptedSubs.length) return [];
  const chosenId = (choices || {})[node.ep.episode_id];
  const sub = (chosenId && node.adoptedSubs.find(s => s.sub_id === chosenId)) || node.adoptedSubs[0];
  const child = node.children.find(c => c.ep.parent_sub_id === sub.sub_id);
  return [sub.content, ...collectLines(child, choices)];
}

// ── Firestore 조회 ──

async function fetchStoryData(db, story_id) {
  const [episodesSnap, submissionsSnap] = await Promise.all([
    db.collection('episodes').where('story_id', '==', story_id).get(),
    db.collection('submissions').where('story_id', '==', story_id).get(),
  ]);
  const episodes = episodesSnap.docs.map(d => ({ episode_id: d.id, ...d.data() }));
  const subMap = new Map(submissionsSnap.docs.map(d => [d.id, { sub_id: d.id, ...d.data() }]));

  // 구형 데이터(submission에 story_id가 없는 경우) 대비 — episode_id로 재조회 병합
  const epIds = episodes.map(e => e.episode_id);
  for (let i = 0; i < epIds.length; i += 30) {
    const chunk = epIds.slice(i, i + 30);
    if (!chunk.length) continue;
    const fbSnap = await db.collection('submissions').where('episode_id', 'in', chunk).get();
    fbSnap.docs.forEach(d => { if (!subMap.has(d.id)) subMap.set(d.id, { sub_id: d.id, ...d.data() }); });
  }
  return { episodes, submissions: [...subMap.values()] };
}

// ── HTML 생성 ──

function proseHtml(opening, lines) {
  const lineHtml = lines.map(l =>
    `<div class="prose-line"><span class="prose-sentence">${esc(l)}</span></div>`
  ).join('\n      ');
  return `<div style="max-width:640px;margin:0 auto;padding:24px 16px 40px">
    <div class="story-prose">
      <div class="prose-opening">${esc(opening)}</div>
      ${lineHtml}
    </div>
    <a href="/bang/" style="display:inline-block;margin-top:24px;padding:10px 20px;background:var(--accent2);color:#fff;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600">화씨.방에서 계속 둘러보기 →</a>
  </div>`;
}

function renderStoryPage(indexHtmlSrc, { id, title, description, url, bodyHtml, lastmod, creatorNickname }) {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    headline: title,
    description,
    author: { '@type': 'Person', name: creatorNickname || '익명' },
    datePublished: lastmod || undefined,
    publisher: { '@type': 'Organization', name: '화씨 (Hwasee)', url: SITE_ORIGIN },
    url,
    inLanguage: 'ko',
  }, null, 2);

  // bang/index.html은 Windows(CRLF) 체크아웃일 수 있음 — 아래 리터럴 블록/치환은
  // 전부 LF 기준이라 먼저 정규화(출력 파일이 LF가 돼도 브라우저/크롤러엔 무해함)
  let html = indexHtmlSrc.replace(/\r\n/g, '\n');

  html = html.replace(
    '<title>화씨.방 — 릴레이 소설 공동창작 플랫폼</title>',
    `<title>${esc(title)} — 화씨.방</title>`
  );
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${esc(description)}">`
  );
  html = html.replace(
    '<link rel="canonical" href="https://hwasee.me/bang/">',
    `<link rel="canonical" href="${url}">`
  );
  // 정규식 대신 정확한 리터럴 블록으로 치환(중첩 객체 때문에 정규식은 깨지기 쉬움) —
  // bang/index.html의 WebApplication JSON-LD 블록이 바뀌면 이 문자열도 같이 고쳐야 함.
  const WEB_APP_JSONLD = `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "화씨.방",
  "alternateName": "Hwasee Bang",
  "url": "https://hwasee.me/bang/",
  "description": "한 문장씩 이어 쓰는 릴레이 소설 공동창작 플랫폼. 씨앗 이야기에 문장을 더해 여러 사람이 함께 이야기를 완성합니다.",
  "applicationCategory": "SocialNetworkingApplication",
  "operatingSystem": "Web",
  "inLanguage": "ko",
  "isAccessibleForFree": true,
  "publisher": {
    "@type": "Organization",
    "name": "화씨 (Hwasee)",
    "url": "https://hwasee.me"
  }
}
</script>`;
  if (!html.includes(WEB_APP_JSONLD)) {
    throw new Error(`WebApplication JSON-LD 블록을 못 찾음(story ${id}) — bang/index.html이 바뀌었을 수 있음`);
  }
  html = html.replace(WEB_APP_JSONLD, `<script type="application/ld+json">\n${jsonLd}\n</script>`);
  html = html.replace('<meta property="og:type"        content="website">', '<meta property="og:type"        content="article">');
  html = html.replace(/<meta property="og:url"\s+content="[^"]*">/, `<meta property="og:url"         content="${url}">`);
  html = html.replace(/<meta property="og:title"\s+content="[^"]*">/, `<meta property="og:title"       content="${esc(title)}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(description)}">`);
  html = html.replace(/<meta name="twitter:title"\s+content="[^"]*">/, `<meta name="twitter:title"      content="${esc(title)}">`);
  html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(description)}">`);

  const appMarker = /<main id="app"><div class="loading">[\s\S]*?<\/div><\/main>/;
  if (!appMarker.test(html)) throw new Error(`#app 마커를 못 찾음(story ${id}) — bang/index.html 구조가 바뀌었을 수 있음`);
  html = html.replace(appMarker, `<main id="app">${bodyHtml}</main>`);

  return html;
}

function renderSitemap(entries) {
  const staticPages = [
    { loc: `${SITE_ORIGIN}/bang/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${SITE_ORIGIN}/bang/story/`, changefreq: 'daily', priority: '0.8' },
    { loc: `${SITE_ORIGIN}/bang/about.html`, changefreq: 'monthly', priority: '0.5' },
    { loc: `${SITE_ORIGIN}/bang/guidelines.html`, changefreq: 'monthly', priority: '0.5' },
    { loc: `${SITE_ORIGIN}/bang/contact.html`, changefreq: 'monthly', priority: '0.5' },
    { loc: `${SITE_ORIGIN}/bang/privacy.html`, changefreq: 'yearly', priority: '0.3' },
  ];
  const urls = [
    ...staticPages.map(p => `  <url><loc>${p.loc}</loc><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`),
    ...entries.map(e =>
      `  <url><loc>${SITE_ORIGIN}/bang/story/${e.id}/</loc>${e.lastmod ? `<lastmod>${e.lastmod.slice(0, 10)}</lastmod>` : ''}<changefreq>monthly</changefreq><priority>0.6</priority></url>`
    ),
  ].join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// 완결작 아카이브 목록 — 별도로 대응하는 SPA 라우트가 없는 순수 정적 허브
// 페이지라 index.html 복제 방식이 아니라 contact.html/privacy.html과 같은
// 가벼운 자체 템플릿 사용. 개별 이야기 정적 페이지로 가는 실제 <a> 링크를
// 모아둬서, sitemap 없이도 크롤러가 내부 링크를 따라 전부 발견할 수 있게 함.
function renderArchiveIndex(entries) {
  const items = entries.map(e => `
    <a class="story-card" href="/bang/story/${e.id}/">
      <div class="story-title">${esc(e.title)}</div>
      <div class="story-desc">${esc(e.description)}</div>
      ${e.lastmod ? `<div class="story-date">완결 ${esc(e.lastmod.slice(0, 10))}</div>` : ''}
    </a>`).join('\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>완결된 이야기 모음 — 화씨.방</title>
<meta name="description" content="화씨.방에서 여러 사람이 함께 써서 완성한 이야기들을 모아봤어요. 지금까지 완결된 ${entries.length}편의 이야기를 읽어보세요.">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${SITE_ORIGIN}/bang/story/">
<link rel="icon" type="image/png" href="/bang/hwaseebang_sum.png">
<meta name="theme-color" content="#f0ead8">
<meta property="og:type"        content="website">
<meta property="og:url"         content="${SITE_ORIGIN}/bang/story/">
<meta property="og:title"       content="완결된 이야기 모음 — 화씨.방">
<meta property="og:description" content="화씨.방에서 여러 사람이 함께 써서 완성한 이야기들을 모아봤어요.">
<meta property="og:image"       content="https://hwasee.me/bang/hwaseebang_og.png">
<!-- 목록/링크 위주 페이지라 광고 스크립트를 안 넣음(빈 슬롯/광고 비율 과다 방지 —
     Gemini 최종 점검 지적, 2026-07-21) — 광고는 콘텐츠가 든든한 메인 앱/완결작
     페이지 위주로만 유지 -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&family=Noto+Sans+KR:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f0ead8; --surface: #e6dac8; --card: #ddd0b8; --border: #c4b090;
    --accent: #80978c; --accent2: #c8823a; --text: #1c0e06; --muted: #7a5c40;
    --radius: 12px; --font: 'Noto Sans KR', system-ui, sans-serif; --serif: 'Gowun Batang', Georgia, serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--font); line-height: 1.7; }
  header {
    position: sticky; top: 0; z-index: 10; background: rgba(240,234,216,.92); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border); padding: 0 24px; height: 56px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .logo { font-size: 20px; font-weight: 400; letter-spacing: .5px; font-family: var(--serif); color: var(--text); text-decoration: none; }
  .back { font-size: 13px; color: var(--muted); text-decoration: none; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 20px 80px; }
  h1 { font-family: var(--serif); font-size: 26px; font-weight: 700; margin-bottom: 8px; }
  .lead { font-size: 14px; color: var(--muted); margin-bottom: 32px; }
  .story-card {
    display: block; text-decoration: none; color: inherit; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; margin-bottom: 12px;
    transition: border-color .15s, background .15s;
  }
  .story-card:hover { border-color: var(--accent2); background: var(--card); }
  .story-title { font-family: var(--serif); font-size: 15px; font-weight: 700; margin-bottom: 6px; }
  .story-desc { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
  .story-date { font-size: 11px; color: var(--accent2); }
  .empty { font-size: 14px; color: var(--muted); padding: 32px 0; text-align: center; }
  footer { text-align: center; font-size: 12px; color: var(--muted); padding: 24px; border-top: 1px solid var(--border); }
  footer a { color: var(--muted); }
</style>
</head>
<body>
<header>
  <a class="logo" href="/bang/">화씨.방</a>
  <a class="back" href="/bang/">← 화씨.방으로 돌아가기</a>
</header>
<main>
  <h1>완결된 이야기 모음</h1>
  <p class="lead">여러 사람이 한 문장씩 이어 써서 완성한 이야기 ${entries.length}편이에요.</p>
  ${entries.length ? items : '<div class="empty">아직 완결된 이야기가 없어요.</div>'}
</main>
<footer>
  <a href="https://hwasee.me/" style="color:var(--muted)">화씨 홈</a> &nbsp;·&nbsp;
  <a href="/bang/" style="color:var(--muted)">화씨.방</a> &nbsp;·&nbsp;
  <a href="/bang/about.html" style="color:var(--muted)">소개</a>
  <p style="margin-top:8px">&copy; 2026 화씨 (Hwasee). All rights reserved.</p>
</footer>
</body>
</html>
`;
}

// ── 메인 ──

async function main() {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다.');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceAccountRaw)) });
  const db = admin.firestore();

  const indexHtmlSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  const storiesSnap = await db.collection('stories').where('status', '==', 'completed').get();
  const stories = storiesSnap.docs.map(d => ({ story_id: d.id, ...d.data() }));
  console.log(`완결 이야기 ${stories.length}건 발견`);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sitemapEntries = [];
  let ok = 0;

  for (const story of stories) {
    try {
      const { episodes, submissions } = await fetchStoryData(db, story.story_id);
      const closedEps = episodes.filter(e => e.status === 'closed');
      const tree = getEpisodeTree(closedEps, submissions);
      if (!tree) { console.error(`스킵(마감된 에피소드 없음): ${story.story_id}`); continue; }

      const canonicalPath = buildCanonicalPath(closedEps, submissions);
      const lines = collectLines(tree, canonicalPath);
      if (!lines.length) { console.error(`스킵(채택 문장 없음): ${story.story_id}`); continue; }

      const lastmod = closedEps.reduce((max, e) => (e.closed_at && e.closed_at > max ? e.closed_at : max), '');
      const title = story.opening.length > 40 ? story.opening.slice(0, 40) + '…' : story.opening;
      const description = (lines[0] || '').length > 80 ? lines[0].slice(0, 80) + '…' : (lines[0] || '화씨.방에서 함께 완성한 이야기');
      const url = `${SITE_ORIGIN}/bang/story/${story.story_id}/`;
      const bodyHtml = proseHtml(story.opening, lines);

      const html = renderStoryPage(indexHtmlSrc, {
        id: story.story_id, title, description, url, bodyHtml, lastmod,
        creatorNickname: story.creator_nickname,
      });

      const dir = path.join(OUT_DIR, story.story_id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html);
      sitemapEntries.push({ id: story.story_id, lastmod, title, description });
      ok++;
    } catch (e) {
      console.error(`이야기 처리 실패(${story.story_id}):`, e.message);
    }
  }

  // 최신순으로 정렬해서 아카이브 목록에 최근 완결작이 먼저 보이게
  sitemapEntries.sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || ''));

  fs.writeFileSync(SITEMAP_PATH, renderSitemap(sitemapEntries));
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), renderArchiveIndex(sitemapEntries));
  console.log(`정적 페이지 ${ok}/${stories.length}건 생성 완료, 아카이브 목록·sitemap.xml 갱신됨`);
}

module.exports = { getEpisodeTree, buildCanonicalPath, collectLines, proseHtml, renderStoryPage, renderSitemap, renderArchiveIndex, esc };

if (require.main === module) {
  main().catch(e => {
    console.error('SSG 빌드 실패:', e);
    process.exit(1);
  });
}
