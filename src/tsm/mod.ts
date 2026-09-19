// Public surface of src/tsm (TypeScript Streaming Markdown).
//
// A 1:1 port of github.com/startvibecoding/GoStreamingMarkdown: a
// zero-dependency CommonMark-compatible Markdown parser plus an ANSI terminal
// renderer, exposed through a streaming facade. Used by the TUI to render
// streaming assistant Markdown.

export { computeIDs, newNode, Node, NodeType } from "./node.ts";
export {
  defaultOption,
  parse,
  type ParseOption,
  streamOption,
} from "./parser.ts";
export {
  autoTheme,
  defaultTheme,
  lightTheme,
  newRenderer,
  render,
  Renderer,
  stripANSI,
  type Theme,
  visualWidth,
  wrapANSI,
} from "./renderer.ts";
export {
  newStream,
  render as gsmRender,
  renderWithStreamOption,
  Stream,
} from "./stream.ts";
