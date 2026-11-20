import {
  type Expression,
  type Identifier,
  isIdentifier,
  isShorthandPropertyAssignment,
  type Node,
  type VariableDeclaration,
} from 'typescript/ast';

import { impureGlobal } from './alike.ts';
import type { Component, TopLevel } from './analyze.ts';
import { checkComputed, checkTypes, COMPUTED_BY, initializerOf, substituted } from './computed.ts';
import { counting } from './counting.ts';
import {
  answered,
  around,
  BROWSER_VALUES,
  captured,
  defaulted,
  type DerivationContext,
  Followed,
  type Following,
  firstVisit,
  hidden,
  type HookReaching,
  importRefusal,
  itself,
  type Naming,
  type Reaching,
  type Resolution,
  serverOnly,
  typeOfBrowser,
  ungiven,
  unread,
  valueOf,
  visitKey,
  whole,
} from './following.ts';
import {
  annotatedIn,
  argumentAt,
  browserValueOf,
  COMPONENT,
  type Frame,
  type HookFrame,
  nestedFrame,
  prefixOf,
  rootFrame,
  type SiteInput,
  whereOf,
} from './frames.ts';
import type { HookDefinition } from './hooks.ts';
import type { ImportBinding } from './imports.ts';
import { isCalledValue } from './method-calls.ts';
import { type Names, type Space, walk } from './scope.ts';
import { type Rewrite, textOf } from './splice.ts';
import type { StateDeclaration } from './statements.ts';
import { annotationOf } from './types.ts';

/**
 * What a dynamic site reads of the browser's values, followed back to the local states it is
 * computed of. The browser computes a constant after the state, or an item a custom hook returns —
 * `effectiveFilter = normalizeFilter(filter)`, `query.filter`, `panels.map(…)` — and the authority
 * computes it again, in place, of the same states, which the page sends it: each constant written
 * as its initializer, each item of a hook as the hook computes it — of the hook's states, keyed by
 * the hook's call, of its constants, and of what its caller gives its parameters — each shared
 * module's function imported into the program. What it is computed by is held to a grammar of
 * values (`computed.ts`): no function but one a value's method is given, nothing awaited or
 * assigned. A state of a hook's is one its parameter declares as it is: the page's value of it is
 * what the authority is sent, as the page holds it, and what the hook returns of it is computed of
 * that again — the effective filter is the application's own `normalizeFilter`'s, on either side.
 *
 * Code written where other code stood is read where it now stands, so no name in it may be taken
 * there by another declaration: a function's parameter in the code the site's function is written
 * of takes no name of the component's that a hook's code would read through it, and no global that
 * code reads; the names the program chooses — the inputs', the imports' — take none of them.
 */

export class Derivation {
  readonly #context: DerivationContext;
  /** What each read followed is, by the prefix of the calls its code is reached through. */
  readonly #resolved = new Map<string, Map<Node, Resolution>>();
  readonly #imports = new Map<string, ImportBinding>();
  /** Every name the code a site's function is written of declares, or reads as a global. */
  readonly #taken = new Set<string>();
  /** The component's constants a site's value is computed of, which the authority computes again. */
  readonly #constants = new Set<Node>();
  readonly #followed = new Followed();
  readonly #names = new Map<HookDefinition, Names>();

  constructor(context: DerivationContext) {
    this.#context = context;
  }

  #written(resolution: Resolution | undefined, naming: Naming, held = false): string | undefined {
    if (resolution === undefined) {
      return undefined;
    }
    switch (resolution.kind) {
      case 'input': {
        return naming.input(resolution.key);
      }
      case 'import': {
        return naming.import(resolution.binding);
      }
      case 'type': {
        return naming.type(resolution.binding);
      }
      case 'value': {
        const { frame, name, node, type } = resolution;
        // A constant's annotation, where the program can name it, types its value as the browser's.
        const written = (): string => {
          const text = textOf(node, this.#sourceOf(frame), this.rewrite(frame, naming));
          // `flag ? 'all' : 'done'` cast whole: `as` binds tighter than an operator.
          const value = substituted(node, text);
          return type === undefined ? value : `(${value} as ${type})`;
        };
        return naming.computed === undefined
          ? written()
          : naming.computed({ held, name, node, prefix: prefixOf(frame) }, written);
      }
    }
  }

