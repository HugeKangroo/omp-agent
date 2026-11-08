/**
 * Concrete declaration for the real `human-review-runtime.mjs` bridge.
 *
 * The implementation imports the canonical public `@oh-my-pi/pi-tui` root.
 * These declarations describe this repository's bridge exports; they do not
 * declare a fictional installed runtime package.
 */
export declare function visibleWidth(str: string): number;
export declare function wrapLiteralLine(line: string, width: number): string[];
export declare function matchesKey(data: string, keyId: string): boolean;
export declare function isKeyRelease(data: string): boolean;
export declare function isKeyRepeat(data: string): boolean;
export declare function stripTerminalSequences(str: string): string;
export declare function normalizeTerminalOutput(str: string): string;
export declare const BRACKETED_PASTE_START: string;
export declare const BRACKETED_PASTE_END: string;
