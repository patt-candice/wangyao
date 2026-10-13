/**
 * วังยาว • ทะเบียนสิ่งของ ซ่อม ยืมคืน — Backend (Google Apps Script, V8 runtime)
 *
 * โครงสร้างไฟล์
 *  1) ค่าคงที่ + โครงตาราง
 *  2) ยูทิลิตี้ / crypto (PBKDF2 แบบ pure JS ใช้เฉพาะเมนูตั้งรหัสเจ้าของ)
 *  3) Snapshot cache (CacheService, gzip+base64, แยก chunk ต่อตาราง, STATE_REV)
 *  4) Db (อ่านจาก snapshot, เขียนแบบตรวจ drift + write-ahead journal)
 *  5) Auth / Session / Rate limit
 *  6) Actions ทั้งหมด
 *  7) Web app entry (doPost) + ตรวจลายเซ็น gateway
 *  8) Triggers / Notifications / Cleanup
 *  9) setupDatabase + เมนูใน Google Sheet
 */

// ============================================================ 1) ค่าคงที่
var APP_VERSION = '1.0.0';
var TZ = 'Asia/Bangkok';
var SESSION_MS = 10 * 3600 * 1000;
var SNAP_TTL = 21600;              // 6 ชม. (สูงสุดของ CacheService)
var CHUNK = 90000;                 // อักขระต่อ chunk
var PBKDF2_ROUNDS = 600000;
var OP_TTL = 21600;
var FILE_PART = 2500000;           // ไบต์ต่อส่วน (Vercel จำกัด body 4.5 MB)
var MAX_FILE = 5 * 1024 * 1024;
var MAX_IMAGE = 600 * 1024;

var BASE_COLS = ['id', 'owner', 'createdAt', 'updatedAt', 'updatedBy', 'version'];
var SCHEMA = {
  Users: ['name', 'email', 'phone', 'role', 'status', 'department', 'passwordHash', 'passwordSalt', 'passwordRounds', 'googleSub', 'mustChangePassword'],
  Roles: ['name', 'seeFinance', 'registerAssets', 'assignWork', 'inspectWork', 'active'],
  Locations: ['name', 'parent', 'kind', 'active'],
  Options: ['kind', 'label', 'aliases', 'active', 'sortOrder'],
  Items: ['name', 'group', 'trackingMode', 'unit', 'active'],
  Assets: ['code', 'item', 'batch', 'name', 'brand', 'group', 'type', 'qty', 'unit', 'price', 'year', 'purchase', 'received', 'location', 'condition', 'responsible', 'serial', 'note', 'loan'],
  Movements: ['asset', 'destinationAsset', 'batch', 'item', 'name', 'qty', 'from', 'to', 'at', 'note', 'kind', 'reference'],
  Repairs: ['code', 'asset', 'qty', 'reportedLocation', 'assigned', 'status', 'issue', 'created', 'due', 'approved'],
  RepairAssessments: ['repair', 'fixable', 'estimate', 'days', 'note', 'at'],
  RepairNotes: ['repair', 'text', 'at', 'kind', 'fromUser', 'toUser'],
  RepairCosts: ['repair', 'amount', 'kind', 'at', 'note'],
  BudgetRevisions: ['repair', 'old', 'amount', 'direction', 'reason', 'at', 'status', 'approvedBy', 'approvedAt', 'decisionNote'],
  Approvals: ['entity', 'entityId', 'decision', 'amount', 'reason', 'at'],
  Loans: ['code', 'borrower', 'phone', 'responsible', 'start', 'due', 'destination', 'status', 'note'],
  LoanLines: ['loan', 'asset', 'original', 'qty', 'returned', 'origin'],
  LoanReturns: ['loan', 'line', 'asset', 'destinationAsset', 'qty', 'to', 'condition', 'at', 'note'],
  Disposals: ['code', 'asset', 'disposedAsset', 'qty', 'reason', 'note', 'status', 'created', 'approvedBy', 'approvedAt', 'approvalNote'],
  Files: ['entity', 'entityId', 'driveId', 'name', 'mime', 'size', 'at'],
  Settings: ['key', 'value'],
  AuditLogs: ['day', 'action', 'entity', 'detail', 'before', 'after', 'at'],
  Notifications: ['channel', 'event', 'entity', 'message', 'status', 'attempts', 'nextAttempt', 'lastError', 'sentAt', 'claim', 'retryKey'],
  Sessions: ['tokenHash', 'user', 'expiresAt', 'revokedAt'],
  AuthTokens: ['tokenHash', 'user', 'purpose', 'expiresAt', 'usedAt'],
  Operations: ['requestId', 'fingerprint', 'action', 'status', 'changes', 'result', 'committedAt']
};
var WORK_TABLES = ['Users', 'Roles', 'Locations', 'Options', 'Items', 'Assets', 'Movements', 'Repairs', 'RepairAssessments',
  'RepairNotes', 'RepairCosts', 'BudgetRevisions', 'Approvals', 'Loans', 'LoanLines', 'LoanReturns', 'Disposals', 'Files', 'Settings'];
var WINDOW_TABLES = { AuditLogs: 600, Notifications: 300 };
var RAW_TABLES = ['Sessions', 'AuthTokens', 'Operations'];
var SNAP_TABLES = WORK_TABLES.concat(Object.keys(WINDOW_TABLES));
var ID_PREFIX = {
  Users: 'U', Roles: 'R', Locations: 'L', Options: 'O', Items: 'I', Assets: 'A', Movements: 'MV', Repairs: 'RP',
  RepairAssessments: 'RA', RepairNotes: 'RN', RepairCosts: 'RC', BudgetRevisions: 'BR', Approvals: 'AP', Loans: 'LN',
  LoanLines: 'LL', LoanReturns: 'LR', Disposals: 'DP', Files: 'F', Settings: 'S', AuditLogs: 'AU', Notifications: 'NT',
  Sessions: 'SS', AuthTokens: 'AT', Operations: 'OP'
};
var JSON_COLS = { aliases: 1, value: 1, before: 1, after: 1, changes: 1, result: 1 };

var CONDITIONS = ['READY', 'IN_USE', 'DAMAGED', 'REPAIRING', 'LOANED', 'PENDING_DISPOSAL', 'DISPOSED'];
var OPEN_REPAIR = { ASSESS: 1, APPROVAL: 1, REPAIR: 1, ACCEPT: 1 };

// ============================================================ 2) ยูทิลิตี้
function nowIso_() { return new Date().toISOString(); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function ymd_() { return Utilities.formatDate(new Date(), TZ, 'yyyyMMdd'); }
function err_(code, msg) { var e = new Error(msg); e.code = code; return e; }
function fail_(msg) { throw err_('E_INPUT', msg); }
function deny_(msg) { throw err_('E_PERM', msg || 'คุณไม่มีสิทธิ์ทำรายการนี้'); }
function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k) { return props_().getProperty(k); }
function setProp_(k, v) { props_().setProperty(k, v); }
function delProp_(k) { props_().deleteProperty(k); }
function cache_() { return CacheService.getScriptCache(); }
function jparse_(s, d) {
  if (s == null || s === '') return d === undefined ? null : d;
  try { return JSON.parse(s); } catch (e) { return d === undefined ? null : d; }
}
function cacheGetJ_(k) { return jparse_(cache_().get(k)); }
function cachePutJ_(k, v, ttl) { cache_().put(k, JSON.stringify(v), Math.max(1, Math.min(ttl || SNAP_TTL, 21600))); }
function hex_(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) { var b = bytes[i] & 255; s += (b < 16 ? '0' : '') + b.toString(16); }
  return s;
}
function hmacHex_(value, key) { return hex_(Utilities.computeHmacSha256Signature(value, key)); }
function sha256Hex_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function randHex_(n) { var s = ''; while (s.length < n) s += Utilities.getUuid().replace(/-/g, ''); return s.slice(0, n); }
function newId_(table) { return (ID_PREFIX[table] || 'X') + Date.now().toString(36) + randHex_(6); }
function newRev_() { return Date.now().toString(36) + randHex_(6); }
function safeEq_(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  var diff = a.length ^ b.length, n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  return diff === 0 && a.length === b.length;
}
function bool_(v) { return v === true || /^(true|1|yes|y|ใช่)$/i.test(String(v == null ? '' : v).trim()); }
function num_(v) { var n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; }
function pad_(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
function packJson_(o) {
  var s = JSON.stringify(o);
  if (s.length < 2000) return s;
  return 'z:' + Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(s, 'application/json')).getBytes());
}
function unpackJson_(s) {
  if (!s) return null;
  if (String(s).indexOf('z:') === 0) {
    return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(s.slice(2)), 'application/x-gzip')).getDataAsString('UTF-8'));
  }
  return JSON.parse(s);
}
/** ค่าที่ขึ้นต้นด้วย = + - @ ใส่ ' นำหน้ากัน formula injection */
function escCell_(v) {
  var s = v == null ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function unesc_(s) { return (s.charAt(0) === "'" && /^'[=+\-@]/.test(s)) ? s.slice(1) : s; }
function cellStr_(v) {
  if (v == null) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return unesc_(String(v));
}
function rowObj_(h, r) { var o = {}; for (var i = 0; i < h.length; i++) if (h[i]) o[h[i]] = r[i] == null ? '' : r[i]; return o; }
function objRow_(h, o) {
  var r = new Array(h.length);
  for (var i = 0; i < h.length; i++) {
    var v = h[i] ? o[h[i]] : '';
    if (v == null) v = '';
    else if (typeof v === 'object') v = JSON.stringify(v);
    else if (typeof v === 'boolean') v = v ? 'TRUE' : 'FALSE';
    r[i] = String(v);
  }
  return r;
}

// ------------------------------------------------------------ ตรวจ input
function vStr_(v, label, max, required) {
  var s = v == null ? '' : String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (required && !s) fail_('กรุณากรอก' + label);
  if (s.length > (max || 200)) fail_(label + 'ยาวเกิน ' + (max || 200) + ' ตัวอักษร');
  return s;
}
function vNum_(v, label, min, max, required) {
  if (v === '' || v == null) { if (required) fail_('กรุณากรอก' + label); return ''; }
  var n = Number(String(v).replace(/,/g, ''));
  if (!isFinite(n)) fail_(label + 'ต้องเป็นตัวเลข');
  if (min != null && n < min) fail_(label + 'ต้องไม่น้อยกว่า ' + min);
  if (max != null && n > max) fail_(label + 'ต้องไม่เกิน ' + max);
  return Math.round(n * 100) / 100;
}
function vInt_(v, label, min, max, required) {
  var n = vNum_(v, label, min, max, required);
  if (n !== '' && Math.floor(n) !== n) fail_(label + 'ต้องเป็นจำนวนเต็ม');
  return n;
}
function vDate_(v, label, required) {
  var s = vStr_(v, label, 10, required);
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s + 'T00:00:00Z').getTime())) fail_(label + 'ไม่ถูกต้อง');
  return s;
}
function vOne_(v, list, label) { if (list.indexOf(v) < 0) fail_(label + 'ไม่ถูกต้อง'); return v; }
function vEmail_(v, required) {
  var s = vStr_(v, 'อีเมล', 120, required).toLowerCase();
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail_('รูปแบบอีเมลไม่ถูกต้อง');
  return s;
}
function vPhone_(v, required) {
  var s = vStr_(v, 'เบอร์โทร', 30, required);
  var d = s.replace(/\D/g, '');
  if (s && (d.length < 9 || d.length > 15)) fail_('เบอร์โทรไม่ถูกต้อง');
  return d;
}
function vPw_(pw) {
  if (!pw || !/^[0-9a-f]{64}$/.test(pw.hash) || !/^[0-9a-f]{32}$/.test(pw.salt) || Number(pw.rounds) < 100000) fail_('รูปแบบรหัสผ่านไม่ถูกต้อง');
  return { passwordHash: pw.hash, passwordSalt: pw.salt, passwordRounds: String(Number(pw.rounds)) };
}

// ------------------------------------------------------------ PBKDF2-HMAC-SHA256 (pure JS)
var K256_ = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
var IV256_ = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

function shaCompress_(st, blk, out, W) {
  var i;
  for (i = 0; i < 16; i++) W[i] = blk[i] | 0;
  for (i = 16; i < 64; i++) {
    var x = W[i - 15], y = W[i - 2];
    var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  var a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
  for (i = 0; i < 64; i++) {
    var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256_[i] + W[i]) | 0;
    var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  out[0] = (st[0] + a) | 0; out[1] = (st[1] + b) | 0; out[2] = (st[2] + c) | 0; out[3] = (st[3] + d) | 0;
  out[4] = (st[4] + e) | 0; out[5] = (st[5] + f) | 0; out[6] = (st[6] + g) | 0; out[7] = (st[7] + h) | 0;
}
/** SHA-256 ต่อจาก state ที่ประมวลผลไปแล้ว prefixLen ไบต์ (ทวีคูณของ 64) */
function shaFrom_(state, prefixLen, bytes) {
  var total = prefixLen + bytes.length, padLen = ((bytes.length + 9 + 63) >> 6) << 6;
  var buf = new Array(padLen), i;
  for (i = 0; i < padLen; i++) buf[i] = 0;
  for (i = 0; i < bytes.length; i++) buf[i] = bytes[i] & 255;
  buf[bytes.length] = 0x80;
  var bits = total * 8;
  buf[padLen - 4] = (bits >>> 24) & 255; buf[padLen - 3] = (bits >>> 16) & 255; buf[padLen - 2] = (bits >>> 8) & 255; buf[padLen - 1] = bits & 255;
  buf[padLen - 5] = Math.floor(bits / 4294967296) & 255;
  var st = state.slice(), blk = new Array(16), W = new Array(64);
  for (var off = 0; off < padLen; off += 64) {
    for (i = 0; i < 16; i++) blk[i] = (buf[off + i * 4] << 24) | (buf[off + i * 4 + 1] << 16) | (buf[off + i * 4 + 2] << 8) | buf[off + i * 4 + 3];
    shaCompress_(st, blk, st, W);
  }
  return st;
}
function wordsToBytes_(w) { var b = []; for (var i = 0; i < w.length; i++) b.push((w[i] >>> 24) & 255, (w[i] >>> 16) & 255, (w[i] >>> 8) & 255, w[i] & 255); return b; }
function utf8Bytes_(s) { return Utilities.newBlob(String(s).normalize('NFC')).getBytes().map(function (b) { return b & 255; }); }
function hexBytes_(h) { var b = []; for (var i = 0; i < h.length; i += 2) b.push(parseInt(h.substr(i, 2), 16)); return b; }

function pbkdf2Hex_(password, saltHex, rounds) {
  var key = utf8Bytes_(password);
  if (key.length > 64) key = wordsToBytes_(shaFrom_(IV256_, 0, key));
  var ip = new Array(16), op = new Array(16), i, W = new Array(64);
  for (i = 0; i < 16; i++) {
    var w = 0, w2 = 0;
    for (var j = 0; j < 4; j++) { var kb = key[i * 4 + j] || 0; w = (w << 8) | (kb ^ 0x36); w2 = (w2 << 8) | (kb ^ 0x5c); }
    ip[i] = w; op[i] = w2;
  }
  var ist = new Array(8), ost = new Array(8);
  shaCompress_(IV256_, ip, ist, W); shaCompress_(IV256_, op, ost, W);
  var salt = hexBytes_(saltHex).concat([0, 0, 0, 1]);
  var inner = shaFrom_(ist, 64, salt);
  var blk = new Array(16); for (i = 0; i < 16; i++) blk[i] = 0;
  blk[8] = 0x80000000 | 0; blk[15] = 768;
  var U = new Array(8), T = new Array(8), tmp = new Array(8);
  for (i = 0; i < 8; i++) blk[i] = inner[i];
  shaCompress_(ost, blk, U, W);
  for (i = 0; i < 8; i++) T[i] = U[i];
  for (var r = 1; r < rounds; r++) {
    for (i = 0; i < 8; i++) blk[i] = U[i];
    shaCompress_(ist, blk, tmp, W);
    for (i = 0; i < 8; i++) blk[i] = tmp[i];
    shaCompress_(ost, blk, U, W);
    for (i = 0; i < 8; i++) T[i] ^= U[i];
  }
  return hex_(wordsToBytes_(T));
}

// ============================================================ 3) Snapshot cache
var LOCK_DEPTH_ = 0;
function withLock_(fn) {
  if (LOCK_DEPTH_ > 0) return fn();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw err_('E_BUSY', 'มีผู้ใช้บันทึกข้อมูลพร้อมกันจำนวนมาก กรุณาลองใหม่อีกครั้ง');
  LOCK_DEPTH_++;
  try { return fn(); } finally { LOCK_DEPTH_--; lock.releaseLock(); }
}

var SS_ = null, SHEETS_ = null;
function ss_() {
  if (!SS_) {
    var id = prop_('DB_ID');
    if (!id) throw err_('E_SETUP', 'ยังไม่ได้ติดตั้งฐานข้อมูล กรุณารัน setupDatabase');
    SS_ = SpreadsheetApp.openById(id);
  }
  return SS_;
}
function sheet_(name) {
  if (!SHEETS_) { SHEETS_ = {}; ss_().getSheets().forEach(function (s) { SHEETS_[s.getName()] = s; }); }
  var s = SHEETS_[name];
  if (!s) throw err_('E_SETUP', 'ไม่พบแท็บ ' + name + ' กรุณารัน setupDatabase');
  return s;
}
function headerOf_(sh) {
  var lc = sh.getLastColumn();
  if (!lc) return [];
  var h = sh.getRange(1, 1, 1, lc).getValues()[0].map(function (x) { return String(x).trim(); });
  while (h.length && !h[h.length - 1]) h.pop();
  return h;
}
function ensureRows_(sh, upto) {
  var max = sh.getMaxRows();
  if (upto > max) sh.insertRowsAfter(max, upto - max + 200);
}
/** เขียนต่อท้าย: ปกติเรียกชีตครั้งเดียว ขยายแถวเฉพาะเมื่อชนขอบชีตจริง */
function writeRows_(sh, row, values) {
  try {
    sh.getRange(row, 1, values.length, values[0].length).setValues(values);
  } catch (e) {
    if (!/out of bounds|outside the dimensions|dimensions of the sheet/i.test(String(e && e.message))) throw e;
    ensureRows_(sh, row + values.length + 500);
    sh.getRange(row, 1, values.length, values[0].length).setValues(values);
  }
}
function normRows_(values, width) {
  return values.map(function (row) {
    var r = new Array(width);
    for (var i = 0; i < width; i++) r[i] = cellStr_(row[i]);
    return r;
  });
}
function invalidate_() { setProp_('STATE_REV', newRev_()); }

/** อ่านทุกตารางในครั้งเดียว: Sheets API batchGet (เร็ว) ไม่ได้ก็ getValues() */
function readSheetsBatch_(ranges) {
  var off = Number(prop_('REST_OFF') || 0);
  if (off && Date.now() - off < 6 * 3600e3) return null;
  try {
    var id = prop_('DB_ID'), res;
    if (typeof Sheets !== 'undefined' && Sheets.Spreadsheets && Sheets.Spreadsheets.Values) {
      res = Sheets.Spreadsheets.Values.batchGet(id, { ranges: ranges, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' });
    } else {
      var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values:batchGet?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS&' +
        ranges.map(function (r) { return 'ranges=' + encodeURIComponent(r); }).join('&');
      var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) throw new Error('HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200));
      res = JSON.parse(resp.getContentText());
    }
    return (res.valueRanges || []).map(function (vr) { return vr.values || []; });
  } catch (e) {
    console.warn('Sheets API ใช้ไม่ได้ ใช้ getValues แทน: ' + e.message);
    setProp_('REST_OFF', String(Date.now()));
    return null;
  }
}

function readAllFromSheets_() {
  var snap = { t: {}, raw: {}, at: Date.now() };
  var ranges = WORK_TABLES.map(function (n) { return "'" + n + "'"; })
    .concat(RAW_TABLES.concat(Object.keys(WINDOW_TABLES)).map(function (n) { return "'" + n + "'!1:1"; }));
  var vals = readSheetsBatch_(ranges);
  WORK_TABLES.forEach(function (n, i) {
    var v = vals ? vals[i] : null;
    if (!v) { var sh = sheet_(n); v = sh.getDataRange().getValues(); }
    if (!v.length || !v[0].length) throw err_('E_SETUP', 'แท็บ ' + n + ' ไม่มีหัวคอลัมน์ กรุณารัน setupDatabase');
    var h = v[0].map(function (x) { return String(x).trim(); });
    while (h.length && !h[h.length - 1]) h.pop();
    if (h.indexOf('id') < 0) throw err_('E_SETUP', 'แท็บ ' + n + ' ไม่มีคอลัมน์ id');
    snap.t[n] = { h: h, r: normRows_(v.slice(1), h.length), s: 2, last: v.length };
  });
  RAW_TABLES.forEach(function (n, i) {
    var v = vals ? vals[WORK_TABLES.length + i] : null;
    var h = v && v[0] ? v[0].map(function (x) { return String(x).trim(); }) : headerOf_(sheet_(n));
    while (h.length && !h[h.length - 1]) h.pop();
    snap.raw[n] = h;
  });
  Object.keys(WINDOW_TABLES).forEach(function (n, i) {
    var sh = sheet_(n);
    var hv = vals ? vals[WORK_TABLES.length + RAW_TABLES.length + i] : null;
    var h = hv && hv[0] ? hv[0].map(function (x) { return String(x).trim(); }) : headerOf_(sh);
    while (h.length && !h[h.length - 1]) h.pop();
    var last = Math.max(1, sh.getLastRow());
    var start = Math.max(2, last - WINDOW_TABLES[n] + 1);
    var rows = last >= start ? sh.getRange(start, 1, last - start + 1, h.length).getValues() : [];
    snap.t[n] = { h: h, r: normRows_(rows, h.length), s: start, last: last };
  });
  return snap;
}

function encodeTable_(t) {
  return Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(t), 'application/json')).getBytes());
}
function decodeTable_(s) {
  return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(s), 'application/x-gzip')).getDataAsString('UTF-8'));
}
function chunkKey_(name, k, i) { return 'ST:' + name + ':' + k + ':' + i; }

