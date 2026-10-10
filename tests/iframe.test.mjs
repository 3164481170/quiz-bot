/**
 * 复现你的真实场景：整个答题界面在**同源 iframe** 里（扣子就是这个结构）。
 * 顶层只有空壳（面包屑），真正的对话区在 iframe 内。
 *
 *   node tests/iframe.test.mjs
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

/* 顶层：面包屑空壳 + 一个 iframe（内部稍后注入） */
const TOP = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
  'body{margin:0}#shell{height:100vh;display:flex;flex-direction:column}' +
  '.topbar{height:65px;border-bottom:1px solid #eee}' +
  'iframe{flex:1;border:0;width:100%}</style></head><body>' +
  '<div id="shell"><div class="topbar">商店 / 学习教育 / AI编程工...与高效开发</div>' +
  '<iframe id="appFrame"></iframe></div></body></html>';

/* iframe 内部：真正的对话界面 */
const INNER = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
  'body{margin:0;height:100vh;display:flex;flex-direction:column}' +
  '.chat-list{flex:1;overflow-y:auto;padding:20px}' +
  '.msg{margin-bottom:14px;display:flex}' +
  '.msg.self{justify-content:flex-end}' +
  '.bubble{max-width:70%;padding:12px 16px;border-radius:10px;background:#f2f4f8}' +
  '.msg.self .bubble{background:#2f6fed}' +
  '.chat-input{display:flex;gap:10px;padding:14px 20px;border-top:1px solid #ddd}' +
  '.editor{flex:1;padding:10px;border:1px solid #ccc;border-radius:18px;outline:none;min-height:22px}' +
  '.send{padding:10px 20px;border:none;background:#2f6fed;color:#fff;border-radius:18px}' +
  '</style></head><body>' +
  '<div class="chat-list">' +
    '<div class="msg other"><div class="bubble">郑靖禹同学，刚才的《AI 编程工具与高效开发》测试题：</div></div>' +
    '<div class="msg other"><div class="bubble">考查知识点：【Java 基础 - 变量、标识符、基本数据类型、运算符】' +
      String.fromCharCode(10) + '【判断题】(2分)：Java 中所有的关键字都不能作为标识符使用 A: 正确；B: 错误</div></div>' +
    '<div class="msg self"><div class="bubble">a</div></div>' +
    '<div class="msg other"><div class="bubble">【判断题】(2分)：Java 中基本数据类型 int 占用的内存字节数是 4 个字节。 A: 正确；B: 错误</div></div>' +
  '</div>' +
  '<div class="chat-input"><div class="editor" contenteditable="true" data-placeholder="发送消息"></div>' +
  '<button class="send">发送</button></div>' +
  '<script>window.SENT=[];document.querySelector(".send").addEventListener("click",function(){' +
    'var e=document.querySelector(".editor");window.SENT.push(e.textContent);e.textContent="";});</script>' +
  '</body></html>';

