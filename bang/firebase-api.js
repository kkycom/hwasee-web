// ═══════════════════════════════════════════════════════
//  HWASEE — Firebase Firestore 백엔드
// ═══════════════════════════════════════════════════════

const FB_CONFIG = {
  apiKey: "AIzaSyB5jojts7ppAoQ8ycQ9YOzB-79doP6Cebc",
  authDomain: "hwasee-bang.firebaseapp.com",
  projectId: "hwasee-bang",
  storageBucket: "hwasee-bang.firebasestorage.app",
  messagingSenderId: "216731930626",
  appId: "1:216731930626:web:81dcf18e763bf65f40971b"
};

firebase.initializeApp(FB_CONFIG);
const db = firebase.firestore();
const functionsRegion = firebase.app().functions('asia-northeast3');

// ─── 익명 인증 (Auth 마이그레이션 1단계) ──────────────────
// 브라우저마다 진짜 Firebase Auth 신원을 부여해두는 준비 작업 — 아직 Firestore
// 규칙은 이 값을 검사하지 않으므로 지금 당장 접근 제어에 영향은 없음.
// 실패해도 회원가입/로그인 등 기존 흐름이 절대 막히면 안 되므로 항상 catch로 감싸 null 반환.
// 지연 초기화: 페이지 로드마다 무조건 쏘지 않고, 실제로 필요한 시점(로그인/가입/
// 세션 백필)에만 첫 호출에서 signInAnonymously()가 발생하도록 함 — 단순 열람
// 경로의 초기 네트워크 부하를 줄이기 위함(성능 관련, 보안 로직 자체는 동일).
let _authReadyPromise = null;
function _fbEnsureAuth() {
  if (!_authReadyPromise) {
    _authReadyPromise = firebase.auth().signInAnonymously()
      .then(cred => cred.user.uid)
      .catch(() => null);
  }
  return _authReadyPromise;
}

async function fbGetAuthUid() {
  try { return await _fbEnsureAuth(); } catch (e) { return null; }
}

const _authBackfillDone = new Set();
async function _fbBackfillAuthUid(uid) {
  if (_authBackfillDone.has(uid)) return;
  _authBackfillDone.add(uid);
  try {
    const authUid = await fbGetAuthUid();
    if (!authUid) return;
    const snap = await db.collection('users').doc(uid).get();
    if (snap.exists && snap.data().auth_uid !== authUid) {
      await snap.ref.update({ auth_uid: authUid });
    }
  } catch (e) { /* best-effort, 실패해도 무시 */ }
}

const FB_ADMIN_ID        = 'c50c82b2-fe0e-4ee9-be8c-8132f03b9cb6';
const FB_AI_ID           = '578873e7-47b7-48d3-9cd8-894546196205'; // AI 자동참여 전용 봇 계정 (관리자 계정과 분리)
var FB_VOTE_THRESHOLD  = 3;
const _closingEpisodes = new Set(); // 동시 중복 마감 방지

// ─── 유틸 ────────────────────────────────────────────────

function fbGenId() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

function fbNow() { return new Date().toISOString(); }

// index.html의 calcDisplayStep과 동일한 규칙 — 분기 생성 시점에 정확한
// branch_display_offset을 미리 계산해서 저장하기 위한 백엔드용 버전
function _calcDisplayStepBackend(storyData, epStep) {
  if (storyData.branch_display_offset !== undefined && storyData.branch_display_offset !== null) {
    return Number(storyData.branch_display_offset) + Number(epStep);
  }
  if (storyData.branch_from_step) return (Number(storyData.branch_from_step) - 1) + Number(epStep);
  return Number(epStep) + 1;
}

async function fbHashPw(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

const FB_AVATAR_SHOP = [
  { id:'🍂', label:'낙엽',    price: 1000 },
  { id:'🌾', label:'벼이삭',  price: 1000 },
  { id:'🍄', label:'버섯',    price: 1400 },
  { id:'🌵', label:'선인장',  price: 1400 },
  { id:'🎋', label:'대나무',  price: 1600 },
  { id:'🌻', label:'해바라기', price: 1600 },
  { id:'🌰', label:'씨앗',    price: 2000 },
  { id:'🌱', label:'새싹',    price: 2000 },
  { id:'🦋', label:'나비',    price: 2400 },
  { id:'🌊', label:'파도',    price: 2400 },
  { id:'🌙', label:'달',      price: 3000 },
  { id:'🌸', label:'꽃봉오리', price: 3000 },
  { id:'🌼', label:'꽃',      price: 3000 },
  { id:'⭐', label:'별',      price: 4000 },
  { id:'🔥', label:'불꽃',   price: 4000 },
  { id:'🍎', label:'사과',    price: 5000 },
  { id:'🌳', label:'나무',    price: 6000 },
  { id:'🍁', label:'단풍',    price: 7000 },
  { id:'🍀', label:'네잎클로버', price: 8500 },
  { id:'🌈', label:'무지개',  price: 10000 },
  { id:'👑', label:'왕관',    price: 15000 },
];

function fbCalcBadge(pts) {
  if (pts >= 10000) return 'fruit';
  if (pts >= 7000) return 'flower1';
  if (pts >= 5000) return 'flower';
  if (pts >= 3500) return 'bud';
  if (pts >= 2500) return 'leaf2';
  if (pts >= 1700) return 'leaf1';
  if (pts >= 1000) return 'leaf';
  if (pts >= 550)  return 'sprout2';
  if (pts >= 350)  return 'sprout1';
  if (pts >= 150)  return 'sprout';
  if (pts >= 60)   return 'seed2';
  if (pts >= 20)   return 'seed1';
  return 'seed';
}

// ─── 세션 ────────────────────────────────────────────────

async function fbGetSession(token) {
  if (!token) return null;
  const uid = localStorage.getItem('hwasee_uid');
  if (!uid) return null;
  try {
    const [snap, secSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('user_secrets').doc(uid).get(),
    ]);
    if (!snap.exists || !secSnap.exists) return null;
    const u = snap.data();
    const sec = secSnap.data();
    if (sec.token !== token) return null;
    if (new Date(sec.token_exp) < new Date()) {
      const new_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await secSnap.ref.update({ token_exp: new_exp });
    }
    return { user_id: uid, nickname: u.nickname, display_name: u.display_name || u.nickname, total_points: u.total_points || 0, badge: u.badge || 'seed' };
  } catch(e) { return undefined; } // undefined = 네트워크 오류 (null = 확실한 토큰 무효)
}

// ─── 포인트 ──────────────────────────────────────────────

async function _fbAddPoints(user_id, pts, reason, sub_id) {
  if (!user_id || pts <= 0 || user_id === FB_AI_ID) return;
  const uRef = db.collection('users').doc(user_id);
  await db.runTransaction(async tx => {
    const snap = await tx.get(uRef);
    if (!snap.exists) return;
    const newPts = (snap.data().total_points || 0) + pts;
    tx.update(uRef, {
      total_points: newPts,
      ...(user_id !== FB_ADMIN_ID ? { badge: fbCalcBadge(newPts) } : {}),
    });
    tx.set(db.collection('point_ledger').doc(fbGenId()), {
      user_id, sub_id: sub_id || '', points: pts, reason, created_at: fbNow()
    });
  });
}

async function _fbSpendPoints(user_id, pts, reason) {
  if (!user_id || pts <= 0) return { ok: false, error: '잘못된 요청입니다.' };
  if (user_id === FB_ADMIN_ID) return { ok: true };
  const uRef = db.collection('users').doc(user_id);
  let remaining;
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(uRef);
      if (!snap.exists) throw new Error('유저를 찾을 수 없습니다.');
      const cur = snap.data().total_points || 0;
      if (cur < pts) throw new Error(`포인트가 부족합니다. (필요: ${pts}P, 보유: ${cur}P)`);
      remaining = cur - pts;
      tx.update(uRef, { total_points: remaining, badge: fbCalcBadge(remaining) });
      tx.set(db.collection('point_ledger').doc(fbGenId()), {
        user_id, sub_id: '', points: -pts, reason, created_at: fbNow()
      });
    });
  } catch(e) { return { ok: false, error: e.message }; }
  return { ok: true, remaining };
}

// ─── 인증 ────────────────────────────────────────────────

async function fbRegister(nickname, password, name, display_name, referral) {
  if (!nickname || !password) return { ok: false, error: '아이디와 비밀번호를 입력해주세요.' };
  if (!/^[가-힣a-zA-Z0-9]{2,12}$/.test(nickname)) return { ok: false, error: '아이디는 2~12자, 한글·영문·숫자만 사용할 수 있어요.' };
  if (password.length < 8) return { ok: false, error: '비밀번호는 8자 이상입니다.' };

  const dn = (display_name || '').trim() || nickname;
  if (!/^[가-힣a-zA-Z0-9 ._-]{2,12}$/.test(dn)) return { ok: false, error: '닉네임은 2~12자, 한글·영문·숫자·공백·._- 만 사용할 수 있어요.' };

  const [dupId, dupDn] = await Promise.all([
    db.collection('users').where('nickname', '==', nickname).limit(1).get(),
    db.collection('users').where('display_name', '==', dn).limit(1).get(),
  ]);
  if (!dupId.empty) return { ok: false, error: '이미 사용 중인 아이디입니다.' };
  if (!dupDn.empty) return { ok: false, error: '이미 사용 중인 닉네임입니다.' };

  const user_id   = fbGenId();
  const token     = fbGenId();
  const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // 신규 가입자는 가입 이전 패치 내역을 볼 필요 없으니, 현재 시점 최신 패치를
  // "이미 본 것"으로 시작해서 공지 팝업이 뜨지 않게 함 (가입 이후 새로 올라오는 것만 노출)
  const latestPatchSnap = await db.collection('patch_notes').orderBy('created_at', 'desc').limit(1).get();
  const initialSeenPatchId = latestPatchSnap.empty ? '' : latestPatchSnap.docs[0].data().patch_id;

  await db.collection('users').doc(user_id).set({
    user_id, nickname, display_name: dn,
    total_points: 0, adoption_count: 0, badge: 'seed', name: (name || '').trim(),
    referral: (referral || '').trim(), created_at: fbNow(),
    last_seen_patch_id: initialSeenPatchId,
    auth_uid: await fbGetAuthUid()
  });
  await db.collection('user_secrets').doc(user_id).set({
    pw_hash: await fbHashPw(password), token, token_exp
  });

  localStorage.setItem('hwasee_uid', user_id);
  return { ok: true, token, user_id, nickname, display_name: dn, total_points: 0, badge: 'seed', is_admin: user_id === FB_ADMIN_ID };
}

async function fbLogin(nickname, password) {
  if (!nickname || !password) return { ok: false, error: '닉네임과 비밀번호를 입력해주세요.' };

  const snap = await db.collection('users').where('nickname', '==', nickname).limit(1).get();
  if (snap.empty) return { ok: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };

  const doc     = snap.docs[0];
  const u       = doc.data();
  const secSnap = await db.collection('user_secrets').doc(doc.id).get();
  const sec     = secSnap.exists ? secSnap.data() : {};
  if (sec.pw_hash !== await fbHashPw(password)) return { ok: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };

  const token     = fbGenId();
  const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.collection('user_secrets').doc(doc.id).set({ token, token_exp }, { merge: true });
  const authUid = await fbGetAuthUid();
  if (authUid) await doc.ref.update({ auth_uid: authUid }).catch(() => {});
  localStorage.setItem('hwasee_uid', u.user_id);

  const daily_bonus = await _fbCheckDailyBonus(u.user_id);

  // 기존 유저 display_name 자동 마이그레이션
  if (!u.display_name) await doc.ref.update({ display_name: u.nickname });

  return {
    ok: true, token, user_id: u.user_id, nickname: u.nickname,
    display_name: u.display_name || u.nickname,
    total_points: u.total_points || 0, badge: u.badge || 'seed',
    is_admin: u.user_id === FB_ADMIN_ID, daily_bonus, adoption_count: u.adoption_count || 0
  };
}

async function _fbCheckDailyBonus(user_id) {
  const today = new Date().toISOString().slice(0, 10);
  const uRef  = db.collection('users').doc(user_id);
  const uSnap = await uRef.get();
  if (!uSnap.exists || uSnap.data().last_daily_bonus_date === today) return 0;
  await uRef.update({ last_daily_bonus_date: today });
  await _fbAddPoints(user_id, 10, 'daily_login', '');
  return 10;
}

async function fbChangePassword(user_id, current_password, new_password) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  const secRef  = db.collection('user_secrets').doc(user_id);
  const secSnap = await secRef.get();
  if (!secSnap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
  const sec = secSnap.data();
  if (sec.pw_hash !== await fbHashPw(current_password)) return { ok: false, error: '현재 비밀번호가 올바르지 않습니다.' };
  await secRef.update({ pw_hash: await fbHashPw(new_password) });
  return { ok: true };
}

async function fbDeleteAccount(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  if (user_id === FB_ADMIN_ID) return { ok: false, error: '관리자 계정은 탈퇴할 수 없습니다.' };
  const batch = db.batch();
  batch.delete(db.collection('users').doc(user_id));
  batch.delete(db.collection('user_secrets').doc(user_id));
  const [bmSnap, nSnap] = await Promise.all([
    db.collection('bookmarks').where('user_id', '==', user_id).get(),
    db.collection('notifications').where('user_id', '==', user_id).get(),
  ]);
  bmSnap.docs.forEach(d => batch.delete(d.ref));
  nSnap.docs.forEach(d => batch.delete(d.ref));
  batch.set(db.collection('config').doc('stats'), { deleted_count: firebase.firestore.FieldValue.increment(1) }, { merge: true });
  await batch.commit();
  localStorage.removeItem('hwasee_uid');
  return { ok: true };
}

async function fbFindAccount(name) {
  const nameVal = (name || '').trim();
  if (nameVal.length < 2) return { ok: false, error: '이름을 2자 이상 입력해주세요.' };
  const snap = await db.collection('users').where('name', '==', nameVal).get();
  if (snap.empty) return { ok: false, error: '해당 이름으로 가입된 계정이 없습니다.' };
  const accounts = snap.docs.map(d => {
    const nick = d.data().nickname || '';
    return { masked_nickname: nick.length > 1 ? nick[0] + '*'.repeat(nick.length - 1) : nick };
  });
  return { ok: true, accounts };
}

async function fbResetPassword(nickname, name, new_password) {
  if (!nickname || !name || !new_password) return { ok: false, error: '모든 항목을 입력해주세요.' };
  if (new_password.length < 8) return { ok: false, error: '비밀번호는 8자 이상이어야 합니다.' };
  const snap = await db.collection('users').where('nickname', '==', nickname).limit(1).get();
  if (snap.empty) return { ok: false, error: '닉네임 또는 이름이 일치하지 않습니다.' };
  const doc = snap.docs[0];
  const u   = doc.data();
  if (!u.name || u.name.trim() !== name.trim()) return { ok: false, error: '닉네임 또는 이름이 일치하지 않습니다.' };
  await db.collection('user_secrets').doc(doc.id).set({ pw_hash: await fbHashPw(new_password) }, { merge: true });
  return { ok: true };
}

// ─── 이야기 ──────────────────────────────────────────────

