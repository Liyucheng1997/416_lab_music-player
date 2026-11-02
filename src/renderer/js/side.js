// 右侧面板：歌词 / AI 赏析 / 播放队列 / 详情
import { h, icon, clear, fmtTime, coverEl } from './dom.js';
import { on, state, uiPref, setUiPref, saveSettings } from './store.js';
import { player, seek, playAt, removeFromQueue, moveInQueue, clearQueue } from './player.js';
import { lyrics, setOffset, loadLyrics } from './lyrics-ctl.js';
import { ai, setLive, runOverview, runTimeline, ask, translate, canTranslate, segProgress, stopAll, hasKey } from './ai-ctl.js';
import { openLyricsSearch, openCoverSearch, openSettings } from './dialogs.js';
import { navigate, albumKey, firstArtist, formatLabel, trackMenu } from './views.js';

const side = document.getElementById('side');
const TABS = [['lyrics', '歌词'], ['ai', 'AI 赏析'], ['queue', '队列'], ['info', '详情']];
let tab = 'lyrics';
const body = h('div', { class: 'side-body' });

export function initSide() {
  tab = uiPref('sideTab', 'lyrics');
  side.hidden = !uiPref('sidePanel', true);
  const seg = h('div', { class: 'seg' }, TABS.map(([k, label]) => h('button', { class: k === tab ? 'active' : '', dataset: { k }, onclick: () => setTab(k) }, label)));
  side.append(h('div', { class: 'side-head' }, seg), body);
  draw();
  on('player:track', () => draw());
  on('lyrics', () => tab === 'lyrics' && draw());
  on('ai', () => tab === 'ai' && draw());
  on('player:queue', () => tab === 'queue' && draw());
  on('track', (t) => tab === 'info' && t?.id === player.track?.id && draw());
  on('library', () => tab === 'info' && draw());
}

export function setTab(k) {
  tab = k;
  setUiPref('sideTab', k);
  side.querySelectorAll('.side-head .seg button').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
  if (side.hidden) toggleSide(true);
  draw();
}

export function toggleSide(force) {
  side.hidden = force != null ? !force : !side.hidden;
  setUiPref('sidePanel', !side.hidden);
}

let cleanup = [];
// AI 面板会随请求进度重绘，保留输入框草稿与滚动位置
const keep = { draft: '', focused: false, scroll: 0, trackId: null };
function draw() {
  cleanup.forEach((f) => f());
  cleanup = [];
  const t = player.track;
  if (!t && tab !== 'queue') {
    return clear(body, h('div', { class: 'lyric-empty' }, icon('disc', 34, { 'stroke-width': 1.4, class: 'ico', style: 'opacity:.6' }), '还没有在播放的歌曲'));
  }
  clear(body, { lyrics: lyricsTab, ai: aiTab, queue: queueTab, info: infoTab }[tab](t));
}

// ---------------- 歌词 ----------------
export function lyricsView({ big = false } = {}) {
  const box = h('div', { class: `lyrics ${lyrics.parsed.synced ? '' : 'plain'}` });
  const lines = lyrics.parsed.lines;
  const els = lines.map((l) => h('div', {
    class: `lyric-line ${l.text ? '' : 'gap'}`,
    onclick: () => { if (lyrics.parsed.synced) seek(l.time - lyrics.offset + 0.05); },
  }, l.text || '·', l.trans ? h('span', { class: 'tr' }, l.trans) : null));
  box.append(...els);
  let userScroll = 0;
  box.addEventListener('wheel', () => { userScroll = Date.now(); }, { passive: true });
  const highlight = (i, smooth = true) => {
    box.querySelector('.cur')?.classList.remove('cur');
    const el = els[i];
    if (!el) return;
    el.classList.add('cur');
    // 用户刚滚过就先不抢滚动
    if (Date.now() - userScroll < 3500) return;
    const top = el.offsetTop - box.clientHeight * (big ? 0.38 : 0.36) + el.offsetHeight / 2;
    box.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  };
  const off = on('lyrics:line', (i) => highlight(i));
  setTimeout(() => highlight(lyrics.index, false));
  return { el: box, destroy: off };
}

