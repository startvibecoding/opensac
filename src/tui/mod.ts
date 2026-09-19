// Public surface of src/tui (Ink + React projection of the Go bubbletea TUI).

export { App, type AppProps } from "./app.tsx";
export {
  MarkdownBlock,
  renderMarkdown,
  renderStreamingMarkdown,
} from "./markdown.ts";
export {
  Transcript,
  type TranscriptBlock,
  type TranscriptProps,
} from "./transcript.tsx";
