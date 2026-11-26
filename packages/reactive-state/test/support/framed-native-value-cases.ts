/** Native fulfillment and entry-value projections, with ordinary data boundaries. */
export const framedNativeValueCases = [
  {
    id: 'promise-native-stack',
    source: "async function frames(){return(await Promise.resolve(new Error('fixed'))).stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'promise-qualified-nested',
    source:
      "async function frames(){return(await globalThis.Promise.resolve(Promise.resolve(new TypeError('fixed')))).stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'promise-native-call',
    source: "async function frames(){return(await Promise.resolve(Error('fixed'))).stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'promise-constructor-alias',
    source:
      "const Native=Promise;const Failure=RangeError;async function frames(){return(await Native.resolve(new Failure('fixed'))).stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'promise-local-words',
    source: "async function frames(){return(await Promise.resolve(new Error('fixed'))).message;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'promise-plain-data',
    source: "async function frames(){return(await Promise.resolve({stack:'fixed'})).stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'promise-local-shadow',
    source:
      "const Promise={resolve(value:unknown){return {stack:'fixed'};}};async function frames(error:Error){return(await Promise.resolve(error)).stack;}",
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'promise-user-thenable',
    source:
      "async function frames(){const thenable={then(resolve:(value:{stack:string})=>void){resolve({stack:'fixed'});}};return(await Promise.resolve(thenable)).stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'promise-augmented-thenable',
    source:
      "async function frames(){const error=Object.assign(new Error('fixed'),{then(resolve:(value:{stack:string})=>void){resolve({stack:'fixed'});}});return(await Promise.resolve(error)).stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'promise-opaque-error-binding',
    source: 'async function frames(error:Error){return(await Promise.resolve(error)).stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'promise-local-error-shadow',
    source:
      "class Error{then(resolve:(value:{stack:string})=>void){resolve({stack:'fixed'});}}async function frames(){return(await Promise.resolve(new Error())).stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'promise-direct-await-pin',
    source: "async function frames(){return(await new Error('fixed')).stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'entries-supplied-stack',
    source:
      "function frames(error:Error){return Object.fromEntries([['failure',error]]).failure.stack;}",
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'entries-supplied-message',
    source:
      "function frames(error:Error){return Object.fromEntries([['failure',error]]).failure.message;}",
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'entries-created-stack',
    source:
      "function frames(){return Object.fromEntries([['failure',new Error('fixed')]]).failure.stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'entries-created-message',
    source:
      "function frames(){return Object.fromEntries([['failure',new Error('fixed')]]).failure.message;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'entries-later-data',
    source:
      "function frames(error:Error){return Object.fromEntries([['failure',error],['failure',{stack:'fixed'}]]).failure.stack;}",
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'entries-later-error',
    source:
      "function frames(error:Error){return Object.fromEntries([['failure',{stack:'fixed'}],['failure',error]]).failure.stack;}",
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'entries-literal-spread',
    source:
      "function frames(error:Error){return Object.fromEntries([...([['other','fixed']] as const),...([['failure',error]] as const)]).failure.stack;}",
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'entries-spread-overwrite',
    source:
      "function frames(error:Error){return Object.fromEntries([['failure',error],...([['failure',{stack:'fixed'}]] as const)]).failure.stack;}",
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'entries-resolved-key',
    source:
      "function frames(error:Error){const key='failure';return Object.fromEntries([[key,error]]).failure.stack;}",
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'entries-conditional-key',
    source:
      "function frames(error:Error,flag:boolean){return Object.fromEntries([[flag?'failure':'other',error]]).failure.stack;}",
    invocation: 'frames(new Error(),true)',
    refused: true,
  },
  {
    id: 'entries-unselected-key',
    source:
      "function frames(error:Error){const key='other';return Object.fromEntries([[key,error],['failure',{stack:'fixed'}]]).failure.stack;}",
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'entries-local-shadow',
    source:
      "const Object={fromEntries(value:unknown){return {failure:{stack:'fixed'}};}};function frames(error:Error){return Object.fromEntries([['failure',error]]).failure.stack;}",
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'entries-const-tuples',
    source:
      "function frames(error:Error){const row=['failure',error] as const;const entries=[row] as const;return Object.fromEntries(entries).failure.stack;}",
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'entries-nested-value',
    source:
      "function frames(error:Error){return Object.fromEntries([['failure',{inner:error}]]).failure.inner.stack;}",
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'entries-unknown-before',
    source:
      "function frames(error:Error,entries:readonly(readonly[string,{stack?:string}])[]){return Object.fromEntries([...entries,['failure',error]]).failure.stack;}",
    invocation: 'frames(new Error(),[])',
    refused: true,
  },
  {
    id: 'entries-unknown-after',
    source:
      "function frames(error:Error,entries:readonly(readonly[string,{stack?:string}])[]){return Object.fromEntries([['failure',error],...entries]).failure.stack;}",
    invocation: 'frames(new Error(),[])',
    refused: true,
  },
  {
    id: 'entries-unknown-overwritten',
    source:
      "function frames(error:Error,entries:readonly(readonly[string,{stack?:string}])[]){return Object.fromEntries([['failure',error],...entries,['failure',{stack:'fixed'}]]).failure.stack;}",
    invocation: 'frames(new Error(),[])',
    refused: false,
  },
  {
    id: 'entries-packed-tuple-overwritten',
    source:
      "function frames(error:Error){const row=['failure',error] as const;const entries=[row] as const;(row as unknown as [string,{stack:string}])[1]={stack:'fixed'};return Object.fromEntries(entries).failure.stack;}",
    invocation: 'frames(new Error())',
    // The written tuple is exposed, so its entries are unread and no type keeps an Error out: an
    // overwrite with an Error reads alike, which main read as readable through that hole.
    refused: true,
  },
  {
    id: 'entries-packed-tuple-overwritten-typed',
    source:
      "function frames(error:Error){const row=['failure',error] as const;const entries=[row] as const;(row as unknown as [string,{stack:string;title:string}])[1]={stack:'fixed',title:'t'};return Object.fromEntries<{stack:string;title:string}>(entries as never).failure.stack;}",
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'entries-packed-tuple-data',
    source:
      "function frames(){const row=['failure',{stack:'fixed'}] as const;const entries=[row] as const;return Object.fromEntries(entries).failure.stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'entries-packed-tuple-local-words',
    source:
      "function frames(){const row=['failure',new Error('fixed')] as const;const entries=[row] as const;return Object.fromEntries(entries).failure.message;}",
    invocation: 'frames()',
    refused: false,
  },
] as const;
