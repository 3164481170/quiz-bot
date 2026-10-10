# -*- coding: utf-8 -*-
"""LLM 客户端：OpenAI 兼容接口 / Anthropic 兼容接口 + 离线 Mock。

config.json 的 "llm" 段示例（API 由你自己接入，支持任意 OpenAI 兼容服务）：

    "llm": {
      "provider": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-...",
      "model": "gpt-4o-mini",
      "temperature": 0.2,
      "max_tokens": 2048,
      "timeout": 120,
      "extra_headers": {},
      "extra_body": {}
    }

api_key 也可以留空，改用环境变量 QUIZBOT_API_KEY 或 OPENAI_API_KEY。
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, List, Optional

import requests

TICK = chr(96)          # 反引号
FENCE = TICK * 3

SYSTEM_PROMPT = """你是一个严谨的答题助手。你会收到一个网页上的题目清单，需要逐题给出答案。

要求：
1. 严格按顺序作答，每题都必须给出答案，不要跳过。
2. 单选题 answer 填单个选项字母（如 "A"）；多选题填字母数组（如 ["A","C"]）；
   判断题填 "对" 或 "错"；填空题/简答题直接填答案文本。
3. 只输出 JSON，不要输出任何解释性文字、不要用 Markdown 代码块包裹。
4. 如果题目信息不足或你不确定，仍要给出最可能的答案，并把 confidence 设为 0~1 之间的较低值。
5. 不要编造题目里不存在的选项字母。

