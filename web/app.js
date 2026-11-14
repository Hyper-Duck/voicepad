import { uid, parseTime, formatTime, parseSrt, exportSrt, captionParts, activeCue,
  partitionRecording, replaceInterval, moveCueClips, encodeWav } from './core.mjs';

const $ = selector => document.querySelector(selector);
const video = $('#video');
const state = { session: null, mode: 'record', selected: null, busy: false,
  preparing: false, finishing: false, recording: null, undo: [], saveError: false,
  sessions: [], wait: false, previewEnd: null, lastActive: '', countdownToken: 0 };
let context, workletReady, micStream, captureNode, micSource, analyser, silentGain;
let voiceNodes = [], voiceToken = 0, voiceClock = null, lastSyncCheck = 0;
let saveQueue = Promise.resolve(), toastTimer;
const buffers = new Map();
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const locked = () => state.busy || state.preparing || state.finishing || !!state.recording;

function toast(message, error = false, duration = 6000) {
  clearTimeout(toastTimer);
  $('#toast span').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => $('#toast').hidden = true, duration);
}
function report(error) {
  console.error(error);
  const friendly = { NotAllowedError: '麦克风权限未开启。请在浏览器地址栏允许访问麦克风后重试。',
    NotFoundError: '没有找到麦克风，请连接设备后刷新麦克风列表。',
    NotReadableError: '麦克风暂时无法使用，请检查它是否被其他程序独占。' };
  toast(friendly[error.name] || error.message || String(error), true, 11000);
}
const run = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(report);
const listen = (selector, event, fn) => $(selector).addEventListener(event, run(fn));
async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function save() {
  if (!state.session) return Promise.resolve();
  const snapshot = structuredClone(state.session);
  const target = state.session;
  $('#save-status').textContent = '正在保存…';
  $('#save-status').classList.remove('failed');
  const task = saveQueue.then(async () => {
    snapshot.revision = target.revision;
    const result = await api(`/api/sessions/${snapshot.id}`, json('PUT', snapshot));
    target.revision = result.revision;
    target.updated = result.updated;
    state.saveError = false;
    $('#save-status').textContent = '已自动保存';
    $('#save-status').classList.remove('failed');
  });
  saveQueue = task.catch(error => {
    state.saveError = true;
    $('#save-status').textContent = '保存失败 · 请勿关闭';
    $('#save-status').classList.add('failed');
    report(error);
  });
  return task;
}
async function flush() {
  await saveQueue;
  if (state.saveError) throw new Error('当前 session 尚未保存成功。请先恢复本地服务，再重试操作。');
}
async function busy(fn) {
  if (locked()) return;
  state.busy = true; renderControls();
  try { return await fn(); }
  finally { state.busy = false; renderControls(); }
}

function renderControls() {
  const lock = locked(), rec = !!state.recording, ready = !!state.session?.video;
  for (const id of ['sessions','new-session','import-video','import-srt','export-srt','export-audio','previous-cue','next-cue','mode-record','mode-replay','refresh-mics','microphone','search','clear-recordings','undo']) {
    $('#' + id).disabled = lock;
  }
  $('#seek').disabled = lock || !ready;
  $('#play').disabled = state.busy || state.finishing || state.preparing || !ready;
  $('#record').disabled = state.busy || state.finishing || !ready || (!rec && !state.preparing && state.mode !== 'record');
  $('#record').innerHTML = state.preparing ? '<span>■</span> 取消准备' : rec ? '<span>■</span> 停止录音' : state.finishing ? '正在保存…' : '<span>●</span> 开始录音';
  $('#record').classList.toggle('recording', rec);
  $('#record-indicator').hidden = !rec;
  $('#mode-record').classList.toggle('active', state.mode === 'record');
  $('#mode-replay').classList.toggle('active', state.mode === 'replay');
  $('#mode-record').setAttribute('aria-pressed', state.mode === 'record');
  $('#mode-replay').setAttribute('aria-pressed', state.mode === 'replay');
  $('#mode-description').textContent = state.mode === 'record' ? '已录人声静音，专注录新的一遍' : '视频、字幕和已录人声同步播放';
  $('#export-audio').disabled = lock || !state.session?.clips.length;
  $('#export-srt').disabled = lock || !state.session?.cues.length;
  $('#clear-recordings').disabled = lock || !state.session?.clips.length;
  $('#undo').disabled = lock || !state.undo.length;
  $('#countdown-enabled').disabled = lock;
  document.querySelectorAll('.cue button,.cue input,.recording-item button').forEach(el => el.disabled = lock);
  $('#play').textContent = video.paused ? '▶' : 'Ⅱ';
  $('#play').setAttribute('aria-label', video.paused ? '播放视频' : '暂停视频');
}

