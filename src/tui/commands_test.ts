// Focused tests for the slash-command dispatcher: unknown/unsupported handling,
// mode/model/clear flows, session and expert routing, and help text. The host
// is a recording stub so the dispatcher's routing is verified without a session.

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CommandHost,
  type CommandResult,
  dispatchCommand,
  helpText,
} from "./commands.ts";
import { Translator } from "./i18n.ts";

function host(overrides: Partial<CommandHost> = {}): {
  host: CommandHost;
  calls: string[];
} {
  const calls: string[] = [];
  const base: CommandHost = {
    workDir: "/w",
    translator: new Translator("en"),
    mode: "yolo",
    modelID: "m1",
    providerName: "p1",
    running: false,
    setMode(mode) {
      calls.push(`setMode:${mode}`);
    },
    setModel(id): Promise<CommandResult> {
      calls.push(`setModel:${id}`);
      return Promise.resolve({ message: `model ${id}` });
    },
    clearConversation() {
      calls.push("clearConversation");
    },
    compact(): Promise<CommandResult> {
      calls.push("compact");
      return Promise.resolve({ message: "compacted" });
    },
    listSkills() {
      return Promise.resolve("skills");
    },
    activateSkill(name) {
      calls.push(`activateSkill:${name}`);
      return Promise.resolve(`activated ${name}`);
    },
    listMCPServers() {
      return "mcps";
    },
    initMCPConfig(scope): CommandResult {
      calls.push(`initMCP:${scope}`);
      return { message: `mcp ${scope}` };
    },
    listExperts() {
      return Promise.resolve("experts");
    },
    showExpert(id) {
      calls.push(`showExpert:${id}`);
      return Promise.resolve(`expert ${id}`);
    },
    bindExpert(id): Promise<CommandResult> {
      calls.push(`bindExpert:${id}`);
      return Promise.resolve({ message: `bound ${id}` });
    },
    forkSwitchExpert(id): Promise<CommandResult> {
      calls.push(`forkExpert:${id}`);
      return Promise.resolve({ message: `forked ${id}` });
    },
    listSessions(): Promise<string> {
      return Promise.resolve("sessions");
    },
    forkSession(): Promise<CommandResult> {
      calls.push("forkSession");
      return Promise.resolve({ message: "forked" });
    },
    switchSession(id): Promise<CommandResult> {
      calls.push(`switchSession:${id}`);
      return Promise.resolve({ message: `switched ${id}` });
    },
    clearSession(): Promise<CommandResult> {
      calls.push("clearSession");
      return Promise.resolve({ message: "cleared" });
    },
    deleteSession(id): Promise<CommandResult> {
      calls.push(`deleteSession:${id}`);
      return Promise.resolve({ message: `deleted ${id}` });
    },
    listWorkflows(): Promise<CommandResult> {
      return Promise.resolve({ message: "workflows" });
    },
    showWorkflow(id): Promise<CommandResult> {
      return Promise.resolve({ message: `wf ${id}` });
    },
    cancelWorkflow(id): Promise<CommandResult> {
      calls.push(`cancelWorkflow:${id}`);
      return Promise.resolve({ message: `cancelled ${id}` });
    },
    handleESM(cmd): Promise<CommandResult> {
      calls.push(`esm:${cmd}`);
      return Promise.resolve({ message: "esm" });
    },
    handleBTW(cmd): Promise<CommandResult> {
      calls.push(`btw:${cmd}`);
      return Promise.resolve({ message: "btw" });
    },
    listEnv() {
      return Promise.resolve("env");
    },
    setEnv(k): Promise<CommandResult> {
      calls.push(`setEnv:${k}`);
      return Promise.resolve({ message: k });
    },
    unsetEnv(k): Promise<CommandResult> {
      calls.push(`unsetEnv:${k}`);
      return Promise.resolve({ message: k });
    },
    clearEnv(): Promise<CommandResult> {
      calls.push("clearEnv");
      return Promise.resolve({ message: "cleared" });
    },
    allowEditPath(parts): CommandResult {
      calls.push(`allowEdit:${parts.join(",")}`);
      return { message: "ae" };
    },
    allowAutoEdit(parts): CommandResult {
      calls.push(`allowAuto:${parts.join(",")}`);
      return { message: "aa" };
    },
    delegateMode(arg): Promise<CommandResult> {
      calls.push(`delegate:${arg}`);
      return Promise.resolve({ message: "d" });
    },
    browserMode(arg): Promise<CommandResult> {
      calls.push(`browser:${arg}`);
      return Promise.resolve({ message: "b" });
    },
    statusLine(parts): Promise<CommandResult> {
      calls.push(`statusline:${parts.join(",")}`);
      return Promise.resolve({ message: "s" });
    },
    handleRule(parts): Promise<CommandResult> {
      calls.push(`rule:${parts.join(",")}`);
      return Promise.resolve({ message: "r" });
    },
    handleSkillHub(parts): Promise<CommandResult> {
      calls.push(`skillhub:${parts.join(",")}`);
      return Promise.resolve({ message: "sh" });
    },
    listStats(parts): Promise<CommandResult> {
      calls.push(`stats:${parts.join(",")}`);
      return Promise.resolve({ message: "st" });
    },
    listAgents(): Promise<string> {
      return Promise.resolve("agents");
    },
    switchAgent(id): Promise<CommandResult> {
      calls.push(`switchAgent:${id}`);
      return Promise.resolve({ message: `switched ${id}` });
    },
    destroyAgent(id): Promise<CommandResult> {
      calls.push(`destroyAgent:${id}`);
      return Promise.resolve({ message: `destroyed ${id}` });
    },
    multiAgentEnabled() {
      return true;
    },
    handleReload(): Promise<CommandResult> {
      calls.push("reload");
      return Promise.resolve({ message: "reload", quit: true });
    },
    showProviders() {
      calls.push("showProviders");
      return Promise.resolve("providers");
    },
    setDefaultModel(parts): Promise<CommandResult> {
      calls.push(`setDefaultModel:${parts.join(",")}`);
      return Promise.resolve({ message: "default" });
    },
    tuiLang(parts): Promise<CommandResult> {
      calls.push(`tuiLang:${parts.join(",")}`);
      return Promise.resolve({ message: "lang" });
    },
    cron(parts): CommandResult {
      calls.push(`cron:${parts.join(",")}`);
      return { message: "cron" };
    },
    systemInit(cmd): Promise<CommandResult> {
      calls.push(`systemInit:${cmd}`);
      return Promise.resolve({ message: "init" });
    },
    pasteImage(): Promise<CommandResult> {
      calls.push("pasteImage");
      return Promise.resolve({ message: "pasted" });
    },
    openModelDialog(): Promise<CommandResult> {
      calls.push("openModelDialog");
      return Promise.resolve({});
    },
    openAuthDialog(): Promise<CommandResult> {
      calls.push("openAuthDialog");
      return Promise.resolve({});
    },
    openSettingsDialog(providerID?: string): Promise<CommandResult> {
      calls.push(`openSettingsDialog:${providerID ?? ""}`);
      return Promise.resolve({});
    },
    openEnvDialog(): Promise<CommandResult> {
      calls.push("openEnvDialog");
      return Promise.resolve({});
    },
    openSessionsDialog(): Promise<CommandResult> {
      calls.push("openSessionsDialog");
      return Promise.resolve({});
    },
    openTuiLangDialog(): Promise<CommandResult> {
      calls.push("openTuiLangDialog");
      return Promise.resolve({});
    },
  };
  return { host: { ...base, ...overrides }, calls };
}

