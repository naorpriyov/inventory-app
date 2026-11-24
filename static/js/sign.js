/* ניהול מלאי – מודול פתק ההחתמה */
/* ===== signing notes module (פתק החתמה) ===== */
(function(){
'use strict';
const DR=[
  {id:"morphine",he:"מורפיום",en:"MORPHINE",cls:"opioid"},
  {id:"midazolam",he:"מידזולם",en:"MIDAZOLAM",cls:"benzo"},
  {id:"ketamine50",he:"קטמין 50",en:"KETAMINE 50",cls:"induct"},
  {id:"ketamine500",he:"קטמין 500",en:"KETAMINE 500",cls:"induct"},
  {id:"actiq",he:"אקטיק",en:"ACTIQ (FENTANYL)",cls:"opioid"}
];
const OTHER={id:"other",he:"אחר",en:"OTHER",cls:"other"};
const REASONS=["טיפול מבצעי","נשבר","אימון"];
const LS_NOTES="sg-notes-local", LS_CARE="sg-caregivers";
const g=id=>document.getElementById(id);
const drug=id=>id==="other"?OTHER:(DR.find(d=>d.id===id)||{id,he:id,en:"",cls:"opioid"});
const itemLabel=it=>it.drug==="other"?(it.name||"אחר"):drug(it.drug).he;
function el(tag,attrs,kids){ const e=document.createElement(tag); for(const k in (attrs||{})){ if(k==="class") e.className=attrs[k]; else if(k==="text") e.textContent=attrs[k]; else e.setAttribute(k,attrs[k]); } (kids||[]).forEach(c=>c&&e.appendChild(c)); return e; }
function toast(t){ const s=g("toast"); if(!s) return; s.textContent=t; s.classList.add("show"); clearTimeout(toast._t); toast._t=setTimeout(()=>s.classList.remove("show"),3200); }
function today(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function fmtDay(s){ if(!s) return ""; const [y,m,d]=s.split("-"); return d+"/"+m+"/"+y.slice(2); }
function fmtStamp(ts){ const d=new Date(ts); return d.toLocaleDateString("he-IL",{day:"2-digit",month:"2-digit",year:"numeric"})+" "+d.toLocaleTimeString("he-IL",{hour:"2-digit",minute:"2-digit"}); }
const monthName=m=>new Date(2000,m-1,1).toLocaleDateString("he-IL",{month:"long"});
function lsGet(k,d){ try{ return JSON.parse(localStorage.getItem(k))??d; }catch(e){ return d; } }
function lsSet(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
const pill=(d,t)=>el("span",{class:"sg-pill sg-"+d.cls,text:t});

/* ---------- markup ---------- */
const host=document.createElement("div");
host.innerHTML=`
<div class="sg-overlay" id="sgOverlay" aria-hidden="true">
 <div class="sg-sheet" role="dialog" aria-modal="true" aria-labelledby="sgTitle">
  <div class="sg-head">
   <div><h2 id="sgTitle">פתק חדש</h2><div class="sg-ctx" id="sgCtx" hidden></div>
    <div class="sg-steps" id="sgSteps"><span class="on">1 · תרופות וכמויות</span><span>2 · פרטי מטפל</span></div></div>
   <button class="sg-x" id="sgClose" aria-label="סגירה">×</button>
  </div>
  <div class="sg-pane" id="sgP1">
   <div class="sg-field"><span class="sg-lbl sg-req" id="sgLinesLbl">סמן תרופות ורשום כמה יחידות נצרכו</span>
    <div class="sg-lines" id="sgLines"></div><div class="sg-err" id="sgEItems"></div></div>
  </div>
  <div class="sg-pane" id="sgP2" hidden>
   <div class="sg-summary" id="sgSummary"></div>
   <div class="sg-field"><label class="sg-lbl sg-req" for="sgName">שם המטפל</label>
    <input class="sg-in" id="sgName" list="sgKnown" autocomplete="off" placeholder="שם מלא"><datalist id="sgKnown"></datalist><datalist id="sgOthers"></datalist><div class="sg-err" id="sgEName"></div></div>
   <div class="sg-field">
    <div class="sg-seg" role="group" aria-label="סוג מספר"><button type="button" data-idt="מ״א" aria-pressed="true">מ״א – מספר אישי</button><button type="button" data-idt="מ״ר" aria-pressed="false">מ״ר – מספר רישיון</button></div>
    <div class="sg-row">
     <div><label class="sg-lbl sg-req" for="sgId" id="sgIdLbl">מספר אישי</label><input class="sg-in" id="sgId" inputmode="numeric" autocomplete="off"><div class="sg-err" id="sgEId"></div></div>
     <div><label class="sg-lbl sg-req" for="sgDate">תאריך מתן התרופה</label><input class="sg-in" id="sgDate" type="date"><div class="sg-err" id="sgEDate"></div></div>
    </div></div>
   <div class="sg-field"><span class="sg-lbl sg-req">סיבת ההחתמה</span><div class="sg-chips" id="sgReasons" role="group" aria-label="סיבת ההחתמה"></div><div class="sg-err" id="sgEReason"></div></div>
   <div class="sg-field"><label class="sg-lbl" for="sgRemarks">הערות</label><textarea class="sg-in" id="sgRemarks" rows="2" maxlength="400" placeholder="לא חובה"></textarea></div>
   <div class="sg-field"><span class="sg-lbl sg-req">חתימת המטפל</span>
    <div class="sg-pad" id="sgPadWrap"><canvas id="sgPad"></canvas><div class="base"></div><div class="ph" id="sgPadPh">חתום כאן באצבע או בעכבר</div></div>
    <div style="display:flex;justify-content:flex-end;margin-top:6px"><button type="button" class="sg-link" id="sgClear">ניקוי חתימה</button></div>
    <div class="sg-err" id="sgESig"></div></div>
  </div>
  <div class="sg-pane sg-done" id="sgP3" hidden><div class="big" aria-hidden="true">✓</div><h3>הפתק נשמר</h3><p id="sgDoneText"></p><button class="btn primary" id="sgDoneBtn">סגירה</button></div>
  <div class="sg-actions" id="sgActions"><button class="btn sg-back" id="sgBack" hidden>חזרה</button><button class="btn primary" id="sgNext">המשך לפרטי המטפל</button></div>
 </div>
</div>`;
document.body.appendChild(host);

/* ---------- runtime ---------- */
let db=null,user=null,uid=null,dl=null,manager=false,local=false,booted=false;
const all=new Map(); const subs=new Set();
let reportEl=null, selYear=new Date().getFullYear(), selMonth=0, openMonths=null, repMsg="טוען פתקים…";
let st={}, cb=null;

async function boot(){
  try{ user=await window.claude?.use?.("user"); }catch(e){}
  try{ db=await window.claude?.use?.("db"); }catch(e){}
  try{ dl=await window.claude?.use?.("downloads"); }catch(e){}
  if(user){ try{ uid=await user.id(); }catch(e){} try{ manager=await user.isOwner(); }catch(e){} try{ if(!manager&&user.canCancel) manager=await user.canCancel(); }catch(e){} }
  if(!db||!uid){ db=null; local=true; manager=!user||manager; lsGet(LS_NOTES,[]).forEach(n=>all.set(n._k,n)); repMsg=""; }
  booted=true;
  const nav=g("navNotes"); if(nav) nav.hidden=!manager;
  if(manager && db) subscribe();
  renderReport();
}
function subscribe(){
  const t=setTimeout(()=>{ repMsg="הפתקים עדיין לא נטענו – ייתכן שאין חיבור."; renderReport(); },10000);
  db.collection("notes").onSnapshot(snap=>{
    if(!snap.metadata.fromCache){ clearTimeout(t); repMsg=""; }
    snap.docs.forEach(d=>{
      if(subs.has(d.id)) return; subs.add(d.id);
      db.collection("notes/"+d.id+"/n").onSnapshot(s2=>{
        s2.docChanges().forEach(ch=>{ const k=d.id+"/"+ch.doc.id; if(ch.type==="removed") all.delete(k); else all.set(k,{...ch.doc.data(),_k:k}); });
        renderReport();
      },()=>{});
    });
    renderReport();
  },()=>{ clearTimeout(t); repMsg="אין הרשאה לצפות בפתקים, או שהם לא זמינים כרגע."; renderReport(); });
}
async function saveNote(rec){
  if(db){ await db.doc("notes/"+uid).set({updated:rec.ts}); await db.collection("notes/"+uid+"/n").add(rec); }
  else{ rec._k="l"+rec.ts; const a=lsGet(LS_NOTES,[]); a.push(rec); lsSet(LS_NOTES,a); all.set(rec._k,rec); renderReport(); }
}

/* ---------- sheet ---------- */
function open(opts){
  opts=opts||{};
  cb=typeof opts.onSigned==="function"?opts.onSigned:null;
  const qty={}; DR.forEach(d=>qty[d.id]=0); const other={qty:0,name:""};
  (opts.items||[]).forEach(it=>{ const q=Math.max(0,parseInt(it.qty)||0); if(it.drug==="other"){ other.qty=q; other.name=it.name||""; } else if(qty[it.drug]!==undefined) qty[it.drug]=q; });
  st={step:1,qty,other,idType:"מ״א",reason:null,lock:opts.lock||null,locks:Array.isArray(opts.locks)&&opts.locks.length?opts.locks:null,maxes:opts.maxes||null,max:opts.max!=null?+opts.max:null,meta:opts.meta||null,ref:opts.itemId||null};
  g("sgCtx").hidden=!opts.context; g("sgCtx").textContent=opts.context||"";
  g("sgLinesLbl").textContent=st.lock?"כמה יחידות נצרכו?":st.locks?"כמה יחידות נצרכו מכל סם?":"סמן תרופות ורשום כמה יחידות נצרכו";
  g("sgName").value=""; g("sgId").value=""; g("sgRemarks").value=""; g("sgDate").value=today(); g("sgDate").max=today();
  setIdType("מ״א"); clearErr(); pad.clear(); renderLines(); renderReasons(); renderKnown(); renderOthers(); show(1);
  g("sgOverlay").classList.add("open"); g("sgOverlay").setAttribute("aria-hidden","false"); document.body.style.overflow="hidden";
}
function close(){ g("sgOverlay").classList.remove("open"); g("sgOverlay").setAttribute("aria-hidden","true"); document.body.style.overflow=""; }

function lineRow(key){
  const isO=key==="other", d=drug(key), locked=st.lock===key||(!!st.locks&&st.locks.includes(key));
  const get=()=>isO?st.other.qty:st.qty[key];
  const inp=el("input",{type:"number",inputmode:"numeric",min:"0",step:"1",placeholder:"0","aria-label":"כמות יחידות "+d.he}); inp.value=get()||"";
  const minus=el("button",{type:"button","aria-label":"הפחתה",text:"−"}), plus=el("button",{type:"button","aria-label":"הוספה",text:"+"});
  const nm=el("button",{type:"button",class:"sg-nm"},[el("b",{text:d.he}),el("small",{text:d.en})]);
  let nameIn=null;
  if(isO){ nameIn=el("input",{class:"sg-in sg-oname",list:"sgOthers",id:"sgOName",placeholder:"רשום את סוג הסם",autocomplete:"off",maxlength:"60","aria-label":"סוג הסם"}); nameIn.value=st.other.name; nameIn.hidden=!(get()>0); if(locked) nameIn.readOnly=true; }
  const row=el("div",{class:"sg-line sg-"+d.cls+(get()>0?" on":"")},[nm,el("div",{class:"sg-step"},[plus,inp,minus]),el("span",{class:"sg-unit",text:"יח׳"}),nameIn]);
  const set=v=>{ const was=get(); v=Math.max(0,Math.min(999,parseInt(v)||0)); if(isO) st.other.qty=v; else st.qty[key]=v; inp.value=v||""; row.classList.toggle("on",v>0); if(nameIn){ nameIn.hidden=!(v>0); if(!was&&v>0&&!st.other.name) setTimeout(()=>nameIn.focus(),0); } g("sgEItems").textContent=""; };
  plus.addEventListener("click",()=>set(get()+1)); minus.addEventListener("click",()=>set(get()-1));
  nm.addEventListener("click",()=>{ if(!get()) set(1); inp.focus(); inp.select(); });
  inp.addEventListener("input",()=>set(inp.value));
  if(nameIn) nameIn.addEventListener("input",()=>{ st.other.name=nameIn.value; nameIn.classList.remove("bad"); g("sgEItems").textContent=""; });
  return row;
}
function renderLines(){
  const box=g("sgLines"); box.innerHTML="";
  if(st.locks){ st.locks.forEach(k=>box.appendChild(lineRow(k))); return; }
  if(st.lock){ box.appendChild(lineRow(st.lock)); return; }
  DR.forEach(d=>box.appendChild(lineRow(d.id))); box.appendChild(lineRow("other"));
}
function renderReasons(){
  const box=g("sgReasons"); box.innerHTML=""; box.classList.remove("bad");
  REASONS.forEach(r=>{ const b=el("button",{type:"button",class:"sg-chip","aria-pressed":String(st.reason===r),text:r}); b.addEventListener("click",()=>{ st.reason=r; renderReasons(); g("sgEReason").textContent=""; }); box.appendChild(b); });
}
function careAll(){ const m=Object.assign({},lsGet(LS_CARE,{})); try{ if(window.SG_CARE) Object.assign(m,window.SG_CARE.all()); }catch(e){} return m; }
function renderOthers(){ const d=g("sgOthers"); if(!d) return; d.innerHTML=""; let a=[]; try{ a=window.SG_OTHERS?window.SG_OTHERS():[]; }catch(e){} a.forEach(n=>d.appendChild(el("option",{value:n}))); }
function renderKnown(){ const d=g("sgKnown"); d.innerHTML=""; Object.keys(careAll()).forEach(n=>d.appendChild(el("option",{value:n}))); }
function setIdType(t){ st.idType=t; host.querySelectorAll(".sg-seg button").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.idt===t))); g("sgIdLbl").textContent=t==="מ״א"?"מספר אישי":"מספר רישיון"; }
host.querySelectorAll(".sg-seg button").forEach(b=>b.addEventListener("click",()=>setIdType(b.dataset.idt)));
g("sgName").addEventListener("change",()=>{ const k=careAll()[g("sgName").value.trim()]; if(!k) return; setIdType(k.idType||"מ״א"); if(!g("sgId").value) g("sgId").value=k.idNum||""; });

function items(){
  const a=DR.filter(d=>st.qty[d.id]>0).map(d=>({drug:d.id,qty:st.qty[d.id]}));
  if(st.other.qty>0) a.push({drug:"other",qty:st.other.qty,name:st.other.name.trim()});
  return a;
}
function show(n){
  st.step=n; g("sgP1").hidden=n!==1; g("sgP2").hidden=n!==2; g("sgP3").hidden=n!==3;
  g("sgActions").hidden=n===3; g("sgBack").hidden=n!==2; g("sgSteps").hidden=n===3;
  g("sgNext").textContent=n===1?"המשך לפרטי המטפל":"חתום ושמור";
  const s=g("sgSteps").children; s[0].classList.toggle("on",n===1); s[1].classList.toggle("on",n===2);
  if(n===1) setTimeout(()=>{ const i=g("sgLines").querySelector("input"); if(i) i.focus(); },60);
  if(n===2){
    const sm=g("sgSummary"); sm.innerHTML=""; const e=el("button",{type:"button",class:"sg-link",text:"שינוי"}); e.addEventListener("click",()=>show(1));
    const p=el("div",{class:"sg-pills"}); items().forEach(it=>p.appendChild(pill(drug(it.drug),itemLabel(it)+" × "+it.qty)));
    sm.append(el("div",{class:"t"},[el("b",{text:"בפתק:"}),e]),p);
    setTimeout(()=>{ pad.resize(); g("sgName").focus(); },30);
  }
}
function clearErr(){ ["sgEItems","sgEName","sgEId","sgEDate","sgEReason","sgESig"].forEach(i=>g(i).textContent=""); host.querySelectorAll(".sg-in.bad").forEach(e=>e.classList.remove("bad")); g("sgPadWrap").classList.remove("bad"); g("sgReasons").classList.remove("bad"); }
function fail(e,i,m){ g(e).textContent=m; if(i) g(i).classList.add("bad"); return false; }
function validate2(){
  clearErr(); let ok=true;
  if(!g("sgName").value.trim()) ok=fail("sgEName","sgName","הזן את שם המטפל.");
  if(!/^\d{4,10}$/.test(g("sgId").value.trim())) ok=fail("sgEId","sgId","ספרות בלבד.");
  const dt=g("sgDate").value; if(!dt) ok=fail("sgEDate","sgDate","בחר תאריך."); else if(dt>today()) ok=fail("sgEDate","sgDate","תאריך עתידי.");
  if(!st.reason){ ok=fail("sgEReason",null,"בחר סיבה."); g("sgReasons").classList.add("bad"); }
  if(!pad.hasInk){ ok=fail("sgESig",null,"נדרשת חתימה."); g("sgPadWrap").classList.add("bad"); }
  return ok;
}
g("sgNext").addEventListener("click",async()=>{
  if(st.step===1){
    const its=items();
    if(!its.length){ g("sgEItems").textContent="סמן לפחות תרופה אחת עם כמות."; return; }
    if(st.other.qty>0&&!st.other.name.trim()){ g("sgEItems").textContent="רשום את סוג הסם שסימנת ב״אחר״."; const o=g("sgOName"); if(o){ o.classList.add("bad"); o.focus(); } return; }
    if(st.max!=null&&its[0].qty>st.max){ g("sgEItems").textContent="במלאי יש רק "+st.max+" יחידות של הפריט הזה."; return; }
    if(st.maxes){ const over=its.find(it=>st.maxes[it.drug]!=null&&it.qty>st.maxes[it.drug]); if(over){ g("sgEItems").textContent="במלאי יש רק "+st.maxes[over.drug]+" יחידות של "+itemLabel(over)+"."; return; } }
    show(2); return;
  }
  if(!validate2()) return;
  const b=g("sgNext"); b.disabled=true; b.textContent="שומר…";
  const rec={ts:Date.now(),date:g("sgDate").value,items:items(),name:g("sgName").value.trim(),idType:st.idType,idNum:g("sgId").value.trim(),reason:st.reason,remarks:g("sgRemarks").value.trim(),sig:pad.toDataURL()};
  if(st.ref) rec.itemRef=st.ref; if(st.meta) Object.assign(rec,st.meta);
  try{
    await saveNote(rec);
    const c=lsGet(LS_CARE,{}); c[rec.name]={idType:rec.idType,idNum:rec.idNum}; lsSet(LS_CARE,c); try{ if(window.SG_CARE) window.SG_CARE.set(rec.name,{idType:rec.idType,idNum:rec.idNum}); }catch(e){}
    g("sgDoneText").textContent=rec.items.map(it=>itemLabel(it)+" × "+it.qty).join(" · ")+" — נחתם ע״י "+rec.name;
    show(3); g("sgDoneBtn").focus();
    if(cb){ try{ await cb(rec); }catch(e){} }
  }catch(e){
    g("sgESig").textContent=e&&e.code==="permission_denied"?"אין לך הרשאת כתיבה. בקש מהמנהל לשתף איתך את הדף עם הרשאת עריכה.":"השמירה נכשלה. נסה שוב.";
  }finally{ b.disabled=false; if(st.step===2) b.textContent="חתום ושמור"; }
});
g("sgBack").addEventListener("click",()=>show(1));
g("sgClose").addEventListener("click",close);
g("sgDoneBtn").addEventListener("click",close);
document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&g("sgOverlay").classList.contains("open")) close(); });

