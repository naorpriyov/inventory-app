/* ניהול מלאי – הלוגיקה הראשית (מסכים, מלאי, פקלי סמים, ספר סמים, הרשאות) */
(function(){
'use strict';
const DEFAULT_LOCS=['כספת אחורית','כספת קידמית'];
const COLS=['items','kits','locations','moves','catalog','batches','perms','ledger','counts','cancels','caregivers','meta','recon','boxes','boxtpl','sap','sapmeta'];
const S={items:{},kits:{},locations:{},moves:{},catalog:{},batches:{},perms:{},ledger:{},counts:{},cancels:{},caregivers:{},meta:{},recon:{},boxes:{},boxtpl:{},sap:{},sapmeta:{}};
const LS_KEY='inv-data-v1', FS_KEY='inv-fs';
let mode='loading', db=null, loadErr=false, route='dashboard';
let user=null, me={id:null,isOwner:false}, signPrefill=null;
const inv={q:'',status:'all',loc:'all',sort:'exp'};
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const MONTHS=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

/* ---------- expiry logic ---------- */
function monthDiff(exp){
  if(!exp) return null;
  const [y,m]=exp.split('-').map(Number); const n=new Date();
  return (y-n.getFullYear())*12+(m-(n.getMonth()+1));
}
function status(exp){const d=monthDiff(exp); if(d===null) return 'ok'; if(d<0) return 'expired'; if(d===0) return 'soon'; return 'ok';}
function fmtExp(exp){ if(!exp) return 'ללא'; const [y,m]=exp.split('-'); return `01/${m}/${y}`; }
const PILL={ok:'<span class="pill ok"><span aria-hidden="true">✓</span>בתוקף</span>',soon:'<span class="pill soon"><span aria-hidden="true">⚠</span>פג החודש</span>',expired:'<span class="pill expired"><span aria-hidden="true">✕</span>פג תוקף</span>'};
function kitExp(k){ const e=(k.contents||[]).map(c=>c.exp).filter(Boolean).sort(); return e[0]||''; }
function rank(s){return s==='expired'?0:s==='soon'?1:2}

/* ---------- storage ---------- */
function loadLocal(){ try{ const d=JSON.parse(localStorage.getItem(LS_KEY)||'null'); if(d) COLS.forEach(c=>S[c]=d[c]||{}); }catch(e){} }
function saveLocal(){ try{ localStorage.setItem(LS_KEY,JSON.stringify(S)); }catch(e){ toast('לא ניתן לשמור בדפדפן הזה'); } }
const clean=o=>JSON.parse(JSON.stringify(o));
async function put(col,obj){
  if(mode==='db'){
    try{ await db.collection(col).doc(obj.id).set(clean(obj)); return true; }
    catch(e){ return fail(e); }
  }
  S[col][obj.id]=obj;
  if(col==='moves'){ const ids=Object.values(S.moves).sort((a,b)=>b.at-a.at).slice(300).map(m=>m.id); ids.forEach(i=>delete S.moves[i]); }
  saveLocal(); renderData(); return true;
}
async function del(col,id){
  if(mode==='db'){ try{ await db.collection(col).doc(id).delete(); return true; }catch(e){ return fail(e); } }
  delete S[col][id]; saveLocal(); renderData(); return true;
}
function fail(e){
  const code=e&&e.code;
  if(code==='invalid_argument') toast('אין לך הרשאה לשנות נתונים כאן.');
  else if(code==='quota_exceeded') toast('נגמר המקום לשמירת נתונים. מחקו רשומות ישנות.');
  else toast('השמירה נכשלה. נסו שוב בעוד רגע.');
  return false;
}
function log(type,o,qty,note){
  return put('moves',{id:uid('m'),at:Date.now(),type,label:o.name||'',sku:o.sku||o.serial||'',batch:o.batch||'',qty:qty||0,loc:o.loc||'',note:note||''});
}
function subscribe(){
  const pending=new Set(COLS);
  const t=setTimeout(()=>{ if(pending.size){ loadErr=true; renderData(); } },10000);
  const done=c=>{ if(pending.delete(c) && !pending.size){ clearTimeout(t); mode='db'; } renderData(); };
  const onErr=c=>e=>{ if(e&&e.code==='revoked'){ toast('הגישה לנתונים הסתיימה.'); } done(c); };
  ['items','kits','locations','catalog','batches','perms','ledger','counts','cancels','caregivers','meta','recon','boxes','boxtpl','sap','sapmeta'].forEach(c=>{
    db.collection(c).onSnapshot(snap=>{ const o={}; snap.docs.forEach(d=>{o[d.id]=Object.assign({},d.data(),{id:d.id});}); S[c]=o; done(c); }, onErr(c));
  });
  db.collection('moves').orderBy('at','desc').limit(300).onSnapshot(snap=>{ const o={}; snap.docs.forEach(d=>{o[d.id]=Object.assign({},d.data(),{id:d.id});}); S.moves=o; done('moves'); }, onErr('moves'));
}

/* ---------- helpers ---------- */
function allLocs(){
  const custom=Object.values(S.locations).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)).map(l=>l.name);
  const set=[...DEFAULT_LOCS]; custom.forEach(n=>{ if(!set.includes(n)) set.push(n); });
  Object.values(S.items).concat(Object.values(S.kits)).forEach(o=>{ if(o.loc && !set.includes(o.loc)) set.push(o.loc); });
  return set;
}
function locOptions(sel,selected){
  const cur=selected!=null?selected:sel.value;
  sel.innerHTML=allLocs().map(l=>`<option value="${esc(l)}">${esc(l)}</option>`).join('');
  if(cur && allLocs().includes(cur)) sel.value=cur;
}
function expPicker(container,val,idp){
  const n=new Date(); const y0=n.getFullYear();
  let [y,m]=val?val.split('-'):['',''];
  const yrs=[]; for(let i=y0-3;i<=y0+12;i++) yrs.push(i);
  container.innerHTML=`<select id="${idp}m" aria-label="חודש תפוגה" required><option value="">חודש</option>${MONTHS.map((nm,i)=>`<option value="${String(i+1).padStart(2,'0')}" ${m===String(i+1).padStart(2,'0')?'selected':''}>${String(i+1).padStart(2,'0')} · ${nm}</option>`).join('')}</select>
  <select id="${idp}y" aria-label="שנת תפוגה" required><option value="">שנה</option>${yrs.map(v=>`<option ${String(v)===y?'selected':''}>${v}</option>`).join('')}</select>`;
}
function readExp(idp){ const m=$('#'+idp+'m').value, y=$('#'+idp+'y').value; return (m&&y)?`${y}-${m}-01`:''; }
let toastT;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),3200); }
function openDlg(d){ d.showModal(); const f=d.querySelector('input:not([type=hidden]),select'); if(f) setTimeout(()=>f.focus(),30); }
document.querySelectorAll('dialog').forEach(d=>{ d.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>d.close())); });

function counts(){
  const items=Object.values(S.items);
  const kits=Object.values(S.kits).filter(k=>k.status!=='issued');
  const c={rows:items.length,units:items.reduce((s,i)=>s+(+i.qty||0),0),soon:0,expired:0,next:0,kits:kits.length,kitAlerts:0};
  items.forEach(i=>{const s=status(i.exp); if(s==='soon')c.soon++; if(s==='expired')c.expired++; if(monthDiff(i.exp)===1)c.next++;});
  kits.forEach(k=>{const s=status(kitExp(k)); if(s!=='ok')c.kitAlerts++; if(s==='soon')c.soon++; if(s==='expired')c.expired++;});
  return c;
}

