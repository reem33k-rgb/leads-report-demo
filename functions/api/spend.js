import { spendForRange, THUMBS, json } from '../_lib/fake.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!DATE.test(from || '') || !DATE.test(to || '') || from > to) return json({ error: 'bad range' }, 400);
  const rows = spendForRange(from, to, Date.now());
  return json({ meta: { generatedAt: new Date().toISOString(), from, to, count: rows.length, currency: 'ILS', account: 'DEMO' }, rows, thumbs: THUMBS });
}
