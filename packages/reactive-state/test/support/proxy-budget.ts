/** Proxy origins whose measurement must refuse without inspecting their application traps. */
export function proxyMeasurements(): readonly {
  readonly name: string;
  readonly make: () => { readonly value: unknown; readonly calls: readonly string[] };
}[] {
  const cases = (['ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'] as const).map((trap) => {
    return {
      name: trap,
      make() {
        const calls: string[] = [];
        const value = new Proxy(
          { value: 'ok' },
          {
            [trap](): never {
              calls.push(trap);
              throw new Error('application trap');
            },
          },
        );
        return { value, calls };
      },
    };
  });
  return [
    ...cases,
    {
      name: 'nested Proxy',
      make() {
        const calls: string[] = [];
        const proxy = new Proxy(
          { value: 'ok' },
          {
            ownKeys(): never {
              calls.push('ownKeys');
              throw new Error('application trap');
            },
          },
        );
        return { value: { nested: [proxy] }, calls };
      },
    },
    {
      name: 'Proxy prototype',
      make() {
        const calls: string[] = [];
        const prototype = new Proxy(
          {},
          {
            getOwnPropertyDescriptor(): never {
              calls.push('descriptor');
              throw new Error('application trap');
            },
          },
        );
        const value: unknown = Object.create(prototype);
        return { value, calls };
      },
    },
    {
      name: 'revoked Proxy',
      make() {
        const value = Proxy.revocable({}, {});
        value.revoke();
        return { value: value.proxy, calls: [] };
      },
    },
    {
      name: 'callable Proxy',
      make: () => ({ value: new Proxy(() => 'ok', {}), calls: [] }),
    },
  ];
}
