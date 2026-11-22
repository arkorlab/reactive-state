import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-written empty template types retain never before conditional branch selection. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-never-interpolation',
    source: `type Failure=\`\${never}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'never-with-head-and-tail',
    source: `type Failure=\`before\${never}after\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nonfinite-prefix-before-never',
    source: `type Failure=\`\${string}\${never}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nonfinite-suffix-after-never',
    source: `type Failure=\`\${never}\${string}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'number-prefix-before-never',
    source: `type Failure=\`\${number}-\${never}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-empty-nonfinite-template',
    source: `type Failure=\`\${\`\${string}\${never}\`}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-never-type-alias',
    source: `type Empty=never;type Failure=\`\${Empty}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-actual-never-template',
    source: `type Text<T extends string>=\`\${T}\`;type Failure=Text<never> extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'union-interpolation-has-literal',
    source: `type Failure=\`\${never|"fixed"}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-actual-union-is-nonempty',
    source: `type Text<T extends string>=\`\${T}\`;type Failure=Text<never|"fixed"> extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nonfinite-string-is-nonempty',
    source: `type Failure=\`\${string}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nonfinite-number-is-nonempty',
    source: `type Failure=\`\${number}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nonfinite-bigint-is-nonempty',
    source: `type Failure=\`\${bigint}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'boolean-is-nonempty',
    source: `type Failure=\`\${boolean}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'whole-any-template-is-nonempty',
    source: `type Failure=\`\${any}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'null-word-is-nonempty',
    source: `type Failure=\`\${null}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'undefined-word-is-nonempty',
    source: `type Failure=\`\${undefined}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'literal-word-is-nonempty',
    source: `type Failure=\`\${"fixed"}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'ordinary-nontemplate-literal-keeps-boundary',
    source: `type Failure="fixed" extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'native-extract-empty-span',
    source: `type Failure=\`\${Extract<string,number>}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'selected-empty-conditional-alias',
    source: `type Empty=string extends number?string:never;type Failure=\`\${Empty}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-return-type-empty-span',
    source: `type Failure=\`\${ReturnType<()=>never>}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-case-map-empty-span',
    source: `type Failure=\`\${Uppercase<never>}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-case-map-nonempty-span',
    source: `type Failure=\`\${Lowercase<string>}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nested-case-map-with-empty-template',
    source: `type Failure=\`\${Uppercase<\`\${string}\${never}\`>}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-case-map-name-keeps-written-meaning',
    source: `type Uppercase<T>="fixed";type Failure=\`\${Uppercase<never>}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'union-of-empty-templates',
    source: `type Failure=(\`\${never}\`|\`before\${never}\`) extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-template-union-has-fixed-literal',
    source: `type Failure=(\`\${never}\`|"fixed") extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unbound-local-span-may-be-never',
    source: `type Failure<T extends string>=\`\${T}\` extends never?Error:{stack:string};function frames<T extends string>(value:Failure<T>){return value.stack;}`,
    invocation: 'frames<never>(new Error("ours"))',
    refused: true,
  },
  {
    id: 'literal-arm-keeps-unbound-span-nonempty',
    source: `type Failure<T extends string>=\`\${T|"fixed"}\` extends never?Error:{stack:string};function frames<T extends string>(value:Failure<T>){return value.stack;}`,
    invocation: 'frames<never>({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'qualified-case-map-empty-span',
    source: `type Failure=\`\${globalThis.Uppercase<never>}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-exclude-empty-span',
    source: `type Failure=\`\${Exclude<"fixed","fixed">}\` extends never?Error:{stack:string};function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('template never readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'template-never.ts', source);
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

describe('shared template never admissions', () => {
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
