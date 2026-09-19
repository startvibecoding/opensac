// Public surface of src/messaging (ported from internal/messaging).
//
// Package messaging defines the messaging platform abstraction for serve
// channels. Platform adapters (WeChat iLink, Feishu/Lark) live in their own
// subpackages (`./wechat`, `./feishu`) mirroring the Go layout.

export * from "./platform.ts";
export * from "./progress.ts";
