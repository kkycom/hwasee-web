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

const FB_ADMIN_ID        = 'c50c82b2-fe0e-4ee9-be8c-8132f03b9cb6';
var FB_VOTE_THRESHOLD  = 3;

// ─── 유틸 ────────────────────────────────────────────────

function fbGenId() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

function fbNow() { return new Date().toISOString(); }

async function fbHashPw(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

const FB_AVATAR_SHOP = [
  { id:'🍂', label:'낙엽',    price: 300 },
  { id:'🌾', label:'벼이삭',  price: 300 },
  { id:'🍄', label:'버섯',    price: 500 },
  { id:'🌵', label:'선인장',  price: 500 },
  { id:'🎋', label:'대나무',  price: 500 },
  { id:'🌻', label:'해바라기', price: 500 },
  { id:'🦋', label:'나비',    price: 800 },
  { id:'🌊', label:'파도',    price: 800 },
  { id:'🌙', label:'달',      price: 800 },
  { id:'⭐', label:'별',      price:1000 },
  { id:'🔥', label:'불꽃',   price:1000 },
];

function fbCalcBadge(pts) {
  if (pts >= 5000) return 'fruit';
  if (pts >= 4000) return 'flower1';
  if (pts >= 3000) return 'flower';
  if (pts >= 2000) return 'bud';
  if (pts >= 1700) return 'leaf2';
  if (pts >= 1200) return 'leaf1';
  if (pts >= 700)  return 'leaf';
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
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return null;
    const u = snap.data();
    if (u.token !== token) return null;
    if (new Date(u.token_exp) < new Date()) return null;
    return { user_id: uid, nickname: u.nickname, display_name: u.display_name || u.nickname, total_points: u.total_points || 0, badge: u.badge || 'seed' };
  } catch(e) { return null; }
}

// ─── 포인트 ──────────────────────────────────────────────

