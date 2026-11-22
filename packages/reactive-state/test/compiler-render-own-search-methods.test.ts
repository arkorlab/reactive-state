import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const ONE_VALUE = '(_s:TemplateStringsArray,value:unknown)=>';
const ONE = `tag\`\${new Date(0)}\``;
const NULLISH = '(candidate:unknown)=>candidate===null';
const CONVERTS = '(candidate:unknown)=>String(candidate)==="x"';
const collectionClass = (body: string) => `class Collection{${body}}`;
const NULLISH_METHOD = 'includes(candidate:unknown){return candidate===null;}';

/**
 * A method the application writes under the name of a string method, called on what the code shows
 * holds it, is that method and not the language's: it converts its argument only if its own body
 * does, which the walk reads like any helper (`includes: (c) => c === null` answers a flag whatever
 * it is given, `includes: (c) => String(c) === 'x'` writes it as text). A method named as text's,
 * called on what the code does not show to be written, is read as the language's. A class's methods
 * are not followed (an instance of one, an inherited method, a static one), which refuses the call
 * as it did before: the walk that reads a called function as a helper does not follow class dispatch.
 */
interface Row {
  readonly id: string;
  readonly pre?: string;
  readonly tag: string;
  readonly local: string | undefined;
}

const CASES: readonly Row[] = [
  {
    id: 'own-arrow-in-an-object-literal',
    tag: `${ONE_VALUE}{const collection={includes:${NULLISH}};return collection.includes(value);}`,
    local: undefined,
  },
  {
    id: 'own-method-in-an-object-literal',
    tag: `${ONE_VALUE}{const collection={includes(candidate:unknown){return candidate===null;}};return collection.includes(value);}`,
    local: undefined,
  },
  {
    id: 'own-function-expression-in-an-object-literal',
    tag: `${ONE_VALUE}{const collection={includes:function(candidate:unknown){return candidate===null;}};return collection.includes(value);}`,
    local: undefined,
  },
  {
    id: 'own-arrow-stored-on-a-constant',
    tag: `${ONE_VALUE}{const has=${NULLISH};const collection={includes:has};return collection.includes(value);}`,
    local: undefined,
  },
  {
    id: 'own-function-declaration-stored-in-an-object-literal',
    tag: `${ONE_VALUE}{function has(candidate:unknown){return candidate===null;}const collection={includes:has};return collection.includes(value);}`,
    local: undefined,
  },
  {
    id: 'own-arrow-called-through-call',
    tag: `${ONE_VALUE}{const collection={includes:${NULLISH}};return collection.includes.call(collection,value);}`,
    local: undefined,
  },
  {
    id: 'own-arrow-called-through-apply',
    tag: `${ONE_VALUE}{const collection={includes:${NULLISH}};return collection.includes.apply(collection,[value]);}`,
    local: undefined,
  },
  ...[
    'startsWith',
    'endsWith',
    'indexOf',
    'lastIndexOf',
    'split',
    'search',
    'match',
    'matchAll',
  ].map((method) => {
    return {
      id: `own-${method}-in-an-object-literal`,
      tag: `${ONE_VALUE}{const collection={${method}:${NULLISH}};return collection.${method}(value);}`,
      local: undefined,
    };
  }),
  ...[
    ['replace', 'value'],
    ['concat', 'value'],
    ['padStart', '0,value'],
  ].map(([method, args]) => {
    return {
      id: `own-${method}-in-an-object-literal`,
      tag: `${ONE_VALUE}{const collection={${method}:${NULLISH}};return collection.${method}(${args});}`,
      local: undefined,
    };
  }),
  {
    id: 'class-instance-method-is-refused-pin',
    pre: collectionClass(NULLISH_METHOD),
    tag: `${ONE_VALUE}{const collection=new Collection();return collection.includes(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-inherited-method-is-refused-pin',
    pre: `class Base{${NULLISH_METHOD}}class Collection extends Base{}`,
    tag: `${ONE_VALUE}{const collection=new Collection();return collection.includes(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-static-method-is-refused-pin',
    pre: collectionClass(`static ${NULLISH_METHOD}`),
    tag: `${ONE_VALUE}{return Collection.includes(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'own-method-that-writes-its-argument-as-text',
    tag: `${ONE_VALUE}{const collection={includes:${CONVERTS}};return collection.includes(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'own-method-in-an-object-literal-that-writes-its-argument-as-text',
    tag: `${ONE_VALUE}{const collection={includes(candidate:unknown){return \`\${candidate}\`==='x';}};return collection.includes(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'own-method-that-searches-a-text-for-its-argument',
    tag: `${ONE_VALUE}{const collection={includes:(candidate:unknown)=>'abc'.includes(candidate as string)};return collection.includes(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'own-replace-that-writes-its-argument-as-text',
    tag: `${ONE_VALUE}{const collection={replace:${CONVERTS}};return collection.replace(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'native-text-in-a-constant',
    tag: `${ONE_VALUE}{const text='abc';return text.includes(value as string);}`,
    local: DATE_TEXT,
  },
  {
    id: 'native-text-literal',
    tag: `${ONE_VALUE}'abc'.includes(value as string)`,
    local: DATE_TEXT,
  },
  {
    id: 'native-text-borrowed-from-the-prototype',
    tag: `${ONE_VALUE}String.prototype.includes.call('abc',value)`,
    local: DATE_TEXT,
  },
  {
    id: 'object-holder-without-the-method-is-refused-pin',
    tag: `${ONE_VALUE}{const collection={has:${NULLISH}};return (collection as unknown as string).includes(value as string);}`,
    local: DATE_TEXT,
  },
  {
    id: 'mutable-holder-is-refused-pin',
    tag: `${ONE_VALUE}{let collection={includes:${NULLISH}};return collection.includes(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'holder-written-after-the-call-is-refused-pin',
    tag: `${ONE_VALUE}{const collection:{includes:(candidate:unknown)=>boolean}={includes:${NULLISH}};collection.includes=String.prototype.includes as never;return collection.includes(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'own-method-that-names-this',
    tag: `${ONE_VALUE}{const collection={items:[1],includes(candidate:unknown){return this.items.length>0&&candidate===null;}};return collection.includes(value);}`,
    local: undefined,
  },
  {
    id: 'own-method-that-names-this-and-writes-its-argument-as-text',
    tag: `${ONE_VALUE}{const collection={items:[1],includes(candidate:unknown){return this.items.length>0&&String(candidate)==='x';}};return collection.includes(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'imported-holder-is-refused-pin',
    tag: `${ONE_VALUE}importedCollection.includes(value)`,
    local: DATE_TEXT,
  },
  {
    id: 'direct-class-instance-is-refused-pin',
    pre: collectionClass(NULLISH_METHOD),
    tag: `${ONE_VALUE}{return new Collection().includes(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'array-of-text-is-refused-pin',
    tag: `${ONE_VALUE}{const names=['a'];return names.includes(value as string);}`,
    local: DATE_TEXT,
  },
];

describe('a method the application writes under the name of a string method', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ pre = '', tag, local }) => {
    const source = `import { importedCollection } from './collection';${pre}export function Widget(){const tag=${tag};return <p>{${ONE}}</p>;}`;

    expect(firstLocalInput(api, source)).toBe(local);
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-own-search-methods.tsx', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const found = renderLocalInput(node);
    if (found !== undefined) return found;
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return undefined;
}
