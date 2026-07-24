// ─── 화씨.방 애널리틱스 대시보드 ───────────────────────────
// bang/index.html(SPA)과 완전히 분리된 관리자 전용 정적 페이지의 로직.
// firebase-api.js를 그대로 재사용해 FB_CONFIG/db/functionsRegion/
// _ensureSessionVerified/FB_ADMIN_ID를 그대로 얻고, 여기서는 인증게이트 +
// getAnalyticsDashboard/getAnalyticsInsights 조회 + SVG 차트 렌더링만 담당한다.

let _rangeDays = 30;
let _customRange = null; // { start_date, end_date } | null
let _lastDashboardRes = null; // AI 분석 버튼이 재사용할, 가장 최근에 받은 대시보드 응답

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _app() { return document.getElementById('app'); }

function _renderMessage(msg, withHome) {
  _app().innerHTML = `<div class="empty">${_esc(msg)}${withHome ? '<br><a href="/bang/">화씨.방으로 이동</a>' : ''}</div>`;
}

// ── 인증 게이트 ──────────────────────────────────────────
async function _authGate() {
  const uid = localStorage.getItem('hwasee_uid');
  const token = localStorage.getItem('hwasee_token');
  if (!uid || !token) { _renderMessage('로그인이 필요합니다.', true); return null; }

  let result = await _ensureSessionVerified();
  if (result === undefined) result = await _ensureSessionVerified(); // 콜드스타트 대비 1회 재시도
  if (result === undefined) { _renderMessage('세션 확인에 실패했습니다. 새로고침해 주세요.', true); return null; }
  if (!result.ok) { _renderMessage('로그인이 필요합니다.', true); return null; }
  if (result.user_id !== FB_ADMIN_ID) { _renderMessage('권한이 없습니다.', true); return null; }

  return { user_id: result.user_id, token };
}

// ── 데이터 조회 ──────────────────────────────────────────
async function _loadDashboard(auth, opts) {
  const params = { user_id: auth.user_id, token: auth.token };
  if (opts.start_date) { params.start_date = opts.start_date; params.end_date = opts.end_date; }
  else params.days = opts.days;
  const fn = functionsRegion.httpsCallable('getAnalyticsDashboard');
  const r = await fn(params);
  return r.data;
}

async function _refresh() {
  _app().innerHTML = '<div class="loading">불러오는 중...</div>';
  const opts = _customRange || { days: _rangeDays };
  let res;
  try {
    res = await _loadDashboard(window._analyticsAuth, opts);
  } catch (e) {
    _renderMessage('불러오지 못했습니다: ' + (e.message || '알 수 없는 오류'));
    return;
  }
  if (!res || !res.ok) { _renderMessage('불러오지 못했습니다.'); return; }
  _lastDashboardRes = res;
  _renderDashboard(res);
}

