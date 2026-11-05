// 资料库视图：路由、歌曲表格（虚拟滚动）、专辑 / 歌手 / 流派 / 年代 / 文件夹 / 歌单 / 智能列表
import { h, icon, clear, fmtTime, fmtTotal, fmtDate, coverEl, compare } from './dom.js';
import { state, emit, on, derived, matchSearch, sortAlbumTracks, patchTrack, uiPref, setUiPref, loadLibrary, albumKey } from './store.js';
import { player, playList, playNext, addToQueue } from './player.js';
import { menu, toast, promptBox, confirmBox } from './ui.js';
import { openCoverSearch, openLyricsSearch } from './dialogs.js';
import { recommendView } from './recommend.js';

const content = document.getElementById('content');
const history = { stack: [], pos: -1 };

export function navigate(name, arg = null, { push = true } = {}) {
  state.view = { name, arg };
  if (push) {
    history.stack = history.stack.slice(0, history.pos + 1);
    history.stack.push({ name, arg });
    history.pos = history.stack.length - 1;
  }
  emit('view', state.view);
  render();
}
export const canBack = () => history.pos > 0;
export const canForward = () => history.pos < history.stack.length - 1;
export function back() { if (canBack()) { history.pos--; const v = history.stack[history.pos]; navigate(v.name, v.arg, { push: false }); } }
export function forward() { if (canForward()) { history.pos++; const v = history.stack[history.pos]; navigate(v.name, v.arg, { push: false }); } }

let activeTable = null;

export function render() {
  activeTable?.destroy();
  activeTable = null;
  const { name, arg } = state.view;
  if (!state.tracks.length && !['playlist', 'settings'].includes(name)) return clear(content, welcome());
  const fn = VIEWS[name] || VIEWS.songs;
  clear(content, fn(arg));
}

// ---------------- 通用：页面头 ----------------
export function pageHead({ eyebrow, title, sub, actions }) {
  return h('div', { class: 'page-head' },
    h('div', {}, eyebrow && h('div', { class: 'eyebrow' }, eyebrow), h('h1', {}, title), sub && h('div', { class: 'sub' }, sub)),
    actions && h('div', { class: 'actions' }, actions));
}

export function playButtons(getIds) {
  return [
    h('button', { class: 'btn btn-primary', onclick: () => { const ids = getIds(); ids.length && playList(ids, 0, { shuffle: false }); } }, icon('play', 15, { fill: 'currentColor' }), '播放'),
    h('button', { class: 'btn', onclick: () => { const ids = getIds(); ids.length && playList(ids, Math.floor(Math.random() * ids.length), { shuffle: true }); } }, icon('shuffle', 15), '随机'),
  ];
}

export const summary = (list) => `${list.length} 首 · ${fmtTotal(list.reduce((s, t) => s + (t.duration || 0), 0))}`;

// ---------------- 歌曲表格 ----------------
const COLUMNS = [
  { key: 'num', label: '#', cls: 'c-num' },
  { key: 'title', label: '标题', cls: 'c-title', sort: (a, b) => compare(a.title, b.title) },
  { key: 'artist', label: '歌手', cls: 'c-artist', sort: (a, b) => compare(a.artist, b.artist) || compare(a.album, b.album) || (a.trackNo || 0) - (b.trackNo || 0) },
  { key: 'album', label: '专辑', cls: 'c-album', sort: (a, b) => compare(a.album, b.album) || (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0) },
  { key: 'duration', label: '时长', cls: 'c-dur', sort: (a, b) => (a.duration || 0) - (b.duration || 0) },
  { key: 'plays', label: '播放', cls: 'c-plays', sort: (a, b) => (a.playCount || 0) - (b.playCount || 0) },
  { key: 'love', label: '', cls: 'c-love' },
];

