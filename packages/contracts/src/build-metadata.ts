declare const __RECURS_VERSION__: string | undefined;

export const RECURS_VERSION = typeof __RECURS_VERSION__ === "string"
  ? __RECURS_VERSION__
  : "development";
