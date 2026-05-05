(function attachPromptStorage(global) {
  "use strict";

  const APP_NAME = "NAI-Prompt-Selector";
  const EXPORT_SCHEMA_VERSION = 1;
  const BACKUP_SCHEMA_VERSION = 1;
  const DEFAULT_BACKUP_LIMIT = 20;
  const MAIN_BASE_SLOT_ID = "main.base";
  const SLOT_TEXT_FIELDS = [
    "groupsDefinition",
    "quickPrompt",
  ];
  const SLOT_JSON_FIELDS = [
    "selectionState",
    "weightMemory",
    "suffixSelectionState",
    "suffixWeightMemory",
  ];
  const SLOT_SIGNATURE_FIELDS = [
    ...SLOT_TEXT_FIELDS,
    ...SLOT_JSON_FIELDS,
  ];

  function cloneJson(value) {
    if (value == null) {
      return value;
    }
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeText(value) {
    return String(value || "").replace(/\r\n?/g, "\n").trim();
  }

  function parseObjectValue(value) {
    if (!value) {
      return {};
    }
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function hasOwnEnumerableKeys(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length);
  }

  function getDefaultGroupsDefinitionForSlot(slotId, options = {}) {
    const defaultsBySlot = options.defaultGroupsDefinitions;
    if (
      defaultsBySlot
      && typeof defaultsBySlot === "object"
      && !Array.isArray(defaultsBySlot)
      && Object.prototype.hasOwnProperty.call(defaultsBySlot, slotId)
    ) {
      return normalizeText(defaultsBySlot[slotId]);
    }
    if (/^character\.\d+\.prompt$/.test(String(slotId || ""))) {
      return normalizeText(options.defaultCharacterPromptGroupsDefinition);
    }
    return slotId === MAIN_BASE_SLOT_ID ? normalizeText(options.defaultGroupsDefinition) : "";
  }

  function getSelectorSlots(selector) {
    if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
      return {};
    }
    if (selector.slots && typeof selector.slots === "object" && !Array.isArray(selector.slots)) {
      return selector.slots;
    }
    if (SLOT_SIGNATURE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(selector, field))) {
      return { [MAIN_BASE_SLOT_ID]: selector };
    }
    return {};
  }

  function slotHasMeaningfulData(slotId, slot, options = {}) {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
      return false;
    }

    if (normalizeText(slot.quickPrompt)) {
      return true;
    }

    for (const field of SLOT_JSON_FIELDS) {
      if (hasOwnEnumerableKeys(parseObjectValue(slot[field]))) {
        return true;
      }
    }

    const groupsDefinition = normalizeText(slot.groupsDefinition);
    if (!groupsDefinition) {
      return false;
    }

    const defaultGroupsDefinition = getDefaultGroupsDefinitionForSlot(slotId, options);
    return !defaultGroupsDefinition || groupsDefinition !== defaultGroupsDefinition;
  }

  function isMeaningfulSelectorState(selector, options = {}) {
    const slots = getSelectorSlots(selector);
    return Object.entries(slots).some(([slotId, slot]) => slotHasMeaningfulData(slotId, slot, options));
  }

  function stableNormalize(value) {
    if (Array.isArray(value)) {
      return value.map(stableNormalize);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = stableNormalize(value[key]);
    }
    return normalized;
  }

  function stableStringify(value) {
    return JSON.stringify(stableNormalize(value));
  }

  function getPromptDataSignature(selector) {
    const slots = getSelectorSlots(selector);
    const signature = {
      characterLabels: selector?.characterLabels && typeof selector.characterLabels === "object"
        ? selector.characterLabels
        : {},
      slots: {},
    };

    for (const slotId of Object.keys(slots).sort()) {
      const slot = slots[slotId] || {};
      const slotSignature = {};
      for (const field of SLOT_SIGNATURE_FIELDS) {
        slotSignature[field] = String(slot[field] || "");
      }
      signature.slots[slotId] = slotSignature;
    }

    return stableStringify(signature);
  }

  function createBackupSnapshot(selector, options = {}) {
    return {
      app: APP_NAME,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      createdAt: options.createdAt || new Date().toISOString(),
      reason: String(options.reason || "backup"),
      selector: cloneJson(selector || {}),
    };
  }

  function isBackupSnapshot(value) {
    return Boolean(
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && value.app === APP_NAME
      && value.schemaVersion === BACKUP_SCHEMA_VERSION
      && value.selector
      && typeof value.selector === "object"
      && !Array.isArray(value.selector),
    );
  }

  function appendBackup(backups, snapshot, options = {}) {
    const limit = Math.max(1, Number.parseInt(options.limit, 10) || DEFAULT_BACKUP_LIMIT);
    const nextBackups = [];
    const seenSignatures = new Set();

    const addSnapshot = (candidate) => {
      if (!isBackupSnapshot(candidate)) {
        return;
      }
      const signature = getPromptDataSignature(candidate.selector);
      if (seenSignatures.has(signature)) {
        return;
      }
      seenSignatures.add(signature);
      nextBackups.push(cloneJson(candidate));
    };

    addSnapshot(snapshot);
    if (Array.isArray(backups)) {
      backups.forEach(addSnapshot);
    }
    return nextBackups.slice(0, limit);
  }

  function createExportEnvelope(selector, options = {}) {
    return {
      app: APP_NAME,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: options.exportedAt || new Date().toISOString(),
      extensionId: String(options.extensionId || ""),
      selector: cloneJson(selector || {}),
    };
  }

  function parseExportEnvelope(input) {
    let parsed = input;
    if (typeof input === "string") {
      try {
        parsed = JSON.parse(input);
      } catch (error) {
        return { ok: false, error: "JSON 파일을 읽지 못했습니다." };
      }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "백업 파일 형식이 올바르지 않습니다." };
    }
    if (parsed.app !== APP_NAME || parsed.schemaVersion !== EXPORT_SCHEMA_VERSION) {
      return { ok: false, error: "NAI-Prompt-Selector 백업 파일이 아닙니다." };
    }
    if (!parsed.selector || typeof parsed.selector !== "object" || Array.isArray(parsed.selector)) {
      return { ok: false, error: "백업 파일에 selector 상태가 없습니다." };
    }

    return { ok: true, envelope: cloneJson(parsed) };
  }

  function getLatestRestorableBackup(backups, options = {}) {
    if (!Array.isArray(backups)) {
      return null;
    }
    for (const backup of backups) {
      if (isBackupSnapshot(backup) && isMeaningfulSelectorState(backup.selector, options)) {
        return cloneJson(backup);
      }
    }
    return null;
  }

  function shouldBlockEmptyRegression(previousSelector, nextSelector, options = {}) {
    if (options.explicit) {
      return false;
    }
    return (
      isMeaningfulSelectorState(previousSelector, options)
      && !isMeaningfulSelectorState(nextSelector, options)
    );
  }

  function shouldCreateAutomaticBackup(previousSelector, nextSelector, options = {}) {
    return (
      isMeaningfulSelectorState(previousSelector, options)
      && getPromptDataSignature(previousSelector) !== getPromptDataSignature(nextSelector)
    );
  }

  function selectLastGoodSelector(nextSelector, previousLastGoodSelector, options = {}) {
    if (isMeaningfulSelectorState(nextSelector, options)) {
      return cloneJson(nextSelector);
    }
    if (isMeaningfulSelectorState(previousLastGoodSelector, options)) {
      return cloneJson(previousLastGoodSelector);
    }
    return null;
  }

  const api = {
    APP_NAME,
    BACKUP_SCHEMA_VERSION,
    DEFAULT_BACKUP_LIMIT,
    EXPORT_SCHEMA_VERSION,
    appendBackup,
    cloneJson,
    createBackupSnapshot,
    createExportEnvelope,
    getLatestRestorableBackup,
    getPromptDataSignature,
    isBackupSnapshot,
    isMeaningfulSelectorState,
    parseExportEnvelope,
    selectLastGoodSelector,
    shouldBlockEmptyRegression,
    shouldCreateAutomaticBackup,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.NAIPromptStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
