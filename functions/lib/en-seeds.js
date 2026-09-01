// English 에디션 Today's Story 씨앗 콘텐츠 — 사용자 승인본(2026-08-29 1차 게이트).
//
// 한국판 씨앗(SPOTLIGHT_AI_OPENINGS 등)의 번역이 아니라 영어 원본으로 새로 쓴 것이다.
// 작성 기준(사용자 지시):
//  - 특정 국가의 명절·제도·지명·학제 등 고유 요소 배제. 특정 미/영 문화에 갇히지 않을 것.
//  - 실존 인물·유명 프랜차이즈·국가 비하·고정관념·저작권 위험 소재 전면 배제.
//  - 번역투·한국식 밈·낯선 전제가 느껴지지 않을 것.
//  - 릴레이 특성상 첫 문장이 너무 닫혀 있으면 이어쓰기가 막히므로, 상황은 서되 여백을 남길 것.
//
// 정적 배열로 두는 이유: 초기 세트가 고정이고, 배포와 함께 버전 관리되며, 한국판의
// Firestore 풀 컬렉션과 달리 클라이언트 위조 경로가 아예 없다. 소진 기록만
// en_spotlight/used_openings(서버 전용)에 남긴다.

// 일반 오프닝 — fixed_ending·genre_switch 슬롯 공용 (한국판 SPOTLIGHT_AI_OPENINGS 대응)
const EN_OPENINGS = [
  // 미스터리 · 균열
  'The last bus never came that night.',
  'The envelope was addressed in my handwriting, but I had never written it.',
  'The town was clearly marked on the map, and no one I asked had ever been there.',
  'My upstairs neighbour moved out on Tuesday, and I still hear them walking at night.',
  'Every photograph in the album had one person cut out of it.',
  'The key fit a door in a building I had never entered.',
  'At some point the clock in the hallway started running backwards, and no one mentioned it.',
  'There was a second set of footprints leading away from the house, and only one of us had gone outside.',
  'The library book was forty years overdue and still smelled of smoke.',
  'Someone had been leaving small gifts on the doorstep for a month, unsigned.',
  // 관계 · 감정
  'My grandmother got my name wrong for the first time the night before she died.',
  'We agreed not to speak for a year, and the year ended yesterday.',
  'My brother introduced himself to me at the party, and he was not joking.',
  'The letter began, "By the time you read this, I will have already forgiven you."',
  'She kept every ticket from every trip we never took.',
  "I found my mother's diary, and the last entry was dated tomorrow.",
  'He apologised for something that had not happened yet.',
  'The seat beside me on the train had been reserved in my name, twice.',
  'We had been best friends for eleven years before I learned she had a twin.',
  'My father called to say he was proud of me, and then asked who I was.',
  // 일상 속 이상함
  'The elevator stopped at a floor the building did not have.',
  'Everyone in the office received the same email, and no one admitted to sending it.',
  "The recipe called for one ingredient I had never heard of, in my grandmother's handwriting.",
  'My reflection blinked a half-second after I did.',
  'The dog refused to walk past the empty lot, and had done so every day for a week.',
  'I woke up to find every clock in the house set to a different time.',
  'The delivery arrived addressed to the person who lived here before me.',
  'There was one more chair at the table than there were people.',
  'The radio kept playing a song that had not been released yet.',
  'My key card opened a door it should not have opened, and I went in.',
  // 상상 · 낯선 세계
  'The city announced that, starting Monday, no one would be allowed to remember Sundays.',
  'On her eighteenth birthday she was given the name she would have to keep secret.',
  'The lighthouse had been automated for decades, and someone still lit it by hand.',
  'Every hundred years the river ran backwards for exactly one hour.',
  'The map showed a coastline that had not existed for a thousand years, drawn last week.',
  'They built the wall to keep something out, and then forgot what.',
  'The museum acquired a painting that changed slightly each night.',
  'Children in the village stopped being afraid of the dark all at once, on the same evening.',
  'The train had been travelling for three days, and no one had boarded or left.',
  'She inherited a house with one room she was told never to measure.',
];

