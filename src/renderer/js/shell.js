// 外框：顶栏、侧栏导航、底部播放条、沉浸式播放页
import { h, icon, clear, fmtTime, coverEl, debounce } from './dom.js';
import { state, on, emit, derived, saveSettings } from './store.js';
import { player, analyser, toggle, next, prev, seek, setVolume, toggleMute, toggleShuffle, cycleRepeat } from './player.js';
import { navigate, back, forward, canBack, canForward, playlistMenu, addToPlaylist, toggleLove, albumKey, firstArtist } from './views.js';
import { setTab, toggleSide, lyricsView } from './side.js';
import { ai } from './ai-ctl.js';
import { activeProfile } from './tune.js';
import { openSettings, openEq } from './dialogs.js';
import { promptBox } from './ui.js';

// ---------------- 滑块 ----------------
export function slider({ onInput, onChange, tip }) {
  const fill = h('div', { class: 'fill' });
  const buf = h('div', { class: 'buf' });
  const knob = h('div', { class: 'knob' });
  const tipEl = tip ? h('div', { class: 'tip' }) : null;
  const el = h('div', { class: 'slider' }, h('div', { class: 'track' }, buf, fill), knob, tipEl);
  let value = 0;
  let dragging = false;
  const set = (v) => {
    value = Math.max(0, Math.min(1, v || 0));
    fill.style.width = `${value * 100}%`;
    knob.style.left = `${value * 100}%`;
  };
  const ratio = (e) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.classList.add('drag');
    el.setPointerCapture(e.pointerId);
    set(ratio(e));
    onInput?.(value);
  });
  el.addEventListener('pointermove', (e) => {
    if (tipEl) {
      const r = ratio(e);
      tipEl.textContent = tip(r);
      tipEl.style.left = `${r * 100}%`;
    }
    if (!dragging) return;
    set(ratio(e));
    onInput?.(value);
  });
  el.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('drag');
    onChange?.(value);
  });
  return { el, set: (v) => { if (!dragging) set(v); }, setBuffered: (v) => { buf.style.width = `${v * 100}%`; }, get dragging() { return dragging; } };
}

