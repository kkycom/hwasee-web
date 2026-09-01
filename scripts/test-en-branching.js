// English 에디션 동률 분기·스핀오프·랭킹 검증 — Firestore 없이 가짜 db로 돌린다.
//
// 이 테스트가 지키려는 것:
//  1) 한국판에서 실제 프로덕션 버그였다가 고쳐진 세 지점이 영어판 포팅본에도
//     반영돼 있는가(참여자 수 승계 / 뒤늦은 마감의 정경 오인 / 콘텐츠 모드 승계).
//  2) 영어판 고유의 재개 가능한 마감과 결합해도 결과가 하나로 수렴하는가(멱등).
//  3) 형제 갈래가 **동시에** 마감돼도 스토리가 한 번만 진행되는가(설계 검토 BLOCKER).
//  4) 랭킹이 user_stats_en만으로 순위를 만들고 한국판 포인트를 읽지 않는가.
//
// 실행: node scripts/test-en-branching.js

const fs = require('fs');
const path = require('path');
const editions = require('../functions/lib/editions.js');

let pass = 0, failCount = 0;
const ok = n => { pass++; console.log('  [ok]', n); };
const bad = (n, d) => { failCount++; console.error('  [FAIL]', n, d ? '— ' + d : ''); };
const check = (n, cond, d) => { cond ? ok(n) : bad(n, d); };

const tick = () => new Promise(r => setImmediate(r));

// ── 낙관적 동시성까지 흉내내는 가짜 Firestore ────────────────────────────
// 트랜잭션이 읽은 문서의 버전을 기억했다가 커밋 시점에 바뀌었으면 재시도한다.
// 실제 Firestore의 트랜잭션 충돌·재시도와 같은 관찰 가능한 성질을 준다 —
// 이게 없으면 형제 동시 마감 테스트가 아무것도 증명하지 못한다.
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  const vers = new Map();
  const touched = new Set();
  const key = (col, id) => col + '/' + id;
  const verOf = k => vers.get(k) || 0;
  const bump = k => vers.set(k, verOf(k) + 1);

  const FieldValue = { delete: () => ({ __delete: true }) };

  function applyVal(k, val, merge) {
    const prev = merge ? (store.get(k) || {}) : {};
    const next = Object.assign({}, prev, val);
    // 점 표기 필드(open_steps.xxx)와 삭제 센티널을 실제 Firestore처럼 처리한다.
    Object.keys(val).forEach(f => {
      if (val[f] && val[f].__delete) {
        delete next[f];
        const dot = f.indexOf('.');
        if (dot > 0) {
          const root = f.slice(0, dot), leaf = f.slice(dot + 1);
          if (next[root] && typeof next[root] === 'object') {
            next[root] = Object.assign({}, next[root]);
            delete next[root][leaf];
          }
        }
        return;
      }
      const dot = f.indexOf('.');
      if (dot > 0) {
        const root = f.slice(0, dot), leaf = f.slice(dot + 1);
        delete next[f];
        next[root] = Object.assign({}, next[root] || {});
        next[root][leaf] = val[f];
      }
    });
    store.set(k, next);
    bump(k);
  }

  const makeRef = (col, id) => {
    const k = key(col, id);
    return {
      __col: col, __id: id, __key: k,
      get: async () => ({ exists: store.has(k), id, data: () => store.get(k) }),
      set: async (val, opt) => applyVal(k, val, !!(opt && opt.merge)),
      // __failUpdateMatching을 두면 그 접두사로 시작하는 필드를 쓰는 ref.update만
      // 실패한다 — batch 커밋과 그 뒤 update 사이의 좁은 구간을 정확히 재현한다.
      update: async (val) => {
        if (api.__failUpdateMatching
            && Object.keys(val).some(f => f.indexOf(api.__failUpdateMatching) === 0)) {
          throw new Error('injected crash: update failed');
        }
        if (store.has(k)) applyVal(k, val, true);
      },
    };
  };

  const makeQuery = (col, filters) => ({
    __col: col, __filters: filters,
    where: (f, op, v) => makeQuery(col, filters.concat([[f, v]])),
    orderBy: (f, dir) => Object.assign(makeQuery(col, filters), { __order: [f, dir] }),
    limit: (n) => Object.assign(makeQuery(col, filters), { __limit: n }),
    doc: (id) => makeRef(col, id || 'auto_' + Math.random().toString(36).slice(2)),
    get: async () => runQuery(col, filters, undefined, undefined),
  });

  function runQuery(col, filters, order, lim) {
    let docs = [...store.entries()]
      .filter(([k]) => k.startsWith(col + '/'))
      .map(([k, v]) => ({ id: k.slice(col.length + 1), data: () => v, ref: makeRef(col, k.slice(col.length + 1)) }))
      .filter(d => (filters || []).every(([f, v]) => d.data()[f] === v));
    if (order) {
      const [f, dir] = order;
      docs.sort((a, b) => (Number(b.data()[f]) || 0) - (Number(a.data()[f]) || 0));
      if (dir !== 'desc') docs.reverse();
    }
    if (lim) docs = docs.slice(0, lim);
    return { docs, size: docs.length, empty: docs.length === 0 };
  }

  const collection = (name) => {
    touched.add(name);
    const q = makeQuery(name, []);
    // orderBy/limit이 붙은 조회는 실제 정렬·개수 제한이 필요하다(랭킹).
    const origGet = q.get;
    q.get = async () => origGet();
    return {
      __col: name,
      doc: q.doc,
      where: q.where,
      orderBy: (f, dir) => {
        const chain = {
          limit: (n) => ({ get: async () => runQuery(name, [], [f, dir], n) }),
          get: async () => runQuery(name, [], [f, dir], undefined),
        };
        return chain;
      },
      limit: (n) => ({ get: async () => runQuery(name, [], undefined, n) }),
      get: async () => runQuery(name, [], undefined, undefined),
    };
  };

  // db.__failBatchAfter를 N으로 두면 N번째 커밋까지만 성공하고 그 다음 커밋에서
  // 예외를 던진다 — 여러 커밋에 걸친 스핀오프가 중간에 끊기는 상황을 실제로 재현한다.
  const api = { __batchCommits: 0, __failBatchAfter: 0, __failUpdateMatching: null, __failTxCommit: false };
  const batch = () => {
    const ops = [];
    return {
      set: (ref, val, opt) => ops.push(() => applyVal(ref.__key, val, !!(opt && opt.merge))),
      update: (ref, val) => ops.push(() => { if (store.has(ref.__key)) applyVal(ref.__key, val, true); }),
      commit: async () => {
        await tick();
        if (api.__failBatchAfter && api.__batchCommits >= api.__failBatchAfter) {
          throw new Error('injected crash: batch commit failed');
        }
        api.__batchCommits++;
        ops.forEach(f => f());
      },
    };
  };

  async function runTransaction(fn) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const reads = new Map();
      const writes = [];
      const tx = {
        get: async (ref) => {
          await tick(); // 인터리브 지점 — 두 트랜잭션이 서로를 볼 수 있게 한다
          if (ref.__id) {
            reads.set(ref.__key, verOf(ref.__key));
            return { exists: store.has(ref.__key), id: ref.__id, data: () => store.get(ref.__key) };
          }
          return runQuery(ref.__col, ref.__filters || [], undefined, undefined);
        },
        set: (ref, val, opt) => writes.push(() => applyVal(ref.__key, val, !!(opt && opt.merge))),
        update: (ref, val) => writes.push(() => { if (store.has(ref.__key)) applyVal(ref.__key, val, true); }),
      };
      const result = await fn(tx);
      await tick();
      let conflict = false;
      for (const [k, v] of reads) if (verOf(k) !== v) { conflict = true; break; }
      if (conflict) continue; // 다른 트랜잭션이 먼저 썼다 — 재시도
      // __failTxCommit이면 커밋 직전에 끊는다. 트랜잭션은 all-or-nothing이라
      // 버퍼된 쓰기를 하나도 적용하지 않아야 한다(부분 상태 없음).
      if (api.__failTxCommit) throw new Error('injected crash: transaction commit failed');
      writes.forEach(f => f());
      return result;
    }
    throw new Error('too much contention');
  }

  return Object.assign(api, { __store: store, __touched: touched, collection, batch, runTransaction, FieldValue });
}

