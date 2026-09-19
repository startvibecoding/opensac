// Scaffold for the Ink + React TUI (migrated from internal/tui).
//
// Framework decision (see docs/proposal/go-to-deno-migration.md): the Go
// bubbletea/lipgloss runtime maps to Ink + React. The full transcript, input,
// and canonical-agent-event wiring land once src/agent and src/agentruntime
// exist; this module only proves the Ink + React toolchain works under Deno.

import React from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";

export interface AppProps {
  /** Banner text rendered in the managed (non-scrollback) view. */
  label: string;
}

/** Minimal Ink root component. */
export function App({ label }: AppProps): ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        {label}
      </Text>
    </Box>
  );
}
