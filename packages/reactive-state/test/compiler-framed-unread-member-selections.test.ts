import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A literal selection keeps the value of a member whose computed name the reader cannot read, and
 * heritage stays possible past a signature or such a member.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-member-key-literal',
    source:
      "const Names={failure:'failure',other:'other'} as const;type Bag={[Names.failure]:Error;caption:{stack:string}};function frames(value:Bag['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'interface-member-key-literal',
    source:
      "const Names={failure:'failure',other:'other'} as const;interface Shape{[Names.failure]:Error;caption:{stack:string}}function frames(value:Shape['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-unread-member',
    source:
      "const Names={failure:'failure',other:'other'} as const;interface Base{[Names.failure]:Error}interface Derived extends Base{caption:{stack:string}}function frames(value:Derived['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'indexed-over-unread-base',
    source:
      "const Names={failure:'failure',other:'other'} as const;interface Base{[Names.failure]:Error}interface Indexed extends Base{[key:string]:unknown}function frames(value:Indexed['failure']){return (value as {stack?:string}).stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'indexed-over-named-base',
    source:
      "interface NamedBase{failure:Error}interface NamedIndexed extends NamedBase{[key:string]:unknown}function frames(value:NamedIndexed['failure']){return (value as {stack?:string}).stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-unread-member',
    source:
      "const Names={failure:'failure',other:'other'} as const;interface Merged{caption:{stack:string}}interface Merged{[Names.failure]:Error}function frames(value:Merged['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'signed-unread-member',
    source:
      "const Names={failure:'failure',other:'other'} as const;type Signed={[Names.failure]:Error;[key:string]:Error|{stack:string}};function frames(value:Signed['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'picked-unread-member',
    source:
      "const Names={failure:'failure',other:'other'} as const;type Bag={[Names.failure]:Error;caption:{stack:string}};function frames(value:Pick<Bag,'failure'>['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-unread-beside-named-base',
    source:
      "const Names={failure:'failure',other:'other'} as const;interface NamedBase{failure:Error}interface OwnUnread extends NamedBase{[Names.other]:string}function frames(value:OwnUnread['failure']){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-caption-data',
    source:
      "const Names={failure:'failure',other:'other'} as const;type Bag={[Names.failure]:Error;caption:{stack:string}};function frames(value:Bag['caption']){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'derived-caption-data',
    source:
      "const Names={failure:'failure',other:'other'} as const;interface Base{[Names.failure]:Error}interface Derived extends Base{caption:{stack:string}}function frames(value:Derived['caption']){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'iterator-method-data',
    source:
      "type Iterable={[Symbol.iterator]():Iterator<string>;caption:{stack:string}};function frames(value:Iterable['caption']){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'signed-data-other',
    source:
      "const Names={failure:'failure',other:'other'} as const;type SignedData={[Names.failure]:{stack:string};[key:string]:{stack:string}};function frames(value:SignedData['other']){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('unread member literal selection readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'unread-member-selections.ts', source);
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

describe('shared unread member literal selection admissions', () => {
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
