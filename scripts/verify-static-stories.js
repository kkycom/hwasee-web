// build-static-stories.js가 생성한 bang/story/{id}/index.html 전수 검사 —
// 애드센스 6차 반려 실제 원인(온보딩 텍스트가 완결작 30개 전부에 복제돼
// 89% 동일 콘텐츠로 묶인 사고)과 같은 종류의 문제가 조용히 재발하는 걸
// 배포 전에 자동으로 잡기 위한 CI 가드레일. 배포될 HTML 자체는 손대지
// 않고 읽기 전용으로만 검사함 — 문제 발견 시 exit 1로 워크플로우를 멈춰서
// upload-pages-artifact/deploy-pages까지 진행되지 않게 함.
//
// 배경: bang/index.html은 "살아있는 SPA 앱 전체"이고 SSG는 이걸 clone해서
// 스토리별로 <main id="app"> 안쪽만 바꿔치기하는 방식이라(project_hwasee
// _bang_adsense_content_gap 메모리 참고), #app 바깥에 새로 추가되는 정적
// 요소(광고, 위젯 등)는 전부 완결작 페이지 30개에 그대로 복제됨. 이 검사는
// 그 복제량이 과거 사고 수준으로 다시 불어나는지 자동으로 감시함.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { V2_TARGET_IDS, V2_READER_IDS_DECL_RE } = require('./lib/v2-reader-ids.js');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML_PATH = path.join(ROOT, 'bang', 'index.html');
const STORY_DIR = path.join(ROOT, 'bang', 'story');
const BUILD_MANIFEST_PATH = path.join(ROOT, '.story-build-manifest.json');
const TODAY_DIR = path.join(ROOT, 'bang', 'today');
const WORD_CHALLENGE_DIR = path.join(ROOT, 'bang', 'word-challenge');
const DIARY_DIR = path.join(ROOT, 'bang', 'diary');
const SITEMAP_PATH = path.join(ROOT, 'bang', 'sitemap.xml');
const SITE_ORIGIN = 'https://hwasee.me';

// 2026-08-11 기준 실측 baseline — 페이지 간 공통(반복) 텍스트가 헤더/푸터/
// 사이드위젯 라벨 수준으로 대략 이 정도였음(직접 curl로 두 완결작 비교해서
// 확인한 실측치). 광고/위젯이 늘면서 조금씩 커지는 건 정상이지만, 이 값
// 대비 몇 배씩 튀면 과거 온보딩 텍스트 중복 사고와 같은 패턴일 가능성이
// 큼 — 구글이 공개한 정확한 "몇 %면 안전"류 절대 임계값은 없어서, 고정
// 퍼센트가 아니라 이 baseline 대비 배수로 급증만 감지함.
const COMMON_TEXT_BASELINE_CHARS = 130;
const WARN_MULTIPLIER = 2.5;
const FAIL_MULTIPLIER = 5;

// 로그인/관리자 전용 UI 문구 — 정적(로그아웃 상태) 페이지에 절대 노출되면
// 안 되는 것들. 온보딩 오버레이 사고 재발 감시용.
const FORBIDDEN_PHRASES = [
  '처음 오셨나요', '로그인하고 시작하기', 'onboarding-overlay', 'id="login-modal"', '관리자 메뉴',
];

let hasFatal = false;
let hasWarning = false;
const fail = msg => { hasFatal = true; console.error('❌ FAIL:', msg); };
const warn = msg => { hasWarning = true; console.warn('⚠️  WARN:', msg); };