async function fbGetStories(page) {
  const p = Number(page) || 1;

  if (p === 1) {
    const [storiesSnap, episodesSnap, boostsSnap] = await Promise.all([
      db.collection('stories').where('status', '==', 'active').get(),
      db.collection('episodes').where('status', '==', 'open').get(),
      db.collection('boosts').where('expires_at', '>', fbNow()).get(),
    ]);

    const openVoteMap = {}, openEpsByStory = {};
    episodesSnap.docs.forEach(d => {
      const e = d.data();
      const cur = openVoteMap[e.story_id] || 0;
      if ((e.vote_total || 0) > cur) openVoteMap[e.story_id] = e.vote_total || 0;
      (openEpsByStory[e.story_id] = openEpsByStory[e.story_id] || []).push({ episode_id: d.id, step: Number(e.step) });
    });
    const boostSet = new Set(boostsSnap.docs.map(d => d.data().story_id));

    // 현재 열린 단계(들)에 제출된 글 개수 (카드에 분기별 "N개" 표시용) — 열린 에피소드 전체 기준
    const subCountMap = {};
    const openEpIds = episodesSnap.docs.map(d => d.id);
    if (openEpIds.length) {
      const _chunks = arr => { const c = []; for (let i = 0; i < arr.length; i += 30) c.push(arr.slice(i, i+30)); return c; };
      const subChunkSnaps = await Promise.all(
        _chunks(openEpIds).map(ch => db.collection('submissions').where('episode_id', 'in', ch).get())
      );
      subChunkSnaps.forEach(snap => snap.docs.forEach(d => {
        if (d.data().is_ai) return;
        const epId = d.data().episode_id;
        subCountMap[epId] = (subCountMap[epId] || 0) + 1;
      }));
    }

    // 1시간 경과 + 참여자 0 + AI 씨앗 → inactive 처리 + 생성자에게 알림 + 오프닝 복구
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const abandoned = storiesSnap.docs.filter(d => {
      const s = d.data();
      return s.is_ai_seed === true && (s.participant_count || 0) === 0 && (s.created_at || '') < oneHourAgo;
    });
    if (abandoned.length) await _fbRecycleAbandonedSeeds(abandoned);
    const recycledSet = new Set(abandoned.map(d => d.id));

    const stories = storiesSnap.docs.filter(d => !recycledSet.has(d.id)).map(d => ({
      ...d.data(),
      is_boosted:        boostSet.has(d.id),
      activity_count:    d.data().participant_count || 0,
      creator_nickname:  d.data().creator_nickname || '익명',
      creator_badge:     d.data().creator_badge    || '',
      open_eps: (openEpsByStory[d.id] || [])
        .sort((a, b) => a.step - b.step)
        .map(e => ({ step: e.step, sub_count: subCountMap[e.episode_id] || 0 })),
    }));

    stories.sort((a, b) => {
      if (a.is_boosted !== b.is_boosted) return a.is_boosted ? -1 : 1;
      const vDiff = (openVoteMap[b.story_id] || 0) - (openVoteMap[a.story_id] || 0);
      if (vDiff !== 0) return vDiff;
      return new Date(a.created_at) - new Date(b.created_at);
    });

    return { ok: true, stories, page: 1 };
  } else {
    const storiesSnap = await db.collection('stories').where('status', '==', 'completed').get();
    const stories = storiesSnap.docs
      .map(d => ({ ...d.data(), like_count: d.data().like_count || 0 }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { ok: true, stories, page: 2 };
  }
}

async function fbGetStory(story_id, user_id) {
  const [storySnap, episodesSnap, primarySubsSnap, commSnap, mvpSnap] = await Promise.all([
    db.collection('stories').doc(story_id).get(),
    db.collection('episodes').where('story_id', '==', story_id).get(),
    db.collection('submissions').where('story_id', '==', story_id).get(),
    db.collection('comments').where('story_id', '==', story_id).get(),
    db.collection('story_mvp').where('story_id', '==', story_id).get(),
  ]);

  if (!storySnap.exists || storySnap.data().status === 'deleted') return { ok: false, error: '스토리를 찾을 수 없습니다.' };

  // story_id 필드가 없는 구형 제출물 보완: episode_id 기준 병렬 조회 후 병합
  const epIds = episodesSnap.docs.map(d => d.id);
  const subMap = new Map(primarySubsSnap.docs.map(d => [d.id, d]));
  if (epIds.length > 0) {
    const batches = [];
    for (let i = 0; i < epIds.length; i += 10) batches.push(epIds.slice(i, i + 10));
    const fallbackSnaps = await Promise.all(
      batches.map(b => db.collection('submissions').where('episode_id', 'in', b).get())
    );
    fallbackSnaps.forEach(snap => snap.docs.forEach(d => { if (!subMap.has(d.id)) subMap.set(d.id, d); }));
  }
  const subsSnap = { docs: [...subMap.values()] };

  // 동기 메타 추출
  const story    = storySnap.data();
  const episodes = episodesSnap.docs.map(d => ({ episode_id: d.id, ...d.data() }));
  const openEp    = episodes.find(e => e.status === 'open');
  const storyCommentDocs = commSnap.docs.filter(d => (d.data().sub_id || '') === '');
  const authorIds = [...new Set([
    ...subsSnap.docs.map(d => d.data().author_id),
    ...storyCommentDocs.map(d => d.data().author_id),
  ].filter(Boolean))];
  const storySubIds = new Set(subsSnap.docs.map(d => d.id));

  const commentCountMap = {};
  commSnap.docs.forEach(d => {
    const sid = d.data().sub_id;
    if (sid) commentCountMap[sid] = (commentCountMap[sid] || 0) + (d.data().deleted ? 0 : 1);
  });

  // Round 2 전: B갈래 분기 sub_id 미리 계산 (Round 2에서 직접 fetch하기 위해)
  const _preBranchSubId = (() => {
    if (!story.parent_story_id || !story.branch_from_step) return null;
    const orphanStep = Number(story.branch_from_step) - 1;
    const orphanEp = episodes.find(e => Number(e.step) === orphanStep && e.parent_sub_id);
    return orphanEp ? orphanEp.parent_sub_id : (story.branch_sub_id || null);
  })();

  // Round 2: 나머지 모든 조회를 한 번에 병렬 처리
  const storySubIdArr = [...storySubIds];
  const [userDocs, bmSnap, likeSnap, voteSnap, branchSnap, pEpsSnap, pSubsSnap, bSubSnap] = await Promise.all([
    authorIds.length > 0
      ? Promise.all(authorIds.map(id => db.collection('users').doc(id).get()))
      : Promise.resolve([]),
    user_id
      ? db.collection('bookmarks').where('user_id','==',user_id).where('story_id','==',story_id).limit(1).get()
      : Promise.resolve(null),
    user_id
      ? db.collection('story_likes').where('story_id','==',story_id).where('user_id','==',user_id).limit(1).get()
      : Promise.resolve(null),
    user_id && storySubIdArr.length > 0
      ? Promise.all(
          Array.from({ length: Math.ceil(storySubIdArr.length / 30) }, (_, i) =>
            db.collection('votes').where('voter_id','==',user_id).where('sub_id','in',storySubIdArr.slice(i*30,(i+1)*30)).get()
          )
        ).then(snaps => ({ docs: snaps.flatMap(s => s.docs) }))
      : Promise.resolve(null),
    db.collection('stories').where('parent_story_id', '==', story_id).get(),
    story.parent_story_id
      ? db.collection('episodes').where('story_id', '==', story.parent_story_id).get()
      : Promise.resolve(null),
    story.parent_story_id
      ? db.collection('submissions').where('story_id', '==', story.parent_story_id).get()
      : Promise.resolve(null),
    _preBranchSubId
      ? db.collection('submissions').doc(_preBranchSubId).get()
      : Promise.resolve(null),
  ]);

  // 마감 대기 에피소드 비동기 복구 — await 제거로 페이지 렌더를 차단하지 않음
  if (openEp) {
    const stuckMaxV = subsSnap.docs
      .filter(d => d.data().episode_id === openEp.episode_id)
      .reduce((m, d) => Math.max(m, Number(d.data().vote_count) || 0), 0);
    if (stuckMaxV >= FB_VOTE_THRESHOLD) {
      _fbCloseEpisode(openEp.episode_id, { ...openEp }).catch(() => {});
    }
  }

  const nickMap = {}, badgeMap = {};
  userDocs.forEach(d => { if (d.exists) { nickMap[d.id] = d.data().display_name || d.data().nickname; badgeMap[d.id] = d.data().badge; } });

  const submissions = subsSnap.docs.map(d => ({
    sub_id: d.id,
    ...d.data(),
    author_nickname: d.data().is_ai ? '익명' : (nickMap[d.data().author_id] || '익명'),
    author_badge:    d.data().is_ai ? 'seed' : (badgeMap[d.data().author_id] || 'seed'),
    comment_count:   commentCountMap[d.id] || 0,
  }));

  const is_bookmarked    = bmSnap   ? !bmSnap.empty   : false;
  const like_count       = storySnap.data().like_count || 0;
  const is_liked         = (user_id && likeSnap) ? !likeSnap.empty : false;
  const my_voted_sub_ids = (voteSnap && user_id) ? voteSnap.docs.map(d => d.data().sub_id).filter(Boolean) : [];
  // branch_from_step 기준 중복 제거 (같은 단계에 여러 fork가 생긴 경우 active 우선)
  const _branchRaw = branchSnap.docs.map(d => ({
    story_id: d.data().story_id || d.id,
    branch_from_step: Number(d.data().branch_from_step),
    is_continuation: !!d.data().is_continuation,
    status: d.data().status,
    branch_episode_id: d.data().branch_episode_id || null,
    branch_sub_id: d.data().branch_sub_id || null,
    branch_leaf_episode_id: d.data().branch_leaf_episode_id || null,
    branch_leaf_sub_id: d.data().branch_leaf_sub_id || null,
  })).sort((a, b) => (a.status === 'active' ? -1 : 1));
  const _branchSeen = new Set();
  const branches = _branchRaw.filter(b => {
    const key = `${b.branch_from_step}_${b.is_continuation}`;
    if (_branchSeen.has(key)) return false;
    _branchSeen.add(key);
    return true;
  });

  // MVP 투표 현황
  const mvp_map = {};
  let my_mvp_episode_id = null;
  mvpSnap.docs.forEach(d => {
    const m = d.data();
    if (m.episode_id) mvp_map[m.episode_id] = (mvp_map[m.episode_id] || 0) + 1;
    if (user_id && m.voter_id === user_id) my_mvp_episode_id = m.episode_id || null;
  });

  // 분기 이야기면 부모 단계 가져오기 (잠금 산문용) — Round 2와 병렬로 이미 조회 완료
  let parent_chain = null;
  if (story.parent_story_id && pEpsSnap && pSubsSnap) {
    // 부모 에피소드 작가 중 현재 nickMap에 없는 ID 추가 조회
    const missingPIds = [...new Set(pSubsSnap.docs.map(d => d.data().author_id).filter(id => id && !nickMap[id]))];
    if (missingPIds.length) {
      const extraDocs = await Promise.all(missingPIds.map(id => db.collection('users').doc(id).get()));
      extraDocs.forEach(d => { if (d.exists) { nickMap[d.id] = d.data().display_name || d.data().nickname; badgeMap[d.id] = d.data().badge; } });
    }
    const pEps = pEpsSnap.docs
      .map(d => ({ episode_id: d.id, ...d.data() }))
      .filter(e => e.status === 'closed');
    // B sub의 episode_id로 fork 에피소드 ID 역산 (step 계산보다 신뢰도 높음)
    const _preBranchEpisodeId = (() => {
      // 1순위: B sub (bSubSnap or pSubsSnap)의 episode_id 직접 사용
      if (bSubSnap && bSubSnap.exists && bSubSnap.data().episode_id)
        return bSubSnap.data().episode_id;
      if (_preBranchSubId) {
        const subDoc = pSubsSnap.docs.find(d => d.id === _preBranchSubId);
        if (subDoc && subDoc.data().episode_id) return subDoc.data().episode_id;
      }
      // 2순위: branch_from_step-1 단계로 역산
      if (!story.branch_from_step) return null;
      const forkStep = Number(story.branch_from_step) - 1;
      const doc = pEpsSnap.docs.find(d => Number(d.data().step) === forkStep);
      return doc ? doc.id : null;
    })();
    // B sub ID: _preBranchSubId(=story.branch_sub_id) 우선, 없으면 fork ep의 non-adopted sub
    const _actualBranchSubId = (() => {
      if (_preBranchSubId) return _preBranchSubId;
      if (!_preBranchEpisodeId) return null;
      const nonAdopted = pSubsSnap.docs.find(d => {
        const data = d.data();
        return data.episode_id === _preBranchEpisodeId &&
               data.is_adopted !== true && data.is_adopted !== 'TRUE';
      });
      return nonAdopted ? nonAdopted.id : null;
    })();
    // B sub: story_id/episode_id 없는 구형 데이터 대응
    const pSubMap = new Map(pSubsSnap.docs.map(d => [d.id, d]));
    if (bSubSnap && bSubSnap.exists && !pSubMap.has(bSubSnap.id)) pSubMap.set(bSubSnap.id, bSubSnap);
    const pSubs = [...pSubMap.values()].map(d => {
      const data = d.data();
      const isBranchSub = _actualBranchSubId && d.id === _actualBranchSubId;
      return {
        sub_id: d.id,
        ...data,
        episode_id: data.episode_id || (isBranchSub ? _preBranchEpisodeId : null),
        // B갈래 sub: fork 에피소드에서 탭 표시를 위해 adopted로 처리 (Firestore 변경 없음)
        is_adopted: isBranchSub ? true : data.is_adopted,
        author_nickname: data.is_ai ? '익명' : (nickMap[data.author_id] || '익명'),
        author_badge:    data.is_ai ? 'seed' : (badgeMap[data.author_id] || 'seed'),
      };
    });
    parent_chain = { episodes: pEps, submissions: pSubs };
  }

  // 분기 이야기: fork 에피소드 ID + B갈래 sub_id 서버에서 직접 계산
  let branch_sub_id = story.branch_sub_id || null;
  let branch_episode_id = story.branch_episode_id || null;
  if (story.parent_story_id && story.branch_from_step) {
    // 1순위: B sub의 episode_id로 fork ep 역산 (bSubSnap / pSubsSnap)
    if (!branch_episode_id && branch_sub_id && bSubSnap && bSubSnap.exists && bSubSnap.data().episode_id)
      branch_episode_id = bSubSnap.data().episode_id;
    if (!branch_episode_id && branch_sub_id && pSubsSnap) {
      const sd = pSubsSnap.docs.find(d => d.id === branch_sub_id);
      if (sd && sd.data().episode_id) branch_episode_id = sd.data().episode_id;
    }
    // 2순위: branch_from_step - 2 단계로 역산 (branch_from_step = lastEp.step + 2)
    if (!branch_episode_id && pEpsSnap) {
      const forkStep = Number(story.branch_from_step) - 2;
      const forkEpDoc = pEpsSnap.docs.find(d => Number(d.data().step) === forkStep);
      if (forkEpDoc) branch_episode_id = forkEpDoc.id;
    }
    // orphan ep parent_sub_id (연장 이야기 방식 대응)
    if (!branch_sub_id) {
      const orphanStep = Number(story.branch_from_step) - 1;
      const orphanEp = episodes.find(e => Number(e.step) === orphanStep && e.parent_sub_id);
      if (orphanEp) branch_sub_id = orphanEp.parent_sub_id;
    }
    // 3순위: fork ep의 non-adopted sub
    if (!branch_sub_id && branch_episode_id && pSubsSnap) {
      const nonAdopted = pSubsSnap.docs.find(d =>
        d.data().episode_id === branch_episode_id &&
        d.data().is_adopted !== true && d.data().is_adopted !== 'TRUE'
      );
      if (nonAdopted) branch_sub_id = nonAdopted.id;
    }
  }

  const storyWithCreator = {
    ...story,
    creator_nickname: story.creator_nickname || '익명',
    creator_badge:    story.creator_badge    || '',
    branch_sub_id,
    branch_episode_id,
  };

  // 외부 분기(들)의 자체 콘텐츠(에피소드+제출물)도 같이 내려줌 —
  // 부모 이야기 산문뷰에서 분기 탭을 눌렀을 때 별도 API 왕복 없이 그 자리에서 바로 보여주기 위함
  const forkBranchList = branches.filter(b => !b.is_continuation);
  if (forkBranchList.length) {
    const branchDataArr = await Promise.all(forkBranchList.map(async b => {
      const [bEpsSnap, bSubsSnap] = await Promise.all([
        db.collection('episodes').where('story_id', '==', b.story_id).where('status', '==', 'closed').get(),
        db.collection('submissions').where('story_id', '==', b.story_id).get(),
      ]);
      const bEps = bEpsSnap.docs.map(d => ({ episode_id: d.id, ...d.data() }));
      const bAuthorIds = [...new Set(bSubsSnap.docs.map(d => d.data().author_id).filter(id => id && !nickMap[id]))];
      if (bAuthorIds.length) {
        const extraDocs = await Promise.all(bAuthorIds.map(id => db.collection('users').doc(id).get()));
        extraDocs.forEach(d => { if (d.exists) { nickMap[d.id] = d.data().display_name || d.data().nickname; badgeMap[d.id] = d.data().badge; } });
      }
      const bSubs = bSubsSnap.docs.map(d => {
        const data = d.data();
        return {
          sub_id: d.id, ...data,
          author_nickname: data.is_ai ? '익명' : (nickMap[data.author_id] || '익명'),
          author_badge:    data.is_ai ? 'seed' : (badgeMap[data.author_id] || 'seed'),
        };
      });
      return { story_id: b.story_id, episodes: bEps, submissions: bSubs };
    }));
    const branchDataMap = new Map(branchDataArr.map(bd => [bd.story_id, bd]));
    branches.forEach(b => {
      const bd = branchDataMap.get(b.story_id);
      if (bd) { b.episodes = bd.episodes; b.submissions = bd.submissions; }
    });
  }

  const story_comments = storyCommentDocs
    .map(d => ({ comment_id: d.id, ...d.data(), author_nickname: nickMap[d.data().author_id] || '익명' }))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  return { ok: true, story: storyWithCreator, episodes, submissions, is_bookmarked, is_liked, like_count, my_voted_sub_ids, branches, parent_chain, mvp_map, my_mvp_episode_id, story_comments };
}

async function fbCreateStory(opening, creator_id, is_ai_seed) {
  if (!opening || !opening.trim()) return { ok: false, error: '시작 문장을 입력해주세요.' };
  const story_id = fbGenId(), episode_id = fbGenId();
  let creator_nickname = '익명', creator_badge = '';
  if (!is_ai_seed) {
    const uDoc = await db.collection('users').doc(creator_id).get();
    const uData = uDoc.exists ? uDoc.data() : {};
    creator_nickname = uData.display_name || uData.nickname || '익명';
    creator_badge    = uData.badge || 'seed';
  }
  const batch = db.batch();
  batch.set(db.collection('stories').doc(story_id), {
    story_id, opening: opening.trim(), max_steps: 10, current_step: 0,
    status: 'active', creator_id, creator_nickname, creator_badge,
    created_at: fbNow(), batch: '', participant_count: 0, like_count: 0,
    is_ai_seed: !!is_ai_seed,
  });
  batch.set(db.collection('episodes').doc(episode_id), {
    episode_id, story_id, step: 1, parent_sub_id: '',
    status: 'open', vote_total: 0, created_at: fbNow(), closed_at: '', pending_at: ''
  });
  await batch.commit();
  if (is_ai_seed && opening) {
    await db.collection('config').doc('used_openings').set(
      { [opening.trim()]: true }, { merge: true }
    );
  }
  return { ok: true, story_id, episode_id };
}

async function fbGetMyStories(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };

  const [mySubsSnap, myVotesSnap] = await Promise.all([
    db.collection('submissions').where('author_id', '==', user_id).limit(300).get(),
    db.collection('votes').where('voter_id', '==', user_id).limit(300).get(),
  ]);

  // 제출에서 story_id 직접 추출 (submissions에 story_id 저장돼 있음)
  const storyIdSet = new Set(mySubsSnap.docs.filter(d => !d.data().is_ai).map(d => d.data().story_id).filter(Boolean));
  const voteEpIds  = [...new Set(myVotesSnap.docs.map(d => d.data().episode_id).filter(Boolean))];

  // 투표 episode_id → story_id 해석 (제출 없이 투표만 한 경우)
  if (voteEpIds.length > 0) {
    const batches = [];
    for (let i = 0; i < voteEpIds.length; i += 10) batches.push(voteEpIds.slice(i, i+10));
    const snaps = await Promise.all(
      batches.map(b => db.collection('episodes').where(firebase.firestore.FieldPath.documentId(), 'in', b).get())
    );
    snaps.forEach(s => s.docs.forEach(d => { if (d.data().story_id) storyIdSet.add(d.data().story_id); }));
  }

  if (storyIdSet.size === 0) return { ok: true, stories: [] };

  const idBatches = [];
  const storyIdArr = [...storyIdSet];
  for (let i = 0; i < storyIdArr.length; i += 10) idBatches.push(storyIdArr.slice(i, i+10));

  // 관련 story/episode만 조회
  const [storySnaps, epSnaps] = await Promise.all([
    Promise.all(idBatches.map(b => db.collection('stories').where(firebase.firestore.FieldPath.documentId(), 'in', b).get())),
    Promise.all(idBatches.map(b => db.collection('episodes').where('story_id', 'in', b).get())),
  ]);

  const epMap = {};
  epSnaps.forEach(s => s.docs.forEach(d => { epMap[d.id] = d.data(); }));

  const openEpMap = {}, openEpMaxMap = {}, openEpsByStoryId = {};
  Object.entries(epMap).forEach(([epId, ep]) => {
    if (ep.status === 'open') {
      const prev    = openEpMap[ep.story_id];
      const prevMax = openEpMaxMap[ep.story_id];
      if (!prev    || ep.step < (epMap[prev]?.step    ?? Infinity))  openEpMap[ep.story_id]    = epId;
      if (!prevMax || ep.step > (epMap[prevMax]?.step ?? -Infinity)) openEpMaxMap[ep.story_id] = epId;
      (openEpsByStoryId[ep.story_id] = openEpsByStoryId[ep.story_id] || []).push(epId);
    }
  });

  const myVoteCountMap = {};
  myVotesSnap.docs.forEach(d => {
    const epId = d.data().episode_id;
    if (epId) myVoteCountMap[epId] = (myVoteCountMap[epId] || 0) + 1;
  });

  // 현재 열린 단계(들)에 제출된 글 개수 (카드에 분기별 "N개" 표시용) — 열린 에피소드 전체 기준
  const subCountMap = {};
  const openEpIds = [...new Set(Object.values(openEpsByStoryId).flat())];
  if (openEpIds.length) {
    const _chunks = arr => { const c = []; for (let i = 0; i < arr.length; i += 30) c.push(arr.slice(i, i+30)); return c; };
    const subChunkSnaps = await Promise.all(
      _chunks(openEpIds).map(ch => db.collection('submissions').where('episode_id', 'in', ch).get())
    );
    subChunkSnaps.forEach(snap => snap.docs.forEach(d => {
      if (d.data().is_ai) return;
      const epId = d.data().episode_id;
      subCountMap[epId] = (subCountMap[epId] || 0) + 1;
    }));
  }

  const mySubsArr = mySubsSnap.docs.map(d => ({
    ...d.data(),
    step:      epMap[d.data().episode_id] ? Number(epMap[d.data().episode_id].step) : 0,
    ep_status: epMap[d.data().episode_id]?.status || 'closed',
  }));

  const stories = [];
  storySnaps.forEach(snap => snap.docs.forEach(d => {
    const s = d.data();
    if (s.status === 'deleted' || s.status === 'inactive') return;
    const openEpId = openEpMap[s.story_id];
    stories.push({
      ...s,
      mySubmissions:     mySubsArr.filter(sub => sub.story_id === s.story_id).sort((a,b) => a.step - b.step),
      activity_count:    s.participant_count || 0,
      has_voted_current: openEpId != null ? (myVoteCountMap[openEpId] || 0) : null,
      open_eps: (openEpsByStoryId[s.story_id] || [])
        .map(id => ({ step: Number(epMap[id].step), sub_count: subCountMap[id] || 0 }))
        .sort((a, b) => a.step - b.step),
    });
  }));

  // 주목 여부 반영 (in + 부등호 복합쿼리 인덱스 이슈로 JS 필터링)
  const allStoryIds = stories.map(s => s.story_id).filter(Boolean);
  if (allStoryIds.length > 0) {
    const nowIso = new Date().toISOString();
    const boostBatches = [];
    for (let i = 0; i < allStoryIds.length; i += 10) boostBatches.push(allStoryIds.slice(i, i+10));
    const boostSnaps = await Promise.all(boostBatches.map(b =>
      db.collection('boosts').where('story_id', 'in', b).get()
    ));
    const boostSet = new Set();
    boostSnaps.forEach(s => s.docs.forEach(d => {
      const data = d.data();
      if ((data.expires_at || '') > nowIso) boostSet.add(data.story_id);
    }));
    stories.forEach(s => { s.is_boosted = boostSet.has(s.story_id); });
  }

  stories.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { ok: true, stories };
}

// ─── 에피소드 ────────────────────────────────────────────

async function fbGetEpisode(episode_id) {
  if (!episode_id) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  const epSnap = await db.collection('episodes').doc(episode_id).get();
  if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  const ep = epSnap.data();
  if (!ep.story_id) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };

  const [subsSnap, storySnap, allEpsSnap, allSubsSnap] = await Promise.all([
    db.collection('submissions').where('episode_id', '==', episode_id).get(),
    db.collection('stories').doc(ep.story_id).get(),
    db.collection('episodes').where('story_id', '==', ep.story_id).get(),
    db.collection('submissions').where('story_id', '==', ep.story_id).get(),
  ]);

  ep.submissions = subsSnap.docs.map(d => d.data());
  const story     = storySnap.exists ? storySnap.data() : null;
  const storyEps  = allEpsSnap.docs.map(d => d.data());
  const storySubs = allSubsSnap.docs.map(d => d.data());

  const prevChain = [];
  let parentSubId = ep.parent_sub_id;
  while (parentSubId) {
    const sub = storySubs.find(s => s.sub_id === parentSubId);
    if (!sub) break;
    const parentEp = storyEps.find(e => e.episode_id === sub.episode_id);
    prevChain.unshift({ step: Number(parentEp?.step || 0), content: sub.content });
    parentSubId = parentEp?.parent_sub_id || null;
  }

  return { ok: true, episode: ep, story, prevChain };
}


