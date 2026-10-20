/**
 * 验证「记录归记录、不因答过而拒答」。
 *
 *   node tests/answer-log.test.mjs
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

const dom = new JSDOM('<!DOCTYPE html><html><body>' +
  '<div class="chat-list"><div class="msg other"><div class="bubble">占位 A: 1；B: 2</div></div></div>' +
  '<div class="chat-input"><div class="editor" contenteditable="true"></div>' +
  '<button class="send">发送</button></div></body></html>',
  { url: 'https://example.test/q', runScripts: 'dangerously', pretendToBeVisual: true });
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
  if (cls.includes('msg')) { const i = Array.from(this.parentElement.children).indexOf(this); return mk(300, 100+i*90, 1000, 80); }
  if (cls.includes('bubble')) return mk(320, 100 + docOrder(this)*90, 380, 60);
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
let mode = 'answer';
window.GM_xmlhttpRequest = (o) => {
  setTimeout(() => {
    if (mode === 'skip') {
      o.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skip: true, answer: '' }) } }] }) });
    } else if (mode === 'fail') {
      o.onerror();
    } else {
      o.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skip: false, answer: 'B', confidence: 0.9, reason: '测试' }) } }] }) });
    }
  }, 0);
};

window.eval(SCRIPT);
if (window.document.readyState === 'loading') await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
await new Promise(r => setTimeout(r, 50));

const api = window.quizbot;
const doc = window.document;
check('脚本加载成功', !!api);
if (!api) process.exit(1);
api.save({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', chatCooldownMs: 400 });
api.chat.detect();

function setQuestion(text) {
  const list = doc.querySelector('.chat-list');
  const row = doc.createElement('div');
  row.className = 'msg other';
  const b = doc.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  row.appendChild(b);
  list.appendChild(row);
}

/* ---- 1. 记录答案 ---- */
console.log('=== 1. 作答后产生记录 ===');
setQuestion('【单选题】(2分)：第一题？ A: 甲；B: 乙');
const r1 = await api.chat.answer(true);
const log1 = api.answerLog();
console.log('  记录条数: ' + log1.length);
log1.forEach(r => console.log('    [' + r.status + '] ' + String(r.text).replace(/\n/g, ' ').slice(0, 40) + ' → ' + r.answer));
check('作答成功', !!(r1 && r1.sent));
check('产生了一条记录', log1.length === 1, '实际 ' + log1.length);
check('记录状态为 answered', log1[0] && log1[0].status === 'answered', log1[0] ? log1[0].status : '-');
check('记录里存了答案', log1[0] && log1[0].answer === 'B', log1[0] ? log1[0].answer : '-');
check('记录里存了完整题面', log1[0] && String(log1[0].text).includes('第一题'), log1[0] ? String(log1[0].text).slice(0, 30) : '-');

/* ---- 2. 同一道题再问一次，仍应作答 ---- */
console.log(String.fromCharCode(10) + '=== 2. 同一道题再次触发仍会作答 ===');
await new Promise(r => setTimeout(r, 3200));   // 越过 3 秒抖动抑制
const before = window.SENT.length;
setQuestion('【单选题】(2分)：第一题？ A: 甲；B: 乙');   // 完全相同的题面
const r2 = await api.chat.answer(false);
const log2 = api.answerLog();
console.log('  发送数: ' + window.SENT.length + '（之前 ' + before + '）');
console.log('  记录条数: ' + log2.length);
check('同一道题没有被拒绝作答', !!(r2 && r2.sent), JSON.stringify(r2));
check('确实又发送了一次', window.SENT.length === before + 1,
  '之前 ' + before + '，现在 ' + window.SENT.length);
check('记录没有无限增长（同题覆盖）', log2.length === 1, '实际 ' + log2.length);

/* ---- 3. skip 也记录 ---- */
console.log(String.fromCharCode(10) + '=== 3. 模型判断无需作答也留记录 ===');
mode = 'skip';
await new Promise(r => setTimeout(r, 3200));
setQuestion('【判断题】(2分)：这是一条闲聊 A: 正确；B: 错误');
const r3 = await api.chat.answer(true);
const log3 = api.answerLog();
const skipRec = log3.filter(r => r.status === 'skipped');
console.log('  skipped 记录数: ' + skipRec.length);
check('skip 时返回 skipped', !!(r3 && r3.skipped));
check('skip 也有记录', skipRec.length === 1, '实际 ' + skipRec.length);

/* ---- 4. 失败也记录 ---- */
console.log(String.fromCharCode(10) + '=== 4. 请求失败也留记录 ===');
mode = 'fail';
await new Promise(r => setTimeout(r, 3200));
setQuestion('【判断题】(2分)：会导致失败的题 A: 正确；B: 错误');
await api.chat.answer(true);
const log4 = api.answerLog();
const failRec = log4.filter(r => r.status === 'failed');
console.log('  failed 记录数: ' + failRec.length);
check('失败也有记录', failRec.length === 1, '实际 ' + failRec.length);

/* ---- 5. 失败后该题仍可重试（不被标记为已答） ---- */
console.log(String.fromCharCode(10) + '=== 5. 失败后可重试 ===');
mode = 'answer';
await new Promise(r => setTimeout(r, 3200));
const beforeRetry = window.SENT.length;
const r5 = await api.chat.answer(false);
console.log('  重试结果: ' + JSON.stringify(r5));
check('失败过的题可以重新作答', !!(r5 && r5.sent), JSON.stringify(r5));

/* ---- 6. 清空记录 ---- */
console.log(String.fromCharCode(10) + '=== 6. 清空记录 ===');
api.clearAnswerLog();
check('清空后记录为 0', api.answerLog().length === 0, '实际 ' + api.answerLog().length);

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');