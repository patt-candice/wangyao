'use strict';
/**
 * สแตกทดสอบในเครื่อง: Code.gs จริง (บน gas-mock) + api/gas.js จริง + public/index.html
 *   node test/server.js            -> เปิด http://127.0.0.1:5173 (ผู้ใช้ owner@wangyao.test / Owner1234)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createEnv } = require('./gas-mock');

const OWNER = { email: 'owner@wangyao.test', password: 'Owner1234' };

function readReq(req) {
  return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
}

async function startStack(o = {}) {
  const env = createEnv({ quiet: o.quiet !== false, ownerEmail: OWNER.email, fetch: o.fetch });
  env.freshExecution();
  env.ctx.setupDatabase();
  const secret = crypto.randomBytes(32).toString('hex');
  env.propStore.set('BRIDGE_SECRET', secret);
  // ตั้งรหัสผ่านเจ้าของ (เทียบเท่าเมนู setOwnerPassword แต่คำนวณด้วย Node ให้เร็ว)
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(OWNER.password, Buffer.from(salt, 'hex'), 600000, 32, 'sha256').toString('hex');
  env.freshExecution();
  const owner = new env.ctx.Db_(env.ctx.loadSnapshot_()).rows('Users').find((u) => u.role === 'ADMIN');
  env.ctx.runTx_(owner.id, 'setOwnerPassword', null, null, (db) => {
    db.update('Users', owner.id, { passwordHash: hash, passwordSalt: salt, passwordRounds: '600000' });
  });
  const gasCalls = [];
  const gas = http.createServer(async (req, res) => {
    const body = await readReq(req);
    const t0 = Date.now();
    const out = env.doPost(body);
    let m = '?'; try { m = JSON.parse(JSON.parse(body).b).m; } catch (e) { }
    gasCalls.push({ m, ms: Date.now() - t0 });
    setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(out); }, o.gasLatency || 0);
  });
  await new Promise((r) => gas.listen(0, '127.0.0.1', r));
  process.env.GAS_URL = 'http://127.0.0.1:' + gas.address().port + '/exec';
  process.env.GAS_BRIDGE_SECRET = secret;
  delete require.cache[require.resolve('../api/gas.js')];
  const handler = require('../api/gas.js');
  const indexFile = path.join(__dirname, '..', 'public', 'index.html');
  const web = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/api' && req.method === 'POST') return handler(req, res);
    if (u === '/api') { res.statusCode = 405; return res.end(); }
    if (u === '/' || u === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache');
      return res.end(fs.readFileSync(indexFile));
    }
    res.statusCode = 404; res.end('not found');
  });
  await new Promise((r) => web.listen(o.port || 0, '127.0.0.1', r));
  const webUrl = 'http://127.0.0.1:' + web.address().port;
  return {
    env, webUrl, secret, owner, gasCalls,
    close: () => Promise.all([new Promise((r) => web.close(r)), new Promise((r) => gas.close(r))])
  };
}

module.exports = { startStack, OWNER };

if (require.main === module) {
  startStack({ port: Number(process.env.PORT || 5173), quiet: false, gasLatency: Number(process.env.GAS_LATENCY || 0) }).then((s) => {
    console.log('พร้อมใช้งาน: ' + s.webUrl + '  (ผู้ใช้ ' + OWNER.email + ' / ' + OWNER.password + ')');
  });
}