/* ---------- views: shells ---------- */
function shellDashboard(){
  const d=new Date().toLocaleDateString('he-IL',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  $('#main').innerHTML=`
  <div class="page-head"><div><h1>לוח בקרה</h1><p class="sub">${esc(d)}</p></div>
  <div class="head-acts"><button class="btn primary" data-act="add-item">+ הוספת פריט</button><div class="more"><button type="button" class="btn more-btn" aria-haspopup="true" aria-expanded="false">עוד <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="more-pop" role="menu"><button class="btn" data-act="add-kit">+ הוספת ערכה</button><button class="btn" data-act="mins">מינימום מלאי</button><button class="btn" data-act="backup">גיבוי</button><button class="btn" type="button" data-trace>איתור אצווה (ריקול)</button></div></div></div></div>
  <div id="notice"></div>
  <section class="rem" id="dRem" aria-live="polite"></section>
  <section id="dHero" aria-live="polite"></section>
  <section class="stats" id="dStats" aria-label="סיכום מלאי"></section>
  <div class="viz-wrap">
    <section class="panel viz" aria-labelledby="hUse"><div class="viz-h"><h2 id="hUse">צריכה חודשית לפי סם</h2><button class="btn sm" type="button" data-viz-table="use" id="vUseT">טבלה</button></div><p class="sub">החתמות, החתמות מערכות ושימוש מפקלים, פחות זיכויים. 6 החודשים האחרונים.</p><div id="vUse"></div></section>
    <section class="panel viz" aria-labelledby="hWhere"><div class="viz-h"><h2 id="hWhere">איפה נמצאים הסמים</h2><button class="btn sm" type="button" data-viz-table="where" id="vWhereT">טבלה</button></div><p class="sub">כמה יחידות מכל סם נמצאות בכל מקום: מלאי חופשי, ערכות ופקלים.</p><div id="vWhere"></div></section>
  </div>
  <div class="grid2">
    <section class="panel" aria-labelledby="hAtt"><h2 id="hAtt">פריטים שפג תוקפם או פגים החודש</h2><div id="dAtt"></div></section>
    <section class="panel" aria-labelledby="hLocs" style="grid-column:1/-1;order:-1"><h2 id="hLocs">סיכום כמויות לפי סם ומיקום <a href="#locations" class="btn sm">לכל המיקומים</a></h2><div id="dLocs"></div></section>
    <section class="panel" aria-labelledby="hNext"><h2 id="hNext">פגים בחודש הבא</h2><div id="dNext"></div></section>
    <section class="panel" aria-labelledby="hMoves"><h2 id="hMoves">תנועות אחרונות</h2><div id="dMoves"></div></section>
  </div>`;
}
function shellInventory(){
  $('#main').innerHTML=`
  <div class="page-head"><div><h1>מלאי</h1><p class="sub">כל הפריטים, עם הוספה והורדה של כמויות.</p></div>
  <div class="head-acts"><button class="btn primary" data-act="add-item">+ הוספת פריט</button><button class="btn" data-act="perm" id="permBtn" hidden>הרשאות משתמשים</button><button class="btn" data-act="req-perm" id="reqBtn" hidden>בקשת הרשאות</button><div class="more"><button type="button" class="btn more-btn" aria-haspopup="true" aria-expanded="false">עוד <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="more-pop" role="menu"><button class="btn" data-act="inv-csv">ייצוא ל־CSV</button><button class="btn" type="button" data-trace>איתור אצווה (ריקול)</button></div></div></div></div>
  <div id="notice"></div>
  <div class="toolbar" role="search" id="iTools">
    <div class="field"><label for="iq">חיפוש</label><input id="iq" type="search" placeholder="שם, מק״ט או אצווה" value="${esc(inv.q)}"></div>
    <button type="button" class="btn sm filt-btn" id="iFilt" aria-expanded="false" aria-controls="iTools">סינון ומיון</button>
    <div class="field adv"><label for="ist">סטטוס</label><select id="ist">
      <option value="all">הכל</option><option value="alert">דורש טיפול</option><option value="soon">פג החודש</option><option value="expired">פג תוקף</option><option value="ok">בתוקף</option></select></div>
    <div class="field adv"><label for="iloc">מיקום</label><select id="iloc"></select></div>
    <div class="field adv"><label for="isort">מיון</label><select id="isort">
      <option value="exp">לפי תאריך תפוגה</option><option value="name">לפי שם</option><option value="qty">לפי כמות</option><option value="sku">לפי מק״ט</option></select></div>
  </div>
  <p class="count-line" id="iCount" aria-live="polite"></p>
  <div class="tbl-wrap" id="iTable"></div>
  <p class="legend"><span>מקרא:</span>${PILL.soon}<span>החודש הוא חודש התפוגה</span>${PILL.expired}<span>חודש התפוגה עבר</span></p>`;
  $('#ist').value=inv.status; $('#isort').value=inv.sort;
  // בטלפון: הסינון והמיון מוסתרים מאחורי כפתור, שמראה כמה מסננים פעילים
  const filtLabel=()=>{ const n=(inv.status!=='all')+(!!inv.loc&&inv.loc!=='all')+(inv.sort!=='exp'); $('#iFilt').textContent='סינון ומיון'+(n===1?' (1 פעיל)':n?` (${n} פעילים)`:''); };
  $('#iFilt').addEventListener('click',()=>{ const t=$('#iTools'); const o=t.classList.toggle('open'); $('#iFilt').setAttribute('aria-expanded',String(o)); });
  filtLabel();
  $('#iq').addEventListener('input',e=>{inv.q=e.target.value; renderInvTable();});
  $('#ist').addEventListener('change',e=>{inv.status=e.target.value; filtLabel(); renderInvTable();});
  $('#iloc').addEventListener('change',e=>{inv.loc=e.target.value; filtLabel(); renderInvTable();});
  $('#isort').addEventListener('change',e=>{inv.sort=e.target.value; filtLabel(); renderInvTable();});
}
function shellLocations(){
  $('#main').innerHTML=`
  <div class="page-head"><div><h1>מיקומים וערכות</h1><p class="sub">מה נמצא בכל כספת ומיקום, כולל ערכות.</p></div>
  <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn" data-act="add-loc">+ הוספת מיקום</button><button class="btn primary" data-act="add-kit">+ הוספת ערכה</button></div></div>
  <div id="notice"></div>
  <nav class="chips" id="lChips" aria-label="קפיצה למיקום"></nav>
  <div id="lSections"></div>
  <section class="panel" aria-labelledby="hIssued"><h2 id="hIssued">ערכות שהוצאו</h2><div id="lIssued"></div></section>`;
}

function shellNotes(){
  $('#main').innerHTML=`<div class="page-head"><div><h1>פתקי החתמה</h1><p class="sub">כל הפתקים שנחתמו, לפי חודשים. גלוי למנהל ולמי שקיבל הרשאת זיכוי פתקים.</p></div></div><div id="sgReport"></div>`;
  if(window.SG) window.SG.mountReport($('#sgReport'));
}
/* ---------- signing on usage ---------- */
const SG_MAP={'מורפיום':'morphine','מידזולם':'midazolam','קטמין 50':'ketamine50','קטמין 500':'ketamine500','אקטיק':'actiq'};
function signOut(id){
  const i=S.items[id]; if(!i) return;
  if(!window.SG){ openQty(id,'out'); return; }
  const key=SG_MAP[(i.name||'').trim()]||'other';
  const it={drug:key,qty:1}; if(key==='other') it.name=i.name;
  window.SG.open({items:[it],lock:key,max:+i.qty||0,itemId:id,meta:{batch:i.batch||'',loc:i.loc||'',sku:i.sku||''},
    context:`מהמלאי: ${i.name}${i.batch?' · אצווה '+i.batch:''} · ${i.loc} · זמין: ${i.qty}`,
    onSigned:async rec=>{
      const cur=S.items[id]; const n=((rec.items||[])[0]||{}).qty||0;
      if(!cur||!n){ toast('הפתק נשמר, אבל הפריט לא נמצא במלאי. עדכן ידנית.'); return; }
      const nq=Math.max(0,(+cur.qty||0)-n); const o=Object.assign({},cur,{qty:nq,updatedAt:Date.now()});
      if(await put('items',o)){ signLedger(o,n,rec); log('sign',o,n,'פתק החתמה · '+rec.reason+' · '+rec.name+(rec.remarks?' · '+rec.remarks:'')); toast(`${cur.name}: נחתם והורד מהמלאי. נותרו ${nq}.`); }
      else toast('הפתק נשמר, אבל עדכון המלאי נכשל. עדכן ידנית.');
    }});
}

/* ---------- views: data ---------- */
function renderNotice(){
  const n=$('#notice'); if(!n) return;
  if(loadErr) n.innerHTML='<div class="notice" role="alert">טעינת הנתונים לוקחת יותר מהרגיל. רעננו את הדף.</div>';
  else if(mode==='loading') n.innerHTML='<div class="notice">טוען נתונים…</div>';
  else if(mode==='local') n.innerHTML='<div class="notice">הנתונים נשמרים בדפדפן הזה בלבד.</div>';
  else n.innerHTML='';
}
function itemLine(o,isKit){
  const s=status(isKit?kitExp(o):o.exp);
  const exp=isKit?kitExp(o):o.exp;
  const meta=isKit?`ערכה${o.serial?' '+esc(o.serial):''}, ${esc(o.loc)}`:`מק״ט ${esc(o.sku)}${o.batch?', אצווה '+esc(o.batch):''}, ${esc(o.loc)}, כמות ${esc(o.qty)}`;
  return `<li class="${s}"><div class="what"><strong>${isKit?'🧰 ':''}${esc(o.name)}</strong><small>${meta}. תוקף ${fmtExp(exp)}</small></div>${PILL[s]}</li>`;
}
const SVG=d=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS={
  box:SVG('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" x2="12" y1="22" y2="12"/>'),
  layers:SVG('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
  clock:SVG('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  x:SVG('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
  kit:SVG('<rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>')
};
/* ---------- storage places shown in "where the drugs are" (fixed order = fixed colour slot) ----------
   כדי להוסיף בעתיד מקום חדש שבונים ממנו מאגר סמים (כמו ערכות או פקלים), מוסיפים כאן שורה אחת. */
function kitsOnlyStockOf(name){ return Object.values(S.kits).filter(k=>k.status!=='issued').reduce((t,k)=>t+(k.contents||[]).filter(c=>c.name===name).reduce((a,c)=>a+(+c.qty||0),0),0); }
const STOCK_POOLS=[
  {key:'free', label:'מלאי חופשי', qty:name=>stockOf(name)},
  {key:'kits', label:'ערכות',      qty:name=>kitsOnlyStockOf(name)},
  {key:'boxes',label:'פקלים',      qty:name=>boxStockOf(name)}
];
/* ---------- dashboard charts (dataviz method: single-series small multiples + 2-series stacked bars) ---------- */
const USE_TYPES={sign:1,'kit-sign':1,'box-use':1};
function chartDrugs(){ return DRUGS.map(d=>d[0]); }
function last6Months(){ const out=[], n=new Date(); for(let i=5;i>=0;i--){ const d=new Date(n.getFullYear(),n.getMonth()-i,1); out.push({y:d.getFullYear(),m:d.getMonth(),key:d.getFullYear()+'-'+(d.getMonth()+1),label:MONTHS[d.getMonth()].slice(0,3)}); } return out; }
function usageByMonth(){
  const months=last6Months(), idx=new Map(months.map((m,i)=>[m.key,i])), res={};
  chartDrugs().forEach(d=>res[d]=months.map(()=>0));
  Object.values(S.ledger).forEach(l=>{ const t=new Date(l.at), i=idx.get(t.getFullYear()+'-'+(t.getMonth()+1)); if(i==null||!res[l.name]) return;
    if(USE_TYPES[l.type]) res[l.name][i]+=(+l.outQty||0); else if(l.type==='cancel') res[l.name][i]-=(+l.inQty||0); });
  Object.values(res).forEach(a=>a.forEach((v,i)=>{ if(v<0) a[i]=0; }));
  return {months,res};
}
const vizTip=(()=>{ let el=null; return { show(target,html){ if(!el){ el=document.createElement('div'); el.className='viz-tip'; el.setAttribute('role','tooltip'); document.body.appendChild(el); }
    el.innerHTML=html; el.hidden=false; const r=target.getBoundingClientRect(), w=el.offsetWidth, h=el.offsetHeight;
    let x=r.left+r.width/2-w/2, y=r.top-h-8; if(y<8) y=r.bottom+8; x=Math.max(8,Math.min(x,innerWidth-w-8)); el.style.left=x+'px'; el.style.top=y+'px'; },
  hide(){ if(el) el.hidden=true; } }; })();
let vizTable={use:false,where:false};
function renderCharts(){
  const vu=$('#vUse'), vw=$('#vWhere'); if(!vu||!vw) return;
  /* 1) monthly usage – small multiples, one hue, shared scale */
  const {months,res}=usageByMonth(); const drugs=chartDrugs();
  const max=Math.max(1,...drugs.flatMap(d=>res[d]));
  const tickMax=max<=5?5:max<=10?10:Math.ceil(max/10)*10;
  if(vizTable.use){
    vu.innerHTML=`<div class="tbl-wrap" style="box-shadow:none"><table><thead><tr><th scope="col">סם</th>${months.map(m=>`<th scope="col">${esc(m.label)}</th>`).join('')}</tr></thead><tbody>${drugs.map(d=>`<tr><th scope="row" style="background:none;color:var(--ink)">${esc(d)}</th>${res[d].map(v=>`<td class="num">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else {
    const cols=vu.clientWidth<420?2:3;
    const W=Math.max(140,Math.floor((vu.clientWidth-(cols-1)*18)/cols)),H=96,top=16,base=74,bw=Math.min(20,Math.floor(W/6)-8);
    vu.innerHTML=`<div class="viz-sm-grid" style="grid-template-columns:repeat(${cols},1fr)">${drugs.map(d=>{ const a=res[d], total=a.reduce((s,v)=>s+v,0);
      const bars=a.map((v,i)=>{ const cx=W-(i+0.5)*(W/6); /* RTL: newest month on the left */ const hgt=v?Math.max(3,(v/tickMax)*(base-top)):0; const x=cx-bw/2, y=base-hgt, r=Math.min(4,hgt);
        const path=hgt?`<path class="viz-bar" d="M${x},${base}V${y+r}Q${x},${y} ${x+r},${y}H${x+bw-r}Q${x+bw},${y} ${x+bw},${y+r}V${base}Z"/>`:'';
        return `${path}<rect class="viz-hit" x="${cx-(W/12)}" y="${top-12}" width="${W/6}" height="${base-top+30}" tabindex="0" data-tip="${esc(months[i].label)} ${months[i].y}|${v}|${esc(d)}" aria-label="${esc(d)}, ${esc(MONTHS[months[i].m])}: ${v}"></rect><text class="viz-x" x="${cx}" y="${base+16}" text-anchor="middle">${esc(months[i].label)}</text>${i===5&&v?`<text class="viz-val" x="${cx}" y="${y-5}" text-anchor="middle">${v}</text>`:''}`; }).join('');
      return `<figure class="viz-sm"><figcaption><strong>${esc(d)}</strong><span>${total} ב־6 חודשים</span></figcaption><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="צריכה חודשית של ${esc(d)}"><line class="viz-base" x1="0" x2="${W}" y1="${base}" y2="${base}"/>${bars}</svg></figure>`; }).join('')}</div>
      <p class="hint viz-note">אותו קנה מידה לכל הסמים (עד ${tickMax} בחודש). הזמן נע מימין לשמאל: החודש הנוכחי משמאל.</p>`;
  }
  /* 2) where the drugs are – one stacked bar per drug, one segment per storage place (STOCK_POOLS) */
  const pools=STOCK_POOLS;
  const rows=drugs.map(d=>{ const v=pools.map(p=>p.qty(d)); return {d,v,tot:v.reduce((a,b)=>a+b,0)}; }).filter(r=>r.tot);
  const mx=Math.max(1,...rows.map(r=>r.tot));
  if(vizTable.where){
    vw.innerHTML=rows.length?`<div class="tbl-wrap" style="box-shadow:none"><table><thead><tr><th scope="col">סם</th>${pools.map(p=>`<th scope="col">${esc(p.label)}</th>`).join('')}<th scope="col">סה״כ</th></tr></thead><tbody>${rows.map(r=>`<tr><th scope="row" style="background:none;color:var(--ink)">${esc(r.d)}</th>${r.v.map(x=>`<td class="num">${x}</td>`).join('')}<td class="num">${r.tot}</td></tr>`).join('')}</tbody></table></div>`:'<p class="empty">אין מלאי.</p>';
  } else {
    vw.innerHTML=`<div class="viz-legend" aria-hidden="true">${pools.map((p,i)=>`<span><i class="s${i+1}"></i>${esc(p.label)}</span>`).join('')}</div>`+(rows.length?rows.map(r=>`<div class="viz-row"><span class="viz-name">${esc(r.d)}</span><div class="viz-track" role="img" aria-label="${esc(r.d)}: ${pools.map((p,i)=>esc(p.label)+' '+r.v[i]).join(', ')}">
      ${r.v.map((x,i)=>x?`<span class="viz-seg s${i+1}" style="width:${x/mx*100}%" tabindex="0" data-tip="${esc(pools[i].label)}|${x}|${esc(r.d)}"></span>`:'').join('')}</div><span class="viz-tot">${r.tot}</span></div>`).join(''):'<p class="empty">אין מלאי.</p>');
  }
  $('#vUseT').textContent=vizTable.use?'גרף':'טבלה'; $('#vWhereT').textContent=vizTable.where?'גרף':'טבלה';
}
const tipFor=t=>{ const [a,v,d]=t.dataset.tip.split('|'); return `<strong>${esc(v)}</strong> ${esc(d)}<br><span>${esc(a)}</span>`; };
document.addEventListener('pointerover',e=>{ const t=e.target.closest&&e.target.closest('[data-tip]'); if(t) vizTip.show(t,tipFor(t)); });
document.addEventListener('pointerout',e=>{ if(e.target.closest&&e.target.closest('[data-tip]')) vizTip.hide(); });
document.addEventListener('focusin',e=>{ const t=e.target.closest&&e.target.closest('[data-tip]'); if(t) vizTip.show(t,tipFor(t)); else vizTip.hide(); });
document.addEventListener('click',e=>{ const b=e.target.closest('[data-viz-table]'); if(!b) return; vizTable[b.dataset.vizTable]=!vizTable[b.dataset.vizTable]; renderCharts(); });
addEventListener('scroll',()=>vizTip.hide(),{passive:true});
let vizRT=null; addEventListener('resize',()=>{ clearTimeout(vizRT); vizRT=setTimeout(()=>{ if(route==='dashboard') renderCharts(); },150); });

function renderDashboard(){
  const c=counts(); const alerts=c.soon+c.expired;
  const h=$('#dHero');
  if(mode==='loading'){ h.innerHTML=''; }
  else{
    const cls=c.expired?'bad':c.soon?'soon':'';
    const msg=alerts?(alerts===1?'פריט אחד דורש טיפול':`${alerts} פריטים דורשים טיפול`):'כל המלאי בתוקף';
    const parts=[]; if(c.expired) parts.push(`${c.expired} פגי תוקף`); if(c.soon) parts.push(`${c.soon} פגים החודש`);
    h.innerHTML=`<div class="hero ${cls}"><div class="big" aria-hidden="true">${alerts?alerts:'✓'}</div><div>
      <p class="msg">${msg}</p><p class="detail">${alerts?parts.join(', ')+'.':'אין פריטים או ערכות שפג תוקפם או שפגים החודש.'}</p>
      ${alerts?'<div class="actions"><button class="btn primary" data-act="show-alerts">הצגת הפריטים במלאי</button></div>':''}</div></div>`;
  }
  $('#dStats').innerHTML=[
    [c.rows,'שורות מלאי','box'],[c.units,'יחידות במלאי','layers'],[c.soon,'פגים החודש','clock'],[c.expired,'פגי תוקף','x'],[c.kits,'ערכות במלאי','kit']
  ].map(([n,l,ic])=>`<div class="stat"><span class="ic" aria-hidden="true">${ICONS[ic]}</span><b>${n}</b><span>${l}</span></div>`).join('');
  const att=Object.values(S.items).filter(i=>status(i.exp)!=='ok').map(i=>({o:i,k:false,e:i.exp}))
    .concat(Object.values(S.kits).filter(k=>k.status!=='issued'&&status(kitExp(k))!=='ok').map(k=>({o:k,k:true,e:kitExp(k)})))
    .sort((a,b)=>(a.e||'').localeCompare(b.e||''));
  $('#dAtt').innerHTML=att.length?`<ul class="list">${att.slice(0,12).map(a=>itemLine(a.o,a.k)).join('')}</ul>${att.length>12?`<p class="empty">ועוד ${att.length-12}.</p>`:''}`:'<p class="empty">אין כרגע פריטים שדורשים טיפול.</p>';
  const nxt=Object.values(S.items).filter(i=>monthDiff(i.exp)===1).map(i=>({o:i,k:false}))
    .concat(Object.values(S.kits).filter(k=>k.status!=='issued'&&monthDiff(kitExp(k))===1).map(k=>({o:k,k:true})));
  $('#dNext').innerHTML=nxt.length?`<ul class="list">${nxt.map(a=>itemLine(a.o,a.k)).join('')}</ul>`:'<p class="empty">אין פריטים שפגים בחודש הבא.</p>';
  const locs=allLocs();
  const drugNames=DRUGS.map(d=>d[0]); const tally={};
  const addT=(n,l,q,inKit)=>{ if(!n) return; tally[n]=tally[n]||{}; const c=tally[n][l]=tally[n][l]||{u:0,k:0}; c.u+=q; if(inKit) c.k+=q; };
  Object.values(S.items).forEach(i=>addT(i.name,i.loc,+i.qty||0,false));
  Object.values(S.kits).filter(k=>k.status!=='issued').forEach(k=>(k.contents||[]).forEach(c=>addT(c.name,k.loc,+c.qty||0,true)));
  const names=drugNames.concat(Object.keys(tally).filter(n=>!drugNames.includes(n)).sort((a,b)=>a.localeCompare(b,'he')));
  const cell=(c,tot)=>(!c||!c.u)?`<td class="num zero${tot?' tot':''}">0</td>`:`<td class="num${tot?' tot':''}">${c.u}${c.k?`<small class="in-kit">מתוכם ${c.k} בערכות</small>`:''}</td>`;
  const sum=arr=>arr.reduce((r,c)=>{ if(c){r.u+=c.u;r.k+=c.k;} return r; },{u:0,k:0});
  const colT=l=>sum(names.map(n=>(tally[n]||{})[l]));
  $('#dLocs').innerHTML=`<div class="tbl-wrap"><table class="matrix"><caption class="sr">כמות מכל סם בכל מיקום</caption><thead><tr><th scope="col">סוג הסם</th>${locs.map(l=>`<th scope="col">${esc(l)}</th>`).join('')}<th scope="col" class="tot">סה״כ בכל המיקומים</th></tr></thead><tbody>${
    names.map(n=>{ const row=tally[n]||{}; return `<tr><th scope="row">${esc(n)}</th>${locs.map(l=>cell(row[l])).join('')}${cell(sum(Object.values(row)),true)}</tr>`; }).join('')
  }</tbody><tfoot><tr><th scope="row">סה״כ יחידות</th>${locs.map(l=>cell(colT(l))).join('')}${cell(sum(locs.map(colT)),true)}</tr></tfoot></table></div>
  <p class="legend">הכמויות כוללות פריטים במלאי וגם פריטים בתוך ערכות שנמצאות במיקום. ערכות שהוצאו לא נספרות.</p>`;
  const mv=Object.values(S.moves).sort((a,b)=>b.at-a.at).slice(0,10);
  const TL={create:'נוסף פריט',in:'הוספה',out:'הורדה',edit:'עריכה',delete:'מחיקה','kit-create':'ערכה נוספה','kit-issue':'ערכה הוצאה','kit-delete':'ערכה נמחקה','kit-edit':'ערכה עודכנה','kit-return':'ערכה הוחזרה למלאי',sign:'החתמה'};
  $('#dMoves').innerHTML=mv.length?`<ul class="list">${mv.map(m=>`<li><div class="what"><strong>${esc(TL[m.type]||m.type)}${m.qty&&(m.type==='in'||m.type==='out'||m.type==='create'||m.type==='sign')?` ${m.type==='out'||m.type==='sign'?'−':'+'}${esc(m.qty)}`:''}: ${esc(m.label)}</strong><small>${esc(m.loc)}${m.batch?', אצווה '+esc(m.batch):''}${m.note?'. '+esc(m.note):''}</small></div><small>${new Date(m.at).toLocaleString('he-IL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</small></li>`).join('')}</ul>`:'<p class="empty">עוד לא היו תנועות במלאי.</p>';
}
function itemRow(i,showLoc){
  const s=status(i.exp);
  return `<tr class="${s}"><th scope="row" style="background:inherit;color:inherit;font-size:1rem;font-weight:700">${esc(i.name)}</th><td class="code" data-label="מק״ט">${esc(i.sku)}</td><td class="code" data-label="אצווה">${esc(i.batch)||'—'}</td><td class="num" data-label="כמות">${esc(i.qty)}</td><td class="code" data-label="תוקף">${fmtExp(i.exp)}</td>${showLoc?`<td data-label="מיקום">${esc(i.loc)}</td>`:''}<td data-label="סטטוס">${PILL[s]}</td>
  <td class="acts-cell"><div class="row-act">
    ${canDo('receive')?`<button class="btn sm in" data-act="qty-in" data-id="${i.id}" aria-label="הוספת כמות ל${esc(i.name)}">+ הוספה</button>`:''}
    <button class="btn sm primary" data-act="sign-item" data-id="${i.id}" aria-label="החתמה על ${esc(i.name)}" ${(+i.qty||0)<=0?'disabled':''}>✍ החתמה</button>
    ${canLower()?`<button class="btn sm out" data-act="qty-out" data-id="${i.id}" aria-label="הורדת כמות מ${esc(i.name)}" ${(+i.qty||0)<=0?'disabled':''}>− הורדה</button>`:''}
    ${canDo('edit')?`<button class="btn sm" data-act="edit-item" data-id="${i.id}" aria-label="עריכת ${esc(i.name)}">עריכה</button>
    <button class="btn sm danger" data-act="del-item" data-id="${i.id}" aria-label="מחיקת ${esc(i.name)}">מחיקה</button>`:''}
  </div></td></tr>`;
}
function itemTable(rows,showLoc,caption){
  return `<table class="inv-cards"><caption class="sr">${esc(caption)}</caption><thead><tr><th scope="col">פריט</th><th scope="col">מק״ט</th><th scope="col">אצווה</th><th scope="col">כמות</th><th scope="col">תאריך תפוגה</th>${showLoc?'<th scope="col">מיקום</th>':''}<th scope="col">סטטוס</th><th scope="col">פעולות</th></tr></thead><tbody>${rows.map(r=>itemRow(r,showLoc)).join('')}</tbody></table>`;
}
function sortItems(a,by){
  const f={exp:(x,y)=>rank(status(x.exp))-rank(status(y.exp))||(x.exp||'9').localeCompare(y.exp||'9')||x.name.localeCompare(y.name,'he'),
    name:(x,y)=>x.name.localeCompare(y.name,'he'),qty:(x,y)=>(+x.qty||0)-(+y.qty||0),sku:(x,y)=>String(x.sku).localeCompare(String(y.sku))}[by];
  return a.sort(f);
}
function renderInvTable(){
  const sel=$('#iloc'); if(!sel) return;
  const cur=inv.loc; sel.innerHTML='<option value="all">כל המיקומים</option>'+allLocs().map(l=>`<option value="${esc(l)}">${esc(l)}</option>`).join(''); sel.value=allLocs().includes(cur)?cur:'all';
  const q=inv.q.trim().toLowerCase();
  let rows=Object.values(S.items).filter(i=>{
    const s=status(i.exp);
    if(inv.status==='alert'&&s==='ok') return false;
    if(['ok','soon','expired'].includes(inv.status)&&s!==inv.status) return false;
    if(sel.value!=='all'&&i.loc!==sel.value) return false;
    if(q&&!(`${i.name} ${i.sku} ${i.batch}`.toLowerCase().includes(q))) return false;
    return true;
  });
  sortItems(rows,inv.sort);
  const total=Object.keys(S.items).length;
  $('#iCount').textContent=total?`מוצגים ${rows.length} מתוך ${total} פריטים`:'';
  $('#iTable').innerHTML=rows.length?itemTable(rows,true,'טבלת מלאי'):
    `<div style="padding:2rem;text-align:center"><p class="empty" style="margin-bottom:1rem">${total?'אין פריטים שמתאימים לסינון. נסו לשנות את החיפוש או הסטטוס.':(mode==='loading'?'טוען…':'אין עדיין פריטים במלאי.')}</p>${total?'':'<button class="btn primary" data-act="add-item">+ הוספת הפריט הראשון</button>'}</div>`;
}
function kitCard(k){
  const e=kitExp(k), s=status(e);
  return `<article class="kit ${s}" aria-label="ערכה ${esc(k.name)}">
    <div class="kit-top"><div><h4><span aria-hidden="true">🧰</span> ${esc(k.name)}</h4><small>${k.serial?'מס׳ '+esc(k.serial)+', ':''}נוספה ${new Date(k.createdAt).toLocaleDateString('he-IL')}</small></div>${s==='ok'?'<span class="pill sealed">במלאי</span>':PILL[s]}</div>
    <div><strong>תוקף הערכה:</strong> ${fmtExp(e)} <small>(הפריט עם התוקף הקרוב ביותר)</small></div>
    <details open><summary>פירוט תכולה (${(k.contents||[]).length} פריטים)</summary>
      <div class="tbl-wrap" style="margin-top:.5rem"><table><thead><tr><th scope="col">פריט</th><th scope="col">מק״ט</th><th scope="col">אצווה</th><th scope="col">כמות</th><th scope="col">תוקף</th></tr></thead><tbody>
      ${(k.contents||[]).map(c=>{const cs=status(c.exp);return `<tr class="${cs}"><td>${esc(c.name)}</td><td class="code">${esc(c.sku)}</td><td class="code">${esc(c.batch)||'—'}</td><td class="num">${esc(c.qty)}</td><td class="code">${fmtExp(c.exp)}</td></tr>`;}).join('')}
      </tbody></table></div></details>
    ${(k.taken||[]).length?`<div class="kit-taken">ערכה פתוחה. נלקח: ${esc(k.taken.map(t=>t.name+' '+t.qty).join(', '))}</div>`:''}
    <div class="row-act" style="flex-wrap:wrap"><button class="btn primary" data-act="kit-sign" data-id="${k.id}">✍ החתמה מתוך הערכה</button>${canDo('edit')?`<button class="btn" data-act="issue-kit" data-id="${k.id}">הוצאת הערכה</button><button class="btn" data-act="edit-kit" data-id="${k.id}" aria-label="עריכת תכולת ${esc(k.name)}">עריכה</button><button class="btn" data-act="dup-kit" data-id="${k.id}" aria-label="שכפול ${esc(k.name)}">שכפול</button>`:''}</div>
  </article>`;
}
function renderLocations(){
  const locs=allLocs();
  $('#lChips').innerHTML=locs.map((l,i)=>{const n=Object.values(S.items).filter(x=>x.loc===l).length+Object.values(S.kits).filter(k=>k.loc===l&&k.status!=='issued').length;return `<a href="#loc-${i}" data-jump="loc-${i}">${esc(l)} <span class="hint">(${n})</span></a>`;}).join('');
  $('#lSections').innerHTML=locs.map((l,i)=>{
    const it=sortItems(Object.values(S.items).filter(x=>x.loc===l),'exp');
    const ks=Object.values(S.kits).filter(k=>k.loc===l&&k.status!=='issued').sort((a,b)=>(kitExp(a)||'9').localeCompare(kitExp(b)||'9'));
    const custom=Object.values(S.locations).find(x=>x.name===l);
    return `<section class="loc" id="loc-${i}" aria-labelledby="loc-h-${i}" tabindex="-1">
      <div class="loc-head"><div><h2 id="loc-h-${i}">${esc(l)}</h2><span class="hint">${it.length} פריטים, ${it.reduce((s,x)=>s+(+x.qty||0),0)} יחידות, ${ks.length} ערכות</span></div>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap"><button class="btn sm" data-act="add-item" data-loc="${esc(l)}">+ פריט כאן</button><button class="btn sm" data-act="add-kit" data-loc="${esc(l)}">+ ערכה כאן</button>${custom&&!it.length&&!ks.length?`<button class="btn sm danger" data-act="del-loc" data-id="${custom.id}">מחיקת מיקום</button>`:''}</div></div>
      <div class="loc-body">
        <h3>פריטים</h3>
        ${it.length?`<div class="tbl-wrap">${itemTable(it,false,'פריטים ב'+l)}</div>`:'<p class="empty">אין פריטים במיקום הזה.</p>'}
        <h3>ערכות</h3>
        ${ks.length?`<div class="kits">${ks.map(kitCard).join('')}</div>`:'<p class="empty">אין ערכות במיקום הזה.</p>'}
      </div></section>`;
  }).join('');
  const issued=Object.values(S.kits).filter(k=>k.status==='issued').sort((a,b)=>(b.issuedAt||0)-(a.issuedAt||0));
  $('#lIssued').innerHTML=issued.length?`<ul class="list">${issued.map(k=>`<li><div class="what"><strong>${esc(k.name)}${k.serial?' ('+esc(k.serial)+')':''}</strong><small>הוצאה מ${esc(k.loc)} ב־${new Date(k.issuedAt).toLocaleString('he-IL',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}${k.issueNote?'. '+esc(k.issueNote):''}</small></div><div class="row-act"><button class="btn sm primary" data-act="return-kit" data-id="${k.id}" aria-label="החזרת ${esc(k.name)} למלאי">החזרה למלאי</button><button class="btn sm danger" data-act="del-kit" data-id="${k.id}" aria-label="מחיקת רשומת ${esc(k.name)}">מחיקת רשומה</button></div></li>`).join('')}</ul>`:'<p class="empty">עוד לא הוצאו ערכות.</p>';
}
function renderData(){
  renderNotice();
  const dl=$('#batchList'); if(dl) dl.innerHTML=[...knownBatches().values()].map(b=>`<option value="${esc(b.batch)}">${esc(b.name)}, ${fmtExp(b.exp)}</option>`).join('');
  const c=counts(); const n=c.soon+c.expired; const b=$('#navBadge');
  b.hidden=!n; b.textContent=n; b.setAttribute('aria-label',`${n} התראות תוקף`);
  const gb=$('#navGBadge'); if(gb){ gb.hidden=!n; gb.textContent=n; gb.setAttribute('aria-label',`${n} התראות תוקף`); }
  updatePermButtons();
  if(applyAccess()===false) return;
  if(route==='dashboard'){ renderDashboard(); renderCharts(); }
  else if(route==='inventory') renderInvTable();
  else if(route==='drugkits') renderBoxes();
  else if(route==='sap') renderSap();
  else if(route==='locations') renderLocations();
  else if(route==='sign') renderSign();
  else if(route==='ledger') renderLedger();
  else if(route==='count') renderCount();
  if(route==='dashboard') renderReminders();
}

/* ---------- download permissions ---------- */
const permKey=id=>'u_'+String(id).replace(/[^A-Za-z0-9_-]/g,'_');
const PERM_FLAGS=[['receive','קבלת מלאי'],['lower','הורדה'],['edit','עריכה, מחיקה והוספה של פריטים וערכות'],['count','ספירת מלאי'],['cancel','זיכוי פתקי החתמה (רואה את כל הפתקים)']];
function canDo(f){ if(mode!=='db') return true; if(me.isOwner) return true; const p=me.id&&S.perms[permKey(me.id)]; if(!(p&&p.status==='approved'&&p.uid===me.id)) return false; return !!(p.flags||{lower:true})[f]; }

/* ---------- screen access per user: none / view / full ---------- */
const TABS=[['dashboard','לוח בקרה'],['inventory','מלאי'],['drugkits','פקלי סמים'],['sign','החתמה'],['ledger','ספר סמים'],['sap','השוואה לסאפ'],['count','ספירת מלאי'],['locations','מיקומים וערכות']];
const LVLS=[['none','ללא גישה'],['view','צפייה בלבד'],['full','גישה מלאה']];
const accessReady=()=>mode==='db'&&!!me.id;
function tabLevel(t){
  if(mode==='local'||me.isOwner) return 'full';
  if(!accessReady()) return 'view'; // עד שהנתונים נטענים: בלי פעולות ובלי הפניות
  if(t==='notes') return canDo('cancel')?'full':'none'; // פתקי החתמה: למי שקיבל הרשאת זיכוי
  const p=S.perms[permKey(me.id)]; if(!(p&&p.status==='approved'&&p.uid===me.id)) return 'none';
  const v=(p.tabs||{})[t]; return v==='view'||v==='full'?v:'none';
}
const canSee=t=>tabLevel(t)!=='none', canFull=t=>tabLevel(t)==='full';
const firstTab=()=>{ const t=TABS.find(([k])=>canSee(k)); return t?t[0]:null; };
function applyAccess(){
  document.querySelectorAll('nav.tabs a[data-route]').forEach(a=>{ if(a.dataset.route!=='notes') a.hidden=!canSee(a.dataset.route); }); navGroups();
  document.body.classList.toggle('ro',route!=='noaccess'&&tabLevel(route)==='view');
  document.body.classList.toggle('no-sign',!canFull('sign'));
  if(accessReady()&&!me.isOwner){ const ok=route==='noaccess'?!firstTab():canSee(route); if(!ok){ go(); return false; } }
  return true;
}
function shellNoAccess(){
  $('#main').innerHTML=`<div class="page-head"><div><h1>אין עדיין גישה למסכים</h1><p class="sub">בקשת ההרשאות שלך נשלחה למנהל. אחרי שהמנהל יאשר ויפתח לך מסכים, הם יופיעו כאן לבד, בלי לרענן.</p></div></div>
  <div id="notice"></div><div class="row-act"><button class="btn primary" data-act="req-perm" id="reqBtn" hidden>בקשת הרשאות</button></div>`;
}
function canLower(){ return canDo('lower'); }
function updatePermButtons(){
  const pb=$('#permBtn'), rb=$('#reqBtn'); const live=mode==='db'&&user&&me.id;
  const pending=Object.values(S.perms).filter(p=>p.status==='pending').length;
  if(pb){ pb.hidden=!(live&&me.isOwner); pb.textContent=pending?`הרשאות משתמשים (${pending} ממתינות)`:'הרשאות משתמשים'; }
  if(rb){ const mine=me.id&&S.perms[permKey(me.id)]; rb.hidden=!(live&&!me.isOwner&&!(mine&&mine.status==='approved')); rb.disabled=!!(mine&&mine.status==='pending'); rb.textContent=mine&&mine.status==='pending'?'הבקשה נשלחה וממתינה לאישור':'בקשת הרשאות'; }
}
function renderPerm(){
  const all=Object.values(S.perms).sort((a,b)=>(a.at||0)-(b.at||0));
  const pend=all.filter(p=>p.status==='pending'), ok=all.filter(p=>p.status==='approved');
  $('#permPending').innerHTML=pend.length?`<ul class="list perm-list">${pend.map(p=>`<li><span><strong>${esc(p.name)}</strong> <small class="hint">${new Date(p.at).toLocaleDateString('he-IL')}</small></span><span class="row-act"><button type="button" class="btn sm primary" data-perm="approve" data-id="${esc(p.id)}">אישור</button><button type="button" class="btn sm danger" data-perm="remove" data-id="${esc(p.id)}">דחייה</button></span></li>`).join('')}</ul>`:'<p class="empty">אין בקשות ממתינות.</p>';
  $('#permList').innerHTML=ok.length?`<ul class="list perm-list">${ok.map(p=>{ const fl=p.flags||{lower:true}; return `<li style="display:block"><div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem"><strong>${esc(p.name)}</strong><button type="button" class="btn sm danger" data-perm="remove" data-id="${esc(p.id)}">הסרת המשתמש</button></div><div class="tab-lvl"><span class="flags-h" style="grid-column:1/-1">גישה למסכים</span>${TABS.map(([t,l])=>{ const v=(p.tabs||{})[t]||'none'; return `<label>${l}<select data-tab="${t}" data-id="${esc(p.id)}" aria-label="גישה של ${esc(p.name)} למסך ${l}">${LVLS.map(([k,n])=>`<option value="${k}" ${v===k?'selected':''}>${n}</option>`).join('')}</select></label>`; }).join('')}</div><div class="flags"><span class="flags-h">פעולות מותרות (במסכים עם גישה מלאה)</span>${PERM_FLAGS.map(([f,l])=>`<label class="chk"><input type="checkbox" data-flag="${f}" data-id="${esc(p.id)}" ${fl[f]?'checked':''}> ${l}</label>`).join('')}</div></li>`; }).join('')}</ul>`:'<p class="empty">עדיין אין משתמשים מאושרים.</p>';
}
function openPerm(){ if(!me.isOwner) return; renderPerm(); openDlg($('#permDlg')); }
$('#permForm').addEventListener('submit',e=>e.preventDefault());
$('#permDlg').addEventListener('change',async e=>{
  const s=e.target.closest('[data-tab]');
  if(s){ const p=S.perms[s.dataset.id]; if(!p) return; const tb=Object.assign({},p.tabs||{},{[s.dataset.tab]:s.value});
    if(await put('perms',Object.assign({},p,{tabs:tb}))) toast('הגישה למסך עודכנה'); return; }
  const c=e.target.closest('[data-flag]'); if(!c) return; const p=S.perms[c.dataset.id]; if(!p) return;
  const fl=Object.assign({},p.flags||{lower:true},{[c.dataset.flag]:c.checked}); if(await put('perms',Object.assign({},p,{flags:fl}))) toast('ההרשאות עודכנו'); });
$('#permDlg').addEventListener('click',async e=>{
  const b=e.target.closest('[data-perm]'); if(!b) return; const p=S.perms[b.dataset.id]; if(!p) return;
  if(b.dataset.perm==='approve'){ if(await put('perms',Object.assign({},p,{status:'approved',decidedAt:Date.now(),flags:p.flags||{receive:true,count:true,lower:false,edit:false},tabs:Object.fromEntries(TABS.map(([t])=>[t,'none']))}))) toast(`${p.name} אושר. עכשיו קבעו לאילו מסכים יש לו גישה.`); }
  else if(await del('perms',p.id)) toast('ההרשאה הוסרה');
  setTimeout(renderPerm,300);
});
$('#reqForm').addEventListener('submit',async e=>{
  e.preventDefault(); const n=$('#reqName').value.trim();
  if(!n) return $('#reqErr').textContent='יש להקליד את השם שלך.';
  if(!me.id) return $('#reqErr').textContent='לא ניתן לזהות את המשתמש שלך.';
  setMyName(n); if(await put('perms',{id:permKey(me.id),uid:me.id,name:n,status:'pending',at:Date.now()})){ $('#reqDlg').close(); toast('הבקשה נשלחה למנהל'); }
});

/* ---------- signing sheet (פתק רפואה) ---------- */
const RX=[['morphine','מורפיום','MORPHINE','opioid'],['midazolam','מידזולם','MIDAZOLAM','benzo'],['ketamine50','קטמין 50','KETAMINE 50','induct'],['ketamine500','קטמין 500','KETAMINE 500','induct'],['actiq','אקטיק','ACTIQ (FENTANYL)','opioid']];
let rxTab='new', rxSel={};
function stockOf(name){ return Object.values(S.items).filter(i=>i.name===name).reduce((t,i)=>t+(+i.qty||0),0); }
function rxList(){
  const base=RX.map(([id,he,en,cls])=>({key:id,name:he,en,cls}));
  const extra=[...new Set(Object.values(S.items).filter(i=>(+i.qty||0)>0).map(i=>i.name))].filter(n=>!RX.some(r=>r[1]===n)).sort((a,b)=>a.localeCompare(b,'he')).map(n=>({key:'other',name:n,en:'OTHER',cls:'other'}));
  return base.concat(extra);
}
function shellSign(){
  $('#main').innerHTML=`
  <div class="rx">
    <div class="rx-head"><div><h1>פתק רפואה – החתמה</h1><p>אפשר לסמן כמה תרופות באותו פתק.</p></div><span class="rx-stamp">מוגבל</span></div>
    <div id="notice"></div>
    <div class="rx-tabs" role="tablist" aria-label="החתמה">
      <button class="rx-tab" role="tab" id="rxTabNew" aria-controls="rxPanelNew" data-rx="new">פתק חדש</button>
      <button class="rx-tab" role="tab" id="rxTabMonth" aria-controls="rxPanelMonth" data-rx="month">פירוט חודשי</button>
    </div>
    <section id="rxPanelNew" role="tabpanel" aria-labelledby="rxTabNew">
      <h2>על מה מחתימים?</h2>
      <p class="rx-help">בוחרים תרופה וכמות, ואז מיקום ואצווה מתוך המלאי. אפשר לבחור כמה תרופות לאותו פתק.</p>
      <div class="rx-grid" id="rxGrid"></div>
      <p class="err" id="rxErr" role="alert"></p>
      <button class="rx-new" type="button" id="rxGo" disabled>המשך לחתימה</button>
      <p class="rx-count" id="rxCount" aria-live="polite"></p>
    </section>
    <section id="rxPanelMonth" role="tabpanel" aria-labelledby="rxTabMonth" hidden><div id="rxReport"></div></section>
  </div>`;
  document.querySelectorAll('[data-rx]').forEach(t=>t.addEventListener('click',()=>{ rxTab=t.dataset.rx; setRxTab(); }));
  const g=$('#rxGrid');
  g.addEventListener('click',e=>{
    const t=e.target.closest('[data-pick]'); if(t){ rxSel[t.dataset.pick]={qty:1,loc:'',item:''}; $('#rxErr').textContent=''; renderSign(); const q=document.getElementById('rxq-'+cssId(t.dataset.pick)); if(q) q.focus(); return; }
    const st=e.target.closest('[data-step]'); if(st){ const n=st.dataset.name, sel=rxSel[n]; if(!sel) return;
      sel.qty=Math.max(0,(parseInt(sel.qty,10)||0)+(+st.dataset.step)); if(!sel.qty) delete rxSel[n]; $('#rxErr').textContent=''; renderSign(); return; }
  });
  g.addEventListener('input',e=>{ const n=e.target.dataset.qty; if(n==null||!rxSel[n]) return; rxSel[n].qty=e.target.value; $('#rxErr').textContent=''; updateRxCount(); });
  g.addEventListener('change',e=>{
    const n=e.target.dataset.name, f=e.target.dataset.f; if(!n||!f||!rxSel[n]) return;
    rxSel[n][f]=e.target.value; if(f==='loc') rxSel[n].item=''; $('#rxErr').textContent=''; renderSign();
  });
  $('#rxGo').addEventListener('click',goSign);
  setRxTab();
}
const cssId=n=>Array.from(n).map(c=>c.charCodeAt(0).toString(36)).join('-');
function setRxTab(){
  if(!canFull('sign')) rxTab='month'; // צפייה בלבד: רק הפירוט החודשי
  const m=rxTab==='month';
  $('#rxTabNew').setAttribute('aria-selected',String(!m)); $('#rxTabMonth').setAttribute('aria-selected',String(m));
  $('#rxPanelNew').hidden=m; $('#rxPanelMonth').hidden=!m;
  if(m&&window.SG) window.SG.mountReport($('#rxReport'));
}
function renderSign(){
  const g=$('#rxGrid'); if(!g) return;
  const act=document.activeElement&&g.contains(document.activeElement)?document.activeElement.id:null;
  const avail=Object.values(S.items).filter(i=>(+i.qty||0)>0);
  g.innerHTML=rxList().map(d=>{
    const n=stockOf(d.name), sel=rxSel[d.name], id=cssId(d.name);
    if(!sel) return `<button type="button" class="rx-tile sg-${d.cls}" data-pick="${esc(d.name)}" aria-label="${esc(d.name)}, במלאי ${n}" ${n?'':'disabled style="opacity:.5;cursor:not-allowed"'}><b>${esc(d.name)}</b><small>${esc(d.en)}</small><span class="stock">${n?'במלאי: '+n:'אין במלאי'}</span></button>`;
    const locs=[...new Set(avail.filter(i=>i.name===d.name).map(i=>i.loc))];
    if(sel.loc&&!locs.includes(sel.loc)){ sel.loc=''; sel.item=''; } if(!sel.loc&&locs.length===1) sel.loc=locs[0];
    const its=avail.filter(i=>i.name===d.name&&i.loc===sel.loc).sort((a,b)=>(a.exp||'').localeCompare(b.exp||''));
    if(sel.item&&!its.some(i=>i.id===sel.item)) sel.item=''; if(!sel.item&&its.length===1) sel.item=its[0].id;
    const it=S.items[sel.item]; const stt=it?status(it.exp):'ok';
    return `<div class="rx-card sg-${d.cls}" role="group" aria-label="${esc(d.name)}">
      <div class="rx-card-top"><div><b>${esc(d.name)}</b><small>${esc(d.en)}</small></div>
        <div class="sg-step"><button type="button" data-step="1" data-name="${esc(d.name)}" aria-label="הוספת יחידה">+</button><input id="rxq-${id}" type="number" inputmode="numeric" min="1" step="1" data-qty="${esc(d.name)}" value="${esc(sel.qty)}" aria-label="כמות ${esc(d.name)}"><button type="button" data-step="-1" data-name="${esc(d.name)}" aria-label="הורדת יחידה">−</button><span class="sg-unit">יח׳</span></div></div>
      <div class="two">
        <div class="field"><label for="rxl-${id}">מאיפה מחתימים? (מיקום)</label><select id="rxl-${id}" data-name="${esc(d.name)}" data-f="loc">${optHtml('בחרו מיקום',locs.map(l=>[l,l]),sel.loc)}</select></div>
        <div class="field"><label for="rxi-${id}">אצווה</label><select id="rxi-${id}" data-name="${esc(d.name)}" data-f="item" ${sel.loc?'':'disabled'}>${optHtml(sel.loc?'בחרו אצווה':'קודם בוחרים מיקום',its.map(i=>[i.id,`${i.batch||'ללא אצווה'}, תוקף ${fmtExp(i.exp)}, במלאי ${i.qty}`]),sel.item)}</select></div>
      </div>
      ${it?`<div class="info">מק״ט ${esc(it.sku)}, במלאי באצווה: <strong>${esc(it.qty)}</strong> ${PILL[stt]}${stt==='expired'?' <strong>האצווה פגת תוקף</strong>':''}</div>`:''}
    </div>`;
  }).join('');
  Object.keys(rxSel).forEach(n=>{ if(!rxList().some(d=>d.name===n)) delete rxSel[n]; });
  if(act){ const el=document.getElementById(act); if(el) el.focus(); }
  updateRxCount();
}
function optHtml(ph,opts,val){ return `<option value="">${esc(ph)}</option>`+opts.map(([v,l])=>`<option value="${esc(v)}" ${v===val?'selected':''}>${esc(l)}</option>`).join(''); }
function updateRxCount(){
  const k=Object.keys(rxSel); const b=$('#rxGo'), c=$('#rxCount'); if(!b) return;
  b.disabled=!k.length;
  c.textContent=k.length?'בפתק: '+k.map(n=>`${n} × ${rxSel[n].qty||0}`).join(', '):'בחרו לפחות תרופה אחת.';
}
function goSign(){
  const err=m=>{ $('#rxErr').textContent=m; };
  if(!window.SG) return err('מודול ההחתמה לא נטען. רעננו את הדף.');
  const list=rxList(); const rows=[]; let others=0;
  for(const n of Object.keys(rxSel)){
    const sel=rxSel[n], d=list.find(x=>x.name===n); const it=S.items[sel.item]; const q=parseInt(sel.qty,10);
    if(isNaN(q)||q<1) return err(`${n}: יש להזין כמות של 1 ומעלה.`);
    if(!sel.loc) return err(`${n}: יש לבחור מאיפה מחתימים.`);
    if(!it) return err(`${n}: יש לבחור אצווה.`);
    if(q>(+it.qty||0)) return err(`${n}: באצווה הזו יש רק ${it.qty} יחידות.`);
    if(d.key==='other'&&++others>1) return err('אפשר לצרף לפתק אחד רק תרופה אחת מסוג "אחר".');
    rows.push({key:d.key,it,q});
  }
  err('');
  const byKey={}, maxes={}; rows.forEach(r=>{ byKey[r.key]=r.it.id; maxes[r.key]=+r.it.qty||0; });
  window.SG.open({
    items:rows.map(r=>r.key==='other'?{drug:'other',qty:r.q,name:r.it.name}:{drug:r.key,qty:r.q}),
    locks:rows.map(r=>r.key),maxes,
    meta:{batch:rows.map(r=>`${r.it.name}: ${r.it.batch||'ללא'}`).join(', '),loc:[...new Set(rows.map(r=>r.it.loc))].join(', '),sku:rows.map(r=>r.it.sku).join(', ')},
    context:'מהמלאי: '+rows.map(r=>`${r.it.name} × ${r.q}, ${r.it.loc}, אצווה ${r.it.batch||'ללא'}`).join(' | '),
    onSigned:async rec=>{
      const done=[], failed=[];
      for(const x of (rec.items||[])){
        const n=+x.qty||0; const cur=S.items[byKey[x.drug]]; if(!n) continue;
        if(!cur){ failed.push(x.drug==='other'?x.name:x.drug); continue; }
        const o=Object.assign({},cur,{qty:Math.max(0,(+cur.qty||0)-n),updatedAt:Date.now()});
        if(await put('items',o)){ signLedger(o,n,rec); log('sign',o,n,'פתק החתמה · '+rec.reason+' · '+rec.name+(rec.remarks?' · '+rec.remarks:'')); done.push(`${cur.name} ${n}`); }
        else failed.push(cur.name);
      }
      rxSel={}; if(route==='sign') renderSign();
      toast(failed.length?`הפתק נשמר. לא עודכן במלאי: ${failed.join(', ')}. עדכנו ידנית.`:`נחתם והורד מהמלאי: ${done.join(', ')}.`);
    }});
}
function applyPrefill(){
  const it=S.items[signPrefill]; signPrefill=null; if(!it||!$('#rxGrid')) return;
  rxSel={[it.name]:{qty:1,loc:it.loc,item:it.id}}; rxTab='new'; setRxTab(); renderSign();
  const q=document.getElementById('rxq-'+cssId(it.name)); if(q){ q.focus(); q.select(); }
}

/* ---------- allocate signed quantities to stock ---------- */
let alloc=null, allocSeq=0;
function rxName(it){ if(it.drug==='other') return (it.name||'').trim(); const r=RX.find(x=>x[0]===it.drug); return r?r[1]:it.drug; }
function stockRows(name){ return Object.values(S.items).filter(i=>i.name===name&&(+i.qty||0)>0).sort((a,b)=>(a.exp||'').localeCompare(b.exp||'')||String(a.loc).localeCompare(String(b.loc),'he')); }
function openAlloc(rec){
  const groups=(rec.items||[]).filter(it=>+it.qty>0).map(it=>{
    const name=rxName(it), opts=stockRows(name);
    return {name,qty:+it.qty,rows:[{k:++allocSeq,item:opts.length===1?opts[0].id:'',qty:+it.qty}]};
  });
  if(!groups.length) return;
  alloc={rec,groups}; renderAlloc(); $('#allocErr').textContent='';
  $('#allocDlg').showModal();
}
function syncAlloc(){
  document.querySelectorAll('#allocBody [data-arow]').forEach(r=>{
    const [gi,k]=r.dataset.arow.split(':').map(Number); const row=alloc.groups[gi].rows.find(x=>x.k===k); if(!row) return;
    row.item=r.querySelector('select').value; row.qty=r.querySelector('input').value;
  });
}
function renderAlloc(){
  $('#allocBody').innerHTML=alloc.groups.map((g,gi)=>{
    const opts=stockRows(g.name);
    if(!opts.length) return `<fieldset class="alloc-grp"><legend>${esc(g.name)} × ${g.qty}</legend><p class="empty" style="margin:0">אין את התרופה הזו במלאי, ולכן הכמות לא תרד.</p></fieldset>`;
    return `<fieldset class="alloc-grp"><legend>${esc(g.name)} × ${g.qty}</legend>
      ${g.rows.map((r,ri)=>`<div class="alloc-row" data-arow="${gi}:${r.k}">
        <div class="field"><label for="ar${r.k}i">מיקום ואצווה</label><select id="ar${r.k}i"><option value="">בחרו מיקום ואצווה</option>${opts.map(i=>`<option value="${esc(i.id)}" ${i.id===r.item?'selected':''}>${esc(i.loc)}, אצווה ${esc(i.batch||'ללא')}, תוקף ${fmtExp(i.exp)}, במלאי ${esc(i.qty)}</option>`).join('')}</select></div>
        <div class="field"><label for="ar${r.k}q">כמות</label><input id="ar${r.k}q" type="number" min="1" step="1" inputmode="numeric" value="${esc(r.qty)}"></div>
        ${g.rows.length>1?`<button type="button" class="btn sm danger" data-arm="${gi}:${r.k}" aria-label="הסרת שורה">הסרה</button>`:'<span></span>'}
      </div>`).join('')}
      ${opts.length>1?`<div><button type="button" class="btn sm" data-aadd="${gi}">+ פיצול לאצווה נוספת</button></div>`:''}
    </fieldset>`;
  }).join('');
}
$('#allocBody').addEventListener('click',e=>{
  const add=e.target.closest('[data-aadd]'), rm=e.target.closest('[data-arm]');
  if(!add&&!rm) return; syncAlloc();
  if(add){ const g=alloc.groups[+add.dataset.aadd]; const used=g.rows.reduce((t,r)=>t+(parseInt(r.qty,10)||0),0); g.rows.push({k:++allocSeq,item:'',qty:Math.max(1,g.qty-used)}); }
  if(rm){ const [gi,k]=rm.dataset.arm.split(':').map(Number); const g=alloc.groups[gi]; g.rows=g.rows.filter(r=>r.k!==k); }
  renderAlloc();
});
$('#allocSkip').addEventListener('click',()=>{ $('#allocDlg').close(); toast('הפתק נשמר. המלאי לא עודכן, יש לעדכן ידנית.'); });
$('#allocDlg').addEventListener('cancel',()=>toast('הפתק נשמר. המלאי לא עודכן, יש לעדכן ידנית.'));
$('#allocForm').addEventListener('submit',async e=>{
  e.preventDefault(); syncAlloc(); const err=m=>{ $('#allocErr').textContent=m; };
  const plan=[]; const perItem={};
  for(const g of alloc.groups){
    if(!stockRows(g.name).length) continue;
    let sum=0;
    for(const r of g.rows){
      const it=S.items[r.item]; const q=parseInt(r.qty,10);
      if(!it) return err(`${g.name}: יש לבחור מיקום ואצווה.`);
      if(isNaN(q)||q<1) return err(`${g.name}: יש להזין כמות של 1 ומעלה.`);
      perItem[it.id]=(perItem[it.id]||0)+q;
      if(perItem[it.id]>(+it.qty||0)) return err(`${g.name}: באצווה ${it.batch||'ללא'} ב${it.loc} יש רק ${it.qty} יחידות.`);
      sum+=q; plan.push({it,q});
    }
    if(sum!==g.qty) return err(`${g.name}: סך הכמויות (${sum}) צריך להיות ${g.qty}, כמו בפתק.`);
  }
  err(''); const rec=alloc.rec; const done=[];
  for(const {it,q} of plan){
    const cur=S.items[it.id]; if(!cur) continue;
    const o=Object.assign({},cur,{qty:Math.max(0,(+cur.qty||0)-q),updatedAt:Date.now()});
    if(await put('items',o)){ signLedger(o,q,rec); log('sign',o,q,'פתק החתמה · '+rec.reason+' · '+rec.name+(rec.remarks?' · '+rec.remarks:'')); done.push(`${cur.name} ${q}`); }
  }
  $('#allocDlg').close(); alloc=null;
  toast(done.length?`הורד מהמלאי: ${done.join(', ')}.`:'הפתק נשמר.');
});

/* ===================== v3: ledger, counts, receipts, kit signing, cancels, caregivers, low stock, backup ===================== */
let dl=null, myName='';
try{ myName=localStorage.getItem('inv-myname')||''; }catch(e){}
function setMyName(n){ myName=n; try{ localStorage.setItem('inv-myname',n); }catch(e){} }
const sgKeyOf=n=>(typeof SG_MAP!=='undefined'&&SG_MAP[(n||'').trim()])||'other';
const rxHe=id=>(RX.find(r=>r[0]===id)||[])[1]||id;
function fmtDT(ts){ return new Date(ts).toLocaleString('he-IL',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function inPeriod(ts,p){ const now=Date.now(), d=new Date();
  if(p==='14') return ts>=now-14*864e5; if(p==='30') return ts>=now-30*864e5;
  if(p==='month') return ts>=new Date(d.getFullYear(),d.getMonth(),1).getTime();
  if(p==='prev'){ const a=new Date(d.getFullYear(),d.getMonth()-1,1).getTime(), b=new Date(d.getFullYear(),d.getMonth(),1).getTime(); return ts>=a&&ts<b; }
  return true; }
const csv=rows=>'\uFEFF'+rows.map(r=>r.map(v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"').join(',')).join('\n');
async function saveFile(name,text,type){
  if(!dl){ toast('הורדת קבצים לא זמינה בתצוגה הזו'); return false; }
  try{ await dl.save({filename:name,data:new Blob([text],{type})}); return true; }
  catch(e){ if(!(e&&e.code==='declined')) toast('השמירה נכשלה'); return false; }
}

/* ---------- signature pad ---------- */
function makePad(c){
  const api={hasInk:false}; let x=null,on=false,last=null;
  function size(){ const r=c.getBoundingClientRect(); if(!r.width) return; const d=Math.max(1,window.devicePixelRatio||1);
    c.width=Math.round(r.width*d); c.height=Math.round(r.height*d); x=c.getContext('2d'); x.setTransform(d,0,0,d,0,0);
    x.lineCap='round'; x.lineJoin='round'; x.lineWidth=2.4; x.strokeStyle='#111'; x.fillStyle='#111'; api.hasInk=false; }
  const pos=e=>{ const r=c.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; };
  c.addEventListener('pointerdown',e=>{ if(!x) size(); if(!x) return; on=true; try{ c.setPointerCapture(e.pointerId); }catch(_){} last=pos(e); x.beginPath(); x.arc(last.x,last.y,1.1,0,7); x.fill(); api.hasInk=true; e.preventDefault(); });
  c.addEventListener('pointermove',e=>{ if(!on) return; const p=pos(e); x.beginPath(); x.moveTo(last.x,last.y); x.lineTo(p.x,p.y); x.stroke(); last=p; });
  ['pointerup','pointercancel','pointerleave'].forEach(t=>c.addEventListener(t,()=>{ on=false; }));
  api.reset=size;
  api.data=()=>{ const w=320,h=Math.max(1,Math.round(c.height/c.width*w)); const o=document.createElement('canvas'); o.width=w; o.height=h; const ox=o.getContext('2d'); ox.fillStyle='#fff'; ox.fillRect(0,0,w,h); ox.drawImage(c,0,0,w,h); return o.toDataURL('image/jpeg',0.7); };
  return api;
}
const qPad=makePad($('#qSig'));
$('#qSigClear').addEventListener('click',()=>qPad.reset());

/* ---------- generic dialog ---------- */
let genHandler=null;
function openGen(title,html,ok,handler){
  $('#genTitle').textContent=title; $('#genBody').innerHTML=html; $('#genErr').textContent='';
  $('#genOk').textContent=ok||'אישור'; $('#genOk').hidden=!handler; genHandler=handler;
  $('#genDlg').showModal(); const f=$('#genBody').querySelector('input:not([disabled]),select'); if(f) setTimeout(()=>f.focus(),40);
}
$('#genForm').addEventListener('submit',async e=>{
  e.preventDefault(); if(!genHandler) return $('#genDlg').close();
  const b=$('#genOk'); b.disabled=true;
  try{ const r=await genHandler(m=>{ $('#genErr').textContent=m; }); if(r) $('#genDlg').close(); } finally{ b.disabled=false; }
});

/* ---------- stock helpers + ledger ---------- */
function kitStockOf(name){ return Object.values(S.kits).filter(k=>k.status!=='issued').reduce((t,k)=>t+(k.contents||[]).filter(c=>c.name===name).reduce((a,c)=>a+(+c.qty||0),0),0)+boxStockOf(name); }
function kitStockExcl(name,kid){ return Object.values(S.kits).filter(k=>k.id!==kid&&k.status!=='issued').reduce((t,k)=>t+(k.contents||[]).filter(c=>c.name===name).reduce((a,c)=>a+(+c.qty||0),0),0)+boxStockOf(name); }
function kitTotals(k){ const t={}; if(k&&k.status!=='issued') (k.contents||[]).forEach(c=>{ t[c.name]=(t[c.name]||0)+(+c.qty||0); }); return t; }
function balAfter(o){ return Object.values(S.items).filter(i=>i.name===o.name&&i.id!==o.id).reduce((t,i)=>t+(+i.qty||0),0)+(+o.qty||0); }
function skuOf(name){ const it=Object.values(S.items).find(i=>i.name===name&&i.sku); if(it) return it.sku; const d=DRUGS.find(x=>x[0]===name); if(d) return d[1]; const c=Object.values(S.catalog).find(x=>x.name===name); return c?c.sku:''; }
function ledgerAdd(e){ const o=Object.assign({id:uid('g'),at:Date.now(),by:me.id||'',byName:myName||''},e); if(!o.sku) o.sku=skuOf(o.name);
  return put('ledger',clean(o)).then(ok=>{ if(ok&&o.type==='receive'&&typeof sapAfterReceive==='function') sapAfterReceive(o); return ok; }); }
function signLedger(o,n,rec){
  return ledgerAdd({name:o.name,sku:o.sku,itemId:o.id,batch:o.batch||'',exp:o.exp||'',loc:o.loc,type:'sign',outQty:n,balance:balAfter(o),kitBalance:kitStockOf(o.name),voucher:'פתק החתמה',note:'פתק החתמה · '+(rec.reason||'')+(rec.remarks?' · '+rec.remarks:''),noteTs:rec.ts,byName:rec.name});
}
function kitLedger(before,after,note){
  const a=kitTotals(before), b=kitTotals(after); const k=after||before; if(!k) return;
  new Set([...Object.keys(a),...Object.keys(b)]).forEach(n=>{ const d=(b[n]||0)-(a[n]||0); if(!d) return;
    ledgerAdd({name:n,type:'kit',kitId:k.id,loc:k.loc,balance:stockOf(n),kitBalance:kitStockExcl(n,k.id)+(b[n]||0),voucher:'',note:note+` (${d>0?'+':''}${d} בערכות)`}); });
}

/* ---------- shared caregiver memory + other drug names for the note ---------- */
const careId=n=>'c_'+Array.from(n).map(ch=>ch.charCodeAt(0).toString(36)).join('').slice(0,180);
window.SG_CARE={
  all:()=>{ const m={}; Object.values(S.caregivers).forEach(c=>{ m[c.name]={idType:c.idType,idNum:c.idNum}; }); return m; },
  set:(name,d)=>{ const ex=Object.values(S.caregivers).find(c=>c.name===name); if(ex&&ex.idType===d.idType&&ex.idNum===d.idNum) return; put('caregivers',{id:careId(name),name,idType:d.idType,idNum:d.idNum,updatedAt:Date.now()}); }
};
window.SG_OTHERS=()=>{ const fixed=['מורפיום','מידזולם','קטמין 50','קטמין 500','אקטיק'];
  return [...new Set(Object.values(S.catalog).map(c=>c.name).concat(Object.values(S.items).map(i=>i.name),['פנטניל']))].filter(n=>n&&!fixed.includes(n)).sort((a,b)=>a.localeCompare(b,'he')); };

/* ---------- meta (count dates, report dates, minimums) ---------- */
function metaDoc(){ return S.meta.main||{id:'main'}; }
const MAIN_DRUGS=()=>DRUGS.map(d=>d[0]);
function lastCountAt(){ return Math.max(+metaDoc().lastCount||0,...Object.values(S.counts).map(c=>+c.at||0),0); }
function setMeta(p){ return put('meta',Object.assign({},metaDoc(),p,{id:'main'})); }
async function initMeta(){
  for(let t=0;t<48&&mode==='loading';t++) await new Promise(r=>setTimeout(r,250));
  if(mode==='loading') return;
  if(!metaDoc().ledgerStart&&(mode!=='db'||me.isOwner)) setMeta({ledgerStart:Date.now()});
}

/* ---------- signature cancel (hooks used by the notes report) ---------- */
function noteLinks(n){ return Object.values(S.ledger).filter(l=>l.noteTs===n.ts&&(l.type==='sign'||l.type==='kit-sign')); }
function returnedFor(lid){ return Object.values(S.cancels).reduce((t,c)=>t+(c.lines||[]).filter(x=>x.ledgerId===lid).reduce((a,x)=>a+(+x.qty||0),0),0); }
window.SG_HOOKS={
  onNotes:()=>{ if(route==='dashboard') renderReminders(); },
  status:n=>{ const L=noteLinks(n); if(!L.length) return ''; const sg=L.reduce((t,l)=>t+(+l.outQty||0),0), rt=L.reduce((t,l)=>t+returnedFor(l.id),0); return rt<=0?'':(rt>=sg?'זוכה':'זוכה חלקית'); },
  cancel:n=>openCancel(n)
};
function openCancel(n){
  const L=noteLinks(n).sort((a,b)=>a.at-b.at);
  const dstr=esc((n.date||'').split('-').reverse().join('/'));
  if(!L.length) return openGen('זיכוי פתק','<p style="margin:0">לא נמצאה הורדה מהמלאי שקשורה לפתק הזה, ולכן אין כמות להחזיר. אם המלאי עודכן ידנית, החזירו אותו ידנית.</p>','',null);
  openGen('זיכוי פתק והחזרה למלאי',`<p class="sub" style="margin:0">פתק מ־${dstr}, ${esc(n.name)}. בחרו כמה להחזיר מכל שורה. אפשר להחזיר חלקית.</p>
    ${L.map(l=>{ const rem=(+l.outQty||0)-returnedFor(l.id); const kit=l.kitId&&S.kits[l.kitId];
      return `<div class="alloc-row" style="grid-template-columns:1fr 110px"><div><strong>${esc(l.name)}</strong><br><span class="hint">${l.kitId?'ערכה '+esc(kit?kit.name:'שנמחקה'):esc(l.loc||'')}, אצווה ${esc(l.batch||'ללא')}. נחתם ${esc(l.outQty)}, הוחזר ${(+l.outQty||0)-rem}</span></div>
      <div class="field"><label for="cx-${l.id}">להחזיר</label><input id="cx-${l.id}" type="number" min="0" max="${rem}" step="1" inputmode="numeric" value="${rem}" data-cx="${l.id}" ${rem?'':'disabled'}></div></div>`; }).join('')}
    <div class="field"><label for="cxReason">סיבת הזיכוי</label><input id="cxReason" autocomplete="off"></div>`,'זיכוי והחזרה למלאי',async err=>{
    const reason=$('#cxReason').value.trim(); if(!reason){ err('יש למלא סיבת זיכוי.'); return false; }
    const lines=[];
    for(const inp of document.querySelectorAll('#genBody [data-cx]')){ if(inp.disabled) continue; const l=S.ledger[inp.dataset.cx]; if(!l) continue;
      const rem=(+l.outQty||0)-returnedFor(l.id); const q=parseInt(inp.value,10)||0;
      if(q<0||q>rem){ err(`${l.name}: אפשר להחזיר עד ${rem}.`); return false; } if(q>0) lines.push({l,q}); }
    if(!lines.length){ err('לא נבחרה כמות להחזרה.'); return false; }
    for(const {l,q} of lines){
      if(l.kitId&&S.kits[l.kitId]){ const k=S.kits[l.kitId]; const contents=(k.contents||[]).map(c=>Object.assign({},c));
        const c=contents.find(c=>c.name===l.name&&(c.batch||'')===(l.batch||'')); if(c) c.qty=(+c.qty||0)+q; else contents.push({name:l.name,sku:l.sku||'',batch:l.batch||'',qty:q,exp:l.exp||''});
        const o=Object.assign({},k,{contents,updatedAt:Date.now()});
        if(await put('kits',o)) await ledgerAdd({name:l.name,sku:l.sku,kitId:k.id,batch:l.batch||'',loc:k.loc,type:'cancel',inQty:q,balance:stockOf(l.name),kitBalance:kitStockExcl(l.name,k.id)+contents.filter(c=>c.name===l.name).reduce((t,c)=>t+(+c.qty||0),0),voucher:'זיכוי פתק',note:'החזרה לערכה '+k.name+' · '+reason,noteTs:n.ts});
        continue; }
      const it=S.items[l.itemId];
      const o=it?Object.assign({},it,{qty:(+it.qty||0)+q,updatedAt:Date.now()}):{id:l.itemId||uid('i'),name:l.name,sku:l.sku||skuOf(l.name),batch:l.batch||'',qty:q,loc:l.loc||DEFAULT_LOCS[0],exp:l.exp||'',createdAt:Date.now(),updatedAt:Date.now()};
      if(await put('items',o)){ log('in',o,q,'זיכוי פתק'); await ledgerAdd({name:o.name,sku:o.sku,itemId:o.id,batch:o.batch||'',loc:o.loc,type:'cancel',inQty:q,balance:balAfter(o),kitBalance:kitStockOf(o.name),voucher:'זיכוי פתק',note:'זיכוי פתק · '+reason,noteTs:n.ts}); }
    }
    await put('cancels',{id:uid('x'),noteTs:n.ts,at:Date.now(),by:me.id||'',byName:myName,reason,lines:lines.map(x=>({ledgerId:x.l.id,qty:x.q}))});
    toast('הפתק זוכה והכמות הוחזרה למלאי');
    [400,1500].forEach(ms=>setTimeout(()=>{ try{ window.SG.refresh(); }catch(e){} },ms));
    return true; });
}

/* ---------- signing from a kit ---------- */
function openKitSign(id){
  const k=S.kits[id]; if(!k) return; if(!window.SG) return toast('מודול ההחתמה לא נטען. רעננו את הדף.');
  const lines=k.contents||[];
  if(!lines.length) return toast('הערכה ריקה.');
  openGen('החתמה מתוך '+k.name,`<p class="sub" style="margin:0">מסמנים כמה נלקח מכל פריט. אחרי זה נפתח פתק ההחתמה.</p>
    ${lines.map((c,ix)=>`<div class="alloc-row" style="grid-template-columns:1fr 110px"><div><strong>${esc(c.name)}</strong><br><span class="hint">אצווה ${esc(c.batch||'ללא')}, תוקף ${fmtExp(c.exp)}, בערכה ${esc(c.qty)}</span></div>
    <div class="field"><label for="ks${ix}">נלקח</label><input id="ks${ix}" type="number" min="0" max="${esc(c.qty)}" step="1" inputmode="numeric" value="0" data-ks="${ix}"></div></div>`).join('')}`,'המשך לחתימה',async err=>{
    const take=[];
    for(const inp of document.querySelectorAll('#genBody [data-ks]')){ const ix=+inp.dataset.ks, c=lines[ix]; const q=parseInt(inp.value,10)||0;
      if(q<0||q>(+c.qty||0)){ err(`${c.name}: בערכה יש ${c.qty} יחידות.`); return false; } if(q>0) take.push({ix,c,q,key:sgKeyOf(c.name)}); }
    if(!take.length){ err('סמנו לפחות פריט אחד.'); return false; }
    const others=[...new Set(take.filter(t=>t.key==='other').map(t=>t.c.name))];
    if(others.length>1){ err('אפשר לצרף לפתק אחד רק תרופה אחת מסוג "אחר".'); return false; }
    const agg={}; take.forEach(t=>{ agg[t.key]=(agg[t.key]||0)+t.q; });
    const maxes={}; lines.forEach(c=>{ const kk=sgKeyOf(c.name); maxes[kk]=(maxes[kk]||0)+(+c.qty||0); });
    const keys=Object.keys(agg);
    $('#genDlg').close();
    window.SG.open({items:keys.map(kk=>kk==='other'?{drug:'other',qty:agg[kk],name:others[0]}:{drug:kk,qty:agg[kk]}),locks:keys,maxes,
      meta:{batch:take.map(t=>`${t.c.name}: ${t.c.batch||'ללא'}`).join(', '),loc:k.loc,kit:k.name},
      context:`מתוך ערכה ${k.name}: `+take.map(t=>`${t.c.name} × ${t.q}`).join(', '),
      onSigned:rec=>applyKitSign(k.id,take,rec)});
    return false; });
}
async function applyKitSign(kid,take,rec){
  const k=S.kits[kid]; if(!k) return toast('הפתק נשמר, אבל הערכה לא נמצאה. עדכנו ידנית.');
  const contents=(k.contents||[]).map(c=>Object.assign({},c)); const used=[];
  for(const x of (rec.items||[])){ let left=+x.qty||0; const kk=x.drug;
    for(const t of take.filter(t=>t.key===kk)){ if(!left) break; const c=contents[t.ix]; const q=Math.min(left,t.q,+c.qty||0); if(q>0){ c.qty=(+c.qty||0)-q; left-=q; used.push({c,q}); } }
    contents.forEach(c=>{ if(left>0&&sgKeyOf(c.name)===kk&&(+c.qty||0)>0){ const q=Math.min(left,+c.qty); c.qty-=q; left-=q; used.push({c,q}); } });
  }
  const remain=contents.filter(c=>(+c.qty||0)>0);
  const taken=(k.taken||[]).concat(used.map(u=>({name:u.c.name,batch:u.c.batch||'',qty:u.q,at:Date.now(),by:rec.name,noteTs:rec.ts})));
  const o=Object.assign({},k,{contents:remain,taken,updatedAt:Date.now()});
  if(!(await put('kits',o))) return toast('הפתק נשמר, אבל עדכון הערכה נכשל. עדכנו ידנית.');
  for(const u of used){ const n=u.c.name;
    await ledgerAdd({name:n,sku:u.c.sku||'',kitId:k.id,batch:u.c.batch||'',exp:u.c.exp||'',loc:k.loc,type:'kit-sign',outQty:u.q,balance:stockOf(n),kitBalance:kitStockExcl(n,k.id)+remain.filter(c=>c.name===n).reduce((t,c)=>t+(+c.qty||0),0),voucher:'פתק החתמה',note:`מתוך ערכה ${k.name} · ${rec.reason||''}${rec.remarks?' · '+rec.remarks:''}`,noteTs:rec.ts,byName:rec.name});
    log('sign',{name:n,batch:u.c.batch,loc:k.loc+', ערכה '+k.name},u.q,'פתק החתמה מערכה · '+rec.name); }
  toast(`נחתם והורד מהערכה: ${used.map(u=>u.c.name+' '+u.q).join(', ')}.`);
}

/* ---------- dashboard reminders ---------- */
function lowStock(){ const mins=metaDoc().mins||{}; const out=[];
  Object.keys(mins).forEach(k=>{ const m=+mins[k]; if(!m) return; const [name,loc]=k.split('||'); if(!MAIN_DRUGS().includes(name)) return; const have=Object.values(S.items).filter(i=>i.name===name&&i.loc===loc).reduce((t,i)=>t+(+i.qty||0),0); if(have<m) out.push({name,loc,have,min:m}); });
  return out; }
function unreconciled(){
  if(!(window.SG&&window.SG.manager&&window.SG.notes)) return []; const st=metaDoc().ledgerStart; if(!st) return [];
  const linked=new Set(Object.values(S.ledger).map(l=>l.noteTs).filter(Boolean));
  return window.SG.notes().filter(n=>n.ts>=st&&n.ts<Date.now()-60000&&!linked.has(n.ts)&&!S.recon['r'+n.ts]);
}
function renderReminders(){
  const el=$('#dRem'); if(!el||mode==='loading') return; const out=[]; const m=metaDoc();
  { const c=counts(); if(c.expired||c.soon) out.push(`<div class="notice bad"><span><strong>${[c.expired?c.expired+' פגי תוקף':'',c.soon?c.soon+' פגים החודש':''].filter(Boolean).join(', ')}</strong> (פריטים וערכות).</span><button class="btn sm" type="button" data-act="show-alerts">הצגה במלאי</button></div>`); }
  const lc=lastCountAt(), d=lc?Math.floor((Date.now()-lc)/864e5):null;
  if(d===null||d>=14) out.push(`<div class="notice warn"><span>${lc?`עברו ${d} ימים מספירת המלאי האחרונה.`:'עוד לא בוצעה ספירת מלאי.'} הספירה מתבצעת כל שבועיים.</span><a class="btn sm" href="#count">לספירת מלאי</a></div>`);
  const lr=m.lastReport||0, dr=lr?Math.floor((Date.now()-lr)/864e5):null;
  if(dr===null||dr>=14) out.push(`<div class="notice"><span>הדוח הדו־שבועי של ספר הסמים מוכן להפקה.</span><a class="btn sm" href="#ledger">לספר הסמים</a></div>`);
  const low=lowStock(); if(low.length) out.push(`<div class="notice bad"><span><strong>מלאי נמוך:</strong> ${low.map(x=>`${esc(x.name)} ב${esc(x.loc)} (${x.have}, מינימום ${x.min})`).join(', ')}</span></div>`);
  const rc=unreconciled(); if(rc.length) out.push(`<div class="notice bad"><span><strong>${rc.length} פתקי החתמה לא ירדו מהמלאי.</strong> ${rc.slice(0,5).map(n=>`${esc((n.date||'').split('-').reverse().join('/'))} ${esc(n.name)} (${esc((n.items||[]).map(it=>(it.drug==='other'?it.name:rxHe(it.drug))+' '+it.qty).join(', '))})`).join('; ')}. עדכנו את המלאי ידנית ואז סמנו כטופל.</span><button class="btn sm" type="button" data-recon-all>סימון כטופל</button></div>`);
  if(canSee('sap')&&sapLast()){ const sh=sapRows().filter(r=>r.diff<0), rc=sapReceiptsSince();
    if(sh.length) out.push(`<div class="notice bad"><span><strong>חוסר מול סאפ:</strong> ${sh.map(r=>esc(r.name)+' '+r.diff).join(', ')}</span><a class="btn sm" href="#sap">להשוואה לסאפ</a></div>`);
    if(rc) out.push(`<div class="notice"><span><strong>התקבלו ${rc} יח׳ מאז עדכון סאפ האחרון.</strong> אחרי שהמשלוח נקלט בסאפ, עדכנו את מלאי סאפ.</span><a class="btn sm" href="#sap">להשוואה לסאפ</a></div>`); }
  if(canSee('drugkits')){ const bs=Object.values(S.boxes), em=bs.filter(b=>b.status==='empty').length, lg=bs.filter(b=>b.status==='signed'&&bxDays(b.since)>=14).length;
    if(em||lg) out.push(`<div class="notice"><span><strong>פקלי סמים:</strong> ${[em?em+' קופסאות ריקות ממתינות למילוי':'',lg?lg+' קופסאות חתומות יותר משבועיים':''].filter(Boolean).join(', ')}.</span><a class="btn sm" href="#drugkits">לפקלי סמים</a></div>`); }
  el.innerHTML=`<h2 class="todo-h">מה דורש טיפול היום${out.length?` <span class="todo-n">${out.length}</span>`:''}</h2>`+(out.length?out.join(''):'<div class="notice ok-n"><span>הכול תקין. אין משימות פתוחות.</span></div>');
}
document.addEventListener('click',async e=>{ if(!e.target.closest('[data-recon-all]')) return; if(!canFull('dashboard')) return toast('יש לך הרשאת צפייה בלבד במסך הזה.'); for(const n of unreconciled()) await put('recon',{id:'r'+n.ts,ts:n.ts,at:Date.now()}); toast('הפתקים סומנו כטופלו'); renderReminders(); });

/* ---------- minimum stock ---------- */
function openMins(){
  const mins=metaDoc().mins||{}; const names=MAIN_DRUGS(), locs=allLocs();
  openGen('מינימום מלאי',`<p class="sub" style="margin:0">קובעים כמות מינימום לכל סם בכל מיקום. כשהמלאי יורד מתחת, מופיעה התראה בלוח הבקרה. השאירו ריק כדי לא לקבוע מינימום.</p>
    <div class="tbl-wrap"><table><thead><tr><th scope="col">סם</th>${locs.map(l=>`<th scope="col">${esc(l)}</th>`).join('')}</tr></thead><tbody>${names.map(n=>`<tr><th scope="row">${esc(n)}</th>${locs.map(l=>{ const k=n+'||'+l; return `<td><input type="number" min="0" step="1" inputmode="numeric" style="max-width:90px" data-min="${esc(k)}" value="${esc(mins[k]==null?'':mins[k])}" aria-label="מינימום ${esc(n)} ב${esc(l)}"></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`,'שמירה',async()=>{
    const mm={}; document.querySelectorAll('#genBody [data-min]').forEach(i=>{ const v=parseInt(i.value,10); if(v>0) mm[i.dataset.min]=v; });
    if(await setMeta({mins:mm})){ toast('המינימום נשמר'); return true; } return false; });
}

/* ---------- backup / export ---------- */
async function doBackup(){
  const data={exportedAt:new Date().toISOString()};
  ['items','kits','locations','catalog','batches','ledger','counts','cancels','caregivers','meta','moves','boxes','boxtpl','sap','sapmeta'].forEach(c=>{ data[c]=Object.values(S[c]||{}); });
  if(await saveFile(`גיבוי-מלאי-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(data,null,1),'application/json')) toast('הגיבוי נשמר');
}
async function exportInvCsv(){
  const rows=[['פריט','מק״ט','אצווה','כמות','תאריך תפוגה','מיקום','סטטוס']].concat(sortItems(Object.values(S.items),'name').map(i=>[i.name,i.sku,i.batch||'',i.qty,fmtExp(i.exp),i.loc,{ok:'בתוקף',soon:'פג החודש',expired:'פג תוקף'}[status(i.exp)]]));
  await saveFile(`מלאי-${new Date().toISOString().slice(0,10)}.csv`,csv(rows),'text/csv');
}

/* ---------- ספר סמים (נספח ב׳) ---------- */
let lgDrug='', lgPeriod='14';
const TYPE_HE={'box-fill':'מילוי קופסת סמים','box-use':'שימוש מקופסת סמים','box-return':'החזרה מקופסה למלאי','box-open':'רישום קופסאות קיימות',receive:'קבלת מלאי',out:'הורדה',sign:'החתמה','kit-sign':'החתמה מערכה',cancel:'זיכוי פתק',count:'ספירת מלאי',adjust:'התאמה לספירה',kit:'ערכות'};
function ledgerNames(){ const ord=n=>{ const x=DRUGS.findIndex(d=>d[0]===n); return x<0?99:x; };
  return [...new Set(DRUGS.map(d=>d[0]).concat(Object.values(S.items).map(i=>i.name),Object.values(S.ledger).map(l=>l.name)).filter(Boolean))].sort((a,b)=>ord(a)-ord(b)||a.localeCompare(b,'he')); }
function ledgerRows(name,p){ return Object.values(S.ledger).filter(l=>(!name||l.name===name)&&inPeriod(l.at,p)).sort((a,b)=>a.at-b.at); }
const LG_HEAD=['תאריך','מס׳ שובר','הכנסה','הוצאה','יתרה','יתרה במחשב','מלאי בערכות / תרמילים','חתימת ק. סופר','הערות'];
const lgNote=l=>(TYPE_HE[l.type]||l.type)+(l.loc?' · '+l.loc:'')+(l.batch?' · אצווה '+l.batch:'')+(l.note?' · '+l.note:'');
function shellLedger(){
  $('#main').innerHTML=`
  <div class="page-head"><div><h1>ספר סמים</h1><p class="sub">מעקב הכנסה, הוצאה וספירת סמים לכל פריט, לפי נספח ב׳.</p></div>
  <div class="head-acts"><button class="btn primary" type="button" id="lgBi">דוח דו־שבועי לכל הסמים</button><div class="more"><button type="button" class="btn more-btn" aria-haspopup="true" aria-expanded="false">עוד <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="more-pop" role="menu"><button class="btn" type="button" id="lgRep">דוח חודשי</button><button class="btn" type="button" id="lgCsv">ייצוא הפריט ל־CSV</button><button class="btn" type="button" data-trace>איתור אצווה (ריקול)</button></div></div></div></div>
  <div id="notice"></div>
  <div class="toolbar" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
    <div class="field"><label for="lgD">שם פריט</label><select id="lgD"></select></div>
    <div class="field"><label for="lgP">תקופה</label><select id="lgP"><option value="14">14 הימים האחרונים</option><option value="30">30 הימים האחרונים</option><option value="month">החודש הנוכחי</option><option value="prev">החודש הקודם</option><option value="all">הכל</option></select></div>
  </div>
  <section class="panel"><div class="paper-head" id="lgHead"></div><div class="tbl-wrap" id="lgTable"></div></section>`;
  $('#lgP').value=lgPeriod;
  $('#lgD').addEventListener('change',e=>{ lgDrug=e.target.value; renderLedger(); });
  $('#lgP').addEventListener('change',e=>{ lgPeriod=e.target.value; renderLedger(); });
  $('#lgCsv').addEventListener('click',exportLedgerCsv);
  $('#lgRep').addEventListener('click',()=>{ const n=new Date(), opts=[]; for(let i=1;i<=12;i++){ const d=new Date(n.getFullYear(),n.getMonth()-i+1,1); opts.push([`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`,`${MONTHS[d.getMonth()]} ${d.getFullYear()}${i===1?' (החודש, עד היום)':''}`]); }
    openGen('דוח חודשי',`<p class="sub" style="margin:0">הדוח נפתח בחלון חדש. משם אפשר להדפיס או לשמור כ־PDF. בתחילת כל חודש נשמר אוטומטית עותק של הדוח של החודש הקודם.</p>
      <div class="field"><label for="repM">חודש</label><select id="repM">${opts.map(([v,l],i)=>`<option value="${v}" ${i===1?'selected':''}>${esc(l)}</option>`).join('')}</select></div>`,'פתיחת הדוח',async()=>{ window.open('/report?month='+$('#repM').value,'_blank','noopener'); return true; }); }); $('#lgBi').addEventListener('click',exportBiweekly);
}
function renderLedger(){
  const sel=$('#lgD'); if(!sel) return; const names=ledgerNames(); if(!names.includes(lgDrug)) lgDrug=names.find(n=>Object.values(S.ledger).some(l=>l.name===n))||names[0]||'';
  sel.innerHTML=names.map(n=>`<option value="${esc(n)}" ${n===lgDrug?'selected':''}>${esc(n)}</option>`).join('');
  $('#lgHead').innerHTML=`<div>שם פריט: <span>${esc(lgDrug)}</span></div><div>מק״ט: <span dir="ltr">${esc(skuOf(lgDrug))}</span></div><div style="font-size:1rem;font-weight:500">יתרה כעת: <strong>${stockOf(lgDrug)}</strong>, בערכות: <strong>${kitStockOf(lgDrug)}</strong></div>`;
  const rows=ledgerRows(lgDrug,lgPeriod);
  if(!rows.length){ $('#lgTable').innerHTML='<p class="empty" style="padding:1rem">אין רישומים בתקופה הזו.</p>'; return; }
  $('#lgTable').innerHTML=`<table class="ledger"><caption class="sr">ספר סמים ${esc(lgDrug)}</caption><thead><tr>${LG_HEAD.map(t=>`<th scope="col">${t}</th>`).join('')}</tr></thead><tbody>${rows.map(l=>{ const isC=l.type==='count', diff=isC&&l.counted!==l.balance;
    return `<tr class="${isC?'cnt':''}${diff?' diff':''}"><td>${fmtDT(l.at)}</td><td>${esc(l.voucher||'')}</td><td class="num">${l.inQty||''}</td><td class="num">${l.outQty||''}</td><td class="num">${esc(isC?l.counted:l.balance)}</td><td class="num">${esc(l.balance)}</td><td class="num">${esc(l.kitBalance==null?'':l.kitBalance)}</td><td>${esc(l.byName||'')}${l.sig?`<img class="sig-img" style="margin:.2rem auto 0" src="${esc(l.sig)}" alt="חתימה של ${esc(l.byName||'')}">`:''}</td><td class="notes">${esc(lgNote(l))}</td></tr>`; }).join('')}</tbody></table>`;
}
const lgRow=l=>[fmtDT(l.at),l.voucher||'',l.inQty||'',l.outQty||'',l.type==='count'?l.counted:l.balance,l.balance,l.kitBalance==null?'':l.kitBalance,l.byName||'',lgNote(l)];
async function exportLedgerCsv(){
  const rows=ledgerRows(lgDrug,lgPeriod); if(!rows.length) return toast('אין רישומים לייצוא');
  await saveFile(`ספר-סמים-${lgDrug}.csv`,csv([['שם פריט',lgDrug,'מק״ט',skuOf(lgDrug)],LG_HEAD].concat(rows.map(lgRow))),'text/csv');
}
async function exportBiweekly(){
  const rows=ledgerRows('', '14').sort((a,b)=>a.name.localeCompare(b.name,'he')||a.at-b.at);
  const sum=ledgerNames().map(n=>[n,skuOf(n),stockOf(n),kitStockOf(n)]);
  const data=[['דוח דו־שבועי, ספר סמים',fmtDT(Date.now())],[],['סיכום'],['שם פריט','מק״ט','יתרה כעת','בערכות']].concat(sum,[[],['תנועות ב־14 הימים האחרונים'],['שם פריט','מק״ט'].concat(LG_HEAD)],rows.map(l=>[l.name,l.sku||''].concat(lgRow(l))));
  if(await saveFile(`דוח-דו-שבועי-${new Date().toISOString().slice(0,10)}.csv`,csv(data),'text/csv')){ if(canFull('ledger')) setMeta({lastReport:Date.now()}); toast('הדוח הדו־שבועי נשמר'); }
}

/* ---------- ספירת מלאי ---------- */
let cnt=null, cPad=null;
function shellCount(){
  $('#main').innerHTML=`
  <div class="page-head"><div><h1>ספירת מלאי</h1><p class="sub">ספירה מלאה של כל המלאי והערכות, כל שבועיים.</p></div></div>
  <div id="notice"></div><div id="cStatus" class="rem"></div>
  <section class="panel" id="cFormWrap" hidden><h2>ספירה חדשה</h2><p class="sub" style="margin-bottom:.75rem">מזינים את הכמות שנספרה בפועל לכל אצווה. שורה עם פער מסומנת באדום.</p>
    <div id="cTable" style="display:grid;gap:1rem"></div>
    <div style="display:grid;gap:.8rem;margin-top:1rem;max-width:640px">
      <div class="field"><label for="cName">שם הסופר</label><input id="cName" autocomplete="name"></div>
      <div class="field"><label for="cNotes">הערות <span class="hint">(חובה כשיש פער)</span></label><textarea id="cNotes" rows="2"></textarea></div>
      <label class="chk"><input type="checkbox" id="cAdjust"> לעדכן את המלאי לכמויות שנספרו</label>
      <div class="field"><span id="cSigLbl" style="font-weight:600">חתימת הסופר</span><canvas id="cSig" class="sig" role="img" aria-labelledby="cSigLbl"></canvas><div><button type="button" class="btn sm" id="cSigClear">ניקוי חתימה</button></div></div>
      <p class="err" id="cErr" role="alert"></p>
      <div class="row-act"><button class="btn primary" type="button" id="cSave">שמירת הספירה</button><button class="btn" type="button" id="cCancel">ביטול</button></div>
    </div></section>
  <section class="panel" style="margin-top:1.25rem"><h2>ספירות קודמות</h2><div id="cHist"></div></section>`;
  cPad=makePad($('#cSig')); $('#cSigClear').addEventListener('click',()=>cPad.reset());
  $('#cTable').addEventListener('input',e=>{ const id=e.target.dataset.cnt; if(!id||!cnt) return; cnt.vals[id]=e.target.value; const it=S.items[id]; e.target.closest('tr').classList.toggle('diff',e.target.value!==''&&!!it&&+e.target.value!==(+it.qty||0)); $('#cErr').textContent=''; });
  $('#cTable').addEventListener('change',e=>{ const k=e.target.dataset.kitok; if(k&&cnt) cnt.kits[k]=e.target.checked; });
  $('#cSave').addEventListener('click',saveCount);
  $('#cCancel').addEventListener('click',()=>{ cnt=null; renderCount(); });
  $('#cStatus').addEventListener('click',e=>{ if(!e.target.closest('#cStart')) return; if(!canFull('count')||!canDo('count')) return toast('אין לך הרשאה לספירת מלאי.');
    cnt={vals:{},kits:{}}; renderCount(); $('#cName').value=myName; $('#cNotes').value=''; $('#cAdjust').checked=false; $('#cErr').textContent='';
    setTimeout(()=>{ cPad.reset(); const f=$('#cTable input'); if(f) f.focus(); },60); });
}
function renderCount(){
  const st=$('#cStatus'); if(!st) return;
  const lc=lastCountAt(), days=lc?Math.floor((Date.now()-lc)/864e5):null, due=days===null||days>=14;
  const lastC=Object.values(S.counts).sort((a,b)=>b.at-a.at)[0];
  st.innerHTML=`<div class="notice ${due?'warn':''}"><span>${lc?`ספירה אחרונה: ${fmtDT(lc)}${lastC&&lastC.byName?', '+esc(lastC.byName):''}. ${due?'הגיע הזמן לספירה הבאה.':`הספירה הבאה בעוד ${14-days} ימים.`}`:'עוד לא בוצעה ספירת מלאי.'}</span>${cnt?'':'<button class="btn primary" type="button" id="cStart">התחלת ספירה</button>'}</div>`;
  $('#cFormWrap').hidden=!cnt;
  if(cnt){
    const tb=$('#cTable'); const act=document.activeElement&&tb.contains(document.activeElement)?document.activeElement.id:null;
    tb.innerHTML=allLocs().map(l=>{ const its=sortItems(Object.values(S.items).filter(i=>i.loc===l),'name'); const ks=Object.values(S.kits).filter(k=>k.loc===l&&k.status!=='issued'); if(!its.length&&!ks.length) return '';
      return `<div><h3 style="margin:0 0 .4rem">${esc(l)}</h3>${its.length?`<div class="tbl-wrap"><table class="count-tbl"><thead><tr><th scope="col">פריט</th><th scope="col">אצווה</th><th scope="col">תוקף</th><th scope="col">במחשב</th><th scope="col">נספר</th></tr></thead><tbody>${its.map(i=>{ const v=cnt.vals[i.id]==null?'':cnt.vals[i.id]; const diff=v!==''&&+v!==(+i.qty||0);
        return `<tr class="${diff?'diff':''}"><th scope="row" style="background:inherit;color:inherit">${esc(i.name)}</th><td class="code">${esc(i.batch||'—')}</td><td class="code">${fmtExp(i.exp)}</td><td class="num">${esc(i.qty)}</td><td><input id="cv-${i.id}" type="number" min="0" step="1" inputmode="numeric" data-cnt="${i.id}" value="${esc(v)}" aria-label="נספר: ${esc(i.name)}, אצווה ${esc(i.batch||'ללא')}"></td></tr>`; }).join('')}</tbody></table></div>`:''}
      ${ks.map(k=>`<div style="margin-top:.5rem"><label class="chk"><input type="checkbox" data-kitok="${k.id}" ${cnt.kits[k.id]?'checked':''}> ערכה ${esc(k.name)}${k.serial?' ('+esc(k.serial)+')':''} נמצאת במקום ותכולתה תואמת</label></div>`).join('')}</div>`; }).join('');
    if(act){ const el=document.getElementById(act); if(el) el.focus(); }
  }
  const hist=Object.values(S.counts).sort((a,b)=>b.at-a.at).slice(0,20);
  $('#cHist').innerHTML=hist.length?hist.map(c=>{ const diffs=(c.lines||[]).filter(l=>l.counted!==l.system); const bad=(c.kits||[]).filter(k=>!k.ok);
    return `<details class="panel" style="margin-bottom:.6rem;padding:.7rem 1rem"><summary style="cursor:pointer;font-weight:700">${fmtDT(c.at)}, ${esc(c.byName||'')} · ${diffs.length?`<span style="color:var(--bad-ink)">${diffs.length} פערים</span>`:'ללא פערים'}${bad.length?` · ${bad.length} ערכות לא אומתו`:''}${c.adjusted?' · המלאי עודכן':''}</summary>
      ${diffs.length?`<div class="tbl-wrap" style="margin-top:.5rem"><table><thead><tr><th scope="col">פריט</th><th scope="col">אצווה</th><th scope="col">מיקום</th><th scope="col">במחשב</th><th scope="col">נספר</th></tr></thead><tbody>${diffs.map(l=>`<tr><td>${esc(l.name)}</td><td class="code">${esc(l.batch||'—')}</td><td>${esc(l.loc)}</td><td class="num">${l.system}</td><td class="num">${l.counted}</td></tr>`).join('')}</tbody></table></div>`:''}
      ${c.notes?`<p style="margin:.5rem 0 0">הערות: ${esc(c.notes)}</p>`:''}${c.sig?`<img class="sig-img" style="margin-top:.5rem;height:48px" src="${esc(c.sig)}" alt="חתימת ${esc(c.byName||'')}">`:''}</details>`; }).join(''):'<p class="empty">עוד לא בוצעו ספירות.</p>';
}
async function saveCount(){
  const err=m=>{ $('#cErr').textContent=m; }; if(!cnt) return;
  const lines=[];
  for(const i of Object.values(S.items)){ const v=cnt.vals[i.id];
    if(v==null||v==='') return err(`יש להזין כמות שנספרה עבור ${i.name}, אצווה ${i.batch||'ללא'}, ${i.loc}.`);
    const c=parseInt(v,10); if(isNaN(c)||c<0) return err(`כמות לא תקינה עבור ${i.name}.`);
    lines.push({itemId:i.id,name:i.name,batch:i.batch||'',loc:i.loc,system:+i.qty||0,counted:c}); }
  const kits=Object.values(S.kits).filter(k=>k.status!=='issued').map(k=>({kitId:k.id,name:k.name,ok:!!cnt.kits[k.id]}));
  const diffs=lines.filter(l=>l.counted!==l.system), badKits=kits.filter(k=>!k.ok);
  const name=$('#cName').value.trim(), notes=$('#cNotes').value.trim(), adjust=$('#cAdjust').checked;
  if(!name) return err('יש למלא את שם הסופר.');
  if((diffs.length||badKits.length)&&!notes) return err('יש פערים או ערכות שלא אומתו. פרטו בהערות.');
  if(!cPad.hasInk) return err('נדרשת חתימת הסופר.');
  setMyName(name); const sig=cPad.data(), at=Date.now(); $('#cSave').disabled=true;
  try{
    if(!(await put('counts',{id:uid('n'),at,by:me.id||'',byName:name,sig,notes,adjusted:adjust,lines,kits}))) return;
    const by={}; lines.forEach(l=>{ const b=by[l.name]=by[l.name]||{sys:0,cnt:0}; b.sys+=l.system; b.cnt+=l.counted; });
    for(const n of Object.keys(by)){ const df=by[n].cnt-by[n].sys;
      await ledgerAdd({name:n,type:'count',balance:by[n].sys,counted:by[n].cnt,kitBalance:kitStockOf(n),voucher:'ספירה',note:'ספירת מלאי'+(df?` · פער ${df>0?'+':''}${df}`:'')+(notes?' · '+notes:''),byName:name,sig,at}); }
    if(adjust){ for(const l of diffs){ const it=S.items[l.itemId]; if(!it) continue; const o=Object.assign({},it,{qty:l.counted,updatedAt:Date.now()});
      if(await put('items',o)){ const d=l.counted-l.system; log(d>0?'in':'out',o,Math.abs(d),'התאמה לספירה');
        await ledgerAdd({name:o.name,sku:o.sku,itemId:o.id,batch:o.batch||'',loc:o.loc,type:'adjust',inQty:d>0?d:0,outQty:d<0?-d:0,balance:balAfter(o),kitBalance:kitStockOf(o.name),voucher:'ספירה',note:'התאמה לספירה',byName:name}); } } }
    setMeta({lastCount:at}); cnt=null; renderCount();
    toast(diffs.length?`הספירה נשמרה. נמצאו ${diffs.length} פערים.`:'הספירה נשמרה. אין פערים.');
  } finally { const b=$('#cSave'); if(b) b.disabled=false; }
}

/* ---------- routing ---------- */
function go(){
  const h=(location.hash||'').slice(1);
  let r=['dashboard','inventory','drugkits','locations','notes','sign','ledger','sap','count','noaccess'].includes(h)?h:(h.startsWith('loc-')?'locations':'dashboard');
  // מסך שאין למשתמש גישה אליו: עוברים למסך הראשון שמותר, או לעמוד "אין גישה"
  if(accessReady()&&!me.isOwner){ if(r==='noaccess'?firstTab():!canSee(r)){ r=firstTab()||'noaccess'; history.replaceState(null,'','#'+r); } }
  else if(r==='noaccess') r='dashboard';
  const changed=r!==route||!$('#main').children.length; route=r;
  document.querySelectorAll('nav.tabs a').forEach(a=>{ if(a.dataset.route===r){ a.setAttribute('aria-current','page'); revealTab(a); } else a.removeAttribute('aria-current'); });
  closeMenu(); navGroups(); closePops();
  if(changed){ ({dashboard:shellDashboard,inventory:shellInventory,drugkits:shellDrugkits,sap:shellSap,locations:shellLocations,notes:shellNotes,sign:shellSign,ledger:shellLedger,count:shellCount,noaccess:shellNoAccess})[r](); renderData(); }
  else applyAccess();
  if(r==='sign'&&signPrefill) applyPrefill();
  if(h.startsWith('loc-')){ const el=document.getElementById(h); if(el){ el.scrollIntoView(); el.focus({preventScroll:true}); } }
  document.title=({dashboard:'לוח בקרה',inventory:'מלאי',drugkits:'פקלי סמים',sap:'השוואה לסאפ',locations:'מיקומים וערכות',notes:'פתקי החתמה',sign:'החתמה',ledger:'ספר סמים',count:'ספירת מלאי',noaccess:'אין גישה'})[r]+' | ניהול מלאי';
}
window.addEventListener('hashchange',go);

/* ---------- phone header: menu button + scrollable tabs ---------- */
const navTabs=document.querySelector('nav.tabs');
function tabFades(){ // RTL: scrollLeft is 0 at the start (right) and negative toward the end (left)
  const max=navTabs.scrollWidth-navTabs.clientWidth, pos=Math.abs(navTabs.scrollLeft);
  navTabs.classList.toggle('more-start',max>2&&pos>2); navTabs.classList.toggle('more-end',max>2&&pos<max-2); }
function revealTab(a){ if(navTabs.scrollWidth<=navTabs.clientWidth) return;
  const n=navTabs.getBoundingClientRect(), r=a.getBoundingClientRect();
  if(r.left<n.left+24) navTabs.scrollLeft-=n.left+40-r.left; else if(r.right>n.right-24) navTabs.scrollLeft+=r.right-n.right+40; }
navTabs.addEventListener('scroll',tabFades,{passive:true});
window.addEventListener('resize',tabFades); new MutationObserver(tabFades).observe(navTabs,{subtree:true,attributes:true,attributeFilter:['hidden']});
setTimeout(tabFades,0);
function closeMenu(){ const h=document.querySelector('header.top'); if(!h.classList.contains('menu-open')) return; h.classList.remove('menu-open'); $('#menuBtn').setAttribute('aria-expanded','false'); }
$('#menuBtn').addEventListener('click',()=>{ const h=document.querySelector('header.top'); const o=h.classList.toggle('menu-open'); $('#menuBtn').setAttribute('aria-expanded',String(o)); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeMenu(); });

/* ---------- drug picker ---------- */
const DRUGS=[['אקטיק','960190270'],['קטמין 50','960003235'],['קטמין 500','960003233'],['מידזולם','960006275'],['מורפיום','960003470'],['פנטניל','960002024']];
const OTHER='__other';
function bindDrug(sel,wrap,nameIn,skuIn,hint){
  sel.innerHTML='<option value="">בחרו סם</option>'+DRUGS.map(d=>`<option value="${esc(d[0])}">${esc(d[0])}</option>`).join('')+`<option value="${OTHER}">אחר</option>`;
  let auto=true;
  const fromCatalog=()=>{
    const c=Object.values(S.catalog).find(x=>x.name===nameIn.value.trim());
    if(c&&(auto||!skuIn.value.trim())){ skuIn.value=c.sku; auto=true; hint.textContent='המק״ט מולא לפי סוג ששמור במערכת. אפשר לשנות.'; }
    else if(!c){ if(auto) skuIn.value=''; hint.textContent='סוג חדש: הקלידו את המק״ט. הוא יישמר במערכת.'; }
  };
  const sync=()=>{
    const v=sel.value;
    if(v===OTHER){ wrap.hidden=false; skuIn.readOnly=false; fromCatalog(); }
    else{ wrap.hidden=true; skuIn.readOnly=true; const d=DRUGS.find(x=>x[0]===v); skuIn.value=d?d[1]:''; hint.textContent=d?'המק״ט נקבע אוטומטית לפי הסוג.':''; auto=true; }
  };
  sel.addEventListener('change',()=>{ sync(); if(sel.value===OTHER) nameIn.focus(); });
  nameIn.addEventListener('input',fromCatalog);
  skuIn.addEventListener('input',()=>{ auto=false; });
  return {
    set(name,sku){
      const known=DRUGS.find(d=>d[0]===name);
      nameIn.value='';
      if(!name){ sel.value=''; sync(); }
      else if(known){ sel.value=name; sync(); }
      else{ sel.value=OTHER; nameIn.value=name; wrap.hidden=false; skuIn.readOnly=false; skuIn.value=sku||''; auto=false; hint.textContent=''; }
    },
    read(){
      const v=sel.value; if(!v) return {error:'יש לבחור סם.'};
      if(v!==OTHER) return {name:v,sku:DRUGS.find(d=>d[0]===v)[1],other:false};
      const name=nameIn.value.trim(), sku=skuIn.value.trim();
      if(!name) return {error:'יש לרשום את סוג הסם.'};
      const known=DRUGS.find(d=>d[0]===name); if(known) return {name,sku:known[1],other:false};
      if(!sku) return {error:`יש להקליד מק״ט עבור ${name}.`};
      return {name,sku,other:true};
    }
  };
}
function rememberDrug(dr){
  if(!dr||!dr.other) return;
  const ex=Object.values(S.catalog).find(c=>c.name===dr.name);
  if(ex&&ex.sku===dr.sku) return;
  put('catalog',{id:ex?ex.id:uid('c'),name:dr.name,sku:dr.sku,updatedAt:Date.now()});
}
const itemDrug=bindDrug($('#fDrug'),$('#fNameWrap'),$('#fName'),$('#fSku'),$('#fSkuHint'));

/* ---------- batch memory ---------- */
function knownBatches(){
  const m=new Map();
  const add=o=>{ const b=(o.batch||'').trim(); if(b&&o.name) m.set(b,{batch:b,name:o.name,sku:o.sku,exp:o.exp}); };
  Object.values(S.items).forEach(add);
  Object.values(S.kits).forEach(k=>(k.contents||[]).forEach(add));
  Object.values(S.batches).forEach(add);
  return m;
}
function findBatch(v){ v=(v||'').trim(); return v?(knownBatches().get(v)||null):null; }
function rememberBatch(o){
  const b=(o.batch||'').trim(); if(!b||!o.name||!o.exp) return;
  const ex=Object.values(S.batches).find(x=>x.batch===b);
  if(ex&&ex.name===o.name&&ex.sku===o.sku&&ex.exp===o.exp) return;
  put('batches',{id:ex?ex.id:uid('b'),batch:b,name:o.name,sku:o.sku,exp:o.exp,updatedAt:Date.now()});
}
function setExp(idp,val){
  if(!val) return; const [y,m]=val.split('-'); const ms=$('#'+idp+'m'), ys=$('#'+idp+'y'); if(!ms||!ys) return;
  ms.value=m; if(![...ys.options].some(o=>o.value===y)) ys.add(new Option(y,y)); ys.value=y;
}
function bindBatch(input,hint,drug,idp){
  const apply=()=>{
    const b=findBatch(input.value);
    if(b){ drug.set(b.name,b.sku); setExp(idp,b.exp); hint.textContent=`אצווה מוכרת: ${b.name}, תוקף ${fmtExp(b.exp)}. מולא אוטומטית.`; }
    else hint.textContent=input.value.trim()?'אצווה חדשה. היא תישמר במערכת עם הסם והתוקף.':'';
  };
  input.addEventListener('input',apply); input.addEventListener('change',apply);
}
bindBatch($('#fBatch'),$('#fBatchHint'),itemDrug,'fe');

/* ---------- item dialog ---------- */
let editId=null;
function openItem(id,loc){
  editId=id||null; const i=id?S.items[id]:null;
  $('#itemDlgTitle').textContent=i?'עריכת פריט':'הוספת פריט';
  $('#itemSave').textContent=i?'שמירת שינויים':'הוספה למלאי';
  itemDrug.set(i?i.name:'',i?i.sku:''); $('#fBatch').value=i?i.batch:''; $('#fQty').value=i?i.qty:'';
  $('#fQtyWrap').hidden=!!i;
  locOptions($('#fLoc'),i?i.loc:(loc||DEFAULT_LOCS[0]));
  expPicker($('#fExp'),i?i.exp:'','fe');
  $('#itemErr').textContent=''; $('#fBatchHint').textContent='';
  openDlg($('#itemDlg'));
}
$('#itemForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const err=m=>{$('#itemErr').textContent=m;};
  const dr=itemDrug.read(); if(dr.error) return err(dr.error);
  const name=dr.name, sku=dr.sku, batch=$('#fBatch').value.trim(), loc=$('#fLoc').value, exp=readExp('fe');
  const qty=parseInt($('#fQty').value,10);
  if(!exp) return err('יש לבחור חודש ושנה של תאריך התפוגה.');
  if(!editId&&(isNaN(qty)||qty<0)) return err('יש להזין כמות של 0 ומעלה.');
  rememberDrug(dr); rememberBatch({batch,name,sku,exp});
  if(editId){
    const o=Object.assign({},S.items[editId],{name,sku,batch,loc,exp,updatedAt:Date.now()});
    if(await put('items',o)){ log('edit',o,0); $('#itemDlg').close(); toast('הפריט עודכן'); }
    return;
  }
  const same=Object.values(S.items).find(i=>i.sku===sku&&(i.batch||'')===batch&&i.loc===loc&&i.exp===exp);
  if(same){ $('#itemDlg').close(); if(qty>0) openQty(same.id,'in',qty); toast('הפריט כבר קיים במיקום הזה. השלימו קבלת מלאי.'); return; }
  const o={id:uid('i'),name,sku,batch,qty:0,loc,exp,createdAt:Date.now(),updatedAt:Date.now()};
  if(await put('items',o)){ log('create',o,0); $('#itemDlg').close(); if(qty>0){ openQty(o.id,'in',qty,o); toast('הפריט נוצר. השלימו קבלת מלאי עם חתימה.'); } else toast('הפריט נוסף למלאי'); }
});

/* ---------- quantity dialog ---------- */
let qtyCtx=null;
function openQty(id,dir,amt,fallback){
  const i=S.items[id]||fallback; if(!i) return; qtyCtx={id,dir,fallback};
  $('#qtyTitle').textContent=dir==='in'?'הוספה למלאי':'הורדה מהמלאי';
  $('#qtySave').textContent=dir==='in'?'הוספת כמות':'הורדת כמות';
  $('#qtyCur').innerHTML=`<strong>${esc(i.name)}</strong><br><span class="hint">מק״ט ${esc(i.sku)}${i.batch?', אצווה '+esc(i.batch):''}, ${esc(i.loc)}</span><br>כמות נוכחית: <strong>${esc(i.qty)}</strong>`;
  $('#qAmt').value=amt||''; $('#qAmt').max=dir==='out'?i.qty:''; $('#qNote').value=''; $('#qtyErr').textContent=''; $('#qVoucher').value='';
  $('#qRecv').hidden=dir!=='in'; $('#qRecvName').value=myName;
  openDlg($('#qtyDlg')); if(dir==='in') setTimeout(()=>qPad.reset(),60);
}
$('#qtyForm').addEventListener('submit',async e=>{
  e.preventDefault(); const i=S.items[qtyCtx.id]||qtyCtx.fallback; if(!i) return $('#qtyDlg').close();
  const err=m=>{ $('#qtyErr').textContent=m; };
  const n=parseInt($('#qAmt').value,10);
  if(isNaN(n)||n<1) return err('יש להזין כמות של 1 ומעלה.');
  if(qtyCtx.dir==='out'&&n>(+i.qty||0)) return err(`אפשר להוריד עד ${i.qty} יחידות.`);
  let rn='', sig='';
  if(qtyCtx.dir==='in'){ rn=$('#qRecvName').value.trim(); if(!rn) return err('יש למלא את שם המקבל.'); if(!qPad.hasInk) return err('נדרשת חתימת המקבל.'); sig=qPad.data(); setMyName(rn); }
  const nq=(+i.qty||0)+(qtyCtx.dir==='in'?n:-n);
  const o=Object.assign({},i,{qty:nq,updatedAt:Date.now()});
  const note=$('#qNote').value.trim(), voucher=$('#qVoucher').value.trim();
  if(await put('items',o)){
    log(qtyCtx.dir,o,n,note);
    ledgerAdd({name:o.name,sku:o.sku,itemId:o.id,batch:o.batch||'',exp:o.exp||'',loc:o.loc,type:qtyCtx.dir==='in'?'receive':'out',inQty:qtyCtx.dir==='in'?n:0,outQty:qtyCtx.dir==='out'?n:0,balance:balAfter(o),kitBalance:kitStockOf(o.name),voucher,note:(qtyCtx.dir==='in'?'קבלת מלאי':'הורדה')+(note?' · '+note:''),byName:qtyCtx.dir==='in'?rn:myName,sig});
    $('#qtyDlg').close(); toast(`${i.name}: כמות עודכנה ל־${nq}`);
  }
});

/* ---------- kit dialog ---------- */
let rowN=0;
function kitRow(c){
  const k=++rowN; const fs=document.createElement('fieldset'); fs.className='kit-row-fs'; fs.dataset.row=k;
  fs.innerHTML=`<legend>פריט בערכה</legend><div class="kit-row">
    <div class="field wide"><label for="kr${k}d">סוג הסם</label><select id="kr${k}d"></select></div>
    <div class="field wide" data-namewrap hidden><label for="kr${k}n">רישום סוג הסם</label><input id="kr${k}n" autocomplete="off"></div>
    <div class="field"><label for="kr${k}s">מק״ט</label><input id="kr${k}s" dir="ltr" autocomplete="off" aria-describedby="kr${k}h"><span class="hint" id="kr${k}h"></span></div>
    <div class="field"><label for="kr${k}b">אצווה</label><input id="kr${k}b" data-f="batch" dir="ltr" autocomplete="off" list="batchList" value="${c?esc(c.batch||''):''}" aria-describedby="kr${k}bh"><span class="hint" id="kr${k}bh"></span></div>
    <div class="field"><label for="kr${k}q">כמות</label><input id="kr${k}q" data-f="qty" type="number" min="1" step="1" inputmode="numeric" value="${c?esc(c.qty):1}"></div>
    <div class="field"><span style="font-weight:600" id="kr${k}el">תוקף</span><div class="exp-pick" role="group" aria-labelledby="kr${k}el" id="kr${k}e"></div></div>
    <div class="wide"><button type="button" class="btn sm danger" data-rm>הסרת פריט מהרשימה</button></div></div>`;
  expPicker(fs.querySelector('#kr'+k+'e'),(c&&c.exp)||'','kr'+k+'x');
  fs._drug=bindDrug(fs.querySelector('#kr'+k+'d'),fs.querySelector('[data-namewrap]'),fs.querySelector('#kr'+k+'n'),fs.querySelector('#kr'+k+'s'),fs.querySelector('#kr'+k+'h'));
  fs._drug.set(c?c.name:'',c?c.sku:'');
  bindBatch(fs.querySelector('#kr'+k+'b'),fs.querySelector('#kr'+k+'bh'),fs._drug,'kr'+k+'x');
  fs.querySelector('[data-rm]').addEventListener('click',()=>{ if($('#kitRows').children.length>1) fs.remove(); else toast('ערכה צריכה לפחות פריט אחד'); });
  $('#kitRows').appendChild(fs); return fs;
}
let kitCtx={mode:'new',id:null};
function openKit(loc,id,mode){
  const src=id?S.kits[id]:null; kitCtx={mode:src?mode:'new',id:src?id:null};
  $('#kitTitle').textContent={new:'הוספת ערכה',edit:'עריכת ערכה',dup:'שכפול ערכה'}[kitCtx.mode];
  $('#kitSub').textContent=kitCtx.mode==='dup'?`ערכה חדשה עם אותם פריטים כמו ${src.name}. יש לתת לה שם אחר.`:'אפשר לערוך את תכולת הערכה בכל זמן.';
  $('#kitSave').textContent=kitCtx.mode==='edit'?'שמירת שינויים':kitCtx.mode==='dup'?'יצירת הערכה':'שמירת הערכה';
  const isEdit=kitCtx.mode==='edit';
  $('#kName').value=isEdit?src.name:''; $('#kSerial').value=isEdit?(src.serial||''):''; $('#kitErr').textContent='';
  locOptions($('#kLoc'),src?src.loc:(loc||DEFAULT_LOCS[0]));
  $('#kitRows').innerHTML='';
  if(src&&(src.contents||[]).length) src.contents.forEach(c=>kitRow(c)); else kitRow();
  openDlg($('#kitDlg'));
}
$('#kitAddRow').addEventListener('click',()=>{ const r=kitRow(); r.querySelector('input').focus(); });
$('#kitForm').addEventListener('submit',async e=>{
  e.preventDefault(); const err=m=>{$('#kitErr').textContent=m;};
  const name=$('#kName').value.trim(); if(!name) return err('יש למלא שם לערכה.');
  const contents=[], drs=[];
  for(const fs of $('#kitRows').children){
    const g=f=>fs.querySelector(`[data-f="${f}"]`).value.trim();
    const k=fs.dataset.row; const exp=readExp('kr'+k+'x'); const qty=parseInt(g('qty'),10);
    const dr=fs._drug.read(); if(dr.error) return err(dr.error);
    if(!exp) return err(`יש לבחור תוקף לפריט ${dr.name}.`);
    if(isNaN(qty)||qty<1) return err(`יש להזין כמות לפריט ${dr.name}.`);
    contents.push({name:dr.name,sku:dr.sku,batch:g('batch'),qty,exp}); drs.push(dr);
  }
  const k={id:uid('k'),name,serial:$('#kSerial').value.trim(),loc:$('#kLoc').value,contents,status:'sealed',createdAt:Date.now()};
  const srcKit=kitCtx.id?S.kits[kitCtx.id]:null;
  if(kitCtx.mode==='dup'&&srcKit&&srcKit.name.trim()===name) return err('לערכה המשוכפלת צריך שם אחר מהמקור.');
  drs.forEach(rememberDrug); contents.forEach(rememberBatch);
  if(kitCtx.mode==='edit'&&srcKit){
    const o=Object.assign({},srcKit,{name,serial:k.serial,loc:k.loc,contents,updatedAt:Date.now()});
    if(await put('kits',o)){ kitLedger(srcKit,o,'ערכה עודכנה: '+o.name); log('kit-edit',o,contents.length); $('#kitDlg').close(); toast('הערכה עודכנה'); }
    return;
  }
  if(await put('kits',k)){ kitLedger(null,k,'ערכה נוספה: '+k.name); log('kit-create',k,contents.length,kitCtx.mode==='dup'&&srcKit?'שוכפלה מ'+srcKit.name:''); $('#kitDlg').close(); toast(kitCtx.mode==='dup'?'הערכה שוכפלה':'הערכה נוספה'); }
});

/* ---------- location dialog ---------- */
$('#locForm').addEventListener('submit',async e=>{
  e.preventDefault(); const n=$('#lName').value.trim();
  if(!n) return $('#locErr').textContent='יש למלא שם מיקום.';
  if(allLocs().includes(n)) return $('#locErr').textContent='כבר יש מיקום בשם הזה.';
  if(await put('locations',{id:uid('l'),name:n,createdAt:Date.now()})){ $('#locDlg').close(); toast(`המיקום ${n} נוסף`); }
});

/* ---------- confirm ---------- */
function confirmDlg(title,text,ok,withNote){
  return new Promise(res=>{
    const d=$('#cfmDlg'); $('#cfmTitle').textContent=title; $('#cfmText').textContent=text; $('#cfmOk').textContent=ok;
    $('#cfmNoteWrap').hidden=!withNote; $('#cfmNote').value='';
    let done=false, settled=false;
    const f=$('#cfmForm');
    // resolves on the click itself, without waiting for the dialog's "close" event (which a browser may delay)
    const finish=()=>{ if(settled) return; settled=true; f.removeEventListener('submit',sub); res(done?{note:$('#cfmNote').value.trim()}:null); };
    const sub=e=>{e.preventDefault(); done=true; finish(); d.close(); };
    f.addEventListener('submit',sub,{once:true});
    d.addEventListener('close',finish,{once:true});
    d.showModal(); setTimeout(()=>(withNote?$('#cfmNote'):$('#cfmOk')).focus(),30);
  });
}

/* ---------- פקלי סמים: קופסאות ממוספרות (בכספת / חתומה / ריקה) ---------- */
const BOX_DEF_TPL={'קטמין 50':2,'קטמין 500':1,'אקטיק':2,'מידזולם':3,'מורפיום':3};
const BOX_ST={vault:'בכספת',signed:'חתומה',empty:'ריקה'};
const bx={f:'all',q:'',ser:'',loc:'',multi:false,sel:new Set()};
const boxList=()=>Object.values(S.boxes);
const boxSort=a=>a.sort((x,y)=>String(x.series).localeCompare(String(y.series))||(x.n||0)-(y.n||0));
function boxTpl(series){ const t=S.boxtpl[series]||S.boxtpl.SA; return Object.assign({},(t&&t.items)||BOX_DEF_TPL); }
function boxQty(b,name){ return b.status==='empty'?0:(b.contents||[]).filter(c=>c.name===name).reduce((a,c)=>a+(+c.qty||0),0); }
function boxStockOf(name,excl){ return boxList().filter(b=>b.id!==excl).reduce((t,b)=>t+boxQty(b,name),0); }
function boxExp(b){ if(b.status==='empty') return ''; const e=(b.contents||[]).map(c=>c.exp).filter(Boolean).sort(); return e[0]||''; }
function boxDrugs(){ const s=new Set(Object.keys(BOX_DEF_TPL)); Object.values(S.boxtpl).forEach(t=>Object.keys(t.items||{}).forEach(n=>s.add(n))); return [...s]; }
const bxDays=t=>Math.floor((Date.now()-(t||Date.now()))/864e5);
const bxText=o=>Object.entries(o).filter(([,q])=>q>0).map(([d,q])=>`${d} ${q}`).join(', ')||'כלום';
function bxPick(name,qty){ const out=[]; let left=qty;
  Object.values(S.items).filter(i=>i.name===name&&(+i.qty||0)>0&&status(i.exp)!=='expired')
    .sort((a,b)=>(a.exp||'9999').localeCompare(b.exp||'9999')).forEach(i=>{ if(left<=0) return; const q=Math.min(left,+i.qty); out.push({i,q}); left-=q; });
  return {out,short:left}; }
async function bxSave(b,text){ b.history=(b.history||[]).concat({at:Date.now(),text,by:myName||''}).slice(-60); b.updatedAt=Date.now(); return put('boxes',clean(b)); }
const bxCan=()=>canFull('drugkits');

function shellDrugkits(){
  $('#main').innerHTML=`
  <div class="page-head"><div><h1>פקלי סמים</h1><p class="sub">קופסאות סגורות וממוספרות. כל קופסה מלאה בכספת, חתומה אצל רופא, או ריקה.</p></div>
  <div class="head-acts" id="bxActs">
    <button class="btn primary" type="button" data-bx="multi" id="bxMulti">בחירת כמה קופסאות</button>
    <div class="more"><button type="button" class="btn more-btn" aria-haspopup="true" aria-expanded="false">עוד <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="more-pop" role="menu"><button class="btn" type="button" data-bx="fillall">מילוי כל הריקות</button><button class="btn" type="button" data-bx="count">ספירת קופסאות בכספת</button><button class="btn" type="button" data-bx="add">+ הוספת קופסאות</button><button class="btn" type="button" data-bx="tpl">תבנית</button></div></div></div></div>
  <div id="notice"></div>
  <div class="bx-stats" id="bxStats"></div>
  <div id="bxAlerts"></div>
  <section class="panel" aria-labelledby="bxH" style="margin-bottom:1rem">
    <h2 id="bxH">כל הקופסאות</h2>
    <div class="bx-seg" role="group" aria-label="סינון לפי מצב" id="bxSeg"></div>
    <div class="bx-tools">
      <div class="field"><label for="bxQ">חיפוש מספר קופסה או הערה</label><input id="bxQ" type="search" placeholder="למשל SA17" autocomplete="off" value="${esc(bx.q)}"></div>
      <div class="field"><label for="bxSer">סדרה</label><select id="bxSer"></select></div>
      <div class="field"><label for="bxLoc">מיקום</label><select id="bxLoc"></select></div>
    </div>
    <div class="bx-grid" id="bxGrid"></div>
  </section>
  <section class="panel" aria-labelledby="bxUH" style="margin-bottom:1rem">
    <h2 id="bxUH">איפה נמצאים הסמים</h2>
    <div class="tbl-wrap" style="box-shadow:none"><table><thead><tr><th scope="col">סם</th><th scope="col">מלאי חופשי</th><th scope="col">בקופסאות בכספת</th><th scope="col">בקופסאות חתומות</th><th scope="col">סה״כ בקופסאות</th><th scope="col">סה״כ הכל</th></tr></thead><tbody id="bxUnits"></tbody></table></div>
    <p class="hint" style="margin:.6rem 0 0">"סה״כ בקופסאות" מופיע בספר הסמים בעמודה "מלאי בערכות / תרמילים".</p>
  </section>
  <section class="panel" aria-labelledby="bxLH"><h2 id="bxLH">תנועות קופסאות בספר הסמים</h2><ul class="bx-log" id="bxLog"></ul></section>
  <div class="bx-bar" id="bxBar" hidden role="region" aria-label="פעולות על קופסאות שנבחרו">
    <span id="bxBarN"></span>
    <button class="btn sm" type="button" data-bulk="sign">יצאו חתומות</button>
    <button class="btn sm" type="button" data-bulk="sealed">חזרו סגורות</button>
    <button class="btn sm primary" type="button" data-bulk="fill">מילוי</button>
    <button class="btn sm" type="button" data-bulk="loc">העברת מיקום</button>
    <button class="btn sm bx-ghost" type="button" data-bulk="clear">ביטול</button>
  </div>`;
  $('#bxQ').addEventListener('input',e=>{ bx.q=e.target.value; renderBoxes(); });
  $('#bxSer').addEventListener('change',e=>{ bx.ser=e.target.value; renderBoxes(); });
  $('#bxLoc').addEventListener('change',e=>{ bx.loc=e.target.value; renderBoxes(); });
}
function renderBoxes(){
  if(!$('#bxGrid')) return;
  const all=boxList(), c={vault:0,signed:0,empty:0}; all.forEach(b=>c[b.status]=(c[b.status]||0)+1);
  const can=bxCan(); $('#bxActs').hidden=!can;
  if(!can&&bx.multi){ bx.multi=false; bx.sel.clear(); }
  const units=all.reduce((t,b)=>t+(b.status==='empty'?0:(b.contents||[]).reduce((a,x)=>a+(+x.qty||0),0)),0);
  const tile=(f,cls,ic,n,l)=>`<button type="button" class="bx-stat ${cls}" data-bxf="${f}" ${['vault','signed','empty'].includes(f)&&bx.f===f?'aria-pressed="true"':''}><span class="ic" aria-hidden="true">${ICONS[ic]}</span><b>${n}</b><span>${l}</span></button>`;
  $('#bxStats').innerHTML=tile('vault','s-vault','box',c.vault,'בכספת, מלאות')+tile('signed','s-signed','clock',c.signed,'חתומות (יצאו)')+tile('empty','s-empty','x',c.empty,'ריקות')+tile('all','s-all','kit',all.length,'סה״כ קופסאות')+tile('all','s-units','layers',units,'יחידות סם בקופסאות');
  const long=all.filter(b=>b.status==='signed'&&bxDays(b.since)>=14);
  const expd=all.filter(b=>b.status!=='empty'&&status(boxExp(b))!=='ok');
  $('#bxAlerts').innerHTML=(long.length?`<div class="notice warn"><span><strong>${long.length} קופסאות חתומות יותר משבועיים:</strong> ${long.map(b=>`${esc(b.id)}${b.to?' ('+esc(b.to)+')':''}, ${bxDays(b.since)} ימים`).join(' · ')}</span></div>`:'')
    +(expd.length?`<div class="notice bad"><span><strong>${expd.length} קופסאות עם סם שפג תוקפו או פג החודש:</strong> ${expd.map(b=>`${esc(b.id)} (${fmtExp(boxExp(b))})`).join(' · ')}</span></div>`:'')
    +(c.empty?`<div class="notice"><span><strong>${c.empty} קופסאות ריקות</strong> ממתינות למילוי.</span>${can?'<button class="btn sm" type="button" data-bx="fillall">מילוי עכשיו</button>':''}</div>`:'');
  $('#bxSeg').innerHTML=[['all','הכל',all.length],['vault','בכספת',c.vault],['signed','חתומות',c.signed],['empty','ריקות',c.empty]].map(([f,l,n])=>`<button type="button" data-bxf="${f}" aria-pressed="${bx.f===f}">${l}<span class="n">${n}</span></button>`).join('');
  const sers=[...new Set(all.map(b=>b.series))].sort(); $('#bxSer').innerHTML='<option value="">כל הסדרות</option>'+sers.map(s=>`<option ${s===bx.ser?'selected':''}>${esc(s)}</option>`).join('');
  $('#bxLoc').innerHTML='<option value="">כל המיקומים</option>'+allLocs().map(l=>`<option value="${esc(l)}" ${l===bx.loc?'selected':''}>${esc(l)}</option>`).join('');
  const q=bx.q.trim().toLowerCase();
  const list=boxSort(all.filter(b=>(bx.f==='all'||b.status===bx.f)&&(!bx.ser||b.series===bx.ser)&&(!bx.loc||b.loc===bx.loc)&&(!q||b.id.toLowerCase().includes(q)||(b.to||'').toLowerCase().includes(q))));
  $('#bxGrid').innerHTML=list.length?list.map(b=>{ const e=boxExp(b), st=status(e);
    const sub=b.status==='signed'?(b.to?esc(b.to)+' · ':'')+(bxDays(b.since)?bxDays(b.since)+' ימים':'היום'):b.status==='empty'?'ממתינה למילוי':(e?'תוקף קרוב: '+fmtExp(e).slice(3):'תוקף לא נרשם');
    return `<button type="button" class="bx-box ${b.status}${bx.sel.has(b.id)?' sel':''}${b.status!=='empty'&&st!=='ok'?' exp-'+st:''}" data-box="${esc(b.id)}" ${bx.multi?`aria-pressed="${bx.sel.has(b.id)}"`:''}>${bx.multi?'<span class="tick" aria-hidden="true">✓</span>':''}<span class="num">${esc(b.id)}</span><span class="bx-st ${b.status}">${BOX_ST[b.status]}</span><small>${esc(b.loc||'')}<br>${sub}</small></button>`; }).join(''):'<p class="empty">'+(all.length?'אין קופסאות שמתאימות לחיפוש.':'עוד אין קופסאות. לוחצים "הוספת קופסאות" כדי להתחיל.')+'</p>';
  $('#bxUnits').innerHTML=boxDrugs().map(d=>{ let v=0,s=0; all.forEach(b=>{ const q=boxQty(b,d); if(b.status==='vault') v+=q; else if(b.status==='signed') s+=q; }); const f=stockOf(d);
    return `<tr><th scope="row" style="background:none;color:var(--ink);font-weight:600">${esc(d)}</th><td class="num">${f}</td><td class="num">${v}</td><td class="num">${s}</td><td class="num" style="background:var(--accent-soft)">${v+s}</td><td class="num">${f+v+s}</td></tr>`; }).join('');
  const lg=Object.values(S.ledger).filter(l=>String(l.type).startsWith('box-')).sort((a,b)=>b.at-a.at).slice(0,40);
  $('#bxLog').innerHTML=lg.length?lg.map(l=>`<li class="${l.type}"><time>${fmtDT(l.at)}</time>${esc(TYPE_HE[l.type]||l.type)}: ${esc(l.name)} ${l.inQty?'+'+l.inQty:''}${l.outQty?'−'+l.outQty:''}${l.batch?' · אצווה '+esc(l.batch):''}${l.note?' · '+esc(l.note):''}</li>`).join(''):'<li>עוד אין תנועות.</li>';
  $('#bxBar').hidden=!(bx.multi&&bx.sel.size); $('#bxBarN').textContent=`${bx.sel.size} נבחרו`; $('#bxMulti').textContent=bx.multi?'סיום בחירה':'בחירת כמה קופסאות';
}

/* ---------- details ---------- */
function bxOpen(id){
  const b=S.boxes[id]; if(!b) return; const can=bxCan(), t=boxTpl(b.series);
  const comp=b.status==='empty'?Object.keys(t).map(d=>`<div><span>${esc(d)}</span><strong>0 / ${t[d]}</strong></div>`).join('')
    :(b.contents||[]).map(x=>`<div><span>${esc(x.name)} <span class="hint">${x.batch?'אצווה '+esc(x.batch)+' · ':''}${x.exp?'תוקף '+fmtExp(x.exp).slice(3):'תוקף לא נרשם'}</span></span><span>${x.exp&&status(x.exp)!=='ok'?PILL[status(x.exp)]+' ':''}<strong>${x.qty}</strong></span></div>`).join('');
  const acts=!can?'':b.status==='vault'?`<button class="btn" type="button" data-bxa="sign" data-id="${esc(id)}">יצאה חתומה</button><button class="btn" type="button" data-bxa="edit" data-id="${esc(id)}">עריכת מיקום ותוקף</button>`
    :b.status==='signed'?`<button class="btn primary" type="button" data-bxa="sealed" data-id="${esc(id)}">חזרה סגורה</button><button class="btn" type="button" data-bxa="opened" data-id="${esc(id)}">חזרה פתוחה</button><button class="btn" type="button" data-bxa="edit" data-id="${esc(id)}">עריכת מיקום ותוקף</button>`
    :`<button class="btn primary" type="button" data-bxa="fill" data-id="${esc(id)}">מילוי מהמלאי</button><button class="btn" type="button" data-bxa="edit" data-id="${esc(id)}">עריכת מיקום</button>${canDo('edit')?`<button class="btn danger" type="button" data-bxa="del" data-id="${esc(id)}">מחיקת הקופסה</button>`:''}`;
  openGen('קופסה '+b.id,`<p class="sub" style="margin:0"><span class="bx-st ${b.status}">${BOX_ST[b.status]}</span> ${esc(b.loc||'')}${b.status==='signed'?` · יצאה ${b.to?'('+esc(b.to)+') ':''}ב־${fmtDT(b.since)}`:''}</p>
    <div><h3 style="margin:0 0 .4rem;font-size:1rem">תכולה</h3><div class="bx-comp">${comp}</div></div>
    <div><h3 style="margin:0 0 .4rem;font-size:1rem">היסטוריה</h3><ul class="bx-tl">${(b.history||[]).slice().reverse().map(h=>`<li><time>${fmtDT(h.at)}${h.by?' · '+esc(h.by):''}</time>${esc(h.text)}</li>`).join('')}</ul></div>
    ${acts?`<div class="dlg-actions">${acts}</div>`:''}`,'',null);
}

/* ---------- sign out (the signature itself stays on paper) ---------- */
function bxSign(ids){
  openGen(ids.length===1?'הוצאת קופסה '+ids[0]:`הוצאת ${ids.length} קופסאות`,`<p class="sub" style="margin:0">החתימה עצמה נעשית על הנייר. כאן רק מסמנים שהקופסה יצאה.</p>
    <div class="field"><label for="bxTo">ליד מי / מספר טופס (לא חובה)</label><input id="bxTo" autocomplete="off" placeholder="למשל: ד״ר כהן, טופס 1234"></div>`,'יצאה חתומה',async()=>{
    const to=$('#bxTo').value.trim(), t=Date.now();
    for(const id of ids){ const b=Object.assign({},S.boxes[id]); if(b.status!=='vault') continue; b.status='signed'; b.to=to; b.since=t; await bxSave(b,'יצאה חתומה'+(to?' · '+to:'')); }
    log('box-sign',{name:'קופסאות '+ids.join(', ')},ids.length,to); bx.sel.clear(); toast(ids.length===1?`קופסה ${ids[0]} יצאה`:`${ids.length} קופסאות יצאו`); renderBoxes(); return true; });
}
async function bxSealed(ids){
  for(const id of ids){ const b=Object.assign({},S.boxes[id]); if(b.status!=='signed') continue; b.status='vault'; b.to=''; b.since=null; await bxSave(b,'חזרה סגורה לכספת'); }
  bx.sel.clear(); toast(ids.length===1?`קופסה ${ids[0]} חזרה לכספת`:`${ids.length} קופסאות חזרו לכספת`); renderBoxes();
}

/* ---------- returned opened: used leaves, the rest goes back to free stock, box becomes empty ---------- */
function bxOpened(id){
  const b=S.boxes[id], by={}; (b.contents||[]).forEach(x=>{ (by[x.name]=by[x.name]||[]).push(x); });
  const rows=Object.entries(by).map(([d,ls])=>{ const tot=ls.reduce((a,x)=>a+(+x.qty||0),0); const noBatch=ls.some(x=>!x.batch);
    const tgt=noBatch?`<select data-bxt="${esc(d)}" aria-label="לאן מחזירים ${esc(d)}"><option value="">פריט חדש ב${esc(b.loc||'')}</option>${Object.values(S.items).filter(i=>i.name===d).map(i=>`<option value="${esc(i.id)}">${esc(i.loc)} · ${i.batch?'אצווה '+esc(i.batch):'ללא אצווה'} · ${fmtExp(i.exp)}</option>`).join('')}</select>`:`<span class="hint">חוזר לאצווה ${ls.map(x=>esc(x.batch)).join(', ')}</span>`;
    return `<div class="bx-use"><label for="bu-${esc(d)}">${esc(d)} <span class="hint">(בקופסה ${tot})</span></label><input id="bu-${esc(d)}" data-bxu="${esc(d)}" data-max="${tot}" type="number" min="0" max="${tot}" value="0" inputmode="numeric">${tgt}</div>`; }).join('');
  openGen(`קופסה ${id} חזרה פתוחה`,`<p class="sub" style="margin:0">מסמנים כמה נוצל. מה שלא נוצל חוזר למלאי החופשי, והקופסה הופכת לריקה. כך אין אף פעם קופסה חלקית.</p>
    <div class="bx-use hd"><span>סם</span><span>נוצל</span><span>מה שלא נוצל חוזר אל</span></div>${rows}
    <div class="field"><label for="bxNote">הערה (לא חובה)</label><input id="bxNote" autocomplete="off"></div>`,'רישום והפיכה לריקה',async err=>{
    const used={}; let any=false;
    for(const i of document.querySelectorAll('#genBody [data-bxu]')){ const q=parseInt(i.value,10)||0, mx=+i.dataset.max; if(q<0||q>mx){ err(`${i.dataset.bxu}: אפשר בין 0 ל־${mx}.`); return false; } used[i.dataset.bxu]=q; if(q) any=true; }
    if(!any){ err('לא סומן שימוש. אם הקופסה חזרה סגורה, בחרו "חזרה סגורה".'); return false; }
    const note=$('#bxNote').value.trim(), cur=S.boxes[id], tgt={};
    document.querySelectorAll('#genBody [data-bxt]').forEach(s=>tgt[s.dataset.bxt]=s.value);
    // every step is saved in order (box -> ledger, stock -> box -> ledger), so the server records exact balances
    const box=Object.assign({},cur,{contents:(cur.contents||[]).map(x=>Object.assign({},x))});
    const byExp=(a,b)=>(a.exp||'9999').localeCompare(b.exp||'9999');
    // 1) usage: taken from the lines with the earliest expiry, and it leaves the kits stock
    for(const [d,q] of Object.entries(used)){ if(!q) continue; let u=q;
      box.contents.filter(x=>x.name===d).sort(byExp).forEach(x=>{ const take=Math.min(u,+x.qty||0); x.qty=(+x.qty||0)-take; u-=take; });
      box.contents=box.contents.filter(x=>(+x.qty||0)>0);
      if(!(await put('boxes',clean(box)))) return false;
      await ledgerAdd({name:d,type:'box-use',outQty:q,balance:stockOf(d),kitBalance:kitStockOf(d),voucher:'',loc:cur.loc,note:`שימוש מקופסה ${id}${cur.to?' ('+cur.to+')':''}${note?' · '+note:''}`}); }
    // 2) what was not used goes back to the free stock, line by line
    for(const x of box.contents.slice()){ const d=x.name, r=+x.qty||0; if(r<=0) continue;
      const it=tgt[d]?S.items[tgt[d]]:(x.batch?(Object.values(S.items).find(i=>i.name===d&&i.batch===x.batch&&i.loc===cur.loc)||Object.values(S.items).find(i=>i.name===d&&i.batch===x.batch))
        :Object.values(S.items).find(i=>i.name===d&&!i.batch&&(i.exp||'')===(x.exp||'')&&i.loc===cur.loc));
      const o=it?Object.assign({},it,{qty:(+it.qty||0)+r,updatedAt:Date.now()}):{id:uid('i'),name:d,sku:x.sku||skuOf(d),batch:x.batch||'',qty:r,loc:cur.loc||DEFAULT_LOCS[0],exp:x.exp||'',createdAt:Date.now(),updatedAt:Date.now()};
      if(!(await put('items',o))) return false;
      box.contents=box.contents.filter(y=>y!==x);
      if(!(await put('boxes',clean(box)))) return false;
      await ledgerAdd({name:d,sku:o.sku,itemId:o.id,batch:o.batch||'',exp:o.exp||'',loc:o.loc,type:'box-return',inQty:r,balance:stockOf(d),kitBalance:kitStockOf(d),voucher:'',note:`הוחזר מקופסה ${id}`}); }
    const b=Object.assign({},box,{status:'empty',contents:[],to:'',since:null});
    await bxSave(b,`חזרה פתוחה: נוצל ${bxText(used)}. השאר הוחזר למלאי, והקופסה ריקה${note?' · '+note:''}`);
    toast(`השימוש נרשם. קופסה ${id} ריקה וממתינה למילוי`); renderBoxes(); return true; });
}

/* ---------- fill empty boxes from the free stock (earliest expiry first) ---------- */
function bxNeed(ids){ const n={}; ids.forEach(id=>{ const t=boxTpl(S.boxes[id].series); Object.entries(t).forEach(([d,q])=>n[d]=(n[d]||0)+q); }); return n; }
function bxFill(ids){
  ids=ids.filter(id=>S.boxes[id]&&S.boxes[id].status==='empty'); if(!ids.length) return toast('אין קופסאות ריקות למילוי.');
  const need=bxNeed(ids);
  const rows=Object.entries(need).map(([d,q])=>{ const p=bxPick(d,q); return `<tr><td>${esc(d)}</td><td class="num">${q}</td><td>${p.short?`<strong style="color:var(--bad-ink)">חסר במלאי ${p.short}</strong>`:p.out.map(x=>`${esc(x.i.batch||'ללא אצווה')} · ${esc(x.i.loc)} · ${fmtExp(x.i.exp).slice(3)} (${x.q})`).join('<br>')}</td></tr>`; }).join('');
  openGen(ids.length===1?`מילוי קופסה ${ids[0]}`:`מילוי ${ids.length} קופסאות`,`<p class="sub" style="margin:0">כל קופסה מתמלאת לגמרי לפי התבנית. המערכת בוחרת את האצוות עם התוקף הקרוב ביותר (בלי פגי תוקף) ומורידה אותן מהמלאי החופשי.</p>
    <div class="tbl-wrap" style="box-shadow:none"><table><thead><tr><th scope="col">סם</th><th scope="col">נדרש</th><th scope="col">יירד מ</th></tr></thead><tbody>${rows}</tbody></table></div>`,'מילוי והחזרה לכספת',async err=>{
    const nd=bxNeed(ids); const sh=Object.entries(nd).find(([d,q])=>bxPick(d,q).short); if(sh){ err(`אין מספיק ${sh[0]} בתוקף במלאי החופשי. אפשר למלא פחות קופסאות.`); return false; }
    // every step is saved in order (stock -> box -> ledger), so the server records exact balances
    for(const id of ids){ const cur=S.boxes[id], t=boxTpl(cur.series); const box=Object.assign({},cur,{status:'vault',contents:[]});
      for(const [d,q] of Object.entries(t)){ const p=bxPick(d,q);
        for(const x of p.out){ const o=Object.assign({},x.i,{qty:(+x.i.qty||0)-x.q,updatedAt:Date.now()}); if(!(await put('items',o))) return false;
          box.contents=box.contents.concat({name:d,sku:x.i.sku||skuOf(d),qty:x.q,batch:x.i.batch||'',exp:x.i.exp||''});
          if(!(await put('boxes',clean(box)))) return false;
          await ledgerAdd({name:d,sku:o.sku,itemId:o.id,batch:o.batch||'',exp:o.exp||'',loc:o.loc,type:'box-fill',outQty:x.q,balance:stockOf(d),kitBalance:kitStockOf(d),voucher:'',note:`מילוי קופסה ${id}`}); } }
      await bxSave(box,'מולאה מהמלאי החופשי וחזרה לכספת'); }
    bx.sel.clear(); toast(ids.length===1?`קופסה ${ids[0]} מולאה וחזרה לכספת`:`${ids.length} קופסאות מולאו וחזרו לכספת`); renderBoxes(); return true; });
}

/* ---------- edit location + batch/expiry of each drug ---------- */
function bxEdit(id){
  const b=S.boxes[id]; const lines=b.status==='empty'?[]:(b.contents||[]);
  openGen('עריכת קופסה '+id,`<div class="field"><label for="bxEL">מיקום</label><select id="bxEL">${allLocs().map(l=>`<option value="${esc(l)}" ${l===b.loc?'selected':''}>${esc(l)}</option>`).join('')}</select></div>
    ${lines.map((x,k)=>`<fieldset><legend>${esc(x.name)} · ${x.qty} יח׳</legend><div class="two"><div class="field"><label for="bxB${k}">אצווה</label><input id="bxB${k}" value="${esc(x.batch||'')}" list="batchList" autocomplete="off"></div>
      <div class="field"><span style="font-weight:600" id="bxE${k}l">תוקף</span><div class="exp-pick" role="group" aria-labelledby="bxE${k}l" id="bxE${k}"></div></div></div></fieldset>`).join('')}
    ${lines.length?'<p class="hint" style="margin:0">אם רושמים אצווה מוכרת, התוקף שלה ממולא לבד.</p>':''}`,'שמירה',async err=>{
    const o=Object.assign({},S.boxes[id]); o.loc=$('#bxEL').value;
    o.contents=lines.map((x,k)=>Object.assign({},x,{batch:$('#bxB'+k).value.trim(),exp:readExp('bxE'+k)||''}));
    await bxSave(o,'עודכנו מיקום ותוקף'); toast('הקופסה עודכנה'); renderBoxes(); return true; });
  lines.forEach((x,k)=>{ expPicker($('#bxE'+k),x.exp||'','bxE'+k); const inp=$('#bxB'+k); inp.addEventListener('change',()=>{ const kb=findBatch(inp.value); if(kb&&kb.name===x.name) setExp('bxE'+k,kb.exp); }); });
}
function bxMove(ids){
  openGen(`העברת ${ids.length} קופסאות`,`<div class="field"><label for="bxML">מיקום חדש</label><select id="bxML">${allLocs().map(l=>`<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select></div>`,'העברה',async()=>{
    const l=$('#bxML').value; for(const id of ids){ const b=Object.assign({},S.boxes[id]); if(b.loc===l) continue; b.loc=l; await bxSave(b,'הועברה ל'+l); }
    bx.sel.clear(); toast('הקופסאות הועברו'); renderBoxes(); return true; });
}

/* ---------- count boxes in the vaults ---------- */
function bxCount(){
  const v=boxSort(boxList().filter(b=>b.status==='vault'));
  openGen('ספירת קופסאות בכספת',`<p class="sub" style="margin:0">מסמנים כל קופסה שנמצאת פיזית במקומה. בסוף מוצגות הקופסאות שלא נמצאו.</p>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn sm" type="button" id="bxCA">סימון הכל</button><button class="btn sm" type="button" id="bxCN">ניקוי</button></div>
    ${allLocs().filter(l=>v.some(b=>b.loc===l)).map(l=>`<fieldset><legend>${esc(l)}</legend><div class="bx-checks">${v.filter(b=>b.loc===l).map(b=>`<label><input type="checkbox" data-bxc="${esc(b.id)}"> ${esc(b.id)}</label>`).join('')}</div></fieldset>`).join('')||'<p class="empty">אין קופסאות בכספת.</p>'}`,'סיום הספירה',async()=>{
    const all=[...document.querySelectorAll('#genBody [data-bxc]')]; const miss=all.filter(i=>!i.checked).map(i=>i.dataset.bxc);
    await log('box-count',{name:'ספירת קופסאות'},all.length-miss.length,miss.length?'חסרות: '+miss.join(', '):'כל הקופסאות נמצאו');
    toast(miss.length?`חסרות ${miss.length} קופסאות: ${miss.slice(0,8).join(', ')}${miss.length>8?'…':''}`:`כל ${all.length} הקופסאות נמצאו`); return true; });
  $('#bxCA').addEventListener('click',()=>document.querySelectorAll('#genBody [data-bxc]').forEach(i=>i.checked=true));
  $('#bxCN').addEventListener('click',()=>document.querySelectorAll('#genBody [data-bxc]').forEach(i=>i.checked=false));
}

/* ---------- add boxes ---------- */
function bxAdd(){
  const sa=boxList().filter(b=>b.series==='SA').map(b=>b.n||0); const nx=Math.max(0,...sa)+1; const t=boxTpl('SA');
  openGen('הוספת קופסאות',`<div class="bx-three"><div class="field"><label for="bxAS">סדרה</label><input id="bxAS" dir="ltr" value="SA" autocomplete="off"></div>
    <div class="field"><label for="bxAF">ממספר</label><input id="bxAF" type="number" min="1" inputmode="numeric" value="${nx}"></div>
    <div class="field"><label for="bxAT">עד מספר</label><input id="bxAT" type="number" min="1" inputmode="numeric" value="${nx}"></div></div>
    <div class="field"><label for="bxAL">מיקום</label><select id="bxAL">${allLocs().map(l=>`<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select></div>
    <div class="field"><label for="bxAM">במה הקופסאות מתחילות</label><select id="bxAM"><option value="empty">ריקות (ממלאים אחר כך מהמלאי)</option><option value="fill">מלאות: למלא עכשיו מהמלאי החופשי</option><option value="built">מלאות כבר עכשיו (הכנסה ראשונה, בלי להוריד מהמלאי)</option></select></div>
    <div id="bxABuilt" hidden><p class="hint" style="margin:0 0 .4rem">תוקף לכל סם (לא חובה). הוא יירשם בכל הקופסאות האלה, ואפשר לשנות אחר כך לכל קופסה.</p>
      ${Object.keys(t).map((d,k)=>`<div class="field" style="margin-bottom:.5rem"><span style="font-weight:600" id="bxAE${k}l">${esc(d)} · ${t[d]} יח׳</span><div class="exp-pick" role="group" aria-labelledby="bxAE${k}l" id="bxAE${k}"></div></div>`).join('')}</div>
    <p class="hint" id="bxAP" style="margin:0"></p>`,'הוספה',async err=>{
    const s=$('#bxAS').value.trim().toUpperCase(), a=+$('#bxAF').value, z=+$('#bxAT').value, m=$('#bxAM').value, loc=$('#bxAL').value;
    if(!/^[A-Z]{1,6}$/.test(s)){ err('סדרה: אותיות באנגלית בלבד, למשל SA.'); return false; }
    if(!(a>=1&&z>=a)){ err('טווח מספרים לא תקין.'); return false; }
    if(z-a>299){ err('אפשר להוסיף עד 300 קופסאות בפעם אחת.'); return false; }
    const ex=[]; for(let i=a;i<=z;i++) if(S.boxes[s+i]) ex.push(s+i); if(ex.length){ err('כבר קיימות: '+ex.slice(0,6).join(', ')+(ex.length>6?'…':'')); return false; }
    const tt=boxTpl(s); if(!S.boxtpl[s]) await put('boxtpl',{id:s,items:tt,updatedAt:Date.now()});
    if(m==='fill'){ const n=z-a+1; const sh=Object.entries(tt).find(([d,q])=>bxPick(d,q*n).short); if(sh){ err(`אין מספיק ${sh[0]} בתוקף במלאי החופשי (צריך ${sh[1]*n}). אפשר להוסיף אותן ריקות.`); return false; } }
    const exps=Object.keys(tt).map((d,k)=>m==='built'?readExp('bxAE'+k):'');
    for(let i=a;i<=z;i++){ const b={id:s+i,series:s,n:i,loc,status:m==='built'?'vault':'empty',to:'',since:null,createdAt:Date.now(),
        contents:m==='built'?Object.keys(tt).map((d,k)=>({name:d,sku:skuOf(d),qty:tt[d],batch:'',exp:exps[k]||''})):[]};
      if(!(await bxSave(b,m==='built'?'נרשמה במערכת: מלאה בכספת':'נוספה ריקה'))) return false; }
    const ids=[]; for(let i=a;i<=z;i++) ids.push(s+i);
    if(m==='built'){ const n=ids.length; for(const [d,q] of Object.entries(tt)) await ledgerAdd({name:d,type:'box-open',balance:stockOf(d),kitBalance:kitStockOf(d),voucher:'',loc,note:`רישום ראשוני של ${n} קופסאות ${s}${a}–${s}${z} שכבר מלאות (${q*n} יח׳, בלי הורדה מהמלאי)`}); }
    toast(`נוספו ${ids.length} קופסאות`); renderBoxes(); if(m==='fill') setTimeout(()=>bxFill(ids),250); return true; });
  const upd=()=>{ const m=$('#bxAM').value, n=(+$('#bxAT').value)-(+$('#bxAF').value)+1; $('#bxABuilt').hidden=m!=='built';
    $('#bxAP').textContent=n>0?`ייווספו ${n} קופסאות. `+({empty:'הן יתחילו ריקות.',built:'הן יירשמו כמלאות, בלי להוריד מהמלאי.',fill:'אחרי ההוספה ייפתח חלון המילוי מהמלאי.'})[m]:''; };
  Object.keys(t).forEach((d,k)=>expPicker($('#bxAE'+k),'','bxAE'+k));
  ['bxAM','bxAF','bxAT'].forEach(i=>{ $('#'+i).addEventListener('input',upd); $('#'+i).addEventListener('change',upd); }); upd();
}

/* ---------- template per series (applies to boxes filled from now on) ---------- */
function bxTplEdit(){
  const sers=[...new Set(['SA'].concat(boxList().map(b=>b.series),Object.keys(S.boxtpl)))].sort();
  const names=[...new Set(boxDrugs().concat(DRUGS.map(d=>d[0])))];
  const rows=s=>{ const t=boxTpl(s); return names.map((d,k)=>`<div class="bx-tpl"><label for="bxTq${k}">${esc(d)}</label><input id="bxTq${k}" data-bxq="${esc(d)}" type="number" min="0" inputmode="numeric" value="${t[d]||0}"></div>`).join(''); };
  openGen('תבנית קופסה',`<p class="sub" style="margin:0">ממה מורכבת קופסה מלאה. שינוי חל על קופסאות שימולאו מעכשיו והלאה. קופסאות מלאות לא משתנות.</p>
    <div class="field"><label for="bxTS">סדרה</label><select id="bxTS">${sers.map(s=>`<option>${esc(s)}</option>`).join('')}</select></div><div id="bxTR" style="display:grid;gap:.4rem">${rows(sers[0])}</div>`,'שמירה',async err=>{
    const s=$('#bxTS').value, items={}; document.querySelectorAll('#genBody [data-bxq]').forEach(i=>{ const q=parseInt(i.value,10)||0; if(q>0) items[i.dataset.bxq]=q; });
    if(!Object.keys(items).length){ err('קופסה צריכה לפחות סם אחד.'); return false; }
    if(await put('boxtpl',{id:s,items,updatedAt:Date.now()})){ toast(`תבנית ${s} נשמרה`); renderBoxes(); return true; } return false; });
  $('#bxTS').addEventListener('change',e=>{ $('#bxTR').innerHTML=rows(e.target.value); });
}
async function bxDelete(id){
  const b=S.boxes[id]; if(!b||b.status!=='empty') return toast('אפשר למחוק רק קופסה ריקה.');
  if(await confirmDlg('מחיקת קופסה',`למחוק את הקופסה ${id}? אפשר למחוק רק קופסה ריקה, ואי אפשר לבטל.`,'מחיקה')){ if(await del('boxes',id)){ log('box-delete',{name:'קופסה '+id},0,''); toast('הקופסה נמחקה'); renderBoxes(); } }
}

/* ---------- clicks ---------- */
document.addEventListener('click',e=>{
  if(route!=='drugkits') return;
  const f=e.target.closest('[data-bxf]'); if(f){ bx.f=(f.classList.contains('bx-stat')&&bx.f===f.dataset.bxf)?'all':f.dataset.bxf; renderBoxes(); return; }
  const card=e.target.closest('[data-box]'); if(card){ const id=card.dataset.box; if(bx.multi){ bx.sel.has(id)?bx.sel.delete(id):bx.sel.add(id); renderBoxes(); } else bxOpen(id); return; }
  const t=e.target.closest('[data-bx],[data-bxa],[data-bulk]'); if(!t) return;
  if(!bxCan()) return toast('יש לך הרשאת צפייה בלבד במסך הזה.');
  if(t.dataset.bx){ ({multi:()=>{ bx.multi=!bx.multi; bx.sel.clear(); renderBoxes(); },fillall:()=>bxFill(boxSort(boxList().filter(b=>b.status==='empty')).map(b=>b.id)),count:bxCount,add:bxAdd,tpl:bxTplEdit})[t.dataset.bx](); return; }
  if(t.dataset.bxa){ const id=t.dataset.id; $('#genDlg').close(); ({sign:()=>bxSign([id]),sealed:()=>bxSealed([id]),opened:()=>bxOpened(id),fill:()=>bxFill([id]),edit:()=>bxEdit(id),del:()=>bxDelete(id)})[t.dataset.bxa](); return; }
  const ids=[...bx.sel], pick=st=>ids.filter(id=>S.boxes[id]&&S.boxes[id].status===st);
  ({sign:()=>{ const v=pick('vault'); v.length?bxSign(v):toast('אף קופסה שנבחרה לא נמצאת בכספת.'); },sealed:()=>{ const v=pick('signed'); v.length?bxSealed(v):toast('אף קופסה שנבחרה לא חתומה.'); },
    fill:()=>{ const v=pick('empty'); v.length?bxFill(v):toast('אף קופסה שנבחרה לא ריקה.'); },loc:()=>bxMove(ids),clear:()=>{ bx.sel.clear(); renderBoxes(); }})[t.dataset.bulk]();
});

/* ---------- השוואה לסאפ ----------
   סאפ מוריד שימוש רק אחרי פתק הצריכה החודשי. לכן משווים את מלאי סאפ (שמוזן ידנית: סם, אצווה, תוקף, כמות) מול:
   המלאי אצלנו (חופשי + ערכות + פקלים) + הצריכה שעוד לא ירדה בסאפ (מאז תאריך החיתוך). שווה או בפלוס = תקין, חוסר = אדום. */
const SAP_PENDING={sign:1,'kit-sign':1,'box-use':1,out:1};
let sapPrefill=null, sapRecTimer=null, sapRecQueue=[];
const sapSnaps=()=>Object.values(S.sap).sort((a,b)=>(a.at||0)-(b.at||0));
const sapLast=()=>{ const s=sapSnaps(); return s[s.length-1]||null; };
const sapMeta=()=>S.sapmeta.main||{};
const ourTotal=name=>STOCK_POOLS.reduce((t,p)=>t+p.qty(name),0);
function sapPending(name){ const c=sapMeta().cutoff||0; let t=0;
  Object.values(S.ledger).forEach(l=>{ if(l.name!==name||(l.at||0)<=c) return; if(SAP_PENDING[l.type]) t+=(+l.outQty||0); else if(l.type==='cancel') t-=(+l.inQty||0); });
  return Math.max(0,t); }
function sapRows(){ const last=sapLast(); if(!last) return []; const names=[];
  (last.lines||[]).forEach(x=>{ if(x.name&&!names.includes(x.name)) names.push(x.name); });
  return names.map(n=>{ const sap=(last.lines||[]).filter(x=>x.name===n).reduce((a,x)=>a+(+x.qty||0),0), ours=ourTotal(n), pend=sapPending(n);
    return {name:n,sku:skuOf(n),sap,ours,pend,diff:ours+pend-sap}; }); }
function sapReceiptsSince(){ const last=sapLast(); if(!last) return 0; return Object.values(S.ledger).filter(l=>l.type==='receive'&&(l.at||0)>(last.at||0)).reduce((t,l)=>t+(+l.inQty||0),0); }
function ourBatches(){ const m=new Map(); const add=(o,q)=>{ if(!o.name||!q) return; const k=o.name+'|'+(o.batch||''); const v=m.get(k)||{name:o.name,batch:o.batch||'',exp:o.exp||'',qty:0}; v.qty+=q; if(!v.exp&&o.exp) v.exp=o.exp; m.set(k,v); };
  Object.values(S.items).forEach(i=>add(i,+i.qty||0));
  Object.values(S.kits).filter(k=>k.status!=='issued').forEach(k=>(k.contents||[]).forEach(c=>add(c,+c.qty||0)));
  Object.values(S.boxes).filter(b=>b.status!=='empty').forEach(b=>(b.contents||[]).forEach(c=>add(c,+c.qty||0)));
  return m; }
const sapCan=()=>canFull('sap');
const expShort=e=>e?fmtExp(e).slice(3):'ללא';

function shellSap(){
  $('#main').innerHTML=`
  <div class="page-head"><div><h1>השוואה לסאפ</h1><p class="sub">מלאי סאפ מול המלאי אצלנו (חופשי + ערכות + פקלים) ועוד הצריכה שעוד לא ירדה בסאפ. שווה או בפלוס זה תקין, חוסר מסומן באדום.</p></div>
  <div class="sap-acts" id="sapActs" style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn primary" type="button" data-sap="update">עדכון מלאי סאפ</button><button class="btn" type="button" data-sap="cutoff">הצריכה הורדה בסאפ</button></div></div>
  <div id="notice"></div><div id="sapAlerts"></div>
  <section class="panel" aria-labelledby="sapH1" style="margin-bottom:1rem"><h2 id="sapH1">השוואה לפי סם</h2><div id="sapMain" style="margin-top:.8rem"></div></section>
  <section class="panel" aria-labelledby="sapH2" style="margin-bottom:1rem"><h2 id="sapH2">צריכה שעוד לא ירדה בסאפ, לפי יום</h2><p class="sub" style="margin:.2rem 0 .8rem">עוזר למלא את פתק הצריכה החודשי. כולל החתמות, החתמות מערכות, שימוש מפקלים והורדות ידניות, פחות זיכויים.</p><div id="sapDays"></div></section>
  <section class="panel" aria-labelledby="sapH3" style="margin-bottom:1rem"><h2 id="sapH3">השוואה לפי אצווה ותוקף</h2><p class="sub" style="margin:.2rem 0 .8rem">לידיעה בלבד: הבדלים באצוות או בתוקף בין סאפ לבין המלאי אצלנו.</p><div id="sapBatches"></div></section>
  <section class="panel" aria-labelledby="sapH4"><h2 id="sapH4">עדכוני סאפ קודמים</h2><div id="sapHist" style="margin-top:.8rem"></div></section>`;
}
function renderSap(){
  if(!$('#sapMain')) return;
  const can=sapCan(); $('#sapActs').hidden=!can;
  const last=sapLast(), meta=sapMeta(), rows=sapRows(), rec=sapReceiptsSince(), short=rows.filter(r=>r.diff<0);
  $('#sapAlerts').innerHTML=!last?`<div class="notice"><span>עוד לא הוזן מלאי סאפ. ${can?'לוחצים "עדכון מלאי סאפ" ומקלידים את מה שמופיע בסאפ: סם, אצווה, תוקף וכמות.':''}</span></div>`
    :(short.length?`<div class="notice bad"><span><strong>חוסר מול סאפ:</strong> ${short.map(r=>`${esc(r.name)} ${r.diff}`).join(', ')}</span></div>`:`<div class="notice ok-n"><span><strong>הכול תקין:</strong> המלאי אצלנו שווה לסאפ או גדול ממנו בכל הסמים.</span></div>`)
     +(rec?`<div class="notice warn"><span><strong>התקבלו ${rec} יח׳ מאז עדכון סאפ האחרון.</strong> אחרי שהמשלוח נקלט בסאפ, עדכנו כאן את מלאי סאפ.</span>${can?'<button class="btn sm" type="button" data-sap="update">עדכון עכשיו</button>':''}</div>`:'')
     +`<p class="hint" style="margin:.2rem 0 1rem">עדכון סאפ אחרון: ${fmtDT(last.at)}${last.byName?' · '+esc(last.byName):''} · הצריכה הורדה בסאפ עד: ${meta.cutoffDate?esc(meta.cutoffDate.split('-').reverse().join('/')):'לא סומן (נספרת כל הצריכה)'}</p>`;
  $('#sapMain').innerHTML=rows.length?`<div class="tbl-wrap" style="box-shadow:none"><table><thead><tr><th scope="col">סם</th><th scope="col">מק״ט</th><th scope="col">בסאפ</th><th scope="col">אצלנו</th><th scope="col">צריכה שעוד לא ירדה בסאפ</th><th scope="col">אצלנו + צריכה</th><th scope="col">פער</th><th scope="col">מצב</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.diff<0?'expired':''}"><th scope="row" style="background:none;color:inherit">${esc(r.name)}</th><td class="code">${esc(r.sku)}</td><td class="num">${r.sap}</td><td class="num">${r.ours}</td><td class="num">${r.pend}</td><td class="num">${r.ours+r.pend}</td><td class="num">${r.diff>0?'+':''}${r.diff}</td><td>${r.diff<0?'<span class="pill expired">✕ חוסר</span>':'<span class="pill ok">✓ תקין</span>'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="empty">אין עדיין נתונים להשוואה.</p>';
  // pending consumption by day (since the cutoff)
  const c=meta.cutoff||0, by=new Map(), names=new Set();
  Object.values(S.ledger).filter(l=>(l.at||0)>c&&(SAP_PENDING[l.type]||l.type==='cancel')).forEach(l=>{ const d=new Date(l.at), k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const o=by.get(k)||{}; o[l.name]=(o[l.name]||0)+(l.type==='cancel'?-(+l.inQty||0):(+l.outQty||0)); by.set(k,o); names.add(l.name); });
  const days=[...by.keys()].sort(), cols=[...names].sort((a,b)=>a.localeCompare(b,'he'));
  $('#sapDays').innerHTML=days.length?`<div class="tbl-wrap" style="box-shadow:none"><table><thead><tr><th scope="col">תאריך</th>${cols.map(n=>`<th scope="col">${esc(n)}</th>`).join('')}</tr></thead><tbody>${days.map(d=>`<tr><td>${d.split('-').reverse().join('/')}</td>${cols.map(n=>`<td class="num">${by.get(d)[n]||''}</td>`).join('')}</tr>`).join('')}<tr><th scope="row">סה״כ</th>${cols.map(n=>`<td class="num"><strong>${days.reduce((t,d)=>t+(by.get(d)[n]||0),0)}</strong></td>`).join('')}</tr></tbody></table></div>`:'<p class="empty">אין צריכה שממתינה להורדה בסאפ.</p>';
  // batch comparison (information only)
  if(last){ const ours=ourBatches(), seen=new Set(), out=[];
    (last.lines||[]).forEach(x=>{ const k=x.name+'|'+(x.batch||''); seen.add(k); const o=ours.get(k);
      const flag=!o?'לא נמצאה אצלנו':(x.exp&&o.exp&&x.exp.slice(0,7)!==o.exp.slice(0,7))?'תוקף שונה':'';
      out.push({name:x.name,batch:x.batch||'',sapQ:+x.qty||0,sapE:x.exp,ourQ:o?o.qty:0,ourE:o?o.exp:'',flag}); });
    ours.forEach((o,k)=>{ if(!seen.has(k)&&rows.some(r=>r.name===o.name)) out.push({name:o.name,batch:o.batch,sapQ:0,sapE:'',ourQ:o.qty,ourE:o.exp,flag:'לא מופיעה בסאפ'}); });
    out.sort((a,b)=>a.name.localeCompare(b.name,'he')||a.batch.localeCompare(b.batch));
    $('#sapBatches').innerHTML=`<div class="tbl-wrap" style="box-shadow:none"><table><thead><tr><th scope="col">סם</th><th scope="col">אצווה</th><th scope="col">בסאפ</th><th scope="col">תוקף בסאפ</th><th scope="col">אצלנו</th><th scope="col">תוקף אצלנו</th><th scope="col">הערה</th></tr></thead><tbody>${out.map(r=>`<tr class="${r.flag?'soon':''}"><td>${esc(r.name)}</td><td class="code">${esc(r.batch||'ללא')}</td><td class="num">${r.sapQ}</td><td>${expShort(r.sapE)}</td><td class="num">${r.ourQ}</td><td>${expShort(r.ourE)}</td><td>${esc(r.flag)}</td></tr>`).join('')}</tbody></table></div>`;
  } else $('#sapBatches').innerHTML='<p class="empty">אין עדיין נתוני סאפ.</p>';
  const hs=sapSnaps().slice(-12).reverse();
  $('#sapHist').innerHTML=hs.length?`<ul class="list">${hs.map(s=>`<li><div class="what"><strong>${fmtDT(s.at)}${s.byName?' · '+esc(s.byName):''}</strong><small>${esc(Object.entries((s.lines||[]).reduce((m,x)=>{ m[x.name]=(m[x.name]||0)+(+x.qty||0); return m; },{})).map(([n,q])=>n+' '+q).join(', '))}${s.note?' · '+esc(s.note):''}</small></div></li>`).join('')}</ul>`:'<p class="empty">אין עדכונים.</p>';
}

/* ---------- update SAP stock (drug, batch, expiry, quantity) ---------- */
function sapUpdate(prefill){
  const last=sapLast(); let lines=(last?last.lines:[]).map(x=>Object.assign({},x));
  if(!lines.length) lines=DRUGS.slice(0,5).map(d=>({name:d[0],batch:'',exp:'',qty:''}));
  (prefill||[]).forEach(p=>{ const ex=lines.find(x=>x.name===p.name&&(x.batch||'')===(p.batch||'')); if(ex) ex.qty=(+ex.qty||0)+p.qty; else lines.push({name:p.name,batch:p.batch||'',exp:p.exp||'',qty:p.qty}); });
  const names=[...new Set(DRUGS.map(d=>d[0]).concat(lines.map(x=>x.name)))];
  const rowHtml=(x,k)=>`<div class="sap-line" data-k="${k}"><select data-f="name" aria-label="סם">${names.map(n=>`<option ${n===x.name?'selected':''}>${esc(n)}</option>`).join('')}</select>
    <input data-f="batch" value="${esc(x.batch||'')}" list="batchList" placeholder="אצווה" aria-label="אצווה" autocomplete="off" dir="ltr">
    <div class="exp-pick" id="sapE${k}" role="group" aria-label="תוקף"></div>
    <input data-f="qty" type="number" min="0" step="1" inputmode="numeric" value="${x.qty===''?'':esc(x.qty)}" placeholder="כמות" aria-label="כמות">
    <button type="button" class="btn sm" data-sapdel="${k}" aria-label="מחיקת השורה">✕</button></div>`;
  openGen('עדכון מלאי סאפ',`<p class="sub" style="margin:0">מקלידים את מה שמופיע עכשיו בסאפ: לכל סם, כל אצווה עם התוקף והכמות. ${prefill&&prefill.length?'<strong>הוספתי את מה שהתקבל במשלוח לשורות המתאימות. בדקו מול סאפ ותקנו אם צריך.</strong>':'השורות ממולאות מהעדכון הקודם.'}</p>
    <div class="sap-line hd" aria-hidden="true"><span>סם</span><span>אצווה</span><span>תוקף</span><span>כמות</span><span></span></div>
    <div id="sapLines" style="display:grid;gap:.5rem">${lines.map(rowHtml).join('')}</div>
    <button type="button" class="btn sm" id="sapAdd">+ שורה</button>
    <div class="field"><label for="sapNote">הערה (לא חובה)</label><input id="sapNote" autocomplete="off" placeholder="למשל: אחרי משלוח מס׳ 1234"></div>`,'שמירת מלאי סאפ',async err=>{
    const out=[];
    for(const r of document.querySelectorAll('#sapLines .sap-line')){ const k=r.dataset.k; const name=r.querySelector('[data-f=name]').value, batch=r.querySelector('[data-f=batch]').value.trim(), qv=r.querySelector('[data-f=qty]').value;
      if(qv==='') continue; const q=+qv; if(!Number.isInteger(q)||q<0){ err(`כמות לא תקינה עבור ${name}.`); return false; }
      out.push({name,sku:skuOf(name),batch,exp:readExp('sapE'+k)||'',qty:q}); }
    if(!out.length){ err('יש להזין לפחות שורה אחת עם כמות.'); return false; }
    if(await put('sap',{id:uid('s'),at:Date.now(),byName:myName||'',lines:out,note:$('#sapNote').value.trim()})){ toast('מלאי סאפ עודכן'); if(route!=='sap') location.hash='sap'; else renderSap(); return true; }
    return false; });
  lines.forEach((x,k)=>expPicker($('#sapE'+k),x.exp||'','sapE'+k));
  let nk=lines.length;
  $('#sapAdd').addEventListener('click',()=>{ $('#sapLines').insertAdjacentHTML('beforeend',rowHtml({name:DRUGS[0][0],batch:'',exp:'',qty:''},nk)); expPicker($('#sapE'+nk),'','sapE'+nk); nk++; });
  $('#sapLines').addEventListener('click',e=>{ const b=e.target.closest('[data-sapdel]'); if(b) b.closest('.sap-line').remove(); });
  $('#sapLines').addEventListener('change',e=>{ const inp=e.target.closest('[data-f=batch]'); if(!inp) return; const kb=findBatch(inp.value), row=inp.closest('.sap-line'); if(kb){ row.querySelector('[data-f=name]').value=kb.name; setExp('sapE'+row.dataset.k,kb.exp); } });
}

/* ---------- consumption was deducted in SAP up to a date ---------- */
function sapCutoff(){
  const n=new Date(), endPrev=new Date(n.getFullYear(),n.getMonth(),0), def=`${endPrev.getFullYear()}-${String(endPrev.getMonth()+1).padStart(2,'0')}-${String(endPrev.getDate()).padStart(2,'0')}`;
  openGen('הצריכה הורדה בסאפ',`<p class="sub" style="margin:0">אחרי שפתק הצריכה החודשי אושר והצריכה הורדה בסאפ, מסמנים עד איזה תאריך היא הורדה. מאותו רגע התוכנה מחשבת "צריכה שעוד לא ירדה בסאפ" רק מהיום שאחרי.</p>
    <div class="field"><label for="sapCD">הצריכה הורדה עד (כולל)</label><input id="sapCD" type="date" value="${def}"></div>
    <div class="field"><label for="sapCN">הערה (לא חובה)</label><input id="sapCN" autocomplete="off" placeholder="למשל: פתק צריכה אוקטובר"></div>
    <p class="hint" style="margin:0">אחרי השמירה כדאי לעדכן גם את מלאי סאפ, כי הוא ירד.</p>`,'שמירה',async err=>{
    const v=$('#sapCD').value; if(!v){ err('יש לבחור תאריך.'); return false; }
    const [y,m,d]=v.split('-').map(Number), cut=new Date(y,m-1,d,23,59,59,999).getTime();
    if(cut>Date.now()+864e5){ err('אי אפשר לבחור תאריך עתידי.'); return false; }
    const cur=sapMeta(); const hist=(cur.history||[]).concat({cutoffDate:v,at:Date.now(),byName:myName||'',note:$('#sapCN').value.trim()}).slice(-60);
    if(await put('sapmeta',{id:'main',cutoff:cut,cutoffDate:v,updatedAt:Date.now(),history:hist})){ toast('נשמר. עכשיו כדאי לעדכן את מלאי סאפ.'); renderSap(); setTimeout(()=>sapUpdate(),300); return true; }
    return false; });
}

/* ---------- after every receipt: offer to update SAP ---------- */
function sapAfterReceive(e){
  if(mode!=='db'||!sapCan()||!e||!e.name) return;
  sapRecQueue.push({name:e.name,batch:e.batch||'',exp:e.exp||'',qty:+e.inQty||0}); sapRecSchedule();
}
function sapRecSchedule(){
  clearTimeout(sapRecTimer);
  sapRecTimer=setTimeout(async()=>{
    if(!sapRecQueue.length) return;
    if([...document.querySelectorAll('dialog')].some(d=>d.open)) return sapRecSchedule(); // wait until the receipt dialogs are closed
    const items=sapRecQueue.splice(0);
    const r=await confirmDlg('התקבל משלוח',`נקלטו במלאי: ${items.map(x=>x.name+' '+x.qty).join(', ')}. אחרי שהמשלוח נקלט גם בסאפ, כדאי לעדכן כאן את מלאי סאפ. לעדכן עכשיו?`,'עדכון מלאי סאפ');
    if(r) sapUpdate(items); },800);
}

document.addEventListener('click',e=>{
  const b=e.target.closest('[data-sap]'); if(!b) return;
  if(!sapCan()) return toast('יש לך הרשאת צפייה בלבד במסך הזה.');
  if(b.dataset.sap==='update') sapUpdate(); else if(b.dataset.sap==='cutoff') sapCutoff();
});


/* ---------- grouped navigation + "more" menus (apple-design: popovers grow from their trigger, close on outside tap / Esc) ---------- */
function navGroups(){
  document.querySelectorAll('nav.tabs .ngrp').forEach(g=>{ const kids=[...g.querySelectorAll('a[data-route]')];
    g.hidden=kids.every(a=>a.hidden); const cur=kids.find(a=>a.getAttribute('aria-current')==='page');
    // on a phone the short group name is kept (the group is highlighted instead), so the menu fits on one line
    const narrow=matchMedia('(max-width:759px)').matches;
    g.classList.toggle('on',!!cur); g.querySelector('.ngrp-lbl').textContent=cur&&!narrow?(cur.dataset.label||cur.textContent.trim()):g.dataset.label; });
}
addEventListener('resize',()=>navGroups());
function closePops(except){ document.querySelectorAll('.ngrp.open,.more.open,.acct.open').forEach(x=>{ if(x===except) return; x.classList.remove('open'); const b=x.querySelector('[aria-expanded]'); if(b) b.setAttribute('aria-expanded','false'); }); }
document.addEventListener('click',e=>{
  const t=e.target.closest('.ngrp-btn,.more-btn');
  if(t){ const box=t.parentElement, open=!box.classList.contains('open'); closePops(box); box.classList.toggle('open',open); t.setAttribute('aria-expanded',String(open));
    if(open){ const first=box.querySelector('.ngrp-pop a:not([hidden]),.more-pop button:not([hidden])'); if(first&&e.detail===0) first.focus(); } return; }
  if(e.target.closest('.ngrp-pop a,.more-pop button')){ setTimeout(()=>closePops(),0); return; }
  if(!e.target.closest('.ngrp,.more,.acct')) closePops();
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ const open=document.querySelector('.ngrp.open,.more.open'); if(open){ closePops(); const b=open.querySelector('[aria-expanded]'); if(b) b.focus(); } } });
new MutationObserver(navGroups).observe(document.querySelector('nav.tabs'),{subtree:true,attributes:true,attributeFilter:['hidden']});
/* ---------- איתור אצווה (ריקול): איפה האצווה נמצאת עכשיו, לאן יצאה, ואילו פתקים קשורים אליה ---------- */
const TR_TYPES={receive:'קבלת מלאי',out:'הורדה',sign:'החתמה','kit-sign':'החתמה מערכה',cancel:'זיכוי פתק',count:'ספירה',adjust:'התאמה לספירה',kit:'ערכות','box-fill':'מילוי פקל','box-return':'החזרה מפקל','box-use':'שימוש מפקל'};
const trNorm=s=>String(s||'').trim().toLowerCase();
function batchTrace(batch){
  const b=trNorm(batch); const eq=x=>trNorm(x)===b;
  const here=[];
  Object.values(S.items).filter(i=>eq(i.batch)&&(+i.qty||0)>0).forEach(i=>here.push({where:'מלאי חופשי',detail:i.loc,name:i.name,exp:i.exp,qty:+i.qty||0}));
  Object.values(S.kits).forEach(k=>(k.contents||[]).filter(c=>eq(c.batch)&&(+c.qty||0)>0).forEach(c=>here.push({where:k.status==='issued'?'ערכה שהוצאה':'ערכה',detail:`${k.name}${k.serial?' ('+k.serial+')':''} · ${k.loc||''}`,name:c.name,exp:c.exp,qty:+c.qty||0})));
  Object.values(S.boxes).filter(x=>x.status!=='empty').forEach(x=>(x.contents||[]).filter(c=>eq(c.batch)&&(+c.qty||0)>0).forEach(c=>here.push({where:x.status==='signed'?'פקל חתום (אצל רופא)':'פקל בכספת',detail:`${x.id} · ${x.loc||''}${x.status==='signed'&&x.to?' · '+x.to:''}`,name:c.name,exp:c.exp,qty:+c.qty||0})));
  const moves=Object.values(S.ledger).filter(l=>eq(l.batch)).sort((a,b)=>a.at-b.at);
  const filled=new Map();
  moves.filter(l=>l.type==='box-fill').forEach(l=>{ const m=/קופסה (\S+)/.exec(l.note||''); if(m) filled.set(m[1],(filled.get(m[1])||0)+(+l.outQty||0)); });
  const notes=[]; const all=(window.SG&&window.SG.notes)?window.SG.notes():[];
  moves.filter(l=>(l.type==='sign'||l.type==='kit-sign')&&l.noteTs).forEach(l=>{ const n=all.find(x=>x.ts===l.noteTs); notes.push({at:l.at,qty:+l.outQty||0,name:l.name,n}); });
  const sap=(typeof sapLast==='function'&&sapLast())?(sapLast().lines||[]).filter(x=>eq(x.batch)):[];
  const info=[...here,...moves].find(x=>x.name)||{}; const exp=(here.find(x=>x.exp)||moves.find(x=>x.exp)||{}).exp||'';
  return {batch:String(batch).trim(),drug:info.name||'',exp,here,moves,filled,notes,sap,total:here.reduce((t,x)=>t+x.qty,0),
    out:moves.reduce((t,l)=>t+((l.type==='sign'||l.type==='kit-sign'||l.type==='out')?(+l.outQty||0):0),0)};
}
function traceHtml(t,forPrint){
  const tbl=(head,rows,empty)=>rows.length?`<div class="tbl-wrap" style="box-shadow:none"><table><thead><tr>${head.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:`<p class="empty">${empty}</p>`;
  return `<div class="trace">
    <p class="sub" style="margin:0">${t.drug?`<strong>${esc(t.drug)}</strong> · `:''}אצווה <strong dir="ltr">${esc(t.batch)}</strong>${t.exp?' · תוקף '+fmtExp(t.exp).slice(3):''} · הופק ${fmtDT(Date.now())}</p>
    <div class="trace-kpis"><div><b>${t.total}</b>נמצאות אצלנו עכשיו</div><div><b>${t.here.length}</b>מקומות</div><div><b>${t.out}</b>יצאו בהחתמות ובהורדות</div><div><b>${t.notes.length}</b>פתקי החתמה קשורים</div></div>
    <h3>איפה האצווה נמצאת עכשיו</h3>
    ${tbl(['מקום','פרטים','סם','תוקף','כמות'],t.here.map(x=>`<tr><td><strong>${esc(x.where)}</strong></td><td>${esc(x.detail)}</td><td>${esc(x.name)}</td><td>${fmtExp(x.exp).slice(3)}</td><td class="num">${x.qty}</td></tr>`),'האצווה לא נמצאת עכשיו באף מקום אצלנו.')}
    ${t.filled.size?`<h3>פקלים שמולאו מהאצווה</h3><p class="sub" style="margin:0 0 .4rem">כולל פקלים שכבר נוצלו או רוקנו. בשימוש מפקל לא נרשמת אצווה, ולכן כדאי לבדוק את הפקלים האלה.</p>${tbl(['פקל','כמה מולאו מהאצווה','מצב היום'],[...t.filled].map(([id,q])=>{ const x=S.boxes[id]; return `<tr><td dir="ltr" style="text-align:end">${esc(id)}</td><td class="num">${q}</td><td>${x?esc(BOX_ST[x.status]||x.status)+(x.status==='signed'&&x.to?' · '+esc(x.to):''):'נמחק'}</td></tr>`; }),'')}`:''}
    <h3>פתקי החתמה שבהם נעשה שימוש באצווה</h3>
    ${tbl(['תאריך','סם','כמות','שם בפתק','מזהה','סיבה'],t.notes.map(x=>`<tr><td>${fmtDT(x.at)}</td><td>${esc(x.name)}</td><td class="num">${x.qty}</td><td>${x.n?esc(x.n.name||''):'<span class="hint">אין גישה לפתק</span>'}</td><td>${x.n?esc((x.n.idType||'')+' '+(x.n.idNum||'')):''}</td><td>${x.n?esc(x.n.reason||''):''}</td></tr>`),'אין פתקי החתמה שקשורים לאצווה.')}
    <h3>כל התנועות של האצווה בספר הסמים</h3>
    ${tbl(['תאריך','פעולה','נכנס','יצא','מיקום','הערה','משתמש'],t.moves.map(l=>`<tr><td>${fmtDT(l.at)}</td><td>${esc(TR_TYPES[l.type]||TYPE_HE[l.type]||l.type)}</td><td class="num">${l.inQty||''}</td><td class="num">${l.outQty||''}</td><td>${esc(l.loc||'')}</td><td>${esc(l.note||'')}</td><td>${esc(l.byUser||l.byName||'')}</td></tr>`),'אין תנועות רשומות לאצווה.')}
    ${t.sap.length?`<h3>בסאפ</h3>${tbl(['סם','תוקף בסאפ','כמות בסאפ'],t.sap.map(x=>`<tr><td>${esc(x.name)}</td><td>${fmtExp(x.exp).slice(3)}</td><td class="num">${x.qty}</td></tr>`),'')}`:''}
    ${forPrint?'<div class="trace-sign"><div>שם וחתימת האחראי</div><div>תאריך</div></div>':''}
  </div>`;
}
function openTrace(pre){
  const known=[...knownBatches().values()].sort((a,b)=>a.batch.localeCompare(b.batch));
  openGen('איתור אצווה (ריקול)',`<p class="sub" style="margin:0">מקלידים מספר אצווה ומקבלים: איפה היא נמצאת עכשיו (מלאי, ערכות, פקלים), לאילו פקלים היא מולאה, באילו פתקי החתמה השתמשו בה, וכל התנועות שלה בספר הסמים.</p>
    <div class="field"><label for="trB">מספר אצווה</label><input id="trB" list="trList" dir="ltr" autocomplete="off" spellcheck="false" value="${esc(pre||'')}" placeholder="למשל M2401…"><datalist id="trList">${known.map(k=>`<option value="${esc(k.batch)}">${esc(k.name)} · ${fmtExp(k.exp).slice(3)}</option>`).join('')}</datalist></div>
    <div id="trOut" aria-live="polite"></div>`,'איתור',async err=>{
    const v=$('#trB').value.trim(); if(!v){ err('יש להקליד מספר אצווה.'); return false; }
    const t=batchTrace(v);
    if(!t.here.length&&!t.moves.length&&!t.sap.length){ $('#trOut').innerHTML=''; err('לא נמצא שום דבר עם האצווה הזו. בדקו את המספר.'); return false; }
    $('#genErr').textContent='';
    $('#trOut').innerHTML=traceHtml(t,false)+`<div class="dlg-actions"><button type="button" class="btn" id="trPrint">הדפסה / שמירה כ־PDF</button></div>`;
    $('#trPrint').addEventListener('click',()=>printTrace(t));
    return false; });
  if(pre) setTimeout(()=>$('#genOk').click(),50);
}
function printTrace(t){
  const w=window.open('','_blank'); if(!w) return toast('הדפדפן חסם חלון חדש. אפשרו חלונות קופצים לאתר.');
  const css=[...document.querySelectorAll('link[rel=stylesheet]')].map(l=>`<link rel="stylesheet" href="${l.href}">`).join('');
  w.document.write(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>איתור אצווה ${esc(t.batch)}</title>${css}<style>body{background:#fff;padding:16px}main{max-width:1000px;margin:0 auto}@media print{@page{size:A4;margin:12mm}.noprint{display:none}}</style></head><body><main><div class="noprint" style="margin-bottom:12px"><button class="btn primary" onclick="print()">הדפסה / שמירה כ־PDF</button></div><h1>איתור אצווה (ריקול)</h1>${traceHtml(t,true)}</main></body></html>`);
  w.document.close();
}
document.addEventListener('click',e=>{ if(e.target.closest('[data-trace]')) openTrace(''); });

/* ---------- actions ---------- */
document.addEventListener('click',async e=>{
  const j=e.target.closest('[data-jump]');
  if(j){ e.preventDefault(); const el=document.getElementById(j.dataset.jump); if(el){ el.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}); el.focus({preventScroll:true}); } return; }
  const b=e.target.closest('[data-act]'); if(!b) return;
  const id=b.dataset.id, a=b.dataset.act;
  const NEED={'add-item':'edit','edit-item':'edit','del-item':'edit','add-kit':'edit','edit-kit':'edit','dup-kit':'edit','del-kit':'edit','issue-kit':'edit','return-kit':'edit','add-loc':'edit','del-loc':'edit','qty-in':'receive','qty-out':'lower','mins':'edit','backup':'edit'};
  const SIGN_ACTS=['sign-item','kit-sign','dash-sign'], VIEW_OK=['inv-csv','show-alerts','perm','req-perm'];
  if(SIGN_ACTS.includes(a)&&!canFull('sign')){ toast('אין לך הרשאה להחתמה.'); return; }
  if(!SIGN_ACTS.includes(a)&&!VIEW_OK.includes(a)&&!canFull(route)){ toast('יש לך הרשאת צפייה בלבד במסך הזה.'); return; }
  if(NEED[a]&&!canDo(NEED[a])){ toast('אין לך הרשאה לפעולה הזו. פנו למנהל המערכת.'); return; }
  if(a==='kit-sign') return openKitSign(id);
  if(a==='mins') return openMins();
  if(a==='backup') return doBackup();
  if(a==='inv-csv') return exportInvCsv();
  if(a==='add-item') openItem(null,b.dataset.loc);
  else if(a==='edit-item') openItem(id);
  else if(a==='qty-in') openQty(id,'in');
  else if(a==='qty-out'){ if(canLower()) openQty(id,'out'); else toast('רק משתמשים מורשים יכולים להוריד כמות. השתמשו בהחתמה.'); }
  else if(a==='sign-item'){ signPrefill=id; if(route==='sign') applyPrefill(); else location.hash='sign'; }
  else if(a==='dash-sign'){ location.hash='sign'; if(window.SG) window.SG.open({items:[],onSigned:rec=>openAlloc(rec)}); else toast('מודול ההחתמה לא נטען. רעננו את הדף.'); }
  else if(a==='perm') openPerm();
  else if(a==='req-perm'){ $('#reqName').value=''; $('#reqErr').textContent=''; openDlg($('#reqDlg')); }
  else if(a==='add-kit') openKit(b.dataset.loc);
  else if(a==='add-loc'){ $('#lName').value=''; $('#locErr').textContent=''; openDlg($('#locDlg')); }
  else if(a==='show-alerts'){ inv.status='alert'; inv.q=''; inv.loc='all'; location.hash='inventory'; }
  else if(a==='del-item'){ const i=S.items[id]; if(await confirmDlg('מחיקת פריט',`למחוק את ${i.name} (אצווה ${i.batch||'ללא'}) מהמלאי? אי אפשר לבטל את הפעולה.`,'מחיקת פריט')){ if(await del('items',id)){ log('delete',i,i.qty); toast('הפריט נמחק'); } } }
  else if(a==='issue-kit'){ const k=S.kits[id]; const r=await confirmDlg('הוצאת ערכה',`להוציא את הערכה ${k.name} מ${k.loc}? הערכה תעבור לרשימת הערכות שהוצאו.`,'הוצאת הערכה',true);
    if(r){ const o=Object.assign({},k,{status:'issued',issuedAt:Date.now(),issueNote:r.note}); if(await put('kits',o)){ kitLedger(k,o,'ערכה הוצאה: '+k.name+(r.note?' · '+r.note:'')); log('kit-issue',o,0,r.note); toast('הערכה הוצאה'); } } }
  else if(a==='edit-kit') openKit(null,id,'edit');
  else if(a==='dup-kit') openKit(null,id,'dup');
  else if(a==='return-kit'){ const k=S.kits[id]; const r=await confirmDlg('החזרת ערכה למלאי',`להחזיר את הערכה ${k.name} למלאי? היא תחזור ל${k.loc}.`,'החזרה למלאי',true);
    if(r){ const o=Object.assign({},k,{status:'sealed',issuedAt:null,issueNote:'',returnedAt:Date.now()}); if(await put('kits',o)){ kitLedger(k,o,'ערכה הוחזרה: '+k.name+(r.note?' · '+r.note:'')); log('kit-return',o,0,r.note); toast('הערכה הוחזרה למלאי'); } } }
  else if(a==='del-kit'){ const k=S.kits[id]; if(await confirmDlg('מחיקת רשומת ערכה',`למחוק את הרשומה של ${k.name}?`,'מחיקה')){ if(await del('kits',id)) log('kit-delete',k,0); } }
  else if(a==='del-loc'){ const l=S.locations[id]; if(await confirmDlg('מחיקת מיקום',`למחוק את המיקום ${l.name}?`,'מחיקת מיקום')){ if(await del('locations',id)) toast('המיקום נמחק'); } }
});

/* ---------- font size ---------- */
function applyFs(n){ document.documentElement.classList.remove('fs-1','fs-2'); if(n>0) document.documentElement.classList.add('fs-'+n);
  document.querySelectorAll('[data-fs]').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.fs===n))); try{localStorage.setItem(FS_KEY,n);}catch(e){} }
document.querySelectorAll('[data-fs]').forEach(b=>b.addEventListener('click',()=>applyFs(+b.dataset.fs)));
let fs0=0; try{ fs0=+(localStorage.getItem(FS_KEY)||0); }catch(e){} applyFs(fs0);

/* ---------- start ---------- */
go();
(async()=>{
  let d=null;
  try{ if(window.claude&&typeof window.claude.use==='function') d=await window.claude.use('db'); }catch(e){ d=null; }
  if(d){ db=d; subscribe(); try{ user=await window.claude.use('user'); if(user) me=await user.me(); }catch(e){ user=null; } try{ dl=await window.claude.use('downloads'); }catch(e){ dl=null; } renderData(); initMeta(); }
  else{ mode='local'; loadLocal(); renderData(); initMeta(); }
})();
// re-evaluate month boundaries if the page stays open
setInterval(()=>renderData(),60*60*1000);
})();
