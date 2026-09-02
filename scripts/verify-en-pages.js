// A-1 — build-en-pages.js가 만든 bang/en/ 산출물 전수 검사(fail-closed).
//
// 문제를 발견하면 exit 1로 워크플로우를 멈춰서 upload-pages-artifact/deploy-pages까지
// 가지 않게 한다. 즉 검증 실패 시 결과는 "잘못된 영어 페이지가 배포됨"이 아니라
// "배포 중단, 이전 라이브 버전 유지"다.
//
// 특히 확인하는 것:
//  - 미승인/스테일 작품이 목록·sitemap·hreflang 어디에도 없는지
//  - 스테일 페이지에 영어 번역 본문이 남아있지 않은지
//  - canonical이 자기 자신을 정확히 1개 가리키는지(한국어 원본과 중복으로 안 묶이게)
//  - 상호 hreflang이 양방향으로 맞물리는지(한쪽만 걸리면 실패)
//  - sitemap URL 수 == 발행 작품 수 + 영어 홈 1
//  - 참여 기능처럼 보이는 클릭 가능한 요소가 없는지

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EN_DIR = path.join(ROOT, 'bang', 'en');
const EN_STORY_DIR = path.join(EN_DIR, 'story');
const EN_ARCHIVE_PATH = path.join(EN_DIR, 'stories', 'index.html');
const EN_SITEMAP_PATH = path.join(EN_DIR, 'sitemap.xml');
const KO_STORY_DIR = path.join(ROOT, 'bang', 'story');
const MANIFEST_PATH = path.join(ROOT, '.en-manifest.json');
const SITE_ORIGIN = 'https://hwasee.me';

let hasFatal = false;
const fail = msg => { hasFatal = true; console.error('❌ FAIL:', msg); };

// 참여 기능처럼 보이면 안 되는 요소들 — "클릭 가능한 버튼·입력 요소가 전혀 없을 것"이
// 명시적 요구사항이라 육안 확인을 코드로 보완한다.
const FORBIDDEN_PATTERNS = [
  { re: /<button\b/i, what: '<button> 요소' },
  { re: /<input\b/i, what: '<input> 요소' },
  { re: /<form\b/i, what: '<form> 요소' },
  { re: /<textarea\b/i, what: '<textarea> 요소' },
  { re: /<select\b/i, what: '<select> 요소' },
  { re: /role\s*=\s*"button"/i, what: 'role="button"' },
  { re: /\son[a-z]+\s*=/i, what: '인라인 이벤트 핸들러(onclick 등)' },
  { re: /serviceWorker\s*\.\s*register/i, what: '서비스워커 등록' },
  { re: /adsbygoogle/i, what: '광고 스크립트' },
];

// 쿠키 동의 배선이 정적 페이지에서 풀리지 않았는지 확인한다(2026-09-02).
// 이 세 가지가 깨지면 "동의 전에 추적·광고가 로드되는" 상태로 되돌아가는데,
// 눈으로는 티가 안 나고 라이브에서만 드러나므로 배포 게이트에서 잡는다.
function checkConsentWiring(html, label) {
  // 1) 애드핏 스크립트가 HTML에 직접 박혀 있으면 동의와 무관하게 즉시 로드된다.
  //    (consent.js가 수락 시에만 동적으로 붙이는 것이 정상 경로다.)
  if (/ba\.min\.js/i.test(html)) {
    fail(`${label}: 동의 없이 즉시 로드되는 카카오 애드핏 스크립트(ba.min.js)가 HTML에 있음`);
  }
  // 2) 동의 배너·광고 로더가 아예 빠지면 배너가 안 뜬다.
  if (!/\/bang\/en\/consent\.js/.test(html)) {
    fail(`${label}: 쿠키 동의 스크립트(/bang/en/consent.js) 참조가 없음`);
  }
  // 3) Consent Mode 기본값은 측정 명령(config)보다 먼저 실행돼야 한다(Google 요구사항).
  const defaultAt = html.indexOf("gtag('consent', 'default'");
  const configAt = html.indexOf("gtag('config'");
  if (defaultAt === -1) {
    fail(`${label}: gtag('consent','default') 기본값 설정이 없음`);
  } else if (configAt !== -1 && defaultAt > configAt) {
    fail(`${label}: gtag('consent','default')가 gtag('config')보다 뒤에 있음`);
  }
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    fail(`.en-manifest.json을 읽을 수 없음: ${e.message}`);
    return null;
  }
}

