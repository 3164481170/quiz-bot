/**
 * 代码模式（Monaco 编辑器 + 关卡任务）回归。
 *
 *   node tests/code-mode.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPT = fs.readFileSync(path.join(ROOT, 'userscript', 'quizbot.user.js'), 'utf8');
const HTML = "<!DOCTYPE html><html><body>\n<main class=\"student-game\"><section class=\"student-workspace\">\n  <aside class=\"student-sidebar\">\n    <section class=\"level-chapter\"><div class=\"level-items\">\n      <button class=\"level-item active\">9-9 测试关卡</button>\n      <button class=\"level-item\">9-8 测试关卡二</button>\n    </div></section>\n  </aside>\n  <section class=\"game-column\">\n    <section class=\"panel story-panel tip-anchor\">任务目标 💡 Tips 测试用关卡（答案库外的题面），请让机器人走一条自制路线，用于验证离线生成路径。</section>\n    <div class=\"game-info-card\"><strong>沿自制路线前进到终点。</strong></div>\n  </section>\n  <section class=\"code-column\"><section class=\"editor-panel\">\n    <button class=\"run\">启动运行</button>\n    <div class=\"monaco-editor\"><textarea class=\"inputarea\" aria-label=\"Editor content\"></textarea></div>\n    <output class=\"editor-value-probe\">// 骨架</output>\n  </section>\n  <div class=\"code-trace\"><div class=\"trace-line\"><span>1</span><code>// 设置能量后</code></div></div>\n  </section>\n</section></main>\n</body></html>";

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('  [PASS] ' + label); }
  else { fail++; console.log('  [FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
};

function boot(opts = {}) {
  const dom = new JSDOM(HTML, { url: "https://aicode.test/student", runScripts: "dangerously", pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () {
    const cls = String(this.className || '');
    const mk = (x, y, w, h) => ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h });
    if (cls.includes('story-panel')) return mk(1168, 100, 400, 120);
    if (cls.includes('editor-panel')) return mk(1168, 300, 400, 500);
    if (cls.includes('monaco')) return mk(1170, 300, 380, 300);
    if (cls.includes('run')) return mk(1400, 220, 100, 30);
    return mk(100, 100, 200, 40);
  };
  window.GM_getValue = (k, d) => d;
  window.GM_setValue = () => {};
  window.GM_registerMenuCommand = () => {};

  const probe = () => window.document.querySelector(".editor-value-probe");

  // 模拟「Monaco 全局可用」
  if (opts.withMonaco) {
    let cur = "// 骨架";
    window.monaco = {
      editor: {
        getEditors: () => [{
          getValue: () => cur,
          setValue: (v) => { cur = v; probe().textContent = v; }
        }],
        getModels: () => []
      }
    };
  }

  // 模拟「只监听 textarea 的平台」：execCommand 会同步到 Monaco 的 .view-line
  if (opts.withExecCommand) {
    const paint = (val) => {
      const host = window.document.querySelector('.monaco-editor');
      // 只重建行容器，不能把 textarea.inputarea 一起清掉
      host.querySelectorAll('.view-line, .view-lines').forEach((n) => n.remove());
      const box = window.document.createElement('div');
      box.className = 'view-lines';
      String(val).split(String.fromCharCode(10)).forEach((line) => {
        const d = window.document.createElement('div');
        d.className = 'view-line';
        d.textContent = line || ' ';
        box.appendChild(d);
      });
      host.appendChild(box);
    };
    window.document.execCommand = function (cmd, ui, val) {
      if (cmd === 'insertText') { paint(val); return true; }
      return false;
    };
    paint('// 骨架');
  }

  window.__requests = [];
  window.GM_xmlhttpRequest = (o) => {
    const body = JSON.parse(o.data);
    const sys = (body.messages || [])[0];
    window.__requests.push({ system: sys ? sys.content : "", user: (body.messages || []).slice(-1)[0].content });
    setTimeout(() => o.onload({ status: 200,
      responseText: JSON.stringify({ choices: [{ message: { content: opts.reply || JSON.stringify({ code: "me.setEnergy(4);" + String.fromCharCode(10) + "for (int i = 0; i < 4; i++) { advance(); }", explain: "设置能量并前进 4 格" }) } }] })
    }), 0);
  };

  window.eval(SCRIPT);
  return { window, probe };
}

async function ready(window) {
  if (window.document.readyState === 'loading') await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
  await new Promise(r => setTimeout(r, 60));
  const api = window.quizbot;
  api.save({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' });
  return api;
}

/* ---- 1. 读取任务 ---- */
console.log('=== 1. 读取关卡任务 ===');
{
  const { window } = boot({ withMonaco: true });
  const api = await ready(window);
  check("暴露了 code API", !!api.code);
  const task = api.code.task();
  console.log("  关卡: " + task.title);
  console.log("  目标: " + task.goal.slice(0, 60));
  check("识别到 Monaco 编辑器", task.hasEditor === true);
  check("读到关卡名", task.title.includes("9-9"), task.title);
  check("读到任务目标", task.goal.includes("测试用关卡"), task.goal.slice(0, 40));
  check("目标里不含「任务目标」标题", !task.goal.startsWith("任务目标"), task.goal.slice(0, 20));
  check("任务目标里没有 Tips 残留", !/^💡|^Tips/.test(task.goal), task.goal.slice(0, 20));
}

