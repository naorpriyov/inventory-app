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
from datetime import datetime
import unicodedata
from functools import wraps

from flask import Flask, g, jsonify, redirect, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

import push_notify
import reports

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
        CREATE TABLE IF NOT EXISTS audit(
            id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, uid TEXT, username TEXT,
            op TEXT NOT NULL, path TEXT, data TEXT);
        CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
        CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, uid TEXT NOT NULL, sub TEXT NOT NULL, created REAL);
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
TABS = ("dashboard", "inventory", "drugkits", "sign", "ledger", "sap", "count", "locations")


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


APPEND_ONLY = {"ledger", "counts", "cancels", "sap"}  # sap = עדכוני מלאי סאפ (נשמרים כרצף, לא נמחקים)

# אוספים שהתוכנה משתמשת בהם. עובד לא יכול ליצור אוספים אחרים
COLLECTIONS = {"items", "kits", "locations", "catalog", "batches", "perms", "ledger", "counts",
               "cancels", "caregivers", "meta", "recon", "moves", "notes",
               "boxes", "boxtpl",  # boxes = קופסאות פקלי סמים ממוספרות, boxtpl = תבנית התכולה לכל סדרה
               "sap", "sapmeta"}  # sap = מלאי סאפ שהוזן ידנית, sapmeta = עד איזה תאריך הצריכה כבר ירדה בסאפ

