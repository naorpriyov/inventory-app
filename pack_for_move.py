"""
אריזת התוכנה והנתונים להעברה למחשב אחר.
יוצר קובץ zip על שולחן העבודה עם כל קבצי התוכנה, עותק עקבי של מסד הנתונים ומפתח הכניסות.
אפשר להריץ גם כשהשרת פועל: מסד הנתונים מועתק בצורה בטוחה.
"""
import os
import shutil
import sqlite3
import tempfile
import time
import zipfile

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("INV_DATA_DIR", os.path.join(BASE, "data"))
SKIP_DIRS = {"data", "backups", "__pycache__", ".git"}
SKIP_EXT = {".pyc"}


def main():
    stamp = time.strftime("%Y%m%d-%H%M")
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    out = os.path.join(desktop if os.path.isdir(desktop) else BASE, f"inventory-move-{stamp}.zip")
    with tempfile.TemporaryDirectory() as tmp:
        db_copy = os.path.join(tmp, "inventory.db")
        src = sqlite3.connect(os.path.join(DATA, "inventory.db"))
        dst = sqlite3.connect(db_copy)
        src.backup(dst)  # עותק עקבי גם בזמן שהשרת כותב
        ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
        dst.execute("PRAGMA journal_mode=DELETE")
        dst.close()
        src.close()
        if ok != "ok":
            raise SystemExit("בדיקת תקינות של מסד הנתונים נכשלה: " + ok)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for root, dirs, files in os.walk(BASE):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                for f in files:
                    p = os.path.join(root, f)
                    if os.path.splitext(f)[1] in SKIP_EXT or os.path.abspath(p) == os.path.abspath(out):
                        continue
                    z.write(p, os.path.join("inventory-app", os.path.relpath(p, BASE)))
            z.write(db_copy, "inventory-app/data/inventory.db")
            z.write(os.path.join(DATA, "secret.key"), "inventory-app/data/secret.key")
            z.writestr("inventory-app/data/.keep", "")
    print("נוצר הקובץ:", out)
    print("הקובץ מכיל נתונים רגישים. העבירו אותו רק בדרך מאובטחת, ומחקו אותו אחרי ההעברה.")


if __name__ == "__main__":
    main()