function lyricsTab(t) {
  if (lyrics.loading) return h('div', { class: 'lyric-empty' }, h('div', { class: 'spinner' }), '正在查找歌词');
  const offsetLabel = h('span', { class: 'offset' }, fmtOffset(lyrics.offset));
  cleanup.push(on('lyrics:offset', (v) => { offsetLabel.textContent = fmtOffset(v); }));
  const trBtn = canTranslate() ? h('button', { class: 'icon-btn', title: 'AI 翻译歌词', onclick: translate }, icon('translate', 15)) : null;
  cleanup.push(on('ai:translate', (s) => { if (trBtn) trBtn.disabled = s.status === 'loading'; }));
  const dl = state.settings.desktopLyrics;
  const tools = h('div', { class: 'side-tools' },
    h('span', { class: 'grow' }, lyrics.source ? `来源：${lyrics.source}` : ''),
    lyrics.parsed.synced ? [
      h('button', { class: 'icon-btn', title: '歌词慢 0.5 秒', onclick: () => setOffset(-0.5) }, '−'),
      offsetLabel,
      h('button', { class: 'icon-btn', title: '歌词快 0.5 秒', onclick: () => setOffset(0.5) }, '+'),
    ] : null,
    trBtn,
    h('button', { class: `icon-btn ${dl.enabled ? 'on' : ''}`, title: '桌面歌词', onclick: () => saveSettings({ desktopLyrics: { enabled: !state.settings.desktopLyrics.enabled } }).then(draw) }, icon('captions', 15)),
    h('button', { class: 'icon-btn', title: '查找歌词', onclick: () => openLyricsSearch(t) }, icon('search', 15)));
  if (lyrics.instrumental) return [tools, h('div', { class: 'lyric-empty' }, icon('wave', 30, { 'stroke-width': 1.4 }), '纯音乐，请欣赏')];
  if (!lyrics.parsed.lines.length) {
    if (lyrics.error) {
      return [tools, h('div', { class: 'lyric-empty' }, icon('mic', 30, { 'stroke-width': 1.4, style: 'opacity:.6' }), `在线歌词暂时取不到（${lyrics.error}）`,
        h('button', { class: 'btn btn-sm', onclick: () => loadLyrics(t) }, icon('refresh', 14), '重试'))];
    }
    return [tools, h('div', { class: 'lyric-empty' }, icon('mic', 30, { 'stroke-width': 1.4, style: 'opacity:.6' }), '没有找到歌词',
      h('button', { class: 'btn btn-sm', onclick: () => openLyricsSearch(t) }, icon('search', 14), '在线搜索'))];
  }
  const v = lyricsView();
  cleanup.push(v.destroy);
  return [tools, v.el];
}

const fmtOffset = (v) => (v ? `${v > 0 ? '+' : ''}${v.toFixed(1)}s` : '0.0s');

// ---------------- AI 赏析 ----------------
export function renderMarkdown(text, streaming = false) {
  const root = h('div', { class: 'md' });
  let list = null;
  const inline = (s) => {
    const frag = document.createDocumentFragment();
    s.split(/(\*\*[^*]+\*\*)/g).forEach((part) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) frag.append(h('strong', {}, part.slice(2, -2)));
      else if (part) frag.append(part);
    });
    return frag;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/^#{1,4}\s/.test(line)) { list = null; root.append(h('h3', {}, inline(line.replace(/^#+\s*/, '')))); continue; }
    if (/^\s*[-*•]\s+/.test(line)) {
      if (!list) { list = h('ul'); root.append(list); }
      list.append(h('li', {}, inline(line.replace(/^\s*[-*•]\s+/, ''))));
      continue;
    }
    list = null;
    if (line.trim()) root.append(h('p', {}, inline(line)));
  }
  if (streaming) (root.lastElementChild?.tagName === 'UL' ? root.lastElementChild.lastElementChild : root.lastElementChild || root).append(h('span', { class: 'caret' }));
  return root;
}

