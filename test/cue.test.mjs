import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCue, isImage } from '../src/main/cue.js';

const CUE = `REM GENRE Classical
REM DATE 1965
PERFORMER "Artur Rubinstein"
TITLE "The Chopin Collection [disc 1]"
FILE "disc 1.ape" WAVE
  TRACK 01 AUDIO
    TITLE "Nocturne, Op. 9 No. 1"
    PERFORMER "Artur Rubinstein"
    INDEX 00 00:00:00
    INDEX 01 00:00:33
  TRACK 02 AUDIO
    TITLE "Nocturne, Op. 9 No. 2"
    PERFORMER "[51ape.com]"
    INDEX 00 05:25:18
    INDEX 01 05:28:30
  TRACK 03 AUDIO
    TITLE "Nocturne, Op. 9 No. 3"
    INDEX 01 09:55:08
`;

test('解析 CUE：专辑信息、分轨起止、帧换算', () => {
  const s = parseCue(CUE);
  assert.equal(s.title, 'The Chopin Collection [disc 1]');
  assert.equal(s.performer, 'Artur Rubinstein');
  assert.equal(s.date, 1965);
  assert.equal(s.genre, 'Classical');
  assert.equal(s.files.length, 1);
  const [a, b, c] = s.files[0].tracks;
  assert.equal(a.start, 33 / 75);
  assert.equal(a.end, 5 * 60 + 25 + 18 / 75); // 下一首的 INDEX 00
  assert.equal(b.start, 5 * 60 + 28 + 30 / 75);
  assert.equal(b.performer, '', '水印演唱者应被丢弃');
  assert.equal(c.end, null);
  assert.ok(isImage(s.files[0]));
});

test('每首一个文件的 CUE 不需要拆分', () => {
  const s = parseCue('FILE "01.flac" WAVE\n TRACK 01 AUDIO\n  TITLE "A"\n  INDEX 01 00:00:00\nFILE "02.flac" WAVE\n TRACK 02 AUDIO\n  INDEX 01 00:00:00\n');
  assert.equal(s.files.length, 2);
  assert.ok(!isImage(s.files[0]));
});
