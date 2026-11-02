// AI 赏析状态：跟随切歌加载缓存或发起请求，按播放进度定位当前段落
import { on, emit, state, uiPref, setUiPref } from './store.js';
import { player } from './player.js';
import { lyrics, currentTime, applyAiTranslation } from './lyrics-ctl.js';
import { mostlyChinese } from './lrc.js';
import { toast } from './ui.js';

const blank = () => ({
  trackId: null,
  overview: { text: '', status: 'idle', error: '' },
  timeline: { segments: [], status: 'idle', error: '' },
  chat: { history: [], status: 'idle', error: '' },
  translate: { status: 'idle' },
  seg: -1,
});

export const ai = { live: false, ...blank() };

const pending = new Map();
window.api.on('ai:delta', ({ reqId, delta }) => pending.get(reqId)?.onDelta?.(delta));
window.api.on('ai:done', ({ reqId, result }) => { pending.get(reqId)?.resolve(result); pending.delete(reqId); });
window.api.on('ai:error', ({ reqId, message }) => { pending.get(reqId)?.reject(new Error(message)); pending.delete(reqId); });

let live = new Set();
function request(kind, payload, onDelta) {
  const reqId = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  live.add(reqId);
  return {
    reqId,
    promise: new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject, onDelta });
      window.api.invoke('ai:start', { reqId, kind, ...payload });
    }).finally(() => live.delete(reqId)),
  };
}

function cancelAll() {
  for (const id of live) window.api.invoke('ai:cancel', id);
  live = new Set();
}

export const hasKey = () => !!(state.settings?.ai?.hasKey || state.settings?.ai?.envKey);

const lyricLines = () => lyrics.parsed.lines.filter((l) => l.text).slice(0, 400).map((l) => ({ time: l.time, text: l.text }));
const changed = () => emit('ai', ai);

export function setLive(v) {
  ai.live = v;
  setUiPref('aiLive', v);
  changed();
  if (v && player.track) start(player.track, { immediate: true });
  if (!v) cancelAll();
}

let startTimer = null;
async function start(track, { immediate = false } = {}) {
  clearTimeout(startTimer);
  cancelAll();
  Object.assign(ai, blank(), { trackId: track.id });
  changed();
  const cached = await window.api.invoke('ai:cached', track.id);
  if (ai.trackId !== track.id) return;
  if (cached.overview) ai.overview = { text: cached.overview, status: 'done', error: '' };
  if (cached.timeline?.length) ai.timeline = { segments: cached.timeline, status: 'done', error: '' };
  updateSeg();
  changed();
  if (!ai.live || !state.settings.ai.autoTimeline) return;
  if (ai.overview.status === 'done' && ai.timeline.status === 'done') return;
  // 快速切歌时不急着发请求
  startTimer = setTimeout(async () => {
    await lyricsReady(track.id);
    if (ai.trackId !== track.id || !ai.live) return;
    if (ai.timeline.status !== 'done') runTimeline();
    if (ai.overview.status !== 'done') runOverview();
  }, immediate ? 0 : 2500);
}

function lyricsReady(id) {
  if (lyrics.trackId === id && !lyrics.loading) return Promise.resolve();
  return new Promise((resolve) => {
    const off = on('lyrics', (l) => { if (l.trackId === id && !l.loading) { off(); resolve(); } });
    setTimeout(() => { off(); resolve(); }, 8000);
  });
}

function guard() {
  if (hasKey()) return true;
  ai.overview.status = 'nokey';
  changed();
  return false;
}

export async function runOverview() {
  const t = player.track;
  if (!t || !guard()) return;
  const id = t.id;
  ai.overview = { text: '', status: 'loading', error: '' };
  changed();
  const { promise } = request('overview', { trackId: id, lines: lyricLines() }, (d) => {
    if (ai.trackId !== id) return;
    ai.overview.text += d;
    emit('ai:overview', ai.overview);
  });
  try {
    const text = await promise;
    if (ai.trackId !== id) return;
    ai.overview = { text, status: 'done', error: '' };
  } catch (e) {
    if (ai.trackId !== id) return;
    ai.overview.status = 'error';
    ai.overview.error = e.message;
  }
  changed();
}

export async function runTimeline() {
  const t = player.track;
  if (!t || !guard()) return;
  const id = t.id;
  ai.timeline = { segments: [], status: 'loading', error: '' };
  changed();
  try {
    const segments = await request('timeline', { trackId: id, lines: lyricLines() }).promise;
    if (ai.trackId !== id) return;
    ai.timeline = { segments, status: 'done', error: '' };
    updateSeg(true);
  } catch (e) {
    if (ai.trackId !== id) return;
    ai.timeline = { segments: [], status: 'error', error: e.message };
  }
  changed();
}

export async function ask(question) {
  const t = player.track;
  if (!t || !question.trim() || !guard()) return;
  const id = t.id;
  ai.chat.history.push({ role: 'user', content: question.trim() });
  const answer = { role: 'assistant', content: '' };
  ai.chat.history.push(answer);
  ai.chat.status = 'loading';
  changed();
  const history = ai.chat.history.slice(0, -1);
  try {
    const text = await request('chat', { trackId: id, lines: lyricLines(), history }, (d) => {
      if (ai.trackId !== id) return;
      answer.content += d;
      emit('ai:chat', ai.chat);
    }).promise;
    answer.content = text;
    ai.chat.status = 'idle';
  } catch (e) {
    ai.chat.history.pop();
    ai.chat.status = 'error';
    ai.chat.error = e.message;
  }
  if (ai.trackId === id) changed();
}

export const canTranslate = () => lyrics.parsed.lines.length > 0 && !mostlyChinese(lyrics.parsed.lines) && !lyrics.parsed.lines.some((l) => l.trans);

export async function translate() {
  const t = player.track;
  if (!t || !guard()) { if (!hasKey()) toast('请先在设置里填写 Claude API Key', 'error'); return; }
  const id = t.id;
  ai.translate.status = 'loading';
  emit('ai:translate', ai.translate);
  try {
    const lines = lyrics.parsed.lines.map((l) => ({ time: l.time, text: l.text }));
    const map = await request('translate', { trackId: id, lines }).promise;
    if (lyrics.trackId === id) await applyAiTranslation(map);
    ai.translate.status = 'done';
    toast('歌词翻译完成', 'success');
  } catch (e) {
    ai.translate.status = 'idle';
    toast(e.message, 'error');
  }
  emit('ai:translate', ai.translate);
}

export function stopAll() {
  cancelAll();
  if (ai.overview.status === 'loading') ai.overview.status = ai.overview.text ? 'done' : 'idle';
  if (ai.timeline.status === 'loading') ai.timeline.status = 'idle';
  if (ai.chat.status === 'loading') ai.chat.status = 'idle';
  changed();
}

function updateSeg(force = false) {
  const segs = ai.timeline.segments;
  let i = -1;
  const t = currentTime();
  for (let k = 0; k < segs.length; k++) if (segs[k].start <= t + 0.3) i = k;
  if (i !== ai.seg || force) {
    ai.seg = i;
    emit('ai:seg', i);
  }
}

export function segProgress() {
  const segs = ai.timeline.segments;
  const s = segs[ai.seg];
  if (!s) return 0;
  const end = segs[ai.seg + 1]?.start ?? player.duration;
  return Math.max(0, Math.min(1, (currentTime() - s.start) / Math.max(1, end - s.start)));
}

on('player:track', (t) => { if (t) start(t); });
on('player:time', () => updateSeg());

export function initAi() {
  ai.live = uiPref('aiLive', false);
}
