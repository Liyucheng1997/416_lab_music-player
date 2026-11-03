// MCP 服务：让外部 Bot（Claude、自建机器人等）通过 Model Context Protocol 控制听音
// 传输用 Streamable HTTP（无会话、直接返回 JSON），另有 src/mcp-stdio.mjs 把 stdio 转成 HTTP
import http from 'node:http';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const newToken = () => crypto.randomBytes(18).toString('base64url');

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export class McpServer {
  // tools: [{ name, title, description, inputSchema, annotations, run(args) }]
  constructor({ dir, version, tools, instructions, getConfig }) {
    this.infoFile = path.join(dir, 'mcp.json');
    this.version = version;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.instructions = instructions;
    this.getConfig = getConfig; // () => { enabled, port, lan, token }
    this.server = null;
    this.error = '';
  }

  get running() { return !!this.server?.listening; }

  status() {
    const c = this.getConfig();
    return { enabled: c.enabled, running: this.running, port: c.port, lan: c.lan, url: `http://127.0.0.1:${c.port}/mcp`, token: c.token, error: this.error };
  }

  async restart() {
    await this.stop();
    const c = this.getConfig();
    if (!c.enabled) return this.status();
    this.error = '';
    const server = http.createServer((req, res) => this.onRequest(req, res).catch((e) => {
      if (!res.headersSent) this.json(res, 500, rpcError(null, -32603, String(e?.message || e)));
    }));
    await new Promise((resolve) => {
      server.once('error', (e) => {
        this.error = e.code === 'EADDRINUSE' ? `端口 ${c.port} 已被占用，换一个端口试试` : String(e.message || e);
        resolve();
      });
      server.listen(c.port, c.lan ? '0.0.0.0' : '127.0.0.1', () => { this.server = server; resolve(); });
    });
    // 写一份连接信息，供 stdio 桥接脚本读取
    if (this.running) await fsp.writeFile(this.infoFile, JSON.stringify({ url: `http://127.0.0.1:${c.port}/mcp`, token: c.token, exe: process.execPath, pid: process.pid }));
    return this.status();
  }

  async stop() {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise((r) => s.close(() => r()));
    s.closeAllConnections?.();
    await fsp.rm(this.infoFile, { force: true });
  }

  json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  authorized(req, url) {
    const token = this.getConfig().token;
    const header = req.headers.authorization || '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : url.searchParams.get('token') || '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async onRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/mcp') return this.json(res, 404, { error: 'not found，MCP 地址是 /mcp' });
    // 浏览器页面不允许调用（防止网页借本机地址操作播放器）
    if (req.headers.origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin)) return this.json(res, 403, rpcError(null, -32600, 'origin not allowed'));
    if (!this.authorized(req, url)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return this.json(res, 401, rpcError(null, -32001, '缺少或错误的访问令牌：在请求头加 Authorization: Bearer <令牌>，或在地址后加 ?token=<令牌>'));
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return this.json(res, 405, rpcError(null, -32000, '只支持 POST（无会话模式，不提供 SSE 推送）'));
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1e6) return this.json(res, 413, rpcError(null, -32600, 'request too large'));
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.json(res, 400, rpcError(null, -32700, 'Parse error'));
    }
    const batch = Array.isArray(msg);
    const replies = (await Promise.all((batch ? msg : [msg]).map((m) => this.dispatch(m)))).filter(Boolean);
    if (!replies.length) return this.json(res, 202); // 只有通知 / 响应
    return this.json(res, 200, batch ? replies : replies[0]);
  }

  async dispatch(m) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      return m && 'id' in m && !('result' in m || 'error' in m) ? rpcError(m.id, -32600, 'Invalid Request') : null;
    }
    const isRequest = m.id !== undefined && m.id !== null;
    if (!isRequest) return null; // notifications/initialized 等
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tingyin', title: '听音音乐播放器', version: this.version },
          instructions: this.instructions,
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: [...this.tools.values()].map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
        });
      case 'tools/call': {
        const tool = this.tools.get(m.params?.name);
        if (!tool) return rpcError(m.id, -32602, `没有这个工具：${m.params?.name}`);
        try {
          const result = await tool.run(m.params.arguments || {});
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
          return ok({ content: [{ type: 'text', text }], ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result } : {}) });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: String(e?.message || e) }], isError: true });
        }
      }
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      default:
        return rpcError(m.id, -32601, `Method not found: ${m.method}`);
    }
  }
}
