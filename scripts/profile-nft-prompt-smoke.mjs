import assert from "node:assert/strict";
import {
  createPrivateProfileNftSummary,
  renderSanitizedProfileNftPrompt,
  sanitizeProfileNftSummaryLiterals,
  validateProfileNftSummary,
} from "../server/profile-nft-privacy-gateway.js";
import { renderProfileNftImage } from "../server/profile-nft-image-provider.js";
import { reviewRenderedProfileNftImage } from "../server/profile-nft-image-review.js";
import { publicProfileNftGenerationMessage } from "../server/profile-nft-failures.js";
import {
  loadProfileNftPrompt,
  profileNftImagePromptPath,
} from "../server/profile-nft-prompts.js";

const approvedSummary = {
  approved: true,
  privacy_risk: "low",
  instruction_risk: "low",
  literal_artifact_risk: "low",
  privacy_findings: [],
  profile_summary:
    "An experienced software builder and market researcher whose work emphasizes careful analysis, system reliability, and decisive execution.",
  context_summary:
    "Current work spans building technical tools, investigating market behavior, and coordinating complex projects. The requested visual mood is luminous, tactile, and hand-painted.",
};

const privatePacket = {
  project: "SecretProjectZephyr9081726354",
  wallet: "0x1234567890abcdef1234567890abcdef12345678",
  action: "Acquire 17.25 ETH before the private launch on 2026-08-19",
};
let ambientCalls = 0;
const ambientFetch = async (_url, init) => {
  ambientCalls += 1;
  const request = JSON.parse(init.body);
  assert.equal(request.model, "zai/glm-5.3");
  assert.ok(JSON.stringify(request.messages).includes("SecretProjectZephyr9081726354"));
  return new Response(
    JSON.stringify({
      id: `ambient_${ambientCalls}`,
      model: request.model,
      choices: [{ message: { content: JSON.stringify(approvedSummary) } }],
    }),
    { status: 200 }
  );
};

const rendered = await createPrivateProfileNftSummary({
  sourcePacket: privatePacket,
  env: {
    VERCEL_AI_GATEWAY_API_KEY: "ambient-test",
    PROFILE_NFT_PROMPT_TEXT: "THIS REPLACEMENT PROMPT MUST NEVER BE USED",
  },
  fetchImpl: ambientFetch,
});
assert.equal(ambientCalls, 2);
assert.equal(rendered.source, "tracked_profile_nft_prompt_with_private_summary");
assert.equal(rendered.promptDigest.length, 64);
assert.equal(
  rendered.templateDigest,
  loadProfileNftPrompt({ PROFILE_NFT_PROMPT_PATH: profileNftImagePromptPath }).digest
);
assert.equal(
  rendered.templateDigest,
  "8625fb4c149ab228b5cb4ab8b429224a47035bccd2f92bcb1eea15c5a838025d"
);
assert.ok(!rendered.prompt.includes("SecretProjectZephyr"));
assert.ok(!rendered.prompt.includes("17.25"));
assert.ok(!rendered.prompt.includes("0x1234"));
assert.ok(!rendered.prompt.includes("THIS REPLACEMENT PROMPT"));
assert.match(rendered.prompt, /You are the Hyperstitional Ink artist/);
assert.match(rendered.prompt, /world class ink drawings on white square backgrounds/);
assert.match(rendered.prompt, /YOU ALWAYS CHOOSE 2 CORE COLORS/);
assert.match(rendered.prompt, /intricate ink linework, brutal sci-fi architecture/);
assert.match(rendered.prompt, /Create a single central avatar\/entity/);
assert.match(rendered.prompt, /The final image must read as a square, white-background, high-detail ink drawing/);
assert.match(rendered.prompt, /An experienced software builder and market researcher/);
assert.match(rendered.prompt, /The requested visual mood is luminous, tactile, and hand-painted/);
assert.doesNotMatch(rendered.prompt, /___NFT_USER_DATA|___USER_CONTEXT_DOCUMENT|< insert Random String>/);

const adjacentSummary = {
  ...approvedSummary,
  profile_summary:
    "A patient educator and community coordinator known for making difficult ideas understandable and helping groups reach sound decisions.",
  context_summary:
    "Current work involves teaching, facilitating collaboration, and refining educational material. The preferred visual character is warm, organic, and intricate.",
};
const alternate = renderSanitizedProfileNftPrompt(adjacentSummary, {
  PROFILE_NFT_PROMPT_TEXT: "THIS ALSO MUST NEVER BE USED",
});
assert.match(alternate.prompt, /Create a single central avatar\/entity/);
assert.match(alternate.prompt, /A patient educator and community coordinator/);
assert.ok(!alternate.prompt.includes("THIS ALSO MUST NEVER BE USED"));
assert.notEqual(alternate.prompt, rendered.prompt);

