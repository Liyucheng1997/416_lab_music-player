import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, lineAt, mergeTranslation, toLrc, mostlyChinese } from '../src/renderer/js/lrc.js';

test('解析普通 LRC 并忽略元信息', () => {
  const r = parseLrc('[ti:稻香]\n[ar:周杰伦]\n[00:01.00]第一句\n[00:05.50]第二句\n');
  assert.equal(r.synced, true);
  assert.deepEqual(r.lines.map((l) => [l.time, l.text]), [[1, '第一句'], [5.5, '第二句']]);
});

test('一行多个时间戳会展开并排序', () => {
  const r = parseLrc('[00:10.00][00:30.00]副歌\n[00:20.00]主歌');
  assert.deepEqual(r.lines.map((l) => l.text), ['副歌', '主歌', '副歌']);
});

test('同一时间戳的第二行作为翻译', () => {
  const r = parseLrc('[00:01.00]Hello, it\'s me\n[00:01.00]你好，是我\n[00:04.00]I was wondering');
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].trans, '你好，是我');
});

test('offset 与逐字时间戳', () => {
  const r = parseLrc('[offset:500]\n[00:02.00]<00:02.00>逐<00:02.30>字');
  assert.equal(r.lines[0].time, 1.5);
  assert.equal(r.lines[0].text, '逐字');
});

test('三位毫秒与两位百分秒', () => {
  const r = parseLrc('[01:02.345]a\n[01:03.5]b');
  assert.equal(r.lines[0].time, 62.345);
  assert.equal(r.lines[1].time, 63.5);
});

test('无时间轴的纯文本歌词', () => {
  const r = parseLrc('第一行\n\n第二行');
  assert.equal(r.synced, false);
  assert.deepEqual(r.lines.map((l) => l.text), ['第一行', '第二行']);
});

test('连续空行合并为一个间奏', () => {
  const r = parseLrc('[00:01]a\n[00:02]\n[00:03]\n[00:04]b');
  assert.deepEqual(r.lines.map((l) => l.text), ['a', '', 'b']);
});

test('lineAt 二分查找', () => {
  const lines = [{ time: 0 }, { time: 5 }, { time: 10 }];
  assert.equal(lineAt(lines, -1), -1);
  assert.equal(lineAt(lines, 0), 0);
  assert.equal(lineAt(lines, 7), 1);
  assert.equal(lineAt(lines, 99), 2);
});

test('合并按行号的翻译并导出 LRC', () => {
  const r = mergeTranslation(parseLrc('[00:01.00]Hello\n[00:02.00]World'), { 1: '世界' });
  assert.equal(r.lines[1].trans, '世界');
  assert.equal(toLrc(r.lines, 0.5), '[00:01.50]Hello\n[00:02.50]World\n[00:02.50]世界');
});

test('判断中文歌词', () => {
  assert.equal(mostlyChinese([{ text: '故事的小黄花' }]), true);
  assert.equal(mostlyChinese([{ text: 'Hello it is me' }]), false);
  assert.equal(mostlyChinese([{ text: '夢ならばどれほどよかったでしょう' }]), false);
});
