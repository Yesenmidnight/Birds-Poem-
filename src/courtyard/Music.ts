/**
 * 背景音乐（合流入口 index.html / garden.html）：两首姊妹曲——观鸟微距一首（lo-fi lullaby，70 BPM）、小院漫游一首
 * （lo-fi chillhop，72 BPM），同为 F 大调（Suno 生成；母带 audio/master/*.wav，网页用 public/audio/*.mp3 已归一到 −17 LUFS）。
 *
 * - 浏览器不许自动播放：第一次真实的用户手势（pointerdown / keydown / touchstart，isTrusted）才建 AudioContext 起曲，
 *   之后观鸟 ↔ 小院切换不停机；页面切到后台 suspend，回来 resume。
 * - 每首用 Web Audio 的 AudioBufferSourceNode 按样本精确循环（循环点落在尾部渐弱后的静音里，比 <audio loop> 的接缝干净）；
 *   观鸟 ↔ 小院交叉淡化：同调，叠在一起不打架。刚起还没听见的声部直接撤，不做无意义的"淡出一段寂静"。
 * - 音量 / 静音记在 localStorage；?music=0 整个不建（截图 / 压测脚本用）。
 */

export type TrackName = 'watch' | 'yard';

const TRACKS: Record<TrackName, { url: string; label: string }> = {
  watch: { url: 'audio/watch.mp3', label: '观鸟 · lo-fi lullaby' },
  yard: { url: 'audio/yard.mp3', label: '小院 · lo-fi chillhop' },
};
const other = (n: TrackName): TrackName => (n === 'watch' ? 'yard' : 'watch');
export const trackLabel = (n: TrackName | null): string => (n ? TRACKS[n].label : '—');

const STORE_KEY = 'birds.music';
/** 循环点前留的静音（秒）：尾部最后一次出声之后再走这么久才回到开头。 */
const LOOP_TAIL = 0.6;
/** "出声"的门槛（≈ −70 dBFS）：底噪 / 淡出尾巴低于它就算静音。 */
const LOOP_THRESHOLD = 3e-4;
/** 起曲淡入（秒）：解锁第一次起曲 / 切曲。 */
const FADE_IN = 2.5;
const FADE_SWITCH = 3;

interface Voice {
  track: TrackName;
  src: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** AudioParam 没有放之四海皆准的 cancelAndHold：先试它，不行就取消计划再钉住当前值。 */
function holdNow(p: AudioParam, now: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') {
    p.cancelAndHoldAtTime(now);
    return;
  }
  const v = p.value;
  p.cancelScheduledValues(now);
  p.setValueAtTime(v, now);
}

/** 循环点：只看最后 4 s，最后一次超过门槛的样本之后再留 LOOP_TAIL 秒静音（找不到就整段用）。 */
function loopEndOf(buf: AudioBuffer): number {
  const d = buf.getChannelData(0);
  const win = Math.min(d.length, Math.floor(buf.sampleRate * 4));
  const begin = d.length - win;
  for (let i = d.length - 1; i >= begin; i--) {
    if (Math.abs(d[i]) > LOOP_THRESHOLD) return Math.min(buf.duration, i / buf.sampleRate + LOOP_TAIL);
  }
  return buf.duration;
}

