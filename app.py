"""
ניהול מלאי – שרת עצמאי (Flask + SQLite)
הרצה:  python app.py      ואז לפתוח  http://localhost:8000
"""
import json
import os
import re
import secrets
import sqlite3
import time
import unicodedata
from functools import wraps

from flask import Flask, g, jsonify, redirect, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
DATA = os.environ.get("INV_DATA_DIR", os.path.join(BASE, "data"))
DB_PATH = os.path.join(DATA, "inventory.db")
os.makedirs(DATA, exist_ok=True)


def _secret_key():
    p = os.path.join(DATA, "secret.key")
    if not os.path.exists(p):
        with open(p, "w") as f:
            f.write(secrets.token_hex(32))
    with open(p) as f:
        return f.read().strip()


app = Flask(__name__, static_folder=None)
app.secret_key = _secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("INV_HTTPS") == "1",
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,
    MAX_CONTENT_LENGTH=4 * 1024 * 1024,
)

# ---------------------------------------------------------------- database
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def _close(_):
    d = g.pop("db", None)
    if d is not None:
        d.close()


def init_db():
    con = sqlite3.connect(DB_PATH)
    con.executescript(
        """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users(
            id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
            pw TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created REAL);
        CREATE TABLE IF NOT EXISTS docs(
            path TEXT PRIMARY KEY, parent TEXT NOT NULL, data TEXT,
            deleted INTEGER NOT NULL DEFAULT 0, updated REAL NOT NULL, by TEXT);
        CREATE INDEX IF NOT EXISTS docs_updated ON docs(updated);
        CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);
        CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
        """
    )
    con.commit()
    con.close()


def setting(k, default=None):
    r = db().execute("SELECT v FROM settings WHERE k=?", (k,)).fetchone()
    return r["v"] if r else default


def set_setting(k, v):
    db().execute("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))
    db().commit()


def new_invite():
    code = secrets.token_hex(3).upper()
    set_setting("invite", code)
    return code


# ---------------------------------------------------------------- users
def pw_ver(u):
    """טביעה קצרה של הסיסמה. כשהסיסמה מוחלפת, כל החיבורים הקודמים של המשתמש מתנתקים."""
    return u["pw"][-12:]


def start_session(u):
    session.clear()
    session.permanent = True
    session["uid"] = u["id"]
    session["pv"] = pw_ver(u)


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    u = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u or u["role"] == "blocked":
        return None
    pv = session.get("pv")
    if pv is None:
        session["pv"] = pw_ver(u)  # חיבור מגרסה קודמת
    elif pv != pw_ver(u):
        return None
    return u


# ---------------------------------------------------------------- brute-force protection
FAILS = {}  # key -> [count, first_ts]
FAIL_WINDOW = 15 * 60


def client_ip():
    ip = request.remote_addr or ""
    # מאחורי Tailscale Funnel הבקשה מגיעה מהמחשב עצמו, והכתובת האמיתית בכותרת
    if ip in ("127.0.0.1", "::1"):
        ip = (request.headers.get("X-Forwarded-For") or ip).split(",")[0].strip()
    return ip


def too_many(*keys_limits):
    now = time.time()
    for key, limit in keys_limits:
        c = FAILS.get(key)
        if c and now - c[1] < FAIL_WINDOW and c[0] >= limit:
            return True
    return False


def add_fail(*keys):
    now = time.time()
    for key in keys:
        c = FAILS.get(key)
        if not c or now - c[1] >= FAIL_WINDOW:
            FAILS[key] = [1, now]
        else:
            c[0] += 1
    if len(FAILS) > 5000:
        for k in [k for k, c in FAILS.items() if now - c[1] >= FAIL_WINDOW]:
            FAILS.pop(k, None)


LOCKED_MSG = "יותר מדי ניסיונות שגויים. נסו שוב בעוד 15 דקות."


def body():
    b = request.get_json(silent=True)
    return b if isinstance(b, dict) else {}


def is_owner(u):
    return u is not None and u["role"] == "owner"


def api_login_required(fn):
    @wraps(fn)
    def w(*a, **kw):
        u = current_user()
        if not u:
            return jsonify(error="נדרשת התחברות", code="unauthenticated"), 401
        g.user = u
        return fn(*a, **kw)
    return w


def owner_required(fn):
    @wraps(fn)
    @api_login_required
    def w(*a, **kw):
        if not is_owner(g.user):
            return jsonify(error="רק מנהל המערכת", code="invalid_argument"), 403
        return fn(*a, **kw)
    return w


def users_count():
    return db().execute("SELECT COUNT(*) c FROM users").fetchone()["c"]


MIN_PW = 7  # אורך מינימלי לסיסמה
PW_MSG = f"הסיסמה צריכה להכיל לפחות {MIN_PW} תווים."

# שם משתמש: אותיות בעברית או באנגלית, ספרות, נקודה, מקף או קו תחתון
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-א-ת]{3,32}$")


