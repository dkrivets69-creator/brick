// Hand-drawn hints ("Крути", "Отклеивай") animated like frame-by-frame drawing:
// everything advances on a 12 fps tick, the strokes "boil" (the SVG displacement filter
// cycles through a few seeds), text is written left to right, then the arrow is drawn.
// Each hint is erased the same way in reverse after its action happens once.

const FPS = 12;
const WRITE_FRAMES = 10;     // frames to write a hint in
const ERASE_FRAMES = 7;      // erasing is a bit quicker
const BOIL_SEEDS = [3, 11, 27];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

class Hint {
  constructor(svg) {
    this.svg = svg;
    this.reveal = svg.querySelector('.reveal');
    this.revealWidth = Number(svg.viewBox.baseVal.width);
    this.arrow = svg.querySelector('.arrow');
    this.head = svg.querySelector('.head');
    this.arrowLength = this.arrow.getTotalLength();
    this.arrow.style.strokeDasharray = `${this.arrowLength}`;
    this.progress = 0;
    this.target = 0;
    this.done = false;
    this.render();
  }

  show() { if (!this.done) this.target = 1; }

  erase() {
    this.done = true;
    this.target = 0;
  }

  get busy() { return this.progress !== this.target || this.progress > 0; }

  step() {
    if (this.progress < this.target) this.progress = reduceMotion ? 1 : Math.min(1, this.progress + 1 / WRITE_FRAMES);
    else if (this.progress > this.target) this.progress = reduceMotion ? 0 : Math.max(0, this.progress - 1 / ERASE_FRAMES);
    this.render();
  }

  render() {
    const p = this.progress;
    const text = clamp01(p / 0.55);                 // write the word first…
    const arrow = clamp01((p - 0.5) / 0.4);         // …then draw the arrow…
    this.reveal.setAttribute('width', (text * this.revealWidth).toFixed(1));
    this.arrow.style.strokeDashoffset = `${(1 - arrow) * this.arrowLength}`;
    this.head.style.opacity = p > 0.93 ? '1' : '0'; // …and flick the arrowhead last
    this.svg.style.visibility = p > 0 ? 'visible' : 'hidden';
  }
}

export function setupHints({ showDelay = 900 } = {}) {
  const turbulence = document.querySelector('#boil feTurbulence');
  const hints = {
    spin: new Hint(document.getElementById('hint-spin')),
    peel: new Hint(document.getElementById('hint-peel')),
  };

  let frame = 0;
  let timer = null;
  const tick = () => {
    frame++;
    if (!reduceMotion) turbulence.setAttribute('seed', BOIL_SEEDS[frame % BOIL_SEEDS.length]);
    Object.values(hints).forEach((h) => h.step());
    // keep boiling while anything is on screen; stop once everything is erased
    if (Object.values(hints).every((h) => h.done && h.progress === 0)) {
      clearInterval(timer);
      timer = null;
    }
  };
  const run = () => { if (!timer) timer = setInterval(tick, 1000 / FPS); };

  setTimeout(() => { hints.spin.show(); run(); }, showDelay);
  setTimeout(() => { hints.peel.show(); run(); }, showDelay + 700);

  addEventListener('brick:spun', () => { hints.spin.erase(); run(); }, { once: true });
  addEventListener('brick:peeled', () => { hints.peel.erase(); run(); }, { once: true });
}
