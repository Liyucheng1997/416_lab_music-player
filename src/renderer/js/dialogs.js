// 对话框：查找歌词、查找封面、设置、均衡器
import { h, icon, clear, fmtTime } from './dom.js';
import { state, emit, on, saveSettings } from './store.js';
import { modal, toast } from './ui.js';
import { EQ_FREQS, EQ_PRESETS, applyEq } from './player.js';
import { parseLrc } from './lrc.js';

// ---------------- 查找歌词 ----------------
export function openLyricsSearch(track) {
  const title = h('input', { class: 'input', value: track.title, placeholder: '歌名' });
  const artist = h('input', { class: 'input', value: track.artist, placeholder: '歌手' });
  const list = h('div', { class: 'result-list' });
  const preview = h('div', { class: 'lyric-preview' }, '选择一条结果预览歌词');
  const paste = h('textarea', { class: 'input', rows: 12, placeholder: '在这里粘贴 LRC 或纯文本歌词', style: { width: '100%', display: 'none', marginTop: '12px' } });
  let picked = null;
  let mode = 'search';
  const useBtn = h('button', { class: 'btn btn-primary', disabled: true, onclick: save }, '使用这份歌词');

  async function search() {
    clear(list, h('div', { class: 'empty', style: { padding: '24px' } }, h('div', { class: 'spinner' })));
    try {
      const res = await window.api.invoke('lyrics:search', { title: title.value.trim(), artist: artist.value.trim() });
      if (!res.length) return clear(list, h('div', { class: 'empty', style: { padding: '24px' } }, '没有找到，换个关键词试试，比如只填歌名'));
      clear(list, res.map((r) => {
        const diff = track.duration && r.duration ? Math.round(r.duration - track.duration) : null;
        const row = h('div', { class: 'result-row', onclick: () => {
          list.querySelectorAll('.active').forEach((x) => x.classList.remove('active'));
          row.classList.add('active');
          picked = r;
          preview.textContent = r.instrumental ? '（纯音乐）' : parseLrc(r.lrc).lines.map((l) => l.text).join('\n');
          useBtn.disabled = false;
        } },
        h('div', { class: 'grow' }, h('div', { class: 'name' }, r.title), h('div', { class: 'desc' }, [r.artist, r.album, r.duration && fmtTime(r.duration)].filter(Boolean).join(' · '))),
        diff != null && Math.abs(diff) > 3 ? h('span', { class: 'badge' }, `${diff > 0 ? '+' : ''}${diff}s`) : null,
        h('span', { class: `badge ${r.synced ? 'blue' : ''}` }, r.instrumental ? '纯音乐' : r.synced ? '逐行同步' : '纯文本'));
        return row;
      }));
    } catch (e) {
      clear(list, h('div', { class: 'ai-error' }, `搜索失败：${e.message}`));
    }
  }

  async function save() {
    const data = mode === 'paste'
      ? { lrc: paste.value, source: '手动粘贴' }
      : { lrc: picked.lrc, instrumental: picked.instrumental, source: 'LRCLIB', remoteId: picked.id };
    if (!data.lrc && !data.instrumental) return;
    await window.api.invoke('lyrics:save', track.id, data);
    emit('lyrics:changed', track.id);
    toast('歌词已更新', 'success');
    m.close();
  }

  const seg = h('div', { class: 'seg', style: { marginBottom: '12px' } },
    h('button', { class: 'active', onclick: (e) => setMode('search', e.target) }, '在线搜索'),
    h('button', { onclick: (e) => setMode('paste', e.target) }, '粘贴歌词'));
  function setMode(next, btn) {
    mode = next;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    searchBox.style.display = next === 'search' ? '' : 'none';
    paste.style.display = next === 'paste' ? '' : 'none';
    useBtn.disabled = next === 'search' ? !picked : false;
  }
  paste.addEventListener('input', () => { useBtn.disabled = !paste.value.trim(); });
  for (const inp of [title, artist]) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  const searchBox = h('div', {},
    h('div', { class: 'search-row' }, title, artist, h('button', { class: 'btn btn-primary', onclick: search }, icon('search', 15), '搜索')),
    list, preview,
    h('div', { class: 'ai-note', style: { marginTop: '10px' } }, '歌词来自 LRCLIB 开放歌词库。'));
  const m = modal({
    title: '查找歌词',
    width: 620,
    body: h('div', {}, seg, searchBox, paste),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, '取消'), useBtn],
  });
  search();
}