// <script>/<style> 내용은 코드일 뿐 실제 화면 텍스트가 아니므로 제외하고,
// 남은 태그를 개행으로 치환해 사람이 실제로 읽는 줄 단위 텍스트만 추출.
function visibleLines(html) {
  let h = html.replace(/<script[\s\S]*?<\/script>/g, '');
  h = h.replace(/<style[\s\S]*?<\/style>/g, '');
  return h.replace(/<[^>]+>/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
}

function verifyStoryPages(sitemap) {
  if (!fs.existsSync(STORY_DIR)) {
    // V2_TARGET_IDS가 설정돼 있다면(=운영 중인 독립 독서 페이지가 있다는 뜻)
    // story 디렉터리 자체가 없는 건 "빌드 스텝 스킵" 허용 범위가 아니라 명백한
    // 전체 누락이다 — 네트워크로 라이브 sitemap을 조회할 필요도 없이 여기서
    // 바로 막는다(2026-09-12, Codex final 지적 — 네트워크 실패 시 대량감소
    // 검사가 무력화되는 것과 별개로, "디렉터리 자체가 없는" 극단적 케이스는
    // 로컬 정보만으로 이미 판정 가능).
    if (V2_TARGET_IDS.length) {
      fail(`bang/story/ 자체가 없음 — V2 대상(${V2_TARGET_IDS.join(', ')})이 설정돼 있는데 독서 페이지가 하나도 안 만들어짐. 빌드 실패로 판단해 배포를 막음.`);
      return 0;
    }
    console.log('bang/story/ 없음 — 이번 빌드에서 정적 스토리 페이지가 생성 안 된 것으로 보임(빌드 스텝이 continue-on-error로 스킵됐을 수 있음). V2 대상도 없어 검사 대상 없음으로 통과 처리.');
    return 0;
  }
  const ids = fs.readdirSync(STORY_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  if (!ids.length) {
    if (V2_TARGET_IDS.length) {
      fail(`bang/story/ 안에 페이지가 0개 — V2 대상(${V2_TARGET_IDS.join(', ')})이 설정돼 있는데 독서 페이지가 하나도 안 만들어짐. 빌드 실패로 판단해 배포를 막음.`);
      return 0;
    }
    console.log('완결작 정적 페이지 0개 — V2 대상도 없어 검사할 게 없어 통과 처리.');
    return 0;
  }
  console.log(`완결작 정적 페이지 ${ids.length}건 검사 시작...`);

  const titleOwners = new Map();
  const descOwners = new Map();
  const bodyHashOwners = new Map();
  const lineFreq = new Map(); // 줄(문자열) -> 등장한 페이지 수
  const generatedV2Ids = []; // 실제 생성된 V2 독립 셸 페이지

  for (const id of ids) {
    const filePath = path.join(STORY_DIR, id, 'index.html');
    if (!fs.existsSync(filePath)) { fail(`${id}: index.html 파일 자체가 없음`); continue; }
    const html = fs.readFileSync(filePath, 'utf8');
    const expectedCanonical = `${SITE_ORIGIN}/bang/story/${id}/`;

    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
    const canonical = (html.match(/<link rel="canonical" href="([^"]*)">/) || [])[1];
    const description = (html.match(/<meta name="description" content="([^"]*)">/) || [])[1];

    if (!title) fail(`${id}: <title> 태그를 못 찾음`);
    else { if (!titleOwners.has(title)) titleOwners.set(title, []); titleOwners.get(title).push(id); }

    if (!description) fail(`${id}: description 메타태그를 못 찾음`);
    else { if (!descOwners.has(description)) descOwners.set(description, []); descOwners.get(description).push(id); }

    if (!canonical) fail(`${id}: canonical 태그를 못 찾음`);
    else if (canonical !== expectedCanonical) fail(`${id}: canonical이 자기 URL과 불일치 (${canonical} !== ${expectedCanonical})`);

    // 본문 — 비어있거나 로딩 상태로 멈춰있으면 이 스토리의 본문 생성 자체가
    // 실패한 것. 기존 renderStoryPage는 <main id="app">(앱 셸 복제), V2
    // 독립 독서 페이지(renderStoryPageV2)는 <h1 class="reader-title">가 있는
    // <main>. 둘 다 지원.
    const isV2 = /<h1 class="reader-title">/.test(html);
    const appMatch = isV2
      ? html.match(/<main>([\s\S]*?)<\/main>/)
      : html.match(/<main id="app">([\s\S]*?)<\/main>/);
    if (!appMatch) { fail(`${id}: ${isV2 ? '<main>(V2)' : '<main id="app">'} 마커를 못 찾음`); continue; }
    const appVisible = visibleLines(`<div>${appMatch[1]}</div>`).join(' ');
    if (!appVisible.trim()) fail(`${id}: 본문 영역이 비어있음`);
    else if (appVisible.includes('불러오는 중')) fail(`${id}: 본문 영역이 로딩 상태로 멈춰있음("불러오는 중" 문구만 있음)`);
    // V2는 canonical/robots가 반드시 있어야 함(독립 셸이라 renderStoryPage의
    // clone 치환에 안 기대므로 자체 생성이 정상 동작하는지 여기서 재확인).
    if (isV2) {
      generatedV2Ids.push(id);
      if (!/<meta name="robots" content="index,follow">/.test(html)) fail(`${id}: V2인데 robots index,follow가 없음`);
      if (html.includes('<main id="app">')) fail(`${id}: V2인데 <main id="app">(앱 셸)이 남아있음 — 템플릿 혼선`);
    }

    const bodyHash = crypto.createHash('sha256').update(appVisible).digest('hex');
    if (!bodyHashOwners.has(bodyHash)) bodyHashOwners.set(bodyHash, []);
    bodyHashOwners.get(bodyHash).push(id);

    // 전체 페이지(스크립트/스타일 제외) 기준 — 금지 문구 + 공통줄 집계.
    // 로딩 위젯 등 정상적인 부속 요소는 여기 포함되지만 "불러오는 중" 한
    // 두 줄 정도는 baseline 계산에서 걸러지므로 문제 삼지 않음(위 #app
    // 전용 체크가 실제 본문 결손은 이미 잡아줌).
    const wholeLines = visibleLines(html);
    for (const phrase of FORBIDDEN_PHRASES) {
      if (wholeLines.some(l => l.includes(phrase))) {
        fail(`${id}: 금지 문구 "${phrase}"가 정적 페이지에 노출돼있음 — 로그인/관리자 전용 UI가 새어나온 것으로 보임`);
      }
    }
    for (const line of new Set(wholeLines)) lineFreq.set(line, (lineFreq.get(line) || 0) + 1);
  }

  // V2 적용 목록 — 앱(bang/index.html의 _V2_READER_IDS)에 주입된 값이
  // (a) 마커 정확히 1개, (b) 이번 빌드에 실제 생성된 V2 셸 페이지 집합과 정확히 일치,
  // (c) 설정 원천(v2-reader-ids.js)에서 하나도 누락되지 않았는지 확인.
  // 앱이 없는 페이지로 라우팅하는 상태를 배포 전에 차단한다.
  {
    const appSrc = fs.existsSync(INDEX_HTML_PATH) ? fs.readFileSync(INDEX_HTML_PATH, 'utf8') : '';
    const decls = appSrc.match(V2_READER_IDS_DECL_RE) || [];
    if (decls.length !== 1) {
      fail(`bang/index.html의 _V2_READER_IDS 주입 마커가 ${decls.length}개 — 정확히 1개여야 함`);
    } else {
      const appIds = (decls[0].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)).sort();
      const genSorted = [...generatedV2Ids].sort();
      if (JSON.stringify(appIds) !== JSON.stringify(genSorted)) {
        fail(`앱 _V2_READER_IDS(${JSON.stringify(appIds)})가 실제 생성된 V2 페이지(${JSON.stringify(genSorted)})와 불일치 — injectV2ReaderIds 누락/오류`);
      }
      // v2_fallback: 분기 상속 조립 실패로 build-static-stories.js가 스스로
      // 기존 렌더러로 되돌린 것 — "불완전한 본문을 발행하지 않는다"는 의도된
      // 동작이라 fail 대상이 아니다. 그 외의 누락만 진짜 결함으로 본다.
      let fallbackIds = [];
      try {
        if (fs.existsSync(BUILD_MANIFEST_PATH)) {
          const manifest = JSON.parse(fs.readFileSync(BUILD_MANIFEST_PATH, 'utf8'));
          fallbackIds = (manifest.v2_fallback || []).map(f => f.id);
        }
      } catch (e) { /* 매니페스트 못 읽으면 폴백 목록 없이 보수적으로 검사(아래에서 걸림) */ }
      const targetMissing = V2_TARGET_IDS.filter(id => !generatedV2Ids.includes(id) && !fallbackIds.includes(id));
      if (targetMissing.length) {
        fail(`v2-reader-ids.js 설정 대상인데 V2 페이지가 생성 안 됨(폴백 사유도 없음): ${targetMissing.join(', ')}`);
      }
      for (const id of fallbackIds) {
        if (generatedV2Ids.includes(id)) continue; // 폴백 목록에 있지만 실제로는 생성됐다면 정보 불일치, 무시(생성이 우선)
        console.log(`(참고) V2 폴백 확인됨: ${id} — 기존 렌더러로 정상 발행됨`);
      }
    }
  }

  for (const [title, owners] of titleOwners) {
    if (owners.length > 1) fail(`title "${title.slice(0, 30)}..."이 서로 다른 ${owners.length}개 페이지에서 동일함: ${owners.join(', ')}`);
  }
  for (const [desc, owners] of descOwners) {
    if (owners.length > 1) fail(`description "${desc.slice(0, 30)}..."이 서로 다른 ${owners.length}개 페이지에서 동일함: ${owners.join(', ')}`);
  }
  for (const [, owners] of bodyHashOwners) {
    if (owners.length > 1) fail(`서로 다른 완결작인데 본문(#app) 내용이 완전히 동일함: ${owners.join(', ')}`);
  }

  // 페이지 90% 이상에 공통으로 등장하는 줄 = 헤더/푸터/사이드위젯 같은
  // "공통 챗ROM" — 이 총 글자수가 baseline 대비 급증하면 경고/실패.
  const threshold = Math.max(2, Math.ceil(ids.length * 0.9));
  let commonChars = 0, commonLineCount = 0;
  for (const [line, count] of lineFreq) {
    if (count >= threshold) { commonChars += line.length; commonLineCount++; }
  }
  console.log(`공통 텍스트(페이지 90%+ 등장): ${commonLineCount}줄, ${commonChars}자 (baseline ${COMMON_TEXT_BASELINE_CHARS}자)`);
  if (commonChars >= COMMON_TEXT_BASELINE_CHARS * FAIL_MULTIPLIER) {
    fail(`공통 텍스트가 baseline 대비 ${FAIL_MULTIPLIER}배 이상(${commonChars}자) — 과거 온보딩 텍스트 중복 사고와 같은 패턴일 가능성이 큼`);
  } else if (commonChars >= COMMON_TEXT_BASELINE_CHARS * WARN_MULTIPLIER) {
    warn(`공통 텍스트가 baseline 대비 ${WARN_MULTIPLIER}배 이상(${commonChars}자) — 급증 추세, 확인 권장`);
  }

  if (sitemap) {
    // 아카이브 목록 URL(/bang/story/, ID 없음) 자체도 sitemap에 있어서
    // [^/]+로만 걸면 그 줄까지 오매칭됨(캡처 그룹이 "</loc"의 "<" 한
    // 글자만 잡아버림) — <loc>...</loc> 태그 경계로 확실히 좁히고, ID엔
    // "<"도 못 오게 해서 그 경우 아예 매치가 안 되게 함.
    const sitemapIds = [...sitemap.matchAll(/<loc>https:\/\/hwasee\.me\/bang\/story\/([^/<]+)\/<\/loc>/g)].map(m => m[1]);
    const sitemapIdSet = new Set(sitemapIds);
    const dirIdSet = new Set(ids);
    for (const id of ids) if (!sitemapIdSet.has(id)) fail(`sitemap.xml에 없는 완결작 페이지: ${id}`);
    for (const id of sitemapIds) if (!dirIdSet.has(id)) fail(`sitemap.xml엔 있는데 실제 생성된 페이지 디렉터리가 없음: ${id}`);
  }

  console.log(`검사 완료: ${ids.length}개 페이지`);
  return ids.length;
}

// "라이브 대비 몇 % 줄었나"(verifyNoMassRegression)는 몇 개가 조용히 빠지는
// 걸 못 잡는 보조 경보다. 이 함수가 본 방어선 — build-static-stories.js가
// 남긴 매니페스트(이번 빌드가 시도한 ID 전체 vs 성공한 ID vs 왜 스킵됐는지)를
// ID 단위로 대조한다. 정상 게이트(마감 안 됨/채택 문장 없음)로 스킵된 건
// 통과시키고, 예상 못 한 예외(kind:'exception')로 스킵된 게 하나라도 있으면
// fail — 개별 작품이 코드 결함으로 조용히 사라지는 걸 잡기 위함
// (2026-09-12, "특정 작품 몇 개 누락은 비율 경보로 못 잡는다"는 지적 반영).
function verifyBuildManifest() {
  if (!fs.existsSync(BUILD_MANIFEST_PATH)) {
    warn('.story-build-manifest.json 없음 — build-static-stories.js가 이 버전 이전에 실행됐거나 빌드 스텝이 스킵된 것으로 보임. ID 단위 누락 대조를 못 함(라이브 대비 급감 검사만 적용됨).');
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(BUILD_MANIFEST_PATH, 'utf8'));
  } catch (e) {
    fail(`.story-build-manifest.json 파싱 실패: ${e.message}`);
    return;
  }
  const { attempted_ids = [], processed_ids = [], skipped = [] } = manifest;

  const exceptions = skipped.filter(s => s.kind === 'exception');
  if (exceptions.length) {
    for (const s of exceptions) fail(`빌드 예외로 조용히 스킵됨(정상 게이트 아님): ${s.id} — ${s.reason}`);
  }
  const accounted = new Set([...processed_ids, ...skipped.map(s => s.id)]);
  const unaccounted = attempted_ids.filter(id => !accounted.has(id));
  if (unaccounted.length) {
    fail(`시도한 ID인데 성공도 스킵 기록도 없음(매니페스트 정합성 깨짐): ${unaccounted.join(', ')}`);
  }

  // processed로 기록된 각 ID가 실제로 파일까지 생성됐는지 1:1 확인 — 1차 패스
  // 통과 후 2차 패스(파일 쓰기)에서만 실패하는 경우까지 잡는다.
  const missingFiles = processed_ids.filter(id => !fs.existsSync(path.join(STORY_DIR, id, 'index.html')));
  if (missingFiles.length) {
    fail(`1차 패스는 통과했는데 실제 페이지 파일이 없음: ${missingFiles.join(', ')}`);
  }

  const gateSkips = skipped.filter(s => s.kind === 'gate');
  console.log(`빌드 매니페스트 대조: 시도 ${attempted_ids.length}건 = 성공 ${processed_ids.length}건 + 정상 게이트 스킵 ${gateSkips.length}건 + 예외 스킵 ${exceptions.length}건`);
}

