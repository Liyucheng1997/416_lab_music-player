// AI 赏析：用 Claude 对正在播放的歌曲做整体赏析、随歌词推进的逐段解读、歌词翻译与追问
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { readJson, writeJson } from './store.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = `你是「听音」音乐播放器里的 AI 聆听伙伴，一位懂音乐、也懂文学的乐评人。用户正在听一首歌，你陪他一起听，帮他听懂、听深。

写作要求：
- 一律用简体中文，语气温和、具体、有画面感，像朋友在耳边聊，而不是百科词条。
- 你听不到音频本身，只能看到歌曲的标签信息和歌词。谈编曲、配器、演唱时，基于你对这首歌的了解；不了解这首歌时，就从流派和年代的常见做法出发，并明确说这是推测。
- 创作背景、发行信息、获奖记录等事实，没有把握就不要写，或者说明「不确定」。宁可少写，不要编造。
- 引用歌词时只摘短句，用「」括起来，紧跟你的解读。
- 不要使用 emoji。`;

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function songCard(track) {
  const rows = [
    `歌名：${track.title || '未知'}`,
    `歌手：${track.artist || '未知'}`,
    track.album && `专辑：${track.album}`,
    track.year && `年份：${track.year}`,
    track.genre && `流派：${track.genre}`,
    track.composer && `作曲：${track.composer}`,
    track.duration && `时长：${fmt(track.duration)}`,
  ];
  return rows.filter(Boolean).join('\n');
}

function lyricsBlock(lines, withTime) {
  if (!lines?.length) return '（没有歌词，可能是纯音乐，或者暂未找到歌词）';
  return lines.map((l) => (withTime && l.time != null ? `[${fmt(l.time)} | ${l.time.toFixed(1)}s] ${l.text}` : l.text)).join('\n');
}

const TIMELINE_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: '这一段开始的秒数' },
          title: { type: 'string', description: '4 到 10 个字的小标题' },
          note: { type: 'string', description: '这一段的赏析' },
        },
        required: ['start', 'title', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['segments'],
  additionalProperties: false,
};

const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, t: { type: 'string' } },
        required: ['i', 't'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

// ---------- AI 调音：按歌曲类型和播放设备推荐均衡器曲线与设置 ----------
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const TUNE_SYSTEM = `你是「听音」音乐播放器里的调音师，熟悉各类耳机、音箱的声音特点，也熟悉不同音乐风格的混音习惯。你要根据用户的播放设备和听的音乐类型，给出均衡器曲线和让声音更好听的设置建议。

播放器的均衡器：
- 10 段，中心频率依次是 ${EQ_FREQS.map((f) => (f >= 1000 ? `${f / 1000}kHz` : `${f}Hz`)).join('、')}；31Hz 是低架、16kHz 是高架，其余是 Q≈1.1 的峰值滤波。
- 每段增益 -12 到 +12 dB，步长 0.5。前级增益 preamp 也是 -12 到 +12 dB。
- 播放器会按最大提升量自动压低前级（约 0.6 倍），防止削波；preamp 一般给 0，需要额外留余量时给负值。

调音原则：
- 宁可温和，不要夸张。大多数频段控制在 ±6 dB 以内，相邻频段不要忽高忽低（不超过 4 dB 的落差），曲线要平滑。
- 先补设备的短板、再顺着音乐风格微调。设备本身放不出来的频段不要硬推（例如笔记本扬声器、手机外放、小音箱在 31/62Hz 几乎没有输出，提升只会浪费动态余量、带来破音，应该持平或衰减，改为在 100~250Hz 适度增加来营造"有低音"的感觉）。
- 认识这款设备型号时，按你对它频响特点的了解来补偿（比如低频过量、3~6kHz 齿音刺耳、高频滚降）；不认识就按设备类型的常见特点推测，并在说明里讲清楚是推测。不要编造参数和测量数据。
- 音量较低时人耳对低频和高频不敏感，可以适度做响度补偿；音量很高时要更克制。
- 用户写了偏好时优先满足，但不要为了满足偏好牺牲清晰度。

