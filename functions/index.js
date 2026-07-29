const functions   = require('firebase-functions');
const admin       = require('firebase-admin');
const crypto      = require('crypto');
const nodemailer  = require('nodemailer');
// @google-analytics/data는 여기서 top-level require 안 함 — 이 파일의 모든
// Cloud Functions가 하나의 모듈을 공유해서 top-level require는 어떤 함수가
// 호출되든 매 콜드스타트마다 실행됨. gRPC/protobuf를 끌고 오는 무거운 패키지를
// 어쩌다 한 번 쓰는 관리자 전용 GA4 함수 때문에 로그인 등 나머지 함수 전체의
// 콜드스타트가 느려지면 안 되므로, 실제로 쓰는 함수 안에서만 지연 require.
admin.initializeApp();

// (CI 자동배포 워크플로 동작 확인용 트리거 — 기능 변경 없음)

const FB_ADMIN_ID = 'c50c82b2-fe0e-4ee9-be8c-8132f03b9cb6';
const FB_AI_ID    = '578873e7-47b7-48d3-9cd8-894546196205'; // AI 자동참여 전용 봇 계정 (관리자 계정과 분리)
// 애널리틱스 집계에서 "실유저 활동"만 세기 위한 공용 필터 — 관리자/AI봇 계정 제외.
const _isRealUser = id => !!id && id !== FB_ADMIN_ID && id !== FB_AI_ID;

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
  { id: 'wordchallenge_rookie', category: 'word_challenge_wins',     threshold: 5,   name: '장원 후보',     avatar: '🎲' },
  { id: 'wordchallenge_king',   category: 'word_challenge_wins',     threshold: 10,  name: '단어의 신',     avatar: '🏆' },
  { id: 'firstline_rookie',     category: 'spotlight_sentence_picks', threshold: 5,   name: '첫줄 유망주',   avatar: '💡' },
  { id: 'firstline_king',       category: 'spotlight_sentence_picks', threshold: 10,  name: '첫줄의 신',     avatar: '🌟' },
  // 콘텐츠 다양화 신규 4종+초성힌트 전용 업적(2026-07-28 추가)
  { id: 'fairytale_rookie',     category: 'fairytale_count',     threshold: 15,  name: '각색루키',      avatar: '🧚' },
  { id: 'fairytale_king',       category: 'fairytale_count',     threshold: 50,  name: '각색왕',        avatar: '🏰' },
  { id: 'speedrun_rookie',      category: 'speedrun_count',      threshold: 30,  name: '질주루키',      avatar: '🏃' },
  { id: 'speedrun_king',        category: 'speedrun_count',      threshold: 100, name: '질주왕',        avatar: '🚀' },
  { id: 'fixedending_rookie',   category: 'fixed_ending_count',  threshold: 15,  name: '운명루키',      avatar: '🧵' },
  { id: 'fixedending_king',     category: 'fixed_ending_count',  threshold: 50,  name: '운명왕',        avatar: '🏛️' },
  { id: 'genreswitch_rookie',   category: 'genre_switch_count',  threshold: 15,  name: '장르루키',      avatar: '🎪' },
  { id: 'genreswitch_king',     category: 'genre_switch_count',  threshold: 50,  name: '장르왕',        avatar: '🌪️' },
  { id: 'hint_rookie',          category: 'hint_win_count',      threshold: 15,  name: '추리루키',      avatar: '🔍' },
  { id: 'hint_king',            category: 'hint_win_count',      threshold: 50,  name: '추리왕',        avatar: '🕵️' },
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

// "오늘의 이야기" 스포트라이트 카드 장르 확률 표시용 — vote_threshold 있는
// (=스포트라이트 슬롯 출신) 이야기에만 적용. 8개 고정 카테고리, 클라이언트
// index.html의 GENRE_META와 이름을 반드시 맞춰야 함(FB_ACHIEVEMENTS 이중화 방식과 동일).
const SPOTLIGHT_GENRES = ['로맨스', '미스터리', '스릴러', '코미디', '판타지', '공포', '드라마', 'SF'];

// 에피소드 마감마다 호출되어(스포트라이트 슬롯 이야기 한정) 단계별 장르 확률
// 이력을 story_genre_probs/{story_id}에 쌓음 — 카드의 상위 장르 표시와 상세페이지
// 등락 차트가 이 문서 하나로 렌더링됨. 완결 여부와 무관하게 매 단계 호출.
async function _classifyStoryGenre(db, story_id, step) {
  const storySnap = await db.collection('stories').doc(story_id).get();
  if (!storySnap.exists) return;
  const story = storySnap.data();

  const secretsSnap = await db.collection('config').doc('secrets').get();
  const claudeKey = secretsSnap.exists ? secretsSnap.data().claude_key : null;
  if (!claudeKey) return;

  const text = await _buildStoryContext(db, story_id, story);
  if (!text.trim()) return;

  const prompt = `다음은 여러 사람이 한 문장씩 이어 쓰고 있는 릴레이 소설의 현재까지 내용입니다. 이 이야기가 최종적으로 어떤 장르로 끝날지 확률을 추정해주세요.

아래 8개 장르 중에서만 골라 각각 확률(%, 정수)을 매기고 합계가 100이 되게 하세요:
${SPOTLIGHT_GENRES.join(', ')}

이야기 내용:
"""
${text}
"""

다른 설명 없이 JSON 객체 하나만 출력하세요. 형식 예: {"로맨스":10,"미스터리":65,"스릴러":10,"코미디":5,"판타지":5,"공포":5,"드라마":0,"SF":0}`;

  let raw;
  try { raw = await _callClaude(claudeKey, prompt, 300); } catch (e) { console.error('genre classify call error:', e.message); return; }
  if (!raw) return;

  let parsed;
  try {
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
    parsed = JSON.parse(jsonText);
  } catch (e) { console.error('genre classify parse error:', e.message, raw); return; }

  const probs = {};
  let sum = 0;
  for (const g of SPOTLIGHT_GENRES) {
    const v = Math.max(0, Math.round(Number(parsed[g]) || 0));
    probs[g] = v; sum += v;
  }
  if (sum <= 0) return;
  // 반올림 오차 보정 없이 비율만 다시 정수화(정확히 100 합계는 표시용으로만
  // 중요하고, 여기선 근사치면 충분해서 단순 나눗셈으로 처리)
  for (const g of SPOTLIGHT_GENRES) probs[g] = Math.round(probs[g] / sum * 100);

  const top = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([genre, pct]) => ({ genre, pct }));

  const ref = db.collection('story_genre_probs').doc(story_id);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const history = snap.exists ? (snap.data().history || []) : [];
    history.push({ step, probs, at: new Date().toISOString() });
    tx.set(ref, { story_id, top, history, updated_at: new Date().toISOString() });
  });
}

// story_id에 속한 전체 에피소드/제출을 episode_id/sub_id로 빠르게 찾을 수 있는
// 맵으로 만듦 — _serverSpinOffOrphan의 조상 체인 추적에 필요.
async function _serverBuildEpisodeMaps(db, story_id) {
  const [allEpsSnap, allSubsSnap] = await Promise.all([
    db.collection('episodes').where('story_id', '==', story_id).get(),
    db.collection('submissions').where('story_id', '==', story_id).get(),
  ]);
  const epById = new Map(allEpsSnap.docs.map(d => [d.id, { episode_id: d.id, ...d.data() }]));
  const subsByEp = new Map();
  allSubsSnap.docs.forEach(d => {
    const s = { sub_id: d.id, ...d.data() };
    if (!subsByEp.has(s.episode_id)) subsByEp.set(s.episode_id, []);
    subsByEp.get(s.episode_id).push(s);
  });
  const subById = new Map(allSubsSnap.docs.map(d => [d.id, { sub_id: d.id, ...d.data() }]));
  return { epById, subsByEp, subById };
}

// 특정 스토리에서 "버려진 갈래" 에피소드 하나를 독립 스토리로 분리하는 공용 헬퍼.
// 두 가지 시점에서 호출됨:
//  1) 스토리가 완결될 때, 그 시점까지 아직 안 닫힌 형제 갈래(orphanEp가 아직
//     'open')를 정리할 때 — resolvedWinners 없이 호출.
//  2) 형제 갈래가 스토리 완결 전에 먼저 자기 투표 임계값을 채워 따로(뒤늦게)
//     마감된 경우 — orphanEp는 이미 closed 처리됐고, resolvedWinners에 그
//     갈래 자신의 마감 결과(winners/anyClose)를 담아 호출. 이 2번 케이스가
//     기존에 아예 빠져있던 부분(2026-07-19 유저 제보로 실제 데이터에서 발견 —
//     current_step이 실제 진행 단계보다 부풀려지는 원인이었음: 이 뒤늦은 마감을
//     _serverCloseEpisode가 그냥 정경 진행으로 취급해서 원 스토리의
//     current_step을 그대로 또 올려버리고 있었음. 아래 참고).
async function _serverSpinOffOrphan(db, orphanEp, story, epById, subsByEp, subById, resolvedWinners) {
  const newStoryId = db.collection('stories').doc().id;

  // orphan의 조상 체인을 거슬러 올라가며 두 지점을 구분해서 기록
  let branch_episode_id = null, branch_sub_id = null;
  let branch_leaf_episode_id = null, branch_leaf_sub_id = null;
  let curSubId = orphanEp.parent_sub_id || null;
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
    const leafDisplayStep = _calcDisplayStepBackend(story, Number(leafEp.step));
    branch_display_offset = leafDisplayStep - Number(orphanEp.step) + 1;
  }

  // resolvedWinners 없으면(1번 케이스) orphan 자신이 아직 열려있는 채로 새
  // 스토리에 그대로 물려짐 — current_step은 orphan 단계 직전까지만.
  // 있으면(2번 케이스) orphan은 이미 결론이 난 상태로 물려지고, current_step은
  // orphan 단계까지 포함해서 잡음(아래에서 결과 에피소드를 따로 만듦).
  const openSteps = {};
  if (!resolvedWinners) {
    openSteps[orphanEp.episode_id] = { step: Number(orphanEp.step), sub_count: (subsByEp.get(orphanEp.episode_id) || []).length };
  }

  const spinBatch = db.batch();
  spinBatch.set(db.collection('stories').doc(newStoryId), {
    story_id: newStoryId, parent_story_id: orphanEp.story_id,
    branch_from_step: Number(orphanEp.step) + 1,
    branch_episode_id, branch_sub_id,
    branch_leaf_episode_id, branch_leaf_sub_id,
    branch_display_offset,
    opening: story.opening, max_steps: story.max_steps || 10,
    current_step: resolvedWinners ? Number(orphanEp.step) : Number(orphanEp.step) - 1,
    status: (resolvedWinners && resolvedWinners.anyClose) ? 'completed' : 'active',
    creator_id: story.creator_id,
    creator_nickname: story.creator_nickname || '익명',
    creator_badge: story.creator_badge || '',
    // 분기(고아 에피소드) 시점의 참여자 수는 여기서 새로 세지 않고 부모
    // 스토리의 누적 participant_count를 그대로 물려받음 — branch_display_offset이
    // 단계 번호를 부모+분기 합산 기준으로 보여주는 것과 일관되게, 참여자 수도
    // "분기 이후 새로 온 사람만" 세면 실제보다 훨씬 적게 표시되는 문제가 있었음
    // (2026-07-08 유저 리포트: 표시상 6단계인데 참여자 4명 — 실제로는 분기 전
    // 부모 쪽에만 15명이 더 있었음). 이후 이 분기에 새 작성자가 오면 기존처럼
    // fbCreateSubmission의 increment(1)로 계속 누적됨.
    participant_count: Number(story.participant_count) || 0, like_count: 0, adoption_count: 0,
    has_branch: false, created_at: new Date().toISOString(), batch: '',
    // 자유 이야기 탭 정렬/카드 표시용 — 새로 분리된 스토리는 방금 연 에피소드가
    // vote_total 0으로 시작하므로 hot_score 0 (firebase-api.js fbCreateStory 참고).
    hot_score: 0,
    open_steps: openSteps,
  });
  spinBatch.update(db.collection('episodes').doc(orphanEp.episode_id), { story_id: newStoryId });
  await spinBatch.commit();

  const subSnap = await db.collection('submissions').where('episode_id', '==', orphanEp.episode_id).get();
  if (!subSnap.empty) {
    const subBatch = db.batch();
    subSnap.docs.forEach(d => subBatch.update(d.ref, { story_id: newStoryId }));
    await subBatch.commit();
  }

  // 2번 케이스면서 완결이 아니면(anyClose===false) — 이미 결론난 이 갈래의
  // 다음 에피소드(들)를 새로 분리된 스토리 밑에 생성
  if (resolvedWinners && !resolvedWinners.anyClose) {
    const nextEpBatch = db.batch();
    const nextOpenSteps = {};
    resolvedWinners.winners.forEach(w => {
      const newEpId = db.collection('episodes').doc().id;
      nextEpBatch.set(db.collection('episodes').doc(newEpId), {
        episode_id: newEpId, story_id: newStoryId,
        step: Number(orphanEp.step) + 1, parent_sub_id: w.id,
        status: 'open', vote_total: 0,
        created_at: new Date().toISOString(), closed_at: '', pending_at: '',
      });
      nextOpenSteps[`open_steps.${newEpId}`] = { step: Number(orphanEp.step) + 1, sub_count: 0 };
    });
    await nextEpBatch.commit();
    await db.collection('stories').doc(newStoryId).update(nextOpenSteps);
  }
}

async function _serverCloseEpisode(db, episode_id, ep) {
  const epRef = db.collection('episodes').doc(episode_id);
  const storyRef = db.collection('stories').doc(ep.story_id);
  const alreadyClosed = await db.runTransaction(async tx => {
    const snap = await tx.get(epRef);
    if (!snap.exists) return true;
    const st = snap.data().status;
    if (st !== 'open' && st !== 'pending') return true;
    tx.update(epRef, { status: 'closed', closed_at: new Date().toISOString() });
    // 자유 이야기 탭 카드용 open_steps에서도 제거 — 안 지우면 닫힌 에피소드가
    // 카드에 계속 "열려있는 것"처럼 남음(2026-07-18 성능개선용 비정규화 필드,
    // firebase-api.js fbCreateStory 참고)
    tx.update(storyRef, { [`open_steps.${episode_id}`]: admin.firestore.FieldValue.delete() });
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
  // 결말 고정 이야기는 fbCreateSubmission이 클라이언트 직접 Firestore write라
  // (firestore.rules에서 submissions가 전부 열려있음) 유저가 기존 "완결하기"
  // (closing:true) 버튼으로 정해진 결말을 우회하고 조기 완결시킬 수 있음 —
  // is_closing을 무조건 무력화해서, 아래 새로 추가한 마지막 단계 자동주입
  // 분기가 결말 고정 이야기의 유일한 완결 경로가 되게 막음.
  const anyClose = st.mode === 'fixed_ending' ? false : winners.some(w => w.is_closing === true);

  // ⚠️ 이 에피소드가 스토리의 "다음 정경(canonical) 단계"가 맞는지 확인.
  // 동률로 갈린 두 갈래 중 하나가 먼저 닫혀서 이미 다음 단계로 진행된 뒤,
  // 나머지(버려진) 갈래가 뒤늦게 자기 투표 임계값을 채워 따로 마감되는 경우가
  // 있음 — 원래는 이 경우도 무조건 current_step을 그대로 또 +1 해버려서, 실제
  // 정경 진행은 7단계까지인 이야기의 current_step이 8, 9로 계속 부풀려지는
  // 버그가 있었음(2026-07-19 유저 제보로 실제 라이브 데이터에서 확인 — 동률 후
  // 버려진 갈래가 4시간 넘게 지나서야 따로 마감되며 재현됨. 그 부풀려진
  // current_step이 "이야기 연장하기"의 branch_from_step 계산에도 그대로
  // 흘러들어가 연장 이야기의 시작 단계 표기까지 틀리게 만들었음).
  // 이 에피소드의 step이 스토리의 "다음 정경 단계"(current_step+1)와 다르면
  // 뒤늦게 마감된 버려진 갈래로 보고, 원 스토리는 전혀 안 건드린 채 이 갈래를
  // 독립 스토리로 즉시 분리함(기존 "스토리 완결 시 남은 open 에피소드 분리"와
  // 동일한 헬퍼(_serverSpinOffOrphan)를 재사용, 호출 시점만 다름).
  if (Number(ep.step) !== (Number(st.current_step) || 0) + 1) {
    const { epById, subsByEp, subById } = await _serverBuildEpisodeMaps(db, ep.story_id);
    await _serverSpinOffOrphan(db, ep, st, epById, subsByEp, subById, { winners, anyClose });
    console.log(`serverCloseEpisode: ${episode_id}는 이미 지나간 단계(step ${ep.step}, story current_step ${st.current_step})라 독립 스토리로 분리함`);
    return;
  }

  const nextStep = (Number(st.current_step) || 0) + 1;

  // 스포트라이트 슬롯 이야기(vote_threshold 있음)는 매 단계 마감마다 장르 확률을
  // 갱신 — 완결 전에도 카드/상세페이지에서 등락을 보여줘야 하므로 여기서 호출.
  // ⚠️ 반드시 await할 것: 이 프로젝트 Cloud Functions는 firebase-functions v1(1st Gen)
  // 이라 HTTPS 콜러블(closeEpisode)이 응답을 보낸 직후 인스턴스 CPU가 스로틀링될 수
  // 있음 — await 없이 던지면(원래 "부가 기능이라 완결 흐름을 막지 않도록" 의도로
  // fire-and-forget 했었음) Claude API 호출처럼 시간이 걸리는 작업이 응답 이후 죽어서
  // 저장이 안 될 수 있음(속도개선방 지적, 2026-07-15). 클라이언트가 애초에 closeEpisode
  // 결과를 기다리지 않고 호출하므로(firebase-api.js closeEpisode 호출부 .catch(()=>{})
  // fire-and-forget) 여기서 await해도 체감 지연은 없음.
  // 장르 강제 전환 이야기는 이미 장르가 확정돼있어(genre_sequence) AI 확률
  // 분류가 낭비+모순(강제된 장르랑 다른 확률이 나올 수 있음)이라 스킵
  if (st.vote_threshold && st.mode !== 'genre_switch') {
    await _classifyStoryGenre(db, ep.story_id, nextStep).catch(e => console.error('genre classify error:', e.message));
  }

  // 결말 고정 이야기: 마지막 단계(max_steps)를 공개 제출로 열지 않고, 생성 시
  // 미리 정해둔 fixed_ending을 채택된 내용으로 그대로 주입해서 즉시 완결시킴.
  // anyClose를 위에서 이미 무력화했으므로 이 분기가 유일한 완결 경로.
  if (st.mode === 'fixed_ending' && nextStep + 1 === Number(st.max_steps)) {
    const now = new Date().toISOString();
    const finalBatch = db.batch();
    // winners가 동률로 여러 갈래일 수 있음 — 갈래를 버리지 않고 각 갈래 끝에
    // 동일한 fixed_ending을 캡으로 씌움
    winners.forEach(w => {
      const finalEpId = db.collection('episodes').doc().id;
      const finalSubId = db.collection('submissions').doc().id;
      finalBatch.set(db.collection('episodes').doc(finalEpId), {
        episode_id: finalEpId, story_id: ep.story_id,
        step: nextStep + 1, parent_sub_id: w.id,
        status: 'closed', vote_total: 0,
        created_at: now, closed_at: now, pending_at: '',
      });
      finalBatch.set(db.collection('submissions').doc(finalSubId), {
        sub_id: finalSubId, episode_id: finalEpId, story_id: ep.story_id,
        content: st.fixed_ending,
        author_id: FB_AI_ID, author_nickname: '익명', author_badge: '',
        derived_from: '', vote_count: 0, is_adopted: true,
        created_at: now, is_closing: true,
      });
    });
    finalBatch.update(storySnap.ref, {
      current_step: nextStep + 1, status: 'completed',
      ...(winners.length > 1 ? { has_branch: true } : {}),
    });
    await finalBatch.commit();
    try { await _serverRefillSpotlightSlot(db, ep.story_id); } catch (e) { console.error('spotlight refill error:', e.message); }
    console.log(`serverCloseEpisode: ${episode_id} → fixed_ending 완결 (step ${nextStep + 1})`);
    return;
  }

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
      const { epById, subsByEp, subById } = await _serverBuildEpisodeMaps(db, ep.story_id);
      for (const orphanDoc of orphanSnap.docs) {
        await _serverSpinOffOrphan(db, { episode_id: orphanDoc.id, ...orphanDoc.data() }, st, epById, subsByEp, subById, null);
      }
    }
  } else {
    // 새로 열리는 다음 단계 에피소드는 vote_total 0에서 시작하므로, 자유 이야기 탭
    // 정렬용 hot_score도 같이 0으로 리셋(안 하면 이전 단계의 표가 그대로 남아
    // 정렬이 실제 활성도와 어긋남). open_steps엔 새로 여는 에피소드(들)를 추가 —
    // 방금 닫힌 에피소드 항목은 위 초기 트랜잭션에서 이미 제거됐음.
    const newEpIds = winners.map(() => db.collection('episodes').doc().id);
    const storyUpdate = { current_step: nextStep, hot_score: 0 };
    if (winners.length > 1) storyUpdate.has_branch = true;
    newEpIds.forEach(newEpId => {
      storyUpdate[`open_steps.${newEpId}`] = { step: nextStep + 1, sub_count: 0 };
    });
    await storySnap.ref.update(storyUpdate);
    const epBatch = db.batch();
    winners.forEach((w, i) => {
      epBatch.set(db.collection('episodes').doc(newEpIds[i]), {
        episode_id: newEpIds[i], story_id: ep.story_id,
        step: nextStep + 1, parent_sub_id: w.id,
        status: 'open', vote_total: 0,
        created_at: new Date().toISOString(), closed_at: '', pending_at: '',
      });
    });
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
        // 초스피드는 투표 자체가 없는 즉시채택 콘텐츠라 AI 자동 참여가 개입할 이유가
        // 없음(최악의 경우 고아 submission 생성 위험) — 완전히 스킵.
        if (story.mode === 'speedrun') continue;

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
          // 스포트라이트 슬롯 이야기(vote_threshold:5, _serverCreateSeedStory에서 지정)는
          // 관심이 몰려 너무 빨리 넘어가는 걸 막기 위해 일반 이야기(기본 3표)보다
          // 높은 문턱을 씀 — 필드 없으면 기존 AI_VOTE_THRESHOLD로 그대로 동작
          const voteThreshold = storyDoc.data().vote_threshold || AI_VOTE_THRESHOLD;
          const maxVoteCount = subs.reduce((m, s) => Math.max(m, Number(s.vote_count) || 0), 0);
          if (maxVoteCount >= voteThreshold) {
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
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const secretsSnap = await db.collection('config').doc('secrets').get();
    const hasKey = secretsSnap.exists && !!secretsSnap.data().claude_key;
    return { ok: true, has_key: hasKey };
  });

exports.setClaudeKey = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const key = data.key;
    if (!key || key.length < 20) {
      throw new functions.https.HttpsError('invalid-argument', '유효한 Claude API 키를 입력해주세요.');
    }
    const db = admin.firestore();
    await db.collection('config').doc('secrets').set({ claude_key: key }, { merge: true });
    return { ok: true };
  });

