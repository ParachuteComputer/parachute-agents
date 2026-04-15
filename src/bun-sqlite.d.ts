/**
 * Minimal ambient declaration for `bun:sqlite`. Covers only the surface
 * `SqliteConversationStore` uses — we intentionally don't pull in the full
 * `@types/bun` (or `bun-types`) package just to keep the dep footprint small.
 * Extend as needed.
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { create?: boolean; readonly?: boolean });
    exec(sql: string): void;
    query<Row = unknown, Params extends unknown[] = unknown[]>(
      sql: string,
    ): {
      run(...params: Params): { lastInsertRowid: number; changes: number };
      all(...params: Params): Row[];
      get(...params: Params): Row | null;
    };
    transaction<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void;
    close(): void;
  }
}
