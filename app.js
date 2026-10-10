/* XTP JP v13 — static, read-only TikTok-style R2 reel viewer.
 * Upload/delete objects in Cloudflare R2 Dashboard, never from this app.
 */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const els = Object.fromEntries([
 'panels','gesture','reelOverlay','loadingIndicator','notice','noticeText','noticeRetry','empty',
 'emptyTitle','emptyText','emptyRefresh','channelName','clipTitle','followBtn','caption','captionTag',
 'captionBody','captionHint','replayBtn','saveBtn','saveIcon','saveText','speedBtn','speedIcon',
 'soundBtn','soundIcon','soundText','progressTrack','progressFill','progressThumb','focusBand',
 'reelCount','timeLabel','tapPlay','tapPlayBtn','toast','allTab','savedTab','library','libraryBtn',
 'libraryClose','librarySummary','libraryList','refreshBtn','searchInput'
].map(k=>[k,$(k)]));
let mediaBase='';
let sources=[];
let playlist=[];
let nextSource=0;
let currentIndex=0;
let mode='all';
let panels=new Map();
let expandPromise=null;
let loadGeneration=0;
let initialised=false;
let muted=true;
let speed=1;
let lang='vi';
let loadingTimer=null;
let loadingFor=null;
let toastTimer=null;
const saved=readSet('xtp-jp-saved-v13');
const following=readSet('xtp-jp-follow-v13');
const rates=[0.75,1,1.25,1.5];
function readSet(key){ try{const value=JSON.parse(localStorage.getItem(key)||'[]');return new Set(Array.isArray(value)?value:[]);}catch{return new Set();}}
function persist(key,set){try{localStorage.setItem(key,JSON.stringify([...set]));}catch{/* Private mode storage may be blocked */}}
function prettyId(id){return id.replace(/[-_]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());}
function seconds(n){if(!Number.isFinite(n))return '--:--';n=Math.max(0,Math.floor(n));return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');}
function bytes(n){if(!Number.isFinite(n))return '? MB';return n<1024*1024 ? (n/1024).toFixed(0)+' KB':(n/1024/1024).toFixed(1)+' MB';}
function toast(message){els.toast.textContent=message;els.toast.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>els.toast.classList.add('hidden'),2500);}
function showError(message, retry=true){clearTimeout(loadingTimer);loadingTimer=null;loadingFor=null;els.loadingIndicator.classList.add('hidden');els.noticeText.textContent=message;els.noticeRetry.classList.toggle('hidden',!retry);els.notice.classList.remove('hidden');}
function clearError(){els.notice.classList.add('hidden');els.tapPlay.classList.add('hidden');}
function showLoading(){
 els.loadingIndicator.classList.remove('hidden');
 const key=activeReel()?.key||'library';
 if(loadingTimer&&loadingFor===key)return;
 clearTimeout(loadingTimer);loadingFor=key;
 loadingTimer=setTimeout(()=>{
  loadingTimer=null;loadingFor=null;
  if(key!==activeReel()?.key||els.reelOverlay.classList.contains('hidden'))return;
  const p=panels.get(key);
  if(p&&p.video.readyState>=2&&p.prepared)els.loadingIndicator.classList.add('hidden');
  else showError('Video không tải kịp. Kiểm tra đường dẫn, MP4 và HTTP Range trên Worker.');
 },15000);
}
function hideLoading(){clearTimeout(loadingTimer);loadingTimer=null;loadingFor=null;els.loadingIndicator.classList.add('hidden');}
async function fetchTimed(url,options={}){
 const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),14000);
 try{return await fetch(url,{...options,signal:ctrl.signal});}finally{clearTimeout(timer);}
}
function basePath(path){return mediaBase+path;}
function getView(){return mode==='saved'?playlist.filter(reel=>saved.has(reel.key)):playlist;}
function activeReel(){return getView()[currentIndex]||null;}
function findStartForSource(id){return getView().findIndex(reel=>reel.sourceId===id);}
function normalizeManifest(source,json){
 if(!json || typeof json!=='object'||!Array.isArray(json.reels))throw new Error('JSON phải có trường reels là mảng');
 const title=String(json.title||prettyId(source.id)).slice(0,160);
 const channel=String(json.channel||'XTP JP').slice(0,100);
 const reels=[];
 json.reels.slice(0,300).forEach((item,j)=>{
  const start=Number(item.start),end=Number(item.end);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end-start>3600)return;
  const f1=Number(item.focusStart),f2=Number(item.focusEnd);
  const validFocus=item.focusStart!==null&&item.focusStart!==undefined&&item.focusEnd!==null&&item.focusEnd!==undefined&&Number.isFinite(f1)&&Number.isFinite(f2)&&f1>=start&&f2<=end&&f2>f1;
  const tokens=Array.isArray(item.tokens)?item.tokens.slice(0,150).map(token=>({
   hira:String(token.hira||'').slice(0,80),kanji:String(token.kanji||'').slice(0,80),
   start:token.start===null||token.start===undefined?null:Number(token.start),
   end:token.end===null||token.end===undefined?null:Number(token.end)
  })).filter(t=>t.hira):[];
  reels.push({key:`${source.id}:${j}`,sourceId:source.id,sourceTitle:title,channel,start,end,
   focusStart:validFocus?f1:null,focusEnd:validFocus?f2:null,
   ja:String(item.ja||'').slice(0,350),vi:String(item.vi||'').slice(0,350),tokens});
 });
 if(!reels.length)throw new Error('JSON không có reel nào hợp lệ');
 return reels;
}
function fallbackReel(source,message=''){
 return [{key:`${source.id}:whole`,sourceId:source.id,sourceTitle:prettyId(source.id),channel:'XTP JP',start:0,end:null,focusStart:null,focusEnd:null,vi:'',ja:'',tokens:[],metadataIssue:message}];
}
async function expandSource(source){
 if(source.expanded)return;
 source.expanded=true;
 try{
  const response=await fetchTimed(basePath(`/api/reels/${encodeURIComponent(source.id)}`));
  if(response.status===404){source.reels=fallbackReel(source);}
  else if(!response.ok){source.reels=fallbackReel(source,`JSON lỗi HTTP ${response.status}`);}
  else {const json=await response.json();source.reels=normalizeManifest(source,json);}
 }catch(e){source.reels=fallbackReel(source,`Không đọc được JSON: ${e.message}`);}
 playlist.push(...source.reels);
}
async function ensureAhead(minimum=currentIndex+4){
 if(expandPromise)return expandPromise;
 expandPromise=(async()=>{
  // Load only metadata needed for the next reel. Never scan or transcode media.
  while(playlist.length<minimum && nextSource<sources.length){
   await expandSource(sources[nextSource++]);
  }
 })();
 try{return await expandPromise;}finally{expandPromise=null;}
}
async function readLibrary(){
 const loaded=[];let cursor=null;
 for(let page=0;page<100;page++){
  const u=new URL(basePath('/api/library'));
  if(cursor)u.searchParams.set('cursor',cursor);
  const response=await fetchTimed(u.toString(),{cache:'no-store'});
  if(!response.ok)throw new Error(`Worker trả HTTP ${response.status}`);
  const json=await response.json();
  if(!json||!Array.isArray(json.videos))throw new Error('API thư viện trả dữ liệu không hợp lệ');
  for(const item of json.videos){if(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.id))loaded.push({id:item.id,bytes:Number(item.bytes)||0,uploaded:item.uploaded||'',expanded:false,reels:null});}
  if(!json.hasMore)break;
  if(!json.cursor||json.cursor===cursor)throw new Error('Phân trang R2 thiếu cursor hợp lệ');
  cursor=json.cursor;
  if(page===99)throw new Error('Thư viện quá lớn (trên 100.000 khóa). Giới hạn phiên hiện tại.');
 }
 loaded.sort((a,b)=>String(b.uploaded).localeCompare(String(a.uploaded)));
 return loaded;
}
async function loadAll(){
 const generation=++loadGeneration;
 els.libraryList.replaceChildren();els.empty.classList.add('hidden');els.reelOverlay.classList.add('hidden');
 clearPanels();clearError();showLoading();
 try{
  const cfg=await fetchTimed('./xtp-config.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Không có xtp-config.json');return r.json();});
  if(!/^https:\/\/[\w.-]+(?:\:\d+)?(?:\/[\w-]+)*\/?$/.test(String(cfg.mediaBaseUrl||''))||String(cfg.mediaBaseUrl).includes('REPLACE_')){
   throw new Error('Chưa cấu hình mediaBaseUrl trong xtp-config.json.');
  }
  mediaBase=cfg.mediaBaseUrl.replace(/\/+$/,'');
  const loaded=await readLibrary();
  if(generation!==loadGeneration)return;
  sources=loaded;playlist=[];nextSource=0;currentIndex=0;mode='all';
  syncTabs();renderLibrary();
  if(!sources.length){hideLoading();showEmpty('Chưa có video','Upload file videos/ten-video.mp4 trên Cloudflare R2 rồi bấm Tải lại thư viện.');return;}
  await ensureAhead(3);
  if(generation!==loadGeneration)return;
  initialised=true;els.reelOverlay.classList.remove('hidden');hideLoading();activate({instant:true});
 }catch(e){
  if(generation!==loadGeneration)return;
  hideLoading();showEmpty('Chưa kết nối được Cloudflare',String(e.message||e));
 }
}
function showEmpty(title,description){els.emptyTitle.textContent=title;els.emptyText.textContent=description;els.empty.classList.remove('hidden');}
function clearPanels(){for(const p of panels.values()){p.video.pause();p.video.removeAttribute('src');p.video.load();p.node.remove();}panels.clear();}
function createPanel(reel,index,active){
 const node=document.createElement('div');node.className='reel-panel no-transition';node.dataset.key=reel.key;
 node.style.transform=`translateY(${(index-active)*100}%)`;
 const video=document.createElement('video');video.playsInline=true;video.setAttribute('playsinline','');video.setAttribute('webkit-playsinline','');
 video.controls=false;video.autoplay=false;video.loop=false;video.muted=muted;video.preload=Math.abs(index-active)<=1?'auto':'metadata';video.playbackRate=speed;
 video.src=basePath('/media/'+encodeURIComponent(reel.sourceId));
 const panel={node,video,reel,prepared:false,error:false};
 node.appendChild(video);els.panels.appendChild(node);
 const seekStart=()=>{
  if(panel.prepared||!video.duration)return;
  if(reel.start>=video.duration){panel.error=true;if(activeReel()?.key===reel.key)showError('Reel bắt đầu sau khi video đã kết thúc. Hãy sửa timestamp trong JSON.');return;}
  if(reel.start>0.05){
   if(Math.abs(video.currentTime-reel.start)>0.18){try{video.currentTime=reel.start;}catch{/* try after data */}return;}
  }
  panel.prepared=true;
  if(activeReel()?.key===reel.key)startActiveVideo();
 };
 video.addEventListener('loadedmetadata',seekStart);
 video.addEventListener('loadeddata',seekStart);
 video.addEventListener('seeked',()=>{
  if(!panel.prepared && Math.abs(video.currentTime-reel.start)<0.2){panel.prepared=true;if(activeReel()?.key===reel.key)startActiveVideo();}
  if(activeReel()?.key===reel.key)updateProgress();
 });
 video.addEventListener('canplay',()=>{seekStart();if(activeReel()?.key===reel.key&&panel.prepared){hideLoading();}});
 video.addEventListener('playing',()=>{if(activeReel()?.key===reel.key){clearError();hideLoading();}});
 video.addEventListener('waiting',()=>{if(activeReel()?.key===reel.key){showLoading();}});
 video.addEventListener('timeupdate',()=>{
  if(activeReel()?.key!==reel.key)return;
  const end=reel.end??video.duration;
  if(Number.isFinite(end)&&end>reel.start&&video.currentTime>=end-0.06){
   video.pause();try{video.currentTime=reel.start;}catch{};video.play().catch(()=>els.tapPlay.classList.remove('hidden'));
  }else updateProgress();
 });
 video.addEventListener('ended',()=>{
  if(activeReel()?.key!==reel.key)return;
  try{video.currentTime=reel.start;}catch{}
  video.play().catch(()=>els.tapPlay.classList.remove('hidden'));
 });
 video.addEventListener('error',()=>{panel.error=true;if(activeReel()?.key===reel.key)showError('Không phát được MP4. Kiểm tra file, codec H.264/AAC và Worker Range.');});
 video.load();
 return panel;
}
function updatePanels(instant=false){
 const view=getView(), wanted=new Set();
 for(let i=Math.max(0,currentIndex-1);i<=Math.min(view.length-1,currentIndex+2);i++)wanted.add(view[i].key);
 for(const [key,p] of [...panels])if(!wanted.has(key)){p.video.pause();p.video.removeAttribute('src');p.video.load();p.node.remove();panels.delete(key);}
 for(let i=Math.max(0,currentIndex-1);i<=Math.min(view.length-1,currentIndex+2);i++){
  const reel=view[i];let p=panels.get(reel.key);
  if(!p){p=createPanel(reel,i,currentIndex);panels.set(reel.key,p);}
  p.video.preload=Math.abs(i-currentIndex)<=1?'auto':'metadata';
 }
 // Existing adjacent video nodes slide into view instead of setting src a second time.
 if(instant){for(const p of panels.values())p.node.classList.add('no-transition');}
 requestAnimationFrame(()=>{
  for(let i=Math.max(0,currentIndex-1);i<=Math.min(view.length-1,currentIndex+2);i++){
   const p=panels.get(view[i].key);p.node.style.transform=`translateY(${(i-currentIndex)*100}%)`;
   p.node.style.zIndex=String(5-Math.abs(i-currentIndex));
  }
  requestAnimationFrame(()=>{for(const p of panels.values())p.node.classList.remove('no-transition');});
 });
}
function startActiveVideo(){
 const reel=activeReel();if(!reel)return;
 for(const p of panels.values())if(p.reel.key!==reel.key)p.video.pause();
 const p=panels.get(reel.key);if(!p||p.error)return;
 p.video.muted=muted;p.video.playbackRate=speed;
 if(!p.prepared){showLoading();return;}
 hideLoading();
 p.video.play().then(()=>{els.tapPlay.classList.add('hidden');}).catch(()=>{
  // iOS may block autoplay even with muted video in some modes.
  els.tapPlay.classList.remove('hidden');
 });
}
function activate({instant=false}={}){
 const reel=activeReel();
 if(!reel){els.reelOverlay.classList.add('hidden');clearPanels();showEmpty(mode==='saved'?'Chưa có reel đã lưu':'Hết video',mode==='saved'?'Nhấn Lưu ở một reel để xem lại tại đây.':'Tải lại thư viện để kiểm tra video mới.');return;}
 els.empty.classList.add('hidden');els.reelOverlay.classList.remove('hidden');clearError();hideLoading();
 updatePanels(instant);renderReelInfo();startActiveVideo();
 if(mode==='all')ensureAhead(currentIndex+5).then(()=>{
  if(activeReel())updatePanels(true);
 }).catch(e=>toast('Không tải thêm được reel: '+e.message));
}
function renderReelInfo(){
 const reel=activeReel();if(!reel)return;
 lang='vi';els.channelName.textContent=reel.channel;els.clipTitle.textContent=reel.sourceTitle;
 els.reelCount.textContent=`${currentIndex+1} / ${getView().length}${mode==='all'&&nextSource<sources.length?'+':''}`;
 els.followBtn.textContent=following.has(reel.channel)?'Following':'Follow';els.followBtn.classList.toggle('following',following.has(reel.channel));
 const isSaved=saved.has(reel.key);els.saveBtn.classList.toggle('saved',isSaved);els.saveText.textContent=isSaved?'Đã lưu':'Lưu';els.saveIcon.textContent=isSaved?'♥':'♡';
 els.speedIcon.textContent=speed+'×';updateSoundUI();renderCaption();updateProgress();
 if(reel.metadataIssue)toast(reel.metadataIssue);
}
function renderCaption(){
 const reel=activeReel();if(!reel)return;
 els.captionBody.replaceChildren();els.caption.classList.toggle('ja-mode',lang==='ja');
 els.captionTag.textContent=lang==='vi'?'VI':'JP';els.captionHint.textContent=lang==='vi'?'Chạm để xem 日本語':'Chạm để xem tiếng Việt';
 const hasCaption=Boolean(reel.ja||reel.vi);els.caption.classList.toggle('no-caption',!hasCaption);
 if(!hasCaption){els.captionBody.textContent='Video gốc — chưa có dữ liệu câu focus.';els.captionHint.textContent='Thêm JSON cùng tên MP4 để tạo reel học';return;}
 if(lang==='vi'){els.captionBody.textContent=reel.vi||'Chưa có bản dịch tiếng Việt';return;}
 if(!reel.tokens.length){els.captionBody.textContent=reel.ja||'Chưa có tiếng Nhật';return;}
 for(const token of reel.tokens){
  const span=document.createElement('span');span.className='jp-token';span.dataset.start=Number.isFinite(token.start)?String(token.start):'';span.dataset.end=Number.isFinite(token.end)?String(token.end):'';
  const ruby=document.createElement('ruby');const rb=document.createElement('rb');rb.textContent=token.hira;ruby.appendChild(rb);
  if(token.kanji){const rt=document.createElement('rt');rt.textContent=token.kanji;ruby.appendChild(rt);}
  span.appendChild(ruby);els.captionBody.appendChild(span);
 }
 updateHighlight();
}
function updateHighlight(){
 const reel=activeReel();if(!reel)return;
 const p=panels.get(reel.key),time=p?.video.currentTime??reel.start;
 const on=reel.focusStart!==null&&time>=reel.focusStart&&time<=reel.focusEnd;
 els.caption.classList.toggle('focus-now',on);
 if(lang==='ja')for(const node of els.captionBody.querySelectorAll('.jp-token')){
  const start=Number(node.dataset.start),end=Number(node.dataset.end);
  const timed=node.dataset.start!==''&&node.dataset.end!==''&&Number.isFinite(start)&&Number.isFinite(end)&&end>start;
  node.classList.toggle('spoken',timed&&time>=start&&time<end);
 }
}
function updateProgress(){
 const reel=activeReel();if(!reel)return;
 const p=panels.get(reel.key);const video=p?.video;
 const end=reel.end??(Number.isFinite(video?.duration)?video.duration:0);
 const span=end-reel.start,time=video?.currentTime??reel.start;
 const fraction=span>0?Math.min(1,Math.max(0,(time-reel.start)/span)):0;
 const percent=fraction*100;
 els.progressFill.style.width=percent+'%';els.progressThumb.style.left=percent+'%';
 els.progressTrack.setAttribute('aria-valuenow',String(Math.round(percent)));
 els.timeLabel.textContent=`${seconds(Math.max(0,time-reel.start))} / ${seconds(span)}`;
 if(reel.focusStart!==null&&span>0){
  els.focusBand.classList.remove('hidden');
  els.focusBand.style.left=Math.max(0,100*(reel.focusStart-reel.start)/span)+'%';
  els.focusBand.style.width=Math.min(100,100*(reel.focusEnd-reel.focusStart)/span)+'%';
 }else els.focusBand.classList.add('hidden');
 updateHighlight();
}
async function go(delta){
 if(!initialised||!els.library.classList.contains('hidden'))return;
 if(delta>0&&mode==='all'&&currentIndex+1>=playlist.length&&nextSource<sources.length)await ensureAhead(currentIndex+2);
 const target=currentIndex+delta;
 if(target<0){toast('Đây là reel đầu tiên');return;}
 if(target>=getView().length){toast('Đã hết reel');return;}
 const prev=activeReel();const prevPanel=prev&&panels.get(prev.key);if(prevPanel)prevPanel.video.pause();
 currentIndex=target;activate();
}
function togglePlay(){const r=activeReel();const p=r&&panels.get(r.key);if(!p)return;if(p.video.paused){startActiveVideo();}else{p.video.pause();els.tapPlay.classList.remove('hidden');}}
function replay(){const r=activeReel(),p=r&&panels.get(r.key);if(!p)return;clearError();p.error=false;try{p.video.currentTime=r.start;}catch{}startActiveVideo();}
function seekFraction(f){const r=activeReel(),p=r&&panels.get(r.key);if(!p)return;const end=r.end??p.video.duration;if(!Number.isFinite(end)||end<=r.start)return;p.video.currentTime=r.start+Math.min(.999,Math.max(0,f))*(end-r.start);updateProgress();}
function updateSoundUI(){els.soundIcon.textContent=muted?'♪̸':'♫';els.soundText.textContent=muted?'Bật tiếng':'Tắt tiếng';}
function syncTabs(){els.allTab.classList.toggle('active',mode==='all');els.savedTab.classList.toggle('active',mode==='saved');}
async function switchMode(to){
 if(mode===to)return;
 const old=activeReel()?.key;mode=to;syncTabs();
 if(to==='saved'){
  for(const key of [...saved]){
   const id=key.split(':')[0];const src=sources.find(s=>s.id===id);
   if(src&&!src.expanded)await expandSource(src);
  }
 }
 let target=getView().findIndex(r=>r.key===old);if(target<0)target=0;
 currentIndex=target;clearPanels();activate({instant:true});
}
function libraryShow(){els.library.classList.remove('hidden');const p=activeReel()&&panels.get(activeReel().key);p?.video.pause();renderLibrary();}
function libraryHide(){els.library.classList.add('hidden');startActiveVideo();}
function renderLibrary(){
 const query=els.searchInput.value.trim().toLowerCase();const filtered=sources.filter(s=>prettyId(s.id).toLowerCase().includes(query));
 const total=sources.reduce((acc,s)=>acc+s.bytes,0);
 els.librarySummary.textContent=`${sources.length.toLocaleString('vi-VN')} video • ${bytes(total)} (MP4)`;
 const fragment=document.createDocumentFragment();
 if(!filtered.length){const p=document.createElement('p');p.style.color='#b0bac3';p.textContent='Không tìm thấy video.';fragment.appendChild(p);}
 for(const src of filtered){
  const b=document.createElement('button');b.type='button';b.className='library-row';
  const poster=document.createElement('img');poster.className='poster';poster.loading='lazy';poster.alt='';poster.src=basePath(`/poster/${encodeURIComponent(src.id)}`);
  poster.addEventListener('error',()=>{const fall=document.createElement('div');fall.className='poster';fall.textContent='▶';poster.replaceWith(fall);},{once:true});
  const data=document.createElement('div');data.className='lib-meta';
  const title=document.createElement('div');title.className='lib-title';title.textContent=prettyId(src.id);
  const sub=document.createElement('div');sub.className='lib-sub';sub.textContent=`${bytes(src.bytes)} • ${src.reels?src.reels.length+' reel':'Chạm để xem'}`;
  data.append(title,sub);
  const arrow=document.createElement('span');arrow.className='lib-arrow';arrow.textContent='›';
  b.append(poster,data,arrow);
  b.addEventListener('click',async()=>{
   b.disabled=true;
   try{
    if(!src.expanded)await expandSource(src);
    const idx=findStartForSource(src.id);
    if(mode==='saved'){mode='all';syncTabs();}
    const first=playlist.findIndex(reel=>reel.sourceId===src.id);
    if(first<0)throw Error('Không thể mở video');
    currentIndex=first;clearPanels();libraryHide();activate({instant:true});
   }catch(e){toast(e.message);}finally{b.disabled=false;}
  });
  fragment.appendChild(b);
 }
 els.libraryList.replaceChildren(fragment);
}
function hookEvents(){
 els.gesture.addEventListener('pointerdown',e=>{els.gesture._start={y:e.clientY,x:e.clientX,time:Date.now()};});
 els.gesture.addEventListener('pointerup',e=>{
  const a=els.gesture._start;if(!a)return;els.gesture._start=null;
  const dy=e.clientY-a.y,dx=e.clientX-a.x;
  if(Math.abs(dy)>55 && Math.abs(dy)>Math.abs(dx)*1.2){go(dy<0?1:-1);return;}
  if(Math.abs(dy)<12&&Math.abs(dx)<12&&Date.now()-a.time<700)togglePlay();
 });
 let lastWheel=0;
 els.gesture.addEventListener('wheel',e=>{e.preventDefault();if(Date.now()-lastWheel<480)return;lastWheel=Date.now();go(e.deltaY>0?1:-1);},{passive:false});
 document.addEventListener('keydown',e=>{
  if(!els.library.classList.contains('hidden')){if(e.key==='Escape')libraryHide();return;}
  if(['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;
  if(e.key==='ArrowDown'){e.preventDefault();go(1);}if(e.key==='ArrowUp'){e.preventDefault();go(-1);}
  if(e.key===' '&&document.activeElement?.tagName!=='BUTTON'){e.preventDefault();togglePlay();}
 });
 els.noticeRetry.addEventListener('click',()=>{
  const r=activeReel(),p=r&&panels.get(r.key);if(!p)return;
  clearError();p.error=false;p.prepared=false;showLoading();p.video.load();
 });
 els.tapPlayBtn.addEventListener('click',startActiveVideo);
 els.emptyRefresh.addEventListener('click',loadAll);
 els.replayBtn.addEventListener('click',replay);
 els.caption.addEventListener('click',()=>{lang=lang==='vi'?'ja':'vi';renderCaption();});
 els.saveBtn.addEventListener('click',()=>{
  const r=activeReel();if(!r)return;
  if(saved.has(r.key))saved.delete(r.key);else saved.add(r.key);
  persist('xtp-jp-saved-v13',saved);
  if(mode==='saved'&&!saved.has(r.key)){currentIndex=Math.max(0,currentIndex-1);clearPanels();activate({instant:true});}else renderReelInfo();
 });
 els.followBtn.addEventListener('click',()=>{
  const r=activeReel();if(!r)return;
  if(following.has(r.channel))following.delete(r.channel);else following.add(r.channel);
  persist('xtp-jp-follow-v13',following);renderReelInfo();
 });
 els.speedBtn.addEventListener('click',()=>{speed=rates[(rates.indexOf(speed)+1)%rates.length];for(const p of panels.values())p.video.playbackRate=speed;els.speedIcon.textContent=speed+'×';});
 els.soundBtn.addEventListener('click',()=>{muted=!muted;for(const p of panels.values())p.video.muted=muted;updateSoundUI();const p=activeReel()&&panels.get(activeReel().key);if(p?.video.paused)startActiveVideo();});
 els.progressTrack.addEventListener('pointerdown',e=>{e.stopPropagation();seekFraction((e.clientX-els.progressTrack.getBoundingClientRect().left)/els.progressTrack.clientWidth);});
 els.progressTrack.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();const r=activeReel(),p=r&&panels.get(r.key);if(!p)return;const end=r.end??p.video.duration;if(!Number.isFinite(end))return;const f=(p.video.currentTime-r.start)/(end-r.start)+(e.key==='ArrowRight'?.05:-.05);seekFraction(f);}});
 els.libraryBtn.addEventListener('click',libraryShow);els.libraryClose.addEventListener('click',libraryHide);
 els.refreshBtn.addEventListener('click',async()=>{els.library.classList.add('hidden');els.searchInput.value='';await loadAll();els.library.classList.remove('hidden');});
 els.searchInput.addEventListener('input',renderLibrary);
 els.allTab.addEventListener('click',()=>switchMode('all'));
 els.savedTab.addEventListener('click',()=>switchMode('saved'));
 document.addEventListener('visibilitychange',()=>{const r=activeReel(),p=r&&panels.get(r.key);if(document.hidden)p?.video.pause();});
}
hookEvents();loadAll();
if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();