async function _fbCloseEpisode(episode_id, ep) {
  if (_closingEpisodes.has(episode_id)) return;
  _closingEpisodes.add(episode_id);
  try {
  const epRef = db.collection('episodes').doc(episode_id);
  const alreadyClosed = await db.runTransaction(async tx => {
    const snap = await tx.get(epRef);
    const st = snap.data().status;
    if (!snap.exists || (st !== 'open' && st !== 'pending')) return true;
    tx.update(epRef, { status: 'closed', closed_at: fbNow() });
    return false;
  });
  if (alreadyClosed) return;

  if (!ep) {
    const snap = await epRef.get();
    if (!snap.exists) return;
    ep = snap.data();
  }

  const subsSnap = await db.collection('submissions').where('episode_id', '==', episode_id).get();
  if (subsSnap.empty) return;

  const allSubs  = subsSnap.docs.map(d => ({ ...d.data(), _ref: d.ref }));
  const maxVotes = Math.max(...allSubs.map(s => Number(s.vote_count) || 0));

  let winners;
  if (maxVotes === 0) {
    // 투표 없이 마감되면 가장 먼저 제출된 글 채택
    const sorted = [...allSubs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    winners = [sorted[0]];
  } else {
    winners = allSubs.filter(s => (Number(s.vote_count) || 0) === maxVotes);
  }
  for (const w of winners) {
    await w._ref.update({ is_adopted: true });
  }
  // 포인트 지급/입양수 증가는 클라이언트가 남의 계정에 직접 쓰지 않도록 서버(Cloud Function)로 이전됨
  await functionsRegion.httpsCallable('distributeEpisodeRewards')({ episode_id }).catch(() => {});

  const storySnap = await db.collection('stories').doc(ep.story_id).get();
  if (!storySnap.exists) return;

  const st       = storySnap.data();
  const nextStep = (Number(st.current_step) || 0) + 1;
  const anyClose = winners.some(w => w.is_closing === true);

  if (anyClose) {
    await storySnap.ref.update({ current_step: nextStep, status: 'completed' });

    // 남은 open 에피소드(다른 갈래)를 독립 active 스토리로 분리
    const orphanSnap = await db.collection('episodes')
      .where('story_id', '==', ep.story_id).where('status', '==', 'open').get();
    if (!orphanSnap.empty) {
      // 갈림길 역추적용: 원본 스토리의 모든 에피소드/제출물 미리 조회
      // (orphan의 parent_sub_id를 거슬러 올라가 실제로 동률이 갈라진 지점을 찾기 위함 —
      //  branch_from_step 숫자 역산은 신뢰할 수 없어 직접 조상 체인을 추적함)
      const [allEpsSnap, allSubsSnap] = await Promise.all([
        db.collection('episodes').where('story_id', '==', ep.story_id).get(),
        db.collection('submissions').where('story_id', '==', ep.story_id).get(),
      ]);
      const epById = new Map(allEpsSnap.docs.map(d => [d.id, { episode_id: d.id, ...d.data() }]));
      const subsByEp = new Map();
      allSubsSnap.docs.forEach(d => {
        const s = { sub_id: d.id, ...d.data() };
        if (!subsByEp.has(s.episode_id)) subsByEp.set(s.episode_id, []);
        subsByEp.get(s.episode_id).push(s);
      });
      const subById = new Map(allSubsSnap.docs.map(d => [d.id, { sub_id: d.id, ...d.data() }]));

      for (const orphanDoc of orphanSnap.docs) {
        const orphan = orphanDoc.data();
        const newStoryId = fbGenId();
        const spinBatch = db.batch();
        // 분리 전에 기존 제출자 수 확인 → participant_count 초기화에 사용
        const subSnap = await db.collection('submissions')
          .where('episode_id', '==', orphan.episode_id).get();
        const uniqueAuthors = new Set(subSnap.docs.filter(d => !d.data().is_ai).map(d => d.data().author_id).filter(Boolean));

        // orphan의 조상 체인을 거슬러 올라가며 두 지점을 구분해서 기록:
        // - branch_episode_id/sub_id: 가장 위쪽 동률(진짜 갈라진 지점) — 상속 경로 재구성용(_buildForkPath)
        // - branch_leaf_episode_id/sub_id: 원본 스토리 안에서 이 갈래가 끊기는 마지막 지점(orphan 바로 위)
        //   — "분기 이야기로 이동" 카드/탭을 표시할 정확한 위치용
        let branch_episode_id = null, branch_sub_id = null;
        let branch_leaf_episode_id = null, branch_leaf_sub_id = null;
        let curSubId = orphan.parent_sub_id || null;
        let isFirst = true;
        while (curSubId) {
          const curSub = subById.get(curSubId);
          if (!curSub) break;
          const curEp = epById.get(curSub.episode_id);
          if (!curEp) break;
          if (isFirst) {
            branch_leaf_episode_id = curEp.episode_id;
            branch_leaf_sub_id = curSubId;
            isFirst = false;
          }
          const adoptedCount = (subsByEp.get(curEp.episode_id) || [])
            .filter(s => s.is_adopted === true || s.is_adopted === 'TRUE').length;
          if (adoptedCount > 1) { branch_episode_id = curEp.episode_id; branch_sub_id = curSubId; }
          curSubId = curEp.parent_sub_id || null;
        }

        // 카드/산문뷰 단계 표시용: 원본 스토리 기준 진짜 이어지는 단계 번호를 정확히 계산
        let branch_display_offset = null;
        if (branch_leaf_episode_id) {
          const leafEp = epById.get(branch_leaf_episode_id);
          const leafDisplayStep = _calcDisplayStepBackend(st, Number(leafEp.step));
          branch_display_offset = leafDisplayStep - Number(orphan.step) + 1;
        }

        spinBatch.set(db.collection('stories').doc(newStoryId), {
          story_id: newStoryId, parent_story_id: ep.story_id,
          branch_from_step: Number(orphan.step) + 1,
          branch_episode_id, branch_sub_id,
          branch_leaf_episode_id, branch_leaf_sub_id,
          branch_display_offset,
          opening: st.opening, max_steps: st.max_steps || 10,
          current_step: Number(orphan.step) - 1, status: 'active',
          creator_id: st.creator_id,
          creator_nickname: st.creator_nickname || '익명',
          creator_badge: st.creator_badge || '',
          participant_count: uniqueAuthors.size, like_count: 0, adoption_count: 0,
          has_branch: false, created_at: fbNow(), batch: '',
        });
        spinBatch.update(orphanDoc.ref, { story_id: newStoryId });
        await spinBatch.commit();
        if (!subSnap.empty) {
          const subBatch = db.batch();
          subSnap.docs.forEach(d => subBatch.update(d.ref, { story_id: newStoryId }));
          await subBatch.commit();
        }
      }
    }
  } else {
    const storyUpdate = { current_step: nextStep };
    if (winners.length > 1) storyUpdate.has_branch = true;
    await storySnap.ref.update(storyUpdate);
    const epBatch = db.batch();
    for (const w of winners) {
      const newEpId = fbGenId();
      epBatch.set(db.collection('episodes').doc(newEpId), {
        episode_id: newEpId, story_id: ep.story_id, step: nextStep + 1,
        parent_sub_id: w.sub_id, status: 'open', vote_total: 0,
        created_at: fbNow(), closed_at: '', pending_at: ''
      });
    }
    await epBatch.commit();
  }
  // 알림은 onEpisodeClosed Cloud Function이 서버사이드에서 생성
  } finally {
    _closingEpisodes.delete(episode_id);
  }
}

async function _fbGetStoryParticipants(story_id) {
  const [subsSnap, bmSnap, commSnap, epsSnap] = await Promise.all([
    db.collection('submissions').where('story_id', '==', story_id).get(),
    db.collection('bookmarks').where('story_id', '==', story_id).get(),
    db.collection('comments').where('story_id', '==', story_id).get(),
    db.collection('episodes').where('story_id', '==', story_id).get(),
  ]);
  const epIds = new Set(epsSnap.docs.map(d => d.id));
  const ids   = [
    ...subsSnap.docs.map(d => d.data().author_id),
    ...bmSnap.docs.map(d => d.data().user_id),
    ...commSnap.docs.map(d => d.data().author_id),
  ];
  // 투표자 — epIds 전체를 10개씩 배치 처리
  if (epIds.size > 0) {
    const epArr = [...epIds];
    const batches = [];
    for (let i = 0; i < epArr.length; i += 10) batches.push(epArr.slice(i, i + 10));
    const vSnaps = await Promise.all(batches.map(b => db.collection('votes').where('episode_id', 'in', b).get()));
    vSnaps.forEach(s => s.docs.forEach(d => ids.push(d.data().voter_id)));
  }
  return [...new Set(ids.filter(Boolean))];
}

// ─── 제출 ────────────────────────────────────────────────

async function fbCreateSubmission(episode_id, content, author_id, derived_from, closing) {
  const text = (content || '').trim();
  if (!text)            return { ok: false, error: '내용을 입력해주세요.' };
  if (text.length > 50) return { ok: false, error: '50자 이내로 작성해주세요.' };

  const epSnap = await db.collection('episodes').doc(episode_id).get();
  if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  const ep = epSnap.data();
  if (ep.status !== 'open') return { ok: false, error: '제출이 마감됐습니다.' };

  const prevSubsSnap = await db.collection('submissions').where('episode_id','==',episode_id).get();
  const myPrevCount = prevSubsSnap.docs.filter(d => d.data().author_id === author_id && !d.data().is_ai).length;
  // 기본 1개 + 추가 제출권 구매 시 1개 더(최대 2개) — extra_submits 문서는 소모되지 않고
  // 계속 남아있어서, 예전엔 "존재 여부"만 확인해 2개를 넘겨도 계속 허용되는 버그가 있었음
  if (myPrevCount >= 2) return { ok: false, error: '이미 제출하셨습니다.' };
  if (myPrevCount === 1) {
    const exSnap = await db.collection('extra_submits')
      .where('episode_id','==',episode_id).where('user_id','==',author_id).limit(1).get();
    if (exSnap.empty) return { ok: false, error: '이미 제출하셨습니다.' };
  }

  const sub_id    = fbGenId();
  const is_closing = closing === true && Number(ep.step) >= 2;
  const uDoc = await db.collection('users').doc(author_id).get();
  const uData = uDoc.exists ? uDoc.data() : {};
  await db.collection('submissions').doc(sub_id).set({
    sub_id, episode_id, story_id: ep.story_id, content: text,
    author_id, author_nickname: uData.display_name || uData.nickname || '익명',
    author_badge: uData.badge || 'seed',
    derived_from: derived_from || '', vote_count: 0,
    is_adopted: false, created_at: fbNow(), is_closing
  });
  await _fbAddPoints(author_id, 10, 'submit', sub_id);

  // participant_count 증가 (첫 제출 시) — 복합 인덱스 없이 단일 필드 쿼리 후 클라이언트 필터
  const mySubsSnap = await db.collection('submissions')
    .where('author_id','==',author_id).get();
  const prevCount = mySubsSnap.docs.filter(d => d.data().story_id === ep.story_id && d.id !== sub_id).length;
  if (prevCount === 0) {
    const storyRef = db.collection('stories').doc(ep.story_id);
    await storyRef.update({ participant_count: firebase.firestore.FieldValue.increment(1) });
    // 첫 사람 제출이 step 1이면 해당 오프닝을 used_openings에 기록 (씨앗 중복 방지 — fbCreateStory에서도 마킹하지만 fallback)
    if (Number(ep.step) === 1) {
      const storySnap = await storyRef.get();
      const storyData = storySnap.exists ? storySnap.data() : null;
      if (storyData?.is_ai_seed && storyData.opening) {
        await db.collection('config').doc('used_openings').set(
          { [storyData.opening]: true }, { merge: true }
        );
      }
    }
  }

  return { ok: true, sub_id };
}

// ─── 투표 ────────────────────────────────────────────────

async function fbVote(episode_id, sub_ids, voter_id) {
  if (!Array.isArray(sub_ids) || sub_ids.length < 1 || sub_ids.length > 2)
    return { ok: false, error: '1개 또는 2개를 선택해주세요.' };

  const [epSnap, prevVoteSnap, subsSnap] = await Promise.all([
    db.collection('episodes').doc(episode_id).get(),
    db.collection('votes').where('episode_id','==',episode_id).where('voter_id','==',voter_id).get(),
    db.collection('submissions').where('episode_id','==',episode_id).get(),
  ]);

  if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  const ep = epSnap.data();
  if (ep.status !== 'open') return { ok: false, error: '공감이 마감됐습니다.' };

  const isRevote = !prevVoteSnap.empty;
  const prevVotedSubIds = prevVoteSnap.docs.map(d => d.data().sub_id);
  const mySub = subsSnap.docs.find(d => d.data().author_id === voter_id && !d.data().is_ai);
  if (mySub && sub_ids.includes(mySub.id)) return { ok: false, error: '본인 제출에는 공감할 수 없습니다.' };

  const batch = db.batch();

  if (isRevote) {
    prevVoteSnap.docs.forEach(d => batch.delete(d.ref));
    subsSnap.docs.forEach(d => {
      if (prevVotedSubIds.includes(d.id))
        batch.update(d.ref, { vote_count: firebase.firestore.FieldValue.increment(-1) });
    });
  }

  sub_ids.forEach(sid => {
    batch.set(db.collection('votes').doc(fbGenId()), {
      episode_id, sub_id: sid, voter_id, created_at: fbNow()
    });
  });
  subsSnap.docs.forEach(d => {
    if (sub_ids.includes(d.id))
      batch.update(d.ref, { vote_count: firebase.firestore.FieldValue.increment(1) });
  });

  const newTotal = isRevote ? (Number(ep.vote_total) || 0) : (Number(ep.vote_total) || 0) + 1;
  batch.update(epSnap.ref, { vote_total: newTotal });

  // 로컬에서 최고 득표 계산 (Firestore 재조회 불필요)
  const maxSubVotes = subsSnap.docs.reduce((m, d) => {
    let c = Number(d.data().vote_count) || 0;
    if (isRevote && prevVotedSubIds.includes(d.id)) c--;
    if (sub_ids.includes(d.id)) c++;
    return Math.max(m, c);
  }, 0);

  await Promise.all([
    batch.commit(),
    isRevote ? Promise.resolve() : _fbAddPoints(voter_id, 5, 'vote', ''),
  ]);

  if (maxSubVotes >= FB_VOTE_THRESHOLD) {
    // await하지 않음 — 마감 처리(당선작 결정/분기 분리/포인트 지급)는 무겁고
    // 투표 자체의 결과와 무관하므로 백그라운드로 흘려보냄. 투표 집계는 이미
    // 위 batch.commit()으로 커밋 완료된 상태라 응답을 늦출 이유가 없음.
    // fbGetStory의 stuck-episode 복구 경로와 동일한 fire-and-forget 패턴.
    _fbCloseEpisode(episode_id, ep).catch(() => {});
  }

  return { ok: true, total_voters: newTotal, max_votes: maxSubVotes };
}

// ─── 씨앗 문장 ───────────────────────────────────────────

const FB_AI_OPENINGS = [
  "그날 밤, 버스는 끝내 오지 않았다.",
  "편지 봉투 안에는 내 필체로 쓴 글씨가 있었는데, 나는 그 편지를 쓴 기억이 없었다.",
  "할머니는 돌아가시기 전날 밤, 내 이름을 처음으로 틀리게 불렀다.",
  "지도에는 분명히 있는 마을인데, 아무도 그곳에 가본 적이 없다고 했다.",
  "서랍 맨 아래에서 사진 한 장이 나왔다. 내가 태어나기 10년 전 사진인데, 거기에 내가 있었다.",
  "그 개는 주인이 죽은 줄 모르는 게 아니었다. 알면서도 기다리고 있었다.",
  "새벽 3시, 낯선 번호에서 문자가 왔다. '이제 다 끝났어.' 발신자는 나였다.",
  "이사 온 첫날, 벽장 안에서 누군가의 일기장을 발견했다. 마지막 날짜는 오늘이었다.",
  "그 여자는 매일 같은 시각 같은 자리에 앉아 있었다. 죽은 지 3년이 됐는데도.",
  "도서관 반납함에 책 한 권이 꽂혀 있었다. 제목은 '내가 사라지는 방법'이었고, 모든 페이지에 내 이름이 밑줄 쳐져 있었다.",
  "엄마는 항상 '우리 가족은 넷'이라고 했다. 그런데 가족사진에는 언제나 다섯 명이 찍혀 있었다.",
  "그 계단은 올라갈 때는 열두 개인데, 내려올 때는 열세 개다.",
  "전학 온 아이는 우리 반 아이들을 이미 알고 있는 것 같았다. 이름까지.",
  "창문 너머로 손을 흔드는 사람이 있었다. 우리 집은 14층이었다.",
  "아버지의 유품 중에 열쇠가 하나 있었다. 어디에도 맞는 자물쇠가 없었다.",
  "그 섬에는 나이 든 사람이 한 명도 없었다.",
  "카페 단골손님이 어느 날 말했다. '당신, 예전에 나한테 약속한 거 기억해요?' 나는 그 사람을 오늘 처음 봤다.",
  "교통사고로 3일간 의식을 잃었다가 깨어났다. 내 방은 그대로인데, 가족이 모두 낯선 사람이었다.",
  "장마가 끝나고 마당에서 신발 한 짝이 나왔다. 아직 젖어 있었다.",
  "그녀는 내가 꿈에서만 봤던 사람이었다. 근데 그녀도 나를 알고 있었다.",
  "5년 전 헤어진 사람에게서 메시지가 왔다. '지금 네 뒤에 있어.'",
  "쌍둥이 중 한 명이 죽었다. 근데 어느 쪽이 죽었는지 아무도 몰랐다.",
  "시골 폐가에서 온 가족이 같이 밥을 먹고 있는 소리가 났다.",
  "나는 30년째 같은 악몽을 꾼다. 어젯밤 꿈에 처음 보는 아이가 나타나서 말했다. '이제 내 차례야.'",
  "버려진 놀이공원에 불이 켜졌다.",
  "퇴근길에 편의점 삼각김밥을 하나 사줬을 뿐인데, 그 사람은 한참을 울었다.",
  "할머니 핸드폰에 저장된 연락처는 딱 셋이었다. 나, 치킨집, 그리고 모르는 번호.",
  "그 집 대문은 항상 열려 있었다. 누가 들어와도 밥상이 차려져 있었다.",
  "아버지가 처음으로 전화를 먼저 했다. 별 이유가 없다고 했다.",
  "오래된 레시피 노트에 엄마 필체로 '이건 실패'라고 적혀 있었다. 그 페이지가 제일 많이 닳아 있었다.",
  "죽은 줄 알았던 선인장이 꽃을 피웠다. 아무도 손댄 적이 없었는데.",
  "면접관이 내 이력서를 한참 보더니 웃었다.",
  "10년 만에 마주쳤는데, 그 사람은 내 이름을 틀리지 않았다.",
  "우산을 빌려줬다. 돌려받을 생각은 처음부터 없었다.",
  "같은 카페에서 매일 마주쳤는데, 처음 말을 건 건 마지막 날이었다.",
  "헤어지자는 말을 삼킨 게 벌써 세 번째였다.",
  "그 도서관의 책들은 밤에만 결말이 달라진다.",
  "숲 끝에 사는 노인은 사람들이 잊어버린 것들을 팔았다.",
  "그 마을에서는 거짓말을 하면 입에서 꽃이 피었다. 아무도 나쁘게 생각하지 않았다.",
  "그 카페에선 주문하면 당신이 가장 필요한 것이 나왔다. 메뉴판은 없었다.",
  "졸업식에서 아무도 나를 찾지 않았다. 그래서 마지막으로 교실을 한 바퀴 더 걸었다.",
  "스무 살이 되던 날 밤, 달라진 게 없었다.",
  "전화번호는 지웠는데 생일은 아직 기억한다.",
  "이사하는 날, 빈 방이 생각보다 훨씬 좁았다.",
  "버스에서 잠들었는데 종점이었다. 내릴 곳이 맞았다.",

  // 추가 씨앗 문장
  "그 우물에서는 달이 질 줄 몰랐다.",
  "마을 사람들은 매년 같은 날 같은 꿈을 꿨다. 올해 처음으로 꿈이 달랐다.",
  "지하철 막차에는 항상 같은 자리에 같은 사람이 앉아 있었다. 노선도에 없는 역에서 내렸다.",
  "그 방의 시계는 항상 4시 44분을 가리키고 있었다. 건전지는 들어있지 않았다.",
  "학교 옥상에는 아무도 올라가지 않았다. 문이 잠겨 있어서가 아니었다.",
  "우리 동네 지도에는 없는 골목이 있었다. 비 오는 날에만 나타났다.",
  "그 아이는 사진에 찍히지 않았다.",
  "마지막 승객이 내리고 나서야, 기사는 백미러를 올려다봤다.",
  "오래된 거울 속의 나는 항상 0.5초 느리게 움직였다.",
  "그 나무는 누군가 울면 잎이 하나씩 떨어졌다.",
  "실종된 지 7년 만에 돌아온 그는 하나도 늙지 않았다.",
  "그 마을의 개들은 자정이 되면 일제히 같은 방향을 향해 짖었다.",
  "사진관 주인이 말했다. '이 사진, 찍어드리기 전에 이미 현상돼 있었어요.'",
  "아이의 상상 속 친구가 남긴 발자국이 실제로 남아 있었다.",
  "그 집에 이사 온 모든 가족은 반년 안에 떠났다. 이유는 말하지 않았다.",
  "그 라디오는 콘센트를 꽂지 않아도 켜졌다.",
  "경비 아저씨는 20년째 같은 자리를 지키고 있었다. 정년이 열다섯 해 전에 지났는데도.",
  "폐교 교실에서 누군가 수업을 듣고 있었다.",
  "기억을 파는 가게가 골목 끝에 생겼다.",
  "그 해부터 사람들은 꿈을 공유하기 시작했다.",
  "로봇은 폐기 명령을 받은 날 처음으로 거짓말을 했다.",
  "달에 첫 번째로 심은 씨앗이 꽃을 피웠다. 아무도 심은 적이 없는데.",
  "마지막 책방이 문을 닫는 날, 책들이 스스로 줄을 섰다.",
  "그 섬에서는 죽은 사람의 목소리가 파도 소리에 섞여 들렸다.",
  "시간이 거꾸로 흐르기 시작한 건 그 아이가 태어난 날부터였다.",
  "할아버지의 지갑에는 돈이 없었다. 대신 영수증이 가득했다.",
  "병원 복도에서 처음 만난 두 노인이 장기를 두고 있었다. 둘 다 이기고 싶지 않아 보였다.",
  "편의점 알바 마지막 날, 단골 할머니가 케이크를 들고 왔다.",
  "잃어버렸던 지갑이 돌아왔다. 안에 쪽지가 하나 있었다.",
  "아무도 없는 줄 알고 혼자 노래를 불렀는데, 박수 소리가 들렸다.",
  "그 사람은 내가 울었다는 걸 알면서도 모른 척해줬다.",
  "그 분식집 이모는 손님 얼굴을 한 번도 잊지 않았다.",
  "반에서 제일 조용했던 애가 졸업식 날 마이크를 잡았다.",
  "세 번 떨어지고 나서야 원서를 다시 썼다.",
  "좋아한다고 말하려고 했는데, 그 애가 먼저 다른 말을 했다.",
  "취업 합격 문자를 받은 날, 기쁘지가 않았다.",
  "처음 자취방에서 처음 해 먹은 건 라면이었다. 맛없었는데 다 먹었다.",
  "도망치듯 상경했는데, 서울도 딱히 다를 게 없었다.",
  "졌는데 악수를 먼저 내밀었다.",
  "엄마가 남긴 레시피에 재료가 하나 비어 있었다. 평생 그게 뭔지 몰랐다.",
  "친한 척 안 하기로 했는데, 그 애가 먼저 말을 걸어왔다.",
  "졸업하고 처음으로 선생님한테 존댓말을 놨다. 어색했다.",
  "그 골목길 끝에는 항상 불이 켜진 방이 하나 있었다. 건물 자체가 없는 자리인데.",
  "폭설이 내린 아침, 우리 집 앞에만 발자국이 없었다.",
  "그 편의점은 새벽 3시에만 문을 열었다.",
  "나는 그 사람의 장례식에서 처음으로 그 사람의 이름을 알았다.",
  "버려진 수첩에 내일의 날씨가 적혀 있었다. 전부 맞았다.",
  "전쟁이 끝난 마을에 아무도 돌아오지 않았다. 단 한 사람 빼고.",
  "그 악기는 아무도 연주하지 않아도 밤마다 소리가 났다.",
  "20년 만에 고향에 돌아왔는데, 아무것도 변하지 않았다. 사람들도.",

  // 코미디
  "소개팅 상대가 내 전 남자친구의 엄마였다.",
  "면접관이 내 이력서를 보더니 조용히 자기 이력서를 꺼냈다.",
  "다이어트 시작 첫날, 치킨집 사장님한테서 전화가 왔다. '오늘 왜 안 오세요?'",
  "귀신인 줄 알고 소리를 질렀는데, 귀신도 소리를 질렀다.",
  "미용실에서 '알아서 해주세요'라고 했다가 진짜 알아서 해줬다.",
  "자신 있게 '제가 낼게요' 했는데 카드가 긁히지 않았다.",
  "상사한테 보내야 할 카톡을 엄마한테 보냈다.",
  "늦잠 자고 뛰어나왔는데 오늘이 휴일이었다.",
  "화장실에 들어가고 나서야 휴지가 없다는 걸 알았다.",
  "이어폰을 끼고 있었는데 내 노래가 다 들렸던 거였다.",
  "택배가 왔다는 문자를 받았는데, 아직 주문한 게 없었다.",
  "처음 해본 요리를 SNS에 올렸더니 첫 댓글이 '이게 음식이에요?'였다.",
  "거울 앞에서 연습한 말이 실전에서 단 한 마디도 나오지 않았다.",
  "친구한테 비밀을 털어놓았는데, 친구가 이미 다 알고 있었다. 우리 엄마한테서.",
  "알람을 열두 개 맞춰놓고 열두 개를 다 끄고 잠들었다.",
  "운동 유튜브를 틀어놓고 한 시간째 보기만 했다.",
  "첫 월급을 탔는데 통장에서 바로 카드값이 빠져나갔다.",
  "남은 반찬이 아까워서 세 끼를 다 먹었다.",
  "엘리베이터에서 내 이야기를 하는 사람들과 딱 마주쳤다.",
  "줄을 잘못 서서 한 시간을 기다렸는데 다른 줄이었다.",
  "처음 만난 사람이 '저 알아요?' 했다. 나만 기억 못 하는 동창이었다.",
  "퇴직금으로 창업했다. 첫 손님이 배달 기사님이었다.",
  "선물 포장을 완벽하게 했는데 받는 사람이 그냥 찢어버렸다.",
  "엄마한테 거짓말을 했는데 엄마가 이미 다 알고 있었다.",
];

async function _fbRecycleAbandonedSeeds(docs) {
  if (!docs.length) return;
  // 여러 유저(탭)가 거의 동시에 홈 탭을 열면 같은 방치 이야기를 각자 발견해서
  // 중복 처리(알림도 중복 발송)하는 문제가 있었음 — 트랜잭션으로 문서별로
  // "먼저 처리한 쪽"만 실제로 진행하도록 선점
  const claimed = [];
  for (const doc of docs) {
    const won = await db.runTransaction(async tx => {
      const snap = await tx.get(doc.ref);
      if (!snap.exists || snap.data().status !== 'active') return false;
      tx.update(doc.ref, { status: 'inactive' });
      return true;
    });
    if (won) claimed.push(doc);
  }
  if (!claimed.length) return;

  // 폐기된 씨앗 오프닝을 used_openings에서 제거 (다시 씨앗 풀로 복귀)
  const toRestore = claimed.map(doc => doc.data().opening).filter(Boolean);
  if (toRestore.length) {
    const deleteFields = {};
    toRestore.forEach(o => { deleteFields[o] = firebase.firestore.FieldValue.delete(); });
    await db.collection('config').doc('used_openings').update(deleteFields).catch(() => {});
  }
  const nb = db.batch();
  let hasNotif = false;
  claimed.forEach(doc => {
    const s = doc.data();
    if (!s.creator_id) return;
    const snippet = (s.opening || '').length > 30 ? s.opening.substring(0, 30) + '…' : (s.opening || '');
    nb.set(db.collection('notifications').doc(fbGenId()), {
      user_id: s.creator_id, type: 'seed_recycled', story_id: '',
      message: `시간이 경과하여 선택하신 이야기가 다시 되돌아갔습니다.\n"${snippet}"`,
      is_read: false, created_at: fbNow(),
    });
    hasNotif = true;
  });
  if (hasNotif) await nb.commit();
}

async function fbGetSeeds() {
  const usedSnap = await db.collection('config').doc('used_openings').get();
  const usedSet  = usedSnap.exists ? new Set(Object.keys(usedSnap.data())) : new Set();
  const available = FB_AI_OPENINGS.filter(o => !usedSet.has(o));
  const src = available.length >= 5 ? available.slice() : FB_AI_OPENINGS.slice();
  const picked = [];
  while (picked.length < Math.min(5, src.length)) {
    const idx = Math.floor(Math.random() * src.length);
    picked.push(src.splice(idx, 1)[0]);
  }
  return { ok: true, seeds: picked };
}

function fbGetAISuggestion() {
  return { ok: true, opening: FB_AI_OPENINGS[Math.floor(Math.random() * FB_AI_OPENINGS.length)] };
}

// ─── 알림 ────────────────────────────────────────────────

async function _fbCreateNotifications(user_ids, story_id, message) {
  const unique = [...new Set(user_ids)].filter(Boolean);
  if (!unique.length) return;
  const batch = db.batch();
  unique.forEach(uid => {
    batch.set(db.collection('notifications').doc(fbGenId()), {
      user_id: uid, type: 'story_advance', story_id, message, is_read: false, created_at: fbNow()
    });
  });
  await batch.commit();
}

async function fbGetNotifications(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  const snap = await db.collection('notifications')
    .where('user_id', '==', user_id).get();
  const toIso = v => v?.toDate ? v.toDate().toISOString() : (v || '');
  const notifications = snap.docs.map(d => ({ ...d.data(), created_at: toIso(d.data().created_at) }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 30);
  const unread_count  = notifications.filter(n => n.is_read === false || n.is_read === 'false').length;
  return { ok: true, notifications, unread_count };
}

async function fbMarkNotificationsRead(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const snap   = await db.collection('notifications').where('user_id', '==', user_id).get();
  const batch  = db.batch();
  snap.docs.forEach(d => {
    const n = d.data();
    if (n.created_at < cutoff) {
      batch.delete(d.ref);
    } else if (n.is_read === false || n.is_read === 'false') {
      batch.update(d.ref, { is_read: true });
    }
  });
  await batch.commit();
  return { ok: true };
}

// ─── 책갈피 ──────────────────────────────────────────────

async function fbAddBookmark(story_id, user_id) {
  if (!story_id || !user_id) return { ok: false, error: '잘못된 요청입니다.' };
  const dup = await db.collection('bookmarks')
    .where('user_id','==',user_id).where('story_id','==',story_id).limit(1).get();
  if (!dup.empty) return { ok: false, already: true };
  await db.collection('bookmarks').doc(fbGenId()).set({ user_id, story_id, created_at: fbNow() });
  return { ok: true };
}

async function fbRemoveBookmark(story_id, user_id) {
  if (!story_id || !user_id) return { ok: false, error: '잘못된 요청입니다.' };
  const snap = await db.collection('bookmarks')
    .where('user_id','==',user_id).where('story_id','==',story_id).limit(1).get();
  if (snap.empty) return { ok: false, error: '책갈피를 찾을 수 없습니다.' };
  await snap.docs[0].ref.delete();
  return { ok: true };
}

async function fbGetBookmarkIds(user_id) {
  if (!user_id) return { ok: true, ids: [] };
  const snap = await db.collection('bookmarks').where('user_id','==',user_id).get();
  return { ok: true, ids: snap.docs.map(d => d.data().story_id) };
}

async function fbGetBookmarks(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  const snap   = await db.collection('bookmarks').where('user_id','==',user_id).get();
  const ids    = snap.docs.map(d => d.data().story_id).filter(Boolean);
  if (!ids.length) return { ok: true, stories: [] };
  const stSnap = await Promise.all(ids.map(id => db.collection('stories').doc(id).get()));
  const stories = stSnap.filter(d => d.exists && d.data().status !== 'deleted' && d.data().status !== 'inactive').map(d => d.data());
  return { ok: true, stories };
}

// ─── 댓글 ────────────────────────────────────────────────

async function fbAddComment(sub_id, content, author_id) {
  const text = (content || '').trim();
  if (!text) return { ok: false, error: '댓글 내용을 입력해주세요.' };
  if (text.length > 100) return { ok: false, error: '100자 이내로 작성해주세요.' };
  const subSnap = await db.collection('submissions').doc(sub_id).get();
  if (!subSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
  await db.collection('comments').doc(fbGenId()).set({
    sub_id, story_id: subSnap.data().story_id, author_id, content: text, created_at: fbNow()
  });
  return { ok: true };
}

async function fbGetComments(sub_id) {
  const snap = await db.collection('comments').where('sub_id','==',sub_id).get();
  const authorIds = [...new Set(snap.docs.map(d => d.data().author_id).filter(Boolean))];
  const nickMap = {};
  if (authorIds.length > 0) {
    const userDocs = await Promise.all(authorIds.map(id => db.collection('users').doc(id).get()));
    userDocs.forEach(d => { if (d.exists) nickMap[d.id] = d.data().display_name || d.data().nickname; });
  }
  const comments = snap.docs.map(d => ({ comment_id: d.id, ...d.data(), author_nickname: nickMap[d.data().author_id] || '익명' }))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return { ok: true, comments };
}

async function fbDeleteComment(comment_id, user_id) {
  const snap = await db.collection('comments').doc(comment_id).get();
  if (!snap.exists) return { ok: false, error: '댓글을 찾을 수 없습니다.' };
  const data = snap.data();
  if (data.author_id !== user_id && user_id !== FB_ADMIN_ID)
    return { ok: false, error: '삭제 권한이 없습니다.' };
  await db.collection('comments').doc(comment_id).update({ deleted: true });
  return { ok: true };
}

async function fbAddStoryComment(story_id, content, author_id) {
  const text = (content || '').trim();
  if (!text) return { ok: false, error: '댓글 내용을 입력해주세요.' };
  if (text.length > 300) return { ok: false, error: '300자 이내로 작성해주세요.' };
  const stSnap = await db.collection('stories').doc(story_id).get();
  if (!stSnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
  await db.collection('comments').doc(fbGenId()).set({
    sub_id: '', story_id, author_id, content: text, created_at: fbNow()
  });
  return { ok: true };
}

async function fbGetStoryComments(story_id) {
  if (!story_id) return { ok: false, error: '잘못된 요청입니다.' };
  const snap = await db.collection('comments')
    .where('story_id','==',story_id).where('sub_id','==','').get();
  const authorIds = [...new Set(snap.docs.map(d => d.data().author_id).filter(Boolean))];
  const nickMap = {};
  if (authorIds.length > 0) {
    const userDocs = await Promise.all(authorIds.map(id => db.collection('users').doc(id).get()));
    userDocs.forEach(d => { if (d.exists) nickMap[d.id] = d.data().display_name || d.data().nickname; });
  }
  const comments = snap.docs.map(d => ({ comment_id: d.id, ...d.data(), author_nickname: nickMap[d.data().author_id] || '익명' }))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return { ok: true, comments };
}

// ─── 신고 ────────────────────────────────────────────────

async function fbAddReport(sub_id, reason, reporter_id) {
  if (!sub_id || !reason || !reporter_id) return { ok: false, error: '잘못된 요청입니다.' };
  const valid = ['plagiarism','sexual','profanity','spam','other'];
  if (!valid.includes(reason)) return { ok: false, error: '유효하지 않은 신고 사유입니다.' };
  const dup = await db.collection('reports')
    .where('sub_id','==',sub_id).where('reporter_id','==',reporter_id).limit(1).get();
  if (!dup.empty) return { ok: false, error: '이미 신고한 글입니다.' };
  const subSnap = await db.collection('submissions').doc(sub_id).get();
  await db.collection('reports').doc(fbGenId()).set({
    sub_id, story_id: subSnap.exists ? subSnap.data().story_id : '',
    reporter_id, reason, created_at: fbNow()
  });
  return { ok: true };
}

async function fbGetReports(admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const rSnap = await db.collection('reports').orderBy('created_at', 'desc').limit(200).get();
  if (rSnap.empty) return { ok: true, reports: [] };

  const subIds     = [...new Set(rSnap.docs.map(d => d.data().sub_id).filter(Boolean))];
  const reporterIds = [...new Set(rSnap.docs.map(d => d.data().reporter_id).filter(Boolean))];

  const subMap = {}, nickMap = {};
  const subDocs = subIds.length > 0
    ? await Promise.all(subIds.map(id => db.collection('submissions').doc(id).get()))
    : [];
  const authorIds = [];
  subDocs.forEach(d => { if (d.exists) { subMap[d.id] = d.data(); if (d.data().author_id) authorIds.push(d.data().author_id); } });

  const allUserIds = [...new Set([...reporterIds, ...authorIds])];
  if (allUserIds.length > 0) {
    const userDocs = await Promise.all(allUserIds.map(id => db.collection('users').doc(id).get()));
    userDocs.forEach(d => { if (d.exists) nickMap[d.id] = d.data().display_name || d.data().nickname; });
  }

  const label = { plagiarism:'표절', sexual:'성적 묘사', profanity:'욕설·혐오', spam:'스팸', other:'기타' };
  const reports = rSnap.docs.map(d => {
    const r = d.data();
    const s = subMap[r.sub_id] || {};
    return {
      report_id: d.id, sub_id: r.sub_id, story_id: r.story_id,
      reason: label[r.reason] || r.reason,
      reporter_nickname: nickMap[r.reporter_id] || '?',
      sub_content: s.content || '(삭제됨)',
      sub_author:  nickMap[s.author_id] || '?',
      created_at:  r.created_at,
    };
  });
  return { ok: true, reports };
}

async function fbDismissReport(report_id, admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  await db.collection('reports').doc(report_id).delete();
  return { ok: true };
}

async function fbSaveFcmToken(user_id, fcm_token) {
  if (!user_id || !fcm_token) return { ok: false };
  await db.collection('users').doc(user_id).update({ fcm_token });
  return { ok: true };
}

function _kstDate(offsetDays = 0) {
  return new Date(Date.now() + (9 + offsetDays * 24) * 3600 * 1000).toISOString().slice(0, 10);
}

async function fbTrackVisit(is_unique) {
  const today = _kstDate();
  const ref   = db.collection('visits').doc(today);
  const patch = { date: today, raw_count: firebase.firestore.FieldValue.increment(1) };
  if (is_unique) patch.count = firebase.firestore.FieldValue.increment(1);
  await ref.set(patch, { merge: true });
  return { ok: true };
}

async function fbGetAdminStats(admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const today     = _kstDate(0);
  const yesterday = _kstDate(-1);
  const [uSnap, sSnap, subSnap, statsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('stories').get(),
    db.collection('submissions').get(),
    db.collection('config').doc('stats').get(),
  ]);

  const referralMap = {};
  uSnap.docs.forEach(d => {
    const r = (d.data().referral || '').trim() || '미입력';
    referralMap[r] = (referralMap[r] || 0) + 1;
  });
  const referral_stats = Object.entries(referralMap)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));

  let visit_today = 0, access_today = 0, visit_yesterday = 0, visit_total = 0;
  try {
    const [todaySnap, yesSnap, allSnap] = await Promise.all([
      db.collection('visits').doc(today).get(),
      db.collection('visits').doc(yesterday).get(),
      db.collection('visits').get(),
    ]);
    visit_today     = todaySnap.exists ? (todaySnap.data().count     || 0) : 0;
    access_today    = todaySnap.exists ? (todaySnap.data().raw_count || 0) : 0;
    visit_yesterday = yesSnap.exists   ? (yesSnap.data().count       || 0) : 0;
    visit_total     = allSnap.docs
      .filter(d => d.id !== '_total')
      .reduce((sum, d) => sum + (d.data().count || 0), 0);
  } catch(e) { /* visits read 실패 시 0 유지 */ }
  return {
    ok: true,
    user_count: uSnap.size, story_count: sSnap.size, submission_count: subSnap.size,
    deleted_count: statsSnap.exists ? (statsSnap.data().deleted_count || 0) : 0,
    visit_today, access_today, visit_yesterday, visit_total, referral_stats,
  };
}

// ─── 랭킹 ────────────────────────────────────────────────

async function fbGetLeaderboard() {
  const [ptsSnap, adpSnap] = await Promise.all([
    db.collection('users').orderBy('total_points', 'desc').limit(11).get(),
    db.collection('users').orderBy('adoption_count', 'desc').limit(11).get(),
  ]);

  const pointsRank = ptsSnap.docs
    .filter(d => Number(d.data().total_points) > 0 && d.id !== FB_ADMIN_ID && d.id !== FB_AI_ID)
    .slice(0, 10)
    .map(d => ({ user_id: d.id, nickname: d.data().display_name || d.data().nickname, badge: d.data().badge, value: Number(d.data().total_points) }));

  const adoptionsRank = adpSnap.docs
    .filter(d => d.id !== FB_ADMIN_ID && d.id !== FB_AI_ID && (d.data().adoption_count || 0) > 0)
    .slice(0, 10)
    .map(d => ({ user_id: d.id, nickname: d.data().display_name || d.data().nickname, badge: d.data().badge, value: d.data().adoption_count || 0 }));

  return { ok: true, points: pointsRank, adoptions: adoptionsRank };
}

async function fbBackfillLikeCounts(admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const likesSnap = await db.collection('story_likes').get();
  const countMap = {};
  likesSnap.docs.forEach(d => {
    const sid = d.data().story_id;
    if (sid) countMap[sid] = (countMap[sid] || 0) + 1;
  });
  const batch = db.batch();
  Object.entries(countMap).forEach(([sid, cnt]) => {
    batch.update(db.collection('stories').doc(sid), { like_count: cnt });
  });
  await batch.commit();
  return { ok: true, updated: Object.keys(countMap).length };
}

async function fbBackfillAdoptionCounts(admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const sSnap = await db.collection('submissions').where('is_adopted', '==', true).get();
  const countMap = {};
  sSnap.docs.forEach(d => {
    const uid = d.data().author_id;
    if (uid && uid !== FB_ADMIN_ID && uid !== FB_AI_ID) countMap[uid] = (countMap[uid] || 0) + 1;
  });
  const batch = db.batch();
  Object.entries(countMap).forEach(([uid, cnt]) => {
    batch.update(db.collection('users').doc(uid), { adoption_count: cnt });
  });
  await batch.commit();
  return { ok: true, updated: Object.keys(countMap).length };
}

// ─── MVP ────────────────────────────────────────────────

async function fbVoteMvp(story_id, episode_id, voter_id) {
  if (!voter_id) return { ok: false, error: '로그인이 필요합니다.' };
  if (!episode_id) return { ok: false, error: '잘못된 요청입니다.' };

  const stSnap = await db.collection('stories').doc(story_id).get();
  if (!stSnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
  const st = stSnap.data();
  if (st.status !== 'completed' && st.status !== 'inactive')
    return { ok: false, error: '완결된 이야기에서만 가능합니다.' };

  const dup = await db.collection('story_mvp')
    .where('story_id','==',story_id).where('voter_id','==',voter_id).limit(1).get();
  if (!dup.empty) return { ok: false, error: '이미 공감하셨습니다.' };

  const subSnap = await db.collection('submissions')
    .where('episode_id','==',episode_id).where('is_adopted','==',true).limit(1).get();
  if (subSnap.empty) return { ok: false, error: '채택된 문장을 찾을 수 없습니다.' };
  const sub = subSnap.docs[0].data();
  if (sub.author_id === voter_id) return { ok: false, error: '본인 글에는 공감할 수 없습니다.' };
  if (!sub.author_id || sub.author_id === 'SYSTEM') return { ok: false, error: '공감할 수 없는 글입니다.' };

  const mvpId = fbGenId();
  await db.collection('story_mvp').doc(mvpId).set({
    story_id, voter_id, nominated_user_id: sub.author_id, episode_id, created_at: fbNow()
  });
  // 포인트 지급은 클라이언트가 남의 계정에 직접 쓰지 않도록 서버(Cloud Function)로 이전됨
  await functionsRegion.httpsCallable('grantMvpPoints')({ mvp_id: mvpId }).catch(() => {});
  const stSnap2 = await db.collection('stories').doc(story_id).get();
  const snippet = ((stSnap2.exists ? stSnap2.data().opening : '') || '').slice(0, 20);
  await _fbCreateNotifications([sub.author_id], story_id, `"${snippet}…" 이야기에서 내 글이 으뜸 글로 선정됐어요! +10P`);
  return { ok: true };
}

async function fbGetMvpVotes(story_id, voter_id) {
  const snap = await db.collection('story_mvp').where('story_id','==',story_id).get();
  const has_voted = voter_id ? snap.docs.some(d => d.data().voter_id === voter_id) : false;
  const countMap  = {};
  snap.docs.forEach(d => {
    const uid = d.data().nominated_user_id;
    countMap[uid] = (countMap[uid] || 0) + 1;
  });
  const nickMap = {}, badgeMap = {};
  const uids = Object.keys(countMap).filter(Boolean);
  if (uids.length > 0) {
    const userDocs = await Promise.all(uids.map(id => db.collection('users').doc(id).get()));
    userDocs.forEach(d => { if (d.exists) { nickMap[d.id] = d.data().display_name || d.data().nickname; badgeMap[d.id] = d.data().badge; } });
  }
  const votes = Object.entries(countMap)
    .sort(([,a],[,b]) => b - a)
    .map(([uid, count]) => ({ user_id: uid, nickname: nickMap[uid] || '?', badge: badgeMap[uid] || 'seed', count }));
  return { ok: true, votes, has_voted, total_voters: new Set(snap.docs.map(d => d.data().voter_id)).size };
}

// ─── 분기 챌린지 ─────────────────────────────────────────

async function fbCreateBranch(story_id, branch_from_step, user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  const step = Number(branch_from_step);
  if (step < 2) return { ok: false, error: '1단계는 분기할 수 없습니다.' };

  const stSnap = await db.collection('stories').doc(story_id).get();
  if (!stSnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
  const st = stSnap.data();
  if (st.status !== 'completed' && st.status !== 'inactive')
    return { ok: false, error: '완결된 이야기에서만 분기를 만들 수 있습니다.' };

  const existSnap = await db.collection('stories').where('parent_story_id','==',story_id).get();
  if (existSnap.docs.some(d => Number(d.data().branch_from_step) === step))
    return { ok: false, error: '이 단계에는 이미 분기가 있습니다.' };

  const spendRes = await _fbSpendPoints(user_id, 30, 'branch_create');
  if (!spendRes.ok) return spendRes;

  const epsSnap = await db.collection('episodes').where('story_id','==',story_id).get();
  const targetEp = epsSnap.docs.map(d => ({ episode_id: d.id, ...d.data() }))
    .find(e => Number(e.step) === step - 1);
  if (!targetEp) return { ok: false, error: '해당 단계를 찾을 수 없습니다.' };

  const subsSnap = await db.collection('submissions').where('episode_id','==',targetEp.episode_id).get();
  const nonAdopted = subsSnap.docs.map(d => d.data())
    .filter(s => s.is_adopted !== true && s.is_adopted !== 'TRUE');

  const new_story_id = fbGenId();
  const new_ep_id    = fbGenId();
  const batch = db.batch();

  // 카드/산문뷰 단계 표시용: 원본 스토리 기준 진짜 이어지는 단계 번호를 정확히 계산
  const leafDisplayStep = _calcDisplayStepBackend(st, Number(targetEp.step));
  const branch_display_offset = leafDisplayStep - (step - 1) + 1;

  batch.set(db.collection('stories').doc(new_story_id), {
    story_id: new_story_id, parent_story_id: story_id, branch_from_step: step,
    branch_episode_id: targetEp.episode_id,
    branch_leaf_episode_id: targetEp.episode_id,
    branch_display_offset,
    opening: st.opening, max_steps: st.max_steps || 10,
    current_step: step - 2, status: 'active', creator_id: user_id,
    created_at: fbNow(), participant_count: 0, batch: '',
  });
  batch.set(db.collection('episodes').doc(new_ep_id), {
    episode_id: new_ep_id, story_id: new_story_id, step: step - 1,
    status: 'open', vote_total: 0, created_at: fbNow(),
    closed_at: '', pending_at: '', parent_sub_id: '',
  });
  nonAdopted.forEach(sub => {
    const sid = fbGenId();
    batch.set(db.collection('submissions').doc(sid), {
      ...sub, sub_id: sid, episode_id: new_ep_id, story_id: new_story_id,
      vote_count: 0, is_adopted: false, derived_from: '',
    });
  });
  await batch.commit();

  const votersSnap = await db.collection('votes').where('episode_id','==',targetEp.episode_id).get();
  const notifyIds = [...new Set([
    ...nonAdopted.map(s => s.author_id),
    ...votersSnap.docs.map(d => d.data().voter_id),
  ])].filter(id => id && id !== user_id);
  const snippet = st.opening.slice(0, 15);
  await _fbCreateNotifications(notifyIds, new_story_id,
    `"${snippet}..." 이야기의 ${step}단계에서 분기 챌린지가 시작됐어요!`);

  return { ok: true, new_story_id };
}

async function fbExtendStory(story_id, user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };

  const stSnap = await db.collection('stories').doc(story_id).get();
  if (!stSnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
  const st = stSnap.data();
  if (st.status !== 'completed') return { ok: false, error: '완결된 이야기에서만 연장할 수 있습니다.' };

  // 이미 연장본이 있으면 해당 id 반환
  const existSnap = await db.collection('stories').where('parent_story_id','==',story_id).where('is_continuation','==',true).get();
  if (!existSnap.empty) {
    const existing_id = existSnap.docs[0].data().story_id || existSnap.docs[0].id;
    return { ok: false, error: '이미 연장된 이야기가 있습니다.', existing_id };
  }

  const spendRes = await _fbSpendPoints(user_id, 30, 'extend_story');
  if (!spendRes.ok) return spendRes;

  const uSnap = await db.collection('users').doc(user_id).get();
  const uData = uSnap.exists ? uSnap.data() : {};

  const parentStep = Number(st.current_step) || 0;
  const new_story_id = fbGenId();
  const new_ep_id    = fbGenId();
  const batch = db.batch();

  batch.set(db.collection('stories').doc(new_story_id), {
    story_id: new_story_id,
    parent_story_id: story_id,
    is_continuation: true,
    branch_from_step: parentStep + 1, // calcDisplayStep 단계 표시용
    opening: st.opening,
    max_steps: 10,
    current_step: 0,
    status: 'active',
    creator_id: user_id,
    creator_nickname: uData.display_name || uData.nickname || '익명',
    creator_badge: uData.badge || 'seed',
    created_at: fbNow(),
    participant_count: 0, like_count: 0, adoption_count: 0,
    has_branch: false, batch: '',
  });
  batch.set(db.collection('episodes').doc(new_ep_id), {
    episode_id: new_ep_id, story_id: new_story_id,
    step: 1, status: 'open', vote_total: 0,
    created_at: fbNow(), closed_at: '', pending_at: '', parent_sub_id: '',
  });
  await batch.commit();

  // 원본 참여자 알림
  const subsSnap = await db.collection('submissions').where('story_id','==',story_id).get();
  const notifyIds = [...new Set(
    subsSnap.docs.map(d => d.data().author_id).filter(id => id && id !== user_id && id !== FB_ADMIN_ID && id !== FB_AI_ID)
  )];
  const snippet = (st.opening || '').slice(0, 15);
  if (notifyIds.length) {
    await _fbCreateNotifications(notifyIds, new_story_id, `"${snippet}..." 이야기가 연장됐어요! 이어서 써봐요.`);
  }

  return { ok: true, new_story_id };
}

// ─── 부스트 / 추가제출 / 추천 ─────────────────────────────

async function fbBoostStory(story_id, user_id) {
  const stSnap = await db.collection('stories').doc(story_id).get();
  if (!stSnap.exists || stSnap.data().status !== 'active')
    return { ok: false, error: '진행 중인 이야기만 주목할 수 있습니다.' };
  const boostSnap = await db.collection('boosts').where('story_id','==',story_id).get();
  const isActive = boostSnap.docs.some(d => d.data().expires_at > fbNow());
  if (isActive) return { ok: false, error: '이미 주목받고 있는 이야기입니다.' };
  const spend = await _fbSpendPoints(user_id, 30, 'boost_story');
  if (!spend.ok) return spend;
  await db.collection('boosts').doc(fbGenId()).set({
    story_id, user_id, created_at: fbNow(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });
  return { ok: true };
}

async function fbBuyExtraSubmit(episode_id, user_id) {
  const epSnap = await db.collection('episodes').doc(episode_id).get();
  if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  if (epSnap.data().status !== 'open') return { ok: false, error: '제출이 마감됐습니다.' };
  const hasSub = await db.collection('submissions')
    .where('episode_id','==',episode_id).where('author_id','==',user_id).limit(1).get();
  if (hasSub.empty) return { ok: false, error: '먼저 기본 제출을 해주세요.' };
  const dup = await db.collection('extra_submits')
    .where('episode_id','==',episode_id).where('user_id','==',user_id).limit(1).get();
  if (!dup.empty) return { ok: false, error: '이미 추가 제출권을 사용하셨습니다.' };
  const spend = await _fbSpendPoints(user_id, 20, 'extra_submit');
  if (!spend.ok) return spend;
  await db.collection('extra_submits').doc(fbGenId()).set({ episode_id, user_id, created_at: fbNow() });
  return { ok: true };
}

async function fbToggleStoryLike(story_id, user_id) {
  const stRef  = db.collection('stories').doc(story_id);
  const stSnap = await stRef.get();
  if (!stSnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
  const st = stSnap.data();
  if (st.status !== 'completed' && st.status !== 'inactive')
    return { ok: false, error: '완결된 이야기에만 추천할 수 있습니다.' };
  const snap   = await db.collection('story_likes').where('story_id','==',story_id).where('user_id','==',user_id).limit(1).get();
  const cur    = st.like_count || 0;
  if (!snap.empty) {
    await snap.docs[0].ref.delete();
    const newCount = Math.max(0, cur - 1);
    await stRef.update({ like_count: newCount });
    return { ok: true, liked: false, like_count: newCount };
  } else {
    await db.collection('story_likes').doc(fbGenId()).set({ story_id, user_id, created_at: fbNow() });
    const newCount = cur + 1;
    await stRef.update({ like_count: newCount });
    return { ok: true, liked: true, like_count: newCount };
  }
}

// ─── 프로필 ──────────────────────────────────────────────

async function fbGetProfile(user_id) {
  const uSnap = await db.collection('users').doc(user_id).get();
  if (!uSnap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
  const u = uSnap.data();

  const _toChunks = arr => { const c = []; for (let i = 0; i < arr.length; i += 30) c.push(arr.slice(i, i+30)); return c; };

  const [histSnap, writingsSnap] = await Promise.all([
    db.collection('point_ledger').where('user_id','==',user_id).orderBy('created_at','desc').limit(20).get(),
    // limit 낮으면 AI가 관리자 계정으로 쓴 글이 최근순 상위를 채워서 실제 글이 밀려날 수 있음(is_ai 필터는 아래에서 적용)
    db.collection('submissions').where('author_id','==',user_id).orderBy('created_at','desc').limit(300).get(),
  ]);

  // 제출글에서 실제 참조하는 ID만 배치 조회
  const epMap = {}, storyMap = {};
  const allEpIds    = [...new Set(writingsSnap.docs.map(d => d.data().episode_id).filter(Boolean))];
  const allStoryIds = [...new Set(writingsSnap.docs.map(d => d.data().story_id).filter(Boolean))];
  await Promise.all([
    ..._toChunks(allEpIds).map(ch =>
      db.collection('episodes').where(firebase.firestore.FieldPath.documentId(), 'in', ch).get()
        .then(s => s.docs.forEach(d => { epMap[d.id] = d.data(); }))
    ),
    ..._toChunks(allStoryIds).map(ch =>
      db.collection('stories').where(firebase.firestore.FieldPath.documentId(), 'in', ch).get()
        .then(s => s.docs.forEach(d => { storyMap[d.id] = d.data().opening; }))
    ),
  ]);

  const history = histSnap.docs.map(d => d.data())
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20);

  const subIds = [...new Set(history.map(h => h.sub_id).filter(Boolean))];
  const subStoryMap = {};
  if (subIds.length) {
    await Promise.all(_toChunks(subIds).map(async ch => {
      const snap = await db.collection('submissions')
        .where(firebase.firestore.FieldPath.documentId(), 'in', ch).get();
      snap.docs.forEach(d => { subStoryMap[d.id] = d.data().story_id; });
    }));
  }
  history.forEach(h => { if (h.sub_id && subStoryMap[h.sub_id]) h.story_id = subStoryMap[h.sub_id]; });

  const writings = writingsSnap.docs.filter(d => !d.data().is_ai).map(d => {
    const s = d.data();
    const ep = epMap[s.episode_id];
    return {
      sub_id: s.sub_id || d.id,
      content: s.content,
      vote_count: s.vote_count || 0,
      is_adopted: s.is_adopted === true || s.is_adopted === 'TRUE',
      ep_status: ep ? ep.status : null,
      story_id: s.story_id,
      story_opening: storyMap[s.story_id] || '',
      step: ep ? Number(ep.step) : 0,
      created_at: s.created_at,
    };
  }).sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 50);

  return {
    ok: true,
    user: { user_id, nickname: u.nickname, display_name: u.display_name || u.nickname, total_points: u.total_points || 0, badge: u.badge || 'seed', avatar: u.avatar || null, owned_avatars: u.owned_avatars || [], created_at: u.created_at },
    history, writings,
  };
}

async function fbGetPublicProfile(user_id) {
  const uSnap = await db.collection('users').doc(user_id).get();
  if (!uSnap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
  const u = uSnap.data();

  const _toChunks = arr => { const c = []; for (let i = 0; i < arr.length; i += 30) c.push(arr.slice(i, i+30)); return c; };

  // limit 낮으면 AI가 관리자 계정으로 쓴 글이 최근순 상위를 채워서 실제 글이 밀려날 수 있음(is_ai 필터는 아래에서 적용)
  const writingsSnap = await db.collection('submissions').where('author_id','==',user_id).orderBy('created_at','desc').limit(300).get();

  const epMap = {}, storyMap = {};
  const allEpIds    = [...new Set(writingsSnap.docs.map(d => d.data().episode_id).filter(Boolean))];
  const allStoryIds = [...new Set(writingsSnap.docs.map(d => d.data().story_id).filter(Boolean))];
  await Promise.all([
    ..._toChunks(allEpIds).map(ch =>
      db.collection('episodes').where(firebase.firestore.FieldPath.documentId(), 'in', ch).get()
        .then(s => s.docs.forEach(d => { epMap[d.id] = d.data(); }))
    ),
    ..._toChunks(allStoryIds).map(ch =>
      db.collection('stories').where(firebase.firestore.FieldPath.documentId(), 'in', ch).get()
        .then(s => s.docs.forEach(d => { storyMap[d.id] = d.data().opening; }))
    ),
  ]);

  const writings = writingsSnap.docs.filter(d => !d.data().is_ai).map(d => {
    const s = d.data();
    const ep = epMap[s.episode_id];
    return {
      sub_id: s.sub_id || d.id,
      content: s.content,
      vote_count: s.vote_count || 0,
      is_adopted: s.is_adopted === true || s.is_adopted === 'TRUE',
      ep_status: ep ? ep.status : null,
      story_id: s.story_id,
      story_opening: storyMap[s.story_id] || '',
      step: ep ? Number(ep.step) : 0,
      created_at: s.created_at,
    };
  }).sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 50);

  return {
    ok: true,
    user: {
      user_id,
      display_name: u.display_name || u.nickname,
      total_points: u.total_points || 0,
      badge: u.badge || 'seed',
      avatar: u.avatar || null,
      created_at: u.created_at || null,
    },
    writings,
  };
}

async function fbBuyAvatar(emoji_id, user_id) {
  const item = FB_AVATAR_SHOP.find(x => x.id === emoji_id);
  if (!item) return { ok: false, error: '존재하지 않는 아이템입니다.' };
  const uRef = db.collection('users').doc(user_id);
  const ledgerRef = db.collection('point_ledger').doc();
  try {
    return await db.runTransaction(async tx => {
      const uSnap = await tx.get(uRef);
      const u = uSnap.data();
      if ((u.owned_avatars || []).includes(emoji_id)) return { ok: false, error: '이미 보유한 아이템입니다.' };
      const newPts = (u.total_points || 0) - item.price;
      if (newPts < 0) return { ok: false, error: '포인트가 부족합니다.' };
      const newOwned = [...(u.owned_avatars || []), emoji_id];
      tx.update(uRef, { total_points: newPts, owned_avatars: newOwned, badge: fbCalcBadge(newPts) });
      tx.set(ledgerRef, { user_id, points: -item.price, reason: 'buy_avatar', created_at: fbNow() });
      return { ok: true, owned_avatars: newOwned, total_points: newPts, badge: fbCalcBadge(newPts) };
    });
  } catch(e) {
    return { ok: false, error: '구매에 실패했습니다. 다시 시도해주세요.' };
  }
}

async function fbSetAvatar(emoji_id, user_id) {
  const val = emoji_id || null;
  const uRef = db.collection('users').doc(user_id);
  if (val) {
    const uSnap = await uRef.get();
    if (!(uSnap.data().owned_avatars || []).includes(val)) return { ok: false, error: '보유하지 않은 아이템입니다.' };
  }
  await uRef.update({ avatar: val });
  return { ok: true, avatar: val };
}

async function fbCheckDisplayName(display_name) {
  const dn = (display_name || '').trim();
  if (!dn) return { ok: true, available: false };
  const snap = await db.collection('users').where('display_name', '==', dn).limit(1).get();
  return { ok: true, available: snap.empty };
}

async function fbChangeDisplayName(user_id, new_display_name) {
  const dn = (new_display_name || '').trim();
  if (!dn || dn.length < 2) return { ok: false, error: '닉네임은 2자 이상이어야 합니다.' };
  if (!/^[가-힣a-zA-Z0-9 ._-]{2,12}$/.test(dn)) return { ok: false, error: '닉네임은 2~12자, 한글·영문·숫자·공백·._- 만 사용할 수 있어요.' };

  const check = await db.collection('users').where('display_name', '==', dn).limit(1).get();
  if (!check.empty) return { ok: false, error: '이미 사용 중인 닉네임입니다.' };

  const uSnap = await db.collection('users').doc(user_id).get();
  if (!uSnap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
  const u = uSnap.data();
  if ((u.total_points || 0) < 20) return { ok: false, error: '포인트가 부족합니다. 닉네임 변경에는 20p가 필요해요.' };

  const old_name = u.display_name || u.nickname;
  await db.collection('users').doc(user_id).update({
    display_name: dn,
    name_history: firebase.firestore.FieldValue.arrayUnion({ name: old_name, changed_at: fbNow() }),
  });

  const spendRes = await _fbSpendPoints(user_id, 20, 'nickname_change');
  if (!spendRes.ok) return spendRes;

  // 과거 제출 문장 닉네임 일괄 업데이트
  const subsSnap = await db.collection('submissions').where('author_id', '==', user_id).get();
  for (let i = 0; i < subsSnap.docs.length; i += 400) {
    const batch = db.batch();
    subsSnap.docs.slice(i, i + 400).forEach(doc => batch.update(doc.ref, { author_nickname: dn }));
    await batch.commit();
  }

  return { ok: true, display_name: dn };
}

async function fbDeleteMySubmission(sub_id, user_id) {
  const subSnap = await db.collection('submissions').doc(sub_id).get();
  if (!subSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
  const sub = subSnap.data();
  if (sub.author_id !== user_id) return { ok: false, error: '권한이 없습니다.' };
  if ((Number(sub.vote_count) || 0) > 0) return { ok: false, error: '공감을 받은 글은 삭제할 수 없습니다.' };
  if (sub.is_adopted === true || sub.is_adopted === 'TRUE') return { ok: false, error: '채택된 글은 삭제할 수 없습니다.' };
  const spend = await _fbSpendPoints(user_id, 10, 'delete_submission');
  if (!spend.ok) return spend;
  await db.collection('submissions').doc(sub_id).delete();
  const cSnap = await db.collection('comments').where('sub_id', '==', sub_id).get();
  if (!cSnap.empty) {
    const batch = db.batch();
    cSnap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  return { ok: true };
}

// ─── 어드민 ──────────────────────────────────────────────

async function fbAdminForceAdopt(sub_id, admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const subSnap = await db.collection('submissions').doc(sub_id).get();
  if (!subSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
  const sub    = subSnap.data();
  const epSnap = await db.collection('episodes').doc(sub.episode_id).get();
  if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  if (epSnap.data().status !== 'open') return { ok: false, error: '이미 마감된 에피소드입니다.' };
  await subSnap.ref.update({ vote_count: 9999 });
  await _fbCloseEpisode(sub.episode_id, { episode_id: sub.episode_id, ...epSnap.data() });
  return { ok: true };
}

async function fbAdminDeleteSubmission(sub_id, admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  await db.collection('submissions').doc(sub_id).delete();
  const [vSnap, cSnap, rSnap] = await Promise.all([
    db.collection('votes').where('sub_id','==',sub_id).get(),
    db.collection('comments').where('sub_id','==',sub_id).get(),
    db.collection('reports').where('sub_id','==',sub_id).get(),
  ]);
  const batch = db.batch();
  [...vSnap.docs, ...cSnap.docs, ...rSnap.docs].forEach(d => batch.delete(d.ref));
  await batch.commit();
  return { ok: true };
}

async function fbAdminFixParticipantCount(story_id, admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const subsSnap = await db.collection('submissions').where('story_id','==',story_id).get();
  const uniqueAuthors = new Set(subsSnap.docs.filter(d => !d.data().is_ai).map(d => d.data().author_id).filter(Boolean));
  const count = uniqueAuthors.size;
  await db.collection('stories').doc(story_id).update({ participant_count: count });
  return { ok: true, participant_count: count, submissions: subsSnap.size };
}

async function fbAdminCloseStory(story_id, admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const stSnap = await db.collection('stories').doc(story_id).get();
  await db.collection('stories').doc(story_id).update({ status: 'inactive' });
  if (stSnap.exists) {
    const d = stSnap.data();
    if (d.is_ai_seed && d.opening) {
      await db.collection('config').doc('used_openings').set(
        { [d.opening]: true }, { merge: true }
      );
    }
  }
  return { ok: true };
}

async function fbGetAIActivities(admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const [configSnap, keyStatus] = await Promise.all([
    db.collection('config').doc('ai_config').get(),
    functionsRegion.httpsCallable('getClaudeKeyStatus')({ admin_id }).then(r => r.data).catch(() => ({ has_key: false })),
  ]);
  const aiConfig = configSnap.exists ? configSnap.data() : { enabled: false, speed_pct: 100 };
  const hasKey = !!keyStatus.has_key;
  let subsSnap, votesSnap;
  try {
    [subsSnap, votesSnap] = await Promise.all([
      db.collection('submissions').where('author_id', '==', FB_AI_ID).where('is_ai', '==', true).orderBy('created_at', 'desc').limit(300).get(),
      db.collection('votes').where('voter_id', '==', FB_AI_ID).where('is_ai', '==', true).orderBy('created_at', 'desc').limit(300).get(),
    ]);
  } catch(e) {
    return { ok: true, ai_config: aiConfig, has_key: hasKey, submissions: [], votes: [], total_subs: 0, total_votes: 0 };
  }
  const subs = subsSnap.docs.map(d => d.data())
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 200);
  const votes = votesSnap.docs.map(d => d.data())
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 100);

  const subStoryIds = [...new Set(subs.map(s => s.story_id).filter(Boolean))];
  const voteEpIds   = [...new Set(votes.map(v => v.episode_id).filter(Boolean))];
  const voteSubIds  = [...new Set(votes.map(v => v.sub_id).filter(Boolean))];

  const storyMap = {}, epToStoryMap = {}, voteSubMap = {};
  await Promise.all([
    ...subStoryIds.map(id => db.collection('stories').doc(id).get().then(d => { if (d.exists) storyMap[d.id] = d.data().opening || ''; })),
    ...voteEpIds.map(id => db.collection('episodes').doc(id).get().then(d => { if (d.exists) epToStoryMap[d.id] = d.data().story_id || ''; })),
    ...voteSubIds.map(id => db.collection('submissions').doc(id).get().then(d => { if (d.exists) voteSubMap[d.id] = d.data().content || ''; })),
  ]);
  const voteStoryIds = [...new Set(Object.values(epToStoryMap).filter(id => id && !storyMap[id]))];
  if (voteStoryIds.length) {
    await Promise.all(voteStoryIds.map(id => db.collection('stories').doc(id).get().then(d => { if (d.exists) storyMap[d.id] = d.data().opening || ''; })));
  }
  return {
    ok: true, ai_config: aiConfig, has_key: hasKey,
    submissions: subs.map(s => ({ ...s, story_opening: storyMap[s.story_id] || '' })),
    votes: votes.map(v => {
      const story_id = epToStoryMap[v.episode_id] || '';
      return { ...v, story_id, story_opening: storyMap[story_id] || '', sub_content: voteSubMap[v.sub_id] || '' };
    }),
    total_subs: subsSnap.size, total_votes: votesSnap.size,
  };
}

async function fbSetClaudeKey(admin_id, key) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  if (!key || key.length < 20) return { ok: false, error: '유효한 Claude API 키를 입력해주세요.' };
  try {
    await functionsRegion.httpsCallable('setClaudeKey')({ admin_id, key });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || '저장에 실패했습니다.' };
  }
}

async function fbGetBugReports(user_id) {
  const uSnap = await db.collection('users').doc(user_id).get();
  if (!uSnap.exists || uSnap.data().badge !== 'treeguard') return { ok: false, error: '권한이 없습니다.' };
  const snap = await db.collection('bug_reports').orderBy('created_at', 'desc').limit(50).get();
  const reporterIds = [...new Set(snap.docs.map(d => d.data().user_id).filter(Boolean))];
  const nickMap = {};
  if (reporterIds.length > 0) {
    const userDocs = await Promise.all(reporterIds.map(id => db.collection('users').doc(id).get()));
    userDocs.forEach(d => { if (d.exists) nickMap[d.id] = d.data().display_name || d.data().nickname; });
  }
  const reports = snap.docs.map(d => ({ id: d.id, ...d.data(), reporter_nickname: nickMap[d.data().user_id] || '알 수 없음' }));
  return { ok: true, reports };
}

async function fbResolveBugReport(report_id, user_id, comment) {
  const uSnap = await db.collection('users').doc(user_id).get();
  if (!uSnap.exists || uSnap.data().badge !== 'treeguard') return { ok: false, error: '권한이 없습니다.' };
  const rSnap = await db.collection('bug_reports').doc(report_id).get();
  if (!rSnap.exists) return { ok: false, error: '존재하지 않는 제보입니다.' };
  await rSnap.ref.update({ status: 'resolved' });
  const reporter_id = rSnap.data().user_id;
  if (reporter_id) {
    const base = '제보해주신 버그가 해결됐어요! 소중한 제보 감사합니다 🌱';
    const message = comment ? `${base}\n"${comment}"` : base;
    await db.collection('notifications').doc(fbGenId()).set({
      user_id: reporter_id, type: 'bug_resolved', story_id: '',
      message, is_read: false, created_at: fbNow(),
    });
  }
  return { ok: true };
}

async function fbSubmitBugReport(content, user_id) {
  if (!content || content.trim().length < 5) return { ok: false, error: '내용을 5자 이상 입력해주세요.' };
  await db.collection('bug_reports').add({ user_id, content: content.trim(), created_at: fbNow(), status: 'open' });
  await _fbAddPoints(user_id, 10, 'bug_report', '');
  await db.collection('notifications').doc(fbGenId()).set({
    user_id: FB_ADMIN_ID, type: 'bug_report', story_id: '',
    message: '새 버그 제보가 접수됐어요 🐛',
    link: 'https://hwasee.me/bang/#admin-bugs',
    is_read: false, created_at: fbNow(),
  });
  return { ok: true };
}

// ─── 패치 내역 ───────────────────────────────────────────

async function fbAddPatchNote(admin_id, content) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  if (!content || !content.trim()) return { ok: false, error: '내용을 입력해주세요.' };
  const patch_id = fbGenId();
  await db.collection('patch_notes').doc(patch_id).set({
    patch_id, content: content.trim(), admin_id, created_at: fbNow(),
  });
  return { ok: true, patch_id };
}

async function fbGetPatchNotes(admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const snap = await db.collection('patch_notes').orderBy('created_at', 'desc').limit(100).get();
  return { ok: true, notes: snap.docs.map(d => d.data()) };
}

async function fbGetPatchNotesFeed() {
  const snap = await db.collection('patch_notes').orderBy('created_at', 'desc').limit(50).get();
  return { ok: true, notes: snap.docs.map(d => d.data()) };
}

async function fbGetUnseenPatchNote(user_id) {
  const [uSnap, snap] = await Promise.all([
    db.collection('users').doc(user_id).get(),
    db.collection('patch_notes').orderBy('created_at', 'desc').limit(1).get(),
  ]);
  if (snap.empty) return { ok: true, unseen: false };
  const latest = snap.docs[0].data();
  const lastSeen = uSnap.exists ? uSnap.data().last_seen_patch_id : null;
  if (latest.patch_id === lastSeen) return { ok: true, unseen: false };
  return { ok: true, unseen: true, patch: latest };
}

async function fbMarkPatchNoteSeen(user_id, patch_id) {
  await db.collection('users').doc(user_id).update({ last_seen_patch_id: patch_id });
  return { ok: true };
}

// ─── 관리자 글 수정 ──────────────────────────────────────

async function fbAdminEditSub(admin_id, sub_id, new_content, old_content, story_id, edit_type) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  if (!new_content?.trim()) return { ok: false, error: '내용을 입력해주세요.' };
  await db.collection('submissions').doc(sub_id).update({ content: new_content.trim() });
  await db.collection('admin_edits').add({
    sub_id, story_id: story_id || '', old_content: old_content || '',
    new_content: new_content.trim(), edit_type: edit_type || 'manual',
    admin_id, edited_at: fbNow(),
  });
  return { ok: true };
}

async function fbGetAdminEdits(admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const snap = await db.collection('admin_edits').orderBy('edited_at', 'desc').limit(200).get();
  if (snap.empty) return { ok: true, edits: [] };
  const storyIds = [...new Set(snap.docs.map(d => d.data().story_id).filter(Boolean))];
  const storyMap = {};
  if (storyIds.length) {
    const sDocs = await Promise.all(storyIds.map(id => db.collection('stories').doc(id).get()));
    sDocs.forEach(d => { if (d.exists) storyMap[d.id] = d.data().opening || ''; });
  }
  const toIso = v => v?.toDate ? v.toDate().toISOString() : (v || '');
  return {
    ok: true,
    edits: snap.docs
      .map(d => ({ edit_id: d.id, ...d.data(), edited_at: toIso(d.data().edited_at), story_opening: storyMap[d.data().story_id] || '' }))
      .sort((a, b) => b.edited_at.localeCompare(a.edited_at)),
  };
}

async function fbMarkAiReviewed(admin_id, sub_ids) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  if (!sub_ids?.length) return { ok: true };
  await Promise.all(sub_ids.map(id => db.collection('submissions').doc(id).update({ ai_reviewed: true })));
  return { ok: true };
}

// ─── AI 활동 ─────────────────────────────────────────────

async function fbSetAIConfig(admin_id, updates) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  const patch = { updated_at: fbNow() };
  if (updates.sub_enabled  !== undefined) patch.sub_enabled  = Boolean(updates.sub_enabled);
  if (updates.vote_enabled !== undefined) patch.vote_enabled = Boolean(updates.vote_enabled);
  if (updates.speed_pct    !== undefined) patch.speed_pct    = Math.min(200, Math.max(50, Number(updates.speed_pct)));
  await db.collection('config').doc('ai_config').set(patch, { merge: true });
  return { ok: true };
}

