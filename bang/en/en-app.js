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
    ${cards.map((c, i) => `
      <div class="spotlight-card-shell">
        <div class="sp-head"><span class="sp-title">${esc(c.title)}</span></div>
        <button class="story-card" onclick="openStory('${esc(c.story_id)}')">
          <div class="story-card-title">${esc(c.opening)}</div>
          <div class="story-card-footer">
            <span class="step-pill"><span class="step-dot"></span>Step ${c.current_step || 0}</span>
            <span class="story-meta-text">${c.participant_count || 0} ${c.participant_count === 1 ? 'writer' : 'writers'}</span>
          </div>
        </button>
        <div class="sp-info">${esc(c.info)}</div>
      </div>
      ${i === 1 ? adSlotHtml('inline') : ''}
    `).join('')}
    ${adSlotHtml('footer')}`;
  loadAds();
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
      <button class="story-card" onclick="openStory('${esc(s.story_id)}')">
        <div class="story-card-title">${esc(s.opening)}</div>
        <div class="story-card-footer">
          <span class="step-pill"><span class="step-dot"></span>Step ${s.current_step || 0}</span>
          <span class="story-meta-text">${s.participant_count || 0} writers</span>
        </div>
      </button>`).join('')}
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
      <button class="story-card" onclick="openStory('${esc(s.story_id)}')">
        <div class="story-card-title">${esc(s.opening)}</div>
        <div class="story-card-footer">
          <span class="story-meta-text">${s.participant_count || 0} writers</span>
        </div>
      </button>`).join('')}` : '';

  app.innerHTML = `<div class="page-title">Completed Stories</div>${translatedHtml}${originalsHtml}${adSlotHtml('footer')}`;
  loadAds();
}

// ── 이야기 상세 ─────────────────────────────────────────────────────────
let openState = { story: null, episode: null, subs: [], picked: new Set() };

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

    const closed = episodes.filter(e => e.status === 'closed').sort((a, b) => Number(a.step) - Number(b.step));
    const openEp = episodes.find(e => e.status === 'open');
    const adopted = closed.map(e => subs.find(s => s.episode_id === e.episode_id && s.is_adopted)).filter(Boolean);
    const candidates = openEp ? subs.filter(s => s.episode_id === openEp.episode_id && !s.is_adopted) : [];

    openState = { story, episode: openEp, subs: candidates, picked: new Set() };
    renderStory(story, adopted, openEp, candidates);
  } catch (e) {
    app.innerHTML = '<div class="empty">Could not load this story.</div>';
  }
}
window.openStory = openStory;

function renderStory(story, adopted, openEp, candidates) {
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

  const genreNow = story.mode === 'genre_switch' && Array.isArray(story.genre_sequence)
    ? `<div class="source-note"><strong>Genre for this step:</strong>
       ${esc(story.genre_sequence[Number(story.current_step) || 0] || story.genre_sequence[0])}</div>` : '';

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

  app.innerHTML = `
    <button class="btn-ghost" onclick="showTab('${currentTab}')" style="margin-bottom:16px">&larr; Back</button>
    <div class="story-card-footer" style="margin-bottom:14px">
      <span class="step-pill"><span class="step-dot"></span>Step ${story.current_step || 0}</span>
      <span class="story-meta-text">${adopted.length} sentences &middot; ${story.participant_count || 0} writers</span>
    </div>
    ${fixedEnding}${genreNow}
    ${proseHtml}
    ${adSlotHtml('inline')}
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

// ── 부팅 ────────────────────────────────────────────────────────────────
document.getElementById('acct-btn').addEventListener('click', () => {
  if (session.signedIn) toast(`Signed in as ${session.nickname || 'you'}`);
  else location.href = '/bang/';
});
if (session.signedIn) {
  document.getElementById('acct-btn').textContent = session.nickname || 'Account';
}
showTab('today');
