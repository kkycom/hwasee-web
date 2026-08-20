// 완결작 + 진행 중 인기작 정적 발행(SSG) — 애드센스 저가치콘텐츠 반려 대응 2단계.
// GitHub Actions 빌드 시점에 완결된 이야기를 bang/index.html 원본을 복제+주입해서
// bang/story/{id}/index.html로 만듦(진짜 프로그레시브 인핸스먼트 — 크롤러/JS 꺼진
// 브라우저는 정적 본문을, 실제 유저는 그 위에 로드된 앱 JS가 그대로 인터랙티브
// 버전으로 갈아치움. bang/index.html의 parsePath()가 이 URL 패턴을 이미 파싱하므로
// 별도 라우팅 처리 불필요). 상세 배경: project_hwasee_bang_static_prerender_handoff
// 메모리 참고(로컬 세션 밖에서는 무시).
//
// 2026-08-20 — 홈 첫 화면의 실제 대표 콘텐츠(오늘의 이야기)가 완결 전엔 정적
// URL이 하나도 없던 간극을 메우려고, "지금 인기 자유 이야기(hot)" 후보까지
// 같은 story_id·같은 URL(/bang/story/{id}/)로 SSG 대상에 포함시킴(진행 중 status
// 그대로). hot은 완결 시에도 story_id가 안 바뀌는 유일한 슬롯이라(다른 슬롯은
// config/spotlight_slots 포인터가 완결마다 새 story_id로 교체됨) canonical/redirect
// 고민 없이 URL을 그대로 유지한 채 내용만(진행 중→완결) 갱신되는 구조가 성립함.
// 나머지 슬롯(word/speedrun/genre_switch/fairytale/fixed_ending)은 역할 기반
// URL이 따로 필요해서 여기 포함하지 않음(다음 단계에서 별도 설계).

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const ROOT = path.join(__dirname, '..');
const BANG_DIR = path.join(ROOT, 'bang');
const INDEX_HTML_PATH = path.join(BANG_DIR, 'index.html');
const ROOT_INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const OUT_DIR = path.join(BANG_DIR, 'story');
const TODAY_OUT_DIR = path.join(BANG_DIR, 'today');
const TODAY_HUB_PATH = path.join(TODAY_OUT_DIR, 'index.html');
const WORD_CHALLENGE_OUT_DIR = path.join(BANG_DIR, 'word-challenge');
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

// ── 5개 역할(role) 슬롯 — config/spotlight_slots 포인터가 완결마다 새
// story_id로 교체하는 슬롯들. bang/index.html의 SPOTLIGHT_META와 동일 라벨.
const SLOT_KEYS = ['word', 'speedrun', 'genre_switch', 'fairytale', 'fixed_ending'];
const SLOT_SLUG = {
  word: 'word', speedrun: 'speedrun', genre_switch: 'genre-switch',
  fairytale: 'fairytale', fixed_ending: 'fixed-ending',
};
const SLOT_LABEL = {
  word: '오늘의 세 단어 챌린지',
  speedrun: '초스피드 초장편',
  genre_switch: '장르 강제 전환',
  fairytale: '동화를 각색한 이야기',
  fixed_ending: '결말이 정해진 이야기',
};

// functions/index.js의 부문 집계 로직(3189~3216줄)과 동일 분류 기준 —
// "직전 완결본" 링크를 슬롯별로 찾으려면 완결작 각각이 어느 슬롯 출신인지
// 알아야 해서 포팅. word는 mode가 아니라 challenge_words 유무로 판별됨(주의).
function classifySection(story) {
  if (story.challenge_words) return 'word';
  if (story.mode === 'speedrun') return 'speedrun';
  if (story.mode === 'genre_switch') return 'genre_switch';
  if (story.mode === 'fixed_ending') return 'fixed_ending';
  if (story.mode === 'fairytale') return 'fairytale';
  return null;
}

// ── Firestore 조회 ──

async function fetchSpotlightSlotsPointer(db) {
  const snap = await db.collection('config').doc('spotlight_slots').get();
  return snap.exists ? snap.data() : {};
}

// bang/firebase-api.js의 fbGetSpotlight() hot 슬롯 선정 쿼리와 동일 기준
// (status/participant_count 인덱스도 firestore.indexes.json에 이미 있어 재사용) —
// 실서비스 홈 화면에 실제로 노출되는 것과 다른 후보를 SSG하면 의미가 없어서
// 그대로 복제. vote_threshold 유무로 "역할 슬롯 출신이라 제외"를 가려내던
// 예전 방식은 exports.cleanupAbandonedSeeds가 이미 겪은 것과 같은 버그
// 패턴(초스피드는 vote_threshold를 아예 안 만들어서 안 걸러짐, 2026-07-29
// 실사고)이라 — 포인터 story_id를 직접 조회해서 명시적으로 제외하는 방식으로
// bang/firebase-api.js와 함께 고침(2026-08-20).
async function fetchHotCandidateStories(db, excludeStoryIds) {
  const snap = await db.collection('stories')
    .where('status', '==', 'active')
    .orderBy('participant_count', 'desc')
    .limit(10)
    .get();
  return snap.docs
    .filter(d => !excludeStoryIds.has(d.id))
    .map(d => ({ story_id: d.id, ...d.data() }));
}

