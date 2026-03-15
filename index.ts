import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { governancePluginConfigSchema, resolveGovernancePluginConfig } from "./src/config.js";
import { createGovernanceRuntime } from "./src/runtime.js";

const plugin = {
  id: "governance-dashboard",
  name: "Governance Dashboard",
  description: "Repo governance scanner and Control UI cockpit for OpenClaw",
  configSchema: governancePluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveGovernancePluginConfig(api.pluginConfig);
    const runtime = createGovernanceRuntime({
      config,
      logger: api.logger,
      pluginId: "governance-dashboard",
      pluginVersion: api.version ?? "0.1.1",
      pluginSourcePath: api.source,
    });

    api.registerService(runtime.service);
    api.registerGatewayMethod(
      "governance.snapshot",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const force =
            params && typeof params === "object"
              ? (params as Record<string, unknown>).force === true
              : false;
          const snapshot = await runtime.getSnapshot({ force });
          respond(true, snapshot);
        } catch (err) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  },
};

export default plugin;
