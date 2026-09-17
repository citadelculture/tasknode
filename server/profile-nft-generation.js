import { transactionCommand, databaseEnabled, query } from "./db/pool.js";
import { PROFILE_NFT_ART_VERSION, PROFILE_NFT_IMAGE_MODEL, PROFILE_NFT_TITLE } from "../shared/profile-nft-art.js";
import { markDailyProfileNftAwardGenerated } from "./repositories/profile-nft-daily-awards.js";
import { enqueueProfileNftRenderJob } from "./repositories/profile-nft-render-jobs.js";
import { createGeneratingProfileNft, getProfileNft } from "./repositories/profile-nfts.js";
import { classifyProfileNftGenerationFailure, publicProfileNftGenerationMessage } from "./profile-nft-failures.js";

export { classifyProfileNftGenerationFailure } from "./profile-nft-failures.js";
const safeText = (value, max) => String(value || "").trim().slice(0, max);

export async function profileNftGenerateStart({ method, payload = {}, session = null, state = null, env = process.env, awardId = "" } = {}) {
  if (method !== "POST") return { status: 405, body: { ok: false, error: "profile_nft_method_not_allowed", message: "Profile NFT generation requires POST." } };
  if (!session?.accountId) return { status: 401, body: { ok: false, error: "profile_nft_login_required", message: "Sign in before generating a profile NFT." } };
  if (!databaseEnabled()) return { status: 503, body: { ok: false, error: "profile_nft_render_queue_database_required", message: "Profile artwork generation is temporarily unavailable." } };
  const size = safeText(payload.size || env.PROFILE_NFT_IMAGE_SIZE || "1024x1024", 32);
  const quality = safeText(payload.quality || env.PROFILE_NFT_IMAGE_QUALITY || "high", 32);
  const outputFormat = safeText(payload.outputFormat || env.PROFILE_NFT_IMAGE_OUTPUT_FORMAT || "png", 32);
  if (size !== "1024x1024" || !["low", "medium", "high", "auto"].includes(quality) || !["png", "jpeg", "webp"].includes(outputFormat)) return { status: 400, body: { ok: false, error: "profile_nft_image_options_invalid", message: "Choose square profile artwork with a supported image quality and format." } };
  try {
    const result = await transactionCommand(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`profile_nft:${session.accountId}`]);
      if (awardId) {
        const ownedAward = await client.query("SELECT id FROM profile_nft_daily_awards WHERE id=$1 AND account_id=$2 AND status='running' FOR UPDATE", [awardId,session.accountId]);
        if (!ownedAward.rowCount) throw new Error("profile_nft_daily_award_not_owned");
      }
      const receipt = async (nft, reused) => {
        if (awardId) await markDailyProfileNftAwardGenerated({ awardId, profileNftId: nft.id });
        return { nft, reused };
      };
      const active = await query(`SELECT nft.id FROM profile_nfts nft JOIN profile_nft_render_jobs job ON job.profile_nft_id=nft.id
        WHERE nft.account_id=$1 AND job.status IN ('queued','rendering') ORDER BY job.created_at LIMIT 1`, [session.accountId]);
      if (active.rows[0]) return receipt(await getProfileNft({ accountId: session.accountId, nftId: active.rows[0].id }), true);
      const nft = await createGeneratingProfileNft({
        accountId: session.accountId,
        walletAddress: safeText(state?.wallet?.pftWallet?.address || state?.session?.walletLink?.address, 120),
        title: PROFILE_NFT_TITLE, description: "An original ink profile picture inspired by completed work. The art guide and anonymous art traits are public; task history stays private.",
        promptSource: PROFILE_NFT_ART_VERSION, model: PROFILE_NFT_IMAGE_MODEL, size, quality, outputFormat,
      });
      // Ignore client history, context documents, identity and claimed scores.
      // The worker reads account-owned canonical task evidence after claiming.
      await enqueueProfileNftRenderJob({ profileNftId: nft.id, stylePreference: safeText(payload.style || payload.note, 1200), model: nft.model, size, quality, outputFormat });
      return receipt(nft, false);
    });
    return { status: 202, body: { ok: true, action: "profile_nft_render_queued", ...result, model: result.nft.model, size: result.nft.size, quality: result.nft.quality, outputFormat: result.nft.outputFormat, promptSource: PROFILE_NFT_ART_VERSION } };
  } catch (error) {
    return { status: 503, body: { ok: false, error: "profile_nft_generation_failed", message: publicProfileNftGenerationMessage(error), failure: classifyProfileNftGenerationFailure(error) } };
  }
}