export function songTable(tracks, opts = {}) {
  const { compact = false, sortKey = null, numbering = 'index', playlistId = null, emptyText = '没有歌曲' } = opts;
  let list = tracks;
  let sort = sortKey ? uiPref(sortKey, null) : null;
  const ROW = 46;
  const selected = new Set();
  let anchor = -1;
  let raf = 0;

  const applySort = () => {
    list = tracks;
    if (sort) {
      const col = COLUMNS.find((c) => c.key === sort.key);
      if (col?.sort) list = [...tracks].sort((a, b) => col.sort(a, b) * sort.dir);
    }
  };
  applySort();

  const head = h('div', { class: 'thead' }, COLUMNS.map((c) => {
    const el = h('div', { class: `${c.cls} ${c.sort && sortKey ? 'sortable' : ''} ${sort?.key === c.key ? 'sorted' : ''}` }, c.label,
      sort?.key === c.key ? icon('down', 12, { style: sort.dir > 0 ? '' : 'transform:rotate(180deg)' }) : null);
    if (c.sort && sortKey) {
      el.addEventListener('click', () => {
        sort = sort?.key === c.key ? (sort.dir > 0 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 };
        setUiPref(sortKey, sort);
        render();
      });
    }
    return el;
  }));

  const inner = h('div', { class: 'tbody-inner' });
  const body = h('div', { class: 'tbody', tabindex: '0' }, inner);
  const table = h('div', { class: `table ${compact ? 'compact' : ''}` }, head, body);

  const playingId = () => player.track?.id;
  const ids = () => list.map((t) => t.id);

  function rowEl(t, i) {
    const cur = playingId() === t.id;
    const num = cur
      ? h('span', { class: `eq-bars ${player.playing ? '' : 'paused'}` }, h('i'), h('i'), h('i'))
      : numbering === 'track' ? (t.trackNo || '') : i + 1;
    const love = h('button', {
      class: `love-btn ${t.loved ? 'on' : ''}`,
      title: t.loved ? '取消喜欢' : '喜欢',
      onclick: async (e) => { e.stopPropagation(); await toggleLove(t); },
      ondblclick: (e) => e.stopPropagation(),
    }, icon('heart', 15));
    const linkArtist = h('a', { onclick: (e) => { e.stopPropagation(); navigate('artist', firstArtist(t.artist)); } }, t.artist || '未知歌手');
    const row = h('div', {
      class: `trow ${selected.has(t.id) ? 'selected' : ''} ${cur ? 'playing' : ''}`,
      style: { transform: `translateY(${i * ROW}px)` },
      draggable: 'true',
      dataset: { i: String(i) },
    },
    h('div', { class: 'c-num' }, num),
    h('div', { class: 'c-title' }, compact && numbering === 'track' ? null : coverEl(t.coverId), h('div', { class: 't-text' },
      h('span', { class: 't-title' }, t.title),
      compact ? null : opts.sub ? h('span', { class: 't-sub t-reason' }, opts.sub(t)) : h('span', { class: 't-sub' }, formatLabel(t)))),
    h('div', { class: 'c-artist' }, linkArtist),
    h('div', { class: 'c-album' }, t.album ? h('a', { onclick: (e) => { e.stopPropagation(); navigate('album', albumKey(t)); } }, t.album) : ''),
    h('div', { class: 'c-dur' }, fmtTime(t.duration)),
    h('div', { class: 'c-plays' }, t.playCount || ''),
    h('div', { class: 'c-love' }, love));
    return row;
  }

  function draw() {
    raf = 0;
    const top = body.scrollTop;
    const height = body.clientHeight || 800;
    const start = Math.max(0, Math.floor(top / ROW) - 8);
    const end = Math.min(list.length, Math.ceil((top + height) / ROW) + 8);
    inner.style.height = `${list.length * ROW}px`;
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.append(rowEl(list[i], i));
    inner.replaceChildren(frag);
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
  body.addEventListener('scroll', schedule, { passive: true });
  const ro = new ResizeObserver(schedule);
  ro.observe(body);

  const refreshSelection = () => {
    for (const row of inner.children) row.classList.toggle('selected', selected.has(list[Number(row.dataset.i)]?.id));
  };

  const indexFromEvent = (e) => {
    const row = e.target.closest('.trow');
    return row ? Number(row.dataset.i) : -1;
  };

  body.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    const i = indexFromEvent(e);
    if (i < 0) return;
    const id = list[i].id;
    if (e.button === 2 && selected.has(id)) return;
    if (e.shiftKey && anchor >= 0) {
      if (!e.ctrlKey) selected.clear();
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      for (let k = a; k <= b; k++) selected.add(list[k].id);
    } else if (e.ctrlKey) {
      selected.has(id) ? selected.delete(id) : selected.add(id);
      anchor = i;
    } else {
      selected.clear();
      selected.add(id);
      anchor = i;
    }
    // 只改选中样式，不重建行：重建会让按下的元素脱离文档，浏览器就不再触发 click / dblclick
    refreshSelection();
  });
  body.addEventListener('dblclick', (e) => {
    if (e.target.closest('a, button')) return;
    const i = indexFromEvent(e);
    if (i >= 0) playList(ids(), i);
  });
  body.addEventListener('contextmenu', (e) => {
    const i = indexFromEvent(e);
    if (i < 0) return;
    e.preventDefault();
    const sel = list.filter((t) => selected.has(t.id)).map((t) => t.id);
    trackMenu(sel.length ? sel : [list[i].id], e.clientX, e.clientY, {
      playFrom: () => playList(ids(), i),
      playlistId,
      onRemoved: opts.onRemoved,
    });
  });
  body.addEventListener('dragstart', (e) => {
    const i = indexFromEvent(e);
    if (i < 0) return;
    if (!selected.has(list[i].id)) { selected.clear(); selected.add(list[i].id); refreshSelection(); }
    e.dataTransfer.setData('application/x-tingyin-tracks', JSON.stringify([...selected]));
    e.dataTransfer.effectAllowed = 'copy';
  });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && selected.size) {
      const i = list.findIndex((t) => selected.has(t.id));
      if (i >= 0) playList(ids(), i);
    } else if (e.key === 'a' && e.ctrlKey) {
      e.preventDefault();
      list.forEach((t) => selected.add(t.id));
      refreshSelection();
    } else if (e.key === 'Delete' && playlistId && selected.size) {
      removeFromPlaylist(playlistId, [...selected], opts.onRemoved);
    }
  });

  const offs = [on('player:track', schedule), on('player:state', schedule), on('track', schedule)];
  const api = {
    destroy() { ro.disconnect(); offs.forEach((f) => f()); cancelAnimationFrame(raf); },
    scrollToPlaying() {
      const i = list.findIndex((t) => t.id === playingId());
      if (i >= 0) body.scrollTop = i * ROW - body.clientHeight / 2 + ROW;
    },
  };
  activeTable = api;
  setTimeout(draw); // 不用 rAF：窗口被遮挡时 rAF 不触发
  if (!list.length) table.append(h('div', { class: 'empty' }, icon('file', 34, { 'stroke-width': 1.4 }), emptyText));
  return { el: table, api };
}

