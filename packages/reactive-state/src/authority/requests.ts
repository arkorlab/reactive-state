import {
  type FieldOperation,
  type Json,
  type OperationArgument,
  type OperationCall,
  type RootRequest,
  type SiteInputs,
  type Value,
  type View,
  VIEW_LIMITS,
  type ViewRequest,
} from '../program.ts';
import { MAX_TEXT_LENGTH } from '../server/schema.ts';
import { HTTP_BAD_REQUEST, HTTP_PAYLOAD_TOO_LARGE, HTTP_UNPROCESSABLE } from '../status.ts';
import { isCarriedJson } from './canonical.ts';
import { refusal } from './errors.ts';
import { fitsJson, fitsJsonCharacters, MAX_CARRIED_BYTES } from './json-size.ts';

/**
 * What a request to the authority names, read from whatever it is — a host hands the engine what a
 * caller sent, whatever its type says — before anything else is done for it: refused (400) when it
 * names nothing the authority reads. Only the fields the contract names are read, and nothing else
 * of the object is kept.
 */

const OPERATION_ID = /^[\w:-]{1,128}$/u;
/** The most an update's captured values take, as canonical JSON. */
const MAX_CAPTURES_LENGTH = 4096;
/** The most arguments a server operation is sent, and the most entries one form holds. */
const MAX_ARGUMENTS = 64;
const MAX_FORM_ENTRIES = 64;
/** The most bytes of UTF-8 one form's names and values take together. */
const MAX_FORM_BYTES = 16_384;
/**
 * The most an operation's arguments take together, as JSON's text: what either host reads, so that
 * the Node authority's body (`MAX_BODY_BYTES`) holds every call this lets through, and the two
 * refuse alike. A form of 16 KiB whose every character JSON escapes takes 96 Ki of it.
 */
const MAX_ARGUMENTS_LENGTH = 262_144;

const encoder = new TextEncoder();

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is one a field is sent: text, a boolean, or a number JSON carries — a finite one.
 * JSON writes any other as `null`, which no field is sent either.
 */
function isValue(value: unknown): value is Value {
  return (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function invalid(code: string, message: string): Error {
  return refusal(HTTP_BAD_REQUEST, code, message);
}

/**
 * Whether `value` is the props a page renders a root with: a JSON object, as JSON carries one
 * (`isCarriedJson`) — a route's root's as well as any other's.
 */
export function isRootProps(value: unknown): value is Readonly<Record<string, Json>> {
  return isObject(value) && isCarriedJson(value);
}

/**
 * Validated transport JSON, copied without inherited serialization or iteration hooks.
 * @returns The same JSON value, copied into ordinary arrays and objects.
 */
function carried(value: Json): Json {
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'number' ? normalizedNumber(value) : value;
  }
  return Array.isArray(value)
    ? carriedArray(value as readonly Json[])
    : carriedObject(value as Readonly<Record<string, Json | undefined>>);
}

/** Validated array indices, with missing entries normalized instead of reading inherited values. */
function carriedArray(value: readonly Json[]): Json[] {
  const copied: Json[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))?.value as Json | undefined;
    copied.push(item === undefined ? null : carried(item));
  }
  return copied;
}

/** Own validated data entries, preserving ordinary prototypes and treating proto text as a key. */
function carriedObject(record: Readonly<Record<string, Json | undefined>>): Record<string, Json> {
  const copied: Record<string, Json> = {};
  for (const [key, item] of Object.entries(record)) {
    if (item !== undefined) {
      Object.defineProperty(copied, key, {
        configurable: true,
        enumerable: true,
        value: carried(item),
        writable: true,
      });
    }
  }
  return copied;
}

/**
 * JSON carries signed zero as zero. Every number copied is finite: a field's value (`isValue`) as
 * any number of JSON (`isCarriedJson`).
 */
function normalizedNumber(value: number): number {
  return value + 0;
}

/** The root a page renders: `{ component, props, build }`, its props copied as JSON carries them. */
export function rootOf(request: unknown): RootRequest {
  const { build, component, props } = (isObject(request) ? request : {}) as Partial<
    Record<keyof RootRequest, unknown>
  >;
  if (typeof component !== 'string' || typeof build !== 'string' || !isRootProps(props)) {
    throw invalid('INVALID_ROOT', 'Name the component, its props as a JSON object, and the build.');
  }
  if (!fitsJson({ build, component, props }, MAX_CARRIED_BYTES)) {
    throw refusal(HTTP_PAYLOAD_TOO_LARGE, 'TOO_LARGE', 'The request is too large.');
  }
  return { build, component, props: carried(props) as RootRequest['props'] };
}

