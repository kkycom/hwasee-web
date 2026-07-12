const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const crypto    = require('crypto');
admin.initializeApp();

// (CI 자동배포 워크플로 동작 확인용 트리거 — 기능 변경 없음)

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

// ── 알림 푸시 발송: 배치(기본) ↔ 즉시, config/notification_settings.batch_enabled로
//    언제든지 되돌릴 수 있게 함(재배포 없이 Firestore 값 하나만 바꾸면 즉시 적용) ──
// - true(기본, 배치): 아래 sendBatchedPushNotifications가 2분마다 모아서 유저당
//   최대 1개 푸시로 합쳐 보냄. 여러 이야기가 비슷한 시점에 닫혀도(AI 마감 등)
//   한 유저가 여러 개의 별도 푸시를 우르르 받는 일이 없어짐 — 회차당 마감 개수
//   상한만으로는 이걸 보장 못 함(캡을 올려도 개인이 그중 여러 개에 걸쳐있으면
//   여전히 뭉텅이로 옴, 2026-07-08).
// - false(즉시, 롤백): sendPushOnNotification이 알림 생성 즉시 개별 발송(예전 방식).
//   AI 마감을 더 이상 안 써서(예: 실사용자만으로 운영) 알림이 몰릴 일이 없어지면,
//   지연 없는 즉시발송이 나을 수 있음 — 어드민 페이지 "AI 참여 설정"에서 토글 가능.
async function _notificationBatchEnabled(db) {
  const snap = await db.collection('config').doc('notification_settings').get();
  return snap.exists ? snap.data().batch_enabled !== false : true;
}

exports.sendPushOnNotification = functions
  .region('asia-northeast3')
  .firestore.document('notifications/{notifId}')
  .onCreate(async snap => {
    const db = admin.firestore();
    if (await _notificationBatchEnabled(db)) return null; // 배치 모드면 스케줄러가 처리 — 여기선 아무것도 안 함

    const notif = snap.data();
    if (!notif.user_id) return null;

    // Firebase CF는 at-least-once 실행 — 트랜잭션으로 중복 발송 방지
    try {
      const shouldSend = await db.runTransaction(async tx => {
        const current = await tx.get(snap.ref);
        if (!current.exists || current.data().push_sent) return false;
        tx.update(snap.ref, { push_sent: true });
        return true;
      });
      if (!shouldSend) return null;
    } catch (e) {
      return null;
    }

    const userSnap = await db.collection('users').doc(notif.user_id).get();
    if (!userSnap.exists) return null;
    const fcmToken = userSnap.data().fcm_token;
    if (!fcmToken) return null;

    const link = notif.link
      || (notif.story_id ? `https://hwasee.me/bang/#story/${notif.story_id}` : 'https://hwasee.me/bang/');

    try {
      await admin.messaging().send({
        token: fcmToken,
        data: {
          title: '화씨.방',
          body: notif.message,
          link,
          icon:  'https://hwasee.me/bang/icon-192.png',
          badge: 'https://hwasee.me/bang/icon-192.png',
        },
      });
    } catch (e) {
      if (e.code === 'messaging/registration-token-not-registered') {
        await db.collection('users').doc(notif.user_id).update({ fcm_token: admin.firestore.FieldValue.delete() });
      }
    }
    return null;
  });

