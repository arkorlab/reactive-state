import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString, framedArrayText } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A statement's operands run before its own write: a write nested in a mutator call's arguments
 * comes before the method the call installs, which still holds.
 */
const NATIVE = 'values.join = Array.prototype.join';

const CASES = [
  {
    id: 'reviewed-assign-argument',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: (${NATIVE}), join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'define-property-argument',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { enumerable: ((${NATIVE}), false), value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'accessor-argument',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'data-definition-argument',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty(values, 'join', { value: Array.prototype.join }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'definitions-argument',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperties(values, { join: { get: () => Array.prototype.join, set: () => {} } }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'earlier-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); Object.assign(values, { ignored: (values.join = Array.prototype.join), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'earlier-accessor-assignment',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'earlier-fixed-value',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'earlier-definitions',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperties(values, { join: { get: () => Array.prototype.join, set: () => {} } }); Object.assign(values, { join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'earlier-opaque-definition',
    source: `function frames(error: Error, key: string) { const values = [error]; Object.defineProperty(values, key, { get: () => Array.prototype.join, set: () => {} }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'earlier-writable-value',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'earlier-writable-value-assign',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, enumerable: false }); Object.assign(values, { join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'earlier-writable-definitions',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperties(values, { join: { value: Array.prototype.join, writable: true } }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'earlier-unwritable-value-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: false }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'earlier-configurable-value-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, configurable: true }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'earlier-writable-opaque-pin',
    source: `function frames(error: Error, writable: boolean) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'earlier-custom-value-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'other-key-accessor-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'toString', { get: () => Array.prototype.toString, set: () => {} }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'other-key-definition-pin',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty(values, 'label', { value: 1 }), join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'other-field-argument-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Object.assign(values, { label: ((${NATIVE}), 1) }); return String(values); }`,
    converts: true,
  },
  {
    id: 'later-statement-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.assign(values, { join: () => 'safe' }); flag && (${NATIVE}); return String(values); }`,
    converts: true,
  },
  {
    id: 'replaced-definition',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, configurable: true }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'replaced-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'replaced-definitions',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperties(values, { join: { get: () => Array.prototype.join, set: () => {}, configurable: true } }); Object.defineProperties(values, { join: { value: () => 'safe' } }); return String(values); }`,
    converts: false,
  },
  {
    id: 'deleted-then-assigned',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); delete values.join; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'replaced-nonconfigurable-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'replaced-opaque-pin',
    source: `function frames(error: Error, descriptor: PropertyDescriptor) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', descriptor); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'replaced-dynamic-key-pin',
    source: `function frames(error: Error, key: string) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, key, { value: 1 }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'assigned-configurable-accessor-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'deleted-nonconfigurable-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); delete values.join; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'deleted-in-branch-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); if (flag) delete values.join; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'assigned-assign-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.assign(values, { join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'partial-update-keeps-writable',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'partial-update-keeps-configurable',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'partial-updates-keep-writable',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperties(values, { join: { value: Array.prototype.join, writable: true } }); Object.defineProperties(values, { join: { value: Array.prototype.join } }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'partial-update-generic-keeps-writable',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); Object.defineProperty(values, 'join', { enumerable: false }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'partial-update-after-accessor-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'partial-update-explicit-false-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: false }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'partial-update-to-accessor-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'partial-update-spread-pin',
    source: `function frames(error: Error, descriptor: PropertyDescriptor) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); Object.defineProperty(values, 'join', { ...descriptor }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'partial-update-configurable-explicit-false-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join, configurable: false }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'assigned-then-partial-update',
    source: `function frames(error: Error) { const values = [error]; values.join = Array.prototype.join; Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'assigned-then-accessor-then-definition',
    source: `function frames(error: Error) { const values = [error]; values.join = Array.prototype.join; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'assigned-then-unwritable-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = Array.prototype.join; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: false }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'assigned-in-branch-then-partial-update-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; if (flag) values.join = Array.prototype.join; Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-then-partial-update',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { join: Array.prototype.join }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'assign-then-accessor-then-definition',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { join: Array.prototype.join }); Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'assign-then-unwritable-pin',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { join: Array.prototype.join }); Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: false }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-partial-update-keeps-writable',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); Object.assign(values, { ignored: Object.defineProperty(values, 'join', { value: Array.prototype.join }), join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-partial-update-keeps-configurable',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.assign(values, { ignored: Object.defineProperty(values, 'join', { value: Array.prototype.join }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-partial-update-unwritable-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join }); Object.assign(values, { ignored: Object.defineProperty(values, 'join', { value: Array.prototype.join }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-partial-update-explicit-false-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); Object.assign(values, { ignored: Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: false }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'conditional-assignment-keeps-writable',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); if (flag) values.join = Array.prototype.join; Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'conditional-assign-keeps-writable',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); if (flag) Object.assign(values, { join: Array.prototype.join }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'conditional-delete-loses-writable-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); if (flag) delete values.join; Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'conditional-definition-loses-writable-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); if (flag) Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: false }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'conditional-partial-definition-keeps-writable',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); if (flag) Object.defineProperty(values, 'join', { value: Array.prototype.join }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'conditional-define-properties-keeps-writable',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); if (flag) Object.defineProperties(values, { join: { value: Array.prototype.join } }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'conditional-definition-sets-writable-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join }); if (flag) Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'conditional-opaque-definition-loses-writable-pin',
    source: `function frames(error: Error, flag: boolean, key: string) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); if (flag) Object.defineProperty(values, key, { value: Array.prototype.join }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'initializer-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const replaced = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'initializer-deletes-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const removed = delete values.join; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'assigned-result-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; let replaced: unknown; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); replaced = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'initializer-nonconfigurable-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); const replaced = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'initializer-in-branch-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); if (flag) { const replaced = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'initializer-second-declaration-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const first = 1, replaced = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'destructured-default-after-initializer',
    source: `function frames(error: Error) { const values = [error]; const { ignored = (values.join = Array.prototype.join) } = Object.assign(values, { join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'destructuring-assignment-default-after-initializer',
    source: `function frames(error: Error) { const values = [error]; let ignored: unknown; ({ ignored = (values.join = Array.prototype.join) } = Object.assign(values, { join: () => 'safe' })); return String(values); }`,
    converts: true,
  },
  {
    id: 'array-destructured-default-after-initializer',
    source: `function frames(error: Error) { const values = [error]; const [ignored = (values.join = Array.prototype.join)] = [Object.assign(values, { join: () => 'safe' }) && undefined]; return String(values); }`,
    converts: true,
  },
  {
    id: 'simple-binding-initializer-pin',
    source: `function frames(error: Error) { const values = [error]; const assigned = Object.assign(values, { join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'assigned-to-setter-result-after-call',
    source: `function frames(error: Error) { const values = [error]; const sink = { set result(value: unknown[]) { value.join = Array.prototype.join; } }; sink.result = Object.assign(values, { join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'assigned-to-element-result-after-call',
    source: `function frames(error: Error) { const values = [error]; const sink = { set result(value: unknown[]) { value.join = Array.prototype.join; } }; sink['result'] = Object.assign(values, { join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'assigned-to-member-replaces-accessor-pin',
    source: `function frames(error: Error) { const values = [error]; const sink: { result?: unknown } = {}; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); sink.result = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-definitions-release-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), second: Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }) }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-replacement-after-logical-pin',
    source: `function frames(error: Error) { const values = [error]; String(Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }) && Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-replacement-in-conditional-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), second: flag ? Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }) : 0 }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-replacement-in-optional-chain-pin',
    source: `function frames(error: Error, holder?: { run(value: unknown): unknown }) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), second: holder?.run(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })) }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-accessor-after-replacement-pin',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }), second: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }) }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'prototype-descriptor-accessor-nested',
    source: `function frames(error: Error) { const values = [error]; values.join = Array.prototype.join; Object.assign(values, { ignored: Object.defineProperty(values, 'join', { __proto__: { get: () => Array.prototype.join, set: () => {} } } as PropertyDescriptor), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'prototype-descriptor-definition',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { __proto__: { value: () => 'safe' } } as PropertyDescriptor); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-replacement-in-binding-default-pin',
    source: `function frames(error: Error, holder: { x?: unknown }) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const { x = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }) } = holder; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-replacement-in-assignment-default-pin',
    source: `function frames(error: Error, holder: { x?: unknown }) { const values = [error]; let x: unknown; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); ({ x = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }) } = holder); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-replacement-in-array-default-pin',
    source: `function frames(error: Error, holder: unknown[]) { const values = [error]; let x: unknown; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); [x = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })] = holder; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-replacement-in-loop-head-pin',
    source: `function frames(error: Error, lists: unknown[][]) { const values = [error]; let x: unknown; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); for ([x = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })] of lists) { } values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-replacement-in-for-increment-pin',
    source: `function frames(error: Error, count: number) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); for (let at = 0; at < count; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })) { at += 1; } values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-operand-definition-runs-first',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true, ignored: Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }) }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-sure-definition-sets-writable',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }) }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-conditional-definition-sets-writable-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.assign(values, { ignored: flag ? Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }) : 0 }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-assignment-sets-writable',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: (values.join = Array.prototype.join) }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-assign-field-sets-writable',
    source: `function frames(error: Error) { const values = [error]; String(Object.assign(values, { join: Array.prototype.join })); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-conditional-assignment-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.assign(values, { ignored: flag ? (values.join = Array.prototype.join) : 0 }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-assignment-over-accessor-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.assign(values, { ignored: (values.join = Array.prototype.join) }); Object.defineProperty(values, 'join', { value: Array.prototype.join }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'optional-chain-base-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })?.length; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'optional-chain-base-element-access',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })?.[0]; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'optional-chain-base-later-links',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })?.length.toFixed(); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'optional-chain-base-of-call-argument',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.keys(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }))?.length; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'optional-chain-base-non-null',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true })?.length!; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'optional-chain-link-argument-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.keys(values)?.at(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }).length); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'optional-chain-element-argument-pin',
    source: `function frames(error: Error, holder?: Record<string, unknown>) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); holder?.[(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), 'run')]; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'optional-call-argument-pin',
    source: `function frames(error: Error, callback?: (value: unknown) => void) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); callback?.(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true })); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'declaration-key-after-initializer',
    source: `function frames(error: Error) { const values = [error]; const { [(Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), 'k')]: unused } = (Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), {}); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'declaration-key-replaces-initializer-accessor',
    source: `function frames(error: Error) { const values = [error]; const { [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), 'k')]: unused } = (Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), {}); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'assignment-pattern-key-after-right',
    source: `function frames(error: Error) { const values = [error]; let unused: unknown; ({ [(Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), 'k')]: unused } = (Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), {})); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'assignment-pattern-key-replaces-right-accessor',
    source: `function frames(error: Error) { const values = [error]; let unused: unknown; ({ [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), 'k')]: unused } = (Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), {})); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'array-pattern-target-after-right',
    source: `function frames(error: Error) { const values = [error]; const sink: Record<string, unknown> = {}; [sink[(Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), 'k')]] = (Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), [1]); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'array-pattern-target-replaces-right-accessor',
    source: `function frames(error: Error) { const values = [error]; const sink: Record<string, unknown> = {}; [sink[(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), 'k')]] = (Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), [1]); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-default-before-nested-pattern',
    source: `function frames(error: Error) { const values = [error]; const { k: { [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), 'j')]: unused } = (Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), {}) } = { k: undefined }; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-default-pattern-key-pin',
    source: `function frames(error: Error) { const values = [error]; const { k: { [(Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), 'j')]: unused } = (Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), {}) } = { k: undefined }; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-assignment-default-before-pattern',
    source: `function frames(error: Error) { const values = [error]; let unused: unknown; ({ k: { [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), 'j')]: unused } = (Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), {}) } = { k: undefined }); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-assignment-creates-configurable',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: (values.join = Array.prototype.join) }); Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'assignment-creates-configurable',
    source: `function frames(error: Error) { const values = [error]; values.join = Array.prototype.join; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-assignment-after-unknown-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; if (flag) { Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); } Object.assign(values, { ignored: (values.join = Array.prototype.join) }); Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-assignment-after-fixed-accessor-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); Object.assign(values, { ignored: (values.join = Array.prototype.join) }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-conditional-assignment-created-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.assign(values, { ignored: flag ? (values.join = Array.prototype.join) : 0 }); Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }); Object.defineProperty(values, 'join', { value: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'class-field-initializer-is-deferred',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), ignored: class { field = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); }, join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'class-private-field-initializer-is-deferred',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), ignored: class { #field = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); }, join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'class-static-field-initializer-runs',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), ignored: class { static field = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); }, join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'class-computed-key-runs',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), ignored: class { [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }), 'key')] = 1; }, join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'class-method-body-is-deferred',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), ignored: class { method() { return Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } }, join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'class-static-then-computed-key-order',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: class { static field = Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), 'key')] = 1; }, join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'class-computed-then-static-key-order',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: class { static field = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); [(Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), 'key')] = 1; }, join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'class-static-block-after-computed-key',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: class { static { Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); } [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), 'key')] = 1; }, join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'class-method-key-after-static-initializer',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: class { static field = Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), 'key')]() {} }, join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'class-heritage-before-computed-key',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: class extends (Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), Object) { [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), 'key')] = 1; }, join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'class-computed-key-before-heritage-pin',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: class extends (Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), Object) { [(Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), 'key')] = 1; }, join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'object-method-computed-name-runs',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = { [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }), 'key')]() {} }; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'object-accessor-computed-name-runs',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = { get [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }), 'key')]() { return 1; } }; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'class-method-computed-name-runs',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = class { [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }), 'key')]() {} }; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'object-method-body-is-deferred-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = { method() { return Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } }; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'object-method-parameter-default-is-deferred-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = { method(value = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })) {} }; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'arrow-parameter-default-is-deferred-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = (value = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })) => value; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-instance-initializer-after-static',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: new (class { field = Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); static other = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); })(), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'class-static-block-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = class { static { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } }; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'class-static-block-two-statements-release',
    source: `function frames(error: Error) { const values = [error]; const unused = class { static { Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); } }; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'class-static-block-two-statements-hold',
    source: `function frames(error: Error) { const values = [error]; const unused = class { static { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); } }; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-static-block-plain-block',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = class { static { { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } } }; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'class-static-block-declaration',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = class { static { const done = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } }; values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'class-static-block-in-argument',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), ignored: class { static { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } }, join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'class-static-block-branch-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = class { static { if (flag) Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } }; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-static-block-loop-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = class { static { for (let at = 0; at < 1; at += 1) Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } }; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-static-block-try-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = class { static { try { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } catch {} } }; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-static-block-in-method-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = { method() { return class { static { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } }; } }; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-static-block-conditional-class-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const unused = flag ? class { static { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } } : 0; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
] as const;

describe('writes a definite method write evaluates first', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'argument-write-order.ts', source);

    expect(convertsError(parsed.sourceFile)).toBe(converts);
  });
});

/** Whether a native join, toString or String call in the source converts the `error` element. */
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
