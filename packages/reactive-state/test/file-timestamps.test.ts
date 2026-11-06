import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import {
  fileReadsClock,
  fileReferenceReadsClock,
  hasFileTimestamp,
} from '../src/compiler/file-timestamps.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('explicit File timestamps', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the File construction in `code` supplies a timestamp shown defined. */
  function dated(code: string, constructor = false): boolean {
    using parsed = parseModule(api, 'file-timestamp.ts', code);
    let made: NewExpression | undefined;
    const visit = (node: Node): void => {
      if (isNewExpression(node)) {
        made = node;
      }
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (made === undefined) {
      throw new Error('The timestamp case contains no construction.');
    }
    return constructor
      ? fileReadsClock(made, (expression) => globalPathOf(expression)?.join('.') === 'File')
      : hasFileTimestamp(made);
  }

  /** Whether a runtime reference to the global File can reach an unchecked construction. */
  function escapes(code: string): boolean {
    using parsed = parseModule(api, 'file-reference.ts', code);
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (isTypeOnly(at)) continue;
      if (
        isIdentifier(at) &&
        globalPathOf(at)?.join('.') === 'File' &&
        fileReferenceReadsClock(at)
      ) {
        return true;
      }
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    return false;
  }

  it.each([
    'function read(Make: typeof File) { return new Make([], "x").lastModified; } read(File);',
    'function constructorOf() { return File; } new (constructorOf())([], "x");',
    'const Make = File; function read(Input: typeof Make) { return new Input([], "x"); } read(Make);',
    'const Make = File; const Alias = Make; const holder = { Alias };',
    'const Make = File; new Make([], "fixed", { lastModified: 0 }); new Make([], "clock");',
    'const Make = File; export { Make };',
    'const Make = File; export { Make as Exposed };',
    'export const Make = File;',
  ])('retains an escaped constructor’s possible clock input: %s', (code) => {
    expect(escapes(code)).toBe(true);
  });

  it.each([
    'declare class Data extends File {} new File([], "fixed", { lastModified: 0 });',
    'const Make = File; declare class Data extends Make {} new Make([], "fixed", { lastModified: 0 });',
    'declare namespace Types { class Data extends File {} } new File([], "fixed", { lastModified: 0 });',
    'const Make = File; declare namespace Types { namespace Nested { class Data extends Make {} } } new Make([], "fixed", { lastModified: 0 });',
    'const Make = File; function read(value: typeof Make): void; function read(value: unknown) {} new Make([], "fixed", { lastModified: 0 });',
    'new File([], "fixed", { lastModified: 0 });',
    'const Make = File; const Alias = Make; new Alias([], "fixed", { lastModified: 0 });',
    'const Make = File; type Constructor = typeof Make; new Make([], "fixed", { lastModified: 0 });',
    'const Make = File; function read(Make: unknown) { return Make; } new Make([], "fixed", { lastModified: 0 });',
    'const Make = File; try {} catch (Make) { consume(Make); } new Make([], "fixed", { lastModified: 0 });',
    'const Other = 0; const Make = File; export { Other as Make }; new Make([], "fixed", { lastModified: 0 });',
    'import { Make as Data } from "./data"; const Make = File; new Make([], "fixed", { lastModified: 0 });',
    'const Make = File; export { Make as Exposed } from "./data"; new Make([], "fixed", { lastModified: 0 });',
    'const Make = File; export { Other as Make } from "./data"; new Make([], "fixed", { lastModified: 0 });',
    'const Make = File; const data = { Make: 0 }; new Make([], "fixed", { lastModified: 0 });',
    'const Make = File; Make: for (;;) { break Make; } new Make([], "fixed", { lastModified: 0 });',
    'const Other = 0; export { Other as File };',
    'import { File as Data } from "./data";',
    'export { File as Exposed } from "./data";',
    'export { Other as File } from "./data";',
    'const Make = File; export type { Make };',
    'const Make = File; export { type Make };',
  ])('keeps fixed constructions, type references and distinct bindings: %s', (code) => {
    expect(escapes(code)).toBe(false);
  });

  it.each([
    "new File([], 'x', { lastModified: 0 });",
    "new File([], 'x', { lastModified: null });",
    "new File([], 'x', { lastModified: false });",
    "new File([], 'x', { lastModified: '0' });",
    "const stamp = 0; const alias = stamp; new File([], 'x', { lastModified: alias });",
    "const lastModified = 0; new File([], 'x', { lastModified });",
    "const options = { lastModified: 0 }; const alias = options; new File([], 'x', alias);",
    "new File([], 'x', { ['lastModified']: 0 });",
    "const key = 'lastModified'; new File([], 'x', { [key]: 0 });",
    "new File([], 'x', { ...{ lastModified: 0 } });",
    "const options = { lastModified: 0 }; new File([], 'x', { ...options });",
    "const base = { lastModified: 0 }; const options = { ...base }; new File([], 'x', options);",
    "new File([], 'x', { lastModified: 0, ...{ type: 'text/plain' } });",
    "new File([], 'x', { lastModified: undefined, ...{ lastModified: 0 } });",
    "new File([], 'x', { ...unknown, lastModified: 0 });",
    "new File([], 'x', { [unknown]: undefined, lastModified: 0 });",
    "new File([], 'x', { ...{ ...unknown, lastModified: 0 } });",
    "new File([], 'x', { lastModified: flag ? 0 : null });",
    "new File([], 'x', { lastModified: unknown ?? 0 });",
    "new File([], 'x', { lastModified: unknown || 0 });",
    "const options = {}; { const options = { lastModified: 0 }; new File([], 'x', options); }",
    "for (const options = { lastModified: 0 }; flag;) { new File([], 'x', options); }",
  ])('keeps a supplied timestamp: %s', (code) => {
    expect(dated(code)).toBe(true);
  });

  it.each([
    "const options = { lastModified: 0 }; options.lastModified = undefined; new File([], 'x', options);",
    "const options = { lastModified: 0 }; const alias = options; alias.lastModified = undefined; new File([], 'x', options);",
    "const options = { lastModified: 0 }; change(options); new File([], 'x', options);",
    "export const options = { lastModified: 0 }; new File([], 'x', options);",
    "new File([], 'x', { lastModified: 0, get endings() { this.lastModified = undefined; return 'transparent'; } });",
    "new File([], 'x', { __proto__: external, lastModified: 0 });",
    "new File(...bits, 'x', { lastModified: 0 });",
    "new File([], 'x');",
    "new File([], 'x', undefined);",
    "new File([], 'x', {});",
    "new File([], 'x', { lastModified: undefined });",
    "new File([], 'x', { lastModified: void 0 });",
    "new File([], 'x', { lastModified: unknown });",
    "const stamp = undefined; new File([], 'x', { lastModified: stamp });",
    "const lastModified = undefined; new File([], 'x', { lastModified });",
    "new File([], 'x', { lastModified: 0, ...{ lastModified: undefined } });",
    "new File([], 'x', { lastModified: 0, ...unknown });",
    "new File([], 'x', { lastModified: 0, [unknown]: undefined });",
    "new File([], 'x', { get lastModified() { return 0; } });",
    "new File([], 'x', { lastModified() { return 0; } });",
    "const left = right; const right = left; new File([], 'x', left);",
    "const stamp = stamp; new File([], 'x', { lastModified: stamp });",
    "const options = { lastModified: 0 }; function read(options: unknown) { return new File([], 'x', options); }",
    "const options = { lastModified: 0 }; try {} catch (options) { new File([], 'x', options); }",
    "const options = { lastModified: 0 }; for (const options of values) { new File([], 'x', options); }",
    "const options = { lastModified: 0 }; for (const options in values) { new File([], 'x', options); }",
    "const options = { lastModified: 0 }; switch (value) { case 0: const options = {}; new File([], 'x', options); }",
    "const options = { lastModified: 0 }; function read() { if (flag) { var options; } return new File([], 'x', options); }",
    "let options = { lastModified: 0 }; new File([], 'x', options);",
    "let stamp = 0; new File([], 'x', { lastModified: stamp });",
    "const options = { lastModified: 0 }; function read({ options }: Input) { return new File([], 'x', options); }",
    "new File([], 'x', { lastModified: flag ? 0 : undefined });",
  ])('retains a possible clock default: %s', (code) => {
    expect(dated(code)).toBe(false);
  });

  it.each([
    "new File([], 'x');",
    "const Make = File; new Make([], 'x');",
    "const Make = File; const Alias = Make; new Alias([], 'x');",
    "const Make = File; function read() { return new Make([], 'x', { lastModified: undefined }); }",
  ])('follows a clock-reading File constructor: %s', (code) => {
    expect(dated(code, true)).toBe(true);
  });

  it.each([
    "const Make = File; new Make([], 'x', { lastModified: 0 });",
    "const Left = Right; const Right = Left; new Left([], 'x');",
    "class Make {} new Make([], 'x');",
    "const Make = File; function read(Make: unknown) { return new Make([], 'x'); }",
    "const Make = File; try {} catch (Make) { new Make([], 'x'); }",
    "const Make = File; for (const Make of values) { new Make([], 'x'); }",
    "const Make = File; switch (value) { case 0: class Make {} new Make([], 'x'); }",
  ])('keeps local constructors and explicit timestamps: %s', (code) => {
    expect(dated(code, true)).toBe(false);
  });
});