/* ---------- signature pad ---------- */
const pad=(function(){
  const c=g("sgPad"),x=c.getContext("2d"); let on=false,last=null; const api={hasInk:false};
  function resize(){ const r=c.getBoundingClientRect(); if(!r.width) return; const dpr=Math.max(1,window.devicePixelRatio||1); const keep=api.hasInk?c.toDataURL():null;
    c.width=Math.round(r.width*dpr); c.height=Math.round(r.height*dpr); x.setTransform(dpr,0,0,dpr,0,0); x.lineCap="round"; x.lineJoin="round"; x.strokeStyle="#0d1a33"; x.fillStyle="#0d1a33"; x.lineWidth=2.4;
    if(keep){ const im=new Image(); im.onload=()=>x.drawImage(im,0,0,r.width,r.height); im.src=keep; } }
  const pos=e=>{ const r=c.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; };
  c.addEventListener("pointerdown",e=>{ on=true; c.setPointerCapture(e.pointerId); last=pos(e); x.beginPath(); x.arc(last.x,last.y,1.1,0,Math.PI*2); x.fill(); mark(); });
  c.addEventListener("pointermove",e=>{ if(!on) return; const p=pos(e); x.beginPath(); x.moveTo(last.x,last.y); x.lineTo(p.x,p.y); x.stroke(); last=p; });
  ["pointerup","pointercancel"].forEach(t=>c.addEventListener(t,()=>on=false));
  function mark(){ if(!api.hasInk){ api.hasInk=true; g("sgPadPh").hidden=true; g("sgESig").textContent=""; g("sgPadWrap").classList.remove("bad"); } }
  api.clear=()=>{ x.save(); x.setTransform(1,0,0,1,0,0); x.clearRect(0,0,c.width,c.height); x.restore(); api.hasInk=false; g("sgPadPh").hidden=false; };
  api.resize=resize;
  api.toDataURL=()=>{ const r=c.getBoundingClientRect(); const w=Math.min(480,Math.round(r.width)),h=Math.round(w*r.height/r.width); const o=document.createElement("canvas"); o.width=w; o.height=h; const ox=o.getContext("2d"); ox.fillStyle="#fff"; ox.fillRect(0,0,w,h); ox.drawImage(c,0,0,w,h); return o.toDataURL("image/png"); };
  window.addEventListener("resize",()=>{ if(g("sgOverlay").classList.contains("open")) resize(); });
  return api;
})();
g("sgClear").addEventListener("click",()=>pad.clear());

