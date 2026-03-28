/**
 * OpenClaw memory-recall plugin — auto-injects clawmem search results into agent context.
 *
 * Install: copy to ~/.openclaw/extensions/memory-recall/index.ts
 * Config in openclaw.json:
 *   { "plugins": { "entries": { "memory-recall": { "enabled": true } } } }
 */
import { execSync } from "child_process";

const SKIP = [/^.{0,15}$/, /^(hi|hey|gm|gn|ok|lol|haha|thanks|wow)$/i];

const plugin = {
  id: "memory-recall",
  name: "Memory Recall",
  register(api: any) {
    const clawmemDir = api.getConfig?.()?.clawmemDir || process.env.CLAWMEM_DIR || ".";
    const maxResults = api.getConfig?.()?.maxResults ?? 5;

    api.on("before_prompt_build", (event: any, ctx: any) => {
      try {
        if (ctx.chatType === "direct" || ctx.chatType === "dm") return {};
        const messages = event.messages || [];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "user") return {};

        const text = typeof last.content === "string" ? last.content
          : last.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") || "";
        if (text.length < 20 || SKIP.some(p => p.test(text))) return {};

        const query = text.replace(/https?:\/\/\S+/g, "").replace(/@\w+/g, "").trim().slice(0, 200);
        if (query.length < 15) return {};

        const result = execSync(
          `cd "${clawmemDir}" && node src/cli.js search "${query.replace(/"/g, '\\"')}" --json --limit ${maxResults}`,
          { timeout: 8000, encoding: "utf-8" }
        ).trim();

        const parsed = JSON.parse(result);
        if (!parsed.results?.length) return {};

        const formatted = parsed.results
          .map((r: any) => `- [${r.source}] ${(r.text || "").slice(0, 300)}`)
          .join("\n");

        return {
          prependContext: `[Memory context — related community knowledge. Use naturally if relevant.]\n${formatted}\n[/Memory context]`,
        };
      } catch { return {}; }
    }, { priority: 5 });
  },
};

export default plugin;
