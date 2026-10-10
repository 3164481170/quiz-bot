# -*- coding: utf-8 -*-
"""端到端自测：不需要任何 API Key。

流程：启动 headless Edge（开调试端口）→ 打开本地示例题库 →
用 mock provider 跑 识别 / 作答 / 填写 → 通过 CDP 读回页面断言答案已填入 → 关闭浏览器。
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

from quizbot import cdp as cdp_mod           # noqa: E402
from quizbot import fill as fill_mod         # noqa: E402
from quizbot import llm as llm_mod           # noqa: E402
import main as main_mod                      # noqa: E402

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def find_browser() -> str:
    for path in EDGE_CANDIDATES:
        if os.path.isfile(path):
            return path
    raise SystemExit("找不到 Edge/Chrome，无法运行端到端测试。")


class BrowserHandle:
    """一次成功的浏览器启动：进程 + 它使用的 profile 目录。"""

    def __init__(self, proc, profile: str):
        self.proc = proc
        self.profile = profile

    def close(self) -> None:
        _stop(self.proc)
        shutil.rmtree(self.profile, ignore_errors=True)


def launch_browser(browser: str, port: int, profile_base: str, page: str,
                   attempts: int = 6) -> "BrowserHandle":
    """启动 headless 浏览器并等调试端口就绪。

    受限环境（沙箱）下 Edge 有概率在 Mojo 命名管道创建上被拒绝（0x5）并立刻退出。
    关键点：**每次重试都必须用一个全新的 profile 目录**——崩溃留下的半初始化
    profile 会让后续所有启动继续崩溃（rmtree 常因残留句柄而静默失败）。
    """
    # 调试端口与 CDP 全在本机，明确禁用代理，避免系统代理把 127.0.0.1 也劫持走
    env = dict(os.environ)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"

    os.makedirs(profile_base, exist_ok=True)
    last_error = ""
    for attempt in range(1, attempts + 1):
        profile = os.path.join(profile_base, "try-%d" % attempt)
        shutil.rmtree(profile, ignore_errors=True)
        os.makedirs(profile, exist_ok=True)
        proc = subprocess.Popen([
            browser,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-crash-reporter",
            "--disable-breakpad",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-extensions",
            "--disable-sync",
            "--allow-file-access-from-files",
            "--remote-debugging-port=%d" % port,
            "--user-data-dir=%s" % profile,
            page,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
        threading.Thread(target=_drain, args=(proc,), daemon=True).start()
        if wait_for_port(port, timeout=15.0, verbose=False):
            print("浏览器已就绪（第 %d 次启动）" % attempt)
            return BrowserHandle(proc, profile)
        alive = proc.poll() is None
        _stop(proc)
        shutil.rmtree(profile, ignore_errors=True)
        if alive:
            last_error = ("浏览器进程存活但 /json/list 无响应 —— "
                          "通常是系统代理拦截了 127.0.0.1，请检查代理设置")
        else:
            last_error = _drain.last_error or "进程已退出，原因未捕获"
        if attempt < attempts:
            print("  第 %d 次启动失败，换新 profile 重试…（进程存活=%s）" % (attempt, alive))
    raise SystemExit("浏览器连续 %d 次启动失败：%s" % (attempts, last_error))


def _drain(proc: "subprocess.Popen") -> None:
    """持续读取 stderr（保留最后若干行，供失败诊断）。"""
    lines = []
    try:
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").strip()
            if line:
                lines.append(line)
                if len(lines) > 200:
                    del lines[:100]
    except Exception:
        pass
    finally:
        key = [l for l in lines if "FATAL" in l or "ERROR" in l]
        _drain.last_error = key[-1] if key else (lines[-1] if lines else "")


_drain.last_error = ""


def _stop(proc) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
    if proc.stderr:
        try:
            proc.stderr.close()
        except Exception:
            pass


def wait_for_port(port: int, timeout: float = 25.0, verbose: bool = True) -> bool:
    """等调试端口就绪，并且能稳定列出 target。"""
    deadline = time.time() + timeout
    stable = 0
    last_error = None
    attempts = 0
    while time.time() < deadline:
        attempts += 1
        try:
            targets = cdp_mod.list_targets(port=port, timeout=2.0)
            stable += 1
            if stable >= 2 and targets:
                return True
            last_error = "targets=%d" % len(targets)
        except Exception as exc:  # noqa: BLE001
            stable = 0
            last_error = str(exc)
        time.sleep(0.4)
    if verbose:
        print("  （端口 %d 等待超时，%d 次尝试，最后状态: %s）" % (port, attempts, last_error))
    return False


def check(label: str, ok: bool, detail: str = "") -> bool:
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", label, (" — " + detail) if detail else ""))
    return ok


def main() -> int:
    browser = find_browser()
    port = free_port()
    profile_base = os.path.join(ROOT, "logs", "e2e-profile-%d" % port)
    shutil.rmtree(profile_base, ignore_errors=True)
    page = "file:///" + os.path.join(HERE, "sample_quiz.html").replace("\\", "/")
    print("浏览器: %s" % browser)
    print("调试端口: %d" % port)
    print("测试页面: %s" % page)

    # --no-sandbox 在受限环境（如沙箱内）是必需的，否则 Edge 会因权限被拒而立刻退出
    handle = launch_browser(browser, port, profile_base, page)
    proc = handle.proc

    failures = 0
    try:
        # 明确挑出我们的测试页面，避免被浏览器自带的扩展后台页干扰
        targets = cdp_mod.list_targets(port=port)
        print("调试端口上的页面:")
        for target in targets:
            print("   - %s | %s" % (target["title"][:40], target["url"][:90]))

        config = {
            "mode": "cdp",
            "llm": {"provider": "mock", "vision": True},
            "cdp": {"host": "127.0.0.1", "port": port, "url_contains": "sample_quiz"},
            "capture": {"max_width": 1400},
            "low_confidence_action": "fill",
            "report": {"path": os.path.join(HERE, "e2e-report.json")},
        }

        # ---- 1. 提取题目 ----
        print("\n=== 1. 题目提取 ===")
        questions, context = main_mod.read_questions_cdp(config)
        print("识别到 %d 道题" % len(questions))
        for question in questions:
            print("   [%d] %-8s %s" % (question["index"], question["type"],
                                       question.get("stem", "")[:60]))
        failures += 0 if check("提取到 6 道题", len(questions) == 6, "实际 %d" % len(questions)) else 1
        types = [q["type"] for q in questions]
        failures += 0 if check("包含单选/多选/文本/下拉",
                               "single" in types and "multiple" in types
                               and "text" in types and "select" in types,
                               str(types)) else 1
        q1 = next((q for q in questions if "默认端口" in q.get("stem", "")), None)
        failures += 0 if check("题干解析正确（第 1 题）",
                               bool(q1) and "HTTP" in q1["stem"], (q1 or {}).get("stem", "")) else 1
        if q1:
            keys = [o["key"] for o in q1["options"]]
            texts = [o["text"] for o in q1["options"]]
            failures += 0 if check("选项解析正确（A~D）", keys == ["A", "B", "C", "D"], str(keys)) else 1
            failures += 0 if check("选项文字已剥离字母前缀",
                                   texts[0] == "21", repr(texts[0])) else 1

        # ---- 2. 模型作答 ----
        print("\n=== 2. 模型作答（mock provider）===")
        client = llm_mod.LLMClient(config["llm"])
        answers = client.answer_questions(questions, context)
        print("返回 %d 条答案" % len(answers))
        failures += 0 if check("每题都有答案", len(answers) == len(questions)) else 1

        # ---- 3. 填写 ----
        print("\n=== 3. 写入页面 ===")
        session = cdp_mod.connect(port=port, url_contains="sample_quiz")
        try:
            report = fill_mod.fill_browser(session, questions, answers)
            print("已填写: %s" % report.get("applied"))
            if report.get("missed"):
                print("未填写: %s" % report["missed"])
            failures += 0 if check("全部填写成功", not report.get("missed"),
                                   str(report.get("missed"))) else 1

            # ---- 4. 读回页面状态验证 ----
            print("\n=== 4. 读回页面状态验证 ===")
            state = json.loads(session.eval_js(
                "JSON.stringify({"
                " q1: (document.querySelector('input[name=q1]:checked')||{}).value || null,"
                " q2: Array.from(document.querySelectorAll('input[name=q2]:checked')).map(e=>e.value),"
                " q3: (document.querySelector('input[name=q3]:checked')||{}).value || null,"
                " q4: document.querySelector('textarea[name=q4]').value,"
                " q5: document.querySelector('select[name=q5]').value,"
                " q6: document.querySelector('input[name=q6]').value"
                "})"))
            print("页面状态: %s" % json.dumps(state, ensure_ascii=False))
            failures += 0 if check("第 1 题已选中 A", state["q1"] == "A", str(state["q1"])) else 1
            failures += 0 if check("第 2 题已勾选（多选）", len(state["q2"]) >= 1, str(state["q2"])) else 1
            failures += 0 if check("第 3 题已选中", state["q3"] in ("T", "F"), str(state["q3"])) else 1
            failures += 0 if check("第 4 题文本已填入", bool(state["q4"].strip()), state["q4"][:40]) else 1
            failures += 0 if check("第 5 题下拉已选择", bool(state["q5"]), state["q5"]) else 1
            failures += 0 if check("第 6 题填空已填入", bool(state["q6"].strip()), state["q6"][:40]) else 1
        finally:
            session.close()

        # ---- 5. 视觉模式的坐标规划（不真的点击）----
        print("\n=== 5. 视觉模式坐标规划 ===")
        from quizbot import capture as capture_mod
        from quizbot import extract_ai
        from PIL import Image
        fake_frame = capture_mod.Frame(image=Image.new("RGB", (1200, 900), "white"),
                                       window=None, taken_at=time.time(),
                                       width=1200, height=900, source="fake")
        fake_questions = [{
            "index": 1, "type": "single", "stem": "测试题",
            "options": [{"key": "A", "text": "甲", "bbox": [100, 200, 60, 30]},
                        {"key": "B", "text": "乙", "bbox": [100, 260, 60, 30]}],
        }]
        steps = extract_ai.plan_vision_clicks(fake_questions, {1: {"answer": "B"}}, fake_frame)
        ok = len(steps) == 1 and steps[0]["kind"] == "click"
        failures += 0 if check("视觉模式生成了点击步骤", ok, json.dumps(steps, ensure_ascii=False)) else 1
        if ok:
            failures += 0 if check("坐标换算正确（B 选项中心）",
                                   steps[0]["x"] == 130 and steps[0]["y"] == 275,
                                   "(%d, %d)" % (steps[0]["x"], steps[0]["y"])) else 1
    finally:
        handle.close()
        time.sleep(0.5)
        shutil.rmtree(profile_base, ignore_errors=True)

    print("\n" + "=" * 60)
    if failures:
        print("测试失败：%d 项未通过" % failures)
        return 1
    print("全部测试通过 ✔")
    return 0


if __name__ == "__main__":
    sys.exit(main())
