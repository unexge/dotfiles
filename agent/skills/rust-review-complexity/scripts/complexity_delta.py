#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""
Compute a review-difficulty score for Rust changes by diffing per-function
metrics (cognitive complexity, cyclomatic complexity, SLOC) between a git
base ref and the current working tree.

Requires `rust-code-analysis-cli` on PATH.
    cargo install rust-code-analysis-cli

Usage:
    complexity_delta.py [--base HEAD] [--json] [--top N]

Exit codes:
    0 - analysis ran (score may be 0)
    2 - missing dependency or git error
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, NoReturn

# Tunable weights. Cognitive complexity dominates because it tracks how hard
# code is to *read*, not just how many branches it has.
W_COGNITIVE = 2.0
W_CYCLOMATIC = 1.0
W_NLOC = 0.1
PENALTY_NEW_FILE = 5.0
PENALTY_DELETED_FILE = 2.0
PENALTY_PER_EXTRA_FILE = 1.5


def die(msg: str, code: int = 2) -> NoReturn:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def run(cmd: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def changed_rust_files(base: str) -> list[str]:
    """Rust files that differ from `base`, including untracked ones so that a
    work-in-progress tree is scored the same way a staged one is."""
    tracked = run(["git", "diff", "--name-only", base, "--", "*.rs"])
    if tracked.returncode != 0:
        die(f"git diff failed: {tracked.stderr.strip()}")
    untracked = run(["git", "ls-files", "--others", "--exclude-standard", "--", "*.rs"])
    if untracked.returncode != 0:
        die(f"git ls-files failed: {untracked.stderr.strip()}")
    names = tracked.stdout.splitlines() + untracked.stdout.splitlines()
    return sorted({n for n in names if n})


def extract_base(base: str, path: str, dest: Path) -> bool:
    """Write the version of `path` at ref `base` to `dest`. Returns False if
    the file did not exist at that ref (i.e. it is a new file). `base` is
    validated in main(), so a failure here means the path is genuinely absent."""
    r = run(["git", "show", f"{base}:{path}"])
    if r.returncode != 0:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(r.stdout)
    return True


def analyze(path: Path) -> dict[str, Any]:
    """Run rust-code-analysis-cli on a single file and return parsed JSON."""
    if not path.exists():
        return {}
    with tempfile.TemporaryDirectory() as out_dir:
        r = run([
            "rust-code-analysis-cli",
            "-m", "-O", "json",
            "-o", out_dir,
            "-p", str(path),
        ])
        if r.returncode != 0:
            die(f"rust-code-analysis-cli failed on {path}: {r.stderr.strip()}")
        # rust-code-analysis-cli writes its output mirroring the input path
        # under out_dir (e.g. input `src/foo.rs` -> `<out_dir>/src/foo.rs.json`),
        # so we need to search recursively rather than with iterdir().
        for entry in Path(out_dir).rglob("*.json"):
            try:
                return json.loads(entry.read_text())
            except json.JSONDecodeError as exc:
                die(f"could not parse metrics for {path}: {exc}")
    die(f"rust-code-analysis-cli produced no metrics for {path}")


def collect_functions(node: dict[str, Any]) -> dict[str, dict[str, float]]:
    """Walk the rust-code-analysis space tree and return
    {qualified_name: {cognitive, cyclomatic, nloc}} for every function-like space."""
    out: dict[str, dict[str, float]] = {}

    def unique(name: str) -> str:
        # Sibling closures all qualify to `parent::<anon>`; keying them by name
        # alone would silently drop every one but the last. Suffix duplicates in
        # traversal (source) order so the Nth sibling still matches the Nth
        # sibling in the baseline.
        if name not in out:
            return name
        index = 2
        while f"{name}#{index}" in out:
            index += 1
        return f"{name}#{index}"

    def walk(n: dict[str, Any], pfx: str) -> None:
        kind = n.get("kind", "")
        name = n.get("name") or "<anon>"
        # rust-code-analysis names the top-level "unit" node with the input
        # file path. That path differs between the baseline checkout (a
        # tempdir) and the current working tree, so including it in the
        # qualified name would make every unchanged function look
        # simultaneously "added" (current) and "removed" (baseline).
        if kind == "unit":
            qn = pfx
        else:
            qn = f"{pfx}::{name}" if pfx else name
        if kind in ("function", "method", "closure"):
            m = n.get("metrics", {})
            cog = m.get("cognitive", {})
            cyc = m.get("cyclomatic", {})
            loc = m.get("loc", {})
            qn = unique(qn)
            out[qn] = {
                "cognitive": float(cog.get("sum", cog.get("total", 0)) or 0),
                "cyclomatic": float(cyc.get("sum", cyc.get("total", 0)) or 0),
                "nloc": float(loc.get("sloc", 0) or 0),
            }
        for sp in n.get("spaces", []) or []:
            walk(sp, qn)

    walk(node, "")
    return out


ZERO = {"cognitive": 0.0, "cyclomatic": 0.0, "nloc": 0.0}


def score_functions(before: dict, after: dict) -> tuple[float, dict]:
    total = 0.0
    breakdown: dict[str, dict[str, Any]] = {}
    for name in set(before) | set(after):
        b = before.get(name, ZERO)
        a = after.get(name, ZERO)
        d_cog = a["cognitive"] - b["cognitive"]
        d_cyc = a["cyclomatic"] - b["cyclomatic"]
        d_nloc = a["nloc"] - b["nloc"]
        s = (
            W_COGNITIVE * abs(d_cog)
            + W_CYCLOMATIC * abs(d_cyc)
            + W_NLOC * abs(d_nloc)
        )
        if s == 0 and name in before and name in after:
            continue
        if name not in before:
            status = "added"
        elif name not in after:
            status = "removed"
        else:
            status = "modified"
        breakdown[name] = {
            "status": status,
            "before": b,
            "after": a,
            "delta_cognitive": d_cog,
            "delta_cyclomatic": d_cyc,
            "delta_nloc": d_nloc,
            "score": round(s, 2),
        }
        total += s
    return total, breakdown


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default="HEAD",
                    help="Git ref to compare against (default: HEAD).")
    ap.add_argument("--json", action="store_true",
                    help="Emit machine-readable JSON.")
    ap.add_argument("--top", type=int, default=5,
                    help="Show top-N functions per file in human output.")
    args = ap.parse_args()

    if not shutil.which("rust-code-analysis-cli"):
        die("rust-code-analysis-cli not found on PATH. "
            "Install with: cargo install rust-code-analysis-cli")
    if run(["git", "rev-parse", "--is-inside-work-tree"]).returncode != 0:
        die("not inside a git work tree")
    if run(["git", "rev-parse", "--verify", "--quiet", args.base]).returncode != 0:
        die(f"unknown git ref: {args.base}")

    files = changed_rust_files(args.base)
    if not files:
        out = {"total_score": 0, "base": args.base, "files_changed": 0,
               "files": {}, "note": "no rust files changed"}
        print(json.dumps(out, indent=2) if args.json else "no rust files changed")
        return

    per_file: dict[str, dict[str, Any]] = {}
    total = 0.0

    with tempfile.TemporaryDirectory() as tmp:
        tmp_root = Path(tmp)
        for f in files:
            base_copy = tmp_root / "before" / f
            had_base = extract_base(args.base, f, base_copy)

            before_funcs = collect_functions(analyze(base_copy)) if had_base else {}
            cur_path = Path(f)
            after_funcs = collect_functions(analyze(cur_path)) if cur_path.exists() else {}

            fn_score, breakdown = score_functions(before_funcs, after_funcs)

            structural = 0.0
            tags: list[str] = []
            if not had_base:
                structural += PENALTY_NEW_FILE
                tags.append("new")
            if not cur_path.exists():
                structural += PENALTY_DELETED_FILE
                tags.append("deleted")

            file_score = fn_score + structural
            per_file[f] = {
                "score": round(file_score, 2),
                "function_score": round(fn_score, 2),
                "structural_score": round(structural, 2),
                "tags": tags,
                "functions": breakdown,
            }
            total += file_score

    extra_files_penalty = max(0, len(files) - 1) * PENALTY_PER_EXTRA_FILE
    total += extra_files_penalty

    result = {
        "total_score": round(total, 2),
        "base": args.base,
        "files_changed": len(files),
        "extra_files_penalty": round(extra_files_penalty, 2),
        "weights": {
            "cognitive": W_COGNITIVE,
            "cyclomatic": W_CYCLOMATIC,
            "nloc": W_NLOC,
            "new_file": PENALTY_NEW_FILE,
            "deleted_file": PENALTY_DELETED_FILE,
            "extra_file": PENALTY_PER_EXTRA_FILE,
        },
        "files": per_file,
    }

    if args.json:
        print(json.dumps(result, indent=2))
        return

    print(f"review complexity score: {result['total_score']}  (base={args.base})")
    print(f"files changed: {len(files)}  extra-files penalty: {extra_files_penalty}")
    print()
    sorted_files = sorted(per_file.items(), key=lambda kv: -kv[1]["score"])
    for fname, info in sorted_files:
        tag = f" [{','.join(info['tags'])}]" if info["tags"] else ""
        print(f"  {fname}{tag}: {info['score']}  "
              f"(funcs={info['function_score']}, struct={info['structural_score']})")
        funcs = sorted(info["functions"].items(), key=lambda kv: -kv[1]["score"])
        for fn, d in funcs[: args.top]:
            print(f"    {d['status']:8} {fn}  "
                  f"cog {d['delta_cognitive']:+.0f}  "
                  f"cyc {d['delta_cyclomatic']:+.0f}  "
                  f"nloc {d['delta_nloc']:+.0f}  "
                  f"score {d['score']}")


if __name__ == "__main__":
    main()