exports.sendBatchedPushNotifications = functions
  .region('asia-northeast3')
  .pubsub.schedule('every 2 minutes')
  .onRun(async () => {
    const db = admin.firestore();
    if (!(await _notificationBatchEnabled(db))) return null; // 즉시발송 모드면 위 트리거가 이미 다 처리함

    const pendingSnap = await db.collection('notifications').where('push_sent', '==', false).get();
    if (pendingSnap.empty) return null;

    const byUser = {};
    pendingSnap.docs.forEach(d => {
      const n = d.data();
      if (!n.user_id) return;
      (byUser[n.user_id] = byUser[n.user_id] || []).push({ ref: d.ref, ...n });
    });

    await Promise.all(Object.entries(byUser).map(async ([user_id, notifs]) => {
      // 알림별로 트랜잭션 선점 — 스케줄러 실행이 겹치거나 at-least-once 재실행돼도
      // 같은 알림이 두 번 카운트/발송되지 않도록 함
      const claimed = [];
      for (const n of notifs) {
        const won = await db.runTransaction(async tx => {
          const snap = await tx.get(n.ref);
          if (!snap.exists || snap.data().push_sent) return false;
          tx.update(n.ref, { push_sent: true });
          return true;
        });
        if (won) claimed.push(n);
      }
      if (!claimed.length) return;

      const userSnap = await db.collection('users').doc(user_id).get();
      if (!userSnap.exists) return;
      const fcmToken = userSnap.data().fcm_token;
      if (!fcmToken) return;

      const single = claimed.length === 1;
      const first  = claimed[0];
      const link = single
        ? (first.link || (first.story_id ? `https://hwasee.me/bang/#story/${first.story_id}` : 'https://hwasee.me/bang/'))
        : 'https://hwasee.me/bang/';
      const body = single ? first.message : `새로운 소식이 ${claimed.length}개 있어요. 확인해보세요!`;

      // 의도적으로 top-level notification/webpush.notification 필드를 안 씀 —
      // 브라우저 자동표시 + sw.js onBackgroundMessage 수동표시가 겹쳐 알림이
      // 두 개씩 뜨던 버그가 있었음(커밋 83008d5). data-only로 유지.
      try {
        await admin.messaging().send({
          token: fcmToken,
          data: {
            title: '화씨.방',
            body,
            link,
            icon:  'https://hwasee.me/bang/icon-192.png',
            badge: 'https://hwasee.me/bang/icon-192.png',
          },
        });
      } catch (e) {
        if (e.code === 'messaging/registration-token-not-registered') {
          await db.collection('users').doc(user_id).update({ fcm_token: admin.firestore.FieldValue.delete() });
        }
      }
    }));
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
    // 이 트리거와 _serverCloseEpisode의 story.current_step 갱신 사이에 순서
    // 보장이 없어서, st.current_step을 직접 읽으면 레이스에 따라 +2가 될 수
    // 있음(그 +2 표시 버그가 실제로 있었음) — 방금 닫힌 이 에피소드 자체의
    // step은 불변이고 정의상 항상 이 값과 같으므로, 그걸 우선 사용해 레이스를 제거
    const nextStep  = Number(after.step) || ((Number(st.current_step) || 0) + 1);
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
          is_read: false, created_at: admin.firestore.Timestamp.now(), push_sent: false,
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
      // nextStep(= 이 트리거 시점에 이미 갱신된 st.current_step + 1)은 새로 열린
      // 에피소드의 step 번호와 같음 — 화면에 보이는 "N단계" 표시는 항상
      // calcDisplayStep(=epStep+1, 분기 없는 경우) 기준이라 여기도 +1만 더해야
      // 맞음. 예전엔 +2를 더해서 실제 페이지보다 항상 1단계 높게 표시되는
      // 버그가 있었음(유저 리포트로 확인: 알림은 "6단계"인데 실제로 들어가보면
      // "5단계"). 분기(다른 갈래) 상황에서도 새로 열리는 에피소드 자체의 표시
      // 단계는 동일하게 계산되므로 두 메시지 다 +1로 통일.
      const msg = winners.length > 1
        ? `"${snippet}" 이야기가 ${nextStep + 1}단계에서 ${winners.length}개 갈림길로 나뉘었어요!`
        : `"${snippet}" 이야기가 ${nextStep + 1}단계로 이어졌어요!`;
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
        push_sent:  false,
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

// 히든 업적 정의 — firebase-api.js의 FB_ACHIEVEMENTS와 반드시 동일하게 유지할 것
// (한쪽에 추가하면 반드시 반대쪽도 같이 수정). category는 users/{uid}의 카운터 필드명.
const FB_ACHIEVEMENTS = [
  { id: 'adopt_rookie',         category: 'adoption_count',      threshold: 30,  name: '채택루키',      avatar: '🎯' },
  { id: 'adopt_king',           category: 'adoption_count',      threshold: 100, name: '채택왕',        avatar: '🏅' },
  { id: 'prolific_rookie',      category: 'submission_count',    threshold: 30,  name: '다작루키',      avatar: '✍️' },
  { id: 'prolific_king',        category: 'submission_count',    threshold: 100, name: '다작왕',        avatar: '📚' },
  { id: 'closer_rookie',        category: 'closing_count',       threshold: 5,   name: '결말지기',      avatar: '🏁' },
  { id: 'closer_king',          category: 'closing_count',       threshold: 20,  name: '종결자',        avatar: '✂️' },
  { id: 'voter_rookie',         category: 'vote_count',          threshold: 50,  name: '심사위원 루키', avatar: '🗳️' },
  { id: 'voter_king',           category: 'vote_count',          threshold: 200, name: '심사위원장',    avatar: '⚖️' },
  { id: 'streak_rookie',        category: 'login_streak',        threshold: 7,   name: '성실루키',      avatar: '📅' },
  { id: 'streak_king',          category: 'login_streak',        threshold: 30,  name: '개근왕',        avatar: '💯' },
  { id: 'refine_rookie',        category: 'refine_count',        threshold: 10,  name: '다듬이 루키',   avatar: '🪄' },
  { id: 'refine_king',          category: 'refine_count',        threshold: 50,  name: '황금손',        avatar: '✨' },
  { id: 'seed_rookie',          category: 'seed_count',          threshold: 5,   name: '씨앗루키',      avatar: '🌿' },
  { id: 'seed_king',            category: 'seed_count',          threshold: 20,  name: '이야기 정원사', avatar: '🪴' },
  { id: 'referral_rookie',      category: 'referral_count',      threshold: 3,   name: '인싸루키',      avatar: '🤝' },
  { id: 'referral_king',        category: 'referral_count',      threshold: 10,  name: '인싸왕',        avatar: '📣' },
  { id: 'wordchallenge_rookie', category: 'word_challenge_wins', threshold: 5,   name: '장원 후보',     avatar: '🎲' },
  { id: 'wordchallenge_king',   category: 'word_challenge_wins', threshold: 10,  name: '단어의 신',     avatar: '🏆' },
];

async function _serverCheckAchievements(db, user_id, category, newValue) {
  if (!user_id || user_id === FB_ADMIN_ID || user_id === FB_AI_ID) return;
  const matches = FB_ACHIEVEMENTS.filter(a => a.category === category && newValue >= a.threshold);
  if (!matches.length) return;
  const uRef = db.collection('users').doc(user_id);
  for (const ach of matches) {
    const granted = await db.runTransaction(async tx => {
      const snap = await tx.get(uRef);
      if (!snap.exists) return false;
      const have = snap.data().achievements || [];
      if (have.includes(ach.id)) return false;
      const owned = snap.data().owned_avatars || [];
      tx.update(uRef, {
        achievements: [...have, ach.id],
        owned_avatars: owned.includes(ach.avatar) ? owned : [...owned, ach.avatar],
      });
      return true;
    });
    if (granted) {
      await db.collection('notifications').doc().set({
        user_id, type: 'achievement', story_id: '',
        message: `🏆 업적 달성: "${ach.name}"! 특별 아바타 ${ach.avatar}를 획득했어요`,
        link: '#profile/avatar', is_read: false, created_at: admin.firestore.Timestamp.now(), push_sent: false,
      });
    }
  }
}

// 카운터를 1 올리고 새 값 기준으로 업적을 체크. 실패해도 호출부(포인트 지급 등)에
// 영향 없도록 항상 try/catch로 감싸서 쓸 것.
async function _serverBumpAchievementCounter(db, user_id, category) {
  if (!user_id || user_id === FB_ADMIN_ID || user_id === FB_AI_ID) return;
  const uRef = db.collection('users').doc(user_id);
  const newValue = await db.runTransaction(async tx => {
    const snap = await tx.get(uRef);
    if (!snap.exists) return null;
    const v = (snap.data()[category] || 0) + 1;
    tx.update(uRef, { [category]: v });
    return v;
  });
  if (newValue != null) await _serverCheckAchievements(db, user_id, category, newValue);
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

  // 업적 카운터: 결말지기(내 글로 이야기가 완결됨)/다듬이(남의 글을 다듬어 채택됨).
  // 포인트 보너스 분기와 별개로, is_closing·derived_from 여부만으로 판단.
  try {
    if (winner.is_closing === true) await _serverBumpAchievementCounter(db, winner.author_id, 'closing_count');
    if (parent) await _serverBumpAchievementCounter(db, winner.author_id, 'refine_count');
  } catch (e) {}
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
    // 다듬기(derived_from) 체인 반영해서 분배 (누락되어 있던 부분 — 원작자
    // 없이 채택자에게 20점을 무조건 몰아주고 있었음)
    await _serverDistributePoints(db, w, allSubs);
    // 채택 횟수 반영 (누락되어 있던 부분 — AI가 마감시킨 경우 실제 채택자의
    // adoption_count가 하나도 안 올라가고 있었음)
    if (w.author_id && w.author_id !== FB_ADMIN_ID && w.author_id !== FB_AI_ID) {
      const uRef = db.collection('users').doc(w.author_id);
      const newAdoptCount = await db.runTransaction(async tx => {
        const snap = await tx.get(uRef);
        if (!snap.exists) return null;
        const v = (snap.data().adoption_count || 0) + 1;
        tx.update(uRef, { adoption_count: v });
        return v;
      });
      if (newAdoptCount != null) {
        try { await _serverCheckAchievements(db, w.author_id, 'adoption_count', newAdoptCount); } catch (e) {}
      }
    }
  }

  const storySnap = await db.collection('stories').doc(ep.story_id).get();
  if (!storySnap.exists) return;

  const st = storySnap.data();
  const nextStep = (Number(st.current_step) || 0) + 1;
  const anyClose = winners.some(w => w.is_closing === true);

  if (anyClose) {
    await storySnap.ref.update({ current_step: nextStep, status: 'completed' });
    // 3슬롯 "오늘의 이야기" 스포트라이트 리필 훅 — 방금 완결된 스토리가 스포트라이트
    // 슬롯을 차지하고 있었다면 다음 이야기로 즉시 교체. 사람/AI 마감 경로 모두
    // 이 함수를 거치므로(공용 단일 완결 지점) 여기가 정확한 훅 위치.
    try { await _serverRefillSpotlightSlot(db, ep.story_id); } catch (e) { console.error('spotlight refill error:', e.message); }

    // 동률 중 일부만 완결을 선택한 경우 — 완결 아닌 갈래는 그대로 묻히면 안
    // 되므로, else 분기와 동일하게 새 열린 에피소드를 만들어줌. 그래야 바로
    // 아래 "남은 open 에피소드 분리" 로직이 이걸 orphan으로 잡아서 독립
    // active 스토리로 즉시 분리해줌(기존엔 이 생성이 없어서 계속 쓰겠다고
    // 한 쪽 글이 채택은 되는데 이어갈 에피소드가 영영 안 생기던 버그였음).
    const nonClosingWinners = winners.filter(w => w.is_closing !== true);
    if (nonClosingWinners.length) {
      const openBatch = db.batch();
      nonClosingWinners.forEach(w => {
        const newEpId = db.collection('episodes').doc().id;
        openBatch.set(db.collection('episodes').doc(newEpId), {
          episode_id: newEpId, story_id: ep.story_id,
          step: nextStep + 1, parent_sub_id: w.id,
          status: 'open', vote_total: 0,
          created_at: new Date().toISOString(), closed_at: '', pending_at: '',
        });
      });
      await openBatch.commit();
    }

    // 남은 open 에피소드(다른 갈래)를 독립 active 스토리로 분리
    // (2026-07-06부터 이 함수가 사람/AI 마감 경로 공용 — 클라이언트엔 별도 사본 없음)
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
          // 분기(고아 에피소드) 시점의 참여자 수는 여기서 새로 세지 않고 부모
          // 스토리의 누적 participant_count를 그대로 물려받음 — branch_display_offset이
          // 단계 번호를 부모+분기 합산 기준으로 보여주는 것과 일관되게, 참여자 수도
          // "분기 이후 새로 온 사람만" 세면 실제보다 훨씬 적게 표시되는 문제가 있었음
          // (2026-07-08 유저 리포트: 표시상 6단계인데 참여자 4명 — 실제로는 분기 전
          // 부모 쪽에만 15명이 더 있었음). 이후 이 분기에 새 작성자가 오면 기존처럼
          // fbCreateSubmission의 increment(1)로 계속 누적됨.
          participant_count: Number(st.participant_count) || 0, like_count: 0, adoption_count: 0,
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

    // AI 참여를 껐다 켜는 사용 패턴 대응: 꺼둔 동안 여러 이야기가 동시에 마감 임계값을
    // 넘긴 채 쌓여있으면, 지터(위 subIntervalMsJ/voteIntervalMsJ)로는 이미 다 지나간
    // 시간 차이를 흡수 못해서 한 번의 실행에서 전부 마감돼 알림이 우르르 몰림(실측:
    // 11개 동시 마감 → 알림 22개). 회차(30분)당 마감 개수에 상한을 둬서 백로그를
    // 여러 실행에 걸쳐 자연스럽게 나눠 처리함.
    // ⚠️ 처음엔 2로 설정했다가, 실제로 한 이야기가 임계값 도달 후 거의 20시간
    // 동안 마감 못 하고 대기한 사례가 발생해서(2026-07-08, 유저 리포트) 5로
    // 올림 — 캡이 너무 낮으면 "우르르 몰림"은 막아도 개별 이야기가 지나치게
    // 오래 기다리는 부작용이 생김. 5 정도면 극단적 백로그(11개)도 3회
    // 실행(~1.5시간)이면 다 풀리면서, 평상시 개별 대기시간도 훨씬 짧아짐.
    // 캡에 걸려 이번 실행에 못 닫는 이야기가 생길 때 "누가 뽑히는지"는 예전엔
    // 매 실행마다 무작위로 섞어서 정했음(통계적으로는 공평하지만, 특정 이야기가
    // 운 나쁘게 계속 안 뽑힐 가능성 자체는 이론상 남아있었음) — 이제 마감 대상을
    // 먼저 전부 모아놓고 에피소드가 가장 오래 열려있던(FIFO) 순서로 캡만큼만
    // 실제로 닫아서, 개별 이야기의 최대 대기시간이 항상 정확히 계산 가능하게 함
    // (밀린 개수 ÷ MAX_CLOSES_PER_RUN × 30분).
    const MAX_CLOSES_PER_RUN = 5;
    const closeCandidates = []; // { episode_id, currentEp }

    for (const storyDoc of storiesSnap.docs) {
      try {
        const story_id = storyDoc.id;
        // 이야기별 지터(±25%) — 여러 이야기의 "다음 AI 투표/제출 시각" 타이머가
        // 같은 30분 스케줄 틱에 계속 겹쳐서(특히 비슷한 시간대에 시작된 이야기들)
        // 알림이 한꺼번에 우르르 도착하던 문제 완화 (속도개선방 진단, 2026-07-06).
        // 매 실행마다 새로 뽑아서 시간이 지날수록 타이머가 자연스럽게 흩어지게 함.
        const jitter = 0.75 + Math.random() * 0.5;
        const subIntervalMsJ  = subIntervalMs  * jitter;
        const voteIntervalMsJ = voteIntervalMs * jitter;
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
          if (now - effectiveLastSubAt >= subIntervalMsJ && aiSubs.length < 3) {
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
            ? now - lastSubAt >= voteIntervalMsJ
            : now - lastAiVoteAt >= voteIntervalMsJ;

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

              // 메모리상 vote_count도 갱신 — 아래 마감 여부 판단이 이번에 막 던진
              // 표까지 반영된 최신 값을 보도록 함
              const chosen = subs.find(s => s.id === chosenId);
              if (chosen) chosen.vote_count = (Number(chosen.vote_count) || 0) + 1;
              console.log(`AI voted ${chosenId} in ${episode_id}`);
            }
          }

          // 마감 여부는 "이번 실행에서 AI가 막 투표했는가"와 무관하게 항상 확인 —
          // 캡에 걸려 이번 실행에 마감 못 한 이야기도 다음 실행에서 여기로 다시
          // 걸려 재시도됨(투표 자체는 이미 끝난 상태라 voteIntervalMs 재대기 없이 감).
          // 실제로 지금 닫진 않고 후보로만 모아둠 — 아래에서 전체 후보 중 가장
          // 오래 열려있던(FIFO) 순서로 캡만큼만 실제로 닫음.
          const maxVoteCount = subs.reduce((m, s) => Math.max(m, Number(s.vote_count) || 0), 0);
          if (maxVoteCount >= AI_VOTE_THRESHOLD) {
            closeCandidates.push({ episode_id, currentEp });
          }
        }
      } catch (e) {
        console.error(`aiParticipate error for story ${storyDoc.id}:`, e.message);
      }
    }

    // 마감 대상 중 에피소드가 가장 먼저 열린(=가장 오래 기다린) 순서로 정렬해
    // 캡만큼만 실제로 마감 — 특정 이야기가 계속 안 뽑히는 일 없이 최대 대기시간이
    // 항상 (밀린 개수 ÷ MAX_CLOSES_PER_RUN × 30분)으로 보장됨.
    closeCandidates.sort((a, b) => new Date(a.currentEp.created_at) - new Date(b.currentEp.created_at));
    for (const { episode_id, currentEp } of closeCandidates.slice(0, MAX_CLOSES_PER_RUN)) {
      try {
        await _serverCloseEpisode(db, episode_id, currentEp);
      } catch (e) {
        console.error(`aiParticipate close error for episode ${episode_id}:`, e.message);
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

// ── 자격증명(user_secrets: token/pw_hash) 서버 이전 (Auth 마이그레이션 5단계) ──
// user_secrets 컬렉션이 인증 없이 완전 공개 상태였음(curl로 임의 유저의 세션 토큰/
// 비밀번호 해시를 그대로 읽을 수 있었고, 토큰을 훔쳐 localStorage에 심으면 비밀번호
// 없이 계정을 완전히 탈취할 수 있었음). 아래 6개 함수가 pw_hash/token을 만지는
// 모든 경로를 흡수하고, user_secrets는 이후 firestore.rules에서 완전 차단됨.
// pw_hash는 기존 클라이언트와 동일하게 무솔트 SHA-256(crypto.createHash)로 계산 —
// 기존 유저 데이터와 호환 유지, 별도 마이그레이션 불필요.

function _genSecretId() { return crypto.randomUUID(); }

exports.register = functions
  .region('asia-northeast3')
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', '인증 정보가 없습니다.');
    const nickname = (data.nickname || '').trim();
    const password = data.password || '';
    const name = data.name || '';
    const display_name = data.display_name || '';
    const referral = data.referral || '';
    const referrer_nickname = data.referrer_nickname || '';

    if (!nickname || !password) throw new functions.https.HttpsError('invalid-argument', '아이디와 비밀번호를 입력해주세요.');
    if (!/^[가-힣a-zA-Z0-9]{2,12}$/.test(nickname)) return { ok: false, error: '아이디는 2~12자, 한글·영문·숫자만 사용할 수 있어요.' };
    if (password.length < 8) return { ok: false, error: '비밀번호는 8자 이상입니다.' };
    const dn = (display_name || '').trim() || nickname;
    if (!/^[가-힣a-zA-Z0-9 ._-]{2,12}$/.test(dn)) return { ok: false, error: '닉네임은 2~12자, 한글·영문·숫자·공백·._- 만 사용할 수 있어요.' };

    const db = admin.firestore();
    const refNick = referrer_nickname.trim();
    const [dupId, dupDn, latestPatchSnap, referrerSnap] = await Promise.all([
      db.collection('users').where('nickname', '==', nickname).limit(1).get(),
      db.collection('users').where('display_name', '==', dn).limit(1).get(),
      db.collection('patch_notes').orderBy('created_at', 'desc').limit(1).get(),
      refNick ? db.collection('users').where('display_name', '==', refNick).limit(1).get() : Promise.resolve(null),
    ]);
    if (!dupId.empty) return { ok: false, error: '이미 사용 중인 아이디입니다.' };
    if (!dupDn.empty) return { ok: false, error: '이미 사용 중인 닉네임입니다.' };

    const user_id = _genSecretId();
    const token = _genSecretId();
    const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const initialSeenPatchId = latestPatchSnap.empty ? '' : latestPatchSnap.docs[0].data().patch_id;
    const referrerDoc = (referrerSnap && !referrerSnap.empty) ? referrerSnap.docs[0] : null;
    const pwHash = crypto.createHash('sha256').update(password).digest('hex');

    await Promise.all([
      db.collection('users').doc(user_id).set({
        user_id, nickname, display_name: dn,
        total_points: 0, adoption_count: 0, badge: 'seed', name: name.trim(),
        referral: referral.trim(), created_at: new Date().toISOString(),
        last_seen_patch_id: initialSeenPatchId,
        auth_uid: context.auth.uid,
      }),
      db.collection('user_secrets').doc(user_id).set({ pw_hash: pwHash, token, token_exp }),
    ]);

    // 추천인 보너스(관리자/AI 봇 제외) — 신규 가입자 본인 몫은 이 함수(Admin SDK)가
    // 이미 처리하므로, 추천인 몫도 같은 트랜잭션 성격으로 여기서 함께 지급(예전엔
    // 별도 grantReferralBonus 콜러블이 있었으나 이 함수로 완전히 흡수돼 삭제됨).
    // users/user_secrets는 이미 위에서 생성 완료된 뒤라, 이 블록이 실패해도(트랜잭션
    // 경합 등) 가입 자체가 통째로 에러로 끝나면 안 됨 — 계정은 이미 만들어졌는데
    // 응답만 실패로 오는 걸 막기 위해 통째로 try/catch (2026-07-07에 클라이언트에서
    // 한 번 겪었던 것과 같은 종류의 버그를 서버 이관 중 재도입할 뻔함)
    let referral_bonus = 0;
    if (referrerDoc && referrerDoc.id !== FB_ADMIN_ID && referrerDoc.id !== FB_AI_ID) {
      try {
        await _serverAddPoints(db, user_id, 50, 'referral_bonus', '');
        referral_bonus = 50;
        const shouldGrant = await db.runTransaction(async tx => {
          const snap = await tx.get(referrerDoc.ref);
          if (!snap.exists || snap.data().referral_bonus_claimed) return false;
          tx.update(referrerDoc.ref, { referral_bonus_claimed: true });
          return true;
        });
        if (shouldGrant) {
          await _serverAddPoints(db, referrerDoc.id, 50, 'referral_bonus', '');
          try { await _serverBumpAchievementCounter(db, referrerDoc.id, 'referral_count'); } catch (e) {}
        }
      } catch (e) { console.error('register referral bonus error:', e.message); }
    }

    return {
      ok: true, token, user_id, nickname, display_name: dn,
      total_points: referral_bonus, badge: 'seed', is_admin: user_id === FB_ADMIN_ID,
      referral_bonus, referral_not_found: !!refNick && !referrerDoc,
    };
  });

exports.login = functions
  .region('asia-northeast3')
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', '인증 정보가 없습니다.');
    const nickname = (data.nickname || '').trim();
    const password = data.password || '';
    if (!nickname || !password) throw new functions.https.HttpsError('invalid-argument', '닉네임과 비밀번호를 입력해주세요.');

    const db = admin.firestore();
    const snap = await db.collection('users').where('nickname', '==', nickname).limit(1).get();
    if (snap.empty) return { ok: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };

    const doc = snap.docs[0];
    const u = doc.data();
    const secSnap = await db.collection('user_secrets').doc(doc.id).get();
    const sec = secSnap.exists ? secSnap.data() : {};
    const pwHash = crypto.createHash('sha256').update(password).digest('hex');
    if (sec.pw_hash !== pwHash) return { ok: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };

    const token = _genSecretId();
    const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // 서버가 이미 비밀번호를 검증했으므로, 기존 rebindAuthUid와 동일한 근거로
    // context.auth.uid를 안전하게 (재)바인딩할 수 있음 — 기기 변경 케이스 포함.
    // 원래 클라이언트도 이 재바인딩을 .catch(()=>{})로 감싸 best-effort로 취급했음
    // (실패해도 로그인 자체는 계속 진행) — 같은 태도를 유지
    try {
      if (u.auth_uid !== context.auth.uid) {
        await doc.ref.update({ auth_uid: context.auth.uid, ...(u.display_name ? {} : { display_name: u.nickname }) });
      } else if (!u.display_name) {
        await doc.ref.update({ display_name: u.nickname });
      }
    } catch (e) { console.error('login auth_uid rebind error:', e.message); }
    await db.collection('user_secrets').doc(doc.id).set({ token, token_exp }, { merge: true });

    return {
      ok: true, token, user_id: u.user_id, nickname: u.nickname,
      display_name: u.display_name || u.nickname,
      total_points: u.total_points || 0, badge: u.badge || 'seed',
      is_admin: u.user_id === FB_ADMIN_ID,
      adoption_count: u.adoption_count || 0,
    };
  });

