const $ = (id) => document.getElementById(id);
const DB_NAME = 'mantar-dedektifi-db';
const DB_VERSION = 1;
let db;
let pendingFiles = [];
let pendingAnalysis = null;
let pendingLocation = null;
let records = [];
let mapInstance = null;
let mapMarkers = [];
let toastTimer;

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function esc(value='') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore('records', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
function tx(mode='readonly') { return db.transaction('records', mode).objectStore('records'); }
function dbGetAll() { return new Promise((resolve,reject)=>{const r=tx().getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);}); }
function dbPut(value) { return new Promise((resolve,reject)=>{const r=tx('readwrite').put(value);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);}); }
function dbDelete(id) { return new Promise((resolve,reject)=>{const r=tx('readwrite').delete(id);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);}); }
function dateLabel(value) { return new Intl.DateTimeFormat('tr-TR',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)); }
function firstName(record) { return record.analysis?.candidates?.[0]?.common_name || 'Tanımlanamayan örnek'; }
function fileToBlob(file) { return file.slice(0, file.size, file.type); }

let supabaseClient = null;
let authUser = null;
let accountAuthEnabled = false;
let accountAuthMode = 'login';

function showAccountOverlay(show) {
  $('loginOverlay').classList.toggle('hidden', !show);
}
function setAccountSession(session) {
  authUser = session && session.user ? session.user : null;
  if (authUser) {
    showAccountOverlay(false);
    $('accountBar').classList.remove('hidden');
    $('accountIdentity').textContent = authUser.email || 'Hesabım';
  } else if (accountAuthEnabled) {
    $('accountBar').classList.add('hidden');
    showAccountOverlay(true);
  }
}
function renderAccountAuthMode() {
  const signup = accountAuthMode === 'signup';
  $('accountAuthTitle').textContent = signup ? 'Yeni hesap oluştur' : 'Hesabına giriş yap';
  $('accountAuthDescription').textContent = signup
    ? 'E-postanı doğrula ve keşiflerini hesabında sakla.'
    : 'Keşiflerine farklı cihazlardan güvenle eriş.';
  $('accountAuthSubmit').textContent = signup ? 'Hesap oluştur' : 'Giriş yap';
  $('accountAuthToggle').textContent = signup ? 'Zaten hesabım var' : 'Yeni hesap oluştur';
  $('accountForgotPassword').classList.toggle('hidden', signup);
  $('accountPasswordInput').autocomplete = signup ? 'new-password' : 'current-password';
  $('accountAuthMessage').textContent = '';
  $('accountAuthForm').classList.remove('hidden');
  $('accountRecoveryForm').classList.add('hidden');
}
async function checkSession() {
  try {
    const configResponse = await fetch('/api/config');
    if (!configResponse.ok) throw new Error('Uygulama yapılandırması alınamadı.');
    const config = await configResponse.json();
    if (config.accountAuthEnabled) {
      accountAuthEnabled = true;
      if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        throw new Error('Hesap servisi yüklenemedi. Sayfayı yenileyip tekrar dene.');
      }
      supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const result = await supabaseClient.auth.getSession();
      if (result.error) throw result.error;
      setAccountSession(result.data.session);
      renderAccountAuthMode();
      supabaseClient.auth.onAuthStateChange((event, session) => {
        setAccountSession(session);
        if (event === 'PASSWORD_RECOVERY') {
          $('accountAuthTitle').textContent = 'Yeni parola belirle';
          $('accountAuthDescription').textContent = 'Hesabın için yeni ve güçlü bir parola seç.';
          $('accountAuthForm').classList.add('hidden');
          document.querySelector('.auth-actions').classList.add('hidden');
          $('accountRecoveryForm').classList.remove('hidden');
          showAccountOverlay(true);
        }
        if (event === 'SIGNED_OUT') {
          $('accountAuthMessage').textContent = 'Oturum kapatıldı.';
        }
      });
      return;
    }
    const response = await fetch('/api/session');
    const session = await response.json();
    $('legacyAuthPanel').classList.toggle('hidden', !session.passwordRequired || session.authenticated);
    $('supabaseAuthPanel').classList.add('hidden');
    showAccountOverlay(session.passwordRequired && !session.authenticated);
  } catch (error) {
    $('supabaseAuthPanel').classList.toggle('hidden', !accountAuthEnabled);
    $('legacyAuthPanel').classList.toggle('hidden', accountAuthEnabled);
    showAccountOverlay(true);
    if (accountAuthEnabled) $('accountAuthMessage').textContent = error.message || 'Hesap sistemine ulaşılamadı.';
    else $('loginError').textContent = error.message || 'Giriş servisine ulaşılamadı.';
  }
}
$('accountAuthToggle').addEventListener('click', () => {
  accountAuthMode = accountAuthMode === 'login' ? 'signup' : 'login';
  renderAccountAuthMode();
});
$('accountAuthForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('accountAuthMessage').textContent = '';
  const email = $('accountEmailInput').value.trim();
  const password = $('accountPasswordInput').value;
  try {
    let result;
    if (accountAuthMode === 'signup') {
      result = await supabaseClient.auth.signUp({
        email, password,
        options: { emailRedirectTo: window.location.origin }
      });
      if (result.error) throw result.error;
      if (result.data.session) {
        setAccountSession(result.data.session);
        if (db) await syncCloudRecords(true);
      } else {
        $('accountAuthMessage').textContent = 'Kayıt talebin alındı. E-posta adresine gelen doğrulama bağlantısına tıkla.';
      }
    } else {
      result = await supabaseClient.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      setAccountSession(result.data.session);
      if (db) await syncCloudRecords(true);
      toast('Hesabına giriş yapıldı.');
    }
  } catch (error) {
    $('accountAuthMessage').textContent = error.message || 'İşlem tamamlanamadı.';
  }
});
$('accountForgotPassword').addEventListener('click', async () => {
  const email = $('accountEmailInput').value.trim();
  if (!email) {
    $('accountAuthMessage').textContent = 'Önce e-posta adresini yaz.';
    return;
  }
  try {
    const result = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });
    if (result.error) throw result.error;
    $('accountAuthMessage').textContent = 'Parola yenileme bağlantısı e-posta adresine gönderildi.';
  } catch (error) {
    $('accountAuthMessage').textContent = error.message || 'Parola yenileme isteği gönderilemedi.';
  }
});
$('accountRecoveryForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const result = await supabaseClient.auth.updateUser({ password: $('accountNewPassword').value });
    if (result.error) throw result.error;
    $('accountAuthMessage').textContent = 'Parolan güncellendi. Şimdi yeni parolanla giriş yapabilirsin.';
    $('accountNewPassword').value = '';
    await supabaseClient.auth.signOut();
    document.querySelector('.auth-actions').classList.remove('hidden');
    accountAuthMode = 'login';
    renderAccountAuthMode();
  } catch (error) {
    $('accountAuthMessage').textContent = error.message || 'Parola güncellenemedi.';
  }
});
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('loginError').textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('appPassword').value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Giriş başarısız.');
    showAccountOverlay(false);
    $('appPassword').value = '';
    toast('Giriş yapıldı.');
  } catch (error) {
    $('loginError').textContent = error.message;
  }
});
$('accountLogout').addEventListener('click', async () => {
  if (!supabaseClient) return;
  const result = await supabaseClient.auth.signOut();
  if (result.error) toast('Oturum kapatılamadı: ' + result.error.message);
});
$('cloudSyncButton').addEventListener('click', () => syncCloudRecords(true));

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  ['analyze','map','records','stats','encyclopedia'].forEach(name=>$(name+'View').classList.toggle('hidden',name!==tab));
  if(tab==='map') setTimeout(renderMap,80);
  if(tab==='records') renderRecords();
  if(tab==='stats') renderStats();
}
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
$('encyclopediaSearch').addEventListener('input',()=>{const q=$('encyclopediaSearch').value.trim().toLocaleLowerCase('tr-TR');document.querySelectorAll('.guide-card').forEach(card=>card.classList.toggle('hidden',!card.textContent.toLocaleLowerCase('tr-TR').includes(q)));});

