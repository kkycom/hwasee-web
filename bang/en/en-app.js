// ═══════════════════════════════════════════════════════════════════════
//  Hwasee.bang — English edition app
//
//  한국판 bang/index.html(약 11,000줄)을 복제하지 않는다. 필요한 화면만 담은
//  별도 앱이고, 서버 호출은 영어 전용 Callable(submitEpisodeEn / voteEpisodeEn /
//  getEnSpotlight)만 쓴다. 어느 에디션에 쓸지는 **서버가 Callable별로 고정**하므로
//  이 클라이언트가 보내는 값으로는 컬렉션 경로가 바뀌지 않는다.
//
//  한국판 bang/firebase-api.js는 건드리지 않는다(회귀 위험 0).
// ═══════════════════════════════════════════════════════════════════════

const FB_CONFIG = {
  apiKey: 'AIzaSyB5jojts7ppAoQ8ycQ9YOzB-79doP6Cebc',
  authDomain: 'hwasee-bang.firebaseapp.com',
  projectId: 'hwasee-bang',
  storageBucket: 'hwasee-bang.firebasestorage.app',
  messagingSenderId: '216731930626',
  appId: '1:216731930626:web:81dcf18e763bf65f40971b',
};
firebase.initializeApp(FB_CONFIG);
const db = firebase.firestore();
const fns = firebase.app().functions('asia-northeast3');
const call = (name, payload) => fns.httpsCallable(name)(payload || {}).then(r => r.data);

// 계정은 한국판과 공유한다(같은 로그인). 세션 키도 같은 것을 읽어서, 한국판에서
// 로그인한 사용자가 영어판에서 다시 로그인할 필요가 없다.
const session = {
  get user_id() { return localStorage.getItem('hwasee_user_id') || ''; },
  get token() { return localStorage.getItem('hwasee_token') || ''; },
  get nickname() { return localStorage.getItem('hwasee_nickname') || ''; },
  get signedIn() { return !!(this.user_id && this.token); },
};

const app = document.getElementById('app');
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let toastTimer = null;
function toast(msg) {
  // 한국판과 같은 방식: opacity 전환용 .show 클래스를 토글한다(ko-shared.css의 .toast/.toast.show).
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3200);
}

// ── 광고 ────────────────────────────────────────────────────────────────
// 한국판 _kakaoAdHtml()을 그대로 쓰지 않는다. 그쪽은 레이아웃 흔들림을 막으려고
// min-height로 자리를 먼저 잡는데, 코드 주석도 인정하듯 광고가 안 채워지는
// 기기에서는 빈 여백이 그대로 남는다. 카카오 애드핏은 한국 타깃이라 영미권
// 트래픽에서는 무필 확률이 훨씬 높아 그 방식이 더 나쁘게 작동한다.
//
// 그래서 여기서는 자리를 아예 잡지 않고(display:none) 실제로 채워진 것이
// 확인될 때만 연다. 채워지지 않으면 래퍼를 제거해 빈 자리 자체를 남기지 않는다.
// 늦게 채워져도 손해가 없다 — 자리를 미리 뺏지 않았으므로.
//
// 쿠팡 배너는 이 파일 어디에도 없다. 한국판 하단 블록을 재사용하지 않는 방식으로
// 구조적으로 배제했다(문구만 영어로 바꾸는 방식은 누락 위험이 있어 쓰지 않았다).
const AD_UNITS = { inline: 'DAN-XrJSiDdqNhNDEgMD', footer: 'DAN-tFQi1kE1l4fdDOhZ' };

function adSlotHtml(kind) {
  const unit = AD_UNITS[kind] || AD_UNITS.inline;
  const h = kind === 'footer' ? 100 : 50;
  return `<div class="ad-slot" data-ad-provider="kakao" data-ad-pending="1">
    <ins class="kakao_ad_area" style="display:none"
      data-ad-unit="${unit}" data-ad-width="320" data-ad-height="${h}"></ins>
    <div class="ad-label">Advertisement</div>
  </div>`;
}

function loadAds() {
  const pending = document.querySelectorAll('.ad-slot[data-ad-pending="1"]');
  if (!pending.length) return;
  const s = document.createElement('script');
  s.src = '//t1.kakaocdn.net/kas/static/ba.min.js';
  s.async = true;
  document.body.appendChild(s);

  // 애드핏은 채워졌는지 알려주는 공식 콜백을 제공하지 않는다(저장소 코드·문서에서
  // 확인). 그래서 ins 안에 실제 내용이 들어왔는지 관찰한다. cross-origin iframe
  // 내부는 못 보지만, "iframe이 생겼는지"까지는 같은 문서에서 확인할 수 있다.
  pending.forEach(slot => {
    const ins = slot.querySelector('ins');
    let settled = false;
    const check = () => {
      if (settled) return;
      const filled = ins && (ins.querySelector('iframe, img, ins') || ins.offsetHeight > 4);
      if (filled) {
        settled = true;
        slot.dataset.filled = '1';
        slot.removeAttribute('data-ad-pending');
        obs.disconnect();
      }
    };
    const obs = new MutationObserver(check);
    if (ins) obs.observe(ins, { childList: true, subtree: true, attributes: true });
    // 넉넉히 기다린 뒤에도 비어 있으면 자리를 남기지 않고 제거한다.
    setTimeout(() => {
      check();
      if (!settled) { obs.disconnect(); slot.remove(); }
    }, 6000);
  });
}

