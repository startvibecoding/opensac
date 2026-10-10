/** Provider/vision family used to tune image limits. */
export type Family =
  | "generic"
  | "openai"
  | "anthropic"
  | "anthropic-bedrock"
  | "gemini"
  | "mistral"
  | "doubao-seed"
  | "qwen"
  | "kimi"
  | "minimax"
  | "glm"
  | "grok"
  | "llama-vision"
  | "gemma-vision"
  | "mimo"
  | "amazon-nova"
  | "deepseek-gateway-vision";

/** Advisory hints about the target provider/model for family inference. */
export interface Hint {
  providerID?: string;
  providerName?: string;
  vendor?: string;
  api?: string;
  baseURL?: string;
  modelID?: string;
}

function normalizeFamilyKey(s: string | undefined): string {
  return (s ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replaceAll(" ", "-")
    .replaceAll(":", "-");
}

function isBedrockProvider(s: string): boolean {
  return s.includes("bedrock") || s.includes("amazonaws.com");
}

function isGatewayProvider(s: string): boolean {
  for (const marker of [
    "volcengine-agentplan",
    "volcengine-codingplan",
    "alibaba",
    "bailian",
    "dashscope",
    "gitee",
    "moark",
    "opencode",
  ]) {
    if (s.includes(marker)) return true;
  }
  return false;
}

/** Infers the vision family for the given provider/model hints. */
export function inferFamily(h: Hint): Family {
  const model = normalizeFamilyKey(h.modelID);
  const providerID = normalizeFamilyKey(h.providerID);
  const providerName = normalizeFamilyKey(h.providerName);
  const vendor = normalizeFamilyKey(h.vendor);
  const api = normalizeFamilyKey(h.api);
  const baseURL = normalizeFamilyKey(h.baseURL);
  const providerText = [providerID, providerName, vendor, baseURL].join(" ");

  if (model !== "") {
    if (model.includes("deepseek-v4") && isGatewayProvider(providerText)) {
      return "deepseek-gateway-vision";
    }
    if (
      model.includes("doubao") ||
      model.includes("seed-2") ||
      model.includes("seed2")
    ) {
      return "doubao-seed";
    }
    if (model.includes("minimax")) return "minimax";
    if (model.includes("qwen")) return "qwen";
    if (model.includes("kimi") || model === "k2p7" || model.includes("k2p7")) {
      return "kimi";
    }
    if (model.includes("glm")) return "glm";
    if (model.includes("mimo")) return "mimo";
    if (
      model.includes("grok") ||
      model.includes("x-ai") ||
      model.includes("xai/")
    ) {
      return "grok";
    }
    if (model.includes("amazon.nova") || model.includes("amazon-nova")) {
      return "amazon-nova";
    }
    if (
      model.includes("llama") &&
      (model.includes("vision") || model.includes("scout"))
    ) {
      return "llama-vision";
    }
    if (model.includes("gemma")) return "gemma-vision";
    if (model.includes("gemini")) return "gemini";
    if (
      model.includes("pixtral") ||
      model.includes("mistral") ||
      model.includes("devstral")
    ) {
      return "mistral";
    }
    if (
      model.includes("claude") ||
      model.includes("anthropic.claude") ||
      model.includes("anthropic/claude")
    ) {
      if (isBedrockProvider(providerText) || model.startsWith("anthropic.")) {
        return "anthropic-bedrock";
      }
      return "anthropic";
    }
    if (
      model.startsWith("gpt-") ||
      model.startsWith("o1") ||
      model.startsWith("o3") ||
      model.startsWith("o4") ||
      model.includes("openai/gpt-")
    ) {
      return "openai";
    }
  }

  if (providerText.includes("xiaomi") || providerText.includes("mimo")) {
    return "mimo";
  }
  if (providerText.includes("minimax")) return "minimax";
  if (providerText.includes("moonshot") || providerText.includes("kimi")) {
    return "kimi";
  }
  if (providerText.includes("zai") || providerText.includes("bigmodel")) {
    return "glm";
  }
  if (providerText.includes("xai") || providerText.includes("x-ai")) {
    return "grok";
  }
  if (isBedrockProvider(providerText)) return "amazon-nova";
  if (
    api.includes("google") ||
    providerText.includes("google-gemini") ||
    providerText.includes("google-vertex")
  ) {
    return "gemini";
  }
  if (providerText.includes("mistral")) return "mistral";
  if (providerText.includes("volcengine")) return "doubao-seed";
  if (
    providerText.includes("alibaba") ||
    providerText.includes("bailian") ||
    providerText.includes("dashscope")
  ) {
    return "qwen";
  }
  if (providerText.includes("anthropic") || api === "anthropic-messages") {
    return "anthropic";
  }
  if (providerName === "openai" || api === "openai-responses") return "openai";
  return "generic";
}
