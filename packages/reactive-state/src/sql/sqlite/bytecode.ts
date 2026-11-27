/**
 * What a statement of SQLite — D1's — reads, as its bytecode (`EXPLAIN`) says: each b-tree it opens
 * to read, by its root page, which the schema (`sqlite_schema`) names the table of — a view read in
 * place of its tables, an index for its table — and whether it writes, or opens what no root page
 * names. The bytecode is SQLite's own and is not promised to stay as it is; what it does not say
 * plainly is read as no answer, and the statement then reads every followed table whole.
 */

/** A row of `EXPLAIN`: an opcode and its operands. */
export interface Instruction {
  readonly opcode: string;
  readonly p1: unknown;
  readonly p2: unknown;
  readonly p3: unknown;
}

/** A row of `sqlite_schema` of a table or an index: its name, its table's, its root page. */
export interface SchemaEntry {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly rootpage: number;
  readonly sql: string | null;
}

/** What a statement's bytecode says it does. */
export type BytecodeReads =
  | {
      readonly kind: 'reads';
      readonly tables: ReadonlySet<string>;
      /** How many virtual tables it opens, whose reads no root page names. */
      readonly virtuals: number;
    }
  | { readonly kind: 'writes' }
  | { readonly kind: 'unread'; readonly why: string };

/** The opcodes that open a b-tree to read: a table's or an index's, by its root page. */
const READS = new Set(['OpenRead', 'ReopenIdx']);
/**
 * The opcodes that write a table: not `Insert` and its kin, which a read writes into a b-tree of its
 * own (`OpenEphemeral`, of a sort, a `DISTINCT`, a list), but a b-tree opened to write, a virtual
 * table's update, SQL run of its own (`SqlExec`: `PRAGMA optimize`, which makes tables of
 * statistics, in a read transaction of some builds), a `VACUUM`, and a transaction's own control
 * (`AutoCommit` of a `BEGIN` or a `COMMIT`, a `Savepoint`), which D1 refuses besides; a write
 * transaction says it besides.
 */
const WRITES = new Set(['AutoCommit', 'OpenWrite', 'Savepoint', 'SqlExec', 'Vacuum', 'VUpdate']);
/** The opcode that opens a virtual table, whose reads no root page names. */
const VIRTUAL = 'VOpen';
/** The opcode every program of SQLite's ends at: one of none is not read as SQLite's. */
const END = 'Halt';

/** `value` as a whole number, where it is one. */
function whole(value: unknown): number | undefined {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : undefined;
}

/**
 * What `instruction` opens to read: the table of the b-tree, by the name `schema` gives its root
 * page; why it is not read plainly — a b-tree of another database than `main` (a temporary or an
 * attached one's), a root page the schema names not; or nothing it opens to read.
 */
function openedBy(
  { opcode, p2, p3 }: Instruction,
  byPage: ReadonlyMap<number, SchemaEntry>,
): { readonly table: string } | { readonly why: string } | undefined {
  if (!READS.has(opcode)) return undefined;
  const page = whole(p2);
  if (page === undefined || whole(p3) !== 0) {
    return { why: 'it opens a b-tree of another database than main' };
  }
  const entry = byPage.get(page);
  return entry === undefined
    ? { why: `no table or index is of root page ${String(page)}` }
    : { table: entry.tableName };
}

/**
 * The tables `instructions` read, by the names `schema` gives their root pages: none where they
 * write anywhere — a write transaction, a b-tree opened to write, a virtual table's update, after
 * what is read not plainly too (an FTS5 table's update opens it first) — and no answer where they
 * open what is not read plainly (`openedBy`), or the answer is of no program as SQLite writes one
 * (no `Halt`): no row, or rows of another shape.
 */
export function bytecodeReads(
  instructions: readonly Instruction[],
  schema: readonly SchemaEntry[],
): BytecodeReads {
  const byPage = new Map(schema.map((entry) => [entry.rootpage, entry]));
  const tables = new Set<string>();
  let unread: string | undefined;
  let virtuals = 0;
  for (const instruction of instructions) {
    const { opcode, p2 } = instruction;
    if (WRITES.has(opcode) || (opcode === 'Transaction' && whole(p2) !== 0)) {
      return { kind: 'writes' };
    }
    if (opcode === VIRTUAL) virtuals += 1;
    const opened = openedBy(instruction, byPage);
    if (opened !== undefined && 'why' in opened) unread ??= opened.why;
    if (opened !== undefined && 'table' in opened) tables.add(opened.table);
  }
  if (instructions.every((instruction) => instruction.opcode !== END)) {
    return { kind: 'unread', why: 'its bytecode is of no Halt' };
  }
  return unread === undefined
    ? { kind: 'reads', tables, virtuals }
    : { kind: 'unread', why: unread };
}
