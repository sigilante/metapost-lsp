// LSP feature handlers. Each takes the workspace and request parameters and
// returns protocol types; server.ts only wires them up.

import * as fs from "fs";
import * as path from "path";
import {
  CompletionItem,
  CompletionItemKind,
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  FoldingRangeKind,
  Hover,
  Location,
  MarkupKind,
  ParameterInformation,
  SignatureHelp,
  SymbolInformation,
  SymbolKind,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import { containsPosition, Definition, DefKind, Position, Range } from "./analyzer";
import { Builtin, BuiltinKind, builtins } from "./builtins";
import { Token } from "./lexer";
import { comparePos, EXTENSIONS, pathToUri, uriToPath, Workspace } from "./workspace";

// ---------------------------------------------------------------- helpers

function tokenAt(ws: Workspace, uri: string, p: Position): Token | undefined {
  const a = ws.get(uri);
  if (!a) return undefined;
  return a.tokens.find((t) => t.line === p.line && t.start <= p.character && p.character <= t.end && t.kind !== "comment");
}

function relativeName(ws: Workspace, uri: string): string {
  const file = uriToPath(uri);
  const root = ws.roots.find((r) => file.startsWith(r + path.sep));
  return root ? path.relative(root, file) : path.basename(file);
}

function definitionsAt(ws: Workspace, uri: string, p: Position): Definition[] {
  const ref = ws.referenceAt(uri, p);
  if (!ref) return [];
  const r = ws.resolve(uri, ref.name, ref.range.start, ref.variable);
  return r.kind === "user" ? r.definitions : [];
}

function sourceLine(ws: Workspace, d: Definition): string {
  const a = ws.get(d.uri);
  const line = a?.text.split(/\r?\n/)[d.range.start.line] ?? "";
  return line.replace(/%.*$/, "").trim();
}

/** One-line description of a definition, for hover and completion detail. */
export function describe(ws: Workspace, d: Definition): string {
  switch (d.kind) {
    case "macro":
    case "vardef":
    case "operator":
    case "let":
      return d.signature ?? d.name;
    case "parameter":
      return `(parameter) ${d.type ?? "expr"} ${d.name}`;
    case "loopvar":
      return `(loop variable) ${d.name}`;
    case "save":
      return `save ${d.declarator ?? d.name}`;
    case "internal":
      return `newinternal ${d.type ? d.type + " " : ""}${d.declarator ?? d.name}`;
    case "variable":
      return `${d.type ?? "numeric"} ${d.declarator ?? d.name}`;
    case "implicit":
      return sourceLine(ws, d) || d.name;
  }
}

function builtinMarkdown(b: Builtin): string {
  const origin = b.plain ? "plain.mp" : "primitive";
  const lines = [`\`${b.name}\` — ${b.kind} (${origin})`];
  if (b.docs.length === 1) lines.push("", b.docs[0]);
  else if (b.docs.length > 1) lines.push("", ...b.docs.map((d) => `- ${d}`));
  return lines.join("\n");
}

// ------------------------------------------------------------------ hover

export function hover(ws: Workspace, uri: string, p: Position): Hover | null {
  const a = ws.get(uri);
  const inp = a?.inputs.find((x) => containsPosition(x.range, p));
  if (inp) {
    const target = ws.resolveInput(uri, inp.target);
    return {
      contents: { kind: MarkupKind.Markdown, value: target ? `\`${relativeName(ws, pathToUri(target))}\`` : `File not found: \`${inp.target}\`` },
      range: inp.range,
    };
  }
  const ref = ws.referenceAt(uri, p);
  if (ref) {
    const r = ws.resolve(uri, ref.name, ref.range.start, ref.variable);
    if (r.kind === "user") {
      const d = r.definitions[0];
      const parts = ["```metapost\n" + describe(ws, d) + "\n```"];
      if (d.doc) parts.push(d.doc);
      const where = `${relativeName(ws, d.uri)}:${d.range.start.line + 1}`;
      const more = r.definitions.length > 1 ? ` (+${r.definitions.length - 1} more)` : "";
      if (d.kind !== "parameter" && d.kind !== "loopvar") parts.push(`*${d.kind === "implicit" ? "First assigned" : "Defined"} in ${where}${more}*`);
      return { contents: { kind: MarkupKind.Markdown, value: parts.join("\n\n") }, range: ref.range };
    }
    if (r.kind === "builtin") return { contents: { kind: MarkupKind.Markdown, value: builtinMarkdown(r.builtin) }, range: ref.range };
    return null;
  }
  const t = tokenAt(ws, uri, p);
  const b = t && builtins.get(t.text);
  if (t && b) {
    return {
      contents: { kind: MarkupKind.Markdown, value: builtinMarkdown(b) },
      range: { start: { line: t.line, character: t.start }, end: { line: t.line, character: t.end } },
    };
  }
  return null;
}

// ---------------------------------------------------- definition, references

export function definition(ws: Workspace, uri: string, p: Position): Location[] {
  const a = ws.get(uri);
  const inp = a?.inputs.find((x) => containsPosition(x.range, p));
  if (inp) {
    const target = ws.resolveInput(uri, inp.target);
    return target ? [Location.create(pathToUri(target), { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } })] : [];
  }
  return definitionsAt(ws, uri, p).map((d) => Location.create(d.uri, d.range));
}