// ── 라우팅 ──────────────────────────────────────────────────────────────
let currentTab = 'today';
function showTab(tab) {
  currentTab = tab;
  ['today', 'free', 'done'].forEach(t => {
    const b = document.getElementById('tab-' + t);
    if (!b) return;
    b.setAttribute('aria-selected', String(t === tab));
    b.classList.toggle('active', t === tab);
  });
  if (tab === 'today') renderToday();
  else if (tab === 'free') renderFree();
  else renderCompleted();
}
window.showTab = showTab;

function skeletons(n) {
  return Array.from({ length: n || 3 }, () => '<div class="skeleton"></div>').join('');
}

// Today 카드 아이콘 — 한국판 SPOTLIGHT_META의 이모지 값과 같은 것을 쓴다.
// 한국판은 같은 자리에 전용 SVG(hwIcon)를 쓰고 이모지는 폴백으로 남겨두는데,
// 영어판은 SVG 정의를 옮겨오지 않았으므로 그 폴백 이모지를 그대로 쓴다.
const EN_SLOT_ICON = {
  fixed_ending: '🎯', genre_switch: '🎭', speedrun: '⚡', fairytale: '📖', hot: '🔥',
};

// 장르 → 색 토큰 접미사. 한국판 GENRE_META와 같은 원칙이고, 8개 장르가 1:1로
// 대응해서 색까지 그대로 같다(--g-* 토큰은 ko-shared.css로 이미 공유 중).
// ⚠️ 키는 functions/lib/en-seeds.js의 EN_GENRES와 반드시 일치해야 한다 —
// 한국판 GENRE_META가 SPOTLIGHT_GENRES와 일치해야 하는 것과 같은 이중화 주의.
// 'Sci-Fi'만 토큰 이름(sf)과 철자가 달라서 매핑이 필요하다.
const EN_GENRE_META = {
  'Romance': 'romance', 'Mystery': 'mystery', 'Thriller': 'thriller', 'Comedy': 'comedy',
  'Fantasy': 'fantasy', 'Horror': 'horror', 'Drama': 'drama', 'Sci-Fi': 'sf',
};

// 장르 강제 전환 전용 배너 — 한국판 genreSwitchBannerHtml()의 이식이다.
// "확률"이 아니라 확정된 "지금 장르"를 보여주고, 카드 톤이 그 장르 색으로
// 통일되도록 한국판과 같은 .genre-panel/--g/--wash 토큰을 그대로 쓴다.
// 한국판은 아이콘이 전용 SVG(hwIcon)지만 영어판은 SVG를 옮겨오지 않았으므로
// 다른 카드 요소와 같은 규칙으로 폴백 이모지를 쓴다.
// 문구를 짧게 쓴 이유: 한국판은 좁은 화면에서도 배너가 한 줄로 떨어지는데,
// 영어로 길게 풀어 쓰면(예: "next step switches to") 430px에서 두 줄이 되어
// 리본 높이가 한국판과 달라진다. 가장 긴 조합(Thriller+Romance = 15자)에서도
// 한 줄이 유지되는 길이로 맞췄다 — 실제 렌더 비교로 확인함.
function enGenreSwitchBannerHtml(genre, nextGenre) {
  if (!genre) return '';
  const suffix = EN_GENRE_META[genre] || 'mystery';
  return `
    <div class="genre-panel" style="--g:var(--g-${suffix});--wash:var(--g-${suffix}-wash);margin-top:10px">
      <div class="genre-row">
        <div class="genre-headline">${EN_SLOT_ICON.genre_switch} Genre now: <span class="genre-pill-primary">${esc(genre)}</span>${nextGenre ? ` &middot; next step: <span class="genre-pill-primary">${esc(nextGenre)}</span>!` : ''}</div>
      </div>
    </div>`;
}

// 카드 전체가 클릭 대상인 목록 카드(자유·완결 탭) — 한국판도 같은 패턴이다
// (`<div class="story-card" onclick=...>`, 별도 액션 버튼 없음). 한국판과 달리
// 키보드로도 열 수 있게 role/tabindex와 이 핸들러를 더한다 — 기능을 빼는 게
// 아니라 더하는 것이라 한국판과의 차이가 회귀가 되지 않는다.
function cardKey(e, story_id) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  openStory(story_id);
}
window.cardKey = cardKey;