// ---------------- 查找封面 ----------------
export function openCoverSearch(track) {
  const artist = h('input', { class: 'input', value: track.albumArtist || track.artist, placeholder: '歌手' });
  const album = h('input', { class: 'input', value: track.album || track.title, placeholder: '专辑' });
  const grid = h('div', { class: 'cover-grid' });

  async function search() {
    clear(grid, h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('div', { class: 'spinner' })));
    try {
      const res = await window.api.invoke('cover:search', { artist: artist.value.trim(), album: album.value.trim() });
      if (!res.length) return clear(grid, h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, '没有找到封面，试试繁体或英文名'));
      clear(grid, res.map((r) => {
        const c = h('div', { class: 'cover' }, h('img', { src: r.thumb, loading: 'lazy' }));
        return h('div', { class: 'cover-pick', title: `${r.title} - ${r.artist}`, onclick: () => apply(r.url) }, c,
          h('div', { class: 'tile-name', style: { fontSize: '12.5px' } }, r.title),
          h('div', { class: 'tile-sub' }, `${r.source}${r.year ? ` · ${r.year}` : ''}`));
      }));
    } catch (e) {
      clear(grid, h('div', { class: 'ai-error' }, `搜索失败：${e.message}`));
    }
  }

  async function apply(url) {
    clear(grid, h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('div', { class: 'spinner' }), '正在下载封面…'));
    try {
      await window.api.invoke('cover:apply', track.id, url);
      toast('封面已更新（整张专辑）', 'success');
      m.close();
    } catch (e) {
      toast(`下载失败：${e.message}`, 'error');
      search();
    }
  }

  for (const inp of [artist, album]) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  const m = modal({
    title: '查找封面',
    width: 680,
    body: h('div', {},
      h('div', { class: 'search-row' }, artist, album, h('button', { class: 'btn btn-primary', onclick: search }, icon('search', 15), '搜索')),
      grid,
      h('div', { class: 'ai-note', style: { marginTop: '10px' } }, '封面来自 iTunes 与 Deezer，只保存在听音的数据目录里，不会改动你的音乐文件。')),
    footer: [
      h('button', { class: 'btn', style: { marginRight: 'auto' }, onclick: async () => { if (await window.api.invoke('cover:pickFile', track.id)) { toast('封面已更新', 'success'); m.close(); } } }, icon('folderOpen', 15), '从本地选择'),
      h('button', { class: 'btn', onclick: () => m.close() }, '关闭'),
    ],
  });
  search();
}

// ---------------- 均衡器 ----------------
export function openEq() {
  const eq = structuredClone(state.settings.eq);
  const commit = () => { applyEq(eq); saveSettings({ eq }); };
  const sw = h('button', { class: `switch ${eq.enabled ? 'on' : ''}`, onclick: () => { eq.enabled = !eq.enabled; sw.classList.toggle('on', eq.enabled); commit(); } });
  const values = [];
  const sliders = [];
  const band = (label, val, min, max, onInput, cls = '') => {
    const v = h('span', { class: 'v' }, (val > 0 ? '+' : '') + val);
    const r = h('input', { type: 'range', min, max, step: 0.5, value: val, oninput: (e) => {
      const x = Number(e.target.value);
      v.textContent = (x > 0 ? '+' : '') + x;
      onInput(x);
    }, onchange: commit, ondblclick: (e) => { e.target.value = 0; e.target.dispatchEvent(new Event('input')); commit(); } });
    return { el: h('div', { class: `eq-band ${cls}` }, v, r, h('span', {}, label)), r, v };
  };
  const pre = band('前级', eq.preamp, -12, 12, (x) => { eq.preamp = x; applyEq(eq); }, 'pre');
  const bands = EQ_FREQS.map((f, i) => {
    const b = band(f >= 1000 ? `${f / 1000}k` : String(f), eq.bands[i], -12, 12, (x) => {
      eq.bands[i] = x;
      eq.preset = '自定义';
      chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      if (!eq.enabled) { eq.enabled = true; sw.classList.add('on'); }
      applyEq(eq);
    });
    values.push(b.v);
    sliders.push(b.r);
    return b.el;
  });
  const chips = h('div', { class: 'eq-presets' }, Object.keys(EQ_PRESETS).map((name) =>
    h('button', { class: `chip ${eq.preset === name ? 'active' : ''}`, onclick: (e) => {
      eq.bands = [...EQ_PRESETS[name]];
      eq.preset = name;
      eq.enabled = name !== '平直' || eq.enabled;
      sw.classList.toggle('on', eq.enabled);
      sliders.forEach((s, i) => { s.value = eq.bands[i]; values[i].textContent = (eq.bands[i] > 0 ? '+' : '') + eq.bands[i]; });
      chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === e.target));
      commit();
    } }, name)));
  modal({
    title: '均衡器',
    width: 640,
    body: h('div', { class: 'eq' },
      h('div', { class: 'eq-top' }, sw, h('div', { class: 'grow' }, h('b', {}, '启用均衡器'), h('div', { class: 'ai-note' }, '双击滑块归零。开启后会自动压低前级增益，避免爆音。'))),
      chips,
      h('div', { class: 'eq-bands' }, pre.el, bands)),
  });
}

