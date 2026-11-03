import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 预加载脚本只放行白名单里的通道，新增 IPC 忘了加白名单会被静默丢弃
const root = path.resolve(import.meta.dirname, '..');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.cjs'), 'utf8');
const allowed = (name) => new Set([...preload.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
const lists = { invoke: allowed('INVOKE'), send: allowed('SEND'), on: allowed('LISTEN') };

test('页面用到的 IPC 通道都在预加载白名单里', () => {
  const dir = path.join(root, 'src/renderer/js');
  const missing = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/window\.api\.(invoke|send|on)\('([^']+)'/g)) {
      if (!lists[m[1]].has(m[2])) missing.push(`${f}: ${m[1]}('${m[2]}')`);
    }
  }
  assert.deepEqual(missing, []);
});
