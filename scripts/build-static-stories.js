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
const { cutRule, styleBlock } = require('./lib/extract-ko-css.js');

const ROOT = path.join(__dirname, '..');
const BANG_DIR = path.join(ROOT, 'bang');
const INDEX_HTML_PATH = path.join(BANG_DIR, 'index.html');
const ROOT_INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const OUT_DIR = path.join(BANG_DIR, 'story');
// 이번 빌드가 "시도한" story 목록과 "왜 안 만들어졌는지"를 verify-static-stories.js가
// 대조할 수 있게 남기는 사이드카(운영 산출물 아님, deploy.yml이 배포 전 제거).
// 라이브 대비 전체 개수 급감(verifyNoMassRegression)은 몇 개가 조용히 사라지는
// 걸 못 잡는 보조 경보라, 이 매니페스트로 "예정 vs 실제"를 ID 단위로 맞춘다.
const BUILD_MANIFEST_PATH = path.join(ROOT, '.story-build-manifest.json');
const TODAY_OUT_DIR = path.join(BANG_DIR, 'today');
const TODAY_HUB_PATH = path.join(TODAY_OUT_DIR, 'index.html');
const WORD_CHALLENGE_OUT_DIR = path.join(BANG_DIR, 'word-challenge');
const DIARY_OUT_DIR = path.join(BANG_DIR, 'diary');
const DIARY_HUB_PATH = path.join(DIARY_OUT_DIR, 'index.html');
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

// 분기 작품의 상속 문장(부모 이야기의 "갈린 지점까지 + 갈린 지점 자체") 조립.
// bang/index.html의 _buildForkPath·firebase-api.js의 parent_chain 조립을 통째로
// 복제하지 않고, 그중 신뢰도가 가장 높은 0순위 경로(서버가 이미 계산해 Firestore
// story 문서에 저장해 둔 branch_sub_id + branch_episode_id)만 기존 SSG 순수
// 함수(getEpisodeTree/buildCanonicalPath/collectSubs — 위 세 함수, 앱 원본과
// 동일 로직)로 재현한다. 나머지(구형 데이터의 역산 1~2순위, 연장 이야기, 다단계
// 분기의 조부모 상속)는 앱도 매 상황 재계산하는 fragile한 로직이라 새로 복제하지
// 않고, 그런 상황이면 ok:false를 반환해 "불완전한 본문을 발행하지 않는다"는
// 원칙대로 호출부가 V2 발행을 건너뛰고 기존 renderStoryPage로 폴백하게 한다.
//
// story: processed 항목(또는 원본 Firestore 문서) — parent_story_id, branch_from_step,
//   branch_sub_id, branch_episode_id, is_continuation 필드 필요.
// parentEpisodes/parentSubmissions: fetchStoryData(db, parent_story_id)로 얻은 원본(전체,
//   status 무관) — 이 함수 안에서 closed만 걸러 쓴다.
function computeBranchInheritance(story, parentEpisodes, parentSubmissions) {
  // 손상된 데이터(예: parent_sub_id가 순환하는 에피소드 그래프)를 만나면
  // getEpisodeTree의 재귀 순회가 "Maximum call stack size exceeded"로 죽을 수
  // 있음을 실제로 재현 확인(2026-09-12, 테스트 fixture). 이건 assertV2ShellOk
  // 이전 단계라 미포착 예외로 새면 호출부(main() 1차 패스)의 catch가 잡아
  // skipped(kind:'exception')로 기록하긴 하지만, 이 함수 스스로도 예외를
  // ok:false로 변환해 두면 어디서 호출되든("불완전 발행 금지" 원칙과 맞게)
  // 안전하게 폴백된다.
  try {
    return _computeBranchInheritanceInner(story, parentEpisodes, parentSubmissions);
  } catch (e) {
    return { ok: false, reason: `예외 발생(데이터 손상 의심 — 순환 참조 등): ${e.message}` };
  }
}

