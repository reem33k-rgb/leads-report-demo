// Demo data generator. Nothing here comes from a real CRM or ad account.
// Deterministic: the same day always produces the same leads, so numbers stay stable between refreshes.

export const CAMPAIGNS = [
  { c: 'DEMO_LeadAds_B2B_Business_2026', w: 26, q: 0.27, meta: true, sets: ['LAL 2%', 'Interests', 'ADV+'] },
  { c: 'DEMO_LeadAds_B2C_Spring_NEW', w: 18, q: 0.33, meta: true, sets: ['ADV+', 'Remarketing', 'LAL 5%'] },
  { c: 'DEMO_LeadAds_B2C_Classic_OLD', w: 10, q: 0.22, meta: true, sets: ['Interests', 'Remarketing'] },
  { c: 'DEMO_LP_B2C_Website_OLD', w: 5, q: 0.14, meta: true, sets: ['Remarketing', 'LAL 2%'], inflate: 6 },
  { c: 'DEMO_LP_B2C_Website_NEW', w: 4, q: 0.04, meta: true, sets: ['ADV+', 'Article Readers'], inflate: 4 },
  { c: 'DEMO_Google_Search_Generic', w: 7, q: 0.12, ls: 'Website' },
  { c: 'DEMO_Google_PMax', w: 3, q: 0.25, ls: 'Website' },
  { c: 'DEMO_YouTube_Unicorns', w: 1, q: 0.5, ls: 'Website' },
  { c: 'DEMO_WhatsApp_Bot', w: 8, q: 0.38, ls: 'WhatsApp' },
  { c: 'DEMO_Private_Pilot_Leasing', w: 2, q: 0.3, meta: true, sets: ['Interests'] },
  { c: null, w: 18, q: 0.19 }
];

export const ADS = [
  'Vid_Demo_Unicorn_Lease_01', 'GIF_Demo_Rocket_Car_Offer', 'Img_Demo_Spaceship_Monthly', 'Vid_Demo_Hamster_Wheel_Deal',
  'Post_Demo_Flying_Sedan_Promo', 'Vid_Demo_Robot_Salesman_30s', 'GIF_Demo_Dragon_SUV', 'Img_Demo_Submarine_Hatchback',
  'Vid_Demo_Time_Machine_Lease', 'Post_Demo_Penguin_Fleet'
];
// a couple of deliberately "too good to be true" ads
const STAR = { 'Vid_Demo_Hamster_Wheel_Deal': 0.95, 'GIF_Demo_Dragon_SUV': 0.71 };

function hash(str) { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pickW = (r, list) => { const tot = list.reduce((s, x) => s + x.w, 0); let v = r() * tot; for (const x of list) { if ((v -= x.w) < 0) return x; } return list[list.length - 1]; };
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

export function daysIn(from, to) {
  const out = []; const d = new Date(from + 'T12:00:00Z'); const end = new Date(to + 'T12:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

export function leadsForDay(day, nowMs) {
  const r = rng(hash('demo-leads-' + day));
  const dow = new Date(day + 'T12:00:00Z').getUTCDay();
  const base = dow === 5 ? 22 : dow === 6 ? 14 : 46;            // Fri / Sat quieter
  const growth = 1 + (new Date(day).getTime() - Date.UTC(2026, 0, 1)) / (365 * 864e5) * 0.8;
  const n = Math.max(3, Math.round(base * growth * (0.75 + r() * 0.5)));
  const rows = [];
  for (let i = 0; i < n; i++) {
    const camp = pickW(r, CAMPAIGNS);
    const minute = Math.floor(7 * 60 + r() * (16 * 60));           // 07:00-23:00 Israel time
    const t = Date.parse(day + 'T00:00:00Z') - 2 * 36e5 + minute * 6e4;
    if (nowMs && t > nowMs) continue;
    const s = camp.meta ? pick(r, camp.sets) : null;
    const a = camp.meta ? pick(r, ADS) : null;
    const qRate = a && STAR[a] ? STAR[a] : camp.q;
    const yes = r() < qRate;
    const ls = camp.meta ? (camp.inflate ? 'Website' : 'Facebook') : camp.ls || pick(r, ['phone', 'phone', 'Website', 'WhatsApp', 'Registration form', 'Service-Center']);
    rows.push({
      id: `demo-${day}-${i}`,
      t: new Date(t).toISOString().replace('.000', ''),
      c: camp.c, s, a: camp.meta && r() < 0.06 ? null : a,
      src: camp.meta ? 'facebook' : null, ls,
      q: yes ? 'Yes' : 'No', qd: yes ? new Date(t + (2 + r() * 30) * 36e5).toISOString() : null,
      st: yes ? 'Pricing' : pick(r, ['New', 'Contacted', 'Contacted', 'Qualified', 'Unresponsive']),
      ct: camp.c && camp.c.includes('B2B') ? 'Business' : 'Private',
      p: 'p' + hash(`${day}-${i}-${Math.floor(r() * 1e9)}`).toString(36)
    });
  }
  return rows;
}

export function spendForRange(from, to, nowMs) {
  const per = new Map();
  for (const day of daysIn(from, to)) {
    for (const l of leadsForDay(day, nowMs)) {
      const camp = CAMPAIGNS.find(x => x.c === l.c);
      if (!camp || !camp.meta || !l.a) continue;
      const key = `${l.c}|${l.s}|${l.a}`;
      if (!per.has(key)) per.set(key, { c: l.c, s: l.s, a: l.a, leads: 0, inflate: camp.inflate || 1.1 });
      per.get(key).leads++;
    }
  }
  const rows = [];
  for (const x of per.values()) {
    const r = rng(hash('demo-spend-' + x.c + x.a + from + to));
    const cpl = x.c.includes('_LP_') ? 90 + r() * 120 : x.a === 'Vid_Demo_Hamster_Wheel_Deal' ? 3 + r() * 4 : 18 + r() * 45;
    rows.push({ d: from, c: x.c, s: x.s, a: x.a, sp: Math.round(x.leads * cpl * 100) / 100, im: Math.round(x.leads * (900 + r() * 2500)), cl: Math.round(x.leads * (12 + r() * 30)), mr: Math.round(x.leads * x.inflate), mk: x.c.includes('_LP_') ? 'pixel' : 'leads_form' });
  }
  return rows;
}

export const THUMBS = Object.fromEntries(ADS.map((a, i) => [a, { t: `demo-ads/${i + 1}.svg`, i: `demo-ads/${i + 1}.svg` }]));

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
