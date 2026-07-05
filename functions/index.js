const functions = require('firebase-functions');
const admin     = require('firebase-admin');
admin.initializeApp();

const FB_ADMIN_ID = 'c50c82b2-fe0e-4ee9-be8c-8132f03b9cb6';
const FB_AI_ID    = '578873e7-47b7-48d3-9cd8-894546196205'; // AI 자동참여 전용 봇 계정 (관리자 계정과 분리)

// index.html의 calcDisplayStep과 동일한 규칙 — 분기 생성 시점에 정확한
// branch_display_offset을 미리 계산해서 저장하기 위한 용도 (firebase-api.js와 동일하게 유지할 것)
function _calcDisplayStepBackend(storyData, epStep) {
  if (storyData.branch_display_offset !== undefined && storyData.branch_display_offset !== null) {
    return Number(storyData.branch_display_offset) + Number(epStep);
  }
  if (storyData.branch_from_step) return (Number(storyData.branch_from_step) - 1) + Number(epStep);
  return Number(epStep) + 1;
}

// ── 알림 생성 시 FCM 푸시 발송 ──────────────────────────────
exports.sendPushOnNotification = functions
  .region('asia-northeast3')
  .firestore.document('notifications/{notifId}')
  .onCreate(async snap => {
    const notif = snap.data();
    if (!notif.user_id) return null;

    // Firebase CF는 at-least-once 실행 — 트랜잭션으로 중복 발송 방지
    try {
      const shouldSend = await admin.firestore().runTransaction(async tx => {
        const current = await tx.get(snap.ref);
        if (!current.exists || current.data().push_sent) return false;
        tx.update(snap.ref, { push_sent: true });
        return true;
      });
      if (!shouldSend) return null;
    } catch (e) {
      return null;
    }

    const userSnap = await admin.firestore().collection('users').doc(notif.user_id).get();
    if (!userSnap.exists) return null;

    const fcmToken = userSnap.data().fcm_token;
    if (!fcmToken) return null;

    const link = notif.link
      || (notif.story_id ? `https://hwasee.me/bang/#story/${notif.story_id}` : 'https://hwasee.me/bang/');

    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: {
          title: '화씨.방',
          body: notif.message,
        },
        data: { link },
        webpush: {
          notification: {
            icon:  'https://hwasee.me/bang/icon-192.png',
            badge: 'https://hwasee.me/bang/icon-192.png',
          },
          fcmOptions: { link },
        },
      });
    } catch (e) {
      if (e.code === 'messaging/registration-token-not-registered') {
        await admin.firestore().collection('users').doc(notif.user_id)
          .update({ fcm_token: admin.firestore.FieldValue.delete() });
      }
    }
    return null;
  });

