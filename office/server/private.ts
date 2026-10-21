import { rmSync, writeFileSync } from "node:fs";

/** Writes `data` to the temp file `tmp` so only the user can read it; the caller then renames or links it into place. */
export function writePrivate(tmp: string, data: string) {
  rmSync(tmp, { force: true }); // a leftover would keep its mode, and a link planted there would be followed
  writeFileSync(tmp, data, { mode: 0o600, flag: "wx" }); // wx: never opens a file or link that appeared since the rm
}
