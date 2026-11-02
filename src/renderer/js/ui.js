// 通用弹层：提示、对话框、确认框、输入框、右键菜单
import { h, icon } from './dom.js';

let toastHost;
export function toast(msg, type = '') {
  toastHost ||= document.body.appendChild(h('div', { class: 'toast-host' }));
  const el = h('div', { class: `toast ${type ? `toast-${type}` : ''}` }, msg);
  toastHost.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, type === 'error' ? 4200 : 2400);
}

export function modal({ title, body, footer, width = 520, onClose, cls = '' }) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const box = h('div', { class: `modal ${cls}`, style: { width: `${width}px` } },
    h('div', { class: 'modal-header' }, h('span', {}, title), h('button', { class: 'modal-x', onclick: close, title: '关闭' }, icon('x', 16))),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-footer' }, footer) : null,
  );
  const overlay = h('div', { class: 'modal-overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  return { close, box };
}

export function confirmBox({ title, message, okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const ok = h('button', { class: `btn ${danger ? 'btn-danger-fill' : 'btn-primary'}`, onclick: () => finish(true) }, okText);
    const m = modal({
      title,
      width: 400,
      cls: 'confirm',
      body: h('div', { class: 'modal-msg' }, message),
      footer: [h('button', { class: 'btn', onclick: () => finish(false) }, '取消'), ok],
      onClose: () => finish(false),
    });
    setTimeout(() => ok.focus(), 30);
  });
}

export function promptBox({ title, value = '', placeholder = '', okText = '确定' }) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value, placeholder, style: { width: '100%' } });
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); });
    const m = modal({
      title,
      width: 420,
      body: input,
      footer: [h('button', { class: 'btn', onclick: () => finish(null) }, '取消'), h('button', { class: 'btn btn-primary', onclick: () => finish(input.value.trim()) }, okText)],
      onClose: () => finish(null),
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

let openMenu = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  document.querySelectorAll('.submenu').forEach((x) => x.remove());
}

// items: [{ label, icon, onClick, disabled, shortcut, sub: [...] } | '-' | { header }]
export function menu(items, x, y) {
  closeMenu();
  const el = h('div', { class: 'popover menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { el.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.header) { el.append(h('div', { class: 'menu-header' }, it.header)); continue; }
    const row = h('div', {
      class: `menu-item ${it.disabled ? 'disabled' : ''} ${it.checked ? 'checked' : ''}`,
      onclick: (e) => {
        e.stopPropagation();
        if (it.disabled || it.sub) return;
        closeMenu();
        it.onClick?.();
      },
    },
    h('span', { class: 'menu-icon' }, it.icon ? icon(it.icon, 15) : it.checked ? '✓' : ''),
    h('span', { class: 'menu-label' }, it.label),
    it.sub ? icon('right', 14, { class: 'ico menu-shortcut' }) : it.shortcut ? h('span', { class: 'menu-shortcut' }, it.shortcut) : null);
    if (it.sub) {
      row.addEventListener('mouseenter', () => {
        document.querySelectorAll('.submenu').forEach((x) => x.remove());
        const r = row.getBoundingClientRect();
        const sub = buildSub(it.sub);
        document.body.append(sub);
        const left = r.right + sub.offsetWidth > innerWidth ? r.left - sub.offsetWidth : r.right;
        sub.style.left = `${left}px`;
        sub.style.top = `${Math.min(r.top - 5, innerHeight - sub.offsetHeight - 8)}px`;
      });
    } else {
      row.addEventListener('mouseenter', () => document.querySelectorAll('.submenu').forEach((x) => x.remove()));
    }
    el.append(row);
  }
  document.body.append(el);
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 6))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - hgt - 6))}px`;
  openMenu = el;
  return el;
}

function buildSub(items) {
  const sub = h('div', { class: 'popover menu submenu' });
  for (const it of items) {
    if (it === '-') { sub.append(h('div', { class: 'menu-sep' })); continue; }
    sub.append(h('div', { class: 'menu-item', onclick: (e) => { e.stopPropagation(); closeMenu(); it.onClick?.(); } },
      h('span', { class: 'menu-icon' }, it.icon ? icon(it.icon, 15) : ''), h('span', { class: 'menu-label' }, it.label)));
  }
  return sub;
}

document.addEventListener('mousedown', (e) => { if (openMenu && !e.target.closest('.menu')) closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