export function references(ws: Workspace, uri: string, p: Position, includeDeclaration: boolean): Location[] {
  const defs = definitionsAt(ws, uri, p);
  if (!defs.length) return [];
  const out = ws.findReferences(defs[0]).filter(({ ref }) => includeDeclaration || !defs.some((d) => sameLoc(d, ref.range, d.uri)));
  return out.map(({ uri, ref }) => Location.create(uri, ref.range));
}

const sameLoc = (d: Definition, r: Range, uri: string) =>
  d.uri === uri && comparePos(d.range.start, r.start) === 0 && comparePos(d.range.end, r.end) === 0;

export function documentHighlight(ws: Workspace, uri: string, p: Position): DocumentHighlight[] {
  const defs = definitionsAt(ws, uri, p);
  if (!defs.length) return [];
  return ws
    .findReferences(defs[0])
    .filter((x) => x.uri === uri)
    .map(({ ref }) => ({ range: ref.range, kind: defs.some((d) => sameLoc(d, ref.range, uri)) ? DocumentHighlightKind.Write : DocumentHighlightKind.Read }));
}

// ------------------------------------------------------------------ rename

export function prepareRename(ws: Workspace, uri: string, p: Position): Range | null {
  const ref = ws.referenceAt(uri, p);
  if (!ref) return null;
  return definitionsAt(ws, uri, p).length ? ref.range : null;
}

export function rename(ws: Workspace, uri: string, p: Position, newName: string): WorkspaceEdit | null {
  if (!/^[A-Za-z_]+$/.test(newName)) throw new Error("A MetaPost name must consist of letters and underscores only.");
  const defs = definitionsAt(ws, uri, p);
  if (!defs.length) return null;
  const changes: Record<string, TextEdit[]> = {};
  for (const { uri: u, ref } of ws.findReferences(defs[0])) {
    (changes[u] ??= []).push(TextEdit.replace(ref.range, newName));
  }
  return { changes };
}

// -------------------------------------------------------------- completion

const BUILTIN_COMPLETION_KIND: Record<BuiltinKind, CompletionItemKind> = {
  internal: CompletionItemKind.Variable,
  variable: CompletionItemKind.Variable,
  constant: CompletionItemKind.Constant,
  operator: CompletionItemKind.Operator,
  command: CompletionItemKind.Function,
  macro: CompletionItemKind.Function,
  keyword: CompletionItemKind.Keyword,
  type: CompletionItemKind.TypeParameter,
};

const DEF_COMPLETION_KIND: Record<DefKind, CompletionItemKind> = {
  variable: CompletionItemKind.Variable,
  implicit: CompletionItemKind.Variable,
  save: CompletionItemKind.Variable,
  internal: CompletionItemKind.Property,
  macro: CompletionItemKind.Function,
  vardef: CompletionItemKind.Function,
  operator: CompletionItemKind.Operator,
  let: CompletionItemKind.Function,
  parameter: CompletionItemKind.TypeParameter,
  loopvar: CompletionItemKind.Variable,
};