// 오늘의 세 단어 챌린지(마감분만) — bang/firebase-api.js의
// fbGetWordChallengeHistory()와 동일 쿼리 패턴(status로 필터링하는 복합
// 인덱스 없이 start_at 단일 인덱스만으로 동작하게, status 필터는 JS에서).
// 진행 중인 챌린지는 실시간 경쟁 상태(투표가 몇 시간 단위로 계속 바뀜)라
// 정적 스냅샷 대상에서 제외 — hint(초성 퀴즈)를 뺀 것과 같은 이유
// (2026-08-20 설계 논의 결론).
//
// ⚠️ winner_text/winner_nickname 단일 필드는 문서 생성 시(_serverStartWordChallenge)
// null로 세팅된 뒤 마감 로직(_serverCloseWordChallenge, functions/index.js
// 3990~4003줄)에서 한 번도 갱신되지 않는 죽은 필드 — 실제 마감 로직은
// "winners" 배열(동률 당선 지원, {text,nickname,vote_count,user_id,points})에
// 우승자를 저장함. 이 필드로 게이트를 걸었더니 실제 마감분이 있는데도 전부
// 빠지는 버그가 있었음(2026-08-20, 라이브 문서 직접 조회로 발견) — winners
// 배열 기준으로 수정.
async function fetchClosedWordChallenges(db, limit = 40) {
  const snap = await db.collection('word_challenges').orderBy('start_at', 'desc').limit(limit).get();
  return snap.docs
    .map(d => ({ challenge_id: d.id, ...d.data() }))
    .filter(c => c.status === 'closed' && Array.isArray(c.winners) && c.winners.length > 0);
}

// 후보 문장 전부를 SSG하면 페이지가 비대해지고 페이지 간 구조도 비슷해져서,
// 득표 상위 5개만 — 결과 페이지 취지에 맞고 완결작의 candidatesHtml(상위 4개
// 갈림길 문장)과 동일한 절제 원칙.
//
// ⚠️ 제출 문장 필드는 content가 아니라 text — fbSubmitWordChallengeEntry
// (bang/firebase-api.js 3483줄)가 그렇게 write함. winners 배열 버그와 같은
// "필드명 확인 없이 짐작" 실수라 같이 발견돼서 함께 고침(2026-08-20).
async function fetchWordChallengeTopSubmissions(db, challenge_id, max = 5) {
  const snap = await db.collection('word_challenge_submissions').where('challenge_id', '==', challenge_id).get();
  return snap.docs
    .map(d => ({ ...d.data() }))
    .filter(s => s.text && s.text.trim())
    .sort((a, b) => (Number(b.vote_count) || 0) - (Number(a.vote_count) || 0))
    .slice(0, max);
}

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

function storyMetaHtml({ participantCount, sentenceCount, days, isCompleted }) {
  const parts = [`참여자 ${participantCount}명`, `${sentenceCount}문장`];
  parts.push(isCompleted
    ? (days != null ? `${days}일 만에 완결` : '완결')
    : (days != null ? `${days}일째 진행 중` : '진행 중'));
  return `<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)">
    <strong style="color:var(--text);font-size:13px">${isCompleted ? '이 이야기가 만들어진 과정' : '지금까지의 이야기'}</strong><br>${esc(parts.join(' · '))}
    ${isCompleted ? '' : '<div style="margin-top:8px;font-size:12.5px;color:var(--accent2)">✍️ 아직 진행 중인 이야기예요. 화씨.방에서 다음 문장을 이어써 보세요.</div>'}
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

function renderSitemap(entries, extraStaticPages) {
  const staticPages = [
    { loc: `${SITE_ORIGIN}/bang/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${SITE_ORIGIN}/bang/story/`, changefreq: 'daily', priority: '0.8' },
    { loc: `${SITE_ORIGIN}/bang/about.html`, changefreq: 'monthly', priority: '0.5' },
    { loc: `${SITE_ORIGIN}/bang/guidelines.html`, changefreq: 'monthly', priority: '0.5' },
    { loc: `${SITE_ORIGIN}/bang/contact.html`, changefreq: 'monthly', priority: '0.5' },
    { loc: `${SITE_ORIGIN}/bang/privacy.html`, changefreq: 'yearly', priority: '0.3' },
    // today 허브/word-challenge 아카이브는 항상 고정 URL이지만 indexable
    // 여부가 빌드마다 바뀔 수 있어(콘텐츠 없으면 noindex) 고정 리스트에
    // 못 넣고 main()에서 조건부로 넘겨줌.
    ...(extraStaticPages || []),
  ];
  const urls = [
    ...staticPages.map(p => `  <url><loc>${p.loc}</loc><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`),
    ...entries.map(e => {
      // slotSlug가 있으면 today/{slot} 역할 페이지, wcId가 있으면 세 단어
      // 챌린지 개별 결과 페이지, 둘 다 없으면 story/{id} 콘텐츠 페이지.
      const loc = e.slotSlug ? `${SITE_ORIGIN}/bang/today/${e.slotSlug}/`
        : e.wcId ? `${SITE_ORIGIN}/bang/word-challenge/${e.wcId}/`
        : `${SITE_ORIGIN}/bang/story/${e.id}/`;
      // 진행 중 이야기/역할 페이지는 문장이 계속 추가되므로 완결작(monthly)보다
      // 짧은 주기로 표시 — 실제 리빌드 주기는 별개(GitHub Actions 스케줄)지만,
      // changefreq는 크롤러에게 갱신 가능성을 알려주는 힌트라 정직하게 반영.
      // 세 단어 챌린지 개별 결과는 마감분만 만들어서(내용이 다시 안 바뀜)
      // 완결작과 동일하게 monthly.
      const changefreq = e.slotSlug ? 'daily' : e.wcId ? 'monthly' : (e.isCompleted ? 'monthly' : 'daily');
      return `  <url><loc>${loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod.slice(0, 10)}</lastmod>` : ''}<changefreq>${changefreq}</changefreq><priority>0.6</priority></url>`;
    }),
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
  <a href="/bang/today/" style="color:var(--muted)">오늘의 이야기</a> &nbsp;·&nbsp;
  <a href="/bang/word-challenge/" style="color:var(--muted)">세 단어 챌린지 결과</a> &nbsp;·&nbsp;
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

