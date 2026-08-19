// Constellation Composer: click stars to connect them into a chain, which
// loops as a melody; drag a star (or arrow-key it while focused) to change
// its note; hover the sky with no button held for an ambient drone plus a
// shooting-star trail wherever the cursor sweeps.
// Every vertical position quantizes to a pentatonic scale, so there is no
// note — and no constellation shape — that can ever sound "wrong".

// Guaranteed present by src/pages/index.astro, which this script is paired with.
const sky = document.querySelector<HTMLElement>("#sky")!;
const linesSvg = document.querySelector<SVGSVGElement>("#lines")!;
const hint = document.querySelector<HTMLElement>("#hint")!;
const clearButton = document.querySelector<HTMLButtonElement>("#clear")!;

function dismissHint(): void {
  hint.classList.add("is-hidden");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// --- Sky geometry: measured, not assumed, so layout (the controls bar,
// header) can't desync star coordinates from where things actually render.
let skyRect = sky.getBoundingClientRect();
window.addEventListener("resize", () => {
  skyRect = sky.getBoundingClientRect();
});

function toSkyCoords(clientX: number, clientY: number): { x: number; y: number } {
  return { x: clientX - skyRect.left, y: clientY - skyRect.top };
}

// --- Pitch: a generated major-pentatonic scale across three octaves, so any
// vertical position quantizes to an in-scale note.
const PENTATONIC_STEPS = [0, 2, 4, 7, 9];
const ROOT_FREQ = 220; // A3
const OCTAVES = 3;
const SCALE = Array.from({ length: PENTATONIC_STEPS.length * OCTAVES }, (_, i) => {
  const octave = Math.floor(i / PENTATONIC_STEPS.length);
  const semitone = PENTATONIC_STEPS[i % PENTATONIC_STEPS.length]!;
  return ROOT_FREQ * 2 ** (octave + semitone / 12);
});

function frequencyFor(y: number): number {
  const t = clamp(y / skyRect.height, 0, 1);
  const index = Math.round((1 - t) * (SCALE.length - 1));
  return SCALE[index]!;
}

function panFor(x: number): number {
  const t = clamp(x / skyRect.width, 0, 1);
  return t * 2 - 1;
}

function brightnessFor(size: number): number {
  return clamp((size - 0.4) / 0.8, 0, 1);
}

// Timbre by height, independent of size: top of the sky rings clear and
// bell-like, the bottom sits warm and dark — layered on top of brightness
// rather than replacing it.
function clarityFor(y: number): number {
  return 1 - clamp(y / skyRect.height, 0, 1);
}

function durationFor(size: number): number {
  return 130 + brightnessFor(size) * 520;
}

function fadeFor(size: number): number {
  return 160 + brightnessFor(size) * 480;
}

let audioCtx: AudioContext | null = null;
let master: GainNode | null = null;

function ensureAudio(): { ctx: AudioContext; master: GainNode } {
  if (!audioCtx || !master) {
    audioCtx = new AudioContext();
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.connect(audioCtx.destination);
    master = audioCtx.createGain();
    master.gain.value = 0.8;
    master.connect(compressor);

    // A shared, subtle sense of space: every voice already routes through
    // `master`, so one feedback-delay bus gives all of them (pluck, chime,
    // chord, hover, whoosh) a soft shared tail. The feedback gain (0.32) is a
    // hard sub-unity scalar with no unity/>1 path in the loop, so each repeat
    // is strictly quieter than the last (a convergent geometric series) —
    // this cannot self-sustain or build up no matter how long it runs.
    const spaceSend = audioCtx.createGain();
    spaceSend.gain.value = 0.5;
    const spaceDelay = audioCtx.createDelay(1);
    spaceDelay.delayTime.value = 0.28;
    const spaceFilter = audioCtx.createBiquadFilter();
    spaceFilter.type = "lowpass";
    spaceFilter.frequency.value = 2200;
    spaceFilter.Q.value = 0.5;
    const spaceFeedback = audioCtx.createGain();
    spaceFeedback.gain.value = 0.32;
    const spaceWet = audioCtx.createGain();
    spaceWet.gain.value = 0.22;

    master.connect(spaceSend);
    spaceSend.connect(spaceDelay);
    spaceDelay.connect(spaceFilter);
    spaceFilter.connect(spaceFeedback);
    spaceFeedback.connect(spaceDelay);
    spaceFilter.connect(spaceWet);
    spaceWet.connect(compressor);
  }
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return { ctx: audioCtx, master };
}

// Browsers refuse to start an AudioContext from a bare pointermove — some
// prior click/tap/keypress has to unlock it first. That gesture doesn't have
// to land on a star though: any first interaction anywhere on the page
// counts, so a single stray click is enough to make hover alone play sound
// from then on.
window.addEventListener("pointerdown", () => ensureAudio(), { once: true });
window.addEventListener("keydown", () => ensureAudio(), { once: true });

// A single note: oscillator -> lowpass filter -> stereo panner -> its own
// gain envelope -> the shared master bus. `pluck` is for taps/keys/shooting
// stars (self-releasing); `update`/`release` are for the held preview tone
// while dragging a star.
// A minimal structural interface so anything that exposes an RMS level
// (Voice, NoiseWhoosh) can drive a star's glow via attachGlow.
interface LevelSource {
  getLevel(): number;
}

class Voice implements LevelSource {
  private osc: OscillatorNode;
  private filter: BiquadFilterNode;
  private panner: StereoPannerNode;
  private gain: GainNode;
  private analyser: AnalyserNode;
  private levelBuffer: Uint8Array<ArrayBuffer>;
  // A quiet extra sine layer whose ratio/prominence depends on brightness —
  // a sub-octave for large/bright stars (richer, deeper), an octave up for
  // small/dim ones (delicate, glassy) — so star size colors the timbre
  // itself, not just volume/duration. Silent (peak 0) for medium stars.
  private charOsc: OscillatorNode;
  private charGain: GainNode;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    frequency: number,
    pan: number,
    private brightness: number,
    clarity = 0,
    private volume = 1,
    attackMs = 15,
  ) {
    this.osc = ctx.createOscillator();
    this.osc.type = "triangle";
    this.osc.frequency.value = frequency;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 350 + brightness * 1900 + clarity * 2500;
    // Small/dim stars ring more (higher Q, glassier); large/bright stars stay
    // smoother and warmer.
    this.filter.Q.value = 1.8 - brightness * 1.2;

    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = pan;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 32;
    this.levelBuffer = new Uint8Array(this.analyser.frequencyBinCount);

    this.osc.connect(this.filter).connect(this.panner).connect(this.gain).connect(out);
    this.gain.connect(this.analyser);
    this.osc.start();

    const charRatio = brightness > 0.5 ? 0.5 : 2;
    const charPeak = Math.abs(brightness - 0.5) * 2 * 0.05 * volume;
    this.charOsc = ctx.createOscillator();
    this.charOsc.type = "sine";
    this.charOsc.frequency.value = frequency * charRatio;
    this.charGain = ctx.createGain();
    this.charGain.gain.value = 0;
    this.charOsc.connect(this.charGain).connect(this.panner);
    this.charOsc.start();

    const now = ctx.currentTime;
    this.gain.gain.linearRampToValueAtTime((0.05 + brightness * 0.25) * volume, now + attackMs / 1000);
    this.charGain.gain.linearRampToValueAtTime(charPeak, now + attackMs / 1000);
  }

  // RMS amplitude of this voice's own envelope (0..~0.5) — used to drive a
  // star's glow directly off the sound it's actually making, rather than a
  // fixed-duration CSS flash guessing at the envelope shape.
  getLevel(): number {
    this.analyser.getByteTimeDomainData(this.levelBuffer);
    let sumSquares = 0;
    for (const sample of this.levelBuffer) {
      const normalized = (sample - 128) / 128;
      sumSquares += normalized * normalized;
    }
    return Math.sqrt(sumSquares / this.levelBuffer.length);
  }

  update(frequency: number, pan: number, brightness: number, clarity = 0, volume = 1, glideTimeConstant = 0.03): void {
    const now = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(frequency, now, glideTimeConstant);
    this.panner.pan.setTargetAtTime(pan, now, 0.05);
    this.filter.frequency.setTargetAtTime(350 + brightness * 1900 + clarity * 2500, now, 0.05);
    this.gain.gain.setTargetAtTime((0.05 + brightness * 0.25) * volume, now, 0.05);
  }

  release(fadeMs = 200): void {
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
    this.osc.stop(now + fadeMs / 1000 + 0.05);
    this.charGain.gain.cancelScheduledValues(now);
    this.charGain.gain.setValueAtTime(this.charGain.gain.value, now);
    this.charGain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
    this.charOsc.stop(now + fadeMs / 1000 + 0.05);
  }

  pluck(holdMs = 350, fadeMs = 180, sparkle = false): void {
    if (sparkle) this.playSparkle();
    setTimeout(() => this.release(fadeMs), holdMs);
  }

  // A brief, quiet, consonant overtone (octave + octave-fifth) layered under
  // a note's attack for a glassy "crystal chime" edge — routed straight to
  // the master bus rather than through this voice's own filter/gain/panner,
  // so its short, fixed decay never gets stretched or truncated by that
  // note's own holdMs/fadeMs (which vary with star size).
  private playSparkle(): void {
    const scale = (0.4 + this.brightness * 0.6) * this.volume;
    playChimeShimmer(this.ctx, this.out, this.osc.frequency.value, this.panner.pan.value, scale);
  }
}

