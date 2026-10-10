/**
 * 复现并锁死你遇到的 bug：
 *   上次误把「面包屑」选成了消息区域并保存下来，
 *   本次打开时脚本直接用了那个错误选择，于是「识别到 2 条消息：#1[对方] #2[对方] /」。
 *
 *   node tests/stale-selector.test.mjs
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

/* 顶层 = 面包屑空壳 + iframe；iframe 内 = 真正的对话区 */
const TOP = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
  '<div class="coz-breadcrumb" id="crumb"><span>商店</span><span>/</span><span>学习教育</span>' +
  '<span>/</span><span>AI编程工...与高效开发</span></div>' +
  '<iframe id="appFrame"></iframe></body></html>';

const INNER = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
  '<div class="chat-list">' +
    '<div class="msg other"><div class="bubble">郑靖禹同学，刚才的《AI 编程工具与高效开发》测试题：</div></div>' +
    '<div class="msg other"><div class="bubble">【判断题】(2分)：Java 中所有的关键字都不能作为标识符使用 A: 正确；B: 错误</div></div>' +
    '<div class="msg self"><div class="bubble">a</div></div>' +
  '</div>' +
  '<div class="chat-input"><div class="editor" contenteditable="true" data-placeholder="发送消息"></div>' +
  '<button class="send">发送</button></div>' +
  '</body></html>';

const dom = new JSDOM(TOP, { url: 'https://www.coze.cn/store/project/7689061576766685203',
  runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;

/* 布局：面包屑是「扁而宽」的一条 —— 这正是它不该被当成聊天区的原因 */
function installLayout(win) {
  win.Element.prototype.getBoundingClientRect = function () {
    const cls = String(this.className || '');
    const tag = (this.tagName || '').toLowerCase();
    const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
    if (tag === 'iframe') return mk(9, 65, 1682, 862);
    if (cls.includes('coz-breadcrumb')) return mk(16, 23, 400, 20);   // 扁而宽
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
    return mk(0, 0, 1682, 862);
  };
}
installLayout(window);

window.GM_getValue = (k, d) => d;
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};

const frame = window.document.getElementById('appFrame');
const fdoc = frame.contentDocument;
fdoc.open(); fdoc.write(INNER); fdoc.close();
const fwin = frame.contentWindow;
installLayout(fwin);
fwin.GM_getValue = (k, d) => d;
fwin.GM_setValue = () => {};
fwin.GM_registerMenuCommand = () => {};

window.eval(SCRIPT);
if (window.document.readyState === 'loading') await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
await new Promise(r => setTimeout(r, 80));

const api = window.quizbot;
check('脚本加载成功', !!api);
if (!api) process.exit(1);

/* ---- 1. 先验证：面包屑本身不可能是合法消息区 ---- */
console.log(String.fromCharCode(10) + '=== 1. 面包屑不应被当成消息区 ===');
const crumb = window.document.getElementById('crumb');
// 模拟「上次误选了面包屑并保存」
api.save({
  chatListSelector: '#crumb',
  chatInputSelector: ''
});
// 清掉内存里已识别的引用，强制走「读保存的选择器」这条路
api.chat._state.listEl = null;
api.chat._state.inputEl = null;

const ok = api.chat.detect();
const st = api.chat._state;
console.log('识别结果: ' + ok);
console.log('选中的 listEl: ' + (st.listEl ? (st.listEl.id || st.listEl.className || st.listEl.tagName) : 'null'));
check('没有采用已失效的面包屑选择器',
  !(st.listEl && st.listEl.id === 'crumb'),
  st.listEl ? String(st.listEl.id || st.listEl.className) : 'null');
check('改用了真正的聊天区',
  !!(st.listEl && /chat-list|msg/.test(String(st.listEl.className || ''))),
  st.listEl ? String(st.listEl.className) : 'null');

/* ---- 2. 读到的消息必须是题目，不是面包屑 ---- */
console.log(String.fromCharCode(10) + '=== 2. 读到的内容应是题目 ===');
const msgs = api.chat.messages();
console.log('读到 ' + msgs.length + ' 条:');
msgs.forEach((m, i) => console.log('  #' + (i + 1) + ' [' + (m.self ? '我' : '对方') + '] ' + m.text.replace(/\n/g, ' ').slice(0, 55)));
const joined = msgs.map(m => m.text).join(' ');
check('读到了真实题目', joined.includes('Java 中所有的关键字'), joined.slice(0, 70));
check('没有把面包屑当消息', !joined.includes('学习教育') && !joined.includes('商店'), joined.slice(0, 70));
check('识别条数合理（3 条）', msgs.length === 3, '实际 ' + msgs.length);

/* ---- 3. 干净状态下的自动识别 ---- */
console.log(String.fromCharCode(10) + '=== 3. 全新状态下自动识别 ===');
api.save({ chatListSelector: '', chatInputSelector: '' });
api.chat._state.listEl = null;
api.chat._state.inputEl = null;
const ok2 = api.chat.detect();
const st2 = api.chat._state;
check('自动识别成功', ok2 === true);
check('自动选中了聊天区',
  !!(st2.listEl && /chat-list|msg/.test(String(st2.listEl.className || ''))),
  st2.listEl ? String(st2.listEl.className) : 'null');
check('自动选中了 iframe 内的输入框',
  !!(st2.inputEl && st2.inputEl.ownerDocument !== window.document));
const msgs2 = api.chat.messages();
check('干净状态下读到 3 条题目', msgs2.length === 3, '实际 ' + msgs2.length);

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');