import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Writes an array read or native copy evaluates in its own operands precede the slots it reads. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const DATA = 'const values:{stack?:string}[]=[{stack:"fixed"}];';
const PAIR = 'const values:{stack?:string}[]=[{stack:"fixed"},{stack:"fixed"}];';

const CASES: readonly Case[] = [
  {
    id: 'slice-argument-write',
    source: `${DATA}return values.slice((values[0]=error,0))[0]!.stack;`,
    refused: true,
  },
  {
    id: 'slice-end-argument-write',
    source: `${DATA}return values.slice(0,(values[0]=error,1))[0]!.stack;`,
    refused: true,
  },
  {
    id: 'borrowed-slice-argument-write',
    source: `${DATA}return(Array.prototype.slice.call(values,(values[0]=error,0))as{stack?:string}[])[0]!.stack;`,
    refused: true,
  },
  {
    id: 'concat-argument-write',
    source: `${DATA}return values.concat((values[0]=error,[]))[0]!.stack;`,
    refused: true,
  },
  {
    id: 'filter-this-argument-write',
    source: `${DATA}return values.filter(()=>true,(values[0]=error,undefined))[0]!.stack;`,
    refused: true,
  },
  {
    id: 'with-argument-write',
    source: `${PAIR}return values.with(1,(values[0]=error,{stack:"other"}))[0]!.stack;`,
    refused: true,
  },
  {
    id: 'slice-argument-push',
    source: `${DATA}return values.slice((values.push(error),1))[0]!.stack;`,
    refused: true,
  },
  {
    id: 'at-argument-write',
    source: `${DATA}return values.at((values[0]=error,0))!.stack;`,
    refused: true,
  },
  {
    id: 'index-key-write',
    source: `${DATA}return values[(values[0]=error,0)]!.stack;`,
    refused: true,
  },
  {
    id: 'join-separator-write',
    source: 'const values:unknown[]=["fixed"];return values.join((values[0]=error,","));',
    refused: true,
  },
  {
    id: 'later-selection-key-write-pin',
    source: `${DATA}return values.slice()[(values[0]=error,0)]!.stack;`,
    refused: false,
  },
  {
    id: 'receiver-rebinding-pin',
    source:
      'let values:{stack?:string}[]=[{stack:"fixed"}];return values.slice((values=[error],0))[0]!.stack;',
    refused: false,
  },
  {
    id: 'other-index-write-pin',
    source: `${PAIR}return values.slice(0,(values[1]=error,1))[0]!.stack;`,
    refused: false,
  },
  {
    id: 'skipped-and-write-pin',
    source: `${DATA}return values.slice(false&&(values[0]=error,0))[0]!.stack;`,
    refused: false,
  },
  {
    id: 'skipped-or-write-pin',
    source: `${DATA}return values.slice((1||(values[0]=error,1))-1)[0]!.stack;`,
    refused: false,
  },
  {
    id: 'unselected-conditional-write-pin',
    source: `${DATA}return values.slice(false?(values[0]=error,0):0)[0]!.stack;`,
    refused: false,
  },
  {
    id: 'later-join-write-pin',
    source: 'const values:unknown[]=["fixed"];return values.join(",")+(values[0]=error,"");',
    refused: false,
  },
];

describe('copy-time argument write readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'argument-writes.ts',
      `function frames(error:Error){${source}}`,
    );
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

describe('shared copy-time argument write admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        `function frames(error:Error){${source}}`,
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
