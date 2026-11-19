import { daysIn, leadsForDay, json } from '../_lib/fake.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!DATE.test(from || '') || !DATE.test(to || '') || from > to) return json({ error: 'bad range' }, 400);
  const days = daysIn(from, to);
  if (days.length > 800) return json({ error: 'range too long' }, 400);
  const now = Date.now();
  const rows = days.flatMap(d => leadsForDay(d, now));
  return json({ meta: { generatedAt: new Date().toISOString(), from, to, count: rows.length, truncated: false }, rows });
}
