declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean });
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
    transaction<T>(fn: () => T): T;
  }

  export interface Statement {
    run(...params: any[]): RunResult;
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }

  export interface RunResult {
    changes: number;
    lastInsertRowid: number;
  }
}
