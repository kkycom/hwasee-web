const functions = require('firebase-functions');
const admin     = require('firebase-admin');
admin.initializeApp();

// notifications 컬렉션에 문서 생성될 때마다 해당 유저에게 FCM 푸시 발송
exports.sendPushOnNotification = functions
  .region('asia-northeast3')
  .firestore.document('notifications/{notifId}')
  .onCreate(async snap => {
    const notif = snap.data();
    if (!notif.user_id) return null;

    const userSnap = await admin.firestore().collection('users').doc(notif.user_id).get();
    if (!userSnap.exists) return null;

    const fcmToken = userSnap.data().fcm_token;
    if (!fcmToken) return null;

    const link = notif.story_id
      ? `https://hwasee.me/bang/#story:${notif.story_id}`
      : 'https://hwasee.me/bang/';

    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: {
          title: '화씨.방',
          body: notif.message,
        },
        webpush: {
          notification: {
            icon: 'https://hwasee.me/bang/icon-192.png',
            badge: 'https://hwasee.me/bang/icon-192.png',
          },
          fcmOptions: { link },
        },
      });
    } catch (e) {
      // 토큰 만료/삭제된 경우 Firestore에서 제거
      if (e.code === 'messaging/registration-token-not-registered') {
        await admin.firestore().collection('users').doc(notif.user_id).update({ fcm_token: admin.firestore.FieldValue.delete() });
      }
    }
    return null;
  });
