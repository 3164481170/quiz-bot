# -*- coding: utf-8 -*-
"""视觉模式：让多模态模型直接从截图里读题，并把答案换算成点击坐标。"""
from __future__ import annotations

import json
import re
from typing import Dict, List, Optional

from .fill import answer_letters, normalize_answer

VISION_PROMPT = """这是一张电脑屏幕截图，上面是一个答题页面。请你把页面上的题目完整识别出来。

要求：
1. 按页面从上到下的顺序输出所有题目（选项、填空框都算题目的一部分）。
2. type 取值：single=单选题，multiple=多选题，text=填空/简答题，bool=判断题。
3. options 里给出每个选项的字母和文字；判断题 options 用 [{"key":"对","text":"对"},{"key":"错","text":"错"}]。
4. bbox 是该元素在图片中的像素位置，格式 [x, y, 宽, 高]，原点在图片左上角。
   - 单选题/多选题：bbox 填「选项文字（或它前面的圆形/方形选择框）」的位置。
   - 填空题：bbox 填「输入框」的位置。
5. 不要遗漏题目，也不要编造看不见的题目。

只输出 JSON，不要任何解释文字：
{"questions":[{"index":1,"type":"single","stem":"题干文字","bbox":[x,y,w,h],
"options":[{"key":"A","text":"选项文字","bbox":[x,y,w,h]}]}]}"""


def _ensure_client_vision(client) -> None:
    if getattr(client, "provider", "openai") == "mock":
        return


def extract_from_image(client, frame) -> List[dict]:
    """调用多模态模型识别截图里的题目。"""
    image_b64 = frame.base64_png()
    prompt = VISION_PROMPT
    size_hint = "图片尺寸: %d x %d 像素。" % (frame.width, frame.height)
    raw = client.chat_with_image(prompt + "\n" + size_hint, image_b64, mime="image/png")
    from .llm import parse_json_loose
    data = parse_json_loose(raw)
    questions = data.get("questions") if isinstance(data, dict) else data
    if not isinstance(questions, list):
        raise ValueError("视觉识别返回结构不对: %s" % str(data)[:300])
    out: List[dict] = []
    for i, item in enumerate(questions):
        if not isinstance(item, dict):
            continue
        qtype = str(item.get("type") or "single").lower()
        if qtype not in ("single", "multiple", "text", "bool", "select"):
            qtype = "single"
        options = []
        for j, opt in enumerate(item.get("options") or []):
            if not isinstance(opt, dict):
                continue
            options.append({
                "index": j,
                "key": str(opt.get("key") or chr(65 + j)).upper(),
                "text": str(opt.get("text") or ""),
                "bbox": _clean_bbox(opt.get("bbox")),
            })
        out.append({
            "index": int(item.get("index") or (i + 1)),
            "type": qtype,
            "stem": str(item.get("stem") or "").strip(),
            "options": options,
            "bbox": _clean_bbox(item.get("bbox")),
        })
    return out


def _clean_bbox(value) -> Optional[List[float]]:
    if not isinstance(value, (list, tuple)) or len(value) < 4:
        return None
    try:
        box = [float(value[0]), float(value[1]), float(value[2]), float(value[3])]
    except (TypeError, ValueError):
        return None
    if box[2] <= 0 or box[3] <= 0:
        return None
    return box


def bbox_center(bbox) -> Optional[tuple]:
    if not bbox:
        return None
    return (bbox[0] + bbox[2] / 2.0, bbox[1] + bbox[3] / 2.0)


def plan_vision_clicks(questions: List[dict], answers: Dict[int, dict], frame,
                       config: Optional[dict] = None) -> List[dict]:
    """把模型答案变成「点击/输入」步骤，坐标已换算成窗口坐标。"""
    config = config or {}
    click_delay = float((config.get("vision") or {}).get("click_delay", 0.35))
    steps: List[dict] = []
    for question in questions:
        entry = answers.get(question["index"])
        if not entry:
            continue
        answer = entry.get("answer")
        qtype = question.get("type")

        if qtype in ("single", "multiple", "bool"):
            letters = [x.upper() for x in answer_letters(answer)]
            if qtype == "bool" and not letters:
                text = normalize_answer(answer)
                letters = ["对"] if text.strip() in ("对", "正确", "true", "T", "√") else ["错"]
            for option in question.get("options") or []:
                key = str(option.get("key") or "").upper()
                bbox = option.get("bbox")
                if not bbox:
                    continue
                if key in letters or key[:1] in letters or key in [l[:1] for l in letters]:
                    point = bbox_center(bbox)
                    if not point:
                        continue
                    wx, wy = frame.to_window_point(point[0], point[1])
                    steps.append({"index": question["index"], "kind": "click",
                                  "x": int(round(wx)), "y": int(round(wy)),
                                  "delay": click_delay})
            continue

        bbox = question.get("bbox")
        if not bbox:
            # 没有输入框位置就退回题干位置
            bbox = question.get("options")[0].get("bbox") if question.get("options") else None
        if not bbox:
            continue
        point = bbox_center(bbox)
        if not point:
            continue
        wx, wy = frame.to_window_point(point[0], point[1])
        steps.append({"index": question["index"], "kind": "text",
                      "x": int(round(wx)), "y": int(round(wy)),
                      "value": normalize_answer(answer), "delay": click_delay})
    return steps
