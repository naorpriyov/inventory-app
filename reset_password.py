"""
איפוס סיסמה ממחשב השרת (למשל אם המנהל שכח את הסיסמה).
הרצה:  python reset_password.py
"""
import getpass
import os
import sqlite3
import sys
import unicodedata

from werkzeug.security import generate_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("INV_DATA_DIR", os.path.join(BASE, "data"))
DB_PATH = os.path.join(DATA, "inventory.db")

if not os.path.exists(DB_PATH):
    sys.exit(f"Database not found: {DB_PATH}")

con = sqlite3.connect(DB_PATH, timeout=10)
users = con.execute("SELECT username, role FROM users ORDER BY created").fetchall()
print("Users:")
for name, role in users:
    print(f"  {name}  ({role})")

username = unicodedata.normalize("NFC", input("\nUsername to reset: ")).strip()
if not con.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
    sys.exit("No such user.")

while True:
    pw = getpass.getpass("New password (min 7 chars, hidden while typing): ")
    if len(pw) < 7:
        print("Too short, try again.")
        continue
    if pw != getpass.getpass("Repeat new password: "):
        print("Passwords do not match, try again.")
        continue
    break

unblock = input("Also unblock this user if blocked? [y/N]: ").strip().lower() == "y"
con.execute("UPDATE users SET pw=? WHERE username=?", (generate_password_hash(pw), username))
if unblock:
    con.execute("UPDATE users SET role='user' WHERE username=? AND role='blocked'", (username,))
con.commit()
con.close()
print(f"\nPassword for '{username}' was reset. You can log in now.")
