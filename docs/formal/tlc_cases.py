#!/usr/bin/env python3
"""TLC settings files (.cfg) for the models under docs/formal, generated from each folder's case table.

A folder's cases are tabled in two committed files:
  cases.tsv            case_id<TAB>config.cfg<TAB>Module, one line per case to run, in run order (read by run-tlc.sh)
  cases.json           one record per case, in the same order (cases.tsv may list a subset, in order: a batch);
                       its "tlc" object holds the case's settings:
                       {"comment": first-line note, "spec": "Spec", "constants": {"Name": "value", "Op": {"<-": "Def"}},
                        "invariants": [...], "properties": [...], "view": "Expr" (optional), "deadlock": true|false,
                        "layout": {...} (optional: only where the case departs from its module's template)}
Retired cases (code that no longer exists, kept for the record) move from both tables to
  cases-retired.json   the same records, each with "retired": "<reason>"; never run, generated only with --with-retired
and one template per model:
  tlc-templates.json   {"Module": {"indent": 4, "constants": [names in order], "lists": "block"|"lines",
                        "deadlockFirst": false}}

The .cfg files are not committed (docs/formal/.gitignore). run-tlc.sh and check-packet.sh generate them before use.

Usage: python3 tlc_cases.py gen [--with-retired] <folder>...   write <folder>/<case>.cfg for every case (and every
                                                                 retired case); remove other *.cfg files there
       python3 tlc_cases.py check  <folder>...   compare the generated text of every case, retired ones included, with
                                                 the *.cfg files present (byte for byte)
       python3 tlc_cases.py import <folder>...   table the *.cfg files present into cases.json and tlc-templates.json; a
                                                 file no cases.tsv line names goes to cases-retired.json
       python3 tlc_cases.py retire <folder> <case_id> <reason>   move a case from cases.tsv and cases.json to
                                                 cases-retired.json
       python3 tlc_cases.py clean  <folder>...   remove the generated *.cfg files
       --all instead of folders: every folder under docs/formal that has a cases.tsv
A folder's gen-cases.py, where there is one, writes cases.tsv, cases.json and tlc-templates.json with attach() below.
"""
import json
import os
import re
import sys

LIST_SECTIONS = (("INVARIANTS", "INVARIANT", "invariants"), ("PROPERTIES", "PROPERTY", "properties"))
CONST_LINE = re.compile(r"^( +)([A-Za-z_][A-Za-z0-9_]*) (=|<-) (.+)$")


def parse_cfg(text):
    """A .cfg's text -> (record, style). Raises ValueError on anything the renderer would not reproduce."""
    if not text.endswith("\n"):
        raise ValueError("no final newline")
    lines = text[:-1].split("\n")
    rec = {}
    style = {"indent": None, "constants": [], "lists": None, "deadlockFirst": False}
    i = 0
    if lines and lines[0].startswith("\\* "):
        rec["comment"] = lines[0][3:]
        i = 1
    seen = []
    section = None
    for line in lines[i:]:
        if line.startswith(" "):
            indent = len(line) - len(line.lstrip(" "))
            if style["indent"] is None:
                style["indent"] = indent
            elif style["indent"] != indent:
                raise ValueError("mixed indentation")
            body = line[indent:]
            if section == "CONSTANTS":
                m = CONST_LINE.match(line)
                if not m:
                    raise ValueError(f"constant line: {line!r}")
                name, op, value = m.group(2), m.group(3), m.group(4)
                if name in rec["constants"]:
                    raise ValueError(f"constant {name} twice")
                rec["constants"][name] = value if op == "=" else {"<-": value}
                style["constants"].append(name)
            elif section in ("INVARIANTS", "PROPERTIES"):
                rec[dict((a, c) for a, _, c in LIST_SECTIONS)[section]].append(body)
            elif section == "VIEW":
                if "view" in rec:
                    raise ValueError("two VIEW lines")
                rec["view"] = body
            else:
                raise ValueError(f"indented line outside a section: {line!r}")
            continue
        word, _, rest = line.partition(" ")
        seen.append(word)
        section = None
        if word == "SPECIFICATION" and rest:
            rec["spec"] = rest
        elif word == "CHECK_DEADLOCK" and rest in ("TRUE", "FALSE"):
            rec["deadlock"] = rest == "TRUE"
            style["deadlockFirst"] = "CONSTANTS" not in seen
        elif word == "CONSTANTS" and not rest:
            section = word
            rec["constants"] = {}
        elif word in ("INVARIANTS", "PROPERTIES") and not rest:
            section = word
            _set_lists(style, "block")
            rec.setdefault(dict((a, c) for a, _, c in LIST_SECTIONS)[word], [])
        elif word in ("INVARIANT", "PROPERTY") and rest:
            _set_lists(style, "lines")
            rec.setdefault(dict((b, c) for _, b, c in LIST_SECTIONS)[word], []).append(rest)
        elif word == "VIEW" and not rest:
            section = word
        else:
            raise ValueError(f"line: {line!r}")
    for key in ("spec", "constants", "deadlock"):
        if key not in rec:
            raise ValueError(f"no {key}")
    rec.setdefault("invariants", [])
    rec.setdefault("properties", [])
    style["lists"] = style["lists"] or "block"
    style["indent"] = style["indent"] if style["indent"] is not None else 4
    ordered = {k: rec[k] for k in ("comment", "spec", "constants", "invariants", "properties", "view", "deadlock") if k in rec}
    return ordered, style


