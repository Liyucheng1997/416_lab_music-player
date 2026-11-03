// AI 分类：让 Claude 按风格 / 语言 / 情绪 / 场景给资料库里的歌打标签，结果存在 ai-tags.json，不改动音乐文件
import path from 'node:path';
import { JsonStore } from './store.js';

// 固定的分类表：结构化输出用枚举约束，保证同一类不会出现五花八门的写法
export const DIMENSIONS = {
  style: {
    label: '风格',
    values: ['流行', '摇滚', '民谣', '说唱', '电子', '舞曲', 'R&B', '爵士蓝调', '乡村', '金属朋克', '中国风', '民族音乐', '古典', '轻音乐', '新世纪', '影视原声', '游戏原声', '动漫', '戏曲曲艺', '儿歌', '红色经典', '宗教', '其他'],
  },
  lang: {
    label: '语言',
    values: ['国语', '粤语', '闽南语', '英语', '日语', '韩语', '少数民族语', '其他外语', '纯音乐'],
  },
  mood: {
    label: '情绪',
    multi: true,
    values: ['欢快', '甜蜜', '治愈', '伤感', '怀旧', '激昂', '深情', '安静', '孤独', '励志', '大气', '轻松', '神秘'],
  },
  scene: {
    label: '场景',
    multi: true,
    values: ['通勤', '学习工作', '运动', '开车', '睡前', '聚会', '雨天', '放松', 'KTV', '思念', '旅行'],
  },
};

const BATCH = 100;
const CONCURRENCY = 3;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          style: { type: 'string', enum: DIMENSIONS.style.values },
          lang: { type: 'string', enum: DIMENSIONS.lang.values },
          mood: { type: 'array', items: { type: 'string', enum: DIMENSIONS.mood.values } },
          scene: { type: 'array', items: { type: 'string', enum: DIMENSIONS.scene.values } },
        },
        required: ['i', 'style', 'lang', 'mood', 'scene'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const SYSTEM = `你是音乐资料库的整理员，负责给歌曲打分类标签。你只能看到标签信息和所在文件夹，听不到音频。
- 认识这首歌就按你对它的了解来分；不认识时，结合歌手、专辑、流派和文件夹名（如「经典老歌」「影视原声」「中国民乐」）推断。
- style 和 lang 各选一个；mood 选 1 到 2 个；scene 选 1 到 2 个最合适的聆听场景。
- 没有人声的器乐、钢琴曲、交响乐，lang 选「纯音乐」。
- 每一行都必须返回，i 原样带回。`;

const rel = (folders, file) => {
  const dir = path.dirname(file);
  const root = folders.find((f) => dir.toLowerCase().startsWith(f.toLowerCase()));
  return (root ? path.relative(root, dir) : dir).split(path.sep).map((p) => p.slice(0, 40)).slice(0, 3).join('/');
};

export class Classifier {
  constructor({ dir, ai, library, onProgress, onChange }) {
    this.store = new JsonStore(path.join(dir, 'ai-tags.json'), { version: 1, tags: {} });
    this.ai = ai;
    this.library = library;
    this.onProgress = onProgress || (() => {});
    this.onChange = onChange || (() => {});
    this.job = null;
  }

  get tags() { return this.store.data.tags; }

  status() {
    const total = this.library.tracks.size;
    let done = 0;
    for (const id of this.library.tracks.keys()) if (this.tags[id]) done++;
    return { total, done, running: !!this.job, progress: this.job?.progress || null };
  }

  // 按维度分组：{ style: { 流行: [id…] }, … }
  groups() {
    const out = Object.fromEntries(Object.keys(DIMENSIONS).map((k) => [k, {}]));
    for (const id of this.library.tracks.keys()) {
      const t = this.tags[id];
      if (!t) continue;
      for (const dim of Object.keys(DIMENSIONS)) {
        for (const v of [].concat(t[dim] || [])) (out[dim][v] ||= []).push(id);
      }
    }
    return out;
  }

  // 后台分类；all=false 时只处理还没有标签的歌
  start({ all = false } = {}) {
    if (this.job) return this.status();
    const todo = [...this.library.tracks.values()].filter((t) => all || !this.tags[t.id]);
    if (!todo.length) return this.status();
    const job = { cancelled: false, progress: { done: 0, total: todo.length, failed: 0 } };
    this.job = job;
    const folders = this.library.folders;
    const batches = [];
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
    let next = 0;
    let lastError = '';
    const worker = async () => {
      while (!job.cancelled && next < batches.length) {
        const batch = batches[next++];
        try {
          await this.classifyBatch(batch, folders, job);
        } catch (e) {
          job.progress.failed += batch.length;
          lastError = String(e?.message || e);
        }
        job.progress.done += batch.length;
        this.onProgress({ ...job.progress, running: true });
        this.store.save();
      }
    };
    Promise.all(Array.from({ length: CONCURRENCY }, worker)).finally(() => {
      this.job = null;
      this.store.save();
      this.onProgress({ ...job.progress, running: false, error: lastError || null });
      this.onChange();
    });
    return this.status();
  }

  cancel() {
    if (this.job) this.job.cancelled = true;
    for (const reqId of this.ai.active.keys()) if (reqId.startsWith('classify:')) this.ai.cancel(reqId);
  }

  async classifyBatch(batch, folders, job) {
    const clean = (s) => String(s || '').replace(/[\t\n\r]/g, ' ').slice(0, 60);
    const rows = batch.map((t, i) => [i, clean(t.artist), clean(t.title), clean(t.album), clean(t.genre), t.year || '', rel(folders, t.path)].join('\t'));
    const raw = await this.ai.run(`classify:${batch[0].id}`, {
      system: SYSTEM,
      format: SCHEMA,
      maxTokens: 32000,
      messages: [{ role: 'user', content: `给下面 ${batch.length} 首歌打标签。每行依次是：序号、歌手、歌名、专辑、流派标签、年份、所在文件夹。\n\n${rows.join('\n')}` }],
    });
    if (job.cancelled) return;
    for (const x of JSON.parse(raw).items || []) {
      const t = batch[x.i];
      if (!t) continue;
      this.tags[t.id] = { style: x.style, lang: x.lang, mood: x.mood.slice(0, 2), scene: x.scene.slice(0, 2), by: 'ai' };
    }
  }

  // 外部导入（比如批量整理好的标签），只接受分类表里的值
  importTags(map) {
    let n = 0;
    for (const [id, t] of Object.entries(map)) {
      if (!this.library.tracks.has(id)) continue;
      const pick = (dim) => [].concat(t[dim] || []).filter((v) => DIMENSIONS[dim].values.includes(v));
      const style = pick('style')[0];
      const lang = pick('lang')[0];
      if (!style || !lang) continue;
      this.tags[id] = { style, lang, mood: pick('mood').slice(0, 2), scene: pick('scene').slice(0, 2), by: t.by || 'ai' };
      n++;
    }
    this.store.save();
    this.onChange();
    return n;
  }

  flushSync() { this.store.flushSync(); }
}
