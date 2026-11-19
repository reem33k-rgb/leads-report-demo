'use strict';

/* ---------- dates (all as YYYY-MM-DD in Israel time) ---------- */
const TZ = 'Asia/Jerusalem';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const todayIso = () => dayFmt.format(new Date());
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const minuteOfDay = date => { const [h, m] = hmFmt.format(date).split(':'); return +h * 60 + +m; };
const toDate = iso => new Date(iso + 'T12:00:00Z');
const toIso = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d); };
const addYears = (iso, n) => { const d = toDate(iso); d.setUTCFullYear(d.getUTCFullYear() + n); return toIso(d); };
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5) + 1;
const monthStart = iso => iso.slice(0, 8) + '01';
const fmtDay = iso => { const [y, m, d] = iso.split('-'); return `${+d}.${+m}.${y.slice(2)}`; };

const PRESETS = [
  { id: 'today', label: 'היום', range: t => [t, t] },
  { id: 'yesterday', label: 'אתמול', range: t => [addDays(t, -1), addDays(t, -1)] },
  { id: 'month', label: 'החודש', range: t => [monthStart(t), t] },
  { id: 'custom', label: 'טווח מותאם', range: null }
];

/* ---------- state ---------- */
const S = {
  preset: 'month', from: null, to: null, compare: 'prev',
  filters: { platform: '', audience: '', status: '' },
  names: 'display', sort: { key: 'leads', dir: -1 }, open: new Set(),
  adSort: { key: 'leads', dir: -1 }, adQuery: '', adAll: false, spend: {}, spendErr: false, thumbs: {},
  loaded: null, rows: [], map: [], updatedAt: null, chart: null
};
try {
  const saved = JSON.parse(localStorage.getItem('cg_report_prefs') || '{}');
  if (saved.preset && PRESETS.some(p => p.id === saved.preset)) S.preset = saved.preset;
  if (saved.compare) S.compare = saved.compare;
} catch { /* ignore */ }
const savePrefs = () => { try { localStorage.setItem('cg_report_prefs', JSON.stringify({ preset: S.preset, compare: S.compare })); } catch { /* ignore */ } };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('he-IL');
const n = v => nf.format(v);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const money = v => (v == null || !isFinite(v) ? '—' : '<bdi dir="ltr">₪' + nf.format(Math.round(v)) + '</bdi>');
const div = (a, b) => (b ? a / b : null);

/* ---------- campaign mapping ---------- */
const NO_CAMP = 'אורגני';
const NO_COST = new Set([]);
// Matching: exact -> "contains" ignoring spaces/underscores/case -> unique campaign code (e.g. GO02B09E07B03A).
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9֐-׿]/g, '');
const CODE = /GO\d{2}[A-Z]\d{2}[A-Z]\d{2}[A-Z]\d{2}[A-Z]/i;
function findMap(c) {
  const nc = norm(c);
  const hit = S.map.find(m => c === m.match) || S.map.find(m => nc.includes(norm(m.match)));
  if (hit) return hit;
  const code = (c.match(CODE) || [])[0];
  if (!code) return null;
  const same = S.map.filter(m => (m.match.match(CODE) || [])[0]?.toUpperCase() === code.toUpperCase());
  return same.length && same.every(m => m.name === same[0].name) ? same[0] : null;
}
function classify(c) {
  if (!c) return { name: NO_CAMP, platform: NO_CAMP, audience: '', status: '', mapped: true };
  const hit = findMap(c);
  if (hit) return { name: hit.name, platform: hit.platform || guessPlatform(c), audience: hit.audience || '', status: hit.status || '', mapped: true };
  return { name: c, platform: guessPlatform(c), audience: '', status: '', mapped: false };
}
function guessPlatform(c) {
  const s = c.toLowerCase();
  if (s.includes('youtube') || s.includes('dv360')) return 'יוטיוב';
  if (s.includes('search') || s.includes('pmax') || s.includes('google')) return 'גוגל';
  if (s.includes('lead') || s.includes('facebook') || s.includes('meta') || s.includes('traffic') || s.includes('_lp_')) return 'מטא';
  return 'אחר';
}

/* ---------- leads kept out of the report (shown only in the table at the bottom) ---------- */
const EXCLUDE = [
  { key: 'private', label: 'ניסוי פרטי (Private Pilot)', note: 'פעילות ניסיונית נפרדת, לא נספרת בדוח', test: r => /Private_Pilot/i.test(r.c || '') },
  { key: 'service', label: 'מוקד שירות (Service Center)', note: 'פניות שירות, לא לידים חדשים', test: r => r.ls === 'Service-Center' }
];
const excludeOf = r => { const x = EXCLUDE.find(e => e.test(r)); return x ? x.key : null; };

function enrich(rows) {
  const cache = new Map();
  return rows.map(r => {
    let k = cache.get(r.c);
    if (!k) { k = classify(r.c); cache.set(r.c, k); }
    const dt = new Date(r.t);
    return { ...r, d: dayFmt.format(dt), mi: minuteOfDay(dt), cn: k.name, pf: k.platform, au: k.audience, ns: k.status, mapped: k.mapped, yes: r.q === 'Yes', ex: excludeOf(r) };
  });
}

/* ---------- data loading ---------- */
async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401) { showLock(); throw new Error('auth'); }
  return res;
}

async function ensureData(from, to, fresh) {
  const L = S.loaded;
  if (!fresh && L && L.from <= from && L.to >= to) return;
  const f = L && !fresh ? (from < L.from ? from : L.from) : from;
  const t = L && !fresh ? (to > L.to ? to : L.to) : to;
  setLoading(true);
  try {
    const res = await api(`/api/leads?from=${f}&to=${t}${fresh ? '&fresh=1' : ''}`);
    if (!res.ok) throw new Error('הנתונים לא נטענו (' + res.status + '). נסו לרענן בעוד דקה.');
    const data = await res.json();
    S.rows = enrich(data.rows || []);
    S.loaded = { from: f, to: t };
    S.updatedAt = new Date(data.meta?.generatedAt || Date.now());
    if (data.meta?.truncated) showError('שימו לב: באחד החודשים יש יותר מ-5,000 לידים והנתונים נחתכו.');
  } finally {
    setLoading(false);
  }
}

