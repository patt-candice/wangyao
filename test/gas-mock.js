'use strict';
/**
 * จำลองบริการของ Google Apps Script พอให้รัน Code.gs จริงใน Node ได้
 * (SpreadsheetApp, Sheets advanced service, CacheService, PropertiesService, LockService,
 *  Utilities, DriveApp, MailApp, UrlFetchApp, ScriptApp, ContentService, Session)
 * นับจำนวนครั้งที่เรียกชีต เพื่อตรวจกฎ "อ่านจาก snapshot ไม่เปิด Spreadsheet"
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');

const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const toBuf = (x) => (Buffer.isBuffer(x) ? x : Array.isArray(x) ? Buffer.from(x.map((b) => b & 255)) : Buffer.from(String(x), 'utf8'));

class Blob {
  constructor(data, type, name) { this.buf = toBuf(data); this.type = type || 'application/octet-stream'; this.name = name || ''; }
  getBytes() { return signed(this.buf); }
  getDataAsString() { return this.buf.toString('utf8'); }
  getContentType() { return this.type; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
}

function createEnv(opts = {}) {
  const stats = { open: 0, sheetCalls: 0, flush: 0, batchGet: 0, mails: [], fetches: [] };
  const fault = { failSetValuesAfter: -1 };
  const tick = () => { stats.sheetCalls++; };

  class Range {
    constructor(sh, r, c, nr, nc) {
      if (r < 1 || c < 1 || nr < 1 || nc < 1 || r + nr - 1 > sh.maxRows || c + nc - 1 > sh.maxCols) {
        throw new Error(`Range out of bounds ${sh.name} r${r} c${c} ${nr}x${nc} (max ${sh.maxRows}x${sh.maxCols})`);
      }
      Object.assign(this, { sh, r, c, nr, nc });
    }
    getValues() {
      tick();
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sh.data[this.r - 1 + i] || [];
        const o = [];
        for (let j = 0; j < this.nc; j++) o.push(row[this.c - 1 + j] == null ? '' : row[this.c - 1 + j]);
        out.push(o);
      }
      return out;
    }
    getValue() { return this.getValues()[0][0]; }
    setValues(v) {
      tick();
      if (fault.failSetValuesAfter === 0) { fault.failSetValuesAfter = -1; throw new Error('SIMULATED CRASH'); }
      if (fault.failSetValuesAfter > 0) fault.failSetValuesAfter--;
      if (v.length !== this.nr || v.some((r) => r.length !== this.nc)) throw new Error(`setValues dims ${v.length}x${v[0] && v[0].length} != ${this.nr}x${this.nc}`);
      for (let i = 0; i < this.nr; i++) {
        const ri = this.r - 1 + i;
        while (this.sh.data.length <= ri) this.sh.data.push([]);
        for (let j = 0; j < this.nc; j++) {
          let x = v[i][j];
          if (fault.rawLog && typeof x === 'string' && x.charAt(0) === "'") fault.rawLog.push(x);
          if (typeof x === 'string' && x.charAt(0) === "'") x = x.slice(1);  // Sheets ซ่อน ' นำหน้า
          this.sh.data[ri][this.c - 1 + j] = x;
        }
      }
      return this;
    }
    setValue(x) { return this.setValues([[x]]); }
    clearContent() { tick(); for (let i = 0; i < this.nr; i++) { const row = this.sh.data[this.r - 1 + i]; if (row) for (let j = 0; j < this.nc; j++) row[this.c - 1 + j] = ''; } return this; }
    setNumberFormat() { tick(); return this; }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setFontColor() { return this; }
  }
  class Sheet {
    constructor(ss, name) { this.ss = ss; this.name = name; this.data = []; this.maxRows = 1000; this.maxCols = 26; }
    getName() { return this.name; }
    getLastRow() { tick(); for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some((x) => x !== '' && x != null)) return i + 1; return 0; }
    getLastColumn() { tick(); let m = 0; this.data.forEach((r) => { for (let j = (r || []).length - 1; j >= 0; j--) if (r[j] !== '' && r[j] != null) { m = Math.max(m, j + 1); break; } }); return m; }
    getMaxRows() { tick(); return this.maxRows; }
    getMaxColumns() { tick(); return this.maxCols; }
    insertRowsAfter(after, n) { tick(); this.maxRows += n; }
    insertColumnsAfter(after, n) { tick(); this.maxCols += n; }
    getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
    getDataRange() { const lr = Math.max(1, this.getLastRow()), lc = Math.max(1, this.getLastColumn()); return new Range(this, 1, 1, lr, lc); }
    setFrozenRows() { return this; }
    /** ใช้ในเทสต์: แทรกแถวด้วยมือ (จำลองคนแก้ชีต) */
    _insertRowAt(rowNum, values) { this.data.splice(rowNum - 1, 0, values.slice()); this.maxRows++; }
  }
  class Spreadsheet {
    constructor(id, name) { this.id = id; this.name = name; this.sheets = [new Sheet(this, 'Sheet1')]; this.tz = ''; }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
    getSheets() { tick(); return this.sheets.slice(); }
    getSheetByName(n) { tick(); return this.sheets.find((s) => s.name === n) || null; }
    insertSheet(n) { tick(); const s = new Sheet(this, n); this.sheets.push(s); return s; }
    deleteSheet(s) { tick(); this.sheets = this.sheets.filter((x) => x !== s); }
    setSpreadsheetTimeZone(tz) { this.tz = tz; }
  }
  const spreadsheets = {};
  let active = null;
  const SpreadsheetApp = {
    openById(id) { stats.open++; if (!spreadsheets[id]) throw new Error('not found'); return spreadsheets[id]; },
    create(name) { const id = 'SS' + crypto.randomBytes(6).toString('hex'); spreadsheets[id] = new Spreadsheet(id, name); return spreadsheets[id]; },
    getActiveSpreadsheet() { return active; },
    flush() { stats.flush++; },
    getUi() { throw new Error('no ui in test'); }
  };
  // Sheets advanced service (FORMATTED_VALUE): ตัดแถว/เซลล์ว่างท้ายเหมือน API จริง
  const Sheets = opts.noSheetsApi ? undefined : {
    Spreadsheets: {
      Values: {
        batchGet(id, o) {
          stats.batchGet++;
          if (opts.sheetsApi403) throw new Error('API call to sheets.spreadsheets.values.batchGet failed with error: 403');
          const ss = spreadsheets[id];
          return {
            valueRanges: o.ranges.map((rg) => {
              const m = /^'([^']+)'(?:!(\d+):(\d+))?$/.exec(rg);
              const sh = ss.sheets.find((s) => s.name === m[1]);
              let rows = sh.data.map((r) => (r || []).map((x) => (x == null ? '' : String(x))));
              if (m[2]) rows = rows.slice(Number(m[2]) - 1, Number(m[3]));
              while (rows.length && !rows[rows.length - 1].some((x) => x !== '')) rows.pop();
              rows = rows.map((r) => { r = r.slice(); while (r.length && r[r.length - 1] === '') r.pop(); return r; });
              return { range: rg, values: rows.length ? rows : undefined };
            })
          };
        }
      }
    }
  };

  const cacheStore = new Map();
  const CacheService = {
    getScriptCache() {
      const chk = (k, v) => {
        if (k.length > 250) throw new Error('cache key too long');
        if (String(v).length > 100 * 1024) throw new Error('cache value too large: ' + k + ' ' + String(v).length);
      };
      return {
        get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
        put: (k, v) => { chk(k, v); cacheStore.set(k, String(v)); },
        putAll: (o) => { Object.keys(o).forEach((k) => chk(k, o[k])); Object.keys(o).forEach((k) => cacheStore.set(k, String(o[k]))); },
        getAll: (keys) => { const o = {}; keys.forEach((k) => { if (cacheStore.has(k)) o[k] = cacheStore.get(k); }); return o; },
        remove: (k) => cacheStore.delete(k),
        removeAll: (keys) => keys.forEach((k) => cacheStore.delete(k))
      };
    }
  };
  const propStore = new Map();
  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty: (k) => (propStore.has(k) ? propStore.get(k) : null),
        setProperty: (k, v) => { propStore.set(k, String(v)); },
        deleteProperty: (k) => propStore.delete(k),
        getProperties: () => Object.fromEntries(propStore)
      };
    }
  };
  const LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => true, releaseLock: () => { } }) };

  const pad = (n) => String(n).padStart(2, '0');
  const Utilities = {
    getUuid: () => crypto.randomUUID(),
    computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', toBuf(k)).update(toBuf(v)).digest()),
    computeDigest: (alg, s) => signed(crypto.createHash('sha256').update(toBuf(s)).digest()),
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF-8' },
    base64Encode: (x) => toBuf(x).toString('base64'),
    base64Decode: (s) => signed(Buffer.from(String(s), 'base64')),
    gzip: (b) => new Blob(zlib.gzipSync(b.buf), 'application/x-gzip'),
    ungzip: (b) => new Blob(zlib.gunzipSync(b.buf)),
    newBlob: (d, t, n) => new Blob(d, t, n),
    formatDate(d, tz, fmt) {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
        .formatToParts(d).map((x) => [x.type, x.value]));
      return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace(/^H$/, String(Number(p.hour)));
    }
  };

  const files = {}, folders = {};
  const mkFile = (blob, parent) => {
    const id = 'F' + crypto.randomBytes(8).toString('hex');
    const f = { id, blob, parent, trashed: false, created: new Date(),
      getId: () => id, getBlob: () => blob, getName: () => blob.name, setTrashed: (t) => { f.trashed = t; return f; }, setDescription: () => f,
      getDateCreated: () => f.created };
    files[id] = f; return f;
  };
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const mkFolder = (name) => {
    const id = 'D' + crypto.randomBytes(6).toString('hex');
    const fo = { id, name, getId: () => id, getUrl: () => 'https://drive.google.com/drive/folders/' + id, isTrashed: () => false,
      createFolder: (n) => mkFolder(n), createFile: (b) => mkFile(b, id),
      getFilesByName: (n) => iter(Object.values(files).filter((f) => f.parent === id && !f.trashed && f.blob.name === n)),
      searchFiles: () => iter(Object.values(files).filter((f) => f.parent === id && !f.trashed && /^tmp_/.test(f.blob.name))) };
    folders[id] = fo; return fo;
  };
  const DriveApp = {
    createFolder: (n) => mkFolder(n),
    getFolderById: (id) => { if (!folders[id]) throw new Error('no folder'); return folders[id]; },
    getFileById: (id) => { if (!files[id]) throw new Error('no file'); return files[id]; }
  };
  const triggers = [];
  const builder = (fn) => {
    const b = { timeBased: () => b, everyMinutes: () => b, atHour: () => b, everyDays: () => b, inTimezone: () => b, forSpreadsheet: () => b, onChange: () => b,
      create: () => { const t = { getHandlerFunction: () => fn }; triggers.push(t); return t; } };
    return b;
  };
  const ScriptApp = {
    getOAuthToken: () => 'tok',
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    newTrigger: builder,
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' })
  };
  let fetchHandler = opts.fetch || (() => ({ code: 200, body: '{}' }));
  const UrlFetchApp = {
    fetch(url, o) {
      stats.fetches.push({ url, o });
      const r = fetchHandler(url, o || {});
      return { getResponseCode: () => r.code, getContentText: () => r.body || '' };
    }
  };
  const ContentService = {
    MimeType: { JSON: 'json', TEXT: 'text' },
    createTextOutput: (s) => { const o = { content: s, getContent: () => s, setMimeType: () => o }; return o; }
  };

  const ctx = {
    SpreadsheetApp, Sheets, CacheService, PropertiesService, LockService, Utilities, DriveApp, ScriptApp, UrlFetchApp, ContentService,
    MailApp: { sendEmail: (m) => stats.mails.push(m) },
    Session: { getEffectiveUser: () => ({ getEmail: () => opts.ownerEmail || 'owner@wangyao.test' }) },
    HtmlService: { createHtmlOutput: () => ({ setWidth() { return this; }, setHeight() { return this; } }) },
    console: opts.quiet ? { log() { }, warn() { }, error: (...a) => console.error('[GAS]', ...a) } : console,
    Date, JSON, Math, Object, Array, String, Number, Error, isNaN, isFinite, parseInt, encodeURIComponent, RegExp
  };
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'Code.gs' });

  return {
    ctx, stats, fault, cacheStore, propStore, spreadsheets, files, triggers,
    setFetch: (f) => { fetchHandler = f; },
    db: () => spreadsheets[propStore.get('DB_ID')],
    sheet: (n) => spreadsheets[propStore.get('DB_ID')].sheets.find((s) => s.name === n),
    /** เริ่ม execution ใหม่ (GAS ล้างตัวแปร global ทุกคำขอ) */
    freshExecution() { ctx.SS_ = null; ctx.SHEETS_ = null; ctx.SNAP_LOCAL_ = null; ctx.LOCK_DEPTH_ = 0; },
    doPost(body) { this.freshExecution(); return ctx.doPost({ postData: { contents: body } }).getContent(); },
    resetStats() { stats.open = 0; stats.sheetCalls = 0; stats.flush = 0; stats.batchGet = 0; }
  };
}

module.exports = { createEnv };
