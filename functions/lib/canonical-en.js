// 영어 발행(A-1) 전용 — 완결작 "정경(canonical) 원문"의 단일 직렬화·해시 규칙.
//
// 왜 별도 모듈인가: 번역을 만드는 쪽(Cloud Functions)과 정적 페이지를 만드는 쪽
// (scripts/build-en-pages.js)이 원문 해시를 **똑같이** 계산하지 못하면, 원문이
// 안 바뀌었는데도 해시가 달라져 멀쩡한 번역이 스테일로 처리되거나(가짜 음성),
// 반대로 원문이 바뀌었는데 못 잡아내는(가짜 양성) 일이 생긴다. 그래서 정경
// 수집과 해시 규칙을 이 파일 하나로 고정하고 양쪽이 이걸 require한다.
//
// - Cloud Functions:  require('./lib/canonical-en.js')
// - 빌드 스크립트:     require('../functions/lib/canonical-en.js')
//
// 아래 getEpisodeTree/buildCanonicalPath/collectSubs는 scripts/build-static-stories.js에
// 이미 배포돼 검증된 구현을 그대로 옮긴 것이다. 기존 한국어 SSG의 동작을 바꾸지
// 않으려고 원본은 건드리지 않았고, 대신 build-en-pages.js가 매 빌드마다 두 구현의
// 결과를 (sub_id + 내용) 쌍으로 대조해 불일치 시 빌드를 실패시킨다 — 두 사본이
// 갈라지는 순간 CI에서 즉시 잡힌다.

const crypto = require('crypto');

function getEpisodeTree(episodes, submissions, pinnedSubs) {
  pinnedSubs = pinnedSubs || {};
  const subToChildEps = {};
  episodes.forEach(ep => {
    if (ep.parent_sub_id) {
      if (!subToChildEps[ep.parent_sub_id]) subToChildEps[ep.parent_sub_id] = [];
      subToChildEps[ep.parent_sub_id].push(ep);
    }
  });
  const rootEp = episodes.find(ep => !ep.parent_sub_id || ep.parent_sub_id === '')
    || (episodes.length ? episodes.reduce((a, b) => Number(a.step) <= Number(b.step) ? a : b) : null);
  if (!rootEp) return null;

  function buildNode(ep) {
    let adoptedSubs = submissions.filter(s =>
      s.episode_id === ep.episode_id && (s.is_adopted === true || s.is_adopted === 'TRUE')
    );
    const pinnedSubId = pinnedSubs[ep.episode_id];
    if (pinnedSubId && !adoptedSubs.some(s => s.sub_id === pinnedSubId)) {
      const pinnedSub = submissions.find(s => s.sub_id === pinnedSubId);
      if (pinnedSub) adoptedSubs = [...adoptedSubs, pinnedSub];
    }
    const children = adoptedSubs.flatMap(sub => (subToChildEps[sub.sub_id] || []).map(buildNode));
    return { ep, adoptedSubs, children };
  }
  return buildNode(rootEp);
}

function buildCanonicalPath(episodes, submissions) {
  const path_ = {};
  let traceSub = submissions.find(s => s.is_closing && s.is_adopted);
  if (!traceSub) {
    const maxStep = Math.max(...episodes.map(e => Number(e.step) || 0));
    const lastEps = new Set(episodes.filter(e => Number(e.step) === maxStep).map(e => e.episode_id));
    traceSub = submissions.find(s => lastEps.has(s.episode_id) && s.is_adopted);
  }
  const seenSubs = new Set();
  while (traceSub && !seenSubs.has(traceSub.sub_id)) {
    seenSubs.add(traceSub.sub_id);
    const ep = episodes.find(e => e.episode_id === traceSub.episode_id);
    if (!ep || !ep.parent_sub_id) break;
    const parentSub = submissions.find(s => s.sub_id === ep.parent_sub_id);
    if (!parentSub) break;
    const parentEp = episodes.find(e => e.episode_id === parentSub.episode_id);
    if (!parentEp) break;
    const parentAdopted = submissions.filter(s => s.episode_id === parentEp.episode_id && s.is_adopted);
    if (parentAdopted.length > 1) path_[parentEp.episode_id] = ep.parent_sub_id;
    traceSub = parentSub;
  }
  return path_;
}

function collectSubs(node, choices) {
  if (!node || node.ep.status !== 'closed' || !node.adoptedSubs.length) return [];
  const chosenId = (choices || {})[node.ep.episode_id];
  const sub = (chosenId && node.adoptedSubs.find(s => s.sub_id === chosenId)) || node.adoptedSubs[0];
  const child = node.children.find(c => c.ep.parent_sub_id === sub.sub_id);
  return [sub, ...collectSubs(child, choices)];
}

// 완결작의 정경 채택 문장들을 순서대로 반환. 마감된 에피소드가 없으면 null.
function collectCanonicalSubs(episodes, submissions) {
  const closedEps = episodes.filter(e => e.status === 'closed');
  const tree = getEpisodeTree(closedEps, submissions);
  if (!tree) return null;
  const choices = buildCanonicalPath(closedEps, submissions);
  const subs = collectSubs(tree, choices);
  return subs.length ? subs : null;
}

// 해시 규칙(고정): NFC 정규화 → 앞뒤 공백 제거 → 내부 연속 공백을 1칸으로 축약.
// 줄 구분은 join('\n')이 담당하므로 줄 안의 공백만 정규화된다.
function normalizeLine(s) {
  return String(s == null ? '' : s).normalize('NFC').trim().replace(/\s+/g, ' ');
}

// 화면에 실제로 출력되는 원문(제목 역할의 opening + 채택 문장들)만 직렬화한다.
function serializeCanonical(opening, subs) {
  return [normalizeLine(opening), ...subs.map(s => normalizeLine(s && s.content))].join('\n');
}

function hashCanonical(opening, subs) {
  return crypto.createHash('sha256')
    .update(serializeCanonical(opening, subs), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

module.exports = {
  getEpisodeTree,
  buildCanonicalPath,
  collectSubs,
  collectCanonicalSubs,
  normalizeLine,
  serializeCanonical,
  hashCanonical,
};
