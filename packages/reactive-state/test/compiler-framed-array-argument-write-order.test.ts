import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isIdentifier,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import {
  arrayMethodOverride,
  framedArrayString,
  framedArrayText,
} from '../src/compiler/framed-arrays.ts';
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
    // Refused since the array is followed only where each mention is known: the answer is held by a static field of a class.
    id: 'class-static-field-initializer-runs',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), ignored: class { static field = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); }, join: () => 'safe' }); return String(values); }`,
    converts: true,
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
    // Refused since the array is followed only where each mention is known: the answer is held by a static field of a class.
    id: 'class-computed-then-static-key-order',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: class { static field = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); [(Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), 'key')] = 1; }, join: () => 'safe' }); return String(values); }`,
    converts: true,
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
  {
    id: 'read-in-class-computed-name-runs-first',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; class K { static y = String(values); [((values.join = Array.prototype.join), 'a')]() {} } return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-class-static-computed-name-runs-first',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; class K { static y = String(values); static [((values.join = Array.prototype.join), 'a')] = 1; } return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-class-expression-computed-name-runs-first',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const K = class { static y = String(values); static [((values.join = Array.prototype.join), 'a')] = 1; }; return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-class-after-heritage-write',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; class K extends ((values.join = Array.prototype.join), Object) { static y = String(values); } return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-static-field-before-static-write-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; class K { static a = String(values); static b = ((values.join = Array.prototype.join), 1); } return values.length; }`,
    converts: false,
  },
  {
    id: 'read-in-static-field-after-static-write',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; class K { static a = String(values); static { values.join = Array.prototype.join; } static c = String(values); } return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-static-field-before-static-block-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; class K { static a = String(values); static { values.join = Array.prototype.join; } } return values.length; }`,
    converts: false,
  },
  {
    id: 'read-in-static-field-after-static-block',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; class K { static { values.join = Array.prototype.join; } static a = String(values); } return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-instance-field-after-static-write',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; class K { x = String(values); static z = ((values.join = Array.prototype.join), 1); } new K(); return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-instance-field-after-later-statement',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; class K { x = String(values); } values.join = Array.prototype.join; new K(); return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-class-expression-instance-field',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const K = class { x = String(values); }; values.join = Array.prototype.join; new K(); return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-method-after-static-write',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; class K { m() { return String(values); } static z = ((values.join = Array.prototype.join), 1); } new K().m(); return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-pattern-key-after-initializer-write',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const { [String(values)]: unused } = ((values.join = Array.prototype.join), {}); return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-assignment-pattern-key-after-right-write',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; let unused: unknown; ({ [String(values)]: unused } = ((values.join = Array.prototype.join), {})); return values.length; }`,
    converts: true,
  },
  {
    id: 'read-in-pattern-key-before-initializer-write-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const { [String(values)]: unused } = {}; (values.join = Array.prototype.join); return values.length; }`,
    converts: false,
  },
  {
    id: 'read-in-argument-before-later-argument-write-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; String(values); Object.assign({}, { first: String(values), second: ((values.join = Array.prototype.join)) }); return values.length; }`,
    converts: false,
  },
  {
    id: 'class-method-decorator-write-runs',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const unused = class { @((values.join = Array.prototype.join), (target: unknown) => target) method() {} }; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-parameter-decorator-write-runs',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const unused = class { method(@((values.join = Array.prototype.join), (target: object, key: string, index: number) => {}) value: unknown) {} }; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-property-decorator-write-runs',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const unused = class { @((values.join = Array.prototype.join), (target: unknown) => target) field = 1; }; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-decorator-before-computed-name',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const unused = class { @((values.join = () => 'safe'), (target: unknown) => target) [((values.join = Array.prototype.join), 'name')]() {} }; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-method-body-decorator-free-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const unused = class { method() { return 1; } }; return String(values); }`,
    converts: false,
  },
  {
    id: 'class-declaration-static-block-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); class Unused { static { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } } values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    // Refused since the array is followed only where each mention is known: the answer is held by a static field of a class.
    id: 'class-declaration-static-field-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); class Unused { static field = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-declaration-computed-name-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); class Unused { [(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }), 'name')]() {} } values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'class-declaration-heritage-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); class Unused extends ((Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })), Object) {} values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'class-declaration-accessor-then-release',
    source: `function frames(error: Error) { const values = [error]; class Unused { static { Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); } } values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'class-declaration-instance-field-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); class Unused { field = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-declaration-method-body-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); class Unused { method() { return Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } } values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'class-declaration-static-in-branch-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); if (flag) { class Unused { static field = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } } values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'iife-arrow-expression-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); (() => Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }))(); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'iife-arrow-block-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); (() => { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); })(); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'iife-function-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); (function () { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); })(); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'iife-return-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); (() => { return Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); })(); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'iife-two-statements-release',
    source: `function frames(error: Error) { const values = [error]; (() => { Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); })(); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'iife-nested-block-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); (() => { { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); } })(); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'iife-in-argument-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { first: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), second: (() => Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }))(), join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'iife-declaration-replaces-accessor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const done = (() => Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }))(); values.join = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'iife-early-return-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); (() => { if (flag) return 0; return Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); })(); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'iife-statement-after-early-return-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); (() => { if (flag) return 0; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); return 1; })(); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'iife-branch-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); (() => { if (flag) Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); })(); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'iife-async-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); (async () => { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); })(); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'iife-generator-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); (function* () { Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); })(); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'iife-parameter-default-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); ((value = Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true })) => value)(); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'called-later-function-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); const replace = () => Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true }); values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-getter-rewrites-later-field',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { get probe() { this.join = Array.prototype.join; return 1; }, join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-getter-after-custom-method-restores-native',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { join: () => 'safe', get probe() { values.join = Array.prototype.join; return 1; } }); return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-setter-only-source-keeps-custom-pin',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { set probe(value: unknown) {}, join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'assign-second-source-length-throws-after-native',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; try { Object.assign(values, { join: Array.prototype.join }, { length: -1, join: () => 'safe' }); } catch {} return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-second-source-computed-key-throws-after-native',
    source: `function frames(error: Error, key: string) { const values = [error]; values.join = () => 'safe'; try { Object.assign(values, { join: Array.prototype.join }, { [key]: -1, join: () => 'safe' }); } catch {} return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-second-source-unknown-length-throws-after-native',
    source: `function frames(error: Error, size: number) { const values = [error]; values.join = () => 'safe'; try { Object.assign(values, { join: Array.prototype.join }, { length: size, join: () => 'safe' }); } catch {} return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-second-source-spread-throws-after-native',
    source: `function frames(error: Error, rest: object) { const values = [error]; values.join = () => 'safe'; try { Object.assign(values, { join: Array.prototype.join }, { ...rest, join: () => 'safe' }); } catch {} return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-second-source-valid-length-keeps-custom-pin',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { join: Array.prototype.join }, { length: 1, join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'assign-loop-partial-write-keeps-native',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; for (let pass = 0; pass < 2 && String(values); pass++) { try { Object.assign(values, { join: Array.prototype.join }, { length: -1, join: () => 'safe' }); } catch {} } return String(values); }`,
    converts: true,
  },
  {
    id: 'define-properties-getter-rewrites-later-descriptor',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperties(values, { get probe() { this.join = { value: Array.prototype.join }; return { value: 1 }; }, join: { value: () => 'safe' } }); return String(values); }`,
    converts: true,
  },
  {
    id: 'define-properties-length-throws-before-custom',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); try { Object.defineProperties(values, { length: { value: -1 }, join: { value: () => 'safe' } }); } catch {} return String(values); }`,
    converts: true,
  },
  {
    id: 'define-properties-computed-key-throws-before-custom',
    source: `function frames(error: Error, key: string) { const values = [error]; Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); try { Object.defineProperties(values, { [key]: { value: -1 }, join: { value: () => 'safe' } }); } catch {} return String(values); }`,
    converts: true,
  },
  {
    id: 'define-descriptor-getter-named-field-rewrites-value',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get enumerable() { this.value = Array.prototype.join; return false; }, value: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'define-descriptor-getter-other-name-keeps-custom-pin',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { get probe() { this.value = Array.prototype.join; return false; }, value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'assign-second-source-throws-in-function-called-in-try',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const run = () => Object.assign(values, { join: Array.prototype.join }, { length: -1, join: () => 'safe' }); try { run(); } catch {} return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-second-source-throws-read-in-finally',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; try { Object.assign(values, { join: Array.prototype.join }, { length: -1, join: () => 'safe' }); } finally { return String(values); } }`,
    converts: true,
  },
  {
    id: 'iife-argument-runs-before-body',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: ((unused: unknown) => Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }))(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true })), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    // Refused since the array is followed only where each mention is known: the answer is handed to a parameter of a function.
    id: 'iife-argument-accessor-then-body-data-definition-pin',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: ((unused: unknown) => Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }))(Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true })), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'iife-function-expression-argument-runs-before-body',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: (function (unused: unknown) { return Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }); })(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true })), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'call-argument-runs-before-the-called-function-pin',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: ((callback: (value: unknown) => unknown) => callback(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true })))(() => Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true })), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'callee-reflect-define-property-restores-native',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Reflect.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); return String(values); }`,
    converts: true,
  },
  {
    id: 'callee-comma-define-property-restores-native',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; (0, Object.defineProperty)(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); return String(values); }`,
    converts: true,
  },
  {
    id: 'callee-constant-alias-restores-native',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const define = Object.defineProperty; define(values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); return String(values); }`,
    converts: true,
  },
  {
    id: 'callee-call-form-restores-native',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Object.defineProperty.call(Object, values, 'join', { value: Array.prototype.join, writable: true, configurable: true }); return String(values); }`,
    converts: true,
  },
  {
    id: 'callee-apply-form-restores-native',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Object.defineProperty.apply(Object, [values, 'join', { value: Array.prototype.join, writable: true, configurable: true }]); return String(values); }`,
    converts: true,
  },
  {
    id: 'callee-reflect-apply-restores-native',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Reflect.apply(Object.defineProperty, Object, [values, 'join', { value: Array.prototype.join, writable: true, configurable: true }]); return String(values); }`,
    converts: true,
  },
  {
    id: 'callee-assign-call-form-restores-native',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Object.assign.call(null, values, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'callee-comma-assign-restores-native',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; (0, Object.assign)(values, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'callee-reflect-define-custom-stays-possible-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Reflect.defineProperty(values, 'join', { value: () => 'again', writable: true, configurable: true }); return String(values); }`,
    converts: true,
  },
  {
    id: 'callee-comma-define-custom-keeps-custom-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; (0, Object.defineProperty)(values, 'join', { value: () => 'again', writable: true, configurable: true }); return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-callee-reflect-accessor-is-held',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Reflect.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-callee-comma-accessor-is-held',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: (0, Object.defineProperty)(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-callee-alias-accessor-is-held',
    source: `function frames(error: Error) { const values = [error]; const define = Object.defineProperty; Object.assign(values, { ignored: define(values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-callee-call-form-accessor-is-held',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty.call(Object, values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-callee-apply-form-accessor-is-held',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty.apply(Object, [values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }]), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-callee-reflect-apply-accessor-is-held',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Reflect.apply(Object.defineProperty, Object, [values, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }]), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-callee-data-definition-lets-the-assignment-replace-pin',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty.call(Object, values, 'join', { value: Array.prototype.join, writable: true, configurable: true }), join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'refused-method-proof-after-reflect-set',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Reflect.set(values, 'join', Array.prototype.join); return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-method-proof-after-reflect-delete',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Reflect.deleteProperty(values, 'join'); return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-method-proof-with-a-destructured-alias',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const [alias] = [values]; alias.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-method-proof-with-an-object-destructured-alias',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const { alias } = { alias: values }; alias.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-method-proof-after-a-bound-mutator',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Object.defineProperty.bind(null)(values, 'join', { value: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-method-proof-after-a-function-of-the-program',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const swap = (list: any) => { list.join = Array.prototype.join; }; swap(values); return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-method-proof-after-a-called-function-literal',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; ((array: any) => Object.defineProperty(array, 'join', { value: Array.prototype.join, writable: true, configurable: true }))(values); return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-method-proof-with-the-array-in-a-literal',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const holder = [values]; (holder[0] as any).join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-method-proof-after-a-called-function-handed-the-answer',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Object.assign(values, { ignored: ((array: any) => Object.defineProperty(array, 'join', { get: () => Array.prototype.join, set: () => {}, configurable: true }))(Object.defineProperty(values, 'join', { value: Array.prototype.join, writable: true, configurable: true })), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'known-method-proof-after-a-method-of-the-array-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values.push('safe'); return String(values); }`,
    converts: false,
  },
  {
    id: 'known-method-proof-after-a-spread-of-the-array-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const copy = [...values]; return String(values); }`,
    converts: false,
  },
  {
    id: 'known-method-proof-after-a-second-custom-method-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values.join = () => 'again'; return String(values); }`,
    converts: false,
  },
  {
    id: 'known-method-proof-after-a-native-mutator-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Object.assign(values, { label: 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'known-method-proof-with-a-handing-after-the-read-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const text = String(values); ((list: any) => { list.join = Array.prototype.join; })(values); return text; }`,
    converts: false,
  },
  {
    id: 'refused-callback-handed-the-array',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values.forEach((_: unknown, __: unknown, array: any) => { Object.defineProperty(array, 'join', { value: Array.prototype.join, writable: true, configurable: true }); }); return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-map-callback-handed-the-array',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values.map((_: unknown, __: unknown, array: any) => { array.join = Array.prototype.join; }); return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-reduce-callback-handed-the-array',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values.reduce((_: unknown, __: unknown, ___: unknown, array: any) => { array.join = Array.prototype.join; }, 0); return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-callback-with-a-rest-parameter',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values.forEach((...rest: any[]) => { rest[2].join = Array.prototype.join; }); return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-function-callback-reading-arguments',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values.forEach(function () { arguments[2].join = Array.prototype.join; }); return String(values); }`,
    converts: true,
  },
  {
    id: 'refused-callback-named-elsewhere',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; const writeBack = (_: unknown, __: unknown, array: any) => { array.join = Array.prototype.join; }; values.forEach(writeBack); return String(values); }`,
    converts: true,
  },
  {
    id: 'known-callback-without-the-array-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values.forEach((item: unknown) => { void item; }); return String(values); }`,
    converts: false,
  },
  {
    id: 'known-callback-native-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values.filter(Boolean); return String(values); }`,
    converts: false,
  },
  {
    id: 'known-callback-with-two-parameters-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values.map((item: unknown, index: number) => [item, index]); return String(values); }`,
    converts: false,
  },
  {
    id: 'container-member-alias-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const holder = [values]; const x = holder[0]; x.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'container-object-alias-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const holder = { a: values }; const x = holder.a; x.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'container-foreach-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const holder = [values]; holder.forEach((a: any) => { a.join = Array.prototype.join; }); return String(values); }`,
    converts: true,
  },
  {
    id: 'container-for-of-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const holder = [values]; for (const a of holder) a.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'container-destructured-alias-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const holder = [values]; const [first] = holder; first.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'tagged-template-argument-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const tag = (_: any, a: any) => { a.join = Array.prototype.join; }; tag\`\${values}\`; return String(values); }`,
    converts: true,
  },
  {
    id: 'conditional-receiver-write-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; (flag ? values : []).join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'logical-receiver-write-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; (values || []).join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'comma-receiver-write-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; (0, values).join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'literal-source-of-a-copy-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const r: any = Object.assign({}, { values }); r.values.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'literal-source-of-a-copy-member-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const r: any = Object.assign({}, { values }); const x = r.values; x.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'answer-of-assign-kept-in-a-constant-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const r: any = Object.assign(values, { x: 1 }); r.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'answer-of-define-kept-in-a-constant-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const r: any = Object.defineProperty(values, 'x', { value: 1 }); r.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'answer-of-sort-kept-in-a-constant-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const r: any = values.sort(); r.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'answer-returned-by-an-iife-kept-in-a-constant-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const r: any = (() => Object.assign(values, { x: 1 }))(); r.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'array-held-by-itself-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; Object.assign(values, { self: Object.assign(values, { y: 1 }) }); const x = (values as any).self; x.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'answer-through-comma-kept-in-a-constant-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const r: any = (0, Object.assign(values, { x: 1 })); r.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'answer-of-reverse-written-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; values.reverse().join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'answer-of-define-written-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; (Object.defineProperty(values, 'x', { value: 1 }) as any).join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'container-destructured-by-a-constant-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const holder = [values]; const [first] = holder; first.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'container-object-destructured-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const holder = { a: values }; const { a } = holder; a.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'container-destructured-by-an-assignment-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const holder = [values]; let first: any; [first] = holder; first.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'known-element-destructuring-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const [first] = values; void first; return String(values); }`,
    converts: false,
  },
  {
    id: 'known-field-destructuring-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; const { length } = values; void length; return String(values); }`,
    converts: false,
  },
  {
    id: 'known-spread-into-a-call-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; ((...a: any[]) => a)(...values); return String(values); }`,
    converts: false,
  },
  {
    id: 'known-conditional-receiver-read-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; void (flag ? values : []).length; return String(values); }`,
    converts: false,
  },
  {
    id: 'method-of-the-array-naming-this-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; (values as any).m = function (this: any) { this.join = Array.prototype.join; }; (values as any).m(); return String(values); }`,
    converts: true,
  },
  {
    id: 'iterator-of-the-array-naming-this-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; (values as any)[Symbol.iterator] = function (this: any) { this.join = Array.prototype.join; return [][Symbol.iterator](); }; [...values]; return String(values); }`,
    converts: true,
  },
  {
    id: 'custom-join-naming-this-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; (values as any).join = function (this: any) { this.join = Array.prototype.join; return 'x'; }; values.toString(); return String(values); }`,
    converts: true,
  },
  {
    id: 'getter-naming-this-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; Object.defineProperty(values, 'x', { get() { this.join = Array.prototype.join; return 1; } }); void (values as any).x; return String(values); }`,
    converts: true,
  },
  {
    id: 'setter-naming-this-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; Object.defineProperty(values, 'x', { set(v: any) { this.join = Array.prototype.join; } }); (values as any).x = 1; return String(values); }`,
    converts: true,
  },
  {
    id: 'own-valueof-naming-this-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; (values as any).valueOf = function (this: any) { this.join = Array.prototype.join; return this; }; void ((values as any) + ''); return String(values); }`,
    converts: true,
  },
  {
    id: 'source-method-naming-this-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; Object.assign(values, { toJSON() { this.join = Array.prototype.join; return 1; } }); JSON.stringify(values); return String(values); }`,
    converts: true,
  },
  {
    id: 'getter-arrow-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; Object.defineProperty(values, 'x', { get: () => 1 }); void (values as any).x; return String(values); }`,
    converts: false,
  },
  {
    id: 'nested-call-through-a-name-of-an-array-that-holds-itself-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; Object.assign(values, { self: Object.assign(values, { y: 1 }) }); const r: any = Object.assign(values, {}); r.self.push(error); return String(values); }`,
    converts: true,
  },
  {
    id: 'answer-in-a-discarded-literal-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; [Object.assign(values, { y: 1 })]; return String(values); }`,
    converts: false,
  },
  {
    id: 'answer-in-a-for-head-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; for (Object.assign(values, { y: 1 }); false; ) {} return String(values); }`,
    converts: false,
  },
  {
    id: 'answer-member-read-dropped-by-a-comma-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; (Object.assign(values, { y: 1 }).length, 0); return String(values); }`,
    converts: false,
  },
  {
    id: 'destructured-alias-of-the-array-refused',
    source: `function frames(error: Error) { const values: any[] = [error]; values.join = () => 'safe'; const [alias] = [values]; alias.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-called-through-call-restores-the-method',
    source: `function frames(error: Error) { const a: any[] = [error]; a.join = () => 'safe'; Object.assign.call(null, a, { join: Array.prototype.join }); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-accessor-field-naming-this-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; Object.defineProperty(values, 'x', { get get() { return () => this; } }); return String(values); }`,
    converts: false,
  },
  {
    id: 'wrapped-getter-naming-this-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; Object.defineProperty(values, 'x', { get: (function (this: any) { this.join = Array.prototype.join; return 1; }) }); void (values as any).x; return String(values); }`,
    converts: true,
  },
  {
    id: 'asserted-getter-naming-this-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; Object.defineProperty(values, 'x', { get: function (this: any) { this.join = Array.prototype.join; return 1; } as () => number }); void (values as any).x; return String(values); }`,
    converts: true,
  },
  {
    id: 'whole-write-of-the-read-name-converts',
    source: `function frames(error: Error, flag: boolean) { let a: any[] = ['safe']; a = [error]; return String(a); }`,
    converts: true,
  },
  {
    id: 'whole-write-of-the-read-name-after-a-method-converts',
    source: `function frames(error: Error, flag: boolean) { let a: any[] = [error]; a.join = () => 'safe'; a = [error]; return String(a); }`,
    converts: true,
  },
  {
    id: 'whole-write-of-an-alias-keeps-the-proof-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = [error]; a.join = () => 'safe'; let b = a; b = []; return String(a); }`,
    converts: false,
  },
  {
    id: 'wrapped-value-naming-this-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = [error]; values.join = () => 'safe'; Object.assign(values, { valueOf: (function (this: any) { this.join = Array.prototype.join; return this; }) }); void ((values as any) + ''); return String(values); }`,
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

const LOGICAL = [
  { id: 'or-assignment', operator: '||=' },
  { id: 'and-assignment', operator: '&&=' },
  { id: 'nullish-assignment', operator: '??=' },
] as const;

describe('what a logical assignment to a method leaves of its attributes', () => {
  it.each(LOGICAL)('$id claims no attribute: it may assign nothing', ({ operator }) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'logical-assignment.ts',
      `function frames(error: Error) { const values = [error]; values.join ${operator} (() => 'x'); return String(values); }`,
    );
    const read = stringCall(parsed.sourceFile);

    expect(arrayMethodOverride(read.arguments[0]!, 'join', read)).toStrictEqual({
      own: false,
    });
  });
});

function stringCall(root: Node): CallExpression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String'
    )
      return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no String call');
}
