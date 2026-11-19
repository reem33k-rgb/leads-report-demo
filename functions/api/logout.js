import { json } from '../_lib/fake.js';

// Demo: open to everyone, no login. Any code on the code screen is accepted.
export const onRequestGet = () => json({ ok: true });
export const onRequestPost = () => json({ ok: true });