function renderSessionList() {
  $('#sessions').innerHTML = state.sessions.map(s => `<option value="${escape(s.id)}">${escape(s.name)}</option>`).join('');
  if (state.session) $('#sessions').value = state.session.id;
}

function renderCues() {
  const s = state.session;
  if (!s) return;
  const query = $('#search').value.trim().toLowerCase();
  const counts = new Map();
  for (const clip of s.clips) counts.set(clip.cueId, (counts.get(clip.cueId) || 0) + 1);
  $('#cue-list').innerHTML = s.cues.map((cue, index) => {
    if (query && !cue.text.toLowerCase().includes(query)) return '';
    const { speaker, text } = captionParts(cue.text);
    const recorded = counts.has(cue.id);
    return `<article class="cue${state.selected === cue.id ? ' selected' : ''}" data-id="${escape(cue.id)}">
      <div class="cue-meta"><span class="cue-number">${String(index + 1).padStart(3, '0')}</span><span class="speaker-tag">${escape(speaker || '字幕')}</span><span class="cue-recorded">${recorded ? '● 已录' : ''}</span></div>
      <button class="cue-text" data-action="seek" title="跳到这一句">${escape(text)}</button>
      <div class="cue-time-row"><span>起</span><input data-time="start" aria-label="第 ${index + 1} 句开始时间" value="${formatTime(cue.start)}" spellcheck="false"><span>→</span><input data-time="end" aria-label="第 ${index + 1} 句结束时间" value="${formatTime(cue.end)}" spellcheck="false"><span class="cue-duration">${(cue.end - cue.start).toFixed(2)}s</span></div>
      <div class="cue-actions"><button data-action="record">● ${recorded ? '重录这一句' : '录这一句'}</button>${recorded ? '<button data-action="preview">▷ 试听</button><button data-action="delete" class="delete-cue">删除录音</button>' : ''}</div>
    </article>`;
  }).join('') || '<div class="script-empty">' + (s.cues.length ? '没有匹配的字幕。' : '导入 SRT，开始逐句配音。') + '</div>';
  $('#cue-count').textContent = `${s.cues.length} 句`;
  $('#progress-label').textContent = `已录 ${s.cues.filter(c => counts.has(c.id)).length} / ${s.cues.length} 句`;
  state.lastActive = '';
  renderControls();
  updateTime();
}

function timelineLength() {
  return Math.max(Number.isFinite(video.duration) ? video.duration : 0,
    ...state.session?.cues.map(c => c.end) || [0],
    ...state.session?.clips.map(c => c.start + c.duration) || [0], 1);
}

function renderTrack() {
  const s = state.session;
  if (!s) return;
  const usedAssets = new Set(s.clips.map(c => c.asset));
  for (const asset of buffers.keys()) if (!usedAssets.has(asset)) buffers.delete(asset);
  const length = timelineLength();
  $('#clip-count').textContent = `${s.clips.length} 段`;
  $('#recordings-summary').textContent = s.clips.length ? '可逐段试听或删除' : '暂无录音';
  $('#track').innerHTML = (s.clips.length ? s.clips.map(clip => {
    const index = s.cues.findIndex(c => c.id === clip.cueId);
    const label = index < 0 ? '句间录音' : `第 ${index + 1} 句`;
    return `<button class="track-clip" data-clip="${escape(clip.id)}" style="left:${clip.start / length * 100}%;width:${clip.duration / length * 100}%" title="${label} · ${formatTime(clip.start)}" aria-label="定位${label}录音"></button>`;
  }).join('') : '<span class="track-empty">录音会出现在这里 · 导出时保留与视频相同的时间位置</span>') + '<i id="playhead"></i>';
  $('#recording-list').innerHTML = [...s.clips].sort((a,b) => a.start - b.start).map(clip => {
    const index = s.cues.findIndex(c => c.id === clip.cueId);
    return `<div class="recording-item" data-clip="${escape(clip.id)}"><span>${index < 0 ? '句间录音' : `第 ${index + 1} 句`}</span><small>${formatTime(clip.start)} · ${clip.duration.toFixed(2)}s</small><button data-action="preview">试听</button><button data-action="delete" class="text-button danger-text">删除</button></div>`;
  }).join('');
  renderControls();
}

