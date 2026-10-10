/**
 * 复现你的两个问题：
 *   1) 「识别到 1 条消息」，而且是**已经答过的旧题** → 新题根本没被看到
 *   2) 开了自动应答却毫无反应（监听只挂在消息列表节点上，新题渲染在别处）
 *
 *   node tests/auto-answer.test.mjs
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

/* 真实场景：已答过的单选题 + 批改反馈 + 新来的判断题 */
const OLD_Q = '考查知识点：【Java 基础 - 变量、标识符、基本数据类型、运算符】' + String.fromCharCode(10) +
  '【单选题】(2分)：计算表达式 5 + 3 * 2 的运算结果，正确的是哪一项？' + String.fromCharCode(10) +
  'A: 16；B: 11；C: 10；D: 8';
const FEEDBACK = '你的回答是：B正确答案：B你的答题结果是：回答正确，获得满分本题得分：2错因分析：无' +
  '反馈：你已经正确掌握 Java 运算符优先级的知识点，继续保持。';
const NEW_Q = '考查知识点：【Java 基础 - 变量、标识符、基本数据类型、运算符】' + String.fromCharCode(10) +
  '【判断题】(2分)：Java 表达式 3 + 2 * 2 的运算结果是 10' + String.fromCharCode(10) +
  'A: 正确；B: 错误';

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

let body = '<div class="chat-list">';
body += '<div class="msg other"><div class="bubble">' + esc(OLD_Q) + '</div></div>';
body += '<div class="msg other"><div class="bubble">' + esc(FEEDBACK) + '</div></div>';
body += '</div>';
body += '<div class="chat-input"><div class="editor" contenteditable="true" data-placeholder="发送消息"></div>' +
        '<button class="send">发送</button></div>';

const dom = new JSDOM('<!DOCTYPE html><html><body>' + body + '</body></html>',
  { url: 'https://example.test/quiz', runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;

/* 关键：气泡的纵向位置必须按「它在文档里出现的先后」递增，
   这样后追加的消息才真的排在下面（真实聊天流就是这样）。 */
function docOrder(el) {
  const all = Array.from(window.document.querySelectorAll('.bubble'));
  const i = all.indexOf(el);
  return i < 0 ? 0 : i;
}
window.Element.prototype.getBoundingClientRect = function () {
  const cls = String(this.className || '');
  const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
  if (cls.includes('chat-list')) return mk(300, 60, 1000, 700);
  if (cls.includes('msg')) {
    const i = Array.from(this.parentElement.children).indexOf(this);
    return mk(300, 100 + i * 90, 1000, 80);
  }
  if (cls.includes('bubble')) {
    const self = !!this.closest('.msg.self');
    return mk(self ? 900 : 320, 100 + docOrder(this) * 90, 380, 60);
  }
  if (cls.includes('chat-input')) return mk(300, 780, 1000, 80);
  if (cls.includes('editor')) return mk(320, 795, 900, 50);
  if (cls.includes('send')) return mk(1230, 795, 60, 40);
  return mk(0, 0, 1000, 100);
};

window.GM_getValue = (k, d) => d;
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};

let sentPrompts = [];
let answers = [];
window.GM_xmlhttpRequest = (opts) => {
  const b = JSON.parse(opts.data);
  const prompt = b.messages[b.messages.length - 1].content;
  sentPrompts.push(prompt);
  const ans = prompt.includes('3 + 2 * 2') ? 'A' : 'B';
  answers.push(ans);
  setTimeout(() => opts.onload({ status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skip: false, answer: ans }) } }] })
  }), 0);
};

let SENT = [];
window.document.querySelector('.send').addEventListener('click', function () {
  SENT.push(window.document.querySelector('.editor').textContent);
  window.document.querySelector('.editor').textContent = '';
});

window.eval(SCRIPT);
if (window.document.readyState === 'loading') await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
await new Promise(r => setTimeout(r, 60));

