// 在线音乐：接聚合音乐服务（搜索 / 榜单 / 歌单 / 播放地址 / 歌词），在线歌曲和本地歌曲共用同一个播放器
// 服务接口：/api/search /api/play /api/lyric /api/toplists /api/playlist /api/discover
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonStore } from './store.js';

export const DEFAULT_BASE = 'https://music.liyucheng.me';
export const SOURCES = { netease: '网易云音乐', kugou: '酷狗音乐', kuwo: '酷我音乐', bilibili: '哔哩哔哩' };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const URL_TTL = 15 * 60e3; // 播放地址有时效
const LIST_TTL = 10 * 60e3; // 榜单 / 歌单 / 搜索结果
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);

export const isOnlineId = (id) => typeof id === 'string' && id.startsWith('ol-');
// 歌曲 id 还要当文件名用（歌词缓存），只留安全字符
export const onlineId = (source, id) => `ol-${source}-${String(id).replace(/[^\w.-]/g, '_')}`;

// 酷我的歌名里混着 HTML 实体和没转义的 &
const clean = (s) => String(s ?? '')
  .replace(/\\+u([0-9a-f]{4})/gi, (_, c) => String.fromCharCode(parseInt(c, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[​‎‏]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// 服务返回的歌曲 → 和本地歌曲同样形状的对象（多一个 online 字段）
export function toTrack(s) {
  const id = onlineId(s.source, s.id);
  const artist = (s.artists || []).map((a) => clean(a.name)).filter(Boolean).join(' / ');
  return {
    id,
    online: { source: s.source, id: String(s.id), fee: s.fee || 'unknown', link: s.link || '' },
    path: `online://${s.source}/${s.id}`,
    ext: '',
    title: clean(s.name || s.title) || '未知歌曲',
    artist,
    albumArtist: artist,
    // B 站的「专辑」就是视频标题，当专辑显示太长，放到 note 里
    album: s.source === 'bilibili' ? '' : clean(s.album),
    note: s.source === 'bilibili' ? clean(s.title) : '',
    genre: '',
    composer: '',
    year: null,
    trackNo: null,
    discNo: null,
    duration: s.duration ? s.duration / 1000 : 0,
    cover: s.cover || '',
    coverId: s.cover ? id : null, // media://cover/<id> 由主进程代取并缓存
    size: 0,
    addedAt: Date.now(),
    playCount: 0,
    skipCount: 0,
    lastPlayed: 0,
    loved: false,
  };
}

// 各家封面地址里带尺寸参数，换成想要的大小
export function sizedCover(url, n) {
  if (!url) return '';
  if (/music\.126\.net/.test(url)) return `${url.split('?')[0]}?param=${n}y${n}`;
  if (/hdslb\.com/.test(url)) return `${url.split('@')[0]}@${n}w_${n}h_1c.jpg`;
  return url.replace('{size}', String(Math.min(n, 480)));
}

export function normalizeBase(input) {
  const s = String(input || '').trim();
  if (!s) return DEFAULT_BASE;
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('请填写 http(s) 服务地址，不要带账号');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const STATS = ['addedAt', 'playCount', 'skipCount', 'lastPlayed', 'loved'];

export class OnlineMusic {
  // pinned() → 歌单和播放队列里用到的在线歌曲 id，这些要存盘
  constructor({ dir, fetch, getConfig, pinned = () => new Set() }) {
    this.fetch = fetch;
    this.getConfig = getConfig;
    this.pinned = pinned;
    this.coverDir = path.join(dir, 'online-covers');
    fs.mkdirSync(this.coverDir, { recursive: true });
    this.store = new JsonStore(path.join(dir, 'online-tracks.json'), { tracks: [] });
    // 见过的在线歌曲都登记在这里；存盘时只留喜欢过、播放过、在歌单或队列里的
    this.tracks = new Map(this.store.data.tracks.map((t) => [t.id, t]));
    this.urls = new Map(); // id → { info, exp } 或进行中的 Promise
    this.lists = new Map(); // 接口路径 → { data, exp }
    this.pruneCovers();
  }

  get enabled() { return this.getConfig()?.enabled !== false; }
  get base() {
    try { return normalizeBase(this.getConfig()?.base); } catch { return DEFAULT_BASE; }
  }

  sourceName(t) { return SOURCES[t?.online?.source] || t?.online?.source || ''; }

  clearCache() {
    this.urls.clear();
    this.lists.clear();
  }

  // ---------- 请求 ----------
  async api(apiPath, { timeout = 25000, method = 'GET', body } = {}) {
    if (!this.enabled) throw new Error('在线音乐已在设置里关闭');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await this.fetch(`${this.base}${apiPath}`, {
        method,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(ctrl.signal.aborted ? '在线音乐服务响应超时' : '连不上在线音乐服务，检查网络或设置里的服务地址');
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || data == null) throw new Error(data?.error || `在线音乐服务出错（HTTP ${res.status}）`);
    return data;
  }

  async cached(apiPath, build) {
    const key = `${this.base}${apiPath}`;
    const hit = this.lists.get(key);
    if (hit && hit.exp > Date.now()) return hit.data;
    const data = build(await this.api(apiPath));
    this.lists.set(key, { data, exp: Date.now() + LIST_TTL });
    if (this.lists.size > 200) this.lists.delete(this.lists.keys().next().value);
    return data;
  }

  // ---------- 歌曲登记 ----------
  register(song) {
    if (!song?.source || song.id == null) return null;
    const t = toTrack(song);
    const old = this.tracks.get(t.id);
    if (!old) { this.tracks.set(t.id, t); return t; }
    const keep = Object.fromEntries(STATS.map((k) => [k, old[k]]));
    Object.assign(old, t, keep, { duration: t.duration || old.duration });
    return old;
  }

  registerAll(songs) {
    return (songs || []).map((s) => this.register(s)).filter(Boolean);
  }

  kept() {
    const pin = this.pinned();
    return [...this.tracks.values()].filter((t) => t.loved || t.playCount || pin.has(t.id));
  }

  save() {
    this.store.data.tracks = this.kept();
    this.store.save();
  }

  flushSync() {
    this.save();
    this.store.flushSync();
  }

  update(id, patch) {
    const t = this.tracks.get(id);
    if (!t) return null;
    for (const k of ['loved', 'rating', 'playCount', 'lastPlayed', 'skipCount']) if (k in patch) t[k] = patch[k];
    this.save();
    return t;
  }

  markPlayed(id) {
    const t = this.tracks.get(id);
    if (!t) return null;
    t.playCount = (t.playCount || 0) + 1;
    t.lastPlayed = Date.now();
    this.save();
    return t;
  }

  setDuration(id, duration) {
    const t = this.tracks.get(id);
    if (t && duration && Math.abs((t.duration || 0) - duration) > 1) t.duration = duration;
  }

  // ---------- 搜索 / 榜单 / 歌单 ----------
  async search(q, { page = 1, source } = {}) {
    const query = String(q || '').trim();
    if (!query) return { keyword: '', page, groups: [] };
    const qs = new URLSearchParams({ q: query, page: String(page), ...(source ? { source } : {}) });
    return this.cached(`/api/search?${qs}`, (r) => ({
      keyword: query,
      page,
      groups: Object.entries(r.results || {})
        // 抖音、汽水音乐只给官方入口，不能在这里播放
        .filter(([, g]) => g.status !== 'external')
        .map(([key, g]) => ({ source: key, name: SOURCES[key] || key, ok: g.ok !== false, message: g.message || g.error || '', tracks: this.registerAll(g.songs) })),
    }));
  }

  toplists() {
    return this.cached('/api/toplists', (list) => (list || []).map((x) => ({
      id: String(x.id), name: x.name, cover: x.cover || '', description: x.description || '', updateTime: x.updateTime || 0, top: this.registerAll(x.top),
    })));
  }

  playlist(id) {
    return this.cached(`/api/playlist?${new URLSearchParams({ id: String(id) })}`, (x) => ({
      id: String(x.id), name: x.name, cover: x.cover || '', description: x.description || '', creator: x.creator || '', playCount: x.playCount || 0,
      updateTime: x.updateTime || 0, tracks: this.registerAll(x.tracks),
    }));
  }

  discover() {
    const brief = (x) => ({ id: String(x.id), name: x.name, cover: x.cover || '', playCount: x.playCount || 0, description: x.description || x.copywriter || '' });
    return this.cached('/api/discover', (d) => ({
      playlists: (d.playlists || []).map(brief),
      toplists: (d.toplists || []).map(brief),
      newSongs: this.registerAll(d.newSongs),
    }));
  }

  songQuery(t) {
    return new URLSearchParams(Object.entries({
      source: t.online.source, id: t.online.id, name: t.title, artist: t.artist.split(' / ')[0], duration: t.duration ? String(Math.round(t.duration * 1000)) : '',
    }).filter(([, v]) => v));
  }

  // ---------- 播放地址 ----------
  // 返回 { url, via, kind, quality, candidates }；没有可播放的音源时 url 为 null
  resolve(track, { refresh = false } = {}) {
    const hit = this.urls.get(track.id);
    if (hit && !refresh && (hit.pending || hit.exp > Date.now())) return hit.pending || Promise.resolve(hit.info);
    const pending = this.api(`/api/play?${this.songQuery(track)}`).then((r) => {
      const abs = (u) => (u && u.startsWith('/') ? `${this.base}${u}` : u);
      const candidates = [...new Set([r.url, ...(r.resources || []).map((x) => x.url)].filter(Boolean).map(abs))];
      const info = { url: candidates[0] || null, candidates, via: r.via || '', kind: r.kind || '', quality: r.quality || null, matched: r.matched ? clean(r.matched.title || r.matched.name) : '' };
      // 酷狗、酷我的搜索结果不带封面：实际音源有封面就借来用
      if (!track.cover && r.matched?.cover) { track.cover = r.matched.cover; track.coverId = track.id; }
      // 找不到音源的结果只记一小会儿，过后可以再试
      this.urls.set(track.id, { info, exp: Date.now() + (info.url ? URL_TTL : 60e3) });
      if (this.urls.size > 500) this.urls.delete(this.urls.keys().next().value);
      return info;
    }, (e) => {
      this.urls.delete(track.id);
      throw e;
    });
    this.urls.set(track.id, { pending });
    return pending;
  }

  // 给界面看的音源信息（详情页）
  async info(id) {
    const t = this.tracks.get(id);
    if (!t) return null;
    const r = await this.resolve(t);
    return { available: !!r.url, via: r.via, viaName: SOURCES[r.via] || r.via, kind: r.kind, quality: r.quality, matched: r.matched, coverId: t.coverId };
  }

  // media://track/<id>：把音频流转给播放器，带上 Range 以支持拖动进度；地址失效就换一个或重新解析
  async stream(track, request) {
    const range = request.headers.get('range');
    for (let attempt = 0; attempt < 2; attempt++) {
      let info;
      try { info = await this.resolve(track, { refresh: attempt > 0 }); } catch (e) { return new Response(String(e.message || e), { status: 502 }); }
      if (!info.url) return new Response('没有可播放的音源', { status: 404 });
      for (const url of [info.url, ...info.candidates.filter((u) => u !== info.url)]) {
        let res;
        try {
          res = await this.fetch(url, { headers: { 'User-Agent': UA, ...(range ? { Range: range } : {}) } });
        } catch { continue; }
        if (!res.ok) { res.body?.cancel().catch(() => {}); continue; }
        info.url = url; // 后面的分段请求直接用这个能通的地址
        const headers = { 'Content-Type': res.headers.get('content-type') || 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
        for (const k of ['content-length', 'content-range']) if (res.headers.get(k)) headers[k] = res.headers.get(k);
        return new Response(res.body, { status: res.status, headers });
      }
    }
    this.urls.delete(track.id);
    return new Response('音源暂时取不到', { status: 502 });
  }

  // ---------- 歌词 ----------
  async lyric(track) {
    const r = await this.api(`/api/lyric?${this.songQuery(track)}`, { timeout: 15000 });
    const lrc = (r?.lrc || '').trim();
    if (!lrc && !r?.pure) return null;
    return { lrc, trans: (r.tlyric || '').trim(), instrumental: !!r.pure && !lrc, source: `在线音乐 · ${SOURCES[track.online.source] || track.online.source}` };
  }

  // ---------- 封面 ----------
  async cover(id, small) {
    const t = this.tracks.get(id);
    if (!t?.cover) return null;
    const url = sizedCover(t.cover, small ? 300 : 800);
    const file = path.join(this.coverDir, `${sha1(url)}.img`);
    try { return await fsp.readFile(file); } catch { /* 还没缓存 */ }
    const res = await this.fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    fsp.writeFile(file, buf).catch(() => {});
    return buf;
  }

  // 封面缓存只留最近两个月用过的
  async pruneCovers() {
    try {
      const old = Date.now() - 60 * 864e5;
      for (const name of await fsp.readdir(this.coverDir)) {
        const file = path.join(this.coverDir, name);
        const st = await fsp.stat(file);
        if (st.mtimeMs < old) await fsp.rm(file, { force: true });
      }
    } catch { /* 清不掉就留着 */ }
  }
}
