# -*- coding: utf-8 -*-
r"""Chrome DevTools Protocol 客户端：连接 Edge/Chrome 的远程调试端口。

用它可以拿到页面的真实 DOM —— 比截图 + OCR 准确得多，
适用于普通网页、问卷、在线考试系统等。

启用方式（需要完全关闭浏览器后再启动）：
    msedge.exe --remote-debugging-port=9222 --user-data-dir="C:\edge-debug"
然后在本程序 config.json 里设置  "cdp": { "enabled": true, "port": 9222 }
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

from .ws import WebSocket, WebSocketError


class CDPError(RuntimeError):
    pass


# 调试端口永远在本机，绝不应该走代理。
# 若系统/环境配置了代理，urllib 会把 127.0.0.1 也发往代理，导致连接挂起（表现为「端口一直未就绪」）。
_LOCAL_OPENER = None


def _local_opener():
    """构造一个显式禁用代理的 urllib opener（只用于访问本机调试端口）。"""
    global _LOCAL_OPENER
    if _LOCAL_OPENER is None:
        import urllib.request
        _LOCAL_OPENER = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),          # 不走任何代理
            urllib.request.HTTPHandler(),
        )
    return _LOCAL_OPENER


def http_json(url: str, timeout: float = 6.0, retries: int = 4) -> Any:
    """请求调试端点的 JSON 接口。

    DevTools 的 HTTP 端点在浏览器刚启动/负载高时会偶发重置连接
    （ConnectionResetError / 对端关闭），所以这里做几次短重试。
    """
    import urllib.request

    last_error: Optional[Exception] = None
    for attempt in range(retries):
        # Connection: close 避免复用已被对端关闭的 keep-alive 连接
        request = urllib.request.Request(
            url, headers={"User-Agent": "quiz-bot/1.0", "Connection": "close"})
        try:
            opener = _local_opener()
            with opener.open(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < retries - 1:
                time.sleep(0.35 * (attempt + 1))
    raise CDPError("无法访问 %s : %s" % (url, last_error))


def list_targets(host: str = "127.0.0.1", port: int = 9222,
                 timeout: float = 6.0) -> List[dict]:  # noqa: D401
    """列出浏览器里所有可调试的页面 target。"""
    data = http_json("http://%s:%d/json/list" % (host, port), timeout=timeout)
    targets = []
    for item in data:
        if item.get("type") != "page":
            continue
        targets.append({
            "id": item.get("id"),
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "ws": item.get("webSocketDebuggerUrl"),
        })
    return targets


def find_target(title_contains: Optional[str] = None, url_contains: Optional[str] = None,
                index: int = 0, host: str = "127.0.0.1", port: int = 9222) -> dict:
    targets = list_targets(host=host, port=port)
    if not targets:
        raise CDPError("调试端口 %d 上没有可用的页面。请确认浏览器是用 "
                       "--remote-debugging-port=%d 启动的。" % (port, port))
    matches = []
    for target in targets:
        if title_contains and title_contains.lower() not in target["title"].lower():
            continue
        if url_contains and url_contains.lower() not in target["url"].lower():
            continue
        matches.append(target)
    if not matches:
        detail = "; ".join("%s | %s" % (t["title"], t["url"]) for t in targets[:10])
        raise CDPError("没有匹配的页面 (title_contains=%r, url_contains=%r)。当前页面: %s"
                       % (title_contains, url_contains, detail))
    matches.sort(key=lambda t: t["url"].startswith("devtools://"))
    if index >= len(matches):
        raise CDPError("匹配到 %d 个页面，但请求 index=%d" % (len(matches), index))
    return matches[index]


class CDPSession:
    """与单个页面 target 的 CDP 会话。"""

    def __init__(self, ws_url: str, timeout: float = 30.0):
        self.ws = WebSocket(ws_url, timeout=timeout)
        self._next_id = 1
        self._events: List[dict] = []

    def call(self, method: str, params: Optional[dict] = None,
             timeout: float = 30.0) -> dict:
        message_id = self._next_id
        self._next_id += 1
        payload = {"id": message_id, "method": method, "params": params or {}}
        self.ws.send_text(json.dumps(payload))
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise CDPError("CDP 调用超时: %s" % method)
            raw = self.ws.recv_text(timeout=remaining)
            if raw is None:
                continue
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if message.get("id") == message_id:
                if "error" in message:
                    raise CDPError("CDP %s 出错: %s" % (method, message["error"]))
                return message.get("result", {})
            if "method" in message:
                self._events.append(message)
        # 不会到达

    def drain_events(self, max_items: int = 200) -> List[dict]:
        out = self._events[:max_items]
        self._events = self._events[max_items:]
        return out

    def eval_js(self, expression: str, await_promise: bool = False,
                timeout: float = 30.0) -> Any:
        """执行 JS 并返回可 JSON 化的结果。"""
        result = self.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
            "userGesture": True,
        }, timeout=timeout)
        if result.get("exceptionDetails"):
            detail = result["exceptionDetails"]
            text = detail.get("exception", {}).get("description") or detail.get("text")
            raise CDPError("页面 JS 执行异常: %s" % text)
        remote = result.get("result", {})
        return remote.get("value")

    def page_title(self) -> str:
        try:
            return str(self.eval_js("document.title") or "")
        except Exception:
            return ""

    def page_url(self) -> str:
        try:
            return str(self.eval_js("location.href") or "")
        except Exception:
            return ""

    def close(self) -> None:
        self.ws.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def connect(title_contains: Optional[str] = None, url_contains: Optional[str] = None,
            index: int = 0, host: str = "127.0.0.1", port: int = 9222,
            timeout: float = 30.0, retries: int = 4) -> CDPSession:
    """连接页面并建立 CDP 会话；握手偶发被重置时自动重试。"""
    last_error: Optional[Exception] = None
    for attempt in range(retries):
        try:
            target = find_target(title_contains=title_contains, url_contains=url_contains,
                                 index=index, host=host, port=port)
            return CDPSession(target["ws"], timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < retries - 1:
                time.sleep(0.4 * (attempt + 1))
    raise CDPError("连接失败: %s" % last_error)
