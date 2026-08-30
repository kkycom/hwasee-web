const functions   = require('firebase-functions');
const admin       = require('firebase-admin');
const crypto      = require('crypto');
// @google-analytics/data, nodemailer는 여기서 top-level require 안 함 — 이 파일의
// 모든 Cloud Functions가 하나의 모듈을 공유해서 top-level require는 어떤 함수가
// 호출되든 매 콜드스타트마다 실행됨. 어쩌다 한 번 쓰는 함수(관리자 전용 GA4,
// 이메일 발송) 때문에 로그인 등 나머지 함수 전체의 콜드스타트가 느려지면 안
// 되므로, 실제로 쓰는 함수 안에서만 지연 require.
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

    // 초스피드는 투표 없이 제출 하나마다 에피소드가 닫히는 구조라(최대 100단계),
    // 이 트리거를 그대로 두면 매 제출마다 스토리 전체 참여자/북마커를 다시
    // 조회해서 "N단계로 이어졌어요" 알림을 쏘는 낭비성 팬아웃이 됨 — AI참여
    // 스케줄러가 이미 "초스피드는 투표 자체가 없어 개입할 이유 없음"으로 완전히
    // 스킵하는 것과 같은 이유로 여기도 빠져있었음(전수감사로 발견, 2026-08-19).
    const storySnapEarly = await db.collection('stories').doc(story_id).get();
    if (storySnapEarly.exists && storySnapEarly.data().mode === 'speedrun') return null;

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

    // 채택 글 결정 (_serverCloseEpisode와 동일 로직이어야 함 — 사람 제출 우선,
    // 없으면 AI 포함. 예전엔 이 우선순위가 없어서 사람/AI 동률일 때 이 트리거가
    // 계산한 승자 집합이 실제 채택 결과와 어긋날 수 있었음, 2026-08-10 디버그방 발견)
    const maxVotes = Math.max(...allSubs.map(s => Number(s.vote_count) || 0));
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

    // storySnapEarly는 위에서 speedrun 여부 확인용으로 이미 조회해둔 것 — 여기서
    // 또 조회하지 않고 그대로 재사용.
    if (!storySnapEarly.exists) return null;
    const st = storySnapEarly.data();
    // 이 트리거와 _serverCloseEpisode의 story.current_step 갱신 사이에 순서
    // 보장이 없어서, st.current_step을 직접 읽으면 레이스에 따라 +2가 될 수
    // 있음(그 +2 표시 버그가 실제로 있었음) — 방금 닫힌 이 에피소드 자체의
    // step은 불변이고 정의상 항상 이 값과 같으므로, 그걸 우선 사용해 레이스를 제거
    const nextStep  = Number(after.step) || ((Number(st.current_step) || 0) + 1);
    // 결말 고정 이야기는 is_closing이 실제 완결 신호가 아님(_serverCloseEpisode의
    // 동일 무력화 참고) — 여기서도 무력화 안 하면, 그 우회 편법이 실제 완결 여부와
    // 무관하게 "이야기가 완결됐어요!" 오알림을 전체 참여자에게 보냄.
    const anyClose  = st.mode === 'fixed_ending' ? false : winners.some(w => w.is_closing === true);
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
  .runWith({ timeoutSeconds: 300 })
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

// 완결 시 짧은 책 제목을 붙여줌("책의 언어" 책장 디자인, 2026-08-26) —
// _classifyStoryGenre와 같은 실패 처리(키/본문 없거나 호출·파싱 실패 시
// 조용히 return, throw 안 함 — 완결 흐름 자체를 막으면 안 됨). title/
// ai_title 둘 다 같은 값으로 채움 — title은 유저가 이후 수정 가능한
// "현재 표시용", ai_title은 신고 시 되돌아갈 원본(editStoryTitle은
// ai_title을 안 건드림).
async function _generateStoryTitle(db, story_id) {
  const storyRef = db.collection('stories').doc(story_id);
  const storySnap = await storyRef.get();
  if (!storySnap.exists) return;
  const story = storySnap.data();
  if (story.title) return; // 이미 제목 있으면(재시도 등) 덮어쓰지 않음

  const secretsSnap = await db.collection('config').doc('secrets').get();
  const claudeKey = secretsSnap.exists ? secretsSnap.data().claude_key : null;
  if (!claudeKey) return;

  const text = await _buildStoryContext(db, story_id, story);
  if (!text.trim()) return;

  const prompt = `다음은 여러 사람이 한 문장씩 이어 써서 완성한 릴레이 소설입니다. 이 이야기에 어울리는 짧은 제목을 지어주세요.

이야기 내용:
"""
${text}
"""

조건: 한국어 명사구 하나, 2~10자 내외. 따옴표나 설명 없이 제목 텍스트만 출력하세요.`;

  let raw;
  try { raw = await _callClaude(claudeKey, prompt, 40); } catch (e) { console.error('title generate call error:', e.message); return; }
  if (!raw) return;

  // 모델이 그래도 따옴표/줄바꿈을 붙여 보내는 경우가 있어 방어적으로 정리
  const title = raw.replace(/^["'“”\s]+|["'“”\s.]+$/g, '').split('\n')[0].slice(0, 20).trim();
  if (!title) return;

  await storyRef.update({ title, ai_title: title });
}

const STORY_TITLE_MAX_CHARS = 20;

// 책 제목 수정 — editYourStory와 달리 story_id를 클라이언트가 지정함(협업
// 창작물이라 "본인 글" 개념이 없어 소유자 검증이 불가 — your_story처럼
// 결정론적 id로 막을 수 없음). 대신 완결된 스토리에만, 짧은 길이 제한
// 안에서만 허용하고, 남용은 아래 reportStoryTitle로 사후 대응(유저 확정
// 방향 — "일단 그냥 제목 바꿀수있게 해주고 신고 기능만"). ai_title은
// 절대 안 건드림 — 신고 시 되돌아갈 원본이라 유지.
exports.editStoryTitle = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    const story_id = data.story_id;
    const title = (data.title || '').trim();
    if (!user_id || !story_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);
    if (!title) return { ok: false, error: '제목을 입력해주세요.' };
    if (title.length > STORY_TITLE_MAX_CHARS) return { ok: false, error: `${STORY_TITLE_MAX_CHARS}자 이내로 작성해주세요.` };

    const db = admin.firestore();
    const storyRef = db.collection('stories').doc(story_id);
    const storySnap = await storyRef.get();
    if (!storySnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
    const story = storySnap.data();
    if (story.status !== 'completed' && story.status !== 'inactive') return { ok: false, error: '완결된 이야기만 제목을 수정할 수 있어요.' };

    await storyRef.update({ title });
    return { ok: true, title };
  });

// 제목 신고 — 신고 1건이면 승인·투표 없이 즉시 AI 원제목으로 복귀(유저 확정
// 방향, your_story_reports의 임계값 3 패턴과 의도적으로 다름 — 여기는
// "삭제"가 아니라 "원상복구"라 리스크가 훨씬 낮아서 즉시 처리해도 안전).
// 중복 신고 방지는 동일하게 결정론적 id(story_id_user_id) 존재 여부로.
exports.reportStoryTitle = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    const story_id = data.story_id;
    if (!user_id || !story_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);

    const db = admin.firestore();
    const storyRef = db.collection('stories').doc(story_id);
    const reportRef = db.collection('story_title_reports').doc(`${story_id}_${user_id}`);

    return db.runTransaction(async tx => {
      const [storySnap, reportSnap] = await Promise.all([tx.get(storyRef), tx.get(reportRef)]);
      if (!storySnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
      if (reportSnap.exists) return { ok: false, error: '이미 신고했어요.' };
      const story = storySnap.data();
      if (!story.ai_title) return { ok: false, error: '신고가 불가한 제목이에요.' };
      if (story.title === story.ai_title) return { ok: false, error: '신고가 불가한 제목이에요.' };

      tx.set(reportRef, { story_id, user_id, created_at: new Date().toISOString() });
      tx.update(storyRef, { title: story.ai_title });
      return { ok: true, title: story.ai_title };
    });
  });

// 이번 기능 배포 전에 이미 완결된 이야기들엔 title이 없음 — 관리자가 수동으로
// 한 번 트리거하는 백필. dryRun:true면 대상 건수만 세고 실제 호출은 안 함
// (Claude 호출 비용을 미리 가늠할 수 있게, 유저 요청). cron 아니고 콜러블
// (관리자 계정으로 직접 호출) — 자동 스케줄 아님.
exports.backfillStoryTitles = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 540 })
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    if (!user_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);
    if (user_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');

    const db = admin.firestore();
    const snap = await db.collection('stories').where('status', '==', 'completed').get();
    const targets = snap.docs.filter(d => !d.data().title);
    if (data.dryRun) return { ok: true, dryRun: true, target_count: targets.length, total_completed: snap.size };

    let done = 0, failed = 0;
    for (const doc of targets) {
      try { await _generateStoryTitle(db, doc.id); done++; }
      catch (e) { failed++; console.error('backfill title error:', doc.id, e.message); }
    }
    return { ok: true, target_count: targets.length, done, failed };
  });

