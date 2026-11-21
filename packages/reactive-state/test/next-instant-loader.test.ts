import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const instantLoader = createRequire(import.meta.url)('../src/next/loader-instant.cjs') as (
  source: string,
) => string;

/** Only actual module value exports suppress the blocking page permission. */
const CASES = [
  {
    id: 'reported-jsx-export-text',
    source:
      'export default async function Page({params}:{params:Promise<{id:string}>}){const{id}=await params;return <p>export const instant = true{id}</p>;}\n',
    unchanged: false,
  },
  {
    id: 'jsx-export-list-text',
    source: 'export default()=> <p>export { blocking as instant }</p>;\n',
    unchanged: false,
  },
  {
    id: 'multiline-jsx-export-text',
    source: 'export default()=> <p>export\nconst\ninstant = true</p>;\n',
    unchanged: false,
  },
  {
    id: 'nested-jsx-export-text',
    source: 'export default()=> <section><p>export const instant = true</p></section>;\n',
    unchanged: false,
  },
  {
    id: 'same-line-jsx-quote-real-export',
    source:
      "const note=<p>Don't</p>;export const instant=true;\nexport default async function Page(){return null;}\n",
    unchanged: true,
  },
  {
    id: 'jsx-expression-string',
    source: "export default()=> <p>{'export const instant = true'}</p>;\n",
    unchanged: false,
  },
  {
    id: 'jsx-attribute-string',
    source: 'export default()=> <p title="export const instant = true">fixed</p>;\n',
    unchanged: false,
  },
  {
    id: 'ordinary-string',
    source:
      "const note='export const instant = true';\nexport default async function Page(){return null;}\n",
    unchanged: false,
  },
  {
    id: 'block-comment',
    source:
      '/*export const instant = true;*/\nexport default async function Page(){return null;}\n',
    unchanged: false,
  },
  {
    id: 'regular-expression',
    source:
      'const note=/export const instant = true/u;\nexport default async function Page(){return null;}\n',
    unchanged: false,
  },
  {
    id: 'template-text',
    source:
      'const note=`export const instant = true`;\nexport default async function Page(){return null;}\n',
    unchanged: false,
  },
  {
    id: 'real-typed-const',
    source:
      'export const instant:boolean=true;\nexport default async function Page(){return null;}\n',
    unchanged: true,
  },
  {
    id: 'real-value-export-alias',
    source:
      'const blocked=false;export {blocked as instant};\nexport default async function Page(){return null;}\n',
    unchanged: true,
  },
  {
    id: 'inline-type-only-export',
    source:
      'type instant=boolean;export {type instant};\nexport default async function Page(){return null;}\n',
    unchanged: false,
  },
  {
    id: 'whole-type-only-export',
    source:
      'type instant=boolean;export type {instant};\nexport default async function Page(){return null;}\n',
    unchanged: false,
  },
  {
    id: 'real-let-export',
    source: 'export let instant=false;\nexport default async function Page(){return null;}\n',
    unchanged: true,
  },
  {
    id: 'real-following-declarator',
    source:
      'export const other=1,instant=true;\nexport default async function Page(){return null;}\n',
    unchanged: true,
  },
  {
    id: 'typescript-angle-assertion',
    source:
      'const value=<boolean>true;export const instant=value;\nexport default async function Page(){return null;}\n',
    unchanged: true,
  },
] as const;

describe('blocking page instant module exports', () => {
  it.each(CASES)('$id', ({ source, unchanged }) => {
    const expected = unchanged ? source : `${source}\nexport const instant = false;\n`;

    expect(instantLoader(source)).toBe(expected);
  });
});
