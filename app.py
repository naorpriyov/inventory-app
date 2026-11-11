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
def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    u = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u or u["role"] == "blocked":
        return None
    return u


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


USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{3,32}$")


def validate_new_user(username, name, password):
    if not USERNAME_RE.match(username or ""):
        return "שם משתמש: 3 עד 32 תווים באנגלית, ספרות, נקודה, מקף או קו תחתון."
    if not (name or "").strip():
        return "יש למלא שם מלא."
    if len(password or "") < 8:
        return "הסיסמה צריכה להכיל לפחות 8 תווים."
    if db().execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        return "שם המשתמש כבר תפוס."
    return None


def create_user(username, name, password, role):
    uid = secrets.token_hex(8)
    db().execute(
        "INSERT INTO users(id,username,name,pw,role,created) VALUES(?,?,?,?,?,?)",
        (uid, username, name.strip(), generate_password_hash(password), role, time.time()),
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


def flags_of(u):
    p = get_doc("perms/" + perm_key(u["id"]))
    if not p or p.get("status") != "approved" or p.get("uid") != u["id"]:
        return {}
    return p.get("flags") or {"lower": True}


APPEND_ONLY = {"ledger", "counts", "cancels"}


def can_read(u, path):
    seg = path.split("/")
    if seg[0] == "notes" and len(seg) >= 2 and seg[1] != u["id"] and not is_owner(u):
        return False
    return True


def can_write(u, path, data, op):
    """op: set | delete. Server-side rules; the owner may do everything."""
    if is_owner(u):
        return True
    seg = path.split("/")
    top = seg[0]
    if top == "notes":
        return op != "delete" and len(seg) >= 2 and seg[1] == u["id"]
    if top == "perms":
        return (
            op != "delete"
            and seg[1] == perm_key(u["id"])
            and isinstance(data, dict)
            and data.get("uid") == u["id"]
            and data.get("status") == "pending"
            and not data.get("flags")
        )
    if top == "cancels":
        return False  # זיכוי פתק – מנהל בלבד
    if top in APPEND_ONLY:
        return op != "delete" and get_doc(path) is None  # רישום חדש בלבד, בלי שינוי או מחיקה
    if top in ("items", "kits", "locations") and op == "delete":
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
    b = request.get_json(force=True)
    err = validate_new_user(b.get("username"), b.get("name"), b.get("password"))
    if err:
        return jsonify(error=err), 400
    uid = create_user(b["username"], b["name"], b["password"], "owner")
    new_invite()
    session.clear()
    session.permanent = True
    session["uid"] = uid
    return jsonify(ok=True)


@app.post("/api/login")
def api_login():
    b = request.get_json(force=True)
    u = db().execute("SELECT * FROM users WHERE username=?", (b.get("username", ""),)).fetchone()
    if not u or not check_password_hash(u["pw"], b.get("password", "")):
        time.sleep(0.6)
        return jsonify(error="שם משתמש או סיסמה שגויים."), 401
    if u["role"] == "blocked":
        return jsonify(error="החשבון חסום. פנו למנהל המערכת."), 403
    session.clear()
    session.permanent = True
    session["uid"] = u["id"]
    return jsonify(ok=True)


@app.post("/api/register")
def api_register():
    b = request.get_json(force=True)
    code = (b.get("invite") or "").strip().upper()
    if not code or code != (setting("invite") or ""):
        return jsonify(error="קוד ההרשמה שגוי. בקשו את הקוד ממנהל המערכת."), 400
    err = validate_new_user(b.get("username"), b.get("name"), b.get("password"))
    if err:
        return jsonify(error=err), 400
    uid = create_user(b["username"], b["name"], b["password"], "user")
    session.clear()
    session.permanent = True
    session["uid"] = uid
    return jsonify(ok=True)


@app.get("/api/me")
@api_login_required
def api_me():
    u = g.user
    return jsonify(id=u["id"], name=u["name"], username=u["username"], isOwner=is_owner(u))


@app.post("/api/me/password")
@api_login_required
def api_change_password():
    b = request.get_json(force=True)
    if not check_password_hash(g.user["pw"], b.get("old", "")):
        return jsonify(error="הסיסמה הנוכחית שגויה."), 400
    if len(b.get("new", "")) < 8:
        return jsonify(error="הסיסמה החדשה צריכה להכיל לפחות 8 תווים."), 400
    db().execute("UPDATE users SET pw=? WHERE id=?", (generate_password_hash(b["new"]), g.user["id"]))
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- admin api
@app.get("/api/admin/users")
@owner_required
def admin_users():
    rows = db().execute("SELECT id,username,name,role,created FROM users ORDER BY created").fetchall()
    return jsonify(users=[dict(r) for r in rows], invite=setting("invite") or new_invite())


@app.post("/api/admin/invite")
@owner_required
def admin_invite():
    return jsonify(invite=new_invite())


@app.post("/api/admin/users/<uid>")
@owner_required
def admin_user_update(uid):
    b = request.get_json(force=True)
    u = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        return jsonify(error="המשתמש לא נמצא."), 404
    if uid == g.user["id"] and b.get("role") and b["role"] != "owner":
        return jsonify(error="אי אפשר להוריד לעצמך את הרשאות המנהל."), 400
    if "password" in b:
        if len(b["password"]) < 8:
            return jsonify(error="הסיסמה צריכה להכיל לפחות 8 תווים."), 400
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
    return jsonify(now=now, docs=out)


@app.put("/api/doc")
@api_login_required
def api_put():
    b = request.get_json(force=True)
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


# ---------------------------------------------------------------- run
init_db()

if __name__ == "__main__":
    host = os.environ.get("INV_HOST", "0.0.0.0")
    port = int(os.environ.get("INV_PORT") or os.environ.get("PORT") or "8000")  # PORT – Render וכד'
    print(f"ניהול מלאי פועל: http://localhost:{port}")
    try:
        from waitress import serve
        serve(app, host=host, port=port, threads=8)
    except ImportError:
        app.run(host=host, port=port)
