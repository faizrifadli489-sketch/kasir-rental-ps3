// Kasir Rental PS3, versi Vercel + Supabase (tanpa dependency)
const crypto = require('crypto');
const PIN = '1111', SECRET = "da879976d2d7a4cbf440";
const STATIC_QRIS = (process.env.QRIS || '').trim();
const TTL = 15 * 60 * 1000, TZ = 'Asia/Jakarta';
const DEFAULT_PRESETS = [ // dipakai kalau tabel kasir_presets masih kosong
  { name: 'Rental PS3 / jam', price: 4000 },
  { name: 'Minuman', price: 1500 },
  { name: 'Minuman', price: 3000 },
  { name: 'Snack', price: 500 },
  { name: 'Snack', price: 1000 },
];

// ---- Supabase REST. Akses dikunci lewat header x-app-key (dicek RLS di database) ----
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1' + path, {
    method,
    headers: { apikey: process.env.SUPABASE_KEY, 'x-app-key': process.env.APP_KEY, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}

// ---- QRIS statis -> dinamis ----
function crc16(s) {
  let c = 0xFFFF;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}
function dynQris(amount) {
  let q = STATIC_QRIS.slice(0, -4).replace('010211', '010212');
  const a = String(amount), i = q.indexOf('5802ID');
  q = q.slice(0, i) + '54' + String(a.length).padStart(2, '0') + a + q.slice(i);
  return q + crc16(q);
}

const dayKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
const send = (res, code, o) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
async function getBody(req) {
  const b = req.body; let raw;
  if (typeof b === 'string') raw = b;
  else if (Buffer.isBuffer(b)) raw = b.toString('utf8');
  else if (b && typeof b === 'object') raw = JSON.stringify(b);
  else raw = await new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s)); });
  let j = {}; try { j = JSON.parse(raw); } catch {}
  return { raw, j: j && typeof j === 'object' ? j : {} };
}
const view = t => {
  const o = { ...t, paidAt: t.paid_at }; delete o.paid_at;
  if (o.status === 'pending' && o.expires && Date.now() > o.expires) o.status = 'expired';
  return o;
};
const SEL = 'select=id,items,amount,method,via,paid_at';

