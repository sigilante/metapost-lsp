# metapost-lsp

A language server for [MetaPost](https://tug.org/metapost.html) (and METAFONT
sources written in the same style). It works with any LSP client; the VS Code
extension lives at [sigilante/metapost-plugin](https://github.com/sigilante/metapost-plugin).

## Features

**Names across the project.** Every `.mp`/`.mf` file under the workspace is
indexed, and `input` statements are followed.

- Go to definition, find references, highlight occurrences, and rename for
  variables, macros (`def`, `vardef`, `primarydef` …), parameters, loop
  variables, `save`d names, and `newinternal`s.
- Hover shows the declaration (`numeric x_height`, `vardef penradius(expr d)`)
  with the comment block above it or the comment after it, plus where it is
  defined. Built-ins show their entry from the MetaPost manual's tables.
- Completion for names in scope, project-wide names, built-ins, and file paths
  after `input`.
- Signature help for macros with delimited parameters, including
  `f(a)(b)` argument groups.
- Semantic highlighting, so variables are coloured at every use, not just where
  they are declared.
- Outline: each `beginfig(n)` labelled with the comment above it (for example
  `beginfig(1024) U+10400 DESERET CAPITAL LETTER LONG I`), with the
  declarations inside it nested underneath. Workspace symbol search finds
  figures by that comment.
- `input` targets are links; folding for groups, macros, loops, conditionals,
  figures, and comment blocks.

**Errors from mpost.** When a file is opened or saved, the server finds the top-level
file that (directly or indirectly) inputs it and runs `mpost` on that, then
shows each error in the file and on the token where mpost stopped, with
mpost's help text. mpost runs in a scratch directory, so the project's own
`.svg`/`.log` output is never touched.

## How names are resolved

MetaPost's syntax is defined by macros at run time, so this is not a full
parser. The server tokenizes exactly as MetaPost does (Table 1 of the manual:
`x_a_0_base` is the variable `x_a_` with suffix `0_base`, `z1r` is `z` applied
to the suffix `1r`) and recognises the statements that introduce names:
type declarations, `save`, `newinternal`, `let`, macro headers, `for` loops,
and first assignments to undeclared names.

A name resolves to the innermost local (parameter, loop variable, saved name)
whose scope contains it; otherwise to declarations in the same file (closest
preceding first); otherwise to declarations in files linked to it by `input`;
otherwise to any declaration in the workspace. Declarations like
`numeric x_a_[]_base` match subscripted uses such as `x_a_3_base`.

## Settings

Read from the client's `metapost` configuration section:

| Setting | Default | |
|---|---|---|
| `metapost.diagnostics.enable` | `true` | Run mpost on open and save |
| `metapost.mpost.path` | `"mpost"` | mpost executable |
| `metapost.mpost.args` | `[]` | Extra command-line arguments |
| `metapost.mpost.timeout` | `30000` | Kill mpost after this many ms |
| `metapost.mainFile` | `""` | Always compile this file (workspace-relative or absolute) instead of detecting the main file |
| `metapost.projectRoot` | `""` | Directory that relative `input` paths resolve from. By default, the directory where the main file's `input` paths resolve |

## Running

```sh
npm install
npm run build
node out/src/server.js --stdio
```

For Neovim (0.11+):

```lua
vim.lsp.config.metapost = {
  cmd = { "node", "/path/to/metapost-lsp/out/src/server.js", "--stdio" },
  filetypes = { "mp" },
  root_markers = { ".git" },
}
vim.lsp.enable("metapost")
```

## Development

```sh
npm test                  # unit tests plus mpost and stdio integration tests
python3 scripts/extract-builtins.py mpman.txt   # regenerate src/builtins.json
```

`src/builtins.json` is generated from `pdftotext -layout mpman.pdf` (Tables 6–12)
plus the primitives listed in the script.
