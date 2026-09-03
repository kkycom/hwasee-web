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
  // 콜드스타트 대비 1회 재시도 — _ensureSessionVerified는 같은 (uid,token) 쌍이면
  // 실패했던 결과까지 그대로 캐시해서 재반환하므로(firebase-api.js), 그냥 다시
  // 부르면 재시도가 아니라 같은 실패를 다시 받아오는 것뿐이었음. 관리자 전용
  // 페이지라 트래픽이 적어 Cloud Functions 콜드스타트를 유독 자주 만나는데,
  // 그때마다 이 무의미한 "재시도"가 실제로는 캐시만 읽고 끝나서 대시보드
  // 자체가 뜨다 안 뜨다 했음(2026-07-26 유저 제보) — 재시도 전에 캐시를 지워
  // 진짜 새 요청이 나가게 함.
  if (result === undefined) { _resetSessionVerify(); result = await _ensureSessionVerified(); }
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
// markerDates(선택): [{date:'YYYY-MM-DD', label:'...'}] — 배포일 등 특정 날짜를
// 점선 세로줄+라벨로 표시해 전후 비교를 눈으로 바로 할 수 있게 함.
// detailed(선택): true면 확대 모달용 — x축 라벨을 훨씬 촘촘히 보여주고(최대
// 24개), 단일 시리즈일 땐 각 점 위에 실제 값을 직접 찍어줌(다중 시리즈는
// 겹쳐서 안 씀 — 툴팁으로 대신 확인).
function _svgLineChart(series, dates, markerDates, detailed) {
  const n = dates.length;
  if (!n) return '<div class="empty" style="padding:24px 0">데이터가 없습니다.</div>';

  const H = detailed ? 320 : 200;
  const W = 640, padL = 34, padR = 12, padT = detailed ? 26 : 14, padB = 26;
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
      const valueLabel = (detailed && series.length === 1 && v != null)
        ? `<text x="${cx}" y="${(+cy - 7).toFixed(1)}" font-size="9" text-anchor="middle" fill="${s.color}" font-weight="700">${v}</text>` : '';
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${s.color}"><title>${_esc(dates[i])}: ${v ?? '-'}</title></circle>${valueLabel}`;
    }).join('');
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join('');

  const labelCount = detailed ? Math.min(24, n) : Math.min(6, n);
  const labelIdxs = [...new Set(Array.from({ length: labelCount }, (_, k) => Math.round(k * (n - 1) / Math.max(1, labelCount - 1))))];
  const xLabelsHtml = labelIdxs.map(i => {
    const anchor = detailed ? 'end' : (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
    const transform = detailed ? ` transform="rotate(-55 ${xAt(i).toFixed(1)} ${H - 4})"` : '';
    return `<text x="${xAt(i).toFixed(1)}" y="${H - 4}" font-size="${detailed ? 8 : 9}" text-anchor="${anchor}"${transform}>${_esc(dates[i].slice(5))}</text>`;
  }).join('');

  const legendHtml = series.length > 1 ? `<div class="chart-legend">${series.map(s =>
    `<span class="li"><span class="dot" style="background:${s.color}"></span>${_esc(s.label)}</span>`).join('')}</div>` : '';

  const markersHtml = (markerDates || []).map(m => {
    const idx = dates.indexOf(m.date);
    if (idx === -1) return '';
    const x = xAt(idx).toFixed(1);
    return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="var(--accent2)" stroke-width="1.5" stroke-dasharray="3 3"/>
      <text x="${x}" y="${(padT - 3).toFixed(1)}" font-size="8.5" text-anchor="middle" fill="var(--accent2)" font-weight="700">${_esc(m.label)}</text>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" aria-label="${_esc(series.map(s => s.label).join(', '))} 차트">
      ${gridHtml}${linesHtml}${markersHtml}${xLabelsHtml}
    </svg>${legendHtml}`;
}

// 막대(좌축)+꺾은선(우축) 콤보 차트 — 두 지표의 규모 차이가 커도(예: 일별
// 신규가입 수십 명 vs 누적가입자 수백 명) 각자 축을 따로 스케일링해서 같은
// x축(날짜) 위에 겹쳐 보여줌. barSeries/lineSeries는 각각 {label,color,values}.
function _svgComboChart(dates, barSeries, lineSeries, markerDates, detailed) {
  const n = dates.length;
  if (!n) return '<div class="empty" style="padding:24px 0">데이터가 없습니다.</div>';

  const H = detailed ? 320 : 200;
  const W = 640, padL = 34, padR = 34, padT = detailed ? 26 : 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const barMax = Math.max(1, ...barSeries.values.filter(v => v != null));
  const lineMax = Math.max(1, ...lineSeries.values.filter(v => v != null));
  const gap = plotW / n;
  const barW = Math.max(1, gap * 0.55);
  const xAt = i => (n <= 1 ? padL + plotW / 2 : padL + i * (plotW / (n - 1)));
  const yAtFrac = frac => padT + (1 - frac) * plotH;

  const gridSteps = 4;
  const gridHtml = Array.from({ length: gridSteps + 1 }, (_, k) => {
    const frac = k / gridSteps;
    const y = yAtFrac(frac).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="1"${k === 0 ? '' : ' stroke-dasharray="2 3"'}/>
      <text x="4" y="${(+y + 3).toFixed(1)}" font-size="9" fill="${barSeries.color}">${Math.round(barMax * frac)}</text>
      <text x="${W - 4}" y="${(+y + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="${lineSeries.color}">${Math.round(lineMax * frac)}</text>`;
  }).join('');

  const barsHtml = barSeries.values.map((v, i) => {
    const val = v || 0;
    const x = (xAt(i) - barW / 2).toFixed(1);
    const yTop = yAtFrac(val / barMax);
    const h = (padT + plotH - yTop).toFixed(1);
    const valueLabel = (detailed && val > 0)
      ? `<text x="${xAt(i).toFixed(1)}" y="${(yTop - 4).toFixed(1)}" font-size="8" text-anchor="middle" fill="${barSeries.color}" font-weight="700">${val}</text>` : '';
    return `<rect x="${x}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h}" fill="${barSeries.color}" opacity=".55"><title>${_esc(dates[i])} ${_esc(barSeries.label)}: ${val}</title></rect>${valueLabel}`;
  }).join('');

  const lastIdx = n - 1;
  const pts = lineSeries.values.map((v, i) => `${xAt(i).toFixed(1)},${yAtFrac((v || 0) / lineMax).toFixed(1)}`).join(' ');
  const dots = lineSeries.values.map((v, i) => {
    const cx = xAt(i).toFixed(1), cy = yAtFrac((v || 0) / lineMax).toFixed(1);
    const r = i === lastIdx ? 4 : 2.5;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${lineSeries.color}"><title>${_esc(dates[i])} ${_esc(lineSeries.label)}: ${v ?? '-'}</title></circle>`;
  }).join('');
  const lineHtml = `<polyline points="${pts}" fill="none" stroke="${lineSeries.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;

  const labelCount = detailed ? Math.min(24, n) : Math.min(6, n);
  const labelIdxs = [...new Set(Array.from({ length: labelCount }, (_, k) => Math.round(k * (n - 1) / Math.max(1, labelCount - 1))))];
  const xLabelsHtml = labelIdxs.map(i => {
    const anchor = detailed ? 'end' : (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
    const transform = detailed ? ` transform="rotate(-55 ${xAt(i).toFixed(1)} ${H - 4})"` : '';
    return `<text x="${xAt(i).toFixed(1)}" y="${H - 4}" font-size="${detailed ? 8 : 9}" text-anchor="${anchor}"${transform}>${_esc(dates[i].slice(5))}</text>`;
  }).join('');

  const markersHtml = (markerDates || []).map(m => {
    const idx = dates.indexOf(m.date);
    if (idx === -1) return '';
    const x = xAt(idx).toFixed(1);
    return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="3 3" opacity=".55"/>
      <text x="${x}" y="${(padT - 3).toFixed(1)}" font-size="8.5" text-anchor="middle" fill="var(--text)" font-weight="700">${_esc(m.label)}</text>`;
  }).join('');

  const legendHtml = `<div class="chart-legend">
    <span class="li"><span class="dot" style="background:${barSeries.color}"></span>${_esc(barSeries.label)} (좌축)</span>
    <span class="li"><span class="dot" style="background:${lineSeries.color}"></span>${_esc(lineSeries.label)} (우축)</span>
  </div>`;

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" aria-label="${_esc(barSeries.label)}+${_esc(lineSeries.label)} 콤보 차트">
      ${gridHtml}${barsHtml}${lineHtml}${markersHtml}${xLabelsHtml}
    </svg>${legendHtml}`;
}

// 카테고리별(날짜 축이 아님) 단순 막대차트 — 위 차트들은 전부 x축이 날짜라
// "책별 결말 도달 수" 같은 범주형 데이터엔 안 맞아서 새로 만듦. 값 라벨은
// 항상 표시(카테고리 수가 적어 안 겹침).
function _svgCategoryBarChart(labels, values, color) {
  const n = labels.length;
  if (!n) return '<div class="empty" style="padding:24px 0">데이터가 없습니다.</div>';

  const H = 200, W = 640, padL = 34, padR = 12, padT = 20, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(1, ...values);
  const gap = plotW / n;
  const barW = Math.max(1, gap * 0.5);
  const xAt = i => padL + i * gap + gap / 2;

  const gridSteps = 4;
  const gridHtml = Array.from({ length: gridSteps + 1 }, (_, k) => {
    const v = Math.round(maxV * k / gridSteps);
    const y = (padT + (1 - k / gridSteps) * plotH).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="1"${k === 0 ? '' : ' stroke-dasharray="2 3"'}/>
      <text x="4" y="${(+y + 3).toFixed(1)}" font-size="9">${v}</text>`;
  }).join('');

  const barsHtml = values.map((v, i) => {
    const val = v || 0;
    const x = (xAt(i) - barW / 2).toFixed(1);
    const yTop = (padT + (1 - val / maxV) * plotH).toFixed(1);
    const h = (padT + plotH - yTop).toFixed(1);
    return `<rect x="${x}" y="${yTop}" width="${barW.toFixed(1)}" height="${h}" fill="${color}" rx="3"><title>${_esc(labels[i])}: ${val}</title></rect>
      <text x="${xAt(i).toFixed(1)}" y="${(+yTop - 6).toFixed(1)}" font-size="10" text-anchor="middle" fill="${color}" font-weight="700">${val}</text>`;
  }).join('');

  const xLabelsHtml = labels.map((l, i) =>
    `<text x="${xAt(i).toFixed(1)}" y="${H - 4}" font-size="9" text-anchor="middle">${_esc(l)}</text>`).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" aria-label="카테고리별 막대차트">
      ${gridHtml}${barsHtml}${xLabelsHtml}
    </svg>`;
}

// 100%-누적 막대차트 — 하루 총 참여량이 들쭉날쭉해도 "그날 무엇에 참여가 몰렸는지
// 비율"만 일정한 높이로 비교할 수 있게 함(절대량은 title 툴팁에서 확인).
function _svgStackedBarChart(dates, series, detailed) {
  const n = dates.length;
  if (!n) return '<div class="empty" style="padding:24px 0">데이터가 없습니다.</div>';

  const H = detailed ? 340 : 220;
  const W = 640, padL = 14, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const totals = dates.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] || 0), 0));
  const gap = plotW / n;
  const barW = Math.max(1, gap * 0.72);
  const xAt = i => padL + i * gap + (gap - barW) / 2;

  let barsHtml = '';
  for (let i = 0; i < n; i++) {
    const total = totals[i];
    let yCursor = padT + plotH;
    const x = xAt(i).toFixed(1);
    series.forEach(s => {
      const raw = s.values[i] || 0;
      if (!raw || !total) return;
      const pct = raw / total * 100;
      const segH = pct / 100 * plotH;
      const yTop = yCursor - segH;
      barsHtml += `<rect x="${x}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" fill="${s.color}"><title>${_esc(dates[i])} ${_esc(s.label)}: ${raw}건 (${pct.toFixed(0)}%)</title></rect>`;
      yCursor = yTop;
    });
    if (!total) barsHtml += `<rect x="${x}" y="${(padT + plotH - 1).toFixed(1)}" width="${barW.toFixed(1)}" height="1" fill="var(--border)"/>`;
  }

  const labelCount = detailed ? Math.min(24, n) : Math.min(6, n);
  const labelIdxs = [...new Set(Array.from({ length: labelCount }, (_, k) => Math.round(k * (n - 1) / Math.max(1, labelCount - 1))))];
  const xLabelsHtml = labelIdxs.map(i => {
    const cx = xAt(i) + barW / 2;
    const anchor = detailed ? 'end' : (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
    const transform = detailed ? ` transform="rotate(-55 ${cx.toFixed(1)} ${H - 4})"` : '';
    return `<text x="${cx.toFixed(1)}" y="${H - 4}" font-size="${detailed ? 8 : 9}" text-anchor="${anchor}"${transform}>${_esc(dates[i].slice(5))}</text>`;
  }).join('');

  const legendHtml = `<div class="chart-legend">${series.map(s =>
    `<span class="li"><span class="dot" style="background:${s.color}"></span>${_esc(s.label)}</span>`).join('')}</div>`;

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" aria-label="${_esc(series.map(s => s.label).join(', '))} 부문별 참여 비율 막대차트">
      ${barsHtml}${xLabelsHtml}
    </svg>${legendHtml}`;
}

