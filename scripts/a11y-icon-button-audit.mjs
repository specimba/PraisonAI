// r150 a11y audit: find icon-only <Button size="icon"> blocks missing an
// aria-label (screen readers announce them as unnamed "button"). Scans all
// praison components. A block = from <Button to the next > that opens the
// children (attributes span multiple JSX lines, so aria-label may legally
// appear after onClick etc. — we take the WHOLE attribute run up to the
// line that ends with > and no continuation).
import fs from "node:fs";
import path from "node:path";

const ROOT = "src/components/praison";
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".tsx")) files.push(p);
  }
})(ROOT);

let total = 0;
const missing = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const re = /<Button\b/g;
  let m;
  while ((m = re.exec(src))) {
    // capture the tag up to the first '>' that is not inside a JSX expression
    let i = m.index, depth = 0, tag = "";
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
      else if (c === ">" && depth === 0) break;
      tag += c;
    }
    const line = src.slice(0, m.index).split("\n").length;
    total++;
    const isIcon = /size="icon"/.test(tag);
    const hasLabel = /aria-label/.test(tag);
    if (isIcon && !hasLabel) {
      missing.push(`${f}:${line}  ${tag.replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
}

console.log(`scanned ${files.length} files, ${total} <Button> tags, ${missing.length} icon-only without aria-label`);
for (const m of missing) console.log("  MISSING: " + m);
process.exit(0);
