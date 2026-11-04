# reactive-state

Server-owned React state for Next.js. A component is written in ordinary React and TypeScript, and
its own code says who may read a value and who may change it. A server authority runs that code for
every render and every write; the browser shows a write at once and the authority confirms it; and
every page that shows the value follows it live.

> [!IMPORTANT]
> This repository is being assembled in small, reviewed pull requests. It does not build or run
> yet, and nothing is published to npm.

## License

Licensed under either of the [MIT license](LICENSE-MIT) or the
[Apache License, Version 2.0](LICENSE-APACHE), at your option.
