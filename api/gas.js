'use strict';
/**
 * Vercel serverless gateway: เบราว์เซอร์ -> /api -> (ลงลายเซ็น HMAC) -> Google Apps Script web app
 * - ตรวจ Origin (same-origin), allow-list เมธอด, จำกัดขนาดคำขอ
 * - คำนวณ PBKDF2-SHA256 600,000 รอบที่นี่ (GAS คำนวณเองช้ามาก)
 * - รับไฟล์ multipart แล้วแปลงเป็น base64 ส่งต่อ
 */
const crypto = require('crypto');
const zlib = require('zlib');

const ALLOWED = new Set(['ping', 'getPublicConfig', 'login', 'loginGoogle', 'register', 'requestPasswordReset', 'resetPassword', 'logout', 'api']);
const MAX_JSON = 1.5 * 1024 * 1024;
const MAX_MULTIPART = 4.4 * 1024 * 1024;   // Vercel จำกัด body ฟังก์ชันที่ 4.5 MB ไฟล์ใหญ่กว่านี้หน้าเว็บแบ่งส่วนส่ง
const ROUNDS = 600000;
const GAS_TIMEOUT = 55000;

class GwError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.rawBody)) return resolve(req.rawBody);
    const chunks = []; let size = 0, done = false, tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { tooBig = true; chunks.length = 0; return; }   // อ่านทิ้งจนจบ แล้วตอบ 413
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (tooBig) reject(new GwError(413, 'E_SIZE', 'ข้อมูลที่ส่งมีขนาดใหญ่เกินกำหนด'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) throw new GwError(403, 'E_ORIGIN', 'ไม่อนุญาตคำขอจากแหล่งนี้');
  let host;
  try { host = new URL(origin).host; } catch { throw new GwError(403, 'E_ORIGIN', 'ไม่อนุญาตคำขอจากแหล่งนี้'); }
  const self = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const extra = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (host !== self && !extra.includes(origin)) throw new GwError(403, 'E_ORIGIN', 'ไม่อนุญาตคำขอจากแหล่งนี้');
}

/** JSON ที่มีแต่ ASCII (escape \uXXXX) เพื่อให้ HMAC ฝั่ง GAS ตรงกันแน่นอน */
function asciiJson(o) {
  return JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function callGas(m, p) {
  const url = process.env.GAS_URL, secret = process.env.GAS_BRIDGE_SECRET;
  if (!url || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(url)) throw new GwError(500, 'E_CONFIG', 'ยังไม่ได้ตั้งค่า GAS_URL บน Vercel');
  if (!secret || secret.length < 32) throw new GwError(500, 'E_CONFIG', 'GAS_BRIDGE_SECRET ต้องยาวอย่างน้อย 32 ตัวอักษร');
  const b = asciiJson({ m, p, ts: Date.now(), n: crypto.randomBytes(16).toString('hex') });
  const s = crypto.createHmac('sha256', secret).update(b).digest('hex');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GAS_TIMEOUT);
  let r, text;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ b, s }), redirect: 'follow', signal: ctrl.signal });
    text = await r.text();
  } catch (e) {
    throw new GwError(504, 'E_GAS', e.name === 'AbortError' ? 'เซิร์ฟเวอร์ตอบช้าเกินไป กรุณาลองใหม่' : 'เชื่อมต่อ Apps Script ไม่ได้');
  } finally { clearTimeout(timer); }
  if (!r.ok) throw new GwError(502, 'E_GAS', 'Apps Script ตอบกลับผิดปกติ (HTTP ' + r.status + ')');
  let j;
  try { j = JSON.parse(text); } catch {
    throw new GwError(502, 'E_GAS', 'Apps Script ไม่ได้ตอบเป็น JSON — ตรวจว่า Deploy แบบ "Anyone" และ GAS_URL ลงท้าย /exec');
  }
  if (j.z) {
    const ms = j.ms;
    j = JSON.parse(zlib.gunzipSync(Buffer.from(j.z, 'base64')).toString('utf8'));
    j.ms = j.ms || ms;
  }
  if (!j.ok) {
    const e = new GwError(200, (j.error && j.error.code) || 'E_SERVER', (j.error && j.error.message) || 'เกิดข้อผิดพลาด');
    e.gasMs = j.ms; throw e;
  }
  return { data: j.data, ms: j.ms };
}

