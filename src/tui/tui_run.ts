// TUI adapter over the front-end-neutral RuntimeRun handle.
import {
  decisionTerminalStatus,
  RuntimeRun,
  type RuntimeRunOptions,
} from "../agentruntime/run_handle.ts";

export const decisionSourceTUI = "tui";
export { decisionTerminalStatus };

export class TuiRun extends RuntimeRun {
  constructor(options: RuntimeRunOptions) {
    super({ ...options, source: decisionSourceTUI });
  }
}
