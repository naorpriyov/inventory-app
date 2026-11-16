"""
בדיקות אוטומטיות לשרת. מריצים לפני כל עדכון:  python tests/run_tests.py
הבדיקות מפעילות שרת זמני על מסד נתונים ריק בתיקייה זמנית, כך שהנתונים האמיתיים לא נוגעים.
"""
import http.cookiejar
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PW = "Test-pass-1234"
results = []


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, base):
        self.base = base
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, headers=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        h = {"Content-Type": "application/json"}
        h.update(headers or {})
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.op.open(r, timeout=20) as resp:
                return resp.status, json.loads(resp.read() or b"{}"), resp.headers
        except urllib.error.HTTPError as e:
            try:
                j = json.loads(e.read() or b"{}")
            except Exception:
                j = {}
            return e.code, j, e.headers

    def put(self, path, data):
        return self.call("PUT", "/api/doc", {"path": path, "data": data})[0]

    def docs(self):
        return {d["path"]: d["data"] for d in self.call("GET", "/api/changes?since=0")[1]["docs"] if not d["deleted"]}


def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name, flush=True)


def section(t):
    print(f"\n== {t}", flush=True)


def run(base):
    owner = Client(base)
    section("הגדרה והרשמה")
    check("יצירת מנהל", owner.call("POST", "/api/setup", {"username": "owner_t", "name": "Owner", "password": PW})[0] == 200)
    invite = owner.call("GET", "/api/admin/users")[1]["invite"]
    emp = Client(base)
    check("הרשמה בלי שם מלא, שם משתמש בעברית", emp.call("POST", "/api/register", {"invite": invite, "username": "עובד.בדיקה", "password": "abcdefg"})[0] == 200)
    me = emp.call("GET", "/api/me")[1]
    key = "u_" + me["id"]
    check("השם שמוצג הוא שם המשתמש", me.get("name") == "עובד.בדיקה")
    check("בקשת הרשאות נוצרה אוטומטית", owner.docs().get("perms/" + key, {}).get("status") == "pending")
    check("סיסמה של 6 תווים נדחית", Client(base).call("POST", "/api/register", {"invite": invite, "username": "short", "password": "abcdef"})[0] == 400)
    check("קוד הרשמה שגוי נדחה", Client(base).call("POST", "/api/register", {"invite": "WRONG1", "username": "x_y", "password": "abcdefg"})[0] == 400)

    section("הרשאות לפי מסך")
    owner.put("items/i1", {"id": "i1", "name": "מורפיום", "sku": "960003470", "batch": "M1", "exp": "2030-01-01", "qty": 10, "loc": "כספת קידמית"})
    owner.put("caregivers/c1", {"id": "c1", "name": "מטפל", "idNum": "123"})
    check("לא מאושר: לא רואה נתונים", set(emp.docs()) == {"perms/" + key})
    check("לא יכול לתת לעצמו הרשאות", emp.put("perms/" + key, {"id": key, "uid": me["id"], "name": "x", "status": "pending", "tabs": {"inventory": "full"}}) == 403)
    perm = {"id": key, "uid": me["id"], "name": "עובד.בדיקה", "status": "approved", "flags": {"receive": True, "lower": True, "edit": False, "count": True},
            "tabs": {t: "none" for t in ["dashboard", "inventory", "drugkits", "sign", "ledger", "count", "locations"]}}
    perm["tabs"]["inventory"] = "view"
    owner.put("perms/" + key, perm)
    d = emp.docs()
    check("צפייה: רואה מלאי", "items/i1" in d)
    check("צפייה: לא יכול לשנות מלאי", emp.put("items/i1", {"id": "i1", "name": "מורפיום", "qty": 9}) == 403)
    check("בלי גישה להחתמה: לא רואה מספרי זהות", not any(p.startswith("caregivers/") for p in d))
    perm["tabs"].update(inventory="full", drugkits="view")
    owner.put("perms/" + key, perm)
    check("פקלי סמים בצפייה: לא יכול לשנות פקל", emp.put("boxes/SA1", {"id": "SA1", "status": "empty"}) == 403)
    perm["tabs"]["drugkits"] = "full"
    owner.put("perms/" + key, perm)
    check("פקלי סמים בגישה מלאה: יכול לשנות פקל", emp.put("boxes/SA1", {"id": "SA1", "series": "SA", "n": 1, "status": "empty", "loc": "כספת קידמית", "contents": []}) == 200)
    check("בלי הרשאת עריכה: לא יכול למחוק פקל", emp.call("DELETE", "/api/doc?path=boxes/SA1")[0] == 403)
    check("אוסף לא מוכר נחסם", emp.put("junk/x", {"a": 1}) == 403)

    section("שלמות ספר הסמים")
    check("כמות שלילית במלאי נדחית", emp.put("items/i1", {"id": "i1", "name": "מורפיום", "qty": -1}) == 400)
    check("כמות לא שלמה נדחית", emp.put("items/i1", {"id": "i1", "name": "מורפיום", "qty": 1.5}) == 400)
    emp.put("items/i1", {"id": "i1", "name": "מורפיום", "sku": "960003470", "batch": "M1", "exp": "2030-01-01", "qty": 7, "loc": "כספת קידמית"})
    emp.put("boxes/SA1", {"id": "SA1", "series": "SA", "n": 1, "status": "vault", "loc": "כספת קידמית", "contents": [{"name": "מורפיום", "qty": 3, "batch": "M1", "exp": "2030-01-01"}]})
    fake = {"id": "g1", "name": "מורפיום", "type": "out", "outQty": 3, "balance": 999, "kitBalance": 999, "at": 1, "by": "someone-else"}
    check("רישום בספר הסמים נשמר", emp.put("ledger/g1", fake) == 200)
    g1 = owner.docs()["ledger/g1"]
    check("השרת קבע את יתרת המלאי (7) ולא את מה שהדפדפן שלח", g1["balance"] == 7)
    check("השרת קבע את המלאי בערכות (3)", g1["kitBalance"] == 3)
    check("השרת קבע את המשתמש ואת הזמן", g1["by"] == me["id"] and g1["byUser"] == "עובד.בדיקה" and g1["at"] > 1)
    check("אי אפשר לשנות רישום קיים", emp.put("ledger/g1", dict(fake, outQty=1)) == 403)
    check("כמות שלילית בספר הסמים נדחית", emp.put("ledger/g2", {"id": "g2", "name": "מורפיום", "type": "out", "outQty": -2}) == 400)
    check("רישום בלי שם סם נדחה", emp.put("ledger/g3", {"id": "g3", "type": "out", "outQty": 1}) == 400)

    section("יומן ביקורת")
    rows = owner.call("GET", "/api/admin/audit?limit=500")[1].get("rows", [])
    check("היומן כולל את השינויים", any(r["path"] == "ledger/g1" and r["username"] == "עובד.בדיקה" for r in rows))
    check("היומן כולל כניסות", any(r["op"] == "login" for r in rows) or any(r["op"] == "set" for r in rows))
    check("עובד לא יכול לקרוא את היומן", emp.call("GET", "/api/admin/audit")[0] == 403)

    section("אבטחה")
    check("בקשה שאינה JSON נדחית", emp.call("POST", "/api/me/password", raw=b"old=a&new=b", headers={"Content-Type": "application/x-www-form-urlencoded"})[0] == 415)
    check("בקשה מאתר זר נחסמת", emp.call("PUT", "/api/doc", {"path": "items/z", "data": {"id": "z"}}, headers={"Origin": "https://evil.example"})[0] == 403)
    h = owner.call("GET", "/api/me")[2]
    check("כותרות אבטחה", h.get("X-Frame-Options") == "DENY" and h.get("X-Content-Type-Options") == "nosniff")
    emp2 = Client(base)
    emp2.call("POST", "/api/login", {"username": "עובד.בדיקה", "password": "abcdefg"})
    emp.call("POST", "/api/me/password", {"old": "abcdefg", "new": "abcdefgh"})
    check("החלפת סיסמה מנתקת מכשירים אחרים", emp2.call("GET", "/api/me")[0] == 401 and emp.call("GET", "/api/me")[0] == 200)
    atk = Client(base)
    codes = [atk.call("POST", "/api/login", {"username": "owner_t", "password": "wrong-%d" % i})[0] for i in range(9)]
    check("נעילה אחרי 8 סיסמאות שגויות", codes[:8] == [401] * 8 and codes[8] == 429)
    page = urllib.request.urlopen(base + "/login", timeout=10).read().decode()
    check("עמוד הכניסה משתמש בגופן המקומי", "/static/fonts/rubik.css" in page and "googleapis" not in page)


def main():
    tmp = tempfile.mkdtemp(prefix="inv-test-")
    port = free_port()
    env = dict(os.environ, INV_DATA_DIR=tmp, INV_PORT=str(port), INV_HOST="127.0.0.1", INV_BACKUP_DIR=os.path.join(tmp, "backups"), PYTHONIOENCODING="utf-8")
    env.pop("INV_HTTPS", None)
    srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "app.py")], env=env, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(base + "/login", timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        run(base)
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=10)
        except subprocess.TimeoutExpired:
            srv.kill()
        shutil.rmtree(tmp, ignore_errors=True)
    ok = sum(1 for _, c in results if c)
    print(f"\n{ok}/{len(results)} passed")
    sys.exit(0 if ok == len(results) else 1)


if __name__ == "__main__":
    main()
