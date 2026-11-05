// 为你推荐：按听歌习惯和资料库出推荐列表（猜你喜欢 / 此刻 / 发掘 / 重温），也可以让 AI 从里面挑一张歌单
import { h, icon, clear } from './dom.js';
import { state, emit, uiPref, setUiPref } from './store.js';
import { toast, promptBox } from './ui.js';
import { requestDetached, hasKey } from './ai-ctl.js';
import { openSettings } from './dialogs.js';
import { navigate, render, songTable, pageHead, playButtons, summary, tagKey } from './views.js';

const MODES = [
  ['mix', '猜你喜欢'],
  ['now', '此刻'],
  ['discover', '发掘新歌'],
  ['rewind', '重温'],
  ['ai', 'AI 精选'],
];
const HINT = {
  mix: '按你的口味挑的，也混了些没怎么听过的',
  now: '',
  discover: '库里还没听过、但和你口味相近的歌',
  rewind: '你喜欢过、但有一阵子没听的歌',
};
const BASIS = {
  collection: '听歌记录还少，目前主要按你收藏的歌来推荐；多听、多点喜欢，会越来越准',
  mixed: '结合了你的听歌记录和收藏',
  listening: '主要按你的听歌记录推荐',
};

// 每种推荐只在首次打开或「换一批」时重新算，来回切换不打乱
const cache = {};
let aiJob = null;

async function load(mode, { fresh = false } = {}) {
  if (mode === 'ai') {
    if (!('ai' in cache)) cache.ai = await window.api.invoke('rec:ai');
    return cache.ai;
  }
  if (cache[mode] && !fresh) return cache[mode];
  const exclude = fresh ? (cache[mode]?.items || []).map((x) => x.id) : [];
  cache[mode] = await window.api.invoke('rec:list', mode, { limit: 40, exclude, seed: Date.now() });
  cache.profile = cache[mode].profile;
  return cache[mode];
}

export function recommendView() {
  let mode = uiPref('recMode', 'mix');
  if (!MODES.some(([k]) => k === mode)) mode = 'mix';
  const head = h('div');
  const taste = h('div', { class: 'rec-taste' });
  const seg = h('div', { class: 'seg' }, MODES.map(([k, label]) =>
    h('button', { class: mode === k ? 'active' : '', onclick: () => { setUiPref('recMode', k); render(); } }, label)));
  const extra = h('div');
  const body = h('div', { class: 'rec-body' }, h('div', { class: 'empty' }, h('div', { class: 'spinner' })));
  const page = h('div', { class: 'page' }, head, h('div', { class: 'rec-bar' }, seg, taste), extra, body);
  const alive = () => page.isConnected && state.view.name === 'foryou';

  const drawHead = (ids, sub, actions = []) => clear(head, pageHead({
    eyebrow: 'For You',
    title: '为你推荐',
    sub,
    actions: [...actions, ids.length ? saveBtn(ids) : null, ...(ids.length ? playButtons(() => ids) : [])],
  }));

  const drawTable = (ids, reasons, emptyText) => {
    const tracks = ids.map((id) => state.byId.get(id)).filter(Boolean);
    clear(body, songTable(tracks, { sub: (t) => reasons.get(t.id) || '', emptyText }).el);
    return tracks;
  };

  if (mode === 'ai') {
    drawAi({ head: drawHead, extra, body, drawTable, alive });
  } else {
    const show = async (fresh) => {
      const r = await load(mode, { fresh });
      if (!alive()) return;
      drawTaste(taste, r.profile);
      const ids = r.items.map((x) => x.id);
      const tracks = drawTable(ids, new Map(r.items.map((x) => [x.id, x.reason])),
        mode === 'rewind' ? '还没有「喜欢过、但很久没听」的歌。多听一阵子，或者点几首喜欢，这里就会有了' : '没有可推荐的歌');
      const hint = mode === 'now' ? `适合${r.slot.label}听的歌${r.habit ? '，参考了你平时这个时段常听的' : ''}` : HINT[mode];
      const sub = tracks.length ? `${summary(tracks)} · ${hint}` : hint;
      drawHead(ids, sub, [h('button', { class: 'btn', title: '换一批（不和这一批重复）', onclick: () => show(true) }, icon('refresh', 15), '换一批')]);
    };
    drawHead([], '');
    show(false).catch((e) => clear(body, h('div', { class: 'empty' }, `推荐失败：${e.message}`)));
  }
  if (cache.profile) drawTaste(taste, cache.profile);
  else if (mode === 'ai') load('mix').then((r) => alive() && drawTaste(taste, r.profile));
  return page;
}

