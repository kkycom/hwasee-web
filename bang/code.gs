// ═══════════════════════════════════════════════════════
//  HWASEE — 협업 이야기 플랫폼
//  Google Apps Script 백엔드
// ═══════════════════════════════════════════════════════

const SS_ID    = '1nDwuxWMrU1N5yPXZQnHo3V9GJLChWjzJ1aTuwdIA9z4';
const ADMIN_ID = 'c368e38a-d894-4854-b152-d5402dc06d6e';

// ─── 유틸 ────────────────────────────────────────────

function isAdmin(user_id) { return user_id === ADMIN_ID; }

let _ss = null;
function getSheet(name) {
  if (!_ss) _ss = SpreadsheetApp.openById(SS_ID);
  return _ss.getSheetByName(name);
}

function genId() {
  return Utilities.getUuid();
}

function now() {
  return new Date().toISOString();
}

function hashPw(pw) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw);
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function _addPoints(user_id, pts, reason, sub_id) {
  if (!user_id || pts <= 0) return;
  getSheet('point_ledger').appendRow([genId(), user_id, sub_id || '', pts, reason, now()]);
  const uSheet = getSheet('users');
  const uData  = uSheet.getDataRange().getValues();
  for (let i = 1; i < uData.length; i++) {
    if (uData[i][0] === user_id) {
      const newPts = (Number(uData[i][5]) || 0) + pts;
      uSheet.getRange(i + 1, 6).setValue(newPts);
      // 어드민 배지는 덮어쓰지 않음
      if (user_id !== ADMIN_ID) uSheet.getRange(i + 1, 7).setValue(_calcBadge(newPts));
      break;
    }
  }
}

function _spendPoints(user_id, pts, reason) {
  if (!user_id || pts <= 0) return { ok: false, error: '잘못된 요청입니다.' };
  if (user_id === ADMIN_ID) return { ok: true }; // 어드민 포인트 무제한
  const uSheet = getSheet('users');
  const uData  = uSheet.getDataRange().getValues();
  for (let i = 1; i < uData.length; i++) {
    if (uData[i][0] === user_id) {
      const cur = Number(uData[i][5]) || 0;
      if (cur < pts) return { ok: false, error: `포인트가 부족합니다. (필요: ${pts}P, 보유: ${cur}P)` };
      const newPts = cur - pts;
      uSheet.getRange(i + 1, 6).setValue(newPts);
      if (user_id !== ADMIN_ID) uSheet.getRange(i + 1, 7).setValue(_calcBadge(newPts));
      getSheet('point_ledger').appendRow([genId(), user_id, '', -pts, reason, now()]);
      return { ok: true, remaining: newPts };
    }
  }
  return { ok: false, error: '유저를 찾을 수 없습니다.' };
}

// ─── 이야기 부스트 ────────────────────────────────────────

function boostStory(story_id, user_id) {
  const stories = sheetToObjects(getSheet('stories'));
  const story   = stories.find(s => s.story_id === story_id);
  if (!story)                    return { ok: false, error: '이야기를 찾을 수 없습니다.' };
  if (story.status !== 'active') return { ok: false, error: '진행 중인 이야기만 주목할 수 있습니다.' };

  const boostSheet = getSheet('boosts');
  if (boostSheet) {
    const active = sheetToObjects(boostSheet)
      .find(b => b.story_id === story_id && new Date(b.expires_at).getTime() > Date.now());
    if (active) return { ok: false, error: '이미 주목받고 있는 이야기입니다.' };
  }

  const spend = _spendPoints(user_id, 30, 'boost_story');
  if (!spend.ok) return spend;

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  getSheet('boosts').appendRow([genId(), story_id, user_id, now(), expiresAt]);
  _cacheInvalidate();
  return { ok: true };
}

// ─── 추가 제출권 ──────────────────────────────────────────

function buyExtraSubmit(episode_id, user_id) {
  const epData    = getSheet('episodes').getDataRange().getValues();
  const epHeaders = epData[0];
  let ep = null;
  for (let i = 1; i < epData.length; i++) {
    if (epData[i][0] === episode_id) {
      ep = {}; epHeaders.forEach((h, j) => ep[h] = epData[i][j]); break;
    }
  }
  if (!ep)                  return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  if (ep.status !== 'open') return { ok: false, error: '제출이 마감됐습니다.' };

  const subs = sheetToObjects(getSheet('submissions')).filter(s => s.episode_id === episode_id);
  if (!subs.some(s => s.author_id === user_id)) return { ok: false, error: '먼저 기본 제출을 해주세요.' };

  const extraSheet = getSheet('extra_submits');
  if (extraSheet && sheetToObjects(extraSheet).some(e => e.episode_id === episode_id && e.user_id === user_id)) {
    return { ok: false, error: '이미 추가 제출권을 사용하셨습니다.' };
  }

  const spend = _spendPoints(user_id, 20, 'extra_submit');
  if (!spend.ok) return spend;

  getSheet('extra_submits').appendRow([genId(), episode_id, user_id, now()]);
  return { ok: true };
}

function setAdminBadge() {
  const uSheet = getSheet('users');
  const uData  = uSheet.getDataRange().getValues();
  for (let i = 1; i < uData.length; i++) {
    if (uData[i][0] === ADMIN_ID) {
      uSheet.getRange(i + 1, 7).setValue('treeguard');
      return { ok: true, message: '나무지기 배지 적용 완료' };
    }
  }
  return { ok: false, error: '어드민 계정을 찾을 수 없습니다.' };
}

function _checkDailyBonus(user_id) {
  const today  = new Date().toISOString().slice(0, 10);
  const ledger = sheetToObjects(getSheet('point_ledger'));
  const already = ledger.some(r =>
    r.user_id === user_id && r.reason === 'daily_login' &&
    String(r.created_at).slice(0, 10) === today
  );
  if (!already) { _addPoints(user_id, 10, 'daily_login', ''); return 10; }
  return 0;
}

function jsonRes(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── 시트 초기화 ──────────────────────────────────────

function initSheets() {
  const ss = SpreadsheetApp.openById(SS_ID);
  const schema = {
    users:        ['user_id','nickname','pw_hash','token','token_exp','total_points','badge','created_at','name'],
    stories:      ['story_id','opening','max_steps','current_step','status','creator_id','created_at','batch','participant_count'],
    episodes:     ['episode_id','story_id','step','parent_sub_id','status','vote_total','created_at','closed_at','pending_at'],
    submissions:  ['sub_id','episode_id','story_id','content','author_id','derived_from','vote_count','is_adopted','created_at','is_closing'],
    votes:        ['vote_id','episode_id','sub_id','voter_id','created_at'],
    point_ledger: ['ledger_id','user_id','sub_id','points','reason','created_at'],
    settings:     ['key','value'],
    comments:     ['comment_id','sub_id','story_id','author_id','content','created_at'],
    bookmarks:    ['bookmark_id','user_id','story_id','created_at'],
    reports:      ['report_id','sub_id','story_id','reporter_id','reason','created_at'],
    notifications: ['notif_id','user_id','type','story_id','message','is_read','created_at'],
    story_mvp:    ['mvp_id','story_id','voter_id','nominated_user_id','created_at'],
    boosts:       ['boost_id','story_id','user_id','created_at','expires_at'],
    extra_submits:['extra_id','episode_id','user_id','created_at'],
    story_likes:  ['like_id','story_id','user_id','created_at'],
  };

  for (const [name, headers] of Object.entries(schema)) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    }
  }
  return { ok: true, message: '시트 초기화 완료' };
}

// ─── 설정 ─────────────────────────────────────────────

