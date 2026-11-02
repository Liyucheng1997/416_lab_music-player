// 资料库：扫描磁盘音乐文件、读取标签、提取封面、维护歌单与播放统计
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { JsonStore } from './store.js';
import { parseCue, isImage } from './cue.js';
import { decodeText } from './online.js';
import { albumKeyOf } from './album-key.js';

const LIB_VERSION = 10;

export const AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.mp4', '.aac', '.webm',
  '.ape', '.wma', '.wv', '.tta', '.tak', '.dsf', '.dff', '.aiff', '.aif', '.mka', '.mpc',
]);
// Chromium 能直接解码的格式，其余交给 ffmpeg 转码
const NATIVE_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.mp4', '.aac', '.webm']);
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);
const COVER_WORDS = /cover|folder|front|albumart|封面|正面/i;
const NOT_COVER = /back|disc|cd\d|inlay|inside|booklet|tray|背面|内页|谱/i;
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

export const trackId = (file) => crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 16);
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
const uid = () => crypto.randomBytes(6).toString('hex');

function isUnder(file, folder) {
  const rel = path.relative(folder.toLowerCase(), file.toLowerCase());
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 资源站在标签里留下的水印：「张国荣【熊猫无损音乐www.xmwav.com】更多打包资源下载」→「张国荣」
const AD = /(www\.|\.com|\.cn|\.net|下载|资源|打包|无损音乐|熊猫|网盘|公众号|微信|^.?(hi-?res|无损|wav|flac|ape|dsd|mqa|sacd|母带|24bit|320k)\b.?$)/i;
export function cleanTag(s = '') {
  return String(s)
    .replace(/[【\[(（「][^】\])）」]*[】\])）」]/g, (seg) => (AD.test(seg) ? '' : seg))
    .replace(/(更多)?(高品质)?(打包)?(资源)?下载.*$/, '')
    .replace(/\s*(https?:\/\/)?www\.[\w.-]+\.(com|cn|net)\S*/gi, '')
    // 拼在歌手后面的「&熊猫无损音乐」，要在去掉网址之后才露出来
    .replace(/\s*[&/、,，]?\s*(熊猫)?无损音乐(网)?(?=$|\s*[&/、,，])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 抓轨软件留下的占位标签，当作没有
const placeholder = (s) => (/^(unknown( artist| album| title)?|untitled|track\s*\d*|未知(歌手|艺术家|专辑)?|(熊猫)?无损音乐(网)?|[\w.-]+\.(com|cn|net))$/i.test(s.trim()) ? '' : s);

// 目录名当专辑名用时，去掉格式、大小、序号之类的修饰：「陈奕迅 DUO（WAV）」→「陈奕迅 DUO」
export function cleanFolderName(s = '') {
  return cleanTag(s)
    .replace(/[【\[(（][^】\])）]*(wav|flac|ape|mp3|dsd|dff|hi-?res|无损|\d+(\.\d+)?\s*g|首)[^】\])）]*[】\])）]/gi, '')
    .replace(/[(（]\d+[)）]$/, '')
    .replace(/(打包下载|打包|下载|稀有资源|全网).*$/, '')
    .replace(/\s+/g, ' ')
    .trim() || s;
}

// 没有标签时从文件名推断：「1-03 歌手 - 歌名」「03. 歌名」
export function guessFromFilename(file) {
  let base = path.basename(file, path.extname(file)).trim();
  let trackNo = null;
  let discNo = null;
  const num = base.match(/^(?:(\d{1,2})[-.])?(\d{1,3})(?:[\s._-]+|(?=[^\d\s]))(.+)$/);
  if (num && !/^\d/.test(num[3])) {
    if (num[1]) discNo = Number(num[1]);
    trackNo = Number(num[2]);
    base = num[3].replace(/^[\s._-]+/, '').trim();
  }
  base = cleanTag(base) || base;
  let parts = base.split(/\s+-\s*|\s*-\s+/);
  // 「刀郎-冲动的惩罚」：不带空格的连字符只在中文歌手名后才当分隔符
  if (parts.length < 2 && /^[一-鿿·]{2,10}-/.test(base)) parts = [base.slice(0, base.indexOf('-')), base.slice(base.indexOf('-') + 1)];
  if (parts.length >= 2 && parts[0].length <= 30) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), trackNo, discNo };
  return { artist: '', title: base, trackNo, discNo };
}

