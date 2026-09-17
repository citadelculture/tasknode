---
name: profile-nft-image-placeholder
model: gpt-image-2.5-sunburst
temperature: 0.7
max_tokens: 4000
---
@@@SYSTEM@@@
Create a square profile NFT image from the supplied user execution context.

The prompt in this file is a safe tracked placeholder. Production can load a
private prompt from `private_prompts/profile_nft_image.md` or from
`PROFILE_NFT_PROMPT_PATH`. Keep the private prompt out of git.

@@@USER@@@
Create a square, high-detail profile NFT image representing the user's current
work identity.

Rules:
- Use one central avatar or work persona with a clear silhouette.
- Use the supplied context for visual motifs, not literal text.
- Do not render words, wallet addresses, user handles, emails, URLs, private
  names, raw task IDs, or raw task titles in the image.
- Use a clean light background suitable for a profile gallery.
- No text in the image.

<NFT_CONTEXT_HYDRATION>
___NFT_USER_DATA_REPLACED_HERE___
</NFT_CONTEXT_HYDRATION>

<USER_CONTEXT_DOCUMENT_DIRECT>
___USER_CONTEXT_DOCUMENT_CONTENT_REPLACED_HERE___
</USER_CONTEXT_DOCUMENT_DIRECT>

Boot string:
< insert Random String>
