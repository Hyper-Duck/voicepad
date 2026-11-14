class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.pending = [];
    this.count = 0;
    this.firstFrame = 0;
    this.targetFrame = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') {
        this.targetFrame = data.frame;
        this.pending = [];
        this.count = 0;
        this.recording = true;
      }
      if (data.type === 'stop') {
        this.recording = false;
        this.flush();
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }
  flush() {
    if (!this.count) return;
    const samples = new Float32Array(this.count);
    let offset = 0;
    for (const chunk of this.pending) { samples.set(chunk, offset); offset += chunk.length; }
    this.port.postMessage({ type: 'samples', frame: this.firstFrame, samples }, [samples.buffer]);
    this.pending = [];
    this.count = 0;
  }
  process(inputs, outputs) {
    const length = outputs[0]?.[0]?.length || 128;
    const input = inputs[0]?.[0] || new Float32Array(length);
    if (this.recording && currentFrame + input.length > this.targetFrame) {
      const skip = Math.max(0, this.targetFrame - currentFrame);
      if (!this.count) this.firstFrame = currentFrame + skip;
      const copy = input.slice(skip);
      this.pending.push(copy);
      this.count += copy.length;
      if (this.count >= 4096) this.flush();
    }
    // No microphone monitoring: the output remains silent to prevent feedback.
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
