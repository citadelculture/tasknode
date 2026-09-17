import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";

const {
  createGeneratingProfileNft,
  createGeneratedProfileNft,
  countProfileNfts,
  getProfileNft,
  listProfileNfts,
  markProfileNftError,
  markProfileNftFailed,
  markProfileNftGenerated,
  markProfileNftMintPrepared,
  markProfileNftMinted,
} = await import("../server/repositories/profile-nfts.js");
const { pftUriToHex } = await import("../server/pftl-submit.js");
const { latestProfileStudioNft } = await import("../server/profile-routes.js");

const accountId = "account_profile_nft_smoke";
const walletAddress = "rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7";
const oldWalletAddress = "rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE";

const generated = await createGeneratedProfileNft({
  accountId,
  walletAddress,
  title: "Smoke Profile NFT",
  imageCid: "QmSmokeProfileNftImageCid1111111111111111111",
  imageGatewayUrl: "https://dweb.link/ipfs/QmSmokeProfileNftImageCid1111111111111111111",
  imageMimeType: "image/png",
  imageSizeBytes: 1234,
  imageSha256: "abc123",
  promptSource: "placeholder",
  promptDigest: "prompt_digest",
  templateDigest: "template_digest",
  model: "gpt-image-2.5-sunburst",
  size: "1024x1024",
  quality: "low",
  outputFormat: "png",
});

assert.equal(generated.status, "generated");
assert.equal(generated.accountId, accountId);

const listed = await listProfileNfts({ accountId });
assert.equal(listed.length, 1);
assert.equal(listed[0].id, generated.id);

const recovering = await createGeneratingProfileNft({
  accountId,
  walletAddress,
  title: "Recoverable Profile NFT",
  promptSource: "placeholder",
  promptDigest: "recover_prompt_digest",
  templateDigest: "recover_template_digest",
  model: "gpt-image-2.5-sunburst",
  size: "1024x1024",
  quality: "high",
  outputFormat: "png",
});
assert.equal(recovering.status, "generating");
assert.equal(recovering.imageCid, "");

const recoveringListed = await listProfileNfts({ accountId, walletAddress });
assert.ok(
  recoveringListed.some((nft) => nft.id === recovering.id && nft.status === "generating"),
  "generating recovery rows must be visible from the profile NFT list"
);

const recovered = await markProfileNftGenerated({
  accountId,
  nftId: recovering.id,
  imageCid: "QmRecoveredProfileNftImageCid1111111111111",
  imageGatewayUrl: "https://dweb.link/ipfs/QmRecoveredProfileNftImageCid1111111111111",
  imageMimeType: "image/png",
  imageSizeBytes: 2345,
  imageSha256: "def456",
  model: "gpt-image-2.5-sunburst",
  size: "1024x1024",
  quality: "high",
  outputFormat: "png",
});
assert.equal(recovered.id, recovering.id);
assert.equal(recovered.status, "generated");
assert.equal(recovered.imageCid, "QmRecoveredProfileNftImageCid1111111111111");
assert.equal(recovered.error, "");

const failedDraft = await createGeneratingProfileNft({
  accountId,
  walletAddress,
  title: "Failed Recoverable Profile NFT",
});
const failed = await markProfileNftFailed({
  accountId,
  nftId: failedDraft.id,
  error: "OpenAI image generation timed out before returning an image.",
});
assert.equal(failed.status, "failed");
assert.match(failed.error, /timed out/);

const oldWalletNft = await createGeneratedProfileNft({
  accountId,
  walletAddress: oldWalletAddress,
  title: "Old Wallet NFT",
  imageCid: "QmOldWalletProfileNftImageCid111111111111111",
});
const walletlessDraft = await createGeneratedProfileNft({
  accountId,
  title: "Walletless Draft",
  imageCid: "QmWalletlessProfileNftImageCid11111111111111",
});

const accountWide = await listProfileNfts({ accountId });
assert.equal(accountWide.length, 5);
assert.ok(accountWide.some((nft) => nft.id === oldWalletNft.id));

const currentWalletListed = await listProfileNfts({ accountId, walletAddress });
const currentWalletCount = await countProfileNfts({ accountId, walletAddress });
assert.ok(currentWalletListed.some((nft) => nft.id === generated.id));
assert.ok(currentWalletListed.some((nft) => nft.id === recovered.id));
assert.ok(currentWalletListed.some((nft) => nft.id === failed.id));
assert.ok(currentWalletListed.some((nft) => nft.id === walletlessDraft.id));
assert.equal(currentWalletCount, currentWalletListed.length);
assert.equal(
  currentWalletListed.some((nft) => nft.id === oldWalletNft.id),
  false,
  "current wallet gallery must not include old wallet NFTs"
);

