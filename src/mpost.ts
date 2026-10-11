// Run mpost and turn its log into diagnostics.
//
// mpost runs in a scratch directory so figures, logs and .mpx files never
// land in the project. The project directory goes on MPINPUTS so relative
// `input` statements resolve as they would in a normal build, and the main
// file is passed relative to it (mpost cannot open paths containing
// spaces). max_print_line and error_line are raised so log lines are not
// wrapped and error context shows whole source lines.
//
// mpost ignores -file-line-error, so errors are TeX style:
//
//   ! Extra tokens will be flushed.
//   <to be read again>
//                      )
//   l.4   x_diam := 2 * x_radius)
//                                + undefined_thing;
//   I've just read as much of that statement as I could fathom, …
//
// The file an error belongs to is tracked from the `(path` … `)` nesting
// that mpost prints as it opens and closes input files.

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface MpostError {
  file: string; // absolute path
  line: number; // 0-based
  column?: number; // 0-based column just after the offending token
  message: string;
  help?: string;
}

export interface MpostResult {
  errors: MpostError[];
  /** Files mpost read, so their old diagnostics can be cleared. */
  files: string[];
  exitCode: number | null;
  timedOut: boolean;
  log: string;
}

export interface MpostOptions {
  mpost: string;
  /** Directory relative inputs resolve from (what mpost would run in). */
  baseDir: string;
  mainFile: string;
  timeoutMs: number;
  extraArgs?: string[];
  signal?: AbortSignal;
}

const FILE_OPEN = /\(([^()]*?\.(?:mp|mf|mpx|mpii|mpiv|mpvi|mpxl|tex))(?=[\s)[]|$)/g;

/** `mainFile` receives errors that happen outside any input file. */
export function parseLog(log: string, baseDir: string, mainFile?: string): { errors: MpostError[]; files: string[] } {
  const lines = log.split(/\r?\n/);
  const errors: MpostError[] = [];
  const files = new Set<string>();
  const stack: string[] = [];
  const absolute = (p: string) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p));

  let i = 0;
  // Skip the banner line.
  if (lines[0]?.startsWith("This is MetaPost")) i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("! ")) {
      const block: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() !== "") block.push(lines[++i]);
      const current = stack.filter(Boolean).pop() ?? mainFile;
      const err = parseErrorBlock(block, current);
      if (err) errors.push(err);
      continue;
    }
    if (line.startsWith(">> ") || line.startsWith(">  ")) continue; // show output
    // Track file nesting. Open parens are matched against file paths;
    // bare `)` closes the innermost file.
    let k = 0;
    while (k < line.length) {
      const c = line[k];
      if (c === "(") {
        FILE_OPEN.lastIndex = k;
        const m = FILE_OPEN.exec(line);
        if (m && m.index === k) {
          const file = absolute(m[1]);
          stack.push(file);
          files.add(file);
          k += m[0].length;
          continue;
        }
        stack.push(""); // a parenthesis that is not a file
      } else if (c === ")") {
        stack.pop();
      }
      k++;
    }
  }
  return { errors, files: [...files] };
}

function parseErrorBlock(block: string[], file: string | undefined): MpostError | undefined {
  const message = block[0].slice(2).trim();
  // The last `l.N` line locates the error in the current file; earlier
  // context lines are macro expansions.
  let lineIdx = -1;
  for (let k = block.length - 1; k > 0; k--) {
    if (/^l\.\d+/.test(block[k])) {
      lineIdx = k;
      break;
    }
  }
  if (!file) return undefined;
  if (lineIdx < 0) return { file, line: 0, message, help: helpText(block, 1) };
  const m = /^l\.(\d+) ?(.*)$/.exec(block[lineIdx])!;
  const before = m[2];
  const column = before.startsWith("...") ? undefined : before.length;
  return {
    file,
    line: Number(m[1]) - 1,
    column,
    message,
    help: helpText(block, lineIdx + 2),
  };
}

function helpText(block: string[], from: number): string | undefined {
  const help = block.slice(from).join(" ").replace(/\s+/g, " ").trim();
  return help || undefined;
}

let warnedMissing = false;

export async function runMpost(opts: MpostOptions): Promise<MpostResult> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "metapost-lsp-"));
  const rel = path.relative(opts.baseDir, opts.mainFile);
  // Prefer a path relative to the base (found through MPINPUTS); fall back
  // to the absolute path when the file lives outside it.
  const target = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : opts.mainFile;
  const sep = process.platform === "win32" ? ";" : ":";
  const env = {
    ...process.env,
    MPINPUTS: [opts.baseDir, path.dirname(opts.mainFile)].join(sep) + sep + (process.env.MPINPUTS ?? ""),
    max_print_line: "10000",
    error_line: "250",
    half_error_line: "200",
  };
  const args = ["-interaction=nonstopmode", ...(opts.extraArgs ?? []), target];

  try {
    const { code, timedOut } = await new Promise<{ code: number | null; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(opts.mpost, args, { cwd: work, env, stdio: ["ignore", "ignore", "ignore"] });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
      const abort = () => child.kill("SIGKILL");
      opts.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        resolve({ code, timedOut });
      });
    });
    const jobname = path.basename(target).replace(/\.[^.]+$/, "");
    let log = "";
    try {
      log = fs.readFileSync(path.join(work, jobname + ".log"), "utf8");
    } catch {
      // No log: mpost was killed or failed to start.
    }
    const parsed = parseLog(log, opts.baseDir, opts.mainFile);
    return { ...parsed, exitCode: code, timedOut, log };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function isMissingExecutable(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** True the first time only, so a missing mpost is reported once. */
export function shouldWarnMissing(): boolean {
  if (warnedMissing) return false;
  warnedMissing = true;
  return true;
}