function updateTime() {
  if (!state.session) return;
  const time = video.currentTime || 0, s = state.session;
  $('#position').textContent = formatTime(time);
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  $('#duration').textContent = formatTime(duration);
  $('#seek').max = duration || 1;
  if (!state.scrubbing) $('#seek').value = time;
  $('#playhead').style.left = `${Math.min(100, time / timelineLength() * 100)}%`;
  const current = activeCue(s.cues, time);
  const upcoming = s.cues.find(c => c.start > time + 0.001);
  const shown = current || upcoming;
  if (shown) {
    const caption = captionParts(shown.text);
    $('#current-speaker').textContent = `${caption.speaker || '字幕'}  /  ${s.cues.indexOf(shown) + 1} of ${s.cues.length}`;
    $('#current-caption').textContent = caption.text;
    $('#current-caption').style.opacity = current ? '1' : '.58';
    $('#cue-clock').textContent = current ? `距结束 ${(Math.max(0, current.end - time)).toFixed(1)}s  ·  ${formatTime(current.start)} → ${formatTime(current.end)}` : `距开始 ${Math.max(0, shown.start - time).toFixed(1)}s  ·  ${formatTime(shown.start)}`;
    const next = s.cues[s.cues.indexOf(shown) + 1];
    $('#next-caption').textContent = next ? captionParts(next.text).text.replace(/\n/g, ' ') : '最后一句';
  } else {
    $('#current-speaker').textContent = s.cues.length ? '已到字幕末尾' : '准备就绪';
    $('#current-caption').textContent = s.cues.length ? '这一遍，完成了。' : '导入 SRT，开始你的配音。';
    $('#current-caption').style.opacity = '.6';
    $('#cue-clock').textContent = ' '; $('#next-caption').textContent = '—';
  }
  const activeId = current?.id || '';
  if (state.lastActive !== activeId) {
    document.querySelectorAll('.cue.current').forEach(el => el.classList.remove('current'));
    const row = document.querySelector(`.cue[data-id="${activeId}"]`);
    row?.classList.add('current');
    if (row && $('#follow').checked && !video.paused && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
      const list = $('#cue-list');
      const top = row.offsetTop - list.offsetTop;
      if (top < list.scrollTop + 10 || top + row.offsetHeight > list.scrollTop + list.clientHeight - 10) list.scrollTo({ top: Math.max(0, top - list.clientHeight / 3), behavior: 'smooth' });
    }
    state.lastActive = activeId;
  }
  if (state.recording) $('#record-elapsed').textContent = `${Math.max(0, time - state.recording.start).toFixed(1)}s`;
}

async function audioContext() {
  context ||= new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  if (context.state !== 'running') await context.resume();
  return context;
}

async function getBuffer(asset) {
  await audioContext();
  if (!buffers.has(asset)) buffers.set(asset, fetch(`/assets/${asset}`).then(response => {
    if (!response.ok) throw new Error('无法读取录音文件。');
    return response.arrayBuffer();
  }).then(bytes => context.decodeAudioData(bytes)).catch(error => { buffers.delete(asset); throw error; }));
  return buffers.get(asset);
}

function stopVoice() {
  voiceToken++;
  for (const node of voiceNodes) { try { node.stop(); } catch {} node.disconnect(); }
  voiceNodes = []; voiceClock = null;
}

async function syncVoice() {
  stopVoice();
  if (state.mode !== 'replay' || video.paused || state.wait || !state.session?.clips.length) return;
  const token = voiceToken;
  await audioContext();
  const relevant = state.session.clips.filter(c => c.start + c.duration > video.currentTime);
  const decoded = new Map(await Promise.all([...new Set(relevant.map(c => c.asset))].map(async asset => [asset, await getBuffer(asset)])));
  if (token !== voiceToken || video.paused || state.mode !== 'replay') return;
  const at = context.currentTime, position = video.currentTime;
  voiceClock = { at, position };
  for (const clip of relevant) {
    const elapsed = Math.max(0, position - clip.start);
    const duration = Math.min(clip.duration - elapsed, decoded.get(clip.asset).duration - clip.offset - elapsed);
    if (duration <= 0) continue;
    const source = context.createBufferSource();
    source.buffer = decoded.get(clip.asset);
    source.connect(context.destination);
    source.start(at + Math.max(0, clip.start - position), clip.offset + elapsed, duration);
    voiceNodes.push(source);
  }
}