/** บันทึก snapshot ลงแคช: เขียนใหม่เฉพาะตารางใน names (หรือทั้งหมด) */
function saveSnapshot_(snap, names) {
  var put = {}, oldKeys = [];
  snap.k = snap.k || {};
  (names || SNAP_TABLES).forEach(function (n) {
    var enc = encodeTable_(snap.t[n]), k = randHex_(8), cnt = Math.max(1, Math.ceil(enc.length / CHUNK));
    var prev = snap.k[n];
    if (prev) for (var j = 0; j < prev.n; j++) oldKeys.push(chunkKey_(n, prev.k, j));
    for (var i = 0; i < cnt; i++) put[chunkKey_(n, k, i)] = enc.substr(i * CHUNK, CHUNK);
    snap.k[n] = { k: k, n: cnt };
  });
  put['SN:meta'] = JSON.stringify({ rev: snap.rev, at: snap.at, saved: Date.now(), k: snap.k, raw: snap.raw });
  var c = cache_();
  var keys = Object.keys(put), batch = {}, size = 0;
  // putAll ทีละประมาณ 900 KB เพื่อไม่ชนขีดจำกัดต่อคำขอ
  keys.forEach(function (key) {
    if (key === 'SN:meta') return;
    batch[key] = put[key]; size += put[key].length;
    if (size > 900000) { c.putAll(batch, SNAP_TTL); batch = {}; size = 0; }
  });
  batch['SN:meta'] = put['SN:meta'];
  c.putAll(batch, SNAP_TTL);
  return oldKeys;
}

function tryLoadCached_(rev) {
  var c = cache_(), meta = jparse_(c.get('SN:meta'));
  if (!meta || meta.rev !== rev || !meta.k) return null;
  var keys = [];
  SNAP_TABLES.forEach(function (n) {
    var m = meta.k[n]; if (!m) { keys = null; return; }
    if (keys) for (var i = 0; i < m.n; i++) keys.push(chunkKey_(n, m.k, i));
  });
  if (!keys) return null;
  var got = c.getAll(keys);
  var snap = { rev: meta.rev, at: meta.at, saved: meta.saved, k: meta.k, raw: meta.raw, t: {} };
  for (var ti = 0; ti < SNAP_TABLES.length; ti++) {
    var n = SNAP_TABLES[ti], m = meta.k[n], s = '';
    for (var i = 0; i < m.n; i++) { var v = got[chunkKey_(n, m.k, i)]; if (v == null) return null; s += v; }
    snap.t[n] = decodeTable_(s);
  }
  return snap;
}

var SNAP_LOCAL_ = null;
/** อ่าน snapshot โดยไม่เปิด Spreadsheet; ไม่มี/เวอร์ชันไม่ตรงจึงสร้างใหม่ภายใต้ lock */
function loadSnapshot_() {
  for (var attempt = 0; attempt < 2; attempt++) {
    var rev = prop_('STATE_REV');
    if (!rev) break;
    if (SNAP_LOCAL_ && SNAP_LOCAL_.rev === rev && !SNAP_LOCAL_.dirty) return SNAP_LOCAL_;
    var snap = tryLoadCached_(rev);
    if (snap && prop_('STATE_REV') === rev) { SNAP_LOCAL_ = snap; return snap; } // กัน torn read
  }
  return rebuildSnapshot_();
}

function rebuildSnapshot_() {
  return withLock_(function () {
    recoverPending_();
    var rev = prop_('STATE_REV');
    if (rev) {
      var again = tryLoadCached_(rev);
      if (again && prop_('STATE_REV') === rev) { SNAP_LOCAL_ = again; return again; }
    } else { rev = newRev_(); setProp_('STATE_REV', rev); }
    var t0 = Date.now();
    var oldMeta = cacheGetJ_('SN:meta');
    var snap = readAllFromSheets_();     // อ่าน rev ก่อนอ่านชีต: ถ้ามีคนแก้ชีตระหว่างนี้ rev จะไม่ตรงและสร้างใหม่รอบหน้า
    snap.rev = rev;
    saveSnapshot_(snap);
    if (oldMeta && oldMeta.k) {
      var keys = [];
      Object.keys(oldMeta.k).forEach(function (n) { for (var i = 0; i < oldMeta.k[n].n; i++) keys.push(chunkKey_(n, oldMeta.k[n].k, i)); });
      try { cache_().removeAll(keys); } catch (e) { }
    }
    console.log('สร้าง snapshot ใหม่ ' + (Date.now() - t0) + ' ms');
    SNAP_LOCAL_ = snap;
    return snap;
  });
}

/** หลังเขียนชีตสำเร็จ: แพตช์เฉพาะตารางที่เปลี่ยน แล้วเลื่อน STATE_REV */
function publish_(snap, changed) {
  snap.rev = newRev_();
  var old = saveSnapshot_(snap, changed);
  setProp_('STATE_REV', snap.rev);
  if (old.length) try { cache_().removeAll(old); } catch (e) { }
  snap.dirty = false;
  SNAP_LOCAL_ = snap;
  return snap.rev;
}

// ============================================================ 4) Db
function Db_(snap, uid) {
  this.snap = snap; this.uid = uid || ''; this.objs = {}; this.idx = {}; this.ch = {}; this.raw = []; this.bumped = {}; this.after = [];
}
Db_.prototype.table = function (name) {
  var t = this.snap.t[name];
  if (!t) throw err_('E_SETUP', 'ไม่พบตาราง ' + name);
  return t;
};
Db_.prototype.rows = function (name) {
  var o = this.objs[name];
  if (!o) {
    var t = this.table(name), idc = t.h.indexOf('id');
    o = [];
    for (var i = 0; i < t.r.length; i++) {
      if (!t.r[i][idc]) continue;
      var x = rowObj_(t.h, t.r[i]);
      Object.defineProperty(x, '_i', { value: i, enumerable: false, writable: true });
      o.push(x);
    }
    this.objs[name] = o;
  }
  return o;
};
Db_.prototype.get = function (name, id) {
  if (!id) return null;
  var m = this.idx[name];
  if (!m) { m = {}; this.rows(name).forEach(function (x) { m[x.id] = x; }); this.idx[name] = m; }
  return m[id] || null;
};
Db_.prototype.must = function (name, id, label) {
  var x = this.get(name, id);
  if (!x) throw err_('E_NOTFOUND', 'ไม่พบ' + (label || 'ข้อมูล') + ' อาจถูกลบหรือแก้ไขแล้ว กรุณาโหลดใหม่');
  return x;
};
Db_.prototype.me = function () { return this.get('Users', this.uid); };
Db_.prototype.chg_ = function (name) {
  this.snap.dirty = true;
  return this.ch[name] || (this.ch[name] = { upd: {}, ins: {} });
};
Db_.prototype.insert = function (name, obj) {
  var t = this.table(name), now = nowIso_(), x = {};
  for (var k in obj) x[k] = obj[k];
  x.id = x.id || newId_(name);
  x.owner = x.owner || this.uid || 'system';
  x.createdAt = x.createdAt || now; x.updatedAt = now; x.updatedBy = this.uid || 'system'; x.version = 1;
  var arr = objRow_(t.h, x);
  t.r.push(arr);
  var i = t.r.length - 1, o = rowObj_(t.h, arr);
  Object.defineProperty(o, '_i', { value: i, enumerable: false, writable: true });
  this.rows(name).push(o);
  this.get(name, o.id); this.idx[name][o.id] = o;
  this.chg_(name).ins[i] = true;
  this.bumped[name + ':' + o.id] = true;
  return o;
};
Db_.prototype.update = function (name, id, patch, expectVersion) {
  var o = this.must(name, id);
  if (expectVersion != null && expectVersion !== '' && String(o.version) !== String(expectVersion)) {
    throw err_('E_VERSION', 'ข้อมูลถูกแก้ไขแล้ว กรุณาโหลดใหม่');
  }
  var t = this.table(name);
  for (var k in patch) if (k !== 'id' && k !== '_i') o[k] = patch[k];
  var key = name + ':' + id;
  if (!this.bumped[key]) { o.version = Number(o.version || 0) + 1; this.bumped[key] = true; }
  o.updatedAt = nowIso_(); o.updatedBy = this.uid || 'system';
  t.r[o._i] = objRow_(t.h, o);
  var norm = rowObj_(t.h, t.r[o._i]);
  for (var k2 in norm) o[k2] = norm[k2];
  this.chg_(name).upd[o._i] = true;
  return o;
};
/** แถวสำหรับตารางนอก snapshot (Sessions/AuthTokens) ต่อท้ายตอน commit */
Db_.prototype.appendRaw = function (name, obj) {
  var now = nowIso_(), x = { id: newId_(name), owner: this.uid || 'system', createdAt: now, updatedAt: now, updatedBy: this.uid || 'system', version: 1 };
  for (var k in obj) x[k] = obj[k];
  this.raw.push({ name: name, obj: x });
  this.snap.dirty = true;
  return x;
};
Db_.prototype.audit = function (action, entity, entityId, detail, before, after) {
  this.insert('AuditLogs', {
    day: today_(), action: action, entity: entity + (entityId ? ':' + entityId : ''), detail: String(detail || '').slice(0, 500),
    before: before ? auditJson_(before) : '', after: after ? auditJson_(after) : '', at: nowIso_()
  });
};
function auditJson_(o) {
  var c = {};
  for (var k in o) if (!/password|token|hash|salt|secret/i.test(k)) c[k] = o[k];
  var s = JSON.stringify(c);
  return s.length > 8000 ? s.slice(0, 8000) : s;
}
Db_.prototype.dirty = function () { return Object.keys(this.ch).length > 0 || this.raw.length > 0; };
Db_.prototype.setting = function (key, def) {
  var s = this.get('Settings', 'S_' + key);
  if (!s) return def;
  var v = jparse_(s.value, undefined);
  return v === undefined ? def : v;
};

/** เขียนการเปลี่ยนแปลงลงชีต: ตรวจ drift -> journal PREPARED -> เขียนจริง -> COMMITTED -> flush */
function commit_(db, j) {
  var names = Object.keys(db.ch);
  var plans = names.map(function (name) {
    var t = db.snap.t[name], c = db.ch[name], sh = sheet_(name);
    var last = sh.getLastRow();
    if (last !== t.last) throw err_('E_DRIFT', name + ' lastRow ' + last + ' != ' + t.last);
    var idc = t.h.indexOf('id');
    var upd = Object.keys(c.upd).map(Number).filter(function (i) { return !c.ins[i]; }).sort(function (a, b) { return a - b; });
    if (upd.length) {
      var rows = upd.map(function (i) { return t.s + i; }), lo = rows[0], hi = rows[rows.length - 1], ids;
      if (hi - lo < 400) {
        var v = sh.getRange(lo, idc + 1, hi - lo + 1, 1).getValues();
        ids = rows.map(function (r) { return cellStr_(v[r - lo][0]); });
      } else ids = rows.map(function (r) { return cellStr_(sh.getRange(r, idc + 1).getValue()); });
      for (var q = 0; q < rows.length; q++) if (ids[q] !== t.r[upd[q]][idc]) throw err_('E_DRIFT', name + ' row ' + rows[q]);
    }
    var ins = Object.keys(c.ins).map(Number).sort(function (a, b) { return a - b; });
    if (ins.length && t.s + ins[0] !== t.last + 1) throw err_('E_DRIFT', name + ' insert position');
    return { name: name, t: t, sh: sh, upd: upd, ins: ins };
  });

  var opSh = null, opRow = 0, op = null, oh = db.snap.raw.Operations;
  if (j.journal && plans.length) {
    var ch = {};
    plans.forEach(function (p) {
      ch[p.name] = { h: p.t.h, u: p.upd.map(function (i) { return p.t.r[i]; }), i: p.ins.map(function (i) { return p.t.r[i]; }) };
    });
    var packed = packJson_(ch);
    if (packed.length > 49000) throw err_('E_INPUT', 'รายการนี้มีข้อมูลมากเกินไป กรุณาแบ่งบันทึกเป็นหลายครั้ง');
    opSh = sheet_('Operations');
    opRow = opSh.getLastRow() + 1;
    var now = nowIso_();
    op = { id: newId_('Operations'), owner: db.uid || 'system', createdAt: now, updatedAt: now, updatedBy: db.uid || 'system', version: 1,
      requestId: j.requestId || '', fingerprint: j.fingerprint || '', action: j.action || '', status: 'PREPARED', changes: packed, result: '', committedAt: '' };
    writeRows_(opSh, opRow, [objRow_(oh, op).map(escCell_)]);
    setProp_('PEND', JSON.stringify({ row: opRow, id: op.id }));
  }

  plans.forEach(function (p) {
    p.upd.forEach(function (i) { p.sh.getRange(p.t.s + i, 1, 1, p.t.h.length).setValues([p.t.r[i].map(escCell_)]); });
    if (p.ins.length) writeRows_(p.sh, p.t.last + 1, p.ins.map(function (i) { return p.t.r[i].map(escCell_); }));
    p.t.last = p.t.s + p.t.r.length - 1;
    var win = WINDOW_TABLES[p.name];
    if (win && p.t.r.length > win) { var drop = p.t.r.length - win; p.t.r.splice(0, drop); p.t.s += drop; }
  });

  var byRaw = {};
  db.raw.forEach(function (x) { (byRaw[x.name] = byRaw[x.name] || []).push(x.obj); });
  Object.keys(byRaw).forEach(function (name) {
    var sh = sheet_(name), h = db.snap.raw[name];
    writeRows_(sh, sh.getLastRow() + 1, byRaw[name].map(function (o) { return objRow_(h, o).map(escCell_); }));
  });

  if (op) {
    op.status = 'COMMITTED'; op.committedAt = nowIso_(); op.result = '{"ok":true}';
    opSh.getRange(opRow, 1, 1, oh.length).setValues([objRow_(oh, op).map(escCell_)]);
  }
  SpreadsheetApp.flush();
  if (op) delProp_('PEND');
}

/** กู้คืนรายการที่ค้าง (GAS ตายกลางการบันทึก) จาก Operations */
function recoverPending_() {
  if (!prop_('PEND')) return false;
  return withLock_(function () {
    var pend = jparse_(prop_('PEND'));
    if (!pend) return false;
    var opSh = sheet_('Operations'), oh = headerOf_(opSh);
    var row = normRows_(opSh.getRange(pend.row, 1, 1, oh.length).getValues(), oh.length)[0];
    var op = rowObj_(oh, row);
    if (op.id === pend.id && op.status !== 'COMMITTED') {
      var ch = unpackJson_(op.changes) || {};
      Object.keys(ch).forEach(function (name) { reapply_(name, ch[name]); });
      op.status = 'COMMITTED'; op.committedAt = nowIso_(); op.result = '{"recovered":true}';
      opSh.getRange(pend.row, 1, 1, oh.length).setValues([objRow_(oh, op).map(escCell_)]);
      SpreadsheetApp.flush();
      console.warn('กู้คืนรายการค้าง ' + op.id + ' (' + op.action + ')');
    }
    delProp_('PEND');
    invalidate_();
    return true;
  });
}
function reapply_(name, c) {
  var sh = sheet_(name), h = headerOf_(sh), idc = h.indexOf('id'), last = sh.getLastRow();
  var from = WINDOW_TABLES[name] ? Math.max(2, last - 3000) : 2;
  var pos = {};
  if (last >= from) sh.getRange(from, idc + 1, last - from + 1, 1).getValues().forEach(function (r, i) { var id = cellStr_(r[0]); if (id) pos[id] = from + i; });
  function toRow(arr) { return objRow_(h, rowObj_(c.h, arr)).map(escCell_); }
  c.u.forEach(function (arr) { var id = rowObj_(c.h, arr).id, r = pos[id]; if (r) sh.getRange(r, 1, 1, h.length).setValues([toRow(arr)]); });
  var add = c.i.filter(function (arr) { return !pos[rowObj_(c.h, arr).id]; });
  if (add.length) { ensureRows_(sh, last + add.length); sh.getRange(last + 1, 1, add.length, h.length).setValues(add.map(toRow)); }
}

/**
 * ทำรายการแบบ transaction: idempotency (แคช OP:) -> lock -> โหลด snapshot -> fn(db) ตรวจ+แก้ในหน่วยความจำ
 * -> commit_ ลงชีต -> แพตช์ snapshot. drift => สร้าง snapshot ใหม่แล้วลองอีกครั้ง
 */
function runTx_(uid, action, requestId, payload, fn, opts) {
  opts = opts || {};
  var fp = requestId ? sha256Hex_(uid + '|' + action + '|' + JSON.stringify(payload || {})) : '';
  if (requestId) {
    var hit = cacheGetJ_('OP:' + requestId);
    if (hit) {
      if (hit.fp !== fp) throw err_('E_INPUT', 'รหัสคำขอซ้ำกับรายการอื่น กรุณาลองใหม่');
      return { data: hit.data, replayed: true };
    }
  }
  return withLock_(function () {
    recoverPending_();
    if (requestId) {
      var hit2 = cacheGetJ_('OP:' + requestId);
      if (hit2) return { data: hit2.data, replayed: true };
    }
    for (var attempt = 0; attempt < 2; attempt++) {
      var snap = loadSnapshot_(), prevRev = snap.rev;
      var db = new Db_(snap, uid);
      var data;
      try {
        data = fn(db);
      } catch (e) {
        if (snap.dirty) { SNAP_LOCAL_ = null; snap.dirty = false; }
        throw e;
      }
      if (!db.dirty()) return { data: data, db: db, rev: prevRev, prevRev: prevRev, changed: [] };
      var ids = {};
      Object.keys(db.ch).forEach(function (n) {
        var t = db.snap.t[n], idc = t.h.indexOf('id'), set = {};
        Object.keys(db.ch[n].upd).concat(Object.keys(db.ch[n].ins)).forEach(function (i) { set[t.r[i][idc]] = 1; });
        ids[n] = set;
      });
      try {
        commit_(db, { requestId: requestId, fingerprint: fp, action: action, journal: opts.journal !== false });
      } catch (e) {
        SNAP_LOCAL_ = null;
        if (e.code === 'E_DRIFT' && attempt === 0) { console.warn('drift: ' + e.message); invalidate_(); continue; }
        if (!e.code || e.code === 'E_DRIFT') invalidate_();
        throw e.code === 'E_DRIFT' ? err_('E_BUSY', 'ข้อมูลในชีตเพิ่งถูกแก้ไข กรุณาลองบันทึกอีกครั้ง') : e;
      }
      var changed = Object.keys(db.ch);
      var rev = changed.length ? publish_(snap, changed) : prevRev;
      if (!changed.length) snap.dirty = false;
      if (requestId) cachePutJ_('OP:' + requestId, { fp: fp, data: data }, OP_TTL);
      db.after.forEach(function (f) { try { f(); } catch (e) { console.warn(e); } });
      return { data: data, db: db, rev: rev, prevRev: prevRev, changed: changed, ids: ids };
    }
  });
}