// 카카오 로그인 인가코드→액세스토큰 교환(kauth.kakao.com/oauth/token)에 필요한
// REST API 키 — Claude 키와 동일 패턴(config/secrets, 관리자 전용 콜러블로만 조회/저장)
exports.getKakaoKeyStatus = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const secretsSnap = await db.collection('config').doc('secrets').get();
    const d = secretsSnap.exists ? secretsSnap.data() : {};
    return { ok: true, has_key: !!d.kakao_rest_key, has_secret: !!d.kakao_client_secret };
  });

exports.setKakaoKey = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const key = (data.key || '').trim();
    if (!key || key.length < 10) {
      throw new functions.https.HttpsError('invalid-argument', '유효한 카카오 REST API 키를 입력해주세요.');
    }
    const update = { kakao_rest_key: key };
    // Client Secret은 콘솔 카카오로그인→보안에서 "사용함"으로 켠 앱만 필요 — 켠 경우
    // 토큰 교환 시 이 값이 없으면 카카오가 KOE010(Bad client credentials)로 거부함
    const secret = (data.secret || '').trim();
    if (secret) update.kakao_client_secret = secret;
    const db = admin.firestore();
    await db.collection('config').doc('secrets').set(update, { merge: true });
    return { ok: true };
  });

// ── 자격증명(user_secrets: token/pw_hash) 서버 이전 (Auth 마이그레이션 5단계) ──
// user_secrets 컬렉션이 인증 없이 완전 공개 상태였음(curl로 임의 유저의 세션 토큰/
// 비밀번호 해시를 그대로 읽을 수 있었고, 토큰을 훔쳐 localStorage에 심으면 비밀번호
// 없이 계정을 완전히 탈취할 수 있었음). 아래 6개 함수가 pw_hash/token을 만지는
// 모든 경로를 흡수하고, user_secrets는 이후 firestore.rules에서 완전 차단됨.

function _genSecretId() { return crypto.randomUUID(); }

// ── 비밀번호 해시: 무솔트 SHA-256 → per-user salt + scrypt로 전환 (2026-07-13) ──
// 예전엔 무솔트 SHA-256이라, pw_hash가 유출되면(user_secrets 노출 사고처럼) 흔한
// 비밀번호는 레인보우테이블로 사실상 바로 역산 가능했고, SHA-256 자체도 브루트포스에
// 빠른 범용 해시라 salt가 있어도 크래킹 비용이 낮음. scrypt(느리고 메모리집약적인
// KDF, Node 내장이라 의존성 추가 없음)+계정별 랜덤 salt로 교체.
// 기존 유저(salt 없음)는 일괄 마이그레이션 스크립트 없이, 다음 로그인/비번변경/
// 비번찾기 시 자동으로 새 스킴으로 전환됨(레거시 해시로 검증 성공하면 그 자리에서
// 재해시) — 평문 비밀번호를 모르는 상태에서 기존 해시를 일괄 재해시할 방법이
// 없으므로 이 "다음 인증 시 승급" 방식이 유일하게 가능한 마이그레이션 경로.
function _genSalt() { return crypto.randomBytes(16).toString('hex'); }
function _hashPwLegacy(password) { return crypto.createHash('sha256').update(password).digest('hex'); }
function _hashPwSalted(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }

// ── 비밀번호 작성규칙 (2026-07-13) ──
// "개인정보의 안전성 확보조치 기준"(개인정보보호위원회 고시) 제5조⑤은 "안전한
// 비밀번호를 설정할 수 있도록 비밀번호 작성규칙을 수립·적용"할 의무만 규정하고
// 특정 자릿수·문자종류를 법으로 강제하지는 않음(2023.9 개정으로 구체적 수치
// 기준은 삭제됨) — 그래도 지금 규칙(8자 이상, 종류 무관)은 사실상 규칙이 없는
// 것과 같아 이 조항 취지를 충족한다고 보기 어려움. 업계에서 여전히 표준으로
// 쓰이는 조합(영문 대/소문자·숫자·특수문자 중 3종류 이상+8자 이상, 또는
// 2종류 이상+10자 이상)을 채택해 실질적인 작성규칙을 갖춤.
function _pwCharTypeCount(pw) {
  let n = 0;
  if (/[A-Z]/.test(pw)) n++;
  if (/[a-z]/.test(pw)) n++;
  if (/[0-9]/.test(pw)) n++;
  if (/[^A-Za-z0-9]/.test(pw)) n++;
  return n;
}
function _isValidPassword(pw) {
  if (!pw) return false;
  const types = _pwCharTypeCount(pw);
  if (types >= 3) return pw.length >= 8;
  if (types >= 2) return pw.length >= 10;
  return false;
}
const PW_RULE_MSG = '비밀번호는 영문 대/소문자·숫자·특수문자 중 3종류 이상 조합 시 8자 이상, 2종류 조합 시 10자 이상이어야 해요.';
// sec: user_secrets 문서 데이터. salt 필드 유무로 신/구 스킴을 구분.
function _verifyPw(password, sec) {
  if (!sec) return false;
  if (sec.salt) return _hashPwSalted(password, sec.salt) === sec.pw_hash;
  return _hashPwLegacy(password) === sec.pw_hash;
}

// ── 관리자 인증: admin_id 문자열 비교 → 실제 세션 토큰 검증으로 강화 (2026-07-13) ──
// 예전엔 클라이언트가 보내는 admin_id 문자열을 FB_ADMIN_ID 상수와 그대로 비교했는데,
// 그 상수 자체가 공개 배포되는 firebase-api.js 소스에 하드코딩돼 있어 누구나
// view-source로 알아낼 수 있었음 — 즉 인증 전혀 없이 curl로 이 값만 그대로 보내면
// 관리자 전용 함수를 전부 통과할 수 있는 상태였음(실제로 이 세션에서
// adminInvalidateAllSessions를 세션/토큰 없이 admin_id만으로 성공시킨 적이 있어서
// 확인됨). changePassword/deleteAccount와 동일하게, user_id+token을 실제
// user_secrets와 대조해서 "그 관리자 계정으로 실제 로그인해 있는지"를 검증한
// 뒤에만 권한을 인정하도록 강화.
async function _requireAdmin(user_id, token) {
  if (!user_id || !token) throw new functions.https.HttpsError('unauthenticated', '로그인이 필요합니다.');
  if (user_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
  const secSnap = await admin.firestore().collection('user_secrets').doc(user_id).get();
  if (!secSnap.exists || secSnap.data().token !== token) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
}

// _requireAdmin과 동일 패턴이지만 FB_ADMIN_ID 제한이 없는 일반 유저용 — onCall
// 함수는 클라이언트가 보낸 user_id를 자동으로 검증해주지 않으므로(Firebase Auth
// context.auth를 안 쓰는 커스텀 세션 구조), speedrunSubmit처럼 "진짜 그 유저가
// 맞는지"가 중요한 콜러블은 이걸로 토큰을 실제로 대조해야 함 — 그냥 data.user_id를
// 그대로 믿으면 다른 사람 사칭이 가능해짐.
async function _requireUser(user_id, token) {
  if (!user_id || !token) throw new functions.https.HttpsError('unauthenticated', '로그인이 필요합니다.');
  const secSnap = await admin.firestore().collection('user_secrets').doc(user_id).get();
  if (!secSnap.exists || secSnap.data().token !== token) throw new functions.https.HttpsError('unauthenticated', '로그인이 필요합니다.');
}

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
    const email = (data.email || '').trim().toLowerCase();

    if (!nickname || !password) throw new functions.https.HttpsError('invalid-argument', '아이디와 비밀번호를 입력해주세요.');
    if (!/^[가-힣a-zA-Z0-9]{2,12}$/.test(nickname)) return { ok: false, error: '아이디는 2~12자, 한글·영문·숫자만 사용할 수 있어요.' };
    if (!_isValidPassword(password)) return { ok: false, error: PW_RULE_MSG };
    const dn = (display_name || '').trim() || nickname;
    if (!/^[가-힣a-zA-Z0-9 ._-]{2,12}$/.test(dn)) return { ok: false, error: '닉네임은 2~12자, 한글·영문·숫자·공백·._- 만 사용할 수 있어요.' };
    // 이메일은 선택 입력(가입 문턱을 유지) — 넣었다면 형식만 검사, 계정당 1개
    // 필수는 아니라서 중복 소유는 허용(아이디/비번찾기 발송 시 여러 계정에 각각 보냄)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: '올바른 이메일 형식이 아니에요.' };

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
    const salt = _genSalt();
    const pwHash = _hashPwSalted(password, salt);

    await Promise.all([
      db.collection('users').doc(user_id).set({
        user_id, nickname, display_name: dn,
        total_points: 0, adoption_count: 0, badge: 'seed', name: name.trim(), email,
        referral: referral.trim(), created_at: new Date().toISOString(),
        last_seen_patch_id: initialSeenPatchId,
        auth_uid: context.auth.uid,
      }),
      db.collection('user_secrets').doc(user_id).set({ pw_hash: pwHash, salt, token, token_exp }),
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
      ok: true, token, user_id, nickname, display_name: dn, email,
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
    if (!_verifyPw(password, sec)) return { ok: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };

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

    // 레거시(무솔트 SHA-256) 계정이 방금 정상 인증됐으면, 이 기회에 salt+scrypt로
    // 자동 승급 — 평문 비밀번호를 아는 유일한 시점이라 여기서만 가능한 마이그레이션
    const secPatch = { token, token_exp };
    if (!sec.salt) {
      const newSalt = _genSalt();
      secPatch.salt = newSalt;
      secPatch.pw_hash = _hashPwSalted(password, newSalt);
    }
    await db.collection('user_secrets').doc(doc.id).set(secPatch, { merge: true });

    return {
      ok: true, token, user_id: u.user_id, nickname: u.nickname,
      display_name: u.display_name || u.nickname, email: u.email || '',
      total_points: u.total_points || 0, badge: u.badge || 'seed',
      is_admin: u.user_id === FB_ADMIN_ID,
      adoption_count: u.adoption_count || 0,
    };
  });

// ── 간편가입: 구글 로그인 (2026-07-17) ──
// register/login과 동일하게 context.auth를 전제로 함 — 다만 여기선 익명인증이
// 아니라 signInWithPopup(GoogleAuthProvider)로 브라우저의 Firebase Auth 세션 자체가
// 구글 계정에 고정 매핑되는 uid로 교체된 상태. context.auth.uid/token은 Firebase가
// 이미 검증해준 값이라(Callable Functions 프레임워크가 ID 토큰을 검증해서 채워줌)
// register/login이 context.auth.uid를 그대로 신뢰하는 것과 동일한 전제 — _requireAdmin
// 교훈(클라이언트가 "보낸" 값은 안 믿는다)과 모순되지 않음, 이건 클라이언트가 보낸 게
// 아니라 프레임워크가 검증해서 채워준 값이기 때문.
//
// users.google_uid(신규 필드)로 계정을 조회 — auth_uid와 별개로 둔 이유: auth_uid는
// "지금 이 계정 쓰기 권한을 가진 세션"이라는 기존 의미를 유지하고, google_uid는
// "이 계정이 어떤 구글 계정에 링크됐는지"를 나타내는 별도 조회키로만 씀.

function _genAutoNickname(rawName, fallback) {
  const cleaned = (rawName || '').replace(/[^가-힣a-zA-Z0-9]/g, '').slice(0, 8);
  return cleaned || fallback || '소셜유저';
}

function _socialProfileResponse(action, token, u) {
  return {
    ok: true, action, token, user_id: u.user_id, nickname: u.nickname,
    display_name: u.display_name || u.nickname, email: u.email || '',
    total_points: u.total_points || 0, badge: u.badge || 'seed',
    is_admin: u.user_id === FB_ADMIN_ID, adoption_count: u.adoption_count || 0,
  };
}

// 신규 계정 생성 공통 헬퍼(최초 가입/병합 거부 두 경로에서 재사용) — 닉네임은
// 구글 이름에서 한글·영문·숫자만 남기고 랜덤 4자리를 붙여 자동생성. 가입 중간에
// 닉네임 입력창을 또 띄우면 "버튼 한 번으로 끝"이라는 간편가입 취지가 흐려지고,
// 표시이름은 어차피 나중에 20p로 자유롭게 바꿀 수 있는 기존 기능이 있어 충분하다고
// 판단(유저 확정 계획).
async function _createGoogleAccount(db, context) {
  const email = context.auth.token.email || '';
  const base = _genAutoNickname(context.auth.token.name, '구글유저');
  let nickname = null;
  for (let i = 0; i < 20; i++) {
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    const candidate = `${base}${suffix}`.slice(0, 12);
    const [dupId, dupDn] = await Promise.all([
      db.collection('users').where('nickname', '==', candidate).limit(1).get(),
      db.collection('users').where('display_name', '==', candidate).limit(1).get(),
    ]);
    if (dupId.empty && dupDn.empty) { nickname = candidate; break; }
  }
  if (!nickname) throw new functions.https.HttpsError('internal', '닉네임 생성에 실패했습니다. 다시 시도해주세요.');

  const user_id = _genSecretId();
  const token = _genSecretId();
  const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  // register와 동일하게 가입 시점 최신 패치를 last_seen_patch_id로 세팅 —
  // 안 하면 가입 이전 패치 내역이 신규 유저에게 안내로 뜸(v185 수정 사항, register:1272/1281 참고)
  const latestPatchSnap = await db.collection('patch_notes').orderBy('created_at', 'desc').limit(1).get();
  const initialSeenPatchId = latestPatchSnap.empty ? '' : latestPatchSnap.docs[0].data().patch_id;

  await Promise.all([
    db.collection('users').doc(user_id).set({
      user_id, nickname, display_name: nickname, email,
      total_points: 0, adoption_count: 0, badge: 'seed', name: '', referral: '',
      created_at: new Date().toISOString(), last_seen_patch_id: initialSeenPatchId,
      auth_uid: context.auth.uid, google_uid: context.auth.uid,
    }),
    // pw_hash/salt 없이 token만 세팅 — _verifyPw(sec)는 salt/pw_hash 둘 다 없으면
    // 항상 false를 반환하므로(functions/index.js _verifyPw), 이 계정으로 실수로
    // 비밀번호 로그인 시도해도 크래시 없이 "틀렸습니다"로 안전하게 거부됨.
    db.collection('user_secrets').doc(user_id).set({ token, token_exp }),
  ]);

  return _socialProfileResponse('created', token, {
    user_id, nickname, display_name: nickname, email,
    total_points: 0, badge: 'seed', adoption_count: 0,
  });
}

exports.loginWithGoogle = functions
  .region('asia-northeast3')
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', '인증 정보가 없습니다.');
    if (context.auth.token.firebase?.sign_in_provider !== 'google.com') {
      throw new functions.https.HttpsError('failed-precondition', '구글 로그인 세션이 아닙니다.');
    }
    if (context.auth.token.email_verified !== true) {
      return { ok: false, error: '구글 계정의 이메일이 확인되지 않았어요.' };
    }
    const db = admin.firestore();

    const byGoogle = await db.collection('users').where('google_uid', '==', context.auth.uid).limit(1).get();
    if (!byGoogle.empty) {
      const doc = byGoogle.docs[0];
      const u = doc.data();
      const token = _genSecretId();
      const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const writes = [db.collection('user_secrets').doc(doc.id).set({ token, token_exp }, { merge: true })];
      if (u.auth_uid !== context.auth.uid) writes.push(doc.ref.update({ auth_uid: context.auth.uid }));
      await Promise.all(writes);
      return _socialProfileResponse('logged_in', token, u);
    }

    const email = context.auth.token.email || '';
    const byEmail = email
      ? await db.collection('users').where('email', '==', email).limit(1).get()
      : { empty: true };
    if (!byEmail.empty) {
      const u = byEmail.docs[0].data();
      return { ok: true, action: 'needs_merge_decision', existing_nickname: u.display_name || u.nickname };
    }

    return await _createGoogleAccount(db, context);
  });

exports.resolveGoogleMerge = functions
  .region('asia-northeast3')
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', '인증 정보가 없습니다.');
    if (context.auth.token.firebase?.sign_in_provider !== 'google.com') {
      throw new functions.https.HttpsError('failed-precondition', '구글 로그인 세션이 아닙니다.');
    }
    const db = admin.firestore();
    const email = context.auth.token.email || '';

    if (data.merge) {
      // 클라이언트가 보낸 계정 식별자를 쓰지 않고, loginWithGoogle의 이메일 매치
      // 조회를 서버가 다시 계산 — 레이스로 그 사이 사라졌으면 에러로 처리.
      if (!email) throw new functions.https.HttpsError('failed-precondition', '이메일 정보가 없습니다.');
      const byEmail = await db.collection('users').where('email', '==', email).limit(1).get();
      if (byEmail.empty) throw new functions.https.HttpsError('failed-precondition', '합칠 계정을 찾을 수 없습니다.');
      const doc = byEmail.docs[0];
      const u = doc.data();
      const token = _genSecretId();
      const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await Promise.all([
        doc.ref.update({ google_uid: context.auth.uid, auth_uid: context.auth.uid }),
        db.collection('user_secrets').doc(doc.id).set({ token, token_exp }, { merge: true }),
      ]);
      return _socialProfileResponse('logged_in', token, u);
    }

    return await _createGoogleAccount(db, context);
  });

