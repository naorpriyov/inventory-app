"""
דוח חודשי: שימוש לפי סם, יתרות, תוקפים, פקלי סמים וספירות.
הדוח נבנה מתוך ספר הסמים, שלא ניתן לשנות, ולכן דוח של חודש שעבר יוצא תמיד אותו דבר.
"""
import html
import time
from datetime import date, datetime

MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"]
DRUG_ORDER = ["אקטיק", "קטמין 50", "קטמין 500", "מידזולם", "מורפיום", "פנטניל"]
USE_SIGN = {"sign", "kit-sign"}
STATUS_HE = {"vault": "בכספת", "signed": "חתומה", "empty": "ריקה"}
e = html.escape


def month_bounds(year, month):
    start = datetime(year, month, 1)
    end = datetime(year + (month == 12), month % 12 + 1, 1)
    return start.timestamp() * 1000, end.timestamp() * 1000


def prev_month(today=None):
    t = today or date.today()
    return (t.year - 1, 12) if t.month == 1 else (t.year, t.month - 1)


def fmt_dt(ms):
    return datetime.fromtimestamp(ms / 1000).strftime("%d/%m/%Y %H:%M")


def fmt_exp(exp):
    if not exp:
        return "ללא"
    y, m = exp.split("-")[:2]
    return f"{m}/{y}"


def months_until(exp, today):
    if not exp:
        return None
    y, m = map(int, exp.split("-")[:2])
    return (y - today.year) * 12 + (m - today.month)


def n(v):
    return int(v or 0)


