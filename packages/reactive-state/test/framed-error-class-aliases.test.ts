import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('declared errors inherited through constant constructor aliases', () => {
  it.each([
    'const Base = class extends globalThis.Error {}; class Error extends Base {} function read(error: Error) { return error.stack; }',
    'const Base = class extends TypeError {}; class Failure extends Base {} function read(error: Failure) { return error.stack; }',
    'const Base = globalThis.Error; class Failure extends Base {} function read(error: Failure) { return error.stack; }',
    'const Base = Error; class Failure extends Base {} function read(error: Failure) { return error.stack; }',
    'const First = class extends globalThis.Error {}; const Base = First; class Error extends (Base as typeof Base) {} function read(error: Error) { return error.stack; }',
    'const Base = class Native extends globalThis.Error {}; class Failure extends Base {} function read(error: Failure) { return error.stack; }',
    'const Base = class<T> extends globalThis.Error {}; class Failure extends Base<string> {} function read(error: Failure) { return error.stack; }',
    'class Base { stack = "data"; } function within() { const Base = class extends Error {}; class Failure extends Base {} function read(error: Failure) { return error.stack; } }',
    'function other(Base: unknown) { return Base; } const Base = class extends Error {}; class Failure extends Base {} function read(error: Failure) { return error.stack; }',
    'const Base = class extends globalThis.Error {}; function within<Base>() { class Failure extends Base {} function read(error: Failure) { return error.stack; } }',
  ])('retains a native error base through written constants: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'const Base = class { stack = "data"; }; class Error extends Base {} function read(error: Error) { return error.stack; }',
    'const First = class { stack = "data"; }; const Base = First; class Error extends Base {} function read(error: Error) { return error.stack; }',
    'const Error = class { stack = "data"; }; class Failure extends Error {} function read(error: Failure) { return error.stack; }',
    'import { Error as Base } from "./data"; class Failure extends Base {} function read(error: Failure) { return error.stack; }',
    'const Base = class extends globalThis.Error {}; function within(Base: unknown) { class Error extends Base {} function read(error: Error) { return error.stack; } }',
    'const Base = class extends globalThis.Error {}; function within() { const Base = class { stack = "data"; }; class Error extends Base {} function read(error: Error) { return error.stack; } }',
    'const globalThis = { Error: class { stack = "data"; } }; const Base = globalThis.Error; class Error extends Base {} function read(error: Error) { return error.stack; }',
    'const Base = Other; const Other = Base; class Error extends Base {} function read(error: Error) { return error.stack; }',
    'const Base = Base; class Error extends Base {} function read(error: Error) { return error.stack; }',
    'const Base = unknownClass; class Error extends Base {} function read(error: Error) { return error.stack; }',
  ])('keeps application classes, lexical value shadows and unresolved cycles: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });
});

/** Whether a written declaration exposes an engine frame, without classifying arbitrary data. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'constant-error-bases.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedRead(at) !== undefined) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