/* ---------- monthly report (owner only) ---------- */
function totalsOf(list){ const t={}; list.forEach(n=>(n.items||[]).forEach(it=>{ const k=it.drug==="other"?"other:"+(it.name||""):it.drug; t[k]=(t[k]||0)+(it.qty||0); })); return t; }
const notesArr=()=>[...all.values()].filter(n=>n&&n.date);
let repQ="";
const matchQ=n=>{ const q=repQ.toLowerCase(); return String(n.name||"").toLowerCase().includes(q)||String(n.idNum||"").includes(q); };
const inSel=n=>repQ?matchQ(n):n.date.startsWith(selYear+"-")&&(!selMonth||parseInt(n.date.slice(5,7))===selMonth);
const byDate=(a,b)=>a.date<b.date?-1:a.date>b.date?1:a.ts-b.ts;

function serialOf(n){ const key=n.date.slice(0,7); const ml=notesArr().filter(x=>x.date.startsWith(key)).sort(byDate); const ix=ml.indexOf(n)+1; return {serial:key.replace("-","")+"-"+ix,idx:ix}; }
function noteLi(n){
  const so=serialOf(n);
  const its=el("div",{class:"sg-pills",style:"margin-top:4px"}); (n.items||[]).forEach(it=>its.appendChild(pill(drug(it.drug),itemLabel(it)+" × "+it.qty)));
  const sig=el("div",{class:"sig"}); if(n.sig){ const im=el("img",{alt:"חתימת "+n.name}); im.src=n.sig; sig.appendChild(im); }
  const pb=el("button",{type:"button",class:"sg-link",style:"margin-top:6px;font-weight:600",text:"הפקת פתק PDF להדפסה"}); pb.addEventListener("click",()=>makePdf(n,so.serial,pb));
  const hk=window.SG_HOOKS||{}; let stx=""; try{ stx=hk.status?hk.status(n):""; }catch(e){}
  let cx=null; if(hk.cancel){ cx=el("button",{type:"button",class:"sg-link",style:"margin-top:6px;margin-inline-start:16px;font-weight:600;color:var(--bad-ink)",text:"זיכוי פתק / החזרה למלאי"}); cx.addEventListener("click",()=>hk.cancel(n)); }
  return el("li",{class:"sg-note"},[el("div",{},[
    el("div",{class:"h"},[el("span",{class:"d",text:fmtDay(n.date)}),el("span",{class:"r",text:n.reason||""}),el("span",{class:"num",text:"פתק "+so.idx}),stx?el("span",{class:"r",style:"border-color:var(--bad-edge);color:var(--bad-ink);font-weight:700",text:stx}):null]),
    its,
    el("div",{class:"who",text:n.name+" · "+n.idType+" "+n.idNum+(n.batch?" · אצווה "+n.batch:"")+(n.loc?" · "+n.loc:"")+(n.kit?" · ערכה "+n.kit:"")}),
    n.remarks?el("div",{class:"who",text:"הערות: "+n.remarks}):null,
    el("div",{},[pb,cx])]),sig]);
}
function mountReport(container){ reportEl=container; renderReport(); }
function renderReport(){
  try{ if(window.SG_HOOKS&&window.SG_HOOKS.onNotes) window.SG_HOOKS.onNotes(); }catch(e){}
  if(!reportEl||!document.body.contains(reportEl)) return;
  const R=reportEl; R.innerHTML="";
  if(!booted){ R.appendChild(el("p",{class:"sg-status",text:"טוען…"})); return; }
  if(!manager){ R.appendChild(el("div",{class:"sg-empty",text:"פירוט הפתקים זמין רק למנהל המלאי ולמי שקיבל הרשאת זיכוי פתקים."})); return; }
  const allN=notesArr();
  const ys=[...new Set(allN.map(n=>parseInt(n.date.slice(0,4))).concat([new Date().getFullYear()]))].sort((a,b)=>b-a);
  const ySel=el("select",{id:"sgYear"}); ys.forEach(y=>{ const o=el("option",{value:String(y),text:String(y)}); if(y===selYear) o.selected=true; ySel.appendChild(o); });
  const mSel=el("select",{id:"sgMonth"}); mSel.appendChild(el("option",{value:"0",text:"כל החודשים"})); for(let m=1;m<=12;m++){ const o=el("option",{value:String(m),text:monthName(m)}); if(m===selMonth) o.selected=true; mSel.appendChild(o); }
  ySel.addEventListener("change",()=>{ selYear=parseInt(ySel.value); openMonths=null; renderReport(); });
  mSel.addEventListener("change",()=>{ selMonth=parseInt(mSel.value)||0; openMonths=null; renderReport(); });
  const exp=el("button",{class:"btn",type:"button",text:"ייצוא ל־CSV"}); exp.hidden=!dl; exp.addEventListener("click",exportCsv);
  const qIn=el("input",{class:"sg-in",id:"sgQ",type:"search",placeholder:"חיפוש לפי שם מטפל או מספר אישי","aria-label":"חיפוש פתקים לפי שם מטפל או מספר אישי"}); qIn.value=repQ;
  qIn.addEventListener("input",()=>{ repQ=qIn.value.trim(); renderReport(); const n2=g("sgQ"); if(n2){ n2.focus(); try{ n2.setSelectionRange(n2.value.length,n2.value.length); }catch(e){} } });
  R.appendChild(el("div",{style:"margin-bottom:12px"},[qIn]));
  R.appendChild(el("div",{class:"sg-rbar"},[el("label",{for:"sgYear",text:"שנה"}),ySel,el("label",{for:"sgMonth",text:"חודש"}),mSel,el("span",{class:"sp"}),exp]));
  if(repMsg) R.appendChild(el("p",{class:"sg-status",text:repMsg}));
  if(local) R.appendChild(el("p",{class:"sg-status",text:"מצב מקומי – הפתקים נשמרים במכשיר זה בלבד."}));
  const list=allN.filter(inSel); const period=repQ?"תוצאות החיפוש":(selMonth?monthName(selMonth)+" ":"")+selYear;
  if(!list.length){ R.appendChild(el("div",{class:"sg-empty",text:"אין פתקים ב"+period+"."})); return; }
  const tot=totalsOf(list), grid=el("div",{class:"sg-tgrid"});
  DR.forEach(d=>grid.appendChild(el("div",{class:"sg-tcell sg-"+d.cls},[el("div",{class:"n",text:String(tot[d.id]||0)}),el("div",{class:"l",text:d.he+" · יח׳"})])));
  Object.keys(tot).filter(k=>k.startsWith("other:")).forEach(k=>grid.appendChild(el("div",{class:"sg-tcell sg-other"},[el("div",{class:"n",text:String(tot[k])}),el("div",{class:"l",text:k.slice(6)+" · יח׳"})])));
  const rc={}; list.forEach(n=>rc[n.reason]=(rc[n.reason]||0)+1);
  R.appendChild(el("section",{class:"sg-totals"},[el("h2",{text:"סיכום "+period+" – "+list.length+" פתקים"}),grid,el("div",{class:"sg-tmeta",text:REASONS.map(r=>r+": "+(rc[r]||0)).join("   ·   ")})]));
  if(repQ){ const ul=el("ul",{class:"sg-notes",style:"background:var(--surface);border:1px solid var(--line);border-radius:12px;padding-top:4px"}); list.slice().sort((a,b)=>byDate(b,a)).forEach(n=>ul.appendChild(noteLi(n))); R.appendChild(ul); return; }
  const nowM=new Date().getFullYear()===selYear?new Date().getMonth()+1:0;
  const lastM=Math.max(...list.map(n=>parseInt(n.date.slice(5,7))));
  const hasNow=nowM&&list.some(n=>parseInt(n.date.slice(5,7))===nowM); const defOpen=hasNow?nowM:lastM;
  for(let m=1;m<=12;m++){
    if(selMonth&&m!==selMonth) continue;
    const key=selYear+"-"+String(m).padStart(2,"0"); const ml=list.filter(n=>n.date.startsWith(key)).sort(byDate); if(!ml.length) continue;
    const mt=totalsOf(ml), pills=el("div",{class:"sg-pills"});
    DR.forEach(d=>{ if(mt[d.id]) pills.appendChild(pill(d,d.he+" "+mt[d.id])); });
    Object.keys(mt).filter(k=>k.startsWith("other:")).forEach(k=>pills.appendChild(pill(OTHER,k.slice(6)+" "+mt[k])));
    const det=el("details",{class:"sg-month"},[el("summary",{},[el("span",{class:"sg-mname",text:monthName(m)}),el("span",{class:"sg-mcount",text:ml.length+" פתקים"}),pills])]);
    det.open = openMonths ? openMonths.has(m) : (!!selMonth || m===defOpen);
    det.addEventListener("toggle",()=>{ if(!openMonths){ openMonths=new Set(); reportEl.querySelectorAll("details.sg-month").forEach(x=>{ if(x.open) openMonths.add(+x.dataset.m); }); } if(det.open) openMonths.add(m); else openMonths.delete(m); });
    det.dataset.m=m;
    const ul=el("ul",{class:"sg-notes"});
    ml.forEach(n=>ul.appendChild(noteLi(n)));
    det.appendChild(ul); R.appendChild(det);
  }
}
async function exportCsv(){
  const list=notesArr().filter(inSel).sort(byDate);
  if(!dl||!list.length){ toast("אין פתקים לייצוא"); return; }
  const esc=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
  const head=["חודש","תאריך מתן התרופה","תרופה","יחידות","סיבה","שם מטפל","סוג מספר","מספר","אצווה","מיקום","הערות"];
  const rows=[]; list.forEach(n=>(n.items||[]).forEach(it=>rows.push([monthName(parseInt(n.date.slice(5,7))),fmtDay(n.date),itemLabel(it),it.qty,n.reason,n.name,n.idType,n.idNum,n.batch||"",n.loc||"",n.remarks||""].map(esc).join(","))));
  try{ await dl.save({filename:"פתקים-"+(selMonth?String(selMonth).padStart(2,"0")+"-":"")+selYear+".csv",data:new Blob(["\uFEFF"+head.map(esc).join(",")+"\n"+rows.join("\n")],{type:"text/csv"})}); }
  catch(e){ if(!(e&&e.code==="declined")) toast("הייצוא לא זמין כאן"); }
}

