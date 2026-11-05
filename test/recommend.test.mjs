import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, buildProfile, slotOf, candidatePool } from '../src/main/recommend.js';
import { AiService, tasteCard } from '../src/main/ai.js';

const DAY = 86400000;
const NOW = new Date(2026, 10, 4, 23, 0).getTime(); // 周三 23 点

// 造一个资料库：4 位歌手 × 2 张专辑 × 5 首，A 是流行伤感，B 是摇滚激昂，C 是古典安静（睡前），D 是民谣治愈
const STYLE = { A: ['流行', '国语', ['伤感'], ['KTV']], B: ['摇滚', '国语', ['激昂'], ['运动']], C: ['古典', '纯音乐', ['安静'], ['睡前']], D: ['民谣', '国语', ['治愈'], ['旅行']] };
function makeLib() {
  const tracks = [];
  const tags = {};
  for (const a of Object.keys(STYLE)) {
    for (let al = 0; al < 2; al++) {
      for (let n = 0; n < 5; n++) {
        const id = `${a}${al}${n}`;
        tracks.push({ id, title: `歌${id}`, artist: `歌手${a}`, album: `专辑${a}${al}`, albumArtist: `歌手${a}`, path: `D:/m/${a}/${al}/${n}.flac`, year: 2005, playCount: 0, skipCount: 0, loved: false, lastPlayed: 0 });
        const [style, lang, mood, scene] = STYLE[a];
        tags[id] = { style, lang, mood, scene };
      }
    }
  }
  return { tracks, tags, byId: new Map(tracks.map((t) => [t.id, t])) };
}
const artistOf = (lib, id) => lib.byId.get(id).artist;

test('没有听歌记录时按收藏推荐，每位歌手最多 2 首、每张专辑最多 2 首', () => {
  const lib = makeLib();
  const r = recommend({ ...lib, mode: 'mix', limit: 20, seed: 1, now: NOW });
  assert.equal(r.profile.basis, 'collection');
  assert.equal(r.items.length, 8); // 4 位歌手 × 2
  const per = {};
  for (const x of r.items) per[artistOf(lib, x.id)] = (per[artistOf(lib, x.id)] || 0) + 1;
  assert.ok(Object.values(per).every((n) => n <= 2));
  assert.ok(r.items.every((x) => x.reason));
});

test('常听的歌手和类型排在前面，理由说得出来', () => {
  const lib = makeLib();
  for (const t of lib.tracks.filter((x) => x.artist === '歌手A').slice(0, 6)) Object.assign(t, { playCount: 12, lastPlayed: NOW - 40 * DAY });
  lib.byId.get('A10').loved = true;
  let hitsA = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const r = recommend({ ...lib, mode: 'mix', limit: 4, seed, now: NOW });
    hitsA += r.items.filter((x) => artistOf(lib, x.id) === '歌手A').length;
  }
  // 20 次、每次 4 首里歌手 A 最多 2 首：满分 40，偏好明显时应接近满分
  assert.ok(hitsA >= 30, `歌手A 出现 ${hitsA} 次`);
  const r = recommend({ ...lib, mode: 'mix', limit: 40, seed: 3, now: NOW });
  assert.notEqual(r.profile.basis, 'collection');
  assert.equal(r.profile.top.artist[0], '歌手A');
  const reasonA = r.items.find((x) => artistOf(lib, x.id) === '歌手A' && !lib.byId.get(x.id).loved)?.reason || '';
  assert.match(reasonA, /常听歌手A/);
});

test('刚听过的歌、老是跳过的歌往后放', () => {
  const lib = makeLib();
  for (const t of lib.tracks.filter((x) => x.artist === '歌手A')) Object.assign(t, { playCount: 5, lastPlayed: NOW - 60 * DAY });
  Object.assign(lib.byId.get('A00'), { lastPlayed: NOW - 3600e3 }); // 一小时前刚听
  Object.assign(lib.byId.get('A01'), { skipCount: 20 });
  let a00 = 0;
  let a01 = 0;
  let a02 = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const ids = recommend({ ...lib, mode: 'mix', limit: 40, seed, now: NOW }).items.map((x) => x.id);
    a00 += ids.includes('A00');
    a01 += ids.includes('A01');
    a02 += ids.includes('A02');
  }
  assert.ok(a00 < a02 / 3 && a01 < a02, `A00=${a00} A01=${a01} A02=${a02}`);
});

