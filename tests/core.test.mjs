import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, exportSrt, parseTime, formatTime, partitionRecording,
  replaceInterval, moveCueClips, encodeWav, captionParts } from '../web/core.mjs';

test('SRT: BOM, CRLF, Unicode, multiline captions, round trip and millisecond carry', () => {
  const source = '\uFEFF1\r\n00:00:00,700 --> 00:00:05,124\r\n[A] First line\r\n第二行\r\n\r\n2\r\n01:02:03,004 --> 01:02:05,999\r\nEnd\r\n';
  const cues = parseSrt(source);
  assert.equal(cues[0].start, .7);
  assert.equal(cues[1].start, 3723.004);
  assert.deepEqual(captionParts(cues[0].text), { speaker: 'A', text: 'First line\n第二行' });
  assert.deepEqual(parseSrt(exportSrt(cues)).map(({ id, ...c }) => c), cues.map(({ id, ...c }) => c));
  assert.equal(formatTime(59.9996), '00:01:00.000');
});
test('reject invalid SRT and timing without silently discarding cues', () => {
  assert.throws(() => parseSrt('1\n00:00:04,000 --> 00:00:01,000\nBackwards'));
  assert.throws(() => parseSrt('1\n00:60:00,000 --> 00:61:00,000\nInvalid'));
  assert.throws(() => parseSrt('not an SRT file'));
  assert.ok(Number.isNaN(parseTime('-4')));
  assert.equal(parseTime('83.456'), 83.456);
});
test('continuous recording partitions at cue edges and preserves inter-cue speech', () => {
  const clips = partitionRecording([{ id: 'a', start: 1, end: 3 }, { id: 'b', start: 4, end: 7 }], .5, 8, 'take.wav');
  assert.deepEqual(clips.map(c => [c.start, c.offset, c.duration, c.cueId]),
    [[.5, 0, .5, null], [1, .5, 2, 'a'], [3, 2.5, 1, null], [4, 3.5, 3, 'b'], [7, 6.5, 1.5, null]]);
  const afterDeletingA = clips.filter(c => c.cueId !== 'a');
  assert.equal(afterDeletingA.reduce((sum, c) => sum + c.duration, 0), 6);
  assert.equal(afterDeletingA.find(c => c.cueId === 'b').offset, 3.5);
});
test('punch-in replacement preserves both outer pieces and their source offsets', () => {
  const old = [{ id: 'one', asset: 'a.wav', cueId: 'cue', start: 2, offset: 5, duration: 8 }];
  const cut = replaceInterval(old, 4, 7);
  assert.deepEqual(cut.map(c => [c.start, c.offset, c.duration]), [[2,5,2], [7,10,3]]);
  assert.equal(old[0].duration, 8);
  assert.equal(replaceInterval(old, 1, 12).length, 0);
});
test('moving a cue moves only its recordings and preserves source samples', () => {
  const clips = [{ cueId: 'a', start: 2, offset: 1.2 }, { cueId: 'b', start: 6, offset: 4 }];
  assert.deepEqual(moveCueClips(clips, 'a', .75), [{ cueId: 'a', start: 2.75, offset: 1.2 }, clips[1]]);
  assert.equal(clips[0].start, 2);
});
test('export is valid little-endian PCM WAV with correct signed extrema', () => {
  const wav = encodeWav(new Float32Array([-1,0,1,.5]), 48000);
  const view = new DataView(wav);
  assert.equal(new TextDecoder().decode(wav.slice(0,4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
});
