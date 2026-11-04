// AI 调音：按歌曲类型和播放设备，让 Claude 推荐均衡器曲线和其他让声音更好听的设置；
// 「我的曲库」模式下为每类歌各调一条曲线，切歌时按类型自动切换
import { h, icon, clear } from './dom.js';
import { state, on, emit, saveSettings } from './store.js';
import { modal, toast } from './ui.js';
import { player, setEqSource, refreshEq, EQ_FREQS } from './player.js';
import { requestDetached, hasKey } from './ai-ctl.js';
import { openSettings } from './dialogs.js';

export const DEVICE_TYPES = ['入耳式耳机', '头戴式耳机', '真无线蓝牙耳机', '头戴式蓝牙耳机', '笔记本扬声器', '桌面音箱', '带低音炮的音箱', '蓝牙小音箱', '电视 / 回音壁', '显示器内置扬声器', '车载音响'];

// ---------- 歌曲归类：优先用 AI 分类的风格，没有就用文件标签里的流派 ----------
const cleanGenre = (g) => (g || '').split(/[;/,，、]/)[0].trim();
export function trackKey(t) {
  if (!t) return null;
  const style = state.tags[t.id]?.style;
  return style && style !== '其他' ? style : cleanGenre(t.genre) || null;
}

export function libraryGroups(limit = 8) {
  const m = new Map();
  for (const t of state.tracks) {
    const k = trackKey(t);
    if (!k) continue;
    const id = k.toLowerCase();
    let g = m.get(id);
    if (!g) m.set(id, (g = { key: k, count: 0, artists: new Map() }));
    g.count++;
    if (t.artist) g.artists.set(t.artist, (g.artists.get(t.artist) || 0) + 1);
  }
  return [...m.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => ({ key: g.key, count: g.count, artists: [...g.artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]) }));
}

// ---------- 播放设备：读系统默认输出设备的名字，猜一下类型 ----------
export async function detectOutput() {
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const def = outs.find((d) => d.deviceId === 'default') || outs[0];
    return (def?.label || '').replace(/^(默认|Default)\s*-\s*/i, '').trim();
  } catch {
    return '';
  }
}

export function guessType(label) {
  const l = (label || '').toLowerCase();
  if (!l) return '';
  if (/airpods pro|airpods|buds|freebuds|wf-|tws|earbuds|hands-free|免提/.test(l)) return '真无线蓝牙耳机';
  if (/wh-|airpods max|qc\d|quietcomfort|momentum|headset|bose|sennheiser hd 4/.test(l)) return '头戴式蓝牙耳机';
  if (/headphone|耳机|earphone/.test(l)) return '入耳式耳机';
  if (/hdmi|display|显示器|nvidia high definition|amd high definition/.test(l)) return '显示器内置扬声器';
  if (/(speaker|扬声器).*(realtek|intel|smart sound|conexant|cirrus|sound research)|(realtek|intel|conexant|cirrus).*(speaker|扬声器)/.test(l)) return '笔记本扬声器';
  if (/soundbar|回音壁|tv|电视/.test(l)) return '电视 / 回音壁';
  if (/(speaker|扬声器|音箱|sound).*(bluetooth|蓝牙)|(bluetooth|蓝牙).*(speaker|扬声器|音箱)/.test(l)) return '蓝牙小音箱';
  if (/speaker|扬声器|音箱/.test(l)) return '桌面音箱';
  return '';
}

// ---------- 实际生效的曲线 ----------
let preview = null; // 对话框里试听中的曲线，优先级最高
let current = null; // 自动模式下当前用的曲线
const tune = () => state.settings?.tune || {};
export const autoOn = () => !!(tune().auto && tune().profiles?.length);
export const activeProfile = () => (autoOn() ? current : null);

function pickProfile(t) {
  const ps = tune().profiles || [];
  const k = trackKey(t)?.toLowerCase();
  return (k && ps.find((p) => p.key.toLowerCase() === k)) || ps.find((p) => p.key === '默认') || ps[0] || null;
}

function source() {
  if (preview) return preview;
  if (autoOn()) {
    current = pickProfile(player.track);
    if (current) return { enabled: true, preamp: current.preamp, bands: current.bands };
  }
  current = null;
  return state.settings.eq;
}

