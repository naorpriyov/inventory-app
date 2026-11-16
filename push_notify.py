"""
התראות לטלפון (Web Push). התוכן מוצפן מקצה לקצה בין השרת לטלפון.
מפתחות ה־VAPID נוצרים פעם אחת ונשמרים בתיקיית הנתונים (vapid_private.pem).
בהתראות אין שמות מטופלים או פרטים אישיים, רק מספרים ותזכורות.
"""
import base64
import json
import os

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException, webpush


def _b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def load_keys(data_dir):
    path = os.path.join(data_dir, "vapid_private.pem")
    if not os.path.exists(path):
        v = Vapid()
        v.generate_keys()
        v.save_key(path)
    v = Vapid.from_file(path)
    pub = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return path, _b64url(pub)


def contact(base_dir):
    """VAPID 'sub' claim: the site's own address (no personal e-mail is sent anywhere)."""
    try:
        with open(os.path.join(base_dir, "כתובת האתר.txt"), encoding="utf-8") as f:
            url = f.read().split()[0]
            if url.startswith("https://"):
                return url
    except Exception:
        pass
    return "https://localhost"


def send(sub, payload, key_path, sub_claim):
    """Returns 'ok', 'gone' (subscription no longer valid) or an error text."""
    try:
        webpush(subscription_info=sub, data=json.dumps(payload, ensure_ascii=False), vapid_private_key=key_path,
                vapid_claims={"sub": sub_claim}, ttl=24 * 3600, timeout=15)
        return "ok"
    except WebPushException as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        return "gone" if code in (404, 410) else f"error {code}: {e}"
    except Exception as e:
        return f"error: {e}"
