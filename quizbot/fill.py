# -*- coding: utf-8 -*-
"""把答案写回页面 / 窗口。

两条路径：
  1. fill_browser()  —— 通过 CDP 直接操作 DOM，最准确（推荐）
  2. fill_window()   —— 纯视觉 + 键鼠模拟，用于无法注入 JS 的场景
"""
from __future__ import annotations

import json
import re
import time
from typing import Dict, List, Optional

from . import win32
from .cdp import CDPSession


def normalize_answer(answer) -> str:
    if answer is None:
        return ""
    if isinstance(answer, (list, tuple)):
        return "".join(str(x) for x in answer)
    return str(answer)


def answer_letters(answer) -> List[str]:
    """把模型给出的答案规范化成选项字母列表，例如 'A' / 'a、C' / ['A','C']。"""
    if answer is None:
        return []
    if isinstance(answer, (list, tuple, set)):
        letters: List[str] = []
        for item in answer:
            letters.extend(answer_letters(item))
        return letters
    text = str(answer).strip()
    if not text:
        return []
    found = re.findall(r"[A-Ha-h]", text)
    if not found:
        return []
    seen, out = set(), []
    for letter in found:
        up = letter.upper()
        if up not in seen:
            seen.add(up)
            out.append(up)
    return out


FILL_JS = r"""
(() => {
  const payload = __PAYLOAD__;
  const report = { applied: [], missed: [], details: [] };

  const fire = (el, types) => {
    types.forEach((type) => {
      let ev;
      if (type === 'click') {
        ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
      } else {
        ev = new Event(type, { bubbles: true, cancelable: true });
      }
      el.dispatchEvent(ev);
    });
  };

  const byHandle = (handle) => document.querySelector('[data-qb-input="' + handle + '"]');

  payload.forEach((item) => {
    try {
      if (item.kind === 'letter') {
        const targets = [];
        (item.handles || []).forEach((h) => {
          const el = byHandle(h);
          if (el) targets.push(el);
        });
        if (!targets.length) { report.missed.push(item.index); return; }
        let hit = 0;
        targets.forEach((el) => {
          const wantHit = (item.keys || []).indexOf(el.getAttribute('data-qb-key') || '') >= 0;
          if (wantHit && !el.checked) {
            if (el.click) { el.click(); } else { fire(el, ['click']); }
            if (!el.checked) { fire(el, ['click', 'change']); }
            hit++;
          } else if (!wantHit && el.checked && item.exclusive) {
            el.click();
          }
        });
        report.applied.push(item.index);
        report.details.push({ index: item.index, hit: hit });
        return;
      }

      if (item.kind === 'text') {
        const el = byHandle(item.handle);
        if (!el) { report.missed.push(item.index); return; }
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        el.focus();
        if (setter && setter.set) { setter.set.call(el, item.value || ''); }
        else { el.value = item.value || ''; }
        fire(el, ['input', 'change', 'blur', 'keyup']);
        report.applied.push(item.index);
        return;
      }

      if (item.kind === 'select') {
        const el = byHandle(item.handle);
        if (!el) { report.missed.push(item.index); return; }
        const wanted = String(item.value == null ? '' : item.value);
        let matched = null;
        for (let i = 0; i < el.options.length; i++) {
          const opt = el.options[i];
          if (opt.value === wanted || (opt.text || '').trim() === wanted) { matched = opt; break; }
        }
        if (!matched && item.key) {
          const k = String(item.key).toUpperCase();
          for (let i = 0; i < el.options.length; i++) {
            const opt = el.options[i];
            if ((opt.text || '').trim().toUpperCase().indexOf(k) === 0) { matched = opt; break; }
          }
        }
        if (!matched && wanted) {
          for (let i = 0; i < el.options.length; i++) {
            if ((el.options[i].text || '').indexOf(wanted) >= 0) { matched = el.options[i]; break; }
          }
        }
        if (!matched) { report.missed.push(item.index); return; }
        el.value = matched.value;
        fire(el, ['input', 'change']);
        report.applied.push(item.index);
        return;
      }
    } catch (err) {
      report.missed.push(item.index);
      report.details.push({ index: item.index, error: String(err) });
    }
  });

  return JSON.stringify(report);
})()
"""


