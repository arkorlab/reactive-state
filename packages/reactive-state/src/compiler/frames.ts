import type { Identifier } from 'typescript/ast';

import type { HookCall } from './analyze.ts';
import type { HookDefinition } from './hooks.ts';
import type { StateDeclaration } from './statements.ts';
import { annotationOf } from './types.ts';

/**
 * Where the code a dynamic site's values are computed by stands — the component's own, or a hook's
 * its call reaches — and the states that code reaches, which the page sends the site (`derive.ts`).
 */

/** How the Client Component holds the value of a state a site reads. */
export type BrowserValue =
  /** A name it binds: the component's own state, or an item of a hook's call it binds. */
  | { readonly kind: 'name'; readonly name: Identifier }
  /** An item of a hook's call it binds no name of, which the Client Component binds one of. */
  | { readonly kind: 'item'; readonly call: HookCall; readonly item: string };

/** A state a dynamic site is rendered of, which the page sends: by its key. */
export interface SiteInput {
  /** Its key: the component's name for it, or a hook's state keyed by the hook's call. */
  readonly key: string;
  /** Where the site reads it first, in the component: what refusing it points at. */
  readonly at: Identifier;
  /** The component's own declaration of it; none for a hook's. */
  readonly state: StateDeclaration | undefined;
  /** Its name where it is declared, which the authority's program names it by where it can. */
  readonly local: string;
  readonly browser: BrowserValue;
  /** Where it is declared: the component's statement, then the hook's, within each call. */
  readonly order: readonly number[];
}

/** Where code a site's values are computed by stands: the component, or a hook its call reached. */
export type Frame =
  | { readonly kind: 'component' }
  | {
      readonly kind: 'hook';
      readonly hook: HookDefinition;
      /** The call that reached it, in `parent`. */
      readonly call: HookCall;
      /** What its states' keys begin with in the component: each call's prefix, outermost first. */
      readonly prefix: string;
      readonly parent: Frame;
      /** The component's call it is reached through. */
      readonly root: HookCall;
      readonly order: readonly number[];
    };

export type HookFrame = Extract<Frame, { kind: 'hook' }>;

/** The component's own code. */
export const COMPONENT: Frame = { kind: 'component' };

/** The prefix of the calls code in `frame` is reached through: none for the component's. */
export function prefixOf(frame: Frame): string {
  return frame.kind === 'component' ? '' : frame.prefix;
}

/** The frame of a hook the component calls. */
export function rootFrame(call: HookCall): HookFrame {
  return {
    call,
    hook: call.hook,
    kind: 'hook',
    order: [call.statement.pos],
    parent: COMPONENT,
    prefix: call.prefix,
    root: call,
  };
}

/** The frame of a hook that the hook of `frame` calls. */
export function nestedFrame(frame: HookFrame, call: HookCall): HookFrame {
  return {
    call,
    hook: call.hook,
    kind: 'hook',
    order: [...frame.order, call.statement.pos],
    parent: frame,
    prefix: `${frame.prefix}${call.prefix}`,
    root: frame.root,
  };
}

/** How a refusal names a hook: by its name and its module's file. */
export function whereOf(hook: HookDefinition): string {
  return `\`${hook.name}\` (${hook.module.fileName})`;
}

/**
 * How the Client Component holds the value of the hook's state `key`: the item of the component's
 * call that returns it, by the name the call binds it by, or one the Client Component binds.
 */
export function browserValueOf(
  call: HookCall,
  key: string,
  refuse: (message: string) => never,
): BrowserValue {
  for (const [item, found] of call.hook.items) {
    if (found.value === undefined || `${call.prefix}${found.value}` !== key) {
      continue;
    }
    const { binding } = call;
    if (binding.kind === 'items') {
      const name = binding.names.get(item);
      return name === undefined ? { call, item, kind: 'item' } : { kind: 'name', name };
    }
    return { call, item, kind: 'item' };
  }
  return refuse(
    `\`${call.callee.text}\` returns no item that holds its state \`${key.slice(call.prefix.length)}\`, whose value the page sends the authority for the dynamic site that reads what the hook computes of it: return it too — \`return { …, ${key.slice(key.lastIndexOf('.') + 1)} }\`.`,
  );
}

/** States read, in the order they are declared: the component's, then within each hook's call. */
export function inDeclarationOrder(inputs: readonly SiteInput[]): readonly SiteInput[] {
  return inputs.toSorted((a, b) => {
    const length = Math.max(a.order.length, b.order.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (a.order[index] ?? -1) - (b.order[index] ?? -1);
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  });
}

/**
 * The type `declaration`'s annotation writes, of the hook `frame` is in, as a program elsewhere
 * writes it (`annotationOf`): none of a type the program cannot name — a type parameter of the
 * hook's, one its module declares itself.
 */
export function annotatedIn(
  frame: HookFrame,
  declaration: Parameters<typeof annotationOf>[0],
): string | undefined {
  const { hook } = frame;
  const local = new Set(hook.declaration.typeParameters?.map(({ name }) => name.text));
  return annotationOf(declaration, {
    local,
    names: hook.names,
    sourceFile: hook.module.sourceFile,
  });
}
