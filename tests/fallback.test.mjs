/**
 * 兜底方法测试：用一个「故意对抗自动识别」的页面
 * （无意义类名 x1~x9、深层嵌套），验证两条不依赖猜测的路子确实可用。
 *
 *   node tests/fallback.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPT = fs.readFileSync(path.join(ROOT, 'userscript', 'quizbot.user.js'), 'utf8');
const FIXTURE = fs.readFileSync(path.join(HERE, 'hostile_dom.html'), 'utf8');

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('  [PASS] ' + label); }
  else { fail++; console.log('  [FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
};

const dom = new JSDOM(FIXTURE, { url: 'https://example.test/hostile',
  runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;

/* 按 fixture 的 CSS 模拟布局（jsdom 不做布局） */
window.Element.prototype.getBoundingClientRect = function () {
  const cls = String(this.className || '');
  const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
  if (cls.includes('x3')) return mk(0, 0, 900, 700);
  // 按真实聊天流：每条消息纵向依次排列
  if (cls.includes('x4')) {
    const rows = Array.from(this.parentElement ? this.parentElement.children : []);
    const i = Math.max(0, rows.indexOf(this));
    return mk(0, 40 + i * 80, 900, 70);
  }
  // 按 fixture 的 CSS 语义：.x5 是 flex-end，所以它的气泡靠右 → 判定为「我」
  if (cls.includes('x6')) {
    const isSelf = !!this.closest('.x5');
    const row = this.closest('.x4');
    const rows = Array.from(row && row.parentElement ? row.parentElement.children : []);
    const i = Math.max(0, rows.indexOf(row));
    return mk(isSelf ? 420 : 20, 40 + i * 80, 460, 50);
  }
  if (cls.includes('x7')) return mk(0, 700, 900, 80);
  if (cls.includes('x8')) return mk(20, 715, 800, 40);
  if (cls.includes('x9')) return mk(840, 715, 60, 40);
  return mk(0, 0, 900, 800);
};

window.fetch = (url, opts) => {
  const body = JSON.parse(opts.body);
  const prompt = body.messages[body.messages.length - 1].content;
  // 判断第二次的问题：问「面向连接」答正确，其余答 B
  const answer = /面向连接/.test(prompt) ? '正确' : 'B';
  return Promise.resolve({ ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ skip: false, answer }) } }] })) });
};
window.GM_getValue = (k, d) => (k === 'apiKey' ? 'k' : (k === 'baseUrl' ? 'https://api.test/v1' : d));
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};

window.eval(SCRIPT);
if (window.document.readyState === 'loading') {
  await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
}
await new Promise(r => setTimeout(r, 30));

const api = window.quizbot;
const doc = window.document;
check('脚本加载成功', !!api);
if (!api) process.exit(1);

/* ---- 方法一：点击学习 ---- */
console.log('\n=== 方法一：点一条消息学会它 ===');
const bubble = doc.querySelectorAll('.x6')[2];   // 点第二题那条（对方发的）
// 走真实的「点击学习」通路：模拟用户点在这个气泡上
api.chat.useList(bubble.closest('.x4').parentElement);
const msgs = api.chat.messages();
console.log('学习后识别到 ' + msgs.length + ' 条消息:');
msgs.forEach((m, i) => console.log('  #' + (i + 1) + ' [' + (m.self ? '我' : '对方') + '] ' + m.text.replace(/\n/g, ' ').slice(0, 60)));
check('点击学习后能解析出 3 条消息', msgs.length === 3, '实际 ' + msgs.length);
check('能正确区分我与对方',
  msgs.length === 3 && !msgs[0].self && msgs[1].self && !msgs[2].self,
  msgs.map(m => m.self ? '我' : '对方').join(','));

/* ---- 方法二：框选区域 ---- */
console.log('\n=== 方法二：框选题目区域 ===');
// 真实用法：框住「整个聊天记录区」（不含底部输入行）
api.chat._region.rect = { left: 0, top: 40, width: 900, height: 660, right: 900, bottom: 700 };
const regionText = api.chat.regionText();
console.log('框内文字:');
regionText.split('\n').forEach(l => console.log('   | ' + l.replace(/\s+/g, ' ').slice(0, 70)));
check('框选区域读到了文字', regionText.length > 0, regionText.length + ' 字');
check('读到了第一个问题', regionText.includes('默认端口'), regionText.slice(0, 80));
check('读到了第二个问题', regionText.includes('面向连接'), regionText.slice(0, 120));
check('没有把「发送」按钮文案算进题目', !regionText.includes('发送'), JSON.stringify(regionText.slice(0, 60)));

/* ---- 指定输入框 + 区域模式作答 ---- */
console.log('\n=== 区域模式：作答并发送 ===');
api.chat.useInput(doc.querySelector('.x8'));
api.chat._region.rect = { left: 0, top: 40, width: 900, height: 660, right: 900, bottom: 700 };
const res = await api.chat.regionAnswer(true);
check('区域模式作答成功', !!(res && res.sent), JSON.stringify(res));
const sent = window.SENT || [];
check('答案已发送', sent.length >= 1, JSON.stringify(sent));
// 框住整个聊天记录时，最新一道题是「第二题（判断题）」，所以应回答「正确」
check('回答的是最后一道题（判断题→正确）', sent[0] === '正确', JSON.stringify(sent[0]));

/* ---- 只框住第一道题 → 应回答它 ---- */
console.log(String.fromCharCode(10) + '=== 只框住第一道题 ===');
api.chat._region.lastText = '';
api.chat._region.rect = { left: 0, top: 40, width: 900, height: 70, right: 900, bottom: 110 };
const resQ1 = await api.chat.regionAnswer(true);
check('只框第一题时作答成功', !!(resQ1 && resQ1.sent), JSON.stringify(resQ1));
const sentQ1 = window.SENT || [];
check('答案对应第一题（HTTP 端口→B）', sentQ1[sentQ1.length - 1] === 'B', JSON.stringify(sentQ1));

// 复位，后续测试基于整区
api.chat._region.rect = { left: 0, top: 40, width: 900, height: 660, right: 900, bottom: 700 };
api.chat._region.lastText = '';

/* ---- 新消息追加后只取增量 ---- */
console.log('\n=== 新消息到达：只取新增部分 ===');
api.chat._region.lastText = regionText;   // 假装已处理过
const area = doc.getElementById('scrollArea');
const row = doc.createElement('div');
row.className = 'x4';
const b2 = doc.createElement('div');
b2.className = 'x6';
b2.textContent = '第三题：TCP 是面向连接的协议吗？A: 正确  B: 错误';
row.appendChild(b2);
area.appendChild(row);
// 追加后框选区域要能覆盖到 → 扩大一点
api.chat._region.rect = { left: 0, top: 40, width: 900, height: 740, right: 900, bottom: 780 };

const res2 = await api.chat.regionAnswer(true);
check('新消息也能作答', !!(res2 && res2.sent), JSON.stringify(res2));
const sent2 = window.SENT || [];
check('新消息也被正确作答', sent2[sent2.length - 1] === '正确', JSON.stringify(sent2));

console.log('\n' + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');
