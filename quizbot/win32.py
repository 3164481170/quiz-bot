# -*- coding: utf-8 -*-
"""Windows 原生能力封装：窗口枚举 / 截图 / 键盘鼠标注入 / 剪贴板。

只依赖标准库 ctypes + Pillow，不依赖 pywin32 / pyautogui。
"""
from __future__ import annotations

import ctypes
import time
from ctypes import wintypes
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence, Tuple

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# ---------------------------------------------------------------- 常量
SW_HIDE, SW_SHOWNORMAL, SW_RESTORE, SW_SHOW = 0, 1, 9, 5
PW_CLIENTONLY, PW_RENDERFULLCONTENT = 0x1, 0x2
SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

INPUT_MOUSE, INPUT_KEYBOARD, INPUT_HARDWARE = 0, 1, 2
KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

VK = {
    "backspace": 0x08, "tab": 0x09, "enter": 0x0D, "return": 0x0D, "shift": 0x10,
    "ctrl": 0x11, "control": 0x11, "alt": 0x12, "pause": 0x13, "capslock": 0x14,
    "esc": 0x1B, "escape": 0x1B, "space": 0x20, "pageup": 0x21, "pagedown": 0x22,
    "end": 0x23, "home": 0x24, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "insert": 0x2D, "delete": 0x2E, "del": 0x2E,
    "0": 0x30, "1": 0x31, "2": 0x32, "3": 0x33, "4": 0x34, "5": 0x35, "6": 0x36,
    "7": 0x37, "8": 0x38, "9": 0x39,
    "a": 0x41, "b": 0x42, "c": 0x43, "d": 0x44, "e": 0x45, "f": 0x46, "g": 0x47,
    "h": 0x48, "i": 0x49, "j": 0x4A, "k": 0x4B, "l": 0x4C, "m": 0x4D, "n": 0x4E,
    "o": 0x4F, "p": 0x50, "q": 0x51, "r": 0x52, "s": 0x53, "t": 0x54, "u": 0x55,
    "v": 0x56, "w": 0x57, "x": 0x58, "y": 0x59, "z": 0x5A,
    "numpad0": 0x60, "numpad1": 0x61, "numpad2": 0x62, "numpad3": 0x63,
    "numpad4": 0x64, "numpad5": 0x65, "numpad6": 0x66, "numpad7": 0x67,
    "numpad8": 0x68, "numpad9": 0x69, "f1": 0x70, "f2": 0x71, "f3": 0x72,
    "f4": 0x73, "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77, "f9": 0x78,
    "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}


# ---------------------------------------------------------------- 结构体
class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_void_p)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_void_p)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD),
                ("wParamH", wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER),
                ("bmiColors", wintypes.DWORD * 3)]


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]


@dataclass
class Window:
    hwnd: int
    pid: int
    title: str
    class_name: str
    rect: Tuple[int, int, int, int]  # left, top, right, bottom
    visible: bool
    minimized: bool

    @property
    def width(self) -> int:
        return max(0, self.rect[2] - self.rect[0])

    @property
    def height(self) -> int:
        return max(0, self.rect[3] - self.rect[1])

    def as_dict(self) -> dict:
        return {"hwnd": self.hwnd, "pid": self.pid, "title": self.title,
                "class_name": self.class_name, "rect": list(self.rect),
                "width": self.width, "height": self.height,
                "visible": self.visible, "minimized": self.minimized}


def enable_dpi_awareness() -> None:
    """让 GetWindowRect / 截图坐标与物理像素一致，避免高分屏下错位。"""
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
        return
    except Exception:
        pass
    try:
        ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
        return
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


def _enum_windows() -> List[int]:
    handles: List[int] = []
    proto = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, _lparam):
        handles.append(hwnd)
        return True

    user32.EnumWindows(proto(_cb), 0)
    return handles


def _window_info(hwnd: int) -> Optional[Window]:
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 2)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value
    cbuf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, cbuf, 255)
    rect = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return Window(hwnd=int(hwnd), pid=int(pid.value), title=title,
                  class_name=cbuf.value,
                  rect=(rect.left, rect.top, rect.right, rect.bottom),
                  visible=bool(user32.IsWindowVisible(hwnd)),
                  minimized=bool(user32.IsIconic(hwnd)))