// ---------------- 顶栏 ----------------
export function initTitlebar() {
  const backBtn = document.getElementById('navBack');
  const fwdBtn = document.getElementById('navFwd');
  backBtn.append(icon('left', 18));
  fwdBtn.append(icon('right', 18));
  backBtn.onclick = back;
  fwdBtn.onclick = forward;
  const syncNav = () => { backBtn.disabled = !canBack(); fwdBtn.disabled = !canForward(); };
  on('view', syncNav);
  syncNav();

  document.getElementById('searchIco').append(icon('search', 16));
  const input = document.getElementById('search');
  let before = null;
  const run = debounce(() => {
    const q = input.value.trim();
    state.search = q;
    if (q) {
      if (state.view.name !== 'search') before = state.view;
      navigate('search', q, { push: state.view.name !== 'search' });
    } else if (state.view.name === 'search') {
      navigate(before?.name || 'songs', before?.arg ?? null);
    }
  }, 220);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; run(); input.blur(); } });

  const themeBtn = document.getElementById('themeBtn');
  const drawTheme = () => clear(themeBtn, icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 17));
  themeBtn.onclick = () => saveSettings({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' });
  on('theme', drawTheme);
  drawTheme();
  const settingsBtn = document.getElementById('settingsBtn');
  settingsBtn.append(icon('settings', 17));
  settingsBtn.onclick = () => openSettings();

  // 有新版本时标题栏出现更新按钮：点一下下载，下载完自动安装并重启
  const updBtn = h('button', { class: 'btn btn-sm btn-primary update-pill', hidden: true, onclick: () => window.api.invoke('update:install') });
  document.querySelector('.tb-actions').prepend(updBtn);
  const drawUpdate = (u) => {
    state.update = u;
    emit('update', u);
    const label = u.status === 'available' ? `更新到 ${u.version}` : u.status === 'downloading' ? `正在下载 ${u.percent || 0}%` : u.status === 'ready' ? '重启并更新' : '';
    updBtn.hidden = !label;
    updBtn.disabled = u.status === 'downloading';
    clear(updBtn, label ? icon('download', 14) : null, label);
  };
  window.api.on('update:state', drawUpdate);
  window.api.invoke('update:state').then(drawUpdate);

  const status = document.getElementById('scanStatus');
  window.api.on('lib:progress', (p) => {
    if (p.phase === 'covers') {
      clear(status, h('span', { class: 'dot' }), `正在补全封面 ${p.done}/${p.total}，已找到 ${p.found}`);
      return;
    }
    if (p.phase === 'covers-done') {
      clear(status, h('span', { class: 'status ok' }, `封面补全完成：${p.total} 张专辑里找到 ${p.found} 张`));
      setTimeout(() => clear(status), 8000);
      window.dispatchEvent(new Event('tingyin:reload'));
      return;
    }
    if (p.phase === 'classify') {
      clear(status, h('span', { class: 'dot' }), `AI 正在分类 ${p.done}/${p.total}`);
      return;
    }
    if (p.phase === 'classify-done') {
      clear(status, p.error ? h('span', { class: 'status warn', title: p.error }, `AI 分类中断：${p.error.slice(0, 40)}`)
        : h('span', { class: 'status ok' }, `AI 分类完成：${p.total - p.failed} 首${p.failed ? `，${p.failed} 首失败` : ''}`));
      setTimeout(() => clear(status), 8000);
      return;
    }
    if (p.phase === 'done') {
      state.scanning = false;
      const changes = (p.added || 0) + (p.updated || 0) + (p.removed || 0);
      clear(status, changes ? h('span', { class: 'status ok' }, `索引完成：新增 ${p.added}，更新 ${p.updated}，移除 ${p.removed}`) : '');
      if (changes) setTimeout(() => clear(status), 6000);
      return;
    }
    state.scanning = true;
    clear(status, h('span', { class: 'dot' }), p.phase === 'walk' ? '正在查找音乐文件…' : `正在读取标签 ${p.done}/${p.total}`);
  });
}

// ---------------- 侧栏 ----------------
export function initSidebar() {
  const nav = document.getElementById('sidebar');
  const item = (key, label, ic, arg = null, count = null) => {
    const active = state.view.name === key && (arg == null || state.view.arg === arg)
      || (key === 'albums' && state.view.name === 'album') || (key === 'artists' && state.view.name === 'artist')
      || (key === 'genres' && state.view.name === 'genre') || (key === 'years' && state.view.name === 'year') || (key === 'folders' && state.view.name === 'folder') || (key === 'aitags' && state.view.name === 'aitag');
    return h('div', { class: `nav-item ${active ? 'active' : ''}`, onclick: () => navigate(key, arg) }, icon(ic, 18), h('span', { class: 'label' }, label),
      count != null ? h('span', { class: 'count' }, count) : null);
  };
  const draw = () => {
    const d = state.tracks.length ? derived() : { albums: [], artists: [], genres: [] };
    const loved = state.tracks.filter((t) => t.loved).length;
    const lists = state.playlists.map((p) => {
      const el = item('playlist', p.name, 'playlist', p.id, p.trackIds.length);
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); playlistMenu(p, e.clientX, e.clientY); });
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-tingyin-tracks')) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('drop');
        const ids = JSON.parse(e.dataTransfer.getData('application/x-tingyin-tracks') || '[]');
        if (ids.length) addToPlaylist(p.id, ids);
      });
      return el;
    });
    clear(nav,
      h('div', { class: 'nav-group' }, h('div', { class: 'nav-title' }, '资料库'),
        item('songs', '歌曲', 'file', null, state.tracks.length || null),
        item('albums', '专辑', 'album', null, d.albums.length || null),
        item('artists', '歌手', 'mic', null, d.artists.length || null),
        item('genres', '流派', 'tag'),
        item('years', '年代', 'calendar'),
        item('aitags', 'AI 分类', 'wand'),
        item('folders', '文件夹', 'folder')),
      h('div', { class: 'nav-group' }, h('div', { class: 'nav-title' }, '收藏'),
        item('loved', '我喜欢', 'heart', null, loved || null),
        item('recent', '最近播放', 'recent'),
        item('top', '最常播放', 'trending'),
        item('added', '最近添加', 'plus')),
      h('div', { class: 'nav-group' }, h('div', { class: 'nav-title' }, '歌单',
        h('button', { class: 'icon-btn', title: '新建歌单', onclick: async () => {
          const name = await promptBox({ title: '新建歌单', value: '新建歌单' });
          if (!name) return;
          const pl = await window.api.invoke('pl:create', name, []);
          state.playlists.push(pl);
          emit('playlists');
          navigate('playlist', pl.id);
        } }, icon('plus', 15))),
      lists.length ? lists : h('div', { class: 'nav-item', style: { color: 'var(--text-3)', fontSize: '12.5px' } }, '拖动歌曲到这里建立歌单')));
  };
  draw();
  for (const evt of ['view', 'library', 'playlists', 'loved']) on(evt, draw);
}