// ============================================================ 5) Auth / Session / Rate limit
function pepper_() {
  var p = prop_('SESSION_PEPPER');
  if (!p) { p = randHex_(64); setProp_('SESSION_PEPPER', p); }
  return p;
}
function tokenHash_(token) { return hmacHex_(String(token), pepper_()); }
function sessKey_(h) { return 'SESS:' + h; }

function normIdent_(ident) {
  var s = String(ident || '').trim().toLowerCase();
  if (s.indexOf('@') > 0) return { email: s };
  var d = s.replace(/\D/g, '');
  return d.length >= 9 ? { phone: d } : null;
}
function findUser_(db, ident) {
  var q = normIdent_(ident);
  if (!q) return null;
  var users = db.rows('Users');
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (q.email && String(u.email).toLowerCase() === q.email) return u;
    if (q.phone && String(u.phone).replace(/\D/g, '') === q.phone) return u;
  }
  return null;
}
function rlKey_(kind, v) { return 'RL:' + kind + ':' + sha256Hex_(String(v || '').toLowerCase()).slice(0, 32); }
function rlCheck_(key, max, msg) {
  var r = cacheGetJ_(key);
  if (r && r.n >= max && r.until > Date.now()) throw err_('E_RATE', msg);
}
function rlHit_(key, windowSec) {
  var r = cacheGetJ_(key), now = Date.now();
  if (!r || r.until < now) r = { n: 0, until: now + windowSec * 1000 };
  r.n++;
  cachePutJ_(key, r, Math.ceil((r.until - now) / 1000));
}
/**
 * ล็อกอินไม่เปิด Spreadsheet: เซสชันอยู่ในแคช + คิว Script Property คีย์ละเซสชัน (LQ:<hash> ไม่มีการชนกัน)
 * trigger ทุก 1 นาที (หรือก่อน logout/revoke) จะเขียนแถว Sessions + AuditLogs จากคิว
 */
function createSession_(user, action, text) {
  var token = randHex_(96), h = tokenHash_(token), exp = Date.now() + SESSION_MS;
  cachePutJ_(sessKey_(h), { u: user.id, exp: exp }, Math.min(21600, SESSION_MS / 1000));
  setProp_('LQ:' + h, JSON.stringify({ u: user.id, exp: exp, at: nowIso_(), a: action, t: text }));
  return token;
}
function flushLoginQueue_() {
  var all = props_().getProperties(), keys = Object.keys(all).filter(function (k) { return k.indexOf('LQ:') === 0; });
  if (!keys.length) return 0;
  return withLock_(function () {
    var cur = props_().getProperties();
    keys = Object.keys(cur).filter(function (k) { return k.indexOf('LQ:') === 0; });
    if (!keys.length) return 0;
    var items = keys.map(function (k) { var e = jparse_(cur[k], {}) || {}; e.h = k.slice(3); return e; })
      .sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
    runTx_('system', 'flushLogins', null, null, function (db) {
      items.forEach(function (e) {
        if (!e.u) return;
        db.appendRaw('Sessions', { owner: e.u, createdAt: e.at, tokenHash: e.h, user: e.u, expiresAt: new Date(Number(e.exp)).toISOString(), revokedAt: e.r || '' });
        db.insert('AuditLogs', { owner: e.u, createdAt: e.at, day: Utilities.formatDate(new Date(e.at), TZ, 'yyyy-MM-dd'), action: e.a || 'LOGIN', entity: 'Users:' + e.u, detail: e.t || 'เข้าสู่ระบบ', before: '', after: '', at: e.at });
      });
    }, { journal: false });
    keys.forEach(function (k) { delProp_(k); });
    return keys.length;
  });
}
function readRawTable_(name) {
  var sh = sheet_(name), v = sh.getDataRange().getValues();
  if (!v.length) return { sh: sh, h: [], rows: [] };
  var h = v[0].map(function (x) { return String(x).trim(); });
  return { sh: sh, h: h, rows: normRows_(v.slice(1), h.length).map(function (r, i) { var o = rowObj_(h, r); o._row = i + 2; return o; }) };
}
function sessionFromSheet_(h) {
  var t = readRawTable_('Sessions');
  for (var i = t.rows.length - 1; i >= 0; i--) {
    var s = t.rows[i];
    if (s.tokenHash === h) return { u: s.user, exp: new Date(s.expiresAt).getTime() || 0, revoked: !!s.revokedAt };
  }
  return null;
}
/** ตรวจเซสชันจากแคช (ไม่แตะชีต) แคชหายจึงค้นในแท็บ Sessions */
function auth_(token) {
  if (!token || typeof token !== 'string' || token.length < 64) throw err_('E_AUTH', 'กรุณาเข้าสู่ระบบ');
  var h = tokenHash_(token), s = cacheGetJ_(sessKey_(h));
  if (!s) {
    var q = jparse_(prop_('LQ:' + h));
    s = q && q.u ? { u: q.u, exp: Number(q.exp) } : sessionFromSheet_(h);
    if (s && !s.revoked && s.exp > Date.now()) cachePutJ_(sessKey_(h), s, Math.min(21600, Math.ceil((s.exp - Date.now()) / 1000)));
  }
  if (!s || s.revoked || s.exp < Date.now()) throw err_('E_AUTH', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  var snap = loadSnapshot_(), db = new Db_(snap, s.u), u = db.me();
  if (!u || u.status !== 'ACTIVE') { cache_().remove(sessKey_(h)); throw err_('E_AUTH', 'บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแล'); }
  return { user: u, hash: h, db: db };
}
function revokeSessions_(userId, exceptHash) {
  flushLoginQueue_();
  var t = readRawTable_('Sessions'), now = nowIso_(), keys = [], col = t.h.indexOf('revokedAt') + 1;
  t.rows.forEach(function (s) {
    if (s.user === userId && !s.revokedAt && s.tokenHash !== exceptHash) {
      t.sh.getRange(s._row, col).setValue(now);
      keys.push(sessKey_(s.tokenHash));
    }
  });
  if (keys.length) cache_().removeAll(keys);
}

function perms_(db, u) {
  var r = db.get('Roles', u.role) || {}, admin = u.role === 'ADMIN', on = admin || bool_(r.active);
  return {
    role: u.role, admin: admin, manager: u.role === 'MANAGER',
    finance: admin || (on && bool_(r.seeFinance)), register: admin || (on && bool_(r.registerAssets)),
    assign: admin || (on && bool_(r.assignWork)), inspect: admin || (on && bool_(r.inspectWork)),
    techOnly: u.role === 'TECH'
  };
}
function meOf_(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, department: u.department, mustChangePassword: bool_(u.mustChangePassword) };
}

// ------------------------------------------------------------ สร้าง state สำหรับเบราว์เซอร์ (กรองที่เซิร์ฟเวอร์)
var STATE_TABLES = ['Users', 'Roles', 'Locations', 'Options', 'Items', 'Assets', 'Movements', 'Repairs', 'RepairAssessments', 'RepairNotes',
  'RepairCosts', 'BudgetRevisions', 'Approvals', 'Loans', 'LoanLines', 'LoanReturns', 'Disposals', 'Files', 'AuditLogs', 'Notifications'];
var HIDE_ALWAYS = { Users: ['passwordHash', 'passwordSalt', 'passwordRounds', 'googleSub'], Files: ['driveId'], Notifications: ['claim', 'retryKey'] };
var HIDE_FIN = { Assets: ['price'], Repairs: ['approved'], RepairAssessments: ['estimate'], RepairCosts: ['amount'], BudgetRevisions: ['old', 'amount'], Approvals: ['amount'] };
var USER_PUBLIC = ['id', 'name', 'role', 'department', 'status', 'version'];

function publicSettings_(db, P) {
  var g = db.setting('googleLogin', { enabled: false, clientId: '' }) || {};
  var s = {
    businessName: db.setting('businessName', 'วังยาวรีสอร์ท'), codePrefix: db.setting('codePrefix', 'WYA'),
    dueAlertDays: db.setting('dueAlertDays', 3), imageMaxPx: db.setting('imageMaxPx', 1440), imageTargetKB: db.setting('imageTargetKB', 250),
    allowRegister: db.setting('allowRegister', true) !== false,
    googleLogin: { enabled: !!g.enabled && !!g.clientId, clientId: g.enabled ? (g.clientId || '') : '' },
    departments: optionLabels_(db, 'departments')
  };
  if (P && P.admin) {
    s.webUrl = db.setting('webUrl', '');
    s.notify = { telegram: !!prop_('TG_TOKEN') && !!prop_('TG_CHAT'), line: !!prop_('LINE_TOKEN') && !!prop_('LINE_TO') };
    s.googleClientId = g.clientId || '';
    s.googleEnabled = !!g.enabled;
    s.version = APP_VERSION;
  }
  return s;
}

/**
 * only   = ส่งเฉพาะตารางที่ระบุ (partial)
 * rowIds = ส่งเฉพาะแถวที่เปลี่ยน {table:{id:1}} (delta: หน้าเว็บ upsert ตาม id) — ไม่ใช้กับช่าง เพราะชุดงานที่เห็นหดได้
 */
function buildState_(db, user, only, rowIds) {
  var P = perms_(db, user);
  var out = { rev: db.snap.rev, at: nowIso_(), me: meOf_(user), perms: P, settings: publicSettings_(db, P), tables: {} };
  var names = STATE_TABLES;
  if (only) { out.partial = true; names = STATE_TABLES.filter(function (n) { return only.indexOf(n) >= 0; }); }
  if (only && rowIds && !P.techOnly) out.delta = true; else rowIds = null;
  var visRep = null, visRev = null;
  if (P.techOnly) {
    visRep = {}; visRev = {};
    db.rows('Repairs').forEach(function (r) { if (r.assigned === user.id) visRep[r.id] = 1; });
    db.rows('BudgetRevisions').forEach(function (b) { if (visRep[b.repair]) visRev[b.id] = 1; });
  }
  names.forEach(function (n) {
    if (n === 'AuditLogs' && !(P.admin || P.manager)) return;
    if (n === 'Notifications' && !P.admin) return;
    var t = db.snap.t[n], hide = {};
    (HIDE_ALWAYS[n] || []).forEach(function (c) { hide[c] = 1; });
    if (!P.finance) (HIDE_FIN[n] || []).forEach(function (c) { hide[c] = 1; });
    var cols = t.h.filter(function (c) { return c && !hide[c]; });
    if (n === 'Users' && !P.admin) cols = cols.filter(function (c) { return USER_PUBLIC.indexOf(c) >= 0; });
    var idx = cols.map(function (c) { return t.h.indexOf(c); }), idc = t.h.indexOf('id');
    var keep = null;
    if (visRep) {
      var ci = function (c) { return t.h.indexOf(c); };
      if (n === 'Repairs') keep = function (r) { return visRep[r[idc]]; };
      else if (n === 'RepairAssessments' || n === 'RepairNotes' || n === 'RepairCosts' || n === 'BudgetRevisions') { var rc = ci('repair'); keep = function (r) { return visRep[r[rc]]; }; }
      else if (n === 'Files') { var fe = ci('entity'), fi = ci('entityId'); keep = function (r) { return r[fe] !== 'Repairs' || visRep[r[fi]]; }; }
      else if (n === 'Approvals') { var ae = ci('entity'), ai = ci('entityId'); keep = function (r) { return (r[ae] === 'Repairs' && visRep[r[ai]]) || (r[ae] === 'BudgetRevisions' && visRev[r[ai]]); }; }
    }
    if (n === 'Approvals' && !P.admin && !visRep) { var ae2 = t.h.indexOf('entity'); keep = function (r) { return r[ae2] !== 'Users'; }; }
    var rows = [], only1 = rowIds ? (rowIds[n] || {}) : null;
    for (var i = 0; i < t.r.length; i++) {
      var r = t.r[i];
      if (!r[idc] || (keep && !keep(r)) || (only1 && !only1[r[idc]])) continue;
      var o = new Array(idx.length);
      for (var j = 0; j < idx.length; j++) o[j] = r[idx[j]];
      rows.push(o);
    }
    out.tables[n] = { h: cols, r: rows };
  });
  return out;
}

// ------------------------------------------------------------ ตัวช่วยโดเมน
function canSeeRepair_(P, user, rep) { return !P.techOnly || rep.assigned === user.id; }
function nextCode_(db, table, prefix, width) {
  var max = 0;
  db.rows(table).forEach(function (x) {
    var c = String(x.code || '');
    if (c.indexOf(prefix) === 0) { var n = parseInt(c.slice(prefix.length), 10); if (n > max) max = n; }
  });
  return prefix + pad_(max + 1, width || 5);
}
function codePrefix_(db) { return String(db.setting('codePrefix', 'WYA') || 'WYA'); }
function assetCode_(db, type) {
  var p = codePrefix_(db);
  return nextCode_(db, 'Assets', type === 'QUANTITY' ? p + '-LOT-' + ymd_() + '-' : p + '-' + ymd_() + '-', 5);
}
function docCode_(db, table, tag) { return nextCode_(db, table, codePrefix_(db) + '-' + tag + '-' + ymd_() + '-', 3); }
function optionLabels_(db, kind) {
  var out = [];
  db.rows('Options').forEach(function (o) { if (o.kind === kind && bool_(o.active)) out.push(o.label); });
  return out;
}
function checkOption_(db, kind, v, label, required) {
  if (!v) { if (required) fail_('กรุณาเลือก' + label); return ''; }
  var ok = db.rows('Options').some(function (o) {
    if (o.kind !== kind) return false;
    if (o.label === v) return true;
    return (jparse_(o.aliases, []) || []).indexOf(v) >= 0;
  });
  if (!ok) fail_(label + ' "' + v + '" ไม่อยู่ในตัวเลือก');
  return v;
}
function checkLocation_(db, id, label) {
  var l = db.get('Locations', id);
  if (!l || !bool_(l.active)) fail_('กรุณาเลือก' + (label || 'สถานที่') + 'ที่ใช้งานอยู่');
  return l;
}
function checkUser_(db, id, label, role) {
  if (!id) return '';
  var u = db.get('Users', id);
  if (!u || u.status !== 'ACTIVE') fail_(label + 'ไม่ถูกต้อง');
  if (role && u.role !== role && u.role !== 'ADMIN') fail_(label + 'ต้องเป็นผู้ใช้บทบาท ' + role);
  return id;
}
function openRepairOf_(db, assetId) {
  var rs = db.rows('Repairs');
  for (var i = 0; i < rs.length; i++) if (rs[i].asset === assetId && OPEN_REPAIR[rs[i].status]) return rs[i];
  return null;
}
function pendingDisposalOf_(db, assetId) {
  var ds = db.rows('Disposals');
  for (var i = 0; i < ds.length; i++) if ((ds[i].asset === assetId || ds[i].disposedAsset === assetId) && ds[i].status === 'PENDING') return ds[i];
  return null;
}
var BUSY_TEXT = { REPAIRING: 'อยู่ระหว่างซ่อม', LOANED: 'ถูกยืมอยู่', PENDING_DISPOSAL: 'รออนุมัติจำหน่าย', DISPOSED: 'จำหน่ายแล้ว' };
function assertAvailable_(a, what) {
  if (BUSY_TEXT[a.condition]) fail_('"' + a.name + '" ' + BUSY_TEXT[a.condition] + ' ไม่สามารถ' + what + 'ได้');
  if (a.loan) fail_('"' + a.name + '" ถูกยืมอยู่ ไม่สามารถ' + what + 'ได้');
  if (num_(a.qty) <= 0) fail_('"' + a.name + '" ไม่มีจำนวนคงเหลือ');
}
function addMovement_(db, a, dest, qty, from, to, kind, note, ref) {
  db.insert('Movements', {
    asset: a.id, destinationAsset: dest ? dest.id : '', batch: a.batch || '', item: a.item, name: a.name, qty: qty,
    from: from || '', to: to || '', at: nowIso_(), note: note || '', kind: kind, reference: ref || ''
  });
}
/** แบ่งล็อต: ลด qty ต้นทาง แล้วรวมเข้าล็อตเดียวกันที่ปลายทาง หรือสร้างล็อตใหม่ */
function splitLot_(db, src, qty, target, merge) {
  var batch = src.batch || src.id;
  db.update('Assets', src.id, { qty: num_(src.qty) - qty });
  if (merge) {
    var cands = db.rows('Assets');
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (c.id !== src.id && c.type === 'QUANTITY' && (c.batch || c.id) === batch && c.location === target.location &&
        c.condition === target.condition && !c.loan) {
        return db.update('Assets', c.id, { qty: num_(c.qty) + qty });
      }
    }
  }
  return db.insert('Assets', {
    code: assetCode_(db, 'QUANTITY'), item: src.item, batch: batch, name: src.name, brand: src.brand, group: src.group, type: 'QUANTITY',
    qty: qty, unit: src.unit, price: src.price, year: src.year, purchase: src.purchase, received: src.received,
    location: target.location, condition: target.condition, responsible: src.responsible, serial: src.serial, note: src.note, loan: target.loan || ''
  });
}
/** รวมล็อตกลับเข้าล็อตเดิมที่สถานที่/สภาพเดียวกัน (หลังซ่อมเสร็จ/คืนของ) */
function mergeBack_(db, a) {
  if (a.type !== 'QUANTITY' || num_(a.qty) <= 0) return a;
  var batch = a.batch || a.id, list = db.rows('Assets');
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (c.id !== a.id && c.type === 'QUANTITY' && (c.batch || c.id) === batch && c.location === a.location && c.condition === a.condition && !c.loan &&
      !openRepairOf_(db, c.id) && !pendingDisposalOf_(db, c.id)) {
      db.update('Assets', c.id, { qty: num_(c.qty) + num_(a.qty) });
      db.update('Assets', a.id, { qty: 0 });
      return c;
    }
  }
  return a;
}
/** แยกส่วนที่ต้องติดตาม (ซ่อม/จำหน่าย/ยืม): เต็มจำนวนใช้รายการเดิม บางส่วนแยกล็อตใหม่ */
function takePart_(db, a, qty, target) {
  if (a.type !== 'QUANTITY' || qty >= num_(a.qty)) {
    var patch = { condition: target.condition };
    if (target.location) patch.location = target.location;
    if (target.loan !== undefined) patch.loan = target.loan;
    return db.update('Assets', a.id, patch);
  }
  return splitLot_(db, a, qty, { location: target.location || a.location, condition: target.condition, loan: target.loan || '' }, false);
}
function partQty_(a, q) {
  if (a.type !== 'QUANTITY') return 1;
  var qty = vInt_(q === '' || q == null ? a.qty : q, 'จำนวน', 1, 1e9, true);
  if (qty > num_(a.qty)) fail_('จำนวนเกินคงเหลือ (' + a.qty + ' ' + (a.unit || '') + ')');
  return qty;
}

// ------------------------------------------------------------ แจ้งเตือนเจ้าของ (เข้าคิว)
function notifyChannels_() {
  var ch = [];
  if (prop_('TG_TOKEN') && prop_('TG_CHAT')) ch.push('TELEGRAM');
  if (prop_('LINE_TOKEN') && prop_('LINE_TO')) ch.push('LINE');
  return ch;
}
Db_.prototype.notify = function (event, entity, message, retryKey) {
  var self = this, biz = this.setting('businessName', 'วังยาวรีสอร์ท'), ch = notifyChannels_();
  ch.forEach(function (c) {
    self.insert('Notifications', {
      channel: c, event: event, entity: entity, message: '[' + biz + '] ' + message, status: 'PENDING', attempts: 0,
      nextAttempt: nowIso_(), lastError: '', sentAt: '', claim: '', retryKey: retryKey ? retryKey + ':' + c : ''
    });
  });
  if (ch.length) this.markQueue();
};
/** ธงว่ามีคิวแจ้งเตือน: trigger ทุกนาทีไม่ต้องถอด snapshot ถ้าไม่มีงาน */
Db_.prototype.markQueue = function () { if (!this._nq) { this._nq = true; this.after.push(function () { setProp_('NQ', '1'); }); } };

