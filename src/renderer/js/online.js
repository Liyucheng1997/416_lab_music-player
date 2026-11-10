// 在线音乐：发现页（排行榜 / 推荐歌单 / 新歌）、在线歌单页、在线搜索
import { h, icon, clear, coverEl, remoteCover } from './dom.js';
import { state, emit, adoptOnline, uiPref, setUiPref } from './store.js';
import { playList } from './player.js';
import { toast, promptBox } from './ui.js';
import { navigate, render, songTable, pageHead, playButtons, summary, formatLabel, trackMenu, onViewClose } from './views.js';

export const SOURCE_NAMES = { netease: '网易云音乐', kugou: '酷狗音乐', kuwo: '酷我音乐', bilibili: '哔哩哔哩' };
const SHORT = { netease: '网易云', kugou: '酷狗', kuwo: '酷我', bilibili: 'B 站' };

// IPC 抛出的错误带一段固定前缀，去掉只留原因
const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const fmtCount = (n) => (n >= 1e8 ? `${(n / 1e8).toFixed(1)} 亿` : n >= 1e4 ? `${Math.round(n / 1e4)} 万` : String(n || 0));
const loading = (text = '') => h('div', { class: 'empty' }, h('div', { class: 'spinner' }), text);
const failed = (e, retry) => h('div', { class: 'empty' }, icon('globe', 34, { 'stroke-width': 1.4 }), errText(e),
  h('button', { class: 'btn btn-sm', onclick: retry }, icon('refresh', 14), '重试'));

// 别处发起在线搜索：点在线歌曲的歌手名、发现页的搜索框
export function searchOnline(q) {
  q = String(q || '').trim();
  if (!q) return;
  state.searchScope = 'online';
  emit('search:set', q);
  navigate('search', q);
}

async function playPlaylist(id) {
  try {
    const pl = await window.api.invoke('online:playlist', id);
    const tracks = adoptOnline(pl.tracks);
    if (tracks.length) playList(tracks.map((t) => t.id), 0, { shuffle: false });
  } catch (e) {
    toast(errText(e), 'error');
  }
}

// ---------------- 发现页 ----------------
export function onlineView() {
  const body = h('div', { class: 'page-scroll' }, loading());
  const input = h('input', {
    class: 'input',
    placeholder: '在线搜索歌曲、歌手',
    spellcheck: false,
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) searchOnline(input.value); },
  });
  const page = h('div', { class: 'page' },
    pageHead({
      eyebrow: 'Online',
      title: '在线音乐',
      sub: '网易云、酷狗、酷我、B 站，一处搜遍',
      actions: h('div', { class: 'ol-search' }, input, h('button', { class: 'btn btn-primary', onclick: () => searchOnline(input.value) }, icon('search', 15), '搜索')),
    }),
    body);

  const listTile = (x, sub) => {
    const cover = remoteCover(x.cover);
    cover.append(h('button', { class: 'play-fab', title: '播放', onclick: (e) => { e.stopPropagation(); playPlaylist(x.id); } }, icon('play', 18)));
    return h('div', { class: 'tile', onclick: () => navigate('onlinelist', x.id) }, cover,
      h('div', { class: 'tile-name', title: x.name }, x.name),
      h('div', { class: 'tile-sub', title: sub }, sub));
  };
  const section = (title, content) => h('section', { class: 'ol-section' }, h('h3', {}, title), content);

  const load = async () => {
    clear(body, loading());
    try {
      const [d, tops] = await Promise.all([window.api.invoke('online:discover'), window.api.invoke('online:toplists')]);
      if (!page.isConnected) return;
      const news = adoptOnline(d.newSongs);
      const ids = news.map((t) => t.id);
      clear(body,
        tops.length ? section('排行榜', h('div', { class: 'grid' }, tops.map((x) => listTile(x, adoptOnline(x.top).map((t) => t.title).join(' / ') || x.description)))) : null,
        d.playlists.length ? section('推荐歌单', h('div', { class: 'grid' }, d.playlists.map((x) => listTile(x, `${fmtCount(x.playCount)} 次播放`)))) : null,
        news.length ? section('新歌速递', h('div', { class: 'ol-songs' }, news.map((t, i) => h('div', {
          class: 'list-row',
          title: '双击播放',
          ondblclick: () => playList(ids, i, { shuffle: false }),
          oncontextmenu: (e) => { e.preventDefault(); trackMenu([t.id], e.clientX, e.clientY, { playFrom: () => playList(ids, i, { shuffle: false }) }); },
        },
        coverEl(t.coverId),
        h('div', { class: 'grow' }, h('div', { class: 'name' }, t.title), h('div', { class: 'desc' }, [t.artist, t.album].filter(Boolean).join(' · '))),
        h('div', { class: 'actions' }, h('button', { class: 'icon-btn', title: '播放', onclick: () => playList(ids, i, { shuffle: false }) }, icon('play', 16))))))) : null);
    } catch (e) {
      if (page.isConnected) clear(body, failed(e, load));
    }
  };
  load();
  return page;
}

