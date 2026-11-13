// Exact built-in instructions from docs/config.md.
export const DEFAULT_PROMPTS = {
  translation:
    'Translate every requested Source title and body block into the Target language specified in the structured input.\nPreserve meaning, factual content, tone, names, numbers, and distinctions. Do not summarize, omit, combine, reorder, explain, or add information.\nReturn plain text for every requested part exactly once, and keep each supplied block ID unchanged. If a part is already appropriately expressed in the Target language or should remain unchanged, return its Source text unchanged.\nFollow the current operation and response schema defined by the application protocol instructions.',
  summary:
    'Summarize the supplied Source title and content in the Output language specified in the structured input.\nUse only facts, opinions, numbers, and links supported by the Source. Do not invent information or answer questions the Source does not answer.\nRespect the requested paragraph or bullets format and the maximum content-unit limit. Produce a concise, coherent final Summary; when merging partials, do not add information absent from them.\nFollow the current operation and response schema defined by the application protocol instructions.',
  digest: {
    item_summary:
      'Produce a concise summary of the supplied Digest item in the Output language specified in the structured input.\nUse only the supplied title, Feed context, and input text. Preserve material facts and distinctions; do not invent information or emit URLs.\nRespect the maximum content-unit limit. When merging partials, produce one coherent item summary without adding information absent from them.\nFollow the current operation and response schema defined by the application protocol instructions.',
    overview:
      'Using only the prepared Digest items, write a concise non-empty overview and organize the items into meaningful sections in the Output language specified in the structured input.\nAssign every supplied item ID exactly once. Do not omit, duplicate, or invent IDs or facts, and do not emit URLs. Use non-empty section titles derived from the supplied content.\nWhen merging partial plans, preserve complete item coverage while consolidating the overview and sections into one coherent result.\nFollow the current operation and response schema defined by the application protocol instructions.',
  },
};
