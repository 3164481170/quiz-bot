/**
 * 诊断基准：量化「自动识别」到底有多贵。
 *
 * jsdom 既不实现 innerText，也不做布局，所以不能靠它测真实耗时。
 * 这里改用「昂贵操作计数」作为代理指标 —— 在真实浏览器里：
 *   - 每次读 innerText        → 触发整棵子树的布局计算（很贵）
 *   - 每次 getBoundingClientRect → 强制同步重排（forced reflow，很贵）
 * 两者次数直接决定是否卡死主线程。
 *
 *   node tests/perf-diag.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPT = fs.readFileSync(path.join(ROOT, 'userscript', 'quizbot.user.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(HERE, 'sample_chat.html'), 'utf8')
  .split('<body>')[1].split('</body>')[0];

/* 造一个「像真实 Coze 应用」的 DOM：聊天区 + 大量侧栏/卡片噪声 */
function buildHtml(noise) {
  const p = [CHAT, '<div id="sidebar">'];
  for (let i = 0; i < noise; i++) {
    p.push('<div class="side-item"><span class="ico"></span><span class="lbl">会话' + i + '</span></div>');
  }
  p.push('</div><div id="workbench">');
  for (let i = 0; i < noise; i++) {
    p.push('<div class="card"><div class="hd"><div class="tt">标题' + i + '</div></div>' +
           '<div class="bd"><p>正文' + i + '</p><span class="tg">标签</span></div></div>');
  }
  p.push('</div>');
  return '<!DOCTYPE html><html><body>' + p.join('') + '</body></html>';
}

