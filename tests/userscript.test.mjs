/**
 * 用 jsdom 在真实 DOM 上测试油猴脚本的核心链路。
 * 不需要浏览器、不需要网络：用桩替换 GM_xmlhttpRequest 模拟 API 返回。
 *
 *   node tests/userscript.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPT = path.join(ROOT, 'userscript', 'quizbot.user.js');
const FIXTURE = fs.readFileSync(path.join(HERE, 'sample_quiz.html'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  [PASS] ' + label); }
  else { fail++; console.log('  [FAIL] ' + label + (detail ? ' — ' + detail : '')); }
}

/* 假 API：把「题干」里的既定答案表映射成模型 JSON 输出 */
const ANSWER_KEY = {
  '默认端口': 'B',
  '关系型数据库': ['A', 'C'],
  '面向连接': 'T',
  '幂等性': '幂等性指同一个操作执行一次和执行多次对系统产生的影响相同。',
  '编程语言': 'Python',
  '状态码 200': '请求成功'
};

function fakeAnswerFor(prompt) {
  const answers = [];
  const re = /^\[(\d+)\]\s*\(([^)]*)\)\s*(.*)$/gm;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    const index = Number(m[1]);
    const stem = m[3];
    let answer = null;
    for (const key of Object.keys(ANSWER_KEY)) {
      if (stem.includes(key)) { answer = ANSWER_KEY[key]; break; }
    }
    answers.push({ index, answer, confidence: 0.9, reason: '测试' });
  }
  return JSON.stringify({ answers });
}

const dom = new JSDOM('<!DOCTYPE html><html><body>' + FIXTURE.split('<body>')[1], {
  url: 'https://example.test/quiz',
  runScripts: 'dangerously',      // 让 getComputedStyle / 事件在 window 上下文里正常工作
  pretendToBeVisual: true
});
const { window } = dom;

/* 桩：Tampermonkey 的 GM_* API */
let lastRequest = null;
window.GM_getValue = (k, d) => (k === 'apiKey' ? 'test-key' : (k === 'baseUrl' ? 'https://api.test/v1' : d));
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};

window.GM_xmlhttpRequest = (opts) => {
  lastRequest = opts;
  const body = JSON.parse(opts.data);
  const prompt = body.messages[body.messages.length - 1].content;
  setTimeout(() => {
    opts.onload({
      status: 200,
      responseText: JSON.stringify({ choices: [{ message: { content: fakeAnswerFor(prompt) } }] })
    });
  }, 0);
};

/* jsdom 不实现布局引擎，getBoundingClientRect 一律返回全 0，
   会被脚本的「可见性」判断当成隐藏元素。真实浏览器不存在这个问题，
   所以这里按元素类型给一个合理的假尺寸，只服务于测试。 */
