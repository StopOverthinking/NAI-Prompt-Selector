"use strict";

const assert = require("node:assert/strict");
const Core = require("../prompt-core");
const Store = require("../prompt-storage");

const meaningfulOptions = {
  defaultGroupsDefinition: Core.DEFAULT_GROUPS_DEFINITION,
  defaultCharacterPromptGroupsDefinition: Core.DEFAULT_CHARACTER_PROMPT_GROUPS_DEFINITION,
  defaultGroupsDefinitions: {
    "main.base": Core.DEFAULT_GROUPS_DEFINITION,
    "main.uc": Core.DEFAULT_NEGATIVE_GROUPS_DEFINITION,
    "character.1.prompt": Core.DEFAULT_CHARACTER_PROMPT_GROUPS_DEFINITION,
    "character.1.uc": "",
  },
};

function makeSelector(overrides = {}) {
  return {
    version: 5,
    activeSlotId: "main.base",
    activePanelTab: "main",
    characterLabels: {},
    slots: {
      "main.base": {
        groupsDefinition: Core.DEFAULT_GROUPS_DEFINITION,
        quickPrompt: "",
        selectionState: "{}",
        weightMemory: "{}",
        suffixSelectionState: "{}",
        suffixWeightMemory: "{}",
      },
      "main.uc": {
        groupsDefinition: Core.DEFAULT_NEGATIVE_GROUPS_DEFINITION,
        quickPrompt: "",
        selectionState: "{}",
        weightMemory: "{}",
        suffixSelectionState: "{}",
        suffixWeightMemory: "{}",
      },
    },
    ...overrides,
  };
}

const emptySelector = makeSelector();
const meaningfulSelector = makeSelector({
  slots: {
    "main.base": {
      groupsDefinition: "[Quality]\nmasterpiece\n\n[Custom]\nblue archive",
      quickPrompt: "dynamic angle",
      selectionState: JSON.stringify({ Quality: { masterpiece: 1 } }),
      weightMemory: "{}",
      suffixSelectionState: "{}",
      suffixWeightMemory: "{}",
    },
    "main.uc": {
      groupsDefinition: "",
      quickPrompt: "",
      selectionState: "{}",
      weightMemory: "{}",
      suffixSelectionState: "{}",
      suffixWeightMemory: "{}",
    },
  },
});

assert.equal(Store.isMeaningfulSelectorState(emptySelector, meaningfulOptions), false);
assert.equal(Store.isMeaningfulSelectorState(meaningfulSelector, meaningfulOptions), true);

const defaultCharacterSelector = makeSelector({
  characterLabels: { 1: Core.DEFAULT_CHARACTER_LABEL },
  slots: {
    ...emptySelector.slots,
    "character.1.prompt": {
      groupsDefinition: Core.DEFAULT_CHARACTER_PROMPT_GROUPS_DEFINITION,
      quickPrompt: "",
      selectionState: "{}",
      weightMemory: "{}",
      suffixSelectionState: "{}",
      suffixWeightMemory: "{}",
    },
    "character.1.uc": {
      groupsDefinition: "",
      quickPrompt: "",
      selectionState: "{}",
      weightMemory: "{}",
      suffixSelectionState: "{}",
      suffixWeightMemory: "{}",
    },
  },
});
assert.equal(Store.isMeaningfulSelectorState(defaultCharacterSelector, meaningfulOptions), false);

const envelope = Store.createExportEnvelope(meaningfulSelector, {
  exportedAt: "2026-05-05T00:00:00.000Z",
  extensionId: "fixed-extension-id",
});
assert.equal(envelope.app, "NAI-Prompt-Selector");
assert.equal(envelope.schemaVersion, 1);
assert.equal(envelope.extensionId, "fixed-extension-id");
assert.deepEqual(Store.parseExportEnvelope(JSON.stringify(envelope)).envelope.selector, meaningfulSelector);

assert.equal(Store.parseExportEnvelope("{").ok, false);
assert.equal(Store.parseExportEnvelope({ app: "Other", schemaVersion: 1, selector: {} }).ok, false);
assert.equal(Store.parseExportEnvelope({ app: "NAI-Prompt-Selector", schemaVersion: 1 }).ok, false);

let backups = [];
for (let index = 0; index < 25; index += 1) {
  const selector = makeSelector({
    slots: {
      ...meaningfulSelector.slots,
      "main.base": {
        ...meaningfulSelector.slots["main.base"],
        quickPrompt: `prompt ${index}`,
      },
    },
  });
  backups = Store.appendBackup(backups, Store.createBackupSnapshot(selector, {
    createdAt: `2026-05-05T00:00:${String(index).padStart(2, "0")}.000Z`,
    reason: "test",
  }));
}
assert.equal(backups.length, Store.DEFAULT_BACKUP_LIMIT);
assert.equal(backups[0].selector.slots["main.base"].quickPrompt, "prompt 24");
assert.equal(backups.at(-1).selector.slots["main.base"].quickPrompt, "prompt 5");

assert.equal(Store.shouldBlockEmptyRegression(meaningfulSelector, emptySelector, meaningfulOptions), true);
assert.equal(
  Store.shouldBlockEmptyRegression(meaningfulSelector, emptySelector, { ...meaningfulOptions, explicit: true }),
  false,
);
assert.equal(Store.shouldCreateAutomaticBackup(meaningfulSelector, emptySelector, meaningfulOptions), true);

assert.deepEqual(
  Store.selectLastGoodSelector(emptySelector, meaningfulSelector, meaningfulOptions),
  meaningfulSelector,
);
assert.deepEqual(
  Store.selectLastGoodSelector(meaningfulSelector, emptySelector, meaningfulOptions),
  meaningfulSelector,
);

console.log("prompt-storage tests passed");
