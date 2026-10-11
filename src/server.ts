#!/usr/bin/env node
// MetaPost language server. Run with --stdio (or let vscode-languageclient
// pick a transport).

import * as fs from "fs";
import * as path from "path";
import {
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  FileChangeType,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as features from "./features";
import { isMissingExecutable, MpostError, runMpost, shouldWarnMissing } from "./mpost";
import { pathToUri, uriToPath, Workspace } from "./workspace";

interface Settings {
  diagnostics: { enable: boolean };
  mpost: { path: string; args: string[]; timeout: number };
  /** Main file to compile, absolute or relative to the workspace root. */
  mainFile: string;
  /** Directory that relative `input` paths resolve from. */
  projectRoot: string;
}

const defaults: Settings = {
  diagnostics: { enable: true },
  mpost: { path: "mpost", args: [], timeout: 30000 },
  mainFile: "",
  projectRoot: "",
};

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const ws = new Workspace();
let settings: Settings = defaults;
let canPullConfig = false;
// Resolves once settings are loaded; checks wait for it so they use the
// configured mpost path and main file.
let markReady: () => void;
const ready = new Promise<void>((resolve) => (markReady = resolve));

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const roots = (params.workspaceFolders ?? []).map((f) => uriToPath(f.uri));
  if (!roots.length && params.rootUri) roots.push(uriToPath(params.rootUri));
  ws.setRoots(roots);
  // Index before answering so no request sees a half-built workspace.
  ws.scan();
  canPullConfig = !!params.capabilities.workspace?.configuration;
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: false } },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      renameProvider: { prepareProvider: true },
      completionProvider: { triggerCharacters: ["/"] },
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      foldingRangeProvider: true,
      documentLinkProvider: { resolveProvider: false },
      semanticTokensProvider: {
        legend: { tokenTypes: features.SEMANTIC_TOKEN_TYPES, tokenModifiers: features.SEMANTIC_TOKEN_MODIFIERS },
        full: true,
      },
      executeCommandProvider: { commands: ["metapost.server.check"] },
    },
    serverInfo: { name: "metapost-lsp", version: "0.1.0" },
  };
});

connection.onInitialized(async () => {
  if (canPullConfig) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined).catch(() => {});
  }
  await loadSettings();
  markReady();
});

async function loadSettings() {
  if (!canPullConfig) return;
  try {
    const s = await connection.workspace.getConfiguration("metapost");
    settings = {
      diagnostics: { ...defaults.diagnostics, ...(s?.diagnostics ?? {}) },
      mpost: { ...defaults.mpost, ...(s?.mpost ?? {}) },
      mainFile: s?.mainFile ?? "",
      projectRoot: s?.projectRoot ?? "",
    };
  } catch {
    settings = defaults;
  }
}

connection.onDidChangeConfiguration(async () => {
  await loadSettings();
  if (!settings.diagnostics.enable) clearAllDiagnostics();
});

// ------------------------------------------------------------- documents

documents.onDidChangeContent((e) => ws.update(e.document.uri, e.document.getText()));
documents.onDidOpen((e) => {
  ws.update(e.document.uri, e.document.getText());
  if (!hasResultsFor(e.document.uri)) check(e.document.uri);
});
documents.onDidClose((e) => ws.close(e.document.uri));
documents.onDidSave((e) => check(e.document.uri));

connection.onDidChangeWatchedFiles((params) => {
  for (const c of params.changes) ws.fileChanged(c.uri, c.type === FileChangeType.Deleted);
  connection.languages.semanticTokens.refresh();
});

// -------------------------------------------------------------- features

connection.onHover((p) => features.hover(ws, p.textDocument.uri, p.position));
connection.onDefinition((p) => features.definition(ws, p.textDocument.uri, p.position));
connection.onReferences((p) => features.references(ws, p.textDocument.uri, p.position, p.context.includeDeclaration));
connection.onDocumentHighlight((p) => features.documentHighlight(ws, p.textDocument.uri, p.position));
connection.onPrepareRename((p) => features.prepareRename(ws, p.textDocument.uri, p.position));
connection.onRenameRequest((p) => features.rename(ws, p.textDocument.uri, p.position, p.newName));
connection.onCompletion((p) => features.completion(ws, p.textDocument.uri, p.position));
connection.onSignatureHelp((p) => features.signatureHelp(ws, p.textDocument.uri, p.position));
connection.onDocumentSymbol((p) => features.documentSymbols(ws, p.textDocument.uri));
connection.onWorkspaceSymbol((p) => features.workspaceSymbols(ws, p.query));
connection.onFoldingRanges((p) => features.foldingRanges(ws, p.textDocument.uri));
connection.onDocumentLinks((p) => features.documentLinks(ws, p.textDocument.uri));
connection.languages.semanticTokens.on((p) => ({ data: features.semanticTokens(ws, p.textDocument.uri) }));
connection.onExecuteCommand(async (p) => {
  if (p.command === "metapost.server.check" && typeof p.arguments?.[0] === "string") await check(p.arguments[0], true);
});