// ---------------- 播放条 ----------------
export function initPlayerbar() {
  const bar = document.getElementById('playerbar');
  const cover = h('div', { class: 'cover' });
  const title = h('div', { class: 'np-title' });
  const artist = h('div', { class: 'np-artist' });
  const love = h('button', { class: 'love-btn', style: { opacity: 1 }, title: '喜欢' }, icon('heart', 16));
  love.onclick = () => player.track && toggleLove(player.track);

  const shuffleBtn = h('button', { class: 'icon-btn', title: '随机播放', onclick: toggleShuffle }, icon('shuffle', 17));
  const prevBtn = h('button', { class: 'icon-btn prevnext', title: '上一首', onclick: prev }, icon('prev', 19));
  const playBtn = h('button', { class: 'icon-btn big', title: '播放 / 暂停（空格）', onclick: toggle });
  const nextBtn = h('button', { class: 'icon-btn prevnext', title: '下一首', onclick: () => next() }, icon('next', 19));
  const repeatBtn = h('button', { class: 'icon-btn', title: '循环', onclick: cycleRepeat });
  const cur = h('span', {}, '0:00');
  const total = h('span', {}, '0:00');
  const prog = slider({
    tip: (r) => fmtTime(r * player.duration),
    onChange: (v) => seek(v * player.duration),
    onInput: (v) => { cur.textContent = fmtTime(v * player.duration); },
  });

  const volIcon = h('button', { class: 'icon-btn', title: '静音', onclick: toggleMute });
  const vol = slider({ onInput: (v) => setVolume(v), tip: (r) => `${Math.round(r * 100)}%` });
  const lyricBtn = h('button', { class: 'icon-btn', title: '歌词', onclick: () => sideButton('lyrics') }, icon('mic', 17));
  const aiBtn = h('button', { class: 'icon-btn', title: 'AI 赏析', onclick: () => sideButton('ai') }, icon('sparkles', 17));
  const queueBtn = h('button', { class: 'icon-btn', title: '播放队列', onclick: () => sideButton('queue') }, icon('queue', 17));
  const dlBtn = h('button', { class: 'icon-btn', title: '桌面歌词', onclick: () => saveSettings({ desktopLyrics: { enabled: !state.settings.desktopLyrics.enabled } }) }, icon('captions', 17));
  const eqBtn = h('button', { class: 'icon-btn', title: '均衡器', onclick: openEq }, icon('eq', 17));

  function sideButton(k) {
    const side = document.getElementById('side');
    const activeTab = state.settings.ui.sideTab;
    if (!side.hidden && activeTab === k) toggleSide(false);
    else setTab(k);
    syncButtons();
  }
  function syncButtons() {
    const side = document.getElementById('side');
    const k = state.settings.ui.sideTab;
    lyricBtn.classList.toggle('on', !side.hidden && k === 'lyrics');
    aiBtn.classList.toggle('on', !side.hidden && k === 'ai' || ai.live);
    queueBtn.classList.toggle('on', !side.hidden && k === 'queue');
    dlBtn.classList.toggle('on', !!state.settings.desktopLyrics.enabled);
    const ap = activeProfile();
    eqBtn.classList.toggle('on', !!state.settings.eq.enabled || !!ap);
    eqBtn.title = ap ? `均衡器（AI 自动：${ap.name} · ${ap.key}）` : '均衡器';
  }

  bar.append(
    h('div', { class: 'np-left' }, cover, h('div', { class: 'np-meta' }, title, artist), love),
    h('div', { class: 'np-center' },
      h('div', { class: 'np-controls' }, shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn),
      h('div', { class: 'np-progress' }, cur, prog.el, total)),
    h('div', { class: 'np-right' }, lyricBtn, aiBtn, queueBtn, dlBtn, eqBtn, h('div', { class: 'vol' }, volIcon, vol.el)),
  );

  const drawTrack = () => {
    const t = player.track;
    clear(cover, coverEl(t?.coverId).firstChild, h('div', { class: 'expand-hint' }, icon('expand', 18)));
    cover.onclick = () => t && toggleImmersive();
    title.textContent = t?.title || '听音';
    clear(artist, t ? h('span', { class: 'link', onclick: () => navigate('artist', firstArtist(t.artist)) }, t.artist || '未知歌手') : '选一首歌开始吧',
      t?.album ? [' — ', h('span', { class: 'link', onclick: () => navigate('album', albumKey(t)) }, t.album)] : null);
    love.classList.toggle('on', !!t?.loved);
    love.style.visibility = t ? 'visible' : 'hidden';
  };
  const drawState = () => {
    clear(playBtn, icon(player.playing ? 'pause' : 'play', 19));
    shuffleBtn.classList.toggle('on', player.shuffle);
    clear(repeatBtn, icon(player.repeat === 'one' ? 'repeat1' : 'repeat', 17));
    repeatBtn.classList.toggle('on', player.repeat !== 'off');
    repeatBtn.title = { off: '不循环', all: '列表循环', one: '单曲循环' }[player.repeat];
  };
  const drawTime = () => {
    const d = player.duration;
    if (!prog.dragging) {
      prog.set(d ? player.time / d : 0);
      cur.textContent = fmtTime(player.time);
    }
    total.textContent = fmtTime(d);
  };
  const drawVol = () => {
    vol.set(player.muted ? 0 : player.volume);
    clear(volIcon, icon(player.muted || player.volume === 0 ? 'mute' : player.volume < 0.5 ? 'volumeLow' : 'volume', 17));
  };
  on('player:track', drawTrack);
  on('track', (t) => { if (t?.id === player.track?.id) drawTrack(); });
  on('loved', drawTrack);
  on('player:state', drawState);
  on('player:time', drawTime);
  on('player:volume', drawVol);
  on('settings', syncButtons);
  on('ai', syncButtons);
  on('tune', syncButtons);
  window.api.on('dl:state', (dl) => { state.settings.desktopLyrics = dl; syncButtons(); });
  drawTrack();
  drawState();
  drawTime();
  drawVol();
  syncButtons();
}

