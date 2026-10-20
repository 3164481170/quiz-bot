/**
 * 验证答题记录的持久化与「答过」标记。
 *
 *   node tests/answer-log-persist.test.mjs
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

/* 模拟 Tampermonkey 的持久化存储（跨「页面重载」保留） */
const PERSIST = Object.create(null);
function makeStorage() {
  return {
    get: (k, d) => (k in PERSIST ? PERSIST[k] : d),
    set: (k, v) => { PERSIST[k] = JSON.parse(JSON.stringify(v)); }
  };
}

const HTML = '<!DOCTYPE html><html><body>' +
  '<div class="chat-list"><div class="msg other"><div class="bubble">占位 A: 1；B: 2</div></div></div>' +
  '<div class="chat-input"><div class="editor" contenteditable="true"></div>' +
  '<button class="send">发送</button></div></body></html>';

function docOrder(win, el) {
  const all = Array.from(win.document.querySelectorAll('.bubble'));
  const i = all.indexOf(el);
  return i < 0 ? 0 : i;
}

async function boot() {
  const dom = new JSDOM(HTML, { url: 'https://example.test/q', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () {
    const cls = String(this.className || '');
    const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
    if (cls.includes('chat-list')) return mk(300, 60, 1000, 700);
    if (cls.includes('msg')) { const i = Array.from(this.parentElement.children).indexOf(this); return mk(300, 100+i*90, 1000, 80); }
    if (cls.includes('bubble')) return mk(320, 100 + docOrder(window, this)*90, 380, 60);
    if (cls.includes('chat-input')) return mk(300, 780, 1000, 80);
    if (cls.includes('editor')) return mk(320, 795, 900, 50);
    if (cls.includes('send')) return mk(1230, 795, 60, 40);
    return mk(0, 0, 1000, 100);
  };
  const store = makeStorage();
  window.GM_getValue = store.get;
  window.GM_setValue = store.set;
  window.GM_registerMenuCommand = () => {};
  window.SENT = [];
  window.document.querySelector('.send').addEventListener('click', function () {
    window.SENT.push(window.document.querySelector('.editor').textContent);
    window.document.querySelector('.editor').textContent = '';
  });
  window.GM_xmlhttpRequest = (o) => {
    setTimeout(() => o.onload({ status: 200,
      responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skip: false, answer: 'B', confidence: 0.9 }) } }] })
    }), 0);
  };
  window.eval(SCRIPT);
  if (window.document.readyState === 'loading') {
    await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  await new Promise(r => setTimeout(r, 50));
  const api = window.quizbot;
  api.save({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' });
  api.chat.detect();
  return { window, api, doc: window.document };
}

function setQuestion(env, text) {
  const list = env.doc.querySelector('.chat-list');
  const row = env.doc.createElement('div');
  row.className = 'msg other';
  const b = env.doc.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  row.appendChild(b);
  list.appendChild(row);
}

/* ---- 第一次会话：作答并产生记录 ---- */
console.log('=== 1. 第一次会话：作答并记录 ===');
const Q1 = '【单选题】(2分)：下列哪个不是基本类型？ A: int；B: String';
let env1 = await boot();
setQuestion(env1, Q1);
await env1.api.chat.answer(true);
const log1 = env1.api.answerLog();
console.log('  记录数: ' + log1.length);
check('产生了记录', log1.length === 1, '实际 ' + log1.length);
check('记录已写入持久化存储', !!PERSIST['answerLog'] && PERSIST['answerLog'].length === 1,
  'PERSIST=' + JSON.stringify(PERSIST['answerLog'] ? PERSIST['answerLog'].length : 'null'));

/* ---- 第二次会话（模拟刷新/重启）：记录应恢复 ---- */
console.log(String.fromCharCode(10) + '=== 2. 重新打开后记录仍在 ===');
let env2 = await boot();
const log2 = env2.api.answerLog();
console.log('  恢复的记录数: ' + log2.length);
log2.forEach(r => console.log('    [' + r.status + '] ' + String(r.text).slice(0, 40) + ' → ' + r.answer));
check('重新打开后记录被恢复', log2.length === 1, '实际 ' + log2.length);
check('恢复的记录含题面', log2[0] && String(log2[0].text).includes('基本类型'),
  log2[0] ? String(log2[0].text).slice(0, 40) : '-');
check('恢复的记录含答案', log2[0] && log2[0].answer === 'B', log2[0] ? log2[0].answer : '-');

/* ---- 第三次会话：同一道题再次出现，应被识别为「以前出现过」---- */
console.log(String.fromCharCode(10) + '=== 3. 同一道题再次出现会被识别 ===');
let env3 = await boot();
setQuestion(env3, Q1);
const detected = env3.api.chat.previewAndDetect ? null : null;
// 直接看预览返回的消息与内部判定
env3.api.chat.preview();
const logLines = env3.window.__qbLog || [];
// 通过再次作答，检查日志里是否出现「以前出现过」提示
await env3.api.chat.answer(true);
const log3 = env3.api.answerLog();
const rec = log3.find(r => String(r.text).includes('基本类型'));
console.log('  该题出现次数: ' + (rec ? rec.count : '-'));
check('记录了出现次数', !!rec && rec.count >= 2, rec ? 'count=' + rec.count : '-');
check('仍然照常作答（不因答过而跳过）', env3.window.SENT.length === 1,
  '发送 ' + env3.window.SENT.length + ' 条');

/* ---- 4. 存储里保留了 count ---- */
console.log(String.fromCharCode(10) + '=== 4. 次数被持久化 ===');
const saved = PERSIST['answerLog'].find(r => String(r.text).includes('基本类型'));
check('持久化记录里含出现次数', !!saved && saved.count >= 2, saved ? 'count=' + saved.count : '-');

/* ---- 5. 清空会同步清除存储 ---- */
console.log(String.fromCharCode(10) + '=== 5. 清空同步清除持久化 ===');
env3.api.clearAnswerLog();
check('内存已清空', env3.api.answerLog().length === 0);
check('存储已清空', !PERSIST['answerLog'] || PERSIST['answerLog'].length === 0,
  JSON.stringify(PERSIST['answerLog'] || []).slice(0, 60));

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');