// Shared crystalline-shimmer synthesis: two quiet consonant overtones (octave
// + octave-fifth), routed straight to `out` with their own short fixed decay
// — used by Voice.playSparkle (a note's connect-chime edge) and by shooting
// stars (their own distinct sound identity, see pluckAt).
function playChimeShimmer(ctx: AudioContext, out: AudioNode, fundamental: number, pan: number, scale: number): void {
  const now = ctx.currentTime;
  const partials: Array<[ratio: number, peak: number]> = [
    [2, 0.05 * scale],
    [3, 0.035 * scale],
  ];
  for (const [ratio, peak] of partials) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = fundamental * ratio;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    osc.connect(gain).connect(panner).connect(out);
    osc.start(now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.008);
    gain.gain.setTargetAtTime(0, now + 0.008, 0.05);
    osc.stop(now + 0.26);
  }
}

interface NoiseWhooshOptions {
  startFreq: number;
  endFreq: number;
  durationMs: number;
  peakGain: number;
  pan: number;
  filterType?: BiquadFilterType;
  Q?: number;
}

let noiseBuffer: AudioBuffer | null = null;

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

// A brief, filtered noise sweep — an airy "whoosh" distinct from any
// oscillator-based Voice. Used for a star's first-activation shimmer and for
// shooting stars' own sound identity. Self-cleaning: its source's stop time
// is scheduled synchronously at construction, same discipline as
// Voice.release, so it can never be left running.
class NoiseWhoosh implements LevelSource {
  private source: AudioBufferSourceNode;
  private filter: BiquadFilterNode;
  private gain: GainNode;
  private panner: StereoPannerNode;
  private analyser: AnalyserNode;
  private levelBuffer: Uint8Array<ArrayBuffer>;