def build(year, month, docs, now_ms=None):
    """docs: {collection: [data, ...]} with keys items, ledger, boxes, kits, notes."""
    start, end = month_bounds(year, month)
    today = date.today()
    ledger = sorted(docs.get("ledger", []), key=lambda l: l.get("at") or 0)
    names = [d for d in DRUG_ORDER if any(l.get("name") == d for l in ledger) or any(i.get("name") == d for i in docs.get("items", []))]
    names += sorted({l.get("name") for l in ledger if l.get("name") and l.get("name") not in names})

    # ---- per drug summary
    rows = []
    for name in names:
        ls = [l for l in ledger if l.get("name") == name]
        before = [l for l in ls if (l.get("at") or 0) < start]
        inside = [l for l in ls if start <= (l.get("at") or 0) < end]
        if not before and not inside:
            continue
        o_free = n(before[-1].get("balance")) if before else None
        o_kit = n(before[-1].get("kitBalance")) if before else None
        last = inside[-1] if inside else (before[-1] if before else None)
        c_free = n(last.get("balance")) if last else None
        c_kit = n(last.get("kitBalance")) if last else None
        got = sum(n(l.get("inQty")) for l in inside if l.get("type") == "receive")
        used_sign = sum(n(l.get("outQty")) for l in inside if l.get("type") in USE_SIGN)
        used_box = sum(n(l.get("outQty")) for l in inside if l.get("type") == "box-use")
        returned = sum(n(l.get("inQty")) for l in inside if l.get("type") == "cancel")
        out = sum(n(l.get("outQty")) for l in inside if l.get("type") == "out")
        adj = sum(n(l.get("inQty")) - n(l.get("outQty")) for l in inside if l.get("type") == "adjust")
        rows.append((name, o_free, o_kit, got, used_sign, used_box, returned, out, adj, c_free, c_kit))

    def cell(v):
        return "—" if v is None else str(v)

    summary = "".join(
        f"<tr><th>{e(r[0])}</th><td>{cell(r[1])}</td><td>{cell(r[2])}</td><td>{r[3]}</td><td><b>{r[4]}</b></td><td><b>{r[5]}</b></td>"
        f"<td>{r[6]}</td><td>{r[7]}</td><td>{'+' if r[8] > 0 else ''}{r[8]}</td><td>{cell(r[9])}</td><td>{cell(r[10])}</td></tr>"
        for r in rows) or '<tr><td colspan="11">אין תנועות בחודש הזה.</td></tr>'

    # ---- counts in the month
    counts = [l for l in ledger if l.get("type") == "count" and start <= (l.get("at") or 0) < end]
    count_rows = "".join(
        f"<tr><td>{fmt_dt(l['at'])}</td><td>{e(l.get('name', ''))}</td><td>{n(l.get('balance'))}</td><td>{n(l.get('counted'))}</td>"
        f"<td>{'<b>' + str(n(l.get('counted')) - n(l.get('balance'))) + '</b>' if n(l.get('counted')) != n(l.get('balance')) else 'תקין'}</td><td>{e(l.get('byName') or l.get('byUser') or '')}</td></tr>"
        for l in counts) or '<tr><td colspan="6">לא בוצעה ספירה בחודש הזה.</td></tr>'

    # ---- expiry (state at the time the report is produced)
    exp_items = []
    for i in docs.get("items", []):
        d = months_until(i.get("exp"), today)
        if d is not None and d <= 2 and n(i.get("qty")) > 0:
            exp_items.append((d, i))
    exp_items.sort(key=lambda x: (x[0], x[1].get("name", "")))
    exp_rows = "".join(
        f"<tr class=\"{'bad' if d < 0 else 'warn' if d == 0 else ''}\"><td>{e(i.get('name', ''))}</td><td>{e(i.get('batch') or 'ללא')}</td><td>{e(i.get('loc', ''))}</td><td>{n(i.get('qty'))}</td>"
        f"<td>{fmt_exp(i.get('exp'))}</td><td>{'פג תוקף' if d < 0 else 'פג החודש' if d == 0 else 'פג בחודשיים הקרובים'}</td></tr>"
        for d, i in exp_items) or '<tr><td colspan="6">אין פריטים שפג תוקפם או שפגים בחודשיים הקרובים.</td></tr>'

    # ---- drug kit boxes (current state)
    boxes = sorted(docs.get("boxes", []), key=lambda b: (b.get("series", ""), n(b.get("n"))))
    by_status = {k: [b for b in boxes if b.get("status") == k] for k in STATUS_HE}
    box_exp = []
    for b in boxes:
        if b.get("status") == "empty":
            continue
        exps = sorted(c.get("exp") for c in (b.get("contents") or []) if c.get("exp"))
        if exps:
            d = months_until(exps[0], today)
            if d is not None and d <= 1:
                box_exp.append((b, exps[0], d))
    signed_rows = "".join(
        f"<tr><td>{e(b.get('id', ''))}</td><td>{e(b.get('loc', ''))}</td><td>{e(b.get('to') or '')}</td><td>{fmt_dt(b['since']) if b.get('since') else ''}</td></tr>"
        for b in by_status["signed"]) or '<tr><td colspan="4">אין פקלים חתומים.</td></tr>'
    box_month = {}
    for l in ledger:
        if start <= (l.get("at") or 0) < end and str(l.get("type", "")).startswith("box-"):
            box_month[l["type"]] = box_month.get(l["type"], 0) + n(l.get("outQty") or l.get("inQty"))

    notes_in_month = sum(1 for x in docs.get("notes", []) if str(x.get("date", ""))[:7] == f"{year}-{month:02d}")
    produced = datetime.fromtimestamp((now_ms or time.time() * 1000) / 1000).strftime("%d/%m/%Y %H:%M")
    title = f"דוח חודשי – {MONTHS[month - 1]} {year}"

    return f"""<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title><link rel="stylesheet" href="/static/fonts/rubik.css">
<style>
:root{{--ink:#0F172A;--muted:#475569;--line:#E2E8F0;--sunk:#EDF1F7;--accent:#2563EB;--warn:#FEF9C3;--bad:#FFE4E6}}
*{{box-sizing:border-box}} body{{margin:0;background:#F5F7FB;color:var(--ink);font-family:"Rubik","Segoe UI",Arial,sans-serif;line-height:1.5}}
main{{max-width:1050px;margin:0 auto;padding:24px 16px 48px}}
.bar{{display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin-bottom:16px}}
.bar button,.bar a{{font:inherit;font-weight:600;border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:12px;padding:8px 14px;cursor:pointer;text-decoration:none}}
.bar button.primary{{background:var(--accent);color:#fff;border-color:var(--accent)}}
.sheet{{background:#fff;border:1px solid var(--line);border-radius:20px;padding:24px}}
h1{{margin:0 0 4px;font-size:1.7rem}} h2{{font-size:1.1rem;margin:28px 0 8px}}
.sub{{color:var(--muted);margin:0}}
.kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}}
.kpis div{{background:var(--sunk);border-radius:14px;padding:10px 12px}} .kpis b{{display:block;font-size:1.5rem;font-variant-numeric:tabular-nums}}
table{{width:100%;border-collapse:collapse;font-size:.88rem}}
th,td{{padding:6px 8px;border-bottom:1px solid var(--line);text-align:start;vertical-align:top}}
thead th{{background:var(--sunk);font-weight:500;color:var(--muted);font-size:.8rem}}
td{{font-variant-numeric:tabular-nums}} tr.warn td{{background:var(--warn)}} tr.bad td{{background:var(--bad)}}
.note{{font-size:.8rem;color:var(--muted);margin-top:6px}}
.sign{{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}} .sign div{{border-top:1px solid var(--ink);padding-top:6px;font-size:.85rem}}
@media (max-width:640px){{.kpis{{grid-template-columns:1fr 1fr}} .sheet{{padding:14px}} table{{font-size:.78rem}}}}
@media print{{body{{background:#fff}} main{{padding:0;max-width:none}} .bar{{display:none}} .sheet{{border:0;padding:0}} h2{{break-after:avoid}} tr{{break-inside:avoid}} @page{{size:A4;margin:12mm}}}}
</style></head><body><main>
<div class="bar"><a href="/#ledger">חזרה לתוכנה</a><button class="primary" type="button" onclick="print()">הדפסה / שמירה כ־PDF</button></div>
<div class="sheet">
<h1>{e(title)}</h1><p class="sub">ניהול מלאי וספר סמים · הופק ב־{produced} · התקופה: 01/{month:02d}/{year} עד סוף החודש</p>
<div class="kpis">
<div><b>{sum(r[4] for r in rows)}</b>יחידות שהוחתמו</div>
<div><b>{sum(r[5] for r in rows)}</b>יחידות שנוצלו מפקלים</div>
<div><b>{notes_in_month}</b>פתקי החתמה</div>
<div><b>{len(counts) and len({fmt_dt(l['at'])[:10] for l in counts})}</b>ימי ספירה</div>
</div>
<h2>סיכום לפי סם</h2>
<div style="overflow-x:auto"><table><thead><tr><th>סם</th><th>יתרה בתחילת החודש</th><th>בערכות ובפקלים בתחילת החודש</th><th>התקבל</th><th>הוחתם</th><th>נוצל מפקלים</th><th>זוכה</th><th>הורד</th><th>התאמות בספירה</th><th>יתרה בסוף החודש</th><th>בערכות ובפקלים בסוף החודש</th></tr></thead><tbody>{summary}</tbody></table></div>
<p class="note">היתרות לקוחות מספר הסמים. "יתרה" היא המלאי החופשי, בלי מה שנמצא בערכות ובפקלים.</p>
<h2>ספירות מלאי בחודש</h2>
<div style="overflow-x:auto"><table><thead><tr><th>מתי</th><th>סם</th><th>יתרה במחשב</th><th>נספר</th><th>פער</th><th>הסופר</th></tr></thead><tbody>{count_rows}</tbody></table></div>
<h2>תוקפים (נכון להפקת הדוח)</h2>
<div style="overflow-x:auto"><table><thead><tr><th>סם</th><th>אצווה</th><th>מיקום</th><th>כמות</th><th>תוקף</th><th>מצב</th></tr></thead><tbody>{exp_rows}</tbody></table></div>
<h2>פקלי סמים (נכון להפקת הדוח)</h2>
<p class="sub">{len(by_status['vault'])} בכספת · {len(by_status['signed'])} חתומים · {len(by_status['empty'])} ריקים · סה״כ {len(boxes)}.
בחודש הזה: מולאו {box_month.get('box-fill', 0)} יח׳, נוצלו {box_month.get('box-use', 0)} יח׳, הוחזרו למלאי {box_month.get('box-return', 0)} יח׳.</p>
{''.join(f"<p class='sub'>⚠ פקל {e(b.get('id', ''))}: תוקף {fmt_exp(x)}{' (פג)' if d < 0 else ''}</p>" for b, x, d in box_exp)}
<div style="overflow-x:auto;margin-top:8px"><table><thead><tr><th>פקל חתום</th><th>מיקום</th><th>ליד מי</th><th>מאז</th></tr></thead><tbody>{signed_rows}</tbody></table></div>
{sap_section(docs, start, end)}
<div class="sign"><div>שם וחתימת האחראי</div><div>תאריך</div></div>
</div></main></body></html>"""