// 口味画像：点风格 / 情绪去对应的 AI 分类，点歌手去歌手页
function drawTaste(box, p) {
  if (!p) return;
  const chip = (label, onclick) => h('button', { class: 'chip', onclick }, label);
  const tags = [
    ...p.top.style.slice(0, 3).map((v) => chip(v, () => navigate('aitag', tagKey('style', v)))),
    ...p.top.lang.slice(0, 2).map((v) => chip(v, () => navigate('aitag', tagKey('lang', v)))),
    ...p.top.mood.slice(0, 2).map((v) => chip(v, () => navigate('aitag', tagKey('mood', v)))),
    ...p.top.artist.slice(0, 3).map((v) => chip(v, () => navigate('artist', v))),
  ];
  clear(box, h('span', { class: 'rec-taste-label', title: BASIS[p.basis] }, '你的口味', p.basis === 'collection' ? icon('sparkles', 12) : null), tags);
  box.title = BASIS[p.basis];
}

function saveBtn(ids) {
  return h('button', { class: 'btn', title: '把这批歌存成歌单', onclick: async () => {
    const d = new Date();
    const name = await promptBox({ title: '保存为歌单', value: cache.ai && uiPref('recMode') === 'ai' ? cache.ai.title : `为你推荐 ${d.getMonth() + 1}月${d.getDate()}日` });
    if (!name) return;
    const pl = await window.api.invoke('pl:create', name, ids);
    state.playlists.push(pl);
    emit('playlists');
    toast(`已保存为歌单「${name}」，共 ${ids.length} 首`, 'success');
  } }, icon('listPlus', 15), '存为歌单');
}

// ---------------- AI 精选 ----------------
function drawAi({ head, extra, body, drawTable, alive }) {
  const wish = h('input', { class: 'input', placeholder: '想听点什么（可不填）：比如 下雨天、开车提神、老歌、别太吵', value: uiPref('recWish', '') });
  const go = h('button', { class: 'btn btn-primary' }, icon('sparkles', 15), '让 AI 挑一张');
  const form = h('div', { class: 'rec-ai-form' }, wish, go);
  const intro = h('div');
  clear(extra, h('div', { class: 'rec-ai' }, form, intro));

  const showResult = (r) => {
    if (!r) {
      head([], 'AI 会根据你的口味，从你的资料库里挑一张有起伏、有新鲜感的歌单，并说明每首为什么选');
      clear(intro);
      clear(body, h('div', { class: 'empty' }, icon('sparkles', 34, { 'stroke-width': 1.4 }), '写下想听什么（也可以不写），点「让 AI 挑一张」'));
      return;
    }
    const tracks = drawTable(r.items.map((x) => x.id), new Map(r.items.map((x) => [x.id, x.why])), '歌单里的歌已经不在资料库了');
    const ids = tracks.map((t) => t.id);
    head(ids, `${summary(tracks)} · ${new Date(r.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 生成${r.wish ? ` · 「${r.wish}」` : ''}`);
    clear(intro, h('div', { class: 'rec-intro' }, icon('sparkles', 16, { class: 'ico' }), h('div', {}, h('b', {}, r.title), h('p', {}, r.intro))));
  };

  const busy = (on) => {
    go.disabled = on;
    wish.disabled = on;
    if (on) {
      clear(body, h('div', { class: 'tune-loading rec-loading' }, h('div', { class: 'spinner' }), 'AI 正在翻你的资料库挑歌，通常要半分钟左右…',
        h('button', { class: 'btn btn-sm', onclick: () => aiJob?.cancel() }, icon('stop', 13), '停止')));
    }
  };

  const run = async () => {
    if (!hasKey()) {
      clear(body, h('div', { class: 'empty' }, '还没有配置 Claude API Key，AI 精选需要用它。',
        h('button', { class: 'btn btn-sm', onclick: () => openSettings('ai') }, '去设置')));
      return;
    }
    const w = wish.value.trim();
    setUiPref('recWish', w);
    busy(true);
    aiJob = requestDetached('recommend', { wish: w });
    try {
      cache.ai = await aiJob.promise;
      if (alive()) showResult(cache.ai);
    } catch (e) {
      if (alive()) {
        showResult(cache.ai);
        if (e.message !== '已停止') toast(`AI 精选失败：${e.message}`, 'error');
      }
    } finally {
      aiJob = null;
      if (alive()) busy(false);
    }
  };
  go.onclick = run;
  wish.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  if (aiJob) {
    busy(true);
    aiJob.promise.then(() => alive() && render(), () => alive() && render());
  } else {
    load('ai').then((r) => alive() && showResult(r));
  }
}