// ── 에피소드 마감 → 서버사이드 알림 생성 ─────────────────────
exports.onEpisodeClosed = functions
  .region('asia-northeast3')
  .firestore.document('episodes/{episodeId}')
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() : null;
    const after  = change.after.exists  ? change.after.data()  : null;
    if (!after || after.status !== 'closed') return null;
    if (before && before.status === 'closed') return null; // 이미 닫힌 상태였으면 무시

    const db = admin.firestore();
    const epRef = change.after.ref;
    const episode_id = context.params.episodeId;
    const story_id   = after.story_id;

    // 중복 처리 방지 — 트랜잭션으로 notif_sent 플래그 선점
    try {
      const shouldProcess = await db.runTransaction(async tx => {
        const snap = await tx.get(epRef);
        if (!snap.exists || snap.data().notif_sent) return false;
        tx.update(epRef, { notif_sent: true });
        return true;
      });
      if (!shouldProcess) return null;
    } catch (e) {
      return null;
    }

    // 제출 목록
    const subsSnap = await db.collection('submissions').where('episode_id', '==', episode_id).get();
    if (subsSnap.empty) return null;
    const allSubs = subsSnap.docs.map(d => d.data());

    // 채택 글 결정 (클라이언트와 동일 로직)
    const maxVotes = Math.max(...allSubs.map(s => Number(s.vote_count) || 0));
    let winners;
    if (maxVotes === 0) {
      const sorted = [...allSubs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      winners = [sorted[0]];
    } else {
      winners = allSubs.filter(s => (Number(s.vote_count) || 0) === maxVotes);
    }

    const storySnap = await db.collection('stories').doc(story_id).get();
    if (!storySnap.exists) return null;
    const st = storySnap.data();
    const nextStep  = (Number(st.current_step) || 0) + 1;
    const anyClose  = winners.some(w => w.is_closing === true);
    const snippet   = (st.opening || '').slice(0, 25) + ((st.opening || '').length > 25 ? '…' : '');

    // 참여자 조회 (submissions + bookmarks + comments + votes)
    const [bmSnap, commSnap, epsSnap] = await Promise.all([
      db.collection('bookmarks').where('story_id', '==', story_id).get(),
      db.collection('comments').where('story_id', '==', story_id).get(),
      db.collection('episodes').where('story_id', '==', story_id).get(),
    ]);
    const storySubsSnap = await db.collection('submissions').where('story_id', '==', story_id).get();
    const epIds = [...new Set(epsSnap.docs.map(d => d.id))];
    const partIds = [
      ...storySubsSnap.docs.map(d => d.data().author_id),
      ...bmSnap.docs.map(d => d.data().user_id),
      ...commSnap.docs.map(d => d.data().author_id),
    ];
    if (epIds.length > 0) {
      const batches = [];
      for (let i = 0; i < epIds.length; i += 10) batches.push(epIds.slice(i, i + 10));
      const vSnaps = await Promise.all(batches.map(b =>
        db.collection('votes').where('episode_id', 'in', b).get()
      ));
      vSnaps.forEach(s => s.docs.forEach(d => partIds.push(d.data().voter_id)));
    }
    const allPart = [...new Set(partIds.filter(Boolean))];

    // 알림 생성 헬퍼
    const createNotifs = async (user_ids, message) => {
      const unique = [...new Set(user_ids)].filter(Boolean);
      if (!unique.length) return;
      const batch = db.batch();
      unique.forEach(uid => {
        batch.set(db.collection('notifications').doc(), {
          user_id: uid, type: 'story_advance', story_id, message,
          is_read: false, created_at: admin.firestore.Timestamp.now(),
        });
      });
      await batch.commit();
    };

    if (anyClose) {
      await createNotifs(allPart, `"${snippet}" 이야기가 완결됐어요!`);
    } else {
      const winnerAuthorIds = new Set(winners.map(w => w.author_id).filter(Boolean));
      const sourceAuthorIds = new Set();
      for (const w of winners) {
        const parent = allSubs.find(s => s.sub_id === w.derived_from);
        if (parent && parent.author_id && !winnerAuthorIds.has(parent.author_id))
          sourceAuthorIds.add(parent.author_id);
      }
      await createNotifs([...winnerAuthorIds], `"${snippet}" 이야기에서 내 문장이 채택됐어요!`);
      await createNotifs([...sourceAuthorIds], `"${snippet}" 이야기에서 내 글을 손본 문장이 채택됐어요! +10P`);
      const excludeIds = new Set([...winnerAuthorIds, ...sourceAuthorIds]);
      const otherIds = allPart.filter(id => !excludeIds.has(id));
      const msg = winners.length > 1
        ? `"${snippet}" 이야기가 ${nextStep + 2}단계에서 ${winners.length}개 갈림길로 나뉘었어요!`
        : `"${snippet}" 이야기가 ${nextStep + 2}단계로 이어졌어요!`;
      await createNotifs(otherIds, msg);
    }
    return null;
  });