export class Music {
  readonly enabled: boolean;
  /** 0..1，面板滑块；静音是单独的开关（取消静音回到这个值）。 */
  volume = 0.75;
  muted = false;
  /** 当前该放的曲子（还没解锁时是"解锁后要放的"）。 */
  desired: TrackName | null = null;
  /** 换曲时回调（面板"曲目"行）。 */
  onTrack: ((name: TrackName | null) => void) | null = null;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** 挂在总线后面的电平表（自检脚本用：确认真的在出声）。 */
  private analyser: AnalyserNode | null = null;
  /** 解锁前解码用（OfflineAudioContext 不受自动播放策略管）。 */
  private decoder: OfflineAudioContext | null = null;
  private buffers: Partial<Record<TrackName, AudioBuffer>> = {};
  private loading: Partial<Record<TrackName, Promise<AudioBuffer | null>>> = {};
  private voice: Voice | null = null;
  private fading: Voice[] = [];
  private unlocked = false;
  private suspended = false;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) return;
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { volume?: unknown; muted?: unknown } | null;
      if (s && typeof s === 'object') {
        if (typeof s.volume === 'number' && Number.isFinite(s.volume)) this.volume = clamp01(s.volume);
        this.muted = s.muted === true;
      }
    } catch {
      // 没有存储权限（隐私模式）：用默认值
    }
    const unlock = (e: Event): void => {
      if (!e.isTrusted) return;
      this.start();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('touchstart', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('touchstart', unlock, true);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx || !this.unlocked) return;
      // 切到后台：挂起解码（定时器被节流也不怕）；回来接着放
      if (document.hidden) {
        this.suspended = true;
        void this.ctx.suspend();
      } else if (this.suspended) {
        this.suspended = false;
        void this.ctx.resume();
      }
    });
  }

  /** 先拉马上要放的那首，好了以后再拉另一首（切曲时不用等）。 */
  prime(first: TrackName): void {
    if (!this.enabled) return;
    void this.load(first).then(() => this.load(other(first)));
  }

  /** 要放哪首：没解锁只记下来（手势来了 start() 起它）；已解锁就交叉淡化过去。 */
  play(name: TrackName, fade = FADE_SWITCH): void {
    if (!this.enabled) return;
    this.desired = name;
    if (!this.ctx) {
      void this.load(name);
      return;
    }
    if (this.voice && this.voice.track === name) return;
    void this.load(name).then((buf) => {
      if (!buf || !this.ctx || this.desired !== name) return;
      this.startVoice(name, buf, fade);
    });
  }

  setVolume(v: number): void {
    this.volume = clamp01(v);
    this.applyGain();
    this.save();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyGain();
    this.save();
  }

  /** 调试 / 自检脚本用。 */
  state(): { enabled: boolean; unlocked: boolean; running: boolean; current: TrackName | null; desired: TrackName | null; volume: number; muted: boolean; master: number; loaded: string[]; loopEnd: Record<string, number> } {
    const loopEnd: Record<string, number> = {};
    for (const k of Object.keys(this.buffers) as TrackName[]) {
      const b = this.buffers[k];
      if (b) loopEnd[k] = loopEndOf(b);
    }
    return {
      enabled: this.enabled,
      unlocked: this.unlocked,
      running: this.ctx ? this.ctx.state === 'running' : false,
      current: this.voice ? this.voice.track : null,
      desired: this.desired,
      volume: this.volume,
      muted: this.muted,
      master: this.master ? this.master.gain.value : -1,
      loaded: Object.keys(this.buffers),
      loopEnd,
    };
  }

  /** 总线上的瞬时电平（0..1 的 RMS；没解锁 = 0）。 */
  level(): number {
    if (!this.analyser) return 0;
    const d = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(d);
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / d.length);
  }

  // ---------------------------------------------------------------------------------------------

  private start(): void {
    if (this.unlocked || !this.enabled) return;
    this.unlocked = true;
    try {
      this.ctx = new AudioContext();
    } catch {
      this.ctx = null;
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser).connect(ctx.destination);
    void ctx.resume();
    if (this.desired) this.play(this.desired, FADE_IN);
  }

  private async load(name: TrackName): Promise<AudioBuffer | null> {
    const got = this.buffers[name];
    if (got) return got;
    const running = this.loading[name];
    if (running) return running;
    const task = (async (): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(TRACKS[name].url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        // 解锁前用 OfflineAudioContext 解码（建 AudioContext 本身就会被自动播放策略记一笔）
        const ctx: BaseAudioContext = this.ctx ?? (this.decoder ??= new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 48000 }));
        const buf = await ctx.decodeAudioData(data);
        this.buffers[name] = buf;
        return buf;
      } catch (e) {
        console.warn('[music] 加载失败', TRACKS[name].url, e);
        return null;
      } finally {
        delete this.loading[name];
      }
    })();
    this.loading[name] = task;
    return task;
  }

  private startVoice(track: TrackName, buf: AudioBuffer, fade: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = loopEndOf(buf);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + fade);
    src.connect(gain).connect(master);
    src.start(now);
    const old = this.voice;
    this.voice = { track, src, gain, startedAt: now };
    if (old) {
      // 旧声部刚起、还没淡入到听得见：直接撤，省得把一段寂静"淡出"一遍
      if (now - old.startedAt < 0.8) this.kill(old);
      else {
        holdNow(old.gain.gain, now);
        old.gain.gain.linearRampToValueAtTime(0, now + fade);
        this.fading.push(old);
        old.src.onended = () => {
          old.gain.disconnect();
          const i = this.fading.indexOf(old);
          if (i >= 0) this.fading.splice(i, 1);
        };
        old.src.stop(now + fade + 0.05);
      }
    }
    this.onTrack?.(track);
  }

  private kill(v: Voice): void {
    try {
      v.src.stop();
    } catch {
      // 还没 start 过 / 已经停了
    }
    v.gain.disconnect();
  }

  private applyGain(): void {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    holdNow(this.master.gain, now);
    this.master.gain.linearRampToValueAtTime(this.muted ? 0 : this.volume, now + 0.15);
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ volume: this.volume, muted: this.muted }));
    } catch {
      // 没有存储权限：只在这次会话里生效
    }
  }
}