// ── SVG 라인차트 (bang/index.html의 _genreChartBodyHtml 패턴을 일반화) ──
function _svgLineChart(series, dates) {
  const n = dates.length;
  if (!n) return '<div class="empty" style="padding:24px 0">데이터가 없습니다.</div>';

  const W = 640, H = 200, padL = 34, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const allVals = series.flatMap(s => s.values).filter(v => v != null);
  const maxV = Math.max(1, ...allVals);
  const xAt = i => (n <= 1 ? padL + plotW / 2 : padL + i * (plotW / (n - 1)));
  const yAt = v => padT + (maxV - v) / maxV * plotH;

  const gridSteps = 4;
  const gridHtml = Array.from({ length: gridSteps + 1 }, (_, k) => {
    const v = Math.round(maxV * k / gridSteps);
    const y = yAt(v).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="1"${k === 0 ? '' : ' stroke-dasharray="2 3"'}/>
      <text x="4" y="${(+y + 3).toFixed(1)}" font-size="9">${v}</text>`;
  }).join('');

  const lastIdx = n - 1;
  const linesHtml = series.map(s => {
    const pts = s.values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v || 0).toFixed(1)}`).join(' ');
    const dots = s.values.map((v, i) => {
      const cx = xAt(i).toFixed(1), cy = yAt(v || 0).toFixed(1);
      const r = i === lastIdx ? 4 : 2.5;
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${s.color}"><title>${_esc(dates[i])}: ${v ?? '-'}</title></circle>`;
    }).join('');
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join('');

  const labelCount = Math.min(6, n);
  const labelIdxs = [...new Set(Array.from({ length: labelCount }, (_, k) => Math.round(k * (n - 1) / Math.max(1, labelCount - 1))))];
  const xLabelsHtml = labelIdxs.map(i => {
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    return `<text x="${xAt(i).toFixed(1)}" y="${H - 4}" font-size="9" text-anchor="${anchor}">${_esc(dates[i].slice(5))}</text>`;
  }).join('');

  const legendHtml = series.length > 1 ? `<div class="chart-legend">${series.map(s =>
    `<span class="li"><span class="dot" style="background:${s.color}"></span>${_esc(s.label)}</span>`).join('')}</div>` : '';

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" aria-label="${_esc(series.map(s => s.label).join(', '))} 차트">
      ${gridHtml}${linesHtml}${xLabelsHtml}
    </svg>${legendHtml}`;
}

// 차트 카드 하나(제목 + AI 분석 자리 + SVG)를 공통 마크업으로 생성.
// insightKey가 있으면 "AI 분석 보기" 클릭 시 #insight-{key} 자리에 문장이 채워짐.
function _chartCardHtml(title, insightKey, bodyHtml) {
  return `
    <div class="card">
      <div class="chart-title">${_esc(title)}</div>
      ${insightKey ? `<div class="insight" id="insight-${insightKey}" style="display:none"></div>` : ''}
      ${bodyHtml}
    </div>`;
}

// ── KPI 카드 ──────────────────────────────────────────────
function _kpiCardsHtml(series) {
  const withData = series.filter(d => d.has_data);
  const last = withData[withData.length - 1];
  const prev = withData[withData.length - 2];
  if (!last) return '<div class="card empty">아직 집계된 데이터가 없습니다. 스케줄 함수가 매일 KST 00:15에 자동 집계하거나, 아래 "과거 이력 백필"로 직접 계산할 수 있어요.</div>';

  const delta = (a, b) => {
    if (a == null || b == null) return '';
    const d = a - b;
    return d === 0 ? '±0' : (d > 0 ? `+${d}` : `${d}`);
  };
  const rows = [
    ['방문자(순)', last.visitors_unique, prev && prev.visitors_unique],
    ['방문자(총)', last.visitors_total, prev && prev.visitors_total],
    ['신규가입', last.new_users_count, prev && prev.new_users_count],
    ['글쓴 유저', last.writer_count, prev && prev.writer_count],
    ['제출글', last.submission_count, prev && prev.submission_count],
    ['투표 유저', last.voter_count, prev && prev.voter_count],
    ['총 투표수', last.vote_count, prev && prev.vote_count],
    ['단어챌린지 작성', last.wc_writer_count, prev && prev.wc_writer_count],
    ['활성 유저(DAU)', last.active_user_count, prev && prev.active_user_count],
  ];
  return `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
      기준일: ${_esc(last.date)} (전날 대비 증감) — 집계는 하루 1번(KST 00:15)만 실행되므로 "오늘" 수치는 항상 없어요.
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
      ${rows.map(([label, val, prevVal]) => `
        <div class="card" style="padding:12px 18px;margin-bottom:0;min-width:110px">
          <div style="font-size:11px;color:var(--muted)">${label}</div>
          <div style="font-size:20px;font-weight:700">${val}</div>
          <div style="font-size:11px;color:var(--muted)">${delta(val, prevVal)}</div>
        </div>`).join('')}
    </div>`;
}

// ── 누적 지표 (글쓴 유저 비율 · 이야기 완주율) ─────────────
function _lifetimeCardHtml(lifetime) {
  if (!lifetime || !lifetime.total_users) return '';
  const writerPct = lifetime.writer_pct ?? 0;
  const completionPct = lifetime.stories_completion_pct ?? 0;
  return _chartCardHtml('📚 누적 지표 (서비스 시작부터 지금까지)', 'lifetime', `
    <div style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
        <div style="font-size:22px;font-weight:700">${lifetime.writer_count}<span style="font-size:13px;color:var(--muted)">명</span></div>
        <div style="font-size:13px;color:var(--muted)">/ 전체 가입자 ${lifetime.total_users}명 중 ${writerPct}%가 글을 써봤어요</div>
      </div>
      <div style="height:10px;border-radius:6px;background:var(--surface);overflow:hidden">
        <div style="height:100%;width:${Math.min(100, writerPct)}%;background:var(--accent2)"></div>
      </div>
    </div>
    <div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
        <div style="font-size:22px;font-weight:700">${lifetime.stories_completed ?? 0}<span style="font-size:13px;color:var(--muted)">편</span></div>
        <div style="font-size:13px;color:var(--muted)">/ 시작된 이야기 ${lifetime.stories_started ?? 0}편 중 ${completionPct}%가 완결됐어요</div>
      </div>
      <div style="height:10px;border-radius:6px;background:var(--surface);overflow:hidden">
        <div style="height:100%;width:${Math.min(100, completionPct)}%;background:var(--success)"></div>
      </div>
    </div>`);
}

// ── D1/D7/D30 형태 코호트 표 (신규가입 리텐션 · 가입후 첫활동 전환 공용) ──
function _cohortCellHtml(pct, n) {
  if (pct == null) return '<span style="color:var(--muted)">-</span>';
  return `${pct}% <span style="color:var(--muted);font-size:11px">(n=${n})</span>`;
}
function _cohortTableHtml(cohorts, valueLabel) {
  if (!cohorts || !cohorts.length) return '<div class="empty">코호트 데이터가 없습니다.</div>';
  const rows = cohorts.map(c => `
    <tr${c.low_confidence ? ' style="opacity:.55"' : ''}>
      <td>${_esc(c.cohort_week)}${c.low_confidence ? ' <span title="표본이 적어 참고용">⚠︎</span>' : ''}</td>
      <td>${c.signup_count}</td>
      <td>${_cohortCellHtml(c.d1_pct, c.d1_n)}</td>
      <td>${_cohortCellHtml(c.d7_pct, c.d7_n)}</td>
      <td>${_cohortCellHtml(c.d30_pct, c.d30_n)}</td>
    </tr>`).join('');
  return `
    <table>
      <thead><tr><th>가입 주(월요일 시작)</th><th>신규가입</th><th>D1 ${_esc(valueLabel)}</th><th>D7 ${_esc(valueLabel)}</th><th>D30 ${_esc(valueLabel)}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── 이야기 완주율 코호트 표 ────────────────────────────────
function _storyCohortTableHtml(cohorts) {
  if (!cohorts || !cohorts.length) return '<div class="empty">데이터가 없습니다.</div>';
  const rows = cohorts.map(c => `
    <tr${c.low_confidence ? ' style="opacity:.55"' : ''}>
      <td>${_esc(c.cohort_week)}${c.low_confidence ? ' <span title="표본이 적어 참고용">⚠︎</span>' : ''}</td>
      <td>${c.started}</td>
      <td>${c.completed}</td>
      <td>${c.active}</td>
      <td>${c.inactive}</td>
      <td>${c.completion_pct == null ? '-' : c.completion_pct + '%'}</td>
    </tr>`).join('');
  return `
    <table>
      <thead><tr><th>시작 주(월요일 시작)</th><th>시작</th><th>완결</th><th>진행중</th><th>방치</th><th>완주율</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── 가입경로별 정착도 표 ───────────────────────────────────
function _referralTableHtml(rows) {
  if (!rows || !rows.length) return '<div class="empty">데이터가 없습니다.</div>';
  const trs = rows.map(r => `
    <tr>
      <td>${_esc(r.referral)}</td>
      <td>${r.total}</td>
      <td>${r.writer_pct == null ? '-' : r.writer_pct + '%'} <span style="color:var(--muted);font-size:11px">(${r.writers}명)</span></td>
      <td>${r.active_pct == null ? '-' : r.active_pct + '%'} <span style="color:var(--muted);font-size:11px">(${r.active_recent}명)</span></td>
    </tr>`).join('');
  return `
    <table>
      <thead><tr><th>가입 경로</th><th>가입자 수</th><th>글 써본 비율(누적)</th><th>최근 30일 활동 비율</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>`;
}

// ── 미집계 구간 안내 + 백필 ───────────────────────────────
function _missingRangeHtml(series) {
  const missing = series.filter(d => !d.has_data);
  if (!missing.length) return '';
  const start = missing[0].date, end = missing[missing.length - 1].date;
  return `
    <div class="card" style="border-color:var(--accent2)">
      <div style="font-size:13px;margin-bottom:8px">⚠️ ${missing.length}일치 데이터가 아직 집계되지 않았어요 (${_esc(start)} ~ ${_esc(end)}).</div>
      <button class="btn btn-ghost btn-sm" onclick="_runBackfill('${start}','${end}')">이 구간 백필하기</button>
      <span id="backfill-status" style="font-size:12px;color:var(--muted);margin-left:8px"></span>
    </div>`;
}

function _addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 31일 제한(backfillAnalyticsDaily)에 맞춰 청크로 나눠 순차 호출.
async function _runBackfill(start, end) {
  const auth = window._analyticsAuth;
  if (!auth) return;
  const statusEl = document.getElementById('backfill-status');
  const chunks = [];
  let c = start;
  while (c <= end) {
    let chunkEnd = _addDaysStr(c, 30);
    if (chunkEnd > end) chunkEnd = end;
    chunks.push([c, chunkEnd]);
    c = _addDaysStr(chunkEnd, 1);
  }
  const fn = functionsRegion.httpsCallable('backfillAnalyticsDaily');
  for (const [s, e] of chunks) {
    if (statusEl) statusEl.textContent = `백필 중... (${s} ~ ${e})`;
    try {
      await fn({ user_id: auth.user_id, token: auth.token, start_date: s, end_date: e });
    } catch (err) {
      if (statusEl) statusEl.textContent = '백필 실패: ' + (err.message || '알 수 없는 오류');
      return;
    }
  }
  if (statusEl) statusEl.textContent = '백필 완료, 새로고침 중...';
  await _refresh();
}

async function _openBackfillPrompt() {
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const start = prompt('언제부터 집계를 다시 계산할까요? (YYYY-MM-DD)', '');
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start) || start > todayKst) { if (start) alert('YYYY-MM-DD 형식으로, 오늘 이전 날짜를 입력해주세요.'); return; }
  await _runBackfill(start, todayKst);
}

// ── 기간 선택 컨트롤 ──────────────────────────────────────
function _rangeControlsHtml() {
  const btn = (label, days) => `<button class="btn btn-ghost btn-sm${!_customRange && _rangeDays === days ? ' active' : ''}" onclick="_setRangeDays(${days})">${label}</button>`;
  return `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      ${btn('7일', 7)}${btn('30일', 30)}${btn('90일', 90)}${btn('180일', 180)}
      <input type="date" id="range-start" value="${_customRange ? _esc(_customRange.start_date) : ''}">
      <span style="color:var(--muted)">~</span>
      <input type="date" id="range-end" value="${_customRange ? _esc(_customRange.end_date) : ''}">
      <button class="btn btn-ghost btn-sm" onclick="_setCustomRange()">기간 조회</button>
      <button class="btn btn-ghost btn-sm" onclick="_openBackfillPrompt()" title="지정한 날짜부터 오늘까지 전부 다시 계산">과거 이력 백필</button>
      <button class="btn btn-ghost btn-sm" id="insight-btn" onclick="_loadInsights()">🤖 AI 분석 보기</button>
    </div>`;
}
function _setRangeDays(days) { _rangeDays = days; _customRange = null; _refresh(); }
function _setCustomRange() {
  const s = document.getElementById('range-start').value, e = document.getElementById('range-end').value;
  if (!s || !e || s > e) { alert('올바른 기간을 선택해주세요.'); return; }
  _customRange = { start_date: s, end_date: e };
  _refresh();
}

// ── AI 분석 (온디맨드 — 자동 호출 안 함, 버튼 클릭 시에만) ──
async function _loadInsights() {
  const auth = window._analyticsAuth;
  const res = _lastDashboardRes;
  if (!auth || !res) return;
  const btn = document.getElementById('insight-btn');
  if (btn) { btn.disabled = true; btn.textContent = '분석 중...'; }
  try {
    const fn = functionsRegion.httpsCallable('getAnalyticsInsights');
    const r = await fn({
      user_id: auth.user_id, token: auth.token,
      series: res.series, retention: res.retention, stickiness: res.stickiness,
      cohorts: res.cohorts, activation_cohorts: res.activation_cohorts,
      story_cohorts: res.story_cohorts, referral_breakdown: res.referral_breakdown,
      lifetime: res.lifetime,
    });
    const data = r.data;
    if (!data || !data.ok) {
      alert('AI 분석 실패: ' + (data && data.error ? data.error : '알 수 없는 오류'));
      return;
    }
    _applyInsights(data.insights);
  } catch (e) {
    alert('AI 분석 호출 실패: ' + (e.message || '알 수 없는 오류'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🤖 AI 분석 보기'; }
  }
}

function _applyInsights(insights) {
  if (!insights) return;
  const overallEl = document.getElementById('insight-overall-block');
  if (overallEl && insights.overall) {
    overallEl.style.display = 'block';
    overallEl.querySelector('.insight-text').textContent = insights.overall;
  }
  Object.entries(insights).forEach(([key, text]) => {
    if (key === 'overall' || !text) return;
    const el = document.getElementById(`insight-${key}`);
    if (el) { el.style.display = 'block'; el.textContent = `🤖 ${text}`; }
  });
}

// ── 전체 렌더 ─────────────────────────────────────────────
function _renderDashboard(res) {
  const dates = res.series.map(d => d.date);
  const cumulativeChart = _svgLineChart([
    { label: '누적 가입자 수', color: 'var(--accent2)', values: res.series.map(d => d.cumulative_users) },
  ], dates);
  const visitorsChart = _svgLineChart([
    { label: '순방문', color: 'var(--accent)', values: res.series.map(d => d.visitors_unique) },
    { label: '총접속', color: 'var(--accent2)', values: res.series.map(d => d.visitors_total) },
  ], dates);
  const writerChart = _svgLineChart([
    { label: '글쓴 유저', color: 'var(--accent2)', values: res.series.map(d => d.writer_count) },
    { label: '제출글 수', color: 'var(--accent)', values: res.series.map(d => d.submission_count) },
  ], dates);
  const voteChart = _svgLineChart([
    { label: '투표 유저', color: 'var(--accent2)', values: res.series.map(d => d.voter_count) },
    { label: '총 투표수', color: 'var(--accent)', values: res.series.map(d => d.vote_count) },
  ], dates);
  const wcChart = _svgLineChart([
    { label: '단어챌린지 작성 유저', color: 'var(--success)', values: res.series.map(d => d.wc_writer_count) },
  ], dates);
  const dauChart = _svgLineChart([
    { label: 'DAU', color: 'var(--success)', values: res.series.map(d => d.active_user_count) },
  ], dates);
  const stickinessDates = res.stickiness.map(d => d.date);
  const stickinessChart = _svgLineChart([
    { label: 'DAU/WAU(%)', color: 'var(--accent2)', values: res.stickiness.map(d => d.dau_wau_pct) },
    { label: 'DAU/MAU(%)', color: 'var(--accent)', values: res.stickiness.map(d => d.dau_mau_pct) },
  ], stickinessDates);
  const retentionDates = res.retention.map(d => d.date);
  const retentionChart = _svgLineChart([
    { label: '주간 잔존율(%)', color: 'var(--accent2)', values: res.retention.map(d => d.retention_pct) },
  ], retentionDates);

  _app().innerHTML = `
    ${_rangeControlsHtml()}
    <div class="card" id="insight-overall-block" style="display:none;border-color:var(--accent2)">
      <div class="chart-title">🤖 AI 종합 분석</div>
      <div class="insight-text" style="font-size:13.5px;line-height:1.6"></div>
    </div>
    ${_kpiCardsHtml(res.series)}
    ${_missingRangeHtml(res.series)}
    ${_chartCardHtml('📈 누적 가입자 수 추이 (우상향 폭으로 성장 속도 확인)', 'cumulative_users', cumulativeChart)}
    ${_chartCardHtml('📈 일별 방문자 추이 (순방문 · 총접속)', 'visitors', visitorsChart)}
    ${_chartCardHtml('✍️ 일별 글 작성 현황 (작성 유저수 · 제출글 수, AI 제외)', 'writers', writerChart)}
    ${_chartCardHtml('🗳️ 일별 투표 현황 (투표 유저수 · 총 투표수, AI 제외)', 'votes', voteChart)}
    ${_chartCardHtml('🎲 오늘의 단어챌린지 작성 유저수 추이', 'word_challenge', wcChart)}
    ${_chartCardHtml('🔥 일별 활성 유저 (DAU, 출석 기준)', 'dau', dauChart)}
    ${_chartCardHtml('🔁 재방문 빈도 (Stickiness: DAU/WAU · DAU/MAU, %)', 'stickiness', stickinessChart)}
    ${_chartCardHtml('📊 주간 잔존율 추이 (지난주 WAU 대비 이번주 잔존율, %)', 'retention', retentionChart)}
    ${_lifetimeCardHtml(res.lifetime)}
    <div class="card">
      <div class="chart-title">🧮 신규가입 코호트 D1/D7/D30 잔존율 (참고용, 표본 적을 수 있음)</div>
      <div class="insight" id="insight-cohorts" style="display:none"></div>
      ${_cohortTableHtml(res.cohorts, '잔존율')}
    </div>
    <div class="card">
      <div class="chart-title">🚀 가입→첫 활동 전환율 (D1/D7/D30 안에 글쓰기 또는 투표를 해봤는지)</div>
      <div class="insight" id="insight-activation" style="display:none"></div>
      ${_cohortTableHtml(res.activation_cohorts, '전환율')}
    </div>
    <div class="card">
      <div class="chart-title">🏁 이야기 시작 주 기준 완주율 (현재 상태 기준, 오래된 코호트일수록 안정적)</div>
      <div class="insight" id="insight-story_completion" style="display:none"></div>
      ${_storyCohortTableHtml(res.story_cohorts)}
    </div>
    <div class="card">
      <div class="chart-title">📡 가입경로별 정착도 (유입량이 아니라 남아서 쓰는지)</div>
      <div class="insight" id="insight-referral" style="display:none"></div>
      ${_referralTableHtml(res.referral_breakdown)}
    </div>
    <div style="font-size:11px;color:var(--muted);text-align:center;margin-top:8px">
      생성: ${_esc(res.generated_at)} · <a href="/bang/">화씨.방으로</a>
    </div>`;
}

// ── 진입점 ────────────────────────────────────────────────
(async function _init() {
  const auth = await _authGate();
  if (!auth) return;
  window._analyticsAuth = auth;
  await _refresh();
})();