function pbkdf2(password, saltHex, rounds) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(password).normalize('NFC'), Buffer.from(saltHex, 'hex'), rounds, 32, 'sha256', (e, k) => (e ? reject(e) : resolve(k.toString('hex'))));
  });
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new GwError(200, 'E_INPUT', 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  if (pw.length > 128) throw new GwError(200, 'E_INPUT', 'รหัสผ่านยาวเกิน 128 ตัวอักษร');
  if (!/[0-9]/.test(pw) || !/[^0-9]/.test(pw)) throw new GwError(200, 'E_INPUT', 'รหัสผ่านต้องมีทั้งตัวเลขและตัวอักษร');
}
async function hashNew(pw) {
  checkPassword(pw);
  const salt = crypto.randomBytes(16).toString('hex');
  return { hash: await pbkdf2(pw, salt, ROUNDS), salt, rounds: ROUNDS };
}
function ctxRounds(c) {
  const r = Number(c.rounds);
  if (!/^[0-9a-f]{32}$/.test(String(c.salt)) || !(r >= 100000 && r <= 5000000)) throw new GwError(502, 'E_GAS', 'ข้อมูลบัญชีไม่ถูกต้อง');
  return r;
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new GwError(400, 'E_INPUT', 'รูปแบบการอัปโหลดไม่ถูกต้อง');
  const delim = Buffer.from('--' + (m[1] || m[2]));
  const parts = {};
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    pos += delim.length;
    if (buf[pos] === 45 && buf[pos + 1] === 45) break;
    pos += 2;
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const head = buf.slice(pos, headEnd).toString('utf8');
    const next = buf.indexOf(delim, headEnd + 4);
    if (next < 0) break;
    const body = buf.slice(headEnd + 4, next - 2);
    const name = /name="([^"]*)"/i.exec(head);
    const filename = /filename="([^"]*)"/i.exec(head);
    if (name) parts[name[1]] = filename ? { filename: filename[1], data: body } : body.toString('utf8');
    pos = next;
  }
  return parts;
}

async function verifyGoogle(credential) {
  if (typeof credential !== 'string' || credential.length > 4096) throw new GwError(200, 'E_LOGIN', 'ข้อมูล Google ไม่ถูกต้อง');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) throw new GwError(200, 'E_LOGIN', 'ยืนยันตัวตนกับ Google ไม่สำเร็จ');
  const t = await r.json();
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(t.iss) || Number(t.exp) * 1000 < Date.now()) {
    throw new GwError(200, 'E_LOGIN', 'ยืนยันตัวตนกับ Google ไม่สำเร็จ');
  }
  return { sub: t.sub, email: t.email, aud: t.aud, emailVerified: t.email_verified === true || t.email_verified === 'true' };
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '').trim();
}

