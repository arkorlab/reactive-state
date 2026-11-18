import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJson } from '../src/authority/canonical.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { targetChanged } from './support/local-write-target.ts';

/**
 * An object the code builds in steps — `target.user = {}` and then `target.user.name = 'x'` — is an
 * ordinary program: the container is the object the code assigned, and a key of an object is no
 * hole. A container the code assigned that may be an array — an array, a call, a choice of either —
 * keeps the refusals of an array's writes (`canonical.ts`'s `isJson` refuses a sparse array and an
 * array with a key beside its elements).
 */

interface Inputs {
  readonly flag: boolean;
  readonly keys: readonly string[];
}

interface Case {
  readonly id: string;
  readonly body: string;
  readonly changed: boolean;
  readonly run: (inputs: Inputs) => unknown;
}

const INPUTS: Inputs = { flag: true, keys: ['a', 'b'] };
const THIRD = 3;
const FIVE = 5;

function box<T>(value: T): T {
  return value;
}

interface Nest {
  extra?: number;
}

type Meta = Record<string, unknown> | unknown[];

const CASES: readonly Case[] = [
  {
    body: "const target: { user?: { name?: string } } = {}; target.user = {}; target.user.name = 'x'; return target;",
    changed: false,
    id: 'object-assigned-then-keyed',
    run: () => {
      const target = box<{ user?: { name?: string } }>({});
      target.user = {};
      target.user.name = 'x';
      return target;
    },
  },
  {
    body: "const target: { user?: { id: number; name?: string } } = {}; target.user = { id: 1 }; target.user.name = 'x'; return target;",
    changed: false,
    id: 'object-literal-assigned-then-keyed',
    run: () => {
      const target = box<{ user?: { id: number; name?: string } }>({});
      target.user = { id: 1 };
      target.user.name = 'x';
      return target;
    },
  },
  {
    body: "const target = { user: { id: 1 } as { id: number; name?: string } }; target.user = {} as { id: number }; target.user.name = 'x'; return target;",
    changed: false,
    id: 'object-replaced-by-object-then-keyed',
    run: () => {
      const target = box<{ user: { id: number; name?: string } }>({ user: { id: 1 } });
      target.user = {} as { id: number };
      target.user.name = 'x';
      return target;
    },
  },
  {
    body: "const target: { user?: { name?: string } } = {}; target.user ??= {}; target.user.name = 'x'; return target;",
    changed: false,
    id: 'object-assigned-by-nullish-assignment-then-keyed',
    run: () => {
      const target = box<{ user?: { name?: string } }>({});
      target.user ??= {};
      target.user.name = 'x';
      return target;
    },
  },
  {
    body: 'const target: Tree = {}; for (const key of keys) { target[key] = {}; target[key].n = 1; } return target;',
    changed: false,
    id: 'object-per-key-assigned-then-keyed',
    run: ({ keys }) => {
      const target = box<Record<string, { n?: number }>>({});
      for (const key of keys) {
        target[key] = {};
        target[key].n = 1;
      }
      return target;
    },
  },
  {
    body: 'const target: { meta?: Record<string, number> } = {}; target.meta = {}; Object.assign(target.meta, { a: 1 }); return target;',
    changed: false,
    id: 'object-assigned-then-assigned-into',
    run: () => {
      const target = box<{ meta?: Record<string, number> }>({});
      target.meta = {};
      Object.assign(target.meta, { a: 1 });
      return target;
    },
  },
  {
    body: 'const target: { meta?: { a?: number } } = {}; target.meta = { a: 1 }; delete target.meta.a; return target;',
    changed: false,
    id: 'object-assigned-then-deleted-from',
    run: () => {
      const target = box<{ meta?: { a?: number } }>({});
      target.meta = { a: 1 };
      delete target.meta.a;
      return target;
    },
  },
  {
    body: 'const target: { items?: unknown } = {}; target.items = [1]; (target.items as Nest).extra = 1; return target;',
    changed: true,
    id: 'pin-array-assigned-then-named-key',
    run: () => {
      const target = box<{ items?: unknown }>({});
      target.items = [1];
      (target.items as Nest).extra = 1;
      return target;
    },
  },
  {
    body: 'const target: { rows?: number[] } = {}; target.rows = [1]; target.rows[3] = 3; return target;',
    changed: true,
    id: 'pin-array-assigned-then-hole',
    run: () => {
      const target = box<{ rows?: number[] }>({});
      target.rows = [1];
      target.rows[THIRD] = THIRD;
      return target;
    },
  },
  {
    body: 'const target: { items?: unknown } = {}; target.items = flag ? [1] : {}; (target.items as Nest).extra = 1; return target;',
    changed: true,
    id: 'pin-choice-of-array-or-object-then-named-key',
    run: ({ flag }) => {
      const target = box<{ items?: unknown }>({});
      target.items = flag ? [1] : {};
      (target.items as Nest).extra = 1;
      return target;
    },
  },
  {
    body: 'const target: { items?: unknown } = {}; target.items = {}; if (flag) { target.items = [1]; } (target.items as Nest).extra = 1; return target;',
    changed: true,
    id: 'pin-object-replaced-by-array-then-named-key',
    run: ({ flag }) => {
      const target = box<{ items?: unknown }>({});
      target.items = {};
      if (flag) {
        target.items = [1];
      }
      (target.items as Nest).extra = 1;
      return target;
    },
  },
  {
    body: 'const target: { items?: unknown } = {}; target.items = make(); (target.items as Nest).extra = 1; return target;\nfunction make() { return [1]; }',
    changed: true,
    id: 'pin-call-assigned-then-named-key',
    run: () => {
      const target = box<{ items?: unknown }>({});
      target.items = [1];
      (target.items as Nest).extra = 1;
      return target;
    },
  },
  {
    body: 'const target: { user?: { n?: number } } = {}; target.user = {}; target.user.n = NaN; return target;',
    changed: true,
    id: 'pin-value-written-into-assigned-object-still-checked',
    run: () => {
      const target = box<{ user?: { n?: number } }>({});
      target.user = {};
      target.user.n = NaN;
      return target;
    },
  },
  {
    body: 'const defaults: { meta?: Meta } = { meta: [] }; const target: { meta?: Meta } = { ...defaults }; target.meta ??= {}; Object.assign(target.meta, { extra: 1 }); return target;',
    changed: true,
    id: 'nullish-assigned-over-a-container-a-spread-may-hold',
    run: () => {
      const defaults = box<{ meta?: Meta }>({ meta: [] });
      const target = box<{ meta?: Meta }>({ ...defaults });
      target.meta ??= {};
      Object.assign(target.meta, { extra: 1 });
      return target;
    },
  },
  {
    body: 'const defaults: { meta?: Meta | null } = { meta: [] }; const target: { meta?: Meta | null } = { ...defaults }; target.meta ||= {}; Object.assign(target.meta, { extra: 1 }); return target;',
    changed: true,
    id: 'or-assigned-over-a-container-a-spread-may-hold',
    run: () => {
      const defaults = box<{ meta?: Meta | null }>({ meta: [] });
      const target = box<{ meta?: Meta | null }>({ ...defaults });
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- exercises the logical assignment
      target.meta ||= {};
      Object.assign(target.meta, { extra: 1 });
      return target;
    },
  },
  {
    body: 'const target: { meta?: Meta } = { meta: {} }; target.meta ??= {}; Object.assign(target.meta, { extra: 1 }); return target;',
    changed: false,
    id: 'nullish-assigned-over-an-object-the-initializer-writes',
    run: () => {
      const target = box<{ meta?: Meta }>({ meta: {} });
      target.meta ??= {};
      Object.assign(target.meta, { extra: 1 });
      return target;
    },
  },
  {
    body: 'const target: { meta?: Meta; other: number } = { other: 1 }; target.meta ??= {}; Object.assign(target.meta, { extra: 1 }); return target;',
    changed: false,
    id: 'nullish-assigned-over-a-key-the-initializer-lacks',
    run: () => {
      const target = box<{ meta?: Meta; other: number }>({ other: 1 });
      target.meta ??= {};
      Object.assign(target.meta, { extra: 1 });
      return target;
    },
  },
  {
    body: 'const target: { meta?: Meta } = { meta: [] }; target.meta ??= {}; Object.assign(target.meta, { extra: 1 }); return target;',
    changed: true,
    id: 'pin-nullish-assigned-over-an-array-the-initializer-writes',
    run: () => {
      const target = box<{ meta?: Meta }>({ meta: [] });
      target.meta ??= {};
      Object.assign(target.meta, { extra: 1 });
      return target;
    },
  },
  {
    body: 'const defaults: { meta: Meta } = { meta: [] }; const target: { meta: Meta } = { ...defaults }; if (keys.length > 5) { target.meta = {}; } Object.assign(target.meta, { extra: 1 }); return target;',
    changed: true,
    id: 'assigned-in-a-branch-over-a-container-a-spread-may-hold',
    run: ({ keys }) => {
      const defaults = box<{ meta: Meta }>({ meta: [] });
      const target = box<{ meta: Meta }>({ ...defaults });
      if (keys.length > FIVE) {
        target.meta = {};
      }
      Object.assign(target.meta, { extra: 1 });
      return target;
    },
  },
  {
    body: 'const target: Record<string, Meta> = {}; for (const key of keys) { target[key] = {}; Object.assign(target[key], { extra: 1 }); } return target;',
    changed: false,
    id: 'dictionary-of-objects-built-in-a-loop-of-an-empty-object',
    run: ({ keys }) => {
      const target = box<Record<string, Meta>>({});
      for (const key of keys) {
        target[key] = {};
        Object.assign(target[key], { extra: 1 });
      }
      return target;
    },
  },
];

describe('local writes into a container the code assigned', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ body, changed, run }) => {
    using parsed = parseModule(
      api,
      'assigned-containers.ts',
      `type Tree = Record<string, { n?: number }>;\ninterface Nest { extra?: number }\ntype Meta = Record<string, unknown> | unknown[];\nexport function build(flag: boolean, keys: readonly string[]) { ${body} }\n`,
    );

    expect(isJson(run(INPUTS))).toBe(!changed);
    expect(targetChanged(parsed.sourceFile)).toBe(changed);
  });
});