// today/{slot} 역할 페이지 — /bang/story/{id}/와 달리 "지금 이 슬롯이 뭘
// 가리키는지" 안내하는 역할(role) 페이지라 완전히 별개 정체성. 완결작
// 아카이브(renderArchiveIndex)와 같은 이유로 대응하는 SPA 라우트가 없는
// 순수 정적 허브라 가벼운 자체 템플릿 사용. 현재 story의 전체 본문은 절대
// 넣지 않고(중복 콘텐츠 방지, 2026-08-20 설계 논의) description(≤80자
// 티저)만 링크와 함께 보여줌 — 전문은 반드시 /bang/story/{id}/에만 존재.
function todaySlotBodyHtml({ slotKey, current, previous }) {
  const label = SLOT_LABEL[slotKey];
  const currentHtml = current ? `
    <div class="today-current">
      <div class="today-current-title">${esc(current.title)}</div>
      <div class="today-current-teaser">${esc(current.description)}</div>
      <div class="today-current-meta">참여자 ${current.meta.participantCount}명 · ${current.meta.sentenceCount}문장 · ${current.meta.days != null ? `${current.meta.days}일째 진행 중` : '진행 중'}</div>
      <a class="today-cta" href="/bang/story/${current.id}/">지금까지의 이야기 읽기 →</a>
    </div>` : `
    <div class="today-current today-empty">새 라운드가 막 시작됐어요. 화씨.방에서 첫 문장을 이어써보세요!</div>`;

  const previousHtml = previous ? `
    <div class="today-previous">
      <div class="today-previous-label">지난 이야기</div>
      <a class="today-previous-link" href="/bang/story/${previous.id}/">
        <div class="today-previous-title">${esc(previous.title)}</div>
        <div class="today-previous-desc">${esc(previous.description)}</div>
      </a>
    </div>` : '';

  // word 슬롯은 이 이야기를 시작시킨 "세 단어 챌린지" 결과 아카이브와
  // 직접 연관돼 있어서(우승 문장이 이 이야기의 오프닝이 됨) 다른 슬롯엔
  // 없는 전용 링크를 하나 더 붙임.
  const wordChallengeLinkHtml = slotKey === 'word'
    ? `<p style="margin-top:16px;font-size:13px;color:var(--muted)">이 이야기는 세 단어 챌린지 우승 문장에서 시작됐어요 — <a href="/bang/word-challenge/" style="color:var(--accent2)">지난 우승작들 보기</a></p>`
    : '';

  return `<h1>${esc(label)}</h1>
    ${currentHtml}
    ${previousHtml}
    ${wordChallengeLinkHtml}
    <a href="/bang/" class="today-back">화씨.방에서 참여하기 →</a>`;
}