def _set_lists(style, form):
    if style["lists"] not in (None, form):
        raise ValueError("both list forms in one file")
    style["lists"] = form


def render(rec, template):
    """A case record and its module's template -> the .cfg text."""
    lay = dict(template)
    lay.update(rec.get("layout", {}))
    pad = " " * lay["indent"]
    names = list(rec["constants"])
    if names != [n for n in lay["constants"] if n in rec["constants"]] or len(names) != len(lay["constants"]):
        raise ValueError(f"constants {names} do not match the template {lay['constants']}")
    out = []
    if "comment" in rec:
        out.append("\\* " + rec["comment"])
    out.append("SPECIFICATION " + rec["spec"])
    deadlock = "CHECK_DEADLOCK " + ("TRUE" if rec["deadlock"] else "FALSE")
    if lay["deadlockFirst"]:
        out.append(deadlock)
    out.append("CONSTANTS")
    for name in lay["constants"]:
        value = rec["constants"][name]
        out.append(f"{pad}{name} = {value}" if isinstance(value, str) else f"{pad}{name} <- {value['<-']}")
    if "view" in rec:
        out += ["VIEW", pad + rec["view"]]
    for plural, single, key in LIST_SECTIONS:
        items = rec.get(key, [])
        if not items:
            continue
        if lay["lists"] == "lines":
            out += [f"{single} {item}" for item in items]
        else:
            out.append(plural)
            out += [pad + item for item in items]
    if not lay["deadlockFirst"]:
        out.append(deadlock)
    return "\n".join(out) + "\n"


def attach(cases, texts):
    """Set each case's "tlc" record from its .cfg text; return the module templates (used by gen-cases.py and import)."""
    styles = {}
    for case, text in zip(cases, texts):
        rec, style = parse_cfg(text)
        case["tlc"] = rec
        styles.setdefault(case["module"], []).append((case, style))
    templates = {}
    for module in sorted(styles):
        entries = styles[module]
        orders = {tuple(s["constants"]) for _, s in entries}
        indents = {s["indent"] for _, s in entries}
        if len(orders) != 1 or len(indents) != 1:
            raise ValueError(f"{module}: the cases do not share one constant order and indentation")
        lists = _majority([s["lists"] for _, s in entries])
        first = _majority([s["deadlockFirst"] for _, s in entries])
        templates[module] = {"indent": indents.pop(), "constants": list(orders.pop()), "lists": lists, "deadlockFirst": first}
        for case, s in entries:
            layout = {k: s[k] for k in ("lists", "deadlockFirst") if s[k] != templates[module][k]}
            if layout:
                case["tlc"]["layout"] = layout
    return templates


def _majority(values):
    return max(sorted(set(values), key=str), key=values.count)


def dump_json(path, value, indent, newline=True):
    with open(path, "w") as f:
        json.dump(value, f, indent=indent)
        if newline:
            f.write("\n")


def json_form(path):
    """The indentation (1 or 2) and final newline of an existing JSON file, so a rewrite keeps its form."""
    with open(path) as f:
        text = f.read()
    second = text.split("\n")[1] if "\n" in text else ""
    return (len(second) - len(second.lstrip(" ")) or 1), text.endswith("\n")


def read_tables(folder):
    with open(os.path.join(folder, "cases.tsv")) as f:
        rows = [line.rstrip("\n").split("\t") for line in f if line.strip()]
    with open(os.path.join(folder, "cases.json")) as f:
        cases = json.load(f)
    by_id = {c["id"]: (i, c) for i, c in enumerate(cases)}
    if len(by_id) != len(cases):
        raise ValueError(f"{folder}: cases.json lists a case twice")
    last = -1
    for row in rows:
        if len(row) != 3 or row[0] not in by_id:
            raise ValueError(f"{folder}: cases.tsv line {row} has no cases.json record")
        index, case = by_id[row[0]]
        if row[1] != case["id"] + ".cfg" or row[2] != case["module"] or index <= last:
            raise ValueError(f"{folder}: cases.tsv line for {row[0]} does not match cases.json (name, module or order)")
        last = index
    return rows, cases


def read_retired(folder):
    path = os.path.join(folder, "cases-retired.json")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return json.load(f)


def generated(folder, with_retired=False):
    """{config file name: text} for every case of the folder (and every retired case)."""
    rows, cases = read_tables(folder)
    selected = {row[0] for row in rows}
    with open(os.path.join(folder, "tlc-templates.json")) as f:
        templates = json.load(f)
    retired = read_retired(folder)
    ids = [c["id"] for c in cases] + [c["id"] for c in retired]
    if len(set(ids)) != len(ids):
        raise ValueError(f"{folder}: a case id is both active and retired, or retired twice")
    texts = {}
    for case in [c for c in cases if c["id"] in selected] + (retired if with_retired else []):
        if "tlc" not in case:
            raise ValueError(f"{folder}: case {case['id']} has no tlc record")
        texts[case["id"] + ".cfg"] = render(case["tlc"], templates[case["module"]])
    return texts


