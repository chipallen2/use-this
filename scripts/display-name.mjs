// scripts/display-name.mjs -- shared short display-name map (OpenRouter ID -> [line1, line2]).
// Single source of truth: render.mjs imports this for HTML output, tests import
// it for expected-value computation. One map, zero drift.
// Versioned entries MUST list the newest version FIRST (regexes match top-down:
// "opus 5.5" before "opus 5") - same longest-first discipline as the scrape aliases.
// Unknown/unmatched ids fall through to the generic versioned splitter at the end.
export function displayName(id) {
  const slug = id.split("/").pop();
  // Synthetic unmatched entries carry the raw AA name in slug form
  // ("unmatched:claude-opus-6"): display the real name, tagged NEW.
  if (slug.startsWith("unmatched:")) {
    const raw = slug.slice("unmatched:".length).replace(/-/g, " ");
    const titled = raw.replace(/\b\w/g, (c) => c.toUpperCase());
    return [titled, "NEW"];
  }
  const map = [
    [/^gpt-6-1-sol-pro$/, ["GPT-6.1", "Sol Pro"]],
    [/^gpt-6-1-sol$/, ["GPT-6.1", "Sol"]],
    [/^gpt-6-luna-pro$/, ["GPT-6", "Luna Pro"]],
    [/^gpt-6-luna$/, ["GPT-6", "Luna"]],
    [/^gpt-6-astra$/, ["GPT-6", "Astra"]],
    [/^gpt-6-sol$/, ["GPT-6", "Sol"]],
    [/^gpt-5\.6-sol-pro$/, ["GPT-5.6", "Sol Pro"]],
    [/^gpt-5\.6-luna-pro$/, ["GPT-5.6", "Luna Pro"]],
    [/^gpt-5\.6-luna$/, ["GPT-5.6", "Luna"]],
    [/^gpt-5\.6-terra$/, ["GPT-5.6", "Terra"]],
    [/^gpt-5\.5-pro$/, ["GPT-5.5", "Pro"]],
    [/^gpt-5\.5$/, ["GPT-5.5", ""]],
    [/^gpt-5\.3-codex$/, ["GPT-5.3", "Codex"]],
    [/^gpt-oss-120b$/, ["GPT-OSS", "120B"]],
    [/^gpt-oss-20b$/, ["GPT-OSS", "20B"]],
    [/^claude-opus-5\.5.*$/, ["Claude", "Opus 5.5"]],
    [/^claude-opus-5.*$/, ["Claude", "Opus 5"]],
    [/^claude-sonnet-5\.5.*$/, ["Claude", "Sonnet 5.5"]],
    [/^claude-sonnet-5.*$/, ["Claude", "Sonnet 5"]],
    [/^claude-haiku-5\.5.*$/, ["Claude", "Haiku 5.5"]],
    [/^claude-fable-5\.1.*$/, ["Claude", "Fable 5.1"]],
    [/^claude-fable-5.*$/, ["Claude", "Fable 5"]],
    [/^muse-wonder.*$/, ["Muse", "Wonder"]],
    [/^muse-glimmer.*$/, ["Muse", "Glimmer"]],
    [/^gemini-4-argon.*$/, ["Gemini 4", "Argon"]],
    [/^gemini-3\.8-flash$/, ["Gemini 3.8", "Flash"]],
    [/^gemini-3\.7-flash$/, ["Gemini 3.7", "Flash"]],
    [/^gemini-3\.6-flash$/, ["Gemini 3.6", "Flash"]],
    [/^gemini-3\.5-flash$/, ["Gemini 3.5", "Flash"]],
    [/^gemini-3-flash-preview$/, ["Gemini 3", "Flash Preview"]],
    [/^gemini-3\.5-flash-lite$/, ["Gemini 3.5", "Flash-Lite"]],
    [/^claude-opus-4\.8.*$/, ["Claude", "Opus 4.8"]],
    [/^claude-opus-4\.6.*$/, ["Claude", "Opus 4.6"]],
    [/^claude-sonnet-4\.6.*$/, ["Claude", "Sonnet 4.6"]],
    [/^claude-sonnet-4.*$/, ["Claude", "Sonnet 4"]],
    [/^grok-4\.3$/, ["Grok 4.3", ""]],
    [/^glm-5\.2.*$/, ["GLM", "5.2"]],
    [/^glm-5\.1.*$/, ["GLM", "5.1"]],
    [/^glm-5v-turbo.*$/, ["GLM", "5V Turbo"]],
    [/^gpt-5\.4.*$/, ["GPT-5.4", ""]],
    [/^gpt-5\.2-codex.*$/, ["GPT-5.2", "Codex"]],
    [/^gpt-5\.2.*$/, ["GPT-5.2", ""]],
    [/^gpt-5\.1-codex.*$/, ["GPT-5.1", "Codex"]],
    [/^deepseek-v4-flash.*$/, ["DeepSeek V4", "Flash"]],
    [/^inkling.*$/, ["Inkling", ""]],
    [/^ling-3\.1-flash$/, ["Ling 3.1", "Flash"]],
    [/^kimi-k2\.5.*$/, ["Kimi K2.5", ""]],
    [/^qwen3-coder-next$/, ["Qwen3", "Coder Next"]],
    [/^mimo-v2\.6-pro-ultraspeed$/, ["MiMo V2.6", "Pro Ultraspeed"]],
    [/^mimo-v2\.6.*$/, ["MiMo V2.6", "Pro"]],
    [/^gemini-3\.1-pro.*$/, ["Gemini 3.1", "Pro"]],
    [/^muse-spark-1\.3-contributor$/, ["Muse Spark 1.3", "Contributor"]],
    [/^muse-spark-1\.3.*$/, ["Muse Spark 1.3", ""]],
    [/^muse-spark.*$/, ["Muse", "Spark"]],
    [/^glm-5\.3-flash.*$/, ["GLM-5.3", "Flash"]],
    [/^glm-5\.3$/, ["GLM-5.3", ""]],
    [/^grok-4\.7$/, ["Grok 4.7", ""]],
    [/^grok-4\.6$/, ["Grok 4.6", ""]],
    [/^kimi-k3$/, ["Kimi K3", ""]],
    [/^kimi-k2.*$/, ["Kimi", "K2"]],
    [/^qwen3\.8.*$/, ["Qwen3.8", ""]],
    [/^qwen3\.7.*$/, ["Qwen3.7", ""]],
    [/^qwen3\.6.*$/, ["Qwen3.6", ""]],
    [/^qwen3\.5.*$/, ["Qwen3.5", ""]],
    [/^mimo.*$/, ["MiMo", ""]],
    [/^minimax-m3$/, ["MiniMax M3", ""]],
    [/^step-5.*$/, ["Step 5", ""]],
    [/^solar-mini.*$/, ["Solar", "Mini"]],
    [/^solar-pro.*$/, ["Solar", "Pro"]],
    [/^deepseek-v4.*$/, ["DeepSeek", "V4"]],
    [/^(\w+)-(\d[\d.]*)-(.*)$/, null], // generic versioned fallback, handled below
  ];
  for (const [re, parts] of map) {
    if (parts == null) { // generic versioned fallback: family-VERSION-rest
      const m = slug.match(re);
      if (m) return [m[1].toUpperCase() + " " + m[2], m[3].replace(/-/g, " ")];
      continue;
    }
    if (re.test(slug)) return parts;
  }
  const bits = slug.split("-");
  return [bits.slice(0, 2).join(" ").toUpperCase(), bits.slice(2).join(" ")];
}

// Full rendered display name (what appears in card headers + table cells).
export function fullDisplayName(id) {
  const [n1, n2] = displayName(id);
  return n1 + (n2 ? " " + n2 : "");
}

export const effortLabel = (e) => (e ? `${e} thinking` : "default");
