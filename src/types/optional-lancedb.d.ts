declare module "@lancedb/lancedb" {
  export function connect(uri: string): Promise<{
    tableNames(): Promise<string[]>;
    openTable(name: string): Promise<unknown>;
    createTable(name: string, rows: unknown[]): Promise<unknown>;
  }>;
}