// ── 간편가입: 카카오 로그인 (2026-07-17) ──
// 구글과 다른 점: Firebase Auth가 카카오를 네이티브로 지원하지 않아서, 클라이언트가
// 보낸 카카오 액세스 토큰을 서버가 직접 카카오 API로 검증해야 함(_verifyKakaoToken).
// 검증 후엔 카카오 id에서 결정적으로 파생된 Firebase uid('kakao:'+id)로 커스텀
// 토큰을 발급(admin.auth().createCustomToken) — 클라이언트가 signInWithCustomToken
// 하면 그 뒤로는 context.auth.uid가 이 값으로 고정되어, 구글의 context.auth.uid(항상
// 같은 구글 계정=같은 uid)와 동일한 안정성을 얻음(기기 바꿔도 재로그인 안정적).
// email은 카카오가 검증해준 경우만(is_email_verified===true) 커스텀 토큰의 클레임에
// 실어서, 이후 resolveKakaoMerge에서 signInWithPopup 이후의 구글과 동일하게
// context.auth.token.email로 꺼내 쓸 수 있게 함.

// 카카오 JS SDK v2.8.1엔 팝업+프로미스로 액세스 토큰을 바로 주는 Kakao.Auth.login()이
// 없음(실제 배포 후 "Kakao.Auth.login is not a function" 런타임 에러로 확인 —
// 공식문서 재확인 결과 카카오는 인가코드+리다이렉트 방식(Kakao.Auth.authorize())만
// 지원하고, 액세스 토큰 발급은 서버가 인가코드를 카카오 토큰 엔드포인트로 교환해야
// 함). 그래서 클라이언트가 바로 액세스 토큰을 주는 게 아니라 인가코드(code)를 주고,
// 여기서 그 코드를 액세스 토큰으로 먼저 교환한 뒤 기존 _verifyKakaoToken으로 넘김.
async function _exchangeKakaoCode(code, redirectUri) {
  if (!code || !redirectUri) return null;
  const db = admin.firestore();
  const secretsSnap = await db.collection('config').doc('secrets').get();
  const secretsData = secretsSnap.exists ? secretsSnap.data() : {};
  const restKey = secretsData.kakao_rest_key;
  if (!restKey) return null;
  try {
    const params = {
      grant_type: 'authorization_code',
      client_id: restKey,
      redirect_uri: redirectUri,
      code,
    };
    // 콘솔에서 Client Secret을 "사용함"으로 켠 앱은 이 값이 없으면 KOE010으로 거부됨
    if (secretsData.kakao_client_secret) params.client_secret = secretsData.kakao_client_secret;
    const res = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) { console.error('kakao token exchange error:', data); return null; }
    return data.access_token;
  } catch (e) { console.error('kakao token exchange fetch error:', e.message); return null; }
}

async function _verifyKakaoToken(kakaoAccessToken) {
  if (!kakaoAccessToken) return null;
  let res, data;
  try {
    res = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: 'Bearer ' + kakaoAccessToken },
    });
    data = await res.json();
  } catch (e) { console.error('kakao token verify error:', e.message); return null; }
  if (!res.ok || !data || !data.id) return null;
  const account = data.kakao_account || {};
  const emailVerified = account.is_email_verified === true && account.is_email_valid === true;
  return {
    kakao_id: String(data.id),
    email: emailVerified ? (account.email || '') : '',
    nickname: (account.profile && account.profile.nickname) || '',
  };
}

async function _createKakaoAccount(db, uid, email, kakaoNickname) {
  const base = _genAutoNickname(kakaoNickname, '카카오유저');
  let nickname = null;
  for (let i = 0; i < 20; i++) {
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    const candidate = `${base}${suffix}`.slice(0, 12);
    const [dupId, dupDn] = await Promise.all([
      db.collection('users').where('nickname', '==', candidate).limit(1).get(),
      db.collection('users').where('display_name', '==', candidate).limit(1).get(),
    ]);
    if (dupId.empty && dupDn.empty) { nickname = candidate; break; }
  }
  if (!nickname) throw new functions.https.HttpsError('internal', '닉네임 생성에 실패했습니다. 다시 시도해주세요.');

  const user_id = _genSecretId();
  const token = _genSecretId();
  const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const latestPatchSnap = await db.collection('patch_notes').orderBy('created_at', 'desc').limit(1).get();
  const initialSeenPatchId = latestPatchSnap.empty ? '' : latestPatchSnap.docs[0].data().patch_id;

  await Promise.all([
    db.collection('users').doc(user_id).set({
      user_id, nickname, display_name: nickname, email,
      total_points: 0, adoption_count: 0, badge: 'seed', name: '', referral: '',
      created_at: new Date().toISOString(), last_seen_patch_id: initialSeenPatchId,
      auth_uid: uid, kakao_uid: uid,
    }),
    db.collection('user_secrets').doc(user_id).set({ token, token_exp }),
  ]);

  return _socialProfileResponse('created', token, {
    user_id, nickname, display_name: nickname, email,
    total_points: 0, badge: 'seed', adoption_count: 0,
  });
}

exports.loginWithKakao = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const kakaoAccessToken = await _exchangeKakaoCode(data.code, data.redirectUri);
    if (!kakaoAccessToken) return { ok: false, error: '카카오 인증 코드 확인에 실패했습니다.' };
    const verified = await _verifyKakaoToken(kakaoAccessToken);
    if (!verified) return { ok: false, error: '카카오 로그인 확인에 실패했습니다.' };
    const uid = 'kakao:' + verified.kakao_id;
    const db = admin.firestore();

    // 모든 분기(로그인/병합대기/신규가입)에서 커스텀 토큰을 발급 — 클라이언트가
    // 다음 호출(resolveKakaoMerge) 전에 반드시 Firebase 세션을 가져야 하므로.
    const customToken = await admin.auth().createCustomToken(uid, {
      email: verified.email || null, nickname: verified.nickname || null,
    });

    const byKakao = await db.collection('users').where('kakao_uid', '==', uid).limit(1).get();
    if (!byKakao.empty) {
      const doc = byKakao.docs[0];
      const u = doc.data();
      const token = _genSecretId();
      const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const writes = [db.collection('user_secrets').doc(doc.id).set({ token, token_exp }, { merge: true })];
      if (u.auth_uid !== uid) writes.push(doc.ref.update({ auth_uid: uid }));
      await Promise.all(writes);
      return { ...(_socialProfileResponse('logged_in', token, u)), customToken };
    }

    if (verified.email) {
      const byEmail = await db.collection('users').where('email', '==', verified.email).limit(1).get();
      if (!byEmail.empty) {
        const u = byEmail.docs[0].data();
        return { ok: true, action: 'needs_merge_decision', existing_nickname: u.display_name || u.nickname, customToken };
      }
    }

    const created = await _createKakaoAccount(db, uid, verified.email, verified.nickname);
    return { ...created, customToken };
  });

exports.resolveKakaoMerge = functions
  .region('asia-northeast3')
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', '인증 정보가 없습니다.');
    if (typeof context.auth.uid !== 'string' || !context.auth.uid.startsWith('kakao:')) {
      throw new functions.https.HttpsError('failed-precondition', '카카오 로그인 세션이 아닙니다.');
    }
    const db = admin.firestore();
    const email = context.auth.token.email || '';
    const kakaoNickname = context.auth.token.nickname || '';

    if (data.merge) {
      if (!email) throw new functions.https.HttpsError('failed-precondition', '이메일 정보가 없습니다.');
      const byEmail = await db.collection('users').where('email', '==', email).limit(1).get();
      if (byEmail.empty) throw new functions.https.HttpsError('failed-precondition', '합칠 계정을 찾을 수 없습니다.');
      const doc = byEmail.docs[0];
      const u = doc.data();
      const token = _genSecretId();
      const token_exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await Promise.all([
        doc.ref.update({ kakao_uid: context.auth.uid, auth_uid: context.auth.uid }),
        db.collection('user_secrets').doc(doc.id).set({ token, token_exp }, { merge: true }),
      ]);
      return _socialProfileResponse('logged_in', token, u);
    }

    return await _createKakaoAccount(db, context.auth.uid, email, kakaoNickname);
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
      display_name: u.display_name || u.nickname, email: u.email || '',
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
    if (!_isValidPassword(new_password)) return { ok: false, error: PW_RULE_MSG };

    const db = admin.firestore();
    const secRef = db.collection('user_secrets').doc(user_id);
    const secSnap = await secRef.get();
    if (!secSnap.exists || secSnap.data().token !== token) throw new functions.https.HttpsError('permission-denied', '로그인이 필요합니다.');
    const sec = secSnap.data();
    if (!_verifyPw(current_password, sec)) return { ok: false, error: '현재 비밀번호가 올바르지 않습니다.' };

    // 비밀번호 변경의 목적 자체가 "혹시 모를 침해(토큰 유출 등) 대응"인데, pw_hash만
    // 바꾸고 기존 token을 그대로 두면 이미 유출된 토큰을 쥔 공격자는 계속 그 세션으로
    // 들어올 수 있어 방어 목적을 달성 못 함 — login과 동일하게 새 token을 발급해서
    // 기존 토큰을 함께 무효화하고, 이 기기가 끊기지 않도록 새 token을 응답에 포함.
    // 새 비밀번호는 항상 salt+scrypt로 저장 — 레거시 계정이었어도 여기서 자동 승급됨.
    const newSalt = _genSalt();
    const newHash = _hashPwSalted(new_password, newSalt);
    const newToken = _genSecretId();
    const newTokenExp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await secRef.update({ pw_hash: newHash, salt: newSalt, token: newToken, token_exp: newTokenExp });
    return { ok: true, token: newToken };
  });

exports.resetPassword = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const nickname = (data.nickname || '').trim();
    const name = (data.name || '').trim();
    const new_password = data.new_password || '';
    if (!nickname || !name || !new_password) return { ok: false, error: '모든 항목을 입력해주세요.' };
    if (!_isValidPassword(new_password)) return { ok: false, error: PW_RULE_MSG };

    const db = admin.firestore();
    const snap = await db.collection('users').where('nickname', '==', nickname).limit(1).get();
    if (snap.empty) return { ok: false, error: '닉네임 또는 이름이 일치하지 않습니다.' };
    const doc = snap.docs[0];
    const u = doc.data();
    if (!u.name || u.name.trim() !== name) return { ok: false, error: '닉네임 또는 이름이 일치하지 않습니다.' };

    // changePassword와 동일한 이유로 token도 함께 무효화 — 이 플로우는 로그인 상태가
    // 아니라 새 token을 이 기기에 돌려줄 필요는 없음(다음 로그인에서 새로 발급됨).
    // 새 비밀번호는 항상 salt+scrypt로 저장 — 레거시 계정이었어도 여기서 자동 승급됨.
    const newSalt = _genSalt();
    const newHash = _hashPwSalted(new_password, newSalt);
    await db.collection('user_secrets').doc(doc.id).set({
      pw_hash: newHash, salt: newSalt, token: _genSecretId(), token_exp: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }, { merge: true });
    return { ok: true };
  });

// ── 이메일 기반 아이디/비밀번호 찾기 (2026-07-13) ──
// 이 앱은 Firebase Auth를 안 쓰는 자체 인증 구조라 이메일 발송을 직접 구현해야
// 함. 가입 시 이름만 받던 기존 resetPassword(위)는 이름이 추측 가능한 약한
// 값이라 본인확인으로 부족하다는 지적으로 이메일 발송 방식을 추가함(이메일은
// 선택 입력이라 없는 계정은 기존 이름 기반 방식이 계속 폴백으로 남아있음).
//
// Claude API 키와 동일한 패턴(config/secrets, 관리자 전용 콜러블로만 조회/저장)
// 으로 Gmail SMTP 자격증명을 저장 — 클라이언트는 firestore.rules에서 config/secrets
// 전체가 차단돼 있어 절대 못 읽음. 관리자가 admin-ai 페이지에서 Gmail 주소+앱
// 비밀번호(2단계 인증 계정에서 발급하는 16자리, 일반 로그인 비밀번호 아님)를
// 입력하면 이 함수들이 동작하기 시작함 — 설정 전엔 발송만 조용히 스킵됨(로그
// 인증/가입 자체는 이메일과 무관하게 항상 정상 동작).
let _mailTransport = null, _mailTransportUser = null;
async function _getMailTransport(db) {
  const secSnap = await db.collection('config').doc('secrets').get();
  const gmailUser = secSnap.exists ? secSnap.data().gmail_user : null;
  const gmailPass = secSnap.exists ? secSnap.data().gmail_app_pass : null;
  if (!gmailUser || !gmailPass) return null;
  if (_mailTransport && _mailTransportUser === gmailUser) return _mailTransport;
  _mailTransport = nodemailer.createTransport({ service: 'gmail', auth: { user: gmailUser, pass: gmailPass } });
  _mailTransportUser = gmailUser;
  return _mailTransport;
}
async function _sendMail(db, to, subject, text) {
  try {
    const transport = await _getMailTransport(db);
    if (!transport) { console.log('mail skipped (Gmail 자격증명 미설정):', subject); return; }
    await transport.sendMail({ from: `"화씨.방" <${_mailTransportUser}>`, to, subject, text });
  } catch (e) { console.error('sendMail error:', e.message); }
}

// ── 이메일 발송 rate limit (2026-07-13, 보안방) ──
// findId/sendPasswordResetEmail 둘 다 발송 빈도 제한이 전혀 없어서, 같은 이메일로
// 무한정 반복 호출하면 스팸/메일폭탄으로 악용될 수 있었음(트래픽이 적은 지금은
// 위험이 낮지만 방치하면 안 되는 항목). 계정 존재 여부와 무관하게 "입력된 이메일
// 문자열" 자체를 키로 제한해서 열거 공격 내성(계정 유무 노출 안 함)은 그대로 유지.
// 두 함수가 같은 컬렉션/키를 공유해서, 한쪽 한도를 다 쓰면 다른 함수로 우회 못 함.
const EMAIL_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;   // 같은 이메일 재발송 최소 간격
const EMAIL_RATE_LIMIT_DAILY_MAX   = 5;           // 같은 이메일 하루 최대 발송 횟수(합산)

async function _checkEmailRateLimit(db, email) {
  if (!email) return false;
  const today = new Date().toISOString().slice(0, 10);
  const ref = db.collection('email_rate_limits').doc(email);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const now = new Date();
    if (!snap.exists) {
      tx.set(ref, { last_sent_at: now.toISOString(), date: today, count: 1 });
      return true;
    }
    const d = snap.data();
    if (d.last_sent_at && now.getTime() - new Date(d.last_sent_at).getTime() < EMAIL_RATE_LIMIT_COOLDOWN_MS) return false;
    const count = d.date === today ? (d.count || 0) : 0;
    if (count >= EMAIL_RATE_LIMIT_DAILY_MAX) return false;
    tx.set(ref, { last_sent_at: now.toISOString(), date: today, count: count + 1 });
    return true;
  });
}

exports.getEmailConfigStatus = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const secSnap = await admin.firestore().collection('config').doc('secrets').get();
    const s = secSnap.exists ? secSnap.data() : {};
    return { ok: true, has_config: !!(s.gmail_user && s.gmail_app_pass), gmail_user: s.gmail_user || null };
  });

exports.setEmailConfig = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const gmail_user = (data.gmail_user || '').trim();
    const gmail_app_pass = (data.gmail_app_pass || '').replace(/\s/g, '');
    if (!gmail_user || !gmail_app_pass) throw new functions.https.HttpsError('invalid-argument', 'Gmail 주소와 앱 비밀번호를 모두 입력해주세요.');
    await admin.firestore().collection('config').doc('secrets').set({ gmail_user, gmail_app_pass }, { merge: true });
    _mailTransport = null; // 자격증명이 바뀌었으니 캐시된 트랜스포터 무효화
    return { ok: true };
  });

// 계정 존재 여부를 응답으로 노출하지 않음(열거 공격 방지) — 매치가 있든 없든
// 항상 동일한 {ok:true} 응답, 실제 결과는 이메일로만 전달됨
exports.findId = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const email = (data.email || '').trim().toLowerCase();
    if (email) {
      const db = admin.firestore();
      try {
        const snap = await db.collection('users').where('email', '==', email).get();
        if (!snap.empty && await _checkEmailRateLimit(db, email)) {
          const nicknames = snap.docs.map(d => d.data().nickname).filter(Boolean);
          await _sendMail(db, email, '[화씨.방] 아이디 찾기 결과',
            `안녕하세요, 화씨.방입니다.\n\n입력하신 이메일로 등록된 아이디는 다음과 같습니다:\n\n${nicknames.map(n => `- ${n}`).join('\n')}\n\n본인이 요청하지 않았다면 이 메일은 무시하셔도 됩니다.`);
        }
      } catch (e) { console.error('findId error:', e.message); }
    }
    return { ok: true };
  });

exports.sendPasswordResetEmail = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const nickname = (data.nickname || '').trim();
    const email = (data.email || '').trim().toLowerCase();
    if (nickname && email) {
      const db = admin.firestore();
      try {
        const snap = await db.collection('users').where('nickname', '==', nickname).limit(1).get();
        if (!snap.empty) {
          const doc = snap.docs[0];
          const u = doc.data();
          if (u.email && u.email.toLowerCase() === email && await _checkEmailRateLimit(db, email)) {
            const token = _genSecretId();
            await db.collection('password_reset_tokens').doc(token).set({
              user_id: doc.id, created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), used: false,
            });
            const link = `https://hwasee.me/bang/#resetpw/${token}`;
            await _sendMail(db, email, '[화씨.방] 비밀번호 재설정',
              `안녕하세요, 화씨.방입니다.\n\n아래 링크에서 30분 이내에 새 비밀번호를 설정해주세요:\n\n${link}\n\n본인이 요청하지 않았다면 이 메일은 무시하셔도 됩니다.`);
          }
        }
      } catch (e) { console.error('sendPasswordResetEmail error:', e.message); }
    }
    return { ok: true };
  });

// 트랜잭션으로 토큰 1회성 소진 처리 — _serverStartWordChallenge와 동일한 이유로,
// 별개 읽기/쓰기면 링크를 두 탭에서 거의 동시에 제출했을 때 이중 처리될 수 있음
exports.resetPasswordWithToken = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const token = (data.token || '').trim();
    const new_password = data.new_password || '';
    if (!token || !new_password) return { ok: false, error: '잘못된 요청입니다.' };
    if (!_isValidPassword(new_password)) return { ok: false, error: PW_RULE_MSG };

    const db = admin.firestore();
    const tokRef = db.collection('password_reset_tokens').doc(token);
    const claim = await db.runTransaction(async tx => {
      const snap = await tx.get(tokRef);
      if (!snap.exists) return { ok: false, error: '유효하지 않거나 만료된 링크예요.' };
      const t = snap.data();
      if (t.used) return { ok: false, error: '이미 사용된 링크예요.' };
      if (new Date(t.expires_at) < new Date()) return { ok: false, error: '만료된 링크예요. 다시 요청해주세요.' };
      tx.update(tokRef, { used: true });
      return { ok: true, user_id: t.user_id };
    });
    if (!claim.ok) return claim;

    const newSalt = _genSalt();
    const newHash = _hashPwSalted(new_password, newSalt);
    await db.collection('user_secrets').doc(claim.user_id).set({
      pw_hash: newHash, salt: newSalt, token: _genSecretId(),
      token_exp: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }, { merge: true });
    return { ok: true };
  });

// ── password_reset_tokens 정기 정리 (2026-07-13, 보안방) ──
// 토큰은 30분 만료/1회 소진되면 더 이상 유효하지 않지만, 문서 자체는 그대로
// 영원히 쌓이는 구조였음. 이 환경엔 gcloud CLI가 없어 Firestore 네이티브 TTL
// 정책(콘솔/gcloud에서 설정)을 직접 걸 수 없어서, 대신 매일 도는 스케줄 함수로
// 만료됐거나 이미 소진된 문서를 직접 삭제 — 실질 효과는 TTL 정책과 동일함.
exports.cleanupPasswordResetTokens = functions
  .region('asia-northeast3')
  .pubsub.schedule('every 24 hours')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    const db = admin.firestore();
    const nowIso = new Date().toISOString();
    const [expiredSnap, usedSnap] = await Promise.all([
      db.collection('password_reset_tokens').where('expires_at', '<', nowIso).get(),
      db.collection('password_reset_tokens').where('used', '==', true).get(),
    ]);
    const toDelete = new Map();
    expiredSnap.docs.forEach(d => toDelete.set(d.id, d.ref));
    usedSnap.docs.forEach(d => toDelete.set(d.id, d.ref));
    const refs = [...toDelete.values()];
    for (let i = 0; i < refs.length; i += 400) {
      const batch = db.batch();
      refs.slice(i, i + 400).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
    return null;
  });