export function completion(ws: Workspace, uri: string, p: Position): CompletionItem[] {
  const a = ws.get(uri);
  if (!a) return [];
  const lineText = a.text.split(/\r?\n/)[p.line] ?? "";
  const before = lineText.slice(0, p.character);

  // Inside a comment or string: nothing.
  const inside = a.tokens.find((t) => t.line === p.line && t.start < p.character && p.character <= t.end);
  if (inside && (inside.kind === "comment" || (inside.kind === "string" && !(inside.text.endsWith('"') && p.character === inside.end && inside.text.length > 1)))) {
    return [];
  }

  const inputMatch = /(?:^|[^A-Za-z_])input\s+([^\s;%"]*)$/.exec(before);
  if (inputMatch) return inputCompletions(ws, uri, p, inputMatch[1]);

  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  // Locals in scope.
  for (const d of a.definitions) {
    if (!d.scope || !containsPosition(d.scope, p) || seen.has(d.name)) continue;
    seen.add(d.name);
    items.push({ label: d.name, kind: DEF_COMPLETION_KIND[d.kind], detail: describe(ws, d), sortText: "0" + d.name });
  }
  // Workspace globals, preferring explicit definitions.
  for (const [name, defs] of ws.globalDefinitions()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const d = defs.find((x) => x.kind !== "implicit") ?? defs[0];
    items.push({
      label: name,
      kind: DEF_COMPLETION_KIND[d.kind],
      detail: describe(ws, d),
      documentation: d.doc ? { kind: MarkupKind.Markdown, value: d.doc } : undefined,
      sortText: "1" + name,
    });
  }
  for (const b of builtins.values()) {
    if (seen.has(b.name) || !/^[A-Za-z_]+$/.test(b.name)) continue;
    items.push({
      label: b.name,
      kind: BUILTIN_COMPLETION_KIND[b.kind],
      detail: `${b.kind} (${b.plain ? "plain.mp" : "primitive"})`,
      documentation: b.docs.length ? { kind: MarkupKind.Markdown, value: b.docs.join("\n\n") } : undefined,
      sortText: "2" + b.name,
    });
  }
  return items;
}

function inputCompletions(ws: Workspace, uri: string, p: Position, partial: string): CompletionItem[] {
  const base = ws.inputBase(uri);
  const items: CompletionItem[] = [];
  const range = { start: { line: p.line, character: p.character - partial.length }, end: p };
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || items.length > 2000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (EXTENSIONS.includes(path.extname(e.name))) {
        const rel = path.relative(base, full).split(path.sep).join("/");
        items.push({ label: rel, kind: CompletionItemKind.File, textEdit: TextEdit.replace(range, rel) });
      }
    }
  };
  walk(base, 0);
  return items;
}

// ----------------------------------------------------------- signature help

export function signatureHelp(ws: Workspace, uri: string, p: Position): SignatureHelp | null {
  const a = ws.get(uri);
  if (!a) return null;
  const toks = a.tokens.filter(
    (t) => t.kind !== "comment" && (t.line < p.line || (t.line === p.line && t.end <= p.character)),
  );
  // Walk back to the innermost unclosed `(` in this statement.
  let depth = 0;
  let commas = 0;
  let k = toks.length - 1;
  for (; k >= 0; k--) {
    const t = toks[k];
    if (t.text === ";") return null;
    if (t.text === ")") depth++;
    else if (t.text === "(") {
      if (depth === 0) break;
      depth--;
    } else if (t.text === "," && depth === 0) commas++;
  }
  if (k < 0) return null;
  // Earlier argument groups: f(a)(b, …
  let j = k - 1;
  let consumed = 0;
  while (j >= 0 && toks[j].text === ")") {
    let d = 0;
    let args = 1;
    for (; j >= 0; j--) {
      if (toks[j].text === ")") d++;
      else if (toks[j].text === "(" && --d === 0) break;
      else if (toks[j].text === "," && d === 1) args++;
    }
    consumed += args;
    j--;
  }
  const nameTok = toks[j];
  if (!nameTok || nameTok.kind !== "tag") return null;
  const r = ws.resolve(uri, nameTok.text, { line: nameTok.line, character: nameTok.start });
  if (r.kind !== "user") return null;
  const macro = r.definitions.find((d) => d.params?.some((x) => x.delimited));
  if (!macro) return null;
  const params = macro.params!.filter((x) => x.delimited);
  let label = `${macro.name}(`;
  const info: ParameterInformation[] = [];
  params.forEach((x, n) => {
    if (n) label += ", ";
    const start = label.length;
    label += `${x.type} ${x.name}`;
    info.push({ label: [start, label.length] });
  });
  label += ")";
  return {
    signatures: [{ label, parameters: info, documentation: macro.doc ? { kind: MarkupKind.Markdown, value: macro.doc } : undefined }],
    activeSignature: 0,
    activeParameter: Math.min(consumed + commas, params.length - 1),
  };
}

// ----------------------------------------------------------------- symbols

const SYMBOL_KIND: Partial<Record<DefKind, SymbolKind>> = {
  variable: SymbolKind.Variable,
  implicit: SymbolKind.Variable,
  internal: SymbolKind.Property,
  macro: SymbolKind.Function,
  vardef: SymbolKind.Function,
  operator: SymbolKind.Operator,
  let: SymbolKind.Function,
};

function figureName(label: string) {
  return `beginfig(${label})`;
}

