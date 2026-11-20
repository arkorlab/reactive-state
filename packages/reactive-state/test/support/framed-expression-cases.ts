/** The fixed comma, native Object identity and awaited native-error regression inputs. */
export const framedExpressionCases = [
  {
    id: 'comma-native-error-stack',
    kind: 'intended-refusal',
    source: 'function frames() { return (0, new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'comma-supplied-error-stack',
    kind: 'intended-refusal',
    source: 'function frames(error: Error) { return (0, error).stack; }',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'comma-right-data',
    kind: 'safe-control',
    source: 'function frames() { return (new Error("ours"), {stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'comma-local-error-words',
    kind: 'safe-control',
    source: 'function frames() { return (0, new Error("ours")).message; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'comma-shadow-error-data',
    kind: 'safe-control',
    source: 'class Error { stack="fixed"; } function frames() { return (0, new Error()).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'freeze-native-error-stack',
    kind: 'intended-refusal',
    source: 'function frames() { return Object.freeze(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'seal-native-error-stack',
    kind: 'intended-refusal',
    source: 'function frames() { return Object.seal(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'prevent-extensions-native-error-stack',
    kind: 'intended-refusal',
    source: 'function frames() { return Object.preventExtensions(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'assign-target-only-error-stack',
    kind: 'intended-refusal',
    source: 'function frames() { return Object.assign(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'freeze-ordinary-data',
    kind: 'safe-control',
    source: 'function frames() { return Object.freeze({stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'seal-ordinary-data',
    kind: 'safe-control',
    source: 'function frames() { return Object.seal({stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'prevent-extensions-ordinary-data',
    kind: 'safe-control',
    source: 'function frames() { return Object.preventExtensions({stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assign-target-only-ordinary-data',
    kind: 'safe-control',
    source: 'function frames() { return Object.assign({stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'freeze-local-shadow-data',
    kind: 'safe-control',
    source:
      'const Object={freeze(_value:unknown){return {stack:"fixed"};}}; function frames() { return Object.freeze(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'seal-local-shadow-data',
    kind: 'safe-control',
    source:
      'const Object={seal(_value:unknown){return {stack:"fixed"};}}; function frames() { return Object.seal(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'prevent-extensions-local-shadow-data',
    kind: 'safe-control',
    source:
      'const Object={preventExtensions(_value:unknown){return {stack:"fixed"};}}; function frames() { return Object.preventExtensions(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'assign-local-shadow-data',
    kind: 'safe-control',
    source:
      'const Object={assign(_value:unknown){return {stack:"fixed"};}}; function frames() { return Object.assign(new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'await-native-error-stack',
    kind: 'intended-refusal',
    source: 'async function frames() { return (await new Error("ours")).stack; }',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'await-ordinary-data',
    kind: 'safe-control',
    source: 'async function frames() { return (await {stack:"fixed"}).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'await-shadow-error-data',
    kind: 'safe-control',
    source:
      'class Error { stack="fixed"; } async function frames() { return (await new Error()).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'await-error-thenable-resolves-data',
    kind: 'safe-control',
    source:
      'async function frames() { const value=Object.assign(new Error("ours"), {then(resolve:(data:{stack:string})=>void) { resolve({stack:"fixed"}); }}); return (await value).stack; }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'await-typed-error-thenable-resolves-data',
    kind: 'safe-control',
    source:
      'async function frames(error:Error & PromiseLike<{stack:string}>) { return (await error).stack; }',
    invocation:
      'frames(Object.assign(new Error("ours"),{then(resolve:(data:{stack:string})=>void){resolve({stack:"fixed"});}}))',
    refused: false,
  },
] as const;
