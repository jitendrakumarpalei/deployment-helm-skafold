declare module 'pg' {
  export interface QueryResult<T = any> {
    rows: T[];
  }

  export class Pool {
    constructor(config?: any);
    connect(): Promise<any>;
    query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
    end(): Promise<void>;
  }

  export type PoolClient = any;
}