exports.verifySession = functions
  .region('asia-northeast3')
  .https.onCall(async (data, context) => {
    const user_id = data.user_id;
    const token = data.token;
    if (!user_id || !token) return { ok: false };
    const db = admin.firestore();
    const [snap, secSnap] = await Promise.all([
      db.collection('users').doc(user_id).get(),
      db.collection('user_secrets').doc(user_id).get(),
    ]);
    if (!snap.exists || !secSnap.exists) return { ok: false };
    const u = snap.data();
    const sec = secSnap.data();
    if (sec.token !== token) return { ok: false };
    if (new Date(sec.token_exp) < new Date()) {
      const new_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await secSnap.ref.update({ token_exp: new_exp });
    }
    // 세션이 확인된 시점에만 auth_uid를 부트 시 1회 백필(기존 클라이언트 백필과 동일 취지)
    if (context.auth && u.auth_uid !== context.auth.uid) {
      db.collection('users').doc(user_id).update({ auth_uid: context.auth.uid }).catch(() => {});
    }
    return {
      ok: true, user_id, nickname: u.nickname,
      display_name: u.display_name || u.nickname,
      total_points: u.total_points || 0, badge: u.badge || 'seed',
      adoption_count: u.adoption_count || 0,
    };
  });

exports.changePassword = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    const token = data.token;
    const current_password = data.current_password || '';
    const new_password = data.new_password || '';
    if (!user_id || !token) throw new functions.https.HttpsError('unauthenticated', '로그인이 필요합니다.');
    if (new_password.length < 8) return { ok: false, error: '비밀번호는 8자 이상이어야 합니다.' };

    const db = admin.firestore();
    const secRef = db.collection('user_secrets').doc(user_id);
    const secSnap = await secRef.get();
    if (!secSnap.exists || secSnap.data().token !== token) throw new functions.https.HttpsError('permission-denied', '로그인이 필요합니다.');
    const sec = secSnap.data();
    const curHash = crypto.createHash('sha256').update(current_password).digest('hex');
    if (sec.pw_hash !== curHash) return { ok: false, error: '현재 비밀번호가 올바르지 않습니다.' };

    // 비밀번호 변경의 목적 자체가 "혹시 모를 침해(토큰 유출 등) 대응"인데, pw_hash만
    // 바꾸고 기존 token을 그대로 두면 이미 유출된 토큰을 쥔 공격자는 계속 그 세션으로
    // 들어올 수 있어 방어 목적을 달성 못 함 — login과 동일하게 새 token을 발급해서
    // 기존 토큰을 함께 무효화하고, 이 기기가 끊기지 않도록 새 token을 응답에 포함
    const newHash = crypto.createHash('sha256').update(new_password).digest('hex');
    const newToken = _genSecretId();
    const newTokenExp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await secRef.update({ pw_hash: newHash, token: newToken, token_exp: newTokenExp });
    return { ok: true, token: newToken };
  });

