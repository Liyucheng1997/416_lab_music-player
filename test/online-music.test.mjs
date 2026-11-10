import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OnlineMusic, toTrack, sizedCover, normalizeBase, onlineId, isOnlineId, DEFAULT_BASE } from '../src/main/online-music.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tingyin-online-'));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const song = (over = {}) => ({ id: '123', source: 'netease', name: '晴天', artists: [{ name: '周杰伦' }], album: '叶惠美', cover: 'https://p1.music.126.net/a/b.jpg?param=300y300', duration: 269000, fee: 'vip', link: 'https://music.163.com/#/song?id=123', ...over });

// 按路径应答的假服务，同时记下收到的请求
function service(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const u = new URL(url);
    const hit = Object.entries(routes).find(([k]) => (k.startsWith('http') ? url.startsWith(k) : u.pathname === k));
    if (!hit) return json({ error: 'not found' }, 404);
    return typeof hit[1] === 'function' ? hit[1](u, opts) : json(hit[1]);
  };
  return { fetch, calls };
}
const make = (routes, config = {}, pinned = () => new Set()) => {
  const svc = service(routes);
  const music = new OnlineMusic({ dir: tmp(), fetch: svc.fetch, getConfig: () => ({ enabled: true, base: 'https://music.example', ...config }), pinned });
  return { music, calls: svc.calls };
};

test('在线歌曲转成和本地歌曲一样的形状', () => {
  const t = toTrack(song());
  assert.equal(t.id, 'ol-netease-123');
  assert.ok(isOnlineId(t.id));
  assert.equal(t.title, '晴天');
  assert.equal(t.artist, '周杰伦');
  assert.equal(t.duration, 269);
  assert.equal(t.coverId, t.id);
  assert.deepEqual(t.online, { source: 'netease', id: '123', fee: 'vip', link: 'https://music.163.com/#/song?id=123' });
  // 每首歌的 path 不同：播放器靠它判断是不是同一个文件
  assert.notEqual(t.path, toTrack(song({ id: '124' })).path);
});

test('清理歌名里的实体和转义，B 站的视频标题不当专辑', () => {
  const kuwo = toTrack(song({ source: 'kuwo', name: '晴天&nbsp;(Live)', artists: [{ name: '周杰伦\\\\u0026五月天' }], cover: '' }));
  assert.equal(kuwo.title, '晴天 (Live)');
  assert.equal(kuwo.artist, '周杰伦&五月天');
  assert.equal(kuwo.coverId, null);
  const bili = toTrack(song({ source: 'bilibili', id: 'BV1xx', title: '【Hi-Res】《晴天》周杰伦', album: '【Hi-Res】《晴天》周杰伦' }));
  assert.equal(bili.album, '');
  assert.equal(bili.note, '【Hi-Res】《晴天》周杰伦');
  assert.equal(onlineId('kugou', 'a/b c'), 'ol-kugou-a_b_c');
});

test('封面尺寸参数与服务地址规整', () => {
  assert.equal(sizedCover('https://p1.music.126.net/a/b.jpg?param=300y300', 800), 'https://p1.music.126.net/a/b.jpg?param=800y800');
  assert.equal(sizedCover('https://i0.hdslb.com/bfs/x.jpg@200w_200h_1c.jpg', 300), 'https://i0.hdslb.com/bfs/x.jpg@300w_300h_1c.jpg');
  assert.equal(sizedCover('http://img.kugou.com/{size}/a.jpg', 800), 'http://img.kugou.com/480/a.jpg');
  assert.equal(normalizeBase(''), DEFAULT_BASE);
  assert.equal(normalizeBase('music.example/'), 'https://music.example');
  assert.equal(normalizeBase('http://127.0.0.1:3000/app/'), 'http://127.0.0.1:3000/app');
  assert.throws(() => normalizeBase('https://user:pw@music.example'));
  assert.throws(() => normalizeBase('ftp://music.example'));
});

test('搜索：按平台分组，去掉只有外链的平台，重复出现的歌保留统计', async () => {
  const { music, calls } = make({
    '/api/search': {
      results: {
        netease: { ok: true, songs: [song()] },
        kugou: { ok: false, songs: [], error: '超时' },
        douyin: { ok: true, songs: [], status: 'external', link: 'https://www.douyin.com' },
      },
    },
  });
  const r = await music.search(' 晴天 ');
  assert.deepEqual(r.groups.map((g) => [g.source, g.name, g.ok, g.tracks.length]), [['netease', '网易云音乐', true, 1], ['kugou', '酷狗音乐', false, 0]]);
  assert.match(calls[0].url, /^https:\/\/music\.example\/api\/search\?q=%E6%99%B4%E5%A4%A9&page=1$/);
  // 同一个关键词短时间内不重复请求
  await music.search('晴天');
  assert.equal(calls.length, 1);

  const t = r.groups[0].tracks[0];
  music.update(t.id, { loved: true });
  music.markPlayed(t.id);
  const again = music.register(song({ name: '晴天 (新版)', duration: 0 }));
  assert.equal(again, t);
  assert.equal(again.title, '晴天 (新版)');
  assert.equal(again.loved, true);
  assert.equal(again.playCount, 1);
  assert.equal(again.duration, 269);
});

