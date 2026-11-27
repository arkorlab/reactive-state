import {
  isIdentifier,
  isVariableStatement,
  type Node,
  type VariableStatement,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canOmit } from '../src/compiler/omitted-work.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A constant only a dynamic site reads, the authority computes again, and the browser part leaves
 * it out where its initialization runs nothing of the application's. Reading a name runs nothing
 * where the code shows the name initialised as the statement runs: a parameter of the function it
 * stands in, a prop its pattern binds, what a statement of the body before it declares — a state, an
 * item of a hook, a constant — and what the module imports, which is initialised once its modules
 * are evaluated, as they are before a component renders. Left out, it brings nothing into the
 * browser part: a prop only the site read is not sent, and a module only the site read is not
 * imported.
 *
 * `undefined`, `NaN` and `Infinity` are read without running or throwing anything wherever no
 * declaration of the name is in scope: they are non-writable, non-configurable properties of the
 * global object, which has no getter to run, and are never absent. A prop only the site read beside
 * one of them (`{ credential, optional: undefined }`) is not sent to the browser.
 *
 * A prefix `-` or `+` of a numeric literal, or of `Infinity` or `NaN`, converts nothing, `!` of an
 * inert value or a name shown initialised is a boolean, and `typeof` of one a string, none of them
 * running anything: `{ credential, offset: -1 }` sends no prop. `-label` and `+label` convert their
 * operand, which calls its `valueOf` or `toString`, and are kept.
 *
 * A name the code does not show initialised is kept, since reading it may run or throw: any other
 * global, whose getter may run or which may be absent; a name nothing declares; a `let`, a `const`
 * or a class read before its declaration; one of those three globals where a declaration of the
 * name is in scope, which is the name read and answers by the rules above.
 */

/** A component of one state whose site alone reads `id`, of the constant `declaration` declares. */
function siteOnly(declaration: string, id: string): Readonly<Record<string, string>> {
  return {
    'components/site-only.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { LABEL } from '@/domain/site-label';",
      'export default function SiteOnly({ projectId, first, label }: { projectId: string; first: string; label: string }) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      `  ${declaration}`,
      "  return <section><button onClick={() => setSelected('x')}>{selected}</button>",
      '    <TodoCommands projectId={projectId}',
      `      id={${id}} /></section>;`,
      '}',
    ].join('\n'),
    'domain/site-label.ts': "export const LABEL = 'label';\n",
  };
}

describe('a constant only a site reads, of names the code shows initialised', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { declaration: 'const shown = selected;', id: 'shown', what: 'of a state' },
    {
      declaration: 'const shown = label;',
      id: 'shown + selected',
      what: 'of a prop the site alone reads, which is not sent',
    },
    {
      declaration: 'const shown = LABEL;',
      id: 'shown + selected',
      what: 'of an export of a shared module, which is not imported',
    },
    {
      declaration: "const shown = 'fixed';",
      id: 'shown + selected',
      what: 'of a literal',
    },
    {
      declaration: 'const shown = { credential: label, optional: undefined };',
      id: 'shown + selected',
      what: 'of a prop and `undefined`, which is not sent',
    },
    {
      declaration: 'const shown = [label, NaN];',
      id: 'shown + selected',
      what: 'of a prop and `NaN`, which is not sent',
    },
    {
      declaration: 'const shown = { credential: label, ratio: Infinity };',
      id: 'shown + selected',
      what: 'of a prop and `Infinity`, which is not sent',
    },
    {
      declaration: 'const shown = { credential: label, offset: -1 };',
      id: 'shown + selected',
      what: 'of a prop and `-1`, which is not sent',
    },
  ])('is left out of the Client Component: $what', async ({ declaration, id }) => {
    const app = await application(siteOnly(declaration, id));
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);

    const client = output(compiled, app, 'components/site-only.client.tsx');
    for (const absent of ['shown', 'label', 'LABEL']) {
      expect(client).not.toContain(absent);
    }

    expect(output(compiled, app, 'components/site-only.authority.mts')).toContain('props: {}');
  });

  it('is kept in the Client Component where it reads a constant before its declaration', async () => {
    // The source throws as it renders, and so does the browser part, which leaving it out skipped.
    const app = await application(
      siteOnly('const shown = later;\n  const later = selected;', 'shown'),
    );
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toStrictEqual([]);
    expect(output(compiled, app, 'components/site-only.client.tsx')).toContain(
      '  const shown = later;\n  void shown;\n  const later = selected;',
    );
  });
});

interface Row {
  readonly id: string;
  /** What the module writes before the function. */
  readonly before?: string;
  /** The body of the function, in which a statement declares `unused`. */
  readonly body: string;
}

