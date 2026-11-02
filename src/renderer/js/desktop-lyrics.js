// 桌面歌词窗口：接收主界面推送的当前行，本地 rAF 补间画出逐字填色进度
import createElement from '../lucide/createElement.mjs';
import Play from '../lucide/icons/play.mjs';
import Pause from '../lucide/icons/pause.mjs';
import SkipBack from '../lucide/icons/skip-back.mjs';
import SkipForward from '../lucide/icons/skip-forward.mjs';
import Lock from '../lucide/icons/lock.mjs';
import LockOpen from '../lucide/icons/lock-open.mjs';
import X from '../lucide/icons/x.mjs';
import Languages from '../lucide/icons/languages.mjs';
import Palette from '../lucide/icons/palette.mjs';
import AppWindow from '../lucide/icons/app-window.mjs';

const ico = (node, size = 16) => createElement(node, { width: size, height: size, 'stroke-width': 2 });
const $ = (id) => document.getElementById(id);
const main = $('main');
const base = main.querySelector('.base');
const sung = main.querySelector('.sung');
const sub = $('sub');
const bar = $('bar');

let st = { text: '', trans: '', next: '', title: '听音', start: 0, end: 0, synced: false, playing: false, t: 0, at: Date.now() };
let style = { showTrans: true, locked: false, fontSize: 34, color: 'blue' };

const btn = (title, child, cmd, cls = '') => {
  const b = document.createElement('button');
  b.title = title;
  b.className = cls;
  if (typeof child === 'string') b.textContent = child; else b.append(child);
  b.onclick = (e) => { e.stopPropagation(); window.api.send('dl:command', cmd); };
  return b;
};
const sep = () => Object.assign(document.createElement('span'), { className: 'sep' });
const playBtn = btn('播放 / 暂停', ico(Play), 'toggle');
const transBtn = btn('显示翻译', ico(Languages), 'trans');
bar.append(
  btn('上一首', ico(SkipBack), 'prev'), playBtn, btn('下一首', ico(SkipForward), 'next'), sep(),
  btn('缩小字号', 'A−', 'smaller'), btn('放大字号', 'A+', 'bigger'), btn('切换颜色', ico(Palette), 'color'), transBtn, sep(),
  btn('锁定（鼠标穿透）', ico(Lock), 'lock'), btn('打开主窗口', ico(AppWindow), 'main'), btn('关闭桌面歌词', ico(X), 'close'),
);
$('unlock').append(ico(LockOpen));
$('unlock').onclick = () => window.api.send('dl:command', 'unlock');

// 锁定时窗口忽略鼠标，但仍能收到 mousemove：移到解锁按钮附近时临时恢复点击
document.addEventListener('mousemove', (e) => {
  if (!style.locked) return;
  document.body.classList.add('hover');
  const r = $('unlock').getBoundingClientRect();
  const over = e.clientX > r.left - 6 && e.clientX < r.right + 6 && e.clientY > r.top - 6 && e.clientY < r.bottom + 6;
  window.api.send('dl:hover', over);
});
document.addEventListener('mouseleave', () => {
  document.body.classList.remove('hover');
  if (style.locked) window.api.send('dl:hover', false);
});

function applyStyle() {
  document.body.classList.toggle('locked', !!style.locked);
  document.body.dataset.color = style.color || 'blue';
  document.documentElement.style.setProperty('--size', `${style.fontSize || 34}px`);
  transBtn.classList.toggle('on', !!style.showTrans);
  drawText();
}

let lastText = null;
function drawText() {
  const text = st.text || (st.synced ? '' : st.title) || st.title;
  if (text !== lastText) {
    base.textContent = text;
    sung.textContent = text;
    main.classList.remove('fade');
    void main.offsetWidth;
    main.classList.add('fade');
    lastText = text;
  }
  sub.textContent = style.showTrans && st.trans ? st.trans : st.synced ? st.next : '';
  playBtn.replaceChildren(ico(st.playing ? Pause : Play));
}

window.api.on('dl:update', (p) => {
  if (p.full) st = { ...st, ...p };
  else Object.assign(st, { t: p.t, at: p.at, playing: p.playing });
  if (p.full) drawText();
  else if (playBtn.dataset.playing !== String(st.playing)) { playBtn.dataset.playing = String(st.playing); playBtn.replaceChildren(ico(st.playing ? Pause : Play)); }
});
window.api.on('dl:style', (s) => { style = s; applyStyle(); });

// 逐字填色：一行的填充时长不超过「字数 × 0.45 秒」，长间奏不会拖得很慢
function frame() {
  requestAnimationFrame(frame);
  if (!st.synced || !st.text) { sung.style.clipPath = 'inset(0 100% 0 0)'; return; }
  const now = st.t + (st.playing ? (Date.now() - st.at) / 1000 : 0);
  const span = Math.min(Math.max(0.5, st.end - st.start), Math.max(1.6, [...st.text].length * 0.45));
  const p = Math.max(0, Math.min(1, (now - st.start) / span));
  sung.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
}
requestAnimationFrame(frame);
applyStyle();
window.api.send('dl:ready');
