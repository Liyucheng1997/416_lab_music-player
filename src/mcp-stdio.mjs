// 听音 MCP stdio 桥接：只支持 stdio 的客户端用它连接正在运行的听音
// 从 stdin 逐行读 JSON-RPC，转发到听音的本机 HTTP 服务，再把回复写回 stdout
// 连接信息（地址、令牌）由听音启动 MCP 服务时写在 %APPDATA%\听音\mcp.json
// 客户端（如 Claude）每次开会话都会启动本脚本并握手、列工具：听音没开时这些请求用上次缓存的结果就地回答，
// 不去启动听音；只有真正调用工具（比如让它放歌）时才把听音打开
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const DATA = process.env.TINGYIN_DATA || path.join(process.env.APPDATA || path.join(process.env.HOME || '', '.config'), '听音');
const INFO = path.join(DATA, 'mcp.json');
const LAST = path.join(DATA, 'mcp-last.json'); // 程序路径 + 握手 / 工具列表缓存
const log = (...a) => process.stderr.write(`[tingyin-mcp] ${a.join(' ')}\n`);
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

let last = readJson(LAST) || {};
function remember(patch) {
  last = { ...last, ...patch };
  try { fs.writeFileSync(LAST, JSON.stringify(last)); } catch { /* 只是缓存 */ }
}

// mcp.json 存在且记录的进程还活着才算听音在运行（异常退出时文件可能没删掉）
function liveInfo() {
  const info = readJson(INFO);
  if (!info) return null;
  if (info.pid) {
    try { process.kill(info.pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; }
  }
  return info;
}

let launched = false;
async function launchAndWait() {
  const exe = process.env.TINGYIN_EXE || last.exe;
  if (exe && !launched && fs.existsSync(exe)) {
    launched = true;
    log('听音没有运行，正在启动', exe);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(exe, [], { detached: true, stdio: 'ignore', env }).unref();
  }
  let info = null;
  for (let i = 0; i < 40 && !info; i++) {
    await new Promise((r) => setTimeout(r, 500));
    info = liveInfo();
  }
  if (!info) throw new Error('听音没有运行，或者没有在 设置 → Bot 接入 里打开 MCP 服务');
  return info;
}

let protocolVersion = null;
async function post(info, msg) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${info.token}` };
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
  const res = await fetch(info.url, { method: 'POST', headers, body: JSON.stringify(msg) });
  if (res.status === 202) return null;
  return res.json();
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

// 听音没开时就地回答的请求；只有 tools/call 返回 undefined，表示必须交给听音
function answerOffline(m) {
  if (!m || typeof m.method !== 'string') return undefined;
  if (m.id == null) return null; // 通知，不用回
  switch (m.method) {
    case 'initialize': {
      const cached = last.initialize || {};
      return ok(m.id, {
        protocolVersion: m.params?.protocolVersion || cached.protocolVersion || '2025-06-18',
        capabilities: cached.capabilities || { tools: { listChanged: false } },
        serverInfo: cached.serverInfo || { name: 'tingyin', title: '听音音乐播放器', version: '0' },
        ...(cached.instructions ? { instructions: cached.instructions } : {}),
      });
    }
    case 'ping': return ok(m.id, {});
    case 'tools/list': return ok(m.id, last.tools || { tools: [] });
    case 'resources/list': return ok(m.id, { resources: [] });
    case 'prompts/list': return ok(m.id, { prompts: [] });
    case 'resources/templates/list': return ok(m.id, { resourceTemplates: [] });
    case 'tools/call': return undefined;
    // 客户端还会探测 logging/setLevel、completion/complete 等，听音都不支持，直接回绝，别为它们把听音打开
    default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

async function forward(msg) {
  const list = [].concat(msg);
  let info = liveInfo();
  if (!info) {
    const offline = list.map(answerOffline);
    if (offline.every((r) => r !== undefined)) {
      const replies = offline.filter(Boolean);
      return Array.isArray(msg) ? (replies.length ? replies : null) : replies[0] || null;
    }
    // 真正要用播放器（调用工具）才启动听音
    info = await launchAndWait();
  }
  let body;
  try {
    body = await post(info, msg);
  } catch (e) {
    if (e?.cause?.code !== 'ECONNREFUSED') throw e;
    info = await launchAndWait();
    body = await post(info, msg);
  }
  if (info.exe && info.exe !== last.exe) remember({ exe: info.exe });
  const replies = [].concat(body ?? []);
  for (const m of list) {
    const r = m?.id != null && replies.find((x) => x?.id === m.id);
    if (!r?.result) continue;
    if (m.method === 'initialize') {
      if (r.result.protocolVersion) protocolVersion = r.result.protocolVersion;
      remember({ initialize: r.result });
    } else if (m.method === 'tools/list') remember({ tools: r.result });
  }
  return body;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  try {
    const reply = await forward(msg);
    if (reply) out(reply);
  } catch (e) {
    const err = e?.cause?.code === 'ECONNREFUSED' ? '连不上听音，请确认听音正在运行并打开了 MCP 服务' : String(e?.message || e);
    log(err);
    for (const m of [].concat(msg)) if (m?.id != null) out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: err } });
  }
});
// stdin 关闭后不主动 process.exit：Windows 上和 fetch 正在关闭的连接抢跑会触发 libuv 断言，等事件循环自然结束即可