function getSetting(key) {
  const sheet = getSheet('settings');
  if (!sheet) return null;
  const rows = sheetToObjects(sheet);
  const row = rows.find(r => r.key === key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  const sheet = getSheet('settings');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

// ─── 캐시 ─────────────────────────────────────────────
function _cacheGet(key) {
  try { const v = CacheService.getScriptCache().get(key); return v ? JSON.parse(v) : null; } catch(e) { return null; }
}
function _cacheSet(key, data, ttlSec) {
  try { CacheService.getScriptCache().put(key, JSON.stringify(data), ttlSec || 60); } catch(e) {}
}
function _cacheInvalidate() {
  try { CacheService.getScriptCache().removeAll(['stories_p1', 'stories_p2', 'lb']); } catch(e) {}
}

// ─── 씨앗 이야기 ──────────────────────────────────────

function _seedBatch(count) {
  const used = sheetToObjects(getSheet('stories')).map(s => s.opening);
  const pool = AI_OPENINGS.filter(o => !used.includes(o));
  const src  = pool.length >= count ? pool : AI_OPENINGS.slice();

  const picked = [];
  while (picked.length < count && src.length > 0) {
    const idx = Math.floor(Math.random() * src.length);
    picked.push(src.splice(idx, 1)[0]);
  }

  picked.forEach(opening => {
    const story_id = genId();
    getSheet('stories').appendRow([story_id, opening, 10, 0, 'active', 'SYSTEM', now(), '']);
    _createEpisode(story_id, 1, '');
  });
}

function seedInitialStories() {
  const existing = sheetToObjects(getSheet('stories')).filter(s => s.creator_id === 'SYSTEM');
  if (existing.length > 0) return { ok: false, error: '이미 초기 이야기가 있습니다.' };
  _seedBatch(5);
  return { ok: true, message: '초기 이야기 5개 생성 완료' };
}

// ─── 인증 ─────────────────────────────────────────────

function register(nickname, password, name) {
  if (!nickname || !password) return { ok: false, error: '닉네임과 비밀번호를 입력해주세요.' };
  if (nickname.length < 2 || nickname.length > 12) return { ok: false, error: '닉네임은 2~12자입니다.' };
  if (password.length < 4) return { ok: false, error: '비밀번호는 4자 이상입니다.' };
  const nameVal = (name || '').trim();
  if (nameVal && (nameVal.length < 2 || nameVal.length > 20)) return { ok: false, error: '이름은 2~20자입니다.' };

  const sheet = getSheet('users');
  const rows  = sheetToObjects(sheet);
  if (rows.some(r => r.nickname === nickname)) return { ok: false, error: '이미 사용 중인 닉네임입니다.' };

  const user_id   = genId();
  const token     = genId();
  const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  sheet.appendRow([user_id, nickname, hashPw(password), token, token_exp, 0, 'seed', now(), nameVal]);
  return { ok: true, token, user_id, nickname, total_points: 0, badge: 'seed', is_admin: user_id === ADMIN_ID };
}

function addUserNameColumn() {
  const sheet   = getSheet('users');
  const headers = sheet.getDataRange().getValues()[0];
  if (!headers.includes('name')) {
    sheet.getRange(1, headers.length + 1).setValue('name');
    return { ok: true, message: 'name 컬럼 추가 완료' };
  }
  return { ok: true, message: 'name 컬럼 이미 존재' };
}

function findAccount(name) {
  const nameVal = (name || '').trim();
  if (nameVal.length < 2) return { ok: false, error: '이름을 2자 이상 입력해주세요.' };
  const rows = sheetToObjects(getSheet('users'));
  const matches = rows.filter(r => String(r.name || '').trim() === nameVal);
  if (!matches.length) return { ok: false, error: '해당 이름으로 가입된 계정이 없습니다.' };
  const accounts = matches.map(r => {
    const nick = r.nickname || '';
    const masked = nick.length > 1 ? nick[0] + '*'.repeat(nick.length - 1) : nick;
    return { masked_nickname: masked };
  });
  return { ok: true, accounts };
}

function resetPassword(nickname, name, new_password) {
  if (!nickname || !name || !new_password) return { ok: false, error: '모든 항목을 입력해주세요.' };
  if (new_password.length < 6) return { ok: false, error: '비밀번호는 6자 이상이어야 합니다.' };
  const sheet = getSheet('users');
  const data  = sheet.getDataRange().getValues();
  const headers = data[0];
  const nameIdx = headers.indexOf('name');
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === nickname) {
      const storedName = nameIdx >= 0 ? String(data[i][nameIdx] || '').trim() : '';
      if (!storedName) return { ok: false, error: '이름 정보가 없는 계정입니다.' };
      if (storedName !== name.trim()) return { ok: false, error: '닉네임 또는 이름이 일치하지 않습니다.' };
      sheet.getRange(i + 1, 3).setValue(hashPw(new_password));
      return { ok: true };
    }
  }
  return { ok: false, error: '닉네임 또는 이름이 일치하지 않습니다.' };
}

function deleteAccount(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  if (user_id === ADMIN_ID) return { ok: false, error: '관리자 계정은 탈퇴할 수 없습니다.' };

  // users 시트에서 행 삭제
  const uSheet = getSheet('users');
  const uData  = uSheet.getDataRange().getValues();
  for (let i = 1; i < uData.length; i++) {
    if (uData[i][0] === user_id) { uSheet.deleteRow(i + 1); break; }
  }

  // 북마크 삭제
  try {
    const bmSheet = getSheet('bookmarks');
    if (bmSheet) {
      const bmData = bmSheet.getDataRange().getValues();
      for (let i = bmData.length - 1; i >= 1; i--) {
        if (bmData[i][1] === user_id) bmSheet.deleteRow(i + 1);
      }
    }
  } catch(e) {}

  // 알림 삭제
  try {
    const nSheet = getSheet('notifications');
    if (nSheet) {
      const nData = nSheet.getDataRange().getValues();
      for (let i = nData.length - 1; i >= 1; i--) {
        if (nData[i][1] === user_id) nSheet.deleteRow(i + 1);
      }
    }
  } catch(e) {}

  _cacheInvalidate();
  return { ok: true };
}

function login(nickname, password) {
  if (!nickname || !password) return { ok: false, error: '닉네임과 비밀번호를 입력해주세요.' };

  const sheet   = getSheet('users');
  const data    = sheet.getDataRange().getValues();
  const pw_hash = hashPw(password);

  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === nickname && data[i][2] === pw_hash) {
      const token     = genId();
      const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      sheet.getRange(i + 1, 4).setValue(token);
      sheet.getRange(i + 1, 5).setValue(token_exp);
      const daily_bonus = _checkDailyBonus(data[i][0]);
      const adoption_count = sheetToObjects(getSheet('submissions'))
        .filter(s => s.author_id === data[i][0] && (s.is_adopted === true || s.is_adopted === 'TRUE'))
        .length;
      return { ok: true, token, user_id: data[i][0], nickname: data[i][1], total_points: data[i][5], badge: data[i][6], is_admin: data[i][0] === ADMIN_ID, daily_bonus, adoption_count };
    }
  }
  return { ok: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };
}

function getSession(token) {
  if (!token) return null;
  const data = getSheet('users').getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][3] === token && new Date(data[i][4]) > new Date()) {
      return { user_id: data[i][0], nickname: data[i][1], total_points: data[i][5], badge: data[i][6] };
    }
  }
  return null;
}

// ─── 스토리 ───────────────────────────────────────────

