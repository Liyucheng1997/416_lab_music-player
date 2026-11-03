// 软件内更新：从 GitHub Releases 检查新版本，一键下载并静默安装后自动重启
import { app, shell } from 'electron';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;
export const RELEASES_URL = 'https://github.com/Liyucheng1997/416_lab_music-player/releases/latest';

export class Updater {
  constructor({ onState }) {
    this.onState = onState || (() => {});
    // 便携版每次运行都解压到临时目录，没法原地替换，只能去下载页
    this.portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
    this.state = { status: 'idle', current: app.getVersion(), portable: this.portable, supported: app.isPackaged && !this.portable };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'available', version: info.version, notes: notesOf(info), date: info.releaseDate }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest' }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent), speed: p.bytesPerSecond }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
    autoUpdater.on('error', (e) => this.fail(e));
  }

  // 最新的 Release 里没有 latest.yml（比如 1.0.0 这种没带更新信息的旧版本）时，当作已是最新
  fail(e) {
    if (/404|latest\.yml/.test(String(e?.message || e)) && this.state.status === 'checking') this.set({ status: 'latest' });
    else this.set({ status: 'error', error: friendly(e) });
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  async check() {
    if (!this.state.supported) {
      this.set({ status: 'unsupported', error: this.portable ? '便携版不能自动更新，请到下载页获取新版本' : '开发模式下不检查更新' });
      return this.state;
    }
    if (['checking', 'downloading'].includes(this.state.status)) return this.state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      // 一般已经由 error 事件处理过，这里只兜底没触发事件的情况
      if (this.state.status === 'checking') this.fail(e);
    }
    return this.state;
  }

  // 一键更新：下载 → 静默安装 → 自动重启
  async install() {
    if (this.state.status === 'ready') return this.quitAndInstall();
    if (this.state.status !== 'available') await this.check();
    if (this.state.status !== 'available') return this.state;
    try {
      this.set({ status: 'downloading', percent: 0 });
      await autoUpdater.downloadUpdate();
      this.quitAndInstall();
    } catch (e) {
      this.set({ status: 'error', error: friendly(e) });
    }
    return this.state;
  }

  quitAndInstall() {
    this.beforeQuit?.();
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return this.state;
  }

  openReleases() { shell.openExternal(RELEASES_URL); }
}

function notesOf(info) {
  const n = info.releaseNotes;
  const text = Array.isArray(n) ? n.map((x) => x.note).join('\n') : n || '';
  return text.replace(/<[^>]+>/g, '').trim().slice(0, 1200);
}

function friendly(e) {
  const m = String(e?.message || e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR/.test(m)) return '连不上 GitHub，请检查网络后重试';
  return m.split('\n')[0].slice(0, 200);
}
