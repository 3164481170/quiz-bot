/**
 * 复现你的场景：消息流是「题目 → 我作答 → 批改反馈 → 题目 → …」
 * 旧逻辑只取「最后一条对方消息」，于是选到批改反馈，模型正确地判断「无需作答」并跳过。
 *
 *   node tests/pick-question.test.mjs
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

/* 真实消息流（取自你的截图） */
const MSGS = [
  { self: false, text: '郑靖禹同学，刚才的《AI 编程工具与高效开发》测试题：' },
  { self: false, text: '考查知识点：【Java 基础 - 变量、标识符、基本数据类型、运算符】' + String.fromCharCode(10) +
      '【判断题】(2分)：Java 中所有的关键字都不能作为标识符使用 A: 正确；B: 错误' },
  { self: true,  text: 'a' },
  { self: false, text: '你的回答是：a正确答案：A你的答题结果是：回答正确本题得分：2错因分析：无反馈：回答正确，你已经掌握了 Java 标识符命名规则中关键字不能作为标识符的知识点，继续保持。本题考查的知识点：Java 基础 - 变量、标识符、基本数据类型、运算符' },
  { self: false, text: '考查知识点：【Java 基础 - 变量、标识符、基本数据类型、运算符】' + String.fromCharCode(10) +
      '【单选题】(2分)：执行代码 int a = 7; a = a * 2; 后变量 a 的值是？' + String.fromCharCode(10) +
      'A: 7；B: 9；C: 14；D: 2' },
];

/* 构建一个只有消息列表的页面 */
let body = '<div class="chat-list">';
MSGS.forEach((m, i) => {
  const cls = m.self ? 'msg self' : 'msg other';
  body += '<div class="' + cls + '"><div class="bubble">' +
          m.text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div></div>';
});
body += '</div><div class="chat-input"><div class="editor" contenteditable="true" data-placeholder="发送消息"></div>' +
        '<button class="send">发送</button></div>';

const dom = new JSDOM('<!DOCTYPE html><html><body>' + body + '</body></html>',
  { url: 'https://example.test/quiz', runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
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
    return mk(self ? 900 : 320, 110, 380, 60);
  }
  if (cls.includes('chat-input')) return mk(300, 780, 1000, 80);
  if (cls.includes('editor')) return mk(320, 795, 900, 50);
  if (cls.includes('send')) return mk(1230, 795, 60, 40);
  return mk(0, 0, 1000, 100);
};
window.GM_getValue = (k, d) => d;
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};
window.eval(SCRIPT);
if (window.document.readyState === 'loading') await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
await new Promise(r => setTimeout(r, 60));

const api = window.quizbot;
check('脚本加载成功', !!api);
if (!api) process.exit(1);

api.save({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' });

/* ---- 1. 判别函数：反馈 vs 题目 ---- */
console.log(String.fromCharCode(10) + '=== 1. 内容判别 ===');
api.chat.detect();                       // 先识别，messages() 才有内容
const msgs = api.chat.messages();
msgs.forEach((m, i) => {
  console.log('  #' + (i + 1) + ' [' + (m.self ? '我' : '对方') + '] ' + m.text.replace(/\n/g, ' ').slice(0, 60));
});
check('读到 5 条消息', msgs.length === 5, '实际 ' + msgs.length);

/* ---- 2. 应该挑中最后那道单选题，而不是批改反馈 ---- */
console.log(String.fromCharCode(10) + '=== 2. 预览时挑中的待答题 ===');
const picked = api.chat.preview();
const txts = picked.map(m => m.text);
const lastQ = txts[txts.length - 1];
check('挑中的是最后一道题（单选题）',
  lastQ.includes('int a = 7'), lastQ.slice(0, 60));
check('挑中的不是批改反馈',
  !lastQ.includes('你的回答是') && !lastQ.includes('本题得分'), lastQ.slice(0, 60));

/* ---- 3. 真正作答时，发给模型的题面必须是那道题 ---- */
console.log(String.fromCharCode(10) + '=== 3. 作答时发给模型的题面 ===');
let sentPrompt = '';
window.GM_xmlhttpRequest = (opts) => {
  const b = JSON.parse(opts.data);
  sentPrompt = b.messages[b.messages.length - 1].content;
  setTimeout(() => opts.onload({ status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skip: false, answer: 'C' }) } }] })
  }), 0);
};
let sent = [];
window.document.querySelector('.send').addEventListener('click', function () {
  sent.push(window.document.querySelector('.editor').textContent);
  window.document.querySelector('.editor').textContent = '';
});

const res = await api.chat.answer(true);
check('作答成功', !!(res && res.sent), JSON.stringify(res));
console.log('发给模型的题面: ' + sentPrompt.replace(/\n/g, ' ').slice(0, 100));
check('发给模型的是题目本身',
  sentPrompt.includes('int a = 7'), sentPrompt.slice(0, 80));
check('发给模型的不是批改反馈',
  !sentPrompt.includes('你的回答是') && !sentPrompt.includes('本题得分'), sentPrompt.slice(0, 80));
check('答案已发送', sent.length === 1 && sent[0] === 'C', JSON.stringify(sent));

/* ---- 4. 只有反馈时，应明确报告无题可答 ---- */
console.log(String.fromCharCode(10) + '=== 4. 只有批改反馈时 ===');
const dom2 = new JSDOM('<!DOCTYPE html><html><body>' +
  '<div class="chat-list">' +
  '<div class="msg other"><div class="bubble">你的回答是：a正确答案：A你的答题结果是：回答正确本题得分：2错因分析：无反馈：回答正确，继续保持。</div></div>' +
  '</div><div class="chat-input"><div class="editor" contenteditable="true"></div><button class="send">发送</button></div>' +
  '</body></html>', { url: 'https://example.test/q2', runScripts: 'dangerously', pretendToBeVisual: true });
const w2 = dom2.window;
w2.Element.prototype.getBoundingClientRect = window.Element.prototype.getBoundingClientRect;
w2.GM_getValue = (k, d) => d;
w2.GM_setValue = () => {};
w2.GM_registerMenuCommand = () => {};
w2.eval(SCRIPT);
if (w2.document.readyState === 'loading') await new Promise(r => w2.addEventListener('DOMContentLoaded', r, { once: true }));
await new Promise(r => setTimeout(r, 60));
const api2 = w2.quizbot;
let called = false;
w2.GM_xmlhttpRequest = () => { called = true; };
api2.save({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' });
const res2 = await api2.chat.answer(true);
check('只有反馈时不作答', res2 === null, JSON.stringify(res2));
check('没有发起 API 请求', called === false, '却发起了请求');

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');