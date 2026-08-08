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
const ROOT_INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const OUT_DIR = path.join(BANG_DIR, 'story');
const SITEMAP_PATH = path.join(BANG_DIR, 'sitemap.xml');
const SITE_ORIGIN = 'https://hwasee.me';
const FB_ADMIN_ID = 'c50c82b2-fe0e-4ee9-be8c-8132f03b9cb6';
const FB_AI_ID    = '578873e7-47b7-48d3-9cd8-894546196205'; // functions/index.js와 동일한 값(AI 자동참여 전용 봇 계정)
const _isRealAuthor = id => id && id !== FB_ADMIN_ID && id !== FB_AI_ID;

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

// collectLines와 동일한 경로를 따라가되 문자열이 아니라 제출 객체 전체를 반환 —
// 참여자 수/투표수 등 부가정보를 계산하려면 author_id/vote_count가 필요해서 추가함.
function collectSubs(node, choices) {
  if (!node || node.ep.status !== 'closed' || !node.adoptedSubs.length) return [];
  const chosenId = (choices || {})[node.ep.episode_id];
  const sub = (chosenId && node.adoptedSubs.find(s => s.sub_id === chosenId)) || node.adoptedSubs[0];
  const child = node.children.find(c => c.ep.parent_sub_id === sub.sub_id);
  return [sub, ...collectSubs(child, choices)];
}

function _daysBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso) - new Date(startIso);
  if (!isFinite(ms) || ms < 0) return null;
  return Math.max(1, Math.round(ms / 86400000));
}

// 완결까지 채택된 문장들 각각에 대해, 같은 지점에서 채택되지 않은 후보 중 가장
// 표를 많이 받은 것("가장 접전이었던 후보")을 뽑음 — 작품마다 완전히 고유한
// 데이터라 다른 완결작 페이지와 중복될 위험이 없음. 채택 문장과의 표차가 작은
// 순(접전 순)으로 정렬해 상위 max개만 노출.
function pickRejectedCandidates(subs, allSubmissions, max) {
  const races = [];
  for (const chosen of subs) {
    const rivals = allSubmissions.filter(s =>
      s.episode_id === chosen.episode_id && s.sub_id !== chosen.sub_id &&
      s.is_adopted !== true && s.is_adopted !== 'TRUE' &&
      !s.is_deleted && s.content && s.content.trim() && _isRealAuthor(s.author_id)
    );
    if (!rivals.length) continue;
    const top = rivals.reduce((a, b) => (Number(b.vote_count) || 0) > (Number(a.vote_count) || 0) ? b : a);
    races.push({
      content: top.content,
      voteCount: Number(top.vote_count) || 0,
      winnerVoteCount: Number(chosen.vote_count) || 0,
    });
  }
  races.sort((a, b) => (a.winnerVoteCount - a.voteCount) - (b.winnerVoteCount - b.voteCount));
  return races.slice(0, max);
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
  return `<div class="story-prose">
      <div class="prose-opening">${esc(opening)}</div>
      ${lineHtml}
    </div>`;
}

function storyMetaHtml({ participantCount, sentenceCount, days }) {
  const parts = [`참여자 ${participantCount}명`, `${sentenceCount}문장`];
  if (days != null) parts.push(`${days}일 만에 완결`);
  return `<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)">
    <strong style="color:var(--text);font-size:13px">이 이야기가 만들어진 과정</strong><br>${esc(parts.join(' · '))}
  </div>`;
}

function candidatesHtml(candidates) {
  if (!candidates.length) return '';
  const items = candidates.map(c => `
    <div style="margin-top:10px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;font-size:13.5px;line-height:1.6">
      ${esc(c.content)}
      <div style="margin-top:4px;font-size:11.5px;color:var(--accent2)">${c.voteCount}표 · 채택 문장은 ${c.winnerVoteCount}표</div>
    </div>`).join('');
  return `<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
    <strong style="color:var(--text);font-size:13px">갈림길이 되었던 문장</strong>${items}
  </div>`;
}

function relatedStoriesHtml(related) {
  if (!related.length) return '';
  const items = related.map(r =>
    `<li style="margin-top:6px"><a href="/bang/story/${r.id}/" style="color:var(--accent2);text-decoration:none">${esc(r.title)}</a></li>`
  ).join('');
  return `<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
    <strong style="color:var(--text);font-size:13px">다른 완결작</strong>
    <ul style="list-style:none;margin-top:8px;font-size:13.5px;padding:0">${items}</ul>
  </div>`;
}