/* ---------- printable PDF ---------- */
let jsP=null;
function loadJsPdf(){ if(window.jspdf) return Promise.resolve(); if(!jsP) jsP=new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="/static/vendor/jspdf.umd.min.js"; s.onload=res; s.onerror=()=>{ jsP=null; rej(new Error("load")); }; document.head.appendChild(s); }); return jsP; }
const loadImg=src=>new Promise(r=>{ if(!src) return r(null); const i=new Image(); i.onload=()=>r(i); i.onerror=()=>r(null); i.src=src; });
async function drawNote(n,serial){
  const FAM='"IBM Plex Sans Hebrew", "Arial Hebrew", Arial, sans-serif';
  try{ await Promise.all([document.fonts.load('700 40px "IBM Plex Sans Hebrew"'),document.fonts.load('400 30px "IBM Plex Sans Hebrew"')]); }catch(e){}
  const W=1240,H=1748,L=90,R=W-90,IW=W-180; const c=document.createElement("canvas"); c.width=W; c.height=H; const x=c.getContext("2d");
  const F=(w,s)=>{ x.font=w+" "+s+"px "+FAM; };
  x.fillStyle="#fff"; x.fillRect(0,0,W,H); x.fillStyle="#000"; x.strokeStyle="#000"; x.textBaseline="middle"; x.direction="rtl";
  x.lineWidth=5; x.strokeRect(60,60,W-120,H-120);
  F(700,58); x.textAlign="right"; x.fillText("פתק רפואה",R,160);
  F(500,34); x.textAlign="center"; x.fillText("-מוגבל-",W/2,125);
  x.lineWidth=3; x.strokeRect(L,95,320,120); F(400,26); x.textAlign="right"; x.fillText("מספר:",L+305,125);
  F(700,36); x.textAlign="center"; x.direction="ltr"; x.fillText(serial,L+160,175); x.direction="rtl";
  const y=250; x.lineWidth=3; x.strokeRect(L,y,IW,560);
  F(700,32); x.textAlign="right"; const ht="תרופות שניתנו:"; x.fillText(ht,R-24,y+48); x.beginPath(); x.lineWidth=2; x.moveTo(R-24-x.measureText(ht).width,y+72); x.lineTo(R-24,y+72); x.stroke();
  x.textAlign="left"; x.direction="ltr"; x.fillText("Rp.",L+24,y+48); x.direction="rtl";
  const q={}; (n.items||[]).forEach(it=>{ if(it.drug!=="other") q[it.drug]=it.qty; });
  const box=(yy,on)=>{ x.lineWidth=3; x.strokeRect(R-70,yy-22,44,44); if(on){ x.lineWidth=6; x.beginPath(); x.moveTo(R-62,yy); x.lineTo(R-50,yy+14); x.lineTo(R-32,yy-14); x.stroke(); } };
  DR.forEach((d,i)=>{ const yy=y+140+i*78, on=q[d.id]>0; box(yy,on);
    F(on?700:400,34); x.textAlign="right"; x.direction="rtl"; const he=d.he+" - "; x.fillText(he,R-90,yy);
    const hw=x.measureText(he).width; x.direction="ltr"; x.fillText(d.en,R-90-hw,yy); x.direction="rtl";
    x.textAlign="left"; x.fillText(on?"כמות: "+q[d.id]+" יח׳":"כמות: ____",L+30,yy); });
  { const oi=(n.items||[]).find(it=>it.drug==="other"), yy=y+140+DR.length*78, on=!!oi; box(yy,on);
    F(on?700:400,34); x.textAlign="right"; x.fillText("אחר - "+(on?String(oi.name||"").slice(0,28):"________________"),R-90,yy);
    x.textAlign="left"; x.fillText(on?"כמות: "+oi.qty+" יח׳":"כמות: ____",L+30,yy); }
  const ty=850, tw=IW/3; x.lineWidth=3; x.strokeRect(L,ty,IW,150);
  x.beginPath(); x.moveTo(L,ty+88); x.lineTo(R,ty+88); x.moveTo(L+tw,ty); x.lineTo(L+tw,ty+150); x.moveTo(L+2*tw,ty); x.lineTo(L+2*tw,ty+150); x.stroke();
  [[n.idType+" "+n.idNum,n.idType==="מ״ר"?"מספר רישיון":"מספר אישי"],[n.name,"שם המטפל"],[fmtDay(n.date),"תאריך מתן התרופה"]].forEach((cc,i)=>{ const cx=R-tw*i-tw/2; F(700,32); x.textAlign="center"; x.fillText(cc[0],cx,ty+46); F(500,26); x.fillText(cc[1],cx,ty+120); });
  const ry=1040; x.strokeRect(L,ry,IW,250); F(700,30); x.textAlign="right"; x.fillText("סיבת ההחתמה: "+(n.reason||""),R-24,ry+46);
  F(400,28); const words=("הערות: "+(n.remarks||"—")+(n.batch?" · אצווה "+n.batch:"")).split(/\s+/); let line="",ly=ry+105,lines=0;
  for(const w of words){ const t=line?line+" "+w:w; if(x.measureText(t).width>IW-48&&line){ x.fillText(line,R-24,ly); ly+=42; line=w; if(++lines>=3){ line=""; break; } } else line=t; }
  if(line) x.fillText(line,R-24,ly);
  const sy=1330; x.lineWidth=3; x.strokeRect(L,sy,IW,260); F(700,30); x.textAlign="right"; x.fillText("חתימת המטפל",R-24,sy+46);
  F(400,24); x.fillText("נחתם: "+fmtStamp(n.ts),R-24,sy+96);
  const img=await loadImg(n.sig); if(img){ const bw=620,bh=230,s=Math.min(bw/img.width,bh/img.height),w=img.width*s,h=img.height*s; x.drawImage(img,L+20+(bw-w)/2,sy+15+(bh-h)/2,w,h); }
  F(400,22); x.textAlign="center"; x.fillStyle="#444"; x.fillText("העתק דיגיטלי של פתק חתום · הופק "+fmtStamp(Date.now()),W/2,1640);
  return c;
}
async function makePdf(n,serial,btn){
  if(!dl){ toast("הורדת קבצים לא זמינה בתצוגה הזו"); return; }
  btn.disabled=true; const old=btn.textContent; btn.textContent="מכין PDF…";
  try{ await loadJsPdf(); const c=await drawNote(n,serial); const pdf=new window.jspdf.jsPDF({unit:"mm",format:"a5",orientation:"portrait"}); pdf.addImage(c.toDataURL("image/jpeg",0.92),"JPEG",0,0,148,210); await dl.save({filename:"פתק-"+serial+".pdf",data:pdf.output("blob")}); }
  catch(e){ if(!(e&&e.code==="declined")) toast("הפקת ה־PDF נכשלה. נסה שוב."); }
  finally{ btn.disabled=false; btn.textContent=old; }
}

window.SG={open,mountReport,notes:()=>notesArr(),refresh:()=>renderReport(),get manager(){ return manager; }};
window.openSignForm=open;
const pre=g("sgReport"); if(pre) mountReport(pre);
boot();
})();