# נתונים רגישים נשלחים רק למי שיש לו גישה (צפייה או מלאה) לאחד מהמסכים שצריכים אותם
READ_TABS = {
    "ledger": ("ledger", "sap"),     # ספר הסמים (ההשוואה לסאפ צריכה את הצריכה)
    "cancels": ("ledger",),           # זיכויי פתקים
    "caregivers": ("sign",),          # שמות ומספרי זהות של מטפלים
    "counts": ("count", "dashboard"),  # ספירות מלאי
    "recon": ("dashboard",),
    "sap": ("sap", "dashboard"),
    "sapmeta": ("sap", "dashboard"),
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
    """op: set | delete. Server-side rules; the owner may do everything except change history."""
    # ספר הסמים, ספירות, זיכויים ועדכוני סאפ: רישום חדש בלבד. אף אחד, גם לא המנהל, לא משנה או מוחק אותם
    if path.split("/")[0] in APPEND_ONLY and (op == "delete" or get_doc(path) is not None):
        return False
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
    if top in ("sap", "sapmeta") and not has_full(u, "sap"):
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


def audit(op, path=None, data=None, user=None, commit=True):
    """יומן ביקורת: כל שינוי נרשם עם מי ומתי. אין שום דרך למחוק או לשנות רשומות ביומן."""
    u = user if user is not None else getattr(g, "user", None)
    db().execute("INSERT INTO audit(at,uid,username,op,path,data) VALUES(?,?,?,?,?,?)",
                 (time.time(), u["id"] if u else None, u["username"] if u else None, op, path,
                  None if data is None else json.dumps(data, ensure_ascii=False)))
    if commit:
        db().commit()


def write_doc(path, data, deleted=False):
    parent = path.rsplit("/", 1)[0]
    before = get_doc(path) if deleted else None
    audit("delete" if deleted else "set", path, before if deleted else data, commit=False)
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
def asset_version():
    """חותמת גרסה לפי זמן השינוי של קבצי העיצוב והקוד, כדי שהדפדפן תמיד יטען את הגרסה החדשה."""
    m = 0
    for d in ("css", "js", "vendor", "fonts"):
        folder = os.path.join(STATIC, d)
        if os.path.isdir(folder):
            for f in os.listdir(folder):
                m = max(m, os.path.getmtime(os.path.join(folder, f)))
    return str(int(m))


def static_page(name):
    if name.endswith(".html"):
        with open(os.path.join(STATIC, name), encoding="utf-8") as f:
            html = f.read().replace("__V__", asset_version())
        resp = app.response_class(html, mimetype="text/html")
    else:
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
        audit("login-failed", None, {"username": name})
        time.sleep(0.6)
        return jsonify(error="שם משתמש או סיסמה שגויים."), 401
    if u["role"] == "blocked":
        return jsonify(error="החשבון חסום. פנו למנהל המערכת."), 403
    FAILS.pop(user_key, None)
    start_session(u)
    audit("login", None, None, user=u)
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
    audit("user-update", "users/" + uid, {"role": b.get("role"), "password_reset": "password" in b}, commit=False)
    db().commit()
    return jsonify(ok=True)



# ---------------------------------------------------------------- ledger integrity
def _live_docs(prefix, con=None):
    c = con or db()
    if "%" in prefix:
        rows = c.execute("SELECT data FROM docs WHERE parent LIKE ? AND deleted=0", (prefix,)).fetchall()
    else:
        rows = c.execute("SELECT data FROM docs WHERE parent=? AND deleted=0", (prefix,)).fetchall()
    out = []
    for r in rows:
        try:
            out.append(json.loads(r["data"]))
        except Exception:
            pass
    return out


def free_stock(name):
    return sum(int(i.get("qty") or 0) for i in _live_docs("items") if i.get("name") == name)


def kit_stock(name):
    t = 0
    for k in _live_docs("kits"):
        if k.get("status") != "issued":
            t += sum(int(c.get("qty") or 0) for c in (k.get("contents") or []) if c.get("name") == name)
    for b in _live_docs("boxes"):
        if b.get("status") != "empty":
            t += sum(int(c.get("qty") or 0) for c in (b.get("contents") or []) if c.get("name") == name)
    return t


def seal_ledger(data):
    """רישום בספר הסמים: השרת קובע בעצמו את הזמן, את המשתמש ואת היתרות, ולא סומך על הדפדפן."""
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        return "רישום בספר הסמים חייב שם סם"
    for f in ("inQty", "outQty", "counted"):
        v = data.get(f)
        if v in (None, ""):
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 or v != int(v):
            return "כמות לא תקינה בספר הסמים"
    data["at"] = int(time.time() * 1000)
    data["by"] = g.user["id"]
    data["byUser"] = g.user["username"]
    data["balance"] = free_stock(name)
    data["kitBalance"] = kit_stock(name)
    data["sealed"] = True
    return None


@app.get("/api/admin/audit")
@owner_required
def admin_audit():
    try:
        limit = max(1, min(int(request.args.get("limit", "200")), 1000))
        before = int(request.args.get("before", "0"))
    except ValueError:
        return jsonify(error="פרמטר לא תקין"), 400
    q = (request.args.get("q") or "").strip()
    sql = "SELECT id,at,username,op,path,data FROM audit WHERE 1=1"
    args = []
    if before:
        sql += " AND id<?"; args.append(before)
    if q:
        sql += " AND (path LIKE ? OR username LIKE ? OR data LIKE ?)"; args += [f"%{q}%"] * 3
    sql += " ORDER BY id DESC LIMIT ?"; args.append(limit)
    rows = [dict(r) for r in db().execute(sql, args).fetchall()]
    return jsonify(rows=rows)

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
    top = path.split("/")[0]
    if top == "items":
        q = data.get("qty", 0)
        if isinstance(q, bool) or not isinstance(q, (int, float)) or q < 0 or q != int(q):
            return jsonify(error="כמות לא תקינה: מספר שלם, 0 ומעלה", code="invalid_argument"), 400
    if top == "ledger" and len(path.split("/")) == 2:
        err = seal_ledger(data)
        if err:
            return jsonify(error=err, code="invalid_argument"), 400
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



# ---------------------------------------------------------------- monthly report
REPORT_DIR = os.path.join(DATA, "reports")


def report_docs(con=None):
    return {"items": _live_docs("items", con), "ledger": _live_docs("ledger", con), "boxes": _live_docs("boxes", con),
            "kits": _live_docs("kits", con), "notes": _live_docs("notes/%/n", con),
            "sap": _live_docs("sap", con), "sapmeta": _live_docs("sapmeta", con)}


def can_see_reports(u):
    return is_owner(u) or tabs_of(u)["ledger"] != "none"


@app.get("/report")
def report_page():
    u = current_user()
    if not u:
        return redirect("/login")
    g.user = u
    if not can_see_reports(u):
        return "אין לך הרשאה לדוחות. פנו למנהל המערכת.", 403
    try:
        y, m = map(int, (request.args.get("month") or "%04d-%02d" % reports.prev_month()).split("-"))
        assert 2000 <= y <= 2100 and 1 <= m <= 12
    except Exception:
        return "חודש לא תקין", 400
    resp = app.response_class(reports.build(y, m, report_docs()), mimetype="text/html")
    resp.headers["Cache-Control"] = "no-store"
    return resp


def monthly_report_job():
    """בתחילת כל חודש נשמר קובץ של הדוח של החודש הקודם בתיקייה data/reports."""
    y, m = reports.prev_month()
    path = os.path.join(REPORT_DIR, "report-%04d-%02d.html" % (y, m))
    if os.path.exists(path):
        return None
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    try:
        docs = report_docs(con)
    finally:
        con.close()
    if not docs["ledger"]:
        return None
    os.makedirs(REPORT_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(reports.build(y, m, docs))
    return (y, m, path)


# ---------------------------------------------------------------- phone notifications (web push)
VAPID_KEY, VAPID_PUBLIC = push_notify.load_keys(DATA)


@app.get("/api/push/key")
@api_login_required
def push_key():
    return jsonify(key=VAPID_PUBLIC)


@app.post("/api/push/subscribe")
@api_login_required
def push_subscribe():
    sub = body().get("sub")
    if not (isinstance(sub, dict) and isinstance(sub.get("endpoint"), str) and sub["endpoint"].startswith("https://")
            and isinstance(sub.get("keys"), dict)):
        return jsonify(error="מנוי לא תקין"), 400
    db().execute("INSERT INTO push_subs(endpoint,uid,sub,created) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET uid=excluded.uid, sub=excluded.sub",
                 (sub["endpoint"], g.user["id"], json.dumps(sub), time.time()))
    db().commit()
    audit("push-on", None, None)
    return jsonify(ok=True)


@app.post("/api/push/unsubscribe")
@api_login_required
def push_unsubscribe():
    ep = str(body().get("endpoint") or "")
    db().execute("DELETE FROM push_subs WHERE endpoint=? AND uid=?", (ep, g.user["id"]))
    db().commit()
    return jsonify(ok=True)


@app.post("/api/push/test")
@api_login_required
def push_test():
    n = notify_users({"title": "ניהול מלאי", "body": "ההתראות פועלות במכשיר הזה.", "url": "/"}, only_uid=g.user["id"])
    return jsonify(ok=True, sent=n)


def notify_users(payload, only_uid=None, want=None, con=None):
    """Sends to every subscribed device of users that pass want(user). Returns how many were delivered."""
    own = con is None
    c = con or sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    sent = 0
    try:
        claim = push_notify.contact(BASE)
        for r in c.execute("SELECT p.endpoint, p.sub, u.* FROM push_subs p JOIN users u ON u.id=p.uid WHERE u.role!='blocked'").fetchall():
            if only_uid and r["id"] != only_uid:
                continue
            if want and not want(r, c):
                continue
            res = push_notify.send(json.loads(r["sub"]), payload, VAPID_KEY, claim)
            if res == "ok":
                sent += 1
            elif res == "gone":
                c.execute("DELETE FROM push_subs WHERE endpoint=?", (r["endpoint"],))
                c.commit()
            else:
                print("push:", res, flush=True)
    finally:
        if own:
            c.close()
    return sent


def _tabs_with(u, c):
    """tabs_of() for a background job (no request context)."""
    if u["role"] == "owner":
        return {t: "full" for t in TABS}
    key = perm_key(u["id"])
    r = c.execute("SELECT data,deleted FROM docs WHERE path=?", ("perms/" + key,)).fetchone()
    p = json.loads(r["data"]) if r and not r["deleted"] else {}
    if p.get("status") != "approved" or p.get("uid") != u["id"]:
        return {t: "none" for t in TABS}
    t = p.get("tabs") or {}
    return {k: (t.get(k) if t.get(k) in ("view", "full") else "none") for k in TABS}


def on_monthly_report(y, m):
    notify_users({"title": "הדוח החודשי מוכן", "body": f"הדוח של {reports.MONTHS[m - 1]} {y} נשמר. לחצו לפתיחה.",
                  "url": "/report?month=%04d-%02d" % (y, m), "tag": "monthly-report"},
                 want=lambda u, c: _tabs_with(u, c)["ledger"] != "none")


def _month_diff(exp, today):
    if not exp:
        return None
    y, m = map(int, str(exp).split("-")[:2])
    return (y - today.year) * 12 + (m - today.month)


def daily_alerts_job(force=False):
    """פעם ביום (מ־08:00) נשלחת תזכורת קצרה, רק אם יש משהו לטפל בו."""
    now = datetime.now()
    if not force and now.hour < 8:
        return 0
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    try:
        today = now.strftime("%Y-%m-%d")
        r = con.execute("SELECT v FROM settings WHERE k='push_daily'").fetchone()
        if not force and r and r["v"] == today:
            return 0
        if not con.execute("SELECT 1 FROM push_subs LIMIT 1").fetchone():
            return 0
        items = _live_docs("items", con)
        boxes = _live_docs("boxes", con)
        meta = next((m for m in _live_docs("meta", con) if m.get("id") == "main"), {})
        expired = sum(1 for i in items if int(i.get("qty") or 0) > 0 and (_month_diff(i.get("exp"), now) or 0) < 0)
        soon = sum(1 for i in items if int(i.get("qty") or 0) > 0 and _month_diff(i.get("exp"), now) == 0)
        low = []
        for k, mn in (meta.get("mins") or {}).items():
            name, _, loc = k.partition("||")
            have = sum(int(i.get("qty") or 0) for i in items if i.get("name") == name and i.get("loc") == loc)
            if mn and have < int(mn):
                low.append(name)
        long_out = sum(1 for b in boxes if b.get("status") == "signed" and b.get("since") and (time.time() * 1000 - b["since"]) > 14 * 864e5)
        empty = sum(1 for b in boxes if b.get("status") == "empty")
        sap = reports.sap_state(report_docs(con))
        box_exp = sum(1 for b in boxes if b.get("status") != "empty" and any((_month_diff(c.get("exp"), now) is not None and _month_diff(c.get("exp"), now) <= 0) for c in (b.get("contents") or [])))

        def lines_for(u, c):
            t = _tabs_with(u, c)
            out = []
            if t["inventory"] != "none" or t["dashboard"] != "none":
                if expired: out.append("פריט אחד פג תוקף" if expired == 1 else f"{expired} פריטים פגי תוקף")
                if soon: out.append("פריט אחד פג החודש" if soon == 1 else f"{soon} פריטים פגים החודש")
                if low: out.append("מלאי נמוך: " + ", ".join(sorted(set(low))))
            if sap and (t["sap"] != "none" or t["dashboard"] != "none"):
                if sap["short"]: out.append("חוסר מול סאפ: " + ", ".join(f"{r['name']} {r['diff']}" for r in sap["short"]))
                if sap["receipts_since"]: out.append("התקבל משלוח ומלאי סאפ לא עודכן")
            if t["drugkits"] != "none":
                if box_exp: out.append("פקל אחד עם סם שפג או פג החודש" if box_exp == 1 else f"{box_exp} פקלים עם סם שפג או פג החודש")
                if long_out: out.append("פקל אחד חתום יותר משבועיים" if long_out == 1 else f"{long_out} פקלים חתומים יותר משבועיים")
                if empty: out.append("פקל אחד ריק ממתין למילוי" if empty == 1 else f"{empty} פקלים ריקים ממתינים למילוי")
            return out

        sent = 0
        for u in con.execute("SELECT DISTINCT u.* FROM push_subs p JOIN users u ON u.id=p.uid WHERE u.role!='blocked'").fetchall():
            ls = lines_for(u, con)
            if ls:
                sent += notify_users({"title": "ניהול מלאי – תזכורת יומית", "body": " · ".join(ls), "url": "/#dashboard", "tag": "daily"},
                                     only_uid=u["id"], con=con)
        con.execute("INSERT INTO settings(k,v) VALUES('push_daily',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (today,))
        con.commit()
        return sent
    finally:
        con.close()

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
        try:
            rep = monthly_report_job()
            if rep:
                print("דוח חודשי נשמר:", rep[2], flush=True)
                on_monthly_report(rep[0], rep[1])
        except Exception as e:
            print("הדוח החודשי נכשל:", e, flush=True)
        try:
            daily_alerts_job()
        except Exception as e:
            print("התראות יומיות נכשלו:", e, flush=True)
        time.sleep(15 * 60)  # בודקים כל רבע שעה: גיבוי יומי, דוח חודשי ותזכורת יומית


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