// ── 완성된 이야기 AI 교정 (2시간마다) ───────────────────────
exports.aiReviewCompletedStories = functions
  .region('asia-northeast3')
  .pubsub.schedule('every 2 hours')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    const db = admin.firestore();

    // at-least-once 중복 실행 방지 — 90분 이내 실행 기록 있으면 skip
    const lockRef = db.collection('config').doc('ai_review_lock');
    const shouldRun = await db.runTransaction(async tx => {
      const snap = await tx.get(lockRef);
      const last = snap.exists ? (snap.data().started_at?.toMillis() || 0) : 0;
      if (Date.now() - last < 90 * 60 * 1000) return false;
      tx.set(lockRef, { started_at: admin.firestore.Timestamp.now() });
      return true;
    });
    if (!shouldRun) { console.log('AI review skipped: duplicate run within 90 min.'); return null; }

    const secretsSnap = await db.collection('config').doc('secrets').get();
    const claudeKey = secretsSnap.exists ? secretsSnap.data().claude_key : null;
    if (!claudeKey) {
      console.log('Claude API key not set. Add it via admin AI page.');
      return null;
    }

    // 완성된 이야기 전체 조회
    const storiesSnap = await db.collection('stories')
      .where('status', '==', 'completed')
      .get();

    if (storiesSnap.empty) return null;

    let totalChanged  = 0;
    let totalStories  = 0;

    for (const storyDoc of storiesSnap.docs) {
      const story_id = storyDoc.id;
      const story    = storyDoc.data();

      // 쿼리 결과 방어 검증 — status가 completed인 것만 처리
      if (story.status !== 'completed') {
        console.warn(`Story ${story_id} has status "${story.status}", skipping.`);
        continue;
      }

      // 채택된 submissions 조회
      const subsSnap = await db.collection('submissions')
        .where('story_id', '==', story_id)
        .where('is_adopted', '==', true)
        .get();

      if (subsSnap.empty) continue;

      const allAdopted = subsSnap.docs.map(d => ({ sub_id: d.id, ...d.data() }));
      const unreviewed = allAdopted.filter(s => !s.ai_reviewed);
      if (!unreviewed.length) continue;

      const allSubIds = unreviewed.map(s => s.sub_id);

      // 문장이 하나뿐이면 교정 의미 없음 — 검토 완료만 처리
      if (allAdopted.length < 2) {
        await Promise.all(allSubIds.map(id =>
          db.collection('submissions').doc(id).update({ ai_reviewed: true })
        ));
        continue;
      }

      // 에피소드 순서 조회
      const epsSnap = await db.collection('episodes')
        .where('story_id', '==', story_id)
        .get();
      const episodes = epsSnap.docs.map(d => ({ episode_id: d.id, ...d.data() }));

      const sortedAdopted = allAdopted.slice().sort((a, b) => {
        const ea = episodes.find(e => e.episode_id === a.episode_id);
        const eb = episodes.find(e => e.episode_id === b.episode_id);
        return (Number(ea?.step) || 0) - (Number(eb?.step) || 0);
      });

      // Claude API 호출
      const prompt = `다음은 여러 사람이 한 문장씩 이어 쓴 릴레이 소설입니다.
전체 이야기를 순서대로 읽고, 문장 사이의 흐름이 자연스럽도록 다듬어 주세요.

규칙:
- 문장의 핵심 의미와 주요 단어는 절대 바꾸지 않는다
- 앞뒤 문장과의 연결이 어색하면 접속어(그때, 그런데, 그러자, 하지만 등), 조사, 접미사를 최소한으로 수정한다
- 오탈자·띄어쓰기도 함께 교정한다
- 개별 문장보다 전체 흐름의 자연스러움을 우선한다
- 수정이 불필요하면 revised에 원문 그대로 넣는다
- JSON 배열 형식으로만 응답, 다른 텍스트 없음

이야기 순서대로 문장 목록:
${JSON.stringify(sortedAdopted.map(s => ({ sub_id: s.sub_id, content: s.content })))}

응답 형식: [{"sub_id":"...","revised":"..."}]`;

      let result = null;
      try {
        const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': claudeKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const data = await apiRes.json();
        result = data.content?.[0]?.text || null;
      } catch (e) {
        console.error(`Claude API error for story ${story_id}:`, e.message);
      }

      if (!result) {
        await Promise.all(allSubIds.map(id =>
          db.collection('submissions').doc(id).update({ ai_reviewed: true })
        ));
        continue;
      }

      let revised;
      try {
        const match = result.match(/\[[\s\S]*\]/);
        revised = JSON.parse(match ? match[0] : result);
      } catch (e) {
        await Promise.all(allSubIds.map(id =>
          db.collection('submissions').doc(id).update({ ai_reviewed: true })
        ));
        continue;
      }

      const batch = db.batch();
      let changedCount = 0;

      for (const r of revised) {
        if (!r.sub_id || !r.revised) continue;
        const orig = allAdopted.find(s => s.sub_id === r.sub_id);
        if (!orig || orig.content.trim() === r.revised.trim()) continue;

        batch.update(db.collection('submissions').doc(r.sub_id), {
          content: r.revised.trim(),
        });
        batch.set(db.collection('admin_edits').doc(), {
          sub_id: r.sub_id, story_id,
          old_content: orig.content,
          new_content: r.revised.trim(),
          edit_type: 'ai',
          admin_id: FB_ADMIN_ID,
          edited_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        changedCount++;
      }

      for (const s of unreviewed) {
        batch.update(db.collection('submissions').doc(s.sub_id), { ai_reviewed: true });
      }

      await batch.commit();

      if (changedCount > 0) {
        totalChanged += changedCount;
        totalStories++;
      }
    }

    // 수정된 게 있으면 어드민 푸시 알림
    if (totalChanged > 0) {
      await admin.firestore().collection('notifications').add({
        user_id:    FB_ADMIN_ID,
        message:    `✏️ AI가 ${totalStories}개 이야기, ${totalChanged}개 문장을 다듬었어요.`,
        type:       'ai_edit',
        link:       'https://hwasee.me/bang/#admin-edits',
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        is_read:    false,
      });
    }

    console.log(`AI review complete. ${totalChanged} sentences changed in ${totalStories} stories.`);
    return null;
  });

