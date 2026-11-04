import {
  type Json,
  SET_STATES,
  type SiteDescriptor,
  type SiteInputs,
  type View as PageView,
} from '../program.ts';
import { HTTP_BAD_REQUEST } from '../status.ts';
import { canonicalJson, frozenJson, shortDigest } from './canonical.ts';
import type { Dependencies } from './dependencies.ts';
import { AuthorityError, asRefusal, describeThrown, isAuthorityError } from './errors.ts';
import { type CheckedItem, itemsOf } from './items.ts';
import {
  firstItems,
  firstListFailure,
  kindOf,
  Region,
  type Renderer,
  type SiteFunctions,
  siteFunctions,
  type SiteRun,
  siteShows,
  treeOf,
} from './render.ts';
import { carryInputs, kindFits, setInputsOf, setStatesOf } from './site-sets.ts';
import {
  type ClientOutput,
  isSiteStep,
  type JsonKind,
  type Output,
  type ShownItem,
  type ShownSite,
  type SiteOutput,
  type SiteStep,
  type Skeleton,
  type SkeletonInstance,
  type SkeletonProp,
  type Step,
  stepOf,
} from './skeleton.ts';
import { rendered } from './tree.ts';

/**
 * The dynamic sites of one render: each client part with sites is named by where it stands — its
 * instance id — and shows the sites the page's view names for it, rendered with the inputs the
 * view sends, and of those it leaves out with the states' first values now (`followedInputs`); a
 * part the view does not name shows the sites its states' first values show. The
 * components a site renders are rendered as any are, the memo's renderings of them used where it
 * holds them, and what they read is what the render depends on. The view a render shows is what it
 * answers with its frame, for the page to compare with what it shows.
 *
 * A list site renders its element for each item of an array of its inputs, each item by its key:
 * keys of text or numbers, none twice, items of JSON, at most `VIEW_LIMITS.items` of them, and an
 * empty list shows nothing — its items made and checked once a render, as it is chosen, and those
 * rendered. What a site's own functions make of the inputs a view sends — a list of
 * other items, or a fault — is that site's refusal (`INVALID_VIEW`), which the answer holds in its
 * place, the rest of the root rendered as ever: never the authority's fault, which the page would
 * ask for again, nor the whole view's, which would fail every site the page waits on with it. So is
 * what the site functions of a part it renders make of the part's first values, which those inputs
 * made — a part no view could name before — the refusal following what the part read. A view
 * no page makes — a site the part has not, inputs it does not read — is refused whole (400).
 */

/** What a site's refusal of the inputs a view sends is coded. */
const INVALID_VIEW = 'INVALID_VIEW';

/**
 * A part the view names, and the site of it, sent inputs it does not read: a request no page makes;
 * `cause`, what a site's own function threw of them, where it threw.
 */
function invalidView(message: string, cause?: unknown): Error {
  return new AuthorityError(message, {
    code: INVALID_VIEW,
    status: HTTP_BAD_REQUEST,
    ...(cause !== undefined && { cause }),
  });
}

/**
 * The id a view names a client part by: where it stands — each component from the root to it, by
 * its id, its key, its region and its ordinal, and each site on the way, by its own id and the key
 * of the item of a list — never its props, which change with what it reads, nor the inputs a site
 * on the way was rendered with: a list's items moved stand where they stood.
 */
function instanceIdOf(path: readonly Step[]): string {
  return shortDigest([
    'instance',
    path.map((step) => {
      if (!isSiteStep(step)) {
        return [step.c, step.k, step.r, step.n];
      }
      return step.k === undefined ? [step.s] : [step.s, step.k];
    }),
  ]);
}

/**
 * Checks `inputs`, sent for the site `site` of a part, against what the site reads: exactly its
 * inputs, each of the kind its first value is, or `null` where either is (`kindFits`).
 */
