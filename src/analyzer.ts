// Per-document analysis: definitions, scopes, references, figures, inputs.
//
// MetaPost's grammar is defined by macros at run time, so this is not a
// parser. It walks the token stream looking for the statements that
// introduce names (declarations, save, newinternal, let, macro headers,
// for loops, first assignments) and records every variable occurrence.
// Everything here is a pure function of the text; cross-file resolution
// lives in workspace.ts.

import { Token, tokenize, tokenEndLine } from "./lexer";
import { builtins, DEF_KEYWORDS, PARAM_TYPES, SUFFIX_MACROS, TYPES } from "./builtins";

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}

export type DefKind =
  | "variable" // type declaration
  | "implicit" // first assignment to an undeclared name
  | "save" // save x (local to the enclosing group)
  | "internal" // newinternal
  | "macro" // def
  | "vardef"
  | "operator" // primarydef / secondarydef / tertiarydef
  | "let"
  | "parameter"
  | "loopvar";

export const MACRO_KINDS: ReadonlySet<DefKind> = new Set(["macro", "vardef", "operator", "let"]);

export interface Param {
  name: string;
  type: string; // expr, suffix, text, primary, …
  delimited: boolean;
}

export interface Definition {
  name: string;
  kind: DefKind;
  uri: string;
  /** The defining occurrence of the name. */
  range: Range;
  /** The whole statement or macro, for outlines and folding. */
  fullRange: Range;
  /** Where the name is visible; undefined means global. */
  scope?: Range;
  /** Declared type (numeric, pair, …) or parameter type. */
  type?: string;
  /** The declared variable as written, e.g. `x[]r`. */
  declarator?: string;
  /** Macro header as written, from the def keyword to `=`. */
  signature?: string;
  params?: Param[];
  doc?: string;
}

export type RefRole = "root" | "macro";

export interface Reference {
  name: string;
  range: Range;
  role: RefRole;
  /** The whole variable as written, normalized: `x_a_0_base`, `p[i]r`. */
  variable: string;
}

/** How a macro name affects the tokens after it. */
export type MacroKind = "vardef" | "macro";

export interface Figure {
  /** Text inside beginfig( … ), e.g. "1024". */
  label: string;
  range: Range;
  selectionRange: Range;
  doc?: string;
}

export interface InputRef {
  target: string;
  range: Range;
}

export interface Fold {
  startLine: number;
  endLine: number;
  kind?: "comment" | "region";
}

export interface Analysis {
  uri: string;
  text: string;
  tokens: Token[];
  definitions: Definition[];
  figures: Figure[];
  inputs: InputRef[];
  folds: Fold[];
}

const pos = (line: number, character: number): Position => ({ line, character });
const tokenRange = (t: Token): Range => ({ start: pos(t.line, t.start), end: pos(tokenEndLine(t), t.end) });
const spanRange = (a: Token, b: Token): Range => ({ start: pos(a.line, a.start), end: pos(tokenEndLine(b), b.end) });

export function containsPosition(r: Range, p: Position): boolean {
  if (p.line < r.start.line || p.line > r.end.line) return false;
  if (p.line === r.start.line && p.character < r.start.character) return false;
  if (p.line === r.end.line && p.character > r.end.character) return false;
  return true;
}

/** Comments that document the token on `line`: the block of whole-line
 * comments directly above it, plus a trailing comment on the line itself. */
function docFor(line: number, comments: Map<number, { text: string; whole: boolean }>): string | undefined {
  const above: string[] = [];
  for (let l = line - 1; l >= 0; l--) {
    const c = comments.get(l);
    if (!c || !c.whole) break;
    above.unshift(c.text);
  }
  const trailing = comments.get(line);
  const parts = [...above];
  if (trailing && !trailing.whole) parts.push(trailing.text);
  const doc = parts.join("\n").trim();
  return doc || undefined;
}

const stripComment = (s: string) => s.replace(/^%+\s?/, "").replace(/\s+$/, "");

type BlockKind = "group" | "def" | "vardef" | "for" | "if" | "figure";

interface Block {
  kind: BlockKind;
  open: Token;
  /** Body start (after the header) for defs and loops. */
  bodyStart?: Token;
  /** Names introduced by save, parameters, or the loop variable. */
  locals: Definition[];
  /** Waiting for the `:` that ends an if/for head. */
  awaitingColon?: boolean;
  figure?: Figure;
}

