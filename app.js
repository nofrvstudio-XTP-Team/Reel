
/* XTP JP v13.7
 * Native video, sequential preload,
 * startup diagnostics, Cloudflare R2.
 */
(() => {
'use strict';

const $ = id => document.getElementById(id);

const els = Object.fromEntries([
 'panels','gesture','reelOverlay','loadingIndicator',
 'notice','noticeText','noticeRetry','empty',
 'emptyTitle','emptyText','emptyRefresh',
 'channelName','clipTitle','followBtn',
 'caption','captionTag','captionBody','captionHint',
 'replayBtn','saveBtn','saveIcon','saveText',
 'speedBtn','speedIcon','soundBtn','soundIcon',
 'soundText','progressTrack','progressFill',
 'progressThumb','focusBand','reelCount',
 'timeLabel','tapPlay','tapPlayBtn','toast',
 'allTab','savedTab','library','libraryBtn',
 'libraryClose','librarySummary','libraryList',
 'refreshBtn','searchInput'
].map(k => [k, $(k)]));

let mediaBase = '';
let sources = [];
let playlist = [];
let nextSource = 0;
let currentIndex = 0;
let mode = 'all';
let panels = new Map();
let expandPromise = null;
let loadGeneration = 0;
let initialised = false;
let muted = true;

let activeEpoch = 0;
let resumeOnShow = false;
let nextPreloadTimer = null;
let wantsPlayback = true;

const isiOS =
 /iPad|iPhone|iPod/.test(navigator.userAgent) ||
 (navigator.platform === 'MacIntel' &&
  navigator.maxTouchPoints > 1);

let speed = 1;
let lang = 'vi';
let loadingTimer = null;
let loadingFor = null;
let toastTimer = null;

const saved = readSet('xtp-jp-saved-v13');
const following = readSet('xtp-jp-follow-v13');
const rates = [0.75, 1, 1.25, 1.5];

function cancelNextPreload() {
 clearTimeout(nextPreloadTimer);
 nextPreloadTimer = null;
}

function isCurrentPanel(panel) {
 return panel &&
  panels.get(panel.reel.key) === panel &&
  activeReel()?.key === panel.reel.key &&
  els.library.classList.contains('hidden') &&
  !document.hidden;
}

function stopOtherVideos(except = null) {
 for (const p of panels.values()) {
  if (p.video !== except) {
   try {
    p.video.pause();
   } catch {}
  }
 }
}

function stopAllVideos() {
 stopOtherVideos();
}

/* ---------------------------------------
   STARTUP AND DIAGNOSTICS
--------------------------------------- */

const diagnostic = {
 phase: 'boot',
 events: [],
 error: ''
};

let bootScreen;
let bootStatus;
let bootButton;
let bootInfo;
let bootTimeout;
let bootDone = false;

function note(event, detail = '') {
 diagnostic.phase = event;

 diagnostic.events.push(
  event + (detail ? ' ' + detail : '')
 );

 if (diagnostic.events.length > 8) {
  diagnostic.events.shift();
 }

 if (!bootDone) updateBootInfo();
}

function mediaDetails() {
 const reel = activeReel();
 const p = reel && panels.get(reel.key);
 const v = p?.video;

 return (
  `reel=${reel?.key || '-'} / ` +
  `ready=${v?.readyState ?? '-'} / ` +
  `network=${v?.networkState ?? '-'} / ` +
  `paused=${v?.paused ?? '-'} / ` +
  `error=${v?.error?.code ?? '-'} / ` +
  `online=${navigator.onLine} / ` +
  `visible=${document.visibilityState}`
 );
}

function updateBootInfo() {
 if (!bootInfo) return;

 bootInfo.textContent =
  'v13.7 | ' +
  mediaDetails() +
  '\n' +
  diagnostic.events.slice(-3).join(' → ') +
  (diagnostic.error
   ? '\n' + diagnostic.error
   : '');
}

function setBoot(message, button = false) {
 if (bootDone) return;

 bootStatus.textContent = message;

 bootButton.style.display =
  button ? 'block' : 'none';

 updateBootInfo();
}

function bootComplete() {
 if (bootDone) return;

 bootDone = true;
 clearTimeout(bootTimeout);

 bootScreen.style.display = 'none';

 note('boot complete');
}

function bootProblem(message) {
 diagnostic.error = message;

 note('boot issue', message);

 setBoot(
  message + ' — Chạm để thử lại.',
  true
 );
}

function bootBegin() {
 bootDone = false;
 diagnostic.error = '';

 if (bootScreen) {
  bootScreen.style.display = 'flex';
 }

 setBoot('Đang tải thư viện video...');

 clearTimeout(bootTimeout);

 bootTimeout = setTimeout(() => {
  if (!bootDone) {
   bootProblem(
    'Khởi động quá 15 giây. ' +
    mediaDetails()
   );
  }
 }, 15000);
}

function createBoot() {
 const style = document.createElement('style');

 style.textContent = `
 #xtpBoot {
  position: fixed !important;
  inset: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999 !important;
  background: #081015 !important;
  color: #fff !important;
  font-family: system-ui, sans-serif;
 }

 #xtpBoot .boot-inner {
  width: min(390px, 92vw);
  text-align: center;
  padding: 20px;
 }

 #xtpBoot .boot-symbol {
  width: 72px;
  height: 72px;
  margin: 0 auto 14px;
  border-radius: 20px;
  display: grid;
  place-items: center;
  background: #55dcc8;
  color: #08201f;
  font-size: 46px;
  font-weight: 900;
 }

 #xtpBoot .boot-title {
  font-size: 26px;
  font-weight: 800;
  margin-bottom: 18px;
 }

 #xtpBoot .boot-status {
  font-size: 14px;
  line-height: 1.5;
  color: #d6e2e5;
  min-height: 45px;
  margin: 18px 0;
 }

 #xtpBoot .boot-action {
  display: none;
  margin: 16px auto;
  background: #55dcc8;
  color: #08201f;
  padding: 13px 20px;
  min-height: 46px;
  border-radius: 12px;
  border: 0;
  font-weight: 750;
  font-size: 15px;
 }

 #xtpBoot .boot-dots {
  display: none !important;
 }

 #xtpBoot .boot-small {
  font: 11px/1.5 monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  text-align: left;
  color: #9fb5b8;
  background: #112027;
  border-radius: 9px;
  padding: 10px;
  margin-top: 25px;
 }
 `;

 document.head.appendChild(style);

 bootScreen = document.getElementById('xtpBoot');

 if (!bootScreen) {
  bootScreen = document.createElement('div');
  bootScreen.id = 'xtpBoot';

  bootScreen.innerHTML = `
   <div class="boot-inner">
    <div class="boot-symbol">X</div>
    <div class="boot-title">XTP JP</div>
    <p class="boot-status">
     Đang khởi động…
    </p>
    <button type="button" class="boot-action">
     ▶ Chạm để phát
    </button>
    <p class="boot-small"></p>
   </div>
  `;

  document.body.appendChild(bootScreen);
 }

 bootStatus =
  bootScreen.querySelector('.boot-status');

 bootButton =
  bootScreen.querySelector('.boot-action');

 bootInfo =
  bootScreen.querySelector('.boot-small');

 bootButton.addEventListener('click', () => {
  const reel = activeReel();
  const p = reel && panels.get(reel.key);

  if (p) {
   note('manual play');

   if (p.error) {
    p.video.pause();
    p.video.removeAttribute('src');
    p.video.load();

    p.loaded = false;
    p.prepared = false;
    p.error = false;
    p.playPending = false;
   }

   startActiveVideo(true);
  } else {
   note('retry library');
   loadAll();
  }

  setBoot(
   'Đang thử phát từ thao tác chạm...'
  );
 });

 bootBegin();
}

/* Disable old shell cache while debugging
   the standalone PWA startup issue. */

function disableOldShellCache() {
 if ('serviceWorker' in navigator) {
  navigator.serviceWorker
   .getRegistrations()
   .then(list => Promise.all(
    list.filter(r =>
     r.scope.startsWith(
      location.origin +
      location.pathname.replace(/[^/]*$/, '')
     )
    ).map(r => r.unregister())
   ))
   .catch(() => {});
 }

 if ('caches' in window) {
  caches.keys()
   .then(keys => Promise.all(
    keys.filter(k =>
     k.startsWith('xtp-jp-v13-shell')
    ).map(k => caches.delete(k))
   ))
   .catch(() => {});
 }
}

/* ---------------------------------------
   UTILITIES
--------------------------------------- */

function readSet(key) {
 try {
  const value = JSON.parse(
   localStorage.getItem(key) || '[]'
  );

  return new Set(
   Array.isArray(value) ? value : []
  );
 } catch {
  return new Set();
 }
}

function persist(key, set) {
 try {
  localStorage.setItem(
   key,
   JSON.stringify([...set])
  );
 } catch {}
}

function prettyId(id) {
 return id
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase());
}

function seconds(n) {
 if (!Number.isFinite(n)) return '--:--';

 n = Math.max(0, Math.floor(n));

 return (
  String(Math.floor(n / 60)).padStart(2, '0') +
  ':' +
  String(n % 60).padStart(2, '0')
 );
}

function bytes(n) {
 if (!Number.isFinite(n)) return '? MB';

 return n < 1024 * 1024
  ? (n / 1024).toFixed(0) + ' KB'
  : (n / 1024 / 1024).toFixed(1) + ' MB';
}

function toast(message) {
 els.toast.textContent = message;
 els.toast.classList.remove('hidden');

 clearTimeout(toastTimer);

 toastTimer = setTimeout(() => {
  els.toast.classList.add('hidden');
 }, 2500);
}

function showError(message, retry = true) {
 if (!bootDone) {
  bootProblem(message);
  return;
 }

 clearTimeout(loadingTimer);

 loadingTimer = null;
 loadingFor = null;

 els.loadingIndicator.classList.add('hidden');
 els.noticeText.textContent = message;

 els.noticeRetry.classList.toggle(
  'hidden',
  !retry
 );

 els.notice.classList.remove('hidden');
}

function clearError() {
 els.notice.classList.add('hidden');
 els.tapPlay.classList.add('hidden');
}

function showLoading() {
 els.loadingIndicator.classList.remove('hidden');

 const key = activeReel()?.key || 'library';

 if (loadingTimer && loadingFor === key) {
  return;
 }

 clearTimeout(loadingTimer);
 loadingFor = key;

 loadingTimer = setTimeout(() => {
  loadingTimer = null;
  loadingFor = null;

  if (
   key !== activeReel()?.key ||
   els.reelOverlay.classList.contains('hidden')
  ) {
   return;
  }

  const p = panels.get(key);

  if (
   p &&
   p.video.readyState >= 2 &&
   p.prepared
  ) {
   els.loadingIndicator.classList.add(
    'hidden'
   );
  } else {
   showError(
    'Video không tải kịp: ' +
    mediaDetails()
   );
  }
 }, 15000);
}

function hideLoading() {
 clearTimeout(loadingTimer);

 loadingTimer = null;
 loadingFor = null;

 els.loadingIndicator.classList.add('hidden');
}

async function fetchTimed(url, options = {}) {
 const ctrl = new AbortController();

 const timer = setTimeout(
  () => ctrl.abort(),
  14000
 );

 try {
  return await fetch(url, {
   ...options,
   signal: ctrl.signal
  });
 } finally {
  clearTimeout(timer);
 }
}

function basePath(path) {
 return mediaBase + path;
}

function getView() {
 return mode === 'saved'
  ? playlist.filter(reel => saved.has(reel.key))
  : playlist;
}

function activeReel() {
 return getView()[currentIndex] || null;
}

function findStartForSource(id) {
 return getView().findIndex(
  reel => reel.sourceId === id
 );
}

/* ---------------------------------------
   DATA / R2 LIBRARY
--------------------------------------- */

function normalizeManifest(source, json) {
 if (
  !json ||
  typeof json !== 'object' ||
  !Array.isArray(json.reels)
 ) {
  throw new Error(
   'JSON phải có trường reels là mảng'
  );
 }

 const title = String(
  json.title || prettyId(source.id)
 ).slice(0, 160);

 const channel = String(
  json.channel || 'XTP JP'
 ).slice(0, 100);

 const reels = [];

 json.reels.slice(0, 300).forEach((item, j) => {
  const start = Number(item.start);
  const end = Number(item.end);

  if (
   !Number.isFinite(start) ||
   !Number.isFinite(end) ||
   start < 0 ||
   end <= start ||
   end - start > 3600
  ) {
   return;
  }

  const f1 = Number(item.focusStart);
  const f2 = Number(item.focusEnd);

  const validFocus =
   item.focusStart !== null &&
   item.focusStart !== undefined &&
   item.focusEnd !== null &&
   item.focusEnd !== undefined &&
   Number.isFinite(f1) &&
   Number.isFinite(f2) &&
   f1 >= start &&
   f2 <= end &&
   f2 > f1;

  const tokens = Array.isArray(item.tokens)
   ? item.tokens.slice(0, 150).map(token => ({
      hira: String(token.hira || '').slice(0, 80),
      kanji: String(token.kanji || '').slice(0, 80),

      start:
       token.start == null
        ? null
        : Number(token.start),

      end:
       token.end == null
        ? null
        : Number(token.end)
     })).filter(t => t.hira)
   : [];

  reels.push({
   key: `${source.id}:${j}`,
   sourceId: source.id,
   sourceTitle: title,
   channel,
   start,
   end,
   focusStart: validFocus ? f1 : null,
   focusEnd: validFocus ? f2 : null,
   ja: String(item.ja || '').slice(0, 350),
   vi: String(item.vi || '').slice(0, 350),
   tokens
  });
 });

 if (!reels.length) {
  throw new Error(
   'JSON không có reel nào hợp lệ'
  );
 }

 return reels;
}

function fallbackReel(source, message = '') {
 return [{
  key: `${source.id}:whole`,
  sourceId: source.id,
  sourceTitle: prettyId(source.id),
  channel: 'XTP JP',
  start: 0,
  end: null,
  focusStart: null,
  focusEnd: null,
  vi: '',
  ja: '',
  tokens: [],
  metadataIssue: message
 }];
}

async function expandSource(source) {
 if (source.expanded) return;

 source.expanded = true;

 try {
  const response = await fetchTimed(
   basePath(
    `/api/reels/${encodeURIComponent(source.id)}`
   )
  );

  if (response.status === 404) {
   source.reels = fallbackReel(source);
  } else if (!response.ok) {
   source.reels = fallbackReel(
    source,
    `JSON lỗi HTTP ${response.status}`
   );
  } else {
   const json = await response.json();

   source.reels = normalizeManifest(
    source,
    json
   );
  }
 } catch (e) {
  source.reels = fallbackReel(
   source,
   `Không đọc được JSON: ${e.message}`
  );
 }

 playlist.push(...source.reels);
}

async function ensureAhead(
 minimum = currentIndex + 4
) {
 if (expandPromise) return expandPromise;

 expandPromise = (async () => {
  while (
   playlist.length < minimum &&
   nextSource < sources.length
  ) {
   await expandSource(sources[nextSource++]);
  }
 })();

 try {
  return await expandPromise;
 } finally {
  expandPromise = null;
 }
}

async function readLibrary() {
 const loaded = [];
 let cursor = null;

 for (let page = 0; page < 100; page++) {
  const u = new URL(
   basePath('/api/library')
  );

  if (cursor) {
   u.searchParams.set('cursor', cursor);
  }

  const response = await fetchTimed(
   u.toString(),
   { cache: 'no-store' }
  );

  if (!response.ok) {
   throw new Error(
    `Worker trả HTTP ${response.status}`
   );
  }

  const json = await response.json();

  if (
   !json ||
   !Array.isArray(json.videos)
  ) {
   throw new Error(
    'API thư viện trả dữ liệu không hợp lệ'
   );
  }

  for (const item of json.videos) {
   if (
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(
     item.id
    )
   ) {
    loaded.push({
     id: item.id,
     bytes: Number(item.bytes) || 0,
     uploaded: item.uploaded || '',
     expanded: false,
     reels: null
    });
   }
  }

  if (!json.hasMore) break;

  if (!json.cursor || json.cursor === cursor) {
   throw new Error(
    'Phân trang R2 thiếu cursor hợp lệ'
   );
  }

  cursor = json.cursor;

  if (page === 99) {
   throw new Error(
    'Thư viện quá lớn'
   );
  }
 }

 loaded.sort(
  (a, b) =>
   String(b.uploaded).localeCompare(
    String(a.uploaded)
   )
 );

 return loaded;
}

async function loadAll() {
 bootBegin();
 note('fetch config');

 const generation = ++loadGeneration;

 els.libraryList.replaceChildren();
 els.empty.classList.add('hidden');
 els.reelOverlay.classList.add('hidden');

 clearPanels();
 clearError();
 showLoading();

 try {
  const cfg = await fetchTimed(
   './xtp-config.json',
   { cache: 'no-store' }
  ).then(r => {
   if (!r.ok) {
    throw Error(
     'Không có xtp-config.json'
    );
   }

   return r.json();
  });

  if (
   !/^https:\/\/[\w.-]+(?:\:\d+)?(?:\/[\w-]+)*\/?$/.test(
    String(cfg.mediaBaseUrl || '')
   ) ||
   String(cfg.mediaBaseUrl).includes(
    'REPLACE_'
   )
  ) {
   throw new Error(
    'Chưa cấu hình mediaBaseUrl trong xtp-config.json.'
   );
  }

  mediaBase = cfg.mediaBaseUrl.replace(
   /\/+$/,
   ''
  );

  note('fetch library');

  const loaded = await readLibrary();

  if (generation !== loadGeneration) return;

  sources = loaded;
  playlist = [];
  nextSource = 0;
  currentIndex = 0;
  mode = 'all';

  note(
   'library count',
   String(loaded.length)
  );

  syncTabs();
  renderLibrary();

  if (!sources.length) {
   bootComplete();
   hideLoading();

   showEmpty(
    'Chưa có video',
    'Upload file videos/ten-video.mp4 trên Cloudflare R2 rồi bấm Tải lại thư viện.'
   );

   return;
  }

  await ensureAhead(1);

  if (generation !== loadGeneration) return;

  initialised = true;

  els.reelOverlay.classList.remove('hidden');

  hideLoading();

  note('start first player');

  activate({ instant: true });
 } catch (e) {
  if (generation !== loadGeneration) return;

  hideLoading();

  bootProblem(
   'Không kết nối thư viện: ' +
   String(e.message || e)
  );

  showEmpty(
   'Chưa kết nối được Cloudflare',
   String(e.message || e)
  );
 }
}

function showEmpty(title, description) {
 els.emptyTitle.textContent = title;
 els.emptyText.textContent = description;
 els.empty.classList.remove('hidden');
}

/* ---------------------------------------
   VIDEO PLAYBACK
--------------------------------------- */

function clearPanels() {
 activeEpoch++;
 cancelNextPreload();
 stopAllVideos();

 for (const p of panels.values()) {
  p.video.pause();
  p.video.removeAttribute('src');
  p.video.load();
  p.node.remove();
 }

 panels.clear();
}

function createPanel(reel, index, active) {
 const node = document.createElement('div');

 node.className = 'reel-panel no-transition';
 node.dataset.key = reel.key;

 node.style.transform =
  `translateY(${(index - active) * 100}%)`;

 const video = document.createElement('video');

 video.playsInline = true;

 video.setAttribute('playsinline', '');
 video.setAttribute('webkit-playsinline', '');

 video.controls = false;
 video.autoplay = false;
 video.loop = false;

 video.defaultMuted = muted;
 video.muted = muted;

 if (muted) {
  video.setAttribute('muted', '');
 }

 video.preload = 'none';
 video.playbackRate = speed;

 const panel = {
  node,
  video,
  reel,
  prepared: false,
  error: false,
  loaded: false,
  didPlay: false,
  playPending: false
 };

 node.appendChild(video);
 els.panels.appendChild(node);

 for (const name of [
  'loadstart',
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'stalled',
  'suspend',
  'waiting',
  'playing',
  'abort',
  'emptied'
 ]) {
  video.addEventListener(name, () => {
   if (isCurrentPanel(panel)) {
    note(name);
   }
  });
 }

 const seekStart = () => {
  if (
   panel.prepared ||
   !Number.isFinite(video.duration) ||
   video.duration <= 0
  ) {
   return;
  }

  if (reel.start >= video.duration) {
   panel.error = true;

   if (isCurrentPanel(panel)) {
    showError(
     'Reel bắt đầu sau khi video kết thúc.'
    );
   }

   return;
  }

  if (
   reel.start > 0.05 &&
   Math.abs(
    video.currentTime - reel.start
   ) > 0.18
  ) {
   try {
    video.currentTime = reel.start;
   } catch {}

   return;
  }

  panel.prepared = true;

  if (isCurrentPanel(panel)) {
   updateProgress();
  }
 };

 video.addEventListener(
  'loadedmetadata',
  seekStart
 );

 video.addEventListener(
  'loadeddata',
  seekStart
 );

 video.addEventListener('seeked', () => {
  if (
   !panel.prepared &&
   Math.abs(
    video.currentTime - reel.start
   ) < 0.2
  ) {
   panel.prepared = true;
  }

  if (isCurrentPanel(panel)) {
   updateProgress();
  }
 });

 video.addEventListener(
  'canplay',
  seekStart
 );

 video.addEventListener('play', () => {
  if (!isCurrentPanel(panel)) {
   video.pause();
   return;
  }

  stopOtherVideos(video);
 });

 video.addEventListener('playing', () => {
  if (!isCurrentPanel(panel)) {
   video.pause();
   return;
  }

  panel.didPlay = true;
  panel.playPending = false;

  bootComplete();

  stopOtherVideos(video);

  clearError();
  hideLoading();

  els.tapPlay.classList.add('hidden');

  queueNextPreload(panel);
 });

 video.addEventListener('waiting', () => {
  if (isCurrentPanel(panel)) {
   showLoading();
  }
 });

 video.addEventListener('timeupdate', () => {
  if (!isCurrentPanel(panel)) return;

  const end = reel.end ?? video.duration;

  if (
   Number.isFinite(end) &&
   end > reel.start &&
   video.currentTime >= end - 0.06
  ) {
   video.pause();

   try {
    video.currentTime = reel.start;
   } catch {}

   startActiveVideo();
  } else {
   updateProgress();
  }
 });

 video.addEventListener('ended', () => {
  if (!isCurrentPanel(panel)) return;

  try {
   video.currentTime = reel.start;
  } catch {}

  startActiveVideo();
 });

 video.addEventListener('error', () => {
  panel.error = true;
  panel.playPending = false;

  diagnostic.error =
   'MediaError ' +
   (video.error?.code ?? '-');

  note('media error');

  if (isCurrentPanel(panel)) {
   const code = video.error?.code;

   const reason =
    code === 4
     ? 'Safari không hỗ trợ codec MP4.'
     : code === 3
      ? 'Thiết bị không giải mã được video.'
      : code === 2
       ? 'Lỗi mạng hoặc HTTP Range.'
       : code === 1
        ? 'Yêu cầu tải video bị hủy.'
        : 'Không phát được MP4.';

   showError(
    `${reason} (MediaError ${
     code ?? 'không xác định'
    }; ${mediaDetails()})`
   );
  }
 });

 return panel;
}

function loadPanel(panel, preloadOnly = false) {
 if (!panel || panel.loaded) return;

 panel.loaded = true;

 note(
  'set src',
  panel.reel.sourceId
 );

 panel.video.preload = 'auto';

 panel.video.src = basePath(
  '/media/' +
  encodeURIComponent(
   panel.reel.sourceId
  )
 );

 panel.video.load();
}

/* Only one current player and one next
   player are prepared at a time. */

function updatePanels(instant = false) {
 const view = getView();
 const wanted = new Set();

 const active = activeReel();

 const activePanel =
  active && panels.get(active.key);

 const canPreload = Boolean(
  activePanel?.didPlay &&
  !activePanel.video.paused
 );

 const begin =
  !isiOS && canPreload
   ? Math.max(0, currentIndex - 1)
   : currentIndex;

 const finish = Math.min(
  view.length - 1,
  currentIndex + (canPreload ? 1 : 0)
 );

 for (let i = begin; i <= finish; i++) {
  wanted.add(view[i].key);
 }

 for (const [key, p] of [...panels]) {
  if (!wanted.has(key)) {
   p.video.pause();
   p.video.removeAttribute('src');
   p.video.load();

   p.node.remove();
   panels.delete(key);
  }
 }

 for (let i = begin; i <= finish; i++) {
  const reel = view[i];

  if (!panels.has(reel.key)) {
   panels.set(
    reel.key,
    createPanel(
     reel,
     i,
     currentIndex
    )
   );
  }
 }

 if (instant) {
  for (const p of panels.values()) {
   p.node.classList.add(
    'no-transition'
   );
  }
 }

 requestAnimationFrame(() => {
  for (let i = begin; i <= finish; i++) {
   const p = panels.get(view[i].key);

   if (!p) continue;

   p.node.style.transform =
    `translateY(${(i - currentIndex) * 100}%)`;

   p.node.style.zIndex = String(
    5 - Math.abs(i - currentIndex)
   );
  }

  requestAnimationFrame(() => {
   for (const p of panels.values()) {
    p.node.classList.remove(
     'no-transition'
    );
   }
  });
 });
}

function queueNextPreload(panel) {
 cancelNextPreload();

 const epoch = activeEpoch;

 nextPreloadTimer = setTimeout(async () => {
  nextPreloadTimer = null;

  if (
   epoch !== activeEpoch ||
   !isCurrentPanel(panel) ||
   panel.video.paused ||
   !panel.didPlay
  ) {
   return;
  }

  try {
   if (
    mode === 'all' &&
    currentIndex + 2 > playlist.length &&
    nextSource < sources.length
   ) {
    await ensureAhead(currentIndex + 2);
   }
  } catch (e) {
   toast(
    'Không tải được reel kế tiếp: ' +
    e.message
   );

   return;
  }

  if (
   epoch !== activeEpoch ||
   !isCurrentPanel(panel) ||
   panel.video.paused
  ) {
   return;
  }

  updatePanels(true);

  const next = getView()[
   currentIndex + 1
  ];

  if (next) {
   const pre = panels.get(next.key);

   if (pre && pre !== panel) {
    loadPanel(pre, true);
   }
  }
 }, 400);
}

function startActiveVideo(
 fromGesture = false
) {
 const reel = activeReel();

 if (!reel) return;

 const p = panels.get(reel.key);

 if (!p) return;

 const video = p.video;

 if (p.error) {
  showError(
   'Video tải lỗi. Bấm Thử lại.'
  );

  return;
 }

 wantsPlayback = true;

 stopOtherVideos(video);

 if (document.hidden) {
  resumeOnShow = true;
  return;
 }

 const epoch = activeEpoch;

 video.muted = muted;
 video.playbackRate = speed;

 loadPanel(p, false);

 note(
  'play request',
  fromGesture ? 'tap' : 'auto'
 );

 if (video.paused) {
  showLoading();
 }

 if (
  p.playPending &&
  !fromGesture
 ) {
  return;
 }

 p.playPending = true;

 let attempt;

 try {
  attempt = video.play();
 } catch (err) {
  p.playPending = false;

  handlePlayReject(
   err,
   reel.key
  );

  return;
 }

 if (attempt?.then) {
  attempt.then(() => {
   note('play resolved');

   p.playPending = false;

   if (
    epoch !== activeEpoch ||
    !isCurrentPanel(p)
   ) {
    video.pause();
    return;
   }

   stopOtherVideos(video);

   els.tapPlay.classList.add('hidden');
  }).catch(err => {
   note(
    'play rejected',
    err?.name || 'unknown'
   );

   p.playPending = false;

   if (
    epoch === activeEpoch &&
    isCurrentPanel(p)
   ) {
    handlePlayReject(
     err,
     reel.key
    );
   }
  });
 } else {
  p.playPending = false;
 }
}

function handlePlayReject(err, key) {
 if (
  activeReel()?.key !== key
 ) {
  return;
 }

 if (!bootDone) {
  bootProblem(
   'Safari từ chối phát: ' +
   (err?.name || 'PlayError') +
   ' ' +
   mediaDetails()
  );

  return;
 }

 hideLoading();

 els.tapPlay.classList.remove('hidden');

 if (
  err?.name === 'NotAllowedError' ||
  err?.name === 'AbortError'
 ) {
  return;
 }

 showError(
  'Không thể phát video: ' +
  (err?.name || 'PlayError') +
  (err?.message
   ? ' — ' + err.message
   : '')
 );
}

function activate({
 instant = false
} = {}) {
 note(
  'activate',
  activeReel()?.key || 'none'
 );

 activeEpoch++;
 cancelNextPreload();
 stopAllVideos();

 wantsPlayback = true;

 const reel = activeReel();

 if (!reel) {
  els.reelOverlay.classList.add('hidden');

  clearPanels();

  showEmpty(
   mode === 'saved'
    ? 'Chưa có reel đã lưu'
    : 'Hết video',
   mode === 'saved'
    ? 'Nhấn Lưu để xem lại.'
    : 'Tải lại thư viện.'
  );

  return;
 }

 els.empty.classList.add('hidden');

 els.reelOverlay.classList.remove(
  'hidden'
 );

 clearError();
 hideLoading();

 updatePanels(instant);
 renderReelInfo();
 startActiveVideo();
}

/* ---------------------------------------
   REEL UI
--------------------------------------- */

function renderReelInfo() {
 const reel = activeReel();

 if (!reel) return;

 lang = 'vi';

 els.channelName.textContent =
  reel.channel;

 els.clipTitle.textContent =
  reel.sourceTitle;

 els.reelCount.textContent =
  `${currentIndex + 1} / ${getView().length}` +
  (
   mode === 'all' &&
   nextSource < sources.length
    ? '+'
    : ''
  );

 els.followBtn.textContent =
  following.has(reel.channel)
   ? 'Following'
   : 'Follow';

 els.followBtn.classList.toggle(
  'following',
  following.has(reel.channel)
 );

 const isSaved = saved.has(reel.key);

 els.saveBtn.classList.toggle(
  'saved',
  isSaved
 );

 els.saveText.textContent =
  isSaved ? 'Đã lưu' : 'Lưu';

 els.saveIcon.textContent =
  isSaved ? '♥' : '♡';

 els.speedIcon.textContent =
  speed + '×';

 updateSoundUI();
 renderCaption();
 updateProgress();

 if (reel.metadataIssue) {
  toast(reel.metadataIssue);
 }
}

function renderCaption() {
 const reel = activeReel();

 if (!reel) return;

 els.captionBody.replaceChildren();

 els.caption.classList.toggle(
  'ja-mode',
  lang === 'ja'
 );

 els.captionTag.textContent =
  lang === 'vi' ? 'VI' : 'JP';

 els.captionHint.textContent =
  lang === 'vi'
   ? 'Chạm để xem 日本語'
   : 'Chạm để xem tiếng Việt';

 const hasCaption = Boolean(
  reel.ja || reel.vi
 );

 els.caption.classList.toggle(
  'no-caption',
  !hasCaption
 );

 if (!hasCaption) {
  els.captionBody.textContent =
   'Video gốc — chưa có dữ liệu câu focus.';

  els.captionHint.textContent =
   'Thêm JSON cùng tên MP4 để tạo reel học';

  return;
 }

 if (lang === 'vi') {
  els.captionBody.textContent =
   reel.vi ||
   'Chưa có bản dịch tiếng Việt';

  return;
 }

 if (!reel.tokens.length) {
  els.captionBody.textContent =
   reel.ja || 'Chưa có tiếng Nhật';

  return;
 }

 for (const token of reel.tokens) {
  const span = document.createElement('span');

  span.className = 'jp-token';

  span.dataset.start =
   Number.isFinite(token.start)
    ? String(token.start)
    : '';

  span.dataset.end =
   Number.isFinite(token.end)
    ? String(token.end)
    : '';

  const ruby = document.createElement('ruby');
  const rb = document.createElement('rb');

  rb.textContent = token.hira;
  ruby.appendChild(rb);

  if (token.kanji) {
   const rt = document.createElement('rt');
   rt.textContent = token.kanji;

   ruby.appendChild(rt);
  }

  span.appendChild(ruby);
  els.captionBody.appendChild(span);
 }

 updateHighlight();
}

function updateHighlight() {
 const reel = activeReel();

 if (!reel) return;

 const p = panels.get(reel.key);

 const time =
  p?.video.currentTime ?? reel.start;

 const on =
  reel.focusStart !== null &&
  time >= reel.focusStart &&
  time <= reel.focusEnd;

 els.caption.classList.toggle(
  'focus-now',
  on
 );

 if (lang === 'ja') {
  for (
   const node of
   els.captionBody.querySelectorAll('.jp-token')
  ) {
   const start = Number(node.dataset.start);
   const end = Number(node.dataset.end);

   const timed =
    node.dataset.start !== '' &&
    node.dataset.end !== '' &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start;

   node.classList.toggle(
    'spoken',
    timed &&
    time >= start &&
    time < end
   );
  }
 }
}

function updateProgress() {
 const reel = activeReel();

 if (!reel) return;

 const p = panels.get(reel.key);
 const video = p?.video;

 const end =
  reel.end ??
  (
   Number.isFinite(video?.duration)
    ? video.duration
    : 0
  );

 const span = end - reel.start;

 const time =
  video?.currentTime ?? reel.start;

 const fraction =
  span > 0
   ? Math.min(
      1,
      Math.max(
       0,
       (time - reel.start) / span
      )
     )
   : 0;

 const percent = fraction * 100;

 els.progressFill.style.width =
  percent + '%';

 els.progressThumb.style.left =
  percent + '%';

 els.progressTrack.setAttribute(
  'aria-valuenow',
  String(Math.round(percent))
 );

 els.timeLabel.textContent =
  `${seconds(Math.max(0, time - reel.start))} / ${seconds(span)}`;

 if (
  reel.focusStart !== null &&
  span > 0
 ) {
  els.focusBand.classList.remove(
   'hidden'
  );

  els.focusBand.style.left =
   Math.max(
    0,
    100 *
    (reel.focusStart - reel.start) /
    span
   ) + '%';

  els.focusBand.style.width =
   Math.min(
    100,
    100 *
    (reel.focusEnd - reel.focusStart) /
    span
   ) + '%';
 } else {
  els.focusBand.classList.add(
   'hidden'
  );
 }

 updateHighlight();
}

/* ---------------------------------------
   NAVIGATION AND CONTROLS
--------------------------------------- */

async function go(delta) {
 if (
  !initialised ||
  !els.library.classList.contains('hidden')
 ) {
  return;
 }

 if (
  delta > 0 &&
  mode === 'all' &&
  currentIndex + 1 >= playlist.length &&
  nextSource < sources.length
 ) {
  stopAllVideos();

  await ensureAhead(
   currentIndex + 2
  );
 }

 const target = currentIndex + delta;

 if (target < 0) {
  toast('Đây là reel đầu tiên');
  return;
 }

 if (target >= getView().length) {
  toast('Đã hết reel');
  return;
 }

 stopAllVideos();

 currentIndex = target;

 activate();
}

function togglePlay() {
 const r = activeReel();
 const p = r && panels.get(r.key);

 if (!p) return;

 if (p.video.paused) {
  startActiveVideo(true);
 } else {
  wantsPlayback = false;

  cancelNextPreload();

  p.video.pause();

  els.tapPlay.classList.remove(
   'hidden'
  );
 }
}

function replay() {
 const r = activeReel();
 const p = r && panels.get(r.key);

 if (!p) return;

 clearError();
 p.error = false;

 try {
  p.video.currentTime = r.start;
 } catch {}

 startActiveVideo(true);
}

function seekFraction(f) {
 const r = activeReel();
 const p = r && panels.get(r.key);

 if (!p) return;

 const end = r.end ?? p.video.duration;

 if (
  !Number.isFinite(end) ||
  end <= r.start
 ) {
  return;
 }

 p.video.currentTime =
  r.start +
  Math.min(
   0.999,
   Math.max(0, f)
  ) *
  (end - r.start);

 updateProgress();
}

function updateSoundUI() {
 els.soundIcon.textContent =
  muted ? '♪̸' : '♫';

 els.soundText.textContent =
  muted ? 'Bật tiếng' : 'Tắt tiếng';
}

function syncTabs() {
 els.allTab.classList.toggle(
  'active',
  mode === 'all'
 );

 els.savedTab.classList.toggle(
  'active',
  mode === 'saved'
 );
}

async function switchMode(to) {
 if (mode === to) return;

 const old = activeReel()?.key;

 mode = to;
 syncTabs();

 if (to === 'saved') {
  for (const key of [...saved]) {
   const id = key.split(':')[0];

   const src = sources.find(
    s => s.id === id
   );

   if (src && !src.expanded) {
    await expandSource(src);
   }
  }
 }

 let target = getView().findIndex(
  r => r.key === old
 );

 if (target < 0) target = 0;

 currentIndex = target;

 clearPanels();
 activate({ instant: true });
}

/* ---------------------------------------
   LIBRARY
--------------------------------------- */

function libraryShow() {
 els.library.classList.remove('hidden');

 activeEpoch++;
 cancelNextPreload();
 stopAllVideos();

 renderLibrary();
}

function libraryHide() {
 els.library.classList.add('hidden');

 startActiveVideo(true);
}

function renderLibrary() {
 const query =
  els.searchInput.value
   .trim()
   .toLowerCase();

 const filtered = sources.filter(s =>
  prettyId(s.id)
   .toLowerCase()
   .includes(query)
 );

 const total = sources.reduce(
  (acc, s) => acc + s.bytes,
  0
 );

 els.librarySummary.textContent =
  `${sources.length.toLocaleString('vi-VN')} video • ${bytes(total)} (MP4)`;

 const fragment =
  document.createDocumentFragment();

 if (!filtered.length) {
  const p = document.createElement('p');

  p.style.color = '#b0bac3';
  p.textContent = 'Không tìm thấy video.';

  fragment.appendChild(p);
 }

 for (const src of filtered) {
  const b = document.createElement('button');

  b.type = 'button';
  b.className = 'library-row';

  const poster =
   document.createElement('img');

  poster.className = 'poster';
  poster.loading = 'lazy';
  poster.alt = '';

  poster.src = basePath(
   `/poster/${encodeURIComponent(src.id)}`
  );

  poster.addEventListener(
   'error',
   () => {
    const fall =
     document.createElement('div');

    fall.className = 'poster';
    fall.textContent = '▶';

    poster.replaceWith(fall);
   },
   { once: true }
  );

  const data =
   document.createElement('div');

  data.className = 'lib-meta';

  const title =
   document.createElement('div');

  title.className = 'lib-title';

  title.textContent = prettyId(
   src.id
  );

  const sub =
   document.createElement('div');

  sub.className = 'lib-sub';

  sub.textContent =
   `${bytes(src.bytes)} • ` +
   (
    src.reels
     ? src.reels.length + ' reel'
     : 'Chạm để xem'
   );

  data.append(title, sub);

  const arrow =
   document.createElement('span');

  arrow.className = 'lib-arrow';
  arrow.textContent = '›';

  b.append(poster, data, arrow);

  b.addEventListener('click', async () => {
   b.disabled = true;

   try {
    if (!src.expanded) {
     await expandSource(src);
    }

    if (mode === 'saved') {
     mode = 'all';
     syncTabs();
    }

    const first = playlist.findIndex(
     reel => reel.sourceId === src.id
    );

    if (first < 0) {
     throw Error(
      'Không thể mở video'
     );
    }

    currentIndex = first;

    clearPanels();
    libraryHide();

    activate({ instant: true });
   } catch (e) {
    toast(e.message);
   } finally {
    b.disabled = false;
   }
  });

  fragment.appendChild(b);
 }

 els.libraryList.replaceChildren(
  fragment
 );
}

/* ---------------------------------------
   EVENTS
--------------------------------------- */

function hookEvents() {
 els.gesture.addEventListener(
  'pointerdown',
  e => {
   els.gesture._start = {
    y: e.clientY,
    x: e.clientX,
    time: Date.now()
   };
  }
 );

 els.gesture.addEventListener(
  'pointerup',
  e => {
   const a = els.gesture._start;

   if (!a) return;

   els.gesture._start = null;

   const dy = e.clientY - a.y;
   const dx = e.clientX - a.x;

   if (
    Math.abs(dy) > 55 &&
    Math.abs(dy) > Math.abs(dx) * 1.2
   ) {
    go(dy < 0 ? 1 : -1);
    return;
   }

   if (
    Math.abs(dy) < 12 &&
    Math.abs(dx) < 12 &&
    Date.now() - a.time < 700
   ) {
    togglePlay();
   }
  }
 );

 let lastWheel = 0;

 els.gesture.addEventListener(
  'wheel',
  e => {
   e.preventDefault();

   if (
    Date.now() - lastWheel < 480
   ) {
    return;
   }

   lastWheel = Date.now();

   go(e.deltaY > 0 ? 1 : -1);
  },
  { passive: false }
 );

 document.addEventListener(
  'keydown',
  e => {
   if (
    !els.library.classList.contains('hidden')
   ) {
    if (e.key === 'Escape') {
     libraryHide();
    }

    return;
   }

   if (
    ['INPUT', 'TEXTAREA'].includes(
     document.activeElement?.tagName
    )
   ) {
    return;
   }

   if (e.key === 'ArrowDown') {
    e.preventDefault();
    go(1);
   }

   if (e.key === 'ArrowUp') {
    e.preventDefault();
    go(-1);
   }

   if (
    e.key === ' ' &&
    document.activeElement?.tagName !== 'BUTTON'
   ) {
    e.preventDefault();
    togglePlay();
   }
  }
 );

 els.noticeRetry.addEventListener(
  'click',
  () => {
   const r = activeReel();
   const p = r && panels.get(r.key);

   if (!p) return;

   clearError();

   p.video.pause();
   p.video.removeAttribute('src');
   p.video.load();

   p.loaded = false;
   p.error = false;
   p.prepared = false;
   p.playPending = false;
   p.didPlay = false;

   startActiveVideo(true);
  }
 );

 els.tapPlayBtn.addEventListener(
  'click',
  () => startActiveVideo(true)
 );

 els.emptyRefresh.addEventListener(
  'click',
  loadAll
 );

 els.replayBtn.addEventListener(
  'click',
  replay
 );

 els.caption.addEventListener(
  'click',
  () => {
   lang =
    lang === 'vi' ? 'ja' : 'vi';

   renderCaption();
  }
 );

 els.saveBtn.addEventListener(
  'click',
  () => {
   const r = activeReel();

   if (!r) return;

   if (saved.has(r.key)) {
    saved.delete(r.key);
   } else {
    saved.add(r.key);
   }

   persist(
    'xtp-jp-saved-v13',
    saved
   );

   if (
    mode === 'saved' &&
    !saved.has(r.key)
   ) {
    currentIndex = Math.max(
     0,
     currentIndex - 1
    );

    clearPanels();
    activate({ instant: true });
   } else {
    renderReelInfo();
   }
  }
 );

 els.followBtn.addEventListener(
  'click',
  () => {
   const r = activeReel();

   if (!r) return;

   if (following.has(r.channel)) {
    following.delete(r.channel);
   } else {
    following.add(r.channel);
   }

   persist(
    'xtp-jp-follow-v13',
    following
   );

   renderReelInfo();
  }
 );

 els.speedBtn.addEventListener(
  'click',
  () => {
   speed = rates[
    (rates.indexOf(speed) + 1) %
    rates.length
   ];

   for (const p of panels.values()) {
    p.video.playbackRate = speed;
   }

   els.speedIcon.textContent =
    speed + '×';
  }
 );

 els.soundBtn.addEventListener(
  'click',
  () => {
   muted = !muted;

   for (const p of panels.values()) {
    p.video.muted = muted;
   }

   updateSoundUI();

   const p =
    activeReel() &&
    panels.get(activeReel().key);

   if (p?.video.paused) {
    startActiveVideo(true);
   }
  }
 );

 els.progressTrack.addEventListener(
  'pointerdown',
  e => {
   e.stopPropagation();

   seekFraction(
    (
     e.clientX -
     els.progressTrack
      .getBoundingClientRect().left
    ) /
    els.progressTrack.clientWidth
   );
  }
 );

 els.progressTrack.addEventListener(
  'keydown',
  e => {
   if (
    e.key !== 'ArrowRight' &&
    e.key !== 'ArrowLeft'
   ) {
    return;
   }

   e.preventDefault();

   const r = activeReel();
   const p = r && panels.get(r.key);

   if (!p) return;

   const end =
    r.end ?? p.video.duration;

   if (!Number.isFinite(end)) {
    return;
   }

   const f =
    (
     p.video.currentTime -
     r.start
    ) /
    (end - r.start) +
    (
     e.key === 'ArrowRight'
      ? 0.05
      : -0.05
    );

   seekFraction(f);
  }
 );

 els.libraryBtn.addEventListener(
  'click',
  libraryShow
 );

 els.libraryClose.addEventListener(
  'click',
  libraryHide
 );

 els.refreshBtn.addEventListener(
  'click',
  async () => {
   els.library.classList.add(
    'hidden'
   );

   els.searchInput.value = '';

   await loadAll();

   els.library.classList.remove(
    'hidden'
   );
  }
 );

 els.searchInput.addEventListener(
  'input',
  renderLibrary
 );

 els.allTab.addEventListener(
  'click',
  () => switchMode('all')
 );

 els.savedTab.addEventListener(
  'click',
  () => switchMode('saved')
 );

 document.addEventListener(
  'visibilitychange',
  () => {
   note(
    'visibility',
    document.visibilityState
   );

   if (document.hidden) {
    const reel = activeReel();

    const panel =
     reel &&
     panels.get(reel.key);

    resumeOnShow =
     resumeOnShow ||
     (
      wantsPlayback &&
      Boolean(
       (panel && !panel.video.paused) ||
       panel?.playPending
      )
     );

    activeEpoch++;
    cancelNextPreload();
    stopAllVideos();
    hideLoading();
   } else if (resumeOnShow) {
    resumeOnShow = false;

    requestAnimationFrame(
     () => startActiveVideo()
    );
   }
  }
 );

 window.addEventListener(
  'pagehide',
  () => {
   activeEpoch++;
   cancelNextPreload();
   stopAllVideos();
  }
 );

 window.addEventListener(
  'pageshow',
  event => {
   if (
    event.persisted &&
    !document.hidden &&
    els.library.classList.contains('hidden')
   ) {
    requestAnimationFrame(
     () => startActiveVideo()
    );
   }
  }
 );
}

/* ---------------------------------------
   START APPLICATION
--------------------------------------- */

createBoot();
hookEvents();
disableOldShellCache();
loadAll();

})();
