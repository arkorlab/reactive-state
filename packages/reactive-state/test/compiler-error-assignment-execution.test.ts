import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Assignment results and referenced local writers retain their actual receiver possibilities. */
const CASES = [
  {
    id: 'assignment-native-error',
    source: 'function read(){let value;return (value=new Error("ours")).stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    id: 'assignment-supplied-error',
    source: 'function read(error:Error){let value;return (value=error).stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assignment-right-data',
    source: 'function read(){let value=new Error("ours");return (value={stack:"fixed"}).stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'assignment-local-error-words',
    source: 'function read(){let value;return (value=new Error("ours")).message;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'assignment-custom-error-data',
    source:
      'class Error {stack="fixed";} function read(){let value;return (value=new Error()).stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'unreferenced-local-writer',
    source:
      'function read(){let value:{stack?:string}={};function unused(){value=new Error("ours");}return value.stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'called-local-writer',
    source:
      'function read(){let value:{stack?:string}={};function change(){value=new Error("ours");}change();return value.stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    id: 'referenced-local-writer',
    source:
      'function read(){let value:{stack?:string}={};function change(){value=new Error("ours");}const run=change;run();return value.stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    id: 'unreferenced-shadowed-local-writer',
    source:
      'function read(){let value:{stack?:string}={};function change(){value=new Error("ours");}{function change(){}change();}return value.stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'called-overloaded-local-writer',
    source:
      'function read(){let value:{stack?:string}={};function change():void;function change(){value=new Error("ours");}change();return value.stack;}',
    invocation: 'read()',
    refused: true,
  },
] as const;

describe('assignment and local execution error readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'assignment-execution.ts', source);
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

describe('shared assignment and local execution error receivers', () => {
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
    const sharedReason = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [sharedReason] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