// ── Today ───────────────────────────────────────────────────────────────
async function renderToday() {
  app.innerHTML = `<div class="page-title">Today's Story</div>
    <p class="page-lead">Each of these is open right now. Add the next sentence, or vote on what should come next.</p>
    ${skeletons(4)}`;
  let res;
  try {
    res = await call('getEnSpotlight');
  } catch (e) {
    app.innerHTML = `<div class="page-title">Today's Story</div>
      <div class="empty">Could not load today's stories.<br>Please try again in a moment.</div>`;
    return;
  }
  const cards = (res && res.cards) || [];
  if (!cards.length) {
    app.innerHTML = `<div class="page-title">Today's Story</div>
      <div class="empty">No stories are open yet.<br>They will appear here as soon as they are seeded.</div>`;
    return;
  }
  app.innerHTML = `<div class="page-title">Today's Story</div>
    <p class="page-lead">Each of these is open right now. Add the next sentence, or vote on what should come next.</p>
    ${cards.map((c, i) => todayCardHtml(c) + (i === 1 ? adSlotHtml('inline') : '')).join('')}
    ${adSlotHtml('footer')}`;
  loadAds();
}

// Today 카드 한 장 — 한국판 cardHtml()과 같은 요소 구성이다:
//   아이콘 + 제목 줄 → 종이 배경 산문(오프닝) → [단계 알약 · 참여자] + 액션 버튼.
// 예전에는 카드 전체가 하나의 <button>이고 안에 제목과 알약만 있었는데, 그러면
// 한국판과 나란히 놨을 때 "참여하기"에 해당하는 명확한 CTA가 없어 다른 화면으로
// 보였다(사용자 지적). 카드는 컨테이너로 두고, 참여는 버튼이 맡는다 — 상호작용
// 패턴까지 한국판과 같아진다.
//
// 한국판에만 있는 신규 배지·장르 확률 패널·챌린지 바로가기는 별개 기능이라
// 옮기지 않는다. 장르 강제 전환의 "지금 장르" 배너는 한국판과 같은 자리에 있다.
function todayCardHtml(c) {
  // 결말 고정 티저 — 한국판 카드와 같은 자리, 같은 규칙(--accent2 왼쪽 선)이다.
  const fixedEndingTeaser = c.slot === 'fixed_ending' && c.fixed_ending ? `
    <div style="font-size:12px;color:var(--accent2);background:var(--surface);border-left:3px solid var(--accent2);border-radius:6px;padding:8px 12px;margin:10px 0">
      ${EN_SLOT_ICON.fixed_ending} It has to end with: <strong>${esc(c.fixed_ending)}</strong>
    </div>` : '';
  // 장르 강제 전환 배너 — 한국판 카드와 같은 자리(오프닝 아래, 푸터 위)이고,
  // 한국판처럼 genre_switch 슬롯에서만 띄운다(hot에 장르전환 이야기가 올라와도
  // 한국판은 배너를 안 띄우므로 같은 규칙을 유지한다).
  // 색인: 한국판은 열린 에피소드 step으로 seq[step-1]을 쓴다. 씨앗은 current_step=0에
  // 1단계 에피소드로 시작하므로 step === current_step + 1이고, getEnSpotlight는
  // 에피소드를 안 내려주므로 같은 값을 seq[current_step]으로 구한다
  // (en-app.js 상세 화면이 이미 쓰는 색인 규칙과 같다).
  const genreSeq = Array.isArray(c.genre_sequence) ? c.genre_sequence : [];
  const genreStep = Number(c.current_step) || 0;
  const genreSwitchTeaser = c.slot === 'genre_switch'
    ? enGenreSwitchBannerHtml(genreSeq[genreStep], genreSeq[genreStep + 1]) : '';
  const writers = Number(c.participant_count) || 0;
  return `
    <div class="spotlight-card-shell">
      <div class="sp-head"><span class="sp-title">${EN_SLOT_ICON[c.slot] || '✍️'} ${esc(c.title)}</span></div>
      <div class="story-prose" style="padding:28px 18px 28px 20px;margin:12px 0">
        <div class="prose-opening">${esc(c.opening)}</div>
      </div>
      ${fixedEndingTeaser}${genreSwitchTeaser}
      <div class="story-card-footer">
        <span class="step-pill"><span class="step-dot"></span>Step ${c.current_step || 0}</span>
        <span class="story-meta-text">${writers} ${writers === 1 ? 'writer' : 'writers'}</span>
        <button class="btn btn-primary btn-sm" style="border-radius:20px;margin-left:auto"
          onclick="openStory('${esc(c.story_id)}')">Write</button>
      </div>
      <div class="sp-info">${esc(c.info)}</div>
    </div>`;
}

