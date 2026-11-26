import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
const CASES = [
  {
    group: 'captured',
    id: 'outer-after-read',
    source:
      'function frames(error:Error){let last:{stack?:string}={stack:"fixed"};function step(){const result=last.stack??"";last=error;return result;}step();return step();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'captured',
    id: 'outer-arrow-after-read',
    source:
      'function frames(error:Error){let last:{stack?:string}={stack:"fixed"};const step=()=>{const result=last.stack??"";last=error;return result;};step();return step();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'captured',
    id: 'local-reinitialized',
    source:
      'function frames(error:Error){function step(){let last:{stack?:string}={stack:"fixed"};const result=last.stack??"";last=error;return result;}step();return step();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'captured',
    id: 'captured-data-write',
    source:
      'function frames(error:Error){let last:{stack?:string}={stack:"fixed"};function step(){const result=last.stack??"";last={stack:"data"};return result;}step();return step();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'captured',
    id: 'captured-false-write',
    source:
      'function frames(error:Error){let last:{stack?:string}={stack:"fixed"};function step(){const result=last.stack??"";if(false)last=error;return result;}step();return step();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'captured',
    id: 'captured-reset-before-read',
    source:
      'function frames(error:Error){let last:{stack?:string}={stack:"fixed"};function step(){last={stack:"data"};const result=last.stack??"";last=error;return result;}step();return step();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'field',
    id: 'instance-after-class',
    source:
      'function frames(error:Error){let last:{stack?:string}={stack:"fixed"};class Holder{result=last.stack??"";}last=error;return new Holder().result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'field',
    id: 'instance-field-closure',
    source:
      'function frames(error:Error){let last:{stack?:string}={stack:"fixed"};class Holder{result=last.stack??"";}const create=()=>new Holder();last=error;return create().result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'field',
    id: 'instance-data',
    source:
      'function frames(error:Error){let last:{stack?:string}={stack:"fixed"};class Holder{result=last.stack??"";}last={stack:"data"};return new Holder().result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'field',
    id: 'static-field-before-write',
    source:
      'function frames(error:Error){let last:{stack?:string}={stack:"fixed"};class Holder{static result=last.stack??"";}last=error;return Holder.result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'field',
    id: 'computed-field-name-before-write',
    source:
      'function frames(error:Error){let last:{stack?:string}={stack:"fixed"};class Holder{[last.stack??"fixed"]="data";}last=error;return new Holder()["fixed"];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'forof',
    id: 'forof-direct',
    source:
      'function frames(error:Error){let value:{stack?:string}={stack:"fixed"};for(value of [error])return value.stack??"";return "";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'forof',
    id: 'forof-object-pattern',
    source:
      'function frames(error:Error){let value:{stack?:string}={stack:"fixed"};for({item:value}of [{item:error}])return value.stack??"";return "";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'forof',
    id: 'forof-array-pattern',
    source:
      'function frames(error:Error){let value:{stack?:string}={stack:"fixed"};for([value]of [[error]])return value.stack??"";return "";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'forof',
    id: 'forof-data',
    source:
      'function frames(error:Error){let value:{stack?:string}={stack:"fixed"};for(value of [{stack:"data"}])return value.stack??"";return "";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'forof',
    id: 'forof-shadow',
    source:
      'function frames(error:Error){let value:{stack?:string}={stack:"fixed"};for(const value of [error]){void value;}return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'forof',
    id: 'forof-empty',
    source:
      'function frames(error:Error){let value:{stack?:string}={stack:"fixed"};for(value of [])return value.stack??"";return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'forof',
    id: 'forof-false-branch',
    source:
      'function frames(error:Error){let value:{stack?:string}={stack:"fixed"};if(false){for(value of [error])return value.stack??"";}return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
] as const;

describe('source-written writes readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'source-writes.ts', source);
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

describe('source-written writes shared modules', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const refusal = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [refusal] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