Deno.test("unknown command reports an error", async () => {
  const { host: h } = host();
  const result = await dispatchCommand("/nope", h);
  assertEquals(result.error, true);
  assertStringIncludes(result.message ?? "", "/nope");
});

Deno.test("dialog commands open interactive panels", async () => {
  const { host: h, calls } = host();
  await dispatchCommand("/auth", h);
  await dispatchCommand("/settings", h);
  await dispatchCommand("/model", h);
  await dispatchCommand("/env", h);
  await dispatchCommand("/sessions", h);
  await dispatchCommand("/tuilang", h);
  assertEquals(calls, [
    "openAuthDialog",
    "openSettingsDialog:",
    "openModelDialog",
    "openEnvDialog",
    "openSessionsDialog",
    "openTuiLangDialog",
  ]);
});

Deno.test("argument forms keep the non-interactive paths", async () => {
  const { host: h, calls } = host();
  await dispatchCommand("/model gpt", h);
  await dispatchCommand("/env set KEY VALUE", h);
  await dispatchCommand("/sessions ls", h);
  assertEquals(calls, ["setModel:gpt", "setEnv:KEY"]);
});

Deno.test("/quit requests exit", async () => {
  const { host: h } = host();
  assertEquals((await dispatchCommand("/quit", h)).quit, true);
});