/* ---- 2. Monaco 接口写入 ---- */
console.log(String.fromCharCode(10) + '=== 2. 通过 Monaco 接口写入 ===');
{
  const { window, probe } = boot({ withMonaco: true });
  const api = await ready(window);
  const code = "me.setEnergy(4);" + String.fromCharCode(10) + "for (int i = 0; i < 4; i++) { advance(); }";
  const res = api.code.fill(code);
  console.log("  结果: " + JSON.stringify(res.ok) + " 方式=" + res.how);
  check("写入成功", res.ok === true, JSON.stringify(res));
  check("用的是 Monaco 接口", res.how === "Monaco 接口", res.how);
  check("编辑器内容已更新", probe().textContent.includes("me.setEnergy(4)"), probe().textContent.slice(0, 40));
  check("回读与写入一致", api.code.editorCode() === code);
}

/* ---- 3. 没有 monaco 全局时回退到全选替换 ---- */
console.log(String.fromCharCode(10) + '=== 3. 回退：全选替换 ===');
{
  const { window, probe } = boot({ withExecCommand: true });
  const api = await ready(window);
  const code = "me.setEnergy(4);";
  const res = api.code.fill(code);
  console.log("  结果: " + JSON.stringify(res.ok) + " 方式=" + res.how);
  check("回退策略写入成功", res.ok === true, JSON.stringify(res));
  check("用的是全选替换", res.how === "全选替换", res.how);
  check("平台已收到文本", api.code.editorCode().includes("me.setEnergy"), api.code.editorCode());
}

/* ---- 4. 全部策略失败时应明确报失败 ---- */
console.log(String.fromCharCode(10) + '=== 4. 写不进去要如实报失败 ===');
{
  const { window } = boot({});
  const api = await ready(window);
  const res = api.code.fill("me.setEnergy(4);");
  console.log("  ok=" + res.ok + " got=「" + String(res.got).slice(0, 20) + "」");
  check("没有假报成功", res.ok === false, JSON.stringify(res));
}

/* ---- 5. 生成并填入（端到端）---- */
console.log(String.fromCharCode(10) + '=== 5. 生成并填入端到端 ===');
{
  const { window, probe } = boot({ withMonaco: true });
  const api = await ready(window);
  const r = await api.code.run(true);
  console.log("  结果: " + JSON.stringify(r && { ok: r.ok, how: r.how }));
  check("端到端成功", !!(r && r.ok), JSON.stringify(r));
  check("请求里带了任务目标", String((window.__requests[0] || {}).user || "").includes("测试用关卡"), String((window.__requests[0] || {}).user || "").slice(0, 40));
  check("用的是代码专用提示词", ((window.__requests[0] || {}).system || "").includes("Java"), ((window.__requests[0] || {}).system || "").slice(0, 30));
  check("编辑器里是模型给的代码", probe().textContent.includes("me.setEnergy(4)"), probe().textContent.slice(0, 40));
  check("答题记录里有这一条", api.answerLog().length >= 1, String(api.answerLog().length));
}