function aiTab(t) {
  const sw = h('button', { class: `switch ${ai.live ? 'on' : ''}`, onclick: () => setLive(!ai.live) });
  const head = h('div', { class: 'ai-switch' }, h('div', { class: 'grow' }, h('b', {}, '实时赏析'), h('small', {}, ai.live ? '跟着歌曲进度，逐段解读' : '打开后，AI 会陪你边听边读这首歌')), sw);
  const scroll = h('div', { class: 'ai-scroll' }, head);

  if (!hasKey()) {
    scroll.append(h('div', { class: 'ai-card' },
      h('div', { class: 'md' }, h('p', {}, 'AI 赏析使用 Claude。填写 API Key 后，听歌时可以看到创作背景、歌词意象、编曲亮点的逐段解读，还能随时追问。')),
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => openSettings('ai') }, '去设置 API Key')));
    return h('div', { class: 'ai' }, scroll);
  }

  // 当前段落（实时）
  const live = h('div');
  const drawLive = () => {
    const s = ai.timeline.segments[ai.seg];
    if (!s) return clear(live);
    const bar = h('i', { style: { width: `${segProgress() * 100}%` } });
    clear(live, h('div', { class: 'ai-live' },
      h('div', { class: 'label' }, h('span', { class: 'dot' }), `正在听 · ${fmtTime(s.start)}`),
      h('h4', {}, s.title), h('p', {}, s.note), h('div', { class: 'seg-progress' }, bar)));
    live._bar = bar;
  };
  drawLive();
  cleanup.push(on('ai:seg', () => { drawLive(); drawSegs(); }));
  cleanup.push(on('player:time', () => { if (live._bar) live._bar.style.width = `${segProgress() * 100}%`; }));
  scroll.append(live);

  // 段落列表
  const segBox = h('div', { class: 'seg-list' });
  const drawSegs = () => clear(segBox, ai.timeline.segments.map((s, i) => h('div', {
    class: `seg-item ${i === ai.seg ? 'cur' : ''}`,
    onclick: (e) => { if (e.detail === 2) seek(s.start); else e.currentTarget.classList.toggle('open'); },
    title: '单击展开，双击跳到这一段',
  }, h('time', {}, fmtTime(s.start)), h('div', {}, h('b', {}, s.title), h('p', {}, s.note)))));
  drawSegs();
  const tl = ai.timeline;
  scroll.append(h('div', { class: 'ai-section' },
    h('div', { class: 'ai-section-head' }, icon('queue', 14), h('span', { class: 'grow' }, '逐段解读'),
      tl.status === 'loading' ? h('div', { class: 'spinner', style: { width: '16px', height: '16px', borderWidth: '2px' } }) : null,
      h('button', { class: 'icon-btn', title: tl.status === 'done' ? '重新生成' : '生成', disabled: tl.status === 'loading', onclick: runTimeline }, icon(tl.status === 'done' ? 'refresh' : 'sparkles', 14))),
    tl.status === 'loading' ? h('div', { class: 'ai-note' }, '正在把这首歌拆成段落……') : null,
    tl.status === 'error' ? h('div', { class: 'ai-error' }, tl.error) : null,
    tl.status === 'idle' && !ai.live ? h('div', { class: 'ai-note' }, '打开「实时赏析」或点右上角的星星，生成随进度推进的逐段解读。') : null,
    segBox));

  // 整体赏析（流式）
  const ov = ai.overview;
  const ovBody = h('div', {});
  const drawOv = () => clear(ovBody,
    ov.status === 'error' ? h('div', { class: 'ai-error' }, ov.error)
      : ov.text ? renderMarkdown(ov.text, ov.status === 'loading')
        : ov.status === 'loading' ? h('div', { class: 'ai-note' }, '正在写赏析……')
          : h('div', { class: 'ai-note' }, '还没有生成整体赏析。'));
  drawOv();
  cleanup.push(on('ai:overview', drawOv));
  scroll.append(h('div', { class: 'ai-section' },
    h('div', { class: 'ai-section-head' }, icon('sparkles', 14), h('span', { class: 'grow' }, '整体赏析'),
      ov.status === 'loading' ? h('button', { class: 'icon-btn', title: '停止', onclick: stopAll }, icon('stop', 13)) : h('button', { class: 'icon-btn', title: ov.status === 'done' ? '重新生成' : '生成', onclick: runOverview }, icon(ov.status === 'done' ? 'refresh' : 'sparkles', 14))),
    h('div', { class: 'ai-card' }, ovBody)));

  // 追问
  const chatBox = h('div', { class: 'chat' });
  const drawChat = () => {
    clear(chatBox, ai.chat.history.map((m) => h('div', { class: `bubble ${m.role}` }, m.content || '…')));
    if (ai.chat.status === 'error') chatBox.append(h('div', { class: 'ai-error' }, ai.chat.error));
    scroll.scrollTop = scroll.scrollHeight;
  };
  drawChat();
  cleanup.push(on('ai:chat', drawChat));
  const asks = ['这首歌想表达什么？', '副歌为什么动人？', '推荐几首风格相近的歌'];
  scroll.append(h('div', { class: 'ai-section' },
    h('div', { class: 'ai-section-head' }, icon('send', 14), h('span', { class: 'grow' }, '追问')),
    ai.chat.history.length ? null : h('div', { class: 'quick-asks' }, asks.map((q) => h('button', { class: 'chip', onclick: () => ask(q) }, q))),
    chatBox));

  if (keep.trackId !== t.id) Object.assign(keep, { trackId: t.id, scroll: 0, draft: '' });
  const input = h('input', {
    class: 'input',
    placeholder: '问问这首歌…',
    value: keep.draft,
    oninput: (e) => { keep.draft = e.target.value; },
    onfocus: () => { keep.focused = true; },
    onblur: () => { keep.focused = false; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); },
  });
  scroll.addEventListener('scroll', () => { keep.scroll = scroll.scrollTop; }, { passive: true });
  requestAnimationFrame(() => {
    scroll.scrollTop = keep.scroll;
    if (keep.focused) input.focus();
  });
  const send = h('button', { class: 'send', title: '发送', disabled: ai.chat.status === 'loading', onclick: () => submit() }, icon('send', 15));
  function submit() {
    const q = input.value.trim();
    if (!q || ai.chat.status === 'loading') return;
    input.value = '';
    keep.draft = '';
    keep.scroll = 1e9;
    ask(q);
  }
  return h('div', { class: 'ai' }, scroll, h('div', { class: 'chat-input' }, input, send));
}