def list_windows(title_contains: Optional[str] = None, pid: Optional[int] = None,
                 class_contains: Optional[str] = None, only_visible: bool = True,
                 only_titled: bool = True, min_size: int = 0) -> List[Window]:
    out: List[Window] = []
    for hwnd in _enum_windows():
        info = _window_info(hwnd)
        if info is None:
            continue
        if only_visible and not info.visible:
            continue
        if only_titled and not info.title.strip():
            continue
        if title_contains and title_contains.lower() not in info.title.lower():
            continue
        if class_contains and class_contains.lower() not in info.class_name.lower():
            continue
        if pid is not None and info.pid != pid:
            continue
        if min_size and (info.width < min_size or info.height < min_size):
            continue
        out.append(info)
    return out


def find_window(title_contains: Optional[str] = None, pid: Optional[int] = None,
                class_contains: Optional[str] = None, index: int = 0,
                only_visible: bool = True) -> Window:
    """按条件定位目标窗口。index 用于命中多个时选择第 N 个（按面积从大到小）。"""
    matches = list_windows(title_contains=title_contains, pid=pid,
                           class_contains=class_contains, only_visible=only_visible)
    if not matches:
        raise LookupError(
            "没有找到匹配的窗口 (title_contains=%r, pid=%r, class_contains=%r)" %
            (title_contains, pid, class_contains))
    matches.sort(key=lambda w: w.width * w.height, reverse=True)
    if index >= len(matches):
        raise LookupError("匹配到 %d 个窗口，但请求 index=%d" % (len(matches), index))
    return matches[index]


# ---------------------------------------------------------------- 截图
def _bitmap_to_image(hdc_mem, hbmp, w: int, h: int):
    from PIL import Image
    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = w
    bmi.bmiHeader.biHeight = -h  # 负数 = 自上而下
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = 0  # BI_RGB
    buf = ctypes.create_string_buffer(w * h * 4)
    got = gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf, ctypes.byref(bmi), DIB_RGB_COLORS)
    if not got:
        raise OSError("GetDIBits 失败")
    return Image.frombuffer("RGBA", (w, h), buf.raw, "raw", "BGRA", 0, 1).convert("RGB")


def capture_rect(left: int, top: int, width: int, height: int):
    """抓取屏幕任意矩形（屏幕坐标系，物理像素）。"""
    if width <= 0 or height <= 0:
        raise ValueError("截图区域无效: %dx%d" % (width, height))
    src = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(src)
    bmp = gdi32.CreateCompatibleBitmap(src, width, height)
    old = gdi32.SelectObject(mem, bmp)
    try:
        if not gdi32.BitBlt(mem, 0, 0, width, height, src, left, top, SRCCOPY):
            raise OSError("BitBlt 失败 (屏幕截图)")
        return _bitmap_to_image(mem, bmp, width, height)
    finally:
        gdi32.SelectObject(mem, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem)
        user32.ReleaseDC(0, src)


def capture_window(hwnd: int, client_only: bool = False):
    """抓取窗口图像。优先 PrintWindow（可抓被遮挡/后台窗口），失败则回退屏幕拷贝。"""
    win = _window_info(hwnd)
    if win is None:
        raise LookupError("窗口不存在: hwnd=%s" % hwnd)
    if client_only:
        crect = RECT()
        user32.GetClientRect(hwnd, ctypes.byref(crect))
        width, height = crect.right - crect.left, crect.bottom - crect.top
        src = user32.GetDC(hwnd)
        origin_x = origin_y = 0
    else:
        width, height = win.width, win.height
        src = user32.GetWindowDC(hwnd)
        origin_x, origin_y = win.rect[0], win.rect[1]
    if width <= 0 or height <= 0:
        raise ValueError("窗口尺寸无效: %dx%d" % (width, height))

    mem = gdi32.CreateCompatibleDC(src)
    bmp = gdi32.CreateCompatibleBitmap(src, width, height)
    old = gdi32.SelectObject(mem, bmp)
    try:
        flags = PW_CLIENTONLY if client_only else PW_RENDERFULLCONTENT
        ok = user32.PrintWindow(hwnd, mem, flags)
        img = None
        if ok:
            try:
                img = _bitmap_to_image(mem, bmp, width, height)
            except OSError:
                img = None
        # PrintWindow 对某些 GPU 合成窗口会返回全黑/全白，检测后回退到屏幕拷贝
        if img is None or _is_blank(img):
            gdi32.BitBlt(mem, 0, 0, width, height, src, 0, 0, SRCCOPY)
            img = _bitmap_to_image(mem, bmp, width, height)
        return img
    finally:
        gdi32.SelectObject(mem, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem)
        user32.ReleaseDC(hwnd if client_only else 0, src)


