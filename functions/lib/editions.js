// 에디션별 Firestore 컬렉션 이름표.
//
// 왜 필드가 아니라 컬렉션을 나눴나: 처음엔 stories.edition 필드 + 모든 쿼리에 조건을
// 붙이는 방식을 검토했는데, 실제로 조건이 필요한 지점이 19곳이었고 기능이 늘 때마다
// 그 수가 증가한다. 한 곳만 빠뜨려도 즉시 한국 화면에 영어 콘텐츠가 섞인다.
// 경로를 물리적으로 나누면 collection('stories')를 읽는 코드는 영어 데이터를
// 구조적으로 볼 수 없다 — 빠뜨릴 필터 자체가 존재하지 않는다.
//
// ⚠️ 보안 원칙: 이 맵의 선택은 **항상 서버가 고정**한다. Callable은 클라이언트가 보낸
// data.edition / data.collection 같은 값을 절대 읽지 않고, 각 Callable이 자기 에디션
// 상수를 직접 넘긴다. 클라이언트 입력이 컬렉션 경로에 영향을 주면 한 계정으로
// 한국 데이터에 영어 경로처럼 쓰거나 그 반대가 가능해진다.

const KO = {
  edition: 'ko',
  // 이야기 그래프
  stories: 'stories',
  episodes: 'episodes',
  submissions: 'submissions',
  votes: 'votes',
  // 이야기에 매달린 콘텐츠
  comments: 'comments',
  bookmarks: 'bookmarks',
  storyLikes: 'story_likes',
  storyMvp: 'story_mvp',
  boosts: 'boosts',
  extraSubmits: 'extra_submits',
  submissionVotes: 'submission_votes',
  submissionReports: 'submission_reports',
  reports: 'reports',
  storyVisits: 'story_visits',
  storyGenreProbs: 'story_genre_probs',
  episodeTyping: 'episode_typing',
  adminEdits: 'admin_edits',
  storyTitleReports: 'story_title_reports',
  // 경제 · 알림 (에디션별 완전 분리 — 상호 사용 불가)
  pointLedger: 'point_ledger',
  notifications: 'notifications',
  // 한국판은 사용자 통계가 users 문서 자체에 있다(total_points/submission_count/badge...).
  // null은 "users 문서를 직접 쓴다"는 뜻.
  userStats: null,
  // Today 슬롯 포인터
  slotsDoc: { collection: 'config', doc: 'spotlight_slots' },
  usedOpeningsDoc: { collection: 'config', doc: 'used_openings' },
};

const EN = {
  edition: 'en',
  stories: 'stories_en',
  episodes: 'episodes_en',
  submissions: 'submissions_en',
  votes: 'votes_en',
  comments: 'comments_en',
  bookmarks: 'bookmarks_en',
  storyLikes: 'story_likes_en',
  storyMvp: 'story_mvp_en',
  boosts: 'boosts_en',
  extraSubmits: 'extra_submits_en',
  submissionVotes: 'submission_votes_en',
  submissionReports: 'submission_reports_en',
  reports: 'reports_en',
  storyVisits: 'story_visits_en',
  storyGenreProbs: 'story_genre_probs_en',
  episodeTyping: 'episode_typing_en',
  adminEdits: 'admin_edits_en',
  storyTitleReports: 'story_title_reports_en',
  pointLedger: 'point_ledger_en',
  notifications: 'notifications_en',
  // 영어판 포인트·카운터·업적은 users 문서가 아니라 이 컬렉션에 둔다.
  // users에 en_ 접두 필드를 두면 안 되는 이유: users update는 클라이언트에 열려 있고
  // rules의 증가폭 가드가 total_points에만 걸려 있어서, 새 필드는 그 가드를 안 타
  // 무제한 위조가 가능하다. 별도 컬렉션은 write를 통째로 막을 수 있다.
  userStats: 'user_stats_en',
  slotsDoc: { collection: 'en_spotlight', doc: 'slots' },
  usedOpeningsDoc: { collection: 'en_spotlight', doc: 'used_openings' },
};

// 모든 에디션이 공유하는 것 — 계정 하나로 양쪽을 쓴다는 결정에 따름.
// 차단(ban)·닉네임·배지 같은 신원 정보는 공유하되, 경제(포인트/업적)는 위에서 분리했다.
const SHARED = {
  users: 'users',
  userSecrets: 'user_secrets',
  configSecrets: { collection: 'config', doc: 'secrets' },
  visits: 'visits',
};

const EDITIONS = { ko: KO, en: EN };

// 서버 내부에서만 쓴다. 알 수 없는 값이 오면 던진다 — 조용히 ko로 폴백하면
// 영어 요청이 한국 컬렉션에 쓰이는 사고가 나므로 실패하는 편이 안전하다.
function editionCols(edition) {
  const cols = EDITIONS[edition];
  if (!cols) throw new Error(`알 수 없는 에디션: ${edition}`);
  return cols;
}

module.exports = { KO, EN, SHARED, EDITIONS, editionCols };
