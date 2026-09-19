// Static architecture guards (backlog item #34).
//
// The guards enforce the anti-fragmentation invariants in AGENTS.md: one
// construction path, one execution/lifecycle path, one DB→DAO direction, one
// decision-envelope owner, one input/content path, and a public SDK that never
// imports `src/`. Run with `deno task test:architecture`.

export {
  foreignKeyEnforcementPattern,
  importSpecifiers,
  isSchemaOrDatabaseOwner,
  isTestPath,
  legacyTestAllowlist,
  legacyTestBoundaryViolations,
  legacyTestExemptDirs,
  productionViolations,
  publicSdkInternalImports,
  relativeSlash,
  stringLiterals,
  toSlash,
  type Violation,
  walkSourceFiles,
} from "./guard.ts";