// ── functions/index.js에서 영어 마감 블록만 떼어내 격리 실행 ──────────────
const SRC = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function cut(from, to, label) {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a + 1);
  if (a === -1 || b === -1 || b <= a) throw new Error('소스에서 ' + label + '을 찾지 못했습니다.');
  return SRC.slice(a, b);
}

const displayStepSrc = cut('function _calcDisplayStepBackend', '\n\n', '_calcDisplayStepBackend');
const closeBlockSrc = cut('const EN_VOTE_THRESHOLD', '// 영어 에피소드 마감 — 클라이언트가', '영어 마감 블록');
const lbSrc = cut('exports.getLeaderboardEn', '// 영어 자유 이야기 시작', 'getLeaderboardEn');

const STUBS = `
const FB_AI_ID = 'AI', FB_ADMIN_ID = 'ADMIN';
const admin = { firestore: Object.assign(() => db, { FieldValue: db.FieldValue }) };
function _pointsApplicable(uid) { return !!uid && uid !== FB_ADMIN_ID && uid !== FB_AI_ID; }
function _txLedger(db, tx, uid, pts, reason, sub_id, ledger) {
  tx.set(db.collection(ledger || 'point_ledger').doc('l_' + uid + '_' + sub_id), { user_id: uid, points: pts, reason });
}
async function _enRefillSlotOnComplete() { return null; }
const functions = { region: () => ({ https: { onCall: h => h } }) };
const exports = {};
`;

function loadEn(db) {
  const factory = new Function('db', '_EDITIONS',
    STUBS + displayStepSrc + '\n' + closeBlockSrc + '\n' + lbSrc +
    '\nreturn { _enCloseEpisode, _enSpinOffOrphan, _enSpinOffRemainingOpen, _enBuildEpisodeMaps, getLeaderboardEn: exports.getLeaderboardEn };');
  return factory(db, editions);
}

// ── 시나리오 헬퍼 ───────────────────────────────────────────────────────
function baseStory(extra) {
  return Object.assign({
    story_id: 'st1', opening: 'It began.', max_steps: 10, current_step: 0,
    status: 'active', creator_id: 'u0', creator_nickname: 'Creator',
    participant_count: 7, like_count: 0, hot_score: 0, edition: 'en',
    vote_threshold: 2, open_steps: { ep1: { step: 1, sub_count: 2 } },
  }, extra || {});
}
function tiedSeed(storyExtra) {
  return {
    'stories_en/st1': baseStory(storyExtra),
    'episodes_en/ep1': { episode_id: 'ep1', story_id: 'st1', step: 1, parent_sub_id: '', status: 'open', vote_total: 4 },
    'submissions_en/sA': { sub_id: 'sA', episode_id: 'ep1', story_id: 'st1', content: 'Path A.', author_id: 'uA', vote_count: 2, created_at: '2026-01-01T00:00:00Z' },
    'submissions_en/sB': { sub_id: 'sB', episode_id: 'ep1', story_id: 'st1', content: 'Path B.', author_id: 'uB', vote_count: 2, created_at: '2026-01-01T00:01:00Z' },
  };
}