// 확대 모달에서 "그냥 크게"가 아니라 실제로 더 촘촘한(x축 라벨 다수+값 라벨)
// 버전을 보여주기 위한 레지스트리 — insightKey별로 "detailed:true로 다시
// 그려주는 함수"를 등록해두고, 모달을 열 때 그 함수를 호출해 재렌더링함.
let _chartRegistry = {};

// 차트 카드 하나(제목 + AI 분석 자리 + SVG)를 공통 마크업으로 생성.
// insightKey가 있으면 "AI 분석 보기" 클릭 시 #insight-{key} 자리에 문장이 채워짐.
// detailedRenderFn(선택): 확대 모달 전용으로 더 촘촘하게 다시 그리는 0-인자 함수.
// 안 주면 그냥 지금 보이는 SVG를 크기만 키워서 보여줌(기존 동작 유지).
function _chartCardHtml(title, insightKey, bodyHtml, detailedRenderFn) {
  const hasSvg = /<svg[\s>]/.test(bodyHtml);
  if (hasSvg && insightKey && detailedRenderFn) _chartRegistry[insightKey] = detailedRenderFn;
  return `
    <div class="card">
      <div class="chart-title">${_esc(title)}</div>
      ${insightKey ? `<div class="insight" id="insight-${insightKey}" style="display:none"></div>` : ''}
      <div${hasSvg ? ` class="chart-zoomable" data-chart-title="${_esc(title)}" data-chart-key="${_esc(insightKey || '')}" onclick="_openChartModal(this)" title="클릭하면 크게+자세히 보기"` : ''}>${bodyHtml}</div>
    </div>`;
}