/* ---- 6. 自动模式：切关卡后自动填充 ---- */
console.log(String.fromCharCode(10) + '=== 6. 自动：切关就填 ===');
{
  const { window, probe } = boot({ withMonaco: true });
  const api = await ready(window);
  api.code.start();
  check("自动模式已开启", api.code._state.watching === true);
  // 模拟切到第 2 关
  const panel = window.document.querySelector(".story-panel");
  panel.textContent = "任务目标 测试关卡二，让机器人走另一条路线。";
  const item = window.document.querySelector(".level-item.active");
  item.classList.remove("active");
  window.document.querySelectorAll(".level-item")[1].classList.add("active");
  await new Promise(r => setTimeout(r, 2500));
  console.log("  编辑器内容: " + String(probe().textContent).slice(0, 40));
  check("新关卡触发了自动填充", String(probe().textContent).includes("me.setEnergy"), String(probe().textContent).slice(0, 40));
  api.code.stop();
  check("可以停止", api.code._state.watching === false);
}

/* ---- 7. 没有任务目标时不乱发请求 ---- */
console.log(String.fromCharCode(10) + '=== 7. 不在关卡页时不乱请求 ===');
{
  const { window } = boot({ withMonaco: true });
  const api = await ready(window);
  const before = window.__requests.length;
  // 情形一：任务面板还在，但内容是无关短文本
  window.document.querySelector(".story-panel").textContent = "随便一段话";
  window.document.querySelector(".game-info-card").textContent = "无关内容";
  const r1 = await api.code.run(true);
  console.log("  短文本: 结果=" + JSON.stringify(r1) + " 新增请求=" + (window.__requests.length - before));
  check("无关短文本不发请求", window.__requests.length === before, String(window.__requests.length - before));

  // 情形二：根本不在关卡页（连 story-panel 都没有）
  const before2 = window.__requests.length;
  window.document.querySelector(".story-panel").remove();
  window.document.querySelector(".game-info-card").remove();
  const r2 = await api.code.run(true);
  console.log("  无任务面板: 结果=" + JSON.stringify(r2) + " 新增请求=" + (window.__requests.length - before2));
  check("没有任务面板时不发请求", window.__requests.length === before2, String(window.__requests.length - before2));
}


/* ---- 8. 关键回归：「逐行执行视图」不能被当成编辑器真值 ----
   真实页面（Byte Goose）右侧同时有两个面板：
     · 上：Monaco 编辑器（用户要改的代码）
     · 下：逐行执行视图 div.code-trace > div.trace-line（上一次运行的结果）
   两者文本很可能相同。如果回读校验读到了 trace-line，
   就会出现「代码明明填进去了，脚本却说写入失败」。 */
console.log(String.fromCharCode(10) + '=== 8. 逐行执行视图不是编辑器真值 ===');
{
  const { window } = boot({});
  const api = await ready(window);
  const doc = window.document;

  // 编辑器内部保持空；旁边放一个内容相同的「逐行执行视图」
  const monaco = doc.querySelector(".monaco-editor");
  monaco.innerHTML = "";
  const ta = doc.createElement("textarea");
  ta.className = "inputarea";
  monaco.appendChild(ta);

  const traced = "me.setEnergy(4);" + String.fromCharCode(10) + "for (int i = 0; i < 4; i++) {";
  const trace = doc.createElement("div");
  trace.className = "code-trace";
  traced.split(String.fromCharCode(10)).forEach((line) => {
    const row = doc.createElement("div");
    row.className = "trace-line";
    row.textContent = line;
    trace.appendChild(row);
  });
  doc.querySelector(".editor-panel").appendChild(trace);

  const read = api.code.editorCode();
  console.log("  editorCode() 读回: 「" + read.slice(0, 50) + "」");
  check("不会把 trace-line 当成编辑器内容", !read.includes("me.moveForward"), read.slice(0, 60));

  // 写入应该被如实判定为失败（编辑器读不到），而不是自以为成功
  const res = api.code.fill("me.setEnergy(4);");
  console.log("  fill 结果: ok=" + res.ok);
  check("读不到编辑器时不假报成功", res.ok === false, JSON.stringify(res));
}

/* ---- 9. 异步重绘的平台：同步读是旧值，稍后才正确 ---- */
console.log(String.fromCharCode(10) + '=== 9. 异步重绘的编辑器 ===');
{
  const { window } = boot({});
  const api = await ready(window);
  const doc = window.document;

  const monaco = doc.querySelector(".monaco-editor");
  monaco.innerHTML = "";
  const ta = doc.createElement("textarea");
  ta.className = "inputarea";
  monaco.appendChild(ta);

  doc.execCommand = function (cmd, ui, val) {
    if (cmd !== "insertText") return false;
    setTimeout(function () {
      monaco.querySelectorAll(".view-line, .view-lines").forEach((n) => n.remove());
      const box = doc.createElement("div");
      box.className = "view-lines";
      String(val).split(String.fromCharCode(10)).forEach((line) => {
        const d = doc.createElement("div");
        d.className = "view-line";
        d.textContent = line || " ";
        box.appendChild(d);
      });
      monaco.appendChild(box);
    }, 400);
    return true;
  };

  const r = await api.code.run(true);
  console.log("  结果: " + JSON.stringify(r && { ok: r.ok, how: r.how }));
  check("异步重绘也能判定成功", !!(r && r.ok), JSON.stringify(r));
  check("延迟复检后读到正确内容", api.code.editorCode().includes("me.setEnergy"), api.code.editorCode());
}

