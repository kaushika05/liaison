import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";

/**
 * Fails if any tracked file starts with a UTF-8 byte order mark.
 *
 * A BOM is invisible in most editors and legal in many formats, but `JSON.parse` rejects it. A BOM
 * on package.json breaks Vite's PostCSS config discovery with an error that names neither the file
 * nor the byte, so this check exists to turn a confusing failure into an obvious one. Some Windows
 * tooling writes a BOM by default, which is how one got in.
 */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function startsWithBom(file: string): boolean {
  let handle: number;
  try {
    handle = openSync(file, "r");
  } catch {
    return false; // Deleted or unreadable in the working tree; not this check's concern.
  }
  try {
    const head = Buffer.alloc(3);
    const bytes = readSync(handle, head, 0, 3, 0);
    return bytes === 3 && head.equals(BOM);
  } finally {
    closeSync(handle);
  }
}

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const offenders = tracked.filter(startsWithBom);

if (offenders.length > 0) {
  process.stderr.write(`Byte order mark found in ${offenders.length} tracked file(s):\n`);
  for (const file of offenders) process.stderr.write(`  ${file}\n`);
  process.stderr.write("Re-save these files as UTF-8 without a BOM.\n");
  process.exit(1);
}

process.stdout.write(`No byte order marks in ${tracked.length} tracked files.\n`);
