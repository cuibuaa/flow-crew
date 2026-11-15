/** Policy fixtures inspect bytes and atomic visibility, not crash durability.
 * Node's writeFileSync handles flush internally, so replacing an exported
 * fsyncSync fixture binding alone does not remove durable disk waits. */
export function stageFileSystem(fs: typeof import('node:fs')) {
  return { ...fs, fsyncSync: () => {},
    writeFileSync: ((file, data, options) => fs.writeFileSync(file, data,
      options && typeof options === 'object' ? { ...options, flush: false } : options)) as typeof fs.writeFileSync,
  };
}

/** SQLite commits bypass node:fs; policy fixtures need visibility, not power-loss durability. */
export function stageSqlite(sqlite: typeof import('node:sqlite')) {
  return { ...sqlite, DatabaseSync: class extends sqlite.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof sqlite.DatabaseSync>) {
      super(...args);
      this.exec('PRAGMA synchronous = OFF');
    }
  } };
}

/** Native CLI policy fixtures retain real writes and transactions, without
 * testing power-loss durability. Embed these closure-free owners so a native
 * child needs no TypeScript loader or second policy implementation. */
export function stagePolicyPreload(): string {
  return `
import fs from 'node:fs';
import sqlite from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
const files = (${stageFileSystem.toString()})({ ...fs });
fs.fsyncSync = files.fsyncSync;
fs.writeFileSync = files.writeFileSync;
sqlite.DatabaseSync = (${stageSqlite.toString()})({ ...sqlite }).DatabaseSync;
syncBuiltinESMExports();
`;
}
