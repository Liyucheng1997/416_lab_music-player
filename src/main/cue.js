// CUE 分轨：解析 .cue，把整轨镜像（一张 CD 一个文件）拆成虚拟单曲
const unquote = (s = '') => s.trim().replace(/^"(.*)"$/, '$1').trim();
// 75 帧 = 1 秒
const toSec = (mmssff) => {
  const [m, s, f] = mmssff.split(':').map(Number);
  return m * 60 + s + (f || 0) / 75;
};
// 资源站水印之类的演唱者（「[51ape.com]」「www.xxx.com」）不可信
const junk = (s) => !s || /^\[.*\]$/.test(s) || /(www\.|\.com|\.net|\.cn)\b/i.test(s);

export function parseCue(text) {
  const sheet = { title: '', performer: '', date: null, genre: '', files: [] };
  let file = null;
  let track = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(\S+)\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    switch (key.toUpperCase()) {
      case 'REM': {
        const r = rest.match(/^(\S+)\s+(.*)$/);
        if (!r) break;
        if (r[1].toUpperCase() === 'DATE') sheet.date = Number(unquote(r[2]).slice(0, 4)) || null;
        if (r[1].toUpperCase() === 'GENRE') sheet.genre = unquote(r[2]);
        break;
      }
      case 'FILE': {
        const name = rest.match(/^"(.*)"/)?.[1] ?? rest.replace(/\s+\S+$/, '');
        file = { name: name.trim(), tracks: [] };
        sheet.files.push(file);
        track = null;
        break;
      }
      case 'TRACK':
        if (!file) break;
        track = { no: Number(rest.split(/\s+/)[0]), title: '', performer: '', composer: '', start: null, pregap: null };
        file.tracks.push(track);
        break;
      case 'TITLE':
        if (track) track.title = unquote(rest); else sheet.title = unquote(rest);
        break;
      case 'PERFORMER':
        if (track) track.performer = unquote(rest); else sheet.performer = unquote(rest);
        break;
      case 'SONGWRITER':
        if (track) track.composer = unquote(rest);
        break;
      case 'INDEX': {
        if (!track) break;
        const [num, time] = rest.split(/\s+/);
        if (Number(num) === 1) track.start = toSec(time);
        else if (Number(num) === 0) track.pregap = toSec(time);
        break;
      }
      default:
    }
  }
  for (const f of sheet.files) {
    f.tracks = f.tracks.filter((t) => t.start != null).sort((a, b) => a.start - b.start);
    f.tracks.forEach((t, i) => {
      // 一首的结束 = 下一首的 INDEX 00（间隙开始），没有间隙就用 INDEX 01
      const next = f.tracks[i + 1];
      t.end = next ? (next.pregap ?? next.start) : null;
      if (junk(t.performer)) t.performer = '';
    });
  }
  if (junk(sheet.performer)) sheet.performer = '';
  return sheet;
}

// 只有一个 FILE 里包含多首歌时才需要拆分；每首一个文件的 CUE 交给普通扫描
export const isImage = (file) => file.tracks.length >= 2;
