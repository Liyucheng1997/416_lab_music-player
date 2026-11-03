// 在线歌词来源：网易云音乐、QQ 音乐、酷狗（国内曲库全、简体字）+ LRCLIB（开放歌词库，欧美歌多）
// 每个来源：search({ title, artist }) → 候选列表；fetch(item) → { lrc, trans, instrumental }
import { Converter } from 'opencc-js/t2cn';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// LRCLIB 的中文歌词多是港台用户上传的繁体；按台湾用字转成大陆简体（「著」→「着」）
const t2s = Converter({ from: 'tw', to: 'cn' });
// 「妳」在大陆不常用，OpenCC 不转，这里统一成「你」
export const toSimplified = (s) => (s ? t2s(s).replace(/妳/g, '你') : s);

const entities = (s = '') => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// 网易云歌词开头有 JSON 格式的制作人员行，解析器不认识，去掉
const stripJsonLines = (s = '') => s.split('\n').filter((l) => !l.trim().startsWith('{')).join('\n').trim();

const isPureMusic = (lrc) => /纯音乐，请(欣赏|您欣赏)|此歌曲为没有填词的纯音乐/.test(lrc) && lrc.split('\n').filter((l) => l.trim()).length <= 3;

export function createSources(online) {
  const get = (url, headers) => online.json(url, 12000, { 'User-Agent': BROWSER_UA, ...headers });
  const keyword = ({ title, artist }) => `${title || ''} ${artist || ''}`.trim();

  const netease = {
    key: 'netease',
    name: '网易云音乐',
    bonus: 8,
    async search(q) {
      const r = await get(`https://music.163.com/api/search/get?${new URLSearchParams({ s: keyword(q), type: '1', limit: '12', offset: '0' })}`, { Referer: 'https://music.163.com/' });
      return (r?.result?.songs || []).map((x) => ({
        id: String(x.id),
        title: x.name,
        artist: (x.artists || []).map((a) => a.name).join(' / '),
        album: x.album?.name || '',
        duration: x.duration ? x.duration / 1000 : null,
      }));
    },
    async fetch(item) {
      const r = await get(`https://music.163.com/api/song/lyric?${new URLSearchParams({ id: item.id, lv: '1', tv: '-1' })}`, { Referer: 'https://music.163.com/' });
      const lrc = stripJsonLines(r?.lrc?.lyric);
      return { lrc, trans: stripJsonLines(r?.tlyric?.lyric), instrumental: !!r?.nolyric || isPureMusic(lrc) };
    },
  };

  const qq = {
    key: 'qq',
    name: 'QQ 音乐',
    bonus: 7,
    async search(q) {
      const r = await get(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${new URLSearchParams({ w: keyword(q), format: 'json', n: '12', p: '1', cr: '1' })}`, { Referer: 'https://y.qq.com/' });
      return (r?.data?.song?.list || []).map((x) => ({
        id: x.songmid,
        title: x.songname,
        artist: (x.singer || []).map((a) => a.name).join(' / '),
        album: x.albumname || '',
        duration: x.interval || null,
      }));
    },
    async fetch(item) {
      const r = await get(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${new URLSearchParams({ songmid: item.id, format: 'json', nobase64: '1', g_tk: '5381' })}`, { Referer: 'https://y.qq.com/' });
      const lrc = entities(r?.lyric);
      return { lrc, trans: entities(r?.trans), instrumental: isPureMusic(lrc) };
    },
  };

  const kugou = {
    key: 'kugou',
    name: '酷狗音乐',
    bonus: 6,
    async search(q) {
      // 这个接口的 https 证书有问题，只能走 http；只取歌曲信息，歌词走 https
      const r = await get(`http://mobilecdn.kugou.com/api/v3/search/song?${new URLSearchParams({ keyword: keyword(q), page: '1', pagesize: '12', format: 'json' })}`);
      return (r?.data?.info || []).map((x) => ({
        id: x.hash,
        title: x.songname,
        artist: x.singername || '',
        album: x.album_name || '',
        duration: x.duration || null,
      }));
    },
    async fetch(item) {
      const params = { ver: '1', man: 'yes', client: 'mobi', hash: item.id, ...(item.duration ? { duration: String(Math.round(item.duration * 1000)) } : {}) };
      const r = await get(`https://krcs.kugou.com/search?${new URLSearchParams(params)}`);
      const c = r?.candidates?.[0];
      if (!c) return { lrc: '' };
      const d = await get(`https://lyrics.kugou.com/download?${new URLSearchParams({ ver: '1', client: 'pc', id: c.id, accesskey: c.accesskey, fmt: 'lrc', charset: 'utf8' })}`);
      const lrc = d?.content ? Buffer.from(d.content, 'base64').toString('utf8') : '';
      return { lrc, instrumental: isPureMusic(lrc) };
    },
  };

  const lrclib = {
    key: 'lrclib',
    name: 'LRCLIB',
    bonus: 4,
    async search({ title, artist, q }) {
      const params = q ? new URLSearchParams({ q }) : new URLSearchParams({ track_name: title || '', ...(artist ? { artist_name: artist } : {}) });
      let list = (await online.json(`https://lrclib.net/api/search?${params}`)) || [];
      if (!list.length && !q && title) list = (await online.json(`https://lrclib.net/api/search?${new URLSearchParams({ q: keyword({ title, artist }) })}`)) || [];
      return list.map(lrclibItem);
    },
    // 有时长时先试精确匹配，命中率高
    async exact({ title, artist, album, duration }) {
      const q = new URLSearchParams({ track_name: title, artist_name: artist, album_name: album || '', duration: String(Math.round(duration)) });
      const x = await online.json(`https://lrclib.net/api/get?${q}`);
      return x && (x.syncedLyrics || x.plainLyrics || x.instrumental) ? lrclibItem(x) : null;
    },
    async fetch(item) {
      return { lrc: item.lrc, instrumental: item.instrumental };
    },
  };

  return [netease, qq, kugou, lrclib];
}

function lrclibItem(x) {
  return {
    id: String(x.id),
    title: x.trackName,
    artist: x.artistName,
    album: x.albumName,
    duration: x.duration,
    synced: !!x.syncedLyrics,
    instrumental: !!x.instrumental,
    lrc: x.syncedLyrics || x.plainLyrics || '',
  };
}