/** Names the code shows initialised where the statement runs: left out. */
const SHOWN: readonly Row[] = [
  { body: 'const unused = source;', id: 'parameter' },
  { body: 'let unused = source;', id: 'let-of-a-parameter' },
  { body: 'const unused = first;', id: 'prop-of-the-parameters-pattern' },
  { body: 'const unused = defaulted;', id: 'prop-with-a-default' },
  { body: 'const unused = rest;', id: 'rest-of-the-parameters-pattern' },
  { body: 'const earlier = make(); const unused = earlier;', id: 'earlier-const' },
  { body: 'let earlier; const unused = earlier;', id: 'earlier-let' },
  { body: 'var earlier = 1; const unused = earlier;', id: 'earlier-var' },
  {
    body: 'const [state, setState] = make() as [number, () => void]; const unused = [state, setState];',
    id: 'earlier-array-pattern',
  },
  {
    body: 'const { item, other: renamed } = source; const unused = { first: item, value: renamed };',
    id: 'earlier-object-pattern',
  },
  { body: 'function earlier() {} const unused = earlier;', id: 'earlier-function' },
  { body: 'class Earlier {} const unused = Earlier;', id: 'earlier-class' },
  { body: 'const earlier = 1, unused = earlier;', id: 'earlier-declaration-of-the-statement' },
  { before: "import { LABEL } from './label';", body: 'const unused = LABEL;', id: 'named-import' },
  { before: "import label from './label';", body: 'const unused = label;', id: 'default-import' },
  {
    before: "import * as labels from './label';",
    body: 'const unused = labels;',
    id: 'namespace-import',
  },
  {
    before: "import { LABEL as renamed } from './label';",
    body: 'const unused = renamed;',
    id: 'renamed-import',
  },
  { body: 'const unused = [source, { value: first }];', id: 'within-an-array-and-an-object' },
  { body: 'const unused = (source as unknown)!;', id: 'under-a-cast' },
  { body: 'const unused = undefined;', id: 'global-undefined' },
  { body: 'const unused = NaN;', id: 'global-nan' },
  { body: 'const unused = Infinity;', id: 'global-infinity' },
  {
    body: 'const unused = { credential: source, optional: undefined };',
    id: 'prop-beside-undefined',
  },
  { body: 'const unused = [undefined, NaN, Infinity, [source]];', id: 'globals-within-an-array' },
  {
    body: 'const undefined = make(); const unused = undefined;',
    id: 'undefined-declared-earlier',
  },
  {
    body: 'function inner(undefined: unknown) { const unused = undefined; return unused; }',
    id: 'undefined-a-parameter-of-a-function-within-another',
  },
  {
    before: "import undefined from './label';",
    body: 'const unused = undefined;',
    id: 'undefined-imported',
  },
  { body: 'const unused = -1;', id: 'negative-number' },
  { body: 'const unused = +2;', id: 'positive-number' },
  { body: 'const unused = -Infinity;', id: 'negated-infinity' },
  { body: 'const unused = +NaN;', id: 'positive-nan' },
  {
    body: 'const unused = { credential: source, offset: -1 };',
    id: 'prop-beside-a-negative-number',
  },
  { body: 'const unused = !source;', id: 'not-a-parameter' },
  { body: 'const unused = !{ value: [source, -1] };', id: 'not-an-inert-value' },
  { body: 'const unused = typeof source;', id: 'typeof-a-parameter' },
  { body: 'const unused = [typeof { value: source }, !undefined];', id: 'typeof-an-inert-value' },
];

