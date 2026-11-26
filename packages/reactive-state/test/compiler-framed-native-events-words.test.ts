import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'event-type',
    source: 'function frames(error:Error){return new Event(error as never).type;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'custom-event-type',
    source: 'function frames(error:Error){return new CustomEvent(error as never).type;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'event-constructor-alias',
    source:
      'const NativeEvent=Event;function frames(error:Error){return new NativeEvent(error as never).type;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'event-global-this',
    source: 'function frames(error:Error){return new globalThis.Event(error as never).type;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'event-local-shadow',
    source:
      'function frames(error:Error){class Event{readonly type="fixed";constructor(_value:unknown){}}return new Event(error).type;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'event-local-error',
    source: 'function frames(){return new Event(new Error("fixed")as never).type;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'event-options-not-text',
    source: 'function frames(error:Error){return new Event("fixed",error as never).type;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
];

describe('native events word readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-events-words.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});

describe('shared native events words', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
