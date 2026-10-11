// Workspace index: analyses for every MetaPost file, cross-file name
// resolution, and the graph of `input` statements.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  analyze,
  Analysis,
  collectReferences,
  containsPosition,
  Definition,
  MACRO_KINDS,
  MacroKind,
  matchesDeclarator,
  Position,
  Reference,
} from "./analyzer";
import { builtins, Builtin } from "./builtins";

export const EXTENSIONS = [".mp", ".mf", ".mpii", ".mpiv", ".mpvi", ".mpxl"];
const SKIP_DIRS = new Set(["node_modules", "out", "dist", "build"]);
const MAX_FILES = 5000;

export const uriToPath = (uri: string) => fileURLToPath(uri);
export const pathToUri = (p: string) => pathToFileURL(p).href;

export type Resolution =
  | { kind: "user"; definitions: Definition[] }
  | { kind: "builtin"; builtin: Builtin }
  | { kind: "none" };

export class Workspace {
  private analyses = new Map<string, Analysis>();
  private open = new Set<string>();
  private refCache = new Map<string, { version: number; refs: Reference[] }>();
  private macroNames = new Map<string, MacroKind>();
  /** Global (unscoped) definitions by name. */
  private globals = new Map<string, Definition[]>();
  private graph?: { version: number; parents: Map<string, Set<string>>; children: Map<string, Set<string>> };
  private inputCache = new Map<string, string | undefined>();
  private version = 0;
  roots: string[] = [];

  setRoots(roots: string[]) {
    this.roots = roots.map((r) => path.resolve(r));
  }