// ── AI 참여 (30분마다) ────────────────────────────────────────

const AI_VOTE_THRESHOLD = 3;

function _serverCalcBadge(pts) {
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

async function _serverAddPoints(db, user_id, amount, reason, sub_id) {
  if (!user_id || user_id === FB_ADMIN_ID || user_id === FB_AI_ID) return;
  const uRef = db.collection('users').doc(user_id);
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(uRef);
      if (!snap.exists) return;
      const newTotal = (snap.data().total_points || 0) + amount;
      tx.update(uRef, { total_points: newTotal, badge: _serverCalcBadge(newTotal) });
      tx.set(db.collection('point_ledger').doc(), {
        user_id, points: amount, reason, sub_id: sub_id || '',
        created_at: new Date().toISOString(),
      });
    });
  } catch (e) {
    console.error('serverAddPoints error:', e.message);
  }
}

// 다듬기(derived_from) 체인에 따라 원작자/다듬은 사람에게 점수를 나눠줌.
// 이야기를 완결지은 경우(is_closing): 직접 제출은 20→30p, 원저자+다듬은 사람 2인 체인은 10/10→15/15p.
// 3인 체인(gp/parent/winner)은 이번 보너스 범위 밖 — 기존 10/5/5 그대로.
async function _serverDistributePoints(db, winner, allSubs) {
  const parent = allSubs.find(s => s.id === winner.derived_from);
  if (!parent) {
    if (winner.is_closing === true) {
      await _serverAddPoints(db, winner.author_id, 30, 'direct_close', winner.id);
    } else {
      await _serverAddPoints(db, winner.author_id, 20, 'direct', winner.id);
    }
  } else {
    const gp = allSubs.find(s => s.id === parent.derived_from);
    if (!gp) {
      if (winner.is_closing === true) {
        await _serverAddPoints(db, parent.author_id, 15, 'source_close',  winner.id);
        await _serverAddPoints(db, winner.author_id, 15, 'derived_close', winner.id);
      } else {
        await _serverAddPoints(db, parent.author_id, 10, 'source',  winner.id);
        await _serverAddPoints(db, winner.author_id, 10, 'derived', winner.id);
      }
    } else {
      await _serverAddPoints(db, gp.author_id,     10, 'source',  winner.id);
      await _serverAddPoints(db, parent.author_id,  5, 'mid',     winner.id);
      await _serverAddPoints(db, winner.author_id,  5, 'derived', winner.id);
    }
  }
}

