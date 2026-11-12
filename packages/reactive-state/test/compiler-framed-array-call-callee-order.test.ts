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
    id: 'loop-try-around-inner-loop-proof-in-try-pin',
    source: `function frames(error: Error) { const values = [error]; for (let outer = 0; outer < 2; outer++) { try { ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; if (outer === 0) throw error; values.join = () => 'fixed'; } } catch { /* the outer loop goes on */ } } }`,
    converts: false,
  },
  {
    id: 'loop-try-around-inner-loop-proof-outside-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let outer = 0; outer < 2; outer++) { try { for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; if (outer === 0) throw error; values.join = () => 'fixed'; } } catch { /* the outer loop goes on */ } } }`,
    converts: true,
  },
  {
    id: 'loop-labeled-break-of-the-loop',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} outer: while (String(values) === 'fixed') { values.join = Array.prototype.join; break outer; } }`,
    converts: false,
  },
  {
    id: 'loop-labeled-break-of-an-outer-loop',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} outer: while (String(values) === 'fixed') { for (const text of ['one', 'two']) { values.join = Array.prototype.join; break outer; } } }`,
    converts: false,
  },
  {
    id: 'loop-finally-return-after-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { try { values.join = Array.prototype.join; return 1; } finally { /* nothing */ } } return 0; }`,
    converts: false,
  },
  {
    id: 'loop-overwrite-in-try-finally',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { try { values.join = Array.prototype.join; values.join = () => 'fixed'; } finally { /* nothing */ } } }`,
    converts: false,
  },
  {
    id: 'loop-finally-continue-skips-overwrite-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { try { values.join = Array.prototype.join; if (pass === 0) throw error; values.join = () => 'fixed'; } finally { continue; } } }`,
    converts: true,
  },
  {
    id: 'loop-outer-catch-skips-overwrite-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { try { try { values.join = Array.prototype.join; if (pass === 0) throw error; values.join = () => 'fixed'; } finally { /* nothing */ } } catch { /* the loop goes on */ } } }`,
    converts: true,
  },
  {
    id: 'loop-unreachable-continue-before-custom-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; if (false) continue; values.join = () => 'fixed'; } }`,
    converts: false,
  },
  {
    id: 'loop-unreachable-break-before-custom-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { switch (pass) { default: { values.join = Array.prototype.join; if (false) break; values.join = () => 'fixed'; } } } }`,
    converts: false,
  },
  {
    id: 'loop-finally-unreachable-continue',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { try { values.join = Array.prototype.join; if (pass === 0) throw error; values.join = () => 'fixed'; } finally { if (false) continue; } } }`,
    converts: false,
  },
  {
    id: 'loop-selected-continue-before-custom-write-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; if (true) continue; values.join = () => 'fixed'; } }`,
    converts: true,
  },
  {
    id: 'loop-finally-inner-block-break-after-return',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { try { values.join = Array.prototype.join; return 1; } finally { inner: { break inner; } } } return 0; }`,
    converts: false,
  },
  {
    id: 'loop-overwrite-in-try-finally-inner-loop-break',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { try { values.join = Array.prototype.join; values.join = () => 'fixed'; } finally { for (;;) { break; } } } }`,
    converts: false,
  },
  {
    id: 'loop-pending-continue-through-finally-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} let guard = 0; while (String(values) === 'fixed' && guard++ < 3) { try { continue; } finally { values.join = Array.prototype.join; } break; } }`,
    converts: true,
  },
  {
    id: 'loop-finally-break-cancels-pending-continue',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} while (String(values) === 'fixed') { try { continue; } finally { values.join = Array.prototype.join; break; } } }`,
    converts: false,
  },
  {
    id: 'loop-catch-between-write-and-return-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} let pass = 0; while (String(values) === 'fixed') { try { values.join = Array.prototype.join; if (pass++ === 0) throw error; return 1; } catch { /* the loop goes on */ } } return 0; }`,
    converts: true,
  },
  {
    id: 'loop-iife-return-skips-custom-write',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { (function once() { values.join = Array.prototype.join; if (pass === 0) return; values.join = () => 'fixed'; })(); } }`,
    converts: true,
  },
  {
    id: 'loop-iife-return-after-custom-write-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { (function once() { values.join = Array.prototype.join; values.join = () => 'fixed'; if (pass === 0) return; })(); } }`,
    converts: false,
  },
  {
    id: 'loop-callback-return-between-writes-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; [1].forEach((each) => { return each; }); values.join = () => 'fixed'; } }`,
    converts: false,
  },
  {
    id: 'loop-jump-in-sibling-else-branch',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { if (pass > 5) { values.join = Array.prototype.join; } else { continue; } values.join = () => 'fixed'; } }`,
    converts: false,
  },
  {
    id: 'loop-jump-in-later-branch-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2 && String(values); pass++) { values.join = Array.prototype.join; if (pass > 5) { values.join = Array.prototype.join; } else { continue; } values.join = () => 'fixed'; } }`,
    converts: true,
  },
  {
    id: 'recursion-between-proof-and-read',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-nested-function-between-proof-and-read',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} const again = () => read(pass + 1); if (pass < 1) again(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-before-proof-keeps-proof',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { if (pass < 1) read(pass + 1); ${SAFE} const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-later-helper-between-proof-and-read',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} if (pass < 1) again(); const text = String(values); values.join = Array.prototype.join; return text; function again() { read(pass + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-later-helper-before-proof-keeps-proof',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { if (pass < 1) again(); ${SAFE} const text = String(values); values.join = Array.prototype.join; return text; function again() { read(pass + 1); } })(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-unreachable-helper-call',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { if (pass < 1) again(); ${SAFE} if (false) again(); const text = String(values); values.join = Array.prototype.join; return text; function again() { read(pass + 1); } })(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-unreachable-helper-only',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} if (false) again(); const text = String(values); values.join = Array.prototype.join; return text; function again() { read(pass + 1); } })(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-helper-hidden-by-nested-helper-of-the-same-name',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { function unused() { function again() { return 0; } again(); } unused(); ${SAFE} if (pass < 1) again(); const text = String(values); values.join = Array.prototype.join; return text; function again() { read(pass + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'recursive-loop-exit-element-write',
    source: `function frames(error: Error) { const values: unknown[] = ['fixed']; (function read(pass: number): string { while (String(values)) { values[0] = error; return pass < 1 ? read(pass + 1) : ''; } return ''; })(0); }`,
    converts: true,
  },
  {
    id: 'named-iife-loop-exit-element-write-pin',
    source: `function frames(error: Error) { const values: unknown[] = ['fixed']; (function read(pass: number): number { while (String(values)) { values[0] = error; return 1; } return 0; })(0); }`,
    converts: false,
  },
  {
    id: 'loop-exit-with-unreachable-self-call',
    source: `function frames(error: Error) { const values = [error]; (function read(): void { ${SAFE} while (String(values) === 'fixed') { values.join = Array.prototype.join; break; } if (false) read(); })(); }`,
    converts: false,
  },
  {
    id: 'loop-exit-with-shadowed-name',
    source: `function frames(error: Error) { const values: unknown[] = ['fixed']; (function read(read = () => 0): number { while (String(values)) { values[0] = error; return read(); } return 0; })(); }`,
    converts: false,
  },
  {
    id: 'recursion-through-declaration-between-proof-and-read',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-bound-arrow-between-proof-and-read',
    source: `function frames(error: Error) { const values = [error]; const read = (pass: number): string => { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; return read(0); }`,
    converts: true,
  },
  {
    id: 'mutual-recursion-between-proof-and-read',
    source: `function frames(error: Error) { const values = [error]; function first(pass: number): string { ${SAFE} if (pass < 1) second(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } function second(pass: number): string { return first(pass); } return first(0); }`,
    converts: true,
  },
  {
    id: 'recursion-after-read-in-declaration-pin',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} const text = String(values); values.join = Array.prototype.join; return pass < 1 ? text + read(pass + 1) : text; } return read(0); }`,
    converts: false,
  },
  {
    id: 'recursive-declaration-loop-exit-element-write',
    source: `function frames(error: Error) { const values: unknown[] = ['fixed']; function read(pass: number): string { while (String(values)) { values[0] = error; return pass < 1 ? read(pass + 1) : ''; } return ''; } read(0); }`,
    converts: true,
  },
  {
    id: 'declaration-loop-exit-element-write-pin',
    source: `function frames(error: Error) { const values: unknown[] = ['fixed']; function read(pass: number): number { while (String(values)) { values[0] = error; return 1; } return 0; } read(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-variable-of-another-name',
    source: `function frames(error: Error) { const values = [error]; const read = function inner(pass: number) { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-assigned-function',
    source: `function frames(error: Error) { const values = [error]; let read; read = function (pass: number) { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-assigned-arrow',
    source: `function frames(error: Error) { const values = [error]; let read; read = (pass: number) => { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-property-function',
    source: `function frames(error: Error) { const values = [error]; const o = { read: function (pass: number) { ${SAFE} if (pass < 1) o.read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } }; return o.read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-object-method',
    source: `function frames(error: Error) { const values = [error]; const o = { read(pass: number) { ${SAFE} if (pass < 1) this.read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } }; return o.read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-class-method',
    source: `function frames(error: Error) { const values = [error]; class C { read(pass: number) { ${SAFE} if (pass < 1) this.read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } } return new C().read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-class-field-arrow',
    source: `function frames(error: Error) { const values = [error]; class C { read = (pass: number) => { ${SAFE} if (pass < 1) this.read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; } return new C().read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-static-method',
    source: `function frames(error: Error) { const values = [error]; class C { static read(pass: number) { ${SAFE} if (pass < 1) C.read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } } return C.read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-getter',
    source: `function frames(error: Error) { const values = [error]; let n = 0; const o = { get x() { ${SAFE} if (n++ < 1) o.x; const text = String(values); values.join = Array.prototype.join; return text; } }; return o.x; }`,
    converts: true,
  },
  {
    id: 'recursion-through-call-method',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number) { ${SAFE} if (pass < 1) read.call(null, pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-apply-method',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number) { ${SAFE} if (pass < 1) read.apply(null, [pass + 1]); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-new',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number) { ${SAFE} if (pass < 1) new read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-tagged-template',
    source: `function frames(error: Error) { const values = [error]; let n = 0; function read() { ${SAFE} if (n++ < 1) read\`\`; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-optional-call',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number) { ${SAFE} if (pass < 1) read?.(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-alias-before-proof',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number) { const r = read; ${SAFE} if (pass < 1) r(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-bound-function',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number) { const r = read.bind(null); ${SAFE} if (pass < 1) r(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-function-in-array',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number) { const fns = [read]; ${SAFE} if (pass < 1) fns[0](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-escaped-function',
    source: `function frames(error: Error) { const values = [error]; const handlers = []; function read(pass: number) { ${SAFE} if (pass < 1) handlers[0](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } handlers.push(read); return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-getter-helper',
    source: `function frames(error: Error) { const values = [error]; const o = { get again() { return read(1); } }; function read(pass: number) { ${SAFE} if (pass < 1) o.again; const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-value-of-helper',
    source: `function frames(error: Error) { const values = [error]; const o = { valueOf() { return read(1); } }; function read(pass: number) { ${SAFE} if (pass < 1) +o; const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-to-primitive-helper',
    source: `function frames(error: Error) { const values = [error]; const o = { [Symbol.toPrimitive]() { return read(1); } }; function read(pass: number) { ${SAFE} if (pass < 1) +o; const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-iterator-helper',
    source: `function frames(error: Error) { const values = [error]; const o = { [Symbol.iterator]() { read(1); return [][Symbol.iterator](); } }; function read(pass: number) { ${SAFE} if (pass < 1) for (const x of o) {} const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-to-string-helper',
    source: `function frames(error: Error) { const values = [error]; const o = { toString() { return String(read(1)); } }; function read(pass: number) { ${SAFE} if (pass < 1) \`\${o}\`; const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-only-in-unreachable-call-of-helper',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number) { ${SAFE} again(); const text = String(values); values.join = Array.prototype.join; return text; } function again() { if (false) read(1); } return read(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-constructor',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; class C { constructor(pass: number) { ${SAFE} if (pass < 1) new C(pass + 1); seen += String(values); values.join = Array.prototype.join; } } new C(0); return seen; }`,
    converts: true,
  },
  {
    id: 'recursion-through-setter',
    source: `function frames(error: Error) { const values = [error]; let n = 0; const o = { set x(v) { ${SAFE} if (n++ < 1) o.x = 1; const text = String(values); values.join = Array.prototype.join; } }; o.x = 0; return String(values); }`,
    converts: true,
  },
  {
    id: 'recursion-after-read-in-declaration-again-pin',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number) { ${SAFE} const text = String(values); values.join = Array.prototype.join; return pass < 1 ? text + read(pass + 1) : text; } return read(0); }`,
    converts: false,
  },
  {
    id: 'declaration-calling-its-parameter-pin',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number, again: (next: number) => string): string { ${SAFE} if (pass < 1) again(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0, () => 'x'); }`,
    converts: false,
  },
  {
    id: 'declaration-calling-an-inner-function-of-its-name-pin',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} if (pass < 1) { function read(inner: number) { return inner; } read(1); } const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-computed-key',
    source: `function frames(error: Error) { const values = [error]; const o: any = { read(pass: number): string { ${SAFE} if (pass < 1) o['re' + 'ad'](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } }; return o.read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-getter-by-destructuring',
    source: `function frames(error: Error) { const values = [error]; let n = 0; function read(): string { ${SAFE} const { x } = read as any; const text = String(values); values.join = Array.prototype.join; return text; } Object.defineProperty(read, 'x', { get() { return n++ === 0 ? read() : 0; } }); return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-getter-by-object-spread',
    source: `function frames(error: Error) { const values = [error]; let n = 0; function read(): string { ${SAFE} const copy = { ...(read as any) }; const text = String(values); values.join = Array.prototype.join; return text; } Object.defineProperty(read, 'x', { enumerable: true, get() { return n++ === 0 ? read() : 0; } }); return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-key-coercion',
    source: `function frames(error: Error) { const values = [error]; let n = 0; const key = { toString() { return n++ === 0 ? String(read()) : 'k'; } }; function read(): string { ${SAFE} const o = { [key as any]: 1 }; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: true,
  },
  {
    id: 'escaped-function-with-nothing-between-pin',
    source: `function frames(error: Error) { const values = [error]; const kept: unknown[] = []; function read(): string { ${SAFE} const text = String(values); values.join = Array.prototype.join; return text; } kept.push(read); return read(); }`,
    converts: false,
  },
  {
    id: 'recursion-through-instance-field-initializer',
    source: `function frames(error: Error) { const values = [error]; class Holder { held = read(1); } function read(pass: number): string { ${SAFE} if (pass < 1) new Holder(); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-class-heritage',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} if (pass < 1) { class Derived extends (read(pass + 1), Object) {} } const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-static-field-initializer',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} if (pass < 1) { class Holder { static held = read(pass + 1); } } const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'instance-field-initializer-never-run-pin',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} class Holder { held = read(pass + 1); } const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-satisfies-holder',
    source: `function frames(error: Error) { const values = [error]; const read = ((pass: number): string => { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }) satisfies (pass: number) => string; return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-as-holder',
    source: `function frames(error: Error) { const values = [error]; const read = ((pass: number): string => { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }) as (pass: number) => string; return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-non-null-holder',
    source: `function frames(error: Error) { const values = [error]; const read = (function (pass: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; })!; return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-angle-assertion-holder',
    source: `function frames(error: Error) { const values = [error]; const read = <(pass: number) => string>((pass) => { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }); return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-wrapped-assignment',
    source: `function frames(error: Error) { const values = [error]; let read: any; read = ((pass: number): string => { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }) satisfies Function; return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-wrapped-property',
    source: `function frames(error: Error) { const values = [error]; const o = { read: ((pass: number): string => { ${SAFE} if (pass < 1) o.read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }) satisfies Function }; return o.read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-wrapped-field',
    source: `function frames(error: Error) { const values = [error]; class C { read = ((pass: number): string => { ${SAFE} if (pass < 1) this.read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }) satisfies Function; } return new C().read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-wrapped-class-expression',
    source: `function frames(error: Error) { const values = [error]; let last = ''; const C = (class { constructor(pass: number) { ${SAFE} if (pass < 1) new C(pass + 1); const text = String(values); values.join = Array.prototype.join; last = text; } }) satisfies Function; new C(0); return last; }`,
    converts: true,
  },
  {
    id: 'recursion-through-function-given-to-a-call',
    source: `function frames(error: Error) { const values = [error]; const wrap = (f: any) => f; const read = wrap((pass: number): string => { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }); return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-named-function-given-to-a-call',
    source: `function frames(error: Error) { const values = [error]; const wrap = (f: any) => f; const read = wrap(function inner(pass: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }); return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-function-in-a-list',
    source: `function frames(error: Error) { const values = [error]; const fns: any[] = [(pass: number): string => { ${SAFE} if (pass < 1) fns[0](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }]; return fns[0](0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-function-in-a-condition',
    source: `function frames(error: Error) { const values = [error]; const read: any = true ? (pass: number): string => { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } : null; return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-function-a-call-returns',
    source: `function frames(error: Error) { const values = [error]; const make = () => (pass: number): string => { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; const read = make(); return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-class-given-to-a-call',
    source: `function frames(error: Error) { const values = [error]; let last = ''; const wrap = (c: any) => c; const C = wrap(class { constructor(pass: number) { ${SAFE} if (pass < 1) new C(pass + 1); const text = String(values); values.join = Array.prototype.join; last = text; } }); new C(0); return last; }`,
    converts: true,
  },
  {
    id: 'recursion-through-new-target',
    source: `function frames(error: Error) { const values = [error]; let last = ''; class C { constructor(pass: number) { ${SAFE} if (pass < 1) new (new.target)(pass + 1); const text = String(values); values.join = Array.prototype.join; last = text; } } new C(0); return last; }`,
    converts: true,
  },
  {
    id: 'recursion-through-constructor-property',
    source: `function frames(error: Error) { const values = [error]; let last = ''; class C { constructor(pass: number) { ${SAFE} if (pass < 1) new (this.constructor as any)(pass + 1); const text = String(values); values.join = Array.prototype.join; last = text; } } new C(0); return last; }`,
    converts: true,
  },
  {
    id: 'uncalled-nested-function-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read() { ${SAFE} function unused() { read(); } const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'uncalled-nested-arrow-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read() { ${SAFE} const unused = () => { read(); }; const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'uncalled-nested-method-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read() { ${SAFE} const o = { go() { read(); } }; const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'uncalled-nested-class-method-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read() { ${SAFE} class K { go() { read(); } } const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'nested-function-called-between',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number) { ${SAFE} function helper() { read(pass + 1); } if (pass < 1) helper(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'hoisted-nested-function-called-between',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number) { ${SAFE} if (pass < 1) helper(); const text = String(values); values.join = Array.prototype.join; return text; function helper() { read(pass + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'nested-function-given-to-a-call-called-between',
    source: `function frames(error: Error) { const values = [error]; const wrap = (f: any) => f; return (function read(pass: number): string { const helper = wrap(() => read(pass + 1)); ${SAFE} if (pass < 1) helper(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'stored-callback-between-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read() { ${SAFE} const later: any[] = []; later.push(() => { read(); }); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-satisfies-holder-around-a-loop',
    source: `function frames(error: Error) { const values: unknown[] = ['fixed']; let seen = ''; const read = ((pass: number): string => { while ((seen += String(values) + ',')) { values[0] = error; return pass < 1 ? read(pass + 1) : ''; } return ''; }) satisfies (pass: number) => string; read(0); return seen; }`,
    converts: true,
  },
  {
    id: 'recursion-while-waiting',
    source: `async function frames(error: Error) { const values = [error]; let seen = ''; async function read(pass: number): Promise<string> { ${SAFE} await 0; const text = String(values); values.join = Array.prototype.join; seen += text + ','; return text; } await Promise.all([read(0), read(1)]); return seen; }`,
    converts: true,
  },
  {
    id: 'recursion-while-waiting-in-an-arrow',
    source: `async function frames(error: Error) { const values = [error]; let seen = ''; const read = async (pass: number): Promise<string> => { ${SAFE} await 0; const text = String(values); values.join = Array.prototype.join; seen += text + ','; return text; }; await Promise.all([read(0), read(1)]); return seen; }`,
    converts: true,
  },
  {
    id: 'recursion-while-yielding',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; function* read(pass: number): Generator<number, string> { ${SAFE} yield 0; const text = String(values); values.join = Array.prototype.join; seen += text + ','; return text; } const a = read(0); const b = read(1); a.next(); b.next(); a.next(); b.next(); return seen; }`,
    converts: true,
  },
  {
    id: 'recursion-while-waiting-in-an-argument',
    source: `async function frames(error: Error) { const values = [error]; let seen = ''; async function read(pass: number): Promise<string> { ${SAFE} const text = String(values, await 0); values.join = Array.prototype.join; seen += text + ','; return text; } await Promise.all([read(0), read(1)]); return seen; }`,
    converts: true,
  },
  {
    id: 'async-without-a-wait-pin',
    source: `async function frames(error: Error) { const values = [error]; let seen = ''; async function read(pass: number): Promise<string> { ${SAFE} const text = String(values); values.join = Array.prototype.join; seen += text + ','; return text; } await Promise.all([read(0), read(1)]); return seen; }`,
    converts: false,
  },
  {
    id: 'recursion-in-a-later-argument',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} const text = String(values, pass < 1 ? read(pass + 1) : 0); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-in-an-earlier-argument-pin',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} const text = String(pass < 1 ? read(pass + 1) : 0, values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-class-computed-key',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} if (pass < 1) { class K { static [String(read(pass + 1))] = 1; } } const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-instance-computed-key',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} if (pass < 1) { new (class K { [String(read(pass + 1))] = 1; })(); } const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-static-method-called',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} class K { static m() { read(pass + 1); } } if (pass < 1) K.m(); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'uncalled-static-method-pin',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} class K { static m() { read(pass + 1); } } const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-object-method-computed-name',
    source: `function frames(error: Error) { const values = [error]; let depth = 0; function read(): string { ${SAFE} const o = { [depth++ < 1 ? read() : 'k']() {} }; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-object-getter-computed-name',
    source: `function frames(error: Error) { const values = [error]; let depth = 0; function read(): string { ${SAFE} const o = { get [depth++ < 1 ? read() : 'k']() { return 1; } }; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-class-field-computed-name',
    source: `function frames(error: Error) { const values = [error]; let depth = 0; function read(): string { ${SAFE} class K { [depth++ < 1 ? read() : 'k'] = 1; } const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: true,
  },
  {
    id: 'property-call-is-a-call-pin',
    source: `function frames(error: Error) { const values = [error]; const lib = { read: () => 'x' }; function read(): string { ${SAFE} note(); const text = String(values); values.join = Array.prototype.join; return text; } function note() {} lib.read.call(null); return read(); }`,
    converts: false,
  },
  {
    id: 'property-apply-is-a-call-pin',
    source: `function frames(error: Error) { const values = [error]; const lib = { read: () => 'x' }; function read(): string { ${SAFE} note(); const text = String(values); values.join = Array.prototype.join; return text; } function note() {} lib.read.apply(null, []); return read(); }`,
    converts: false,
  },
  {
    id: 'property-bind-is-an-escape-pin',
    source: `function frames(error: Error) { const values = [error]; const lib = { read: () => 'x' }; function read(): string { ${SAFE} note(); const text = String(values); values.join = Array.prototype.join; return text; } function note() {} lib.read.bind(null); return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-immediate-named-helper-around-a-loop',
    source: `function frames(error: Error) { const values: unknown[] = ['fixed']; let seen = ''; (function read(pass: number): string { while ((seen += String(values) + ',')) { values[0] = error; return (function helper() { return pass < 1 ? read(pass + 1) : ''; })(); } return ''; })(0); return seen; }`,
    converts: true,
  },
  {
    id: 'recursion-through-named-helper-called-with-call',
    source: `function frames(error: Error) { const values: unknown[] = ['fixed']; let seen = ''; (function read(pass: number): string { while ((seen += String(values) + ',')) { values[0] = error; return (function helper() { return pass < 1 ? read(pass + 1) : ''; }).call(null); } return ''; })(0); return seen; }`,
    converts: true,
  },
  {
    id: 'recursion-through-immediate-named-helper',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (function helper() { if (pass < 1) read(pass + 1); })(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-named-helper-made-with-new',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} new (function helper() { if (pass < 1) read(pass + 1); })(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-named-helper-as-a-tag',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (function helper(s: any) { if (pass < 1) read(pass + 1); })\`\`; const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'named-helper-never-called-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (function helper() { read(pass + 1); }); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: false,
  },
  {
    id: 'unreachable-wait-pin',
    source: `async function frames(error: Error) { const values = [error]; let seen = ''; async function read(): Promise<string> { ${SAFE} if (false) await 0; const text = String(values); values.join = Array.prototype.join; seen += text + ','; return text; } await Promise.all([read(), read()]); return seen; }`,
    converts: false,
  },
  {
    id: 'unreachable-yield-pin',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; function* read(): Generator<number, string> { ${SAFE} if (false) yield 0; const text = String(values); values.join = Array.prototype.join; seen += text + ','; return text; } const a = read(); const b = read(); a.next(); b.next(); return seen; }`,
    converts: false,
  },
  {
    id: 'recursion-through-constructor-of-a-class-made-on-the-spot',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} new (class { constructor() { if (pass < 1) read(pass + 1); } })(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-constructor-of-a-named-class-made-on-the-spot',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} new (class Named { constructor() { if (pass < 1) read(pass + 1); } })(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-initializer-of-a-class-made-on-the-spot',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} new (class { x = pass < 1 ? read(pass + 1) : 0; })(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-while-an-immediate-async-function-waits',
    source: `async function frames(error: Error) { const values = [error]; let seen = ''; const read = (pass: number) => { (async () => { ${SAFE} await 0; const text = String(values); values.join = Array.prototype.join; seen += text + ','; })(); }; read(0); read(1); await new Promise((r) => setTimeout(r, 5)); return seen; }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-function-around-an-immediate-async-function',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; const read = (pass: number): void => { (async () => { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; seen += text + ','; })(); }; read(0); return seen; }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-function-around-an-immediate-generator',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; const read = (pass: number): void => { (function* () { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; seen += text + ','; })().next(); }; read(0); return seen; }`,
    converts: true,
  },
  {
    id: 'immediate-async-function-without-a-wait-pin',
    source: `async function frames(error: Error) { const values = [error]; let seen = ''; const read = (pass: number): void => { (async () => { ${SAFE} const text = String(values); values.join = Array.prototype.join; seen += text + ','; })(); }; read(0); read(1); await new Promise((r) => setTimeout(r, 5)); return seen; }`,
    converts: false,
  },
  {
    id: 'class-never-made-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (class { constructor() { read(pass + 1); } }); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: false,
  },
  {
    id: 'uncalled-function-in-a-helper-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function helper() { function unused() { read(); } } })(); }`,
    converts: false,
  },
  {
    id: 'uncalled-arrow-in-a-helper-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function helper() { const unused = () => { read(); }; } })(); }`,
    converts: false,
  },
  {
    id: 'called-function-in-a-helper',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(pass); const text = String(values); values.join = Array.prototype.join; return text; function helper(p: number) { function inner() { if (p < 1) read(p + 1); } inner(); } })(0); }`,
    converts: true,
  },
  {
    id: 'dropped-generator-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (function* helper() { read(pass + 1); })(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: false,
  },
  {
    id: 'dropped-async-generator-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (async function* helper() { read(pass + 1); })(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: false,
  },
  {
    id: 'generator-advanced-on-the-spot',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (function* helper() { if (pass < 1) read(pass + 1); })().next(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'generator-spread',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} [...(function* helper() { if (pass < 1) read(pass + 1); })()]; const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'generator-iterated',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} for (const x of (function* helper() { if (pass < 1) read(pass + 1); })()) {} const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'generator-advanced-after-it-is-made',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { const it = (function* helper() { if (pass < 1) read(pass + 1); })(); ${SAFE} it.next(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'async-function-runs-up-to-its-first-wait',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (async function helper() { if (pass < 1) read(pass + 1); })(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'property-write-of-the-name-pin',
    source: `function frames(error: Error) { const values = [error]; const holder: any = {}; function read(): string { ${SAFE} holder.read = 1; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: false,
  },
  {
    id: 'element-write-of-the-name-pin',
    source: `function frames(error: Error) { const values = [error]; const holder: any = {}; function read(): string { ${SAFE} holder['read'] = 1; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: false,
  },
  {
    id: 'wrapped-property-write-of-the-name-pin',
    source: `function frames(error: Error) { const values = [error]; const holder: any = {}; function read(): string { ${SAFE} (holder.read as any) = 1; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: false,
  },
  {
    id: 'recursion-through-a-setter-the-write-calls',
    source: `function frames(error: Error) { const values = [error]; let depth = 0; const holder = { set x(v: number) { if (depth++ < 1) read(); } }; function read(): string { ${SAFE} holder.x = 1; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-setter-named-like-the-function',
    source: `function frames(error: Error) { const values = [error]; let depth = 0; const holder = { set read(v: number) { if (depth++ < 1) read(); } }; function read(): string { ${SAFE} holder.read = 1; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-defined-setter',
    source: `function frames(error: Error) { const values = [error]; let depth = 0; const holder = {}; Object.defineProperty(holder, 'read', { set(v: number) { if (depth++ < 1) read(); } }); function read(): string { ${SAFE} (holder as any).read = 1; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-setter-a-pattern-writes',
    source: `function frames(error: Error) { const values = [error]; let depth = 0; const holder = { set read(v: number) { if (depth++ < 1) read(); } }; function read(): string { ${SAFE} ({ a: holder.read } = { a: 1 }); const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-in-the-key-of-a-write',
    source: `function frames(error: Error) { const values = [error]; let depth = 0; const holder: any = { get [String(1)]() { return 1; } }; function read(pass: number): string { ${SAFE} holder[pass < 1 ? read(pass + 1) : 0] = 1; const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'unused-class-field-in-a-helper-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function helper() { class Unused { x = read(); } } })(); }`,
    converts: false,
  },
  {
    id: 'unused-class-expression-field-in-a-helper-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function helper() { const Unused = class { x = read(); }; } })(); }`,
    converts: false,
  },
  {
    id: 'class-field-built-in-a-helper',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(pass); const text = String(values); values.join = Array.prototype.join; return text; function helper(p: number) { class Used { x = p < 1 ? read(p + 1) : 0; } new Used(); } })(0); }`,
    converts: true,
  },
  {
    id: 'class-field-built-on-the-spot-in-a-helper',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(pass); const text = String(values); values.join = Array.prototype.join; return text; function helper(p: number) { new (class { x = p < 1 ? read(p + 1) : 0; })(); } })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-field-of-a-class-given-to-a-call',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { const wrap = (c: any) => c; const K = wrap(class { x = pass < 1 ? read(pass + 1) : 0; }); ${SAFE} new K(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-field-of-a-class-in-a-list',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { const ks = [class { x = pass < 1 ? read(pass + 1) : 0; }]; ${SAFE} new ks[0](); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'class-field-never-built-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { class K { x = pass < 1 ? read(pass + 1) : 0; } ${SAFE} const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-field-of-the-parent-class',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { class A { x = pass < 1 ? read(pass + 1) : 0; } class B extends A {} ${SAFE} new B(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'named-generator-made-and-dropped-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper() { read(); } })(); }`,
    converts: false,
  },
  {
    id: 'generator-method-an-object-holds-is-reached-by-its-keys-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} ({ *helper() { read(); } }).helper(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'generator-made-and-dropped-in-a-helper-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} g(); const text = String(values); values.join = Array.prototype.join; return text; function g() { helper(); } function* helper() { read(); } })(); }`,
    converts: false,
  },
  {
    id: 'generator-made-before-the-proof-and-advanced-between',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { const it = helper(pass); ${SAFE} it.next(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: number) { if (p < 1) read(p + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'named-generator-advanced-on-the-spot',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(pass).next(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: number) { if (p < 1) read(p + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'named-generator-kept-then-advanced',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} const it = helper(pass); it.next(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: number) { if (p < 1) read(p + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'named-generator-iterated',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} for (const x of helper(pass)) {} const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: number) { if (p < 1) read(p + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'named-generator-spread',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} [...helper(pass)]; const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: number) { if (p < 1) read(p + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'named-generator-delegated-to',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} [...outer(pass)]; const text = String(values); values.join = Array.prototype.join; return text; function* outer(p: number) { yield* helper(p); } function* helper(p: number) { if (p < 1) read(p + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'plain-method-sharing-a-generators-name',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string { ${SAFE} if (pass < 1) plain.helper(pass); const text = String(values); values.join = Array.prototype.join; return text; } const gens = { *helper() { read(1); } }; const plain = { helper(p: number) { read(p + 1); } }; return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-outer-target-of-a-chained-assignment',
    source: `function frames(error: Error) { const values = [error]; let a: any, b: any, c: any; const o: any = {}; a = b = (pass: number): string => { ${SAFE} if (pass < 1) a(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; return b(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-inner-target-of-a-chained-assignment',
    source: `function frames(error: Error) { const values = [error]; let a: any, b: any, c: any; const o: any = {}; a = b = (pass: number): string => { ${SAFE} if (pass < 1) b(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; return a(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-outermost-of-three-targets',
    source: `function frames(error: Error) { const values = [error]; let a: any, b: any, c: any; const o: any = {}; a = b = c = (pass: number): string => { ${SAFE} if (pass < 1) a(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; return c(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-an-outer-target-read-by-another-name',
    source: `function frames(error: Error) { const values = [error]; let a: any, b: any, c: any; const o: any = {}; a = b = (pass: number): string => { ${SAFE} if (pass < 1) a(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; const d = a; return d(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-property-target-of-a-chain',
    source: `function frames(error: Error) { const values = [error]; let a: any, b: any, c: any; const o: any = {}; o.x = b = (pass: number): string => { ${SAFE} if (pass < 1) o.x(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; return b(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-chain-in-a-property-value',
    source: `function frames(error: Error) { const values = [error]; let a: any, b: any, c: any; const o: any = {}; const p = { k: a = (pass: number): string => { ${SAFE} if (pass < 1) a(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } }; return p.k(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-wrapped-chain',
    source: `function frames(error: Error) { const values = [error]; let a: any, b: any, c: any; const o: any = {}; a = (b = ((pass: number): string => { ${SAFE} if (pass < 1) a(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }) as any); return b(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-chain-with-a-logical-assignment',
    source: `function frames(error: Error) { const values = [error]; let a: any, b: any, c: any; const o: any = {}; a ||= b = (pass: number): string => { ${SAFE} if (pass < 1) a(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }; return b(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-chain-given-to-a-call',
    source: `function frames(error: Error) { const values = [error]; let a: any, b: any, c: any; const o: any = {}; const keep = (f: any) => f; keep(a = (pass: number): string => { ${SAFE} if (pass < 1) a(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }); return a(0); }`,
    converts: true,
  },
  {
    id: 'chained-assignment-never-read-again-pin',
    source: `function frames(error: Error) { const values = [error]; let a: any, b: any, c: any; const o: any = {}; a = b = (pass: number): string => { ${SAFE} const text = String(values); values.join = Array.prototype.join; return text; }; return b(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-the-default-of-a-dropped-generator',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} if (pass < 1) helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: any = read(pass + 1)) {} })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-default-of-a-dropped-generator-method',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} if (pass < 1) ({ *helper(p: any = read(pass + 1)) {} }).helper(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-helper-in-the-default-of-a-dropped-generator',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} if (pass < 1) helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: any = other()) {} function other() { return read(pass + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'dropped-generator-with-a-plain-default-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: any = 1) { read(pass + 1); } })(0); }`,
    converts: false,
  },
  {
    id: 'generators-whose-defaults-make-each-other-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} if (false) a(); const text = String(values); values.join = Array.prototype.join; return text; function* a(x: any = b()) {} function* b(y: any = a()) {} })(); }`,
    converts: false,
  },
  {
    id: 'generator-advanced-only-in-unreachable-code-pin',
    source: `function frames(error: Error) { const values = [error]; function note() {} return (function read(): string { ${SAFE} if (false) helper().next(); note(); const text = String(values); values.join = Array.prototype.join; return text; function* helper() { read(); } })(); }`,
    converts: false,
  },
  {
    id: 'generator-spread-only-in-unreachable-code-pin',
    source: `function frames(error: Error) { const values = [error]; function note() {} return (function read(): string { ${SAFE} if (false) [...helper()]; note(); const text = String(values); values.join = Array.prototype.join; return text; function* helper() { read(); } })(); }`,
    converts: false,
  },
  {
    id: 'generator-advanced-in-reachable-code',
    source: `function frames(error: Error) { const values = [error]; function note() {} return (function read(pass: number): string { ${SAFE} if (true) helper(pass).next(); note(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: number) { if (p < 1) read(p + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'dead-default-of-a-dropped-generator-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: any = false ? read() : 1) { read(); } })(); }`,
    converts: false,
  },
  {
    id: 'dead-default-in-the-other-arm-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: any = true ? 1 : read()) { read(); } })(); }`,
    converts: false,
  },
  {
    id: 'dead-default-of-a-generator-method-an-object-holds-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} ({ *helper(p: any = false ? read() : 1) { read(); } }).helper(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'live-default-of-a-dropped-generator',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: any = pass < 1 ? read(pass + 1) : 1) {} })(0); }`,
    converts: true,
  },
  {
    id: 'live-default-in-a-constant-arm',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(p: any = true ? (pass < 1 ? read(pass + 1) : 1) : 2) {} })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-default-of-an-immediate-generator',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (function* (next: any = pass < 1 ? read(pass + 1) : '') {})(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-default-of-a-generator-called-with-call',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (function* (next: any = pass < 1 ? read(pass + 1) : '') {}).call(null); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-default-of-an-immediate-async-generator',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (async function* (next: any = pass < 1 ? read(pass + 1) : '') {})(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'dead-default-of-an-immediate-generator-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (function* (next: any = false ? read(pass + 1) : '') { read(pass + 1); })(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: false,
  },
  {
    id: 'immediate-generator-with-a-plain-default-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (function* (next: any = 1) { read(pass + 1); })(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-the-default-of-a-kept-generator',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} const it = (function* (next: any = pass < 1 ? read(pass + 1) : '') {})(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'parameter-named-like-the-function-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(() => 'ok'); const text = String(values); values.join = Array.prototype.join; return text; function helper(read: () => string) { return read(); } })(); }`,
    converts: false,
  },
  {
    id: 'parameter-named-like-a-helper-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} (function (helper: () => any) { helper(); })(() => 1); const text = String(values); values.join = Array.prototype.join; return text; function helper() { if (pass < 1) read(pass + 1); } })(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-a-parameter-given-a-caller',
    source: `function frames(error: Error) { const values = [error]; return (function go(pass: number): string { ${SAFE} helper(pass); const text = String(values); values.join = Array.prototype.join; return text; function helper(read: any) { read = () => { if (pass < 1) go(pass + 1); }; read(); } })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-function-passed-as-an-argument',
    source: `function frames(error: Error) { const values = [error]; return (function go(pass: number): string { ${SAFE} helper(go, pass); const text = String(values); values.join = Array.prototype.join; return text; function helper(f: any, p: number) { if (p < 1) f(p + 1); } })(0); }`,
    converts: true,
  },
  {
    id: 'parameter-of-another-name-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(() => 'ok'); const text = String(values); values.join = Array.prototype.join; return text; function helper(other: () => string) { return other(); } function again() { read(1); } })(0); }`,
    converts: false,
  },
  {
    id: 'unused-class-in-the-default-of-a-generator-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(next: any = (() => { class Unused { text = read(); } })()) { read(); } })(); }`,
    converts: false,
  },
  {
    id: 'class-built-in-the-default-of-a-generator',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(next: any = (() => { class Used { text = pass < 1 ? read(pass + 1) : ''; } new Used(); })()) {} })(0); }`,
    converts: true,
  },
  {
    id: 'default-function-of-a-dropped-generator-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(next: any = () => read()) {} })(); }`,
    converts: false,
  },
  {
    id: 'default-function-of-a-helper-never-called-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function helper(next: any = () => read()) {} })(); }`,
    converts: false,
  },
  {
    id: 'default-function-the-helper-calls',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function helper(next: any = () => { if (pass < 1) read(pass + 1); }) { next(); } })(0); }`,
    converts: true,
  },
  {
    id: 'default-function-the-helper-keeps',
    source: `function frames(error: Error) { const values = [error]; let kept: any; return (function read(pass: number): string { ${SAFE} helper(); kept(); const text = String(values); values.join = Array.prototype.join; return text; function helper(next: any = () => { if (pass < 1) read(pass + 1); }) { kept = next; } })(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-template-key',
    source: `function frames(error: Error) { const values = [error]; const helper = { again(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) helper[\`again\`](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-wrapped-key',
    source: `function frames(error: Error) { const values = [error]; const helper = { again(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) helper[('again' as const)](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'write-through-a-template-key-pin',
    source: `function frames(error: Error) { const values = [error]; const helper: any = {}; function read(): string { ${SAFE} helper[\`read\`] = 1; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: false,
  },
  {
    id: 'recursion-through-a-getter-in-an-immediate-arrow',
    source: `function frames(error: Error) { const values = [error]; let n = 0; const o = { get x() { if (n++ === 0) read(); return 0; } }; function read(): string { return (() => { ${SAFE} o['x' + '']; const text = String(values); values.join = Array.prototype.join; return text; })(); } return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-getter-in-an-immediate-function',
    source: `function frames(error: Error) { const values = [error]; let n = 0; const o = { get x() { if (n++ === 0) read(); return 0; } }; function read(): string { return (function () { ${SAFE} o['x' + '']; const text = String(values); values.join = Array.prototype.join; return text; })(); } return read(); }`,
    converts: true,
  },
  {
    id: 'getter-in-an-arrow-never-called-pin',
    source: `function frames(error: Error) { const values = [error]; let n = 0; const o = { get x() { if (n++ === 0) read(); return 0; } }; function read(): string { ${SAFE} const later = () => o['x' + '']; const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: false,
  },
  {
    id: 'default-function-in-a-parameter-of-any-name-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function* helper(cb: any = () => read()) {} })(); }`,
    converts: false,
  },
  {
    id: 'default-function-in-a-parameter-of-any-name-called',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { ${SAFE} helper(); const text = String(values); values.join = Array.prototype.join; return text; function helper(cb: any = () => { if (pass < 1) read(pass + 1); }) { cb(); } })(0); }`,
    converts: true,
  },
  {
    id: 'variable-named-like-an-implicit-method-called',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { const next = () => { if (pass < 1) read(pass + 1); }; ${SAFE} next(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'function-named-like-an-implicit-method-called',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { function toString() { if (pass < 1) read(pass + 1); } ${SAFE} toString(); const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'method-the-iteration-calls',
    source: `function frames(error: Error) { const values = [error]; return (function read(pass: number): string { const it = { [Symbol.iterator]() { return { next() { if (pass < 1) read(pass + 1); return { done: true, value: undefined }; } }; } }; ${SAFE} for (const x of it as any) {} const text = String(values); values.join = Array.prototype.join; return text; })(0); }`,
    converts: true,
  },
  {
    id: 'method-the-wait-calls',
    source: `async function frames(error: Error) { const values = [error]; let seen = ''; const thenable = { then(r: any) { r(0); } }; async function read(pass: number) { ${SAFE} await thenable; const text = String(values); values.join = Array.prototype.join; seen += text + ','; } await Promise.all([read(0), read(1)]); return seen; }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-private-method-a-method-calls',
    source: `function frames(error: Error) { const values = [error]; class C { #again(p: number): string { return read(p); } call(p: number): string { return this.#again(p); } } function read(pass: number): string { ${SAFE} if (pass < 1) new C().call(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-private-static-method',
    source: `function frames(error: Error) { const values = [error]; class C { static #again(p: number): string { return read(p); } static call(p: number): string { return C.#again(p); } } function read(pass: number): string { ${SAFE} if (pass < 1) C.call(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-private-method-the-constructor-calls',
    source: `function frames(error: Error) { const values = [error]; class C { #again(p: number): void { read(p); } constructor(p: number) { this.#again(p); } } function read(pass: number): string { ${SAFE} if (pass < 1) new C(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'write-of-a-private-field-pin',
    source: `function frames(error: Error) { const values = [error]; class C { #again: number = 0; set(p: number): void { this.#again = p; } } function read(pass: number): string { ${SAFE} new C().set(pass); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: false,
  },
  {
    id: 'accessor-in-unreachable-code-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} if (false) { const unused = { get again() { return read(); } }; } Math.abs(0); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'class-in-unreachable-code-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} if (false) { class U { get again() { return read(); } } } Math.abs(0); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'accessor-in-reachable-code',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} if (true) { const used = { get again() { if (n++ < 1) read(); return 0; } }; used.again; } const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-chain-that-ends-in-an-implicit-property',
    source: `function frames(error: Error) { const values = [error]; let n = 0; let x: any; let y: any; const o: any = {}; function read(): string { ${SAFE} '' + o; const text = String(values); values.join = Array.prototype.join; return text; } o.toString = x = () => { if (n++ === 0) read(); return 'x'; }; return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-chain-into-an-element-property',
    source: `function frames(error: Error) { const values = [error]; let n = 0; let x: any; let y: any; const o: any = {}; function read(): string { ${SAFE} '' + o; const text = String(values); values.join = Array.prototype.join; return text; } o['toString'] = x = () => { if (n++ === 0) read(); return 'x'; }; return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-property-in-the-middle-of-a-chain',
    source: `function frames(error: Error) { const values = [error]; let n = 0; let x: any; let y: any; const o: any = {}; function read(): string { ${SAFE} '' + o; const text = String(values); values.join = Array.prototype.join; return text; } x = o.valueOf = y = () => { if (n++ === 0) read(); return 'x'; }; return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-chain-into-a-property-value',
    source: `function frames(error: Error) { const values = [error]; let n = 0; let x: any; let y: any; const o: any = {}; function read(): string { ${SAFE} \`\${o.p}\`; const text = String(values); values.join = Array.prototype.join; return text; } o.p = { toString: x = () => { if (n++ === 0) read(); return 'x'; } }; return read(); }`,
    converts: true,
  },
  {
    id: 'chain-of-variables-never-called-pin',
    source: `function frames(error: Error) { const values = [error]; let n = 0; let x: any; let y: any; const o: any = {}; function read(): string { ${SAFE} note(); const text = String(values); values.join = Array.prototype.join; return text; } function note() {} x = y = () => { read(); }; return read(); }`,
    converts: false,
  },
  {
    id: 'call-through-a-template-key-is-a-call-pin',
    source: `function frames(error: Error) { const values = [error]; const lib = { read: () => 'x' }; function read(): string { ${SAFE} note(); const text = String(values); values.join = Array.prototype.join; return text; } function note() {} lib[\`read\`].call(null); return read(); }`,
    converts: false,
  },
  {
    id: 'call-through-a-string-key-is-a-call-pin',
    source: `function frames(error: Error) { const values = [error]; const lib = { read: () => 'x' }; function read(): string { ${SAFE} note(); const text = String(values); values.join = Array.prototype.join; return text; } function note() {} lib['read'].apply(null, []); return read(); }`,
    converts: false,
  },
  {
    id: 'call-through-a-wrapped-key-is-a-call-pin',
    source: `function frames(error: Error) { const values = [error]; const lib = { read: () => 'x' }; function read(): string { ${SAFE} note(); const text = String(values); values.join = Array.prototype.join; return text; } function note() {} lib[('read' as const)].call(null); return read(); }`,
    converts: false,
  },
  {
    id: 'bind-through-a-template-key-is-an-escape-pin',
    source: `function frames(error: Error) { const values = [error]; const lib = { read: () => 'x' }; function read(): string { ${SAFE} note(); const text = String(values); values.join = Array.prototype.join; return text; } function note() {} lib[\`read\`].bind(null); return read(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-numeric-key',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { 0(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) helper[0](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-numeric-key-written-with-a-point',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { 1.0(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) helper[1](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-hexadecimal-key',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { 16(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) helper[0x10](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-bigint-key',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { 1(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) helper[1n as any](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-negative-key',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { '-1'(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) helper[-1](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-null-key',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { null(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) helper[null as any](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-key-worked-out',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { again(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) helper['ag' + 'ain'](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-key-held-by-a-constant',
    source: `function frames(error: Error) { const values = [error]; const key = 'again'; const helper: any = { again(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) helper[key](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-key-a-call-gives',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { again(next: number): string { return read(next); } }; function read(pass: number): string { const k = Object.keys(helper)[0]; ${SAFE} if (pass < 1) helper[k](pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-values-of-an-object',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { again(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) Object.values(helper).forEach((f: any) => f(pass + 1)); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-copy-of-an-object',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { again(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} if (pass < 1) { const copy = { ...helper }; copy.again(pass + 1); } const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-method-found-by-its-name-at-run-time',
    source: `function frames(error: Error) { const values = [error]; class C { again(next: number): string { return read(next); } } function read(pass: number): string { ${SAFE} if (pass < 1) { const m = Object.getOwnPropertyNames(C.prototype).filter((n) => n !== 'constructor')[0]; (new C() as any)[m](pass + 1); } const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'method-never-reached-pin',
    source: `function frames(error: Error) { const values = [error]; const helper: any = { again(next: number): string { return read(next); } }; function read(pass: number): string { ${SAFE} const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: false,
  },
  {
    id: 'recursion-through-a-field-arrow-a-method-calls',
    source: `function frames(error: Error) { const values = [error]; class C { helper = (p: number): string => read(p); } function read(pass: number): string { ${SAFE} if (pass < 1) new C().helper(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'field-arrow-never-called-pin',
    source: `function frames(error: Error) { const values = [error]; class C { helper = (p: number): string => read(p); } function read(pass: number): string { ${SAFE} const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: false,
  },
  {
    id: 'accessor-in-a-function-never-called-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} function unused() { const object = { get again() { return read(); } }; } Math.abs(0); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'accessor-in-an-arrow-never-called-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} const unused = () => { const object = { get again() { return read(); } }; }; Math.abs(0); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'accessor-in-a-function-that-is-called',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} function used() { const object = { get again() { if (n++ < 1) read(); return 0; } }; object.again; } used(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'accessor-in-a-function-nested-in-one-never-called-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} function outer() { function inner() { const object = { get again() { return read(); } }; } } Math.abs(0); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'accessor-in-a-function-called-on-the-spot',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} (() => { const object = { get again() { if (n++ < 1) read(); return 0; } }; object.again; })(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-prototype-read-of-extends',
    source: `function frames(error: Error) { const values = [error]; let n = 0; const Base: any = new Proxy(class {}, { get(t: any, k: any) { if (n++ < 1) read(); return t[k]; } }); function read(): string { ${SAFE} class Derived extends Base {} const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: true,
  },
  {
    id: 'class-without-heritage-runs-nothing-pin',
    source: `function frames(error: Error) { const values = [error]; function read(): string { ${SAFE} class Plain { m() { read(); } } const text = String(values); values.join = Array.prototype.join; return text; } return read(); }`,
    converts: false,
  },
  {
    id: 'function-at-the-top-of-a-file-is-taken-to-run',
    source: `function unused() { const object = { get again() { return read(); } }; } function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} Math.abs(0); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-method-the-default-of-a-generator-creates',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} (function* (p: any = +{ valueOf() { if (n++ < 1) read(); return 0; } }) {})(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-getter-the-default-of-a-generator-creates',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} (function* (p: any = { get again() { if (n++ < 1) read(); return 0; } }.again) {})(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-a-method-the-default-of-an-immediate-function-creates',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} (function (p: any = +{ valueOf() { if (n++ < 1) read(); return 0; } }) {})(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'method-made-in-the-body-of-a-dropped-generator-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} (function* () { const o = { valueOf() { return read(); } }; })(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'accessor-in-a-field-of-a-class-never-built-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} class Unused { object = { get again() { return read(); } }; } Math.abs(0); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'accessor-in-a-field-of-a-class-expression-never-built-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} const Unused = class { object = { get again() { return read(); } }; }; Math.abs(0); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'accessor-in-a-field-of-a-class-that-is-built',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} class Used { object = { get again() { if (n++ < 1) read(); return 0; } }; constructor() { this.object.again; } } new Used(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'accessor-in-a-field-of-a-class-made-on-the-spot',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} new (class { object = { get again() { if (n++ < 1) read(); return 0; } }; constructor() { this.object.again; } })(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'accessor-in-a-static-field-of-a-class',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} class K { static object = { get again() { if (n++ < 1) read(); return 0; } }; static { K.object.again; } } const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'accessor-in-the-body-of-a-generator-whose-iterator-is-dropped-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} function* helper() { const o = { get again() { return read(); } }; o.again; } helper(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'accessor-in-the-body-of-a-dropped-generator-expression-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} const helper = function* () { const o = { get again() { return read(); } }; o.again; }; helper(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'accessor-in-the-body-of-a-generator-that-is-advanced',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} function* helper() { const o = { get again() { if (n++ < 1) read(); return 0; } }; o.again; } [...helper()]; const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'accessor-in-the-body-of-a-generator-advanced-elsewhere',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} function* helper() { const o = { get again() { if (n++ < 1) read(); return 0; } }; o.again; } helper(); const it = helper(); it.next(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'accessor-in-the-default-of-a-generator-whose-iterator-is-dropped',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} function* helper(p: any = { get again() { if (n++ < 1) read(); return 0; } }.again) {} helper(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'accessor-in-the-body-of-a-generator-never-called-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} function* helper() { const o = { get again() { return read(); } }; o.again; } const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'class-builds-itself-in-a-static-block',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} class Unused { object = { again() { if (n++ < 1) read(); } }; constructor() { this.object.again(); } static { new this(); } } const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'class-builds-itself-in-a-static-field',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} class Unused { object = { again() { if (n++ < 1) read(); } }; constructor() { this.object.again(); } static made = new this(); } const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'class-builds-itself-with-reflect',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} class Unused { object = { again() { if (n++ < 1) read(); } }; constructor() { this.object.again(); } static { Reflect.construct(this, []); } } const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'class-static-block-without-this-pin',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} class Unused { object = { again() { if (n++ < 1) read(); } }; constructor() { this.object.again(); } static { n; } } const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: false,
  },
  {
    id: 'class-a-decorator-builds',
    source: `function frames(error: Error) { const values = [error]; let n = 0; const build = (c: any) => new c(); return (function read(): string { ${SAFE} @build class Unused { object = { again() { if (n++ < 1) read(); } }; constructor() { this.object.again(); } } const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'recursion-through-the-constructor-of-an-unnamed-function',
    source: `function frames(error: Error) { const values = [error]; let last = ''; new (function (this: any, pass: number) { ${SAFE} if (pass < 1) new this.constructor(pass + 1); const text = String(values); values.join = Array.prototype.join; last = text; } as any)(0); return last; }`,
    converts: true,
  },
  {
    id: 'recursion-through-new-target-of-an-unnamed-function',
    source: `function frames(error: Error) { const values = [error]; let last = ''; new (function (this: any, pass: number) { ${SAFE} if (pass < 1) new (new.target as any)(pass + 1); const text = String(values); values.join = Array.prototype.join; last = text; } as any)(0); return last; }`,
    converts: true,
  },
  {
    id: 'unnamed-function-made-with-new-without-reentry-pin',
    source: `function frames(error: Error) { const values = [error]; let last = ''; new (function (this: any, pass: number) { ${SAFE} const text = String(values); values.join = Array.prototype.join; last = text; } as any)(0); return last; }`,
    converts: false,
  },
  {
    id: 'accessor-in-a-generator-method-an-object-holds-is-refused-pin',
    source: `function frames(error: Error) { const values = [error]; return (function read(): string { ${SAFE} const holder = { *helper() { const o = { get again() { return read(); } }; o.again; } }; holder.helper(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'generator-method-advanced-by-the-values-of-its-object',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} const holder: any = { *helper() { const o = { get again() { if (n++ < 1) read(); return 0; } }; o.again; } }; Object.values(holder).forEach((f: any) => f().next()); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'generator-method-advanced-by-a-key-worked-out',
    source: `function frames(error: Error) { const values = [error]; let n = 0; return (function read(): string { ${SAFE} const holder: any = { *helper() { const o = { get again() { if (n++ < 1) read(); return 0; } }; o.again; } }; const k = Object.keys(holder)[0]; holder[k]().next(); const text = String(values); values.join = Array.prototype.join; return text; })(); }`,
    converts: true,
  },
  {
    id: 'loop-ends-in-a-return-that-holds-the-write-pin',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; values.join = () => 'fixed'; while ((seen += String(values)) === 'fixed') { return (values.join = Array.prototype.join); } return seen; }`,
    converts: false,
  },
  {
    id: 'loop-ends-in-a-branch-return-that-holds-the-write-pin',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; values.join = () => 'fixed'; let c = true; while ((seen += String(values)) === 'fixed') { if (c) return (values.join = Array.prototype.join); } return seen; }`,
    converts: false,
  },
  {
    id: 'return-that-holds-the-write-in-a-try-whose-finally-continues',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; values.join = () => 'fixed'; let pass = 0; while ((seen += String(values)) === 'fixed' && pass++ < 2) { try { return (values.join = Array.prototype.join); } finally { continue; } } return seen; }`,
    converts: true,
  },
  {
    id: 'return-that-holds-the-write-in-a-branch-not-taken-pin',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; values.join = () => 'fixed'; let c = false; while ((seen += String(values)) === 'fixed' && !c) { if (c) { return (values.join = Array.prototype.join); } c = true; } return seen; }`,
    converts: false,
  },
  {
    id: 'return-of-a-function-in-the-loop-that-holds-the-write',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; values.join = () => 'fixed'; let pass = 0; while ((seen += String(values)) === 'fixed' && pass++ < 2) { (() => { return (values.join = Array.prototype.join); })(); } return seen; }`,
    converts: true,
  },
  {
    id: 'unused-setter-between-a-proof-and-a-read-pin',
    source: `function frames(error: Error) { const values = [error]; const kept: unknown[] = []; function read(): string { ${SAFE} const unused = { set x(value: number) {} }; const text = String(values); values.join = Array.prototype.join; return text; } kept.push(read); return read(); }`,
    converts: false,
  },
  {
    id: 'unused-constructor-between-a-proof-and-a-read-pin',
    source: `function frames(error: Error) { const values = [error]; const kept: unknown[] = []; function note() {} function read(): string { ${SAFE} class Unused { constructor() { note(); } } const text = String(values); values.join = Array.prototype.join; return text; } kept.push(read); return read(); }`,
    converts: false,
  },
  {
    id: 'unused-class-expression-constructor-between-a-proof-and-a-read-pin',
    source: `function frames(error: Error) { const values = [error]; const kept: unknown[] = []; function note() {} function read(): string { ${SAFE} const Unused = class { constructor() { note(); } }; const text = String(values); values.join = Array.prototype.join; return text; } kept.push(read); return read(); }`,
    converts: false,
  },
  {
    id: 'setter-called-between-a-proof-and-a-read',
    source: `function frames(error: Error) { const values = [error]; let n = 0; const kept: unknown[] = []; function read(): string { ${SAFE} const used = { set x(value: number) { if (n++ < 1) read(); } }; used.x = 1; const text = String(values); values.join = Array.prototype.join; return text; } kept.push(read); return read(); }`,
    converts: true,
  },
  {
    id: 'constructor-called-between-a-proof-and-a-read',
    source: `function frames(error: Error) { const values = [error]; let n = 0; const kept: unknown[] = []; function read(): string { ${SAFE} class Used { constructor() { if (n++ < 1) read(); } } new Used(); const text = String(values); values.join = Array.prototype.join; return text; } kept.push(read); return read(); }`,
    converts: true,
  },
  {
    id: 'loop-body-is-a-return-that-holds-the-write-pin',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; values.join = () => 'fixed'; while ((seen += String(values)) === 'fixed') return (values.join = Array.prototype.join); return seen; }`,
    converts: false,
  },
  {
    id: 'for-body-is-a-return-that-holds-the-write-pin',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; values.join = () => 'fixed'; for (let i = 0; (seen += String(values)) === 'fixed'; i++) return (values.join = Array.prototype.join); return seen; }`,
    converts: false,
  },
  {
    id: 'loop-body-is-a-branch-with-a-return-that-holds-the-write-pin',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; values.join = () => 'fixed'; let c = true; while ((seen += String(values)) === 'fixed') if (c) return (values.join = Array.prototype.join); return seen; }`,
    converts: false,
  },
  {
    id: 'loop-body-is-a-write-that-comes-round',
    source: `function frames(error: Error) { const values = [error]; let seen = ''; values.join = () => 'fixed'; let pass = 0; while ((seen += String(values)) === 'fixed' && pass++ < 2) values.join = Array.prototype.join; return seen; }`,
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