function getStories(page) {
  const p    = Number(page) || 1;
  const cKey = 'stories_p' + p;
  const cached = _cacheGet(cKey);
  if (cached) return cached;

  if (p === 1) {
    try { closeInactiveStories(); } catch(e) {}
  }

  const allEpisodes = sheetToObjects(getSheet('episodes'));
  const pendingStoryIds = new Set(
    allEpisodes.filter(e => e.status === 'pending').map(e => e.story_id)
  );

  const openVoteMap = {};
  allEpisodes.forEach(e => {
    if (e.status === 'open' || e.status === 'pending') {
      const cur = openVoteMap[e.story_id] || 0;
      if ((Number(e.vote_total) || 0) > cur) {
        openVoteMap[e.story_id] = Number(e.vote_total) || 0;
      }
    }
  });

  const allSubs     = sheetToObjects(getSheet('submissions'));
  const commSheet   = getSheet('comments');
  const allComments = commSheet ? sheetToObjects(commSheet).filter(c => !c.sub_id || c.sub_id === '') : [];

  const subCountMap  = {};
  const voteCountMap = {};
  allSubs.forEach(sub => {
    subCountMap[sub.story_id]  = (subCountMap[sub.story_id]  || 0) + 1;
    voteCountMap[sub.story_id] = (voteCountMap[sub.story_id] || 0) + (Number(sub.vote_count) || 0);
  });
  const commentCountMap = {};
  allComments.forEach(c => {
    commentCountMap[c.story_id] = (commentCountMap[c.story_id] || 0) + 1;
  });

  // 활성 부스트 목록
  const boostSet = new Set();
  try {
    const boostSheet = getSheet('boosts');
    if (boostSheet) {
      const now_ms = Date.now();
      sheetToObjects(boostSheet)
        .filter(b => new Date(b.expires_at).getTime() > now_ms)
        .forEach(b => boostSet.add(b.story_id));
    }
  } catch(e) {}

  const rows = sheetToObjects(getSheet('stories'));
  let filtered;

  if (p === 1) {
    filtered = rows.filter(s => s.status === 'active');
    filtered.forEach(s => {
      s.has_pending    = pendingStoryIds.has(s.story_id);
      s.is_boosted     = boostSet.has(s.story_id);
      s.activity_count = (subCountMap[s.story_id] || 0)
                       + (voteCountMap[s.story_id] || 0)
                       + (commentCountMap[s.story_id] || 0);
    });
    filtered.sort((a, b) => {
      if (a.is_boosted  !== b.is_boosted)  return a.is_boosted  ? -1 : 1;
      if (a.has_pending !== b.has_pending) return a.has_pending ? -1 : 1;
      const vDiff = (openVoteMap[b.story_id] || 0) - (openVoteMap[a.story_id] || 0);
      if (vDiff !== 0) return vDiff;
      const aDiff = (b.activity_count || 0) - (a.activity_count || 0);
      if (aDiff !== 0) return aDiff;
      return new Date(a.created_at) - new Date(b.created_at);
    });
  } else {
    const likeCountMap = {};
    try {
      const likeSheet = getSheet('story_likes');
      if (likeSheet) sheetToObjects(likeSheet)
        .forEach(r => { likeCountMap[r.story_id] = (likeCountMap[r.story_id] || 0) + 1; });
    } catch(e) {}

    filtered = rows
      .filter(s => s.status === 'completed' || s.status === 'inactive')
      .map(s => ({ ...s, like_count: likeCountMap[s.story_id] || 0 }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  const result = { ok: true, stories: filtered, page: p };
  _cacheSet(cKey, result, p === 1 ? 120 : 600);
  return result;
}

function closeInactiveStories() {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const episodes = sheetToObjects(getSheet('episodes'));
  const stSheet  = getSheet('stories');
  const stData   = stSheet.getDataRange().getValues();

  for (let i = 1; i < stData.length; i++) {
    if (stData[i][4] !== 'active') continue;
    const story_id = stData[i][0];
    const openEps  = episodes.filter(e => e.story_id === story_id && (e.status === 'open' || e.status === 'pending'));
    if (!openEps.length) continue;

    // 열린 에피소드가 있는데 14일간 투표가 0이면 비활성 처리
    const allStale = openEps.every(e =>
      new Date(e.created_at) < cutoff && (Number(e.vote_total) || 0) === 0
    );
    if (allStale) stSheet.getRange(i + 1, 5).setValue('inactive');
  }
}

function getStory(story_id, user_id) {
  // pending 에피소드 중 30분 경과분 자동 마감
  try { _checkPendingEpisodes(story_id); } catch(e) {}

  const story = sheetToObjects(getSheet('stories')).find(s => s.story_id === story_id);
  if (!story) return { ok: false, error: '스토리를 찾을 수 없습니다.' };

  const nickMap = {};
  const badgeMap = {};
  sheetToObjects(getSheet('users')).forEach(u => { nickMap[u.user_id] = u.nickname; badgeMap[u.user_id] = u.badge; });

  const episodes    = sheetToObjects(getSheet('episodes')).filter(e => e.story_id === story_id);
  const submissions = sheetToObjects(getSheet('submissions'))
    .filter(s => s.story_id === story_id)
    .map(s => ({ ...s, author_nickname: nickMap[s.author_id] || '익명', author_badge: badgeMap[s.author_id] || 'seed' }));

  let is_bookmarked = false;
  if (user_id) {
    const bmSheet = getSheet('bookmarks');
    if (bmSheet) is_bookmarked = sheetToObjects(bmSheet).some(b => b.user_id === user_id && b.story_id === story_id);
  }

  let is_liked = false;
  let like_count = 0;
  try {
    const likeSheet = getSheet('story_likes');
    if (likeSheet) {
      const likes = sheetToObjects(likeSheet).filter(r => r.story_id === story_id);
      like_count = likes.length;
      if (user_id) is_liked = likes.some(r => r.user_id === user_id);
    }
  } catch(e) {}

  let my_voted_sub_ids = [];
  if (user_id) {
    const openEp = episodes.find(e => e.status === 'open' || e.status === 'pending');
    if (openEp) {
      my_voted_sub_ids = sheetToObjects(getSheet('votes'))
        .filter(v => v.episode_id === openEp.episode_id && v.voter_id === user_id)
        .map(v => v.sub_id);
    }
  }

  return { ok: true, story, episodes, submissions, is_bookmarked, is_liked, like_count, my_voted_sub_ids };
}

function getComments(sub_id) {
  const sheet = getSheet('comments');
  if (!sheet) return { ok: true, comments: [] };
  const nickMap = {};
  sheetToObjects(getSheet('users')).forEach(u => { nickMap[u.user_id] = u.nickname; });
  const comments = sheetToObjects(sheet)
    .filter(c => c.sub_id === sub_id)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(c => ({ ...c, author_nickname: nickMap[c.author_id] || '익명' }));
  return { ok: true, comments };
}

function addComment(sub_id, content, author_id) {
  const text = (content || '').trim();
  if (!text)             return { ok: false, error: '댓글 내용을 입력해주세요.' };
  if (text.length > 100) return { ok: false, error: '100자 이내로 작성해주세요.' };

  const sub = sheetToObjects(getSheet('submissions')).find(s => s.sub_id === sub_id);
  if (!sub) return { ok: false, error: '제출을 찾을 수 없습니다.' };

  const sheet = getSheet('comments');
  if (!sheet) return { ok: false, error: 'comments 시트가 없습니다. initSheets를 실행해주세요.' };

  getSheet('comments').appendRow([genId(), sub_id, sub.story_id, author_id, text, now()]);
  return { ok: true };
}

function createStory(opening, creator_id) {
  if (!opening || opening.trim().length === 0) return { ok: false, error: '시작 문장을 입력해주세요.' };

  const story_id = genId();
  getSheet('stories').appendRow([story_id, opening.trim(), 10, 0, 'active', creator_id, now(), '']);

  const ep = _createEpisode(story_id, 1, '');
  _cacheInvalidate();
  return { ok: true, story_id, episode_id: ep.episode_id };
}

function getMyStories(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };

  const allSubs  = sheetToObjects(getSheet('submissions'));
  const mySubs   = allSubs.filter(s => s.author_id === user_id);
  const votes    = sheetToObjects(getSheet('votes')).filter(v => v.voter_id === user_id);

  const epIds    = new Set([...mySubs.map(s => s.episode_id), ...votes.map(v => v.episode_id)]);
  const episodes = sheetToObjects(getSheet('episodes'));
  const storyIds = new Set(episodes.filter(e => epIds.has(e.episode_id)).map(e => e.story_id));

  const commSheet   = getSheet('comments');
  const allComments = commSheet ? sheetToObjects(commSheet).filter(c => !c.sub_id || c.sub_id === '') : [];

  const subCountMap  = {};
  const voteCountMap = {};
  allSubs.forEach(sub => {
    subCountMap[sub.story_id]  = (subCountMap[sub.story_id]  || 0) + 1;
    voteCountMap[sub.story_id] = (voteCountMap[sub.story_id] || 0) + (Number(sub.vote_count) || 0);
  });
  const commentCountMap = {};
  allComments.forEach(c => {
    commentCountMap[c.story_id] = (commentCountMap[c.story_id] || 0) + 1;
  });

  // 현재 진행 중인 에피소드 맵 및 유저 투표 여부
  const openEpMap = {};
  episodes.filter(e => e.status === 'open' || e.status === 'pending')
    .forEach(e => { openEpMap[e.story_id] = e.episode_id; });
  const myVotedEpIds = new Set(votes.map(v => v.episode_id));

  const stories = sheetToObjects(getSheet('stories'))
    .filter(s => storyIds.has(s.story_id) && s.status !== 'deleted')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const pendingStoryIds = new Set(episodes.filter(e => e.status === 'pending').map(e => e.story_id));

  const pendingExpiresMap = {};
  episodes.filter(e => e.status === 'pending' && e.pending_at).forEach(e => {
    const exp = new Date(new Date(e.pending_at).getTime() + PENDING_MINUTES * 60000);
    pendingExpiresMap[e.story_id] = exp.toISOString();
  });

  const storiesWithActivity = stories.map(s => {
    const openEpId = openEpMap[s.story_id];
    return {
      ...s,
      mySubmissions:      mySubs.filter(sub => sub.story_id === s.story_id),
      activity_count:     (subCountMap[s.story_id]  || 0)
                        + (voteCountMap[s.story_id] || 0)
                        + (commentCountMap[s.story_id] || 0),
      has_pending:        pendingStoryIds.has(s.story_id),
      pending_expires_at: pendingExpiresMap[s.story_id] || null,
      has_voted_current:  openEpId != null ? myVotedEpIds.has(openEpId) : null,
    };
  });

  return { ok: true, stories: storiesWithActivity };
}

// ─── 에피소드 ─────────────────────────────────────────

function _createEpisode(story_id, step, parent_sub_id) {
  const episode_id = genId();
  getSheet('episodes').appendRow([episode_id, story_id, step, parent_sub_id, 'open', 0, now(), '', '']);
  return { episode_id };
}

function getEpisode(episode_id) {
  // 시트는 각 1회만 읽어 재사용
  const allEps  = sheetToObjects(getSheet('episodes'));
  const ep = allEps.find(e => e.episode_id === episode_id);
  if (!ep) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };

  const allSubs = sheetToObjects(getSheet('submissions'));
  ep.submissions = allSubs.filter(s => s.episode_id === episode_id);

  const story      = sheetToObjects(getSheet('stories')).find(s => s.story_id === ep.story_id) || null;
  const storySubs  = allSubs.filter(s => s.story_id === ep.story_id);
  const storyEps   = allEps.filter(e => e.story_id === ep.story_id);

  const prevChain = [];
  let parentSubId = ep.parent_sub_id;
  while (parentSubId) {
    const sub = storySubs.find(s => s.sub_id === parentSubId);
    if (!sub) break;
    const parentEp = storyEps.find(e => e.episode_id === sub.episode_id);
    prevChain.unshift({ step: Number(parentEp ? parentEp.step : 0), content: sub.content });
    parentSubId = parentEp ? parentEp.parent_sub_id : null;
  }

  return { ok: true, episode: ep, story, prevChain };
}

// ─── 제출 ─────────────────────────────────────────────

function createSubmission(episode_id, content, author_id, derived_from, closing) {
  const text = (content || '').trim();
  if (!text)            return { ok: false, error: '내용을 입력해주세요.' };
  if (text.length > 50) return { ok: false, error: '50자 이내로 작성해주세요.' };

  const epData    = getSheet('episodes').getDataRange().getValues();
  const epHeaders = epData[0];
  let ep = null; let epRow = -1;
  for (let i = 1; i < epData.length; i++) {
    if (epData[i][0] === episode_id) {
      ep = {}; epHeaders.forEach((h, j) => ep[h] = epData[i][j]); epRow = i + 1; break;
    }
  }
  if (!ep)                  return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  if (ep.status !== 'open') return { ok: false, error: '제출이 마감됐습니다.' };

  const subs = sheetToObjects(getSheet('submissions')).filter(s => s.episode_id === episode_id);
  if (subs.some(s => s.author_id === author_id)) {
    const extraSheet = getSheet('extra_submits');
    const hasExtra   = extraSheet && sheetToObjects(extraSheet)
      .some(e => e.episode_id === episode_id && e.user_id === author_id);
    if (!hasExtra) return { ok: false, error: '이미 제출하셨습니다.' };
  }

  const sub_id    = genId();
  const is_closing = closing === true && Number(ep.step) >= 6;
  getSheet('submissions').appendRow([sub_id, episode_id, ep.story_id, text, author_id, derived_from || '', 0, false, now(), is_closing]);
  _addPoints(author_id, 5, 'submit', sub_id);
  _cacheInvalidate();

  // 이 이야기에 처음 제출하는 경우 participant_count 증가
  const storySubs = sheetToObjects(getSheet('submissions')).filter(s => s.story_id === ep.story_id && s.author_id === author_id);
  if (storySubs.length <= 1) {
    const stSheet = getSheet('stories');
    const stData  = stSheet.getDataRange().getValues();
    for (let i = 1; i < stData.length; i++) {
      if (stData[i][0] === ep.story_id) {
        stSheet.getRange(i + 1, 9).setValue((Number(stData[i][8]) || 0) + 1);
        break;
      }
    }
  }

  return { ok: true, sub_id };
}

// ─── 투표 ─────────────────────────────────────────────

const VOTE_THRESHOLD  = 2;
const PENDING_MINUTES = 15;

function vote(episode_id, sub_ids, voter_id) {
  if (!Array.isArray(sub_ids) || sub_ids.length < 1 || sub_ids.length > 2) {
    return { ok: false, error: '1개 또는 2개를 선택해주세요.' };
  }

  const epSheet   = getSheet('episodes');
  const epData    = epSheet.getDataRange().getValues();
  const epHeaders = epData[0];
  let ep = null; let epRow = -1;
  for (let i = 1; i < epData.length; i++) {
    if (epData[i][0] === episode_id) {
      ep = {}; epHeaders.forEach((h, j) => ep[h] = epData[i][j]); epRow = i + 1; break;
    }
  }
  if (!ep) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  if (ep.status !== 'open' && ep.status !== 'pending') return { ok: false, error: '투표가 마감됐습니다.' };

  const votes = sheetToObjects(getSheet('votes'));
  if (votes.some(v => v.episode_id === episode_id && v.voter_id === voter_id)) {
    return { ok: false, error: '이미 투표하셨습니다.' };
  }

  const subs    = sheetToObjects(getSheet('submissions')).filter(s => s.episode_id === episode_id);
  const mySubId = (subs.find(s => s.author_id === voter_id) || {}).sub_id;
  if (mySubId && sub_ids.includes(mySubId)) {
    return { ok: false, error: '본인 제출에는 투표할 수 없습니다.' };
  }

  const vSheet = getSheet('votes');
  sub_ids.forEach(sid => vSheet.appendRow([genId(), episode_id, sid, voter_id, now()]));
  _addPoints(voter_id, 1, 'vote', '');

  const subSheet = getSheet('submissions');
  const subData  = subSheet.getDataRange().getValues();
  for (let i = 1; i < subData.length; i++) {
    if (sub_ids.includes(subData[i][0])) {
      subSheet.getRange(i + 1, 7).setValue((Number(subData[i][6]) || 0) + 1);
    }
  }

  const newTotal = (Number(ep.vote_total) || 0) + 1;
  epSheet.getRange(epRow, 6).setValue(newTotal);

  // 제출물 중 최고 득표수 계산 (방금 업데이트된 값 반영)
  const updatedSubData = subSheet.getDataRange().getValues();
  const maxSubVotes = updatedSubData.slice(1)
    .filter(row => row[1] === episode_id)
    .reduce((max, row) => Math.max(max, Number(row[6]) || 0), 0);

  const pendingAtCol = epHeaders.indexOf('pending_at') + 1;
  const statusCol    = epHeaders.indexOf('status') + 1;

  if (maxSubVotes >= VOTE_THRESHOLD && ep.status === 'open') {
    // 한 문장이 기준 득표 달성 → pending 전환 (15분 대기 시작)
    epSheet.getRange(epRow, statusCol).setValue('pending');
    epSheet.getRange(epRow, pendingAtCol).setValue(now());
  } else if (ep.status === 'pending') {
    const base = ep.pending_at || new Date(0).toISOString();
    const elapsed = (new Date() - new Date(base)) / 60000;
    if (elapsed >= PENDING_MINUTES) {
      _closeEpisode(episode_id, ep);
    }
  }

  _cacheInvalidate();
  return { ok: true, total_voters: newTotal, max_votes: maxSubVotes, is_pending: maxSubVotes >= VOTE_THRESHOLD || ep.status === 'pending' };
}

// ─── 에피소드 마감 & 포인트 ───────────────────────────

function _checkPendingEpisodes(story_id) {
  const episodes = sheetToObjects(getSheet('episodes'))
    .filter(e => e.story_id === story_id && e.status === 'pending');
  episodes.forEach(ep => {
    const base = ep.pending_at || new Date(0).toISOString();
    const elapsed = (new Date() - new Date(base)) / 60000;
    if (elapsed >= PENDING_MINUTES) _closeEpisode(ep.episode_id, ep);
  });
}

function _createNotifications(user_ids, story_id, message) {
  const nSheet = getSheet('notifications');
  if (!nSheet) return;
  const unique = [...new Set(user_ids)].filter(Boolean);
  unique.forEach(uid => nSheet.appendRow([genId(), uid, 'story_advance', story_id, message, 'false', now()]));
}

function _closeEpisode(episode_id, ep) {
  if (!ep) {
    ep = sheetToObjects(getSheet('episodes')).find(e => e.episode_id === episode_id);
    if (!ep) return;
  }

  const epSheet = getSheet('episodes');
  const epData  = epSheet.getDataRange().getValues();
  for (let i = 1; i < epData.length; i++) {
    if (epData[i][0] === episode_id) {
      epSheet.getRange(i + 1, 5).setValue('closed');
      epSheet.getRange(i + 1, 8).setValue(now());
      break;
    }
  }

  const subSheet   = getSheet('submissions');
  const subData    = subSheet.getDataRange().getValues();
  const subHeaders = subData[0];
  const allSubs    = [];
  for (let i = 1; i < subData.length; i++) {
    if (subData[i][1] === episode_id) {
      const s = {}; subHeaders.forEach((h, j) => s[h] = subData[i][j]); s._row = i + 1;
      allSubs.push(s);
    }
  }
  if (!allSubs.length) return;

  const maxVotes = Math.max(...allSubs.map(s => Number(s.vote_count) || 0));
  if (maxVotes === 0) return;

  // 동률이면 여러 명 → 분기 생성
  const winners = allSubs.filter(s => (Number(s.vote_count) || 0) === maxVotes);

  winners.forEach(w => {
    subSheet.getRange(w._row, 8).setValue(true);
    _distributePoints(w, allSubs);
  });

  const stSheet = getSheet('stories');
  const stData  = stSheet.getDataRange().getValues();
  for (let i = 1; i < stData.length; i++) {
    if (stData[i][0] === ep.story_id) {
      const nextStep   = (Number(stData[i][3]) || 0) + 1;
      const maxSteps   = Number(stData[i][2]) || 10;
      const anyClosing = winners.some(w => w.is_closing === true || w.is_closing === 'TRUE');
      stSheet.getRange(i + 1, 4).setValue(nextStep);
      if (nextStep >= maxSteps || anyClosing) {
        stSheet.getRange(i + 1, 5).setValue('completed');
        // 완결 알림
        const opening   = stData[i][1] || '';
        const snippet   = opening.length > 25 ? opening.slice(0, 25) + '…' : opening;
        const notifyIds = _getStoryParticipants(ep.story_id);
        _createNotifications(notifyIds, ep.story_id, `"${snippet}" 이야기가 완결됐어요!`);
      } else {
        // 각 winner마다 새 에피소드 → 분기 발생 시 여러 에피소드 생성
        winners.forEach(w => _createEpisode(ep.story_id, nextStep + 1, w.sub_id));
        // 이야기 진행 알림
        const opening   = stData[i][1] || '';
        const snippet   = opening.length > 25 ? opening.slice(0, 25) + '…' : opening;
        const isBranch  = winners.length > 1;
        const advanceMsg = isBranch
          ? `"${snippet}" 이야기가 ${nextStep}단계에서 ${winners.length}개 갈림길로 나뉘었어요!`
          : `"${snippet}" 이야기가 ${nextStep}단계로 이어졌어요!`;
        const winnerAuthorIds = new Set(winners.map(w => w.author_id).filter(Boolean));
        // 채택된 문장 작성자에게 별도 알림
        winnerAuthorIds.forEach(uid => {
          _createNotifications([uid], ep.story_id, `"${snippet}" 이야기에서 내 문장이 채택됐어요!`);
        });
        // 나머지 참여자에게 진행 알림
        const allParticipants = _getStoryParticipants(ep.story_id);
        const otherIds = allParticipants.filter(id => !winnerAuthorIds.has(id));
        _createNotifications(otherIds, ep.story_id, advanceMsg);
      }
      break;
    }
  }
}

function _getStoryParticipants(story_id) {
  const epIds = new Set(
    sheetToObjects(getSheet('episodes'))
      .filter(e => e.story_id === story_id)
      .map(e => e.episode_id)
  );
  const submitters = sheetToObjects(getSheet('submissions'))
    .filter(s => s.story_id === story_id).map(s => s.author_id);
  const voters = sheetToObjects(getSheet('votes'))
    .filter(v => epIds.has(v.episode_id)).map(v => v.voter_id);
  const bookmarkers = sheetToObjects(getSheet('bookmarks'))
    .filter(b => b.story_id === story_id).map(b => b.user_id);
  const commSheet = getSheet('comments');
  const commenters = commSheet
    ? sheetToObjects(commSheet).filter(c => c.story_id === story_id).map(c => c.author_id)
    : [];
  return [...new Set([...submitters, ...voters, ...bookmarkers, ...commenters])];
}

function _distributePoints(winner, allSubs) {
  const parent = allSubs.find(s => s.sub_id === winner.derived_from);
  if (!parent) {
    _addPoints(winner.author_id, 20, 'direct', winner.sub_id);
  } else {
    const grandParent = allSubs.find(s => s.sub_id === parent.derived_from);
    if (!grandParent) {
      _addPoints(parent.author_id, 10, 'source',  winner.sub_id);
      _addPoints(winner.author_id, 10, 'derived', winner.sub_id);
    } else {
      _addPoints(grandParent.author_id, 10, 'source',  winner.sub_id);
      _addPoints(parent.author_id,       5, 'mid',     winner.sub_id);
      _addPoints(winner.author_id,       5, 'derived', winner.sub_id);
    }
  }
}

function _calcBadge(pts) {
  if (pts >= 5000) return 'fruit';
  if (pts >= 3000) return 'flower';
  if (pts >= 2000) return 'bud';
  if (pts >= 1200) return 'leaf1';
  if (pts >= 700)  return 'leaf';
  if (pts >= 350)  return 'sprout1';
  if (pts >= 150)  return 'sprout';
  if (pts >= 60)   return 'seed2';
  if (pts >= 20)   return 'seed1';
  return 'seed';
}

// ─── 프로필 ───────────────────────────────────────────

function getProfile(user_id) {
  const uData = getSheet('users').getDataRange().getValues();
  for (let i = 1; i < uData.length; i++) {
    if (uData[i][0] === user_id) {
      const history = sheetToObjects(getSheet('point_ledger'))
        .filter(r => r.user_id === user_id)
        .reverse()
        .slice(0, 20);

      const allEps = sheetToObjects(getSheet('episodes'));
      const epMap = {};
      allEps.forEach(e => { epMap[e.episode_id] = e; });
      const storiesArr = sheetToObjects(getSheet('stories'));
      const storyMap = {};
      storiesArr.forEach(s => { storyMap[s.story_id] = s.opening; });

      const adoptions = sheetToObjects(getSheet('submissions'))
        .filter(s => s.author_id === user_id && (s.is_adopted === true || s.is_adopted === 'TRUE'))
        .map(s => ({
          sub_id: s.sub_id,
          content: s.content,
          vote_count: s.vote_count,
          story_id: s.story_id,
          story_opening: storyMap[s.story_id] || '',
          step: epMap[s.episode_id] ? Number(epMap[s.episode_id].step) : 0,
          created_at: s.created_at,
        }))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      return {
        ok: true,
        user: { user_id: uData[i][0], nickname: uData[i][1], total_points: uData[i][5], badge: uData[i][6], created_at: uData[i][7] },
        history,
        adoptions,
      };
    }
  }
  return { ok: false, error: '사용자를 찾을 수 없습니다.' };
}

// ─── 씨앗 문장 목록 ───────────────────────────────────

const AI_OPENINGS = [
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

function getSeeds() {
  const used = new Set(sheetToObjects(getSheet('stories')).map(s => String(s.opening)));
  const available = AI_OPENINGS.filter(o => !used.has(o));
  const src = available.length >= 5 ? available.slice() : AI_OPENINGS.slice();
  const picked = [];
  while (picked.length < Math.min(5, src.length)) {
    const idx = Math.floor(Math.random() * src.length);
    picked.push(src.splice(idx, 1)[0]);
  }
  return { ok: true, seeds: picked, exhausted: available.length === 0 };
}

function getAISuggestion() {
  const idx = Math.floor(Math.random() * AI_OPENINGS.length);
  return { ok: true, opening: AI_OPENINGS[idx] };
}

// ─── 책갈피 ───────────────────────────────────────────

function addBookmark(story_id, user_id) {
  if (!story_id || !user_id) return { ok: false, error: '잘못된 요청입니다.' };
  const sheet = getSheet('bookmarks');
  if (!sheet) return { ok: false, error: 'bookmarks 시트가 없습니다. initSheets를 실행해주세요.' };
  if (sheetToObjects(sheet).some(b => b.user_id === user_id && b.story_id === story_id)) {
    return { ok: false, already: true };
  }
  sheet.appendRow([genId(), user_id, story_id, now()]);
  return { ok: true };
}

function removeBookmark(story_id, user_id) {
  if (!story_id || !user_id) return { ok: false, error: '잘못된 요청입니다.' };
  const sheet = getSheet('bookmarks');
  if (!sheet) return { ok: false, error: 'bookmarks 시트가 없습니다.' };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === user_id && data[i][2] === story_id) {
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: '책갈피를 찾을 수 없습니다.' };
}

function getBookmarks(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  const sheet = getSheet('bookmarks');
  if (!sheet) return { ok: true, stories: [] };
  const bmarks   = sheetToObjects(sheet).filter(b => b.user_id === user_id);
  const storyIds = new Set(bmarks.map(b => b.story_id));
  const stories  = sheetToObjects(getSheet('stories')).filter(s => storyIds.has(s.story_id));
  return { ok: true, stories };
}

// ─── 랭킹 ────────────────────────────────────────────

function getLeaderboard() {
  const cached = _cacheGet('lb');
  if (cached) return cached;

  const users = sheetToObjects(getSheet('users'));
  const subs  = sheetToObjects(getSheet('submissions'));
  const votes = sheetToObjects(getSheet('votes'));

  const userMap = {};
  users.forEach(u => { userMap[u.user_id] = { nickname: u.nickname, badge: u.badge }; });

  // 포인트 랭킹
  const pointsRank = [...users]
    .filter(u => Number(u.total_points) > 0 && u.user_id !== ADMIN_ID)
    .sort((a, b) => Number(b.total_points) - Number(a.total_points))
    .slice(0, 10)
    .map(u => ({ nickname: u.nickname, badge: u.badge, value: Number(u.total_points) }));

  // 채택 랭킹
  const adoptMap = {};
  subs.filter(s => (s.is_adopted === true || s.is_adopted === 'TRUE') && s.author_id !== ADMIN_ID)
    .forEach(s => { adoptMap[s.author_id] = (adoptMap[s.author_id] || 0) + 1; });
  const adoptionsRank = Object.entries(adoptMap)
    .sort(([,a],[,b]) => b - a).slice(0, 10)
    .map(([uid, cnt]) => {
      const u = userMap[uid] || {};
      return { nickname: u.nickname || '?', badge: u.badge || 'seed', value: cnt };
    });

  // 참여 랭킹 (제출 수 + 투표 참여 에피소드 수)
  const partMap = {};
  subs.filter(s => s.author_id !== ADMIN_ID)
    .forEach(s => { partMap[s.author_id] = (partMap[s.author_id] || 0) + 1; });
  const votedEps = {};
  votes.filter(v => v.voter_id !== ADMIN_ID).forEach(v => {
    if (!votedEps[v.voter_id]) votedEps[v.voter_id] = new Set();
    votedEps[v.voter_id].add(v.episode_id);
  });
  Object.entries(votedEps).forEach(([uid, eps]) => {
    partMap[uid] = (partMap[uid] || 0) + eps.size;
  });
  const partRank = Object.entries(partMap)
    .sort(([,a],[,b]) => b - a).slice(0, 10)
    .map(([uid, cnt]) => {
      const u = userMap[uid] || {};
      return { nickname: u.nickname || '?', badge: u.badge || 'seed', value: cnt };
    });

  const result = { ok: true, points: pointsRank, adoptions: adoptionsRank, participations: partRank };
  _cacheSet('lb', result, 300);
  return result;
}

// ─── 알림 ────────────────────────────────────────────

function getNotifications(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  const sheet = getSheet('notifications');
  if (!sheet) return { ok: true, notifications: [], unread_count: 0 };
  const all = sheetToObjects(sheet)
    .filter(n => n.user_id === user_id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 30);
  const unread_count = all.filter(n => n.is_read === 'false' || n.is_read === false).length;
  return { ok: true, notifications: all, unread_count };
}

function markNotificationsRead(user_id) {
  if (!user_id) return { ok: false, error: '로그인이 필요합니다.' };
  const sheet = getSheet('notifications');
  if (!sheet) return { ok: true };
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const userIdx    = headers.indexOf('user_id');
  const isReadIdx  = headers.indexOf('is_read');
  const createdIdx = headers.indexOf('created_at');
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  // 뒤에서부터 순회: 30일 이상 된 알림 삭제 + 읽음 처리
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][userIdx] !== user_id) continue;
    if (new Date(data[i][createdIdx]) < cutoff) {
      sheet.deleteRow(i + 1);
    } else if (data[i][isReadIdx] === 'false' || data[i][isReadIdx] === false) {
      sheet.getRange(i + 1, isReadIdx + 1).setValue('true');
    }
  }
  return { ok: true };
}

