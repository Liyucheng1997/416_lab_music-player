// MCP 远程控制：主进程把 Bot 的播放指令转到这里执行，结果原样回传
import { state } from './store.js';
import { player, toggle, next, prev, seek, setVolume, toggleShuffle, cycleRepeat, playList, playNext, addToQueue } from './player.js';
import { toggleLove } from './views.js';

const COMMANDS = {
  state() {
    return {
      playing: player.playing,
      trackId: player.track?.id || null,
      position: Math.round(player.time),
      duration: Math.round(player.duration || 0),
      volume: Math.round(player.volume * 100),
      muted: player.muted,
      shuffle: player.shuffle,
      repeat: player.repeat,
      queueLength: player.queue.length,
      queueIndex: player.index,
    };
  },
  async control({ action }) {
    if (action === 'next') next();
    else if (action === 'previous') prev();
    else if (action === 'toggle' || (action === 'play' && !player.playing) || (action === 'pause' && player.playing)) await toggle();
    // 给 <audio> 一点时间切换状态，回报的状态才准确
    await new Promise((r) => setTimeout(r, 250));
    return COMMANDS.state();
  },
  async play({ ids, shuffle }) {
    playList(ids, shuffle ? Math.floor(Math.random() * ids.length) : 0, { shuffle });
    await new Promise((r) => setTimeout(r, 300));
    return COMMANDS.state();
  },
  enqueue({ ids, next: asNext }) {
    if (asNext) playNext(ids);
    else addToQueue(ids);
    return { queueLength: player.queue.length };
  },
  queue({ limit = 20 }) {
    const from = Math.max(0, player.index);
    return { index: player.index, total: player.queue.length, from, ids: player.queue.slice(from, from + limit) };
  },
  volume({ value }) {
    setVolume(Math.max(0, Math.min(100, value)) / 100);
    return { volume: Math.round(player.volume * 100) };
  },
  seek({ seconds }) {
    if (!player.track) throw new Error('现在没有在播放');
    seek(seconds);
    return { position: Math.round(player.time), duration: Math.round(player.duration || 0) };
  },
  mode({ shuffle, repeat }) {
    if (shuffle != null && shuffle !== player.shuffle) toggleShuffle();
    for (let i = 0; repeat && player.repeat !== repeat && i < 3; i++) cycleRepeat();
    return { shuffle: player.shuffle, repeat: player.repeat };
  },
  async love({ id, loved }) {
    const t = state.byId.get(id || player.track?.id);
    if (!t) throw new Error(id ? '资料库里没有这首歌' : '现在没有在播放');
    if (!!t.loved !== loved) await toggleLove(t);
    return { id: t.id, loved: !!t.loved };
  },
};

window.api.on('mcp:call', async ({ reqId, cmd, args }) => {
  try {
    const fn = COMMANDS[cmd];
    if (!fn) throw new Error(`unknown command ${cmd}`);
    window.api.send('mcp:reply', { reqId, result: await fn(args || {}) });
  } catch (e) {
    window.api.send('mcp:reply', { reqId, error: String(e?.message || e) });
  }
});
