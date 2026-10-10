/**
 * 大页面取文回归：聊天区排在页面很靠后的位置，前面有上万个噪音元素。
 * 旧实现会因为「扫描 8000 个节点就退出」而永远读不到聊天区 —— 这正是
 * 「框选区域有文字却提示 0 字」的根因。
 *
 *   node tests/region-large.test.mjs
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

/* 聊天区在文档后部，前面堆满噪音 */
function buildHtml(noise) {
  let body = '<div id="shell">';
  for (let i = 0; i < noise; i++) {
    body += '<div class="noise"><span class="nt">项 ' + i + '</span></div>';
  }
  body += '<div id="chatArea">' +
          '<div class="msg">第一题：HTTP 默认端口是多少？A: 21  B: 80</div>' +
          '<div class="msg">第二题：TCP 是面向连接的协议吗？A: 正确  B: 错误</div>' +
          '</div>';
  body += '<div id="editor" contenteditable="true"></div><button id="go">发送</button></div>';
  return '<!DOCTYPE html><html><body>' + body + '</body></html>';
}

const dom = new JSDOM(buildHtml(12000), { url: 'https://example.test/big',
  runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;

/* 模拟布局：聊天区在视口里，噪音元素全在很下方 */
window.Element.prototype.getBoundingClientRect = function () {
  const cls = String(this.className || '');
  const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
  if (this.id === 'shell') return mk(0, 0, 1400, 200000);
  if (cls.includes('noise')) return mk(0, 4000, 200, 28);
  if (cls.includes('nt')) return mk(4, 4000, 180, 20);
  if (this.id === 'chatArea') return mk(300, 100, 700, 200);
  if (cls.includes('msg')) {
    const i = Array.from(this.parentElement.children).indexOf(this);
    return mk(320, 120 + i * 60, 500, 50);
  }
  if (this.id === 'editor') return mk(320, 500, 600, 40);
  if (this.id === 'go') return mk(930, 500, 70, 40);
  return mk(0, 0, 1000, 100);
};
window.GM_getValue = (k, d) => d;
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};
window.eval(SCRIPT);
if (window.document.readyState === 'loading') {
  await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
}
await new Promise(r => setTimeout(r, 40));

const api = window.quizbot;
const total = window.document.querySelectorAll('*').length;
console.log('DOM 元素总数: ' + total);
console.log('候选取文节点数: ' + window.document.querySelectorAll('div,p,span,li,td,th,pre,code,article,section,label').length);

console.log(String.fromCharCode(10) + '=== 框住聊天区（视口 top=100, height=200）===');
api.chat._region.rect = { left: 300, top: 100, width: 700, height: 200, right: 1000, bottom: 300 };
const t0 = Date.now();
const text = api.chat.regionText();
const ms = Date.now() - t0;
console.log('耗时 ' + ms + 'ms，读到 ' + text.length + ' 字');
console.log('内容: ' + JSON.stringify(text.slice(0, 160)));

check('大页面里也能读到文字（旧版会返回 0）', text.length > 0, text.length + ' 字');
check('读到了第一题', text.includes('默认端口'), text.slice(0, 60));
check('读到了第二题', text.includes('面向连接'), text.slice(0, 100));
check('没有混入噪音内容', !text.includes('项 1') && !text.includes('项 5'), text.slice(0, 120));
check('没有把「发送」算进来', !text.includes('发送'), text.slice(0, 120));
check('耗时在合理范围（<1500ms）', ms < 1500, ms + 'ms');

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');