// Tokenizer following the MetaPost manual, section 7.1 and Table 1.
//
// A symbolic token is a run of characters from the same row of Table 1.
// `,;()` are loners, `%` starts a comment, a lone `.` is ignored, and a
// period touching digits is part of a number. `btex`/`verbatimtex` … `etex`
// is kept as a single opaque token so TeX never reaches the analyzer.

export type TokenKind = "tag" | "symbol" | "number" | "string" | "comment" | "tex" | "loner";

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  start: number; // UTF-16 column, as LSP expects
  end: number;
  /** Whitespace or a line break separates this token from the previous one. */
  spaceBefore: boolean;
  /** A lone period (suffix separator, as in `z.a`) came just before. */
  afterDot?: boolean;
}

const CLASSES = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz",
  ":<=>|",
  "#&@$",
  "/*\\",
  "+-",
  "!?",
  "'`",
  "^~",
  "{}",
  "[",
  "]",
];

const classOf = new Map<string, number>();
CLASSES.forEach((chars, i) => {
  for (const c of chars) classOf.set(c, i);
});

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split(/\r?\n/);
  let space = true;
  let dot = false;
  let tex: { line: number; start: number; parts: string[] } | null = null;

  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln];
    let i = 0;
    space = true;
    dot = false;
    while (i < s.length) {
      const c = s[i];

      if (tex) {
        // Inside btex … etex: look for a standalone `etex`.
        const m = /(?<![A-Za-z_])etex(?![A-Za-z_])/.exec(s.slice(i));
        if (!m) {
          tex.parts.push(s.slice(i));
          i = s.length;
          break;
        }
        tex.parts.push(s.slice(i, i + m.index));
        const endCol = i + m.index + 4;
        const token: TexToken = {
          kind: "tex",
          text: tex.parts.join("\n"),
          line: tex.line,
          start: tex.start,
          end: endCol, // column on endLine
          endLine: ln,
          spaceBefore: true,
        };
        tokens.push(token);
        tex = null;
        i = endCol;
        space = false;
        continue;
      }

      if (c === " " || c === "\t" || c === "\f" || c === "\r") {
        i++;
        space = true;
        continue;
      }
      const start = i;
      const push = (kind: TokenKind, end: number) => {
        const token: Token = { kind, text: s.slice(start, end), line: ln, start, end, spaceBefore: space };
        if (dot) token.afterDot = true;
        tokens.push(token);
        space = false;
        dot = false;
        i = end;
      };

      if (c === "%") {
        push("comment", s.length);
        continue;
      }
      if (c === '"') {
        const close = s.indexOf('"', i + 1);
        push("string", close === -1 ? s.length : close + 1);
        continue;
      }
      if (isDigit(c) || (c === "." && isDigit(s[i + 1]))) {
        let j = i;
        while (isDigit(s[j])) j++;
        if (s[j] === "." && isDigit(s[j + 1])) {
          j++;
          while (isDigit(s[j])) j++;
        }
        push("number", j);
        continue;
      }
      if (c === ".") {
        let j = i;
        while (s[j] === ".") j++;
        if (j - i === 1) {
          // A lone period separates tokens and is otherwise ignored.
          i = j;
          dot = true;
          continue;
        }
        push("symbol", j);
        continue;
      }
      if (c === "," || c === ";" || c === "(" || c === ")") {
        push("loner", i + 1);
        continue;
      }
      const cls = classOf.get(c);
      if (cls === undefined) {
        // Characters outside Table 1 (non-ASCII etc.): one token each.
        push("symbol", i + (c.codePointAt(0)! > 0xffff ? 2 : 1));
        continue;
      }
      let j = i + 1;
      while (j < s.length && classOf.get(s[j]) === cls) j++;
      const word = s.slice(i, j);
      if (cls === 0 && (word === "btex" || word === "verbatimtex")) {
        tex = { line: ln, start: i, parts: [] };
        i = j;
        continue;
      }
      push(cls === 0 ? "tag" : "symbol", j);
    }
  }
  if (tex) {
    // Unterminated btex: swallow to end of file.
    const token: TexToken = {
      kind: "tex",
      text: tex.parts.join("\n"),
      line: tex.line,
      start: tex.start,
      end: lines[lines.length - 1].length,
      endLine: lines.length - 1,
      spaceBefore: true,
    };
    tokens.push(token);
  }
  return tokens;
}

export interface TexToken extends Token {
  endLine: number;
}

export function tokenEndLine(t: Token): number {
  return t.kind === "tex" ? (t as TexToken).endLine : t.line;
}