function renderTodaySlotPage({ slotKey, current, previous, indexable }) {
  const label = SLOT_LABEL[slotKey];
  const url = `${SITE_ORIGIN}/bang/today/${SLOT_SLUG[slotKey]}/`;
  const description = current
    ? `지금 화씨.방에서 진행 중인 ${label} — ${current.description}`
    : previous
      ? `화씨.방의 ${label} — 지난 이야기: ${previous.description}`
      : `화씨.방에서 매일 진행되는 ${label}에 참여해보세요.`;
  const body = todaySlotBodyHtml({ slotKey, current, previous });

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(label)} — 화씨.방</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${indexable ? 'index,follow' : 'noindex,follow'}">
<link rel="canonical" href="${url}">
<link rel="icon" type="image/png" href="/bang/hwaseebang_sum.png">
<meta name="theme-color" content="#f0ead8">
<meta property="og:type"        content="website">
<meta property="og:url"         content="${url}">
<meta property="og:title"       content="${esc(label)} — 화씨.방">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image"       content="https://hwasee.me/bang/hwaseebang_og.png">
<!-- 완결작 아카이브와 같은 이유로 광고 스크립트 없음(요약/링크 위주 허브,
     Gemini 최종 점검 지적, 2026-07-21) -->
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
  main { max-width: 640px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-family: var(--serif); font-size: 24px; font-weight: 700; margin-bottom: 20px; }
  .today-current { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 20px; }
  .today-current-title { font-family: var(--serif); font-size: 16px; font-weight: 700; margin-bottom: 8px; }
  .today-current-teaser { font-size: 14px; color: var(--text); margin-bottom: 10px; line-height: 1.7; }
  .today-current-meta { font-size: 12px; color: var(--muted); margin-bottom: 14px; }
  .today-cta, .today-back { display: inline-block; padding: 10px 18px; background: var(--accent2); color: #fff; border-radius: 10px; text-decoration: none; font-size: 14px; font-weight: 600; }
  .today-empty { color: var(--muted); font-size: 14px; }
  .today-previous { margin-bottom: 24px; }
  .today-previous-label { font-size: 12px; color: var(--muted); font-weight: 700; margin-bottom: 8px; }
  .today-previous-link { display: block; text-decoration: none; color: inherit; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
  .today-previous-title { font-family: var(--serif); font-size: 14px; font-weight: 700; margin-bottom: 4px; }
  .today-previous-desc { font-size: 13px; color: var(--muted); }
  .today-back { margin-top: 8px; }
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
  ${body}
</main>
<footer>
  <a href="https://hwasee.me/" style="color:var(--muted)">화씨 홈</a> &nbsp;·&nbsp;
  <a href="/bang/" style="color:var(--muted)">화씨.방</a> &nbsp;·&nbsp;
  <a href="/bang/today/" style="color:var(--muted)">오늘의 이야기</a> &nbsp;·&nbsp;
  <a href="/bang/story/" style="color:var(--muted)">완결작 모음</a> &nbsp;·&nbsp;
  <a href="/bang/word-challenge/" style="color:var(--muted)">세 단어 챌린지 결과</a>
  <p style="margin-top:8px">&copy; 2026 화씨 (Hwasee). All rights reserved.</p>
</footer>
</body>
</html>
`;
}

// 완결작 아카이브(renderArchiveIndex)/역할 슬롯(renderTodaySlotPage)과 같은
// "SPA 라우트가 없는 가벼운 정적 허브" 부류가 이제 3종류(오늘의 이야기 허브,
// 세 단어 챌린지 아카이브·개별 결과)로 늘어나서 <head>/헤더/푸터 반복을
// 공유 셸로 뺌 — 기존 두 함수는 이미 배포돼 검증된 구조라 굳이 안 건드림.
function staticHubPageShell({ title, description, canonical, robots, ogTitle, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" href="/bang/hwaseebang_sum.png">
<meta name="theme-color" content="#f0ead8">
<meta property="og:type"        content="website">
<meta property="og:url"         content="${canonical}">
<meta property="og:title"       content="${esc(ogTitle || title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image"       content="https://hwasee.me/bang/hwaseebang_og.png">
<!-- 완결작 아카이브와 같은 이유로 광고 스크립트 없음(요약/링크 위주 허브,
     Gemini 최종 점검 지적, 2026-07-21) -->
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
  main { max-width: 640px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-family: var(--serif); font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  h2 { font-family: var(--serif); font-size: 16px; font-weight: 700; margin: 28px 0 12px; }
  .lead { font-size: 14px; color: var(--muted); margin-bottom: 24px; }
  .hub-item {
    display: block; text-decoration: none; color: inherit; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; margin-bottom: 12px;
  }
  .hub-item-title { font-family: var(--serif); font-size: 15px; font-weight: 700; margin-bottom: 6px; }
  .hub-item-teaser { font-size: 13px; color: var(--muted); }
  .hub-item-meta { font-size: 11px; color: var(--accent2); margin-top: 6px; }
  .wc-words { font-size: 12px; color: var(--accent2); font-weight: 700; margin-bottom: 6px; letter-spacing: .3px; }
  .wc-winner { font-family: var(--serif); font-size: 15px; font-weight: 700; margin-bottom: 6px; }
  .wc-candidate { margin-top: 8px; padding: 8px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; font-size: 13px; line-height: 1.6; }
  .wc-candidate-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .more-list { list-style: none; font-size: 13.5px; }
  .more-list li { margin-bottom: 8px; }
  .more-list a { color: var(--accent2); }
  .empty { text-align: center; padding: 32px 0; color: var(--muted); font-size: 14px; }
  .back-cta { display: inline-block; margin-top: 24px; padding: 10px 20px; background: var(--accent2); color: #fff; border-radius: 10px; text-decoration: none; font-size: 14px; font-weight: 600; }
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
  ${bodyHtml}
</main>
<footer>
  <a href="https://hwasee.me/" style="color:var(--muted)">화씨 홈</a> &nbsp;·&nbsp;
  <a href="/bang/" style="color:var(--muted)">화씨.방</a> &nbsp;·&nbsp;
  <a href="/bang/today/" style="color:var(--muted)">오늘의 이야기</a> &nbsp;·&nbsp;
  <a href="/bang/story/" style="color:var(--muted)">완결작 모음</a> &nbsp;·&nbsp;
  <a href="/bang/word-challenge/" style="color:var(--muted)">세 단어 챌린지 결과</a>
  <p style="margin-top:8px">&copy; 2026 화씨 (Hwasee). All rights reserved.</p>
</footer>
</body>
</html>
`;
}

// /bang/today/ 허브 — 5개 역할 슬롯을 한 곳에 모아 링크(오늘의 이야기 각
// 슬롯 페이지가 sitemap에만 있고 실제 내부링크가 없으면 크롤러 발견 신뢰도가
// 낮아서, 2026-08-20 논의로 추가). hint/diary는 story_id가 없는 완전히 다른
// 데이터 모델이라 이번엔 전용 페이지를 안 만들고, 여기서 안내+링크만.
function todayHubBodyHtml(slotSummaries) {
  const items = slotSummaries.map(({ slotKey, current, previous }) => {
    const label = SLOT_LABEL[slotKey];
    const teaser = current ? current.description : (previous ? `지난 이야기: ${previous.description}` : '새 라운드를 준비하고 있어요.');
    return `
    <a class="hub-item" href="/bang/today/${SLOT_SLUG[slotKey]}/">
      <div class="hub-item-title">${esc(label)}</div>
      <div class="hub-item-teaser">${esc(teaser)}</div>
    </a>`;
  }).join('');

  return `<h1>오늘의 이야기</h1>
    <p class="lead">화씨.방에서 지금 진행 중인 이야기들이에요.</p>
    ${items}
    <h2>그 밖에도</h2>
    <ul class="more-list">
      <li>🧩 초성 문장 퀴즈 — 매일 정시마다 새 라운드가 열려요. <a href="/bang/">화씨.방에서 참여하기 →</a></li>
      <li>📔 훔쳐본 일기장 — 매주 수요일 새 이야기가 공개돼요. <a href="/bang/">화씨.방에서 읽기 →</a></li>
      <li>🎲 세 단어 챌린지 — 지난 우승작들은 <a href="/bang/word-challenge/">여기서</a> 볼 수 있어요.</li>
    </ul>`;
}

function renderTodayHubPage(slotSummaries) {
  const url = `${SITE_ORIGIN}/bang/today/`;
  return staticHubPageShell({
    title: '오늘의 이야기 — 화씨.방',
    description: '화씨.방에서 지금 진행 중인 초스피드 초장편, 장르 강제 전환, 결말이 정해진 이야기, 동화 각색, 세 단어 챌린지를 한눈에 보세요.',
    canonical: url, robots: 'index,follow',
    bodyHtml: todayHubBodyHtml(slotSummaries),
  });
}

// winners 배열의 첫 번째(대표) 당선작 — 동률 당선이면 여러 명이지만, 리스트
// 미리보기/제목/description처럼 "대표 1개"가 필요한 자리에서 사용.
function primaryWinner(challenge) {
  return (challenge.winners || [])[0] || {};
}

// /bang/word-challenge/{id}/ — 마감된 챌린지만 SSG 대상(진행 중인 챌린지는
// 몇 시간 단위로 순위가 바뀌는 실시간 경쟁 상태라 정적 스냅샷 부적합 —
// hint를 뺀 것과 같은 이유, 2026-08-20 설계 논의 결론). 후보 전부가 아니라
// 득표 상위 5개만(completedOnly의 candidatesHtml과 동일 절제 원칙). 동률
// 당선(winners 여러 개)이면 전부 "우승"으로 표시 — 스토리 쪽 갈림길 완결과
// 동일한 원칙(_serverCloseWordChallenge가 동률을 전부 당선 처리함).
function wordChallengePageBodyHtml({ challenge, candidates }) {
  const winners = challenge.winners || [];
  const words = (challenge.words || []).join(' · ');
  const winnerTexts = new Set(winners.map(w => w.text));
  const winnersHtml = winners.map(w => `
    <div class="wc-winner">"${esc(w.text)}"</div>
    <div class="hub-item-meta">${esc(w.nickname || '익명')}님 · ${Number(w.vote_count) || 0}표${winners.length > 1 ? ' · 공동 우승' : '로 우승'}</div>`).join('');
  const candidatesHtml2 = candidates
    .filter(c => !winnerTexts.has(c.text)) // 우승작 중복 노출 방지
    .map(c => `
    <div class="wc-candidate">
      ${esc(c.text)}
      <div class="wc-candidate-meta">${Number(c.vote_count) || 0}표</div>
    </div>`).join('');

  return `<a class="back" href="/bang/word-challenge/">← 세 단어 챌린지 결과 모음</a>
    <h1>${esc(challenge.date || '')} 세 단어 챌린지</h1>
    <div class="wc-words">${esc(words)}</div>
    ${winnersHtml}
    ${candidatesHtml2 ? `<h2>다른 도전 문장들</h2>${candidatesHtml2}` : ''}
    <a href="/bang/today/word/" class="back-cta">지금 이어지는 이야기 보기 →</a>`;
}

function renderWordChallengePage({ challenge, candidates }) {
  const url = `${SITE_ORIGIN}/bang/word-challenge/${challenge.challenge_id}/`;
  const winner = primaryWinner(challenge);
  const title = `${(challenge.words || []).join('·')} — 세 단어 챌린지 우승작`;
  const description = `"${winner.text}" — ${(challenge.words || []).join(', ')}로 만든 세 단어 챌린지 우승 문장.`;
  return staticHubPageShell({
    title: `${esc(title)} — 화씨.방`, description, canonical: url, robots: 'index,follow',
    ogTitle: title,
    bodyHtml: wordChallengePageBodyHtml({ challenge, candidates }),
  });
}

// /bang/word-challenge/ 아카이브 허브
function wordChallengeArchiveBodyHtml(entries) {
  const items = entries.map(({ challenge }) => {
    const winner = primaryWinner(challenge);
    return `
    <a class="hub-item" href="/bang/word-challenge/${challenge.challenge_id}/">
      <div class="wc-words">${esc((challenge.words || []).join(' · '))}</div>
      <div class="hub-item-title">"${esc(winner.text)}"</div>
      <div class="hub-item-meta">${esc(winner.nickname || '익명')}님 · ${Number(winner.vote_count) || 0}표${(challenge.winners || []).length > 1 ? ` 외 공동우승 ${challenge.winners.length - 1}건` : ''} · ${esc((challenge.date || '').slice(0, 10))}</div>
    </a>`;
  }).join('');

  return `<h1>세 단어 챌린지 결과 모음</h1>
    <p class="lead">매일 주어지는 세 단어로 사람들이 쓴 문장 중, 가장 많은 표를 받은 우승작들이에요. 진행 중인 챌린지는 <a href="/bang/">화씨.방</a>에서 실시간으로 참여할 수 있어요.</p>
    ${entries.length ? items : '<div class="empty">아직 마감된 챌린지가 없어요.</div>'}`;
}

function renderWordChallengeArchive(entries, indexable) {
  const url = `${SITE_ORIGIN}/bang/word-challenge/`;
  return staticHubPageShell({
    title: '세 단어 챌린지 결과 모음 — 화씨.방',
    description: `화씨.방에서 매일 진행되는 세 단어 챌린지의 지난 우승작 ${entries.length}편을 모아봤어요.`,
    canonical: url, robots: indexable ? 'index,follow' : 'noindex,follow',
    bodyHtml: wordChallengeArchiveBodyHtml(entries),
  });
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
  const completedStories = storiesSnap.docs.map(d => ({ story_id: d.id, ...d.data(), isCompleted: true }));

  const slotPtr = await fetchSpotlightSlotsPointer(db);
  const slotStoryIds = new Set(SLOT_KEYS.map(k => slotPtr[k] && slotPtr[k].story_id).filter(Boolean));
  const hotStories = await fetchHotCandidateStories(db, slotStoryIds);
  // 정합성 회귀 가드 — 위에서 명시적으로 제외했으니 절대 겹치면 안 됨(겹치면
  // hot 선정 로직이 다시 예전 vote_threshold 버그 패턴으로 돌아갔다는 뜻).
  const overlap = hotStories.filter(s => slotStoryIds.has(s.story_id));
  if (overlap.length) {
    throw new Error(`hot 후보와 역할 슬롯 story_id가 겹침(선정 로직 회귀 의심): ${overlap.map(s => s.story_id).join(', ')}`);
  }

  // 5개 역할 슬롯이 지금 가리키는 story도 같은 in-progress 파이프라인으로
  // /bang/story/{id}/를 만들어둠 — today/{slot} 페이지가 여길 링크로만
  // 참조하고(본문 복붙 안 함) 항상 유효한 링크가 되게 하려면 hot 후보 여부와
  // 무관하게 독립적으로 존재를 보장해야 함.
  const slotCurrentStories = [];
  for (const key of SLOT_KEYS) {
    const sid = slotPtr[key] && slotPtr[key].story_id;
    if (!sid) continue;
    const doc = await db.collection('stories').doc(sid).get();
    if (doc.exists) slotCurrentStories.push({ story_id: sid, ...doc.data(), fromSlot: key });
  }

  console.log(`완결 이야기 ${completedStories.length}건, 진행 중 인기작 후보 ${hotStories.length}건, 역할 슬롯 현재작 ${slotCurrentStories.length}건 발견`);
  const stories = [...completedStories, ...hotStories, ...slotCurrentStories];

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
      // 완결작뿐 아니라 진행 중 인기작에도 동일하게 적용되는 최소 게이트 —
      // 실제 참여자가 채택한 문장이 최소 1개는 있어야 다른 페이지와 구별되는
      // 고유 콘텐츠가 생김("짧으면 저품질"이 아니라 "서로 구별 안 되면
      // 저품질"이라는 기준, 2026-08-20 설계 논의 결론).
      if (!subs.length) { console.error(`스킵(채택 문장 없음): ${story.story_id}`); continue; }
      const lines = subs.map(s => s.content);

      const lastmod = closedEps.reduce((max, e) => (e.closed_at && e.closed_at > max ? e.closed_at : max), '');
      const title = story.opening.length > 40 ? story.opening.slice(0, 40) + '…' : story.opening;
      const description = (lines[0] || '').length > 80 ? lines[0].slice(0, 80) + '…' : (lines[0] || '화씨.방에서 함께 완성한 이야기');
      const url = `${SITE_ORIGIN}/bang/story/${story.story_id}/`;

      const participantCount = new Set(subs.map(s => s.author_id).filter(_isRealAuthor)).size;
      const isCompleted = story.isCompleted === true;

      processed.push({
        id: story.story_id, lastmod, title, description, url, isCompleted,
        opening: story.opening, lines,
        creatorNickname: story.creator_nickname,
        // sectionKey: 이 완결작이 어느 역할 슬롯 출신인지("직전 완결본" 찾기용).
        // fromSlot: 이 story가 지금 그 슬롯의 현재(진행 중) 대상인지(today
        // 페이지의 "현재 진행 중" 링크 대상 찾기용) — 완결작은 항상 undefined.
        sectionKey: classifySection(story),
        fromSlot: story.fromSlot,
        meta: {
          participantCount,
          sentenceCount: lines.length,
          days: _daysBetween(story.created_at, lastmod),
          isCompleted,
        },
        candidates: pickRejectedCandidates(subs, submissions, 4),
      });
    } catch (e) {
      console.error(`이야기 처리 실패(${story.story_id}):`, e.message);
    }
  }

  // 최신순으로 정렬 — 아카이브 목록과 "관련 작품" 선정 둘 다 이 순서를 기준으로 씀
  processed.sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || ''));

  // 서로 다른 완결작 두 편이 우연히 같은 오프닝 문장으로 시작하면 title이
  // (개설 초기 시절 같은 예시 씨앗 문장이 여러 번 쓰였던 경우 등) 완전히
  // 동일해짐 — verify-static-stories.js의 title 중복 검사가 정확히 이걸
  // 잡아내서 배포 자체를 막은 실제 사고(2026-08-18, 완결작 31개 중 3쌍
  // 발견). description(첫 채택 문장)도 이론상 같은 문제가 가능해서 함께
  // 방어. 흔치 않은 경우에만 최소 개입: 두 번째 등장부터 완결일을 붙여
  // 구분하고, 그마저 겹치면(극단적으로 드묾) 순번까지 추가.
  function _dedupe(items, field) {
    const count = new Map();
    const used = new Set();
    for (const item of items) {
      const base = item[field];
      const n = (count.get(base) || 0) + 1;
      count.set(base, n);
      if (n > 1) {
        const d = item.lastmod ? new Date(item.lastmod) : null;
        const suffix = item.isCompleted ? '완결' : '갱신';
        let candidate = (d && !isNaN(d)) ? `${base} · ${d.getMonth() + 1}/${d.getDate()} ${suffix}` : `${base} (${n})`;
        if (used.has(candidate)) candidate = `${base} (${n})`;
        item[field] = candidate;
      }
      used.add(item[field]);
    }
  }
  _dedupe(processed, 'title');
  _dedupe(processed, 'description');

  // "다른 완결작" 관련 링크는 완결작 풀에서만 골라야 함 — 진행 중인 이야기를
  // "완결작"이라고 링크 걸면 거짓 정보가 됨(2026-08-20 설계 논의 결론). 진행
  // 중 페이지에도 이 링크는 그대로 붙음(완결작 아카이브 발견 경로가 하나 늘어남).
  const completedOnly = processed.filter(p => p.isCompleted);

  // 2차 패스: 관련 작품(완결작 풀에서 자기 다음 최신순 3편, 순환) 확정 후 실제 파일 생성
  const sitemapEntries = [];
  let ok = 0;
  for (let i = 0; i < processed.length; i++) {
    const item = processed[i];
    const related = [];
    const poolLen = completedOnly.length;
    const selfIdx = completedOnly.indexOf(item);
    const startK = selfIdx >= 0 ? selfIdx + 1 : 0;
    for (let k = 0; k < poolLen && related.length < 3; k++) {
      const candidate = completedOnly[(startK + k) % poolLen];
      if (candidate !== item) related.push(candidate);
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
    sitemapEntries.push({ id: item.id, lastmod: item.lastmod, title: item.title, description: item.description, isCompleted: item.isCompleted });
    ok++;
  }

  // 3차 패스: today/{slot} 역할 페이지 — 5개 슬롯 모두 항상 페이지가 존재함
  // (URL 안정성). current는 위에서 이미 만든 processed 항목 중 이 슬롯의
  // 현재 포인터 대상(게이트 통과 못 했으면 null), previous는 완결작 풀에서
  // 이 슬롯 출신 중 가장 최근 것. 둘 다 없으면(막 시작된 슬롯이고 이전
  // 완결본도 아직 없음) 구별되는 콘텐츠가 없다는 뜻이라 noindex.
  fs.rmSync(TODAY_OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(TODAY_OUT_DIR, { recursive: true });
  let todayIndexable = 0;
  const slotSummaries = [];
  for (const slotKey of SLOT_KEYS) {
    const current = processed.find(p => p.fromSlot === slotKey) || null;
    const previous = completedOnly.find(p => p.sectionKey === slotKey) || null;
    const indexable = !!(current || previous);
    if (indexable) todayIndexable++;
    slotSummaries.push({ slotKey, current, previous });

    const html = renderTodaySlotPage({ slotKey, current, previous, indexable });
    const dir = path.join(TODAY_OUT_DIR, SLOT_SLUG[slotKey]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);

    // noindex 페이지는 sitemap에 안 넣음(Google 가이드상 모순 신호라 권장 안 됨) —
    // 페이지 자체는 항상 존재하므로 URL이 깨지진 않고, 콘텐츠가 쌓이면 다음
    // cron 빌드에서 자동으로 indexable+sitemap 포함으로 전환됨.
    if (indexable) {
      sitemapEntries.push({ slotSlug: SLOT_SLUG[slotKey], lastmod: (current && current.lastmod) || (previous && previous.lastmod) || null });
    }
  }
  console.log(`역할 슬롯 페이지 ${SLOT_KEYS.length}건 생성(그중 indexable ${todayIndexable}건)`);

  // 4차: today 허브 — 5개 슬롯 다 있으니 항상 indexable(개별 슬롯이 noindex여도
  // 허브 자체는 "지금 이런 게 진행 중"이라는 요약이라 별개로 유효).
  fs.writeFileSync(TODAY_HUB_PATH, renderTodayHubPage(slotSummaries));

  // 3차: 세 단어 챌린지 — 마감분만, 후보는 상위 5개만(fetchWordChallengeTopSubmissions).
  fs.rmSync(WORD_CHALLENGE_OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORD_CHALLENGE_OUT_DIR, { recursive: true });
  const closedChallenges = await fetchClosedWordChallenges(db);
  const wcEntries = [];
  for (const challenge of closedChallenges) {
    try {
      const candidates = await fetchWordChallengeTopSubmissions(db, challenge.challenge_id);
      const html = renderWordChallengePage({ challenge, candidates });
      const dir = path.join(WORD_CHALLENGE_OUT_DIR, challenge.challenge_id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html);
      sitemapEntries.push({ wcId: challenge.challenge_id, lastmod: challenge.closed_at || challenge.start_at || null });
      wcEntries.push({ challenge, candidates });
    } catch (e) {
      console.error(`세 단어 챌린지 처리 실패(${challenge.challenge_id}):`, e.message);
    }
  }
  const wcIndexable = wcEntries.length > 0;
  fs.writeFileSync(path.join(WORD_CHALLENGE_OUT_DIR, 'index.html'), renderWordChallengeArchive(wcEntries, wcIndexable));
  console.log(`세 단어 챌린지 결과 페이지 ${wcEntries.length}건 생성`);

  const extraStaticPages = [
    { loc: `${SITE_ORIGIN}/bang/today/`, changefreq: 'daily', priority: '0.8' },
    ...(wcIndexable ? [{ loc: `${SITE_ORIGIN}/bang/word-challenge/`, changefreq: 'daily', priority: '0.6' }] : []),
  ];
  fs.writeFileSync(SITEMAP_PATH, renderSitemap(sitemapEntries, extraStaticPages));
  // 아카이브 목록/루트 미리보기는 "완결된 이야기 모음"이라는 페이지 자체의
  // 정체성 때문에 완결작만 — 진행 중 인기작은 sitemap.xml과 각자 페이지의
  // "다른 완결작" 링크로는 발견되지만 이 두 곳엔 안 실림.
  const completedSitemapEntries = sitemapEntries.filter(e => e.isCompleted);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), renderArchiveIndex(completedSitemapEntries));
  console.log(`정적 페이지 ${ok}/${stories.length}건 생성 완료(완결 ${completedSitemapEntries.length}건, 그 외 진행중/역할슬롯/챌린지 ${sitemapEntries.length - completedSitemapEntries.length}건), 아카이브 목록·sitemap.xml 갱신됨`);

  const ROOT_PREVIEW_COUNT = 15;
  const rootHtmlSrc = fs.readFileSync(ROOT_INDEX_HTML_PATH, 'utf8');
  const MARKER = '<!-- STORY_ARCHIVE_PLACEHOLDER -->';
  if (!rootHtmlSrc.includes(MARKER)) {
    throw new Error('루트 index.html에서 STORY_ARCHIVE_PLACEHOLDER 마커를 못 찾음 — index.html 구조가 바뀌었을 수 있음');
  }
  const rootPreviewHtml = renderRootArchivePreview(completedSitemapEntries.slice(0, ROOT_PREVIEW_COUNT));
  fs.writeFileSync(ROOT_INDEX_HTML_PATH, rootHtmlSrc.replace(MARKER, rootPreviewHtml));
  console.log(`루트 페이지(index.html)에 완결작 미리보기 ${Math.min(ROOT_PREVIEW_COUNT, completedSitemapEntries.length)}편 삽입 완료`);
}

module.exports = {
  getEpisodeTree, buildCanonicalPath, collectLines, collectSubs, pickRejectedCandidates,
  proseHtml, storyMetaHtml, candidatesHtml, relatedStoriesHtml, storyPageBodyHtml,
  renderStoryPage, renderSitemap, renderArchiveIndex, renderRootArchivePreview, esc,
  classifySection, todaySlotBodyHtml, renderTodaySlotPage,
  renderTodayHubPage, renderWordChallengePage, renderWordChallengeArchive,
  SLOT_KEYS, SLOT_SLUG, SLOT_LABEL,
};

if (require.main === module) {
  main().catch(e => {
    console.error('SSG 빌드 실패:', e);
    process.exit(1);
  });
}
