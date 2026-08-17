import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// This week's brief: "turn the browser into a musical instrument". These
// assert the lines of the published spec that are mechanically checkable —
// see spec/README.md for what that split means and why the rest is left to
// the crit. Run against the BUILT site (`pnpm build` first, which `pnpm
// check` does for you).
const DIST = resolve("dist");

function allFiles(dir: string = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return allFiles(path);
    return [path];
  });
}

const files = allFiles();
const htmlFiles = files.filter((f) => extname(f) === ".html");
const pages = htmlFiles.map((path) => ({
  path,
  doc: new JSDOM(readFileSync(path, "utf8")).window.document,
}));

// Inline <script> content plus any separately-built JS files — wherever the
// synthesis code actually ends up depends on how big the bundle gets.
const allScriptText = [
  ...pages.flatMap(({ doc }) =>
    Array.from(doc.querySelectorAll("script"))
      .filter((s) => !s.src)
      .map((s) => s.textContent ?? ""),
  ),
  ...files
    .filter((f) => extname(f) === ".js")
    .map((f) => readFileSync(f, "utf8")),
].join("\n");

const AUDIO_FILE_EXTENSIONS = [".mp3", ".wav", ".ogg", ".m4a", ".flac"];

describe("instrument: sound is made live, not played back", () => {
  it("ships no <audio> or <video> element", () => {
    for (const { path, doc } of pages) {
      expect(
        doc.querySelectorAll("audio, video").length,
        `${path} has an <audio>/<video> element — the brief asks for sound synthesized live in the page, not played back`,
      ).toBe(0);
    }
  });

  it("ships no pre-recorded audio file", () => {
    const audioFile = files.find((f) =>
      AUDIO_FILE_EXTENSIONS.includes(extname(f).toLowerCase()),
    );
    expect(
      audioFile,
      `found a shipped audio file (${audioFile}) — sound should come from the Web Audio API, not a recording`,
    ).toBeUndefined();
  });

  it("uses the Web Audio API somewhere in the built script", () => {
    expect(
      /AudioContext/.test(allScriptText),
      "no reference to AudioContext in the built JS — this week's synthesis has to happen live in the browser",
    ).toBe(true);
  });
});

describe("instrument: playable with whatever is at hand", () => {
  it("has at least one native, keyboard-reachable control", () => {
    for (const { path, doc } of pages) {
      const native = doc.querySelectorAll("button, input, a[href], select");
      const customFocusable = doc.querySelectorAll("[tabindex]");
      expect(
        native.length + customFocusable.length,
        `${path} has no native interactive element and nothing with a tabindex — a keyboard or touch user needs something they can reach`,
      ).toBeGreaterThan(0);
    }
  });

  it("gives every ARIA button role a way to receive focus", () => {
    for (const { path, doc } of pages) {
      for (const el of doc.querySelectorAll('[role="button"]')) {
        expect(
          el.hasAttribute("tabindex"),
          `${path}: an element with role="button" has no tabindex, so it's a mouse-only control`,
        ).toBe(true);
      }
    }
  });
});

describe("instrument: no way to play it wrong", () => {
  const FAIL_STATE_PATTERN = /\b(score|game[\s-]?over|fail(?:ed|ure)?|you\s+(?:win|lose|lost)|lives\s*:|high\s?score)\b/i;

  it("ships no score, fail-state, or game-over language", () => {
    for (const { path, doc } of pages) {
      const text = doc.body?.textContent ?? "";
      const match = text.match(FAIL_STATE_PATTERN);
      expect(
        match,
        `${path} contains "${match?.[0]}" — the brief rules out a score or fail state`,
      ).toBeNull();
    }
  });
});
