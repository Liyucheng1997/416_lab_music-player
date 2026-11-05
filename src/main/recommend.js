// 为你推荐：按听歌习惯（播放、喜欢、跳过、听歌时段）和资料库的构成算出口味画像，再从库里挑歌
// 听歌记录少的时候主要看「收藏了什么」，记录越多越看「常听什么」
import { albumKeyOf } from './album-key.js';

const DAY = 86400000;

export const MODES = {
  mix: '猜你喜欢',
  now: '此刻',
  discover: '发掘',
  rewind: '重温',
};

const DIMS = ['artist', 'style', 'lang', 'mood', 'scene', 'decade', 'genre'];
// 各维度在「像不像你的口味」里占的分量
const WEIGHTS = { artist: 0.3, style: 0.2, lang: 0.14, mood: 0.14, scene: 0.06, decade: 0.08, genre: 0.08 };
// 发掘新歌时少看歌手、多看类型，不然翻来覆去还是那几位
const DISCOVER_WEIGHTS = { ...WEIGHTS, artist: 0.1, style: 0.28, mood: 0.2 };

// 一天里的时段：对应适合的场景和情绪（AI 分类的取值）
const SLOTS = [
  { to: 6, key: 'night', label: '深夜', scene: ['睡前'], mood: ['安静', '孤独', '治愈'] },
  { to: 9, key: 'morning', label: '早晨', scene: ['通勤'], mood: ['轻松', '欢快', '励志'] },
  { to: 12, key: 'forenoon', label: '上午', scene: ['学习工作'], mood: ['安静', '轻松'] },
  { to: 14, key: 'noon', label: '午间', scene: ['放松'], mood: ['轻松', '治愈'] },
  { to: 18, key: 'afternoon', label: '下午', scene: ['学习工作'], mood: ['轻松', '安静'] },
  { to: 21, key: 'evening', label: '傍晚', scene: ['通勤', '开车', '放松'], mood: ['怀旧', '轻松', '欢快'] },
  { to: 24, key: 'late', label: '夜晚', scene: ['睡前', '放松', '思念'], mood: ['深情', '治愈', '安静'] },
];

export function slotOf(date = new Date()) {
  const s = SLOTS.find((x) => date.getHours() < x.to);
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  // 周末白天换成出游、聚会
  if (weekend && date.getHours() >= 9 && date.getHours() < 21) {
    return { ...s, label: `周末${s.label}`, scene: ['旅行', '聚会', '放松'], mood: ['欢快', '轻松', ...s.mood.slice(0, 1)] };
  }
  return s;
}

export const splitArtists = (s) => (s || '').split(/\s*(?:\/|;|、|&|，|,|\bfeat\.?\s|\bft\.\s)\s*/i).map((x) => x.trim()).filter(Boolean);

export function features(t, tg) {
  return {
    artist: splitArtists(t.artist),
    style: tg?.style ? [tg.style] : [],
    lang: tg?.lang ? [tg.lang] : [],
    mood: tg?.mood || [],
    scene: tg?.scene || [],
    decade: t.year ? [`${Math.floor(t.year / 10) * 10}s`] : [],
    genre: t.genre ? t.genre.split(/\s*[/;,]\s*/).map((g) => g.toLowerCase()).filter(Boolean) : [],
  };
}

// 一首歌反映出多少「喜欢」：播放次数取对数（一首歌循环一百遍不该压倒一切），越久没听越淡；喜欢、评分加分，跳过扣分
export function engagement(t, now = Date.now()) {
  const plays = t.playCount || 0;
  const skips = t.skipCount || 0;
  if (!plays && !skips && !t.loved && !t.rating) return 0;
  const days = t.lastPlayed ? (now - t.lastPlayed) / DAY : 365;
  const recency = 0.5 + 0.5 * 0.5 ** (days / 120);
  return 2 * Math.log2(1 + plays) * recency + (t.loved ? 4 : 0) + (t.rating || 0) * 0.6 - skips * 0.8;
}

const emptyDims = () => Object.fromEntries(DIMS.map((d) => [d, new Map()]));
const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
const maxOf = (m) => Math.max(0, ...m.values());

