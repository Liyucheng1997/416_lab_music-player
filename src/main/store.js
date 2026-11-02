// JSON 持久化：原子写入 + 防抖，所有数据都放在 userData 下
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
    this.timer = null;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      this.data = { ...this.data, ...JSON.parse(raw) };
    } catch {
      // 首次运行或文件损坏：使用默认值
    }
  }

  save(delay = 600) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.data));
    await fsp.rename(tmp, this.file);
  }

  flushSync() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value));
}
