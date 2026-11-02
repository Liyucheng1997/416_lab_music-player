// 歌词控制：随切歌加载歌词、跟随播放进度定位当前行、同步到桌面歌词
import { on, emit, state } from './store.js';
import { player } from './player.js';
import { parseLrc, mergeTranslation, lineAt } from './lrc.js';

export const lyrics = {
  trackId: null,
  loading: false,
  parsed: { synced: false, lines: [] },
  source: '',
  instrumental: false,
  offset: 0, // 用户手动调整的偏移（秒），正数 = 歌词提前
  index: -1,
  raw: null,
};

let seq = 0;

export async function loadLyrics(track) {
  const my = ++seq;
  lyrics.trackId = track?.id || null;
  lyrics.loading = !!track;
  lyrics.parsed = { synced: false, lines: [] };
  lyrics.index = -1;
  lyrics.source = '';
  lyrics.instrumental = false;
  lyrics.offset = 0;
  lyrics.error = '';
  emit('lyrics', lyrics);
  pushDesktop(true);
  if (!track) return;
  let data;
  try {
    data = await window.api.invoke('lyrics:get', track.id);
  } catch {
    data = { none: true };
  }
  if (my !== seq) return; // 已经切到别的歌
  lyrics.raw = data;
  lyrics.loading = false;
  lyrics.instrumental = !!data.instrumental;
  lyrics.source = data.source || '';
  lyrics.error = data.error || '';
  lyrics.offset = data.offset || 0;
  lyrics.parsed = data.lrc ? parseLrc(data.lrc) : { synced: false, lines: [] };
  if (data.aiTrans) mergeTranslation(lyrics.parsed, data.aiTrans);
  emit('lyrics', lyrics);
  tick(true);
}

export function currentTime() {
  return player.time + lyrics.offset;
}

function tick(force = false) {
  if (!lyrics.parsed.synced) { if (force) pushDesktop(true); return; }
  const i = lineAt(lyrics.parsed.lines, currentTime());
  if (i !== lyrics.index || force) {
    lyrics.index = i;
    emit('lyrics:line', i);
    pushDesktop(true);
  }
}

// 桌面歌词：换行时发完整内容，其余时间每 250ms 校一次时间，窗口内部用 rAF 补间
let lastSync = 0;
function pushDesktop(full) {
  const now = performance.now();
  if (!full && now - lastSync < 250) return;
  lastSync = now;
  const t = player.track;
  const lines = lyrics.parsed.lines;
  const i = lyrics.index;
  const payload = { t: currentTime(), playing: player.playing, at: Date.now() };
  if (full) {
    const cur = lines[i];
    const nextLine = lines[i + 1];
    Object.assign(payload, {
      full: true,
      title: t ? `${t.title}${t.artist ? ` - ${t.artist}` : ''}` : '听音',
      synced: lyrics.parsed.synced,
      text: cur?.text || '',
      trans: cur?.trans || '',
      next: nextLine?.text || (i < 0 ? lines[0]?.text || '' : ''),
      start: cur?.time ?? 0,
      end: nextLine?.time ?? (player.duration || (cur?.time ?? 0) + 5),
      empty: !lines.length,
      instrumental: lyrics.instrumental,
    });
  }
  window.api.send('dl:update', payload);
}

on('player:track', (t) => loadLyrics(t));
on('player:time', () => { tick(); pushDesktop(false); });
on('player:state', () => pushDesktop(true));
on('lyrics:changed', (id) => { if (id === lyrics.trackId) loadLyrics(state.byId.get(id)); });
window.api.on('dl:resend', () => pushDesktop(true));

// 播放中用 rAF 让歌词滚动更跟手（timeupdate 只有 4Hz）
function loop() {
  if (player.playing) tick();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

export async function setOffset(delta) {
  lyrics.offset = Math.round((lyrics.offset + delta) * 10) / 10;
  if (Math.abs(lyrics.offset) < 0.05) lyrics.offset = 0;
  emit('lyrics:offset', lyrics.offset);
  tick(true);
  await window.api.invoke('lyrics:save', lyrics.trackId, { offset: lyrics.offset });
}

export async function applyAiTranslation(map) {
  mergeTranslation(lyrics.parsed, map);
  emit('lyrics', lyrics);
  tick(true);
  await window.api.invoke('lyrics:save', lyrics.trackId, { aiTrans: map });
}
