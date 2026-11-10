// 在线资源：歌词（本地 .lrc / 内嵌 / 网易云 / QQ 音乐 / 酷狗 / LRCLIB）、专辑封面（iTunes / Deezer）、歌手图片（Deezer）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson } from './store.js';
import { albumKeyOf } from './album-key.js';
import { createSources, toSimplified } from './lyric-sources.js';

const UA = 'TingYin/0.1 (local music player; https://github.com/)';
// 自动查找的来源变了就递增，让之前缓存的「未找到」重新查一次
const LYRIC_SOURCES_VERSION = 2;
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);

// 去掉括号里的版本信息，便于匹配：「晴天 (Live)」→「晴天」
export function cleanTitle(s = '') {
  return s.replace(/\s*[([（【].*?[)\]）】]\s*/g, ' ').replace(/\s+feat\..*$/i, '').trim() || s;
}

// 中文 LRC 常见 GBK 编码：UTF-8 解码出现乱码时改用 GBK
export function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}

// 查询词里有多少比例的字符出现在结果中（忽略空格与大小写）
export function overlap(query, text) {
  const q = [...new Set(query.toLowerCase().replace(/\s+/g, ''))];
  if (!q.length) return 0;
  const t = text.toLowerCase();
  return q.filter((c) => t.includes(c)).length / q.length;
}

export const firstArtist = (s = '') => s.split(/\s*[/;&,、]\s*/)[0].trim();

// 比较用：转简体、小写、去掉空白和标点
const norm = (s = '') => toSimplified(cleanTitle(s)).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// 候选歌词和要找的歌有多像；accept = 能不能直接自动采用
export function matchScore(x, want) {
  const t = norm(x.title);
  const wt = norm(want.title);
  const titleHit = !!wt && t === wt ? 2 : wt && t && (t.includes(wt) || wt.includes(t)) ? 1 : 0;
  const a = norm(x.artist);
  const wa = norm(want.artist);
  const artistHit = !!wa && !!a && (a.includes(wa) || wa.includes(a));
  const diff = want.duration && x.duration ? Math.abs(x.duration - want.duration) : null;
  let score = titleHit * 25 + (artistHit ? 30 : 0) + (x.src?.bonus || 0) + (x.exact ? 3 : 0);
  if (diff != null) score -= Math.min(40, diff * 1.5);
  if (x.synced === false) score -= 15;
  // 时长差太多多半是别的版本；歌手对不上时（例如英文名 / 中文名）要求时长几乎一致
  const accept = titleHit > 0 && (diff == null || diff <= 15) && (artistHit || !wa || (diff != null && diff <= 3));
  return { score, accept };
}

function lyricData(x, got) {
  return { lrc: got.lrc || '', trans: got.trans || '', instrumental: !!got.instrumental, source: x.src.name, remoteId: `${x.src.key}:${x.id}` };
}

export class Online {
  constructor({ dir, fetch, library, music = null, simplified = () => true }) {
    this.fetch = fetch;
    this.library = library;
    this.music = music; // 在线音乐服务：在线歌曲先按它给的歌曲 id 取歌词
    this.simplified = simplified;
    this.sources = createSources(this);
    this.lyricDir = path.join(dir, 'lyrics');
    this.artistDir = path.join(dir, 'artists');
    fs.mkdirSync(this.lyricDir, { recursive: true });
    fs.mkdirSync(this.artistDir, { recursive: true });
    this.artistMiss = new Set();
  }