function setMode(mode) {
  state.mode = mode;
  renderControls();
  run(syncVoice)();
}

function selectCue(id) {
  state.selected = id;
  document.querySelectorAll('.cue.selected').forEach(el => el.classList.remove('selected'));
  document.querySelector(`.cue[data-id="${id}"]`)?.classList.add('selected');
}

function seek(time) {
  if (locked()) return;
  state.previewEnd = null;
  video.currentTime = Math.min(Math.max(0, time), Number.isFinite(video.duration) ? video.duration : time);
  updateTime();
}

async function togglePlay() {
  if (state.recording) return finishRecording();
  if (locked() || !state.session?.video) return;
  if (video.paused) {
    await audioContext();
    if (video.currentTime >= video.duration - 0.02) video.currentTime = 0;
    await video.play();
  } else video.pause();
  renderControls();
}

async function preview(start, end) {
  if (locked()) return;
  video.pause(); setMode('replay');
  seek(start); state.previewEnd = end;
  await audioContext(); await video.play();
}

function pushUndo() {
  state.undo.push(structuredClone(state.session.clips));
  if (state.undo.length > 12) state.undo.shift();
}

async function deleteClips(predicate) {
  if (locked()) return;
  pushUndo();
  state.session.clips = state.session.clips.filter(c => !predicate(c));
  renderCues(); renderTrack(); await syncVoice(); await save();
  toast('已删除录音。误删可以点击“撤销删除”。');
}

function closeMicrophone() {
  captureNode?.disconnect(); micSource?.disconnect(); analyser?.disconnect(); silentGain?.disconnect();
  micStream?.getTracks().forEach(track => track.stop());
  captureNode = micSource = analyser = silentGain = micStream = null;
  $('#level').style.width = '0%';
}

async function refreshMicrophones(authorize = false) {
  let temporary;
  if (authorize) temporary = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const previous = $('#microphone').value;
    $('#microphone').innerHTML = '<option value="">默认麦克风</option>' + devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default').map((d, i) => `<option value="${escape(d.deviceId)}">${escape(d.label || `麦克风 ${i + 1}`)}</option>`).join('');
    if ([...$('#microphone').options].some(o => o.value === previous)) $('#microphone').value = previous;
  } finally { temporary?.getTracks().forEach(track => track.stop()); }
}

async function prepareMicrophone(token) {
  await audioContext();
  if (token !== state.countdownToken) return;
  const deviceId = $('#microphone').value;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    channelCount: 1, sampleRate: 48000, echoCancellation: false,
    noiseSuppression: false, autoGainControl: false }, video: false });
  if (token !== state.countdownToken) { stream.getTracks().forEach(track => track.stop()); return; }
  try {
    workletReady ||= context.audioWorklet.addModule('/recorder-worklet.js').catch(error => { workletReady = null; throw error; });
    await workletReady;
  } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  if (token !== state.countdownToken) { stream.getTracks().forEach(track => track.stop()); return; }
  micStream = stream;
  micSource = context.createMediaStreamSource(micStream);
  captureNode = new AudioWorkletNode(context, 'voice-capture');
  analyser = context.createAnalyser(); analyser.fftSize = 256;
  silentGain = context.createGain(); silentGain.gain.value = 0;
  micSource.connect(analyser); micSource.connect(captureNode);
  captureNode.connect(silentGain); silentGain.connect(context.destination);
  micStream.getAudioTracks()[0].addEventListener('ended', () => {
    if (state.recording) { toast('麦克风已断开，正在保存已录部分。', true); run(finishRecording)(); }
  });
  await refreshMicrophones();
}

function cancelPreparation() {
  state.countdownToken++;
  state.preparing = false;
  $('#count-in').hidden = true;
  closeMicrophone();
  renderControls();
}

