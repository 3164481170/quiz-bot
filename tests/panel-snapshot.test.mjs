/**
 * 验证「面板里的导出结构快照」按钮真的能产出可用报告。
 *
 *   node tests/panel-snapshot.test.mjs
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

/* 仿扣子真实结构 */
let body = '<div id="app">';
body += '<div id="sidebar">';
for (let i = 0; i < 200; i++) body += '<div class="side-item"><span class="ico"></span><span class="lbl">会话 ' + i + '</span></div>';
body += '</div><div id="main">';
body += '<div class="chat-list"><div class="msg other"><div class="bubble">【判断题】(2分)：Java 中所有的关键字都不能作为标识符使用 A: 正确；B: 错误</div></div>';
body += '<div class="msg self"><div class="bubble">A</div></div>';
body += '<div class="msg other"><div class="bubble">考查知识点：【Java 基础 - 变量、标识符、基本数据类型、运算符】' +
        '【判断题】(2分)：Java 中基本数据类型 int 占用的内存字节数是 4 个字节。 A: 正确；B: 错误</div></div></div>';
body += '<div class="chat-input"><div class="editor" contenteditable="true" data-placeholder="发送消息"></div>' +
        '<button class="send">发送</button></div>';
body += '</div></div>';

const dom = new JSDOM('<!DOCTYPE html><html><body>' + body + '</body></html>',
  { url: 'https://www.coze.cn/store/project/7689061576766685203', runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  const cls = String(this.className || '');
  const id = this.id || '';
  const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
  if (id === 'app') return mk(0, 0, 1400, 900);
  if (id === 'sidebar') return mk(0, 0, 260, 900);
  if (cls.includes('side-item')) return mk(10, 100, 240, 36);
  if (id === 'main') return mk(260, 0, 1140, 900);
  if (cls.includes('chat-list')) return mk(300, 60, 1000, 700);
  if (cls.includes('msg')) { const i = Array.from(this.parentElement.children).indexOf(this); return mk(300, 100 + i * 140, 1000, 120); }
  if (cls.includes('bubble')) { const s = !!this.closest('.msg.self'); return mk(s ? 900 : 320, 110, 380, 100); }
  if (cls.includes('chat-input')) return mk(300, 780, 1000, 80);
  if (cls.includes('editor')) return mk(320, 795, 900, 50);
  if (cls.includes('send')) return mk(1230, 795, 60, 40);
  return mk(0, 0, 1000, 100);
};
window.GM_getValue = (k, d) => d;
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};
window.eval(SCRIPT);
if (window.document.readyState === 'loading') await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
await new Promise(r => setTimeout(r, 40));

const api = window.quizbot;
check('脚本加载成功', !!api);
if (!api) process.exit(1);
check('暴露了 snapshot API', typeof api.snapshot === 'function');

/* 用 API 直接取报告（等价于点按钮后文本框里的内容） */
const report = api.snapshotReport();
console.log(String.fromCharCode(10) + '快照长度: ' + report.length + ' 字');
check('报告非空', report.length > 1000, report.length + ' 字');
check('含环境章节', report.includes('===== 1. 环境 ====='));
check('含 iframe 章节', report.includes('===== 2. iframe ====='));
check('含输入框章节', report.includes('===== 3. 所有候选输入框'));
check('含候选容器章节', report.includes('===== 4. 候选消息容器'));
check('含最深文本块章节', report.includes('===== 5. 最深的文本块'));
check('含屏幕采样章节', report.includes('===== 6. 屏幕采样点'));
check('含 HTML 快照章节', report.includes('===== 7. 关键区域 HTML 快照'));
check('含 Shadow DOM 章节', report.includes('===== 8. Shadow DOM'));
check('抓到了真实题目文字', report.includes('Java 中所有的关键字'));
check('抓到了输入框 placeholder', report.includes('发送消息'));
check('候选 #0 是 chat-list（不是侧栏）', /候选 #0 ---[\s\S]{0,200}chat-list/.test(report), '');
check('报告了 URL', report.includes('coze.cn'));

/* 点按钮后应出现对话框 */
api.snapshot();
await new Promise(r => setTimeout(r, 30));
// 页面上可能有多个 textarea（设置表单里也有一个），取 value 最长的那个 = 快照框
const allTa = Array.from(window.document.querySelectorAll('textarea'))
  .filter(t => t.closest('[data-quizbot-ui]'));
const dlg = allTa.reduce((best, t) => (!best || t.value.length > best.value.length) ? t : best, null);
check('点按钮后弹出快照对话框', !!dlg, '找到 ' + allTa.length + ' 个候选');
if (dlg) {
  check('对话框里有完整报告', dlg.value.length > 1000, dlg.value.length + ' 字');
  const btns = Array.from(window.document.querySelectorAll('[data-quizbot-ui] button')).map(b => b.textContent);
  check('有「复制」按钮', btns.includes('复制'), JSON.stringify(btns));
  check('有「点击采集某个气泡」按钮', btns.some(b => b.includes('点击采集')), JSON.stringify(btns));
  check('有「下载为文件」按钮', btns.includes('下载为文件'), JSON.stringify(btns));
}

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');