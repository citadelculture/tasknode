import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILE_NFT_IMAGE_MODEL } from "../shared/profile-nft-art.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

export const profileNftImagePromptPath = path.join(rootDir, "prompts", "profile", "profile_nft_image_v1.md");
export const privateProfileNftPromptPath = path.join(rootDir, "private_prompts", "profile_nft_image.md");
export const placeholderProfileNftPromptPath = path.join(
  rootDir,
  "prompts",
  "non_production",
  "profile_nft_dev",
  "profile_nft_image.placeholder.md"
);

const nftUserDataPlaceholder = "___NFT_USER_DATA_REPLACED_HERE___";
const contextDocumentPlaceholder = "___USER_CONTEXT_DOCUMENT_CONTENT_REPLACED_HERE___";
const bootStringPlaceholder = "< insert Random String>";

function readSecretPrompt(env = process.env) {
  const direct = String(env.PROFILE_NFT_PROMPT_TEXT || "").trim();
  if (direct) {
    return {
      text: direct,
      source: "env_secret",
      sourcePath: "PROFILE_NFT_PROMPT_TEXT",
    };
  }

  const encoded = String(env.PROFILE_NFT_PROMPT_B64 || "").trim();
  if (!encoded) return null;
  return {
    text: Buffer.from(encoded, "base64").toString("utf8").trim(),
    source: "env_secret",
    sourcePath: "PROFILE_NFT_PROMPT_B64",
  };
}

function readPromptFile(env = process.env) {
  if (env.PROFILE_NFT_PROMPT_PATH) {
    const configuredPath = path.resolve(env.PROFILE_NFT_PROMPT_PATH);
    return {
      text: readFileSync(configuredPath, "utf8").trim(),
      source: configuredPath === profileNftImagePromptPath ? "tracked" : "configured",
      sourcePath: configuredPath,
    };
  }

  const secretPrompt = readSecretPrompt(env);
  if (secretPrompt?.text) return secretPrompt;

  const sourcePath = existsSync(profileNftImagePromptPath)
    ? profileNftImagePromptPath
    : existsSync(privateProfileNftPromptPath)
      ? privateProfileNftPromptPath
      : placeholderProfileNftPromptPath;
  return {
    text: readFileSync(sourcePath, "utf8").trim(),
    source:
      sourcePath === profileNftImagePromptPath
        ? "tracked"
        : sourcePath === placeholderProfileNftPromptPath
          ? "placeholder"
          : "legacy_private",
    sourcePath,
  };
}

export function parsePromptDocument(rawText = "") {
  const text = String(rawText || "").trim();
  if (!text.startsWith("---")) {
    return { metadata: {}, prompt: text };
  }

  const closing = text.indexOf("\n---", 3);
  if (closing === -1) return { metadata: {}, prompt: text };

  const frontmatter = text.slice(3, closing).trim();
  const prompt = text.slice(closing + 4).trim();
  const metadata = {};

  for (const line of frontmatter.split("\n").map((line) => line.trimEnd())) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) metadata[key] = value;
  }

  return { metadata, prompt };
}

export function normalizeOpenAiImageModel(model = "") {
  const raw = String(model || "").trim();
  if (!raw) return PROFILE_NFT_IMAGE_MODEL;
  return raw.startsWith("openai/") ? raw.slice("openai/".length) : raw;
}

export function profileNftPromptDigest(prompt = "") {
  return createHash("sha256").update(String(prompt || ""), "utf8").digest("hex");
}

export function loadProfileNftPrompt(env = process.env) {
  const promptFile = readPromptFile(env);
  const parsed = parsePromptDocument(promptFile.text);
  const model = normalizeOpenAiImageModel(parsed.metadata.model || PROFILE_NFT_IMAGE_MODEL);
  return {
    ...promptFile,
    metadata: {
      ...parsed.metadata,
      model,
    },
    promptTemplate: parsed.prompt,
    digest: profileNftPromptDigest(parsed.prompt),
  };
}

export function renderProfileNftPrompt({
  nftUserData = "",
  contextDocument = "",
  bootString = "",
  env = process.env,
} = {}) {
  const loaded = loadProfileNftPrompt(env);
  const randomString = bootString || randomBytes(16).toString("hex");
  const prompt = loaded.promptTemplate
    .replaceAll(nftUserDataPlaceholder, String(nftUserData || "").trim() || "No profile execution data supplied.")
    .replaceAll(contextDocumentPlaceholder, String(contextDocument || "").trim() || "No context document supplied.")
    .replaceAll(bootStringPlaceholder, randomString)
    .trim();

  return {
    metadata: loaded.metadata,
    prompt,
    promptDigest: profileNftPromptDigest(prompt),
    templateDigest: loaded.digest,
    source: loaded.source,
    sourcePath: loaded.sourcePath,
    unresolvedPlaceholders: [
      nftUserDataPlaceholder,
      contextDocumentPlaceholder,
      bootStringPlaceholder,
    ].filter((placeholder) => prompt.includes(placeholder)),
  };
}