function main() {
  const manifest = readManifest();

  // 마커가 없으면 "영어 빌드가 아예 안 돌았음"이다.
  // 단, 워크플로가 영어 빌드를 실행하도록 되어 있는 경우(EN_BUILD_REQUIRED=1)에는
  // 마커 부재가 곧 빌드 실패다 — 그대로 통과시키면 아카이브·sitemap 없이 배포되어
  // 이전에 발행돼 있던 영어 페이지가 통째로 사라진다.
  if (!manifest || manifest.build_completed !== true) {
    if (process.env.EN_BUILD_REQUIRED === '1') {
      fail('영어 빌드가 요구된 실행인데 .en-manifest.json 완료 마커가 없음 — 빌드가 실패했을 수 있어 배포를 막습니다.');
      process.exit(1);
    }
    if (fs.existsSync(EN_STORY_DIR)) {
      fail('bang/en/story/는 있는데 .en-manifest.json 완료 마커가 없음 — 영어 빌드가 중간에 실패했을 수 있어 배포를 막습니다.');
      process.exit(1);
    }
    console.log('영어 빌드가 실행되지 않음(bang/en/story/ 없음, manifest 없음) — 검사 대상 없어 통과 처리.');
    return;
  }

  if (!fs.existsSync(EN_STORY_DIR) && (manifest.publishable_ids || []).length) {
    fail('manifest는 빌드 완료라고 하는데 bang/en/story/ 디렉터리가 없음.');
    process.exit(1);
  }

  const publishableIds = manifest.publishable_ids || [];
  const staleIds = manifest.stale_ids || [];
  const publishableSet = new Set(publishableIds);
  const staleSet = new Set(staleIds);

  // ── 완결작 아카이브 ──────────────────────────────────────────────────
  // bang/en/index.html은 **영어 앱 소스**라 빌드 산출물이 아니다. 검사 대상은
  // 빌드가 만드는 아카이브 페이지(bang/en/stories/index.html)다.
  const indexPath = EN_ARCHIVE_PATH;
  if (!fs.existsSync(indexPath)) fail('bang/en/stories/index.html이 없음');
  else {
    const html = fs.readFileSync(indexPath, 'utf8');
    const canonicals = [...html.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map(m => m[1]);
    if (canonicals.length !== 1) fail(`en/stories/index.html: canonical이 정확히 1개가 아님(${canonicals.length}개)`);
    else if (canonicals[0] !== `${SITE_ORIGIN}/bang/en/stories/`) fail(`en/stories/index.html: canonical이 자기 URL이 아님(${canonicals[0]})`);
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.re.test(html)) fail(`en/stories/index.html: 금지 요소 발견 — ${p.what}`);
    }
    checkConsentWiring(html, 'en/stories/index.html');
    // 미승인/스테일 작품이 목록에 링크로 노출되면 안 된다.
    for (const id of staleIds) {
      if (html.includes(`/bang/en/story/${id}/`)) fail(`en/stories/index.html: 재확인 대상 작품이 목록에 노출됨 — ${id}`);
    }
  }

  // ── 개별 작품 페이지 ─────────────────────────────────────────────────
  const dirIds = fs.existsSync(EN_STORY_DIR)
    ? fs.readdirSync(EN_STORY_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    : [];

  // 디렉터리에 있는데 manifest가 모르는 작품 = 미승인이 새어나온 것.
  for (const id of dirIds) {
    if (!publishableSet.has(id) && !staleSet.has(id)) {
      fail(`bang/en/story/${id}/: manifest에 없는 작품이 생성됨(미승인 노출 의심)`);
    }
  }
  for (const id of publishableIds) {
    if (!dirIds.includes(id)) fail(`발행 대상인데 페이지가 생성되지 않음: ${id}`);
  }

  for (const id of dirIds) {
    const p = path.join(EN_STORY_DIR, id, 'index.html');
    if (!fs.existsSync(p)) { fail(`bang/en/story/${id}/index.html이 없음`); continue; }
    const html = fs.readFileSync(p, 'utf8');
    const expected = `${SITE_ORIGIN}/bang/en/story/${id}/`;

    const canonicals = [...html.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map(m => m[1]);
    if (canonicals.length !== 1) fail(`en/story/${id}: canonical이 정확히 1개가 아님(${canonicals.length}개)`);
    else if (canonicals[0] !== expected) fail(`en/story/${id}: canonical이 자기 URL과 불일치(${canonicals[0]})`);

    const robots = (html.match(/<meta name="robots" content="([^"]*)">/) || [])[1];
    if (!robots) fail(`en/story/${id}: robots 메타태그를 못 찾음`);

    for (const pat of FORBIDDEN_PATTERNS) {
      if (pat.re.test(html)) fail(`en/story/${id}: 금지 요소 발견 — ${pat.what}`);
    }
    checkConsentWiring(html, `en/story/${id}`);

    const hasHreflang = /rel="alternate" hreflang="en"/.test(html);

    if (staleSet.has(id)) {
      // 스테일 페이지: noindex + hreflang 없음 + 번역 본문 없음.
      if (!robots || !robots.includes('noindex')) fail(`en/story/${id}: 재확인 대상인데 noindex가 아님(${robots})`);
      if (hasHreflang) fail(`en/story/${id}: 재확인 대상인데 hreflang이 붙어 있음`);
      if (/<div class="prose">/.test(html)) fail(`en/story/${id}: 재확인 대상인데 영어 번역 본문이 렌더됨`);
    } else {
      if (robots && robots.includes('noindex')) fail(`en/story/${id}: 발행 대상인데 noindex임`);
      if (!hasHreflang) fail(`en/story/${id}: 발행 대상인데 hreflang이 없음`);
      // 상호 hreflang — 한국어 원본이 이 영어 URL을 가리키고 있어야 한다.
      const koPath = path.join(KO_STORY_DIR, id, 'index.html');
      if (fs.existsSync(koPath)) {
        const koHtml = fs.readFileSync(koPath, 'utf8');
        if (!koHtml.includes(`hreflang="en" href="${expected}"`)) {
          fail(`en/story/${id}: 한국어 원본에 역방향 hreflang이 없음(일방향 hreflang)`);
        }
      } else {
        fail(`en/story/${id}: 대응하는 한국어 정적 페이지가 없음(bang/story/${id}/)`);
      }
    }
  }

  // 한국어 페이지가 스테일/미승인 영어 URL을 가리키면 안 된다.
  if (fs.existsSync(KO_STORY_DIR)) {
    for (const id of staleIds) {
      const koPath = path.join(KO_STORY_DIR, id, 'index.html');
      if (fs.existsSync(koPath)) {
        const koHtml = fs.readFileSync(koPath, 'utf8');
        if (koHtml.includes(`hreflang="en" href="${SITE_ORIGIN}/bang/en/story/${id}/"`)) {
          fail(`bang/story/${id}: 재확인 대상 영어 페이지를 hreflang으로 가리키고 있음`);
        }
      }
    }
  }

  // ── sitemap ──────────────────────────────────────────────────────────
  if (!fs.existsSync(EN_SITEMAP_PATH)) fail('bang/en/sitemap.xml이 없음');
  else {
    const xml = fs.readFileSync(EN_SITEMAP_PATH, 'utf8');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    const storyLocs = locs.filter(l => l.includes('/bang/en/story/'));
    const sitemapIds = storyLocs.map(l => (l.match(/\/bang\/en\/story\/([^/]+)\//) || [])[1]).filter(Boolean);

    // 필수 검증 6: URL 수가 승인된 페이지 수와 정확히 일치(영어 홈 1개 포함).
    if (locs.length !== publishableIds.length + 1) {
      fail(`en/sitemap.xml: URL 수(${locs.length})가 발행 작품 수+홈(${publishableIds.length + 1})과 불일치`);
    }
    for (const id of sitemapIds) {
      if (!publishableSet.has(id)) fail(`en/sitemap.xml: 발행 대상이 아닌 작품이 실려 있음 — ${id}`);
      if (!dirIds.includes(id)) fail(`en/sitemap.xml: 실제 생성된 페이지가 없는 URL — ${id}`);
    }
    for (const id of publishableIds) {
      if (!sitemapIds.includes(id)) fail(`en/sitemap.xml: 발행 대상인데 sitemap에 없음 — ${id}`);
    }
    for (const id of staleIds) {
      if (sitemapIds.includes(id)) fail(`en/sitemap.xml: 재확인 대상이 sitemap에 실려 있음(모순된 신호) — ${id}`);
    }
  }

  if (hasFatal) {
    console.error('\n영어 발행 검증 실패 — 배포를 중단합니다(이전 라이브 버전이 그대로 유지됩니다).');
    process.exit(1);
  }
  console.log(`영어 발행 검증 통과 — 발행 ${publishableIds.length}건, 재확인 ${staleIds.length}건, 미승인 스킵 ${manifest.skipped_unapproved || 0}건`);
}

main();