export function checkedInputs(
  site: string,
  declared: Pick<SiteOutput, 'inputs' | 'kinds'>,
  inputs: unknown,
): SiteInputs {
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
    throw invalidView(`The inputs of the site ${site} are an object of its states' values.`);
  }
  const given = inputs as Readonly<Record<string, Json>>;
  const names = Object.keys(given);
  if (
    names.length !== declared.inputs.length ||
    declared.inputs.some((name) => !Object.hasOwn(given, name))
  ) {
    const read = declared.inputs.map((name) => JSON.stringify(name)).join(', ');
    throw invalidView(
      `The site ${site} reads ${read === '' ? 'no state' : read}, and is sent those alone.`,
    );
  }
  for (const name of declared.inputs) {
    const kind: JsonKind | undefined = declared.kinds[name];
    if (!kindFits(kindOf(given[name] as Json), kind)) {
      throw invalidView(`The input \`${name}\` of the site ${site} is a ${kind ?? 'value'}.`);
    }
  }
  // A copy of them, each object's keys in order of their names, frozen through: what the site's
  // functions read of them is what they read of the page's same values, and of a first render's.
  return frozenJson(given);
}

/** What a site of a descriptor reads, as `checkedInputs` checks it: its inputs, and their kinds. */
export function declaredOf(
  site: SiteDescriptor,
  states: Readonly<Record<string, unknown>>,
): Pick<SiteOutput, 'inputs' | 'kinds'> {
  const kinds: Record<string, JsonKind> = {};
  for (const input of site.inputs) {
    const value = states[input];
    Object.defineProperty(kinds, input, {
      enumerable: true,
      value: kindOf((value ?? null) as Json),
    });
  }
  return { inputs: site.inputs, kinds };
}

/** A skeleton's node, as its kind says what it is. */
type SkeletonNode = Exclude<Skeleton, readonly Skeleton[] | boolean | number | string | null>;

/** What a skeleton's node is, by its kind: anything else a prop holds is JSON or an action. */
const NODE_KINDS: ReadonlySet<unknown> = new Set(['element', 'fragment', 'instance', 'module']);

function isSkeletonNode(value: unknown): value is SkeletonNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    NODE_KINDS.has((value as { readonly kind?: unknown }).kind)
  );
}

/**
 * A render's root, its sites rendered, the view it shows, and what of it a subscription names: the
 * parts explicitly requested or showing otherwise than at first; a subscription render finds the
 * rest again.
 */
export interface Filled {
  readonly root: SkeletonInstance;
  readonly view: PageView;
  readonly named: PageView;
}

/**
 * Where the walk stands: the path from the root, the depth of the component it is in, and — beneath
 * a site a view names — how that site runs the site functions of the parts in it (`asView`).
 */
interface At {
  readonly path: readonly Step[];
  readonly depth: number;
  readonly asView?: SiteRun | undefined;
}

/**
 * A site a part shows: its id, the inputs it is shown with, whether a view sent them, its refusal
 * of them, where its guard or its list refused them already, and a list's items, as it was chosen.
 */
interface Showing {
  readonly site: string;
  readonly inputs: SiteInputs;
  readonly requested: boolean;
  readonly refused: AuthorityError | undefined;
  readonly items: readonly CheckedItem[] | undefined;
}

/**
 * The sites a part shows, with their inputs, the items of each list among them, checked, and those
 * that refused the inputs a view sent.
 */
interface Chosen {
  readonly sites: Readonly<Record<string, SiteInputs>>;
  /** Of the sites a view names, the inputs it sent: those it left out the page still follows. */
  readonly sent: Readonly<Record<string, SiteInputs>>;
  readonly items: ReadonlyMap<string, readonly CheckedItem[]>;
  readonly refused: ReadonlyMap<string, AuthorityError>;
}

