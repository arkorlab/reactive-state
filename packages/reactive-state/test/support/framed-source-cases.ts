/** Source-visible receiver values, native identities and lexical writes in shared helpers. */
export const framedSourceCases = [
  {
    name: 'conditional constructed stacks',
    source:
      'function frames(flag: boolean) { return (flag ? new Error("a") : new TypeError("b")).stack; }',
    invocation: 'frames(true)',
    refused: true,
  },
  {
    name: 'conditional mixed data stack',
    source:
      'function frames(flag: boolean) { return (flag ? {stack:"data"} : new Error()).stack; }',
    invocation: 'frames(false)',
    refused: true,
  },
  {
    name: 'conditional supplied words',
    source:
      'function frames(error: Error, flag: boolean) { return (flag ? error : {message:"data"}).message; }',
    invocation: 'frames(new Error(), true)',
    refused: true,
  },
  {
    name: 'constant selected error stack',
    source:
      'const flag = true; function frames() { return (flag ? new Error() : {stack:"data"}).stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    name: 'conditional nested receiver',
    source:
      'function frames(flag: boolean) { return (flag ? new Error() : (flag ? {stack:"data"} : new TypeError())).stack; }',
    invocation: 'frames(false)',
    refused: true,
  },
  {
    name: 'native Object error stack',
    source: 'function frames(error: Error) { return Object(error).stack; }',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    name: 'native Object supplied words',
    source: 'function frames(error: Error) { return Object(error).message; }',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    name: 'native Object constructed stack',
    source: 'function frames() { return Object(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    name: 'nested native Object identity',
    source: 'function frames(error: Error) { return Object(Object(error)).stack; }',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    name: 'qualified Object identity',
    source: 'function frames(error: Error) { return globalThis.Object(error).stack; }',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    name: 'direct reaching error write',
    source:
      'function frames() { let value: {stack?: string} = {}; value = new Error(); return value.stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    name: 'reaching supplied word write',
    source:
      'function frames(error: Error) { let value: {message?: string} = {}; value = error; return value.message; }',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    name: 'unknown branch error write',
    source:
      'function frames(flag: boolean) { let value: {stack?: string} = {}; if (flag) value = new Error(); return value.stack; }',
    invocation: 'frames(true)',
    refused: true,
  },
  {
    name: 'logical assignment error write',
    source:
      'function frames() { let value: {stack?: string} | undefined; value ??= new Error(); return value.stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    name: 'later-written invoked closure write',
    source:
      'function frames() { let value: {stack?: string} = {}; set(); return value.stack; function set() { value = new Error(); } }',
    invocation: 'frames()',
    refused: true,
  },
  {
    name: 'prefix read in deferred owner',
    source:
      'function frames() { let value: {stack?: string} = {}; const read = () => value.stack; value = new Error(); return read(); }',
    invocation: 'frames()',
    refused: true,
  },
  {
    name: 'native constructor alias stack',
    source: 'const NativeError = Error; function frames() { return new NativeError().stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    name: 'qualified constructor alias stack',
    source:
      'const NativeError = globalThis.TypeError; function frames() { return new NativeError().stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    name: 'constructor alias chain stack',
    source:
      'const NativeError = Error; const NextError = NativeError; function frames() { return new NextError().stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    name: 'callable native constructor alias',
    source:
      'const NativeError = TypeError; function frames() { return NativeError("ours").stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    name: 'conditional plain data',
    source: 'function frames(flag: boolean) { return (flag ? {stack:"a"} : {stack:"b"}).stack; }',
    invocation: 'frames(true)',
    refused: false,
  },
  {
    name: 'conditional constructed own words',
    source:
      'function frames(flag: boolean) { return (flag ? new Error("a") : new TypeError("b")).message; }',
    invocation: 'frames(true)',
    refused: false,
  },
  {
    name: 'asserted conditional own words',
    source:
      'function frames(flag: boolean) { return ((flag ? new Error("a") : new TypeError("b")) as Error).message; }',
    invocation: 'frames(true)',
    refused: false,
  },
  {
    name: 'unreachable conditional error',
    source: 'function frames() { return (false ? new Error() : {stack:"data"}).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'Object plain data',
    source: 'function frames() { return Object({stack:"data"}).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'Object constructed own words',
    source: 'function frames() { return Object(new Error("ours")).message; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'asserted Object own words',
    source: 'function frames() { return (Object(new Error("ours")) as Error).message; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'lexically shadowed Object',
    source:
      'const Object = (_value: unknown) => ({stack:"data"}); function frames(error: Error) { return Object(error).stack; }',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    name: 'Object primitive value',
    source: 'function frames() { return Object("data").stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'plain reaching write',
    source:
      'function frames() { let value: {stack?: string} = {}; value = {stack:"data"}; return value.stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'write in other lexical binding',
    source:
      'function frames() { let value: {stack?: string} = {}; { let value: {stack?: string} = {}; value = new Error(); } return value.stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'unreachable later error write',
    source:
      'function frames() { let value: {stack?: string} = {}; return value.stack; value = new Error(); }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'known false error write',
    source:
      'function frames() { let value: {stack?: string} = {}; if (false) value = new Error(); return value.stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'known true alternate error write',
    source:
      'function frames() { let value: {stack?: string} = {}; if (true) value = {stack:"data"}; else value = new Error(); return value.stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'assigned constructed own words',
    source:
      'function frames() { let value: {message?: string} = {}; value = new Error("ours"); return value.message; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'native alias constructed words',
    source:
      'const NativeError = Error; function frames() { return new NativeError("ours").message; }',
    invocation: 'frames()',
    refused: false,
    compilerRefused: true,
  },
  {
    name: 'local data constructor alias',
    source:
      'const NativeError = class { stack = "data"; }; function frames() { return new NativeError().stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'shadowed Error constructor alias',
    source:
      'class Error { stack = "data"; } const NativeError = Error; function frames() { return new NativeError().stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    name: 'mutable data constructor alias',
    source:
      'let NativeError: new () => {stack?: string} = Error; NativeError = class { stack = "data"; }; function frames() { return new NativeError().stack; }',
    invocation: 'frames()',
    refused: false,
    compilerRefused: true,
  },
] as const;