// ---------------- 沉浸式播放页 ----------------
const imm = document.getElementById('immersive');
let openSubs = []; // 打开期间的订阅
let drawSubs = []; // 每次重绘的订阅
let vizRaf = 0;
let noteBox = null;

const drop = (list) => { list.forEach((f) => f()); return []; };

export function toggleImmersive(force) {
  const open = force ?? imm.hidden;
  openSubs = drop(openSubs);
  drawSubs = drop(drawSubs);
  cancelAnimationFrame(vizRaf);
  if (!open) { imm.hidden = true; return; }
  imm.hidden = false;
  openSubs.push(
    on('player:track', drawImmersive),
    on('lyrics', drawImmersive),
    on('ai:seg', drawNote),
    on('ai', drawNote),
    on('player:state', () => imm.classList.toggle('paused', !player.playing)),
  );
  drawImmersive();
}

function drawNote() {
  if (!noteBox) return;
  const s = ai.timeline.segments[ai.seg];
  clear(noteBox);
  noteBox.hidden = !s;
  if (s) noteBox.append(h('b', {}, icon('sparkles', 13), s.title), s.note);
}

function drawImmersive() {
  const t = player.track;
  if (!t) return toggleImmersive(false);
  drawSubs = drop(drawSubs);
  cancelAnimationFrame(vizRaf);
  imm.classList.toggle('paused', !player.playing);
  const canvas = h('canvas', { class: 'viz', width: 920, height: 72 });
  noteBox = h('div', { class: 'imm-note' });
  const v = lyricsView({ big: true });
  drawSubs.push(v.destroy);
  clear(imm,
    h('div', { class: 'imm-left' }, coverEl(t.coverId, { small: false }),
      h('div', { class: 'imm-meta' }, h('h2', {}, t.title), h('div', { class: 'a' }, [t.artist, t.album].filter(Boolean).join(' — '))),
      canvas, noteBox),
    h('div', { class: 'imm-right' }, v.el.childElementCount ? v.el : h('div', { class: 'lyric-empty' }, '暂无歌词')),
    h('button', { class: 'tb-round imm-close', title: '收起（Esc）', onclick: () => toggleImmersive(false) }, icon('collapse', 17)));
  drawNote();
  startViz(canvas);
}

function startViz(canvas) {
  const g = canvas.getContext('2d');
  const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#0071e3';
  const data = new Uint8Array(1024);
  const N = 48;
  const draw = () => {
    vizRaf = requestAnimationFrame(draw);
    if (!analyser || imm.hidden) return;
    analyser.getByteFrequencyData(data);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = color;
    const w = canvas.width / N;
    for (let i = 0; i < N; i++) {
      // 对数分布频段，低频更细
      const a = Math.floor(2 ** (i / N * 9) + 1);
      const b = Math.floor(2 ** ((i + 1) / N * 9) + 1);
      let sum = 0;
      for (let k = a; k <= b; k++) sum += data[k] || 0;
      const v = sum / (b - a + 1) / 255;
      const hgt = Math.max(3, v * canvas.height);
      g.globalAlpha = 0.15 + v * 0.85;
      g.beginPath();
      g.roundRect(i * w + w * 0.2, canvas.height - hgt, w * 0.6, hgt, 3);
      g.fill();
    }
  };
  draw();
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !imm.hidden && !document.querySelector('.modal-overlay')) toggleImmersive(false); });