// ─── 신고 ────────────────────────────────────────────

function addReport(sub_id, reason, reporter_id) {
  if (!sub_id || !reason || !reporter_id) return { ok: false, error: '잘못된 요청입니다.' };
  const validReasons = ['plagiarism', 'sexual', 'profanity', 'spam', 'other'];
  if (!validReasons.includes(reason)) return { ok: false, error: '유효하지 않은 신고 사유입니다.' };

  const rSheet = getSheet('reports');
  if (!rSheet) return { ok: false, error: 'reports 시트가 없습니다.' };

  const existing = sheetToObjects(rSheet).find(r => r.sub_id === sub_id && r.reporter_id === reporter_id);
  if (existing) return { ok: false, error: '이미 신고한 글입니다.' };

  const sub = sheetToObjects(getSheet('submissions')).find(s => s.sub_id === sub_id);
  const story_id = sub ? sub.story_id : '';

  rSheet.appendRow([genId(), sub_id, story_id, reporter_id, reason, now()]);
  return { ok: true };
}

// ─── 이야기 전체 댓글 ──────────────────────────────────

function addStoryComment(story_id, content, author_id) {
  const text = (content || '').trim();
  if (!text) return { ok: false, error: '댓글 내용을 입력해주세요.' };
  if (text.length > 300) return { ok: false, error: '300자 이내로 작성해주세요.' };
  const story = sheetToObjects(getSheet('stories')).find(s => s.story_id === story_id);
  if (!story) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
  getSheet('comments').appendRow([genId(), '', story_id, author_id, text, now()]);
  return { ok: true };
}