def _is_blank(img) -> bool:
    """判断截图是否几乎纯色（用于识别 PrintWindow 失败）。"""
    try:
        small = img.convert("L").resize((32, 32))
        data = small.tobytes()
        return (max(data) - min(data)) < 6
    except Exception:
        return False


def capture_fullscreen():
    left = user32.GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
    top = user32.GetSystemMetrics(77)
    width = user32.GetSystemMetrics(78)
    height = user32.GetSystemMetrics(79)
    return capture_rect(left, top, width, height)


# ---------------------------------------------------------------- 焦点
def focus_window(hwnd: int, retries: int = 5, restore: bool = True) -> bool:
    """把窗口激活到前台。返回是否成功。"""
    if restore and user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
        time.sleep(0.35)
    elif restore and not user32.IsWindowVisible(hwnd):
        user32.ShowWindow(hwnd, SW_SHOW)

    for attempt in range(retries):
        fg = user32.GetForegroundWindow()
        if fg == hwnd:
            return True
        tid_fg = user32.GetWindowThreadProcessId(fg, None)
        tid_cur = kernel32.GetCurrentThreadId()
        attached = False
        if tid_fg and tid_fg != tid_cur:
            attached = bool(user32.AttachThreadInput(tid_cur, tid_fg, True))
        try:
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            user32.SetActiveWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(tid_cur, tid_fg, False)
        if user32.GetForegroundWindow() == hwnd:
            return True
        # 前台锁有时需要一次 ALT 按键才能放开
        _send_inputs([_key_input(0x12, down=True, extended=False),
                      _key_input(0x12, down=False, extended=False)])
        time.sleep(0.15 * (attempt + 1))
    return user32.GetForegroundWindow() == hwnd


def get_foreground() -> Optional[Window]:
    hwnd = user32.GetForegroundWindow()
    return _window_info(hwnd) if hwnd else None


# ---------------------------------------------------------------- 输入注入
def _key_input(vk: int, down: bool = True, scan: int = 0, unicode_mode: bool = False,
               extended: bool = False) -> INPUT:
    item = INPUT()
    item.type = INPUT_KEYBOARD
    flags = 0
    if unicode_mode:
        flags |= KEYEVENTF_UNICODE
    if extended:
        flags |= KEYEVENTF_EXTENDEDKEY
    if not down:
        flags |= KEYEVENTF_KEYUP
    item.ki = KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=None)
    return item


def _mouse_input(flags: int, dx: int = 0, dy: int = 0, data: int = 0) -> INPUT:
    item = INPUT()
    item.type = INPUT_MOUSE
    item.mi = MOUSEINPUT(dx=dx, dy=dy, mouseData=data, dwFlags=flags, time=0,
                         dwExtraInfo=None)
    return item


def _send_inputs(items: Sequence[INPUT]) -> None:
    if not items:
        return
    array = (INPUT * len(items))(*items)
    sent = user32.SendInput(len(items), ctypes.byref(array), ctypes.sizeof(INPUT))
    if sent != len(items):
        raise OSError("SendInput 只发送了 %d/%d 个事件 (错误码 %d)" %
                      (sent, len(items), ctypes.get_last_error()))


