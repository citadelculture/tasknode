import { PROFILE_NFT_IMAGE_MODEL } from "../shared/profile-nft-art.js";

const OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";

function safeText(value = "", max = 10000) {
  return String(value || "").trim().slice(0, max);
}

export async function renderProfileNftImage({ prompt, model = PROFILE_NFT_IMAGE_MODEL, size, quality, outputFormat, env = process.env, fetchImpl = fetch, signal } = {}) {
  const apiKey = safeText(env.PROFILE_NFT_OPENAI_API_KEY, 10000);
  if (!apiKey) throw Object.assign(new Error("profile_nft_openai_not_configured"), { status: 503 });
  const sanitizedPrompt = safeText(prompt, 8000);
  if (!sanitizedPrompt) throw Object.assign(new Error("profile_nft_sanitized_prompt_required"), { status: 400 });
  let baseUrl = safeText(env.PROFILE_NFT_OPENAI_BASE_URL || OPENAI_IMAGE_BASE_URL, 500);
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(30_000, Number(env.PROFILE_NFT_IMAGE_TIMEOUT_MS || 300_000)));
  try {
    const response = await fetchImpl(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      body: JSON.stringify({ model, prompt: sanitizedPrompt, size, quality, output_format: outputFormat, n: 1 }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error("profile_nft_openai_http_error"), { status: response.status });
    return body;
  } finally {
    clearTimeout(timeout);
  }
}