def _tag_option_keys(session: CDPSession, questions: List[dict]) -> None:
    """把每题每个选项的「字母键」写到 data-qb-key，供填写脚本按字母选中。"""
    pairs = []
    for question in questions:
        if question.get("type") not in ("single", "multiple"):
            continue
        for option in question.get("options") or []:
            handle = option.get("handle")
            key = (option.get("key") or "").upper()
            if handle:
                pairs.append([handle, key])
    if not pairs:
        return
    script = (
        "(() => { const p = " + json.dumps(pairs, ensure_ascii=False) + ";"
        " p.forEach(function (pair) {"
        " var el = document.querySelector('[data-qb-input=\"' + pair[0] + '\"]');"
        " if (el) el.setAttribute('data-qb-key', pair[1]); }); return true; })()"
    )
    session.eval_js(script)


def build_payload(questions: List[dict], answers: Dict[int, dict],
                  include_low_confidence: bool = True,
                  min_confidence: float = 0.0):
    """把模型答案转成填写指令。返回 (payload, skipped)。"""
    payload: List[dict] = []
    skipped: List[dict] = []
    for question in questions:
        index = question["index"]
        entry = answers.get(index)
        if not entry:
            skipped.append({"index": index, "reason": "模型没有给出答案"})
            continue
        confidence = float(entry.get("confidence", 0.8))
        if not include_low_confidence and confidence < min_confidence:
            skipped.append({"index": index, "reason": "置信度 %.2f 低于阈值" % confidence,
                            "answer": entry.get("answer")})
            continue
        answer = entry.get("answer")
        kind = question.get("type")

        if kind in ("single", "multiple"):
            letters = answer_letters(answer)
            if not letters:
                skipped.append({"index": index, "reason": "答案里没有可识别的选项字母",
                                "answer": answer})
                continue
            handles = [o.get("handle") for o in question.get("options") or [] if o.get("handle")]
            payload.append({"kind": "letter", "index": index, "keys": letters,
                            "handles": handles, "exclusive": kind == "single"})
        elif kind == "select":
            payload.append({"kind": "select", "index": index, "handle": question.get("handle"),
                            "value": normalize_answer(answer),
                            "key": (answer_letters(answer) or [""])[0]})
        else:
            payload.append({"kind": "text", "index": index, "handle": question.get("handle"),
                            "value": normalize_answer(answer)})
    return payload, skipped


def fill_browser(session: CDPSession, questions: List[dict], answers: Dict[int, dict],
                 include_low_confidence: bool = True,
                 min_confidence: float = 0.0) -> dict:
    """通过 CDP 把答案填进页面，返回填写结果报告。"""
    _tag_option_keys(session, questions)
    payload, skipped = build_payload(questions, answers, include_low_confidence, min_confidence)
    if not payload:
        return {"applied": [], "missed": [], "skipped": skipped, "raw": None}
    script = FILL_JS.replace("__PAYLOAD__", json.dumps(payload, ensure_ascii=False))
    raw = session.eval_js(script)
    report = json.loads(raw) if isinstance(raw, str) else (raw or {})
    report["skipped"] = skipped
    report["requested"] = payload
    return report


# ------------------------------------------------------------------ 视觉填写
def fill_window(window, steps: List[dict], click_delay: float = 0.35,
                use_clipboard: bool = True, dry_run: bool = False,
                coordinate_space: str = "window") -> dict:
    """按视觉定位结果逐题点击 + 输入。

    steps 每项形如：
      {"index": 1, "kind": "click", "x": 320, "y": 480}
      {"index": 2, "kind": "text",  "x": 400, "y": 700, "value": "答案"}

    coordinate_space 为 "window" 时坐标相对窗口左上角（截图默认口径），
    为 "client" 时相对客户区左上角（capture.client_only = true 时的口径）。
    """
    applied, missed = [], []
    if not dry_run and not win32.focus_window(window.hwnd):
        raise RuntimeError("无法把目标窗口切到前台，请手动点击一次该窗口后重试")
    time.sleep(0.3)
    for step in steps:
        x, y = int(step.get("x", 0)), int(step.get("y", 0))
        if dry_run:
            applied.append(step.get("index"))
            continue
        relative_to_client = (coordinate_space == "client")
        if step.get("kind") == "click":
            win32.click_in_window(window, x, y, client_relative=relative_to_client)
            applied.append(step.get("index"))
        elif step.get("kind") == "text":
            win32.click_in_window(window, x, y, client_relative=relative_to_client)
            time.sleep(click_delay * 0.5)
            win32.send_hotkey("ctrl+a")
            value = normalize_answer(step.get("value"))
            if use_clipboard and len(value) > 12:
                win32.paste_text(value)
            else:
                win32.type_text(value)
            time.sleep(click_delay * 0.5)
            applied.append(step.get("index"))
        else:
            missed.append(step.get("index"))
        time.sleep(click_delay)
    return {"applied": applied, "missed": missed}