// ---------------- 设置 ----------------
const SECTIONS = [
  ['library', '资料库', 'library'],
  ['playback', '播放', 'play'],
  ['lyrics', '歌词与封面', 'mic'],
  ['desktop', '桌面歌词', 'captions'],
  ['ai', 'AI 赏析', 'sparkles'],
  ['bot', 'Bot 接入', 'bot'],
  ['look', '外观', 'sun'],
  ['about', '关于', 'disc'],
];

const row = (t, d, control) => h('div', { class: 'set-row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, t), d && h('div', { class: 'd' }, d)), control);

function switchCtl(value, onChange) {
  const el = h('button', { class: `switch ${value ? 'on' : ''}`, onclick: () => { value = !value; el.classList.toggle('on', value); onChange(value); } });
  return el;
}

function segCtl(options, value, onChange) {
  const el = h('div', { class: 'seg' }, options.map(([k, label]) => h('button', { class: value === k ? 'active' : '', onclick: (e) => {
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.target));
    onChange(k);
  } }, label)));
  return el;
}

export function openSettings(section = 'library') {
  const main = h('div', { class: 'settings-main' });
  const nav = h('div', { class: 'settings-nav' });
  const show = (key) => {
    nav.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.k === key));
    clear(main, PAGES[key]());
  };
  for (const [k, label, ic] of SECTIONS) nav.append(h('div', { class: 'nav-item', dataset: { k }, onclick: () => show(k) }, icon(ic, 17), h('span', { class: 'label' }, label)));
  const s = () => state.settings;

  const PAGES = {
    library() {
      const folders = h('div', {});
      const draw = () => clear(folders, state.folders.length ? state.folders.map((f) => h('div', { class: 'folder-row' }, icon('folder', 16),
        h('div', { class: 'grow', title: f }, f),
        h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
          await window.api.invoke('lib:removeFolder', f);
          state.folders = state.folders.filter((x) => x !== f);
          draw();
        } }, '移除'))) : h('div', { class: 'ai-note' }, '还没有添加音乐文件夹'));
      draw();
      return h('div', {},
        h('div', { class: 'set-group' }, h('h4', {}, '音乐文件夹'), folders,
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
            h('button', { class: 'btn btn-primary', onclick: async () => { const added = await window.api.invoke('lib:pickFolder'); if (added.length) { state.folders.push(...added); draw(); } } }, icon('plus', 15), '添加文件夹'),
            h('button', { class: 'btn', onclick: () => { window.api.invoke('lib:rescan'); toast('开始重新扫描'); } }, icon('refresh', 15), '重新扫描'))),
        h('div', { class: 'set-group' }, h('h4', {}, '索引'),
          row('歌曲总数', `${state.tracks.length} 首，${new Set(state.tracks.map((t) => t.album).filter(Boolean)).size} 张专辑`, null),
          row('自动监视', '文件夹里新增、删除音乐文件时自动更新索引；外接硬盘拔掉时保留原有索引。', h('span', { class: 'status ok' }, '已开启')),
          row('导入歌单', '支持 M3U / M3U8，按文件路径匹配资料库里的歌曲。', h('button', { class: 'btn btn-sm', onclick: async () => {
            const r = await window.api.invoke('pl:import');
            if (r.length) { state.playlists.push(...r); emit('playlists'); toast(`导入了 ${r.length} 个歌单`, 'success'); }
          } }, icon('upload', 14), '导入'))));
    },
    playback() {
      const ff = h('span', { class: 'status' }, '检测中…');
      const check = async () => {
        const ok = await window.api.invoke('settings:ffmpeg');
        ff.className = `status ${ok ? 'ok' : 'warn'}`;
        ff.textContent = ok ? '可用' : '未找到';
      };
      check();
      return h('div', {},
        h('div', { class: 'set-group' }, h('h4', {}, '播放'),
          row('均衡器', '10 段均衡器与预设', h('button', { class: 'btn btn-sm', onclick: openEq }, icon('eq', 14), '打开')),
          row('关闭窗口时最小化到托盘', '音乐继续播放，从托盘图标恢复窗口', switchCtl(s().closeToTray, (v) => saveSettings({ closeToTray: v })))),
        h('div', { class: 'set-group' }, h('h4', {}, '格式支持'),
          row('ffmpeg', 'APE、WMA、DSD、ALAC、WavPack 等格式需要 ffmpeg 转码后播放，转码结果会缓存。', ff),
          row('ffmpeg 路径', s().ffmpegPath || '留空则使用系统 PATH 里的 ffmpeg', h('button', { class: 'btn btn-sm', onclick: async () => {
            const p = await window.api.invoke('settings:pickFfmpeg');
            if (p) { await saveSettings({ ffmpegPath: p }); show('playback'); }
          } }, '选择…'))));
    },
    lyrics() {
      return h('div', {}, h('div', { class: 'set-group' }, h('h4', {}, '歌词'),
        row('自动在线查找歌词', '本地没有 .lrc 文件也没有内嵌歌词时，从 LRCLIB 查找并缓存。', switchCtl(s().lyrics.online, (v) => saveSettings({ lyrics: { online: v } }))),
        row('歌词来源顺序', '手动选择的歌词 → 同名 .lrc 文件 → 文件内嵌歌词 → LRCLIB 在线歌词', null)),
      h('div', { class: 'set-group' }, h('h4', {}, '图片'),
        row('歌手图片', '在歌手页面从 Deezer 获取歌手照片并缓存。', switchCtl(s().lyrics.artistImages, (v) => saveSettings({ lyrics: { artistImages: v } }))),
        row('自动补全专辑封面', '播放到没有封面的专辑时，从 iTunes / Deezer 查找匹配度高的封面。也可以在右键菜单「查找封面」手动挑选。', switchCtl(s().lyrics.autoCover, (v) => saveSettings({ lyrics: { autoCover: v } })))));
    },
    desktop() {
      const dl = s().desktopLyrics;
      const size = h('input', { type: 'range', min: 18, max: 72, value: dl.fontSize, style: { width: '180px' }, onchange: (e) => saveSettings({ desktopLyrics: { fontSize: Number(e.target.value) } }) });
      return h('div', {}, h('div', { class: 'set-group' }, h('h4', {}, '桌面歌词'),
        row('显示桌面歌词', '置顶显示在桌面上，可拖动位置、调整宽度', switchCtl(dl.enabled, (v) => saveSettings({ desktopLyrics: { enabled: v } }))),
        row('锁定', '锁定后鼠标可以穿透歌词操作下面的窗口；鼠标移到歌词上会出现解锁按钮', switchCtl(dl.locked, (v) => saveSettings({ desktopLyrics: { locked: v } }))),
        row('显示翻译', '歌词带翻译时显示第二行', switchCtl(dl.showTrans, (v) => saveSettings({ desktopLyrics: { showTrans: v } }))),
        row('字号', null, size),
        row('颜色', '已唱部分的颜色', segCtl([['blue', '蓝色'], ['white', '白色'], ['dark', '深色']], dl.color, (v) => saveSettings({ desktopLyrics: { color: v } })))));
    },
    ai() {
      const ai = s().ai;
      const key = h('input', { class: 'input', type: 'password', placeholder: ai.hasKey ? '已保存（输入新的 Key 可替换）' : ai.envKey ? '已从环境变量读取，可留空' : 'sk-ant-…' });
      const base = h('input', { class: 'input', value: ai.baseURL || '', placeholder: '留空使用官方地址 https://api.anthropic.com' });
      const model = h('select', { class: 'input' }, [
        ['claude-opus-5-5', 'Claude Opus 5.5（默认）'],
        ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
        ['claude-haiku-5-5', 'Claude Haiku 5.5'],
      ].map(([v, label]) => h('option', { value: v, selected: ai.model === v }, label)));
      model.addEventListener('change', () => saveSettings({ ai: { model: model.value } }));
      const status = h('span', { class: `status ${ai.hasKey || ai.envKey ? 'ok' : 'warn'}` }, ai.hasKey ? '已配置' : ai.envKey ? '使用环境变量' : '未配置');
      return h('div', {},
        h('div', { class: 'set-group' }, h('h4', {}, '连接 Claude'),
          row('API Key', '保存在本机并用 Windows 凭据加密，不会显示在界面上。', status),
          h('div', { class: 'search-row', style: { margin: '4px 0 12px' } }, key,
            h('button', { class: 'btn btn-primary', onclick: async () => {
              await saveSettings({ ai: { apiKey: key.value } });
              key.value = '';
              toast('API Key 已保存', 'success');
              show('ai');
            } }, '保存'),
            ai.hasKey ? h('button', { class: 'btn btn-danger', onclick: async () => { await saveSettings({ ai: { apiKey: '' } }); show('ai'); } }, '清除') : null),
          row('接口地址', '使用代理或中转服务时填写。', null),
          h('div', { class: 'search-row', style: { margin: '4px 0 12px' } }, base, h('button', { class: 'btn', onclick: async () => { await saveSettings({ ai: { baseURL: base.value.trim() } }); toast('已保存', 'success'); } }, '保存')),
          row('模型', null, model),
          row('思考深度', '「快」出字最快，适合边听边看；「深」分析更细，等待更久。', segCtl([['low', '快'], ['medium', '中'], ['high', '深']], ai.effort, (v) => saveSettings({ ai: { effort: v } })))),
        h('div', { class: 'set-group' }, h('h4', {}, '实时赏析'),
          row('切歌时自动生成', '打开 AI 赏析后，每换一首歌自动生成逐段解读与整体赏析（会消耗 API 额度，结果会缓存）。', switchCtl(ai.autoTimeline, (v) => saveSettings({ ai: { autoTimeline: v } })))));
    },
    bot() {
      const m = s().mcp || {};
      const st = h('span', { class: 'status' }, '检测中…');
      const info = h('div', {});
      const port = h('input', { class: 'input', type: 'number', min: 1024, max: 65535, value: m.port || 17890, style: { width: '110px' } });
      const apply = async (patch) => {
        const r = await window.api.invoke('mcp:set', patch);
        state.settings.mcp = { ...state.settings.mcp, ...patch, token: r.token, port: r.port };
        draw(r);
      };
      const copy = (text, what) => { navigator.clipboard.writeText(text); toast(`已复制${what}`, 'success'); };
      const draw = async (r) => {
        st.className = `status ${r.running ? 'ok' : r.enabled ? 'warn' : ''}`;
        st.textContent = r.running ? '运行中' : r.enabled ? (r.error || '未启动') : '已关闭';
        if (!r.running) return clear(info);
        const stdio = await window.api.invoke('mcp:stdioCommand');
        const httpConf = JSON.stringify({ mcpServers: { tingyin: { type: 'http', url: r.url, headers: { Authorization: `Bearer ${r.token}` } } } }, null, 2);
        const stdioConf = JSON.stringify({ mcpServers: { tingyin: { command: stdio.command, args: stdio.args, env: stdio.env } } }, null, 2);
        clear(info,
          row('HTTP 地址', '支持 Streamable HTTP 的客户端直接填这个地址，带上下面的令牌。', h('button', { class: 'btn btn-sm', onclick: () => copy(r.url, '地址') }, '复制')),
          h('div', { class: 'mcp-code' }, r.lan ? `${r.url}
局域网内其他设备：把 127.0.0.1 换成这台电脑的局域网 IP` : r.url),
          row('访问令牌', '请求头 Authorization: Bearer <令牌>，或在地址后加 ?token=<令牌>。令牌泄露时点「重新生成」。',
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', { class: 'btn btn-sm', onclick: () => copy(r.token, '令牌') }, '复制'),
              h('button', { class: 'btn btn-sm', onclick: () => apply({ resetToken: true }) }, '重新生成'))),
          row('HTTP 配置', '适用于 Claude Code、Cursor 以及多数 Bot 框架', h('button', { class: 'btn btn-sm', onclick: () => copy(httpConf, ' HTTP 配置') }, '复制')),
          h('div', { class: 'mcp-code' }, httpConf),
          row('stdio 配置', '只支持命令行方式的客户端用这个（Claude Desktop 等）；听音没开时会自动启动它。', h('button', { class: 'btn btn-sm', onclick: () => copy(stdioConf, ' stdio 配置') }, '复制')),
          h('div', { class: 'mcp-code' }, stdioConf));
      };
      window.api.invoke('mcp:status').then(draw);
      const tools = ['now_playing', 'player_control', 'search_tracks', 'play', 'add_to_queue', 'get_queue', 'set_volume', 'seek', 'set_play_mode', 'set_loved', 'list_playlists', 'list_categories', 'get_lyrics', 'classify_library'];
      return h('div', {},
        h('div', { class: 'set-group' }, h('h4', {}, 'MCP 服务'),
          row('开启 MCP 服务', '让你的 Bot / AI 助手通过 Model Context Protocol 搜歌、点歌、切歌、调音量、看歌词。', h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, st, switchCtl(m.enabled, (v) => apply({ enabled: v })))),
          row('端口', '默认 17890，被占用时换一个', h('div', { style: { display: 'flex', gap: '6px' } }, port, h('button', { class: 'btn btn-sm', onclick: () => apply({ port: Number(port.value) }) }, '应用'))),
          row('允许局域网访问', '关闭时只有本机程序能连；打开后同一局域网的设备凭令牌也能控制。', switchCtl(m.lan, (v) => apply({ lan: v }))),
          info),
        h('div', { class: 'set-group' }, h('h4', {}, '提供的工具'), h('div', { class: 'mcp-tools' }, tools.map((t) => h('span', {}, t))),
          h('p', { class: 'ai-note', style: { marginTop: '10px' } }, '例：对 Bot 说「放点适合睡前听的粤语歌」，它会调用 play {"scene":"睡前","lang":"粤语"}。')));
    },
    look() {
      return h('div', {}, h('div', { class: 'set-group' }, h('h4', {}, '外观'),
        row('主题', null, segCtl([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']], s().theme, (v) => saveSettings({ theme: v })))));
    },
    about() {
      const u = () => state.update || {};
      const stText = h('span', { class: 'status' });
      const btn = h('button', { class: 'btn btn-sm btn-primary' });
      const notes = h('div', {});
      const draw = () => {
        const x = u();
        const map = {
          checking: ['正在检查…', ''], latest: ['已是最新版本', 'ok'], available: [`发现新版本 ${x.version}`, 'warn'],
          downloading: [`正在下载 ${x.percent || 0}%`, 'warn'], ready: ['下载完成', 'ok'], error: [x.error, 'warn'], unsupported: [x.error, 'warn'],
        };
        const [t, cls] = map[x.status] || ['', ''];
        stText.className = `status ${cls}`;
        stText.textContent = t || '';
        stText.hidden = !t;
        const action = x.status === 'available' ? ['一键更新', () => window.api.invoke('update:install')]
          : x.status === 'ready' ? ['重启并更新', () => window.api.invoke('update:install')]
            : x.status === 'unsupported' && x.portable ? ['打开下载页', () => window.api.invoke('update:releases')]
              : ['检查更新', () => window.api.invoke('update:check')];
        btn.textContent = action[0];
        btn.onclick = action[1];
        btn.disabled = ['checking', 'downloading'].includes(x.status);
        clear(notes, x.notes && ['available', 'downloading', 'ready'].includes(x.status) ? h('div', { class: 'mcp-code' }, x.notes) : null);
      };
      draw();
      const off = on('update', () => { if (stText.isConnected) draw(); else off(); });
      return h('div', {},
        h('div', { class: 'set-group' }, h('h4', {}, '软件更新'),
          row(`当前版本 ${u().current || ''}`, '新版本发布在 GitHub，点「一键更新」会下载并静默安装，完成后自动重启，设置和资料库都会保留。', h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, stText, btn)),
          notes,
          row('启动时自动检查更新', '有新版本时标题栏右上角会出现更新按钮', switchCtl(s().update?.autoCheck !== false, (v) => saveSettings({ update: { autoCheck: v } })))),
        h('div', { class: 'set-group' }, h('h4', {}, `听音 ${u().current || ''}`),
        h('p', { class: 'modal-msg' }, '一个按苹果式简约设计语言做的本地音乐播放器。\n功能参考 MusicBee：资料库索引、分类浏览、歌单、均衡器、桌面歌词、在线歌词与封面，另外加了 AI 实时赏析、AI 分类，并通过 MCP 开放给 Bot 控制。\n\n歌词：LRCLIB（lrclib.net）\n封面：iTunes Search API、Deezer API\nAI：Anthropic Claude')));
    },
  };

  modal({
    title: '设置',
    width: 900,
    body: h('div', { class: 'settings' }, nav, main),
  });
  show(section);
}