exports.resetPassword = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const nickname = (data.nickname || '').trim();
    const name = (data.name || '').trim();
    const new_password = data.new_password || '';
    if (!nickname || !name || !new_password) return { ok: false, error: '모든 항목을 입력해주세요.' };
    if (new_password.length < 8) return { ok: false, error: '비밀번호는 8자 이상이어야 합니다.' };

    const db = admin.firestore();
    const snap = await db.collection('users').where('nickname', '==', nickname).limit(1).get();
    if (snap.empty) return { ok: false, error: '닉네임 또는 이름이 일치하지 않습니다.' };
    const doc = snap.docs[0];
    const u = doc.data();
    if (!u.name || u.name.trim() !== name) return { ok: false, error: '닉네임 또는 이름이 일치하지 않습니다.' };

    // changePassword와 동일한 이유로 token도 함께 무효화 — 이 플로우는 로그인 상태가
    // 아니라 새 token을 이 기기에 돌려줄 필요는 없음(다음 로그인에서 새로 발급됨)
    const newHash = crypto.createHash('sha256').update(new_password).digest('hex');
    await db.collection('user_secrets').doc(doc.id).set({
      pw_hash: newHash, token: _genSecretId(), token_exp: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }, { merge: true });
    return { ok: true };
  });

exports.deleteAccount = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    const token = data.token;
    const reason = data.reason || '';
    const detail = data.detail || '';
    if (!user_id || !token) throw new functions.https.HttpsError('unauthenticated', '로그인이 필요합니다.');
    if (user_id === FB_ADMIN_ID) return { ok: false, error: '관리자 계정은 탈퇴할 수 없습니다.' };

    const db = admin.firestore();
    const secSnap = await db.collection('user_secrets').doc(user_id).get();
    if (!secSnap.exists || secSnap.data().token !== token) throw new functions.https.HttpsError('permission-denied', '로그인이 필요합니다.');

    const batch = db.batch();
    batch.delete(db.collection('users').doc(user_id));
    batch.delete(db.collection('user_secrets').doc(user_id));
    const [bmSnap, nSnap] = await Promise.all([
      db.collection('bookmarks').where('user_id', '==', user_id).get(),
      db.collection('notifications').where('user_id', '==', user_id).get(),
    ]);
    bmSnap.docs.forEach(d => batch.delete(d.ref));
    nSnap.docs.forEach(d => batch.delete(d.ref));
    batch.set(db.collection('config').doc('stats'), { deleted_count: admin.firestore.FieldValue.increment(1) }, { merge: true });
    batch.set(db.collection('account_deletion_reasons').doc(_genSecretId()), {
      reason: reason.trim() || '미선택',
      detail: detail.trim(),
      deleted_at: new Date().toISOString(),
    });
    await batch.commit();
    return { ok: true };
  });