// 口味画像：collection 是资料库构成（收藏了什么），listen 是听歌记录；两者按记录多少混合，每个维度归一到 0~1
export function buildProfile({ tracks, tags = {}, history = [], now = Date.now() }) {
  const coll = emptyDims();
  const listen = emptyDims();
  const feats = new Map();
  let engaged = 0;
  let plays = 0;
  let loved = 0;
  let skips = 0;
  const heard = { artist: new Map(), style: new Map() };
  for (const t of tracks) {
    const f = features(t, tags[t.id]);
    feats.set(t.id, f);
    const e = engagement(t, now);
    plays += t.playCount || 0;
    skips += t.skipCount || 0;
    if (t.loved) loved++;
    if (t.playCount) {
      for (const a of f.artist) add(heard.artist, a, t.playCount);
      for (const st of f.style) add(heard.style, st, t.playCount);
    }
    if (e > 0) engaged += e;
    for (const d of DIMS) {
      const vals = f[d];
      for (const v of vals) {
        add(coll[d], v, 1 / vals.length);
        if (e) add(listen[d], v, e / vals.length);
      }
    }
  }
  // 收藏得多的歌手 / 类型开根号，免得一位歌手收了几百首就霸占推荐
  for (const d of DIMS) for (const [k, v] of coll[d]) coll[d].set(k, Math.sqrt(v));
  const alpha = Math.min(0.9, engaged / (engaged + 30));
  const dims = {};
  for (const d of DIMS) {
    const cm = maxOf(coll[d]) || 1;
    const lm = maxOf(listen[d]) || 1;
    const out = new Map();
    for (const [k, v] of coll[d]) out.set(k, (1 - alpha) * (v / cm));
    for (const [k, v] of listen[d]) if (v > 0) add(out, k, alpha * (v / lm));
    dims[d] = out;
  }
  // 按时段的习惯：只在记录够多时才用
  const byId = new Map(tracks.map((t) => [t.id, t]));
  return { dims, listen, coll, heard, feats, byId, alpha, plays, loved, skips, engaged, history, collCount: countArtists(tracks) };
}

function countArtists(tracks) {
  const m = new Map();
  for (const t of tracks) for (const a of splitArtists(t.artist)) add(m, a, 1);
  return m;
}

// 和画像有多像：歌手取最像的一位，情绪 / 场景这类多值的取平均；没有的维度不计
export function similarity(dims, f, weights = WEIGHTS) {
  let s = 0;
  let w = 0;
  for (const d of DIMS) {
    const vals = f[d];
    if (!vals?.length || !weights[d]) continue;
    const m = dims[d];
    const v = d === 'artist' ? Math.max(...vals.map((x) => m.get(x) || 0)) : vals.reduce((a, x) => a + (m.get(x) || 0), 0) / vals.length;
    s += weights[d] * v;
    w += weights[d];
  }
  return w ? s / w : 0;
}

// 某个时段内（前后 2 小时）实际听过什么
function hourProfile(profile, date) {
  const h = date.getHours();
  const near = profile.history.filter(([, ts]) => {
    const d = Math.abs(new Date(ts).getHours() - h);
    return Math.min(d, 24 - d) <= 2;
  });
  if (near.length < 20) return null;
  const dims = emptyDims();
  for (const [id] of near) {
    const f = profile.feats.get(id);
    if (!f) continue;
    for (const d of DIMS) for (const v of f[d]) add(dims[d], v, 1 / f[d].length);
  }
  for (const d of DIMS) {
    const m = maxOf(dims[d]) || 1;
    for (const [k, v] of dims[d]) dims[d].set(k, v / m);
  }
  return { dims, count: near.length };
}

function slotFit(f, slot) {
  if (!f.scene.length && !f.mood.length) return { fit: 0.35, hit: '' };
  const scene = f.scene.filter((x) => slot.scene.includes(x));
  const mood = f.mood.filter((x) => slot.mood.includes(x));
  return { fit: Math.min(1, (scene.length + 0.6 * mood.length) / 1.2), hit: scene[0] || mood[0] || '' };
}

// 刚听过的先放一放
function freshness(t, now) {
  if (!t.lastPlayed) return 1;
  const d = (now - t.lastPlayed) / DAY;
  return d < 1 ? 0.05 : d < 3 ? 0.3 : d < 14 ? 0.65 : 1;
}
const skipFactor = (t) => ((t.playCount || 0) + 1) / ((t.playCount || 0) + 1 + (t.skipCount || 0) * 0.8);

