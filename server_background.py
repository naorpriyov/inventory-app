"""
הפעלת השרת ברקע, בלי חלון. מופעל אוטומטית על ידי Windows (משימה מתוזמנת "InventoryServer")
כשהמחשב נדלק. כל ההודעות נכתבות לקובץ logs\\server.log.

התהליך הזה הוא "שומר": הוא מריץ את השרת (app.py), מפעיל אותו מחדש אם הוא נופל,
ומבצע בקשות עצירה/הפעלה מחדש שנכתבות לקובץ logs\\control.request (ראו server-control.ps1).
"""
import os
import socket
import subprocess
import sys
import threading
import time

BASE = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE)
sys.path.insert(0, BASE)
os.environ.setdefault("INV_HTTPS", "1")
# רק המחשב עצמו מגיע לשרת. מבחוץ נכנסים רק דרך הכתובת המאובטחת של Tailscale Funnel
os.environ.setdefault("INV_HOST", "127.0.0.1")
PORT = int(os.environ.get("INV_PORT") or "8000")
TAILSCALE = r"C:\Program Files\Tailscale\tailscale.exe"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# ---- log file (rotated at 5MB, one old copy kept)
LOG_DIR = os.path.join(BASE, "logs")
os.makedirs(LOG_DIR, exist_ok=True)
LOG = os.path.join(LOG_DIR, "server.log")
REQUEST = os.path.join(LOG_DIR, "control.request")
if os.path.exists(LOG) and os.path.getsize(LOG) > 5 * 1024 * 1024:
    os.replace(LOG, LOG + ".1")
log = open(LOG, "a", encoding="utf-8", buffering=1)
sys.stdout = sys.stderr = log


def say(msg):
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}")


print(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} starting in background =====")


def port_in_use():
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def take_request():
    """Returns 'stop' / 'restart' if one was requested (and clears it), else None."""
    try:
        with open(REQUEST, encoding="utf-8") as f:
            r = f.read().strip().lower()
        os.remove(REQUEST)
        return r if r in ("stop", "restart") else None
    except FileNotFoundError:
        return None
    except Exception as e:
        say(f"could not read control request: {e}")
        return None


# ---- Windows job object: if this watchdog dies, Windows also ends the server it started,
# so no server is ever left running without a watchdog.
JOB = None
if os.name == "nt":
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]

        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class EXTENDED(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IO_COUNTERS),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.OpenProcess.restype = wintypes.HANDLE
        JOB = k32.CreateJobObjectW(None, None)
        info = EXTENDED()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject(JOB, 9, ctypes.byref(info), ctypes.sizeof(info))  # 9 = ExtendedLimitInformation

        def bind_to_job(pid):
            h = k32.OpenProcess(0x0101, False, pid)  # PROCESS_SET_QUOTA | PROCESS_TERMINATE
            if h:
                k32.AssignProcessToJobObject(JOB, h)
                k32.CloseHandle(h)
    except Exception as e:
        say(f"job object unavailable: {e}")
        JOB = None


# ---- public address (Tailscale Funnel). Runs beside the server, so a slow Tailscale after boot
# never delays the server. The Funnel setting is saved by Tailscale itself, so this is a re-check.
def ensure_funnel():
    for attempt in range(12):
        try:
            if os.path.exists(TAILSCALE):
                subprocess.run([TAILSCALE, "funnel", "--bg", "--yes", str(PORT)], capture_output=True, timeout=30, creationflags=NO_WINDOW, check=True)
                print("Tailscale Funnel is on.")
            break
        except Exception as e:
            print("Tailscale not ready yet:", e)
            time.sleep(10)
    try:
        import update_link
        update_link.main()  # prints the address and refreshes the address files
    except Exception as e:
        print("Could not refresh the address files:", e)


threading.Thread(target=ensure_funnel, daemon=True).start()

# ---- watchdog loop
take_request()  # ignore a stale request left from before this start
env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
while True:
    if port_in_use():  # another copy is running (e.g. start-public.bat): wait for it to finish
        if take_request() == "stop":
            say("stop requested while another copy holds the port; exiting")
            sys.exit(0)
        time.sleep(5)
        continue
    child = subprocess.Popen([sys.executable, os.path.join(BASE, "app.py")], cwd=BASE, env=env,
                             stdout=log, stderr=log, creationflags=NO_WINDOW)
    if JOB:
        bind_to_job(child.pid)
    req = None
    while child.poll() is None:
        req = take_request()
        if req:
            say(f"{req} requested")
            child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
            break
        time.sleep(1)
    if req == "stop":
        say("server stopped on request")
        sys.exit(0)
    if req != "restart":
        say(f"server stopped (exit code {child.returncode}); restarting in 5 seconds")
        time.sleep(5)
