// Chromium 解不了的格式（APE / WMA / DSD / ALAC …）先用 ffmpeg 转成 FLAC 缓存，再交给播放器
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const KEEP = 40; // 缓存里最多保留的转码文件数

export class Transcoder {
  constructor({ dir, getFfmpeg }) {
    this.dir = path.join(dir, 'transcode');
    this.getFfmpeg = getFfmpeg;
    this.jobs = new Map();
    this.checked = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
  }

  ffmpeg() {
    const bin = this.getFfmpeg() || 'ffmpeg';
    if (!this.checked.has(bin)) {
      const r = spawnSync(bin, ['-version'], { windowsHide: true });
      this.checked.set(bin, r.status === 0);
    }
    return this.checked.get(bin) ? bin : null;
  }

  available() { return !!this.ffmpeg(); }

  async get(track) {
    // CUE 拆出的各首共用一个整轨文件，按文件转码一次
    const out = path.join(this.dir, `${track.fileId || track.id}_${Math.round(track.mtime)}.flac`);
    if (fs.existsSync(out)) {
      const now = new Date();
      fsp.utimes(out, now, now).catch(() => {});
      return out;
    }
    if (this.jobs.has(out)) return this.jobs.get(out);
    const bin = this.ffmpeg();
    if (!bin) throw new Error('需要 ffmpeg 才能播放这种格式，请在设置里指定 ffmpeg 路径');
    const dsd = /^(dsf|dff)$/i.test(track.ext);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', track.path, '-map', '0:a:0', '-vn',
      ...(dsd ? ['-ar', '88200', '-sample_fmt', 's32'] : []), '-c:a', 'flac', '-compression_level', '0', out + '.part.flac'];
    const job = new Promise((resolve, reject) => {
      const p = spawn(bin, args, { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', async (code) => {
        if (code !== 0) { reject(new Error(err.trim() || `ffmpeg 退出码 ${code}`)); return; }
        try {
          await fsp.rename(out + '.part.flac', out);
          resolve(out);
          this.prune();
        } catch (e) { reject(e); }
      });
    }).finally(() => this.jobs.delete(out));
    this.jobs.set(out, job);
    return job;
  }

  async prune() {
    const files = await fsp.readdir(this.dir);
    const stats = await Promise.all(files.filter((f) => !f.includes('.part')).map(async (f) => {
      const full = path.join(this.dir, f);
      return { full, t: (await fsp.stat(full)).mtimeMs };
    }));
    stats.sort((a, b) => b.t - a.t);
    for (const s of stats.slice(KEEP)) fsp.unlink(s.full).catch(() => {});
  }
}
