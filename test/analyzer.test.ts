import { test } from "node:test";
import * as assert from "node:assert/strict";
import { analyze, collectReferences, matchesDeclarator } from "../src/analyzer";

const URI = "file:///test.mp";
const defs = (text: string) => analyze(URI, text).definitions;
const brief = (text: string) => defs(text).map((d) => `${d.kind}:${d.name}${d.type ? ":" + d.type : ""}`);

test("multi-line declarations declare every name", () => {
  const text = "numeric font_size,\n  pen_thin,  % thinnest\n  x_height;\npair A[], B;";
  assert.deepEqual(brief(text), [
    "variable:font_size:numeric",
    "variable:pen_thin:numeric",
    "variable:x_height:numeric",
    "variable:A:pair",
    "variable:B:pair",
  ]);
  const thin = defs(text).find((d) => d.name === "pen_thin")!;
  assert.equal(thin.doc, "thinnest");
  assert.equal(defs(text).find((d) => d.name === "A")!.declarator, "A[]");
});

test("type keywords used as predicates are not declarations", () => {
  assert.deepEqual(brief("if numeric x: show x; fi"), []);
});

test("macro headers: delimited, undelimited, and operator parameters", () => {
  const text = [
    "def stroke(expr p)(suffix s) text t = draw p t; enddef;",
    "vardef foo@#(expr a, b) = a + b enddef;",
    "primarydef w dotprod z = 0 enddef;",
    "def twice primary x = x + x enddef;",
  ].join("\n");
  const d = defs(text);
  const stroke = d.find((x) => x.name === "stroke")!;
  assert.equal(stroke.kind, "macro");
  assert.equal(stroke.signature, "def stroke(expr p)(suffix s) text t");
  assert.deepEqual(
    stroke.params!.map((p) => `${p.type} ${p.name} ${p.delimited}`),
    ["expr p true", "suffix s true", "text t false"],
  );
  assert.deepEqual(d.find((x) => x.name === "foo")!.params!.map((p) => p.name), ["a", "b"]);
  const op = d.find((x) => x.name === "dotprod")!;
  assert.equal(op.kind, "operator");
  assert.deepEqual(op.params!.map((p) => p.name), ["w", "z"]);
  assert.deepEqual(d.find((x) => x.name === "twice")!.params!.map((p) => `${p.type} ${p.name}`), ["primary x"]);
});

test("parameters, saved names, and loop variables are scoped", () => {
  const text = [
    "vardef ladder(expr n) =", // 0
    "  save i, h;", // 1
    "  h := 3;", // 2
    "  for i = 1 upto n:", // 3
    "    draw (0, i * h);", // 4
    "  endfor", // 5
    "enddef;", // 6
    "h := 5;", // 7
  ].join("\n");
  const d = defs(text);
  const param = d.find((x) => x.kind === "parameter")!;
  assert.equal(param.scope!.start.line, 1);
  assert.equal(param.scope!.end.line, 6);
  const saved = d.filter((x) => x.kind === "save").map((x) => x.name);
  assert.deepEqual(saved, ["i", "h"]);
  assert.ok(d.filter((x) => x.kind === "save").every((x) => x.scope && x.scope.end.line === 6));
  const loop = d.find((x) => x.kind === "loopvar")!;
  assert.equal(loop.name, "i");
  assert.equal(loop.scope!.start.line, 4);
  assert.equal(loop.scope!.end.line, 5);
  // `h := 3` assigns the saved h; `h := 5` at top level is a global.
  const implicit = d.filter((x) => x.kind === "implicit");
  assert.deepEqual(implicit.map((x) => x.range.start.line), [7]);
});

test("first assignments, newinternal, let", () => {
  const d = brief("x_a_0_base := -12.0;\nwidth = 300;\nnewinternal numeric margin;\nlet drw = draw;");
  // Digits end a name: x_a_0_base is the variable x_a_ with suffix 0_base.
  assert.deepEqual(d, ["implicit:x_a_", "implicit:width", "internal:margin:numeric", "let:drw"]);
  assert.equal(defs("x_a_0_base := -12.0;")[0].declarator, "x_a_0_base");
});