// ── 에피소드 마감 (Callable — 사람 투표로 임계값 도달 시 클라이언트가 호출.
//    _serverCloseEpisode는 원래 AI 자동참여 경로(aiParticipate)에서만 쓰던,
//    이미 검증된 마감/분기/완결 로직 — 브라우저 fire-and-forget 대신 서버에서
//    끝까지 안정적으로 완료되도록 사람 마감 경로도 동일 함수를 재사용함.
//    탭이 백그라운드로 넘어가거나 닫혀도 서버 실행은 계속 진행됨) ──
exports.closeEpisode = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const episode_id = data.episode_id;
    if (!episode_id) throw new functions.https.HttpsError('invalid-argument', 'episode_id가 필요합니다.');
    const db = admin.firestore();
    const epSnap = await db.collection('episodes').doc(episode_id).get();
    if (!epSnap.exists) return { ok: true };
    await _serverCloseEpisode(db, episode_id, epSnap.data());
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

// ── 연속 출석 끊김 방지 리마인더 푸시 (매일 저녁 9시, 아직 오늘 출석 안 한
//    연속 출석 중인 유저에게만) ──
exports.streakReminderPush = functions
  .region('asia-northeast3')
  .pubsub.schedule('every day 21:00')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    const db = admin.firestore();
    const today = new Date().toISOString().slice(0, 10);

    const usersSnap = await db.collection('users').where('login_streak', '>', 0).get();
    const targets = usersSnap.docs.filter(d => {
      const u = d.data();
      return u.last_daily_bonus_date !== today
        && u.fcm_token
        && d.id !== FB_ADMIN_ID
        && d.id !== FB_AI_ID;
    });

    await Promise.all(targets.map(async d => {
      const u = d.data();
      try {
        // top-level notification/webpush.notification 필드를 쓰면 브라우저가
        // 자동으로 한 번 표시하고 sw.js의 onBackgroundMessage가 또 한 번 수동
        // 표시해서 알림이 두 개씩 뜸(sendPushOnNotification에서 실제로 겪은
        // 버그, 커밋 83008d5) — 이 함수도 같은 패턴이라 data-only로 통일
        await admin.messaging().send({
          token: u.fcm_token,
          data: {
            title: '화씨.방',
            body: `🔥 지금 ${u.login_streak}일 연속 출석 중이에요! 오늘 놓치면 처음부터 다시 시작돼요.`,
            link: 'https://hwasee.me/bang/',
            icon:  'https://hwasee.me/bang/icon-192.png',
            badge: 'https://hwasee.me/bang/icon-192.png',
          },
        });
      } catch (e) {
        if (e.code === 'messaging/registration-token-not-registered') {
          await d.ref.update({ fcm_token: admin.firestore.FieldValue.delete() });
        }
      }
    }));
    return null;
  });

// ── 오늘의 단어 챌린지: 안 어울리는 단어 3개를 매일 던져주고 그걸로 문장을
//    지어 투표받는 이벤트. 씨앗 탭의 "명예의 전당" 자리를 대체함(2026-07-09).
//    라운드는 매일 00:00(KST) 시작 ~ 21:00(KST) 마감, 우승자(최다 득표, 동점이면
//    먼저 제출한 사람) 1명에게 100p 지급. from 인자 기준으로 "다음 21시(KST)"를
//    계산해서 end_at을 정하므로 관리자가 임의 시각에 수동 시작해도 안전함.
function _next9pmKST(from) {
  const kst = new Date(from.getTime() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth(), d = kst.getUTCDate(), h = kst.getUTCHours();
  const targetDay = h >= 21 ? d + 1 : d;
  const targetKst = new Date(Date.UTC(y, m, targetDay, 21, 0, 0));
  return new Date(targetKst.getTime() - 9 * 3600 * 1000);
}

// 관리자가 세트를 직접 등록하지 않아도 매일 새 조합이 나오도록 미리 심어둔
// "안 어울리는 단어 3개" 세트 — index.html의 FB_AI_OPENINGS(씨앗 이야기 자동
// 시딩)와 같은 취지. 50개를 다 쓰면 config/word_challenge_seed_state.next_index로
// 처음부터 순환 재사용(하루짜리 가벼운 이벤트라 반복돼도 크게 문제 없음).
const WORD_CHALLENGE_SEED_SETS = [
  ['냉장고','우주비행사','젓가락'], ['지하철','공룡','립스틱'], ['우산','해적','계산기'],
  ['코끼리','와이파이','도자기'], ['산타클로스','잠수함','양파'], ['형광펜','늑대','결혼식'],
  ['로봇청소기','무지개','곰탕'], ['타자기','열대어','등산화'], ['마법사','택배','냄비'],
  ['선인장','경찰차','트럼펫'], ['미라','자전거','초콜릿'], ['번개','도서관','문어'],
  ['축구공','유령','젤리'], ['낙타','계단','헤드폰'], ['벚꽃','잠망경','만두'],
  ['사이렌','고양이','여권'], ['폭포','넥타이','좀비'], ['불꽃놀이','개미','안경'],
  ['피아노','상어','배낭'], ['눈사람','스파이','삼겹살'], ['등대','로켓','젓갈'],
  ['유니콘','신호등','냉면'], ['회전목마','문신','감자'], ['도깨비','헬리콥터','치즈'],
  ['파도','마이크','곰인형'], ['화산','우체통','국수'], ['시계탑','상어','붕어빵'],
  ['캥거루','지팡이','라면'], ['오로라','소방차','만두피'], ['인어','냉동고','우비'],
  ['벽난로','스케이트보드','참치'], ['은하수','대나무','오리'], ['미로','콘서트','젓가락'],
  ['다이너마이트','튤립','순대'], ['미어캣','콘센트','도넛'], ['산호초','우주선','뻥튀기'],
  ['폭탄','발레리나','냉장고'], ['거미줄','트램펄린','만두국'], ['빙하','색소폰','짜장면'],
  ['나침반','도깨비불','붕대'], ['화석','스노클','계란빵'], ['눈보라','마술사','순두부'],
  ['사막','잠수정','볼펜'], ['얼음낚시','롤러코스터','젤리'], ['부엉이','헬멧','딸기'],
  ['폭죽','미로찾기','감자탕'], ['오르골','산악자전거','콩나물'], ['은하계','태권도','소시지'],
  ['늪','우주정거장','도장'], ['화살표','곰돌이','라볶이'],
];

// 중복 라운드 생성 방지("이미 진행 중인지 확인" → "세트 소진" → "라운드 생성")를
// 하나의 트랜잭션으로 묶어서 원자적으로 처리 — 예전엔 각 단계가 별개 읽기/쓰기라서
// 관리자가 "지금 바로 시작" 버튼을 빠르게 두 번 누르거나(혹은 콜러블 SDK가 네트워크
// 문제로 자동 재시도하는 경우) 두 요청이 동시에 "진행 중인 라운드 없음"을 확인하고
// 둘 다 통과해버려 세트를 2개 이상 소진하고 활성 라운드가 중복 생성될 수 있었음
// (실제로 2026-07-09 관리자가 버튼을 여러 번 눌러서 겪음).
async function _serverStartWordChallenge(db) {
  const now = new Date();
  await db.runTransaction(async tx => {
    const activeSnap = await tx.get(db.collection('word_challenges').where('status', '==', 'active').limit(1));
    if (!activeSnap.empty) return; // 이미 진행 중인 라운드가 있으면 중복 생성 방지

    const setsSnap = await tx.get(db.collection('word_challenge_sets').orderBy('created_at', 'asc').limit(500));
    const nextSet = setsSnap.docs.find(d => !d.data().used);

    let words, seedStateRef = null, seedStateSnap = null, seedIdx = 0;
    if (nextSet) {
      words = nextSet.data().words;
    } else {
      seedStateRef = db.collection('config').doc('word_challenge_seed_state');
      seedStateSnap = await tx.get(seedStateRef);
      seedIdx = (seedStateSnap.exists ? Number(seedStateSnap.data().next_index) || 0 : 0) % WORD_CHALLENGE_SEED_SETS.length;
      words = WORD_CHALLENGE_SEED_SETS[seedIdx];
    }

    if (nextSet) tx.update(nextSet.ref, { used: true });
    else tx.set(seedStateRef, { next_index: seedIdx + 1 }, { merge: true });

    tx.set(db.collection('word_challenges').doc(), {
      date: new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10),
      words,
      status: 'active',
      start_at: now.toISOString(),
      end_at: _next9pmKST(now).toISOString(),
      winner_user_id: null,
      winner_submission_id: null,
      winner_nickname: null,
      winner_text: null,
      winner_vote_count: null,
      submission_count: 0,
      closed_at: null,
    });
  });
}