async function startRecording(cueId = null) {
  if (locked() || !state.session?.video) return;
  const cue = state.session.cues.find(c => c.id === cueId);
  if (cue && cue.start >= video.duration) throw new Error('这句字幕在视频结束之后，请先调整时间。');
  video.pause(); stopVoice();
  state.previewEnd = null;
  state.mode = 'record';
  state.preparing = true;
  const token = ++state.countdownToken;
  renderControls();
  try {
    await flush();
    await prepareMicrophone(token);
    if (token !== state.countdownToken) return;
    if (cue) { selectCue(cue.id); video.currentTime = cue.start; }
    else if (video.currentTime >= video.duration - 0.03) video.currentTime = 0;
    if (video.seeking) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { video.removeEventListener('seeked', done); reject(new Error('视频定位超时，请重试。')); }, 8000);
      const done = () => { clearTimeout(timer); resolve(); };
      video.addEventListener('seeked', done, { once: true });
    });
    if ($('#countdown-enabled').checked) {
      const countdown = $('#count-in');
      const dots = Array.from({ length: 3 }, () => {
        const dot = document.createElement('span');
        dot.className = 'count-dot';
        dot.setAttribute('aria-hidden', 'true');
        return dot;
      });
      countdown.replaceChildren(...dots);
      countdown.hidden = false;
      const started = performance.now();
      for (const [index, dot] of dots.entries()) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (index + 1) * 500 - performance.now())));
        if (token !== state.countdownToken) return;
        dot.style.visibility = 'hidden';
      }
    }
    if (token !== state.countdownToken) return;
    $('#count-in').hidden = true;
    const chunks = [];
    let stopResolve;
    const stopped = new Promise(resolve => stopResolve = resolve);
    const node = captureNode;
    node.port.onmessage = ({ data }) => {
      if (data.type === 'samples') chunks.push(data);
      if (data.type === 'stopped') stopResolve();
    };
    await video.play();
    if (token !== state.countdownToken) { video.pause(); return; }
    const anchor = context.currentTime;
    state.recording = { start: video.currentTime, anchor, rate: context.sampleRate,
      end: cue ? Math.min(cue.end, video.duration) : Infinity,
      cueId: cue?.id || null, chunks, stopped, node };
    node.port.postMessage({ type: 'start', frame: Math.ceil(anchor * context.sampleRate) });
    state.preparing = false;
    renderControls();
  } catch (error) {
    if (token !== state.countdownToken) return;
    cancelPreparation();
    throw error;
  }
}

function download(url, name) {
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
}

async function finishRecording() {
  const recording = state.recording;
  if (!recording || state.finishing) return;
  state.finishing = true;
  const end = Math.min(video.currentTime, recording.end);
  video.pause(); stopVoice(); renderControls();
  let wav;
  try {
    recording.node.port.postMessage({ type: 'stop' });
    await Promise.race([recording.stopped, new Promise((_, reject) => setTimeout(() => reject(new Error('录音设备没有及时响应，请重试。')), 4000))]);
    closeMicrophone();
    const first = recording.chunks[0]?.frame;
    const start = recording.start + (first / recording.rate - recording.anchor);
    const available = recording.chunks.reduce((total, c) => total + c.samples.length, 0);
    const length = Math.min(available, Math.max(0, Math.floor((end - start) * recording.rate)));
    if (!Number.isFinite(start) || length < recording.rate * 0.08) {
      toast('录音太短，没有覆盖之前的录音。'); return;
    }
    const pcm = new Float32Array(length);
    let offset = 0;
    for (const chunk of recording.chunks) {
      const count = Math.min(chunk.samples.length, length - offset);
      if (count <= 0) break;
      pcm.set(chunk.samples.subarray(0, count), offset); offset += count;
    }
    wav = new Blob([encodeWav(pcm, recording.rate)], { type: 'audio/wav' });
    const asset = await api('/api/assets?name=take.wav', { method: 'POST', body: wav });
    pushUndo();
    let retained = state.session.clips;
    if (recording.cueId) retained = retained.filter(c => c.cueId !== recording.cueId);
    retained = replaceInterval(retained, start, start + length / recording.rate);
    const clips = partitionRecording(state.session.cues, start, length / recording.rate, asset.id);
    state.session.clips = [...retained, ...clips].sort((a,b) => a.start - b.start);
    await save();
    toast(`已保存 ${(length / recording.rate).toFixed(1)} 秒录音。切到“重放模式”即可听人声。`);
  } catch (error) {
    if (wav) {
      const url = URL.createObjectURL(wav);
      download(url, 'Voicepad-unsaved-take.wav');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      report(new Error(`${error.message} 已下载这次录音的 WAV 备份。`));
    } else report(error);
  } finally {
    closeMicrophone(); state.recording = null; state.finishing = false;
    renderCues(); renderTrack(); renderControls();
  }
}

