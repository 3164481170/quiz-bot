# -*- coding: utf-8 -*-
"""quiz-bot 主程序。

用法：
    python main.py --list-windows          # 列出可见窗口，便于填写配置
    python main.py --list-targets          # 列出调试端口上的页面
    python main.py --probe                 # 只识别题目并打印
    python main.py --dry-run               # 识别 + 让模型作答，但不写入页面
    python main.py                         # 识别 + 作答 + 自动填写

两种工作模式（config.json 里的 "mode"）：
    "cdp"    —— 通过 Chrome DevTools Protocol 读取真实 DOM 并填写（最准，推荐）
    "vision" —— 截屏 + 多模态模型识别 + 键鼠模拟（适用于无法开调试端口的窗口）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from quizbot import capture as capture_mod
from quizbot import cdp as cdp_mod
from quizbot import extract_ai
from quizbot import fill as fill_mod
from quizbot import llm as llm_mod
from quizbot import win32

HERE = os.path.dirname(os.path.abspath(__file__))


def load_config(path: Optional[str]) -> dict:
    candidates = [path] if path else []
    candidates += [os.path.join(HERE, "config.json"),
                   os.path.join(os.getcwd(), "config.json")]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            with open(candidate, "r", encoding="utf-8") as handle:
                text = handle.read()
            try:
                return json.loads(text)
            except ValueError as exc:
                raise SystemExit("配置文件 %s 不是合法 JSON: %s" % (candidate, exc))
    raise SystemExit("找不到配置文件。请把 config.example.json 复制为 config.json 后再运行。")


def banner(title: str) -> None:
    print("\n" + "=" * 68)
    print("  " + title)
    print("=" * 68)


def print_questions(questions: List[dict], context: str = "") -> None:
    if context:
        print("页面: %s" % context.replace("\n", " | ")[:160])
    for question in questions:
        kind = {"single": "单选", "multiple": "多选", "text": "填空/简答",
                "select": "下拉", "bool": "判断"}.get(question.get("type"), "?")
        print("\n[%d] (%s) %s" % (question["index"], kind, (question.get("stem") or "")[:300]))
        for option in question.get("options") or []:
            print("      %s. %s" % (option.get("key"), (option.get("text") or "")[:160]))
    if not questions:
        print("  （没有识别到题目）")


def read_questions_cdp(config: dict, session=None):
    """用 CDP 读取页面结构并解析出题目清单。返回 (questions, context)。"""
    cdp_cfg = config.get("cdp") or {}
    owns = session is None
    if owns:
        session = cdp_mod.connect(
            title_contains=cdp_cfg.get("title_contains"),
            url_contains=cdp_cfg.get("url_contains"),
            index=int(cdp_cfg.get("index", 0)),
            host=cdp_cfg.get("host", "127.0.0.1"),
            port=int(cdp_cfg.get("port", 9222)))
    try:
        script_path = os.path.join(HERE, "quizbot", "extract.js")
        with open(script_path, "r", encoding="utf-8") as handle:
            script = handle.read()
        raw = session.eval_js(script)
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
        questions = data.get("questions") or []
        context = ((data.get("title") or "") + "\n" + (data.get("url") or "")).strip()
        for warning in data.get("warnings") or []:
            print("  [警告] %s" % warning)
        return questions, context
    finally:
        if owns and session is not None:
            session.close()


# ------------------------------------------------------------------ 子命令
def cmd_list_windows(config: dict) -> int:
    banner("当前可见窗口")
    windows = win32.list_windows(only_visible=True, only_titled=True, min_size=120)
    windows.sort(key=lambda w: w.width * w.height, reverse=True)
    if not windows:
        print("没有枚举到可见窗口（可能被沙箱限制）。")
    for win in windows:
        print("  pid=%-8d hwnd=%-10d %5dx%-5d %s" %
              (win.pid, win.hwnd, win.width, win.height, win.title[:80]))
        print("             class=%s" % win.class_name)
    print("\n提示：把目标窗口标题关键字填到 config.json 的 capture.title_contains，或直接填 capture.pid。")
    return 0


def cmd_list_targets(config: dict) -> int:
    cdp_cfg = config.get("cdp") or {}
    host = cdp_cfg.get("host", "127.0.0.1")
    port = int(cdp_cfg.get("port", 9222))
    banner("调试端口 %s:%d 上的页面" % (host, port))
    try:
        targets = cdp_mod.list_targets(host=host, port=port)
    except Exception as exc:  # noqa: BLE001
        print("连接失败: %s" % exc)
        print("\n请先完全退出浏览器，再用调试端口重新启动，例如：")
        print('  msedge.exe --remote-debugging-port=%d --user-data-dir="C:\\edge-debug"' % port)
        return 1
    for target in targets:
        print("  %s" % (target["title"] or "")[:80])
        print("      %s" % (target["url"] or "")[:140])
    if not targets:
        print("  （没有页面）")
    return 0


def cmd_probe(config: dict) -> int:
    mode = (config.get("mode") or "cdp").lower()
    if mode == "cdp":
        questions, context = read_questions_cdp(config)
        banner("识别到 %d 道题（CDP 模式）" % len(questions))
    else:
        questions, context = read_questions_vision(config)
        banner("识别到 %d 道题（视觉模式）" % len(questions))
    print_questions(questions, context)
    return 0


def read_questions_vision(config: dict):
    capturer = capture_mod.Capturer(config)
    frame = capturer.grab()
    banner("截图 %dx%d（来源: %s）" % (frame.width, frame.height, frame.source))
    save_debug_shot(config, frame)
    client = llm_mod.LLMClient(config.get("llm") or {})
    questions = extract_ai.extract_from_image(client, frame)
    return questions, "视觉模式截图 %dx%d" % (frame.width, frame.height)


def save_debug_shot(config: dict, frame) -> None:
    debug_dir = (config.get("capture") or {}).get("debug_dir")
    if not debug_dir:
        return
    if not os.path.isabs(debug_dir):
        debug_dir = os.path.join(HERE, debug_dir)
    os.makedirs(debug_dir, exist_ok=True)
    path = os.path.join(debug_dir, "shot-%s.png" % time.strftime("%Y%m%d-%H%M%S"))
    frame.save(path)
    print("截图已保存: %s" % path)


def cmd_run(config: dict, dry_run: bool = False, min_confidence: float = 0.0) -> int:
    mode = (config.get("mode") or "cdp").lower()
    client = llm_mod.LLMClient(config.get("llm") or {})
    instructions = config.get("instructions") or ""
    low_conf_action = (config.get("low_confidence_action") or "fill").lower()
    if mode == "cdp":
        return run_cdp(config, client, instructions, dry_run, min_confidence, low_conf_action)
    return run_vision(config, client, instructions, dry_run, min_confidence)


def run_cdp(config, client, instructions, dry_run, min_confidence, low_conf_action) -> int:
    cdp_cfg = config.get("cdp") or {}
    session = cdp_mod.connect(
        title_contains=cdp_cfg.get("title_contains"),
        url_contains=cdp_cfg.get("url_contains"),
        index=int(cdp_cfg.get("index", 0)),
        host=cdp_cfg.get("host", "127.0.0.1"),
        port=int(cdp_cfg.get("port", 9222)))
    try:
        banner("目标页面: %s" % (session.page_title() or "(无标题)"))
        print("URL: %s" % session.page_url())

        questions, context = read_questions_cdp(config, session)
        print("\n识别到 %d 道题" % len(questions))
        print_questions(questions)
        if not questions:
            print("\n没有识别到题目。可先运行 --probe，或改用视觉模式。")
            return 2

        banner("请求模型作答中…")
        started = time.time()
        answers = client.answer_questions(questions, context, instructions)
        print("模型返回 %d 条答案，耗时 %.1fs" % (len(answers), time.time() - started))
        for index in sorted(answers):
            entry = answers[index]
            print("  [%s] -> %s  (置信度 %.2f) %s" %
                  (index, entry.get("answer"), entry.get("confidence", 0),
                   (entry.get("reason") or "")[:80]))

        if dry_run:
            banner("dry-run：不写入页面")
            save_report(config, questions, answers, {"dry_run": True})
            return 0

        banner("填写答案")
        report = fill_mod.fill_browser(session, questions, answers,
                                       include_low_confidence=(low_conf_action == "fill"),
                                       min_confidence=min_confidence)
        print("  已填写 %d 题: %s" % (len(report.get("applied") or []), report.get("applied")))
        if report.get("missed"):
            print("  未填写 %d 题: %s" % (len(report["missed"]), report["missed"]))
        for item in report.get("skipped") or []:
            print("  跳过 [%s]: %s" % (item.get("index"), item.get("reason")))
        save_report(config, questions, answers, report)

        if (config.get("auto_submit") or {}).get("enabled") and not dry_run:
            return maybe_submit(session, config)
        return 0
    finally:
        session.close()


def run_vision(config, client, instructions, dry_run, min_confidence) -> int:
    capturer = capture_mod.Capturer(config)
    frame = capturer.grab()
    banner("截图 %dx%d（来源: %s）" % (frame.width, frame.height, frame.source))
    save_debug_shot(config, frame)

    llm_cfg = config.get("llm") or {}
    if (llm_cfg.get("provider") or "").lower() != "mock" and not llm_cfg.get("vision"):
        print("\n[提示] 视觉模式需要多模态模型。当前 provider=%s model=%s" %
              (client.provider, client.model))
        print("        请在 config.json 里把 llm.vision 设为 true 并选用支持图片的模型，")
        print("        或改用 mode = \"cdp\"。")
        return 3

    questions = extract_ai.extract_from_image(client, frame)
    print("\n识别到 %d 道题" % len(questions))
    print_questions(questions)
    if not questions:
        return 2

    banner("请求模型作答中…")
    answers = client.answer_questions(questions, "屏幕截图答题", instructions)
    for index in sorted(answers):
        entry = answers[index]
        print("  [%s] -> %s  (置信度 %.2f)" %
              (index, entry.get("answer"), entry.get("confidence", 0)))

    if dry_run:
        banner("dry-run：不写入窗口")
        save_report(config, questions, answers, {"dry_run": True})
        return 0

    steps = extract_ai.plan_vision_clicks(questions, answers, frame, config)
    window = capturer.target_window()
    if window is None:
        print("视觉填写需要在 config.json 的 capture 里指定目标窗口。")
        return 4
    report = fill_mod.fill_window(window, steps)
    save_report(config, questions, answers, report)
    print("  已执行 %d 步，跳过 %d 步" % (len(report["applied"]), len(report["missed"])))
    return 0


def maybe_submit(session, config) -> int:
    submit_cfg = config.get("auto_submit") or {}
    selector = submit_cfg.get("selector")
    text = submit_cfg.get("text")
    confirm = submit_cfg.get("confirm_text")
    banner("自动提交")
    script = ("(() => { const s = " + json.dumps(selector) + "; const t = " + json.dumps(text) + ";"
              " const visible = (el) => { const r = el.getBoundingClientRect();"
              " return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };"
              " let target = null;"
              " if (s) { target = document.querySelector(s); }"
              " if (!target && t) {"
              "   const cands = Array.from(document.querySelectorAll('button,a,input[type=submit],div[role=button],span'));"
              "   target = cands.find(el => visible(el) && (el.innerText || el.value || '').trim().indexOf(t) >= 0) || null; }"
              " if (!target) return JSON.stringify({ok:false, reason:'no-button'});"
              " target.click();"
              " return JSON.stringify({ok:true, text:(target.innerText||target.value||'').trim().slice(0,40)}); })()")
    try:
        raw = session.eval_js(script)
        result = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception as exc:  # noqa: BLE001
        print("  提交失败: %s" % exc)
        return 5
    if not result.get("ok"):
        print("  没有找到提交按钮（%s），请手动提交。" % result.get("reason"))
        return 5
    print("  已点击提交按钮: %s" % result.get("text"))
    if confirm:
        time.sleep(1.0)
        try:
            session.eval_js(
                "(() => { const t = " + json.dumps(confirm) + ";"
                " const c = Array.from(document.querySelectorAll('button,a,div[role=button]'))"
                ".find(el => (el.innerText||'').trim().indexOf(t) >= 0);"
                " if (c) { c.click(); return true; } return false; })()")
        except Exception:  # noqa: BLE001
            pass
    return 0


def save_report(config: dict, questions, answers, report) -> None:
    path = (config.get("report") or {}).get("path")
    if not path:
        return
    if not os.path.isabs(path):
        path = os.path.join(HERE, path)
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        payload = {"time": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "questions": questions, "answers": answers, "report": report}
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        print("\n报告已写入: %s" % path)
    except Exception as exc:  # noqa: BLE001
        print("写报告失败: %s" % exc)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="基于网页/窗口的 AI 答题程序")
    parser.add_argument("--config", help="配置文件路径（默认 ./config.json）")
    parser.add_argument("--list-windows", action="store_true", help="列出可见窗口，便于填写配置")
    parser.add_argument("--list-targets", action="store_true", help="列出调试端口上的页面")
    parser.add_argument("--probe", action="store_true", help="只识别题目并打印，不调用模型、不填写")
    parser.add_argument("--dry-run", action="store_true", help="识别 + 作答，但不写入页面")
    parser.add_argument("--min-confidence", type=float, default=0.0,
                        help="低于该置信度的题不自动填写（配合 low_confidence_action=skip）")
    parser.add_argument("--mode", choices=["cdp", "vision"], help="覆盖配置里的 mode")
    args = parser.parse_args(argv)

    win32.enable_dpi_awareness()
    config = load_config(args.config)
    if args.mode:
        config["mode"] = args.mode

    try:
        if args.list_windows:
            return cmd_list_windows(config)
        if args.list_targets:
            return cmd_list_targets(config)
        if args.probe:
            return cmd_probe(config)
        return cmd_run(config, dry_run=args.dry_run, min_confidence=args.min_confidence)
    except KeyboardInterrupt:
        print("\n已取消。")
        return 130
    except Exception as exc:  # noqa: BLE001
        print("\n[错误] %s: %s" % (type(exc).__name__, exc))
        if os.environ.get("QUIZBOT_DEBUG"):
            import traceback
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