async function _fbAddPoints(user_id, pts, reason, sub_id) {
  if (!user_id || pts <= 0) return;
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

async function fbRegister(nickname, password, name, display_name) {
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

  await db.collection('users').doc(user_id).set({
    user_id, nickname, display_name: dn, pw_hash: await fbHashPw(password), token, token_exp,
    total_points: 0, badge: 'seed', name: (name || '').trim(), created_at: fbNow()
  });

  localStorage.setItem('hwasee_uid', user_id);
  return { ok: true, token, user_id, nickname, display_name: dn, total_points: 0, badge: 'seed', is_admin: user_id === FB_ADMIN_ID };
}

async function fbLogin(nickname, password) {
  if (!nickname || !password) return { ok: false, error: '닉네임과 비밀번호를 입력해주세요.' };

  const snap = await db.collection('users').where('nickname', '==', nickname).limit(1).get();
  if (snap.empty) return { ok: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };

  const doc  = snap.docs[0];
  const u    = doc.data();
  if (u.pw_hash !== await fbHashPw(password)) return { ok: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };

  const token     = fbGenId();
  const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await doc.ref.update({ token, token_exp });
  localStorage.setItem('hwasee_uid', u.user_id);

  const daily_bonus = await _fbCheckDailyBonus(u.user_id);
  const adoptSnap = await db.collection('submissions')
    .where('author_id', '==', u.user_id).where('is_adopted', '==', true).get();

  // 기존 유저 display_name 자동 마이그레이션
  if (!u.display_name) await doc.ref.update({ display_name: u.nickname });

  return {
    ok: true, token, user_id: u.user_id, nickname: u.nickname,
    display_name: u.display_name || u.nickname,
    total_points: u.total_points || 0, badge: u.badge || 'seed',
    is_admin: u.user_id === FB_ADMIN_ID, daily_bonus, adoption_count: adoptSnap.size
  };
}

async function _fbCheckDailyBonus(user_id) {
  const today = new Date().toISOString().slice(0, 10);
  const snap  = await db.collection('point_ledger')
    .where('user_id', '==', user_id).where('reason', '==', 'daily_login').get();
  const already = snap.docs.some(d => String(d.data().created_at).slice(0, 10) === today);
  if (!already) { await _fbAddPoints(user_id, 10, 'daily_login', ''); return 10; }
  return 0;
}

async function fbChangePassword(user_id, current_password, new_password) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  const snap = await db.collection('users').doc(user_id).get();
  if (!snap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
  const u = snap.data();
  if (u.pw_hash !== await fbHashPw(current_password)) return { ok: false, error: '현재 비밀번호가 올바르지 않습니다.' };
  await snap.ref.update({ pw_hash: await fbHashPw(new_password) });
  return { ok: true };
}

async function fbDeleteAccount(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  if (user_id === FB_ADMIN_ID) return { ok: false, error: '관리자 계정은 탈퇴할 수 없습니다.' };
  const batch = db.batch();
  batch.delete(db.collection('users').doc(user_id));
  const [bmSnap, nSnap] = await Promise.all([
    db.collection('bookmarks').where('user_id', '==', user_id).get(),
    db.collection('notifications').where('user_id', '==', user_id).get(),
  ]);
  bmSnap.docs.forEach(d => batch.delete(d.ref));
  nSnap.docs.forEach(d => batch.delete(d.ref));
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
  await doc.ref.update({ pw_hash: await fbHashPw(new_password) });
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

    const openVoteMap = {};
    episodesSnap.docs.forEach(d => {
      const e = d.data();
      const cur = openVoteMap[e.story_id] || 0;
      if ((e.vote_total || 0) > cur) openVoteMap[e.story_id] = e.vote_total || 0;
    });
    const boostSet = new Set(boostsSnap.docs.map(d => d.data().story_id));

    const stories = storiesSnap.docs.map(d => ({
      ...d.data(),
      is_boosted:       boostSet.has(d.id),
      activity_count:   d.data().participant_count || 0,
      creator_nickname: d.data().creator_nickname || '익명',
      creator_badge:    d.data().creator_badge    || '',
    }));

    stories.sort((a, b) => {
      if (a.is_boosted !== b.is_boosted) return a.is_boosted ? -1 : 1;
      const vDiff = (openVoteMap[b.story_id] || 0) - (openVoteMap[a.story_id] || 0);
      if (vDiff !== 0) return vDiff;
      return new Date(a.created_at) - new Date(b.created_at);
    });

    return { ok: true, stories, page: 1 };
  } else {
    const [storiesSnap, likesSnap] = await Promise.all([
      db.collection('stories').where('status', '==', 'completed').get(),
      db.collection('story_likes').get(),
    ]);
    const likeCountMap = {};
    likesSnap.docs.forEach(d => {
      const r = d.data();
      likeCountMap[r.story_id] = (likeCountMap[r.story_id] || 0) + 1;
    });
    const stories = storiesSnap.docs
      .map(d => ({ ...d.data(), like_count: likeCountMap[d.id] || 0 }))
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

  // 제출 작성자만 개별 조회 (전체 users 컬렉션 대신)
  const authorIds = [...new Set(subsSnap.docs.map(d => d.data().author_id).filter(Boolean))];
  const nickMap = {}, badgeMap = {};
  if (authorIds.length > 0) {
    const userDocs = await Promise.all(authorIds.map(id => db.collection('users').doc(id).get()));
    userDocs.forEach(d => { if (d.exists) { nickMap[d.id] = d.data().display_name || d.data().nickname; badgeMap[d.id] = d.data().badge; } });
  }

  const commentCountMap = {};
  commSnap.docs.forEach(d => {
    const sid = d.data().sub_id;
    if (sid) commentCountMap[sid] = (commentCountMap[sid] || 0) + (d.data().deleted ? 0 : 1);
  });

  const story       = storySnap.data();
  const episodes    = episodesSnap.docs.map(d => ({ episode_id: d.id, ...d.data() }));
  const submissions = subsSnap.docs.map(d => ({
    sub_id: d.id,
    ...d.data(),
    author_nickname: nickMap[d.data().author_id] || '익명',
    author_badge:    badgeMap[d.data().author_id] || 'seed',
    comment_count:   commentCountMap[d.id] || 0,
  }));

  let is_bookmarked = false;
  let is_liked = false, like_count = 0;
  let my_voted_sub_ids = [];

  const extras = await Promise.all([
    user_id ? db.collection('bookmarks').where('user_id','==',user_id).where('story_id','==',story_id).limit(1).get() : Promise.resolve(null),
    db.collection('story_likes').where('story_id','==',story_id).get(),
  ]);

  if (extras[0]) is_bookmarked = !extras[0].empty;
  like_count = extras[1].size;
  if (user_id) is_liked = extras[1].docs.some(d => d.data().user_id === user_id);

  // open 상태인데 최고 득표가 임계값 이상이면 pending으로 자동 전환 (채택강행 후 stuck 복구)
  const stuckEp = episodes.find(e => e.status === 'open');
  if (stuckEp) {
    const stuckSubs = submissions.filter(s => s.episode_id === stuckEp.episode_id);
    const maxV = stuckSubs.reduce((m, s) => Math.max(m, Number(s.vote_count) || 0), 0);
    if (maxV >= FB_VOTE_THRESHOLD) {
      await _fbCloseEpisode(stuckEp.episode_id, { ...stuckEp });
    }
  }

  if (user_id) {
    const openEp = episodes.find(e => e.status === 'open');
    if (openEp) {
      const vSnap = await db.collection('votes')
        .where('episode_id','==',openEp.episode_id).where('voter_id','==',user_id).get();
      my_voted_sub_ids = vSnap.docs.map(d => d.data().sub_id);
    }
  }

  // MVP 투표 현황
  const mvp_map = {};
  let my_mvp_episode_id = null;
  mvpSnap.docs.forEach(d => {
    const m = d.data();
    if (m.episode_id) mvp_map[m.episode_id] = (mvp_map[m.episode_id] || 0) + 1;
    if (user_id && m.voter_id === user_id) my_mvp_episode_id = m.episode_id || null;
  });

  // 이 이야기의 외부 분기 목록
  const branchSnap = await db.collection('stories').where('parent_story_id', '==', story_id).get();
  const branches = branchSnap.docs.map(d => ({
    story_id: d.data().story_id || d.id,
    branch_from_step: Number(d.data().branch_from_step),
    status: d.data().status,
  }));

  // 분기 이야기면 부모 단계 가져오기 (잠금 산문용)
  let parent_chain = null;
  if (story.parent_story_id) {
    const [pEpsSnap, pSubsSnap] = await Promise.all([
      db.collection('episodes').where('story_id', '==', story.parent_story_id).get(),
      db.collection('submissions').where('story_id', '==', story.parent_story_id).get(),
    ]);
    const pEps = pEpsSnap.docs
      .map(d => ({ episode_id: d.id, ...d.data() }))
      .filter(e => e.status === 'closed' && Number(e.step) < Number(story.branch_from_step) - 1);
    const pSubs = pSubsSnap.docs.map(d => ({
      ...d.data(),
      author_nickname: nickMap[d.data().author_id] || '익명',
      author_badge:    badgeMap[d.data().author_id] || 'seed',
    }));
    parent_chain = { episodes: pEps, submissions: pSubs };
  }

  const storyWithCreator = {
    ...story,
    creator_nickname: story.creator_nickname || '익명',
    creator_badge:    story.creator_badge    || '',
  };

  return { ok: true, story: storyWithCreator, episodes, submissions, is_bookmarked, is_liked, like_count, my_voted_sub_ids, branches, parent_chain, mvp_map, my_mvp_episode_id };
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
    created_at: fbNow(), batch: '', participant_count: 0
  });
  batch.set(db.collection('episodes').doc(episode_id), {
    episode_id, story_id, step: 1, parent_sub_id: '',
    status: 'open', vote_total: 0, created_at: fbNow(), closed_at: '', pending_at: ''
  });
  await batch.commit();
  return { ok: true, story_id, episode_id };
}

