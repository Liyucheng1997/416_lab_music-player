// DOM 小工具：h() 建元素、icon() 取 lucide 图标、格式化函数
import createElement from '../lucide/createElement.mjs';
import Play from '../lucide/icons/play.mjs';
import Pause from '../lucide/icons/pause.mjs';
import SkipBack from '../lucide/icons/skip-back.mjs';
import SkipForward from '../lucide/icons/skip-forward.mjs';
import Shuffle from '../lucide/icons/shuffle.mjs';
import Repeat from '../lucide/icons/repeat.mjs';
import Repeat1 from '../lucide/icons/repeat-1.mjs';
import Volume2 from '../lucide/icons/volume-2.mjs';
import Volume1 from '../lucide/icons/volume-1.mjs';
import VolumeX from '../lucide/icons/volume-x.mjs';
import Heart from '../lucide/icons/heart.mjs';
import ListMusic from '../lucide/icons/list-music.mjs';
import Disc3 from '../lucide/icons/disc-3.mjs';
import DiscAlbum from '../lucide/icons/disc-album.mjs';
import MicVocal from '../lucide/icons/mic-vocal.mjs';
import Tag from '../lucide/icons/tag.mjs';
import Folder from '../lucide/icons/folder.mjs';
import FolderOpen from '../lucide/icons/folder-open.mjs';
import Clock from '../lucide/icons/clock.mjs';
import Star from '../lucide/icons/star.mjs';
import Search from '../lucide/icons/search.mjs';
import Plus from '../lucide/icons/plus.mjs';
import Settings from '../lucide/icons/settings.mjs';
import Moon from '../lucide/icons/moon.mjs';
import Sun from '../lucide/icons/sun.mjs';
import Sparkles from '../lucide/icons/sparkles.mjs';
import X from '../lucide/icons/x.mjs';
import Ellipsis from '../lucide/icons/ellipsis.mjs';
import Sliders from '../lucide/icons/sliders-horizontal.mjs';
import Refresh from '../lucide/icons/refresh-cw.mjs';
import ImageIcon from '../lucide/icons/image.mjs';
import User from '../lucide/icons/user.mjs';
import ChevronDown from '../lucide/icons/chevron-down.mjs';
import ChevronRight from '../lucide/icons/chevron-right.mjs';
import ChevronLeft from '../lucide/icons/chevron-left.mjs';
import ListPlus from '../lucide/icons/list-plus.mjs';
import Trash from '../lucide/icons/trash.mjs';
import Lock from '../lucide/icons/lock.mjs';
import LockOpen from '../lucide/icons/lock-open.mjs';
import Captions from '../lucide/icons/captions.mjs';
import Maximize from '../lucide/icons/maximize-2.mjs';
import Minimize from '../lucide/icons/minimize-2.mjs';
import Send from '../lucide/icons/send.mjs';
import Square from '../lucide/icons/square.mjs';
import Recent from '../lucide/icons/rotate-ccw-clock.mjs';
import Trending from '../lucide/icons/trending-up.mjs';
import ListOrdered from '../lucide/icons/list-ordered.mjs';
import Languages from '../lucide/icons/languages.mjs';
import Pencil from '../lucide/icons/pencil.mjs';
import Download from '../lucide/icons/download.mjs';
import Upload from '../lucide/icons/upload.mjs';
import Monitor from '../lucide/icons/monitor.mjs';
import AudioLines from '../lucide/icons/audio-lines.mjs';
import ArrowUpDown from '../lucide/icons/arrow-up-down.mjs';
import FileMusic from '../lucide/icons/file-music.mjs';
import Library from '../lucide/icons/square-library.mjs';
import Type from '../lucide/icons/type.mjs';
import Wand from '../lucide/icons/wand-sparkles.mjs';
import Calendar from '../lucide/icons/calendar.mjs';
import Bot from '../lucide/icons/bot.mjs';

const ICONS = {
  play: Play, pause: Pause, prev: SkipBack, next: SkipForward, shuffle: Shuffle, repeat: Repeat, repeat1: Repeat1,
  volume: Volume2, volumeLow: Volume1, mute: VolumeX, heart: Heart, playlist: ListMusic, disc: Disc3, album: DiscAlbum,
  mic: MicVocal, tag: Tag, folder: Folder, folderOpen: FolderOpen, clock: Clock, star: Star, search: Search, plus: Plus,
  settings: Settings, moon: Moon, sun: Sun, sparkles: Sparkles, x: X, more: Ellipsis, eq: Sliders, refresh: Refresh,
  image: ImageIcon, user: User, down: ChevronDown, right: ChevronRight, left: ChevronLeft, listPlus: ListPlus, trash: Trash,
  lock: Lock, unlock: LockOpen, captions: Captions, expand: Maximize, collapse: Minimize, send: Send, stop: Square,
  recent: Recent, trending: Trending, queue: ListOrdered, translate: Languages, edit: Pencil, download: Download,
  upload: Upload, monitor: Monitor, wave: AudioLines, sort: ArrowUpDown, file: FileMusic, library: Library, type: Type,
  wand: Wand, calendar: Calendar, bot: Bot,
};

export function icon(name, size = 18, extra = {}) {
  const node = ICONS[name];
  if (!node) throw new Error(`unknown icon ${name}`);
  const el = createElement(node, { width: size, height: size, 'stroke-width': 1.75, class: 'ico', ...extra });
  return el;
}

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function fmtTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtTotal(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const coverUrl = (id, small = true) => (id ? `media://cover/${id}${small ? '_s' : ''}` : '');

// 没有封面时：灰底 + 唱片图标
export function coverEl(id, { small = true, cls = '' } = {}) {
  const box = h('div', { class: `cover ${cls}` });
  if (id) box.append(h('img', { src: coverUrl(id, small), loading: 'lazy', decoding: 'async', draggable: 'false', onerror: (e) => e.target.remove() }));
  else box.append(icon('disc', 28, { class: 'ico cover-ph' }));
  return box;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// 拼音/大小写无关的排序
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
export const compare = (a, b) => collator.compare(a || '', b || '');