/* ---- 10. 部分写入不能被当成成功 ---- */
console.log(String.fromCharCode(10) + '=== 10. 部分写入不算成功 ===');
{
  const { window } = boot({});
  const api = await ready(window);
  const doc = window.document;
  const monaco = doc.querySelector(".monaco-editor");
  monaco.innerHTML = "";
  const ta = doc.createElement("textarea");
  ta.className = "inputarea";
  monaco.appendChild(ta);

  doc.execCommand = function (cmd, ui, val) {
    if (cmd !== "insertText") return false;
    monaco.querySelectorAll(".view-line, .view-lines").forEach((n) => n.remove());
    const box = doc.createElement("div");
    box.className = "view-lines";
    const d = doc.createElement("div");
    d.className = "view-line";
    d.textContent = String(val).split(String.fromCharCode(10))[0];
    box.appendChild(d);
    monaco.appendChild(box);
    return true;
  };

  const r = await api.code.run(true);
  console.log("  结果: " + JSON.stringify(r && { ok: r.ok }));
  check("只写进去一半时如实报失败", !(r && r.ok), JSON.stringify(r));
}

/* ---- 11. 代码骨架不能被当成填空题（真实事故回归）----
   真实页面里有两块文本：
     「可用 API」面板：  int moveCount / me.setEnergy(int value) / me.moveForward()
     编辑器代码骨架：    int moveCount = [TODO 注释]; …
   旧逻辑把这两块当成「填空题」，还占用了表单模式，
   结果整段代码被当作答案发给模型。 */
console.log(String.fromCharCode(10) + '=== 11. 代码骨架不当作题目 ===');
{
  const { window } = boot({ withMonaco: true });
  const api = await ready(window);
  const doc = window.document;

  const apiPanel = doc.createElement("section");
  apiPanel.className = "api-panel";
  apiPanel.textContent = "可用 API me.setEnergy(int value) me.moveForward() int moveCount";
  doc.querySelector(".code-column").appendChild(apiPanel);

  const skeleton = "int moveCount = /* TODO */;" + String.fromCharCode(10) +
    "// TODO: 用 moveCount 控制移动次数" + String.fromCharCode(10) +
    "for (int i = 0; i < moveCount; i++) {" + String.fromCharCode(10) +
    "  // TODO: 前进一步" + String.fromCharCode(10) + "}";
  api.code.fill(skeleton);

  const qs = api.questions();
  console.log("  表单模式识别到题目数: " + qs.length);
  const joined = JSON.stringify(qs);
  check("API 面板不算题目", !joined.includes("moveForward"), joined.slice(0, 80));
  check("代码骨架不算题目", !joined.includes("moveCount"), joined.slice(0, 80));
  check("编程关卡里识别不到填空题", qs.filter(q => q.type === "text").length === 0, String(qs.length));
}

/* ---- 12. 编程关卡里，对话模式要自动改走代码模式 ---- */
console.log(String.fromCharCode(10) + '=== 12. 编程关卡自动分流到代码模式 ===');
{
  const { window, probe } = boot({ withMonaco: true });
  const api = await ready(window);
  const before = window.__requests.length;
  const r = await api.chat.answer(true);
  console.log("  返回值 ok=" + (r && r.ok));
  check("没有把代码当填空题发出去", window.__requests.length - before <= 1, String(window.__requests.length - before));
  check("实际走的是代码模式", !!(r && r.ok), JSON.stringify(r));
  check("写进了编辑器", String(probe().textContent).includes("me.setEnergy"), String(probe().textContent).slice(0, 40));
}