export function analyze(uri: string, text: string): Analysis {
  const tokens = tokenize(text);
  const comments = new Map<number, { text: string; whole: boolean }>();
  const sig: Token[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === "comment") {
      const prev = tokens[k - 1];
      comments.set(t.line, { text: stripComment(t.text), whole: !prev || tokenEndLine(prev) !== t.line });
    } else {
      sig.push(t);
    }
  }

  const lines = text.split(/\r?\n/);
  const definitions: Definition[] = [];
  const figures: Figure[] = [];
  const inputs: InputRef[] = [];
  const folds: Fold[] = [];
  const stack: Block[] = [];
  let statementStart = true;

  const isLocal = (name: string) => stack.some((b) => b.locals.some((d) => d.name === name));
  const innermostGroup = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].kind === "group" || stack[k].kind === "vardef" || stack[k].kind === "figure") return stack[k];
    }
    return undefined;
  };
  const closeBlock = (kinds: BlockKind[], closer: Token) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (kinds.includes(stack[k].kind)) {
        // Anything opened inside and never closed ends here too.
        const [block] = stack.splice(k, stack.length - k);
        const scope: Range = spanRange(block.bodyStart ?? block.open, closer);
        for (const d of block.locals) d.scope = scope;
        if (closer.line > block.open.line) folds.push({ startLine: block.open.line, endLine: closer.line - 1, kind: "region" });
        return block;
      }
    }
    return undefined;
  };
  const define = (d: Omit<Definition, "uri">): Definition => {
    const def = { uri, ...d };
    definitions.push(def);
    return def;
  };

  /** Read a variable starting at sig[k]: a tag plus suffixes and subscripts.
   * Returns the index after it and the text as written. */
  const readVariable = (k: number): { end: number; text: string } => {
    let text = sig[k].text;
    let j = k + 1;
    while (j < sig.length) {
      const t = sig[j];
      if (t.kind === "number" || (t.kind === "tag" && !isSpark(t.text))) {
        text += (t.afterDot ? "." : "") + t.text;
        j++;
      } else if (t.text === "[") {
        let depth = 0;
        let m = j;
        for (; m < sig.length; m++) {
          if (sig[m].text === "[") depth++;
          else if (sig[m].text === "]" && --depth === 0) break;
          else if (sig[m].text === ";") break;
        }
        if (sig[m]?.text !== "]") break;
        text += bracketText(sig.slice(j + 1, m));
        j = m + 1;
      } else break;
    }
    return { end: j, text };
  };

  /** Parse a `def`/`vardef`/`…def` header starting at sig[k]. */
  const parseHeader = (k: number) => {
    const kw = sig[k];
    const params: Param[] = [];
    const paramTokens: { token: Token; param: Param }[] = [];
    let nameToken: Token | undefined;
    let j = k + 1;
    let operatorLeft: Token | undefined;
    let operatorRight: Token | undefined;

    if (kw.text === "primarydef" || kw.text === "secondarydef" || kw.text === "tertiarydef") {
      operatorLeft = sig[j]?.kind === "tag" ? sig[j++] : undefined;
      nameToken = sig[j++];
      operatorRight = sig[j]?.kind === "tag" ? sig[j++] : undefined;
    } else {
      nameToken = sig[j++];
      if (kw.text === "vardef") {
        // vardef names may carry suffixes: vardef foo[]bar@#(…)
        while (j < sig.length && sig[j].text !== "(" && sig[j].text !== "=" && sig[j].text !== ":=" && !PARAM_TYPES.has(sig[j].text)) {
          if (sig[j].text === ";") break;
          j++;
        }
      }
    }

    while (j < sig.length) {
      const t = sig[j];
      if (t.text === "=" || t.text === ":=" || t.text === ";") break;
      if (t.text === "(") {
        // (expr a, b)(suffix s)
        let type = "expr";
        j++;
        while (j < sig.length && sig[j].text !== ")" && sig[j].text !== ";") {
          const u = sig[j];
          if (PARAM_TYPES.has(u.text)) type = u.text;
          else if (u.kind === "tag") {
            const param = { name: u.text, type, delimited: true };
            params.push(param);
            paramTokens.push({ token: u, param });
          }
          j++;
        }
        j++;
        continue;
      }
      if (PARAM_TYPES.has(t.text) && sig[j + 1]?.kind === "tag") {
        // Undelimited: primary x, expr x of y, text t
        const param = { name: sig[j + 1].text, type: t.text, delimited: false };
        params.push(param);
        paramTokens.push({ token: sig[j + 1], param });
        j += 2;
        if (sig[j]?.text === "of" && sig[j + 1]?.kind === "tag") {
          const of = { name: sig[j + 1].text, type: "primary", delimited: false };
          params.push(of);
          paramTokens.push({ token: sig[j + 1], param: of });
          j += 2;
        }
        continue;
      }
      j++;
    }
    const eq = Math.min(j, sig.length - 1);
    const headerEnd = sig[eq];
    const signature = lines
      .slice(kw.line, headerEnd.line + 1)
      .map((l, n, all) => {
        const from = n === 0 ? kw.start : 0;
        const to = n === all.length - 1 ? headerEnd.start : l.length;
        return l.slice(from, to).replace(/%.*$/, "");
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (operatorLeft) {
      const param = { name: operatorLeft.text, type: "primary", delimited: false };
      params.unshift(param);
      paramTokens.unshift({ token: operatorLeft, param });
    }
    if (operatorRight) {
      const param = { name: operatorRight.text, type: "primary", delimited: false };
      params.push(param);
      paramTokens.push({ token: operatorRight, param });
    }
    return { nameToken, params, paramTokens, headerEnd: eq, signature };
  };

  // Names that are not variables: keywords, built-in operators and macros,
  // and macros defined in this file. Used to tell where a variable's
  // suffix ends. Cross-file macros are handled when references are built.
  const localMacros = new Set<string>();
  const isSpark = (name: string) => {
    if (localMacros.has(name)) return true;
    const b = builtins.get(name);
    return !!b && b.kind !== "variable" && b.kind !== "internal" && b.kind !== "constant";
  };
  for (let k = 0; k + 1 < sig.length; k++) {
    if (DEF_KEYWORDS.has(sig[k].text)) {
      // primarydef a op b: the name is the second token.
      const name = sig[k].text === "def" || sig[k].text === "vardef" ? sig[k + 1] : sig[k + 2];
      if (name) localMacros.add(name.text);
    }
  }

  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    const atStart = statementStart;
    statementStart = false;

    if (t.text === ";") {
      statementStart = true;
      continue;
    }
    if (t.text === ":") {
      const head = stack[stack.length - 1];
      if (head?.awaitingColon) {
        head.awaitingColon = false;
        head.bodyStart = sig[i + 1] ?? t;
      }
      statementStart = true;
      continue;
    }
    if (t.kind !== "tag") continue;

    switch (t.text) {
      case "def":
      case "vardef":
      case "primarydef":
      case "secondarydef":
      case "tertiarydef": {
        const h = parseHeader(i);
        if (!h.nameToken) break;
        const kind: DefKind = t.text === "def" ? "macro" : t.text === "vardef" ? "vardef" : "operator";
        const end = findEnddef(sig, h.headerEnd + 1);
        const macro = define({
          name: h.nameToken.text,
          kind,
          range: tokenRange(h.nameToken),
          fullRange: spanRange(t, sig[end] ?? sig[sig.length - 1]),
          signature: h.signature,
          params: h.params,
          doc: docFor(t.line, comments),
        });
        const block: Block = { kind: kind === "vardef" ? "vardef" : "def", open: t, locals: [] };
        block.bodyStart = sig[h.headerEnd + 1] ?? sig[h.headerEnd];
        for (const { token, param } of h.paramTokens) {
          block.locals.push(
            define({
              name: param.name,
              kind: "parameter",
              type: param.type,
              range: tokenRange(token),
              fullRange: macro.fullRange,
              doc: `Parameter of ${macro.name}`,
            }),
          );
        }
        stack.push(block);
        i = h.headerEnd;
        statementStart = true;
        continue;
      }
      case "enddef":
        closeBlock(["def", "vardef"], t);
        continue;
      case "begingroup":
        stack.push({ kind: "group", open: t, locals: [] });
        statementStart = true;
        continue;
      case "endgroup":
        closeBlock(["group"], t);
        continue;
      case "beginfig": {
        let label = "";
        let j = i + 1;
        if (sig[j]?.text === "(") {
          let depth = 0;
          const parts: string[] = [];
          for (; j < sig.length; j++) {
            if (sig[j].text === "(") depth++;
            else if (sig[j].text === ")" && --depth === 0) break;
            else if (depth > 0) parts.push(sig[j].text);
          }
          label = parts.join(" ");
        }
        const figure: Figure = {
          label,
          range: tokenRange(t),
          selectionRange: spanRange(t, sig[Math.min(j, sig.length - 1)]),
          doc: docFor(t.line, comments),
        };
        figures.push(figure);
        stack.push({ kind: "figure", open: t, locals: [], figure });
        continue;
      }
      case "endfig": {
        const block = closeBlock(["figure"], t);
        if (block?.figure) block.figure.range = spanRange(block.open, t);
        continue;
      }
      case "if":
        stack.push({ kind: "if", open: t, locals: [], awaitingColon: true });
        continue;
      case "elseif":
      case "else": {
        const top = stack[stack.length - 1];
        if (top?.kind === "if") top.awaitingColon = true;
        continue;
      }
      case "fi":
        closeBlock(["if"], t);
        statementStart = true;
        continue;
      case "for":
      case "forsuffixes":
      case "forever": {
        const block: Block = { kind: "for", open: t, locals: [], awaitingColon: true };
        const v = sig[i + 1];
        const next = sig[i + 2];
        if (t.text !== "forever" && v?.kind === "tag" && (next?.text === "=" || next?.text === ":=" || next?.text === "within")) {
          block.locals.push(
            define({
              name: v.text,
              kind: "loopvar",
              type: t.text === "forsuffixes" ? "suffix" : "expr",
              range: tokenRange(v),
              fullRange: tokenRange(t),
            }),
          );
          i++;
        }
        stack.push(block);
        continue;
      }
      case "endfor": {
        const block = closeBlock(["for"], t);
        if (block) for (const d of block.locals) d.fullRange = spanRange(block.open, t);
        statementStart = true;
        continue;
      }
      case "input": {
        // A file name is everything up to a space, `;` or `%`.
        const line = lines[t.line];
        const m = /^\s+([^\s;%"]+)/.exec(line.slice(t.end));
        if (m) {
          const start = t.end + m[0].length - m[1].length;
          inputs.push({ target: m[1], range: { start: pos(t.line, start), end: pos(t.line, start + m[1].length) } });
          while (i + 1 < sig.length && sig[i + 1].line === t.line && sig[i + 1].start < start + m[1].length) i++;
        }
        continue;
      }
    }

    if (!atStart) continue;

    // Statements that introduce names.
    if (TYPES.has(t.text) || t.text === "save" || t.text === "newinternal") {
      const kind: DefKind = t.text === "save" ? "save" : t.text === "newinternal" ? "internal" : "variable";
      let type = TYPES.has(t.text) ? t.text : undefined;
      let j = i + 1;
      if (kind === "internal" && sig[j] && TYPES.has(sig[j].text)) type = sig[j++].text;
      const group = kind === "save" ? innermostGroup() : undefined;
      while (j < sig.length && sig[j].text !== ";") {
        const u = sig[j];
        if (u.kind === "tag") {
          const v = readVariable(j);
          const def = define({
            name: u.text,
            kind,
            type,
            declarator: v.text,
            range: tokenRange(u),
            fullRange: spanRange(t, sig[Math.max(j, v.end - 1)]),
            doc: docFor(u.line, comments) ?? docFor(t.line, comments),
          });
          group?.locals.push(def);
          j = v.end;
        } else j++;
      }
      i = j - 1;
      continue;
    }
    if (t.text === "let" && sig[i + 1]) {
      const name = sig[i + 1];
      const target = sig[i + 3];
      define({
        name: name.text,
        kind: "let",
        range: tokenRange(name),
        fullRange: spanRange(t, target ?? name),
        signature: `let ${name.text} = ${target?.text ?? ""}`,
        doc: docFor(t.line, comments),
      });
      i += 1;
      continue;
    }
    if (!isSpark(t.text) && !builtins.has(t.text) && !isLocal(t.text)) {
      // `name := …` or `name = …` at the start of a statement.
      const v = readVariable(i);
      const op = sig[v.end];
      if (op && (op.text === ":=" || op.text === "=")) {
        define({
          name: t.text,
          kind: "implicit",
          declarator: v.text,
          range: tokenRange(t),
          fullRange: spanRange(t, op),
          doc: docFor(t.line, comments),
        });
      }
    }
  }
  // Unclosed blocks run to the end of the file.
  const last = sig[sig.length - 1];
  while (stack.length && last) closeBlock([stack[stack.length - 1].kind], last);

  // Runs of two or more whole-line comments fold.
  let runStart = -1;
  for (let l = 0; l <= lines.length; l++) {
    const c = comments.get(l);
    if (c?.whole) {
      if (runStart < 0) runStart = l;
    } else {
      if (runStart >= 0 && l - 1 > runStart) folds.push({ startLine: runStart, endLine: l - 1, kind: "comment" });
      runStart = -1;
    }
  }

  return { uri, text, tokens, definitions, figures, inputs, folds };
}

/** `p[3]` is the same variable as `p3`; `[]` stays a generic subscript. */
function bracketText(inner: Token[]): string {
  if (inner.length === 0) return "[]";
  if (inner.length === 1 && inner[0].kind === "number") return inner[0].text;
  return "[" + inner.map((x) => x.text).join(" ") + "]";
}

/** Does a reference's variable match a declarator? Each `[]` in the
 * declarator matches any subscript: `x_a_[]_base` matches `x_a_0_base`. */
export function matchesDeclarator(variable: string, declarator: string): boolean {
  if (variable === declarator) return true;
  if (!declarator.includes("[]")) return false;
  const pattern = declarator
    .split("[]")
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("(?:\\d*\\.?\\d+|\\[[^\\]]*\\])");
  return new RegExp("^" + pattern + "$").test(variable);
}

function findEnddef(sig: Token[], from: number): number {
  let depth = 1;
  for (let k = from; k < sig.length; k++) {
    if (sig[k].kind !== "tag") continue;
    if (DEF_KEYWORDS.has(sig[k].text)) depth++;
    else if (sig[k].text === "enddef" && --depth === 0) return k;
  }
  return sig.length - 1;
}

/** Variable roots and macro uses. `macroKind` reports user macros from
 * the whole workspace: a name that is a macro ends a variable's suffix just
 * like a keyword does, and a vardef takes a suffix of its own. */
export function collectReferences(a: Analysis, macroKind: (name: string) => MacroKind | undefined): Reference[] {
  const refs: Reference[] = [];
  // The reference whose variable the next suffix tokens extend, or "skip"
  // after a vardef (its suffix is not a variable at all).
  let current: Reference | "skip" | undefined;
  const brackets: { owner: Reference | "skip" | undefined; tokens: Token[] }[] = [];
  const inputRanges = a.inputs.map((x) => x.range);
  const extend = (s: string) => {
    if (current && current !== "skip") current.variable += s;
  };

  for (const t of a.tokens) {
    if (t.kind === "comment") continue;
    brackets[brackets.length - 1]?.tokens.push(t);
    if (t.kind === "tag") {
      if (inputRanges.some((r) => containsPosition(r, pos(t.line, t.start)))) continue;
      if (current && t.afterDot) {
        // A suffix after a period, as in `z.a` or `label.top`.
        extend("." + t.text);
        continue;
      }
      const mk = macroKind(t.text);
      if (mk) {
        refs.push({ name: t.text, range: tokenRange(t), role: "macro", variable: t.text });
        current = mk === "vardef" ? "skip" : undefined;
        continue;
      }
      const b = builtins.get(t.text);
      if (b && b.kind !== "variable" && b.kind !== "internal" && b.kind !== "constant") {
        current = SUFFIX_MACROS.has(t.text) ? "skip" : undefined;
        continue;
      }
      if (current) {
        // A suffix such as the `r` in `z1r` or `_base` in `x_a_0_base`.
        extend(t.text);
        continue;
      }
      // Built-in variables (x, y, currentpen, …) are recorded too: a file
      // may declare its own `x[]`, and resolution falls back to the built-in.
      const ref: Reference = { name: t.text, range: tokenRange(t), role: "root", variable: t.text };
      refs.push(ref);
      current = ref;
      continue;
    }
    if (t.kind === "number" && current) {
      extend(t.text);
      continue;
    }
    if (t.text === "[") {
      brackets.push({ owner: current, tokens: [] });
      current = undefined;
      continue;
    }
    if (t.text === "]") {
      const open = brackets.pop();
      current = open?.owner;
      if (open && current) extend(bracketText(open.tokens.slice(0, -1)));
      continue;
    }
    current = undefined;
  }
  return refs;
}
