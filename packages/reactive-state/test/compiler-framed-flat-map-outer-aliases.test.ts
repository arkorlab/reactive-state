import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A flatMap mapper returning an outer array alias flattens that array's own elements. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'flat-map-outer-alias',
    source:
      'function frames(error:Error){const items=[error];return[0].flatMap(()=>items)[0]!.stack;}',
    refused: true,
  },
  {
    id: 'flat-map-outer-alias-words',
    source:
      'function frames(error:Error){const items=[error];return[0].flatMap(()=>items)[0]!.message;}',
    refused: true,
  },
  {
    id: 'flat-map-outer-alias-second',
    source:
      'function frames(error:Error){const items=[{stack:"fixed"},error];return[0].flatMap(()=>items)[1]!.stack;}',
    refused: true,
  },
  {
    id: 'flat-map-outer-alias-data-pin',
    source:
      'function frames(error:Error){const items=[{stack:"fixed"},error];return[0].flatMap(()=>items)[0]!.stack;}',
    refused: false,
  },
  {
    id: 'flat-map-outer-data-alias-pin',
    source:
      'function frames(error:Error){const items=[{stack:"fixed"}];return[error].flatMap(()=>items)[0]!.stack;}',
    refused: false,
  },
  {
    id: 'flat-map-shadowed-parameter-pin',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).flatMap((error)=>[error])[0]!.stack;}',
    refused: false,
  },
  {
    id: 'flat-map-input-parameter-pin',
    source: 'function frames(error:Error){return[error].flatMap((value)=>[value])[0]!.stack;}',
    refused: true,
  },
];

describe('flatMap outer alias readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'flat-map-aliases.ts', source);
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

describe('shared flatMap outer alias admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
