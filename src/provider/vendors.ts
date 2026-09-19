// Ported from internal/provider/vendor_*.go init() ordering.
//
// Go registers every vendor adapter from package-level init() functions, which
// run in filename byte order. This module reproduces that order explicitly so
// that `vendorFromBaseURL` first-match semantics stay identical.

import { registerVendorAgnes } from "./vendor_agnes.ts";
import { registerVendorAmazonBedrock } from "./vendor_amazon_bedrock.ts";
import { registerVendorAmdRadeon } from "./vendor_amd_radeon.ts";
import { registerVendorAnthropic } from "./vendor_anthropic.ts";
import { registerVendorAntLing } from "./vendor_ant_ling.ts";
import { registerVendorBailian } from "./vendor_bailian.ts";
import { registerVendorCerebras } from "./vendor_cerebras.ts";
import { registerVendorCloudflareAiGateway } from "./vendor_cloudflare_ai_gateway.ts";
import { registerVendorCloudflareWorkersAi } from "./vendor_cloudflare_workers_ai.ts";
import { registerVendorCodeok } from "./vendor_codeok.ts";
import { registerVendorCtyunPlan } from "./vendor_ctyun_plan.ts";
import { registerVendorDeepseek } from "./vendor_deepseek.ts";
import { registerVendorFireworks } from "./vendor_fireworks.ts";
import { registerVendorGitee } from "./vendor_gitee.ts";
import { registerVendorGithubCopilot } from "./vendor_github_copilot.ts";
import { registerVendorGoogleGemini } from "./vendor_google_gemini.ts";
import { registerVendorGoogleVertex } from "./vendor_google_vertex.ts";
import { registerVendorGroq } from "./vendor_groq.ts";
import { registerVendorHuawei } from "./vendor_huawei.ts";
import { registerVendorHuaweiPlan } from "./vendor_huawei_plan.ts";
import { registerVendorHuggingface } from "./vendor_huggingface.ts";
import { registerVendorJdPlan } from "./vendor_jd_plan.ts";
import { registerVendorKimi } from "./vendor_kimi.ts";
import { registerVendorLongcat } from "./vendor_longcat.ts";
import { registerVendorMinimax } from "./vendor_minimax.ts";
import { registerVendorMistral } from "./vendor_mistral.ts";
import { registerVendorMoonshotai } from "./vendor_moonshotai.ts";
import { registerVendorMthreadsPlan } from "./vendor_mthreads_plan.ts";
import { registerVendorNvidia } from "./vendor_nvidia.ts";
import { registerVendorOpenai } from "./vendor_openai.ts";
import { registerVendorOpencode } from "./vendor_opencode.ts";
import { registerVendorOpenrouter } from "./vendor_openrouter.ts";
import { registerVendorQianfan } from "./vendor_qianfan.ts";
import { registerVendorTencentHyPlan } from "./vendor_tencent_hy_plan.ts";
import { registerVendorTogether } from "./vendor_together.ts";
import { registerVendorVercelAiGateway } from "./vendor_vercel_ai_gateway.ts";
import { registerVendorVolcengine } from "./vendor_volcengine.ts";
import { registerVendorVolcengineAgentplan } from "./vendor_volcengine_agentplan.ts";
import { registerVendorVolcengineCodingplan } from "./vendor_volcengine_codingplan.ts";
import { registerVendorXai } from "./vendor_xai.ts";
import { registerVendorXiaomi } from "./vendor_xiaomi.ts";
import { registerVendorYescode } from "./vendor_yescode.ts";
import { registerVendorZai } from "./vendor_zai.ts";

let registered = false;

/** Registers every built-in vendor adapter once, in Go init() order. */
export function registerBuiltinVendors(): void {
  if (registered) return;
  registered = true;
  registerVendorAgnes();
  registerVendorAmazonBedrock();
  registerVendorAmdRadeon();
  registerVendorAnthropic();
  registerVendorAntLing();
  registerVendorBailian();
  registerVendorCerebras();
  registerVendorCloudflareAiGateway();
  registerVendorCloudflareWorkersAi();
  registerVendorCodeok();
  registerVendorCtyunPlan();
  registerVendorDeepseek();
  registerVendorFireworks();
  registerVendorGitee();
  registerVendorGithubCopilot();
  registerVendorGoogleGemini();
  registerVendorGoogleVertex();
  registerVendorGroq();
  registerVendorHuawei();
  registerVendorHuaweiPlan();
  registerVendorHuggingface();
  registerVendorJdPlan();
  registerVendorKimi();
  registerVendorLongcat();
  registerVendorMinimax();
  registerVendorMistral();
  registerVendorMoonshotai();
  registerVendorMthreadsPlan();
  registerVendorNvidia();
  registerVendorOpenai();
  registerVendorOpencode();
  registerVendorOpenrouter();
  registerVendorQianfan();
  registerVendorTencentHyPlan();
  registerVendorTogether();
  registerVendorVercelAiGateway();
  registerVendorVolcengine();
  registerVendorVolcengineAgentplan();
  registerVendorVolcengineCodingplan();
  registerVendorXai();
  registerVendorXiaomi();
  registerVendorYescode();
  registerVendorZai();
}

registerBuiltinVendors();