function getStoryComments(story_id) {
  if (!story_id) return { ok: false, error: '잘못된 요청입니다.' };
  const sheet = getSheet('comments');
  if (!sheet) return { ok: true, comments: [] };
  const nickMap = {};
  sheetToObjects(getSheet('users')).forEach(u => { nickMap[u.user_id] = u.nickname; });
  const comments = sheetToObjects(sheet)
    .filter(c => c.story_id === story_id && (!c.sub_id || c.sub_id === ''))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(c => ({ ...c, author_nickname: nickMap[c.author_id] || '익명' }));
  return { ok: true, comments };
}

// ─── 이야기 추천 ──────────────────────────────────────

function toggleStoryLike(story_id, user_id) {
  const sheet = getSheet('story_likes');
  if (!sheet) return { ok: false, error: 'story_likes 시트 없음 — initSheets를 실행해주세요.' };

  const story = sheetToObjects(getSheet('stories')).find(s => s.story_id === story_id);
  if (!story) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
  if (story.status !== 'completed' && story.status !== 'inactive') {
    return { ok: false, error: '완결된 이야기에만 추천할 수 있습니다.' };
  }

  const all    = sheetToObjects(sheet);
  const myLike = all.find(r => r.story_id === story_id && r.user_id === user_id);

  if (myLike) {
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === myLike.like_id) { sheet.deleteRow(i + 1); break; }
    }
    const newCount = all.filter(r => r.story_id === story_id).length - 1;
    _cacheInvalidate();
    return { ok: true, liked: false, like_count: newCount };
  } else {
    sheet.appendRow([genId(), story_id, user_id, now()]);
    const newCount = all.filter(r => r.story_id === story_id).length + 1;
    _cacheInvalidate();
    return { ok: true, liked: true, like_count: newCount };
  }
}