async function handle(req) {
  const ct = String(req.headers['content-type'] || '');
  let body;
  if (ct.startsWith('multipart/form-data')) {
    const parts = parseMultipart(await readBody(req, MAX_MULTIPART), ct);
    let meta;
    try { meta = JSON.parse(parts.meta || '{}'); } catch { throw new GwError(400, 'E_INPUT', 'ข้อมูลอัปโหลดไม่ถูกต้อง'); }
    if (!parts.file || !parts.file.data || !parts.file.data.length) throw new GwError(400, 'E_INPUT', 'ไม่พบไฟล์');
    body = {
      method: 'api', token: meta.token, requestId: meta.requestId, rev: meta.rev, action: 'uploadFile',
      payload: { entity: meta.entity, entityId: meta.entityId, name: meta.name || parts.file.filename, part: meta.part, parts: meta.parts, uploadId: meta.uploadId, data: parts.file.data.toString('base64') }
    };
  } else {
    const raw = await readBody(req, MAX_JSON);
    try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw new GwError(400, 'E_INPUT', 'คำขอไม่ถูกต้อง'); }
  }
  const method = String(body.method || '');
  if (!ALLOWED.has(method)) throw new GwError(400, 'E_INPUT', 'ไม่อนุญาตคำสั่งนี้');
  const p = body.payload && typeof body.payload === 'object' ? body.payload : {};

  switch (method) {
    case 'ping':
    case 'getPublicConfig':
      return callGas(method, {});
    case 'login': {
      const identifier = String(p.identifier || '').trim().slice(0, 120);
      if (!identifier || typeof p.password !== 'string' || !p.password) throw new GwError(200, 'E_INPUT', 'กรุณากรอกอีเมล/เบอร์โทร และรหัสผ่าน');
      if (p.password.length > 128) throw new GwError(200, 'E_LOGIN', 'อีเมล/เบอร์โทร หรือรหัสผ่านไม่ถูกต้อง');
      const c = await callGas('authContext', { identifier });
      const derived = await pbkdf2(p.password, c.data.salt, ctxRounds(c.data));
      const r = await callGas('login', { identifier, derived });
      r.ms = (c.ms || 0) + (r.ms || 0);
      return r;
    }
    case 'loginGoogle':
      return callGas('loginGoogle', await verifyGoogle(p.credential));
    case 'register': {
      const pw = await hashNew(p.password);
      return callGas('register', { name: p.name, email: p.email, phone: p.phone, department: p.department, pw, ip: clientIp(req) });
    }
    case 'requestPasswordReset':
      return callGas('requestPasswordReset', { identifier: String(p.identifier || '').slice(0, 120), ip: clientIp(req), origin: 'https://' + String(req.headers['x-forwarded-host'] || req.headers.host || '') });
    case 'resetPassword':
      return callGas('resetPassword', { token: String(p.token || ''), pw: await hashNew(p.password) });
    case 'logout':
      return callGas('logout', { token: String(body.token || p.token || '') });
    case 'api': {
      const action = String(body.action || '');
      if (!/^[a-zA-Z]{2,40}$/.test(action)) throw new GwError(400, 'E_INPUT', 'คำสั่งไม่ถูกต้อง');
      const token = String(body.token || '');
      let payload = p;
      if (action === 'changePassword') {
        if (typeof p.current !== 'string' || !p.current) throw new GwError(200, 'E_INPUT', 'กรุณากรอกรหัสผ่านปัจจุบัน');
        const c = await callGas('authContext', { token });
        payload = { currentDerived: await pbkdf2(p.current.slice(0, 128), c.data.salt, ctxRounds(c.data)), pw: await hashNew(p.next) };
      } else if ((action === 'saveUser' || action === 'setTempPassword') && typeof p.password === 'string' && p.password) {
        payload = Object.assign({}, p, { pw: await hashNew(p.password) });
        delete payload.password;
      }
      return callGas('api', { token, action, payload, requestId: String(body.requestId || '').slice(0, 64), rev: String(body.rev || '').slice(0, 40) });
    }
  }
  throw new GwError(400, 'E_INPUT', 'ไม่อนุญาตคำสั่งนี้');
}

function send(req, res, status, obj) {
  let buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (buf.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    buf = zlib.gzipSync(buf, { level: 6 });
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
  }
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new GwError(405, 'E_METHOD', 'ใช้ได้เฉพาะ POST'); }
    checkOrigin(req);
    const r = await handle(req);
    send(req, res, 200, { ok: true, data: r.data, ms: { gas: r.ms || 0, total: Date.now() - t0 } });
  } catch (e) {
    const known = e instanceof GwError;
    if (!known) console.error(e);
    send(req, res, known ? e.status : 500, {
      ok: false, error: { code: known ? e.code : 'E_GATEWAY', message: known ? e.message : 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่' },
      ms: { gas: e.gasMs || 0, total: Date.now() - t0 }
    });
  }
};
module.exports._test = { parseMultipart, asciiJson, pbkdf2 };