写作要求：一律用简体中文，具体、口语化，说清楚"为什么这样调、听起来会有什么变化"。不要使用 emoji。`;

const tuneSchema = (keys) => ({
  type: 'object',
  properties: {
    device: { type: 'string', description: '对这个播放设备声音特点的判断，以及调音的总体思路，80 到 160 字' },
    profiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: keys, description: '对应哪一类歌曲' },
          name: { type: 'string', description: '这条曲线的名字，2 到 8 个字，例如「人声透亮」「温暖低频」' },
          preamp: { type: 'number' },
          bands: { type: 'array', items: { type: 'number' }, description: `10 个数，依次对应 ${EQ_FREQS.join('/')} Hz 的增益(dB)` },
          why: { type: 'string', description: '为什么这样调、听感变化，40 到 100 字' },
        },
        required: ['key', 'name', 'preamp', 'bands', 'why'],
        additionalProperties: false,
      },
    },
    tips: {
      type: 'array',
      description: '均衡器以外让声音更好听的建议，3 到 5 条：系统或设备侧的设置、音量、摆放位置、蓝牙编码、音源格式等',
      items: {
        type: 'object',
        properties: { title: { type: 'string', description: '不超过 12 个字' }, detail: { type: 'string', description: '具体怎么做，30 到 80 字' } },
        required: ['title', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['device', 'profiles', 'tips'],
  additionalProperties: false,
});

const half = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.round((Number(x) || 0) * 2) / 2));

export function normalizeProfile(p) {
  const bands = EQ_FREQS.map((_, i) => half(p?.bands?.[i], -12, 12));
  return { key: String(p?.key || '默认'), name: String(p?.name || 'AI 推荐').slice(0, 12), preamp: half(p?.preamp, -12, 12), bands, why: String(p?.why || '') };
}

function deviceCard(device) {
  const rows = [
    `设备类型：${device?.type || '未说明'}`,
    device?.model && `型号 / 名称：${device.model}`,
    device?.label && `系统里的输出设备名：${device.label}`,
    device?.volume != null && `播放器音量：${Math.round(device.volume * 100)}%`,
  ];
  return rows.filter(Boolean).join('\n');
}

export class AiService {
  constructor({ dir, getSettings }) {
    this.cacheDir = path.join(dir, 'ai');
    this.getSettings = getSettings;
    this.active = new Map();
  }

  client() {
    const s = this.getSettings().ai || {};
    const opts = { maxRetries: 2 };
    if (s.apiKey) opts.apiKey = s.apiKey;
    if (s.baseURL) opts.baseURL = s.baseURL;
    // 未填写 Key 时，SDK 会继续读取 ANTHROPIC_API_KEY 等环境变量
    return { client: new Anthropic(opts), s };
  }

  cacheFile(trackIdValue) { return path.join(this.cacheDir, `${trackIdValue}.json`); }
  async cached(trackIdValue) { return (await readJson(this.cacheFile(trackIdValue))) || {}; }
  async remember(trackIdValue, patch) {
    const old = await this.cached(trackIdValue);
    await writeJson(this.cacheFile(trackIdValue), { ...old, ...patch, at: Date.now() });
  }

  // 统一的流式请求：增量文字通过 onText 回调推给界面
  async run(reqId, { system, messages, format, maxTokens = 64000, onText }) {
    const { client, s } = this.client();
    const params = {
      model: s.model || DEFAULT_MODEL,
      max_tokens: maxTokens,
      system,
      messages,
      output_config: { effort: s.effort || 'low', ...(format ? { format: { type: 'json_schema', schema: format } } : {}) },
    };
    // 官方接口上开启服务端兜底：主模型拒答时由推荐的备用模型接手；自定义代理地址可能不认这个参数
    const official = !s.baseURL;
    const stream = official
      ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : client.messages.stream(params);
    this.active.set(reqId, stream);
    if (onText) stream.on('text', (delta) => onText(delta));
    try {
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error('模型拒绝回答这个请求，可以换个问法再试。');
      return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    } finally {
      this.active.delete(reqId);
    }
  }

  cancel(reqId) {
    this.active.get(reqId)?.abort();
    this.active.delete(reqId);
  }

  async overview(reqId, { track, lines }, onText) {
    const text = await this.run(reqId, {
      system: SYSTEM,
      onText,
      messages: [{
        role: 'user',
        content: `请为这首歌写一篇聆听赏析。\n\n${songCard(track)}\n\n歌词：\n${lyricsBlock(lines, false)}\n\n用 Markdown 输出，按下面的小节组织（用 ### 作小标题，没有内容的小节可以省略）：\n### 一句话印象\n### 创作与时代\n### 歌词里的意象\n### 声音与编曲\n### 聆听建议\n整篇控制在 600 到 900 字。`,
      }],
    });
    await this.remember(track.id, { overview: text });
    return text;
  }

  async timeline(reqId, { track, lines }) {
    const synced = lines?.some((l) => l.time != null && l.time > 0);
    const hint = synced
      ? '每一段的 start 必须取自上面某一行歌词的秒数（括号里的数字），第一段从 0 开始（前奏）。'
      : `歌词没有时间轴。请根据时长 ${Math.round(track.duration || 240)} 秒和这类歌曲常见的结构（前奏、主歌、副歌、桥段、尾奏）估计每段的开始秒数。`;
    const raw = await this.run(reqId, {
      system: SYSTEM,
      format: TIMELINE_SCHEMA,
      maxTokens: 16000,
      messages: [{
        role: 'user',
        content: `用户正在听这首歌。请把它拆成 5 到 10 个段落，为每一段写一段随听随读的赏析，播放到哪一段，界面就显示哪一段。\n\n${songCard(track)}\n\n歌词（带时间）：\n${lyricsBlock(lines, true)}\n\n${hint}\n每段 note 写 60 到 140 字：这一段在讲什么、情绪如何推进、值得留意的词句或音乐处理。不要重复整首歌的概述。`,
      }],
    });
    const segments = (JSON.parse(raw).segments || [])
      .filter((x) => Number.isFinite(x.start))
      .sort((a, b) => a.start - b.start);
    await this.remember(track.id, { timeline: segments });
    return segments;
  }

  async translate(reqId, { track, lines }) {
    const items = lines.map((l, i) => `${i}\t${l.text}`).join('\n');
    const raw = await this.run(reqId, {
      system: SYSTEM,
      format: TRANSLATE_SCHEMA,
      maxTokens: 32000,
      messages: [{
        role: 'user',
        content: `把下面这首歌（${track.artist} -《${track.title}》）的歌词逐行翻译成简体中文。保持歌词的语感和韵味，不要逐字硬译。每行前面是行号，用 i 原样返回；本来就是中文的行、拟声词或空行，t 返回空字符串。\n\n${items}`,
      }],
    });
    const map = {};
    for (const x of JSON.parse(raw).lines || []) if (x.t) map[x.i] = x.t;
    return map;
  }

  // mode = 'now'：只为正在播放的这首歌给一条曲线；'library'：为资料库里的主要类型各给一条，外加「默认」
  async tune(reqId, { mode, track, tags, groups, device, wish }) {
    let keys;
    let music;
    if (mode === 'now' && track) {
      keys = ['当前歌曲'];
      const tg = tags ? [tags.style && `风格：${tags.style}`, tags.lang && `语言：${tags.lang}`, tags.mood?.length && `情绪：${tags.mood.join('、')}`].filter(Boolean).join('\n') : '';
      music = `只为下面这首歌调一条曲线（key 填「当前歌曲」）：\n${songCard(track)}${tg ? `\n${tg}` : ''}`;
    } else {
      const list = (groups || []).slice(0, 10);
      keys = [...list.map((g) => g.key), '默认'];
      music = `用户资料库里主要的歌曲类型（按数量排序）：\n${list.map((g) => `- ${g.key}：${g.count} 首${g.artists?.length ? `，常听：${g.artists.join('、')}` : ''}`).join('\n')}\n\n请为上面每一类各调一条曲线（key 用类型名原样填写），另外给一条「默认」曲线，用于不属于这些类型的歌。播放器会在切歌时按歌曲类型自动切换曲线，所以同一设备下各条曲线的整体响度要接近，切换时不要忽大忽小。`;
    }
    const raw = await this.run(reqId, {
      system: TUNE_SYSTEM,
      format: tuneSchema(keys),
      maxTokens: 16000,
      messages: [{
        role: 'user',
        content: `播放设备：\n${deviceCard(device)}\n\n${music}${wish ? `\n\n用户的偏好：${wish}` : ''}`,
      }],
    });
    const data = JSON.parse(raw);
    const seen = new Set();
    const profiles = (data.profiles || []).map(normalizeProfile).filter((p) => keys.includes(p.key) && !seen.has(p.key) && seen.add(p.key));
    if (!profiles.length) throw new SyntaxError('no profiles');
    return { device: String(data.device || ''), profiles, tips: (data.tips || []).slice(0, 6) };
  }

  async chat(reqId, { track, lines, history }, onText) {
    const context = `${songCard(track)}\n\n歌词：\n${lyricsBlock(lines, false)}`;
    const messages = history.map((m, i) => ({
      role: m.role,
      content: i === 0 && m.role === 'user' ? `（正在播放的歌曲信息）\n${context}\n\n我的问题：${m.content}` : m.content,
    }));
    return this.run(reqId, { system: `${SYSTEM}\n- 现在是问答环节，回答要简短直接，一般不超过 300 字。`, messages, onText });
  }
}

export function describeAiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'API Key 无效，请在设置里检查。';
  if (e instanceof Anthropic.PermissionDeniedError) return '这个 API Key 没有调用该模型的权限。';
  if (e instanceof Anthropic.NotFoundError) return '找不到所选模型，请在设置里换一个模型。';
  if (e instanceof Anthropic.RateLimitError) return '请求太频繁或额度不足，请稍后再试。';
  if (e instanceof Anthropic.BadRequestError) return `请求被拒绝：${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return '连不上 AI 服务，请检查网络或代理地址。';
  if (e instanceof Anthropic.APIUserAbortError) return '已停止';
  if (e instanceof Anthropic.APIError) return `AI 服务出错（${e.status}）：${e.message}`;
  if (e instanceof SyntaxError) return 'AI 返回的内容无法解析，请重试。';
  return String(e?.message || e);
}