// ─── MVP 따봉 ─────────────────────────────────────────

function voteMvp(story_id, nominated_user_ids, voter_id) {
  if (!voter_id) return { ok: false, error: '로그인이 필요합니다.' };
  if (!Array.isArray(nominated_user_ids) || nominated_user_ids.length !== 1) {
    return { ok: false, error: '1명을 선택해주세요.' };
  }
  const story = sheetToObjects(getSheet('stories')).find(s => s.story_id === story_id);
  if (!story) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
  if (story.status !== 'completed' && story.status !== 'inactive') {
    return { ok: false, error: '완결된 이야기에서만 가능합니다.' };
  }
  const sheet = getSheet('story_mvp');
  if (!sheet) return { ok: false, error: 'story_mvp 시트 없음 — initSheets를 실행해주세요.' };
  const existing = sheetToObjects(sheet).filter(r => r.story_id === story_id && r.voter_id === voter_id);
  if (existing.length > 0) return { ok: false, error: '이미 투표하셨습니다.' };
  if (nominated_user_ids.includes(voter_id)) return { ok: false, error: '본인을 선택할 수 없습니다.' };

  const winnerIds = new Set(
    sheetToObjects(getSheet('submissions'))
      .filter(s => s.story_id === story_id && (s.is_adopted === true || s.is_adopted === 'TRUE'))
      .map(s => s.author_id)
  );
  for (const uid of nominated_user_ids) {
    if (!winnerIds.has(uid)) return { ok: false, error: '이야기 참여자만 선택할 수 있습니다.' };
  }

  nominated_user_ids.forEach(uid => {
    sheet.appendRow([genId(), story_id, voter_id, uid, now()]);
    _addPoints(uid, 10, 'mvp_nomination', '');
  });
  _cacheInvalidate();
  return { ok: true };
}