Deno.test("/mode validates and mutates", async () => {
  const { host: h, calls } = host();
  const ok = await dispatchCommand("/mode plan", h);
  assertEquals(ok.error, undefined);
  assertEquals(calls, ["setMode:plan"]);
  const bad = await dispatchCommand("/mode bogus", h);
  assertEquals(bad.error, true);
  // Bare /mode reports the current mode.
  const status = await dispatchCommand("/mode", h);
  assertStringIncludes(status.message ?? "", "YOLO");
});

Deno.test("/model delegates to the host", async () => {
  const { host: h, calls } = host();
  await dispatchCommand("/model gpt", h);
  assertEquals(calls, ["setModel:gpt"]);
});

Deno.test("/clear and /compact route to the host", async () => {
  const { host: h, calls } = host();
  await dispatchCommand("/clear", h);
  await dispatchCommand("/compact", h);
  assertEquals(calls, ["clearConversation", "compact"]);
  // /compact is refused while running.
  const busy = host({ running: true });
  const result = await dispatchCommand("/compact", busy.host);
  assertEquals(result.error, true);
});

Deno.test("skill commands activate by name and prefix form", async () => {
  const { host: h, calls } = host();
  await dispatchCommand("/skill myskill", h);
  await dispatchCommand("/skill:other", h);
  assertEquals(calls, ["activateSkill:myskill", "activateSkill:other"]);
});

Deno.test("expert and session subcommands route correctly", async () => {
  const { host: h, calls } = host();
  await dispatchCommand("/expert bind exp1", h);
  await dispatchCommand("/expert switch exp2", h);
  await dispatchCommand("/expert unbind", h);
  await dispatchCommand("/expert show exp3", h);
  await dispatchCommand("/sessions ls", h);
  await dispatchCommand("/sessions del s1", h);
  await dispatchCommand("/sessions new", h);
  await dispatchCommand("/sessions fork", h);
  await dispatchCommand("/sessions branch", h);
  assertEquals(calls, [
    "bindExpert:exp1",
    "forkExpert:exp2",
    "bindExpert:",
    "showExpert:exp3",
    "deleteSession:s1",
    "clearSession",
    "forkSession",
    "forkSession",
  ]);
});

Deno.test("workflows cancel routes to the host", async () => {
  const { host: h, calls } = host();
  const result = await dispatchCommand("/workflows cancel wf1", h);
  assertEquals(calls, ["cancelWorkflow:wf1"]);
  assertEquals(result.message, "cancelled wf1");
});

Deno.test("/settings with a provider deep-links into auth", async () => {
  const { host: h, calls } = host();
  await dispatchCommand("/settings anthropic", h);
  assertEquals(calls, ["openSettingsDialog:anthropic"]);
});

Deno.test("/esm and /btw pass the raw command line through", async () => {
  const { host: h, calls } = host();
  await dispatchCommand("/esm pause", h);
  await dispatchCommand("/btw what is x", h);
  assertEquals(calls, ["esm:/esm pause", "btw:/btw what is x"]);
});

Deno.test("/agent respects multi-agent gating", async () => {
  const { host: h } = host();
  const ok = await dispatchCommand("/agent list", h);
  assertEquals(ok.message, "agents");
  const disabled = host({ multiAgentEnabled: () => false });
  const result = await dispatchCommand("/agent list", disabled.host);
  assertStringIncludes(result.message ?? "", "disabled");
});

Deno.test("/agent switch and destroy route to the host", async () => {
  const { host: h, calls } = host();
  await dispatchCommand("/agent switch sub1", h);
  await dispatchCommand("/agent destroy sub2", h);
  assertEquals(calls, ["switchAgent:sub1", "destroyAgent:sub2"]);
  const bare = await dispatchCommand("/agent switch", h);
  assertEquals(bare.error, true);
});

Deno.test("dialog commands refuse to open while running", async () => {
  const busy = host({ running: true });
  const model = await dispatchCommand("/model", busy.host);
  assertEquals(model.error, true);
  const auth = await dispatchCommand("/auth", busy.host);
  assertEquals(auth.error, true);
  const settings = await dispatchCommand("/settings", busy.host);
  assertEquals(settings.error, true);
  const def = await dispatchCommand("/defaultModel", busy.host);
  assertEquals(def.error, true);
  // Argument forms still work while running.
  const argForm = host({ running: true });
  await dispatchCommand("/model gpt", argForm.host);
  assertEquals(argForm.calls, ["setModel:gpt"]);
});

Deno.test("help text lists commands and shortcuts", () => {
  const text = helpText(new Translator("en"));
  assertStringIncludes(text, "/mode");
  assertStringIncludes(text, "Keyboard shortcuts");
  assertStringIncludes(text, "Ctrl+O");
});