export function formatLabel(t) {
  const ext = (t.ext || '').toUpperCase();
  if (t.lossless) return `${t.bitsPerSample > 16 || t.sampleRate > 48000 ? 'Hi-Res 无损' : '无损'} · ${ext}`;
  return t.bitrate ? `${ext} · ${t.bitrate} kbps` : ext;
}

export { albumKey };
export const firstArtist = (s) => (s || '未知歌手').split(/\s*(?:\/|;|、|&|，|,|\bfeat\.?\s|\bft\.\s)\s*/i)[0] || '未知歌手';

export async function toggleLove(t) {
  const r = await window.api.invoke('lib:update', t.id, { loved: !t.loved });
  patchTrack(r);
  emit('loved');
}

async function removeFromPlaylist(plId, idsToRemove, after) {
  const pl = await window.api.invoke('pl:update', plId, { remove: idsToRemove });
  const local = state.playlists.find((p) => p.id === plId);
  if (local) local.trackIds = pl.trackIds;
  emit('playlists');
  after?.();
}

export function playlistSubmenu(ids) {
  return [
    { label: '新建歌单…', icon: 'plus', onClick: async () => {
      const name = await promptBox({ title: '新建歌单', value: '新建歌单' });
      if (!name) return;
      const pl = await window.api.invoke('pl:create', name, ids);
      state.playlists.push(pl);
      emit('playlists');
      toast(`已创建「${name}」并添加 ${ids.length} 首`, 'success');
    } },
    ...(state.playlists.length ? ['-'] : []),
    ...state.playlists.map((p) => ({
      label: p.name,
      icon: 'playlist',
      onClick: () => addToPlaylist(p.id, ids),
    })),
  ];
}

export async function addToPlaylist(plId, ids) {
  const pl = await window.api.invoke('pl:update', plId, { add: ids });
  const local = state.playlists.find((p) => p.id === plId);
  if (local) local.trackIds = pl.trackIds;
  emit('playlists');
  toast(`已添加到「${pl.name}」`, 'success');
}