// ============================================================ 6) Actions
var ACTIONS = {};
function act_(name, opts, fn) { opts.fn = fn; ACTIONS[name] = opts; }

// ---------- บัญชี
act_('changePassword', { self: true }, function (db, me, P, p, ctx) {
  if (!p.currentDerived || !safeEq_(String(p.currentDerived).toLowerCase(), me.passwordHash)) fail_('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  var pw = vPw_(p.pw);
  pw.mustChangePassword = 'FALSE';
  db.update('Users', me.id, pw);
  db.audit('CHANGE_PASSWORD', 'Users', me.id, 'เปลี่ยนรหัสผ่าน');
  db.after.push(function () { revokeSessions_(me.id, ctx.hash); });
  return { ok: true };
});

// ---------- ผู้ใช้ (Admin)
function uniqueUser_(db, id, email, phone) {
  db.rows('Users').forEach(function (u) {
    if (u.id === id) return;
    if (email && String(u.email).toLowerCase() === email) fail_('อีเมลนี้มีผู้ใช้แล้ว');
    if (phone && String(u.phone).replace(/\D/g, '') === phone) fail_('เบอร์โทรนี้มีผู้ใช้แล้ว');
  });
}
function activeAdmins_(db, exceptId) {
  return db.rows('Users').filter(function (u) { return u.id !== exceptId && u.role === 'ADMIN' && u.status === 'ACTIVE'; }).length;
}
act_('saveUser', { admin: true }, function (db, me, P, p) {
  var roles = db.rows('Roles').map(function (r) { return r.id; });
  var d = {
    name: vStr_(p.name, 'ชื่อ', 100, true), email: vEmail_(p.email, false), phone: vPhone_(p.phone, false),
    role: vOne_(String(p.role || ''), roles, 'บทบาท'), status: vOne_(String(p.status || 'ACTIVE'), ['ACTIVE', 'PENDING', 'INACTIVE'], 'สถานะ'),
    department: p.department ? checkOption_(db, 'departments', String(p.department), 'แผนก') : ''
  };
  if (!d.email && !d.phone) fail_('กรุณากรอกอีเมลหรือเบอร์โทรอย่างน้อยหนึ่งอย่าง');
  uniqueUser_(db, p.id, d.email, d.phone);
  if (p.id) {
    var u = db.must('Users', p.id, 'ผู้ใช้');
    if (u.role === 'ADMIN' && u.status === 'ACTIVE' && (d.role !== 'ADMIN' || d.status !== 'ACTIVE') && !activeAdmins_(db, u.id)) fail_('ต้องมีผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน');
    var before = meOf_(u);
    if (p.pw) { var pw = vPw_(p.pw); for (var k in pw) d[k] = pw[k]; d.mustChangePassword = 'TRUE'; }
    db.update('Users', u.id, d, p.version);
    db.audit('UPDATE_USER', 'Users', u.id, 'แก้ไขผู้ใช้ ' + d.name, before, meOf_(u));
    if (d.status !== 'ACTIVE' || p.pw) db.after.push(function () { revokeSessions_(u.id); });
    return { id: u.id };
  }
  if (!p.pw) fail_('กรุณาตั้งรหัสผ่านชั่วคราวสำหรับผู้ใช้ใหม่');
  var pw2 = vPw_(p.pw);
  for (var k2 in pw2) d[k2] = pw2[k2];
  d.mustChangePassword = 'TRUE'; d.googleSub = '';
  var nu = db.insert('Users', d);
  db.audit('CREATE_USER', 'Users', nu.id, 'สร้างผู้ใช้ ' + d.name, null, meOf_(nu));
  return { id: nu.id };
});
act_('approveUser', { admin: true }, function (db, me, P, p) {
  var u = db.must('Users', p.id, 'ผู้ใช้');
  if (u.status !== 'PENDING') fail_('ผู้ใช้นี้ไม่ได้อยู่ในสถานะรออนุมัติ');
  var approve = p.decision === 'APPROVE';
  var role = approve ? vOne_(String(p.role || 'STAFF'), db.rows('Roles').map(function (r) { return r.id; }), 'บทบาท') : u.role;
  db.update('Users', u.id, { status: approve ? 'ACTIVE' : 'INACTIVE', role: role }, p.version);
  db.insert('Approvals', { entity: 'Users', entityId: u.id, decision: approve ? 'APPROVE' : 'REJECT', amount: '', reason: vStr_(p.reason, 'หมายเหตุ', 300), at: nowIso_() });
  db.audit(approve ? 'APPROVE_USER' : 'REJECT_USER', 'Users', u.id, (approve ? 'อนุมัติ' : 'ไม่อนุมัติ') + 'ผู้สมัคร ' + u.name);
  return { ok: true };
});
act_('setTempPassword', { admin: true }, function (db, me, P, p) {
  var u = db.must('Users', p.id, 'ผู้ใช้');
  var pw = vPw_(p.pw);
  pw.mustChangePassword = 'TRUE';
  db.update('Users', u.id, pw);
  db.audit('TEMP_PASSWORD', 'Users', u.id, 'ตั้งรหัสผ่านชั่วคราวให้ ' + u.name);
  db.after.push(function () { revokeSessions_(u.id); });
  return { ok: true };
});

// ---------- สถานที่ / ตัวเลือก / ตั้งค่า
act_('saveLocation', { admin: true }, function (db, me, P, p) {
  var d = {
    name: vStr_(p.name, 'ชื่อสถานที่', 100, true), parent: String(p.parent || ''),
    kind: vOne_(String(p.kind || 'AREA'), ['STORE', 'BUILDING', 'FLOOR', 'ROOM', 'AREA'], 'ประเภทสถานที่'), active: p.active === false || p.active === 'FALSE' ? 'FALSE' : 'TRUE'
  };
  if (d.parent && !db.get('Locations', d.parent)) fail_('สถานที่หลักไม่ถูกต้อง');
  if (p.id && d.parent === p.id) fail_('สถานที่หลักต้องไม่ใช่ตัวเอง');
  db.rows('Locations').forEach(function (l) { if (l.id !== p.id && l.name === d.name && l.parent === d.parent) fail_('มีสถานที่ชื่อนี้แล้ว'); });
  if (p.id) {
    var l = db.must('Locations', p.id, 'สถานที่');
    if (d.active === 'FALSE') {
      if (l.id === 'CENTRAL') fail_('ไม่สามารถปิดสต๊อกกลางได้');
      var has = db.rows('Assets').some(function (a) { return a.location === l.id && num_(a.qty) > 0 && a.condition !== 'DISPOSED'; });
      if (has) fail_('ยังมีสิ่งของอยู่ในสถานที่นี้ กรุณาย้ายออกก่อนปิด');
    }
    db.update('Locations', l.id, d, p.version);
    db.audit('UPDATE_LOCATION', 'Locations', l.id, 'แก้ไขสถานที่ ' + d.name);
    return { id: l.id };
  }
  var nl = db.insert('Locations', d);
  db.audit('CREATE_LOCATION', 'Locations', nl.id, 'เพิ่มสถานที่ ' + d.name);
  return { id: nl.id };
});
act_('saveOption', { admin: true }, function (db, me, P, p) {
  var kind = vOne_(String(p.kind || ''), ['groups', 'units', 'brands', 'reasons', 'departments'], 'ประเภทตัวเลือก');
  var label = vStr_(p.label, 'ชื่อตัวเลือก', 80, true);
  db.rows('Options').forEach(function (o) { if (o.kind === kind && o.id !== p.id && o.label === label) fail_('มีตัวเลือกนี้แล้ว'); });
  if (p.id) {
    var o = db.must('Options', p.id, 'ตัวเลือก'), aliases = jparse_(o.aliases, []) || [];
    if (o.label !== label && aliases.indexOf(o.label) < 0) aliases.push(o.label);   // ชื่อเดิมยังอ้างอิงได้
    var active = p.active === false || p.active === 'FALSE' ? 'FALSE' : 'TRUE';
    db.update('Options', o.id, { label: label, aliases: JSON.stringify(aliases), active: active, sortOrder: vInt_(p.sortOrder === '' ? o.sortOrder : p.sortOrder, 'ลำดับ', 0, 9999) }, p.version);
    db.audit(active === 'FALSE' ? 'DISABLE_OPTION' : 'UPDATE_OPTION', 'Options', o.id, kind + ': ' + label);
    return { id: o.id };
  }
  var max = 0;
  db.rows('Options').forEach(function (x) { if (x.kind === kind) max = Math.max(max, num_(x.sortOrder)); });
  var no = db.insert('Options', { kind: kind, label: label, aliases: '[]', active: 'TRUE', sortOrder: max + 1 });
  db.audit('CREATE_OPTION', 'Options', no.id, kind + ': ' + label);
  return { id: no.id };
});
function putSetting_(db, key, value) {
  var id = 'S_' + key, v = JSON.stringify(value);
  if (db.get('Settings', id)) { if (db.get('Settings', id).value !== v) db.update('Settings', id, { value: v }); }
  else db.insert('Settings', { id: id, key: key, value: v });
}
act_('saveSettings', { admin: true }, function (db, me, P, p) {
  var prefix = vStr_(p.codePrefix, 'คำนำหน้ารหัส', 6, true).toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(prefix)) fail_('คำนำหน้ารหัสต้องเป็น A-Z หรือ 0-9 จำนวน 2-6 ตัว');
  var cid = vStr_(p.googleClientId, 'Google Client ID', 200);
  if (bool_(p.googleEnabled) && !/\.apps\.googleusercontent\.com$/.test(cid)) fail_('Google Client ID ไม่ถูกต้อง');
  var web = vStr_(p.webUrl, 'ที่อยู่เว็บ', 200);
  if (web && !/^https:\/\/[^\s/]+/.test(web)) fail_('ที่อยู่เว็บต้องขึ้นต้นด้วย https://');
  putSetting_(db, 'businessName', vStr_(p.businessName, 'ชื่อกิจการ', 100, true));
  putSetting_(db, 'codePrefix', prefix);
  putSetting_(db, 'dueAlertDays', vInt_(p.dueAlertDays, 'วันแจ้งเตือนก่อนครบกำหนด', 0, 30, true));
  putSetting_(db, 'imageMaxPx', vInt_(p.imageMaxPx, 'ขนาดภาพสูงสุด', 480, 4000, true));
  putSetting_(db, 'imageTargetKB', vInt_(p.imageTargetKB, 'ขนาดไฟล์ภาพเป้าหมาย', 50, 500, true));
  putSetting_(db, 'allowRegister', bool_(p.allowRegister));
  putSetting_(db, 'googleLogin', { enabled: bool_(p.googleEnabled), clientId: cid });
  if (web) putSetting_(db, 'webUrl', web.replace(/\/+$/, ''));
  db.audit('UPDATE_SETTINGS', 'Settings', '', 'แก้ไขตั้งค่าระบบ');
  return { ok: true };
});

// ---------- ทะเบียนสิ่งของ
function itemFor_(db, name, group, type, unit) {
  var key = (name + '|' + group).toLowerCase(), items = db.rows('Items');
  for (var i = 0; i < items.length; i++) if ((items[i].name + '|' + items[i].group).toLowerCase() === key) return items[i];
  return db.insert('Items', { name: name, group: group, trackingMode: type, unit: unit, active: 'TRUE' });
}
act_('saveAsset', { perm: 'register' }, function (db, me, P, p) {
  var d = {
    name: vStr_(p.name, 'ชื่อสิ่งของ', 150, true), group: checkOption_(db, 'groups', String(p.group || ''), 'หมวด', true),
    brand: p.brand ? checkOption_(db, 'brands', String(p.brand), 'ยี่ห้อ') : '', unit: checkOption_(db, 'units', String(p.unit || ''), 'หน่วย', true),
    year: vInt_(p.year, 'ปีที่ได้มา', 2400, 2700), purchase: vDate_(p.purchase, 'วันที่ซื้อ'), received: vDate_(p.received, 'วันที่รับเข้า'),
    responsible: checkUser_(db, String(p.responsible || ''), 'ผู้รับผิดชอบ'), serial: vStr_(p.serial, 'Serial', 100), note: vStr_(p.note, 'หมายเหตุ', 1000)
  };
  if (P.finance) d.price = vNum_(p.price, 'ราคา', 0, 1e9);
  if (p.id) {
    var a = db.must('Assets', p.id, 'สิ่งของ');
    if (a.condition === 'DISPOSED') fail_('สิ่งของนี้จำหน่ายแล้ว ไม่สามารถแก้ไขได้');
    if (p.condition && p.condition !== a.condition) {
      if (['READY', 'IN_USE', 'DAMAGED'].indexOf(a.condition) < 0) fail_('สภาพปัจจุบัน "' + a.condition + '" เปลี่ยนเองไม่ได้ ต้องทำผ่านงานซ่อม/ยืมคืน/จำหน่าย');
      d.condition = vOne_(String(p.condition), ['READY', 'IN_USE', 'DAMAGED'], 'สภาพ');
    }
    if (a.type === 'QUANTITY' && p.qty !== undefined && p.qty !== '' && Number(p.qty) !== num_(a.qty)) {
      if (a.loan || ['LOANED', 'REPAIRING', 'PENDING_DISPOSAL'].indexOf(a.condition) >= 0) fail_('ล็อตนี้อยู่ระหว่างดำเนินการ ปรับจำนวนไม่ได้');
      d.qty = vInt_(p.qty, 'จำนวน', 0, 1e9, true);
    }
    var before = {}; for (var k in d) before[k] = a[k];
    var item = itemFor_(db, d.name, d.group, a.type, d.unit);
    d.item = item.id;
    db.update('Assets', a.id, d, p.version);
    db.audit('UPDATE_ASSET', 'Assets', a.id, 'แก้ไขทะเบียน ' + a.code + ' ' + d.name, before, d);
    return { id: a.id };
  }
  var type = vOne_(String(p.type || 'UNIT'), ['UNIT', 'QUANTITY'], 'รูปแบบทะเบียน');
  var loc = checkLocation_(db, String(p.location || 'CENTRAL'), 'สถานที่');
  d.condition = vOne_(String(p.condition || 'READY'), ['READY', 'IN_USE', 'DAMAGED'], 'สภาพ');
  var qty = vInt_(p.qty || 1, 'จำนวน', 1, type === 'UNIT' ? 200 : 1e9, true);
  var it = itemFor_(db, d.name, d.group, type, d.unit);
  var made = [];
  var n = type === 'UNIT' ? qty : 1;
  for (var i = 0; i < n; i++) {
    var x = {}; for (var k2 in d) x[k2] = d[k2];
    x.code = assetCode_(db, type); x.item = it.id; x.type = type; x.qty = type === 'UNIT' ? 1 : qty; x.location = loc.id; x.loan = '';
    if (!P.finance) x.price = '';
    var a2 = db.insert('Assets', x);
    if (type === 'QUANTITY') db.update('Assets', a2.id, { batch: a2.id });
    addMovement_(db, a2, null, x.qty, '', loc.id, 'RECEIVE', 'ลงทะเบียนใหม่');
    made.push(a2.id);
  }
  db.audit('CREATE_ASSET', 'Assets', made[0], 'ลงทะเบียน ' + d.name + ' ' + (type === 'UNIT' ? n + ' รายการ' : qty + ' ' + d.unit));
  return { ids: made, id: made[0] };
});
act_('moveAsset', { perm: 'register' }, function (db, me, P, p) {
  var a = db.must('Assets', p.asset, 'สิ่งของ');
  assertAvailable_(a, 'ย้าย');
  var to = checkLocation_(db, String(p.to || ''), 'สถานที่ปลายทาง');
  if (to.id === a.location) fail_('สถานที่ปลายทางต้องไม่ใช่ที่เดิม');
  var qty = partQty_(a, p.qty), note = vStr_(p.note, 'เหตุผล', 300, true);
  if (p.version !== undefined && p.version !== '' && String(a.version) !== String(p.version)) throw err_('E_VERSION', 'ข้อมูลถูกแก้ไขแล้ว กรุณาโหลดใหม่');
  var from = a.location, dest;
  if (a.type !== 'QUANTITY' || qty === num_(a.qty)) {
    dest = db.update('Assets', a.id, { location: to.id });
    if (a.type === 'QUANTITY') dest = mergeBack_(db, dest);
  } else dest = splitLot_(db, a, qty, { location: to.id, condition: a.condition }, true);
  addMovement_(db, a, dest.id !== a.id ? dest : null, qty, from, to.id, 'MOVE', note);
  db.audit('MOVE_ASSET', 'Assets', a.id, 'ย้าย ' + a.code + ' ' + qty + ' ' + (a.unit || '') + ' ไป ' + to.name);
  return { id: dest.id };
});

