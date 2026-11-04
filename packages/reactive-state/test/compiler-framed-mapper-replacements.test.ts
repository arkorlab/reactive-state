import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A native mapper returns what its body writes into its first parameter, not only its source slot. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'replacement-review',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].map((value:Error|{stack:string})=>{const ignored=(value=error);return value;})[0]!.stack;}',
    refused: true,
  },
  {
    id: 'replacement-message',
    source:
      'function frames(error:Error){return[{message:"fixed"}].map((value:Error|{message:string})=>{const ignored=(value=error);return value;})[0]!.message;}',
    refused: true,
  },
  {
    id: 'replacement-pattern-name',
    source:
      'function frames(error:Error){return[{failure:{stack:"fixed"}}].map(({failure}:{failure:Error|{stack:string}})=>{const ignored=(failure=error);return failure;})[0]!.stack;}',
    refused: true,
  },
  {
    id: 'replacement-flat-map',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].flatMap((value:Error|{stack:string})=>{const ignored=(value=error);return[value];})[0]!.stack;}',
    refused: true,
  },
  {
    id: 'replacement-mapper-alias',
    source:
      'function frames(error:Error){const mapping=(value:Error|{stack:string})=>{const ignored=(value=error);return value;};return[{stack:"fixed"}].map(mapping)[0]!.stack;}',
    refused: true,
  },
  {
    id: 'replacement-reverse-pin',
    source:
      'function frames(error:Error){return[error].map((value:Error|{stack:string})=>{const ignored=(value={stack:"fixed"});return value;})[0]!.stack;}',
    refused: true,
  },
  {
    id: 'replacement-later-effect-pin',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].map((value:Error|{stack:string})=>{const ignored=(value=error);Object.assign(value,{stack:"fixed"});return value;})[0]!.stack;}',
    refused: false,
  },
  {
    id: 'replacement-after-return-pin',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].map((value:Error|{stack:string})=>{return value;value=error;})[0]!.stack;}',
    refused: false,
  },
  {
    id: 'replacement-data-pin',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].map((value:{stack:string})=>{const ignored=(value={stack:"other"});return value;})[0]!.stack;}',
    refused: false,
  },
  {
    id: 'replacement-local-words-pin',
    source:
      'function frames(error:Error){return[{message:"fixed"}].map((value:Error|{message:string})=>{const ignored=(value=new Error("fixed"));return value;})[0]!.message;}',
    refused: false,
  },
  {
    id: 'replacement-prior-exposure-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return[{stack:"fixed"}].map((value:Error|{stack:string})=>{const ignored=(value=error);return value;})[0]!.stack;}',
    refused: false,
  },
  {
    id: 'replacement-saved-result-pin',
    source:
      'function frames(error:Error){const values=[{stack:"fixed"}].map((value:Error|{stack:string})=>{const ignored=(value=error);return value;});Object.assign(error,{stack:"fixed"});return values[0]!.stack;}',
    refused: false,
  },
];

describe('mapper parameter replacement readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'mapper-replacements.ts', source);
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

describe('shared mapper parameter replacement admissions', () => {
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