export function trackMenu(ids, x, y, { playFrom, playlistId, onRemoved } = {}) {
  const tracks = ids.map((id) => state.byId.get(id)).filter(Boolean);
  const one = tracks.length === 1 ? tracks[0] : null;
  const allLoved = tracks.every((t) => t.loved);
  menu([
    tracks.length > 1 ? { header: `已选 ${tracks.length} 首` } : null,
    { label: '播放', icon: 'play', onClick: () => (playFrom && one ? playFrom() : playList(ids, 0)) },
    { label: '下一首播放', icon: 'listPlus', onClick: () => playNext(ids) },
    { label: '加入播放队列', icon: 'queue', onClick: () => addToQueue(ids) },
    { label: '添加到歌单', icon: 'playlist', sub: playlistSubmenu(ids) },
    '-',
    { label: allLoved ? '取消喜欢' : '喜欢', icon: 'heart', onClick: async () => {
      for (const t of tracks) {
        const r = await window.api.invoke('lib:update', t.id, { loved: !allLoved });
        patchTrack(r);
      }
      emit('loved');
    } },
    one && { label: '转到专辑', icon: 'album', disabled: !one.album, onClick: () => navigate('album', albumKey(one)) },
    one && { label: '转到歌手', icon: 'user', onClick: () => navigate('artist', firstArtist(one.artist)) },
    '-',
    one && { label: '查找歌词…', icon: 'mic', onClick: () => openLyricsSearch(one) },
    one && { label: '查找封面…', icon: 'image', onClick: () => openCoverSearch(one) },
    one && { label: '在资源管理器中显示', icon: 'folderOpen', onClick: () => window.api.invoke('lib:reveal', one.id) },
    playlistId && '-',
    playlistId && { label: '从歌单中移除', icon: 'trash', onClick: () => removeFromPlaylist(playlistId, ids, onRemoved) },
  ], x, y);
}

// ---------------- 视图 ----------------
function songsView() {
  const list = state.tracks;
  const t = songTable(list, { sortKey: 'sort:songs' });
  return h('div', { class: 'page' },
    pageHead({ eyebrow: 'Library', title: '歌曲', sub: summary(list), actions: playButtons(currentListIds) }),
    t.el);
}
// 播放按钮按表格当前排序播放
function currentListIds() {
  const sort = uiPref('sort:songs', null);
  let list = state.tracks;
  if (sort) {
    const col = COLUMNS.find((c) => c.key === sort.key);
    list = [...list].sort((a, b) => col.sort(a, b) * sort.dir);
  }
  return list.map((t) => t.id);
}

function searchView(q) {
  const tracks = matchSearch(state.tracks, q);
  const ql = q.trim().toLowerCase();
  const { albums, artists } = derived();
  const hitArtists = artists.filter((a) => a.name.toLowerCase().includes(ql)).slice(0, 12);
  const hitAlbums = albums.filter((a) => `${a.name} ${a.artist}`.toLowerCase().includes(ql)).slice(0, 12);
  const t = songTable(tracks, { emptyText: '没有匹配的歌曲' });
  return h('div', { class: 'page' },
    pageHead({ eyebrow: 'Search', title: `“${q}”`, sub: `${tracks.length} 首歌曲 · ${hitArtists.length} 位歌手 · ${hitAlbums.length} 张专辑`, actions: playButtons(() => tracks.map((x) => x.id)) }),
    hitArtists.length || hitAlbums.length ? h('div', { style: { flexShrink: 0, padding: '0 20px' } },
      hitArtists.length ? h('div', { class: 'row-scroll' }, hitArtists.map(artistTile)) : null,
      hitAlbums.length ? h('div', { class: 'row-scroll' }, hitAlbums.map(albumTile)) : null) : null,
    t.el);
}

function albumTile(a) {
  return h('div', { class: 'tile', onclick: () => navigate('album', a.key), oncontextmenu: (e) => { e.preventDefault(); trackMenu(a.tracks.map((t) => t.id), e.clientX, e.clientY); } },
    (() => {
      const c = coverEl(a.coverId);
      c.append(h('button', { class: 'play-fab', title: '播放', onclick: (e) => { e.stopPropagation(); playList(a.tracks.map((t) => t.id), 0, { shuffle: false }); } }, icon('play', 18)));
      return c;
    })(),
    h('div', { class: 'tile-name', title: a.name }, a.name),
    h('div', { class: 'tile-sub' }, [a.artist, a.year].filter(Boolean).join(' · ')));
}

function albumsView() {
  const { albums } = derived();
  const mode = uiPref('albumSort', 'name');
  const sorted = mode === 'artist' ? [...albums].sort((a, b) => compare(a.artist, b.artist) || (a.year || 0) - (b.year || 0))
    : mode === 'year' ? [...albums].sort((a, b) => (b.year || 0) - (a.year || 0))
      : mode === 'added' ? [...albums].sort((a, b) => b.addedAt - a.addedAt) : albums;
  const seg = h('div', { class: 'seg' }, [['name', '名称'], ['artist', '歌手'], ['year', '年份'], ['added', '最近添加']].map(([k, label]) =>
    h('button', { class: mode === k ? 'active' : '', onclick: () => { setUiPref('albumSort', k); render(); } }, label)));
  const missing = albums.filter((a) => !a.coverId).length;
  const fill = missing ? h('button', { class: 'btn', title: '在线为缺封面的专辑查找封面', onclick: () => { window.api.invoke('cover:fillMissing'); toast(`开始为 ${missing} 张专辑查找封面，在后台进行`); } }, icon('image', 15), '补全封面') : null;
  return h('div', { class: 'page' },
    pageHead({ eyebrow: 'Library', title: '专辑', sub: `${albums.length} 张专辑${missing ? ` · ${missing} 张缺封面` : ''}`, actions: [fill, seg] }),
    h('div', { class: 'page-scroll' }, h('div', { class: 'grid' }, sorted.map(albumTile))));
}

