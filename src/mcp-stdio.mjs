// 听音 MCP stdio 桥接：只支持 stdio 的客户端用它连接正在运行的听音
// 从 stdin 逐行读 JSON-RPC，转发到听音的本机 HTTP 服务，再把回复写回 stdout
// 连接信息（地址、令牌）由听音启动 MCP 服务时写在 %APPDATA%\听音\mcp.json；听音没开时会尝试把它启动起来
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const DATA = process.env.TINGYIN_DATA || path.join(process.env.APPDATA || path.join(process.env.HOME || '', '.config'), '听音');
const INFO = path.join(DATA, 'mcp.json');
const log = (...a) => process.stderr.write(`[tingyin-mcp] ${a.join(' ')}\n`);
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const readInfo = () => { try { return JSON.parse(fs.readFileSync(INFO, 'utf8')); } catch { return null; } };
let launched = false;

async function ensureInfo() {
  let info = readInfo();
  if (info) return info;
  // 听音没开或 MCP 服务没打开：用上次记录的程序路径把听音启动起来，再等它写出连接信息
  const exe = process.env.TINGYIN_EXE || readLast()?.exe;
  if (exe && !launched && fs.existsSync(exe)) {
    launched = true;
    log('听音没有运行，正在启动', exe);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(exe, [], { detached: true, stdio: 'ignore', env }).unref();
  }
  for (let i = 0; i < 40 && !info; i++) {
    await new Promise((r) => setTimeout(r, 500));
    info = readInfo();
  }
  if (!info) throw new Error('听音没有运行，或者没有在 设置 → Bot 接入 里打开 MCP 服务');
  return info;
}

// 记住程序路径，下次听音没开时可以自动启动
const LAST = path.join(DATA, 'mcp-last.json');
const readLast = () => { try { return JSON.parse(fs.readFileSync(LAST, 'utf8')); } catch { return null; } };

let protocolVersion = null;
async function forward(msg) {
  const info = await ensureInfo();
  try { fs.writeFileSync(LAST, JSON.stringify({ exe: info.exe })); } catch { /* 只是缓存 */ }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${info.token}` };
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
  const res = await fetch(info.url, { method: 'POST', headers, body: JSON.stringify(msg) });
  if (res.status === 202) return null;
  const body = await res.json();
  if (msg.method === 'initialize' && body?.result?.protocolVersion) protocolVersion = body.result.protocolVersion;
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