// 로그인 상태에서 본인 이메일 등록/변경(비어있던 계정 위한 자발적 추가 포함) —
// changePassword와 동일한 session(user_id+token) 검증 패턴
exports.setMyEmail = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id, token = data.token;
    const email = (data.email || '').trim().toLowerCase();
    if (!user_id || !token) throw new functions.https.HttpsError('unauthenticated', '로그인이 필요합니다.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: '올바른 이메일 형식이 아니에요.' };
    const db = admin.firestore();
    const secSnap = await db.collection('user_secrets').doc(user_id).get();
    if (!secSnap.exists || secSnap.data().token !== token) throw new functions.https.HttpsError('permission-denied', '로그인이 필요합니다.');
    await db.collection('users').doc(user_id).update({ email });
    return { ok: true, email };
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

// ── 초스피드 초장편: 투표 없이 즉시 채택되는 스프린트형 이야기 ──────────
// fbCreateSubmission(클라이언트 트랜잭션, firestore.rules에서 episodes/submissions가
// 전부 열려있어 가능한 방식)은 에피소드 open 여부 체크가 트랜잭션 "밖"의 별도
// 읽기라 TOCTOU 허점이 있음(bang/firebase-api.js:1182 부근). 초스피드는 "누가
// 먼저 썼는지"가 메커니즘의 전부라 이 허점을 그대로 두면 안 됨 — Admin SDK
// 콜러블로 만들고, 에피소드 open 체크를 트랜잭션 안의 첫 읽기로 둠.
exports.speedrunSubmit = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const episode_id = data.episode_id;
    const author_id = data.user_id;
    const text = (data.content || '').trim();
    if (!episode_id || !author_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(author_id, data.token);
    if (!text) return { ok: false, error: '내용을 입력해주세요.' };
    if (text.length > 15) return { ok: false, error: '15자 이내로 작성해주세요.' };

    const db = admin.firestore();
    const epRef = db.collection('episodes').doc(episode_id);

    const result = await db.runTransaction(async tx => {
      const epSnap = await tx.get(epRef); // ← 가장 먼저 읽음, 트랜잭션 안에서
      if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
      const ep = epSnap.data();
      if (ep.status !== 'open') return { ok: false, error: '이미 채택됐어요.' };

      const storyRef = db.collection('stories').doc(ep.story_id);
      const [storySnap, uSnap] = await Promise.all([tx.get(storyRef), tx.get(db.collection('users').doc(author_id))]);
      if (!storySnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
      const st = storySnap.data();
      // 이 체크가 없으면 초스피드가 아닌 일반(투표 기반) 이야기의 episode_id를
      // 그대로 넣어 호출해도 즉시채택+마감이 그대로 먹혀서, 남이 투표로 진행
      // 중인 이야기를 아무나 가로챌 수 있었음(디버그방 감사 지적, 2026-07-28) —
      // 클라이언트 버튼이 안 보인다고 서버가 안전한 게 아니므로 여기서 직접 검증.
      if (st.mode !== 'speedrun') return { ok: false, error: '잘못된 요청입니다.' };

      // 최근 채택자 최대 5명 배열(cooldown_winners)에 포함돼 있으면 재참여 불가 —
      // 최근 5단계의 채택자를 매번 쿼리하는 것보다 story 문서에 이미 읽어야 하는
      // 필드로 O(1) 체크(전례 없는 부분이라 새로 설계, 트랜잭션 안에서 추가 읽기 없음)
      if ((st.cooldown_winners || []).includes(author_id)) {
        return { ok: false, error: '최근에 채택돼서 아직 참여할 수 없어요.' };
      }

      const step = Number(ep.step) || 1;
      const points = Number((st.point_values || [])[step - 1]) || 0;
      const sub_id = db.collection('submissions').doc().id;
      const uData = uSnap.exists ? uSnap.data() : {};

      tx.set(db.collection('submissions').doc(sub_id), {
        sub_id, episode_id, story_id: ep.story_id, content: text,
        author_id, author_nickname: uData.display_name || uData.nickname || '익명',
        author_badge: uData.badge || '',
        derived_from: '', vote_count: 0, is_adopted: true,
        created_at: new Date().toISOString(), is_closing: false,
        downvote_count: 0, is_invalidated: false,
      });
      tx.update(epRef, { status: 'closed', closed_at: new Date().toISOString() });

      const nextWinners = [...(st.cooldown_winners || []), author_id].slice(-5);
      const isLastStep = step >= (Number(st.max_steps) || 100);

      if (isLastStep) {
        tx.update(storyRef, {
          current_step: step, status: 'completed', cooldown_winners: nextWinners,
          [`open_steps.${episode_id}`]: admin.firestore.FieldValue.delete(),
        });
      } else {
        const newEpId = db.collection('episodes').doc().id;
        tx.set(db.collection('episodes').doc(newEpId), {
          episode_id: newEpId, story_id: ep.story_id, step: step + 1, parent_sub_id: sub_id,
          status: 'open', vote_total: 0, created_at: new Date().toISOString(), closed_at: '', pending_at: '',
        });
        tx.update(storyRef, {
          current_step: step, cooldown_winners: nextWinners,
          [`open_steps.${episode_id}`]: admin.firestore.FieldValue.delete(),
          [`open_steps.${newEpId}`]: { step: step + 1, sub_count: 0 },
        });
      }

      // _serverAddPoints()는 자체 트랜잭션을 열어서 여기서 재사용 불가(트랜잭션
      // 중첩 금지) — 잔액갱신+배지재계산+point_ledger 기록 로직을 인라인.
      // 업적(adoption_count)은 의도적으로 건드리지 않음(유저 확정) — 초스피드는
      // 투표 없이 빠르게 채택되는 특성이라, 기존 "투표 기반 채택" 업적 기준이
      // 희석되는 걸 막기 위해 별도 추적(전용 업적은 나중에 필요해지면 추가).
      if (points > 0 && author_id !== FB_ADMIN_ID && author_id !== FB_AI_ID && uSnap.exists) {
        const newTotal = (Number(uData.total_points) || 0) + points;
        tx.update(db.collection('users').doc(author_id), { total_points: newTotal, badge: _serverCalcBadge(newTotal) });
        tx.set(db.collection('point_ledger').doc(), {
          user_id: author_id, points, reason: 'speedrun_adopt', sub_id, created_at: new Date().toISOString(),
        });
      }

      return { ok: true, sub_id, points, completed: isLastStep, story_id: ep.story_id };
    });

    if (result.ok) {
      // 위 "업적 의도적으로 안 건드림" 코멘트가 말하던 전용 업적(2026-07-28 추가)
      try { await _serverBumpAchievementCounter(db, author_id, 'speedrun_count'); } catch (e) { console.error('speedrun achievement error:', e.message); }
    }
    if (result.ok && result.completed) {
      try { await _serverRefillSpotlightSlot(db, result.story_id); } catch (e) { console.error('speedrun spotlight refill error:', e.message); }
    }
    return result;
  });

// 정식 "신고"(reports 컬렉션, 운영자 검토용)와는 별개의 경량 자정 장치 — 투표
// 필터가 없는 초스피드 특성상 스팸/의미없는 문장을 커뮤니티가 자체적으로
// 걸러내게 함. 결정적 doc ID(sub_id_voter_id)로 중복 방지를 트랜잭션 안의
// 단일 읽기로 처리(reports의 query-then-write보다 원자성이 강함).
// 비추/추천을 독립 카운터로 각각 3표 도달 시 발동시키면, 한 글에 비추도 3표
// 추천도 3표가 동시에 쌓이는 경우 "무효화"와 "포인트 2배"가 둘 다 발동되는
// 모순이 생길 수 있음(유저 지적, 2026-07-29) — 순추천(추천-비추)을 단일 점수로
// 계산해서 +3이면 보너스, -3이면 무효화로 통일. 한 사람이 같은 글에 추천과
// 비추를 둘 다 남길 수 없게(먼저 누른 방향에 고정) submission_votes 하나의
// 컬렉션/결정적 doc ID로 방향 불문 중복 방지. downvote_count/upvote_count는
// 화면에 각각 몇 표 받았는지 보여주기 위한 표시용 누적치로 별도 유지(순점수
// 계산에만 서로 상쇄해서 씀, 카운트 자체는 안 깎임).
async function _serverSpeedrunVote(data, direction) {
  const sub_id = data.sub_id;
  const voter_id = data.user_id;
  if (!sub_id || !voter_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
  await _requireUser(voter_id, data.token);
  const db = admin.firestore();
  const subRef = db.collection('submissions').doc(sub_id);
  const voteRef = db.collection('submission_votes').doc(`${sub_id}_${voter_id}`);

  const result = await db.runTransaction(async tx => {
    const [subSnap, voteSnap] = await Promise.all([tx.get(subRef), tx.get(voteRef)]);
    if (!subSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
    if (voteSnap.exists) return { ok: false, error: '이미 표시했어요.' };
    const sub = subSnap.data();
    if (sub.author_id === voter_id) return { ok: false, error: '본인 글에는 표시할 수 없습니다.' };
    // speedrunSubmit과 동일한 이유로 방어 — 범위 밖(일반 이야기) 문서에 쓰기가
    // 들어가지 않게 막아둠.
    const storySnap = await tx.get(db.collection('stories').doc(sub.story_id));
    if (!storySnap.exists || storySnap.data().mode !== 'speedrun') return { ok: false, error: '잘못된 요청입니다.' };

    const newUpCount = (Number(sub.upvote_count) || 0) + (direction === 'up' ? 1 : 0);
    const newDownCount = (Number(sub.downvote_count) || 0) + (direction === 'down' ? 1 : 0);
    const netScore = newUpCount - newDownCount;
    tx.set(voteRef, { sub_id, voter_id, direction, created_at: new Date().toISOString() });
    const update = { upvote_count: newUpCount, downvote_count: newDownCount };
    // 각각 !sub.is_invalidated/!sub.upvote_bonus_given 가드로 한 번 발동된 뒤엔
    // 순점수가 등락해도 다시 발동 안 함(무효화는 영구, 보너스도 1회성).
    const willInvalidate = netScore <= -3 && !sub.is_invalidated;
    const willBonus = netScore >= 3 && !sub.upvote_bonus_given && !sub.is_invalidated;
    if (willInvalidate) update.is_invalidated = true;
    if (willBonus) update.upvote_bonus_given = true;
    tx.update(subRef, update);
    return {
      ok: true, upvote_count: newUpCount, downvote_count: newDownCount,
      invalidated: willInvalidate, bonused: willBonus,
      // 보너스 지급 이후에 순점수가 -3까지 떨어져 뒤늦게 무효화되는 경우, 이미
      // 나간 보너스도 같이 회수해야 함(원래 채택 포인트만 회수하면 보너스만큼
      // 유저에게 남아버림)
      reverseBonus: willInvalidate && sub.upvote_bonus_given === true,
    };
  });

  if (result.ok && result.invalidated) {
    const db2 = admin.firestore();
    try { await _serverReverseSpeedrunPoints(db2, sub_id, 'speedrun_adopt', 'speedrun_invalidate'); } catch (e) { console.error('speedrun point reversal error:', e.message); }
    if (result.reverseBonus) {
      try { await _serverReverseSpeedrunPoints(db2, sub_id, 'speedrun_upvote_bonus', 'speedrun_invalidate'); } catch (e) { console.error('speedrun bonus reversal error:', e.message); }
    }
  }
  if (result.ok && result.bonused) {
    try { await _serverBonusSpeedrunPoints(admin.firestore(), sub_id); } catch (e) { console.error('speedrun upvote bonus error:', e.message); }
  }
  return result;
}

exports.speedrunDownvote = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => _serverSpeedrunVote(data, 'down'));

// 비추(신고성 자정 장치)와 대칭되는 추천 — "이어쓰기 센스가 좋았던 글"을 커뮤니티가
// 직접 더 보상해줄 수 있게 함(유저 제안, 2026-07-29). 순점수 +3 도달 시 원래 받은
// 포인트만큼 한 번 더 지급해서 총 2배가 되게 함.
exports.speedrunUpvote = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => _serverSpeedrunVote(data, 'up'));

// 무효화(-3)/보너스클로백 공용 — 강제 회수라 실패해선 안 되므로 잔액부족시
// throw하는 _fbSpendPoints와 달리 0으로 클램프(유저 확정: "이미 다른 데 써버렸어도
// 마이너스로 안 내려감"). point_ledger에서 원래 지급 건을 sub_id+reason으로
// 정확히 찾아서 반대 부호로 역분개.
async function _serverReverseSpeedrunPoints(db, sub_id, sourceReason, reverseReason) {
  const ledgerSnap = await db.collection('point_ledger')
    .where('sub_id', '==', sub_id).where('reason', '==', sourceReason).limit(1).get();
  if (ledgerSnap.empty) return;
  const entry = ledgerSnap.docs[0].data();
  const amount = Number(entry.points) || 0;
  if (amount <= 0) return;
  const uRef = db.collection('users').doc(entry.user_id);
  await db.runTransaction(async tx => {
    const uSnap = await tx.get(uRef);
    if (!uSnap.exists) return;
    const newTotal = Math.max(0, (Number(uSnap.data().total_points) || 0) - amount);
    tx.update(uRef, { total_points: newTotal, badge: _serverCalcBadge(newTotal) });
    tx.set(db.collection('point_ledger').doc(), {
      user_id: entry.user_id, points: -amount, reason: reverseReason, sub_id, created_at: new Date().toISOString(),
    });
  });
}

// speedrunUpvote가 순점수 +3째에서 호출 — point_ledger에서 원래 speedrun_adopt
// 지급 건을 찾아 동일한 금액을 한 번 더 지급(합쳐서 2배).
async function _serverBonusSpeedrunPoints(db, sub_id) {
  const ledgerSnap = await db.collection('point_ledger')
    .where('sub_id', '==', sub_id).where('reason', '==', 'speedrun_adopt').limit(1).get();
  if (ledgerSnap.empty) return;
  const entry = ledgerSnap.docs[0].data();
  const amount = Number(entry.points) || 0;
  if (amount <= 0) return;
  await _serverAddPoints(db, entry.user_id, amount, 'speedrun_upvote_bonus', sub_id);
}

// 초스피드 전용 씨앗 생성 — _serverCreateSeedStory는 max_steps:10/vote_threshold:5가
// 하드코딩돼 있어 그대로 못 씀. point_values는 1~100 셔플(Fisher–Yates)로 스토리
// 생성 시 한 번만 만들어서 저장 — 매 단계 랜덤이 아니라 스토리당 고정 배정.
function _serverCreateSpeedrunSeedStory(db, writer, opening) {
  const story_id = db.collection('stories').doc().id;
  const episode_id = db.collection('episodes').doc().id;
  const point_values = [...Array(100)].map((_, i) => i + 1);
  for (let i = point_values.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [point_values[i], point_values[j]] = [point_values[j], point_values[i]];
  }
  writer.set(db.collection('stories').doc(story_id), {
    story_id, opening: opening.trim(), max_steps: 100, current_step: 0,
    status: 'active', creator_id: FB_AI_ID, creator_nickname: '익명', creator_badge: '',
    created_at: new Date().toISOString(), batch: '', participant_count: 0, like_count: 0,
    is_ai_seed: true, mode: 'speedrun', point_values, cooldown_winners: [],
    hot_score: 0, open_steps: { [episode_id]: { step: 1, sub_count: 0 } },
  });
  writer.set(db.collection('episodes').doc(episode_id), {
    episode_id, story_id, step: 1, parent_sub_id: '',
    status: 'open', vote_total: 0, created_at: new Date().toISOString(), closed_at: '', pending_at: '',
  });
  return story_id;
}

// 15자짜리 짧은 오프닝 — 이후 모든 줄이 15자 제한이라 오프닝만 길면 톤이 어긋남
const SPEEDRUN_OPENINGS = [
  '문이 갑자기 열렸다.', '전화벨이 울렸다.', '하늘에서 뭔가 떨어졌다.',
  '갑자기 정전이 됐다.', '낯선 발소리가 들렸다.', '창문이 저절로 열렸다.',
  '누군가 이름을 불렀다.', '땅이 흔들리기 시작했다.', '갑자기 불이 꺼졌다.',
  '거울 속 내가 웃었다.', '시계가 거꾸로 돌았다.', '편지 한 통이 도착했다.',
];

// 결말 고정 이야기의 마무리 문장 풀 — 장르 무관하게 두루 붙게 톤을 섞어서
// 작성함. 저작권 큐레이션이 필요한 콘텐츠가 아니라(직접 작성) fairytale
// 풀과 달리 정적 배열로 충분 — 스토리마다 랜덤으로 하나 배정.
const FIXED_ENDING_POOL = [
  '그렇게, 아무도 그날의 진실을 다시 묻지 않았다.',
  '문은 닫혔고, 다시는 열리지 않았다.',
  '그는 뒤돌아보지 않고 걸었다.',
  '계절이 두 번 바뀌고 나서야, 모든 것이 제자리를 찾았다.',
  '아무도 몰랐다, 그것이 마지막 만남이라는 것을.',
  '편지는 끝내 부쳐지지 않았다.',
  '그리고, 아주 오랫동안 아무 일도 일어나지 않았다.',
  '그날 이후로 그는 다시 웃을 수 있었다.',
  '모두가 떠난 자리에, 작은 불빛 하나만 남아있었다.',
  '결국, 처음부터 정해져 있던 결말이었다.',
  '세상은 아무 일 없었다는 듯 다시 돌아갔다.',
  '그 후로 오랫동안, 그들은 행복했다.',
];
function _serverRandomFixedEnding() {
  return FIXED_ENDING_POOL[Math.floor(Math.random() * FIXED_ENDING_POOL.length)];
}

// 장르 강제 전환 이야기 — 매 단계 장르가 랜덤으로 바뀜. speedrun의
// point_values와 동일하게 스토리 생성 시 1회만 만들어서 고정 배정(매 단계
// 라이브로 뽑지 않음 — 완결까지 일관되게 조회 가능해야 함).
function _serverRandomGenreSequence(steps) {
  const arr = [];
  for (let i = 0; i < steps; i++) arr.push(SPOTLIGHT_GENRES[Math.floor(Math.random() * SPOTLIGHT_GENRES.length)]);
  return arr;
}

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

// ── 애널리틱스 대시보드: 일별 롤업 집계 (분리된 bang/analytics.html 전용) ──
// users/submissions/point_ledger의 created_at은 fbNow()=UTC ISO 문자열인데,
// visits/{date}와 다른 스케줄 함수들은 전부 KST(Asia/Seoul) 날짜 경계를 씀 —
// 여기서 KST로 통일해서 집계하지 않으면 visits 수치와 날짜가 9시간씩 어긋남.
function _kstDateStr(isoUtc, offsetDays = 0) {
  const t = new Date(isoUtc).getTime() + (9 + offsetDays * 24) * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}
function _addDaysKst(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function _kstDayRangeUtc(kstDateStr) {
  const start = new Date(`${kstDateStr}T00:00:00+09:00`);
  return { startIso: start.toISOString(), endIso: new Date(start.getTime() + 86400000).toISOString() };
}
function _isoWeekStartKst(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=일 ~ 6=토
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day)); // 그 주의 월요일로
  return d.toISOString().slice(0, 10);
}