  /** Index every MetaPost file under the workspace roots. */
  scan() {
    let count = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 12 || count >= MAX_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
        } else if (e.isFile() && EXTENSIONS.includes(path.extname(e.name))) {
          const uri = pathToUri(full);
          if (!this.open.has(uri)) this.loadFromDisk(uri);
          count++;
        }
      }
    };
    for (const root of this.roots) walk(root, 0);
    this.changed();
  }

  loadFromDisk(uri: string) {
    try {
      const text = fs.readFileSync(uriToPath(uri), "utf8");
      this.analyses.set(uri, analyze(uri, text));
    } catch {
      this.analyses.delete(uri);
    }
  }

  /** Called for disk changes reported by the client's file watcher. */
  fileChanged(uri: string, deleted: boolean) {
    if (this.open.has(uri)) return;
    if (deleted) this.analyses.delete(uri);
    else this.loadFromDisk(uri);
    this.changed();
  }

  update(uri: string, text: string) {
    this.open.add(uri);
    this.analyses.set(uri, analyze(uri, text));
    this.changed();
  }

  close(uri: string) {
    this.open.delete(uri);
    // Fall back to the saved file so cross-file features keep working.
    if (uri.startsWith("file:")) this.loadFromDisk(uri);
    else this.analyses.delete(uri);
    this.changed();
  }

  get(uri: string): Analysis | undefined {
    return this.analyses.get(uri);
  }

  all(): Analysis[] {
    return [...this.analyses.values()];
  }

  private changed() {
    this.version++;
    this.inputCache.clear();
    const names = new Map<string, MacroKind>();
    const globals = new Map<string, Definition[]>();
    for (const a of this.analyses.values()) {
      for (const d of a.definitions) {
        if (d.scope || d.kind === "parameter" || d.kind === "loopvar" || d.kind === "save") continue;
        if (MACRO_KINDS.has(d.kind) && names.get(d.name) !== "vardef") names.set(d.name, d.kind === "vardef" ? "vardef" : "macro");
        if (!globals.has(d.name)) globals.set(d.name, []);
        globals.get(d.name)!.push(d);
      }
    }
    this.macroNames = names;
    this.globals = globals;
  }

  globalDefinitions(): Map<string, Definition[]> {
    return this.globals;
  }

  macroKind = (name: string) => this.macroNames.get(name);

  references(uri: string): Reference[] {
    const a = this.analyses.get(uri);
    if (!a) return [];
    const cached = this.refCache.get(uri);
    if (cached && cached.version === this.version) return cached.refs;
    const refs = collectReferences(a, this.macroKind);
    this.refCache.set(uri, { version: this.version, refs });
    return refs;
  }

  /** The reference or definition under the cursor. */
  referenceAt(uri: string, p: Position): Reference | undefined {
    return this.references(uri).find((r) => containsPosition(r.range, p));
  }

  /** What `name` (the root of `variable`), used at `p` in `uri`, refers to.
   * Declarations whose declarator matches the whole variable win over
   * other declarations of the same root; first assignments only count
   * for exactly the same variable (`x_a_0_base` ≠ `x_a_1_base`). */
  resolve(uri: string, name: string, p: Position, variable: string = name): Resolution {
    const a = this.analyses.get(uri);
    // Innermost local first: parameters, loop variables, saved names.
    // (A parameter's defining occurrence sits in the header, outside its scope.)
    const locals = (a?.definitions ?? []).filter(
      (d) => d.name === name && d.scope && (containsPosition(d.scope, p) || containsPosition(d.range, p)),
    );
    if (locals.length) {
      locals.sort((x, y) => rangeSize(x.scope!) - rangeSize(y.scope!));
      return { kind: "user", definitions: [locals[0]] };
    }
    const explicit: Definition[] = [];
    const implicit: Definition[] = [];
    // (An unscoped save only exists at top level, where it is a no-op, so
    // saves are not in the global index.)
    for (const d of this.globals.get(name) ?? []) (d.kind === "implicit" ? implicit : explicit).push(d);
    const matching = explicit.filter((d) => matchesDeclarator(variable, d.declarator ?? d.name));
    const sameVariable = implicit.filter((d) => (d.declarator ?? d.name) === variable);
    const found = matching.length ? matching : explicit.length ? explicit : sameVariable.length ? sameVariable : implicit;
    if (found.length) return { kind: "user", definitions: this.rank(found, uri, p) };
    const b = builtins.get(name);
    if (b) return { kind: "builtin", builtin: b };
    return { kind: "none" };
  }

  /** Keep only the nearest definitions: those in the same file (closest
   * preceding first), else those in files connected to it by `input`,
   * else everything. Each glyph file declaring its own `path stem`
   * should not send go-to-definition to every other glyph. */
  private rank(defs: Definition[], uri: string, p: Position): Definition[] {
    const same = defs.filter((d) => d.uri === uri);
    if (same.length) {
      const before = same.filter((d) => comparePos(d.range.start, p) <= 0).sort((x, y) => comparePos(y.range.start, x.range.start));
      const after = same.filter((d) => comparePos(d.range.start, p) > 0).sort((x, y) => comparePos(x.range.start, y.range.start));
      return [...before, ...after];
    }
    const related = this.relatedFiles(uri);
    const near = defs.filter((d) => related.has(d.uri));
    const pool = near.length ? near : defs;
    return [...pool].sort((x, y) => (x.uri < y.uri ? -1 : x.uri > y.uri ? 1 : comparePos(x.range.start, y.range.start)));
  }

  /** Every reference in the workspace that resolves to `target`. */
  findReferences(target: Definition): { uri: string; ref: Reference }[] {
    const out: { uri: string; ref: Reference }[] = [];
    for (const a of this.analyses.values()) {
      if (target.scope && a.uri !== target.uri) continue;
      for (const ref of this.references(a.uri)) {
        if (ref.name !== target.name) continue;
        if (target.scope && !containsPosition(target.scope, ref.range.start) && !sameRange(ref.range, target.range)) continue;
        const r = this.resolve(a.uri, ref.name, ref.range.start, ref.variable);
        if (r.kind === "user" && r.definitions.some((d) => sameDef(d, target))) out.push({ uri: a.uri, ref });
        else if (a.uri === target.uri && sameRange(ref.range, target.range)) out.push({ uri: a.uri, ref });
      }
    }
    return out;
  }

  /** Resolve an `input` target to a file. MetaPost looks relative to the
   * directory it runs in, which is usually a project root above the file,
   * so try the file's own directory and then each parent up to a root. */
  resolveInput(fromUri: string, target: string): string | undefined {
    const key = path.dirname(fromUri) + "\0" + target;
    if (this.inputCache.has(key)) return this.inputCache.get(key);
    const found = this.findInput(fromUri, target);
    this.inputCache.set(key, found);
    return found;
  }

  private findInput(fromUri: string, target: string): string | undefined {
    const names = path.extname(target) ? [target] : [target + ".mp", target];
    if (path.isAbsolute(target)) return names.find(isFile);
    let dir = path.dirname(uriToPath(fromUri));
    const stop = this.roots.find((r) => dir.startsWith(r)) ?? path.parse(dir).root;
    for (;;) {
      for (const n of names) {
        const candidate = path.join(dir, n);
        if (isFile(candidate)) return candidate;
      }
      if (dir === stop || dir === path.dirname(dir)) break;
      dir = path.dirname(dir);
    }
    return undefined;
  }

  /** Directory from which `fromUri`'s inputs resolve (where mpost should run). */
  inputBase(fromUri: string): string {
    const a = this.analyses.get(fromUri);
    const file = uriToPath(fromUri);
    for (const inp of a?.inputs ?? []) {
      const resolved = this.resolveInput(fromUri, inp.target);
      if (resolved && !path.isAbsolute(inp.target)) {
        const base = resolved.slice(0, resolved.length - normalizeTarget(inp.target, resolved).length);
        return base.replace(/[\\/]+$/, "") || path.dirname(file);
      }
    }
    return path.dirname(file);
  }

  private inputGraph() {
    if (this.graph?.version === this.version) return this.graph;
    const parents = new Map<string, Set<string>>();
    const children = new Map<string, Set<string>>();
    for (const a of this.analyses.values()) {
      for (const inp of a.inputs) {
        const target = this.resolveInput(a.uri, inp.target);
        if (!target) continue;
        const t = pathToUri(target);
        if (!parents.has(t)) parents.set(t, new Set());
        parents.get(t)!.add(a.uri);
        if (!children.has(a.uri)) children.set(a.uri, new Set());
        children.get(a.uri)!.add(t);
      }
    }
    this.graph = { version: this.version, parents, children };
    return this.graph;
  }

  /** Files that input `uri`, directly or indirectly. */
  includers(uri: string): Set<string> {
    const { parents } = this.inputGraph();
    const seen = new Set<string>();
    const queue = [uri];
    while (queue.length) {
      const u = queue.pop()!;
      for (const p of parents.get(u) ?? []) {
        if (!seen.has(p) && p !== uri) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    return seen;
  }

  /** Top-level files to compile so that `uri` is checked: the files that
   * include it and are not themselves included, or `uri` itself. */
  mainFilesFor(uri: string): string[] {
    const ups = this.includers(uri);
    if (!ups.size) return [uri];
    const tops = [...ups].filter((u) => this.includers(u).size === 0);
    return tops.length ? tops : [uri];
  }

  private relatedFiles(uri: string): Set<string> {
    const set = this.includers(uri);
    for (const c of this.inputGraph().children.get(uri) ?? []) set.add(c);
    return set;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The part of `resolved` that corresponds to `target` (with extension). */
function normalizeTarget(target: string, resolved: string): string {
  const withExt = path.extname(target) ? target : target + path.extname(resolved);
  return path.normalize(withExt);
}

export function comparePos(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

function rangeSize(r: { start: Position; end: Position }): number {
  return (r.end.line - r.start.line) * 100000 + (r.end.character - r.start.character);
}

function sameRange(a: { start: Position; end: Position }, b: { start: Position; end: Position }): boolean {
  return comparePos(a.start, b.start) === 0 && comparePos(a.end, b.end) === 0;
}

export function sameDef(a: Definition, b: Definition): boolean {
  return a.uri === b.uri && a.name === b.name && sameRange(a.range, b.range);
}