/** A view's inputs for one site: a JSON object. */
function isInputs(value: unknown): value is SiteInputs {
  return isObject(value) && isCarriedJson(value);
}

/** A view or part's own JSON data entries, before traversal can dispatch an accessor. */
function isViewContainer(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isObject(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.getOwnPropertyNames(value).every((name) => {
      const entry = Object.getOwnPropertyDescriptor(value, name);
      return entry?.enumerable === true && 'value' in entry;
    })
  );
}

/** Whether `value` is a view as `View` names one, within the limits a page's view keeps to. */
function isView(value: unknown): value is View {
  if (!isViewContainer(value)) {
    return false;
  }
  const parts = Object.values(value);
  return (
    parts.length <= VIEW_LIMITS.parts &&
    parts.every((sites) => {
      return (
        isViewContainer(sites) &&
        Object.keys(sites).length <= VIEW_LIMITS.sites &&
        Object.values(sites).every((inputs) => isInputs(inputs))
      );
    }) &&
    fitsJson(value as View, VIEW_LIMITS.bytes)
  );
}

/**
 * A root rendered again for a page's view: the frame's subscription, as signed, and the view — the
 * inputs of each site the page shows, by part and site, as JSON objects within the view's limits.
 */
export function viewRequestOf(request: unknown): ViewRequest {
  const { subscription, view } = (isObject(request) ? request : {}) as Partial<
    Record<keyof ViewRequest, unknown>
  >;
  if (
    typeof subscription !== 'string' ||
    subscription.length > VIEW_LIMITS.subscription ||
    !isView(view)
  ) {
    throw invalid(
      'INVALID_VIEW',
      `Name the frame's subscription, and the view: at most ${String(VIEW_LIMITS.parts)} parts of at most ${String(VIEW_LIMITS.sites)} sites each, the inputs of each a JSON object, in ${String(VIEW_LIMITS.bytes)} bytes of JSON.`,
    );
  }
  return { subscription, view: carried(view) as View };
}

/** One write to a field: its binding, its id, its registered update, and its value or captures. */
export function fieldOperationOf(request: unknown): FieldOperation {
  const { binding, captures, operationId, updaterId, value } = (
    isObject(request) ? request : {}
  ) as Partial<Record<keyof FieldOperation, unknown>>;
  if (
    typeof binding !== 'string' ||
    typeof updaterId !== 'string' ||
    typeof operationId !== 'string' ||
    !OPERATION_ID.test(operationId) ||
    !(value === undefined || isValue(value)) ||
    !(captures === undefined || (isObject(captures) && isCarriedJson(captures)))
  ) {
    throw invalid('INVALID_OPERATION', 'The operation is not valid.');
  }
  // No field holds text this long, so it is refused before anything is rendered for it.
  if (typeof value === 'string' && value.length > MAX_TEXT_LENGTH) {
    throw refusal(
      HTTP_UNPROCESSABLE,
      'INVALID_VALUE',
      `The text is longer than ${String(MAX_TEXT_LENGTH)}.`,
    );
  }
  if (captures !== undefined && !fitsJsonCharacters(captures, MAX_CAPTURES_LENGTH)) {
    throw refusal(HTTP_PAYLOAD_TOO_LARGE, 'TOO_LARGE', 'The update captured too much.');
  }
  // As JSON carries them (`carried`): `-0` as `0`, as the Node authority reads them, whatever crossed
  // a Durable Object's RPC.
  return {
    binding,
    operationId,
    updaterId,
    ...(value !== undefined && { value: carried(value) as Value }),
    ...(captures !== undefined && {
      captures: carried(captures) as Readonly<Record<string, Json>>,
    }),
  };
}