async function _buildStoryContext(db, story_id, story) {
  let text = story.opening || '';
  const adoptedSnap = await db.collection('submissions')
    .where('story_id', '==', story_id).where('is_adopted', '==', true).get();
  if (adoptedSnap.empty) return text;

  const epIds = [...new Set(adoptedSnap.docs.map(d => d.data().episode_id).filter(Boolean))];
  if (!epIds.length) return text;

  const chunks = [];
  for (let i = 0; i < epIds.length; i += 10) chunks.push(epIds.slice(i, i + 10));
  const epStepMap = {};
  await Promise.all(chunks.map(async ch => {
    const s = await db.collection('episodes')
      .where(admin.firestore.FieldPath.documentId(), 'in', ch).get();
    s.docs.forEach(d => { epStepMap[d.id] = d.data().step || 0; });
  }));

  const adopted = adoptedSnap.docs.map(d => d.data())
    .sort((a, b) => (epStepMap[a.episode_id] || 0) - (epStepMap[b.episode_id] || 0));
  for (const s of adopted) text += '\n' + s.content;
  return text;
}

async function _callClaude(key, prompt, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || null;
}

async function _serverCloseEpisode(db, episode_id, ep) {
  const epRef = db.collection('episodes').doc(episode_id);
  const alreadyClosed = await db.runTransaction(async tx => {
    const snap = await tx.get(epRef);
    if (!snap.exists) return true;
    const st = snap.data().status;
    if (st !== 'open' && st !== 'pending') return true;
    tx.update(epRef, { status: 'closed', closed_at: new Date().toISOString() });
    return false;
  });
  if (alreadyClosed) return;

  const subsSnap = await db.collection('submissions').where('episode_id', '==', episode_id).get();
  if (subsSnap.empty) return;

  const allSubs = subsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const maxVotes = Math.max(...allSubs.map(s => Number(s.vote_count) || 0));

  // 동률이면 여러 명 모두 채택 → 갈림길(분기) 생성. 사람 제출 우선, 없으면 AI 포함.
  let winners;
  if (maxVotes === 0) {
    const humanSubs = allSubs.filter(s => !s.is_ai);
    const pool = humanSubs.length > 0 ? humanSubs : allSubs;
    winners = [pool.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]];
  } else {
    const tied = allSubs.filter(s => (Number(s.vote_count) || 0) === maxVotes);
    const humanTied = tied.filter(s => !s.is_ai);
    winners = humanTied.length > 0 ? humanTied : tied;
  }

  for (const w of winners) {
    await db.collection('submissions').doc(w.id).update({ is_adopted: true });
    // firebase-api.js의 _fbDistributePoints와 동일 — 다듬기(derived_from) 체인 반영해서 분배
    // (누락되어 있던 부분 — 원작자 없이 채택자에게 20점을 무조건 몰아주고 있었음)
    await _serverDistributePoints(db, w, allSubs);
    // firebase-api.js의 _fbCloseEpisode와 동일하게 채택 횟수 반영 (누락되어 있던 부분 — AI가
    // 마감시킨 경우 실제 채택자의 adoption_count가 하나도 안 올라가고 있었음)
    if (w.author_id && w.author_id !== FB_ADMIN_ID && w.author_id !== FB_AI_ID) {
      const uRef = db.collection('users').doc(w.author_id);
      await db.runTransaction(async tx => {
        const snap = await tx.get(uRef);
        if (!snap.exists) return;
        tx.update(uRef, { adoption_count: (snap.data().adoption_count || 0) + 1 });
      });
    }
  }

  const storySnap = await db.collection('stories').doc(ep.story_id).get();
  if (!storySnap.exists) return;

  const st = storySnap.data();
  const nextStep = (Number(st.current_step) || 0) + 1;
  const anyClose = winners.some(w => w.is_closing === true);

  if (anyClose) {
    await storySnap.ref.update({ current_step: nextStep, status: 'completed' });

    // 남은 open 에피소드(다른 갈래)를 독립 active 스토리로 분리
    // (firebase-api.js의 _fbCloseEpisode와 동일한 로직 — 반드시 함께 수정할 것)
    const orphanSnap = await db.collection('episodes')
      .where('story_id', '==', ep.story_id).where('status', '==', 'open').get();
    if (!orphanSnap.empty) {
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
        const newStoryId = db.collection('stories').doc().id;
        const subSnap = await db.collection('submissions')
          .where('episode_id', '==', orphan.episode_id).get();
        const uniqueAuthors = new Set(subSnap.docs.filter(d => !d.data().is_ai).map(d => d.data().author_id).filter(Boolean));

        // orphan의 조상 체인을 거슬러 올라가며 두 지점을 구분해서 기록
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

        const spinBatch = db.batch();
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
          has_branch: false, created_at: new Date().toISOString(), batch: '',
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
      const newEpId = db.collection('episodes').doc().id;
      epBatch.set(db.collection('episodes').doc(newEpId), {
        episode_id: newEpId, story_id: ep.story_id,
        step: nextStep + 1, parent_sub_id: w.id,
        status: 'open', vote_total: 0,
        created_at: new Date().toISOString(), closed_at: '', pending_at: '',
      });
    }
    await epBatch.commit();
  }
  console.log(`serverCloseEpisode: ${episode_id} → ${anyClose ? 'completed' : `step ${nextStep + 1}`} (winners: ${winners.length})`);
}