/* ---------- Meta spend (CAR2GO account, leasing campaigns) ---------- */
async function loadSpend(range, fresh) {
  if (!range) return;
  const key = range[0] + '|' + range[1];
  if (S.spend[key] && !fresh) return;
  try {
    const res = await api(`/api/spend?from=${range[0]}&to=${range[1]}${fresh ? '&fresh=1' : ''}`);
    if (!res.ok) throw new Error('spend ' + res.status);
    const data = await res.json();
    S.spend[key] = (data.rows || []).map(r => {
      const k = classify(r.c);
      return { ...r, cn: k.name, pf: 'מטא', au: k.audience, ns: k.status, mapped: k.mapped, ex: excludeOf(r) };
    });
    Object.assign(S.thumbs, data.thumbs || {});
    S.spendErr = false;
  } catch (e) {
    if (e.message === 'auth') throw e;
    S.spendErr = true;
  }
}
function pickSpend(range) {
  if (!range) return null;
  const F = S.filters;
  const rows = S.spend[range[0] + '|' + range[1]];
  if (!rows) return null;
  return rows.filter(r => !r.ex && (!F.platform || r.pf === F.platform) && (!F.audience || r.au === F.audience) && (!F.status || r.ns === F.status));
}
const sumSp = list => (list || []).reduce((t, r) => t + r.sp, 0);

function setLoading(on) { $('loading').hidden = !on; }
function showError(msg) { const e = $('error'); e.textContent = msg; e.hidden = !msg; }

/* ---------- ranges ---------- */
function currentRange() {
  if (S.preset === 'custom') return [S.from, S.to];
  return PRESETS.find(p => p.id === S.preset).range(todayIso());
}
function compareRange([from, to]) {
  if (S.compare === 'none') return null;
  if (S.compare === 'yoy') return [addYears(from, -1), addYears(to, -1)];
  const len = daysBetween(from, to);
  if (S.preset === 'month' || S.preset === 'lastMonth') {
    const pf = monthStart(addDays(from, -1));
    return [pf, addDays(pf, len - 1)];
  }
  return [addDays(from, -len), addDays(from, -1)];
}

/* ---------- filtering & aggregation ---------- */
// cutMin: on the last day of the range, only count leads created up to this minute (fair "so far" comparison)
function pick(from, to, cutMin = null) {
  const F = S.filters;
  return S.rows.filter(r => !r.ex && r.d >= from && r.d <= to
    && (cutMin == null || r.d !== to || r.mi <= cutMin)
    && (!F.platform || r.pf === F.platform)
    && (!F.audience || r.au === F.audience)
    && (!F.status || r.ns === F.status));
}
function stats(list) {
  const phones = new Set();
  let yes = 0;
  for (const r of list) { if (r.p) phones.add(r.p); if (r.yes) yes++; }
  return { leads: list.length, phones: phones.size, quotes: yes, rate: pct(yes, list.length) };
}
function groupBy(list, keyFn) {
  const m = new Map();
  for (const r of list) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}

/* ---------- render ---------- */
async function refresh(fresh = false) {
  showError('');
  const cur = currentRange();
  if (!cur[0] || !cur[1] || cur[0] > cur[1]) { showError('בחרו טווח תאריכים תקין.'); return; }
  const cmp = compareRange(cur);
  try {
    const t = todayIso();
    await ensureData(cmp && cmp[0] < cur[0] ? cmp[0] : cur[0], cur[1] > t ? cur[1] : t, fresh);
  } catch (e) {
    if (e.message !== 'auth') showError(e.message);
    return;
  }
  render(cur, cmp);
  const need = [cur, cmp].filter(r => r && (fresh || !S.spend[r[0] + '|' + r[1]]));
  if (!need.length) return;
  try { await Promise.all(need.map(r => loadSpend(r, fresh))); } catch (e) { return; }
  if (currentRange().join() === cur.join()) render(cur, cmp);
}

function render(cur, cmp) {
  const live = cur[1] === todayIso();
  const cut = live ? minuteOfDay(new Date()) : null;
  const A = pick(cur[0], cur[1]);
  const B = cmp ? pick(cmp[0], cmp[1], cut) : null;
  const a = stats(A), b = B ? stats(B) : null;
  const hhmm = cut != null ? ` עד ${String(Math.floor(cut / 60)).padStart(2, '0')}:${String(cut % 60).padStart(2, '0')}` : '';

  $('rangeLabel').textContent = `${fmtDay(cur[0])} – ${fmtDay(cur[1])} (${daysBetween(cur[0], cur[1])} ימים)` +
    (cmp ? ` · מושווה ל-${fmtDay(cmp[0])} – ${fmtDay(cmp[1])}${hhmm}` : '');
  $('updated').textContent = S.updatedAt ? 'עודכן ' + S.updatedAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '';

  renderFilters();
  const SA = pickSpend(cur), SB = cmp ? pickSpend(cmp) : null;
  renderKpis(a, b, A, B, SA, SB);
  const cmpDays = cmp ? (cmp[0] === cmp[1] ? fmtDay(cmp[0]) : `${fmtDay(cmp[0])}–${fmtDay(cmp[1])}`) : '';
  const cmpName = S.compare === 'yoy' ? 'אותה תקופה בשנה שעברה' : (daysBetween(cur[0], cur[1]) === 1 ? 'היום הקודם' : 'אותו מספר ימים בתקופה הקודמת');
  $('kpiNote').innerHTML = cmp
    ? `האחוז הירוק או האדום מתחת לכל מספר = השינוי לעומת <b>${cmpDays}${hhmm}</b> (${cmpName}${hhmm ? ', עד אותה שעה' : ''}).`
    : 'ההשוואה כבויה. אפשר להפעיל אותה ב"השוואה ל".';
  renderInsights(A, B, a, b);
  renderTrend(cur, cmp, A, B);
  renderCampaigns(A, B, a, SA);
  renderAds(A, SA);
  renderOldNew(A, SA);
  renderExcluded(cur);
  renderAlert();
}