function albumView(key) {
  const a = derived().albums.find((x) => x.key === key);
  if (!a) return emptyPage('专辑不存在了');
  const t = songTable(a.tracks, { compact: true, numbering: 'track' });
  const formats = [...new Set(a.tracks.map((x) => x.ext.toUpperCase()))].join(' / ');
  return h('div', { class: 'page' },
    h('div', { class: 'hero' }, coverEl(a.coverId, { small: false }),
      h('div', { class: 'hero-info' },
        h('div', { class: 'eyebrow' }, 'Album'),
        h('h1', {}, a.name),
        h('div', { class: 'artist-line link', onclick: () => navigate('artist', firstArtist(a.artist)) }, a.artist),
        h('div', { class: 'meta' }, [a.year, summary(a.tracks), formats].filter(Boolean).join(' · ')),
        h('div', { class: 'hero-actions' }, playButtons(() => a.tracks.map((x) => x.id)),
          h('button', { class: 'btn', title: '查找封面', onclick: () => openCoverSearch(a.tracks[0]) }, icon('image', 15), '封面'),
          h('button', { class: 'btn', onclick: (e) => trackMenu(a.tracks.map((x) => x.id), e.clientX, e.clientY) }, icon('more', 16))))),
    t.el);
}

// 头像首字：跳过开头的括号、标点
const initial = (name) => (name.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();

function artistTile(a) {
  const box = coverEl(null);
  box.replaceChildren(h('span', { class: 'avatar-initial' }, initial(a.name)));
  if (a.coverId) box.dataset.cover = a.coverId;
  lazyArtistImage(box, a.name);
  return h('div', { class: 'tile round', onclick: () => navigate('artist', a.name) },
    box,
    h('div', { class: 'tile-name', title: a.name }, a.name),
    h('div', { class: 'tile-sub' }, `${a.tracks.length} 首${a.albums ? ` · ${a.albums} 张专辑` : ''}`));
}

// 进入可视区域才去拿歌手图片，避免一次发出几百个请求
const artistIo = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    artistIo.unobserve(en.target);
    const el = en.target;
    window.api.invoke('artist:image', el.dataset.artist).then((url) => {
      if (url) el.append(h('img', { src: url, onerror: (e) => e.target.remove() }));
      else if (el.dataset.cover) el.append(h('img', { src: `media://cover/${el.dataset.cover}_s`, onerror: (e) => e.target.remove() }));
    });
  }
}, { rootMargin: '200px' });

function lazyArtistImage(el, name) {
  el.dataset.artist = name;
  artistIo.observe(el);
}

function artistsView() {
  const { artists } = derived();
  return h('div', { class: 'page' },
    pageHead({ eyebrow: 'Library', title: '歌手', sub: `${artists.length} 位歌手` }),
    h('div', { class: 'page-scroll' }, h('div', { class: 'grid' }, artists.map(artistTile))));
}

function artistView(name) {
  const a = derived().artists.find((x) => x.name === name);
  if (!a) return emptyPage('没有这位歌手的歌');
  const albums = derived().albums.filter((al) => al.tracks.some((t) => a.tracks.includes(t))).sort((x, y) => (y.year || 0) - (x.year || 0));
  const tracks = [...a.tracks].sort((x, y) => (y.playCount || 0) - (x.playCount || 0) || compare(x.album, y.album) || (x.trackNo || 0) - (y.trackNo || 0));
  const avatar = coverEl(null, { small: false });
  avatar.replaceChildren(h('span', { class: 'avatar-initial' }, initial(name)));
  if (a.coverId) avatar.dataset.cover = a.coverId;
  lazyArtistImage(avatar, name);
  const t = songTable(tracks, { compact: false });
  return h('div', { class: 'page' },
    h('div', { class: 'hero round' }, avatar,
      h('div', { class: 'hero-info' },
        h('div', { class: 'eyebrow' }, 'Artist'),
        h('h1', {}, name),
        h('div', { class: 'meta' }, `${summary(a.tracks)} · ${albums.length} 张专辑`),
        h('div', { class: 'hero-actions' }, playButtons(() => tracks.map((x) => x.id))))),
    albums.length > 1 ? h('div', { style: { padding: '0 20px', flexShrink: 0 } }, h('div', { class: 'row-scroll' }, albums.map(albumTile))) : null,
    t.el);
}

