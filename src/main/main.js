// 听音 · 主进程：窗口、本地媒体协议、资料库 / 歌词 / AI 的 IPC、桌面歌词窗口、托盘、MCP 服务、软件内更新
import { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, nativeImage, nativeTheme, Tray, Menu, screen, safeStorage } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Library } from './library.js';
import { Online } from './online.js';
import { AiService, DEFAULT_MODEL, describeAiError } from './ai.js';
import { Transcoder } from './transcode.js';
import { JsonStore } from './store.js';
import { Classifier, DIMENSIONS } from './classify.js';
import { McpServer, newToken } from './mcp.js';
import { createTools, INSTRUCTIONS } from './mcp-tools.js';
import { Updater } from './updater.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RENDERER = path.join(ROOT, 'src/renderer');
// 打包后图标在 app.asar 里，按缓冲区读取比按路径更稳
const ICON = path.join(ROOT, 'build/icon.png');
const iconImage = () => nativeImage.createFromBuffer(fs.readFileSync(ICON));
const DEV = process.argv.includes('--dev');

// 用独立的数据目录，可通过 --user-data=xxx 指定（便于测试）
const udArg = process.argv.find((a) => a.startsWith('--user-data='));
if (udArg) app.setPath('userData', path.resolve(udArg.slice('--user-data='.length)));
const DATA = app.getPath('userData');

if (!app.requestSingleInstanceLock()) app.quit();

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const DEFAULT_SETTINGS = {
  theme: 'system',
  volume: 0.8,
  closeToTray: false,
  ffmpegPath: '',
  eq: { enabled: false, preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preset: '平直' },
  lyrics: { online: true, simplified: true, autoCover: true, artistImages: true },
  desktopLyrics: { enabled: false, locked: false, fontSize: 34, showTrans: true, color: 'blue', bounds: null },
  ai: { apiKeyEnc: '', baseURL: '', model: DEFAULT_MODEL, effort: 'low', autoTimeline: true },
  mcp: { enabled: false, port: 17890, lan: false, token: '' },
  update: { autoCheck: true },
  // AI 调音：设备信息、偏好、上次的推荐结果；auto 开启时按歌曲类型自动切换 profiles 里的曲线
  tune: { device: { type: '', model: '' }, wish: '', auto: false, profiles: [], last: null },
  window: null,
  session: null,
  ui: {},
};

const settings = new JsonStore(path.join(DATA, 'settings.json'), DEFAULT_SETTINGS);
// 补齐新增的嵌套默认值
for (const k of ['eq', 'lyrics', 'desktopLyrics', 'ai', 'mcp', 'update', 'tune']) settings.data[k] = { ...DEFAULT_SETTINGS[k], ...settings.data[k] };
if (!settings.data.mcp.token) { settings.data.mcp.token = newToken(); settings.save(); }

function apiKey() {
  const enc = settings.data.ai.apiKeyEnc;
  if (!enc) return '';
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : Buffer.from(enc, 'base64').toString();
  } catch {
    return '';
  }
}

// 渲染进程拿到的设置里不包含 API Key 明文
function publicSettings() {
  const s = structuredClone(settings.data);
  s.ai.hasKey = !!apiKey();
  s.ai.envKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  delete s.ai.apiKeyEnc;
  return s;
}

function mergeDeep(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') mergeDeep(target[k], v);
    else target[k] = v;
  }
}

function thumb(buf, max) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const scaled = width > max || height > max ? img.resize(width >= height ? { width: max, quality: 'best' } : { height: max, quality: 'best' }) : img;
  return scaled.toJPEG(88);
}

let mainWin = null;
let lyricWin = null;
let tray = null;
let quitting = false;

const send = (ch, payload) => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send(ch, payload);