async function main() {
  // ── 1. 동률이면 갈림길이 생긴다 ────────────────────────────────────────
  console.log('\n[1] 동률 → 갈림길 생성');
  {
    const db = makeDb(tiedSeed());
    const en = loadEn(db);
    const r = await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const st = db.__store.get('stories_en/st1');
    const opens = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('episodes_en/') && v.status === 'open');
    check('마감 결과가 진행(advanced)이다', r === 'closed', String(r));
    check('다음 단계가 승자 수(2)만큼 열렸다', opens.length === 2, String(opens.length));
    check('두 갈래의 부모 제출이 서로 다르다',
      opens[0][1].parent_sub_id !== opens[1][1].parent_sub_id);
    check('스토리에 has_branch가 기록된다', st.has_branch === true);
    check('current_step이 정확히 1만 올라간다', Number(st.current_step) === 1, String(st.current_step));
    check('두 승자 모두 채택 처리된다',
      db.__store.get('submissions_en/sA').is_adopted === true
      && db.__store.get('submissions_en/sB').is_adopted === true);
    check('채택 보상이 승자 1인당 한 번씩 지급된다',
      Number(db.__store.get('user_stats_en/uA').total_points) === 20
      && Number(db.__store.get('user_stats_en/uB').total_points) === 20);
    check('영어 장부에만 기록된다(한국 장부 무오염)',
      [...db.__touched].includes('point_ledger_en') && ![...db.__touched].includes('point_ledger'));
    check('한국 컬렉션을 하나도 건드리지 않는다',
      ![...db.__touched].some(n => ['stories', 'episodes', 'submissions', 'point_ledger'].includes(n)),
      [...db.__touched].join(','));
  }

  // ── 2. 표가 없으면 분기하지 않는다(speedrun 포함) ──────────────────────
  console.log('\n[2] 무투표(speedrun 포함)는 분기하지 않는다');
  {
    const seed = tiedSeed({ mode: 'speedrun' });
    seed['submissions_en/sA'].vote_count = 0;
    seed['submissions_en/sB'].vote_count = 0;
    const db = makeDb(seed);
    const en = loadEn(db);
    await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const opens = [...db.__store.entries()].filter(([k, v]) => k.startsWith('episodes_en/') && v.status === 'open');
    check('표가 없으면 승자는 하나뿐이다', opens.length === 1, String(opens.length));
    check('가장 먼저 제출된 글이 채택된다', db.__store.get('submissions_en/sA').is_adopted === true);
    check('has_branch가 켜지지 않는다', db.__store.get('stories_en/st1').has_branch !== true);
  }

  // ── 3. 뒤늦게 마감된 버려진 갈래 (사용자 지목 2) ───────────────────────
  console.log('\n[3] 뒤늦게 마감된 갈래는 정경 진행이 아니라 스핀오프');
  {
    // ep2는 step 2인데 스토리는 이미 current_step 2까지 진행됨(형제가 먼저 마감).
    const db = makeDb({
      'stories_en/st1': baseStory({
        current_step: 2, participant_count: 15, mode: 'fixed_ending',
        fixed_ending: 'And so it ended.', genre_sequence: ['noir', 'comedy'],
        vote_threshold: 3, open_steps: {},
      }),
      'episodes_en/ep0': { episode_id: 'ep0', story_id: 'st1', step: 1, parent_sub_id: '', status: 'closed', vote_total: 4 },
      'submissions_en/s0a': { sub_id: 's0a', episode_id: 'ep0', story_id: 'st1', content: 'Fork root A.', author_id: 'uA', vote_count: 2, is_adopted: true, created_at: '2026-01-01T00:00:00Z' },
      'submissions_en/s0b': { sub_id: 's0b', episode_id: 'ep0', story_id: 'st1', content: 'Fork root B.', author_id: 'uB', vote_count: 2, is_adopted: true, created_at: '2026-01-01T00:01:00Z' },
      'episodes_en/ep2': { episode_id: 'ep2', story_id: 'st1', step: 2, parent_sub_id: 's0b', status: 'open', vote_total: 3 },
      'submissions_en/sX': { sub_id: 'sX', episode_id: 'ep2', story_id: 'st1', content: 'Late branch.', author_id: 'uC', vote_count: 3, created_at: '2026-01-02T00:00:00Z' },
    });
    const en = loadEn(db);
    const before = Number(db.__store.get('stories_en/st1').current_step);
    const r = await en._enCloseEpisode(db, 'ep2', db.__store.get('episodes_en/ep2'));
    const parent = db.__store.get('stories_en/st1');
    const spin = db.__store.get('stories_en/ep2__spin');

    check('스핀오프로 처리된다', r === 'spun_off', String(r));
    check('부모 스토리의 current_step이 부풀려지지 않는다',
      Number(parent.current_step) === before, `${before} → ${parent.current_step}`);
    check('분리된 새 스토리가 생성된다', !!spin);
    check('분리된 에피소드가 새 스토리로 옮겨진다',
      db.__store.get('episodes_en/ep2').story_id === 'ep2__spin');
    check('그 에피소드의 제출도 같이 옮겨진다',
      db.__store.get('submissions_en/sX').story_id === 'ep2__spin');
    // 사용자 지목 (1)
    check('[지목1] 부모의 누적 참여자 수를 그대로 물려받는다',
      Number(spin.participant_count) === 15, String(spin && spin.participant_count));
    // 사용자 지목 (3)
    check('[지목3] mode를 물려받는다', spin.mode === 'fixed_ending', String(spin && spin.mode));
    check('[지목3] fixed_ending을 물려받는다', spin.fixed_ending === 'And so it ended.');
    check('[지목3] genre_sequence를 물려받는다',
      Array.isArray(spin.genre_sequence) && spin.genre_sequence.length === 2);
    check('[지목3] vote_threshold를 물려받는다', Number(spin.vote_threshold) === 3);
    check('분리된 스토리도 영어 에디션으로 표시된다', spin.edition === 'en');
    check('부모를 parent_story_id로 가리킨다', spin.parent_story_id === 'st1');
    check('hot_score가 있어 목록 쿼리에서 빠지지 않는다', spin.hot_score === 0);

    // 재개 방어 — 다시 불러도 스핀오프가 반복되지 않는다
    const storiesBefore = [...db.__store.keys()].filter(k => k.startsWith('stories_en/')).length;
    await en._enCloseEpisode(db, 'ep2', db.__store.get('episodes_en/ep2'));
    const storiesAfter = [...db.__store.keys()].filter(k => k.startsWith('stories_en/')).length;
    check('재호출해도 스핀오프가 반복되지 않는다(무한 분리 방어)',
      storiesBefore === storiesAfter, `${storiesBefore} → ${storiesAfter}`);
  }

  // ── 4. 형제 갈래 동시 마감 (설계 검토 BLOCKER 1) ───────────────────────
  console.log('\n[4] 형제 갈래가 동시에 마감돼도 스토리는 한 번만 진행한다');
  {
    const db = makeDb({
      'stories_en/st1': baseStory({ current_step: 1, open_steps: { epA: { step: 2, sub_count: 1 }, epB: { step: 2, sub_count: 1 } } }),
      'episodes_en/epA': { episode_id: 'epA', story_id: 'st1', step: 2, parent_sub_id: 's0a', status: 'open', vote_total: 2 },
      'episodes_en/epB': { episode_id: 'epB', story_id: 'st1', step: 2, parent_sub_id: 's0b', status: 'open', vote_total: 2 },
      'submissions_en/sA2': { sub_id: 'sA2', episode_id: 'epA', story_id: 'st1', content: 'A2.', author_id: 'uA', vote_count: 2, created_at: '2026-01-03T00:00:00Z' },
      'submissions_en/sB2': { sub_id: 'sB2', episode_id: 'epB', story_id: 'st1', content: 'B2.', author_id: 'uB', vote_count: 2, created_at: '2026-01-03T00:00:00Z' },
    });
    const en = loadEn(db);
    const results = await Promise.all([
      en._enCloseEpisode(db, 'epA', db.__store.get('episodes_en/epA')),
      en._enCloseEpisode(db, 'epB', db.__store.get('episodes_en/epB')),
    ]);
    const st = db.__store.get('stories_en/st1');
    const spun = results.filter(r => r === 'spun_off').length;
    check('스토리는 정확히 한 단계만 진행한다(2)',
      Number(st.current_step) === 2, String(st.current_step));
    check('정확히 하나만 정경으로 진행하고 나머지는 분리된다',
      spun === 1, JSON.stringify(results));
    check('진 쪽이 독립 스토리로 분리된다',
      !!db.__store.get('stories_en/epA__spin') !== !!db.__store.get('stories_en/epB__spin'));
  }

  // ── 5. 멱등성 — 같은 마감을 두 번 실행 ─────────────────────────────────
  console.log('\n[5] 같은 마감을 반복 실행해도 결과가 하나로 수렴한다');
  {
    const db = makeDb(tiedSeed());
    const en = loadEn(db);
    await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const epsAfter1 = [...db.__store.keys()].filter(k => k.startsWith('episodes_en/')).length;
    const ptsAfter1 = Number(db.__store.get('user_stats_en/uA').total_points);
    await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const epsAfter3 = [...db.__store.keys()].filter(k => k.startsWith('episodes_en/')).length;
    check('에피소드가 중복 생성되지 않는다', epsAfter1 === epsAfter3, `${epsAfter1} → ${epsAfter3}`);
    check('포인트가 중복 지급되지 않는다',
      Number(db.__store.get('user_stats_en/uA').total_points) === ptsAfter1);
    check('current_step이 한 번만 올라간다',
      Number(db.__store.get('stories_en/st1').current_step) === 1);
  }

  // ── 6. 완결 시 남은 형제 갈래 분리 ────────────────────────────────────
  console.log('\n[6] 완결 시 남아 있던 갈래는 고아로 방치되지 않는다');
  {
    const seed = tiedSeed();
    // sA는 완결 선언, sB는 계속 — 갈래 하나는 완결, 하나는 이어져야 한다.
    seed['submissions_en/sA'].is_closing = true;
    const db = makeDb(seed);
    const en = loadEn(db);
    const r = await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const st = db.__store.get('stories_en/st1');
    const spins = [...db.__store.keys()].filter(k => k.startsWith('stories_en/') && k.endsWith('__spin'));
    check('스토리가 완결된다', r === 'completed' && st.status === 'completed', String(r));
    check('완결 시각이 기록된다', !!st.completed_at);
    check('완결을 고르지 않은 갈래가 독립 스토리로 분리된다', spins.length === 1, spins.join(','));
    if (spins.length === 1) {
      const spin = db.__store.get(spins[0]);
      check('분리된 갈래는 계속 진행 가능한 상태다', spin.status === 'active', spin.status);
      check('분리된 갈래도 참여자 수를 물려받는다', Number(spin.participant_count) === 7);
    }
  }

  // ── 7. 결말 고정 이야기는 갈래마다 같은 결말로 닫힌다 ──────────────────
  console.log('\n[7] 결말 고정 + 동률 — 갈래를 버리지 않고 각 끝에 결말을 씌운다');
  {
    const db = makeDb(Object.assign(tiedSeed({
      mode: 'fixed_ending', fixed_ending: 'The lights went out.', max_steps: 3, current_step: 1,
    }), {
      'episodes_en/ep1': { episode_id: 'ep1', story_id: 'st1', step: 2, parent_sub_id: 's0', status: 'open', vote_total: 4 },
    }));
    const en = loadEn(db);
    const r = await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const endSubs = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('submissions_en/') && v.is_closing === true);
    check('완결로 처리된다', r === 'completed', String(r));
    check('갈래 수(2)만큼 결말 문장이 주입된다', endSubs.length === 2, String(endSubs.length));
    check('주입된 결말이 지정한 문장이다',
      endSubs.every(([, v]) => v.content === 'The lights went out.'));
    check('주입 문장에는 보상이 나가지 않는다',
      endSubs.every(([, v]) => v.adopt_rewarded === true && v.author_id === 'AI'));
  }

  // ── 8. 스핀오프 중간 실패 후 재시도 (최종 검토 WARNING 3) ──────────────
  console.log('\n[8] 스핀오프가 중간에 끊겨도 재시도가 상태를 하나로 수렴시킨다');
  {
    const db = makeDb({
      'stories_en/st1': baseStory({ current_step: 5, participant_count: 9, open_steps: {} }),
      'episodes_en/epL': { episode_id: 'epL', story_id: 'st1', step: 2, parent_sub_id: '', status: 'open', vote_total: 2 },
      'submissions_en/sL': { sub_id: 'sL', episode_id: 'epL', story_id: 'st1', content: 'Late.', author_id: 'uA', vote_count: 2, created_at: '2026-01-04T00:00:00Z' },
    });
    const en = loadEn(db);
    // 1차: 제출 이전 커밋 직후 끊긴 것처럼, 스핀오프만 직접 부분 실행한다.
    const maps = await en._enBuildEpisodeMaps(db, 'st1');
    await en._enSpinOffOrphan(db, { episode_id: 'epL', ...db.__store.get('episodes_en/epL') },
      db.__store.get('stories_en/st1'), maps.epById, maps.subsByEp, maps.subById, null);
    const firstSpin = Object.assign({}, db.__store.get('stories_en/epL__spin'));
    // 그 사이 새 참여자가 왔다고 가정
    db.__store.set('stories_en/epL__spin', Object.assign({}, firstSpin, { participant_count: 12 }));
    // 2차: 같은 스핀오프를 다시 실행(재개)
    await en._enSpinOffOrphan(db, { episode_id: 'epL', ...db.__store.get('episodes_en/epL') },
      db.__store.get('stories_en/st1'), maps.epById, maps.subsByEp, maps.subById, null);
    const second = db.__store.get('stories_en/epL__spin');
    const spinCount = [...db.__store.keys()].filter(k => k.startsWith('stories_en/') && k.endsWith('__spin')).length;
    check('재시도해도 분리 스토리가 하나뿐이다', spinCount === 1, String(spinCount));
    check('재시도가 그 사이 쌓인 참여자 수를 덮어쓰지 않는다',
      Number(second.participant_count) === 12, String(second.participant_count));
    check('이전된 에피소드는 정확히 한 스토리만 소유한다',
      db.__store.get('episodes_en/epL').story_id === 'epL__spin');
    check('이전된 제출도 같은 스토리를 가리킨다',
      db.__store.get('submissions_en/sL').story_id === 'epL__spin');
  }

  // ── 8b. 실제 중단 → 실제 재개 경로 (최종 검토 BLOCKER 1) ───────────────
  // 헬퍼를 직접 두 번 부르는 것이 아니라, 스핀오프가 커밋 도중 죽은 뒤
  // _enCloseEpisode를 다시 부르는 진짜 재개 경로를 검증한다.
  console.log('\n[8b] 스핀오프가 커밋 도중 죽은 뒤 마감을 재개해도 하나로 수렴한다');
  {
    const db = makeDb({
      'stories_en/st1': baseStory({ current_step: 2, participant_count: 15, open_steps: {} }),
      'episodes_en/ep0': { episode_id: 'ep0', story_id: 'st1', step: 1, parent_sub_id: '', status: 'closed', vote_total: 4 },
      'submissions_en/s0b': { sub_id: 's0b', episode_id: 'ep0', story_id: 'st1', content: 'Root B.', author_id: 'uB', vote_count: 2, is_adopted: true, created_at: '2026-01-01T00:01:00Z' },
      'episodes_en/ep2': { episode_id: 'ep2', story_id: 'st1', step: 2, parent_sub_id: 's0b', status: 'open', vote_total: 3 },
      'submissions_en/sX': { sub_id: 'sX', episode_id: 'ep2', story_id: 'st1', content: 'Late branch.', author_id: 'uC', vote_count: 3, created_at: '2026-01-02T00:00:00Z' },
    });
    const en = loadEn(db);

    // 첫 커밋(스토리 생성 + 에피소드 이전)만 통과시키고 그 다음 커밋에서 죽인다.
    db.__failBatchAfter = 1;
    let crashed = false;
    try {
      await en._enCloseEpisode(db, 'ep2', db.__store.get('episodes_en/ep2'));
    } catch (e) { crashed = true; }
    check('중단이 실제로 재현된다', crashed);
    check('중단 시점에 에피소드는 이미 옮겨져 있다',
      db.__store.get('episodes_en/ep2').story_id === 'ep2__spin');
    check('중단 시점에 제출은 아직 안 옮겨졌다(부분 상태)',
      db.__store.get('submissions_en/sX').story_id === 'st1');
    check('중단 시점에 마감 완료 표시가 없다',
      db.__store.get('episodes_en/ep2').close_finalized !== true);

    // 재개 — 이제 ep2.story_id는 이미 ep2__spin이다(오래된 스냅샷 문제의 핵심).
    db.__failBatchAfter = 0;
    const r = await en._enCloseEpisode(db, 'ep2', db.__store.get('episodes_en/ep2'));
    const spins = [...db.__store.keys()].filter(k => k.startsWith('stories_en/') && k.includes('__spin'));
    check('재개 후 분리 스토리가 정확히 하나다(2차 스핀오프 없음)',
      spins.length === 1, spins.join(','));
    check('2차 스핀오프 문서(__spin__spin)가 생기지 않는다',
      !spins.some(k => k.includes('__spin__spin')), spins.join(','));
    check('재개가 남은 제출 이전을 마저 끝낸다',
      db.__store.get('submissions_en/sX').story_id === 'ep2__spin',
      db.__store.get('submissions_en/sX').story_id);
    check('재개 후 마감 완료 표시가 남는다',
      db.__store.get('episodes_en/ep2').close_finalized === true, String(r));
    check('부모 스토리 current_step은 끝까지 그대로다',
      Number(db.__store.get('stories_en/st1').current_step) === 2);

    // 한 번 더 불러도 아무것도 늘지 않는다.
    await en._enCloseEpisode(db, 'ep2', db.__store.get('episodes_en/ep2'));
    check('완료 후 재호출해도 분리 스토리가 늘지 않는다',
      [...db.__store.keys()].filter(k => k.startsWith('stories_en/') && k.includes('__spin')).length === 1);
  }

  // ── 8c. 분리된 갈래도 상한·강제 결말을 지킨다 (최종 재검토 BLOCKER) ────
  // 예전엔 스핀오프가 anyClose만 보고 무조건 다음 단계를 열어서, 분리된 갈래만
  // max_steps를 넘겨 계속 진행되거나 결말 고정 이야기가 결말 없이 이어졌다.
  console.log('\n[8c] 분리된 갈래도 max_steps·결말 고정 규칙을 그대로 따른다');
  const lateSeed = (storyExtra, step) => ({
    'stories_en/st1': baseStory(Object.assign({ current_step: 9, participant_count: 5, open_steps: {} }, storyExtra)),
    'episodes_en/epL': { episode_id: 'epL', story_id: 'st1', step: step, parent_sub_id: '', status: 'open', vote_total: 2 },
    'submissions_en/sL': { sub_id: 'sL', episode_id: 'epL', story_id: 'st1', content: 'Late.', author_id: 'uA', vote_count: 2, created_at: '2026-01-05T00:00:00Z' },
  });
  {
    // 최대 단계에 도달한 갈래가 뒤늦게 마감된 경우 (max_steps 10, 이 갈래가 10단계를
    // 끝냈고 형제는 이미 그 너머로 진행해 current_step이 10 — 그래야 orphan이 된다).
    const db = makeDb(lateSeed({ max_steps: 10, current_step: 10 }, 10));
    const en = loadEn(db);
    await en._enCloseEpisode(db, 'epL', db.__store.get('episodes_en/epL'));
    const spin = db.__store.get('stories_en/epL__spin');
    const openAfter = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('episodes_en/') && v.story_id === 'epL__spin' && v.status === 'open');
    check('상한에 도달한 분리 갈래는 완결된다', spin && spin.status === 'completed',
      spin && spin.status);
    check('상한을 넘는 다음 단계를 열지 않는다', openAfter.length === 0, String(openAfter.length));
  }
  {
    // 결말 고정 이야기의 갈래가 마지막 직전 단계에서 뒤늦게 마감된 경우
    const db = makeDb(lateSeed(
      { max_steps: 10, mode: 'fixed_ending', fixed_ending: 'The lights went out.' }, 9));
    const en = loadEn(db);
    await en._enCloseEpisode(db, 'epL', db.__store.get('episodes_en/epL'));
    const spin = db.__store.get('stories_en/epL__spin');
    const ends = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('submissions_en/') && v.story_id === 'epL__spin' && v.is_closing === true);
    const openAfter = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('episodes_en/') && v.story_id === 'epL__spin' && v.status === 'open');
    check('결말 고정 분리 갈래에 정해진 결말이 주입된다',
      ends.length === 1 && ends[0][1].content === 'The lights went out.',
      ends.map(e => e[1].content).join('|'));
    check('결말 주입 후 완결 상태가 된다', spin && spin.status === 'completed', spin && spin.status);
    check('결말 대신 새 단계를 열지 않는다', openAfter.length === 0, String(openAfter.length));
    check('주입 문장에는 보상이 나가지 않는다',
      ends.every(([, v]) => v.author_id === 'AI' && v.adopt_rewarded === true));
  }
  {
    // 아직 상한에 안 닿은 갈래는 예전처럼 다음 단계를 연다(회귀 방지)
    const db = makeDb(lateSeed({ max_steps: 10 }, 3));
    const en = loadEn(db);
    await en._enCloseEpisode(db, 'epL', db.__store.get('episodes_en/epL'));
    const spin = db.__store.get('stories_en/epL__spin');
    const openAfter = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('episodes_en/') && v.story_id === 'epL__spin' && v.status === 'open');
    check('상한 전이면 분리 갈래가 계속 진행된다', spin && spin.status === 'active');
    check('다음 단계가 하나 열린다', openAfter.length === 1, String(openAfter.length));
  }

  // ── 8d. 재개가 사용자 활동을 지우지 않는다 (최종 재검토 BLOCKER) ───────
  console.log('\n[8d] 다음 단계 생성 후 중단 → 사용자 활동 → 재개해도 활동이 지워지지 않는다');
  {
    const db = makeDb(lateSeed({ max_steps: 10 }, 3));
    const en = loadEn(db);
    // 지적된 시나리오: 다음 단계 생성은 끝났는데 close_finalized 기록 전에 죽었다.
    // 그 커밋이 스핀오프의 마지막 batch라 커밋 실패 주입으로는 그 틈을 만들 수
    // 없으므로, 정상 실행 후 close_finalized만 되돌려 같은 중간 상태를 만든다
    // (에피소드는 closed 그대로 — 그래야 재개 경로를 탄다).
    await en._enCloseEpisode(db, 'epL', db.__store.get('episodes_en/epL'));
    const nextKey = [...db.__store.keys()].find(k => k.includes('__spinnext__'));
    check('중단 전에 다음 단계가 만들어졌다', !!nextKey, String(nextKey));
    db.__store.set('episodes_en/epL', Object.assign({}, db.__store.get('episodes_en/epL'),
      { close_finalized: false }));
    check('중단 시점에 마감 완료 표시가 없다',
      db.__store.get('episodes_en/epL').close_finalized !== true);

    // 그 사이 사람들이 그 단계에 참여했다고 가정한다.
    const nextId = nextKey.slice('episodes_en/'.length);
    db.__store.set(nextKey, Object.assign({}, db.__store.get(nextKey),
      { vote_total: 7, status: 'pending', pending_at: '2026-02-02T00:00:00Z' }));

    // 재개
    db.__failBatchAfter = 0;
    await en._enCloseEpisode(db, 'epL', db.__store.get('episodes_en/epL'));
    const after = db.__store.get(nextKey);
    check('재개가 그 단계의 투표수를 지우지 않는다', Number(after.vote_total) === 7,
      String(after.vote_total));
    check('재개가 그 단계의 상태를 되돌리지 않는다', after.status === 'pending', after.status);
    check('재개가 그 단계를 중복 생성하지 않는다',
      [...db.__store.keys()].filter(k => k.includes('__spinnext__')).length === 1);
    check('재개 후 마감 완료 표시가 남는다',
      db.__store.get('episodes_en/epL').close_finalized === true);
  }

  // ── 8e. 에피소드 생성과 open_steps 기록 사이의 중단 (최종 재검토 BLOCKER) ─
  // 두 작업이 별도 커밋이라, 그 사이에 끊기면 재개 시 에피소드는 이미 있어서
  // 건너뛰고 open_steps만 영구 누락될 수 있었다. 실패를 그 구간에 직접 주입한다.
  console.log('\n[8e] 다음 단계 생성 후 open_steps 기록 전 중단돼도 재개가 복구한다');
  {
    const db = makeDb(lateSeed({ max_steps: 10 }, 3));
    const en = loadEn(db);
    db.__failUpdateMatching = 'open_steps.';
    let crashed = false;
    try { await en._enCloseEpisode(db, 'epL', db.__store.get('episodes_en/epL')); }
    catch (e) { crashed = true; }
    check('open_steps 기록 구간에서 중단이 재현된다', crashed);

    const nextKey = [...db.__store.keys()].find(k => k.indexOf('__spinnext__') !== -1);
    check('중단 전에 다음 단계 에피소드는 만들어졌다', !!nextKey, String(nextKey));
    const spinBefore = db.__store.get('stories_en/epL__spin');
    check('중단 시점에 open_steps가 비어 있다',
      !spinBefore.open_steps || Object.keys(spinBefore.open_steps).length === 0,
      JSON.stringify(spinBefore.open_steps));
    check('중단 시점에 마감 완료 표시가 없다',
      db.__store.get('episodes_en/epL').close_finalized !== true);

    // 재개
    db.__failUpdateMatching = null;
    const nextId = nextKey.slice('episodes_en/'.length);
    await en._enCloseEpisode(db, 'epL', db.__store.get('episodes_en/epL'));
    const spinAfter = db.__store.get('stories_en/epL__spin');
    check('재개가 누락된 open_steps를 복구한다',
      !!(spinAfter.open_steps && spinAfter.open_steps[nextId]),
      JSON.stringify(spinAfter.open_steps));
    check('복구된 항목의 단계 번호가 맞다',
      spinAfter.open_steps && spinAfter.open_steps[nextId]
      && Number(spinAfter.open_steps[nextId].step) === 4,
      JSON.stringify(spinAfter.open_steps && spinAfter.open_steps[nextId]));
    check('재개가 에피소드를 중복 생성하지 않는다',
      [...db.__store.keys()].filter(k => k.indexOf('__spinnext__') !== -1).length === 1);
    check('재개 후 마감 완료 표시가 남는다',
      db.__store.get('episodes_en/epL').close_finalized === true);

    // 그 단계에 이미 제출이 쌓인 뒤 또 재개돼도 카운트를 되돌리지 않아야 한다.
    db.__store.set('stories_en/epL__spin', Object.assign({}, spinAfter,
      { open_steps: { [nextId]: { step: 4, sub_count: 5 } } }));
    db.__store.set('episodes_en/epL', Object.assign({}, db.__store.get('episodes_en/epL'),
      { close_finalized: false }));
    await en._enCloseEpisode(db, 'epL', db.__store.get('episodes_en/epL'));
    const spin3 = db.__store.get('stories_en/epL__spin');
    check('이미 있는 open_steps 항목의 sub_count를 되돌리지 않는다',
      spin3.open_steps && Number(spin3.open_steps[nextId].sub_count) === 5,
      JSON.stringify(spin3.open_steps && spin3.open_steps[nextId]));
  }

  // ── 8f. 완결 시점 동률 → 결말마다 독립 완결작 ─────────────────────────
  // 완결 시점 갈래들은 같은 에피소드 안의 여러 채택 문장이라 에피소드를 옮기는
  // 스핀오프를 쓸 수 없다. 문장을 복제하지 않고 원본을 가리키는 완결작 문서를
  // 만든다 — 복제가 없으므로 포인트·통계가 두 번 잡힐 수 없다.
  console.log('\n[8f] 완결 시점 동률은 결말마다 독립 완결작으로 노출된다');
  const tie3Seed = (storyExtra, closing) => {
    const seed = {
      'stories_en/st1': baseStory(Object.assign({ current_step: 0 }, storyExtra)),
      'episodes_en/ep1': { episode_id: 'ep1', story_id: 'st1', step: 1, parent_sub_id: '', status: 'open', vote_total: 6 },
    };
    ['A', 'B', 'C'].forEach((k, i) => {
      seed['submissions_en/s' + k] = {
        sub_id: 's' + k, episode_id: 'ep1', story_id: 'st1', content: 'Ending ' + k,
        author_id: 'u' + k, vote_count: 2, created_at: `2026-01-0${i + 1}T00:00:00Z`,
        ...(closing ? { is_closing: true } : {}),
      };
    });
    return seed;
  };
  {
    // 3갈래 동률 + 전원 완결 선언
    const db = makeDb(tie3Seed({ max_steps: 10 }, true));
    const en = loadEn(db);
    const r = await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const parent = db.__store.get('stories_en/st1');
    const endSpins = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('stories_en/') && v.is_end_branch === true);

    check('원작이 완결된다', r === 'completed' && parent.status === 'completed', String(r));
    check('3갈래 동률에서 독립 완결작이 2개 생긴다(본 줄기 1 + 갈래 2)',
      endSpins.length === 2, String(endSpins.length));
    check('생성된 완결작이 전부 completed 상태다',
      endSpins.every(([, v]) => v.status === 'completed' && !!v.completed_at));
    check('각 완결작이 서로 다른 결말 문장을 가리킨다',
      new Set(endSpins.map(([, v]) => v.branch_leaf_sub_id)).size === 2,
      endSpins.map(([, v]) => v.branch_leaf_sub_id).join(','));
    check('본 줄기로 남은 갈래는 완결작이 따로 만들어지지 않는다',
      !endSpins.some(([, v]) => v.branch_leaf_sub_id === 'sA'),
      endSpins.map(([, v]) => v.branch_leaf_sub_id).join(','));
    check('갈래 관계가 데이터에 남는다(parent_story_id/branch_*)',
      endSpins.every(([, v]) => v.parent_story_id === 'st1'
        && !!v.branch_leaf_episode_id && !!v.branch_leaf_sub_id));
    check('참여자 수를 원작에서 물려받는다',
      endSpins.every(([, v]) => Number(v.participant_count) === 7));

    // 조건: 포인트·통계 중복 금지
    const ledger = [...db.__store.keys()].filter(k => k.startsWith('point_ledger_en/'));
    check('채택 보상이 작성자 1인당 정확히 한 번이다', ledger.length === 3, ledger.join(','));
    check('각 작성자의 채택 수가 1이다',
      ['uA', 'uB', 'uC'].every(u => Number(db.__store.get('user_stats_en/' + u).adoption_count) === 1));
    check('제출을 복제하지 않는다(원본 3건 그대로)',
      [...db.__store.keys()].filter(k => k.startsWith('submissions_en/')).length === 3);

    // 멱등
    await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    check('재호출해도 완결작이 늘지 않는다',
      [...db.__store.entries()].filter(([k, v]) => k.startsWith('stories_en/') && v.is_end_branch).length === 2);
    check('재호출해도 보상이 늘지 않는다',
      [...db.__store.keys()].filter(k => k.startsWith('point_ledger_en/')).length === 3);
  }
  {
    // 3갈래 동률 + 최대 단계 도달(완결 선언 없음)
    const db = makeDb(tie3Seed({ max_steps: 1 }, false));
    const en = loadEn(db);
    const r = await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const endSpins = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('stories_en/') && v.is_end_branch === true);
    check('최대 단계 도달로 완결돼도 갈래가 독립 완결작이 된다',
      r === 'completed' && endSpins.length === 2, `${r} / ${endSpins.length}`);
  }
  {
    // 결말 고정 + 3갈래 동률
    const db = makeDb(tie3Seed(
      { max_steps: 3, current_step: 1, mode: 'fixed_ending', fixed_ending: 'It ended.' }, false));
    db.__store.set('episodes_en/ep1', Object.assign({}, db.__store.get('episodes_en/ep1'), { step: 2 }));
    const en = loadEn(db);
    const r = await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const endSpins = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('stories_en/') && v.is_end_branch === true);
    const injected = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('submissions_en/') && v.is_closing === true);
    check('결말 고정 동률도 갈래마다 독립 완결작이 된다',
      r === 'completed' && endSpins.length === 2, `${r} / ${endSpins.length}`);
    check('갈래 수만큼 결말이 주입된다(3)', injected.length === 3, String(injected.length));
    check('완결작이 각자 자기 결말 에피소드를 가리킨다',
      endSpins.every(([, v]) => String(v.branch_leaf_episode_id).indexOf('__end__') !== -1),
      endSpins.map(([, v]) => v.branch_leaf_episode_id).join(','));
    check('주입 결말에는 보상이 나가지 않는다',
      injected.every(([, v]) => v.author_id === 'AI' && v.adopt_rewarded === true));
    check('모드 설정을 완결작이 물려받는다',
      endSpins.every(([, v]) => v.mode === 'fixed_ending' && v.fixed_ending === 'It ended.'));
  }
  {
    // 트랜잭션이 실제로 중간에 끊기는 경우 — 완결작이 부분만 생기면 안 된다.
    const db = makeDb(tie3Seed({ max_steps: 10 }, true));
    const en = loadEn(db);
    db.__failTxCommit = true;   // TX-C 커밋 시점에 실제로 끊는다
    let crashed = false;
    try { await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1')); }
    catch (e) { crashed = true; }
    check('완결 트랜잭션 중단이 재현된다', crashed);
    const partial = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('stories_en/') && v.is_end_branch === true);
    check('중단 시 완결작이 하나도 남지 않는다(부분 상태 없음)',
      partial.length === 0, String(partial.length));
    check('중단 시 원작도 완결로 바뀌지 않는다',
      db.__store.get('stories_en/st1').status === 'active',
      db.__store.get('stories_en/st1').status);

    db.__failTxCommit = false;
    await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const after = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('stories_en/') && v.is_end_branch === true);
    check('재개하면 완결작 2개가 정확히 만들어진다', after.length === 2, String(after.length));
    check('재개 후 보상이 1인당 한 번 그대로다',
      [...db.__store.keys()].filter(k => k.startsWith('point_ledger_en/')).length === 3);
  }

  // ── 8g. 원작 완결본의 대표 결말 (최종 검토 BLOCKER) ───────────────────
  // 원작이 대표 결말을 스스로 고르면 조회 순서에 따라 달라져서, 이미 독립
  // 완결작이 있는 결말을 중복 노출하고 본 줄기 결말은 어디서도 못 읽게 된다.
  console.log('\n[8g] 원작 완결본은 서버가 못박은 대표 결말을 보여준다');
  {
    const db = makeDb(tie3Seed({ max_steps: 10 }, true));
    const en = loadEn(db);
    await en._enCloseEpisode(db, 'ep1', db.__store.get('episodes_en/ep1'));
    const parent = db.__store.get('stories_en/st1');
    const endSpins = [...db.__store.entries()]
      .filter(([k, v]) => k.startsWith('stories_en/') && v.is_end_branch === true);

    check('원작에 대표 결말이 기록된다', !!parent.canonical_ending_sub_id,
      String(parent.canonical_ending_sub_id));
    check('대표 결말이 본 줄기(가장 먼저 제출된 sA)다',
      parent.canonical_ending_sub_id === 'sA', String(parent.canonical_ending_sub_id));
    check('대표 결말은 독립 완결작으로 중복 생성되지 않는다',
      !endSpins.some(([, v]) => v.branch_leaf_sub_id === parent.canonical_ending_sub_id));
    check('나머지 결말은 전부 독립 완결작으로 존재한다',
      ['sB', 'sC'].every(id => endSpins.some(([, v]) => v.branch_leaf_sub_id === id)),
      endSpins.map(([, v]) => v.branch_leaf_sub_id).join(','));

    // 화면이 그 대표 결말을 실제로 렌더하는지 — 조회 순서를 뒤집어도 같아야 한다.
    const APP_SRC2 = fs.readFileSync(path.join(__dirname, '..', 'bang', 'en', 'en-app.js'), 'utf8')
      .replace(/\r\n/g, '\n');
    const lineageSrc2 = APP_SRC2.slice(APP_SRC2.indexOf('function lineageSentences'),
                                      APP_SRC2.indexOf('async function openStory'));
    const lineage = new Function(lineageSrc2 + '\nreturn lineageSentences;')();

    const eps = [{ episode_id: 'ep1', story_id: 'st1', step: 1, parent_sub_id: '', status: 'closed' }];
    const mkSub = id => Object.assign({}, db.__store.get('submissions_en/' + id), { sub_id: id });
    const order1 = ['sA', 'sB', 'sC'].map(mkSub);
    const order2 = ['sC', 'sB', 'sA'].map(mkSub);

    const shown1 = lineage(eps, order1, null, eps, parent.canonical_ending_sub_id);
    const shown2 = lineage(eps, order2, null, eps, parent.canonical_ending_sub_id);
    check('원작이 대표 결말 문장으로 끝난다',
      shown1.length === 1 && shown1[0].sub_id === 'sA',
      shown1.map(s => s.sub_id).join(','));
    check('제출 조회 순서를 뒤집어도 같은 결말을 보여준다',
      shown2.length === 1 && shown2[0].sub_id === 'sA',
      shown2.map(s => s.sub_id).join(','));

    // 대표 결말 기록이 없는 옛 완결작(마이그레이션 안 함)도 결정적이어야 한다.
    const old1 = lineage(eps, order1, null, eps, null);
    const old2 = lineage(eps, order2, null, eps, null);
    check('대표 기록이 없는 옛 완결작도 조회 순서와 무관하게 같은 결말을 보여준다',
      old1.length === 1 && old2.length === 1 && old1[0].sub_id === old2[0].sub_id,
      `${old1.map(s => s.sub_id)} vs ${old2.map(s => s.sub_id)}`);
  }

  // ── 9. 랭킹 ────────────────────────────────────────────────────────────
  console.log('\n[9] 영어판 랭킹은 user_stats_en만으로 만든다');
  {
    const db = makeDb({
      'user_stats_en/uA': { user_id: 'uA', edition: 'en', total_points: 120, adoption_count: 6 },
      'user_stats_en/uB': { user_id: 'uB', edition: 'en', total_points: 80, adoption_count: 9 },
      'user_stats_en/uZ': { user_id: 'uZ', edition: 'en', total_points: 0, adoption_count: 0 },
      'user_stats_en/ADMIN': { user_id: 'ADMIN', edition: 'en', total_points: 9999, adoption_count: 999 },
      'user_stats_en/AI': { user_id: 'AI', edition: 'en', total_points: 5000, adoption_count: 500 },
      // 한국판 포인트가 전혀 다른 값이어도 영어 랭킹에 영향을 주면 안 된다.
      'users/uA': { display_name: 'Ann', badge: 'sprout', total_points: 999999, adoption_count: 777 },
      'users/uB': { nickname: 'Ben', badge: 'seed', total_points: 111111, adoption_count: 888 },
    });
    const en = loadEn(db);
    const res = await en.getLeaderboardEn({});
    check('랭킹 조회가 성공한다', res && res.ok === true);
    check('포인트 1위가 영어판 수치 기준이다',
      res.points[0] && res.points[0].user_id === 'uA' && res.points[0].value === 120,
      JSON.stringify(res.points[0]));
    check('한국판 users의 포인트를 값으로 쓰지 않는다',
      res.points.every(r => r.value !== 999999 && r.value !== 111111));
    check('채택 랭킹은 영어판 adoption_count 기준이다',
      res.adoptions[0] && res.adoptions[0].user_id === 'uB' && res.adoptions[0].value === 9,
      JSON.stringify(res.adoptions[0]));
    check('관리자·AI 계정은 순위에서 제외된다',
      !res.points.some(r => r.user_id === 'ADMIN' || r.user_id === 'AI')
      && !res.adoptions.some(r => r.user_id === 'ADMIN' || r.user_id === 'AI'));
    check('기록이 0인 사용자는 노출되지 않는다', !res.points.some(r => r.user_id === 'uZ'));
    check('표시용 닉네임은 공용 users에서 채운다',
      res.points[0].nickname === 'Ann' && res.adoptions[0].nickname === 'Ben');
    check('영어 랭킹이 point_ledger(한국 장부)를 읽지 않는다',
      ![...db.__touched].includes('point_ledger') && ![...db.__touched].includes('point_ledger_en'));
  }

  // ── 9b. 스핀오프된 이야기의 산문 계보 (최종 검토 BLOCKER 2) ────────────
  // 스핀오프는 갈래 에피소드와 그 제출만 새 스토리로 옮기고 조상은 부모 스토리에
  // 남긴다. 상세 화면이 현재 story_id만 조회하면 계보가 첫 걸음에서 끊겨,
  // 분리된 이야기가 오프닝만 남고 그동안 쌓인 문장이 통째로 사라져 보인다.
  console.log('\n[9b] 분리된 이야기도 앞부분 문장을 잃지 않는다');
  {
    const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'bang', 'en', 'en-app.js'), 'utf8')
      .replace(/\r\n/g, '\n');
    const lineageSrc = APP_SRC.slice(APP_SRC.indexOf('function lineageSentences'),
                                    APP_SRC.indexOf('async function openStory'));
    const lineageSentences = new Function(lineageSrc + '\nreturn lineageSentences;')();

    // 부모 st1: ep0(1단계, sA 채택) → ep1(2단계, sB1/sB2 동률 채택)
    // 분리본 spin: ep2(3단계, 부모 문장 sB2에서 이어짐)
    const parentEps = [
      { episode_id: 'ep0', story_id: 'st1', step: 1, parent_sub_id: '', status: 'closed' },
      { episode_id: 'ep1', story_id: 'st1', step: 2, parent_sub_id: 'sA', status: 'closed' },
    ];
    const parentSubs = [
      { sub_id: 'sA', episode_id: 'ep0', story_id: 'st1', content: 'First.', is_adopted: true },
      { sub_id: 'sB1', episode_id: 'ep1', story_id: 'st1', content: 'Branch one.', is_adopted: true },
      { sub_id: 'sB2', episode_id: 'ep1', story_id: 'st1', content: 'Branch two.', is_adopted: true },
    ];
    const ownEps = [{ episode_id: 'ep2', story_id: 'spin', step: 3, parent_sub_id: 'sB2', status: 'open' }];
    const ownSubs = [];
    const openEp = ownEps[0];

    // 고친 전의 동작 — 조상을 안 합치면 계보가 끊긴다.
    const without = lineageSentences(ownEps, ownSubs, openEp, ownEps);
    check('(회귀 재현) 조상을 안 합치면 앞 문장이 전부 사라진다', without.length === 0,
      String(without.length));

    // 고친 뒤 — 조상까지 합쳐 복원한다.
    const merged = lineageSentences(ownEps.concat(parentEps), ownSubs.concat(parentSubs), openEp, ownEps);
    check('분리된 이야기에서 앞 문장이 복원된다', merged.length === 2, String(merged.length));
    check('문장 순서가 오프닝 쪽부터다',
      merged[0] && merged[0].sub_id === 'sA' && merged[1] && merged[1].sub_id === 'sB2',
      merged.map(s => s.sub_id).join(','));
    check('내 갈래가 아닌 형제 문장(sB1)은 섞이지 않는다',
      !merged.some(s => s.sub_id === 'sB1'));

    // 완결된 분리본 — 시작점을 조상이 아니라 자기 에피소드에서 골라야 한다.
    const doneOwnEps = [{ episode_id: 'ep2', story_id: 'spin', step: 3, parent_sub_id: 'sB2', status: 'closed' }];
    const doneOwnSubs = [{ sub_id: 'sC', episode_id: 'ep2', story_id: 'spin', content: 'Ending.', is_adopted: true }];
    const doneMerged = lineageSentences(
      doneOwnEps.concat(parentEps), doneOwnSubs.concat(parentSubs), null, doneOwnEps);
    check('완결된 분리본도 자기 갈래 기준으로 계보를 복원한다',
      doneMerged.length === 3 && doneMerged[2].sub_id === 'sC',
      doneMerged.map(s => s.sub_id).join(','));

    // 상세 화면이 실제로 조상을 조회하는지(소스 수준).
    check('openStory가 parent_story_id를 따라 조상을 조회한다',
      APP_SRC.includes('parent_story_id') && /while \(parentId/.test(APP_SRC));
    check('열린 갈래 목록은 조상을 섞지 않는다(자기 에피소드만)',
      APP_SRC.includes('const openEps = episodes.filter(e => e.status === \'open\')'));
  }

  // ── 10. 소스 수준 경계 확인 ────────────────────────────────────────────
  console.log('\n[10] 소스 경계 — 영어 블록이 한국 컬렉션을 문자열로도 안 쓴다');
  {
    const enBlock = closeBlockSrc + lbSrc;
    const koLiterals = ["collection('stories')", "collection('episodes')",
      "collection('submissions')", "collection('point_ledger')", "collection('votes')"];
    const found = koLiterals.filter(l => enBlock.includes(l));
    check('영어 블록에 한국 컬렉션 리터럴이 없다', found.length === 0, found.join(', '));
    check('랭킹이 user_stats_en을 읽는다', lbSrc.includes('EN.userStats'));
    // 순위를 매기는 정렬(orderBy)이 전부 user_stats_en에 걸려 있어야 한다.
    // users에 orderBy가 걸리면 그 순간 한국판 포인트로 순위를 매기는 셈이 된다.
    const orderByCount = (lbSrc.match(/\.orderBy\(/g) || []).length;
    const statsOrderBy = (lbSrc.match(/EN\.userStats\)\s*\.orderBy\(/g) || []).length;
    check('랭킹의 정렬 기준이 전부 user_stats_en이다',
      orderByCount === 2 && statsOrderBy === 2, `orderBy ${orderByCount}개 중 user_stats_en ${statsOrderBy}개`);
    check('users는 정렬·순위에 쓰이지 않는다(표시용 doc 조회만)',
      !/SHARED\.users\)[\s\S]{0,40}\.orderBy/.test(lbSrc) && lbSrc.includes('SHARED.users'));
  }

  console.log(`\n결과: ${pass} 통과 / ${failCount} 실패`);
  if (failCount) process.exit(1);
}

main().catch(e => { console.error('테스트 실행 실패:', e); process.exit(1); });
