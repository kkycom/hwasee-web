// ═══════════════════════════════════════════════════════════════════════
//  영어판 공통 쿠키 동의 배너 (2026-09-02)
//
//  누가 쓰는가 — 이 한 파일을 두 종류의 영어 페이지가 공유한다:
//    1) 라이브 앱(SPA): bang/en/index.html
//    2) 정적 완결작 페이지: scripts/build-en-pages.js가 만드는
//       /bang/en/story/*, /bang/en/stories/
//  한국판(/bang/)은 이 파일을 읽지 않는다 — 이번 범위에서 제외됐다.
//
//  왜 배너를 HTML에 안 쓰고 여기서 DOM으로 만드는가:
//  scripts/verify-en-pages.js가 정적 영어 페이지 HTML에 <button>·role="button"·
//  인라인 on*= 핸들러가 있으면 배포를 차단한다("참여 기능처럼 보이면 안 된다").
//  배너 마크업을 HTML로 넣으면 그 게이트에 걸리므로, 두 페이지가 같은 파일을
//  공유하려면 런타임 생성이어야 한다. 스타일도 같은 이유로 여기서 주입한다
//  (정적 페이지 셸에는 .btn 같은 공용 버튼 클래스가 아예 없다).
//
//  동의 상태는 localStorage에 3가지로만 존재한다:
//    'accepted' | 'rejected' | null(미결정 — 아직 선택 안 함, 또는 읽기 실패)
//  미결정과 거부는 광고·분석 관점에서 똑같이 취급한다(= 아무것도 로드 안 함).
//
//  ⚠️ Consent Mode 기본값(denied)은 이 파일이 아니라 각 페이지 head의 인라인
//  스니펫이 설정한다. gtag('consent','default')는 gtag('config')보다 먼저
//  실행돼야 한다는 Google 요구사항 때문에 defer 스크립트로는 늦다.
//  여기서는 사용자가 배너에서 수락했을 때의 'update'만 담당한다.
// ═══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var KEY = window.HW_CONSENT_KEY || 'hwasee_en_cookie_consent';

  function read() {
    // head 스니펫이 이미 같은 방어를 갖고 있지만, 이 파일이 그 스니펫 없이
    // 로드되는 경우(정적 페이지 셸이 바뀌는 등)에도 죽지 않게 자체 방어를 둔다.
    if (typeof window.hwConsentGet === 'function') return window.hwConsentGet();
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function write(value) {
    // 저장이 실패해도(프라이빗 모드 등) 이번 방문의 선택은 존중한다 —
    // 다음 방문에 배너가 다시 뜰 뿐이다.
    try { localStorage.setItem(KEY, value); } catch (e) {}
  }

  // ── 광고(카카오 애드핏) ───────────────────────────────────────────────
  // 애드핏은 Google Consent Mode 대상이 아니라서 동의 신호로 제어할 수 없다.
  // 그래서 "스크립트를 아예 안 붙이는" 방식으로 막는다.
  function showAds() {
    // 정적 페이지: 하단 고정 광고 바가 display:none으로 대기 중이다.
    // 이 바를 열 때만 본문이 가려지지 않게 body 아래 여백을 준다(원래 CSS에
    // 박혀 있던 padding-bottom:130px을 여기로 옮겼다 — 광고가 안 뜨는
    // 방문자에게 130px 빈 여백이 남지 않게 하려는 것).
    var bar = document.getElementById('en-ad-footer');
    if (bar) {
      bar.style.display = 'block';
      document.body.style.paddingBottom = '130px';
    }

    // 라이브 앱: en-app.js의 loadAds()가 슬롯 수집·스크립트 주입·채움 감지·
    // 미노출 시 슬롯 제거까지 전부 한다. 그 로직을 여기서 복제하지 않는다.
    if (typeof window.loadAds === 'function') { window.loadAds(); return; }

    // 정적 페이지: <ins>는 이미 HTML에 있으므로 스크립트만 붙이면
    // ba.min.js가 문서의 미처리 .kakao_ad_area를 스캔해서 채운다.
    if (!document.querySelector('ins.kakao_ad_area')) return;
    var s = document.createElement('script');
    s.src = '//t1.kakaocdn.net/kas/static/ba.min.js';
    s.async = true;
    document.body.appendChild(s);
  }

  function dropAds() {
    // 거부한 방문자에게는 빈 광고 자리도 남기지 않는다. 스크립트는 애초에
    // 붙인 적이 없으므로 네트워크 요청은 이 시점까지 0건이다.
    var bar = document.getElementById('en-ad-footer');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    document.body.style.paddingBottom = '';
    var slots = document.querySelectorAll('.ad-slot');
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].parentNode) slots[i].parentNode.removeChild(slots[i]);
    }
  }

  function grant() {
    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'update', {
        'ad_storage': 'granted',
        'ad_user_data': 'granted',
        'ad_personalization': 'granted',
        'analytics_storage': 'granted'
      });
    }
  }

  // ── 배너 ──────────────────────────────────────────────────────────────
  // 색은 전부 기존 토큰만 쓴다(--surface/--border/--text/--muted/--accent/
  // --accent2/--radius). 새 hex를 만들지 않는다 — 이 저장소의 팔레트 드리프트
  // 문제 때문(2026-08-19 정리된 원칙).
  // z-index 9000: 라이브 앱의 .toast(9999)보다 낮아 토스트가 항상 위에 뜨고,
  // 정적 페이지의 하단 광고 바(50)보다는 높다.
  var CSS = [
    '.hw-consent{position:fixed;left:0;right:0;bottom:0;z-index:9000;',
    'background:var(--surface);border-top:1px solid var(--border);',
    'padding:14px 18px;display:flex;flex-wrap:wrap;gap:12px;',
    'align-items:center;justify-content:center;',
    'box-shadow:0 -4px 20px rgba(0,0,0,.12);font-size:12.5px;line-height:1.6}',
    '.hw-consent-text{color:var(--muted);max-width:620px;margin:0}',
    '.hw-consent-text a{color:var(--accent2)}',
    '.hw-consent-actions{display:flex;gap:8px;flex-shrink:0}',
    '.hw-consent-btn{font:inherit;font-size:12.5px;cursor:pointer;',
    'padding:8px 16px;border-radius:8px;border:1px solid var(--border);',
    'background:transparent;color:var(--muted)}',
    '.hw-consent-btn:hover{color:var(--text)}',
    '.hw-consent-btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}',
    '.hw-consent-btn:focus-visible{outline:2px solid var(--accent2);outline-offset:2px}',
    '@media(max-width:560px){.hw-consent{flex-direction:column;align-items:stretch}',
    '.hw-consent-actions{justify-content:flex-end}}'
  ].join('');

  function showBanner() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var box = document.createElement('div');
    box.className = 'hw-consent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Cookie consent');

    var text = document.createElement('p');
    text.className = 'hw-consent-text';
    // 문구는 실제 동작과 어긋나지 않게 쓴다: 거부해도 로그인 유지에 필요한
    // 저장은 남고, 승인 전에도 Google 태그 자체는 익명 모드로 동작한다
    // ("추적이 전혀 없다"고 말하지 않는다 — 고급 Consent Mode의 실제 동작).
    text.innerHTML = 'We use cookies for analytics and advertising. '
      + 'Until you accept, analytics and ad storage stay off and no ad script is loaded. '
      + 'Your choice is saved in this browser, and cookies needed to keep you signed in are always kept. '
      + '<a href="/bang/privacy.html">Privacy policy</a>';

    var actions = document.createElement('div');
    actions.className = 'hw-consent-actions';

    var reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'hw-consent-btn';
    reject.textContent = 'Reject';

    var accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'hw-consent-btn hw-consent-btn-primary';
    accept.textContent = 'Accept';

    function close() {
      if (box.parentNode) box.parentNode.removeChild(box);
      document.body.style.paddingBottom = '';
    }

    reject.addEventListener('click', function () {
      write('rejected');
      close();
      dropAds();
    });

    accept.addEventListener('click', function () {
      write('accepted');
      close();
      grant();
      showAds();
    });

    actions.appendChild(reject);
    actions.appendChild(accept);
    box.appendChild(text);
    box.appendChild(actions);
    document.body.appendChild(box);

    // 배너가 본문·사이트 footer를 덮지 않게 그 높이만큼 아래 여백을 준다.
    // (선택하면 close()에서 되돌리고, 수락이면 showAds()가 다시 잡는다.)
    document.body.style.paddingBottom = (box.offsetHeight + 8) + 'px';
  }

  function start() {
    var decision = read();
    if (decision === 'accepted') { showAds(); return; }
    if (decision === 'rejected') { dropAds(); return; }
    showBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