// ---------------- 在线歌单 / 榜单 ----------------
export function onlineListView(id) {
  const page = h('div', { class: 'page' }, loading());
  const load = async () => {
    clear(page, loading());
    try {
      const pl = await window.api.invoke('online:playlist', id);
      if (!page.isConnected) return;
      const tracks = adoptOnline(pl.tracks);
      const ids = () => tracks.map((t) => t.id);
      const t = songTable(tracks, { emptyText: '这个歌单是空的' });
      const save = h('button', { class: 'btn', title: '存成听音里的歌单（歌曲仍是在线播放）', onclick: async () => {
        const name = await promptBox({ title: '保存为歌单', value: pl.name });
        if (!name) return;
        const made = await window.api.invoke('pl:create', name, ids());
        state.playlists.push(made);
        emit('playlists');
        toast(`已保存为歌单「${name}」，共 ${tracks.length} 首`, 'success');
      } }, icon('listPlus', 15), '存为歌单');
      clear(page,
        h('div', { class: 'hero' }, remoteCover(pl.cover),
          h('div', { class: 'hero-info' },
            h('div', { class: 'eyebrow' }, 'Online Playlist'),
            h('h1', {}, pl.name),
            h('div', { class: 'meta' }, [summary(tracks), pl.creator, pl.playCount ? `${fmtCount(pl.playCount)} 次播放` : ''].filter(Boolean).join(' · ')),
            pl.description ? h('div', { class: 'meta ol-desc', title: pl.description }, pl.description) : null,
            h('div', { class: 'hero-actions' }, playButtons(ids), save))),
        t.el);
    } catch (e) {
      if (page.isConnected) clear(page, failed(e, load));
    }
  };
  load();
  return page;
}

// ---------------- 在线搜索 ----------------
// 搜过的关键词留着结果，来回切换不用重搜
const results = new Map();

// 「全部」：各平台的结果轮流排，同一首歌（歌名和歌手都一样）只留排在最前的一条
function merged(groups) {
  const out = [];
  const seen = new Set();
  const norm = (s) => (s || '').toLowerCase().replace(/[\s\p{P}]+/gu, '');
  for (let i = 0; groups.some((g) => i < g.tracks.length); i++) {
    for (const g of groups) {
      const t = g.tracks[i];
      if (!t) continue;
      const key = `${norm(t.title)}\u0001${norm(t.artist)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

export function onlineSearchView(q, scopeSeg) {
  let data = results.get(q) || null;
  let filter = uiPref('olSource', 'all');
  let table = null;
  let busy = false;
  const head = h('div');
  const bar = h('div', { class: 'rec-bar' });
  const body = h('div', { class: 'rec-body' }, loading('正在各个平台搜索…'));
  const page = h('div', { class: 'page' }, head, bar, body);
  onViewClose(() => table?.api.destroy());

  const current = () => {
    if (!data) return [];
    if (filter !== 'all' && !data.groups.some((g) => g.source === filter)) filter = 'all';
    return filter === 'all' ? merged(data.groups) : data.groups.find((g) => g.source === filter).tracks;
  };

  const draw = () => {
    const tracks = current();
    const down = data ? data.groups.filter((g) => !g.ok).map((g) => SHORT[g.source] || g.name) : [];
    clear(head, pageHead({
      eyebrow: 'Online Search',
      title: `“${q}”`,
      sub: !data ? '在线搜索' : `${tracks.length} 首在线歌曲${down.length ? ` · ${down.join('、')}暂时搜不到` : ''}`,
      actions: [scopeSeg, ...(tracks.length ? playButtons(() => tracks.map((t) => t.id)) : [])],
    }));
    if (!data) return clear(bar);
    const chip = (key, label, n) => h('button', { class: filter === key ? 'active' : '', onclick: () => { filter = key; setUiPref('olSource', key); draw(); } }, `${label} ${n}`);
    clear(bar,
      h('div', { class: 'seg' }, chip('all', '全部', merged(data.groups).length), data.groups.map((g) => chip(g.source, SHORT[g.source] || g.name, g.tracks.length))),
      data.more ? h('button', { class: 'btn btn-sm', disabled: busy, onclick: more }, busy ? '正在加载…' : '更多结果') : null);
    table?.api.destroy();
    table = songTable(tracks, {
      emptyText: '没有搜到，换个关键词试试',
      // B 站的结果是视频，副标题显示视频标题
      sub: (t) => (t.note ? `${SHORT[t.online.source]} · ${t.note}` : formatLabel(t)),
    });
    clear(body, table.el);
  };

  const adopt = (r) => r.groups.map((g) => ({ ...g, tracks: adoptOnline(g.tracks) }));

  const load = async () => {
    try {
      const r = await window.api.invoke('online:search', q, { page: 1 });
      data = { groups: adopt(r), page: 1, more: r.groups.some((g) => g.tracks.length >= 10) };
      results.set(q, data);
      if (results.size > 30) results.delete(results.keys().next().value);
      if (page.isConnected) draw();
    } catch (e) {
      if (page.isConnected) clear(body, failed(e, () => { clear(body, loading('正在各个平台搜索…')); load(); }));
    }
  };

  async function more() {
    if (busy) return;
    busy = true;
    draw();
    try {
      const r = await window.api.invoke('online:search', q, { page: data.page + 1 });
      let added = 0;
      for (const g of adopt(r)) {
        const mine = data.groups.find((x) => x.source === g.source);
        if (!mine) continue;
        const have = new Set(mine.tracks.map((t) => t.id));
        const fresh = g.tracks.filter((t) => !have.has(t.id));
        mine.tracks.push(...fresh);
        added += fresh.length;
      }
      data.page++;
      data.more = added > 0;
      if (!added) toast('没有更多结果了');
    } catch (e) {
      toast(errText(e), 'error');
    }
    busy = false;
    if (page.isConnected) draw();
  }

  if (data) draw();
  else {
    draw();
    // 边打字边搜：停下来一会儿再发请求
    const timer = setTimeout(load, 500);
    onViewClose(() => clearTimeout(timer));
  }
  return page;
}