function delta(cur, prev, unit = '%') {
  if (prev == null) return '';
  if (unit === 'pt') {
    const d = Math.round((cur - prev) * 10) / 10;
    if (!d) return '<span class="muted">ללא שינוי</span>';
    return `<span class="${d > 0 ? 'up' : 'down'}"><bdi dir="ltr">${d > 0 ? '+' : ''}${d}</bdi> נק׳</span>`;
  }
  if (!prev) return cur ? '<span class="up">חדש</span>' : '';
  const d = Math.round(((cur - prev) / prev) * 100);
  if (!d) return '<span class="muted">ללא שינוי</span>';
  return `<span class="${d > 0 ? 'up' : 'down'}"><bdi dir="ltr">${d > 0 ? '+' : ''}${d}%</bdi></span>`;
}

function deltaCost(cur, prev, neutral) {
  if (cur == null || prev == null || !prev) return '';
  const d = Math.round(((cur - prev) / prev) * 100);
  if (!d) return '<span class="muted">ללא שינוי</span>';
  const cls = neutral ? 'muted' : (d < 0 ? 'up' : 'down');
  return `<span class="${cls}"><bdi dir="ltr">${d > 0 ? '+' : ''}${d}%</bdi></span>`;
}
function metaCosts(list, sp) {
  const m = list.filter(r => r.pf === 'מטא' && !NO_COST.has(r.cn));
  const q = m.filter(r => r.yes).length;
  return { sp, leads: m.length, quotes: q, cpl: div(sp, m.length), cpq: div(sp, q) };
}
function renderKpis(a, b, A, B, SA, SB) {
  const k = (lbl, val, cmpHtml) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="cmp">${cmpHtml}</div></div>`;
  $('kpis').innerHTML =
    k('לידים', n(a.leads), delta(a.leads, b?.leads), b ? n(b.leads) : '') +
    k('נשלחה הצעת מחיר', n(a.quotes), delta(a.quotes, b?.quotes), b ? n(b.quotes) : '') +
    k('% הצעת מחיר מהלידים', a.rate + '%', delta(a.rate, b?.rate, 'pt'), b ? b.rate + '%' : '') +
    costKpis(A, B, SA, SB);
}
function costKpis(A, B, SA, SB) {
  const k = (lbl, val, cmpHtml, prevTxt, note) => `<div class="kpi cost"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="cmp">${cmpHtml}</div>${note || ''}</div>`;
  if (!SA) return `<div class="kpi soon"><div class="lbl">הוצאה ועלויות במטא</div><div class="val">₪ —</div><div class="cmp">${S.spendErr ? 'נתוני מטא לא נטענו. נסו לרענן' : 'טוען…'}</div></div>`;
  const x = metaCosts(A, sumSp(SA)), y = SB && B ? metaCosts(B, sumSp(SB)) : null;
  return k('הוצאה במטא', money(x.sp), y ? deltaCost(x.sp, y.sp, true) : '', y ? money(y.sp) : '') +
    k('עלות לליד (מטא)', money(x.cpl), y ? deltaCost(x.cpl, y.cpl) : '', y ? money(y.cpl) : '', `<div class="cmp">${n(x.leads)} לידים ממטא</div>`) +
    k('עלות להצעת מחיר (מטא)', money(x.cpq), y ? deltaCost(x.cpq, y.cpq) : '', y ? money(y.cpq) : '', `<div class="cmp">${n(x.quotes)} הצעות מחיר ממטא</div>`);
}

function renderInsights(A, B, a, b) {
  const out = [];
  if (!a.leads) { $('insights').innerHTML = '<li>אין לידים בטווח הזה.</li>'; return; }
  const g = [...groupBy(A, r => r.cn)].map(([k, l]) => ({ k, ...stats(l) })).sort((x, y) => y.leads - x.leads);
  const top = g.find(x => x.k !== NO_CAMP) || g[0];
  out.push(`<b>${esc(top.k)}</b> הביא הכי הרבה לידים: ${n(top.leads)} (${pct(top.leads, a.leads)}% מהכלל), ${top.rate}% מהם קיבלו הצעת מחיר.`);
  const solid = g.filter(x => x.leads >= Math.max(10, a.leads * 0.05) && x.k !== NO_CAMP);
  if (solid.length > 1) {
    const best = [...solid].sort((x, y) => y.rate - x.rate)[0];
    const worst = [...solid].sort((x, y) => x.rate - y.rate)[0];
    if (best.k !== worst.k && best.rate - worst.rate >= 5)
      out.push(`איכות: ב-<b>${esc(best.k)}</b> ${best.rate}% קיבלו הצעת מחיר, לעומת ${worst.rate}% ב-<b>${esc(worst.k)}</b>.`);
  }
  if (B && b) {
    const prev = new Map([...groupBy(B, r => r.cn)].map(([k, l]) => [k, l.length]));
    const moves = g.map(x => ({ k: x.k, d: x.leads - (prev.get(x.k) || 0) }));
    for (const [k, c] of prev) if (!g.some(x => x.k === k)) moves.push({ k, d: -c });
    const big = moves.sort((x, y) => Math.abs(y.d) - Math.abs(x.d))[0];
    if (big && Math.abs(big.d) >= 5)
      out.push(`השינוי הגדול מול תקופת ההשוואה: <b>${esc(big.k)}</b> ${big.d > 0 ? 'עלה' : 'ירד'} ב-${n(Math.abs(big.d))} לידים.`);
  }
  const noCamp = A.filter(r => !r.c).length;
  $('organicNote').textContent = noCamp
    ? `${pct(noCamp, a.leads)}% מהלידים בטווח (${n(noCamp)}) הם "אורגני": הגיעו בלי שם קמפיין, למשל טלפון, טופס הרשמה או וואטסאפ.`
    : '';
  $('insights').innerHTML = out.map(o => typeof o === 'string' ? `<li>${o}</li>` : `<li class="warn">${o.t}</li>`).join('');
}

function bucketKey(iso, weekly) {
  if (!weekly) return iso;
  const d = toDate(iso); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return toIso(d); // week starts Sunday
}
function series(from, to, list, weekly) {
  const keys = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { const k = bucketKey(d, weekly); if (keys[keys.length - 1] !== k) keys.push(k); }
  const by = groupBy(list, r => bucketKey(r.d, weekly));
  return keys.map(k => { const l = by.get(k) || []; const s = stats(l); return { k, leads: s.leads, rate: s.rate }; });
}
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

function hourly(list) {
  const by = groupBy(list, r => Math.floor(r.mi / 60));
  return Array.from({ length: 24 }, (_, h) => { const s = stats(by.get(h) || []); return { k: h, leads: s.leads, rate: s.rate }; });
}
function renderTrend(cur, cmp, A, B) {
  const days = daysBetween(cur[0], cur[1]);
  const weekly = days > 62, byHour = days === 1;
  $('trendNote').textContent = byHour ? 'לפי שעה' : weekly ? 'לפי שבוע (א׳–ש׳)' : 'לפי יום';
  const s = byHour ? hourly(A) : series(cur[0], cur[1], A, weekly);
  const p = cmp ? (byHour ? hourly(B) : series(cmp[0], cmp[1], B, weekly)) : null;
  const labels = s.map(x => byHour ? String(x.k).padStart(2, '0') + ':00' : weekly ? 'שבוע ' + fmtDay(x.k) : fmtDay(x.k));
  const ink2 = css('--ink-2'), line = css('--line');
  const ds = [
    { type: 'bar', label: 'לידים', data: s.map(x => x.leads), backgroundColor: css('--bar'), borderRadius: 4, yAxisID: 'y', order: 2 },
    { type: 'line', label: '% הצעת מחיר', hidden: byHour, data: s.map(x => x.rate), borderColor: css('--up'), backgroundColor: css('--up'), pointRadius: 2, tension: .3, yAxisID: 'y2', order: 1 }
  ];
  if (p) ds.push({ type: 'line', label: 'לידים בתקופת ההשוואה', data: s.map((_, i) => p[i]?.leads ?? null), borderColor: css('--ink-3'), borderDash: [5, 4], pointRadius: 0, tension: .3, yAxisID: 'y', order: 0 });
  if (S.chart) S.chart.destroy();
  S.chart = new Chart($('trendChart'), {
    data: { labels, datasets: ds },
    options: {
      maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { rtl: true, labels: { color: ink2, boxWidth: 12, font: { family: 'Heebo' } } },
        tooltip: { rtl: true, callbacks: { label: c => `${c.dataset.label}: ${c.raw ?? '—'}${c.dataset.yAxisID === 'y2' ? '%' : ''}` } }
      },
      scales: {
        x: { reverse: true, ticks: { color: ink2, maxRotation: 0, autoSkipPadding: 12, font: { family: 'Heebo' } }, grid: { display: false } },
        y: { position: 'right', beginAtZero: true, ticks: { color: ink2, precision: 0 }, grid: { color: line } },
        y2: { position: 'left', beginAtZero: true, suggestedMax: 50, ticks: { color: ink2, callback: v => v + '%' }, grid: { display: false } }
      }
    }
  });
}

const COLS = [
  { key: 'name', label: 'שם' },
  { key: 'leads', label: 'לידים' },
  { key: 'share', label: '% מהכלל' },
  { key: 'quotes', label: 'הצעות מחיר' },
  { key: 'rate', label: '% הצעה' },
  { key: 'sp', label: 'הוצאה' },
  { key: 'cpl', label: 'עלות לליד' },
  { key: 'cpq', label: 'עלות להצעה' },
  { key: 'delta', label: 'שינוי' }
];
function topLs(list) {
  const g = [...groupBy(list, r => r.ls || 'לא ידוע')].sort((a, b) => b[1].length - a[1].length);
  return g.length ? g[0][0] + (g.length > 1 ? ` +${g.length - 1}` : '') : '';
}
const sortVal = v => (v == null ? Infinity : v);
function buildRows(list, prevList, keyFn, total, spList) {
  const prev = prevList ? groupBy(prevList, keyFn) : null;
  const byLead = groupBy(list, keyFn);
  const bySp = spList ? groupBy(spList, keyFn) : new Map();
  const keys = new Set([...byLead.keys(), ...bySp.keys()]);
  const rows = [...keys].map(k => {
    const l = byLead.get(k) || [];
    const spl = bySp.get(k) || [];
    const s = stats(l);
    const sp = spList ? sumSp(spl) : null;
    return { key: k, list: l, spList: spl, prevList: prev ? prev.get(k) || [] : null, ...s, share: pct(s.leads, total),
      prev: prev ? (prev.get(k) || []).length : null, ls: topLs(l), sp, cpl: sp ? div(sp, s.leads) : null, cpq: sp ? div(sp, s.quotes) : null };
  });
  const { key, dir } = S.sort;
  rows.sort((a, b) => {
    if (key === 'name') return dir * String(a.key).localeCompare(String(b.key), 'he');
    if (key === 'delta') return dir * (((a.leads - (a.prev || 0))) - ((b.leads - (b.prev || 0))));
    if (key === 'ls') return dir * a.ls.localeCompare(b.ls);
    if (key === 'cpl' || key === 'cpq') return (dir * (sortVal(a[key]) - sortVal(b[key]))) || (b.leads - a.leads);
    return dir * ((a[key] || 0) - (b[key] || 0));
  });
  return rows;
}
const nm = (text, prefix = '') => `<bdi class="nm" title="${esc(prefix + text)}">${esc(prefix + text)}</bdi>`;
function thumb(adName, cls = '') {
  const t = adName && S.thumbs[adName];
  if (!t) return '';
  return `<span class="tw${t.v ? ' vid' : ''}"><img class="thumb ${cls}" loading="lazy" src="${esc(t.t)}" data-full="${esc(t.i || t.t)}" data-video="${esc(t.v || '')}" data-cap="${esc(adName)}" alt="" referrerpolicy="no-referrer"></span>`;
}
function rowHtml(r, level, id, label, hasKids, extraTag = '', img = '') {
  const open = S.open.has(id);
  return `<tr class="l${level}${hasKids ? ' click' : ''}${open ? ' open' : ''}" data-id="${esc(id)}">
    <td class="name"><span class="cell">${hasKids ? `<span class="caret">${open ? '▾' : '◂'}</span>` : '<span class="caret"></span>'}${img}${label}${extraTag}</span></td>
    <td>${n(r.leads)}</td>
    <td>${r.share}%<span class="share"><i style="width:${Math.min(100, r.share)}%"></i></span></td>
    <td>${n(r.quotes)}</td>
    <td>${r.rate}%</td>
    <td>${r.sp ? money(r.sp) : ''}</td>
    <td>${r.sp ? money(r.cpl) : ''}</td>
    <td>${r.sp ? money(r.cpq) : ''}</td>
    <td>${r.prev == null ? '' : delta(r.leads, r.prev)}</td></tr>`;
}
function renderCampaigns(A, B, a, SA) {
  const total = a.leads;
  const top = S.names === 'raw' ? r => r.c || NO_CAMP : r => r.cn;
  let html = '<thead><tr>' + COLS.map(c => `<th data-k="${c.key}" class="${S.sort.key === c.key ? 'sorted' + (S.sort.dir > 0 ? ' asc' : '') : ''}">${c.label}</th>`).join('') + '</tr></thead><tbody>';
  for (const c of buildRows(A, B, top, total, SA ? SA.filter(r => top(r) !== NO_CAMP) : null)) {
    const id0 = 'c|' + c.key;
    const noCamp = c.key === NO_CAMP;
    const all = c.list.concat(c.spList);
    const unm = !noCamp && all.some(r => !r.mapped) ? '<span class="tag warn">לא ממופה</span>' : '';
    const pfTag = noCamp ? '' : `<span class="tag">${esc(all[0].pf)}</span>`;
    html += rowHtml(c, 0, id0, nm(c.key), true, unm);
    if (!S.open.has(id0)) continue;
    const kid1 = noCamp ? r => r.ls || 'לא ידוע' : r => r.s || 'ללא Ad Set';
    for (const s of buildRows(c.list, c.prevList, kid1, total, SA ? c.spList : null)) {
      const id1 = id0 + '|' + s.key;
      const kids = !noCamp && (s.list.some(r => r.a) || s.spList.some(r => r.a));
      html += rowHtml(s, 1, id1, nm(s.key, noCamp ? '' : 'Ad Set: '), kids);
      if (!kids || !S.open.has(id1)) continue;
      for (const ad of buildRows(s.list, s.prevList, r => r.a || 'ללא מודעה', total, SA ? s.spList : null)) html += rowHtml(ad, 2, id1 + '|' + ad.key, nm(ad.key), false, '', thumb(ad.key, 'sm'));
    }
  }
  const mc = SA ? metaCosts(A, sumSp(SA)) : null;
  html += `</tbody><tfoot><tr><td>סה״כ</td><td>${n(a.leads)}</td><td>100%</td><td>${n(a.quotes)}</td><td>${a.rate}%</td><td>${mc ? money(mc.sp) : ''}</td><td>${mc ? money(mc.cpl) : ''}</td><td>${mc ? money(mc.cpq) : ''}</td><td></td></tr></tfoot>`;
  $('campTable').innerHTML = html;
}

/* ---------- old vs new Meta campaigns, with recommendations ---------- */
function campType(name) {
  if (/ליד אדס/.test(name)) return 'ליד אדס';
  if (/המרות לאתר/.test(name)) return 'המרות לאתר';
  if (/טראפיק/.test(name)) return 'טראפיק';
  return 'אחר';
}
// Meta's own reported results vs real leads in the CRM view
function metaVsCrm(r) {
  if (!r.mr) return '';
  const ratio = r.leads ? r.mr / r.leads : null;
  const big = ratio == null || ratio >= 2;
  const txt = ratio == null ? 'אין לידים ב-CRM' : (ratio >= 1.15 ? `פי ${ratio.toFixed(1)}` : ratio <= 0.85 ? `${Math.round(ratio * 100)}%` : 'תואם');
  return `<span class="mvc${big ? ' bad' : ''}" title="מטא מדווחת ${n(r.mr)} תוצאות, ב-CRM יש ${n(r.leads)} לידים">מטא ${n(r.mr)} · CRM ${n(r.leads)} <b>(${txt})</b></span>`;
}
function renderOldNew(A, SA) {
  const block = $('oldNewBlock');
  if (!SA) {
    $('onSummary').innerHTML = `<p class="muted">${S.spendErr ? 'נתוני מטא לא נטענו. נסו לרענן.' : 'טוען נתוני מטא…'}</p>`;
    $('onRows').innerHTML = ''; $('onConclusions').innerHTML = '';
    return;
  }
  const leads = A.filter(r => r.pf === 'מטא' && !NO_COST.has(r.cn));
  const byL = groupBy(leads, r => r.cn), byS = groupBy(SA.filter(r => !NO_COST.has(r.cn)), r => r.cn);
  let rows = [...new Set([...byL.keys(), ...byS.keys()])].map(k => {
    const l = byL.get(k) || [], s = byS.get(k) || [];
    const st = (l.concat(s).find(r => r.ns) || {}).ns || '';
    const sp = sumSp(s), q = l.filter(r => r.yes).length;
    const mr = s.reduce((t, r) => t + (r.mr || 0), 0);
    return { name: k, status: st === 'חדש' ? 'new' : st === 'ישן' ? 'old' : '', type: campType(k), sp, leads: l.length, quotes: q, mr,
      rate: pct(q, l.length), cpl: div(sp, l.length), cpq: div(sp, q) };
  }).filter(r => r.sp > 0); // only campaigns that actually spent in the Meta account
  if (!rows.length) { $('onSummary').innerHTML = '<p class="muted">אין נתוני מטא בטווח הזה.</p>'; $('onRows').innerHTML = ''; $('onConclusions').innerHTML = ''; return; }

  const measured = rows.filter(r => r.type !== 'טראפיק');
  const tot = measured.reduce((t, r) => ({ sp: t.sp + r.sp, q: t.q + r.quotes }), { sp: 0, q: 0 });
  const avg = div(tot.sp, tot.q);
  for (const r of rows) {
    if (r.type === 'טראפיק') { r.rec = 'info'; r.recTxt = 'חשיפה'; r.why = 'קמפיין חשיפה, לא נמדד לפי הצעות מחיר'; continue; }
    if (!avg) { r.rec = 'wait'; r.recTxt = 'מוקדם לקבוע'; r.why = 'אין עדיין הצעות מחיר בטווח'; continue; }
    if (r.quotes === 0) {
      if (r.sp >= avg) { r.rec = 'down'; r.recTxt = 'להחליש'; r.why = `הוציא ${money(r.sp)} בלי אף הצעת מחיר`; }
      else { r.rec = 'wait'; r.recTxt = 'מוקדם לקבוע'; r.why = 'הוצאה נמוכה מכדי לשפוט'; }
    } else if (r.quotes < 3 && r.sp < avg * 2) { r.rec = 'wait'; r.recTxt = 'מוקדם לקבוע'; r.why = 'מעט הצעות מחיר עד כה'; }
    else if (r.cpq <= avg * 0.75) { r.rec = 'up'; r.recTxt = 'לחזק'; r.why = `זול ב-${Math.round((1 - r.cpq / avg) * 100)}% מהממוצע להצעה`; }
    else if (r.cpq >= avg * 1.75) { r.rec = 'down'; r.recTxt = 'להחליש'; r.why = `יקר פי ${(r.cpq / avg).toFixed(1)} מהממוצע להצעה`; }
    else { r.rec = 'keep'; r.recTxt = 'להשאיר'; r.why = 'קרוב לממוצע'; }
  }
  const order = { new: 0, old: 1, '': 2 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || ((a.cpq ?? Infinity) - (b.cpq ?? Infinity)) || (b.sp - a.sp));

  // summary cards: old vs new
  const grp = st => {
    const g = measured.filter(r => r.status === st);
    const sp = g.reduce((t, r) => t + r.sp, 0), l = g.reduce((t, r) => t + r.leads, 0), q = g.reduce((t, r) => t + r.quotes, 0);
    return { n: g.length, sp, l, q, rate: pct(q, l), cpl: div(sp, l), cpq: div(sp, q) };
  };
  const O = grp('old'), N = grp('new');
  const card = (cls, title, g) => `<div class="on-card ${cls}"><div class="on-title">${title}<span class="muted small"> · ${g.n} קמפיינים · ${pct(g.sp, tot.sp)}% מההוצאה</span></div>
    <div class="on-metrics">
      <div><span>עלות להצעה</span><b>${money(g.cpq)}</b></div>
      <div><span>הצעות מחיר</span><b>${n(g.q)}</b></div>
      <div><span>% הצעה</span><b>${g.rate}%</b></div>
      <div><span>עלות לליד</span><b>${money(g.cpl)}</b></div>
      <div><span>לידים</span><b>${n(g.l)}</b></div>
      <div><span>הוצאה</span><b>${money(g.sp)}</b></div>
    </div></div>`;
  $('onSummary').innerHTML = card('new', 'חדש', N) + card('old', 'ישן', O);

  // per-campaign rows with a cost-per-quote bar
  const maxCpq = Math.max(1, ...rows.filter(r => r.cpq != null).map(r => r.cpq), avg || 0);
  $('onRows').innerHTML = rows.map(r => {
    const w = r.cpq != null ? Math.max(4, (r.cpq / maxCpq) * 100) : 100;
    const bar = r.type === 'טראפיק' ? '<span class="muted small">לא רלוונטי</span>'
      : r.cpq != null ? `<div class="cpq-bar"><i style="width:${w}%"></i></div><b class="cpq-val">${money(r.cpq)}</b>`
      : `<div class="cpq-bar empty"><i style="width:100%"></i></div><b class="cpq-val">אין הצעות</b>`;
    return `<div class="on-row ${r.status || 'na'}">
      <div class="on-name"><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span><span class="tag">${r.type}</span></div>
      <div class="on-bar">${bar}${avg && r.type !== 'טראפיק' ? `<span class="avg-mark" style="right:${(avg / maxCpq) * 100}%" title="ממוצע ${money(avg).replace(/<[^>]+>/g, '')}"></span>` : ''}</div>
      <div class="on-nums small"><span>${money(r.sp)} הוצאה</span><span>${n(r.leads)} לידים</span><span>${n(r.quotes)} הצעות (${r.rate}%)</span>${metaVsCrm(r)}</div>
      <div class="on-rec"><span class="rec ${r.rec}">${r.recTxt}</span><span class="muted small">${r.why}</span></div>
    </div>`;
  }).join('');

  // conclusions
  const out = [];
  if (O.cpq && N.cpq) {
    const better = N.cpq < O.cpq ? 'החדשים' : 'הישנים';
    out.push(`בממוצע, הצעת מחיר מקמפיין <b>חדש</b> עלתה ${money(N.cpq)} ומקמפיין <b>ישן</b> ${money(O.cpq)}. ${better} יעילים יותר בטווח הזה.`);
  }
  const byType = t => { const g = measured.filter(r => r.type === t); const sp = g.reduce((s, r) => s + r.sp, 0), q = g.reduce((s, r) => s + r.quotes, 0); return { sp, q, cpq: div(sp, q) }; };
  const LA = byType('ליד אדס'), LP = byType('המרות לאתר');
  if (LA.sp && LP.sp) out.push(`לפי סוג: ליד אדס ${money(LA.cpq)} להצעה, המרות לאתר ${LP.q ? money(LP.cpq) : 'בלי הצעות'} להצעה. המרות לאתר קיבלו ${pct(LP.sp, tot.sp)}% מהתקציב והביאו ${pct(LP.q, tot.q)}% מהצעות המחיר.`);
  const ups = rows.filter(r => r.rec === 'up'), downs = rows.filter(r => r.rec === 'down');
  if (ups.length || downs.length) {
    out.push(`המלצה: ${ups.length ? 'לחזק את <b>' + ups.map(r => esc(r.name)).join('</b>, <b>') + '</b>' : ''}${ups.length && downs.length ? ', ובמקביל ' : ''}${downs.length ? 'להחליש את <b>' + downs.map(r => esc(r.name)).join('</b>, <b>') + '</b>' : ''}. מומלץ לשנות תקציב בהדרגה, עד כ-20%–30% בכל פעם, ולבדוק שוב אחרי שבוע.`);
  }
  out.push({ warn: true, t: 'שימו לב: הצעות מחיר נשלחות בדרך כלל עד יומיים אחרי הליד, לכן הימים האחרונים בטווח עדיין חסרים. כדאי להחליט לפי טווח של לפחות שבוע.' });
  $('onConclusions').innerHTML = out.map(o => typeof o === 'string' ? `<li>${o}</li>` : `<li class="warn">${o.t}</li>`).join('');
  block.hidden = false;
}

function renderExcluded(cur) {
  const sp = S.spend[cur[0] + '|' + cur[1]] || [];
  const rows = EXCLUDE.map(e => {
    const l = S.rows.filter(r => r.ex === e.key && r.d >= cur[0] && r.d <= cur[1]);
    const st = stats(l), s = sumSp(sp.filter(r => r.ex === e.key));
    return { e, ...st, sp: s };
  });
  $('exTable').innerHTML = '<thead><tr><th>מה הוחרג</th><th>לידים</th><th>הצעות מחיר</th><th>% הצעה</th><th>הוצאה במטא</th><th>סיבה</th></tr></thead><tbody>' +
    rows.map(r => `<tr><td>${esc(r.e.label)}</td><td>${n(r.leads)}</td><td>${n(r.quotes)}</td><td>${r.rate}%</td><td>${r.sp ? money(r.sp) : '—'}</td><td class="muted small">${esc(r.e.note)}</td></tr>`).join('') + '</tbody>';
}

/* ---------- ads (flat, across campaigns) ---------- */
const AD_COLS = [
  { key: 'name', label: 'מודעה' },
  { key: 'leads', label: 'לידים' },
  { key: 'quotes', label: 'הצעות מחיר' },
  { key: 'rate', label: '% הצעת מחיר' },
  { key: 'sp', label: 'הוצאה' },
  { key: 'cpl', label: 'עלות לליד' },
  { key: 'cpq', label: 'עלות להצעה' },
  { key: 'camps', label: 'קמפיינים' }
];
const AD_LIMIT = 25;
function renderAds(A, SA) {
  const withAd = A.filter(r => r.a);
  const spAd = (SA || []).filter(r => r.a);
  const q = S.adQuery.trim().toLowerCase();
  const byL = groupBy(withAd, r => r.a), byS = groupBy(spAd, r => r.a);
  let rows = [...new Set([...byL.keys(), ...byS.keys()])].map(k => {
    const l = byL.get(k) || [], spl = byS.get(k) || [];
    const cn = [...new Set(l.concat(spl).map(r => r.cn))];
    const s = stats(l), sp = SA ? sumSp(spl) : null;
    return { name: k, ...s, sp, cpl: sp ? div(sp, s.leads) : null, cpq: sp ? div(sp, s.quotes) : null, camps: cn.length, campNames: cn.join(' · ') };
  });
  if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));
  const { key, dir } = S.adSort;
  rows.sort((a, b) => key === 'name' ? dir * a.name.localeCompare(b.name)
    : (key === 'cpl' || key === 'cpq') ? ((dir * (sortVal(a[key]) - sortVal(b[key]))) || (b.leads - a.leads))
    : ((dir * ((a[key] || 0) - (b[key] || 0))) || (b.leads - a.leads)));
  const shown = S.adAll ? rows : rows.slice(0, AD_LIMIT);
  const max = Math.max(1, ...rows.map(r => r.leads));
  let html = '<thead><tr>' + AD_COLS.map(c => `<th data-k="${c.key}" class="${S.adSort.key === c.key ? 'sorted' + (S.adSort.dir > 0 ? ' asc' : '') : ''}">${c.label}</th>`).join('') + '</tr></thead><tbody>';
  html += shown.map(r => `<tr class="leaf"><td class="ad"><span class="cell">${thumb(r.name)}${nm(r.name)}</span></td><td>${n(r.leads)}<span class="share"><i style="width:${(r.leads / max) * 100}%"></i></span></td><td>${n(r.quotes)}</td><td>${r.rate}%</td><td>${r.sp ? money(r.sp) : ''}</td><td>${r.sp ? money(r.cpl) : ''}</td><td>${r.sp ? money(r.cpq) : ''}</td><td class="muted small" title="${esc(r.campNames)}">${r.camps === 1 ? esc(r.campNames) : r.camps + ' קמפיינים'}</td></tr>`).join('')
    || '<tr><td colspan="8" class="muted">אין לידים עם שם מודעה בטווח הזה</td></tr>';
  const tot = stats(withAd);
  const totSp = SA ? sumSp(spAd) : null;
  html += `</tbody><tfoot><tr><td>סה״כ</td><td>${n(tot.leads)}</td><td>${n(tot.quotes)}</td><td>${tot.rate}%</td><td>${totSp ? money(totSp) : ''}</td><td>${totSp ? money(div(totSp, tot.leads)) : ''}</td><td>${totSp ? money(div(totSp, tot.quotes)) : ''}</td><td></td></tr></tfoot>`;
  $('adTable').innerHTML = html;
  const more = $('adMore');
  more.hidden = rows.length <= AD_LIMIT;
  more.textContent = S.adAll ? 'הצג פחות' : `הצג את כל ${n(rows.length)} המודעות`;
}

/* ---------- alert: Meta leads without an ad name (from ALERT_SINCE onward) ---------- */
const ALERT_SINCE = '2026-11-05T15:00:00Z'; // 5.11.2026 17:00 Israel time - when the alert was turned on
function renderAlert() {
  // manual-transfer form leads never carry an ad name - not a fault
  const bad = S.rows.filter(r => !r.ex && r.t >= ALERT_SINCE && r.pf === 'מטא' && !r.a && !/^Lead Form - Leasing - 24\/07/.test(r.c || ''));
  const box = $('alert');
  if (!bad.length) { box.hidden = true; return; }
  const by = [...groupBy(bad, r => r.c || NO_CAMP)].sort((x, y) => y[1].length - x[1].length);
  const last = bad.reduce((m, r) => (r.t > m ? r.t : m), '');
  const when = new Date(last).toLocaleString('he-IL', { timeZone: TZ, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  box.innerHTML = `<h2>תקלה: ${n(bad.length)} לידים ממטא הגיעו בלי שם מודעה</h2>
    <div>מאז 5.11 בשעה 17:00. האחרון הגיע ב-${when}. כנראה הליד נכנס רק דרך זאפייר ולא דרך n8n, או שהקמפיין לא מחובר.</div>
    <ul>${by.map(([c, l]) => `<li><bdi>${esc(c)}</bdi>: ${n(l.length)}</li>`).join('')}</ul>`;
  box.hidden = false;
}

/* ---------- filters ---------- */
function renderFilters() {
  const opts = (key, label, values) => {
    const cur = S.filters[key];
    return `<label>${label}<select data-f="${key}"><option value="">הכול</option>${values.map(v => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
  };
  const uniq = f => [...new Set(S.rows.map(f).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
  $('filters').innerHTML =
    opts('status', 'חדש / ישן', uniq(r => r.ns));
}

/* ---------- PIN ---------- */
function showLock() {
  $('app').hidden = true; $('lock').hidden = false;
  $('pinIn').value = ''; $('pinIn').focus();
}
let pinBusy = false;
function setupPin() {
  const inp = $('pinIn');
  $('pinForm').addEventListener('submit', e => { e.preventDefault(); if (inp.value.trim().length >= 4) submitPin(inp); });
}
async function submitPin(inp) {
  if (pinBusy) return;
  pinBusy = true;
  const msg = $('pinMsg'); msg.textContent = '';
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: inp.value }) });
    if (res.ok) { $('lock').hidden = true; $('app').hidden = false; refresh(); return; }
    const body = await res.json().catch(() => ({}));
    msg.textContent = res.status === 429 ? 'יותר מדי ניסיונות. נסו שוב בעוד 15 דקות.' : `קוד שגוי${body.left != null ? ` (נשארו ${body.left} ניסיונות)` : ''}`;
    inp.value = ''; inp.focus();
  } finally { pinBusy = false; }
}