// ── Free Stories ────────────────────────────────────────────────────────
async function renderFree() {
  app.innerHTML = `<div class="page-title">Free Stories</div>
    <p class="page-lead">Stories anyone can start and anyone can continue.</p>${skeletons(3)}`;
  let docs = [];
  try {
    const snap = await db.collection('stories_en')
      .where('status', '==', 'active').limit(40).get();
    docs = snap.docs.map(d => ({ story_id: d.id, ...d.data() }));
    docs.sort((a, b) => (Number(b.participant_count) || 0) - (Number(a.participant_count) || 0));
  } catch (e) {
    app.innerHTML = `<div class="page-title">Free Stories</div><div class="empty">Could not load stories.</div>`;
    return;
  }
  if (!docs.length) {
    app.innerHTML = `<div class="page-title">Free Stories</div>
      <p class="page-lead">Stories anyone can start and anyone can continue.</p>
      ${startPanelHtml()}
      <div class="empty">No open stories yet. Start the first one.</div>`;
    return;
  }
  app.innerHTML = `<div class="page-title">Free Stories</div>
    <p class="page-lead">Stories anyone can start and anyone can continue.</p>
    ${startPanelHtml()}
    ${docs.map(s => `
      <div class="story-card" role="button" tabindex="0"
        onclick="openStory('${esc(s.story_id)}')" onkeydown="cardKey(event,'${esc(s.story_id)}')">
        <div class="story-card-title">${esc(s.opening)}</div>
        <div class="story-card-footer">
          <span class="step-pill"><span class="step-dot"></span>Step ${s.current_step || 0}</span>
          <span class="story-meta-text">${s.participant_count || 0} writers</span>
        </div>
      </div>`).join('')}
    ${adSlotHtml('footer')}`;
  loadAds();
}

function startPanelHtml() {
  return `<div class="card">
    <h3>Start a new story</h3>
    <textarea id="open-input" maxlength="300" placeholder="Write the first sentence. Someone else writes the next one."
      oninput="document.getElementById('open-count').textContent = this.value.length"></textarea>
    <div class="char-count"><span id="open-count">0</span> / 300</div>
    <div style="text-align:right;margin-top:8px">
      <button class="btn btn-primary" id="open-btn" onclick="startStory()">Start</button>
    </div>
  </div>`;
}

async function startStory() {
  if (!session.signedIn) { toast('Please sign in on the Korean site first — your account works here too.'); return; }
  const input = document.getElementById('open-input');
  const opening = (input.value || '').trim();
  if (!opening) { toast('Write an opening sentence first.'); return; }
  const btn = document.getElementById('open-btn');
  btn.disabled = true;
  try {
    const r = await call('createStoryEn', { user_id: session.user_id, token: session.token, opening });
    if (!r || !r.ok) { toast((r && r.error) || 'Could not start the story.'); btn.disabled = false; return; }
    toast('Your story is open. Someone will write the next sentence.');
    openStory(r.story_id);
  } catch (e) {
    toast('Could not start the story. Please try again.');
    btn.disabled = false;
  }
}
window.startStory = startStory;

// ── Completed ───────────────────────────────────────────────────────────
// 두 갈래를 출처로 구분해 보여준다(사용자 확정):
//   From Korean — 한국 원작의 번역본. 승인·해시 게이트를 통과한 것만 발행되고,
//                 각 작품에 원문 출처와 한국어 원문 링크를 유지한다.
//   English Originals — 영어판에서 직접 완결된 이야기. 번역이 아니라 원작이다.
async function renderCompleted() {
  app.innerHTML = `<div class="page-title">Completed Stories</div>${skeletons(2)}`;

  let originals = [];
  try {
    const snap = await db.collection('stories_en').where('status', '==', 'completed').limit(50).get();
    originals = snap.docs.map(d => ({ story_id: d.id, ...d.data() }));
  } catch (e) { /* 목록이 비어도 화면은 뜬다 */ }

  // 번역작 목록은 빌드가 만드는 정적 아카이브(/bang/en/stories/)가 정본이다.
  // story_translations는 클라이언트가 읽을 수 없고(미승인 번역이 새면 안 되므로),
  // 승인·해시 게이트를 통과한 것만 그 페이지에 실린다. 아카이브가 아직 없으면
  // (승인 0건) 안내만 보여준다.
  let archiveOk = false;
  try {
    const resp = await fetch('/bang/en/stories/', { method: 'HEAD' });
    archiveOk = resp.ok;
  } catch (e) { /* 오프라인 등 — 안내로 폴백 */ }

  const translatedHtml = `
    <h2>From Korean &middot; Translated &amp; curated</h2>
    <div class="source-note">
      These stories were written in Korean by the Hwasee.bang community, then translated
      into English and checked by a human before publishing. Each one links back to its
      Korean original.
    </div>
    ${archiveOk
      ? `<a class="story-card" href="/bang/en/stories/">
          <div class="story-card-title">Browse translated stories</div>
          <div class="story-card-footer">
            <span class="story-meta-text">Reviewed and published one at a time</span>
          </div>
        </a>`
      : `<div class="empty">
          No translated stories have been published yet.<br>
          They are added one at a time, after review.
        </div>`}`;

  const originalsHtml = originals.length ? `
    <h2>English Originals</h2>
    <div class="source-note">
      Written in English here, one sentence at a time. Not translations.
    </div>
    ${originals.map(s => `
      <div class="story-card" role="button" tabindex="0"
        onclick="openStory('${esc(s.story_id)}')" onkeydown="cardKey(event,'${esc(s.story_id)}')">
        <div class="story-card-title">${esc(s.opening)}</div>
        <div class="story-card-footer">
          <span class="story-meta-text">${s.participant_count || 0} writers${
            s.parent_story_id ? (s.is_end_branch ? ' &middot; an alternate ending' : ' &middot; a branch') : ''
          }</span>
        </div>
      </div>`).join('')}` : '';

  app.innerHTML = `<div class="page-title">Completed Stories</div>${translatedHtml}${originalsHtml}${adSlotHtml('footer')}`;
  loadAds();
}