let lastLabel = '';
export function initTune() {
  setEqSource(source);
  on('player:track', () => { if (autoOn()) { refreshEq(); emit('tune', current); } });
  detectOutput().then((l) => { lastLabel = l; });
  navigator.mediaDevices?.addEventListener('devicechange', async () => {
    const l = await detectOutput();
    if (!l || l === lastLabel) return;
    lastLabel = l;
    const made = tune().last?.label;
    if ((autoOn() || state.settings.eq.enabled) && made && made !== l) toast(`播放设备换成了「${l}」，可以在均衡器里用 AI 调音重新推荐`);
  });
}

export function stopAuto() {
  if (tune().auto) saveSettings({ tune: { auto: false } }).then(() => emit('tune', null));
}

// ---------- 曲线缩略图 ----------
export function curveSvg(bands, { w = 240, hgt = 64 } = {}) {
  const pad = 4;
  const x = (i) => pad + (i / (EQ_FREQS.length - 1)) * (w - pad * 2);
  // 纵轴满量程 ±8 dB：推荐曲线一般很温和，按 ±12 画会看不出起伏
  const y = (db) => hgt / 2 - (Math.max(-8, Math.min(8, db)) / 8) * (hgt / 2 - pad);
  const pts = bands.map((b, i) => [x(i), y(b)]);
  // Catmull-Rom 转贝塞尔，让曲线平滑
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1.map((v) => v.toFixed(1))} ${c2.map((v) => v.toFixed(1))} ${p2.map((v) => v.toFixed(1))}`;
  }
  const area = `${d} L${x(pts.length - 1).toFixed(1)},${hgt / 2} L${x(0).toFixed(1)},${hgt / 2} Z`;
  const box = h('span', { class: 'tune-curve' });
  box.innerHTML = `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" x2="${w}" y1="${hgt / 2}" y2="${hgt / 2}" class="zero"/>
    <path d="${area}" class="area"/><path d="${d}" class="line"/></svg>`;
  return box;
}

const fmtFreq = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
const fmtDb = (v) => `${v > 0 ? '+' : ''}${v}`;

// ---------- 对话框 ----------
export async function openTune(initialMode) {
  const t0 = tune();
  const last = t0.last;
  const label = await detectOutput();
  const device = { type: t0.device?.type || guessType(label), model: t0.device?.model || '' };
  let mode = initialMode || last?.mode || (player.track ? 'now' : 'library');
  let result = last?.result && last.mode === mode ? last.result : null;
  let resultMeta = result ? { stale: true, at: last.at, track: last.trackTitle } : null;
  let selected = 0;
  let listening = result ? 'orig' : 'ai'; // ai = 听推荐，orig = 听原来的；打开对话框时先不改变正在听的声音
  let req = null;

  // 设备
  const typeSel = h('select', { class: 'input' }, h('option', { value: '' }, '选择设备类型'),
    DEVICE_TYPES.map((x) => h('option', { value: x, selected: device.type === x }, x)));
  typeSel.addEventListener('change', () => { device.type = typeSel.value; });
  const model = h('input', { class: 'input', value: device.model, placeholder: '型号（可不填），如 AirPods Pro 2、漫步者 R1000' });
  model.addEventListener('input', () => { device.model = model.value.trim(); });
  const detected = h('div', { class: 'ai-note' }, label ? `系统当前输出：${label}` : '没读到系统输出设备的名字，手动选一下类型就好');

  // 对象
  const context = h('div', { class: 'ai-note tune-context' });
  const drawContext = () => {
    if (mode === 'now') {
      const t = player.track;
      const k = trackKey(t);
      clear(context, t ? `为《${t.title}》${t.artist ? ` - ${t.artist}` : ''} 调一条曲线${k ? `（${k}）` : ''}，应用后作为固定的均衡器设置。` : '还没有在播放的歌，先放一首，或者选「我的曲库」。');
    } else {
      const gs = libraryGroups();
      clear(context, gs.length
        ? [`按你曲库里的主要类型各调一条：${gs.map((g) => `${g.key} ${g.count}`).join(' · ')}，另加一条「默认」。应用后切歌时自动换曲线。`,
          Object.keys(state.tags).length ? null : h('div', {}, '提示：先在侧栏「AI 分类」给歌曲分好风格，归类会更准；现在用的是文件里的流派标签。')]
        : '曲库里的歌还没有风格或流派信息，只会给一条通用的「默认」曲线。可以先到侧栏「AI 分类」给歌曲分类。');
    }
  };
  const seg = h('div', { class: 'seg' }, [['now', '这首歌'], ['library', '我的曲库']].map(([k, text]) =>
    h('button', { class: mode === k ? 'active' : '', onclick: (e) => {
      if (mode === k) return;
      mode = k;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
      result = last?.result && last.mode === mode ? last.result : null;
      resultMeta = result ? { stale: true, at: last.at, track: last.trackTitle } : null;
      selected = 0;
      stopPreview();
      drawContext();
      drawResult();
    } }, text)));

  const wish = h('input', { class: 'input', value: t0.wish || '', placeholder: '偏好（可不填）：比如 人声再清楚点、低音别太轰、听久了不累' });
  const goBtn = h('button', { class: 'btn btn-primary', onclick: go }, icon('sparkles', 15), '让 AI 推荐');
  const out = h('div', { class: 'tune-result' });

  // 试听
  function setPreview() {
    const p = result?.profiles?.[selected];
    preview = listening === 'ai' && p ? { enabled: true, preamp: p.preamp, bands: p.bands } : null;
    refreshEq();
  }
  function stopPreview() { preview = null; refreshEq(); }

  async function go() {
    if (!hasKey()) {
      clear(out, h('div', { class: 'tune-nokey' }, h('div', { class: 'ai-error' }, '还没有配置 Claude API Key，AI 调音需要用它。'),
        h('button', { class: 'btn btn-sm', onclick: () => { m.close(); openSettings('ai'); } }, '去设置')));
      return;
    }
    if (mode === 'now' && !player.track) return toast('先放一首歌，或者选「我的曲库」');
    if (!device.type && !device.model && !label) return toast('先选一下播放设备的类型');
    req?.cancel();
    stopPreview();
    const payload = {
      mode,
      trackId: mode === 'now' ? player.track?.id : undefined,
      tags: mode === 'now' ? state.tags[player.track?.id] : undefined,
      groups: mode === 'library' ? libraryGroups() : undefined,
      device: { ...device, label, volume: player.volume },
      wish: wish.value.trim(),
    };
    saveSettings({ tune: { device, wish: payload.wish } });
    goBtn.disabled = true;
    clear(out, h('div', { class: 'tune-loading' }, h('div', { class: 'spinner' }), h('span', {}, mode === 'now' ? '正在听这首歌适合怎么调…' : '正在为每一类歌调曲线…'),
      h('button', { class: 'btn btn-sm', onclick: () => req?.cancel() }, '停止')));
    req = requestDetached('tune', payload);
    const mine = req;
    try {
      const r = await req.promise;
      if (mine !== req) return;
      result = r;
      selected = 0;
      listening = 'ai';
      const trackTitle = mode === 'now' ? player.track?.title || '' : '';
      resultMeta = { stale: false, at: Date.now(), track: trackTitle };
      saveSettings({ tune: { last: { mode, result: r, label, trackTitle, at: resultMeta.at } } });
      drawResult();
      setPreview();
    } catch (e) {
      if (mine !== req) return;
      clear(out, h('div', { class: 'ai-error' }, e.message === '已停止' ? '已停止' : `推荐失败：${e.message}`));
    } finally {
      if (mine === req) { goBtn.disabled = false; req = null; }
    }
  }

  const footer = h('div', { class: 'tune-footer' });
  function drawFooter() {
    const p = result?.profiles?.[selected];
    const close = h('button', { class: 'btn', onclick: () => m.close() }, '关闭');
    if (!p) return clear(footer, close);
    const applyOne = h('button', { class: `btn ${mode === 'now' ? 'btn-primary' : ''}`, onclick: async () => {
      await saveSettings({ eq: { enabled: true, preamp: p.preamp, bands: [...p.bands], preset: `AI · ${p.name}` }, tune: { auto: false } });
      emit('tune', null);
      toast(`已应用「${p.name}」到均衡器`, 'success');
      m.close();
    } }, mode === 'now' ? '应用到均衡器' : '只用这一条');
    const applyAuto = mode === 'library' ? h('button', { class: 'btn btn-primary', onclick: async () => {
      await saveSettings({ tune: { auto: true, profiles: result.profiles.map(({ key, name, preamp, bands }) => ({ key, name, preamp, bands })) } });
      m.close();
      refreshEq();
      emit('tune', activeProfile());
      toast(`已开启按类型自动调音（${result.profiles.length} 条曲线）`, 'success');
    } }, '按类型自动切换') : null;
    clear(footer, close, applyOne, applyAuto);
  }

  function drawResult() {
    drawFooter();
    if (!result) {
      clear(out, h('div', { class: 'tune-empty' }, icon('eq', 22),
        h('div', {}, 'AI 会根据你的设备特点和歌曲类型推荐均衡器曲线，再给几条设备和系统方面的建议。'),
        h('div', { class: 'ai-note' }, '推荐出来后可以直接试听，并和原来的声音对比，满意了再应用。')));
      return;
    }
    const p = result.profiles[selected];
    const ab = h('div', { class: 'seg' }, [['ai', '听推荐'], ['orig', '听原来的']].map(([k, text]) =>
      h('button', { class: listening === k ? 'active' : '', onclick: (e) => {
        listening = k;
        ab.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
        setPreview();
      } }, text)));
    const cards = result.profiles.map((x, i) => h('div', { class: `tune-card ${i === selected ? 'active' : ''}`, onclick: () => {
      selected = i;
      listening = 'ai';
      drawResult();
      setPreview();
    } }, h('div', { class: 'tune-card-head' }, h('b', {}, x.name), h('span', { class: 'badge' }, x.key)), curveSvg(x.bands)));
    const detail = h('div', { class: 'tune-detail' },
      h('div', { class: 'tune-detail-head' }, h('b', {}, `${p.name}`), h('span', { class: 'badge blue' }, p.key), h('div', { class: 'grow' }), ab),
      h('p', {}, p.why),
      h('div', { class: 'tune-bands' }, EQ_FREQS.map((f, i) => h('div', {}, h('span', { class: `v ${p.bands[i] > 0 ? 'up' : p.bands[i] < 0 ? 'down' : ''}` }, fmtDb(p.bands[i])), h('span', {}, fmtFreq(f)))),
        h('div', { class: 'pre' }, h('span', { class: 'v' }, fmtDb(p.preamp)), h('span', {}, '前级'))));
    clear(out,
      resultMeta?.stale ? h('div', { class: 'ai-note' }, `上次的推荐（${new Date(resultMeta.at).toLocaleString()}${resultMeta.track ? ` ·《${resultMeta.track}》` : ''}${last?.label && last.label !== label ? ` · 当时的设备：${last.label}` : ''}），可以重新推荐。`) : null,
      result.device ? h('div', { class: 'tune-device' }, icon('headphones', 16), h('p', {}, result.device)) : null,
      result.profiles.length > 1 ? h('div', { class: 'tune-cards' }, cards) : null,
      detail,
      result.tips?.length ? h('div', { class: 'tune-tips' }, h('h4', {}, '其他建议'),
        result.tips.map((x) => h('div', { class: 'tune-tip' }, h('b', {}, x.title), h('p', {}, x.detail)))) : null);
  }

  const m = modal({
    title: 'AI 调音',
    width: 680,
    cls: 'tune-modal',
    body: h('div', { class: 'tune' },
      h('div', { class: 'tune-form' },
        h('div', { class: 'tune-field' }, h('label', {}, '播放设备'), h('div', { class: 'search-row' }, typeSel, model), detected),
        h('div', { class: 'tune-field' }, h('label', {}, '调给谁听'), h('div', {}, seg), context),
        h('div', { class: 'tune-field' }, h('label', {}, '偏好'), h('div', { class: 'search-row' }, wish, goBtn))),
      out),
    footer,
    onClose: () => { req?.cancel(); stopPreview(); },
  });
  drawContext();
  drawResult();
}
