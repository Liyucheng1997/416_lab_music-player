import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Library, guessFromFilename, cleanTag, cleanFolderName } from '../src/main/library.js';
import { decodeText, cleanTitle, overlap } from '../src/main/online.js';

test('从文件名推断歌手、歌名、音轨号', () => {
  assert.deepEqual(guessFromFilename('D:/m/03 周杰伦 - 晴天.mp3'), { artist: '周杰伦', title: '晴天', trackNo: 3, discNo: null });
  assert.deepEqual(guessFromFilename('D:/m/Hello.flac'), { artist: '', title: 'Hello', trackNo: null, discNo: null });
  assert.deepEqual(guessFromFilename('D:/m/1-01 今天等我来.wav'), { artist: '', title: '今天等我来', trackNo: 1, discNo: 1 });
  assert.deepEqual(guessFromFilename('D:/m/刀郎-冲动的惩罚.wav'), { artist: '刀郎', title: '冲动的惩罚', trackNo: null, discNo: null });
  assert.equal(guessFromFilename('D:/m/2002年的第一场雪.wav').title, '2002年的第一场雪');
  assert.equal(guessFromFilename('D:/m/Re-Do.mp3').artist, '');
  assert.deepEqual(guessFromFilename('D:/m/爱乐团 -天涯.wav'), { artist: '爱乐团', title: '天涯', trackNo: null, discNo: null });
});

test('清理标签水印与目录名修饰', () => {
  assert.equal(cleanTag('张国荣【熊猫无损音乐www.xmwav.com】更多打包资源下载'), '张国荣');
  assert.equal(cleanTag('晴天 (Live)'), '晴天 (Live)');
  assert.equal(cleanTag('Hello [www.51ape.com]'), 'Hello');
  assert.equal(cleanTag('【Hi-Res】孙露'), '孙露');
  assert.equal(cleanTag('任贤齐&李宗盛&熊猫无损音乐'), '任贤齐&李宗盛');
  assert.equal(cleanTag('T.R.Y.&熊猫无损音乐www.xmwav.com更多打包下载'), 'T.R.Y.');
  assert.equal(cleanTag('稻香 [Live]'), '稻香 [Live]');
  assert.equal(cleanFolderName('陈奕迅 DUO（WAV）'), '陈奕迅 DUO');
  assert.equal(cleanFolderName('薛之谦精选[WAV+5.41GB](1)'), '薛之谦精选');
});

test('标题清洗与 GBK 歌词解码', () => {
  assert.equal(cleanTitle('晴天 (Live)'), '晴天');
  assert.equal(cleanTitle('Lemon feat. Someone'), 'Lemon');
  const gbk = Buffer.from([0x5b, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x5d, 0xc7, 0xe7, 0xcc, 0xec]); // [00:01]晴天
  assert.equal(decodeText(gbk), '[00:01]晴天');
});

test('封面结果相关度：简繁体部分重合也能得分', () => {
  assert.ok(overlap('周杰伦 叶惠美', '葉惠美 周杰倫') > 0.6);
  assert.ok(overlap('周杰伦 叶惠美', 'Puccini: Essentials Angela') < 0.2);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('扫描文件夹：读标签、增量更新、删除失效文件', { skip: !hasFfmpeg && '需要 ffmpeg 生成测试音频' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tingyin-'));
  const music = path.join(root, 'music');
  fs.mkdirSync(path.join(music, 'a'), { recursive: true });
  const mk = (file, title, artist) => spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', 'album=测试专辑', file]);
  mk(path.join(music, 'a', 'one.mp3'), '第一首', '歌手甲');
  mk(path.join(music, '02 歌手乙 - 第二首.flac'), '', '');

  const lib = new Library({ dir: path.join(root, 'data'), thumb: (b) => b });
  let stats = await lib.addFolder(music);
  assert.equal(stats.added, 2);
  const tracks = lib.snapshot().tracks.sort((x, y) => x.title.localeCompare(y.title));
  const one = tracks.find((t) => t.ext === 'mp3');
  assert.equal(one.title, '第一首');
  assert.equal(one.artist, '歌手甲');
  assert.equal(one.album, '测试专辑');
  assert.ok(one.duration > 2);
  const two = tracks.find((t) => t.ext === 'flac');
  assert.equal(two.title, '第二首');
  assert.equal(two.artist, '歌手乙');
  assert.equal(two.trackNo, 2);

  lib.markPlayed(one.id);
  stats = await lib.scan();
  assert.equal(stats.added + stats.updated, 0, '未改动的文件不应重新读取');
  assert.equal(lib.tracks.get(one.id).playCount, 1);

  fs.unlinkSync(path.join(music, 'a', 'one.mp3'));
  stats = await lib.scan();
  assert.equal(stats.removed, 1);
  assert.equal(lib.tracks.size, 1);

  const pl = lib.createPlaylist('我的歌单', [two.id]);
  lib.updatePlaylist(pl.id, { add: [two.id, 'x'] });
  assert.deepEqual(lib.playlists[0].trackIds, [two.id, 'x']);
  await lib.flush();
  for (const w of lib.watchers.values()) w.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('CUE 整轨拆分为单曲，并跳过 macOS 的 ._ 隐藏文件', { skip: !hasFfmpeg && '需要 ffmpeg 生成测试音频' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tingyin-cue-'));
  const music = path.join(root, 'music');
  fs.mkdirSync(music, { recursive: true });
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9', path.join(music, 'CD1.flac')]);
  fs.writeFileSync(path.join(music, '._CD1.flac'), 'apple double');
  // CUE 里写的是 .wav，实际文件是 .flac
  fs.writeFileSync(path.join(music, 'CD1-曲单.cue'), 'PERFORMER "演奏家"\nTITLE "测试专辑"\nREM DATE 1999\nFILE "CD1.wav" WAVE\n  TRACK 01 AUDIO\n    TITLE "第一乐章"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "第二乐章"\n    INDEX 01 00:04:00\n');
  const lib = new Library({ dir: path.join(root, 'data'), thumb: (b) => b });
  const stats = await lib.addFolder(music);
  const tracks = lib.snapshot().tracks.sort((a, b) => a.trackNo - b.trackNo);
  assert.equal(tracks.length, 2, '整轨文件本身不应再作为一首歌出现');
  assert.equal(stats.added, 2);
  assert.deepEqual(tracks.map((t) => [t.title, t.album, t.artist, t.year, t.cueStart]), [['第一乐章', '测试专辑', '演奏家', 1999, 0], ['第二乐章', '测试专辑', '演奏家', 1999, 4]]);
  assert.equal(tracks[0].cueEnd, 4);
  assert.ok(Math.abs(tracks[1].duration - 5) < 0.2);
  assert.equal(tracks[0].fileId, tracks[1].fileId);
  const again = await lib.scan();
  assert.equal(again.added + again.updated + again.removed, 0, '未改动时不重新读取');
  for (const w of lib.watchers.values()) w.close();
  fs.rmSync(root, { recursive: true, force: true });
});