function _openChartModal(el) {
  const modal = document.getElementById('chart-modal');
  const body = document.getElementById('chart-modal-body');
  const titleEl = document.getElementById('chart-modal-title');
  if (!modal || !body) return;
  const key = el.dataset.chartKey;
  const detailedFn = key && _chartRegistry[key];
  if (detailedFn) {
    body.innerHTML = detailedFn();
  } else if (el.querySelector('svg')) {
    body.innerHTML = el.innerHTML; // 등록된 상세 렌더러가 없으면 기존처럼 그대로 확대만
  } else {
    return; // 데이터 없음/로딩 중 등 SVG 자체가 없는 카드는 확대 안 함
  }
  if (titleEl) titleEl.textContent = el.dataset.chartTitle || '';
  modal.classList.add('open');
}
function _closeChartModal() {
  const modal = document.getElementById('chart-modal');
  if (modal) modal.classList.remove('open');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeChartModal(); });

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
    ['└ 친구추천 가입', last.referred_new_users_count, prev && prev.referred_new_users_count],
    ['글쓴 유저', last.writer_count, prev && prev.writer_count],
    ['제출글', last.submission_count, prev && prev.submission_count],
    ['투표 유저', last.voter_count, prev && prev.voter_count],
    ['총 투표수', last.vote_count, prev && prev.vote_count],
    ['단어챌린지 작성', last.wc_writer_count, prev && prev.wc_writer_count],
    ['초성 문장 퀴즈 참여자', last.hint_participant_count, prev && prev.hint_participant_count],
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
    </div>
    <div style="margin-top:14px;font-size:13px;color:var(--muted)">
      🏆 누적 업적(뱃지) 달성 건수: <span style="color:var(--text);font-weight:700">${lifetime.achievements_total ?? 0}</span>건
    </div>`);
}

// ── D1/D7/D30 형태 코호트 표 (신규가입 리텐션 · 가입후 첫활동 전환 공용) ──
function _cohortCellHtml(pct, n) {
  if (pct == null) return '<span style="color:var(--muted)">-</span>';
  return `${pct}% <span style="color:var(--muted);font-size:11px">(n=${n})</span>`;
}
function _cohortTableHtml(cohorts, valueLabel) {
  if (!cohorts || !cohorts.length) return '<div class="empty">가입 주차별 데이터가 없습니다.</div>';
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
      <span style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px dashed var(--border);border-radius:8px">
        <span style="font-size:11px;color:var(--muted)">직접 지정</span>
        <span style="font-size:11px;color:var(--muted)">시작일</span>
        <input type="date" id="range-start" aria-label="시작일" value="${_customRange ? _esc(_customRange.start_date) : ''}">
        <span style="color:var(--muted)">~</span>
        <span style="font-size:11px;color:var(--muted)">종료일</span>
        <input type="date" id="range-end" aria-label="종료일" value="${_customRange ? _esc(_customRange.end_date) : ''}">
        <button class="btn btn-ghost btn-sm" onclick="_setCustomRange()">기간 조회</button>
      </span>
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
      achievements: res.achievements, lifetime: res.lifetime,
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
  // 대규모 콘텐츠 업그레이드(초성힌트/초스피드/장르전환/결말고정/동화각색 5종)
  // 배포일 — 관련 지표 차트에 점선 기준선으로 표시해 전후 비교를 눈으로 바로 함.
  const CONTENT_UPGRADE_MARKERS = [{ date: '2026-07-28', label: '콘텐츠 업그레이드' }];
  const cumulativeChart = _svgComboChart(
    dates,
    { label: '일별 신규가입', color: 'var(--accent)', values: res.series.map(d => d.new_users_count) },
    { label: '누적 가입자 수', color: 'var(--accent2)', values: res.series.map(d => d.cumulative_users) },
    CONTENT_UPGRADE_MARKERS
  );
  const conversionChart = _svgLineChart([
    { label: '방문자→가입 전환율(%)', color: 'var(--success)', values: res.series.map(d => d.visitor_signup_conversion_pct) },
  ], dates, CONTENT_UPGRADE_MARKERS);
  const womChart = _svgLineChart([
    { label: '친구추천 가입 비율(%)', color: 'var(--accent2)', values: res.series.map(d => d.referred_signup_pct) },
  ], dates, CONTENT_UPGRADE_MARKERS);
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
  const sectionChart = _svgStackedBarChart(dates, [
    { label: '단어챌린지 응모', color: 'var(--success)', values: res.series.map(d => d.section_word_challenge) },
    { label: '단어챌린지 선정작 이어쓰기', color: 'var(--accent)', values: res.series.map(d => d.section_word_challenge_story) },
    { label: '초성 문장 퀴즈 시도', color: '#4a4364', values: res.series.map(d => d.hint_guess_count) },
    { label: '초스피드', color: '#7a4030', values: res.series.map(d => d.section_speedrun) },
    { label: '장르전환', color: '#4a4a8a', values: res.series.map(d => d.section_genre_switch) },
    { label: '결말고정', color: '#2e5f66', values: res.series.map(d => d.section_fixed_ending) },
    { label: '동화각색', color: '#8a4a5c', values: res.series.map(d => d.section_fairytale) },
    { label: '스포트라이트(레거시, 문장제안+AI픽)', color: 'var(--accent2)', values: res.series.map(d => d.section_spotlight_other) },
    { label: '자유 이야기', color: '#8a6420', values: res.series.map(d => d.section_free) },
  ]);
  const achievementDates = (res.achievements || []).map(d => d.date);
  const achievementChart = _svgLineChart([
    { label: '업적 달성 건수', color: 'var(--accent2)', values: (res.achievements || []).map(d => d.count) },
  ], achievementDates);

  _app().innerHTML = `
    ${_rangeControlsHtml()}
    <div class="card" id="insight-overall-block" style="display:none;border-color:var(--accent2)">
      <div class="chart-title">🤖 AI 종합 분석</div>
      <div class="insight-text" style="font-size:13.5px;line-height:1.6"></div>
    </div>
    ${_kpiCardsHtml(res.series)}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
      <div class="card" style="padding:12px 18px;margin-bottom:0;min-width:110px">
        <div style="font-size:11px;color:var(--muted)">🌍 /bang/en/ 방문자(오늘)</div>
        <div id="en-visitor-today" style="font-size:20px;font-weight:700">…</div>
      </div>
      <div class="card" style="padding:12px 18px;margin-bottom:0;min-width:110px">
        <div style="font-size:11px;color:var(--muted)">🌍 /bang/en/ 방문자(어제)</div>
        <div id="en-visitor-yesterday" style="font-size:20px;font-weight:700">…</div>
      </div>
    </div>
    ${_missingRangeHtml(res.series)}
    <div id="ga4-setup-wrap"></div>
    ${_chartCardHtml('📈 누적 가입자 수 추이 (막대: 일별 신규가입 · 선: 누적, 콘텐츠 업그레이드 기준선 포함)', 'cumulative_users', cumulativeChart, () => _svgComboChart(
      dates,
      { label: '일별 신규가입', color: 'var(--accent)', values: res.series.map(d => d.new_users_count) },
      { label: '누적 가입자 수', color: 'var(--accent2)', values: res.series.map(d => d.cumulative_users) },
      CONTENT_UPGRADE_MARKERS, true
    ))}
    ${_chartCardHtml('🔀 일별 방문자→가입 전환율 (그날 방문자 대비 그날 신규가입, %)', 'conversion', conversionChart, () => _svgLineChart([
      { label: '방문자→가입 전환율(%)', color: 'var(--success)', values: res.series.map(d => d.visitor_signup_conversion_pct) },
    ], dates, CONTENT_UPGRADE_MARKERS, true))}
    ${_chartCardHtml('🗣️ 일별 친구추천 가입 비율 (검증된 지인추천, 홍보 없는 입소문 신호)', 'word_of_mouth', womChart, () => _svgLineChart([
      { label: '친구추천 가입 비율(%)', color: 'var(--accent2)', values: res.series.map(d => d.referred_signup_pct) },
    ], dates, CONTENT_UPGRADE_MARKERS, true))}
    ${_chartCardHtml('📈 일별 방문자 추이 (순방문 · 총접속)', 'visitors', visitorsChart, () => _svgLineChart([
      { label: '순방문', color: 'var(--accent)', values: res.series.map(d => d.visitors_unique) },
      { label: '총접속', color: 'var(--accent2)', values: res.series.map(d => d.visitors_total) },
    ], dates, null, true))}
    ${_chartCardHtml('✍️ 일별 글 작성 현황 (작성 유저수 · 제출글 수, AI 제외)', 'writers', writerChart, () => _svgLineChart([
      { label: '글쓴 유저', color: 'var(--accent2)', values: res.series.map(d => d.writer_count) },
      { label: '제출글 수', color: 'var(--accent)', values: res.series.map(d => d.submission_count) },
    ], dates, null, true))}
    ${_chartCardHtml('🗳️ 일별 투표 현황 (투표 유저수 · 총 투표수, AI 제외)', 'votes', voteChart, () => _svgLineChart([
      { label: '투표 유저', color: 'var(--accent2)', values: res.series.map(d => d.voter_count) },
      { label: '총 투표수', color: 'var(--accent)', values: res.series.map(d => d.vote_count) },
    ], dates, null, true))}
    ${_chartCardHtml('🎲 오늘의 단어챌린지 작성 유저수 추이', 'word_challenge', wcChart, () => _svgLineChart([
      { label: '단어챌린지 작성 유저', color: 'var(--success)', values: res.series.map(d => d.wc_writer_count) },
    ], dates, null, true))}
    ${_chartCardHtml('🔥 일별 활성 유저 (DAU, 출석 기준)', 'dau', dauChart, () => _svgLineChart([
      { label: 'DAU', color: 'var(--success)', values: res.series.map(d => d.active_user_count) },
    ], dates, null, true))}
    ${_chartCardHtml('🔁 재방문 빈도 (Stickiness: DAU/WAU · DAU/MAU, %)', 'stickiness', stickinessChart, () => _svgLineChart([
      { label: 'DAU/WAU(%)', color: 'var(--accent2)', values: res.stickiness.map(d => d.dau_wau_pct) },
      { label: 'DAU/MAU(%)', color: 'var(--accent)', values: res.stickiness.map(d => d.dau_mau_pct) },
    ], stickinessDates, null, true))}
    ${_chartCardHtml('📊 주간 잔존율 추이 (지난주 WAU 대비 이번주 잔존율, %)', 'retention', retentionChart, () => _svgLineChart([
      { label: '주간 잔존율(%)', color: 'var(--accent2)', values: res.retention.map(d => d.retention_pct) },
    ], retentionDates, null, true))}
    ${_chartCardHtml('🧭 일별 부문 참여 비율 (그날 참여가 어디에 몰렸는지, 100% 기준)', 'sections', sectionChart, () => _svgStackedBarChart(dates, [
      { label: '단어챌린지 응모', color: 'var(--success)', values: res.series.map(d => d.section_word_challenge) },
      { label: '단어챌린지 선정작 이어쓰기', color: 'var(--accent)', values: res.series.map(d => d.section_word_challenge_story) },
      { label: '초성 문장 퀴즈 시도', color: '#4a4364', values: res.series.map(d => d.hint_guess_count) },
      { label: '초스피드', color: '#7a4030', values: res.series.map(d => d.section_speedrun) },
      { label: '장르전환', color: '#4a4a8a', values: res.series.map(d => d.section_genre_switch) },
      { label: '결말고정', color: '#2e5f66', values: res.series.map(d => d.section_fixed_ending) },
      { label: '동화각색', color: '#8a4a5c', values: res.series.map(d => d.section_fairytale) },
      { label: '스포트라이트(레거시, 문장제안+AI픽)', color: 'var(--accent2)', values: res.series.map(d => d.section_spotlight_other) },
      { label: '자유 이야기', color: '#8a6420', values: res.series.map(d => d.section_free) },
    ], true))}
    ${_chartCardHtml('🏆 일별 업적(뱃지) 달성 건수', 'achievements', achievementChart, () => _svgLineChart([
      { label: '업적 달성 건수', color: 'var(--accent2)', values: (res.achievements || []).map(d => d.count) },
    ], achievementDates, null, true))}
    <div class="card">
      <div class="chart-title">📔 훔쳐본 일기장 — 결말 도달 인원 (책별)</div>
      <div class="insight" id="insight-diary_ending" style="display:none"></div>
      <div id="diary-ending-chart-body" class="chart-zoomable" data-chart-title="📔 훔쳐본 일기장 — 결말 도달 인원 (책별)" data-chart-key="diary_ending" onclick="_openChartModal(this)" title="클릭하면 크게+자세히 보기"><div class="loading" style="padding:16px 0">불러오는 중...</div></div>
    </div>
    <div class="card">
      <div class="chart-title">⏱️ 일별 평균 체류시간 (Google Analytics)</div>
      <div class="insight" id="insight-dwell_time" style="display:none"></div>
      <div id="ga4-chart-body" class="chart-zoomable" data-chart-title="⏱️ 일별 평균 체류시간 (Google Analytics)" data-chart-key="dwell_time" onclick="_openChartModal(this)" title="클릭하면 크게+자세히 보기"><div class="loading" style="padding:16px 0">불러오는 중...</div></div>
    </div>
    <div class="card">
      <div class="chart-title">🔂 방문자 1인당 하루 평균 방문 횟수 (Google Analytics, 그날 온 사람 기준)</div>
      <div class="insight" id="insight-visit_frequency" style="display:none"></div>
      <div id="ga4-freq-chart-body" class="chart-zoomable" data-chart-title="🔂 방문자 1인당 하루 평균 방문 횟수" data-chart-key="visit_frequency" onclick="_openChartModal(this)" title="클릭하면 크게+자세히 보기"><div class="loading" style="padding:16px 0">불러오는 중...</div></div>
    </div>
    <div class="card">
      <div class="chart-title">📱 일별 기기 종류 분포 (모바일 · PC · 태블릿, Google Analytics, 100% 기준)</div>
      <div class="insight" id="insight-device" style="display:none"></div>
      <div id="ga4-device-chart-body" class="chart-zoomable" data-chart-title="📱 일별 기기 종류 분포" data-chart-key="device" onclick="_openChartModal(this)" title="클릭하면 크게+자세히 보기"><div class="loading" style="padding:16px 0">불러오는 중...</div></div>
    </div>
    <div class="card">
      <div class="chart-title">🌍 /bang/en/ 유입 소스 (구글 · 빙 · 기타, Google Analytics)</div>
      <div class="insight" id="insight-en_source" style="display:none"></div>
      <div id="ga4-en-source-chart-body" class="chart-zoomable" data-chart-title="🌍 /bang/en/ 유입 소스" data-chart-key="en_source" onclick="_openChartModal(this)" title="클릭하면 크게+자세히 보기"><div class="loading" style="padding:16px 0">불러오는 중...</div></div>
    </div>
    ${_lifetimeCardHtml(res.lifetime)}
    <div class="card">
      <div class="chart-title">🧮 신규가입 주차별 D1/D7/D30 잔존율 (참고용, 표본 적을 수 있음)</div>
      <div class="insight" id="insight-cohorts" style="display:none"></div>
      ${_cohortTableHtml(res.cohorts, '잔존율')}
    </div>
    <div class="card">
      <div class="chart-title">🚀 가입→첫 활동 전환율 (D1/D7/D30 안에 글쓰기 또는 투표를 해봤는지)</div>
      <div class="insight" id="insight-activation" style="display:none"></div>
      ${_cohortTableHtml(res.activation_cohorts, '전환율')}
    </div>
    <div class="card">
      <div class="chart-title">🏁 이야기 시작 주 기준 완주율 (현재 상태 기준, 오래된 주차일수록 안정적)</div>
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

  // GA4 체류시간은 별도 API(느릴 수 있음/미설정일 수 있음)라 대시보드 본문
  // 렌더가 끝난 뒤 비동기로 따로 불러와 해당 자리만 채움 — 실패해도 나머지
  // 차트 렌더링에 영향 없음.
  const startDate = dates[0], endDate = dates[dates.length - 1];
  _loadGa4Chart(startDate, endDate);
  _loadGa4DeviceChart(startDate, endDate);
  _loadGa4EnSourceChart(startDate, endDate);
  _loadGa4SetupCard();
  _loadDiaryEndingStats();
}