module.exports = async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/\/+$/, ''), m = req.method;
  try {
    // Webhook MacroDroid: pakai secret, bukan PIN
    if (m === 'POST' && p === '/api/webhook') {
      const { raw, j } = await getBody(req);
      if (!SECRET || (j.secret || u.searchParams.get('secret')) !== SECRET) return send(res, 401, { error: 'Secret salah' });
      const text = String(j.text || raw);
      const mt = text.match(/Rp\.?\s?([\d.]+)/i);
      const amount = j.amount ? Math.round(+j.amount) : mt ? parseInt(mt[1].replace(/\./g, ''), 10) : 0;
      const ok = Number.isInteger(amount) && amount > 0;
      const [t] = ok ? await sb(`/kasir_trx?status=eq.pending&method=eq.qris&amount=eq.${amount}&expires=gt.${Date.now()}&order=created.asc&limit=1`) : [];
      await sb('/kasir_logs', { method: 'POST', body: { at: Date.now(), amount: ok ? amount : 0, text: text.slice(0, 160), trx: t ? t.id : null }, prefer: 'return=minimal' });
      if (!t) return send(res, 404, { ok: false, amount });
      const done = await sb(`/kasir_trx?id=eq.${t.id}&status=eq.pending`, { method: 'PATCH', body: { status: 'paid', paid_at: Date.now(), via: 'qris' }, prefer: 'return=representation' });
      return done.length ? send(res, 200, { ok: true, id: t.id, amount }) : send(res, 404, { ok: false, amount });
    }

    // Semua endpoint lain wajib PIN
    if (!PIN || req.headers['x-pin'] !== PIN) return send(res, 401, { error: 'PIN salah' });

    if (p === '/api/presets') {
      // Daftar preset tersimpan di DB; kalau kosong pakai DEFAULT_PRESETS (belum dimigrasi)
      if (m === 'GET') {
        const rows = await sb('/kasir_presets?select=name,price,sort&order=sort.asc,name.asc').catch(() => null);
        return send(res, 200, rows && rows.length ? rows.map(r => ({ name: r.name, price: r.price })) : DEFAULT_PRESETS);
      }
      const saveAll = async list => {
        await sb('/kasir_presets?id=gt.0', { method: 'DELETE', prefer: 'return=minimal' });
        if (list.length) await sb('/kasir_presets', { method: 'POST', prefer: 'return=minimal', body: list.map((x, i) => ({ name: x.name, price: x.price, sort: i })) });
        return list;
      };
      const clean = arr => (Array.isArray(arr) ? arr : []).map(x => ({ name: String(x.name || '').trim().slice(0, 60), price: Math.round(+x.price) })).filter(x => x.name && x.price > 0);
      if (m === 'POST') { // tambah satu preset
        const { j } = await getBody(req);
        const [item] = clean([j]);
        if (!item) return send(res, 400, { error: 'Nama dan harga wajib diisi' });
        const cur = await sb('/kasir_presets?select=name,price,sort');
        await saveAll([...cur.map(r => ({ name: r.name, price: r.price })), item]);
        return send(res, 200, { ok: true, presets: [...cur.map(r => ({ name: r.name, price: r.price })), item] });
      }
      if (m === 'PUT') { // ganti seluruh daftar (untuk edit/hapus/urut)
        const { j } = await getBody(req);
        return send(res, 200, { ok: true, presets: await saveAll(clean(j.presets)) });
      }
      return send(res, 405, { error: 'Method tidak didukung' });
    }

    if (m === 'POST' && p === '/api/trx') {
      const { j } = await getBody(req);
      const items = (Array.isArray(j.items) ? j.items : []).map(i => ({
        name: String(i.name || '').slice(0, 60), price: Math.round(+i.price), qty: Math.round(+i.qty),
      })).filter(i => i.name && i.price > 0 && i.qty > 0);
      const sub = items.reduce((s, i) => s + i.price * i.qty, 0);
      if (!sub) return send(res, 400, { error: 'Keranjang kosong' });
      const t = { id: crypto.randomBytes(4).toString('hex'), items, subtotal: sub, amount: sub, method: j.method === 'cash' ? 'cash' : 'qris', status: 'pending', created: Date.now() };
      if (t.method === 'cash') Object.assign(t, { status: 'paid', paid_at: Date.now(), via: 'manual' });
      else {
        // 1 pembayar sekali waktu: QRIS pending sebelumnya dibatalkan
        await sb('/kasir_trx?status=eq.pending&method=eq.qris', { method: 'PATCH', body: { status: 'cancelled' }, prefer: 'return=minimal' });
        Object.assign(t, { qris: dynQris(sub), expires: Date.now() + TTL });
      }
      await sb('/kasir_trx', { method: 'POST', body: t, prefer: 'return=minimal' });
      return send(res, 200, view(t));
    }

    let mm;
    if ((mm = p.match(/^\/api\/trx\/(\w+)(?:\/(paid|cancel))?$/))) {
      const id = mm[1];
      let [t] = await sb(`/kasir_trx?id=eq.${id}`);
      if (!t) return send(res, 404, { error: 'Tidak ditemukan' });
      if (m === 'POST' && mm[2] && view(t).status === 'pending') {
        const patch = mm[2] === 'paid' ? { status: 'paid', paid_at: Date.now(), via: 'manual' } : { status: 'cancelled' };
        await sb(`/kasir_trx?id=eq.${id}&status=eq.pending`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
        [t] = await sb(`/kasir_trx?id=eq.${id}`);
      }
      return send(res, 200, view(t));
    }

    if (m === 'POST' && p === '/api/expense') {
      const { j } = await getBody(req);
      const amount = Math.round(+j.amount), note = String(j.note || '').slice(0, 80);
      if (!(amount > 0) || !note) return send(res, 400, { error: 'Isi keterangan dan nominal' });
      await sb('/kasir_expenses', { method: 'POST', body: { id: crypto.randomBytes(3).toString('hex'), note, amount, at: Date.now() }, prefer: 'return=minimal' });
      return send(res, 200, { ok: true });
    }

    if (m === 'GET' && p === '/api/summary') {
      const today = dayKey(Date.now()), month = today.slice(0, 7);
      const monthStart = new Date(month + '-01T00:00:00+07:00').getTime();
      const since = Math.min(monthStart, Date.now() - 8 * 864e5);
      const [paid, exMo, exRecent, logs, recent] = await Promise.all([
        sb(`/kasir_trx?status=eq.paid&paid_at=gte.${since}&${SEL}&order=paid_at.asc`),
        sb(`/kasir_expenses?at=gte.${monthStart}&select=amount`),
        sb('/kasir_expenses?select=id,note,amount,at&order=at.desc&limit=8'),
        sb('/kasir_logs?select=at,amount,text,trx&order=at.desc&limit=15'),
        sb(`/kasir_trx?status=eq.paid&${SEL}&order=paid_at.desc&limit=15`),
      ]);
      const sum = a => a.reduce((s, t) => s + t.amount, 0);
      const td = paid.filter(t => dayKey(t.paid_at) === today);
      const mo = paid.filter(t => dayKey(t.paid_at).startsWith(month));
      const expense = sum(exMo);
      const days = [...Array(7).keys()].reverse().map(i => {
        const d = dayKey(Date.now() - i * 864e5);
        return { d, income: sum(paid.filter(t => dayKey(t.paid_at) === d)) };
      });
      return send(res, 200, {
        today: { income: sum(td), cash: sum(td.filter(t => t.method === 'cash')), qris: sum(td.filter(t => t.method === 'qris')), count: td.length },
        month: { income: sum(mo), expense, profit: sum(mo) - expense, count: mo.length },
        days, logs, expenses: exRecent,
        recent: recent.map(t => ({ id: t.id, at: t.paid_at, method: t.method, via: t.via, amount: t.amount, items: t.items.map(i => `${i.name} x${i.qty}`).join(', ') })),
      });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) { console.error(e); send(res, 500, { error: 'Server error' }); }
};