# ---------------------------------------------------------------- השוואה לסאפ
# סאפ מוריד שימוש רק אחרי פתק הצריכה החודשי, ולכן משווים את סאפ מול:
# המלאי אצלנו (חופשי + ערכות + פקלים) + הצריכה שעוד לא ירדה בסאפ (מאז תאריך החיתוך).
PENDING_OUT = {"sign", "kit-sign", "box-use", "out"}


def our_stock(docs, name):
    free = sum(n(i.get("qty")) for i in docs.get("items", []) if i.get("name") == name)
    kits = sum(n(c.get("qty")) for k in docs.get("kits", []) if k.get("status") != "issued"
               for c in (k.get("contents") or []) if c.get("name") == name)
    boxes = sum(n(c.get("qty")) for b in docs.get("boxes", []) if b.get("status") != "empty"
                for c in (b.get("contents") or []) if c.get("name") == name)
    return free + kits + boxes


def sap_state(docs):
    snaps = sorted(docs.get("sap", []), key=lambda x: x.get("at") or 0)
    if not snaps:
        return None
    last = snaps[-1]
    meta = next((m for m in docs.get("sapmeta", []) if m.get("id") == "main"), {})
    cutoff = meta.get("cutoff") or 0
    ledger = docs.get("ledger", [])
    names = []
    for ln in last.get("lines") or []:
        if ln.get("name") and ln["name"] not in names:
            names.append(ln["name"])
    rows = []
    for name in names:
        sap = sum(n(ln.get("qty")) for ln in last["lines"] if ln.get("name") == name)
        ours = our_stock(docs, name)
        pend = sum(n(l.get("outQty")) for l in ledger if l.get("name") == name and l.get("type") in PENDING_OUT and (l.get("at") or 0) > cutoff)
        pend -= sum(n(l.get("inQty")) for l in ledger if l.get("name") == name and l.get("type") == "cancel" and (l.get("at") or 0) > cutoff)
        pend = max(pend, 0)
        rows.append({"name": name, "sap": sap, "ours": ours, "pending": pend, "diff": ours + pend - sap})
    rec = sum(n(l.get("inQty")) for l in ledger if l.get("type") == "receive" and (l.get("at") or 0) > (last.get("at") or 0))
    return {"at": last.get("at"), "by": last.get("byName") or last.get("byUser") or "", "rows": rows,
            "short": [r for r in rows if r["diff"] < 0], "receipts_since": rec, "cutoff": cutoff,
            "cutoff_date": meta.get("cutoffDate") or "", "snaps": snaps}