// ── 훔쳐본 일기장: 결말 도달 인원 (책별, getAnalyticsDashboard와 별개 호출) ──
async function _loadDiaryEndingStats() {
  const el = document.getElementById('diary-ending-chart-body');
  const auth = window._analyticsAuth;
  if (!el || !auth) return;
  try {
    const fn = functionsRegion.httpsCallable('getDiaryEndingStats');
    const r = await fn({ user_id: auth.user_id, token: auth.token });
    const data = r.data;
    if (!data || !data.ok) {
      el.innerHTML = `<div class="empty" style="padding:16px 0">${_esc((data && data.error) || '불러오지 못했습니다.')}</div>`;
      return;
    }
    const byBook = data.by_book || [];
    const labels = byBook.map(b => b.book_title || b.book_id);
    const values = byBook.map(b => b.total || 0);
    el.innerHTML = _svgCategoryBarChart(labels, values, 'var(--accent2)');
    _chartRegistry.diary_ending = () => {
      const detailRows = (data.by_ending || []).map(e =>
        `<tr><td>${_esc(e.book_title || e.book_id)}</td><td>${_esc(e.ending_title || e.node_id)}</td><td style="text-align:right">${e.count}</td></tr>`
      ).join('');
      return `${_svgCategoryBarChart(labels, values, 'var(--accent2)')}
        <table style="width:100%;margin-top:12px;font-size:13px;border-collapse:collapse">
          <thead><tr><th style="text-align:left">책</th><th style="text-align:left">결말</th><th style="text-align:right">도달 인원</th></tr></thead>
          <tbody>${detailRows || '<tr><td colspan="3">데이터가 없습니다.</td></tr>'}</tbody>
        </table>`;
    };
  } catch (e) {
    el.innerHTML = `<div class="empty" style="padding:16px 0">불러오지 못했습니다: ${_esc(e.message || '알 수 없는 오류')}</div>`;
  }
}