function lyricsFromTags(common) {
  const list = common.lyrics || [];
  for (const l of list) {
    if (l?.syncText?.length) {
      return l.syncText.map((s) => {
        const t = (s.timestamp ?? 0) / 1000;
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = (t % 60).toFixed(2).padStart(5, '0');
        return `[${mm}:${ss}]${s.text}`;
      }).join('\n');
    }
    if (typeof l === 'string' && l.trim()) return l;
    if (l?.text?.trim()) return l.text;
  }
  return '';
}

export class Library {
  constructor({ dir, thumb, onProgress, onChange }) {
    this.dir = dir;
    this.coverDir = path.join(dir, 'covers');
    this.thumb = thumb; // (buffer) => 缩略图 jpeg buffer
    this.onProgress = onProgress || (() => {});
    this.onChange = onChange || (() => {});
    this.store = new JsonStore(path.join(dir, 'library.json'), { folders: [], tracks: [], playlists: [] });
    this.tracks = new Map(this.store.data.tracks.map((t) => [t.id, t]));
    // 索引格式升级后，下次扫描把所有文件重新读一遍（播放统计会保留）
    if (this.store.data.version !== LIB_VERSION) {
      for (const t of this.tracks.values()) t.mtime = 0;
      this.store.data.version = LIB_VERSION;
    }
    this.dirCoverCache = new Map();
    this.scanning = false;
    this.pending = new Set();
    this.watchers = new Map();
    fs.mkdirSync(this.coverDir, { recursive: true });
  }

  get folders() { return this.store.data.folders; }
  get playlists() { return this.store.data.playlists; }

  snapshot() {
    return { folders: this.folders, tracks: [...this.tracks.values()], playlists: this.playlists, scanning: this.scanning };
  }

  persist() {
    this.store.data.tracks = [...this.tracks.values()];
    this.store.save();
  }

  // ---------- 文件夹 ----------
  async addFolder(folder) {
    folder = path.resolve(folder);
    if (!this.folders.some((f) => f.toLowerCase() === folder.toLowerCase())) {
      this.folders.push(folder);
      this.store.save();
      this.watch(folder);
    }
    return this.scan([folder]);
  }

  removeFolder(folder) {
    this.store.data.folders = this.folders.filter((f) => f.toLowerCase() !== folder.toLowerCase());
    for (const [id, t] of this.tracks) if (isUnder(t.path, folder)) this.tracks.delete(id);
    this.watchers.get(folder)?.close();
    this.watchers.delete(folder);
    this.persist();
    this.onChange();
  }

  watchAll() {
    for (const f of this.folders) this.watch(f);
  }

