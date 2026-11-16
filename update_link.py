"""
מוצא את הכתובת הקבועה של האתר (מ־Tailscale) ושומר אותה בתיקיית התוכנה:
  - "כתובת האתר.url": קיצור דרך. לחיצה כפולה פותחת את האתר.
  - "כתובת האתר.txt": הכתובת כטקסט, להעתקה ולשליחה לעובדים.
רץ אוטומטית בכל הפעלה של start-public.bat, כך שאם הכתובת משתנה (למשל במחשב חדש), הקבצים מתעדכנים לבד.
"""
import json
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
TAILSCALE = r"C:\Program Files\Tailscale\tailscale.exe"
LAST_KNOWN = "https://cnd03720l6.tail08b186.ts.net"


def detect():
    exe = TAILSCALE if os.path.exists(TAILSCALE) else "tailscale"
    out = subprocess.run([exe, "status", "--json"], capture_output=True, timeout=20, check=True,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    name = json.loads(out.decode("utf-8-sig"))["Self"]["DNSName"].rstrip(".")
    if not name:
        raise ValueError("no DNS name")
    return "https://" + name


def main():
    try:
        url = detect()
        found = True
    except Exception:
        txt = os.path.join(BASE, "כתובת האתר.txt")
        url = open(txt, encoding="utf-8").read().split()[0] if os.path.exists(txt) else LAST_KNOWN
        found = False
    with open(os.path.join(BASE, "כתובת האתר.url"), "w", encoding="utf-8") as f:
        f.write(f"[InternetShortcut]\nURL={url}\n")
    with open(os.path.join(BASE, "כתובת האתר.txt"), "w", encoding="utf-8") as f:
        f.write(url + "\n")
    print(url)
    if not found:
        print("(Tailscale is not available right now; showing the last saved address)", file=sys.stderr)


if __name__ == "__main__":
    main()
