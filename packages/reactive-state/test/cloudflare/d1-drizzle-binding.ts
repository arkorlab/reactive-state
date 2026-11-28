/** A fixture binding's property, whose native methods keep the binding as their receiver. */
export function bindingValue(target: D1Database, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key);
  return typeof value === 'function' ? value.bind(target) : value;
}