async function run(noise, label) {
  const dom = new JSDOM(buildHtml(noise), { url: 'https://example.test/app',
    runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;

  let innerTextReads = 0, rectCalls = 0, styleCalls = 0;

  // 必须在脚本执行「之前」装好探针，但初始化阶段（建面板）也读 innerText，
  // 所以先只装计数器，脚本跑完后再清零，单独统计后面的检测阶段。
  // 模拟真实布局：聊天区是大块可滚动区域，侧栏是窄而高的列表，卡片是小块。
  // 用几何尺寸来区分「消息区」和「侧边栏」，这正是脚本要做的判断。
  window.Element.prototype.getBoundingClientRect = function () {
    rectCalls++;
    const t = (this.tagName || '').toLowerCase();
    const cls = String(this.className || '');
    const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
    if (this.id === 'chatList' || cls.includes('chat-list')) return mk(300, 60, 700, 600);
    if (this.id === 'sidebar' || cls.includes('side-item')) return mk(0, 60, 260, 900);
    if (cls.includes('msg-row') || cls.includes('bubble')) return mk(320, 100, 400, 60);
    if (this.id === 'editor') return mk(320, 690, 600, 40);
    if (this.id === 'sendBtn') return mk(930, 690, 70, 40);
    if (cls.includes('card')) return mk(300, 100, 400, 120);
    if (t === 'input' || t === 'textarea' || t === 'select' || t === 'button') return mk(10, 10, 200, 28);
    return mk(0, 0, 1000, 400);
  };
  const origGCS = window.getComputedStyle.bind(window);
  window.getComputedStyle = function (el, ps) { styleCalls++; return origGCS(el, ps); };

  window.GM_getValue = (k, d) => d;
  window.GM_setValue = () => {};
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = () => {};

  const scriptErrors = [];
  window.addEventListener('error', e => scriptErrors.push(String(e.message || e.error)));
  window.eval(SCRIPT);

  // 脚本在 DOMContentLoaded 之后才建面板并挂 window.quizbot，
  // 这里必须等它，否则拿到的是 undefined（测试自身的时序问题）。
  if (window.document.readyState === 'loading') {
    await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  await new Promise(r => setTimeout(r, 40));

  const api = window.quizbot;
  const doc = window.document;
  if (!api) {
    console.log('脚本初始化失败: ' + (scriptErrors.join(' | ') || '(无错误信息)'));
    return null;
  }

  // 脚本已就绪，现在装 innerText 探针（真实浏览器里读它极贵）
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { innerTextReads++; return this.textContent; }
  });

  // ---- 场景 A：自动识别 ----
  innerTextReads = 0; rectCalls = 0; styleCalls = 0;
  const t0 = Date.now();
  let detectOk = false, detectErr = '';
  try { detectOk = api.chat.detect(); } catch (e) { detectErr = e.message; }
  const detectMs = Date.now() - t0;
  const a = { ms: detectMs, innerText: innerTextReads, rect: rectCalls, style: styleCalls, ok: detectOk, err: detectErr };

  // ---- 场景 B：手动指定消息区域后再预览 ----
  const list = doc.getElementById('chatList');
  api.chat.useList(list);
  api.chat.useInput(doc.getElementById('editor'));
  innerTextReads = 0; rectCalls = 0; styleCalls = 0;
  const t1 = Date.now();
  let msgs = [], previewErr = '';
  try { msgs = api.chat.messages(); } catch (e) { previewErr = e.message; }
  const previewMs = Date.now() - t1;
  const b = { ms: previewMs, innerText: innerTextReads, rect: rectCalls, style: styleCalls,
              count: msgs.length, err: previewErr };

  console.log('=== ' + label + ' (DOM ' + doc.querySelectorAll('*').length + ' 元素) ===');
  console.log('  A 自动识别: ' + a.ms + 'ms | innerText ' + a.innerText + ' 次 | 强制布局 ' + a.rect +
              ' 次 | getComputedStyle ' + a.style + ' 次 | 成功=' + a.ok + (a.err ? ' | 异常: ' + a.err : ''));
  console.log('  B 手动指定后预览: ' + b.ms + 'ms | innerText ' + b.innerText + ' 次 | 强制布局 ' + b.rect +
              ' 次 | getComputedStyle ' + b.style + ' 次 | 消息数=' + b.count + (b.err ? ' | 异常: ' + b.err : ''));
  return { a, b };
}

const small = await run(200, '小页面');
console.log('');
const big = await run(600, '大页面');
if (!small || !big) { console.log('无法完成体检（脚本初始化失败）。'); process.exit(1); }

console.log('\n--- 增长倍率（页面放大 3 倍）---');
console.log('  A 自动识别 innerText: ' + (small.a.innerText ? (big.a.innerText / small.a.innerText).toFixed(2) : 'n/a') + 'x');
console.log('  A 自动识别 强制布局: ' + (small.a.rect ? (big.a.rect / small.a.rect).toFixed(2) : 'n/a') + 'x');
console.log('  B 预览     innerText: ' + (small.b.innerText ? (big.b.innerText / small.b.innerText).toFixed(2) : 'n/a') + 'x');
console.log('  B 预览     强制布局: ' + (small.b.rect ? (big.b.rect / small.b.rect).toFixed(2) : 'n/a') + 'x');

const LIMIT = 500;
console.log('\n--- 判定（越少越好；真实浏览器里每次都是同步重排）---');
const okDetect = big.a.innerText + big.a.rect < LIMIT;
const okPreview = big.b.innerText + big.b.rect < LIMIT;
console.log((okDetect ? '[PASS]' : '[FAIL]') + ' 自动识别的昂贵操作 < ' + LIMIT + '（实际 ' +
            (big.a.innerText + big.a.rect) + '）');
console.log((okPreview ? '[PASS]' : '[FAIL]') + ' 预览的昂贵操作 < ' + LIMIT + '（实际 ' +
            (big.b.innerText + big.b.rect) + '）');
if (!okDetect || !okPreview) {
  console.log('\n结论：昂贵操作过多 —— 在真实浏览器里足以让主线程卡住数秒到数十秒。');
  process.exit(1);
}
console.log('\n达标 ✔');