// ── 이야기 상세 ─────────────────────────────────────────────────────────
let openState = { story: null, episode: null, subs: [], picked: new Set(), openEps: [] };
// 지금 읽고 있는 갈래(episode_id). 동률로 갈라진 이야기에서만 의미가 있다.
let branchChoice = null;

// 선택된 갈래에서 오프닝 쪽으로 parent_sub_id 체인을 거슬러 올라가 **그 갈래의
// 문장만** 순서대로 복원한다.
//
// 왜 필요한가: 예전에는 닫힌 에피소드를 step 순으로 전부 이어 붙였는데, 동률
// 분기가 생기면 같은 step에 닫힌 에피소드가 여러 개라 서로 다른 갈래의 문장이
// 한 이야기처럼 섞여 보인다. 분기가 없는 이야기에서는 기존과 같은 결과가 된다.
// episodes/subs는 조상 스토리까지 합친 그래프이고, startFrom은 시작점을 고를 때만
// 쓰는 **이 스토리 자신의** 에피소드 목록이다(조상 쪽에서 시작점을 고르면 남의
// 갈래를 보여주게 된다).
function lineageSentences(episodes, subs, leafEp, startFrom, startSubId) {
  const epById = new Map(episodes.map(e => [e.episode_id, e]));
  const subById = new Map(subs.map(s => [s.sub_id, s]));
  // 같은 에피소드에 채택 문장이 여럿일 수 있다(동률). 조회 순서에 따라 대표가
  // 달라지면 안 되므로 서버 _enOrderWinners와 같은 기준(created_at → id)으로
  // 첫 번째를 고른다. 대표 결말이 서버에 기록돼 있으면 아래에서 그 값이 우선한다.
  const adoptedByEp = new Map();
  const earlier = (a, b) => {
    const t = new Date(a.created_at) - new Date(b.created_at);
    if (t) return t < 0;
    return String(a.sub_id).localeCompare(String(b.sub_id)) < 0;
  };
  subs.forEach(s => {
    if (!s.is_adopted) return;
    const prev = adoptedByEp.get(s.episode_id);
    if (!prev || earlier(s, prev)) adoptedByEp.set(s.episode_id, s);
  });

  // 시작점: 완결 갈래는 자기 마지막 문장이 명시돼 있으면 그 문장까지 포함해서,
  // 열린 갈래가 있으면 그 부모 문장부터, 둘 다 없으면 가장 깊은 채택 문장부터
  // 거슬러 올라간다.
  let curSubId = null;
  if (startSubId) curSubId = startSubId;
  else if (leafEp) curSubId = leafEp.parent_sub_id || null;
  else {
    let deepest = null;
    (startFrom || episodes).forEach(e => {
      if (e.status !== 'closed' || !adoptedByEp.has(e.episode_id)) return;
      if (!deepest || Number(e.step) > Number(deepest.step)) deepest = e;
    });
    if (deepest) curSubId = (adoptedByEp.get(deepest.episode_id) || {}).sub_id || null;
  }

  const chain = [];
  const seen = new Set();
  while (curSubId && !seen.has(curSubId)) {
    seen.add(curSubId);
    const sub = subById.get(curSubId);
    if (!sub) break;
    chain.push(sub);
    const ep = epById.get(sub.episode_id);
    curSubId = ep ? (ep.parent_sub_id || null) : null;
  }
  return chain.reverse();
}

