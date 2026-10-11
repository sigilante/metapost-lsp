#!/usr/bin/env python3
"""Build src/builtins.json from the reference tables in the MetaPost manual.

    pdftotext -layout mpman.pdf mpman.txt
    python3 scripts/extract-builtins.py mpman.txt

Tables 6-12 (internal variables, predefined variables and constants,
operators, commands, function-like macros) are parsed from the layout text.
Primitives that the tables leave out (control flow, definitions, types) are
listed in EXTRA below. The output is committed, so this only needs to run
when the manual changes.
"""
import json
import re
import sys
from pathlib import Path

TABLES = {
    "6": ("internal", "Internal variables with numeric values"),
    "7": ("internal", "Internal string variables"),
    "8": ("variable", "Other Predefined Variables"),
    "9": ("constant", "Predefined Constants"),
    "10": ("operator", "Operators"),
    "11": ("command", "Commands"),
    "12": ("macro", "Function-Like Macros"),
}

PAGE_NUMBER = re.compile(r"^\s+\d+\s*$")
NAME_WIDTH = 13

EXTRA = {
    "keyword": {
        "if": "Conditional: if ⟨boolean⟩: … elseif ⟨boolean⟩: … else: … fi",
        "elseif": "Further condition in an if … fi block",
        "else": "Fallback branch in an if … fi block",
        "fi": "Ends an if block",
        "for": "Loop: for ⟨var⟩ = ⟨list⟩ or ⟨start⟩ step ⟨inc⟩ until ⟨end⟩: … endfor",
        "forsuffixes": "Loop over a list of suffixes: forsuffixes s = a, b: … endfor",
        "forever": "Unbounded loop, left with exitif or exitunless",
        "endfor": "Ends a for, forsuffixes or forever loop",
        "exitif": "Leave the innermost loop if the boolean is true",
        "exitunless": "Leave the innermost loop if the boolean is false",
        "step": "Loop increment: for i = 0 step 2 until 10:",
        "until": "Loop bound: for i = 0 step 2 until 10:",
        "upto": "Same as step 1 until",
        "downto": "Same as step -1 until",
        "begingroup": "Start a group; save and interim changes are undone at endgroup",
        "endgroup": "End a group; restores saved variables and internals",
        "input": "Read a file: input ⟨filename⟩",
        "endinput": "Stop reading the current file at the end of this line",
        "end": "Finish the job",
        "dump": "Finish the job and dump a mem file (inimpost only)",
        "scantokens": "Read a string as if it were a line of input",
        "expandafter": "Expand the token after the next one first",
        "within": "for p within ⟨picture⟩: iterate over the components of a picture",
        "of": "Separates arguments of 'of' operators: point t of p",
        "btex": "Typeset the following TeX up to etex and return it as a picture",
        "verbatimtex": "Pass the following TeX up to etex to the TeX preamble",
        "etex": "Ends a btex or verbatimtex block",
        "def": "Define a macro: def name(expr a)(suffix b)(text c) = … enddef",
        "vardef": "Define a variable-like macro; its body is an implicit group",
        "enddef": "Ends a macro definition",
        "primarydef": "Define a binary operator at primary level: primarydef a op b = … enddef",
        "secondarydef": "Define a binary operator at secondary level",
        "tertiarydef": "Define a binary operator at tertiary level",
        "expr": "Macro parameter that receives a value",
        "suffix": "Macro parameter that receives a suffix",
        "text": "Macro parameter that receives a token list",
        "primary": "Undelimited macro parameter parsed as a primary",
        "secondary": "Undelimited macro parameter parsed as a secondary",
        "tertiary": "Undelimited macro parameter parsed as a tertiary",
        "delimiters": "Declare a pair of matching delimiters",
        "outer": "Forbid a token in macro bodies and conditionals",
        "inner": "Undo outer",
        "everyjob": "Token inserted at the start of every job",
        "randomseed": "Seed the random number generator: randomseed := ⟨numeric⟩",
        "readfrom": "Read a line from a file: readfrom ⟨filename⟩",
        "showstats": "Show memory usage statistics",
        "contour": "addto ⟨picture⟩ contour ⟨path⟩: low-level fill",
        "doublepath": "addto ⟨picture⟩ doublepath ⟨path⟩: low-level stroke",
        "also": "addto ⟨picture⟩ also ⟨picture⟩: low-level picture merge",
        "beginfig": "Start figure n: beginfig(n); … endfig;",
        "endfig": "Finish and ship out the current figure",
        "cycle": "Close a path: z0 .. z1 .. cycle. Also tests whether a path is cyclic",
        "curl": "Direction specifier for path endpoints: {curl 1}",
        "tension": "Path join tension: z0 .. tension 2 .. z1",
        "controls": "Explicit Bézier control points: z0 .. controls a and b .. z1",
        "atleast": "Minimum tension: .. tension atleast 1 ..",
        "and": "Separates pairs of tension or control values; also logical and",
        "whatever": "A new anonymous unknown, for equations: z = whatever[a, b]",
        "known": "Is the expression known?",
        "unknown": "Is the expression unknown?",
    },
    "type": {
        "numeric": "Declare numeric variables, or test whether an expression is numeric",
        "pair": "Declare pair variables, or test whether an expression is a pair",
        "path": "Declare path variables, or test whether an expression is a path",
        "pen": "Declare pen variables, or test whether an expression is a pen",
        "picture": "Declare picture variables, or test whether an expression is a picture",
        "string": "Declare string variables, or test whether an expression is a string",
        "transform": "Declare transform variables, or test whether an expression is a transform",
        "color": "Declare color variables, or test whether an expression is a color",
        "rgbcolor": "Same as color",
        "cmykcolor": "Declare cmykcolor variables, or test whether an expression is a cmykcolor",
        "boolean": "Declare boolean variables, or test whether an expression is a boolean",
    },
}


