/**
 * Fixed lazy bridge to the public OMP TUI helpers.
 *
 * OMP's extension loader resolves these literal canonical imports to the
 * host's module registry, so the review component uses the same terminal
 * width/wrapping/key implementation as the running host. This file is loaded
 * only by the fixed local-main-TUI adapter after its context and evidence
 * gates pass; ordinary host-only paths never import it.
 */
export {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  normalizeTerminalOutput,
  stripTerminalSequences,
  visibleWidth,
  wrapLiteralLine,
} from "@oh-my-pi/pi-tui";