async function fbGetMyStories(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };

  const [mySubsSnap, myVotesSnap] = await Promise.all([
    db.collection('submissions').where('author_id', '==', user_id).get(),
    db.collection('votes').where('voter_id', '==', user_id).get(),
  ]);

  // 제출에서 story_id 직접 추출 (submissions에 story_id 저장돼 있음)
  const storyIdSet = new Set(mySubsSnap.docs.map(d => d.data().story_id).filter(Boolean));
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

  const openEpMap = {};
  Object.entries(epMap).forEach(([epId, ep]) => {
    if (ep.status === 'open') openEpMap[ep.story_id] = epId;
  });

  const myVoteCountMap = {};
  myVotesSnap.docs.forEach(d => {
    const epId = d.data().episode_id;
    if (epId) myVoteCountMap[epId] = (myVoteCountMap[epId] || 0) + 1;
  });

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
    });
  }));

  stories.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { ok: true, stories };
}

// ─── 에피소드 ────────────────────────────────────────────

async function fbGetEpisode(episode_id) {
  const epSnap = await db.collection('episodes').doc(episode_id).get();
  if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  const ep = epSnap.data();

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
  const epRef = db.collection('episodes').doc(episode_id);
  // 트랜잭션으로 pending 상태일 때만 closed로 변경 — 동시 호출 시 중복 처리 방지
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
    await _fbDistributePoints(w, allSubs);
  }

  const storySnap = await db.collection('stories').doc(ep.story_id).get();
  if (!storySnap.exists) return;

  const st       = storySnap.data();
  const nextStep = (Number(st.current_step) || 0) + 1;
  const maxSteps = Number(st.max_steps) || 10;
  const anyClose = winners.some(w => w.is_closing === true);
  const snippet  = (st.opening || '').slice(0, 25) + ((st.opening || '').length > 25 ? '…' : '');

  if (nextStep >= maxSteps || anyClose) {
    await storySnap.ref.update({ current_step: nextStep, status: 'completed' });
    const ids = await _fbGetStoryParticipants(ep.story_id);
    await _fbCreateNotifications(ids, ep.story_id, `"${snippet}" 이야기가 완결됐어요!`);
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

    const winnerAuthorIds = new Set(winners.map(w => w.author_id).filter(Boolean));
    for (const uid of winnerAuthorIds) {
      await _fbCreateNotifications([uid], ep.story_id, `"${snippet}" 이야기에서 내 문장이 채택됐어요!`);
    }
    const sourceAuthorIds = new Set();
    for (const w of winners) {
      const parent = allSubs.find(s => s.sub_id === w.derived_from);
      if (parent && parent.author_id && !winnerAuthorIds.has(parent.author_id)) {
        sourceAuthorIds.add(parent.author_id);
      }
    }
    for (const uid of sourceAuthorIds) {
      await _fbCreateNotifications([uid], ep.story_id, `"${snippet}" 이야기에서 내 글을 손본 문장이 채택됐어요! +10P`);
    }
    const allPart  = await _fbGetStoryParticipants(ep.story_id);
    const otherIds = allPart.filter(id => !winnerAuthorIds.has(id));
    const msg = winners.length > 1
      ? `"${snippet}" 이야기가 ${nextStep + 1}단계에서 ${winners.length}개 갈림길로 나뉘었어요!`
      : `"${snippet}" 이야기가 ${nextStep + 1}단계로 이어졌어요!`;
    await _fbCreateNotifications(otherIds, ep.story_id, msg);
  }
}