/**
 * The inputs a view sent for a site, and each it left out of a state the part starts of a value:
 * that value, as the authority renders it now. The page leaves out a state it has not set, which
 * follows what the authority renders of it (`useReactiveState`), and shows the site for that value
 * as it takes it — at once, of the frame that brings both. What is no object is left for
 * `checkedInputs` to refuse.
 */
function followedInputs(declared: SiteOutput, inputs: unknown, output: ClientOutput): unknown {
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
    return inputs;
  }
  const filled: Record<string, unknown> = { ...(inputs as Readonly<Record<string, unknown>>) };
  for (const name of declared.inputs) {
    const state = Object.hasOwn(output.states, name) ? output.states[name] : undefined;
    if (state !== undefined && !Object.hasOwn(filled, name) && 'value' in state) {
      Object.defineProperty(filled, name, { enumerable: true, value: state.value });
    }
  }
  return filled;
}

/** Whether `error` is a site's refusal of the inputs a view sent. */
function isSiteRefusal(error: unknown): error is AuthorityError {
  return error instanceof AuthorityError && error.code === INVALID_VIEW;
}

/** A site that refused the inputs a view sent, as the answer holds it in the site's place. */
function refusedSite(inputs: SiteInputs, error: AuthorityError): ShownSite {
  return { inputs, refused: { code: error.code, message: error.message } };
}

/** The sites a part shows while its states hold their first values: each its guard shows then. */
function firstOf(output: ClientOutput): Readonly<Record<string, SiteInputs>> {
  const first: Record<string, SiteInputs> = {};
  for (const [site, declared] of Object.entries(output.sites)) {
    if (declared.initial !== null) {
      Object.defineProperty(first, site, { enumerable: true, value: declared.initial });
    }
  }
  return first;
}

class Filling {
  readonly #renderer: Renderer;
  readonly #requested: PageView | undefined;
  readonly #dependencies: Dependencies;
  readonly #recorded: string[] = [];
  readonly view: Record<string, Readonly<Record<string, SiteInputs>>> = {};
  readonly named: Record<string, Readonly<Record<string, SiteInputs>>> = {};

  constructor(renderer: Renderer, requested: PageView | undefined, dependencies: Dependencies) {
    this.#renderer = renderer;
    this.#requested = requested;
    this.#dependencies = dependencies;
  }