// ---------------- 队列 ----------------
function queueTab() {
  const box = h('div', { class: 'queue' });
  const q = player.queue;
  if (!q.length) return h('div', { class: 'lyric-empty' }, icon('queue', 30, { 'stroke-width': 1.4 }), '播放队列是空的');
  const tools = h('div', { class: 'side-tools' }, h('span', { class: 'grow' }, `${q.length} 首 · ${player.shuffle ? '随机' : '顺序'}播放`),
    h('button', { class: 'btn btn-sm btn-ghost', onclick: clearQueue }, '清空'));
  let dragFrom = -1;
  const rowFor = (id, i) => {
    const t = state.byId.get(id);
    if (!t) return null;
    const row = h('div', {
      class: `q-row ${i === player.index ? 'cur' : ''}`,
      draggable: 'true',
      ondblclick: () => playAt(i),
      oncontextmenu: (e) => { e.preventDefault(); trackMenu([id], e.clientX, e.clientY); },
      ondragstart: (e) => { dragFrom = i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; },
      ondragend: () => row.classList.remove('dragging'),
      ondragover: (e) => { e.preventDefault(); row.classList.add('over'); },
      ondragleave: () => row.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); row.classList.remove('over'); if (dragFrom >= 0 && dragFrom !== i) moveInQueue(dragFrom, i); },
    }, coverEl(t.coverId), h('div', { class: 'grow' }, h('div', { class: 'q-title' }, t.title), h('div', { class: 'q-sub' }, `${t.artist} · ${fmtTime(t.duration)}`)),
    i === player.index ? null : h('button', { class: 'icon-btn', title: '移出队列', onclick: (e) => { e.stopPropagation(); removeFromQueue(i); } }, icon('x', 14)));
    return row;
  };
  // 只渲染当前曲目前 20 首到后 200 首，长队列也不卡
  const from = Math.max(0, player.index - 20);
  const to = Math.min(q.length, player.index + 200);
  if (from > 0) box.append(h('div', { class: 'q-label' }, `前面还有 ${from} 首`));
  for (let i = from; i < to; i++) {
    if (i === player.index + 1) box.append(h('div', { class: 'q-label' }, '接下来'));
    box.append(rowFor(q[i], i));
  }
  if (to < q.length) box.append(h('div', { class: 'q-label' }, `还有 ${q.length - to} 首`));
  requestAnimationFrame(() => box.querySelector('.cur')?.scrollIntoView({ block: 'center' }));
  return [tools, box];
}

