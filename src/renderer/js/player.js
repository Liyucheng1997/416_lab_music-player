// 播放引擎：<audio> + Web Audio（10 段均衡器、前级增益、淡入淡出、频谱分析），播放队列与随机 / 循环
import { state, emit, patchTrack, saveSettings } from './store.js';
import { toast } from './ui.js';
import { coverUrl } from './dom.js';

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS = {
  平直: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  流行: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  摇滚: [5, 3, 1, -1, -2, -1, 2, 4, 5, 5],
  爵士: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  古典: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
  人声: [-2, -2, -1, 1, 3, 4, 4, 2, 0, -1],
  低音增强: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  高音增强: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  电子: [4, 3, 1, 0, -2, 2, 1, 1, 3, 4],
  原声: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1],
};

const audio = new Audio();
audio.crossOrigin = 'anonymous';
audio.preload = 'auto';

let ctx = null;
let filters = [];
let preamp = null;
let fader = null;
export let analyser = null;

// 实际生效的均衡器设置：默认是设置里的 eq，AI 调音开启「按类型自动切换」时由 tune.js 接管
let eqSource = () => state.settings.eq;
export function setEqSource(fn) { eqSource = fn; refreshEq(); }
export function refreshEq() { if (state.settings) applyEq(eqSource()); }

export const player = {
  queue: [],
  original: [],
  index: -1,
  shuffle: false,
  repeat: 'all', // off | all | one
  volume: 0.8,
  muted: false,
  get track() { return state.byId.get(this.queue[this.index]) || null; },
  get playing() { return !audio.paused; },
  // CUE 分轨：时间相对于这一首在整轨文件里的起点
  get time() { return Math.max(0, (audio.currentTime || 0) - offsetOf(this.track)); },
  get duration() {
    const t = this.track;
    if (t?.cueStart != null) return t.cueEnd != null ? t.cueEnd - t.cueStart : Number.isFinite(audio.duration) ? audio.duration - t.cueStart : t.duration;
    return Number.isFinite(audio.duration) ? audio.duration : t?.duration || 0;
  },
};

const offsetOf = (t) => t?.cueStart || 0;
let loadedPath = '';
let counted = false;
let wantPlay = false; // 用户（或自动连播）确实要播放这一首；启动时恢复上次进度不算

function ensureGraph() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'playback' });
  const src = ctx.createMediaElementSource(audio);
  preamp = ctx.createGain();
  filters = EQ_FREQS.map((f, i) => {
    const b = ctx.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    b.frequency.value = f;
    b.Q.value = 1.1;
    return b;
  });
  fader = ctx.createGain();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  let node = src.connect(preamp);
  for (const f of filters) node = node.connect(f);
  node.connect(fader).connect(analyser).connect(ctx.destination);
  applyEq(eqSource());
}

export function applyEq(eq) {
  if (!ctx) return;
  const on = eq.enabled;
  filters.forEach((f, i) => f.gain.setTargetAtTime(on ? eq.bands[i] || 0 : 0, ctx.currentTime, 0.03));
  // 前级增益：开启均衡器时按最大提升量自动压低，防止削波
  const maxBoost = on ? Math.max(0, ...eq.bands) : 0;
  const db = on ? (eq.preamp || 0) - maxBoost * 0.6 : 0;
  preamp.gain.setTargetAtTime(10 ** (db / 20), ctx.currentTime, 0.03);
}

function fadeTo(v, ms) {
  if (!ctx) return Promise.resolve();
  const t = ctx.currentTime;
  fader.gain.cancelScheduledValues(t);
  fader.gain.setValueAtTime(fader.gain.value, t);
  fader.gain.linearRampToValueAtTime(v, t + ms / 1000);
  return new Promise((r) => setTimeout(r, ms));
}

function emitState() {
  emit('player:state', player);
  const t = player.track;
  window.api.send('np:state', { title: t?.title || '', artist: t?.artist || '', playing: player.playing });
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused';
}

function updateMediaSession(t) {
  if (!('mediaSession' in navigator) || !t) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist,
    album: t.album,
    artwork: t.coverId ? [{ src: coverUrl(t.coverId, false), sizes: '1000x1000', type: 'image/jpeg' }] : [],
  });
  document.title = `${t.title} - ${t.artist || '听音'}`;
}

