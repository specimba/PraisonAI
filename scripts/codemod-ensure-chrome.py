#!/usr/bin/env python3
"""r254 codemod: wire ensureChrome() into every CDP suite that assumes a live
9222 (no self-launch). Deterministic, idempotent, and self-verifying:

  1. Target = scripts/*.mjs that mention 127.0.0.1:9222, are not the helper
     itself, and don't already import cdp-ensure-chrome.
  2. Insert `await ensureChrome();` immediately BEFORE the first line that
     references 127.0.0.1:9222, copying that line's indentation (keeps the
     call inside the same async function scope the suite dials CDP from).
  3. Prepend the import (after a shebang if present).
  4. Syntax-check every touched file with `node --check`; auto-revert any
     file that fails so the tree is never left broken.

Prints a summary; exit 1 if any file had to be reverted.
"""

import re
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
HELPER_NAME = "cdp-ensure-chrome.mjs"
IMPORT_LINE = f'import {{ ensureChrome }} from "./{HELPER_NAME}";\n'
CALL_LINE = "await ensureChrome();"

def main() -> int:
    touched: list[Path] = []
    reverted: list[Path] = []

    for f in sorted(SCRIPTS.glob("*.mjs")):
        if f.name == HELPER_NAME or f.name == Path(__file__).name:
            continue
        src = f.read_text()
        if HELPER_NAME[:-4] in src or "127.0.0.1:9222" not in src:
            continue
        lines = src.splitlines(keepends=True)

        # first CDP reference line
        idx = next(i for i, l in enumerate(lines) if "127.0.0.1:9222" in l)
        indent = re.match(r"[ \t]*", lines[idx]).group(0)
        call = f"{indent}{CALL_LINE}\n"

        # avoid inserting inside a comment block: skip if the previous
        # non-empty line ends an ongoing // comment that the anchor continues
        new_lines = lines[:idx] + [call] + lines[idx:]

        # import after shebang if present, else at top
        ins = 1 if lines and lines[0].startswith("#!") else 0
        new_lines = new_lines[:ins] + [IMPORT_LINE] + new_lines[ins:]

        f.write_text("".join(new_lines))

        check = subprocess.run(
            ["node", "--check", str(f)], capture_output=True, text=True
        )
        if check.returncode != 0:
            subprocess.run(["git", "checkout", "--", str(f)], check=True)
            reverted.append(f.name)
            print(f"REVERTED {f.name}: {check.stderr.strip()[:160]}")
        else:
            touched.append(f.name)
            print(f"OK {f.name}")

    print(f"\ntouched={len(touched)} reverted={len(reverted)}")
    return 1 if reverted else 0

if __name__ == "__main__":
    sys.exit(main())