// ---------- งานซ่อม
function repairActor_(P, me, rep) { return P.admin || P.assign || rep.assigned === me.id; }
act_('createRepair', {}, function (db, me, P, p) {
  var a = db.must('Assets', p.asset, 'สิ่งของ');
  if (openRepairOf_(db, a.id)) fail_('"' + a.name + '" มีงานซ่อมที่ยังไม่ปิดอยู่แล้ว');
  if (pendingDisposalOf_(db, a.id)) fail_('"' + a.name + '" อยู่ระหว่างรออนุมัติจำหน่าย');
  assertAvailable_(a, 'แจ้งซ่อม');
  var qty = partQty_(a, p.qty);
  var issue = vStr_(p.issue, 'อาการเสีย', 1000, true);
  var assigned = P.assign ? checkUser_(db, String(p.assigned || ''), 'ช่างผู้รับผิดชอบ', 'TECH') : '';
  var due = P.assign ? vDate_(p.due, 'กำหนดเสร็จ') : '';
  var loc = p.reportedLocation ? checkLocation_(db, String(p.reportedLocation), 'สถานที่พบปัญหา').id : a.location;
  var part = takePart_(db, a, qty, { condition: 'REPAIRING' });
  var r = db.insert('Repairs', { code: docCode_(db, 'Repairs', 'RP'), asset: part.id, qty: qty, reportedLocation: loc, assigned: assigned, status: 'ASSESS', issue: issue, created: nowIso_(), due: due, approved: '' });
  if (part.id !== a.id) addMovement_(db, a, part, qty, a.location, a.location, 'SPLIT', 'แยกส่งซ่อม', r.code);
  if (assigned) db.insert('RepairNotes', { repair: r.id, text: 'มอบหมายงานซ่อม', at: nowIso_(), kind: 'ASSIGN', fromUser: me.id, toUser: assigned });
  db.audit('CREATE_REPAIR', 'Repairs', r.id, 'แจ้งซ่อม ' + r.code + ' ' + a.name + ': ' + issue);
  db.notify('REPAIR_NEW', 'Repairs:' + r.id, 'แจ้งซ่อมใหม่ ' + r.code + '\n' + a.name + ' (' + a.code + ')\nอาการ: ' + issue + '\nผู้แจ้ง: ' + me.name);
  return { id: r.id, code: r.code };
});
act_('updateRepairIssue', {}, function (db, me, P, p) {
  var r = db.must('Repairs', p.id, 'งานซ่อม');
  if (!canSeeRepair_(P, me, r)) deny_();
  if (!(P.admin || P.assign || r.owner === me.id || r.assigned === me.id)) deny_('เฉพาะผู้แจ้ง ช่าง หรือผู้มอบหมายงานเท่านั้นที่แก้อาการได้');
  if (r.status !== 'ASSESS' && r.status !== 'APPROVAL') fail_('แก้อาการได้เฉพาะงานที่ยังไม่อนุมัติ');
  var d = { issue: vStr_(p.issue, 'อาการเสีย', 1000, true) };
  if (P.assign) d.due = vDate_(p.due, 'กำหนดเสร็จ');
  db.update('Repairs', r.id, d, p.version);
  db.audit('UPDATE_REPAIR', 'Repairs', r.id, 'แก้อาการเสีย ' + r.code, { issue: r.issue }, d);
  return { ok: true };
});
act_('assessRepair', {}, function (db, me, P, p) {
  var r = db.must('Repairs', p.id, 'งานซ่อม');
  if (!canSeeRepair_(P, me, r) || !repairActor_(P, me, r)) deny_('เฉพาะช่างที่ได้รับมอบหมายหรือผู้มอบหมายงานเท่านั้น');
  if (r.status !== 'ASSESS' && r.status !== 'APPROVAL') fail_('ประเมินได้เฉพาะงานสถานะรอประเมิน/รออนุมัติ');
  var fixable = bool_(p.fixable);
  var est = vNum_(p.estimate, 'ประมาณการค่าใช้จ่าย', 0, 1e8, fixable);
  var days = vInt_(p.days, 'ระยะเวลา (วัน)', 0, 365, fixable);
  var note = vStr_(p.note, 'หมายเหตุ', 1000);
  db.insert('RepairAssessments', { repair: r.id, fixable: fixable ? 'TRUE' : 'FALSE', estimate: est, days: days, note: note, at: nowIso_() });
  db.update('Repairs', r.id, { status: 'APPROVAL', assigned: r.assigned || (me.role === 'TECH' ? me.id : '') }, p.version);
  db.audit('ASSESS_REPAIR', 'Repairs', r.id, 'ประเมิน ' + r.code + (fixable ? ' ซ่อมได้' : ' ซ่อมไม่ได้'));
  db.notify('REPAIR_APPROVAL', 'Repairs:' + r.id, 'งานซ่อมรออนุมัติ ' + r.code + '\n' + (fixable ? 'ซ่อมได้ ประมาณการ ' + est + ' บาท ' + days + ' วัน' : 'ช่างประเมินว่าซ่อมไม่ได้') + (note ? '\n' + note : ''));
  return { ok: true };
});
act_('forwardRepair', {}, function (db, me, P, p) {
  var r = db.must('Repairs', p.id, 'งานซ่อม');
  if (!(P.admin || P.assign || r.assigned === me.id)) deny_('เฉพาะผู้มอบหมายงานหรือช่างเจ้าของงานเท่านั้น');
  if (!OPEN_REPAIR[r.status]) fail_('งานนี้ปิดแล้ว');
  var to = checkUser_(db, String(p.assigned || ''), 'ช่างผู้รับงาน', 'TECH');
  if (!to) fail_('กรุณาเลือกช่างผู้รับงาน');
  if (to === r.assigned) fail_('งานนี้มอบหมายให้ช่างคนนี้อยู่แล้ว');
  var d = { assigned: to };
  if (P.assign && p.due) d.due = vDate_(p.due, 'กำหนดเสร็จ');
  db.update('Repairs', r.id, d, p.version);
  db.insert('RepairNotes', { repair: r.id, text: vStr_(p.note, 'หมายเหตุ', 1000) || 'ส่งต่องาน', at: nowIso_(), kind: 'FORWARD', fromUser: r.assigned || me.id, toUser: to });
  db.audit('FORWARD_REPAIR', 'Repairs', r.id, 'ส่งต่องาน ' + r.code + ' ให้ ' + db.get('Users', to).name);
  return { ok: true };
});
act_('addRepairNote', {}, function (db, me, P, p) {
  var r = db.must('Repairs', p.id, 'งานซ่อม');
  if (!canSeeRepair_(P, me, r)) deny_();
  var n = db.insert('RepairNotes', { repair: r.id, text: vStr_(p.text, 'ข้อความติดตาม', 1000, true), at: nowIso_(), kind: 'NOTE', fromUser: me.id, toUser: '' });
  db.audit('REPAIR_NOTE', 'Repairs', r.id, 'บันทึกติดตาม ' + r.code);
  return { id: n.id };
});
act_('decideRepair', { admin: true }, function (db, me, P, p) {
  var r = db.must('Repairs', p.id, 'งานซ่อม');
  if (r.status !== 'APPROVAL') fail_('งานนี้ไม่ได้อยู่ในสถานะรออนุมัติ');
  var approve = p.decision === 'APPROVE', reason = vStr_(p.reason, 'เหตุผล', 500, !approve);
  var amount = approve ? vNum_(p.amount, 'วงเงินอนุมัติ', 0, 1e8, true) : '';
  db.update('Repairs', r.id, approve ? { status: 'REPAIR', approved: amount } : { status: 'REJECT' }, p.version);
  if (!approve) { var a = db.get('Assets', r.asset); if (a) db.update('Assets', a.id, { condition: 'DAMAGED' }); }
  db.insert('Approvals', { entity: 'Repairs', entityId: r.id, decision: approve ? 'APPROVE' : 'REJECT', amount: amount, reason: reason, at: nowIso_() });
  db.insert('RepairNotes', { repair: r.id, text: (approve ? 'อนุมัติซ่อม' : 'ไม่อนุมัติซ่อม') + (reason ? ': ' + reason : ''), at: nowIso_(), kind: approve ? 'APPROVE' : 'REJECT', fromUser: me.id, toUser: '' });
  db.audit(approve ? 'APPROVE_REPAIR' : 'REJECT_REPAIR', 'Repairs', r.id, (approve ? 'อนุมัติ ' : 'ไม่อนุมัติ ') + r.code + (approve ? ' วงเงิน ' + amount : ''));
  return { ok: true };
});
act_('requestBudgetRevision', {}, function (db, me, P, p) {
  var r = db.must('Repairs', p.id, 'งานซ่อม');
  if (!canSeeRepair_(P, me, r) || !repairActor_(P, me, r)) deny_();
  if (r.status !== 'REPAIR') fail_('ขอแก้ไขวงเงินได้เฉพาะงานที่กำลังซ่อม');
  if (db.rows('BudgetRevisions').some(function (b) { return b.repair === r.id && b.status === 'PENDING'; })) fail_('มีคำขอแก้ไขวงเงินที่รอพิจารณาอยู่แล้ว');
  var amount = vNum_(p.amount, 'วงเงินใหม่', 0, 1e8, true), old = num_(r.approved);
  if (amount === old) fail_('วงเงินใหม่ต้องไม่เท่ากับวงเงินเดิม');
  var b = db.insert('BudgetRevisions', { repair: r.id, old: old, amount: amount, direction: amount > old ? 'INCREASE' : 'DECREASE', reason: vStr_(p.reason, 'เหตุผล', 500, true), at: nowIso_(), status: 'PENDING', approvedBy: '', approvedAt: '', decisionNote: '' });
  db.audit('REQUEST_BUDGET', 'Repairs', r.id, 'ขอแก้ไขวงเงิน ' + r.code);
  db.notify('BUDGET_REVISION', 'Repairs:' + r.id, 'ขอแก้ไขวงเงินซ่อม ' + r.code + '\nจาก ' + old + ' เป็น ' + amount + ' บาท\nเหตุผล: ' + b.reason);
  return { id: b.id };
});
act_('decideBudgetRevision', { admin: true }, function (db, me, P, p) {
  var b = db.must('BudgetRevisions', p.id, 'คำขอแก้ไขวงเงิน');
  if (b.status !== 'PENDING') fail_('คำขอนี้พิจารณาแล้ว');
  var r = db.must('Repairs', b.repair, 'งานซ่อม');
  var approve = p.decision === 'APPROVE', note = vStr_(p.note, 'หมายเหตุ', 500, !approve);
  db.update('BudgetRevisions', b.id, { status: approve ? 'APPROVED' : 'REJECTED', approvedBy: me.id, approvedAt: nowIso_(), decisionNote: note }, p.version);
  if (approve) db.update('Repairs', r.id, { approved: b.amount });
  db.insert('Approvals', { entity: 'BudgetRevisions', entityId: b.id, decision: approve ? 'APPROVE' : 'REJECT', amount: b.amount, reason: note, at: nowIso_() });
  db.audit(approve ? 'APPROVE_BUDGET' : 'REJECT_BUDGET', 'Repairs', r.id, (approve ? 'อนุมัติ' : 'ไม่อนุมัติ') + 'แก้ไขวงเงิน ' + r.code);
  return { ok: true };
});
var COST_KINDS = ['PARTS', 'LABOR', 'OUTSOURCE', 'OTHER'];
act_('completeRepair', {}, function (db, me, P, p) {
  var r = db.must('Repairs', p.id, 'งานซ่อม');
  if (!canSeeRepair_(P, me, r) || !repairActor_(P, me, r)) deny_();
  if (r.status !== 'REPAIR') fail_('ปิดงานได้เฉพาะงานที่กำลังซ่อม');
  var costs = Array.isArray(p.costs) ? p.costs : [];
  if (costs.length > 30) fail_('ค่าใช้จ่ายสูงสุด 30 รายการ');
  costs.forEach(function (c) {
    db.insert('RepairCosts', { repair: r.id, amount: vNum_(c.amount, 'ค่าใช้จ่าย', 0, 1e8, true), kind: vOne_(String(c.kind || 'OTHER'), COST_KINDS, 'ประเภทค่าใช้จ่าย'), at: nowIso_(), note: vStr_(c.note, 'รายละเอียด', 300) });
  });
  db.update('Repairs', r.id, { status: 'ACCEPT' }, p.version);
  db.insert('RepairNotes', { repair: r.id, text: vStr_(p.note, 'หมายเหตุ', 1000) || 'ซ่อมเสร็จ รอตรวจรับ', at: nowIso_(), kind: 'COMPLETE', fromUser: me.id, toUser: '' });
  db.audit('COMPLETE_REPAIR', 'Repairs', r.id, 'ปิดงานซ่อม ' + r.code + ' รอตรวจรับ');
  db.notify('REPAIR_ACCEPT', 'Repairs:' + r.id, 'งานซ่อม ' + r.code + ' เสร็จแล้ว รอตรวจรับ');
  return { ok: true };
});
act_('editRepairCosts', { perm: 'finance' }, function (db, me, P, p) {
  var r = db.must('Repairs', p.id, 'งานซ่อม');
  if (r.status !== 'ACCEPT' && r.status !== 'DONE' && r.status !== 'REPAIR') fail_('แก้ค่าใช้จ่ายได้เฉพาะงานที่กำลังซ่อมหรือปิดงานแล้ว');
  (Array.isArray(p.costs) ? p.costs : []).forEach(function (c) {
    if (c.id) {
      var x = db.must('RepairCosts', c.id, 'ค่าใช้จ่าย');
      if (x.repair !== r.id) fail_('ค่าใช้จ่ายไม่ตรงกับงานซ่อม');
      if (c.remove) db.update('RepairCosts', x.id, { amount: 0, kind: 'VOID' }, c.version);
      else db.update('RepairCosts', x.id, { amount: vNum_(c.amount, 'ค่าใช้จ่าย', 0, 1e8, true), kind: vOne_(String(c.kind || 'OTHER'), COST_KINDS, 'ประเภท'), note: vStr_(c.note, 'รายละเอียด', 300) }, c.version);
    } else if (!c.remove) {
      db.insert('RepairCosts', { repair: r.id, amount: vNum_(c.amount, 'ค่าใช้จ่าย', 0, 1e8, true), kind: vOne_(String(c.kind || 'OTHER'), COST_KINDS, 'ประเภท'), at: nowIso_(), note: vStr_(c.note, 'รายละเอียด', 300) });
    }
  });
  db.audit('EDIT_REPAIR_COST', 'Repairs', r.id, 'แก้ค่าใช้จ่าย ' + r.code);
  return { ok: true };
});
act_('acceptRepair', { perm: 'inspect' }, function (db, me, P, p) {
  var r = db.must('Repairs', p.id, 'งานซ่อม');
  if (r.status !== 'ACCEPT') fail_('งานนี้ไม่ได้อยู่ในสถานะรอตรวจรับ');
  var ok = p.decision === 'ACCEPT', note = vStr_(p.note, 'หมายเหตุ', 1000, !ok);
  db.update('Repairs', r.id, { status: ok ? 'DONE' : 'REPAIR' }, p.version);
  if (ok) { var a = db.get('Assets', r.asset); if (a) mergeBack_(db, db.update('Assets', a.id, { condition: 'READY' })); }
  db.insert('RepairNotes', { repair: r.id, text: (ok ? 'ตรวจรับงานแล้ว' : 'ส่งกลับแก้ไข') + (note ? ': ' + note : ''), at: nowIso_(), kind: ok ? 'ACCEPT' : 'RETURN', fromUser: me.id, toUser: ok ? '' : r.assigned });
  db.audit(ok ? 'ACCEPT_REPAIR' : 'RETURN_REPAIR', 'Repairs', r.id, (ok ? 'ตรวจรับ ' : 'ส่งกลับแก้ไข ') + r.code);
  return { ok: true };
});

// ---------- ยืมคืน
act_('saveLoan', {}, function (db, me, P, p) {
  var h = {
    borrower: vStr_(p.borrower, 'ชื่อผู้ยืม', 100, true), phone: vPhone_(p.phone, false), responsible: checkUser_(db, String(p.responsible || me.id), 'ผู้รับผิดชอบ'),
    due: vDate_(p.due, 'กำหนดคืน', true), note: vStr_(p.note, 'หมายเหตุ', 500)
  };
  if (p.id) {
    var L = db.must('Loans', p.id, 'ใบยืม');
    if (L.status === 'RETURNED') fail_('ใบยืมนี้คืนครบแล้ว แก้ไขไม่ได้');
    if (h.due < L.start) fail_('กำหนดคืนต้องไม่ก่อนวันยืม');
    db.update('Loans', L.id, h, p.version);
    db.audit('UPDATE_LOAN', 'Loans', L.id, 'แก้ใบยืม ' + L.code);
    return { id: L.id };
  }
  h.start = vDate_(p.start || today_(), 'วันยืม', true);
  if (h.due < h.start) fail_('กำหนดคืนต้องไม่ก่อนวันยืม');
  var dest = p.destination ? checkLocation_(db, String(p.destination), 'สถานที่ปลายทาง') : null;
  var lines = Array.isArray(p.lines) ? p.lines : [];
  if (!lines.length) fail_('กรุณาเลือกสิ่งของที่ยืมอย่างน้อย 1 รายการ');
  if (lines.length > 50) fail_('ใบยืมหนึ่งใบมีได้ไม่เกิน 50 รายการ');
  var seen = {};
  h.code = docCode_(db, 'Loans', 'LN'); h.destination = dest ? dest.id : ''; h.status = 'OPEN';
  var L2 = db.insert('Loans', h);
  lines.forEach(function (ln) {
    var a = db.must('Assets', ln.asset, 'สิ่งของ');
    if (seen[a.id]) fail_('"' + a.name + '" ถูกเลือกซ้ำ'); seen[a.id] = 1;
    assertAvailable_(a, 'ยืม');
    if (a.condition === 'DAMAGED') fail_('"' + a.name + '" ชำรุดอยู่ ไม่สามารถให้ยืมได้');
    if (openRepairOf_(db, a.id) || pendingDisposalOf_(db, a.id)) fail_('"' + a.name + '" อยู่ระหว่างซ่อม/รอจำหน่าย');
    var qty = partQty_(a, ln.qty), origin = a.location;
    var part = takePart_(db, a, qty, { condition: 'LOANED', location: dest ? dest.id : a.location, loan: L2.id });
    db.insert('LoanLines', { loan: L2.id, asset: part.id, original: a.id, qty: qty, returned: 0, origin: origin });
    addMovement_(db, a, part.id !== a.id ? part : null, qty, origin, part.location, 'LOAN', 'ยืมโดย ' + h.borrower, h.code);
  });
  db.audit('CREATE_LOAN', 'Loans', L2.id, 'สร้างใบยืม ' + h.code + ' ผู้ยืม ' + h.borrower + ' ' + lines.length + ' รายการ');
  return { id: L2.id, code: h.code };
});
act_('returnLoan', {}, function (db, me, P, p) {
  var L = db.must('Loans', p.id, 'ใบยืม');
  if (L.status === 'RETURNED') fail_('ใบยืมนี้คืนครบแล้ว');
  if (p.version !== undefined && p.version !== '' && String(L.version) !== String(p.version)) throw err_('E_VERSION', 'ข้อมูลถูกแก้ไขแล้ว กรุณาโหลดใหม่');
  var lines = (Array.isArray(p.lines) ? p.lines : []).filter(function (x) { return Number(x.qty) > 0; });
  if (!lines.length) fail_('กรุณาระบุจำนวนที่คืนอย่างน้อย 1 รายการ');
  lines.forEach(function (x) {
    var ln = db.must('LoanLines', x.line, 'รายการยืม');
    if (ln.loan !== L.id) fail_('รายการไม่ตรงกับใบยืม');
    var remain = num_(ln.qty) - num_(ln.returned);
    var qty = vInt_(x.qty, 'จำนวนคืน', 1, remain, true);
    var to = checkLocation_(db, String(x.to || ln.origin || 'CENTRAL'), 'สถานที่รับคืน');
    var cond = vOne_(String(x.condition || 'READY'), ['READY', 'DAMAGED'], 'สภาพของที่คืน');
    var a = db.must('Assets', ln.asset, 'สิ่งของที่ยืม'), dest;
    if (a.type !== 'QUANTITY' || qty >= num_(a.qty)) {
      dest = db.update('Assets', a.id, { location: to.id, condition: cond, loan: '' });
      dest = mergeBack_(db, dest);
    } else dest = splitLot_(db, a, qty, { location: to.id, condition: cond, loan: '' }, true);
    db.update('LoanLines', ln.id, { returned: num_(ln.returned) + qty });
    db.insert('LoanReturns', { loan: L.id, line: ln.id, asset: a.id, destinationAsset: dest.id, qty: qty, to: to.id, condition: cond, at: nowIso_(), note: vStr_(x.note, 'หมายเหตุ', 300) });
    addMovement_(db, a, dest.id !== a.id ? dest : null, qty, a.location, to.id, 'RETURN', 'คืนจาก ' + L.borrower + (cond === 'DAMAGED' ? ' (ชำรุด)' : ''), L.code);
  });
  var all = db.rows('LoanLines').filter(function (l) { return l.loan === L.id; });
  var done = all.every(function (l) { return num_(l.returned) >= num_(l.qty); });
  db.update('Loans', L.id, { status: done ? 'RETURNED' : 'PARTIAL' });
  db.audit('RETURN_LOAN', 'Loans', L.id, 'รับคืน ' + L.code + (done ? ' ครบ' : ' บางส่วน'));
  return { done: done };
});