  constructor(ctx: AudioContext, out: AudioNode, opts: NoiseWhooshOptions) {
    const now = ctx.currentTime;
    this.source = ctx.createBufferSource();
    this.source.buffer = getNoiseBuffer(ctx);
    this.source.loop = true;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = opts.filterType ?? "bandpass";
    this.filter.Q.value = opts.Q ?? 1;
    this.filter.frequency.setValueAtTime(opts.startFreq, now);
    this.filter.frequency.linearRampToValueAtTime(opts.endFreq, now + opts.durationMs / 1000);

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = opts.pan;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 32;
    this.levelBuffer = new Uint8Array(this.analyser.frequencyBinCount);

    this.source.connect(this.filter).connect(this.gain).connect(this.panner).connect(out);
    this.gain.connect(this.analyser);

    this.gain.gain.linearRampToValueAtTime(opts.peakGain, now + (opts.durationMs * 0.3) / 1000);
    this.gain.gain.linearRampToValueAtTime(0, now + opts.durationMs / 1000);
    this.source.start(now);
    this.source.stop(now + opts.durationMs / 1000 + 0.05);
    this.source.onended = () => {
      this.source.disconnect();
      this.filter.disconnect();
      this.gain.disconnect();
      this.panner.disconnect();
      this.analyser.disconnect();
    };
  }