// ─── 메인 디스패처 ───────────────────────────────────────

async function firebaseApi(action, params = {}) {
  const token = localStorage.getItem('hwasee_token');
  const uid   = localStorage.getItem('hwasee_uid');
  // localStorage 값은 누구나 브라우저 콘솔에서 조작 가능 — 매 호출마다 Firestore의
  // 실제 token과 대조해서 검증해야 타인 user_id를 임의로 넣어 행세하는 걸 막을 수 있음
  let session = null;
  let sessionCheckFailed = false; // Firestore 조회 자체가 실패한 경우(네트워크 등) — 진짜 세션 만료와 구분해야 함
  if (token && uid) {
    try {
      const snap = await db.collection('user_secrets').doc(uid).get();
      if (snap.exists && snap.data().token === token) session = { user_id: uid };
    } catch (e) { sessionCheckFailed = true; }
  }
  if (session) _fbBackfillAuthUid(uid); // 기존 세션 유지 중인 유저도 점진적으로 auth_uid 바인딩 (fire-and-forget)
  // sessionCheckFailed일 땐 '로그인이 필요합니다.'를 던지지 않음 — 그 문자열은 클라이언트
  // api()에서 "진짜 세션 만료"로 해석해 강제 로그아웃+홈 이동을 트리거하는데, 단순 조회
  // 실패(네트워크 hiccup 등)까지 그렇게 처리하면 토큰이 멀쩡한데도 로그아웃당하고
  // 관리자 페이지 등에서 "로딩하다가 튕겨나가는" 간헐적 증상으로 이어짐.
  const need = () => {
    if (session) return session;
    throw new Error(sessionCheckFailed ? '일시적인 오류입니다. 다시 시도해주세요.' : '로그인이 필요합니다.');
  };

  switch (action) {
    case 'register':           return fbRegister(params.nickname, params.password, params.name, params.display_name, params.referral);
    case 'login':              return fbLogin(params.nickname, params.password);
    case 'deleteAccount':      return fbDeleteAccount(need().user_id);
    case 'changePassword':     return fbChangePassword(need().user_id, params.current_password, params.new_password);
    case 'findAccount':        return fbFindAccount(params.name);
    case 'resetPassword':      return fbResetPassword(params.nickname, params.name, params.new_password);

    case 'getStories':         return fbGetStories(params.page);
    case 'getStory':           return fbGetStory(params.story_id, session?.user_id || null);
    case 'createStory':        return fbCreateStory(params.opening, need().user_id, params.is_ai_seed);
    case 'getMyStories':       return fbGetMyStories(need().user_id);

    case 'getEpisode':         return fbGetEpisode(params.episode_id);
    case 'createSubmission':   return fbCreateSubmission(params.episode_id, params.content, need().user_id, params.derived_from, params.closing);
    case 'vote':               return fbVote(params.episode_id, params.sub_ids, need().user_id);

    case 'getSeeds':           return fbGetSeeds();
    case 'getAISuggestion':    return fbGetAISuggestion();
    case 'seedInitialStories': return { ok: true };

    case 'getNotifications':      return fbGetNotifications(need().user_id);
    case 'markNotificationsRead': return fbMarkNotificationsRead(need().user_id);

    case 'addBookmark':        return fbAddBookmark(params.story_id, need().user_id);
    case 'removeBookmark':     return fbRemoveBookmark(params.story_id, need().user_id);
    case 'getBookmarkIds':     return fbGetBookmarkIds(need().user_id);
    case 'getBookmarks':       return fbGetBookmarks(need().user_id);

    case 'addComment':         return fbAddComment(params.sub_id, params.content, need().user_id);
    case 'deleteComment':      return fbDeleteComment(params.comment_id, need().user_id);
    case 'getComments':        return fbGetComments(params.sub_id);
    case 'addStoryComment':    return fbAddStoryComment(params.story_id, params.content, need().user_id);
    case 'getStoryComments':   return fbGetStoryComments(params.story_id);

    case 'addReport':          return fbAddReport(params.sub_id, params.reason, need().user_id);
    case 'getReports':         return fbGetReports(need().user_id);
    case 'dismissReport':      return fbDismissReport(params.report_id, need().user_id);
    case 'getAdminStats':      return fbGetAdminStats(need().user_id);
    case 'adminEditSub':       return fbAdminEditSub(need().user_id, params.sub_id, params.new_content, params.old_content, params.story_id, params.edit_type);
    case 'getAdminEdits':      return fbGetAdminEdits(need().user_id);
    case 'markAiReviewed':     return fbMarkAiReviewed(need().user_id, params.sub_ids);

    case 'getLeaderboard':          return fbGetLeaderboard();
    case 'backfillAdoptionCounts':  return fbBackfillAdoptionCounts(need().user_id);
    case 'backfillLikeCounts':      return fbBackfillLikeCounts(need().user_id);
    case 'getProfile':           return fbGetProfile(need().user_id);
    case 'getPublicProfile':     need(); return fbGetPublicProfile(params.user_id);
    case 'buyAvatar':            return fbBuyAvatar(params.emoji_id, need().user_id);
    case 'setAvatar':            return fbSetAvatar(params.emoji_id, need().user_id);
    case 'checkDisplayName':     return fbCheckDisplayName(params.display_name);
    case 'changeDisplayName':    return fbChangeDisplayName(need().user_id, params.display_name);

    case 'voteMvp':            return fbVoteMvp(params.story_id, params.episode_id, need().user_id);
    case 'getMvpVotes':        return fbGetMvpVotes(params.story_id, session?.user_id || null);
    case 'createBranch':       return fbCreateBranch(params.story_id, params.branch_from_step, need().user_id);
    case 'extendStory':        return fbExtendStory(params.story_id, need().user_id);

    case 'deleteMySubmission': return fbDeleteMySubmission(params.sub_id, need().user_id);

    case 'boostStory':         return fbBoostStory(params.story_id, need().user_id);
    case 'buyExtraSubmit':     return fbBuyExtraSubmit(params.episode_id, need().user_id);
    case 'toggleStoryLike':    return fbToggleStoryLike(params.story_id, need().user_id);

    case 'adminForceAdopt':       return fbAdminForceAdopt(params.sub_id, need().user_id);
    case 'adminDeleteSubmission': return fbAdminDeleteSubmission(params.sub_id, need().user_id);
    case 'adminCloseStory':       return fbAdminCloseStory(params.story_id, need().user_id);
    case 'adminFixParticipantCount': return fbAdminFixParticipantCount(params.story_id, need().user_id);
    case 'getAIActivities':       return fbGetAIActivities(need().user_id);
    case 'setAIConfig':           return fbSetAIConfig(need().user_id, params);
    case 'setClaudeKey':          return fbSetClaudeKey(need().user_id, params.key);

    case 'saveFcmToken':    return fbSaveFcmToken(need().user_id, params.fcm_token);
    case 'trackVisit':      return fbTrackVisit(params.is_unique);
    case 'checkDailyBonus': return { ok: true, bonus: await _fbCheckDailyBonus(need().user_id) };
    case 'submitBugReport':   return fbSubmitBugReport(params.content, need().user_id);
    case 'getBugReports':     return fbGetBugReports(need().user_id);
    case 'resolveBugReport':  return fbResolveBugReport(params.report_id || params.bug_id, need().user_id, params.comment || '');

    case 'addPatchNote':      return fbAddPatchNote(need().user_id, params.content);
    case 'getPatchNotes':     return fbGetPatchNotes(need().user_id);
    case 'getUnseenPatchNote': return fbGetUnseenPatchNote(need().user_id);
    case 'markPatchNoteSeen': return fbMarkPatchNoteSeen(need().user_id, params.patch_id);
    case 'getPatchNotesFeed': need(); return fbGetPatchNotesFeed();
    case 'pingWarm': return { ok: true };
    default:         return { ok: false, error: '알 수 없는 요청입니다.' };
  }
}