/* ---- 13. 提示词必须要求替换 TODO ---- */
console.log(String.fromCharCode(10) + '=== 13. 提示词要求落实占位符 ===');
{
  const { window } = boot({ withMonaco: true });
  const api = await ready(window);
  api.code.fill("int moveCount = /* TODO */;");
  await api.code.run(true);
  const req = window.__requests[0] || {};
  console.log("  system 片段: " + String(req.system).slice(0, 60).replace(/\n/g, " "));
  check("提示词警告了 TODO 会编译报错", String(req.system).includes("illegal start of expression"), String(req.system).slice(0, 60));
  check("提示词给出了替换示范", String(req.system).includes("int moveCount = 4"), String(req.system).slice(0, 60));
  check("user 里点了名要替换 TODO", String(req.user).includes("不要保留"), String(req.user).slice(-60));
}

/* ---- 14. 模型返回为空要说清楚原因 ---- */
console.log(String.fromCharCode(10) + '=== 14. 空返回的诊断 ===');
{
  const { window } = boot({ withMonaco: true });
  const api = await ready(window);
  window.GM_xmlhttpRequest = (o) => {
    setTimeout(() => o.onload({ status: 200,
      responseText: JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] })
    }), 0);
  };
  // 抓住脚本写进控制台的日志
  const captured = [];
  const origWarn = window.console.error;
  window.console.error = (...a) => { captured.push(a.join(" ")); origWarn.apply(window.console, a); };
  const origLog = window.console.log;
  window.console.log = (...a) => { captured.push(a.join(" ")); origLog.apply(window.console, a); };
  const r = await api.code.run(true);
  const text = captured.join(String.fromCharCode(10));
  console.log("  结果: " + JSON.stringify(r));
  check("空返回不算成功", !(r && r.ok), JSON.stringify(r));
  check("日志提示了 max_tokens", text.includes("max_tokens"), text.slice(-120));
  check("日志带上了 finish_reason", text.includes("length"), text.slice(-120));
}

/* ---- 15. 逐行执行视图里的镜像编辑器不能被误认 ----
   真实页面（1-3 数据类型闸门）右侧同时有：
     · 上方 Monaco 编辑器（真，带 textarea.inputarea）
     · 下方「逐行执行视图」里一份只读镜像（也带 .view-line）
   若 findMonacoRoot 取到镜像，写入后的回读永远是旧内容。 */
console.log(String.fromCharCode(10) + '=== 15. 镜像编辑器不被误认 ===');
{
  const { window } = boot({});
  const api = await ready(window);
  const doc = window.document;

  const col = doc.querySelector(".code-column");
  col.innerHTML = "";

  // 先放「逐行执行视图」——故意放在前面，考验选择顺序
  const trace = doc.createElement("div");
  trace.className = "code-trace";
  const mirror = doc.createElement("div");
  mirror.className = "monaco-editor";
  const mirrorLines = doc.createElement("div");
  mirrorLines.className = "view-lines";
  ["public class Main {", "  // 上一次运行的结果", "}"].forEach((line) => {
    const d = doc.createElement("div");
    d.className = "view-line";
    d.textContent = line;
    mirrorLines.appendChild(d);
  });
  mirror.appendChild(mirrorLines);
  trace.appendChild(mirror);
  col.appendChild(trace);

  // 再放真编辑器（有 textarea）
  const real = doc.createElement("div");
  real.className = "monaco-editor";
  const ta = doc.createElement("textarea");
  ta.className = "inputarea";
  real.appendChild(ta);
  const realLines = doc.createElement("div");
  realLines.className = "view-lines";
  const initLine = doc.createElement("div");
  initLine.className = "view-line";
  initLine.textContent = "// 待填写";
  realLines.appendChild(initLine);
  real.appendChild(realLines);
  col.appendChild(real);

  const read = api.code.editorCode();
  console.log("  editorCode() 读回: 「" + read.slice(0, 40) + "」");
  check("回读的是真编辑器而不是镜像", !read.includes("上一次运行的结果"), read.slice(0, 60));

  // 写入后必须能被读回（旧实现会一直读到镜像）
  doc.execCommand = function (cmd, ui, val) {
    if (cmd !== "insertText") return false;
    realLines.innerHTML = "";
    String(val).split(String.fromCharCode(10)).forEach((line) => {
      const d = doc.createElement("div");
      d.className = "view-line";
      d.textContent = line || " ";
      realLines.appendChild(d);
    });
    return true;
  };
  const res = api.code.fill("int energy = 100;");
  console.log("  fill ok=" + res.ok + " got=「" + String(res.got).slice(0, 40) + "」");
  check("写入后能读回新内容", res.ok === true, JSON.stringify(res).slice(0, 120));
  check("读回的不是镜像里的旧代码", !String(res.got).includes("上一次运行"), String(res.got).slice(0, 60));
}