window.Element.prototype.getBoundingClientRect = function () {
  const tag = this.tagName ? this.tagName.toLowerCase() : '';
  const type = (this.getAttribute && this.getAttribute('type')) || '';
  const hidden = this.hasAttribute && (this.hasAttribute('hidden') || this.getAttribute('aria-hidden') === 'true');
  const inlineNone = this.getAttribute && /displays*:s*none/.test(this.getAttribute('style') || '');
  if (hidden || inlineNone) {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  const isControl = tag === 'input' || tag === 'textarea' || tag === 'select';
  const w = isControl ? (type === 'radio' || type === 'checkbox' ? 14 : 200) : 400;
  const h = isControl ? (type === 'radio' || type === 'checkbox' ? 14 : 28) : 20;
  return { x: 10, y: 10, width: w, height: h, top: 10, left: 10, right: 10 + w, bottom: 10 + h };
};

/* 注入脚本（在 window 上下文里执行） */
const scriptErrors = [];
window.addEventListener('error', e => scriptErrors.push(String(e.message || e.error)));
const code = fs.readFileSync(SCRIPT, 'utf8');
window.eval(code);

/* jsdom 的 DOMContentLoaded 是异步派发的，脚本会在该事件里初始化面板，这里等它跑完 */
if (window.document.readyState === 'loading') {
  await new Promise(resolve => window.addEventListener('DOMContentLoaded', resolve, { once: true }));
}
await new Promise(resolve => setTimeout(resolve, 30));

const api = window.quizbot;
check('脚本注入后暴露 window.quizbot', !!api,
  scriptErrors.length ? '脚本报错: ' + scriptErrors.join(' | ') : '未初始化');
if (!api) { process.exit(1); }

/* ---- 1. 读取题目 ---- */
console.log('\n=== 1. 读取题目 ===');
const questions = api.read();
console.log('识别到 ' + questions.length + ' 道题');
questions.forEach(q => console.log('  [' + q.index + '] ' + q.type + ' :: ' + String(q.stem).replace(/\n/g, ' ').slice(0, 60)));

check('识别到 6 道题', questions.length === 6, '实际 ' + questions.length);
const types = questions.map(q => q.type);
check('题型齐备（单选/多选/文本/下拉）',
  types.includes('single') && types.includes('multiple') && types.includes('text') && types.includes('select'),
  types.join(','));

const q1 = questions.find(q => String(q.stem).includes('默认端口'));
check('第 1 题题干解析正确', !!q1 && q1.stem.includes('HTTP'), q1 ? q1.stem : '未找到');
if (q1) {
  check('第 1 题选项为 A~D', q1.options.map(o => o.key).join('') === 'ABCD',
    q1.options.map(o => o.key).join(''));
  check('选项文字已剥离字母前缀', q1.options[0].text === '21', JSON.stringify(q1.options[0].text));
}

const q3 = questions.find(q => String(q.stem).includes('面向连接'));
check('判断题选项 key 识别为 T/F', !!q3 && q3.options.map(o => o.key).join('') === 'TF',
  q3 ? q3.options.map(o => o.key).join('') : '未找到');

const q4 = questions.find(q => q.type === 'text');
check('填空题带 handle', !!q4 && !!q4.handle, q4 ? JSON.stringify(q4.handle) : '未找到');

/* ---- 2. 完整流程：调用 API + 填写 ---- */
console.log('\n=== 2. AI 作答并填写（完整流程）===');
const result = await api.run();
check('run() 返回结果', !!result, JSON.stringify(result));
if (result) {
  check('全部 6 题填写成功', result.okCount === 6, '成功 ' + result.okCount + '，失败: ' + JSON.stringify(result.fails));
}
check('请求发到了正确的地址', lastRequest && lastRequest.url === 'https://api.test/v1/chat/completions',
  lastRequest ? lastRequest.url : '无请求');
check('请求带上了 Authorization 头',
  !!lastRequest && lastRequest.headers.Authorization === 'Bearer test-key',
  lastRequest ? JSON.stringify(lastRequest.headers.Authorization) : '');

/* ---- 3. 读回 DOM 断言 ---- */
console.log('\n=== 3. 读回页面真实状态 ===');
const doc = window.document;
const checkedRadio = name => {
  const el = doc.querySelector('input[name="' + name + '"]:checked');
  return el ? el.value : null;
};
const boxesText = () => Array.from(doc.querySelectorAll('input[name="q2"]:checked')).map(e => e.value);

check('第 1 题（单选）选中 B', checkedRadio('q1') === 'B', String(checkedRadio('q1')));
check('第 2 题（多选）勾选 A 和 C', boxesText().sort().join('') === 'AC', boxesText().join(''));
check('第 3 题（判断题 T/F）选中 T', checkedRadio('q3') === 'T', String(checkedRadio('q3')));
check('第 4 题（textarea）已填入',
  doc.querySelector('textarea[name=q4]').value.includes('幂等性'),
  doc.querySelector('textarea[name=q4]').value.slice(0, 40));
check('第 5 题（select）选中 Python',
  doc.querySelector('select[name=q5]').value === 'py',
  doc.querySelector('select[name=q5]').value);
check('第 6 题（填空）已填入',
  doc.querySelector('input[name=q6]').value.includes('请求成功'),
  doc.querySelector('input[name=q6]').value);

/* ---- 4. React 受控输入兼容性 ---- */
console.log('\n=== 4. 受控组件兼容性 ===');
let inputEvents = 0;
let changeEvents = 0;
const probe = doc.querySelector('input[name=q6]');
probe.addEventListener('input', () => inputEvents++);
probe.addEventListener('change', () => changeEvents++);
api.fill();
check('重新填写时触发了 input 事件', inputEvents > 0, String(inputEvents));
check('重新填写时触发了 change 事件', changeEvents > 0, String(changeEvents));

/* ---- 5. 分组：同名 radio 只算一题 ---- */
console.log('\n=== 5. 分组正确性 ===');
const singles = questions.filter(q => q.type === 'single');
check('4 个同名 radio 归为 1 题，而不是 4 题', singles.length === 2,
  '单选题目数 = ' + singles.length + '（q1 与 q3）');

console.log('\n' + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');