/* ---------- events ---------- */
function renderPresets() {
  $('presets').innerHTML = PRESETS.map(p => `<button class="chip${p.id === S.preset ? ' on' : ''}" data-p="${p.id}">${p.label}</button>`).join('');
  $('custom').hidden = S.preset !== 'custom';
}
function bind() {
  $('presets').addEventListener('click', e => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    if (b.dataset.p === 'custom') { const [f, t] = currentRange(); S.from = S.from || f; S.to = S.to || t; $('fromIn').value = S.from; $('toIn').value = S.to; }
    S.preset = b.dataset.p; savePrefs(); renderPresets(); refresh();
  });
  $('fromIn').addEventListener('change', e => { S.from = e.target.value; refresh(); });
  $('toIn').addEventListener('change', e => { S.to = e.target.value; refresh(); });
  $('compareSel').value = S.compare;
  $('compareSel').addEventListener('change', e => { S.compare = e.target.value; savePrefs(); refresh(); });
  $('filters').addEventListener('change', e => { const k = e.target.dataset.f; if (!k) return; S.filters[k] = e.target.value; refresh(); });
  $('campTable').addEventListener('click', e => {
    const th = e.target.closest('th[data-k]');
    if (th) { const k = th.dataset.k; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'name' ? 1 : -1) }; refresh(); return; }
    const tr = e.target.closest('tr.click'); if (!tr) return;
    const id = tr.dataset.id; S.open.has(id) ? S.open.delete(id) : S.open.add(id); refresh();
  });
  document.querySelector('.seg').addEventListener('click', e => {
    const b = e.target.closest('[data-names]'); if (!b) return;
    S.names = b.dataset.names; S.open.clear();
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b)); refresh();
  });
  $('adTable').addEventListener('click', e => {
    const th = e.target.closest('th[data-k]'); if (!th) return;
    const k = th.dataset.k; S.adSort = { key: k, dir: S.adSort.key === k ? -S.adSort.dir : (k === 'name' ? 1 : -1) }; refresh();
  });
  $('adSearch').addEventListener('input', e => { S.adQuery = e.target.value; refresh(); });
  $('adMore').addEventListener('click', () => { S.adAll = !S.adAll; refresh(); });
  $('campTable').addEventListener('click', e => {
    const td = e.target.closest('tr:not(.click) td.name');
    if (td && !e.target.closest('.thumb')) td.classList.toggle('full');
  });
  $('adTable').addEventListener('click', e => {
    const td = e.target.closest('tr.leaf td.ad');
    if (td && !e.target.closest('.thumb')) td.classList.toggle('full');
  });
  document.addEventListener('click', e => {
    const wrap = e.target.closest('.tw');
    const img = wrap && wrap.querySelector('img.thumb');
    if (!img) return;
    e.stopPropagation(); e.preventDefault();
    const vid = $('lbVid'), pic = $('lbImg');
    if (img.dataset.video) {
      pic.hidden = true; pic.src = '';
      vid.hidden = false; vid.poster = img.dataset.full || img.src; vid.src = img.dataset.video;
      vid.play().catch(() => {});
    } else {
      vid.hidden = true; vid.removeAttribute('src');
      pic.hidden = false; pic.src = img.dataset.full || img.src;
    }
    $('lbCap').textContent = img.dataset.cap || '';
    $('lightbox').hidden = false;
  }, true);
  const closeLb = () => { const v = $('lbVid'); v.pause(); v.removeAttribute('src'); v.load(); $('lbImg').src = ''; $('lightbox').hidden = true; };
  $('lightbox').addEventListener('click', e => { if (!e.target.closest('video')) closeLb(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('lightbox').hidden) closeLb(); });
  $('refreshBtn').addEventListener('click', () => refresh(true));
  $('logoutBtn').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); location.reload(); });
  // auto refresh every 15 minutes while the tab is open
  setInterval(() => { if (!document.hidden && !$('app').hidden && currentRange()[1] === todayIso()) refresh(true); }, 15 * 60 * 1000);
}

async function init() {
  setupPin(); renderPresets(); bind();
  try { S.map = (await (await fetch('campaign-map.json')).json()).campaigns || []; } catch { S.map = []; }
  // Ask for the code on every visit: drop any earlier session, then show the code screen.
  // Demo: no code needed
  $('lock').hidden = true; $('app').hidden = false;
  refresh();
}
init();
