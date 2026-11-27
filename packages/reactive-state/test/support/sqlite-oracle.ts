import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { D1Database } from '@cloudflare/workers-types';
import { relations } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { followDrizzle } from '../../src/sql/index.ts';
import type { DrizzleD1Follow } from '../../src/sql/sqlite/follow.ts';

/**
 * A database of an application's shape, for the oracle of what a render follows: a tenancy's four
 * tables, indexes and foreign keys, the change log's real triggers, a binding of D1's shape over
 * `node:sqlite`, and random rows and writes of few enough ids that they meet.
 */

export const user = sqliteTable(
  'user',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    githubId: text('github_id').unique(),
    verified: integer({ mode: 'boolean' }).notNull().default(false),
    level: text(),
  },
  (table) => [index('user_level').on(table.level)],
);
export const organization = sqliteTable('organization', {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
});
export const member = sqliteTable(
  'member',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id').notNull(),
    userId: text('user_id').notNull(),
    role: text().notNull(),
    createdAt: integer('created_at').notNull(),
    level: integer(),
  },
  (table) => {
    return [
      uniqueIndex('member_seat').on(table.organizationId, table.userId),
      index('member_user').on(table.userId),
      index('member_level').on(table.level),
    ];
  },
);
export const teamInvitations = sqliteTable(
  'team_invitations',
  {
    id: text().primaryKey(),
    organizationId: text('organization_id').notNull(),
    githubId: text('github_id').notNull(),
    status: text().notNull(),
    inviterUserId: text('inviter_user_id'),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => {
    return [
      index('invitation_organization').on(table.organizationId),
      index('invitation_github').on(table.githubId),
      index('invitation_inviter').on(table.inviterUserId),
    ];
  },
);

const tables = { member, organization, teamInvitations, user };
const memberRelations = relations(member, ({ one }) => {
  return {
    organization: one(organization, {
      fields: [member.organizationId],
      references: [organization.id],
    }),
    user: one(user, { fields: [member.userId], references: [user.id] }),
  };
});
const organizationRelations = relations(organization, ({ many }) => ({ members: many(member) }));
const schema = { ...tables, memberRelations, organizationRelations };

const DDL = [
  `CREATE TABLE "user" (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, github_id TEXT UNIQUE,
    verified INTEGER NOT NULL DEFAULT 0, level TEXT)`,
  `CREATE INDEX user_level ON "user" (level)`,
  `CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE member (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    role TEXT NOT NULL, created_at INTEGER NOT NULL, level INTEGER)`,
  `CREATE UNIQUE INDEX member_seat ON member (organization_id, user_id)`,
  `CREATE INDEX member_user ON member (user_id)`,
  `CREATE INDEX member_level ON member (level)`,
  `CREATE TABLE team_invitations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
    github_id TEXT NOT NULL, status TEXT NOT NULL,
    inviter_user_id TEXT REFERENCES "user" (id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL)`,
  `CREATE INDEX invitation_organization ON team_invitations (organization_id)`,
  `CREATE INDEX invitation_github ON team_invitations (github_id)`,
  `CREATE INDEX invitation_inviter ON team_invitations (inviter_user_id)`,
];

/** Whether SQLite answers rows of `sql`, as D1 does of a statement it reads. */
const READS = /^\s*(?:explain|pragma|select|values|with)\b/iu;

/** A statement a render's candidate asks, whose values name the rows of a table. */
const CANDIDATE = /^SELECT DISTINCT "\w+" AS "value" FROM /u;

/** What a trial does around a render's statements: what writes between them, or answers otherwise. */
interface OracleHooks {
  /** Told as a batch of candidates is asked, and as it is answered. */
  asking?: (() => void) | undefined;
  answered?: (() => void) | undefined;
  /** Whether a statement waits a turn, so that the candidates beside it run first. */
  late?: boolean;
  /** What the rows of a candidate are answered as. */
  rows?: ((rows: readonly unknown[]) => readonly unknown[]) | undefined;
}

/** What `answer` answers, as D1 does: later, and of a rejection of what it throws. */
async function later<T>(answer: () => T, hooks: OracleHooks): Promise<T> {
  await (hooks.late === true
    ? new Promise((resolve) => {
        setImmediate(resolve);
      })
    : Promise.resolve());
  return answer();
}

/** A statement of D1's shape, bound to `values`. */
function statementOf(
  db: DatabaseSync,
  hooks: OracleHooks,
  sql: string,
  values: readonly SQLInputValue[],
) {
  const ran = () => {
    const prepared = db.prepare(sql);
    if (CANDIDATE.test(sql)) {
      const rows = prepared.all(...values);
      return { meta: {}, results: hooks.rows?.(rows) ?? rows, success: true };
    }
    if (READS.test(sql)) return { meta: {}, results: prepared.all(...values), success: true };
    const { changes } = prepared.run(...values);
    return { meta: { changes: Number(changes) }, results: [], success: true };
  };
  return {
    all: () => later(ran, hooks),
    bind: (...bound: readonly SQLInputValue[]) => statementOf(db, hooks, sql, bound),
    first: () => later(() => db.prepare(sql).get(...values) ?? null, hooks),
    ran,
    raw: () => {
      return later(() => {
        const prepared = db.prepare(sql);
        prepared.setReturnArrays(true);
        return prepared.all(...values);
      }, hooks);
    },
    run: () => later(ran, hooks),
    sql,
  };
}

/** A binding of D1's shape over `db`, whose calls answer a turn later, as D1's do. */
function bindingOf(db: DatabaseSync, hooks: OracleHooks): D1Database {
  const binding = {
    batch: async (statements: readonly ReturnType<typeof statementOf>[]) => {
      const candidates = statements.some((statement) => CANDIDATE.test(statement.sql));
      await Promise.resolve();
      if (candidates) hooks.asking?.();
      const answers = statements.map((statement) => statement.ran());
      if (candidates) hooks.answered?.();
      return answers;
    },
    prepare: (sql: string) => statementOf(db, hooks, sql, []),
  };
  return binding as unknown as D1Database;
}

/** What a statement of the oracle runs on. */
export type Orm = DrizzleD1Database<typeof schema>;

/** A database of the oracle. */
export interface OracleDatabase {
  readonly binding: D1Database;
  readonly db: DatabaseSync;
  readonly follow: DrizzleD1Follow<typeof tables>;
  /** What a trial sets around a render, and clears after it. */
  readonly hooks: OracleHooks;
  /** What a render reads through: its statements note their rows. */
  readonly followed: Orm;
  /** What the oracle asks through, of nothing noted. */
  readonly plain: Orm;
}

/** A database of the schema and its log's triggers, of what reads it and what follows it. */
export function oracleDatabase(foreignKeys: boolean): OracleDatabase {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: foreignKeys });
  const follow = followDrizzle(tables);
  for (const statement of DDL) db.exec(statement);
  for (const statement of follow.captureSql()) db.exec(statement);
  const hooks: OracleHooks = {};
  const binding = bindingOf(db, hooks);
  return {
    binding,
    db,
    follow,
    hooks,
    followed: drizzle(follow.client(binding), { schema }),
    plain: drizzle(binding, { schema }),
  };
}

