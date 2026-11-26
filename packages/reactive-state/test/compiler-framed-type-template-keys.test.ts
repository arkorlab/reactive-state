import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Finite template index keys retain each span and selected member in their original type environments. */
const CASES = [
  {
    id: 'single-template-error',
    source: `type Key=\`fail\${"ure"}\`;type Failure={failure:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'direct-template-error',
    source: `type Failure={failure:Error}[\`fail\${"ure"}\`];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'union-span-template-error',
    source: `type Key=\`fail\${"ure"|"ureAgain"}\`;type Failure={failure:Error,failureAgain:{stack:string}}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'multi-span-template-error',
    source: `type Key=\`f\${"ai"}\${"l"}\${"ure"}\`;type Failure={failure:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'aliased-span-template-error',
    source: `type Suffix="ure";type Key=\`fail\${Suffix}\`;type Failure={failure:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'generic-span-template-error',
    source: `type Key<T extends string>=\`fail\${T}\`;type Failure={failure:Error}[Key<"ure">];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'nested-template-error',
    source: `type Suffix<T extends string>=\`\${T}re\`;type Key=\`fai\${Suffix<"lu">}\`;type Failure={failure:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'decreasing-template-alias-error',
    source: `type Key<T extends string>=\`\${T}\`;type Failure={failure:Error}[Key<Key<"failure">>];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'numeric-span-template-error',
    source: `type Key=\`failure\${1}\`;type Failure={failure1:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'boolean-span-template-error',
    source: `type Key=\`failure\${true}\`;type Failure={failuretrue:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'boolean-domain-template-error',
    source: `type Key=\`failure\${boolean}\`;type Failure={failuretrue:Error,failurefalse:{stack:string}}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'bigint-span-template-error',
    source: `type Key=\`failure\${1n}\`;type Failure={failure1:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'negative-bigint-span-template-error',
    source: `type Key=\`failure\${-1n}\`;type Failure={"failure-1":Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'null-span-template-error',
    source: `type Key=\`failure\${null}\`;type Failure={failurenull:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'undefined-span-template-error',
    source: `type Key=\`failure\${undefined}\`;type Failure={failureundefined:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'record-template-index-error',
    source: `type Key=\`fail\${"ure"}\`;type Failure=Record<Key,Error>[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'template-array-index-error',
    source: `type Failure=[{stack:string},Error][\`\${1}\`];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'selected-template-data-pin',
    source: `type Key=\`da\${"ta"}\`;type Failure={failure:Error,data:{stack:string}}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'generic-selected-data-pin',
    source: `type Key<T extends string>=\`\${T}\`;type Failure={failure:Error,data:{stack:string}}[Key<"data">];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'nested-selected-data-pin',
    source: `type Key<T extends string>=\`\${T}\`;type Failure={failure:Error,data:{stack:string}}[Key<Key<"data">>];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'union-selected-data-pin',
    source: `type Key=\`d\${"ata"|"ataAgain"}\`;type Failure={failure:Error,data:{stack:string},dataAgain:{stack:string}}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'numeric-data-pin',
    source: `type Key=\`\${0}\`;type Failure=[{stack:string},Error][Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'boolean-data-pin',
    source: `type Key=\`failure\${false}\`;type Failure={failuretrue:Error,failurefalse:{stack:string}}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'shadow-error-template-data-pin',
    source: `type Error={stack:string};type Key=\`fail\${"ure"}\`;type Failure={failure:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'literal-index-error-pin',
    source:
      'type Failure={failure:Error}["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours") as Failure)',
    refused: true,
  },
  {
    id: 'literal-index-data-pin',
    source:
      'type Failure={failure:Error,data:{stack:string}}["data"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"} as Failure)',
    refused: false,
  },
  {
    id: 'opaque-nonfinite-data-pin',
    source: `type Key=\`data\${string}\`;type Failure=Record<string,{stack:string}>[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'opaque-mixed-span-data-pin',
    source: `type Key=\`data\${0|number}\`;type Failure=Record<\`data\${number}\`,{stack:string}>[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'negative-zero-bigint-data-pin',
    source: `type Key=\`failure\${-0n}\`;type Failure={failure0:{stack:string},"failure-0":Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'hexadecimal-bigint-template-error',
    source: `type Key=\`failure\${0x10n}\`;type Failure={failure16:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'separated-numeric-template-error',
    source: `type Key=\`failure\${1_000}\`;type Failure={failure1000:Error}[Key];function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('finite template index readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'template-key-observations.ts', source);
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

describe('shared finite template index admissions', () => {
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
