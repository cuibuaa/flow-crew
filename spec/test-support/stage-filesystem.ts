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
