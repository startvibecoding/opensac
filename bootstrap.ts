// Public bootstrap entry (mirrors the Go public `bootstrap` package).
//
// Importing this module performs the SDK wiring that the public `sdk/agent`
// package deliberately does not do itself: it registers the concrete provider
// factories (openai/anthropic/google), the provider resolution hook behind
// `Builder.withProviderByName`, and the internal agent builder behind
// `Builder.build()`.
//
// This file exists so that examples and external programs never have to import
// a `src/` path (see src/architecture/public_sdk_boundary_test.ts): they
// import the public SDK (`sdk/agent`) plus this facade, exactly like Go
// programs imported the public `agent` and `bootstrap` packages.
export * from "./src/bootstrap/mod.ts";