async function openStory(story_id) {
  app.innerHTML = skeletons(3);
  try {
    const [sSnap, epSnap] = await Promise.all([
      db.collection('stories_en').doc(story_id).get(),
      db.collection('episodes_en').where('story_id', '==', story_id).get(),
    ]);
    if (!sSnap.exists) { app.innerHTML = '<div class="empty">Story not found.</div>'; return; }
    const story = { story_id, ...sSnap.data() };
    const episodes = epSnap.docs.map(d => ({ episode_id: d.id, ...d.data() }));
    const subSnap = await db.collection('submissions_en').where('story_id', '==', story_id).get();
    const subs = subSnap.docs.map(d => ({ sub_id: d.id, ...d.data() }));

    // 분기로 갈라져 나온 이야기는 앞부분이 **부모 스토리에 남아 있다** — 스핀오프는
    // 갈래 에피소드와 그 제출만 옮기고 조상은 원래 자리에 두기 때문이다. 조상까지
    // 따라가지 않으면 계보가 첫 걸음에서 끊겨 오프닝만 남고 그동안 쌓인 문장이
    // 통째로 사라져 보인다.
    let ancestorEps = [], ancestorSubs = [];
    const seenStories = new Set([story_id]);
    let parentId = story.parent_story_id || null;
    while (parentId && !seenStories.has(parentId) && seenStories.size < 8) {
      seenStories.add(parentId);
      const [pS, pE, pSub] = await Promise.all([
        db.collection('stories_en').doc(parentId).get(),
        db.collection('episodes_en').where('story_id', '==', parentId).get(),
        db.collection('submissions_en').where('story_id', '==', parentId).get(),
      ]);
      ancestorEps = ancestorEps.concat(pE.docs.map(d => ({ episode_id: d.id, ...d.data() })));
      ancestorSubs = ancestorSubs.concat(pSub.docs.map(d => ({ sub_id: d.id, ...d.data() })));
      parentId = pS.exists ? (pS.data().parent_story_id || null) : null;
    }

    // 열린 갈래·후보는 **이 스토리의 것만** 쓴다(조상의 열린 갈래가 섞이면 안 된다).
    // 순서를 episode_id로 고정해서 다시 그려도 갈래 번호가 뒤바뀌지 않게 한다.
    const openEps = episodes.filter(e => e.status === 'open')
      .sort((a, b) => String(a.episode_id).localeCompare(String(b.episode_id)));
    const openEp = openEps.find(e => e.episode_id === branchChoice) || openEps[0] || null;

    // 완결 시점 동률로 갈라진 결말은 자기 에피소드 없이 부모의 마지막 문장을
    // 가리키는 완결작이다(is_end_branch). 그 문장을 시작점으로 줘야 그 결말로
    // 끝나는 계보가 정확히 복원된다.
    // 완결 갈래는 자기 마지막 문장을, 원작 완결본은 **서버가 못박은 대표 결말**을
    // 시작점으로 쓴다. 원작이 대표를 스스로 고르면 이미 독립 완결작이 있는 결말을
    // 중복해서 보여주고 본 줄기 결말은 아무 데서도 못 읽게 된다(최종 검토 지적).
    // 예전에 완결된 이야기에는 이 필드가 없으므로 기존 폴백이 그대로 쓰인다.
    const endLeafSubId = (story.is_end_branch && story.branch_leaf_sub_id)
      ? story.branch_leaf_sub_id
      : (story.canonical_ending_sub_id || null);

    // 산문 계보만 조상까지 합친 그래프에서 복원한다.
    const adopted = lineageSentences(
      episodes.concat(ancestorEps), subs.concat(ancestorSubs), openEp, episodes, endLeafSubId);
    const candidates = openEp ? subs.filter(s => s.episode_id === openEp.episode_id && !s.is_adopted) : [];

    openState = { story, episode: openEp, subs: candidates, picked: new Set(), openEps };
    renderStory(story, adopted, openEp, candidates, openEps);
  } catch (e) {
    app.innerHTML = '<div class="empty">Could not load this story.</div>';
  }
}
window.openStory = openStory;

// 갈래 선택 — 선택된 갈래가 곧 읽는 대상이자 투표·제출 대상이 된다.
function pickBranch(episode_id) {
  branchChoice = episode_id;
  if (openState.story) openStory(openState.story.story_id);
}
window.pickBranch = pickBranch;