exports.aiParticipate = functions
  .region('asia-northeast3')
  .pubsub.schedule('every 30 minutes')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    const db = admin.firestore();
    const secretsSnap = await db.collection('config').doc('secrets').get();
    const claudeKey = secretsSnap.exists ? secretsSnap.data().claude_key : null;
    if (!claudeKey) return null;

    // 한국시간 08:00~22:00 외 비활성
    const nowKSTDate = new Date(Date.now() + 9 * 3600 * 1000);
    const hourKST = nowKSTDate.getUTCHours();
    if (hourKST < 8 || hourKST >= 22) return null;

    // 야간(어젯밤 22:00 ~ 오늘 08:00) 활동 여부 판단용
    const kstMidnightUTC = Date.UTC(nowKSTDate.getUTCFullYear(), nowKSTDate.getUTCMonth(), nowKSTDate.getUTCDate()) - 9 * 3600 * 1000;
    const overnightStart  = kstMidnightUTC - 2 * 3600 * 1000;  // 어젯밤 22:00 KST
    const todayEightAMUTC = kstMidnightUTC + 8 * 3600 * 1000;  // 오늘 08:00 KST

    const configSnap = await db.collection('config').doc('ai_config').get();
    const aiConfig = configSnap.exists ? configSnap.data() : {};
    const subEnabled  = aiConfig.sub_enabled  !== undefined ? aiConfig.sub_enabled  : !!aiConfig.enabled;
    const voteEnabled = aiConfig.vote_enabled !== undefined ? aiConfig.vote_enabled : !!aiConfig.enabled;
    if (!subEnabled && !voteEnabled) return null;

    const speedPct = Math.max(50, Math.min(200, Number(aiConfig.speed_pct) || 100));
    const subIntervalMs  = 3 * 60 * 60 * 1000 * (100 / speedPct);
    const voteIntervalMs = 2 * 60 * 60 * 1000 * (100 / speedPct);
    const now = Date.now();

    const storiesSnap = await db.collection('stories').where('status', '==', 'active').get();

    for (const storyDoc of storiesSnap.docs) {
      try {
        const story_id = storyDoc.id;
        const story = storyDoc.data();

        const epsSnap = await db.collection('episodes')
          .where('story_id', '==', story_id).where('status', '==', 'open').get();
        if (epsSnap.empty) continue;

        const currentEp = epsSnap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.step || 0) - (b.step || 0))[0];
        const episode_id = currentEp.id;

        const subsSnap = await db.collection('submissions')
          .where('episode_id', '==', episode_id).get();
        const subs = subsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (subs.length === 0) continue;

        const votesSnap = await db.collection('votes')
          .where('episode_id', '==', episode_id).get();
        const votes = votesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const lastSubAt = subs.reduce((m, s) => Math.max(m, new Date(s.created_at).getTime()), 0);

        // ── 제출 로직
        if (subEnabled) {
          const aiSubs = subs.filter(s => s.is_ai === true);
          // 야간 활동이 있었으면 오늘 8시 기준 3시간 인터벌(→ 11시), 없었으면 8시 즉시 허용
          const hadOvernightActivity = lastSubAt >= overnightStart;
          const effectiveLastSubAt = hadOvernightActivity ? Math.max(lastSubAt, todayEightAMUTC) : lastSubAt;
          if (now - effectiveLastSubAt >= subIntervalMs && aiSubs.length < 3) {
            const storyText = await _buildStoryContext(db, story_id, story);
            const epStep = Number(currentEp.step) || 1;
            const isClosing = epStep >= 3;
            const tones = [
              '자연스럽게 이야기를 이어가도록',
              '가볍고 유머러스하게 (개그 톤)',
              '반전이나 의외성이 있게 (독자가 예상 못 한 방향으로)',
            ];
            const tone = tones[Math.min(aiSubs.length, 2)];

            const subPrompt = `당신은 릴레이 소설에 참여하는 작가입니다.

⚠️ 핵심 제약: 반드시 30자~50자 이내의 짧은 한 문장만 작성하세요. 50자 초과 시 잘립니다.

지금까지의 이야기:
${storyText}

위 이야기에 이어지는 다음 문장 하나를 ${tone} 써주세요.
${isClosing ? '이 문장이 이야기의 마지막 문장이 되어야 합니다. 자연스럽게 마무리해 주세요.' : '이야기가 계속 이어질 수 있도록 열린 결말로 써주세요.'}

규칙:
- 딱 한 문장만, 마침표(. 또는 !)로 끝낼 것
- 한국어로
- 문장만 출력, 다른 설명 없음
- 반드시 50자 이내 (공백 포함, 초과 금지)`;

            let content = null;
            try { content = await _callClaude(claudeKey, subPrompt, 200); } catch (e) { console.error('AI sub error:', e.message); }

            if (content) {
              const sub_id = db.collection('submissions').doc().id;
              await db.collection('submissions').doc(sub_id).set({
                sub_id, episode_id, story_id,
                author_id: FB_AI_ID,
                author_nickname: '익명',
                author_badge: 'seed',
                content: content.slice(0, 50),
                is_closing: isClosing,
                is_ai: true,
                is_adopted: false,
                created_at: new Date().toISOString(),
                vote_count: 0,
              });

              // 첫 AI 제출 시 participant_count 증가
              if (aiSubs.length === 0) {
                await db.collection('stories').doc(story_id).update({
                  participant_count: admin.firestore.FieldValue.increment(1),
                });
              }
              console.log(`AI submitted to ${episode_id} (tone ${aiSubs.length}, closing=${isClosing})`);
            }
          }
        }

        // ── 투표 로직
        if (voteEnabled && subs.length >= 2) {
          const aiVotes = votes.filter(v => v.voter_id === FB_AI_ID);
          const lastAiVoteAt = aiVotes.reduce((m, v) => Math.max(m, new Date(v.created_at).getTime()), 0);
          const shouldVote = lastAiVoteAt === 0
            ? now - lastSubAt >= voteIntervalMs
            : now - lastAiVoteAt >= voteIntervalMs;

          if (shouldVote) {
            const humanSubs = subs.filter(s => !s.is_ai);
            const votable = humanSubs.length > 0 ? humanSubs : subs;
            if (votable.length === 0) continue;

            const storyText = await _buildStoryContext(db, story_id, story);
            const votePrompt = `다음은 릴레이 소설 한 단계에 제출된 문장들입니다.

이야기 앞부분:
${storyText}

제출된 문장 목록:
${votable.map((s, i) => `[${i + 1}] sub_id=${s.id} | ${s.content}`).join('\n')}

가장 재밌고 참신한 문장 하나를 골라 해당 sub_id 값만 출력하세요. 다른 텍스트 없이.`;

            let chosenId = null;
            try {
              const raw = await _callClaude(claudeKey, votePrompt, 100);
              if (raw && votable.some(s => s.id === raw)) {
                chosenId = raw;
              } else {
                // Claude가 유효한 ID를 못 뽑으면 첫 번째 선택
                chosenId = votable[0].id;
              }
            } catch (e) {
              console.error('AI vote error:', e.message);
              chosenId = votable[0].id;
            }

            if (chosenId) {
              await db.collection('votes').doc(db.collection('votes').doc().id).set({
                episode_id, sub_id: chosenId,
                voter_id: FB_AI_ID,
                is_ai: true,
                created_at: new Date().toISOString(),
              });
              await db.collection('submissions').doc(chosenId).update({
                vote_count: admin.firestore.FieldValue.increment(1),
              });
              await db.collection('episodes').doc(episode_id).update({
                vote_total: admin.firestore.FieldValue.increment(1),
              });

              // 임계값 도달 시 에피소드 종료
              const chosen = subs.find(s => s.id === chosenId);
              const newCount = (Number(chosen?.vote_count) || 0) + 1;
              if (newCount >= AI_VOTE_THRESHOLD) {
                await _serverCloseEpisode(db, episode_id, currentEp);
              }
              console.log(`AI voted ${chosenId} in ${episode_id}`);
            }
          }
        }
      } catch (e) {
        console.error(`aiParticipate error for story ${storyDoc.id}:`, e.message);
      }
    }

    return null;
  });

