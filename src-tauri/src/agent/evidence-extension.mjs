import "./evidence-model.js";
import { createEvidenceRuntime } from "./evidence-runtime.mjs";

// The command and notifications are a private desktop transport, not chat.
export default function desktopEvidence(api) {
  const epoch = process.env.OMP_DESKTOP_CONTEXT_EPOCH;
  const profileId = process.env.OMP_DESKTOP_PROFILE_ID;
  if (
    !epoch ||
    epoch.length > 128 ||
    !/^[a-zA-Z0-9-]+$/.test(epoch) ||
    !profileId ||
    Buffer.byteLength(profileId) > 256
  )
    return;
  const runtime = createEvidenceRuntime(api, { epoch, profileId });
  api.registerCommand(runtime.command, {
    description: "Private desktop Evidence transport",
    handler: runtime.privateCommand,
  });
  const z = api.zod;
  const kinds = [
    "any",
    "image",
    "video",
    "test",
    "runtime",
    "code",
    "ci",
    "build",
    "other",
  ];
  api.registerTool({
    name: "evidence",
    label: "Evidence",
    loadMode: "essential",
    approval: "write",
    description:
      "Inspect the Evidence ledger, propose outcomes or criteria, record scoped evidence or gaps, attach a file, or capture existing CI. Use view with outcomeId, requirementId, recordId, receiptId or requestId to inspect a specific part of a large ledger. A passed claim is your interpretation, never independent acceptance. You cannot edit user-owned criteria, review, waive, change policies or disable collection. Receipts document execution, not meaning.",
    parameters: z.object({
      op: z.enum(["view", "outcome", "requirement", "record", "capture_ci"]),
      outcomeId: z.string().optional(),
      requirementId: z.string().optional(),
      recordId: z.string().optional(),
      receiptId: z.string().optional(),
      requestId: z.string().optional(),
      outcome: z
        .object({
          id: z.string().optional(),
          title: z.string(),
          description: z.string().optional(),
          todoRefs: z.array(z.string()).optional(),
        })
        .optional(),
      requirement: z
        .object({
          id: z.string().optional(),
          text: z.string(),
          kind: z.enum(kinds),
          required: z.boolean(),
        })
        .optional(),
      record: z
        .object({
          title: z.string(),
          kind: z.enum(kinds),
          result: z.enum([
            "observed",
            "passed",
            "failed",
            "blocked",
            "cancelled",
          ]),
          summary: z.string(),
          limitations: z.string().optional(),
          reason: z.string().optional(),
          receiptId: z.string().optional(),
          path: z.string().optional(),
          url: z.string().optional(),
          fileRef: z
            .object({
              path: z.string(),
              from: z.string().optional(),
              to: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const report = await runtime.agentOperation(ctx, params);
      return {
        content: [{ type: "text", text: report }],
        details: { evidence: true },
      };
    },
  });
  for (const event of [
    "session_start",
    "session_switch",
    "session_branch",
    "session_tree",
    "session_compact",
  ])
    api.on(event, (payload, ctx) => runtime.lifecycle(ctx, payload));
  api.on("before_agent_start", (event, ctx) => runtime.guidance(ctx, event));
  api.on("tool_call", (event, ctx) => runtime.toolBefore(event, ctx));
  api.on("tool_execution_start", (event) => runtime.toolStarted(event));
  api.on("tool_result", (event, ctx) => runtime.toolResult(event, ctx));
  api.on("tool_execution_end", async (event, ctx) => {
    await runtime.toolResult(event, ctx);
  });
  api.on("session_stop", (event, ctx) => runtime.stop(event, ctx));
  api.on("session_shutdown", () => runtime.shutdown());
}
