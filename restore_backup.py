"""
שחזור מגיבוי אוטומטי. מריצים רק כשהשרת כבוי:  python restore_backup.py
מסד הנתונים הנוכחי לא נמחק: הוא נשמר קודם בתיקייה backups.
"""
import os
import shutil
import socket
import sqlite3
import time

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("INV_DATA_DIR", os.path.join(BASE, "data"))
DB_PATH = os.path.join(DATA, "inventory.db")
BACKUP_DIR = os.environ.get("INV_BACKUP_DIR", os.path.join(BASE, "backups", "auto"))
PORT = int(os.environ.get("INV_PORT") or "8000")


def server_running():
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def main():
    if server_running():
        raise SystemExit("השרת עדיין פועל. סגרו את חלון השרת ואז הריצו שוב.")
    files = sorted(f for f in os.listdir(BACKUP_DIR) if f.endswith(".db")) if os.path.isdir(BACKUP_DIR) else []
    if not files:
        raise SystemExit("לא נמצאו גיבויים ב־" + BACKUP_DIR)
    print("גיבויים זמינים:")
    for i, f in enumerate(files, 1):
        print(f"  {i}. {f}")
    choice = input("מספר הגיבוי לשחזור (Enter לביטול): ").strip().lstrip("﻿")
    if not choice:
        return
    if not choice.isdigit() or not 1 <= int(choice) <= len(files):
        raise SystemExit("מספר לא תקין. הריצו שוב ובחרו מספר מהרשימה.")
    src = os.path.join(BACKUP_DIR, files[int(choice) - 1])
    con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    ok = con.execute("PRAGMA integrity_check").fetchone()[0]
    con.close()
    if ok != "ok":
        raise SystemExit("הגיבוי הזה פגום. בחרו גיבוי אחר.")
    if input(f"לשחזר את {os.path.basename(src)}? השינויים מאז הגיבוי יוחלפו. (yes/no): ").strip().lower() != "yes":
        return
    keep = os.path.join(os.path.dirname(os.path.abspath(DATA)), "backups", "before-restore-" + time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(keep, exist_ok=True)
    for ext in ("", "-wal", "-shm"):
        p = DB_PATH + ext
        if os.path.exists(p):
            shutil.move(p, os.path.join(keep, os.path.basename(p)))
    shutil.copy2(src, DB_PATH)
    print("השחזור הושלם. מסד הנתונים הקודם נשמר ב־" + keep)
    print("עכשיו מפעילים את השרת מחדש (start-public.bat).")


if __name__ == "__main__":
    main()
