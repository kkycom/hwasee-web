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

// 백그라운드 알림 수신 — 서버가 data-only 메시지로 보냄(top-level notification
// 필드 없음). 그래야 브라우저가 알아서 자동 표시하지 않고, 아래에서 딱 한 번만
// 직접 표시함(예전엔 notification 필드도 같이 보내서 브라우저 자동표시 + 여기 수동
// 표시가 겹쳐 똑같은 알림이 두 개씩 뜨는 버그가 있었음)
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

// 알림 클릭 시 해당 페이지로 이동
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

// ── 캐시 전략 ───────────────────────────────────────────────

const CACHE = 'hwasee-bang-v282';
const PRECACHE = [
  '/bang/',
  '/bang/index.html',
  '/bang/firebase-api.js',
  '/bang/hwaseebang.png',
  '/bang/hwaseebang_sum.png',
  '/bang/icon-192.png',
  '/bang/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('firestore.googleapis.com') ||
      e.request.url.includes('firebase') ||
      e.request.url.includes('googleapis.com') ||
      e.request.url.includes('pagead2') ||
      e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match('/bang/index.html'));
    })
  );
});
