/**
 * 对话模式测试：模拟「和 AI 智能体对话的答题窗口」。
 *
 *   node tests/chat.test.mjs
 *
 * 注意：jsdom 没有布局引擎，getBoundingClientRect 一律返回 0，
 * 而「谁是对方/谁是我」需要真实几何信息。所以这里按 fixture 的 CSS 语义
 * 模拟一套布局（.self 靠右、.other 靠左），仅用于测试。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPT = path.join(ROOT, 'userscript', 'quizbot.user.js');
const FIXTURE = fs.readFileSync(path.join(HERE, 'sample_chat.html'), 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  [PASS] ' + label); }
  else { fail++; console.log('  [FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const dom = new JSDOM(FIXTURE, {
  url: 'https://example.test/chat',
  runScripts: 'dangerously',
  pretendToBeVisual: true
});
const { window } = dom;

/* 模拟布局：容器 900 宽，气泡最宽 70%，self 靠右、other 靠左 */
const APP_W = 900;
window.Element.prototype.getBoundingClientRect = function () {
  const cls = String(this.className || '');
  const tag = (this.tagName || '').toLowerCase();
  const r = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });

  if (this.id === 'editor') return r(20, 700, 800, 40);
  if (this.id === 'sendBtn') return r(840, 700, 60, 40);
  if (cls.includes('chat-list')) return r(0, 0, APP_W, 660);
  if (cls.includes('msg-row')) return r(0, 0, APP_W, 60);
  if (cls.includes('bubble')) {
    const w = 300, h = 50;
    const isSelf = !!this.closest('.msg-row.self');
    const x = isSelf ? (20 + 800 - w) : 20;   // self 靠右，other 靠左
    return r(x, 0, w, h);
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return r(10, 10, 200, 28);
  return r(10, 10, 400, 20);
};

/* 桩：API */
window.GM_getValue = (k, d) => (k === 'apiKey' ? 'k' : (k === 'baseUrl' ? 'https://api.test/v1' : d));
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};
window.GM_xmlhttpRequest = (opts) => {
  const body = JSON.parse(opts.data);
  const prompt = body.messages[body.messages.length - 1].content;
  // 模拟模型：判断题答「正确」
  const answer = { skip: false, answer: '正确' };
  setTimeout(() => opts.onload({
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] })
  }), 0);
};

window.eval(fs.readFileSync(SCRIPT, 'utf8'));
if (window.document.readyState === 'loading') {
  await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
}
await new Promise(r => setTimeout(r, 30));

const api = window.quizbot;
const doc = window.document;
check('脚本注入成功', !!api);
if (!api) process.exit(1);

/* ---- 1. 关键回归：聊天输入框不能被当成填空题 ---- */
console.log('\n=== 1. 聊天输入框不应被当成题目（回归）===');
const formQuestions = api.read();
const asText = JSON.stringify(formQuestions);
check('「发送消息」输入框没有被识别成填空题',
  !asText.includes('发送消息'), '识别结果: ' + asText.slice(0, 200));
check('对话窗口没有可填写表单题目', formQuestions.length === 0, '实际 ' + formQuestions.length + ' 题');

/* ---- 2. 自动识别 ---- */
console.log('\n=== 2. 自动识别消息区域与输入框 ===');
check('自动找到了消息区域和输入框', api.chat.detect() === true);
const msgs = api.chat.messages();
console.log('识别到 ' + msgs.length + ' 条消息:');
msgs.forEach((m, i) => console.log('  #' + (i + 1) + ' [' + (m.self ? '我' : '对方') + '] ' + m.text.replace(/\n/g, ' ').slice(0, 60)));

check('识别到 3 条消息', msgs.length === 3, '实际 ' + msgs.length);
check('条 1 判定为对方（靠左）', msgs[0] && msgs[0].self === false, msgs[0] ? String(msgs[0].self) : '无');
check('条 2 判定为我（靠右）', msgs[1] && msgs[1].self === true, msgs[1] ? String(msgs[1].self) : '无');
check('条 3 判定为对方并含题目',
  msgs[2] && msgs[2].self === false && msgs[2].text.includes('判断题'),
  msgs[2] ? msgs[2].text.slice(0, 40) : '无');

/* ---- 3. 回答最新一条 ---- */
console.log('\n=== 3. 回答最新一条并发送 ===');
const res = await api.chat.answer(true);
check('answer() 返回已发送', !!(res && res.sent), JSON.stringify(res));
check('回复内容是模型给的答案', res && res.answer === '正确', res ? res.answer : '无');

const sent = window.SENT || [];
check('答案确实被发送出去了（点到发送按钮）', sent.length === 1, JSON.stringify(sent));
check('发送内容正确', sent[0] === '正确', JSON.stringify(sent[0]));
check('输入框发送后已清空',
  doc.getElementById('editor').textContent === '',
  JSON.stringify(doc.getElementById('editor').textContent));

/* ---- 4. 去重：同一条不重复回答 ---- */
console.log('\n=== 4. 同一条消息不会重复回答 ===');
const again = await api.chat.answer(false);
check('未强制时同一条消息被跳过', again === null, JSON.stringify(again));
check('没有产生新的发送', (window.SENT || []).length === 1, JSON.stringify(window.SENT));

/* ---- 5. 自动应答：新消息触发 ---- */
console.log('\n=== 5. 自动应答（MutationObserver）===');
api.chat.start();
check('自动应答已开启', api.chat._state.watching === true);

const list = doc.getElementById('chatList');
const row = doc.createElement('div');
row.className = 'msg-row other';
const bubble = doc.createElement('div');
bubble.className = 'bubble';
bubble.textContent = '【判断题】TCP 是面向连接的协议。\nA: 正确；B: 错误';
row.appendChild(bubble);
list.appendChild(row);

await new Promise(r => setTimeout(r, 2600));   // 等冷却时间 + 请求
const sent2 = window.SENT || [];
check('新消息到达后自动回复了', sent2.length === 2, '共发送 ' + sent2.length + ' 条: ' + JSON.stringify(sent2));
check('自动回复内容正确', sent2[1] === '正确', JSON.stringify(sent2[1]));

api.chat.stop();
check('自动应答已停止', api.chat._state.watching === false);

/* ---- 6. 方向判断可手动覆盖 ---- */
console.log('\n=== 6. 手动指定「我的消息位置」===');
api.save({ chatSelfSide: 'left' });
const flipped = api.chat.messages();
check('切换为「我的消息在左侧」后判定反转',
  flipped[1] && flipped[1].self === false, JSON.stringify(flipped.map(m => m.self)));
api.save({ chatSelfSide: 'auto' });

console.log('\n' + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');
