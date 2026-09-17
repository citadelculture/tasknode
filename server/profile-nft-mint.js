import { pinContextIpfsJson } from "./context-ipfs.js";
import { PROFILE_NFT_IMAGE_MODEL, PROFILE_NFT_TITLE } from "../shared/profile-nft-art.js";
import {
  pftUriToHex,
  preparePftNftMintTransaction,
  submitSignedPftNftMintTransaction,
} from "./pftl-submit.js";
import {
  getProfileNft,
  markProfileNftError,
  markProfileNftMinted,
  markProfileNftMintPrepared,
} from "./repositories/profile-nfts.js";

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function linkedWalletAddressFromState(state = {}) {
  return safeText(state?.wallet?.pftWallet?.address || state?.session?.walletLink?.address || "", 120);
}

export function metadataForNft(nft = {}) {
  return {
    schema: "erc721",
    name: nft.title || PROFILE_NFT_TITLE,
    description:
      nft.description ||
      "Task Node profile artwork. Task history stays private.",
    image: `ipfs://${nft.imageCid}`,
    ...(nft.metadataJson?.art ? { art: nft.metadataJson.art } : {}),
    attributes: [
      ...(nft.metadataJson?.art ? [
        { trait_type: "Collection", value: PROFILE_NFT_TITLE },
        { trait_type: "Creature", value: nft.metadataJson.art.creature },
        { trait_type: "Creature level", value: nft.metadataJson.art.creature_level },
        { trait_type: "Hyperstition", value: nft.metadataJson.art.hyperstition, max_value: 100 },
        { trait_type: "Bread and Circuses", value: nft.metadataJson.art.bread_and_circuses, max_value: 100 },
        { trait_type: "Hostile AGI", value: nft.metadataJson.art.hostile_agi, max_value: 100 },
        { trait_type: "Momentum", value: nft.metadataJson.art.momentum },
        { trait_type: "Colors", value: nft.metadataJson.art.colors.join(" / ") },
      ] : []),
      { trait_type: "Source", value: "Task Node Official" },
      { trait_type: "Model", value: nft.model || PROFILE_NFT_IMAGE_MODEL },
      { trait_type: "Prompt digest", value: nft.promptDigest || "unavailable" },
      { trait_type: "Template digest", value: nft.templateDigest || "unavailable" },
    ],
  };
}

function validateSessionAndWallet({ session = null, state = null, nft = null } = {}) {
  if (!session?.accountId) {
    const error = new Error("profile_nft_login_required");
    error.status = 401;
    throw error;
  }
  const walletAddress = linkedWalletAddressFromState(state);
  if (!walletAddress) {
    const error = new Error("profile_nft_wallet_required");
    error.status = 400;
    throw error;
  }
  if (nft?.walletAddress && nft.walletAddress !== walletAddress) {
    const error = new Error("profile_nft_wallet_mismatch");
    error.status = 400;
    throw error;
  }
  return walletAddress;
}

async function prepareProfileNftMint({ nft, session, state, env }) {
  const walletAddress = validateSessionAndWallet({ session, state, nft });
  if (!nft?.imageCid) {
    const error = new Error("profile_nft_image_missing");
    error.status = 400;
    throw error;
  }

  const metadataJson = metadataForNft(nft);
  const metadataPin = await pinContextIpfsJson({
    payload: metadataJson,
    name: `profile_nft_metadata_${nft.id}`,
    keyvalues: {
      type: "profile_nft_metadata",
      accountId: session.accountId,
      nftId: nft.id,
    },
    env,
  });
  const metadataUri = `ipfs://${metadataPin.cid}`;
  const uriHex = pftUriToHex(metadataUri);
  const prepared = await preparePftNftMintTransaction({
    account: walletAddress,
    uriHex,
    flags: 9,
    taxon: 0,
    transferFee: 0,
    env,
  });
  const updated = await markProfileNftMintPrepared({
    accountId: session.accountId,
    nftId: nft.id,
    metadataCid: metadataPin.cid,
    metadataUri,
    metadataJson,
    mintTxJson: prepared.txJson,
    walletAddress,
  });

  return {
    ok: true,
    phase: "prepared",
    nft: updated,
    txJson: prepared.txJson,
    metadataCid: metadataPin.cid,
    metadataUri,
    uriHex,
    networkId: prepared.networkId,
  };
}

async function submitProfileNftMint({ nft, payload, session, state, env }) {
  const walletAddress = validateSessionAndWallet({ session, state, nft });
  const signedTxBlob = safeText(payload?.signedTxBlob, 100000);
  if (!signedTxBlob) {
    const error = new Error("profile_nft_signed_transaction_required");
    error.status = 400;
    throw error;
  }
  if (!nft?.mintTxJson?.URI) {
    const error = new Error("profile_nft_mint_not_prepared");
    error.status = 400;
    throw error;
  }

  const submitted = await submitSignedPftNftMintTransaction({
    signedTxBlob,
    expectedAccount: walletAddress,
    expectedUriHex: nft.mintTxJson.URI,
    env,
  });
  const updated = await markProfileNftMinted({
    accountId: session.accountId,
    nftId: nft.id,
    txHash: submitted.txHash || "",
    nftTokenId: submitted.nftTokenId || "",
  });

  return {
    ok: true,
    phase: "minted",
    nft: updated,
    txHash: submitted.txHash,
    nftTokenId: submitted.nftTokenId,
    ledgerIndex: submitted.ledgerIndex,
    networkId: submitted.networkId,
  };
}

export async function profileNftMintStart({
  method,
  payload = {},
  session = null,
  state = null,
  env = process.env,
} = {}) {
  if (method !== "POST") {
    return {
      status: 405,
      body: {
        ok: false,
        error: "profile_nft_method_not_allowed",
        message: "Profile NFT minting requires POST.",
      },
    };
  }

  if (!session?.accountId) {
    return {
      status: 401,
      body: {
        ok: false,
        error: "profile_nft_login_required",
        message: "Sign in before minting a profile NFT.",
      },
    };
  }

  const phase = safeText(payload?.phase || "prepare", 40);
  const nftId = safeText(payload?.nftId, 120);
  const nft = await getProfileNft({ accountId: session.accountId, nftId });
  if (!nft) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "profile_nft_not_found",
        message: "Profile NFT record was not found.",
      },
    };
  }

  try {
    const body =
      phase === "submit"
        ? await submitProfileNftMint({ nft, payload, session, state, env })
        : await prepareProfileNftMint({ nft, session, state, env });
    return { status: 200, body };
  } catch (error) {
    const nftWithError = await markProfileNftError({
      accountId: session.accountId,
      nftId,
      error: error?.message || "profile_nft_mint_failed",
    }).catch(() => null);
    return {
      status: error?.status || 500,
      body: {
        ok: false,
        error: error?.message || "profile_nft_mint_failed",
        message: error?.message || "Profile NFT minting failed.",
        nft: nftWithError || nft,
      },
    };
  }
}
