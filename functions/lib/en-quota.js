// A-1 — 영어 번역 API 호출의 비용 통제(킬스위치 + 시간당/일일 상한).
//
// 별도 모듈인 이유: "상한과 킬스위치가 실제로 API 호출을 막는지"가 필수 검증
// 항목이라, Firestore 없이 가짜 db로 단위 테스트할 수 있어야 한다.
//
// 핵심 성질 두 가지:
//  1) fail-closed — 설정 문서가 없거나 필드 타입이 손상됐거나 상한이 음수면
//     거부한다. 기본 활성화하거나 상한을 무한대로 간주하지 않는다.
//  2) 트랜잭션 예약 — 단순히 "읽고 나서 호출"하면 동시 요청이 각자 같은 값을
//     읽고 전부 통과해 상한을 넘길 수 있다. 검사와 증가를 한 트랜잭션에 묶어
//     예약한 뒤에만 API를 호출한다.

const EN_CONTROL = 'translation_control';
const EN_USAGE   = 'translation_usage';

// 설정 문서를 읽어 검증한다. 조금이라도 이상하면 null(=거부).
function parseEnLimits(snap) {
  if (!snap || !snap.exists) return null;
  const d = (typeof snap.data === 'function' ? snap.data() : null) || {};
  const enabled = d.translation_enabled;
  const hourly = d.hourly_limit;
  const daily = d.daily_limit;
  if (typeof enabled !== 'boolean') return null;
  if (!Number.isInteger(hourly) || hourly < 0) return null;
  if (!Number.isInteger(daily) || daily < 0) return null;
  return { enabled, hourly, daily };
}

function enBuckets(now) {
  const iso = (now || new Date()).toISOString();
  return { hour: 'hour:' + iso.slice(0, 13), day: 'day:' + iso.slice(0, 10) };
}

// API 호출 전에 킬스위치·시간당·일일 상한을 한 트랜잭션에서 확인하고 1건을 예약한다.
async function reserveEnQuota(db, now) {
  const buckets = enBuckets(now);
  const controlRef = db.collection(EN_CONTROL).doc('flags');
  const hourRef = db.collection(EN_USAGE).doc(buckets.hour);
  const dayRef = db.collection(EN_USAGE).doc(buckets.day);

  return db.runTransaction(async tx => {
    const cSnap = await tx.get(controlRef);
    const hSnap = await tx.get(hourRef);
    const dSnap = await tx.get(dayRef);

    const limits = parseEnLimits(cSnap);
    if (!limits) {
      return { ok: false, code: 'no_config', message: '번역 설정 문서가 없거나 손상됐습니다. 먼저 setTranslationLimits로 설정하세요.' };
    }
    if (!limits.enabled) {
      return { ok: false, code: 'disabled', message: '번역 기능이 꺼져 있습니다(킬스위치).' };
    }

    const hUsed = Number((hSnap.exists && hSnap.data().count) || 0);
    const dUsed = Number((dSnap.exists && dSnap.data().count) || 0);
    if (hUsed >= limits.hourly) {
      return { ok: false, code: 'hourly_limit', message: '시간당 상한(' + limits.hourly + '건)에 도달했습니다.' };
    }
    if (dUsed >= limits.daily) {
      return { ok: false, code: 'daily_limit', message: '일일 상한(' + limits.daily + '건)에 도달했습니다.' };
    }

    const ts = new Date().toISOString();
    tx.set(hourRef, { count: hUsed + 1, bucket: buckets.hour, updated_at: ts }, { merge: true });
    tx.set(dayRef, { count: dUsed + 1, bucket: buckets.day, updated_at: ts }, { merge: true });
    return { ok: true, hourUsed: hUsed + 1, dayUsed: dUsed + 1, limits };
  });
}

module.exports = { parseEnLimits, enBuckets, reserveEnQuota, EN_CONTROL, EN_USAGE };
