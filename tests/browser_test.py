# -*- coding: utf-8 -*-
"""真实浏览器验证：把油猴脚本注入 headless Edge，跑完整链路。

与 userscript.test.mjs（jsdom 单元测试）互补——这里用的是真实布局引擎和真实事件系统，
能验证「可见性判断」「受控输入」「多选/单选点击」在真实浏览器里确实成立。

    python tests/browser_test.py
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from quizbot import cdp as cdp_mod   # noqa: E402

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

PASS = 0
FAIL = 0


def check(label: str, ok: bool, detail: str = "") -> bool:
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  [PASS] %s" % label)
    else:
        FAIL += 1
        print("  [FAIL] %s%s" % (label, (" — " + str(detail)) if detail else ""))
    return ok


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def find_browser() -> str:
    for path in EDGE_CANDIDATES:
        if os.path.isfile(path):
            return path
    raise SystemExit("找不到 Edge/Chrome")


def launch(browser: str, port: int, base: str, url: str, attempts: int = 8):
    """启动浏览器。受限沙箱下 Mojo 命名管道偶发被拒，需每次换新 profile 重试。"""
    os.makedirs(base, exist_ok=True)
    for attempt in range(1, attempts + 1):
        profile = os.path.join(base, "try-%d" % attempt)
        shutil.rmtree(profile, ignore_errors=True)
        os.makedirs(profile, exist_ok=True)
        proc = subprocess.Popen([
            browser, "--headless=new", "--no-sandbox", "--disable-gpu",
            "--disable-crash-reporter", "--disable-breakpad",
            "--no-first-run", "--no-default-browser-check",
            "--disable-background-networking", "--disable-extensions",
            "--allow-file-access-from-files",
            "--remote-debugging-port=%d" % port,
            "--user-data-dir=%s" % profile,
            url,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 15
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            try:
                cdp_mod.list_targets(port=port, timeout=1.5)
                print("浏览器已就绪（第 %d 次启动）" % attempt)
                return proc, profile
            except Exception:
                time.sleep(0.4)
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=6)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
    raise SystemExit("浏览器连续 %d 次启动失败" % attempts)


# 桩代码：模拟 AI 接口返回，无需真实网络
STUB = """
window.__qbStub = true;
const mk = (prompt) => {
  const KEY = {'默认端口':'B','关系型数据库':['A','C'],'面向连接':'T',
               '幂等性':'幂等操作执行一次与多次影响相同。','编程语言':'Python','状态码 200':'请求成功'};
  const answers = [];
  const re = /^\\[(\\d+)\\]\\s*\\(([^)]*)\\)\\s*(.*)$/gm;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    let a = null;
    for (const k in KEY) { if (m[3].includes(k)) { a = KEY[k]; break; } }
    answers.push({index: Number(m[1]), answer: a, confidence: 0.9, reason: 'stub'});
  }
  return JSON.stringify({answers});
};
window.fetch = (url, opts) => {
  const body = JSON.parse(opts.body);
  const prompt = body.messages[body.messages.length - 1].content;
  return Promise.resolve({ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify({choices:[{message:{content: mk(prompt)}}]}))});
};
"""


def main() -> int:
    browser = find_browser()
    port = free_port()
    base = os.path.join(ROOT, "logs", "browser-test-%d" % port)
    page_url = "file:///" + os.path.join(HERE, "sample_quiz.html").replace("\\", "/")
    print("浏览器: %s" % browser)
    print("调试端口: %d" % port)
    print("测试页面: %s" % page_url)

    proc, profile = launch(browser, port, base, page_url)
    try:
        session = cdp_mod.connect(port=port, url_contains="sample_quiz")
        try:
            session.call("Runtime.enable")
            # 等页面加载完成
            for _ in range(60):
                state = session.eval_js("document.readyState")
                if state == "complete":
                    break
                time.sleep(0.2)
            check("页面加载完成", session.eval_js("document.readyState") == "complete")
            check("页面里有 6 个题目区块",
                  session.eval_js("document.querySelectorAll('.question').length") == 6)

            # 预设配置（控制台模式下存 localStorage）+ 注入 API 桩
            session.eval_js(STUB)
            session.eval_js(
                "localStorage.setItem('quizbot.baseUrl', %s);"
                "localStorage.setItem('quizbot.apiKey', %s);"
                "localStorage.setItem('quizbot.model', %s);"
                "localStorage.setItem('quizbot.provider', %s); true"
                % (json.dumps('"https://api.test/v1"'), json.dumps('"k"'),
                   json.dumps('"m"'), json.dumps('"openai"')))

            code = open(os.path.join(ROOT, "userscript", "quizbot.user.js"),
                        "r", encoding="utf-8").read()
            session.eval_js("window.__qbErr=[];"
                            "window.addEventListener('error', e => window.__qbErr.push(String(e.message))); true")
            session.eval_js(code)
            time.sleep(0.6)
            check("脚本在真实浏览器里注入成功",
                  session.eval_js("!!window.quizbot"),
                  session.eval_js("JSON.stringify(window.__qbErr)"))

            # ---- 读取题目 ----
            print("\n=== 读取题目（真实浏览器）===")
            questions = json.loads(session.eval_js(
                "JSON.stringify(window.quizbot.read())"))
            print("识别到 %d 道题" % len(questions))
            for q in questions:
                print("  [%d] %-8s %s" % (q["index"], q["type"], str(q["stem"]).replace("\n", " ")[:60]))
            check("识别到 6 道题（未把脚本自身面板算进去）", len(questions) == 6,
                  "实际 %d" % len(questions))

            # ---- 完整流程 ----
            print("\n=== AI 作答并填写 ===")
            result = json.loads(session.eval_js("window.quizbot.run().then(r => JSON.stringify(r))",
                                                await_promise=True))
            check("全部 6 题填写成功", result and result.get("okCount") == 6,
                  json.dumps(result, ensure_ascii=False))

            # ---- 读回真实 DOM ----
            print("\n=== 读回真实 DOM 状态 ===")
            state = json.loads(session.eval_js(
                "JSON.stringify({"
                " q1: (document.querySelector('input[name=q1]:checked')||{}).value || null,"
                " q2: Array.from(document.querySelectorAll('input[name=q2]:checked')).map(e=>e.value),"
                " q3: (document.querySelector('input[name=q3]:checked')||{}).value || null,"
                " q4: document.querySelector('textarea[name=q4]').value,"
                " q5: document.querySelector('select[name=q5]').value,"
                " q6: document.querySelector('input[name=q6]').value})"))
            print("  " + json.dumps(state, ensure_ascii=False)[:220])
            check("单选选中 B", state["q1"] == "B", state["q1"])
            check("多选勾选 A 和 C", sorted(state["q2"]) == ["A", "C"], state["q2"])
            check("判断题选中 T", state["q3"] == "T", state["q3"])
            check("textarea 已填入", "幂等" in state["q4"], state["q4"][:40])
            check("下拉框选中 Python", state["q5"] == "py", state["q5"])
            check("填空已填入", "请求成功" in state["q6"], state["q6"])

            # ---- 面板确实渲染在页面上 ----
            print("\n=== 界面 ===")
            check("面板已渲染到页面",
                  session.eval_js("!!document.querySelector('[data-quizbot-ui]')"))
        finally:
            session.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(0.5)
        shutil.rmtree(base, ignore_errors=True)

    print("\n" + "=" * 56)
    if FAIL:
        print("测试失败：%d 项未通过（通过 %d 项）" % (FAIL, PASS))
        return 1
    print("全部通过 ✔  共 %d 项" % PASS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
