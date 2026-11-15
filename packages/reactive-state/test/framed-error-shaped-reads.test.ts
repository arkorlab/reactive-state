import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('written error bindings, members, keys and array words', () => {
  it.each([
    'function frames({ stack }: Error) { return stack; }',
    'function frames({ stack: value }: TypeError) { return value; }',
    'type Failure = Error; function frames({ stack }: Failure) { return stack; }',
    'function frames({ message }: Error) { return message; }',
    'function frames({ error: { stack } }: { error: Error }) { return stack; }',
    'function frames(box: { error: Error }) { return box.error.stack; }',
    'function frames(error: Error) { const box: { error: Error } = { error }; return box.error.stack; }',
    'type Box<T> = { error: T }; function frames(box: Box<Error>) { return box.error.stack; }',
    'function frames(box: { nested: readonly [Error] }) { return box.nested[0].stack; }',
    'function frames(box: { readonly error: Error }) { const alias = box; return alias.error.stack; }',
    "const field = 'stack'; function frames(error: Error) { return error[field]; }",
    "const first = 'stack'; const field = first; function frames(error: Error) { return error[field]; }",
    "function frames(error: Error) { const field = 'message'; return error[field]; }",
    "const field = 'stack'; function frames({ [field]: value }: Error) { return value; }",
    "function frames(error: Error) { return [error].join(','); }",
    'function frames(error: Error) { return [error].toString(); }',
    "function frames(error: Error) { const values = [error]; return values.join(','); }",
    "function frames(error: Error) { return [[error]].join(','); }",
    "const method = 'join'; function frames(error: Error) { return [error][method](','); }",
    'function frames(error: Error) { const values = [error]; const alias = values; return alias.toString(); }',
    "function frames(errors: Error[]) { return errors.join(','); }",
    'type Errors<T> = ReadonlyArray<T>; function frames(errors: Errors<Error>) { return errors.toString(); }',
    'type Errors = readonly [Error]; function frames(errors: Errors) { return errors.toString(); }',
    'function frames(box: { error: Error }) { const { error } = box; return error.stack; }',
    'function frames(box: { error: Error }) { const { error: { stack } } = box; return stack; }',
    "function frames(error: Error, override: boolean) { const values = [error]; if (override) values.join = () => 'fixed'; return values.join(','); }",
    "function frames(error: Error) { const values = [error]; values.join = () => 'fixed'; values.join = Array.prototype.join; return values.join(','); }",
    "function frames(error: Error) { const values = [error]; values.join = () => 'fixed'; Object.assign(values, { join: Array.prototype.join }); return values.join(','); }",
    "function frames(error: Error) { const values = [error]; values.join = () => 'fixed'; Object.defineProperty(values, 'join', { value: Array.prototype.join }); return values.toString(); }",
    "function frames(error: Error, methods: unknown) { const values = [error]; Object.assign(values, methods); return values.join(','); }",
    "function frames(error: Error, Object: { assign(...args: unknown[]): void }) { const values = [error]; Object.assign(values, { join: () => 'fixed' }); return values.join(','); }",
    "function frames(error: Error) { const values = [error]; Object.assign(values, { label: 'fixed' }); return values.join(','); }",
    "function frames(error: Error) { const values = [error]; Object.assign(values, { join: () => 'fixed' }, { join: Array.prototype.join }); return values.join(','); }",
    "function frames(error: Error, descriptor: PropertyDescriptor) { const values = [error]; Object.defineProperty(values, 'join', descriptor); return values.toString(); }",
    "function frames(error: Error) { const nativeJoin = Array.prototype.join; const values = [error]; values.join = nativeJoin; return values.join(','); }",
    "function frames(error: Error) { const nativeJoin = Array.prototype.join; const alias = nativeJoin; const values = [error]; values.join = alias; return values.join(','); }",
    'function frames(error: Error) { const nativeText = Array.prototype.toString; const values = [error]; values.toString = nativeText; return values.toString(); }',
    "function frames(error: Error, join: typeof Array.prototype.join) { const values = [error]; values.join = join; return values.join(','); }",
    "function frames(error: Error) { const values = [error]; values.join = false ? () => 'fixed' : Array.prototype.join; return values.join(','); }",
    "function frames(error: Error, custom: boolean) { const values = [error]; values.join = custom ? () => 'fixed' : Array.prototype.join; return values.join(','); }",
    "function frames(error: Error) { let own = () => 'fixed'; own = Array.prototype.join; const values = [error]; values.join = own; return values.join(','); }",
    "function frames(error: Error) { const methods = { join() { return 'fixed'; } }; methods.join = Array.prototype.join; const values = [error]; values.join = methods.join; return values.join(','); }",
    "function frames(error: Error, join: typeof Array.prototype.join) { const values = [error]; values.join = () => 'fixed'; values.join = join; return values.join(','); }",
    "function frames(error: Error) { function own() { return 'fixed'; } restore(); const values = [error]; values.join = own; return values.join(','); function restore() { own = Array.prototype.join; } }",
    "function frames(error: Error) { const methods = { join() { return 'fixed'; } }; restore(); const values = [error]; values.join = methods.join; return values.join(','); function restore() { methods.join = Array.prototype.join; } }",
  ])('refuses an explicitly selected engine observation: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'function frames({ stack }: { stack: string }) { return stack; }',
    'type Error = { stack: string }; function frames({ stack }: Error) { return stack; }',
    'function frames(box: { error: { stack: string }; unrelated: Error }) { return box.error.stack; }',
    'type Error = { stack: string }; type Box<T> = { error: T }; function frames(box: Box<Error>) { return box.error.stack; }',
    'function outer(box: { error: Error }) { function frames(box: { error: { stack: string } }) { return box.error.stack; } return frames; }',
    "const field = 'stack'; function frames(error: Error & { data: string }, field: 'data') { return error[field]; }",
    "const field = 'stack'; function frames(error: Error & { data: string }) { const field = 'data'; return error[field]; }",
    "function frames(value: { message: string }) { return [value].join(','); }",
    "function frames() { return [new Error('ours')].join(','); }",
    "function frames(error: Error) { return { join() { return 'fixed'; } }.join(','); }",
    "function frames(values: { [key: number]: Error; join(separator: string): string }) { return values.join(','); }",
    'function frames() { try { throw { data: { stack: "ours" } }; } catch ({ data: { stack } }) { return stack; } }',
    "const field = 'stack'; function frames(error: Error & { data: string }) { for (const field of ['data'] as const) return error[field]; }",
    'function frames(box: { error: Error }) { for (const box of [{ error: { stack: "ours" } }]) return box.error.stack; }',
  ])('preserves data, lexical shadows, written error words and non-array methods: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });

  it.each([
    "function frames(error: Error) { const values = [error]; values.join = () => 'fixed'; return values.join(','); }",
    "function frames(error: Error) { const values = [error]; values.join = () => 'fixed'; return values.toString(); }",
    "function frames(error: Error) { const values = [error]; values.toString = () => 'fixed'; return values.toString(); }",
    "function frames(error: Error) { const values = Object.assign([error], { join: () => 'fixed' }); return values.join(','); }",
    "function frames(error: Error) { const values = [error]; const alias = values; alias.join = () => 'fixed'; return [values].join(','); }",
    "function frames(error: Error) { const values = [error]; Object.assign(values, { join: () => 'fixed' }); return values.join(','); }",
    "function frames(error: Error) { const values = [error]; Object.assign(values, { toString: () => 'fixed' }); return values.toString(); }",
    "function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: () => 'fixed' }); return values.toString(); }",
    "function frames(error: Error) { const values = [error]; Object.defineProperties(values, { toString: { value: () => 'fixed' } }); return values.toString(); }",
    "function frames(error: Error) { const values = [error]; const alias = values; Object.assign(alias, { join: () => 'fixed' }); return [values].join(','); }",
    "function frames(error: Error) { const own = () => 'fixed'; const values = [error]; values.join = own; return values.join(','); }",
    "function frames(error: Error) { const own = () => 'fixed'; const alias = own; const values = [error]; values.join = alias; return values.join(','); }",
    "function frames(error: Error) { const own = function () { return 'fixed'; }; const values = [error]; values.join = own; return values.join(','); }",
    "function frames(error: Error) { function own() { return 'fixed'; } const values = [error]; values.join = own; return values.join(','); }",
    "function frames(error: Error) { const methods = { join() { return 'fixed'; } }; const own = methods.join; const values = [error]; values.join = own; return values.join(','); }",
    "function frames(error: Error) { const own = ({ join() { return 'fixed'; } }).join; const values = [error]; values.join = own; return values.join(','); }",
    "function frames(error: Error, custom: boolean) { const values = [error]; values.join = custom ? () => 'first' : function () { return 'second'; }; return values.join(','); }",
    "function frames(error: Error) { function own() { return 'fixed'; } own(); own(); const values = [error]; values.join = own; return values.join(','); }",
    "function frames(error: Error) { const methods = { join() { return 'fixed'; } }; methods.join(); methods.join(); const values = [error]; values.join = methods.join; return values.join(','); }",
    "function frames(error: Error) { function own() { return 'fixed'; } const captured = own; restore(); const values = [error]; values.join = captured; return values.join(','); function restore() { own = Array.prototype.join; } }",
    "function frames(error: Error) { const methods = { join() { return 'fixed'; } }; const captured = methods.join; restore(); const values = [error]; values.join = captured; return values.join(','); function restore() { methods.join = Array.prototype.join; } }",
  ])('refuses an array text conversion when join or toString is overridden: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    "function frames(error: Error & { data: string }) { let field = 'stack'; field = 'data'; return error[field]; }",
    "const field = 'stack'; function frames(error: Error) { function field() {} return error[field]; }",
    'const { [field]: field } = {}; function frames(error: Error) { return error[field]; }',
  ])('refuses an opaque key of a known error: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });
});

/** Whether a written source exposes frames or engine-chosen error words. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'shaped-errors.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
