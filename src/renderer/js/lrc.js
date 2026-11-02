// LRC 歌词解析：多时间戳、[offset:]、逐字时间 <mm:ss.xx>、同一时间戳的第二行视为翻译
const TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META = /^\[(ti|ar|al|by|au|length|re|ve|id|offset|#):?(.*)\]$/i;

const toSec = (m, s, f = '0') => Number(m) * 60 + Number(s) + Number(f.padEnd(3, '0').slice(0, 3)) / 1000;

export function parseLrc(text = '') {
  let offset = 0;
  const timed = [];
  const plain = [];
  for (const rawLine of text.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const meta = line.match(META);
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') offset = Number(meta[2]) / 1000 || 0;
      continue;
    }
    const times = [];
    TIME.lastIndex = 0;
    let m;
    let last = 0;
    while ((m = TIME.exec(line)) && m.index === last) {
      times.push(toSec(m[1], m[2], m[3]));
      last = TIME.lastIndex;
    }
    const body = line.slice(last).replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    if (times.length) for (const t of times) timed.push({ time: t, text: body });
    else plain.push(body);
  }

  if (!timed.length) {
    return { synced: false, offset: 0, lines: plain.map((text) => ({ time: null, text, trans: '' })) };
  }

  // 稳定排序后，相同时间戳的后一行作为前一行的翻译
  timed.sort((a, b) => a.time - b.time);
  const lines = [];
  for (const l of timed) {
    const prev = lines[lines.length - 1];
    if (prev && Math.abs(prev.time - l.time) < 0.01 && l.text) {
      if (!prev.text) prev.text = l.text;
      else if (!prev.trans) prev.trans = l.text;
      continue;
    }
    lines.push({ time: l.time, text: l.text, trans: '' });
  }
  for (const l of lines) l.time = Math.max(0, l.time - offset);
  // 合并连续的空行（间奏）
  const merged = lines.filter((l, i) => l.text || !(lines[i - 1] && !lines[i - 1].text));
  return { synced: true, offset, lines: merged };
}

// 把单独的翻译 LRC（或 { 行号: 译文 }）合并进原歌词
export function mergeTranslation(parsed, trans) {
  if (!trans) return parsed;
  if (typeof trans === 'string') {
    const t = parseLrc(trans);
    if (t.synced && parsed.synced) {
      for (const l of parsed.lines) {
        const hit = t.lines.find((x) => Math.abs(x.time - l.time) < 0.05);
        if (hit && hit.text && hit.text !== l.text) l.trans = hit.text;
      }
    }
    return parsed;
  }
  parsed.lines.forEach((l, i) => { if (trans[i]) l.trans = trans[i]; });
  return parsed;
}

// 二分查找：当前时间对应的最后一行
export function lineAt(lines, t) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// 生成标准 LRC 文本（保存手动调整过偏移的歌词）
export function toLrc(lines, shift = 0) {
  const fmt = (t) => {
    t = Math.max(0, t + shift);
    const m = Math.floor(t / 60);
    const s = (t - m * 60).toFixed(2).padStart(5, '0');
    return `[${String(m).padStart(2, '0')}:${s}]`;
  };
  const out = [];
  for (const l of lines) {
    if (l.time == null) { out.push(l.text); continue; }
    out.push(fmt(l.time) + l.text);
    if (l.trans) out.push(fmt(l.time) + l.trans);
  }
  return out.join('\n');
}

// 判断歌词主要是不是中文（决定是否提供 AI 翻译）
export function mostlyChinese(lines) {
  const text = lines.map((l) => l.text).join('');
  if (!text) return true;
  const han = (text.match(/[一-鿿]/g) || []).length;
  const kana = (text.match(/[぀-ヿ가-힯]/g) || []).length;
  return han / text.length > 0.3 && kana / text.length < 0.05;
}