  // 服务繁忙（429 / 503）时退避重试两次
  async json(url, timeout = 12000, headers = {}) {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await this.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctrl.signal });
        if (res.status === 404) return null;
        if ((res.status === 429 || res.status === 503) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new Error(res.status === 429 || res.status === 503 ? '服务繁忙' : `HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async buffer(url) {
    const res = await this.fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ================= 歌词 =================
  lyricCacheFile(id) { return path.join(this.lyricDir, `${id}.json`); }

  // 本地调整（时间偏移、AI 翻译）单独保存，叠加到任何来源的歌词上
  async getLyrics(track, opts = {}) {
    const cached = await readJson(this.lyricCacheFile(track.id));
    const found = await this.findLyrics(track, cached, opts);
    const out = { ...found, offset: cached?.offset || 0, aiTrans: cached?.aiTrans || null };
    return this.simplified() ? this.simplify(out) : out;
  }

  simplify(x) {
    return { ...x, lrc: toSimplified(x.lrc), trans: toSimplified(x.trans) };
  }

  async findLyrics(track, cached, { online = true } = {}) {
    if (cached && (cached.lrc || cached.instrumental)) return cached;

    // CUE 分轨共用一个整轨文件，同名 .lrc 对应的是整张专辑，不能用
    const base = track.cueStart != null || track.online ? null : track.path.slice(0, -path.extname(track.path).length);
    for (const ext of base ? ['.lrc', '.LRC', '.txt'] : []) {
      try {
        const text = decodeText(await fsp.readFile(base + ext));
        if (text.trim()) return { lrc: text, source: '本地 LRC 文件' };
      } catch { /* 没有同名文件 */ }
    }

    if (track.hasEmbeddedLyrics) {
      const text = await this.library.embeddedLyrics(track.path);
      if (text) return { lrc: text, source: '文件内嵌' };
    }

    if (!online) return { none: true };
    // 「未找到」只缓存 3 天，之后再自动试一次；歌词来源变了也重试
    if (cached?.none && cached.v === LYRIC_SOURCES_VERSION && Date.now() - cached.at < 3 * 864e5) return cached;
    try {
      const own = track.online && this.music ? await this.music.lyric(track).catch(() => null) : null;
      const data = own || (await this.autoLyrics(track)) || { none: true, v: LYRIC_SOURCES_VERSION };
      return await this.saveLyrics(track.id, data);
    } catch (e) {
      return { none: true, error: String(e.message || e) };
    }
  }

  // 各来源一起搜，按匹配度从高到低取歌词，取到为止
  async autoLyrics(track) {
    // B 站视频的「歌手」是上传者，不能拿来匹配
    const want = { title: cleanTitle(track.title), artist: track.online?.source === 'bilibili' ? '' : firstArtist(track.artist), duration: track.duration };
    const tasks = this.sources.map((src) => src.search(want).then((list) => list.map((x) => ({ ...x, src }))));
    const lrclib = this.sources.find((s) => s.key === 'lrclib');
    if (track.duration && want.artist) {
      tasks.push(lrclib.exact({ ...want, album: track.album }).then((x) => (x ? [{ ...x, src: lrclib, exact: true }] : [])));
    }
    const results = await Promise.allSettled(tasks);
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    const cands = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      .map((x) => ({ x, m: matchScore(x, want) }))
      .filter(({ m }) => m.accept)
      .sort((a, b) => b.m.score - a.m.score);
    for (const { x } of cands.slice(0, 5)) {
      try {
        const got = await x.src.fetch(x);
        if (got.lrc?.trim() || got.instrumental) return lyricData(x, got);
      } catch { /* 这个来源取不到，试下一个 */ }
    }
    return null;
  }

  // 手动搜索：所有来源的结果合在一起按匹配度排序；国内来源的歌词在选中时再取
  async searchLyrics(query) {
    const want = { title: (query.title || '').trim(), artist: firstArtist(query.artist), duration: query.duration };
    const results = await Promise.allSettled(this.sources.map((src) => src.search(want).then((list) => list.map((x) => ({ ...x, src })))));
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    return all
      .map((x) => ({ x, s: matchScore(x, want).score }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map(({ x }) => {
        const item = { id: x.id, provider: x.src.key, source: x.src.name, title: x.title, artist: x.artist, album: x.album, duration: x.duration, synced: x.synced, instrumental: x.instrumental, lrc: x.lrc };
        return this.simplified() && item.lrc ? this.simplify(item) : item;
      });
  }

  async fetchLyrics(item) {
    const src = this.sources.find((s) => s.key === item.provider);
    if (!src) throw new Error('未知的歌词来源');
    const data = lyricData({ ...item, src }, await src.fetch(item));
    return this.simplified() ? this.simplify(data) : data;
  }

  async saveLyrics(id, data) {
    const old = (await readJson(this.lyricCacheFile(id))) || {};
    const next = { ...old, ...data, at: Date.now() };
    // 换了一份歌词：按行号对应的 AI 翻译已经对不上了
    if ('lrc' in data && data.lrc !== old.lrc && !('aiTrans' in data)) delete next.aiTrans;
    next.none = !next.lrc && !next.instrumental;
    await writeJson(this.lyricCacheFile(id), next);
    return next;
  }

  // ================= 封面 =================
  // quick：批量补全时用，只查限额宽松的 Deezer 和两个 iTunes 地区（iTunes 每分钟约 20 次）
  async searchCovers({ artist = '', album = '', title = '' }, { quick = false } = {}) {
    const term = `${artist} ${album || title}`.trim();
    const tasks = (quick ? ['cn', 'tw'] : ['cn', 'tw', 'hk', 'jp', 'us']).map((country) =>
      this.json(`https://itunes.apple.com/search?${new URLSearchParams({ term, entity: 'album', limit: '8', country })}`).catch(() => null),
    );
    const deezer = this.json(`https://api.deezer.com/search/album?${new URLSearchParams({ q: term, limit: '10' })}`).catch(() => null);
    const results = await Promise.all(tasks);
    const deezerResult = await deezer;
    const out = [];
    const seen = new Set();
    for (const r of results) {
      for (const x of r?.results || []) {
        if (!x.artworkUrl100 || seen.has(x.collectionId)) continue;
        seen.add(x.collectionId);
        out.push({
          source: 'iTunes',
          title: x.collectionName,
          artist: x.artistName,
          year: (x.releaseDate || '').slice(0, 4),
          thumb: x.artworkUrl100.replace('100x100bb', '300x300bb'),
          url: x.artworkUrl100.replace('100x100bb', '1200x1200bb'),
        });
      }
    }
    for (const x of deezerResult?.data || []) {
      if (!x.cover_xl) continue;
      out.push({ source: 'Deezer', title: x.title, artist: x.artist?.name, year: '', thumb: x.cover_medium, url: x.cover_xl });
    }
    // 各地区商店会返回不相关的热门专辑：按字符重合度排序并过滤（简繁体只有部分字不同，仍能得分）
    const scored = out.map((x) => ({ x, s: overlap(term, `${x.title} ${x.artist}`) })).sort((a, b) => b.s - a.s);
    const good = scored.filter((r) => r.s >= 0.34);
    return (good.length ? good : scored.slice(0, 8)).map((r) => r.x);
  }

  // 播放到没有封面的歌：只在匹配度足够高时自动采用第一条结果，同一张专辑只试一次
  async autoCover(track, { quick = false } = {}) {
    if (track.coverId || !track.album) return null;
    const key = albumKeyOf(track);
    this.coverTried ||= new Set();
    if (this.coverTried.has(key)) return null;
    this.coverTried.add(key);
    const list = await this.searchCovers({ artist: track.albumArtist || track.artist, album: track.album }, { quick });
    const best = list[0];
    if (!best || overlap(`${track.albumArtist || track.artist}${track.album}`, `${best.title}${best.artist}`) < 0.6) return null;
    return this.applyCover(track.id, best.url);
  }

  // 批量补全：只处理标签里写了专辑名的（目录名推断出来的合集搜不到），逐张慢慢查
  async fillMissingCovers(onProgress) {
    if (this.filling) return { busy: true };
    this.filling = true;
    const albums = new Map();
    for (const t of this.library.tracks.values()) {
      if (t.coverId || !t.album || t.tagAlbum === false) continue;
      const key = albumKeyOf(t);
      if (!albums.has(key)) albums.set(key, t);
    }
    const list = [...albums.values()];
    let found = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        onProgress({ phase: 'covers', done: i, total: list.length, found });
        try { if (await this.autoCover(list[i], { quick: true })) found++; } catch { /* 网络错误跳过这张 */ }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      this.filling = false;
    }
    onProgress({ phase: 'covers-done', total: list.length, found });
    return { total: list.length, found };
  }

  async applyCover(trackIdValue, url) {
    const buf = await this.buffer(url);
    return this.library.setAlbumCover(trackIdValue, buf);
  }

  // ================= 歌手图片 =================
  artistFile(name) { return path.join(this.artistDir, `${hash(name.toLowerCase())}.jpg`); }

  async artistImage(name, { online = true } = {}) {
    if (!name) return null;
    const file = this.artistFile(name);
    if (fs.existsSync(file)) return file;
    if (!online || this.artistMiss.has(name)) return null;
    try {
      const r = await this.json(`https://api.deezer.com/search/artist?${new URLSearchParams({ q: name, limit: '5' })}`);
      const norm = (s) => s.toLowerCase().replace(/\s+/g, '');
      const hit = (r?.data || []).find((a) => norm(a.name) === norm(name));
      // Deezer 没有图片时返回的默认头像路径里 hash 为空
      if (!hit?.picture_xl || /\/artist\/\/|\/images\/artist\/\//.test(hit.picture_xl)) { this.artistMiss.add(name); return null; }
      await fsp.writeFile(file, await this.buffer(hit.picture_xl));
      return file;
    } catch {
      this.artistMiss.add(name);
      return null;
    }
  }
}
