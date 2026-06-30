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

// 백그라운드 알림 수신
messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || '화씨.방';
  const body  = payload.notification?.body  || '';
  const link  = payload.data?.link || '/bang/';
  self.registration.showNotification(title, {
    body,
    icon: '/bang/icon-192.png',
    badge: '/bang/icon-192.png',
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
          c.navigate(link);
          return c.focus();
        }
      }
      return clients.openWindow(link);
    })
  );
});

// ── 캐시 전략 ───────────────────────────────────────────────

const CACHE = 'hwasee-bang-v17';
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