// 동률이면 100p를 인원수만큼 나눠 지급(예: 2명 동률 → 각 50p). 투표가 저조해서
// 동률이 자주 나올 수 있어 도입 — 예전엔 동률이어도 먼저 제출한 사람 1명이
// 전액을 가져갔음. 구버전(단일 winner_* 필드)으로 이미 마감된 과거 기록은
// 그대로 두고, 이번부터 닫히는 챌린지는 winners 배열로 저장.
async function _serverCloseWordChallenge(db) {
  const activeSnap = await db.collection('word_challenges').where('status', '==', 'active').limit(5).get();
  for (const doc of activeSnap.docs) {
    const challenge_id = doc.id;
    const subsSnap = await db.collection('word_challenge_submissions')
      .where('challenge_id', '==', challenge_id).get();

    const allSubs = subsSnap.docs.map(d => ({ submission_id: d.id, ...d.data() }));
    const maxVotes = allSubs.length ? Math.max(...allSubs.map(s => s.vote_count || 0)) : 0;
    const tiedWinners = allSubs
      .filter(s => (s.vote_count || 0) === maxVotes)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const share = tiedWinners.length ? Math.round(100 / tiedWinners.length) : 0;

    const patch = { status: 'closed', closed_at: new Date().toISOString(), submission_count: subsSnap.size, winners: [] };
    if (tiedWinners.length) {
      const nickCache = {};
      for (const w of tiedWinners) {
        if (!nickCache[w.user_id]) {
          const uSnap = await db.collection('users').doc(w.user_id).get();
          nickCache[w.user_id] = uSnap.exists ? (uSnap.data().display_name || uSnap.data().nickname) : '익명';
        }
      }
      patch.winners = tiedWinners.map(w => ({
        user_id: w.user_id, submission_id: w.submission_id, text: w.text,
        nickname: nickCache[w.user_id], vote_count: w.vote_count || 0, points: share,
      }));
      patch.winner_vote_count = maxVotes;
    }
    await doc.ref.update(patch);

    for (const w of tiedWinners) {
      await _serverAddPoints(db, w.user_id, share, 'word_challenge_win', w.submission_id);
      try { await _serverBumpAchievementCounter(db, w.user_id, 'word_challenge_wins'); } catch (e) {}
    }

    // 스포트라이트 슬롯1(🎲) FIFO 풀에 채택 문장 적재 — 동률이어도 같은 라운드는
    // 같은 3단어라서 대표 1개만(가장 먼저 제출된 것) 넣음. 그대로 다 넣으면
    // 같은 단어 조합이 스포트라이트에 연달아 노출되는 문제가 있어서.
    if (tiedWinners.length) {
      await db.collection('spotlight_word_pool').doc().set({
        text: tiedWinners[0].text, source_challenge_id: challenge_id, used: false,
        created_at: new Date().toISOString(),
      });
      try { await _serverRefillSlotFromPoolIfEmpty(db, 'word'); } catch (e) {}
    }
  }
}

exports.startWordChallenge = functions
  .region('asia-northeast3')
  .pubsub.schedule('every day 00:00')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    await _serverStartWordChallenge(admin.firestore());
    return null;
  });

exports.closeWordChallenge = functions
  .region('asia-northeast3')
  .pubsub.schedule('every day 21:00')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    await _serverCloseWordChallenge(admin.firestore());
    return null;
  });

exports.adminForceStartWordChallenge = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    if (data.admin_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
    await _serverStartWordChallenge(admin.firestore());
    return { ok: true };
  });

exports.adminForceCloseWordChallenge = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    if (data.admin_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
    await _serverCloseWordChallenge(admin.firestore());
    return { ok: true };
  });

// ── 3슬롯 "오늘의 이야기" 스포트라이트 ────────────────────────
// config/spotlight_slots = { word:{story_id}, sentence:{story_id,state,round_id}, ai:{story_id} }
// 완결 훅(_serverCloseEpisode)이 슬롯 스토리 완결을 감지해 다음 이야기로 즉시 교체함.