def press_key(key: str, presses: int = 1, interval: float = 0.05) -> None:
    """按下一个键，key 支持 'enter' / 'f5' / 'a' 等名称。"""
    name = key.strip().lower()
    if name not in VK:
        raise ValueError("不认识的按键: %r" % key)
    vk = VK[name]
    extended = name in ("left", "right", "up", "down", "home", "end", "pageup",
                        "pagedown", "insert", "delete", "del", "numpad0")
    for _ in range(max(1, presses)):
        _send_inputs([_key_input(vk, True, extended=extended),
                      _key_input(vk, False, extended=extended)])
        time.sleep(interval)


def send_hotkey(combo: str, interval: float = 0.05) -> None:
    """发送组合键，例如 'ctrl+enter'、'alt+s'、'ctrl+shift+a'。"""
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    if not parts:
        raise ValueError("组合键为空")
    for p in parts:
        if p not in VK:
            raise ValueError("不认识的按键: %r" % p)
    downs = [_key_input(VK[p], True) for p in parts]
    ups = [_key_input(VK[p], False) for p in reversed(parts)]
    _send_inputs(downs)
    time.sleep(interval)
    _send_inputs(ups)


def type_text(text: str, interval: float = 0.0, chunk: int = 64) -> None:
    """用 KEYEVENTF_UNICODE 直接注入任意 Unicode 文本（支持中文，不经过输入法）。"""
    if not text:
        return
    units = text.encode("utf-16-le")
    codes = [units[i] | (units[i + 1] << 8) for i in range(0, len(units), 2)]
    for start in range(0, len(codes), chunk):
        batch: List[INPUT] = []
        for code in codes[start:start + chunk]:
            batch.append(_key_input(0, True, scan=code, unicode_mode=True))
            batch.append(_key_input(0, False, scan=code, unicode_mode=True))
        _send_inputs(batch)
        if interval:
            time.sleep(interval)


def click(x: int, y: int, button: str = "left", double: bool = False,
          settle: float = 0.12) -> None:
    """在屏幕坐标 (x, y) 处点击。"""
    if not set_cursor_pos(x, y):
        raise OSError("SetCursorPos(%d, %d) 失败" % (x, y))
    time.sleep(0.05)
    down = MOUSEEVENTF_LEFTDOWN if button == "left" else MOUSEEVENTF_RIGHTDOWN
    up = MOUSEEVENTF_LEFTUP if button == "left" else MOUSEEVENTF_RIGHTUP
    clicks = 2 if double else 1
    for _ in range(clicks):
        _send_inputs([_mouse_input(down), _mouse_input(up)])
        time.sleep(0.06)
    time.sleep(settle)


def set_cursor_pos(x: int, y: int) -> bool:
    return bool(user32.SetCursorPos(int(x), int(y)))


def click_in_window(win: Window, x: int, y: int, client_relative: bool = True,
                    **kwargs) -> None:
    """在窗口内相对坐标处点击（默认相对客户区左上角）。"""
    if client_relative:
        point = wintypes.POINT(int(x), int(y))
        user32.ClientToScreen(wintypes.HWND(win.hwnd), ctypes.byref(point))
        sx, sy = point.x, point.y
    else:
        sx, sy = win.rect[0] + int(x), win.rect[1] + int(y)
    click(sx, sy, **kwargs)


# ---------------------------------------------------------------- 剪贴板
def set_clipboard_text(text: str) -> bool:
    """写入剪贴板（长文本用粘贴比逐字符注入更快更稳）。"""
    if not user32.OpenClipboard(None):
        return False
    try:
        user32.EmptyClipboard()
        size = (len(text) + 1) * 2
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        if not handle:
            return False
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            kernel32.GlobalFree(handle)
            return False
        ctypes.memmove(pointer, text.encode("utf-16-le") + b"\x00\x00", size)
        kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(CF_UNICODETEXT, handle):
            kernel32.GlobalFree(handle)
            return False
        return True  # 所有权已交给系统，不要 GlobalFree
    finally:
        user32.CloseClipboard()


def paste_text(text: str, restore_foreground: bool = True) -> bool:
    """通过剪贴板 + Ctrl+V 输入文本。"""
    if not set_clipboard_text(text):
        return False
    time.sleep(0.08)
    send_hotkey("ctrl+v")
    return True