// 해당 KST 하루치를 처음부터 다시 계산해 analytics_daily/{kstDateStr}에 전체
// 덮어쓰기로 저장. 매번 완전 재계산이라 merge 불필요 — 스케줄 함수와 백필
// onCall이 이 헬퍼 하나를 공유해서 집계 로직이 두 곳에서 갈라지지 않게 함.
// 관리자/AI봇 계정(FB_ADMIN_ID/FB_AI_ID)과 AI 자동참여 제출(is_ai)은 "실유저
// 활동"이 아니므로 신규가입/글쓴유저/DAU 집계에서 전부 제외.
async function _computeAndStoreAnalyticsForDate(db, kstDateStr) {
  const { startIso, endIso } = _kstDayRangeUtc(kstDateStr);
  const isReal = _isRealUser;

  const visitDoc = await db.collection('visits').doc(kstDateStr).get();
  const visitors_unique = visitDoc.exists ? (visitDoc.data().count || 0) : 0;
  const visitors_total  = visitDoc.exists ? (visitDoc.data().raw_count || 0) : 0;

  const [usersSnap, subsSnap, ledgerSnap, votesSnap, wcSubsSnap, cumulativeUsersSnap, hintGuessesSnap] = await Promise.all([
    db.collection('users').where('created_at', '>=', startIso).where('created_at', '<', endIso).get(),
    db.collection('submissions').where('created_at', '>=', startIso).where('created_at', '<', endIso).get(),
    // reason/is_ai는 쿼리 등호필터에 안 넣고(복합 인덱스 필요해지는 걸 회피) 메모리에서 필터
    db.collection('point_ledger').where('created_at', '>=', startIso).where('created_at', '<', endIso).get(),
    db.collection('votes').where('created_at', '>=', startIso).where('created_at', '<', endIso).get(),
    db.collection('word_challenge_submissions').where('created_at', '>=', startIso).where('created_at', '<', endIso).get(),
    // 누적 가입자 수(우상향 곡선용) — 해당 KST 하루가 끝난 시점까지 가입한 전체
    // 유저 수. count() 집계 쿼리라 문서 전체를 안 읽어와 저렴함.
    db.collection('users').where('created_at', '<', endIso).count().get(),
    // 초성힌트 — hint_guesses.created_at은 항상 ISO 문자열(서버 hintGuess onCall이
    // new Date().toISOString()로 씀, notifications.created_at 같은 타입 혼재 없음).
    db.collection('hint_guesses').where('created_at', '>=', startIso).where('created_at', '<', endIso).get(),
  ]);
  const cumulative_users = cumulativeUsersSnap.data().count || 0;

  const new_user_ids = usersSnap.docs.map(d => d.id).filter(isReal);

  const writerIds = new Set();
  let submission_count = 0;
  subsSnap.docs.forEach(d => {
    const s = d.data();
    if (s.is_ai) return;
    submission_count++;
    if (isReal(s.author_id)) writerIds.add(s.author_id);
  });

  // 일별 부문 참여 — 이 제출(submission)이 어느 콘텐츠 종류 스토리에 달린 건지
  // story_id로 역추적. challenge_words가 있으면 단어챌린지 선정작 이어쓰기,
  // mode 필드로 신규 콘텐츠 4종(초스피드/장르전환/결말고정/동화각색) 구분 —
  // speedrun은 vote_threshold가 아예 안 붙어서 mode를 vote_threshold보다 먼저
  // 체크해야 함. mode 없이 vote_threshold만 있으면 레거시 스포트라이트(문장제안+
  // AI픽, sentence/ai 슬롯 폐지로 신규 발생은 없지만 과거 데이터엔 남아있음).
  // 둘 다 없으면 자유 이야기. 필요한 story만 documentId() in 청크(30개)로
  // select() 조회해서 stories 전체를 훑지 않음.
  const section = {
    word_challenge_story: 0, speedrun: 0, genre_switch: 0, fixed_ending: 0,
    fairytale: 0, spotlight_other: 0, free: 0,
  };
  {
    const humanSubStoryIds = [...new Set(subsSnap.docs.map(d => d.data()).filter(s => !s.is_ai).map(s => s.story_id).filter(Boolean))];
    const storyFlagMap = {};
    if (humanSubStoryIds.length) {
      const chunks = [];
      for (let i = 0; i < humanSubStoryIds.length; i += 30) chunks.push(humanSubStoryIds.slice(i, i + 30));
      const chunkSnaps = await Promise.all(chunks.map(c =>
        db.collection('stories').where(admin.firestore.FieldPath.documentId(), 'in', c)
          .select('vote_threshold', 'challenge_words', 'mode').get()
      ));
      chunkSnaps.forEach(snap => snap.docs.forEach(d => { storyFlagMap[d.id] = d.data(); }));
    }
    subsSnap.docs.forEach(d => {
      const s = d.data();
      if (s.is_ai) return;
      const flags = storyFlagMap[s.story_id] || {};
      if (flags.challenge_words) section.word_challenge_story++;
      else if (flags.mode === 'speedrun') section.speedrun++;
      else if (flags.mode === 'genre_switch') section.genre_switch++;
      else if (flags.mode === 'fixed_ending') section.fixed_ending++;
      else if (flags.mode === 'fairytale') section.fairytale++;
      else if (flags.vote_threshold) section.spotlight_other++;
      else section.free++;
    });
  }

  // 초성힌트 — 별도 컬렉션(hint_guesses)이라 submissions 기반 부문집계와 분리.
  // guess_count(시도 횟수, 다른 부문의 "제출 건수"와 같은 단위)와 participant
  // 수를 둘 다 저장.
  const hintParticipantIds = new Set();
  let hint_guess_count = 0;
  hintGuessesSnap.docs.forEach(d => {
    const g = d.data();
    hint_guess_count++;
    if (isReal(g.user_id)) hintParticipantIds.add(g.user_id);
  });

  const activeIds = new Set();
  ledgerSnap.docs.forEach(d => {
    const p = d.data();
    if (p.reason === 'daily_login' && isReal(p.user_id)) activeIds.add(p.user_id);
  });

  const voterIds = new Set();
  let vote_count = 0;
  votesSnap.docs.forEach(d => {
    const v = d.data();
    if (v.is_ai) return;
    vote_count++;
    if (isReal(v.voter_id)) voterIds.add(v.voter_id);
  });

  const wcWriterIds = new Set();
  wcSubsSnap.docs.forEach(d => {
    const w = d.data();
    if (isReal(w.user_id)) wcWriterIds.add(w.user_id);
  });

  await db.collection('analytics_daily').doc(kstDateStr).set({
    date: kstDateStr,
    visitors_unique, visitors_total,
    new_users_count: new_user_ids.length, new_user_ids,
    writer_count: writerIds.size, writer_ids: [...writerIds],
    submission_count,
    active_user_count: activeIds.size, active_user_ids: [...activeIds],
    vote_count, voter_count: voterIds.size, voter_ids: [...voterIds],
    wc_writer_count: wcWriterIds.size, wc_writer_ids: [...wcWriterIds],
    cumulative_users,
    // 부문별 참여(제출 기준) — word_challenge/초성힌트는 story submissions가
    // 아니라 각자 별도 컬렉션 건수(응모/시도 자체), 나머지는 section 변수 그대로.
    section_word_challenge: wcSubsSnap.size,
    section_word_challenge_story: section.word_challenge_story,
    section_speedrun: section.speedrun,
    section_genre_switch: section.genre_switch,
    section_fixed_ending: section.fixed_ending,
    section_fairytale: section.fairytale,
    section_spotlight_other: section.spotlight_other,
    section_free: section.free,
    hint_guess_count, hint_participant_count: hintParticipantIds.size, hint_participant_ids: [...hintParticipantIds],
    computed_at: new Date().toISOString(),
  });

  // 누적("역대") 글쓴 유저 집합 — 가입자 대비 "글을 써본 적 있는 유저 비율" 계산용.
  // arrayUnion은 자동 중복제거+멱등이라 백필로 같은 날짜를 다시 계산해도 안전함.
  if (writerIds.size) {
    await db.collection('analytics_daily').doc('_lifetime').set({
      writer_ids: admin.firestore.FieldValue.arrayUnion(...writerIds),
      updated_at: new Date().toISOString(),
    }, { merge: true });
  }
}

// 매일 KST 00:15에 "방금 끝난" KST 하루치를 집계. streakReminderPush 등과
// 동일한 region+timeZone 패턴. 00:00이 아니라 00:15인 이유는 자정 직후 아직
// 처리 중일 수 있는 막판 쓰기와의 경합을 피하기 위함.
exports.computeAnalyticsDaily = functions
  .region('asia-northeast3')
  .pubsub.schedule('every day 00:15')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    const db = admin.firestore();
    const kstDate = _kstDateStr(new Date().toISOString(), -1);
    await _computeAndStoreAnalyticsForDate(db, kstDate);
    return null;
  });

// 과거 이력 소급 백필(관리자 전용, bang/analytics.js가 여러 날짜 구간을 나눠
// 여러 번 호출). 한 번에 최대 31일로 제한해 onCall 기본 타임아웃(60초) 안에
// 여유있게 끝나도록 함 — 서비스 시작일부터 전체 백필은 클라이언트가 31일
// 단위로 반복 호출.
exports.backfillAnalyticsDaily = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const start = data.start_date, end = data.end_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
      throw new functions.https.HttpsError('invalid-argument', '날짜 형식이 올바르지 않습니다.');
    }
    const dates = [];
    for (let d = start; d <= end; d = _addDaysKst(d, 1)) dates.push(d);
    if (dates.length > 31) {
      throw new functions.https.HttpsError('invalid-argument', '한 번에 최대 31일까지 백필할 수 있습니다.');
    }
    const db = admin.firestore();
    for (const d of dates) await _computeAndStoreAnalyticsForDate(db, d);
    return { ok: true, backfilled: dates.length };
  });

// 주간 신규가입 코호트별 D1/D7/D30 잔존율 — 표본이 작을 수 있어(신규가입
// 코호트가 한 자릿수인 주도 흔함) 참고용 보조 표. byDate에 target 날짜의
// 롤업이 아직 없거나(백필 안 됨) target이 미래면 그 유저는 분모에서 제외
// (모르는 걸 0%로 잘못 집계하지 않기 위함).
function _computeSignupCohorts(byDate, visibleDates, todayKst) {
  const WINDOWS = [1, 7, 30];
  const cohortMap = {};
  visibleDates.forEach(d => {
    const day = byDate[d];
    if (!day || !day.new_user_ids || !day.new_user_ids.length) return;
    const week = _isoWeekStartKst(d);
    if (!cohortMap[week]) cohortMap[week] = { cohort_week: week, signup_count: 0, retained: { 1: 0, 7: 0, 30: 0 }, eligible: { 1: 0, 7: 0, 30: 0 } };
    const c = cohortMap[week];
    day.new_user_ids.forEach(uid => {
      c.signup_count++;
      WINDOWS.forEach(w => {
        const target = _addDaysKst(d, w);
        if (target > todayKst) return;
        const targetDay = byDate[target];
        if (!targetDay) return;
        c.eligible[w]++;
        if ((targetDay.active_user_ids || []).includes(uid)) c.retained[w]++;
      });
    });
  });
  return Object.values(cohortMap)
    .sort((a, b) => (a.cohort_week < b.cohort_week ? -1 : 1))
    .map(c => ({
      cohort_week: c.cohort_week,
      signup_count: c.signup_count,
      d1_pct: c.eligible[1] ? +(c.retained[1] / c.eligible[1] * 100).toFixed(1) : null, d1_n: c.eligible[1],
      d7_pct: c.eligible[7] ? +(c.retained[7] / c.eligible[7] * 100).toFixed(1) : null, d7_n: c.eligible[7],
      d30_pct: c.eligible[30] ? +(c.retained[30] / c.eligible[30] * 100).toFixed(1) : null, d30_n: c.eligible[30],
      low_confidence: c.signup_count < 5,
    }));
}

// 주간 신규가입 코호트별 "가입→첫 활동(글쓰기 또는 투표) 전환율" — 리텐션(다시
// 돌아오는지)과는 다른 질문: "애초에 한 번이라도 참여해봤는지"를 봄. D1/D7/D30
// 윈도우 안에 하루라도 writer_ids/voter_ids에 등장하면 활성화된 것으로 봄
// (리텐션처럼 정확히 그날 활동했는지가 아니라 그 기간 누적 여부) — 윈도우에
// 포함된 모든 날짜의 롤업이 있어야 판정 가능(중간에 미백필 구간이 있으면 스킵).
function _computeActivationCohorts(byDate, visibleDates, todayKst) {
  const WINDOWS = [1, 7, 30];
  const cohortMap = {};
  visibleDates.forEach(d => {
    const day = byDate[d];
    if (!day || !day.new_user_ids || !day.new_user_ids.length) return;
    const week = _isoWeekStartKst(d);
    if (!cohortMap[week]) cohortMap[week] = { cohort_week: week, signup_count: 0, activated: { 1: 0, 7: 0, 30: 0 }, eligible: { 1: 0, 7: 0, 30: 0 } };
    const c = cohortMap[week];
    day.new_user_ids.forEach(uid => {
      c.signup_count++;
      WINDOWS.forEach(w => {
        const windowEnd = _addDaysKst(d, w);
        if (windowEnd > todayKst) return;
        let dataComplete = true, activated = false;
        for (let dt = d; dt <= windowEnd; dt = _addDaysKst(dt, 1)) {
          const dayData = byDate[dt];
          if (!dayData) { dataComplete = false; break; }
          if ((dayData.writer_ids || []).includes(uid) || (dayData.voter_ids || []).includes(uid)) { activated = true; break; }
        }
        if (!dataComplete) return;
        c.eligible[w]++;
        if (activated) c.activated[w]++;
      });
    });
  });
  return Object.values(cohortMap)
    .sort((a, b) => (a.cohort_week < b.cohort_week ? -1 : 1))
    .map(c => ({
      cohort_week: c.cohort_week,
      signup_count: c.signup_count,
      d1_pct: c.eligible[1] ? +(c.activated[1] / c.eligible[1] * 100).toFixed(1) : null, d1_n: c.eligible[1],
      d7_pct: c.eligible[7] ? +(c.activated[7] / c.eligible[7] * 100).toFixed(1) : null, d7_n: c.eligible[7],
      d30_pct: c.eligible[30] ? +(c.activated[30] / c.eligible[30] * 100).toFixed(1) : null, d30_n: c.eligible[30],
      low_confidence: c.signup_count < 5,
    }));
}

// 이야기 시작 주(created_at 기준) 코호트별 완주율 — "얼마나 자주 오는가"가 아니라
// "시작한 이야기가 끝까지 가는가"를 봄. stories엔 완결 시각 필드가 없어서(status만
// 'completed'로 바뀜) 날짜별 롤업으로는 못 만들고, 매 조회 시점 stories 전체를
// 가볍게 스캔해 "현재 상태"를 코호트에 반영함(실시간 진실 — 오래된 코호트일수록
// 자연히 완주율이 안정화됨).
function _computeStoryCohorts(storiesDocs) {
  const cohortMap = {};
  storiesDocs.forEach(s => {
    if (!s.created_at) return;
    const week = _isoWeekStartKst(s.created_at.slice(0, 10));
    if (!cohortMap[week]) cohortMap[week] = { cohort_week: week, started: 0, completed: 0, inactive: 0, active: 0 };
    const c = cohortMap[week];
    c.started++;
    if (s.status === 'completed') c.completed++;
    else if (s.status === 'inactive') c.inactive++;
    else c.active++;
  });
  return Object.values(cohortMap)
    .sort((a, b) => (a.cohort_week < b.cohort_week ? -1 : 1))
    .map(c => ({ ...c, completion_pct: c.started ? +(c.completed / c.started * 100).toFixed(1) : null, low_confidence: c.started < 5 }));
}

// 대시보드 조회(관리자 전용). days 또는 start_date/end_date로 조회 범위를 정하고,
// MAU(월간 활성유저, stickiness 계산용) 산출에 필요한 직전 30일치를 여유분으로
// 더 가져와서 잘라냄 — series/retention/stickiness에는 요청한 구간만 노출.
exports.getAnalyticsDashboard = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const LOOKBACK = 30; // MAU(30일 윈도우) 계산에 필요한 최대 여유분
    const todayKst = _kstDateStr(new Date().toISOString());
    let dates;
    if (data.start_date && data.end_date) {
      dates = [];
      for (let d = _addDaysKst(data.start_date, -LOOKBACK); d <= data.end_date; d = _addDaysKst(d, 1)) dates.push(d);
    } else {
      // 오늘(KST)은 computeAnalyticsDaily가 아직 계산 안 한 게 정상(내일 새벽에야
      // 채워짐)이라, 빠른선택 버튼(days만 지정)에선 매번 "오늘 누락" 배너가 뜨는 걸
      // 막기 위해 조회 구간을 어제까지로 잡음. 명시적 start_date/end_date로 오늘을
      // 직접 지정하는 건 그대로 허용(사용자가 의도한 선택이므로).
      const days = Math.min(Math.max(Number(data.days) || 30, 1), 3650);
      dates = [];
      for (let i = days + LOOKBACK; i >= 1; i--) dates.push(_addDaysKst(todayKst, -i));
    }

    const refs = dates.map(d => db.collection('analytics_daily').doc(d));
    const [snaps, lifetimeSnap, usersCountSnap, storiesSnap, usersReferralSnap] = await Promise.all([
      db.getAll(...refs),
      db.collection('analytics_daily').doc('_lifetime').get(),
      db.collection('users').count().get(),
      // 이야기 완주율 코호트용 — created_at/status만 필요해서 select()로 대역폭 절약.
      db.collection('stories').select('created_at', 'status').get(),
      // 가입경로별 교차표용 — referral만 필요.
      db.collection('users').select('referral').get(),
    ]);
    const byDate = {};
    snaps.forEach((s, i) => { byDate[dates[i]] = s.exists ? s.data() : null; });

    const visibleDates = dates.slice(LOOKBACK);
    const series = visibleDates.map(d => {
      const v = byDate[d] || {};
      return {
        date: d,
        visitors_unique: v.visitors_unique || 0, visitors_total: v.visitors_total || 0,
        new_users_count: v.new_users_count || 0, writer_count: v.writer_count || 0,
        submission_count: v.submission_count || 0, active_user_count: v.active_user_count || 0,
        vote_count: v.vote_count || 0, voter_count: v.voter_count || 0,
        wc_writer_count: v.wc_writer_count || 0,
        cumulative_users: v.cumulative_users || 0,
        section_word_challenge: v.section_word_challenge || 0,
        section_word_challenge_story: v.section_word_challenge_story || 0,
        section_speedrun: v.section_speedrun || 0,
        section_genre_switch: v.section_genre_switch || 0,
        section_fixed_ending: v.section_fixed_ending || 0,
        section_fairytale: v.section_fairytale || 0,
        section_spotlight_other: v.section_spotlight_other || 0,
        section_free: v.section_free || 0,
        hint_guess_count: v.hint_guess_count || 0,
        hint_participant_count: v.hint_participant_count || 0,
        has_data: !!byDate[d],
      };
    });

    // 트레일링 N일 활성유저(daily_login 기준) 합집합 — WAU/MAU/코호트가 전부 이걸 공유.
    const activeSetTrailing = (d, windowDays) => {
      const ids = new Set();
      for (let i = 0; i < windowDays; i++) {
        const day = byDate[_addDaysKst(d, -i)];
        (day && day.active_user_ids || []).forEach(id => ids.add(id));
      }
      return ids;
    };
    const retention = visibleDates.map(d => {
      const thisW = activeSetTrailing(d, 7), prevW = activeSetTrailing(_addDaysKst(d, -7), 7);
      const retained = [...prevW].filter(id => thisW.has(id));
      return {
        date: d, wau: thisW.size, prev_wau: prevW.size,
        retention_pct: prevW.size ? +(retained.length / prevW.size * 100).toFixed(1) : null,
      };
    });

    // 재방문 빈도(Stickiness) — "활성 유저 중 얼마나 자주 돌아오는가"를 DAU 대비
    // WAU/MAU 비율로 근사. 100%에 가까울수록 활성유저 대부분이 거의 매일 옴,
    // 낮을수록 어쩌다 한 번씩만 들르는 유저 비중이 큼(신규 데이터 수집 없이
    // 이미 저장해둔 daily_login 기반 active_user_ids만으로 계산 가능).
    const stickiness = visibleDates.map(d => {
      const day = byDate[d];
      const dau = (day && day.active_user_count) || 0;
      const wau = activeSetTrailing(d, 7).size;
      const mau = activeSetTrailing(d, 30).size;
      return {
        date: d, dau, wau, mau,
        dau_wau_pct: wau ? +(dau / wau * 100).toFixed(1) : null,
        dau_mau_pct: mau ? +(dau / mau * 100).toFixed(1) : null,
      };
    });

    const cohorts = _computeSignupCohorts(byDate, visibleDates, todayKst);
    const activation_cohorts = _computeActivationCohorts(byDate, visibleDates, todayKst);
    const story_cohorts = _computeStoryCohorts(storiesSnap.docs.map(d => d.data()));

    const lifetimeWriterIds = lifetimeSnap.exists ? (lifetimeSnap.data().writer_ids || []) : [];
    const lifetimeWriterSet = new Set(lifetimeWriterIds);
    const totalUsers = usersCountSnap.data().count || 0;
    const storiesCompleted = story_cohorts.reduce((sum, c) => sum + c.completed, 0);
    const storiesStarted = story_cohorts.reduce((sum, c) => sum + c.started, 0);
    const lifetime = {
      total_users: totalUsers,
      writer_count: lifetimeWriterIds.length,
      writer_pct: totalUsers ? +(lifetimeWriterIds.length / totalUsers * 100).toFixed(1) : null,
      stories_started: storiesStarted,
      stories_completed: storiesCompleted,
      stories_completion_pct: storiesStarted ? +(storiesCompleted / storiesStarted * 100).toFixed(1) : null,
    };

    // 가입경로(referral)별 교차표 — 그 채널 유저들이 실제로 글을 써봤는지(누적)
    // 및 최근 30일 안에 활동했는지(조회 구간 마지막 날 기준 MAU)를 함께 봄.
    // "유입량"은 기존 이용통계 페이지에 이미 있으니 여기선 품질(정착도)만 다룸.
    const recentMauSet = visibleDates.length ? activeSetTrailing(visibleDates[visibleDates.length - 1], 30) : new Set();
    const referralMap = {};
    usersReferralSnap.docs.forEach(d => {
      if (!_isRealUser(d.id)) return;
      const referral = (d.data().referral || '').trim() || '미입력';
      if (!referralMap[referral]) referralMap[referral] = { referral, total: 0, writers: 0, active_recent: 0 };
      const r = referralMap[referral];
      r.total++;
      if (lifetimeWriterSet.has(d.id)) r.writers++;
      if (recentMauSet.has(d.id)) r.active_recent++;
    });
    const referral_breakdown = Object.values(referralMap)
      .map(r => ({
        ...r,
        writer_pct: r.total ? +(r.writers / r.total * 100).toFixed(1) : null,
        active_pct: r.total ? +(r.active_recent / r.total * 100).toFixed(1) : null,
      }))
      .sort((a, b) => b.total - a.total);

    // 업적(뱃지) 발생건수 추이 — notifications(type:'achievement')가 유일한 타임스탬프
    // 기록(users.achievements 배열엔 시각이 없어 추이를 못 만듦). created_at이
    // 클라이언트 경로(_fbCheckAchievements, ISO 문자열)와 서버 경로
    // (_serverCheckAchievements, Firestore Timestamp)로 섞여 저장되는 기존 버그가
    // 있어 range 쿼리 대신 type 등호필터로만 전량 읽고(유저수×업적30종이 상한이라
    // 소량) 메모리에서 두 형태 다 처리해 날짜별로 집계 — 그래서 별도 백필도 불필요,
    // 매번 최신 전체를 다시 계산함.
    const achievementsSnap = await db.collection('notifications').where('type', '==', 'achievement').get();
    const achievementCountByDate = {};
    achievementsSnap.docs.forEach(d => {
      const raw = d.data().created_at;
      const iso = typeof raw === 'string' ? raw
        : (raw && typeof raw.toDate === 'function') ? raw.toDate().toISOString() : null;
      if (!iso) return;
      const dateStr = _kstDateStr(iso);
      achievementCountByDate[dateStr] = (achievementCountByDate[dateStr] || 0) + 1;
    });
    const achievements = visibleDates.map(d => ({ date: d, count: achievementCountByDate[d] || 0 }));
    lifetime.achievements_total = achievementsSnap.size;

    return {
      ok: true, series, retention, stickiness, cohorts, activation_cohorts, story_cohorts,
      referral_breakdown, achievements, lifetime, generated_at: new Date().toISOString(),
    };
  });

