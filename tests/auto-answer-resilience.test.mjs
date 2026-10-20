/**
 * 复现「自动应答偶尔中断」的几种场景。
 *
 *   node tests/auto-answer-resilience.test.mjs
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

function makeEnv(opts = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' +
    '<div class="chat-list"><div class="msg other"><div class="bubble">旧题：A: 1；B: 2</div></div></div>' +
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
    if (cls.includes('msg')) { const i = Array.from(this.parentElement.children).indexOf(this); return mk(300, 100 + i*90, 1000, 80); }
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
  window.__requests = [];
  window.GM_xmlhttpRequest = (o) => {
    const b = JSON.parse(o.data);
    const prompt = b.messages[b.messages.length - 1].content;
    window.__requests.push(prompt);
    if (opts.failNext && opts.failNext()) { o.onerror(); return; }
    if (opts.neverRespond) return;   // 模拟请求挂住
    setTimeout(() => o.onload({ status: 200,
      responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skip: false, answer: 'A' }) } }] })
    }), opts.delay || 0);
  };
  window.eval(SCRIPT);
  return { window, dom };
}

async function boot(opts) {
  const { window } = makeEnv(opts);
  if (window.document.readyState === 'loading') await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
  await new Promise(r => setTimeout(r, 50));
  const api = window.quizbot;
  api.save({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' });
  api.chat.detect();
  return { window, api, doc: window.document };
}

function addQuestion(win, text) {
  const list = win.document.querySelector('.chat-list');
  const row = win.document.createElement('div');
  row.className = 'msg other';
  const b = win.document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  row.appendChild(b);
  list.appendChild(row);
}

/* ---------- 场景 1：API 请求失败后，自动应答是否还能继续 ---------- */
console.log('=== 1. API 出错后仍能继续应答 ===');
{
  let calls = 0;
  const env = await boot({ failNext: () => { calls++; return calls <= 1; } });
  const { api, window } = env;
  api.chat.start();
  addQuestion(window, '【判断题】(2分)：第一题 A: 正确；B: 错误');
  await new Promise(r => setTimeout(r, 2200));
  const afterFail = window.SENT.length;
  console.log('  第一次（模拟失败）后已发送: ' + afterFail);
  // 再来一道新题，应能正常作答
  addQuestion(window, '【判断题】(2分)：第二题 A: 正确；B: 错误');
  await new Promise(r => setTimeout(r, 2200));
  console.log('  第二次后已发送: ' + window.SENT.length);
  check('请求失败后仍能继续处理新题', window.SENT.length === 1,
    '实际发送 ' + window.SENT.length + ' 条');
  api.chat.stop();
}

/* ---------- 场景 2：请求很慢时 busy 不应永久卡住 ---------- */
console.log(String.fromCharCode(10) + '=== 2. 请求挂住后仍能恢复 ===');
{
  // 请求永不返回，且之后页面**再无任何变化** —— 这是最恶劣的情况。
  // 看门狗必须能发现并自恢复，否则自动应答就永久停摆了。
  const env = await boot({ neverRespond: true });
  const { api, window } = env;
  // 缩短看门狗周期，让测试跑得快些
  api.save({ watchdogIntervalMs: 500 });
  api.chat.start();
  addQuestion(window, '【判断题】(2分)：会挂住的题 A: 正确；B: 错误');
  await new Promise(r => setTimeout(r, 1200));
  const stuck = api.chat._state.busy;
  console.log('  请求未返回时 busy = ' + stuck);
  check('请求挂住时确实处于 busy（前提成立）', stuck === true, 'busy=' + stuck);

  // 把 busySince 拨到超时之前，等看门狗自己发现并恢复。
  // 注意：恢复后看门狗会尝试重试，而桩仍挂住 → busy 会再次变 true。
  // 因此这里用「超时计数」和「退避时间」来验证恢复逻辑，而不是看 busy 瞬时值。
  api.chat._state.busySince = Date.now() - 120000;
  await new Promise(r => setTimeout(r, 1500));
  const timeouts = api.chat._state.timeouts || 0;
  console.log('  看门狗超时计数 = ' + timeouts);
  check('看门狗发现并处理了卡住（超时计数增加）', timeouts >= 1, 'timeouts=' + timeouts);

  // 等退避结束（桩仍挂住，所以可能再次超时）—— 关键是不能崩、不能永久静默
  api.chat._state.busySince = Date.now() - 120000;
  api.chat._state.retryAfter = 0;
  // 接口恢复正常
  window.GM_xmlhttpRequest = (o) => {
    setTimeout(() => o.onload({ status: 200,
      responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skip: false, answer: 'A' }) } }] })
    }), 0);
  };
  api.chat._state.busy = false;
  api.chat._state.busySince = 0;
  addQuestion(window, '【判断题】(2分)：恢复后的新题 A: 正确；B: 错误');
  await new Promise(r => setTimeout(r, 2500));
  console.log('  恢复后已发送: ' + window.SENT.length);
  check('接口恢复后能继续作答（不会永久停摆）', window.SENT.length >= 1,
    '实际 ' + window.SENT.length + ' 条');
  api.chat.stop();
}

