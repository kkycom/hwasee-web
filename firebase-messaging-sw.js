importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyB5jojts7ppAoQ8ycQ9YOzB-79doP6Cebc",
  authDomain: "hwasee-bang.firebaseapp.com",
  projectId: "hwasee-bang",
  storageBucket: "hwasee-bang.firebasestorage.app",
  messagingSenderId: "216731930626",
  appId: "1:216731930626:web:81dcf18e763bf65f40971b"
});

const messaging = firebase.messaging();

// 홈 화면에 설치된 웹앱(PWA)이 /bang/sw.js 대신 기본 경로(사이트 루트의
// firebase-messaging-sw.js)를 찾는 경우가 있어서 이 파일을 추가함 — 실제
// 알림 처리 로직은 bang/sw.js와 동일하게 유지(둘 중 어느 경로로 등록되든
// 똑같이 동작하도록)
messaging.onBackgroundMessage(payload => {
  const d = payload.data || {};
  const title = d.title || '화씨.방';
  const body  = d.body  || '';
  const link  = d.link  || '/bang/';
  self.registration.showNotification(title, {
    body,
    icon: d.icon  || '/bang/icon-192.png',
    badge: d.badge || '/bang/icon-192.png',
    data: { link },
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const link = e.notification.data?.link || '/bang/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('/bang') && 'focus' in c) {
          return c.navigate(link).then(cl => (cl || c).focus()).catch(() => clients.openWindow(link));
        }
      }
      return clients.openWindow(link);
    })
  );
});
