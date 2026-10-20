/**
 * 验证：已移除「每分钟最多回复」限制，连续作答不会被中断。
 *
 *   node tests/no-rate-limit.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPT = fs.readFileSync(path.join(ROOT, 'userscript', 'quizbot.user.js'), 'utf8');

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('  [PASS] ' + label); }
  else { fail++; console.log('  [FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
};

console.log('=== 1. 源码里不应再有速率限制 ===');
check('没有 chatMaxPerMinute 配置', !SCRIPT.includes('chatMaxPerMinute'));
check('没有「每分钟最多回复」设置项', !SCRIPT.includes('每分钟最多回复'));
check('没有「已达上限」的停止逻辑', !SCRIPT.includes('每分钟回复数已达上限'));
check('没有 handledAt 计数数组', !SCRIPT.includes('handledAt: []'));

/* ---- 连续作答 ---- */
const HTML = '<!DOCTYPE html><html><body>' +
  '<div class="chat-list"><div class="msg other"><div class="bubble">占位 A: 1；B: 2</div></div></div>' +
  '<div class="chat-input"><div class="editor" contenteditable="true"></div>' +
  '<button class="send">发送</button></div></body></html>';

const dom = new JSDOM(HTML, { url: 'https://example.test/q', runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
function docOrder(el) {
  const all = Array.from(window.document.querySelectorAll('.bubble'));
  const i = all.indexOf(el);
  return i < 0 ? 0 : i;
}
window.Element.prototype.getBoundingClientRect = function () {
  const cls = String(this.className || '');
  const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
  if (cls.includes('chat-list')) return mk(300, 60, 1000, 700);
  if (cls.includes('msg')) { const i = Array.from(this.parentElement.children).indexOf(this); return mk(300, 100+i*60, 1000, 50); }
  if (cls.includes('bubble')) return mk(320, 100 + docOrder(this)*60, 380, 40);
  if (cls.includes('chat-input')) return mk(300, 780, 1000, 80);
  if (cls.includes('editor')) return mk(320, 795, 900, 50);
  if (cls.includes('send')) return mk(1230, 795, 60, 40);
  return mk(0, 0, 1000, 100);
};
window.GM_getValue = (k, d) => d;
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};
window.SENT = [];
window.document.querySelector('.send').addEventListener('click', function () {
  window.SENT.push(window.document.querySelector('.editor').textContent);
  window.document.querySelector('.editor').textContent = '';
});
window.GM_xmlhttpRequest = (o) => {
  setTimeout(() => o.onload({ status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skip: false, answer: 'A' }) } }] })
  }), 0);
};
window.eval(SCRIPT);
if (window.document.readyState === 'loading') await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
await new Promise(r => setTimeout(r, 50));

const api = window.quizbot;
api.save({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', chatCooldownMs: 300 });
api.chat.detect();

function addQ(text) {
  const list = window.document.querySelector('.chat-list');
  const row = window.document.createElement('div');
  row.className = 'msg other';
  const b = window.document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  row.appendChild(b);
  list.appendChild(row);
}

console.log('');
console.log('=== 2. 连续 20 题，全部作答（旧版 12 题就会被掐断）===');
for (let i = 1; i <= 20; i++) {
  addQ('【单选题】(2分)：第 ' + i + ' 题？ A: 甲；B: 乙');
  await api.chat.answer(false);
  await new Promise(r => setTimeout(r, 60));
}
console.log('  已发送: ' + window.SENT.length + ' 条');
check('20 题全部作答（未被限速中断）', window.SENT.length === 20,
  '实际 ' + window.SENT.length);

console.log('');
console.log('=== 3. 自动应答模式下也不受限制 ===');
let sentBefore = window.SENT.length;
api.chat.start();
check('自动应答已开启', api.chat._state.watching === true);
for (let i = 21; i <= 30; i++) {
  addQ('【单选题】(2分)：第 ' + i + ' 题？ A: 甲；B: 乙');
  await new Promise(r => setTimeout(r, 700));
}
await new Promise(r => setTimeout(r, 1500));
const added = window.SENT.length - sentBefore;
console.log('  自动应答期间新增发送: ' + added + ' 条');
check('自动应答连续作答 10 题未被中断', added >= 8,
  '实际 ' + added + ' 条');
check('自动应答仍在运行', api.chat._state.watching === true,
  'watching=' + api.chat._state.watching);
api.chat.stop();

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');