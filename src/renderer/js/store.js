// 全局状态：资料库数据、派生分类（专辑 / 歌手 / 流派 / 年代 / 文件夹）、设置、简单事件
import { compare } from './dom.js';

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, payload) {
  listeners.get(evt)?.forEach((fn) => fn(payload));
}

export const state = {
  tracks: [],
  byId: new Map(),
  playlists: [],
  folders: [],
  settings: null,
  scanning: false,
  view: { name: 'songs', arg: null },
  search: '',
  // AI 分类：tags[id] = { style, lang, mood: [], scene: [] }；dims 是分类表
  tags: {},
  tagDims: {},
  tagStatus: null,
  // 在线歌曲不进资料库列表（tracks），但和本地歌曲一起放在 byId 里，队列、歌单、歌词都按 id 取
  searchScope: 'local',
};

export const isOnline = (t) => !!t?.online;
export const onlineEnabled = () => state.settings?.online?.enabled !== false;
export const onlineTracks = () => [...state.byId.values()].filter(isOnline);

// 主进程返回的在线歌曲 → 界面里唯一的那份对象（已有的就地更新，保持引用不变）
export function adoptOnline(list) {
  return (list || []).map((t) => {
    const cur = state.byId.get(t.id);
    if (cur) return Object.assign(cur, t);
    state.byId.set(t.id, t);
    return t;
  });
}

let derivedCache = null;

// 与主进程 album-key.js 的规则一致：没有「专辑歌手」标签的按目录归组
export function albumKey(t) {
  if (t.tagAlbumArtist === false) return `${t.path.slice(0, Math.max(t.path.lastIndexOf('\\'), t.path.lastIndexOf('/')))}\u0001${t.album}`;
  return `${t.albumArtist}\u0001${t.album}`;
}

export async function loadLibrary() {
  const snap = await window.api.invoke('lib:snapshot');
  // 这次会话里见过的在线歌曲（搜索结果、榜单）留着，免得队列里的歌找不到
  const seen = onlineTracks();
  state.tracks = snap.tracks;
  state.byId = new Map(snap.tracks.map((t) => [t.id, t]));
  for (const t of seen) state.byId.set(t.id, t);
  adoptOnline(snap.online);
  state.playlists = snap.playlists;
  state.folders = snap.folders;
  state.scanning = snap.scanning;
  const tg = await window.api.invoke('tags:get');
  state.tags = tg.tags;
  state.tagDims = tg.dims;
  state.tagStatus = tg.status;
  derivedCache = null;
  emit('library');
}

export function patchTrack(t) {
  if (!t) return;
  const cur = state.byId.get(t.id);
  if (cur) Object.assign(cur, t);
  emit('track', cur || t);
}

const splitArtists = (s) => (s || '').split(/\s*(?:\/|;|、|&|，|,|\bfeat\.?\s|\bft\.\s)\s*/i).map((x) => x.trim()).filter(Boolean);

// 「POP」「pop」「Pop」合并成一个流派
const genreName = (g) => (/^[\x00-\x7f]+$/.test(g) ? g.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : g);

function groupBy(list, keyFn) {
  const m = new Map();
  for (const t of list) for (const k of [].concat(keyFn(t))) {
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return m;
}

export function sortAlbumTracks(list) {
  return [...list].sort((a, b) => (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 999) - (b.trackNo || 999) || compare(a.title, b.title));
}

export function derived() {
  if (derivedCache) return derivedCache;
  const tracks = state.tracks;
  const albums = [...groupBy(tracks, (t) => (t.album ? albumKey(t) : null)).entries()].map(([key, list]) => {
    const sorted = sortAlbumTracks(list);
    const artists = new Set(list.map((t) => t.albumArtist || t.artist));
    return {
      key,
      name: list[0].album,
      artist: artists.size > 1 ? '群星' : list[0].albumArtist || list[0].artist,
      year: Math.max(0, ...list.map((t) => t.year || 0)) || null,
      coverId: list.find((t) => t.coverId)?.coverId || null,
      tracks: sorted,
      addedAt: Math.max(...list.map((t) => t.addedAt || 0)),
    };
  }).sort((a, b) => compare(a.name, b.name));

  const artists = [...groupBy(tracks, (t) => splitArtists(t.artist).length ? splitArtists(t.artist) : ['未知歌手']).entries()].map(([name, list]) => ({
    name,
    tracks: list,
    albums: new Set(list.map((t) => t.album).filter(Boolean)).size,
    coverId: list.find((t) => t.coverId)?.coverId || null,
  })).sort((a, b) => compare(a.name, b.name));

  const genres = [...groupBy(tracks, (t) => (t.genre ? t.genre.split(/\s*[/;,]\s*/).map(genreName) : ['未分类'])).entries()]
    .map(([name, list]) => ({ name, tracks: list, coverIds: [...new Set(list.map((t) => t.coverId).filter(Boolean))].slice(0, 4) }))
    .sort((a, b) => b.tracks.length - a.tracks.length);

  const years = [...groupBy(tracks, (t) => (t.year ? `${Math.floor(t.year / 10) * 10}s` : '未知年代')).entries()]
    .map(([name, list]) => ({ name, tracks: list, coverIds: [...new Set(list.map((t) => t.coverId).filter(Boolean))].slice(0, 4) }))
    .sort((a, b) => compare(b.name, a.name));

  const ai = {};
  for (const dim of Object.keys(state.tagDims)) {
    const order = state.tagDims[dim].values;
    ai[dim] = [...groupBy(tracks, (t) => state.tags[t.id]?.[dim] || null).entries()]
      .map(([name, list]) => ({ name, tracks: list, coverIds: [...new Set(list.map((t) => t.coverId).filter(Boolean))].slice(0, 4) }))
      .sort((a, b) => b.tracks.length - a.tracks.length || order.indexOf(a.name) - order.indexOf(b.name));
  }

  derivedCache = { albums, artists, genres, years, ai };
  return derivedCache;
}

export function invalidate() { derivedCache = null; }

// 搜索：空格分隔的多个关键词都要命中（标题 / 歌手 / 专辑 / 流派 / 文件名 / AI 分类）
export function matchSearch(list, q) {
  q = q.trim().toLowerCase();
  if (!q) return list;
  const words = q.split(/\s+/);
  return list.filter((t) => {
    const tg = state.tags[t.id];
    const hay = `${t.title}\u0001${t.artist}\u0001${t.album}\u0001${t.genre}\u0001${t.composer}\u0001${t.path}${tg ? `\u0001${tg.style}\u0001${tg.lang}\u0001${tg.mood.join('\u0001')}\u0001${tg.scene.join('\u0001')}` : ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export async function saveSettings(patch) {
  state.settings = await window.api.invoke('settings:set', patch);
  emit('settings', state.settings);
  return state.settings;
}

export function uiPref(key, fallback) {
  return state.settings?.ui?.[key] ?? fallback;
}

export function setUiPref(key, value) {
  state.settings.ui[key] = value;
  window.api.invoke('settings:set', { ui: { [key]: value } });
}