// 독서 페이지가 이 사이트의 핵심 산출물이라, "필수 페이지가 누락된 빌드"가
// 조용히 정상 배포되면 안 된다. 개별 작품 하나가 관리자 판단으로 비공개·삭제
// 되는 건 정상 운영(sitemap에서 하나씩 빠짐)이지만, Firestore 조회 실패 등으로
// story 페이지 전체가 왕창 안 만들어지는 건 버그다 — 이 둘을 "몇 개나 줄었나"로
// 구분한다. 라이브 sitemap.xml을 fetch해서 비교(네트워크 실패 시엔 이 검사만
// 건너뛰고 warn — 다른 fail-closed 검사는 그대로 유지되므로 전체가 통과 처리로
// 새지 않음). 이 검사가 fail하면 verify가 exit 1 → deploy.yml이 upload/deploy
// 단계에 도달 못 해 배포가 중단되고, GitHub Pages는 마지막 성공 배포를 그대로
// 서빙한다(별도 롤백 로직 불필요 — Pages 배포 모델 자체가 그렇게 동작함).
async function verifyNoMassRegression(currentStoryCount) {
  let liveSitemap;
  try {
    const res = await fetch(`${SITE_ORIGIN}/bang/sitemap.xml`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    liveSitemap = await res.text();
  } catch (e) {
    warn(`라이브 sitemap.xml 조회 실패(${e.message}) — 완결작 수 급감 여부를 못 봄. 이 검사만 건너뛰고 나머지 검사는 그대로 fail-closed.`);
    return;
  }
  const liveCount = (liveSitemap.match(/<loc>https:\/\/hwasee\.me\/bang\/story\/[^/<]+\/<\/loc>/g) || []).length;
  if (liveCount === 0) { console.log('(참고) 라이브 sitemap에 story 페이지가 0개 — 최초 배포로 보여 급감 비교 생략.'); return; }
  if (currentStoryCount === 0) {
    fail(`이번 빌드는 story 페이지가 0개인데 라이브는 ${liveCount}개 — 전체 누락으로 의심돼 배포를 막음(의도된 전체 비공개라면 이 검사를 알고 조정할 것).`);
    return;
  }
  const dropRatio = (liveCount - currentStoryCount) / liveCount;
  if (dropRatio >= 0.5) {
    fail(`story 페이지가 라이브 대비 ${Math.round(dropRatio * 100)}% 감소(${liveCount} → ${currentStoryCount}) — 개별 비공개/삭제로는 이 폭까지 잘 안 줄어서 데이터 조회 실패 등 빌드 결함 가능성이 큼. 배포를 막음.`);
  } else if (dropRatio > 0) {
    console.log(`(참고) story 페이지 수 소폭 감소: 라이브 ${liveCount} → 이번 빌드 ${currentStoryCount}(개별 비공개/삭제로 추정, 통과)`);
  } else {
    console.log(`(참고) story 페이지 수: 라이브 ${liveCount} → 이번 빌드 ${currentStoryCount}`);
  }
}

// bang/today/{slug}/index.html — 역할(role) 페이지 전수 검사. story 페이지와
// 달리 완결작 개수만큼 있는 게 아니라 슬롯 개수만큼만 있고, noindex인 페이지는
// sitemap에서 의도적으로 빠지므로 1:1 매칭 방향이 다름(sitemap→디렉터리는
// 여전히 1:1이어야 하지만 디렉터리→sitemap은 indexable인 것만).
function verifyTodayPages(sitemap) {
  if (!fs.existsSync(TODAY_DIR)) {
    console.log('bang/today/ 없음 — 이번 빌드에서 역할 슬롯 페이지가 생성 안 됨. 검사 대상 없어 통과 처리.');
    return;
  }
  const slugs = fs.readdirSync(TODAY_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  if (!slugs.length) { console.log('역할 슬롯 정적 페이지 0개 — 검사할 게 없어 통과 처리.'); return; }
  console.log(`\n역할 슬롯 정적 페이지 ${slugs.length}건 검사 시작...`);

  const titleOwners = new Map();
  const indexableSlugs = [];

  for (const slug of slugs) {
    const filePath = path.join(TODAY_DIR, slug, 'index.html');
    if (!fs.existsSync(filePath)) { fail(`today/${slug}: index.html 파일 자체가 없음`); continue; }
    const html = fs.readFileSync(filePath, 'utf8');
    const expectedCanonical = `${SITE_ORIGIN}/bang/today/${slug}/`;

    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
    const canonical = (html.match(/<link rel="canonical" href="([^"]*)">/) || [])[1];
    const description = (html.match(/<meta name="description" content="([^"]*)">/) || [])[1];
    const robots = (html.match(/<meta name="robots" content="([^"]*)">/) || [])[1];

    if (!title) fail(`today/${slug}: <title> 태그를 못 찾음`);
    else { if (!titleOwners.has(title)) titleOwners.set(title, []); titleOwners.get(title).push(slug); }
    if (!description) fail(`today/${slug}: description 메타태그를 못 찾음`);
    if (!robots) fail(`today/${slug}: robots 메타태그를 못 찾음`);

    // today 페이지는 역할 페이지 자체가 canonical 대상이라(story/{id}로 이전
    // 안 함, 2026-08-20 설계 논의 결론) 항상 자기 자신을 가리켜야 함.
    if (!canonical) fail(`today/${slug}: canonical 태그를 못 찾음`);
    else if (canonical !== expectedCanonical) fail(`today/${slug}: canonical이 자기 URL과 불일치 (${canonical} !== ${expectedCanonical})`);

    const mainMatch = html.match(/<main>([\s\S]*?)<\/main>/);
    if (!mainMatch) { fail(`today/${slug}: <main> 마커를 못 찾음`); continue; }
    const mainVisible = visibleLines(`<div>${mainMatch[1]}</div>`).join(' ');
    if (!mainVisible.trim()) fail(`today/${slug}: 본문이 비어있음`);
    if (mainVisible.includes('불러오는 중')) fail(`today/${slug}: 로딩 상태 문구가 정적 페이지에 남아있음(이 템플릿은 전부 정적이라 있으면 안 됨)`);

    const wholeLines = visibleLines(html);
    for (const phrase of FORBIDDEN_PHRASES) {
      if (wholeLines.some(l => l.includes(phrase))) {
        fail(`today/${slug}: 금지 문구 "${phrase}"가 정적 페이지에 노출돼있음`);
      }
    }

    if (robots && robots.includes('index') && !robots.includes('noindex')) indexableSlugs.push(slug);
    else if (robots && robots.includes('noindex') && sitemap && sitemap.includes(`/bang/today/${slug}/`)) {
      fail(`today/${slug}: robots가 noindex인데 sitemap.xml에는 실려있음(모순된 신호)`);
    }
  }

  for (const [title, owners] of titleOwners) {
    if (owners.length > 1) fail(`today 페이지 title "${title}"이 서로 다른 슬롯에서 동일함: ${owners.join(', ')}`);
  }

  if (sitemap) {
    const sitemapSlugs = [...sitemap.matchAll(/<loc>https:\/\/hwasee\.me\/bang\/today\/([^/<]+)\/<\/loc>/g)].map(m => m[1]);
    const slugSet = new Set(slugs);
    for (const slug of sitemapSlugs) if (!slugSet.has(slug)) fail(`sitemap.xml엔 있는데 실제 생성된 today 페이지 디렉터리가 없음: ${slug}`);
    for (const slug of indexableSlugs) if (!sitemapSlugs.includes(slug)) fail(`today/${slug}: index,follow인데 sitemap.xml에 없음`);
  }

  console.log(`역할 슬롯 검사 완료: ${slugs.length}개 페이지(그중 indexable ${indexableSlugs.length}개)`);
}

// today/word-challenge 허브·개별 페이지가 공통으로 쓰는 가벼운 정적 셸
// 검사 — title/canonical/description/robots/본문 존재/금지문구까지 한
// 파일 기준으로 검사하고 결과를 돌려줌(호출부가 title 중복 등 페이지 간
// 비교는 알아서 함).
function checkStaticShellFile(filePath, expectedCanonical, label) {
  if (!fs.existsSync(filePath)) { fail(`${label}: index.html 파일 자체가 없음`); return null; }
  const html = fs.readFileSync(filePath, 'utf8');
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
  const canonical = (html.match(/<link rel="canonical" href="([^"]*)">/) || [])[1];
  const description = (html.match(/<meta name="description" content="([^"]*)">/) || [])[1];
  const robots = (html.match(/<meta name="robots" content="([^"]*)">/) || [])[1];

  if (!title) fail(`${label}: <title> 태그를 못 찾음`);
  if (!description) fail(`${label}: description 메타태그를 못 찾음`);
  if (!robots) fail(`${label}: robots 메타태그를 못 찾음`);
  if (!canonical) fail(`${label}: canonical 태그를 못 찾음`);
  else if (canonical !== expectedCanonical) fail(`${label}: canonical이 자기 URL과 불일치 (${canonical} !== ${expectedCanonical})`);

  const mainMatch = html.match(/<main>([\s\S]*?)<\/main>/);
  if (!mainMatch) { fail(`${label}: <main> 마커를 못 찾음`); return { title, canonical, description, robots }; }
  const mainVisible = visibleLines(`<div>${mainMatch[1]}</div>`).join(' ');
  if (!mainVisible.trim()) fail(`${label}: 본문이 비어있음`);
  if (mainVisible.includes('불러오는 중')) fail(`${label}: 로딩 상태 문구가 정적 페이지에 남아있음(이 템플릿은 전부 정적이라 있으면 안 됨)`);

  const wholeLines = visibleLines(html);
  for (const phrase of FORBIDDEN_PHRASES) {
    if (wholeLines.some(l => l.includes(phrase))) fail(`${label}: 금지 문구 "${phrase}"가 정적 페이지에 노출돼있음`);
  }
  return { title, canonical, description, robots };
}

function verifyTodayHub(sitemap) {
  const filePath = path.join(TODAY_DIR, 'index.html');
  if (!fs.existsSync(TODAY_DIR)) return; // verifyTodayPages가 이미 안내 로그를 찍음
  console.log('\ntoday 허브 검사...');
  const info = checkStaticShellFile(filePath, `${SITE_ORIGIN}/bang/today/`, 'today 허브');
  if (!info) return;
  // 설계상 today 허브는 5개 슬롯 요약이라 항상 indexable이어야 함(2026-08-20).
  if (info.robots !== 'index,follow') fail(`today 허브: robots가 "index,follow"가 아님(항상 indexable이어야 하는 설계) — 실제: "${info.robots}"`);
  if (sitemap && !sitemap.includes('<loc>https://hwasee.me/bang/today/</loc>')) {
    fail('today 허브: sitemap.xml에 /bang/today/ 자체가 없음');
  }
  console.log('today 허브 검사 완료');
}

// bang/word-challenge/{id}/index.html + bang/word-challenge/index.html(허브) —
// 개별 페이지는 마감분(winner_text 있음)만 생성되므로 story 페이지처럼 항상
// indexable. 허브는 마감분이 하나도 없으면 noindex일 수 있음(today/{slot}과
// 동일 원칙).
function verifyWordChallengePages(sitemap) {
  if (!fs.existsSync(WORD_CHALLENGE_DIR)) {
    console.log('bang/word-challenge/ 없음 — 이번 빌드에서 세 단어 챌린지 페이지가 생성 안 됨. 검사 대상 없어 통과 처리.');
    return;
  }
  const ids = fs.readdirSync(WORD_CHALLENGE_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  console.log(`\n세 단어 챌린지 개별 페이지 ${ids.length}건 검사 시작...`);

  const titleOwners = new Map();
  const descOwners = new Map();
  for (const id of ids) {
    const filePath = path.join(WORD_CHALLENGE_DIR, id, 'index.html');
    const info = checkStaticShellFile(filePath, `${SITE_ORIGIN}/bang/word-challenge/${id}/`, `word-challenge/${id}`);
    if (!info) continue;
    if (info.robots !== 'index,follow') fail(`word-challenge/${id}: robots가 "index,follow"가 아님(마감분은 항상 indexable이어야 하는 설계) — 실제: "${info.robots}"`);
    if (info.title) { if (!titleOwners.has(info.title)) titleOwners.set(info.title, []); titleOwners.get(info.title).push(id); }
    if (info.description) { if (!descOwners.has(info.description)) descOwners.set(info.description, []); descOwners.get(info.description).push(id); }
  }
  for (const [title, owners] of titleOwners) {
    if (owners.length > 1) fail(`word-challenge title "${title}"이 서로 다른 챌린지에서 동일함: ${owners.join(', ')}`);
  }
  for (const [desc, owners] of descOwners) {
    if (owners.length > 1) fail(`word-challenge description "${desc.slice(0, 30)}..."이 서로 다른 챌린지에서 동일함: ${owners.join(', ')}`);
  }

  if (sitemap) {
    const sitemapIds = [...sitemap.matchAll(/<loc>https:\/\/hwasee\.me\/bang\/word-challenge\/([^/<]+)\/<\/loc>/g)].map(m => m[1]);
    const idSet = new Set(ids);
    for (const id of ids) if (!sitemapIds.includes(id)) fail(`sitemap.xml에 없는 word-challenge 페이지: ${id}`);
    for (const id of sitemapIds) if (!idSet.has(id)) fail(`sitemap.xml엔 있는데 실제 생성된 word-challenge 페이지 디렉터리가 없음: ${id}`);
  }
  console.log(`세 단어 챌린지 개별 페이지 검사 완료: ${ids.length}건`);

  console.log('\nword-challenge 허브 검사...');
  const hubInfo = checkStaticShellFile(path.join(WORD_CHALLENGE_DIR, 'index.html'), `${SITE_ORIGIN}/bang/word-challenge/`, 'word-challenge 허브');
  if (hubInfo) {
    const hubIndexable = hubInfo.robots === 'index,follow';
    const hubInSitemap = !!(sitemap && sitemap.includes('<loc>https://hwasee.me/bang/word-challenge/</loc>'));
    if (hubIndexable && !hubInSitemap) fail('word-challenge 허브: index,follow인데 sitemap.xml에 없음');
    if (!hubIndexable && hubInSitemap) fail('word-challenge 허브: noindex인데 sitemap.xml에는 실려있음(모순된 신호)');
  }
  console.log('word-challenge 허브 검사 완료');
}

// bang/diary/{book_id}/index.html + bang/diary/index.html(허브) — 개별
// 페이지는 getDiaryBook이 공개일 게이트를 통과시킨 회차만 생성되므로
// word-challenge 개별 페이지처럼 항상 indexable. 게이트 로직 자체(날짜 비교)는
// 여기서 다시 검사하지 않음 — build-static-stories.js가 그 로직을 안 베끼고
// 라이브 콜러블에 그대로 위임하게 짠 이유(단일 소스)와 같은 원칙.
function verifyDiaryPages(sitemap) {
  if (!fs.existsSync(DIARY_DIR)) {
    console.log('bang/diary/ 없음 — 이번 빌드에서 훔쳐본 일기장 페이지가 생성 안 됨. 검사 대상 없어 통과 처리.');
    return;
  }
  const ids = fs.readdirSync(DIARY_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  console.log(`\n훔쳐본 일기장 개별 페이지 ${ids.length}건 검사 시작...`);

  const titleOwners = new Map();
  const descOwners = new Map();
  for (const id of ids) {
    const filePath = path.join(DIARY_DIR, id, 'index.html');
    const info = checkStaticShellFile(filePath, `${SITE_ORIGIN}/bang/diary/${id}/`, `diary/${id}`);
    if (!info) continue;
    if (info.robots !== 'index,follow') fail(`diary/${id}: robots가 "index,follow"가 아님(공개된 회차는 항상 indexable이어야 하는 설계) — 실제: "${info.robots}"`);
    if (info.title) { if (!titleOwners.has(info.title)) titleOwners.set(info.title, []); titleOwners.get(info.title).push(id); }
    if (info.description) { if (!descOwners.has(info.description)) descOwners.set(info.description, []); descOwners.get(info.description).push(id); }
  }
  for (const [title, owners] of titleOwners) {
    if (owners.length > 1) fail(`diary title "${title}"이 서로 다른 회차에서 동일함: ${owners.join(', ')}`);
  }
  for (const [desc, owners] of descOwners) {
    if (owners.length > 1) fail(`diary description "${desc.slice(0, 30)}..."이 서로 다른 회차에서 동일함: ${owners.join(', ')}`);
  }

  if (sitemap) {
    const sitemapIds = [...sitemap.matchAll(/<loc>https:\/\/hwasee\.me\/bang\/diary\/([^/<]+)\/<\/loc>/g)].map(m => m[1]);
    const idSet = new Set(ids);
    for (const id of ids) if (!sitemapIds.includes(id)) fail(`sitemap.xml에 없는 diary 페이지: ${id}`);
    for (const id of sitemapIds) if (!idSet.has(id)) fail(`sitemap.xml엔 있는데 실제 생성된 diary 페이지 디렉터리가 없음: ${id}`);
  }
  console.log(`훔쳐본 일기장 개별 페이지 검사 완료: ${ids.length}건`);

  console.log('\ndiary 허브 검사...');
  const hubInfo = checkStaticShellFile(path.join(DIARY_DIR, 'index.html'), `${SITE_ORIGIN}/bang/diary/`, 'diary 허브');
  if (hubInfo) {
    const hubIndexable = hubInfo.robots === 'index,follow';
    const hubInSitemap = !!(sitemap && sitemap.includes('<loc>https://hwasee.me/bang/diary/</loc>'));
    if (hubIndexable && !hubInSitemap) fail('diary 허브: index,follow인데 sitemap.xml에 없음');
    if (!hubIndexable && hubInSitemap) fail('diary 허브: noindex인데 sitemap.xml에는 실려있음(모순된 신호)');
  }
  console.log('diary 허브 검사 완료');
}

async function main() {
  const sitemap = fs.existsSync(SITEMAP_PATH) ? fs.readFileSync(SITEMAP_PATH, 'utf8') : null;
  if (!sitemap) warn('sitemap.xml을 못 찾음');
  // 완결작/진행중 story 검사와 역할 슬롯 검사는 서로 독립된 빌드 산출물이라,
  // 한쪽이 비어있거나(예: 역할 슬롯 아직 미도입) 실패해도 다른 쪽 검사는
  // 그대로 계속 진행 — early return으로 서로를 가리지 않게 별도 함수로 분리.
  const storyCount = verifyStoryPages(sitemap);
  verifyBuildManifest();
  verifyTodayPages(sitemap);
  verifyTodayHub(sitemap);
  verifyWordChallengePages(sitemap);
  verifyDiaryPages(sitemap);
  await verifyNoMassRegression(storyCount);

  // fetch(verifyNoMassRegression의 AbortSignal.timeout)가 남긴 내부 타이머와
  // process.exit()의 강제 종료가 겹치면 Windows에서 libuv assertion으로
  // 비정상 종료하는 경우가 로컬 재현으로 확인됨(2026-09-12). exitCode만
  // 설정하고 자연 종료를 기다리면(강제 exit 없음) 이 문제가 없음 — CI(Ubuntu)
  // 무관하게 더 안전한 패턴이라 둘 다 이 방식으로 통일.
  if (hasFatal) { console.error('\n🔴 치명적 문제 발견 — 배포를 중단합니다.'); process.exitCode = 1; return; }
  console.log(hasWarning ? '\n🟠 경고 있음 — 배포는 진행하되 확인 권장.' : '\n🟢 이상 없음.');
}

if (require.main === module) {
  main().catch(e => { console.error('verify-static-stories 실행 중 예외:', e); process.exitCode = 1; });
}

// 테스트용 export(정상 CLI 실행 흐름은 안 바뀜 — require해도 위 가드 때문에 main()이 안 돎).
module.exports = { verifyNoMassRegression, verifyBuildManifest };