const LEHMER = {
  multiplier: 48_271,
  modulus: 2_147_483_647,
  spread: 2_654_435,
  warmth: 8,
} as const;

/** A seeded stream of choices, so that what one run finds the next finds again. */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = ((seed + 1) * LEHMER.spread) % LEHMER.modulus;
    for (let at = 0; at < LEHMER.warmth; at += 1) this.next();
  }

  next(): number {
    this.#state = (this.#state * LEHMER.multiplier) % LEHMER.modulus;
    return this.#state / LEHMER.modulus;
  }

  int(below: number): number {
    return Math.floor(this.next() * below);
  }

  of<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  chance(share: number): boolean {
    return this.next() < share;
  }
}

const idsOf = (prefix: string, count: number): readonly string[] =>
  Array.from({ length: count }, (_, at) => `${prefix}${String(at)}`);

export const USERS = idsOf('u', 5);
export const ORGANIZATIONS = idsOf('o', 3);
export const SLUGS = idsOf('s', 3);
export const GITHUB = idsOf('g', 5);
const MEMBERS = idsOf('m', 9);
const INVITATIONS = idsOf('i', 7);
const ROLES = ['member', 'admin', 'owner'];
const NAMES = ['ann', 'bob', 'cid'];
const STATUSES = ['pending', 'accepted'];
const SHARE = { filled: 0.8, held: 0.7, nulled: 0.2 } as const;
const STAMPS = 9;
/** A member's levels, as integers. */
const LEVELS = [1, 2];
/** A person's levels, of texts a member's integer equals though their text is not its own. */
const TEXT_LEVELS = ['1', '01'];

