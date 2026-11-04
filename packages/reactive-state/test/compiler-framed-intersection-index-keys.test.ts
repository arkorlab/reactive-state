import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Finite intersection index keys retain their written set meaning and original type environments. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

const CASES: readonly Case[] = [
  {
    id: 'alias-narrows-to-data',
    source:
      "type Data={stack:string};type Fields='failure'|'caption';type Box={failure:Error;caption:Data;label:Data};type Keys=Fields&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'reverse-intersection-data',
    source:
      "type Data={stack:string};type Fields='failure'|'caption';type Box={failure:Error;caption:Data;label:Data};type Keys='caption'&Fields;type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'direct-written-data',
    source:
      "type Data={stack:string};type Box={failure:Error;caption:Data;label:Data};type Keys=('failure'|'caption')&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'narrowed-error-control',
    source:
      "type Data={stack:string};type Fields='failure'|'caption';type Box={failure:Error;caption:Data;label:Data};type Keys=Fields&'failure';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shared-error-alternative',
    source:
      "type Data={stack:string};type Box={failure:Error;caption:Data;label:Data};type Keys=('failure'|'caption')&('failure'|'caption');type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-finite-intersections',
    source:
      "type Data={stack:string};type Fields='failure'|'caption'|'label';type Box={failure:Error;caption:Data;label:Data};type Keys=(Fields&('caption'|'label'))&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'union-of-narrowed-data',
    source:
      "type Data={stack:string};type Box={failure:Error;caption:Data;label:Data};type Keys=(('failure'|'caption')&'caption')|(('failure'|'label')&'label');type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'repeated-alias-occurrences',
    source:
      "type Data={stack:string};type Fields='failure'|'caption';type Box={failure:Error;caption:Data;label:Data};type Keys=Fields&Fields&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'numeric-intersection-data',
    source:
      'type Data={stack:string};type Box={0:Error;1:Data};type Keys=(0|1)&1;type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'numeric-error-control',
    source:
      'type Data={stack:string};type Box={0:Error;1:Data};type Keys=(0|1)&0;type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'negative-numeric-data',
    source:
      'type Data={stack:string};type Box={[-1]:Data;0:Error};type Keys=(-1|0)&-1;type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'negative-zero-data',
    source:
      'type Data={stack:string};type Box={0:Data;1:Error};type Keys=(0|1)&-0;type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'same-property-distinct-type-string',
    source:
      "type Data={stack:string};type Box={1:Data};type Keys=(1|'1')&'1';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'same-property-distinct-type-number',
    source:
      "type Data={stack:string};type Box={1:Data};type Keys=(1|'1')&1;type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'finite-template-data',
    source: `type Data={stack:string};type Fields=\`cap\${'tion'|'ture'}\`;type Box={caption:Data;capture:Error};type Keys=Fields&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'template-intersection-error',
    source: `type Data={stack:string};type Fields=\`cap\${'tion'|'ture'}\`;type Box={caption:Data;capture:Error};type Keys=Fields&'capture';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'concrete-generic-data',
    source:
      "type Data={stack:string};type Fields='failure'|'caption';type Shape<T>={failure:Error;caption:T};type Box=Shape<Data>;type Keys=Fields&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'concrete-generic-error',
    source:
      "type Data={stack:string};type Fields='failure'|'caption';type Shape<T>={failure:Error;caption:T};type Box=Shape<Error>;type Keys=Fields&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'defaulted-index-alias',
    source:
      "type Data={stack:string};type Fields='failure'|'caption';type Narrow<T='caption'>=Fields&T;type Box={failure:Error;caption:Data;label:Data};type Keys=Narrow;type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nested-actual-key-alias',
    source:
      "type Data={stack:string};type Fields='failure'|'caption';type Wrap<A>=Fields&A;type Narrow<B>=Wrap<B>;type Box={failure:Error;caption:Data;label:Data};type Keys=Narrow<'caption'>;type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'object-union-error-control',
    source:
      "type Data={stack:string};type Box={failure:Error;caption:Data}|{failure:Data;caption:Error};type Keys=('failure'|'caption')&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-record-projection',
    source:
      "type Data={stack:string};type Fields='failure'|'caption';type Box=Record<Fields,Data>;type Keys=Fields&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'native-pick-projection',
    source:
      "type Data={stack:string};type Fields='failure'|'caption';type Shape={failure:Error;caption:Data};type Box=Pick<Shape,Fields>;type Keys=Fields&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'local-error-shadow-data',
    source:
      "type Data={stack:string};type Error=Data;type Fields='failure'|'caption';type Box={failure:Error;caption:Data;label:Data};type Keys=Fields&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plain-union-existing-error-pin',
    source:
      "type Data={stack:string};type Box={failure:Error;caption:Data;label:Data};type Keys='failure'|'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plain-literal-existing-data-pin',
    source:
      "type Data={stack:string};type Box={failure:Error;caption:Data;label:Data};type Keys='caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'broad-index-existing-opacity-pin',
    source:
      "type Data={stack:string};type Fields=string;type Box={failure:Error;caption:Data;label:Data};type Keys=Fields&'caption';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unbound-outer-index-existing-boundary',
    source:
      "type Data={stack:string};type Box={failure:Error;caption:Data;label:Data};function frames<K extends 'failure'|'caption'>(value:Box[K&'caption']){return value.stack;}",
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'imported-key-existing-boundary',
    source:
      'type Data={stack:string};type Fields=import("./external.js").Fields;type Box={failure:Error;caption:Data;label:Data};type Keys=Fields&\'caption\';type Raw=Box[Keys];type Failure=Raw;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
    files: {
      'domain/external.ts': 'export type Fields="failure"|"caption";',
    },
  },
];

describe('intersection index key readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'intersection-index-keys.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('shared intersection index key admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, files }) => {
    const app = await application({
      ...files,
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
