// Kasir Rental PS3 — Node.js tanpa dependency (aman buat Termux)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || 'rahasiamu'; // untuk MacroDroid
const PIN = process.env.ADMIN_PIN || '1234';                      // untuk dashboard
const TTL = 15 * 60 * 1000;                                       // QRIS berlaku 15 menit
const TZ = 'Asia/Jakarta';
const STATIC_QRIS = (process.env.QRIS || fs.readFileSync(path.join(__dirname, 'qris.txt'), 'utf8')).trim();
const PRESETS = [ // ubah harga di sini
  { name: 'Rental PS3 / jam', price: 5000 },
  { name: 'Stik tambahan', price: 2000 },
  { name: 'Minuman', price: 5000 },
  { name: 'Snack', price: 3000 },
];

const DB = path.join(__dirname, 'data.json');
let db = { trx: [], expenses: [] };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
db.logs = db.logs || []; // log notifikasi dana masuk (cocok maupun tidak)
const save = () => fs.writeFileSync(DB, JSON.stringify(db));

// ---- QRIS statis -> dinamis (ubah tipe 11->12, sisipkan tag 54 nominal, hitung ulang CRC16) ----
function crc16(s) {
  let c = 0xFFFF;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}
function dynQris(amount) {
  let q = STATIC_QRIS.slice(0, -4).replace('010211', '010212'); // buang CRC lama, sisakan "6304"
  const a = String(amount), i = q.indexOf('5802ID');
  q = q.slice(0, i) + '54' + String(a.length).padStart(2, '0') + a + q.slice(i);
  return q + crc16(q);
}

const dayKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const body = req => new Promise(r => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch {} r({ raw: b, j: j && typeof j === 'object' ? j : {} }); });
});
const view = t => {
  if (t.status === 'pending' && t.expires && Date.now() > t.expires) t.status = 'expired';
  return t;
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method;
  try {
    if (m === 'GET' && p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (m === 'GET' && p === '/api/presets') return json(res, 200, PRESETS);

    // Buat transaksi. cash = langsung lunas, qris = pending sampai notifikasi masuk
    if (m === 'POST' && p === '/api/trx') {
      const { j } = await body(req);
      const items = (Array.isArray(j.items) ? j.items : []).map(i => ({
        name: String(i.name || '').slice(0, 60), price: Math.round(+i.price), qty: Math.round(+i.qty),
      })).filter(i => i.name && i.price > 0 && i.qty > 0);
      const sub = items.reduce((s, i) => s + i.price * i.qty, 0);
      if (!sub) return json(res, 400, { error: 'Keranjang kosong' });
      const t = { id: crypto.randomBytes(4).toString('hex'), items, subtotal: sub, method: j.method === 'cash' ? 'cash' : 'qris', status: 'pending', created: Date.now() };
      if (t.method === 'cash') { t.amount = sub; t.status = 'paid'; t.paidAt = Date.now(); t.via = 'manual'; }
      else {
        // 1 pembayar sekali waktu: QRIS pending sebelumnya otomatis dibatalkan
        db.trx.forEach(x => { if (x.status === 'pending' && x.method === 'qris') x.status = 'cancelled'; });
        Object.assign(t, { amount: sub, qris: dynQris(sub), expires: Date.now() + TTL });
      }
      db.trx.push(t); save();
      return json(res, 200, t);
    }

    let mm;
    if ((mm = p.match(/^\/api\/trx\/(\w+)(?:\/(paid|cancel))?$/))) {
      const t = db.trx.find(x => x.id === mm[1]);
      if (!t) return json(res, 404, { error: 'Tidak ditemukan' });
      if (m === 'POST' && mm[2] === 'paid' && view(t).status === 'pending') { Object.assign(t, { status: 'paid', paidAt: Date.now(), via: 'manual' }); save(); }
      if (m === 'POST' && mm[2] === 'cancel' && t.status === 'pending') { t.status = 'cancelled'; save(); }
      return json(res, 200, view(t));
    }

    // Webhook MacroDroid: body = teks notifikasi DANA (atau JSON {text, secret})
    if (m === 'POST' && p === '/api/webhook') {
      const { raw, j } = await body(req);
      if ((j.secret || u.searchParams.get('secret')) !== SECRET) return json(res, 401, { error: 'Secret salah' });
      const text = String(j.text || raw);
      const mt = text.match(/Rp\.?\s?([\d.]+)/i);
      const amount = j.amount ? Math.round(+j.amount) : mt ? parseInt(mt[1].replace(/\./g, ''), 10) : 0;
      const t = db.trx.filter(x => x.status === 'pending' && x.method === 'qris' && Date.now() < x.expires && x.amount === amount).sort((a, b) => a.created - b.created)[0];
      db.logs.push({ at: Date.now(), amount, text: text.slice(0, 160), trx: t ? t.id : null });
      db.logs = db.logs.slice(-200);
      if (!t) { save(); return json(res, 404, { ok: false, amount }); }
      Object.assign(t, { status: 'paid', paidAt: Date.now(), via: 'qris' }); save();
      return json(res, 200, { ok: true, id: t.id, amount });
    }

    // ---- Dashboard (butuh PIN) ----
    if (p === '/api/summary' || p === '/api/expense') {
      if (req.headers['x-pin'] !== PIN) return json(res, 401, { error: 'PIN salah' });
      if (m === 'POST' && p === '/api/expense') {
        const { j } = await body(req);
        const amount = Math.round(+j.amount), note = String(j.note || '').slice(0, 80);
        if (!(amount > 0) || !note) return json(res, 400, { error: 'Isi keterangan dan nominal' });
        db.expenses.push({ id: crypto.randomBytes(3).toString('hex'), note, amount, at: Date.now() }); save();
        return json(res, 200, { ok: true });
      }
      const paid = db.trx.filter(t => t.status === 'paid');
      const today = dayKey(Date.now()), month = today.slice(0, 7);
      const sum = a => a.reduce((s, t) => s + t.amount, 0);
      const td = paid.filter(t => dayKey(t.paidAt) === today);
      const mo = paid.filter(t => dayKey(t.paidAt).startsWith(month));
      const exMo = db.expenses.filter(e => dayKey(e.at).startsWith(month));
      const days = [...Array(7).keys()].reverse().map(i => {
        const d = dayKey(Date.now() - i * 864e5);
        return { d, income: sum(paid.filter(t => dayKey(t.paidAt) === d)) };
      });
      return json(res, 200, {
        today: { income: sum(td), cash: sum(td.filter(t => t.method === 'cash')), qris: sum(td.filter(t => t.method === 'qris')), count: td.length },
        month: { income: sum(mo), expense: sum(exMo), profit: sum(mo) - sum(exMo), count: mo.length },
        days,
        recent: paid.slice(-15).reverse().map(t => ({ id: t.id, at: t.paidAt, method: t.method, via: t.via, amount: t.amount, items: t.items.map(i => `${i.name} x${i.qty}`).join(', ') })),
        expenses: db.expenses.slice(-8).reverse(),
        logs: db.logs.slice(-15).reverse(),
      });
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) { console.error(e); json(res, 500, { error: 'Server error' }); }
}).listen(PORT, '0.0.0.0', () => console.log(`Kasir jalan di http://localhost:${PORT}`));
