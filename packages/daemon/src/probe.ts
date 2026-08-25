/**
 * Step 0 auth probe.
 *
 * The entire cost model of aide rests on one assumption: that the Agent SDK,
 * run WITHOUT --bare, inherits the local Claude Code login and therefore draws
 * on the Max subscription rather than billing API rates.
 *
 * This script tests that assumption for a few cents before anything is built
 * on top of it. Run:  pnpm probe
 */
import { query, type SettingSource } from "@anthropic-ai/claude-agent-sdk"

// --isolated  -> load only the target project's .claude/, not the host's ~/.claude
// (default)   -> load everything, exactly like an interactive session
const isolated = process.argv.includes("--isolated")
const settingSources: SettingSource[] | undefined = isolated ? ["project"] : undefined

// If this is set, the SDK uses it INSTEAD of the OAuth login, and a passing
// probe would tell us nothing about the subscription path.
const envKey = process.env.ANTHROPIC_API_KEY
console.log("aide probe")
console.log("  ANTHROPIC_API_KEY in env:", envKey ? "YES  <-- shadows the subscription login" : "no")
console.log("  cwd:", process.cwd())
console.log("  settingSources:", settingSources ? JSON.stringify(settingSources) : "(all - CLI default)")
console.log()

try {
  for await (const message of query({
    prompt: "Reply with exactly the word: ok",
    options: {
      model: "claude-opus-5",
      allowedTools: [],
      permissionMode: "dontAsk",
      cwd: process.cwd(),
      ...(settingSources ? { settingSources } : {}),
    },
  })) {
    const m = message as Record<string, unknown>

    if (message.type === "system" && m["subtype"] === "init") {
      console.log("--- system/init ---")
      console.log("  model   ", m["model"])
      console.log("  plugins ", JSON.stringify(m["plugins"] ?? []))
      console.log("  slash   ", ((m["slash_commands"] as unknown[]) ?? []).length, "commands")
      console.log()
    }

    if (message.type === "assistant") {
      const content = (m["message"] as { content?: Array<Record<string, unknown>> })?.content ?? []
      for (const block of content) {
        if (block["type"] === "text") console.log("text:", String(block["text"]).trim())
      }
    }

    if (message.type === "result") {
      console.log()
      console.log("--- result ---")
      console.log("  subtype        ", m["subtype"])
      console.log("  num_turns      ", m["num_turns"])
      console.log("  duration_ms    ", m["duration_ms"])
      console.log("  total_cost_usd ", m["total_cost_usd"], "(client-side estimate)")
      console.log("  usage          ", JSON.stringify(m["usage"]))
      console.log("  modelUsage     ", JSON.stringify(m["modelUsage"], null, 2))
    }
  }
} catch (err) {
  console.error()
  console.error("PROBE FAILED:", err instanceof Error ? err.message : err)
  console.error()
  console.error("If this says the API key is missing, the subscription assumption is wrong.")
  console.error("Stop and reconsider the cost model before building on it.")
  process.exitCode = 1
}
