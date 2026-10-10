# -*- coding: utf-8 -*-
"""截图策略、裁剪、缩放与「画面是否变化」判定。"""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Optional, Sequence, Tuple

from . import win32
from .win32 import Window


@dataclass
class Frame:
    image: object                 # PIL.Image.Image
    window: Optional[Window]
    taken_at: float
    width: int
    height: int
    source: str                   # window / screen / region
    crop_box: Optional[Tuple[int, int, int, int]] = None   # 裁剪框（原图坐标）
    scale: float = 1.0                                     # 缩放比（输出/原图）

    def to_window_point(self, x: float, y: float) -> Tuple[float, float]:
        """把「截图里的像素坐标」换算回「窗口内坐标」。"""
        offset_x = self.crop_box[0] if self.crop_box else 0
        offset_y = self.crop_box[1] if self.crop_box else 0
        ratio = self.scale or 1.0
        return (offset_x + x / ratio, offset_y + y / ratio)

    def png_bytes(self) -> bytes:
        import io
        buf = io.BytesIO()
        self.image.save(buf, format="PNG", optimize=True)
        return buf.getvalue()

    def base64_png(self) -> str:
        import base64
        return base64.b64encode(self.png_bytes()).decode("ascii")

    def save(self, path: str) -> str:
        self.image.save(path)
        return path

    def signature(self, size: int = 32) -> bytes:
        gray = self.image.convert("L").resize((size, size))
        return gray.tobytes()

    def digest(self, size: int = 32) -> str:
        return hashlib.sha1(self.signature(size)).hexdigest()


def similarity(a: bytes, b: bytes) -> float:
    """两个签名之间的相似度，1.0 表示完全一致。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    total = sum(abs(x - y) for x, y in zip(a, b))
    return max(0.0, 1.0 - total / (255.0 * len(a)))


class Capturer:
    """按配置抓取目标区域。"""

    def __init__(self, config: dict):
        cap = dict(config.get("capture") or {})
        self.title_contains: Optional[str] = cap.get("title_contains") or None
        self.pid: Optional[int] = cap.get("pid")
        self.class_contains: Optional[str] = cap.get("class_contains") or None
        self.index: int = int(cap.get("index", 0))
        self.client_only: bool = bool(cap.get("client_only", False))
        self.crop: Optional[Sequence[int]] = cap.get("crop")      # 像素 [左, 上, 右, 下]
        self.crop_ratio: Optional[Sequence[float]] = cap.get("crop_ratio")  # 比例 0~1
        self.max_width: int = int(cap.get("max_width", 1600))
        self.region: Optional[Sequence[int]] = cap.get("region")  # 屏幕绝对 [x, y, w, h]
        self._cached_window: Optional[Window] = None

    def target_window(self, refresh: bool = False) -> Optional[Window]:
        if self.region:
            return None
        if self._cached_window is not None:
            info = win32.list_windows(only_visible=False, only_titled=False)
            for item in info:
                if item.hwnd == self._cached_window.hwnd:
                    self._cached_window = item
                    return item
            self._cached_window = None
        win = win32.find_window(title_contains=self.title_contains, pid=self.pid,
                                class_contains=self.class_contains, index=self.index)
        self._cached_window = win
        return win

    def grab(self, expect_window: bool = True) -> Frame:
        if self.region:
            x, y, w, h = [int(v) for v in self.region]
            img = win32.capture_rect(x, y, w, h)
            win = None
            source = "region"
        else:
            win = self.target_window()
            if win is None:
                if expect_window:
                    raise LookupError("没有找到目标窗口")
                img = win32.capture_fullscreen()
                source = "screen"
            else:
                img = win32.capture_window(win.hwnd, client_only=self.client_only)
                source = "window"
        img, crop_box = self._apply_crop(img)
        img, scale = self._apply_scale(img)
        return Frame(image=img, window=win, taken_at=time.time(),
                     width=img.width, height=img.height, source=source,
                     crop_box=crop_box, scale=scale)

    def _apply_crop(self, img):
        if self.crop_ratio:
            left, top, right, bottom = self.crop_ratio
            w, h = img.width, img.height
            box = (int(left * w), int(top * h), int(right * w), int(bottom * h))
        elif self.crop:
            box = tuple(int(v) for v in self.crop)
        else:
            return img, None
        box = (max(0, box[0]), max(0, box[1]),
               min(img.width, box[2]), min(img.height, box[3]))
        if box[2] <= box[0] or box[3] <= box[1]:
            return img, None
        return img.crop(box), box

    def _apply_scale(self, img):
        if self.max_width and img.width > self.max_width:
            ratio = self.max_width / float(img.width)
            return img.resize((self.max_width, max(1, int(img.height * ratio)))), ratio
        return img, 1.0