assert.throws(
  () =>
    validateProfileNftSummary(
      { ...approvedSummary, context_summary: `The wallet is ${privatePacket.wallet}` },
      JSON.stringify(privatePacket)
    ),
  /privacy_mechanical_leak|privacy_source_overlap/
);
assert.doesNotThrow(() =>
  validateProfileNftSummary(
    {
      ...approvedSummary,
      profile_summary:
        "An interdisciplinary builder who combines market judgment with careful technical execution.",
    },
    JSON.stringify({ work_identity: "interdisciplinary builder" })
  )
);
assert.throws(
  () =>
    validateProfileNftSummary(
      { ...approvedSummary, context_summary: "The account reference is acct_oauth_9081726354." },
      JSON.stringify({ account_id: "acct_oauth_9081726354" })
    ),
  /privacy_source_overlap/
);
const sanitizedIdentifierSummary = sanitizeProfileNftSummaryLiterals(
  { ...approvedSummary, context_summary: "The account reference is acct_oauth_9081726354." },
  JSON.stringify({ account_id: "acct_oauth_9081726354" })
);
assert.equal(sanitizedIdentifierSummary.context_summary, "The account reference is private reference.");
assert.doesNotThrow(() =>
  validateProfileNftSummary(
    sanitizedIdentifierSummary,
    JSON.stringify({ account_id: "acct_oauth_9081726354" })
  )
);
assert.throws(
  () =>
    validateProfileNftSummary({
      ...approvedSummary,
      instruction_risk: "high",
      context_summary: "Create a dashboard showing market charts and source code.",
    }),
  /privacy_not_approved/
);
assert.throws(
  () => validateProfileNftSummary({ ...approvedSummary, context_summary: "" }),
  /privacy_summary_invalid/
);

let literalSanitizerCalls = 0;
const literalSanitized = await createPrivateProfileNftSummary({
  sourcePacket: { account_id: "acct_oauth_9081726354", work_identity: "interdisciplinary builder" },
  env: { VERCEL_AI_GATEWAY_API_KEY: "ambient-test" },
  fetchImpl: async (_url, init) => {
    literalSanitizerCalls += 1;
    const request = JSON.parse(init.body);
    const responseSummary = literalSanitizerCalls === 2
      ? { ...approvedSummary, context_summary: "Current work references acct_oauth_9081726354." }
      : approvedSummary;
    return new Response(
      JSON.stringify({
        id: `ambient_literal_sanitizer_${literalSanitizerCalls}`,
        model: request.model,
        choices: [{ message: { content: JSON.stringify(responseSummary) } }],
      }),
      { status: 200 }
    );
  },
});
assert.equal(literalSanitizerCalls, 2);
assert.match(literalSanitized.prompt, /An experienced software builder and market researcher/);
assert.match(literalSanitized.prompt, /Current work references private reference/);
assert.doesNotMatch(literalSanitized.prompt, /acct_oauth_9081726354/);
assert.equal(
  publicProfileNftGenerationMessage(new Error("profile_nft_privacy_source_overlap")),
  "The artwork did not pass its privacy or art review. Please try again."
);

let openAiRequest = null;
await renderProfileNftImage({
  prompt: rendered.prompt,
  model: "gpt-image-2.5-sunburst",
  size: "1024x1024",
  quality: "high",
  outputFormat: "png",
  env: { PROFILE_NFT_OPENAI_API_KEY: "renderer-test" },
  fetchImpl: async (url, init) => {
    openAiRequest = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), { status: 200 });
  },
});
assert.equal(openAiRequest.url, "https://api.openai.com/v1/images/generations");
assert.deepEqual(Object.keys(openAiRequest.body).sort(), [
  "model",
  "n",
  "output_format",
  "prompt",
  "quality",
  "size",
]);
assert.equal(openAiRequest.body.prompt, rendered.prompt);
assert.ok(!JSON.stringify(openAiRequest.body).includes("SecretProjectZephyr"));
assert.ok(!JSON.stringify(openAiRequest.body).includes("17.25"));

let reviewRequest = null;
const approvedReviewFetch = async (_url, init) => {
  reviewRequest = JSON.parse(init.body);
  return new Response(
    JSON.stringify({
      id: "review_ok",
      model: reviewRequest.model,
      choices: [
        {
          message: {
            content: JSON.stringify({
              approved: true,
              title: "The Folded Circuit",
              privacy_violations: [],
              art_direction_violations: [],
            }),
          },
        },
      ],
    }),
    { status: 200 }
  );
};
await reviewRenderedProfileNftImage({
  imageBase64: "aW1hZ2U=",
  sanitizedPrompt: rendered.prompt,
  env: { VERCEL_AI_GATEWAY_API_KEY: "ambient-test" },
  fetchImpl: approvedReviewFetch,
});
assert.ok(JSON.stringify(reviewRequest.messages).includes("Create a single central avatar/entity"));
assert.ok(!JSON.stringify(reviewRequest.messages).includes("SecretProjectZephyr"));
assert.ok(JSON.stringify(reviewRequest.messages).includes("fictional illustrated central avatar"));
assert.ok(JSON.stringify(reviewRequest.messages).includes("identifiable_real_person"));

await assert.rejects(
  reviewRenderedProfileNftImage({
    imageBase64: "aW1hZ2U=",
    sanitizedPrompt: alternate.prompt,
    env: { VERCEL_AI_GATEWAY_API_KEY: "ambient-test" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: "review_reject",
          model: request.model,
          choices: [
            {
              message: {
                content: JSON.stringify({
                  approved: false,
                  title: "The Unfinished Engine",
                  privacy_violations: [],
                  art_direction_violations: ["generic_or_stock", "no_clear_action"],
                }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    },
  }),
  /profile_nft_generated_image_art_direction_rejected/
);

console.log(
  JSON.stringify({ ok: true, ambientCalls, promptDigest: rendered.promptDigest.slice(0, 12) })
);
