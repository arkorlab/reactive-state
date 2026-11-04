import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Mapper and own method bodies with quiet expression statements keep their returned values. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const OWN =
  'const values:{stack?:string}[]=[{stack:"fixed"}];let found:{stack?:string}={stack:"fixed"};';

const CASES: readonly Case[] = [
  {
    id: 'mapper-statement-replacement',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].map((value:Error|{stack:string})=>{value=error;return value;})[0]!.stack;}',
    refused: true,
  },
  {
    id: 'mapper-statement-slot',
    source:
      'function frames(error:Error){return[error].map((value)=>{const n=1;n;return value;})[0]!.stack;}',
    refused: true,
  },
  {
    id: 'flat-map-statement-replacement',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].flatMap((value:Error|{stack:string})=>{value=error;return[value];})[0]!.stack;}',
    refused: true,
  },
  {
    id: 'own-at-statement',
    source: `function frames(error:Error){${OWN}values.at=()=>{found=error;return found;};return values.at(0)!.stack;}`,
    refused: true,
  },
  {
    id: 'mapper-statement-effect-pin',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].map((value:Error|{stack:string})=>{value=error;Object.assign(value,{stack:"fixed"});return value;})[0]!.stack;}',
    refused: false,
  },
  {
    id: 'mapper-statement-data-pin',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].map((value:{stack:string})=>{value={stack:"other"};return value;})[0]!.stack;}',
    refused: false,
  },
  {
    id: 'own-at-effect-pin',
    source: `function frames(error:Error){${OWN}values.at=()=>{found=Object.assign(error,{stack:"fixed"});return found;};return values.at(0)!.stack;}`,
    refused: false,
  },
];

describe('callback statement readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'callback-statements.ts', source);
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

describe('shared callback statement admissions', () => {
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
