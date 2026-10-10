// Static architecture guards (backlog item #34).
//
// The guards enforce the anti-fragmentation invariants in AGENTS.md: one
// construction path, one execution/lifecycle path, one DB→DAO direction, one
// decision-envelope owner, one input/content path, and a public SDK that never
// imports `src/`, plus the narrow reviewed `src/core` foundation boundary.
// Run with `npm run test:architecture`.

export {
  coreBoundaryAllowlist,
  foreignKeyEnforcementPattern,
  importSpecifiers,
  isCorePath,
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
