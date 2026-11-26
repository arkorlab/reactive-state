import { writeFileSync } from 'node:fs';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'reported-arithmetic',
    source:
      'const state=1+2;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'subtraction',
    source:
      'const state=4-1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'multiplication',
    source:
      'const state=2*3;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'division',
    source:
      'const state=6/2;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'remainder',
    source:
      'const state=7%3;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'exponentiation',
    source:
      'const state=2**3;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'comparison-less',
    source:
      'const state=1<2;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'comparison-less-equal',
    source:
      'const state=1<=2;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'comparison-greater',
    source:
      'const state=2>1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'comparison-greater-equal',
    source:
      'const state=2>=1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'equality',
    source:
      'const state=1===1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'loose-equality',
    source:
      'const state=1==1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'inequality',
    source:
      'const state=Number("1")!==Number("2");export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'loose-inequality',
    source:
      'const state=Number("1")!=Number("2");export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'string-concatenation',
    source:
      'const state="fixed"+" value";export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'mixed-concatenation',
    source:
      'const state="n"+3;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'bitwise-and',
    source:
      'const state=3&1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'bitwise-or',
    source:
      'const state=3|1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'bitwise-xor',
    source:
      'const state=3^1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'left-shift',
    source:
      'const state=4<<1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'right-shift',
    source:
      'const state=8>>1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'unsigned-shift',
    source:
      'const state=8>>>1;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'bigint-addition',
    source:
      'const state=1n+2n;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'bigint-comparison',
    source:
      'const state=1n<2n;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'in-predicate',
    source:
      'const state="a" in {a:1};export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'wrapped-binary',
    source:
      'const state=((1+2)as number);export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'nonfinite-result',
    source:
      'const state=1/0;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'alias-chain-arithmetic',
    source:
      'const state=1+2;const middle=state;export function caption(value:string){const alias=middle;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'literal-number-pin',
    source:
      'const state=3;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'literal-string-pin',
    source:
      'const state="fixed";export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'native-nan-pin',
    source:
      'const state=NaN;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'native-infinity-pin',
    source:
      'const state=Infinity;export function caption(value:string){const alias=state;Object.freeze(alias);return value+String(alias);}',
    shared: true,
    invocation: 'caption("input")',
  },
  {
    id: 'logical-and-object',
    source:
      'const retained={banner:"held"};const state=true&&retained;export function caption(value:string){const alias=state;Object.freeze(alias);return value;}',
    shared: false,
    invocation: 'caption("input")',
  },
  {
    id: 'logical-or-object',
    source:
      'const retained={banner:"held"};const state=false||retained;export function caption(value:string){const alias=state;Object.freeze(alias);return value;}',
    shared: false,
    invocation: 'caption("input")',
  },
  {
    id: 'nullish-object',
    source:
      'const retained={banner:"held"};const state=retained??{banner:"other"};export function caption(value:string){const alias=state;Object.freeze(alias);return value;}',
    shared: false,
    invocation: 'caption("input")',
  },
  {
    id: 'conditional-object',
    source:
      'const retained={banner:"held"};const state=true?retained:{banner:"other"};export function caption(value:string){const alias=state;Object.freeze(alias);return value;}',
    shared: false,
    invocation: 'caption("input")',
  },
  {
    id: 'direct-object',
    source:
      'const retained={banner:"held"};const state=retained;export function caption(value:string){const alias=state;Object.freeze(alias);return value;}',
    shared: false,
    invocation: 'caption("input")',
  },
  {
    id: 'assignment-result-object',
    source:
      'const retained={banner:"held"};let target:{banner:string};const state=(target=retained);export function caption(value:string){const alias=state;Object.freeze(alias);return value;}',
    shared: false,
    invocation: 'caption("input")',
  },
  {
    id: 'own-valueOf-object-pin',
    source:
      'const state={valueOf(){return 3;}};export function caption(value:string){const alias=state;Object.freeze(alias);return value;}',
    shared: false,
    invocation: 'caption("input")',
  },
  {
    id: 'same-name-object-shadow-pin',
    source:
      'const state=1+2;export function caption(value:string){const state={banner:"fresh"};const alias=state;Object.freeze(alias);return value;}',
    shared: true,
    invocation: 'caption("input")',
  },
] as const;

describe('primitive expression aliases preserve value semantics', () => {
  it.each(CASES)('$id', ({ source, shared }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'kept-primitive-expressions.ts', source);

    expect(unsettledIn(parsed.sourceFile) !== undefined).toBe(!shared);
  });
});

describe('shared primitive-expression constant aliases', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_ALIAS_OBSERVATIONS'];
    if (file !== undefined) writeFileSync(file, JSON.stringify(observations, null, 2));
    api[Symbol.dispose]();
    await Promise.all(apps.map(async (app) => removed(app)));
  });

  it.each(CASES)('$id', async ({ id, source, shared }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        "export function normalizeFilter(value:string):TodoFilter{return String(caption(value)).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compiledApp(app, api).refusals.map((item) => item.reason);
    observations.push({ id, source, expectedRefused: !shared, reasons });
    const refused = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(shared ? [] : [refused]);
  });
});