function renderStory(story, adopted, openEp, candidates, openEps) {
  // 산문뷰는 한국판 .story-prose(줄무늬 종이 배경) + .prose-opening / .prose-line /
  // .prose-sentence 구조를 그대로 쓴다. 오프닝은 첫 줄로, 이어진 문장은 .prose-line으로.
  const lines = adopted.map(sub =>
    `<div class="prose-line"><span class="prose-sentence">${esc(sub.content)}</span></div>`).join('');
  const proseHtml = `<div class="story-prose">
      <div class="prose-opening">${esc(story.opening)}</div>
      ${lines}
    </div>`;

  const fixedEnding = story.mode === 'fixed_ending' && story.fixed_ending
    ? `<div class="source-note"><strong>This story has to end with:</strong><br>
       &ldquo;${esc(story.fixed_ending)}&rdquo;</div>` : '';

  // 장르 강제 전환 배너 — 카드 목록과 같은 컴포넌트(enGenreSwitchBannerHtml)를 쓴다.
  // 예전엔 상세만 밋밋한 .source-note 한 줄이라 카드와 따로 놀았다.
  //
  // 색인은 한국판 상세(bang/index.html의 genreSwitchBannerHtml 호출부)와 같은
  // 규칙 — 열린 에피소드 step 기준으로 지금 장르 seq[step-1], 다음 장르 seq[step].
  // 서버도 같은 식으로 단계 장르를 강제한다(functions/index.js의 gsGenre).
  // 카드 목록은 getEnSpotlight가 에피소드를 안 내려줘서 같은 값을 seq[current_step]
  // 으로 우회해 구하지만, 상세는 openEp를 실제로 갖고 있으므로 그쪽이 정확하다.
  // current_step 기준을 그대로 쓰면 두 경우에 틀린다:
  //  - 완결된 이야기엔 열린 에피소드가 없는데도 "지금 장르"를 계속 띄운다.
  //  - 동률로 갈라진 이야기는 고른 갈래마다 step이 달라서, 스토리 문서의
  //    current_step이 지금 읽는 갈래의 단계와 어긋날 수 있다.
  // 그래서 한국판처럼 openEp가 있을 때만, openEp.step 기준으로 그린다.
  const genreSeq = Array.isArray(story.genre_sequence) ? story.genre_sequence : [];
  const genreNow = (story.mode === 'genre_switch' && openEp)
    ? enGenreSwitchBannerHtml(genreSeq[Number(openEp.step) - 1], genreSeq[Number(openEp.step)])
    : '';

  // 서버의 _submitMaxChars와 같은 규칙 — genre_switch 모드는 50자다.
  const maxChars = story.mode === 'genre_switch' ? 50 : 300;
  const writePanel = openEp ? `
    <div class="card">
      <h3>Write the next sentence</h3>
      <textarea id="sub-input" maxlength="${maxChars}" placeholder="Continue the story in one sentence..."
        oninput="document.getElementById('sub-count').textContent = this.value.length"></textarea>
      <div class="char-count"><span id="sub-count">0</span> / ${maxChars}</div>
      <div style="text-align:right;margin-top:8px">
        <button class="btn btn-primary" id="sub-btn" onclick="submitSentence()">Submit</button>
      </div>
    </div>` : '';

  const votePanel = (openEp && candidates.length) ? `
    <div class="card">
      <h3>Vote on what comes next</h3>
      ${candidates.map(c => `
        <div class="candidate" id="cand-${esc(c.sub_id)}">
          <div class="candidate-text">${esc(c.content)}</div>
          <div class="candidate-foot">
            <span>${c.vote_count || 0} ${c.vote_count === 1 ? 'vote' : 'votes'}</span>
            <button class="btn-ghost" onclick="togglePick('${esc(c.sub_id)}')">Pick</button>
          </div>
        </div>`).join('')}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px">
        <span class="char-count" style="margin:0">Choose up to 2</span>
        <button class="btn btn-primary" onclick="castVote()">Vote</button>
      </div>
    </div>` : '';

  // 동률로 갈라진 이야기 — 갈래를 고르면 그 갈래만 읽고, 그 갈래에 투표·제출한다.
  // 고르지 못하면 만들어진 갈래가 화면에서 영영 닿을 수 없는 데이터가 된다.
  const branches = (openEps && openEps.length > 1) ? `
    <div class="source-note">
      <strong>This story has branched.</strong>
      The vote was tied, so it continues in ${openEps.length} directions.
      Pick one to read and continue.
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        ${openEps.map((e, i) => `<button class="btn btn-sm ${e.episode_id === (openEp && openEp.episode_id) ? 'btn-primary' : 'btn-ghost'}"
          onclick="pickBranch('${esc(e.episode_id)}')">Branch ${i + 1}</button>`).join('')}
      </div>
    </div>` : '';

  // 갈라져 나온 이야기는 원작과의 관계를 화면에서도 확인할 수 있어야 한다
  // (데이터의 parent_story_id/branch_* 와 같은 사실을 사람이 읽는 형태로).
  const origin = story.parent_story_id ? `
    <div class="source-note">
      <strong>${story.is_end_branch ? 'One of several endings.' : 'A branch of another story.'}</strong>
      The vote was tied, so the story split here and this path became its own.
      <div style="margin-top:8px">
        <button class="btn btn-ghost btn-sm" onclick="openStory('${esc(story.parent_story_id)}')">Read the original</button>
      </div>
    </div>` : '';

  app.innerHTML = `
    <button class="btn-ghost" onclick="showTab('${currentTab}')" style="margin-bottom:16px">&larr; Back</button>
    <div class="story-card-footer" style="margin-bottom:14px">
      <span class="step-pill"><span class="step-dot"></span>Step ${story.current_step || 0}</span>
      <span class="story-meta-text">${adopted.length} sentences &middot; ${story.participant_count || 0} writers</span>
    </div>
    ${origin}${fixedEnding}${branches}
    ${proseHtml}
    ${adSlotHtml('inline')}
    ${genreNow}
    ${writePanel}${votePanel}`;
  loadAds();
}

function togglePick(sub_id) {
  const el = document.getElementById('cand-' + sub_id);
  if (openState.picked.has(sub_id)) { openState.picked.delete(sub_id); el.classList.remove('picked'); }
  else {
    if (openState.picked.size >= 2) { toast('You can pick at most two.'); return; }
    openState.picked.add(sub_id); el.classList.add('picked');
  }
}
window.togglePick = togglePick;