const dom = new JSDOM(TOP, { url: 'https://www.coze.cn/store/project/7689061576766685203',
  runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;

/* 布局桩：iframe 从 top=65 起，占满其余区域；内部按 CSS 语义布局 */
function installLayout(win, inFrame) {
  win.Element.prototype.getBoundingClientRect = function () {
    const cls = String(this.className || '');
    const tag = (this.tagName || '').toLowerCase();
    const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
    if (tag === 'iframe') return mk(9, 65, 1682, 862);
    if (cls.includes('topbar')) return mk(0, 0, 1699, 65);
    if (cls.includes('chat-list')) return mk(0, 0, 1682, 700);
    if (cls.includes('msg')) {
      const i = Array.from(this.parentElement.children).indexOf(this);
      return mk(20, 40 + i * 110, 1640, 100);
    }
    if (cls.includes('bubble')) {
      const self = !!this.closest('.msg.self');
      return mk(self ? 1100 : 40, 50, 540, 80);
    }
    if (cls.includes('chat-input')) return mk(0, 700, 1682, 90);
    if (cls.includes('editor')) return mk(20, 720, 1500, 50);
    if (cls.includes('send')) return mk(1540, 720, 100, 50);
    if (tag === 'input' || tag === 'textarea') return mk(10, 10, 200, 28);
    return mk(0, 0, 1682, 862);
  };
}
installLayout(window, false);

window.GM_getValue = (k, d) => d;
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};
window.GM_xmlhttpRequest = () => {};

/* 先给 iframe 注入内容（jsdom 不解析 srcdoc），再跑脚本 */
const frame = window.document.getElementById('appFrame');
const fdoc = frame.contentDocument;
fdoc.open(); fdoc.write(INNER); fdoc.close();
const fwin = frame.contentWindow;
installLayout(fwin, true);
fwin.GM_getValue = (k, d) => d;
fwin.GM_setValue = () => {};
fwin.GM_registerMenuCommand = () => {};
// 脚本优先用 GM_xmlhttpRequest 发请求；iframe 里也要装桩，否则请求发不出去
function stubXhr(win) {
  win.GM_xmlhttpRequest = (opts) => {
    setTimeout(() => opts.onload({
      status: 200,
      responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skip: false, answer: 'A' }) } }] })
    }), 0);
  };
}
stubXhr(fwin);
stubXhr(window);

window.eval(SCRIPT);
if (window.document.readyState === 'loading') await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
await new Promise(r => setTimeout(r, 80));

const api = window.quizbot;
console.log('顶层元素数: ' + window.document.querySelectorAll('*').length);
console.log('iframe 内元素数: ' + fdoc.querySelectorAll('*').length);
check('顶层脚本加载成功', !!api);
if (!api) process.exit(1);

/* ---- 1. 跨 iframe 找输入框 ---- */
console.log(String.fromCharCode(10) + '=== 1. 跨 iframe 找输入框 ===');
const found = api.chat.detect();
const st = api.chat._state;
console.log('识别结果: ' + found);
console.log('inputEl: ' + (st.inputEl ? (st.inputEl.className || st.inputEl.tagName) : 'null') +
  ' | 在 iframe 内: ' + !!(st.inputEl && st.inputEl.ownerDocument !== window.document));
check('找到了 iframe 内的输入框', !!st.inputEl, '未找到');
check('输入框确实在 iframe 里', !!(st.inputEl && st.inputEl.ownerDocument !== window.document));

/* ---- 2. 跨 iframe 读消息 ---- */
console.log(String.fromCharCode(10) + '=== 2. 跨 iframe 读消息 ===');
const msgs = api.chat.messages();
console.log('读到 ' + msgs.length + ' 条:');
msgs.forEach((m, i) => console.log('  #' + (i + 1) + ' [' + (m.self ? '我' : '对方') + '] ' + m.text.replace(/\n/g, ' ').slice(0, 55)));
check('读到了 iframe 内的消息', msgs.length >= 3, '实际 ' + msgs.length);
const joined = msgs.map(m => m.text).join(' ');
check('读到了真实题目文字', joined.includes('Java 中所有的关键字'), joined.slice(0, 70));

/* ---- 3. 跨 iframe 写入并发送 ---- */
console.log(String.fromCharCode(10) + '=== 3. 跨 iframe 作答并发送 ===');
fwin.SENT = [];
api.save({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' });
const res = await api.chat.answer(true);
check('作答成功', !!(res && res.sent), JSON.stringify(res));
const sentArr = fwin.SENT || [];
console.log('iframe 内 SENT: ' + JSON.stringify(sentArr));
check('答案写入 iframe 内输入框并发送', sentArr.length === 1, JSON.stringify(sentArr));
check('发送内容正确', sentArr[0] === 'A', JSON.stringify(sentArr[0]));

/* ---- 4. 面板只在顶层 ---- */
console.log(String.fromCharCode(10) + '=== 4. 面板只出现在顶层 ===');
check('顶层有面板', !!window.document.querySelector('[data-quizbot-ui]'));
check('iframe 内没有重复面板', !fdoc.querySelector('[data-quizbot-ui]'));

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');