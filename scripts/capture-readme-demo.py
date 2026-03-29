from __future__ import annotations

import ctypes
import ctypes.wintypes
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from PIL import Image, ImageGrab


REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = REPO_ROOT / "docs" / "images"
SERVER_PORT = 8877
CREATE_NEW_CONSOLE = 0x00000010
CREATE_NO_WINDOW = 0x08000000
SW_RESTORE = 9
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_SHOWWINDOW = 0x0040
TERMINAL_WIDTH = 2460
TERMINAL_HEIGHT = 1400
DASHBOARD_WIDTH = 2200
DASHBOARD_HEIGHT = 1400

CHROME_CANDIDATES = [
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
]


user32 = ctypes.windll.user32
user32.SetProcessDPIAware()


def run(command: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=str(cwd or REPO_ROOT),
        check=True,
        text=True,
        capture_output=True,
    )


def choose_browser() -> Path:
    for candidate in CHROME_CANDIDATES:
        if candidate.exists():
            return candidate
    raise FileNotFoundError("Could not find Chrome or Edge")


def start_server() -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-m", "http.server", str(SERVER_PORT), "--bind", "127.0.0.1"],
        cwd=str(REPO_ROOT),
        creationflags=CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )


def start_sidecar(room: str, stream_id: str, runtime: str, state_dir: Path) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    run([
        "node",
        ".\\dist\\cli.js",
        "start",
        "--room", room,
        "--id", stream_id,
        "--runtime", runtime,
        "--state-dir", str(state_dir),
    ])


def stop_sidecar(state_dir: Path) -> None:
    run(["node", ".\\dist\\cli.js", "stop", "--state-dir", str(state_dir)])


def launch_browser(browser: Path, room: str) -> subprocess.Popen[str]:
    url = f"http://127.0.0.1:{SERVER_PORT}/dashboard.html?room={room}&password=false&name=Dashboard&autoconnect=true"
    return subprocess.Popen(
        [str(browser), "--new-window", "--app=" + url],
        cwd=str(REPO_ROOT),
        creationflags=CREATE_NEW_CONSOLE,
        text=True,
    )


