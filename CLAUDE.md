# COMP4020 prototype

Your starter repo for a COMP4020 prototype: a static site in HTML/CSS/TypeScript
that builds to plain HTML/CSS/JS and deploys to GitHub Pages. The deployed site
is what gets marked, not this repo.

The
[course website](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/)
publishes this deliverable's brief and spec, and this repo's name tells you
which deliverable applies. Read both before you plan or build.

## How to work in here

- Keep the dev server running (`pnpm dev`) so you see changes as you make them.
- Run `pnpm check` before you push.
- Open the page in a browser and look at it. The rendered page is the truth;
  your mental model of it isn't.
- When a check fails, read its output before you change anything.
- Never commit a red state.

## The checks

`typecheck`, `build`, `deploy`, `spec`, `lint`, `tests`, `evidence`, `links`,
`secrets`. Run `pnpm check`. Read the failure.

`spec/README.md`, `PROCESS.md` and `reflections/README.md` are in this repo and
say what they are for.

## This week's stack: Astro

This prototype uses Astro instead of the template's default hand-written
HTML/Vite. A few things that changed and why:

- Pages live in `src/pages/` as `.astro` files, not `.html` at the repo root.
  Styles live in `src/styles/`, imported from a page's frontmatter.
- `astro.config.mjs` sets `base: "/comp4020-crit4-leahylin"`. GitHub Pages
  serves this repo under that subpath, and Astro needs `base` set explicitly
  for its internal links and assets to resolve there — unlike the template's
  Vite config, which sidesteps this with relative (`base: "./"`) asset URLs.
  Any new internal link should go through `import.meta.env.BASE_URL` (or a
  relative path) rather than a hand-written absolute `/path`, or it'll 404 once
  deployed even though it looks fine in `astro dev`. `BASE_URL` itself has no
  trailing slash, so `` `${base}about` `` builds `/comp4020-crit4-leahylinabout`,
  not `/comp4020-crit4-leahylin/about` — every nav link had this bug at once
  before it was caught, because `pnpm check`'s build step never crawls hrefs.
  Write it as `` `${base}/about` `` and confirm with the links check below,
  not just a build that succeeds.
- `pnpm typecheck` runs `astro check` (not `tsc --noEmit`) — plain `tsc`
  doesn't understand `.astro` files.
- **The links check needed a CI fix.** Because `base` makes every internal
  href root-relative to `/comp4020-crit4-leahylin`, crawling the raw `dist/`
  folder (the template's default `pnpm dlx linkinator ./dist`) treats `dist/`
  as the domain root and 404s on that prefix — it's not a real broken link,
  just a mismatch between local raw-folder testing and how GitHub Pages
  actually serves a subpath. `.github/workflows/checks.yml`'s "Check internal
  links" step now boots `astro preview` and crawls the served URL instead of
  the raw folder. Reproduce it locally the same way rather than
  `pnpm dlx linkinator ./dist`, which will show a false positive:
  ```sh
  pnpm preview --port 4321 &
  pnpm dlx linkinator http://localhost:4321/comp4020-crit4-leahylin/ --silent --skip "instagram\.com"
  kill %1
  ```
  The `--skip` flag matters too: last week's footer had an Instagram link that
  got crawled as an external link, and Instagram bot-blocks crawlers with a
  `429` that carries no `retry-after` header — often enough to flake CI on a
  link that isn't actually broken. Linkinator's `--retry` only retries a `429`
  when the response includes `retry-after`, so it didn't help there; skipping
  the domain outright is the fix that actually works. Drop the `--skip` if this
  prototype has no such external link.

## This file is yours

A starting point, not a rulebook. As you learn what your prototype needs --- a
convention the work has to hold to, a sensor that keeps catching you out, a fact
about the stack that is easy to get wrong --- write it down here. Growing this
file is the work.
