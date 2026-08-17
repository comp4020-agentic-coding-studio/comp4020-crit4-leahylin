// Constellation Composer: click stars to connect them into a chain, which
// loops as a melody; drag a star (or arrow-key it while focused) to change
// its note; drag across empty sky for a one-off shooting-star melody.
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

// A single note: oscillator -> lowpass filter -> stereo panner -> its own
// gain envelope -> the shared master bus. `pluck` is for taps/keys/shooting
// stars (self-releasing); `update`/`release` are for the held preview tone
// while dragging a star.
class Voice {
  private osc: OscillatorNode;
  private filter: BiquadFilterNode;
  private panner: StereoPannerNode;
  private gain: GainNode;

  constructor(
    private ctx: AudioContext,
    out: AudioNode,
    frequency: number,
    pan: number,
    brightness: number,
  ) {
    this.osc = ctx.createOscillator();
    this.osc.type = "triangle";
    this.osc.frequency.value = frequency;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 400 + brightness * 4000;
    this.filter.Q.value = 0.7;

    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = pan;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    this.osc.connect(this.filter).connect(this.panner).connect(this.gain).connect(out);
    this.osc.start();

    const now = ctx.currentTime;
    this.gain.gain.linearRampToValueAtTime(0.05 + brightness * 0.25, now + 0.015);
  }

  update(frequency: number, pan: number, brightness: number): void {
    const now = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(frequency, now, 0.03);
    this.panner.pan.setTargetAtTime(pan, now, 0.05);
    this.filter.frequency.setTargetAtTime(400 + brightness * 4000, now, 0.05);
    this.gain.gain.setTargetAtTime(0.05 + brightness * 0.25, now, 0.05);
  }

  release(fadeMs = 200): void {
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
    this.osc.stop(now + fadeMs / 1000 + 0.05);
  }

  pluck(durationMs = 350): void {
    setTimeout(() => this.release(180), durationMs);
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

const starState = new Map<HTMLButtonElement, StarState>();
const chainOrder: HTMLButtonElement[] = [];
const edges: Edge[] = [];
const starDrags = new Map<number, DragState>();
const justDragged = new Set<HTMLButtonElement>();

let sequencerTimer: number | null = null;
let sequencerStep = 0;

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

function pluckStar(star: HTMLButtonElement, durationMs = 350): void {
  const { ctx, master: out } = ensureAudio();
  const state = starState.get(star)!;
  const voice = new Voice(ctx, out, frequencyFor(state.y), panFor(state.x), brightnessFor(state.size));
  voice.pluck(durationMs);
  flashActive(star, durationMs);
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

function scheduleSequencerStep(): void {
  if (chainOrder.length < 2) return;
  const star = chainOrder[sequencerStep % chainOrder.length]!;
  const prevIndex = (sequencerStep - 1 + chainOrder.length) % chainOrder.length;
  const prevStar = chainOrder[prevIndex]!;
  pluckStar(star, Math.round(STEP_MS * 0.8));
  flashEdge(prevStar, star, Math.round(STEP_MS * 0.8));
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
  chainOrder.push(star);
  if (last) drawEdge(last, star);
  pluckStar(star);
  restartSequencer();
  dismissHint();
}

function clearConstellation(): void {
  stopSequencer();
  chainOrder.length = 0;
  for (const edge of edges) edge.line.remove();
  edges.length = 0;
}

function wireStar(star: HTMLButtonElement): void {
  star.addEventListener("pointerdown", (e) => {
    star.setPointerCapture(e.pointerId);
    starDrags.set(e.pointerId, { star, dragging: false, startX: e.clientX, startY: e.clientY, voice: null });
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
      drag.voice = new Voice(ctx, out, frequencyFor(state.y), panFor(state.x), brightnessFor(state.size));
      dismissHint();
    }
    if (drag.dragging) {
      const { x, y } = toSkyCoords(e.clientX, e.clientY);
      moveStar(star, x, y);
      const state = starState.get(star)!;
      drag.voice?.update(frequencyFor(state.y), panFor(state.x), brightnessFor(state.size));
    }
  });

  function endDrag(e: PointerEvent): void {
    const drag = starDrags.get(e.pointerId);
    if (!drag || drag.star !== star) return;
    if (drag.dragging) {
      drag.voice?.release();
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

  const diameter = 8 + size * 18;
  star.style.width = `${diameter}px`;
  star.style.height = `${diameter}px`;
  positionStar(star, x, y);

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
  pluckStar(target, 300);
  dismissHint();
});

// --- Shooting stars: dragging on empty sky plucks a quick, ephemeral
// melody along the path and leaves a fading trail — nothing here joins the
// permanent constellation.
function pluckAt(x: number, y: number, durationMs = 220): void {
  const { ctx, master: out } = ensureAudio();
  const voice = new Voice(ctx, out, frequencyFor(y), panFor(x), brightnessFor(SHOOT_SIZE));
  voice.pluck(durationMs);
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

interface ShootState {
  lastX: number;
  lastY: number;
  lastTime: number;
}

let shootState: ShootState | null = null;

sky.addEventListener("pointerdown", (e) => {
  const target = e.target;
  if (target instanceof Element && target.closest(".star")) return;
  sky.setPointerCapture(e.pointerId);
  const { x, y } = toSkyCoords(e.clientX, e.clientY);
  shootState = { lastX: x, lastY: y, lastTime: performance.now() };
  dismissHint();
});

sky.addEventListener("pointermove", (e) => {
  if (!shootState) return;
  const { x, y } = toSkyCoords(e.clientX, e.clientY);
  const dist = Math.hypot(x - shootState.lastX, y - shootState.lastY);
  const dt = performance.now() - shootState.lastTime;
  if (dist < SHOOT_MIN_DIST && dt < SHOOT_MIN_MS) return;
  drawTrailSegment(shootState.lastX, shootState.lastY, x, y);
  pluckAt(x, y);
  shootState = { lastX: x, lastY: y, lastTime: performance.now() };
});

function endShoot(): void {
  shootState = null;
}
sky.addEventListener("pointerup", endShoot);
sky.addEventListener("pointercancel", endShoot);

clearButton.addEventListener("click", () => clearConstellation());