function _computeBranchInheritanceInner(story, parentEpisodes, parentSubmissions) {
  if (!story.parentStoryId) return { ok: true, before: [], tie: [] }; // 원본작 — 상속 없음
  if (story.isContinuation) {
    return { ok: false, reason: '연장(is_continuation) 이야기는 fork 지점 개념이 달라 별도 로직 필요 — 이번 범위 아님' };
  }
  if (!story.branchFromStep) return { ok: false, reason: 'branch_from_step 없음(분기 판정 불가)' };
  if (!story.branchSubId || !story.branchEpisodeId) {
    return { ok: false, reason: '서버 계산값(branch_sub_id/branch_episode_id)이 story 문서에 없음 — 역산 로직은 포팅하지 않음' };
  }
  const parentClosed = (parentEpisodes || []).filter(e => e.status === 'closed');
  if (!parentClosed.length) return { ok: false, reason: '부모의 closed 에피소드가 없음' };
  const tieEp = parentClosed.find(e => e.episode_id === story.branchEpisodeId);
  if (!tieEp) return { ok: false, reason: 'branch_episode_id가 부모의 closed 에피소드 목록에 없음' };

  const canonical = buildCanonicalPath(parentClosed, parentSubmissions);
  const forkPath = { ...canonical, [story.branchEpisodeId]: story.branchSubId };

  const beforeEps = parentClosed.filter(e => e.episode_id !== story.branchEpisodeId);
  const beforeTree = beforeEps.length ? getEpisodeTree(beforeEps, parentSubmissions, forkPath) : null;
  if (beforeEps.length && !beforeTree) return { ok: false, reason: 'beforeTree(갈리기 전 공통 구간) 조립 실패' };
  const tieTree = getEpisodeTree([tieEp], parentSubmissions, forkPath);
  if (!tieTree) return { ok: false, reason: 'tieTree(갈린 지점) 조립 실패' };

  const beforeSubs = beforeTree ? collectSubs(beforeTree, forkPath) : [];
  const tieSubs = collectSubs(tieTree, forkPath);
  if (!tieSubs.length) return { ok: false, reason: '갈린 지점(tie)에서 이 갈래의 채택 문장을 못 찾음' };
  // getEpisodeTree/collectSubs는 pinnedSubId(branch_sub_id)가 그 에피소드의 실제
  // 제출물 중에 없으면(예: story 문서의 branch_sub_id가 잘못됐거나 삭제된 sub를
  // 가리킴) 조용히 adoptedSubs[0](다른 문장, 보통 canonical A갈래)로 fallback해
  // 버린다 — 이 상태로 ok:true를 반환하면 "이 갈래의 실제 채택 문장이 아닌 다른
  // 문장"을 상속으로 발행하게 되므로, tie에서 뽑힌 sub_id가 정확히 story가
  // 지정한 branch_sub_id인지 반드시 재확인한다(2026-09-12, Codex final 지적).
  const tieSub = tieSubs[tieSubs.length - 1];
  if (!tieSub || tieSub.sub_id !== story.branchSubId) {
    return { ok: false, reason: `branch_sub_id(${story.branchSubId})가 갈린 지점의 실제 제출물이 아님 — 다른 문장으로 fallback될 뻔함(실제 선택된 sub_id: ${tieSub && tieSub.sub_id})` };
  }

  return { ok: true, before: beforeSubs.map(s => s.content), tie: tieSubs.map(s => s.content) };
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
//
// ⚠️ 2026-09-06: 원래 limit=40(가장 최근 마감 40개)이었는데, 매일 새 챌린지가
// 마감될 때마다 40개 창이 밀려나면서 오래된 페이지가 다음 빌드에서 통째로
// 삭제돼 — 이미 구글이 색인해둔 URL이 나중에 404로 바뀌는 진짜 회귀가
// 있었음(서치콘솔 "찾을 수 없음" 10건으로 발견). 완결작·영어 아카이브는
// 전부 무제한 보관인데 이것만 롤링 캡이 걸려있던 게 불일치였던 것 —
// 캡 제거하고 마감분 전부 영구 보관으로 통일.
async function fetchClosedWordChallenges(db, limit = null) {
  let q = db.collection('word_challenges').orderBy('start_at', 'desc');
  if (limit) q = q.limit(limit);
  const snap = await q.get();
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

// 훔쳐본 일기장 — functions/index.js에 서버 전용 상수(DIARY_STORY_DATA)로만
// 있고 Firestore엔 없음(2026-08-19 보안방: 공개일 도래 전 회차가 클라이언트
// 번들에 실려 미리 새던 문제 수정, [[project_hwasee_speedrun_participant_count_bug]]와
// 같은 세션에서 다룬 것과 별개 이슈). 그래서 admin SDK로 못 읽고, 이미 배포된
// getDiaryBook 콜러블을 그대로 호출 — 이게 유일한 공개일 게이트 소스(book_id별
// DIARY_RELEASE_DATES 비교)라, 여기서 날짜 로직을 다시 베끼면 두 곳이 어긋날
// 위험이 생김(word-challenge winners 필드명 사고와 같은 종류의 실수를 막으려는
// 설계). 로그인 불필요 콜러블이라 인증 없이 그대로 POST.
const DIARY_FUNCTION_URL = 'https://asia-northeast3-hwasee-bang.cloudfunctions.net/getDiaryBook';
// 총 권수 — DIARY_RELEASE_DATES(functions/index.js)/DIARY_HUB_BOOKS(bang/index.html)에
// 책이 추가되면 여기도 같이 늘려야 함(이미 있던 3-파일 동기화 관행과 동일).
const DIARY_BOOK_COUNT = 7;

async function fetchPublicDiaryBook(book_id) {
  try {
    const res = await fetch(DIARY_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { book_id } }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json.result || {};
    return result.ok ? result.book : null; // 공개 전이면 ok:false(locked:true)로 옴 — 그대로 제외
  } catch (e) {
    console.error(`훔쳐본 일기장 ${book_id}권 조회 실패:`, e.message);
    return null;
  }
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

// ─────────────────────────────────────────────────────────────────────────
// renderStoryPageV2 — 독립 독서 페이지 (AdSense 재심 대응, 2026-09-10 시범)
//
// 현재 renderStoryPage는 bang/index.html(앱 전체 ~600KB)을 복제하고 <main id=app>만
// 치환한다. 그 결과 앱 JS가 로드되면 story()가 #app을 통째로 다시 그리며 정적
// 본문을 지우고 getStory API에 의존한다(API 실패 시 본문이 에러로 대체됨).
//
// V2는 word-challenge/diary 페이지처럼 앱을 복제하지 않는 독립 셸이다. 제목·본문·
// 작품 간 이동이 JS/Firebase 없이 완성되고, 참여 기능은 없애지 않고 기존 앱의
// 해당 작품으로 링크한다. 적용은 V2_STORY_IDS(완결작 기본 포함 + 명시적 제외,
// computeV2TargetIds) 대상에만 — 그 집합이 비면 전체 기존 renderStoryPage로 롤백.
//
// CSS는 손으로 옮겨 적지 않고 bang/index.html의 <style>에서 잘라온다(EN 페이지의
// ko-shared.css와 같은 원칙, extract-ko-css.js의 cutRule 재사용).

// 적용 대상 규칙의 유일한 원천은 scripts/lib/v2-reader-ids.js(computeV2TargetIds —
// "완결작 기본 포함 + 명시적 제외", 2026-09-13 4번 확대). completedStories 1차 패스
// (processed)가 확정된 뒤에야 대상 집합을 계산할 수 있어서, V2_TARGET_IDS/V2_STORY_IDS는
// main() 안에서 processed 직후에 지역 변수로 계산한다(아래 "V2 대상 계산" 참고).
// main() 끝에서 **이번 빌드에 실제 생성·검증된 ID만** bang/index.html의 _V2_READER_IDS
// 마커에 주입한다(수동 동기화 목록 없음). 분기 작품 상속 조립 실패(ok:false)나
// V2_EXCLUDED_IDS 등록으로 대상이 0개가 되면 전체 기존 renderStoryPage로 자동 복귀.
const { V2_EXCLUDED_IDS, computeV2TargetIds, V2_READER_IDS_DECL_RE, buildV2ReaderIdsDecl } = require('./lib/v2-reader-ids.js');

// 이번 빌드에서 실제로 V2 셸 생성·검증에 성공한 작품 ID(순서 유지). main()의
// 2차 패스가 채우고, 그 뒤 injectV2ReaderIds가 이 값으로 앱 마커를 치환한다.
const _v2GeneratedIds = [];

// 생성된 V2 HTML이 실제로 독립 셸인지 최소 검증 — 하나라도 실패하면 빌드 실패.
function assertV2ShellOk(id, html) {
  const problems = [];
  if (!/<h1 class="reader-title">[^<]/.test(html)) problems.push('reader-title 없음/비어있음');
  if (html.includes('<main id="app">')) problems.push('앱 셸(<main id="app">) 잔존');
  if (!/<div class="story-prose">[\s\S]*?<span class="prose-sentence">/.test(html)) problems.push('본문(.prose-sentence) 없음');
  if (!/<meta name="robots" content="index,follow">/.test(html)) problems.push('robots index,follow 없음');
  if (!new RegExp(`<link rel="canonical" href="https://[^"]*/bang/story/${id}/">`).test(html)) problems.push('canonical 불일치');
  if (problems.length) throw new Error(`V2 생성 검증 실패(${id}): ${problems.join(', ')}`);
}

// 이번 빌드에 실제 생성된 V2 ID로 bang/index.html의 _V2_READER_IDS 선언을 치환한다.
// bang/index.html은 원본 겸 배포 산출물(별도 산출물 디렉토리가 없는 현재 구조) —
// 루트 index.html의 미리보기 MARKER 치환과 같은 방식이다. 커밋본의 값은 사람이
// 읽을 기본값일 뿐이고, 배포 직전 이 함수가 실제값으로 덮어쓴다.
function injectV2ReaderIds(generatedIds) {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const matches = src.match(V2_READER_IDS_DECL_RE) || [];
  if (matches.length === 0) throw new Error('bang/index.html에서 _V2_READER_IDS 선언(주입 마커)을 못 찾음');
  if (matches.length > 1) throw new Error(`bang/index.html에 _V2_READER_IDS 선언이 ${matches.length}개 — 마커 중복`);
  const decl = buildV2ReaderIdsDecl(generatedIds);
  fs.writeFileSync(INDEX_HTML_PATH, src.replace(V2_READER_IDS_DECL_RE, () => decl));
  console.log(`_V2_READER_IDS 주입: ${generatedIds.length}편 [${generatedIds.join(', ')}]`);
}

// 독서 페이지에 필요한 CSS 규칙만 bang/index.html <style>에서 잘라온다.
// 셀렉터가 사라지면(구조 변경) 조용히 빠지지 않게 못 찾은 건 목록으로 모아
// 호출부에서 throw 한다.
const _READER_CSS_SELECTORS = [
  ':root', '*', 'body',
  '.story-prose', '.prose-opening', '.prose-line', '.prose-sentence',
  '.prose-divider', '.prose-divider::before, .prose-divider::after',
  '.prose-inherited', '.prose-inherited.prose-inherited-continuation',
  '.step-pill', '.step-dot',
  '.badge',
  '.badge-seed', '.badge-seed1', '.badge-seed2',
  '.badge-sprout', '.badge-sprout1', '.badge-sprout2',
  '.badge-leaf', '.badge-leaf1', '.badge-leaf2',
  '.badge-bud', '.badge-flower', '.badge-flower1',
  '.badge-fruit', '.badge-treeguard',
];
let _readerCssCache = null;
function readerCss(indexHtmlSrc) {
  if (_readerCssCache) return _readerCssCache;
  const css = styleBlock(indexHtmlSrc).replace(/\r\n/g, '\n');
  const parts = [];
  const missing = [];
  for (const sel of _READER_CSS_SELECTORS) {
    const found = cutRule(css, sel);
    if (!found.length) { missing.push(sel); continue; }
    parts.push(found.join('\n'));
  }
  if (missing.length) {
    throw new Error(`renderStoryPageV2: bang/index.html에서 CSS 규칙을 못 찾음 — ${missing.join(', ')} (구조가 바뀌었을 수 있음)`);
  }
  // 독서 페이지 전용 보강 — 앱에서는 JS가 채우던 것들의 정적 대체.
  parts.push(`
  body { max-width: 680px; margin: 0 auto; padding: 0 16px 64px; }
  .reader-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid var(--border); margin-bottom: 24px; font-size: 13px; }
  .reader-header a { color: var(--muted); text-decoration: none; }
  .reader-logo { font-family: var(--serif); font-size: 18px; color: var(--text); }
  h1.reader-title { font-family: var(--serif); font-size: 23px; font-weight: 700; line-height: 1.4; margin: 8px 0 4px; color: var(--text); }
  .reader-byline { font-size: 12px; color: var(--muted); margin-bottom: 20px; }
  .reader-theend { text-align: center; font-family: var(--serif); font-size: 15px; color: var(--muted); letter-spacing: 3px; margin: 20px 0 0; }
  .reader-nav { display: flex; gap: 10px; margin: 28px 0 0; }
  .reader-nav a { flex: 1; text-align: center; padding: 12px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; text-decoration: none; color: var(--text); font-size: 13px; }
  .reader-nav a.disabled { opacity: .45; pointer-events: none; }
  .reader-participate { display: block; margin: 24px 0 0; padding: 14px 18px; background: var(--accent2); color: #fff; border-radius: 10px; text-decoration: none; font-size: 14px; font-weight: 600; text-align: center; }
  .reader-share { display: flex; gap: 8px; margin: 16px 0 0; }
  .reader-share button { flex: 1; padding: 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; font-size: 13px; color: var(--text); cursor: pointer; font-family: inherit; }
  .reader-footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); text-align: center; }
  .reader-footer a { color: var(--muted); }
  .prose-inherited { opacity: .55; }
  `);
  _readerCssCache = parts.join('\n');
  return _readerCssCache;
}

// 상속(부모 갈래) 문장 + 이 갈래 문장을 하나의 산문 블록으로. 분기 아니면 inherited는 빈 배열.
function readerProseHtml(opening, inheritedLines, lines) {
  const inheritedHtml = (inheritedLines || []).map(l =>
    `<div class="prose-line"><span class="prose-sentence">${esc(l)}</span></div>`).join('\n      ');
  const dividerHtml = (inheritedLines && inheritedLines.length)
    ? `<div class="prose-divider">여기서 이야기가 갈라졌어요</div>` : '';
  const lineHtml = lines.map(l =>
    `<div class="prose-line"><span class="prose-sentence">${esc(l)}</span></div>`).join('\n      ');
  return `<div class="story-prose">
      <div class="prose-opening">${esc(opening)}</div>
      ${inheritedHtml ? `<div class="prose-inherited">${inheritedHtml}</div>${dividerHtml}` : ''}
      ${lineHtml}
    </div>`;
}

function renderStoryPageV2(opts) {
  const {
    indexHtmlSrc, id, storyTitle, description, url, opening, creatorNickname,
    inheritedLines, lines, meta, candidates, related, isCompleted, lastmod,
    hasEn, prevEntry, nextEntry, parentTitle, parentStoryId,
  } = opts;
  const displayTitle = (storyTitle && storyTitle.trim())
    || (opening.length > 30 ? opening.slice(0, 30) + '…' : opening);
  const koUrl = url;
  const enUrl = `${SITE_ORIGIN}/bang/en/story/${id}/`;

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'CreativeWork',
    headline: displayTitle, description,
    author: { '@type': 'Person', name: creatorNickname || '익명' },
    datePublished: lastmod || undefined,
    publisher: { '@type': 'Organization', name: '화씨 (Hwasee)', url: SITE_ORIGIN },
    url, inLanguage: 'ko',
  }, null, 2).replace(/</g, '\\u003c');

  const hreflang = hasEn
    ? `<link rel="alternate" hreflang="ko" href="${koUrl}">\n`
      + `<link rel="alternate" hreflang="en" href="${enUrl}">\n`
      + `<link rel="alternate" hreflang="x-default" href="${koUrl}">\n`
    : '';

  const prevLink = prevEntry
    ? `<a href="/bang/story/${prevEntry.id}/">← 이전 완결작</a>`
    : `<a class="disabled">← 이전 완결작</a>`;
  const nextLink = nextEntry
    ? `<a href="/bang/story/${nextEntry.id}/">다음 완결작 →</a>`
    : `<a class="disabled">다음 완결작 →</a>`;

  const body = `<div class="reader-header">
    <a class="reader-logo" href="/bang/">화씨.방</a>
    <a href="/bang/story/">← 완결작 모음</a>
  </div>
  <main>
    <h1 class="reader-title">${esc(displayTitle)}</h1>
    <div class="reader-byline">${esc(creatorNickname || '익명')}님의 씨앗 문장에서 시작 · 여러 사람이 한 문장씩 이어 씀</div>
    ${parentStoryId ? `<p style="font-size:12.5px;color:var(--muted);margin-bottom:14px;padding:10px 12px;background:var(--surface);border-radius:8px">⑂ 이 이야기는 <a href="/bang/story/${parentStoryId}/" style="color:var(--accent2);font-weight:600">${esc(parentTitle || '원본 이야기')}</a>에서 갈라져 나온 결말이에요. 처음부터 읽으려면 원본 이야기로 가세요.</p>` : ''}
    ${readerProseHtml(opening, inheritedLines, lines)}
    ${isCompleted ? `<p class="reader-theend">· 完 ·</p>` : ''}
    ${storyMetaHtml(meta)}
    ${candidatesHtml(candidates)}
    ${relatedStoriesHtml(related || [])}
    <div class="reader-nav">${prevLink}${nextLink}</div>
    <a class="reader-participate" href="/bang/story/${id}/?write=1">이 작품에 참여하기 (화씨.방 앱)</a>
    <div class="reader-share">
      <label style="flex:1;display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)">이 작품 링크
        <input id="reader-url" type="text" readonly value="${url}" onclick="this.select()"
          style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12px;color:var(--text)">
      </label>
      <button id="reader-copy" type="button" style="align-self:flex-end">링크 복사</button>
      ${hasEn ? `<a href="${enUrl}" style="align-self:flex-end;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:10px;font-size:13px;color:var(--text);text-decoration:none">Read in English</a>` : ''}
    </div>
  </main>
  <div class="reader-footer">
    <a href="https://hwasee.me/">화씨 홈</a> · <a href="/bang/">화씨.방</a> · <a href="/bang/story/">완결작 모음</a> · <a href="/bang/guidelines.html">가이드라인</a> · <a href="/bang/privacy.html">개인정보처리방침</a>
    <p style="margin-top:8px">&copy; 2026 화씨 (Hwasee). All rights reserved.</p>
  </div>`;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(displayTitle)} — 화씨.방</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${url}">
${hreflang}<link rel="icon" type="image/png" href="/bang/hwaseebang_sum.png">
<meta name="theme-color" content="#f0ead8">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(displayTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="https://hwasee.me/bang/hwaseebang_og.png">
<meta property="og:locale" content="ko_KR">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&family=Noto+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${readerCss(indexHtmlSrc)}
</style>
<script type="application/ld+json">
${jsonLd}
</script>
</head>
<body>
${body}
<script>
// 이 페이지는 서버 조회 없이 읽는 독립 독서 페이지다. 아래 JS는 "있으면 편한"
// 것들뿐이고, 꺼도 제목·본문·이동 링크·URL 확인(입력창 클릭 선택)은 그대로 된다.
(function () {
  // (1) 참여 진입: "참여하기"는 /bang/story/{id}/?write=1 로 온다. 그 정적 URL을
  // 그대로 두면 앱이 없어 참여를 못 하므로, 앱 홈의 해시 라우트로 한 번 넘긴다
  // (앱이 #story/{id} 를 story 라우트로 전환 — bang/index.html 레거시 해시 처리).
  // ?write=1 이 없으면(그냥 이 페이지를 새로고침) 아무 일도 안 한다 = 왕복 없음.
  try {
    if (new URLSearchParams(location.search).get('write')) {
      location.replace('/bang/#story/' + ${JSON.stringify(id)});
      return;
    }
  } catch (e) {}
  // (2) 링크 복사: clipboard API 있으면 버튼으로, 없으면 입력창 클릭→선택으로 대체.
  var btn = document.getElementById('reader-copy');
  var input = document.getElementById('reader-url');
  if (btn && input) {
    btn.addEventListener('click', function () {
      var done = function () { btn.textContent = '복사됨'; setTimeout(function () { btn.textContent = '링크 복사'; }, 1500); };
      var fail = function () { input.focus(); input.select(); btn.textContent = '직접 복사하세요'; setTimeout(function () { btn.textContent = '링크 복사'; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(done, fail);
      } else {
        input.focus(); input.select();
        try { document.execCommand('copy') ? done() : fail(); } catch (e) { fail(); }
      }
    });
  }
})();
</script>
</body>
</html>
`;
}

// English 에디션 — 영어판이 실제로 발행된 완결작 id 집합. build-en-pages.js가
// 먼저 돌면서 남긴 .en-manifest.json에서 읽는다. 양쪽 빌드가 같은 판정을 써야
// 한쪽만 상대를 가리키는 일방향 hreflang이 생기지 않는다. manifest가 없으면
// (영어 빌드 미실행/실패) 빈 집합이라 hreflang을 전혀 붙이지 않고 기존 동작 그대로 간다.
function loadEnPublishedIds() {
  const p = path.join(ROOT, '.en-manifest.json');
  if (!fs.existsSync(p)) return new Set();
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (m.build_completed !== true) return new Set();
    return new Set(m.publishable_ids || []);
  } catch (e) {
    console.error('.en-manifest.json 파싱 실패 — hreflang 없이 진행:', e.message);
    return new Set();
  }
}
const EN_PUBLISHED_IDS = loadEnPublishedIds();

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

  // 영어판이 실제로 발행된 완결작에만 상호 hreflang을 붙인다. canonical은 양쪽 다
  // 자기 자신을 유지해서(위에서 이미 자기 URL로 바꿨다) 한국어 원본과 영어판이
  // 중복 콘텐츠로 묶이지 않게 하고, hreflang으로만 서로를 언어 대체본이라고 알린다.
  // 위 canonicalMatch 하드체크가 실패하면 여기 오기 전에 throw되므로, 태그 구조가
  // 바뀌었을 때 이 주입이 조용히 누락되지 않는다.
  if (EN_PUBLISHED_IDS.has(id)) {
    const enUrl = `${SITE_ORIGIN}/bang/en/story/${id}/`;
    html = html.replace(
      `<link rel="canonical" href="${url}">`,
      `<link rel="canonical" href="${url}">
`
      + `<link rel="alternate" hreflang="ko" href="${url}">
`
      + `<link rel="alternate" hreflang="en" href="${enUrl}">
`
      + `<link rel="alternate" hreflang="x-default" href="${url}">`
    );
  }
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
      // 챌린지 개별 결과 페이지, diaryId가 있으면 훔쳐본 일기장 개별 회차,
      // 나머지는 story/{id} 콘텐츠 페이지.
      const loc = e.slotSlug ? `${SITE_ORIGIN}/bang/today/${e.slotSlug}/`
        : e.wcId ? `${SITE_ORIGIN}/bang/word-challenge/${e.wcId}/`
        : e.diaryId ? `${SITE_ORIGIN}/bang/diary/${e.diaryId}/`
        : `${SITE_ORIGIN}/bang/story/${e.id}/`;
      // 진행 중 이야기/역할 페이지는 문장이 계속 추가되므로 완결작(monthly)보다
      // 짧은 주기로 표시 — 실제 리빌드 주기는 별개(GitHub Actions 스케줄)지만,
      // changefreq는 크롤러에게 갱신 가능성을 알려주는 힌트라 정직하게 반영.
      // 세 단어 챌린지 개별 결과/일기장 개별 회차는 한 번 공개되면 내용이 다시
      // 안 바뀌어서 완결작과 동일하게 monthly.
      const changefreq = e.slotSlug ? 'daily' : (e.wcId || e.diaryId) ? 'monthly' : (e.isCompleted ? 'monthly' : 'daily');
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
  <a href="/bang/word-challenge/" style="color:var(--muted)">세 단어 챌린지 결과</a> &nbsp;·&nbsp;
  <a href="/bang/diary/" style="color:var(--muted)">훔쳐본 일기장</a>
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
  .diary-page p { font-family: var(--serif); font-size: 14.5px; line-height: 1.9; margin-bottom: 14px; }
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
  <a href="/bang/word-challenge/" style="color:var(--muted)">세 단어 챌린지 결과</a> &nbsp;·&nbsp;
  <a href="/bang/diary/" style="color:var(--muted)">훔쳐본 일기장</a>
  <p style="margin-top:8px">&copy; 2026 화씨 (Hwasee). All rights reserved.</p>
</footer>
</body>
</html>
`;
}

// /bang/today/ 허브 — 5개 역할 슬롯을 한 곳에 모아 링크(오늘의 이야기 각
// 슬롯 페이지가 sitemap에만 있고 실제 내부링크가 없으면 크롤러 발견 신뢰도가
// 낮아서, 2026-08-20 논의로 추가). hint(초성 퀴즈)는 정답이 콘텐츠라 원천적으로
// SSG 대상이 될 수 없어 안내 문구만 남김. diary(훔쳐본 일기장)는 2026-08-25에
// /bang/diary/ 전용 페이지가 생겨서 아래 링크가 그리로 감(story_id가 없는
// 별도 데이터 모델이라 story 파이프라인과는 독립적으로 처리 — renderDiaryHubPage 참고).
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
      <li>📔 훔쳐본 일기장 — 매주 수요일 새 이야기가 공개돼요. <a href="/bang/diary/">지난 회차 보기 →</a></li>
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
  // ⚠️ 2026-09-06: 단어 조합만으로 제목을 만들었더니, 마감분 40개 캡을 없앤
  // 뒤(위 fetchClosedWordChallenges 참고) 같은 세 단어가 다른 날 재사용된
  // 챌린지 2건("코끼리·와이파이·도자기", 7/13과 9/1)이 title 완전 동일로
  // CI 가드레일(verifyWordChallengePages)에 걸려 배포가 막힘 — 날짜를
  // 앞에 붙여 항상 유일하게 만듦(날짜+단어 조합은 challenge_id 자체가
  // 유일한 만큼 절대 안 겹침).
  const title = `${challenge.date || challenge.challenge_id} · ${(challenge.words || []).join('·')} — 세 단어 챌린지 우승작`;
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

// /bang/diary/{book_id}/ — 스포일러 없는 도입부(start 노드, 선택 갈리기 전)만
// 정적으로 공개. 전체 분기/모든 엔딩을 다 풀면 그건 크롤러만이 아니라 검색으로
// 우연히 들어온 일반 유저에게도 스포일러가 되고(정적 페이지는 앱과 달리 누구나
// 바로 도달 가능한 공개 URL), 인터랙티브하게 선택해가며 읽는 앱 본연의 재미도
// 없앰 — start 노드는 어떤 선택을 하든 모두가 보는 공통 도입부라 스포일러가 될
// 수 없음(2026-08-25 논의 결론).
function diaryTeaserBodyHtml({ book, book_id }) {
  const startNode = (book.nodes || {})[book.startNodeId] || {};
  const paragraphsHtml = (startNode.paragraphs || []).map(p => `<p>${esc(p)}</p>`).join('');
  // "이어 읽기"는 홈이 아니라 이 회차로 직접 연결한다(2026-09-12 수정 — 예전엔
  // /bang/로 보내 유저가 책장부터 다시 찾아야 했음). /bang/diary/{book_id}는 이
  // 정적 페이지 자신의 URL이라 그리로 링크하면 새로고침만 될 뿐 앱으로 못 가므로,
  // bang/index.html의 범용 레거시 해시 리다이렉트(#route/param → routeToPath로
  // 자동 전환, ?write=1 우회 없이도 diary가 _ROUTE_WHITELIST에 있어 이미 동작)를
  // 그대로 이용한다. 앱이 뜨면 diaryHub()가 currentParam으로 이 회차를 자동 오픈.
  return `<a class="back" href="/bang/diary/">← 훔쳐본 일기장 모음</a>
    <h1>${esc(book.title)}</h1>
    ${startNode.dateLabel ? `<div class="hub-item-meta">${esc(startNode.dateLabel)}</div>` : ''}
    <div class="diary-page">${paragraphsHtml}</div>
    <p class="lead" style="margin-top:20px">이야기는 여기서 갈라져요. 선택에 따라 결말이 달라집니다.</p>
    <a href="/bang/#diary/${book_id}" class="back-cta">화씨.방에서 이어 읽기 →</a>`;
}

function renderDiaryBookPage({ book_id, book }) {
  const url = `${SITE_ORIGIN}/bang/diary/${book_id}/`;
  const startNode = (book.nodes || {})[book.startNodeId] || {};
  const firstPara = (startNode.paragraphs || [])[0] || '';
  const description = `${firstPara.slice(0, 80)}${firstPara.length > 80 ? '…' : ''} — 훔쳐본 일기장 ${book_id}권 도입부.`;
  return staticHubPageShell({
    title: `${esc(book.title)} — 훔쳐본 일기장 — 화씨.방`,
    description, canonical: url, robots: 'index,follow',
    ogTitle: book.title,
    bodyHtml: diaryTeaserBodyHtml({ book, book_id }),
  });
}

// /bang/diary/ 허브 — 공개된 회차만 나열(release 게이트는 getDiaryBook이
// 이미 통과시킨 것만 여기 도착하므로 별도 필터 불필요).
function diaryHubBodyHtml(entries) {
  const items = entries.map(({ book_id, book }) => {
    const startNode = (book.nodes || {})[book.startNodeId] || {};
    const firstPara = (startNode.paragraphs || [])[0] || '';
    return `
    <a class="hub-item" href="/bang/diary/${book_id}/">
      <div class="hub-item-title">${esc(book.title)}</div>
      <div class="hub-item-teaser">${esc(firstPara.slice(0, 60))}${firstPara.length > 60 ? '…' : ''}</div>
    </a>`;
  }).join('');

  return `<h1>훔쳐본 일기장</h1>
    <p class="lead">다른 사람의 일기를 몰래 열어보는 읽기 전용 콘텐츠예요. 매주 수요일마다 새 회차가 한 편씩 공개돼요. 여기서는 공개된 회차의 도입부만 볼 수 있고, 선택에 따라 갈라지는 결말은 <a href="/bang/">화씨.방</a>에서 직접 읽을 수 있어요.</p>
    ${entries.length ? items : '<div class="empty">아직 공개된 회차가 없어요.</div>'}`;
}

function renderDiaryHubPage(entries, indexable) {
  const url = `${SITE_ORIGIN}/bang/diary/`;
  return staticHubPageShell({
    title: '훔쳐본 일기장 — 화씨.방',
    description: `화씨.방 훔쳐본 일기장 — 지금까지 공개된 회차 ${entries.length}편의 도입부를 모아봤어요.`,
    canonical: url, robots: indexable ? 'index,follow' : 'noindex,follow',
    bodyHtml: diaryHubBodyHtml(entries),
  });
}

// ── 메인 ──

async function main() {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다.');
  const svcJson = JSON.parse(serviceAccountRaw);
  admin.initializeApp({ credential: admin.credential.cert(svcJson) });
  const db = admin.firestore();

  let indexHtmlSrc = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

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
  // 왜 스킵됐는지 구조화해 남긴다 — 'gate'(의도된 최소 콘텐츠 기준, 정상 운영)와
  // 'exception'(예상 못 한 예외, 버그 의심)을 구분해야 verify가 "정상적인 소수
  // 누락"과 "빌드 결함으로 조용히 사라진 것"을 가려낼 수 있다(2026-09-12,
  // "50% 급감 감지는 몇 개 누락은 못 잡는 보조 경보"라는 지적 반영).
  const skipped = [];
  for (const story of stories) {
    try {
      const { episodes, submissions } = await fetchStoryData(db, story.story_id);
      const closedEps = episodes.filter(e => e.status === 'closed');
      const tree = getEpisodeTree(closedEps, submissions);
      if (!tree) {
        console.error(`스킵(마감된 에피소드 없음): ${story.story_id}`);
        skipped.push({ id: story.story_id, kind: 'gate', reason: '마감된 에피소드 없음' });
        continue;
      }

      const canonicalPath = buildCanonicalPath(closedEps, submissions);
      const subs = collectSubs(tree, canonicalPath);
      // 완결작뿐 아니라 진행 중 인기작에도 동일하게 적용되는 최소 게이트 —
      // 실제 참여자가 채택한 문장이 최소 1개는 있어야 다른 페이지와 구별되는
      // 고유 콘텐츠가 생김("짧으면 저품질"이 아니라 "서로 구별 안 되면
      // 저품질"이라는 기준, 2026-08-20 설계 논의 결론).
      if (!subs.length) {
        console.error(`스킵(채택 문장 없음): ${story.story_id}`);
        skipped.push({ id: story.story_id, kind: 'gate', reason: '채택 문장 없음' });
        continue;
      }
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
        // V2 독서 페이지용 — 실제 작품명(있으면), 책장 정렬 기준(completed_at
        // 우선, 없으면 created_at), 분기 관계. 기존 renderStoryPage는 안 씀.
        storyTitle: story.title || '',
        completedAt: story.completed_at || '',
        createdAt: story.created_at || '',
        mode: story.mode || null,
        parentStoryId: story.parent_story_id || null,
        branchEpisodeId: story.branch_episode_id || null,
        branchSubId: story.branch_sub_id || null,
        branchFromStep: story.branch_from_step || null,
        isContinuation: !!story.is_continuation,
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
      skipped.push({ id: story.story_id, kind: 'exception', reason: e.message });
    }
  }

  // 최신순 정렬 — 아카이브 목록·홈 미리보기·"관련 작품" 선정이 쓰는 기존 기준
  // (lastmod = 마지막 마감 시각). ⚠️ V2 이전/다음 링크를 앱 책장과 맞추려고
  // 이 정렬 자체를 completed_at 기준으로 바꿨다가, 아카이브/홈 순서까지 딸려
  // 바뀌는 의도치 않은 변경이라 되돌림(2026-09-10 사용자 지적). V2의 이전/다음은
  // 아래에서 별도로 책장과 같은 기준(completed_at || created_at)으로 계산한다.
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

  // V2 대상 계산 — "완결작 기본 포함 + 명시적 제외"(scripts/lib/v2-reader-ids.js).
  // processed가 확정된 뒤에야 계산 가능(mode/isCompleted가 이 배열에만 있음).
  const V2_TARGET_IDS = computeV2TargetIds(processed);
  const V2_STORY_IDS = new Set(V2_TARGET_IDS);
  console.log(`V2 목표 집합: 완결작 ${processed.filter(p => p.isCompleted).length}건 중 `
    + `${V2_TARGET_IDS.length}건(초스피드·명시적 제외 ${V2_EXCLUDED_IDS.size}건 제외분 반영)`);

  // "다른 완결작" 관련 링크는 완결작 풀에서만 골라야 함 — 진행 중인 이야기를
  // "완결작"이라고 링크 걸면 거짓 정보가 됨(2026-08-20 설계 논의 결론). 진행
  // 중 페이지에도 이 링크는 그대로 붙음(완결작 아카이브 발견 경로가 하나 늘어남).
  const completedOnly = processed.filter(p => p.isCompleted);

  // V2 "이전/다음 완결작"은 앱 완결작 책장 기본 정렬(_sortStories 'latest':
  // completed_at || created_at 내림차순, bang/index.html)과 같은 순서로 넘겨야
  // 한다. processed.sort는 아카이브/홈이 쓰는 lastmod 기준이라 별개로 정렬한
  // 사본을 둔다(2026-09-10). completed_at 없는 옛날 데이터는 _sortStories와
  // 동일하게 created_at으로 폴백.
  const completedByBookshelf = [...completedOnly].sort((a, b) =>
    new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0));

  // 검증 전용 사이드카(운영 배포엔 영향 없음): env가 있을 때만, 이번 빌드가
  // 실제로 본 완결작 데이터를 그대로 덤프한다. verify-reading-pages.yml의
  // summarize 단계가 이 데이터에 앱 _sortStories('latest') 기준을 독립적으로
  // 재적용해 V2 이전/다음 링크와 자동 대조한다(라이브 목록 육안 비교 대신).
  if (process.env.READING_PILOT_EXPECTED_OUT) {
    fs.writeFileSync(process.env.READING_PILOT_EXPECTED_OUT, JSON.stringify({
      generated_at: new Date().toISOString(),
      v2_ids: [...V2_STORY_IDS],
      completed: completedByBookshelf.map(p => ({
        id: p.id, completedAt: p.completedAt || '', createdAt: p.createdAt || '',
      })),
    }, null, 2));
  }

  // V2 분기 작품 상속 조립 — computeBranchInheritance(0순위만 지원)를 실제 빌드
  // 경로에 연결. 부모 조회 실패나 모호한 데이터(ok:false)면 "앞부분을 생략한
  // V2를 발행하지 않는다" 원칙대로 그 작품을 V2 대상에서 조용히 제외하고
  // 기존 renderStoryPage(+기존 URL)를 유지한다 — 이건 빌드 실패가 아니라
  // 의도된 폴백이라 v2FallbackIds로 별도 추적(아래 _v2Missing 검사에서 구분).
  const v2ParentTitleByStory = {};
  const v2InheritanceByStory = {}; // id -> { before, tie } (성공한 것만)
  const v2Fallback = []; // { id, reason } — 의도된 폴백(기존 렌더러 유지)
  for (const item of processed) {
    if (!V2_STORY_IDS.has(item.id) || !item.parentStoryId) continue;
    try {
      const parentDoc = await db.collection('stories').doc(item.parentStoryId).get();
      v2ParentTitleByStory[item.id] = (parentDoc.exists && parentDoc.data().title) || '원본 이야기';
    } catch (e) {
      console.error(`V2 분기 부모 제목 조회 실패(${item.id} ← ${item.parentStoryId}):`, e.message);
    }
    try {
      const { episodes: parentEpisodes, submissions: parentSubmissions } = await fetchStoryData(db, item.parentStoryId);
      const result = computeBranchInheritance(item, parentEpisodes, parentSubmissions);
      if (result.ok) {
        v2InheritanceByStory[item.id] = { before: result.before, tie: result.tie };
      } else {
        console.error(`V2 폴백(${item.id}, 기존 렌더러 유지): ${result.reason}`);
        v2Fallback.push({ id: item.id, reason: result.reason });
      }
    } catch (e) {
      console.error(`V2 폴백(${item.id}, 기존 렌더러 유지) — 부모 조회 예외: ${e.message}`);
      v2Fallback.push({ id: item.id, reason: `부모 조회 예외: ${e.message}` });
    }
  }
  const v2FallbackIds = new Set(v2Fallback.map(f => f.id));

  // "이번 빌드가 시도한 목록 vs 실제 성공한 목록 vs 스킵/폴백 사유"를 ID 단위로
  // 남긴다(운영 산출물 아님, deploy.yml이 배포 전 제거). 라이브 대비 전체 개수
  // 비교(verifyNoMassRegression)는 몇 개가 조용히 빠지는 걸 못 잡는 보조 경보이고,
  // 이 매니페스트가 본 방어선 — verify가 kind:'exception' 스킵이 하나라도 있으면
  // fail 처리한다(정상 게이트가 아닌 예외로 페이지가 안 만들어진 것이므로).
  // v2_fallback은 1차 패스는 통과했지만 분기 상속 조립 실패로 기존 렌더러로
  // 돌아간 것 — verify가 "V2 설정 대상인데 미생성"을 fail 처리할 때 이 목록에
  // 있으면 의도된 것으로 봐야 한다.
  fs.writeFileSync(BUILD_MANIFEST_PATH, JSON.stringify({
    generated_at: new Date().toISOString(),
    attempted_ids: stories.map(s => s.story_id),
    processed_ids: processed.map(p => p.id),
    skipped,
    v2_ids: V2_TARGET_IDS,
    v2_fallback: v2Fallback,
  }, null, 2));

  // V2 대상 중 이번 빌드 풀에 실제로 있고, 분기 상속 조립도 실패하지 않은 작품만
  // 이번에 발행할 계획. renderStoryPage가 클론하는 indexHtmlSrc의 _V2_READER_IDS를
  // 지금 이 값으로 맞춰서, 비-V2 완결작 페이지 안의 앱도 올바른 목록을 갖게 한다
  // (파일 쓰기는 2차 패스 뒤 injectV2ReaderIds가, 실제 생성 성공 목록으로). 둘이
  // 어긋나면(폴백이 아닌 진짜 누락이면) 2차 패스의 _v2Missing 검사가 빌드를 멈춘다.
  const _v2PlannedIds = V2_TARGET_IDS.filter(id => processed.some(p => p.id === id) && !v2FallbackIds.has(id));
  indexHtmlSrc = indexHtmlSrc.replace(V2_READER_IDS_DECL_RE, () => buildV2ReaderIdsDecl(_v2PlannedIds));

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

    const isV2Target = V2_STORY_IDS.has(item.id) && !v2FallbackIds.has(item.id);
    let html;
    if (isV2Target) {
      // 독립 독서 페이지. 이전/다음은 책장 정렬(completedByBookshelf)에서.
      const cIdx = completedByBookshelf.indexOf(item);
      const prevEntry = cIdx > 0 ? completedByBookshelf[cIdx - 1] : null;         // 정렬상 앞 = 더 최신
      const nextEntry = cIdx >= 0 && cIdx < completedByBookshelf.length - 1 ? completedByBookshelf[cIdx + 1] : null;
      const inh = v2InheritanceByStory[item.id] || { before: [], tie: [] };
      html = renderStoryPageV2({
        indexHtmlSrc,
        id: item.id, storyTitle: item.storyTitle, description: item.description, url: item.url,
        opening: item.opening, creatorNickname: item.creatorNickname,
        inheritedLines: [...inh.before, ...inh.tie], // 분기면 실제 조립된 상속 문장, 원본작이면 빈 배열
        parentTitle: v2ParentTitleByStory[item.id], parentStoryId: item.parentStoryId,
        lines: item.lines, meta: item.meta, candidates: item.candidates, related,
        isCompleted: item.isCompleted, lastmod: item.lastmod,
        hasEn: EN_PUBLISHED_IDS.has(item.id),
        prevEntry: prevEntry && { id: prevEntry.id },
        nextEntry: nextEntry && { id: nextEntry.id },
      });
    } else {
      // V2 대상이 아니거나(비-V2 완결작), 분기 상속 조립 실패로 폴백된 작품 —
      // 기존 URL·기존 렌더러 그대로 유지.
      const bodyHtml = storyPageBodyHtml({
        opening: item.opening, lines: item.lines, meta: item.meta,
        candidates: item.candidates, related,
      });
      html = renderStoryPage(indexHtmlSrc, {
        id: item.id, title: item.title, description: item.description, url: item.url,
        bodyHtml, lastmod: item.lastmod, creatorNickname: item.creatorNickname,
      });
    }

    if (isV2Target) {
      assertV2ShellOk(item.id, html);          // 실패 시 throw → 빌드 실패
      if (!_v2GeneratedIds.includes(item.id)) _v2GeneratedIds.push(item.id);
    }

    const dir = path.join(OUT_DIR, item.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    sitemapEntries.push({ id: item.id, lastmod: item.lastmod, title: item.title, description: item.description, isCompleted: item.isCompleted });
    ok++;
  }

  // V2 대상인데 이번 빌드에서 생성/검증도 안 됐고 "의도된 폴백"으로도 설명 안 되는
  // 게 있으면 빌드 실패(앱을 없는 페이지로 보내지 않기 위해 — 주입 목록은
  // "설정 ID"가 아니라 "실제 생성된 ID"). 분기 상속 조립 실패로 인한 폴백은
  // v2FallbackIds에 이유와 함께 이미 기록됐으므로 여기서 실패로 치지 않는다.
  const _v2Missing = [...V2_STORY_IDS].filter(id => !_v2GeneratedIds.includes(id) && !v2FallbackIds.has(id));
  if (_v2Missing.length) {
    throw new Error(`V2 대상인데 페이지 생성/검증 실패: ${_v2Missing.join(', ')} `
      + `(완결작 풀에 없거나 게이트 탈락). 앱에 죽은 링크를 주입하지 않도록 빌드를 멈춤.`);
  }
  if (v2Fallback.length) {
    console.log(`V2 폴백 ${v2Fallback.length}건(기존 렌더러 유지): ${v2Fallback.map(f => `${f.id}(${f.reason})`).join('; ')}`);
  }
  // 실제 생성된 V2 ID를 앱 마커에 주입(수동 _V2_READER_IDS 목록 대체).
  injectV2ReaderIds(_v2GeneratedIds);

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

  // 4차: 훔쳐본 일기장 — getDiaryBook 콜러블이 공개일 게이트를 이미 통과시킨
  // 책만 ok:true로 내려주므로, 여기선 그 결과를 그대로 신뢰하고 순회만 함
  // (날짜 로직 중복 없음, fetchPublicDiaryBook 주석 참고).
  fs.rmSync(DIARY_OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIARY_OUT_DIR, { recursive: true });
  const diaryEntries = [];
  for (let book_id = 1; book_id <= DIARY_BOOK_COUNT; book_id++) {
    const book = await fetchPublicDiaryBook(book_id);
    if (!book) continue;
    const html = renderDiaryBookPage({ book_id, book });
    const dir = path.join(DIARY_OUT_DIR, String(book_id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    sitemapEntries.push({ diaryId: book_id, lastmod: null });
    diaryEntries.push({ book_id, book });
  }
  const diaryIndexable = diaryEntries.length > 0;
  fs.writeFileSync(DIARY_HUB_PATH, renderDiaryHubPage(diaryEntries, diaryIndexable));
  console.log(`훔쳐본 일기장 페이지 ${diaryEntries.length}/${DIARY_BOOK_COUNT}건 생성(공개된 회차만)`);

  const extraStaticPages = [
    { loc: `${SITE_ORIGIN}/bang/today/`, changefreq: 'daily', priority: '0.8' },
    ...(wcIndexable ? [{ loc: `${SITE_ORIGIN}/bang/word-challenge/`, changefreq: 'daily', priority: '0.6' }] : []),
    ...(diaryIndexable ? [{ loc: `${SITE_ORIGIN}/bang/diary/`, changefreq: 'weekly', priority: '0.6' }] : []),
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
  renderDiaryBookPage, renderDiaryHubPage,
  renderStoryPageV2, readerCss, readerProseHtml,
  SLOT_KEYS, SLOT_SLUG, SLOT_LABEL, DIARY_BOOK_COUNT,
  // 테스트/스크래치 스크립트용 — 멱등성·롤백 검증에 필요(정상 빌드 흐름은 안 바뀜)
  injectV2ReaderIds, assertV2ShellOk,
  // 분기 작품 상속 문장 조립 — main()의 1차 패스 후~2차 패스 전에서 실행돼
  // V2_TARGET_IDS(computeV2TargetIds 계산분) 전체에 적용됨. export는 검증
  // 스크립트가 개별 케이스를 재현할 때 계속 사용.
  computeBranchInheritance,
};

if (require.main === module) {
  main().catch(e => {
    console.error('SSG 빌드 실패:', e);
    process.exit(1);
  });
}