function mosaic(coverIds) {
  const box = coverEl(coverIds[0] || null);
  if (coverIds.length >= 4) box.replaceChildren(h('div', { class: 'mosaic' }, coverIds.slice(0, 4).map((id) => h('img', { src: `media://cover/${id}_s`, loading: 'lazy' }))));
  return box;
}

function groupView(kind, title, eyebrow) {
  const groups = derived()[kind];
  return h('div', { class: 'page' },
    pageHead({ eyebrow, title, sub: `${groups.length} 个分类` }),
    h('div', { class: 'page-scroll' }, h('div', { class: 'grid' }, groups.map((g) => {
      const c = mosaic(g.coverIds);
      c.append(h('button', { class: 'play-fab', onclick: (e) => { e.stopPropagation(); playList(g.tracks.map((t) => t.id), 0, { shuffle: true }); } }, icon('play', 18)));
      return h('div', { class: 'tile', onclick: () => navigate(kind === 'genres' ? 'genre' : 'year', g.name) }, c,
        h('div', { class: 'tile-name' }, g.name), h('div', { class: 'tile-sub' }, `${g.tracks.length} 首`));
    }))));
}

function groupDetail(kind, name, eyebrow) {
  const g = derived()[kind].find((x) => x.name === name);
  if (!g) return emptyPage('这个分类已经没有歌曲了');
  const list = [...g.tracks].sort((a, b) => compare(a.artist, b.artist) || compare(a.album, b.album) || (a.trackNo || 0) - (b.trackNo || 0));
  const t = songTable(list, { sortKey: `sort:${kind}` });
  return h('div', { class: 'page' }, pageHead({ eyebrow, title: name, sub: summary(list), actions: playButtons(() => list.map((x) => x.id)) }), t.el);
}

// ---------------- AI 分类 ----------------
export const tagKey = (dim, name) => `${dim}\u0001${name}`;

function aiTagsView() {
  const dims = state.tagDims;
  const dimKeys = Object.keys(dims);
  let dim = uiPref('aiDim', 'style');
  if (!dims[dim]) dim = dimKeys[0];
  const groups = derived().ai[dim] || [];
  const st = state.tagStatus || { total: state.tracks.length, done: 0, running: false };
  const left = Math.max(0, st.total - st.done);
  const seg = h('div', { class: 'seg' }, dimKeys.map((k) =>
    h('button', { class: dim === k ? 'active' : '', onclick: () => { setUiPref('aiDim', k); render(); } }, dims[k].label)));
  const start = async (all) => {
    if (!state.settings.ai.hasKey && !state.settings.ai.envKey) { toast('先在 设置 → AI 赏析 里填写 API Key', 'error'); return; }
    state.tagStatus = await window.api.invoke('tags:start', { all });
    toast(`开始为 ${all ? st.total : left} 首歌分类，在后台进行`);
    render();
  };
  const runBtn = st.running
    ? h('button', { class: 'btn', onclick: async () => { await window.api.invoke('tags:cancel'); toast('已停止分类'); } }, icon('stop', 14), '停止')
    : left ? h('button', { class: 'btn btn-primary', title: '只处理还没有分类的歌', onclick: () => start(false) }, icon('wand', 15), st.done ? `分类剩下的 ${left} 首` : '开始 AI 分类')
      : h('button', { class: 'btn', onclick: async () => { if (await confirmBox({ title: '重新分类', message: `把全部 ${st.total} 首歌重新交给 AI 分类？会消耗 API 额度。`, okText: '重新分类' })) start(true); } }, icon('refresh', 15), '重新分类');
  const sub = st.running ? `正在分类… 本次 ${st.progress?.done || 0} / ${st.progress?.total || left} 首` : `已分类 ${st.done} / ${st.total} 首 · 按${dims[dim]?.label || ''}分成 ${groups.length} 类`;
  const body = groups.length
    ? h('div', { class: 'grid' }, groups.map((g) => {
      const c = mosaic(g.coverIds);
      c.append(h('button', { class: 'play-fab', onclick: (e) => { e.stopPropagation(); playList(g.tracks.map((t) => t.id), 0, { shuffle: true }); } }, icon('play', 18)));
      return h('div', { class: 'tile', onclick: () => navigate('aitag', tagKey(dim, g.name)) }, c,
        h('div', { class: 'tile-name' }, g.name), h('div', { class: 'tile-sub' }, `${g.tracks.length} 首`));
    }))
    : h('div', { class: 'empty' }, icon('wand', 34, { 'stroke-width': 1.4 }),
      'AI 会根据歌名、歌手、专辑和所在文件夹，把歌按风格、语言、情绪和场景分好类。', h('br'), '结果只保存在听音里，不会改动、移动你的音乐文件。');
  return h('div', { class: 'page' },
    pageHead({ eyebrow: 'AI Categories', title: 'AI 分类', sub, actions: [runBtn, seg] }),
    h('div', { class: 'page-scroll' }, body));
}

