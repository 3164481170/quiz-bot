/**
 * 内置答案库回归：命中即填、命中时不联网。
 *   node tests/builtin-answers.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPT = fs.readFileSync(path.join(ROOT, 'userscript', 'quizbot.user.js'), 'utf8');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('  [PASS] ' + label); }
  else { fail++; console.log('  [FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
};

// 从脚本里抽出内置答案，用于构造对应页面
const START = '/* __BUILTIN_START__ */';
const END = '/* __BUILTIN_END__ */';
const from = SCRIPT.indexOf(START);
const to = SCRIPT.indexOf(END);
if (from < 0 || to <= from) { console.log('找不到内置答案块'); process.exit(1); }
// 块里是若干以逗号分隔的对象，不是 JSON 数组，用数组字面量求值
const BUILTIN = Function('return [' + SCRIPT.slice(from + START.length, to) + '];')();
if (!Array.isArray(BUILTIN) || !BUILTIN.length) {
  console.log('内置答案解析为空');
  process.exit(1);
}

function makeHtml(entry) {
  return [
    "<!DOCTYPE html><html><body>",
    '<main class="student-game"><section class="student-workspace">',
    '  <section class="game-column"><section class="panel story-panel">任务目标 ' + entry.goal + "</section></section>",
    '  <section class="code-column"><section class="editor-panel">',
    '    <button>启动运行</button>',
    '    <div class="monaco-editor"><textarea class="inputarea"></textarea></div>',
    "  </section></section>",
    "</section></main>",
    "</body></html>",
  ].join(NL);
}

function boot(entry) {
  const dom = new JSDOM(makeHtml(entry), {
    url: "https://aicode.test/student",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 });
  window.GM_getValue = (k, d) => d;
  window.GM_setValue = () => {};
  window.GM_registerMenuCommand = () => {};
  let requests = 0;
  window.GM_xmlhttpRequest = (o) => {
    requests++;
    setTimeout(() => o.onload({ status: 200, responseText: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ code: "// 不该走到这里" }) } }],
    }) }), 0);
  };
  window.__count = () => requests;

  // 模拟真实编辑器的写入能力（Monaco 的 setValue）
  let cur = "// 骨架";
  const probe = () => window.document.querySelector(".editor-value-probe");
  window.monaco = {
    editor: {
      getEditors: () => [
        {
          getValue: () => cur,
          setValue: (v) => {
            cur = v;
            window.document.querySelector(".monaco-editor").innerHTML =
              '<div class="view-lines">' +
              String(v).split(NL).map((line) =>
                '<div class="view-line">' + (line || " ") + "</div>").join("") +
              "</div>";
          },
        },
      ],
      getModels: () => [],
    },
  };

  window.eval(SCRIPT);
  return window;
}

async function ready(window) {
  if (window.document.readyState === 'loading') {
    await new Promise((r) => window.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  await new Promise((r) => setTimeout(r, 60));
  const api = window.quizbot;
  api.save({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' });
  return api;
}

console.log('=== 1. 答案库完整性 ===');
{
  check("内置了 20 题", BUILTIN.length === 20, String(BUILTIN.length));
  const emptyCode = BUILTIN.filter((b) => !b.code || !b.code.trim());
  check("每题都有代码", emptyCode.length === 0, emptyCode.map((b) => b.index).join(","));
  const dupTitle = BUILTIN.map((b) => b.title);
  check("标题不重复", new Set(dupTitle).size === dupTitle.length);
  const noTodo = BUILTIN.filter((b) => /TODO/.test(b.code.replace(/\/\/.*TODO[^\n]*/g, "")));
  check("代码里不残留 TODO 占位", noTodo.length === 0, noTodo.map((b) => b.index).join(","));
  const idx = BUILTIN.map((b) => b.index).sort((a, c) => a - c);
  check("题号连续 1..20", idx.every((v, i) => v === i + 1), idx.join(","));
}

console.log(NL + '=== 2. 命中内置答案：不联网、瞬时填入 ===');
{
  const entry = BUILTIN[0];
  const window = boot(entry);
  const api = await ready(window);
  const before = window.__count();
  const r = await api.code.run(true);
  const after = window.__count();
  console.log("  结果: " + JSON.stringify(r && { ok: r.ok, how: r.how, builtin: r.builtin }));
  check("作答成功", !!(r && r.ok), JSON.stringify(r));
  check("标记为内置命中", r && r.builtin === true, String(r && r.builtin));
  check("完全没有发起 API 请求", before === after, String(after - before));
  check("编辑器里是内置代码", api.code.editorCode().includes("me.setEnergy(4)"), api.code.editorCode().slice(0, 50));
}

console.log(NL + '=== 3. 每一题都能被匹配到 ===');
{
  let hit = 0;
  const missed = [];
  for (const entry of BUILTIN) {
    const window = boot(entry);
    const api = await ready(window);
    const r = await api.code.run(true);
    if (r && r.builtin) hit++;
    else missed.push(entry.index + " " + entry.title);
    window.close();
  }
  console.log("  命中 " + hit + "/" + BUILTIN.length);
  check("20 题全部命中", hit === BUILTIN.length, missed.join(" | "));
}

console.log(NL + '=== 4. 未知题目回落到 API ===');
{
  const window = boot({ goal: "这是一个答案库里没有的全新关卡任务，需要现写。", title: "不存在的关卡" });
  const api = await ready(window);
  const r = await api.code.run(true);
  check("未知题目会用 API", window.__count() > 0, String(window.__count()));
  check("走的是 AI 而不是内置", !(r && r.builtin), String(r && r.builtin));
}

console.log(NL + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');