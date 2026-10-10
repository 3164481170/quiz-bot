# -*- coding: utf-8 -*-
"""极简 WebSocket 客户端 (RFC 6455)，仅支持客户端、文本帧，用于连接 CDP。

不依赖 websocket-client，只用标准库 socket + hashlib。
"""
from __future__ import annotations

import base64
import hashlib
import os
import socket
import ssl
import struct
import time
from typing import Optional, Tuple
from urllib.parse import urlparse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocketError(RuntimeError):
    pass


class WebSocket:
    """同步 WebSocket 客户端。"""

    def __init__(self, url: str, timeout: float = 30.0):
        parsed = urlparse(url)
        if parsed.scheme not in ("ws", "wss"):
            raise ValueError("只支持 ws:// 与 wss://，收到: %s" % url)
        self.url = url
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        self.path = parsed.path or "/"
        if parsed.query:
            self.path += "?" + parsed.query
        self.timeout = timeout
        self._buffer = b""
        self._closed = False

        # 直连本机调试端口，不经过任何代理
        raw = socket.create_connection((self.host, self.port), timeout=timeout)
        if parsed.scheme == "wss":
            ctx = ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=self.host)
        self.sock = raw
        self.sock.settimeout(timeout)
        self._handshake()
        self.sock.settimeout(0.2)

    # -------------------------------------------------- 握手
    def _handshake(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = self.host if self.port in (80, 443) else "%s:%d" % (self.host, self.port)
        request = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: quiz-bot/1.0\r\n"
            "\r\n"
        ) % (self.path, host_header, key)
        self.sock.sendall(request.encode("ascii"))

        head = b""
        deadline = time.time() + self.timeout
        while b"\r\n\r\n" not in head:
            if time.time() > deadline:
                raise WebSocketError("WebSocket 握手超时")
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WebSocketError("WebSocket 握手期间连接被关闭")
            head += chunk
        header_blob, rest = head.split(b"\r\n\r\n", 1)
        self._buffer = rest
        lines = header_blob.decode("latin-1").split("\r\n")
        status = lines[0]
        if "101" not in status:
            raise WebSocketError("WebSocket 握手失败: %s" % status)
        expected = base64.b64encode(
            hashlib.sha1((key + GUID).encode("ascii")).digest()).decode("ascii")
        accept = None
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                if name.strip().lower() == "sec-websocket-accept":
                    accept = value.strip()
        if accept and accept != expected:
            raise WebSocketError("Sec-WebSocket-Accept 校验失败")

    # -------------------------------------------------- 底层收发
    def _recv_exact(self, count: int, deadline: float) -> bytes:
        while len(self._buffer) < count:
            if time.time() > deadline:
                raise WebSocketError("读取 WebSocket 数据超时")
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                raise WebSocketError("连接已关闭")
            self._buffer += chunk
        out, self._buffer = self._buffer[:count], self._buffer[count:]
        return out

    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _read_frame(self, deadline: float) -> Tuple[int, bytes]:
        header = self._recv_exact(2, deadline)
        fin = header[0] & 0x80
        opcode = header[0] & 0x0F
        masked = header[1] & 0x80
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2, deadline))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8, deadline))[0]
        mask = self._recv_exact(4, deadline) if masked else None
        payload = self._recv_exact(length, deadline) if length else b""
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if not fin:
            # 分片：继续读直到 FIN
            pieces = [payload]
            while True:
                h2 = self._recv_exact(2, deadline)
                ln = h2[1] & 0x7F
                if ln == 126:
                    ln = struct.unpack(">H", self._recv_exact(2, deadline))[0]
                elif ln == 127:
                    ln = struct.unpack(">Q", self._recv_exact(8, deadline))[0]
                m2 = self._recv_exact(4, deadline) if (h2[1] & 0x80) else None
                part = self._recv_exact(ln, deadline) if ln else b""
                if m2:
                    part = bytes(b ^ m2[i % 4] for i, b in enumerate(part))
                pieces.append(part)
                if h2[0] & 0x80:
                    break
            payload = b"".join(pieces)
        return opcode, payload

    def recv_text(self, timeout: Optional[float] = None) -> Optional[str]:
        """读取下一条文本消息；超时返回 None。自动回应 ping 并跳过 pong。"""
        deadline = time.time() + (self.timeout if timeout is None else timeout)
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            self.sock.settimeout(min(0.25, max(0.05, remaining)))
            try:
                opcode, payload = self._read_frame(deadline)
            except WebSocketError as exc:
                if "超时" in str(exc):
                    continue
                raise
            except socket.timeout:
                continue
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")
            if opcode == 0x8:
                self._closed = True
                raise WebSocketError("对端关闭了 WebSocket")
            if opcode == 0x9:  # ping -> pong
                self._send_control(0xA, payload)
                continue
            if opcode == 0xA:
                continue

    def _send_control(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])
        header.append(0x80 | len(payload))
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        try:
            self.sock.sendall(bytes(header) + masked)
        except OSError:
            pass

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._send_control(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