function aiTagView(key) {
  const [dim, name] = String(key).split('\u0001');
  const g = derived().ai[dim]?.find((x) => x.name === name);
  if (!g) return emptyPage('这个分类已经没有歌曲了');
  const list = [...g.tracks].sort((a, b) => compare(a.artist, b.artist) || compare(a.album, b.album) || (a.trackNo || 0) - (b.trackNo || 0));
  const t = songTable(list, { sortKey: 'sort:aitag' });
  return h('div', { class: 'page' }, pageHead({ eyebrow: `AI · ${state.tagDims[dim]?.label || ''}`, title: name, sub: summary(list), actions: playButtons(() => list.map((x) => x.id)) }), t.el);
}

function foldersView() {
  const dirs = new Map();
  for (const t of state.tracks) {
    const dir = t.path.slice(0, Math.max(t.path.lastIndexOf('\\'), t.path.lastIndexOf('/')));
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(t);
  }
  const rows = [...dirs.entries()].sort((a, b) => compare(a[0], b[0]));
  return h('div', { class: 'page' },
    pageHead({ eyebrow: 'Library', title: '文件夹', sub: `${rows.length} 个文件夹 · 来自 ${state.folders.length} 个音乐库目录` }),
    h('div', { class: 'page-scroll' }, h('div', { class: 'list' }, rows.map(([dir, list]) => {
      const root = state.folders.find((f) => dir.toLowerCase().startsWith(f.toLowerCase()));
      const rel = root ? dir.slice(root.length).replace(/^[\\/]/, '') || dir.split(/[\\/]/).pop() : dir;
      return h('div', { class: 'list-row', ondblclick: () => playList(sortAlbumTracks(list).map((t) => t.id), 0), onclick: () => navigate('folder', dir) },
        h('div', { class: 'app-ico' }, icon('folder', 17)),
        h('div', { class: 'grow' }, h('div', { class: 'name' }, rel), h('div', { class: 'desc' }, `${list.length} 首 · ${dir}`)),
        h('div', { class: 'actions' }, h('button', { class: 'icon-btn', title: '播放', onclick: (e) => { e.stopPropagation(); playList(sortAlbumTracks(list).map((t) => t.id), 0); } }, icon('play', 16))));
    }))));
}

function folderView(dir) {
  const list = sortAlbumTracks(state.tracks.filter((t) => t.path.slice(0, Math.max(t.path.lastIndexOf('\\'), t.path.lastIndexOf('/'))) === dir));
  const t = songTable(list, { sortKey: 'sort:folder' });
  return h('div', { class: 'page' }, pageHead({ eyebrow: 'Folder', title: dir.split(/[\\/]/).pop(), sub: `${summary(list)} · ${dir}`, actions: playButtons(() => list.map((x) => x.id)) }), t.el);
}

function smartView(kind) {
  const conf = {
    loved: { title: '我喜欢', eyebrow: 'Loved', list: () => state.tracks.filter((t) => t.loved).sort((a, b) => compare(a.artist, b.artist)), empty: '点一下歌曲右侧的心形，喜欢的歌会出现在这里' },
    recent: { title: '最近播放', eyebrow: 'Recently Played', list: () => state.tracks.filter((t) => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 300), empty: '还没有播放记录' },
    top: { title: '最常播放', eyebrow: 'Most Played', list: () => state.tracks.filter((t) => t.playCount).sort((a, b) => b.playCount - a.playCount).slice(0, 100), empty: '还没有播放记录' },
    added: { title: '最近添加', eyebrow: 'Recently Added', list: () => [...state.tracks].sort((a, b) => b.addedAt - a.addedAt).slice(0, 300), empty: '' },
  }[kind];
  const list = conf.list();
  const t = songTable(list, { emptyText: conf.empty });
  const sub = kind === 'recent' && list[0] ? `${summary(list)} · 最近一次 ${fmtDate(list[0].lastPlayed)}` : summary(list);
  return h('div', { class: 'page' }, pageHead({ eyebrow: conf.eyebrow, title: conf.title, sub, actions: playButtons(() => list.map((x) => x.id)) }), t.el);
}

