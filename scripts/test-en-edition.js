// English 에디션 격리 검증 — Firestore 없이 가짜 db로 서버 로직의 컬렉션 접근을 추적한다.
//
// 이 테스트가 지키려는 것 두 가지:
//  1) A-2 회귀 보존 — 한국 제출 경로가 공용화 이후에도 예전과 정확히 같은 컬렉션만 쓴다.
//  2) 에디션 격리 — 영어 경로는 _en 컬렉션만 쓰고, 클라이언트가 보낸 값으로는
//     컬렉션 경로를 절대 바꿀 수 없다.
//
// 실행: node scripts/test-en-edition.js

const path = require('path');
const editions = require('../functions/lib/editions.js');
const gate = require('../functions/lib/auto-task-gate.js');
const seeds = require('../functions/lib/en-seeds.js');

let pass = 0, failCount = 0;
const ok = n => { pass++; console.log('  [ok]', n); };
const bad = (n, d) => { failCount++; console.error('  [FAIL]', n, d ? '— ' + d : ''); };
const check = (n, cond, d) => { cond ? ok(n) : bad(n, d); };

// ── 컬렉션 접근을 기록하는 가짜 Firestore ────────────────────────────────
function makeFakeDb(seed) {
  const touched = new Set();
  const store = new Map(Object.entries(seed || {}));
  const writes = [];

  const q = (name) => {
    const chain = {
      __col: name,
      where: () => chain, orderBy: () => chain, limit: () => chain,
      doc: (id) => {
        const ref = { __col: name, __id: id || ('auto_' + Math.random().toString(36).slice(2)) };
        // 트랜잭션 밖에서 쓰이는 경로(used_openings 마킹 등)도 실제 코드와 같은
        // 모양이어야 한다 — 지원하지 않으면 예외가 나고 코드가 그걸 삼켜서
        // 테스트가 "정상"과 "조용히 실패"를 구별하지 못한다.
        ref.get = async () => ({
          exists: store.has(ref.__col + '/' + ref.__id),
          data: () => store.get(ref.__col + '/' + ref.__id),
          id: ref.__id,
        });
        ref.set = async (val, opt) => {
          const prev = (opt && opt.merge && store.get(ref.__col + '/' + ref.__id)) || {};
          writes.push({ op: 'set', col: ref.__col, val });
          store.set(ref.__col + '/' + ref.__id, Object.assign({}, prev, val));
        };
        ref.update = async (val) => { writes.push({ op: 'update', col: ref.__col, val }); };
        return ref;
      },
    };
    return chain;
  };
  const collection = (name) => { touched.add(name); return q(name); };

  const snapFor = (ref) => {
    const key = ref.__col + '/' + ref.__id;
    return { exists: store.has(key), data: () => store.get(key), id: ref.__id };
  };
  const querySnap = (ref) => {
    const docs = [...store.entries()]
      .filter(([k]) => k.startsWith(ref.__col + '/'))
      .map(([k, v]) => ({ id: k.split('/')[1], data: () => v }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  };

  return {
    __touched: touched,
    __writes: writes,
    collection,
    runTransaction: async (fn) => fn({
      get: async (ref) => (ref.__id ? snapFor(ref) : querySnap(ref)),
      set: (ref, val) => { writes.push({ op: 'set', col: ref.__col, val }); store.set(ref.__col + '/' + ref.__id, val); },
      update: (ref, val) => { writes.push({ op: 'update', col: ref.__col, val }); },
    }),
  };
}

// ── 1. 컬렉션 맵 ────────────────────────────────────────────────────────
console.log('\n[1] 에디션 컬렉션 맵');
check('한국 맵은 기존 컬렉션 이름을 그대로 쓴다',
  editions.KO.stories === 'stories' && editions.KO.episodes === 'episodes'
  && editions.KO.submissions === 'submissions' && editions.KO.votes === 'votes');
check('영어 맵은 전부 _en 접미사',
  editions.EN.stories === 'stories_en' && editions.EN.episodes === 'episodes_en'
  && editions.EN.submissions === 'submissions_en' && editions.EN.votes === 'votes_en');
check('포인트 장부가 에디션별로 분리됨 (결정 2)',
  editions.KO.pointLedger === 'point_ledger' && editions.EN.pointLedger === 'point_ledger_en');
check('알림 저장소가 에디션별로 분리됨 (결정 3)',
  editions.KO.notifications === 'notifications' && editions.EN.notifications === 'notifications_en');
check('영어 사용자 통계는 users가 아닌 전용 컬렉션',
  editions.KO.userStats === null && editions.EN.userStats === 'user_stats_en');
check('Today 슬롯 포인터가 분리됨',
  editions.KO.slotsDoc.collection === 'config' && editions.EN.slotsDoc.collection === 'en_spotlight');

{
  // 두 맵이 같은 컬렉션 이름을 공유하면 격리가 깨진다.
  const koNames = Object.entries(editions.KO).filter(([, v]) => typeof v === 'string' && v !== 'ko').map(([, v]) => v);
  const enNames = Object.entries(editions.EN).filter(([, v]) => typeof v === 'string' && v !== 'en').map(([, v]) => v);
  const overlap = koNames.filter(n => enNames.includes(n));
  check('한국·영어 컬렉션 이름이 하나도 겹치지 않음', overlap.length === 0, overlap.join(', '));
}
{
  let threw = false;
  try { editions.editionCols('xx'); } catch (e) { threw = true; }
  check('알 수 없는 에디션은 조용히 ko로 폴백하지 않고 던진다', threw);
}

// ── 2. 제출 코어의 실제 컬렉션 접근 ─────────────────────────────────────
async function main() {
console.log('\n[2] 제출 코어 — A-2 회귀 보존과 에디션 격리');

// functions/index.js를 통째로 require하면 firebase-functions 초기화가 필요하므로,
// core 함수만 소스에서 떼어내 격리 실행한다.
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
const startIdx = src.indexOf('async function _submitEpisodeCore');
const endIdx = src.indexOf('// 한국판 제출 — 기존 Callable 이름');
check('core 함수를 소스에서 찾을 수 있음', startIdx !== -1 && endIdx > startIdx);

const coreSrc = src.slice(startIdx, endIdx);
// core가 참조하는 외부 심볼을 최소 스텁으로 채워 격리 실행한다.
const stubs = `
const functions = { https: { HttpsError: class extends Error { constructor(c, m) { super(m); } } } };
const admin = { firestore: () => db };
async function _requireUser() {}
function _activeBan() { return null; }
function _submitMaxChars() { return 300; }
function _pointsApplicable() { return true; }
function _txPointFields(d, amt) { return { total_points: (Number(d.total_points)||0) + amt, badge: 'seed' }; }
function _txLedger(db, tx, uid, pts, reason, sub_id, ledger) { tx.set(db.collection(ledger || 'point_ledger').doc(), {}); }
async function _serverCheckAchievements() {}
const MODE_ACHIEVEMENT_CATEGORY = {};
const SUBMIT_RATE_HOURLY_MAX = 30, SUBMIT_RATE_DAILY_MAX = 60;
`;
// new Function 스코프에는 require가 없으므로 모듈을 인자로 주입한다.
const factory = new Function('db', 'cols', 'data', '_EDITIONS',
  stubs + coreSrc + '\nreturn _submitEpisodeCore(db, cols, data);');

async function runSubmit(cols, extraData) {
  const epCol = cols.episodes, stCol = cols.stories;
  const db = makeFakeDb({
    [`${epCol}/ep1`]: { status: 'open', step: 1, story_id: 'st1' },
    [`${stCol}/st1`]: { status: 'active', open_steps: {}, participant_count: 0 },
    'users/u1': { display_name: 'Tester', badge: 'seed', total_points: 0, submission_count: 0 },
  });
  const res = await factory(db, cols, Object.assign({
    episode_id: 'ep1', user_id: 'u1', content: 'A sentence.', token: 't',
  }, extraData || {}), editions);
  return { db, res };
}

{
  // 제출 경로에서 조용히 삼켜진 오류가 없는지 확인한다(가짜 db 미지원으로
  // 실제 버그가 가려지던 문제 — 최종 검토 WARNING).
  const origErr = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const probe = await runSubmit(editions.KO);
  console.error = origErr;
  check('한국 제출 경로에서 삼켜진 오류가 없다', errors.length === 0, errors.join(' | '));
  check('제출이 정상 성공', probe.res && probe.res.ok === true);
}
{
  const { db, res } = await runSubmit(editions.KO);
  const t = [...db.__touched];
  check('한국 제출이 성공한다', res && res.ok === true, JSON.stringify(res));
  check('한국 경로는 submissions/episodes/stories를 쓴다 (A-2 보존)',
    t.includes('submissions') && t.includes('episodes') && t.includes('stories'), t.join(','));
  check('한국 경로는 users 문서에 포인트를 쓴다',
    db.__writes.some(w => w.op === 'update' && w.col === 'users'));
  check('한국 경로는 point_ledger를 쓴다', t.includes('point_ledger'));
  check('한국 경로가 _en 컬렉션을 전혀 건드리지 않음',
    !t.some(n => n.endsWith('_en')), t.filter(n => n.endsWith('_en')).join(','));
}
{
  const { db, res } = await runSubmit(editions.EN);
  const t = [...db.__touched];
  check('영어 제출이 성공한다', res && res.ok === true, JSON.stringify(res));
  check('영어 경로는 _en 컬렉션만 쓴다',
    t.includes('submissions_en') && t.includes('episodes_en') && t.includes('stories_en'), t.join(','));
  check('영어 경로가 한국 이야기 컬렉션을 건드리지 않음',
    !t.includes('submissions') && !t.includes('episodes') && !t.includes('stories'), t.join(','));
  check('영어 포인트는 point_ledger_en으로 (한국 장부 무오염)',
    t.includes('point_ledger_en') && !t.includes('point_ledger'));
  check('영어 통계는 user_stats_en에 쓰고 users 문서는 안 고침 (결정 2)',
    db.__writes.some(w => w.col === 'user_stats_en')
    && !db.__writes.some(w => w.op === 'update' && w.col === 'users'));
  check('영어 경로도 users는 읽는다(계정·차단 확인은 공유)', t.includes('users'));
}
{
  // 클라이언트가 어떤 값을 넣어도 컬렉션 경로가 바뀌면 안 된다 (결정 1).
  const { db } = await runSubmit(editions.KO, {
    edition: 'en', collection: 'stories_en', cols: editions.EN, submissions: 'submissions_en',
  });
  const t = [...db.__touched];
  check('클라이언트가 edition/collection을 보내도 한국 경로가 유지됨 (결정 1)',
    t.includes('submissions') && !t.some(n => n.endsWith('_en')), t.join(','));
}

// ── 2-B. 마감 재개 가능성 · 인덱스 정의 ─────────────────────────────────
console.log('');
console.log('[2-B] 마감 재개(idempotent)와 인덱스 정의');
{
  const src2 = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  const closeSrc = src2.slice(src2.indexOf('async function _enCloseEpisode'), src2.indexOf('exports.closeEpisodeEn'));

  check('마감 선점 시 close_finalized:false를 남긴다', closeSrc.includes('close_finalized: false'));
  check('이미 닫혔어도 후속 처리가 미완이면 resume으로 재개한다',
    closeSrc.includes("close_finalized === true ? 'already_closed' : 'resume'"));
  check('resume도 후속 처리를 계속한다',
    closeSrc.includes("closeResult !== 'closed' && closeResult !== 'resume'"));
  check('채택과 보상이 한 트랜잭션에서 처리된다(중간 실패로 보상 누락 없음)',
    closeSrc.includes('adopt_rewarded') && closeSrc.includes('is_adopted: true, adopt_rewarded: true'));
  // 1.5단계에서 동률 분기가 들어오면서 ID가 승자별로 파생된다
  // (episode_id + '__next__' + winnerId). 여전히 결정적이라 재실행·동시실행이
  // 같은 문서를 쓴다는 성질은 그대로다.
  check('후속 생성물이 결정적 문서 ID를 쓴다(동시 실행에도 중복 없음)',
    closeSrc.includes("episode_id + '__next__'") && closeSrc.includes("episode_id + '__end__'"));
  const finalizedWrites = closeSrc.split('close_finalized: true').length - 1;
  check('완결·다음단계·재개 경로 모두 close_finalized:true를 기록', finalizedWrites >= 3, 'found ' + finalizedWrites);

  const createSrc = src2.slice(src2.indexOf('exports.createStoryEn'));
  check('이야기 시작 제한이 트랜잭션으로 원자화됨(동시 호출 우회 차단)',
    createSrc.includes('runTransaction') && createSrc.includes('create_bucket'));
  check('이야기 시작이 복합 인덱스가 필요한 쿼리를 쓰지 않음',
    !createSrc.includes("where('creator_id'"));
}
{
  // 영어 컬렉션 쿼리에 필요한 복합 인덱스가 정의돼 있는지.
  const idx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bang', 'firestore.indexes.json'), 'utf8'));
  const hasIdx = (group, fields) => idx.indexes.some(i =>
    i.collectionGroup === group &&
    fields.every((f, n) => i.fields[n] && i.fields[n].fieldPath === f));
  check('submissions_en(author_id + created_at) 인덱스 정의됨 — 없으면 영어 제출이 실패',
    hasIdx('submissions_en', ['author_id', 'created_at']));
  check('stories_en(status + participant_count) 인덱스 정의됨 — hot 슬롯용',
    hasIdx('stories_en', ['status', 'participant_count']));
  check('한국판 인덱스가 그대로 남아 있음',
    hasIdx('submissions', ['author_id', 'created_at']) && hasIdx('stories', ['status', 'participant_count']));
}
{
  // 민감 컬렉션이 공개 읽기로 열려 있지 않은지.
  const rules = fs.readFileSync(path.join(__dirname, '..', 'bang', 'firestore.rules'), 'utf8');
  const denied = n => rules.includes('match /' + n + '/{docId}') &&
    rules.split('match /' + n + '/{docId}')[1].slice(0, 90).includes('allow read, write: if false');
  check('알림·포인트장부·사용자통계가 공개 읽기가 아님',
    denied('notifications_en') && denied('point_ledger_en') && denied('user_stats_en'));
  check('bookmarks_en은 읽기까지 차단', denied('bookmarks_en'));
  check('영어 이야기 그래프는 클라이언트 쓰기 차단',
    rules.includes('match /stories_en/{docId}     { allow read: if true; allow write: if false; }')
    && rules.includes('match /submissions_en/{docId} { allow read: if true; allow write: if false; }'));
}

// ── 2-C. 마감 경로 실행 수준 검증 ───────────────────────────────────────
// 소스 패턴 검사만으로는 동시성·중간 실패를 못 잡는다는 지적을 받아, 실제로
// _enCloseEpisode를 격리 실행해 재개·동시 호출 결과를 확인한다.
console.log('');
console.log('[2-C] 마감 경로 실행 — 재개·동시 호출 시 중복이 없는지');
{
  const src3 = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  // _enCloseEpisode는 1.5단계부터 스핀오프 헬퍼들과 함께 동작하므로 블록 전체를
  // 떼어낸다(EN_VOTE_THRESHOLD부터 — 상수와 헬퍼가 그 안에 있다).
  const closeSrc = src3.slice(src3.indexOf('const EN_VOTE_THRESHOLD'),
                              src3.indexOf('// 영어 에피소드 마감 — 클라이언트가'));

  const stubs = [
    "const admin = { firestore: { FieldValue: { delete: () => '__DEL__' } } };",
    "function _pointsApplicable(id) { return !!id && id !== 'AI'; }",
    "function _txLedger(db, tx, uid, pts, reason, sub_id, ledger) {",
    "  tx.set(db.collection(ledger).doc('L' + (db.__ledgerSeq++)), { user_id: uid, points: pts, reason });",
    "}",
    "async function _enRefillSlotOnComplete() { return null; }",
    // 스핀오프가 분기 단계 표시 계산에 쓴다(에디션과 무관한 순수 함수).
    "function _calcDisplayStepBackend(s, epStep) {",
    "  if (s.branch_display_offset !== undefined && s.branch_display_offset !== null)",
    "    return Number(s.branch_display_offset) + Number(epStep);",
    "  if (s.branch_from_step) return (Number(s.branch_from_step) - 1) + Number(epStep);",
    "  return Number(epStep) + 1;",
    "}",
    "const FB_AI_ID = 'AI';",
  ].join('\n');

  const makeClose = new Function('db', 'episode_id', 'ep', '_EDITIONS',
    stubs + closeSrc + '\nreturn _enCloseEpisode(db, episode_id, ep);');

  // 트랜잭션을 직렬 실행하는 가짜 Firestore. 실제 Firestore도 경합 시 재시도로
  // 직렬화되므로, 이 실행 결과가 동시 호출의 최종 상태를 대변한다.
  function closeDb(seed) {
    const store = new Map(Object.entries(seed));
    const ver = new Map(); // 문서별 버전 — 트랜잭션 충돌 판정용
    // 실제 Firestore처럼 where 필터를 적용하고 각 문서에 ref를 붙인다.
    // (스핀오프가 조회 결과의 d.ref로 batch update를 걸기 때문에 둘 다 필요하다.
    //  없으면 실제로는 나지 않는 오류가 테스트에서만 난다.)
    function qsnap(name, filters) {
      const docs = [...store.entries()].filter(([k]) => k.startsWith(name + '/'))
        .map(([k, v]) => ({ id: k.slice(name.length + 1), data: () => v, ref: { __col: name, __id: k.slice(name.length + 1) } }))
        .filter(d => (filters || []).every(([f, v]) => d.data()[f] === v));
      return { docs, size: docs.length, empty: !docs.length };
    }
    const db = {
      __ledgerSeq: 1,
      __store: store,
      collection: (name) => {
        const mk = (filters) => ({
          __col: name, __filters: filters,
          where: (f, op, v) => mk(filters.concat([[f, v]])),
          orderBy: () => mk(filters), limit: () => mk(filters),
          doc: (id) => chain.doc(id),
          get: async () => qsnap(name, filters),
        });
        const chain = {
          __col: name, __filters: [],
          where: (f, op, v) => mk([[f, v]]),
          orderBy: () => chain, limit: () => chain,
          doc: (id) => {
            const ref = { __col: name, __id: id };
            const k = name + '/' + id;
            ref.get = async () => ({ exists: store.has(k), data: () => store.get(k), id });
            ref.update = async (v) => {
              store.set(k, Object.assign({}, store.get(k) || {}, v));
              ver.set(k, (ver.get(k) || 0) + 1);
            };
            ref.set = async (v, o) => {
              const prev = (o && o.merge && store.get(k)) || {};
              store.set(k, Object.assign({}, prev, v));
              ver.set(k, (ver.get(k) || 0) + 1);
            };
            return ref;
          },
          get: async () => qsnap(name, chain.__filters),
        };
        return chain;
      },
      // 실제 Firestore 트랜잭션과 같은 낙관적 동시성: 읽은 문서가 커밋 전에
      // 바뀌었으면 재시도한다. 이게 없으면 병렬 호출이 서로의 쓰기를 못 봐서
      // 실제로는 나지 않는 중복이 테스트에서만 발생한다.
      runTransaction: async (fn) => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const readVers = new Map();
          const pending = [];
          const res = await fn({
            get: async (r) => {
              if (!r.__id) return qsnap(r.__col, r.__filters);
              const k = r.__col + '/' + r.__id;
              readVers.set(k, ver.get(k) || 0);
              return { exists: store.has(k), data: () => store.get(k) };
            },
            set: (r, v, o) => pending.push(['set', r.__col + '/' + r.__id, v, o]),
            update: (r, v) => pending.push(['update', r.__col + '/' + r.__id, v]),
          });
          let stale = false;
          for (const [k, v0] of readVers) if ((ver.get(k) || 0) !== v0) { stale = true; break; }
          if (stale) continue; // 충돌 — 처음부터 다시
          for (const [op, k, v, o] of pending) {
            const prev = (op === 'set' && !(o && o.merge)) ? {} : (store.get(k) || {});
            store.set(k, Object.assign({}, prev, v));
            ver.set(k, (ver.get(k) || 0) + 1);
          }
          return res;
        }
        throw new Error('transaction retry limit');
      },
      batch: () => {
        const ops = [];
        return {
          set: (r, v, o) => ops.push(['set', r, v, o]),
          update: (r, v) => ops.push(['update', r, v]),
          commit: async () => ops.forEach(([op, r, v, o]) => {
            const k = r.__col + '/' + r.__id;
            if (op === 'set') {
              const prev = (o && o.merge && store.get(k)) || {};
              store.set(k, Object.assign({}, prev, v));
            } else {
              store.set(k, Object.assign({}, store.get(k) || {}, v));
            }
            ver.set(k, (ver.get(k) || 0) + 1);
          }),
        };
      },
    };
    return db;
  }

  const seedFor = () => ({
    'episodes_en/ep1': { episode_id: 'ep1', story_id: 'st1', step: 1, status: 'open' },
    'stories_en/st1': { story_id: 'st1', status: 'active', current_step: 0, max_steps: 10, open_steps: {}, vote_threshold: 2 },
    'submissions_en/w1': { sub_id: 'w1', episode_id: 'ep1', story_id: 'st1', author_id: 'u1',
      content: 'A sentence.', vote_count: 3, is_adopted: false, created_at: '2026-01-01T00:00:00Z' },
    'submissions_en/w2': { sub_id: 'w2', episode_id: 'ep1', story_id: 'st1', author_id: 'u2',
      content: 'Another.', vote_count: 1, is_adopted: false, created_at: '2026-01-01T00:01:00Z' },
  });

  const ledgerCount = db => [...db.__store.keys()].filter(k => k.startsWith('point_ledger_en/')).length;
  const nextEps = db => [...db.__store.entries()]
    .filter(([k, v]) => k.startsWith('episodes_en/') && v && v.parent_sub_id === 'w1').length;

  {
    const db = closeDb(seedFor());
    const r1 = await makeClose(db, 'ep1', db.__store.get('episodes_en/ep1'), editions);
    check('임계값 도달 시 마감된다', r1 === 'closed', String(r1));
    check('승자가 채택된다', db.__store.get('submissions_en/w1').is_adopted === true);
    check('보상이 1회 지급된다', ledgerCount(db) === 1, 'ledger=' + ledgerCount(db));
    check('다음 단계가 1개 생성된다', nextEps(db) === 1, 'next=' + nextEps(db));
    check('마감 완료 표시가 남는다', db.__store.get('episodes_en/ep1').close_finalized === true);

    const r2 = await makeClose(db, 'ep1', db.__store.get('episodes_en/ep1'), editions);
    check('완료된 마감을 다시 호출하면 already_closed', r2 === 'already_closed', String(r2));
    check('재호출해도 보상이 늘지 않는다', ledgerCount(db) === 1, 'ledger=' + ledgerCount(db));
    check('재호출해도 다음 단계가 늘지 않는다', nextEps(db) === 1, 'next=' + nextEps(db));
  }

  {
    const db = closeDb(seedFor());
    db.__store.set('episodes_en/ep1', Object.assign({}, db.__store.get('episodes_en/ep1'),
      { status: 'closed', close_finalized: false }));
    const r = await makeClose(db, 'ep1', db.__store.get('episodes_en/ep1'), editions);
    check('선점만 된 상태에서 재호출하면 후속 처리를 재개한다', r === 'closed', String(r));
    check('재개 후 승자가 채택된다', db.__store.get('submissions_en/w1').is_adopted === true);
    check('재개 시 보상이 정확히 1회', ledgerCount(db) === 1, 'ledger=' + ledgerCount(db));
    check('재개 시 다음 단계가 정확히 1개', nextEps(db) === 1, 'next=' + nextEps(db));
  }

  {
    // 채택은 됐지만 보상 전에 죽은 경우 — 보상이 영구 누락되면 안 된다.
    const db = closeDb(seedFor());
    db.__store.set('episodes_en/ep1', Object.assign({}, db.__store.get('episodes_en/ep1'),
      { status: 'closed', close_finalized: false }));
    db.__store.set('submissions_en/w1', Object.assign({}, db.__store.get('submissions_en/w1'),
      { is_adopted: true }));
    await makeClose(db, 'ep1', db.__store.get('episodes_en/ep1'), editions);
    check('채택 후 보상 전에 중단됐어도 재개하면 보상이 지급된다', ledgerCount(db) === 1,
      'ledger=' + ledgerCount(db));
  }

  {
    const db = closeDb(seedFor());
    db.__store.set('episodes_en/ep1', Object.assign({}, db.__store.get('episodes_en/ep1'),
      { status: 'closed', close_finalized: false }));
    const ep = db.__store.get('episodes_en/ep1');
    await Promise.all([
      makeClose(db, 'ep1', ep, editions),
      makeClose(db, 'ep1', ep, editions),
    ]);
    check('동시 재개 2건에도 보상은 1회', ledgerCount(db) === 1, 'ledger=' + ledgerCount(db));
    check('동시 재개 2건에도 다음 단계는 1개(결정적 ID)', nextEps(db) === 1, 'next=' + nextEps(db));
  }

  {
    const seed = seedFor();
    // 1.5단계부터 "이 에피소드가 스토리의 다음 정경 단계인가"를 검사하므로,
    // 마지막 단계 마감을 재현하려면 에피소드 step도 current_step+1이어야 한다.
    // (예전 시드는 current_step 9에 step 1짜리 에피소드였는데, 그건 실제로는
    //  뒤늦게 마감된 버려진 갈래라서 이제 스핀오프로 분류된다 — 의도된 변화다.)
    seed['stories_en/st1'] = Object.assign({}, seed['stories_en/st1'], { current_step: 9, max_steps: 10 });
    seed['episodes_en/ep1'] = Object.assign({}, seed['episodes_en/ep1'], { step: 10 });
    const db = closeDb(seed);
    const r = await makeClose(db, 'ep1', db.__store.get('episodes_en/ep1'), editions);
    check('최대 단계에 도달하면 완결된다', r === 'completed', String(r));
    check('완결 시 story.status가 completed', db.__store.get('stories_en/st1').status === 'completed');
  }
}

// ── 3. 자동 작업 게이트 ─────────────────────────────────────────────────
console.log('\n[3] 자동 작업 게이트');
check('완결작 다듬기는 ko 전용 — 영어를 대상으로 삼지 않음 (비용·본문 변경 차단)',
  gate.isEditionAllowed('ai_review_completed', 'ko') === true
  && gate.isEditionAllowed('ai_review_completed', 'en') === false);
check('AI 자동참여도 ko 전용',
  gate.isEditionAllowed('ai_participate', 'en') === false);
check('제목 생성·장르 분류는 양쪽 대상',
  gate.isEditionAllowed('generate_title', 'en') && gate.isEditionAllowed('classify_genre', 'en'));
check('번역은 한국 완결작을 원본으로 삼음',
  gate.isEditionAllowed('translate_to_en', 'ko') && !gate.isEditionAllowed('translate_to_en', 'en'));
{
  let threw = false;
  try { gate.isEditionAllowed('brand_new_task', 'ko'); } catch (e) { threw = true; }
  check('등록되지 않은 자동 작업은 던진다(대상 미선언 방지)', threw);
}
{
  const r = gate.shouldProcessStory('ai_review_completed', 'en', { status: 'completed' });
  check('영어 완결작은 한국 다듬기 대상에서 제외됨', r.ok === false && r.reason === 'edition_not_targeted');
}
{
  const r = gate.shouldProcessStory('ai_review_completed', 'ko', { status: 'completed', auto_tasks_disabled: true });
  check('관리자가 끈 이야기는 자동 처리에서 빠짐', r.ok === false && r.reason === 'disabled_on_story');
}
{
  const r = gate.shouldProcessStory('ai_review_completed', 'ko', { status: 'completed' }, { requireStatus: 'completed' });
  check('정상 대상은 통과', r.ok === true);
}

// ── 4. 승인된 씨앗 세트 ─────────────────────────────────────────────────
console.log('\n[4] 승인된 씨앗 세트 무결성');
check('일반 오프닝 40', seeds.EN_OPENINGS.length === 40);
check('초스피드 16', seeds.EN_SPEEDRUN_OPENINGS.length === 16);
check('정해진 결말 14', seeds.EN_FIXED_ENDING_POOL.length === 14);
check('동화 도입 12', seeds.EN_FAIRYTALE_OPENINGS.length === 12);
check('장르 8', seeds.EN_GENRES.length === 8);
{
  const all = [...seeds.EN_OPENINGS, ...seeds.EN_SPEEDRUN_OPENINGS, ...seeds.EN_FIXED_ENDING_POOL, ...seeds.EN_FAIRYTALE_OPENINGS];
  check('중복 문장 없음', new Set(all).size === all.length);
  check('한글이 섞여 들어가지 않음', !all.some(s => /[가-힣]/.test(s)));
  check('1단계 슬롯은 4개 + hot (초성 퀴즈·단어 챌린지 제외)',
    seeds.EN_SLOT_KEYS.length === 4 && !seeds.EN_SLOT_KEYS.includes('hint') && !seeds.EN_SLOT_KEYS.includes('word'));
  check('모든 슬롯에 영어 안내 문구가 있음',
    seeds.EN_SLOT_KEYS.concat('hot').every(k => typeof seeds.EN_SLOT_INFO[k] === 'string' && seeds.EN_SLOT_INFO[k].length > 10));
}

  console.log(`\n결과: ${pass} 통과 / ${failCount} 실패`);
  if (failCount) process.exit(1);
}

main().catch(e => { console.error('테스트 실행 실패:', e); process.exit(1); });