async function _fbDistributePoints(winner, allSubs) {
  const parent = allSubs.find(s => s.sub_id === winner.derived_from);
  if (!parent) {
    await _fbAddPoints(winner.author_id, 20, 'direct', winner.sub_id);
  } else {
    const gp = allSubs.find(s => s.sub_id === parent.derived_from);
    if (!gp) {
      await _fbAddPoints(parent.author_id, 10, 'source',  winner.sub_id);
      await _fbAddPoints(winner.author_id, 10, 'derived', winner.sub_id);
    } else {
      await _fbAddPoints(gp.author_id,     10, 'source',  winner.sub_id);
      await _fbAddPoints(parent.author_id,  5, 'mid',     winner.sub_id);
      await _fbAddPoints(winner.author_id,  5, 'derived', winner.sub_id);
    }
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
  // 투표자 — in 쿼리 최대 10개 제한 대응
  if (epIds.size > 0) {
    const epArr = [...epIds].slice(0, 10);
    const vSnap = await db.collection('votes').where('episode_id', 'in', epArr).get();
    vSnap.docs.forEach(d => ids.push(d.data().voter_id));
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
  const already = prevSubsSnap.docs.some(d => d.data().author_id === author_id);
  if (already) {
    const exSnap = await db.collection('extra_submits')
      .where('episode_id','==',episode_id).where('user_id','==',author_id).limit(1).get();
    if (exSnap.empty) return { ok: false, error: '이미 제출하셨습니다.' };
  }

  const sub_id    = fbGenId();
  const is_closing = closing === true && Number(ep.step) >= 3;
  const uDoc = await db.collection('users').doc(author_id).get();
  const uData = uDoc.exists ? uDoc.data() : {};
  await db.collection('submissions').doc(sub_id).set({
    sub_id, episode_id, story_id: ep.story_id, content: text,
    author_id, author_nickname: uData.display_name || uData.nickname || '익명',
    author_badge: uData.badge || 'seed',
    derived_from: derived_from || '', vote_count: 0,
    is_adopted: false, created_at: fbNow(), is_closing
  });
  await _fbAddPoints(author_id, 5, 'submit', sub_id);

  // participant_count 증가 (첫 제출 시) — 복합 인덱스 없이 단일 필드 쿼리 후 클라이언트 필터
  const mySubsSnap = await db.collection('submissions')
    .where('author_id','==',author_id).get();
  const prevCount = mySubsSnap.docs.filter(d => d.data().story_id === ep.story_id && d.id !== sub_id).length;
  if (prevCount === 0) {
    await db.collection('stories').doc(ep.story_id).update({
      participant_count: firebase.firestore.FieldValue.increment(1)
    });
  }

  return { ok: true, sub_id };
}

// ─── 투표 ────────────────────────────────────────────────

async function fbVote(episode_id, sub_ids, voter_id) {
  if (!Array.isArray(sub_ids) || sub_ids.length < 1 || sub_ids.length > 2)
    return { ok: false, error: '1개 또는 2개를 선택해주세요.' };

  const epSnap = await db.collection('episodes').doc(episode_id).get();
  if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  const ep = epSnap.data();
  if (ep.status !== 'open') return { ok: false, error: '공감이 마감됐습니다.' };

  const prevVoteSnap = await db.collection('votes')
    .where('episode_id','==',episode_id).where('voter_id','==',voter_id).get();
  const isRevote = !prevVoteSnap.empty;
  const prevVotedSubIds = prevVoteSnap.docs.map(d => d.data().sub_id);

  const subsSnap = await db.collection('submissions').where('episode_id','==',episode_id).get();
  const mySub    = subsSnap.docs.find(d => d.data().author_id === voter_id);
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
  await batch.commit();

  if (!isRevote) await _fbAddPoints(voter_id, 1, 'vote', '');

  // 최고 득표 확인
  const updSubsSnap = await db.collection('submissions').where('episode_id','==',episode_id).get();
  const maxSubVotes = updSubsSnap.docs.reduce((m, d) => Math.max(m, Number(d.data().vote_count) || 0), 0);

  if (maxSubVotes >= FB_VOTE_THRESHOLD) {
    await _fbCloseEpisode(episode_id, ep);
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
];

async function fbGetSeeds() {
  const usedSnap = await db.collection('stories').get();
  const used     = new Set(usedSnap.docs.map(d => d.data().opening));
  const available = FB_AI_OPENINGS.filter(o => !used.has(o));
  const src    = available.length >= 5 ? available.slice() : FB_AI_OPENINGS.slice();
  const picked = [];
  while (picked.length < Math.min(5, src.length)) {
    const idx = Math.floor(Math.random() * src.length);
    picked.push(src.splice(idx, 1)[0]);
  }
  return { ok: true, seeds: picked, exhausted: available.length === 0 };
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
  const notifications = snap.docs.map(d => d.data())
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
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
  const ids    = snap.docs.map(d => d.data().story_id);
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
  const [rSnap, uSnap, sSnap] = await Promise.all([
    db.collection('reports').orderBy('created_at', 'desc').get(),
    db.collection('users').get(),
    db.collection('submissions').get(),
  ]);
  const nickMap = {}, subMap = {};
  uSnap.docs.forEach(d => { nickMap[d.id] = d.data().display_name || d.data().nickname; });
  sSnap.docs.forEach(d => { subMap[d.id] = d.data(); });
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

// ─── 랭킹 ────────────────────────────────────────────────

async function fbGetLeaderboard() {
  const [uSnap, sSnap, vSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('submissions').get(),
    db.collection('votes').get(),
  ]);

  const uMap = {};
  uSnap.docs.forEach(d => { uMap[d.id] = d.data(); });

  const pointsRank = uSnap.docs
    .filter(d => Number(d.data().total_points) > 0 && d.id !== FB_ADMIN_ID)
    .sort((a,b) => Number(b.data().total_points) - Number(a.data().total_points))
    .slice(0, 10)
    .map(d => ({ nickname: d.data().display_name || d.data().nickname, badge: d.data().badge, value: Number(d.data().total_points) }));

  const adoptMap = {};
  sSnap.docs.filter(d => d.data().is_adopted === true && d.data().author_id !== FB_ADMIN_ID)
    .forEach(d => { adoptMap[d.data().author_id] = (adoptMap[d.data().author_id] || 0) + 1; });
  const adoptionsRank = Object.entries(adoptMap)
    .sort(([,a],[,b]) => b - a).slice(0, 10)
    .map(([uid, cnt]) => ({ nickname: uMap[uid]?.display_name || uMap[uid]?.nickname || '?', badge: uMap[uid]?.badge || 'seed', value: cnt }));

  const partMap = {};
  sSnap.docs.filter(d => d.data().author_id !== FB_ADMIN_ID)
    .forEach(d => { partMap[d.data().author_id] = (partMap[d.data().author_id] || 0) + 1; });
  const votedEps = {};
  vSnap.docs.filter(d => d.data().voter_id !== FB_ADMIN_ID).forEach(d => {
    const v = d.data();
    if (!votedEps[v.voter_id]) votedEps[v.voter_id] = new Set();
    votedEps[v.voter_id].add(v.episode_id);
  });
  Object.entries(votedEps).forEach(([uid, eps]) => { partMap[uid] = (partMap[uid] || 0) + eps.size; });
  const partRank = Object.entries(partMap)
    .sort(([,a],[,b]) => b - a).slice(0, 10)
    .map(([uid, cnt]) => ({ nickname: uMap[uid]?.display_name || uMap[uid]?.nickname || '?', badge: uMap[uid]?.badge || 'seed', value: cnt }));

  return { ok: true, points: pointsRank, adoptions: adoptionsRank, participations: partRank };
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

  await db.collection('story_mvp').doc(fbGenId()).set({
    story_id, voter_id, nominated_user_id: sub.author_id, episode_id, created_at: fbNow()
  });
  await _fbAddPoints(sub.author_id, 10, 'mvp_nomination', '');
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
  const uSnap = await db.collection('users').get();
  const nickMap = {}, badgeMap = {};
  uSnap.docs.forEach(d => { nickMap[d.id] = d.data().nickname; badgeMap[d.id] = d.data().badge; });
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

  batch.set(db.collection('stories').doc(new_story_id), {
    story_id: new_story_id, parent_story_id: story_id, branch_from_step: step,
    opening: st.opening, max_steps: st.max_steps || 10,
    current_step: step - 1, status: 'active', creator_id: user_id,
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
  const stSnap = await db.collection('stories').doc(story_id).get();
  if (!stSnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
  const st = stSnap.data();
  if (st.status !== 'completed' && st.status !== 'inactive')
    return { ok: false, error: '완결된 이야기에만 추천할 수 있습니다.' };
  const snap    = await db.collection('story_likes').where('story_id','==',story_id).get();
  const myLike  = snap.docs.find(d => d.data().user_id === user_id);
  if (myLike) {
    await myLike.ref.delete();
    return { ok: true, liked: false, like_count: snap.size - 1 };
  } else {
    await db.collection('story_likes').doc(fbGenId()).set({ story_id, user_id, created_at: fbNow() });
    return { ok: true, liked: true, like_count: snap.size + 1 };
  }
}

// ─── 프로필 ──────────────────────────────────────────────

async function fbGetProfile(user_id) {
  const uSnap = await db.collection('users').doc(user_id).get();
  if (!uSnap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
  const u = uSnap.data();

  const [histSnap, adoptSnap] = await Promise.all([
    db.collection('point_ledger').where('user_id','==',user_id).get(),
    db.collection('submissions').where('author_id','==',user_id).where('is_adopted','==',true).get(),
  ]);

  // 채택글에서 실제 참조하는 ID만 배치 조회 (전체 episodes/stories 조회 방지)
  const epMap = {}, storyMap = {};
  const _toChunks = arr => { const c = []; for (let i = 0; i < arr.length; i += 30) c.push(arr.slice(i, i+30)); return c; };
  const adoptedEpIds    = [...new Set(adoptSnap.docs.map(d => d.data().episode_id).filter(Boolean))];
  const adoptedStoryIds = [...new Set(adoptSnap.docs.map(d => d.data().story_id).filter(Boolean))];
  await Promise.all([
    ..._toChunks(adoptedEpIds).map(ch =>
      db.collection('episodes').where(firebase.firestore.FieldPath.documentId(), 'in', ch).get()
        .then(s => s.docs.forEach(d => { epMap[d.id] = d.data(); }))
    ),
    ..._toChunks(adoptedStoryIds).map(ch =>
      db.collection('stories').where(firebase.firestore.FieldPath.documentId(), 'in', ch).get()
        .then(s => s.docs.forEach(d => { storyMap[d.id] = d.data().opening; }))
    ),
  ]);

  const history = histSnap.docs.map(d => d.data())
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20);

  const subIds = [...new Set(history.map(h => h.sub_id).filter(Boolean))];
  const subStoryMap = {};
  if (subIds.length) {
    const chunks = [];
    for (let i = 0; i < subIds.length; i += 30) chunks.push(subIds.slice(i, i + 30));
    await Promise.all(chunks.map(async chunk => {
      const snap = await db.collection('submissions')
        .where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
      snap.docs.forEach(d => { subStoryMap[d.id] = d.data().story_id; });
    }));
  }
  history.forEach(h => { if (h.sub_id && subStoryMap[h.sub_id]) h.story_id = subStoryMap[h.sub_id]; });
  const adoptions = adoptSnap.docs.map(d => {
    const s = d.data();
    return {
      sub_id: s.sub_id, content: s.content, vote_count: s.vote_count,
      story_id: s.story_id, story_opening: storyMap[s.story_id] || '',
      step: epMap[s.episode_id] ? Number(epMap[s.episode_id].step) : 0,
      created_at: s.created_at,
    };
  }).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

  return {
    ok: true,
    user: { user_id, nickname: u.nickname, display_name: u.display_name || u.nickname, total_points: u.total_points || 0, badge: u.badge || 'seed', avatar: u.avatar || null, owned_avatars: u.owned_avatars || [], created_at: u.created_at },
    history, adoptions,
  };
}

async function fbBuyAvatar(emoji_id, user_id) {
  const item = FB_AVATAR_SHOP.find(x => x.id === emoji_id);
  if (!item) return { ok: false, error: '존재하지 않는 아이템입니다.' };
  const uRef = db.collection('users').doc(user_id);
  const ledgerRef = db.collection('point_ledger').doc();
  return db.runTransaction(async tx => {
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

async function fbAdminCloseStory(story_id, admin_id) {
  if (admin_id !== FB_ADMIN_ID) return { ok: false, error: '권한이 없습니다.' };
  await db.collection('stories').doc(story_id).update({ status: 'inactive' });
  return { ok: true };
}

async function fbGetBugReports(user_id) {
  const uSnap = await db.collection('users').doc(user_id).get();
  if (!uSnap.exists || uSnap.data().badge !== 'treeguard') return { ok: false, error: '권한이 없습니다.' };
  const snap = await db.collection('bug_reports').orderBy('created_at', 'desc').limit(50).get();
  const reports = await Promise.all(snap.docs.map(async d => {
    const data = d.data();
    const uDoc = await db.collection('users').doc(data.user_id).get();
    return { id: d.id, ...data, reporter_nickname: uDoc.exists ? (uDoc.data().display_name || uDoc.data().nickname) : '알 수 없음' };
  }));
  return { ok: true, reports };
}

async function fbResolveBugReport(report_id, user_id) {
  const uSnap = await db.collection('users').doc(user_id).get();
  if (!uSnap.exists || uSnap.data().badge !== 'treeguard') return { ok: false, error: '권한이 없습니다.' };
  await db.collection('bug_reports').doc(report_id).update({ status: 'resolved' });
  return { ok: true };
}

async function fbSubmitBugReport(content, user_id) {
  if (!content || content.trim().length < 5) return { ok: false, error: '내용을 5자 이상 입력해주세요.' };
  const t = now();
  await db.collection('bug_reports').add({ user_id, content: content.trim(), created_at: t, status: 'open' });
  await Promise.all([
    db.collection('users').doc(user_id).update({
      points: firebase.firestore.FieldValue.increment(10),
      total_points: firebase.firestore.FieldValue.increment(10),
    }),
    db.collection('point_history').add({ user_id, points: 10, reason: 'bug_report', created_at: t }),
  ]);
  return { ok: true };
}

// ─── 메인 디스패처 ───────────────────────────────────────

async function firebaseApi(action, params = {}) {
  const token   = localStorage.getItem('hwasee_token');
  const session = token ? await fbGetSession(token) : null;
  const need    = () => { if (!session) throw new Error('로그인이 필요합니다.'); return session; };

  switch (action) {
    case 'register':           return fbRegister(params.nickname, params.password, params.name);
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

    case 'getLeaderboard':       return fbGetLeaderboard();
    case 'getProfile':           return fbGetProfile(need().user_id);
    case 'buyAvatar':            return fbBuyAvatar(params.emoji_id, need().user_id);
    case 'setAvatar':            return fbSetAvatar(params.emoji_id, need().user_id);
    case 'checkDisplayName':     return fbCheckDisplayName(params.display_name);
    case 'changeDisplayName':    return fbChangeDisplayName(need().user_id, params.display_name);

    case 'voteMvp':            return fbVoteMvp(params.story_id, params.episode_id, need().user_id);
    case 'getMvpVotes':        return fbGetMvpVotes(params.story_id, session?.user_id || null);
    case 'createBranch':       return fbCreateBranch(params.story_id, params.branch_from_step, need().user_id);

    case 'deleteMySubmission': return fbDeleteMySubmission(params.sub_id, need().user_id);

    case 'boostStory':         return fbBoostStory(params.story_id, need().user_id);
    case 'buyExtraSubmit':     return fbBuyExtraSubmit(params.episode_id, need().user_id);
    case 'toggleStoryLike':    return fbToggleStoryLike(params.story_id, need().user_id);

    case 'adminForceAdopt':       return fbAdminForceAdopt(params.sub_id, need().user_id);
    case 'adminDeleteSubmission': return fbAdminDeleteSubmission(params.sub_id, need().user_id);
    case 'adminCloseStory':       return fbAdminCloseStory(params.story_id, need().user_id);

    case 'checkDailyBonus': return { ok: true, bonus: await _fbCheckDailyBonus(need().user_id) };
    case 'submitBugReport':   return fbSubmitBugReport(params.content, need().user_id);
    case 'getBugReports':     return fbGetBugReports(need().user_id);
    case 'resolveBugReport':  return fbResolveBugReport(params.report_id, need().user_id);
    case 'pingWarm': return { ok: true };
    default:         return { ok: false, error: '알 수 없는 요청입니다.' };
  }
}
