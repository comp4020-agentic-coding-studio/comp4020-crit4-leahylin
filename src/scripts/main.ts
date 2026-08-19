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
class Voice {
  private osc: OscillatorNode;
  private filter: BiquadFilterNode;
  private panner: StereoPannerNode;
  private gain: GainNode;
  private analyser: AnalyserNode;
  private levelBuffer: Uint8Array<ArrayBuffer>;

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
    this.filter.Q.value = 0.7;

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

    const now = ctx.currentTime;
    this.gain.gain.linearRampToValueAtTime((0.05 + brightness * 0.25) * volume, now + attackMs / 1000);
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

  update(frequency: number, pan: number, brightness: number, clarity = 0, volume = 1): void {
    const now = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(frequency, now, 0.03);
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
    const now = this.ctx.currentTime;
    const fundamental = this.osc.frequency.value;
    const pan = this.panner.pan.value;
    const scale = (0.4 + this.brightness * 0.6) * this.volume;
    const partials: Array<[ratio: number, peak: number]> = [
      [2, 0.05 * scale],
      [3, 0.035 * scale],
    ];
    for (const [ratio, peak] of partials) {
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = fundamental * ratio;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = pan;
      osc.connect(gain).connect(panner).connect(this.out);
      osc.start(now);
      gain.gain.linearRampToValueAtTime(peak, now + 0.008);
      gain.gain.setTargetAtTime(0, now + 0.008, 0.05);
      osc.stop(now + 0.26);
    }
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

const STAR_COUNT = 20;
const MARGIN = 40;
const MIN_SPACING = 70;
const DRAG_THRESHOLD = 6;
const STEP_MS = 450;
const SHOOT_MIN_DIST = 40;
const SHOOT_MIN_MS = 90;
const SHOOT_SIZE = 0.6;

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

function attachGlow(star: HTMLButtonElement, voice: Voice, stopAfterMs?: number): void {
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
  star.classList.add("is-lit");
  star.classList.add("igniting");
  setTimeout(() => star.classList.remove("igniting"), 550); // matches ignite-burst's duration
  chainOrder.push(star);
  if (last) drawEdge(last, star);
  pluckStar(star, undefined, 1, true);
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
function pluckAt(x: number, y: number, volume = 1): void {
  const { ctx, master: out } = ensureAudio();
  const voice = new Voice(ctx, out, frequencyFor(y), panFor(x), brightnessFor(SHOOT_SIZE), clarityFor(y), volume);
  voice.pluck(durationFor(SHOOT_SIZE), fadeFor(SHOOT_SIZE));
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

  if (!hoverVoice) hoverVoice = new Voice(ctx, out, frequencyFor(y), panFor(x), 0, clarityFor(y), HOVER_VOLUME);
  else hoverVoice.update(frequencyFor(y), panFor(x), 0, clarityFor(y), HOVER_VOLUME);

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