function storyPageBodyHtml({ opening, lines, meta, candidates, related }) {
  return `<div style="max-width:640px;margin:0 auto;padding:24px 16px 40px">
    ${proseHtml(opening, lines)}
    ${storyMetaHtml(meta)}
    ${candidatesHtml(candidates)}
    ${relatedStoriesHtml(related)}
    <a href="/bang/" style="display:inline-block;margin-top:24px;padding:10px 20px;background:var(--accent2);color:#fff;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600">화씨.방에서 계속 둘러보기 →</a>
  </div>`;
}

function renderStoryPage(indexHtmlSrc, { id, title, description, url, bodyHtml, lastmod, creatorNickname }) {
  // title/description은 유저가 쓴 오프닝·채택문장에서 옴(글자수만 제한되고
  // 문자 종류 제한은 없음) — JSON.stringify는 '<'나 '/'를 이스케이프하지
  // 않으므로 "</script><script>...</script>"를 심으면 이 JSON-LD 블록 자체가
  // 조기 종료되고 뒤의 스크립트가 실행되는 저장형 XSS가 됨. '<'를 유니코드
  // 이스케이프로 치환해 스크립트 태그로 절대 해석될 수 없게 함(JSON 값으로는
  // <도 '<'로 동일하게 파싱되므로 데이터 손실 없음).
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
  }, null, 2).replace(/</g, '\\u003c');

  // bang/index.html은 Windows(CRLF) 체크아웃일 수 있음 — 아래 리터럴 블록/치환은
  // 전부 LF 기준이라 먼저 정규화(출력 파일이 LF가 돼도 브라우저/크롤러엔 무해함)
  let html = indexHtmlSrc.replace(/\r\n/g, '\n');

  // 2026-07-27 네이버 노출 개선(커밋 0ec9ca3)으로 bang/index.html의 실제
  // <title> 문구가 "화씨.방 — ..."에서 "화씨.방(화씨방) — ..."로 바뀌면서
  // 아래 있던 리터럴 문자열 매칭이 조용히 실패하기 시작함(.replace()는 매치 실패해도
  // 에러 없이 원본을 그대로 반환) — 그 결과 완결작 정적 페이지 전부가 실제 이야기
  // 제목 대신 사이트 제네릭 타이틀을 그대로 달고 나갔고, 30개 페이지의 <title>이
  // 전부 바이트 단위로 동일해져서 구글이 중복 콘텐츠로 묶고 canonical을 무시하는
  // 결과로 이어짐(색인 급감 + 애드센스 저가치콘텐츠 재반려, 2026-08-08 발견).
  // JSON-LD/#app 마커처럼 구조 기반 정규식 + 못 찾으면 즉시 throw로 바꿔서
  // bang/index.html의 타이틀 문구가 또 바뀌어도 조용히 깨지지 않게 함.
  const titleMatch = html.match(/<title>[^<]*<\/title>/);
  if (!titleMatch) throw new Error(`<title> 태그를 못 찾음(story ${id}) — bang/index.html 구조가 바뀌었을 수 있음`);
  html = html.replace(titleMatch[0], `<title>${esc(title)} — 화씨.방</title>`);

  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${esc(description)}">`
  );

  // canonical도 같은 부류의 리터럴 매칭 취약점이라 함께 정규식+하드체크로 교체
  const canonicalMatch = html.match(/<link rel="canonical" href="[^"]*">/);
  if (!canonicalMatch) throw new Error(`canonical 태그를 못 찾음(story ${id}) — bang/index.html 구조가 바뀌었을 수 있음`);
  html = html.replace(canonicalMatch[0], `<link rel="canonical" href="${url}">`);
  // 예전엔 JSON-LD 내용 전체를 문자열로 그대로 박아넣어 정확히 일치해야만
  // 치환됐음 — bang/index.html 쪽 JSON-LD 필드(alternateName 등)가 나중에
  // 바뀌면서 두 사본이 어긋났고, 그 결과 이 매칭이 계속 실패해 완결작 SSG
  // 정적 페이지가 전부(25/25) 조용히 생성 실패하고 있었음(디버그방 발견,
  // 2026-07-29 — 애드센스 콘텐츠 반려의 실제 원인). 내부 필드 값과 무관하게
  // "WebApplication JSON-LD 스크립트 블록"이라는 구조만 정규식으로 찾도록 바꿔서
  // 같은 문제가 재발하지 않게 함.
  const webAppJsonLdMatch = html.match(/<script type="application\/ld\+json">\s*\{\s*"@context":\s*"https:\/\/schema\.org",\s*"@type":\s*"WebApplication"[\s\S]*?<\/script>/);
  if (!webAppJsonLdMatch) {
    throw new Error(`WebApplication JSON-LD 블록을 못 찾음(story ${id}) — bang/index.html이 바뀌었을 수 있음`);
  }
  html = html.replace(webAppJsonLdMatch[0], `<script type="application/ld+json">\n${jsonLd}\n</script>`);
  html = html.replace('<meta property="og:type"        content="website">', '<meta property="og:type"        content="article">');
  html = html.replace(/<meta property="og:url"\s+content="[^"]*">/, `<meta property="og:url"         content="${url}">`);
  html = html.replace(/<meta property="og:title"\s+content="[^"]*">/, `<meta property="og:title"       content="${esc(title)}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(description)}">`);
  html = html.replace(/<meta name="twitter:title"\s+content="[^"]*">/, `<meta name="twitter:title"      content="${esc(title)}">`);
  html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(description)}">`);

  // 예전엔 <div class="loading"> 리터럴까지 포함해서 찾았는데, .loading 클래스는
  // ::after로 "불러오는 중입니다"를 자동 삽입하는 CSS라 안에 진짜 콘텐츠를 채운
  // 채로 그 클래스를 쓰면 로딩 문구가 중복 표시되는 버그가 있었음(유저 지적,
  // 2026-07-29) — bang/index.html 쪽에서 그 클래스를 뺐더니 이 리터럴 매칭이
  // 깨졌을 것(WebApplication JSON-LD 때와 같은 종류의 함정). 내부 구조와
  // 무관하게 <main id="app"> ~ </main> 전체를 구조로만 찾도록 완화.
  const appMarker = /<main id="app">[\s\S]*?<\/main>/;
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

