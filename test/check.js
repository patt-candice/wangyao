'use strict';
/** ตรวจไวยากรณ์ทุกไฟล์ JS (รวม Code.gs และสคริปต์ใน index.html) + ตรวจ appsscript.json  —  node test/check.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
let bad = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) bad++; };
const compile = (code, name) => { try { new vm.Script(code, { filename: name }); return true; } catch (e) { console.log('    ' + e.message); return false; } };

ok(compile(fs.readFileSync(path.join(root, 'apps-script/Code.gs'), 'utf8'), 'Code.gs'), 'apps-script/Code.gs');
ok(compile(fs.readFileSync(path.join(root, 'api/gas.js'), 'utf8'), 'gas.js'), 'api/gas.js');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(scripts.length >= 2 && scripts.every((s, i) => compile(s, 'index.html#' + i)), 'public/index.html inline scripts (' + scripts.length + ')');
ok(/integrity="sha384-[A-Za-z0-9+/=]+"/.test(html), 'SweetAlert2 มี SRI');

const man = JSON.parse(fs.readFileSync(path.join(root, 'apps-script/appsscript.json'), 'utf8'));
ok(man.timeZone === 'Asia/Bangkok', 'timeZone Asia/Bangkok');
ok(man.runtimeVersion === 'V8', 'runtime V8');
ok(man.webapp && man.webapp.executeAs === 'USER_DEPLOYING' && man.webapp.access === 'ANYONE_ANONYMOUS', 'webapp: Execute as Me / Anyone');
const need = { spreadsheets: 'SpreadsheetApp/Sheets API', drive: 'DriveApp', 'script.external_request': 'UrlFetchApp', 'script.send_mail': 'MailApp', 'script.scriptapp': 'triggers', 'script.container.ui': 'เมนู/ui', 'userinfo.email': 'Session email' };
Object.keys(need).forEach((s) => ok(man.oauthScopes.includes('https://www.googleapis.com/auth/' + s), 'scope ' + s + ' (' + need[s] + ')'));
const vj = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
ok(vj.functions['api/gas.js'].maxDuration === 60, 'vercel.json maxDuration 60');
ok(vj.rewrites.some((r) => r.source === '/api' && r.destination === '/api/gas'), 'vercel.json rewrite /api');
console.log(bad ? '\nมีปัญหา ' + bad + ' จุด' : '\nผ่านทั้งหมด');
process.exit(bad ? 1 : 0);