  getLevel(): number {
    this.analyser.getByteTimeDomainData(this.levelBuffer);
    let sumSquares = 0;
    for (const sample of this.levelBuffer) {
      const normalized = (sample - 128) / 128;
      sumSquares += normalized * normalized;
    }
    return Math.sqrt(sumSquares / this.levelBuffer.length);
  }
}

// --- Stars: real <button>s, positioned absolutely, generated at runtime so
// every load is a different sky.
interface StarState {
  x: number;
  y: number;
  size: number;
}

interface Edge {
  a: HTMLButtonElement;
  b: HTMLButtonElement;
  line: SVGLineElement;
}

interface DragState {
  star: HTMLButtonElement;
  dragging: boolean;
  startX: number;
  startY: number;
  voice: Voice | null;
}

// Purely cosmetic per-star variance (shape, rotation, ray length, glow
// radius) — assigned once at creation, alongside the audio-driving --size.
const STAR_SHAPES = ["point", "particle", "burst", "cross"] as const;

const STAR_COUNT = 20;
const MARGIN = 40;
const MIN_SPACING = 70;
const DRAG_THRESHOLD = 6;
const STEP_MS = 450;
const SHOOT_MIN_DIST = 40;
const SHOOT_MIN_MS = 90;

// --- "Drawing music": a soft ambient swell on first touch, a crystalline
// chime when a connection lands, and a warm consonant chord each time the
// constellation's melody completes a full loop.
const SWELL_ATTACK_MS = 500;
const SWELL_HOLD_MS = 550; // >= attack, so the swell actually blooms before fading
const SWELL_FADE_MS = 450;
const SWELL_VOLUME = 0.12;
const CHORD_VOLUME = 0.18;
const CHORD_ATTACK_MS = 500;
const CHORD_HOLD_MS = 550; // >= attack, same reasoning as the swell
const CHORD_FADE_MS = 900;
const CHORD_PAN_SPREAD = 0.25;

const starState = new Map<HTMLButtonElement, StarState>();
const chainOrder: HTMLButtonElement[] = [];
const edges: Edge[] = [];
const starDrags = new Map<number, DragState>();
const justDragged = new Set<HTMLButtonElement>();

// --- Hover melody: whether a star is eligible to re-trigger via passive
// hover. Any pluck (click, sequencer, keyboard, hover) disarms its star;
// it only re-arms once the cursor actually leaves HOVER_RADIUS around it.
const starHoverArmed = new Map<HTMLButtonElement, boolean>();

let sequencerTimer: number | null = null;
let sequencerStep = 0;

// --- Glow: each star's brightness/flare follows the live amplitude of its
// own voice (via Voice#getLevel), not a fixed-duration CSS guess. `glowGen`
// lets a fresh pluck/drag cancel a still-running loop from the same star
// without the two racing to write --amp.
const glowGen = new Map<HTMLButtonElement, number>();

