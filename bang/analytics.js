// ─── 화씨.방 애널리틱스 대시보드 ───────────────────────────
// bang/index.html(SPA)과 완전히 분리된 관리자 전용 정적 페이지의 로직.
// firebase-api.js를 그대로 재사용해 FB_CONFIG/db/functionsRegion/
// _ensureSessionVerified/FB_ADMIN_ID를 그대로 얻고, 여기서는 인증게이트 +
// getAnalyticsDashboard 조회 + SVG 차트 렌더링만 담당한다.

let _rangeDays = 30;
let _customRange = null; // { start_date, end_date } | null

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

// ── KPI 카드 ──────────────────────────────────────────────
function _kpiCardsHtml(series) {
  const withData = series.filter(d => d.has_data);
  const last = withData[withData.length - 1];
  const prev = withData[withData.length - 2];
  if (!last) return '<div class="card empty">아직 집계된 데이터가 없습니다. 스케줄 함수가 매일 KST 00:15에 자동 집계하거나, 아래 "과거 이력 전체 백필"로 직접 계산할 수 있어요.</div>';

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

// ── 코호트 표 ─────────────────────────────────────────────
function _cohortCellHtml(pct, n) {
  if (pct == null) return '<span style="color:var(--muted)">-</span>';
  return `${pct}% <span style="color:var(--muted);font-size:11px">(n=${n})</span>`;
}
function _cohortTableHtml(cohorts) {
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
      <thead><tr><th>가입 주(월요일 시작)</th><th>신규가입</th><th>D1</th><th>D7</th><th>D30</th></tr></thead>
      <tbody>${rows}</tbody>
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
    </div>`;
}
function _setRangeDays(days) { _rangeDays = days; _customRange = null; _refresh(); }
function _setCustomRange() {
  const s = document.getElementById('range-start').value, e = document.getElementById('range-end').value;
  if (!s || !e || s > e) { alert('올바른 기간을 선택해주세요.'); return; }
  _customRange = { start_date: s, end_date: e };
  _refresh();
}

// ── 전체 렌더 ─────────────────────────────────────────────
function _renderDashboard(res) {
  const dates = res.series.map(d => d.date);
  const visitorsChart = _svgLineChart([
    { label: '순방문', color: 'var(--accent)', values: res.series.map(d => d.visitors_unique) },
    { label: '총접속', color: 'var(--accent2)', values: res.series.map(d => d.visitors_total) },
  ], dates);
  const writerChart = _svgLineChart([{ label: '글쓴 유저', color: 'var(--accent2)', values: res.series.map(d => d.writer_count) }], dates);
  const dauChart = _svgLineChart([{ label: 'DAU', color: 'var(--success)', values: res.series.map(d => d.active_user_count) }], dates);
  const retentionDates = res.retention.map(d => d.date);
  const retentionChart = _svgLineChart([{ label: '주간 잔존율(%)', color: 'var(--accent2)', values: res.retention.map(d => d.retention_pct) }], retentionDates);

  _app().innerHTML = `
    ${_rangeControlsHtml()}
    ${_kpiCardsHtml(res.series)}
    ${_missingRangeHtml(res.series)}
    <div class="card"><div class="chart-title">일별 방문자 추이</div>${visitorsChart}</div>
    <div class="card"><div class="chart-title">일별 글쓴 유저 수 (제출글 작성자 기준, AI 제외)</div>${writerChart}</div>
    <div class="card"><div class="chart-title">일별 활성 유저 (DAU, 출석 기준)</div>${dauChart}</div>
    <div class="card"><div class="chart-title">주간 잔존율 추이 (이번 주 WAU 중 저번 주에도 활성이던 비율)</div>${retentionChart}</div>
    <div class="card">
      <div class="chart-title">신규가입 코호트 D1/D7/D30 잔존율 (참고용, 표본 적을 수 있음)</div>
      ${_cohortTableHtml(res.cohorts)}
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