function getMvpVotes(story_id, voter_id) {
  const sheet = getSheet('story_mvp');
  if (!sheet) return { ok: true, votes: [], has_voted: false, total_voters: 0 };
  const allVotes = sheetToObjects(sheet).filter(r => r.story_id === story_id);
  const has_voted = voter_id ? allVotes.some(r => r.voter_id === voter_id) : false;
  const countMap = {};
  allVotes.forEach(r => { countMap[r.nominated_user_id] = (countMap[r.nominated_user_id] || 0) + 1; });
  const nickMap = {}; const badgeMap = {};
  sheetToObjects(getSheet('users')).forEach(u => { nickMap[u.user_id] = u.nickname; badgeMap[u.user_id] = u.badge; });
  const votes = Object.entries(countMap)
    .sort(([,a],[,b]) => b - a)
    .map(([uid, count]) => ({ user_id: uid, nickname: nickMap[uid] || '?', badge: badgeMap[uid] || 'seed', count }));
  return { ok: true, votes, has_voted, total_voters: new Set(allVotes.map(r => r.voter_id)).size };
}

// ─── 관리자 ───────────────────────────────────────────

function adminForceAdopt(sub_id, admin_id) {
  if (!isAdmin(admin_id)) return { ok: false, error: '권한이 없습니다.' };

  const subSheet   = getSheet('submissions');
  const subData    = subSheet.getDataRange().getValues();
  const subHeaders = subData[0];
  let sub = null;
  for (let i = 1; i < subData.length; i++) {
    if (subData[i][0] === sub_id) {
      sub = {}; subHeaders.forEach((h, j) => sub[h] = subData[i][j]);
      subSheet.getRange(i + 1, 7).setValue(9999);
      break;
    }
  }
  if (!sub) return { ok: false, error: '제출을 찾을 수 없습니다.' };

  const epData = getSheet('episodes').getDataRange().getValues();
  let ep = null;
  for (let i = 1; i < epData.length; i++) {
    if (epData[i][0] === sub.episode_id) {
      ep = {}; epData[0].forEach((h, j) => ep[h] = epData[i][j]); break;
    }
  }
  if (!ep) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
  if (ep.status !== 'open') return { ok: false, error: '이미 마감된 에피소드입니다.' };

  _closeEpisode(sub.episode_id, ep);
  return { ok: true };
}

function adminDeleteSubmission(sub_id, admin_id) {
  if (!isAdmin(admin_id)) return { ok: false, error: '권한이 없습니다.' };

  const subSheet = getSheet('submissions');
  const subData  = subSheet.getDataRange().getValues();
  let deleted = false;
  for (let i = 1; i < subData.length; i++) {
    if (subData[i][0] === sub_id) {
      subSheet.deleteRow(i + 1);
      deleted = true;
      break;
    }
  }
  if (!deleted) return { ok: false, error: '제출을 찾을 수 없습니다.' };

  // 연관된 투표/댓글/신고 cascade 삭제
  ['votes', 'comments', 'reports'].forEach(sheetName => {
    const sh = getSheet(sheetName);
    if (!sh) return;
    const data = sh.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][1] === sub_id) sh.deleteRow(i + 1);
    }
  });

  return { ok: true };
}

function adminCloseStory(story_id, admin_id) {
  if (!isAdmin(admin_id)) return { ok: false, error: '권한이 없습니다.' };

  const stSheet = getSheet('stories');
  const stData  = stSheet.getDataRange().getValues();
  for (let i = 1; i < stData.length; i++) {
    if (stData[i][0] === story_id) {
      stSheet.getRange(i + 1, 5).setValue('inactive');
      return { ok: true };
    }
  }
  return { ok: false, error: '이야기를 찾을 수 없습니다.' };
}

function getReports(admin_id) {
  if (!isAdmin(admin_id)) return { ok: false, error: '권한이 없습니다.' };

  const reports = sheetToObjects(getSheet('reports'))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const subMap  = {};
  sheetToObjects(getSheet('submissions')).forEach(s => { subMap[s.sub_id] = s; });
  const nickMap = {};
  sheetToObjects(getSheet('users')).forEach(u => { nickMap[u.user_id] = u.nickname; });

  const reasonLabel = { plagiarism:'표절', sexual:'성적 묘사', profanity:'욕설·혐오', spam:'스팸', other:'기타' };

  const enriched = reports.map(r => ({
    report_id:        r.report_id,
    sub_id:           r.sub_id,
    story_id:         r.story_id,
    reason:           reasonLabel[r.reason] || r.reason,
    reporter_nickname: nickMap[r.reporter_id] || '?',
    sub_content:      (subMap[r.sub_id] || {}).content || '(삭제됨)',
    sub_author:       nickMap[(subMap[r.sub_id] || {}).author_id] || '?',
    created_at:       r.created_at,
  }));

  return { ok: true, reports: enriched };
}

