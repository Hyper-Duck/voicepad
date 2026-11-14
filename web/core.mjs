export const uid = () => globalThis.crypto.randomUUID();

export function parseTime(input) {
  const value = String(input).trim().replace(',', '.');
  if (/^\d+(?:\.\d{1,3})?$/.test(value)) return Number(value);
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return NaN;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] || '').padEnd(3, '0')) / 1000;
}

export function formatTime(seconds, srt = false) {
  const total = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  const ms = String(total % 1000).padStart(3, '0');
  const secs = Math.floor(total / 1000);
  const h = String(Math.floor(secs / 3600)).padStart(2, '0');
  const m = String(Math.floor(secs / 60) % 60).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${h}:${m}:${s}${srt ? ',' : '.'}${ms}`;
}

export function parseSrt(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('字幕文件是空的。');
  const cues = [];
  for (const [index, block] of text.split(/\n[\t ]*\n+/).entries()) {
    const lines = block.trim().split('\n');
    const line = lines.findIndex(value => value.includes('-->'));
    if (line < 0) throw new Error(`第 ${index + 1} 个字幕段缺少时间码。`);
    const times = lines[line].match(/^\s*(\d+:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{1,3})(?:\s+.*)?$/);
    if (!times) throw new Error(`第 ${index + 1} 个字幕段时间格式不正确。`);
    const start = parseTime(times[1]), end = parseTime(times[2]);
    const caption = lines.slice(line + 1).join('\n').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !caption) {
      throw new Error(`第 ${index + 1} 个字幕段需要有效的起止时间和文字。`);
    }
    cues.push({ id: uid(), start, end, text: caption });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function exportSrt(cues) {
  return [...cues].sort((a, b) => a.start - b.start).map((cue, i) =>
    `${i + 1}\n${formatTime(cue.start, true)} --> ${formatTime(cue.end, true)}\n${cue.text}\n`
  ).join('\n');
}

export function captionParts(text) {
  const match = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(text);
  return { speaker: match ? match[1] : '', text: (match ? match[2] : text).replace(/<\/?(?:i|b|u)>/gi, '') };
}

export function activeCue(cues, time) {
  return cues.find(cue => cue.start <= time + 0.001 && cue.end > time + 0.001) || null;
}

// Each subtitle owns its slice; speech in gaps stays available as separate clips.
export function partitionRecording(cues, start, duration, asset) {
  const end = start + duration;
  const edges = [...new Set([start, end, ...cues.flatMap(c => [c.start, c.end])
    .filter(t => t > start && t < end)])].sort((a, b) => a - b);
  const clips = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1];
    if (b - a < 0.001) continue;
    const cueId = activeCue(cues, (a + b) / 2)?.id || null;
    const previous = clips.at(-1);
    if (previous && previous.cueId === cueId) previous.duration += b - a;
    else clips.push({ id: uid(), asset, start: a, offset: a - start, duration: b - a, cueId });
  }
  return clips;
}

// Punch-in recording replaces the covered interval, preserving both outer pieces.
export function replaceInterval(clips, start, end) {
  return clips.flatMap(clip => {
    const tail = clip.start + clip.duration;
    if (tail <= start || clip.start >= end) return [{ ...clip }];
    const parts = [];
    if (clip.start < start) parts.push({ ...clip, duration: start - clip.start });
    if (tail > end) parts.push({ ...clip, id: uid(), start: end,
      offset: clip.offset + end - clip.start, duration: tail - end });
    return parts;
  });
}

export function moveCueClips(clips, cueId, delta) {
  return clips.map(clip => clip.cueId === cueId ? { ...clip, start: Math.max(0, clip.start + delta) } : clip);
}

export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const word = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  word(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); word(8, 'WAVE');
  word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}