  #sourceOf(frame: Frame): Component['sourceFile'] {
    return frame.kind === 'component'
      ? this.#context.component.sourceFile
      : frame.hook.module.sourceFile;
  }

  #refuse(origin: Identifier, message: string): never {
    return this.#context.component.fail(message, origin);
  }

  #resolve(frame: Frame, node: Node, resolution: Resolution): void {
    const prefix = prefixOf(frame);
    let resolved = this.#resolved.get(prefix);
    if (resolved === undefined) {
      resolved = new Map();
      this.#resolved.set(prefix, resolved);
    }
    resolved.set(node, resolution);
  }

  /**
   * A global the code written in place reads, `at` where it is written: one of what it is given
   * alone, which neither a name declared around it there nor a name of the component's takes.
   */
  #global(name: string, at: Following, where?: string): void {
    const prefix = where === undefined ? '' : `In ${where}: `;
    if (where !== undefined && this.#context.component.names.has(name)) {
      this.#refuse(at.origin, `${prefix}${answered(name)}`);
    }
    if (at.scope.has(name)) {
      this.#refuse(at.origin, `${prefix}${hidden(name)}`);
    }
    const impure = impureGlobal(name);
    if (impure !== undefined) {
      this.#refuse(at.origin, `${prefix}${impure}`);
    }
    this.#taken.add(name);
  }

  #componentRead(identifier: Identifier, entry: TopLevel, at: Following): boolean {
    switch (entry.kind) {
      case 'state': {
        this.#componentState(identifier, entry.state, at);
        return true;
      }
      case 'constant': {
        this.#componentConstant(identifier, entry.declaration, at);
        return true;
      }
      case 'hooked': {
        this.#hookItem(identifier, { at, frame: rootFrame(entry.call), item: entry.item });
        return true;
      }
      case 'node':
      case 'self':
      case 'setter': {
        return this.#refuse(at.origin, unread(identifier.text, entry.kind));
      }
      case 'import':
      case 'intrinsic':
      case 'module':
      case 'param':
      case 'prop':
      case 'server': {
        return false;
      }
    }
  }

  #componentState(identifier: Identifier, state: StateDeclaration, at: Following): void {
    const key = state.value.text;
    // The component's own state is written under its own name, which nothing around may take.
    if (at.scope.has(key)) {
      this.#refuse(at.origin, captured(key));
    }
    this.#resolve(COMPONENT, identifier, { key, kind: 'input' });
    if (!at.inputs.has(key)) {
      at.inputs.set(key, {
        at: at.origin,
        browser: { kind: 'name', name: state.value },
        key,
        local: key,
        order: [state.statement.pos],
        state,
      });
    }
  }

  #componentConstant(
    identifier: Identifier,
    declaration: VariableDeclaration,
    at: Following,
  ): void {
    const initializer = initializerOf(identifier.text, declaration, {
      refuse: (message) => this.#refuse(at.origin, message),
      what: "a constant of the browser's",
    });
    const { names, sourceFile } = this.#context.component;
    const type = annotationOf(declaration, { names, sourceFile });
    this.#resolve(COMPONENT, identifier, valueOf(COMPONENT, identifier, initializer, type));
    this.#constants.add(declaration);
    this.#followed.within(prefixOf(COMPONENT), declaration, {
      follow: () => {
        this.#inComponent(initializer, at);
      },
      refuse: () => this.#refuse(at.origin, itself(identifier.text)),
    });
  }

  #follow(node: Node, frame: Frame, at: Following): void {
    if (frame.kind === 'component') {
      this.#inComponent(node, at);
    } else {
      this.#inHook(node, frame, at);
    }
  }

  /** Follows code of the component's that a site's value is computed by: a constant's, an argument. */
  #inComponent(node: Node, at: Following): void {
    if (!firstVisit(at.visited, visitKey('', at.scope), node)) {
      return;
    }
    checkComputed(node, (message) => this.#refuse(at.origin, message));
    const { names } = this.#context.component;
    this.#context.walking(node, {
      declare: (identifier) => {
        this.#taken.add(identifier.text);
      },
      global: (identifier) => {
        this.#global(identifier.text, at);
      },
      read: (identifier, space, scope) => {
        this.#componentCodeRead(identifier, space, around(at, scope, names));
      },
      unresolved: (identifier) => {
        this.#refuse(at.origin, `\`${identifier.text}\` is not in scope here.`);
      },
    });
  }

  /** A read in code of the component's that a site's value is computed by. */
  #componentCodeRead(identifier: Identifier, space: Space, at: Following): void {
    const entry = this.#context.component.names.get(identifier.text);
    if (space === 'type' && entry !== undefined && BROWSER_VALUES.has(entry.kind)) {
      this.#refuse(at.origin, typeOfBrowser(identifier.text));
    }
    if (space === 'value' && entry !== undefined) {
      if (this.#componentRead(identifier, entry, at)) {
        return;
      }
      const refused =
        entry.kind === 'import' ? importRefusal(identifier.text, entry.binding) : undefined;
      if (refused !== undefined) {
        this.#refuse(at.origin, refused);
      }
      if (entry.kind === 'server') {
        this.#refuse(at.origin, serverOnly(identifier.text));
      }
      // Written as it is, under its own name, which nothing around where it is written may take.
      if (at.scope.has(identifier.text)) {
        this.#refuse(at.origin, captured(identifier.text));
      }
    }
    this.#context.authority(identifier, space);
  }

  /** Follows the item `item` a hook's call returns, in the hook's own code. */
  #hookItem(identifier: Identifier, reaching: HookReaching): void {
    const { at, frame, item } = reaching;
    if (item === 'whole') {
      this.#refuse(at.origin, whole(identifier.text, frame.hook.name));
    }
    const found = frame.hook.items.get(item);
    if (found === undefined) {
      this.#refuse(at.origin, `\`${frame.hook.name}\` returns no item \`${item}\`.`);
    }
    const node = found.node as Expression;
    this.#resolve(frame.parent, identifier, valueOf(frame, identifier, node));
    this.#inHook(node, frame, at);
  }

  /** Follows code of a hook's that a site's value is computed by, keyed by the calls that reach it. */
  #inHook(node: Node, frame: HookFrame, at: Following): void {
    if (!firstVisit(at.visited, visitKey(frame.prefix, at.scope), node)) {
      return;
    }
    const { hook } = frame;
    const where = whereOf(hook);
    const fail = (message: string): never => this.#refuse(at.origin, `In ${where}: ${message}`);
    checkComputed(node, fail);
    const parameters = new Set(hook.declaration.typeParameters?.map(({ name }) => name.text));
    checkTypes(
      node,
      (name) =>
        parameters.has(name) || (!hook.names.has(name) && hook.sides.scope.declared.has(name)),
      fail,
    );
    walk(
      node,
      this.#namesOf(hook),
      {
        declare: (identifier) => {
          this.#taken.add(identifier.text);
        },
        global: (identifier) => {
          this.#global(identifier.text, at, where);
        },
        read: (identifier, space, scope) => {
          if (space === 'type') {
            this.#hookType(identifier, { at, frame });
          } else {
            this.#hookRead(identifier, { at: around(at, scope, hook.names), frame });
          }
        },
        unresolved: (identifier) => {
          fail(`\`${identifier.text}\` is not in scope here.`);
        },
      },
      fail,
    );
  }

  #namesOf(hook: HookDefinition): Names {
    let names = this.#names.get(hook);
    if (names === undefined) {
      names = {
        declared: hook.sides.scope.declared,
        declaring: hook.sides.scope.declaring,
        reserved: this.#context.reserved,
        topLevel: new Set(hook.names.keys()),
      };
      this.#names.set(hook, names);
    }
    return names;
  }

  #hookRead(identifier: Identifier, reaching: Reaching): void {
    const { at, frame } = reaching;
    const entry = frame.hook.names.get(identifier.text);
    if (entry === undefined) {
      return;
    }
    switch (entry.kind) {
      case 'state': {
        this.#hookState(identifier, entry.state, reaching);
        return;
      }
      case 'constant': {
        this.#hookConstant(identifier, entry.declaration, reaching);
        return;
      }
      case 'param': {
        this.#hookParam(identifier, entry.index, reaching);
        return;
      }
      case 'hooked': {
        this.#hookItem(identifier, { at, frame: nestedFrame(frame, entry.call), item: entry.item });
        return;
      }
      case 'import': {
        this.#hookImport(identifier, entry.binding, reaching);
        return;
      }
      case 'intrinsic':
      case 'module':
      case 'node':
      case 'prop':
      case 'self':
      case 'server':
      case 'setter': {
        this.#refuse(
          at.origin,
          entry.kind === 'module'
            ? `In ${whereOf(frame.hook)}: \`${identifier.text}\` is declared by the hook's module for itself, which the authority's program cannot import, and ${COMPUTED_BY}. Move it into a shared module of the application's.`
            : `In ${whereOf(frame.hook)}: \`${identifier.text}\` is the browser's alone, and ${COMPUTED_BY}.`,
        );
      }
    }
  }

  #hookConstant(
    identifier: Identifier,
    declaration: VariableDeclaration,
    reaching: Reaching,
  ): void {
    const { at, frame } = reaching;
    const where = whereOf(frame.hook);
    const initializer = initializerOf(identifier.text, declaration, {
      refuse: (message) => this.#refuse(at.origin, `In ${where}: ${message}`),
      what: 'a constant',
    });
    const type = annotatedIn(frame, declaration);
    this.#resolve(frame, identifier, valueOf(frame, identifier, initializer, type));
    this.#followed.within(prefixOf(frame), declaration, {
      follow: () => {
        this.#inHook(initializer, frame, at);
      },
      refuse: () => this.#refuse(at.origin, `In ${where}: ${itself(identifier.text)}`),
    });
  }

  /** A parameter of a hook's, which the call gives the value of: what the caller computes it by. */
  #hookParam(identifier: Identifier, index: number, reaching: Reaching): void {
    const { at, frame } = reaching;
    const where = whereOf(frame.hook);
    const state = frame.hook.feeds.get(index);
    if (state !== undefined) {
      this.#refuse(
        at.origin,
        `In ${where}: \`${identifier.text}\` is what the hook's state \`${state}\` starts from, and a dynamic site's value is computed of the state itself, which the page sends the authority: read \`${state}\`.`,
      );
    }
    if (frame.hook.declaration.parameters[index]?.initializer !== undefined) {
      this.#refuse(at.origin, `In ${where}: ${defaulted(identifier.text)}`);
    }
    const argument = argumentAt(frame.call.call.arguments, index);
    if (argument === undefined) {
      this.#refuse(
        at.origin,
        `In ${where}: \`${identifier.text}\` is given no value of its own by the call to compute a value of.`,
      );
    }
    // The parameter's annotation, where the program can name it, types what the call gives it, as
    // the hook's code reads it: `'all'` given `mode: Mode` is of `Mode` there, not of `'all'` alone.
    const parameter = frame.hook.declaration.parameters[index];
    const type = parameter === undefined ? undefined : annotatedIn(frame, parameter);
    this.#resolve(frame, identifier, valueOf(frame.parent, identifier, argument, type));
    this.#follow(argument, frame.parent, at);
  }

  #hookImport(identifier: Identifier, binding: ImportBinding, reaching: Reaching): void {
    const { at, frame } = reaching;
    const refused = importRefusal(identifier.text, binding);
    if (refused !== undefined) {
      this.#refuse(at.origin, `In ${whereOf(frame.hook)}: ${refused}`);
    }
    this.#resolve(frame, identifier, { binding, kind: 'import' });
    this.#imports.set(`${binding.module.written}#${binding.exported}`, binding);
  }

  /** A type a hook's code names, which the program imports where the hook's module does. */
  #hookType(identifier: Identifier, reaching: Reaching): void {
    const { at, frame } = reaching;
    const entry = frame.hook.names.get(identifier.text);
    if (entry?.kind !== 'import') {
      this.#refuse(
        at.origin,
        `In ${whereOf(frame.hook)}: the type \`${identifier.text}\` is the hook's own, which the authority's program, where the value is computed again in place, has no name for. Declare it in a shared module of the application's, or leave it out of what the value is computed by.`,
      );
    }
    this.#resolve(frame, identifier, { binding: entry.binding, kind: 'type' });
  }

  /** A state of a hook's a site's value is computed of: one a parameter declares, of a value of the page's. */
  #hookState(identifier: Identifier, state: StateDeclaration, reaching: Reaching): void {
    const { at, frame } = reaching;
    const where = whereOf(frame.hook);
    const local = state.value.text;
    const fed = frame.hook.fed.get(local);
    if (fed === undefined) {
      this.#refuse(
        at.origin,
        `In ${where}: \`${local}\` is a state the hook starts itself, in the browser, which the authority has no first value of: declare it of a parameter — \`useReactiveState(initial)\` — which the component gives a value of the page's.`,
      );
    }
    if (fed.persistent) {
      this.#refuse(
        at.origin,
        `In ${where}: \`${local}\` binds a field of the database, and a dynamic site is rendered of local states alone. Have the reactive component read the field itself.`,
      );
    }
    const argument = argumentAt(frame.call.call.arguments, fed.index);
    if (argument === undefined) {
      this.#refuse(at.origin, `In ${where}: ${ungiven(local)}`);
    }
    const key = `${frame.prefix}${local}`;
    this.#resolve(frame, identifier, { key, kind: 'input' });
    if (!at.inputs.has(key)) {
      at.inputs.set(key, {
        at: at.origin,
        browser: browserValueOf(frame.root, key, (message) => this.#refuse(at.origin, message)),
        key,
        local,
        order: [...frame.order, state.statement.pos],
        state: undefined,
      });
    }
  }

  /** The imports of hooks' modules the derivations read, which the program imports. */
  get imports(): readonly ImportBinding[] {
    return [...this.#imports.values()];
  }

  /**
   * The names the code a site's function is written of declares, or reads as a global: the program
   * names nothing it chooses for the function — an input, an import — by any of them.
   */
  get taken(): ReadonlySet<string> {
    return this.#taken;
  }

  /**
   * Whether a site's value is computed of each constant `declarations` declares, which the grammar
   * of values holds to. Whether its initialization can be omitted without skipping application
   * work is checked separately where the browser chooses which declarations it keeps.
   */
  computes(declarations: readonly Node[]): boolean {
    return declarations.every((declaration) => this.#constants.has(declaration));
  }

  /**
   * Follows a read of a name of the component's that the browser computes or holds — a state, a
   * constant, a hook's item — into the states it is made of, each added to `inputs`. Answers
   * whether it was one: any other read is the caller's.
   */
  read(
    identifier: Identifier,
    entry: TopLevel,
    reading: {
      readonly inputs: Map<string, SiteInput>;
      readonly scope?: ReadonlySet<string> | undefined;
    },
  ): boolean {
    const at = {
      inputs: reading.inputs,
      origin: identifier,
      scope: new Set<string>(),
      visited: new Map(),
    };
    return this.#componentRead(
      identifier,
      entry,
      around(at, reading.scope, this.#context.component.names),
    );
  }

  /**
   * Notes a name the site's own code — its element, its conditions — declares, or reads as a
   * global: the program writes that code as it is, so it chooses no name of either, and a
   * declaration there takes no global that the code written in place under it reads.
   */
  inSite(identifier: Identifier): void {
    this.#taken.add(identifier.text);
  }

  /**
   * The rewrite of code in `frame` as the program writes it: each read followed written as the name
   * of its input, as its value computed in place, or as the name of its import; `base` for the rest;
   * and each value the code makes, and what each function a method is given answers, through
   * `$.counted(…)` (`counting`).
   */
  rewrite(frame: Frame, naming: Naming, base?: Rewrite): Rewrite {
    const resolved = this.#resolved.get(prefixOf(frame));
    return counting(this.#sourceOf(frame), (node) => {
      if (isShorthandPropertyAssignment(node) && isIdentifier(node.name)) {
        const value = this.#written(resolved?.get(node.name), naming);
        return value === undefined ? undefined : `${node.name.text}: ${value}`;
      }
      if (isIdentifier(node)) {
        return this.#written(resolved?.get(node), naming, isCalledValue(node));
      }
      return base?.(node);
    });
  }
}
