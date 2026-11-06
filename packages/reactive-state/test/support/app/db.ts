import { boolean, database, integer, table, text } from '../../../src/server/index.ts';

/**
 * The test application's database, as `@/db` declares one: the fixture's projects, their members
 * and their tasks — the project fixture's own `src/db.ts`, whose seed it starts with — and a
 * counter, whose `count` a page without a session shows.
 */
export const db = database(
  {
    projects: table({
      ownerId: text({ maxLength: 64 }),
      title: text({ maxLength: 200 }),
    }),
    memberships: table(
      {
        projectId: text({ maxLength: 64 }),
        userId: text({ maxLength: 64 }),
        canEdit: boolean(),
      },
      { unique: [['projectId', 'userId']] },
    ),
    todos: table({
      projectId: text({ maxLength: 64 }),
      title: text({ maxLength: 200 }),
      completed: boolean(),
      estimate: integer({ min: 0, max: 1_000_000 }),
    }),
    counters: table(
      {
        ownerId: text({ maxLength: 64 }),
        title: text({ maxLength: 200 }),
        count: integer({ max: 1_000_000, min: -1_000_000 }),
      },
      { public: ['count'] },
    ),
  },
  {
    seed: {
      projects: {
        p1: { ownerId: 'alice', title: '開発' },
        p2: { ownerId: 'alice', title: '運用' },
        p3: { ownerId: 'bob', title: 'Bob の作業' },
      },
      memberships: {
        'p1-bob': { projectId: 'p1', userId: 'bob', canEdit: true },
        'p2-bob': { projectId: 'p2', userId: 'bob', canEdit: true },
      },
      todos: {
        t1: { projectId: 'p1', title: '一覧を作る', completed: false, estimate: 2 },
        t2: { projectId: 'p1', title: '同期を確認する', completed: false, estimate: 3 },
        t3: { projectId: 'p2', title: '監視を見直す', completed: false, estimate: 1 },
      },
      counters: {
        main: { count: 0, ownerId: 'alice', title: 'Shared counter' },
        other: { count: 100, ownerId: 'alice', title: 'Unrelated counter' },
      },
    },
  },
);
