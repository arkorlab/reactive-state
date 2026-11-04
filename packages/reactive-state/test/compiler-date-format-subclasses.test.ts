import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native date formatter heritage retains implicit clock reads and written method overrides. */
const CASES = [
  {
    id: 'subclass-no-date',
    source: 'class Format extends Intl.DateTimeFormat {}',
    invocation: "new Format('en-US').format()",
    clock: true,
  },
  {
    id: 'subclass-undefined-parts',
    source: 'class Format extends Intl.DateTimeFormat {}',
    invocation: "new Format('en-US').formatToParts(undefined).length",
    clock: true,
  },
  {
    id: 'constant-class-alias',
    source: 'class Format extends Intl.DateTimeFormat {} const Alias=Format;',
    invocation: "new Alias('en-US').format()",
    clock: true,
  },
  {
    id: 'local-heritage-chain',
    source: 'class Base extends Intl.DateTimeFormat {} class Format extends Base {}',
    invocation: "new Format('en-US').format()",
    clock: true,
  },
  {
    id: 'constant-native-base',
    source: 'const Base=Intl.DateTimeFormat; class Format extends Base {}',
    invocation: "new Format('en-US').format()",
    clock: true,
  },
  {
    id: 'provided-date',
    source: 'class Format extends Intl.DateTimeFormat {}',
    invocation: "new Format('en-US').format(new Date(0))",
    clock: false,
  },
  {
    id: 'shadowed-intl',
    source:
      'const Intl={DateTimeFormat:class {format(){return "fixed";}}}; class Format extends Intl.DateTimeFormat {}',
    invocation: 'new Format().format()',
    clock: false,
  },
  {
    id: 'own-format-method',
    source: 'class Format extends Intl.DateTimeFormat {format(){return "fixed";}}',
    invocation: "new Format('en-US').format()",
    clock: false,
  },
  {
    id: 'own-format-field',
    source: 'class Format extends Intl.DateTimeFormat {format=()=>"fixed";}',
    invocation: "new Format('en-US').format()",
    clock: false,
  },
  {
    id: 'own-parts-method',
    source: 'class Format extends Intl.DateTimeFormat {formatToParts(){return [];}}',
    invocation: "new Format('en-US').formatToParts().length",
    clock: false,
  },
  {
    id: 'inherited-own-format',
    source:
      'class Base extends Intl.DateTimeFormat {format(){return "fixed";}} class Format extends Base {}',
    invocation: "new Format('en-US').format()",
    clock: false,
  },
  {
    id: 'ordinary-class-data',
    source: 'class Format {format(){return "fixed";}}',
    invocation: 'new Format().format()',
    clock: false,
  },
  {
    id: 'cyclic-class-alias',
    source: 'const Format=Alias; const Alias=Format;',
    invocation: 'new Format().format()',
    clock: false,
  },
  {
    id: 'native-no-date-pin',
    source: '',
    invocation: "new Intl.DateTimeFormat('en-US').format()",
    clock: true,
  },
  {
    id: 'native-provided-date-pin',
    source: '',
    invocation: "new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(new Date(0))",
    clock: false,
  },
  {
    id: 'declared-field-keeps-native-format',
    source:
      'class Format extends Intl.DateTimeFormat { declare format:(date?:number|Date)=>string; }',
    invocation: "new Format('en-US').format()",
    clock: true,
  },
] as const;

describe('date formatter subclass clock reads', () => {
  it.each(CASES)('$id', ({ source, invocation, clock }) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'format-subclasses.ts',
      `${source}
function shown(){return ${invocation};}`,
    );
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read).toBe(clock ? 'Intl.DateTimeFormat' : undefined);
  });
});

describe('routes with date formatter subclass reads', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, clock }) => {
    const app = await application({
      'app/boards/layout.tsx': [
        "import type { ReactNode } from 'react';",
        source,
        `const shown = async () => ${invocation};`,
        'export default async function Layout({children}:{children:ReactNode}) {',
        '  return <section data-shown={String(await shown())}>{children}</section>;',
        '}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');

    expect(compiled.refusals).toStrictEqual([]);
    expect(board).toMatchObject({ shared: !clock });
    expect(board?.private === undefined).toBe(!clock);
  });
});