function ago(ts, now) {
  const d = Math.floor((now - ts) / DAY);
  if (d < 30) return `${d} 天前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}

// 推荐理由：挑最能说明问题的一条
function reason(t, f, profile, ctx) {
  const { mode, now, slot } = ctx;
  if (mode === 'rewind') return `听过 ${t.playCount || 0} 次${t.loved ? '、你喜欢的歌' : ''}，上次是${t.lastPlayed ? ago(t.lastPlayed, now) : '很久以前'}`;
  if (mode === 'now' && ctx.fit?.hit) return `适合${slot.label} · ${ctx.fit.hit}`;
  if (t.loved) return '你喜欢的歌';
  const typ = [f.style[0], f.mood[0]].filter(Boolean).join(' · ');
  const artist = f.artist.filter((a) => (profile.listen.artist.get(a) || 0) > 0).sort((a, b) => (profile.heard.artist.get(b) || 0) - (profile.heard.artist.get(a) || 0))[0];
  if (artist) {
    const n = profile.heard.artist.get(artist) || 0;
    return `你${n >= 5 ? '常听' : '听过'}${artist}${n ? `（${n} 次）` : ''}`;
  }
  const style = f.style.find((x) => (profile.listen.style.get(x) || 0) > 0);
  if (style) return `${typ}，${(profile.heard.style.get(style) || 0) >= 10 ? '你常听的类型' : '合你口味'}`;
  const many = f.artist.find((a) => (profile.collCount.get(a) || 0) >= 8);
  if (many) return `你收藏了 ${profile.collCount.get(many)} 首${many}`;
  return typ || (f.genre[0] ? `流派：${f.genre[0]}` : '随便听听');
}

// 加权随机抽样（Efraimidis–Spirakis）：分越高越容易被抽中，又不至于每次都一样；sharp 越大越偏向高分
function sample(scored, { limit, perArtist, perAlbum, sharp, rand }) {
  const keyed = scored.filter((x) => x.score > 0).map((x) => ({ ...x, key: Math.log(rand()) / x.score ** sharp }));
  keyed.sort((a, b) => b.key - a.key);
  const artists = new Map();
  const albums = new Map();
  const out = [];
  for (const x of keyed) {
    if (out.length >= limit) break;
    const a = x.f.artist[0] || '';
    const al = x.album;
    if (a && (artists.get(a) || 0) >= perArtist) continue;
    if (al && (albums.get(al) || 0) >= perAlbum) continue;
    if (a) add(artists, a, 1);
    if (al) add(albums, al, 1);
    out.push(x);
  }
  return out;
}

export function rng(seed = Date.now()) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
}

// 主入口：mode = mix | now | discover | rewind；exclude 是「换一批」时上一批的歌
export function recommend({ tracks, tags = {}, history = [], mode = 'mix', limit = 40, exclude = [], seed, now = Date.now(), date = new Date(now), profile }) {
  profile ||= buildProfile({ tracks, tags, history, now });
  const rand = rng(seed ?? now);
  const skip = new Set(exclude);
  const slot = slotOf(date);
  const hour = mode === 'now' ? hourProfile(profile, date) : null;
  const sharp = 3 + 3 * profile.alpha;
  const scored = [];
  for (const t of tracks) {
    if (skip.has(t.id)) continue;
    const f = profile.feats.get(t.id) || features(t, tags[t.id]);
    let score;
    let fit = null;
    if (mode === 'discover') {
      if (t.playCount || t.skipCount) continue;
      const newArtist = !f.artist.some((a) => (profile.listen.artist.get(a) || 0) > 0);
      score = similarity(profile.dims, f, DISCOVER_WEIGHTS) * (newArtist ? 1.15 : 1);
    } else if (mode === 'rewind') {
      const e = engagement(t, now);
      const days = t.lastPlayed ? (now - t.lastPlayed) / DAY : 365;
      if (e <= 0 || days < 21) continue;
      score = Math.min(1, e / 8) * Math.min(1.5, 0.5 + days / 90);
    } else {
      const base = similarity(profile.dims, f);
      if (mode === 'now') {
        fit = slotFit(f, slot);
        score = hour
          ? base * 0.35 + fit.fit * 0.3 + similarity(hour.dims, f) * 0.35
          : base * 0.45 + fit.fit * 0.55;
      } else {
        score = base * (t.loved ? 1.2 : 1);
      }
      score *= freshness(t, now) * skipFactor(t);
    }
    scored.push({ t, f, score, fit, album: t.album ? albumKeyOf(t) : '' });
  }
  const caps = mode === 'rewind' ? { perArtist: 4, perAlbum: 3 } : mode === 'discover' ? { perArtist: 2, perAlbum: 1 } : { perArtist: 2, perAlbum: 2 };
  const picked = sample(scored, { limit, sharp, rand, ...caps });
  return {
    mode,
    slot: { key: slot.key, label: slot.label },
    habit: hour ? hour.count : 0,
    items: picked.map((x) => ({ id: x.t.id, score: Math.round(x.score * 1000) / 1000, reason: reason(x.t, x.f, profile, { mode, now, slot, fit: x.fit }) })),
    profile: summarize(profile),
  };
}

// 给界面和 AI 看的画像摘要
export function summarize(profile, n = { artist: 6, style: 4, lang: 3, mood: 4, scene: 3, decade: 3 }) {
  const top = {};
  for (const [d, k] of Object.entries(n)) {
    top[d] = [...profile.dims[d].entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name]) => name);
  }
  const basis = profile.alpha < 0.35 ? 'collection' : profile.alpha < 0.7 ? 'mixed' : 'listening';
  return { top, basis, alpha: Math.round(profile.alpha * 100) / 100, plays: profile.plays, loved: profile.loved, skips: profile.skips, history: profile.history.length };
}

// 交给 AI 挑选的候选池：猜你喜欢 + 发掘 + 重温，去重
export function candidatePool(args, sizes = { mix: 120, discover: 60, rewind: 20 }) {
  const profile = buildProfile(args);
  const seen = new Set();
  const pool = [];
  for (const [mode, limit] of Object.entries(sizes)) {
    const r = recommend({ ...args, profile, mode, limit, exclude: [...seen] });
    for (const it of r.items) if (!seen.has(it.id)) { seen.add(it.id); pool.push({ ...it, from: mode }); }
  }
  return { pool, profile: summarize(profile), slot: slotOf(args.date || new Date(args.now || Date.now())) };
}