// ---------- จำหน่าย
act_('saveDisposal', { perm: 'register' }, function (db, me, P, p) {
  if (p.id) {
    var d = db.must('Disposals', p.id, 'คำขอจำหน่าย');
    if (d.status !== 'PENDING') fail_('แก้ได้เฉพาะคำขอที่รออนุมัติ');
    var patch = { reason: checkOption_(db, 'reasons', String(p.reason || ''), 'เหตุผลจำหน่าย', true), note: vStr_(p.note, 'หมายเหตุ', 1000) };
    db.update('Disposals', d.id, patch, p.version);
    db.audit('UPDATE_DISPOSAL', 'Disposals', d.id, 'แก้คำขอจำหน่าย ' + d.code);
    return { id: d.id };
  }
  var a = db.must('Assets', p.asset, 'สิ่งของ');
  if (openRepairOf_(db, a.id)) fail_('"' + a.name + '" มีงานซ่อมที่ยังไม่ปิด ไม่สามารถเสนอจำหน่ายได้');
  if (pendingDisposalOf_(db, a.id)) fail_('"' + a.name + '" มีคำขอจำหน่ายรออนุมัติอยู่แล้ว');
  assertAvailable_(a, 'เสนอจำหน่าย');
  var qty = partQty_(a, p.qty);
  var reason = checkOption_(db, 'reasons', String(p.reason || ''), 'เหตุผลจำหน่าย', true);
  var part = takePart_(db, a, qty, { condition: 'PENDING_DISPOSAL' });
  var nd = db.insert('Disposals', { code: docCode_(db, 'Disposals', 'DP'), asset: a.id, disposedAsset: part.id, qty: qty, reason: reason, note: vStr_(p.note, 'หมายเหตุ', 1000), status: 'PENDING', created: nowIso_(), approvedBy: '', approvedAt: '', approvalNote: '' });
  if (part.id !== a.id) addMovement_(db, a, part, qty, a.location, a.location, 'SPLIT', 'แยกเสนอจำหน่าย', nd.code);
  db.audit('PROPOSE_DISPOSAL', 'Disposals', nd.id, 'เสนอจำหน่าย ' + nd.code + ' ' + a.name + ' ' + qty + ' ' + (a.unit || ''));
  db.notify('DISPOSAL_NEW', 'Disposals:' + nd.id, 'เสนอจำหน่าย ' + nd.code + '\n' + a.name + ' ' + qty + ' ' + (a.unit || '') + '\nเหตุผล: ' + reason);
  return { id: nd.id, code: nd.code };
});
act_('decideDisposal', { admin: true }, function (db, me, P, p) {
  var d = db.must('Disposals', p.id, 'คำขอจำหน่าย');
  if (d.status !== 'PENDING') fail_('คำขอนี้พิจารณาแล้ว');
  var approve = p.decision === 'APPROVE', note = vStr_(p.note, 'หมายเหตุ', 500, !approve);
  db.update('Disposals', d.id, { status: approve ? 'APPROVED' : 'REJECTED', approvedBy: me.id, approvedAt: nowIso_(), approvalNote: note }, p.version);
  var a = db.get('Assets', d.disposedAsset);
  if (a) {
    if (approve) {
      db.update('Assets', a.id, { condition: 'DISPOSED' });
      addMovement_(db, a, null, d.qty, a.location, '', 'DISPOSE', d.reason, d.code);
    } else {
      var wasDamaged = db.rows('Repairs').some(function (r) { return (r.asset === a.id || r.asset === d.asset) && r.status === 'REJECT'; });
      mergeBack_(db, db.update('Assets', a.id, { condition: wasDamaged ? 'DAMAGED' : 'READY' }));
    }
  }
  db.insert('Approvals', { entity: 'Disposals', entityId: d.id, decision: approve ? 'APPROVE' : 'REJECT', amount: '', reason: note, at: nowIso_() });
  db.audit(approve ? 'APPROVE_DISPOSAL' : 'REJECT_DISPOSAL', 'Disposals', d.id, (approve ? 'อนุมัติ' : 'ไม่อนุมัติ') + 'จำหน่าย ' + d.code);
  return { ok: true };
});

// ---------- ไฟล์แนบ
var FILE_ENTITIES = { Assets: 1, Repairs: 1, Loans: 1, Disposals: 1 };
function canSeeEntity_(db, P, me, entity, id) {
  if (!FILE_ENTITIES[entity]) return false;
  var x = db.get(entity, id);
  if (!x) return false;
  if (entity === 'Repairs') return canSeeRepair_(P, me, x);
  return true;
}
function sniffMime_(b) {
  var u = function (i) { return b[i] & 255; };
  if (b.length > 3 && u(0) === 0xFF && u(1) === 0xD8 && u(2) === 0xFF) return 'image/jpeg';
  if (b.length > 8 && u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47) return 'image/png';
  if (b.length > 12 && u(0) === 0x52 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x46 && u(8) === 0x57 && u(9) === 0x45 && u(10) === 0x42 && u(11) === 0x50) return 'image/webp';
  if (b.length > 5 && u(0) === 0x25 && u(1) === 0x50 && u(2) === 0x44 && u(3) === 0x46 && u(4) === 0x2D) return 'application/pdf';
  return '';
}
function driveFolder_(kind) {
  var id = prop_(kind === 'pdf' ? 'DRIVE_PDF' : 'DRIVE_IMG');
  if (!id) throw err_('E_SETUP', 'ยังไม่ได้สร้างโฟลเดอร์ Drive กรุณารัน setupDatabase');
  return DriveApp.getFolderById(id);
}
/**
 * อัปโหลดไฟล์ (แบ่งส่วนได้ เพราะ Vercel จำกัด body 4.5 MB): ส่วนที่ไม่ใช่ส่วนสุดท้ายเก็บเป็นไฟล์ชั่วคราวใน Drive
 */
