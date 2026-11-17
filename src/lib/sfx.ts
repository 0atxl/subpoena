/**
 * Procedural WebAudio effects (shutter, typewriter tick, rubber stamp thud).
 * Muted by default until the user explicitly enables sound.
 */

export class SoundEffects {
  private enabled = false;
  private ctx: AudioContext | null = null;

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(next: boolean): boolean {
    this.enabled = next;
    if (this.enabled) {
      this.ensureContext();
    }
    return this.enabled;
  }

  public toggle(): boolean {
    return this.setEnabled(!this.enabled);
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return null;

    if (!this.ctx) {
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public shutter(): void {
    if (!this.enabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const dur = 0.065;
    const len = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.25));
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2200, now);
    bp.Q.setValueAtTime(1.2, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(bp).connect(gain).connect(ctx.destination);
    noise.start(now);

    // Mechanical shutter leaf click
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(640, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.03);
    og.gain.setValueAtTime(0.14, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    osc.connect(og).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.035);
  }

  public tick(): void {
    if (!this.enabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const dur = 0.018;
    const len = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.22));
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(1600 + Math.random() * 650, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.085, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(hp).connect(gain).connect(ctx.destination);
    src.start(now);
  }

  public thud(): void {
    if (!this.enabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(125, now);
    osc.frequency.exponentialRampToValueAtTime(36, now + 0.14);

    gain.gain.setValueAtTime(0.42, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.17);

    // Subtle paper slap transient
    const dur = 0.04;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.18));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, now);

    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.18, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + dur);

    noise.connect(lp).connect(ng).connect(ctx.destination);
    noise.start(now);
  }
}

export const sfx = new SoundEffects();
