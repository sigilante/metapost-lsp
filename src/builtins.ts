// Built-in names: primitives and plain.mp macros, with docs extracted from
// the MetaPost manual (see scripts/extract-builtins.py).

import data from "./builtins.json";

export type BuiltinKind = "internal" | "variable" | "constant" | "operator" | "command" | "macro" | "keyword" | "type";

export interface Builtin {
  name: string;
  kind: BuiltinKind;
  /** Defined by plain.mp rather than a primitive. */
  plain: boolean;
  docs: string[];
}

export const builtins = new Map<string, Builtin>();
for (const [name, entry] of Object.entries(data as Record<string, Omit<Builtin, "name">>)) {
  builtins.set(name, { name, ...entry });
}

// Names from plain.mp and the primitive set that the manual's tables omit.
// They still need to count as built-in so they are not mistaken for
// user variables.
const EXTRA_NAMES: Record<string, BuiltinKind> = {
  z: "macro", x: "variable", y: "variable", fill: "command", erase: "command",
  label: "macro", top: "operator", bot: "operator", lft: "operator", rt: "operator",
  ulft: "operator", urt: "operator", llft: "operator", lrt: "operator",
  penrazor: "constant", penspeck: "constant", currentpen: "variable",
  rotatedaround: "operator", rotatedabout: "operator", reflectedabout: "operator",
  counterclockwise: "operator", cutbefore: "operator", cutafter: "operator",
  tensepath: "operator", interpath: "operator", softjoin: "operator",
  takepower: "operator", magstep: "operator", thru: "operator", on: "operator",
  off: "operator", step: "keyword", hide: "macro", stop: "macro", exitunless: "keyword",
  interact: "macro", loggingall: "command", mod: "operator", dotprod: "operator",
  ditto: "constant", eps: "constant", epsilon: "constant", mpprocset: "internal",
  charexists: "operator", ligtable: "command", charlist: "command", extensible: "command",
  fontdimen: "command", headerbyte: "command", kern: "command", skipto: "command",
  boundarychar: "internal", designsize: "internal", fontmaking: "internal",
  charext: "internal", chardp: "internal", charht: "internal", charic: "internal",
  charwd: "internal", unitvector: "operator", mexp: "operator", mlog: "operator",
  str: "operator", center: "operator", image: "macro", drawarrow: "command",
  pensquare: "constant", base_name: "variable", base_version: "variable",
  mpxbreak: "command", infont: "operator", fontsize: "operator", within: "keyword",
  readstring: "operator", closefrom: "command", write: "command", to: "keyword",
  everyjob: "keyword", special: "command", numbersystem: "internal",
  numberprecision: "internal", arclength: "operator", arctime: "operator",
  intersectionpoint: "operator", intersectiontimes: "operator", whatever: "keyword",
  ahlength: "internal", ahangle: "internal", arrowhead: "macro", drawdblarrow: "command",
  incr: "macro", decr: "macro", round: "operator", ceiling: "operator", floor: "operator",
  sqrt: "operator", sind: "operator", cosd: "operator", hround: "operator", vround: "operator",
};
for (const [name, kind] of Object.entries(EXTRA_NAMES)) {
  if (!builtins.has(name)) builtins.set(name, { name, kind, plain: true, docs: [] });
}

export const TYPES = new Set([
  "numeric", "pair", "path", "pen", "picture", "string", "transform", "color", "rgbcolor", "cmykcolor", "boolean",
]);

/** Built-in vardefs that take a suffix right after the name: z1r, label.top. */
export const SUFFIX_MACROS = new Set(["z", "label", "dotlabel", "thelabel", "labels", "dotlabels", "makelabel", "penpos", "penlabels"]);

export const PARAM_TYPES = new Set(["expr", "suffix", "text", "primary", "secondary", "tertiary"]);

export const DEF_KEYWORDS = new Set(["def", "vardef", "primarydef", "secondarydef", "tertiarydef"]);

/** Tokens that open a construct closed by `enddef` (for nesting). */
export const isDefKeyword = (s: string) => DEF_KEYWORDS.has(s);