test("built-in names are never implicit definitions", () => {
  assert.deepEqual(brief("prologues := 3;\nz1 = (0, 0);\noutputformat := \"svg\";"), []);
});

test("figures, inputs, and doc comments", () => {
  const text = [
    "% U+10400 DESERET CAPITAL LETTER LONG I",
    "beginfig(1024);",
    "  draw p;",
    "endfig;",
    "input src/letters/U10401.mp; % next",
    "input boxes",
  ].join("\n");
  const a = analyze(URI, text);
  assert.equal(a.figures.length, 1);
  assert.equal(a.figures[0].label, "1024");
  assert.equal(a.figures[0].doc, "U+10400 DESERET CAPITAL LETTER LONG I");
  assert.equal(a.figures[0].range.end.line, 3);
  assert.deepEqual(
    a.inputs.map((i) => [i.target, i.range.start.character, i.range.end.character]),
    [
      ["src/letters/U10401.mp", 6, 27],
      ["boxes", 6, 11],
    ],
  );
});

test("folds for blocks and comment runs", () => {
  const a = analyze(URI, "% a\n% b\nbeginfig(1);\n  draw p;\nendfig;");
  assert.deepEqual(
    a.folds.map((f) => [f.startLine, f.endLine, f.kind]),
    [
      [2, 3, "region"],
      [0, 1, "comment"],
    ],
  );
});

test("references record variable roots, not suffixes", () => {
  const text = "z1r = z.a + p[i]r + q;\nlabel.top(\"x\", w);\nstroke_it pp;";
  const a = analyze(URI, text);
  const refs = collectReferences(a, (n) => (n === "stroke_it" ? "macro" : undefined));
  // z and label are vardefs: z1r, z.a and label.top are calls, not variables.
  assert.deepEqual(
    refs.map((r) => `${r.role}:${r.name}:${r.variable}`),
    ["root:p:p[i]r", "root:i:i", "root:q:q", "root:w:w", "macro:stroke_it:stroke_it", "root:pp:pp"],
  );
});

test("references normalize subscripts", () => {
  const a = analyze(URI, "x_a_0_base := p[3] + p3 + q[i+1].tip;");
  const refs = collectReferences(a, () => undefined);
  assert.deepEqual(
    refs.map((r) => r.variable),
    ["x_a_0_base", "p3", "p3", "q[i + 1].tip", "i"],
  );
});

test("declarator patterns match subscripted variables", () => {
  assert.ok(matchesDeclarator("x_a_0_base", "x_a_[]_base"));
  assert.ok(matchesDeclarator("p[i]r", "p[]r"));
  assert.ok(matchesDeclarator("A12", "A[]"));
  assert.ok(!matchesDeclarator("x_a_0_tip", "x_a_[]_base"));
  assert.ok(matchesDeclarator("x_diam", "x_diam"));
});

test("unbalanced input does not throw", () => {
  for (const text of ["vardef f(expr a", "beginfig(1); for i = 1 upto", "numeric", 'label("unterminated', "btex never closed"]) {
    assert.doesNotThrow(() => collectReferences(analyze(URI, text), () => undefined));
  }
});

test("an unclosed figure runs to the end of the file, covering its selection", () => {
  // VS Code rejects a document symbol whose selectionRange lies outside its range.
  for (const text of ["beginfig(53);\n  draw p;", "begingroup beginfig(7); endgroup draw q;"]) {
    const [fig] = analyze(URI, text).figures;
    const { start, end } = fig.range;
    const sel = fig.selectionRange;
    const le = (a: typeof start, b: typeof start) => a.line < b.line || (a.line === b.line && a.character <= b.character);
    assert.ok(le(start, sel.start) && le(sel.end, end), `${JSON.stringify(text)}: ${JSON.stringify(fig)}`);
  }
});
