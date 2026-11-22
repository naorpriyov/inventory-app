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
SKIP_DIRS = {"data", "backups", "logs", "__pycache__", ".git"}
SKIP_EXT = {".pyc"}


def main(out_dir=None):
    """out_dir: where to save (e.g. a USB drive "D:\\"). Default: the Desktop."""
    stamp = time.strftime("%Y%m%d-%H%M")
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    target = out_dir or (desktop if os.path.isdir(desktop) else BASE)
    out = os.path.join(target, f"inventory-move-{stamp}.zip")
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
            if os.path.exists(os.path.join(DATA, "vapid_private.pem")):  # מפתח ההתראות לטלפון
                z.write(os.path.join(DATA, "vapid_private.pem"), "inventory-app/data/vapid_private.pem")
            rep = os.path.join(DATA, "reports")
            if os.path.isdir(rep):  # הדוחות החודשיים שנשמרו
                for f in os.listdir(rep):
                    z.write(os.path.join(rep, f), "inventory-app/data/reports/" + f)
            z.writestr("inventory-app/data/.keep", "")
            auto = os.path.join(BASE, "backups", "auto")
            if os.path.isdir(auto):  # הגיבויים היומיים, כדי שאפשר יהיה לשחזר גם במחשב החדש
                for f in os.listdir(auto):
                    if f.endswith(".db"):
                        z.write(os.path.join(auto, f), "inventory-app/backups/auto/" + f)
    print("נוצר הקובץ:", out)
    print("הקובץ מכיל נתונים רגישים. העבירו אותו רק בדרך מאובטחת, ומחקו אותו אחרי ההעברה.")


if __name__ == "__main__":
    import sys
    main(sys.argv[1] if len(sys.argv) > 1 else None)
