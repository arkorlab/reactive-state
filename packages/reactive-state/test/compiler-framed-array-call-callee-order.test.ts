import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import type { ArrayMethodOverride } from '../src/compiler/framed-array-own-methods.ts';
import {
  arrayMethodOverride,
  framedArrayString,
  framedArrayText,
} from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A call selects its method before it evaluates its arguments (ECMA-262, call evaluation): a write
 * of that method in the arguments is made after the selection, and what the call runs is the method
 * written before it. An assignment evaluates its right side before it writes, and a loop its
 * iterable before its head does: a read in either comes before the write. What the method itself
 * then reads, and a call's own repeats, still see it.
 */
const SAFE = "values.join = () => 'fixed';";

const CASES = [
  {
    id: 'reviewed-delete-argument',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values.join(delete values.join); }`,
    converts: false,
  },
  {
    id: 'assignment-argument',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values.join((values.join = Array.prototype.join, 1)); }`,
    converts: false,
  },
  {
    id: 'definition-argument',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values.join(Object.defineProperty(values, 'join', { value: Array.prototype.join })); }`,
    converts: false,
  },
  {
    id: 'element-access-callee',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values['join'](delete values.join); }`,
    converts: false,
  },
  {
    id: 'sort-argument',
    source: `function frames(error: Error) { const values = [error]; values.sort = () => values; return values.sort(delete values.sort); }`,
    converts: false,
  },
  {
    id: 'to-string-reads-join-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values.toString(delete values.join); }`,
    converts: true,
  },
  {
    id: 'string-argument-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return String(values, delete values.join); }`,
    converts: true,
  },
  {
    id: 'operand-before-call-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return [delete values.join, values.join()][1]; }`,
    converts: true,
  },
  {
    id: 'other-method-argument-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values.join(delete values.toString); }`,
    converts: false,
  },
  {
    id: 'loop-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} let text = ''; for (let pass = 0; pass < 2; pass++) text = values.join(delete values.join); return text; }`,
    converts: true,
  },
  {
    id: 'captured-array-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} function read() { return values.join(delete values.join); } return read() + read(); }`,
    converts: true,
  },
  {
    id: 'assignment-operand',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} values.join = String(values) as any; }`,
    converts: false,
  },
  {
    id: 'array-pattern-operand',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} [values.join] = [String(values) as any]; }`,
    converts: false,
  },
  {
    id: 'object-pattern-operand',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} ({ restore: values.join } = { restore: String(values) as any }); }`,
    converts: false,
  },
  {
    id: 'loop-iterable-operand',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (values.join of [String(values) as any]); }`,
    converts: false,
  },
  {
    id: 'later-target-default',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} [values.join, text = String(values)] = [Array.prototype.join, undefined]; }`,
    converts: true,
  },
  {
    id: 'later-computed-key',
    source: `function frames(error: Error, text: { [key: string]: unknown }) { const values = [error]; ${SAFE} ({ restore: values.join, [String(values)]: text.field } = { restore: Array.prototype.join }); }`,
    converts: true,
  },
  {
    id: 'earlier-default-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} [text = String(values), values.join] = [undefined, Array.prototype.join]; }`,
    converts: false,
  },
  {
    id: 'other-array-target-pin',
    source: `function frames(error: Error) { const values = [error]; const other = [1]; ${SAFE} [other.join, text = String(values)] = [Array.prototype.join, undefined]; }`,
    converts: false,
  },
  {
    id: 'loop-condition-revisit',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { values.join = Array.prototype.join; } }`,
    converts: true,
  },
  {
    id: 'loop-body-later-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2; pass++) { String(values); values.join = Array.prototype.join; } }`,
    converts: true,
  },
  {
    id: 'loop-update-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2; values.join = Array.prototype.join) String(values); }`,
    converts: true,
  },
  {
    id: 'loop-made-array-pin',
    source: `function frames(error: Error) { for (let pass = 0; pass < 2; pass++) { const values = [error]; ${SAFE} String(values); values.join = Array.prototype.join; } }`,
    converts: false,
  },
  {
    id: 'later-statement-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} String(values); values.join = Array.prototype.join; }`,
    converts: false,
  },
  {
    id: 'repeated-assignment-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2; pass++) values.join = String(values) as any; }`,
    converts: true,
  },
  {
    id: 'captured-assignment-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} function read() { values.join = String(values) as any; } read(); read(); }`,
    converts: true,
  },
  {
    id: 'loop-override-before-each-read',
    source: `function frames(error: Error) { const values = [error]; for (let pass = 0; pass < 2; pass++) { ${SAFE} String(values); values.join = Array.prototype.join; } }`,
    converts: false,
  },
  {
    id: 'loop-override-before-condition-revisit-pin',
    source: `function frames(error: Error) { const values = [error]; for (let pass = 0; pass < 2; pass++) { ${SAFE} while (String(values) === 'fixed') { values.join = Array.prototype.join; } } }`,
    converts: true,
  },
  {
    id: 'loop-branch-write-before-read-pin',
    source: `function frames(error: Error) { const values = [error]; for (let pass = 0; pass < 2; pass++) { ${SAFE} if (pass > 0) values.join = Array.prototype.join; String(values); } }`,
    converts: true,
  },
  {
    id: 'iterable-read-runs-once',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (const text of [String(values), 'other']) { values.join = Array.prototype.join; } }`,
    converts: false,
  },
  {
    id: 'for-initializer-read-runs-once',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let text = String(values), pass = 0; pass < 2; pass++) { values.join = Array.prototype.join; } }`,
    converts: false,
  },
  {
    id: 'for-in-expression-read-runs-once',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (const key in { [String(values)]: 1, other: 2 }) { values.join = Array.prototype.join; } }`,
    converts: false,
  },
  {
    id: 'loop-body-read-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (const text of ['one', 'two']) { String(values); values.join = Array.prototype.join; } }`,
    converts: true,
  },
  {
    id: 'loop-condition-read-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; String(values) && pass < 2; pass++) { values.join = Array.prototype.join; } }`,
    converts: true,
  },
  {
    id: 'recursive-iife-selection',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(pass: number, text = values.join((values.join = Array.prototype.join, ''))): string { return pass < 1 ? text + read(pass + 1) : text; })(0); }`,
    converts: true,
  },
  {
    id: 'single-iife-selection-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(pass: number, text = values.join((values.join = Array.prototype.join, ''))): string { return text; })(0); }`,
    converts: false,
  },
  {
    id: 'named-iife-calling-another-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} const other = (pass: number) => pass; return (function read(pass: number, text = values.join((values.join = Array.prototype.join, ''))): string { return text + other(pass); })(0); }`,
    converts: false,
  },
  {
    id: 'shadowed-name-iife-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(read = () => '', text = String(values)) { values.join = Array.prototype.join; return text + read(); })(); }`,
    converts: false,
  },
  {
    id: 'shadowed-by-local-iife-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(text = String(values)) { values.join = Array.prototype.join; const read = () => ''; return text + read(); })(); }`,
    converts: false,
  },
  {
    id: 'inner-function-of-same-name-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(text = String(values)) { values.join = Array.prototype.join; return text + (function read(pass: number): string { return pass > 0 ? read(pass - 1) : ''; })(1); })(); }`,
    converts: false,
  },
  {
    id: 'recursive-iife-in-body-reference',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(pass: number, text = String(values)): string { values.join = Array.prototype.join; return pass < 1 ? text + read(pass + 1) : text; })(0); }`,
    converts: true,
  },
  {
    id: 'unreachable-self-reference',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(text = String(values)): string { values.join = Array.prototype.join; if (false) read(); return text; })(); }`,
    converts: false,
  },
  {
    id: 'unreachable-conditional-self-reference',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(text = String(values)): string { values.join = Array.prototype.join; return false ? read() : text; })(); }`,
    converts: false,
  },
  {
    id: 'unreachable-nested-function-self-reference',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(text = String(values)): string { values.join = Array.prototype.join; if (false) { (() => read())(); } return text; })(); }`,
    converts: false,
  },
  {
    id: 'selected-branch-self-reference',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(pass: number, text = String(values)): string { values.join = Array.prototype.join; if (true) { return pass < 1 ? text + read(pass + 1) : text; } return text; })(0); }`,
    converts: true,
  },
  {
    id: 'unreachable-self-reference-selection',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(text = values.join((values.join = Array.prototype.join, ''))): string { if (false) read(); return text; })(); }`,
    converts: false,
  },
  {
    id: 'loop-custom-only-write-keeps-proof',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = () => 'also fixed'; } }`,
    converts: false,
  },
  {
    id: 'loop-custom-object-assign-keeps-proof',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { Object.assign(values, { join: () => 'also fixed' }); } }`,
    converts: false,
  },
  {
    id: 'loop-custom-definition-keeps-proof',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { Object.defineProperty(values, 'join', { value: () => 'also fixed', writable: true }); } }`,
    converts: false,
  },
  {
    id: 'loop-custom-write-in-branch-keeps-proof',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { if (pass > 0) values.join = () => 'also fixed'; } }`,
    converts: false,
  },
  {
    id: 'loop-custom-then-native-write-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = () => 'also fixed'; values.join = Array.prototype.join; } }`,
    converts: true,
  },
  {
    id: 'loop-unknown-function-write-pin',
    source: `function frames(error: Error) { const values = [error]; const choices = [() => 'also fixed', Array.prototype.join]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = choices[pass] as any; } }`,
    converts: true,
  },
  {
    id: 'loop-custom-write-of-another-method-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; values.sort = () => values; } }`,
    converts: true,
  },
  {
    id: 'loop-custom-write-without-proof-pin',
    source: `function frames(error: Error) { const values = [error]; for (let pass = 0; pass < 2 && String(values); pass++) { values.join = () => 'later'; } }`,
    converts: true,
  },
  {
    id: 'other-function-custom-write-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} function again() { values.join = () => 'also fixed'; } again(); return String(values); }`,
    converts: true,
  },
  {
    id: 'loop-break-after-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { values.join = Array.prototype.join; break; } }`,
    converts: false,
  },
  {
    id: 'loop-return-after-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { values.join = Array.prototype.join; return 1; } return 0; }`,
    converts: false,
  },
  {
    id: 'loop-throw-after-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { values.join = Array.prototype.join; throw error; } }`,
    converts: false,
  },
  {
    id: 'loop-break-in-block-after-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} let pass = 0; while (String(values) === 'fixed') { if (pass++ > 1) { values.join = Array.prototype.join; break; } } }`,
    converts: false,
  },
  {
    id: 'loop-break-after-write-in-for',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; String(values) === 'fixed'; pass++) { values.join = Array.prototype.join; break; } }`,
    converts: false,
  },
  {
    id: 'loop-inner-loop-break',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { for (const text of ['one', 'two']) { values.join = Array.prototype.join; break; } } }`,
    converts: true,
  },
  {
    id: 'loop-switch-break',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} let pass = 0; while (String(values) === 'fixed') { switch (pass++) { default: values.join = Array.prototype.join; break; } } }`,
    converts: true,
  },
  {
    id: 'loop-caught-throw',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { try { values.join = Array.prototype.join; throw error; } catch { /* the loop goes on */ } } }`,
    converts: true,
  },
  {
    id: 'loop-try-finally-return',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { try { values.join = Array.prototype.join; return 1; } finally { continue; } } return 0; }`,
    converts: true,
  },
  {
    id: 'loop-inner-loop-break-then-break',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { for (const text of ['one', 'two']) { values.join = Array.prototype.join; break; } break; } }`,
    converts: false,
  },
  {
    id: 'loop-break-in-selected-branch-after-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { if (error) { values.join = Array.prototype.join; break; } } }`,
    converts: false,
  },
  {
    id: 'loop-labeled-break-of-inner-block',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { stop: { values.join = Array.prototype.join; break stop; } } }`,
    converts: true,
  },
  {
    id: 'loop-labeled-break-of-inner-block-element-write',
    source: `function frames(error: Error) { const values: unknown[] = ['fixed']; for (let pass = 0; pass < 2 && String(values); pass++) { inner: { values[0] = error; break inner; } } }`,
    converts: true,
  },
  {
    id: 'loop-skipped-custom-write-after-caught-throw',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { try { values.join = Array.prototype.join; if (pass === 0) throw error; values.join = () => 'fixed'; } catch { /* skipped */ } } }`,
    converts: true,
  },
  {
    id: 'loop-labeled-break-skips-custom-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { skip: { values.join = Array.prototype.join; if (pass === 0) break skip; values.join = () => 'fixed'; } } }`,
    converts: true,
  },
  {
    id: 'loop-switch-break-skips-custom-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { switch (pass) { default: { values.join = Array.prototype.join; if (pass === 0) break; values.join = () => 'fixed'; } } } }`,
    converts: true,
  },
  {
    id: 'loop-continue-before-exit-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} let pass = 0; while (String(values) === 'fixed') { values.join = Array.prototype.join; if (pass++ < 1) continue; break; } }`,
    converts: true,
  },
  {
    id: 'loop-continue-in-write-block-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} let pass = 0; while (String(values) === 'fixed') { if (pass++ < 1) { values.join = Array.prototype.join; continue; } break; } }`,
    converts: true,
  },
  {
    id: 'loop-conditional-exit-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} let pass = 0; while (String(values) === 'fixed') { values.join = Array.prototype.join; if (pass++ > 1) break; } }`,
    converts: true,
  },
  {
    id: 'loop-exit-before-write-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} let pass = 0; while (String(values) === 'fixed') { if (pass++ > 1) break; values.join = Array.prototype.join; } }`,
    converts: true,
  },
  {
    id: 'loop-exit-after-write-of-outer-loop-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let outer = 0; outer < 2; outer++) { while (String(values) === 'fixed') { values.join = Array.prototype.join; break; } } }`,
    converts: true,
  },
  {
    id: 'loop-restoration-then-custom-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; values.join = () => 'fixed'; } }`,
    converts: false,
  },
  {
    id: 'loop-branch-restoration-then-custom-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { if (pass > 0) { values.join = Array.prototype.join; } values.join = () => 'fixed'; } }`,
    converts: false,
  },
  {
    id: 'loop-unknown-write-then-custom-write',
    source: `function frames(error: Error) { const values = [error]; const choices = [() => 'also fixed', Array.prototype.join]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = choices[pass] as any; values.join = () => 'fixed'; } }`,
    converts: false,
  },
  {
    id: 'loop-custom-then-restoration-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = () => 'fixed'; values.join = Array.prototype.join; } }`,
    converts: true,
  },
  {
    id: 'loop-continue-between-restoration-and-custom-write-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; if (pass >= 0) continue; values.join = () => 'fixed'; } }`,
    converts: true,
  },
  {
    id: 'loop-custom-write-after-the-loop-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; } values.join = () => 'fixed'; }`,
    converts: true,
  },
  {
    id: 'loop-custom-write-in-inner-loop-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; for (let inner = 0; inner < pass; inner++) { values.join = () => 'fixed'; } } }`,
    converts: true,
  },
  {
    id: 'loop-update-write-then-custom-write-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); values.join = Array.prototype.join) { values.join = () => 'fixed'; } }`,
    converts: true,
  },
  {
    id: 'loop-custom-write-of-another-method-after-restoration-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; values.sort = () => values; } }`,
    converts: true,
  },
  {
    id: 'recursive-iife-own-array-pin',
    source: `function frames(error: Error) { return (function read(pass: number): string { const values = [error]; ${SAFE} const text = values.join((values.join = Array.prototype.join, '')); return pass < 1 ? text + read(pass + 1) : text; })(0); }`,
    converts: false,
  },
  {
    id: 'recursive-iife-later-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (function read(pass: number, text = String(values)): string { values.join = Array.prototype.join; return pass < 1 ? text + read(pass + 1) : text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursive-iife-override-before-each-read-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} const text = String(values); values.join = Array.prototype.join; return pass < 1 ? text + read(pass + 1) : text; })(0); }`,
    converts: false,
  },
] as const;

