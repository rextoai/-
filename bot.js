#!/usr/bin/env node
'use strict';
/* =====================================================================
   TARIX TEST BOTI  (Telegram)  —  hech qanday tashqi kutubxonasiz, faqat Node.js 18+
   Imkoniyatlar:
     • 5–9-sinf darsliklari: sinf → fan → mavzu(lar) → daraja → savollar soni → adabiyot → «Tayyormisan?»
     • Savollar faqat darslik matnidan tuziladi va 2 bosqichda tekshiriladi (sayt bilan bir xil sifat)
     • Natija: foiz, to'g'ri/xato, xatolar tahlili (darslikdan dalil + bet raqami), nimani qayta o'qish kerakligi
     • Tarixiy Duel: PIN bilan xona, jonli reyting, tezlik bonusi, hamma bir xil savol oladi
     • /key — har bir foydalanuvchi o'zining Google AI Studio (Gemini) kalitini kiritishi mumkin
   Tezlik: parallel generatsiya + savollar banki (keshi) + «Tayyormisan?» paytida oldindan tayyorlash.
   ===================================================================== */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');

/* ---------- .env va sozlamalar ---------- */
(function loadEnv() {
  const f = path.join(__dirname, '.env'); if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();
const CFG = {
  token: process.env.BOT_TOKEN || '',
  apiRoot: (process.env.TG_API_ROOT || 'https://api.telegram.org').replace(/\/$/, ''),
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiBase: process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/',
  admins: (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  conc: Math.max(1, +process.env.GEN_CONCURRENCY || 3),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  booksDir: process.env.BOOKS_DIR || path.join(__dirname, 'tarix-data'),
  sharedKey: process.env.ALLOW_SHARED_KEY !== '0'
};
const DU = {
  base: 500, speed: 500, streakStep: 50, streakMax: 200, max: 12, grace: 1500,
  countdown: +process.env.DUEL_COUNTDOWN_MS || 3000, reveal: +process.env.DUEL_REVEAL_MS || 6500, tick: +process.env.DUEL_TICK_MS || 5000
};

/* ---------- yordamchilar ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const spawn = fn => { Promise.resolve().then(fn).catch(e => log('XATO', (e && e.stack) || e)); };
const hash = s => crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 10);
const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const LET = ['A', 'B', 'C', 'D'];
const mmss = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
const bar = (d, t, n = 10) => { const f = t ? Math.max(0, Math.min(n, Math.round(d / t * n))) : 0; return '▓'.repeat(f) + '░'.repeat(n - f); };
const atomicWrite = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); };

/* ---------- Telegram API (kutubxonasiz) ---------- */
let nextAt = 0;
async function throttle() { const now = Date.now(), t = Math.max(now, nextAt); nextAt = t + 38; if (t > now) await sleep(t - now); }
async function tg(method, params = {}) {
  for (let a = 0; ; a++) {
    if (method !== 'getUpdates') await throttle();
    let res = null, j = null;
    try {
      res = await fetch(`${CFG.apiRoot}/bot${CFG.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(method === 'getUpdates' ? 45000 : 25000) });
      j = await res.json().catch(() => null);
    } catch (e) { if (a >= 4) throw e; await sleep(800 * (a + 1)); continue; }
    if (j && j.ok) return j.result;
    const code = j && j.error_code, desc = (j && j.description) || ('HTTP ' + res.status);
    if (code === 429 && a < 8) { await sleep((((j.parameters && j.parameters.retry_after) || 1) + 0.3) * 1000); continue; }
    if ((code >= 500 || !code) && a < 4) { await sleep(1000 * (a + 1)); continue; }
    const err = new Error(method + ': ' + desc); err.code = code; err.desc = desc; throw err;
  }
}
const kb = rows => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });
const urlBtn = (text, url) => ({ text, url });
const send = (chat, text, markup) => tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup });
async function edit(chat, mid, text, markup) {
  try { return await tg('editMessageText', { chat_id: chat, message_id: mid, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup || { inline_keyboard: [] } }); }
  catch (e) { if (/not modified/i.test(e.desc || '')) return null; throw e; }
}
// xabarni tahrirlaydi, bo'lmasa yangisini yuboradi; xabar id sini qaytaradi
async function show(chat, mid, text, markup) {
  if (mid) { try { await edit(chat, mid, text, markup); return mid; } catch (e) { if (e.code === 429) throw e; } }
  const m = await send(chat, text, markup); return m.message_id;
}
const ansCb = (id, text, alert) => tg('answerCallbackQuery', { callback_query_id: id, text: text ? trunc(text, 190) : undefined, show_alert: !!alert }).catch(() => {});
const del = (chat, mid) => tg('deleteMessage', { chat_id: chat, message_id: mid }).catch(() => {});
// uzun matnni 4000 belgidan oshmaydigan xabarlarga bo'lib yuboradi
function packBlocks(blocks, head) {
  const out = []; let cur = head || '';
  for (const b of blocks) { if (cur && (cur + '\n\n' + b).length > 3800) { out.push(cur); cur = b; } else cur = cur ? cur + '\n\n' + b : b; }
  if (cur) out.push(cur); return out;
}

/* ---------- Saqlash: foydalanuvchilar va savollar banki ---------- */
const DB_FILE = path.join(CFG.dataDir, 'db.json');
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (!db.users) db.users = {}; } catch (e) {}
let dbTimer = null;
const saveDb = () => { if (dbTimer) return; dbTimer = setTimeout(() => { dbTimer = null; try { atomicWrite(DB_FILE, JSON.stringify(db)); } catch (e) { log('db saqlanmadi', e.message); } }, 1500); };
const userRec = id => (db.users[id] = db.users[id] || { seen: {}, tests: 0, sumPct: 0, duels: 0, wins: 0 });
const banks = new Map();
function bankOf(bk) {
  if (!banks.has(bk)) { let d = {}; try { d = JSON.parse(fs.readFileSync(path.join(CFG.dataDir, 'bank', bk + '.json'), 'utf8')); } catch (e) {} banks.set(bk, { d, t: null }); }
  return banks.get(bk);
}
function bankSave(bk) {
  const b = bankOf(bk); if (b.t) return;
  b.t = setTimeout(() => { b.t = null; try { atomicWrite(path.join(CFG.dataDir, 'bank', bk + '.json'), JSON.stringify(b.d)); } catch (e) { log('bank saqlanmadi', e.message); } }, 2000);
}
function flushAll() {
  try { atomicWrite(DB_FILE, JSON.stringify(db)); } catch (e) {}
  for (const [bk, b] of banks) { try { atomicWrite(path.join(CFG.dataDir, 'bank', bk + '.json'), JSON.stringify(b.d)); } catch (e) {} }
}

/* ---------- Darsliklar (tarix-data/*.js — saytdagi bilan bir xil fayllar) ---------- */
const BOOKS = [];
try {
  for (const f of fs.readdirSync(CFG.booksDir)) {
    const m = /^(\d)([uj])?\.js$/.exec(f);
    if (m) BOOKS.push({ key: m[1] + (m[2] || ''), grade: +m[1], kind: m[2] || '', file: path.join(CFG.booksDir, f) });
  }
} catch (e) { log("tarix-data papkasi o'qilmadi:", CFG.booksDir); }
BOOKS.sort((a, b) => a.key.localeCompare(b.key));
const GRADES = [...new Set(BOOKS.map(b => b.grade))].sort((a, b) => a - b);
const bookCache = new Map();
function loadBook(key) {
  if (bookCache.has(key)) return bookCache.get(key);
  const meta = BOOKS.find(b => b.key === key); if (!meta) throw new Error("Darslik topilmadi: " + key);
  const sb = {}; sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.runInNewContext(fs.readFileSync(meta.file, 'utf8'), sb, { timeout: 60000 });
  const data = sb.TARIX_DATA && sb.TARIX_DATA[key];
  if (!data || !Array.isArray(data.topics)) throw new Error("Darslik ma'lumoti noto'g'ri: " + meta.file);
  data.key = key; data.grade = meta.grade; data.kind = meta.kind;
  data.name = data.name || (meta.kind === 'u' ? "O'zbekiston tarixi" : meta.kind === 'j' ? 'Jahon tarixi' : 'Tarix');
  bookCache.set(key, data); return data;
}
const bookLabel = b => b.kind === 'u' ? "O'zbekiston tarixi" : b.kind === 'j' ? 'Jahon tarixi' : 'Tarix';
const pageRange = t => { const ps = t.pages.map(p => p.p); const a = Math.min(...ps), b = Math.max(...ps); return a === b ? a + '-bet' : a + '–' + b + '-betlar'; };

/* ===== SAYTDAGI TEKSHIRUV MANTIG'I (o'zgartirilmagan) ===== */
const LEVELS = {
  orta:   { name: "O'rta",  icon: 'fa-seedling', tone: 'emerald', desc: "Darslikdagi aniq faktlar: kim, qachon, qayerda, nima.",
            rule: "ODDIY FAKT savollari: sana, shaxs, joy, atama, aniq ma'lumot. Bitta aniq faktga tayanadi. Variantlar bir turdagi (hammasi sana yoki hammasi shaxs)." },
  yuqori: { name: 'Yuqori', icon: 'fa-fire',     tone: 'amber',   desc: "Sabab-oqibat, taqqoslash, voqealar ketma-ketligi.",
            rule: "MURAKKAB savollar: sabab-oqibat, taqqoslash, voqealar tartibi, \"qaysi biri NOTO'G'RI\" turidagi savollar. Variantlar o'xshash va chalg'ituvchi, lekin matn bo'yicha aniq ajraladi." },
  master: { name: 'Master', icon: 'fa-crown',    tone: 'purple',  desc: "Tahliliy: bir necha faktni bog'lash, hukmlar kombinatsiyasi.",
            rule: "TAHLILIY savollar: bir nechta faktni bog'lash, sabab-oqibat zanjiri, tarixiy ahamiyatni baholash; yoki 3-4 ta hukm (I, II, III, IV) berilib, variantlar \"I va III\" kabi kombinatsiya bo'ladi. Eng qiyin, lekin to'liq matn bilan isbotlanadigan." }
};

/* ---------- matn bilan ishlash ---------- */
const NORM = s => String(s || '').toLowerCase().replace(/\[\d+-bet\]/g, ' ').replace(/[‘’ʻʼ`´']/g, '').replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ').trim();
const grams = n => { const w = n.split(' '), s = new Set(); for (let i = 0; i + 3 < w.length; i++) s.add(w.slice(i, i + 4).join(' ')); return s; };
function overlap(ev, gramSet) {
  const w = NORM(ev).split(' ').filter(Boolean); if (w.length < 5) return 0;
  const g = grams(w.join(' ')); if (!g.size) return 0;
  let hit = 0; g.forEach(x => { if (gramSet.has(x)) hit++; });
  return hit / g.size;
}
function groundedAnswer(ans, chunkNorm) {
  const nums = String(ans).match(/\d{3,4}/g) || [];
  for (const n of nums) if (chunkNorm.indexOf(n) < 0) return false;
  const names = String(ans).replace(/^\S+\s/, '').match(/[A-ZА-ЯЎҚҒҲ][a-zа-яўқғҳ']{3,}/g) || [];
  for (const w of names) { const stem = NORM(w); const k = Math.max(4, stem.length - 3); if (chunkNorm.indexOf(stem.slice(0, k)) < 0) return false; }
  return true;
}
function fmtPages(arr) {
  const a = [...new Set(arr)].sort((x, y) => x - y); if (!a.length) return '';
  const out = []; let st = a[0], p = a[0];
  for (let i = 1; i <= a.length; i++) { if (a[i] === p + 1) { p = a[i]; continue; } out.push(st === p ? `${st}` : `${st}–${p}`); st = a[i]; p = a[i]; }
  return out.join(', ') + (a.length > 1 ? '-betlar' : '-bet');
}
function splitLong(t, max) {
  if (t.length <= max) return [t];
  const out = []; let cur = '';
  for (const p of t.split('\n')) {
    if ((cur + '\n' + p).length > max && cur) { out.push(cur); cur = p; } else cur = cur ? cur + '\n' + p : p;
  }
  if (cur) out.push(cur);
  return out.flatMap(x => x.length > max * 1.5 ? x.match(new RegExp('[\\s\\S]{1,' + max + '}', 'g')) : [x]);
}
function buildChunks(topics) {
  const chunks = [];
  for (const t of topics) {
    let cur = null;
    const flush = () => { if (cur && cur.parts.length) chunks.push(cur); cur = null; };
    for (const pg of t.pages) for (const piece of splitLong(pg.t, 5200)) {
      if (!cur) cur = { n: t.n, title: t.title, parts: [], len: 0 };
      if (cur.len + piece.length > 6200 && cur.parts.length) { flush(); cur = { n: t.n, title: t.title, parts: [], len: 0 }; }
      cur.parts.push({ p: pg.p, t: piece }); cur.len += piece.length;
    }
    flush();
  }
  chunks.forEach(c => { c.text = c.parts.map(x => `[${x.p}-bet] ${x.t}`).join('\n'); c.norm = NORM(c.parts.map(x => x.t).join(' ')); c.grams = grams(c.norm); });
  return chunks;
}
const capOf = c => Math.max(3, Math.floor(c.len / 200));
function plan(chunks, N) {
  const caps = chunks.map(capOf), tot = chunks.reduce((a, c) => a + c.len, 0) || 1;
  const total = Math.min(N, caps.reduce((a, b) => a + b, 0));
  const q = chunks.map((c, i) => Math.min(caps[i], Math.floor(total * c.len / tot)));
  let rem = total - q.reduce((a, b) => a + b, 0);
  const order = chunks.map((c, i) => [total * c.len / tot - q[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0, guard = 0; rem > 0 && guard < 5000; k = (k + 1) % order.length, guard++) { const i = order[k][1]; if (q[i] < caps[i]) { q[i]++; rem--; } }
  const batches = []; let cur = null;
  chunks.forEach((c, i) => {
    let left = q[i];
    while (left > 0) {
      const take = Math.min(left, 10);
      if (cur && cur.n + take <= 10 && cur.len + c.len <= 7600 && cur.items.every(x => x.i !== i)) { cur.items.push({ i, take }); cur.n += take; cur.len += c.len; }
      else { if (cur) batches.push(cur); cur = { items: [{ i, take }], n: take, len: c.len }; }
      left -= take;
    }
  });
  if (cur) batches.push(cur);
  return { batches, quota: q, caps, total };
}


function parseJSON(t) { t = String(t).replace(/```json|```/g, ''); const a = t.indexOf('{'), b = t.lastIndexOf('}'); return JSON.parse(t.slice(a, b + 1)); }

function genPrompt(level, texts, want, avoid) {
  const sys = `Sen O'zbekiston maktab tarix darsliklaridan imtihon testi tuzuvchi QATTIQQO'L mutaxassissan. Faqat quyida berilgan DARSLIK MATNI asosida ${want} ta test savoli tuz. Javob: faqat JSON, o'zbek tilida (lotin).

MUTLAQ QOIDALAR:
1. Har bir savolning javobi FAQAT berilgan matndan to'liq isbotlanishi shart. Tashqi bilimni ISHLATMA va darslikni "tuzatma": matndagi nom, atama, sana va yozilish shakli yagona haqiqat (masalan, matnda yunonlar vatanini "Ellada" deb atagan deyilsa, javob "Ellada"; "varvar" emas).
2. "dalil" — javobni isbotlovchi matn bo'lagi, matndan SO'ZMA-SO'Z ko'chirilgan (8–35 so'z). O'zgartirma, qisqartirma, [..-bet] belgisini qo'shma.
3. "javob" — yagona to'g'ri javob (qisqa, 140 belgigacha, darslik so'zlari bilan). "xato" — aynan 3 ta noto'g'ri variant: ishonarli, to'g'ri javob bilan bir turdagi va deyarli bir xil uzunlikda, lekin matn bo'yicha aniq noto'g'ri. Imkon bo'lsa o'sha matndagi boshqa shaxs/sana/atamalardan ol. "Hammasi to'g'ri", "Hech biri", "A va B" kabi variantlar YOZMA. Variantlar o'zaro bir xil ma'noda bo'lmasin. To'g'ri javob eng uzun variant bo'lmasin.
4. Faqat matnda aniq yozilgan faktlardan so'ra: sana, shaxs, joy, atama, sabab, oqibat, ta'rif. "Savol va topshiriqlar", "O'ylab ko'ring", rasm izohi, topshiriq, shaxsiy fikr haqida so'rama.
5. Savol matni mustaqil bo'lsin ("matnga ko'ra", "yuqoridagi" deb yozma). Savolda javob oshkor bo'lib qolmasin.
6. "qaysi biri noto'g'ri" turidagi savolda "javob" = noto'g'ri hukm, "xato" = 3 ta to'g'ri hukm.
7. "bet" — dalil joylashgan [N-bet] belgisidagi N raqami. "bolim" — savol tegishli kichik mavzu nomi (2–5 so'z). "izoh" — nega aynan shu javob to'g'riligini bitta qisqa jumlada tushuntir.
8. Savollar bir-birini takrorlamasin va berilgan barcha qismlar bo'ylab teng taqsimlansin.

QIYINLIK DARAJASI — ${LEVELS[level].name}: ${LEVELS[level].rule}

JSON shakli: {"savollar":[{"savol":"...","javob":"...","xato":["...","...","..."],"dalil":"...","bet":12,"bolim":"...","izoh":"..."}]}`;
  const usr = `DARSLIK MATNI:\n${texts}\n\n${avoid.length ? "Quyidagi savollar allaqachon tuzilgan, takrorlama:\n- " + avoid.slice(-25).join('\n- ') + '\n\n' : ''}Endi aynan ${want} ta savol tuz.`;
  return [{ role: 'system', content: sys }, { role: 'user', content: usr }];
}
function validate(raw, chunks, avoidNorm) {
  if (!raw || typeof raw.savol !== 'string' || typeof raw.javob !== 'string' || !Array.isArray(raw.xato) || typeof raw.dalil !== 'string') return null;
  const savol = raw.savol.trim(), javob = raw.javob.trim(), xato = raw.xato.map(x => String(x).trim()).filter(Boolean);
  if (savol.length < 12 || savol.length > 400 || !javob || javob.length > 200 || xato.length !== 3) return null;
  const all = [javob, ...xato].map(NORM); if (new Set(all).size !== 4 || all.some(x => !x)) return null;
  if (/\b(hammasi|hech biri|barchasi to'g'ri|yuqoridagi)/i.test(javob + ' ' + xato.join(' ')) || /matnga ko'ra|yuqoridagi/i.test(savol)) return null;
  const nj = NORM(javob); if (nj.length >= 6 && NORM(savol).includes(nj)) return null;
  const maxX = Math.max(...xato.map(x => x.length)); if (javob.length > 60 && javob.length > 2.2 * maxX) return null;
  let best = null, bs = 0;
  chunks.forEach(c => { const s = overlap(raw.dalil, c.grams); if (s > bs) { bs = s; best = c; } });
  if (!best || bs < 0.6) return null;
  if (!groundedAnswer(javob, best.norm)) return null;
  const nq = NORM(savol).split(' ').filter(w => w.length > 3);
  for (const a of avoidNorm) { const set = new Set(a); const inter = nq.filter(w => set.has(w)).length; if (nq.length && inter / Math.max(nq.length, a.length) > 0.7) return null; }
  let page = +raw.bet || best.parts[0].p, ps = 0;
  best.parts.forEach(pt => { const s = overlap(raw.dalil, grams(NORM(pt.t))); if (s > ps) { ps = s; page = pt.p; } });
  return { savol, javob, xato, dalil: raw.dalil.trim(), page, sub: String(raw.bolim || '').trim().slice(0, 60), why: String(raw.izoh || '').trim(), chunk: best };
}
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }



/* =====================================================================
   GEMINI (Google AI Studio) mijozi
   ===================================================================== */
const GM = {
  GEN: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  VER: ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']
};
const SAFETY = ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT'].map(c => ({ category: 'HARM_CATEGORY_' + c, threshold: 'BLOCK_ONLY_HIGH' }));
const mkErr = (code, msg) => { const e = new Error(msg); e.code = code; return e; };
const fatal = e => !!e && (e.message === 'ABORT' || ['BADKEY', 'NOKEY', 'REGION', 'QUOTA'].includes(e.code));
const gInfo = new Map(); // kalit -> { avail:Set|null, discovered, noThink:{} }
const gi = key => { if (!gInfo.has(key)) gInfo.set(key, { avail: null, discovered: false, noThink: {} }); return gInfo.get(key); };
let gActive = 0; const gWait = [];
const gAcquire = () => new Promise(res => { if (gActive < CFG.conc * 2) { gActive++; res(); } else gWait.push(res); });
const gRelease = () => { const n = gWait.shift(); if (n) n(); else gActive--; };
const wait = (ms, sig) => new Promise((res, rej) => { const t = setTimeout(res, ms); if (sig) sig.addEventListener('abort', () => { clearTimeout(t); rej(new Error('ABORT')); }, { once: true }); });

async function gCheck(key) {
  try {
    const r = await fetch(CFG.geminiBase + 'models?pageSize=1000', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(12000) });
    if (r.ok) { const d = await r.json().catch(() => ({})); return { ok: true, models: d.models || [] }; }
    const e = await r.json().catch(() => ({})); const msg = (e.error && e.error.message) || ('HTTP ' + r.status);
    return (r.status === 400 || r.status === 401 || r.status === 403) ? { ok: false, invalid: true, msg } : { ok: false, other: true, msg };
  } catch (e) { return { ok: false, network: true, msg: e.message }; }
}
function setAvail(key, models) {
  const g = gi(key), s = new Set();
  (models || []).forEach(m => { if (m && m.name && (!m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))) s.add(String(m.name).replace(/^models\//, '')); });
  g.avail = s.size ? s : null; g.discovered = true;
}
async function gDiscover(key) { const g = gi(key); if (g.discovered) return; g.discovered = true; const r = await gCheck(key); if (r.ok) setAvail(key, r.models); }
function gChain(key, pref) {
  const av = gi(key).avail; if (!av) return pref.slice();
  const out = pref.filter(m => av.has(m));
  const auto = [...av].map(n => { const m = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/.exec(n); return m ? { n, v: parseFloat(m[1]), lite: m[2] ? 1 : 0 } : null; }).filter(Boolean).sort((a, b) => b.v - a.v || a.lite - b.lite).map(x => x.n);
  auto.slice(0, 3).forEach(n => { if (!out.includes(n)) out.push(n); });
  return out.length ? out : pref.slice();
}
function retryWait(e, headers) {
  let w = NaN;
  try { ((e.error && e.error.details) || []).forEach(d => { if (d && d.retryDelay) { const m = /([\d.]+)s/.exec(d.retryDelay); if (m) w = parseFloat(m[1]); } }); } catch (x) {}
  if (isNaN(w)) { const m = /retry in ([\d.]+)\s*(ms|s)/i.exec((e.error && e.error.message) || ''); if (m) w = m[2].toLowerCase() === 'ms' ? parseFloat(m[1]) / 1000 : parseFloat(m[1]); }
  if (isNaN(w)) { const h = parseFloat(headers.get('retry-after')); if (!isNaN(h)) w = h; }
  return w;
}
async function gChat(key, models, messages, o) {
  o = o || {};
  if (!key) throw mkErr('NOKEY', "AI kaliti kiritilmagan. /key buyrug'i bilan Google AI Studio kalitingizni kiriting.");
  await gDiscover(key);
  const g = gi(key), list = gChain(key, models);
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] }));
  let lastErr = null, dailyHit = false;
  for (const model of list) {
    const gen = { temperature: o.temperature == null ? 0.3 : o.temperature, maxOutputTokens: Math.min(32768, Math.max(4096, (o.max_tokens || 4096) * 2)) };
    if (o.json) gen.responseMimeType = 'application/json';
    if (o.effort && !g.noThink[model]) gen.thinkingConfig = { thinkingLevel: o.effort };
    const body = { contents, generationConfig: gen, safetySettings: SAFETY };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    let strip = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (o.signal && o.signal.aborted) throw new Error('ABORT');
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 90000);
      const onAbort = () => ctl.abort(); if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });
      let slot = false;
      try {
        await gAcquire(); slot = true;
        const r = await fetch(CFG.geminiBase + 'models/' + model + ':generateContent', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
        gRelease(); slot = false;
        if (r.ok) {
          const d = await r.json();
          const cand = d.candidates && d.candidates[0];
          const parts = cand && cand.content && cand.content.parts ? cand.content.parts : [];
          const text = parts.filter(p => p && p.text && !p.thought).map(p => p.text).join('');
          if (text) return { text, model };
          const why = (d.promptFeedback && d.promptFeedback.blockReason) || (cand && cand.finishReason) || 'EMPTY';
          lastErr = new Error("AI bo'sh javob qaytardi (" + why + ')');
          if (/SAFETY|PROHIBITED|BLOCKLIST/.test(why)) break;
          continue;
        }
        const e = await r.json().catch(() => ({})); const msg = (e.error && e.error.message) || ('HTTP ' + r.status), raw = JSON.stringify(e);
        lastErr = new Error(msg);
        if (/API_KEY_INVALID|API key not valid|API key expired|leaked/i.test(raw) || r.status === 401) throw mkErr('BADKEY', "AI kaliti yaroqsiz yoki bekor qilingan. /key bilan yangisini kiriting.");
        if (r.status === 403) throw mkErr('BADKEY', "AI kalitiga ruxsat yo'q (403). Google AI Studio'da kalitni tekshiring yoki /key bilan yangisini kiriting.");
        if (r.status === 400) {
          if (/location is not supported/i.test(msg)) throw mkErr('REGION', "Google Gemini API server joylashgan hududda qo'llab-quvvatlanmaydi.");
          if (strip === 0 && gen.thinkingConfig) { delete gen.thinkingConfig; g.noThink[model] = true; strip = 1; continue; }
          if (strip < 2) { delete gen.responseMimeType; delete body.safetySettings; strip = 2; continue; }
          break;
        }
        if (r.status === 404) break;
        if (r.status === 429) {
          if (/PerDay|per day|daily/i.test(raw)) { dailyHit = true; break; }
          let w = retryWait(e, r.headers); if (isNaN(w)) w = 8 * (attempt + 1);
          if (w > 75) break;
          if (o.onWait) o.onWait(Math.ceil(w + 1));
          await wait((w + 1) * 1000, o.signal); continue;
        }
        if (r.status >= 500) { await wait(2500 * (attempt + 1), o.signal); continue; }
        break;
      } catch (err) {
        if (slot) { gRelease(); slot = false; }
        if (err && (err.code === 'BADKEY' || err.code === 'REGION')) throw err;
        if ((o.signal && o.signal.aborted) || (err && err.message === 'ABORT')) throw new Error('ABORT');
        lastErr = err && err.name === 'AbortError' ? new Error('AI javobi kechikdi (timeout)') : err;
        await wait(2000 * (attempt + 1), o.signal);
      } finally { clearTimeout(tm); if (o.signal) o.signal.removeEventListener('abort', onAbort); }
    }
  }
  if (dailyHit) throw mkErr('QUOTA', "Bepul kunlik limit tugadi. Ertaga qayta urinib ko'ring yoki boshqa kalit kiriting (/key).");
  throw lastErr || new Error("AI bilan aloqa yo'q");
}
const errText = e => {
  if (!e) return "Noma'lum xatolik";
  if (['NOKEY', 'BADKEY', 'REGION', 'QUOTA'].includes(e.code)) return e.message;
  return 'Xatolik: ' + e.message;
};

/* =====================================================================
   SAVOL TUZISH — parallel, savollar banki bilan
   ===================================================================== */
// nomzod: kanonik shakl (bankka shu saqlanadi) + tekshirish uchun aralashtirilgan variantlar
function toCand(v) {
  const opts = shuffle([v.javob, ...v.xato]);
  return { id: hash(v.savol), q: v.savol, ans: v.javob, wrong: v.xato.slice(), ev: v.dalil, page: v.page, topic: v.chunk.n, title: v.chunk.title, sub: v.sub, why: v.why, opts, a: opts.indexOf(v.javob), verified: true };
}
const canon = c => ({ id: c.id, q: c.q, ans: c.ans, wrong: c.wrong, ev: c.ev, page: c.page, topic: c.topic, title: c.title, sub: c.sub, why: c.why });
function serve(c) { const opts = shuffle([c.ans, ...c.wrong]); return { id: c.id, q: c.q, opts, a: opts.indexOf(c.ans), ev: c.ev, page: c.page, topic: c.topic, title: c.title, sub: c.sub, why: c.why }; }

async function verifyBatch(key, cands, texts, o) {
  const qs = cands.map((c, i) => `${i + 1}) ${c.q}\n` + c.opts.map((t, k) => `${LET[k]}. ${t}`).join('\n')).join('\n\n');
  const msgs = [{ role: 'system', content: `Sen tarix darsligi matni bo'yicha test yechuvchisan. Har bir savolga FAQAT berilgan matnga tayanib javob ber. Tashqi bilimni ishlatma. Agar matn bitta variantni aniq isbotlamasa yoki bir nechta variant to'g'ri bo'lsa, "v":"0" yoz. Faqat JSON: {"javoblar":[{"n":1,"v":"B"}]}` },
    { role: 'user', content: `MATN:\n${texts}\n\nSAVOLLAR:\n${qs}` }];
  const r = await gChat(key, GM.VER, msgs, { temperature: 0, max_tokens: 700, json: true, effort: 'low', signal: o.signal, onWait: o.onWait });
  const d = parseJSON(r.text), map = {};
  (d.javoblar || []).forEach(x => { map[+x.n] = String(x.v || '').trim().toUpperCase().charAt(0); });
  return cands.map((c, i) => map[i + 1] === LET[c.a]);
}
async function runBatch(key, level, chunks, items, want, state, o) {
  const used = items.map(x => chunks[x.i]);
  const texts = used.map(c => `=== ${c.n}-mavzu: ${c.title} ===\n${c.text}`).join('\n\n');
  const r = await gChat(key, GM.GEN, genPrompt(level, texts, want, state.avoid), { temperature: 0.25, max_tokens: 3600, json: true, effort: level === 'master' ? 'medium' : 'low', signal: o.signal, onWait: o.onWait });
  let list = []; try { list = parseJSON(r.text).savollar || []; } catch (e) { return 0; }
  const cands = [];
  for (const raw of list) {
    const v = validate(raw, used, state.avoidNorm); if (!v) { state.rejected++; continue; }
    state.avoidNorm.push(NORM(v.savol).split(' ').filter(w => w.length > 3)); state.avoid.push(v.savol); cands.push(toCand(v));
  }
  if (!cands.length) return 0;
  let ok; try { ok = await verifyBatch(key, cands, texts, o); } catch (e) { if (fatal(e)) throw e; ok = cands.map(() => null); }
  let added = 0;
  cands.forEach((q, i) => { if (ok[i] === false) { state.rejected++; return; } q.verified = ok[i] !== false && ok[i] !== null; state.out.push(q); added++; });
  return added;
}
// Parallel generatsiya: batchlar bir vaqtda (CFG.conc ta) ishlaydi, N ta tasdiqlangan savol yig'ilishi bilan to'xtaydi
async function generateQuestions(key, level, topics, N, o) {
  const chunks = buildChunks(topics); if (!chunks.length) throw new Error('Tanlangan mavzularda matn topilmadi');
  const { batches } = plan(chunks, N);
  const avoid = (o.avoid || []).slice();
  const state = { out: [], avoid, avoidNorm: avoid.map(q => NORM(q).split(' ').filter(w => w.length > 3)), rejected: 0, err: null };
  const ctl = new AbortController(); let userAbort = false, enough = false, fatalErr = null;
  if (o.signal) { if (o.signal.aborted) throw new Error('ABORT'); o.signal.addEventListener('abort', () => { userAbort = true; ctl.abort(); }, { once: true }); }
  const bo = { signal: ctl.signal, onWait: o.onWait };
  const prog = msg => o.progress && o.progress(Math.min(state.out.length, N), N, msg);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < batches.length && !ctl.signal.aborted) {
      const b = batches[next++], want = Math.min(12, Math.ceil(b.n * 1.35));
      try { await runBatch(key, level, chunks, b.items, want, state, bo); }
      catch (e) { if (fatal(e) && e.message !== 'ABORT') { fatalErr = e; ctl.abort(); } else if (e.message !== 'ABORT') state.err = e; }
      done++; prog(`Savollar tuzilmoqda va darslik bilan tekshirilmoqda (${done}/${batches.length})`);
      if (state.out.length >= N && !enough) { enough = true; ctl.abort(); }
    }
  };
  prog('Savollar tuzilmoqda…');
  await Promise.all(Array.from({ length: Math.min(CFG.conc, batches.length) }, worker));
  if (userAbort) throw new Error('ABORT');
  if (fatalErr) throw fatalErr;
  const caps = chunks.map(capOf), capSum = caps.reduce((a, b) => a + b, 0);
  for (let rounds = 0; state.out.length < Math.min(N, capSum) && rounds < 4; rounds++) {
    const need = Math.min(N, capSum) - state.out.length;
    const have = chunks.map(c => state.out.filter(q => q.topic === c.n && q.title === c.title).length);
    const room = chunks.map((c, i) => i).filter(i => have[i] < caps[i]); if (!room.length) break;
    room.sort((x, y) => have[x] / caps[x] - have[y] / caps[y]);
    const idx = room[rounds % Math.min(room.length, 3)];
    prog(`Yetishmayotgan ${need} ta savol qo'shilmoqda…`);
    try { await runBatch(key, level, chunks, [{ i: idx, take: need }], Math.min(10, need + 2), state, { signal: o.signal, onWait: o.onWait }); }
    catch (e) { if (e.message === 'ABORT') throw e; if (fatal(e)) throw e; state.err = e; }
  }
  const all = state.out.slice();
  let items = all.slice();
  while (items.length > N) { // eng ko'p savol berilgan mavzudan ortiqchasini olib tashlaymiz
    const cnt = new Map(); items.forEach(q => cnt.set(q.topic, (cnt.get(q.topic) || 0) + 1));
    let worst = null, m = -1; cnt.forEach((v, k) => { if (v >= m) { m = v; worst = k; } });
    const pos = items.map(q => q.topic).lastIndexOf(worst); items.splice(pos, 1);
  }
  return { items, all, rejected: state.rejected, err: state.err };
}
// Bank + generatsiya: avval foydalanuvchi ko'rmagan tayyor savollar, yetmasa yangilari tuziladi
async function getQuestions(o) {
  const bank = bankOf(o.bookKey).d, rec = userRec(o.uid), seen = new Set(rec.seen[o.bookKey + '|' + o.level] || []);
  const pools = o.topics.map(t => shuffle((bank[t.n + '|' + o.level] || []).filter(x => !seen.has(x.id))));
  const pick = []; let i = 0;
  while (pick.length < o.N && pools.some(p => p.length)) { const p = pools[i++ % pools.length]; if (p.length) pick.push(p.pop()); }
  if (pick.length >= o.N) { o.progress && o.progress(o.N, o.N, 'Tayyor savollar banki'); return { items: pick.map(serve), fromBank: pick.length, fresh: 0 }; }
  const need = o.N - pick.length;
  const avoid = o.topics.flatMap(t => (bank[t.n + '|' + o.level] || []).map(x => x.q));
  const base = pick.length;
  const gen = await generateQuestions(o.key, o.level, o.topics, need, { avoid, signal: o.signal, onWait: o.onWait, progress: (d, t, m) => o.progress && o.progress(base + d, o.N, m) });
  addToBank(o.bookKey, o.level, gen.all);
  const items = shuffle([...pick.map(serve), ...gen.items.map(serve)]).slice(0, o.N);
  if (items.length < Math.min(5, o.N)) throw new Error("Yetarli darajada sifatli savol tuzib bo'lmadi" + (gen.err ? ' (' + gen.err.message + ')' : '') + ". Qayta urinib ko'ring yoki boshqa mavzu tanlang.");
  return { items, fromBank: pick.length, fresh: gen.items.length, short: items.length < o.N ? items.length : 0 };
}
function addToBank(bk, level, cands) {
  const bank = bankOf(bk).d; let n = 0;
  for (const c of cands) {
    if (!c.verified) continue; // faqat ikki bosqichda tasdiqlangan savollar keshlanadi
    const k = c.topic + '|' + level; const arr = bank[k] = bank[k] || [];
    if (arr.some(x => x.id === c.id)) continue; arr.push(canon(c)); n++;
  }
  if (n) bankSave(bk);
}
const markSeen = (uid, bk, level, items) => {
  const rec = userRec(uid), k = bk + '|' + level; const arr = rec.seen[k] = rec.seen[k] || [];
  items.forEach(q => { if (!arr.includes(q.id)) arr.push(q.id); }); if (arr.length > 3000) arr.splice(0, arr.length - 3000); saveDb();
};
const aiKeyOf = uid => (userRec(uid).key || (CFG.sharedKey ? CFG.geminiKey : '') || '');

/* =====================================================================
   FOYDALANUVCHI HOLATI VA MENYULAR
   ===================================================================== */
const SESS = new Map();
const sess = id => { if (!SESS.has(id)) SESS.set(id, { level: 'orta', count: 20, sec: 20, sel: new Set(), mode: 'solo', step: 'home' }); return SESS.get(id); };
const LEVEL_UI = { orta: ["🌱 O'rta", "Aniq faktlar: kim, qachon, qayerda"], yuqori: ['🔥 Yuqori', 'Sabab-oqibat, taqqoslash, ketma-ketlik'], master: ['👑 Master', "Tahliliy, bir necha faktni bog'lash"] };
const selTopics = s => s.book.topics.filter(t => s.sel.has(t.n));
const PER_PAGE = 8;

function homeView(uid) {
  const r = userRec(uid), has = !!r.key;
  return { text: `👋 <b>Assalomu alaykum!</b>\n\nBu bot maktab tarix darsliklari (${GRADES.length ? GRADES.join(', ') + '-sinflar' : '—'}) asosida <b>xatosiz, darslik bilan tekshirilgan</b> testlar tuzadi.\n\n📚 <b>Test</b> — sinf, mavzu, daraja va savollar sonini tanlaysiz\n⚔️ <b>Tarixiy Duel</b> — do'stlar bilan real vaqtda bellashuv (PIN orqali)\n🔑 <b>AI kalit</b> — ${has ? "o'zingizning kalitingiz ulangan ✅" : 'ixtiyoriy: o\'zingizning Google AI Studio kalitingiz'}`,
    markup: kb([[btn('📚 Test ishlash', 'm:solo')], [btn('⚔️ Tarixiy Duel', 'm:duel')], [btn(has ? '🔑 AI kalit (ulangan)' : '🔑 AI kalit', 'k:menu'), btn('📊 Natijalarim', 'stats')]]) };
}
function gradesView(s) {
  if (!GRADES.length) return { text: "⚠️ <b>tarix-data</b> papkasida darsliklar topilmadi.", markup: kb([[btn('🏠 Menyu', 'h')]]) };
  const rows = []; for (let i = 0; i < GRADES.length; i += 3) rows.push(GRADES.slice(i, i + 3).map(g => btn(`${g}-sinf`, 'g:' + g)));
  rows.push([btn('⬅️ Orqaga', 'h')]);
  return { text: s.mode === 'duel' ? "⚔️ <b>Tarixiy Duel — xona yaratish</b>\n\nQaysi sinf tarixidan savollar bo'lsin?" : "📚 <b>Qaysi sinf tarixidan test ishlaysiz?</b>\n\n<i>Savollar faqat rasmiy darslik matnidan tuziladi va har biri darslik bilan tekshiriladi.</i>", markup: kb(rows) };
}
function subjectsView(s) {
  const bs = BOOKS.filter(b => b.grade === s.grade);
  return { text: `<b>${s.grade}-sinf:</b> fanni tanlang`, markup: kb([...bs.map(b => [btn(b.kind === 'u' ? "🕌 O'zbekiston tarixi" : b.kind === 'j' ? '🌍 Jahon tarixi' : '📖 Tarix', 'b:' + b.key)]), [btn('⬅️ Orqaga', 'bk')]]) };
}
function topicsView(s) {
  const T = s.book.topics, pages = Math.max(1, Math.ceil(T.length / PER_PAGE)); s.page = Math.min(Math.max(0, s.page || 0), pages - 1);
  const rows = T.slice(s.page * PER_PAGE, (s.page + 1) * PER_PAGE).map((t, i) => { const idx = s.page * PER_PAGE + i; return [btn(`${s.sel.has(t.n) ? '☑️' : '⬜'} ${t.n}. ${trunc(t.title, 46)}`, 'tt:' + idx)]; });
  if (pages > 1) rows.push([btn('◀️', 'tp:' + (s.page - 1)), btn(`${s.page + 1}/${pages}`, 'noop'), btn('▶️', 'tp:' + (s.page + 1))]);
  rows.push([btn('✅ Hammasi', 'ta:1'), btn('🧹 Tozalash', 'ta:0')]);
  rows.push([btn('⬅️ Orqaga', 'bk'), btn(`Davom etish (${s.sel.size}) ▶️`, 'tc')]);
  return { text: `📖 <b>${esc(s.book.name)}</b> · ${s.grade}-sinf\n\n<b>Mavzu(lar)ni tanlang</b> — bitta yoki bir nechta.`, markup: kb(rows) };
}
function settingsView(s) {
  const lv = Object.entries(LEVEL_UI).map(([k, v]) => btn((s.level === k ? '✅ ' : '') + v[0], 'lv:' + k));
  const cn = [10, 20, 30].map(n => btn((s.count === n ? '✅ ' : '') + n + ' ta', 'cn:' + n));
  const rows = [lv, cn];
  let extra = '';
  if (s.mode === 'duel') { rows.push([10, 15, 20, 30].map(n => btn((s.sec === n ? '✅ ' : '') + n + ' s', 'sc:' + n))); extra = "\n\n⏱ <b>Har bir savolga vaqt</b> (3-qator)\n<i>To'g'ri javob 500 ball + 0–500 tezlik bonusi + seriya bonusi (ko'pi bilan +200).</i>"; }
  rows.push([btn('⬅️ Orqaga', 'bk'), btn(s.mode === 'duel' ? '🚪 Xona yaratish' : 'Davom etish ▶️', 'st')]);
  const caps = buildChunks(selTopics(s)).reduce((a, c) => a + capOf(c), 0);
  const note = s.count > caps ? `\n\nℹ️ Tanlangan mavzu(lar) matni qisqa: sifatli savollar ko'pi bilan ~${caps} ta chiqadi.` : '';
  return { text: `⚙️ <b>Test sozlamalari</b>\n\n<b>1. Daraja</b> (1-qator)\n${Object.values(LEVEL_UI).map(v => `${v[0]} — ${v[1]}`).join('\n')}\n\n<b>2. Savollar soni</b> (2-qator)${extra}${note}`, markup: kb(rows) };
}
function litView(s) {
  const ts = selTopics(s);
  const lines = ts.slice(0, 15).map(t => `• <b>${esc(t.n)}-mavzu.</b> ${esc(trunc(t.title, 60))} — <i>${pageRange(t)}</i>`);
  if (ts.length > 15) lines.push(`… va yana ${ts.length - 15} ta mavzu`);
  return { text: `📚 <b>Kerakli adabiyot</b>\n${esc(s.book.name)}, ${s.grade}-sinf darsligi:\n\n${lines.join('\n')}\n\n📝 ${s.count} ta savol · ${LEVEL_UI[s.level][0]} daraja\n\n<b>Tayyormisan?</b>`, markup: kb([[btn('✅ Ha, boshlaymiz', 'rd')], [btn('⬅️ Orqaga', 'bk')]]) };
}

/* ---------- oldindan tayyorlash (prefetch) ---------- */
function startJob(uid, s, chat) {
  if (s.job) { try { s.job.ctl.abort(); } catch (e) {} }
  const ctl = new AbortController();
  const job = { ctl, d: 0, t: s.count, msg: 'Savollar tayyorlanmoqda…', wait: 0, done: false, res: null, err: null, sig: [s.bookKey, s.level, s.count, [...s.sel].join(',')].join('|') };
  job.p = getQuestions({ uid, key: aiKeyOf(uid), bookKey: s.bookKey, topics: selTopics(s), level: s.level, N: s.count, signal: ctl.signal,
    progress: (d, t, m) => { job.d = d; job.t = t; if (m) job.msg = m; job.wait = 0; }, onWait: w => { job.wait = w; } })
    .then(r => { job.res = r; job.done = true; return r; }, e => { job.err = e; job.done = true; });
  s.job = job; return job;
}
async function beginSolo(chat, mid, uid) {
  const s = sess(uid);
  if (s.starting) return; s.starting = true;
  try {
    let job = s.job;
    const sig = [s.bookKey, s.level, s.count, [...s.sel].join(',')].join('|');
    if (!job || job.sig !== sig || (job.done && job.err)) job = startJob(uid, s, chat);
    let last = '', lastAt = 0;
    while (!job.done) {
      const txt = `⏳ <b>Test tuzilmoqda</b>\n\n${bar(job.d, job.t)} ${job.d}/${job.t}\n<i>${esc(job.wait ? `AI limiti: ${job.wait} soniya kutilmoqda…` : job.msg)}</i>`;
      if (txt !== last && Date.now() - lastAt > 1500) { last = txt; lastAt = Date.now(); await edit(chat, mid, txt, kb([[btn('✖️ Bekor qilish', 'cx')]])).catch(() => {}); }
      await sleep(150); if (s.job !== job) return;
    }
    if (job.err) {
      if (job.err.message === 'ABORT') return;
      await edit(chat, mid, `❌ ${esc(errText(job.err))}`, kb([[btn('🔁 Qayta urinish', 'rd')], ...(/kalit|key|limit/i.test(job.err.message) ? [[btn('🔑 AI kalit', 'k:menu')]] : []), [btn('⬅️ Orqaga', 'bk')]]));
      return;
    }
    s.items = job.res.items; s.ans = s.items.map(() => null); s.i = 0; s.t0 = Date.now(); s.short = job.res.short || 0; s.step = 'quiz'; s.job = null;
    markSeen(uid, s.bookKey, s.level, s.items);
    await renderQ(chat, mid, s);
  } finally { s.starting = false; }
}
function qView(s) {
  const it = s.items[s.i], n = s.items.length, sel = s.ans[s.i], answered = s.ans.filter(a => a != null).length;
  const text = `📝 <b>Savol ${s.i + 1}/${n}</b> · ${answered}/${n} belgilandi\n<i>${esc(it.topic)}-mavzu · ${esc(trunc(it.title, 50))}</i>\n\n<b>${esc(it.q)}</b>\n\n${it.opts.map((t, k) => `<b>${LET[k]}.</b> ${esc(t)}`).join('\n')}${s.short ? `\n\n<i>Faqat ${s.short} ta savol darslik bilan to'liq tasdiqlandi.</i>` : ''}`;
  const rows = [it.opts.map((t, k) => btn((sel === k ? '✅ ' : '') + LET[k], 'qa:' + k))];
  rows.push([btn('◀️', 'qn:' + (s.i - 1)), btn(`${s.i + 1}/${n}`, 'noop'), btn('▶️', 'qn:' + (s.i + 1))]);
  rows.push([btn('🏁 Testni yakunlash', 'qf')]);
  return { text, markup: kb(rows) };
}
const renderQ = (chat, mid, s) => { const v = qView(s); return edit(chat, mid, v.text, v.markup); };

/* ---------- natija ---------- */
function verdict(p) {
  if (p >= 90) return ["A'lo natija!", "Mavzuni juda yaxshi o'zlashtirgansiz. Endi yuqoriroq darajada sinab ko'ring."];
  if (p >= 75) return ['Yaxshi natija', "Asosiy qismi o'zlashtirilgan. Quyidagi xatolarni darslikdan qayta o'qib chiqsangiz, natija a'loga chiqadi."];
  if (p >= 50) return ['Qoniqarli', "Mavzuni qayta o'qib chiqish kerak. Ayniqsa quyida ko'rsatilgan betlarga e'tibor bering."];
  return ["Qayta o'rganish kerak", "Mavzuni darslikdan boshidan diqqat bilan o'qib, so'ng testni qayta ishlang."];
}
function resultMessages(s, all) {
  const n = s.items.length; let ok = 0, bad = 0, skip = 0;
  s.items.forEach((q, i) => { const a = s.ans[i]; if (a == null) skip++; else if (a === q.a) ok++; else bad++; });
  const pct = Math.round(ok / n * 100), v = verdict(pct), dur = Math.floor((s.dur != null ? s.dur : (Date.now() - s.t0) / 1000));
  const byTopic = new Map();
  s.items.forEach((q, i) => { if (!byTopic.has(q.topic)) byTopic.set(q.topic, { title: q.title, all: 0, bad: 0, pages: [], subs: new Map() }); const t = byTopic.get(q.topic); t.all++; if (s.ans[i] !== q.a) { t.bad++; t.pages.push(q.page); if (q.sub) t.subs.set(q.sub, (t.subs.get(q.sub) || 0) + 1); } });
  const weak = [...byTopic.entries()].filter(([, t]) => t.bad).sort((a, b) => b[1].bad / b[1].all - a[1].bad / a[1].all);
  const adv = [];
  if (!bad && !skip) adv.push("Barcha savollarga to'g'ri javob berdingiz. Keyingi darajadagi test yoki boshqa mavzuga o'ting.");
  else {
    adv.push("Xato qilingan joylarni darslikda ko'rsatilgan betlardan qayta o'qing — har bir xato ostida darslikdan aynan dalil keltirilgan.");
    if (skip) adv.push(`${skip} ta savol belgilanmagan: bilmagan savolni ham taxmin qilib belgilang, so'ng shu joyni darslikdan toping.`);
    if (pct < 50) adv.push("Avval mavzu matnini boshidan oxirigacha o'qing, sana va nomlarning qisqa konspektini yozing, keyin testni qayta ishlang.");
    else if (pct < 90) adv.push("Faqat xato qilgan bo'limlaringizni qayta o'qib, shu mavzuning yangi testini ishlang.");
    if (s.level !== 'master' && pct >= 85) adv.push("Natijangiz yaxshi — keyingi (yuqoriroq) darajani sinab ko'ring.");
  }
  const em = pct >= 90 ? '🏆' : pct >= 75 ? '👍' : pct >= 50 ? '🙂' : '📚';
  let head = `${em} <b>Test yakunlandi</b>\n\n📊 Natija: <b>${pct}%</b> — ${v[0]}\n✅ To'g'ri: <b>${ok}</b>   ❌ Xato: <b>${bad}</b>   ➖ Belgilanmagan: <b>${skip}</b>\n⏱ Vaqt: ${mmss(dur)}\n\n<i>${v[1]}</i>\n\n💡 <b>Nima qilsangiz yaxshi bo'ladi</b>\n${adv.map(a => '• ' + esc(a)).join('\n')}`;
  if (weak.length) head += `\n\n📖 <b>Ko'proq o'qish kerak bo'lgan joylar</b>\n` + weak.map(([k, t]) => {
    const subs = [...t.subs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
    return `• <b>${esc(k)}-mavzu.</b> ${esc(trunc(t.title, 50))} — ${t.bad}/${t.all} xato\n   🔖 ${esc(fmtPages(t.pages))}ni qayta o'qing${subs.length ? `\n   <i>Bo'limlar: ${esc(subs.join(' · '))}</i>` : ''}`;
  }).join('\n');
  const blocks = [];
  s.items.forEach((q, i) => {
    const a = s.ans[i], good = a === q.a; if (good && !all) return;
    blocks.push(`${good ? '✅' : '❌'} <b>${i + 1}.</b> ${esc(q.q)}\nSizning javobingiz: <b>${a == null ? 'belgilanmagan' : LET[a] + '. ' + esc(q.opts[a])}</b>${good ? '' : `\nTo'g'ri javob: <b>${LET[q.a]}. ${esc(q.opts[q.a])}</b>`}${q.why ? `\n${esc(q.why)}` : ''}\n<i>Darslikdan: «${esc(q.ev)}» (${esc(q.page)}-bet)</i>`);
  });
  const msgs = [head];
  if (blocks.length) packBlocks(blocks, `🔎 <b>Savollar tahlili</b>${all ? ' (hammasi)' : ' (xatolar)'}`).forEach(m => msgs.push(m));
  return { msgs, pct, ok, n };
}
async function finishSolo(chat, mid, uid) {
  const s = sess(uid); s.dur = Math.floor((Date.now() - s.t0) / 1000); s.step = 'result';
  const r = resultMessages(s, false); const rec = userRec(uid); rec.tests++; rec.sumPct += r.pct; saveDb();
  const tail = kb([[btn('🔁 Yangi test', 'again')], [btn('⚙️ Sozlamalarni o\'zgartirish', 'rset'), btn('📋 Hammasi', 'rall')], [btn('🏠 Menyu', 'h')]]);
  await edit(chat, mid, r.msgs[0], r.msgs.length === 1 ? tail : undefined);
  for (let i = 1; i < r.msgs.length; i++) await send(chat, r.msgs[i], i === r.msgs.length - 1 ? tail : undefined);
}



/* =====================================================================
   TARIXIY DUEL — xona (PIN), taymer, jonli reyting
   Barcha hisob-kitob serverda (xona egasining o'yini bot jarayonida yuradi): hamma bir xil savol oladi.
   ===================================================================== */
const ROOMS = new Map(), ROOM_OF = new Map();
let BOT_NAME = '';
const pName = u => trunc(([u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || "O'yinchi").replace(/[<>&]/g, ''), 16);
const fmtPin = p => p.slice(0, 3) + ' ' + p.slice(3);
const newPin = () => { for (;;) { const p = String(100000 + crypto.randomInt(900000)); if (!ROOMS.has(p)) return p; } };
const onlineOf = r => [...r.players.values()].filter(p => p.on);
const menuKb = kb([[btn('🏠 Menyu', 'h')]]);
const joinLink = r => `https://t.me/${BOT_NAME}?start=duel_${r.pin}`;
const rankIcon = i => ['🥇', '🥈', '🥉'][i] || `<b>${i + 1}.</b>`;
const dots = h => { const s = h.length > 16 ? '…' + h.slice(-16) : h; return s.replace(/1/g, '🟩').replace(/0/g, '🟥').replace(/-/g, '⬜'); };
const sorted = r => [...r.players.values()].sort((a, b) => b.s - a.s || b.c - a.c || a.name.localeCompare(b.name));
function addPlayer(r, uid, chat, user) {
  let base = pName(user), name = base, k = 2;
  while ([...r.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase())) name = base.slice(0, 12) + ' (' + (k++) + ')';
  const p = { id: uid, chat, name, s: 0, c: 0, st: 0, h: '', on: true, mid: 0, last: '', picks: {}, sentAt: 0 };
  r.players.set(uid, p); ROOM_OF.set(uid, r.pin); return p;
}
function lobbyText(r) {
  const ps = [...r.players.values()];
  const g = r.gen;
  const status = g.err ? `❌ ${esc(g.err)}` : r.ready ? `✅ <b>${g.msg}</b>` : `⏳ ${esc(g.wait ? `AI limiti: ${g.wait} soniya kutilmoqda…` : g.msg)}\n${bar(g.d, g.t)} ${g.d}/${g.t}`;
  return `⚔️ <b>Tarixiy Duel</b>\n\n🔑 PIN: <code>${r.pin}</code>\n🔗 ${joinLink(r)}\n\n📚 ${r.set.grade}-sinf · ${esc(r.set.book)} · ${LEVEL_UI[r.set.level][0]} · ${r.set.count} savol · ${r.set.sec} soniya\n\n👥 <b>O'yinchilar (${ps.length}/${DU.max})</b>\n${ps.map(p => `${p.id === r.host ? '👑' : '•'} ${esc(p.name)}${p.on ? '' : ' 📴'}`).join('\n')}\n\n${status}\n\n<i>To'g'ri javob ${DU.base} ball + tezlik bonusi (0–${DU.speed}) + seriya bonusi (ko'pi bilan +${DU.streakMax}).</i>`;
}
function lobbyKb(r, p) {
  if (p.id !== r.host) return kb([[btn('🚪 Chiqish', 'dl')]]);
  const share = `https://t.me/share/url?url=${encodeURIComponent(joinLink(r))}&text=${encodeURIComponent('Tarixiy Duel! PIN: ' + r.pin)}`;
  const rows = [[btn(r.ready ? "▶️ O'yinni boshlash" : '⏳ Savollar tayyorlanmoqda…', 'dg')], [urlBtn("📤 Do'stlarni taklif qilish", share)]];
  if (r.gen.err) rows.push([btn('🔄 Qayta urinish', 'dgr')]);
  rows.push([btn('🚪 Xonani yopish', 'dx')]); return kb(rows);
}
function refreshLobby(r) {
  if (r.rf) return;
  r.rf = setTimeout(async () => {
    r.rf = null; if (r.phase !== 'lobby') return;
    const text = lobbyText(r);
    await Promise.allSettled(onlineOf(r).map(async p => {
      const markup = lobbyKb(r, p), key = text + JSON.stringify(markup); if (p.last === key) return; p.last = key;
      try { await edit(p.chat, p.mid, text, markup); } catch (e) { if (e.code === 403) p.on = false; }
    }));
  }, 450);
}
async function createRoom(uid, chat, user, s, mid) {
  leaveRoom(uid);
  const r = { pin: newPin(), host: uid, phase: 'lobby', set: { grade: s.grade, book: bookLabel(s.book), level: s.level, count: s.count, sec: s.sec }, setup: { bookKey: s.bookKey, topics: selTopics(s), level: s.level, count: s.count },
    items: [], ready: false, gen: { d: 0, t: s.count, msg: '', err: '', wait: 0 }, players: new Map(), qi: -1, ans: {}, rv: null, review: null, run: 0, ctl: null, tm: null, tick: null, rf: null, ttl: null };
  ROOMS.set(r.pin, r);
  const p = addPlayer(r, uid, chat, user);
  p.mid = await show(chat, mid, lobbyText(r), lobbyKb(r, p)); p.last = lobbyText(r) + JSON.stringify(lobbyKb(r, p));
  genRoom(r); return r;
}
function genRoom(r) {
  const run = ++r.run; r.ready = false; r.items = [];
  r.gen = { d: 0, t: r.setup.count, msg: 'Savollar tuzilmoqda…', err: '', wait: 0 };
  if (r.ctl) try { r.ctl.abort(); } catch (e) {}
  r.ctl = new AbortController(); refreshLobby(r);
  getQuestions({ uid: r.host, key: aiKeyOf(r.host), bookKey: r.setup.bookKey, topics: r.setup.topics, level: r.setup.level, N: r.setup.count, signal: r.ctl.signal,
    progress: (d, t, m) => { if (run !== r.run) return; r.gen.d = d; r.gen.t = t; if (m) r.gen.msg = m; r.gen.wait = 0; refreshLobby(r); },
    onWait: w => { if (run === r.run) { r.gen.wait = w; refreshLobby(r); } } })
    .then(res => {
      if (run !== r.run) return;
      r.items = res.items; r.ready = true; r.set.count = res.items.length; markSeen(r.host, r.setup.bookKey, r.setup.level, res.items);
      r.gen = { d: res.items.length, t: res.items.length, msg: res.items.length + ' ta savol tayyor', err: '', wait: 0 }; refreshLobby(r);
    }, e => { if (run !== r.run || e.message === 'ABORT') return; r.gen.err = errText(e); refreshLobby(r); });
}
async function joinRoom(uid, chat, user, pin) {
  const r = ROOMS.get(pin);
  if (!r) return send(chat, "❌ Bunday xona topilmadi. PIN ni tekshirib, qayta yuboring.", menuKb);
  if (r.players.has(uid)) return send(chat, 'Siz bu xonadasiz. Yuqoridagi xabarga qarang yoki /leave bilan chiqing.', menuKb);
  if (r.phase !== 'lobby') return send(chat, "❌ Bu xonada o'yin allaqachon boshlangan.", menuKb);
  if (r.players.size >= DU.max) return send(chat, "❌ Xona to'la (" + DU.max + " tagacha o'yinchi).", menuKb);
  leaveRoom(uid);
  const p = addPlayer(r, uid, chat, user);
  const m = await send(chat, lobbyText(r), lobbyKb(r, p)); p.mid = m.message_id; p.last = lobbyText(r) + JSON.stringify(lobbyKb(r, p));
  r.players.forEach(x => { x.last = ''; }); refreshLobby(r);
}
function leaveRoom(uid) {
  const pin = ROOM_OF.get(uid); if (!pin) return false;
  const r = ROOMS.get(pin); ROOM_OF.delete(uid); if (!r) return true;
  const p = r.players.get(uid); if (!p) return true;
  if (r.phase === 'lobby') {
    r.players.delete(uid);
    if (uid === r.host) { closeRoom(r, '🚪 Xona egasi xonani yopdi.'); return true; }
    edit(p.chat, p.mid, '🚪 Xonadan chiqdingiz.', menuKb).catch(() => {}); r.players.forEach(x => { x.last = ''; }); refreshLobby(r);
  } else {
    p.on = false; if (r.phase !== 'finished') edit(p.chat, p.mid, "🚪 Xonadan chiqdingiz. Natijangiz saqlanib qoldi.", menuKb).catch(() => {});
    if (!onlineOf(r).length) closeRoom(r, null);
  }
  return true;
}
function closeRoom(r, reason) {
  clearTimeout(r.tm); clearInterval(r.tick); clearTimeout(r.rf); clearTimeout(r.ttl); r.run++; if (r.ctl) try { r.ctl.abort(); } catch (e) {}
  r.phase = 'closed'; ROOMS.delete(r.pin);
  for (const p of r.players.values()) { if (ROOM_OF.get(p.id) === r.pin) ROOM_OF.delete(p.id); if (reason && p.mid) edit(p.chat, p.mid, reason, menuKb).catch(() => {}); }
}
const sendFail = (p, e) => { if (e && (e.code === 403 || e.code === 400)) p.on = p.on && e.code !== 403; };
async function startGame(r) {
  r.players.forEach((p, id) => { if (!p.on) { r.players.delete(id); ROOM_OF.delete(id); } });
  r.phase = 'countdown'; r.qi = -1;
  await Promise.allSettled(onlineOf(r).map(p => edit(p.chat, p.mid, `🎮 <b>Tayyor bo'ling!</b>\n\n${r.items.length} ta savol · har biri ${r.set.sec} soniya.\nBirinchi savol ${Math.round(DU.countdown / 1000)} soniyadan so'ng…`).catch(e => sendFail(p, e))));
  r.tm = setTimeout(() => nextQ(r), DU.countdown);
}
const dqOpts = (it, mark) => it.opts.map((t, k) => `<b>${LET[k]}.</b> ${esc(t)}${mark === k ? ' ✅' : ''}`).join('\n');
function dqText(r, p, left, mark) {
  const it = r.items[r.qi];
  return `⚔️ <b>Savol ${r.qi + 1}/${r.items.length}</b> · 🏅 ${p.s} ball\n<i>${esc(it.topic)}-mavzu · ${esc(trunc(it.title, 45))}</i>\n\n<b>${esc(it.q)}</b>\n\n${dqOpts(it, mark)}\n\n` +
    (mark != null ? '✅ <b>Javob qabul qilindi</b> — boshqalar kutilmoqda…' : `⏱ ${bar(left, r.set.sec)} <b>${Math.max(0, Math.ceil(left))} s</b>`);
}
const dqKb = (r, p) => kb([[0, 1, 2, 3].slice(0, r.items[r.qi].opts.length).map(k => btn(LET[k], `dd:${r.pin}:${r.qi}:${k}`))]);
async function nextQ(r) {
  if (r.phase === 'closed') return;
  r.qi++; if (r.qi >= r.items.length) return finishRoom(r);
  const qi = r.qi; r.phase = 'question'; r.ans = {}; r.qStart = Date.now();
  await Promise.allSettled(onlineOf(r).map(async p => { try { await edit(p.chat, p.mid, dqText(r, p, r.set.sec), dqKb(r, p)); } catch (e) { sendFail(p, e); } p.sentAt = Date.now(); }));
  if (r.qi !== qi || r.phase !== 'question') return;
  r.tm = setTimeout(() => closeQ(r, qi), r.set.sec * 1000 + DU.grace + (Date.now() - r.qStart));
  clearInterval(r.tick);
  r.tick = setInterval(() => {
    if (r.phase !== 'question' || r.qi !== qi) return clearInterval(r.tick);
    onlineOf(r).forEach(p => { if (r.ans[p.id]) return; const left = r.set.sec - (Date.now() - (p.sentAt || r.qStart)) / 1000; if (left > 1) edit(p.chat, p.mid, dqText(r, p, left), dqKb(r, p)).catch(e => sendFail(p, e)); });
  }, DU.tick);
  if (!onlineOf(r).length) closeRoom(r, null);
}
function onDuelAnswer(cq, pin, qi, k) {
  const uid = cq.from.id, r = ROOMS.get(pin), p = r && r.players.get(uid);
  if (!p) return ansCb(cq.id, 'Xona topilmadi', true);
  if (r.phase !== 'question' || qi !== r.qi) return ansCb(cq.id, 'Bu savol yopilgan');
  if (r.ans[uid]) return ansCb(cq.id, 'Javob allaqachon qabul qilingan');
  const now = Date.now(), base = p.sentAt || r.qStart;
  if (now - base > r.set.sec * 1000 + DU.grace) return ansCb(cq.id, '⏱ Vaqt tugadi');
  r.ans[uid] = { k, el: Math.min(r.set.sec * 1000, Math.max(0, now - base)) }; p.picks[qi] = k;
  ansCb(cq.id, '✅ Javob qabul qilindi');
  edit(p.chat, p.mid, dqText(r, p, 0, k), kb([])).catch(e => sendFail(p, e));
  if (onlineOf(r).every(x => r.ans[x.id])) { clearTimeout(r.tm); r.tm = setTimeout(() => closeQ(r, qi), 700); }
}
function boardText(r, me) {
  return sorted(r).map((p, i) => `${rankIcon(i)} ${p.id === me ? '➤ ' : ''}${esc(p.name)}${p.on ? '' : ' 📴'} — <b>${p.s}</b>\n      ${dots(p.h)}`).join('\n');
}
async function closeQ(r, qi) {
  if (r.phase !== 'question' || r.qi !== qi) return;
  clearTimeout(r.tm); clearInterval(r.tick);
  const it = r.items[qi], res = {};
  for (const p of r.players.values()) {
    const a = r.ans[p.id];
    if (a && a.k === it.a) {
      const sp = Math.round(DU.speed * (1 - a.el / (r.set.sec * 1000)));
      p.st += 1; const sb = Math.min(DU.streakMax, (p.st - 1) * DU.streakStep), gain = DU.base + sp + sb;
      p.s += gain; p.c += 1; p.h += '1'; res[p.id] = [a.k, gain, sp, sb];
    } else { p.st = 0; p.h += a ? '0' : '-'; res[p.id] = [a ? a.k : -1, 0, 0, 0]; }
  }
  r.phase = 'reveal'; r.rv = res;
  await Promise.allSettled(onlineOf(r).map(p => {
    const m = res[p.id] || [-1, 0, 0, 0], good = m[0] === it.a;
    const me = good ? `✅ <b>To'g'ri!</b> +${m[1]} ball <i>(${DU.base} + tezlik ${m[2]}${m[3] ? ' + seriya ' + m[3] : ''})</i>` : m[0] < 0 ? "⏱ <b>Javob berilmadi</b>" : `❌ <b>Noto'g'ri</b> (siz: ${LET[m[0]]})`;
    const text = `⚔️ <b>Savol ${qi + 1}/${r.items.length} — natija</b>\n\n<b>${esc(it.q)}</b>\n\n✔️ To'g'ri javob: <b>${LET[it.a]}. ${esc(it.opts[it.a])}</b>\n${me}${it.why ? `\n\n${esc(it.why)}` : ''}\n<i>Darslikdan: «${esc(trunc(it.ev, 240))}» (${esc(it.page)}-bet)</i>\n\n🏆 <b>Jonli reyting</b>\n${boardText(r, p.id)}`;
    return edit(p.chat, p.mid, text).catch(e => sendFail(p, e));
  }));
  if (r.phase !== 'reveal') return;
  r.tm = setTimeout(() => (qi >= r.items.length - 1 ? finishRoom(r) : nextQ(r)), DU.reveal);
}
async function finishRoom(r) {
  if (r.phase === 'closed') return;
  clearTimeout(r.tm); clearInterval(r.tick); r.phase = 'finished';
  const rank = sorted(r), tie = rank.length > 1 && rank[0].s === rank[1].s;
  rank.forEach((p, i) => { const rec = userRec(p.id); rec.duels = (rec.duels || 0) + 1; if (i === 0 && !tie) rec.wins = (rec.wins || 0) + 1; }); saveDb();
  await Promise.allSettled(onlineOf(r).map(p => {
    const pos = rank.findIndex(x => x.id === p.id) + 1;
    const text = `🏁 <b>O'yin yakunlandi</b>\n${tie ? '🤝 <b>Durang!</b>' : `🏆 G'olib: <b>${esc(rank[0].name)}</b>`}\n\n${boardText(r, p.id)}\n\n📍 Sizning o'rningiz: <b>${pos}/${rank.length}</b> · ${p.s} ball · ${p.c}/${r.items.length} to'g'ri`;
    const rows = [[btn('📋 Savollar tahlili', 'dv')]]; if (p.id === r.host) rows.push([btn("🔁 Yana o'ynash (yangi savollar)", 'dr')]); rows.push([btn('🏠 Menyu', 'h')]);
    return edit(p.chat, p.mid, text, kb(rows)).catch(e => sendFail(p, e));
  }));
  r.ttl = setTimeout(() => closeRoom(r, null), 2 * 3600 * 1000);
}
function duelReview(r, p) {
  const blocks = [];
  r.items.forEach((q, i) => {
    const a = p.picks[i]; if (a === q.a) return;
    blocks.push(`❌ <b>${i + 1}.</b> ${esc(q.q)}\nSizning javobingiz: <b>${a == null ? 'berilmagan' : LET[a] + '. ' + esc(q.opts[a])}</b>\nTo'g'ri javob: <b>${LET[q.a]}. ${esc(q.opts[q.a])}</b>${q.why ? `\n${esc(q.why)}` : ''}\n<i>Darslikdan: «${esc(q.ev)}» (${esc(q.page)}-bet)</i>`);
  });
  return blocks.length ? packBlocks(blocks, '🔎 <b>Xatolar tahlili</b>') : ["🎉 <b>Xato yo'q!</b> Barcha savollarga to'g'ri javob berdingiz."];
}
function rematch(r) {
  clearTimeout(r.ttl); clearTimeout(r.tm); clearInterval(r.tick);
  r.players.forEach((p, id) => { if (!p.on) { r.players.delete(id); ROOM_OF.delete(id); } else { p.s = 0; p.c = 0; p.st = 0; p.h = ''; p.picks = {}; p.last = ''; } });
  r.phase = 'lobby'; r.qi = -1; r.ans = {}; r.rv = null; r.set.count = r.setup.count; genRoom(r);
}

/* =====================================================================
   AI KALIT (/key)
   ===================================================================== */
function keyView(uid) {
  const r = userRec(uid), has = !!r.key;
  const text = `🔑 <b>Google AI Studio kaliti</b>\n\nSavollarni AI tuzadi. Kalit bo'lmasa ham tayyor (oldin tuzilgan) savollar ishlaydi, yangi savollar uchun esa kalit kerak.\n\n${has ? `✅ Sizning kalitingiz ulangan: <code>${esc(r.key.slice(0, 4))}••••${esc(r.key.slice(-4))}</code>` : (CFG.sharedKey && CFG.geminiKey ? "ℹ️ Hozir botning umumiy kaliti ishlatiladi (limit hamma uchun umumiy)." : '⚠️ Hozircha kalit ulanmagan.')}\n\n<b>Bepul kalit olish:</b>\n1. https://aistudio.google.com/apikey ga kiring\n2. <b>Create API key</b> ni bosing\n3. Kalitni shu chatga yuboring (xabar darhol o'chiriladi)\n\n<i>Kalit faqat bot serverida saqlanadi va faqat Google'ga yuboriladi. Bepul darajada Google so'rovlarni mahsulotini yaxshilash uchun ishlatishi mumkin.</i>`;
  return { text, markup: kb([[btn("✍️ Kalit kiritish", 'k:set')], ...(has ? [[btn("🗑 Kalitni o'chirish", 'k:del')]] : []), [btn('🏠 Menyu', 'h')]]) };
}
async function saveKey(chat, uid, mid, raw) {
  const key = String(raw || '').replace(/[\s"'`]+/g, '');
  if (key.length < 20) return send(chat, "❌ Kalit juda qisqa. To'liq kalitni yuboring.", kb([[btn('🏠 Menyu', 'h')]]));
  const m = await send(chat, '⏳ Kalit tekshirilmoqda…');
  const r = await gCheck(key);
  if (r.invalid) return edit(chat, m.message_id, `❌ Kalit qabul qilinmadi: ${esc(trunc(r.msg, 200))}`, kb([[btn('🔁 Qayta kiritish', 'k:set')], [btn('🏠 Menyu', 'h')]]));
  userRec(uid).key = key; gInfo.delete(key); if (r.ok) setAvail(key, r.models); saveDb();
  return edit(chat, m.message_id, r.ok ? '✅ <b>Kalit tekshirildi va saqlandi.</b> Endi savollar sizning kalitingiz bilan tuziladi.' : `✅ Kalit saqlandi, lekin hozir tekshirib bo'lmadi (${r.network ? 'tarmoq' : 'Google javobi'}).`, kb([[btn('📚 Test ishlash', 'm:solo')], [btn('🏠 Menyu', 'h')]]));
}

/* =====================================================================
   BUYRUQLAR VA TUGMALAR
   ===================================================================== */
const isAdmin = uid => CFG.admins.includes(String(uid));
async function showHome(chat, mid, uid) { const s = sess(uid); s.step = 'home'; const v = homeView(uid); return show(chat, mid, v.text, v.markup); }
function statsText(uid) {
  const r = userRec(uid);
  return `📊 <b>Natijalarim</b>\n\n📚 Ishlangan testlar: <b>${r.tests}</b>\n🎯 O'rtacha natija: <b>${r.tests ? Math.round(r.sumPct / r.tests) : 0}%</b>\n⚔️ Duellar: <b>${r.duels || 0}</b> (g'alaba: <b>${r.wins || 0}</b>)`;
}
async function pickBook(chat, mid, uid, key) {
  const s = sess(uid); s.bookKey = key; s.step = 'topics'; s.sel = new Set(); s.page = 0;
  mid = await show(chat, mid, "⏳ Darslik yuklanmoqda…", undefined);
  try { s.book = loadBook(key); } catch (e) { return show(chat, mid, '❌ ' + esc(e.message), kb([[btn('⬅️ Orqaga', 'bk')]])); }
  const v = topicsView(s); return show(chat, mid, v.text, v.markup);
}
async function stepBack(chat, mid, uid) {
  const s = sess(uid); let v;
  if (s.job && s.step === 'lit') { try { s.job.ctl.abort(); } catch (e) {} s.job = null; }
  if (s.step === 'lit') { s.step = 'settings'; v = settingsView(s); }
  else if (s.step === 'settings') { s.step = 'topics'; v = topicsView(s); }
  else if (s.step === 'topics') { if (BOOKS.filter(b => b.grade === s.grade).length > 1) { s.step = 'subjects'; v = subjectsView(s); } else { s.step = 'grades'; v = gradesView(s); } }
  else if (s.step === 'subjects') { s.step = 'grades'; v = gradesView(s); }
  else return showHome(chat, mid, uid);
  return show(chat, mid, v.text, v.markup);
}
async function onCallback(cq) {
  const uid = cq.from.id, msg = cq.message; if (!msg) return ansCb(cq.id);
  const chat = msg.chat.id, mid = msg.message_id, data = cq.data || '', parts = data.split(':'), ns = parts[0], arg = parts[1];
  const s = sess(uid);
  const need = what => { if (!s[what]) { ansCb(cq.id, 'Sessiya eskirgan. /start ni bosing.', true); return false; } return true; };
  if (ns === 'dd') return onDuelAnswer(cq, parts[1], +parts[2], +parts[3]);
  if (ns === 'qa' || ns === 'qn') { if (!s.items) return ansCb(cq.id, 'Test topilmadi. /start ni bosing.', true); }
  if (ns !== 'qa') await ansCb(cq.id);
  let v;
  switch (ns) {
    case 'noop': return;
    case 'h': {
      const pin = ROOM_OF.get(uid), r = pin && ROOMS.get(pin);
      if (r && r.phase !== 'lobby' && r.phase !== 'finished') return ansCb(cq.id, "O'yin davom etmoqda. Chiqish uchun /leave", true);
      if (s.job) { try { s.job.ctl.abort(); } catch (e) {} s.job = null; }
      leaveRoom(uid); return showHome(chat, mid, uid);
    }
    case 'm': {
      if (arg === 'duel' && ROOM_OF.has(uid)) { const r = ROOMS.get(ROOM_OF.get(uid)); if (r && r.phase !== 'finished') return show(chat, mid, "Siz allaqachon xonadasiz. Avval /leave bilan chiqing.", menuKb); }
      s.mode = arg === 'duel' ? 'duel' : 'solo'; s.step = 'grades'; v = gradesView(s);
      if (arg === 'duel') v.markup.inline_keyboard.splice(v.markup.inline_keyboard.length - 1, 0, [btn('🔑 PIN orqali qo\'shilish', 'du:join')]);
      return show(chat, mid, v.text, v.markup);
    }
    case 'du': { s.await = 'pin'; return show(chat, mid, "🔑 <b>Xonaga qo'shilish</b>\n\nDo'stingiz bergan 6 xonali PIN kodni yuboring.", kb([[btn('⬅️ Orqaga', 'h')]])); }
    case 'g': { s.grade = +arg; const bs = BOOKS.filter(b => b.grade === s.grade); if (bs.length === 1) return pickBook(chat, mid, uid, bs[0].key); s.step = 'subjects'; v = subjectsView(s); return show(chat, mid, v.text, v.markup); }
    case 'b': return pickBook(chat, mid, uid, arg);
    case 'bk': return stepBack(chat, mid, uid);
    case 'tt': { if (!need('book')) return; const t = s.book.topics[+arg]; if (t) { if (s.sel.has(t.n)) s.sel.delete(t.n); else s.sel.add(t.n); } v = topicsView(s); return show(chat, mid, v.text, v.markup); }
    case 'tp': { if (!need('book')) return; s.page = +arg; v = topicsView(s); return show(chat, mid, v.text, v.markup); }
    case 'ta': { if (!need('book')) return; s.sel = arg === '1' ? new Set(s.book.topics.map(t => t.n)) : new Set(); v = topicsView(s); return show(chat, mid, v.text, v.markup); }
    case 'tc': { if (!need('book')) return; if (!s.sel.size) return ansCb(cq.id, 'Kamida bitta mavzuni tanlang', true); s.step = 'settings'; v = settingsView(s); return show(chat, mid, v.text, v.markup); }
    case 'lv': case 'cn': case 'sc': {
      if (!need('book')) return; if (ns === 'lv' && LEVEL_UI[arg]) s.level = arg; if (ns === 'cn') s.count = +arg; if (ns === 'sc') s.sec = +arg;
      v = settingsView(s); return show(chat, mid, v.text, v.markup);
    }
    case 'st': {
      if (!need('book') || !s.sel.size) return;
      if (s.mode === 'duel') { if (ROOM_OF.has(uid)) leaveRoom(uid); return createRoom(uid, chat, cq.from, s, mid); }
      s.step = 'lit'; startJob(uid, s, chat); v = litView(s); return show(chat, mid, v.text, v.markup);
    }
    case 'rd': { if (!need('book')) return; spawn(() => beginSolo(chat, mid, uid)); return; }
    case 'cx': { if (s.job) { try { s.job.ctl.abort(); } catch (e) {} s.job = null; } s.step = 'lit'; startJob(uid, s, chat); v = litView(s); return show(chat, mid, v.text, v.markup); }
    case 'qa': {
      if (s.step !== 'quiz') return ansCb(cq.id);
      await ansCb(cq.id); s.ans[s.i] = +arg; if (s.i < s.items.length - 1) s.i++; return renderQ(chat, mid, s).catch(() => {});
    }
    case 'qn': { const i = +arg; if (i >= 0 && i < s.items.length) s.i = i; return renderQ(chat, mid, s).catch(() => {}); }
    case 'qf': {
      if (!s.items) return; const un = s.ans.filter(a => a == null).length;
      if (!un) return finishSolo(chat, mid, uid);
      return edit(chat, mid, `⚠️ <b>${un} ta savol belgilanmagan.</b>\nShunday bo'lsa ham testni yakunlaysizmi?`, kb([[btn('🏁 Ha, yakunlash', 'qy')], [btn('↩️ Testni davom ettirish', 'qx')]]));
    }
    case 'qy': return s.items ? finishSolo(chat, mid, uid) : undefined;
    case 'qx': return s.items ? renderQ(chat, mid, s) : undefined;
    case 'again': { if (!need('book')) return; s.step = 'lit'; startJob(uid, s, chat); v = litView(s); return show(chat, mid, v.text, v.markup); }
    case 'rset': { if (!need('book')) return; s.step = 'settings'; v = settingsView(s); return send(chat, v.text, v.markup); }
    case 'rall': { if (!s.items) return; const r = resultMessages(s, true); for (let i = 1; i < r.msgs.length; i++) await send(chat, r.msgs[i]); return; }
    case 'stats': return show(chat, mid, statsText(uid), menuKb);
    case 'k': {
      if (arg === 'set') { s.await = 'key'; return show(chat, mid, "✍️ <b>Kalitni yuboring</b>\n\nGoogle AI Studio'dan olgan kalitni shu chatga yuboring. Xabar tekshirilgach o'chiriladi.", kb([[btn('⬅️ Orqaga', 'k:menu')]])); }
      if (arg === 'del') { delete userRec(uid).key; saveDb(); }
      s.await = null; v = keyView(uid); return show(chat, mid, v.text, v.markup);
    }
    // ----- duel -----
    case 'dg': {
      const r = ROOMS.get(ROOM_OF.get(uid)); if (!r || r.host !== uid || r.phase !== 'lobby') return;
      if (!r.ready) return ansCb(cq.id, r.gen.err ? 'Savollar tuzilmadi: «Qayta urinish» ni bosing' : 'Savollar hali tayyor emas, biroz kuting', true);
      if (onlineOf(r).length < 2) return ansCb(cq.id, "Kamida 2 ta o'yinchi kerak. PIN ni do'stlaringizga yuboring.", true);
      return startGame(r);
    }
    case 'dgr': { const r = ROOMS.get(ROOM_OF.get(uid)); if (r && r.host === uid && r.phase === 'lobby') genRoom(r); return; }
    case 'dx': { const r = ROOMS.get(ROOM_OF.get(uid)); if (r && r.host === uid) closeRoom(r, "🚪 Xona yopildi."); return; }
    case 'dl': { leaveRoom(uid); return; }
    case 'dr': { const r = ROOMS.get(ROOM_OF.get(uid)); if (r && r.host === uid && r.phase === 'finished') rematch(r); return; }
    case 'dv': {
      const r = ROOMS.get(ROOM_OF.get(uid)), p = r && r.players.get(uid); if (!p) return ansCb(cq.id, 'Xona yopilgan', true);
      for (const m of duelReview(r, p)) await send(chat, m); return;
    }
  }
}
async function onMessage(m) {
  if (!m.from || m.from.is_bot) return;
  const uid = m.from.id, chat = m.chat.id;
  if (m.chat.type !== 'private') { if (/^\/(start|duel)/.test(m.text || '')) await send(chat, "Botdan shaxsiy chatda foydalaning 🙂"); return; }
  const s = sess(uid), text = (m.text || '').trim(); if (!text) return;
  const cm = /^\/(\w+)(?:@\w+)?\s*(.*)$/.exec(text);
  if (!cm) {
    if (s.await === 'key') { s.await = null; del(chat, m.message_id); return saveKey(chat, uid, 0, text); }
    if (s.await === 'pin') { const pin = text.replace(/\D/g, ''); s.await = null; if (/^\d{6}$/.test(pin)) return joinRoom(uid, chat, m.from, pin); s.await = 'pin'; return send(chat, "PIN 6 ta raqamdan iborat. Qayta yuboring.", menuKb); }
    if (/^\d{3}\s?\d{3}$/.test(text)) return joinRoom(uid, chat, m.from, text.replace(/\s/g, ''));
    return showHome(chat, 0, uid);
  }
  const cmd = cm[1].toLowerCase(), arg = cm[2].trim(); s.await = null;
  switch (cmd) {
    case 'start': {
      const d = /^duel_(\d{6})$/.exec(arg); if (d) return joinRoom(uid, chat, m.from, d[1]);
      return showHome(chat, 0, uid);
    }
    case 'menu': case 'cancel': { if (s.job) { try { s.job.ctl.abort(); } catch (e) {} s.job = null; } return showHome(chat, 0, uid); }
    case 'help': return send(chat, "ℹ️ <b>Yordam</b>\n\n/start — bosh menyu\n/duel — Tarixiy Duel\n/join 123456 — xonaga qo'shilish\n/leave — xonadan chiqish\n/key — AI kalitini kiritish\n/stats — natijalarim\n/cancel — bekor qilish", menuKb);
    case 'stats': return send(chat, statsText(uid), menuKb);
    case 'key': { const v = keyView(uid); return send(chat, v.text, v.markup); }
    case 'leave': { const ok = leaveRoom(uid); return send(chat, ok ? '🚪 Xonadan chiqdingiz.' : 'Siz hech qanday xonada emassiz.', menuKb); }
    case 'duel': { s.mode = 'duel'; s.step = 'grades'; const v = gradesView(s); v.markup.inline_keyboard.splice(v.markup.inline_keyboard.length - 1, 0, [btn("🔑 PIN orqali qo'shilish", 'du:join')]); return send(chat, v.text, v.markup); }
    case 'join': { const pin = arg.replace(/\D/g, ''); if (/^\d{6}$/.test(pin)) return joinRoom(uid, chat, m.from, pin); s.await = 'pin'; return send(chat, "🔑 Do'stingiz bergan 6 xonali PIN kodni yuboring.", menuKb); }
    case 'botstats': if (isAdmin(uid)) { const bk = BOOKS.map(b => { const d = bankOf(b.key).d; return `${b.key}: ${Object.values(d).reduce((a, x) => a + x.length, 0)}`; }).join(', '); return send(chat, `👥 Foydalanuvchilar: ${Object.keys(db.users).length}\n🏠 Xonalar: ${ROOMS.size}\n🏦 Bank: ${esc(bk || '—')}`); } break;
    case 'prewarm': if (isAdmin(uid)) { spawn(() => prewarm(chat, uid, arg)); return; } break;
  }
}
// Admin: kitob bo'yicha savollar bankini oldindan to'ldiradi (keyin testlar bir zumda chiqadi)
async function prewarm(chat, uid, arg) {
  const [bk, lv = 'orta', per = '12'] = arg.split(/\s+/);
  if (!BOOKS.some(b => b.key === bk) || !LEVEL_UI[lv]) return send(chat, "Foydalanish: /prewarm 7u orta 12\n(kitob: " + BOOKS.map(b => b.key).join(', ') + '; daraja: orta, yuqori, master)');
  const book = loadBook(bk), key = aiKeyOf(uid) || CFG.geminiKey, m = await send(chat, `⏳ ${bk} (${lv}) bankini to'ldirish boshlandi…`);
  let total = 0;
  for (let i = 0; i < book.topics.length; i++) {
    const t = book.topics[i], have = (bankOf(bk).d[t.n + '|' + lv] || []);
    if (have.length >= +per) continue;
    try {
      const g = await generateQuestions(key, lv, [t], +per - have.length, { avoid: have.map(x => x.q) });
      addToBank(bk, lv, g.all); total += g.all.filter(x => x.verified).length;
    } catch (e) { if (fatal(e)) { await edit(chat, m.message_id, '❌ ' + esc(errText(e))); return; } }
    await edit(chat, m.message_id, `⏳ ${bk} (${lv}): ${i + 1}/${book.topics.length} mavzu, +${total} savol`).catch(() => {});
  }
  flushAll();
  await edit(chat, m.message_id, `✅ ${bk} (${lv}) tayyor: +${total} ta tasdiqlangan savol bankka qo'shildi.`);
}

/* =====================================================================
   ISHGA TUSHIRISH
   ===================================================================== */
const locks = new Map();
function withLock(uid, fn) {
  const prev = locks.get(uid) || Promise.resolve();
  const next = prev.then(fn).catch(e => log('XATO', (e && e.stack) || e));
  locks.set(uid, next); next.then(() => { if (locks.get(uid) === next) locks.delete(uid); });
}
function handle(u) {
  if (u.callback_query) withLock(u.callback_query.from.id, () => onCallback(u.callback_query));
  else if (u.message) withLock(u.message.from ? u.message.from.id : 0, () => onMessage(u.message));
}
async function main() {
  if (!CFG.token) { console.error("BOT_TOKEN topilmadi. .env fayliga BOT_TOKEN=... yozing."); process.exit(1); }
  const me = await tg('getMe'); BOT_NAME = me.username;
  await tg('setMyCommands', { commands: [{ command: 'start', description: 'Bosh menyu' }, { command: 'duel', description: 'Tarixiy Duel' }, { command: 'join', description: "Xonaga qo'shilish (PIN)" }, { command: 'key', description: 'AI kalitini kiritish' }, { command: 'stats', description: 'Natijalarim' }, { command: 'leave', description: 'Xonadan chiqish' }, { command: 'help', description: 'Yordam' }] }).catch(() => {});
  log(`@${BOT_NAME} ishga tushdi · darsliklar: ${BOOKS.map(b => b.key).join(', ') || "YO'Q"} · parallel generatsiya: ${CFG.conc} · umumiy AI kalit: ${CFG.geminiKey ? 'bor' : "yo'q"}`);
  let offset = 0;
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      for (const u of ups) { offset = u.update_id + 1; handle(u); }
    } catch (e) { log('getUpdates xato:', e.message); await sleep(2000); }
  }
}
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });
process.on('unhandledRejection', e => log('unhandledRejection', (e && e.stack) || e));
main();