/* ---- 16. 平台限制（教学策略）要传给模型 ---- */
console.log(String.fromCharCode(10) + '=== 16. 平台限制传给模型 ===');
{
  const { window } = boot({ withMonaco: true });
  const api = await ready(window);
  const doc = window.document;

  const rules = doc.createElement("div");
  rules.className = "result-panel";
  rules.textContent = "需要修复 教学策略：当前课程只允许变量、判断、循环、数组、集合和关卡提供的教学 API。" +
    "请不要使用线程、文件、网络、反射、类加载、进程或其他系统能力。";
  doc.querySelector(".game-column").appendChild(rules);

  await api.code.run(true);
  const req = window.__requests[0] || {};
  console.log("  user 片段: " + String(req.user).slice(0, 100).replace(/\n/g, " "));
  check("请求里带了平台限制", String(req.user).includes("平台限制"), String(req.user).slice(0, 80));
  check("限制内容被完整带出", String(req.user).includes("当前课程只允许变量"), String(req.user).slice(0, 120));
  check("限制里提到禁止项", String(req.user).includes("反射") || String(req.user).includes("线程"), String(req.user).slice(0, 120));
}

/* ---- 17. 平台侧 598 要能被识别并说明白 ----
   自由练习不限次数，编程练习2 有提交配额。
   同一个脚本在自由练习能跑，在作业里会打出：
     Request failed with status code 598
   这是网关限流/超时，不是代码错误，必须讲清楚，
   否则用户会以为是 AI 写错了代码。 */
console.log(String.fromCharCode(10) + '=== 17. 识别平台的 598 限流 ===');
{
  const { window } = boot({});
  const api = await ready(window);
  const doc = window.document;

  // 命令行输出面板
  const panel = doc.createElement("section");
  panel.className = "panel result-panel";
  const title = doc.createElement("div");
  title.className = "panel-title";
  title.textContent = "命令行输出";
  const body = doc.createElement("div");
  body.className = "console-body";
  body.textContent = "Request failed with status code 598";
  panel.appendChild(title);
  panel.appendChild(body);
  doc.querySelector(".game-column").appendChild(panel);

  const captured = [];
  const origlog = window.console.log;
  window.console.log = (...a) => { captured.push(a.join(" ")); origlog.apply(window.console, a); };

  api.code.clickRun();
  await new Promise((r) => setTimeout(r, 1600));
  const text = captured.join(String.fromCharCode(10));
  console.log("  日志片段: " + text.split(String.fromCharCode(10)).filter((l) => /598|限流|配额/.test(l)).join(" / "));
  check("识别出 598", /598/.test(text), text.slice(-150));
  check("点明是网关拦代码而不是代码写错", /网关|防火墙/.test(text) && /不是代码写错/.test(text), text.slice(-200));
  check("说明手动运行也会一样", /手动/.test(text), text.slice(-200));
}

/* ---- 18. 正常输出不该被误报成失败 ---- */
console.log(String.fromCharCode(10) + '=== 18. 正常输出不误报 ===');
{
  const { window } = boot({});
  const api = await ready(window);
  const doc = window.document;

  const panel = doc.createElement("section");
  panel.className = "panel result-panel";
  const title = doc.createElement("div");
  title.className = "panel-title";
  title.textContent = "命令行输出";
  const body = doc.createElement("div");
  body.textContent = "执行步数: 5";
  panel.appendChild(title);
  panel.appendChild(body);
  doc.querySelector(".game-column").appendChild(panel);

  const captured = [];
  const origlog = window.console.log;
  window.console.log = (...a) => { captured.push(a.join(" ")); origlog.apply(window.console, a); };

  api.code.clickRun();
  await new Promise((r) => setTimeout(r, 1600));
  const text = captured.join(String.fromCharCode(10));
  console.log("  日志: " + text.split(String.fromCharCode(10)).filter((l) => /运行/.test(l)).join(" / "));
  check("正常输出不报错", !/598|限流/.test(text), text.slice(-120));
  check("打印了运行结果", /运行结果/.test(text), text.slice(-120));
}
console.log(String.fromCharCode(10) + '='.repeat(56));
if (fail) { console.log('测试失败：' + fail + ' 项未通过（通过 ' + pass + ' 项）'); process.exit(1); }
console.log('全部通过 ✔  共 ' + pass + ' 项');