// 루트 홈(hwasee.me/) 콘텐츠 밀도 보강 — 애드센스가 "가치가 별로 없는 콘텐츠"로
// 반려(2026-07-29)했는데, curl로 직접 찍어보니 루트 페이지 실제 본문이 601자짜리
// 링크 허브뿐이었음(디버그방 확인, /bang/은 SSG로 이미 4만자 넘게 정상). 이미
// 만들어둔 완결작 데이터를 재사용해서 루트 페이지 자체에도 실제 이야기 미리보기를
// 심어 넣음 — 크롤러가 도메인 대표 얼굴(루트)에서부터 실질적인 텍스트를 보게 함.
//
// 2026-08-08 정정: 220자까지 자르던 이전 방식은, 완결작 본문이 대부분 100~450자라
// 사실상 이야기 전문을 루트 페이지에 그대로 재게시하는 꼴이었음(구글이 루트와
// 개별 작품 URL을 유사 콘텐츠로 묶어 canonical을 다르게 선택하는 원인 후보로 확인,
// [[project_hwasee_bang_adsense_content_gap]] 참고). 아카이브 목록(story/index.html)에서
// 이미 쓰고 있던 첫 문장 한 줄짜리 description으로 통일 — 루트에서는 "맛보기"만
// 보여주고 전문은 반드시 작품 URL에만 존재하게 함.
function renderRootArchivePreview(entries) {
  if (!entries.length) return '';
  const items = entries.map(e => {
    return `
    <a class="archive-item" href="/bang/story/${e.id}/">
      <div class="archive-title">${esc(e.title)}</div>
      <div class="archive-preview">${esc(e.description)}</div>
      ${e.lastmod ? `<div class="archive-date">완결 ${esc(e.lastmod.slice(0, 10))}</div>` : ''}
    </a>`;
  }).join('');

  return `
  <section class="archive">
    <h2>화씨.방에서 완성된 이야기</h2>
    <p class="archive-lede">여러 사람이 한 문장씩 이어 써서 완성한 이야기들이에요. 전체 목록은 <a href="/bang/story/">완결작 아카이브</a>에서 볼 수 있어요.</p>
    <div class="archive-list">${items}
    </div>
  </section>`;
}

// ── 메인 ──