function dismissReport(report_id, admin_id) {
  if (!isAdmin(admin_id)) return { ok: false, error: '권한이 없습니다.' };
  const sheet = getSheet('reports');
  if (!sheet) return { ok: false, error: 'reports 시트가 없습니다.' };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === report_id) { sheet.deleteRow(i + 1); return { ok: true }; }
  }
  return { ok: false, error: '신고를 찾을 수 없습니다.' };
}

// ─── handleRequest (google.script.run용) ─────────────

function handleRequest(jsonBody) {
  try {
    const p       = JSON.parse(jsonBody);
    const session = p.token ? getSession(p.token) : null;
    const need    = () => {
      if (!session) throw new Error('로그인이 필요합니다.');
      return session;
    };

    let result;
    switch (p.action) {
      case 'initSheets':         result = initSheets(); break;
      case 'register':           result = register(p.nickname, p.password, p.name); break;
      case 'login':              result = login(p.nickname, p.password); break;
      case 'getStories':         result = getStories(p.page); break;
      case 'getStory':           result = getStory(p.story_id, session ? session.user_id : null); break;
      case 'createStory':        result = createStory(p.opening, need().user_id); break;
      case 'getEpisode':         result = getEpisode(p.episode_id); break;
      case 'createSubmission':   result = createSubmission(p.episode_id, p.content, need().user_id, p.derived_from, p.closing); break;
      case 'vote':               result = vote(p.episode_id, p.sub_ids, need().user_id); break;
      case 'getProfile':         result = getProfile(need().user_id); break;
      case 'getSeeds':           result = getSeeds(); break;
      case 'getLeaderboard':     result = getLeaderboard(); break;
      case 'getAISuggestion':    result = getAISuggestion(); break;
      case 'getMyStories':       result = getMyStories(need().user_id); break;
      case 'seedInitialStories': result = seedInitialStories(); break;
      case 'addComment':            result = addComment(p.sub_id, p.content, need().user_id); break;
      case 'getComments':           result = getComments(p.sub_id); break;
      case 'addBookmark':           result = addBookmark(p.story_id, need().user_id); break;
      case 'removeBookmark':        result = removeBookmark(p.story_id, need().user_id); break;
      case 'getBookmarks':          result = getBookmarks(need().user_id); break;
      case 'getNotifications':      result = getNotifications(need().user_id); break;
      case 'markNotificationsRead': result = markNotificationsRead(need().user_id); break;
      case 'addReport':             result = addReport(p.sub_id, p.reason, need().user_id); break;
      case 'addStoryComment':       result = addStoryComment(p.story_id, p.content, need().user_id); break;
      case 'getStoryComments':      result = getStoryComments(p.story_id); break;
      case 'getReports':            result = getReports(need().user_id); break;
      case 'dismissReport':         result = dismissReport(p.report_id, need().user_id); break;
      case 'adminForceAdopt':       result = adminForceAdopt(p.sub_id, need().user_id); break;
      case 'adminDeleteSubmission': result = adminDeleteSubmission(p.sub_id, need().user_id); break;
      case 'adminCloseStory':       result = adminCloseStory(p.story_id, need().user_id); break;
      case 'pingWarm':              result = pingWarm(); break;
      case 'findAccount':           result = findAccount(p.name); break;
      case 'resetPassword':         result = resetPassword(p.nickname, p.name, p.new_password); break;
      case 'voteMvp':               result = voteMvp(p.story_id, p.nominated_user_ids, need().user_id); break;
      case 'getMvpVotes':           result = getMvpVotes(p.story_id, session ? session.user_id : null); break;
      case 'addUserNameColumn':     result = addUserNameColumn(); break;
      case 'boostStory':            result = boostStory(p.story_id, need().user_id); break;
      case 'buyExtraSubmit':        result = buyExtraSubmit(p.episode_id, need().user_id); break;
      case 'toggleStoryLike':       result = toggleStoryLike(p.story_id, need().user_id); break;
      case 'deleteAccount':         result = deleteAccount(need().user_id); break;
      default:                      result = { ok: false, error: '알 수 없는 요청입니다.' };
    }
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ ok: false, error: err.message });
  }
}

// ─── Keep-warm ────────────────────────────────────────

function pingWarm() {
  return { ok: true };
}

// ─── 라우터 ───────────────────────────────────────────

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('HWASEE')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    const p       = JSON.parse(e.postData.contents);
    const session = p.token ? getSession(p.token) : null;
    const need    = () => session || (() => { throw new Error('로그인이 필요합니다.'); })();

    switch (p.action) {
      case 'initSheets':         return jsonRes(initSheets());
      case 'register':           return jsonRes(register(p.nickname, p.password, p.name));
      case 'login':              return jsonRes(login(p.nickname, p.password));
      case 'getStories':         return jsonRes(getStories(p.page));
      case 'getStory':           return jsonRes(getStory(p.story_id, session ? session.user_id : null));
      case 'createStory':        return jsonRes(createStory(p.opening, need().user_id));
      case 'getEpisode':         return jsonRes(getEpisode(p.episode_id));
      case 'createSubmission':   return jsonRes(createSubmission(p.episode_id, p.content, need().user_id, p.derived_from, p.closing));
      case 'vote':               return jsonRes(vote(p.episode_id, p.sub_ids, need().user_id));
      case 'getProfile':         return jsonRes(getProfile(need().user_id));
      case 'getSeeds':           return jsonRes(getSeeds());
      case 'getLeaderboard':     return jsonRes(getLeaderboard());
      case 'getAISuggestion':    return jsonRes(getAISuggestion());
      case 'getMyStories':       return jsonRes(getMyStories(need().user_id));
      case 'seedInitialStories': return jsonRes(seedInitialStories());
      case 'addComment':            return jsonRes(addComment(p.sub_id, p.content, need().user_id));
      case 'getComments':           return jsonRes(getComments(p.sub_id));
      case 'addBookmark':           return jsonRes(addBookmark(p.story_id, need().user_id));
      case 'removeBookmark':        return jsonRes(removeBookmark(p.story_id, need().user_id));
      case 'getBookmarks':          return jsonRes(getBookmarks(need().user_id));
      case 'getNotifications':      return jsonRes(getNotifications(need().user_id));
      case 'markNotificationsRead': return jsonRes(markNotificationsRead(need().user_id));
      case 'addReport':             return jsonRes(addReport(p.sub_id, p.reason, need().user_id));
      case 'addStoryComment':       return jsonRes(addStoryComment(p.story_id, p.content, need().user_id));
      case 'getStoryComments':      return jsonRes(getStoryComments(p.story_id));
      case 'getReports':            return jsonRes(getReports(need().user_id));
      case 'dismissReport':         return jsonRes(dismissReport(p.report_id, need().user_id));
      case 'adminForceAdopt':       return jsonRes(adminForceAdopt(p.sub_id, need().user_id));
      case 'adminDeleteSubmission': return jsonRes(adminDeleteSubmission(p.sub_id, need().user_id));
      case 'adminCloseStory':       return jsonRes(adminCloseStory(p.story_id, need().user_id));
      case 'pingWarm':              return jsonRes(pingWarm());
      case 'findAccount':           return jsonRes(findAccount(p.name));
      case 'resetPassword':         return jsonRes(resetPassword(p.nickname, p.name, p.new_password));
      case 'voteMvp':               return jsonRes(voteMvp(p.story_id, p.nominated_user_ids, need().user_id));
      case 'getMvpVotes':           return jsonRes(getMvpVotes(p.story_id, session ? session.user_id : null));
      case 'addUserNameColumn':     return jsonRes(addUserNameColumn());
      case 'boostStory':            return jsonRes(boostStory(p.story_id, need().user_id));
      case 'buyExtraSubmit':        return jsonRes(buyExtraSubmit(p.episode_id, need().user_id));
      case 'toggleStoryLike':       return jsonRes(toggleStoryLike(p.story_id, need().user_id));
      case 'deleteAccount':         return jsonRes(deleteAccount(need().user_id));
      default:                      return jsonRes({ ok: false, error: '알 수 없는 요청입니다.' });
    }
  } catch (err) {
    return jsonRes({ ok: false, error: err.message });
  }
}