describe("writes in a call's arguments, after it selected its method", () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'call-callee-order.ts', source);

    expect(convertsError(parsed.sourceFile)).toBe(converts);
  });

  it('drops the value of a method a repeated custom write may replace, and keeps it custom', () => {
    const source =
      "function frames(error: Error) { const values = [error]; values.map = () => 'fixed'; for (let pass = 0; pass < 2 && values.map(String); pass++) { values.map = () => 'again'; } }";
    using api = openTypeScript();
    using parsed = parseModule(api, 'call-callee-order.ts', source);

    expect(overrideFound(parsed.sourceFile, 'map')?.own).toBe(true);
    expect(overrideFound(parsed.sourceFile, 'map')?.value).toBeUndefined();
  });

  it('keeps the selected method for a result-sensitive read', () => {
    const source =
      "function frames(error: Error) { const values = [error]; values.at = () => 'fixed'; return values.at(delete values.at); }";
    using api = openTypeScript();
    using parsed = parseModule(api, 'call-callee-order.ts', source);

    expect(overrideFound(parsed.sourceFile, 'at')?.own).toBe(true);
  });
});

/** Whether a native join, toString, sort or String call in the source converts `error`. */
function convertsError(root: Node): boolean {
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedArrayText(node, words)) return true;
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      framedArrayString(node.arguments[0], words, node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** What the source's call of the method on `values` finds written on it. */
function overrideFound(root: Node, method: string): ArrayMethodOverride | undefined {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === method
    )
      return arrayMethodOverride(node.expression.expression, method, node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no call');
}