  async #output(output: Output, at: At): Promise<Output> {
    switch (output.kind) {
      case 'refused': {
        return output;
      }
      case 'tree': {
        const tree = await this.#tree(output.tree, at);
        return tree === output.tree ? output : { kind: 'tree', tree };
      }
      case 'client': {
        return this.#client(output, at);
      }
    }
  }

  async #client(output: ClientOutput, at: At): Promise<Output> {
    const slots: Record<string, Skeleton> = {};
    let changed = false;
    for (const [name, slot] of Object.entries(output.slots)) {
      const filled = await this.#tree(slot, at);
      changed ||= filled !== slot;
      Object.defineProperty(slots, name, { enumerable: true, value: filled });
    }
    if (Object.keys(output.sites).length === 0) {
      return changed ? { ...output, slots } : output;
    }
    const instance = instanceIdOf(at.path);
    const first = firstOf(output);
    const { items, refused, sent, sites: chosen } = this.#chosen(instance, output, first);
    const requested = this.#requested !== undefined && Object.hasOwn(this.#requested, instance);
    const failure = firstListFailure(output);
    if (!requested && failure !== undefined) {
      at.asView?.(() => {
        throw invalidView(failure);
      });
    }
    const shown: Record<string, ShownSite> = {};
    for (const [site, inputs] of Object.entries(chosen)) {
      const showing = {
        inputs,
        items: items.get(site),
        refused: refused.get(site),
        requested,
        site,
      };
      const value = await this.#site(output, showing, at);
      Object.defineProperty(shown, site, { enumerable: true, value });
    }
    this.view[instance] = chosen;
    this.#recorded.push(instance);
    // What the frame's subscription names: the inputs as the view sent them, those it left out
    // rendered again of what the authority renders then.
    if (requested || canonicalJson(chosen) !== canonicalJson(first)) {
      this.named[instance] = sent;
    }
    return { ...output, instance, shown, slots };
  }

  /**
   * The sites the part `instance` shows, with their inputs: as the view names them, or at first;
   * the items of each list, made once; and those whose functions refused the inputs a view sent,
   * which stand refused.
   */
  #chosen(
    instance: string,
    output: ClientOutput,
    first: Readonly<Record<string, SiteInputs>>,
  ): Chosen {
    const refused = new Map<string, AuthorityError>();
    const requested = this.#requested;
    if (requested === undefined || !Object.hasOwn(requested, instance)) {
      return { items: firstItems(output), refused, sent: first, sites: first };
    }
    const entry = requested[instance] ?? {};
    const given = setStatesOf(entry, output);
    // The values the page set that a site the view names carries; `SET_STATES` holds the rest.
    const carried: Record<string, Json> = {};
    const chosen: Record<string, SiteInputs> = {};
    const sent: Record<string, SiteInputs> = Object.hasOwn(entry, SET_STATES)
      ? { [SET_STATES]: given }
      : {};
    const items = new Map<string, readonly CheckedItem[]>();
    const sites = Object.entries(entry).filter(([site]) => site !== SET_STATES);
    for (const [site, inputs] of sites) {
      const declared = Object.hasOwn(output.sites, site) ? output.sites[site] : undefined;
      if (declared === undefined) {
        throw invalidView(`The part the view names has no site ${site}.`);
      }
      const checked = checkedInputs(site, declared, followedInputs(declared, inputs, output));
      carryInputs(carried, inputs, output);
      const functions = siteFunctions(output, site);
      // Shown only where its conditions hold now: a parent's own condition — a prop it was rendered
      // with, what its server part computed — may have changed since the page chose the site. A
      // list of no items shows nothing.
      let shows = true;
      try {
        shows = functions === undefined || showsOfView(site, functions, checked, items);
      } catch (error) {
        if (!isSiteRefusal(error)) {
          throw error;
        }
        refused.set(site, error);
      }
      if (shows) {
        Object.defineProperty(chosen, site, { enumerable: true, value: checked });
      }
      // Named, though it shows not now: the page's, which no site the authority opens takes.
      Object.defineProperty(sent, site, { enumerable: true, value: inputs });
    }
    // A part the view names without the states the page set shows the sites it names alone: a part
    // no longer rendered, one holding a value JSON carries not, a request past what it carries, a
    // view of before them.
    if (Object.hasOwn(entry, SET_STATES)) {
      // What `SET_STATES` says stands over a site's: one a render not committed yet waits for.
      this.#opened(output, entry, { ...carried, ...given }, { chosen, items });
    }
    return { items, refused, sent, sites: chosen };
  }

  /**
   * Of a part a view names with the states the page set, `set`, the sites it names not that show,
   * each where its conditions hold of those and of the authority's own values of the rest: a site a
   * state the page follows opens shows in the frame that brings the state's value. What a site's own
   * functions refuse of them, the page asked not for: the site does not show.
   */
  #opened(
    output: ClientOutput,
    entry: Readonly<Record<string, unknown>>,
    set: Readonly<Record<string, Json>>,
    into: {
      readonly chosen: Record<string, SiteInputs>;
      readonly items: Map<string, readonly CheckedItem[]>;
    },
  ): void {
    for (const [site, declared] of Object.entries(output.sites)) {
      if (Object.hasOwn(entry, site)) {
        continue;
      }
      const functions = siteFunctions(output, site);
      try {
        const given = setInputsOf(set, declared.inputs);
        const checked = checkedInputs(site, declared, followedInputs(declared, given, output));
        if (functions === undefined || showsOfView(site, functions, checked, into.items)) {
          Object.defineProperty(into.chosen, site, { enumerable: true, value: checked });
        }
      } catch (error) {
        if (!isSiteRefusal(error)) {
          throw error;
        }
      }
    }
  }

  /**
   * The site `shown.site` of `output`, rendered with its inputs, or its refusal of the inputs a
   * view sent, in its place.
   */
  async #site(output: ClientOutput, shown: Showing, at: At): Promise<ShownSite> {
    if (shown.refused !== undefined) {
      return refusedSite(shown.inputs, shown.refused);
    }
    // The site's own functions' refusals alone are the site's: one of a part inside it — a view of
    // it no page makes — is the whole view's, and passes through.
    const own = new WeakSet<AuthorityError>();
    const checkpoint = this.#recorded.length;
    try {
      return await this.#rendering(output, shown, { at, own });
    } catch (error) {
      if (isSiteRefusal(error) && own.has(error)) {
        for (const instance of this.#recorded.splice(checkpoint)) {
          Reflect.deleteProperty(this.view, instance);
          Reflect.deleteProperty(this.named, instance);
        }
        return refusedSite(shown.inputs, error);
      }
      throw error;
    }
  }

  /**
   * The site `shown.site` of `output`, rendered with its inputs — its element, or each item of a
   * list, under a step of its own — and the sites inside it in turn.
   */
  async #rendering(
    output: ClientOutput,
    shown: Showing,
    { at, own }: { readonly at: At; readonly own: WeakSet<AuthorityError> },
  ): Promise<ShownSite> {
    const functions = siteFunctions(output, shown.site);
    if (functions === undefined) {
      throw new Error(
        `A rendering of a part keeps no site ${shown.site}: compile the application again.`,
      );
    }
    const { inputs, requested, site } = shown;
    const step: SiteStep = { i: inputs, s: site };
    // What the site's own functions make of the inputs a view sent is the site's refusal, noted
    // as its own — and what the site functions of a part it renders make of the part's first
    // values, which those inputs made: beneath it, the walk runs them as its own.
    const asView: SiteRun | undefined = requested
      ? (made) => {
          try {
            return ofView(site, made);
          } catch (error) {
            if (isSiteRefusal(error)) {
              own.add(error);
            }
            throw error;
          }
        }
      : at.asView;
    const run: SiteRun = asView ?? ((made) => made());
    if (functions.each === undefined) {
      const node = run(() => functions.render(inputs));
      const path = [...at.path, step];
      const content = await this.#content(node, { asView, depth: at.depth, path });
      return { content, inputs };
    }
    // A list's items were made and checked as it was chosen, of these inputs: its function runs
    // once a render.
    const { items } = shown;
    if (items === undefined) {
      throw new Error(`The list ${site} was chosen of no items made: a fault of the authority.`);
    }
    const shownItems: ShownItem[] = [];
    for (const { item, key, render } of items) {
      const node = run(render);
      const path = [...at.path, { ...step, k: key }];
      const content = await this.#content(node, { asView, depth: at.depth, path });
      shownItems.push({ content, item, key });
    }
    return { inputs, items: shownItems };
  }

  /** What a site's function made, rendered where the walk stands, and the sites inside it in turn. */
  async #content(node: unknown, at: At): Promise<Skeleton> {
    this.#renderer.counts.siteRenders += 1;
    const content = await treeOf(
      this.#renderer,
      rendered(node),
      { asView: at.asView, dependencies: this.#dependencies, depth: at.depth },
      new Region(''),
    );
    return this.#tree(content, at);
  }

  /** A tree the component the walk is in rendered, the components in it filled in turn. */
  async #tree(skeleton: Skeleton, at: At): Promise<Skeleton> {
    if (Array.isArray(skeleton)) {
      const list = skeleton as readonly Skeleton[];
      const items: Skeleton[] = [];
      let changed = false;
      for (const item of list) {
        const filled = await this.#tree(item, at);
        changed ||= filled !== item;
        items.push(filled);
      }
      return changed ? items : list;
    }
    if (!isSkeletonNode(skeleton)) {
      return skeleton;
    }
    switch (skeleton.kind) {
      case 'instance': {
        return this.instance(skeleton, {
          asView: at.asView,
          depth: at.depth + 1,
          path: [...at.path, stepOf(skeleton)],
        });
      }
      case 'fragment': {
        const children = await this.#tree(skeleton.children, at);
        return children === skeleton.children
          ? skeleton
          : { ...skeleton, children: children as readonly Skeleton[] };
      }
      case 'element':
      case 'module': {
        return this.#element(skeleton, at);
      }
    }
  }

  /** An element, or a module's export, its children and the props that render filled. */
  async #element(
    element: Extract<SkeletonNode, { readonly kind: 'element' | 'module' }>,
    at: At,
  ): Promise<Skeleton> {
    const children = await this.#tree(element.children, at);
    const props: Record<string, SkeletonProp> = {};
    let changed = children !== element.children;
    for (const [name, value] of Object.entries(element.props)) {
      const filled =
        Array.isArray(value) || isSkeletonNode(value)
          ? await this.#tree(value as Skeleton, at)
          : value;
      changed ||= filled !== value;
      Object.defineProperty(props, name, { enumerable: true, value: filled });
    }
    return changed ? { ...element, children: children as readonly Skeleton[], props } : element;
  }

  /** `instance`, where the walk stands, with the sites of every part in it rendered. */
  async instance(instance: SkeletonInstance, at: At): Promise<SkeletonInstance> {
    const output = await this.#output(instance.output, at);
    return output === instance.output ? instance : { ...instance, output };
  }
}

