/**
 * 自动识别回归测试：在一堆干扰元素（会话历史侧栏、卡片列表）中，
 * 必须挑中真正的聊天区，而不是侧边栏或输入区。
 *
 *   node tests/detect.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPT = fs.readFileSync(path.join(ROOT, 'userscript', 'quizbot.user.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(HERE, 'sample_chat.html'), 'utf8').split('<body>')[1].split('</body>')[0];

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('  [PASS] ' + label); }
  else { fail++; console.log('  [FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
};

/* 复刻真实应用：聊天区 + 会话历史侧栏 + 工作台卡片 */
function buildApp(sideItems, cards) {
  const p = [CHAT, '<div id="sidebar">'];
  for (let i = 0; i < sideItems; i++) {
    p.push('<div class="side-item"><span class="ico"></span><span class="lbl">会话 ' + i + '</span></div>');
  }
  p.push('</div><div id="workbench">');
  for (let i = 0; i < cards; i++) {
    p.push('<div class="card"><div class="hd"><div class="tt">标题 ' + i + '</div></div>' +
           '<div class="bd"><p>正文内容 ' + i + '</p></div></div>');
  }
  p.push('</div>');
  return '<!DOCTYPE html><html><body>' + p.join('') + '</body></html>';
}

/* 模拟真实布局：聊天区是宽而高的大块，侧栏窄而高，卡片是小块 */
function installLayout(window) {
  window.Element.prototype.getBoundingClientRect = function () {
    const t = (this.tagName || '').toLowerCase();
    const cls = String(this.className || '');
    const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
    if (this.id === 'chatList' || cls.includes('chat-list')) return mk(300, 60, 700, 600);
    if (this.id === 'sidebar') return mk(0, 60, 260, 900);
    if (cls.includes('side-item')) return mk(10, 100, 240, 36);
    if (cls.includes('msg-row')) return mk(300, 100, 700, 70);
    if (cls.includes('bubble')) return mk(320, 110, 400, 50);
    if (this.id === 'editor') return mk(320, 690, 600, 40);
    if (this.id === 'sendBtn') return mk(930, 690, 70, 40);
    if (cls.includes('card')) return mk(300, 100, 400, 120);
    if (t === 'input' || t === 'textarea' || t === 'select' || t === 'button') return mk(10, 10, 200, 28);
    return mk(0, 0, 1000, 400);
  };
}

async function detectIn(html) {
  const dom = new JSDOM(html, { url: 'https://example.test/app', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  installLayout(window);
  window.GM_getValue = (k, d) => d;
  window.GM_setValue = () => {};
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = () => {};
  window.eval(SCRIPT);
  if (window.document.readyState === 'loading') {
    await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  await new Promise(r => setTimeout(r, 30));
  const api = window.quizbot;
  const ok = api.chat.detect();
  return { ok, api, msgs: api.chat.messages(), state: api.chat._state, window };
}

console.log('=== 干扰元素很多时仍能挑中聊天区 ===');
const r1 = await detectIn(buildApp(120, 200));
console.log('  识别到 ' + r1.msgs.length + ' 条消息');
r1.msgs.forEach((m, i) => console.log('    #' + (i + 1) + ' [' + (m.self ? '我' : '对方') + '] ' + m.text.replace(/\n/g, ' ').slice(0, 50)));
check('自动识别成功', r1.ok === true);
check('识别出 3 条消息（不是侧栏里的 120 条）', r1.msgs.length === 3, '实际 ' + r1.msgs.length);
check('没有把侧边栏当成消息区',
  !(r1.state.listEl && /sidebar/i.test(String(r1.state.listEl.id || r1.state.listEl.className || ''))),
  r1.state.listEl ? String(r1.state.listEl.id || r1.state.listEl.className) : 'null');
check('没有把输入区当成消息区',
  !(r1.state.listEl && /chat-input/i.test(String(r1.state.listEl.className || ''))),
  r1.state.listEl ? String(r1.state.listEl.className) : 'null');
check('找到输入框', !!r1.state.inputEl);
check('方向判断正确（对方/我/对方）',
  r1.msgs.length === 3 && !r1.msgs[0].self && r1.msgs[1].self && !r1.msgs[2].self,
  r1.msgs.map(m => m.self ? '我' : '对方').join(','));

console.log('\n=== 无干扰元素的干净页面 ===');
const r2 = await detectIn('<!DOCTYPE html><html><body>' + CHAT + '</body></html>');
check('干净页面也能识别', r2.ok === true);
check('干净页面识别出 3 条消息', r2.msgs.length === 3, '实际 ' + r2.msgs.length);

console.log('\n=== 完全无关的页面不应硬猜 ===');
const junk = '<!DOCTYPE html><html><body><div class="a"><p>纯文本</p></div>' +
             '<div class="b"><span>更多文本</span></div></body></html>';
const r3 = await detectIn(junk);
check('没有聊天窗口时不误报', r3.msgs.length === 0, '实际 ' + r3.msgs.length + ' 条');

console.log('\n' + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');