// 시계열 배열 하나를 "최근값/기간평균/전반부 대비 후반부 증감률/최고점" 요약으로
// 압축 — AI 분석 프롬프트에 일별 원본 배열을 통째로 넣으면 토큰 낭비라 요약만 전달.
function _trendSummary(dates, values) {
  const n = values.length;
  if (!n) return null;
  const half = Math.max(1, Math.floor(n / 2));
  const firstHalf = values.slice(0, half);
  const secondHalf = values.slice(half).length ? values.slice(half) : firstHalf;
  const avg = arr => arr.reduce((a, b) => a + (b || 0), 0) / arr.length;
  const avgFirst = avg(firstHalf), avgSecond = avg(secondHalf);
  const peakIdx = values.reduce((mi, v, i) => ((v || 0) > (values[mi] || 0) ? i : mi), 0);
  return {
    latest: values[n - 1], period_avg: +avg(values).toFixed(1),
    change_pct: avgFirst ? +((avgSecond - avgFirst) / avgFirst * 100).toFixed(1) : null,
    peak: values[peakIdx], peak_date: dates[peakIdx],
  };
}

// 차트별 AI 분석 의견(관리자 전용, 온디맨드). 대시보드 로드마다 자동 호출하면
// 매번 Claude 비용+지연이 붙으므로, 클라이언트가 버튼을 눌렀을 때만 이미
// getAnalyticsDashboard로 받아둔 시계열을 그대로 넘겨받아 호출함 — 서버가
// 다시 집계하지 않고 요약 통계만 뽑아 Claude에 넘김.
exports.getAnalyticsInsights = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const secretsSnap = await db.collection('config').doc('secrets').get();
    const claudeKey = secretsSnap.exists ? secretsSnap.data().claude_key : null;
    if (!claudeKey) return { ok: false, error: 'Claude API 키가 설정되지 않았어요. admin-ai 페이지에서 먼저 등록해주세요.' };

    const series = Array.isArray(data.series) ? data.series : [];
    const retention = Array.isArray(data.retention) ? data.retention : [];
    const stickiness = Array.isArray(data.stickiness) ? data.stickiness : [];
    const cohorts = Array.isArray(data.cohorts) ? data.cohorts : [];
    const activationCohorts = Array.isArray(data.activation_cohorts) ? data.activation_cohorts : [];
    const storyCohorts = Array.isArray(data.story_cohorts) ? data.story_cohorts : [];
    const referralBreakdown = Array.isArray(data.referral_breakdown) ? data.referral_breakdown : [];
    const lifetime = data.lifetime || {};
    if (!series.length) return { ok: false, error: '분석할 데이터가 없어요.' };

    const dates = series.map(d => d.date);
    const summary = {
      기간: `${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length}일)`,
      방문자_순: _trendSummary(dates, series.map(d => d.visitors_unique)),
      방문자_총: _trendSummary(dates, series.map(d => d.visitors_total)),
      신규가입: _trendSummary(dates, series.map(d => d.new_users_count)),
      누적가입자수: _trendSummary(dates, series.map(d => d.cumulative_users)),
      글쓴유저: _trendSummary(dates, series.map(d => d.writer_count)),
      제출글: _trendSummary(dates, series.map(d => d.submission_count)),
      투표유저: _trendSummary(dates, series.map(d => d.voter_count)),
      총투표수: _trendSummary(dates, series.map(d => d.vote_count)),
      단어챌린지작성유저: _trendSummary(dates, series.map(d => d.wc_writer_count)),
      DAU: _trendSummary(dates, series.map(d => d.active_user_count)),
      주간잔존율_퍼센트: _trendSummary(retention.map(d => d.date), retention.map(d => d.retention_pct || 0)),
      스티키니스_DAU_WAU_퍼센트: _trendSummary(stickiness.map(d => d.date), stickiness.map(d => d.dau_wau_pct || 0)),
      스티키니스_DAU_MAU_퍼센트: _trendSummary(stickiness.map(d => d.date), stickiness.map(d => d.dau_mau_pct || 0)),
      부문별_참여_단어챌린지응모: _trendSummary(dates, series.map(d => d.section_word_challenge)),
      부문별_참여_단어챌린지선정작이어쓰기: _trendSummary(dates, series.map(d => d.section_word_challenge_story)),
      부문별_참여_초성힌트시도: _trendSummary(dates, series.map(d => d.hint_guess_count)),
      부문별_참여_초스피드: _trendSummary(dates, series.map(d => d.section_speedrun)),
      부문별_참여_장르전환: _trendSummary(dates, series.map(d => d.section_genre_switch)),
      부문별_참여_결말고정: _trendSummary(dates, series.map(d => d.section_fixed_ending)),
      부문별_참여_동화각색: _trendSummary(dates, series.map(d => d.section_fairytale)),
      '부문별_참여_레거시스포트라이트(문장제안+AI픽,신규발생없음)': _trendSummary(dates, series.map(d => d.section_spotlight_other)),
      부문별_참여_자유이야기: _trendSummary(dates, series.map(d => d.section_free)),
      일별_업적달성건수: _trendSummary((data.achievements || []).map(d => d.date), (data.achievements || []).map(d => d.count)),
      최근_신규가입_리텐션_코호트: cohorts.slice(-4),
      최근_가입후_첫활동_전환_코호트: activationCohorts.slice(-4),
      최근_이야기_완주_코호트: storyCohorts.slice(-4),
      가입경로별_정착도: referralBreakdown,
      누적_가입자_대비_글쓴유저_및_완주율_및_누적업적수: lifetime,
    };

    const prompt = `다음은 협업 릴레이소설 서비스 "화씨.방" 관리자 애널리틱스 대시보드의 최근 추이 요약(JSON)입니다. 운영자가 참고할 수 있도록 지표별로 간결한 한국어 분석 의견을 1~2문장씩 작성해주세요. 숫자를 그대로 반복하지 말고, 증가/감소 흐름과 그 의미, 주목할 점, 필요하면 짧은 제안을 담아주세요. change_pct가 null이거나 표본(n)이 작은 지표는 그 한계도 짧게 언급하세요. "가입후_첫활동_전환"은 리텐션(다시 돌아오는지)과 다르게 "애초에 한 번이라도 참여해봤는지"를 뜻합니다. "부문별_참여"는 최근 대규모 콘텐츠 업그레이드로 추가된 초성힌트/초스피드/장르전환/결말고정/동화각색을 포함해 그날 참여가 어디에 몰렸는지를 뜻합니다(레거시 스포트라이트는 옛 슬롯 방식으로 지금은 신규 발생이 없음). "일별_업적달성건수"는 유저들이 뱃지(업적)를 새로 획득한 건수 추이입니다.

${JSON.stringify(summary)}

다른 설명 없이 아래 키를 가진 JSON 객체 하나만 출력하세요:
{"overall":"...", "visitors":"...", "cumulative_users":"...", "writers":"...", "votes":"...", "word_challenge":"...", "dau":"...", "stickiness":"...", "retention":"...", "cohorts":"...", "activation":"...", "story_completion":"...", "referral":"...", "sections":"...", "achievements":"..."}`;

    let raw;
    try { raw = await _callClaude(claudeKey, prompt, 1400); }
    catch (e) { return { ok: false, error: 'AI 분석 호출에 실패했어요: ' + e.message }; }
    if (!raw) return { ok: false, error: 'AI 분석 응답이 비어있어요.' };

    let insights;
    try {
      const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
      insights = JSON.parse(jsonText);
    } catch (e) { return { ok: false, error: 'AI 분석 응답을 해석하지 못했어요.' }; }

    return { ok: true, insights, generated_at: new Date().toISOString() };
  });

// ── Google Analytics 4 연동 (일별 평균 체류시간) — Claude/카카오 키와 동일하게
// config/secrets에 저장, _requireAdmin 게이트로만 조회/설정. gtag.js가 이미
// 앱에 붙어있어(bang/index.html) GA4가 세션 참여시간을 자동 수집 중이므로,
// 새 클라이언트 계측을 만들지 않고 GA4 Data API로 이미 쌓인 값만 읽어옴.
exports.getGa4KeyStatus = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const secretsSnap = await db.collection('config').doc('secrets').get();
    const s = secretsSnap.exists ? secretsSnap.data() : {};
    return { ok: true, has_key: !!s.ga4_service_account_json, property_id: s.ga4_property_id || null };
  });

exports.setGa4Key = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const propertyId = (data.property_id || '').trim();
    const serviceAccountJson = data.service_account_json;
    if (!propertyId || !/^\d+$/.test(propertyId)) {
      throw new functions.https.HttpsError('invalid-argument', 'GA4 속성 ID는 숫자만 입력해주세요(측정 ID "G-..."가 아니라 GA4 관리 → 속성 세부정보의 속성 ID).');
    }
    if (!serviceAccountJson) {
      throw new functions.https.HttpsError('invalid-argument', '서비스 계정 JSON 키를 입력해주세요.');
    }
    let parsed;
    try { parsed = JSON.parse(serviceAccountJson); }
    catch (e) { throw new functions.https.HttpsError('invalid-argument', 'JSON 형식이 올바르지 않습니다.'); }
    if (!parsed.client_email || !parsed.private_key) {
      throw new functions.https.HttpsError('invalid-argument', '서비스 계정 키 파일이 아닌 것 같아요(client_email/private_key 필드가 없음).');
    }
    const db = admin.firestore();
    await db.collection('config').doc('secrets').set({
      ga4_service_account_json: serviceAccountJson, ga4_property_id: propertyId,
    }, { merge: true });
    return { ok: true };
  });

exports.getGa4EngagementTrend = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const secretsSnap = await db.collection('config').doc('secrets').get();
    const s = secretsSnap.exists ? secretsSnap.data() : {};
    if (!s.ga4_service_account_json || !s.ga4_property_id) {
      return { ok: false, error: 'GA4 연동이 아직 설정되지 않았어요.' };
    }

    const start_date = data.start_date, end_date = data.end_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      throw new functions.https.HttpsError('invalid-argument', '날짜 형식이 올바르지 않습니다.');
    }

    let credentials;
    try { credentials = JSON.parse(s.ga4_service_account_json); }
    catch (e) { return { ok: false, error: '저장된 GA4 서비스 계정 키가 손상됐어요. 애널리틱스 대시보드에서 다시 저장해주세요.' }; }

    let series = [];
    try {
      const { BetaAnalyticsDataClient } = require('@google-analytics/data');
      const client = new BetaAnalyticsDataClient({ credentials });
      const [reportResponse] = await client.runReport({
        property: `properties/${s.ga4_property_id}`,
        dateRanges: [{ startDate: start_date, endDate: end_date }],
        dimensions: [{ name: 'date' }],
        // sessions/activeUsers을 같이 받아서 "그날 실제로 온 사람 기준 하루 평균
        // 방문(세션) 횟수"를 계산 — 전체 가입자 대비로 나누면 대부분 0이라
        // 의미가 흐려지므로, 그날 활성 유저(GA4 기준)만 분모로 씀.
        metrics: [
          { name: 'averageSessionDuration' },
          { name: 'sessions' },
          { name: 'activeUsers' },
        ],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      });
      series = (reportResponse.rows || []).map(row => {
        const raw = row.dimensionValues[0].value; // 'YYYYMMDD'
        const dateStr = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
        const seconds = Number(row.metricValues[0].value) || 0;
        const sessions = Number(row.metricValues[1].value) || 0;
        const activeUsers = Number(row.metricValues[2].value) || 0;
        return {
          date: dateStr, avg_engagement_seconds: +seconds.toFixed(1),
          sessions, active_users: activeUsers,
          sessions_per_user: activeUsers ? +(sessions / activeUsers).toFixed(2) : null,
        };
      });
    } catch (e) {
      return { ok: false, error: 'GA4 조회 실패: ' + e.message };
    }

    return { ok: true, series, generated_at: new Date().toISOString() };
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
    // 최소 1표 이상 받아야 당선 — 전원 0표면(참여는 있었지만 아무도 투표를 못
    // 받은 경우) maxVotes가 0이 되면서 "0표 전원 동률 당선"으로 처리돼 포인트가
    // 나가고 아무 문장이나(가장 먼저 제출된 것) 스포트라이트 씨앗으로 채택되던
    // 문제가 있었음(유저 지적, 2026-07-27). 1표 미만이면 당선작 없음으로 처리.
    const tiedWinners = maxVotes >= 1 ? allSubs
      .filter(s => (s.vote_count || 0) === maxVotes)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)) : [];
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
      // 당첨 자체에 대한 알림이 없어서 유저가 이겼는지조차 알 방법이 없었음(제보로 발견)
      try {
        await db.collection('notifications').doc().set({
          user_id: w.user_id, type: 'word_challenge_win', story_id: '',
          message: `🎲 오늘의 단어 챌린지 우승! +${share}p 획득했어요`,
          is_read: false, created_at: new Date().toISOString(), push_sent: false,
        });
      } catch (e) {}
    }

    // 스포트라이트 슬롯1(🎲) FIFO 풀에 채택 문장 적재 — 동률이어도 같은 라운드는
    // 같은 3단어라서 대표 1개만(가장 먼저 제출된 것) 넣음. 그대로 다 넣으면
    // 같은 단어 조합이 스포트라이트에 연달아 노출되는 문제가 있어서.
    if (tiedWinners.length) {
      await db.collection('spotlight_word_pool').doc().set({
        text: tiedWinners[0].text, source_challenge_id: challenge_id, used: false,
        created_at: new Date().toISOString(), winner_user_id: tiedWinners[0].user_id,
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
    await _requireAdmin(data.user_id, data.token);
    await _serverStartWordChallenge(admin.firestore());
    return { ok: true };
  });

exports.adminForceCloseWordChallenge = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    await _serverCloseWordChallenge(admin.firestore());
    return { ok: true };
  });