/**
 * Whether the site `site` shows of the inputs a view sent, `inputs`: its guard holds of them, and a
 * list holds an item of them — its items made and checked once (`itemsOf`), kept in `items` for
 * its rendering to render. What its functions make of the inputs is the view's (`ofView`).
 */
function showsOfView(
  site: string,
  functions: SiteFunctions,
  inputs: SiteInputs,
  items: Map<string, readonly CheckedItem[]>,
): boolean {
  if (!ofView(site, () => siteShows(functions, inputs))) {
    return false;
  }
  const { each } = functions;
  if (each === undefined) {
    return true;
  }
  const listed = ofView(site, () => itemsOf(site, each, inputs, invalidView));
  items.set(site, listed);
  return listed.length > 0;
}

/**
 * What `made` makes of inputs a view sent: any fault of a site's own function of them is the view's
 * (400), which the page sends no more — not the authority's, which it would ask for again. A
 * refusal stays what it is, of whichever copy of the package threw it; a fault is the refusal's
 * cause, and the authority's log keeps it, for one the inputs only revealed of the code.
 */
function ofView<T>(site: string, made: () => T): T {
  try {
    return made();
  } catch (error) {
    if (isAuthorityError(error)) {
      throw asRefusal(error);
    }
    // The authority's own log wherever it runs — stderr in Node, the object's log in workerd —
    // through the one writer both have.
    // eslint-disable-next-line no-console
    console.error(`The site ${site} faulted of the inputs a view sent: ${describeThrown(error)}`);
    throw invalidView(`The site ${site} renders nothing of the inputs the view sends.`, error);
  }
}

/**
 * The sites of every part `root` renders, rendered for the view `requested` — at first, for a part
 * it does not name — in the render's call, what they read joining `dependencies`: the root as the
 * page shows it, and the view it shows.
 */
export async function fillSites(
  renderer: Renderer,
  root: SkeletonInstance,
  requested: PageView | undefined,
  dependencies: Dependencies,
): Promise<Filled> {
  const filling = new Filling(renderer, requested, dependencies);
  const filled = await filling.instance(root, { depth: 0, path: [] });
  return { named: filling.named, root: filled, view: filling.view };
}