test('只把喜欢过、播放过、在歌单或队列里的在线歌曲存盘', () => {
  const pinned = new Set();
  const { music } = make({}, {}, () => pinned);
  const [a, b, c, d] = ['1', '2', '3', '4'].map((id) => music.register(song({ id })));
  music.update(a.id, { loved: true });
  music.markPlayed(b.id);
  pinned.add(c.id);
  assert.deepEqual(music.kept().map((t) => t.id).sort(), [a.id, b.id, c.id]);
  assert.ok(music.tracks.has(d.id));
  music.flushSync();
  const saved = JSON.parse(fs.readFileSync(music.store.file, 'utf8'));
  assert.equal(saved.tracks.length, 3);
});

test('播放：解析音源并转发音频流，带上 Range', async () => {
  const { music, calls } = make({
    '/api/play': { url: '/api/stream/bilibili/BV1', via: 'bilibili', kind: 'full', quality: { bitrate: 184 }, resources: [{ url: '/api/stream/bilibili/BV1' }] },
    '/api/stream/bilibili/BV1': (_u, opts) => new Response('abcd', { status: 206, headers: { 'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-3/100', 'Content-Length': '4' } }),
  });
  const t = music.register(song());
  const res = await music.stream(t, new Request('media://track/x', { headers: { Range: 'bytes=0-3' } }));
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'audio/mp4');
  assert.equal(res.headers.get('content-range'), 'bytes 0-3/100');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(await res.text(), 'abcd');
  const play = new URL(calls[0].url);
  assert.deepEqual([play.searchParams.get('source'), play.searchParams.get('id'), play.searchParams.get('name'), play.searchParams.get('artist'), play.searchParams.get('duration')],
    ['netease', '123', '晴天', '周杰伦', '269000']);
  assert.equal(calls[1].url, 'https://music.example/api/stream/bilibili/BV1');
  assert.equal(calls[1].opts.headers.Range, 'bytes=0-3');
  // 后面的分段请求不再重新解析
  await music.stream(t, new Request('media://track/x'));
  assert.equal(calls.filter((c) => c.url.includes('/api/play')).length, 1);
  assert.deepEqual(await music.info(t.id), { available: true, via: 'bilibili', viaName: '哔哩哔哩', kind: 'full', quality: { bitrate: 184 }, matched: '', coverId: t.id });
});

test('播放：首选地址失效时换备用地址；没有音源返回 404', async () => {
  const { music, calls } = make({
    '/api/play': (u) => (u.searchParams.get('id') === '404'
      ? json({ url: null, resources: [], statuses: {} })
      : json({ url: 'https://cdn.example/dead.mp3', via: 'netease', resources: [{ url: 'https://cdn.example/dead.mp3' }, { url: 'https://cdn2.example/ok.mp3' }] })),
    'https://cdn.example/dead.mp3': () => new Response('gone', { status: 403 }),
    'https://cdn2.example/ok.mp3': () => new Response('music', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }),
  });
  const ok = await music.stream(music.register(song()), new Request('media://track/x'));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'music');
  assert.deepEqual(calls.slice(1).map((c) => c.url), ['https://cdn.example/dead.mp3', 'https://cdn2.example/ok.mp3']);

  const none = await music.stream(music.register(song({ id: '404' })), new Request('media://track/y'));
  assert.equal(none.status, 404);
});

test('歌词：没有歌词返回 null，纯音乐单独标记；关闭后不再请求', async () => {
  let enabled = true;
  const svc = service({
    '/api/lyric': (u) => json(u.searchParams.get('id') === '1' ? { lrc: '[00:01.00]故事的小黄花', tlyric: '', pure: false } : u.searchParams.get('id') === '2' ? { lrc: '', pure: true } : { lrc: '' }),
  });
  const music = new OnlineMusic({ dir: tmp(), fetch: svc.fetch, getConfig: () => ({ enabled, base: 'https://music.example' }) });
  const a = await music.lyric(music.register(song({ id: '1' })));
  assert.equal(a.lrc, '[00:01.00]故事的小黄花');
  assert.equal(a.source, '在线音乐 · 网易云音乐');
  assert.equal((await music.lyric(music.register(song({ id: '2' })))).instrumental, true);
  assert.equal(await music.lyric(music.register(song({ id: '3' }))), null);
  enabled = false;
  await assert.rejects(() => music.toplists(), /关闭/);
});
