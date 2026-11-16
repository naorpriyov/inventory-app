/* ניהול מלאי – חיבור האפליקציה לשרת העצמאי.
   מספק את window.claude.use('db' | 'user' | 'downloads') כך שקוד האפליקציה לא צריך לדעת איפה הנתונים נשמרים. */
(function () {
  'use strict';
  const API = '/api';

  async function req(method, url, body) {
    let r;
    try {
      r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { const er = new Error('אין חיבור לשרת'); er.code = 'unavailable'; setOnline(false); throw er; }
    if (r.status === 401) { location.href = '/login'; const er = new Error('נדרשת התחברות'); er.code = 'unauthenticated'; throw er; }
    let j = {};
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const er = new Error(j.error || 'שגיאה'); er.code = j.code || (r.status === 403 ? 'invalid_argument' : 'unavailable'); throw er; }
    setOnline(true);
    return j;
  }
  window.INV_API = req;

  /* ---------------- live document store (polling) ---------------- */
  const parentOf = p => p.slice(0, p.lastIndexOf('/'));
  const idOf = p => p.slice(p.lastIndexOf('/') + 1);
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const clone = o => JSON.parse(JSON.stringify(o));
  const store = new Map();
  const listeners = new Set();
  let since = 0, loaded = false, polling = false, access = null;

  function emit(l) {
    let docs = [];
    store.forEach((data, p) => { if (parentOf(p) === l.path) docs.push({ id: idOf(p), data }); });
    if (l.order) {
      const { field, dir } = l.order;
      docs.sort((a, b) => { const x = a.data[field], y = b.data[field]; const c = x < y ? -1 : x > y ? 1 : 0; return dir === 'desc' ? -c : c; });
    }
    if (l.limit) docs = docs.slice(0, l.limit);
    const next = new Map(docs.map(d => [d.id, JSON.stringify(d.data)]));
    const changes = [];
    docs.forEach(d => { const prev = l.prev.get(d.id); if (prev === undefined) changes.push({ type: 'added', d }); else if (prev !== next.get(d.id)) changes.push({ type: 'modified', d }); });
    l.prev.forEach((v, id) => { if (!next.has(id)) changes.push({ type: 'removed', d: { id, data: JSON.parse(v) } }); });
    if (!l.first && !changes.length) return;
    l.first = false; l.prev = next;
    const wrap = d => ({ id: d.id, exists: true, data: () => clone(d.data) });
    const snap = {
      docs: docs.map(wrap), size: docs.length, empty: !docs.length,
      metadata: { fromCache: false, hasPendingWrites: false },
      docChanges: () => changes.map(c => ({ type: c.type, doc: wrap(c.d) }))
    };
    try { l.cb(snap); } catch (e) { console.error(e); }
  }
  function emitPath(path) { listeners.forEach(l => { if (l.path === path) emit(l); }); }

  async function poll() {
    if (polling) return; polling = true;
    try {
      const j = await req('GET', API + '/changes?since=' + since);
      // ההרשאות של המשתמש השתנו (למשל המנהל פתח או סגר לו מסך): טוענים הכול מחדש
      if (access !== null && j.access !== access) { location.reload(); return; }
      access = j.access;
      const touched = new Set();
      j.docs.forEach(d => { if (d.deleted) store.delete(d.path); else store.set(d.path, d.data); touched.add(parentOf(d.path)); });
      since = j.now;
      const first = !loaded; loaded = true;
      listeners.forEach(l => { if (first || l.first || touched.has(l.path)) emit(l); });
    } catch (e) { /* ננסה שוב */ }
    polling = false;
    setTimeout(poll, document.hidden ? 15000 : 3000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  function docRef(path) {
    return {
      id: idOf(path), path,
      async set(data) { const j = await req('PUT', API + '/doc', { path, data }); store.set(path, j.data); emitPath(parentOf(path)); },
      async update(data) { const j = await req('PUT', API + '/doc', { path, data, merge: true }); store.set(path, j.data); emitPath(parentOf(path)); },
      async delete() { await req('DELETE', API + '/doc?path=' + encodeURIComponent(path)); store.delete(path); emitPath(parentOf(path)); },
      async get() { const d = store.get(path); return { id: idOf(path), exists: !!d, data: () => d ? clone(d) : undefined }; }
    };
  }
  function query(path, opts) {
    return {
      doc: id => docRef(path + '/' + (id || genId())),
      add: async data => { const r = docRef(path + '/' + genId()); await r.set(data); return r; },
      orderBy: (field, dir) => query(path, Object.assign({}, opts, { order: { field, dir: dir || 'asc' } })),
      limit: n => query(path, Object.assign({}, opts, { limit: n })),
      where: () => query(path, opts),
      onSnapshot(cb) {
        const l = { path, cb, order: opts.order, limit: opts.limit, prev: new Map(), first: true };
        listeners.add(l);
        if (loaded) setTimeout(() => emit(l), 0);
        return () => listeners.delete(l);
      }
    };
  }
  const dbApi = { collection: path => query(path, {}), doc: path => docRef(path) };

  /* ---------------- user ---------------- */
  let meP = null;
  const me = () => (meP = meP || req('GET', API + '/me'));
  const userApi = {
    me: async () => { const m = await me(); return { id: m.id, name: m.name, isOwner: m.isOwner }; },
    id: async () => (await me()).id,
    isOwner: async () => (await me()).isOwner,
    name: async () => (await me()).name,
    search: async () => [], profiles: async () => ({})
  };

  /* ---------------- downloads ---------------- */
  const dlApi = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
      const a = document.createElement('a'); a.href = url; a.download = filename || 'file';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
  };

  window.claude = {
    use: async name => {
      if (name === 'db') { if (!loaded) poll(); return dbApi; }
      if (name === 'user') { try { await me(); return userApi; } catch (e) { return null; } }
      if (name === 'downloads') return dlApi;
      return null;
    }
  };

  /* ---------------- connection banner ---------------- */
  let banner = null;
  function setOnline(on) {
    if (!banner) return;
    banner.hidden = on;
  }

  /* ---------------- header: user menu + accounts admin ---------------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function toast(t) { const s = document.getElementById('toast'); if (!s) return; s.textContent = t; s.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => s.classList.remove('show'), 3200); }

  document.addEventListener('DOMContentLoaded', async () => {
    banner = document.createElement('div');
    banner.hidden = true; banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:sticky;top:0;z-index:70;background:#BE123C;color:#fff;text-align:center;padding:.45rem 1rem;font-weight:600';
    banner.textContent = 'אין חיבור לשרת. שינויים לא יישמרו עד שהחיבור יחזור.';
    document.body.prepend(banner);

    const style = document.createElement('style');
    style.textContent = `.acct{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}.acct .who{font-weight:600;color:var(--muted);font-size:.92rem}
      .acc-row{display:grid;grid-template-columns:1fr auto;gap:.4rem .75rem;align-items:center;border-top:1px solid var(--line);padding:.6rem 0}
      .acc-row:first-child{border-top:0}.acc-row .meta{font-size:.85rem;color:var(--muted)}.acc-row .acts{display:flex;gap:.35rem;flex-wrap:wrap}
      .invite{font-size:1.6rem;font-weight:700;letter-spacing:.15em;direction:ltr;text-align:center;background:var(--sunk);border-radius:.6rem;padding:.5rem}`;
    document.head.appendChild(style);

    let m; try { m = await me(); } catch (e) { return; }
    const top = document.querySelector('.top-in');
    if (top) {
      const box = document.createElement('div'); box.className = 'acct';
      box.innerHTML = `<span class="who">${esc(m.name)}</span>${m.isOwner ? '<button type="button" class="btn sm" id="acctBtn">חשבונות משתמשים</button>' : ''}<button type="button" class="btn sm" id="pwBtn">שינוי סיסמה</button><a class="btn sm" href="/logout">יציאה</a>`;
      top.appendChild(box);
    }

    const dlg = document.createElement('dialog');
    dlg.setAttribute('aria-labelledby', 'accTitle');
    dlg.innerHTML = `<form method="dialog" style="padding:1.4rem;display:grid;gap:.9rem;max-height:86vh;overflow-y:auto" novalidate>
      <h2 id="accTitle" style="margin:0">חשבונות משתמשים</h2><div id="accBody"></div>
      <div class="dlg-actions"><button class="btn" value="close">סגירה</button></div></form>`;
    document.body.appendChild(dlg);

    async function renderAccounts() {
      const body = dlg.querySelector('#accBody');
      let j; try { j = await req('GET', API + '/admin/users'); } catch (e) { body.innerHTML = '<p class="err">לא ניתן לטעון את רשימת המשתמשים.</p>'; return; }
      const roleHe = { owner: 'מנהל', user: 'משתמש', blocked: 'חסום' };
      body.innerHTML = `<p class="sub" style="margin:0">עובד חדש נרשם בעמוד ההרשמה עם קוד ההרשמה הזה. בקשת ההרשאות שלו מגיעה אליך אוטומטית, ואת ההרשאות עצמן מגדירים בעמוד המלאי בכפתור "הרשאות משתמשים".</p>
        <div class="invite" aria-label="קוד הרשמה">${esc(j.invite)}</div>
        <div><button type="button" class="btn sm" data-acc="invite">יצירת קוד חדש</button> <span class="hint">הקוד הקודם יפסיק לעבוד.</span></div>
        <div><button type="button" class="btn sm" data-acc="audit">יומן ביקורת</button> <span class="hint">כל שינוי וכל כניסה, עם מי ומתי. אי אפשר למחוק ממנו.</span></div>
        <p class="sub" style="margin:0">${j.lastBackup ? `גיבוי אוטומטי אחרון: ${esc(new Date(j.lastBackup).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}. נשמרים ${esc(j.backups)} גיבויים יומיים.` : 'עוד לא נשמר גיבוי אוטומטי.'}</p>
        <h3 style="margin:.5rem 0 0;font-size:1rem">משתמשים רשומים</h3>
        <div>${j.users.map(u => `<div class="acc-row"><div><strong>${esc(u.name)}</strong><div class="meta">${esc(u.username)}, ${roleHe[u.role] || u.role}</div></div>
          <div class="acts">${u.id === m.id ? '' : `<button type="button" class="btn sm" data-acc="pw" data-id="${esc(u.id)}" data-name="${esc(u.name)}">איפוס סיסמה</button>
          ${u.role === 'blocked' ? `<button type="button" class="btn sm" data-acc="role" data-role="user" data-id="${esc(u.id)}">ביטול חסימה</button>` : `<button type="button" class="btn sm danger" data-acc="role" data-role="blocked" data-id="${esc(u.id)}">חסימה</button>`}
          ${u.role === 'owner' ? `<button type="button" class="btn sm" data-acc="role" data-role="user" data-id="${esc(u.id)}">הסרת ניהול</button>` : (u.role === 'user' ? `<button type="button" class="btn sm" data-acc="role" data-role="owner" data-id="${esc(u.id)}">הפיכה למנהל</button>` : '')}`}</div></div>`).join('')}</div>`;
    }
    dlg.addEventListener('click', async e => {
      const b = e.target.closest('[data-acc]'); if (!b) return;
      if (b.dataset.acc === 'audit') { openAudit(); return; }
      try {
        if (b.dataset.acc === 'invite') { await req('POST', API + '/admin/invite', {}); toast('נוצר קוד הרשמה חדש'); }
        if (b.dataset.acc === 'pw') { const p = prompt(`סיסמה חדשה עבור ${b.dataset.name} (לפחות 7 תווים):`); if (!p) return; await req('POST', API + '/admin/users/' + b.dataset.id, { password: p }); toast('הסיסמה אופסה. מסרו אותה לעובד.'); }
        if (b.dataset.acc === 'role') { await req('POST', API + '/admin/users/' + b.dataset.id, { role: b.dataset.role }); toast('החשבון עודכן'); }
        renderAccounts();
      } catch (er) { toast(er.message); }
    });
    /* ---------- audit log (owner only) ---------- */
    const COLL_HE = { items: 'מלאי', ledger: 'ספר סמים', boxes: 'פקלי סמים', boxtpl: 'תבנית פקל', kits: 'ערכות', perms: 'הרשאות', notes: 'פתקי החתמה', counts: 'ספירת מלאי', moves: 'תנועות', cancels: 'זיכויים', caregivers: 'מטפלים', locations: 'מיקומים', meta: 'הגדרות', recon: 'טיפול בפתקים', catalog: 'קטלוג', batches: 'אצוות', users: 'משתמשים' };
    const OP_HE = { set: 'שמירה', delete: 'מחיקה', login: 'כניסה', 'login-failed': 'ניסיון כניסה שגוי', 'user-update': 'שינוי משתמש' };
    const adlg = document.createElement('dialog');
    adlg.setAttribute('aria-labelledby', 'audTitle');
    adlg.style.maxWidth = 'min(860px,96vw)';
    adlg.innerHTML = `<form method="dialog" style="padding:1.3rem;display:grid;gap:.8rem;max-height:88vh;overflow-y:auto" novalidate>
      <h2 id="audTitle" style="margin:0">יומן ביקורת</h2>
      <p class="sub" style="margin:0">כל שינוי בנתונים וכל ניסיון כניסה נרשמים כאן אוטומטית. אי אפשר למחוק או לשנות את היומן.</p>
      <div class="field"><label for="audQ">חיפוש (שם משתמש, סם, מספר פקל…)</label><input id="audQ" type="search" autocomplete="off"></div>
      <div id="audBody"></div>
      <div class="dlg-actions"><button type="button" class="btn sm" id="audMore">עוד</button><button class="btn" value="close">סגירה</button></div></form>`;
    document.body.appendChild(adlg);
    let audLast = 0, audT = null;
    const summ = r => { let d = null; try { d = r.data ? JSON.parse(r.data) : null; } catch (e) {}
      if (!d) return ''; const bits = [];
      ['name', 'id', 'status', 'qty', 'inQty', 'outQty', 'batch', 'loc', 'note', 'username', 'role'].forEach(k => { if (d[k] != null && d[k] !== '' && bits.length < 6) bits.push(String(d[k])); });
      return bits.join(' · '); };
    async function loadAudit(reset) {
      if (reset) { audLast = 0; adlg.querySelector('#audBody').innerHTML = ''; }
      const q = adlg.querySelector('#audQ').value.trim();
      let j; try { j = await req('GET', API + '/admin/audit?limit=100' + (audLast ? '&before=' + audLast : '') + (q ? '&q=' + encodeURIComponent(q) : '')); } catch (e) { toast(e.message); return; }
      const rows = j.rows || []; if (rows.length) audLast = rows[rows.length - 1].id;
      adlg.querySelector('#audMore').hidden = rows.length < 100;
      const html = rows.map(r => { const col = (r.path || '').split('/')[0];
        return `<tr><td style="white-space:nowrap">${esc(new Date(r.at * 1000).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</td><td>${esc(r.username || '')}</td><td>${esc(OP_HE[r.op] || r.op)}</td><td>${esc(COLL_HE[col] || col)}</td><td>${esc(summ(r))}</td></tr>`; }).join('');
      const body = adlg.querySelector('#audBody');
      if (!body.querySelector('table')) body.innerHTML = `<div class="tbl-wrap" style="box-shadow:none"><table><thead><tr><th scope="col">מתי</th><th scope="col">משתמש</th><th scope="col">פעולה</th><th scope="col">איפה</th><th scope="col">פרטים</th></tr></thead><tbody></tbody></table></div>`;
      body.querySelector('tbody').insertAdjacentHTML('beforeend', html || (reset ? '<tr><td colspan="5">אין רישומים.</td></tr>' : ''));
    }
    function openAudit() { adlg.querySelector('#audQ').value = ''; loadAudit(true); adlg.showModal(); }
    adlg.querySelector('#audQ').addEventListener('input', () => { clearTimeout(audT); audT = setTimeout(() => loadAudit(true), 300); });
    adlg.querySelector('#audMore').addEventListener('click', () => loadAudit(false));

    const ab = document.getElementById('acctBtn');
    if (ab) ab.addEventListener('click', () => { renderAccounts(); dlg.showModal(); });

    const pb = document.getElementById('pwBtn');
    if (pb) pb.addEventListener('click', async () => {
      const old = prompt('הסיסמה הנוכחית:'); if (!old) return;
      const nw = prompt('סיסמה חדשה (לפחות 7 תווים):'); if (!nw) return;
      try { await req('POST', API + '/me/password', { old, new: nw }); toast('הסיסמה הוחלפה'); } catch (er) { toast(er.message); }
    });
  });

  /* ---------------- install as an app ---------------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