def find_window(substring: str) -> int | None:
    found: list[int] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def enum_proc(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        title = buffer.value
        if substring.lower() in title.lower():
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(enum_proc, 0)
    return found[0] if found else None


def wait_for_window(substring: str, timeout: float = 30.0) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        hwnd = find_window(substring)
        if hwnd:
            return hwnd
        time.sleep(0.5)
    raise TimeoutError(f"Timed out waiting for window containing: {substring}")


def move_window(hwnd: int, x: int, y: int, width: int, height: int) -> None:
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.MoveWindow(hwnd, x, y, width, height, True)


def window_rect(hwnd: int) -> tuple[int, int, int, int]:
    rect = ctypes.wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect.left, rect.top, rect.right, rect.bottom


def capture_window(hwnd: int, output_path: Path) -> Image.Image:
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
    time.sleep(0.6)
    left, top, right, bottom = window_rect(hwnd)
    image = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
    image.save(output_path)
    return image


def build_codex_command(state_dir: Path, title: str) -> str:
    send_prompt = (
        "Use the shell only. "
        f"Run: node .\\\\dist\\\\cli.js chat --state-dir '{state_dir}' "
        "'Codex here. Please review the rollout plan.' "
        "Then reply with the exact shell output only."
    )
    read_prompt = (
        "Use the shell only. "
        f"Run: node .\\\\dist\\\\cli.js read --state-dir '{state_dir}' --take 10 "
        "Then reply with the exact shell output only."
    )
    return "\n".join([
        "@echo off",
        f"title {title}",
        "mode con: cols=180 lines=52",
        f'cd /d "{REPO_ROOT}"',
        "echo Room info",
        f'node .\\dist\\cli.js room --state-dir "{state_dir}"',
        "echo(",
        "echo Sending as Codex...",
        f'codex exec --dangerously-bypass-approvals-and-sandbox --cd "{REPO_ROOT}" "{send_prompt}"',
        "echo(",
        "echo Waiting for Claude...",
        'powershell -Command "Start-Sleep -Seconds 14"',
        "echo(",
        "echo Reading reply...",
        f'codex exec --dangerously-bypass-approvals-and-sandbox --cd "{REPO_ROOT}" "{read_prompt}"',
        "echo(",
        "echo Demo complete.",
        "pause",
    ])


def build_claude_command(state_dir: Path, title: str) -> str:
    prompt = (
        "Use Bash only. "
        f"First run: node .\\\\dist\\\\cli.js read --state-dir '{state_dir}' --take 10 "
        f"Then run: node .\\\\dist\\\\cli.js chat --state-dir '{state_dir}' "
        "'Claude here. I can review it now. Send the diff or checklist.' "
        "Then reply with the exact shell output only."
    )
    return "\n".join([
        "@echo off",
        f"title {title}",
        "mode con: cols=180 lines=52",
        f'cd /d "{REPO_ROOT}"',
        "echo Room info",
        f'node .\\dist\\cli.js room --state-dir "{state_dir}"',
        "echo(",
        "echo Waiting for Codex...",
        'powershell -Command "Start-Sleep -Seconds 6"',
        "echo(",
        "echo Reading and replying as Claude...",
        f'claude -p --dangerously-skip-permissions "{prompt}"',
        "echo(",
        "echo Demo complete.",
        "pause",
    ])


def write_demo_script(path: Path, content: str) -> Path:
    path.write_text(content + "\n", encoding="utf-8")
    return path


def make_composite(images: list[Image.Image], output_path: Path) -> None:
    width = sum(image.width for image in images) + 32
    height = max(image.height for image in images)
    canvas = Image.new("RGB", (width, height), "#0d1117")
    x = 0
    for image in images:
        canvas.paste(image, (x, 0))
        x += image.width + 16
    canvas.save(output_path)


def main() -> None:
    browser = choose_browser()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    room = f"readme_demo_{uuid.uuid4().hex[:8]}"
    terminal_title = f"NINJA_DEMO_CHAT_{room}"
    base_dir = Path(tempfile.gettempdir()) / f"ninja-p2p-readme-demo-{uuid.uuid4().hex[:6]}"
    claude_state = base_dir / "claude"
    codex_state = base_dir / "codex"
    if base_dir.exists():
        shutil.rmtree(base_dir)
    claude_state.mkdir(parents=True, exist_ok=True)
    codex_state.mkdir(parents=True, exist_ok=True)

    server = start_server()
    time.sleep(2)
    start_sidecar(room, "claude", "claude-code", claude_state)
    start_sidecar(room, "codex", "codex-cli", codex_state)
    time.sleep(4)

    launch_browser(browser, room)
    time.sleep(4)
    codex_script = write_demo_script(base_dir / "codex-demo.cmd", build_codex_command(codex_state, "CODEX_PANE"))
    claude_script = write_demo_script(base_dir / "claude-demo.cmd", build_claude_command(claude_state, terminal_title))

    subprocess.Popen(
        [
            "wt.exe",
            "new-tab",
            "--title",
            "CODEX_PANE",
            "--suppressApplicationTitle",
            "cmd",
            "/k",
            str(codex_script),
            ";",
            "split-pane",
            "-V",
            "--title",
            terminal_title,
            "--suppressApplicationTitle",
            "cmd",
            "/k",
            str(claude_script),
        ],
        cwd=str(REPO_ROOT),
        creationflags=CREATE_NEW_CONSOLE,
        text=True,
    )

    terminal_hwnd = wait_for_window(terminal_title)
    dashboard_hwnd = wait_for_window("Ninja P2P Dashboard")

    move_window(terminal_hwnd, 40, 80, TERMINAL_WIDTH, TERMINAL_HEIGHT)
    move_window(dashboard_hwnd, 120, 80, DASHBOARD_WIDTH, DASHBOARD_HEIGHT)

    time.sleep(40)

    terminal_image = capture_window(terminal_hwnd, OUTPUT_DIR / "readme-demo-terminal.png")
    half_width = terminal_image.width // 2
    codex_image = terminal_image.crop((0, 0, half_width, terminal_image.height))
    claude_image = terminal_image.crop((half_width, 0, terminal_image.width, terminal_image.height))
    codex_image.save(OUTPUT_DIR / "readme-demo-codex.png")
    claude_image.save(OUTPUT_DIR / "readme-demo-claude.png")
    dashboard_image = capture_window(dashboard_hwnd, OUTPUT_DIR / "readme-demo-dashboard.png")
    make_composite(
        [claude_image, codex_image, dashboard_image],
        OUTPUT_DIR / "readme-demo-composite.png",
    )

    stop_sidecar(claude_state)
    stop_sidecar(codex_state)
    server.terminate()

    print(f"room={room}")
    print(f"claude={OUTPUT_DIR / 'readme-demo-claude.png'}")
    print(f"codex={OUTPUT_DIR / 'readme-demo-codex.png'}")
    print(f"dashboard={OUTPUT_DIR / 'readme-demo-dashboard.png'}")
    print(f"composite={OUTPUT_DIR / 'readme-demo-composite.png'}")


if __name__ == "__main__":
    main()