def sap_section(docs, start, end):
    st = sap_state(docs)
    if not st:
        return "<h2>השוואה לסאפ</h2><p class='sub'>עוד לא הוזן מלאי סאפ.</p>"
    rows = "".join(
        f"<tr class=\"{'bad' if r['diff'] < 0 else ''}\"><th>{e(r['name'])}</th><td>{r['sap']}</td><td>{r['ours']}</td><td>{r['pending']}</td>"
        f"<td><b>{'+' if r['diff'] > 0 else ''}{r['diff']}</b></td><td>{'חוסר' if r['diff'] < 0 else 'תקין'}</td></tr>" for r in st["rows"])
    upd = [x for x in st["snaps"] if start <= (x.get("at") or 0) < end]
    upd_txt = ", ".join(f"{fmt_dt(x['at'])} ({e(x.get('byName') or x.get('byUser') or '')})" for x in upd) or "אין"
    return (f"<h2>השוואה לסאפ (נכון להפקת הדוח)</h2><p class='sub'>עדכון סאפ אחרון: {fmt_dt(st['at'])}"
            f"{' · ' + e(st['by']) if st['by'] else ''} · הצריכה הורדה בסאפ עד: {e(st['cutoff_date']) or 'לא סומן'}"
            f"{' · התקבלו ' + str(st['receipts_since']) + ' יח׳ מאז העדכון האחרון' if st['receipts_since'] else ''}.</p>"
            "<div style='overflow-x:auto'><table><thead><tr><th>סם</th><th>בסאפ</th><th>אצלנו</th><th>צריכה שעוד לא ירדה בסאפ</th><th>פער</th><th>מצב</th></tr></thead>"
            f"<tbody>{rows}</tbody></table></div><p class='note'>עדכוני מלאי סאפ בחודש: {upd_txt}</p>")