const library = new Library({
  dir: DATA,
  thumb,
  onProgress: (p) => send('lib:progress', p),
  onChange: () => send('lib:changed'),
});
const online = new Online({ dir: DATA, fetch: (...a) => net.fetch(...a), library, simplified: () => settings.data.lyrics.simplified });
const ai = new AiService({
  dir: DATA,
  getSettings: () => ({ ai: { ...settings.data.ai, apiKey: apiKey() } }),
});
const transcoder = new Transcoder({ dir: DATA, getFfmpeg: () => settings.data.ffmpegPath });
const classifier = new Classifier({
  dir: DATA,
  ai,
  library,
  onProgress: (p) => send('lib:progress', { ...p, phase: p.running ? 'classify' : 'classify-done' }),
  onChange: () => send('lib:changed'),
});

// MCP 的播放指令转给界面执行
const pendingCalls = new Map();
let callSeq = 0;
function callRenderer(cmd, args) {
  if (!mainWin || mainWin.isDestroyed()) return Promise.reject(new Error('听音主窗口没有打开'));
  const reqId = ++callSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingCalls.delete(reqId); reject(new Error('播放器没有响应')); }, 10000);
    pendingCalls.set(reqId, { resolve, reject, timer });
    mainWin.webContents.send('mcp:call', { reqId, cmd, args });
  });
}
const mcp = new McpServer({
  dir: DATA,
  version: app.getVersion(),
  instructions: INSTRUCTIONS,
  getConfig: () => settings.data.mcp,
  tools: createTools({ library, classifier, online, callRenderer, onlineLyrics: () => settings.data.lyrics.online }),
});
const updater = new Updater({ onState: (st) => send('update:state', st) });
updater.beforeQuit = () => { quitting = true; };

// ---------------- 协议 ----------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const AUDIO_MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm' };

async function serveFile(file, request, type) {
  const st = await fsp.stat(file);
  const range = request.headers.get('range');
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : st.size - 1;
    if (!m[1] && m[2]) { start = st.size - Number(m[2]); end = st.size - 1; }
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
  }
  headers['Content-Length'] = String(st.size);
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
}

