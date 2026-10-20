/**
 * 验证设置面板在小屏/缩放时不会被截断：必须有高度上限与纵向滚动。
 *
 *   node tests/ui-scroll.test.mjs
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

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="host"></div></body></html>',
  { url: 'https://example.test/q', runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40 };
};
window.GM_getValue = (k, d) => d;
window.GM_setValue = () => {};
window.GM_registerMenuCommand = () => {};
window.eval(SCRIPT);
if (window.document.readyState === 'loading') await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
await new Promise(r => setTimeout(r, 60));

const api = window.quizbot;
check('脚本加载成功', !!api);
if (!api) process.exit(1);

const panel = window.document.querySelector('[data-quizbot-ui]');
check('面板已渲染', !!panel);
if (!panel) process.exit(1);

const css = String(panel.getAttribute('style') || '');
console.log('  面板样式片段: ' + css.slice(0, 160).replace(/\s+/g, ' ') + '…');

console.log('');
console.log('=== 1. 高度必须受视口约束 ===');
check('有 max-height 且基于视口高度', /max-height:\s*calc\(100vh/.test(css),
  css.match(/max-height:[^;]+/) ? css.match(/max-height:[^;]+/)[0] : '(缺失)');
check('不再使用固定 width 而无上限', /max-width:\s*calc\(100vw/.test(css),
  css.match(/max-width:[^;]+/) ? css.match(/max-width:[^;]+/)[0] : '(缺失)');

console.log('');
console.log('=== 2. 必须能纵向滚动 ===');
check('overflow-y 为 auto 或 scroll', /overflow-y:\s*(auto|scroll)/.test(css),
  css.match(/overflow-y:[^;]+/) ? css.match(/overflow-y:[^;]+/)[0] : '(缺失)');
check('横向不出现滚动条', /overflow-x:\s*hidden/.test(css),
  css.match(/overflow-x:[^;]+/) ? css.match(/overflow-x:[^;]+/)[0] : '(缺失)');

console.log('');
console.log('=== 3. 盒模型不能把 padding 撑出边界 ===');
check('使用 border-box', /box-sizing:\s*border-box/.test(css),
  css.match(/box-sizing:[^;]+/) ? css.match(/box-sizing:[^;]+/)[0] : '(缺失)');

console.log('');
console.log('=== 4. 滚动不会带动页面本身 ===');
check('overscroll-behavior: contain', /overscroll-behavior:\s*contain/.test(css));

console.log('');
console.log('=== 5. 设置区在面板内部（跟随面板滚动）===');
check('设置区是面板的后代节点', !!panel.querySelector('#qb-config'),
  '#qb-config ' + (panel.querySelector('#qb-config') ? '存在' : '不存在'));

console.log('');
console.log('=== 6. 结构快照弹窗同样受视口约束 ===');
api.snapshotReport && api.snapshot();
await new Promise(r => setTimeout(r, 50));
const dialogs = Array.from(window.document.querySelectorAll('[data-quizbot-ui]'))
  .filter(d => d !== panel && /position:\s*fixed/.test(String(d.getAttribute('style') || '')));
const snapshotDlg = dialogs.find(d => {
  const s = String(d.getAttribute('style') || '');
  return /width:\s*540px/.test(s);
});
check('找到了快照弹窗', !!snapshotDlg);
if (snapshotDlg) {
  const scss = String(snapshotDlg.getAttribute('style') || '');
  check('快照弹窗高度基于视口', /max-height:\s*calc\(100vh/.test(scss),
    scss.match(/max-height:[^;]+/) ? scss.match(/max-height:[^;]+/)[0] : '(缺失)');
  check('快照弹窗宽度有上限', /max-width:\s*calc\(100vw/.test(scss));
  check('快照弹窗 border-box', /box-sizing:\s*border-box/.test(scss));
}

console.log('');
console.log('='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');