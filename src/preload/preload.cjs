// 预加载：只暴露白名单里的 IPC 通道
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'lib:snapshot', 'lib:pickFolder', 'lib:addFolder', 'lib:removeFolder', 'lib:rescan', 'lib:update', 'lib:played', 'lib:duration', 'lib:reveal', 'lib:exists', 'lib:suggestions',
  'pl:create', 'pl:update', 'pl:delete', 'pl:import', 'pl:export',
  'lyrics:get', 'lyrics:search', 'lyrics:save',
  'cover:search', 'cover:apply', 'cover:auto', 'cover:fillMissing', 'cover:pickFile', 'artist:image',
  'ai:cached', 'ai:cancel', 'ai:start',
  'settings:get', 'settings:set', 'settings:ffmpeg', 'settings:pickFfmpeg', 'shell:open',
]);
const SEND = new Set(['dl:update', 'dl:command', 'dl:ready', 'dl:hover', 'np:state']);
const LISTEN = new Set(['lib:progress', 'lib:changed', 'player:command', 'dl:state', 'dl:resend', 'dl:update', 'dl:style', 'ai:delta', 'ai:done', 'ai:error']);

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...args) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error(`blocked: ${ch}`))),
  send: (ch, payload) => SEND.has(ch) && ipcRenderer.send(ch, payload),
  on: (ch, fn) => {
    if (!LISTEN.has(ch)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(ch, handler);
    return () => ipcRenderer.removeListener(ch, handler);
  },
});