/** A form's entries, each a name and a text value, within the limits a form of this kind takes. */
function formOf(entries: unknown): readonly (readonly [string, string])[] {
  if (!Array.isArray(entries)) {
    throw invalid('INVALID_OPERATION', 'A form is sent as its entries.');
  }
  if (entries.length > MAX_FORM_ENTRIES) {
    throw refusal(
      HTTP_PAYLOAD_TOO_LARGE,
      'TOO_LARGE',
      `A form is sent ${String(MAX_FORM_ENTRIES)} entries at most.`,
    );
  }
  let bytes = 0;
  const form: (readonly [string, string])[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const [name, value] = formEntry(indexedData(entries, index));
    bytes += encoder.encode(name).length + encoder.encode(value).length;
    form.push([name, value]);
  }
  if (bytes > MAX_FORM_BYTES) {
    throw refusal(
      HTTP_PAYLOAD_TOO_LARGE,
      'TOO_LARGE',
      `A form is sent ${String(MAX_FORM_BYTES)} bytes at most.`,
    );
  }
  return form;
}

/** A protocol array index supplies data, without inherited values or accessor dispatch. */
function indexedData(values: readonly unknown[], index: number): unknown {
  const entry = Object.getOwnPropertyDescriptor(values, String(index));
  return entry !== undefined && 'value' in entry ? entry.value : undefined;
}

/** A form tuple is exactly two own data strings; no iterator or indexed getter is consulted. */
function formEntry(entry: unknown): readonly [string, string] {
  if (!Array.isArray(entry) || entry.length !== 2) {
    throw invalid('INVALID_OPERATION', 'Each entry of a form is a name and its text.');
  }
  const name = indexedData(entry, 0);
  const value = indexedData(entry, 1);
  if (typeof name !== 'string' || typeof value !== 'string') {
    throw invalid('INVALID_OPERATION', 'Each entry of a form is a name and its text.');
  }
  return [name, value];
}

function argumentOf(argument: unknown): OperationArgument {
  if (isObject(argument)) {
    const names = Object.keys(argument);
    const [key] = names;
    const entry = key === undefined ? undefined : Object.getOwnPropertyDescriptor(argument, key);
    if (names.length === 1 && entry?.enumerable === true && 'value' in entry) {
      const value: unknown = entry.value;
      if (key === 'form') {
        return { form: formOf(value) };
      }
      if (key === 'json' && isCarriedJson(value)) {
        return { json: value };
      }
    }
  }
  throw invalid('INVALID_OPERATION', 'Each argument is sent as `{ json }` or as `{ form }`.');
}

/** A server operation, as the application's server asks for it to be run. */
export function operationCallOf(request: unknown): OperationCall {
  const { args, build, module, name, operationId } = (isObject(request) ? request : {}) as Partial<
    Record<keyof OperationCall, unknown>
  >;
  if (
    typeof module !== 'string' ||
    typeof name !== 'string' ||
    typeof build !== 'string' ||
    typeof operationId !== 'string' ||
    !OPERATION_ID.test(operationId) ||
    !Array.isArray(args)
  ) {
    throw invalid('INVALID_OPERATION', 'The operation is not valid.');
  }
  if (args.length > MAX_ARGUMENTS) {
    throw refusal(
      HTTP_PAYLOAD_TOO_LARGE,
      'TOO_LARGE',
      `An operation is sent ${String(MAX_ARGUMENTS)} arguments at most.`,
    );
  }
  const read: OperationArgument[] = [];
  for (let index = 0; index < args.length; index += 1) {
    read.push(argumentOf(indexedData(args, index)));
  }
  if (!fitsJsonCharacters(read, MAX_ARGUMENTS_LENGTH)) {
    throw refusal(
      HTTP_PAYLOAD_TOO_LARGE,
      'TOO_LARGE',
      `An operation is sent ${String(MAX_ARGUMENTS_LENGTH)} characters of arguments at most, as JSON.`,
    );
  }
  return {
    args: read.map((argument) =>
      'json' in argument ? { json: carried(argument.json) } : argument,
    ),
    build,
    module,
    name,
    operationId,
  };
}

/** The arguments an operation is called with: a form's entries as `FormData`, JSON as itself. */
export function argumentsOf(args: readonly OperationArgument[]): readonly unknown[] {
  return args.map((argument): unknown => {
    let value: unknown;
    if ('json' in argument) {
      value = argument.json;
    } else {
      const form = new FormData();
      for (const [name, entry] of argument.form) {
        form.append(name, entry);
      }
      value = form;
    }
    return value;
  });
}
