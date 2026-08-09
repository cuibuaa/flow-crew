import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalizeCodexHome } from "../../src/adapters/codex.js";

function fakeCodexHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fc_codex_home_"));
  // the 99%-of-disk offender: .tmp/plugins git packs
  mkdirSync(join(home, ".tmp", "plugins", ".git", "objects", "pack"), { recursive: true });
  writeFileSync(join(home, ".tmp", "plugins", ".git", "objects", "pack", "pack-x.pack"), "x".repeat(4096));
  writeFileSync(join(home, "config.toml"), "model = 'x'\n");
  writeFileSync(join(home, "state.sqlite"), "db");
  writeFileSync(join(home, "state.sqlite-wal"), "wal");
  writeFileSync(join(home, "logs.sqlite-shm"), "shm");
  return home;
}

describe("finalizeCodexHome — disk retention (purge on success, keep on failure)", () => {
  it("purges the ENTIRE codex_home on stage success (exitCode 0)", () => {
    const home = fakeCodexHome();
    finalizeCodexHome(home, 0);
    expect(existsSync(home)).toBe(false);
  });

  it("keeps codex_home on any failure (non-zero) for debugging, dropping only the SQLite WAL/SHM", () => {
    for (const code of [1, 124, 137]) {
      const home = fakeCodexHome();
      finalizeCodexHome(home, code);
      expect(existsSync(home)).toBe(true); // kept for debugging
      expect(existsSync(join(home, "config.toml"))).toBe(true);
      expect(existsSync(join(home, ".tmp", "plugins", ".git", "objects", "pack", "pack-x.pack"))).toBe(true);
      expect(existsSync(join(home, "state.sqlite"))).toBe(true); // DB kept
      expect(existsSync(join(home, "state.sqlite-wal"))).toBe(false); // WAL dropped (checkpointed)
      expect(existsSync(join(home, "logs.sqlite-shm"))).toBe(false); // SHM dropped
    }
  });
});