async function loadSession(session) {
  video.pause(); stopVoice();
  state.session = session; state.undo = []; state.selected = null;
  state.previewEnd = null; state.saveError = false; state.lastActive = '';
  buffers.clear(); $('#search').value = '';
  if (!state.sessions.some(s => s.id === session.id)) state.sessions.unshift(session);
  localStorage.setItem('voicepad-session', session.id);
  state.openAt = session.cues[0]?.start || 0;
  const assetUrl = session.video ? `/assets/${session.video.id}` : '';
  if (assetUrl) { video.src = assetUrl; video.load(); }
  else { video.removeAttribute('src'); video.load(); }
  $('#video-empty').hidden = !!session.video;
  $('#video-name').textContent = session.video?.name || '尚未导入视频';
  $('#save-status').textContent = '已自动保存'; $('#save-status').classList.remove('failed');
  renderSessionList(); renderCues(); renderTrack(); renderControls();
}

function confirmAction(title, description) {
  return new Promise(resolve => {
    $('#confirm-title').textContent = title; $('#confirm-description').textContent = description;
    const dialog = $('#confirm-dialog'); dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

async function importVideo(file) {
  if (!file) return;
  if (state.session.clips.length && !await confirmAction('替换视频？', '当前录音和字幕会保留在原时间位置。若是新项目，建议新建空白 session。')) return;
  await busy(async () => {
    video.pause(); $('#video-name').textContent = '正在导入视频…';
    const asset = await api(`/api/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
    state.session.video = { id: asset.id, name: file.name };
    await save();
    const session = state.session; await loadSession(session);
    toast('视频已导入。');
  });
}

async function importSrt(file) {
  if (!file) return;
  const bytes = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('gb18030').decode(bytes); }
  const cues = parseSrt(text);
  if (state.session.clips.length && !await confirmAction('替换字幕？', '已有录音会保留在原时间位置，并按新字幕重新分段。')) return;
  await busy(async () => {
    video.pause();
    state.session.clips = state.session.clips.flatMap(clip => partitionRecording(cues, clip.start, clip.duration, clip.asset).map(part => ({ ...part, offset: part.offset + clip.offset })));
    state.session.cues = cues; state.undo = [];
    renderCues(); renderTrack(); await save();
    toast(`已导入 ${cues.length} 句字幕。`);
  });
}

async function exportAudio() {
  if (!state.session.clips.length) return;
  await busy(async () => {
    video.pause(); await flush();
    $('#export-audio').textContent = '正在合成人声…';
    try {
      const rate = 48000, length = timelineLength();
      if (length > 7200) throw new Error('单次导出暂时支持 2 小时以内的视频。');
      const offline = new OfflineAudioContext(1, Math.ceil(length * rate), rate);
      const decoded = new Map(await Promise.all([...new Set(state.session.clips.map(c => c.asset))].map(async asset => [asset, await getBuffer(asset)])));
      for (const clip of state.session.clips) {
        const duration = Math.min(clip.duration, decoded.get(clip.asset).duration - clip.offset);
        if (duration <= 0) continue;
        const source = offline.createBufferSource(); source.buffer = decoded.get(clip.asset);
        source.connect(offline.destination); source.start(clip.start, clip.offset, duration);
      }
      const result = await offline.startRendering();
      const pcm = result.getChannelData(0);
      let peak = 1;
      for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
      if (peak > 1) for (let i = 0; i < pcm.length; i++) pcm[i] /= peak;
      const blob = new Blob([encodeWav(pcm, rate)], { type: 'audio/wav' });
      const name = `${state.session.name.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'Voicepad'}-voice.wav`;
      const file = await api(`/api/exports?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
      download(file.url, name);
      toast(`人声 WAV 已导出（${length.toFixed(1)} 秒）。本地 exports 文件夹也保留了一份。`, false, 9000);
    } finally { $('#export-audio').textContent = '↓ 导出人声 WAV'; }
  });
}

listen('#play', 'click', togglePlay);
listen('#record', 'click', () => state.preparing ? cancelPreparation() : state.recording ? finishRecording() : startRecording());
listen('#mode-record', 'click', () => setMode('record'));
listen('#mode-replay', 'click', () => setMode('replay'));
listen('#refresh-mics', 'click', () => busy(() => refreshMicrophones(true)));
listen('#export-audio', 'click', exportAudio);
listen('#help', 'click', () => $('#help-dialog').showModal());
listen('#close-help', 'click', () => $('#help-dialog').close());
listen('#toast button', 'click', () => $('#toast').hidden = true);
listen('#import-video', 'click', () => $('#video-file').click());
listen('#import-first-video', 'click', () => $('#video-file').click());
listen('#import-srt', 'click', () => $('#srt-file').click());
listen('#video-file', 'change', async event => { try { await importVideo(event.target.files[0]); } finally { event.target.value = ''; } });
listen('#srt-file', 'change', async event => { try { await importSrt(event.target.files[0]); } finally { event.target.value = ''; } });
listen('#search', 'input', renderCues);
listen('#seek', 'input', event => { seek(Number(event.target.value)); $('#position').textContent = formatTime(video.currentTime); });
$('#seek').addEventListener('pointerdown', () => state.scrubbing = true);
window.addEventListener('pointerup', () => { state.scrubbing = false; updateTime(); });
listen('#original-audio', 'change', () => video.muted = !$('#original-audio').checked);
listen('#video-volume', 'input', () => video.volume = Number($('#video-volume').value));
video.volume = Number($('#video-volume').value);

listen('#previous-cue', 'click', () => {
  const cues = state.session.cues.filter(c => c.start < video.currentTime - 0.15);
  const cue = cues.at(-1); if (cue) { seek(cue.start); selectCue(cue.id); }
});
listen('#next-cue', 'click', () => {
  const cue = state.session.cues.find(c => c.start > video.currentTime + 0.15);
  if (cue) { seek(cue.start); selectCue(cue.id); }
});

listen('#cue-list', 'click', async event => {
  if (locked()) return;
  const button = event.target.closest('button[data-action]');
  const row = button?.closest('.cue'); if (!row) return;
  const cue = state.session.cues.find(c => c.id === row.dataset.id);
  const action = button.dataset.action;
  selectCue(cue.id);
  if (action === 'seek') seek(cue.start);
  if (action === 'record') await startRecording(cue.id);
  if (action === 'preview') await preview(cue.start, Math.max(cue.end, ...state.session.clips.filter(c => c.cueId === cue.id).map(c => c.start + c.duration)));
  if (action === 'delete') await deleteClips(c => c.cueId === cue.id);
});

listen('#cue-list', 'change', async event => {
  const input = event.target.closest('[data-time]');
  if (!input || locked()) return;
  const cue = state.session.cues.find(c => c.id === input.closest('.cue').dataset.id);
  const field = input.dataset.time;
  const time = parseTime(input.value);
  const start = field === 'start' ? time : cue.start, end = field === 'end' ? time : cue.end;
  if (!Number.isFinite(time) || start < 0 || end <= start) {
    input.classList.add('invalid');
    throw new Error('时间无效：结束必须晚于开始。可输入 00:01:23.456 或秒数 83.456。');
  }
  if (field === 'start') {
    const delta = time - cue.start;
    state.session.clips = moveCueClips(state.session.clips, cue.id, delta);
    state.undo = state.undo.map(clips => moveCueClips(clips, cue.id, delta));
  }
  cue[field] = time;
  state.session.cues.sort((a, b) => a.start - b.start);
  renderCues(); renderTrack(); await syncVoice(); await save();
});
listen('#cue-list', 'keydown', event => { if (event.key === 'Enter' && event.target.matches('[data-time]')) event.target.blur(); });

listen('#track', 'click', event => {
  if (locked()) return;
  const clipId = event.target.closest('[data-clip]')?.dataset.clip;
  if (clipId) {
    const clip = state.session.clips.find(c => c.id === clipId);
    seek(clip.start); if (clip.cueId) selectCue(clip.cueId);
  } else {
    const rect = $('#track').getBoundingClientRect();
    seek((event.clientX - rect.left) / rect.width * timelineLength());
  }
});
listen('#recording-list', 'click', async event => {
  const button = event.target.closest('button[data-action]');
  const row = button?.closest('[data-clip]'); if (!row || locked()) return;
  const clip = state.session.clips.find(c => c.id === row.dataset.clip);
  if (button.dataset.action === 'delete') await deleteClips(c => c.id === clip.id);
  else await preview(clip.start, clip.start + clip.duration);
});
listen('#undo', 'click', async () => {
  if (locked() || !state.undo.length) return;
  state.session.clips = state.undo.pop();
  renderCues(); renderTrack(); await syncVoice(); await save(); toast('已恢复上一次录音修改。');
});
listen('#clear-recordings', 'click', async () => {
  if (await confirmAction('清空这个 session 的录音？', '视频和字幕会保留，其他 session 不受影响。清空后可以撤销。')) await deleteClips(() => true);
});

listen('#sessions', 'change', async event => {
  const id = event.target.value;
  await busy(async () => { await flush(); await loadSession(await api(`/api/sessions/${id}`)); });
});
listen('#new-session', 'click', () => {
  if (locked()) return;
  video.pause();
  $('#session-name').value = `Session ${state.sessions.length + 1}`;
  $('#reuse-source').checked = !!state.session?.video;
  $('#new-dialog').returnValue = ''; $('#new-dialog').showModal();
  $('#session-name').select();
});
listen('#new-dialog', 'close', async () => {
  if ($('#new-dialog').returnValue !== 'create') return;
  await busy(async () => {
    await flush();
    const reuse = $('#reuse-source').checked;
    const session = await api('/api/sessions', json('POST', {
      name: $('#session-name').value.trim() || `Session ${state.sessions.length + 1}`,
      video: reuse ? state.session.video : null,
      cues: reuse ? structuredClone(state.session.cues) : [], clips: []
    }));
    await loadSession(session); toast('新 session 已创建，人声音轨为空。');
  });
});
listen('#export-srt', 'click', () => busy(async () => {
  await flush();
  const name = 'Voicepad-subtitles.srt';
  const file = await api(`/api/exports?name=${name}`, { method: 'POST', body: new Blob(['\uFEFF' + exportSrt(state.session.cues)], { type: 'text/plain' }) });
  download(file.url, name); toast('已导出调整后的 SRT 字幕。');
}));

video.addEventListener('loadedmetadata', () => {
  if (state.openAt !== null && state.openAt !== undefined) {
    video.currentTime = Math.min(state.openAt, Math.max(0, video.duration - .01));
    state.openAt = null;
  }
  renderTrack(); updateTime(); renderControls();
});
video.addEventListener('error', () => { if (state.session?.video) toast('这个视频无法在浏览器中解码。请使用 H.264 / AAC 编码的 MP4 或 WebM。', true, 12000); });
video.addEventListener('play', renderControls);
video.addEventListener('playing', () => { state.wait = false; run(syncVoice)(); renderControls(); });
video.addEventListener('pause', () => { stopVoice(); renderControls(); if (state.recording && !state.finishing) run(finishRecording)(); });
video.addEventListener('seeking', () => { stopVoice(); if (state.recording && !state.finishing) run(finishRecording)(); });
video.addEventListener('seeked', () => { updateTime(); run(syncVoice)(); });
video.addEventListener('waiting', () => {
  state.wait = true; stopVoice();
  if (state.recording && !state.finishing) { toast('视频缓冲，已暂停并保存录音。', true); run(finishRecording)(); }
});
video.addEventListener('ended', () => { if (state.recording) run(finishRecording)(); renderControls(); });

function tick() {
  updateTime();
  if (state.recording && video.currentTime >= state.recording.end) run(finishRecording)();
  if (!state.recording && state.previewEnd !== null && video.currentTime >= state.previewEnd) { video.pause(); state.previewEnd = null; }
  if (analyser) {
    const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    $('#level').style.width = `${Math.min(100, rms * 400)}%`;
  }
  if (voiceClock && performance.now() - lastSyncCheck > 500) {
    lastSyncCheck = performance.now();
    const expected = voiceClock.position + context.currentTime - voiceClock.at;
    if (Math.abs(expected - video.currentTime) > 0.09) run(syncVoice)();
  }
}
setInterval(tick, 50);

document.addEventListener('keydown', event => {
  if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName) || document.querySelector('dialog[open]')) return;
  if (event.code === 'Space') { event.preventDefault(); run(togglePlay)(); }
  if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    if (state.recording) run(finishRecording)();
    else if (state.preparing) cancelPreparation();
    else if (state.mode === 'record') run(startRecording)();
  }
  if (event.key === 'Escape') {
    if (state.preparing) cancelPreparation();
    else if (state.recording) run(finishRecording)();
  }
});
window.addEventListener('beforeunload', event => {
  if (state.recording || state.preparing || state.finishing || state.busy || state.saveError || $('#save-status').textContent === '正在保存…') {
    event.preventDefault(); event.returnValue = '';
  }
});

async function initialize() {
  const data = await api('/api/bootstrap');
  state.sessions = data.sessions;
  const last = localStorage.getItem('voicepad-session');
  const previous = data.sessions.find(s => s.id === last) || data.sessions[0];
  if (previous) await loadSession(await api(`/api/sessions/${previous.id}`));
  else await loadSession(await api('/api/sessions', json('POST', { name: 'Session 1', video: null, cues: [], clips: [] })));
  await refreshMicrophones();
}
run(initialize)();
