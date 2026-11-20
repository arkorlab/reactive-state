import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type Expression,
  isCallExpression,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { afterEach, describe, expect, it } from 'vitest';

import { analyzeComponent } from '../src/compiler/analyze.ts';
import {
  componentScope,
  constantOf,
  patternCapturesNothing,
} from '../src/compiler/component-values.ts';
import { failIn } from '../src/compiler/errors.ts';
import { HookModules } from '../src/compiler/hooks.ts';
import { Modules } from '../src/compiler/modules.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * Whether the pattern a component's `split` divides text by may hold a group that captures nothing
 * (`patternCapturesNothing`), of which `split` answers `undefined` among its text — no JSON: a
 * pattern written there, a constant that holds one, a name a shared module exports, and a constant
 * that holds an import, `const separator = importedPattern`. A name read through constants is read
 * as what a shared module declares of it, as it is where it stands alone.
 *
 * Each row writes a component and the shared module of patterns it imports, and asks of the
 * argument of the component's `split` call.
 */

const api = openTypeScript();
const dirs: string[] = [];

/** The patterns a shared module exports: one that captures, one that does not, an object of one. */
const PATTERNS = `export const importedPattern = /a|(b)/;
export const plainPattern = /a|b/;
export const nested = { sep: /a|(b)/ };
export const text = ',';
`;

/** The call `.split(…)` the component holds, whose first argument is the pattern. */
function splitArgument(root: Node): Expression | undefined {
  let found: Expression | undefined;
  const visit = (node: Node): void => {
    if (
      found === undefined &&
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'split'
    ) {
      found = node.arguments[0];
    }
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

/**
 * What `patternCapturesNothing` answers of `first.split(argument)` in a component that declares
 * `server` in its server part, and imports of the module of patterns what `imports` names.
 */
function answered(argument: string, server = '', imports = ''): boolean {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-split-pattern-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  const source = path.join(root, 'src');
  mkdirSync(path.join(source, 'lib'), { recursive: true });
  mkdirSync(path.join(source, 'components'), { recursive: true });
  writeFileSync(path.join(source, 'lib/patterns.ts'), PATTERNS);
  const file = path.join(source, 'components/lab.reactive.tsx');
  writeFileSync(
    file,
    `${imports}
export default function Lab({ first }: { first: string }) {
${server}  return <p>{first.split(${argument}).length}</p>;
}
`,
  );
  using modules = new Modules(api, source);
  const hooks = new HookModules(modules);
  const parsed = modules.parse(file, true);
  const fail = failIn(parsed.sourceFile, parsed.name);
  const component = analyzeComponent({
    classify: (specifier) => modules.targetOf(specifier, file),
    fail,
    fileName: parsed.name,
    hookOf: (binding) => hooks.hookOf(binding),
    id: modules.idOf(file, 'component') ?? fail('No component.'),
    sourceFile: parsed.sourceFile,
  });
  const node = splitArgument(parsed.sourceFile);
  if (node === undefined) {
    throw new Error('no split call');
  }
  const scope = componentScope({ component, modules });
  return patternCapturesNothing(scope, node, {
    follow: (name) => constantOf(component, name),
    scope,
  });
}

const NAMED = "import { importedPattern, plainPattern, nested, text } from '@/lib/patterns';";
const NAMESPACE = "import * as pats from '@/lib/patterns';";

describe('the pattern a component splits text by, which may capture nothing', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('a capturing pattern a constant holds as an import is read as it is imported', () => {
    it.each([
      { id: 'a constant of an imported pattern', server: '  const separator = importedPattern;\n' },
      {
        id: 'a constant of a constant of an imported pattern',
        server: '  const one = importedPattern;\n  const separator = one;\n',
      },
      {
        id: 'a constant of an imported pattern, cast',
        server: '  const separator = importedPattern as RegExp;\n',
      },
      {
        id: 'a constant of a member of an imported object',
        server: '  const separator = nested.sep;\n',
      },
      {
        id: 'a constant of a member of a namespace import',
        imports: NAMESPACE,
        server: '  const separator = pats.importedPattern;\n',
      },
    ])('$id', ({ imports, server }) => {
      expect(answered('separator', server, imports ?? NAMED)).toBe(true);
    });
  });

  describe('a capturing pattern read where it stands is read as ever', () => {
    it.each([
      { argument: 'importedPattern', id: 'an imported pattern, named in the call' },
      { argument: 'nested.sep', id: 'a member of an imported object, named in the call' },
      { argument: '/a|(b)/', id: 'a pattern written in the call' },
      { argument: '(importedPattern)', id: 'an imported pattern in parentheses' },
      { argument: '...[importedPattern]', id: 'a spread, which hands anything' },
    ])('$id', ({ argument }) => {
      expect(answered(argument, '', NAMED)).toBe(true);
    });

    it('a constant of a pattern written there', () => {
      expect(answered('separator', '  const separator = /a|(b)/;\n')).toBe(true);
    });

    it('a pattern a module exports under a namespace import, named in the call', () => {
      expect(answered('pats.importedPattern', '', NAMESPACE)).toBe(true);
    });
  });

  describe('a pattern that captures nothing, or no pattern, stays taken, named or not', () => {
    it.each([
      { argument: 'plainPattern', id: 'an imported pattern with no group' },
      { argument: 'text', id: 'an imported text' },
      { argument: '/a|b/', id: 'a pattern with no group written in the call' },
      { argument: '/(?:a|b)/', id: 'a pattern whose group does not capture' },
      { argument: "','", id: 'text written in the call' },
    ])('$id', ({ argument }) => {
      expect(answered(argument, '', NAMED)).toBe(false);
    });

    it.each([
      {
        id: 'a constant of an imported pattern with no group',
        server: '  const separator = plainPattern;\n',
      },
      { id: 'a constant of an imported text', server: '  const separator = text;\n' },
      {
        id: 'a constant of a pattern with no group written there',
        server: '  const separator = /a|b/;\n',
      },
      { id: 'a constant of text written there', server: "  const separator = ',';\n" },
    ])('$id', ({ server }) => {
      expect(answered('separator', server, NAMED)).toBe(false);
    });
  });
});