function attachGlow(star: HTMLButtonElement, voice: LevelSource, stopAfterMs?: number): void {
  const gen = (glowGen.get(star) ?? 0) + 1;
  glowGen.set(star, gen);
  const start = performance.now();

  function frame(): void {
    if (glowGen.get(star) !== gen) return;
    star.style.setProperty("--amp", voice.getLevel().toFixed(3));
    if (stopAfterMs !== undefined && performance.now() - start >= stopAfterMs) {
      star.style.setProperty("--amp", "0");
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function positionStar(star: HTMLButtonElement, x: number, y: number): void {
  star.style.left = `${x}px`;
  star.style.top = `${y}px`;
}

function randomPosition(existing: StarState[]): { x: number; y: number } {
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = MARGIN + Math.random() * (skyRect.width - MARGIN * 2);
    const y = MARGIN + Math.random() * (skyRect.height - MARGIN * 2);
    if (existing.every((s) => Math.hypot(s.x - x, s.y - y) >= MIN_SPACING)) {
      return { x, y };
    }
  }
  return {
    x: MARGIN + Math.random() * (skyRect.width - MARGIN * 2),
    y: MARGIN + Math.random() * (skyRect.height - MARGIN * 2),
  };
}

function updateEdgesFor(star: HTMLButtonElement): void {
  for (const edge of edges) {
    if (edge.a === star || edge.b === star) {
      const a = starState.get(edge.a)!;
      const b = starState.get(edge.b)!;
      edge.line.setAttribute("x1", String(a.x));
      edge.line.setAttribute("y1", String(a.y));
      edge.line.setAttribute("x2", String(b.x));
      edge.line.setAttribute("y2", String(b.y));
    }
  }
}

function moveStar(star: HTMLButtonElement, x: number, y: number): void {
  const state = starState.get(star)!;
  state.x = clamp(x, MARGIN, skyRect.width - MARGIN);
  state.y = clamp(y, MARGIN, skyRect.height - MARGIN);
  positionStar(star, state.x, state.y);
  updateEdgesFor(star);
}

function flashActive(star: HTMLButtonElement, ms = 250): void {
  star.classList.add("active");
  setTimeout(() => star.classList.remove("active"), ms);
}

function flashEdge(a: HTMLButtonElement, b: HTMLButtonElement, ms = 250): void {
  for (const edge of edges) {
    if ((edge.a === a && edge.b === b) || (edge.a === b && edge.b === a)) {
      edge.line.classList.add("edge-active");
      setTimeout(() => edge.line.classList.remove("edge-active"), ms);
    }
  }
}

function pluckStar(star: HTMLButtonElement, holdMsOverride?: number, volume = 1, sparkle = false): void {
  const { ctx, master: out } = ensureAudio();
  const state = starState.get(star)!;
  const hold = holdMsOverride ?? durationFor(state.size);
  const fade = fadeFor(state.size);
  const voice = new Voice(
    ctx,
    out,
    frequencyFor(state.y),
    panFor(state.x),
    brightnessFor(state.size),
    clarityFor(state.y),
    volume,
  );
  voice.pluck(hold, fade, sparkle);
  flashActive(star, hold);
  attachGlow(star, voice, hold + fade + 50);
  starHoverArmed.set(star, false);
}

// A very subtle, slow-attack rising tone played the instant a pointer
// touches any star — before it's known whether the gesture will become a
// click-to-connect or a drag-to-reposition. Self-contained: its own Voice,
// its own release, no interaction state touched.
function playPointerSwell(star: HTMLButtonElement): void {
  const { ctx, master: out } = ensureAudio();
  const state = starState.get(star)!;
  const voice = new Voice(
    ctx,
    out,
    frequencyFor(state.y),
    panFor(state.x),
    brightnessFor(state.size),
    clarityFor(state.y),
    SWELL_VOLUME,
    SWELL_ATTACK_MS,
  );
  voice.pluck(SWELL_HOLD_MS, SWELL_FADE_MS);
  attachGlow(star, voice, SWELL_HOLD_MS + SWELL_FADE_MS + 50);
}

// The soft "awakening" whoosh/shimmer that opens a star's first activation —
// a brief noise sweep toward its own pitch, glow-synced, followed shortly by
// the existing connect chime (see connectStar) for a gentle-attack /
// bright-peak / smooth-decay envelope overall.
const AWAKEN_WHOOSH_MS = 220;
const AWAKEN_CHIME_DELAY_MS = 80;
const CONNECT_HANDOFF_FADE_MS = 120;

function playAwakening(star: HTMLButtonElement): void {
  const { ctx, master: out } = ensureAudio();
  const state = starState.get(star)!;
  const freq = frequencyFor(state.y);
  const brightness = brightnessFor(state.size);
  const whoosh = new NoiseWhoosh(ctx, out, {
    startFreq: 500,
    endFreq: clamp(freq * 1.5, 900, 3200),
    durationMs: AWAKEN_WHOOSH_MS,
    peakGain: 0.04 + brightness * 0.02,
    pan: panFor(state.x),
    filterType: "bandpass",
    Q: 1.2,
  });
  attachGlow(star, whoosh, AWAKEN_WHOOSH_MS + 50);
}

function drawEdge(a: HTMLButtonElement, b: HTMLButtonElement): void {
  const sa = starState.get(a)!;
  const sb = starState.get(b)!;
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line") as SVGLineElement;
  line.setAttribute("class", "edge");
  line.setAttribute("x1", String(sa.x));
  line.setAttribute("y1", String(sa.y));
  line.setAttribute("x2", String(sb.x));
  line.setAttribute("y2", String(sb.y));
  linesSvg.appendChild(line);
  edges.push({ a, b, line });
}

function stopSequencer(): void {
  if (sequencerTimer !== null) {
    clearTimeout(sequencerTimer);
    sequencerTimer = null;
  }
}

// A soft root/fifth/octave chord off the chain's first star — played only
// when the melody loop actually wraps back around to its start, so the
// constellation feels like it "comes alive" once a phrase completes rather
// than glittering on every single note.
function playLoopChord(rootStar: HTMLButtonElement): void {
  const { ctx, master: out } = ensureAudio();
  const state = starState.get(rootStar)!;
  const rootFreq = frequencyFor(state.y);
  const brightness = brightnessFor(state.size);
  const clarity = clarityFor(state.y);
  const pan = panFor(state.x);
  const ratios = [1, 1.5, 2]; // root, fifth, octave — consonant only
  ratios.forEach((ratio, i) => {
    const voice = new Voice(
      ctx,
      out,
      rootFreq * ratio,
      clamp(pan + (i - 1) * CHORD_PAN_SPREAD, -1, 1),
      brightness,
      clarity,
      CHORD_VOLUME,
      CHORD_ATTACK_MS,
    );
    voice.pluck(CHORD_HOLD_MS, CHORD_FADE_MS);
  });

  // A faint, slow-blooming shimmer two octaves up, lingering after the chord
  // itself has faded — grows gently with how much of the sky is chained,
  // capped so it can never outgrow the chord it's decorating.
  const richness = clamp(chainOrder.length / 8, 0, 1);
  const shimmer = new Voice(
    ctx,
    out,
    rootFreq * 4,
    pan,
    brightness,
    clarity,
    CHORD_VOLUME * 0.4 * richness,
    900,
  );
  shimmer.pluck(CHORD_HOLD_MS, 1600);
}

function scheduleSequencerStep(): void {
  if (chainOrder.length < 2) return;
  const isLoopWrap = sequencerStep > 0 && sequencerStep % chainOrder.length === 0;
  const star = chainOrder[sequencerStep % chainOrder.length]!;
  const prevIndex = (sequencerStep - 1 + chainOrder.length) % chainOrder.length;
  const prevStar = chainOrder[prevIndex]!;
  pluckStar(star, Math.round(STEP_MS * 0.8));
  flashEdge(prevStar, star, Math.round(STEP_MS * 0.8));
  if (isLoopWrap) playLoopChord(chainOrder[0]!);
  sequencerStep++;
  sequencerTimer = window.setTimeout(scheduleSequencerStep, STEP_MS);
}

function restartSequencer(): void {
  stopSequencer();
  if (chainOrder.length >= 2) {
    sequencerStep = 0;
    scheduleSequencerStep();
  }
}

function connectStar(star: HTMLButtonElement): void {
  const last = chainOrder[chainOrder.length - 1];
  if (last === star) return;
  const isFirstActivation = !star.classList.contains("is-lit");
  if (hoverIdleTimer !== null) {
    clearTimeout(hoverIdleTimer);
    hoverIdleTimer = null;
  }
  if (hoverVoice) {
    hoverVoice.release(CONNECT_HANDOFF_FADE_MS);
    hoverVoice = null;
  }
  star.classList.add("is-lit");
  star.classList.add("igniting");
  setTimeout(() => star.classList.remove("igniting"), 550); // matches ignite-burst's duration
  chainOrder.push(star);
  if (last) drawEdge(last, star);
  if (isFirstActivation) {
    playAwakening(star);
    setTimeout(() => pluckStar(star, undefined, 1, true), AWAKEN_CHIME_DELAY_MS);
  } else {
    pluckStar(star, undefined, 1, true);
  }
  restartSequencer();
  dismissHint();
}

function clearConstellation(): void {
  stopSequencer();
  for (const star of chainOrder) star.classList.remove("is-lit");
  chainOrder.length = 0;
  for (const edge of edges) edge.line.remove();
  edges.length = 0;
}

function wireStar(star: HTMLButtonElement): void {
  star.addEventListener("pointerdown", (e) => {
    star.setPointerCapture(e.pointerId);
    starDrags.set(e.pointerId, { star, dragging: false, startX: e.clientX, startY: e.clientY, voice: null });
    playPointerSwell(star);
  });

  star.addEventListener("pointermove", (e) => {
    const drag = starDrags.get(e.pointerId);
    if (!drag || drag.star !== star) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      drag.dragging = true;
      const { ctx, master: out } = ensureAudio();
      const state = starState.get(star)!;
      drag.voice = new Voice(
        ctx,
        out,
        frequencyFor(state.y),
        panFor(state.x),
        brightnessFor(state.size),
        clarityFor(state.y),
      );
      attachGlow(star, drag.voice);
      dismissHint();
    }
    if (drag.dragging) {
      const { x, y } = toSkyCoords(e.clientX, e.clientY);
      moveStar(star, x, y);
      const state = starState.get(star)!;
      drag.voice?.update(frequencyFor(state.y), panFor(state.x), brightnessFor(state.size), clarityFor(state.y));
    }
  });

  function endDrag(e: PointerEvent): void {
    const drag = starDrags.get(e.pointerId);
    if (!drag || drag.star !== star) return;
    if (drag.dragging) {
      drag.voice?.release();
      if (drag.voice) attachGlow(star, drag.voice, 250);
      justDragged.add(star);
    }
    starDrags.delete(e.pointerId);
  }
  star.addEventListener("pointerup", endDrag);
  star.addEventListener("pointercancel", endDrag);

  star.addEventListener("click", () => {
    if (justDragged.has(star)) {
      justDragged.delete(star);
      return;
    }
    connectStar(star);
  });
}

function createStar(index: number): void {
  const star = document.createElement("button");
  star.type = "button";
  star.className = "star";
  star.setAttribute("aria-label", `Star ${index + 1}`);

  const size = 0.4 + Math.random() * 0.8;
  const { x, y } = randomPosition(Array.from(starState.values()));
  starState.set(star, { x, y, size });

  const diameter = 4 + size * 9;
  star.style.width = `${diameter}px`;
  star.style.height = `${diameter}px`;
  star.style.setProperty("--size", size.toFixed(2));
  positionStar(star, x, y);

  const shape = STAR_SHAPES[Math.floor(Math.random() * STAR_SHAPES.length)]!;
  star.classList.add(`star-${shape}`);
  star.style.setProperty("--rot", `${(Math.random() * 360).toFixed(1)}deg`);
  star.style.setProperty("--ray-scale", (0.75 + Math.random() * 0.55).toFixed(2));
  star.style.setProperty("--glow", (0.75 + Math.random() * 0.55).toFixed(2));
  if (shape === "burst") {
    star.style.setProperty("--ray-gap", Math.random() < 0.5 ? "90deg" : "60deg");
  }

  const flickerDuration = 4 + Math.random() * 5;
  star.style.animationDuration = `${flickerDuration}s`;
  star.style.animationDelay = `${-Math.random() * flickerDuration}s`;

  sky.appendChild(star);
  wireStar(star);
}

for (let i = 0; i < STAR_COUNT; i++) createStar(i);

// --- Keyboard: arrow keys reposition the focused star, the same way a drag
// does — the keyboard-only path to reshaping a constellation.
const NUDGE_STEP = 24;

sky.addEventListener("keydown", (e) => {
  const target = e.target;
  if (!(target instanceof HTMLButtonElement) || !target.classList.contains("star")) return;
  let dx = 0;
  let dy = 0;
  switch (e.key) {
    case "ArrowUp":
      dy = -NUDGE_STEP;
      break;
    case "ArrowDown":
      dy = NUDGE_STEP;
      break;
    case "ArrowLeft":
      dx = -NUDGE_STEP;
      break;
    case "ArrowRight":
      dx = NUDGE_STEP;
      break;
    default:
      return;
  }
  e.preventDefault();
  const state = starState.get(target)!;
  moveStar(target, state.x + dx, state.y + dy);
  pluckStar(target);
  dismissHint();
});

// --- Shooting stars: moving the mouse over empty sky (hover — no button
// held, same trigger as the ambient melody below) plucks a quick, ephemeral
// melody along the path and leaves a fading trail — nothing here joins the
// permanent constellation.
const METEOR_WHOOSH_MS = 140;

function pluckAt(x: number, y: number, volume = 1): void {
  const { ctx, master: out } = ensureAudio();
  const freq = frequencyFor(y);
  const pan = panFor(x);
  new NoiseWhoosh(ctx, out, {
    startFreq: freq * 3,
    endFreq: freq * 1.1,
    durationMs: METEOR_WHOOSH_MS,
    peakGain: 0.05 * volume,
    pan,
    filterType: "bandpass",
    Q: 1.5,
  });
  playChimeShimmer(ctx, out, freq * 2, pan, 0.5 * volume);
}

function drawTrailSegment(x1: number, y1: number, x2: number, y2: number): void {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line") as SVGLineElement;
  line.setAttribute("class", "trail");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  linesSvg.appendChild(line);
  line.addEventListener("animationend", () => line.remove());
}

let lastMeteorPoint: { x: number; y: number; time: number } | null = null;

sky.addEventListener("pointerdown", (e) => {
  const target = e.target;
  if (!(target instanceof Element && target.closest(".star"))) dismissHint();
});

sky.addEventListener("pointermove", (e) => {
  if (e.buttons === 0) {
    handleHoverMelody(e);
    return;
  }
  lastMeteorPoint = null; // dragging a star resets meteor-trail continuity
});

// --- Hover melody: moving the mouse over the sky with no button held plays
// a quiet drone that glides with the cursor, plus a distinct "ting" for
// each star the cursor sweeps past, plus the shooting-star trail+pluck above
// — brushing past the constellation without committing any of it to the
// permanent chain. The drone/ting sound requires audio to already be
// unlocked by a prior click/tap/key (browsers won't start an AudioContext
// from a bare mousemove); the trail is purely visual, so it can appear
// before that first gesture. Everything here plays quieter than an actual
// click — connecting stars is the main instrument, hover is background
// texture underneath it, not competing with it.
const HOVER_RADIUS = 50;
const HOVER_IDLE_MS = 500;
const HOVER_VOLUME = 0.35;
let hoverVoice: Voice | null = null;
let hoverIdleTimer: number | null = null;

function handleHoverMelody(e: PointerEvent): void {
  const { x, y } = toSkyCoords(e.clientX, e.clientY);

  if (lastMeteorPoint) {
    const dist = Math.hypot(x - lastMeteorPoint.x, y - lastMeteorPoint.y);
    const dt = performance.now() - lastMeteorPoint.time;
    if (dist >= SHOOT_MIN_DIST || dt >= SHOOT_MIN_MS) {
      drawTrailSegment(lastMeteorPoint.x, lastMeteorPoint.y, x, y);
      if (audioCtx) pluckAt(x, y, HOVER_VOLUME);
      lastMeteorPoint = { x, y, time: performance.now() };
    }
  } else {
    lastMeteorPoint = { x, y, time: performance.now() };
  }

  if (!audioCtx) return;
  const { ctx, master: out } = ensureAudio();

  // Drawing a connection between already-lit stars gets a slightly brighter,
  // more smoothly-glided drone than plain ambient hover before any chain
  // exists — the "physically drawing a musical phrase" feel from req 3.
  const isDrawing = chainOrder.length > 0;
  const hoverBrightness = isDrawing ? 0.15 : 0;
  const hoverGlide = isDrawing ? 0.09 : 0.03;

  if (!hoverVoice) {
    hoverVoice = new Voice(ctx, out, frequencyFor(y), panFor(x), hoverBrightness, clarityFor(y), HOVER_VOLUME);
  } else {
    hoverVoice.update(frequencyFor(y), panFor(x), hoverBrightness, clarityFor(y), HOVER_VOLUME, hoverGlide);
  }

  if (hoverIdleTimer !== null) clearTimeout(hoverIdleTimer);
  hoverIdleTimer = window.setTimeout(() => {
    hoverVoice?.release(400);
    hoverVoice = null;
    hoverIdleTimer = null;
  }, HOVER_IDLE_MS);

  for (const [star, state] of starState) {
    const near = Math.hypot(state.x - x, state.y - y) <= HOVER_RADIUS;
    if (near && (starHoverArmed.get(star) ?? true)) {
      pluckStar(star, undefined, HOVER_VOLUME);
    }
    if (!near) starHoverArmed.set(star, true);
  }
}

sky.addEventListener("pointerleave", () => {
  lastMeteorPoint = null;
  if (hoverIdleTimer !== null) clearTimeout(hoverIdleTimer);
  hoverIdleTimer = null;
  hoverVoice?.release(250);
  hoverVoice = null;
});

clearButton.addEventListener("click", () => clearConstellation());
