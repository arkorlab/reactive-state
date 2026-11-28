import type { TableRead } from '../server/context.ts';
import type { ChangeCause, Dependencies, RowChange } from './dependencies.ts';

/**
 * What the authority can say of what it follows, which no page shows: a read of a table whole
 * renders the same as a read of its rows, and a render for a change that shows nothing sends the
 * page nothing. Tables, components and counts alone: a read's values never enter it, so that a
 * key's text — an address, say — reaches no log.
 */

/** How many reads of a table named its rows, and how many read it whole. */
interface TableReads {
  keyed: number;
  whole: number;
}

/** How many renders a table's changes woke, by why. */
type Causes = Partial<Record<ChangeCause, number>>;

/** What the authority counted since it started (`Stats.follow`). */
export interface FollowStats {
  readonly reads: Readonly<Record<string, Readonly<TableReads>>>;
  /** Of each page's root, by each table: why a commit woke a stream to render it again. */
  readonly rendersAgain: Readonly<Record<string, Readonly<Record<string, Readonly<Causes>>>>>;
}

/** How often the report is written where it is asked for: once a minute, at most. */
const REPORT_EVERY_MS = 60_000;

/** How often a host's setting asks for the report, as `REACTIVE_DIAGNOSTICS=on` does. */
export function diagnosticsEveryOf(setting: unknown): number | undefined {
  return setting === 'on' ? REPORT_EVERY_MS : undefined;
}

/**
 * The counts, and their report. It is written as a call of the queue ends (`report`), never in one
 * and never of a poll, which runs beside the queue: a render's first statement is no account of the
 * render, and a report of it could say a table was read by rows that its next statement reads whole.
 * It holds no timer, so it asks for no turn of a Durable Object's one alarm, and what was counted
 * since the last report waits for the next call.
 */
export class Diagnostics {
  readonly #clock: () => number;
  readonly #everyMs: number | undefined;
  readonly #reads = new Map<string, TableReads>();
  readonly #again = new Map<string, Map<string, Causes>>();
  #reportedAt: number | undefined;
  #unreported = false;

  constructor(clock: () => number, everyMs: number | undefined) {
    this.#clock = clock;
    this.#everyMs = everyMs;
  }

  /** What a render's statement read, but the table of the schema, which every statement reads. */
  read(reads: readonly TableRead[]): void {
    for (const { schema, table, where } of reads) {
      if (schema === true) continue;
      const counted = this.#reads.get(table) ?? { keyed: 0, whole: 0 };
      this.#reads.set(table, counted);
      counted[Object.keys(where).length > 0 ? 'keyed' : 'whole'] += 1;
      this.#unreported = true;
    }
  }

  /** Whether a commit of `rows` wakes a stream of `component`, counted with why where it does. */
  woken(component: string, read: Dependencies | undefined, rows: readonly RowChange[]): boolean {
    if (read?.changedBy(rows) !== true) return false;
    const changed = read.causeOf(rows);
    if (changed === undefined) return true;
    const { cause, table } = changed;
    const tables = this.#again.get(component) ?? new Map<string, Causes>();
    this.#again.set(component, tables);
    const causes = tables.get(table) ?? {};
    tables.set(table, causes);
    causes[cause] = (causes[cause] ?? 0) + 1;
    this.#unreported = true;
    return true;
  }

  /** Writes the report, where it was asked for, its interval passed and something was counted. */
  report(): void {
    if (this.#everyMs === undefined || !this.#unreported) return;
    const now = this.#clock();
    if (this.#reportedAt !== undefined && now - this.#reportedAt < this.#everyMs) return;
    this.#reportedAt = now;
    this.#unreported = false;
    try {
      // eslint-disable-next-line no-console
      console.info(`reactive-state diagnostics: ${JSON.stringify(this.stats)}`);
    } catch {
      // A report is no part of the call it follows, whatever the host's console does.
    }
  }

  get stats(): FollowStats {
    const reads = [...this.#reads].map(([table, counted]) => [table, { ...counted }] as const);
    const rendersAgain = [...this.#again].map(([component, tables]) => {
      const causes = [...tables].map(([table, each]) => [table, { ...each }] as const);
      return [component, Object.fromEntries(causes)] as const;
    });
    return {
      reads: Object.fromEntries(reads),
      rendersAgain: Object.fromEntries(rendersAgain),
    };
  }
}