// ── Claude API 키 관리 (클라이언트는 Firestore config 컬렉션에 직접 접근 불가 —
//    firestore.rules에서 config/** 전체를 차단하므로 이 두 함수를 통해서만 조회/저장 가능) ──
exports.getClaudeKeyStatus = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    if (data.admin_id !== FB_ADMIN_ID) {
      throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
    }
    const db = admin.firestore();
    const secretsSnap = await db.collection('config').doc('secrets').get();
    const hasKey = secretsSnap.exists && !!secretsSnap.data().claude_key;
    return { ok: true, has_key: hasKey };
  });

exports.setClaudeKey = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    if (data.admin_id !== FB_ADMIN_ID) {
      throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
    }
    const key = data.key;
    if (!key || key.length < 20) {
      throw new functions.https.HttpsError('invalid-argument', '유효한 Claude API 키를 입력해주세요.');
    }
    const db = admin.firestore();
    await db.collection('config').doc('secrets').set({ claude_key: key }, { merge: true });
    return { ok: true };
  });

// ── 에피소드 마감 보상 지급 (Callable — 클라이언트가 남의 계정에 직접 점수/입양수를
//    쓰지 못하게 하기 위함. 클라이언트는 is_adopted만 표시하고 이 함수를 호출함) ──
exports.distributeEpisodeRewards = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const episode_id = data.episode_id;
    if (!episode_id) throw new functions.https.HttpsError('invalid-argument', 'episode_id가 필요합니다.');
    const db = admin.firestore();
    const epRef = db.collection('episodes').doc(episode_id);

    const shouldProcess = await db.runTransaction(async tx => {
      const snap = await tx.get(epRef);
      if (!snap.exists || snap.data().status !== 'closed' || snap.data().rewards_distributed) return false;
      tx.update(epRef, { rewards_distributed: true });
      return true;
    });
    if (!shouldProcess) return { ok: true };

    const subsSnap = await db.collection('submissions').where('episode_id', '==', episode_id).get();
    const allSubs = subsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const winners = allSubs.filter(s => s.is_adopted === true);

    for (const w of winners) {
      if (w.author_id && w.author_id !== FB_ADMIN_ID && w.author_id !== FB_AI_ID) {
        const uRef = db.collection('users').doc(w.author_id);
        await db.runTransaction(async tx => {
          const snap = await tx.get(uRef);
          if (!snap.exists) return;
          tx.update(uRef, { adoption_count: (snap.data().adoption_count || 0) + 1 });
        });
      }
      await _serverDistributePoints(db, w, allSubs);
    }
    return { ok: true };
  });

// ── MVP 공감 포인트 지급 (Callable — 공감한 사람이 아니라 글쓴이에게 점수가 가야 하는데,
//    그 지급을 클라이언트가 직접 하지 못하게 서버로 이전) ──
exports.grantMvpPoints = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const mvp_id = data.mvp_id;
    if (!mvp_id) throw new functions.https.HttpsError('invalid-argument', 'mvp_id가 필요합니다.');
    const db = admin.firestore();
    const mvpRef = db.collection('story_mvp').doc(mvp_id);

    const nominatedUserId = await db.runTransaction(async tx => {
      const snap = await tx.get(mvpRef);
      if (!snap.exists || snap.data().points_granted) return null;
      tx.update(mvpRef, { points_granted: true });
      return snap.data().nominated_user_id;
    });
    if (!nominatedUserId) return { ok: true };

    await _serverAddPoints(db, nominatedUserId, 10, 'mvp_nomination', '');
    return { ok: true };
  });