// 책장 표지색용 — _classifyStoryGenre는 원래 "오늘의 이야기" 스포트라이트
// 슬롯 출신에만 호출돼서(vote_threshold 게이트), 일반 자유 이야기 완결작
// 대부분엔 story_genre_probs가 없어 표지가 회색으로만 보임(2026-08-26,
// "책의 언어" 책장 기능에서 발견). 유저가 전체 확장을 확정해서, 완결작
// 전체 대상으로 이 함수도 같은 백필 방식으로 추가. genre_switch 모드는
// 이미 genre_sequence로 장르가 확정돼있어(AI 확률 분류가 낭비+모순, 기존
// anyClose 훅 주석과 동일 이유) 대상에서 제외 — 프론트에서 그 값을 직접
// 색으로 씀.
exports.backfillGenreProbs = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 540 })
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    if (!user_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);
    if (user_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');

    const db = admin.firestore();
    const [storiesSnap, probsSnap] = await Promise.all([
      db.collection('stories').where('status', '==', 'completed').get(),
      db.collection('story_genre_probs').get(),
    ]);
    const haveProbs = new Set(probsSnap.docs.map(d => d.id));
    const targets = storiesSnap.docs.filter(d => !haveProbs.has(d.id) && d.data().mode !== 'genre_switch');
    if (data.dryRun) return { ok: true, dryRun: true, target_count: targets.length, total_completed: storiesSnap.size };

    let done = 0, failed = 0;
    for (const doc of targets) {
      try { await _classifyStoryGenre(db, doc.id, Number(doc.data().current_step) || 0); done++; }
      catch (e) { failed++; console.error('backfill genre error:', doc.id, e.message); }
    }
    return { ok: true, target_count: targets.length, done, failed };
  });

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
    ...((resolvedWinners && resolvedWinners.anyClose) ? { completed_at: new Date().toISOString() } : {}),
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
    // 콘텐츠 모드별 필드를 안 물려주고 있었음 — 결말고정/장르전환 이야기가
    // 동률 분기로 스핀오프되면 mode/fixed_ending/genre_sequence가 통째로
    // 빠져서, 분기된 새 스토리가 조용히 "그냥 자유 이야기"로 되돌아가
    // 강제 결말·강제 장르 보장이 다 풀리고 있었음(디버그방 감사 발견,
    // 2026-07-30). 원본에 있던 것만 그대로 이어받게 함.
    ...(story.mode ? { mode: story.mode } : {}),
    ...(story.fixed_ending ? { fixed_ending: story.fixed_ending } : {}),
    ...(story.genre_sequence ? { genre_sequence: story.genre_sequence } : {}),
    ...(story.vote_threshold ? { vote_threshold: story.vote_threshold } : {}),
    ...(story.challenge_words ? { challenge_words: story.challenge_words } : {}),
    ...(story.is_ai_seed ? { is_ai_seed: story.is_ai_seed } : {}),
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
  // 🔒 2026-08-27 보안방: closeEpisode가 무인증+무검증 콜러블이라 실제 투표
  // 임계값 도달 여부와 무관하게 아무나 강제 마감을 트리거할 수 있었음 —
  // 마감 선점(status:'closed'로 바꾸는 것)과 같은 트랜잭션 안에서 실제
  // 최고 득표수를 재조회해 임계값 미만이면 아무것도 바꾸지 않고 되돌아감
  // (TOCTOU 없이, 검증과 상태변경이 원자적으로 묶임).
  const closeResult = await db.runTransaction(async tx => {
    const [snap, storySnap, subsSnap] = await Promise.all([
      tx.get(epRef),
      tx.get(storyRef),
      tx.get(db.collection('submissions').where('episode_id', '==', episode_id)),
    ]);
    if (!snap.exists) return 'already_closed';
    const st = snap.data().status;
    if (st !== 'open' && st !== 'pending') return 'already_closed';

    const voteThreshold = (storySnap.exists && storySnap.data().vote_threshold) || AI_VOTE_THRESHOLD;
    const maxVoteCount = subsSnap.docs.reduce((m, d) => Math.max(m, Number(d.data().vote_count) || 0), 0);
    if (maxVoteCount < voteThreshold) return 'below_threshold';

    tx.update(epRef, { status: 'closed', closed_at: new Date().toISOString() });
    // 자유 이야기 탭 카드용 open_steps에서도 제거 — 안 지우면 닫힌 에피소드가
    // 카드에 계속 "열려있는 것"처럼 남음(2026-07-18 성능개선용 비정규화 필드,
    // firebase-api.js fbCreateStory 참고)
    tx.update(storyRef, { [`open_steps.${episode_id}`]: admin.firestore.FieldValue.delete() });
    return 'closed';
  });
  if (closeResult !== 'closed') return closeResult;

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

  const storySnap = await db.collection('stories').doc(ep.story_id).get();
  if (!storySnap.exists) return;
  const st = storySnap.data();
  // 결말 고정 이야기는 fbCreateSubmission이 클라이언트 직접 Firestore write라
  // (firestore.rules에서 submissions가 전부 열려있음) 유저가 기존 "완결하기"
  // (closing:true) 버튼으로 정해진 결말을 우회하고 조기 완결시킬 수 있음 —
  // is_closing을 무조건 무력화해서, 아래 새로 추가한 마지막 단계 자동주입
  // 분기가 결말 고정 이야기의 유일한 완결 경로가 되게 막음.
  const isFixedEnding = st.mode === 'fixed_ending';
  const anyClose = isFixedEnding ? false : winners.some(w => w.is_closing === true);

  for (const w of winners) {
    await db.collection('submissions').doc(w.id).update({ is_adopted: true });
    // 다듬기(derived_from) 체인 반영해서 분배 (누락되어 있던 부분 — 원작자
    // 없이 채택자에게 20점을 무조건 몰아주고 있었음). 결말 고정 이야기에선
    // is_closing이 무력화된 것과 같은 이유로, 여기서도 완결 보너스 포인트·
    // 업적(closing_count)이 새지 않도록 is_closing을 같이 무력화해서 넘김
    // (2026-08-10 디버그방 발견 — 완결 자체는 막혀 있었는데 포인트/업적만 샜음).
    await _serverDistributePoints(db, isFixedEnding ? { ...w, is_closing: false } : w, allSubs);
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
  // ⚠️ 화면 표시 단계(calcDisplayStep, bang/index.html)는 오프닝 문장을 "1단계"로
  // 치고 내부 step마다 +1을 더해서 보여줌(분기/연장 이력 없는 일반 스토리 기준).
  // 원래는 nextStep+1===max_steps일 때 주입해서 내부 10단계(=화면 11단계)에
  // 결말이 뜨고 있었음 — max_steps:10 설정과 실제 화면 표시가 어긋나서
  // "10단계에서 끝나야 의미있지 않냐"는 유저 지적으로 한 단계 앞당김
  // (2026-08-21). 이제 내부 9단계(=화면 10단계)에 결말이 뜨고, max_steps와
  // 화면 표시가 정확히 일치함 — 진행률 표시("N/max_steps단계")도 더는
  // 분자가 분모를 넘는 일이 없어짐. 단, 이미 내부 9단계가 예전 기준(10단계에서
  // 주입)으로 공개 제출을 받아 진행 중이던 스토리(AoB9rHAEM7hNZg5seMHi 등)는
  // nextStep+1===max_steps 조건도 같이 남겨둬서 그대로 완결까지 가게 함(그
  // 스토리만 예전처럼 화면 11단계로 끝남 — 이미 열린 단계를 지금 와서 무효화할
  // 순 없으므로, 신규 스토리만 새 기준 적용).
  if (st.mode === 'fixed_ending' && (nextStep + 2 === Number(st.max_steps) || nextStep + 1 === Number(st.max_steps))) {
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
    // completed_at 신설(2026-08-22) — 완성된 이야기 탭이 지금까지 created_at
    // (이야기 시작일) 기준으로 정렬돼서, 오래전에 시작해 방금 막 완결된 긴
    // 이야기가 목록 맨 위가 아니라 시작일 기준 옛날 자리에 묻혀 보였음(유저
    // 제보 — "완성된 이야기로 안 넘어온 것 같다", 실제론 넘어갔는데 정렬 때문에
    // 안 보였던 것). 아래 다른 완결 경로(anyClose/초스피드/고아분기) 전부 동일.
    finalBatch.update(storySnap.ref, {
      current_step: nextStep + 1, status: 'completed', completed_at: now,
      ...(winners.length > 1 ? { has_branch: true } : {}),
    });
    await finalBatch.commit();
    try { await _serverRefillSpotlightSlot(db, ep.story_id); } catch (e) { console.error('spotlight refill error:', e.message); }

    // 이 스토리에 더 앞선 단계에서 동률로 갈렸던 미완주 분기가 남아있으면,
    // 일반 완결 경로(anyClose)와 동일하게 독립 스토리로 분리 — 안 그러면
    // 부모 스토리가 completed로 바뀌면서 그 분기가 투표를 못 받는 고아
    // 상태로 방치됨(유저 지적, 2026-07-29). _serverSpinOffOrphan은 mode/
    // fixed_ending을 그대로 물려주므로, 분리된 분기도 같은 결말로 마저
    // 완결될 수 있음(유저 확정 — "포기"가 아니라 "독립적으로 마저 완결").
    const orphanSnap = await db.collection('episodes')
      .where('story_id', '==', ep.story_id).where('status', '==', 'open').get();
    if (!orphanSnap.empty) {
      const { epById, subsByEp, subById } = await _serverBuildEpisodeMaps(db, ep.story_id);
      for (const orphanDoc of orphanSnap.docs) {
        await _serverSpinOffOrphan(db, { episode_id: orphanDoc.id, ...orphanDoc.data() }, st, epById, subsByEp, subById, null);
      }
    }

    try { await _generateStoryTitle(db, ep.story_id); } catch (e) { console.error('title generate error:', e.message); }
    console.log(`serverCloseEpisode: ${episode_id} → fixed_ending 완결 (step ${nextStep + 1})`);
    return;
  }

  if (anyClose) {
    await storySnap.ref.update({ current_step: nextStep, status: 'completed', completed_at: new Date().toISOString() });
    // 3슬롯 "오늘의 이야기" 스포트라이트 리필 훅 — 방금 완결된 스토리가 스포트라이트
    // 슬롯을 차지하고 있었다면 다음 이야기로 즉시 교체. 사람/AI 마감 경로 모두
    // 이 함수를 거치므로(공용 단일 완결 지점) 여기가 정확한 훅 위치.
    try { await _serverRefillSpotlightSlot(db, ep.story_id); } catch (e) { console.error('spotlight refill error:', e.message); }
    // 책장 표지용 짧은 제목 생성("책의 언어" 디자인, 2026-08-26) — 사람/AI
    // 마감 공용 지점이라 여기 한 곳이면 일반 자유 이야기·genre_switch·
    // 단어챌린지 등 대부분의 완결을 커버함(fixed_ending/초스피드는 각자
    // 완결 경로가 따로 있어 그쪽에도 별도로 호출 필요).
    try { await _generateStoryTitle(db, ep.story_id); } catch (e) { console.error('title generate error:', e.message); }

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
    // 장르전환은 강제완결이 없어 max_steps(10)를 넘어서도 계속 진행될 수
    // 있는데 genre_sequence가 정확히 10개짜리라 새 단계가 배열 길이를
    // 넘어서면 미리 늘려서 저장(유저 지적, 2026-07-29).
    if (st.mode === 'genre_switch' && (Number(st.genre_sequence?.length) || 0) < nextStep + 1) {
      storyUpdate.genre_sequence = _serverExtendGenreSequence(st.genre_sequence, nextStep + 1);
    }
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
  .runWith({ timeoutSeconds: 300 })
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

        // 장르전환(genre_switch) 이야기는 매 단계 장르가 genre_sequence로 강제
        // 지정돼있음 — 제출/투표 둘 다 이 단계가 어떤 장르여야 하는지 알아야
        // 해서 공통으로 한 번만 계산(2026-08-17, 제출 프롬프트도 장르 인지하게 함).
        const gsGenre = story.mode === 'genre_switch' ? (story.genre_sequence || [])[(Number(currentEp.step) || 1) - 1] : null;

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
            // 장르전환은 톤 지시보다 장르 지정이 우선 — 안 맞으면 투표 AI가 어차피
            // 잘 안 뽑아서 헛제출이 되니, 톤은 그대로 두되 장르 제약을 덧붙임.
            const genreInstruction = gsGenre
              ? `\n\n⚠️ 이 이야기는 매 단계마다 장르가 강제로 바뀌는 콘셉트입니다. 이번 단계는 반드시 "${gsGenre}" 장르에 맞게 써야 합니다 — 직전 문장과 톤이 확 달라져도 괜찮습니다(오히려 의도된 특징).`
              : '';

            const subPrompt = `당신은 릴레이 소설에 참여하는 작가입니다.

⚠️ 핵심 제약: 반드시 30자~50자 이내의 짧은 한 문장만 작성하세요. 50자 초과 시 잘립니다.

지금까지의 이야기:
${storyText}

위 이야기에 이어지는 다음 문장 하나를 ${tone} 써주세요.${genreInstruction}
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
            // "가장 재밌고 참신한"만 기준이었을 때, 이야기 흐름과 무관하게 튀는
            // 뜬금없는 비유(뜻밖의 이미지를 던지는 AI 특유의 문체)가 참신함
            // 점수만으로 계속 선택돼 이야기 맥락이 무너지는 문제가 있었음(유저
            // 제보, 2026-08-02). 참신함 자체는 나쁜 게 아니라 "이야기에 맞는지"를
            // 아예 기준에서 안 물어봤던 게 문제라, 맥락 적합성을 1차 기준으로
            // 두고 그 안에서 재미/참신함을 보도록 순서를 명시.
            //
            // 장르전환(genre_switch) 이야기는 매 단계 장르가 강제로 바뀌는 게
            // 설계 의도라, 위 "맥락과 자연스럽게 이어지는지" 기준을 그대로 적용하면
            // 오히려 의도대로 잘 튄(장르에 맞게 바뀐) 좋은 문장이 "뜬금없다"고
            // 손해 보는 부작용이 생김(유저 지적, 2026-08-02) — genre_sequence에서
            // 이번 단계가 어떤 장르여야 하는지 미리 알려주고, 그 장르에 맞는지를
            // 기준으로 판단하도록 별도 지시. (gsGenre는 이제 위에서 제출 로직과
            // 공유하는 값을 그대로 씀 — 2026-08-17)
            const criteriaText = gsGenre
              ? `이 이야기는 매 단계마다 장르가 강제로 바뀌는 콘셉트입니다. 이번 단계는 "${gsGenre}" 장르여야 합니다 — 직전 톤과 안 이어지고 확 튀는 것이 오히려 의도된 정상적인 특징이니, 그 이유만으로 감점하지 마세요.
"${gsGenre}" 장르에 실제로 잘 맞으면서, 그중에서도 가장 재밌고 참신한 문장 하나를 골라 해당 sub_id 값만 출력하세요.`
              : `위 "이야기 앞부분"의 흐름·톤·설정과 자연스럽게 이어지는 문장들 중에서, 가장 재밌고 참신한 문장 하나를 골라 해당 sub_id 값만 출력하세요.
이야기 전개에서 벗어나거나 맥락과 무관하게 뜬금없는 문장은 아무리 참신해도 고르지 마세요.`;
            const votePrompt = `다음은 릴레이 소설 한 단계에 제출된 문장들입니다.

이야기 앞부분:
${storyText}

제출된 문장 목록:
${votable.map((s, i) => `[${i + 1}] sub_id=${s.id} | ${s.content}`).join('\n')}

${criteriaText} 다른 텍스트 없이.`;

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
          // 스포트라이트 슬롯 이야기(vote_threshold, _serverCreateSeedStory에서 지정)는
          // 원래 관심 몰림 방지로 일반 이야기(AI_VOTE_THRESHOLD=3)보다 높게(5→3) 잡았던
          // 건데, 지금은 반대로 회전이 느리다고 판단해 2로 낮춤(2026-08-17) — 이제
          // 일반 이야기보다도 낮은 문턱. 필드 없으면(레거시 데이터 등) 기존
          // AI_VOTE_THRESHOLD로 폴백.
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

// ── 계정 이용 정지(어뷰징 대응) ──────────────────────────────
// users.banned_until(ISO)이 미래 시점이면 로그인/세션 재검증을 전부 막음 —
// "글쓰기만 막기"는 제출/투표/댓글 등 쓰기 경로가 너무 많이 흩어져 있어(수십 곳)
// 일부만 막고 놓치는 경로가 남을 위험이 커서, 로그인 자체를 막는 더 단순하고
// 확실한 방식으로 감(2026-08-02, 어뷰징 제보 대응 — 유저 확정).
function _activeBan(u) {
  if (!u.banned_until) return null;
  if (new Date(u.banned_until) <= new Date()) return null;
  return { banned: true, banned_until: u.banned_until, error: '어뷰징 제보로 이용이 중단된 계정입니다.' };
}

exports.adminBanUser = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const target_id = data.target_user_id;
    const days = Number(data.days) || 0;
    if (!target_id || days <= 0) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    const banned_until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await admin.firestore().collection('users').doc(target_id).update({
      banned_until, ban_reason: data.reason || '',
    });
    return { ok: true, banned_until };
  });

exports.adminUnbanUser = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const target_id = data.target_user_id;
    if (!target_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await admin.firestore().collection('users').doc(target_id).update({
      banned_until: admin.firestore.FieldValue.delete(), ban_reason: admin.firestore.FieldValue.delete(),
    });
    return { ok: true };
  });

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

    const initBatch = db.batch();
    initBatch.set(db.collection('users').doc(user_id), {
      user_id, nickname, display_name: dn,
      total_points: 0, adoption_count: 0, badge: 'seed', name: name.trim(), email,
      referral: referral.trim(), created_at: new Date().toISOString(),
      last_seen_patch_id: initialSeenPatchId,
      auth_uid: context.auth.uid,
    });
    initBatch.set(db.collection('user_secrets').doc(user_id), { pw_hash: pwHash, salt, token, token_exp });
    await initBatch.commit();

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

// ── 로그인 brute-force 방어 (2026-08-03, 보안방) ──
// login이 비밀번호 시도 횟수에 아무 제한이 없어서, 익명 세션 하나로 특정
// 닉네임을 대상으로 무제한 비밀번호 대입이 가능했음. 정답 비밀번호는 절대
// 막지 않는(계정 소유자가 락아웃당하지 않는) 쿨다운 방식 — 하드 락아웃은
// 공격자가 일부러 틀린 비밀번호를 반복 입력해 피해자를 강제로 못 들어오게
// 만드는 역공격에 악용될 수 있어 피함. email_rate_limits와 동일한 트랜잭션
// 패턴 재사용.
const LOGIN_FAIL_THRESHOLD = 5;   // 이 실패 횟수부터 쿨다운 발동
const LOGIN_COOLDOWN_MS = 5 * 60 * 1000; // 쿨다운 5분, 실패 카운트 창도 동일

async function _checkLoginRateLimit(db, nickname) {
  const snap = await db.collection('login_attempts').doc(nickname).get();
  if (!snap.exists) return { allowed: true };
  const d = snap.data();
  if (d.locked_until && Date.now() < new Date(d.locked_until).getTime()) {
    return { allowed: false };
  }
  return { allowed: true };
}

async function _recordLoginFailure(db, nickname) {
  const ref = db.collection('login_attempts').doc(nickname);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const now = Date.now();
    let fails = 1;
    if (snap.exists) {
      const d = snap.data();
      const withinWindow = d.last_fail_at && now - new Date(d.last_fail_at).getTime() < LOGIN_COOLDOWN_MS;
      fails = withinWindow ? (d.fail_count || 0) + 1 : 1;
    }
    const patch = { fail_count: fails, last_fail_at: new Date().toISOString() };
    if (fails >= LOGIN_FAIL_THRESHOLD) patch.locked_until = new Date(now + LOGIN_COOLDOWN_MS).toISOString();
    tx.set(ref, patch, { merge: true });
  });
}

async function _clearLoginFailures(db, nickname) {
  await db.collection('login_attempts').doc(nickname).delete().catch(() => {});
}

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

    const rl = await _checkLoginRateLimit(db, nickname);
    if (!rl.allowed) return { ok: false, error: '로그인 시도가 너무 많아요. 5분 후 다시 시도해주세요.' };

    const doc = snap.docs[0];
    const u = doc.data();
    const secSnap = await db.collection('user_secrets').doc(doc.id).get();
    const sec = secSnap.exists ? secSnap.data() : {};
    if (!_verifyPw(password, sec)) {
      await _recordLoginFailure(db, nickname).catch(e => console.error('login rate limit record error:', e.message));
      return { ok: false, error: '닉네임 또는 비밀번호가 틀렸습니다.' };
    }
    await _clearLoginFailures(db, nickname);
    const ban = _activeBan(u);
    if (ban) return { ok: false, ...ban };

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
      const ban = _activeBan(u);
      if (ban) return { ok: false, ...ban };
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
      const ban = _activeBan(u);
      if (ban) return { ok: false, ...ban };
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
    // 커밋 메시지엔 "verifySession도 체크해서 이미 로그인된 세션도 다음
    // 재검증 때 걸린다"고 돼있었는데 실제로는 이 함수가 _activeBan을 호출한
    // 적이 없어서, 정지 전에 이미 로그인해둔 세션은 토큰이 안 만료되는 한
    // 계속 정상 이용이 가능한 상태였음(디버그방 감사 발견, 2026-08-02) —
    // 클라이언트(fbGetSession)는 이미 result.banned를 받을 준비가 돼있었으므로
    // 서버만 실제로 채워주면 됨.
    const ban = _activeBan(u);
    if (ban) return { ok: false, banned: true, banned_until: ban.banned_until };
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
  const nodemailer = require('nodemailer');
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
// 🔒 2026-08-27 보안방: episode_id만 받고 인증이 전혀 없어서, 로그인 없이
// 아무나 진행 중인 에피소드를 즉시 마감시킬 수 있었음(실제 투표수는
// _serverCloseEpisode도 검증 안 해서, 1표든 0표든 그대로 채택/포인트분배/
// 다음 단계 진행까지 트리거됨). 최소한 로그인된 사용자만 호출 가능하도록
// _requireUser로 막고, 실제 임계값 검증은 _serverCloseEpisode 안(마감
// 트랜잭션과 동일 트랜잭션)에서 재확인하도록 함께 수정.
exports.closeEpisode = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const episode_id = data.episode_id;
    if (!episode_id) throw new functions.https.HttpsError('invalid-argument', 'episode_id가 필요합니다.');
    await _requireUser(data.user_id, data.token);
    const db = admin.firestore();
    const epSnap = await db.collection('episodes').doc(episode_id).get();
    if (!epSnap.exists) return { ok: true };

    // 🔒 2026-08-29 보안방(P0 투표 위조 대응): 관리자 강제채택(원래
    // fbAdminForceAdopt가 클라에서 submissions.vote_count를 직접 9999로
    // 썼던 경로)을 여기로 흡수 — vote_count가 서버 전용이 되면서(firestore.rules)
    // 그 직접 write가 막히므로, 같은 효과를 Admin SDK로 대신 냄. force_sub_id가
    // 실제로 이 episode_id 소속인지, 에피소드가 아직 open인지 먼저 확인—
    // 안 그러면 다른 에피소드 문서를 잘못/악의적으로 강제채택시키거나 이미
    // 닫힌 에피소드에 소급 개입할 수 있음(계획 검토 지적).
    if (data.force_sub_id) {
      if (data.user_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
      if (epSnap.data().status !== 'open') return { ok: false, error: '이미 마감된 에피소드입니다.' };
      const forceSubSnap = await db.collection('submissions').doc(data.force_sub_id).get();
      if (!forceSubSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
      if (forceSubSnap.data().episode_id !== episode_id) return { ok: false, error: '잘못된 요청입니다.' };
      await forceSubSnap.ref.update({ vote_count: 9999 });
    }

    const result = await _serverCloseEpisode(db, episode_id, epSnap.data());
    if (result === 'below_threshold') return { ok: false, error: '아직 투표 임계값에 도달하지 않았습니다.' };
    return { ok: true };
  });

// 🔒 2026-08-29 보안방(P0): 일반 에피소드 투표를 서버 Callable로 이관.
// fbVote가 클라이언트에서 votes/submissions.vote_count를 직접 썼는데, 그
// 컬렉션들이 완전 개방(firestore.rules)이라 로그인 계정 하나만 있으면
// vote_count를 위조해 closeEpisode의 임계값 재검증(95cbbd7)을 그대로
// 통과시킬 수 있었음. 이제 vote_count/is_adopted는 이 함수(Admin SDK)를
// 거쳐야만 바뀌고, 클라 직접 write는 firestore.rules로 막힘.
//
// EPISODE_MAX_VOTE_PICKS: bang/index.html의 selectedSubs 상한(2, "if
// (selectedSubs.length >= 2)")과 반드시 같은 값으로 유지 — DB에 이 값을 담는
// 필드가 따로 없어서(전수 확인) 서버가 이 상수로 그 근거를 대신 가짐.
const EPISODE_MAX_VOTE_PICKS = 2;

exports.voteEpisode = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const episode_id = data.episode_id;
    const voter_id = data.user_id;
    const sub_ids = [...new Set(Array.isArray(data.sub_ids) ? data.sub_ids : [])];
    if (!episode_id || sub_ids.length < 1 || sub_ids.length > EPISODE_MAX_VOTE_PICKS) {
      throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    }
    await _requireUser(voter_id, data.token);

    const db = admin.firestore();
    const userSnap = await db.collection('users').doc(voter_id).get();
    if (!userSnap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
    const ban = _activeBan(userSnap.data());
    if (ban) return { ok: false, error: ban.error };

    const epRef = db.collection('episodes').doc(episode_id);
    const subRefs = sub_ids.map(sid => db.collection('submissions').doc(sid));
    const prevVotesQuery = db.collection('votes')
      .where('episode_id', '==', episode_id).where('voter_id', '==', voter_id);

    const result = await db.runTransaction(async tx => {
      const [epSnap, subSnaps, prevVoteSnap] = await Promise.all([
        tx.get(epRef), Promise.all(subRefs.map(r => tx.get(r))), tx.get(prevVotesQuery),
      ]);
      if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
      const ep = epSnap.data();
      if (ep.status !== 'open') return { ok: false, error: '공감이 마감됐습니다.' };

      for (const s of subSnaps) {
        if (!s.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
        const sub = s.data();
        if (sub.episode_id !== episode_id) return { ok: false, error: '잘못된 요청입니다.' };
        // 이미 채택된 후보는 투표 대상이 아님(계획 승인 시 추가 요청) — 일반
        // submissions엔 is_adopted 외 다른 숨김/삭제류 상태 필드가 없음(전수
        // 확인 — is_deleted는 speedrun/your_story 전용 별개 컬렉션 성격).
        if (sub.is_adopted === true) return { ok: false, error: '이미 채택된 글이에요.' };
        if (sub.author_id === voter_id && !sub.is_ai) return { ok: false, error: '본인 제출에는 공감할 수 없습니다.' };
      }

      // 재투표(표 바꾸기) 대비: 이전에 투표했던 후보 중 이번 sub_ids에 없는
      // 것들도 읽어야 감소시킬 수 있음(트랜잭션 read-먼저 규칙이라 여기서 미리).
      const prevVotedSubIds = prevVoteSnap.docs.map(d => d.data().sub_id);
      const extraPrevIds = prevVotedSubIds.filter(id => !sub_ids.includes(id));
      const extraPrevSnaps = await Promise.all(extraPrevIds.map(id => tx.get(db.collection('submissions').doc(id))));

      // ── write ──
      const isRevote = !prevVoteSnap.empty;
      if (isRevote) {
        prevVoteSnap.docs.forEach(d => tx.delete(d.ref));
        extraPrevSnaps.forEach(s => {
          if (s.exists) tx.update(s.ref, { vote_count: admin.firestore.FieldValue.increment(-1) });
        });
      }
      subRefs.forEach((ref, i) => {
        // 이전에도 투표했던 후보를 이번에도 다시 고르면 증감이 상쇄돼야 하니
        // 그 경우만 건드리지 않음(재투표로 표를 안 바꾼 후보는 그대로 유지).
        if (isRevote && prevVotedSubIds.includes(sub_ids[i])) return;
        tx.update(ref, { vote_count: admin.firestore.FieldValue.increment(1) });
      });
      sub_ids.forEach(sid => {
        tx.set(db.collection('votes').doc(`${episode_id}_${voter_id}_${sid}`), {
          episode_id, sub_id: sid, voter_id, created_at: new Date().toISOString(),
        });
      });

      const newTotal = isRevote ? (Number(ep.vote_total) || 0) : (Number(ep.vote_total) || 0) + 1;
      tx.update(epRef, { vote_total: newTotal });

      return { ok: true, isRevote, newTotal, story_id: ep.story_id };
    });

    if (!result.ok) return result;

    if (!result.isRevote) {
      try { await _serverAddPoints(db, voter_id, 5, 'vote', ''); } catch (e) { console.error('vote point error:', e.message); }
      try { await _serverBumpAchievementCounter(db, voter_id, 'vote_count'); } catch (e) { console.error('vote achievement error:', e.message); }
    }

    // 응답은 기존 fbVote와 동일 형태 — 클라가 이 값으로 closeEpisode 호출
    // 여부를 그대로 판단(마감 트리거 흐름은 안 건드림, 최소 변경).
    const [freshSubsSnap, storySnap] = await Promise.all([
      db.collection('submissions').where('episode_id', '==', episode_id).get(),
      db.collection('stories').doc(result.story_id).get(),
    ]);
    const maxVotes = freshSubsSnap.docs.reduce((m, d) => Math.max(m, Number(d.data().vote_count) || 0), 0);
    const voteThreshold = (storySnap.exists && storySnap.data().vote_threshold) || AI_VOTE_THRESHOLD;
    return { ok: true, total_voters: result.newTotal, max_votes: maxVotes, vote_threshold: voteThreshold };
  });

// 🔒 2026-08-29 보안방(P0): 관리자 제출물 편집을 서버로 이관 — 위 voteEpisode와
// 세트. submissions의 update firestore.rule을 "content/is_closing은 무투표·
// 미채택일 때만" 화이트리스트로 좁혔는데(fbEditMySubmission 자기수정용),
// 관리자는 투표/채택 상태와 무관하게(오타 수정 등) content를 고칠 수 있어야
// 하는 기존 동작이라 그 화이트리스트로는 커버가 안 됨 — Admin SDK로 이관해서
// 규칙 자체를 우회. fbAdminEditSub(bang/firebase-api.js)의 로직 그대로.
exports.adminEditSubmission = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const admin_id = data.user_id;
    const sub_id = data.sub_id;
    const new_content = (data.new_content || '').trim();
    if (!admin_id || !sub_id || !new_content) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(admin_id, data.token);
    if (admin_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');

    const db = admin.firestore();
    const subRef = db.collection('submissions').doc(sub_id);
    const subSnap = await subRef.get();
    if (!subSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
    await subRef.update({ content: new_content });
    await db.collection('admin_edits').add({
      sub_id, story_id: data.story_id || '', old_content: data.old_content || '',
      new_content, edit_type: data.edit_type || 'manual',
      admin_id, edited_at: new Date().toISOString(),
    });
    return { ok: true };
  });

// 🔒 2026-08-29 보안방(P0): ai_reviewed는 글로벌화(번역) 계획이 "이 문장은
// 안정화됐다"는 신뢰 조건으로 쓸 예정이라, submissions update 화이트리스트에
// 아예 안 넣고 완전히 서버 전용으로 둠(계획 검토 지적). fbMarkAiReviewed의
// 로직 그대로.
exports.adminMarkAiReviewed = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const admin_id = data.user_id;
    const sub_ids = Array.isArray(data.sub_ids) ? data.sub_ids : [];
    if (!admin_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(admin_id, data.token);
    if (admin_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');
    if (!sub_ids.length) return { ok: true };

    const db = admin.firestore();
    await Promise.all(sub_ids.map(id => db.collection('submissions').doc(id).update({ ai_reviewed: true })));
    return { ok: true };
  });

// ══ A-2 (2026-08-29 보안방): 제출(submissions) 쓰기 경로 전면 서버 이관 ══
//
// 배경: submissions는 그동안 클라이언트가 직접 쓰는 구조라, fbCreateSubmission의
// 검증(제출 횟수 제한, 에피소드 open 여부, 1인당 제출 수)이 전부 "앱을 거치는
// 경로에서만" 유효한 client-side best-effort였음(be93ea7 당시 한계로 명시 기록됨).
// 앱을 안 거치고 Firestore에 직접 쓰면 그 체크 전부를 우회할 수 있었음.
// 이제 아래 함수들(+ P0의 voteEpisode/closeEpisode/adminEditSubmission 등)만
// submissions에 쓸 수 있고, 클라이언트 직접 write는 firestore.rules로 완전 차단됨.
//
// ⚠️ 동시성 설계 노트: 제출 rate limit을 별도 카운터 컬렉션 없이 강제하기 위해,
// 같은 사용자의 동시 요청이 반드시 충돌하도록 users/{author_id} 문서를 제출
// 트랜잭션 안에서 함께 읽고 쓴다(포인트/카운터 갱신이 원래 그 문서에 필요하므로
// 추가 비용이 없음). Firestore 트랜잭션은 낙관적 동시성이라 한쪽이 재시도되고,
// 재시도 시 rate limit 쿼리가 다시 평가되므로 두 요청이 모두 통과할 수 없음.

const SUBMIT_RATE_HOURLY_MAX = 30;
const SUBMIT_RATE_DAILY_MAX  = 60;
// bang/firebase-api.js의 FB_GENRE_SWITCH_MAX_CHARS(50)와 같은 값으로 유지할 것.
const SUBMIT_MAX_CHARS = 50;
const GENRE_SWITCH_MAX_CHARS = 50;
const MODE_ACHIEVEMENT_CATEGORY = {
  fairytale: 'fairytale_count', fixed_ending: 'fixed_ending_count', genre_switch: 'genre_switch_count',
};

function _submitMaxChars(story) {
  return (story && story.mode === 'genre_switch') ? GENRE_SWITCH_MAX_CHARS : SUBMIT_MAX_CHARS;
}

// 이미 열려 있는 트랜잭션 안에서 포인트를 적용하기 위한 필드 계산 —
// _serverAddPoints는 자체 트랜잭션을 열어서 중첩이 불가능하므로(speedrunSubmit이
// 같은 이유로 인라인 처리함) 잔액/배지 계산만 떼어 재사용 가능한 형태로 둔다.
// 실제 tx.update/tx.set은 호출부가 다른 필드와 합쳐서 한 번에 수행한다.
function _txPointFields(uData, amount) {
  const newTotal = (Number(uData.total_points) || 0) + amount;
  return { total_points: newTotal, badge: _serverCalcBadge(newTotal) };
}
function _pointsApplicable(user_id) {
  return !!user_id && user_id !== FB_ADMIN_ID && user_id !== FB_AI_ID;
}
function _txLedger(db, tx, user_id, points, reason, sub_id) {
  tx.set(db.collection('point_ledger').doc(), {
    user_id, points, reason, sub_id: sub_id || '', created_at: new Date().toISOString(),
  });
}

// 500-write 한도를 넘지 않도록 400건씩 나눠 커밋(닉네임 캐스케이드/분기 복사/
// 관리자 삭제 정리 공통) — 문서 수가 많을 때 단일 batch가 통째로 실패하는 것을 막음.
async function _commitInChunks(db, docs, apply, chunkSize) {
  const size = chunkSize || 400;
  for (let i = 0; i < docs.length; i += size) {
    const batch = db.batch();
    docs.slice(i, i + size).forEach(d => apply(batch, d));
    await batch.commit();
  }
}

// ── 제출 생성 (기존 fbCreateSubmission) ──────────────────────
exports.submitEpisode = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const episode_id = data.episode_id;
    const author_id = data.user_id;
    const text = (data.content || '').trim();
    const derived_from = data.derived_from || '';
    if (!episode_id || !author_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(author_id, data.token);
    if (!text) return { ok: false, error: '내용을 입력해주세요.' };

    const db = admin.firestore();
    const uRef = db.collection('users').doc(author_id);
    const epRef = db.collection('episodes').doc(episode_id);
    const now = Date.now();
    const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const dayAgo  = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    // orderBy('created_at','desc')를 반드시 명시 — 기존 author_id ASC + created_at DESC
    // 복합 인덱스를 그대로 타기 위함(명시 안 하면 Firestore가 암묵적 오름차순 인덱스를
    // 요구해 "인덱스 필요" 400으로 제출이 통째로 깨짐, be93ea7 때 실제로 겪은 함정).
    // .count()는 이 프로젝트에서 호환성 문제 전례가 있어 쓰지 않고 limit+size로 판정.
    const hourQuery = db.collection('submissions').where('author_id', '==', author_id)
      .where('created_at', '>', hourAgo).orderBy('created_at', 'desc').limit(SUBMIT_RATE_HOURLY_MAX);
    const dayQuery  = db.collection('submissions').where('author_id', '==', author_id)
      .where('created_at', '>', dayAgo).orderBy('created_at', 'desc').limit(SUBMIT_RATE_DAILY_MAX);
    // 회차 내 본인 제출 수는 기존과 동일하게 episode_id 단일 조건으로 읽고 코드에서
    // 필터한다(복합 인덱스를 새로 요구하지 않기 위함 — 아젠다 제약).
    const epSubsQuery = db.collection('submissions').where('episode_id', '==', episode_id);

    const result = await db.runTransaction(async tx => {
      const epSnap = await tx.get(epRef);
      if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
      const ep = epSnap.data();
      // 기존 클라이언트 구현은 이 확인이 트랜잭션 "밖"이라 TOCTOU 허점이 있었음
      // (speedrunSubmit 주석이 지목한 그 허점) — 트랜잭션 안 첫 읽기로 옮김.
      if (ep.status !== 'open') return { ok: false, error: '제출이 마감됐습니다.' };

      const storyRef = db.collection('stories').doc(ep.story_id);
      const [uSnap, storySnap, hourSnap, daySnap, epSubsSnap] = await Promise.all([
        tx.get(uRef), tx.get(storyRef), tx.get(hourQuery), tx.get(dayQuery), tx.get(epSubsQuery),
      ]);
      if (!uSnap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
      const uData = uSnap.data();
      const ban = _activeBan(uData);
      if (ban) return { ok: false, error: ban.error };

      if (hourSnap.size >= SUBMIT_RATE_HOURLY_MAX) return { ok: false, error: '너무 빠르게 많이 작성하고 있어요. 잠시 후 다시 시도해주세요.' };
      if (daySnap.size >= SUBMIT_RATE_DAILY_MAX) return { ok: false, error: '오늘 작성 가능한 횟수를 다 채웠어요. 내일 다시 시도해주세요.' };

      const story0 = storySnap.exists ? storySnap.data() : {};
      const maxChars = _submitMaxChars(story0);
      if (text.length > maxChars) return { ok: false, error: `${maxChars}자 이내로 작성해주세요.` };

      const myPrevCount = epSubsSnap.docs.filter(d => d.data().author_id === author_id && !d.data().is_ai).length;
      // 기본 1개 + 추가 제출권 1개(최대 2개). extra_submits 문서는 소모되지 않고 남으므로
      // "존재 여부"만 보던 예전 버그를 반복하지 않도록 개수 기준을 그대로 유지.
      if (myPrevCount >= 2) return { ok: false, error: '이미 제출하셨습니다.' };
      if (myPrevCount === 1) {
        const exSnap = await tx.get(db.collection('extra_submits')
          .where('episode_id', '==', episode_id).where('user_id', '==', author_id).limit(1));
        if (exSnap.empty) return { ok: false, error: '이미 제출하셨습니다.' };
      }

      // ── write ──
      const sub_id = db.collection('submissions').doc().id;
      const is_closing = data.closing === true && Number(ep.step) >= 2;
      const nowIso = new Date().toISOString();
      tx.set(db.collection('submissions').doc(sub_id), {
        sub_id, episode_id, story_id: ep.story_id, content: text,
        author_id, author_nickname: uData.display_name || uData.nickname || '익명',
        author_badge: uData.badge || 'seed',
        derived_from, vote_count: 0, is_adopted: false,
        created_at: nowIso, is_closing,
        // A-1(번역 스테일 판정)이 원문 변경을 식별할 수 있게 남기는 훅 —
        // 저장소 관례대로 ISO 문자열. 이 필드가 없는 문서는 "기존 문서"로 취급하면 됨.
        content_updated_at: nowIso,
      });
      if (storySnap.exists) {
        const cur = (story0.open_steps || {})[episode_id] || { step: Number(ep.step) || 0, sub_count: 0 };
        tx.update(storyRef, { [`open_steps.${episode_id}`]: { step: cur.step, sub_count: (Number(cur.sub_count) || 0) + 1 } });
      }

      // 제출 10p + 카운터를 같은 트랜잭션의 users 쓰기로 합침 — 부분 성공(제출은
      // 됐는데 포인트 미지급)을 없애고, 동시에 이 문서가 per-user 직렬화 지점이 됨.
      const userUpdate = { submission_count: (Number(uData.submission_count) || 0) + 1 };
      const modeCat = MODE_ACHIEVEMENT_CATEGORY[story0.mode];
      if (modeCat) userUpdate[modeCat] = (Number(uData[modeCat]) || 0) + 1;
      if (_pointsApplicable(author_id)) {
        Object.assign(userUpdate, _txPointFields(uData, 10));
        _txLedger(db, tx, author_id, 10, 'submit', sub_id);
      }
      tx.update(uRef, userUpdate);

      return {
        ok: true, sub_id, story_id: ep.story_id, step: Number(ep.step) || 0,
        newSubCount: userUpdate.submission_count,
        modeCat: modeCat || null, newModeCount: modeCat ? userUpdate[modeCat] : null,
      };
    });

    if (!result.ok) return result;

    // ── 파생 효과(실패해도 제출 성공을 훼손하지 않음, 기존 정책 그대로) ──
    // 카운터는 위 트랜잭션에서 이미 올렸으므로 여기서는 업적 판정만 한다
    // (_serverBumpAchievementCounter를 쓰면 카운터가 이중 증가함).
    try { await _serverCheckAchievements(db, author_id, 'submission_count', result.newSubCount); } catch (e) { console.error('submit achievement error:', e.message); }
    if (result.modeCat) {
      try { await _serverCheckAchievements(db, author_id, result.modeCat, result.newModeCount); } catch (e) { console.error('submit mode achievement error:', e.message); }
    }
    try {
      // participant_count 증가(이 이야기에 처음 참여한 경우) — 기존 구현과 동일하게
      // author_id 단일 조건으로 읽고 story_id로 필터(복합 인덱스 불필요).
      //
      // ⚠️ "이번 제출 말고 이전 제출이 없으면 증가"(기존 방식)는 동시 제출에 취약했다 —
      // 추가 제출권 보유자가 첫 두 건을 동시에 보내면 둘 다 커밋된 뒤 서로 상대를
      // 발견해 양쪽 다 증가를 건너뛰어 참여자 수가 누락된다(최종 재검토 지적).
      // 그래서 "내 제출물 중 가장 먼저 만들어진 한 건인가"로 판정을 바꿨다 —
      // 정렬 기준이 결정론적(created_at, 동률이면 문서 ID)이라 동시에 커밋된 두
      // 요청이 같은 목록을 보더라도 정확히 한쪽만 참이 된다. 새 컬렉션·필드 없음.
      const mySubsSnap = await db.collection('submissions').where('author_id', '==', author_id).get();
      const mineInStory = mySubsSnap.docs
        .filter(d => d.data().story_id === result.story_id)
        .map(d => ({ id: d.id, created_at: String(d.data().created_at || '') }))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id < b.id ? -1 : 1)));
      const isFirstParticipation = mineInStory.length > 0 && mineInStory[0].id === result.sub_id;
      if (isFirstParticipation) {
        const storyRef = db.collection('stories').doc(result.story_id);
        await db.runTransaction(async tx => {
          const snap = await tx.get(storyRef);
          if (!snap.exists) return;
          tx.update(storyRef, { participant_count: (Number(snap.data().participant_count) || 0) + 1 });
        });
        if (result.step === 1) {
          const storySnap = await storyRef.get();
          const storyData = storySnap.exists ? storySnap.data() : null;
          if (storyData && storyData.is_ai_seed && storyData.opening) {
            await db.collection('config').doc('used_openings').set({ [storyData.opening]: true }, { merge: true });
          }
        }
      }
    } catch (e) { console.error('submit participant_count error:', e.message); }

    return { ok: true, sub_id: result.sub_id };
  });

// ── 내 제출 수정 (기존 fbEditMySubmission) ───────────────────
exports.editMySubmission = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const sub_id = data.sub_id;
    const user_id = data.user_id;
    const text = (data.content || '').trim();
    const closing = data.closing;
    if (!sub_id || !user_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);
    if (!text) return { ok: false, error: '문장을 입력해주세요.' };

    const db = admin.firestore();
    const uRef = db.collection('users').doc(user_id);
    const subRef = db.collection('submissions').doc(sub_id);

    // 득표/채택 확인과 실제 수정을 반드시 한 트랜잭션에 둔다 — 확인 직후 투표나
    // 채택이 들어오면 "이미 표를 받은 글"이 수정될 수 있기 때문(최종 검토 지적).
    return await db.runTransaction(async tx => {
      const [subSnap, uSnap] = await Promise.all([tx.get(subRef), tx.get(uRef)]);
      if (!uSnap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
      const ban = _activeBan(uSnap.data());
      if (ban) return { ok: false, error: ban.error };
      if (!subSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
      const sub = subSnap.data();
      if (sub.author_id !== user_id) return { ok: false, error: '권한이 없습니다.' };
      if ((Number(sub.vote_count) || 0) > 0) return { ok: false, error: '공감을 받은 글은 수정할 수 없습니다.' };
      if (sub.is_adopted === true || sub.is_adopted === 'TRUE') return { ok: false, error: '채택된 글은 수정할 수 없습니다.' };

      // 글자수 상한은 생성 경로와 동일한 헬퍼로 계산(구조적으로 어긋나지 않게).
      const epSnap = await tx.get(db.collection('episodes').doc(sub.episode_id));
      const storySnap = epSnap.exists
        ? await tx.get(db.collection('stories').doc(epSnap.data().story_id)) : null;
      const maxChars = _submitMaxChars(storySnap && storySnap.exists ? storySnap.data() : {});
      if (text.length > maxChars) return { ok: false, error: `${maxChars}자 이내로 작성해주세요.` };

      const update = { content: text, content_updated_at: new Date().toISOString() };
      if (typeof closing === 'boolean' && closing !== !!sub.is_closing) {
        if (closing) {
          // "완결하기"는 클라이언트가 보낸 값을 그대로 믿지 않고 제출 폼과 동일한
          // 조건(이야기가 완결 가능한 길이)을 서버에서 다시 확인 — 기존 정책 유지.
          if (!epSnap.exists) return { ok: false, error: '에피소드를 찾을 수 없습니다.' };
          const ep = epSnap.data();
          const story = (storySnap && storySnap.exists) ? storySnap.data() : {};
          const closedSnap = await tx.get(db.collection('episodes')
            .where('story_id', '==', ep.story_id).where('status', '==', 'closed'));
          const parentSteps = story.branch_from_step ? Number(story.branch_from_step) - 1 : 0;
          if (closedSnap.size + parentSteps < 1) return { ok: false, error: '아직 완결로 제출할 수 없는 단계예요.' };
        }
        update.is_closing = closing;
      }
      tx.update(subRef, update);
      return { ok: true };
    });
  });

// ── 내 제출 삭제 (기존 fbDeleteMySubmission) ─────────────────
exports.deleteMySubmission = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const sub_id = data.sub_id;
    const user_id = data.user_id;
    if (!sub_id || !user_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);

    const db = admin.firestore();
    const uRef = db.collection('users').doc(user_id);
    const subRef = db.collection('submissions').doc(sub_id);

    const result = await db.runTransaction(async tx => {
      const [subSnap, uSnap] = await Promise.all([tx.get(subRef), tx.get(uRef)]);
      if (!subSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
      if (!uSnap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
      const uData = uSnap.data();
      const ban = _activeBan(uData);
      if (ban) return { ok: false, error: ban.error };
      const sub = subSnap.data();
      if (sub.author_id !== user_id) return { ok: false, error: '권한이 없습니다.' };
      if ((Number(sub.vote_count) || 0) > 0) return { ok: false, error: '공감을 받은 글은 삭제할 수 없습니다.' };
      if (sub.is_adopted === true || sub.is_adopted === 'TRUE') return { ok: false, error: '채택된 글은 삭제할 수 없습니다.' };

      tx.delete(subRef);
      // 10p 회수를 같은 트랜잭션에 넣어 부분 성공을 없애되, 잔액이 부족하면
      // 차감을 건너뛰고 삭제는 그대로 진행한다 — 기존 정책("포인트 차감이 실패해도
      // 삭제 자체는 유지")의 사용자 체감 동작을 그대로 보존하기 위함.
      let spent = false;
      if (_pointsApplicable(user_id) && (Number(uData.total_points) || 0) >= 10) {
        tx.update(uRef, _txPointFields(uData, -10));
        _txLedger(db, tx, user_id, -10, 'delete_submission', '');
        spent = true;
      }
      return { ok: true, story_id: sub.story_id, episode_id: sub.episode_id, spent };
    });

    if (!result.ok) return result;

    // 카드 표시용 카운터와 댓글 정리는 부가 작업 — 실패해도 삭제 결과를 뒤집지 않음.
    try {
      await db.collection('stories').doc(result.story_id).update({
        [`open_steps.${result.episode_id}.sub_count`]: admin.firestore.FieldValue.increment(-1),
      });
    } catch (e) { console.error('delete sub_count error:', e.message); }
    try {
      const cSnap = await db.collection('comments').where('sub_id', '==', sub_id).get();
      await _commitInChunks(db, cSnap.docs, (batch, d) => batch.delete(d.ref));
    } catch (e) { console.error('delete comments error:', e.message); }

    return { ok: true };
  });

// ── 닉네임(표시 이름) 변경 (기존 fbChangeDisplayName) ────────
exports.changeDisplayName = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    const dn = (data.display_name || '').trim();
    if (!user_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);
    if (!dn || dn.length < 2) return { ok: false, error: '닉네임은 2자 이상이어야 합니다.' };
    if (!/^[가-힣a-zA-Z0-9 ._-]{2,12}$/.test(dn)) return { ok: false, error: '닉네임은 2~12자, 한글·영문·숫자·공백·._- 만 사용할 수 있어요.' };

    const db = admin.firestore();
    const uRef = db.collection('users').doc(user_id);
    const dupQuery = db.collection('users').where('display_name', '==', dn).limit(1);

    const result = await db.runTransaction(async tx => {
      // 중복 확인을 트랜잭션 안 읽기로 둬서, 확인~쓰기 사이의 취약 창을 없앰
      // (완전한 고유성 보장은 예약 문서가 필요하지만 그건 register까지 함께
      // 바꿔야 하는 별도 과제 — 기존 대비 나빠지지 않으면서 창만 좁힘).
      const [dupSnap, uSnap] = await Promise.all([tx.get(dupQuery), tx.get(uRef)]);
      if (!uSnap.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
      const u = uSnap.data();
      const ban = _activeBan(u);
      if (ban) return { ok: false, error: ban.error };
      if (!dupSnap.empty && dupSnap.docs[0].id !== user_id) return { ok: false, error: '이미 사용 중인 닉네임입니다.' };

      // 최초 1회(name_history가 비어있을 때)는 무료, 이후 20p — 간편가입 자동
      // 생성 닉네임을 처음 바꾸는 데 비용을 물리지 않기 위한 기존 정책 그대로.
      const isFirstChange = !u.name_history || u.name_history.length === 0;
      const chargeable = !isFirstChange && _pointsApplicable(user_id);
      if (chargeable && (Number(u.total_points) || 0) < 20) {
        return { ok: false, error: '포인트가 부족합니다. 닉네임 변경에는 20p가 필요해요.' };
      }

      const old_name = u.display_name || u.nickname;
      const userUpdate = {
        display_name: dn,
        name_history: admin.firestore.FieldValue.arrayUnion({ name: old_name, changed_at: new Date().toISOString() }),
      };
      // 이름 변경과 20p 차감을 한 트랜잭션에 둬서, "이름은 바뀌었는데 차감이
      // 실패해 오류가 반환되는" 기존 순서 문제를 없앰.
      if (chargeable) {
        Object.assign(userUpdate, _txPointFields(u, -20));
        _txLedger(db, tx, user_id, -20, 'nickname_change', '');
      }
      tx.update(uRef, userUpdate);
      return { ok: true, display_name: dn };
    });

    if (!result.ok) return result;

    // 과거 제출물의 표시 닉네임 일괄 갱신 — 400건씩 끝까지 순회(수백 건이라
    // 트랜잭션에 넣을 수 없고, 표시용 필드라 뒤따라 갱신되어도 안전).
    try {
      const subsSnap = await db.collection('submissions').where('author_id', '==', user_id).get();
      await _commitInChunks(db, subsSnap.docs, (batch, d) => batch.update(d.ref, { author_nickname: dn }));
    } catch (e) { console.error('nickname cascade error:', e.message); }

    return { ok: true, display_name: dn };
  });

// ── 분기 만들기 (기존 fbCreateBranch) ────────────────────────
// 이 함수가 A-2 범위에 포함된 이유: 분기 생성은 원본 회차의 미채택 제출물을
// 새 에피소드로 "복사"하므로 submissions에 직접 write를 한다 — rules를 잠그면
// 이 유료(30p) 기능이 통째로 깨진다(아젠다에는 없었으나 전수 grep으로 발견).
exports.createStoryBranch = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const story_id = data.story_id;
    const step = Number(data.branch_from_step);
    const user_id = data.user_id;
    if (!story_id || !step || !user_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);

    const db = admin.firestore();
    const new_story_id = db.collection('stories').doc().id;
    const new_ep_id    = db.collection('episodes').doc().id;
    const nowIso = new Date().toISOString();
    // 한 회차의 제출물 수는 현실적으로 수~수십 건이지만, 트랜잭션 write 한도(500)를
    // 넘는 입력이 오면 조용히 일부만 복사되는 대신 명시적으로 거부한다.
    const BRANCH_COPY_MAX = 400;

    // ⚠️ 상태·중복 분기·대상 회차 검증과 30p 차감, 새 스토리/에피소드 생성,
    // 미채택 제출물 복사를 전부 한 트랜잭션에 둔다(최종 검토 지적).
    //  - 검증이 트랜잭션 밖에 있으면 동시 요청이 모두 중복 검사를 통과해 같은
    //    단계에 분기가 여러 개 생기고 각각 30p가 빠져나갈 수 있음.
    //  - 제출물 복사가 트랜잭션 밖에 있으면 복사 실패 시에도 스토리와 차감만
    //    커밋되어, open_steps.sub_count가 실제 복사본 수와 어긋난 채 남음.
    const txResult = await db.runTransaction(async tx => {
      const uRef = db.collection('users').doc(user_id);
      const stRef = db.collection('stories').doc(story_id);
      const [freshU, stSnap, existSnap, epsSnap] = await Promise.all([
        tx.get(uRef), tx.get(stRef),
        tx.get(db.collection('stories').where('parent_story_id', '==', story_id)),
        tx.get(db.collection('episodes').where('story_id', '==', story_id)),
      ]);
      if (!freshU.exists) return { ok: false, error: '사용자를 찾을 수 없습니다.' };
      const uData = freshU.data();
      const ban = _activeBan(uData);
      if (ban) return { ok: false, error: ban.error };
      if (!stSnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
      const st = stSnap.data();
      if (st.status !== 'completed' && st.status !== 'inactive') {
        return { ok: false, error: '완결된 이야기에서만 분기를 만들 수 있습니다.' };
      }
      if (existSnap.docs.some(d => Number(d.data().branch_from_step) === step)) {
        return { ok: false, error: '이 단계에는 이미 분기가 있습니다.' };
      }
      const targetEp = epsSnap.docs.map(d => ({ episode_id: d.id, ...d.data() }))
        .find(e => Number(e.step) === step - 1);
      // ⚠️ 기존 클라이언트 구현은 30p를 먼저 차감한 뒤에 이 대상 회차를 찾아서,
      // 못 찾으면 포인트만 날아가는 결함이 있었음 — 모든 검증 통과 후에만 차감한다.
      if (!targetEp) return { ok: false, error: '해당 단계를 찾을 수 없습니다.' };

      const subsSnap = await tx.get(db.collection('submissions').where('episode_id', '==', targetEp.episode_id));
      const nonAdopted = subsSnap.docs.map(d => d.data())
        .filter(s => s.is_adopted !== true && s.is_adopted !== 'TRUE');
      if (nonAdopted.length > BRANCH_COPY_MAX) {
        return { ok: false, error: '이 단계는 제출물이 너무 많아 분기를 만들 수 없습니다.' };
      }

      const chargeable = _pointsApplicable(user_id);
      if (chargeable && (Number(uData.total_points) || 0) < 30) {
        return { ok: false, error: '포인트가 부족합니다. (필요: 30P, 보유: ' + (Number(uData.total_points) || 0) + 'P)' };
      }

      // ── write ──
      if (chargeable) {
        tx.update(uRef, _txPointFields(uData, -30));
        _txLedger(db, tx, user_id, -30, 'branch_create', '');
      }
      const leafDisplayStep = _calcDisplayStepBackend(st, Number(targetEp.step));
      const branch_display_offset = leafDisplayStep - (step - 1) + 1;
      tx.set(db.collection('stories').doc(new_story_id), {
        story_id: new_story_id, parent_story_id: story_id, branch_from_step: step,
        branch_episode_id: targetEp.episode_id,
        branch_leaf_episode_id: targetEp.episode_id,
        branch_display_offset,
        opening: st.opening, max_steps: st.max_steps || 10,
        current_step: step - 2, status: 'active', creator_id: user_id,
        created_at: nowIso,
        // 분기 시점의 참여자 수는 0부터 새로 세지 않고 원본의 누적값을 물려받음
        // (branch_display_offset이 단계 번호를 합산 기준으로 보여주는 것과 일관되게).
        participant_count: Number(st.participant_count) || 0, batch: '',
        // hot_score가 없는 문서는 자유 이야기 탭 orderBy 조회에서 아예 빠지므로 필수.
        hot_score: 0,
        open_steps: { [new_ep_id]: { step: step - 1, sub_count: nonAdopted.length } },
      });
      tx.set(db.collection('episodes').doc(new_ep_id), {
        episode_id: new_ep_id, story_id: new_story_id, step: step - 1,
        status: 'open', vote_total: 0, created_at: nowIso,
        closed_at: '', pending_at: '', parent_sub_id: '',
      });
      // 제출물 복사도 같은 트랜잭션 안에서 — sub_count와 실제 복사본 수가
      // 어긋날 수 없게 하고, 실패 시 분기 생성과 30p 차감까지 함께 롤백되게 한다.
      for (const sub of nonAdopted) {
        const sid = db.collection('submissions').doc().id;
        tx.set(db.collection('submissions').doc(sid), {
          ...sub, sub_id: sid, episode_id: new_ep_id, story_id: new_story_id,
          vote_count: 0, is_adopted: false, derived_from: '',
        });
      }
      return {
        ok: true,
        opening: st.opening || '',
        target_episode_id: targetEp.episode_id,
        authorIds: nonAdopted.map(s => s.author_id),
      };
    });
    if (!txResult.ok) return txResult;

    // 알림은 분기 생성의 부가 효과 — 실패해도 분기 결과를 뒤집지 않음(기존 정책).
    try {
      const votersSnap = await db.collection('votes').where('episode_id', '==', txResult.target_episode_id).get();
      const notifyIds = [...new Set([
        ...txResult.authorIds,
        ...votersSnap.docs.map(d => d.data().voter_id),
      ])].filter(id => id && id !== user_id);
      const snippet = (txResult.opening || '').slice(0, 15);
      const message = `"${snippet}..." 이야기의 ${step}단계에서 분기 챌린지가 시작됐어요!`;
      await _commitInChunks(db, notifyIds, (batch, uid) => {
        batch.set(db.collection('notifications').doc(), {
          user_id: uid, type: 'story_advance', story_id: new_story_id, message,
          is_read: false, created_at: admin.firestore.Timestamp.now(), push_sent: false,
        });
      });
    } catch (e) { console.error('branch notify error:', e.message); }

    return { ok: true, new_story_id };
  });

// ── 관리자 제출물 삭제 (기존 fbAdminDeleteSubmission) ────────
// adminEditSubmission과 동일한 게이트. rules 잠금 후에도 관리자 삭제가 동작해야
// 하므로 함께 이관한다(P0의 delete 규칙이 무투표·미채택만 허용해서, 관리자가
// 득표/채택된 글을 지우려 할 때 이미 막히던 잠재 회귀도 이걸로 함께 닫힘).
exports.adminDeleteSubmission = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const admin_id = data.user_id;
    const sub_id = data.sub_id;
    if (!admin_id || !sub_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(admin_id, data.token);
    if (admin_id !== FB_ADMIN_ID) throw new functions.https.HttpsError('permission-denied', '권한이 없습니다.');

    const db = admin.firestore();
    const subRef = db.collection('submissions').doc(sub_id);
    const subSnap = await subRef.get();
    await subRef.delete();

    if (subSnap.exists) {
      const sub = subSnap.data();
      try {
        await db.collection('stories').doc(sub.story_id).update({
          [`open_steps.${sub.episode_id}.sub_count`]: admin.firestore.FieldValue.increment(-1),
        });
      } catch (e) { console.error('admin delete sub_count error:', e.message); }
    }
    const [vSnap, cSnap, rSnap] = await Promise.all([
      db.collection('votes').where('sub_id', '==', sub_id).get(),
      db.collection('comments').where('sub_id', '==', sub_id).get(),
      db.collection('reports').where('sub_id', '==', sub_id).get(),
    ]);
    // 연관 문서가 많으면 단일 batch의 500-write 한도를 넘을 수 있어 청크 커밋.
    await _commitInChunks(db, [...vSnap.docs, ...cSnap.docs, ...rSnap.docs], (batch, d) => batch.delete(d.ref));
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
        report_count: 0, is_deleted: false,
      });
      tx.update(epRef, { status: 'closed', closed_at: new Date().toISOString() });

      const nextWinners = [...(st.cooldown_winners || []), author_id].slice(-5);
      const isLastStep = step >= (Number(st.max_steps) || 100);

      if (isLastStep) {
        tx.update(storyRef, {
          current_step: step, status: 'completed', completed_at: new Date().toISOString(), cooldown_winners: nextWinners,
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
      try { await _generateStoryTitle(db, result.story_id); } catch (e) { console.error('speedrun title generate error:', e.message); }
    }
    return result;
  });

// 초스피드 문장 추천 — "이어쓰기 센스가 좋았던 글"을 커뮤니티가 직접 더
// 보상해줄 수 있게 함(유저 제안, 2026-07-29). 3표 도달 시 원래 받은 포인트만큼
// 한 번 더 지급해서 총 2배가 되게 함(1회성).
// 원래는 비추 누적 시 "무효화"도 같이 있었는데, "무효가 한 번 뜨면 나중에
// 표가 바뀌어도 안 풀린다"는 규칙이 직관적이지 않아 혼란을 줌(유저 재지적,
// 2026-07-29 — 순추천 -2인데 여전히 무효로 표시된 걸 이상하게 여김). "추천은
// 보상, 신고는 제재"로 역할을 아예 분리하는 쪽으로 정리 — 비추/무효화 대신
// 아래 speedrunReport로 대체.
exports.speedrunUpvote = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
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
      // speedrunReport와 동일한 가드가 여기 빠져있었음(전수감사로 발견, 2026-08-19)
      // — 신고 3표로 이미 삭제 처리된 문장에도 추천이 계속 걸려서, 그 뒤 추천이
      // 3표 모이면 이미 삭제된 글의 작성자에게 보너스 포인트가 또 나갈 수 있었음.
      if (sub.is_deleted) return { ok: false, error: '이미 삭제된 문장이에요.' };
      // speedrunSubmit과 동일한 이유로 방어 — 범위 밖(일반 이야기) 문서에 쓰기가
      // 들어가지 않게 막아둠.
      const storySnap = await tx.get(db.collection('stories').doc(sub.story_id));
      if (!storySnap.exists || storySnap.data().mode !== 'speedrun') return { ok: false, error: '잘못된 요청입니다.' };

      const newUpCount = (Number(sub.upvote_count) || 0) + 1;
      tx.set(voteRef, { sub_id, voter_id, created_at: new Date().toISOString() });
      const willBonus = newUpCount >= 3 && !sub.upvote_bonus_given;
      const update = { upvote_count: newUpCount };
      if (willBonus) update.upvote_bonus_given = true;
      tx.update(subRef, update);
      return { ok: true, upvote_count: newUpCount, bonused: willBonus };
    });

    if (result.ok && result.bonused) {
      try { await _serverBonusSpeedrunPoints(admin.firestore(), sub_id); } catch (e) { console.error('speedrun upvote bonus error:', e.message); }
    }
    return result;
  });

// 문장 단위 신고(스토리 전체가 아니라 그 한 줄만) — 투표 필터가 없는 초스피드
// 특성상 스팸/의미없는 문장을 커뮤니티가 자체적으로 걸러내게 함. 신고 3표
// 누적 시 그 문장만 삭제 처리(is_deleted) — 예전 "비추 3표=무효화"와 동일한
// 임계값/그리는 방식(취소선+상태 배지)을 그대로 재사용하되, 방향성 있는
// 투표가 아니라 신고 전용이라 더 이상 "표가 바뀌면 풀릴 수 있는지" 자체가
// 헷갈릴 일이 없음. 결정적 doc ID(sub_id_voter_id)로 중복 신고 방지.
const SPEEDRUN_REPORT_THRESHOLD = 3;
exports.speedrunReport = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const sub_id = data.sub_id;
    const voter_id = data.user_id;
    if (!sub_id || !voter_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(voter_id, data.token);
    const db = admin.firestore();
    const subRef = db.collection('submissions').doc(sub_id);
    const reportRef = db.collection('submission_reports').doc(`${sub_id}_${voter_id}`);

    const result = await db.runTransaction(async tx => {
      const [subSnap, reportSnap] = await Promise.all([tx.get(subRef), tx.get(reportRef)]);
      if (!subSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
      if (reportSnap.exists) return { ok: false, error: '이미 신고했어요.' };
      const sub = subSnap.data();
      if (sub.author_id === voter_id) return { ok: false, error: '본인 글은 신고할 수 없습니다.' };
      if (sub.is_deleted) return { ok: false, error: '이미 삭제된 문장이에요.' };
      const storySnap = await tx.get(db.collection('stories').doc(sub.story_id));
      if (!storySnap.exists || storySnap.data().mode !== 'speedrun') return { ok: false, error: '잘못된 요청입니다.' };

      const newReportCount = (Number(sub.report_count) || 0) + 1;
      tx.set(reportRef, { sub_id, voter_id, created_at: new Date().toISOString() });
      const willDelete = newReportCount >= SPEEDRUN_REPORT_THRESHOLD;
      const update = { report_count: newReportCount };
      // deleted_at — 관리자 "신고 내역" 페이지에서 최신순 정렬용(2026-07-29 확장).
      if (willDelete) { update.is_deleted = true; update.deleted_at = new Date().toISOString(); }
      tx.update(subRef, update);
      return { ok: true, report_count: newReportCount, deleted: willDelete, hadBonus: sub.upvote_bonus_given === true };
    });

    if (result.ok && result.deleted) {
      const db2 = admin.firestore();
      try { await _serverReversePoints(db2, sub_id, 'speedrun_adopt', 'speedrun_report_delete'); } catch (e) { console.error('speedrun report point reversal error:', e.message); }
      if (result.hadBonus) {
        try { await _serverReversePoints(db2, sub_id, 'speedrun_upvote_bonus', 'speedrun_report_delete'); } catch (e) { console.error('speedrun report bonus reversal error:', e.message); }
      }
    }
    return result;
  });

// 무효화(-3)/보너스클로백 공용 — 강제 회수라 실패해선 안 되므로 잔액부족시
// throw하는 _fbSpendPoints와 달리 0으로 클램프(유저 확정: "이미 다른 데 써버렸어도
// 마이너스로 안 내려감"). point_ledger에서 원래 지급 건을 sub_id+reason으로
// 정확히 찾아서 반대 부호로 역분개. 원래 speedrun 전용이었는데 당신의 이야기
// (2026-08-18)도 신고 3표 삭제 시 동일한 회수 로직이 필요해져서 이름에서
// speedrun을 떼고 공용으로 승격.
async function _serverReversePoints(db, sub_id, sourceReason, reverseReason) {
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

// 1회성 관리자 콜러블 — 신고 방식 전환(2026-07-29) 이전, 비추 3표 무효화
// 규칙이 직관적이지 않다는 유저 지적으로 그 규칙 자체를 없앴는데, 이미 그
// 규칙 때문에 무효 처리됐던 문장을 유저가 직접 복구해달라고 요청함. is_
// invalidated/is_deleted 둘 다(구 무효화·신 신고삭제) 되돌리고, 그때 회수됐던
// 채택 포인트/추천 보너스를 point_ledger에서 찾아 다시 지급(감사기록 남김).
exports.adminReviveSpeedrunSubmission = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const sub_id = data.sub_id;
    if (!sub_id) return { ok: false, error: 'sub_id가 필요합니다.' };
    const db = admin.firestore();
    const subRef = db.collection('submissions').doc(sub_id);
    const subSnap = await subRef.get();
    if (!subSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
    const sub = subSnap.data();
    if (!sub.is_invalidated && !sub.is_deleted) return { ok: false, error: '이미 정상 상태예요.' };

    await subRef.update({ is_invalidated: false, is_deleted: false });

    const reversalSnap = await db.collection('point_ledger')
      .where('sub_id', '==', sub_id).where('reason', 'in', ['speedrun_invalidate', 'speedrun_report_delete']).get();
    let restored = 0;
    for (const doc of reversalSnap.docs) {
      const entry = doc.data();
      const amount = Math.abs(Number(entry.points) || 0);
      if (amount <= 0) continue;
      const uRef = db.collection('users').doc(entry.user_id);
      await db.runTransaction(async tx => {
        const uSnap = await tx.get(uRef);
        if (!uSnap.exists) return;
        const newTotal = (Number(uSnap.data().total_points) || 0) + amount;
        tx.update(uRef, { total_points: newTotal, badge: _serverCalcBadge(newTotal) });
        tx.set(db.collection('point_ledger').doc(), {
          user_id: entry.user_id, points: amount, reason: 'speedrun_invalidate_revert', sub_id, created_at: new Date().toISOString(),
        });
      });
      restored += amount;
    }
    return { ok: true, restored_points: restored };
  });

// 1회성 관리자 콜러블 — adminReviveSpeedrunSubmission의 반대 방향. 신고 3표가
// 자연 누적되길 기다릴 필요 없이 관리자가 즉시 삭제 처리하고 포인트도 회수할 때
// 콘솔에서 api('adminForceDeleteSpeedrunSubmission', {sub_id:'...'})로 직접
// 호출(2026-08-05, 테스트 목적으로 실수 게재된 초스피드 문장 처리 계기). 이미
// 회수된 건에 다시 걸면 중복 차감될 수 있어 point_ledger에 회수 기록이 있으면
// 막음.
exports.adminForceDeleteSpeedrunSubmission = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const sub_id = data.sub_id;
    if (!sub_id) return { ok: false, error: 'sub_id가 필요합니다.' };
    const db = admin.firestore();
    const subRef = db.collection('submissions').doc(sub_id);
    const subSnap = await subRef.get();
    if (!subSnap.exists) return { ok: false, error: '제출을 찾을 수 없습니다.' };
    const sub = subSnap.data();
    const alreadyReversed = await db.collection('point_ledger')
      .where('sub_id', '==', sub_id).where('reason', '==', 'speedrun_report_delete').limit(1).get();
    if (!alreadyReversed.empty) return { ok: false, error: '이미 포인트가 회수됐어요.' };
    if (!sub.is_deleted) await subRef.update({ is_deleted: true, deleted_at: new Date().toISOString() });
    await _serverReversePoints(db, sub_id, 'speedrun_adopt', 'speedrun_report_delete');
    if (sub.upvote_bonus_given === true) {
      await _serverReversePoints(db, sub_id, 'speedrun_upvote_bonus', 'speedrun_report_delete');
    }
    return { ok: true };
  });

// ─── 당신의 이야기 (참여형 아닌 익명 한 줄 일지, 2026-08-18) ───────────────
// 하루 1개(유저당), 30자, 익명, 추천/선정 없이 하트(순공감)+신고만. 신고 3표
// 도달 시 텍스트를 "신고에 의해 삭제된 댓글입니다."로 대체하고 지급됐던
// 10P를 회수(본인 삭제도 동일하게 회수). 익명이 핵심 요구사항인데 Firestore
// 규칙은 필드 단위로 user_id만 숨길 수 없어서(hint_rounds와 동일한 이유,
// firestore.rules 참고) 컬렉션 자체를 완전히 잠그고 아래 함수들이 클라이언트
// 응답에 user_id를 절대 포함하지 않음(mine/hearted처럼 계산된 값만 내려줌).
// 문서 ID를 `${kst날짜}_${user_id}`로 결정적으로 잡아서 "하루 1개"를 별도
// 카운터/쿼리 없이 존재 여부만으로 판정(submission_votes의 `${sub_id}_${voter_id}`
// 결정적 ID 패턴과 동일).
const YOUR_STORY_MAX_CHARS = 30;
const YOUR_STORY_REPORT_THRESHOLD = 3;

exports.submitYourStory = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    const text = (data.text || '').trim();
    if (!user_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);
    if (!text) return { ok: false, error: '내용을 입력해주세요.' };
    if (text.length > YOUR_STORY_MAX_CHARS) return { ok: false, error: `${YOUR_STORY_MAX_CHARS}자 이내로 작성해주세요.` };

    const db = admin.firestore();
    const kstToday = _kstDateStr(new Date().toISOString());
    const post_id = `${kstToday}_${user_id}`;
    const postRef = db.collection('your_story_posts').doc(post_id);
    const dayMetaRef = db.collection('your_story_day_meta').doc(kstToday);

    const result = await db.runTransaction(async tx => {
      const postSnap = await tx.get(postRef);
      if (postSnap.exists) return { ok: false, error: '오늘은 이미 남기셨어요.' };
      tx.set(postRef, {
        post_id, user_id, date: kstToday, text,
        heart_count: 0, report_count: 0, is_deleted: false, deleted_reason: '',
        created_at: new Date().toISOString(), edited_at: '',
      });
      // 날짜별 게시글 수 비정규화 — 달력에 "이 날짜에 글이 있다" 점 표시할 때
      // your_story_posts를 date로 스캔하지 않고 이 카운터 하나만 읽게 함
      // (초성힌트 participant_count와 동일한 이유).
      tx.set(dayMetaRef, { post_count: admin.firestore.FieldValue.increment(1) }, { merge: true });
      return { ok: true, post_id };
    });

    // _serverAddPoints는 자체 트랜잭션을 열어서 위 트랜잭션 안에서 재사용
    // 불가(speedrunSubmit과 동일 이유) — 성공 후 별도 호출.
    if (result.ok) await _serverAddPoints(db, user_id, 10, 'your_story_post', post_id);
    return result;
  });

exports.editYourStory = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    const text = (data.text || '').trim();
    if (!user_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);
    if (!text) return { ok: false, error: '내용을 입력해주세요.' };
    if (text.length > YOUR_STORY_MAX_CHARS) return { ok: false, error: `${YOUR_STORY_MAX_CHARS}자 이내로 작성해주세요.` };

    const db = admin.firestore();
    const kstToday = _kstDateStr(new Date().toISOString());
    // post_id를 클라이언트가 보내게 하지 않고 오늘 날짜+인증된 본인 user_id로
    // 서버가 직접 계산 — 남의 글 id를 넣어 수정 시도할 수 있는 여지 자체를 없앰.
    const postRef = db.collection('your_story_posts').doc(`${kstToday}_${user_id}`);
    const postSnap = await postRef.get();
    if (!postSnap.exists || postSnap.data().is_deleted) return { ok: false, error: '수정할 글을 찾을 수 없습니다.' };
    await postRef.update({ text, edited_at: new Date().toISOString() });
    return { ok: true };
  });

exports.deleteYourStory = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    if (!user_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);

    const db = admin.firestore();
    const kstToday = _kstDateStr(new Date().toISOString());
    const post_id = `${kstToday}_${user_id}`;
    const postRef = db.collection('your_story_posts').doc(post_id);
    const dayMetaRef = db.collection('your_story_day_meta').doc(kstToday);

    // 본인 삭제는 신고 삭제와 달리 완전히 지워버림(다른 콘텐츠처럼 남길 "흔적"이
    // 없는 단발성 콘텐츠라 소프트 삭제 이유가 없음) — 문서가 사라지므로 같은 날
    // 다시 쓸 수도 있게 됨(포인트도 아래에서 같이 회수되니 순증 없음, 실질적
    // 어뷰징 경로 아님).
    const result = await db.runTransaction(async tx => {
      const postSnap = await tx.get(postRef);
      if (!postSnap.exists) return { ok: false, error: '삭제할 글을 찾을 수 없습니다.' };
      tx.delete(postRef);
      tx.set(dayMetaRef, { post_count: admin.firestore.FieldValue.increment(-1) }, { merge: true });
      return { ok: true };
    });

    if (result.ok) await _serverReversePoints(db, post_id, 'your_story_post', 'your_story_self_delete');
    return result;
  });

exports.reportYourStory = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    const post_id = data.post_id;
    if (!user_id || !post_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);

    const db = admin.firestore();
    const postRef = db.collection('your_story_posts').doc(post_id);
    const reportRef = db.collection('your_story_reports').doc(`${post_id}_${user_id}`);

    const result = await db.runTransaction(async tx => {
      const [postSnap, reportSnap] = await Promise.all([tx.get(postRef), tx.get(reportRef)]);
      if (!postSnap.exists) return { ok: false, error: '글을 찾을 수 없습니다.' };
      if (reportSnap.exists) return { ok: false, error: '이미 신고했어요.' };
      const post = postSnap.data();
      if (post.user_id === user_id) return { ok: false, error: '본인 글은 신고할 수 없습니다.' };
      if (post.is_deleted) return { ok: false, error: '이미 삭제된 글이에요.' };

      const newReportCount = (Number(post.report_count) || 0) + 1;
      tx.set(reportRef, { post_id, user_id, created_at: new Date().toISOString() });
      const willDelete = newReportCount >= YOUR_STORY_REPORT_THRESHOLD;
      const update = { report_count: newReportCount };
      if (willDelete) { update.is_deleted = true; update.deleted_reason = 'report'; update.deleted_at = new Date().toISOString(); }
      tx.update(postRef, update);
      return { ok: true, report_count: newReportCount, deleted: willDelete };
    });

    if (result.ok && result.deleted) {
      try { await _serverReversePoints(db, post_id, 'your_story_post', 'your_story_report_delete'); }
      catch (e) { console.error('your_story report point reversal error:', e.message); }
    }
    return result;
  });

exports.toggleYourStoryHeart = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    const post_id = data.post_id;
    if (!user_id || !post_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);

    const db = admin.firestore();
    const postRef = db.collection('your_story_posts').doc(post_id);
    const heartRef = db.collection('your_story_hearts').doc(`${post_id}_${user_id}`);

    return db.runTransaction(async tx => {
      const [postSnap, heartSnap] = await Promise.all([tx.get(postRef), tx.get(heartRef)]);
      if (!postSnap.exists) return { ok: false, error: '글을 찾을 수 없습니다.' };
      const post = postSnap.data();
      if (post.user_id === user_id) return { ok: false, error: '본인 글에는 공감할 수 없습니다.' };
      const alreadyHearted = heartSnap.exists;
      const newCount = Math.max(0, (Number(post.heart_count) || 0) + (alreadyHearted ? -1 : 1));
      tx.update(postRef, { heart_count: newCount });
      if (alreadyHearted) tx.delete(heartRef);
      else tx.set(heartRef, { post_id, user_id, created_at: new Date().toISOString() });
      return { ok: true, heart_count: newCount, hearted: !alreadyHearted };
    });
  });

// 공개 피드 조회 — 비로그인도 열람 가능(user_id 없으면 mine/hearted는 항상
// false). user_id가 오면 그 계정 소유 확인까지 함(다른 사람 계정으로 mine/
// hearted를 훔쳐볼 수 없게).
exports.getYourStoryFeed = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const date = data.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new functions.https.HttpsError('invalid-argument', '잘못된 날짜입니다.');
    const db = admin.firestore();
    const kstToday = _kstDateStr(new Date().toISOString());
    if (date > kstToday) return { ok: false, error: '아직 오지 않은 날짜예요.' };

    const user_id = data.user_id;
    if (user_id) await _requireUser(user_id, data.token);

    const snap = await db.collection('your_story_posts').where('date', '==', date).orderBy('created_at', 'desc').limit(50).get();
    const posts = snap.docs.map(d => d.data());

    const myHearts = new Set();
    if (user_id && posts.length) {
      const ids = posts.map(p => p.post_id);
      const chunks = []; // Firestore 'in'은 최대 30개라 나눠서 조회
      for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
      const heartSnaps = await Promise.all(chunks.map(chunk =>
        db.collection('your_story_hearts').where('user_id', '==', user_id).where('post_id', 'in', chunk).get()));
      heartSnaps.forEach(s => s.docs.forEach(d => myHearts.add(d.data().post_id)));
    }

    return {
      ok: true,
      posts: posts.map(p => p.is_deleted
        ? { post_id: p.post_id, deleted: true, created_at: p.created_at }
        : {
            post_id: p.post_id, text: p.text, heart_count: p.heart_count || 0,
            created_at: p.created_at, edited: Boolean(p.edited_at),
            mine: Boolean(user_id) && p.user_id === user_id,
            hearted: myHearts.has(p.post_id),
          }),
    };
  });

// 카드의 ‹ › 가 넘겨보는 "내가 쓴 과거 글"만 — 오늘 것은 date/post_id로 이미
// 알 수 있어(클라이언트가 KST 오늘 날짜 계산) 제외.
exports.getMyYourStoryHistory = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const user_id = data.user_id;
    if (!user_id) throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    await _requireUser(user_id, data.token);
    const db = admin.firestore();
    const kstToday = _kstDateStr(new Date().toISOString());
    const [todaySnap, histSnap] = await Promise.all([
      db.collection('your_story_posts').doc(`${kstToday}_${user_id}`).get(),
      db.collection('your_story_posts').where('user_id', '==', user_id).orderBy('date', 'desc').limit(31).get(),
    ]);
    // 오늘 것도 같이 내려줘서(카드의 "오늘" 슬롯 표시용) 클라이언트가 별도
    // 호출을 안 하게 함 — 문서ID로 직접 읽어서 위 range 쿼리와 무관하게 항상 최신.
    const today = todaySnap.exists
      ? (todaySnap.data().is_deleted ? { deleted: true } : { text: todaySnap.data().text })
      : null;
    const history = histSnap.docs.map(d => d.data())
      .filter(p => p.date !== kstToday)
      .map(p => p.is_deleted ? { date: p.date, deleted: true } : { date: p.date, text: p.text });
    return { ok: true, today, history };
  });

// 날짜 달력 점 표시용 — your_story_posts를 직접 스캔하지 않고 위에서 이미
// 비정규화해둔 day_meta.post_count만 문서ID(=날짜) 범위쿼리로 읽음(추가
// 복합인덱스 불필요, 문서ID 단일필드 범위쿼리라 자동 인덱싱됨).
exports.getYourStoryMonthDots = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const from = data.from, to = data.to;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
      throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    }
    const db = admin.firestore();
    const snap = await db.collection('your_story_day_meta')
      .where(admin.firestore.FieldPath.documentId(), '>=', from)
      .where(admin.firestore.FieldPath.documentId(), '<=', to).get();
    const dates = snap.docs.filter(d => (d.data().post_count || 0) > 0).map(d => d.id);
    return { ok: true, dates };
  });

// 초스피드 전용 씨앗 생성 — _serverCreateSeedStory는 max_steps:10/vote_threshold:2가
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
// 완전 무작위(매 단계 독립 추첨)였더니 8개 장르 중 하나라 바로 앞 단계와
// 우연히 같은 장르가 뽑히는 경우가 꽤 흔했음(1/8 확률, 10단계면 한 번 이상
// 겹칠 확률이 더 높음) — "장르 전환"이 취지인 콘텐츠인데 안 바뀐 것처럼
// 보여서 유저 지적(2026-07-29). 직전 단계와 같은 장르는 후보에서 제외하고
// 뽑아서 인접 단계끼리는 항상 다른 장르가 되게 함.
function _serverRandomGenreSequence(steps) {
  const arr = [];
  for (let i = 0; i < steps; i++) {
    const prev = arr[i - 1];
    const pool = prev ? SPOTLIGHT_GENRES.filter(g => g !== prev) : SPOTLIGHT_GENRES;
    arr.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return arr;
}

// 장르전환은 fixed_ending과 달리 max_steps(10) 도달 시 강제완결이 없어서
// (유저가 "완결하기"를 눌러야만 끝남) 아무도 안 누르면 10단계 넘어서도
// 계속 진행될 수 있는데, genre_sequence가 정확히 10개짜리라 11단계부터는
// 장르가 undefined로 새서 조용히 기본값(미스터리)으로 표시되던 문제가
// 있었음(유저 지적, 2026-07-29) — 필요한 만큼 그때그때 늘려서 저장.
// 이어붙이는 규칙(직전 장르와 안 겹치게)은 _serverRandomGenreSequence와 동일.
function _serverExtendGenreSequence(seq, uptoLength) {
  const arr = (seq || []).slice();
  while (arr.length < uptoLength) {
    const prev = arr[arr.length - 1];
    const pool = prev ? SPOTLIGHT_GENRES.filter(g => g !== prev) : SPOTLIGHT_GENRES;
    arr.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return arr;
}

// ── MVP 공감 포인트 지급 ──────────────────────────────────────────
// 🔒 2026-08-27 보안방 긴급수정 — 완전 비활성화: 이 함수는 mvp_id만 받고
// 호출자 인증이 전혀 없었고, story_mvp 컬렉션도 클라이언트가 직접 쓸 수
// 있었음(firestore.rules 참고) — 그 결과 누구나 (1) story_mvp에 임의
// {nominated_user_id: 내계정, points_granted: false} 문서를 직접 만들고
// (2) 이 함수를 mvp_id만으로 호출하는 것을 반복해서 로그인조차 없이
// 무제한으로 포인트를 찍어낼 수 있었음(실제 재현 확인함). voteMvp(아래)로
// 완전히 대체됐고, 옛 클라이언트가 캐시돼 있다가 이 함수를 호출해도 절대
// 포인트가 나가지 않도록 본문 자체를 무력화함 — 삭제하지 않고 남겨둔 이유는
// Cloud Functions 삭제가 별도 배포 조작(functions:delete)이라 이 커밋만으론
// 실제로 안 지워지고, 무력화된 채로 남겨두는 편이 안전하기 때문.
exports.grantMvpPoints = functions
  .region('asia-northeast3')
  .https.onCall(async () => {
    return { ok: false, error: '이 기능은 더 이상 사용되지 않습니다.' };
  });

// ── MVP 선정 (Callable — 기존 fbVoteMvp의 검증 전부를 서버로 재구현) ──
// 🔒 2026-08-27 보안방: 기존엔 클라이언트(fbVoteMvp)가 검증(완결 여부/채택
// 문장 존재/본인글 아님/SYSTEM 아님/중복투표)을 먼저 하고 story_mvp 문서를
// 직접 만든 뒤 grantMvpPoints를 호출하는 구조였음 — story_mvp가 공개 쓰기라
// 이 클라이언트 검증을 통째로 우회할 수 있었음. 이제 검증·문서생성·포인트
// 지급·알림까지 전부 이 서버 함수 하나가 담당하고, story_mvp는 읽기 전용으로
// 잠갔음(firestore.rules 참고).
exports.voteMvp = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const story_id = data.story_id;
    const episode_id = data.episode_id;
    const voter_id = data.user_id;
    if (!story_id || !episode_id || !voter_id) {
      throw new functions.https.HttpsError('invalid-argument', '잘못된 요청입니다.');
    }
    await _requireUser(voter_id, data.token);

    const db = admin.firestore();
    const stSnap = await db.collection('stories').doc(story_id).get();
    if (!stSnap.exists) return { ok: false, error: '이야기를 찾을 수 없습니다.' };
    const st = stSnap.data();
    if (st.status !== 'completed' && st.status !== 'inactive') {
      return { ok: false, error: '완결된 이야기에서만 가능합니다.' };
    }

    const subSnap = await db.collection('submissions')
      .where('episode_id', '==', episode_id).where('is_adopted', '==', true).limit(1).get();
    if (subSnap.empty) return { ok: false, error: '채택된 문장을 찾을 수 없습니다.' };
    const sub = subSnap.docs[0].data();
    if (sub.author_id === voter_id) return { ok: false, error: '본인 글에는 공감할 수 없습니다.' };
    if (!sub.author_id || sub.author_id === 'SYSTEM') return { ok: false, error: '공감할 수 없는 글입니다.' };
    const nominated_user_id = sub.author_id;

    // story_id+voter_id 결정적 ID로 신규 중복(동시요청 포함)을 트랜잭션 안에서
    // 원자적으로 막고, story_mvp가 공개 쓰기였던 시절 만들어진 랜덤 ID 문서(기존
    // fbVoteMvp가 fbGenId()로 생성)까지 같이 조회해서 과거 데이터로도 중복
    // 방지가 되게 함.
    const mvpRef = db.collection('story_mvp').doc(`${story_id}_${voter_id}`);
    const legacyDupQuery = db.collection('story_mvp')
      .where('story_id', '==', story_id).where('voter_id', '==', voter_id).limit(1);
    const grantPoints = nominated_user_id !== FB_ADMIN_ID && nominated_user_id !== FB_AI_ID;
    const nomineeRef = grantPoints ? db.collection('users').doc(nominated_user_id) : null;

    const result = await db.runTransaction(async tx => {
      // Firestore 트랜잭션 규칙상 모든 읽기가 쓰기보다 먼저 와야 해서 한 번에 모음.
      const [mvpSnap, legacyDupSnap, nomineeSnap] = await Promise.all([
        tx.get(mvpRef),
        tx.get(legacyDupQuery),
        nomineeRef ? tx.get(nomineeRef) : Promise.resolve(null),
      ]);
      if (mvpSnap.exists || !legacyDupSnap.empty) {
        return { ok: false, error: '이미 으뜸 글을 선정하셨습니다.' };
      }

      tx.set(mvpRef, {
        story_id, voter_id, nominated_user_id, episode_id,
        created_at: new Date().toISOString(), points_granted: true,
      });

      // 기존 _serverAddPoints는 자체 트랜잭션을 열어서 이 트랜잭션 안에서 재사용
      // 불가(submitYourStory 등과 동일한 이유) — 동일한 total_points/badge/
      // point_ledger 형식을 여기서 직접 재현해 문서생성과 원자적으로 묶음.
      if (grantPoints && nomineeSnap && nomineeSnap.exists) {
        const newTotal = (nomineeSnap.data().total_points || 0) + 10;
        tx.update(nomineeRef, { total_points: newTotal, badge: _serverCalcBadge(newTotal) });
        tx.set(db.collection('point_ledger').doc(), {
          user_id: nominated_user_id, points: 10, reason: 'mvp_nomination', sub_id: '',
          created_at: new Date().toISOString(),
        });
      }

      // 알림도 같은 트랜잭션에 묶어서 처리 — 기존 fbVoteMvp도 관리자/AI 여부와
      // 무관하게 항상 보냈던 것과 동일하게 무조건 생성(AI/관리자 계정은 어차피
      // 알림을 안 봄, 기존 동작 그대로 유지).
      const snippet = (st.opening || '').slice(0, 20);
      tx.set(db.collection('notifications').doc(), {
        user_id: nominated_user_id, type: 'story_advance', story_id,
        message: `"${snippet}…" 이야기에서 내 글이 으뜸 글로 선정됐어요! +10P`,
        is_read: false, created_at: admin.firestore.Timestamp.now(), push_sent: false,
      });

      return { ok: true };
    });

    return result;
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
  const referralBonusUserIds = new Set();
  ledgerSnap.docs.forEach(d => {
    const p = d.data();
    if (p.reason === 'daily_login' && isReal(p.user_id)) activeIds.add(p.user_id);
    // 친구초대(추천인 닉네임 입력) 보너스 — 신규가입자 쪽과 기존 추천인 쪽 둘 다
    // reason:'referral_bonus'로 찍힘. new_user_ids와 교집합만 취하면 "그날
    // 가입자 중 실제로 지인 추천으로 들어온 사람" 수가 자연히 나옴(추천인은
    // 그날 신규가입자가 아니므로 자동 제외됨).
    if (p.reason === 'referral_bonus' && p.user_id) referralBonusUserIds.add(p.user_id);
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

  const referred_new_users_count = new_user_ids.filter(id => referralBonusUserIds.has(id)).length;

  await db.collection('analytics_daily').doc(kstDateStr).set({
    date: kstDateStr,
    visitors_unique, visitors_total,
    new_users_count: new_user_ids.length, new_user_ids,
    referred_new_users_count,
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

// stories/submissions 총 개수(관리자 통계용, 2026-08-10 추가). fbGetAdminStats가
// 예전엔 두 컬렉션 전체를 .get()으로 읽어와 .size만 썼는데(스토리 266+제출 2243건,
// 계속 커짐), users는 referral_stats 집계 때문에 어차피 문서 전체가 필요해 그대로
// 두고, count()만으로 충분한 두 컬렉션만 이 콜러블로 분리 — compat SDK는 count()
// 집계를 지원 안 해서(2026-07-04 검증) 클라이언트에서 직접 부를 수 없음(Admin SDK 전용).
exports.adminGetCollectionCounts = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const [storiesCount, submissionsCount] = await Promise.all([
      db.collection('stories').count().get(),
      db.collection('submissions').count().get(),
    ]);
    return {
      ok: true,
      story_count: storiesCount.data().count || 0,
      submission_count: submissionsCount.data().count || 0,
    };
  });

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
        // 방문자→가입 전환율 — 그날 순방문자(visitors_unique, localStorage 기반이라
        // 기기/브라우저 바뀌면 중복 집계될 수 있는 근사치) 대비 그날 신규가입자 비율.
        // 같은 사람이 방문한 날과 가입한 날이 다를 수 있어 완벽한 코호트 전환율은
        // 아니지만, 이미 있는 두 값의 비율이라 별도 계측 없이 추이 파악엔 충분함.
        visitor_signup_conversion_pct: v.visitors_unique
          ? +((v.new_users_count || 0) / v.visitors_unique * 100).toFixed(2) : null,
        // 그날 신규가입자 중 실제 "추천인 닉네임" 입력으로 친구초대 보너스를
        // 받은 사람 수/비율 — 자기신고형 "가입경로" 칩과 달리 검증된 진짜
        // 지인추천 신호. 이 비율이 올라가는 추세면 입소문이 붙기 시작한 것.
        referred_new_users_count: v.referred_new_users_count || 0,
        referred_signup_pct: v.new_users_count
          ? +((v.referred_new_users_count || 0) / v.new_users_count * 100).toFixed(1) : null,
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
      일별_방문자_가입전환율_퍼센트: _trendSummary(dates, series.map(d => d.visitor_signup_conversion_pct || 0)),
      일별_친구추천가입_비율_퍼센트: _trendSummary(dates, series.map(d => d.referred_signup_pct || 0)),
      최근_신규가입_리텐션_코호트: cohorts.slice(-4),
      최근_가입후_첫활동_전환_코호트: activationCohorts.slice(-4),
      최근_이야기_완주_코호트: storyCohorts.slice(-4),
      가입경로별_정착도: referralBreakdown,
      누적_가입자_대비_글쓴유저_및_완주율_및_누적업적수: lifetime,
    };

    const prompt = `다음은 협업 릴레이소설 서비스 "화씨.방" 관리자 애널리틱스 대시보드의 최근 추이 요약(JSON)입니다. 운영자가 참고할 수 있도록 지표별로 간결한 한국어 분석 의견을 1~2문장씩 작성해주세요. 숫자를 그대로 반복하지 말고, 증가/감소 흐름과 그 의미, 주목할 점, 필요하면 짧은 제안을 담아주세요. change_pct가 null이거나 표본(n)이 작은 지표는 그 한계도 짧게 언급하세요. "가입후_첫활동_전환"은 리텐션(다시 돌아오는지)과 다르게 "애초에 한 번이라도 참여해봤는지"를 뜻합니다. "부문별_참여"는 최근 대규모 콘텐츠 업그레이드로 추가된 초성힌트/초스피드/장르전환/결말고정/동화각색을 포함해 그날 참여가 어디에 몰렸는지를 뜻합니다(레거시 스포트라이트는 옛 슬롯 방식으로 지금은 신규 발생이 없음). "일별_업적달성건수"는 유저들이 뱃지(업적)를 새로 획득한 건수 추이입니다. "일별_방문자_가입전환율_퍼센트"는 그날 방문자 수 대비 그날 신규가입자 비율로, 2026-07-28에 있었던 대규모 콘텐츠 업그레이드(초성힌트/초스피드/장르전환/결말고정/동화각색 5종 신설) 전후로 변화가 있었는지 특히 주목해서 언급해주세요. "일별_친구추천가입_비율_퍼센트"는 그날 신규가입자 중 실제로 기존 유저의 추천인 닉네임을 입력해 친구초대 보너스를 받은 사람 비율(자기신고 아닌 검증된 지인추천 신호)로, 이 비율이 추세적으로 올라가는지가 홍보 없이 입소문만으로 성장이 붙기 시작했는지의 핵심 지표입니다.

${JSON.stringify(summary)}

다른 설명 없이 아래 키를 가진 JSON 객체 하나만 출력하세요:
{"overall":"...", "visitors":"...", "cumulative_users":"...", "writers":"...", "votes":"...", "word_challenge":"...", "dau":"...", "stickiness":"...", "retention":"...", "cohorts":"...", "activation":"...", "story_completion":"...", "referral":"...", "sections":"...", "achievements":"...", "conversion":"...", "word_of_mouth":"..."}`;

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

// 일별 기기 종류(모바일/PC/태블릿) 분포 — 자체 데이터엔 기기 정보가 전혀
// 없어서 GA4의 자동 수집 dimension(deviceCategory)을 그대로 씀. GA4는
// (date, deviceCategory) 조합별로 한 행씩 반환하므로 날짜별로 다시 묶어줌.
exports.getGa4DeviceTrend = functions
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

    const byDate = {};
    try {
      const { BetaAnalyticsDataClient } = require('@google-analytics/data');
      const client = new BetaAnalyticsDataClient({ credentials });
      const [reportResponse] = await client.runReport({
        property: `properties/${s.ga4_property_id}`,
        dateRanges: [{ startDate: start_date, endDate: end_date }],
        dimensions: [{ name: 'date' }, { name: 'deviceCategory' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      });
      (reportResponse.rows || []).forEach(row => {
        const raw = row.dimensionValues[0].value; // 'YYYYMMDD'
        const dateStr = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
        const device = (row.dimensionValues[1].value || 'other').toLowerCase(); // mobile/desktop/tablet/(그 외 smart tv 등은 other로)
        const users = Number(row.metricValues[0].value) || 0;
        if (!byDate[dateStr]) byDate[dateStr] = { date: dateStr, mobile: 0, desktop: 0, tablet: 0, other: 0 };
        if (device in byDate[dateStr]) byDate[dateStr][device] += users;
        else byDate[dateStr].other += users;
      });
    } catch (e) {
      return { ok: false, error: 'GA4 조회 실패: ' + e.message };
    }

    const series = Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
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
    // 시작 쪽(_serverStartWordChallenge)엔 "이미 진행 중이면 중복 생성 방지"
    // 트랜잭션 가드가 있는데(2026-07-09 관리자 중복클릭 실사고로 추가됨),
    // 마감 쪽엔 이 가드가 없었음 — 21시 스케줄과 관리자 강제마감이 겹치거나
    // Cloud Functions 재시도가 겹치면 같은 라운드가 두 번 마감돼 포인트가
    // 중복 지급될 수 있었음(디버그방 감사 발견, 2026-07-30). 무거운 집계(투표
    // 계산·닉네임 조회) 전에 먼저 소유권을 트랜잭션으로 확정 —
    // closeSentenceRounds와 동일한 claim 관용구.
    const claimed = await db.runTransaction(async tx => {
      const snap = await tx.get(doc.ref);
      if (!snap.exists || snap.data().status !== 'active') return false;
      tx.update(doc.ref, { status: 'closed', closed_at: new Date().toISOString() });
      return true;
    });
    if (!claimed) continue;

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

    const patch = { submission_count: subsSnap.size, winners: [] };
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
// adminInitSpotlight) — 그래서 vote_threshold를 고정으로 넣어도 안전함.
// 원래 5였던 이유: 관심이 몰려 표가 너무 빨리 차서 한 단계가 순식간에
// 지나가버리는 걸 막기 위해 일반 이야기(기본 3표, FB_VOTE_THRESHOLD/
// AI_VOTE_THRESHOLD)보다 높게 잡았던 것. 그런데 지금은 반대로 3표조차
// 잘 안 채워질 만큼 투표량이 적어서, 5로 두면 오히려 진행이 지나치게
// 느려짐 — 유저 판단으로 3으로 되돌림(2026-08-03), 그마저도 회전이 느리다고
// 판단해 2로 추가 하향(2026-08-17). 나중에 투표량이 다시 늘어나면 재조정 검토.
function _serverCreateSeedStory(db, writer, opening, extraFields) {
  const story_id = db.collection('stories').doc().id;
  const episode_id = db.collection('episodes').doc().id;
  writer.set(db.collection('stories').doc(story_id), {
    story_id, opening: opening.trim(), max_steps: 10, current_step: 0,
    status: 'active', creator_id: FB_AI_ID, creator_nickname: '익명', creator_badge: '',
    created_at: new Date().toISOString(), batch: '', participant_count: 0, like_count: 0,
    is_ai_seed: true, vote_threshold: 2,
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

// slotKey('word'|'fairytale')의 풀에 새 항목이 막 쌓였을 때, 그 슬롯이 마침 비어있는
// 상태(story_id==null)였다면 바로 채워줌 — _serverCloseWordChallenge(슬롯1 풀 적재
// 직후)에서 호출. 이 호출 시점엔 슬롯이 이미 story_id==null 상태로 놓여 있었을
// 때만 의미가 있어(그 외엔 손대지 않고 조용히 반환), _serverRefillSpotlightSlot과
// 트랜잭션이 겹칠 일이 없음. ('sentence' 분기는 slotKey 폐지(2026-07-28)와
// closeSentenceRounds 삭제(2026-07-29)로 더는 호출되지 않는 죽은 코드.)
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
  // 풀 소진 시 true/false를 돌려줘야(2026-08-09 유저 지적) adminForceStartHintRound가
  // "성공"으로 잘못 표시하지 않음 — 관리자가 등록 없이 바로 시작 버튼만 눌렀다가
  // 아무 반응 없이 조용히 실패했는데 성공 토스트가 떠서 헷갈렸던 사례로 발견.
  return await db.runTransaction(async tx => {
    const activeSnap = await tx.get(db.collection('hint_rounds').where('status', '==', 'active').limit(1));
    activeSnap.docs.forEach(d => tx.update(d.ref, { status: 'closed', closed_at: now.toISOString() }));

    // where(used==false)로 직접 걸러야 함 — orderBy(created_at)+limit(50)로 앞에서부터
    // 훑어 client-side로 필터링하던 옛 방식은, 이 이벤트가 몇 주째 돌면서 이미 사용된
    // 오래된 문장이 50개를 넘게 쌓이자 새로 등록한(더 최근 created_at인) 미사용 문장이
    // 항상 그 50개 밖으로 밀려나 영영 안 보이는 버그였음(2026-08-09 — 새 문장을 등록해도
    // "지금 바로 새 라운드 시작"이 계속 조용히 아무 일도 안 하던 원인).
    const poolSnap = await tx.get(db.collection('hint_pool').where('used', '==', false).orderBy('created_at', 'asc').limit(1));
    const nextEntry = poolSnap.docs[0];
    if (!nextEntry) return false; // 풀 소진 — 관리자가 채울 때까지 그냥 공백으로 둠(word/fairytale 슬롯과 동일 원칙)

    tx.update(nextEntry.ref, { used: true });
    const roundRef = db.collection('hint_rounds').doc();
    const text = nextEntry.data().text;
    tx.set(roundRef, {
      round_id: roundRef.id, text, hint: _serverToChoseong(text),
      status: 'active', start_at: now.toISOString(), end_at: '',
      winner_user_id: null, winner_nickname: null, winner_submission_id: null, winner_text: null,
      points: HINT_GUESS_POINTS, closed_at: null, participant_count: 0,
    });
    return true;
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

// 아무도 못 맞힌 라운드는 다음 라운드가 시작되는 순간(_serverStartHintRound가
// 같은 트랜잭션에서 옛 라운드 닫기+새 라운드 열기를 동시에 함) 곧바로
// 새 라운드에 가려져서 정답을 아무도 못 보고 지나가고 있었음(유저 지적,
// 2026-07-29 — "정답자 없을 때 룰 안 정했지 우리?"). 다음 라운드 10분
// 전에 먼저 "실패" 처리해서, 그 10분 동안은 정답이 공개된 채로 보이게 함.
async function _serverFailHintRoundIfUnsolved(db) {
  const snap = await db.collection('hint_rounds').where('status', '==', 'active').limit(1).get();
  if (snap.empty) return; // 이미 누군가 맞혀서 닫혔거나(정상 종료), 애초에 라운드가 없음
  await snap.docs[0].ref.update({ status: 'closed', closed_at: new Date().toISOString(), failed: true });
}
exports.failHintRound0750 = functions.region('asia-northeast3').pubsub.schedule('every day 07:50').timeZone('Asia/Seoul').onRun(async () => { await _serverFailHintRoundIfUnsolved(admin.firestore()); return null; });
exports.failHintRound0950 = functions.region('asia-northeast3').pubsub.schedule('every day 09:50').timeZone('Asia/Seoul').onRun(async () => { await _serverFailHintRoundIfUnsolved(admin.firestore()); return null; });
exports.failHintRound1150 = functions.region('asia-northeast3').pubsub.schedule('every day 11:50').timeZone('Asia/Seoul').onRun(async () => { await _serverFailHintRoundIfUnsolved(admin.firestore()); return null; });
exports.failHintRound1350 = functions.region('asia-northeast3').pubsub.schedule('every day 13:50').timeZone('Asia/Seoul').onRun(async () => { await _serverFailHintRoundIfUnsolved(admin.firestore()); return null; });
exports.failHintRound1550 = functions.region('asia-northeast3').pubsub.schedule('every day 15:50').timeZone('Asia/Seoul').onRun(async () => { await _serverFailHintRoundIfUnsolved(admin.firestore()); return null; });
exports.failHintRound1750 = functions.region('asia-northeast3').pubsub.schedule('every day 17:50').timeZone('Asia/Seoul').onRun(async () => { await _serverFailHintRoundIfUnsolved(admin.firestore()); return null; });

// 테스트/부트스트랩용 — 콘솔에서 수동 트리거
exports.adminForceStartHintRound = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const started = await _serverStartHintRound(admin.firestore());
    if (!started) return { ok: false, error: '대기 중인 씨앗 문장이 없어요. 먼저 문장을 등록해주세요.' };
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
      return { ok: true, round: { ...base, text: r.text, winner_user_id: r.winner_user_id, winner_nickname: r.winner_nickname, winner_text: r.winner_text, failed: r.failed || false } };
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


// ─── 훔쳐본 일기장 (읽기 전용 분기형 다이어리, 2026-08-11 도입) ──────────
// 2026-08-19 보안방: 원래 이 데이터가 bang/index.html에 7권 전체가 통째로
// 인라인돼 있었음 — 화면 잠금(_dhIsUnlocked, releaseDate 비교)은 정상 작동
// 했지만, 그건 UI에서 안 보여줄 뿐이고 콘텐츠 자체는 이미 모든 방문자의
// 브라우저로 다운로드되고 있었음. "페이지 소스 보기"나 개발자도구 콘솔에서
// DIARY_STORY_DATA[4] 한 줄만 쳐도 몇 주 뒤 공개 예정인 회차까지 전문이
// 그대로 노출됨을 실제로 재현 확인함(9/16 공개 예정인 7권까지 포함). 계정
// 탈취류는 아니지만 "매주 수요일 한 권씩 공개"라는 콘텐츠 자체의 조기유출
// 문제라, hint_rounds(정답)/your_story_posts(익명성)와 동일한 원칙으로
// 서버 전용으로 옮김 — 아래 데이터는 클라이언트 어디에도 존재하지 않고
// getDiaryBook 콜러블을 통해 공개일 도래 후에만 내려줌.
//
// DIARY_RELEASE_DATES는 bang/index.html의 DIARY_HUB_BOOKS와 releaseDate가
// 반드시 일치해야 함(책장 UI 잠금 표시와 실제 서버 게이트가 어긋나면 안 됨)
// — 새 회차 추가/일정 변경 시 두 곳 다 같이 수정할 것.
const DIARY_RELEASE_DATES = {
  1: null,
  2: '2026-08-12',
  3: '2026-08-19',
  4: '2026-08-26',
  5: '2026-09-02',
  6: '2026-09-09',
  7: '2026-09-16',
};

const DIARY_STORY_DATA = {
  1: {
    title: '첫 번째 일기',
    theme: 1,
    startNodeId: 'start',
    nodes: {
      start: { dateLabel: '8월 3일', paragraphs: [
        '형사가 두 번째로 찾아왔다. 이번엔 명함을 건네지 않았다. 대신 물었다. "그날 저녁 6시부터 9시, 어디 계셨어요?"',
        '나는 대답 대신 창밖을 봤다. 정원의 감나무가 그대로였다. 지수가 없어진 지 나흘째인데, 저 나무는 아무것도 모른다는 듯 잎을 늘어뜨리고 있었다.',
        '형사는 기다렸다. 나는 그 세 시간 동안 어디 있었는지 정확히 알고 있었다. 문제는 그걸 말할 수 있느냐였다.',
        '"말씀하시기 곤란한 일이라도?" 형사가 물었다.',
        '시계 초침 소리가 유난히 크게 들렸다.',
      ], choices: [
        { label: '사실대로 말한다', nextNodeId: 'truth-1' },
        { label: '거짓말한다', nextNodeId: 'lie-1' },
        { label: '변호사 없이는 답하지 않겠다고 한다', nextNodeId: 'silent-1' },
      ] },
      'truth-1': { paragraphs: [
        '나는 숨을 골랐다. "그 시간에 저는… 정우 씨 집에 있었어요."',
        '형사의 눈썹이 움직였다. 정우는 내 오랜 친구이자, 지수의 약혼자였다. 그 사실을 말하는 순간 내가 무슨 짓을 했는지가 아니라, 무슨 사이인지부터 의심받게 될 거란 걸 알고 있었다.',
        '"확인해봐도 되겠죠?" 형사가 물었다.',
        '나는 고개를 끄덕였다. 하지만 정우에게 연락은 하지 않았다. 그가 뭐라고 말할지, 확신이 서지 않았기 때문이다.',
        '다음 날, 형사가 다시 왔다. "정우 씨는 그날 혼자 집에 있었다고 하던데요."',
        '내 알리바이가 무너지는 소리였다.',
      ], choices: [
        { label: '정우에게 직접 확인해달라고 부탁한다', nextNodeId: 'truth-ask' },
        { label: '아무 말도 하지 않는다', nextNodeId: 'truth-silent' },
        { label: '다른 증거를 스스로 찾아 제시한다', nextNodeId: 'truth-evidence' },
      ] },
      'truth-ask': { dateLabel: '8월 4일', paragraphs: [
        '나는 정우의 회사 앞에서 그를 기다렸다. 그는 나를 보고도 걸음을 멈추지 않았다.',
        '"왜 거짓말했어?" 내가 물었다.',
        '그는 한참 후에야 입을 열었다. "내가 그날 너랑 있었다고 하면… 지수 부모님이 뭐라고 생각하시겠어. 실종된 딸 약혼자가, 그 날 다른 여자랑 있었다고?"',
        '나는 그 말이 틀리지 않다는 걸 알았다. 그래서 더 화가 났다.',
        '"그럼 내가 대신 의심받으라고?"',
        '정우는 대답하지 않았다. 대신 다음 날, 그는 형사에게 진술을 정정했다. 내 알리바이는 증명됐다.',
        '그런데 그가 돌아서던 순간, 셔츠 소매 아래로 얼핏 보인 손등의 상처가 눈에 걸렸다. 언제 다친 거냐고 물으니, 그는 못 들은 척 화제를 돌렸다.',
      ], choices: [
        { label: '그 위화감을 캐묻는다', nextNodeId: 't-end-a' },
        { label: '그냥 넘어간다', nextNodeId: 't-end-b' },
        { label: '형사에게 그 사실을 알린다', nextNodeId: 't-end-c' },
      ] },
      'truth-silent': { dateLabel: '9월 초', paragraphs: [
        '나는 아무 말도 하지 않았다. 정우가 거짓말한 이유를 굳이 캐묻지 않기로 했다. 그를 곤란하게 만들고 싶지 않아서였는지, 아니면 그의 거짓말 뒤에 숨은 이유를 알고 싶지 않아서였는지는 나도 확신할 수 없었다.',
        '형사는 나를 계속 지켜봤다. 확실한 증거는 없었지만, 확실한 알리바이도 없었다.',
        '그렇게 몇 주가 흘렀다. 사건은 풀리지 않았고, 나는 여전히 용의선상에 있었다.',
        '그러던 어느 날, 정우에게서 오랜만에 메시지가 왔다. "얘기 좀 하자."',
      ], choices: [
        { label: '정우의 연락에 답한다', nextNodeId: 't-end-a' },
        { label: '계속 답장하지 않는다', nextNodeId: 't-end-d' },
        { label: '이사를 준비한다', nextNodeId: 't-end-e' },
      ] },
      'truth-evidence': { dateLabel: '8월 5일', paragraphs: [
        '나는 그날 저녁 들렀던 카페 영수증을 찾아냈다. 시간까지 정확히 찍혀 있었다.',
        '형사에게 그걸 보여주자, 그는 별다른 말 없이 수첩에 뭔가를 적었다. "이걸로 확인은 되네요. 근데 왜 진작 말씀 안 하셨어요?"',
        '나는 대답하지 않았다. 영수증에는 시간만 찍혀 있었지, 내가 누구와 함께 있었는지는 나오지 않았으니까.',
        '사실 그 카페에 함께 있었던 건 정우였다. 영수증은 결백을 증명했지만, 정우와 있었다는 사실 자체는 여전히 나만 아는 비밀로 남아 있었다.',
        '형사가 돌아간 뒤, 나는 그 비밀을 어떻게 할지 생각했다.',
      ], choices: [
        { label: '정우와의 일은 끝까지 숨긴다', nextNodeId: 't-end-f' },
        { label: '그래도 정우에게는 사실대로 말해준다', nextNodeId: 't-end-b' },
        { label: '형사에게 모든 걸 솔직히 말한다', nextNodeId: 't-end-c' },
      ] },
      'lie-1': { paragraphs: [
        '"집에 혼자 있었어요." 나는 말했다. 목소리가 떨리지 않아서 스스로도 놀랐다.',
        '형사는 수첩에 뭔가를 적었다. "누가 확인해 줄 수 있는 분 있으세요?"',
        '"아니요. 혼자였으니까요."',
        '거짓말은 쉬웠다. 진짜 그 시간에 내가 있던 곳을 떠올리지 않으려고만 하면 됐다.',
        '사흘 뒤, 형사가 다시 찾아왔다. 이번엔 표정이 달랐다. "그날 저녁, 이 근처 편의점 CCTV에 찍힌 분이 있던데요."',
        '내가 아는 얼굴이 화면 속에 있었다. 편의점 아르바이트생이 나를 기억하고 있었던 것이다.',
      ], choices: [
        { label: '더 그럴듯한 거짓말로 덮는다', nextNodeId: 'lie-coverup' },
        { label: '사실은 거짓말이었다고 자백한다', nextNodeId: 'lie-confess' },
        { label: '자리를 피해 잠적한다', nextNodeId: 'lie-flee' },
      ] },
      'lie-coverup': { dateLabel: '8월 11일', paragraphs: [
        '"아, 잠깐 나갔었네요. 깜빡했어요. 근처 편의점에 담배 사러요." 나는 태연하게 말했다.',
        '형사는 별말 없이 수첩을 덮었다. 넘어간 줄 알았다.',
        "일주일 후, 지수의 휴대폰이 발견됐다. 마지막으로 접속된 기지국 위치가 하필 내가 '깜빡했다'고 둘러댄 그 시간, 그 동네였다.",
        '형사가 나를 정식으로 불렀다. 이번엔 변호사를 대동하라고 했다.',
        '변호사는 내 얘기를 다 듣고서 말했다. "지금부터가 진짜 중요해요. 어떻게 하실 거예요?"',
      ], choices: [
        { label: '변호사 조언대로 끝까지 부인한다', nextNodeId: 'l-end-a' },
        { label: '결국 무너져 자백한다', nextNodeId: 'l-end-b' },
        { label: '다른 사람에게 뒤집어씌운다', nextNodeId: 'l-end-c' },
      ] },
      'lie-confess': { dateLabel: '8월 7일', paragraphs: [
        '"거짓말이었어요." 나는 말했다. 형사의 눈이 커졌다.',
        '"그날 저는… 지수 몰래, 지수 언니를 만나고 있었어요. 지수 모르게 돈을 빌리는 중이었거든요. 부끄러워서 말 못했어요."',
        '형사는 한참 나를 보다가 말했다. "진작 말씀하셨어야죠."',
        '내 알리바이는 확인됐다. 부끄러운 사정이었지만, 범죄는 아니었다.',
        '혐의를 벗은 날, 지수 언니에게서 문자가 왔다. "너 때문에 나까지 조사받았잖아."',
      ], choices: [
        { label: '지수 언니에게 사과 편지를 쓴다', nextNodeId: 'l-end-d' },
        { label: '그냥 관계를 정리하고 만다', nextNodeId: 'l-end-e' },
        { label: '빌린 돈 문제를 뒤늦게 해결하려 한다', nextNodeId: 'l-end-d' },
      ] },
      'lie-flee': { dateLabel: '8월 9일', paragraphs: [
        '나는 짐을 챙겨 무작정 고속버스에 올랐다. 어디로 가는지도 정하지 않았다.',
        '낯선 동네의 낯선 숙소에서, 나는 매일 뉴스를 확인했다. 내 이름이 나올까 봐.',
        '사흘째 되던 날, 형사에게서 문자가 왔다. "연락 주세요. 상황 안 좋아집니다."',
        '휴대폰 화면을 오래 들여다봤다. 돌아가는 것도, 여기 계속 있는 것도 다 무서웠다.',
      ], choices: [
        { label: '결국 스스로 돌아와 자백한다', nextNodeId: 'l-end-b' },
        { label: '끝까지 숨어 지낸다', nextNodeId: 'l-end-c' },
        { label: '가족에게 연락해 도움을 요청한다', nextNodeId: 'l-end-f' },
      ] },
      'silent-1': { paragraphs: [
        '"변호사 없이는 답하지 않겠습니다." 나는 말했다. 내 목소리가 낯설게 들릴 만큼 딱딱했다.',
        '형사는 잠깐 나를 보다가 수첩을 덮었다. "그러시죠. 다만 보통 그런 말씀은…" 그는 문장을 끝맺지 않았다. 끝맺지 않아도 알 수 있는 말이었다.',
        '그날 저녁, 옆집 아주머니가 마당 너머로 나를 흘깃거렸다. 하루 만에 동네에 뭔가 퍼진 모양이었다.',
        '나는 잘못한 게 없다고 되뇌었다. 그런데 왜 자꾸 잘못한 사람처럼 굴게 되는 걸까.',
        '사흘 후, 형사가 다시 왔다. 이번엔 변호사 동석 여부를 정식으로 물었다.',
      ], choices: [
        { label: '실제로 변호사를 선임한다', nextNodeId: 'silent-lawyer' },
        { label: '생각을 바꿔 사실대로 말하기로 한다', nextNodeId: 'silent-truth' },
        { label: '형사를 피해 멀리 떠날 준비를 한다', nextNodeId: 'silent-flee' },
      ] },
      'silent-lawyer': { dateLabel: '8월 9일', paragraphs: [
        '변호사는 젊고 사무적이었다. "묻는 말에만 짧게 답하세요. 먼저 말하지 마시고요."',
        '다음 조사에서 나는 그 말대로 했다. 형사의 질문에 최소한으로만 답했다.',
        '조사가 끝난 뒤, 변호사가 말했다. "잘하셨어요. 근데 하나만 물을게요. 진짜 숨기시는 거 있어요?"',
        '나는 대답을 망설였다.',
      ], choices: [
        { label: '변호사를 통해 제한적으로만 계속 협조한다', nextNodeId: 's-end-a' },
        { label: '변호사 몰래 형사를 따로 만난다', nextNodeId: 's-end-b' },
        { label: '변호사의 조언을 모두 따른다', nextNodeId: 's-end-a' },
      ] },
      'silent-truth': { dateLabel: '8월 9일', paragraphs: [
        '나는 형사에게 다시 연락했다. "드릴 말씀이 있어요. 사실은…"',
        '그날 있었던 일을 전부 말했다. 형사는 별다른 표정 변화 없이 들었다.',
        '"진작 말씀하셨으면 서로 편했을 텐데요." 형사가 말했다.',
        '맞는 말이었다. 그런데도 나는 처음부터 그렇게 하지 못했다.',
      ], choices: [
        { label: '왜 처음부터 말 안 했는지 솔직히 설명한다', nextNodeId: 's-end-c' },
        { label: '설명 없이 그냥 넘어가려 한다', nextNodeId: 's-end-a' },
        { label: '가족에게 먼저 이 사실을 알린다', nextNodeId: 's-end-d' },
      ] },
      'silent-flee': { dateLabel: '8월 9일', paragraphs: [
        '나는 짐가방을 꺼내 옷가지를 넣기 시작했다. 어디로 갈지는 정하지 않았다.',
        '짐을 반쯤 쌌을 때, 정우에게서 전화가 왔다. 나는 받지 않았다.',
        '창밖으로 해가 지고 있었다. 짐가방은 열린 채로 방바닥에 그대로 있었다.',
      ], choices: [
        { label: '떠나기 전 형사를 다시 찾아간다', nextNodeId: 's-end-a' },
        { label: '아무 말 없이 떠난다', nextNodeId: 's-end-e' },
        { label: '짐을 도로 정리하고 마음을 바꾼다', nextNodeId: 's-end-d' },
      ] },
      't-end-a': { ending: { title: '그가 알고 있었던 것', rarity: 18, verdict: ['작은 위화감도, 그냥 넘기지 못하는군요.', '당신은 — 진실을 끝까지 캐묻는 사람.', '그 진실이, 알고 싶지 않았던 것이었어도요.'] }, paragraphs: [
        '나는 결국 정우에게 다시 물었다. "그 상처, 대체 어디서 난 거야?"',
        '그는 오래 침묵하다가 입을 열었다. "그날 밤, 나도 지수를 만나러 갔었어. 너를 만나기 전에."',
        '심장이 내려앉았다. "그런데 왜 나랑 있었다고..."',
        '"그게 더 안전해 보였으니까." 그가 조용히 말했다.',
        '그는 범인이 아니었다. 하지만 그날 밤 그가 보고도 말하지 않은 게 있었다.',
        '사건은 결국 다른 방식으로 풀렸다. 그러나 나는 이제 정우를 볼 때마다, 내가 알던 사람이 맞는지 다시 생각하게 됐다.',
      ] },
      't-end-b': { ending: { title: '증명된 결백, 무너진 사이', rarity: 27, verdict: ['묻고 싶은 걸 알면서도, 그냥 넘어가는 쪽을 택했군요.', '당신은 — 평온을 위해 침묵을 고르는 사람.', '그 대가가 무엇이든요.'] }, paragraphs: [
        '나는 그 일을 더 캐묻지 않기로 했다. 캐물어봐야 좋을 게 없을 것 같았다.',
        '지수는 열이틀 만에 발견됐다. 범인은 전혀 다른 사람이었다. 사건은 끝났다.',
        '하지만 내 결백을 증명하기 위해 드러난 것들 — 정우와 나 사이의 오래된 마음 — 은 원래대로 돌아가지 않았다.',
        '우리는 그 후로 다시는 예전처럼 마주 보지 못했다.',
        '가끔 그날의 일이 떠오른다. 이제 와서 무슨 상관이냐고 생각하면서도.',
      ] },
      't-end-c': { ending: { title: '의심은 옅어지지 않는다', rarity: 15, verdict: ['옳다고 믿는 걸, 결국 말하고야 마는군요.', '당신은 — 절차를 믿는 사람.', '사람들의 시선까지는, 절차가 지켜주지 못하지만요.'] }, paragraphs: [
        '나는 형사에게 내가 본 것, 느낀 것을 전부 말했다. 형사는 알겠다고만 했다.',
        '몇 주 뒤, 진범이 따로 붙잡혔다. 나와는 아무 상관 없는 사람이었다.',
        '사건은 공식적으로 종결됐다. 서류상으로는 나는 완전히 무혐의였다.',
        '그런데도 동네 사람들은 나를 볼 때마다 잠깐씩 말을 멈췄다. 마트에서, 엘리베이터에서, 늘 그 반 박자만큼의 침묵이 있었다.',
        '결백은 증명됐지만, 의심은 서류로 지워지는 게 아니었다.',
      ] },
      't-end-d': { ending: { title: '말하지 않은 것들', rarity: 9, verdict: ['끝까지, 답하지 않는 쪽을 택했군요.', '당신은 — 침묵으로 스스로를 지키는 사람.', '그게 무엇으로부터 지키는 건지는, 아마 본인만 알겠지만요.'] }, paragraphs: [
        '나는 끝내 답장하지 않았다. 정우가 그날 왜 거짓말했는지, 더는 알고 싶지 않았다.',
        '사건은 결국 미제로 남았다. 지수는 발견되지 않았다.',
        "동네 사람들의 시선 속에서 나는 오랫동안 '그날 어디 있었는지 말하지 못한 사람'으로 남았다.",
        '가끔 그 여름을 생각한다. 아무것도 답하지 않은 채로 지나간 계절을.',
      ] },
      't-end-e': { ending: { title: '혼자가 된 방식', rarity: 6, verdict: ['가장 조용한 방법으로, 떠났군요.', '당신은 — 관계보다 거리를 택하는 사람.', '아무도 모르게, 그러나 스스로는 분명히 알면서요.'] }, paragraphs: [
        '나는 조용히 이사를 준비했다. 누구에게도 이유를 자세히 설명하지 않았다.',
        '떠나기 전날, 정원의 감나무를 마지막으로 봤다. 그 나무는 여전히 아무것도 모른다는 듯한 얼굴이었다.',
        '새로운 동네에서는 아무도 나를 몰랐다. 그게 다행이면서도, 이상하게 쓸쓸했다.',
        '가끔 예전 동네 이야기가 들려온다. 사건이 어떻게 됐는지, 정우가 어떻게 지내는지. 나는 이제 그런 소식들을 그냥 흘려듣는다.',
        '혼자가 되는 데도 방법이 있다면, 나는 그중 가장 조용한 방법을 골랐던 것 같다.',
      ] },
      't-end-f': { ending: { title: '말없이 지나간 여름', rarity: 21, verdict: ['굳이, 꺼내지 않는 쪽을 택했군요.', '당신은 — 평화를 위해 침묵을 아끼는 사람.', '비밀 하나쯤은, 그렇게 계속 갖고 사는 사람이고요.'] }, paragraphs: [
        '나는 그 카페 영수증 뒤의 진실을 아무에게도 말하지 않기로 했다.',
        '사건은 별다른 소란 없이 마무리됐다. 나는 완전히 혐의를 벗었다.',
        '정우와는 가끔 안부를 주고받는 사이로 남았다. 그날에 대해서는 서로 다시 꺼내지 않았다.',
        '때로는 아무 일도 없었다는 듯 지나가는 게 가장 어려운 선택이라는 걸, 그해 여름에 알았다.',
      ] },
      'l-end-a': { ending: { title: '덮을수록 깊어지는', rarity: 12, verdict: ['끝까지, 밀고 나가는군요.', '당신은 — 부인이 곧 방어인 사람.', '그 방어가 자기 자신에게도 향하고 있다는 걸, 아직은 모르는 사람이고요.'] }, paragraphs: [
        '나는 변호사가 시키는 대로 했다. "기억이 안 납니다." "확실하지 않습니다." 정해진 말만 반복했다.',
        '수사는 몇 달을 끌었다. 결정적인 증거는 나오지 않았고, 나는 기소되지 않았다.',
        '하지만 그 몇 달 동안, 나는 매일 밤 같은 꿈을 꿨다. 대답하지 못한 질문들이 방 안 가득 쌓여가는 꿈.',
        '사건은 미제로 덮였다. 나는 자유의 몸이지만, 아직도 가끔 내가 정말로 그날 저녁을 기억 못 하는 건지, 기억하지 않기로 한 건지 스스로도 헷갈린다.',
      ] },
      'l-end-b': { ending: { title: '뒤늦은 자백', rarity: 24, verdict: ['결국은, 무너지고 마는군요.', '당신은 — 버틸 수 있을 때까지 버티는 사람.', '그리고 버틴 만큼, 늦게 인정하는 사람이고요.'] }, paragraphs: [
        '나는 결국 무너졌다. "죄송합니다. 거짓말했습니다."',
        '방 안이 조용해졌다. 형사는 담담하게 다음 질문으로 넘어갔다.',
        '진실은 생각보다 별것 아니었다 — 그저 부끄러운 사정 하나였을 뿐. 하지만 그 사실을 인정하기까지 걸린 시간이, 나를 이미 다른 사람으로 만들어 놓았다.',
        '혐의를 벗은 뒤에도 사람들은 나를 예전처럼 대하지 않았다. 거짓말을 했다는 사실 자체가, 어떤 진실보다 오래 남았다.',
      ] },
      'l-end-c': { ending: { title: '돌아오지 않는 것', rarity: 5, verdict: ['돌아갈 곳이 있어도, 돌아가지 못하는군요.', '당신은 — 두려움이 판단을 앞서는 사람.', '그 두려움이 틀렸다는 걸 알게 됐을 땐, 이미 늦은 사람이고요.'] }, paragraphs: [
        '나는 끝까지 숨었다. 이름을 바꾸고, 번호를 바꾸고, 아는 사람이 없는 곳에서 지냈다.',
        '몇 달 뒤, 뉴스에서 지수의 소식을 봤다. 발견됐다고 했다. 이미 오래전에.',
        '범인은 내가 아니었다. 처음부터 나를 진범으로 의심할 증거도 없었다고 했다.',
        '나는 도망칠 필요가 없었다. 그 사실을 그제야 알았을 때, 나는 이미 너무 멀리 와 있었다.',
        '돌아갈 곳이 있었는데도, 나는 스스로 돌아오지 않는 사람이 되어 있었다.',
      ] },
      'l-end-d': { ending: { title: '증명의 대가', rarity: 19, verdict: ['부끄러운 것도, 결국은 갚아내는군요.', '당신은 — 체면보다 매듭을 중요하게 여기는 사람.', '후련함을 위해서라면, 자존심 정도는 내줄 수 있는 사람이고요.'] }, paragraphs: [
        '나는 지수 언니에게 편지를 썼다. 그날의 사정과, 뒤늦게라도 사과하고 싶다는 말을 적었다.',
        '답장은 오지 않았다. 대신 몇 달 뒤, 빌렸던 돈을 갚으라는 문자 한 통이 왔다.',
        '나는 그 돈을 갚았다. 관계를 되돌리기 위해서가 아니라, 적어도 그 하나는 제대로 끝내고 싶어서였다.',
        '혐의를 벗은 대가로, 나는 부끄러운 사정을 모두 잃었다. 그리고 이상하게도, 그게 후련했다.',
      ] },
      'l-end-e': { ending: { title: '말없이 남은 것', rarity: 14, verdict: ['굳이, 다시 붙잡지 않는군요.', '당신은 — 끝난 건 끝난 대로 두는 사람.', '설명보다 침묵이 더 편한, 그런 사람이고요.'] }, paragraphs: [
        '나는 지수 언니에게 다시 연락하지 않았다. 관계는 그렇게 조용히 끝났다.',
        '혐의를 벗은 뒤에도, 나는 한동안 누구에게도 그날의 진짜 사정을 말하지 않았다.',
        '사건은 마무리됐고, 사람들의 관심도 곧 다른 곳으로 옮겨갔다.',
        '가끔 그 여름을 생각하면, 남은 건 결백의 증명이 아니라 말하지 않은 것들의 목록뿐이다.',
      ] },
      'l-end-f': { ending: { title: '누군가는 알고 있었다', rarity: 26, verdict: ['결국은, 손을 내밀었군요.', '당신은 — 혼자 버티기보다 기대는 걸 택하는 사람.', '그게 약한 게 아니라는 걸, 뒤늦게라도 아는 사람이고요.'] }, paragraphs: [
        '나는 가족에게 전화를 걸었다. 목소리가 갈라졌다.',
        '가족은 놀라지 않았다. "뉴스 보고 있었어. 어디야, 데리러 갈게."',
        '나는 그제야 알았다. 도망치는 동안에도, 누군가는 계속 나를 찾고 있었다는 걸.',
        '돌아온 날, 형사 앞에서 모든 걸 말했다. 무서웠던 건 사실 형사가 아니라, 혼자라는 생각이었다는 것도.',
      ] },
      's-end-a': { ending: { title: '의심은 남는다', rarity: 23, verdict: ['정해진 절차를, 믿는군요.', '당신은 — 감정보다 규칙을 앞세우는 사람.', '사람들의 마음까지는 절차가 정리해주지 않는다는 것도, 이제는 아는 사람이고요.'] }, paragraphs: [
        '나는 끝까지 변호사의 조언대로만 움직였다. 정해진 절차 안에서, 나는 완벽하게 결백했다.',
        '몇 주 뒤, 다른 용의자가 지목됐다. 나는 정식으로 혐의를 벗었다.',
        '그런데도 동네에서는 여전히 나를 두고 이런저런 말이 돌았다. "왜 처음엔 그렇게 입을 다물었대?"',
        '법적으로는 아무 문제 없었다. 하지만 사람들의 마음속 서류는 다르게 정리된 모양이었다.',
      ] },
      's-end-b': { ending: { title: '혼자 짊어진 것', rarity: 11, verdict: ['정해진 절차보다, 자신의 판단을 믿는군요.', '당신은 — 결국 스스로 결정하고 마는 사람.', '그 결과도, 스스로 짊어지는 사람이고요.'] }, paragraphs: [
        '나는 변호사 몰래 형사를 따로 찾아갔다. "사실 저 혼자 알고 있는 게 있어요."',
        '형사는 놀란 표정을 감추지 못했다. 나는 그날 있었던 일을 처음으로 자세히 털어놓았다.',
        '그 이야기는 사건 해결에 결정적인 실마리가 됐다. 하지만 변호사는 그 사실을 알고 나서 나와의 계약을 정중히 끝냈다.',
        '나는 사건에서는 벗어났지만, 그 이후로는 어떤 일이든 혼자 판단하고 혼자 책임지는 사람이 되어 있었다.',
      ] },
      's-end-c': { ending: { title: '뒤늦어도 괜찮은 것', rarity: 22, verdict: ['결국은, 솔직한 이유를 꺼내놓는군요.', '당신은 — 늦더라도 마음을 설명하려는 사람.', '그 편이 낫다는 걸, 경험으로 배운 사람이고요.'] }, paragraphs: [
        '나는 왜 처음부터 그렇게 방어적이었는지, 나조차 잘 설명할 수 없었던 그 마음을 그대로 말했다. "무서웠어요. 저를 안 믿어줄까 봐."',
        '형사는 잠깐 침묵하다가 말했다. "그런 분들 많아요. 그래도 지금이라도 말씀해 주셔서 다행이에요."',
        '사건은 곧 다른 방향으로 풀렸다. 나는 그날, 늦게라도 말하는 게 아예 말하지 않는 것보다 낫다는 걸 배웠다.',
      ] },
      's-end-d': { ending: { title: '혼자가 아니었다는 것', rarity: 28, verdict: ['혼자 끙끙 앓기보다, 먼저 말하는 쪽을 택했군요.', '당신은 — 기대는 법을 아는 사람.', '그게 가장 어려운 선택이라는 것도, 아마 알고 있을 사람이고요.'] }, paragraphs: [
        '나는 가족에게 먼저 전화를 걸었다. 떨리는 목소리로 그동안의 일을 털어놓았다.',
        '가족은 화내지 않았다. "왜 혼자 끙끙 앓았어. 진작 말하지."',
        '다음 날, 가족과 함께 형사를 찾아갔다. 혼자 마주했다면 훨씬 무서웠을 그 자리가, 그렇게 견딜 만해졌다.',
        '사건은 결국 잘 마무리됐다. 그보다 더 오래 남은 건, 혼자가 아니라는 감각이었다.',
      ] },
      's-end-e': { ending: { title: '혼자가 된 방식', rarity: 7, verdict: ['아무 말 없이, 그냥 떠나는군요.', '당신은 — 설명보다 거리를 택하는 사람.', '스스로 만든 혼자라는 상태에서, 좀처럼 나오지 않는 사람이고요.'] }, paragraphs: [
        '나는 짐가방을 닫고 조용히 집을 나섰다. 누구에게도 연락하지 않았다.',
        '새로운 도시에서, 나는 이름도 조금 바꾸고 지냈다.',
        '몇 달 뒤 들려온 소식으로는, 사건은 나와 상관없이 다른 사람이 잡히며 마무리됐다고 했다.',
        '나는 이제 아무 혐의도 없는 사람이었다. 하지만 이미 스스로 선택한 혼자라는 상태에서, 좀처럼 다시 나오지 못했다.',
      ] },
    },
  },
  2: {
    "title": "두 번째 일기",
    "theme": 2,
    "startNodeId": "start",
    "nodes": {
      "start": {
        "dateLabel": "5일 전",
        "paragraphs": [
          "청첩장 시안을 확인해달라는 문자가 왔다. 보낸 사람은 수호였다.",
          "나는 답장 대신 사진을 한참 들여다봤다. 지안의 웃는 얼굴이 정중앙에 있었다.",
          "5년 전, 수호가 지안을 소개해준 날부터 지금까지, 나는 이 마음을 한 번도 입 밖에 낸 적이 없다.",
          "결혼식까지 닷새. 마지막 기회라는 생각이 문득 들었다.",
          "수호에게서 문자가 하나 더 왔다. \"우리 셋이서 마지막으로 술 한잔 할까?\""
        ],
        "choices": [
          {
            "label": "마음을 숨기고 축하만 해준다",
            "nextNodeId": "lust-hide"
          },
          {
            "label": "지안에게 마음을 고백한다",
            "nextNodeId": "lust-confess"
          },
          {
            "label": "핑계를 대고 술자리를 피한다",
            "nextNodeId": "lust-avoid"
          }
        ]
      },
      "lust-hide": {
        "dateLabel": "4일 전",
        "paragraphs": [
          "나는 답장했다. \"좋지, 몇 시에 볼까?\"",
          "술자리에서 나는 평소처럼 웃었다. 수호와 지안의 손이 테이블 위에서 겹치는 걸 봐도 아무렇지 않은 척했다.",
          "자리가 끝나갈 무렵, 지안이 화장실에 간 사이 수호가 말했다. \"너 요즘 좀 이상해. 무슨 일 있어?\"",
          "나는 아니라고 했다. 그 말이 사실이 아니라는 걸, 나만 알고 있었다.",
          "집에 돌아오는 길, 지안에게서 문자가 왔다. \"오늘 너 좀 조용하더라. 괜찮아?\""
        ],
        "choices": [
          {
            "label": "괜찮다고 짧게 답한다",
            "nextNodeId": "lust-hide-short"
          },
          {
            "label": "솔직한 마음이 담긴 긴 답장을 쓰다가 지운다",
            "nextNodeId": "lust-hide-almost"
          },
          {
            "label": "아예 답장하지 않는다",
            "nextNodeId": "lust-hide-silent"
          }
        ]
      },
      "lust-confess": {
        "dateLabel": "4일 전",
        "paragraphs": [
          "나는 답장 대신 지안에게 따로 연락했다. \"잠깐 볼 수 있을까, 결혼식 전에 꼭 할 말이 있어.\"",
          "지안은 잠시 뒤 그러자고 했다. 어디서 볼지 정하는 그 짧은 대화조차, 심장이 터질 것 같았다.",
          "약속 장소에 먼저 도착해서, 나는 몇 번이나 할 말을 고쳐 썼다 지웠다.",
          "지안이 문을 열고 들어왔다. \"무슨 일이야, 급하게.\"",
          "나는 숨을 들이쉬었다."
        ],
        "choices": [
          {
            "label": "그동안의 마음을 솔직하게 말한다",
            "nextNodeId": "lust-confess-tell"
          },
          {
            "label": "막상 앞에 서니 아무 말도 못 하고 다른 핑계를 댄다",
            "nextNodeId": "lust-confess-chicken"
          },
          {
            "label": "고백 대신 결혼을 축하한다는 말로 돌린다",
            "nextNodeId": "lust-confess-redirect"
          }
        ]
      },
      "lust-avoid": {
        "dateLabel": "4일 전",
        "paragraphs": [
          "나는 수호에게 답장했다. \"미안, 그날 회사에 급한 일이 생겨서.\"",
          "거짓말이었다. 나는 그저 지안과 수호가 나란히 앉은 모습을 볼 자신이 없었다.",
          "그날 밤, 나는 핸드폰을 무음으로 해두고 일찍 잠자리에 들었다. 잠은 오지 않았다.",
          "다음 날 아침, 부재중 전화 세 통이 와 있었다. 전부 지안이었다.",
          "마지막 문자만 확인했다. \"무슨 일 있는 거 아니지? 결혼식엔 올 거지?\""
        ],
        "choices": [
          {
            "label": "무슨 일 있냐는 문자에 솔직히 답한다",
            "nextNodeId": "lust-avoid-honest"
          },
          {
            "label": "아무 일 없다고 둘러대고 결혼식엔 가겠다고 한다",
            "nextNodeId": "lust-avoid-deny"
          },
          {
            "label": "결혼식마저 다른 핑계로 빠지려 한다",
            "nextNodeId": "lust-avoid-skip"
          }
        ]
      },
      "lust-hide-short": {
        "dateLabel": "결혼식 전날",
        "paragraphs": [
          "결혼식 전날, 나는 축의금 봉투에 이름을 쓰다가 손을 멈췄다.",
          "수호에게서 전화가 왔다. \"내일 사회 좀 봐줄 수 있어? 원래 부탁하려던 애가 못 온대.\"",
          "나는 웃으며 그러겠다고 했다. 마이크를 잡고 두 사람의 행복을 빌어주는 역할이, 하필 나에게 떨어졌다.",
          "전화를 끊고 나서, 나는 내일 할 축사를 써야 했다. 첫 문장을 쓰다가 몇 번이나 다시 지웠다."
        ],
        "choices": [
          {
            "label": "진심을 담아 축사를 완성한다",
            "nextNodeId": "lust-end-a"
          },
          {
            "label": "형식적인 축사로 대충 채운다",
            "nextNodeId": "lust-end-b"
          },
          {
            "label": "축사를 쓰다 말고 사회를 못 보겠다고 연락한다",
            "nextNodeId": "lust-end-c"
          }
        ]
      },
      "lust-hide-almost": {
        "dateLabel": "결혼식 전날",
        "paragraphs": [
          "긴 문자를 쓰다가, 나는 결국 전송 버튼 대신 전체 삭제를 눌렀다.",
          "대신 짧게 \"괜찮아, 그냥 피곤해서\"라고 보냈다.",
          "지안에게서 답장이 왔다. \"다행이다. 내일 보자, 축하해줄 거지?\"",
          "'축하해줄 거지'라는 말이, 이상하게 오래 마음에 남았다."
        ],
        "choices": [
          {
            "label": "지운 문자의 내용을 다시 써서 보낸다",
            "nextNodeId": "lust-end-d"
          },
          {
            "label": "그냥 이대로 마음을 묻기로 한다",
            "nextNodeId": "lust-end-b"
          },
          {
            "label": "결혼식 당일, 지안과 단둘이 이야기할 기회를 만든다",
            "nextNodeId": "lust-end-e"
          }
        ]
      },
      "lust-hide-silent": {
        "dateLabel": "결혼식 전날",
        "paragraphs": [
          "나는 답장하지 않았다. 무슨 말을 해도 거짓말이 될 것 같았다.",
          "다음 날이 결혼식이었다. 나는 밤새 뒤척이다가, 결국 아침이 되어서야 잠깐 잠들었다.",
          "눈을 떴을 때, 지안에게서 메시지 한 통이 더 와 있었다. \"어제 답장 안 해서 걱정했어. 이따 봐.\"",
          "나는 그 메시지를 한참 바라보다가, 결혼식장으로 향하는 옷을 꺼냈다."
        ],
        "choices": [
          {
            "label": "아무 일 없었다는 듯 결혼식에 참석한다",
            "nextNodeId": "lust-end-b"
          },
          {
            "label": "결국 참석하지 못하고 마지막에 자리를 피한다",
            "nextNodeId": "lust-end-f"
          },
          {
            "label": "결혼식장에서 지안에게 짧게라도 진심을 전한다",
            "nextNodeId": "lust-end-e"
          }
        ]
      },
      "lust-confess-tell": {
        "dateLabel": "결혼식 3일 전",
        "paragraphs": [
          "나는 모든 걸 말했다. 5년 동안 하지 못했던 말들이, 한번 터지자 멈추지 않았다.",
          "지안은 오래 침묵하다가 말했다. \"...왜 이제 와서 말해.\"",
          "나는 대답하지 못했다. 왜 하필 이제 와서인지는, 나도 알고 싶었다.",
          "지안이 먼저 자리에서 일어났다. \"정리할 시간이 필요해.\""
        ],
        "choices": [
          {
            "label": "지안의 결정을 기다린다",
            "nextNodeId": "lust-end-g"
          },
          {
            "label": "수호에게도 사실대로 말해야 한다고 생각한다",
            "nextNodeId": "lust-end-h"
          },
          {
            "label": "고백을 취소하고 싶다고, 아무 일 없던 걸로 하자고 한다",
            "nextNodeId": "lust-end-i"
          }
        ]
      },
      "lust-confess-chicken": {
        "dateLabel": "결혼식 3일 전",
        "paragraphs": [
          "결국 나는 아무 말도 하지 못했다. \"청첩장 디자인 예쁘게 나왔더라, 그 말 하려고 불렀어.\"",
          "지안은 의아한 표정이었지만, 더 캐묻지 않았다.",
          "헤어지고 돌아오는 길, 나는 핸드폰에 아직 저장해둔 고백 문장들을 다시 읽었다.",
          "결국 하지 못한 말들이, 오히려 더 선명하게 남았다."
        ],
        "choices": [
          {
            "label": "이대로 마음을 완전히 접기로 한다",
            "nextNodeId": "lust-end-b"
          },
          {
            "label": "결혼식 날, 마지막으로 한 번 더 시도한다",
            "nextNodeId": "lust-end-e"
          },
          {
            "label": "지안이 아닌, 수호에게 그동안의 마음을 털어놓는다",
            "nextNodeId": "lust-end-h"
          }
        ]
      },
      "lust-confess-redirect": {
        "dateLabel": "결혼식 3일 전",
        "paragraphs": [
          "\"결혼 축하해.\" 나는 준비했던 말 대신, 그 한마디만 했다.",
          "지안의 얼굴에 옅은 안도가 스쳤다. \"고마워. 와줘서 다행이야, 그날 좀 이상하게 굴어서 걱정했잖아.\"",
          "나는 웃었다. 그 웃음이 내가 지을 수 있는 가장 정직한 표정이었다.",
          "헤어지고 나서, 나는 한참을 그 자리에 서 있었다."
        ],
        "choices": [
          {
            "label": "이걸로 마음을 완전히 정리하기로 한다",
            "nextNodeId": "lust-end-b"
          },
          {
            "label": "정리되지 않은 마음을 일기에 계속 쓰기로 한다",
            "nextNodeId": "lust-end-j"
          },
          {
            "label": "수호에게 지안을 잘 부탁한다는 말을 전한다",
            "nextNodeId": "lust-end-a"
          }
        ]
      },
      "lust-avoid-honest": {
        "dateLabel": "결혼식 이틀 전",
        "paragraphs": [
          "나는 지안에게 전화를 걸었다. \"사실… 너희 결혼 준비 보는 게, 나한테는 좀 힘들었어.\"",
          "지안은 한참 말이 없었다. \"그게 무슨 말이야.\"",
          "나는 더 설명하지 않았다. 이미 너무 많은 걸 말해버린 것 같았다.",
          "지안이 조용히 말했다. \"결혼식엔… 올 수 있겠어?\""
        ],
        "choices": [
          {
            "label": "괜찮다고, 가겠다고 말한다",
            "nextNodeId": "lust-end-e"
          },
          {
            "label": "아직은 모르겠다고 솔직히 말한다",
            "nextNodeId": "lust-end-f"
          },
          {
            "label": "미안하다는 말만 남기고 전화를 끊는다",
            "nextNodeId": "lust-end-i"
          }
        ]
      },
      "lust-avoid-deny": {
        "dateLabel": "결혼식 이틀 전",
        "paragraphs": [
          "\"아무 일도 없어. 당연히 가야지.\" 나는 최대한 밝게 말했다.",
          "지안은 믿는 눈치였다. 그게 오히려 더 마음에 걸렸다.",
          "전화를 끊고, 나는 옷장에서 결혼식에 입고 갈 옷을 미리 꺼내봤다.",
          "거울 속의 내 얼굴이, 낯설게 느껴졌다."
        ],
        "choices": [
          {
            "label": "예정대로 결혼식에 참석한다",
            "nextNodeId": "lust-end-b"
          },
          {
            "label": "당일 아침, 결국 가지 못하고 연락을 끊는다",
            "nextNodeId": "lust-end-f"
          },
          {
            "label": "결혼식에 가서 처음으로 솔직한 표정을 짓기로 한다",
            "nextNodeId": "lust-end-e"
          }
        ]
      },
      "lust-avoid-skip": {
        "dateLabel": "결혼식 당일",
        "paragraphs": [
          "나는 결혼식 시작 한 시간 전, 수호에게 문자를 보냈다. \"미안, 갑자기 못 갈 것 같아.\"",
          "답장은 오지 않았다. 나는 핸드폰을 내려놓고, 창밖을 봤다.",
          "몇 시간 뒤, 지안에게서 사진 한 장이 왔다. 웨딩드레스를 입은 모습이었다. 메시지는 없었다.",
          "나는 그 사진을 오래 저장해뒀다가, 결국 지우지 못했다."
        ],
        "choices": [
          {
            "label": "뒤늦게 사과 연락을 한다",
            "nextNodeId": "lust-end-k"
          },
          {
            "label": "이대로 연락을 끊고 지낸다",
            "nextNodeId": "lust-end-f"
          },
          {
            "label": "사진에 짧게라도 답장을 보낸다",
            "nextNodeId": "lust-end-j"
          }
        ]
      },
      "lust-end-a": {
        "ending": {
          "title": "축하할 자격",
          "rarity": 19,
          "verdict": [
            "결국은, 마음을 정리하기보다 잘 보내주는 쪽을 택했군요.",
            "당신은 — 자신의 감정보다 상대의 행복을 앞에 두는 사람.",
            "그 다정함이, 가장 오래 스스로를 아프게 한다는 것도 아마 알 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결국 진심을 담아 축사를 썼다. 마이크 앞에 서서, 나는 내가 쓴 문장들을 하나씩 읽어 내려갔다.",
          "지안과 수호가 웃는 얼굴로 나를 봤다. 그 웃음이 나를 향한 게 아니라는 걸 알면서도, 나는 끝까지 흔들리지 않고 읽었다.",
          "박수 소리 속에서 자리로 돌아오며, 나는 처음으로 이 마음을 완전히 내려놓은 것 같은 기분이 들었다.",
          "적어도 오늘만큼은, 나는 좋은 사람이었다."
        ]
      },
      "lust-end-b": {
        "ending": {
          "title": "괜찮은 척, 진짜 괜찮아질 때까지",
          "rarity": 24,
          "verdict": [
            "끝내 아무 말도 하지 않는 쪽을 택했군요.",
            "당신은 — 시간이 해결해줄 거라 믿는 사람.",
            "그 믿음이 틀리지 않기를, 스스로도 바라고 있을 사람이고요."
          ]
        },
        "paragraphs": [
          "결혼식은 무사히 끝났다. 나는 웃었고, 사진도 찍었고, 축의금도 냈다.",
          "집에 돌아와 옷을 갈아입다가, 나는 문득 이 모든 게 생각보다 견딜 만했다는 걸 깨달았다.",
          "물론 완전히 괜찮아진 건 아니었다. 다만 괜찮은 척이, 조금씩 진짜 괜찮음에 가까워지고 있었다.",
          "시간이 좀 더 지나면, 이 일기장도 다시 펼쳐보지 않게 될 것 같았다."
        ]
      },
      "lust-end-c": {
        "ending": {
          "title": "마지막 순간의 도망",
          "rarity": 13,
          "verdict": [
            "끝까지 해낼 수 있을 줄 알았는데, 결국 한 발 물러섰군요.",
            "당신은 — 감당할 수 없는 순간엔 스스로를 먼저 지키는 사람.",
            "그게 도망이 아니라 선택이었다는 걸, 나중에는 알게 될 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결국 수호에게 전화를 걸었다. \"미안한데, 나 사회 못 볼 것 같아. 갑자기 몸이 너무 안 좋아서.\"",
          "수호는 걱정하며 알겠다고 했다. 다른 사람을 급하게 구해야 한다는 말과 함께.",
          "나는 전화를 끊고, 스스로에게 물었다. 정말 몸이 안 좋은 건지, 그냥 그 자리에 설 자신이 없었던 건지.",
          "결혼식 당일, 나는 참석은 했지만 맨 뒷줄에 앉았다. 그게 지금 나한테 맞는 거리였다."
        ]
      },
      "lust-end-d": {
        "ending": {
          "title": "지운 문장을 다시 쓰는 일",
          "rarity": 9,
          "verdict": [
            "결국 지웠던 걸 다시 꺼내는군요.",
            "당신은 — 후회를 남기느니 어색함을 택하는 사람.",
            "그 용기가 늘 좋은 결과로 이어지는 건 아니라는 것도, 이미 알고 있을 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 삭제했던 문자를 다시 썼다. 이번엔 지우지 않고 전송 버튼을 눌렀다.",
          "몇 분 뒤, 지안에게서 전화가 왔다. \"이게 무슨 말이야, 지금.\"",
          "나는 전화기를 붙잡고, 처음으로 5년 동안의 마음을 소리 내어 말했다.",
          "지안은 오래 아무 말도 하지 않았다. 그 침묵이, 대답보다 더 많은 것을 말하고 있었다."
        ]
      },
      "lust-end-e": {
        "ending": {
          "title": "그래도, 마지막 인사는 진심으로",
          "rarity": 16,
          "verdict": [
            "끝까지 자리를 지키는 쪽을 택했군요.",
            "당신은 — 마음을 다 전하지 못해도, 곁에는 있어주는 사람.",
            "그 절반의 용기가, 어쩌면 가장 어려운 선택이었을 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결혼식장 한쪽에서 지안과 잠깐 눈이 마주쳤다.",
          "모두가 바쁜 틈을 타, 나는 다가가 짧게 말했다. \"행복해야 해. 진심으로.\"",
          "지안은 잠깐 놀란 표정이었다가, 이내 웃으며 고맙다고 했다.",
          "그 말 한마디로 5년이 다 정리되진 않았지만, 적어도 나는 도망치지 않고 그 자리에 있었다."
        ]
      },
      "lust-end-f": {
        "ending": {
          "title": "가지 못한 결혼식",
          "rarity": 7,
          "verdict": [
            "결국은, 그 자리에 서지 못했군요.",
            "당신은 — 감당하기 힘든 순간을 피해버리는 사람.",
            "그 회피가 무엇을 지켜준 건지는, 아직 스스로도 확신하지 못할 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결혼식에 가지 못했다. 아니, 가지 않았다는 게 더 정확할 것이다.",
          "그날 이후 지안에게서는 연락이 오지 않았다. 나도 먼저 연락하지 않았다.",
          "몇 달이 지난 지금도, 나는 가끔 그날의 하늘을 기억한다. 유난히 맑았던 그날, 나는 혼자 방 안에 있었다.",
          "어떤 마음은, 끝내 아무에게도 전해지지 못한 채로 남는다."
        ]
      },
      "lust-end-g": {
        "ending": {
          "title": "정리할 시간, 그 이후",
          "rarity": 6,
          "verdict": [
            "기다리는 쪽을 택했군요.",
            "당신은 — 결과를 스스로 정하기보다 상대의 답을 기다리는 사람.",
            "그 기다림이 때로는 가장 무거운 짐이라는 것도 알 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 아무 연락도 하지 않고 기다렸다. 하루, 이틀, 사흘.",
          "결혼식 전날 밤, 지안에게서 짧은 문자가 왔다. \"내일 결혼식, 예정대로 할게. 너도 알고 있었으면 해서.\"",
          "나는 그 문자를 몇 번이나 다시 읽었다. 예상했던 답이었는데도, 마음이 무너지는 소리가 들리는 것 같았다.",
          "다음 날, 나는 결혼식에 가지 않았다. 그게 지안이 나에게 마지막으로 준 배려라고 생각하기로 했다."
        ]
      },
      "lust-end-h": {
        "ending": {
          "title": "털어놓은 진실, 남은 것",
          "rarity": 8,
          "verdict": [
            "숨기기보다는, 모두에게 정직하기를 택했군요.",
            "당신은 — 관계가 깨지더라도 진실을 우선하는 사람.",
            "그 정직함의 대가를 오래 짊어지게 될 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 수호를 따로 만나 모든 걸 말했다. 그의 표정이 서서히 굳어가는 걸 보면서도, 나는 말을 멈추지 않았다.",
          "수호는 한참 후에야 입을 열었다. \"차라리 말해줘서... 나도 생각할 시간이 필요할 것 같다.\"",
          "결혼식은 예정대로 진행됐다. 다만 그 이후로, 나와 수호 사이엔 예전 같은 편안함이 남아있지 않았다.",
          "진실을 말한 것을 후회하진 않는다. 다만 그 대가가 이렇게 클 줄은 몰랐다."
        ]
      },
      "lust-end-i": {
        "ending": {
          "title": "없던 일로 하자는 말",
          "rarity": 11,
          "verdict": [
            "꺼낸 마음을 스스로 도로 집어넣는군요.",
            "당신은 — 후폭풍이 두려워 되돌리려 하는 사람.",
            "이미 뱉은 말은 되돌려지지 않는다는 것도, 서서히 알게 될 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 지안에게 다시 연락했다. \"미안해, 방금 한 말은 잊어줘. 아무 일도 아니었어.\"",
          "지안은 알겠다고 했다. 그 대답이 너무 순순해서, 오히려 더 아팠다.",
          "결혼식 날, 우리는 예전처럼 인사를 나눴다. 겉으로는 아무 일도 없었던 것처럼.",
          "하지만 나는 안다. 어떤 말은 취소한다고 해서, 정말로 없었던 일이 되지는 않는다는 걸."
        ]
      },
      "lust-end-j": {
        "ending": {
          "title": "끝나지 않은 일기",
          "rarity": 14,
          "verdict": [
            "완전히 끝내지 못한 채로, 계속 붙들고 있군요.",
            "당신은 — 정리보다 기록을 택하는 사람.",
            "그렇게라도 붙잡아야, 견딜 수 있는 마음이 있다는 걸 아는 사람이고요."
          ]
        },
        "paragraphs": [
          "결혼식은 끝났지만, 나는 여전히 이 일기를 쓰고 있다.",
          "가끔 지안의 SNS에 들어가 본다. 행복해 보이는 사진들 밑에, 나는 아무 말도 남기지 않는다.",
          "이 마음이 언제 끝날지 나도 모른다. 어쩌면 끝나지 않을 수도 있다는 생각이 든다.",
          "그래도 매일 밤, 나는 이 노트를 펼친다. 여기서만큼은 솔직해도 되니까."
        ]
      },
      "lust-end-k": {
        "ending": {
          "title": "늦은 사과",
          "rarity": 12,
          "verdict": [
            "늦었지만, 결국은 마음을 전했군요.",
            "당신은 — 타이밍을 놓쳐도 포기하지 않는 사람.",
            "늦은 진심도 아예 없는 것보다는 낫다고 믿는 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 며칠을 고민하다가 지안에게 전화를 걸었다. \"그날 못 가서 미안해. 사실은…\"",
          "나는 처음으로 모든 걸 털어놓았다. 왜 가지 못했는지, 그동안 어떤 마음이었는지.",
          "지안은 한참 침묵하다가 말했다. \"진작 알았으면 좋았을 텐데. 그래도... 말해줘서 고마워.\"",
          "우리 사이가 예전 같아지진 않겠지만, 적어도 더는 숨기지 않아도 된다는 게 다행이었다."
        ]
      }
    }
  },
  3: {
    "title": "세 번째 일기",
    "theme": 3,
    "startNodeId": "start",
    "nodes": {
      "start": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "현우의 핸드폰이 울렸다. 화면이 켜졌고, 나는 그저 무음으로 바꿔주려던 것뿐이었다.",
          "메시지 미리보기가 보였다. \"오늘 자기 만나서 너무 좋았어. 예린이한테는 절대 말하지 마.\" 보낸 사람은 저장된 이름이 '민서'였다.",
          "민서는 내 가장 오랜 친구였다. 10년 넘게, 내 결혼식 들러리를 서줬던 사람.",
          "현우가 샤워를 마치고 나오는 소리가 들렸다. 나는 핸드폰을 원래 자리에 내려놓았다.",
          "\"무슨 일 있어?\" 현우가 물었다. 평소와 똑같은 목소리로."
        ],
        "choices": [
          {
            "label": "당장 추궁한다",
            "nextNodeId": "wrath-confront"
          },
          {
            "label": "증거부터 더 모으기로 한다",
            "nextNodeId": "wrath-gather"
          },
          {
            "label": "아무 내색도 하지 않는다",
            "nextNodeId": "wrath-hide"
          }
        ]
      },
      "wrath-confront": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "나는 참지 못하고 물었다. \"민서가 누구야?\"",
          "현우의 얼굴이 하얗게 질렸다. \"그게... 무슨 소리야.\"",
          "나는 핸드폰 화면을 그대로 들이밀었다. 변명할 틈도 주지 않았다.",
          "긴 침묵 끝에, 현우가 입을 열었다. \"미안해. 얼마나 됐는지... 말할게.\""
        ],
        "choices": [
          {
            "label": "얼마나 됐는지 끝까지 듣는다",
            "nextNodeId": "wrath-confront-listen"
          },
          {
            "label": "더 듣고 싶지 않다며 자리를 뜬다",
            "nextNodeId": "wrath-confront-leave"
          },
          {
            "label": "그 자리에서 민서에게 바로 전화를 건다",
            "nextNodeId": "wrath-confront-call"
          }
        ]
      },
      "wrath-gather": {
        "dateLabel": "이틀 후",
        "paragraphs": [
          "나는 아무렇지 않은 척, 현우의 일정을 유심히 살피기 시작했다.",
          "이틀 뒤, 나는 현우가 '야근'이라고 한 날 회사 근처에서 그를 봤다. 민서와 함께였다.",
          "두 사람은 다정하게 웃고 있었다. 내가 알던 그 웃음이었다, 나에게만 짓던 줄 알았던.",
          "나는 사진을 몇 장 찍었다. 손이 떨렸다."
        ],
        "choices": [
          {
            "label": "사진을 들고 그 자리에서 나타난다",
            "nextNodeId": "wrath-gather-confront"
          },
          {
            "label": "집에 가서 조용히 이야기를 준비한다",
            "nextNodeId": "wrath-gather-home"
          },
          {
            "label": "민서에게 먼저 연락해 따로 만나자고 한다",
            "nextNodeId": "wrath-gather-friend"
          }
        ]
      },
      "wrath-hide": {
        "dateLabel": "다음 날",
        "paragraphs": [
          "나는 아무것도 모르는 척, 평소처럼 아침을 차렸다.",
          "현우는 눈치채지 못한 듯 보였다. 아니, 눈치채지 못한 척하는 건 나도 마찬가지였을지 모른다.",
          "그날 오후, 민서에게서 태연한 안부 문자가 왔다. \"이번 주말에 셋이 볼까?\"",
          "나는 핸드폰을 손에 쥔 채 한참을 가만히 있었다."
        ],
        "choices": [
          {
            "label": "아무렇지 않게 약속을 잡는다",
            "nextNodeId": "wrath-hide-agree"
          },
          {
            "label": "핑계를 대고 약속을 미룬다",
            "nextNodeId": "wrath-hide-delay"
          },
          {
            "label": "더는 못 참고 그 자리에서 다 말해버린다",
            "nextNodeId": "wrath-hide-explode"
          }
        ]
      },
      "wrath-confront-listen": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "나는 자리에 앉아 끝까지 들었다. 여섯 달이었다. 여섯 달 동안, 나는 아무것도 몰랐다.",
          "현우는 울면서 사과했다. \"정말 후회하고 있어. 우리 다시 잘해볼 수 있을까?\"",
          "나는 그 질문에 바로 답할 수 없었다. 화가 나는 건지, 그냥 슬픈 건지도 구분이 안 됐다.",
          "창밖이 밝아올 때까지, 나는 아무 말도 하지 못하고 앉아 있었다."
        ],
        "choices": [
          {
            "label": "다시 잘해보기로 한다",
            "nextNodeId": "wrath-end-a"
          },
          {
            "label": "이별을 요구한다",
            "nextNodeId": "wrath-end-b"
          },
          {
            "label": "시간을 갖고 생각해보겠다고 한다",
            "nextNodeId": "wrath-end-c"
          }
        ]
      },
      "wrath-confront-leave": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "나는 더 듣지 않고 자리에서 일어났다. \"지금은 아무 말도 듣고 싶지 않아.\"",
          "현우가 붙잡으려 했지만, 나는 문을 닫고 나왔다.",
          "차 안에 앉아, 나는 처음으로 크게 소리 내어 울었다.",
          "몇 시간이 지나자, 현우에게서 문자가 쌓이기 시작했다. 나는 읽지 않았다."
        ],
        "choices": [
          {
            "label": "며칠 뒤 돌아가 대화를 시도한다",
            "nextNodeId": "wrath-end-c"
          },
          {
            "label": "그대로 짐을 챙겨 나온다",
            "nextNodeId": "wrath-end-d"
          },
          {
            "label": "친구들에게 도움을 요청한다",
            "nextNodeId": "wrath-end-e"
          }
        ]
      },
      "wrath-confront-call": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "나는 그 자리에서 민서에게 전화를 걸었다. 신호가 두 번 울리기도 전에 받았다.",
          "\"여보세요?\" 민서의 목소리가 평소와 똑같아서, 나는 잠시 말을 잃었다.",
          "\"너였어?\" 내가 물었다. 수화기 너머로 긴 침묵이 흘렀다.",
          "민서가 울먹이며 말했다. \"미안해... 정말 미안해, 예린아.\""
        ],
        "choices": [
          {
            "label": "민서와도 그 자리에서 끝까지 이야기한다",
            "nextNodeId": "wrath-end-f"
          },
          {
            "label": "더 말하지 않고 전화를 끊는다",
            "nextNodeId": "wrath-end-g"
          },
          {
            "label": "현우와 민서 둘 다 당장 만나자고 한다",
            "nextNodeId": "wrath-end-h"
          }
        ]
      },
      "wrath-gather-confront": {
        "dateLabel": "이틀 후",
        "paragraphs": [
          "나는 두 사람 앞에 나타났다. 현우의 얼굴이 순식간에 굳었다.",
          "민서는 아무 말도 하지 못하고 나를 쳐다봤다. 나는 손에 쥔 사진을 테이블 위에 올려놨다.",
          "\"설명해.\" 내 목소리는 놀랄 만큼 차분했다.",
          "두 사람 다, 한참 동안 아무 말도 하지 못했다."
        ],
        "choices": [
          {
            "label": "그 자리에서 관계를 정리한다",
            "nextNodeId": "wrath-end-d"
          },
          {
            "label": "일단 자리를 떠나 혼자 생각할 시간을 갖는다",
            "nextNodeId": "wrath-end-c"
          },
          {
            "label": "두 사람의 설명을 들어보기로 한다",
            "nextNodeId": "wrath-end-f"
          }
        ]
      },
      "wrath-gather-home": {
        "dateLabel": "이틀 후",
        "paragraphs": [
          "나는 집에 돌아와 사진을 몇 번이고 다시 봤다.",
          "현우가 퇴근해 돌아왔다. \"다녀왔어.\" 평소와 똑같은 인사였다.",
          "나는 사진을 테이블 위에 조용히 올려놨다. \"오늘, 야근이었다며.\"",
          "현우의 표정이 무너지는 걸, 나는 처음부터 끝까지 지켜봤다."
        ],
        "choices": [
          {
            "label": "차분하게 그동안의 일을 다 말하게 한다",
            "nextNodeId": "wrath-end-a"
          },
          {
            "label": "당장 나가라고 말한다",
            "nextNodeId": "wrath-end-d"
          },
          {
            "label": "아무 말도 하지 못하고 그대로 방에 들어가 버린다",
            "nextNodeId": "wrath-end-i"
          }
        ]
      },
      "wrath-gather-friend": {
        "dateLabel": "이틀 후",
        "paragraphs": [
          "나는 민서에게 먼저 연락했다. \"얘기 좀 하자, 우리 둘이.\"",
          "카페에서 마주 앉은 민서는, 내가 사진을 보여주기도 전에 먼저 울기 시작했다.",
          "\"미안해. 어떻게 말해야 할지 몰라서 계속 미뤘어.\"",
          "나는 10년 지기 친구가 우는 모습을 보면서도, 마음이 조금도 풀리지 않는 걸 느꼈다."
        ],
        "choices": [
          {
            "label": "친구로서 마지막으로 하고 싶은 말을 다 한다",
            "nextNodeId": "wrath-end-e"
          },
          {
            "label": "이 우정은 여기서 끝이라고 말한다",
            "nextNodeId": "wrath-end-g"
          },
          {
            "label": "현우에게도 함께 이야기하자고 부른다",
            "nextNodeId": "wrath-end-f"
          }
        ]
      },
      "wrath-hide-agree": {
        "dateLabel": "주말",
        "paragraphs": [
          "나는 태연하게 답장했다. \"좋지, 어디서 볼까?\"",
          "셋이 만난 자리에서, 나는 웃으며 대화를 이어갔다. 아무도 내가 알고 있다는 걸 눈치채지 못했다.",
          "헤어질 무렵, 나는 민서를 잠깐 따로 불렀다. \"청첩장 사진, 잘 봤어. 너한테 보낸 거 아니었는데 말이야.\"",
          "민서의 얼굴이 순식간에 하얗게 질렸다."
        ],
        "choices": [
          {
            "label": "그 자리에서 모든 걸 밝힌다",
            "nextNodeId": "wrath-end-h"
          },
          {
            "label": "그 말만 남기고 아무 일 없었다는 듯 돌아선다",
            "nextNodeId": "wrath-end-j"
          },
          {
            "label": "집에 가서 현우와 담판을 짓는다",
            "nextNodeId": "wrath-end-a"
          }
        ]
      },
      "wrath-hide-delay": {
        "dateLabel": "주말",
        "paragraphs": [
          "나는 몸이 안 좋다는 핑계로 약속을 미뤘다.",
          "대신, 나는 조용히 변호사 상담 일정을 알아보기 시작했다.",
          "현우는 내가 뭔가 알고 있다는 걸 눈치채지 못한 채, 평소처럼 나를 대했다.",
          "나는 시간을 벌고 있었다. 무엇을 위한 시간인지는, 나 스스로도 정리가 필요했다."
        ],
        "choices": [
          {
            "label": "필요한 준비를 다 마친 뒤 이별을 통보한다",
            "nextNodeId": "wrath-end-d"
          },
          {
            "label": "생각보다 마음이 정리되어, 대화로 풀어보기로 한다",
            "nextNodeId": "wrath-end-c"
          },
          {
            "label": "결국 준비만 하다가 아무 말도 못 한다",
            "nextNodeId": "wrath-end-i"
          }
        ]
      },
      "wrath-hide-explode": {
        "dateLabel": "다음 날",
        "paragraphs": [
          "나는 참지 못하고 소리쳤다. \"민서가 누군지 알아! 다 알고 있다고!\"",
          "현우의 손에서 핸드폰이 떨어졌다. 그 소리가 유난히 크게 울렸다.",
          "집 안이 순식간에 아수라장이 됐다. 나는 그동안 참아왔던 말들을 전부 쏟아냈다.",
          "한참을 소리 지르고 나서야, 나는 숨을 몰아쉬며 자리에 주저앉았다."
        ],
        "choices": [
          {
            "label": "다 쏟아낸 뒤, 차분히 대화를 이어간다",
            "nextNodeId": "wrath-end-a"
          },
          {
            "label": "이 사람과는 끝이라고 선언한다",
            "nextNodeId": "wrath-end-d"
          },
          {
            "label": "너무 지쳐서 그날은 더 말하지 않기로 한다",
            "nextNodeId": "wrath-end-c"
          }
        ]
      },
      "wrath-end-a": {
        "ending": {
          "title": "다시, 처음부터",
          "rarity": 15,
          "verdict": [
            "무너진 걸 다시 세우는 쪽을 택했군요.",
            "당신은 — 분노보다 관계를 우선하는 사람.",
            "그 인내가 언제까지 갈지는, 시간만이 답해줄 사람이고요."
          ]
        },
        "paragraphs": [
          "우리는 다시 잘해보기로 했다. 상담을 받기 시작했고, 나는 매일 이 결정이 맞는지 스스로에게 되물었다.",
          "쉽지 않았다. 아무렇지 않은 척했던 순간들이 문득문득 떠올라 숨이 막힐 때도 있었다.",
          "그래도 나는 이 선택을 후회하지 않기로 했다. 적어도 지금은.",
          "신뢰는 한 번에 돌아오지 않는다. 매일 조금씩, 다시 쌓아가는 수밖에 없다는 걸 배웠다."
        ]
      },
      "wrath-end-b": {
        "ending": {
          "title": "끝을 선택하다",
          "rarity": 22,
          "verdict": [
            "망설임 없이, 끝을 택했군요.",
            "당신은 — 회복보다 단절이 낫다고 믿는 사람.",
            "그 단호함이 스스로를 지키는 가장 확실한 방법이라고 믿는 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 헤어지자고 말했다. 현우는 매달렸지만, 내 마음은 이미 정해져 있었다.",
          "짐을 정리하는 데는 두 달이 걸렸다. 함께 쌓아온 것들을 나누는 일은, 생각보다 훨씬 고통스러웠다.",
          "모든 게 끝난 뒤, 나는 텅 빈 집에서 처음으로 깊이 잠들었다.",
          "슬펐지만, 후련하기도 했다. 두 감정이 동시에 존재할 수 있다는 걸, 나는 그때 처음 알았다."
        ]
      },
      "wrath-end-c": {
        "ending": {
          "title": "생각할 시간",
          "rarity": 26,
          "verdict": [
            "아직, 결론을 내리지 않는군요.",
            "당신은 — 성급한 답보다 충분한 시간을 택하는 사람.",
            "그 신중함이 때로는 가장 어려운 선택이라는 것도 알 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 당장 답을 내리지 않기로 했다. 현우는 거실 소파에서, 나는 침실에서 지내기 시작했다.",
          "몇 주가 지나도 마음은 정리되지 않았다. 어떤 날은 용서할 수 있을 것 같았고, 어떤 날은 절대 안 될 것 같았다.",
          "결정을 미루는 게 도망이 아닌지, 스스로에게 여러 번 물었다.",
          "아직 답은 나오지 않았다. 이 일기는, 그 답을 찾는 동안의 기록이 될 것 같다."
        ]
      },
      "wrath-end-d": {
        "ending": {
          "title": "짐을 챙겨",
          "rarity": 12,
          "verdict": [
            "돌아보지 않고, 바로 떠났군요.",
            "당신은 — 결정하면 곧바로 행동에 옮기는 사람.",
            "그 속도가 후회를 남기지 않기 위한 자기 방어라는 것도, 아마 알 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 그날 밤, 짐을 챙겨 집을 나왔다. 뒤도 돌아보지 않았다.",
          "친구 집 소파에서 며칠을 지내며, 나는 그제야 실감했다. 10년 넘게 쌓아온 것들이 하루아침에 무너질 수 있다는 걸.",
          "현우에게서 수십 통의 연락이 왔지만, 나는 하나도 답하지 않았다.",
          "아팠다. 하지만 그 순간의 나에게는, 그게 유일하게 할 수 있는 선택이었다."
        ]
      },
      "wrath-end-e": {
        "ending": {
          "title": "친구들에게 기댄 밤",
          "rarity": 18,
          "verdict": [
            "혼자 견디기보다, 곁에 있는 사람들에게 기댔군요.",
            "당신은 — 무너질 때일수록 사람을 찾는 사람.",
            "그게 약한 게 아니라 현명한 거라는 걸, 이미 알고 있을 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 오랜 친구들에게 모든 걸 털어놓았다. 예상보다 훨씬 많은 사람들이 내 곁에 있어줬다.",
          "혼자가 아니라는 사실이, 그날 밤 나를 버티게 한 유일한 힘이었다.",
          "민서와의 우정은 그렇게 끝이 났다. 아쉬웠지만, 이상하게 후련하기도 했다.",
          "모든 관계가 끝난 자리에도, 남아있는 사람들이 있다는 걸 그날 배웠다."
        ]
      },
      "wrath-end-f": {
        "ending": {
          "title": "세 사람의 자리",
          "rarity": 10,
          "verdict": [
            "둘 다 마주 앉혀 놓고, 끝까지 들었군요.",
            "당신은 — 회피보다 정면 대응을 택하는 사람.",
            "그 용기가 상처를 더 깊게 만들 수도 있다는 걸 감수한 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 현우와 민서를 한자리에 불렀다. 세 사람이 마주 앉은 그 침묵은, 내가 겪어본 것 중 가장 무거웠다.",
          "각자의 이야기를 들으며, 나는 화도 나고 허탈하기도 했다. 두 사람 다 나에게 미안하다고 했다.",
          "그 자리에서 모든 게 해결되진 않았다. 하지만 적어도, 더는 숨겨진 것이 없었다.",
          "진실은 아팠지만, 적어도 더 이상 어둠 속에 있지는 않았다."
        ]
      },
      "wrath-end-g": {
        "ending": {
          "title": "전화를 끊다",
          "rarity": 9,
          "verdict": [
            "한쪽과의 관계만, 조용히 끊어냈군요.",
            "당신은 — 모든 걸 한 번에 정리하지 않는 사람.",
            "우선순위를 나누는 그 판단이, 꽤 냉정하면서도 현실적인 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 더 듣지 않고 전화를 끊었다. 그 후로 민서의 연락은 받지 않았다.",
          "현우와는 계속 이야기를 이어갔지만, 10년 지기였던 친구는 그렇게 내 삶에서 사라졌다.",
          "가끔 예전 사진들을 보면, 이상하게 마음이 복잡해진다. 그리움인지, 배신감인지 아직도 잘 모르겠다.",
          "어떤 관계는, 끝나는 순간조차 명확하지 않은 채로 그렇게 흐려진다."
        ]
      },
      "wrath-end-h": {
        "ending": {
          "title": "다 밝혀진 자리",
          "rarity": 7,
          "verdict": [
            "숨기지 않고, 모두가 보는 앞에서 터뜨렸군요.",
            "당신은 — 체면보다 진실을 앞세우는 사람.",
            "그 순간의 후련함이, 오래도록 스스로를 지켜줄 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 그 자리에서 모든 걸 밝혔다. 목소리가 떨렸지만, 멈추지 않았다.",
          "주변의 시선이 쏠렸지만, 나는 신경 쓰지 않았다. 더 이상 숨길 이유가 없었다.",
          "현우와 민서 모두, 그 자리에서 아무 말도 하지 못했다.",
          "창피함보다, 처음으로 솔직해졌다는 후련함이 더 컸다."
        ]
      },
      "wrath-end-i": {
        "ending": {
          "title": "아무 말도 하지 못한 채",
          "rarity": 13,
          "verdict": [
            "결국 아무 말도 못 하고 지나갔군요.",
            "당신은 — 갈등보다 침묵을 택하는 사람.",
            "그 침묵의 무게를 혼자 짊어지고 있다는 것도, 스스로는 알고 있을 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결국 아무 말도 하지 못했다. 하고 싶은 말은 많았지만, 입 밖으로 나오지 않았다.",
          "시간이 흐르면서, 그 말들은 점점 더 하기 어려워졌다.",
          "우리는 겉으로는 예전과 비슷하게 지냈다. 하지만 나는 안다. 그날 이후로, 아무것도 예전 같지 않다는 걸.",
          "언젠가는 말할 수 있을까. 아직은, 잘 모르겠다."
        ]
      },
      "wrath-end-j": {
        "ending": {
          "title": "돌아선 뒷모습",
          "rarity": 11,
          "verdict": [
            "당황하게 만들고, 담담히 돌아섰군요.",
            "당신은 — 감정을 드러내기보다 주도권을 쥐는 사람.",
            "그 침착함 뒤에 얼마나 많은 게 억눌려 있는지는, 아마 본인만 알 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 민서에게 그 한마디만 남기고 돌아섰다. 뒤에서 민서가 뭐라고 부르는 소리가 들렸지만, 돌아보지 않았다.",
          "집에 돌아와, 나는 현우가 오기를 기다렸다. 이번엔 내가 먼저 준비된 채로.",
          "현우가 문을 열고 들어왔을 때, 나는 이미 모든 걸 알고 있다는 표정으로 그를 마주 봤다.",
          "이제부터가, 진짜 우리 이야기의 시작이었다."
        ]
      }
    }
  },
  4: {
    "title": "네 번째 일기",
    "theme": 4,
    "startNodeId": "start",
    "nodes": {
      "start": {
        "dateLabel": "장례식 다음 날",
        "paragraphs": [
          "아버지의 유품을 정리하다가, 서랍 깊숙한 곳에서 낡은 서류 봉투를 찾았다.",
          "안에는 오래된 유언장이 있었다. 변호사도 모르는, 아버지가 직접 쓴 것이었다.",
          "내용을 읽어 내려가다, 나는 손을 멈췄다. 이 유언장대로라면 재산은 전부 나에게 온다. 동생 몫은 한 줄도 없었다.",
          "공식 유언장은 이미 변호사 손에 있고, 거기엔 반반씩 나누라고 되어 있었다. 이 서류는 그보다 나중에 쓰인 것 같았다.",
          "동생은 아직 이 서류의 존재를 모른다."
        ],
        "choices": [
          {
            "label": "이 유언장을 변호사에게 그대로 제출한다",
            "nextNodeId": "greed-submit"
          },
          {
            "label": "동생 몰래 없던 일로 하고 태워버린다",
            "nextNodeId": "greed-burn"
          },
          {
            "label": "동생에게 먼저 보여주고 상의한다",
            "nextNodeId": "greed-tell"
          }
        ]
      },
      "greed-submit": {
        "dateLabel": "일주일 후",
        "paragraphs": [
          "나는 서류를 변호사에게 가져갔다. 변호사는 필적과 날짜를 확인하더니, 법적 효력이 있을 수도 있다고 했다.",
          "절차가 시작되자 동생에게도 소식이 들어갔다. 동생에게서 전화가 왔다. \"이게 무슨 소리야, 갑자기 새 유언장이 나왔다니.\"",
          "나는 사실대로 말했다. 아버지 서랍에서 찾았다고.",
          "동생은 한참 말이 없다가 말했다. \"…네가 찾았다는 것부터가, 이상하지 않아?\""
        ],
        "choices": [
          {
            "label": "동생에게 서류를 직접 보여주며 결백을 증명한다",
            "nextNodeId": "greed-submit-prove"
          },
          {
            "label": "그런 의심을 받는 것 자체에 화를 낸다",
            "nextNodeId": "greed-submit-anger"
          },
          {
            "label": "법적 절차에 맡기고 동생과는 거리를 둔다",
            "nextNodeId": "greed-submit-distance"
          }
        ]
      },
      "greed-burn": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "나는 서류를 조용히 태웠다. 재가 될 때까지 지켜봤다.",
          "다음 날, 변호사를 만나 공식 유언장대로 재산을 반씩 나누는 절차를 진행했다.",
          "동생은 아무것도 몰랐다. 절차는 매끄럽게 끝났다.",
          "그런데 며칠 뒤, 동생이 물었다. \"아버지 서재 정리하다가 뭐 특이한 거 없었어?\" 그냥 지나가는 말투였다."
        ],
        "choices": [
          {
            "label": "아무것도 없었다고 대답한다",
            "nextNodeId": "greed-burn-deny"
          },
          {
            "label": "사실 뭔가 찾았지만 별거 아니었다고 얼버무린다",
            "nextNodeId": "greed-burn-hint"
          },
          {
            "label": "결국 사실대로 다 말한다",
            "nextNodeId": "greed-burn-confess"
          }
        ]
      },
      "greed-tell": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "나는 동생을 불러 서류를 보여줬다. \"이런 게 나왔어. 어떻게 할지 같이 정하자.\"",
          "동생은 한참 서류를 들여다보다가 말했다. \"…아버지답네. 마지막까지 편애하시네.\"",
          "그 말에 나는 아무 대답도 하지 못했다. 편애를 받은 게 나인지, 아니면 이 상황 자체가 편애인지 헷갈렸다.",
          "동생이 물었다. \"너는 어떻게 하고 싶은데?\""
        ],
        "choices": [
          {
            "label": "이 서류대로 하지 말고 원래대로 반씩 나누자고 한다",
            "nextNodeId": "greed-tell-split"
          },
          {
            "label": "이 서류도 하나의 선택지로 변호사와 상의해보자고 한다",
            "nextNodeId": "greed-tell-legal"
          },
          {
            "label": "동생의 결정에 맡기겠다고 한다",
            "nextNodeId": "greed-tell-defer"
          }
        ]
      },
      "greed-submit-prove": {
        "paragraphs": [
          "나는 동생 앞에서 서류의 필적, 발견 장소, 날짜를 하나하나 짚어가며 설명했다.",
          "동생은 오래 듣다가 고개를 끄덕였다. \"…믿을게. 근데 솔직히, 그 순간엔 진짜 의심했어.\"",
          "우리는 결국 법정 대신 둘이 합의하기로 했다. 새 유언장의 존재는 인정하되, 절반씩 나누는 걸로.",
          "완전히 풀리진 않았지만, 적어도 대화는 끝까지 했다."
        ],
        "choices": [
          {
            "label": "합의한 대로 반씩 나누고 끝낸다",
            "nextNodeId": "greed-end-a"
          },
          {
            "label": "그래도 새 유언장의 효력을 끝까지 주장한다",
            "nextNodeId": "greed-end-b"
          },
          {
            "label": "차라리 내 몫을 동생에게 양보한다",
            "nextNodeId": "greed-end-c"
          }
        ]
      },
      "greed-submit-anger": {
        "paragraphs": [
          "나는 발끈해서 말했다. \"내가 그런 사람으로 보여? 아버지가 쓰신 거잖아!\"",
          "동생은 물러서지 않았다. \"그럼 왜 하필 지금, 네가 정리하다가 나온 건데.\"",
          "우리는 그날 크게 다퉜다. 서로 언성을 높이다가, 결국 전화를 끊었다.",
          "법정 다툼으로 넘어갔다. 변호사 비용만 남고, 우리 둘 다 지쳐갔다."
        ],
        "choices": [
          {
            "label": "지쳐서 결국 화해를 시도한다",
            "nextNodeId": "greed-end-d"
          },
          {
            "label": "끝까지 소송으로 간다",
            "nextNodeId": "greed-end-e"
          },
          {
            "label": "소송을 취하하고 동생에게 양보한다",
            "nextNodeId": "greed-end-c"
          }
        ]
      },
      "greed-submit-distance": {
        "paragraphs": [
          "나는 더 설명하지 않았다. \"절차대로 하면 되잖아.\" 그렇게만 말했다.",
          "법적 절차는 시간이 걸렸다. 그동안 우리는 거의 연락하지 않았다.",
          "결국 서류의 법적 효력이 인정되어, 재산은 대부분 나에게 왔다.",
          "승소 통지를 받은 날, 나는 기쁘지 않았다. 동생의 번호를 한참 바라보다가, 결국 누르지 못했다."
        ],
        "choices": [
          {
            "label": "이제라도 동생에게 연락해본다",
            "nextNodeId": "greed-end-f"
          },
          {
            "label": "이대로 관계를 정리하고 만다",
            "nextNodeId": "greed-end-g"
          },
          {
            "label": "받은 재산의 일부를 동생 몰래 보내준다",
            "nextNodeId": "greed-end-h"
          }
        ]
      },
      "greed-burn-deny": {
        "paragraphs": [
          "나는 아무것도 없었다고 말했다. 동생은 \"그렇구나\" 하고 넘어갔다.",
          "시간이 지나며 나는 이 일을 점점 잊어갔다. 아니, 잊은 척하는 게 익숙해졌다.",
          "가끔 아버지의 다른 유품을 볼 때마다, 그 서랍이 떠오른다.",
          "완전 범죄라는 게 있다면, 아마 이런 걸까. 아무도 모르지만 나는 안다."
        ],
        "choices": [
          {
            "label": "이대로 평생 비밀로 간직한다",
            "nextNodeId": "greed-end-i"
          },
          {
            "label": "언젠가는 동생에게 고백하기로 마음먹는다",
            "nextNodeId": "greed-end-j"
          },
          {
            "label": "죄책감에 재산 일부를 몰래 기부한다",
            "nextNodeId": "greed-end-k"
          }
        ]
      },
      "greed-burn-hint": {
        "paragraphs": [
          "나는 얼버무렸다. \"뭐 오래된 편지 같은 거 있긴 했는데, 별 내용 없었어.\"",
          "동생의 표정이 살짝 굳는 걸 봤다. 더 캐묻지는 않았지만, 뭔가 눈치챈 것 같았다.",
          "그 후로 동생은 나를 대하는 게 조금 달라졌다. 정확히 뭐라 말할 수 없지만, 예전 같지 않았다.",
          "확인할 방법은 없다. 그저 짐작만 할 뿐이다."
        ],
        "choices": [
          {
            "label": "먼저 나서서 다 털어놓는다",
            "nextNodeId": "greed-end-j"
          },
          {
            "label": "그냥 이 애매한 상태로 둔다",
            "nextNodeId": "greed-end-l"
          },
          {
            "label": "동생이 더 캐묻기 전에 화제를 돌린다",
            "nextNodeId": "greed-end-i"
          }
        ]
      },
      "greed-burn-confess": {
        "paragraphs": [
          "나는 결국 다 말했다. 유언장을 찾은 것, 태운 것, 전부.",
          "동생은 오래 말이 없다가, 뜻밖의 말을 했다. \"…태워줘서 고마워. 나였어도 그랬을 것 같아.\"",
          "나는 눈물이 났다. 죄책감 때문인지, 안도감 때문인지 알 수 없었다.",
          "우리는 그 서랍 이야기를 다시는 꺼내지 않기로 했다. 다만 이제는, 함께 아는 비밀이 되었다."
        ],
        "choices": [
          {
            "label": "이 비밀을 계기로 오히려 더 가까워진다",
            "nextNodeId": "greed-end-m"
          },
          {
            "label": "미안한 마음에 내 몫을 더 나눠준다",
            "nextNodeId": "greed-end-c"
          },
          {
            "label": "말은 했지만 마음 한구석은 계속 불편하다",
            "nextNodeId": "greed-end-l"
          }
        ]
      },
      "greed-tell-split": {
        "paragraphs": [
          "우리는 새 유언장을 없던 일로 하고, 원래대로 반씩 나누기로 했다.",
          "동생이 말했다. \"너 진짜 그래도 괜찮아? 다 가질 수도 있었는데.\"",
          "나는 괜찮다고 했다. 그리고 그 말은 진심이었다.",
          "재산보다, 이 결정 이후로도 동생과 계속 편하게 지낼 수 있다는 게 더 크게 느껴졌다."
        ],
        "choices": [
          {
            "label": "그 선택에 후회 없이 만족한다",
            "nextNodeId": "greed-end-a"
          },
          {
            "label": "시간이 지나며 조금씩 아쉬움이 남는다",
            "nextNodeId": "greed-end-n"
          },
          {
            "label": "동생도 나에게 뭔가를 양보하려 한다",
            "nextNodeId": "greed-end-m"
          }
        ]
      },
      "greed-tell-legal": {
        "paragraphs": [
          "우리는 함께 변호사를 찾아가 두 유언장을 모두 보여줬다.",
          "변호사는 여러 절차를 설명했다. 시간도 비용도 만만치 않았다.",
          "그 과정에서 우리는 몇 번이나 부딪혔다. 각자 원하는 결과가 조금씩 달랐다.",
          "결국 법원의 조정으로 마무리됐다. 완전히 만족스럽진 않았지만, 공정하다고는 느꼈다."
        ],
        "choices": [
          {
            "label": "결과를 순순히 받아들인다",
            "nextNodeId": "greed-end-a"
          },
          {
            "label": "조정 결과에 불만이 남는다",
            "nextNodeId": "greed-end-n"
          },
          {
            "label": "이 과정 자체가 너무 힘들어 관계가 소원해진다",
            "nextNodeId": "greed-end-g"
          }
        ]
      },
      "greed-tell-defer": {
        "paragraphs": [
          "나는 동생에게 결정을 맡겼다. \"네가 정해, 나는 따를게.\"",
          "동생은 한참 고민하다가 말했다. \"…그럼 새 유언장대로 하자. 아버지 뜻이었다면, 뜻이었겠지.\"",
          "뜻밖의 대답이었다. 나는 놀랐지만, 동생의 결정을 존중하기로 했다.",
          "결국 나는 더 많은 몫을 받았다. 동생이 스스로 내린 결정이라는 게, 마음을 복잡하게 만들었다."
        ],
        "choices": [
          {
            "label": "받은 몫에 감사하며 잘 지낸다",
            "nextNodeId": "greed-end-h"
          },
          {
            "label": "동생의 결정이 계속 마음에 걸려 다시 나눠준다",
            "nextNodeId": "greed-end-c"
          },
          {
            "label": "동생이 정말 괜찮은 건지 계속 확인하게 된다",
            "nextNodeId": "greed-end-n"
          }
        ]
      },
      "greed-end-a": {
        "ending": {
          "title": "공정하게 나눈 자리",
          "rarity": 24,
          "verdict": [
            "결국은, 공평하게 나누는 쪽을 택했군요.",
            "당신은 — 몫보다 관계를 우선하는 사람.",
            "그 선택이 손해처럼 보여도, 후회는 남기지 않는 사람이고요."
          ]
        },
        "paragraphs": [
          "결국 우리는 반반씩 나눴다. 서류상으로도, 마음으로도 깔끔하게 정리됐다.",
          "재산은 절반이 됐지만, 동생과의 관계는 예전 그대로 남았다.",
          "가끔 그날의 서랍을 생각한다. 열지 않았다면 더 편했을까, 하는 생각도 든다.",
          "그래도 후회하지 않는다. 지킨 게 재산보다 크다고 믿는다."
        ]
      },
      "greed-end-b": {
        "ending": {
          "title": "끝까지 쥔 몫",
          "rarity": 9,
          "verdict": [
            "끝까지, 자기 몫을 놓지 않는군요.",
            "당신은 — 관계보다 정당한 권리를 우선하는 사람.",
            "그 권리가 무엇을 대가로 지켜졌는지는, 나중에야 실감할 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 새 유언장의 효력을 끝까지 주장했다. 법적으로는 내가 이겼다.",
          "재산은 대부분 내 앞으로 왔다. 하지만 그 이후로 동생과는 명절에도 만나지 않는 사이가 됐다.",
          "돈은 남았다. 가족은 남지 않았다.",
          "가끔 그게 맞는 거래였는지, 스스로에게 묻는다."
        ]
      },
      "greed-end-c": {
        "ending": {
          "title": "양보한 몫",
          "rarity": 17,
          "verdict": [
            "재산보다, 관계를 택했군요.",
            "당신은 — 손해를 감수하고서라도 마음을 지키는 사람.",
            "그 셈법이 남들 눈엔 손해로 보여도, 본인에겐 아닐 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결국 내 몫을 동생에게 더 넘겼다. 미안함 때문이었는지, 진심이었는지 구분이 안 됐다.",
          "동생은 처음엔 사양하다가, 결국 받았다. \"고마워. 근데 너도 손해 보지 마.\"",
          "경제적으로는 손해였다. 하지만 그날 이후 우리는 예전보다 더 편하게 연락하는 사이가 됐다.",
          "무엇을 얻었는지는 정확히 셀 수 없지만, 잃지 않은 건 분명했다."
        ]
      },
      "greed-end-d": {
        "ending": {
          "title": "지쳐서 다시 손 내밀다",
          "rarity": 11,
          "verdict": [
            "지칠 대로 지치고 나서야, 다시 손을 내미는군요.",
            "당신은 — 끝까지 가보고서야 멈출 곳을 아는 사람.",
            "그 과정이 꼭 필요했다고, 나중엔 생각할 사람이고요."
          ]
        },
        "paragraphs": [
          "몇 달의 소송 끝에, 우리 둘 다 완전히 지쳤다.",
          "어느 날 동생에게서 먼저 연락이 왔다. \"이제 그만하자. 우리 이러다 진짜 남 되겠어.\"",
          "우리는 소송을 취하하고, 변호사 없이 직접 마주 앉아 다시 이야기했다.",
          "완벽한 합의는 아니었지만, 적어도 서로의 얼굴을 다시 볼 수 있게 됐다."
        ]
      },
      "greed-end-e": {
        "ending": {
          "title": "남이 된 형제",
          "rarity": 6,
          "verdict": [
            "끝까지 물러서지 않았고, 결국 남이 됐군요.",
            "당신은 — 옳음을 증명하는 데 모든 걸 거는 사람.",
            "그 증명의 대가가 무엇이었는지, 아마 계속 곱씹을 사람이고요."
          ]
        },
        "paragraphs": [
          "소송은 끝까지 갔다. 법원은 손을 들어줬지만, 그 사이 우리는 완전히 갈라섰다.",
          "재산 분할이 끝난 뒤에도, 우리는 서로에게 연락하지 않았다.",
          "명절마다 부모님 생각이 나지만, 동생 생각은 애써 지운다.",
          "이겼다고 말하기엔, 남은 게 너무 없었다."
        ]
      },
      "greed-end-f": {
        "ending": {
          "title": "다시 건 전화",
          "rarity": 14,
          "verdict": [
            "끊어질 뻔한 걸, 먼저 다시 이었군요.",
            "당신은 — 이겼어도 관계를 놓지 않으려는 사람.",
            "그 시도가 늦었을까 걱정하면서도, 하지 않는 것보단 낫다고 믿는 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결국 동생에게 전화를 걸었다. 신호음이 길게 울렸다.",
          "동생이 받았다. \"…웬일이야.\" 목소리에 경계심이 묻어 있었다.",
          "나는 그동안의 일을 사과했다. 완벽한 해결은 아니었지만, 대화가 다시 시작됐다.",
          "관계를 되돌리는 데는, 재산을 나누는 것보다 훨씬 오랜 시간이 걸릴 것 같았다."
        ]
      },
      "greed-end-g": {
        "ending": {
          "title": "그대로 멀어진 사이",
          "rarity": 10,
          "verdict": [
            "거리가 생긴 채로, 그냥 두는군요.",
            "당신은 — 먼저 다가가기보다 시간에 맡기는 사람.",
            "그 시간이 관계를 되돌려줄지는, 아직 모를 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 연락하지 않았다. 시간이 지날수록, 먼저 연락하기가 더 어려워졌다.",
          "재산은 내게 남았다. 동생은 내 삶에서 조용히 빠져나갔다.",
          "가끔 SNS에서 동생의 소식을 본다. 잘 지내는 것 같아, 그게 다행이면서도 쓸쓸하다.",
          "무엇을 지켰고 무엇을 잃었는지, 이제는 계산하지 않기로 했다."
        ]
      },
      "greed-end-h": {
        "ending": {
          "title": "몰래 보낸 몫",
          "rarity": 13,
          "verdict": [
            "표 내지 않고, 조용히 나눴군요.",
            "당신은 — 마음을 굳이 증명하려 하지 않는 사람.",
            "알아주지 않아도 괜찮다고, 스스로 정한 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 받은 재산의 일부를 동생 몰래 계좌로 보냈다. 이름도, 메모도 남기지 않았다.",
          "동생에게서 문자가 왔다. \"이거 뭐야? 누가 잘못 보낸 거 아니야?\"",
          "나는 모른 척했다. 굳이 밝히지 않아도 되는 마음이 있다고 생각했다.",
          "동생은 결국 그 돈을 그냥 받아들이기로 한 것 같았다. 우리 사이는, 겉으로는 아무 일도 없었다."
        ]
      },
      "greed-end-i": {
        "ending": {
          "title": "완전한 비밀",
          "rarity": 19,
          "verdict": [
            "끝까지, 아무에게도 말하지 않는군요.",
            "당신은 — 비밀은 비밀로 두는 게 낫다고 믿는 사람.",
            "그 비밀의 무게를 평생 혼자 짊어질 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 그 일을 아무에게도 말하지 않았다. 시간이 지나며 기억도 흐려졌다.",
          "동생과는 평범하게 지낸다. 명절마다 만나고, 안부를 묻는다.",
          "다만 가끔, 아무 이유 없이 그 서랍이 떠오르는 밤이 있다.",
          "완전 범죄는 없다고들 하는데, 적어도 지금까지는 아무도 모른다."
        ]
      },
      "greed-end-j": {
        "ending": {
          "title": "뒤늦은 고백",
          "rarity": 8,
          "verdict": [
            "늦었지만, 결국은 털어놓는군요.",
            "당신은 — 시간이 걸려도 진실을 묻어두지 못하는 사람.",
            "그 뒤늦음이 미안함을 더 키운다는 것도, 감수하는 사람이고요."
          ]
        },
        "paragraphs": [
          "몇 년이 지난 어느 날, 나는 결국 동생에게 다 털어놓았다.",
          "동생은 한참 아무 말도 하지 않았다. 그러다 조용히 말했다. \"…왜 이제야 말해.\"",
          "화를 낼 줄 알았는데, 동생은 그저 서운해했다. 그게 오히려 더 미안했다.",
          "늦었지만, 이제라도 말할 수 있어서 다행이라고 생각하기로 했다."
        ]
      },
      "greed-end-k": {
        "ending": {
          "title": "몰래 흘려보낸 죄책감",
          "rarity": 12,
          "verdict": [
            "죄책감을, 조용히 어딘가로 흘려보내는군요.",
            "당신은 — 드러내지 않고 스스로 매듭을 지으려는 사람.",
            "그 매듭이 완전히 풀리진 않는다는 것도, 이미 아는 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 그 재산의 일부를 익명으로 기부했다. 누구에게도 말하지 않았다.",
          "죄책감이 완전히 사라지진 않았지만, 조금은 가벼워졌다.",
          "동생과는 여전히 평범하게 지낸다. 다만 나 혼자만 아는 이 매듭이, 늘 마음 한편에 있다.",
          "이게 속죄인지 자기만족인지는, 나도 확신할 수 없다."
        ]
      },
      "greed-end-l": {
        "ending": {
          "title": "애매하게 남은 것",
          "rarity": 15,
          "verdict": [
            "확실히 끝맺지 못하고, 애매하게 남겨두는군요.",
            "당신은 — 정면으로 부딪히기보다 시간에 흐려지길 바라는 사람.",
            "그 애매함이 오히려 더 오래간다는 걸, 서서히 알게 될 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 끝내 확실하게 말하지도, 완전히 숨기지도 못했다.",
          "동생과 나 사이엔 뭔가 애매한 앙금 같은 게 남았다. 서로 입 밖에 내지 않을 뿐이었다.",
          "명절마다 만나긴 하지만, 예전 같은 편안함은 아니다.",
          "어떤 일들은 이렇게, 끝나지 않은 채로 계속 이어진다."
        ]
      },
      "greed-end-m": {
        "ending": {
          "title": "비밀로 더 가까워진 사이",
          "rarity": 7,
          "verdict": [
            "가장 이기적일 수 있었던 순간에, 오히려 솔직했군요.",
            "당신은 — 약점을 나누는 게 관계를 더 단단하게 만든다고 믿는 사람.",
            "그 믿음이 맞았다는 걸, 지금의 사이가 증명해주는 사람이고요."
          ]
        },
        "paragraphs": [
          "우리는 그 일을 계기로 오히려 더 가까워졌다. 서로의 가장 약한 순간을 나눠 가진 사이가 됐으니까.",
          "동생이 말했다. \"이제 우리, 진짜 숨기는 거 없는 거다?\" 나는 웃으며 그러자고 했다.",
          "재산 문제는 이미 오래전에 정리됐고, 이제는 기억도 잘 안 난다.",
          "가장 이기적일 수 있었던 순간에 정직했던 게, 결국 관계를 더 단단하게 만들었다."
        ]
      },
      "greed-end-n": {
        "ending": {
          "title": "남은 아쉬움",
          "rarity": 16,
          "verdict": [
            "옳은 선택을 하고도, 완전히 개운하진 않군요.",
            "당신은 — 정답을 알면서도 미련이 남는 사람.",
            "그 미련이 잘못이 아니라는 것도, 아마 알고 있을 사람이고요."
          ]
        },
        "paragraphs": [
          "결정 자체는 순리대로 내렸지만, 시간이 지날수록 작은 아쉬움이 쌓였다.",
          "동생과의 관계는 나쁘지 않다. 다만 가끔, ‘그때 조금 더 챙길걸’ 하는 생각이 스친다.",
          "그 생각이 들 때마다 스스로도 놀란다. 관계를 지킨 걸 후회하는 건 아닌데, 완전히 개운하지도 않다.",
          "사람 마음이라는 게, 정리했다고 해서 완전히 끝나는 건 아닌가 보다."
        ]
      }
    }
  },
  5: {
    "title": "다섯 번째 일기",
    "theme": 5,
    "startNodeId": "start",
    "nodes": {
      "start": {
        "dateLabel": "합격자 발표일",
        "paragraphs": [
          "합격자 명단이 떴다. 내 이름은 없었다. 대신, 익숙한 이름이 있었다. 수아.",
          "수아는 내 가장 친한 친구였다. 함께 준비했고, 함께 지원했다.",
          "축하한다고 말해야 하는데, 손가락이 움직이지 않았다.",
          "수아에게서 먼저 문자가 왔다. \"나 붙었어…! 너는?\"",
          "답장을 쓰다가, 나는 몇 번이나 지웠다."
        ],
        "choices": [
          {
            "label": "축하한다고 솔직하게 답한다",
            "nextNodeId": "envy-congrats"
          },
          {
            "label": "괜찮은 척하며 얼버무린다",
            "nextNodeId": "envy-hide"
          },
          {
            "label": "수아의 포트폴리오에서 본 미심쩍은 부분이 떠올라 신경 쓰인다",
            "nextNodeId": "envy-suspect"
          }
        ]
      },
      "envy-congrats": {
        "dateLabel": "다음 날",
        "paragraphs": [
          "나는 진심을 담아 축하 메시지를 보냈다. 답장을 보내고도 마음 한구석은 여전히 무거웠다.",
          "수아를 만났을 때, 나는 웃으며 축하한다고 다시 말했다.",
          "수아가 말했다. \"너도 다음엔 꼭 될 거야. 너 진짜 열심히 했잖아.\"",
          "그 말이 위로가 되면서도, 동시에 아프기도 했다. 열심히 한 게 나만이 아니었을 텐데."
        ],
        "choices": [
          {
            "label": "진심으로 다음을 준비하기로 한다",
            "nextNodeId": "envy-congrats-prepare"
          },
          {
            "label": "겉으로는 웃지만 속으로 계속 비교하게 된다",
            "nextNodeId": "envy-congrats-compare"
          },
          {
            "label": "수아에게 솔직히 지금 마음이 복잡하다고 말한다",
            "nextNodeId": "envy-congrats-honest"
          }
        ]
      },
      "envy-hide": {
        "dateLabel": "다음 날",
        "paragraphs": [
          "\"잘됐네, 축하해.\" 나는 짧게만 답했다.",
          "수아를 만나는 자리를 이런저런 핑계로 미뤘다. 마주 보고 웃을 자신이 없었다.",
          "며칠 뒤, 공통 친구에게서 연락이 왔다. \"너 요즘 수아 피하는 거 다들 눈치챘어.\"",
          "나는 아니라고 했지만, 스스로도 그 말이 거짓말이라는 걸 알고 있었다."
        ],
        "choices": [
          {
            "label": "더는 피하지 않고 수아를 직접 만난다",
            "nextNodeId": "envy-hide-face"
          },
          {
            "label": "이대로 계속 거리를 둔다",
            "nextNodeId": "envy-hide-continue"
          },
          {
            "label": "수아에게 솔직히 질투 났었다고 털어놓는다",
            "nextNodeId": "envy-hide-confess"
          }
        ]
      },
      "envy-suspect": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "수아의 포트폴리오 중 한 부분이 자꾸 떠올랐다. 예전에 다른 작가의 작업물과 비슷하다고 생각했던 부분.",
          "확실한 증거는 없었다. 그냥 내 기분 탓일 수도 있었다.",
          "신고하면 어떻게 될지, 나는 인터넷으로 이것저것 찾아봤다.",
          "화면을 오래 들여다보다가, 나는 스스로에게 물었다. 이게 정말 정의감인지, 아니면 다른 마음인지."
        ],
        "choices": [
          {
            "label": "확실한 증거를 더 찾아본다",
            "nextNodeId": "envy-suspect-dig"
          },
          {
            "label": "익명으로 문제를 제기한다",
            "nextNodeId": "envy-suspect-report"
          },
          {
            "label": "찜찜하지만 그냥 넘어가기로 한다",
            "nextNodeId": "envy-suspect-drop"
          }
        ]
      },
      "envy-congrats-prepare": {
        "paragraphs": [
          "나는 다음 기회를 위해 다시 포트폴리오를 다듬기 시작했다.",
          "수아는 종종 조언을 해줬다. 합격한 사람의 시선에서 보는 피드백은 확실히 달랐다.",
          "몇 달 뒤, 나는 다른 곳에 합격했다. 수아가 제일 먼저 축하해줬다.",
          "우리는 각자 다른 곳에서, 여전히 서로를 응원하는 사이로 남았다."
        ],
        "choices": [
          {
            "label": "그 성취를 온전히 즐긴다",
            "nextNodeId": "envy-end-a"
          },
          {
            "label": "그래도 수아와 비교하는 마음이 완전히 사라지진 않는다",
            "nextNodeId": "envy-end-b"
          },
          {
            "label": "수아에게 그동안 힘들었던 마음을 뒤늦게 고백한다",
            "nextNodeId": "envy-end-c"
          }
        ]
      },
      "envy-congrats-compare": {
        "paragraphs": [
          "나는 겉으로는 계속 웃었지만, 속으로는 수아의 SNS를 매일 확인하게 됐다.",
          "수아가 올리는 회사 생활, 동료들과의 사진 하나하나가 나를 초조하게 만들었다.",
          "어느 날 나는 결국 수아의 SNS를 뮤트했다. 보지 않는 게 나아 보였다.",
          "그렇게 하고 나니 마음은 편해졌지만, 동시에 수아와도 조금씩 멀어졌다."
        ],
        "choices": [
          {
            "label": "거리를 둔 채로 각자의 삶을 산다",
            "nextNodeId": "envy-end-d"
          },
          {
            "label": "뮤트를 풀고 다시 마주하기로 한다",
            "nextNodeId": "envy-end-e"
          },
          {
            "label": "이 마음을 인정하고 상담이나 도움을 받아본다",
            "nextNodeId": "envy-end-f"
          }
        ]
      },
      "envy-congrats-honest": {
        "paragraphs": [
          "나는 수아에게 말했다. \"축하하는 마음 진짜야. 근데 솔직히, 부럽기도 해.\"",
          "수아는 놀란 표정이었다가, 이내 고개를 끄덕였다. \"그렇게 말해줘서 고마워. 사실 나도 붙고 나서 너한테 미안했어.\"",
          "우리는 그날 오래 이야기했다. 숨기지 않으니, 오히려 더 편해졌다.",
          "질투와 우정이 동시에 존재할 수 있다는 걸, 그날 처음 알았다."
        ],
        "choices": [
          {
            "label": "이후로도 솔직한 사이를 유지한다",
            "nextNodeId": "envy-end-c"
          },
          {
            "label": "말은 했지만 여전히 완전히 편해지진 않는다",
            "nextNodeId": "envy-end-b"
          },
          {
            "label": "이 대화를 계기로 둘 다 한 단계 성장한다",
            "nextNodeId": "envy-end-a"
          }
        ]
      },
      "envy-hide-face": {
        "paragraphs": [
          "나는 수아에게 연락해 만나자고 했다. 마주 앉기까지, 심장이 계속 뛰었다.",
          "수아가 먼저 말했다. \"너 나 피했지. 알아, 괜찮아. 나였어도 그랬을 것 같아.\"",
          "그 말에 오히려 눈물이 났다. 이해받는다는 게, 이렇게 큰 위로가 될 줄 몰랐다.",
          "우리는 그날 이후로 예전처럼 지내기 시작했다. 완전히 예전 같지는 않아도, 다시 가까워지는 중이다."
        ],
        "choices": [
          {
            "label": "천천히 예전 관계를 회복해간다",
            "nextNodeId": "envy-end-c"
          },
          {
            "label": "그래도 마음 한구석에 앙금이 남는다",
            "nextNodeId": "envy-end-b"
          },
          {
            "label": "수아와의 우정이 오히려 더 단단해진다",
            "nextNodeId": "envy-end-a"
          }
        ]
      },
      "envy-hide-continue": {
        "paragraphs": [
          "나는 계속 거리를 뒀다. 만남을 피하고, 연락도 줄였다.",
          "수아도 결국 더는 연락하지 않게 됐다. 자연스럽게, 우리는 멀어졌다.",
          "가끔 다른 친구들을 통해 수아의 소식을 듣는다. 잘 지낸다는 이야기에, 안심과 씁쓸함이 동시에 든다.",
          "먼저 놓은 게 나였다는 걸, 알면서도 되돌리지 못하고 있다."
        ],
        "choices": [
          {
            "label": "언젠가는 다시 연락해볼까 고민한다",
            "nextNodeId": "envy-end-g"
          },
          {
            "label": "이대로 관계가 끝난 걸 받아들인다",
            "nextNodeId": "envy-end-h"
          },
          {
            "label": "다른 사람에게라도 이 마음을 털어놓는다",
            "nextNodeId": "envy-end-f"
          }
        ]
      },
      "envy-hide-confess": {
        "paragraphs": [
          "나는 결국 말했다. \"사실 나, 그때 너 진짜 질투 났었어.\"",
          "수아는 잠깐 놀라더니, 오히려 편안한 표정이 됐다. \"말해줘서 고마워. 나 혼자 눈치 보는 것도 힘들었거든.\"",
          "솔직해지고 나니, 이상하게 마음이 가벼워졌다.",
          "질투를 인정하는 게 지는 거라고 생각했는데, 오히려 그 반대였다."
        ],
        "choices": [
          {
            "label": "그날 이후로 더 솔직한 친구가 된다",
            "nextNodeId": "envy-end-c"
          },
          {
            "label": "말했지만 여전히 어색함이 남는다",
            "nextNodeId": "envy-end-b"
          },
          {
            "label": "이 경험을 통해 스스로를 더 잘 이해하게 된다",
            "nextNodeId": "envy-end-a"
          }
        ]
      },
      "envy-suspect-dig": {
        "paragraphs": [
          "나는 며칠에 걸쳐 조용히 자료를 모았다. 비슷한 이전 작업물들을 캡처해뒀다.",
          "막상 증거를 모아놓고 보니, 확신이 서지 않았다. 우연한 유사성일 수도 있었다.",
          "나는 그 파일들을 폴더에 넣어두고, 한동안 열어보지 않았다.",
          "어느 날 그 폴더를 다시 열었을 때, 나는 이걸 왜 모으고 있었는지 스스로에게 물어야 했다."
        ],
        "choices": [
          {
            "label": "결국 그 자료로 문제를 제기한다",
            "nextNodeId": "envy-end-i"
          },
          {
            "label": "자료를 전부 삭제하고 포기한다",
            "nextNodeId": "envy-end-j"
          },
          {
            "label": "수아에게 직접 그 부분에 대해 물어본다",
            "nextNodeId": "envy-end-k"
          }
        ]
      },
      "envy-suspect-report": {
        "paragraphs": [
          "나는 익명으로 관련 부서에 문제를 제기했다. 심장이 오래 뛰었다.",
          "몇 주 뒤, 수아의 합격이 재검토에 들어갔다는 소문이 돌았다.",
          "수아에게서 연락이 왔다. \"나 지금 조사받고 있어. 누가 신고했나 봐.\" 목소리가 떨리고 있었다.",
          "나는 아무것도 모르는 척, 위로의 말을 건넸다. 그 말을 하는 내내 마음이 무거웠다."
        ],
        "choices": [
          {
            "label": "끝까지 익명으로 남기로 한다",
            "nextNodeId": "envy-end-l"
          },
          {
            "label": "결국 스스로 신고했다고 고백한다",
            "nextNodeId": "envy-end-m"
          },
          {
            "label": "조사 결과와 상관없이 이 일을 계기로 수아와 멀어진다",
            "nextNodeId": "envy-end-h"
          }
        ]
      },
      "envy-suspect-drop": {
        "paragraphs": [
          "나는 결국 아무 행동도 하지 않기로 했다. 확신도 없었고, 그 이후가 두렵기도 했다.",
          "수아는 아무것도 모른 채 새 직장에 잘 적응해갔다.",
          "나는 그 의심을 마음 한편에 묻어두기로 했다. 확인되지 않은 의심은, 계속 나를 따라다녔다.",
          "가끔 수아의 그 포트폴리오가 떠오를 때마다, 나는 애써 다른 생각을 한다."
        ],
        "choices": [
          {
            "label": "시간이 지나며 이 의심을 완전히 잊는다",
            "nextNodeId": "envy-end-j"
          },
          {
            "label": "여전히 마음 한편에서 계속 신경 쓰인다",
            "nextNodeId": "envy-end-n"
          },
          {
            "label": "언젠가 진실을 알게 될까 봐 불안해한다",
            "nextNodeId": "envy-end-n"
          }
        ]
      },
      "envy-end-a": {
        "ending": {
          "title": "질투를 지나 도착한 곳",
          "rarity": 20,
          "verdict": [
            "질투를 감추지 않고, 결국 자기 힘으로 나아갔군요.",
            "당신은 — 부러움을 동력으로 바꿀 줄 아는 사람.",
            "그 감정을 부끄러워하지 않는 법을, 이번에 배운 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결국 내 힘으로 다른 문을 열었다. 그 과정에서 배운 건, 질투도 나쁜 감정만은 아니라는 것이었다.",
          "수아와는 여전히 친구다. 각자의 자리에서, 서로를 진심으로 응원한다.",
          "부러움이 나를 움직이게 한 원동력이었다는 걸, 이제는 인정할 수 있다.",
          "그 감정을 부끄러워하지 않게 된 것, 그게 가장 큰 변화였다."
        ]
      },
      "envy-end-b": {
        "ending": {
          "title": "완전히 지워지지 않는 마음",
          "rarity": 22,
          "verdict": [
            "말끔히 지워지진 않는군요.",
            "당신은 — 감정이 남아있어도 관계는 이어가는 사람.",
            "완벽하게 정리되지 않아도 괜찮다는 걸, 배워가는 사람이고요."
          ]
        },
        "paragraphs": [
          "겉으로는 다 정리된 것처럼 보인다. 수아와도 잘 지내고, 내 삶에도 만족한다.",
          "그런데 가끔, 아주 가끔, 그때의 그 마음이 문득 떠오른다.",
          "완전히 사라지지 않는 감정도 있다는 걸, 이제는 받아들이기로 했다.",
          "그 마음과 함께 살아가는 법을 배우는 중이다."
        ]
      },
      "envy-end-c": {
        "ending": {
          "title": "숨기지 않아서 가까워진 사이",
          "rarity": 15,
          "verdict": [
            "감정을 숨기지 않고 꺼내놓았군요.",
            "당신은 — 솔직함이 관계를 더 단단하게 만든다고 믿는 사람.",
            "그 믿음이 맞았다는 걸, 지금 이 우정이 보여주는 사람이고요."
          ]
        },
        "paragraphs": [
          "솔직하게 말한 이후로, 나와 수아는 오히려 더 가까워졌다.",
          "질투도, 미안함도 다 꺼내놓고 나니, 숨길 게 없는 사이가 됐다.",
          "우리는 지금도 서로의 성취를 가장 먼저 축하해주는 친구다.",
          "감정을 숨기지 않는 게, 관계를 지키는 가장 좋은 방법이었다."
        ]
      },
      "envy-end-d": {
        "ending": {
          "title": "각자의 거리",
          "rarity": 18,
          "verdict": [
            "가깝지도, 멀지도 않은 거리를 택했군요.",
            "당신은 — 완전히 끊기보다 적당한 선을 긋는 사람.",
            "그 선이 언젠가 다시 좁혀질지는, 아직 모를 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 수아와 적당한 거리를 유지한 채 지낸다. 완전히 끊은 건 아니지만, 예전 같지도 않다.",
          "가끔 안부를 주고받는 정도. 그 이상으로 가까워지려 하지 않는다.",
          "이게 최선인지는 모르겠지만, 지금은 이 정도가 편하다.",
          "관계에도 유지 보수가 필요하다는 걸, 이번에 알았다."
        ]
      },
      "envy-end-e": {
        "ending": {
          "title": "다시 마주한 화면",
          "rarity": 13,
          "verdict": [
            "피하지 않고, 다시 마주 보는군요.",
            "당신은 — 불편함을 견디며 익숙해지는 쪽을 택하는 사람.",
            "그 견딤이 결국 회복으로 이어진다는 걸, 아는 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 뮤트를 풀고 수아의 SNS를 다시 봤다. 처음엔 불편했지만, 점점 익숙해졌다.",
          "수아의 성취를 보는 게, 예전만큼 아프지 않다는 걸 깨달은 순간이 있었다.",
          "완전히 극복했다고는 못 하겠지만, 적어도 도망치지는 않게 됐다.",
          "마주하는 것도 나름의 용기가 필요하다는 걸 배웠다."
        ]
      },
      "envy-end-f": {
        "ending": {
          "title": "도움을 청한 마음",
          "rarity": 9,
          "verdict": [
            "혼자 끙끙대지 않고, 도움을 청했군요.",
            "당신은 — 마음을 돌보는 데 주저함이 없는 사람.",
            "그 선택이 결국 스스로를 더 잘 이해하게 만든 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 이 마음을 혼자 감당하기 어려워, 상담을 받아보기로 했다.",
          "상담사와 이야기하며, 질투가 단순한 나쁜 감정이 아니라 내가 원하는 걸 알려주는 신호라는 걸 배웠다.",
          "수아와의 관계도, 내 마음도 조금씩 정리가 됐다.",
          "도움을 청하는 것도 용기라는 걸, 그때 알았다."
        ]
      },
      "envy-end-g": {
        "ending": {
          "title": "다시 걸어볼까 하는 마음",
          "rarity": 16,
          "verdict": [
            "끝난 건 아니지만, 아직 다시 시작하진 못했군요.",
            "당신은 — 마음은 있어도 행동은 미루는 사람.",
            "그 망설임 속에서도, 완전히 포기하진 않은 사람이고요."
          ]
        },
        "paragraphs": [
          "멀어진 지 한참이 지난 지금도, 가끔 수아에게 연락할까 고민한다.",
          "핸드폰을 만지작거리다가, 아직은 용기가 나지 않아 그만둔다.",
          "언젠가는 다시 연락할 수 있을 거라고, 스스로를 다독인다.",
          "그 언젠가가 언제일지는, 아직 나도 모른다."
        ]
      },
      "envy-end-h": {
        "ending": {
          "title": "멀어진 채로",
          "rarity": 8,
          "verdict": [
            "결국 다시 가까워지지 못했군요.",
            "당신은 — 끝난 관계를 억지로 붙잡지 않는 사람.",
            "그 끝을 받아들이는 데도, 나름의 용기가 필요했을 사람이고요."
          ]
        },
        "paragraphs": [
          "우리는 결국 다시 가까워지지 못했다. 각자의 삶을 사는 사이가 됐다.",
          "가끔 옛 사진첩에서 함께 찍은 사진을 본다. 그때가 그립기도 하다.",
          "관계는 끝났지만, 그 시절의 우정 자체를 후회하지는 않는다.",
          "모든 인연이 끝까지 가는 건 아니라는 걸, 받아들이기로 했다."
        ]
      },
      "envy-end-i": {
        "ending": {
          "title": "제기한 문제",
          "rarity": 5,
          "verdict": [
            "결국 이름을 걸고, 문제를 제기했군요.",
            "당신은 — 확신이 없어도 행동해야 한다고 믿는 사람.",
            "그 행동의 대가가 무엇이었는지는, 계속 곱씹게 될 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결국 모아둔 자료로 정식 문제를 제기했다. 익명이 아니라, 내 이름으로.",
          "수아는 그 사실을 알게 됐고, 우리 관계는 그날로 끝났다.",
          "조사 결과, 유사성은 인정됐지만 표절로 보긴 어렵다는 결론이 나왔다.",
          "나는 옳은 일을 했다고 믿고 싶지만, 그 확신이 매일 같지는 않다."
        ]
      },
      "envy-end-j": {
        "ending": {
          "title": "지워버린 의심",
          "rarity": 12,
          "verdict": [
            "결국 의심을, 스스로 지워버렸군요.",
            "당신은 — 확신 없는 의심을 오래 붙들지 않는 사람.",
            "그게 관계를 지키는 나름의 방법이었을 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결국 모든 자료를 지웠다. 이 의심을 더 붙잡고 있고 싶지 않았다.",
          "시간이 지나며 그때의 찜찜함도 서서히 옅어졌다.",
          "수아와는 여전히 잘 지낸다. 그 일은 나만 아는, 없었던 셈 치는 기억이 됐다.",
          "완전히 잊었다고 하면 거짓말이겠지만, 적어도 더는 마음을 갉아먹지 않는다."
        ]
      },
      "envy-end-k": {
        "ending": {
          "title": "직접 물어본 진실",
          "rarity": 14,
          "verdict": [
            "의심을 품고만 있지 않고, 직접 물어봤군요.",
            "당신은 — 확인되지 않은 걸 그냥 두지 못하는 사람.",
            "그 확인이 관계를 지켜줬다는 것도, 이제는 아는 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 수아에게 직접 물었다. \"그 부분, 어디서 영감을 받은 거야?\"",
          "수아는 순순히 설명해줬다. 알고 보니 같은 참고자료를 썼을 뿐, 우연이었다.",
          "괜한 의심을 했다는 게 부끄러웠지만, 물어보길 잘했다고 생각했다.",
          "확인하지 않은 의심은 언제나 실제보다 크게 자란다는 걸 배웠다."
        ]
      },
      "envy-end-l": {
        "ending": {
          "title": "끝까지 숨긴 이름",
          "rarity": 4,
          "verdict": [
            "끝까지, 이름을 밝히지 않는군요.",
            "당신은 — 책임을 드러내지 않고 감당하려는 사람.",
            "그 침묵의 무게가 얼마나 큰지, 아마 매일 느끼고 있을 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 끝까지 내가 신고했다는 걸 밝히지 않았다.",
          "수아는 결백이 밝혀져 무사히 넘어갔지만, 그 일로 한동안 힘들어했다.",
          "나는 위로하는 척하며 곁에 있었다. 그 이중적인 마음이 나를 계속 괴롭혔다.",
          "진실을 아는 건 나 하나뿐이고, 그 무게도 나 혼자 짊어지고 있다."
        ]
      },
      "envy-end-m": {
        "ending": {
          "title": "밝힌 이름, 끝난 우정",
          "rarity": 6,
          "verdict": [
            "결국 밝혔고, 그 대가로 우정을 잃었군요.",
            "당신은 — 숨기는 것보다 밝히는 걸 택하는 사람.",
            "옳음과 관계, 둘 다 지킬 수는 없었던 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결국 내가 신고했다고 수아에게 고백했다.",
          "수아는 충격받은 얼굴로 나를 바라봤다. \"…네가? 나한테 어떻게 그럴 수 있어.\"",
          "그 후로 우리는 다시 예전처럼 지내지 못했다. 우정은 그렇게 끝났다.",
          "옳은 일이었을지 몰라도, 그 방식이 맞았는지는 계속 자문하게 된다."
        ]
      },
      "envy-end-n": {
        "ending": {
          "title": "풀리지 않는 찜찜함",
          "rarity": 21,
          "verdict": [
            "풀지도, 놓지도 못한 채로 남겨두는군요.",
            "당신은 — 확신 없는 것들을 붙들고 사는 사람.",
            "그 찜찜함과 함께 지내는 법을, 천천히 익히는 중인 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 아무 행동도 하지 않았지만, 그 의심은 계속 마음 한편에 남아있다.",
          "수아를 볼 때마다, 나도 모르게 그 부분이 떠오른다.",
          "확인할 수도, 완전히 잊을 수도 없는 채로, 시간만 흘러간다.",
          "어떤 의심은 풀리지 않은 채로 그냥 오래 남기도 한다는 걸 알았다."
        ]
      }
    }
  },
  6: {
    "title": "여섯 번째 일기",
    "theme": 6,
    "startNodeId": "start",
    "nodes": {
      "start": {
        "dateLabel": "밤 11시",
        "paragraphs": [
          "남편이 잠든 걸 확인하고, 나는 조용히 부엌으로 갔다.",
          "냉장고 문을 열었다. 낮에 사둔 것들이 그대로 있었다. 아무도 모르게 사서, 아무도 모르게 먹고, 아무도 모르게 치우는 게 벌써 몇 달째다.",
          "첫입을 먹는 순간의 안도감과, 다 먹고 난 뒤의 자기혐오. 이 반복을 이제는 스스로도 어떻게 멈춰야 할지 모르겠다.",
          "그런데 오늘, 거실에서 인기척이 들렸다. 남편이 깬 것 같았다."
        ],
        "choices": [
          {
            "label": "얼른 먹던 걸 치우고 아무 일 없던 척한다",
            "nextNodeId": "glut-hide"
          },
          {
            "label": "이번엔 숨기지 않고 그냥 먹던 걸 보여준다",
            "nextNodeId": "glut-reveal"
          },
          {
            "label": "먹던 걸 그대로 두고 방으로 피한다",
            "nextNodeId": "glut-flee"
          }
        ]
      },
      "glut-hide": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "나는 재빨리 봉지들을 치우고 물을 마시는 척했다.",
          "남편이 부엌에 들어와 물었다. \"안 자고 뭐 해?\" 나는 목이 말라서 나왔다고 둘러댔다.",
          "남편은 별생각 없이 다시 방으로 들어갔다. 들키지 않았다는 안도감과, 또 숨겼다는 씁쓸함이 동시에 밀려왔다.",
          "다음 날, 나는 이 패턴을 어떻게든 끊어야겠다고 다짐했다. 하지만 다짐은 이번이 처음이 아니었다."
        ],
        "choices": [
          {
            "label": "병원이나 상담을 알아보기로 한다",
            "nextNodeId": "glut-hide-help"
          },
          {
            "label": "그냥 의지로 버텨보기로 한다",
            "nextNodeId": "glut-hide-willpower"
          },
          {
            "label": "또 다짐만 하고 아무것도 바꾸지 않는다",
            "nextNodeId": "glut-hide-repeat"
          }
        ]
      },
      "glut-reveal": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "나는 숨기지 않고 그대로 서 있었다. 남편이 부엌에 들어와 나를 봤다.",
          "남편은 잠시 아무 말도 하지 않았다. 그러다 조용히 물었다. \"…괜찮아? 요즘 무슨 일 있어?\"",
          "화를 낼 줄 알았는데, 걱정하는 눈빛이었다. 나는 그 자리에서 눈물이 났다.",
          "몇 달 만에 처음으로, 이 얘기를 누군가에게 꺼낼 수 있을 것 같았다."
        ],
        "choices": [
          {
            "label": "그동안의 마음을 다 털어놓는다",
            "nextNodeId": "glut-reveal-talk"
          },
          {
            "label": "괜찮다고 얼버무리고 넘어간다",
            "nextNodeId": "glut-reveal-deflect"
          },
          {
            "label": "같이 해결 방법을 찾아보자고 제안한다",
            "nextNodeId": "glut-reveal-together"
          }
        ]
      },
      "glut-flee": {
        "dateLabel": "그날 밤",
        "paragraphs": [
          "나는 먹던 것들을 그대로 두고 방으로 들어와 문을 닫았다.",
          "다음 날 아침, 부엌은 깨끗이 치워져 있었다. 남편이 정리한 것 같았다.",
          "남편은 그 일에 대해 아무 말도 하지 않았다. 나도 먼저 꺼내지 못했다.",
          "말하지 않은 그 밤이, 이상하게 우리 사이에 계속 걸려 있는 느낌이었다."
        ],
        "choices": [
          {
            "label": "먼저 그날 밤에 대해 이야기를 꺼낸다",
            "nextNodeId": "glut-flee-open"
          },
          {
            "label": "계속 그 일을 없었던 척한다",
            "nextNodeId": "glut-flee-avoid"
          },
          {
            "label": "혼자서라도 변화를 시도해본다",
            "nextNodeId": "glut-flee-alone"
          }
        ]
      },
      "glut-hide-help": {
        "paragraphs": [
          "나는 혼자 병원을 알아보고, 예약을 잡았다. 남편에게는 아직 말하지 못했다.",
          "첫 상담에서 나는 많이 울었다. 오랫동안 아무에게도 못 했던 이야기를 처음으로 꺼냈다.",
          "상담사는 이게 단순한 식탐이 아니라, 스트레스와 관련된 패턴일 수 있다고 했다.",
          "조금씩, 아주 조금씩 나아지고 있다는 걸 스스로 느끼기 시작했다."
        ],
        "choices": [
          {
            "label": "꾸준히 상담을 이어가며 나아진다",
            "nextNodeId": "glut-end-a"
          },
          {
            "label": "남편에게도 이 사실을 알린다",
            "nextNodeId": "glut-end-b"
          },
          {
            "label": "상담 중에도 여전히 힘든 날들이 있다",
            "nextNodeId": "glut-end-c"
          }
        ]
      },
      "glut-hide-willpower": {
        "paragraphs": [
          "나는 그날부터 냉장고에 아무것도 사두지 않기로 했다. 의지로 버텨보기로 했다.",
          "며칠은 괜찮았다. 하지만 힘든 하루를 보낸 밤, 나는 결국 편의점까지 걸어갔다.",
          "의지만으로는 안 된다는 걸, 다시 한번 확인한 밤이었다.",
          "실패했다는 자책이 몰려왔지만, 이번엔 조금 다르게 생각해보기로 했다. 의지의 문제가 아닐 수도 있다고."
        ],
        "choices": [
          {
            "label": "결국 전문가의 도움을 찾기로 한다",
            "nextNodeId": "glut-end-a"
          },
          {
            "label": "자책 속에서 같은 패턴을 반복한다",
            "nextNodeId": "glut-end-d"
          },
          {
            "label": "스스로에게 조금 더 너그러워지기로 한다",
            "nextNodeId": "glut-end-e"
          }
        ]
      },
      "glut-hide-repeat": {
        "paragraphs": [
          "다짐은 또 흐지부지됐다. 며칠 뒤, 나는 다시 같은 밤을 보내고 있었다.",
          "이 패턴이 반복될수록, 나 자신에게 실망하는 마음도 커졌다.",
          "남편은 여전히 눈치채지 못한 것 같았다. 아니, 어쩌면 눈치챘지만 모르는 척하는 걸 수도 있었다.",
          "어느 쪽이든, 나는 이 문제를 계속 혼자 짊어지고 있었다."
        ],
        "choices": [
          {
            "label": "결국 더는 못 버티고 도움을 요청한다",
            "nextNodeId": "glut-end-b"
          },
          {
            "label": "이대로 몇 달을 더 반복한다",
            "nextNodeId": "glut-end-d"
          },
          {
            "label": "혼자 인터넷으로 방법을 찾아 조금씩 시도한다",
            "nextNodeId": "glut-end-e"
          }
        ]
      },
      "glut-reveal-talk": {
        "paragraphs": [
          "나는 그동안의 스트레스, 외로움, 반복되는 밤들에 대해 다 이야기했다.",
          "남편은 조용히 들어줬다. 다 듣고 나서 말했다. \"말해줘서 고마워. 나도 몰랐어서 미안해.\"",
          "우리는 그날 늦게까지 이야기를 나눴다. 처음으로 이 문제를 ‘우리’의 일로 만든 밤이었다.",
          "모든 게 한 번에 해결되진 않았지만, 더는 혼자가 아니라는 게 컸다."
        ],
        "choices": [
          {
            "label": "함께 병원을 찾아가기로 한다",
            "nextNodeId": "glut-end-b"
          },
          {
            "label": "대화만으로도 마음이 한결 가벼워진다",
            "nextNodeId": "glut-end-f"
          },
          {
            "label": "여전히 혼자 해결하고 싶은 마음도 남아있다",
            "nextNodeId": "glut-end-c"
          }
        ]
      },
      "glut-reveal-deflect": {
        "paragraphs": [
          "막상 말할 기회가 왔는데, 나는 \"그냥 배고파서\"라고 얼버무렸다.",
          "남편은 더 캐묻지 않고 넘어갔다. 그 순간은 넘어갔지만, 마음은 편하지 않았다.",
          "기회가 있었는데 놓쳤다는 아쉬움이 오래 남았다.",
          "다음엔 꼭 말해야겠다고 생각했지만, 그 ‘다음’이 언제일지는 알 수 없었다."
        ],
        "choices": [
          {
            "label": "다음 기회에는 꼭 이야기하기로 마음먹는다",
            "nextNodeId": "glut-end-e"
          },
          {
            "label": "이후로도 계속 숨기게 된다",
            "nextNodeId": "glut-end-d"
          },
          {
            "label": "결국 편지로라도 마음을 전한다",
            "nextNodeId": "glut-end-f"
          }
        ]
      },
      "glut-reveal-together": {
        "paragraphs": [
          "나는 남편에게 같이 방법을 찾아보자고 제안했다. 남편은 흔쾌히 그러자고 했다.",
          "우리는 함께 상담 센터를 알아보고, 예약도 같이 잡았다.",
          "혼자였다면 시작하지 못했을 일을, 둘이라서 시작할 수 있었다.",
          "완치까지는 시간이 걸리겠지만, 적어도 이제는 혼자 걷는 길이 아니었다."
        ],
        "choices": [
          {
            "label": "함께 꾸준히 상담을 이어간다",
            "nextNodeId": "glut-end-b"
          },
          {
            "label": "중간에 지치는 순간도 있지만 포기하지 않는다",
            "nextNodeId": "glut-end-f"
          },
          {
            "label": "남편에게 의지하는 게 미안해지기도 한다",
            "nextNodeId": "glut-end-c"
          }
        ]
      },
      "glut-flee-open": {
        "paragraphs": [
          "나는 며칠 뒤, 먼저 그날 밤 얘기를 꺼냈다. \"그때… 봤지?\"",
          "남편이 고개를 끄덕였다. \"말 안 해줘서 서운했던 것보단, 걱정이 더 컸어.\"",
          "우리는 그제야 제대로 이야기를 나눌 수 있었다. 늦었지만, 늦지 않은 대화였다.",
          "먼저 문을 여는 데 며칠이 걸렸지만, 그 며칠도 의미가 있었다고 생각하기로 했다."
        ],
        "choices": [
          {
            "label": "이 대화를 계기로 도움을 찾기 시작한다",
            "nextNodeId": "glut-end-b"
          },
          {
            "label": "말은 했지만 여전히 조심스러운 사이가 된다",
            "nextNodeId": "glut-end-c"
          },
          {
            "label": "서로에 대한 신뢰가 오히려 더 깊어진다",
            "nextNodeId": "glut-end-f"
          }
        ]
      },
      "glut-flee-avoid": {
        "paragraphs": [
          "나는 그 밤에 대해 다시는 꺼내지 않았다. 남편도 마찬가지였다.",
          "우리 사이엔 말하지 않은 것들이 하나씩 쌓여갔다. 겉으로는 평온해 보이지만, 속은 그렇지 않았다.",
          "가끔 그 밤이 떠오를 때마다, 나는 애써 다른 생각을 한다.",
          "언제까지 이렇게 피할 수 있을지, 스스로도 확신이 없다."
        ],
        "choices": [
          {
            "label": "결국 한계에 부딪혀 이야기를 꺼내게 된다",
            "nextNodeId": "glut-end-b"
          },
          {
            "label": "이 침묵이 계속 이어진다",
            "nextNodeId": "glut-end-d"
          },
          {
            "label": "혼자서라도 조금씩 변화를 시도한다",
            "nextNodeId": "glut-end-e"
          }
        ]
      },
      "glut-flee-alone": {
        "paragraphs": [
          "나는 아무에게도 말하지 않은 채, 혼자 식습관 관련 책을 찾아 읽기 시작했다.",
          "조금씩 패턴을 기록하고, 스트레스가 심한 날을 미리 대비하는 연습을 했다.",
          "완벽하진 않았지만, 조금씩 나아지는 게 스스로 느껴졌다.",
          "언젠가는 이 이야기를 남편에게도 할 수 있을 것 같다는 생각이 들었다."
        ],
        "choices": [
          {
            "label": "결국 남편에게도 이야기하게 된다",
            "nextNodeId": "glut-end-f"
          },
          {
            "label": "혼자만의 방식으로 계속 나아간다",
            "nextNodeId": "glut-end-e"
          },
          {
            "label": "가끔 다시 예전 패턴으로 돌아가기도 한다",
            "nextNodeId": "glut-end-c"
          }
        ]
      },
      "glut-end-a": {
        "ending": {
          "title": "혼자 걸어간 회복",
          "rarity": 18,
          "verdict": [
            "혼자서라도, 회복의 길을 걷기 시작했군요.",
            "당신은 — 남에게 기대기 전에 스스로 먼저 움직이는 사람.",
            "그 첫걸음이 얼마나 큰 용기였는지, 아마 본인만 알 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 계속 혼자 상담을 이어갔다. 남편에게는 끝내 말하지 못했지만, 스스로 조금씩 나아지고 있었다.",
          "밤마다 반복되던 패턴이 완전히 사라지진 않았지만, 빈도는 확실히 줄었다.",
          "언젠가는 이 얘기를 나눌 수 있을 거라 믿으며, 지금은 내 속도대로 걷기로 했다.",
          "혼자 시작한 회복이지만, 혼자라서 못 하는 건 아니라는 걸 배웠다."
        ]
      },
      "glut-end-b": {
        "ending": {
          "title": "함께 걷는 길",
          "rarity": 21,
          "verdict": [
            "혼자가 아니라, 함께 걷는 쪽을 택했군요.",
            "당신은 — 도움을 받아들일 줄 아는 사람.",
            "그 선택이 회복의 속도를 바꿔놓은 사람이고요."
          ]
        },
        "paragraphs": [
          "우리는 함께 병원을 다니기 시작했다. 남편은 상담일마다 데려다주고, 끝나면 같이 저녁을 먹었다.",
          "혼자였다면 몇 번이고 포기했을 텐데, 함께라서 계속할 수 있었다.",
          "패턴은 여전히 완전히 사라지지 않았지만, 이제는 숨기지 않아도 된다는 것만으로도 큰 변화였다.",
          "회복은 느리지만, 더는 혼자 걷는 길이 아니었다."
        ]
      },
      "glut-end-c": {
        "ending": {
          "title": "여전히 힘든 밤들",
          "rarity": 24,
          "verdict": [
            "여전히 힘든 날이 있다는 걸, 숨기지 않는군요.",
            "당신은 — 완치보다 과정을 받아들이는 사람.",
            "좋은 날도 나쁜 날도 다 자신의 일부라고 여기는 사람이고요."
          ]
        },
        "paragraphs": [
          "상담도 받고, 대화도 나눴지만, 여전히 힘든 밤이 찾아온다.",
          "완전히 나아졌다고 말할 순 없지만, 적어도 예전처럼 혼자 숨기지는 않는다.",
          "좋은 날과 나쁜 날이 반복된다. 그게 회복의 실제 모습이라는 걸 이제는 안다.",
          "완벽하지 않아도 괜찮다고, 스스로에게 말해주는 연습을 하고 있다."
        ]
      },
      "glut-end-d": {
        "ending": {
          "title": "반복되는 밤",
          "rarity": 14,
          "verdict": [
            "끊어내지 못한 채로, 계속 반복하는군요.",
            "당신은 — 알면서도 쉽게 벗어나지 못하는 패턴 안에 있는 사람.",
            "그 반복 속에서도 일기를 놓지 않는 건, 아직 포기하지 않은 사람이고요."
          ]
        },
        "paragraphs": [
          "다짐도, 시도도 여러 번 있었지만, 패턴은 좀처럼 바뀌지 않았다.",
          "같은 밤이 계속 반복된다. 자책도 이제는 익숙해질 지경이다.",
          "이 굴레를 언젠가는 끊어야 한다는 걸 알면서도, 오늘 밤도 나는 부엌으로 향한다.",
          "그래도 이 일기를 계속 쓰는 건, 완전히 포기하진 않았다는 뜻이라고 믿고 싶다."
        ]
      },
      "glut-end-e": {
        "ending": {
          "title": "스스로에게 너그러워지는 법",
          "rarity": 15,
          "verdict": [
            "스스로를 다그치기보다, 너그러워지는 쪽을 택했군요.",
            "당신은 — 완벽함보다 자기 이해를 우선하는 사람.",
            "그 다정함이 오히려 가장 효과적인 방법이었다는 걸 알게 된 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 완벽하게 끊으려 하기보다, 스스로에게 조금 너그러워지는 연습을 시작했다.",
          "실패한 밤에도 자책 대신, ‘그럴 수도 있지’라고 말해주려 애썼다.",
          "신기하게도, 자책을 줄이자 오히려 패턴도 조금씩 줄어들었다.",
          "완벽함이 아니라 너그러움이 회복의 시작이었다는 걸, 뒤늦게 알았다."
        ]
      },
      "glut-end-f": {
        "ending": {
          "title": "말하고 나서 가벼워진 마음",
          "rarity": 8,
          "verdict": [
            "숨기던 걸, 결국 다 꺼내놓았군요.",
            "당신은 — 혼자 짊어지기보다 나누는 쪽을 택하는 사람.",
            "그 선택이 생각보다 훨씬 가벼운 결과로 돌아온 사람이고요."
          ]
        },
        "paragraphs": [
          "결국 나는 이 모든 걸 남편에게 털어놓았다. 두려워했던 것과 달리, 남편은 있는 그대로 받아들여줬다.",
          "말하고 나니, 혼자 짊어졌던 무게가 조금은 가벼워졌다.",
          "패턴이 완전히 사라진 건 아니지만, 이제는 숨길 이유가 없다는 것만으로도 다른 삶이었다.",
          "가장 무서웠던 건 들키는 게 아니라, 계속 혼자였다는 사실이었다는 걸 그제야 알았다."
        ]
      }
    }
  },
  7: {
    "title": "일곱 번째 일기",
    "theme": 7,
    "startNodeId": "start",
    "nodes": {
      "start": {
        "dateLabel": "회의 다음 날",
        "paragraphs": [
          "어제 회의에서, 팀장은 지난주 오류의 책임을 은지에게 돌렸다.",
          "사실 그 오류는 내가 낸 거였다. 은지는 그저 마지막에 파일을 전달했을 뿐이다.",
          "나는 그 자리에서 아무 말도 하지 않았다. 회의는 그렇게 끝났다.",
          "은지는 억울한 표정이었지만, 아무에게도 따지지 않고 조용히 자리로 돌아갔다."
        ],
        "choices": [
          {
            "label": "지금이라도 팀장에게 사실대로 말한다",
            "nextNodeId": "sloth-tell"
          },
          {
            "label": "은지에게만 조용히 사과한다",
            "nextNodeId": "sloth-apologize"
          },
          {
            "label": "아무 말도 하지 않고 넘어간다",
            "nextNodeId": "sloth-silent"
          }
        ]
      },
      "sloth-tell": {
        "dateLabel": "그날 오후",
        "paragraphs": [
          "나는 팀장을 따로 찾아가 말했다. \"어제 그 오류, 사실 제 실수였습니다.\"",
          "팀장은 잠깐 놀라더니 물었다. \"그럼 왜 어제 말하지 않았어요?\"",
          "나는 마땅한 대답을 찾지 못했다. \"…죄송합니다\"라는 말만 반복했다.",
          "팀장은 알겠다고 했지만, 표정에서 약간의 실망이 스치는 걸 느꼈다."
        ],
        "choices": [
          {
            "label": "은지에게도 직접 찾아가 사과한다",
            "nextNodeId": "sloth-tell-apologize"
          },
          {
            "label": "정정된 것으로 만족하고 넘어간다",
            "nextNodeId": "sloth-tell-done"
          },
          {
            "label": "앞으로는 절대 이런 일이 없게 하겠다고 다짐한다",
            "nextNodeId": "sloth-tell-vow"
          }
        ]
      },
      "sloth-apologize": {
        "dateLabel": "그날 오후",
        "paragraphs": [
          "나는 은지를 따로 불러 말했다. \"어제 그거, 사실 내 실수였어. 미안해.\"",
          "은지는 잠시 나를 보다가 말했다. \"…그럼 팀장님한테는 말 안 할 거야?\"",
          "나는 선뜻 대답하지 못했다. 은지의 표정이 조금씩 굳어가는 게 보였다.",
          "은지가 먼저 말했다. \"네가 편한 대로 해. 근데 나는, 이미 오해받은 채로 넘어가고 싶진 않아.\""
        ],
        "choices": [
          {
            "label": "은지의 말을 듣고 팀장에게도 알린다",
            "nextNodeId": "sloth-tell-apologize"
          },
          {
            "label": "은지에게 미안하다고만 하고 넘어간다",
            "nextNodeId": "sloth-apologize-stop"
          },
          {
            "label": "다음 기회에 말하겠다고 미룬다",
            "nextNodeId": "sloth-apologize-delay"
          }
        ]
      },
      "sloth-silent": {
        "dateLabel": "며칠 후",
        "paragraphs": [
          "나는 결국 아무 말도 하지 않았다. 시간이 지나면 자연스레 잊힐 거라 생각했다.",
          "하지만 은지는 그 뒤로도 팀 안에서 은근한 눈초리를 받는 것 같았다.",
          "나는 그걸 보면서도, 매번 ‘오늘은 아니야’라고 되뇌었다.",
          "그렇게 이 주가 지났다. 말할 타이밍은 점점 더 찾기 어려워졌다."
        ],
        "choices": [
          {
            "label": "더 늦기 전에 지금이라도 말한다",
            "nextNodeId": "sloth-silent-late"
          },
          {
            "label": "이제 와서 말하기엔 너무 늦었다고 생각하고 포기한다",
            "nextNodeId": "sloth-silent-give"
          },
          {
            "label": "은지에게 다른 방식으로라도 도움이 되려 한다",
            "nextNodeId": "sloth-silent-help"
          }
        ]
      },
      "sloth-tell-apologize": {
        "paragraphs": [
          "나는 은지를 찾아가 말했다. \"팀장님께 사실대로 말씀드렸어. 진작 그랬어야 했는데, 미안해.\"",
          "은지는 놀란 표정이었다가, 이내 옅게 웃었다. \"고마워. 늦었지만, 그래도 말해줘서.\"",
          "우리 사이의 어색함은 완전히 풀리진 않았지만, 조금씩 나아졌다.",
          "용기를 내는 데 하루가 걸렸지만, 그 하루가 관계를 되돌릴 수 있었다."
        ],
        "choices": [
          {
            "label": "이후로 은지와 신뢰를 회복해간다",
            "nextNodeId": "sloth-end-a"
          },
          {
            "label": "미안함이 계속 마음에 남는다",
            "nextNodeId": "sloth-end-b"
          },
          {
            "label": "이 경험을 계기로 더 적극적인 사람이 되기로 한다",
            "nextNodeId": "sloth-end-c"
          }
        ]
      },
      "sloth-tell-done": {
        "paragraphs": [
          "정정은 됐고, 나는 그걸로 할 일을 다 했다고 생각했다.",
          "은지에게 따로 사과하지는 않았다. 굳이 그럴 필요까진 없다고 생각했다.",
          "은지는 명예를 회복했지만, 나와는 이전보다 조금 서먹한 사이가 됐다.",
          "필요한 절차는 다 밟았는데, 뭔가 빠뜨린 게 있다는 느낌이 계속 남았다."
        ],
        "choices": [
          {
            "label": "뒤늦게라도 은지에게 사과한다",
            "nextNodeId": "sloth-end-a"
          },
          {
            "label": "이 서먹함을 그냥 받아들인다",
            "nextNodeId": "sloth-end-d"
          },
          {
            "label": "다음부터는 더 신경 쓰기로 다짐한다",
            "nextNodeId": "sloth-end-c"
          }
        ]
      },
      "sloth-tell-vow": {
        "paragraphs": [
          "나는 다시는 이런 일이 없도록, 스스로 다짐했다. 매사에 더 신중해지기로.",
          "그 다짐은 이후의 업무 태도에도 조금씩 영향을 미쳤다.",
          "은지와는 자연스럽게 다시 편해졌다. 시간이 그 사이를 메꿔준 것 같았다.",
          "한 번의 실수와 침묵이, 결국 나를 조금 더 책임감 있는 사람으로 만들었다."
        ],
        "choices": [
          {
            "label": "이 다짐을 꾸준히 지켜나간다",
            "nextNodeId": "sloth-end-c"
          },
          {
            "label": "시간이 지나며 다짐이 흐려진다",
            "nextNodeId": "sloth-end-e"
          },
          {
            "label": "은지와도 완전히 예전 관계를 회복한다",
            "nextNodeId": "sloth-end-a"
          }
        ]
      },
      "sloth-apologize-stop": {
        "paragraphs": [
          "나는 은지에게 미안하다고만 하고, 팀장에게는 끝내 알리지 않았다.",
          "은지는 실망한 기색이 역력했지만, 더는 캐묻지 않았다.",
          "그날 이후로 은지는 나를 대하는 태도가 눈에 띄게 달라졌다.",
          "사과했다고 생각했는데, 은지에게는 사과가 아니었던 것 같다."
        ],
        "choices": [
          {
            "label": "뒤늦게라도 팀장에게 사실대로 말한다",
            "nextNodeId": "sloth-end-a"
          },
          {
            "label": "이대로 관계가 서먹해진 채로 지낸다",
            "nextNodeId": "sloth-end-d"
          },
          {
            "label": "은지에게 다시 한번 진심으로 이야기해본다",
            "nextNodeId": "sloth-end-f"
          }
        ]
      },
      "sloth-apologize-delay": {
        "paragraphs": [
          "나는 다음 기회에 말하겠다고 스스로에게 약속했다. 하지만 그 다음은 좀처럼 오지 않았다.",
          "은지는 점점 나에게 거리를 뒀다. 예전처럼 편하게 대화하는 일이 줄었다.",
          "미루는 게 습관이 됐다는 걸, 그제야 깨달았다.",
          "이번에도 결국 말하지 못한 채로, 시간만 흘려보내고 있다."
        ],
        "choices": [
          {
            "label": "더 미루지 않고 결국 말한다",
            "nextNodeId": "sloth-end-a"
          },
          {
            "label": "결국 끝까지 말하지 못한다",
            "nextNodeId": "sloth-end-g"
          },
          {
            "label": "말 대신 행동으로라도 미안함을 표현하려 한다",
            "nextNodeId": "sloth-end-f"
          }
        ]
      },
      "sloth-silent-late": {
        "paragraphs": [
          "이 주가 지난 뒤에야, 나는 팀장을 찾아가 뒤늦게 사실대로 말했다.",
          "팀장은 \"왜 이렇게 오래 걸렸어요\"라고 물었다. 나는 딱히 할 말이 없었다.",
          "은지에게도 뒤늦은 사과를 전했다. 은지는 \"이제라도 말해줘서 다행이야\"라고 했다.",
          "늦은 정직함도, 하지 않은 것보다는 나았다고 믿고 싶다."
        ],
        "choices": [
          {
            "label": "늦었지만 관계를 회복해간다",
            "nextNodeId": "sloth-end-b"
          },
          {
            "label": "늦어버린 것에 대한 죄책감이 오래 남는다",
            "nextNodeId": "sloth-end-e"
          },
          {
            "label": "이 일을 계기로 미루는 습관을 고치려 애쓴다",
            "nextNodeId": "sloth-end-c"
          }
        ]
      },
      "sloth-silent-give": {
        "paragraphs": [
          "나는 결국 포기했다. 이제 와서 말해봐야 어색하기만 할 거라고 스스로를 설득했다.",
          "은지는 결국 그 오해를 안은 채로 팀에서 지내게 됐다.",
          "나는 아무 일도 없었다는 듯 일상을 이어갔지만, 가끔 죄책감이 불쑥 올라왔다.",
          "말하지 않은 것들은 사라지지 않고, 그냥 마음 어딘가에 계속 쌓여 있었다."
        ],
        "choices": [
          {
            "label": "이 죄책감을 안고 계속 지낸다",
            "nextNodeId": "sloth-end-g"
          },
          {
            "label": "결국 더 참지 못하고 뒤늦게라도 말한다",
            "nextNodeId": "sloth-end-b"
          },
          {
            "label": "다른 방식으로 은지에게 보상하려 한다",
            "nextNodeId": "sloth-end-f"
          }
        ]
      },
      "sloth-silent-help": {
        "paragraphs": [
          "나는 팀장에게 직접 말하는 대신, 은지가 맡은 다른 업무를 적극적으로 도왔다.",
          "은지는 처음엔 의아해했지만, 점차 내 도움을 편하게 받아들였다.",
          "직접적인 사과는 아니었지만, 행동으로나마 미안함을 갚고 싶었다.",
          "완벽한 해결은 아니었어도, 아무것도 안 하는 것보다는 나았다고 생각한다."
        ],
        "choices": [
          {
            "label": "이 방식이 은지와의 관계를 서서히 회복시킨다",
            "nextNodeId": "sloth-end-f"
          },
          {
            "label": "결국엔 말로도 직접 사과하게 된다",
            "nextNodeId": "sloth-end-a"
          },
          {
            "label": "행동만으로는 부족했다는 걸 깨닫는다",
            "nextNodeId": "sloth-end-g"
          }
        ]
      },
      "sloth-end-a": {
        "ending": {
          "title": "되찾은 신뢰",
          "rarity": 19,
          "verdict": [
            "결국은, 말과 행동 모두로 되갚았군요.",
            "당신은 — 늦어도 끝까지 책임지는 사람.",
            "그 책임감이 관계를 다시 되돌려놓은 사람이고요."
          ]
        },
        "paragraphs": [
          "결국 나는 말과 행동 모두로 은지에게 사과했고, 팀장에게도 사실을 알렸다.",
          "시간이 걸렸지만, 은지와의 관계는 서서히 예전으로 돌아왔다.",
          "침묵했던 시간이 후회로 남지만, 그 후회가 결국 나를 움직이게 했다.",
          "다음엔 망설이지 않기로, 스스로와 약속했다."
        ]
      },
      "sloth-end-b": {
        "ending": {
          "title": "늦었지만 닿은 진심",
          "rarity": 22,
          "verdict": [
            "늦었지만, 결국 닿았군요.",
            "당신은 — 타이밍을 놓쳐도 포기하지 않는 사람.",
            "그 뒤늦음마저도, 안 하는 것보단 낫다고 믿는 사람이고요."
          ]
        },
        "paragraphs": [
          "뒤늦게 전한 사과였지만, 은지는 그걸 받아들여줬다.",
          "완전히 예전 같지는 않아도, 우리는 다시 대화를 나누는 사이가 됐다.",
          "늦은 정직함도 아예 없는 것보다는 낫다는 걸, 이번에 배웠다.",
          "다음부터는 이렇게까지 늦지 않기로 다짐했다."
        ]
      },
      "sloth-end-c": {
        "ending": {
          "title": "달라지기로 한 사람",
          "rarity": 17,
          "verdict": [
            "이 일을 계기로, 다른 사람이 되기로 했군요.",
            "당신은 — 실수에서 배워 스스로를 바꾸는 사람.",
            "그 변화가 다음번엔 다른 선택을 하게 만들 사람이고요."
          ]
        },
        "paragraphs": [
          "이 일을 계기로, 나는 침묵하는 대신 목소리를 내는 사람이 되기로 했다.",
          "작은 일에도 책임을 미루지 않으려 노력하기 시작했다.",
          "은지와의 관계도, 시간이 지나며 자연스럽게 회복됐다.",
          "한 번의 침묵이 아프게 가르쳐준 교훈을, 잊지 않기로 했다."
        ]
      },
      "sloth-end-d": {
        "ending": {
          "title": "서먹해진 채로",
          "rarity": 14,
          "verdict": [
            "절차는 끝났지만, 관계는 그대로 남았군요.",
            "당신은 — 해야 할 일과 관계의 회복을 다르게 보는 사람.",
            "그 둘 사이의 간극을, 아직 다 메우지 못한 사람이고요."
          ]
        },
        "paragraphs": [
          "절차상으로는 다 해결됐지만, 은지와 나 사이엔 미묘한 거리가 남았다.",
          "우리는 여전히 같은 팀에서 일하지만, 예전 같은 편안함은 아니다.",
          "필요한 걸 다 했다고 생각했는데, 관계는 서류처럼 깔끔하게 정리되지 않았다.",
          "무엇을 더 했어야 했는지, 아직도 정확히 모르겠다."
        ]
      },
      "sloth-end-e": {
        "ending": {
          "title": "남은 죄책감",
          "rarity": 11,
          "verdict": [
            "정정은 했지만, 죄책감은 남는군요.",
            "당신은 — 결과보다 그 사이의 시간을 더 무겁게 느끼는 사람.",
            "그 무게를 스스로 계속 지고 가는 사람이고요."
          ]
        },
        "paragraphs": [
          "결국 정정하긴 했지만, 그 며칠간의 침묵은 계속 마음에 남았다.",
          "은지는 괜찮다고 했지만, 나는 스스로를 쉽게 용서하지 못했다.",
          "이 죄책감이 완전히 사라지진 않겠지만, 다음엔 더 빨리 움직이겠다고 다짐한다.",
          "실수보다 무거운 건, 그 실수를 알고도 미뤘던 시간이라는 걸 알았다."
        ]
      },
      "sloth-end-f": {
        "ending": {
          "title": "말 대신 행동으로",
          "rarity": 13,
          "verdict": [
            "말 대신, 행동으로 갚으려 했군요.",
            "당신은 — 표현이 서툴러도 마음은 다하는 사람.",
            "그 방식이 결국 상대에게도 닿았다는 걸, 확인한 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 끝내 직접적인 사과의 말은 다 하지 못했지만, 행동으로 계속 미안함을 갚아나갔다.",
          "은지도 점차 그 마음을 알아채고, 다시 편하게 대해주기 시작했다.",
          "말보다 행동이 더 진심을 전할 때도 있다는 걸, 이번에 느꼈다.",
          "완벽한 해결은 아니었지만, 우리는 나름의 방식으로 화해했다."
        ]
      },
      "sloth-end-g": {
        "ending": {
          "title": "끝내 하지 못한 말",
          "rarity": 4,
          "verdict": [
            "결국, 끝까지 하지 못했군요.",
            "당신은 — 알면서도 행동으로 옮기지 못할 때가 있는 사람.",
            "그 후회를 안고 있다는 것 자체가, 아직 마음 쓰고 있다는 증거인 사람이고요."
          ]
        },
        "paragraphs": [
          "나는 결국 끝까지 제대로 된 사과도, 정정도 하지 못했다.",
          "은지와는 시간이 지나며 자연스럽게 멀어졌다. 같은 팀이지만, 필요한 말만 나누는 사이가 됐다.",
          "가끔 그때를 떠올리면, 왜 그렇게 못 했을까 하는 후회가 밀려온다.",
          "이 일기에 쓰는 것 말고는, 아직 이 마음을 어디에도 꺼내지 못했다."
        ]
      }
    }
  },
};

// 공개일 도래 전엔 book 존재 여부조차 확인해줄 필요 없음(locked만 반환) —
// 로그인 불필요(읽기 전용 공개 콘텐츠, your_story 피드 조회와 동일 원칙).
exports.getDiaryBook = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    const book_id = Number(data.book_id);
    if (!Number.isInteger(book_id) || !(book_id in DIARY_RELEASE_DATES)) {
      return { ok: false, error: '존재하지 않는 책이에요.' };
    }
    const releaseDate = DIARY_RELEASE_DATES[book_id];
    if (releaseDate) {
      const kstToday = _kstDateStr(new Date().toISOString());
      if (kstToday < releaseDate) return { ok: false, locked: true, error: '아직 공개되지 않았어요.' };
    }
    const book = DIARY_STORY_DATA[book_id];
    if (!book) return { ok: false, error: '아직 콘텐츠가 준비되지 않았어요.' };
    return { ok: true, book };
  });

// 애널리틱스 대시보드용 — diary_ending_reached(book_id_node_id별 순수 카운터,
// project_hwasee_kakao_adfit 메모리 참고: rarity% 실측 대신 표본 확인용으로만
// 쌓는 중)를 책별로 합산 + 결말별 상세로 반환. 책 제목/결말 제목은
// DIARY_STORY_DATA에서 조인해 그래프 라벨을 읽기 좋게 만듦.
exports.getDiaryEndingStats = functions
  .region('asia-northeast3')
  .https.onCall(async (data) => {
    await _requireAdmin(data.user_id, data.token);
    const db = admin.firestore();
    const snap = await db.collection('diary_ending_reached').get();
    const byBookMap = {};
    const byEnding = [];
    snap.docs.forEach(doc => {
      const d = doc.data();
      const book_id = Number(d.book_id);
      const count = Number(d.count) || 0;
      byBookMap[book_id] = (byBookMap[book_id] || 0) + count;
      const book = DIARY_STORY_DATA[book_id];
      const node = book && book.nodes && book.nodes[d.node_id];
      byEnding.push({
        book_id, node_id: d.node_id, count,
        book_title: book ? book.title : `${book_id}권`,
        ending_title: (node && node.ending && node.ending.title) || d.node_id,
      });
    });
    const by_book = Object.keys(byBookMap).map(k => ({
      book_id: Number(k),
      book_title: (DIARY_STORY_DATA[k] && DIARY_STORY_DATA[k].title) || `${k}권`,
      total: byBookMap[k],
    })).sort((a, b) => a.book_id - b.book_id);
    byEnding.sort((a, b) => a.book_id - b.book_id || b.count - a.count);
    return { ok: true, by_book, by_ending: byEnding, generated_at: new Date().toISOString() };
  });