def norm_username(s):
    """מאחד צורות כתיבה שונות של אותו שם, כדי שהכניסה תעבוד מכל מקלדת."""
    return unicodedata.normalize("NFC", str(s or "")).strip()


def validate_new_user(username, name, password):
    if not USERNAME_RE.match(norm_username(username)):
        return "שם משתמש: 3 עד 32 תווים, אותיות בעברית או באנגלית, ספרות, נקודה, מקף או קו תחתון. בלי רווחים."
    if not (name or "").strip():
        return "יש למלא שם מלא."
    if len(password or "") < MIN_PW:
        return PW_MSG
    if db().execute("SELECT 1 FROM users WHERE username=?", (norm_username(username),)).fetchone():
        return "שם המשתמש כבר תפוס."
    return None


def create_user(username, name, password, role):
    uid = secrets.token_hex(8)
    db().execute(
        "INSERT INTO users(id,username,name,pw,role,created) VALUES(?,?,?,?,?,?)",
        (uid, norm_username(username), name.strip(), generate_password_hash(password), role, time.time()),
    )
    db().commit()
    return uid


# ---------------------------------------------------------------- permissions
def perm_key(uid):
    return "u_" + re.sub(r"[^A-Za-z0-9_-]", "_", uid)


def get_doc(path):
    r = db().execute("SELECT data,deleted FROM docs WHERE path=?", (path,)).fetchone()
    if not r or r["deleted"]:
        return None
    return json.loads(r["data"])


def approved_perm(u):
    p = get_doc("perms/" + perm_key(u["id"]))
    if not p or p.get("status") != "approved" or p.get("uid") != u["id"]:
        return None
    return p


def flags_of(u):
    p = approved_perm(u)
    if not p:
        return {}
    return p.get("flags") or {"lower": True}


# מסכי התוכנה. לכל עובד נקבעת לכל מסך רמת גישה: none (ללא), view (צפייה), full (מלאה)
TABS = ("dashboard", "inventory", "drugkits", "sign", "ledger", "count", "locations")


def tabs_of(u):
    if is_owner(u):
        return {t: "full" for t in TABS}
    p = approved_perm(u)
    t = (p or {}).get("tabs") or {}
    return {k: (t.get(k) if t.get(k) in ("view", "full") else "none") for k in TABS}


def has_any_access(u):
    return any(v != "none" for v in tabs_of(u).values())


def has_full(u, *tabs):
    t = tabs_of(u)
    return any(t[x] == "full" for x in (tabs or TABS))


def access_sig(u):
    """משתנה כשהרשאות המשתמש משתנות, כדי שהדפדפן יטען מחדש את הנתונים."""
    return json.dumps([u["role"], tabs_of(u)], sort_keys=True)


APPEND_ONLY = {"ledger", "counts", "cancels"}

# אוספים שהתוכנה משתמשת בהם. עובד לא יכול ליצור אוספים אחרים
COLLECTIONS = {"items", "kits", "locations", "catalog", "batches", "perms", "ledger", "counts",
               "cancels", "caregivers", "meta", "recon", "moves", "notes",
               "boxes", "boxtpl"}  # boxes = קופסאות ערכות סמים ממוספרות, boxtpl = תבנית התכולה לכל סדרה

# נתונים רגישים נשלחים רק למי שיש לו גישה (צפייה או מלאה) לאחד מהמסכים שצריכים אותם
READ_TABS = {
    "ledger": ("ledger",),            # ספר הסמים
    "cancels": ("ledger",),           # זיכויי פתקים
    "caregivers": ("sign",),          # שמות ומספרי זהות של מטפלים
    "counts": ("count", "dashboard"),  # ספירות מלאי
    "recon": ("dashboard",),
}


def can_read(u, path):
    if is_owner(u):
        return True
    seg = path.split("/")
    if seg[0] == "perms":
        return len(seg) >= 2 and seg[1] == perm_key(u["id"])  # רק בקשת ההרשאות של עצמו
    if not has_any_access(u):
        return False  # עובד בלי גישה לאף מסך לא מקבל נתונים
    if seg[0] == "notes" and len(seg) >= 2 and seg[1] != u["id"]:
        return False
    need = READ_TABS.get(seg[0])
    if need:
        t = tabs_of(u)
        return any(t[x] != "none" for x in need)
    return True


