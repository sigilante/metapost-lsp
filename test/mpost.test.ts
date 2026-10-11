import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseLog, runMpost } from "../src/mpost";

const LOG = `This is MetaPost, version 2.11 (TeX Live 2025) (kpathsea version 6.4.1)  11 OCT 2026 14:26
(/usr/local/texlive/2025/texmf-dist/metapost/base/mpost.mp (/usr/local/texlive/2025/texmf-dist/metapost/base/plain.mp
Preloading the plain mem file, version 1.005) ) (/work/my font/src/main.mp (/work/my font/src/letters/U10400.mp
! Extra tokens will be flushed.
<to be read again>
                   )
l.4   x_diam := 2 * x_radius)
                              + undefined_thing;
I've just read as much of that statement as I could fathom,
so a semicolon should have been next.

[1024]) (/work/my font/src/letters/U10401.mp
>> 100
! A statement can't begin with \`withpen'.
<to be read again>
                   withpen
l.7   pickup thin_pen withpen
                             ;
I was looking for the beginning of a new statement.

[1025])
! Isolated expression.
<to be read again>
                   ;
l.12 foo(1, 2) ... (3)
                      ;
Back in main.

)
`;

// Columns are where mpost stopped reading: just after the offending token.
test("parseLog attributes errors to the file being read", () => {
  const { errors, files } = parseLog(LOG, "/work/my font");
  assert.deepEqual(
    errors.map((e) => [path.basename(e.file), e.line, e.column, e.message]),
    [
      ["U10400.mp", 3, 25, "Extra tokens will be flushed."],
      ["U10401.mp", 6, 25, "A statement can't begin with `withpen'."],
      ["main.mp", 11, 17, "Isolated expression."],
    ],
  );
  assert.equal(errors[0].file, "/work/my font/src/letters/U10400.mp");
  assert.match(errors[0].help!, /^I've just read as much/);
  assert.ok(files.includes("/work/my font/src/main.mp"));
  assert.equal(files.filter((f) => f.startsWith("/work")).length, 3);
});

test("parseLog falls back to the main file for errors outside any file", () => {
  const log = "This is MetaPost\n! I can't find file `nope.mp'.\n<*> nope.mp\n\n";
  const { errors } = parseLog(log, "/w", "/w/main.mp");
  assert.deepEqual(errors.map((e) => [e.file, e.line, e.message]), [["/w/main.mp", 0, "I can't find file `nope.mp'."]]);
});

function haveMpost(): boolean {
  try {
    execFileSync("mpost", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("runMpost reports errors without touching the project", { skip: !haveMpost() && "mpost not installed" }, async () => {
  // Copy the broken fixture into a directory whose path has a space.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp lsp "));
  const src = path.resolve(__dirname, "../../test/fixtures/broken");
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  try {
    const result = await runMpost({ mpost: "mpost", baseDir: dir, mainFile: path.join(dir, "main.mp"), timeoutMs: 20000 });
    assert.deepEqual(
      result.errors.map((e) => [path.basename(e.file), e.line, e.column, e.message]),
      [
        ["glyph.mp", 2, 13, "Extra tokens will be flushed."],
        ["glyph.mp", 3, 26, "A statement can't begin with `withpen'."],
        ["glyph.mp", 3, 26, "Extra tokens will be flushed."],
      ],
    );
    assert.deepEqual(fs.readdirSync(dir).sort(), ["glyph.mp", "main.mp"]); // no output written here
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runMpost on a clean project reports nothing", { skip: !haveMpost() && "mpost not installed" }, async () => {
  const root = path.resolve(__dirname, "../../test/fixtures/project");
  const before = fs.readdirSync(root);
  const result = await runMpost({ mpost: "mpost", baseDir: root, mainFile: path.join(root, "src/main.mp"), timeoutMs: 20000 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(fs.readdirSync(root), before);
});

test("a missing executable rejects with ENOENT", async () => {
  await assert.rejects(
    runMpost({ mpost: "definitely-not-mpost", baseDir: os.tmpdir(), mainFile: path.join(os.tmpdir(), "x.mp"), timeoutMs: 1000 }),
    (e: NodeJS.ErrnoException) => e.code === "ENOENT",
  );
});
