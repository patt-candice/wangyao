'use strict';
/**
 * ทดสอบ backend ทั้งเส้นทาง: เบราว์เซอร์(fetch) -> api/gas.js -> Code.gs (บน gas-mock)
 * รวมถึงชั้น snapshot: สร้าง/แพตช์/drift/กู้คืน/replay/แคชหาย/5,000 รายการ
 *   node test/backend.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const { startStack, OWNER } = require('./server');
const { createEnv } = require('./gas-mock');

let pass = 0, failN = 0;
const results = [];
async function t(name, fn) {
  const t0 = Date.now();
  try { await fn(); pass++; results.push(['PASS', name, Date.now() - t0]); console.log('  ✔ ' + name + ' (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { failN++; results.push(['FAIL', name]); console.log('  ✘ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)); }
}
const rid = () => crypto.randomBytes(12).toString('hex');
const objs = (st, n) => { const t = st.tables[n]; return t ? t.r.map((r) => Object.fromEntries(t.h.map((c, i) => [c, r[i]]))) : []; };
const metrics = {};

(async () => {
  const S = await startStack({ quiet: true });
  const { env, webUrl } = S;
  const ctx = env.ctx;
  const post = async (body, headers = {}) => {
    const r = await fetch(webUrl + '/api', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Origin: webUrl }, headers), body: typeof body === 'string' ? body : JSON.stringify(body) });
    const j = await r.json(); j._status = r.status; return j;
  };
  const call = (method, payload, extra) => post(Object.assign({ method, payload }, extra || {}));
  const login = async (identifier, password) => { const r = await call('login', { identifier, password }); if (!r.ok) throw new Error('login: ' + r.error.message); return r.data; };
  let state = null;
  const sess = {};
  const api = async (who, action, payload, o = {}) => {
    const s = sess[who];
    const r = await post({ method: 'api', token: s.token, action, payload, requestId: o.requestId || rid(), rev: o.rev });
    if (r.ok && r.data && r.data.state && !r.data.state.partial) s.state = r.data.state;
    return r;
  };
  const ok = async (who, action, payload, o) => {
    const r = await api(who, action, payload, o);
    if (!r.ok) throw new Error(action + ': ' + r.error.code + ' ' + r.error.message);
    return Object.assign({}, r.data.data, { data: r.data.data, state: r.data.state });
  };
  const errCode = async (who, action, payload, code) => { const r = await api(who, action, payload); assert.strictEqual(r.ok, false, action + ' ควรล้มเหลว'); if (code) assert.strictEqual(r.error.code, code, r.error.message); return r.error; };
  const full = async (who) => { const r = await post({ method: 'api', token: sess[who].token, action: 'getState', payload: {} }); assert(r.ok, JSON.stringify(r.error)); sess[who].state = r.data.state; return r.data.state; };
  const snapNow = () => { env.freshExecution(); return new ctx.Db_(ctx.loadSnapshot_()); };

  console.log('\n[1] setupDatabase');
  await t('สร้างครบทุกแท็บ + หัวคอลัมน์ + ข้อมูลตั้งต้น', async () => {
    const names = Object.keys(ctx.SCHEMA);
    assert.strictEqual(names.length, 24);
    names.forEach((n) => {
      const sh = env.sheet(n); assert(sh, 'ไม่มีแท็บ ' + n);
      const h = sh.data[0];
      ctx.BASE_COLS.concat(ctx.SCHEMA[n]).forEach((c) => assert(h.includes(c), n + ' ขาด ' + c));
    });
    assert(!env.db().sheets.find((s) => s.name === 'Sheet1'), 'ควรลบ Sheet1');
    const db = snapNow();
    assert.strictEqual(db.rows('Roles').length, 7);
    assert(db.get('Locations', 'CENTRAL') && db.get('Locations', 'CENTRAL').name === 'สต๊อกกลาง');
    assert(db.rows('Options').filter((o) => o.kind === 'groups').length >= 5);
    assert.strictEqual(db.setting('codePrefix'), 'WYA');
    assert.strictEqual(db.setting('dueAlertDays'), 3);
    assert.strictEqual(db.setting('imageMaxPx'), 1440);
    assert.strictEqual(db.rows('Users').filter((u) => u.role === 'ADMIN').length, 1);
    assert(env.propStore.get('DRIVE_IMG') && env.propStore.get('DRIVE_PDF'));
    const trig = env.triggers.map((x) => x.getHandlerFunction()).sort();
    assert.deepStrictEqual(trig, ['cronDaily', 'cronMinute', 'onSheetChange']);
  });

  sess.owner = await login(OWNER.email, OWNER.password);

  console.log('\n[2] Gateway / ความปลอดภัย');
  await t('ไม่มี Origin / Origin อื่น -> 403', async () => {
    const r1 = await fetch(webUrl + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"method":"ping"}' });
    assert.strictEqual(r1.status, 403);
    const r2 = await post({ method: 'ping' }, { Origin: 'https://evil.example' });
    assert.strictEqual(r2._status, 403);
  });
  await t('เมธอดนอก allow-list -> 400, GET -> 405', async () => {
    const r = await post({ method: 'authContext', payload: { identifier: OWNER.email } });
    assert.strictEqual(r._status, 400);
    const g = await fetch(webUrl + '/api'); assert.strictEqual(g.status, 405);
  });
  await t('JSON เกิน 1.5 MB -> 413', async () => {
    const r = await post({ method: 'ping', pad: 'x'.repeat(1.6 * 1024 * 1024) });
    assert.strictEqual(r._status, 413);
  });
  await t('GAS ปฏิเสธลายเซ็นผิด / หมดอายุ / nonce ซ้ำ', async () => {
    const sign = (b, sec) => crypto.createHmac('sha256', sec).update(b).digest('hex');
    const b1 = JSON.stringify({ m: 'ping', p: {}, ts: Date.now(), n: 'aa' + rid() });
    assert.strictEqual(JSON.parse(env.doPost(JSON.stringify({ b: b1, s: sign(b1, 'wrong-secret-wrong-secret-wrong-secret') }))).error.code, 'E_BRIDGE');
    const b2 = JSON.stringify({ m: 'ping', p: {}, ts: Date.now() - 120000, n: rid() });
    assert.strictEqual(JSON.parse(env.doPost(JSON.stringify({ b: b2, s: sign(b2, S.secret) }))).error.code, 'E_BRIDGE');
    const b3 = JSON.stringify({ m: 'ping', p: {}, ts: Date.now(), n: rid() });
    assert.strictEqual(JSON.parse(env.doPost(JSON.stringify({ b: b3, s: sign(b3, S.secret) }))).ok, true);
    assert.strictEqual(JSON.parse(env.doPost(JSON.stringify({ b: b3, s: sign(b3, S.secret) }))).error.code, 'E_BRIDGE');
  });
  await t('PBKDF2 ฝั่ง GAS (pure JS) ตรงกับ Node crypto', async () => {
    const salt = crypto.randomBytes(16).toString('hex');
    for (const pw of ['Owner1234', 'รหัสไทย๑๒๓abc', 'x'.repeat(100)]) {
      assert.strictEqual(ctx.pbkdf2Hex_(pw, salt, 2000), crypto.pbkdf2Sync(pw.normalize('NFC'), Buffer.from(salt, 'hex'), 2000, 32, 'sha256').toString('hex'));
    }
    const t0 = Date.now(); ctx.pbkdf2Hex_('Owner1234', salt, 600000); metrics.pbkdf2PureJs600k = Date.now() - t0;
  });

  console.log('\n[3] บัญชีและสิทธิ์');
  await t('ล็อกอินคืน {token,user,state} ครั้งเดียว และไม่มี hash/salt ในคำตอบ', async () => {
    env.resetStats();
    const t0 = Date.now(); const r = await call('login', { identifier: OWNER.email, password: OWNER.password }); metrics.loginLocalMs = Date.now() - t0;
    assert.strictEqual(env.stats.open, 0, 'ล็อกอินต้องไม่เปิด Spreadsheet'); assert.strictEqual(env.stats.sheetCalls, 0);
    assert(r.ok); assert(r.data.token.length >= 64); assert.strictEqual(r.data.user.role, 'ADMIN');
    assert(r.data.state.tables.Assets && r.data.state.perms.admin);
    const s = JSON.stringify(r);
    ['passwordHash', 'passwordSalt', 'passwordRounds', 'googleSub', 'driveId', OWNER.password].forEach((k) => assert(!s.includes(k), 'รั่ว ' + k));
  });
  await t('คิวล็อกอิน: trigger ทุกนาทีเขียนแถว Sessions + AuditLogs (LOGIN)', async () => {
    const before = env.sheet('Sessions').data.filter((r) => r[0]).length;
    assert([...env.propStore.keys()].some((k) => k.startsWith('LQ:')));
    env.freshExecution(); ctx.cronMinute();
    assert(![...env.propStore.keys()].some((k) => k.startsWith('LQ:')), 'คิวต้องว่าง');
    assert(env.sheet('Sessions').data.filter((r) => r[0]).length > before);
    assert(objs(await full('owner'), 'AuditLogs').some((l) => l.action === 'LOGIN' && l.owner === S.owner.id));
  });
  await t('รหัสผิด -> E_LOGIN, ไม่พบผู้ใช้ตอบเหมือนกัน (กัน enumeration)', async () => {
    const a = await call('login', { identifier: OWNER.email, password: 'Wrong1234' });
    const b = await call('login', { identifier: 'nobody@x.test', password: 'Wrong1234' });
    assert.strictEqual(a.error.code, 'E_LOGIN'); assert.strictEqual(a.error.message, b.error.message);
  });
  await t('getState อ่านจาก snapshot โดยไม่เปิด Spreadsheet และ rev เดิม -> unchanged', async () => {
    env.resetStats();
    const st = await full('owner');
    assert.strictEqual(env.stats.open, 0, 'ไม่ควรเปิด Spreadsheet'); assert.strictEqual(env.stats.sheetCalls, 0);
    const r = await post({ method: 'api', token: sess.owner.token, action: 'getState', payload: {}, rev: st.rev });
    assert.strictEqual(r.data.unchanged, true); assert.strictEqual(env.stats.open, 0);
  });
  await t('สมัครสมาชิก -> รออนุมัติ -> ล็อกอินไม่ได้ -> อนุมัติ -> ล็อกอินได้', async () => {
    const r = await call('register', { name: 'สมใจ ใจดี', email: 'somjai@wangyao.test', phone: '081-234-5678', department: 'แม่บ้าน', password: 'Somjai123' });
    assert(r.ok, JSON.stringify(r.error));
    const l = await call('login', { identifier: '0812345678', password: 'Somjai123' });
    assert.strictEqual(l.error.code, 'E_LOGIN'); assert(/รอผู้ดูแลอนุมัติ/.test(l.error.message));
    const u = objs(await full('owner'), 'Users').find((x) => x.email === 'somjai@wangyao.test');
    assert.strictEqual(u.status, 'PENDING');
    await ok('owner', 'approveUser', { id: u.id, version: u.version, decision: 'APPROVE', role: 'HOUSEKEEPER' });
    sess.hk = await login('somjai@wangyao.test', 'Somjai123');
    assert.strictEqual(sess.hk.user.role, 'HOUSEKEEPER');
    const dup = await call('register', { name: 'ซ้ำ', email: 'somjai@wangyao.test', password: 'Somjai123' });
    assert.strictEqual(dup.ok, false);
  });
  await t('Admin สร้างผู้ใช้ด้วยรหัสชั่วคราว -> บังคับเปลี่ยนรหัสก่อนทำรายการ', async () => {
    await ok('owner', 'saveUser', { name: 'ช่างเอก', email: 'tech@wangyao.test', phone: '0899999999', role: 'TECH', status: 'ACTIVE', department: 'ช่างซ่อมบำรุง', password: 'Temp1234' });
    await ok('owner', 'saveUser', { name: 'ช่างบี', email: 'tech2@wangyao.test', role: 'TECH', status: 'ACTIVE', password: 'Temp1234' });
    await ok('owner', 'saveUser', { name: 'พนักงานซี', email: 'staff@wangyao.test', role: 'STAFF', status: 'ACTIVE', password: 'Temp1234' });
    await ok('owner', 'saveUser', { name: 'บัญชีดี', email: 'acc@wangyao.test', role: 'ACCOUNT', status: 'ACTIVE', password: 'Temp1234' });
    sess.tech = await login('tech@wangyao.test', 'Temp1234');
    assert.strictEqual(sess.tech.user.mustChangePassword, true);
    await errCode('tech', 'addRepairNote', { id: 'x', text: 'a' }, 'E_MUSTCHANGE');
    await errCode('tech', 'changePassword', { current: 'Wrong999', next: 'Tech12345' }, 'E_INPUT');
    await ok('tech', 'changePassword', { current: 'Temp1234', next: 'Tech12345' });
    sess.tech = await login('tech@wangyao.test', 'Tech12345');
    assert.strictEqual(sess.tech.user.mustChangePassword, false);
    for (const [k, e] of [['tech2', 'tech2@wangyao.test'], ['staff', 'staff@wangyao.test'], ['acc', 'acc@wangyao.test']]) {
      sess[k] = await login(e, 'Temp1234');
      await ok(k, 'changePassword', { current: 'Temp1234', next: 'Pass12345' });
      sess[k] = await login(e, 'Pass12345');
    }
  });
  await t('จำกัดการลองล็อกอิน 8 ครั้ง/15 นาที (ครั้งที่ 9 ถูกบล็อกแม้รหัสถูก)', async () => {
    for (let i = 0; i < 8; i++) assert.strictEqual((await call('login', { identifier: 'staff@wangyao.test', password: 'Bad12345' })).error.code, 'E_LOGIN');
    const r = await call('login', { identifier: 'staff@wangyao.test', password: 'Pass12345' });
    assert.strictEqual(r.error.code, 'E_RATE');
    [...env.cacheStore.keys()].filter((k) => k.startsWith('RL:')).forEach((k) => env.cacheStore.delete(k));
  });
  await t('ลืมรหัสผ่าน: ส่งอีเมล ลิงก์ใช้ครั้งเดียว', async () => {
    const before = env.stats.mails.length;
    const r = await call('requestPasswordReset', { identifier: 'acc@wangyao.test' });
    assert(r.ok);
    assert.strictEqual(env.stats.mails.length, before + 1);
    const token = /reset=([0-9a-f]{64})/.exec(env.stats.mails[env.stats.mails.length - 1].body)[1];
    const r2 = await call('resetPassword', { token, password: 'NewAcc123' });
    assert(r2.ok, JSON.stringify(r2.error));
    assert.strictEqual((await call('resetPassword', { token, password: 'NewAcc456' })).ok, false);
    const r3 = await post({ method: 'api', token: sess.acc.token, action: 'getState', payload: {} });
    assert.strictEqual(r3.error.code, 'E_AUTH', 'เซสชันเดิมต้องถูกยกเลิก');
    sess.acc = await login('acc@wangyao.test', 'NewAcc123');
    const none = await call('requestPasswordReset', { identifier: 'nobody@x.test' });
    assert.strictEqual(none.data.message, r.data.message);
  });
  await t('ออกจากระบบ -> token ใช้ไม่ได้ (ลบแคชด้วย)', async () => {
    const s = await login('staff@wangyao.test', 'Pass12345');
    assert((await call('logout', {}, { token: s.token })).ok);
    const r = await post({ method: 'api', token: s.token, action: 'getState', payload: {} });
    assert.strictEqual(r.error.code, 'E_AUTH');
  });

  console.log('\n[4] ทะเบียนสิ่งของ / ย้าย');
  let unitIds, lot;
  await t('ลงทะเบียน UNIT 3 ชิ้น + QUANTITY 100 พร้อมรหัสอัตโนมัติ', async () => {
    const d = await ok('owner', 'saveAsset', { name: 'ทีวี 43 นิ้ว', group: 'เครื่องใช้ไฟฟ้า', brand: 'Samsung', unit: 'เครื่อง', type: 'UNIT', qty: 3, price: 12900, location: 'L_A101', year: 2568 });
    unitIds = d.ids; assert.strictEqual(unitIds.length, 3);
    const d2 = await ok('owner', 'saveAsset', { name: 'ผ้าเช็ดตัว', group: 'ผ้าและสิ่งทอ', unit: 'ผืน', type: 'QUANTITY', qty: 100, price: 180, location: 'CENTRAL' });
    const as = objs(sess.owner.state, 'Assets');
    const tv = as.filter((a) => unitIds.includes(a.id)).map((a) => a.code).sort();
    const ymd = ctx.ymd_();
    assert.deepStrictEqual(tv, [1, 2, 3].map((n) => 'WYA-' + ymd + '-0000' + n));
    lot = as.find((a) => a.id === d2.id);
    assert(/^WYA-LOT-\d{8}-00001$/.test(lot.code)); assert.strictEqual(lot.batch, lot.id); assert.strictEqual(lot.qty, '100');
    assert(objs(sess.owner.state, 'Movements').some((m) => m.asset === lot.id && m.kind === 'RECEIVE'));
  });
  await t('optimistic locking: version เก่า -> "ข้อมูลถูกแก้ไขแล้ว"', async () => {
    const a = objs(sess.owner.state, 'Assets').find((x) => x.id === unitIds[0]);
    await ok('owner', 'saveAsset', { id: a.id, version: a.version, name: a.name, group: a.group, unit: a.unit, brand: a.brand, serial: 'SN-001' });
    const e = await errCode('owner', 'saveAsset', { id: a.id, version: a.version, name: a.name, group: a.group, unit: a.unit, serial: 'SN-XXX' }, 'E_VERSION');
    assert(/ข้อมูลถูกแก้ไขแล้ว/.test(e.message));
  });
  await t('ย้ายบางส่วน แบ่งล็อตอัตโนมัติ และรวมล็อตปลายทาง', async () => {
    await ok('owner', 'moveAsset', { asset: lot.id, qty: 30, to: 'L_POOL', note: 'เตรียมสระ' });
    await ok('owner', 'moveAsset', { asset: lot.id, qty: 10, to: 'L_POOL', note: 'เพิ่ม' });
    const as = objs(sess.owner.state, 'Assets').filter((a) => a.batch === lot.id);
    assert.strictEqual(as.find((a) => a.id === lot.id).qty, '60');
    const pool = as.filter((a) => a.location === 'L_POOL'); assert.strictEqual(pool.length, 1); assert.strictEqual(pool[0].qty, '40');
    await errCode('owner', 'moveAsset', { asset: lot.id, qty: 61, to: 'L_SPA', note: 'x' }, 'E_INPUT');
    await errCode('staff', 'moveAsset', { asset: lot.id, qty: 1, to: 'L_SPA', note: 'x' }, 'E_PERM');
  });
  await t('กัน formula injection (= + - @) ตอนเขียนชีต', async () => {
    env.fault.rawLog = [];
    await ok('owner', 'saveAsset', { name: '=HYPERLINK("http://x","y")', group: 'อื่นๆ', unit: 'ชิ้น', type: 'UNIT', qty: 1, note: '@cmd', serial: '-5' });
    assert(env.fault.rawLog.includes('\'=HYPERLINK("http://x","y")') && env.fault.rawLog.includes("'@cmd") && env.fault.rawLog.includes("'-5"));
    env.fault.rawLog = null;
    assert(objs(sess.owner.state, 'Assets').some((a) => a.name === '=HYPERLINK("http://x","y")'));
  });

  console.log('\n[5] งานซ่อม + สิทธิ์การเงิน');
  let rep;
  const techId = () => objs(sess.owner.state, 'Users').find((u) => u.email === 'tech@wangyao.test').id;
  await t('แจ้งซ่อม -> ประเมิน -> อนุมัติ -> ขอแก้วงเงิน -> ปิดงาน -> ตรวจรับ', async () => {
    const d = await ok('owner', 'createRepair', { asset: unitIds[0], issue: 'เปิดไม่ติด', assigned: techId(), due: '2030-01-31' });
    rep = d.id;
    assert.strictEqual(objs(sess.owner.state, 'Assets').find((a) => a.id === unitIds[0]).condition, 'REPAIRING');
    await errCode('owner', 'createRepair', { asset: unitIds[0], issue: 'ซ้ำ' }, 'E_INPUT');
    const ts = await full('tech');
    const r0 = objs(ts, 'Repairs'); assert.strictEqual(r0.length, 1); assert(!('approved' in r0[0]), 'ช่างต้องไม่เห็นวงเงิน');
    assert(!ts.tables.Assets.h.includes('price'));
    await ok('tech', 'assessRepair', { id: rep, version: r0[0].version, fixable: true, estimate: 1500, days: 3, note: 'เปลี่ยนบอร์ด' });
    await errCode('staff', 'decideRepair', { id: rep, decision: 'APPROVE', amount: 1500 }, 'E_PERM');
    await ok('owner', 'decideRepair', { id: rep, decision: 'APPROVE', amount: 1500 });
    const tr = await ok('tech', 'requestBudgetRevision', { id: rep, amount: 2000, reason: 'อะไหล่ขึ้นราคา' });
    await errCode('tech', 'requestBudgetRevision', { id: rep, amount: 2100, reason: 'ซ้ำ' }, 'E_INPUT');
    await ok('owner', 'decideBudgetRevision', { id: tr.id, decision: 'APPROVE' });
    assert.strictEqual(objs(sess.owner.state, 'Repairs').find((r) => r.id === rep).approved, '2000');
    await ok('tech', 'completeRepair', { id: rep, costs: [{ amount: 1200, kind: 'PARTS', note: 'บอร์ด' }, { amount: 500, kind: 'LABOR' }] });
    const ts2 = await full('tech');
    assert(objs(ts2, 'RepairCosts').every((c) => !('amount' in c)), 'ช่างต้องไม่เห็นค่าซ่อม');
    await errCode('staff', 'acceptRepair', { id: rep, decision: 'ACCEPT' }, 'E_PERM');
    await ok('hk', 'acceptRepair', { id: rep, decision: 'ACCEPT', note: 'ใช้งานได้' });
    const st = await full('owner');
    assert.strictEqual(objs(st, 'Repairs').find((r) => r.id === rep).status, 'DONE');
    assert.strictEqual(objs(st, 'Assets').find((a) => a.id === unitIds[0]).condition, 'READY');
    const costs = objs(st, 'RepairCosts').filter((c) => c.repair === rep);
    assert.strictEqual(costs.reduce((s, c) => s + Number(c.amount), 0), 1700);
  });
  await t('ช่างเห็นเฉพาะงานของตัวเอง, ส่งต่องาน, ผู้มีสิทธิ์การเงินแก้ค่าใช้จ่าย', async () => {
    const d = await ok('owner', 'createRepair', { asset: unitIds[1], issue: 'ไม่มีเสียง', assigned: techId() });
    const ts = await full('tech'); assert.strictEqual(objs(ts, 'Repairs').length, 2);
    const t2 = objs(sess.owner.state, 'Users').find((u) => u.email === 'tech2@wangyao.test').id;
    await ok('tech', 'forwardRepair', { id: d.id, assigned: t2, note: 'ฝากช่างบี' });
    assert.strictEqual(objs(await full('tech'), 'Repairs').length, 1);
    assert.strictEqual(objs(await full('tech2'), 'Repairs').length, 1);
    await errCode('tech', 'addRepairNote', { id: d.id, text: 'แอบดู' }, 'E_PERM');
    const c = objs(sess.owner.state, 'RepairCosts').find((x) => x.repair === rep);
    await errCode('staff', 'editRepairCosts', { id: rep, costs: [{ id: c.id, amount: 1, kind: 'PARTS' }] }, 'E_PERM');
    await ok('acc', 'editRepairCosts', { id: rep, costs: [{ id: c.id, version: c.version, amount: 1100, kind: 'PARTS', note: 'แก้ตามใบเสร็จ' }] });
    // ไม่อนุมัติ -> ของชำรุด
    await ok('tech2', 'assessRepair', { id: d.id, fixable: false, note: 'ลำโพงขาด' });
    await ok('owner', 'decideRepair', { id: d.id, decision: 'REJECT', reason: 'ไม่คุ้ม' });
    assert.strictEqual(objs(sess.owner.state, 'Assets').find((a) => a.id === unitIds[1]).condition, 'DAMAGED');
  });
  await t('ซ่อมบางส่วนของล็อต: แยกล็อตแล้วรวมกลับเมื่อเสร็จ', async () => {
    const d = await ok('owner', 'createRepair', { asset: lot.id, qty: 2, issue: 'ขาด', assigned: techId() });
    const part = objs(sess.owner.state, 'Repairs').find((r) => r.id === d.id).asset;
    assert.notStrictEqual(part, lot.id);
    assert.strictEqual(objs(sess.owner.state, 'Assets').find((a) => a.id === lot.id).qty, '58');
    await ok('tech', 'assessRepair', { id: d.id, fixable: true, estimate: 50, days: 1 });
    await ok('owner', 'decideRepair', { id: d.id, decision: 'APPROVE', amount: 50 });
    await ok('tech', 'completeRepair', { id: d.id, costs: [] });
    await ok('owner', 'acceptRepair', { id: d.id, decision: 'ACCEPT' });
    const as = objs(sess.owner.state, 'Assets');
    assert.strictEqual(as.find((a) => a.id === lot.id).qty, '60'); assert.strictEqual(as.find((a) => a.id === part).qty, '0');
  });

  console.log('\n[6] ยืมคืน');
  let loan;
  await t('ยืมหลายรายการ (รายชิ้น + บางส่วนของล็อต) แล้วคืนบางส่วน/ทั้งหมด จำนวนรวมคงเดิม', async () => {
    await errCode('owner', 'saveLoan', { borrower: 'x', due: '2030-01-01', lines: [{ asset: unitIds[1] }] }, 'E_INPUT');  // ชำรุด
    const d = await ok('owner', 'saveLoan', { borrower: 'คุณลูกค้า งานแต่ง', phone: '0811111111', due: '2030-02-01', destination: 'L_MEET', lines: [{ asset: unitIds[2] }, { asset: lot.id, qty: 20 }] });
    loan = d.id;
    let st = sess.owner.state;
    const lines = objs(st, 'LoanLines').filter((l) => l.loan === loan);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(objs(st, 'Assets').find((a) => a.id === unitIds[2]).condition, 'LOANED');
    await errCode('owner', 'moveAsset', { asset: unitIds[2], to: 'CENTRAL', note: 'x' }, 'E_INPUT');
    const lotLine = lines.find((l) => l.original === lot.id), unitLine = lines.find((l) => l.original === unitIds[2]);
    await ok('owner', 'returnLoan', { id: loan, lines: [{ line: lotLine.id, qty: 5, to: 'CENTRAL', condition: 'READY' }] });
    assert.strictEqual(objs(sess.owner.state, 'Loans').find((l) => l.id === loan).status, 'PARTIAL');
    await errCode('owner', 'returnLoan', { id: loan, lines: [{ line: lotLine.id, qty: 16, to: 'CENTRAL' }] }, 'E_INPUT');
    await ok('owner', 'returnLoan', { id: loan, lines: [{ line: lotLine.id, qty: 15, to: 'CENTRAL', condition: 'READY' }, { line: unitLine.id, qty: 1, to: 'L_A101', condition: 'DAMAGED', note: 'จอร้าว' }] });
    st = sess.owner.state;
    assert.strictEqual(objs(st, 'Loans').find((l) => l.id === loan).status, 'RETURNED');
    const batch = objs(st, 'Assets').filter((a) => a.batch === lot.id);
    assert.strictEqual(batch.reduce((s, a) => s + Number(a.qty), 0), 100, 'จำนวนรวมของล็อตต้องคงเดิม');
    assert.strictEqual(objs(st, 'Assets').find((a) => a.id === unitIds[2]).condition, 'DAMAGED');
    assert.strictEqual(objs(st, 'LoanReturns').filter((r) => r.loan === loan).length, 3);
    await errCode('owner', 'saveLoan', { id: loan, borrower: 'x', due: '2030-03-01' }, 'E_INPUT');
  });

  console.log('\n[7] จำหน่าย');
  await t('ห้ามเสนอซ้ำ/มีงานซ่อมเปิด, ไม่อนุมัติ -> กลับสภาพเดิม, อนุมัติ -> DISPOSED', async () => {
    const r = await ok('owner', 'createRepair', { asset: unitIds[0], issue: 'สีซีด' });
    await errCode('owner', 'saveDisposal', { asset: unitIds[0], reason: 'ล้าสมัย' }, 'E_INPUT');
    await errCode('staff', 'saveDisposal', { asset: unitIds[1], reason: 'ซ่อมไม่ได้' }, 'E_PERM');
    const d = await ok('owner', 'saveDisposal', { asset: unitIds[1], reason: 'ซ่อมไม่ได้', note: 'ลำโพงขาด' });
    await errCode('owner', 'saveDisposal', { asset: unitIds[1], reason: 'ซ่อมไม่ได้' }, 'E_INPUT');
    await ok('owner', 'saveDisposal', { id: d.id, reason: 'ชำรุดซ่อมไม่คุ้มค่า', note: 'แก้เหตุผล' });
    await ok('owner', 'decideDisposal', { id: d.id, decision: 'REJECT', note: 'ลองซ่อมอีกครั้ง' });
    assert.strictEqual(objs(sess.owner.state, 'Assets').find((a) => a.id === unitIds[1]).condition, 'DAMAGED');
    const d2 = await ok('owner', 'saveDisposal', { asset: unitIds[1], reason: 'ซ่อมไม่ได้' });
    await ok('owner', 'decideDisposal', { id: d2.id, decision: 'APPROVE' });
    assert.strictEqual(objs(sess.owner.state, 'Assets').find((a) => a.id === unitIds[1]).condition, 'DISPOSED');
    const d3 = await ok('owner', 'saveDisposal', { asset: lot.id, qty: 3, reason: 'หมดอายุการใช้งาน' });
    await ok('owner', 'decideDisposal', { id: d3.id, decision: 'APPROVE' });
    const st = sess.owner.state;
    assert.strictEqual(objs(st, 'Assets').find((a) => a.id === lot.id).qty, '57');   // 60 ที่สต๊อกกลาง - จำหน่าย 3
    assert.strictEqual(objs(st, 'Disposals').filter((x) => x.status === 'APPROVED').length, 2);
    void r;
  });

  console.log('\n[8] จัดการระบบ');
  await t('สถานที่ / ตัวเลือก (เปลี่ยนชื่อเก็บ alias) / ตั้งค่า / กันลบ admin คนสุดท้าย', async () => {
    const l = await ok('owner', 'saveLocation', { name: 'ห้อง A107', parent: 'L_BLDG_A', kind: 'ROOM' });
    await errCode('owner', 'saveLocation', { name: 'ห้อง A107', parent: 'L_BLDG_A', kind: 'ROOM' }, 'E_INPUT');
    const c = objs(sess.owner.state, 'Locations').find((x) => x.id === 'L_POOL');
    await errCode('owner', 'saveLocation', { id: 'L_POOL', version: c.version, name: c.name, kind: c.kind, active: false }, 'E_INPUT');
    const g = objs(sess.owner.state, 'Options').find((o) => o.kind === 'groups' && o.label === 'ผ้าและสิ่งทอ');
    await ok('owner', 'saveOption', { id: g.id, version: g.version, kind: 'groups', label: 'ผ้า/สิ่งทอ', sortOrder: g.sortOrder });
    const g2 = objs(sess.owner.state, 'Options').find((o) => o.id === g.id);
    assert.deepStrictEqual(JSON.parse(g2.aliases), ['ผ้าและสิ่งทอ']);
    const a = objs(sess.owner.state, 'Assets').find((x) => x.id === lot.id);
    await ok('owner', 'saveAsset', { id: a.id, version: a.version, name: a.name, group: a.group, unit: a.unit, note: 'ชื่อหมวดเดิมยังใช้ได้' });
    await ok('owner', 'saveSettings', { businessName: 'วังยาวรีสอร์ท', codePrefix: 'WYA', dueAlertDays: 3, imageMaxPx: 1440, imageTargetKB: 250, allowRegister: true, googleEnabled: false, googleClientId: '' });
    await errCode('owner', 'saveSettings', { businessName: 'x', codePrefix: 'WYA', dueAlertDays: 3, imageMaxPx: 1440, imageTargetKB: 250, googleEnabled: true, googleClientId: 'bad' }, 'E_INPUT');
    const me = objs(sess.owner.state, 'Users').find((u) => u.role === 'ADMIN');
    await errCode('owner', 'saveUser', { id: me.id, version: me.version, name: me.name, email: me.email, role: 'STAFF', status: 'ACTIVE' }, 'E_INPUT');
    await errCode('staff', 'saveLocation', { name: 'x', kind: 'AREA' }, 'E_PERM');
    void l;
  });
  await t('ตั้งรหัสชั่วคราวให้ผู้อื่น -> เซสชันเดิมถูกยกเลิก', async () => {
    const u = objs(sess.owner.state, 'Users').find((x) => x.email === 'staff@wangyao.test');
    await ok('owner', 'setTempPassword', { id: u.id, password: 'Reset1234' });
    assert.strictEqual((await post({ method: 'api', token: sess.staff.token, action: 'getState', payload: {} })).error.code, 'E_AUTH');
    sess.staff = await login('staff@wangyao.test', 'Reset1234');
    assert.strictEqual(sess.staff.user.mustChangePassword, true);
  });

  console.log('\n[9] ไฟล์แนบ');
  const upload = async (who, meta, bytes, mime = 'application/octet-stream') => {
    const fd = new FormData();
    fd.append('meta', JSON.stringify(Object.assign({ token: sess[who].token, requestId: rid() }, meta)));
    fd.append('file', new Blob([bytes], { type: mime }), meta.name || 'f');
    const r = await fetch(webUrl + '/api', { method: 'POST', headers: { Origin: webUrl }, body: fd });
    return r.json();
  };
  let fileId;
  await t('อัปโหลดภาพ (ตรวจ magic bytes) และดาวน์โหลดตามสิทธิ์', async () => {
    const jpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), crypto.randomBytes(40000)]);
    const r = await upload('owner', { entity: 'Repairs', entityId: rep, name: 'หลักฐาน.jpg' }, jpg, 'image/jpeg');
    assert(r.ok, JSON.stringify(r.error));
    fileId = r.data.data.id;
    const f = objs(r.data.state.partial ? (await full('owner')) : r.data.state, 'Files').find((x) => x.id === fileId);
    assert(f && !('driveId' in f) && f.mime === 'image/jpeg');
    const g = await ok('owner', 'getFile', { id: fileId });
    assert(Buffer.from(g.data.data, 'base64').equals(jpg));
    const bad = await upload('owner', { entity: 'Repairs', entityId: rep, name: 'virus.exe' }, Buffer.from('MZ\x90\x00 not allowed'));
    assert.strictEqual(bad.ok, false); assert(/รองรับเฉพาะ/.test(bad.error.message));
    const big = await upload('owner', { entity: 'Repairs', entityId: rep, name: 'big.jpg' }, Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), crypto.randomBytes(700 * 1024)]));
    assert.strictEqual(big.ok, false);
    // ช่างคนที่ 2 ไม่ได้รับมอบหมายงานนี้
    await errCode('tech2', 'getFile', { id: fileId }, 'E_PERM');
  });
  await t('PDF 3.2 MB อัปโหลดแบบแบ่ง 2 ส่วน (Vercel จำกัด 4.5 MB/คำขอ)', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(3.2 * 1024 * 1024)]);
    const uploadId = rid();
    const p1 = await upload('owner', { entity: 'Assets', entityId: lot.id, name: 'คู่มือ.pdf', part: 0, parts: 2, uploadId }, pdf.slice(0, 2500000));
    assert(p1.ok && p1.data.data.pending, JSON.stringify(p1));
    const p2 = await upload('owner', { entity: 'Assets', entityId: lot.id, name: 'คู่มือ.pdf', part: 1, parts: 2, uploadId }, pdf.slice(2500000));
    assert(p2.ok, JSON.stringify(p2.error));
    const id = p2.data.data.id;
    const a = await ok('owner', 'getFile', { id, part: 0 }), b = await ok('owner', 'getFile', { id, part: 1 });
    assert.strictEqual(a.data.parts, 2);
    assert(Buffer.concat([Buffer.from(a.data.data, 'base64'), Buffer.from(b.data.data, 'base64')]).equals(pdf));
    assert(!Object.values(env.files).some((f) => !f.trashed && /^tmp_/.test(f.blob.name)), 'ไฟล์ชั่วคราวต้องถูกลบ');
  });

  console.log('\n[10] แจ้งเตือน Telegram / LINE');
  await t('คิวแจ้งเตือน: 429 -> retry -> SENT, token ไม่ถูกส่งไปเบราว์เซอร์', async () => {
    let tgCalls = 0;
    env.setFetch((url) => {
      if (url.includes('api.telegram.org')) { tgCalls++; return tgCalls === 1 ? { code: 429, body: '{"ok":false,"parameters":{"retry_after":0}}' } : { code: 200, body: '{"ok":true}' }; }
      if (url.includes('api.line.me')) return { code: 200, body: '{}' };
      return { code: 404, body: '' };
    });
    await ok('owner', 'notifySave', { telegramToken: '123456:SECRET-TG-TOKEN', telegramChat: '-1001', lineToken: 'SECRET-LINE-TOKEN', lineTo: 'Uabc' });
    await ok('owner', 'notifyTest', {});
    let n = objs(await full('owner'), 'Notifications');
    assert(n.some((x) => x.channel === 'TELEGRAM' && x.status === 'PENDING' && /429/.test(x.lastError)));
    assert(n.some((x) => x.channel === 'LINE' && x.status === 'SENT'));
    env.freshExecution(); ctx.cronMinute();
    n = objs(await full('owner'), 'Notifications');
    assert(n.filter((x) => x.event === 'TEST').every((x) => x.status === 'SENT'), JSON.stringify(n.map((x) => [x.channel, x.status, x.lastError])));
    const s = JSON.stringify(sess.owner.state);
    assert(!s.includes('SECRET-TG-TOKEN') && !s.includes('SECRET-LINE-TOKEN'));
    assert(sess.owner.state.settings.notify.telegram === true);
    const lineReq = env.stats.fetches.find((f) => f.url.includes('api.line.me'));
    assert(/^[0-9a-f-]{36}$/.test(lineReq.o.headers['X-Line-Retry-Key']));
    // เหตุการณ์จริงเข้าคิว
    await ok('owner', 'createRepair', { asset: unitIds[2], issue: 'จอร้าว' });
    assert(objs(sess.owner.state, 'Notifications').some((x) => x.event === 'REPAIR_NEW'));
  });

  console.log('\n[11] ชั้น snapshot');
  const sheetIds = (n) => env.sheet(n).data.slice(1).map((r) => r[0]).filter(Boolean);
  await t('snapshot ในแคช = ข้อมูลในชีตทุกตาราง (หลังเขียน-แพตช์มาหลายรอบ)', async () => {
    env.freshExecution();
    const cached = ctx.tryLoadCached_(env.propStore.get('STATE_REV'));
    assert(cached, 'ต้องมี snapshot ในแคช');
    env.freshExecution();
    const fresh = ctx.readAllFromSheets_();
    ctx.SNAP_TABLES.forEach((n) => {
      assert.deepStrictEqual(cached.t[n].h, fresh.t[n].h, n + ' header');
      assert.strictEqual(cached.t[n].last, fresh.t[n].last, n + ' last');
      assert.strictEqual(cached.t[n].s, fresh.t[n].s, n + ' start');
      assert.deepStrictEqual(cached.t[n].r, fresh.t[n].r, n + ' rows');
    });
    for (const k of env.cacheStore.keys()) assert(env.cacheStore.get(k).length <= 100 * 1024);
  });
  await t('drift: มีคนแทรกแถวกลางชีต (ไม่ผ่าน trigger) -> ตรวจพบ สร้างใหม่ แล้วเขียนถูกแถว', async () => {
    const sh = env.sheet('Assets'), h = sh.data[0];
    const manual = h.map((c) => ({ id: 'MANUAL1', code: 'MANUAL-1', name: 'เพิ่มด้วยมือ', type: 'UNIT', qty: '1', unit: 'ชิ้น', group: 'อื่นๆ', location: 'CENTRAL', condition: 'READY', version: '1' }[c] || ''));
    sh._insertRowAt(3, manual);
    const a = objs(sess.owner.state, 'Assets').find((x) => x.id === unitIds[0]);
    await ok('owner', 'saveAsset', { id: a.id, version: a.version, name: a.name, group: a.group, unit: a.unit, serial: 'AFTER-DRIFT' });
    const row = sh.data.find((r) => r[0] === unitIds[0]);
    assert.strictEqual(row[h.indexOf('serial')], 'AFTER-DRIFT');
    assert.strictEqual(sh.data.filter((r) => r[0] === unitIds[0]).length, 1);
    assert(objs(await full('owner'), 'Assets').some((x) => x.id === 'MANUAL1'), 'แถวที่เพิ่มด้วยมือต้องเข้า snapshot');
  });
  await t('drift: id ในแถวไม่ตรง (สลับแถวด้วยมือ) -> ไม่เขียนผิดแถว', async () => {
    const sh = env.sheet('Assets'), h = sh.data[0];
    const i1 = sh.data.findIndex((r) => r[0] === unitIds[2]), i2 = sh.data.findIndex((r) => r[0] === 'MANUAL1');
    const tmp = sh.data[i1]; sh.data[i1] = sh.data[i2]; sh.data[i2] = tmp;
    const a = objs(sess.owner.state, 'Assets').find((x) => x.id === unitIds[2]);
    await ok('owner', 'saveAsset', { id: a.id, version: a.version, name: a.name, group: a.group, unit: a.unit, serial: 'SWAP-OK' });
    assert.strictEqual(sh.data.find((r) => r[0] === unitIds[2])[h.indexOf('serial')], 'SWAP-OK');
    assert.notStrictEqual(sh.data.find((r) => r[0] === 'MANUAL1')[h.indexOf('serial')], 'SWAP-OK');
  });
  await t('GAS ตายกลางการบันทึก -> journal PREPARED + PEND -> กู้คืนครบในคำขอถัดไป', async () => {
    const before = sheetIds('Assets').length;
    env.fault.failSetValuesAfter = 1;   // เขียน journal สำเร็จ แล้วตายตอนเขียนข้อมูลจริง
    const r = await api('owner', 'saveAsset', { name: 'กู้คืน', group: 'อื่นๆ', unit: 'ชิ้น', type: 'UNIT', qty: 2, location: 'CENTRAL' });
    assert.strictEqual(r.ok, false);
    assert(env.propStore.get('PEND'), 'ต้องมี PEND ค้าง');
    assert.strictEqual(sheetIds('Assets').length, before);
    const ops = env.sheet('Operations'), oh = ops.data[0];
    assert.strictEqual(ops.data[ops.data.length - 1][oh.indexOf('status')], 'PREPARED');
    const st = await full('owner');      // คำขอถัดไป (อ่าน) -> สร้าง snapshot -> recoverPending_
    assert(!env.propStore.get('PEND'));
    assert.strictEqual(sheetIds('Assets').length, before + 2);
    assert.strictEqual(objs(st, 'Assets').filter((a) => a.name === 'กู้คืน').length, 2);
    assert.strictEqual(ops.data[ops.data.length - 1][oh.indexOf('status')], 'COMMITTED');
    env.freshExecution(); ctx.recoverPending_();
    assert.strictEqual(sheetIds('Assets').length, before + 2, 'กู้ซ้ำต้องไม่เพิ่มแถว');
  });
  await t('replay requestId: กดซ้ำได้ผลเดิม ไม่บันทึกซ้ำ / requestId เดิมแต่ข้อมูลต่าง -> ปฏิเสธ', async () => {
    const id = rid(), before = sheetIds('Assets').length;
    const p = { name: 'กันกดซ้ำ', group: 'อื่นๆ', unit: 'ชิ้น', type: 'UNIT', qty: 1 };
    const a = await ok('owner', 'saveAsset', p, { requestId: id });
    const b = await ok('owner', 'saveAsset', p, { requestId: id });
    assert.deepStrictEqual(a.data, b.data);
    assert.strictEqual(sheetIds('Assets').length, before + 1);
    const c = await api('owner', 'saveAsset', Object.assign({}, p, { name: 'อื่น' }), { requestId: id });
    assert.strictEqual(c.ok, false);
  });
  await t('ส่งเฉพาะตารางที่เปลี่ยน (partial state) เมื่อหน้าเว็บมี rev ล่าสุด', async () => {
    const st = await full('owner');
    const r = await api('owner', 'addRepairNote', { id: rep, text: 'ติดตาม' }, { rev: st.rev });
    assert(r.data.state.partial);
    assert.deepStrictEqual(Object.keys(r.data.state.tables).sort(), ['AuditLogs', 'RepairNotes']);
    assert(r.data.state.delta, 'ควรส่งเฉพาะแถวที่เปลี่ยน');
    assert.strictEqual(r.data.state.tables.RepairNotes.r.length, 1);
    assert.strictEqual(r.data.state.tables.AuditLogs.r.length, 1);
  });
  await t('แคชหายทั้งหมด -> ยังใช้งานได้ (สร้าง snapshot ใหม่, เซสชันสำรองจากแท็บ Sessions)', async () => {
    env.cacheStore.clear();
    env.resetStats();
    const st = await full('owner');
    assert(st.tables.Assets.r.length > 0);
    assert(env.stats.batchGet >= 1, 'ควรอ่านผ่าน batchGet ครั้งเดียว');
    env.resetStats();
    await full('owner');
    assert.strictEqual(env.stats.open, 0, 'คำขอถัดไปต้องไม่เปิด Spreadsheet');
  });
  await t('แก้ชีตด้วยมือ (onEdit) -> STATE_REV เปลี่ยน -> สร้าง snapshot ใหม่อัตโนมัติ', async () => {
    const sh = env.sheet('Locations'), h = sh.data[0];
    const row = sh.data.find((r) => r[0] === 'L_SPA'); row[h.indexOf('name')] = 'สปา (แก้ในชีต)';
    const rev0 = env.propStore.get('STATE_REV'); ctx.onEdit({});
    assert.notStrictEqual(env.propStore.get('STATE_REV'), rev0);
    assert.strictEqual(objs(await full('owner'), 'Locations').find((l) => l.id === 'L_SPA').name, 'สปา (แก้ในชีต)');
  });
  await t('ตาราง window: AuditLogs เก็บใน snapshot แค่ 600 แถวท้าย แต่ในชีตไม่ถูกลบ', async () => {
    const env2 = env; env2.freshExecution();
    const owner = S.owner.id;
    for (let i = 0; i < 4; i++) ctx.runTx_(owner, 'bulkAudit', null, null, (db) => { for (let k = 0; k < 200; k++) db.audit('TEST', 'X', '', 'bulk ' + i + '-' + k); }, { journal: false });
    env.freshExecution();
    const snap = ctx.loadSnapshot_();
    assert.strictEqual(snap.t.AuditLogs.r.length, 600);
    assert.strictEqual(snap.t.AuditLogs.s + 599, snap.t.AuditLogs.last);
    assert(env.sheet('AuditLogs').data.length - 1 > 800);
    const page = await ok('owner', 'auditPage', {});
    assert.strictEqual(page.data.rows.length, 200);
  });
  await t('ล้างข้อมูลเก่ารายวัน: Operations > 14 วัน, Sessions/AuthTokens หมดอายุ > 2 วัน, AuditLogs ไม่ลบ', async () => {
    const ops = env.sheet('Operations'), oh = ops.data[0];
    ops.data[1][oh.indexOf('createdAt')] = new Date(Date.now() - 20 * 86400000).toISOString();
    const ss = env.sheet('Sessions'), sh = ss.data[0];
    ss.data[1][sh.indexOf('expiresAt')] = new Date(Date.now() - 3 * 86400000).toISOString();
    const audit = env.sheet('AuditLogs').data.length, nOps = ops.data.filter((r) => r[0]).length, nS = ss.data.filter((r) => r[0]).length;
    env.freshExecution(); const out = ctx.cleanup_();
    assert.strictEqual(out.Operations, 1); assert.strictEqual(out.Sessions, 1);
    assert.strictEqual(ops.data.filter((r) => r[0]).length, nOps - 1);
    assert.strictEqual(ss.data.filter((r) => r[0]).length, nS - 1);
    assert.strictEqual(env.sheet('AuditLogs').data.length, audit);
  });
  await t('รัน setupDatabase ซ้ำ: ข้อมูลเดิมไม่หาย และเติมคอลัมน์ที่ขาด', async () => {
    const sh = env.sheet('Assets'), h = sh.data[0], li = h.indexOf('loan');
    const nRows = sh.data.filter((r) => r[0]).length;
    const nRoles = env.sheet('Roles').data.filter((r) => r[0]).length;
    h[li] = '';                      // จำลองหัวคอลัมน์ loan หาย
    env.freshExecution(); ctx.setupDatabase();
    assert.strictEqual(env.sheet('Assets').data[0][li], 'loan');
    assert.strictEqual(sh.data.filter((r) => r[0]).length, nRows);
    assert.strictEqual(env.sheet('Roles').data.filter((r) => r[0]).length, nRoles);
    assert.strictEqual(env.sheet('Users').data.filter((r) => r[0] && r[0] !== 'id').length, 6);
    assert((await full('owner')).tables.Assets.r.length >= nRows - 1);
  });
  await t('Sheets API 403 -> fallback getValues ยังสร้าง snapshot ได้', async () => {
    const e2 = createEnv({ quiet: true, sheetsApi403: true });
    e2.freshExecution(); e2.ctx.setupDatabase();
    assert(e2.propStore.get('REST_OFF'));
    e2.freshExecution(); const snap = e2.ctx.loadSnapshot_();
    assert.strictEqual(snap.t.Roles.r.length, 7);
  });

  console.log('\n[12] ขนาดข้อมูล 5,000 รายการทะเบียน');
  await t('เพิ่ม 5,000 รายการ แล้ววัดเวลา/ขนาด', async () => {
    const sh = env.sheet('Assets'), h = sh.data[0], now = new Date().toISOString();
    const groups = ['เฟอร์นิเจอร์', 'เครื่องใช้ไฟฟ้า', 'อุปกรณ์ห้องพัก', 'อุปกรณ์ครัว'], locs = ['CENTRAL', 'L_A101', 'L_A102', 'L_POOL', 'L_REST', 'L_B201'];
    const base = sh.data.length;
    for (let i = 0; i < 5000; i++) {
      const o = { id: 'BULK' + i, owner: S.owner.id, createdAt: now, updatedAt: now, updatedBy: S.owner.id, version: '1', code: 'WYA-20260101-' + String(10000 + i), item: 'I1', batch: '',
        name: 'เก้าอี้ไม้สักห้องพัก รุ่น ' + (i % 50), brand: 'ไม่ระบุ', group: groups[i % 4], type: 'UNIT', qty: '1', unit: 'ตัว', price: String(1000 + i), year: '2567',
        purchase: '2024-01-15', received: '2024-01-20', location: locs[i % 6], condition: i % 17 === 0 ? 'DAMAGED' : 'READY', responsible: '', serial: 'SN' + (100000 + i), note: 'นำเข้าทดสอบ', loan: '' };
      sh.data.push(h.map((c) => (o[c] == null ? '' : o[c])));
    }
    sh.maxRows = Math.max(sh.maxRows, base + 5100);
    ctx.invalidate_();
    env.freshExecution(); env.resetStats();
    let t0 = Date.now(); ctx.loadSnapshot_(); metrics.rebuild5k = Date.now() - t0;
    metrics.rebuildSheetCalls = env.stats.sheetCalls; metrics.rebuildBatchGet = env.stats.batchGet;
    const keys = [...env.cacheStore.keys()].filter((k) => k.startsWith('ST:Assets:'));
    metrics.assetChunks = keys.length; metrics.assetCacheChars = keys.reduce((s, k) => s + env.cacheStore.get(k).length, 0);
    env.freshExecution(); t0 = Date.now(); ctx.loadSnapshot_(); metrics.loadFromCache5k = Date.now() - t0;
    env.resetStats();
    t0 = Date.now(); const lg = await call('login', { identifier: OWNER.email, password: OWNER.password }); metrics.login5kMs = Date.now() - t0;
    assert(lg.ok);
    metrics.loginOpen = env.stats.open; metrics.loginSheetCalls = env.stats.sheetCalls;
    sess.owner = lg.data;
    const raw = JSON.stringify(lg); metrics.stateJsonKB = Math.round(raw.length / 1024); metrics.stateGzipKB = Math.round(zlib.gzipSync(raw).length / 1024);
    env.resetStats();
    t0 = Date.now(); await full('owner'); metrics.getState5kMs = Date.now() - t0; metrics.getStateOpen = env.stats.open;
    env.resetStats();
    t0 = Date.now(); const w = await api('owner', 'saveAsset', { name: 'วัดเวลาบันทึก', group: 'อื่นๆ', unit: 'ชิ้น', type: 'UNIT', qty: 1 }, { rev: sess.owner.state.rev });
    metrics.save5kMs = Date.now() - t0; metrics.saveSheetCalls = env.stats.sheetCalls; metrics.saveOpen = env.stats.open; metrics.saveFlush = env.stats.flush;
    assert(w.ok && w.data.state.partial);
    metrics.savePartialKB = Math.round(JSON.stringify(w).length / 1024);
    env.resetStats();
    t0 = Date.now(); const u = await post({ method: 'api', token: sess.owner.token, action: 'getState', payload: {}, rev: w.data.state.rev }); metrics.pollUnchangedMs = Date.now() - t0;
    assert(u.data.unchanged);
  });

  await S.close();
  console.log('\nตัวเลขที่วัดได้ (เครื่องทดสอบ, GAS จำลอง):');
  Object.entries(metrics).forEach(([k, v]) => console.log('  ' + k.padEnd(22) + v));
  console.log('\nสรุป: ผ่าน ' + pass + ' / ' + (pass + failN) + (failN ? '  (ไม่ผ่าน ' + failN + ')' : ''));
  require('fs').writeFileSync(require('path').join(__dirname, 'backend-metrics.json'), JSON.stringify({ pass, fail: failN, metrics, results }, null, 2));
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