export function documentSymbols(ws: Workspace, uri: string): DocumentSymbol[] {
  const a = ws.get(uri);
  if (!a) return [];
  const seenImplicit = new Set<string>();
  const explicitNames = new Set(a.definitions.filter((d) => d.kind !== "implicit").map((d) => d.name));
  const defs = a.definitions.filter((d) => {
    if (d.scope || !SYMBOL_KIND[d.kind]) return false;
    if (d.kind === "implicit") {
      if (explicitNames.has(d.name) || seenImplicit.has(d.name)) return false;
      seenImplicit.add(d.name);
    }
    return true;
  });
  const toSymbol = (d: Definition): DocumentSymbol => ({
    name: d.name,
    detail: describe(ws, d),
    kind: SYMBOL_KIND[d.kind]!,
    range: d.fullRange,
    selectionRange: d.range,
  });
  const figures: DocumentSymbol[] = a.figures.map((f) => ({
    name: figureName(f.label),
    detail: f.doc?.split("\n")[0],
    kind: SymbolKind.Namespace,
    range: f.range,
    selectionRange: f.selectionRange,
    children: [],
  }));
  const top: DocumentSymbol[] = [...figures];
  for (const d of defs) {
    const fig = figures.find((f) => containsPosition(f.range, d.range.start));
    (fig ? fig.children! : top).push(toSymbol(d));
  }
  return top.sort((x, y) => comparePos(x.range.start, y.range.start));
}

export function workspaceSymbols(ws: Workspace, query: string): SymbolInformation[] {
  const q = query.toLowerCase();
  const out: SymbolInformation[] = [];
  for (const a of ws.all()) {
    for (const f of a.figures) {
      const name = figureName(f.label) + (f.doc ? " " + f.doc.split("\n")[0] : "");
      if (name.toLowerCase().includes(q)) out.push(SymbolInformation.create(name, SymbolKind.Namespace, f.selectionRange, a.uri));
    }
  }
  for (const [name, defs] of ws.globalDefinitions()) {
    if (!name.toLowerCase().includes(q)) continue;
    const explicit = defs.filter((d) => d.kind !== "implicit");
    for (const d of explicit.length ? explicit : defs.slice(0, 1)) {
      out.push(SymbolInformation.create(name, SYMBOL_KIND[d.kind] ?? SymbolKind.Variable, d.range, d.uri));
    }
    if (out.length > 1000) break;
  }
  return out;
}

// --------------------------------------------------------- semantic tokens

export const SEMANTIC_TOKEN_TYPES = ["variable", "parameter", "function", "macro", "operator", "property"];
export const SEMANTIC_TOKEN_MODIFIERS = ["declaration", "readonly"];

const TYPE_FOR_DEF: Record<DefKind, string> = {
  variable: "variable",
  implicit: "variable",
  save: "variable",
  internal: "property",
  macro: "macro",
  vardef: "function",
  operator: "operator",
  let: "macro",
  parameter: "parameter",
  loopvar: "parameter",
};

export function semanticTokens(ws: Workspace, uri: string): number[] {
  const entries: { line: number; char: number; length: number; type: number; mods: number }[] = [];
  for (const ref of ws.references(uri)) {
    const r = ws.resolve(uri, ref.name, ref.range.start, ref.variable);
    let type: string | undefined;
    let mods = 0;
    if (r.kind === "user") {
      const d = r.definitions[0];
      type = TYPE_FOR_DEF[d.kind];
      if (r.definitions.some((x) => sameLoc(x, ref.range, uri))) mods |= 1;
      if (d.kind === "internal") mods |= 2;
    } else if (r.kind === "none") {
      type = "variable"; // never declared, but still a variable
    }
    if (!type) continue;
    entries.push({
      line: ref.range.start.line,
      char: ref.range.start.character,
      length: ref.range.end.character - ref.range.start.character,
      type: SEMANTIC_TOKEN_TYPES.indexOf(type),
      mods,
    });
  }
  entries.sort((x, y) => x.line - y.line || x.char - y.char);
  const data: number[] = [];
  let line = 0;
  let char = 0;
  for (const e of entries) {
    const dl = e.line - line;
    data.push(dl, dl ? e.char : e.char - char, e.length, e.type, e.mods);
    line = e.line;
    char = e.char;
  }
  return data;
}

// --------------------------------------------------------- folding, links

export function foldingRanges(ws: Workspace, uri: string): FoldingRange[] {
  const a = ws.get(uri);
  if (!a) return [];
  return a.folds
    .filter((f) => f.endLine > f.startLine)
    .map((f) => ({
      startLine: f.startLine,
      endLine: f.endLine,
      kind: f.kind === "comment" ? FoldingRangeKind.Comment : FoldingRangeKind.Region,
    }));
}

export function documentLinks(ws: Workspace, uri: string): DocumentLink[] {
  const a = ws.get(uri);
  if (!a) return [];
  const links: DocumentLink[] = [];
  for (const inp of a.inputs) {
    const target = ws.resolveInput(uri, inp.target);
    if (target) links.push({ range: inp.range, target: pathToUri(target) });
  }
  return links;
}