function uploadFile_(ctx, p) {
  var me = ctx.user, db = ctx.db, P = perms_(db, me);
  var entity = String(p.entity || ''), entityId = String(p.entityId || '');
  if (!canSeeEntity_(db, P, me, entity, entityId)) deny_('ไม่พบรายการที่จะแนบไฟล์ หรือคุณไม่มีสิทธิ์');
  var part = Number(p.part || 0), parts = Number(p.parts || 1), upId = String(p.uploadId || '');
  if (!(parts >= 1 && parts <= 3 && part >= 0 && part < parts)) fail_('ข้อมูลการอัปโหลดไม่ถูกต้อง');
  if (parts > 1 && !/^[a-zA-Z0-9]{16,40}$/.test(upId)) fail_('ข้อมูลการอัปโหลดไม่ถูกต้อง');
  var bytes = Utilities.base64Decode(String(p.data || ''));
  if (!bytes.length || bytes.length > FILE_PART + 16) fail_('ขนาดไฟล์ส่วนนี้ไม่ถูกต้อง');
  var tmpFolder = driveFolder_('pdf');
  if (part < parts - 1) {
    tmpFolder.createFile(Utilities.newBlob(bytes, 'application/octet-stream', 'tmp_' + upId + '_' + part)).setDescription('temp upload');
    return { part: part, pending: true };
  }
  var all = bytes;
  if (parts > 1) {
    var pieces = [];
    for (var i = 0; i < parts - 1; i++) {
      var it = tmpFolder.getFilesByName('tmp_' + upId + '_' + i);
      if (!it.hasNext()) fail_('ไฟล์ส่วนที่ ' + (i + 1) + ' หายไป กรุณาอัปโหลดใหม่');
      var f = it.next(); pieces.push(f.getBlob().getBytes()); f.setTrashed(true);
    }
    all = [];
    pieces.concat([bytes]).forEach(function (pc) { for (var k = 0; k < pc.length; k++) all.push(pc[k]); });
  }
  var mime = sniffMime_(all);
  if (!mime) fail_('รองรับเฉพาะไฟล์ภาพ (JPEG/PNG/WebP) และ PDF เท่านั้น');
  if (mime === 'application/pdf' ? all.length > MAX_FILE : all.length > MAX_IMAGE) fail_(mime === 'application/pdf' ? 'ไฟล์ PDF ต้องไม่เกิน 5 MB' : 'ไฟล์ภาพต้องไม่เกิน 512 KB');
  var name = vStr_(p.name, 'ชื่อไฟล์', 120) || ('file_' + Date.now());
  name = name.replace(/[\\/:*?"<>|]/g, '_');
  var res = runTx_(me.id, 'uploadFile', p.requestId, { e: entity, i: entityId, n: name, s: all.length, part: part }, function (db2) {
    var count = db2.rows('Files').filter(function (f) { return f.entity === entity && f.entityId === entityId; }).length;
    if (count >= 30) fail_('แนบไฟล์ได้สูงสุด 30 ไฟล์ต่อรายการ');
    var file = driveFolder_(mime === 'application/pdf' ? 'pdf' : 'img').createFile(Utilities.newBlob(all, mime, name));
    var x = db2.insert('Files', { entity: entity, entityId: entityId, driveId: file.getId(), name: name, mime: mime, size: all.length, at: nowIso_() });
    db2.audit('UPLOAD_FILE', entity, entityId, 'แนบไฟล์ ' + name);
    return { id: x.id };
  });
  return res;
}
function getFile_(ctx, p) {
  var db = ctx.db, me = ctx.user, P = perms_(db, me);
  var f = db.must('Files', p.id, 'ไฟล์');
  if (!canSeeEntity_(db, P, me, f.entity, f.entityId)) deny_('คุณไม่มีสิทธิ์เปิดไฟล์นี้');
  var bytes = DriveApp.getFileById(f.driveId).getBlob().getBytes();
  var parts = Math.max(1, Math.ceil(bytes.length / FILE_PART)), part = Math.min(Number(p.part || 0), parts - 1);
  return { name: f.name, mime: f.mime, size: bytes.length, part: part, parts: parts, data: Utilities.base64Encode(bytes.slice(part * FILE_PART, (part + 1) * FILE_PART)) };
}

// ---------- ประวัติ / โครงสร้าง / แจ้งเตือน
function auditPage_(ctx, p) {
  var P = perms_(ctx.db, ctx.user);
  if (!(P.admin || P.manager)) deny_();
  var t = ctx.db.snap.t.AuditLogs, end = Math.min(Number(p.before) || t.s, t.s) - 1;
  if (end < 2) return { rows: [], next: 0 };
  var start = Math.max(2, end - 199), sh = sheet_('AuditLogs');
  var v = normRows_(sh.getRange(start, 1, end - start + 1, t.h.length).getValues(), t.h.length);
  return { h: t.h, rows: v, next: start > 2 ? start : 0 };
}
function schema_(ctx) {
  if (!perms_(ctx.db, ctx.user).admin) deny_();
  var snap = ctx.db.snap, out = [];
  SNAP_TABLES.forEach(function (n) {
    var t = snap.t[n];
    out.push({ name: n, columns: t.h, rows: Math.max(0, t.last - 1), mode: WINDOW_TABLES[n] ? 'window ' + WINDOW_TABLES[n] + ' แถวท้าย' : 'snapshot' });
  });
  RAW_TABLES.forEach(function (n) { var sh = sheet_(n); out.push({ name: n, columns: snap.raw[n], rows: Math.max(0, sh.getLastRow() - 1), mode: 'ไม่โหลดเข้า snapshot' }); });
  return { tables: out, rev: snap.rev, snapshotAt: snap.at, dbUrl: ss_().getUrl() };
}
act_('notifySave', { admin: true, journal: false }, function (db, me, P, p) {
  var tg = vStr_(p.telegramToken, 'Telegram token', 200), tc = vStr_(p.telegramChat, 'Telegram chat id', 60);
  var lt = vStr_(p.lineToken, 'LINE token', 400), lto = vStr_(p.lineTo, 'LINE user/group id', 80);
  if (tg) setProp_('TG_TOKEN', tg);
  if (tc) setProp_('TG_CHAT', tc);
  if (lt) setProp_('LINE_TOKEN', lt);
  if (lto) setProp_('LINE_TO', lto);
  db.audit('NOTIFY_CONFIG', 'Settings', '', 'ตั้งค่าการแจ้งเตือน' + (tg || tc ? ' Telegram' : '') + (lt || lto ? ' LINE' : ''));
  return { ok: true };
});
act_('notifyClear', { admin: true, journal: false }, function (db, me, P, p) {
  var ch = vOne_(String(p.channel || ''), ['TELEGRAM', 'LINE'], 'ช่องทาง');
  if (ch === 'TELEGRAM') { delProp_('TG_TOKEN'); delProp_('TG_CHAT'); } else { delProp_('LINE_TOKEN'); delProp_('LINE_TO'); }
  db.audit('NOTIFY_CLEAR', 'Settings', '', 'ล้างการเชื่อมต่อ ' + ch);
  return { ok: true };
});
act_('notifyTest', { admin: true, journal: false, sendAfter: true }, function (db, me, P, p) {
  if (!notifyChannels_().length) fail_('ยังไม่ได้ตั้งค่าช่องทางแจ้งเตือน');
  db.notify('TEST', '', 'ทดสอบการแจ้งเตือนจาก ' + me.name + ' เวลา ' + Utilities.formatDate(new Date(), TZ, 'HH:mm'));
  return { ok: true };
});
act_('notifyRetry', { admin: true, journal: false, sendAfter: true }, function (db, me, P, p) {
  var n = db.must('Notifications', p.id, 'รายการแจ้งเตือน');
  if (n.status === 'SENT') fail_('รายการนี้ส่งสำเร็จแล้ว');
  db.update('Notifications', n.id, { status: 'PENDING', attempts: 0, nextAttempt: nowIso_(), lastError: '', claim: '' });
  db.markQueue();
  return { ok: true };
});

// ---------- ข้อมูลตัวอย่าง (ผู้ดูแลกดเพิ่มเอง มีป้าย [ตัวอย่าง])
act_('addSampleData', { admin: true }, function (db, me) { return sampleData_(db, me); });
function sampleData_(db, me) {
  if (db.rows('Assets').some(function (a) { return a.name.indexOf('[ตัวอย่าง]') === 0; })) fail_('มีข้อมูลตัวอย่างอยู่แล้ว');
  var locs = db.rows('Locations').filter(function (l) { return bool_(l.active); }).map(function (l) { return l.id; });
  var pick = function (i) { return locs[i % locs.length]; };
  var list = [
    ['เครื่องปรับอากาศ 12000 BTU', 'เครื่องใช้ไฟฟ้า', 'Daikin', 'เครื่อง', 'UNIT', 1, 18500],
    ['ทีวี LED 43 นิ้ว', 'เครื่องใช้ไฟฟ้า', 'Samsung', 'เครื่อง', 'UNIT', 1, 12900],
    ['ตู้เย็นมินิบาร์', 'เครื่องใช้ไฟฟ้า', 'Sharp', 'เครื่อง', 'UNIT', 1, 5900],
    ['เตียงเดี่ยว 3.5 ฟุต', 'เฟอร์นิเจอร์', '', 'ชิ้น', 'UNIT', 1, 7500],
    ['โต๊ะทำงานไม้สัก', 'เฟอร์นิเจอร์', '', 'ตัว', 'UNIT', 1, 4200],
    ['ผ้าเช็ดตัวสีขาว', 'ผ้าและสิ่งทอ', '', 'ผืน', 'QUANTITY', 120, 180],
    ['ผ้าปูที่นอน 6 ฟุต', 'ผ้าและสิ่งทอ', '', 'ผืน', 'QUANTITY', 60, 650],
    ['แก้วน้ำใส', 'อุปกรณ์ครัว', '', 'ใบ', 'QUANTITY', 200, 35],
    ['ไดร์เป่าผม', 'อุปกรณ์ห้องพัก', 'Philips', 'เครื่อง', 'UNIT', 1, 890],
    ['เก้าอี้สระว่ายน้ำ', 'อุปกรณ์สระว่ายน้ำ', '', 'ตัว', 'QUANTITY', 24, 1500],
    ['สว่านไร้สาย', 'เครื่องมือช่าง', '', 'เครื่อง', 'UNIT', 1, 3200],
    ['เครื่องพิมพ์เลเซอร์', 'อุปกรณ์สำนักงาน', '', 'เครื่อง', 'UNIT', 1, 6900]
  ];
  var made = [];
  list.forEach(function (x, i) {
    var it = itemFor_(db, '[ตัวอย่าง] ' + x[0], x[1], x[4], x[3]);
    var loc = x[4] === 'QUANTITY' ? 'CENTRAL' : pick(i + 1);
    var a = db.insert('Assets', { code: assetCode_(db, x[4]), item: it.id, batch: '', name: '[ตัวอย่าง] ' + x[0], brand: x[2], group: x[1], type: x[4], qty: x[5], unit: x[3], price: x[6], year: 2567, purchase: '', received: today_(), location: loc, condition: 'READY', responsible: '', serial: x[4] === 'UNIT' ? 'SN-DEMO-' + (1000 + i) : '', note: 'ข้อมูลตัวอย่าง ลบหรือจำหน่ายได้', loan: '' });
    if (x[4] === 'QUANTITY') db.update('Assets', a.id, { batch: a.id });
    addMovement_(db, a, null, x[5], '', loc, 'RECEIVE', 'ข้อมูลตัวอย่าง');
    made.push(a);
  });
  db.audit('SAMPLE_DATA', 'Assets', '', 'เพิ่มข้อมูลตัวอย่าง ' + made.length + ' รายการ');
  return { count: made.length };
}

// ============================================================ 7) Web app entry
function doGet() {
  return ContentService.createTextOutput('วังยาว API ' + APP_VERSION + ' — ใช้งานผ่านหน้าเว็บบน Vercel เท่านั้น').setMimeType(ContentService.MimeType.TEXT);
}
function doPost(e) {
  var t0 = Date.now(), out;
  try {
    var body = e && e.postData ? e.postData.contents : '';
    if (!body || body.length > 9000000) throw err_('E_INPUT', 'คำขอไม่ถูกต้อง');
    var req = verifyBridge_(JSON.parse(body));
    out = { ok: true, data: route_(req) };
  } catch (err) {
    var known = !!err.code;
    if (!known) console.error(err && err.stack ? err.stack : err);
    out = { ok: false, error: { code: known ? err.code : 'E_SERVER', message: known ? err.message : 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง' } };
  }
  out.ms = Date.now() - t0;
  var s = JSON.stringify(out);
  if (s.length > 20000) s = JSON.stringify({ z: Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(s, 'application/json')).getBytes()), ms: out.ms });
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}
function verifyBridge_(env) {
  var secret = prop_('BRIDGE_SECRET');
  if (!secret) throw err_('E_SETUP', 'ยังไม่ได้เชื่อมต่อ Vercel กรุณารันเมนู "เชื่อมต่อ Vercel"');
  if (!env || typeof env.b !== 'string' || typeof env.s !== 'string') throw err_('E_BRIDGE', 'คำขอไม่ถูกต้อง');
  if (!safeEq_(hmacHex_(env.b, secret), String(env.s).toLowerCase())) throw err_('E_BRIDGE', 'ลายเซ็นคำขอไม่ถูกต้อง (ตรวจ GAS_BRIDGE_SECRET บน Vercel)');
  var req = JSON.parse(env.b);
  if (!req.ts || Math.abs(Date.now() - Number(req.ts)) > 90000) throw err_('E_BRIDGE', 'คำขอหมดอายุ กรุณาลองใหม่');
  var nk = 'NONCE:' + String(req.n || '').slice(0, 64), c = cache_();
  if (!req.n || c.get(nk)) throw err_('E_BRIDGE', 'คำขอซ้ำ');
  c.put(nk, '1', 120);
  return req;
}
function route_(req) {
  var p = req.p || {};
  switch (req.m) {
    case 'ping': var s = loadSnapshot_(); return { pong: true, rev: s.rev, config: publicSettings_(new Db_(s), null) };
    case 'getPublicConfig': return publicSettings_(new Db_(loadSnapshot_()), null);
    case 'authContext': return authContext_(p);
    case 'login': return login_(p);
    case 'loginGoogle': return loginGoogle_(p);
    case 'register': return register_(p);
    case 'requestPasswordReset': return requestReset_(p);
    case 'resetPassword': return resetPassword_(p);
    case 'logout': return logout_(p);
    case 'api': return api_(p);
  }
  throw err_('E_INPUT', 'ไม่รู้จักคำสั่ง');
}

// ------------------------------------------------------------ บัญชี (ไม่ต้องล็อกอิน)
function statusCheck_(u) {
  if (u.status === 'PENDING') throw err_('E_LOGIN', 'บัญชีของคุณรอผู้ดูแลอนุมัติ');
  if (u.status !== 'ACTIVE') throw err_('E_LOGIN', 'บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแล');
}
/** gateway ขอ salt/rounds ก่อนคำนวณ PBKDF2 (ไม่พบผู้ใช้ตอบ salt ปลอมที่คงที่ กัน user enumeration) */
function authContext_(p) {
  var u = null;
  if (p.token) u = auth_(p.token).user;
  else u = findUser_(new Db_(loadSnapshot_()), p.identifier);
  if (u && u.passwordSalt) return { salt: u.passwordSalt, rounds: Number(u.passwordRounds) || PBKDF2_ROUNDS };
  return { salt: hmacHex_('fake:' + String(p.identifier || '').trim().toLowerCase(), pepper_()).slice(0, 32), rounds: PBKDF2_ROUNDS };
}
function startSession_(uid, action, text, extra) {
  var db = extra
    ? runTx_(uid, action, null, null, function (db2) { extra(db2, db2.me()); }, { journal: false }).db
    : new Db_(loadSnapshot_(), uid);
  var u = db.me();
  var token = createSession_(u, action, text);
  return { token: token, user: meOf_(u), state: buildState_(db, u) };
}
function login_(p) {
  var ident = String(p.identifier || '').trim();
  if (!ident) fail_('กรุณากรอกอีเมลหรือเบอร์โทร');
  var key = rlKey_('login', ident);
  rlCheck_(key, 8, 'ลองเข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่');
  var u = findUser_(new Db_(loadSnapshot_()), ident);
  var ok = !!(u && u.passwordHash && safeEq_(String(p.derived || '').toLowerCase(), u.passwordHash));
  if (!ok) { rlHit_(key, 900); throw err_('E_LOGIN', 'อีเมล/เบอร์โทร หรือรหัสผ่านไม่ถูกต้อง'); }
  statusCheck_(u);
  cache_().remove(key);
  return startSession_(u.id, 'LOGIN', 'เข้าสู่ระบบ');
}
function loginGoogle_(p) {
  var db = new Db_(loadSnapshot_()), g = db.setting('googleLogin', {}) || {};
  if (!g.enabled || !g.clientId) throw err_('E_LOGIN', 'ยังไม่ได้เปิดใช้การเข้าสู่ระบบด้วย Google');
  if (p.aud !== g.clientId || !p.sub || !p.emailVerified) throw err_('E_LOGIN', 'ยืนยันตัวตนกับ Google ไม่สำเร็จ');
  var email = String(p.email || '').toLowerCase(), u = null;
  db.rows('Users').forEach(function (x) { if (!u && x.googleSub && x.googleSub === p.sub) u = x; });
  if (!u) db.rows('Users').forEach(function (x) { if (!u && !x.googleSub && email && String(x.email).toLowerCase() === email) u = x; });
  if (!u) throw err_('E_LOGIN', 'ไม่พบบัญชีที่ผูกกับ Google นี้ กรุณาสมัครสมาชิกหรือติดต่อผู้ดูแล');
  statusCheck_(u);
  var link = !u.googleSub;
  return startSession_(u.id, 'LOGIN_GOOGLE', 'เข้าสู่ระบบด้วย Google', link ? function (db2, u2) { db2.update('Users', u2.id, { googleSub: String(p.sub) }); } : null);
}
function register_(p) {
  var rk = rlKey_('reg', p.ip || 'x');
  rlCheck_(rk, 5, 'สมัครสมาชิกบ่อยเกินไป กรุณาลองใหม่ภายหลัง');
  var res = runTx_('system', 'register', null, null, function (db) {
    if (db.setting('allowRegister', true) === false) fail_('ระบบปิดรับสมัครสมาชิก กรุณาติดต่อผู้ดูแล');
    var d = { name: vStr_(p.name, 'ชื่อ-นามสกุล', 100, true), email: vEmail_(p.email, false), phone: vPhone_(p.phone, false),
      department: p.department ? checkOption_(db, 'departments', String(p.department), 'แผนก') : '' };
    if (!d.email && !d.phone) fail_('กรุณากรอกอีเมลหรือเบอร์โทรอย่างน้อยหนึ่งอย่าง');
    uniqueUser_(db, '', d.email, d.phone);
    var pw = vPw_(p.pw);
    for (var k in pw) d[k] = pw[k];
    d.role = 'STAFF'; d.status = 'PENDING'; d.mustChangePassword = 'FALSE'; d.googleSub = '';
    var u = db.insert('Users', d);
    db.update('Users', u.id, { owner: u.id });
    db.audit('REGISTER', 'Users', u.id, 'สมัครสมาชิก ' + d.name);
    db.notify('USER_REGISTER', 'Users:' + u.id, 'มีผู้สมัครสมาชิกใหม่: ' + d.name + (d.department ? ' (' + d.department + ')' : '') + '\nกรุณาอนุมัติในเมนู อนุมัติรายการ');
    return { ok: true };
  });
  rlHit_(rk, 3600);
  return res.data;
}
function requestReset_(p) {
  var ident = String(p.identifier || '').trim();
  var msg = { ok: true, message: 'ถ้าข้อมูลถูกต้อง ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว (ลิงก์ใช้ได้ 15 นาที)' };
  if (!ident) fail_('กรุณากรอกอีเมลหรือเบอร์โทร');
  var k1 = rlKey_('reset', ident), k2 = rlKey_('resetip', p.ip || 'x');
  rlCheck_(k1, 3, 'ขอรีเซ็ตรหัสผ่านบ่อยเกินไป กรุณารอ 15 นาที');
  rlCheck_(k2, 10, 'ขอรีเซ็ตรหัสผ่านบ่อยเกินไป กรุณารอสักครู่');
  rlHit_(k1, 900); rlHit_(k2, 900);
  var db = new Db_(loadSnapshot_()), u = findUser_(db, ident);
  if (!u || u.status !== 'ACTIVE' || !u.email) return msg;
  var base = String(db.setting('webUrl', '') || p.origin || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) { console.warn('ไม่มี webUrl สำหรับลิงก์รีเซ็ต'); return msg; }
  var token = randHex_(64), h = tokenHash_(token), exp = Date.now() + 15 * 60000;
  runTx_(u.id, 'requestReset', null, null, function (db2) {
    db2.appendRaw('AuthTokens', { tokenHash: h, user: u.id, purpose: 'RESET', expiresAt: new Date(exp).toISOString(), usedAt: '' });
    db2.audit('REQUEST_RESET', 'Users', u.id, 'ขอรีเซ็ตรหัสผ่าน');
  }, { journal: false });
  cachePutJ_('RST:' + h, { u: u.id, exp: exp }, 900);
  var link = base + '/?reset=' + token, biz = db.setting('businessName', 'วังยาวรีสอร์ท');
  MailApp.sendEmail({
    to: u.email, subject: '[' + biz + '] ตั้งรหัสผ่านใหม่',
    htmlBody: '<div style="font-family:sans-serif;font-size:15px;color:#3a3956">สวัสดีคุณ ' + String(u.name).replace(/[<>&"]/g, '') +
      '<br><br>กดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่ (ใช้ได้ครั้งเดียว ภายใน 15 นาที)<br><br><a href="' + link + '" style="background:#a8e8d2;color:#1f4a42;padding:10px 18px;border-radius:12px;text-decoration:none">ตั้งรหัสผ่านใหม่</a>' +
      '<br><br>ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้</div>',
    body: 'ตั้งรหัสผ่านใหม่ (ใช้ได้ 15 นาที): ' + link
  });
  return msg;
}
function resetPassword_(p) {
  var token = String(p.token || '');
  if (!/^[0-9a-f]{64}$/.test(token)) fail_('ลิงก์ไม่ถูกต้องหรือหมดอายุ');
  var h = tokenHash_(token), t = readRawTable_('AuthTokens'), row = null;
  for (var i = t.rows.length - 1; i >= 0; i--) if (t.rows[i].tokenHash === h) { row = t.rows[i]; break; }
  if (!row || row.purpose !== 'RESET' || row.usedAt || new Date(row.expiresAt).getTime() < Date.now()) fail_('ลิงก์ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว กรุณาขอใหม่');
  var pw = vPw_(p.pw);
  runTx_(row.user, 'resetPassword', null, null, function (db) {
    var u = db.must('Users', row.user, 'ผู้ใช้');
    pw.mustChangePassword = 'FALSE';
    db.update('Users', u.id, pw);
    db.audit('RESET_PASSWORD', 'Users', u.id, 'ตั้งรหัสผ่านใหม่ผ่านอีเมล');
  });
  t.sh.getRange(row._row, t.h.indexOf('usedAt') + 1).setValue(nowIso_());
  cache_().remove('RST:' + h);
  revokeSessions_(row.user);
  return { ok: true };
}
function logout_(p) {
  if (!p.token || String(p.token).length < 64) return { ok: true };
  var h = tokenHash_(p.token), s = cacheGetJ_(sessKey_(h));
  cache_().remove(sessKey_(h));
  flushLoginQueue_();
  var t = readRawTable_('Sessions'), col = t.h.indexOf('revokedAt') + 1;
  for (var i = t.rows.length - 1; i >= 0; i--) {
    if (t.rows[i].tokenHash === h) { if (!t.rows[i].revokedAt) t.sh.getRange(t.rows[i]._row, col).setValue(nowIso_()); s = s || { u: t.rows[i].user }; break; }
  }
  if (s && s.u) {
    try { runTx_(s.u, 'LOGOUT', null, null, function (db) { db.audit('LOGOUT', 'Users', s.u, 'ออกจากระบบ'); }, { journal: false }); } catch (e) { console.warn(e); }
  }
  return { ok: true };
}

// ------------------------------------------------------------ API (ต้องล็อกอิน)
function api_(p) {
  var action = String(p.action || ''), payload = p.payload || {};
  if (action === 'getState' && p.rev && p.rev === prop_('STATE_REV')) {
    // ข้อมูลไม่เปลี่ยนตั้งแต่ rev ที่หน้าเว็บมี: ตรวจเซสชันจากแคชอย่างเดียว ไม่ต้องโหลด snapshot
    var h = tokenHash_(String(p.token || '')), s = cacheGetJ_(sessKey_(h));
    if (s && !s.revoked && s.exp > Date.now()) return { unchanged: true, rev: p.rev };
  }
  var ctx = auth_(p.token), me = ctx.user;
  if (action === 'getState') return { state: buildState_(ctx.db, me) };
  if (action === 'getFile') return { data: getFile_(ctx, payload) };
  if (action === 'auditPage') return { data: auditPage_(ctx, payload) };
  if (action === 'getSchema') return { data: schema_(ctx) };
  if (bool_(me.mustChangePassword) && action !== 'changePassword') throw err_('E_MUSTCHANGE', 'กรุณาเปลี่ยนรหัสผ่านชั่วคราวก่อนใช้งาน');
  if (action === 'uploadFile') {
    payload.requestId = p.requestId;
    var up = uploadFile_(ctx, payload);
    if (up.pending) return { data: up };
    return withState_(up, me.id, p.rev);
  }
  var A = ACTIONS[action];
  if (!A) throw err_('E_INPUT', 'ไม่รู้จักคำสั่งนี้');
  var res = runTx_(me.id, action, p.requestId, payload, function (db) {
    var u = db.me();
    if (!u || u.status !== 'ACTIVE') throw err_('E_AUTH', 'บัญชีนี้ถูกปิดการใช้งาน');
    var P = perms_(db, u);
    if (A.admin && !P.admin) deny_('เฉพาะผู้ดูแลระบบเท่านั้น');
    if (A.perm && !P[A.perm]) deny_();
    return A.fn(db, u, P, payload, ctx);
  }, { journal: A.journal !== false });
  if (A.sendAfter) { try { processNotifications_(); } catch (e) { console.warn(e); } res.changed = null; res.db = null; }
  return withState_(res, me.id, p.rev);
}
/** คำตอบของ action ที่เขียนข้อมูล: {data, state} (ส่งเฉพาะตารางที่เปลี่ยนถ้าหน้าเว็บมี rev ก่อนหน้า) */
function withState_(res, uid, clientRev) {
  var db = res.db;
  if (!db) db = new Db_(loadSnapshot_(), uid);
  var u = db.get('Users', uid) || db.me();
  var partial = !!(res.changed && res.prevRev && clientRev && clientRev === res.prevRev);
  return { data: res.data, state: buildState_(db, u, partial ? res.changed : null, partial ? res.ids : null) };
}

// ============================================================ 8) Triggers / Notifications / Cleanup
function cronMinute() {
  try { recoverPending_(); } catch (e) { console.error('recover: ' + e); }
  try { flushLoginQueue_(); } catch (e) { console.error('logins: ' + e); }
  try { warmSnapshot_(); } catch (e) { console.error('warm: ' + e); }
  try { processNotifications_(); } catch (e) { console.error('notify: ' + e); }
  try { dueCheck_(); } catch (e) { console.error('due: ' + e); }
}
function warmSnapshot_() {
  var rev = prop_('STATE_REV'), meta = cacheGetJ_('SN:meta');
  if (!rev || !meta || meta.rev !== rev) { loadSnapshot_(); return 'rebuilt'; }
  if (Date.now() - Number(meta.at || 0) > 4 * 3600e3) { invalidate_(); rebuildSnapshot_(); return 'refreshed'; }
  return 'ok';
}
function processNotifications_() {
  if (!prop_('NQ')) return 0;
  var empty = withLock_(function () {
    var t = loadSnapshot_().t.Notifications, si = t.h.indexOf('status');
    if (t.r.some(function (r) { return r[si] === 'PENDING' || r[si] === 'SENDING'; })) return false;
    delProp_('NQ');
    return true;
  });
  if (empty) return 0;
  var now = Date.now(), claim = randHex_(10);
  var picked = runTx_('system', 'notifyClaim', null, null, function (db) {
    var list = db.rows('Notifications'), out = [];
    var sentRecently = list.filter(function (n) { return n.status === 'SENT' && now - new Date(n.sentAt).getTime() < 60000; }).length;
    list.forEach(function (n) {
      if (n.status === 'SENDING' && now - new Date(n.updatedAt).getTime() > 10 * 60000) {
        db.update('Notifications', n.id, { status: 'UNKNOWN', lastError: 'ไม่ทราบผลการส่ง (ค้างเกิน 10 นาที)' });
      }
    });
    for (var i = 0; i < list.length && out.length < Math.max(0, 8 - sentRecently); i++) {
      var n = list[i];
      if (n.status === 'PENDING' && new Date(n.nextAttempt || 0).getTime() <= now) {
        db.update('Notifications', n.id, { status: 'SENDING', claim: claim, attempts: num_(n.attempts) + 1 });
        out.push({ id: n.id, channel: n.channel, message: n.message, attempts: num_(n.attempts) + 1 });
      }
    }
    return out;
  }, { journal: false }).data;
  if (!picked.length) return 0;
  var results = picked.map(sendOne_);
  runTx_('system', 'notifyResult', null, null, function (db) {
    results.forEach(function (r) {
      var n = db.get('Notifications', r.id);
      if (!n || n.claim !== claim) return;
      if (r.ok) db.update('Notifications', n.id, { status: 'SENT', sentAt: nowIso_(), lastError: '' });
      else if (r.retry && num_(n.attempts) < 5) db.update('Notifications', n.id, { status: 'PENDING', nextAttempt: new Date(Date.now() + (r.after != null ? r.after : 60 * Math.pow(2, num_(n.attempts))) * 1000).toISOString(), lastError: r.error });
      else db.update('Notifications', n.id, { status: 'FAILED', lastError: r.error });
    });
  }, { journal: false });
  return picked.length;
}
function uuidFrom_(s) { var h = sha256Hex_(s); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32); }
function sendOne_(n) {
  try {
    var resp;
    if (n.channel === 'TELEGRAM') {
      var tok = prop_('TG_TOKEN'), chat = prop_('TG_CHAT');
      if (!tok || !chat) return { id: n.id, ok: false, error: 'ยังไม่ได้ตั้งค่า Telegram' };
      resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + tok + '/sendMessage', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ chat_id: chat, text: String(n.message).slice(0, 4000), disable_web_page_preview: true })
      });
    } else if (n.channel === 'LINE') {
      var lt = prop_('LINE_TOKEN'), to = prop_('LINE_TO');
      if (!lt || !to) return { id: n.id, ok: false, error: 'ยังไม่ได้ตั้งค่า LINE' };
      resp = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + lt, 'X-Line-Retry-Key': uuidFrom_(n.id) },
        payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: String(n.message).slice(0, 4900) }] })
      });
    } else return { id: n.id, ok: false, error: 'ไม่รู้จักช่องทาง' };
    var code = resp.getResponseCode(), body = resp.getContentText().slice(0, 300);
    if (code >= 200 && code < 300) return { id: n.id, ok: true };
    if (n.channel === 'LINE' && code === 409) return { id: n.id, ok: true };       // retry key ซ้ำ = ส่งไปแล้ว
    if (code === 429) {
      var after = 60;
      try { var ra = (JSON.parse(body).parameters || {}).retry_after; if (ra != null && isFinite(ra)) after = Number(ra); } catch (e) { }
      return { id: n.id, ok: false, retry: true, after: after, error: 'ถูกจำกัดอัตรา (429)' };
    }
    return { id: n.id, ok: false, retry: code >= 500, error: 'HTTP ' + code + ': ' + body };
  } catch (e) {
    return { id: n.id, ok: false, retry: true, error: String(e.message || e).slice(0, 200) };
  }
}
function dueCheck_() {
  var today = today_();
  if (prop_('LAST_DUE_CHECK') === today || Number(Utilities.formatDate(new Date(), TZ, 'H')) < 8) return;
  setProp_('LAST_DUE_CHECK', today);
  if (!notifyChannels_().length) return;
  runTx_('system', 'dueCheck', null, null, function (db) {
    var days = Number(db.setting('dueAlertDays', 3)) || 0;
    var lim = Utilities.formatDate(new Date(Date.now() + days * 86400000), TZ, 'yyyy-MM-dd');
    var over = [], near = [];
    db.rows('Loans').forEach(function (L) {
      if (L.status === 'RETURNED' || !L.due) return;
      if (L.due < today) over.push(L); else if (L.due <= lim) near.push(L);
    });
    if (!over.length && !near.length) return;
    var line = function (L) { return '• ' + L.code + ' ' + L.borrower + ' กำหนดคืน ' + L.due; };
    var msg = 'สรุปการยืมประจำวัน' + (over.length ? '\nเกินกำหนด ' + over.length + ' ใบ\n' + over.slice(0, 15).map(line).join('\n') : '') +
      (near.length ? '\nใกล้ครบกำหนด ' + near.length + ' ใบ\n' + near.slice(0, 15).map(line).join('\n') : '');
    db.notify('LOAN_DUE', 'Loans', msg, 'LOANDUE:' + today);
  }, { journal: false });
}
function cronDaily() { cleanup_(); }
function cleanup_() {
  return withLock_(function () {
    var now = Date.now(), out = {};
    var rewrite = function (name, keepFn) {
      var t = readRawTable_(name), keep = t.rows.filter(keepFn);
      if (keep.length === t.rows.length) { out[name] = 0; return; }
      var last = t.sh.getLastRow();
      if (last > 1) t.sh.getRange(2, 1, last - 1, t.h.length).clearContent();
      if (keep.length) t.sh.getRange(2, 1, keep.length, t.h.length).setValues(keep.map(function (o) { return objRow_(t.h, o).map(escCell_); }));
      out[name] = t.rows.length - keep.length;
    };
    if (!prop_('PEND')) rewrite('Operations', function (o) { return now - new Date(o.createdAt).getTime() < 14 * 86400000; });
    var notExpired = function (o) { return new Date(o.expiresAt).getTime() > now - 2 * 86400000; };
    rewrite('Sessions', notExpired);
    rewrite('AuthTokens', notExpired);
    SpreadsheetApp.flush();
    try {
      var it = driveFolder_('pdf').searchFiles('title contains "tmp_"');
      while (it.hasNext()) { var f = it.next(); if (now - f.getDateCreated().getTime() > 86400000) f.setTrashed(true); }
    } catch (e) { console.warn(e); }
    console.log('cleanup ' + JSON.stringify(out));
    return out;
  });
}

// ============================================================ 9) setupDatabase + เมนู
function ui_() { try { return SpreadsheetApp.getUi(); } catch (e) { return null; } }
function say_(title, msg) { var ui = ui_(); if (ui) ui.alert(title, msg, ui.ButtonSet.OK); console.log(title + '\n' + msg); }

function onOpen() {
  var ui = ui_();
  if (!ui) return;
  ui.createMenu('วังยาว')
    .addItem('1) สร้าง/ตรวจโครงฐานข้อมูล', 'setupDatabase')
    .addItem('2) ตั้งรหัสผ่านเจ้าของ', 'setOwnerPassword')
    .addItem('3) เชื่อมต่อ Vercel', 'configureGateway')
    .addSeparator()
    .addItem('ตรวจระบบ (health check)', 'healthCheck')
    .addItem('โหลดข้อมูลจากชีตใหม่', 'reloadFromSheet')
    .addItem('เพิ่มข้อมูลตัวอย่าง', 'addSampleDataMenu')
    .addItem('ล้างคิวเก่า', 'purgeOldQueue')
    .addToUi();
}
/** แก้ชีตด้วยมือ -> เปลี่ยน STATE_REV ให้ snapshot ถูกสร้างใหม่ */
function onEdit() { try { invalidate_(); } catch (e) { } }
function onSheetChange() { try { invalidate_(); } catch (e) { } }

function resetConnection_() {
  ['STATE_REV', 'PEND', 'REST_OFF'].forEach(delProp_);
  try { cache_().remove('SN:meta'); } catch (e) { }
  SS_ = null; SHEETS_ = null; SNAP_LOCAL_ = null;
}