test('发掘只给没听过的歌；重温只给喜欢过但三周以上没听的', () => {
  const lib = makeLib();
  Object.assign(lib.byId.get('A00'), { playCount: 9, lastPlayed: NOW - 100 * DAY });
  Object.assign(lib.byId.get('A01'), { playCount: 9, lastPlayed: NOW - 2 * DAY });
  Object.assign(lib.byId.get('B00'), { loved: true });
  Object.assign(lib.byId.get('C00'), { skipCount: 3, lastPlayed: NOW - 90 * DAY });
  const d = recommend({ ...lib, mode: 'discover', limit: 40, seed: 2, now: NOW });
  assert.ok(d.items.every((x) => !lib.byId.get(x.id).playCount && !lib.byId.get(x.id).skipCount));
  const r = recommend({ ...lib, mode: 'rewind', limit: 40, seed: 2, now: NOW });
  assert.deepEqual(r.items.map((x) => x.id).sort(), ['A00', 'B00']);
  assert.match(r.items.find((x) => x.id === 'A00').reason, /听过 9 次.*3 个月前/);
});

test('换一批不和上一批重复', () => {
  const lib = makeLib();
  const a = recommend({ ...lib, mode: 'mix', limit: 6, seed: 5, now: NOW });
  const b = recommend({ ...lib, mode: 'mix', limit: 6, seed: 6, now: NOW, exclude: a.items.map((x) => x.id) });
  assert.equal(b.items.length, 6);
  assert.ok(b.items.every((x) => !a.items.some((y) => y.id === x.id)));
});

test('此刻：按时段挑歌，有足够的时段记录时参考习惯', () => {
  const lib = makeLib();
  assert.equal(slotOf(new Date(NOW)).label, '夜晚');
  assert.equal(slotOf(new Date(2026, 10, 7, 15, 0)).label, '周末下午');
  // 23 点：古典安静（睡前）最合适，民谣治愈其次，KTV / 运动的歌很少出现
  const seen = { 歌手A: 0, 歌手B: 0, 歌手C: 0, 歌手D: 0 };
  for (let seed = 1; seed <= 50; seed++) {
    const r = recommend({ ...lib, mode: 'now', limit: 2, seed, now: NOW });
    for (const x of r.items) seen[artistOf(lib, x.id)]++;
  }
  assert.ok(seen.歌手C > seen.歌手D && seen.歌手D > seen.歌手A + seen.歌手B, JSON.stringify(seen));
  assert.ok(seen.歌手A + seen.歌手B <= 10, JSON.stringify(seen));
  // 这个时段其实总在听摇滚：记录够多后，摇滚也该上来
  const history = Array.from({ length: 30 }, (_, i) => [`B0${i % 5}`, NOW - (i + 1) * DAY]);
  const r = recommend({ ...lib, history, mode: 'now', limit: 4, seed: 1, now: NOW });
  assert.equal(r.habit, 30);
  const base = recommend({ ...lib, mode: 'now', limit: 40, seed: 9, now: NOW });
  const withHabit = recommend({ ...lib, history, mode: 'now', limit: 40, seed: 9, now: NOW });
  const scoreB = (res) => Math.max(...res.items.filter((x) => artistOf(lib, x.id) === '歌手B').map((x) => x.score));
  assert.ok(scoreB(withHabit) > scoreB(base));
});

test('AI 候选池去重，画像能写进提示词', () => {
  const lib = makeLib();
  const { pool, profile } = candidatePool({ ...lib, now: NOW });
  assert.equal(new Set(pool.map((x) => x.id)).size, pool.length);
  assert.ok(pool.length >= 8);
  const card = tasteCard(profile, { label: '夜晚' });
  assert.match(card, /收藏/);
  assert.match(card, /现在是夜晚/);
  assert.equal(buildProfile({ ...lib, now: NOW }).alpha, 0);
});

test('AI 精选：按序号换成歌曲 id，丢掉越界和重复的', async () => {
  const lib = makeLib();
  const ai = new AiService({ dir: '.', getSettings: () => ({ ai: {} }) });
  const calls = [];
  ai.run = async (_id, params) => {
    calls.push(params);
    return JSON.stringify({ title: '夜里听', intro: '思路', picks: [{ i: 1, why: '好听' }, { i: 1, why: '重复' }, { i: 99, why: '越界' }, { i: 0, why: '开场' }] });
  };
  const pool = lib.tracks.slice(0, 3).map((t) => ({ track: t, tags: lib.tags[t.id], from: 'mix' }));
  const { profile } = candidatePool({ ...lib, now: NOW });
  const r = await ai.recommend('r', { pool, profile, slot: { label: '夜晚' }, wish: '安静点' });
  assert.deepEqual(r.items, [{ id: 'A01', why: '好听' }, { id: 'A00', why: '开场' }]);
  assert.equal(r.title, '夜里听');
  const prompt = calls[0].messages[0].content;
  assert.match(prompt, /安静点/);
  assert.match(prompt, /0\t歌手A\t歌A00\t专辑A0/);
});
