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

const ROOT = path.join(__dirname, '..');
const STORY_DIR = path.join(ROOT, 'bang', 'story');
const TODAY_DIR = path.join(ROOT, 'bang', 'today');
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
    console.log('bang/story/ 없음 — 이번 빌드에서 정적 스토리 페이지가 생성 안 된 것으로 보임(빌드 스텝이 continue-on-error로 스킵됐을 수 있음). 검사 대상 없어 통과 처리.');
    return;
  }
  const ids = fs.readdirSync(STORY_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  if (!ids.length) { console.log('완결작 정적 페이지 0개 — 검사할 게 없어 통과 처리.'); return; }
  console.log(`완결작 정적 페이지 ${ids.length}건 검사 시작...`);

  const titleOwners = new Map();
  const descOwners = new Map();
  const bodyHashOwners = new Map();
  const lineFreq = new Map(); // 줄(문자열) -> 등장한 페이지 수

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

    // #app(이 스토리만의 고유 본문) — 비어있거나 로딩 상태로 멈춰있으면
    // 실제로는 이 스토리의 본문 생성 자체가 실패한 것.
    const appMatch = html.match(/<main id="app">([\s\S]*?)<\/main>/);
    if (!appMatch) { fail(`${id}: <main id="app"> 마커를 못 찾음`); continue; }
    const appVisible = visibleLines(`<div>${appMatch[1]}</div>`).join(' ');
    if (!appVisible.trim()) fail(`${id}: 본문(#app) 영역이 비어있음`);
    else if (appVisible.includes('불러오는 중')) fail(`${id}: 본문(#app) 영역이 로딩 상태로 멈춰있음(실제 이야기 내용이 아니라 "불러오는 중" 문구만 있음)`);

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

function main() {
  const sitemap = fs.existsSync(SITEMAP_PATH) ? fs.readFileSync(SITEMAP_PATH, 'utf8') : null;
  if (!sitemap) warn('sitemap.xml을 못 찾음');
  // 완결작/진행중 story 검사와 역할 슬롯 검사는 서로 독립된 빌드 산출물이라,
  // 한쪽이 비어있거나(예: 역할 슬롯 아직 미도입) 실패해도 다른 쪽 검사는
  // 그대로 계속 진행 — early return으로 서로를 가리지 않게 별도 함수로 분리.
  verifyStoryPages(sitemap);
  verifyTodayPages(sitemap);

  if (hasFatal) { console.error('\n🔴 치명적 문제 발견 — 배포를 중단합니다.'); process.exit(1); }
  console.log(hasWarning ? '\n🟠 경고 있음 — 배포는 진행하되 확인 권장.' : '\n🟢 이상 없음.');
}

main();