function playlistView(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return emptyPage('歌单已删除');
  const list = pl.trackIds.map((x) => state.byId.get(x)).filter(Boolean);
  const t = songTable(list, { playlistId: id, emptyText: '把歌曲拖到左侧这个歌单上，或者在右键菜单里选择「添加到歌单」', onRemoved: render });
  const more = h('button', { class: 'btn', onclick: (e) => playlistMenu(pl, e.clientX, e.clientY) }, icon('more', 16));
  return h('div', { class: 'page' },
    pageHead({ eyebrow: 'Playlist', title: pl.name, sub: summary(list), actions: [...playButtons(() => list.map((x) => x.id)), more] }),
    t.el);
}

export function playlistMenu(pl, x, y) {
  menu([
    { label: '重命名', icon: 'edit', onClick: async () => {
      const name = await promptBox({ title: '重命名歌单', value: pl.name });
      if (!name) return;
      await window.api.invoke('pl:update', pl.id, { name });
      pl.name = name;
      emit('playlists');
      if (state.view.arg === pl.id) render();
    } },
    { label: '导出为 M3U8…', icon: 'download', onClick: async () => { if (await window.api.invoke('pl:export', pl.id)) toast('已导出', 'success'); } },
    '-',
    { label: '删除歌单', icon: 'trash', onClick: async () => {
      if (!(await confirmBox({ title: '删除歌单', message: `删除「${pl.name}」？歌曲文件不会被删除。`, okText: '删除', danger: true }))) return;
      await window.api.invoke('pl:delete', pl.id);
      state.playlists = state.playlists.filter((p) => p.id !== pl.id);
      emit('playlists');
      if (state.view.arg === pl.id) navigate('songs');
    } },
  ], x, y);
}

export function emptyPage(text) {
  return h('div', { class: 'page' }, h('div', { class: 'empty' }, icon('disc', 34, { 'stroke-width': 1.4 }), text));
}

// ---------------- 欢迎页（资料库为空） ----------------
function welcome() {
  const suggestions = h('div', { class: 'suggest' });
  const hour = new Date().getHours();
  const hello = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  window.api.invoke('lib:suggestions').then((list) => {
    for (const { path: p, from, exists } of list) {
      suggestions.append(h('div', { class: 'suggest-row' },
        h('div', { class: 'app-ico' }, icon('folder', 17)),
        h('div', { class: 'grow' }, p, h('div', { class: 'desc' }, exists ? from : `${from} · 目前找不到（外接硬盘未连接？）`)),
        h('button', { class: 'btn btn-sm', disabled: !exists, onclick: () => window.api.invoke('lib:addFolder', p) }, '添加')));
    }
  });
  return h('div', { class: 'welcome' }, h('div', { class: 'welcome-card' },
    h('img', { class: 'big-ico', src: 'build/icon.png' }),
    h('div', { class: 'hello' }, `${hello} 👋`),
    h('h2', {}, '把你的', h('em', {}, '音乐'), '带进来'),
    h('p', {}, '选择存放音乐的文件夹，听音会读取标签、提取封面并建立索引。支持 MP3、FLAC、M4A、OGG、WAV，装了 ffmpeg 还能播放 APE、WMA、DSD。'),
    h('button', { class: 'btn btn-primary', style: { height: '40px', padding: '0 26px', fontSize: '14px' }, onclick: () => window.api.invoke('lib:pickFolder') }, icon('plus', 16), '添加音乐文件夹'),
    suggestions));
}

const VIEWS = {
  songs: songsView,
  search: searchView,
  albums: albumsView,
  album: albumView,
  artists: artistsView,
  artist: artistView,
  genres: () => groupView('genres', '流派', 'Genres'),
  genre: (n) => groupDetail('genres', n, 'Genre'),
  years: () => groupView('years', '年代', 'Decades'),
  year: (n) => groupDetail('years', n, 'Decade'),
  aitags: aiTagsView,
  aitag: aiTagView,
  folders: foldersView,
  folder: folderView,
  loved: () => smartView('loved'),
  recent: () => smartView('recent'),
  top: () => smartView('top'),
  added: () => smartView('added'),
  playlist: playlistView,
  foryou: recommendView,
};

export function scrollToPlaying() { activeTable?.scrollToPlaying(); }
export { loadLibrary };