// ── 3슬롯 "오늘의 이야기" 스포트라이트 ────────────────────────
// config/spotlight_slots = { word:{story_id}, sentence:{story_id,state,round_id}, ai:{story_id}, fairytale:{story_id}, speedrun:{story_id}, fixed_ending:{story_id}, genre_switch:{story_id} }
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
// 이 함수는 스포트라이트 슬롯(오늘의 이야기) 전용 씨앗 생성에만 쓰임(호출부
// 전부 _serverRefillSpotlightSlot/_serverRefillSlotFromPoolIfEmpty/
// adminInitSpotlight) — 그래서 vote_threshold:5를 고정으로 넣어도 안전함.
// 관심이 몰려 표가 너무 빨리 차서 한 단계가 순식간에 지나가버리는 걸 막기
// 위해 일반 이야기(기본 3표, FB_VOTE_THRESHOLD/AI_VOTE_THRESHOLD)보다 높게 잡음.
function _serverCreateSeedStory(db, writer, opening, extraFields) {
  const story_id = db.collection('stories').doc().id;
  const episode_id = db.collection('episodes').doc().id;
  writer.set(db.collection('stories').doc(story_id), {
    story_id, opening: opening.trim(), max_steps: 10, current_step: 0,
    status: 'active', creator_id: FB_AI_ID, creator_nickname: '익명', creator_badge: '',
    created_at: new Date().toISOString(), batch: '', participant_count: 0, like_count: 0,
    is_ai_seed: true, vote_threshold: 5,
    // 자유 이야기 탭 정렬/카드 표시용 (firebase-api.js fbCreateStory 참고)
    hot_score: 0,
    open_steps: { [episode_id]: { step: 1, sub_count: 0 } },
    // 단어챌린지 우승작으로 만들어진 씨앗이면 그 3단어를 같이 저장(challenge_words) —
    // 스포트라이트 카드 오프닝 문장에서 boldChallengeWords()로 강조 표시하기 위함
    // (유저 요청, 2026-07-21). 다른 슬롯(문장 제안/AI)은 extraFields 없이 호출됨.
    ...(extraFields || {}),
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
  let newlyCreatedStoryId = null;
  await db.runTransaction(async tx => {
    const ptrSnap = await tx.get(ptrRef);
    if (!ptrSnap.exists) return; // adminInitSpotlight 실행 전 — 아직 스포트라이트 미도입
    const slots = ptrSnap.data();
    // sentence/ai 슬롯 폐지(2026-07-28) — 더는 이 목록에 없으므로 두 슬롯이던
    // 스토리가 완결돼도 자동 리필하지 않음(featured 노출 자체가 끝났으므로).
    const slotKey = ['word', 'fairytale', 'speedrun', 'fixed_ending', 'genre_switch'].find(k => slots[k] && slots[k].story_id === completed_story_id);
    if (!slotKey) return; // 스포트라이트 슬롯 스토리가 아님

    if (slotKey === 'ai') {
      const usedSnap = await tx.get(db.collection('config').doc('used_openings'));
      const used = usedSnap.exists ? usedSnap.data() : {};
      const available = SPOTLIGHT_AI_OPENINGS.filter(o => !used[o]);
      const src = available.length ? available : SPOTLIGHT_AI_OPENINGS;
      const opening = src[Math.floor(Math.random() * src.length)];
      const newStoryId = _serverCreateSeedStory(db, tx, opening);
      newlyCreatedStoryId = newStoryId;
      tx.set(db.collection('config').doc('used_openings'), { [opening]: true }, { merge: true });
      tx.update(ptrRef, { 'ai.story_id': newStoryId });
      return;
    }

    if (slotKey === 'speedrun') {
      // 저작권 큐레이션이 필요 없는 짧은 오프닝뿐이라 ai 슬롯과 동일하게 정적
      // 배열+used_openings dedup만으로 충분 — 풀 컬렉션 불필요.
      const usedSnap = await tx.get(db.collection('config').doc('used_openings'));
      const used = usedSnap.exists ? usedSnap.data() : {};
      const available = SPEEDRUN_OPENINGS.filter(o => !used[o]);
      const src = available.length ? available : SPEEDRUN_OPENINGS;
      const opening = src[Math.floor(Math.random() * src.length)];
      const newStoryId = _serverCreateSpeedrunSeedStory(db, tx, opening);
      newlyCreatedStoryId = newStoryId;
      tx.set(db.collection('config').doc('used_openings'), { [opening]: true }, { merge: true });
      tx.update(ptrRef, { 'speedrun.story_id': newStoryId });
      return;
    }

    if (slotKey === 'fixed_ending') {
      // 정상 엔진 그대로 재사용(투표/채택 로직 안 건드림) — extraFields로
      // mode+fixed_ending만 얹어서 _serverCloseEpisode의 새 분기가 인식하게 함.
      const usedSnap = await tx.get(db.collection('config').doc('used_openings'));
      const used = usedSnap.exists ? usedSnap.data() : {};
      const available = SPOTLIGHT_AI_OPENINGS.filter(o => !used[o]);
      const src = available.length ? available : SPOTLIGHT_AI_OPENINGS;
      const opening = src[Math.floor(Math.random() * src.length)];
      const newStoryId = _serverCreateSeedStory(db, tx, opening, {
        mode: 'fixed_ending', fixed_ending: _serverRandomFixedEnding(),
      });
      newlyCreatedStoryId = newStoryId;
      tx.set(db.collection('config').doc('used_openings'), { [opening]: true }, { merge: true });
      tx.update(ptrRef, { 'fixed_ending.story_id': newStoryId });
      return;
    }

    if (slotKey === 'genre_switch') {
      const usedSnap = await tx.get(db.collection('config').doc('used_openings'));
      const used = usedSnap.exists ? usedSnap.data() : {};
      const available = SPOTLIGHT_AI_OPENINGS.filter(o => !used[o]);
      const src = available.length ? available : SPOTLIGHT_AI_OPENINGS;
      const opening = src[Math.floor(Math.random() * src.length)];
      const newStoryId = _serverCreateSeedStory(db, tx, opening, {
        mode: 'genre_switch', genre_sequence: _serverRandomGenreSequence(10),
      });
      newlyCreatedStoryId = newStoryId;
      tx.set(db.collection('config').doc('used_openings'), { [opening]: true }, { merge: true });
      tx.update(ptrRef, { 'genre_switch.story_id': newStoryId });
      return;
    }

    const poolName = slotKey === 'word' ? 'spotlight_word_pool'
      : slotKey === 'sentence' ? 'spotlight_sentence_pool' : 'spotlight_fairytale_pool';
    const poolSnap = await tx.get(db.collection(poolName).orderBy('created_at', 'asc').limit(50));
    const nextEntry = poolSnap.docs.find(d => !d.data().used);

    if (!nextEntry) {
      if (slotKey === 'sentence') {
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
      } else {
        // word/fairytale은 순수 FIFO 큐라 라운드 개념이 없음 — 그냥 비운 채로 둠
        // (fairytale은 관리자가 다시 채워 넣을 때까지, word는 다음 챌린지 마감까지 대기)
        tx.update(ptrRef, { [`${slotKey}.story_id`]: null });
      }
      return;
    }

    // 단어챌린지 우승작이면 그 3단어를 같이 넘겨서 스토리에 저장(challenge_words) —
    // 쓰기(tx.update) 전에 읽어야 하는 Firestore 트랜잭션 규칙 때문에 여기서 먼저 조회
    let extraFields = {};
    // 완성된 이야기 탭에서 콘텐츠 종류별 배지를 보여주기 위함(유저 요청,
    // 2026-07-28) — 다른 신규 콘텐츠(결말고정/장르전환/초스피드)는 이미
    // mode 필드가 있는데 동화각색만 없어서 추가.
    if (slotKey === 'fairytale') extraFields.mode = 'fairytale';
    const entryData = nextEntry.data();
    if (slotKey === 'word' && entryData.source_challenge_id) {
      const challengeSnap = await tx.get(db.collection('word_challenges').doc(entryData.source_challenge_id));
      if (challengeSnap.exists && Array.isArray(challengeSnap.data().words)) {
        extraFields.challenge_words = challengeSnap.data().words;
      }
    }
    // 단어챌린지 우승작/문장제안 채택작은 실제 작성자가 있는데도 스포트라이트
    // 씨앗은 전부 AI/익명으로 표시되고 있었음(유저 지적, 2026-07-27) — 실제
    // 작성자를 알 수 있으면(word는 winner_user_id, sentence는 proposer_id) 그
    // 사람으로 귀속. 순수 AI 랜덤 씨앗(slotKey==='ai')과 관리자 큐레이션
    // 씨앗(slotKey==='fairytale')은 그대로 익명 유지.
    const creatorUserId = slotKey === 'word' ? entryData.winner_user_id
      : slotKey === 'sentence' ? entryData.proposer_id : null;
    if (creatorUserId) {
      const uSnap = await tx.get(db.collection('users').doc(creatorUserId));
      if (uSnap.exists) {
        const u = uSnap.data();
        extraFields.creator_id = creatorUserId;
        extraFields.creator_nickname = u.display_name || u.nickname || '익명';
        extraFields.creator_badge = u.badge || '';
      }
    }
    tx.update(nextEntry.ref, { used: true });
    const newStoryId = _serverCreateSeedStory(db, tx, entryData.text, extraFields);
    newlyCreatedStoryId = newStoryId;
    if (slotKey === 'sentence') {
      tx.update(ptrRef, { 'sentence.story_id': newStoryId, 'sentence.state': 'story', 'sentence.round_id': null });
    } else {
      tx.update(ptrRef, { [`${slotKey}.story_id`]: newStoryId }); // word 또는 fairytale
    }
  });

  // 씨앗 문장 하나만으로도 장르를 어느 정도 가늠할 수 있어서, 첫 마감을 기다리지
  // 않고 슬롯이 새 이야기로 채워지는 즉시 1차 분류를 해둠 — 안 그러면 카드가
  // 새로 채워진 직후엔 장르 패널이 계속 비어있어서(첫 마감까지, 하루 이상 걸릴 수
  // 있음) "오 뭐지?" 하고 눈길을 끌려는 이 기능의 취지 자체가 무색해짐(유저 지적,
  // 2026-07-15). 트랜잭션 밖에서(외부 API 호출은 트랜잭션 안에 넣으면 안 됨) await —
  // fire-and-forget 금지 원칙은 [[feedback_defer_noncritical_writes]] 참고.
  if (newlyCreatedStoryId) {
    await _classifyStoryGenre(db, newlyCreatedStoryId, 0).catch(e => console.error('genre classify(seed) error:', e.message));
  }
}

// slotKey('word'|'sentence')의 풀에 새 항목이 막 쌓였을 때, 그 슬롯이 마침 비어있는
// 상태(story_id==null)였다면 바로 채워줌 — _serverCloseWordChallenge(슬롯1 풀 적재
// 직후)와 closeSentenceRounds(슬롯2 라운드 마감 직후)에서 호출. 이 두 호출 시점엔
// 슬롯이 이미 story_id==null 상태로 놓여 있었을 때만 의미가 있어(그 외엔 손대지
// 않고 조용히 반환), _serverRefillSpotlightSlot과 트랜잭션이 겹칠 일이 없음.
async function _serverRefillSlotFromPoolIfEmpty(db, slotKey) {
  const ptrRef = db.collection('config').doc('spotlight_slots');
  let newlyCreatedStoryId = null;
  await db.runTransaction(async tx => {
    const ptrSnap = await tx.get(ptrRef);
    if (!ptrSnap.exists) return;
    const slot = ptrSnap.data()[slotKey];
    if (!slot || slot.story_id) return; // 이미 진행 중인 스토리가 있으면 손대지 않음

    const poolName = slotKey === 'word' ? 'spotlight_word_pool'
      : slotKey === 'sentence' ? 'spotlight_sentence_pool' : 'spotlight_fairytale_pool';
    const poolSnap = await tx.get(db.collection(poolName).orderBy('created_at', 'asc').limit(50));
    const nextEntry = poolSnap.docs.find(d => !d.data().used);

    if (!nextEntry) {
      // 슬롯2는 라운드가 방금 닫혔는데(호출 시점상 항상 그러함) 제출이 하나도
      // 없어서 채택 풀도 비었을 수 있음 — 그대로 방치하면 영영 안 채워지므로
      // 새 24시간 라운드를 다시 염. word/fairytale은 순수 FIFO 큐라 이 fallback이
      // 필요 없음(비어있으면 그냥 다음 공급까지 대기).
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

    // 단어챌린지 우승작이면 그 3단어를 같이 넘겨서 스토리에 저장(challenge_words) —
    // 쓰기(tx.update) 전에 읽어야 하는 Firestore 트랜잭션 규칙 때문에 여기서 먼저 조회
    let extraFields = {};
    // 완성된 이야기 탭에서 콘텐츠 종류별 배지를 보여주기 위함(유저 요청,
    // 2026-07-28) — 다른 신규 콘텐츠(결말고정/장르전환/초스피드)는 이미
    // mode 필드가 있는데 동화각색만 없어서 추가.
    if (slotKey === 'fairytale') extraFields.mode = 'fairytale';
    const entryData = nextEntry.data();
    if (slotKey === 'word' && entryData.source_challenge_id) {
      const challengeSnap = await tx.get(db.collection('word_challenges').doc(entryData.source_challenge_id));
      if (challengeSnap.exists && Array.isArray(challengeSnap.data().words)) {
        extraFields.challenge_words = challengeSnap.data().words;
      }
    }
    // 단어챌린지 우승작/문장제안 채택작은 실제 작성자가 있는데도 스포트라이트
    // 씨앗은 전부 AI/익명으로 표시되고 있었음(유저 지적, 2026-07-27) — 실제
    // 작성자를 알 수 있으면(word는 winner_user_id, sentence는 proposer_id) 그
    // 사람으로 귀속. 순수 AI 랜덤 씨앗(slotKey==='ai')과 관리자 큐레이션
    // 씨앗(slotKey==='fairytale')은 그대로 익명 유지.
    const creatorUserId = slotKey === 'word' ? entryData.winner_user_id
      : slotKey === 'sentence' ? entryData.proposer_id : null;
    if (creatorUserId) {
      const uSnap = await tx.get(db.collection('users').doc(creatorUserId));
      if (uSnap.exists) {
        const u = uSnap.data();
        extraFields.creator_id = creatorUserId;
        extraFields.creator_nickname = u.display_name || u.nickname || '익명';
        extraFields.creator_badge = u.badge || '';
      }
    }
    tx.update(nextEntry.ref, { used: true });
    const newStoryId = _serverCreateSeedStory(db, tx, entryData.text, extraFields);
    newlyCreatedStoryId = newStoryId;
    if (slotKey === 'sentence') {
      tx.update(ptrRef, { 'sentence.story_id': newStoryId, 'sentence.state': 'story', 'sentence.round_id': null });
    } else {
      tx.update(ptrRef, { [`${slotKey}.story_id`]: newStoryId }); // word 또는 fairytale
    }
  });

  // _serverRefillSpotlightSlot과 동일 이유(씨앗만으로도 1차 분류 가능) + 동일
  // 원칙(트랜잭션 밖에서 await, fire-and-forget 금지).
  if (newlyCreatedStoryId) {
    await _classifyStoryGenre(db, newlyCreatedStoryId, 0).catch(e => console.error('genre classify(seed) error:', e.message));
  }
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

        for (let i = 0; i < top.length; i++) {
          const w = top[i];
          await db.collection('spotlight_sentence_pool').doc().set({
            text: w.text, proposer_id: w.user_id, round_id: doc.id, used: false,
            created_at: new Date().toISOString(),
          });
          // 채택 포인트는 실제로 문장이 풀에서 소진돼 쓰일 때가 아니라 라운드
          // 마감 시 즉시 지급(유저 확정, 2026-07-12) — word_challenge 마감과
          // 같은 코드 경로에 붙어 있어 일관되고, 선정됐는데 나중에 안 쓰인다고
          // 보상을 못 받는 경우가 없음.
          await _serverAddPoints(db, w.user_id, 50, 'spotlight_sentence_pick', w.submission_id);
          try { await _serverBumpAchievementCounter(db, w.user_id, 'spotlight_sentence_picks'); } catch (e) {}
          // 채택 자체를 알려줄 방법이 없었음(제보로 발견) — 실제로 풀에서 소진돼
          // 화면에 뜨는 건 순서가 밀리면 한참 뒤일 수 있어서, 그 시점이 아니라
          // 채택이 확정되는 지금 바로 알려줌
          try {
            await db.collection('notifications').doc().set({
              user_id: w.user_id, type: 'spotlight_sentence_pick', story_id: '',
              message: `✍️ 오늘의 이야기 시작 문장 ${i + 1}등으로 채택됐어요! +50p (순서대로 다음 슬롯에 사용돼요)`,
              is_read: false, created_at: new Date().toISOString(), push_sent: false,
            });
          } catch (e) {}
        }
      }

      try { await _serverRefillSlotFromPoolIfEmpty(db, 'sentence'); } catch (e) {}
    }
    return null;
  });

// 방치된 AI 씨앗 이야기 자동 정리 — 원래 클라이언트(자유 이야기 탭 로딩 시점)에서
// 실행했는데, 캐시된 구버전 클라이언트 JS가 계속 떠돌면서 그 로직이 스포트라이트
// 슬롯 이야기까지 잘못 청소해버리는 사고가 반복됨(2026-07-12, 07-13 두 번 — 서버
// 코드는 vote_threshold 있는 이야기를 제외하도록 이미 고쳐뒀는데도, 그 수정이
// 반영 안 된 오래된 클라이언트가 실행하면 재발함). 클라이언트 JS 버전과 무관하게
// 항상 최신 로직으로만 동작하도록 서버 스케줄러로 이관.
exports.cleanupAbandonedSeeds = functions
  .region('asia-northeast3')
  .pubsub.schedule('every 30 minutes')
  .onRun(async () => {
    const db = admin.firestore();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // vote_threshold 유무로 "스포트라이트 슬롯 이야기라 건드리면 안 됨"을 가려내던
    // 기존 방식은 새 콘텐츠 모드가 추가될 때마다 재발하는 구조적 결함이었음 —
    // 초스피드(_serverCreateSpeedrunSeedStory)는 투표가 없어 vote_threshold를 아예
    // 안 만들고, speedrunSubmit도 participant_count를 안 올려서 "1시간 넘은 AI
    // 씨앗+참여자 0명" 조건을 계속 만족해버림. 실제로 17단계나 진행된 초스피드
    // 스포트라이트 이야기가 이 로직에 의해 status:inactive로 잘못 마킹된 걸
    // 라이브 데이터에서 확인함(디버그방, 2026-07-29). vote_threshold 유무를 보는
    // 대신 스포트라이트 슬롯 포인터를 직접 조회해서 예외 없이 제외 — 앞으로
    // vote_threshold 없는 모드가 또 추가돼도 이 버그가 재발하지 않음.
    const ptrSnap = await db.collection('config').doc('spotlight_slots').get();
    const slotStoryIds = new Set(
      ptrSnap.exists ? Object.values(ptrSnap.data()).map(v => v && v.story_id).filter(Boolean) : []
    );
    const storiesSnap = await db.collection('stories').where('status', '==', 'active').get();
    const abandoned = storiesSnap.docs.filter(d => {
      const s = d.data();
      return s.is_ai_seed === true && !s.vote_threshold && (s.participant_count || 0) === 0
        && (s.created_at || '') < oneHourAgo && !slotStoryIds.has(d.id);
    });
    if (!abandoned.length) return null;

    // 문서별 트랜잭션으로 선점(이 함수 자체는 30분 주기 단일 실행이라 겹칠 일은
    // 없지만, 기존 클라이언트 구현의 안전장치를 그대로 유지)
    const claimed = [];
    for (const doc of abandoned) {
      const won = await db.runTransaction(async tx => {
        const snap = await tx.get(doc.ref);
        if (!snap.exists || snap.data().status !== 'active') return false;
        tx.update(doc.ref, { status: 'inactive' });
        return true;
      });
      if (won) claimed.push(doc);
    }
    if (!claimed.length) return null;

    // 폐기된 씨앗 오프닝을 used_openings에서 제거(다시 씨앗 풀로 복귀)
    const toRestore = claimed.map(doc => doc.data().opening).filter(Boolean);
    if (toRestore.length) {
      const deleteFields = {};
      toRestore.forEach(o => { deleteFields[o] = admin.firestore.FieldValue.delete(); });
      await db.collection('config').doc('used_openings').update(deleteFields).catch(() => {});
    }

    const batch = db.batch();
    let hasNotif = false;
    claimed.forEach(doc => {
      const s = doc.data();
      if (!s.creator_id) return;
      const snippet = (s.opening || '').length > 30 ? s.opening.substring(0, 30) + '…' : (s.opening || '');
      batch.set(db.collection('notifications').doc(), {
        user_id: s.creator_id, type: 'seed_recycled', story_id: '',
        message: `시간이 경과하여 선택하신 이야기가 다시 되돌아갔습니다.\n"${snippet}"`,
        is_read: false, created_at: new Date().toISOString(), push_sent: false,
      });
      hasNotif = true;
    });
    if (hasNotif) await batch.commit();
    return null;
  });

// 스포트라이트 최초 도입 시 1회 실행 — 포인터 doc이 없으면 3슬롯이 전부 비어
// 보이므로, 관리자가 배포 후 한 번 호출해 3슬롯을 AI 씨앗으로 부트스트랩함.
// 이후로는 각 슬롯의 지정된 소스(단어챌린지 풀/제안투표 풀/AI 랜덤픽)가 이어받음.
exports.adminInitSpotlight = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
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

// 스포트라이트 도입 시점(adminInitSpotlight)에 슬롯1·2가 실제 단어챌린지 우승작/
// 제안투표 채택작이 아니라 그냥 랜덤 AI 문장으로 부트스트랩됐던 문제를 바로잡는
// 1회성 관리자 콜러블. 슬롯1은 스포트라이트 도입 전부터 이미 쌓여있던 단어챌린지
// 과거 우승 기록을 소급해서 풀에 채워넣고(라운드당 대표 1개, _serverCloseWordChallenge와
// 동일한 규칙 — winners[0]이 이미 created_at 오름차순으로 정렬돼 저장돼 있어서 그대로
// 씀), 슬롯2는 아직 제안투표 라운드가 한 번도 없었으니 풀을 채울 과거 데이터가 없어서
// 그냥 지금 바로 첫 24시간 라운드를 열도록 함. 이후엔 두 슬롯 다 정상 소스로 계속 이어짐.
exports.adminFixSpotlightBootstrap = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const ptrRef0 = db.collection('config').doc('spotlight_slots');
    const ptrSnap0 = await ptrRef0.get();
    // 재실행 방지 — 슬롯이 이미 정상 소스로 채워진 뒤에 실수로 다시 부르면
    // story_id를 null로 되돌려서 진행 중인 이야기를 끊어버리게 되므로 가드 필요
    if (ptrSnap0.exists && ptrSnap0.data().bootstrap_fixed) return { ok: true, already: true };

    const existingPoolSnap = await db.collection('spotlight_word_pool').get();
    const alreadyBackfilled = new Set(existingPoolSnap.docs.map(d => d.data().source_challenge_id).filter(Boolean));

    const closedSnap = await db.collection('word_challenges').where('status', '==', 'closed').get();
    const rounds = closedSnap.docs
      .map(d => ({ challenge_id: d.id, ...d.data() }))
      .filter(r => !alreadyBackfilled.has(r.challenge_id))
      .map(r => {
        const text = (r.winners && r.winners.length) ? r.winners[0].text : r.winner_text;
        return text ? { challenge_id: r.challenge_id, text, closed_at: r.closed_at } : null;
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at));

    const batch = db.batch();
    for (const r of rounds) {
      batch.set(db.collection('spotlight_word_pool').doc(), {
        text: r.text, source_challenge_id: r.challenge_id, used: false, created_at: r.closed_at,
      });
    }
    if (rounds.length) await batch.commit();

    await ptrRef0.update({ 'word.story_id': null, 'sentence.story_id': null, bootstrap_fixed: true });

    await _serverRefillSlotFromPoolIfEmpty(db, 'word');
    await _serverRefillSlotFromPoolIfEmpty(db, 'sentence');

    return { ok: true, backfilled_rounds: rounds.length };
  });