function registerProtocols() {
  // app://local/... → 界面文件，只开放 src/renderer 与图标库
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const allowed = [RENDERER, path.join(ROOT, 'node_modules/lucide/dist/esm'), path.join(ROOT, 'build')];
    const file = path.normalize(rel.startsWith('lucide/') ? path.join(ROOT, 'node_modules/lucide/dist/esm', rel.slice(7)) : rel.startsWith('build/') ? path.join(ROOT, rel) : path.join(RENDERER, rel));
    if (!allowed.some((dir) => file.startsWith(dir))) return new Response('forbidden', { status: 403 });
    try {
      return new Response(await fsp.readFile(file), { headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  // media://track/<id>  media://cover/<id>[_s]  media://artist/<name>
  protocol.handle('media', async (request) => {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    try {
      if (url.host === 'track') {
        const t = library.tracks.get(key);
        if (!t) return new Response('not found', { status: 404 });
        if (t.needsTranscode) return serveFile(await transcoder.get(t), request, 'audio/flac');
        return serveFile(t.path, request, AUDIO_MIME[t.ext] || 'application/octet-stream');
      }
      if (url.host === 'cover') {
        const small = key.endsWith('_s');
        const file = library.coverPath(small ? key.slice(0, -2) : key, small);
        return new Response(await fsp.readFile(file), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000', 'Access-Control-Allow-Origin': '*' } });
      }
      if (url.host === 'artist') {
        const file = await online.artistImage(key, { online: false });
        if (!file) return new Response('not found', { status: 404 });
        return new Response(await fsp.readFile(file), { headers: { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' } });
      }
    } catch (e) {
      return new Response(String(e.message || e), { status: 500 });
    }
    return new Response('bad request', { status: 400 });
  });
}

// ---------------- 窗口 ----------------
function themeColors() {
  const dark = settings.data.theme === 'dark' || (settings.data.theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? { bg: '#000000', symbol: '#f5f5f7' } : { bg: '#f5f5f7', symbol: '#1d1d1f' };
}

function createMainWindow() {
  const b = settings.data.window || {};
  const c = themeColors();
  mainWin = new BrowserWindow({
    width: b.width || 1320,
    height: b.height || 840,
    x: b.x,
    y: b.y,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: c.bg,
    title: '听音',
    icon: iconImage(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bg, symbolColor: c.symbol, height: 54 },
    webPreferences: {
      preload: path.join(ROOT, 'src/preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // 最小化时桌面歌词仍要流畅
    },
  });
  if (b.maximized) mainWin.maximize();
  mainWin.loadURL('app://local/index.html');
  mainWin.once('ready-to-show', () => mainWin.show());
  if (DEV) mainWin.webContents.openDevTools({ mode: 'detach' });

  const saveBounds = () => {
    if (mainWin.isMinimized()) return;
    settings.data.window = { ...(mainWin.isMaximized() ? settings.data.window : mainWin.getBounds()), maximized: mainWin.isMaximized() };
    settings.save();
  };
  mainWin.on('resize', saveBounds);
  mainWin.on('move', saveBounds);
  mainWin.on('close', (e) => {
    if (settings.data.closeToTray && !quitting) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => {
    mainWin = null;
    if (!settings.data.closeToTray) app.quit();
  });
}

function applyTitleBarTheme() {
  if (!mainWin) return;
  const c = themeColors();
  mainWin.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbol, height: 54 });
  mainWin.setBackgroundColor(c.bg);
}

// 桌面歌词：透明、置顶、无边框；只有歌词文字处接收鼠标，锁定后只有解锁按钮接收
function createLyricWindow() {
  if (lyricWin && !lyricWin.isDestroyed()) return lyricWin;
  const area = screen.getPrimaryDisplay().workArea;
  const saved = settings.data.desktopLyrics.bounds;
  const w = Math.min(1000, area.width - 80);
  const h = 170;
  lyricWin = new BrowserWindow({
    width: saved?.width || w,
    height: saved?.height || h,
    x: saved?.x ?? Math.round(area.x + (area.width - w) / 2),
    y: saved?.y ?? area.y + area.height - h - 40,
    transparent: true,
    frame: false,
    resizable: true,
    minWidth: 420,
    minHeight: 110,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: { preload: path.join(ROOT, 'src/preload/preload.cjs'), contextIsolation: true, sandbox: true },
  });
  lyricWin.setAlwaysOnTop(true, 'screen-saver');
  lyricWin.loadURL('app://local/desktop-lyrics.html');
  lyricWin.once('ready-to-show', () => {
    lyricWin.showInactive();
    // 默认点击穿透；歌词窗口根据鼠标是否在歌词上通过 dl:hover 临时接收点击
    lyricWin.setIgnoreMouseEvents(true, { forward: true });
    applyLock();
  });
  const saveBounds = () => { settings.data.desktopLyrics.bounds = lyricWin.getBounds(); settings.save(); };
  lyricWin.on('moved', saveBounds);
  lyricWin.on('resized', saveBounds);
  lyricWin.on('closed', () => { lyricWin = null; });
  return lyricWin;
}

// 歌词窗口收到新样式后会重新计算命中区域，并用 dl:hover 告诉这边要不要穿透
function applyLock() {
  if (!lyricWin || lyricWin.isDestroyed()) return;
  lyricWin.webContents.send('dl:style', settings.data.desktopLyrics);
}

function setDesktopLyrics(enabled) {
  settings.data.desktopLyrics.enabled = enabled;
  settings.save();
  if (enabled) createLyricWindow();
  else if (lyricWin) lyricWin.close();
  send('dl:state', settings.data.desktopLyrics);
  updateTray();
}

function setLyricLock(locked) {
  settings.data.desktopLyrics.locked = locked;
  settings.save();
  applyLock();
  send('dl:state', settings.data.desktopLyrics);
  updateTray();
}

function showMain() {
  if (!mainWin) createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

let nowPlaying = { title: '', artist: '', playing: false };
function updateTray() {
  if (!tray) return;
  const dl = settings.data.desktopLyrics;
  tray.setToolTip(nowPlaying.title ? `${nowPlaying.title} - ${nowPlaying.artist}` : '听音');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: nowPlaying.title ? `${nowPlaying.title} - ${nowPlaying.artist}` : '听音', enabled: false },
    { type: 'separator' },
    { label: nowPlaying.playing ? '暂停' : '播放', click: () => send('player:command', 'toggle') },
    { label: '上一首', click: () => send('player:command', 'prev') },
    { label: '下一首', click: () => send('player:command', 'next') },
    { type: 'separator' },
    { label: '桌面歌词', type: 'checkbox', checked: dl.enabled, click: (i) => setDesktopLyrics(i.checked) },
    { label: '锁定桌面歌词', type: 'checkbox', checked: dl.locked, enabled: dl.enabled, click: (i) => setLyricLock(i.checked) },
    { type: 'separator' },
    { label: '显示主窗口', click: showMain },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = iconImage().resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', showMain);
  updateTray();
}

// 欢迎页的建议目录：MusicBee 扫描过的文件夹 + 系统「音乐」文件夹
async function folderSuggestions() {
  const out = [];
  const add = (p, from) => {
    p = path.resolve(p);
    if (!out.some((x) => x.path.toLowerCase() === p.toLowerCase())) out.push({ path: p, from, exists: fs.existsSync(p) });
  };
  try {
    const ini = await fsp.readFile(path.join(app.getPath('music'), 'MusicBee', 'MusicBeeLibrarySettings.ini'), 'utf8');
    const block = ini.match(/<OrganisationLastScannedFolders>([\s\S]*?)<\/OrganisationLastScannedFolders>/);
    for (const m of block?.[1].matchAll(/<string>([^<]+)<\/string>/g) || []) add(m[1], 'MusicBee 资料库');
  } catch { /* 没装 MusicBee */ }
  add(app.getPath('music'), '系统音乐文件夹');
  return out.filter((x) => !library.folders.some((f) => f.toLowerCase() === x.path.toLowerCase()));
}

// ---------------- IPC ----------------
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...args) => fn(...args));
}

function registerIpc() {
  handle('lib:snapshot', () => library.snapshot());
  handle('lib:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: '选择音乐文件夹', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled) return [];
    for (const p of r.filePaths) library.addFolder(p);
    return r.filePaths;
  });
  handle('lib:addFolder', (p) => { library.addFolder(p); return true; });
  handle('lib:removeFolder', (p) => library.removeFolder(p));
  handle('lib:rescan', () => { library.scan(); return true; });
  handle('lib:update', (id, patch) => library.update(id, patch));
  handle('lib:played', (id) => library.markPlayed(id));
  handle('lib:duration', (id, d) => library.setDuration(id, d));
  handle('lib:reveal', (id) => { const t = library.tracks.get(id); if (t) shell.showItemInFolder(t.path); });
  handle('lib:exists', (p) => fs.existsSync(p));
  handle('lib:suggestions', () => folderSuggestions());

  handle('pl:create', (name, ids) => library.createPlaylist(name, ids));
  handle('pl:update', (id, patch) => library.updatePlaylist(id, patch));
  handle('pl:delete', (id) => library.deletePlaylist(id));
  handle('pl:import', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: '导入歌单', filters: [{ name: 'M3U 歌单', extensions: ['m3u', 'm3u8'] }], properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) out.push(await library.importM3U(f));
    return out;
  });
  handle('pl:export', async (id) => {
    const pl = library.playlists.find((p) => p.id === id);
    const r = await dialog.showSaveDialog(mainWin, { title: '导出歌单', defaultPath: `${pl?.name || '歌单'}.m3u8`, filters: [{ name: 'M3U8 歌单', extensions: ['m3u8'] }] });
    if (r.canceled) return false;
    return library.exportM3U(id, r.filePath);
  });

  handle('lyrics:get', (id) => {
    const t = library.tracks.get(id);
    return t ? online.getLyrics(t, { online: settings.data.lyrics.online }) : { none: true };
  });
  handle('lyrics:search', (q) => online.searchLyrics(q));
  handle('lyrics:fetch', (item) => online.fetchLyrics(item));
  handle('lyrics:save', (id, data) => online.saveLyrics(id, data));
  handle('cover:search', (q) => online.searchCovers(q));
  handle('cover:apply', (id, url) => online.applyCover(id, url));
  handle('cover:fillMissing', () => { online.fillMissingCovers((p) => send('lib:progress', p)); return true; });
  handle('cover:auto', (id) => {
    const t = library.tracks.get(id);
    return t && settings.data.lyrics.autoCover ? online.autoCover(t).catch(() => null) : null;
  });
  handle('cover:pickFile', async (id) => {
    const r = await dialog.showOpenDialog(mainWin, { title: '选择封面图片', filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    return library.setAlbumCover(id, await fsp.readFile(r.filePaths[0]));
  });
  handle('artist:image', async (name) => {
    const file = await online.artistImage(name, { online: settings.data.lyrics.artistImages });
    return file ? `media://artist/${encodeURIComponent(name)}` : null;
  });

  handle('ai:cached', (id) => ai.cached(id));
  handle('ai:cancel', (reqId) => ai.cancel(reqId));
  handle('ai:start', ({ reqId, kind, trackId: id, lines, history, ...rest }) => {
    const track = library.tracks.get(id);
    if (kind === 'tune') {
      ai.tune(reqId, { ...rest, track })
        .then((result) => send('ai:done', { reqId, result }))
        .catch((e) => send('ai:error', { reqId, message: describeAiError(e) }));
      return true;
    }
    if (!track) return false;
    const onText = (delta) => send('ai:delta', { reqId, delta });
    const job = kind === 'overview' ? ai.overview(reqId, { track, lines }, onText)
      : kind === 'timeline' ? ai.timeline(reqId, { track, lines })
        : kind === 'translate' ? ai.translate(reqId, { track, lines })
          : ai.chat(reqId, { track, lines, history }, onText);
    job.then((result) => send('ai:done', { reqId, result }))
      .catch((e) => send('ai:error', { reqId, message: describeAiError(e) }));
    return true;
  });

  handle('tags:get', () => ({ tags: classifier.tags, dims: DIMENSIONS, status: classifier.status() }));
  handle('tags:start', (opts) => classifier.start(opts || {}));
  handle('tags:cancel', () => { classifier.cancel(); return classifier.status(); });

  handle('mcp:status', () => mcp.status());
  handle('mcp:set', async (patch) => {
    if (patch.resetToken) patch = { ...patch, token: newToken() };
    delete patch.resetToken;
    if (patch.port != null) patch.port = Math.max(1024, Math.min(65535, Math.round(Number(patch.port)) || 17890));
    Object.assign(settings.data.mcp, patch);
    settings.save();
    return mcp.restart();
  });
  handle('mcp:stdioCommand', () => ({
    // 打包后用自带的 Electron 当 Node 跑桥接脚本，不需要另装 Node.js
    command: process.execPath,
    args: app.isPackaged ? [path.join(process.resourcesPath, 'app.asar', 'src', 'mcp-stdio.mjs')] : [path.join(ROOT, 'src', 'mcp-stdio.mjs')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }));

  handle('update:state', () => updater.state);
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.install());
  handle('update:releases', () => updater.openReleases());

  handle('settings:get', () => publicSettings());
  handle('settings:set', (patch) => {
    if (patch.ai && 'apiKey' in patch.ai) {
      const key = patch.ai.apiKey.trim();
      settings.data.ai.apiKeyEnc = !key ? '' : safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key).toString('base64') : Buffer.from(key).toString('base64');
      delete patch.ai.apiKey;
    }
    if (patch.ffmpegPath !== undefined) transcoder.checked.clear();
    mergeDeep(settings.data, patch);
    settings.save();
    if (patch.theme) { nativeTheme.themeSource = patch.theme; applyTitleBarTheme(); }
    if (patch.desktopLyrics) {
      if ('enabled' in patch.desktopLyrics) setDesktopLyrics(patch.desktopLyrics.enabled);
      if ('locked' in patch.desktopLyrics) setLyricLock(patch.desktopLyrics.locked);
      applyLock();
    }
    return publicSettings();
  });
  handle('settings:ffmpeg', () => transcoder.available());
  handle('settings:pickFfmpeg', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: '选择 ffmpeg.exe', filters: [{ name: 'ffmpeg', extensions: ['exe'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('shell:open', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

  // 主界面 → 桌面歌词
  ipcMain.on('dl:update', (_e, payload) => {
    if (lyricWin && !lyricWin.isDestroyed()) lyricWin.webContents.send('dl:update', payload);
  });
  ipcMain.on('np:state', (_e, s) => { nowPlaying = s; updateTray(); });
  ipcMain.on('mcp:reply', (_e, { reqId, result, error }) => {
    const p = pendingCalls.get(reqId);
    if (!p) return;
    pendingCalls.delete(reqId);
    clearTimeout(p.timer);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  });
  // 桌面歌词 → 主界面
  ipcMain.on('dl:command', (_e, cmd) => {
    if (cmd === 'close') setDesktopLyrics(false);
    else if (cmd === 'lock') setLyricLock(true);
    else if (cmd === 'unlock') setLyricLock(false);
    else if (cmd === 'bigger' || cmd === 'smaller') {
      const dl = settings.data.desktopLyrics;
      dl.fontSize = Math.max(18, Math.min(72, dl.fontSize + (cmd === 'bigger' ? 2 : -2)));
      settings.save();
      applyLock();
      send('dl:state', dl);
    } else if (cmd === 'trans') {
      settings.data.desktopLyrics.showTrans = !settings.data.desktopLyrics.showTrans;
      settings.save();
      applyLock();
      send('dl:state', settings.data.desktopLyrics);
    } else if (cmd === 'color') {
      const order = ['blue', 'white', 'dark'];
      const dl = settings.data.desktopLyrics;
      dl.color = order[(order.indexOf(dl.color) + 1) % order.length];
      settings.save();
      applyLock();
    } else if (cmd === 'main') showMain();
    else send('player:command', cmd);
  });
  ipcMain.on('dl:ready', () => { applyLock(); send('dl:resend'); });
  // 鼠标在歌词上（锁定时：在解锁按钮上）才接收点击，其余地方穿透
  ipcMain.on('dl:hover', (_e, over) => {
    if (lyricWin && !lyricWin.isDestroyed()) lyricWin.setIgnoreMouseEvents(!over, { forward: true });
  });
  // 拖动歌词：按光标的屏幕坐标移动，避免高分屏下换算误差
  let drag = null;
  ipcMain.on('dl:drag', (_e, phase) => {
    if (!lyricWin || lyricWin.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    if (phase === 'start') drag = { ...lyricWin.getBounds(), cx: p.x, cy: p.y };
    else if (phase === 'move' && drag) lyricWin.setBounds({ x: drag.x + p.x - drag.cx, y: drag.y + p.y - drag.cy, width: drag.width, height: drag.height });
    else if (phase === 'end' && drag) {
      drag = null;
      settings.data.desktopLyrics.bounds = lyricWin.getBounds();
      settings.save();
    }
  });
}

// ---------------- 生命周期 ----------------
app.on('second-instance', showMain);

app.whenReady().then(() => {
  app.setAppUserModelId('com.liyucheng.tingyin');
  nativeTheme.themeSource = settings.data.theme;
  registerProtocols();
  registerIpc();
  createMainWindow();
  createTray();
  if (settings.data.desktopLyrics.enabled) createLyricWindow();
  library.watchAll();
  // 启动后增量扫描一次，把离线期间的变化补上
  setTimeout(() => library.folders.length && library.scan(), 2500);
  mcp.restart();
  if (settings.data.update.autoCheck) setTimeout(() => updater.check(), 8000);
});

nativeTheme.on('updated', applyTitleBarTheme);

app.on('before-quit', () => {
  quitting = true;
  settings.flushSync();
  library.store.data.tracks = [...library.tracks.values()];
  library.store.flushSync();
  classifier.flushSync();
  mcp.stop();
  // stop() 是异步的，进程可能等不到它删完；这里同步删掉连接信息，免得桥接脚本以为听音还开着
  try { fs.rmSync(mcp.infoFile, { force: true }); } catch { /* 无所谓 */ }
});

app.on('window-all-closed', () => {
  if (!settings.data.closeToTray) app.quit();
});
