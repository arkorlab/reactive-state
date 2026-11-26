import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Merged class and interface types retain written native error bases without a data member. */
const CASES = [
  {
    name: 'interface before class error base',
    source: 'interface Failure extends Error {} class Failure {}',
    error: true,
  },
  {
    name: 'class before interface error base',
    source: 'class Failure {} interface Failure extends Error {}',
    error: true,
  },
  {
    name: 'merged supplied type argument base',
    source: 'type Base<T> = T; interface Failure extends Base<Error> {} class Failure {}',
    error: true,
  },
  {
    name: 'merged default type argument base',
    source: 'type Base<T = Error> = T; interface Failure extends Base {} class Failure {}',
    error: true,
  },
  {
    name: 'merged namespace interface base',
    source:
      'declare namespace Types { interface Failure extends Error {} } declare namespace Types { class Failure {} } type Failure = Types.Failure;',
    error: true,
  },
  {
    name: 'merged cycle retains reachable error',
    source:
      'interface Failure extends Other {} class Failure {} interface Other extends Failure, Error {}',
    error: true,
  },
  {
    name: 'interface first data field error parameter',
    source:
      'interface Failure extends Error {} class Failure { stack = "data"; } class Raised extends Error { declare stack: string; }',
    argument: 'new Raised(value)',
    error: true,
  },
  {
    name: 'class first data field error parameter',
    source:
      'class Failure { stack = "data"; } interface Failure extends Error {} class Raised extends Error { declare stack: string; }',
    argument: 'new Raised(value)',
    error: true,
  },
  {
    name: 'merged ordinary data stays data',
    source: 'interface Failure { stack: string } class Failure { stack = "fixed"; }',
    error: false,
  },
  {
    name: 'merged shadowed error type stays data',
    source: 'type Error = { stack: string }; interface Failure extends Error {} class Failure {}',
    error: false,
  },
  {
    name: 'merged cycle without error stays data',
    source:
      'interface Failure extends Other {} class Failure {} interface Other extends Failure {}',
    error: false,
  },
] as const;

describe('merged class interface error reader', () => {
  it.each(CASES)('$name', ({ source, error }) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'merged-interface.ts',
      `${source} function frames(error: Failure) { return error.stack; }`,
    );
    const pending: Node[] = [parsed.sourceFile];
    const reasons: string[] = [];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      const reason = framedRead(node);
      if (reason !== undefined) reasons.push(reason);
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(reasons.length > 0).toBe(error);
  });
});

describe('merged class interface actual shared admission', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$name', async (row) => {
    const { source, error } = row;
    const fallback = error ? 'new Error(value)' : '{ stack: value }';
    const argument = 'argument' in row ? row.argument : fallback;
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        'function frames(error: Failure): string { return error.stack ?? ""; }',
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(${argument})).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = error ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
