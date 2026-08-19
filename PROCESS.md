# Process overview

## What I built

**Constellation Composer**: Click stars in the night sky to connect them into a chain that loops as a melody. Drag a star, or use the arrow keys when it is focused, to change its note. Move the mouse across the empty sky to create an ambient drone and trigger shooting star trails. Each vertical position is mapped to a note in a generated pentatonic scale, so any combination of stars or dragged positions will always sound musical. The sound design uses crystalline chimes, soft noise based whooshes for star activation and shooting stars, and a shared delay effect, making each connection feel like drawing a piece of music across the sky rather than playing isolated notes.


## The moments that mattered

**1. Clear constellation reset the data but not the visual state.** The Clear button correctly emptied the chain and removed the connection lines, but the stars still retained their `is-lit` class, making the constellation appear active after being cleared. Instead of re-rendering the entire scene and potentially resetting unrelated animation state, I removed the `is-lit` class as part of the same clear operation. After connecting several stars and pressing Clear, all stars correctly returned to their inactive state.
([`f867b7f`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-leahylin/commit/f867b7f)).

**2. The sound redesign was integrated into the existing Web Audio system.** Instead of creating a separate audio engine for the new activation, connection, and shooting star effects, I extended the existing Web Audio graph. The new `NoiseWhoosh` effects and shared delay are connected to the same master and analyser system used by the original `Voice` class. The new audio nodes also follow the existing cleanup pattern to avoid unnecessary resource usage. I verified the implementation with `pnpm check` and a browser test covering activation, the sequencer, hovering, dragging, keyboard interaction, and clearing and rebuilding the constellation, with no console errors.
([`e3d039d`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-leahylin/commit/e3d039d)).