// ── Google Analytics 4 연동 (체류시간 + 1인당 방문횟수, 한 번의 호출로 같이 받음) ──
async function _loadGa4Chart(startDate, endDate) {
  const el = document.getElementById('ga4-chart-body');
  const freqEl = document.getElementById('ga4-freq-chart-body');
  const auth = window._analyticsAuth;
  if (!el || !auth) return;
  try {
    const fn = functionsRegion.httpsCallable('getGa4EngagementTrend');
    const r = await fn({ user_id: auth.user_id, token: auth.token, start_date: startDate, end_date: endDate });
    const data = r.data;
    if (!data || !data.ok) {
      const msg = `<div class="empty" style="padding:16px 0">${_esc((data && data.error) || 'GA4 연동이 설정되지 않았어요.')} 아래 "Google Analytics 연동 설정"에서 등록할 수 있어요.</div>`;
      el.innerHTML = msg;
      if (freqEl) freqEl.innerHTML = msg;
      return;
    }
    const gDates = data.series.map(d => d.date);
    // GA4 averageSessionDuration은 초 단위로 옴 — 수백~수천이라 감이 안 와서
    // 분 단위(소수 1자리)로 변환해서 보여줌. 트래픽이 적은 날은 탭을 오래
    // 켜둔 사람 한둘 때문에 그날 평균이 확 튈 수 있음(표본이 작을 때 흔함).
    const minutesVals = data.series.map(d => d.avg_engagement_seconds != null ? +(d.avg_engagement_seconds / 60).toFixed(1) : null);
    el.innerHTML = _svgLineChart([
      { label: '평균 체류시간(분)', color: 'var(--success)', values: minutesVals },
    ], gDates);
    _chartRegistry.dwell_time = () => _svgLineChart([
      { label: '평균 체류시간(분)', color: 'var(--success)', values: minutesVals },
    ], gDates, null, true);
    if (freqEl) {
      freqEl.innerHTML = _svgLineChart([
        { label: '1인당 하루 평균 방문(세션) 횟수', color: 'var(--accent2)', values: data.series.map(d => d.sessions_per_user) },
      ], gDates);
      _chartRegistry.visit_frequency = () => _svgLineChart([
        { label: '1인당 하루 평균 방문(세션) 횟수', color: 'var(--accent2)', values: data.series.map(d => d.sessions_per_user) },
      ], gDates, null, true);
    }
  } catch (e) {
    const msg = `<div class="empty" style="padding:16px 0">불러오지 못했습니다: ${_esc(e.message || '알 수 없는 오류')}</div>`;
    el.innerHTML = msg;
    if (freqEl) freqEl.innerHTML = msg;
  }
}

