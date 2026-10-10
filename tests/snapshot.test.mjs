/**
 * 快照工具的自我验证：对着一个仿扣子的对话页跑一遍，
 * 确认它真的能抓出「消息容器、输入框、题目文字、祖先链」。
 *
 *   node tests/snapshot.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SNAP = fs.readFileSync(path.join(ROOT, 'tools', 'snapshot.js'), 'utf8');

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('  [PASS] ' + label); }
  else { fail++; console.log('  [FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
};

/* 仿扣子：侧栏 + 聊天区 + 底部输入行，聊天区在文档后部 */
let body = '<div id="app">';
body += '<div id="sidebar">';
for (let i = 0; i < 300; i++) body += '<div class="side-item"><span class="ico"></span><span class="lbl">会话 ' + i + '</span></div>';
body += '</div>';
body += '<div id="main">';
body += '<div class="chat-list" role="log">';
body += '<div class="msg-row other"><div class="avatar">AI</div><div class="bubble">【判断题】(2分)：' +
        'Java 中所有的关键字都不能作为标识符使用 A: 正确；B: 错误</div></div>';
body += '<div class="msg-row self"><div class="bubble">A</div><div class="avatar">我</div></div>';
body += '<div class="msg-row other"><div class="avatar">AI</div><div class="bubble">【判断题】(2分)：' +
        'Java 中基本数据类型 int 占用的内存字节数是 4 个字节。 A: 正确；B: 错误</div></div>';
body += '</div>';
body += '<div class="chat-input"><div class="editor" contenteditable="true" data-placeholder="发送消息"></div>' +
        '<button class="send">发送</button></div>';
body += '</div></div>';

const dom = new JSDOM('<!DOCTYPE html><html><body>' + body + '</body></html>',
  { url: 'https://example.test/coze', runScripts: 'dangerously', pretendToBeVisual: true });
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
  if (cls.includes('msg-row')) {
    const i = Array.from(this.parentElement.children).indexOf(this);
    return mk(300, 100 + i * 120, 1000, 100);
  }
  if (cls.includes('bubble')) {
    const self = !!this.closest('.msg-row.self');
    return mk(self ? 900 : 320, 110, 380, 80);
  }
  if (cls.includes('chat-input')) return mk(300, 780, 1000, 80);
  if (cls.includes('editor')) return mk(320, 795, 900, 50);
  if (cls.includes('send')) return mk(1230, 795, 60, 40);
  return mk(0, 0, 1000, 100);
};
window.GM_getValue = (k, d) => d;
window.GM_setValue = () => {};

window.eval(SNAP);
const report = window.__qbSnapshotReport || '';

console.log('快照长度: ' + report.length + ' 字');
console.log('');

check('快照生成成功', report.length > 500, report.length + ' 字');
check('报告了环境信息', report.includes('视口:'), '');
check('报告了 iframe 情况', report.includes('===== 2. iframe ====='));
check('列出了候选输入框', report.includes('===== 3. 所有候选输入框 ====='));
check('列出了候选消息容器', report.includes('===== 4. 候选消息容器'));
check('列出了最深的文本块', report.includes('===== 5. 最深的文本块'));
check('做了屏幕采样', report.includes('===== 6. 屏幕采样点'));
check('给出了 HTML 快照', report.includes('===== 7. 关键区域 HTML 快照'));
check('检查了 Shadow DOM', report.includes('===== 8. Shadow DOM'));

console.log(String.fromCharCode(10) + '--- 关键内容抽查 ---');
check('抓到了题目文字', report.includes('Java 中所有的关键字'), '');
check('抓到了 chat-list 容器', report.includes('chat-list'), '');
check('抓到了输入框 placeholder', report.includes('发送消息'), '');
check('给出了子元素签名分布', report.includes('子元素签名:'), '');
check('给出了祖先链', report.includes('祖先链:'), '');
check('显示在页面上（有文本框）', !!window.document.querySelector('[data-quizbot-ui] textarea'), '');

console.log(String.fromCharCode(10) + '--- 报告片段预览 ---');
const lines2 = report.split(String.fromCharCode(10));
const idx = lines2.findIndex(l => l.includes('===== 4.'));
lines2.slice(idx, idx + 16).forEach(l => console.log('  ' + l.slice(0, 150)));

console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');