// ----------------------------------------------------------- diagnostics

/** Diagnostics from each main file's last run, by file. */
const results = new Map<string, Map<string, Diagnostic[]>>();
const running = new Map<string, AbortController>();

function hasResultsFor(uri: string): boolean {
  for (const byFile of results.values()) if (byFile.has(uri)) return true;
  return running.size > 0 && [...running.keys()].some((m) => m === uri);
}

function publish(uri: string) {
  const all: Diagnostic[] = [];
  for (const byFile of results.values()) all.push(...(byFile.get(uri) ?? []));
  connection.sendDiagnostics({ uri, diagnostics: all });
}

function clearAllDiagnostics() {
  const uris = new Set<string>();
  for (const byFile of results.values()) for (const u of byFile.keys()) uris.add(u);
  results.clear();
  for (const u of uris) connection.sendDiagnostics({ uri: u, diagnostics: [] });
}

function mainFiles(uri: string): string[] {
  if (settings.mainFile) {
    const p = path.isAbsolute(settings.mainFile) ? settings.mainFile : path.join(ws.roots[0] ?? "", settings.mainFile);
    return [pathToUri(p)];
  }
  return ws.mainFilesFor(uri).slice(0, 3);
}

async function check(uri: string, force = false) {
  await ready;
  if (!settings.diagnostics.enable && !force) return;
  if (!uri.startsWith("file:")) return;
  await Promise.all(mainFiles(uri).map((m) => compile(m)));
}

async function compile(mainUri: string) {
  running.get(mainUri)?.abort();
  const controller = new AbortController();
  running.set(mainUri, controller);
  const mainFile = uriToPath(mainUri);
  const baseDir = settings.projectRoot
    ? path.isAbsolute(settings.projectRoot)
      ? settings.projectRoot
      : path.join(ws.roots[0] ?? "", settings.projectRoot)
    : ws.inputBase(mainUri);
  try {
    const result = await runMpost({
      mpost: settings.mpost.path,
      baseDir,
      mainFile,
      timeoutMs: settings.mpost.timeout,
      extraArgs: settings.mpost.args,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    const byFile = new Map<string, Diagnostic[]>();
    for (const f of result.files) byFile.set(pathToUri(f), []);
    byFile.set(mainUri, byFile.get(mainUri) ?? []);
    for (const err of result.errors) {
      const u = pathToUri(err.file);
      if (!byFile.has(u)) byFile.set(u, []);
      byFile.get(u)!.push(toDiagnostic(u, err));
    }
    if (result.timedOut) {
      byFile.get(mainUri)!.push({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        severity: DiagnosticSeverity.Warning,
        source: "mpost",
        message: `mpost did not finish within ${settings.mpost.timeout} ms (an infinite loop?).`,
      });
    }
    const previous = results.get(mainUri);
    results.set(mainUri, byFile);
    const touched = new Set([...byFile.keys(), ...(previous?.keys() ?? [])]);
    for (const u of touched) publish(u);
  } catch (e) {
    if (isMissingExecutable(e)) {
      if (shouldWarnMissing()) {
        connection.window.showWarningMessage(
          `MetaPost: could not run "${settings.mpost.path}". Install TeX Live or set metapost.mpost.path to get error checking.`,
        );
      }
    } else {
      connection.console.error(`mpost failed: ${String(e)}`);
    }
  } finally {
    if (running.get(mainUri) === controller) running.delete(mainUri);
  }
}

function lineText(uri: string, line: number): string {
  const open = documents.get(uri);
  if (open) return open.getText({ start: { line, character: 0 }, end: { line: line + 1, character: 0 } }).replace(/\r?\n$/, "");
  const a = ws.get(uri);
  const text = a?.text ?? safeRead(uriToPath(uri));
  return text.split(/\r?\n/)[line] ?? "";
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function toDiagnostic(uri: string, err: MpostError): Diagnostic {
  const text = lineText(uri, err.line);
  let start = text.length - text.trimStart().length;
  let end = text.length;
  if (err.column !== undefined) {
    // Highlight the token that ends where mpost stopped reading.
    const a = ws.get(uri);
    const onLine = (a?.tokens ?? []).filter((t) => t.line === err.line && t.kind !== "comment" && t.end <= err.column!);
    const last = onLine[onLine.length - 1];
    if (last) {
      start = last.start;
      end = last.end;
    } else {
      start = Math.max(0, err.column - 1);
      end = err.column;
    }
  }
  return {
    range: { start: { line: err.line, character: start }, end: { line: err.line, character: end } },
    severity: DiagnosticSeverity.Error,
    source: "mpost",
    message: err.help ? `${err.message}\n\n${err.help}` : err.message,
  };
}

documents.listen(connection);
connection.listen();
