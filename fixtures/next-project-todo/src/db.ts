import { boolean, database, integer, table, text } from '@arkorlab/reactive-state/server';

// V4 target: extend the existing declaration; never mark these fields globally public.
// Records returned by get/findMany include an immutable, DB-assigned `id`.
export const db = database(
  {
    projects: table({
      ownerId: text({ maxLength: 64 }),
      title: text({ maxLength: 200 }),
      published: boolean(),
      internalNote: text({ maxLength: 2000 }),
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
  },
  {
    seed: {
      projects: {
        p1: {
          ownerId: 'alice', title: '開発', published: true,
          internalNote: 'PRIVATE_ONLY_P1_8ca2_do_not_publish',
        },
        p2: {
          ownerId: 'alice', title: '運用', published: false,
          internalNote: 'PRIVATE_ONLY_P2_a491_do_not_publish',
        },
      },
      memberships: {
        'p1-bob': { projectId: 'p1', userId: 'bob', canEdit: true },
        'p2-bob': { projectId: 'p2', userId: 'bob', canEdit: true },
      },
      todos: {
        t1: { projectId: 'p1', title: '一覧を作る', completed: false, estimate: 2 },
        t2: { projectId: 'p1', title: '同期を確認する', completed: false, estimate: 3 },
      },
    },
  },
);
