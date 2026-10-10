# Examples

Public SDK (`sdk/agent`) usage examples. They import only the SDK and the
repository's `bootstrap.ts` facade — never a `src/` path — mirroring how
external programs consume the published package.

| Example               | What it shows                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `custom_provider.ts`  | Implement the public `Provider` interface in-process and run one agent turn (no network needed).               |
| `builtin_provider.ts` | Resolve a built-in provider through `withProviderByName` and stream one real turn (`OPENAI_API_KEY` required). |

Run:

```sh
node --import ./scripts/test/preload.mjs examples/custom_provider.ts
OPENAI_API_KEY=sk-... node --import ./scripts/test/preload.mjs examples/builtin_provider.ts
```