async function load(index, { autoplay = true, at = 0 } = {}) {
  if (index < 0 || index >= player.queue.length) return;
  player.index = index;
  const t = player.track;
  if (!t) return;
  counted = false;
  wantPlay = autoplay;
  ensureGraph();
  if (ctx.state === 'suspended') ctx.resume();
  const start = offsetOf(t) + at;
  const continuing = loadedPath === t.path && audio.src && !audio.paused && Math.abs(audio.currentTime - start) <= 1;
  if (loadedPath === t.path && audio.src) {
    // 同一个整轨文件里的下一首：顺着播下去就是无缝衔接，不重新加载
    if (Math.abs(audio.currentTime - start) > 1) audio.currentTime = start;
  } else {
    if (t.needsTranscode) toast(`「${t.title}」需要转码，首次播放稍等片刻`);
    audio.src = `media://track/${t.id}`;
    loadedPath = t.path;
    if (start) audio.currentTime = start;
  }
  emit('player:track', t);
  updateMediaSession(t);
  if (autoplay && continuing) {
    // 无缝衔接时不做淡入淡出
  } else if (autoplay) {
    fader.gain.value = 0;
    try {
      await audio.play();
      fadeTo(1, 220);
    } catch (e) {
      if (e.name !== 'AbortError') console.warn(e);
    }
  } else if (fader) {
    fader.gain.value = 1;
  }
  emitState();
  saveSession();
}

export function playList(ids, start = 0, { shuffle = player.shuffle } = {}) {
  if (!ids.length) return;
  player.original = [...ids];
  player.shuffle = shuffle;
  if (shuffle) {
    const first = ids[start];
    const rest = ids.filter((_, i) => i !== start);
    shuffleInPlace(rest);
    player.queue = [first, ...rest];
    start = 0;
  } else {
    player.queue = [...ids];
  }
  emit('player:queue', player);
  load(start);
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function toggleShuffle() {
  player.shuffle = !player.shuffle;
  const cur = player.queue[player.index];
  if (player.shuffle) {
    const rest = player.queue.filter((_, i) => i !== player.index);
    player.queue = cur ? [cur, ...shuffleInPlace(rest)] : shuffleInPlace(rest);
    player.index = cur ? 0 : -1;
  } else {
    const extra = player.queue.filter((id) => !player.original.includes(id));
    player.queue = [...player.original, ...extra];
    player.index = Math.max(0, player.queue.indexOf(cur));
  }
  emit('player:queue', player);
  emitState();
  saveSession();
}

export function cycleRepeat() {
  player.repeat = { off: 'all', all: 'one', one: 'off' }[player.repeat];
  emitState();
  saveSession();
}

export async function toggle() {
  if (player.index < 0) {
    if (state.tracks.length) playList(state.tracks.map((t) => t.id), 0);
    return;
  }
  ensureGraph();
  if (ctx.state === 'suspended') await ctx.resume();
  if (audio.paused) {
    // 上次加载失败（比如外接硬盘当时没插）：重新加载这一首再播
    if (!audio.src || audio.error) return load(player.index);
    wantPlay = true;
    fader.gain.value = 0;
    await audio.play().catch(() => {});
    fadeTo(1, 200);
  } else {
    await fadeTo(0, 160);
    audio.pause();
    saveSession();
  }
}

export function next(auto = false) {
  if (!player.queue.length) return;
  if (auto && player.repeat === 'one') { audio.currentTime = offsetOf(player.track); audio.play(); return; }
  if (!auto && player.track && !counted && audio.currentTime < 20) {
    window.api.invoke('lib:update', player.track.id, { skipCount: (player.track.skipCount || 0) + 1 });
  }
  let i = player.index + 1;
  if (i >= player.queue.length) {
    if (player.repeat === 'off' && auto) { audio.pause(); audio.currentTime = offsetOf(player.track); emitState(); return; }
    i = 0;
  }
  load(i);
}

export function prev() {
  if (!player.queue.length) return;
  if (player.time > 3) { seek(0); return; }
  load(player.index - 1 < 0 ? player.queue.length - 1 : player.index - 1);
}

export function playAt(i) { load(i); }

export function seek(t) {
  if (!Number.isFinite(t)) return;
  audio.currentTime = offsetOf(player.track) + Math.max(0, Math.min(t, player.duration || t));
  emit('player:time', player);
}

export function setVolume(v) {
  player.volume = Math.max(0, Math.min(1, v));
  player.muted = false;
  audio.volume = player.volume ** 2; // 听感上更线性
  audio.muted = false;
  emit('player:volume', player);
  persistVolume();
}

export function toggleMute() {
  player.muted = !player.muted;
  audio.muted = player.muted;
  emit('player:volume', player);
}

let volTimer;
function persistVolume() {
  clearTimeout(volTimer);
  volTimer = setTimeout(() => saveSettings({ volume: player.volume }), 500);
}

export function playNext(ids) {
  if (player.index < 0) return playList(ids, 0);
  player.queue.splice(player.index + 1, 0, ...ids);
  player.original.push(...ids);
  emit('player:queue', player);
  toast(`已添加 ${ids.length} 首到下一首播放`);
  saveSession();
}

export function addToQueue(ids) {
  if (player.index < 0) return playList(ids, 0);
  player.queue.push(...ids);
  player.original.push(...ids);
  emit('player:queue', player);
  toast(`已添加 ${ids.length} 首到播放队列`);
  saveSession();
}

export function removeFromQueue(i) {
  if (i === player.index) return;
  player.queue.splice(i, 1);
  if (i < player.index) player.index--;
  emit('player:queue', player);
  saveSession();
}

export function moveInQueue(from, to) {
  const [id] = player.queue.splice(from, 1);
  player.queue.splice(to, 0, id);
  if (from === player.index) player.index = to;
  else if (from < player.index && to >= player.index) player.index--;
  else if (from > player.index && to <= player.index) player.index++;
  emit('player:queue', player);
  saveSession();
}

export function clearQueue() {
  const cur = player.queue[player.index];
  player.queue = cur ? [cur] : [];
  player.original = [...player.queue];
  player.index = cur ? 0 : -1;
  emit('player:queue', player);
  saveSession();
}

let sessionTimer;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    window.api.invoke('settings:set', {
      session: {
        queue: player.queue.slice(0, 5000),
        original: player.original.slice(0, 5000),
        index: player.index,
        time: player.time,
        shuffle: player.shuffle,
        repeat: player.repeat,
      },
    });
  }, 800);
}