function addFiles(list) {
  const incoming = [...list];
  for (const file of incoming) {
    if (!file.type.startsWith('image/')) continue;
    if (pendingFiles.length >= 5) { toast('En fazla 5 fotoğraf ekleyebilirsin.'); break; }
    if (file.size > 8*1024*1024) { toast(`${file.name}: 8 MB sınırını aşıyor.`); continue; }
    if (!['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(file.type)) { toast('JPG, PNG, WebP veya iPhone HEIC/HEIF fotoğrafı kullan.'); continue; }
    pendingFiles.push(file);
  }
  renderPhotoGrid();
}
$('galleryInput').addEventListener('change', e=>{addFiles(e.target.files);e.target.value='';});
$('cameraInput').addEventListener('change', e=>{addFiles(e.target.files);e.target.value='';});
function renderPhotoGrid() {
  $('photoCount').textContent=pendingFiles.length;
  $('photoGrid').innerHTML='';
  if(!pendingFiles.length){$('photoGrid').innerHTML='<div class="empty-photo"><span>＋</span><b>Fotoğraf bekleniyor</b><small>En az iki farklı açı ekle</small></div>';}
  pendingFiles.forEach((file,i)=>{
    const url=URL.createObjectURL(file);
    const tile=document.createElement('div');tile.className='photo-tile';
    tile.innerHTML=`<img alt="Mantar fotoğrafı ${i+1}" src="${url}"><span class="photo-index">${i+1}</span><button class="remove-photo" aria-label="Fotoğrafı sil">×</button>`;
    tile.querySelector('button').addEventListener('click',()=>{pendingFiles.splice(i,1);renderPhotoGrid();});
    $('photoGrid').append(tile);
  });
  const ready=pendingFiles.length>=2;
  $('analyzeBtn').disabled=!ready;
  $('analysisHint').textContent=ready?'Analiz için hazır. GPS koordinatları fotoğraf analizine gönderilmez.':'Devam etmek için en az 2 fotoğraf ekle.';
}

$('getLocationBtn').addEventListener('click',()=>{
  if(!navigator.geolocation){toast('Bu tarayıcı konum özelliğini desteklemiyor.');return;}
  $('getLocationBtn').disabled=true;$('getLocationBtn').textContent='Alınıyor…';
  navigator.geolocation.getCurrentPosition(pos=>{
    pendingLocation={lat:pos.coords.latitude,lon:pos.coords.longitude,accuracy:pos.coords.accuracy};
    $('locationTitle').textContent='Konum hazır';
    $('locationText').textContent=`Yaklaşık doğruluk: ${Math.round(pos.coords.accuracy)} m · Yalnızca bu telefonda saklanır.`;
    $('getLocationBtn').textContent='Konumu yenile';$('getLocationBtn').disabled=false;
    toast('Konum bu keşfe eklenecek.');
  },err=>{
    const reason=err.code===1?'Konum izni verilmedi.':err.code===2?'Konum bulunamadı.':'Konum isteği zaman aşımına uğradı.';
    toast(reason);$('getLocationBtn').disabled=false;$('getLocationBtn').textContent='Tekrar dene';
  },{enableHighAccuracy:true,timeout:15000,maximumAge:30000});
});

function selectedSource(){return document.querySelector('input[name="source"]:checked')?.value||'wild';}
document.querySelectorAll('input[name="source"]').forEach(input=>input.addEventListener('change',()=>{
  document.querySelectorAll('.source-choice').forEach(el=>el.classList.toggle('selected',el.querySelector('input').checked));
}));

$('analyzeBtn').addEventListener('click', analyze);
async function analyze(){
  if(pendingFiles.length<2){toast('En az 2 fotoğraf gerekiyor.');return;}
  const fd=new FormData();pendingFiles.forEach(file=>fd.append('photos',file,file.name));fd.append('source',selectedSource());
  $('loading').classList.remove('hidden');$('resultPanel').classList.add('hidden');$('analyzeBtn').disabled=true;
  try{
    const response=await fetch('/api/analyze',{method:'POST',body:fd});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Analiz başarısız.');
    pendingAnalysis=data.result;renderResult(data.result);
    $('resultPanel').classList.remove('hidden');
    $('resultPanel').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(err){toast(err.message||'Bağlantı hatası.');}
  finally{$('loading').classList.add('hidden');$('analyzeBtn').disabled=pendingFiles.length<2;}
}
function renderResult(result){
  const candidates=Array.isArray(result.candidates)?result.candidates:[];
  const confidenceLabel=value=>({low:'Düşük',medium:'Orta',high:'Yüksek'}[(value||'low').toLowerCase()]||'Belirsiz');
  const candidatesHtml=candidates.length?candidates.map((candidate,index)=>{
    const reasons=Array.isArray(candidate.reasons)?candidate.reasons:[];
    const lookalikes=Array.isArray(candidate.lookalikes)?candidate.lookalikes:[];
    return `<article class="candidate">
      <div class="candidate-topline"><span class="candidate-number">Aday ${index+1}</span><span class="confidence confidence-${esc((candidate.confidence||'low').toLowerCase())}">Görsel benzerlik: ${esc(confidenceLabel(candidate.confidence))}</span></div>
      <b>${esc(candidate.common_name||'Olası tür belirtilmedi')}</b>
      <em>${esc(candidate.scientific_name||'Bilimsel ad belirsiz')}</em>
      ${reasons.length?`<h5>Bu adayı düşündüren özellikler</h5><ul class="feature-list">${reasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul>`:''}
      ${lookalikes.length?`<p><strong>Karıştırılabileceği türler:</strong> ${lookalikes.map(esc).join(', ')}</p>`:''}
    </article>`;
  }).join(''):'<p class="microcopy">Fotoğraflardan güvenilir bir tür adayı çıkarılamadı. Daha net ve farklı açılardan fotoğraflar eklemeyi dene.</p>';
  const f=result.visible_features||{};
  const features=[['Şapka',f.cap],['Alt yüzey',f.underside],['Sap',f.stem],['Sap tabanı',f.base],['Habitat ipuçları',f.habitat_clues]].filter(x=>x[1]&&String(x[1]).trim());
  const missing=Array.isArray(result.missing_views)?result.missing_views:[];
  const risks=Array.isArray(result.risk_notes)?result.risk_notes:[];
  $('resultPanel').innerHTML=`<div class="result-head"><span>FOTOĞRAFLI ÖN İNCELEME</span><h3>${result.is_mushroom?'Mantar örneği incelendi':'Mantar olduğu doğrulanamadı'}</h3><p>${esc(result.summary||'Fotoğraflar incelendi; sonuçlar kesin teşhis değildir.')}</p></div><div class="result-body">
    <div class="analysis-notice"><strong>Önemli:</strong> Aşağıdaki adaylar yalnızca fotoğraflardaki görsel benzerliğe dayanır; güven etiketi tür teşhisinin doğruluğunu veya yenilebilirliği göstermez.</div>
    <h4>Olası tür adayları</h4>${candidatesHtml}
    ${features.length?`<h4>Fotoğraflarda görülen özellikler</h4><ul class="feature-list">${features.map(([label,value])=>`<li><b>${esc(label)}:</b> ${esc(value)}</li>`).join('')}</ul>`:''}
    ${missing.length?`<section class="analysis-section"><h4>Eksik fotoğraf açıları</h4><p>Bu görüntüler değerlendirmeyi iyileştirebilir:</p><ul class="feature-list">${missing.map(view=>`<li>${esc(view)}</li>`).join('')}</ul></section>`:''}
    <div class="safety-lock"><b>⚠ TÜKETİM GÜVENLİĞİ DOĞRULANMADI</b><br>Fotoğraftan mantarın yenilebilir olduğu belirlenemez. Yabani mantarı tüketme; şüpheli örneği yetkin bir uzmana yerinde doğrulat.${risks.length?`<br><br>${risks.map(esc).join('<br>')}`:''}</div>
    ${selectedSource()==='packaged'?`<h4>Kültür mantarı için genel tarif</h4><div class="candidate"><b>Sarımsaklı tereyağında sote</b><p>Yalnızca güvenilir ambalajlı, marketten alınmış kültür mantarı için: temizleyip dilimle. Tavada tereyağıyla sotele; sarımsak, tuz, karabiber ve maydanoz ekleyip iyice pişir.</p></div>`:''}
    <div class="result-actions"><button id="saveRecordBtn" class="button primary">Keşfi kaydet</button><button id="newAnalysisBtn" class="button secondary">Yeni analiz</button></div></div>`;
  $('saveRecordBtn').addEventListener('click',saveRecord);$('newAnalysisBtn').addEventListener('click',()=>{$('resultPanel').classList.add('hidden');pendingAnalysis=null;pendingFiles=[];pendingLocation=null;$('locationTitle').textContent='Konum eklenmedi';$('locationText').textContent='GPS yalnızca sen istediğinde alınır ve analiz servisine gönderilmez.';$('getLocationBtn').textContent='Konum ekle';renderPhotoGrid();window.scrollTo({top:0,behavior:'smooth'});});
}
async function saveRecord(){
  if(!pendingAnalysis){toast('Önce fotoğraf analizi yapmalısın.');return;}
  const record={id:crypto.randomUUID(),createdAt:new Date().toISOString(),source:selectedSource(),analysis:pendingAnalysis,photos:pendingFiles.map(fileToBlob),location:pendingLocation?{...pendingLocation}:null};
  try{await dbPut(record);records=await dbGetAll();updateCounts();renderRecords();toast('Keşif bu telefona kaydedildi.');switchTab('records');}
  catch{toast('Kayıt saklanamadı. iPhone depolama alanını kontrol et.');}
}

function recordCard(record){
  const img=record.photos?.[0]?URL.createObjectURL(record.photos[0]):'';
  const card=document.createElement('article');card.className='record-card';
  const loc=record.location?'Konum kayıtlı':'Konum yok';
  card.innerHTML=`<img class="record-thumb" alt="Keşif fotoğrafı" src="${img}"><div class="record-main"><b>${esc(firstName(record))}</b><small>${dateLabel(record.createdAt)} · ${loc}</small><span class="record-chip">${record.source==='packaged'?'Kültür mantarı':'Yabani örnek · tüketim onayı yok'}</span>${record.note?`<p class="record-note">${esc(record.note)}</p>`:''}</div><div class="record-actions"><button class="tiny-action open-record">Aç</button><button class="tiny-action share-record">Paylaş</button></div>`;
  card.querySelector('.open-record').addEventListener('click',()=>showDetail(record.id));
  card.querySelector('.share-record').addEventListener('click',()=>shareLocation(record.id));
  return card;
}
function renderRecords(){
  const query=($('recordSearch')?.value||'').trim().toLocaleLowerCase('tr-TR');
  const filter=$('speciesFilter')?.value||'all';
  const species=[...new Set(records.map(firstName))].sort((a,b)=>a.localeCompare(b,'tr'));
  const sel=$('speciesFilter');if(sel){const prior=sel.value;sel.innerHTML='<option value="all">Tüm türler</option>'+species.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');if(species.includes(prior))sel.value=prior;}
  const filtered=records.filter(r=>{
    const text=[firstName(r),r.analysis?.summary,r.analysis?.candidates?.[0]?.scientific_name,r.note].join(' ').toLocaleLowerCase('tr-TR');
    return (!query||text.includes(query))&&(filter==='all'||firstName(r)===filter);
  });
  const sort=$('recordSort')?.value||'newest';
  filtered.sort((a,b)=>sort==='oldest'?a.createdAt.localeCompare(b.createdAt):sort==='name'?firstName(a).localeCompare(firstName(b),'tr'):b.createdAt.localeCompare(a.createdAt));
  $('recordsList').innerHTML='';
  if(!filtered.length){$('recordsList').innerHTML='<div class="empty-state panel"><span>🍄</span><b>Gösterilecek keşif yok</b><small>Filtreyi değiştir veya yeni kayıt ekle.</small></div>';}
  filtered.forEach(r=>$('recordsList').append(recordCard(r)));
  $('recordsTotal').textContent=`${records.length} kayıt`;
}
$('recordSearch').addEventListener('input',renderRecords);$('speciesFilter').addEventListener('change',renderRecords);$('recordSort').addEventListener('change',renderRecords);

function blobToDataUrl(blob){
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
}
function dataUrlToBlob(dataUrl){
  if(typeof dataUrl!=='string'||!dataUrl.startsWith('data:image/'))throw new Error('Yedekte geçersiz fotoğraf verisi var.');
  const [header,data]=dataUrl.split(',');
  const mime=header.match(/data:(.*?);base64/)?.[1]||'image/jpeg';
  const binary=atob(data);const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new Blob([bytes],{type:mime});
}
$('exportRecordsBtn').addEventListener('click',async()=>{
  try{
    const payload={app:'Mantar Dedektifi',formatVersion:1,exportedAt:new Date().toISOString(),records:[]};
    for(const r of records){
      payload.records.push({...r,photos:await Promise.all((r.photos||[]).map(blobToDataUrl))});
    }
    const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`mantar-dedektifi-yedek-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
    toast(`${records.length} kayıt yedeklendi.`);
  }catch(err){toast('Yedek oluşturulamadı. Depolama alanını kontrol et.');}
});
$('importRecordsInput').addEventListener('change',async e=>{
  const file=e.target.files?.[0];e.target.value='';if(!file)return;
  if(file.size>100*1024*1024){toast('Yedek dosyası 100 MB sınırını aşıyor.');return;}
  try{
    const payload=JSON.parse(await file.text());
    if(payload.app!=='Mantar Dedektifi'||payload.formatVersion!==1||!Array.isArray(payload.records))throw new Error('Bu dosya Mantar Dedektifi yedeği değil.');
    if(!confirm(`${payload.records.length} kayıt yedekten içe aktarılacak. Aynı kimlikli kayıtlar güncellenecek; diğer kayıtlar korunacak. Devam edilsin mi?`))return;
    let imported=0;
    for(const raw of payload.records){
      if(!raw||typeof raw.id!=='string'||!raw.analysis||!Array.isArray(raw.photos))continue;
      const record={...raw,photos:raw.photos.map(dataUrlToBlob),note:typeof raw.note==='string'?raw.note.slice(0,2000):''};
      await dbPut(record);imported++;
    }
    records=await dbGetAll();records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));updateCounts();renderRecords();renderMap();
    toast(`${imported} kayıt geri yüklendi.`);
  }catch(err){toast(err.message||'Yedek dosyası okunamadı.');}
});

function showDetail(id){
  const r=records.find(x=>x.id===id);if(!r)return;
  const photoHtml=(r.photos||[]).map(blob=>`<img src="${URL.createObjectURL(blob)}" alt="Mantar fotoğrafı">`).join('');
  const candidates=(r.analysis?.candidates||[]).map(c=>`<p><b>${esc(c.common_name)}</b> <em>${esc(c.scientific_name)}</em></p>`).join('');
  $('detailContent').innerHTML=`<div class="detail-photos">${photoHtml}</div><h3>${esc(firstName(r))}</h3><p class="detail-meta">${dateLabel(r.createdAt)} · ${r.source==='packaged'?'Paketli kültür mantarı':'Doğadan toplanmış yabani örnek'}</p><p class="detail-meta">${esc(r.analysis?.summary||'')}</p>${candidates}<label class="note-label" for="recordNoteInput">Kişisel not / gözlem</label><textarea id="recordNoteInput" class="note-input" maxlength="2000" placeholder="Örn. bulunduğu ağaç, hava durumu, koku, renk değişimi…">${esc(r.note||'')}</textarea><div class="note-actions"><small id="noteCharCount">0 / 2000</small><button id="saveNoteBtn" class="button primary">Notu kaydet</button></div><div class="safety-lock">Bu uygulama tüketim güvenliği onayı vermez. Yabani mantarı tüketme.</div>${r.location?`<p class="detail-meta">Konum kayıtlı · ${r.location.lat.toFixed(5)}, ${r.location.lon.toFixed(5)}</p>`:'<p class="detail-meta">Bu kayıtta konum yok.</p>'}<div class="detail-buttons"><button id="detailPdf" class="button primary">PDF raporu</button>${r.location?'<button id="detailShare" class="button primary">Konumu paylaş</button>':''}<button id="detailDelete" class="button secondary">Kaydı sil</button></div>`;
  const noteInput=$('recordNoteInput');const countNote=()=>{$('noteCharCount').textContent=`${noteInput.value.length} / 2000`;};countNote();noteInput.addEventListener('input',countNote);
  $('saveNoteBtn').addEventListener('click',async()=>{r.note=noteInput.value.trim();try{await dbPut(r);records=await dbGetAll();updateCounts();renderRecords();toast('Not kaydedildi.');}catch{toast('Not kaydedilemedi.');}});
  $('detailPdf').addEventListener('click',()=>window.print());
  if(r.location)$('detailShare').addEventListener('click',()=>shareLocation(id));
  $('detailDelete').addEventListener('click',async()=>{if(confirm('Bu keşif kaydını ve fotoğraflarını bu cihazdan silmek istiyor musun?')){await dbDelete(id);records=await dbGetAll();updateCounts();renderRecords();renderMap();$('detailDialog').close();toast('Kayıt silindi.');}});
  $('detailDialog').showModal();
}
$('closeDialog').addEventListener('click',()=>$('detailDialog').close());
async function shareLocation(id){
  const r=records.find(x=>x.id===id);if(!r?.location){toast('Bu kayıtta konum bulunmuyor.');return;}
  const {lat,lon}=r.location;
  const url=`https://maps.apple.com/?ll=${lat},${lon}&q=${encodeURIComponent(firstName(r))}`;
  const text=`Mantar keşfi: ${firstName(r)}\nTarih: ${dateLabel(r.createdAt)}\nKonum: ${lat.toFixed(6)}, ${lon.toFixed(6)}\nHarita: ${url}\nNot: Bu tür tahmini kesin teşhis veya tüketim onayı değildir.`;
  try{if(navigator.share){await navigator.share({title:'Mantar keşif konumu',text,url});}else if(navigator.clipboard){await navigator.clipboard.writeText(text);toast('Konum bağlantısı panoya kopyalandı.');}else{window.prompt('Konum paylaşım metni',text);}}catch(err){if(err.name!=='AbortError')toast('Paylaşım açılamadı.');}
}

function updateCounts(){
  $('recordCount').textContent=records.length;$('mapCount').textContent=`${records.filter(r=>r.location).length} nokta`;
  $('recordsTotal').textContent=`${records.length} kayıt`;
}
function renderStats(){
  const total=records.length;
  const withLocation=records.filter(r=>r.location).length;
  const species=new Map();
  records.forEach(r=>{const name=firstName(r);species.set(name,(species.get(name)||0)+1);});
  const top=[...species.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'tr')).slice(0,5);
  const firstSeen=records.length?records.reduce((min,r)=>r.createdAt<min?r.createdAt:min,records[0].createdAt):null;
  const months=[];
  const now=new Date();
  for(let offset=5;offset>=0;offset--){
    const d=new Date(now.getFullYear(),now.getMonth()-offset,1);
    const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    months.push({key,label:new Intl.DateTimeFormat('tr-TR',{month:'short'}).format(d),count:records.filter(r=>{const x=new Date(r.createdAt);return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}`===key;}).length});
  }
  const maxMonth=Math.max(1,...months.map(m=>m.count));
  $('statsSummary').innerHTML=[
    ['Toplam keşif',total,'📒'],['Konumlu kayıt',withLocation,'📍'],['Farklı tahmin',species.size,'🍄'],['Konum oranı',total?`${Math.round(withLocation/total*100)}%`:'—','🧭']
  ].map(([label,value,icon])=>`<article class="stat-card panel"><span>${icon}</span><small>${label}</small><b>${value}</b></article>`).join('');
  $('monthlyStats').innerHTML=months.map(m=>`<div class="month-bar"><div class="month-bar-track"><span style="height:${m.count?Math.max(8,m.count/maxMonth*100):0}%"></span></div><b>${m.count}</b><small>${esc(m.label)}</small></div>`).join('');
  $('speciesStats').innerHTML=top.length?top.map(([name,count])=>`<div class="stat-row"><div class="stat-row-label"><span>${esc(name)}</span><b>${count}</b></div><div class="stat-track"><span style="width:${count/Math.max(1,top[0][1])*100}%"></span></div></div>`).join(''):'<p class="stats-empty">Henüz kayıt yok. İlk keşfini analiz edip kaydettiğinde istatistiklerin burada görünecek.</p>';
  const wild=records.filter(r=>r.source!=='packaged').length;
  const packaged=records.filter(r=>r.source==='packaged').length;
  const sourceTotal=Math.max(1,total);
  $('sourceStats').innerHTML=`<div class="source-stat"><div><span class="source-dot wild"></span>Doğadan kaydedilen</div><b>${wild} · ${Math.round(wild/sourceTotal*100)}%</b></div><div class="source-stat"><div><span class="source-dot packaged"></span>Paketli kültür mantarı</div><b>${packaged} · ${Math.round(packaged/sourceTotal*100)}%</b></div><div class="source-track"><span class="wild" style="width:${wild/sourceTotal*100}%"></span><span class="packaged" style="width:${packaged/sourceTotal*100}%"></span></div>`;
  $('statsFootnote').textContent=firstSeen?`İlk kayıt: ${dateLabel(firstSeen)}. Veriler bu tarayıcıdaki kayıtlarından hesaplandı; tür tahminleri kesin teşhis değildir.`:'İstatistikler, bu cihazda kayıt oluşturduğunda otomatik hesaplanır.';
}
function renderMap(){
  const withLocation=records.filter(r=>r.location);
  $('mapCount').textContent=`${withLocation.length} nokta`;
  if(!window.L){$('map').innerHTML='<div class="map-empty">Harita yüklenemedi. İnternet bağlantısını kontrol et.</div>';return;}
  if(!mapInstance){mapInstance=L.map('map',{scrollWheelZoom:false}).setView([39,35],5);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(mapInstance);}
  mapMarkers.forEach(m=>mapInstance.removeLayer(m));mapMarkers=[];
  $('mapList').innerHTML='';
  if(!withLocation.length){mapInstance.setView([39,35],5);$('mapList').innerHTML='<div class="empty-state panel"><span>⌖</span><b>Konumlu kayıt yok</b><small>Yeni keşif sırasında GPS konumunu ekle.</small></div>';return;}
  const bounds=[];
  withLocation.forEach(r=>{
    const {lat,lon}=r.location;const marker=L.marker([lat,lon]).addTo(mapInstance).bindPopup(`<b>${esc(firstName(r))}</b><br>${dateLabel(r.createdAt)}`);mapMarkers.push(marker);bounds.push([lat,lon]);
    $('mapList').append(recordCard(r));
  });
  if(bounds.length===1)mapInstance.setView(bounds[0],14);else mapInstance.fitBounds(bounds,{padding:[25,25],maxZoom:13});
  setTimeout(()=>mapInstance.invalidateSize(),100);
}

$('installHint').addEventListener('click',()=>toast('Safari’de Paylaş düğmesine dokun → “Ana Ekrana Ekle” seç.'));
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/service-worker.js').catch(()=>{}));

(async()=>{
  checkSession();
  try{db=await openDB();records=await dbGetAll();records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));updateCounts();renderRecords();}
  catch{toast('Cihaz içi kayıt alanı açılamadı.');}
  renderPhotoGrid();
})();
