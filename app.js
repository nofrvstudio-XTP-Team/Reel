
/* XTP JP v13.11
 * Clock-verified preload and bounded decoder recovery.
 * Media: Cloudflare R2 via Worker.
 */
(() => {
'use strict';

const $ = id => document.getElementById(id);

const els = Object.fromEntries([
 'panels','gesture','reelOverlay','loadingIndicator',
 'notice','noticeText','noticeRetry','empty',
 'emptyTitle','emptyText','emptyRefresh','channelName',
 'clipTitle','followBtn','caption','captionTag',
 'captionBody','captionHint','replayBtn','saveBtn',
 'saveIcon','saveText','speedBtn','speedIcon',
 'soundBtn','soundIcon','soundText','progressTrack',
 'progressFill','progressThumb','focusBand',
 'reelCount','timeLabel','tapPlay','tapPlayBtn',
 'toast','allTab','savedTab','library','libraryBtn',
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
let speed = 1;
let lang = 'vi';

let activeEpoch = 0;
let resumeOnShow = false;
let nextPreloadTimer = null;
let wantsPlayback = true;

let loadingTimer = null;
let loadingFor = null;
let toastTimer = null;

const isiOS =
 /iPad|iPhone|iPod/.test(navigator.userAgent) ||
 (
  navigator.platform === 'MacIntel' &&
  navigator.maxTouchPoints > 1
 );

const rates = [0.75, 1, 1.25, 1.5];

const saved = readSet('xtp-jp-saved-v13');
const following = readSet('xtp-jp-follow-v13');

/* ========================================
   VIDEO STATE AND RECOVERY
======================================== */

const clockRetries = new Map();
const MEDIA_STALL_MS = 5200;
const CLOCK_STEP = 0.07;

let recoveryBusy = false;

function cancelNextPreload() {
 clearTimeout(nextPreloadTimer);
 nextPreloadTimer = null;
}

function isCurrentPanel(panel) {
 return Boolean(
  panel &&
  panels.get(panel.reel.key) === panel &&
  activeReel()?.key === panel.reel.key &&
  els.library.classList.contains('hidden') &&
  !document.hidden
 );
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

function clearClock(panel) {
 if (!panel) return;

 panel.clockTime = null;
 panel.clockAt = performance.now();
 panel.progressSteps = 0;
}

function logRecovery(message) {
 console.warn('[XTP JP v13.11]', message);
 toast(message);
}

function disposePanel(panel) {
 if (!panel) return;

 try {
  panel.video.pause();
  panel.video.removeAttribute('src');
  panel.video.load();
 } catch {}

 panel.node.remove();
 panels.delete(panel.reel.key);
}

function releaseOtherPreloads(active) {
 cancelNextPreload();

 for (const p of [...panels.values()]) {
  if (p !== active) {
   disposePanel(p);
  }
 }
}

/*
 Recovery sequence:

 1. Free speculative preload and wake
    the existing decoder.

 2. If clock is still frozen, replace
    the native video element and retry
    the media URL with a cache-busting
    query parameter.

 Never retry indefinitely.
*/

function recoverClock(panel) {
 if (
  recoveryBusy ||
  !isCurrentPanel(panel) ||
  document.hidden ||
  !wantsPlayback
 ) {
  return;
 }

 const key = panel.reel.key;
 const count = clockRetries.get(key) || 0;

 if (count >= 2) {
  wantsPlayback = false;

  panel.video.pause();

  hideLoading();

  showError(
   'Video đã tải đủ nhưng đồng hồ vẫn đứng. ' +
   'Đã thử khôi phục 2 lần. ' +
   'Bấm Thử lại hoặc kiểm tra MP4 trực tiếp trong Safari.'
  );

  return;
 }

 clockRetries.set(key, count + 1);

 recoveryBusy = true;

 // Release only speculative media.
 // The active player is preserved
 // during the first recovery attempt.
 releaseOtherPreloads(panel);

 panel.didAdvance = false;
 panel.preloadQueued = false;

 const epoch = activeEpoch;

 if (count === 0) {
  logRecovery(
   'Video đứng: giải phóng preload ' +
   'và khôi phục decoder (1/2)'
  );

  const video = panel.video;

  try {
   video.pause();

   const end =
    panel.reel.end ?? video.duration;

   const target = Math.max(
    panel.reel.start + 0.15,
    video.currentTime + 0.15
   );

   if (
    Number.isFinite(end) &&
    target < end - 0.2
   ) {
    video.currentTime = target;
   }
  } catch {}

  panel.playPending = false;
  clearClock(panel);

  setTimeout(() => {
   recoveryBusy = false;

   if (
    epoch === activeEpoch &&
    isCurrentPanel(panel)
   ) {
    startActiveVideo();
   }
  }, 300);

 } else {
  logRecovery(
   'Video vẫn đứng: tạo lại player ' +
   'và tải URL media mới (2/2)'
  );

  const reel = panel.reel;

  disposePanel(panel);

  const fresh = createPanel(
   reel,
   currentIndex,
   currentIndex
  );

  fresh.freshMedia = true;

  panels.set(key, fresh);

  clearClock(fresh);

  recoveryBusy = false;

  if (
   epoch === activeEpoch &&
   isCurrentPanel(fresh)
  ) {
   startActiveVideo();
  }
 }
}

/*
 Monitor real media-clock movement.

 A playing event is insufficient:
 Safari may report paused=false,
 readyState=4 and playing while
 currentTime remains frozen.
*/

setInterval(() => {
 if (
  recoveryBusy ||
  !initialised ||
  document.hidden ||
  !els.library.classList.contains('hidden')
 ) {
  return;
 }

 const reel = activeReel();

 const panel =
  reel && panels.get(reel.key);

 if (
  !panel ||
  panel.error ||
  !wantsPlayback ||
  !panel.loaded
 ) {
  return;
 }

 const video = panel.video;
 const now = performance.now();

 if (
  video.paused ||
  video.ended ||
  video.seeking ||
  video.readyState < 2
 ) {
  clearClock(panel);
  return;
 }

 if (
  panel.lastSeekAt &&
  now - panel.lastSeekAt < 900
 ) {
  clearClock(panel);
  return;
 }

 if (panel.clockTime === null) {
  panel.clockTime = video.currentTime;
  panel.clockAt = now;
  return;
 }

 const delta =
  video.currentTime - panel.clockTime;

 if (delta >= CLOCK_STEP) {
  panel.progressSteps++;
  panel.clockAt = now;
  panel.clockTime = video.currentTime;

  /*
   Two observations of clock movement
   are required before preload starts.
  */

  if (panel.progressSteps >= 2) {
   clockRetries.delete(panel.reel.key);

   if (!panel.didAdvance) {
    panel.didAdvance = true;

    queueNextPreload(panel);
   }
  }

 } else if (delta < -0.1) {
  // A seek or reel loop changed time.
  clearClock(panel);

 } else if (
  now - panel.clockAt >= MEDIA_STALL_MS
 ) {
  clearClock(panel);
  recoverClock(panel);
 }

}, 1000);

/* ========================================
   UTILITIES
======================================== */

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

 const key =
  activeReel()?.key || 'library';

 if (
  loadingTimer &&
  loadingFor === key
 ) {
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

  const panel = panels.get(key);

  if (
   panel &&
   panel.video.readyState >= 2 &&
   panel.prepared
  ) {
   els.loadingIndicator.classList.add(
    'hidden'
   );
  } else {
   showError(
    'Video không tải kịp. ' +
    'Kiểm tra MP4 và HTTP Range.'
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

/* ========================================
   REEL METADATA
======================================== */

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
     })).filter(token => token.hira)
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

 } catch (error) {
  source.reels = fallbackReel(
   source,
   'Không đọc được JSON: ' + error.message
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
  const url = new URL(
   basePath('/api/library')
  );

  if (cursor) {
   url.searchParams.set(
    'cursor',
    cursor
   );
  }

  const response = await fetchTimed(
   url.toString(),
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

  if (
   !json.cursor ||
   json.cursor === cursor
  ) {
   throw new Error(
    'Phân trang R2 thiếu cursor hợp lệ'
   );
  }

  cursor = json.cursor;

  if (page === 99) {
   throw new Error(
    'Thư viện vượt giới hạn phiên'
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
 const generation = ++loadGeneration;

 els.libraryList.replaceChildren();

 els.empty.classList.add('hidden');
 els.reelOverlay.classList.add('hidden');

 clearPanels();
 clearError();
 showLoading();

 try {
  const config = await fetchTimed(
   './xtp-config.json',
   { cache: 'no-store' }
  ).then(response => {
   if (!response.ok) {
    throw Error(
     'Không có xtp-config.json'
    );
   }

   return response.json();
  });

  if (
   !/^https:\/\/[\w.-]+(?:\:\d+)?(?:\/[\w-]+)*\/?$/.test(
    String(config.mediaBaseUrl || '')
   ) ||
   String(config.mediaBaseUrl).includes(
    'REPLACE_'
   )
  ) {
   throw new Error(
    'Chưa cấu hình mediaBaseUrl'
   );
  }

  mediaBase = config.mediaBaseUrl.replace(
   /\/+$/,
   ''
  );

  const loaded = await readLibrary();

  if (generation !== loadGeneration) {
   return;
  }

  sources = loaded;
  playlist = [];
  nextSource = 0;
  currentIndex = 0;
  mode = 'all';

  syncTabs();
  renderLibrary();

  if (!sources.length) {
   hideLoading();

   showEmpty(
    'Chưa có video',
    'Upload MP4 lên Cloudflare R2 rồi tải lại thư viện.'
   );

   return;
  }

  await ensureAhead(1);

  if (generation !== loadGeneration) {
   return;
  }

  initialised = true;

  els.reelOverlay.classList.remove(
   'hidden'
  );

  hideLoading();

  activate({ instant: true });

 } catch (error) {
  if (generation !== loadGeneration) {
   return;
  }

  hideLoading();

  showEmpty(
   'Chưa kết nối được Cloudflare',
   String(error.message || error)
  );
 }
}

function showEmpty(title, description) {
 els.emptyTitle.textContent = title;
 els.emptyText.textContent = description;
 els.empty.classList.remove('hidden');
}

/* ========================================
   NATIVE VIDEO PLAYER
======================================== */

function clearPanels() {
 activeEpoch++;
 cancelNextPreload();
 stopAllVideos();

 for (const panel of [...panels.values()]) {
  disposePanel(panel);
 }

 panels.clear();
}

function createPanel(reel, index, active) {
 const node = document.createElement('div');

 node.className =
  'reel-panel no-transition';

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
  didAdvance: false,
  preloadQueued: false,
  playPending: false,

  clockTime: null,
  clockAt: performance.now(),
  progressSteps: 0,
  lastSeekAt: 0,

  freshMedia: false
 };

 node.appendChild(video);
 els.panels.appendChild(node);

 function seekStart() {
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
     'Timestamp của reel nằm ngoài video.'
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
 }

 video.addEventListener(
  'loadedmetadata',
  seekStart
 );

 video.addEventListener(
  'loadeddata',
  seekStart
 );

 video.addEventListener('seeking', () => {
  panel.lastSeekAt = performance.now();
  clearClock(panel);
 });

 video.addEventListener('seeked', () => {
  panel.lastSeekAt = performance.now();
  clearClock(panel);

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

  stopOtherVideos(video);

  clearError();
  hideLoading();

  els.tapPlay.classList.add('hidden');

  /*
   DO NOT PRELOAD HERE.

   Safari can emit playing while
   currentTime is frozen.

   Preload is scheduled only after
   the clock monitor observes progress.
  */
 });

 video.addEventListener('waiting', () => {
  if (isCurrentPanel(panel)) {
   showLoading();
  }
 });

 video.addEventListener('timeupdate', () => {
  if (!isCurrentPanel(panel)) return;

  const end =
   reel.end ?? video.duration;

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

  if (!isCurrentPanel(panel)) return;

  const code = video.error?.code;

  const reason =
   code === 4
    ? 'Safari không hỗ trợ định dạng video.'
    : code === 3
     ? 'Thiết bị không giải mã được MP4.'
     : code === 2
      ? 'Lỗi mạng hoặc HTTP Range.'
      : code === 1
       ? 'Yêu cầu tải video bị hủy.'
       : 'Không thể phát MP4.';

  showError(
   `${reason} (MediaError ${
    code ?? 'không xác định'
   })`
  );
 });

 return panel;
}

function loadPanel(
 panel,
 preloadOnly = false
) {
 if (
  !panel ||
  panel.loaded
 ) {
  return;
 }

 panel.loaded = true;

 panel.video.preload = 'auto';

 let url = basePath(
  '/media/' +
  encodeURIComponent(
   panel.reel.sourceId
  )
 );

 /*
  Only change the media URL when
  rebuilding a stuck native decoder.
 */

 if (panel.freshMedia) {
  url +=
   '?xtp_retry=' +
   Date.now().toString(36);
 }

 panel.video.src = url;
 panel.video.load();
}

/* ========================================
   PANEL MANAGEMENT AND PRELOAD
======================================== */

function updatePanels(
 instant = false
) {
 const view = getView();
 const wanted = new Set();

 const active = activeReel();

 const activePanel =
  active && panels.get(active.key);

 const canPreload = Boolean(
  activePanel?.didAdvance &&
  !activePanel.video.paused
 );

 /*
  iOS: current + next.

  Desktop: previous + current + next.

  Only the active video is allowed
  to play. Next is network preload only.
 */

 const begin =
  !isiOS && canPreload
   ? Math.max(0, currentIndex - 1)
   : currentIndex;

 const finish = Math.min(
  view.length - 1,
  currentIndex +
  (canPreload ? 1 : 0)
 );

 for (
  let i = begin;
  i <= finish;
  i++
 ) {
  wanted.add(view[i].key);
 }

 for (const [key, panel] of [...panels]) {
  if (!wanted.has(key)) {
   disposePanel(panel);
  }
 }

 for (
  let i = begin;
  i <= finish;
  i++
 ) {
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
  for (const panel of panels.values()) {
   panel.node.classList.add(
    'no-transition'
   );
  }
 }

 requestAnimationFrame(() => {
  for (
   let i = begin;
   i <= finish;
   i++
  ) {
   const panel =
    panels.get(view[i].key);

   if (!panel) continue;

   panel.node.style.transform =
    `translateY(${(i - currentIndex) * 100}%)`;

   panel.node.style.zIndex = String(
    5 - Math.abs(i - currentIndex)
   );
  }

  requestAnimationFrame(() => {
   for (const panel of panels.values()) {
    panel.node.classList.remove(
     'no-transition'
    );
   }
  });
 });
}

/*
 Preload remains enabled.

 It starts only after two observations
 of real currentTime progression.
*/

function queueNextPreload(panel) {
 if (panel.preloadQueued) return;

 panel.preloadQueued = true;

 cancelNextPreload();

 const epoch = activeEpoch;

 nextPreloadTimer = setTimeout(async () => {
  nextPreloadTimer = null;

  if (
   epoch !== activeEpoch ||
   !isCurrentPanel(panel) ||
   panel.video.paused ||
   !panel.didAdvance
  ) {
   return;
  }

  try {
   if (
    mode === 'all' &&
    currentIndex + 2 > playlist.length &&
    nextSource < sources.length
   ) {
    await ensureAhead(
     currentIndex + 2
    );
   }

  } catch (error) {
   toast(
    'Không tải được dữ liệu reel kế tiếp: ' +
    error.message
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

  const next =
   getView()[currentIndex + 1];

  if (!next) return;

  const pre = panels.get(next.key);

  if (
   pre &&
   pre !== panel
  ) {
   // Network preload only.
   // Never play the next video here.
   loadPanel(pre, true);
  }

 }, 400);
}

/* ========================================
   PLAYBACK
======================================== */

function startActiveVideo(
 fromGesture = false
) {
 const reel = activeReel();

 if (!reel) return;

 const panel = panels.get(reel.key);

 if (!panel) return;

 const video = panel.video;

 if (panel.error) {
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

 loadPanel(panel, false);

 if (video.paused) {
  showLoading();
 }

 if (
  panel.playPending &&
  !fromGesture
 ) {
  return;
 }

 panel.playPending = true;

 let attempt;

 try {
  attempt = video.play();

 } catch (error) {
  panel.playPending = false;

  handlePlayReject(
   error,
   reel.key
  );

  return;
 }

 if (attempt?.then) {
  attempt.then(() => {
   panel.playPending = false;

   if (
    epoch !== activeEpoch ||
    !isCurrentPanel(panel)
   ) {
    video.pause();
    return;
   }

   stopOtherVideos(video);

   els.tapPlay.classList.add(
    'hidden'
   );

  }).catch(error => {
   panel.playPending = false;

   if (
    epoch === activeEpoch &&
    isCurrentPanel(panel)
   ) {
    handlePlayReject(
     error,
     reel.key
    );
   }
  });

 } else {
  panel.playPending = false;
 }
}

function handlePlayReject(error, key) {
 if (
  activeReel()?.key !== key
 ) {
  return;
 }

 hideLoading();

 els.tapPlay.classList.remove(
  'hidden'
 );

 if (
  error?.name === 'NotAllowedError' ||
  error?.name === 'AbortError'
 ) {
  return;
 }

 showError(
  'Không thể phát video: ' +
  (error?.name || 'PlayError') +
  (
   error?.message
    ? ' — ' + error.message
    : ''
  )
 );
}

function activate({
 instant = false
} = {}) {
 recoveryBusy = false;
 activeEpoch++;

 cancelNextPreload();
 stopAllVideos();

 wantsPlayback = true;

 const reel = activeReel();

 if (!reel) {
  els.reelOverlay.classList.add(
   'hidden'
  );

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

/* ========================================
   UI
======================================== */

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

 const isSaved =
  saved.has(reel.key);

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
   reel.ja ||
   'Chưa có tiếng Nhật';

  return;
 }

 for (const token of reel.tokens) {
  const span =
   document.createElement('span');

  span.className = 'jp-token';

  span.dataset.start =
   Number.isFinite(token.start)
    ? String(token.start)
    : '';

  span.dataset.end =
   Number.isFinite(token.end)
    ? String(token.end)
    : '';

  const ruby =
   document.createElement('ruby');

  const rb =
   document.createElement('rb');

  rb.textContent = token.hira;
  ruby.appendChild(rb);

  if (token.kanji) {
   const rt =
    document.createElement('rt');

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

 const panel = panels.get(reel.key);

 const time =
  panel?.video.currentTime ??
  reel.start;

 const focused =
  reel.focusStart !== null &&
  time >= reel.focusStart &&
  time <= reel.focusEnd;

 els.caption.classList.toggle(
  'focus-now',
  focused
 );

 if (lang === 'ja') {
  for (
   const node of
   els.captionBody.querySelectorAll('.jp-token')
  ) {
   const start =
    Number(node.dataset.start);

   const end =
    Number(node.dataset.end);

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

 const panel = panels.get(reel.key);
 const video = panel?.video;

 const end =
  reel.end ??
  (
   Number.isFinite(video?.duration)
    ? video.duration
    : 0
  );

 const span = end - reel.start;

 const time =
  video?.currentTime ??
  reel.start;

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

/* ========================================
   NAVIGATION
======================================== */

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

 const target =
  currentIndex + delta;

 if (target < 0) {
  toast('Đây là reel đầu tiên');
  return;
 }

 if (
  target >= getView().length
 ) {
  toast('Đã hết reel');
  return;
 }

 stopAllVideos();

 currentIndex = target;

 activate();
}

function togglePlay() {
 const reel = activeReel();

 const panel =
  reel && panels.get(reel.key);

 if (!panel) return;

 if (panel.video.paused) {
  startActiveVideo(true);

 } else {
  wantsPlayback = false;

  cancelNextPreload();

  panel.video.pause();

  els.tapPlay.classList.remove(
   'hidden'
  );
 }
}

function replay() {
 const reel = activeReel();

 const panel =
  reel && panels.get(reel.key);

 if (!panel) return;

 clearError();

 panel.error = false;
 clearClock(panel);

 try {
  panel.video.currentTime =
   reel.start;
 } catch {}

 startActiveVideo(true);
}

function seekFraction(fraction) {
 const reel = activeReel();

 const panel =
  reel && panels.get(reel.key);

 if (!panel) return;

 const end =
  reel.end ??
  panel.video.duration;

 if (
  !Number.isFinite(end) ||
  end <= reel.start
 ) {
  return;
 }

 panel.video.currentTime =
  reel.start +
  Math.min(
   0.999,
   Math.max(0, fraction)
  ) *
  (end - reel.start);

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

 const old =
  activeReel()?.key;

 mode = to;
 syncTabs();

 if (to === 'saved') {
  for (const key of [...saved]) {
   const id = key.split(':')[0];

   const source = sources.find(
    s => s.id === id
   );

   if (
    source &&
    !source.expanded
   ) {
    await expandSource(source);
   }
  }
 }

 let target = getView().findIndex(
  reel => reel.key === old
 );

 if (target < 0) target = 0;

 currentIndex = target;

 clearPanels();

 activate({
  instant: true
 });
}

/* ========================================
   LIBRARY
======================================== */

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

 const filtered = sources.filter(
  source =>
   prettyId(source.id)
    .toLowerCase()
    .includes(query)
 );

 const total = sources.reduce(
  (sum, source) =>
   sum + source.bytes,
  0
 );

 els.librarySummary.textContent =
  `${sources.length.toLocaleString('vi-VN')} video • ${bytes(total)} (MP4)`;

 const fragment =
  document.createDocumentFragment();

 if (!filtered.length) {
  const p =
   document.createElement('p');

  p.style.color = '#b0bac3';
  p.textContent = 'Không tìm thấy video.';

  fragment.appendChild(p);
 }

 for (const source of filtered) {
  const button =
   document.createElement('button');

  button.type = 'button';
  button.className = 'library-row';

  const poster =
   document.createElement('img');

  poster.className = 'poster';
  poster.loading = 'lazy';
  poster.alt = '';

  poster.src = basePath(
   `/poster/${encodeURIComponent(source.id)}`
  );

  poster.addEventListener(
   'error',
   () => {
    const fallback =
     document.createElement('div');

    fallback.className = 'poster';
    fallback.textContent = '▶';

    poster.replaceWith(fallback);
   },
   { once: true }
  );

  const data =
   document.createElement('div');

  data.className = 'lib-meta';

  const title =
   document.createElement('div');

  title.className = 'lib-title';

  title.textContent =
   prettyId(source.id);

  const sub =
   document.createElement('div');

  sub.className = 'lib-sub';

  sub.textContent =
   `${bytes(source.bytes)} • ` +
   (
    source.reels
     ? source.reels.length + ' reel'
     : 'Chạm để xem'
   );

  data.append(title, sub);

  const arrow =
   document.createElement('span');

  arrow.className = 'lib-arrow';
  arrow.textContent = '›';

  button.append(poster, data, arrow);

  button.addEventListener(
   'click',
   async () => {
    button.disabled = true;

    try {
     if (!source.expanded) {
      await expandSource(source);
     }

     const first =
      playlist.findIndex(
       reel =>
        reel.sourceId === source.id
      );

     if (first < 0) {
      throw Error(
       'Không thể mở video'
      );
     }

     if (mode === 'saved') {
      mode = 'all';
      syncTabs();
     }

     currentIndex = first;

     clearPanels();
     libraryHide();

     activate({
      instant: true
     });

    } catch (error) {
     toast(error.message);

    } finally {
     button.disabled = false;
    }
   }
  );

  fragment.appendChild(button);
 }

 els.libraryList.replaceChildren(
  fragment
 );
}

/* ========================================
   EVENTS
======================================== */

function hookEvents() {
 els.gesture.addEventListener(
  'pointerdown',
  event => {
   els.gesture._start = {
    y: event.clientY,
    x: event.clientX,
    time: Date.now()
   };
  }
 );

 els.gesture.addEventListener(
  'pointerup',
  event => {
   const start =
    els.gesture._start;

   if (!start) return;

   els.gesture._start = null;

   const dy =
    event.clientY - start.y;

   const dx =
    event.clientX - start.x;

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
    Date.now() - start.time < 700
   ) {
    togglePlay();
   }
  }
 );

 let lastWheel = 0;

 els.gesture.addEventListener(
  'wheel',
  event => {
   event.preventDefault();

   if (
    Date.now() - lastWheel < 480
   ) {
    return;
   }

   lastWheel = Date.now();

   go(
    event.deltaY > 0 ? 1 : -1
   );
  },
  { passive: false }
 );

 document.addEventListener(
  'keydown',
  event => {
   if (
    !els.library.classList.contains('hidden')
   ) {
    if (event.key === 'Escape') {
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

   if (event.key === 'ArrowDown') {
    event.preventDefault();
    go(1);
   }

   if (event.key === 'ArrowUp') {
    event.preventDefault();
    go(-1);
   }

   if (
    event.key === ' ' &&
    document.activeElement?.tagName !== 'BUTTON'
   ) {
    event.preventDefault();
    togglePlay();
   }
  }
 );

 els.noticeRetry.addEventListener(
  'click',
  () => {
   const reel = activeReel();

   const panel =
    reel && panels.get(reel.key);

   if (!panel) return;

   clearError();

   panel.video.pause();

   panel.video.removeAttribute(
    'src'
   );

   panel.video.load();

   panel.loaded = false;
   panel.error = false;
   panel.prepared = false;
   panel.playPending = false;
   panel.didPlay = false;
   panel.didAdvance = false;
   panel.preloadQueued = false;

   clockRetries.delete(reel.key);

   clearClock(panel);

   recoveryBusy = false;

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
   const reel = activeReel();

   if (!reel) return;

   if (saved.has(reel.key)) {
    saved.delete(reel.key);
   } else {
    saved.add(reel.key);
   }

   persist(
    'xtp-jp-saved-v13',
    saved
   );

   if (
    mode === 'saved' &&
    !saved.has(reel.key)
   ) {
    currentIndex = Math.max(
     0,
     currentIndex - 1
    );

    clearPanels();

    activate({
     instant: true
    });

   } else {
    renderReelInfo();
   }
  }
 );

 els.followBtn.addEventListener(
  'click',
  () => {
   const reel = activeReel();

   if (!reel) return;

   if (
    following.has(reel.channel)
   ) {
    following.delete(reel.channel);
   } else {
    following.add(reel.channel);
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

   for (const panel of panels.values()) {
    panel.video.playbackRate = speed;
   }

   els.speedIcon.textContent =
    speed + '×';
  }
 );

 els.soundBtn.addEventListener(
  'click',
  () => {
   muted = !muted;

   for (const panel of panels.values()) {
    panel.video.muted = muted;
   }

   updateSoundUI();

   const reel = activeReel();

   const panel =
    reel && panels.get(reel.key);

   if (
    panel &&
    panel.video.paused
   ) {
    startActiveVideo(true);
   }
  }
 );

 els.progressTrack.addEventListener(
  'pointerdown',
  event => {
   event.stopPropagation();

   seekFraction(
    (
     event.clientX -
     els.progressTrack
      .getBoundingClientRect().left
    ) /
    els.progressTrack.clientWidth
   );
  }
 );

 els.progressTrack.addEventListener(
  'keydown',
  event => {
   if (
    event.key !== 'ArrowRight' &&
    event.key !== 'ArrowLeft'
   ) {
    return;
   }

   event.preventDefault();

   const reel = activeReel();

   const panel =
    reel && panels.get(reel.key);

   if (!panel) return;

   const end =
    reel.end ?? panel.video.duration;

   if (!Number.isFinite(end)) {
    return;
   }

   const fraction =
    (
     panel.video.currentTime -
     reel.start
    ) /
    (end - reel.start) +
    (
     event.key === 'ArrowRight'
      ? 0.05
      : -0.05
    );

   seekFraction(fraction);
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
   if (document.hidden) {
    const reel = activeReel();

    const panel =
     reel && panels.get(reel.key);

    resumeOnShow =
     resumeOnShow ||
     (
      wantsPlayback &&
      Boolean(
       (
        panel &&
        !panel.video.paused
       ) ||
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

/* ========================================
   START
======================================== */

hookEvents();
loadAll();

if (
 'serviceWorker' in navigator &&
 location.protocol === 'https:'
) {
 navigator.serviceWorker
  .register('./sw.js')
  .catch(() => {});
}

})();