// 지금 이미 스포트라이트 슬롯1(🎲)을 차지하고 있는 스토리는 challenge_words 저장
// 로직이 생기기 전에 만들어져서 이 필드가 없음 — 1회성으로 채워넣음. spotlight_word_pool
// 에서 이미 used:true이고 text가 현재 스토리의 opening과 같은 항목을 찾아
// source_challenge_id → word_challenges.words를 그대로 복사.
exports.adminBackfillWordSlotChallengeWords = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const ptrSnap = await db.collection('config').doc('spotlight_slots').get();
    const wordStoryId = ptrSnap.exists ? ptrSnap.data().word?.story_id : null;
    if (!wordStoryId) return { ok: false, error: '슬롯1에 진행 중인 스토리가 없습니다.' };

    const storySnap = await db.collection('stories').doc(wordStoryId).get();
    if (!storySnap.exists) return { ok: false, error: '스토리를 찾을 수 없습니다.' };
    if (storySnap.data().challenge_words) return { ok: true, already: true };

    const opening = storySnap.data().opening;
    const poolSnap = await db.collection('spotlight_word_pool').where('text', '==', opening).limit(1).get();
    if (poolSnap.empty) return { ok: false, error: '일치하는 단어챌린지 풀 항목을 못 찾았습니다(수동 생성된 씨앗일 수 있음).' };

    const challengeId = poolSnap.docs[0].data().source_challenge_id;
    if (!challengeId) return { ok: false, error: '풀 항목에 source_challenge_id가 없습니다.' };

    const challengeSnap = await db.collection('word_challenges').doc(challengeId).get();
    const words = challengeSnap.exists ? challengeSnap.data().words : null;
    if (!Array.isArray(words)) return { ok: false, error: '챌린지 단어 목록을 찾을 수 없습니다.' };

    await db.collection('stories').doc(wordStoryId).update({ challenge_words: words });
    return { ok: true, story_id: wordStoryId, challenge_words: words };
  });

// ── 동화 각색 슬롯(fairytale) 씨앗 풀 관리 ──────────────────
// spotlight_fairytale_pool은 firestore.rules에서 클라이언트 접근이 완전히
// 막혀있음(저작권 큐레이션 목적 — word_challenge_sets처럼 열어두면 아무나
// 임의 텍스트를 씨앗으로 주입할 수 있게 됨) — 그래서 word_challenge_sets와
// 달리 추가/조회/삭제 전부 Admin SDK 콜러블로만 노출함.
exports.adminAddFairytalePoolEntries = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const lines = (data.raw_text || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { ok: false, error: '등록할 문장이 없어요.' };
    const batch = db.batch();
    lines.forEach(line => {
      batch.set(db.collection('spotlight_fairytale_pool').doc(), { text: line, used: false, created_at: new Date().toISOString() });
    });
    await batch.commit();
    // 최초 1회 호출 시 self-bootstrap — 슬롯 포인터 키가 없으면 생성(merge라
    // 이미 있는 story_id는 안 건드림)
    const ptrRef = db.collection('config').doc('spotlight_slots');
    const ptrSnap = await ptrRef.get();
    if (!ptrSnap.exists || !ptrSnap.data().fairytale) {
      await ptrRef.set({ fairytale: { story_id: null } }, { merge: true });
    }
    await _serverRefillSlotFromPoolIfEmpty(db, 'fairytale').catch(e => console.error('fairytale slot refill error:', e.message));
    return { ok: true, added: lines.length };
  });

exports.adminGetFairytalePoolQueue = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const snap = await admin.firestore().collection('spotlight_fairytale_pool').orderBy('created_at', 'asc').limit(500).get();
    const all = snap.docs.map(d => ({ entry_id: d.id, ...d.data() }));
    return { ok: true, unused: all.filter(s => !s.used), used_count: all.filter(s => s.used).length };
  });

exports.adminDeleteFairytalePoolEntry = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    await admin.firestore().collection('spotlight_fairytale_pool').doc(data.entry_id).delete();
    return { ok: true };
  });

// ── 초성 힌트: 정시(하루 6회) 문장 맞히기 이벤트 — 스토리가 아닌 완전히
//    독립된 스케줄 이벤트. hint_pool(관리자 큐레이션 씨앗 풀, fairytale
//    풀과 동일 패턴) → hint_rounds(진행 중 라운드, 반드시 서버 전용) →
//    hint_guesses(실시간 시도 피드, 정답 없어서 읽기는 열어둠) ──────────

const CHOSEONG = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
// 완성형 한글 유니코드 분해: code=charCode-0xAC00, 초성=CHOSEONG[Math.floor(code/588)]
// (588 = 21(중성)*28(종성)). 완성형 범위 밖(공백/문장부호 등)은 그대로 통과.
function _serverToChoseong(text) {
  return [...text].map(ch => {
    const code = ch.charCodeAt(0) - 0xAC00;
    if (code < 0 || code > 11171) return ch;
    return CHOSEONG[Math.floor(code / 588)];
  }).join('');
}

const HINT_GUESS_POINTS = 30; // 50P였다가 30P로 하향(2026-07-28, 유저 판단 — 반응 과열)

async function _serverStartHintRound(db) {
  const now = new Date();
  await db.runTransaction(async tx => {
    const activeSnap = await tx.get(db.collection('hint_rounds').where('status', '==', 'active').limit(1));
    activeSnap.docs.forEach(d => tx.update(d.ref, { status: 'closed', closed_at: now.toISOString() }));

    const poolSnap = await tx.get(db.collection('hint_pool').orderBy('created_at', 'asc').limit(50));
    const nextEntry = poolSnap.docs.find(d => !d.data().used);
    if (!nextEntry) return; // 풀 소진 — 관리자가 채울 때까지 그냥 공백으로 둠(word/fairytale 슬롯과 동일 원칙)

    tx.update(nextEntry.ref, { used: true });
    const roundRef = db.collection('hint_rounds').doc();
    const text = nextEntry.data().text;
    tx.set(roundRef, {
      round_id: roundRef.id, text, hint: _serverToChoseong(text),
      status: 'active', start_at: now.toISOString(), end_at: '',
      winner_user_id: null, winner_nickname: null, winner_submission_id: null, winner_text: null,
      points: HINT_GUESS_POINTS, closed_at: null, participant_count: 0,
    });
  });
}

// 하루 6회 정시(08/10/12/14/16/18시 KST) — 이 코드베이스의 기존 관례(단일시각
// 스케줄 문자열, 콤마/유닉스크론 전례 없음)를 그대로 따름. 전부 공용 헬퍼 호출.
exports.startHintRound08 = functions.region('asia-northeast3').pubsub.schedule('every day 08:00').timeZone('Asia/Seoul').onRun(async () => { await _serverStartHintRound(admin.firestore()); return null; });
exports.startHintRound10 = functions.region('asia-northeast3').pubsub.schedule('every day 10:00').timeZone('Asia/Seoul').onRun(async () => { await _serverStartHintRound(admin.firestore()); return null; });
exports.startHintRound12 = functions.region('asia-northeast3').pubsub.schedule('every day 12:00').timeZone('Asia/Seoul').onRun(async () => { await _serverStartHintRound(admin.firestore()); return null; });
exports.startHintRound14 = functions.region('asia-northeast3').pubsub.schedule('every day 14:00').timeZone('Asia/Seoul').onRun(async () => { await _serverStartHintRound(admin.firestore()); return null; });
exports.startHintRound16 = functions.region('asia-northeast3').pubsub.schedule('every day 16:00').timeZone('Asia/Seoul').onRun(async () => { await _serverStartHintRound(admin.firestore()); return null; });
exports.startHintRound18 = functions.region('asia-northeast3').pubsub.schedule('every day 18:00').timeZone('Asia/Seoul').onRun(async () => { await _serverStartHintRound(admin.firestore()); return null; });

// 테스트/부트스트랩용 — 콘솔에서 수동 트리거
exports.adminForceStartHintRound = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    await _serverStartHintRound(admin.firestore());
    return { ok: true };
  });

// 진행 중(active) 라운드면 text를 절대 응답에 안 넣음(힌트만) — 정답 유출은
// 이 함수가 유일한 클라이언트 접점이라 여기서만 막으면 됨(hint_rounds 자체는
// firestore.rules에서 완전히 잠겨있어 직접 읽기는 원천 차단).
exports.getHintRound = functions
  .region('asia-northeast3')
  .https.onCall(async () => {
    const db = admin.firestore();
    const activeSnap = await db.collection('hint_rounds').where('status', '==', 'active').limit(1).get();
    let doc = !activeSnap.empty ? activeSnap.docs[0] : null;
    if (!doc) {
      const lastSnap = await db.collection('hint_rounds').orderBy('start_at', 'desc').limit(1).get();
      doc = !lastSnap.empty ? lastSnap.docs[0] : null;
    }
    if (!doc) return { ok: true, round: null };
    const r = doc.data();
    // 예전엔 매 호출마다 hint_guesses를 round_id로 전체 스캔해서 유니크 참여자
    // 수를 셌는데, 시도가 쌓일수록(이 함수는 홈 탭 방문/재렌더마다 호출됨) 매번
    // 무거워지는 구조였음 — hintGuess 트랜잭션에서 이미 비정규화해서 저장하는
    // participant_count 필드를 그대로 읽음(2026-07-29, open_steps와 동일 패턴)
    const participant_count = r.participant_count || 0;
    const base = { round_id: doc.id, hint: r.hint, status: r.status, start_at: r.start_at, points: r.points, participant_count };
    if (r.status === 'closed') {
      return { ok: true, round: { ...base, text: r.text, winner_user_id: r.winner_user_id, winner_nickname: r.winner_nickname, winner_text: r.winner_text } };
    }
    return { ok: true, round: base }; // text는 절대 안 내려줌
  });

exports.hintGuess = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const round_id = data.round_id;
    const author_id = data.user_id;
    const text = (data.guess || '').trim();
    if (!round_id || !author_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(author_id, data.token);
    if (!text) return { ok: false, error: '답을 입력해주세요.' };

    const db = admin.firestore();
    const uSnap = await db.collection('users').doc(author_id).get();
    const uData = uSnap.exists ? uSnap.data() : {};
    const nickname = uData.display_name || uData.nickname || '익명';
    const roundRef = db.collection('hint_rounds').doc(round_id);

    const result = await db.runTransaction(async tx => {
      const roundSnap = await tx.get(roundRef);
      if (!roundSnap.exists) return { ok: false, error: '라운드를 찾을 수 없습니다.' };
      const round = roundSnap.data();
      if (round.status !== 'active') return { ok: false, error: '이미 마감된 라운드예요.' };

      // 시도 간 쿨다운 10초 — 원래 설계엔 없었는데(무제한 시도), 실사용에서
      // 한 사람이 연속으로 여러 번 찍어서 맞히는 사례가 나와 추가(2026-07-28,
      // 유저 판단). round_id+user_id 둘 다 등호 조건이라 복합 인덱스 불필요.
      const myGuessesSnap = await tx.get(
        db.collection('hint_guesses').where('round_id', '==', round_id).where('user_id', '==', author_id));
      const lastGuess = myGuessesSnap.docs.map(d => d.data())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (lastGuess) {
        const elapsedMs = Date.now() - new Date(lastGuess.created_at).getTime();
        if (elapsedMs < 10000) {
          return { ok: false, error: `${Math.ceil((10000 - elapsedMs) / 1000)}초 후 다시 시도해주세요.` };
        }
      }

      // 정규화: 공백 전부 제거 + 끝의 마침표 제거(씨앗 문장이 전부 "다."로 끝남) —
      // 정답 판정과 글자별 매치 카운트 둘 다 이 정규화된 문자열 기준으로 통일
      const norm = s => (s || '').replace(/\s+/g, '').replace(/\.+$/, '');
      const gN = norm(text), aN = norm(round.text);
      const isCorrect = gN.length > 0 && gN === aN;
      let matchCount = 0;
      for (let i = 0; i < Math.min(gN.length, aN.length); i++) if (gN[i] === aN[i]) matchCount++;

      const guessRef = db.collection('hint_guesses').doc();
      tx.set(guessRef, {
        guess_id: guessRef.id, round_id, user_id: author_id, nickname,
        text, match_count: matchCount, total_length: aN.length,
        is_correct: isCorrect, created_at: new Date().toISOString(),
      });

      // participant_count 비정규화(open_steps와 동일 패턴, 2026-07-29) — 예전엔
      // getHintRound가 매번 hint_guesses를 round_id로 통째로 스캔해서 유니크
      // user_id 수를 세었는데, 라운드가 진행될수록(시도 쌓일수록) 매 호출마다
      // 점점 무거워지는 구조였음. 여기서 이미 쿨다운 체크용으로 "이 유저의
      // 기존 시도"를 읽고 있으므로(myGuessesSnap), 그게 비어있으면(=이 라운드
      // 첫 시도) 신규 참여자란 뜻 — 추가 읽기 없이 그대로 판단 가능.
      const roundUpdate = {};
      if (myGuessesSnap.empty) roundUpdate.participant_count = admin.firestore.FieldValue.increment(1);
      if (isCorrect) {
        Object.assign(roundUpdate, {
          status: 'closed', closed_at: new Date().toISOString(),
          winner_user_id: author_id, winner_nickname: nickname,
          winner_submission_id: guessRef.id, winner_text: text,
        });
      }
      if (Object.keys(roundUpdate).length) tx.update(roundRef, roundUpdate);
      // 지급액은 상수가 아니라 라운드 생성 시점에 저장된 round.points를 씀 —
      // 안 그러면 포인트 값이 바뀐 시점에 이미 열려있던(옛 값으로 만들어진)
      // 라운드가 화면엔 옛 값으로 표시되는데 실제 지급은 새 상수로 되는 불일치 발생
      return { ok: true, guess_id: guessRef.id, match_count: matchCount, total_length: aN.length, correct: isCorrect, points: round.points };
    });

    if (result.ok && result.correct) {
      try { await _serverAddPoints(db, author_id, result.points, 'hint_guess_win', result.guess_id); } catch (e) { console.error('hint point award error:', e.message); }
      try { await _serverBumpAchievementCounter(db, author_id, 'hint_win_count'); } catch (e) { console.error('hint achievement error:', e.message); }
    }
    return result;
  });

// 초성힌트 씨앗 풀 관리 — spotlight_fairytale_pool과 동일 이유로 서버 전용
// Cloud Function 트리오(hint_rounds가 정답을 참조하는 원천이라 마찬가지로
// 아무 텍스트나 주입되면 안 됨).
exports.adminAddHintPoolEntries = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const lines = (data.raw_text || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { ok: false, error: '등록할 문장이 없어요.' };
    const batch = db.batch();
    lines.forEach(line => {
      batch.set(db.collection('hint_pool').doc(), { text: line, used: false, created_at: new Date().toISOString() });
    });
    await batch.commit();
    return { ok: true, added: lines.length };
  });

exports.adminGetHintPoolQueue = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const snap = await admin.firestore().collection('hint_pool').orderBy('created_at', 'asc').limit(500).get();
    const all = snap.docs.map(d => ({ entry_id: d.id, ...d.data() }));
    return { ok: true, unused: all.filter(s => !s.used), used_count: all.filter(s => s.used).length };
  });

exports.adminDeleteHintPoolEntry = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    await admin.firestore().collection('hint_pool').doc(data.entry_id).delete();
    return { ok: true };
  });

// 초스피드 슬롯 최초 부트스트랩(1회성 관리자 콜러블) — adminInitSpotlight은 이미
// initialized:true라 재실행 안 됨(동화각색 때와 동일 상황). 배포 후 한 번만 호출.
exports.adminInitSpeedrunSlot = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const ptrRef = db.collection('config').doc('spotlight_slots');
    const ptrSnap = await ptrRef.get();
    if (ptrSnap.exists && ptrSnap.data().speedrun) return { ok: true, already: true };

    const usedSnap = await db.collection('config').doc('used_openings').get();
    const used = usedSnap.exists ? usedSnap.data() : {};
    const available = SPEEDRUN_OPENINGS.filter(o => !used[o]);
    const src = available.length ? available : SPEEDRUN_OPENINGS;
    const opening = src[Math.floor(Math.random() * src.length)];

    const batch = db.batch();
    const newStoryId = _serverCreateSpeedrunSeedStory(db, batch, opening);
    batch.set(db.collection('config').doc('used_openings'), { [opening]: true }, { merge: true });
    batch.set(ptrRef, { speedrun: { story_id: newStoryId } }, { merge: true });
    await batch.commit();
    return { ok: true, story_id: newStoryId };
  });

exports.adminInitFixedEndingSlot = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const ptrRef = db.collection('config').doc('spotlight_slots');
    const ptrSnap = await ptrRef.get();
    if (ptrSnap.exists && ptrSnap.data().fixed_ending) return { ok: true, already: true };

    const usedSnap = await db.collection('config').doc('used_openings').get();
    const used = usedSnap.exists ? usedSnap.data() : {};
    const available = SPOTLIGHT_AI_OPENINGS.filter(o => !used[o]);
    const src = available.length ? available : SPOTLIGHT_AI_OPENINGS;
    const opening = src[Math.floor(Math.random() * src.length)];

    const batch = db.batch();
    const newStoryId = _serverCreateSeedStory(db, batch, opening, {
      mode: 'fixed_ending', fixed_ending: _serverRandomFixedEnding(),
    });
    batch.set(db.collection('config').doc('used_openings'), { [opening]: true }, { merge: true });
    batch.set(ptrRef, { fixed_ending: { story_id: newStoryId } }, { merge: true });
    await batch.commit();
    // _serverRefillSpotlightSlot 경로(다른 슬롯들의 정상 리필)는 매번 이걸 호출하는데,
    // 이 1회성 부트스트랩만 빠져있어서 갓 만들어진 스토리에 장르 확률 차트가
    // 안 뜨는 버그가 있었음(유저 제보, 2026-07-28) — 추가.
    await _classifyStoryGenre(db, newStoryId, 0).catch(e => console.error('genre classify(bootstrap) error:', e.message));
    return { ok: true, story_id: newStoryId };
  });

exports.adminInitGenreSwitchSlot = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const ptrRef = db.collection('config').doc('spotlight_slots');
    const ptrSnap = await ptrRef.get();
    if (ptrSnap.exists && ptrSnap.data().genre_switch) return { ok: true, already: true };

    const usedSnap = await db.collection('config').doc('used_openings').get();
    const used = usedSnap.exists ? usedSnap.data() : {};
    const available = SPOTLIGHT_AI_OPENINGS.filter(o => !used[o]);
    const src = available.length ? available : SPOTLIGHT_AI_OPENINGS;
    const opening = src[Math.floor(Math.random() * src.length)];

    const batch = db.batch();
    const newStoryId = _serverCreateSeedStory(db, batch, opening, {
      mode: 'genre_switch', genre_sequence: _serverRandomGenreSequence(10),
    });
    batch.set(db.collection('config').doc('used_openings'), { [opening]: true }, { merge: true });
    batch.set(ptrRef, { genre_switch: { story_id: newStoryId } }, { merge: true });
    await batch.commit();
    return { ok: true, story_id: newStoryId };
  });

// sentence/ai 슬롯 폐지 실행 (1회성 관리자 콜러블) — 원래 계획대로 초스피드+
// 동화각색이 완성된 시점에 한꺼번에 교체(콘텐츠 다양화 기획 메모 참고).
// 진행 중이던 두 스토리는 삭제하지 않고 24시간 주목(무료, 포인트 차감 없음)만
// 부여해서 자유 이야기 탭에서 계속 눈에 띄게 하고, featured 포인터는 비움
// (프론트가 이미 sentence/ai를 조회 목록에서 뺐으므로 실질적으로는 방어용).
exports.adminExitSentenceAiSlots = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const ptrRef = db.collection('config').doc('spotlight_slots');
    const ptrSnap = await ptrRef.get();
    if (!ptrSnap.exists) return { ok: false, error: '스포트라이트가 아직 초기화되지 않았습니다.' };
    const slots = ptrSnap.data();

    const boosted = [];
    const batch = db.batch();
    for (const key of ['sentence', 'ai']) {
      const storyId = slots[key] && slots[key].story_id;
      if (storyId) {
        batch.set(db.collection('boosts').doc(), {
          story_id: storyId, user_id: FB_ADMIN_ID, created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });
        boosted.push(storyId);
      }
      batch.update(ptrRef, { [`${key}.story_id`]: null });
    }
    await batch.commit();
    return { ok: true, boosted_story_ids: boosted };
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
    await _requireAdmin(data.user_id, data.token);
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
    await _requireAdmin(data.user_id, data.token);
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
    await _requireAdmin(data.user_id, data.token);
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