输出格式（严格遵守）：
{"answers":[{"index":1,"answer":"A","confidence":0.95,"reason":"简短理由"}]}"""


class LLMError(RuntimeError):
    pass


def _strip_code_fence(text: str) -> str:
    """去掉模型可能加上的 Markdown 代码块包裹。"""
    out = (text or "").strip()
    if out.startswith(FENCE):
        out = out[len(FENCE):]
    if out.endswith(FENCE):
        out = out[:-len(FENCE)]
    out = out.strip()
    if out.lower().startswith("json"):
        out = out[4:].strip()
    if out.startswith(TICK) and out.endswith(TICK) and len(out) > 1:
        out = out[1:-1].strip()
    return out.strip()


def parse_json_loose(text: str) -> Any:
    """从模型输出里尽力抽出 JSON 对象。"""
    if not text:
        raise LLMError("模型返回为空")
    cleaned = _strip_code_fence(text)
    for candidate in (cleaned, text):
        try:
            return json.loads(candidate)
        except ValueError:
            pass
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start >= 0 and end > start:
        blob = cleaned[start:end + 1]
        try:
            return json.loads(blob)
        except ValueError:
            fixed = re.sub(r",\s*([}\]])", r"\1", blob)
            try:
                return json.loads(fixed)
            except ValueError as exc:
                raise LLMError("无法解析模型返回的 JSON: %s" % exc)
    start, end = cleaned.find("["), cleaned.rfind("]")
    if start >= 0 and end > start:
        try:
            return json.loads(cleaned[start:end + 1])
        except ValueError:
            pass
    raise LLMError("模型返回中找不到 JSON: %s" % cleaned[:500])


def build_user_prompt(questions: List[dict], page_context: str = "",
                      instructions: str = "") -> str:
    """把题目清单渲染成给模型的用户消息。"""
    lines: List[str] = []
    if page_context:
        lines.append("【页面背景信息】")
        lines.append(page_context.strip()[:4000])
        lines.append("")
    lines.append("【题目清单】共 %d 题" % len(questions))
    for q in questions:
        kind_label = {"single": "单选题", "multiple": "多选题", "text": "填空/简答题",
                      "select": "下拉选择", "bool": "判断题"}.get(q.get("type"), "题目")
        lines.append("")
        lines.append("[%d] (%s) %s" % (q["index"], kind_label, (q.get("stem") or "").strip()))
        for opt in q.get("options") or []:
            lines.append("    %s. %s" % (opt.get("key") or opt.get("value"), opt.get("text", "")))
        if q.get("type") == "text":
            extra = []
            if q.get("placeholder"):
                extra.append("输入提示: %s" % q["placeholder"])
            if q.get("maxlength"):
                extra.append("字数上限: %s" % q["maxlength"])
            if q.get("multiline"):
                extra.append("多行输入")
            if extra:
                lines.append("    （%s）" % "；".join(extra))
    if instructions:
        lines.append("")
        lines.append("【额外要求】")
        lines.append(instructions.strip())
    lines.append("")
    lines.append("请按题目序号作答，只输出规定的 JSON。")
    return "\n".join(lines)


class LLMClient:
    """OpenAI / Anthropic 兼容客户端。"""

    def __init__(self, config: dict):
        cfg = dict(config or {})
        self.provider = (cfg.get("provider") or "openai").lower()
        self.base_url = (cfg.get("base_url") or "https://api.openai.com/v1").rstrip("/")
        env_name = cfg.get("api_key_env", "QUIZBOT_API_KEY")
        self.api_key = cfg.get("api_key") or os.environ.get(env_name, "")
        if not self.api_key:
            self.api_key = os.environ.get("OPENAI_API_KEY", "")
        self.model = cfg.get("model") or "gpt-4o-mini"
        self.temperature = float(cfg.get("temperature", 0.2))
        self.max_tokens = int(cfg.get("max_tokens", 2048))
        self.timeout = float(cfg.get("timeout", 120))
        self.retries = int(cfg.get("retries", 2))
        self.verify_ssl = bool(cfg.get("verify_ssl", True))
        self.system_prompt = cfg.get("system_prompt") or SYSTEM_PROMPT
        self.extra_headers = dict(cfg.get("extra_headers") or {})
        self.extra_body = dict(cfg.get("extra_body") or {})
        self._session = requests.Session()

    # ------------------------------------------------ HTTP
    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.provider == "anthropic":
            if self.api_key:
                headers["x-api-key"] = self.api_key
            headers["anthropic-version"] = "2023-06-01"
        elif self.api_key:
            headers["Authorization"] = "Bearer %s" % self.api_key
        headers.update(self.extra_headers)
        return headers

    def chat(self, messages: List[dict]) -> str:
        """发一次请求，返回模型的纯文本输出。"""
        if self.provider == "mock":
            return self._mock_reply(messages)
        if self.provider == "anthropic":
            return self._chat_anthropic(messages)
        return self._chat_openai(messages)

    def chat_with_image(self, prompt: str, image_b64: str, mime: str = "image/png",
                        system: Optional[str] = None) -> str:
        """带图片的一次请求（视觉模式用）。"""
        if self.provider == "mock":
            return json.dumps({"questions": []}, ensure_ascii=False)
        system = system or "你是一个精确的图文识别助手，只输出要求的 JSON。"
        if self.provider == "anthropic":
            messages = [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime,
                                             "data": image_b64}},
                {"type": "text", "text": prompt},
            ]}]
            return self._chat_anthropic([{"role": "system", "content": system}] + messages)
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (mime, image_b64)}},
            ]},
        ]
        return self._chat_openai(messages)

    def _post(self, url: str, payload: dict) -> dict:
        last_error: Optional[Exception] = None
        for attempt in range(self.retries + 1):
            try:
                response = self._session.post(url, headers=self._headers(), json=payload,
                                              timeout=self.timeout, verify=self.verify_ssl)
                if response.status_code >= 400:
                    raise LLMError("HTTP %d: %s" % (response.status_code, response.text[:400]))
                return response.json()
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if attempt < self.retries:
                    time.sleep(1.5 * (attempt + 1))
        raise LLMError("调用模型失败: %s" % last_error)

    def _chat_openai(self, messages: List[dict]) -> str:
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        payload.update(self.extra_body)
        data = self._post("%s/chat/completions" % self.base_url, payload)
        choices = data.get("choices") or []
        if not choices:
            raise LLMError("响应里没有 choices: %s" % json.dumps(data, ensure_ascii=False)[:400])
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        if not content:
            content = choices[0].get("text") or ""
        return str(content)

    def _chat_anthropic(self, messages: List[dict]) -> str:
        system = ""
        converted = []
        for message in messages:
            if message.get("role") == "system":
                system = message.get("content", "")
                continue
            converted.append({"role": message["role"],
                              "content": [{"type": "text", "text": message.get("content", "")}]})
        payload: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "messages": converted,
        }
        if system:
            payload["system"] = system
        payload.update(self.extra_body)
        data = self._post("%s/messages" % self.base_url, payload)
        blocks = data.get("content") or []
        return "".join(b.get("text", "") for b in blocks if isinstance(b, dict))

    # ------------------------------------------------ 结构化答题
    def answer_questions(self, questions: List[dict], page_context: str = "",
                         instructions: str = "") -> Dict[int, dict]:
        """让模型逐题作答，返回 {题目序号: {answer, confidence, reason}}。"""
        if not questions:
            return {}
        prompt = build_user_prompt(questions, page_context, instructions)
        messages = [{"role": "system", "content": self.system_prompt},
                    {"role": "user", "content": prompt}]
        raw = self.chat(messages)
        parsed = parse_json_loose(raw)
        items = parsed.get("answers") if isinstance(parsed, dict) else parsed
        if not isinstance(items, list):
            raise LLMError("模型返回结构不对，期望 {\"answers\": [...]}，实际: %s"
                           % str(parsed)[:300])
        out: Dict[int, dict] = {}
        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                idx = int(item.get("index"))
            except (TypeError, ValueError):
                continue
            try:
                confidence = float(item.get("confidence", 0.8) or 0.8)
            except (TypeError, ValueError):
                confidence = 0.8
            out[idx] = {
                "answer": item.get("answer"),
                "confidence": confidence,
                "reason": str(item.get("reason", ""))[:300],
                "raw": item,
            }
        return out

    # ------------------------------------------------ Mock（离线自测）
    def _mock_reply(self, messages: List[dict]) -> str:
        prompt = messages[-1].get("content", "")
        parsed_questions: List[dict] = []
        current: Optional[dict] = None
        for line in prompt.splitlines():
            head = re.match(r"^\[(\d+)\]\s*\((.*?)\)\s*(.*)$", line)
            if head:
                current = {"index": int(head.group(1)), "type": head.group(2),
                           "stem": head.group(3), "options": []}
                parsed_questions.append(current)
                continue
            opt = re.match(r"^\s{4}(\S+)\.\s*(.*)$", line)
            if opt and current is not None:
                current["options"].append({"key": opt.group(1), "text": opt.group(2)})
        answers = []
        for q in parsed_questions:
            if q["options"]:
                keys = [o["key"] for o in q["options"]]
                if "多选" in q["type"]:
                    answer = keys[:2] if len(keys) > 1 else keys
                else:
                    answer = keys[0]
            else:
                answer = "mock答案-" + q["stem"][:20]
            answers.append({"index": q["index"], "answer": answer,
                            "confidence": 0.5, "reason": "mock provider"})
        return json.dumps({"answers": answers}, ensure_ascii=False)
