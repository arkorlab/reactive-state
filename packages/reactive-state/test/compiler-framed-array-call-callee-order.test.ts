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