  // Windows 支持递归监听：有新增/删除的音乐文件时自动增量扫描
  watch(folder) {
    if (this.watchers.has(folder)) return;
    try {
      let timer = null;
      const w = fs.watch(folder, { recursive: true }, (_e, name) => {
        if (!name || !AUDIO_EXTS.has(path.extname(name).toLowerCase())) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.scan([folder]), 4000);
      });
      w.on('error', () => this.watchers.delete(folder));
      this.watchers.set(folder, w);
    } catch {
      // 盘符未挂载时忽略，下次启动再试
    }
  }

  // ---------- 扫描 ----------
  // 点开头的是隐藏文件，比如 macOS 拷贝时留下的 ._xxx.wav 元数据，一律跳过
  async walk(root, out, cues) {
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(root, e.name);
      const ext = path.extname(e.name).toLowerCase();
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) await this.walk(full, out, cues);
      } else if (AUDIO_EXTS.has(ext)) {
        out.push(full);
      } else if (ext === '.cue') {
        cues.push(full);
      }
    }
  }

  // 找出 CUE 描述的整轨文件：CUE 里写的文件名常和实际不符（.wav 实为 .ape，或文件被改名）
  async cueImages(files, cues) {
    const byLower = new Map(files.map((f) => [f.toLowerCase(), f]));
    const byDir = new Map();
    for (const f of files) {
      const d = path.dirname(f).toLowerCase();
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(f);
    }
    const images = new Map();
    for (const cuePath of cues) {
      let sheet;
      let cueSt;
      try {
        sheet = parseCue(decodeText(await fsp.readFile(cuePath)));
        cueSt = await fsp.stat(cuePath);
      } catch { continue; }
      const dir = path.dirname(cuePath);
      const sheetFiles = sheet.files.filter(isImage);
      for (const f of sheetFiles) {
        const stem = (n) => path.basename(n, path.extname(n)).toLowerCase();
        const siblings = byDir.get(dir.toLowerCase()) || [];
        const audio = byLower.get(path.join(dir, f.name).toLowerCase())
          || siblings.find((x) => stem(x) === stem(f.name))
          || (sheetFiles.length === 1 ? siblings.find((x) => stem(x) === stem(cuePath)) : null)
          || (sheetFiles.length === 1 && siblings.length === 1 ? siblings[0] : null);
        if (audio && !images.has(audio.toLowerCase())) images.set(audio.toLowerCase(), { cuePath, cueMtime: cueSt.mtimeMs, sheet, file: f });
      }
    }
    return images;
  }

  async scan(folders = this.folders) {
    if (this.scanning) { folders.forEach((f) => this.pending.add(f)); return { queued: true }; }
    this.scanning = true;
    const stats = { added: 0, updated: 0, removed: 0, total: 0, failed: 0 };
    try {
      for (const folder of folders) {
        this.onProgress({ phase: 'walk', folder, done: 0, total: 0 });
        if (!fs.existsSync(folder)) continue; // 外接盘未连接时保留旧索引
        const files = [];
        const cues = [];
        await this.walk(folder, files, cues);
        const images = await this.cueImages(files, cues);
        const seen = new Set();
        const todo = [];
        for (const file of files) {
          let st;
          try { st = await fsp.stat(file); } catch { continue; }
          const image = images.get(file.toLowerCase());
          if (image) {
            const ids = image.file.tracks.map((t) => trackId(`${file}#${t.no}`));
            ids.forEach((id) => seen.add(id));
            const old = this.tracks.get(ids[0]);
            if (old && old.mtime === st.mtimeMs && old.size === st.size && old.cueMtime === image.cueMtime && ids.every((id) => this.tracks.has(id))) continue;
            todo.push({ file, st, image, ids });
            continue;
          }
          const id = trackId(file);
          seen.add(id);
          const old = this.tracks.get(id);
          if (old && old.mtime === st.mtimeMs && old.size === st.size) continue;
          todo.push({ file, id, st, old });
        }
        for (const [id, t] of this.tracks) {
          if (isUnder(t.path, folder) && !seen.has(id)) { this.tracks.delete(id); stats.removed++; }
        }
        stats.total += seen.size;
        let done = 0;
        const worker = async () => {
          while (todo.length) {
            const job = todo.shift();
            try {
              if (job.image) {
                for (const track of await this.readCueTracks(job)) {
                  this.tracks.has(track.id) ? stats.updated++ : stats.added++;
                  this.tracks.set(track.id, track);
                }
              } else {
                const track = await this.readTrack(job.file, job.st, job.old);
                this.tracks.set(job.id, track);
                job.old ? stats.updated++ : stats.added++;
              }
            } catch {
              stats.failed++;
            }
            done++;
            if (done % 10 === 0 || !todo.length) this.onProgress({ phase: 'read', folder, done, total: done + todo.length });
            if (done % 300 === 0) this.persist();
          }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
      }
      this.inferMissing();
    } finally {
      this.scanning = false;
      this.persist();
      this.onProgress({ phase: 'done', ...stats });
      this.onChange();
    }
    if (this.pending.size) {
      const next = [...this.pending];
      this.pending.clear();
      this.scan(next);
    }
    return stats;
  }

  // 没有歌手 / 专辑标签的歌：歌手从上级目录名里找资料库已有的歌手，专辑用所在目录名
  inferMissing() {
    const known = new Set();
    for (const t of this.tracks.values()) {
      if (t.tagArtist !== false) for (const a of t.artist.split(/\s*[/;&、,，]\s*/)) if (a.length >= 2) known.add(a.toLowerCase());
    }
    const roots = this.folders.map((f) => f.toLowerCase());
    for (const t of this.tracks.values()) {
      if (t.cueStart != null) continue;
      const dirs = [];
      for (let d = path.dirname(t.path); ; d = path.dirname(d)) {
        if (roots.includes(d.toLowerCase()) || path.dirname(d) === d) break;
        dirs.push(path.basename(d));
      }
      // 「丁菲飞《乐源》」「闵惠芬-《霓裳曲》」：书名号前是演奏者，书名号里是专辑
      const quoted = dirs[0] && cleanTag(dirs[0]).match(/^([^《》]{2,20}?)\s*[-–—_]?\s*《([^》]+)》/);
      if (t.tagArtist === false && !guessFromFilename(t.path).artist) {
        let found = quoted ? quoted[1].trim() : '';
        for (const name of found ? [] : dirs.map(cleanTag)) {
          const lower = name.toLowerCase();
          if (known.has(lower)) { found = name; break; }
          // 「陈奕迅 DUO」「【林俊杰】精选」这类以歌手名开头的目录
          const head = lower.replace(/^[【\[]/, '').split(/[\s】\]·_\-—–(（]/)[0];
          if (head.length >= 2 && known.has(head)) { found = name.replace(/^[【\[]/, '').slice(0, head.length); break; }
        }
        t.artist = found;
        if (!t.albumArtist || t.albumArtist === '') t.albumArtist = found;
      }
      if (t.tagAlbum === false && dirs.length) {
        t.album = quoted ? quoted[2].trim() : cleanFolderName(dirs[0]);
        t.albumArtist ||= t.artist;
      }
    }
  }

  // 整轨文件只读一次标签和封面，再按 CUE 生成每一首（cueStart / cueEnd 是在整轨里的秒数）
  async readCueTracks({ file, st, image, ids }) {
    const base = await this.readTrack(file, st, null);
    const { sheet, file: cueFile, cuePath, cueMtime } = image;
    return cueFile.tracks.map((t, i) => {
      const id = ids[i];
      const old = this.tracks.get(id);
      const end = t.end ?? base.duration;
      return {
        ...base,
        id,
        title: t.title || `音轨 ${t.no}`,
        artist: t.performer || sheet.performer || base.artist,
        albumArtist: sheet.performer || base.albumArtist,
        tagAlbumArtist: !!sheet.performer || base.tagAlbumArtist,
        album: sheet.title || base.album || path.basename(file, path.extname(file)),
        genre: sheet.genre || base.genre,
        year: sheet.date || base.year,
        composer: t.composer || base.composer,
        trackNo: t.no,
        duration: Math.max(0, (end || 0) - t.start),
        cueStart: t.start,
        cueEnd: t.end,
        cuePath,
        cueMtime,
        hasEmbeddedLyrics: false,
        coverId: old?.coverLocked ? old.coverId : base.coverId,
        coverLocked: old?.coverLocked || false,
        addedAt: old?.addedAt || Date.now(),
        playCount: old?.playCount || 0,
        skipCount: old?.skipCount || 0,
        lastPlayed: old?.lastPlayed || 0,
        loved: old?.loved || false,
        rating: old?.rating || 0,
      };
    });
  }

  async readTrack(file, st, old) {
    const ext = path.extname(file).toLowerCase();
    const guess = guessFromFilename(file);
    let meta = null;
    try {
      meta = await parseFile(file, { duration: false, skipCovers: false });
    } catch {
      meta = null;
    }
    const c = meta?.common || {};
    const f = meta?.format || {};
    const codec = f.codec || '';
    let coverId = null;
    if (c.picture?.length) coverId = await this.saveCover(c.picture[0].data);
    if (!coverId) coverId = await this.folderCover(path.dirname(file));
    const tagArtist = placeholder(cleanTag(c.artist || (c.artists || []).join(' / ')));
    const artist = tagArtist || guess.artist || '';
    const album = cleanTag(c.album);
    return {
      id: trackId(file),
      fileId: trackId(file), // 同一个物理文件的标识，CUE 拆出的各首共用
      path: file,
      ext: ext.slice(1),
      // 标签和文件名都只是「Unknown Artist」之类的占位时，用音轨号命名
      title: placeholder(cleanTag(c.title)) || placeholder(guess.title) || `音轨 ${String(c.track?.no ?? guess.trackNo ?? '').padStart(2, '0')}`.trim(),
      artist,
      albumArtist: cleanTag(c.albumartist) || artist,
      tagAlbumArtist: !!cleanTag(c.albumartist),
      album,
      // 记录哪些字段来自标签，没有的在扫描结束后按目录推断（见 inferMissing）
      tagArtist: !!tagArtist,
      tagAlbum: !!album,
      genre: (c.genre || []).join(' / '),
      year: c.year || (c.date ? Number(String(c.date).slice(0, 4)) || null : null),
      trackNo: c.track?.no ?? guess.trackNo ?? null,
      discNo: c.disk?.no ?? guess.discNo ?? null,
      composer: (c.composer || []).join(' / '),
      duration: f.duration || 0,
      bitrate: f.bitrate ? Math.round(f.bitrate / 1000) : null,
      sampleRate: f.sampleRate || null,
      bitsPerSample: f.bitsPerSample || null,
      codec,
      lossless: !!f.lossless,
      needsTranscode: !NATIVE_EXTS.has(ext) || /alac/i.test(codec),
      hasEmbeddedLyrics: !!lyricsFromTags(c),
      coverId: old?.coverLocked ? old.coverId : coverId,
      coverLocked: old?.coverLocked || false,
      size: st.size,
      mtime: st.mtimeMs,
      addedAt: old?.addedAt || Date.now(),
      playCount: old?.playCount || 0,
      skipCount: old?.skipCount || 0,
      lastPlayed: old?.lastPlayed || 0,
      loved: old?.loved || false,
      rating: old?.rating || 0,
    };
  }

  async embeddedLyrics(file) {
    try {
      const meta = await parseFile(file, { duration: false, skipCovers: true });
      return lyricsFromTags(meta.common);
    } catch {
      return '';
    }
  }

  // 精确时长（标签里没有时长的 VBR 文件），播放时由渲染进程回填
  setDuration(id, duration) {
    const t = this.tracks.get(id);
    if (t && t.cueStart == null && duration && Math.abs((t.duration || 0) - duration) > 1) { t.duration = duration; this.persist(); }
  }

  // ---------- 封面 ----------
  coverPath(coverId, small = false) {
    return path.join(this.coverDir, `${coverId}${small ? '_s' : ''}.jpg`);
  }

  async saveCover(buf) {
    buf = Buffer.from(buf);
    const id = sha1(buf);
    const full = this.coverPath(id);
    if (!fs.existsSync(full)) {
      try {
        const big = this.thumb(buf, 1000);
        const small = this.thumb(buf, 320);
        if (!big || !small) return null;
        await fsp.writeFile(full, big);
        await fsp.writeFile(this.coverPath(id, true), small);
      } catch {
        return null;
      }
    }
    return id;
  }

  async folderCover(dir) {
    if (this.dirCoverCache.has(dir)) return this.dirCoverCache.get(dir);
    const task = (async () => {
      let names;
      try { names = await fsp.readdir(dir); } catch { return null; }
      const images = names.filter((n) => !n.startsWith('.') && IMAGE_EXTS.includes(path.extname(n).toLowerCase()));
      const stem = (n) => path.basename(n, path.extname(n));
      // 名字像封面的优先；只有一张图且不像曲谱、背面时也用它；多张图又没有明显封面时宁可不选
      const pick = images.find((n) => COVER_WORDS.test(stem(n)) && !/back|背面/i.test(stem(n)))
        || (images.length === 1 && !NOT_COVER.test(stem(images[0])) ? images[0] : null);
      if (pick) {
        try {
          const id = await this.saveCover(await fsp.readFile(path.join(dir, pick)));
          if (id) return id;
        } catch { /* 图片读不了 */ }
      }
      // 多碟专辑（CD1 / Disc 2 …）的封面通常放在上一级目录
      if (/^(cd|disc|disk|碟)\s*[\d.]+$|[(（\[.\s]cd[.\s]?\d+[)）\]]?$/i.test(path.basename(dir))) return this.folderCover(path.dirname(dir));
      return null;
    })();
    this.dirCoverCache.set(dir, task);
    return task;
  }

  // 给整张专辑设置封面（在线检索结果），不改动音乐文件
  async setAlbumCover(trackIdValue, buf) {
    const t = this.tracks.get(trackIdValue);
    if (!t) return null;
    const coverId = await this.saveCover(buf);
    if (!coverId) return null;
    const key = albumKeyOf(t);
    const sameAlbum = (x) => (t.album ? albumKeyOf(x) === key : x.id === t.id);
    for (const x of this.tracks.values()) if (sameAlbum(x)) { x.coverId = coverId; x.coverLocked = true; }
    this.persist();
    this.onChange();
    return coverId;
  }

  // ---------- 统计 / 喜欢 ----------
  update(id, patch) {
    const t = this.tracks.get(id);
    if (!t) return null;
    const allowed = ['loved', 'rating', 'playCount', 'lastPlayed', 'skipCount'];
    for (const k of allowed) if (k in patch) t[k] = patch[k];
    this.persist();
    return t;
  }

  markPlayed(id) {
    const t = this.tracks.get(id);
    if (!t) return null;
    t.playCount = (t.playCount || 0) + 1;
    t.lastPlayed = Date.now();
    this.persist();
    return t;
  }

  // ---------- 歌单 ----------
  createPlaylist(name, trackIds = []) {
    const pl = { id: uid(), name: name || '新建歌单', trackIds: [...trackIds], createdAt: Date.now() };
    this.playlists.push(pl);
    this.store.save();
    return pl;
  }

  updatePlaylist(id, patch) {
    const pl = this.playlists.find((p) => p.id === id);
    if (!pl) return null;
    if (patch.name != null) pl.name = patch.name;
    if (patch.trackIds) pl.trackIds = patch.trackIds;
    if (patch.add) for (const t of patch.add) if (!pl.trackIds.includes(t)) pl.trackIds.push(t);
    if (patch.remove) pl.trackIds = pl.trackIds.filter((t) => !patch.remove.includes(t));
    this.store.save();
    return pl;
  }

  deletePlaylist(id) {
    this.store.data.playlists = this.playlists.filter((p) => p.id !== id);
    this.store.save();
  }

  // M3U / M3U8 导入：相对路径以歌单文件所在目录为基准
  async importM3U(file) {
    const text = await fsp.readFile(file, 'utf8');
    const base = path.dirname(file);
    const ids = [];
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const full = path.isAbsolute(line) ? line : path.join(base, line);
      const id = trackId(full);
      if (this.tracks.has(id)) ids.push(id);
    }
    return this.createPlaylist(path.basename(file, path.extname(file)), ids);
  }

  async exportM3U(playlistId, file) {
    const pl = this.playlists.find((p) => p.id === playlistId);
    if (!pl) return false;
    const lines = ['#EXTM3U'];
    for (const id of pl.trackIds) {
      const t = this.tracks.get(id);
      if (!t) continue;
      lines.push(`#EXTINF:${Math.round(t.duration || 0)},${t.artist} - ${t.title}`, t.path);
    }
    await fsp.writeFile(file, '﻿' + lines.join('\r\n'), 'utf8');
    return true;
  }

  async flush() {
    this.store.data.tracks = [...this.tracks.values()];
    await this.store.flush();
  }
}