def present_cfgs(folder):
    return sorted(n for n in os.listdir(folder) if n.endswith(".cfg"))


def cmd_gen(folder, with_retired=False):
    texts = generated(folder, with_retired)
    for name in present_cfgs(folder):
        if name not in texts:
            os.remove(os.path.join(folder, name))
    for name, text in texts.items():
        with open(os.path.join(folder, name), "w") as f:
            f.write(text)
    print(f"{folder}: {len(texts)} settings files generated")
    return 0


def cmd_check(folder):
    texts = generated(folder, True)
    present = set(present_cfgs(folder))
    bad = 0
    for name, text in texts.items():
        if name not in present:
            print(f"{folder}: {name} is not present")
            bad += 1
            continue
        with open(os.path.join(folder, name)) as f:
            if f.read() != text:
                print(f"{folder}: {name} differs from the generated text")
                bad += 1
    for name in sorted(present - set(texts)):
        print(f"{folder}: {name} is present but no case generates it")
        bad += 1
    print(f"{folder}: {len(texts)} cases, {len(texts) - min(bad, len(texts))} identical, {bad} difference(s)")
    return 1 if bad else 0


def cmd_import(folder):
    rows, cases = read_tables(folder)
    if len(rows) != len(cases):
        raise ValueError(f"{folder}: import needs cases.tsv to list every case of cases.json")
    texts = []
    for row in rows:
        with open(os.path.join(folder, row[1])) as f:
            texts.append(f.read())
    indent, newline = json_form(os.path.join(folder, "cases.json"))
    templates = attach(cases, texts)
    dump_json(os.path.join(folder, "cases.json"), cases, indent, newline)
    dump_json(os.path.join(folder, "tlc-templates.json"), templates, 2)
    named = {row[1] for row in rows}
    loose = [n for n in present_cfgs(folder) if n not in named]
    if loose:
        modules = sorted({c["module"] for c in cases})
        if len(modules) != 1:
            raise ValueError(f"{folder}: {loose} are in no table, and the folder has more than one module")
        retired = read_retired(folder)
        for name in loose:
            with open(os.path.join(folder, name)) as f:
                rec, style = parse_cfg(f.read())
            rec["layout"] = style
            retired.append({"id": name[:-4], "module": modules[0], "config": name,
                            "retired": "a settings file no case table named (an earlier form of the model)", "tlc": rec})
        dump_json(os.path.join(folder, "cases-retired.json"), retired, 1)
    print(f"{folder}: {len(cases)} cases tabled, {len(templates)} templates, {len(loose)} retired")
    return 0


def cmd_retire(folder, case_id, reason):
    rows, cases = read_tables(folder)
    index = next((i for i, c in enumerate(cases) if c["id"] == case_id), None)
    if index is None:
        raise ValueError(f"{folder}: no case {case_id}")
    case = cases.pop(index)
    rows = [r for r in rows if r[0] != case_id]
    retired = read_retired(folder)
    retired.append(dict(case, retired=reason))
    indent, newline = json_form(os.path.join(folder, "cases.json"))
    dump_json(os.path.join(folder, "cases.json"), cases, indent, newline)
    dump_json(os.path.join(folder, "cases-retired.json"), retired, 1)
    with open(os.path.join(folder, "cases.tsv"), "w") as f:
        f.write("".join("\t".join(r) + "\n" for r in rows))
    print(f"{folder}: {case_id} retired")
    return 0


def cmd_clean(folder):
    for name in present_cfgs(folder):
        os.remove(os.path.join(folder, name))
    return 0


def all_folders():
    root = os.path.dirname(os.path.abspath(__file__))
    return sorted(d for d, _, files in os.walk(root) if "cases.tsv" in files)


def main(argv):
    commands = {"gen": cmd_gen, "check": cmd_check, "import": cmd_import, "clean": cmd_clean}
    if len(argv) == 4 and argv[0] == "retire":
        try:
            return cmd_retire(argv[1], argv[2], argv[3])
        except (ValueError, OSError) as error:
            print(error)
            return 1
    with_retired = "--with-retired" in argv[1:]
    args = [a for a in argv[1:] if a != "--with-retired"]
    if len(argv) < 2 or argv[0] not in commands or not args or (with_retired and argv[0] != "gen"):
        print(__doc__)
        return 2
    folders = all_folders() if args == ["--all"] else args
    rc = 0
    for folder in folders:
        try:
            rc |= commands[argv[0]](folder, with_retired) if argv[0] == "gen" else commands[argv[0]](folder)
        except (ValueError, OSError, KeyError) as error:
            print(f"{folder}: {error}")
            rc |= 1
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
