import { isBinaryExpression } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native Date array addition retains possible local operand initializers under original guards. */
const CASES = [
  {
    id: 'let-primitive-left',
    source: "export function Widget(){let text='';return <p>{text + [new Date(0)]}</p>;}",
    runtime: "export function probe():string{let text='';return String(text + [new Date(0)]);}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
  },
  {
    id: 'let-primitive-right',
    source: "export function Widget(){let text='';return <p>{[new Date(0)] + text}</p>;}",
    runtime: "export function probe():string{let text='';return String([new Date(0)] + text);}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
  },
  {
    id: 'const-primitive-existing-private',
    source: "export function Widget(){const text='';return <p>{text + [new Date(0)]}</p>;}",
    runtime: "export function probe():string{const text='';return String(text + [new Date(0)]);}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
  },
  {
    id: 'let-scalar-array-existing-shared',
    source: "export function Widget(){let text='';return <p>{text + [1,'x',true]}</p>;}",
    runtime: "export function probe():string{let text='';return String(text + [1,'x',true]);}",
    input: false,
    owner: false,
    private: false,
    native: 'same',
    callArgs: [],
  },
  {
    id: 'let-array-right',
    source: "export function Widget(){let dates=[new Date(0)];return <p>{''+dates}</p>;}",
    runtime: "export function probe():string{let dates=[new Date(0)];return String(''+dates);}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'let-array-left',
    source: "export function Widget(){let dates=[new Date(0)];return <p>{dates+''}</p>;}",
    runtime: "export function probe():string{let dates=[new Date(0)];return String(dates+'');}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'both-let-operands',
    source:
      "export function Widget(){let text='';let dates=[new Date(0)];return <p>{text+dates}</p>;}",
    runtime:
      "export function probe():string{let text='';let dates=[new Date(0)];return String(text+dates);}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'single-var-primitive',
    source: "export function Widget(){var text='';return <p>{text+[new Date(0)]}</p>;}",
    runtime: "export function probe():string{var text='';return String(text+[new Date(0)]);}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'single-var-array',
    source: "export function Widget(){var dates=[new Date(0)];return <p>{dates+''}</p>;}",
    runtime: "export function probe():string{var dates=[new Date(0)];return String(dates+'');}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'assignment-existing-private',
    source: "export function Widget(){let text='';text += [new Date(0)];return <p>{text}</p>;}",
    runtime:
      "export function probe():string{let text='';text += [new Date(0)];return String(text);}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'nonprimitive-companion',
    source:
      "export function Widget(){let text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};return <p>{text+[new Date(0)]}</p>;}",
    runtime:
      "export function probe():string{let text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};return String(text+[new Date(0)]);}",
    input: true,
    owner: false,
    private: true,
    native: 'same',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'prior-local-write',
    source:
      "export function Widget(){let text:any='';text={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};return <p>{text+[new Date(0)]}</p>;}",
    runtime:
      "export function probe():string{let text:any='';text={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};return String(text+[new Date(0)]);}",
    input: true,
    owner: false,
    private: true,
    native: 'same',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'var-redeclaration',
    source:
      "export function Widget(){var text:any='';var text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};return <p>{text+[new Date(0)]}</p>;}",
    runtime:
      "export function probe():string{var text:any='';var text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};return String(text+[new Date(0)]);}",
    input: true,
    owner: false,
    private: true,
    native: 'same',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'getter-companion',
    source:
      "export function Widget(){const holder={get text(){Date.prototype.toString=()=> 'fixed';return '';}};return <p>{holder.text+[new Date(0)]}</p>;}",
    runtime:
      "export function probe():string{const holder={get text(){Date.prototype.toString=()=> 'fixed';return '';}};return String(holder.text+[new Date(0)]);}",
    input: true,
    owner: false,
    private: true,
    native: 'same',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'captured-owner',
    source:
      "export function Widget(){let text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};function textOf(){return text+[new Date(0)];}return <p>{textOf()}</p>;}",
    runtime:
      "export function probe():string{let text:any={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};function textOf(){return text+[new Date(0)];}return String(textOf());}",
    input: true,
    owner: false,
    private: true,
    native: 'same',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'loop-before-conversion',
    source:
      "export function Widget(){let text:any='';for(let i=0;i<1;i++){text={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};}return <p>{text+[new Date(0)]}</p>;}",
    runtime:
      "export function probe():string{let text:any='';for(let i=0;i<1;i++){text={[Symbol.toPrimitive](){Date.prototype.toString=()=> 'fixed';return '';}};}return String(text+[new Date(0)]);}",
    input: true,
    owner: false,
    private: true,
    native: 'same',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'array-own-conversion-write',
    source:
      "export function Widget(){let dates=[new Date(0)];dates.toString=()=> 'fixed';return <p>{''+dates}</p>;}",
    runtime:
      "export function probe():string{let dates=[new Date(0)];dates.toString=()=> 'fixed';return String(''+dates);}",
    input: false,
    owner: false,
    private: false,
    native: 'same',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'conditional-false-assignment',
    source:
      "export function Widget(){if(false){var value:unknown=[new Date(0)];}value += '';return <p>{String(value)}</p>;}",
    runtime:
      "export function probe():string{if(false){var value:unknown=[new Date(0)];}value += '';return String(String(value));}",
    input: true,
    owner: true,
    private: true,
    native: 'same',
    callArgs: [],
    conservativePolicy: true,
  },
  {
    id: 'bare-block-assignment',
    source:
      "export function Widget(){{var value:unknown=[new Date(0)];}value += '';return <p>{String(value)}</p>;}",
    runtime:
      "export function probe():string{{var value:unknown=[new Date(0)];}value += '';return String(String(value));}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'conditional-true-assignment',
    source:
      "export function Widget(){if(true){var value:unknown=[new Date(0)];}value += '';return <p>{String(value)}</p>;}",
    runtime:
      "export function probe():string{if(true){var value:unknown=[new Date(0)];}value += '';return String(String(value));}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
    conservativePolicy: false,
  },
  {
    id: 'conditional-unknown-assignment',
    source:
      "export function Widget(flag?:unknown){if(flag){var value:unknown=[new Date(0)];}value += '';return <p>{String(value)}</p>;}",
    runtime:
      "export function probe(flag?:unknown):string{if(flag){var value:unknown=[new Date(0)];}value += '';return String(value);}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [true],
  },
  {
    id: 'conditional-false-array-right',
    source:
      "export function Widget(){if(false){var value:unknown=[new Date(0)];}return <p>{''+value}</p>;}",
    runtime:
      "export function probe():string{if(false){var value:unknown=[new Date(0)];}return String(''+value);}",
    input: true,
    owner: true,
    private: true,
    native: 'same',
    callArgs: [],
    conservativePolicy: true,
  },
  {
    id: 'conditional-false-array-left',
    source:
      "export function Widget(){if(false){var value:unknown=[new Date(0)];}return <p>{value+''}</p>;}",
    runtime:
      "export function probe():string{if(false){var value:unknown=[new Date(0)];}return String(value+'');}",
    input: true,
    owner: true,
    private: true,
    native: 'same',
    callArgs: [],
    conservativePolicy: true,
  },
  {
    id: 'unreachable-text-existing-private',
    source:
      "export function Widget(){if(false){const unused='' + [new Date(0)];}return <p>{'fixed'}</p>;}",
    runtime:
      "export function probe():string{if(false){const unused='' + [new Date(0)];}return String('fixed');}",
    input: true,
    owner: true,
    private: true,
    native: 'same',
    callArgs: [],
    conservativePolicy: true,
  },
  {
    id: 'mutable-array-assignment-right',
    source:
      "export function Widget(){let dates=[new Date(0)];let text='';text += dates;return <p>{text}</p>;}",
    runtime:
      "export function probe():string{let dates=[new Date(0)];let text='';text += dates;return String(text);}",
    input: true,
    owner: true,
    private: true,
    native: 'zone',
    callArgs: [],
  },
] as const;

describe('mutable array Date binary addition owner boundaries', () => {
  it.each(CASES)('$id', ({ source, owner }) => {
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

describe('mutable array Date binary addition readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-date-addition.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('mutable array Date binary addition route renders', () => {
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
