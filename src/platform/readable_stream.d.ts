// The Node runtime makes `ReadableStream` async-iterable, but the DOM library
// types bundled with tsc do not declare it. Augment the global interface so
// `for await (const chunk of stream)` and `AsyncIterable<Uint8Array>` consumers
// type-check (the runtime already supports it).
interface ReadableStream<R = any> extends AsyncIterable<R> {}
