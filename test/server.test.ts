// End-to-end: start the server over stdio and talk LSP to it.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const SERVER = path.resolve(__dirname, "../src/server.js");

function haveMpost(): boolean {
  try {
    execFileSync("mpost", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function withServer(root: string, fn: (conn: ReturnType<typeof createMessageConnection>, diags: Map<string, unknown[]>) => Promise<void>) {
  const child = spawn(process.execPath, [SERVER, "--stdio"]);
  const conn = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  const diags = new Map<string, unknown[]>();
  conn.onNotification("textDocument/publishDiagnostics", (...args: unknown[]) => {
    const p = args[0] as { uri: string; diagnostics: unknown[] };
    diags.set(p.uri, p.diagnostics);
  });
  conn.onRequest("workspace/configuration", () => [{}]);
  conn.onRequest("client/registerCapability", () => null);
  conn.onRequest("workspace/semanticTokens/refresh", () => null);
  conn.listen();
  const rootUri = pathToFileURL(root).href;
  try {
    await conn.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "test" }],
      capabilities: { workspace: { configuration: true } },
    });
    conn.sendNotification("initialized", {});
    await fn(conn, diags);
    await conn.sendRequest("shutdown");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await conn.sendNotification("exit");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  } finally {
    conn.dispose();
    child.kill();
  }
}

function open(conn: ReturnType<typeof createMessageConnection>, file: string) {
  const uri = pathToFileURL(file).href;
  conn.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "metapost", version: 1, text: fs.readFileSync(file, "utf8") },
  });
  return uri;
}

async function waitFor<T>(get: () => T | undefined, ms = 20000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("server answers hover and definition requests", async () => {
  const root = path.resolve(__dirname, "../../test/fixtures/project");
  await withServer(root, async (conn) => {
    const uri = open(conn, path.join(root, "src/glyphs/a.mp"));
    const hover = await conn.sendRequest<{ contents: { value: string } }>("textDocument/hover", {
      textDocument: { uri },
      position: { line: 3, character: 30 }, // x_height
    });
    assert.match(hover.contents.value, /numeric x_height/);
    const defs = await conn.sendRequest<{ uri: string }[]>("textDocument/definition", {
      textDocument: { uri },
      position: { line: 5, character: 16 }, // penradius
    });
    assert.equal(path.basename(new URL(defs[0].uri).pathname), "main.mp");
  });
});

test("opening an input file checks the project's main file", { skip: !haveMpost() && "mpost not installed" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp lsp "));
  const src = path.resolve(__dirname, "../../test/fixtures/broken");
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  try {
    await withServer(dir, async (conn, diags) => {
      const uri = open(conn, path.join(dir, "glyph.mp"));
      const list = (await waitFor(() => diags.get(uri))) as { range: { start: { line: number; character: number } }; message: string }[];
      assert.deepEqual(
        list.map((d) => [d.range.start.line, d.range.start.character, d.message.split("\n")[0]]),
        [
          [2, 12, "Extra tokens will be flushed."],
          [3, 19, "A statement can't begin with `withpen'."],
          [3, 19, "Extra tokens will be flushed."],
        ],
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
