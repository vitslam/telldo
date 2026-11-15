import {
  DatabaseSync,
  backup as backupDatabase,
  type StatementSync,
} from "node:sqlite";

/** Synchronous SQLite bundled with Electron's Node runtime; no platform addon. */
class Statement {
  constructor(private readonly statement: StatementSync) {
    statement.setAllowBareNamedParameters(true);
    statement.setAllowUnknownNamedParameters(true);
  }
  run(...parameters: any[]): {
    changes: number;
    lastInsertRowid: number | bigint;
  } {
    const result = this.statement.run(...parameters);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }
  get(...parameters: any[]): Record<string, any> | undefined {
    const row = this.statement.get(...parameters);
    return row ? { ...row } : undefined;
  }
  all(...parameters: any[]): Record<string, any>[] {
    return this.statement.all(...parameters).map((row) => ({ ...row }));
  }
}
class SQLiteDatabase {
  private readonly connection: DatabaseSync;
  private depth = 0;
  private sequence = 0;
  constructor(path: string) {
    this.connection = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
  }
  function(name: string, handler: (...values: any[]) => any): void {
    this.connection.function(name, { deterministic: true }, handler);
  }
  exec(sql: string): void {
    this.connection.exec(sql);
  }
  prepare(sql: string): Statement {
    return new Statement(this.connection.prepare(sql));
  }
  pragma(statement: string, options?: { simple?: boolean }): any {
    const rows = this.prepare(`PRAGMA ${statement}`).all();
    return options?.simple
      ? rows[0]
        ? Object.values(rows[0])[0]
        : undefined
      : rows;
  }
  transaction<T, Args extends unknown[]>(
    operation: (...args: Args) => T,
  ): (...args: Args) => T {
    return (...args: Args): T => {
      const nested = this.depth > 0,
        savepoint = `telldo_${++this.sequence}`;
      this.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      this.depth++;
      try {
        const result = operation(...args);
        if (result && typeof (result as any).then === "function")
          throw new Error("SQLite transactions must be synchronous");
        this.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        try {
          this.exec(
            nested
              ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`
              : "ROLLBACK",
          );
        } catch {
          /* Preserve the original write/commit error. */
        }
        throw error;
      } finally {
        this.depth--;
      }
    };
  }
  async backup(destination: string): Promise<void> {
    await backupDatabase(this.connection, destination);
  }
  close(): void {
    this.connection.close();
  }
}
namespace SQLiteDatabase {
  export type Database = SQLiteDatabase;
}
export default SQLiteDatabase;
