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

// 窗口平时忽略鼠标（点击穿透到下面的窗口），但仍能收到 mousemove。
// 只有鼠标在「歌词文字」上时才接收点击并显示底板和工具条；底板显示后整块底板都算。
// 锁定时只有解锁按钮能点。
const frameEl = $('frame');
let mouse = null;
let over = null;
let dragging = false;
const inside = (el, pad) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && mouse.x > r.left - pad && mouse.x < r.right + pad && mouse.y > r.top - pad && mouse.y < r.bottom + pad;
};
function updateHover(force = false) {
  if (!mouse) return;
  const body = document.body;
  let hit;
  if (style.locked) {
    body.classList.add('hover');
    hit = inside($('unlock'), 6);
  } else {
    hit = dragging || (body.classList.contains('hover') ? inside(frameEl, 0) : inside(main, 8) || inside(sub, 8));
    body.classList.toggle('hover', hit);
  }
  if (hit !== over || force) { over = hit; window.api.send('dl:hover', hit); }
}
document.addEventListener('mousemove', (e) => { mouse = { x: e.clientX, y: e.clientY }; updateHover(); if (dragging) window.api.send('dl:drag', 'move'); });
document.addEventListener('mouseleave', () => {
  if (dragging) return;
  mouse = null;
  document.body.classList.remove('hover');
  if (over !== false) { over = false; window.api.send('dl:hover', false); }
});

// 拖动底板移动窗口（不用 -webkit-app-region，那样拖动区域收不到鼠标事件，没法判断鼠标离开）
frameEl.addEventListener('pointerdown', (e) => {
  if (style.locked || e.button !== 0 || e.target.closest('button')) return;
  dragging = true;
  frameEl.setPointerCapture(e.pointerId);
  document.body.classList.add('dragging');
  window.api.send('dl:drag', 'start');
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  window.api.send('dl:drag', 'end');
  updateHover();
};
frameEl.addEventListener('pointerup', endDrag);
frameEl.addEventListener('pointercancel', endDrag);

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
// 样式变了（锁定 / 字号）命中区域也跟着变，重新告诉主进程
window.api.on('dl:style', (s) => { style = s; applyStyle(); updateHover(true); });

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