async function submitSentence() {
  if (!session.signedIn) { toast('Please sign in on the Korean site first — your account works here too.'); return; }
  const input = document.getElementById('sub-input');
  const text = (input.value || '').trim();
  if (!text) { toast('Write a sentence first.'); return; }
  const btn = document.getElementById('sub-btn');
  btn.disabled = true;
  try {
    // 영어 전용 Callable. 어느 컬렉션에 쓸지는 서버가 이 함수 안에서 고정한다.
    const r = await call('submitEpisodeEn', {
      episode_id: openState.episode.episode_id,
      user_id: session.user_id, token: session.token, content: text,
    });
    if (!r || !r.ok) { toast((r && r.error) || 'Could not submit.'); btn.disabled = false; return; }
    toast('Your sentence was submitted.');
    // 마감 조건(투표 임계값 도달, 또는 speedrun의 즉시 채택)을 서버가 다시 확인한다.
    // 미달이면 아무것도 바뀌지 않으므로 매번 불러도 안전하다.
    await tryClose();
    openStory(openState.story.story_id);
  } catch (e) {
    toast('Could not submit. Please try again.');
    btn.disabled = false;
  }
}
window.submitSentence = submitSentence;

// 마감은 서버가 임계값을 재검증한다 — 미달이면 조용히 아무 일도 일어나지 않는다.
async function tryClose() {
  try {
    await call('closeEpisodeEn', {
      episode_id: openState.episode.episode_id,
      user_id: session.user_id, token: session.token,
    });
  } catch (e) { /* 마감 실패가 제출·투표 성공을 훼손하지 않는다 */ }
}

async function castVote() {
  if (!session.signedIn) { toast('Please sign in on the Korean site first — your account works here too.'); return; }
  if (!openState.picked.size) { toast('Pick at least one sentence.'); return; }
  try {
    const r = await call('voteEpisodeEn', {
      episode_id: openState.episode.episode_id,
      user_id: session.user_id, token: session.token,
      sub_ids: [...openState.picked],
    });
    if (!r || !r.ok) { toast((r && r.error) || 'Could not vote.'); return; }
    toast('Your vote was counted.');
    await tryClose();
    openStory(openState.story.story_id);
  } catch (e) {
    toast('Could not vote. Please try again.');
  }
}
window.castVote = castVote;

// ── PC 세로 랭킹 위젯 (포인트/채택 스와이프) ─────────────────────────────
// 한국판 renderPcSideRank와 같은 동작이다. 데이터는 getLeaderboardEn Callable에서
// 오고, 그 안의 순위·수치는 전부 user_stats_en(영어판 전용)에서만 나온다 —
// 한국판 포인트와 절대 섞이지 않는다.
let _lbData = null;
let _pcRankTab = 0;

function lbRowsHtml(rows, suffix) {
  if (!rows.length) {
    return '<div style="font-size:12px;color:var(--muted);padding:12px 0;text-align:center">No entries yet.</div>';
  }
  return rows.map((r, i) => `
    <div class="lb-row">
      <span class="lb-rank ${i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : ''}">${i + 1}</span>
      <span class="lb-name">${esc(r.nickname)}</span>
      <span class="lb-value">${r.value || 0}${suffix}</span>
    </div>`).join('');
}

function renderPcSideRank() {
  const body = document.getElementById('pc-side-rank-body');
  if (!body) return;
  const title = document.getElementById('pc-side-rank-title');
  if (title) title.textContent = _pcRankTab === 0 ? 'Points' : 'Adoptions';
  if (_lbData) {
    const rows = (_pcRankTab === 0 ? (_lbData.points || []) : (_lbData.adoptions || [])).slice(0, 8);
    body.innerHTML = lbRowsHtml(rows, _pcRankTab === 0 ? 'p' : '');
  } else {
    body.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:12px 0;text-align:center">Loading...</div>';
  }
  document.querySelectorAll('.pc-side-rank-dot')
    .forEach((d, i) => d.classList.toggle('active', i === _pcRankTab));
}

function pcSideRankSwipe(dir) {
  _pcRankTab = (_pcRankTab + dir + 2) % 2;
  renderPcSideRank();
}
window.pcSideRankSwipe = pcSideRankSwipe;

async function loadLeaderboard() {
  // 위젯은 1280px 이상에서만 보이므로(한국판과 같은 제약), 보이지 않는 화면에서는
  // 호출 자체를 하지 않는다 — 모바일 트래픽에서 불필요한 함수 호출 비용을 안 낸다.
  const widget = document.getElementById('pc-side-rank');
  if (!widget) return;
  if (window.matchMedia && !window.matchMedia('(min-width: 1280px)').matches) return;
  try {
    const res = await call('getLeaderboardEn');
    if (res && res.ok) _lbData = res;
  } catch (e) { /* 랭킹 실패가 본문 렌더를 막지 않는다 */ }
  if (!_lbData) { widget.remove(); return; }
  renderPcSideRank();
}

// ── 부팅 ────────────────────────────────────────────────────────────────
document.getElementById('acct-btn').addEventListener('click', () => {
  if (session.signedIn) toast(`Signed in as ${session.nickname || 'you'}`);
  else location.href = '/bang/';
});
if (session.signedIn) {
  document.getElementById('acct-btn').textContent = session.nickname || 'Account';
}
showTab('today');
loadLeaderboard();