// firebase-api.js의 FB_AI_OPENINGS(1162행~)와 반드시 동일하게 유지할 것
// (한쪽에 추가하면 반드시 반대쪽도 같이 수정) — FB_ACHIEVEMENTS와 같은 이유로,
// 서버는 별도 배포 단위라 클라이언트 파일을 참조할 수 없어 사본을 둠.
const SPOTLIGHT_AI_OPENINGS = [
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

// stories/episodes 문서 생성 공통 헬퍼 — fbCreateStory(firebase-api.js:786)와 동일한
// shape. writer는 tx 또는 batch(둘 다 .set(ref,data) 시그니처가 같아 그대로 재사용 가능).
// 스포트라이트로 시작되는 이야기는 특정 개인 소유가 아니라 시스템이 심은 것이라
// creator_id를 항상 FB_AI_ID로 둠(슬롯1/2도 채택/포인트 지급은 이미 챌린지·라운드
// 마감 시점에 끝났으므로, 스토리 자체의 창작자 귀속은 기존 AI씨앗과 동일 취급).
function _serverCreateSeedStory(db, writer, opening) {
  const story_id = db.collection('stories').doc().id;
  const episode_id = db.collection('episodes').doc().id;
  writer.set(db.collection('stories').doc(story_id), {
    story_id, opening: opening.trim(), max_steps: 10, current_step: 0,
    status: 'active', creator_id: FB_AI_ID, creator_nickname: '익명', creator_badge: '',
    created_at: new Date().toISOString(), batch: '', participant_count: 0, like_count: 0,
    is_ai_seed: true,
  });
  writer.set(db.collection('episodes').doc(episode_id), {
    episode_id, story_id, step: 1, parent_sub_id: '',
    status: 'open', vote_total: 0, created_at: new Date().toISOString(), closed_at: '', pending_at: '',
  });
  return story_id;
}

// 슬롯 스토리 완결 시 호출(_serverCloseEpisode 참고) — 완결된 스토리가 실제로
// 스포트라이트 슬롯을 차지하고 있었는지 확인 후, 맞다면 다음 이야기로 즉시 교체.
// word_challenge_sets의 "미리 읽어서 JS에서 필터" 방식(_serverStartWordChallenge
// 참고)을 그대로 써서 (used==false + orderBy) 복합 인덱스 없이 처리.
async function _serverRefillSpotlightSlot(db, completed_story_id) {
  const ptrRef = db.collection('config').doc('spotlight_slots');
  await db.runTransaction(async tx => {
    const ptrSnap = await tx.get(ptrRef);
    if (!ptrSnap.exists) return; // adminInitSpotlight 실행 전 — 아직 스포트라이트 미도입
    const slots = ptrSnap.data();
    const slotKey = ['word', 'sentence', 'ai'].find(k => slots[k] && slots[k].story_id === completed_story_id);
    if (!slotKey) return; // 스포트라이트 슬롯 스토리가 아님

    if (slotKey === 'ai') {
      const usedSnap = await tx.get(db.collection('config').doc('used_openings'));
      const used = usedSnap.exists ? usedSnap.data() : {};
      const available = SPOTLIGHT_AI_OPENINGS.filter(o => !used[o]);
      const src = available.length ? available : SPOTLIGHT_AI_OPENINGS;
      const opening = src[Math.floor(Math.random() * src.length)];
      const newStoryId = _serverCreateSeedStory(db, tx, opening);
      tx.set(db.collection('config').doc('used_openings'), { [opening]: true }, { merge: true });
      tx.update(ptrRef, { 'ai.story_id': newStoryId });
      return;
    }

    const poolName = slotKey === 'word' ? 'spotlight_word_pool' : 'spotlight_sentence_pool';
    const poolSnap = await tx.get(db.collection(poolName).orderBy('created_at', 'asc').limit(50));
    const nextEntry = poolSnap.docs.find(d => !d.data().used);

    if (!nextEntry) {
      if (slotKey === 'word') {
        tx.update(ptrRef, { 'word.story_id': null });
      } else {
        // 채택 풀이 비어있으면(아직 이만큼 라운드가 안 쌓였음) 24시간 제안+투표
        // 라운드를 새로 염 — round_id는 이 시점엔 항상 비어있는 상태에서 옴
        // (스토리 진행 중엔 round_id를 null로 유지하는 불변식이라 별도 상태
        // 확인 없이 바로 새 라운드를 열어도 안전).
        const roundRef = db.collection('sentence_rounds').doc();
        const now = new Date();
        tx.set(roundRef, {
          round_id: roundRef.id, status: 'active',
          start_at: now.toISOString(), end_at: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
          submission_count: 0, winners: [], closed_at: null,
        });
        tx.update(ptrRef, { 'sentence.story_id': null, 'sentence.state': 'proposing', 'sentence.round_id': roundRef.id });
      }
      return;
    }

    tx.update(nextEntry.ref, { used: true });
    const newStoryId = _serverCreateSeedStory(db, tx, nextEntry.data().text);
    if (slotKey === 'word') {
      tx.update(ptrRef, { 'word.story_id': newStoryId });
    } else {
      tx.update(ptrRef, { 'sentence.story_id': newStoryId, 'sentence.state': 'story', 'sentence.round_id': null });
    }
  });
}

// slotKey('word'|'sentence')의 풀에 새 항목이 막 쌓였을 때, 그 슬롯이 마침 비어있는
// 상태(story_id==null)였다면 바로 채워줌 — _serverCloseWordChallenge(슬롯1 풀 적재
// 직후)와 closeSentenceRounds(슬롯2 라운드 마감 직후)에서 호출. 이 두 호출 시점엔
// 슬롯이 이미 story_id==null 상태로 놓여 있었을 때만 의미가 있어(그 외엔 손대지
// 않고 조용히 반환), _serverRefillSpotlightSlot과 트랜잭션이 겹칠 일이 없음.
async function _serverRefillSlotFromPoolIfEmpty(db, slotKey) {
  const ptrRef = db.collection('config').doc('spotlight_slots');
  await db.runTransaction(async tx => {
    const ptrSnap = await tx.get(ptrRef);
    if (!ptrSnap.exists) return;
    const slot = ptrSnap.data()[slotKey];
    if (!slot || slot.story_id) return; // 이미 진행 중인 스토리가 있으면 손대지 않음

    const poolName = slotKey === 'word' ? 'spotlight_word_pool' : 'spotlight_sentence_pool';
    const poolSnap = await tx.get(db.collection(poolName).orderBy('created_at', 'asc').limit(50));
    const nextEntry = poolSnap.docs.find(d => !d.data().used);

    if (!nextEntry) {
      // 슬롯2는 라운드가 방금 닫혔는데(호출 시점상 항상 그러함) 제출이 하나도
      // 없어서 채택 풀도 비었을 수 있음 — 그대로 방치하면 영영 안 채워지므로
      // 새 24시간 라운드를 다시 염.
      if (slotKey === 'sentence') {
        const roundRef = db.collection('sentence_rounds').doc();
        const now = new Date();
        tx.set(roundRef, {
          round_id: roundRef.id, status: 'active',
          start_at: now.toISOString(), end_at: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
          submission_count: 0, winners: [], closed_at: null,
        });
        tx.update(ptrRef, { 'sentence.state': 'proposing', 'sentence.round_id': roundRef.id });
      }
      return;
    }

    tx.update(nextEntry.ref, { used: true });
    const newStoryId = _serverCreateSeedStory(db, tx, nextEntry.data().text);
    if (slotKey === 'word') {
      tx.update(ptrRef, { 'word.story_id': newStoryId });
    } else {
      tx.update(ptrRef, { 'sentence.story_id': newStoryId, 'sentence.state': 'story', 'sentence.round_id': null });
    }
  });
}

// 슬롯2(✍️) 24시간 제안+투표 라운드 마감 — word_challenge는 "매일 00시 시작→21시
// 마감" 고정 cron이지만, 이 라운드는 "슬롯 스토리가 완결되는 시점"이 이벤트
// 트리거라 고정 시각 cron을 못 씀. 대신 aiParticipate(828행~)처럼 주기적으로
// end_at 지난 라운드를 찾아 정산 + sendBatchedPushNotifications(107행~)의
// 트랜잭션 claim 관용구로 중복 마감 방지.
exports.closeSentenceRounds = functions
  .region('asia-northeast3')
  .pubsub.schedule('every 30 minutes')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    const db = admin.firestore();
    const MAX_ROUND_CLOSES_PER_RUN = 5;
    const activeSnap = await db.collection('sentence_rounds').where('status', '==', 'active').limit(MAX_ROUND_CLOSES_PER_RUN).get();
    const now = Date.now();

    for (const doc of activeSnap.docs) {
      const round = doc.data();
      if (new Date(round.end_at).getTime() > now) continue;

      const claimed = await db.runTransaction(async tx => {
        const snap = await tx.get(doc.ref);
        if (!snap.exists || snap.data().status !== 'active') return false;
        tx.update(doc.ref, { status: 'closed', closed_at: new Date().toISOString() });
        return true;
      });
      if (!claimed) continue;

      const subsSnap = await db.collection('sentence_round_submissions').where('round_id', '==', doc.id).get();
      const allSubs = subsSnap.docs.map(d => ({ submission_id: d.id, ...d.data() }));
      // 1등뿐 아니라 1~3등까지 채택 — 슬롯이 빌 때 마침 새 라운드가 끝나있으리란
      // 보장이 없어 여유분을 확보하는 목적
      const top = allSubs
        .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0) || new Date(a.created_at) - new Date(b.created_at))
        .slice(0, 3);

      if (top.length) {
        const nickCache = {};
        for (const w of top) {
          if (!nickCache[w.user_id]) {
            const uSnap = await db.collection('users').doc(w.user_id).get();
            nickCache[w.user_id] = uSnap.exists ? (uSnap.data().display_name || uSnap.data().nickname) : '익명';
          }
        }
        const winners = top.map(w => ({
          user_id: w.user_id, submission_id: w.submission_id, text: w.text,
          nickname: nickCache[w.user_id], vote_count: w.vote_count || 0,
        }));
        await doc.ref.update({ winners });

        for (const w of top) {
          await db.collection('spotlight_sentence_pool').doc().set({
            text: w.text, proposer_id: w.user_id, round_id: doc.id, used: false,
            created_at: new Date().toISOString(),
          });
          // 채택 포인트는 실제로 문장이 풀에서 소진돼 쓰일 때가 아니라 라운드
          // 마감 시 즉시 지급(유저 확정, 2026-07-12) — word_challenge 마감과
          // 같은 코드 경로에 붙어 있어 일관되고, 선정됐는데 나중에 안 쓰인다고
          // 보상을 못 받는 경우가 없음.
          await _serverAddPoints(db, w.user_id, 50, 'spotlight_sentence_pick', w.submission_id);
        }
      }

      try { await _serverRefillSlotFromPoolIfEmpty(db, 'sentence'); } catch (e) {}
    }
    return null;
  });