// 초스피드 오프닝 — 짧고 즉각적 (한국판 15자 규칙에 대응해 8단어 이내)
const EN_SPEEDRUN_OPENINGS = [
  'The door opened by itself.',
  'The phone rang at 3 a.m.',
  'Something fell from the sky.',
  'The lights went out.',
  'Footsteps came down the hall.',
  'The window opened on its own.',
  'Someone called my name.',
  'The ground began to shake.',
  'My reflection smiled first.',
  'A letter arrived with no sender.',
  'The engine stopped on the bridge.',
  'Every phone in the room rang at once.',
  'The last train pulled in empty.',
  'A stranger sat down across from me.',
  'The alarm went off in an empty building.',
  'The power came back, but the room had changed.',
];

// 정해진 결말 — fixed_ending 슬롯. 참여자가 이 마지막 문장까지 이어 쓴다.
// 여운은 있되 어떤 이야기에도 붙을 만큼 열려 있어야 한다.
const EN_FIXED_ENDING_POOL = [
  'And no one ever asked about that night again.',
  'The door closed, and it did not open again.',
  'He walked away without looking back.',
  'It took two changes of season before anything felt right again.',
  'None of them knew it would be the last time they met.',
  'The letter was never sent.',
  'And then, for a very long time, nothing happened at all.',
  'That was the day he learned how to laugh again.',
  'When everyone had gone, a single light was still burning.',
  'In the end, it had been decided from the very beginning.',
  'The world carried on as though nothing had happened.',
  'They were, for many years afterwards, happy.',
  'She kept the secret, and it kept her.',
  'The last one to leave turned off the light.',
];

// 동화 도입 — fairytale 슬롯. 퍼블릭 도메인 원전만(Grimm / Andersen / Aesop / 천일야화).
// 특정 영화사 각색본의 이름·설정·디자인 요소는 일절 쓰지 않는다(저작권 위험 배제).
const EN_FAIRYTALE_OPENINGS = [
  'The glass slipper fit perfectly, and the girl wearing it said it was not hers.',
  "The wolf reached the grandmother's cottage first, and found someone already waiting.",
  'The trail of breadcrumbs was gone, but a second trail led deeper into the woods.',
  "The miller's daughter had spun the straw into gold, and the little man came back a year early.",
  'She pricked her finger, and only half the castle fell asleep.',
  'The emperor walked through the city in his new clothes, and this time nobody laughed.',
  'The mermaid traded her voice, and the sea took something else as well.',
  'The tin soldier stood on one leg at the window, watching the street below.',
  'The tortoise crossed the finish line, and the hare was nowhere to be found.',
  'He rubbed the lamp, and the voice inside asked him a question first.',
  'The boy cried wolf a fourth time, and this time the village came running.',
  'Twelve princesses came down to breakfast with their shoes worn through again.',
];

// 장르 — genre_switch 슬롯. 한국판 SPOTLIGHT_GENRES와 1:1 대응이며 순서·개수를 맞춰
// 클라이언트 GENRE_META의 색상 키(romance/mystery/...)를 그대로 재사용한다.
const EN_GENRES = ['Romance', 'Mystery', 'Thriller', 'Comedy', 'Fantasy', 'Horror', 'Drama', 'Sci-Fi'];

// 슬롯 안내 문구(영어 UI) — 한국판 SPOTLIGHT_META.info 대응
const EN_SLOT_INFO = {
  fixed_ending: 'The last sentence is already written. Get the story there any way you like.',
  genre_switch: 'The genre changes at random every step. Keep each sentence under 50 characters.',
  speedrun: 'No voting here — whatever you write is accepted instantly. One short sentence at a time, up to 100 steps.',
  fairytale: 'Start from an opening everyone knows, then take it somewhere new. Use the original characters as much as you like.',
  hot: 'The open story with the most people writing in it right now. This changes as you visit.',
};

const EN_SLOT_TITLE = {
  fixed_ending: 'Fixed Ending',
  genre_switch: 'Genre Switch',
  speedrun: 'Speedrun',
  fairytale: 'Fairytale Retold',
  hot: 'Hot Story',
};

// 1단계 영어 Today 슬롯 — word(단어 챌린지)와 hint(초성 퀴즈)는 제외.
// hint는 한글 자모 기반이라 영어 이식이 구조적으로 불가능하다.
const EN_SLOT_KEYS = ['fixed_ending', 'genre_switch', 'speedrun', 'fairytale'];

module.exports = {
  EN_OPENINGS,
  EN_SPEEDRUN_OPENINGS,
  EN_FIXED_ENDING_POOL,
  EN_FAIRYTALE_OPENINGS,
  EN_GENRES,
  EN_SLOT_INFO,
  EN_SLOT_TITLE,
  EN_SLOT_KEYS,
};