async function _loadGa4DeviceChart(startDate, endDate) {
  const el = document.getElementById('ga4-device-chart-body');
  const auth = window._analyticsAuth;
  if (!el || !auth) return;
  try {
    const fn = functionsRegion.httpsCallable('getGa4DeviceTrend');
    const r = await fn({ user_id: auth.user_id, token: auth.token, start_date: startDate, end_date: endDate });
    const data = r.data;
    if (!data || !data.ok) {
      el.innerHTML = `<div class="empty" style="padding:16px 0">${_esc((data && data.error) || 'GA4 연동이 설정되지 않았어요.')}</div>`;
      return;
    }
    const dDates = data.series.map(d => d.date);
    const hasOther = data.series.some(d => d.other > 0);
    const buildSeries = () => {
      const s = [
        { label: '모바일', color: 'var(--accent2)', values: data.series.map(d => d.mobile) },
        { label: 'PC', color: 'var(--accent)', values: data.series.map(d => d.desktop) },
        { label: '태블릿', color: 'var(--success)', values: data.series.map(d => d.tablet) },
      ];
      if (hasOther) s.push({ label: '기타(스마트TV 등)', color: '#7a5c40', values: data.series.map(d => d.other) });
      return s;
    };
    el.innerHTML = _svgStackedBarChart(dDates, buildSeries());
    _chartRegistry.device = () => _svgStackedBarChart(dDates, buildSeries(), true);
  } catch (e) {
    el.innerHTML = `<div class="empty" style="padding:16px 0">불러오지 못했습니다: ${_esc(e.message || '알 수 없는 오류')}</div>`;
  }
}

