'use strict';
/**
 * ทดสอบหน้าเว็บด้วยเบราว์เซอร์จริง (Playwright + Edge/Chrome ที่ติดตั้งในเครื่อง)
 * กับสแตก: index.html -> api/gas.js -> Code.gs (gas-mock)
 *   PW_DEPS=<โฟลเดอร์ที่มี node_modules/playwright-core,jsqr> SHOTS=<โฟลเดอร์ภาพ> node test/ui.test.js
 */
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const assert = require('assert');
const DEPS = process.env.PW_DEPS || path.join(__dirname, '..');
const { chromium } = require(path.join(DEPS, 'node_modules', 'playwright-core'));
const jsQR = require(path.join(DEPS, 'node_modules', 'jsqr'));
const { startStack, OWNER } = require('./server');

const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));

let pass = 0, failN = 0;
const timings = {};
async function t(name, fn) {
  const t0 = Date.now();
  try { await fn(); pass++; console.log('  ✔ ' + name + ' (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { failN++; console.log('  ✘ ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n      ')); }
}

/** PNG สีพาสเทลจริง (ไว้ทดสอบการบีบอัดภาพในเบราว์เซอร์) */
function makePng(w, h) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200 + (x % 55); raw[o + 1] = 160 + (y % 90); raw[o + 2] = 230 - ((x * y) % 80); } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const SWAL_SPY = `(() => {
  window.__swal = []; let last = '';
  const scan = () => {
    const p = document.querySelector('.swal2-popup'); if (!p || !p.isConnected) { last = ''; return; }
    const title = ((p.querySelector('.swal2-title') || {}).textContent || '').trim();
    const icon = ['success', 'error', 'warning', 'question', 'info'].find((i) => p.classList.contains('swal2-icon-' + i)) || (p.classList.contains('swal2-loading') ? 'loading' : '');
    const key = icon + '|' + title + '|' + p.classList.contains('swal2-toast');
    if (key !== last) { last = key; window.__swal.push({ icon, title, toast: p.classList.contains('swal2-toast'), err: p.classList.contains('swal-error') }); }
  };
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`;

(async () => {
  if (!BROWSER) { console.log('ไม่พบ Edge/Chrome ในเครื่อง'); process.exit(1); }
  const S = await startStack({ quiet: true, gasLatency: Number(process.env.GAS_LATENCY || 0) });
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  const pngPath = path.join(SHOTS, 'sample.png'); fs.writeFileSync(pngPath, makePng(1800, 1200));
  const pdfPath = path.join(SHOTS, 'sample.pdf'); fs.writeFileSync(pdfPath, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3000, 32), Buffer.from('\n%%EOF')]));

  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'th-TH', timezoneId: 'Asia/Bangkok', acceptDownloads: true });
  await ctx.addInitScript(SWAL_SPY);
  const page = await ctx.newPage();
  const apiCalls = [];
  page.on('request', (r) => { if (r.url().endsWith('/api')) apiCalls.push(r.url()); });
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const swal = () => page.evaluate(() => window.__swal.slice());
  const clearSwal = () => page.evaluate(() => { window.__swal.length = 0; });
  const waitSwal = async (icon, re, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const log = await swal();
      const hit = log.find((x) => x.icon === icon && (!re || re.test(x.title)));
      if (hit) return hit;
      const err = log.find((x) => x.icon === 'error');
      if (err && icon !== 'error') throw new Error('เจอป๊อปอัปผิดพลาด: ' + JSON.stringify(log.slice(-3)));
      await page.waitForTimeout(80);
    }
    throw new Error('ไม่พบป๊อปอัป ' + icon + ' ' + re + ' log=' + JSON.stringify(await swal()));
  };
  const swalGone = () => page.waitForFunction(() => !document.querySelector('.swal2-container:not(.swal2-toast-shown) .swal2-popup:not(.swal2-toast)'), null, { timeout: 15000 }).catch(() => { });
  const confirmSwal = async (value) => {
    await page.waitForSelector('.swal2-popup .swal2-confirm', { state: 'visible' });
    if (value != null) { const inp = await page.$('.swal2-popup .swal2-input:not([style*="display: none"]), .swal2-popup .swal2-textarea[style*="flex"], .swal2-popup textarea.swal2-textarea'); if (inp && await inp.isVisible()) await inp.fill(String(value)); }
    await page.click('.swal2-popup .swal2-confirm');
  };
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
  const nav = async (id) => { await page.click(`#nav a[data-page="${id}"]`); await page.waitForTimeout(60); };
  const fillForm = async (vals) => { for (const [k, v] of Object.entries(vals)) { const el = await page.$('#f_' + k); const tag = await el.evaluate((e) => e.tagName); if (tag === 'SELECT') await page.selectOption('#f_' + k, typeof v === 'object' ? v : { label: v }); else await page.fill('#f_' + k, String(v)); } };
  const submitForm = () => page.click('button[type=submit][form=mForm]');
  const pick = async (picker, text) => { await page.fill(`[data-picker="${picker}"] .picker-q`, text); await page.waitForSelector(`[data-picker="${picker}"] .picker-res button`); await page.click(`[data-picker="${picker}"] .picker-res button`); };

  console.log('\n[UI] หน้าเข้าสู่ระบบ');
  await t('เปิดหน้า login + SweetAlert2 โหลดจาก CDN (SRI) สำเร็จ', async () => {
    await page.goto(S.webUrl);
    await page.waitForSelector('#loginForm');
    assert.strictEqual(await page.evaluate(() => !!window.Swal && !window.__swalFallback), true, 'Swal ไม่ได้มาจาก CDN');
    await page.waitForFunction(() => document.querySelector('#loginTitle').textContent.includes('วังยาว'));
    await shot('01-login-desktop');
  });
  await t('รหัสผิด -> ป๊อปอัปแดง "ทำรายการไม่สำเร็จ" พร้อมสาเหตุ', async () => {
    await clearSwal();
    await page.fill('#l_identifier', OWNER.email); await page.fill('#l_password', 'Wrong1234'); await page.click('#loginForm button[type=submit]');
    await waitSwal('loading', /กำลังตรวจบัญชี/);
    const e = await waitSwal('error', /ทำรายการไม่สำเร็จ/);
    assert(e.err, 'ต้องใช้ธีม swal-error');
    assert(/ไม่ถูกต้อง/.test(await page.textContent('.swal2-html-container')));
    await shot('02-login-error');
    await page.click('.swal2-confirm');
  });
  await t('ล็อกอินสำเร็จ (คำขอเดียว) -> toast ยินดีต้อนรับ -> แดชบอร์ด', async () => {
    await clearSwal(); apiCalls.length = 0;
    await page.fill('#l_password', OWNER.password);
    const t0 = Date.now(); await page.click('#loginForm button[type=submit]');
    await page.waitForSelector('#app:not(.hidden) #page .stat');
    timings.loginToDashboardMs = Date.now() - t0;
    assert.strictEqual(apiCalls.length, 1, 'ล็อกอินควรเป็นคำขอเดียว: ' + apiCalls.length);
    await waitSwal('success', /ยินดีต้อนรับ/);
    await shot('03-dashboard-desktop');
  });

  console.log('\n[UI] เมนูทั้งหมด (ไม่เรียกเซิร์ฟเวอร์)');
  await t('คลิกทุกเมนู: เปลี่ยนหน้า < 0.3 วินาที และไม่มีคำขอไป /api', async () => {
    const ids = await page.$$eval('#nav a', (as) => as.map((a) => a.dataset.page));
    assert(ids.length >= 11, 'เมนูไม่ครบ: ' + ids.join(','));
    apiCalls.length = 0; const times = {};
    for (const id of ids) {
      const ms = await page.evaluate(async (pid) => { const t0 = performance.now(); document.querySelector(`#nav a[data-page="${pid}"]`).click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t0; }, id);
      times[id] = Math.round(ms);
      assert(ms < 300, id + ' ใช้เวลา ' + ms);
      assert.strictEqual(await page.evaluate((pid) => document.querySelector('#nav a.on').dataset.page, id), id);
    }
    assert.strictEqual(apiCalls.length, 0, 'เปลี่ยนหน้าไม่ควรเรียก API');
    timings.navMs = times;
  });

  console.log('\n[UI] จัดการระบบ');
  await t('เพิ่มผู้ใช้ช่าง (รหัสชั่วคราว) -> สำเร็จ', async () => {
    await page.goto(S.webUrl + '/#/admin?tab=users'); await page.waitForSelector('[data-act="user-new"]');
    await clearSwal(); await page.click('[data-act="user-new"]');
    await fillForm({ name: 'ช่างสมศักดิ์', email: 'somsak@wangyao.test', phone: '0891112222', role: { value: 'TECH' }, password: 'Temp5678' });
    await shot('04-user-form');
    await submitForm();
    await waitSwal('loading'); await waitSwal('success', /เพิ่มผู้ใช้เรียบร้อย/);
    await page.waitForSelector('text=ช่างสมศักดิ์');
  });
  await t('ตั้งค่าระบบ / ตัวเลือก / สถานที่ / แจ้งเตือน (กรณีผิดพลาด) / ประวัติ', async () => {
    await page.click('[data-act="filter"][data-val="settings"]'); await page.waitForSelector('#settingsForm');
    await clearSwal(); await page.fill('#p_dueAlertDays', '5'); await page.click('#settingsForm button[type=submit]'); await waitSwal('success', /บันทึกการตั้งค่า/);
    await page.click('[data-act="filter"][data-val="options"]'); await page.waitForSelector('[data-act="opt-new"][data-kind="groups"]');
    await clearSwal(); await page.click('[data-act="opt-new"][data-kind="groups"]'); await confirmSwal('อุปกรณ์กีฬา'); await waitSwal('success');
    await page.waitForSelector('text=อุปกรณ์กีฬา');
    await clearSwal(); await page.click('.list-item:has-text("อุปกรณ์กีฬา") [data-act="opt-toggle"]'); await waitSwal('warning', /ปิดตัวเลือก/); await shot('05-confirm-disable-option'); await page.click('.swal2-confirm'); await waitSwal('success', /ปิดตัวเลือก/);
    await page.click('[data-act="filter"][data-val="locations"]'); await clearSwal(); await page.click('[data-act="loc-new"]');
    await fillForm({ name: 'ห้อง A201', kind: { value: 'ROOM' }, parent: { value: 'L_BLDG_A' } }); await submitForm(); await waitSwal('success', /เพิ่มสถานที่/);
    await page.click('[data-act="filter"][data-val="notify"]'); await clearSwal(); await page.click('[data-act="notify-test"]');
    await waitSwal('error', /ทำรายการไม่สำเร็จ/); assert(/ยังไม่ได้ตั้งค่าช่องทาง/.test(await page.textContent('.swal2-html-container'))); await page.click('.swal2-confirm');
    await page.click('[data-act="filter"][data-val="history"]'); await page.waitForSelector('text=ประวัติการทำรายการ');
    await shot('06-admin-history');
  });

  console.log('\n[UI] ทะเบียนสิ่งของ');
  let assetCode = '';
  await t('ลงทะเบียน 2 ชิ้น + แนบภาพ (บีบอัดในเบราว์เซอร์) -> ขั้นตอนอัปโหลด -> สำเร็จ', async () => {
    await nav('assets'); await clearSwal(); await page.click('[data-act="asset-new"]');
    await fillForm({ name: 'เครื่องปรับอากาศ 18000 BTU', group: 'เครื่องใช้ไฟฟ้า', brand: 'Daikin', unit: 'เครื่อง', qty: 2, location: { value: 'L_A101' }, price: 21900, serial: 'DK-001' });
    await page.setInputFiles('#mForm input[type=file]', [pngPath]);
    await shot('07-asset-form');
    await submitForm();
    await waitSwal('loading', /อัปโหลดไฟล์ 1 \/ 1/);
    await waitSwal('success', /ลงทะเบียนเรียบร้อย/);
    await page.waitForSelector('#list tr.click:has-text("เครื่องปรับอากาศ 18000 BTU")');
    const files = S.env.ctx; void files;
    const f = Object.values(S.env.files).find((x) => /\.jpg$/.test(x.blob.name));
    assert(f, 'ต้องมีไฟล์ภาพใน Drive'); assert(f.blob.buf.length <= 512 * 1024, 'ภาพต้อง ≤ 512 KB: ' + f.blob.buf.length);
    assert(f.blob.buf[0] === 0xFF && f.blob.buf[1] === 0xD8, 'ต้องเป็น JPEG');
    timings.compressedImageKB = Math.round(f.blob.buf.length / 1024);
  });
  await t('ค้นหา/กรอง แล้วเปิดรายละเอียด + QR ถอดรหัสได้ลิงก์ ?asset=', async () => {
    await page.fill('[data-filter="q"]', 'DK-001'); await page.waitForTimeout(400);
    const withFile = new S.env.ctx.Db_(S.env.ctx.loadSnapshot_()).rows('Files').find((f) => f.entity === 'Assets');
    assert.strictEqual(await page.$$eval('#list tr.click', (r) => r.length), 2, 'ลงทะเบียน 2 ชิ้น serial เดียวกัน');
    await page.click('#list tr.click[data-id="' + withFile.entityId + '"]');
    await page.waitForSelector('.modal .qrbox svg');
    assetCode = (await page.textContent('.modal .kv .code')).trim();
    const img = await page.evaluate(async () => {
      const svg = document.querySelector('.modal .qrbox svg').outerHTML;
      const im = new Image(); im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await im.decode();
      const c = document.createElement('canvas'); c.width = c.height = 400; const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(im, 0, 0, 400, 400);
      return Array.from(x.getImageData(0, 0, 400, 400).data);
    });
    const code = jsQR(Uint8ClampedArray.from(img), 400, 400);
    assert(code, 'ถอดรหัส QR ไม่ได้');
    assert(/\?asset=A/.test(code.data) && code.data.startsWith(S.webUrl), code.data);
    await shot('08-asset-detail');
  });
  await t('เปิดไฟล์แนบ (โหลดเมื่อกดเท่านั้น)', async () => {
    apiCalls.length = 0;
    await page.click('.modal [data-act="open-file"]');
    await page.waitForSelector('.swal2-image');
    assert(apiCalls.length >= 1);
    await page.click('.swal2-confirm');
  });

  console.log('\n[UI] งานซ่อม');
  await t('แจ้งซ่อมจากหน้ารายละเอียด (มอบหมายช่าง) -> ประเมิน -> อนุมัติ -> ปิดงาน -> ตรวจรับ', async () => {
    await clearSwal();
    await page.click('.modal [data-act="repair-new"]');
    await page.waitForSelector('[data-picker="rpAsset"] .picker-sel .chip');
    await fillForm({ issue: 'ไม่เย็น มีน้ำหยด', assigned: 'ช่างสมศักดิ์', due: '2030-12-31' });
    await page.setInputFiles('#mForm input[type=file]', [pngPath]);
    await submitForm(); await waitSwal('success', /แจ้งซ่อมเรียบร้อย/);
    await nav('repairs'); await page.click('#list tr.click:has-text("ไม่เย็น")');
    await clearSwal(); await page.click('.modal [data-act="repair-assess"]');
    await fillForm({ estimate: 1800, days: 2, note: 'เติมน้ำยา ล้างแผง' }); await submitForm(); await waitSwal('success', /ผลประเมิน/);
    await page.waitForSelector('.modal [data-act="repair-approve"]');
    await clearSwal(); await page.click('.modal [data-act="repair-approve"]'); await page.waitForSelector('.swal2-input');
    await shot('09-approve-input'); await page.fill('.swal2-input', '1800'); await page.click('.swal2-confirm'); await waitSwal('success', /อนุมัติงานซ่อม/);
    await page.waitForSelector('.modal [data-act="repair-complete"]');
    await clearSwal(); await page.click('.modal [data-act="repair-complete"]');
    const rows = await page.$$('#costRows tr');
    await rows[0].$eval('[name=amount]', (e) => { e.value = '1200'; }); await rows[0].$eval('[name=note]', (e) => { e.value = 'น้ำยา R32'; });
    await rows[1].$eval('[name=amount]', (e) => { e.value = '500'; });
    await page.click('[data-act="cost-add"]'); await page.click('#costRows tr:last-child [data-act="cost-remove"]');
    await page.fill('#f_note', 'เติมน้ำยาเรียบร้อย'); await submitForm(); await waitSwal('success', /ปิดงานซ่อมเรียบร้อย/);
    await page.waitForSelector('.modal [data-act="repair-accept"]');
    await clearSwal(); await page.click('.modal [data-act="repair-accept"]'); await confirmSwal(); await waitSwal('success', /ตรวจรับงาน/);
    await page.waitForSelector('.modal .chip:has-text("เสร็จสิ้น")');
    await shot('10-repair-done');
    const r = new S.env.ctx.Db_(S.env.ctx.loadSnapshot_()).rows('Repairs').find((x) => x.issue === 'ไม่เย็น มีน้ำหยด');
    assert.strictEqual(r.status, 'DONE'); assert.strictEqual(r.approved, '1800');
  });
  await t('พิมพ์ใบส่งซ่อม (รวมรูปหลักฐาน) เปิดหน้าต่างพิมพ์', async () => {
    const [pop] = await Promise.all([page.waitForEvent('popup'), page.click('.modal [data-act="repair-print"]')]);
    await pop.waitForSelector('text=ใบส่งซ่อม', { timeout: 15000 });
    await pop.waitForSelector('.imgs img');
    await pop.screenshot({ path: path.join(SHOTS, '11-print-repair.png') });
    await pop.close();
    await page.click('.modal [data-act="close-modal"]');
  });

  console.log('\n[UI] ยืมคืน / ย้าย / จำหน่าย');
  await t('สร้างใบยืม (ค้นหา+เลือก 1 รายการ) แล้วรับคืน', async () => {
    await nav('loans'); await clearSwal(); await page.click('[data-act="loan-new"]');
    await fillForm({ borrower: 'คุณมานี (งานเลี้ยง)', phone: '0812223333' });
    await pick('lnAsset', assetCode);
    await page.waitForSelector('#loanLines tr td');
    await shot('12-loan-form');
    await submitForm(); await waitSwal('success', /บันทึกการยืมเรียบร้อย/);
    await page.click('#list tr.click'); await page.click('.modal [data-act="loan-return"]');
    await page.selectOption('tr[data-line] [name=condition]', 'READY');
    await clearSwal(); await submitForm(); await waitSwal('success', /บันทึกการคืน/);
    await page.waitForSelector('.modal .chip:has-text("คืนครบ")');
    const [pop] = await Promise.all([page.waitForEvent('popup'), page.click('.modal [data-act="loan-print"]')]);
    await pop.waitForSelector('text=ใบยืม-คืน'); await pop.close();
    await page.click('.modal [data-act="close-modal"]');
  });
  await t('ย้ายสิ่งของไปสถานที่อื่น', async () => {
    await nav('move'); await pick('mvAsset', assetCode);
    await page.selectOption('#p_to', 'L_A102'); await page.fill('#moveForm [name=note]', 'สลับห้อง');
    await clearSwal(); await page.click('#moveForm button[type=submit]'); await waitSwal('success', /ย้าย/);
    await page.waitForSelector('text=สลับห้อง');
    await shot('13-move');
  });
  await t('เสนอจำหน่าย (ยืนยันก่อน) -> อนุมัติจากหน้าอนุมัติรายการ (badge)', async () => {
    await nav('disposals'); await clearSwal(); await page.click('[data-act="disposal-new"]');
    await pick('dpAsset', assetCode); await page.selectOption('#f_reason', { label: 'ล้าสมัย' });
    await submitForm(); await waitSwal('warning', /ยืนยันเสนอจำหน่าย/); await page.click('.swal2-confirm');
    await waitSwal('success', /ส่งคำขอจำหน่าย/);
    const badge = await page.textContent('#nav a[data-page="approvals"] .badge');
    assert(Number(badge) >= 1, 'badge ' + badge);
    await nav('approvals'); await shot('14-approvals');
    await clearSwal(); await page.click('[data-act="disposal-approve"]'); await waitSwal('warning', /อนุมัติจำหน่าย/); await page.click('.swal2-confirm');
    await waitSwal('success', /อนุมัติจำหน่ายเรียบร้อย/);
  });

  console.log('\n[UI] รายงาน');
  await t('ทุกแท็บรายงาน + ส่งออก CSV (มี BOM, กันสูตร) + พิมพ์ A4', async () => {
    await nav('reports');
    const tabs = await page.$$eval('.tabs .tab', (b) => b.map((x) => x.dataset.val));
    assert(tabs.includes('budget') && tabs.includes('today'), tabs.join(','));
    for (const k of tabs) { await page.click(`.tabs .tab[data-val="${k}"]`); await page.waitForSelector(`[data-act="report-csv"][data-type="${k}"]`); }
    await page.click('.tabs .tab[data-val="assets"]');
    await clearSwal();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="report-csv"]')]);
    const buf = fs.readFileSync(await dl.path());
    assert.strictEqual(buf.slice(0, 3).toString('hex'), 'efbbbf', 'CSV ต้องมี BOM');
    assert(buf.toString('utf8').includes('เครื่องปรับอากาศ'));
    await waitSwal('success', /ส่งออก CSV/);
    await page.click('.tabs .tab[data-val="budget"]');
    const [pop] = await Promise.all([page.waitForEvent('popup'), page.click('[data-act="report-print"]')]);
    await pop.waitForSelector('table'); await pop.screenshot({ path: path.join(SHOTS, '15-print-budget.png') }); await pop.close();
  });

  console.log('\n[UI] อื่น ๆ');
  await t('กิจกรรมวันนี้ + โครงสร้างฐานข้อมูล', async () => {
    await nav('activity'); await page.waitForSelector('#list table');
    await nav('schema'); await clearSwal(); await page.click('[data-act="schema-load"]'); await waitSwal('success', /โหลดโครงสร้าง/);
    assert(await page.isVisible('text=Operations'));
    await shot('16-schema');
  });
  await t('รีเฟรช: ข้อมูลไม่เปลี่ยน -> toast, แถบสถานะแสดงเวลาตอบสนอง', async () => {
    await clearSwal(); await page.click('[data-act="refresh"]'); await waitSwal('success', /อัปเดตข้อมูลล่าสุด/);
    assert(/ตอบสนอง \d+\.\d วินาที/.test(await page.textContent('#latency')));
  });
  await t('เปลี่ยนรหัสผ่าน: รหัสใหม่ไม่ตรงกัน -> เตือน, ยกเลิกได้', async () => {
    await clearSwal(); await page.click('[data-act="change-password"]');
    await fillForm({ current: OWNER.password, next: 'Abcd12345', next2: 'Abcd99999' }); await submitForm();
    await waitSwal('warning', /ไม่ตรงกัน/);
    await page.click('.modal [data-act="close-modal"]');
  });
  await t('อินเทอร์เน็ตหลุด/กลับมา แจ้งเตือน', async () => {
    await clearSwal(); await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await waitSwal('warning', /อินเทอร์เน็ตหลุด/);
    await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitSwal('success', /กลับมาแล้ว/);
  });
  await t('ออกจากระบบ (ยืนยันก่อน)', async () => {
    await clearSwal(); await page.click('[data-act="logout"]'); await waitSwal('question', /ออกจากระบบ/); await page.click('.swal2-confirm');
    await page.waitForSelector('#loginForm');
  });
  await t('เซสชันหมดอายุ -> ไอคอนเตือน แล้วกลับหน้า login', async () => {
    await page.fill('#l_identifier', OWNER.email); await page.fill('#l_password', OWNER.password); await page.click('#loginForm button[type=submit]');
    await page.waitForSelector('#app:not(.hidden)');
    await page.evaluate(() => { API.setToken('f'.repeat(96)); });
    await clearSwal(); await page.click('[data-act="refresh"]');
    await waitSwal('warning', /เซสชันหมดอายุ/); await page.click('.swal2-confirm'); await page.waitForSelector('#loginForm');
  });
  await t('ไม่มี console error ตลอดการทดสอบ desktop', async () => { assert.deepStrictEqual(errors, []); });

  console.log('\n[UI] มือถือ');
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
  await m.addInitScript(SWAL_SPY);
  const mp = await m.newPage();
  const merr = []; mp.on('pageerror', (e) => merr.push(e.message)); mp.on('console', (x) => { if (x.type() === 'error' && !/fonts\./.test(x.text())) merr.push(x.text()); });
  await t('มือถือ: login, แดชบอร์ด, เมนูพับได้, ตารางเลื่อนแนวนอน, ไม่ล้นจอ', async () => {
    await mp.goto(S.webUrl); await mp.waitForSelector('#loginForm'); await mp.screenshot({ path: path.join(SHOTS, '20-login-mobile.png') });
    await mp.fill('#l_identifier', OWNER.email); await mp.fill('#l_password', OWNER.password); await mp.click('#loginForm button[type=submit]');
    await mp.waitForSelector('#page .stat'); await mp.waitForTimeout(2300);
    await mp.screenshot({ path: path.join(SHOTS, '21-dashboard-mobile.png') });
    const over = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(over <= 1, 'หน้าล้นแนวนอน ' + over + 'px');
    assert(!(await mp.isVisible('#side .nav a[data-page="assets"]')) || (await mp.evaluate(() => document.querySelector('#side').getBoundingClientRect().right <= 0)), 'เมนูต้องพับอยู่');
    await mp.click('#menuBtn'); await mp.waitForTimeout(300); await mp.screenshot({ path: path.join(SHOTS, '22-menu-mobile.png') });
    await mp.click('#nav a[data-page="assets"]'); await mp.waitForSelector('#list table');
    const tw = await mp.evaluate(() => { const w = document.querySelector('.table-wrap'); return { sw: w.scrollWidth, cw: w.clientWidth, page: document.documentElement.scrollWidth - innerWidth }; });
    assert(tw.sw > tw.cw && tw.page <= 1, JSON.stringify(tw));
    await mp.screenshot({ path: path.join(SHOTS, '23-assets-mobile.png') });
    await mp.click('[data-act="asset-new"]'); await mp.waitForSelector('#mForm');
    const cols = await mp.evaluate(() => getComputedStyle(document.querySelector('.form-grid')).gridTemplateColumns.split(' ').length);
    assert.strictEqual(cols, 1, 'ฟอร์มมือถือต้องคอลัมน์เดียว');
    const small = await mp.evaluate(() => Array.from(document.querySelectorAll('.modal .btn, .modal .input')).filter((e) => e.offsetParent && e.getBoundingClientRect().height < 36).length);
    assert.strictEqual(small, 0, 'ปุ่ม/ช่องกรอกเล็กเกินไป');
    await mp.screenshot({ path: path.join(SHOTS, '24-form-mobile.png') });
    assert.deepStrictEqual(merr, []);
  });

  console.log('\n[UI] CDN ของ SweetAlert2 ล่ม');
  await t('ใช้ป๊อปอัปสำรองในหน้า (ไม่มี error) ยังแจ้งผิดพลาดได้', async () => {
    const c = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await c.route(/sweetalert2/, (r) => r.abort());
    const p = await c.newPage(); const ee = []; p.on('pageerror', (e) => ee.push(e.message));
    await p.goto(S.webUrl); await p.waitForSelector('#loginForm');
    assert.strictEqual(await p.evaluate(() => window.__swalFallback === true), true);
    await p.fill('#l_identifier', OWNER.email); await p.fill('#l_password', 'Wrong1234'); await p.click('#loginForm button[type=submit]');
    await p.waitForSelector('.fb-box.err >> text=ทำรายการไม่สำเร็จ', { timeout: 15000 });
    await p.screenshot({ path: path.join(SHOTS, '30-fallback-error.png') });
    await p.click('.fb-ok');
    await p.fill('#l_password', OWNER.password); await p.click('#loginForm button[type=submit]'); await p.waitForSelector('#page .stat');
    assert.deepStrictEqual(ee, []);
    await c.close();
  });

  process.on('unhandledRejection', (e) => { if (!/Target page, context or browser has been closed/.test(String(e))) throw e; });
  for (const c of [m, ctx]) await c.close().catch(() => { });
  await browser.close().catch(() => { }); await S.close();
  console.log('\nเวลา (เครื่องทดสอบ):', JSON.stringify(timings));
  console.log('สรุป UI: ผ่าน ' + pass + ' / ' + (pass + failN));
  fs.writeFileSync(path.join(SHOTS, 'ui-result.json'), JSON.stringify({ pass, fail: failN, timings }, null, 2));
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