def can_write(u, path, data, op):
    """op: set | delete. Server-side rules; the owner may do everything."""
    if is_owner(u):
        return True
    seg = path.split("/")
    top = seg[0]
    if top not in COLLECTIONS:
        return False
    if top == "perms":
        return (
            op != "delete"
            and seg[1] == perm_key(u["id"])
            and isinstance(data, dict)
            and data.get("uid") == u["id"]
            and data.get("status") == "pending"
            and not data.get("flags")
            and not data.get("tabs")
        )
    # הרשאות לפי מסך: כתיבה רק למי שיש לו גישה מלאה למסך הרלוונטי
    if top == "notes":
        return op != "delete" and len(seg) >= 2 and seg[1] == u["id"] and has_full(u, "sign")
    if top == "counts" and not has_full(u, "count"):
        return False
    if top == "locations" and not has_full(u, "locations"):
        return False
    if top == "recon" and not has_full(u, "dashboard"):
        return False
    if top in ("boxes", "boxtpl") and not has_full(u, "drugkits"):
        return False
    if not has_full(u):
        return False  # צפייה בלבד בכל המסכים
    if top == "cancels":
        return False  # זיכוי פתק – מנהל בלבד
    if top in APPEND_ONLY:
        return op != "delete" and get_doc(path) is None  # רישום חדש בלבד, בלי שינוי או מחיקה
    if top in ("items", "kits", "locations", "boxes") and op == "delete":
        return bool(flags_of(u).get("edit"))
    return True


SEG_RE = re.compile(r"^[^/\s]{1,200}$")


def valid_doc_path(path):
    seg = (path or "").split("/")
    return len(seg) >= 2 and len(seg) % 2 == 0 and all(SEG_RE.match(s) for s in seg)


def write_doc(path, data, deleted=False):
    parent = path.rsplit("/", 1)[0]
    db().execute(
        """INSERT INTO docs(path,parent,data,deleted,updated,by) VALUES(?,?,?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET data=excluded.data, deleted=excluded.deleted,
           updated=excluded.updated, by=excluded.by""",
        (path, parent, None if deleted else json.dumps(data, ensure_ascii=False), 1 if deleted else 0, time.time(), g.user["id"]),
    )
    db().commit()


# ---------------------------------------------------------------- request guards
@app.before_request
def _csrf_guard():
    # בקשות ששומרות נתונים חייבות להיות JSON. טופס מאתר זר לא יכול לשלוח JSON בלי אישור הדפדפן
    if request.path.startswith("/api/") and request.method in ("POST", "PUT") and not request.is_json:
        return jsonify(error="בקשה לא תקינה", code="invalid_argument"), 415
    origin = request.headers.get("Origin")
    if origin and request.method not in ("GET", "HEAD", "OPTIONS") and origin.split("://", 1)[-1] != request.host:
        return jsonify(error="בקשה מאתר אחר נחסמה", code="invalid_argument"), 403


@app.after_request
def _security_headers(resp):
    h = resp.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Referrer-Policy", "same-origin")
    h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    h.setdefault("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'")
    if app.config["SESSION_COOKIE_SECURE"]:
        h.setdefault("Strict-Transport-Security", "max-age=31536000")
    if request.path.startswith("/api/"):
        h["Cache-Control"] = "no-store"
    return resp


# ---------------------------------------------------------------- pages
def static_page(name):
    resp = send_from_directory(STATIC, name)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/")
def home():
    if users_count() == 0:
        return redirect("/setup")
    if not current_user():
        return redirect("/login")
    return static_page("index.html")


@app.get("/login")
@app.get("/register")
@app.get("/setup")
def auth_pages():
    if request.path == "/setup" and users_count() > 0:
        return redirect("/login")
    return static_page("auth.html")


@app.get("/logout")
def logout():
    session.clear()
    return redirect("/login")


@app.get("/sw.js")
def sw():
    resp = static_page("sw.js")
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.get("/manifest.webmanifest")
def manifest():
    resp = send_from_directory(STATIC, "manifest.webmanifest", mimetype="application/manifest+json")
    return resp


@app.get("/static/<path:p>")
def static_files(p):
    return send_from_directory(STATIC, p)