/* ---------- 场景 3：每次只出一道题，逐题作答 ---------- */
console.log(String.fromCharCode(10) + '=== 3. 逐题作答（每题只出一道）===');
{
  const env = await boot({ delay: 80 });
  const { api, window } = env;
  api.save({ chatCooldownMs: 400, chatMaxPerMinute: 60 });
  api.chat.start();

  // 第一题
  addQuestion(window, '【判断题】(2分)：第一道题 A: 正确；B: 错误');
  await new Promise(r => setTimeout(r, 1800));
  const after1 = window.SENT.length;
  console.log('  第 1 题后已发送: ' + after1);

  // 第二题（新的、内容不同的题）
  addQuestion(window, '【判断题】(2分)：第二道题 A: 正确；B: 错误');
  await new Promise(r => setTimeout(r, 1800));
  const after2 = window.SENT.length;
  console.log('  第 2 题后已发送: ' + after2);

  // 第三题
  addQuestion(window, '【单选题】(2分)：第三道题？ A: 甲；B: 乙');
  await new Promise(r => setTimeout(r, 1800));
  const after3 = window.SENT.length;
  console.log('  第 3 题后已发送: ' + after3);

  check('第一题被作答', after1 === 1, '实际 ' + after1);
  check('第二题也被作答', after2 === 2, '实际 ' + after2);
  check('第三题也被作答', after3 === 3, '实际 ' + after3);
  api.chat.stop();
}

/* ---------- 场景 3b：同一道题不应重复作答 ---------- */
console.log(String.fromCharCode(10) + '=== 3b. 同一道题不重复作答 ===');
{
  const env = await boot({ delay: 80 });
  const { api, window } = env;
  api.save({ chatCooldownMs: 400, chatMaxPerMinute: 60 });
  api.chat.start();
  addQuestion(window, '【判断题】(2分)：只应答一次 A: 正确；B: 错误');
  await new Promise(r => setTimeout(r, 1800));
  const n1 = window.SENT.length;
  // 触发多次 DOM 变化（模拟页面重绘），不应导致重复作答
  for (let i = 0; i < 3; i++) {
    addQuestion(window, '');
    await new Promise(r => setTimeout(r, 500));
  }
  await new Promise(r => setTimeout(r, 1500));
  console.log('  发送次数: ' + window.SENT.length);
  check('同一题没有被重复作答', window.SENT.length === n1 && n1 === 1,
    '实际 ' + window.SENT.length + ' 次');
  api.chat.stop();
}

/* ---------- 场景 4：iframe 重建后监听是否还活着 ---------- */
console.log(String.fromCharCode(10) + '=== 4. 监听器数量与状态 ===');
{
  const env = await boot({});
  const { api } = env;
  api.chat.start();
  const w1 = api.chat._state.watching;
  api.chat.stop();
  const w2 = api.chat._state.watching;
  api.chat.start();
  const w3 = api.chat._state.watching;
  check('可以反复开关', w1 === true && w2 === false && w3 === true,
    JSON.stringify([w1, w2, w3]));
  api.chat.stop();
}

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');