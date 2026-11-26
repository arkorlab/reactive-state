import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Borrowed native date formatter methods retain the actual receiver and consumed date. */
const CASES = [
  {
    id: 'prototype-reflect',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const prototype=Intl.DateTimeFormat.prototype;return <p>{String(JSON.stringify(Reflect.apply(prototype.formatToParts,formatter,[])))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const prototype=Intl.DateTimeFormat.prototype;return String(JSON.stringify(Reflect.apply(prototype.formatToParts,formatter,[])));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
  {
    id: 'prototype-method-reflect',
    source:
      'export function Widget(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const prototype=Intl.DateTimeFormat.prototype;const method=prototype.formatToParts;return <p>{String(JSON.stringify(Reflect.apply(method,formatter,[])))}</p>;}',
    runtime:
      'function probe(){const formatter=new Intl.DateTimeFormat("en-US",{timeZone:"UTC",timeStyle:"medium"});const prototype=Intl.DateTimeFormat.prototype;const method=prototype.formatToParts;return String(JSON.stringify(Reflect.apply(method,formatter,[])));}',
    input: 'Intl.DateTimeFormat',
    native: 'parts-now',
    client: true,
    reader: true,
  },
] as const;

describe('borrowed date clock Reflect alias readers', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'render-borrowed-date-clock.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(input);
  });
});

describe('borrowed date clock Reflect alias route renders', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${source}`,
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        "import { Widget } from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){',
        'return <section><Widget />{children}</section>;',
        '}',
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
    const expected = { refusals: [], shared: false, private: true };

    expect(found).toStrictEqual(expected);
  });
});