# ---------------------------------------------------------------- auth api
@app.post("/api/setup")
def api_setup():
    if users_count() > 0:
        return jsonify(error="המערכת כבר הוגדרה."), 400
    b = body()
    err = validate_new_user(b.get("username"), b.get("name"), b.get("password"))
    if err:
        return jsonify(error=err), 400
    uid = create_user(b["username"], b["name"], b["password"], "owner")
    new_invite()
    start_session(db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
    return jsonify(ok=True)


@app.post("/api/login")
def api_login():
    b = body()
    name = norm_username(b.get("username"))
    ip_key, user_key = "ip:" + client_ip(), "user:" + name.lower()
    if too_many((ip_key, 20), (user_key, 8)):
        return jsonify(error=LOCKED_MSG), 429
    u = db().execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
    if not u or not check_password_hash(u["pw"], str(b.get("password") or "")):
        add_fail(ip_key, user_key)
        time.sleep(0.6)
        return jsonify(error="שם משתמש או סיסמה שגויים."), 401
    if u["role"] == "blocked":
        return jsonify(error="החשבון חסום. פנו למנהל המערכת."), 403
    FAILS.pop(user_key, None)
    start_session(u)
    return jsonify(ok=True)


@app.post("/api/register")
def api_register():
    b = body()
    ip_key = "reg:" + client_ip()
    if too_many((ip_key, 10)):
        return jsonify(error=LOCKED_MSG), 429
    code = str(b.get("invite") or "").strip().upper()
    if not code or not secrets.compare_digest(code, setting("invite") or ""):
        add_fail(ip_key)
        return jsonify(error="קוד ההרשמה שגוי. בקשו את הקוד ממנהל המערכת."), 400
    # ההרשמה בלי שם מלא: שם המשתמש משמש גם כשם שמוצג בתוכנה
    b["name"] = str(b.get("name") or "").strip() or norm_username(b.get("username"))
    err = validate_new_user(b.get("username"), b.get("name"), b.get("password"))
    if err:
        return jsonify(error=err), 400
    uid = create_user(b["username"], b["name"], b["password"], "user")
    # בקשת הרשאות נשלחת למנהל אוטומטית, כדי שהעובד יופיע אצלו ב"בקשות ממתינות"
    g.user = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    key = perm_key(uid)
    write_doc("perms/" + key, {"id": key, "uid": uid, "name": b["name"].strip(), "status": "pending", "at": int(time.time() * 1000)})
    start_session(g.user)
    return jsonify(ok=True)


@app.get("/api/me")
@api_login_required
def api_me():
    u = g.user
    return jsonify(id=u["id"], name=u["name"], username=u["username"], isOwner=is_owner(u))


@app.post("/api/me/password")
@api_login_required
def api_change_password():
    b = body()
    user_key = "pw:" + g.user["id"]
    if too_many((user_key, 8)):
        return jsonify(error=LOCKED_MSG), 429
    if not check_password_hash(g.user["pw"], str(b.get("old") or "")):
        add_fail(user_key)
        return jsonify(error="הסיסמה הנוכחית שגויה."), 400
    new = str(b.get("new") or "")
    if len(new) < MIN_PW:
        return jsonify(error=PW_MSG), 400
    db().execute("UPDATE users SET pw=? WHERE id=?", (generate_password_hash(new), g.user["id"]))
    db().commit()
    # החיבורים במכשירים אחרים מתנתקים, החיבור הנוכחי נשאר
    start_session(db().execute("SELECT * FROM users WHERE id=?", (g.user["id"],)).fetchone())
    return jsonify(ok=True)


# ---------------------------------------------------------------- admin api
@app.get("/api/admin/users")
@owner_required
def admin_users():
    rows = db().execute("SELECT id,username,name,role,created FROM users ORDER BY created").fetchall()
    return jsonify(users=[dict(r) for r in rows], invite=setting("invite") or new_invite(),
                   lastBackup=last_backup(), backups=len(list_backups()))


@app.post("/api/admin/invite")
@owner_required
def admin_invite():
    return jsonify(invite=new_invite())


@app.post("/api/admin/users/<uid>")
@owner_required
def admin_user_update(uid):
    b = body()
    u = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        return jsonify(error="המשתמש לא נמצא."), 404
    if uid == g.user["id"] and b.get("role") and b["role"] != "owner":
        return jsonify(error="אי אפשר להוריד לעצמך את הרשאות המנהל."), 400
    if "password" in b:
        if not isinstance(b["password"], str) or len(b["password"]) < MIN_PW:
            return jsonify(error=PW_MSG), 400
        db().execute("UPDATE users SET pw=? WHERE id=?", (generate_password_hash(b["password"]), uid))
    if b.get("role") in ("user", "owner", "blocked"):
        db().execute("UPDATE users SET role=? WHERE id=?", (b["role"], uid))
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- data api
@app.get("/api/changes")
@api_login_required
def api_changes():
    try:
        since = float(request.args.get("since", "0")) - 2.0  # חפיפה קטנה כדי לא לפספס כתיבות
    except ValueError:
        since = 0
    now = time.time()
    rows = db().execute("SELECT path,data,deleted,updated FROM docs WHERE updated>? ORDER BY updated", (since,)).fetchall()
    out = []
    for r in rows:
        if not can_read(g.user, r["path"]):
            continue
        out.append({"path": r["path"], "deleted": bool(r["deleted"]), "data": None if r["deleted"] else json.loads(r["data"])})
    return jsonify(now=now, docs=out, access=access_sig(g.user))


@app.put("/api/doc")
@api_login_required
def api_put():
    b = body()
    path, data = b.get("path"), b.get("data")
    if not valid_doc_path(path) or not isinstance(data, dict):
        return jsonify(error="נתיב או נתונים לא תקינים", code="invalid_argument"), 400
    if b.get("merge"):
        cur = get_doc(path) or {}
        cur.update(data)
        data = cur
    if not can_write(g.user, path, data, "set"):
        return jsonify(error="אין לך הרשאה לפעולה הזו", code="invalid_argument"), 403
    write_doc(path, data)
    return jsonify(ok=True, data=data)


@app.delete("/api/doc")
@api_login_required
def api_delete():
    path = request.args.get("path", "")
    if not valid_doc_path(path):
        return jsonify(error="נתיב לא תקין", code="invalid_argument"), 400
    if not can_write(g.user, path, None, "delete"):
        return jsonify(error="אין לך הרשאה לפעולה הזו", code="invalid_argument"), 403
    write_doc(path, None, deleted=True)
    return jsonify(ok=True)


# ---------------------------------------------------------------- automatic backup
BACKUP_DIR = os.environ.get("INV_BACKUP_DIR", os.path.join(BASE, "backups", "auto"))
BACKUP_KEEP = int(os.environ.get("INV_BACKUP_KEEP", "30"))
BACKUP_RE = re.compile(r"^inventory-(\d{4}-\d{2}-\d{2})\.db$")


def list_backups():
    if not os.path.isdir(BACKUP_DIR):
        return []
    return sorted(f for f in os.listdir(BACKUP_DIR) if BACKUP_RE.match(f))


def daily_backup():
    """עותק אחד ליום של מסד הנתונים. נשמרים BACKUP_KEEP הימים האחרונים."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    name = "inventory-" + time.strftime("%Y-%m-%d") + ".db"
    final = os.path.join(BACKUP_DIR, name)
    if os.path.exists(final):
        return None
    tmp = final + ".part"
    src = sqlite3.connect(DB_PATH, timeout=30)
    dst = sqlite3.connect(tmp)
    try:
        src.backup(dst)  # עותק עקבי גם בזמן שהשרת כותב
        ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
        dst.execute("PRAGMA journal_mode=DELETE")
    finally:
        dst.close()
        src.close()
    if ok != "ok":
        os.remove(tmp)
        raise RuntimeError("integrity check failed: " + ok)
    os.replace(tmp, final)
    for old in list_backups()[:-BACKUP_KEEP]:
        os.remove(os.path.join(BACKUP_DIR, old))
    return final


def last_backup():
    b = list_backups()
    if not b:
        return None
    return int(os.path.getmtime(os.path.join(BACKUP_DIR, b[-1])) * 1000)


def backup_loop():
    while True:
        try:
            done = daily_backup()
            if done:
                print("גיבוי אוטומטי נשמר:", done, flush=True)
        except Exception as e:  # לא מפילים את השרת בגלל גיבוי
            print("הגיבוי האוטומטי נכשל:", e, flush=True)
        time.sleep(60 * 60)  # בודקים כל שעה אם כבר יש גיבוי להיום


# ---------------------------------------------------------------- run
init_db()

if __name__ == "__main__":
    host = os.environ.get("INV_HOST", "0.0.0.0")
    port = int(os.environ.get("INV_PORT") or os.environ.get("PORT") or "8000")  # PORT – Render וכד'
    print(f"ניהול מלאי פועל: http://localhost:{port}")
    import threading
    threading.Thread(target=backup_loop, daemon=True).start()
    try:
        from waitress import serve
        serve(app, host=host, port=port, threads=8)
    except ImportError:
        app.run(host=host, port=port)
