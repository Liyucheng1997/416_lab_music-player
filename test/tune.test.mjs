import test from 'node:test';
import assert from 'node:assert/strict';
import { AiService, normalizeProfile } from '../src/main/ai.js';

test('normalizeProfile 截断到 ±12、步长 0.5、补齐 10 段', () => {
  const p = normalizeProfile({ key: '流行', name: '人声透亮', preamp: -20, bands: [1.26, 30, -40, 'x'], why: 'w' });
  assert.equal(p.preamp, -12);
  assert.deepEqual(p.bands, [1.5, 12, -12, 0, 0, 0, 0, 0, 0, 0]);
});

function fakeService(reply) {
  const ai = new AiService({ dir: '.', getSettings: () => ({ ai: {} }) });
  const calls = [];
  ai.run = async (_id, params) => { calls.push(params); return JSON.stringify(reply); };
  return { ai, calls };
}

test('曲库模式：按类型给 key 枚举，丢掉多余和重复的曲线', async () => {
  const { ai, calls } = fakeService({
    device: '小音箱',
    profiles: [
      { key: '流行', name: 'A', preamp: 0, bands: [0, 0, 1, 2, 0, 0, 1, 1, 0, 0], why: '' },
      { key: '流行', name: '重复', preamp: 0, bands: [], why: '' },
      { key: '默认', name: 'B', preamp: -1, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], why: '' },
    ],
    tips: [{ title: 't', detail: 'd' }],
  });
  const r = await ai.tune('r1', {
    mode: 'library',
    groups: [{ key: '流行', count: 10, artists: ['周杰伦'] }, { key: '摇滚', count: 5 }],
    device: { type: '蓝牙小音箱', label: 'Speakers (Bluetooth)', volume: 0.5 },
    wish: '人声清楚',
  });
  assert.deepEqual(r.profiles.map((p) => p.name), ['A', 'B']);
  const schema = calls[0].format;
  assert.deepEqual(schema.properties.profiles.items.properties.key.enum, ['流行', '摇滚', '默认']);
  const prompt = calls[0].messages[0].content;
  assert.match(prompt, /蓝牙小音箱/);
  assert.match(prompt, /音量：50%/);
  assert.match(prompt, /人声清楚/);
});

test('单曲模式：只有「当前歌曲」一条', async () => {
  const { ai, calls } = fakeService({ device: '', profiles: [{ key: '当前歌曲', name: 'X', preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], why: '' }], tips: [] });
  const r = await ai.tune('r2', { mode: 'now', track: { title: '晴天', artist: '周杰伦' }, tags: { style: '流行', mood: ['怀旧'] }, device: { type: '入耳式耳机' } });
  assert.equal(r.profiles.length, 1);
  assert.match(calls[0].messages[0].content, /晴天[\s\S]*风格：流行[\s\S]*情绪：怀旧/);
});

test('没有可用曲线时报错', async () => {
  const { ai } = fakeService({ device: '', profiles: [], tips: [] });
  await assert.rejects(ai.tune('r3', { mode: 'library', groups: [], device: {} }));
});
