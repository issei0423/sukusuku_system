/* ================================================================
   状態: サーバ(/api)から取得したデータをここに保持する
================================================================ */
let ME = null;            // {id, name, role}
let CHILDREN = [];        // 園児＋午睡状態
let CHANNELS = [];        // 自分の役割で見えるチャンネル
let NISSHI = [];
let DEV_ITEMS = [];
let DEV_RESULTS = {};     // {item_id: result}
let currentCh = null;
let currentKid = null;
let currentPage = 'home';
const memoOpen = {};      // 午睡メモ欄の開閉（画面側の状態）

const roleLabel = {admin:'👑 園長・主任', staff:'🌼 保育士', parent:'🏠 保護者'};

/* ================================================================
   APIヘルパー
================================================================ */
async function api(path, opts = {}){
  const res = await fetch('/api' + path, {
    headers: {'Content-Type':'application/json'},
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch(e) {}
  if(res.status === 401){ showLogin(); throw new Error(data.error || '未ログイン'); }
  if(!res.ok) throw new Error(data.error || 'エラーが発生しました');
  return data;
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function nowStr(){const n=new Date();return `${n.getHours()}:${String(n.getMinutes()).padStart(2,'0')}`;}

/* ================================================================
   ログイン / 新規登録
================================================================ */
function switchTab(t){
  document.getElementById('tab-login').classList.toggle('on', t==='login');
  document.getElementById('tab-signup').classList.toggle('on', t==='signup');
  document.getElementById('pane-login').style.display = t==='login' ? 'block' : 'none';
  document.getElementById('pane-signup').style.display = t==='signup' ? 'block' : 'none';
}
async function doLogin(){
  const err = document.getElementById('loginErr');
  err.textContent = '';
  try{
    await api('/login', {method:'POST', body: JSON.stringify({
      id: document.getElementById('uid').value.trim(),
      password: document.getElementById('pw').value,
      remember: document.getElementById('remember').checked,
    })});
    await enterApp();
  }catch(e){ err.textContent = e.message; }
}
function quickLogin(id){
  document.getElementById('uid').value = id;
  document.getElementById('pw').value = id;
  switchTab('login');
  doLogin();
}
async function doSignup(){
  const err = document.getElementById('signupErr');
  err.textContent = '';
  try{
    await api('/signup', {method:'POST', body: JSON.stringify({
      code: document.getElementById('code').value.trim(),
      id: document.getElementById('nid').value.trim(),
      password: document.getElementById('npw').value,
    })});
    await enterApp();
  }catch(e){ err.textContent = e.message; }
}
async function logout(){
  try{ await api('/logout', {method:'POST'}); }catch(e){}
  showLogin();
}
function showLogin(){
  document.getElementById('app').classList.remove('active');
  document.getElementById('login').classList.add('active');
}

/* ================================================================
   アプリ初期化（ログイン後）
================================================================ */
async function enterApp(){
  const d = await api('/bootstrap');
  ME = d.user; CHILDREN = d.children; CHANNELS = d.channels;
  NISSHI = d.nisshi; DEV_ITEMS = d.dev_items;
  SERVER_TODAY = d.today;   // 「本日」判定はサーバ日付を正とする（端末時刻ズレ対策）

  document.getElementById('login').classList.remove('active');
  document.getElementById('app').classList.add('active');
  document.getElementById('roleBadge').textContent = roleLabel[ME.role];

  applyRoleVisibility();
  renderHome();
  renderNisshi();
  renderChatSide();
  if(CHANNELS.length){ currentCh = CHANNELS.some(c=>c.id===currentCh) ? currentCh : CHANNELS[0].id; }
  await loadMessages();
  renderGosui();
  renderDevList();
  currentKid = CHILDREN.length ? CHILDREN[0].id : null;
  if(currentKid) await openKid(currentKid);
  if(ME.role!=='parent' && CHILDREN.length) await openShintaiKid(CHILDREN[0].id);

  go('home');
  window.scrollTo(0,0);
}

function applyRoleVisibility(){
  const r = ME.role;
  document.querySelectorAll('[data-hide]').forEach(el=>{
    el.style.display = el.dataset.hide.split(' ').includes(r) ? 'none' : '';
  });
  document.querySelectorAll('[data-show]').forEach(el=>{
    el.style.display = el.dataset.show.split(' ').includes(r) ? '' : 'none';
  });
  const gosuiBtn = document.querySelector('.app-nav [data-page="gosui"]');
  gosuiBtn.disabled = (r==='parent');
}

/* ================================================================
   ページ遷移
================================================================ */
function go(p){
  if((p==='gosui' || p==='shintai') && ME && ME.role==='parent') return;
  currentPage = p;
  document.querySelectorAll('.page').forEach(m=>m.hidden = m.dataset.pg!==p);
  document.querySelectorAll('.app-nav button').forEach(b=>b.classList.toggle('on', b.dataset.page===p));
  window.scrollTo(0,0);
}

/* ================================================================
   ホーム
================================================================ */
function renderHome(){
  const now = new Date();
  const date = now.toLocaleDateString('ja-JP', {year:'numeric',month:'long',day:'numeric',weekday:'short'});
  document.getElementById('greetTitle').textContent =
    (now.getHours()<11?'おはようございます':'こんにちは') + '、' + ME.name;
  document.getElementById('greetSub').textContent = `${date} ・ ひまわり組`;

  const pend = NISSHI.filter(n=>n.status==='申請中').length;
  document.getElementById('badgeNisshi').textContent = pend ? `申請中 ${pend}件` : '';
  document.getElementById('badgeGosui').textContent = `見守り中 ${CHILDREN.filter(c=>c.sleeping).length}名`;
  const late = CHILDREN.filter(c=>c.late).length;
  document.getElementById('badgeDev').textContent = late ? `未実施 ${late}名` : '';
}

/* ================================================================
   日誌
================================================================ */
function renderNisshi(){
  const box = document.getElementById('nisshiList');
  if(!NISSHI.length){
    box.innerHTML = '<p class="empty">表示できる日誌はまだありません。</p>';
    return;
  }
  const chipCls = {'下書き':'draft','申請中':'pending','承認済み':'ok','差し戻し':'back'};
  box.innerHTML = NISSHI.map(n=>`
    <div class="nisshi-item">
      <div class="date"><b>${esc(n.date)}</b><span>${esc(n.dow)}</span></div>
      <div>
        <h4>${esc(n.title)} <span class="chip ${chipCls[n.status]}">${n.status}</span></h4>
        <p>${esc(n.detail)}</p>
      </div>
      <div class="acts">
        ${ME.role==='admin' && n.status==='申請中' ? `
          <button class="mini approve" onclick="setNisshiStatus(${n.id},'承認済み')">承認</button>
          <button class="mini back" onclick="setNisshiStatus(${n.id},'差し戻し')">差し戻し</button>`:''}
        <button class="mini" onclick="alert('日誌の詳細画面は次の開発ステップです')">開く</button>
      </div>
    </div>`).join('');
}
async function setNisshiStatus(id, status){
  const d = await api(`/nisshi/${id}/status`, {method:'POST', body:JSON.stringify({status})});
  const i = NISSHI.findIndex(n=>n.id===id);
  if(i>=0) NISSHI[i] = d.nisshi;
  renderNisshi(); renderHome();
}

/* ================================================================
   チャット
================================================================ */
const chGrpOrder = ['園全体','グループ','個人'];
function renderChatSide(){
  const side = document.getElementById('chatSide');
  let html = '';
  chGrpOrder.forEach(g=>{
    const chs = CHANNELS.filter(c=>c.grp===g);
    if(!chs.length) return;
    html += `<h4>${g}</h4>`;
    html += chs.map(c=>`
      <button class="ch ${c.id===currentCh?'on':''}" onclick="openCh('${c.id}')">
        ${c.icon} ${esc(c.name)}
        ${c.perm==='read'?'<span class="lock">閲覧のみ</span>':''}
      </button>`).join('');
  });
  side.innerHTML = html;
}
async function openCh(id){
  currentCh = id;
  renderChatSide();
  await loadMessages();
  const row = document.getElementById('chatInputRow');
  if(row.style.display!=='none') document.getElementById('chatInput').focus();
}
async function loadMessages(){
  if(!currentCh) return;
  const c = CHANNELS.find(x=>x.id===currentCh);
  if(!c) return;
  const d = await api(`/channels/${currentCh}/messages`);
  document.getElementById('chatHead').innerHTML =
    `${c.icon} <b>${esc(c.name)}</b> <small style="color:var(--cocoa-soft)">${esc(c.sub)}</small>`;
  const body = document.getElementById('chatBody');
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  body.innerHTML = d.messages.map(m=>m.mine?`
    <div class="msg me">
      <span class="avatar" style="background:var(--leaf);color:#fff">私</span>
      <div><p class="meta">あなた ・ ${m.time}</p><div class="bubble">${esc(m.body)}</div></div>
    </div>`:`
    <div class="msg">
      <span class="avatar" style="background:${m.bg};color:${m.fg}">${esc(m.avatar)}</span>
      <div><p class="meta">${esc(m.who)} ・ ${m.time}</p><div class="bubble">${esc(m.body)}</div></div>
    </div>`).join('');
  if(nearBottom || true) body.scrollTop = body.scrollHeight;

  const canPost = d.perm==='post';
  document.getElementById('chatInputRow').style.display = canPost ? 'flex' : 'none';
  const ro = document.getElementById('chatReadonly');
  ro.style.display = canPost ? 'none' : 'block';
  if(!canPost){
    ro.textContent = currentCh==='en'
      ? '🔒 園チャットは閲覧専用です。投稿できるのは管理者（園長・主任）のみです。'
      : '🔒 このグループは閲覧専用です。園への連絡は「個人チャット」をご利用ください。';
  }
}
async function sendMsg(){
  const inp = document.getElementById('chatInput');
  const body = inp.value.trim();
  if(!body || !currentCh) return;
  inp.value = '';
  try{
    await api(`/channels/${currentCh}/messages`, {method:'POST', body:JSON.stringify({body})});
    await loadMessages();
  }catch(e){ alert(e.message); inp.value = body; }
}

/* ================================================================
   午睡チェック
================================================================ */
const quickMemos = ['鼻血','咳','鼻水','嘔吐','発熱ぎみ','寝つき悪い'];
function renderGosui(){
  const g = document.getElementById('gosuiGrid');
  g.innerHTML = CHILDREN.map(k=>`
    <div class="kid-card ${k.sleeping?'sleeping':''} ${k.memo?'memo-flag':''}">
      <div class="kid-head">
        <span class="avatar">${k.emoji}</span>
        <div><b>${esc(k.name)}</b><small>${esc(k.age_label)}${k.sleeping?` ・ ${k.since}〜就寝中`:''}</small></div>
      </div>
      <button class="sleep-toggle ${k.sleeping?'sleep':'awake'}" onclick="toggleSleep(${k.id})">
        ${k.sleeping?'😴 睡眠中 → タップで起床':'☀️ 起床 → タップで就寝'}
      </button>
      <button class="memo-btn ${k.memo?'has':''}" onclick="toggleMemoBox(${k.id})">
        ${k.memo?`📝 ${esc(k.memo.length>14?k.memo.slice(0,14)+'…':k.memo)}`:'＋ メモを書く（鼻血・咳など）'}
      </button>
      <div class="memo-area ${memoOpen[k.id]?'open':''}">
        <textarea id="memoTxt${k.id}" placeholder="例）13:05 鼻血。5分で止血、様子見。">${esc(k.memo)}</textarea>
        <div class="quick">
          ${quickMemos.map(q=>`<button onclick="quickMemo(${k.id},'${q}')">${q}</button>`).join('')}
        </div>
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px">
          <button class="mini" onclick="saveMemo(${k.id},true)">クリア</button>
          <button class="mini approve" onclick="saveMemo(${k.id})">保存</button>
        </div>
      </div>
      <div class="kid-foot">
        <span>最終チェック ${k.last_check||'--:--'}</span>
        <span style="color:var(--leaf);font-weight:700">✓ 記録済</span>
      </div>
    </div>`).join('');
  document.getElementById('cntSleep').textContent = CHILDREN.filter(k=>k.sleeping).length;
  document.getElementById('cntAwake').textContent = CHILDREN.filter(k=>!k.sleeping).length;
  document.getElementById('cntMemo').textContent = CHILDREN.filter(k=>k.memo).length;
}
async function toggleSleep(cid){
  const d = await api(`/nap/${cid}/toggle`, {method:'POST'});
  const k = CHILDREN.find(c=>c.id===cid);
  Object.assign(k, d.nap);
  renderGosui(); renderHome();
}
function toggleMemoBox(cid){ memoOpen[cid] = !memoOpen[cid]; renderGosui(); }
function quickMemo(cid, word){
  const ta = document.getElementById('memoTxt'+cid);
  ta.value = (ta.value ? ta.value + ' / ' : '') + `${nowStr()} ${word}`;
  ta.focus();
}
async function saveMemo(cid, clear){
  const memo = clear ? '' : document.getElementById('memoTxt'+cid).value.trim();
  const d = await api(`/nap/${cid}/memo`, {method:'POST', body:JSON.stringify({memo})});
  const k = CHILDREN.find(c=>c.id===cid);
  Object.assign(k, d.nap);
  memoOpen[cid] = false;
  renderGosui();
}

/* ================================================================
   発達チェック
================================================================ */
function renderDevList(){
  const box = document.getElementById('devList');
  if(ME.role==='parent'){
    /* 保護者は自児（デモ: さくら）のみ */
    box.innerHTML = '';
    return;
  }
  box.innerHTML = CHILDREN.map(k=>`
    <button class="dev-kid ${k.id===currentKid?'on':''} ${k.late?'late':''}" onclick="openKid(${k.id})">
      <span style="font-size:1.4rem">${k.emoji}</span>
      <span><b>${esc(k.name)}</b><small>${esc(k.age_label)} ・ 次回 ${esc(k.next_check)}</small></span>
      ${k.late?'<span class="flag">未実施!</span>':''}
    </button>`).join('');
}
async function openKid(cid){
  currentKid = cid;
  const k = CHILDREN.find(c=>c.id===cid);
  if(!k) return;
  const d = await api(`/dev/${cid}`);
  DEV_RESULTS = d.results;
  document.getElementById('devKidName').textContent = `${k.name} さん ─ ${k.age_label}`;
  document.getElementById('devKidSub').textContent = `次回チェック予定: ${k.next_check}`;
  document.getElementById('devNote').value = d.note || '';
  document.getElementById('devSaved').textContent = '';
  renderDevList();
  renderDevItems();
}
function renderDevItems(){
  const box = document.getElementById('devItems');
  const ro = ME.role==='parent';
  box.innerHTML = DEV_ITEMS.map(it=>{
    const cur = DEV_RESULTS[String(it.id)] || '';
    const seg = [['確認できた',''],['一部','part'],['未確認','no']].map(([label,cls])=>`
      <button class="${cur===label?('on '+cls):''}" ${ro?'disabled':''}
        onclick="setDev(${it.id},'${label}')">${label}</button>`).join('');
    return `
    <div class="check-item">
      <div><p>${esc(it.label)}</p><small>${esc(it.category)}</small></div>
      <div class="seg">${seg}</div>
    </div>`;
  }).join('');
}
async function setDev(itemId, result){
  if(ME.role==='parent') return;
  await api(`/dev/${currentKid}`, {method:'POST', body:JSON.stringify({item_id:itemId, result})});
  DEV_RESULTS[String(itemId)] = result;
  renderDevItems();
}
async function saveDevNote(){
  await api(`/dev/${currentKid}`, {method:'POST',
    body:JSON.stringify({note: document.getElementById('devNote').value})});
  const mark = document.getElementById('devSaved');
  mark.textContent = '✓ 保存しました';
  setTimeout(()=>mark.textContent='', 2000);
}

/* ================================================================
   身体記録
================================================================ */
let SH_KID = null;        // 選択中の園児ID
let SH_DATA = null;       // /api/physical/<id> のレスポンス
let SH_TYPE = 'height';   // グラフ表示: 'height' / 'weight'
let SH_CONFIRMED = {};    // ユーザーが個別に承諾した確認 {range:true, overwrite:true}
let SERVER_TODAY = null;  // サーバ日付（bootstrap / physical APIから取得）
const SH_STD = {};        // 成長曲線基準値キャッシュ {'M:height': [...]}

function todayStr(){
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}
function serverToday(){ return SERVER_TODAY || todayStr(); }

/* 入力値が変わったら、承諾済みの確認を無効化する（値が変わった以上、再確認が必要） */
function shResetConfirm(){ SH_CONFIRMED = {}; hideShWarn(); }

/* 発達チェック画面から同じ園児の成長グラフへ遷移する */
async function openShintaiFromDev(){
  if(currentKid) await openShintaiKid(currentKid);
  go('shintai');
}

function renderShintaiList(){
  const box = document.getElementById('shList');
  box.innerHTML = CHILDREN.map(k=>`
    <button class="dev-kid ${k.id===SH_KID?'on':''}" onclick="openShintaiKid(${k.id})">
      <span style="font-size:1.4rem">${k.emoji}</span>
      <span><b>${esc(k.name)}</b><small>${esc(k.age_label)} ・ 前回 ${k.last_measured ? esc(k.last_measured.slice(5).replace('-','/')) : 'なし'}</small></span>
      ${k.last_measured===serverToday() ? '<span class="sh-done">✓ 本日入力済</span>' : ''}
    </button>`).join('');
}

async function openShintaiKid(cid){
  SH_KID = cid;
  shResetConfirm();
  document.getElementById('shErr').textContent = '';
  document.getElementById('shSaved').textContent = '';
  SH_DATA = await api('/physical/' + cid);
  if(SH_DATA.today) SERVER_TODAY = SH_DATA.today;
  const c = SH_DATA.child;
  document.getElementById('shKidName').textContent = `${c.name} さん ─ ${c.age_label}`;
  document.getElementById('shKidSub').textContent = c.birth_date ? `生年月日: ${c.birth_date}` : '生年月日が未登録です';
  document.getElementById('shDate').value = serverToday();
  document.getElementById('shHeight').value = '';
  document.getElementById('shWeight').value = '';
  const last = SH_DATA.records[SH_DATA.records.length - 1];
  document.getElementById('shPrev').textContent = last
    ? `前回測定: ${last.measured_on} ／ 身長 ${last.height_cm} cm ／ 体重 ${last.weight_kg} kg`
    : '前回の測定記録はありません。';
  renderShintaiList();
  await renderGrowthChart();
  renderShintaiTable();
}

function renderShintaiTable(){
  const body = document.getElementById('shTableBody');
  const recs = [...SH_DATA.records].reverse();
  body.innerHTML = recs.length ? recs.map(r=>`
    <tr>
      <td>${esc(r.measured_on)}</td>
      <td>${r.age_m!=null ? r.age_m + 'ヶ月' : '─'}</td>
      <td>${r.height_cm} cm</td>
      <td>${r.weight_kg} kg</td>
      <td>${esc(r.recorded_by)}</td>
    </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--cocoa-soft)">記録がまだありません</td></tr>';
}

function hideShWarn(){ document.getElementById('shWarn').style.display = 'none'; SH_PENDING = null; }

let SH_PENDING = null;    // いま警告表示中の確認種別（'range' / 'overwrite'）

/* 警告ボックスの「このまま登録する」: 表示中の確認種別だけを承諾して再送信する */
function confirmShWarn(){
  if(SH_PENDING) SH_CONFIRMED[SH_PENDING] = true;
  hideShWarn();
  saveShintai();
}

async function saveShintai(){
  const err = document.getElementById('shErr');
  const saved = document.getElementById('shSaved');
  err.textContent = ''; saved.textContent = '';
  const payload = {
    measured_on: document.getElementById('shDate').value,
    height_cm:  document.getElementById('shHeight').value,
    weight_kg:  document.getElementById('shWeight').value,
  };
  // 承諾済みの確認種別のみフラグを付ける（範囲外の承諾が上書き確認を兼ねないようにする）
  if(SH_CONFIRMED.range) payload.confirm_range = true;
  if(SH_CONFIRMED.overwrite) payload.confirm_overwrite = true;
  try{
    const d = await api('/physical/' + SH_KID, {method:'POST', body: JSON.stringify(payload)});
    if(d.confirm){
      // 範囲外警告・上書き確認: 種別ごとにインラインで確認してから再送信する
      SH_PENDING = d.confirm;
      document.getElementById('shWarnMsg').textContent = d.message;
      document.getElementById('shWarn').style.display = 'flex';
      return;
    }
    SH_CONFIRMED = {};
    SH_DATA.records = d.records;
    saved.textContent = '✓ 身体測定記録を登録しました';
    setTimeout(()=>saved.textContent='', 2500);
    document.getElementById('shHeight').value = '';
    document.getElementById('shWeight').value = '';
    const last = SH_DATA.records[SH_DATA.records.length - 1];
    if(last) document.getElementById('shPrev').textContent =
      `前回測定: ${last.measured_on} ／ 身長 ${last.height_cm} cm ／ 体重 ${last.weight_kg} kg`;
    const k = CHILDREN.find(c=>c.id===SH_KID);
    if(k && (!k.last_measured || payload.measured_on > k.last_measured)) k.last_measured = payload.measured_on;
    renderShintaiList();
    await renderGrowthChart();
    renderShintaiTable();
  }catch(e){ err.textContent = e.message; }
}

async function setShType(t){
  SH_TYPE = t;
  document.getElementById('shTabH').classList.toggle('on', t==='height');
  document.getElementById('shTabW').classList.toggle('on', t==='weight');
  await renderGrowthChart();
}

async function loadStandards(sex, type){
  const key = sex + ':' + type;
  if(!SH_STD[key]){
    const d = await api(`/growth_standards?sex=${sex}&type=${type}`);
    SH_STD[key] = d.standards;
  }
  return SH_STD[key];
}

async function renderGrowthChart(){
  const svg = document.getElementById('shChart');
  const c = SH_DATA.child;
  if(!c.birth_date){
    svg.innerHTML = '<text x="300" y="140" text-anchor="middle" font-size="14" fill="#8A7A64">生年月日が未登録のためグラフを表示できません</text>';
    return;
  }
  const unit = SH_TYPE==='height' ? 'cm' : 'kg';
  const val = r => SH_TYPE==='height' ? r.height_cm : r.weight_kg;
  const std = await loadStandards(c.sex, SH_TYPE);
  const byAge = {};   // {月齢: {3:v, 50:v, 97:v}}
  std.forEach(s=>{ (byAge[s.age_in_months] = byAge[s.age_in_months] || {})[s.percentile] = s.value; });

  const recs = SH_DATA.records.filter(r=>r.age_m!=null);
  const ages = recs.map(r=>r.age_m);
  let xmin = recs.length ? Math.max(0, Math.min(...ages)-2) : 0;
  let xmax = recs.length ? Math.max(...ages)+2 : 36;
  if(xmax - xmin < 6) xmax = xmin + 6;
  xmax = Math.min(xmax, 36);

  const stdAges = Object.keys(byAge).map(Number).filter(m=>m>=xmin && m<=xmax).sort((a,b)=>a-b);
  const allVals = [
    ...stdAges.map(m=>byAge[m][3]), ...stdAges.map(m=>byAge[m][97]),
    ...recs.map(val),
  ];
  let ymin = Math.min(...allVals), ymax = Math.max(...allVals);
  const pad = (ymax - ymin) * 0.12 || 1;
  ymin -= pad; ymax += pad;

  // 描画領域
  const L=52, R=588, T=16, B=244;
  const X = m => L + (m - xmin) / (xmax - xmin) * (R - L);
  const Y = v => B - (v - ymin) / (ymax - ymin) * (B - T);

  let out = '';
  // Y軸グリッドとラベル
  const ystep = (ymax - ymin) / 4;
  for(let i=0;i<=4;i++){
    const v = ymin + ystep*i, y = Y(v);
    out += `<line x1="${L}" y1="${y}" x2="${R}" y2="${y}" stroke="#EBDFC2" stroke-width="1"/>`;
    out += `<text x="${L-6}" y="${y+4}" text-anchor="end" font-size="10" fill="#8A7A64">${v.toFixed(SH_TYPE==='height'?0:1)}</text>`;
  }
  // X軸ラベル（3ヶ月刻み）
  for(let m=Math.ceil(xmin/3)*3; m<=xmax; m+=3){
    out += `<text x="${X(m)}" y="${B+18}" text-anchor="middle" font-size="10" fill="#8A7A64">${m}ヶ月</text>`;
  }
  out += `<text x="${L}" y="${T-2}" font-size="10" fill="#8A7A64">${unit}</text>`;

  if(stdAges.length){
    // 3〜97パーセンタイル帯
    const band = stdAges.map(m=>`${X(m)},${Y(byAge[m][97])}`).join(' ') + ' ' +
                 [...stdAges].reverse().map(m=>`${X(m)},${Y(byAge[m][3])}`).join(' ');
    out += `<polygon points="${band}" fill="#F2B33D" opacity=".16"/>`;
    // 50パーセンタイル
    out += `<polyline points="${stdAges.map(m=>`${X(m)},${Y(byAge[m][50])}`).join(' ')}" stroke="#D99B1F" stroke-width="2" fill="none" stroke-dasharray="6 5"/>`;
    const lm = stdAges[stdAges.length-1];
    out += `<text x="${X(lm)-4}" y="${Y(byAge[lm][50])-8}" text-anchor="end" font-size="10" fill="#8A7A64">50パーセンタイル</text>`;
    out += `<text x="${X(lm)-4}" y="${Y(byAge[lm][97])-6}" text-anchor="end" font-size="9" fill="#C9A85C">97</text>`;
    out += `<text x="${X(lm)-4}" y="${Y(byAge[lm][3])+12}" text-anchor="end" font-size="9" fill="#C9A85C">3</text>`;
  }
  if(recs.length){
    out += `<polyline points="${recs.map(r=>`${X(r.age_m)},${Y(val(r))}`).join(' ')}" stroke="#4A3B2A" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    recs.forEach(r=>{
      out += `<circle cx="${X(r.age_m)}" cy="${Y(val(r))}" r="5.5" fill="#E58A6E"><title>${r.measured_on}: ${val(r)} ${unit}</title></circle>`;
    });
    const lr = recs[recs.length-1];
    out += `<text x="${X(lr.age_m)+9}" y="${Y(val(lr))+4}" font-size="11" font-weight="bold" fill="#4A3B2A">${val(lr)} ${unit}</text>`;
  } else {
    out += `<text x="300" y="130" text-anchor="middle" font-size="13" fill="#8A7A64">測定記録がまだありません</text>`;
  }
  svg.innerHTML = out;
}

/* ================================================================
   ポーリング: 他の端末の更新を数秒おきに反映（チャット・午睡）
================================================================ */
setInterval(async ()=>{
  if(!ME || document.visibilityState!=='visible') return;
  try{
    if(currentPage==='chat') await loadMessages();
    if(currentPage==='gosui'){
      const d = await api('/bootstrap');
      CHILDREN = d.children;
      renderGosui();
    }
  }catch(e){}
}, 4000);

/* ===== チェック間隔タイマー(表示用デモ) ===== */
let sec = 600;
setInterval(()=>{
  sec = sec>0 ? sec-1 : 600;
  const el = document.getElementById('timer');
  if(el) el.textContent = `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
},1000);

/* ===== 起動時: セッションが残っていれば自動ログイン ===== */
(async ()=>{
  try{ await api('/me'); await enterApp(); }
  catch(e){ /* 未ログイン → ログイン画面のまま */ }
})();
