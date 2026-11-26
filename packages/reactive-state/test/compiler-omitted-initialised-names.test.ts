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
 * A name the code does not show initialised is kept, since reading it may run or throw: a global,
 * whose getter may run; a name nothing declares; a `let`, a `const` or a class read before its
 * declaration.
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
];

/** Names the code does not show initialised, and reads that are more than a name's: kept. */
const KEPT: readonly Row[] = [
  { body: 'const unused = window;', id: 'global' },
  { body: 'const unused = globalThis.value;', id: 'member-of-the-global-object' },
  { body: 'const unused = nothingDeclaresThis;', id: 'undeclared-name' },
  { body: 'const unused = undefined;', id: 'undefined' },
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
const NESTED: Row = {
  before: "import { LABEL } from './label';",
  body: 'return function inner() { const unused = LABEL; return unused; };',
  id: 'import-read-in-a-function-within-another',
};

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

  it.each([...KEPT, NESTED])('keeps what the code does not show initialised: $id', (row) => {
    expect(omitted(row)).toBe(false);
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
