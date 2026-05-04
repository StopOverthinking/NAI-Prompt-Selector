"use strict";

const assert = require("node:assert/strict");
const Core = require("../prompt-core");

assert.equal(Core.formatPromptItemWithWeight("1girl", 1), "1girl");
assert.equal(Core.formatPromptItemWithWeight("1girl", 1.5), "1.5::1girl::");
assert.equal(Core.formatPromptItemWithWeight("1girl", -1.5), "-1.5::1girl::");
assert.equal(Core.formatPromptItemWithWeight("1girl", 0.75), "0.75::1girl::");
assert.equal(Core.formatPromptItemWithWeight("masterpiece, best quality", 1.25), "1.25::masterpiece, best quality::");
assert.equal(Core.formatPromptWeightValue(1.50), "1.5");
assert.equal(Core.formatPromptWeightValue(1.05), "1.05");
assert.equal(Core.normalizePromptWeight(1.234), 1.25);
assert.equal(Core.normalizePromptWeight(9), 3);
assert.equal(Core.normalizePromptWeight(-9), -3);
assert.equal(Core.normalizePromptWeight(0.01), 0);
assert.equal(Core.normalizePromptWeight(-0.01), 0);

const groups = Core.parseGroupsDefinition(`[Personnel]
1girl
solo

[Quality]
best quality`);
const selectionState = Core.parseSelectionState({
  Personnel: {
    "1girl": 1.5,
  },
  Quality: {
    "best quality": 1,
  },
});
const prompt = Core.buildPrompt(groups, selectionState, "1.5::1girl::\nextra detail");

assert.equal(prompt, "1.5::1girl::,\n\nbest quality,\n\nextra detail");
assert.equal(prompt.includes("(1girl:"), false);
assert.equal(Core.unwrapNovelAiWeightSyntax("1.5::1girl::"), "1girl");
assert.equal(Core.unwrapNovelAiWeightSyntax("-1.5::1girl::"), "1girl");
assert.equal(Core.normalizePromptIdentity("1.5::1girl::"), Core.normalizePromptIdentity("1girl"));

assert.equal(
  Core.canPruneMissingCharacterSlots({
    hasStoredCharacterSlots: true,
    hasPromptMain: false,
    currentCharacterCount: 0,
    hasObservedCharacterDom: false,
  }),
  false,
);
assert.equal(
  Core.canPruneMissingCharacterSlots({
    hasStoredCharacterSlots: true,
    hasPromptMain: true,
    currentCharacterCount: 0,
    hasObservedCharacterDom: false,
  }),
  false,
);
assert.equal(
  Core.canPruneMissingCharacterSlots({
    hasStoredCharacterSlots: true,
    hasPromptMain: true,
    currentCharacterCount: 1,
    hasObservedCharacterDom: false,
  }),
  true,
);
assert.equal(
  Core.canPruneMissingCharacterSlots({
    forcePruneMissingCharacters: true,
    hasStoredCharacterSlots: true,
    hasPromptMain: false,
    currentCharacterCount: 0,
    hasObservedCharacterDom: false,
  }),
  true,
);

const promptWithSuffix = Core.buildPrompt(groups, selectionState, "solo\nextra detail\nbest quality", {
  suffixSelectionState: Core.parseSelectionState({
    Personnel: {
      solo: 1,
    },
  }),
});

assert.equal(promptWithSuffix, "1.5::1girl::,\n\nbest quality,\n\nextra detail\n\nsolo,");
assert.equal(
  Core.buildPrompt(groups, selectionState, "extra detail", { suffixSelectionState: {} }),
  "1.5::1girl::,\n\nbest quality,\n\nextra detail",
);

console.log("prompt-core tests passed");