// /bang/en/ 유입 소스(구글/빙/기타) — 영어판 SEO/애드핏(외국인 트래픽) 작업이
// 실제로 어느 채널에서 유입을 만드는지 확인용(2026-09-02). 기기 분포 차트와
// 같은 (date, category) 스택형 구조라 _svgStackedBarChart를 그대로 재사용.
async function _loadGa4EnSourceChart(startDate, endDate) {
  const el = document.getElementById('ga4-en-source-chart-body');
  const auth = window._analyticsAuth;
  if (!el || !auth) return;
  try {
    const fn = functionsRegion.httpsCallable('getGa4EnSourceTrend');
    const r = await fn({ user_id: auth.user_id, token: auth.token, start_date: startDate, end_date: endDate });
    const data = r.data;
    const todayEl0 = document.getElementById('en-visitor-today');
    const yesterdayEl0 = document.getElementById('en-visitor-yesterday');
    if (!data || !data.ok) {
      el.innerHTML = `<div class="empty" style="padding:16px 0">${_esc((data && data.error) || 'GA4 연동이 설정되지 않았어요.')}</div>`;
      if (todayEl0) todayEl0.textContent = '-';
      if (yesterdayEl0) yesterdayEl0.textContent = '-';
      return;
    }
    if (!data.series.length) {
      el.innerHTML = `<div class="empty" style="padding:16px 0">아직 /bang/en/ 방문 데이터가 없어요(태그를 막 추가해서 그럴 수 있어요).</div>`;
      if (todayEl0) todayEl0.textContent = '0명';
      if (yesterdayEl0) yesterdayEl0.textContent = '0명';
      return;
    }
    // 상단 KPI 카드(_kpiCardsHtml)는 배치 집계 특성상 "오늘"이 절대 안 나오는데
    // (하루 1번 KST 00:15 집계), GA4는 실시간에 가까워서 "오늘"까지 보여줄 수
    // 있음 — 그래서 선택된 기간(startDate/endDate)과 무관하게 KST 기준
    // 오늘/어제로 직접 계산(2026-09-02, "en 페이지 방문자 칸" 요청).
    const kstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const kstYesterday = new Date(Date.now() + 9 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
    const sumOf = dateStr => {
      const row = data.series.find(d => d.date === dateStr);
      return row ? (row.google + row.bing + row.direct + row.other) : 0;
    };
    const todayEl = document.getElementById('en-visitor-today');
    const yesterdayEl = document.getElementById('en-visitor-yesterday');
    if (todayEl) todayEl.textContent = `${sumOf(kstToday)}명`;
    if (yesterdayEl) yesterdayEl.textContent = `${sumOf(kstYesterday)}명`;

    const eDates = data.series.map(d => d.date);
    const hasOther = data.series.some(d => d.other > 0);
    const buildSeries = () => {
      // ⚠️ --accent(세이지 그린)와 --success(초록)가 둘 다 초록 계열이라 빙/
      // 다이렉트가 구분 안 된다는 지적(2026-09-02) — 빙만 파란색 계열로 교체.
      const s = [
        { label: '구글', color: 'var(--accent2)', values: data.series.map(d => d.google) },
        { label: '빙', color: '#4a6fa5', values: data.series.map(d => d.bing) },
        { label: '다이렉트(URL 직접입력 등)', color: 'var(--success)', values: data.series.map(d => d.direct) },
      ];
      if (hasOther) s.push({ label: '기타', color: '#7a5c40', values: data.series.map(d => d.other) });
      return s;
    };
    // 막대만 보면 정확한 인원수를 알기 어렵다는 지적(2026-09-02)에 대응 —
    // 선택 기간 합계를 텍스트로 바로 보여줌(마우스오버 title 툴팁에 기대지 않음).
    const totalsHtml = () => `<div style="display:flex;flex-wrap:wrap;gap:10px;font-size:13px;margin-bottom:10px">
      ${buildSeries().map(s => `<span><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.color};margin-right:4px"></span>${_esc(s.label)} <strong>${s.values.reduce((a, b) => a + b, 0)}명</strong></span>`).join('')}
    </div>`;
    el.innerHTML = totalsHtml() + _svgStackedBarChart(eDates, buildSeries());
    _chartRegistry.en_source = () => totalsHtml() + _svgStackedBarChart(eDates, buildSeries(), true);
  } catch (e) {
    el.innerHTML = `<div class="empty" style="padding:16px 0">불러오지 못했습니다: ${_esc(e.message || '알 수 없는 오류')}</div>`;
  }
}

async function _loadGa4SetupCard() {
  const wrap = document.getElementById('ga4-setup-wrap');
  const auth = window._analyticsAuth;
  if (!wrap || !auth) return;
  let status = { has_key: false, property_id: null };
  try {
    const fn = functionsRegion.httpsCallable('getGa4KeyStatus');
    const r = await fn({ user_id: auth.user_id, token: auth.token });
    if (r.data && r.data.ok) status = r.data;
  } catch (e) { /* 상태 조회 실패해도 폼은 그대로 보여줌(빈 값으로) */ }

  const configured = status.has_key;
  wrap.innerHTML = `
    <div class="card">
      <details${configured ? '' : ' open'}>
        <summary style="cursor:pointer;font-size:13px;font-weight:700">
          🔌 Google Analytics 연동 설정
          <span style="font-size:11px;font-weight:400;margin-left:6px;color:${configured ? 'var(--success)' : 'var(--accent2)'}">${configured ? '✓ 설정됨' : '미설정 — 체류시간 차트 비활성'}</span>
        </summary>
        <div style="font-size:12px;color:var(--muted);margin:10px 0">
          GA4(gtag.js)가 이미 세션 참여시간을 자동 수집 중이라 새 계측 없이 GA4 Data API로 읽어오기만 하면 됩니다.
          Google Cloud Console에서 서비스 계정을 만들고 JSON 키를 발급 → GA4 관리자 → 속성 액세스 관리에서 그 서비스계정 이메일을 "뷰어"로 추가 → GA4 관리자 → 속성 세부정보에서 속성 ID(숫자, 상단 측정 ID "G-..."와는 다름)를 확인해 아래에 입력하세요.
        </div>
        <div style="margin-bottom:8px">
          <input type="text" id="ga4-property-input" placeholder="GA4 속성 ID (숫자만)" value="${status.property_id ? _esc(status.property_id) : ''}"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--bg);color:var(--text);box-sizing:border-box">
        </div>
        <textarea id="ga4-json-input" placeholder="서비스 계정 JSON 키 전체를 붙여넣으세요" rows="4"
          style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;background:var(--bg);color:var(--text);box-sizing:border-box;font-family:monospace;margin-bottom:8px"></textarea>
        <button class="btn btn-primary btn-sm" onclick="_saveGa4Key()">저장</button>
        <span id="ga4-save-status" style="font-size:12px;color:var(--muted);margin-left:8px"></span>
      </details>
    </div>`;
}

async function _saveGa4Key() {
  const auth = window._analyticsAuth;
  const propertyId = document.getElementById('ga4-property-input')?.value.trim();
  const json = document.getElementById('ga4-json-input')?.value.trim();
  const statusEl = document.getElementById('ga4-save-status');
  if (!propertyId || !json) { if (statusEl) statusEl.textContent = '속성 ID와 JSON 키를 모두 입력해주세요.'; return; }
  if (statusEl) statusEl.textContent = '저장 중...';
  try {
    const fn = functionsRegion.httpsCallable('setGa4Key');
    const r = await fn({ user_id: auth.user_id, token: auth.token, property_id: propertyId, service_account_json: json });
    if (!r.data || !r.data.ok) { if (statusEl) statusEl.textContent = '저장 실패'; return; }
    if (statusEl) statusEl.textContent = '저장됐어요. 차트를 다시 불러옵니다...';
    const dates = _lastDashboardRes ? _lastDashboardRes.series.map(d => d.date) : [];
    if (dates.length) await _loadGa4Chart(dates[0], dates[dates.length - 1]);
    await _loadGa4SetupCard();
  } catch (e) {
    if (statusEl) statusEl.textContent = '저장 실패: ' + (e.message || '알 수 없는 오류');
  }
}

// ── 진입점 ────────────────────────────────────────────────
(async function _init() {
  const auth = await _authGate();
  if (!auth) return;
  window._analyticsAuth = auth;
  await _refresh();
})();