export function restoreSession() {
  const s = state.settings.session;
  player.volume = state.settings.volume ?? 0.8;
  audio.volume = player.volume ** 2;
  if (!s?.queue?.length) return;
  player.queue = s.queue.filter((id) => state.byId.has(id));
  player.original = (s.original || s.queue).filter((id) => state.byId.has(id));
  player.shuffle = !!s.shuffle;
  player.repeat = s.repeat || 'all';
  const cur = s.queue[s.index];
  const idx = player.queue.indexOf(cur);
  if (idx < 0) return;
  player.index = idx;
  const t = player.track;
  audio.src = `media://track/${t.id}`;
  loadedPath = t.path;
  audio.currentTime = offsetOf(t) + (s.time || 0);
  emit('player:queue', player);
  emit('player:track', t);
  updateMediaSession(t);
  emitState();
}

// ---------- 音频事件 ----------
audio.addEventListener('play', emitState);
audio.addEventListener('pause', emitState);
audio.addEventListener('ended', () => {
  if (player.track && !counted) markPlayed();
  next(true);
});
audio.addEventListener('loadedmetadata', () => {
  const t = player.track;
  if (t && t.cueStart == null && Number.isFinite(audio.duration) && Math.abs((t.duration || 0) - audio.duration) > 1) {
    t.duration = audio.duration;
    window.api.invoke('lib:duration', t.id, audio.duration);
  }
  emit('player:time', player);
});
audio.addEventListener('timeupdate', () => {
  if (checkCueEnd()) return;
  emit('player:time', player);
  // 听过一半（或 4 分钟）计一次播放
  if (!counted && player.duration && (audio.currentTime > player.duration * 0.5 || audio.currentTime > 240)) markPlayed();
  if (Math.floor(audio.currentTime) % 10 === 0) saveSession();
});
// 播放失败就停在这一首，不自动跳下一首：文件找不到时（外接硬盘没插）往下跳也一样放不了，只会一直报错
audio.addEventListener('error', async () => {
  const t = player.track;
  loadedPath = '';
  if (!t || !audio.src) return;
  const shouldTell = wantPlay;
  wantPlay = false;
  emitState();
  if (!shouldTell) return; // 启动时恢复上次的歌，文件不在就安静地等着，不弹提示
  const exists = await window.api.invoke('lib:exists', t.path).catch(() => true);
  const why = !exists ? '：找不到文件，外接硬盘是不是没插？' : t.needsTranscode ? '（需要 ffmpeg 转码）' : '';
  toast(`无法播放「${t.title}」${why}`, 'error');
});

// CUE 分轨播到本首结尾时切到下一首；timeupdate 只有 4Hz，播放中再用定时器补一下精度
function checkCueEnd() {
  const t = player.track;
  if (t?.cueEnd == null || audio.paused || audio.currentTime < t.cueEnd - 0.03) return false;
  if (!counted) markPlayed();
  next(true);
  return true;
}
setInterval(checkCueEnd, 60);

async function markPlayed() {
  counted = true;
  const t = await window.api.invoke('lib:played', player.track.id);
  patchTrack(t);
}

// 系统媒体键 / Windows 媒体浮窗
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => toggle());
  navigator.mediaSession.setActionHandler('pause', () => toggle());
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('seekto', (d) => seek(d.seekTime));
}

window.api.on('player:command', (cmd) => {
  if (cmd === 'toggle') toggle();
  else if (cmd === 'next') next();
  else if (cmd === 'prev') prev();
});
