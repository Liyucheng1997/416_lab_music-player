// 入口：加载设置与资料库，挂载各模块，绑定快捷键
import { state, on, emit, loadLibrary } from './store.js';
import { player, toggle, next, prev, setVolume, seek, applyEq, restoreSession } from './player.js';
import { navigate, render, scrollToPlaying } from './views.js';
import { initTitlebar, initSidebar, initPlayerbar, toggleImmersive } from './shell.js';
import { initSide } from './side.js';
import { initAi } from './ai-ctl.js';
import { debounce } from './dom.js';
import './lyrics-ctl.js';

const media = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = state.settings.theme;
  const dark = pref === 'dark' || (pref === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  emit('theme');
}
media.addEventListener('change', applyTheme);

async function boot() {
  state.settings = await window.api.invoke('settings:get');
  state.settings.ui ||= {};
  applyTheme();
  await loadLibrary();
  initAi();
  initTitlebar();
  initSidebar();
  initPlayerbar();
  initSide();
  restoreSession();
  const last = state.settings.ui.lastView;
  navigate(last?.name && last.name !== 'search' ? last.name : 'songs', last?.arg ?? null);
}

on('settings', (s) => {
  applyTheme();
  applyEq(s.eq);
});

// 正在播放的歌没有封面时，后台尝试在线补全（成功后主进程会通知资料库变化）
on('player:track', (t) => { if (t && !t.coverId) window.api.invoke('cover:auto', t.id); });

on('view', (v) => {
  state.settings.ui.lastView = v;
  window.api.invoke('settings:set', { ui: { lastView: v } });
});

// 资料库变化（扫描完成、换封面）后整体刷新
const reload = debounce(async () => {
  await loadLibrary();
  render();
}, 300);
window.api.on('lib:changed', reload);
window.addEventListener('tingyin:reload', reload);
on('scan', () => render());
on('playlists', () => { if (state.view.name === 'playlist') render(); });
on('loved', () => { if (state.view.name === 'loved') render(); });

// ---------- 快捷键 ----------
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    document.getElementById('search').focus();
    document.getElementById('search').select();
    return;
  }
  if (typing) return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.ctrlKey && e.key === 'ArrowRight') next();
  else if (e.ctrlKey && e.key === 'ArrowLeft') prev();
  else if (e.ctrlKey && e.key === 'ArrowUp') { e.preventDefault(); setVolume(player.volume + 0.05); }
  else if (e.ctrlKey && e.key === 'ArrowDown') { e.preventDefault(); setVolume(player.volume - 0.05); }
  else if (e.key === 'ArrowRight' && !e.ctrlKey) seek(player.time + 5);
  else if (e.key === 'ArrowLeft' && !e.ctrlKey) seek(player.time - 5);
  else if (e.ctrlKey && e.key.toLowerCase() === 'l') scrollToPlaying();
  else if (e.key.toLowerCase() === 'i' && e.ctrlKey) toggleImmersive();
});

document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea')) e.preventDefault();
});

boot();
