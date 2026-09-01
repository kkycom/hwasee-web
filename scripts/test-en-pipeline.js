// A-1 영어 발행 파이프라인 로컬 검증 — Firestore 없이 순수 함수와 렌더러,
// 그리고 실제 verify 스크립트를 가짜 산출물로 돌려서 필수 검증 항목을 증명한다.
//
// 실행: node scripts/test-en-pipeline.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const canon = require('../functions/lib/canonical-en.js');
const quota = require('../functions/lib/en-quota.js');
const enBuild = require('./build-en-pages.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, failCount = 0;
const ok = name => { pass++; console.log('  [ok]', name); };
const bad = (name, detail) => { failCount++; console.error('  [FAIL]', name, detail ? '— ' + detail : ''); };
const check = (name, cond, detail) => { cond ? ok(name) : bad(name, detail); };

// 트랜잭션을 직렬 실행하는 최소 가짜 Firestore. 실제 Firestore 트랜잭션도 경합 시
// 재시도로 직렬화되므로, 순차 실행해 예약 누계가 상한을 넘지 않는지 검증한다.
function fakeDb(controlData) {
  const store = new Map();
  if (controlData !== undefined) store.set('translation_control/flags', controlData);
  return {
    collection: c => ({ doc: d => ({ __key: c + '/' + d }) }),
    runTransaction: async fn => fn({
      get: async r => ({ exists: store.has(r.__key), data: () => store.get(r.__key) }),
      set: (r, val, opt) => {
        const prev = (opt && opt.merge && store.get(r.__key)) || {};
        store.set(r.__key, Object.assign({}, prev, val));
      },
    }),
  };
}

// 시스템 임시 디렉터리는 환경에 따라 쓰기 권한이 없을 수 있어(샌드박스·CI)
// 테스트가 검증 단계에 도달하지 못한 채 실패하곤 했다(최종 검토 WARNING).
// 저장소 안의 무시되는 경로를 먼저 쓰고, 그마저 안 되면 tmpdir로 폴백한다.
function makeTempRoot() {
  const local = path.join(ROOT, '.test-tmp');
  try {
    fs.mkdirSync(local, { recursive: true });
    return fs.mkdtempSync(path.join(local, 'en-verify-'));
  } catch (e) {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'en-verify-'));
  }
}