// 스포트라이트 최초 도입 시 1회 실행 — 포인터 doc이 없으면 3슬롯이 전부 비어
// 보이므로, 관리자가 배포 후 한 번 호출해 3슬롯을 AI 씨앗으로 부트스트랩함.
// 이후로는 각 슬롯의 지정된 소스(단어챌린지 풀/제안투표 풀/AI 랜덤픽)가 이어받음.
exports.adminInitSpotlight = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    if (data.admin_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
    const db = admin.firestore();
    const ptrRef = db.collection('config').doc('spotlight_slots');
    const ptrSnap = await ptrRef.get();
    if (ptrSnap.exists && ptrSnap.data().initialized) return { ok: true, already: true };

    const usedSnap = await db.collection('config').doc('used_openings').get();
    const used = usedSnap.exists ? usedSnap.data() : {};
    const available = SPOTLIGHT_AI_OPENINGS.filter(o => !used[o]);
    const src = available.length >= 3 ? available.slice() : SPOTLIGHT_AI_OPENINGS.slice();
    const picked = [];
    while (picked.length < 3) {
      const idx = Math.floor(Math.random() * src.length);
      picked.push(src.splice(idx, 1)[0]);
    }
    const [op1, op2, op3] = picked;

    const batch = db.batch();
    const wordStoryId = _serverCreateSeedStory(db, batch, op1);
    const sentenceStoryId = _serverCreateSeedStory(db, batch, op2);
    const aiStoryId = _serverCreateSeedStory(db, batch, op3);
    batch.set(db.collection('config').doc('used_openings'), { [op1]: true, [op2]: true, [op3]: true }, { merge: true });
    batch.set(ptrRef, {
      word: { story_id: wordStoryId },
      sentence: { story_id: sentenceStoryId, state: 'story', round_id: null },
      ai: { story_id: aiStoryId },
      initialized: true,
    });
    await batch.commit();
    return { ok: true, word_story_id: wordStoryId, sentence_story_id: sentenceStoryId, ai_story_id: aiStoryId };
  });

// ── 업적 시스템 도입 이전 활동 소급 반영 (1회성 관리자 콜러블) ──
// adoption_count/login_streak는 원래 있던 필드라 현재값 그대로 판정하면 되지만,
// 나머지 7개 카운터(제출/투표/씨앗/다듬기/결말/초대/단어챌린지)는 이번에 새로
// 만든 필드라 기존 유저 전부 0부터 시작함 — 실제 컬렉션을 스캔해서 카운터
// 필드를 실측값으로 채워넣고, 그 값 기준으로 이미 달성한 업적을 지급함.
// 멱등성 있음(중복 실행해도 안전 — 카운터는 더 큰 값으로만 갱신, 업적은
// achievements 배열로 중복 지급 방지) — 실수로 두 번 눌러도 문제 없음.
exports.adminBackfillAchievements = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 300 })
  .https.onCall(async (data) => {
    if (data.admin_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
    const db = admin.firestore();

    const [usersSnap, subsSnap, votesSnap, storiesSnap, ledgerSnap, wcSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('submissions').get(),
      db.collection('votes').get(),
      db.collection('stories').get(),
      db.collection('point_ledger').get(),
      db.collection('word_challenges').where('status', '==', 'closed').get(),
    ]);

    const submissionCountByUser = {};
    const closingCountByUser = {};
    const refineCountByUser = {};
    subsSnap.docs.forEach(d => {
      const s = d.data();
      if (s.is_ai || !s.author_id) return;
      submissionCountByUser[s.author_id] = (submissionCountByUser[s.author_id] || 0) + 1;
      if (s.is_adopted && s.is_closing === true) closingCountByUser[s.author_id] = (closingCountByUser[s.author_id] || 0) + 1;
      if (s.is_adopted && s.derived_from) refineCountByUser[s.author_id] = (refineCountByUser[s.author_id] || 0) + 1;
    });

    // 투표는 "몇 표를 던졌나"가 아니라 "몇 개의 서로 다른 에피소드에 투표했나"로 셈
    // (재투표는 새 투표로 안 침 — 라이브 카운터와 동일한 기준)
    const voteEpisodesByUser = {};
    votesSnap.docs.forEach(d => {
      const v = d.data();
      if (!v.voter_id || !v.episode_id) return;
      (voteEpisodesByUser[v.voter_id] = voteEpisodesByUser[v.voter_id] || new Set()).add(v.episode_id);
    });

    const seedCountByUser = {};
    storiesSnap.docs.forEach(d => {
      const s = d.data();
      if (s.is_ai_seed || !s.creator_id) return;
      seedCountByUser[s.creator_id] = (seedCountByUser[s.creator_id] || 0) + 1;
    });

    const referralCountByUser = {};
    // 출석 마일스톤(5/10/20/30일) 로그로 과거 최고 연속출석의 하한선을 역산
    // (예: login_streak_10 기록이 있으면 그 유저는 최소 10일까지는 갔었다는 뜻이고,
    // 도중에 반드시 7일도 지나쳤을 것이므로 streak_rookie(7) 판정에 안전하게 씀)
    const streakMilestoneByUser = {};
    ledgerSnap.docs.forEach(d => {
      const l = d.data();
      if (!l.user_id) return;
      if (l.reason === 'referral_bonus') referralCountByUser[l.user_id] = (referralCountByUser[l.user_id] || 0) + 1;
      const m = /^login_streak_(\d+)$/.exec(l.reason || '');
      if (m) streakMilestoneByUser[l.user_id] = Math.max(streakMilestoneByUser[l.user_id] || 0, Number(m[1]));
    });

    const wcWinCountByUser = {};
    wcSnap.docs.forEach(d => {
      const w = d.data();
      if (w.winner_user_id) wcWinCountByUser[w.winner_user_id] = (wcWinCountByUser[w.winner_user_id] || 0) + 1;
    });

    let processed = 0;
    for (const uDoc of usersSnap.docs) {
      const uid = uDoc.id;
      if (uid === FB_ADMIN_ID || uid === FB_AI_ID) continue;
      const u = uDoc.data();

      const counters = {
        submission_count: submissionCountByUser[uid] || 0,
        closing_count: closingCountByUser[uid] || 0,
        refine_count: refineCountByUser[uid] || 0,
        vote_count: voteEpisodesByUser[uid] ? voteEpisodesByUser[uid].size : 0,
        seed_count: seedCountByUser[uid] || 0,
        referral_count: referralCountByUser[uid] || 0,
        word_challenge_wins: wcWinCountByUser[uid] || 0,
      };

      const patch = {};
      Object.entries(counters).forEach(([k, v]) => { if (v > (u[k] || 0)) patch[k] = v; });
      if (Object.keys(patch).length) await uDoc.ref.update(patch);

      const checks = [
        ['adoption_count', u.adoption_count || 0],
        ['login_streak', Math.max(u.login_streak || 0, streakMilestoneByUser[uid] || 0)],
        ...Object.entries(counters),
      ];
      for (const [cat, val] of checks) {
        if (val > 0) await _serverCheckAchievements(db, uid, cat, val);
      }
      processed++;
    }
    return { ok: true, processed };
  });

// ── 임시 진단용(1회성) — 유저가 "테스트 라운드가 시간 좀 지나니까 사라졌다"고
//    제보해서 실제 word_challenges 기록을 눈으로 확인하기 위해 추가. 원인
//    파악되면 제거할 것. ──
exports.adminDebugWordChallenges = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    if (data.admin_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
    const db = admin.firestore();
    const snap = await db.collection('word_challenges').orderBy('start_at', 'desc').limit(8).get();
    const challenges = await Promise.all(snap.docs.map(async d => {
      const c = d.data();
      const subsSnap = await db.collection('word_challenge_submissions').where('challenge_id', '==', d.id).get();
      return {
        id: d.id, date: c.date, words: c.words, status: c.status,
        start_at: c.start_at, end_at: c.end_at, closed_at: c.closed_at,
        winner_nickname: c.winner_nickname, winner_text: c.winner_text,
        submission_count_field: c.submission_count, actual_submission_count: subsSnap.size,
      };
    }));
    return { ok: true, now: new Date().toISOString(), challenges };
  });

// ── 전 유저 세션 토큰 강제 무효화 (Callable, 관리자 전용 — 사고 대응용 일회성 도구) ──
// user_secrets가 한동안 인증 없이 완전 공개돼 있었던 사고(2026-07-10 firestore.rules
// 차단 이전) 대응. 그 기간에 이미 유출됐을 수 있는 token은 30일 만료 전까진 계속
// 유효하므로, firestore.rules로 읽기를 막아도 "이미 퍼진 옛날 토큰" 자체는 죽지
// 않음 — 전 유저의 token을 한 번에 새 값으로 교체해 강제 재로그인시켜야 완전히 무력화됨.
// user_secrets 규칙 차단(`allow read, write: if false` 배포) 이후에 실행할 것 —
// 차단 전에 실행하면 새로 발급된 토큰도 그대로 다시 읽혀서 의미가 없음.
exports.adminInvalidateAllSessions = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 300 })
  .https.onCall(async (data) => {
    if (data.admin_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
    const db = admin.firestore();
    const snap = await db.collection('user_secrets').get();
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      docs.slice(i, i + 400).forEach(d => {
        batch.update(d.ref, { token: _genSecretId(), token_exp: new Date().toISOString() });
      });
      await batch.commit();
    }
    return { ok: true, invalidated: docs.length };
  });

// 재배포 트리거(진단 함수 삭제분 반영용)

