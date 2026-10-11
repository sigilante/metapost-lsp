import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as features from "../src/features";
import { pathToUri, Workspace } from "../src/workspace";

const ROOT = path.resolve(__dirname, "../../test/fixtures/project");
const MAIN = pathToUri(path.join(ROOT, "src/main.mp"));
const A = pathToUri(path.join(ROOT, "src/glyphs/a.mp"));
const B = pathToUri(path.join(ROOT, "src/glyphs/b.mp"));

function workspace() {
  const ws = new Workspace();
  ws.setRoots([ROOT]);
  ws.scan();
  return ws;
}

/** Position of the n-th occurrence of `word` on `line`. */
function at(ws: Workspace, uri: string, line: number, word: string, n = 0) {
  const text = ws.get(uri)!.text.split("\n")[line];
  let idx = -1;
  for (let k = 0; k <= n; k++) idx = text.indexOf(word, idx + 1);
  assert.ok(idx >= 0, `${word} not found on line ${line}: ${text}`);
  return { line, character: idx + 1 };
}

test("scan indexes every file", () => {
  assert.equal(workspace().all().length, 3);
});

test("inputs resolve from the project root and find the main file", () => {
  const ws = workspace();
  assert.equal(ws.resolveInput(MAIN, "src/glyphs/a.mp"), path.join(ROOT, "src/glyphs/a.mp"));
  assert.equal(ws.inputBase(MAIN), ROOT);
  assert.deepEqual(ws.mainFilesFor(A), [MAIN]);
  assert.deepEqual(ws.mainFilesFor(MAIN), [MAIN]);
});

test("go to definition across files", () => {
  const ws = workspace();
  const defs = features.definition(ws, A, at(ws, A, 3, "x_height"));
  assert.deepEqual(defs.map((d) => [d.uri, d.range.start.line]), [[MAIN, 6]]);
  const macro = features.definition(ws, A, at(ws, A, 5, "penradius"));
  assert.deepEqual(macro.map((d) => [d.uri, d.range.start.line]), [[MAIN, 11]]);
  const input = features.definition(ws, MAIN, at(ws, MAIN, 31, "glyphs"));
  assert.equal(input[0].uri, A);
});

test("same-named declarations in sibling files stay separate", () => {
  const ws = workspace();
  const inA = features.definition(ws, A, at(ws, A, 7, "bowl"));
  assert.deepEqual(inA.map((d) => [d.uri, d.range.start.line]), [[A, 2]]);
  const refs = features.references(ws, A, at(ws, A, 2, "bowl"), true);
  assert.ok(refs.every((r) => r.uri === A));
  assert.equal(refs.length, 4);
});

test("parameters and loop variables resolve locally", () => {
  const ws = workspace();
  // `n` in `for i = 1 upto n:` is ladder's parameter.
  const n = features.definition(ws, MAIN, at(ws, MAIN, 24, "n:"));
  assert.deepEqual(n.map((d) => d.range.start.line), [21]);
  // `i` inside the loop is the loop variable, not the saved i.
  const i = features.definition(ws, MAIN, at(ws, MAIN, 25, "i *"));
  assert.deepEqual(i.map((d) => d.range.start.line), [24]);
  const stepY = features.references(ws, MAIN, at(ws, MAIN, 22, "step_y"), true);
  assert.deepEqual(stepY.map((r) => r.range.start.line), [22, 23, 25, 25]);
});

test("hover shows declarations, docs, and built-ins", () => {
  const ws = workspace();
  const stem = features.hover(ws, A, at(ws, A, 4, "stem_width"))!;
  const text = (stem.contents as { value: string }).value;
  assert.match(text, /numeric stem_width/);
  assert.match(text, /weight of vertical strokes/);
  assert.match(text, /Defined in src\/main\.mp:6/);
  const pr = (features.hover(ws, A, at(ws, A, 5, "penradius"))!.contents as { value: string }).value;
  assert.match(pr, /vardef penradius\(expr d\)/);
  assert.match(pr, /Half the breadth/);
  const draw = (features.hover(ws, A, at(ws, A, 7, "draw"))!.contents as { value: string }).value;
  assert.match(draw, /`draw` — command/);
});

