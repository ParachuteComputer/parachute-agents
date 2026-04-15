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
    close(): void;
  }
}