function runVerify(setup) {
  const tmp = makeTempRoot();
  try {
    fs.mkdirSync(path.join(tmp, 'bang', 'en', 'story'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'bang', 'en', 'stories'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'bang', 'story'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'verify-en-pages.js'), path.join(tmp, 'scripts', 'verify-en-pages.js'));
    setup(tmp);
    let code = 0, out = '';
    try {
      out = execFileSync(process.execPath, [path.join(tmp, 'scripts', 'verify-en-pages.js')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      code = e.status == null ? 1 : e.status;
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    return { code, out };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeGood(tmp, ids) {
  const koHtml = id => `<link rel="canonical" href="https://hwasee.me/bang/story/${id}/">\n`
    + `<link rel="alternate" hreflang="ko" href="https://hwasee.me/bang/story/${id}/">\n`
    + `<link rel="alternate" hreflang="en" href="https://hwasee.me/bang/en/story/${id}/">`;
  for (const id of ids) {
    fs.mkdirSync(path.join(tmp, 'bang', 'en', 'story', id), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bang', 'en', 'story', id, 'index.html'),
      enBuild.renderEnStoryPage({ story_id: id, state: 'ok', lastmod: '', title_en: 'T', description_en: 'D', lines_en: ['L'] }));
    fs.mkdirSync(path.join(tmp, 'bang', 'story', id), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bang', 'story', id, 'index.html'), koHtml(id));
  }
  fs.writeFileSync(path.join(tmp, 'bang', 'en', 'stories', 'index.html'),
    enBuild.renderEnIndex(ids.map(id => ({ story_id: id, title_en: 'T', description_en: 'D', lines_en: ['L'] }))));
  fs.writeFileSync(path.join(tmp, 'bang', 'en', 'sitemap.xml'),
    enBuild.renderEnSitemap(ids.map(id => ({ story_id: id, lastmod: '' }))));
  fs.writeFileSync(path.join(tmp, '.en-manifest.json'), JSON.stringify({
    build_completed: true, publishable_ids: ids, stale_ids: [], skipped_unapproved: 0,
  }));
}

async function main() {
  // ── 1. 원문 해시 규칙 ──────────────────────────────────────────────
  console.log('\n[1] 원문 해시 규칙 (스테일 감지의 근거)');
  const subs = a => a.map((c, i) => ({ sub_id: 's' + i, content: c }));
  const h1 = canon.hashCanonical('제목', subs(['첫 문장.', '둘째 문장.']));
  check('같은 원문 → 같은 해시', h1 === canon.hashCanonical('제목', subs(['첫 문장.', '둘째 문장.'])));
  check('공백 차이는 동일 취급(표시상 같은 텍스트)',
    h1 === canon.hashCanonical('제목', subs(['첫  문장.', ' 둘째 문장. '])));
  check('문장이 바뀌면 해시가 달라짐', h1 !== canon.hashCanonical('제목', subs(['첫 문장!', '둘째 문장.'])));
  check('제목이 바뀌면 해시가 달라짐', h1 !== canon.hashCanonical('다른 제목', subs(['첫 문장.', '둘째 문장.'])));
  check('문장 순서가 바뀌면 해시가 달라짐', h1 !== canon.hashCanonical('제목', subs(['둘째 문장.', '첫 문장.'])));

  // ── 2. 킬스위치 · 비용 상한 (필수 검증 3) ──────────────────────────
  console.log('\n[2] 킬스위치와 비용 상한이 실제로 API 호출을 막는지 (필수 검증 3)');
  let r = await quota.reserveEnQuota(fakeDb(undefined));
  check('설정 문서 없음 → 거부(fail-closed)', r.ok === false && r.code === 'no_config', JSON.stringify(r));

  r = await quota.reserveEnQuota(fakeDb({ translation_enabled: false, hourly_limit: 30, daily_limit: 300 }));
  check('킬스위치 off → 거부', r.ok === false && r.code === 'disabled', JSON.stringify(r));

  r = await quota.reserveEnQuota(fakeDb({ translation_enabled: true, hourly_limit: 30, daily_limit: -1 }));
  check('음수 상한 → 거부(손상된 설정)', r.ok === false && r.code === 'no_config', JSON.stringify(r));

  r = await quota.reserveEnQuota(fakeDb({ translation_enabled: 'yes', hourly_limit: 30, daily_limit: 300 }));
  check('필드 타입 손상 → 거부', r.ok === false && r.code === 'no_config', JSON.stringify(r));

  {
    const db = fakeDb({ translation_enabled: true, hourly_limit: 30, daily_limit: 300 });
    let granted = 0, denied = 0, code = null;
    for (let i = 0; i < 31; i++) {
      const res = await quota.reserveEnQuota(db);
      if (res.ok) granted++; else { denied++; code = res.code; }
    }
    check('시간당 상한 30 → 31회 시도 중 정확히 30건만 통과', granted === 30 && denied === 1, `granted=${granted}`);
    check('초과분은 hourly_limit으로 거부', code === 'hourly_limit', String(code));
  }
  {
    const db = fakeDb({ translation_enabled: true, hourly_limit: 100, daily_limit: 2 });
    const a = await quota.reserveEnQuota(db);
    const b = await quota.reserveEnQuota(db);
    const c = await quota.reserveEnQuota(db);
    check('시간 상한은 남고 일일 상한만 소진 → daily_limit으로 거부',
      a.ok && b.ok && !c.ok && c.code === 'daily_limit', JSON.stringify([a.code || 'ok', b.code || 'ok', c.code]));
  }

  // ── 3. 발행 게이트 3중 판정 ────────────────────────────────────────
  console.log('\n[3] 발행 게이트 — 승인 + 해시일치 + 승인본 일치');
  const decide = t => {
    if (t.en_publish_approved !== true) return 'skip';
    const approvedMatches = t.approved_source_hash && t.approved_source_hash === t.source_text_hash;
    return (t.current === t.source_text_hash && approvedMatches) ? 'publish' : 'stale';
  };
  check('미승인 → 발행 안 함(파일 미생성 → 404)',
    decide({ en_publish_approved: false, source_text_hash: 'a', approved_source_hash: 'a', current: 'a' }) === 'skip');
  check('승인 + 해시일치 + 승인본일치 → 발행',
    decide({ en_publish_approved: true, source_text_hash: 'a', approved_source_hash: 'a', current: 'a' }) === 'publish');
  check('원문이 바뀜 → 재확인 대상',
    decide({ en_publish_approved: true, source_text_hash: 'a', approved_source_hash: 'a', current: 'b' }) === 'stale');
  check('재번역 후 재승인 전 → 재확인 대상(자동 공개 안 됨)',
    decide({ en_publish_approved: true, source_text_hash: 'b', approved_source_hash: 'a', current: 'b' }) === 'stale');

  // ── 4. 생성 HTML의 성질 ────────────────────────────────────────────
  console.log('\n[4] 생성되는 HTML의 성질');
  const okItem = {
    story_id: 'story_ok', state: 'ok', lastmod: '2026-08-01T00:00:00.000Z',
    title_en: 'The Lighthouse That Waited',
    description_en: 'A lighthouse keeper receives a letter that should not exist.',
    lines_en: ['The lamp went out at midnight.', 'Nobody had touched it.'],
  };
  const okHtml = enBuild.renderEnStoryPage(okItem);
  const staleHtml = enBuild.renderEnStoryPage({ story_id: 'story_stale', state: 'stale' });
  const indexHtml = enBuild.renderEnIndex([okItem]);

  const forbidden = [/<button\b/i, /<input\b/i, /<form\b/i, /<textarea\b/i, /<select\b/i, /role\s*=\s*"button"/i, /\son[a-z]+\s*=/i];
  const hits = [];
  for (const h of [okHtml, staleHtml, indexHtml]) {
    for (const re of forbidden) if (re.test(h)) hits.push(re.source);
  }
  check('참여 요소(버튼·입력·폼·핸들러) 전무 (필수 검증 5)', hits.length === 0, hits.join(', '));
  check('광고 스크립트 없음', !/adsbygoogle/i.test(okHtml + indexHtml));
  check('서비스워커 등록 없음', !/serviceWorker/i.test(okHtml + indexHtml));

  const cs = [...okHtml.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map(m => m[1]);
  check('canonical이 정확히 1개이고 자기 자신 (필수 검증 4)',
    cs.length === 1 && cs[0] === 'https://hwasee.me/bang/en/story/story_ok/', cs.join(','));
  check('한국어 원문과 hreflang 상호 연결',
    okHtml.includes('hreflang="ko" href="https://hwasee.me/bang/story/story_ok/"')
    && okHtml.includes('hreflang="en" href="https://hwasee.me/bang/en/story/story_ok/"'));
  check('한국어 원문 보기 링크 존재', okHtml.includes('/bang/story/story_ok/'));
  check('발행 페이지는 index,follow', okHtml.includes('content="index,follow"'));
  check('번역 본문이 렌더됨', okHtml.includes('The lamp went out at midnight.'));
  check('릴레이 방식 설명이 페이지에 있음', /one sentence at a time/i.test(okHtml));

  check('스테일 페이지는 noindex,follow (필수 검증 2)', staleHtml.includes('content="noindex,follow"'));
  check('스테일 페이지에 hreflang 없음', !/rel="alternate"/.test(staleHtml));
  check('스테일 페이지에 번역 본문 없음', !staleHtml.includes('<div class="prose">'));
  check('스테일 페이지는 재확인 중임을 표시', /re-checked/i.test(staleHtml));

  const sm = enBuild.renderEnSitemap([okItem]);
  check('sitemap URL 수 = 발행 1건 + 영어 홈 1 (필수 검증 6)', [...sm.matchAll(/<loc>/g)].length === 2);
  check('발행 0건이면 sitemap에 영어 홈만', [...enBuild.renderEnSitemap([]).matchAll(/<loc>/g)].length === 1);

  const evil = enBuild.renderEnStoryPage({
    story_id: 'x', state: 'ok', lastmod: '',
    title_en: '</script><script>alert(1)</script>',
    description_en: '"><img src=x onerror=alert(1)>',
    lines_en: ['<script>alert(2)</script>'],
  });
  check('JSON-LD에 </script> 이스케이프됨', !/<\/script><script>alert\(1\)/.test(evil));
  check('본문에 raw <script> 삽입 안 됨', !evil.includes('<script>alert(2)</script>'));

  // ── 5. verify 스크립트 실제 실행 ───────────────────────────────────
  console.log('\n[5] verify-en-pages.js 실제 동작(배포 차단 게이트)');
  let v = runVerify(tmp => writeGood(tmp, ['a']));
  check('정상 산출물 → 통과', v.code === 0, v.out.slice(0, 300));

  v = runVerify(tmp => {
    writeGood(tmp, ['a']);
    fs.mkdirSync(path.join(tmp, 'bang', 'en', 'story', 'sneaky'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bang', 'en', 'story', 'sneaky', 'index.html'),
      enBuild.renderEnStoryPage({ story_id: 'sneaky', state: 'ok', lastmod: '', title_en: 'X', description_en: 'X', lines_en: ['X'] }));
  });
  check('미승인 페이지가 섞이면 배포 차단 (필수 검증 1)', v.code !== 0 && /미승인 노출 의심/.test(v.out), v.out.slice(0, 200));

  v = runVerify(tmp => {
    writeGood(tmp, ['a']);
    fs.writeFileSync(path.join(tmp, 'bang', 'en', 'sitemap.xml'),
      enBuild.renderEnSitemap([{ story_id: 'a', lastmod: '' }, { story_id: 'ghost', lastmod: '' }]));
  });
  check('sitemap URL 수 불일치 → 배포 차단 (필수 검증 6)', v.code !== 0 && /URL 수/.test(v.out), v.out.slice(0, 200));

  v = runVerify(tmp => {
    writeGood(tmp, ['a']);
    fs.writeFileSync(path.join(tmp, 'bang', 'story', 'a', 'index.html'),
      '<link rel="canonical" href="https://hwasee.me/bang/story/a/">');
  });
  check('일방향 hreflang → 배포 차단', v.code !== 0 && /역방향 hreflang/.test(v.out), v.out.slice(0, 200));

  v = runVerify(tmp => {
    const id = 's1';
    fs.mkdirSync(path.join(tmp, 'bang', 'en', 'story', id), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bang', 'en', 'story', id, 'index.html'),
      enBuild.renderEnStoryPage({ story_id: id, state: 'stale' }));
    fs.writeFileSync(path.join(tmp, 'bang', 'en', 'stories', 'index.html'), enBuild.renderEnIndex([]));
    fs.writeFileSync(path.join(tmp, 'bang', 'en', 'sitemap.xml'), enBuild.renderEnSitemap([]));
    fs.writeFileSync(path.join(tmp, '.en-manifest.json'), JSON.stringify({
      build_completed: true, publishable_ids: [], stale_ids: [id], skipped_unapproved: 0,
    }));
  });
  check('스테일만 있는 빌드 → 통과(페이지는 유지, sitemap에선 제외) (필수 검증 2)', v.code === 0, v.out.slice(0, 300));

  v = runVerify(tmp => { writeGood(tmp, ['a']); fs.rmSync(path.join(tmp, '.en-manifest.json')); });
  check('완료 마커 없는데 bang/en/story/ 존재 → 배포 차단', v.code !== 0 && /완료 마커/.test(v.out), v.out.slice(0, 200));

  v = runVerify(tmp => { fs.rmSync(path.join(tmp, 'bang', 'en', 'story'), { recursive: true, force: true }); });
  check('영어 빌드 미실행 → 통과(검사 대상 없음)', v.code === 0, v.out.slice(0, 200));

  console.log(`\n결과: ${pass} 통과 / ${failCount} 실패`);
  if (failCount) process.exit(1);
}

main().catch(e => { console.error('테스트 실행 실패:', e); process.exit(1); });