/** A statement of a write, and its values. */
type Write = readonly [sql: string, values: readonly SQLInputValue[]];

/** A table's rows as the oracle writes them. */
interface Target {
  readonly table: string;
  readonly ids: readonly string[];
  readonly insert: (random: Random, id: string) => Write;
  readonly updates: (random: Random) => readonly (readonly [string, SQLInputValue])[];
}

const githubOf = (random: Random) => (random.chance(SHARE.nulled) ? null : random.of(GITHUB));

const TARGETS: readonly Target[] = [
  {
    ids: USERS,
    insert: (random, id) => {
      return [
        'INSERT INTO "user" (id, name, github_id, verified, level) VALUES (?, ?, ?, ?, ?)',
        [id, random.of(NAMES), githubOf(random), random.int(2), random.of(TEXT_LEVELS)],
      ];
    },
    table: 'user',
    updates: (random) => {
      return [
        ['name', random.of(NAMES)],
        ['github_id', githubOf(random)],
        ['id', random.of(USERS)],
        ['verified', random.int(2)],
        ['level', random.of(TEXT_LEVELS)],
      ];
    },
  },
  {
    ids: ORGANIZATIONS,
    insert: (random, id) => {
      return [
        'INSERT INTO organization (id, name, slug) VALUES (?, ?, ?)',
        [id, random.of(NAMES), random.of(SLUGS)],
      ];
    },
    table: 'organization',
    updates: (random) => {
      return [
        ['name', random.of(NAMES)],
        ['slug', random.of(SLUGS)],
        ['id', random.of(ORGANIZATIONS)],
      ];
    },
  },
  {
    ids: MEMBERS,
    insert: (random, id) => {
      return [
        `INSERT INTO member (id, organization_id, user_id, role, created_at, level)
          VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          random.of(ORGANIZATIONS),
          random.of(USERS),
          random.of(ROLES),
          random.int(STAMPS),
          random.of(LEVELS),
        ],
      ];
    },
    table: 'member',
    updates: (random) => {
      return [
        ['organization_id', random.of(ORGANIZATIONS)],
        ['user_id', random.of(USERS)],
        ['role', random.of(ROLES)],
        ['created_at', random.int(STAMPS)],
        ['level', random.of(LEVELS)],
      ];
    },
  },
  {
    ids: INVITATIONS,
    insert: (random, id) => {
      return [
        `INSERT INTO team_invitations
          (id, organization_id, github_id, status, inviter_user_id, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          random.of(ORGANIZATIONS),
          random.of(GITHUB),
          random.of(STATUSES),
          random.of(USERS),
          random.int(STAMPS),
        ],
      ];
    },
    table: 'team_invitations',
    updates: (random) => {
      return [
        ['organization_id', random.of(ORGANIZATIONS)],
        ['github_id', random.of(GITHUB)],
        ['status', random.of(STATUSES)],
        ['inviter_user_id', random.of(USERS)],
        ['expires_at', random.int(STAMPS)],
      ];
    },
  },
];

/** The text of `write`, where the database took it: a constraint may refuse it. */
function attempt(db: DatabaseSync, [sql, values]: Write): string | undefined {
  try {
    db.prepare(sql).run(...values);
    return `${sql} ${JSON.stringify(values)}`;
  } catch {
    return undefined;
  }
}

/** Rows of most of each table's ids. */
export function populate(db: DatabaseSync, random: Random): void {
  for (const target of TARGETS) {
    for (const id of target.ids) {
      if (random.chance(SHARE.filled)) attempt(db, target.insert(random, id));
    }
  }
}

/**
 * A random write of one statement, of its text where the database took it, most of the time of a row
 * `held` names: what an answer holds is what a miss shows in.
 */
export function mutate(db: DatabaseSync, random: Random, held = ''): string | undefined {
  const { ids, insert, table, updates } = random.of(TARGETS);
  const kind = random.of(['insert', 'update', 'update', 'delete']);
  const named = ids.filter((each) => held.includes(`"${each}"`));
  const id = random.of(named.length > 0 && random.chance(SHARE.held) ? named : ids);
  if (kind === 'insert') return attempt(db, insert(random, id));
  if (kind === 'delete') return attempt(db, [`DELETE FROM "${table}" WHERE id = ?`, [id]]);
  const [column, value] = random.of(updates(random));
  return attempt(db, [`UPDATE "${table}" SET ${column} = ? WHERE id = ?`, [value, id]]);
}