const api = window.quizbot;
const doc = window.document;
check('脚本加载成功', !!api);
if (!api) process.exit(1);
api.save({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' });
api.chat.detect();

/* ---- 1. 内容驱动：此刻页面上唯一的题目就是那道旧单选题 ---- */
console.log(String.fromCharCode(10) + '=== 1. 内容驱动选题 ===');
api.chat.preview();

/* ---- 2. 智能体发来新判断题（追加到列表）---- */
console.log(String.fromCharCode(10) + '=== 2. 出现新题后作答 ===');
const list0 = doc.querySelector('.chat-list');
const row0 = doc.createElement('div');
row0.className = 'msg other';
const bub0 = doc.createElement('div');
bub0.className = 'bubble';
bub0.textContent = NEW_Q;
row0.appendChild(bub0);
list0.appendChild(row0);

const r1 = await api.chat.answer(true);
console.log('发给模型的题面: ' + (sentPrompts[0] || '').replace(/\n/g, ' ').slice(0, 100));
check('作答成功', !!(r1 && r1.sent), JSON.stringify(r1));
check('答的是最新那道判断题（3 + 2 * 2）',
  (sentPrompts[0] || '').includes('3 + 2 * 2'), (sentPrompts[0] || '').slice(0, 80));
check('没有误答旧的单选题（5 + 3 * 2）',
  !(sentPrompts[0] || '').includes('5 + 3 * 2'), (sentPrompts[0] || '').slice(0, 80));
check('没有误答批改反馈',
  !(sentPrompts[0] || '').includes('你的回答是'), (sentPrompts[0] || '').slice(0, 80));
check('答案已发送', SENT.length === 1, JSON.stringify(SENT));

/* ---- 3. 同一条不重复作答 ---- */
console.log(String.fromCharCode(10) + '=== 3. 去重 ===');
const beforeDedup = SENT.length;
const r2 = await api.chat.answer(false);
check('同一条不重复作答', r2 === null, JSON.stringify(r2));
check('没有产生新的发送', SENT.length === beforeDedup,
  '之前 ' + beforeDedup + ' 条，现在 ' + SENT.length + ' 条');

/* ---- 4. 自动应答：新题出现后应自动作答 ---- */
console.log(String.fromCharCode(10) + '=== 4. 自动应答 ===');
api.chat.start();
check('自动应答已开启', api.chat._state.watching === true);

/* 模拟智能体发来一道全新的题 */
const NEWER_Q = '【判断题】(2分)：Java 中 String 是不可变类' + String.fromCharCode(10) + 'A: 正确；B: 错误';
const list = doc.querySelector('.chat-list');
const row = doc.createElement('div');
row.className = 'msg other';
const bub = doc.createElement('div');
bub.className = 'bubble';
bub.textContent = NEWER_Q;
row.appendChild(bub);
list.appendChild(row);

const before4 = SENT.length;
await new Promise(r => setTimeout(r, 2600));   // 等冷却 + 请求
console.log('累计发送: ' + JSON.stringify(SENT));
check('新题出现后自动作答了', SENT.length === before4 + 1,
  '之前 ' + before4 + ' 条，现在 ' + SENT.length + ' 条');
check('自动答的是最新那道题',
  (sentPrompts[sentPrompts.length - 1] || '').includes('不可变类'),
  (sentPrompts[sentPrompts.length - 1] || '').slice(0, 80));
api.chat.stop();

/* ---- 5. 新题渲染在消息列表之外时，也应被监听到 ---- */
console.log(String.fromCharCode(10) + '=== 5. 新题渲染在别的容器 ===');
api.chat.start();
const outside = doc.createElement('div');
outside.className = 'other-container';
const bub2 = doc.createElement('div');
bub2.className = 'bubble';
bub2.textContent = '【单选题】(2分)：Java 中用于定义常量的关键字是？' + String.fromCharCode(10) + 'A: final；B: const；C: static；D: var';
outside.appendChild(bub2);
doc.body.appendChild(outside);   // 挂在 chat-list 之外
const before5 = SENT.length;
await new Promise(r => setTimeout(r, 2600));
console.log('累计发送: ' + JSON.stringify(SENT));
check('列表外的新题也被监听到并作答', SENT.length === before5 + 1,
  '之前 ' + before5 + ' 条，现在 ' + SENT.length + ' 条');
api.chat.stop();

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');