/** Names the code does not show initialised, and reads that are more than a name's: kept. */
const KEPT: readonly Row[] = [
  { body: 'const unused = window;', id: 'global' },
  { body: 'const unused = globalThis.value;', id: 'member-of-the-global-object' },
  { body: 'const unused = nothingDeclaresThis;', id: 'undeclared-name' },
  { body: 'const unused = Math;', id: 'another-global-of-the-global-object' },
  { body: 'const unused = [undefined, Math];', id: 'undefined-beside-another-global' },
  { body: 'const unused = -source;', id: 'negated-parameter' },
  { body: 'const unused = +source;', id: 'positive-parameter' },
  { body: 'const unused = +1n;', id: 'positive-bigint' },
  { body: 'const unused = !Math;', id: 'not-another-global' },
  { body: 'const unused = typeof Math;', id: 'typeof-another-global' },
  { body: 'const unused = void 0;', id: 'void-zero' },
  { body: 'const unused = ++rest;', id: 'increment' },
  {
    body: 'const Infinity = make(); const unused = -Infinity;',
    id: 'negated-infinity-declared-earlier',
  },
  {
    before: 'const Infinity = { valueOf: () => 1 };',
    body: 'const unused = -Infinity;',
    id: 'negated-infinity-of-the-module',
  },
  { body: 'const unused = undefined; const undefined = make();', id: 'undefined-declared-later' },
  { body: 'const unused = NaN; let NaN = 1;', id: 'nan-declared-later' },
  { before: 'const Infinity = 1;', body: 'const unused = Infinity;', id: 'infinity-of-the-module' },
  { body: 'const unused = later; const later = 1;', id: 'const-before-its-declaration' },
  { body: 'let unused = later; let later = 1;', id: 'let-before-its-declaration' },
  { body: 'const unused = Later; class Later {}', id: 'class-before-its-declaration' },
  { body: 'const unused = later; var later = 1;', id: 'var-declared-later' },
  { body: 'const unused = later; function later() {}', id: 'function-declared-later' },
  { body: 'const unused = unused;', id: 'its-own-name' },
  { body: 'const unused = later, later = 1;', id: 'later-declaration-of-the-statement' },
  { body: '{ let inner = 1; void inner; } const unused = inner;', id: 'let-of-a-sibling-block' },
  {
    before: "import { LABEL } from './label';",
    body: 'const unused = LABEL; const LABEL = 1;',
    id: 'import-shadowed-by-a-later-declaration',
  },
  { body: 'const unused = source; var source = 1;', id: 'parameter-declared-again-later' },
  {
    before: "import type { Label } from './label';",
    body: 'const unused = Label;',
    id: 'import-of-a-type-alone',
  },
  {
    before: "import { type Label } from './label';",
    body: 'const unused = Label;',
    id: 'named-import-of-a-type-alone',
  },
  { before: 'const outer = 1;', body: 'const unused = outer;', id: 'constant-of-the-module' },
  { body: '{ const unused = source; void unused; }', id: 'statement-of-an-inner-block' },
  { body: 'const unused = source.value;', id: 'member-of-a-parameter' },
  { body: 'const unused = { source };', id: 'shorthand-of-a-parameter' },
  { body: 'const unused = [...rest];', id: 'spread-of-a-parameter' },
];

/** A function within another, which a scope stands around: what the module imports is not shown. */
const NESTED: readonly Row[] = [
  {
    before: "import { LABEL } from './label';",
    body: 'return function inner() { const unused = LABEL; return unused; };',
    id: 'import-read-in-a-function-within-another',
  },
  {
    before: "import undefined from './label';",
    body: 'return function inner() { const unused = undefined; return unused; };',
    id: 'undefined-imported-and-read-in-a-function-within-another',
  },
];

describe('whether a constant’s initialization may be left out, by the names it reads', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `canOmit` leaves out the statement of `row` that declares `unused`. */
  function omitted(row: Row): boolean {
    using parsed = api.createSourceFile(
      'omitted-initialised-names.ts',
      [
        row.before ?? '',
        'export function frames(make: () => unknown, { first, defaulted = make(), ...rest }: any, source: any) {',
        row.body,
        '}',
        '',
      ].join('\n'),
    );
    const found = declaring(parsed.sourceFile, 'unused');
    if (found === undefined) {
      throw new Error(`No statement of ${row.id} declares \`unused\`.`);
    }
    return canOmit(found);
  }

  it.each(SHOWN)('leaves out a read of a name shown initialised: $id', (row) => {
    expect(omitted(row)).toBe(true);
  });

  it.each([...KEPT, ...NESTED])('keeps what the code does not show initialised: $id', (row) => {
    expect(omitted(row)).toBe(false);
  });

  it('answers each statement of one body by where it stands, the body read once', () => {
    using parsed = api.createSourceFile(
      'omitted-initialised-names.ts',
      [
        "import { LABEL } from './label';",
        'export function frames(source: unknown) {',
        '  const early = later;',
        '  const later = source;',
        '  const after = later;',
        '  const all = [early, after, later, LABEL];',
        '  const LABEL = all;',
        '  const last = LABEL;',
        '}',
        '',
      ].join('\n'),
    );
    const answers = ['early', 'later', 'after', 'all', 'LABEL', 'last'].map((name) => {
      const found = declaring(parsed.sourceFile, name);
      return found !== undefined && canOmit(found);
    });

    // `later` is read before its declaration and after it; `LABEL` is the body's, not the import's.
    expect(answers).toStrictEqual([false, true, true, false, true, true]);
  });
});

/** The first variable statement within `root` one of whose declarations is named `name`. */
function declaring(root: Node, name: string): VariableStatement | undefined {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (each) => isIdentifier(each.name) && each.name.text === name,
      )
    ) {
      return node;
    }
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return undefined;
}