async function main() {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다.');
  const svcJson = JSON.parse(serviceAccountRaw);
  admin.initializeApp({ credential: admin.credential.cert(svcJson) });
  const db = admin.firestore();

  const indexHtmlSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  const storiesSnap = await db.collection('stories').where('status', '==', 'completed').get();
  const stories = storiesSnap.docs.map(d => ({ story_id: d.id, ...d.data() }));
  console.log(`완결 이야기 ${stories.length}건 발견`);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1차 패스: 파일은 아직 안 쓰고 데이터만 계산 — "관련 작품" 링크를 고르려면
  // 전체 완결작 목록이 먼저 확정돼 있어야 해서 두 단계로 나눔(2026-08-09,
  // 콘텐츠 밀도 보강 — [[project_hwasee_bang_adsense_content_gap]] 참고).
  const processed = [];
  for (const story of stories) {
    try {
      const { episodes, submissions } = await fetchStoryData(db, story.story_id);
      const closedEps = episodes.filter(e => e.status === 'closed');
      const tree = getEpisodeTree(closedEps, submissions);
      if (!tree) { console.error(`스킵(마감된 에피소드 없음): ${story.story_id}`); continue; }

      const canonicalPath = buildCanonicalPath(closedEps, submissions);
      const subs = collectSubs(tree, canonicalPath);
      if (!subs.length) { console.error(`스킵(채택 문장 없음): ${story.story_id}`); continue; }
      const lines = subs.map(s => s.content);

      const lastmod = closedEps.reduce((max, e) => (e.closed_at && e.closed_at > max ? e.closed_at : max), '');
      const title = story.opening.length > 40 ? story.opening.slice(0, 40) + '…' : story.opening;
      const description = (lines[0] || '').length > 80 ? lines[0].slice(0, 80) + '…' : (lines[0] || '화씨.방에서 함께 완성한 이야기');
      const url = `${SITE_ORIGIN}/bang/story/${story.story_id}/`;

      const participantCount = new Set(subs.map(s => s.author_id).filter(_isRealAuthor)).size;

      processed.push({
        id: story.story_id, lastmod, title, description, url,
        opening: story.opening, lines,
        creatorNickname: story.creator_nickname,
        meta: {
          participantCount,
          sentenceCount: lines.length,
          days: _daysBetween(story.created_at, lastmod),
        },
        candidates: pickRejectedCandidates(subs, submissions, 4),
      });
    } catch (e) {
      console.error(`이야기 처리 실패(${story.story_id}):`, e.message);
    }
  }

  // 최신순으로 정렬 — 아카이브 목록과 "관련 작품" 선정 둘 다 이 순서를 기준으로 씀
  processed.sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || ''));

  // 2차 패스: 관련 작품(자기 다음 최신순 3편, 끝까지 가면 처음부터 순환) 확정 후 실제 파일 생성
  const sitemapEntries = [];
  let ok = 0;
  for (let i = 0; i < processed.length; i++) {
    const item = processed[i];
    const related = [];
    for (let k = 1; k <= processed.length - 1 && related.length < 3; k++) {
      related.push(processed[(i + k) % processed.length]);
    }

    const bodyHtml = storyPageBodyHtml({
      opening: item.opening, lines: item.lines, meta: item.meta,
      candidates: item.candidates, related,
    });

    const html = renderStoryPage(indexHtmlSrc, {
      id: item.id, title: item.title, description: item.description, url: item.url,
      bodyHtml, lastmod: item.lastmod, creatorNickname: item.creatorNickname,
    });

    const dir = path.join(OUT_DIR, item.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    sitemapEntries.push({ id: item.id, lastmod: item.lastmod, title: item.title, description: item.description });
    ok++;
  }

  fs.writeFileSync(SITEMAP_PATH, renderSitemap(sitemapEntries));
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), renderArchiveIndex(sitemapEntries));
  console.log(`정적 페이지 ${ok}/${stories.length}건 생성 완료, 아카이브 목록·sitemap.xml 갱신됨`);

  const ROOT_PREVIEW_COUNT = 15;
  const rootHtmlSrc = fs.readFileSync(ROOT_INDEX_HTML_PATH, 'utf8');
  const MARKER = '<!-- STORY_ARCHIVE_PLACEHOLDER -->';
  if (!rootHtmlSrc.includes(MARKER)) {
    throw new Error('루트 index.html에서 STORY_ARCHIVE_PLACEHOLDER 마커를 못 찾음 — index.html 구조가 바뀌었을 수 있음');
  }
  const rootPreviewHtml = renderRootArchivePreview(sitemapEntries.slice(0, ROOT_PREVIEW_COUNT));
  fs.writeFileSync(ROOT_INDEX_HTML_PATH, rootHtmlSrc.replace(MARKER, rootPreviewHtml));
  console.log(`루트 페이지(index.html)에 완결작 미리보기 ${Math.min(ROOT_PREVIEW_COUNT, sitemapEntries.length)}편 삽입 완료`);
}

module.exports = {
  getEpisodeTree, buildCanonicalPath, collectLines, collectSubs, pickRejectedCandidates,
  proseHtml, storyMetaHtml, candidatesHtml, relatedStoriesHtml, storyPageBodyHtml,
  renderStoryPage, renderSitemap, renderArchiveIndex, renderRootArchivePreview, esc,
};

if (require.main === module) {
  main().catch(e => {
    console.error('SSG 빌드 실패:', e);
    process.exit(1);
  });
}
