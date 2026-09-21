// Ported from internal/serve/runtime — the serve-owned front-end-neutral
// background-run submission contract shared by the WebUI, chat-completions
// x_background branch, and external/channel runtimes.
export {
  type BackgroundRequest,
  type BackgroundRunDriver,
  type BackgroundSubmitter,
} from "./background.ts";
export { formatAttachmentSummary } from "./attachments.ts";
