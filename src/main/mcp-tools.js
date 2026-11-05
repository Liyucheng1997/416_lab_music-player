// MCP 工具：查资料库在主进程完成，播放控制转给界面（播放器跑在渲染进程里）
import { DIMENSIONS } from './classify.js';

const fmt = (t) => (Number.isFinite(t) && t > 0 ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '');
const DIM_KEYS = Object.keys(DIMENSIONS);

// 与界面一样的过滤条件，search / play / add_to_queue 共用
const FILTERS = {
  query: { type: 'string', description: '关键词，空格分隔多个词都要命中；会匹配歌名、歌手、专辑、流派、文件路径和 AI 分类' },
  artist: { type: 'string', description: '歌手名（包含即可）' },
  album: { type: 'string', description: '专辑名（包含即可）' },
  genre: { type: 'string', description: '文件标签里的流派（包含即可）' },
  ...Object.fromEntries(DIM_KEYS.map((k) => [k, { type: 'string', enum: DIMENSIONS[k].values, description: `AI 分类 · ${DIMENSIONS[k].label}` }])),
  loved: { type: 'boolean', description: '只要「我喜欢」里的歌' },
};

const LRC_TIME = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g;

export function createTools({ library, classifier, online, callRenderer, onlineLyrics, recommendList }) {
  const tags = (id) => classifier.tags[id] || null;
  const card = (t) => t && {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    year: t.year || undefined,
    duration: fmt(t.duration),
    genre: t.genre || undefined,
    ai: tags(t.id) ? { style: tags(t.id).style, lang: tags(t.id).lang, mood: tags(t.id).mood, scene: tags(t.id).scene } : undefined,
    loved: t.loved || undefined,
    plays: t.playCount || undefined,
  };

  function filter(args) {
    const words = (args.query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const has = (v, q) => !q || (v || '').toLowerCase().includes(q.toLowerCase());
    const out = [];
    for (const t of library.tracks.values()) {
      const tg = tags(t.id);
      if (!has(t.artist, args.artist) || !has(t.album, args.album) || !has(t.genre, args.genre)) continue;
      if (args.loved && !t.loved) continue;
      if (DIM_KEYS.some((k) => args[k] && ![].concat(tg?.[k] || []).includes(args[k]))) continue;
      if (words.length) {
        const hay = `${t.title}\u0001${t.artist}\u0001${t.album}\u0001${t.genre}\u0001${t.path}${tg ? `\u0001${tg.style}\u0001${tg.lang}\u0001${tg.mood.join('\u0001')}\u0001${tg.scene.join('\u0001')}` : ''}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      out.push(t);
    }
    // 歌名完全一致的排前面，其次是歌名包含关键词的
    const q = (args.query || '').trim().toLowerCase();
    const rank = (t) => (!q ? 2 : t.title.toLowerCase() === q ? 0 : t.title.toLowerCase().includes(q) ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b)
      || (a.albumArtist || '').localeCompare(b.albumArtist || '') || (a.album || '').localeCompare(b.album || '')
      || (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 999) - (b.trackNo || 999));
  }

  // track_ids / playlist / 过滤条件 → 曲目 id 列表
  function resolve(args) {
    if (args.track_ids?.length) {
      const ids = args.track_ids.filter((id) => library.tracks.has(id));
      if (!ids.length) throw new Error('这些 track_ids 都不在资料库里，先用 search_tracks 查 id');
      return ids;
    }
    if (args.playlist) {
      const p = library.playlists.find((x) => x.id === args.playlist) || library.playlists.find((x) => x.name === args.playlist)
        || library.playlists.find((x) => x.name.includes(args.playlist));
      if (!p) throw new Error(`没有找到歌单「${args.playlist}」，可以先用 list_playlists 查看`);
      return p.trackIds.filter((id) => library.tracks.has(id));
    }
    if (!Object.keys(FILTERS).some((k) => args[k] != null && args[k] !== '')) throw new Error('请给出 track_ids、playlist 或至少一个筛选条件（query、artist、style、mood…）');
    const ids = filter(args).map((t) => t.id);
    if (!ids.length) throw new Error('资料库里没有符合条件的歌');
    return ids.slice(0, Math.max(1, Math.min(args.limit || 500, 2000)));
  }

  const nowPlaying = async () => {
    const s = await callRenderer('state');
    return { ...s, track: card(library.tracks.get(s.trackId)) || null, trackId: undefined };
  };

  const ro = { readOnlyHint: true, openWorldHint: false };
  const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  return [
    {
      name: 'now_playing',
      title: '正在播放',
      description: '查看播放器当前状态：正在播放的歌、是否在播放、进度、音量、随机 / 循环模式、队列长度。',
      inputSchema: { type: 'object', properties: {} },
      annotations: ro,
      run: nowPlaying,
    },
    {
      name: 'player_control',
      title: '播放控制',
      description: '播放、暂停、切换播放/暂停、下一首、上一首。',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['play', 'pause', 'toggle', 'next', 'previous'] } }, required: ['action'] },
      annotations: act,
      run: async ({ action }) => { await callRenderer('control', { action }); return nowPlaying(); },
    },
    {
      name: 'search_tracks',
      title: '搜索歌曲',
      description: '在本地资料库里找歌，返回歌曲 id 和信息。可以组合筛选，例如 artist="周杰伦"、mood="治愈"、scene="睡前"。',
      inputSchema: { type: 'object', properties: { ...FILTERS, limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 } } },
      annotations: ro,
      run: async (args) => {
        const list = filter(args);
        return { total: list.length, tracks: list.slice(0, Math.min(args.limit || 20, 200)).map(card) };
      },
    },
    {
      name: 'play',
      title: '播放歌曲',
      description: '替换播放队列并开始播放。用 track_ids 播指定的歌；用 playlist 播歌单（名字或 id）；也可以只给筛选条件，比如 {"artist":"陈奕迅"}、{"mood":"伤感","lang":"粤语"}、{"query":"晴天"}，会播放所有符合条件的歌。',
      inputSchema: {
        type: 'object',
        properties: {
          track_ids: { type: 'array', items: { type: 'string' }, description: '按顺序播放这些歌（id 来自 search_tracks）' },
          playlist: { type: 'string', description: '歌单名字或 id' },
          ...FILTERS,
          shuffle: { type: 'boolean', description: '随机播放；不填时，按条件筛出多首歌默认随机，指定 track_ids / 歌单默认顺序' },
          limit: { type: 'integer', minimum: 1, maximum: 2000, description: '按条件筛选时最多放进队列的歌数，默认 500' },
        },
      },
      annotations: act,
      run: async (args) => {
        const ids = resolve(args);
        const shuffle = args.shuffle ?? (!args.track_ids?.length && !args.playlist && !args.album && ids.length > 1);
        await callRenderer('play', { ids, shuffle });
        return { queued: ids.length, shuffle, ...(await nowPlaying()) };
      },
    },
    {
      name: 'add_to_queue',
      title: '加入队列',
      description: '把歌加到播放队列：position="next" 插到当前这首之后，"end" 放到队尾。选歌方式同 play。',
      inputSchema: {
        type: 'object',
        properties: {
          track_ids: { type: 'array', items: { type: 'string' } },
          playlist: { type: 'string' },
          ...FILTERS,
          position: { type: 'string', enum: ['next', 'end'], default: 'end' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        },
      },
      annotations: act,
      run: async (args) => {
        const ids = resolve({ limit: 50, ...args });
        await callRenderer('enqueue', { ids, next: args.position === 'next' });
        return { added: ids.length, position: args.position || 'end' };
      },
    },
    {
      name: 'get_queue',
      title: '查看队列',
      description: '查看播放队列里当前这首及接下来的歌。',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 } } },
      annotations: ro,
      run: async ({ limit = 20 }) => {
        const q = await callRenderer('queue', { limit });
        return { ...q, tracks: q.ids.map((id, i) => ({ position: q.from + i, current: q.from + i === q.index || undefined, ...card(library.tracks.get(id)) })), ids: undefined };
      },
    },
    {
      name: 'set_volume',
      title: '调节音量',
      description: '设置音量，0 到 100。',
      inputSchema: { type: 'object', properties: { volume: { type: 'number', minimum: 0, maximum: 100 } }, required: ['volume'] },
      annotations: act,
      run: async ({ volume }) => callRenderer('volume', { value: volume }),
    },
    {
      name: 'seek',
      title: '跳转进度',
      description: '跳到当前歌曲的第几秒。',
      inputSchema: { type: 'object', properties: { seconds: { type: 'number', minimum: 0 } }, required: ['seconds'] },
      annotations: act,
      run: async ({ seconds }) => callRenderer('seek', { seconds }),
    },
    {
      name: 'set_play_mode',
      title: '播放模式',
      description: '设置随机播放和循环方式（off 不循环、all 列表循环、one 单曲循环）。',
      inputSchema: { type: 'object', properties: { shuffle: { type: 'boolean' }, repeat: { type: 'string', enum: ['off', 'all', 'one'] } } },
      annotations: act,
      run: async (args) => callRenderer('mode', args),
    },
    {
      name: 'set_loved',
      title: '我喜欢',
      description: '把歌加入或移出「我喜欢」。不填 track_id 时操作正在播放的歌。',
      inputSchema: { type: 'object', properties: { track_id: { type: 'string' }, loved: { type: 'boolean', default: true } } },
      annotations: act,
      run: async ({ track_id, loved = true }) => {
        const r = await callRenderer('love', { id: track_id, loved });
        return { loved, track: card(library.tracks.get(r.id)) };
      },
    },
    {
      name: 'list_playlists',
      title: '歌单列表',
      description: '列出所有歌单的名字、id 和歌曲数量。',
      inputSchema: { type: 'object', properties: {} },
      annotations: ro,
      run: async () => ({ playlists: library.playlists.map((p) => ({ id: p.id, name: p.name, tracks: p.trackIds.length })) }),
    },
    {
      name: 'list_categories',
      title: '分类统计',
      description: '查看资料库按某个维度分组后的类别和歌曲数：AI 分类的 style / lang / mood / scene，或者 artist（歌手，前 100 位）、genre（文件标签流派）。',
      inputSchema: { type: 'object', properties: { dimension: { type: 'string', enum: [...DIM_KEYS, 'artist', 'genre'], default: 'style' } } },
      annotations: ro,
      run: async ({ dimension = 'style' }) => {
        const counts = new Map();
        const bump = (k) => k && counts.set(k, (counts.get(k) || 0) + 1);
        let tagged = 0;
        for (const t of library.tracks.values()) {
          if (dimension === 'artist') bump(t.artist);
          else if (dimension === 'genre') bump(t.genre);
          else if (tags(t.id)) { tagged++; [].concat(tags(t.id)[dimension]).forEach(bump); }
        }
        const items = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, dimension === 'artist' ? 100 : 200).map(([name, tracks]) => ({ name, tracks }));
        return { dimension, totalTracks: library.tracks.size, ...(DIM_KEYS.includes(dimension) ? { tagged } : {}), categories: items };
      },
    },
    {
      name: 'get_lyrics',
      title: '获取歌词',
      description: '获取歌词纯文本（去掉时间轴）。不填 track_id 时取正在播放的歌。',
      inputSchema: { type: 'object', properties: { track_id: { type: 'string' } } },
      annotations: { ...ro, openWorldHint: true },
      run: async ({ track_id }) => {
        const id = track_id || (await callRenderer('state')).trackId;
        const t = library.tracks.get(id);
        if (!t) throw new Error(track_id ? '资料库里没有这首歌' : '现在没有在播放');
        const r = await online.getLyrics(t, { online: onlineLyrics() });
        if (r.instrumental) return { track: card(t), lyrics: '', note: '纯音乐' };
        if (!r.lrc) return { track: card(t), lyrics: '', note: '没有找到歌词' };
        const text = r.lrc.split(/\r?\n/).map((l) => l.replace(LRC_TIME, '').trim()).filter((l) => l && !/^\[[a-z]+:/i.test(l)).join('\n');
        return { track: card(t), source: r.source, lyrics: text };
      },
    },
    ...(recommendList ? [{
      name: 'recommend',
      title: '为你推荐',
      description: '按用户的听歌习惯（播放次数、喜欢、跳过、常在什么时段听什么）和资料库构成推荐歌曲，每首附推荐理由。mode：mix 猜你喜欢、now 适合此刻（按时段）、discover 没听过但可能喜欢、rewind 喜欢过但很久没听。play=true 时直接替换队列按推荐顺序播放。',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['mix', 'now', 'discover', 'rewind'], default: 'mix' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          play: { type: 'boolean', default: false },
        },
      },
      annotations: act,
      run: async ({ mode = 'mix', limit = 30, play = false }) => {
        const r = recommendList(mode, { limit: Math.max(1, Math.min(limit, 100)) });
        if (!r.items.length) return { mode, tracks: [], note: mode === 'rewind' ? '还没有「喜欢过但很久没听」的歌' : '没有可推荐的歌' };
        if (play) await callRenderer('play', { ids: r.items.map((x) => x.id), shuffle: false });
        return {
          mode,
          slot: r.slot.label,
          taste: r.profile.top,
          basis: r.profile.basis,
          tracks: r.items.map((x) => ({ ...card(library.tracks.get(x.id)), reason: x.reason })),
          ...(play ? { playing: true } : {}),
        };
      },
    }] : []),
    {
      name: 'classify_library',
      title: 'AI 分类资料库',
      description: '在后台用 Claude 给还没分类的歌打风格 / 语言 / 情绪 / 场景标签（需要在听音里配置 API Key）。all=true 时全部重新分类。返回当前进度，可以重复调用查看进度。',
      inputSchema: { type: 'object', properties: { all: { type: 'boolean', default: false }, status_only: { type: 'boolean', default: false } } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      run: async ({ all = false, status_only = false }) => (status_only ? classifier.status() : classifier.start({ all })),
    },
  ];
}

export const INSTRUCTIONS = `这是「听音」——用户电脑上的本地音乐播放器。
- 想放某首歌：先 search_tracks 找到 id，再 play {track_ids:[…]}；想按心情 / 场景 / 歌手放一批歌，直接 play 并给出筛选条件即可。
- AI 分类可选值 —— ${DIM_KEYS.map((k) => `${DIMENSIONS[k].label}(${k})：${DIMENSIONS[k].values.join('、')}`).join('；')}。
- 不确定资料库里有什么时，用 list_categories 看分类和数量。
- 用户说「随便放点我爱听的」「推荐几首」时用 recommend（可加 play:true 直接播放）。`;
