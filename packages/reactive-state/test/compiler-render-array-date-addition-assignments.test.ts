import { isBinaryExpression } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native array addition assignments retain original operand evaluation and local target guards. */
const CASES = [
  {
    id: 'reported-let-right-array',
    source: "export function Widget(){let text='';text += [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text='';text += [new Date(0)];return String(text);}",
    native: 'zone',
    owner: true,
  },
  {
    id: 'let-prefix-right-array',
    source:
      "export function Widget(){let text='instant: ';text += [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text='instant: ';text += [new Date(0)];return String(text);}",
    native: 'zone',
    owner: true,
  },
  {
    id: 'const-primitive-initializer',
    source:
      "export function Widget(){const initial='';let text=initial;text += [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{const initial='';let text=initial;text += [new Date(0)];return String(text);}",
    native: 'zone',
    owner: true,
  },
  {
    id: 'single-var-right-array',
    source: "export function Widget(){var text='';text += [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{var text='';text += [new Date(0)];return String(text);}",
    native: 'zone',
    owner: true,
  },
  {
    id: 'parenthesized-target',
    source: "export function Widget(){let text='';(text) += [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text='';(text) += [new Date(0)];return String(text);}",
    native: 'zone',
    owner: true,
  },
  {
    id: 'whole-array-alias',
    source:
      "export function Widget(){const dates=[new Date(0)];let text='';text += dates;return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{const dates=[new Date(0)];let text='';text += dates;return String(text);}",
    native: 'zone',
    owner: true,
  },
  {
    id: 'nested-array',
    source: "export function Widget(){let text='';text += [[new Date(0)]];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text='';text += [[new Date(0)]];return String(text);}",
    native: 'zone',
    owner: true,
  },
  {
    id: 'array-left-written-unknown',
    source:
      "export function Widget(){let text:unknown=[new Date(0)];text += '';return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text:unknown=[new Date(0)];text += '';return String(text);}",
    native: 'zone',
    owner: true,
    writtenTypeQualification:
      'The original fixture uses an unknown binding type with a string right operand; actual Beta strict/EOPT accepts it without a cast.',
  },
  {
    id: 'ISO-data',
    source:
      "export function Widget(){let text='';text += [new Date(0).toISOString()];return <p>{text}</p>;}",
    input: false,
    private: false,
    runtime:
      "export function probe():string{let text='';text += [new Date(0).toISOString()];return String(text);}",
    native: 'same',
    owner: false,
  },
  {
    id: 'UTC-data',
    source:
      "export function Widget(){let text='';text += [new Date(0).toUTCString()];return <p>{text}</p>;}",
    input: false,
    private: false,
    runtime:
      "export function probe():string{let text='';text += [new Date(0).toUTCString()];return String(text);}",
    native: 'same',
    owner: false,
  },
  {
    id: 'scalar-array',
    source: "export function Widget(){let text='';text += [1,'x',true];return <p>{text}</p>;}",
    input: false,
    private: false,
    runtime:
      "export function probe():string{let text='';text += [1,'x',true];return String(text);}",
    native: 'same',
    owner: false,
  },
  {
    id: 'empty-array',
    source: "export function Widget(){let text='';text += [];return <p>{text}</p>;}",
    input: false,
    private: false,
    runtime: "export function probe():string{let text='';text += [];return String(text);}",
    native: 'same',
    owner: false,
  },
  {
    id: 'invalid-Date-array',
    source: "export function Widget(){let text='';text += [new Date('bad')];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text='';text += [new Date('bad')];return String(text);}",
    native: 'same',
    owner: false,
    existingPrivatePin: true,
  },
  {
    id: 'nonprimitive-before-array',
    source:
      "export function Widget(){let text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};text += [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};text += [new Date(0)];return String(text);}",
    native: 'same',
    owner: false,
    existingPrivatePin: true,
  },
  {
    id: 'earlier-target-write',
    source:
      "export function Widget(){let text:any='';text={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};text += [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text:any='';text={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};text += [new Date(0)];return String(text);}",
    native: 'same',
    owner: false,
    existingPrivatePin: true,
  },
  {
    id: 'var-redeclaration',
    source:
      "export function Widget(){var text:any='';var text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};text += [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{var text:any='';var text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};text += [new Date(0)];return String(text);}",
    native: 'same',
    owner: false,
    existingPrivatePin: true,
  },
  {
    id: 'executed-closure',
    source:
      "export function Widget(){let text:any='';const update=()=>{text={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};};update();text += [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text:any='';const update=()=>{text={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};};update();text += [new Date(0)];return String(text);}",
    native: 'same',
    owner: false,
    existingPrivatePin: true,
  },
  {
    id: 'loop-before-conversion',
    source:
      "export function Widget(){let text:any='';for(let i=0;i<1;i++){text={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};}text += [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text:any='';for(let i=0;i<1;i++){text={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};}text += [new Date(0)];return String(text);}",
    native: 'same',
    owner: false,
    existingPrivatePin: true,
  },
  {
    id: 'getter-target',
    source:
      "export function Widget(){const holder={get text(){Date.prototype.toString=()=> 'fixed';return '';},set text(_value:string){}};holder.text += [new Date(0)];return <p>{holder.text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{const holder={get text(){Date.prototype.toString=()=> 'fixed';return '';},set text(_value:string){}};holder.text += [new Date(0)];return String(holder.text);}",
    native: 'same',
    owner: false,
    existingPrivatePin: true,
  },
  {
    id: 'captured-target-owner',
    source:
      "export function Widget(){let text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};function append(){text += [new Date(0)];}append();return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{let text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};function append(){text += [new Date(0)];}append();return String(text);}",
    native: 'same',
    owner: false,
    existingPrivatePin: true,
  },
  {
    id: 'local-Date-shadow',
    source:
      "export function Widget(){class Date{constructor(_time:number){}toString(){return 'fixed';}}let text='';text += [new Date(0)];return <p>{text}</p>;}",
    input: false,
    private: false,
    runtime:
      "export function probe():string{class Date{constructor(_time:number){}toString(){return 'fixed';}}let text='';text += [new Date(0)];return String(text);}",
    native: 'same',
    owner: false,
  },
  {
    id: 'binary-existing-private',
    source: "export function Widget(){const text='' + [new Date(0)];return <p>{text}</p>;}",
    input: true,
    private: true,
    runtime: "export function probe():string{const text='' + [new Date(0)];return String(text);}",
    native: 'zone',
    owner: true,
  },
  {
    id: 'event-only-assignment',
    source:
      "export function Widget(){return <button onClick={()=>{let text='';text += [new Date(0)];return text;}}>fixed</button>;}",
    input: null,
    private: false,
    runtime: null,
    native: null,
    owner: null,
  },
  {
    id: 'effect-only-assignment',
    source:
      "import {useEffect}from'react';export function Widget(){useEffect(()=>{let text='';text += [new Date(0)];void text;},[]);return <p>fixed</p>;}",
    input: null,
    private: false,
    runtime: null,
    native: null,
    owner: null,
  },
  // A left side the compile cannot read may be any value; the array it is given becomes text.
  {
    id: 'unread-left-array',
    source:
      "export function Widget(){const render=(text:string)=>{text += [new Date(0)];return text;};return <p>{render('x')}</p>;}",
    input: true,
    private: true,
    runtime:
      "export function probe():string{const render=(text:string)=>{text += [new Date(0)];return text;};return render('x');}",
    native: 'zone',
    owner: true,
  },
  {
    id: 'unread-left-text-array-data',
    source:
      "export function Widget(){const render=(text:string)=>{text += ['-'];return text;};return <p>{render('x')}</p>;}",
    input: false,
    private: false,
    runtime:
      "export function probe():string{const render=(text:string)=>{text += ['-'];return text;};return render('x');}",
    native: 'same',
    owner: false,
  },
] as const;

describe('array Date addition assignment owner boundaries', () => {
  it.each(CASES.filter((row) => row.owner !== null))('$id', ({ source, owner }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-assignment-owner.tsx', source);
    const read = firstIn(
      [parsed.sourceFile],
      (node) => (isBinaryExpression(node) ? renderDateConversion(node) : undefined),
      () => false,
    );

    expect(read !== undefined).toBe(owner);
  });
});

describe('array Date addition assignment readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('array Date addition assignment route renders', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, private: privateRender }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');
    const found = {
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    };
    const expected = { refusals: [], shared: !privateRender, private: privateRender };

    expect(found).toStrictEqual(expected);
  });
});