test("rename updates every reference and only those", () => {
  const ws = workspace();
  const edit = features.rename(ws, A, at(ws, A, 4, "stem_width"), "stem")!;
  const counts = Object.fromEntries(Object.entries(edit.changes!).map(([u, e]) => [path.basename(u), e.length]));
  assert.deepEqual(counts, { "main.mp": 3, "a.mp": 1, "b.mp": 1 });
  assert.throws(() => features.rename(ws, A, at(ws, A, 4, "stem_width"), "stem 2"));
  assert.equal(features.prepareRename(ws, A, at(ws, A, 7, "draw")), null);
});

test("signature help counts arguments across groups", () => {
  const ws = workspace();
  const line = ws.get(A)!.text.split("\n")[8]; // stroke_with(bowl)(r) withcolor red;
  const sh = features.signatureHelp(ws, A, { line: 8, character: line.indexOf("(r") + 1 })!;
  assert.equal(sh.signatures[0].label, "stroke_with(expr p, suffix s)");
  assert.equal(sh.activeParameter, 1);
});

test("document symbols nest declarations under figures", () => {
  const ws = workspace();
  const syms = features.documentSymbols(ws, A);
  assert.equal(syms.length, 1);
  assert.equal(syms[0].name, "beginfig(97)");
  assert.equal(syms[0].detail, "LATIN SMALL LETTER A");
  assert.deepEqual(syms[0].children!.map((c) => c.name), ["bowl"]);
  const main = features.documentSymbols(ws, MAIN).map((s) => s.name);
  assert.deepEqual(main.slice(0, 6), ["stem_width", "x_height", "penradius", "stroke_with", "midway", "ladder"]);
});

test("workspace symbols find figures by their comment", () => {
  const ws = workspace();
  assert.deepEqual(features.workspaceSymbols(ws, "letter b").map((s) => s.name), ["beginfig(98) LATIN SMALL LETTER B"]);
});

test("semantic tokens cover user names only", () => {
  const ws = workspace();
  const data = features.semanticTokens(ws, B);
  const tokens: string[] = [];
  const lines = ws.get(B)!.text.split("\n");
  let line = 0;
  let ch = 0;
  for (let k = 0; k < data.length; k += 5) {
    line += data[k];
    ch = data[k] ? data[k + 1] : ch + data[k + 1];
    tokens.push(`${lines[line].substr(ch, data[k + 2])}:${features.SEMANTIC_TOKEN_TYPES[data[k + 3]]}`);
  }
  assert.deepEqual(tokens, [
    "bowl:variable",
    "bowl:variable",
    "x_height:variable",
    "midway:operator",
    "stem_width:variable",
    "ladder:function",
    "bowl:variable",
  ]);
});

test("completion offers locals, workspace names, built-ins, and input paths", () => {
  const ws = workspace();
  const items = features.completion(ws, MAIN, at(ws, MAIN, 23, "step_y"));
  const labels = new Set(items.map((i) => i.label));
  for (const name of ["step_y", "n", "stem_width", "penradius", "draw", "fullcircle"]) assert.ok(labels.has(name), name);
  const line = ws.get(MAIN)!.text.split("\n")[31];
  const paths = features.completion(ws, MAIN, { line: 31, character: line.indexOf("src") + 4 });
  assert.deepEqual(paths.map((i) => i.label).sort(), ["src/glyphs/a.mp", "src/glyphs/b.mp", "src/main.mp"]);
  assert.deepEqual(features.completion(ws, MAIN, { line: 0, character: 5 }), []); // in a comment
});

test("links and folding", () => {
  const ws = workspace();
  assert.deepEqual(features.documentLinks(ws, MAIN).map((l) => l.target), [A, B]);
  const folds = features.foldingRanges(ws, MAIN).map((f) => [f.startLine, f.endLine]);
  assert.ok(folds.some(([s, e]) => s === 21 && e === 26), JSON.stringify(folds)); // vardef ladder
});