// ---------------- 详情 ----------------
function infoTab(t) {
  const artistBox = h('div');
  const name = firstArtist(t.artist);
  window.api.invoke('artist:image', name).then((url) => {
    const av = coverEl(null);
    if (url) av.append(h('img', { src: url }));
    else av.replaceChildren(h('span', { class: 'avatar-initial', style: { fontSize: '20px' } }, [...name][0] || '?'));
    clear(artistBox, h('div', { class: 'artist-card link', onclick: () => navigate('artist', name) }, av,
      h('div', {}, h('div', { class: 'q-title' }, name), h('div', { class: 'q-sub' }, `资料库里有 ${state.tracks.filter((x) => (x.artist || '').includes(name)).length} 首`))));
  });
  const rows = [
    ['专辑', t.album], ['歌手', t.artist], ['专辑歌手', t.albumArtist !== t.artist ? t.albumArtist : ''], ['年份', t.year], ['流派', t.genre],
    ['作曲', t.composer], ['音轨', t.trackNo ? `${t.discNo ? `${t.discNo}-` : ''}${t.trackNo}` : ''], ['时长', fmtTime(t.duration)],
    ['格式', `${formatLabel(t)}${t.codec ? `（${t.codec}）` : ''}`], ['采样', t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz${t.bitsPerSample ? ` / ${t.bitsPerSample} bit` : ''}` : ''],
    ['码率', t.bitrate ? `${t.bitrate} kbps` : ''], ['大小', `${(t.size / 1048576).toFixed(1)} MB`], ['播放', `${t.playCount || 0} 次`], ['位置', t.path],
  ].filter(([, v]) => v);
  return h('div', { class: 'info' },
    coverEl(t.coverId, { small: false }),
    h('h3', {}, t.title),
    h('div', { class: 'artist link', onclick: () => t.album && navigate('album', albumKey(t)) }, t.album || t.artist),
    h('div', { class: 'info-actions' },
      h('button', { class: 'btn btn-sm', onclick: () => openCoverSearch(t) }, icon('image', 14), '查找封面'),
      h('button', { class: 'btn btn-sm', onclick: () => openLyricsSearch(t) }, icon('mic', 14), '查找歌词'),
      h('button', { class: 'btn btn-sm', onclick: () => window.api.invoke('lib:reveal', t.id) }, icon('folderOpen', 14), '打开位置')),
    artistBox,
    h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])));
}