def parse_table(lines, start, kind):
    """Parse one table. Columns are located from the header line: the page
    number sits under "Page" and the explanation follows it."""
    entries = []
    current = None
    page_col = expl_col = None
    for line in lines[start + 1:]:
        if re.search(r"Table \d+:", line) or line.startswith("⟨"):
            break
        if not line.strip() or PAGE_NUMBER.match(line):
            continue
        if page_col is None:
            if "Explanation" in line:
                page_col = line.index("Page")
            continue
        if line.lstrip().startswith(("Left", "Name")):
            continue
        indent = len(line) - len(line.lstrip())
        page = None
        if indent <= 6:
            for m in re.finditer(r"(?<=\s)(\d+|–)(?=\s+\S)", line):
                if page_col - 3 <= m.start() <= page_col + 6:
                    page = m
        if page:
            head = line[:page.start()]
            expl = line[page.end():].strip()
            expl_col = line.index(expl, page.end())
            name_m = re.match(r"\s*(†?)(\S(?:\S| (?! ))*)", head)
            current = {
                "names": name_m.group(2).split(),
                "kind": kind,
                "plain": bool(name_m.group(1)),
                "types": " ".join(head[name_m.end():].split()),
                "doc": expl,
            }
            entries.append(current)
            continue
        if current is None:
            continue
        name_part = line[:NAME_WIDTH].strip()
        if name_part and current["names"][-1].endswith("-"):
            words = name_part.split()
            current["names"][-1] = current["names"][-1][:-1] + words[0]
        tail = line[expl_col - 2:].strip() if expl_col and len(line) > expl_col - 2 else ""
        # Skip stray math fragments from formulas set in the PDF.
        if tail and re.search(r"[A-Za-z]{3}", tail):
            current["doc"] += " " + tail
    return entries


def main():
    text = Path(sys.argv[1]).read_text().splitlines()
    out = {}

    def add(name, kind, doc, types="", plain=False):
        entry = out.setdefault(name, {"kind": kind, "plain": plain, "docs": []})
        line = doc if not types else f"{doc} ({types})"
        if line not in entry["docs"]:
            entry["docs"].append(line)

    for number, (kind, title) in TABLES.items():
        starts = [i for i, l in enumerate(text) if f"Table {number}: {title}" in l]
        for start in starts:
            for e in parse_table(text, start, kind):
                names = e["names"]
                # "arctime of" -> arctime; "write to" -> write; "< = >" -> each symbol
                if names[-1] in ("of", "to") and len(names) == 2:
                    names = names[:1]
                for name in names:
                    add(name, kind, e["doc"], e["types"] if kind in ("operator", "macro") else "", e["plain"])

    for kind, items in EXTRA.items():
        for name, doc in items.items():
            if kind == "type":
                out.setdefault(name, {"plain": False, "docs": []})
                out[name]["kind"] = "type"
                out[name]["docs"].insert(0, doc)
            elif name not in out:
                add(name, kind, doc)

    dest = Path(__file__).resolve().parent.parent / "src" / "builtins.json"
    dest.write_text(json.dumps(dict(sorted(out.items())), indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {len(out)} builtins to {dest}")


main()
