import { test } from "node:test";
import * as assert from "node:assert/strict";
import { tokenize } from "../src/lexer";

const texts = (s: string) => tokenize(s).map((t) => t.text);

test("symbolic tokens follow Table 1 character classes", () => {
  assert.deepEqual(texts("A_alpha +-+ != x34"), ["A_alpha", "+-+", "!", "=", "x", "34"]);
  assert.deepEqual(texts("a:=b<=c"), ["a", ":=", "b", "<=", "c"]);
});

test("brackets only combine with themselves", () => {
  assert.deepEqual(texts("[[ ]] [x]"), ["[[", "]]", "[", "x", "]"]);
});

test("loners are always separate tokens", () => {
  assert.deepEqual(texts("(())"), ["(", "(", ")", ")"]);
  assert.deepEqual(texts(";;,,"), [";", ";", ",", ","]);
});

test("numbers, periods, and suffix separators", () => {
  assert.deepEqual(texts(".5 1.25 12"), [".5", "1.25", "12"]);
  assert.deepEqual(texts("z1 .. z2 ... z3"), ["z", "1", "..", "z", "2", "...", "z", "3"]);
  const toks = tokenize("z.a");
  assert.deepEqual(toks.map((t) => t.text), ["z", "a"]);
  assert.equal(toks[1].afterDot, true);
  assert.equal(toks[0].afterDot, undefined);
});

test("strings and comments", () => {
  const toks = tokenize('label("50% off", z1); % note');
  assert.deepEqual(
    toks.map((t) => [t.kind, t.text]),
    [
      ["tag", "label"],
      ["loner", "("],
      ["string", '"50% off"'],
      ["loner", ","],
      ["tag", "z"],
      ["number", "1"],
      ["loner", ")"],
      ["loner", ";"],
      ["comment", "% note"],
    ],
  );
});

test("btex … etex is one opaque token, even across lines", () => {
  const toks = tokenize("label(btex $x_1 % not a comment$\n \\it y etex, z1);");
  const tex = toks.find((t) => t.kind === "tex")!;
  assert.ok(tex.text.includes("% not a comment"));
  assert.equal(tex.line, 0);
  assert.deepEqual(
    toks.filter((t) => t.kind !== "tex").map((t) => t.text),
    ["label", "(", ",", "z", "1", ")", ";"],
  );
});

test("positions are UTF-16 columns", () => {
  const toks = tokenize("input a.mp; % 𐐀 Deseret\ndraw p;");
  const draw = toks.find((t) => t.text === "draw")!;
  assert.deepEqual([draw.line, draw.start, draw.end], [1, 0, 4]);
});
