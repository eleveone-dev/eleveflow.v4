// Client Supabase encadeável em memória, suficiente para os módulos _shared.
// Suporta select/eq/in/order/limit/maybeSingle/single/insert/update/rpc e
// registra as escritas para asserção.

export type Row = Record<string, any>;
export type FakeDb = Record<string, Row[]>;

export interface FakeWrite {
  table: string;
  kind: "insert" | "update";
  payload: Row;
  filters: Array<[string, any]>;
}

export interface FakeClientOptions {
  rpc?: Record<string, (args: Row) => { data: any; error: any }>;
  errors?: Record<string, { message: string }>;
}

export function createFakeClient(db: FakeDb, options: FakeClientOptions = {}) {
  const writes: FakeWrite[] = [];
  const rpcCalls: Array<{ name: string; args: Row }> = [];

  function matches(row: Row, filters: Array<[string, any]>, inFilters: Array<[string, any[]]>) {
    return (
      filters.every(([column, value]) => row[column] === value) &&
      inFilters.every(([column, values]) => values.includes(row[column]))
    );
  }

  function builder(table: string) {
    const filters: Array<[string, any]> = [];
    const inFilters: Array<[string, any[]]> = [];
    let mode: "select" | "insert" | "update" | "upsert" = "select";
    let conflictColumn: string | null = null;
    let payload: Row = {};
    let limitCount: number | null = null;
    let orderColumn: string | null = null;
    let orderAscending = true;

    const resolve = () => {
      const error = options.errors?.[table] ?? null;
      if (error) return { data: null, error };

      const rows = db[table] ?? [];

      if (mode === "upsert") {
        const rows_ = Array.isArray(payload) ? payload : [payload];
        for (const row of rows_) {
          const existing = conflictColumn
            ? rows.find((candidate) => candidate[conflictColumn!] === row[conflictColumn!])
            : undefined;
          if (existing) Object.assign(existing, row);
          else db[table] = [...(db[table] ?? []), row];
        }
        writes.push({ table, kind: "insert", payload, filters: [...filters] });
        return { data: rows_, error: null };
      }

      if (mode === "insert") {
        const inserted = Array.isArray(payload) ? payload : [payload];
        db[table] = [...rows, ...inserted];
        writes.push({ table, kind: "insert", payload, filters: [...filters] });
        return { data: inserted, error: null };
      }

      const selected = rows.filter((row) => matches(row, filters, inFilters));

      if (mode === "update") {
        for (const row of selected) Object.assign(row, payload);
        writes.push({ table, kind: "update", payload, filters: [...filters] });
        return { data: selected, error: null };
      }

      let result = [...selected];
      if (orderColumn) {
        result.sort((a, b) => {
          const left = a[orderColumn!];
          const right = b[orderColumn!];
          if (left === right) return 0;
          return (left > right ? 1 : -1) * (orderAscending ? 1 : -1);
        });
      }
      if (limitCount !== null) result = result.slice(0, limitCount);
      return { data: result, error: null };
    };

    const chain: any = {
      select: () => chain,
      eq: (column: string, value: any) => {
        filters.push([column, value]);
        return chain;
      },
      in: (column: string, values: any[]) => {
        inFilters.push([column, values]);
        return chain;
      },
      or: () => chain,
      lte: () => chain,
      order: (column: string, opts?: { ascending?: boolean }) => {
        orderColumn = column;
        orderAscending = opts?.ascending !== false;
        return chain;
      },
      limit: (count: number) => {
        limitCount = count;
        return chain;
      },
      insert: (rows: Row) => {
        mode = "insert";
        payload = rows;
        return chain;
      },
      upsert: (rows: Row, options?: { onConflict?: string }) => {
        mode = "upsert";
        payload = rows;
        conflictColumn = options?.onConflict ?? null;
        return resolve();
      },
      update: (patch: Row) => {
        mode = "update";
        payload = patch;
        return chain;
      },
      maybeSingle: async () => {
        const { data, error } = resolve();
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
      },
      single: async () => {
        const { data, error } = resolve();
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
      },
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };

    return chain;
  }

  return {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Row) => {
      rpcCalls.push({ name, args });
      const handler = options.rpc?.[name];
      return handler ? handler(args) : { data: null, error: null };
    },
    __writes: writes,
    __rpcCalls: rpcCalls,
  };
}