const collectionAccountId = "account_profile_nft_collection_smoke";
const collectionWalletAddress = "r4RPpeS2kUE8BjY9LvKbptW8PQVHhVWghS";
for (let index = 0; index < 67; index += 1) {
  await createGeneratedProfileNft({
    accountId: collectionAccountId,
    walletAddress: collectionWalletAddress,
    title: `Collection NFT ${index + 1}`,
    imageCid: `QmCollectionProfileNftImageCid${String(index + 1).padStart(3, "0")}`,
  });
}
const collectionListed = await listProfileNfts({
  accountId: collectionAccountId,
  walletAddress: collectionWalletAddress,
  limit: 240,
});
assert.equal(collectionListed.length, 67, "current wallet gallery must support imported NFT collections over 40 rows");

const metadataUri = "ipfs://QmSmokeProfileNftMetadataCid1111111111111111";
const uriHex = pftUriToHex(metadataUri);
assert.equal(Buffer.from(uriHex, "hex").toString("utf8"), metadataUri);

const prepared = await markProfileNftMintPrepared({
  accountId,
  nftId: generated.id,
  metadataCid: "QmSmokeProfileNftMetadataCid1111111111111111",
  metadataUri,
  metadataJson: { schema: "erc721", image: `ipfs://${generated.imageCid}` },
  mintTxJson: {
    TransactionType: "NFTokenMint",
    Account: walletAddress,
    URI: uriHex,
  },
});
assert.equal(prepared.status, "prepared");
assert.equal(prepared.mintTxJson.URI, uriHex);

const erroredPrepared = await markProfileNftError({
  accountId,
  nftId: prepared.id,
  error: "Signed transaction does not match the linked wallet.",
});
assert.equal(erroredPrepared.status, "prepared", "mint errors must not turn generated art into failed generation");
assert.match(erroredPrepared.error, /linked wallet/);

const retryPrepared = await markProfileNftMintPrepared({
  accountId,
  nftId: prepared.id,
  metadataCid: "QmSmokeProfileNftMetadataCid1111111111111111",
  metadataUri,
  metadataJson: { schema: "erc721", image: `ipfs://${generated.imageCid}` },
  mintTxJson: {
    TransactionType: "NFTokenMint",
    Account: walletAddress,
    URI: uriHex,
  },
});
assert.equal(retryPrepared.status, "prepared");
assert.equal(retryPrepared.error, "");

const preparedDraft = await markProfileNftMintPrepared({
  accountId,
  nftId: walletlessDraft.id,
  metadataCid: "QmWalletlessProfileNftMetadataCid1111111111",
  metadataUri,
  metadataJson: { schema: "erc721", image: `ipfs://${walletlessDraft.imageCid}` },
  mintTxJson: {
    TransactionType: "NFTokenMint",
    Account: walletAddress,
    URI: uriHex,
  },
  walletAddress,
});
assert.equal(preparedDraft.walletAddress, walletAddress, "mint preparation must bind walletless drafts to the signing wallet");

const minted = await markProfileNftMinted({
  accountId,
  nftId: generated.id,
  txHash: "ABCDEF123456",
  nftTokenId: "000B013A95F14B0044F78A264E41713C64B5F89242540EE2",
});
assert.equal(minted.status, "minted");
assert.equal(minted.txHash, "ABCDEF123456");

const fetched = await getProfileNft({ accountId, nftId: generated.id });
assert.equal(fetched.nftTokenId, "000B013A95F14B0044F78A264E41713C64B5F89242540EE2");
const orderedAfterMint = await listProfileNfts({ accountId, walletAddress });
assert.equal(orderedAfterMint[0].id, walletlessDraft.id, "profile NFT list must default to newest created row, not latest minted row");

const chainImported = {
  id: "nft_chain_newest",
  promptSource: "pftl_chain_inventory",
  status: "minted",
};
assert.equal(
  latestProfileStudioNft([chainImported, erroredPrepared])?.id,
  erroredPrepared.id,
  "Profile Studio latest must prefer app-generated rows over imported onchain inventory"
);
assert.equal(latestProfileStudioNft([chainImported])?.id, chainImported.id);
assert.equal(
  latestProfileStudioNft([oldWalletNft, erroredPrepared], { walletAddress })?.id,
  erroredPrepared.id,
  "Profile Studio latest must ignore app-generated rows from a previous wallet"
);
assert.equal(latestProfileStudioNft([oldWalletNft], { walletAddress }), null);
assert.equal(latestProfileStudioNft([walletlessDraft], { walletAddress })?.id, walletlessDraft.id);

console.log("profile-nft-flow-smoke ok");