function setupDatabase() {
  var t0 = Date.now(), active = null, ss = null, id = prop_('DB_ID'), created = false;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { }
  if (active) {
    if (id && id !== active.getId()) resetConnection_();
    ss = active;
  } else if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) { ss = SpreadsheetApp.create('วังยาว • ฐานข้อมูล'); resetConnection_(); created = true; }
  setProp_('DB_ID', ss.getId());
  SS_ = ss; SHEETS_ = null;
  ss.setSpreadsheetTimeZone(TZ);
  var log = [];
  withLock_(function () {
    Object.keys(SCHEMA).forEach(function (name) { log.push(ensureSheet_(ss, name, BASE_COLS.concat(SCHEMA[name]))); });
    ['Sheet1', 'ชีต1', 'แผ่น1'].forEach(function (n) {
      var s = ss.getSheetByName(n);
      if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
    });
    SHEETS_ = null;
    log.push(seedAll_(ss));
    SpreadsheetApp.flush();
    invalidate_();
  });
  pepper_();
  log.push(setupDrive_());
  log.push(installTriggers_(ss));
  var snapMs = Date.now(); rebuildSnapshot_(); snapMs = Date.now() - snapMs;
  var msg = (created ? 'สร้างสเปรดชีตใหม่: ' + ss.getUrl() + '\n' : 'ใช้สเปรดชีต: ' + ss.getUrl() + '\n') + log.filter(String).join('\n') +
    '\nสร้าง snapshot ' + snapMs + ' ms\nเสร็จใน ' + Math.round((Date.now() - t0) / 100) / 10 + ' วินาที\n\nขั้นต่อไป: เมนู "ตั้งรหัสผ่านเจ้าของ"';
  say_('ติดตั้งฐานข้อมูลเรียบร้อย', msg);
  return msg;
}
function ensureSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name), isNew = false;
  if (!sh) { sh = ss.insertSheet(name); isNew = true; }
  var hdr = headerOf_(sh), added = [];
  if (!hdr.length) { hdr = []; }
  cols.forEach(function (c) { if (hdr.indexOf(c) < 0) { hdr.push(c); added.push(c); } });
  if (sh.getMaxColumns() < hdr.length) sh.insertColumnsAfter(sh.getMaxColumns(), hdr.length - sh.getMaxColumns());
  if (added.length) sh.getRange(1, 1, 1, hdr.length).setValues([hdr]);
  sh.getRange(1, 1, sh.getMaxRows(), hdr.length).setNumberFormat('@');
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, hdr.length).setFontWeight('bold').setBackground('#ece4ff').setFontColor('#3a3956');
  return isNew ? 'สร้างแท็บ ' + name : (added.length ? 'เพิ่มคอลัมน์ใน ' + name + ': ' + added.join(', ') : '');
}
function seedRows_(ss, name, rows) {
  var sh = ss.getSheetByName(name), h = headerOf_(sh), idc = h.indexOf('id'), last = sh.getLastRow();
  var have = {};
  if (last > 1) sh.getRange(2, idc + 1, last - 1, 1).getValues().forEach(function (r) { have[cellStr_(r[0])] = 1; });
  var now = nowIso_();
  var add = rows.filter(function (r) { return !have[r.id]; }).map(function (r) {
    var o = { owner: 'system', createdAt: now, updatedAt: now, updatedBy: 'system', version: 1 };
    for (var k in r) o[k] = r[k];
    return objRow_(h, o).map(escCell_);
  });
  if (add.length) { ensureRows_(sh, last + add.length); sh.getRange(last + 1, 1, add.length, h.length).setValues(add); }
  return add.length;
}
function seedAll_(ss) {
  var n = 0, T = 'TRUE', F = 'FALSE';
  n += seedRows_(ss, 'Roles', [
    { id: 'ADMIN', name: 'ผู้ดูแลระบบ', seeFinance: T, registerAssets: T, assignWork: T, inspectWork: T, active: T },
    { id: 'MANAGER', name: 'ผู้จัดการ', seeFinance: T, registerAssets: T, assignWork: T, inspectWork: T, active: T },
    { id: 'HOUSEKEEPER', name: 'แม่บ้าน', seeFinance: F, registerAssets: F, assignWork: F, inspectWork: T, active: T },
    { id: 'TECH', name: 'ช่างซ่อมบำรุง', seeFinance: F, registerAssets: F, assignWork: F, inspectWork: F, active: T },
    { id: 'HEAD', name: 'หัวหน้าแผนก', seeFinance: F, registerAssets: T, assignWork: T, inspectWork: T, active: T },
    { id: 'STAFF', name: 'พนักงาน', seeFinance: F, registerAssets: F, assignWork: F, inspectWork: F, active: T },
    { id: 'ACCOUNT', name: 'บัญชี', seeFinance: T, registerAssets: T, assignWork: F, inspectWork: F, active: T }
  ]);
  var locs = [
    ['CENTRAL', 'สต๊อกกลาง', '', 'STORE'], ['L_LOBBY', 'ล็อบบี้และแผนกต้อนรับ', '', 'AREA'], ['L_REST', 'ห้องอาหาร', '', 'AREA'],
    ['L_KITCHEN', 'ครัว', '', 'AREA'], ['L_POOL', 'สระว่ายน้ำ', '', 'AREA'], ['L_SPA', 'สปา', '', 'AREA'], ['L_MEET', 'ห้องประชุม/จัดเลี้ยง', '', 'AREA'],
    ['L_OFFICE', 'สำนักงาน', '', 'AREA'], ['L_HK', 'ห้องแม่บ้าน', '', 'AREA'], ['L_ENG', 'ห้องช่าง', '', 'AREA'], ['L_LAUNDRY', 'ห้องซักรีด', '', 'AREA'],
    ['L_BLDG_A', 'อาคาร A', '', 'BUILDING'], ['L_BLDG_B', 'อาคาร B', '', 'BUILDING']
  ];
  ['A101', 'A102', 'A103', 'A104', 'A105', 'A106'].forEach(function (r) { locs.push(['L_' + r, 'ห้อง ' + r, 'L_BLDG_A', 'ROOM']); });
  ['B201', 'B202', 'B203', 'B204'].forEach(function (r) { locs.push(['L_' + r, 'ห้อง ' + r, 'L_BLDG_B', 'ROOM']); });
  n += seedRows_(ss, 'Locations', locs.map(function (l) { return { id: l[0], name: l[1], parent: l[2], kind: l[3], active: T }; }));
  var opts = {
    groups: ['เฟอร์นิเจอร์', 'เครื่องใช้ไฟฟ้า', 'อุปกรณ์ห้องพัก', 'อุปกรณ์ครัว', 'อุปกรณ์สำนักงาน', 'อุปกรณ์สระว่ายน้ำ', 'เครื่องมือช่าง', 'ผ้าและสิ่งทอ', 'อื่นๆ'],
    units: ['ชิ้น', 'เครื่อง', 'ตัว', 'ชุด', 'ผืน', 'ใบ', 'อัน', 'กล่อง', 'คู่'],
    brands: ['ไม่ระบุ', 'Samsung', 'LG', 'Panasonic', 'Sharp', 'Toshiba', 'Daikin', 'Mitsubishi', 'Philips', 'Electrolux', 'Hitachi'],
    reasons: ['ชำรุดซ่อมไม่คุ้มค่า', 'ซ่อมไม่ได้', 'หมดอายุการใช้งาน', 'ล้าสมัย', 'สูญหาย'],
    departments: ['ส่วนหน้า', 'แม่บ้าน', 'ช่างซ่อมบำรุง', 'ครัวและอาหาร', 'บัญชี', 'ผู้บริหาร', 'สปาและสระว่ายน้ำ']
  };
  var orows = [];
  Object.keys(opts).forEach(function (k) { opts[k].forEach(function (label, i) { orows.push({ id: 'O_' + k + '_' + (i + 1), kind: k, label: label, aliases: '[]', active: T, sortOrder: i + 1 }); }); });
  n += seedRows_(ss, 'Options', orows);
  var settings = { businessName: 'วังยาวรีสอร์ท', codePrefix: 'WYA', dueAlertDays: 3, imageMaxPx: 1440, imageTargetKB: 250, allowRegister: true, googleLogin: { enabled: false, clientId: '' }, webUrl: '' };
  n += seedRows_(ss, 'Settings', Object.keys(settings).map(function (k) { return { id: 'S_' + k, key: k, value: JSON.stringify(settings[k]) }; }));
  // ผู้ดูแลจากอีเมลผู้ติดตั้ง
  var email = '';
  try { email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) { }
  var ush = ss.getSheetByName('Users'), uh = headerOf_(ush), ulast = ush.getLastRow(), hasAdmin = false;
  if (ulast > 1) normRows_(ush.getRange(2, 1, ulast - 1, uh.length).getValues(), uh.length).forEach(function (r) {
    var u = rowObj_(uh, r); if (u.role === 'ADMIN' || (email && String(u.email).toLowerCase() === email)) hasAdmin = true;
  });
  if (!hasAdmin) {
    n += seedRows_(ss, 'Users', [{ id: newId_('Users'), name: 'ผู้ดูแลระบบ', email: email, phone: '', role: 'ADMIN', status: 'ACTIVE', department: 'ผู้บริหาร',
      passwordHash: '', passwordSalt: '', passwordRounds: '', googleSub: '', mustChangePassword: 'FALSE' }]);
  }
  return 'ข้อมูลตั้งต้นเพิ่มใหม่ ' + n + ' แถว' + (email ? ' (ผู้ดูแล: ' + email + ')' : '');
}
function setupDrive_() {
  var get = function (key, name, parent) {
    var id = prop_(key);
    if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { } }
    var nf = parent ? parent.createFolder(name) : DriveApp.createFolder(name);
    setProp_(key, nf.getId());
    return nf;
  };
  var root = get('DRIVE_ROOT', 'วังยาว • ไฟล์แนบ');
  get('DRIVE_IMG', 'ภาพ', root);
  get('DRIVE_PDF', 'เอกสาร PDF', root);
  return 'โฟลเดอร์ Drive: ' + root.getUrl();
}
function installTriggers_(ss) {
  var want = { cronMinute: 1, cronDaily: 1, onSheetChange: 1 };
  ScriptApp.getProjectTriggers().forEach(function (t) { if (want[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('cronMinute').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('cronDaily').timeBased().atHour(3).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
  return 'ติดตั้ง trigger: ทุก 1 นาที (อุ่นระบบ+แจ้งเตือน), รายวัน 03:00 (ล้างข้อมูลเก่า), เมื่อแก้ชีต';
}
function ownerUser_(db) {
  var email = '';
  try { email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) { }
  var us = db.rows('Users');
  for (var i = 0; i < us.length; i++) if (email && String(us[i].email).toLowerCase() === email) return us[i];
  for (var j = 0; j < us.length; j++) if (us[j].role === 'ADMIN' && us[j].status === 'ACTIVE') return us[j];
  return null;
}
function setOwnerPassword() {
  var ui = ui_();
  if (!ui) throw new Error('กรุณารันจากเมนู "วังยาว" ใน Google Sheet');
  var db = new Db_(loadSnapshot_()), u = ownerUser_(db);
  if (!u) { say_('ไม่พบผู้ดูแล', 'กรุณารัน setupDatabase ก่อน'); return; }
  var r1 = ui.prompt('ตั้งรหัสผ่านเจ้าของ', 'บัญชี: ' + (u.email || u.name) + '\nรหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var pw = r1.getResponseText();
  if (pw.length < 8 || pw.length > 128 || !/[0-9]/.test(pw) || !/[^0-9]/.test(pw)) { say_('ไม่สำเร็จ', 'รหัสผ่านต้องยาว 8-128 ตัวอักษร และมีทั้งตัวเลขและตัวอักษร'); return; }
  var r2 = ui.prompt('ยืนยันรหัสผ่าน', 'พิมพ์รหัสผ่านอีกครั้ง', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  if (r2.getResponseText() !== pw) { say_('ไม่สำเร็จ', 'รหัสผ่านสองช่องไม่ตรงกัน'); return; }
  var t0 = Date.now(), salt = randHex_(32), hash = pbkdf2Hex_(pw, salt, PBKDF2_ROUNDS);
  runTx_(u.id, 'setOwnerPassword', null, null, function (db2) {
    db2.update('Users', u.id, { passwordHash: hash, passwordSalt: salt, passwordRounds: String(PBKDF2_ROUNDS), mustChangePassword: 'FALSE', status: 'ACTIVE' });
    db2.audit('OWNER_PASSWORD', 'Users', u.id, 'ตั้งรหัสผ่านเจ้าของจากเมนู');
  });
  say_('ตั้งรหัสผ่านเรียบร้อย', 'ใช้อีเมล ' + (u.email || '-') + ' เข้าสู่ระบบได้แล้ว (คำนวณ ' + Math.round((Date.now() - t0) / 100) / 10 + ' วินาที)\n\nขั้นต่อไป: Deploy เป็น Web app แล้วรันเมนู "เชื่อมต่อ Vercel"');
}
function configureGateway() {
  var ui = ui_();
  if (!ui) throw new Error('กรุณารันจากเมนู "วังยาว" ใน Google Sheet');
  var db = new Db_(loadSnapshot_()), cur = db.setting('webUrl', '');
  var r = ui.prompt('เชื่อมต่อ Vercel', 'ที่อยู่เว็บบน Vercel (เช่น https://wangyao.vercel.app)' + (cur ? '\nปัจจุบัน: ' + cur : ''), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var web = r.getResponseText().trim().replace(/\/+$/, '') || cur;
  if (!/^https:\/\/[^\s/]+$/.test(web)) { say_('ไม่สำเร็จ', 'ที่อยู่เว็บต้องขึ้นต้นด้วย https:// และไม่มี path'); return; }
  var secret = prop_('BRIDGE_SECRET');
  if (secret) {
    var again = ui.alert('มีรหัสเชื่อมต่ออยู่แล้ว', 'ต้องการสร้าง GAS_BRIDGE_SECRET ใหม่หรือไม่?\n(ถ้าสร้างใหม่ ต้องแก้ค่าบน Vercel แล้ว Redeploy)', ui.ButtonSet.YES_NO);
    if (again === ui.Button.YES) secret = '';
  }
  if (!secret) { secret = randHex_(64); setProp_('BRIDGE_SECRET', secret); }
  var owner = ownerUser_(db);
  runTx_(owner ? owner.id : 'system', 'configureGateway', null, null, function (db2) {
    putSetting_(db2, 'webUrl', web);
    db2.audit('CONFIGURE_GATEWAY', 'Settings', '', 'เชื่อมต่อ Vercel ' + web);
  });
  var gasUrl = '';
  try { gasUrl = ScriptApp.getService().getUrl() || ''; } catch (e) { }
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var html = '<div style="font-family:sans-serif;font-size:14px;color:#3a3956">' +
    '<p>ไปที่ Vercel → Project → Settings → Environment Variables แล้วเพิ่ม 2 ค่านี้ (Production และ Preview) จากนั้น Redeploy</p>' +
    '<b>GAS_URL</b><br><input style="width:100%;padding:6px" readonly onclick="this.select()" value="' + esc(gasUrl || 'คัดลอกจาก Deploy > Manage deployments (ลงท้าย /exec)') + '"><br><br>' +
    '<b>GAS_BRIDGE_SECRET</b><br><input style="width:100%;padding:6px" readonly onclick="this.select()" value="' + esc(secret) + '"><br><br>' +
    '<small>GAS_URL ต้องลงท้ายด้วย /exec เท่านั้น (ห้ามใช้ /dev)</small></div>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(560).setHeight(320), 'ค่าสำหรับ Vercel');
}
function healthCheck() {
  var lines = [], ok = function (b, t) { lines.push((b ? '✅ ' : '❌ ') + t); };
  try {
    var ss = ss_(); ok(true, 'ฐานข้อมูล: ' + ss.getName());
    Object.keys(SCHEMA).forEach(function (n) {
      var sh = ss.getSheetByName(n);
      if (!sh) { ok(false, 'ไม่มีแท็บ ' + n); return; }
      var h = headerOf_(sh), miss = BASE_COLS.concat(SCHEMA[n]).filter(function (c) { return h.indexOf(c) < 0; });
      if (miss.length) ok(false, n + ' ขาดคอลัมน์ ' + miss.join(', '));
    });
    var t0 = Date.now(); invalidate_(); var snap = rebuildSnapshot_(); ok(true, 'สร้าง snapshot ใหม่ ' + (Date.now() - t0) + ' ms (ทะเบียน ' + (snap.t.Assets.r.length) + ' แถว)');
    SNAP_LOCAL_ = null; t0 = Date.now(); loadSnapshot_(); ok(true, 'อ่าน snapshot จากแคช ' + (Date.now() - t0) + ' ms');
    ok(!prop_('REST_OFF'), prop_('REST_OFF') ? 'Sheets API ใช้ไม่ได้ (ใช้ getValues แทน ช้ากว่าเล็กน้อย)' : 'Sheets API batchGet ใช้งานได้');
    var db = new Db_(snap), owner = ownerUser_(db);
    ok(!!(owner && owner.passwordHash), owner && owner.passwordHash ? 'ตั้งรหัสผ่านเจ้าของแล้ว' : 'ยังไม่ได้ตั้งรหัสผ่านเจ้าของ');
    ok(!!prop_('BRIDGE_SECRET'), prop_('BRIDGE_SECRET') ? 'ตั้ง GAS_BRIDGE_SECRET แล้ว' : 'ยังไม่ได้เชื่อมต่อ Vercel');
    ok(!!db.setting('webUrl', ''), 'ที่อยู่เว็บ: ' + (db.setting('webUrl', '') || '-'));
    var trig = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    ok(trig.indexOf('cronMinute') >= 0 && trig.indexOf('cronDaily') >= 0, 'Trigger: ' + (trig.join(', ') || 'ไม่มี'));
    ok(!prop_('PEND'), prop_('PEND') ? 'มีรายการค้างรอกู้คืน' : 'ไม่มีรายการค้าง');
    try { driveFolder_('img'); driveFolder_('pdf'); ok(true, 'โฟลเดอร์ Drive พร้อม'); } catch (e) { ok(false, e.message); }
    var ch = notifyChannels_(); ok(true, 'แจ้งเตือน: ' + (ch.join(', ') || 'ยังไม่ได้ตั้งค่า'));
    var url = ''; try { url = ScriptApp.getService().getUrl(); } catch (e) { }
    ok(!!url, 'Web app: ' + (url || 'ยังไม่ได้ Deploy'));
  } catch (e) { ok(false, e.message); }
  say_('ผลตรวจระบบ', lines.join('\n'));
  return lines.join('\n');
}
function reloadFromSheet() {
  var t0 = Date.now(); invalidate_(); SNAP_LOCAL_ = null; rebuildSnapshot_();
  say_('โหลดข้อมูลจากชีตใหม่แล้ว', 'ใช้เวลา ' + (Date.now() - t0) + ' ms ผู้ใช้จะเห็นข้อมูลล่าสุดเมื่อรีเฟรช');
}
function addSampleDataMenu() {
  var db = new Db_(loadSnapshot_()), owner = ownerUser_(db);
  var r = runTx_(owner ? owner.id : 'system', 'addSampleData', null, null, function (db2) { return sampleData_(db2, db2.me()); });
  say_('เพิ่มข้อมูลตัวอย่างแล้ว', 'เพิ่ม ' + r.data.count + ' รายการ (ชื่อขึ้นต้นด้วย [ตัวอย่าง])');
}
function purgeOldQueue() {
  var n = runTx_('system', 'purgeQueue', null, null, function (db) {
    var c = 0, lim = Date.now() - 2 * 86400000;
    db.rows('Notifications').forEach(function (x) {
      if ((x.status === 'PENDING' || x.status === 'SENDING') && new Date(x.createdAt).getTime() < lim) { db.update('Notifications', x.id, { status: 'FAILED', lastError: 'ล้างคิวเก่า' }); c++; }
    });
    return c;
  }, { journal: false }).data;
  var out = cleanup_();
  say_('ล้างคิวเก่าแล้ว', 'แจ้งเตือนค้าง ' + n + ' รายการ\nลบ Operations ' + (out.Operations || 0) + ', Sessions ' + (out.Sessions || 0) + ', AuthTokens ' + (out.AuthTokens || 0) + ' แถว');
}
