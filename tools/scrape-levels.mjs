/**
 * 抓取 aicode 编程练习的全部关卡（题目 / 骨架 / API / 限制）
 * 产出 levels.json，供 tools/build-answers.mjs 生成内置答案。
 *
 * 用法：
 *   node tools/scrape-levels.mjs --launch      # 自己拉一个浏览器（独立配置目录）
 *   node tools/scrape-levels.mjs --cdp 9222    # 接管已有调试端口的浏览器
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BASE = process.env.AICODE_BASE || "https://aicode.neusoft.edu.cn";
const OUT = process.env.OUT_FILE || path.join(ROOT, "levels.json");

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const hasFlag = (n) => argv.includes(n);
const CDP_PORT = argOf("--cdp") || process.env.CDP_PORT || "9222";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function connect(port) {
  let targets;
  try {
    targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  } catch (err) {
    throw new Error(
      `连不上调试端口 ${port}。${err.message}\n` +
      "Edge 已经在跑时，新加的 --remote-debugging-port 会被忽略。\n" +
      "先完全退出 Edge，或用 --launch 让本脚本自己起一个。\n" +
      `  node tools/scrape-levels.mjs --launch`
    );
  }
  const pages = targets.filter((t) => t.type === "page");
  const page = pages.find((t) => /aicode/i.test(t.url || "")) || pages[0];
  if (!page) throw new Error("浏览器里没有打开的页面");
  console.log(`接管标签页: ${page.url}`);
  return attach(page.webSocketDebuggerUrl);
}

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "页面脚本出错");
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

/* ---------------- 页面内抓取逻辑 ---------------- */

const HELPERS = String.raw`
window.__qb = {
  clean(s) {
    return String(s || "").replace(/[ \t\u00a0]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  },
  // 题目列表：作业视图下是 .assignment-item-button
  items() {
    return [...document.querySelectorAll(".assignment-item-button")].map((el, i) => ({
      index: i,
      title: this.clean(el.querySelector(".assignment-item-copy")?.textContent || el.textContent),
      active: el.classList.contains("active"),
    }));
  },
  clickItem(i) {
    const el = [...document.querySelectorAll(".assignment-item-button")][i];
    if (!el) return false;
    el.click();
    return true;
  },
  // 切题后编辑器是异步换的，必须等它真的变了再读
  waitEditorChange(prev, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const now = this.code();
        if (now && now !== prev) return resolve(now);
        if (Date.now() - start > (timeoutMs || 8000)) return resolve(now);
        setTimeout(tick, 250);
      };
      setTimeout(tick, 250);
    });
  },
  goal() {
    const p = document.querySelector(".story-panel");
    if (!p) return "";
    return this.clean(p.textContent)
      .replace(/^任务目标\s*/, "")
      .replace(/^💡\s*Tips\s*/i, "");
  },
  // 可用 API / 必用语法
  api() {
    const list = [...document.querySelectorAll(".api-list li, .api-list > *")];
    if (list.length) return list.map((e) => this.clean(e.textContent)).join("\n");
    const node = [...document.querySelectorAll(".panel-title")]
      .find((e) => /可用\s*API|必用语法/.test(e.textContent));
    const box = node && node.parentElement;
    return box ? this.clean(box.textContent).replace(/^可用\s*API[^\n]*\n?/, "") : "";
  },
  // 编辑器真实内容：优先 monaco 模型，其次限定 .monaco-editor 内的 view-line
  code() {
    try {
      const eds = window.monaco?.editor?.getEditors?.() || [];
      if (eds.length) return String(eds[0].getValue());
    } catch (e) {}
    const roots = [...document.querySelectorAll(".monaco-editor")];
    const real = roots.find((r) => r.querySelector("textarea.inputarea, textarea")) || roots[0];
    if (!real) return "";
    return [...real.querySelectorAll(".view-line")]
      .map((l) => l.textContent.replace(/\u00a0/g, " "))
      .join("\n");
  },
  // 系统锁定前后缀（不进编辑器，属于外壳）
  lockInfo() {
    const pre = document.querySelector(".locked-code-prefix");
    const suf = document.querySelector(".locked-code-suffix");
    return {
      prefix: pre ? this.clean(pre.textContent) : "",
      suffix: suf ? this.clean(suf.textContent) : "",
    };
  },
  runButton() {
    const b = [...document.querySelectorAll("button")].find((e) => /启动运行|运行/.test(this.clean(e.textContent)));
    return !!b;
  },
};
"ok"`;

async function main() {
  if (hasFlag("--launch")) {
    const { spawn } = await import("node:child_process");
    const os = await import("node:os");
    const profile = path.join(os.tmpdir(), "qbot-scrape-profile");
    const cands = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    const exe = cands.find((p) => fs.existsSync(p));
    if (!exe) throw new Error("找不到 Edge");
    console.log(`启动浏览器（独立配置，不影响日常使用）`);
    spawn(exe, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", `${BASE}/student`],
      { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 40; i++) {
      try { await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); break; } catch { await sleep(600); }
    }
  }

  const cdp = await connect(CDP_PORT);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // 确保在 /student
  const url = await cdp.evaluate("location.href");
  if (!/\/student/.test(url)) {
    await cdp.send("Page.navigate", { url: `${BASE}/student` });
    await sleep(5000);
  }
  if (/login/i.test(await cdp.evaluate("location.href"))) {
    console.log("页面停在登录页：请在浏览器里登录后重跑本命令");
    cdp.close();
    process.exit(2);
  }

  await cdp.evaluate(HELPERS);
  let items = await cdp.evaluate("window.__qb.items()");
  if (!items.length) {
    console.log("没找到题目列表，等页面渲染…");
    await sleep(4000);
    await cdp.evaluate(HELPERS);
    items = await cdp.evaluate("window.__qb.items()");
  }
  console.log(`发现 ${items.length} 道题`);
  if (!items.length) {
    console.log("可用标题:", await cdp.evaluate("document.title"));
    cdp.close();
    process.exit(1);
  }

  const out = [];
  let prevCode = "";
  for (const it of items) {
    process.stdout.write(`[${it.index + 1}/${items.length}] ${it.title.slice(0, 14)} … `);
    await cdp.evaluate(`window.__qb.clickItem(${it.index})`);
    // 等编辑器内容真正变化，而不是死等固定时间
    const settled = await cdp.evaluate(
      `window.__qb.waitEditorChange(${JSON.stringify(prevCode)}, 8000)`
    );
    if (settled === prevCode) {
      // 内容没变：可能是首次点击或题目骨架确实相同，再等一下兜底
      await sleep(1200);
    }
    await cdp.evaluate(HELPERS);
    const goal = await cdp.evaluate("window.__qb.goal()");
    const api = await cdp.evaluate("window.__qb.api()");
    const code = await cdp.evaluate("window.__qb.code()");
    const lock = await cdp.evaluate("window.__qb.lockInfo()");
    prevCode = code;
    const same = out.length && out[out.length - 1].skeleton === code;
    console.log(`${code.split("\n").length} 行${same ? "（与上一题相同，可疑）" : ""}`);
    out.push({
      index: it.index + 1,
      title: it.title,
      goal,
      api,
      prefix: lock.prefix,
      suffix: lock.suffix,
      skeleton: code,
    });
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  console.log(`\n已写出 ${out.length} 题 -> ${OUT}`);
  cdp.close();
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
