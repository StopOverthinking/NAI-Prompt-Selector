(function loadNaiPromptSelector() {
  "use strict";

  if (window.__naiPromptSelectorLoaded) {
    return;
  }
  window.__naiPromptSelectorLoaded = true;

  const Core = window.NAIPromptCore;
  if (!Core) {
    console.error("[NAI-Prompt-Selector] prompt-core.js was not loaded.");
    return;
  }

  const SELECTOR_STORAGE_KEY = "naiPromptSelector.selector";
  const LEGACY_SELECTOR_STORAGE_KEY = "naiPromptManager.selector";
  const AUTO_REFRESH_MS = 500;
  const ONE_CLICK_TIMEOUT_MS = 10 * 60 * 1000;
  const PANEL_POSITION_MARGIN = 8;
  const PANEL_EDGE_ANCHOR_DISTANCE = 24;

  const MAIN_BASE_SLOT_ID = "main.base";
  const MAIN_UC_SLOT_ID = "main.uc";

  const DEFAULT_SELECTOR_STATE = {
    version: 5,
    activeSlotId: MAIN_BASE_SLOT_ID,
    activeCharacterIndex: null,
    activePanelTab: "auto",
    panelCollapsed: true,
    panelPosition: null,
    panelCollapsedPosition: null,
    panelCollapsedFrame: null,
    characterLabels: {},
    slots: {},
  };

  let selectorState = {
    ...DEFAULT_SELECTOR_STATE,
    slots: {
      [MAIN_BASE_SLOT_ID]: createSlotData(MAIN_BASE_SLOT_ID),
      [MAIN_UC_SLOT_ID]: createSlotData(MAIN_UC_SLOT_ID),
    },
  };
  let panelHost = null;
  let panelShadow = null;
  let ui = {};
  let statusTimer = null;
  let hasObservedCharacterDom = false;
  const characterEnabledMemory = {};
  const characterRootState = new WeakMap();
  const textareaVerticalCaretMemory = new WeakMap();
  let suppressCharacterReconcileUntil = 0;
  let suppressCharacterActionTrackingUntil = 0;

  const autoRun = {
    active: false,
    count: 0,
    completedCount: 0,
    target: 0,
    initialHistoryCount: 0,
    timerId: null,
    timeoutId: null,
    useSelector: false,
    waitingForCompletion: false,
    ignoreReadyUntil: 0,
  };
  let pendingDeleteCharacterIndex = null;
  let draggingCharacterIndex = null;
  let characterDropTargetIndex = null;
  let panelLayoutRequestId = 0;
  let panelViewportRealignRequestId = 0;
  let panelCurrentFrame = null;
  let panelResolutionWatcher = null;

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function storageGet(area, keys) {
    return new Promise((resolve) => {
      chrome.storage[area].get(keys, (result) => resolve(result || {}));
    });
  }

  function storageSet(area, values) {
    return new Promise((resolve) => {
      chrome.storage[area].set(values, () => resolve());
    });
  }

  function createSlotData(slotId, overrides = {}) {
    const isMainBase = slotId === MAIN_BASE_SLOT_ID;
    return {
      groupsDefinition: isMainBase ? Core.DEFAULT_GROUPS_DEFINITION : "",
      selectionState: "{}",
      weightMemory: "{}",
      quickPrompt: "",
      suffixSelectionState: "{}",
      suffixWeightMemory: "{}",
      ...overrides,
    };
  }

  function sanitizeSlotData(slotId, value = {}) {
    return createSlotData(slotId, {
      groupsDefinition: String(value.groupsDefinition ?? (slotId === MAIN_BASE_SLOT_ID ? Core.DEFAULT_GROUPS_DEFINITION : "")),
      selectionState: String(value.selectionState || "{}"),
      weightMemory: String(value.weightMemory || "{}"),
      quickPrompt: String(value.quickPrompt || ""),
      suffixSelectionState: String(value.suffixSelectionState || "{}"),
      suffixWeightMemory: String(value.suffixWeightMemory || "{}"),
    });
  }

  function cloneSlotData(slotId, value) {
    return sanitizeSlotData(slotId, value ? { ...value } : createSlotData(slotId));
  }

  function sanitizePanelPosition(value) {
    const left = Number.parseFloat(value?.left);
    const top = Number.parseFloat(value?.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      return null;
    }
    return { left, top };
  }

  function sanitizePanelFrame(value) {
    const position = sanitizePanelPosition(value);
    if (!position || !value || typeof value !== "object") {
      return null;
    }

    const width = Number.parseFloat(value.width);
    const height = Number.parseFloat(value.height);
    const rightGap = Number.parseFloat(value.rightGap);
    const bottomGap = Number.parseFloat(value.bottomGap);
    const viewportWidth = Number.parseFloat(value.viewportWidth);
    const viewportHeight = Number.parseFloat(value.viewportHeight);
    const devicePixelRatio = Number.parseFloat(value.devicePixelRatio);
    return {
      left: position.left,
      top: position.top,
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
      rightGap: Number.isFinite(rightGap) ? rightGap : null,
      bottomGap: Number.isFinite(bottomGap) ? bottomGap : null,
      viewportWidth: Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : null,
      viewportHeight: Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : null,
      devicePixelRatio: Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : null,
      anchorRight: Boolean(value.anchorRight),
      anchorBottom: Boolean(value.anchorBottom),
    };
  }

  function sanitizeCharacterLabels(value) {
    const labels = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return labels;
    }

    for (const [index, label] of Object.entries(value)) {
      const numericIndex = Number.parseInt(index, 10);
      const normalizedLabel = String(label || "").trim();
      if (Number.isFinite(numericIndex) && numericIndex > 0 && normalizedLabel) {
        labels[numericIndex] = normalizedLabel.slice(0, 48);
      }
    }
    return labels;
  }

  function getCharacterPanelTabId(index) {
    return `character.${index}`;
  }

  function parsePanelTab(tabId) {
    if (tabId === "auto") {
      return { kind: "auto" };
    }
    if (tabId === "main") {
      return { kind: "main" };
    }
    const match = String(tabId || "").match(/^character\.(\d+)$/);
    if (match) {
      const index = Number.parseInt(match[1], 10);
      if (Number.isFinite(index) && index > 0) {
        return { kind: "character", index };
      }
    }
    return null;
  }

  function sanitizePanelTab(tabId) {
    return parsePanelTab(tabId) ? tabId : DEFAULT_SELECTOR_STATE.activePanelTab;
  }

  function migrateStoredSelectorState(stored = {}) {
    const storedActiveCharacterIndex = Number.parseInt(stored.activeCharacterIndex, 10);
    const storedPanelCollapsed = Boolean(stored.panelCollapsed);
    const storedPanelPosition = sanitizePanelPosition(stored.panelPosition);
    const storedPanelCollapsedPosition = sanitizePanelPosition(stored.panelCollapsedPosition);
    const storedPanelCollapsedFrame = sanitizePanelFrame(stored.panelCollapsedFrame);
    const nextState = {
      ...DEFAULT_SELECTOR_STATE,
      panelCollapsed: storedPanelCollapsed,
      panelPosition: storedPanelPosition,
      panelCollapsedPosition: storedPanelCollapsedPosition || (storedPanelCollapsed ? storedPanelPosition : null),
      panelCollapsedFrame: storedPanelCollapsedFrame,
      activePanelTab: sanitizePanelTab(stored.activePanelTab),
      characterLabels: sanitizeCharacterLabels(stored.characterLabels),
      activeSlotId: typeof stored.activeSlotId === "string" ? stored.activeSlotId : MAIN_BASE_SLOT_ID,
      activeCharacterIndex: Number.isFinite(storedActiveCharacterIndex) && storedActiveCharacterIndex > 0
        ? storedActiveCharacterIndex
        : null,
      slots: {},
    };

    if (stored.slots && typeof stored.slots === "object" && !Array.isArray(stored.slots)) {
      for (const [slotId, slotData] of Object.entries(stored.slots)) {
        nextState.slots[slotId] = sanitizeSlotData(slotId, slotData);
      }
    } else {
      nextState.slots[MAIN_BASE_SLOT_ID] = sanitizeSlotData(MAIN_BASE_SLOT_ID, {
        groupsDefinition: stored.groupsDefinition,
        selectionState: stored.selectionState,
        weightMemory: stored.weightMemory,
        quickPrompt: stored.quickPrompt,
      });
    }

    if (!nextState.slots[MAIN_BASE_SLOT_ID]) {
      nextState.slots[MAIN_BASE_SLOT_ID] = createSlotData(MAIN_BASE_SLOT_ID);
    }
    if (!nextState.slots[MAIN_UC_SLOT_ID]) {
      nextState.slots[MAIN_UC_SLOT_ID] = createSlotData(MAIN_UC_SLOT_ID);
    }
    if (!nextState.slots[nextState.activeSlotId]) {
      nextState.activeSlotId = MAIN_BASE_SLOT_ID;
    }
    if (!nextState.panelCollapsedFrame && nextState.panelCollapsedPosition) {
      nextState.panelCollapsedFrame = createPanelFrameFromPosition(nextState.panelCollapsedPosition, getPanelFallbackSize(true));
    }

    return nextState;
  }

  async function loadSelectorState() {
    const result = await storageGet("local", [SELECTOR_STORAGE_KEY, LEGACY_SELECTOR_STORAGE_KEY]);
    const storedState = result[SELECTOR_STORAGE_KEY] || result[LEGACY_SELECTOR_STORAGE_KEY] || {};
    selectorState = migrateStoredSelectorState(storedState);
    if (!result[SELECTOR_STORAGE_KEY] && result[LEGACY_SELECTOR_STORAGE_KEY]) {
      await saveSelectorState();
    }
  }

  function saveSelectorState() {
    return storageSet("local", { [SELECTOR_STORAGE_KEY]: selectorState });
  }

  function ensureSlot(slotId) {
    if (!selectorState.slots[slotId]) {
      selectorState.slots[slotId] = createSlotData(slotId);
    }
    return selectorState.slots[slotId];
  }

  function getActiveSlotId() {
    if (!selectorState.slots[selectorState.activeSlotId]) {
      selectorState.activeSlotId = MAIN_BASE_SLOT_ID;
    }
    return selectorState.activeSlotId;
  }

  function getActiveSlotData() {
    return ensureSlot(getActiveSlotId());
  }

  function parseSlotSelectorState(slotId = getActiveSlotId(), mode = "leading") {
    const slotData = ensureSlot(slotId);
    const groups = Core.parseGroupsDefinition(slotData.groupsDefinition);
    const isSuffix = mode === "suffix";
    const selectionState = Core.parseSelectionState(isSuffix ? slotData.suffixSelectionState : slotData.selectionState);
    const weightMemoryState = Core.parseWeightMemoryState(isSuffix ? slotData.suffixWeightMemory : slotData.weightMemory);
    return { groups, selectionState, weightMemoryState };
  }

  function pruneAndStoreSelectorState(slotId = getActiveSlotId()) {
    const slotData = ensureSlot(slotId);
    const { groups, selectionState, weightMemoryState } = parseSlotSelectorState(slotId);
    const normalized = Core.normalizeStoredPromptState(groups, selectionState, weightMemoryState);
    slotData.selectionState = JSON.stringify(normalized.selectionState);
    slotData.weightMemory = JSON.stringify(normalized.weightMemoryState);
    if (slotId === MAIN_BASE_SLOT_ID) {
      const {
        selectionState: suffixSelectionState,
        weightMemoryState: suffixWeightMemoryState,
      } = parseSlotSelectorState(slotId, "suffix");
      const normalizedSuffix = Core.normalizeStoredPromptState(groups, suffixSelectionState, suffixWeightMemoryState);
      slotData.suffixSelectionState = JSON.stringify(normalizedSuffix.selectionState);
      slotData.suffixWeightMemory = JSON.stringify(normalizedSuffix.weightMemoryState);
    }
    return normalized;
  }

  function buildSlotPrompt(slotId = getActiveSlotId()) {
    const slotData = ensureSlot(slotId);
    const { groups, selectionState } = parseSlotSelectorState(slotId);
    const options = slotId === MAIN_BASE_SLOT_ID
      ? { suffixSelectionState: Core.parseSelectionState(slotData.suffixSelectionState) }
      : {};
    return Core.buildPrompt(groups, selectionState, slotData.quickPrompt, options);
  }

  function buildCurrentPrompt() {
    return buildSlotPrompt(getActiveSlotId());
  }

  function parseSlotId(slotId) {
    if (slotId === MAIN_BASE_SLOT_ID) {
      return { scope: "main", kind: "base", label: "Base" };
    }
    if (slotId === MAIN_UC_SLOT_ID) {
      return { scope: "main", kind: "uc", label: "Main UC" };
    }
    const match = String(slotId || "").match(/^character\.(\d+)\.(prompt|uc)$/);
    if (match) {
      const index = Number.parseInt(match[1], 10);
      const kind = match[2];
      return {
        scope: "character",
        index,
        kind,
        label: `Char ${index} ${kind === "prompt" ? "Prompt" : "UC"}`,
      };
    }
    return null;
  }

  function makeCharacterSlotId(index, kind) {
    return `character.${index}.${kind}`;
  }

  function getCharacterLabel(index) {
    const numericIndex = Number.parseInt(index, 10);
    const label = selectorState.characterLabels?.[numericIndex];
    return String(label || "").trim() || `Char ${numericIndex}`;
  }

  function setCharacterLabel(index, value) {
    const numericIndex = Number.parseInt(index, 10);
    if (!Number.isFinite(numericIndex) || numericIndex < 1) {
      return;
    }
    if (!selectorState.characterLabels || typeof selectorState.characterLabels !== "object") {
      selectorState.characterLabels = {};
    }
    const label = String(value || "").trim().slice(0, 48);
    if (label) {
      selectorState.characterLabels[numericIndex] = label;
    } else {
      delete selectorState.characterLabels[numericIndex];
    }
  }

  function removeCharacterLabel(index) {
    if (selectorState.characterLabels) {
      delete selectorState.characterLabels[index];
    }
  }

  function swapCharacterLabels(leftIndex, rightIndex) {
    if (!selectorState.characterLabels || typeof selectorState.characterLabels !== "object") {
      selectorState.characterLabels = {};
    }
    const leftLabel = selectorState.characterLabels[leftIndex];
    const rightLabel = selectorState.characterLabels[rightIndex];
    if (rightLabel) {
      selectorState.characterLabels[leftIndex] = rightLabel;
    } else {
      delete selectorState.characterLabels[leftIndex];
    }
    if (leftLabel) {
      selectorState.characterLabels[rightIndex] = leftLabel;
    } else {
      delete selectorState.characterLabels[rightIndex];
    }
  }

  function shiftCharacterLabelsAfterDelete(deletedIndex, previousMaxIndex) {
    if (!selectorState.characterLabels || typeof selectorState.characterLabels !== "object") {
      selectorState.characterLabels = {};
      return;
    }
    for (let index = deletedIndex; index < previousMaxIndex; index += 1) {
      const nextLabel = selectorState.characterLabels[index + 1];
      if (nextLabel) {
        selectorState.characterLabels[index] = nextLabel;
      } else {
        delete selectorState.characterLabels[index];
      }
    }
    removeCharacterLabel(previousMaxIndex);
  }

  function getExplicitCharacterLabel(index) {
    const numericIndex = Number.parseInt(index, 10);
    const label = selectorState.characterLabels?.[numericIndex];
    return String(label || "").trim();
  }

  function copyExplicitCharacterLabel(index, label) {
    if (!selectorState.characterLabels || typeof selectorState.characterLabels !== "object") {
      selectorState.characterLabels = {};
    }
    const numericIndex = Number.parseInt(index, 10);
    const normalizedLabel = String(label || "").trim();
    if (normalizedLabel) {
      selectorState.characterLabels[numericIndex] = normalizedLabel;
    } else {
      delete selectorState.characterLabels[numericIndex];
    }
  }

  function getSlotLabel(slotId) {
    const parsed = parseSlotId(slotId);
    if (parsed?.scope === "character") {
      return `${getCharacterLabel(parsed.index)} ${parsed.kind === "prompt" ? "Prompt" : "UC"}`;
    }
    return parsed?.label || slotId;
  }

  function compareSlotIds(left, right) {
    const leftParsed = parseSlotId(left);
    const rightParsed = parseSlotId(right);
    const order = (parsed) => {
      if (!parsed) {
        return 9999;
      }
      if (parsed.scope === "main") {
        return parsed.kind === "base" ? 0 : 1;
      }
      return 10 + parsed.index * 2 + (parsed.kind === "prompt" ? 0 : 1);
    };
    return order(leftParsed) - order(rightParsed) || String(left).localeCompare(String(right));
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 16 && rect.height > 16;
  }

  function hasRenderedBox(element, { minWidth = 1, minHeight = 1 } = {}) {
    if (!(element instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width >= minWidth && rect.height >= minHeight;
  }

  function findGenerateButton() {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.find((button) => /Generate\s+\d+\s+Image(s)?/i.test(button.textContent || "")) || null;
  }

  function findPromptEditors() {
    const candidates = Array.from(document.querySelectorAll("[contenteditable]"))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.isContentEditable)
      .filter(isVisible)
      .filter((element) => !element.closest("#nai-prompt-selector-host"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width >= 140 && rect.height >= 24;
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.top - bRect.top || aRect.left - bRect.left;
      });

    return candidates;
  }

  function getVisibleEditorIn(root) {
    if (!root) {
      return null;
    }
    return Array.from(root.querySelectorAll("[contenteditable]"))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.isContentEditable)
      .filter(isVisible)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.top - bRect.top || aRect.left - bRect.left;
      })[0] || null;
  }

  function normalizeButtonText(button) {
    return String(button?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function findButtonByText(root, matcher) {
    if (!root) {
      return null;
    }
    return Array.from(root.querySelectorAll("button"))
      .filter(isVisible)
      .find((button) => matcher(normalizeButtonText(button))) || null;
  }

  function findCharacterBodyToggle(root) {
    if (!root) {
      return null;
    }

    return Array.from(root.querySelectorAll('[role="button"], [tabindex]'))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.tagName !== "BUTTON")
      .filter(isVisible)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
      })[0] || null;
  }

  function findAddCharacterButton() {
    return findButtonByText(document, (text) => /^Add Character$/i.test(text));
  }

  function getCharacterActionButtons(root) {
    if (!root) {
      return [];
    }

    const rootRect = root.getBoundingClientRect();
    return Array.from(root.querySelectorAll("button"))
      .filter((button) => button instanceof HTMLButtonElement)
      .filter((button) => {
        if (!isVisible(button) || normalizeButtonText(button)) {
          return false;
        }
        const rect = button.getBoundingClientRect();
        return rect.top <= rootRect.top + 44 && rect.left >= rootRect.left + rootRect.width - 96;
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  }

  function getCharacterActionButton(index, action) {
    const character = getCharacterScanByIndex(index);
    const actionIndex = { up: 0, down: 1 }[action];
    if (!character || actionIndex === undefined) {
      return null;
    }
    const button = getCharacterActionButtons(character.root)[actionIndex] || null;
    return button && !button.disabled ? button : null;
  }

  function getButtonMetadata(button) {
    return [
      normalizeButtonText(button),
      button?.getAttribute?.("aria-label"),
      button?.getAttribute?.("title"),
      button?.getAttribute?.("data-state"),
      button?.getAttribute?.("data-active"),
      button?.getAttribute?.("aria-pressed"),
      button?.getAttribute?.("aria-checked"),
      button?.className,
    ].map((value) => String(value || "").trim()).filter(Boolean).join(" ").toLowerCase();
  }

  function getCharacterEnabledToggleButtonFromRoot(root) {
    if (!root) {
      return null;
    }
    const header = root.children?.[0] || root;
    const buttons = Array.from(header.querySelectorAll("button"))
      .filter((button) => button instanceof HTMLButtonElement)
      .filter(isVisible);
    return buttons[2] || getCharacterActionButtons(root)[2] || null;
  }

  function readCharacterEnabledState(root, index, button = getCharacterEnabledToggleButtonFromRoot(root)) {
    if (root) {
      const opacity = Number.parseFloat(window.getComputedStyle(root).opacity);
      if (Number.isFinite(opacity) && opacity < 0.99) {
        return opacity >= 0.75;
      }
    }

    if (!button) {
      return characterEnabledMemory[index] ?? true;
    }

    const ariaPressed = button.getAttribute("aria-pressed");
    if (/^(true|false)$/i.test(String(ariaPressed || ""))) {
      return ariaPressed === "true";
    }
    const ariaChecked = button.getAttribute("aria-checked");
    if (/^(true|false)$/i.test(String(ariaChecked || ""))) {
      return ariaChecked === "true";
    }

    const metadata = getButtonMetadata(button);
    if (/\b(disabled|inactive|off|unchecked|enable character|enable)\b/.test(metadata)) {
      return false;
    }
    if (/\b(enabled|active|on|checked|disable character|disable)\b/.test(metadata)) {
      return true;
    }

    return characterEnabledMemory[index] ?? true;
  }

  function getCharacterDeleteButtonCandidatesFromRoot(root) {
    if (!root) {
      return [];
    }

    const body = root.children?.[1] || root;
    const metadataMatchesDelete = (button) => /\b(delete|remove|trash)\b/i.test(getButtonMetadata(button));
    const isUsableButton = (button) => (
      button instanceof HTMLButtonElement
      && hasRenderedBox(button, { minWidth: 1, minHeight: 1 })
      && !button.disabled
    );
    const bodyButtons = Array.from(body.querySelectorAll("button")).filter(isUsableButton);
    const rootRect = root.getBoundingClientRect();
    const bodyRect = body instanceof Element ? body.getBoundingClientRect() : rootRect;
    const iconButtons = bodyButtons
      .filter((button) => !normalizeButtonText(button))
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width <= 36 && rect.height <= 36;
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        const score = (rect) => {
          let value = 0;
          if (rect.left >= rootRect.left + (rootRect.width * 0.55)) {
            value += 8;
          }
          if (rect.left >= rootRect.right - 80) {
            value += 6;
          }
          if (rect.top <= bodyRect.top + 72) {
            value += 4;
          }
          if (rect.width <= 24 && rect.height <= 24) {
            value += 2;
          }
          return value;
        };
        return score(bRect) - score(aRect) || aRect.top - bRect.top || bRect.left - aRect.left;
      });

    const candidates = [];
    const addCandidate = (button) => {
      if (button && !candidates.includes(button)) {
        candidates.push(button);
      }
    };

    bodyButtons.filter(metadataMatchesDelete).forEach(addCandidate);
    iconButtons.forEach(addCandidate);
    return candidates;
  }

  function getCharacterDeleteButtonFromRoot(root) {
    return getCharacterDeleteButtonCandidatesFromRoot(root)[0] || null;
  }

  function getCharacterDeleteButtonCandidates(index) {
    const character = getCharacterScanByIndex(index);
    if (!character) {
      return [];
    }
    return getCharacterDeleteButtonCandidatesFromRoot(character.root);
  }

  function getCharacterDeleteButton(index) {
    return getCharacterDeleteButtonCandidates(index)[0] || null;
  }

  function getCharacterEnabledToggleButton(index) {
    const character = getCharacterScanByIndex(index);
    return character?.enabledToggleButton || getCharacterEnabledToggleButtonFromRoot(character?.root);
  }

  function getNovelAiCharacterActionFromButton(root, button) {
    if (!root || !button) {
      return null;
    }
    if (getCharacterDeleteButtonCandidatesFromRoot(root).includes(button)) {
      return "delete";
    }
    const actionButtons = getCharacterActionButtons(root);
    if (button === actionButtons[0]) {
      return "up";
    }
    if (button === actionButtons[1]) {
      return "down";
    }
    return null;
  }

  function scanMainPromptSlots() {
    const root = Array.from(document.querySelectorAll(".image-gen-prompt-main"))
      .filter(isVisible)[0] || null;
    const main = {
      root,
      base: { editor: null, tabButton: null },
      uc: { editor: null, tabButton: null },
    };

    if (!root) {
      return main;
    }

    main.base.tabButton = findButtonByText(root, (text) => /^(Base\s+)?Prompt$/i.test(text));
    main.uc.tabButton = findButtonByText(root, (text) => /^Undesired Content$/i.test(text));

    const visibleEditors = Array.from(root.querySelectorAll("[contenteditable]"))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.isContentEditable)
      .filter(isVisible);

    for (const editor of visibleEditors) {
      const wrapper = editor.closest(".prompt-input-box-base-prompt, .prompt-input-box-prompt, .prompt-input-box-undesired-content");
      const className = String(wrapper?.className || "");
      if (className.includes("undesired-content")) {
        main.uc.editor = editor;
      } else if (className.includes("base-prompt") || className.includes("prompt-input-box-prompt")) {
        main.base.editor = editor;
      }
    }

    return main;
  }

  function getCharacterIndexFromBlock(block) {
    const match = String(block?.className || "").match(/character-prompt-input-(\d+)/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  function scanCharacterPromptSlots() {
    const seen = new Set();
    const characters = [];
    const blocks = Array.from(document.querySelectorAll(".character-prompt-input"))
      .filter((block) => block instanceof HTMLElement)
      .filter(isVisible)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.top - bRect.top || aRect.left - bRect.left;
      });

    for (const root of blocks) {
      const index = getCharacterIndexFromBlock(root);
      if (!index || seen.has(index)) {
        continue;
      }
      seen.add(index);

      const promptTab = findButtonByText(root, (text) => /^Prompt$/i.test(text));
      const ucTab = findButtonByText(root, (text) => /^Undesired Content$/i.test(text));
      const activeEditor = getVisibleEditorIn(root);
      const enabledToggleButton = getCharacterEnabledToggleButtonFromRoot(root);
      const enabled = readCharacterEnabledState(root, index, enabledToggleButton);
      characterEnabledMemory[index] = enabled;

      characters.push({
        index,
        root,
        bodyToggle: findCharacterBodyToggle(root),
        activeEditor,
        enabled,
        enabledToggleButton,
        prompt: { tabButton: promptTab, editor: null },
        uc: { tabButton: ucTab, editor: null },
      });
    }

    return characters.sort((a, b) => a.index - b.index);
  }

  function scanNovelAiPromptSlots() {
    const scan = {
      main: scanMainPromptSlots(),
      characters: scanCharacterPromptSlots(),
    };

    if (scan.characters.length > 0) {
      hasObservedCharacterDom = true;
    }

    ensureSlot(MAIN_BASE_SLOT_ID);
    ensureSlot(MAIN_UC_SLOT_ID);
    for (const character of scan.characters) {
      ensureSlot(makeCharacterSlotId(character.index, "prompt"));
      ensureSlot(makeCharacterSlotId(character.index, "uc"));
    }

    return scan;
  }

  function getCharacterIndexData(index) {
    return {
      label: getExplicitCharacterLabel(index),
      prompt: cloneSlotData(makeCharacterSlotId(index, "prompt"), selectorState.slots[makeCharacterSlotId(index, "prompt")]),
      uc: cloneSlotData(makeCharacterSlotId(index, "uc"), selectorState.slots[makeCharacterSlotId(index, "uc")]),
    };
  }

  function setCharacterIndexData(index, data) {
    selectorState.slots[makeCharacterSlotId(index, "prompt")] = cloneSlotData(makeCharacterSlotId(index, "prompt"), data?.prompt);
    selectorState.slots[makeCharacterSlotId(index, "uc")] = cloneSlotData(makeCharacterSlotId(index, "uc"), data?.uc);
    copyExplicitCharacterLabel(index, data?.label || "");
  }

  function collectKnownCharacterIndices(characters = []) {
    const indices = new Set(characters.map((character) => character.index));
    for (const slotId of Object.keys(selectorState.slots || {})) {
      const parsed = parseSlotId(slotId);
      if (parsed?.scope === "character") {
        indices.add(parsed.index);
      }
    }
    for (const index of Object.keys(selectorState.characterLabels || {})) {
      const numericIndex = Number.parseInt(index, 10);
      if (Number.isFinite(numericIndex) && numericIndex > 0) {
        indices.add(numericIndex);
      }
    }
    return [...indices].sort((a, b) => a - b);
  }

  function refreshCharacterRootState(characters) {
    for (const character of characters) {
      characterRootState.set(character.root, {
        index: character.index,
      });
    }
  }

  function suppressCharacterReconcile(ms = 1200) {
    suppressCharacterReconcileUntil = Date.now() + ms;
  }

  function suppressCharacterActionTracking(ms = 1200) {
    suppressCharacterActionTrackingUntil = Date.now() + ms;
  }

  function reconcileCharacterIndexState(characters) {
    if (!characters.length) {
      return false;
    }
    const mappings = [];
    for (const character of characters) {
      const previous = characterRootState.get(character.root);
      if (
        previous
        && Number.isFinite(previous.index)
        && previous.index > 0
        && previous.index !== character.index
      ) {
        mappings.push({
          from: previous.index,
          to: character.index,
        });
      }
    }

    if (!mappings.length || Date.now() < suppressCharacterReconcileUntil) {
      refreshCharacterRootState(characters);
      return false;
    }

    const before = {};
    for (const index of collectKnownCharacterIndices(characters)) {
      before[index] = getCharacterIndexData(index);
    }

    for (const { from, to } of mappings) {
      if (before[from]) {
        setCharacterIndexData(to, before[from]);
      }
    }

    refreshCharacterRootState(characters);
    return true;
  }

  function getCurrentDomSlotIds(scan = scanNovelAiPromptSlots()) {
    const slotIds = new Set([MAIN_BASE_SLOT_ID, MAIN_UC_SLOT_ID]);
    for (const character of scan.characters) {
      slotIds.add(makeCharacterSlotId(character.index, "prompt"));
      slotIds.add(makeCharacterSlotId(character.index, "uc"));
    }
    return slotIds;
  }

  function hasStoredCharacterSlots() {
    return Object.keys(selectorState.slots).some((slotId) => parseSlotId(slotId)?.scope === "character");
  }

  function canPruneMissingCharacters(scan, { forcePruneMissingCharacters = false } = {}) {
    return Core.canPruneMissingCharacterSlots({
      forcePruneMissingCharacters,
      hasStoredCharacterSlots: hasStoredCharacterSlots(),
      hasPromptMain: Boolean(scan.main.root),
      currentCharacterCount: scan.characters.length,
      hasObservedCharacterDom,
    });
  }

  function syncSlotsWithDom({ pruneMissingCharacters = false, forcePruneMissingCharacters = false } = {}) {
    const scan = scanNovelAiPromptSlots();
    const reconciledCharacters = reconcileCharacterIndexState(scan.characters);
    const currentSlotIds = getCurrentDomSlotIds(scan);
    const shouldPruneMissingCharacters = (pruneMissingCharacters || reconciledCharacters)
      && canPruneMissingCharacters(scan, { forcePruneMissingCharacters });

    for (const slotId of currentSlotIds) {
      ensureSlot(slotId);
    }

    if (shouldPruneMissingCharacters) {
      for (const slotId of Object.keys(selectorState.slots)) {
        const parsed = parseSlotId(slotId);
        if (parsed?.scope === "character" && !currentSlotIds.has(slotId)) {
          delete selectorState.slots[slotId];
        }
      }
      const activeIndices = new Set(scan.characters.map((character) => character.index));
      for (const labelIndex of Object.keys(selectorState.characterLabels || {})) {
        const numericIndex = Number.parseInt(labelIndex, 10);
        if (!activeIndices.has(numericIndex)) {
          delete selectorState.characterLabels[labelIndex];
        }
      }
    }

    if (!currentSlotIds.has(selectorState.activeSlotId)) {
      const activeSlot = parseSlotId(selectorState.activeSlotId);
      if (activeSlot?.scope !== "character" || shouldPruneMissingCharacters) {
        selectorState.activeSlotId = MAIN_BASE_SLOT_ID;
      }
    }

    if (reconciledCharacters) {
      void saveSelectorState();
    }

    return { scan, currentSlotIds, prunedMissingCharacters: shouldPruneMissingCharacters };
  }

  function getKnownSlotIds() {
    const { currentSlotIds } = syncSlotsWithDom();
    return [...currentSlotIds].filter((slotId) => parseSlotId(slotId)).sort(compareSlotIds);
  }

  function getCurrentCharacterIndices(scan = scanNovelAiPromptSlots()) {
    return scan.characters.map((character) => character.index).sort((a, b) => a - b);
  }

  function getSelectedCharacterIndex(scan = scanNovelAiPromptSlots()) {
    const indices = getCurrentCharacterIndices(scan);
    if (!indices.length) {
      const activeSlot = parseSlotId(getActiveSlotId());
      if (activeSlot?.scope === "character") {
        selectorState.activeCharacterIndex = activeSlot.index;
        return activeSlot.index;
      }
      return selectorState.activeCharacterIndex || null;
    }

    const activeSlot = parseSlotId(getActiveSlotId());
    if (activeSlot?.scope === "character" && indices.includes(activeSlot.index)) {
      selectorState.activeCharacterIndex = activeSlot.index;
      return activeSlot.index;
    }

    if (indices.includes(selectorState.activeCharacterIndex)) {
      return selectorState.activeCharacterIndex;
    }

    selectorState.activeCharacterIndex = indices[0];
    return selectorState.activeCharacterIndex;
  }

  function setSelectedCharacterIndex(index, { selectPromptSlot = false } = {}) {
    const numericIndex = Number(index);
    if (!Number.isFinite(numericIndex) || numericIndex < 1) {
      selectorState.activeCharacterIndex = null;
      return;
    }

    selectorState.activeCharacterIndex = numericIndex;
    if (selectPromptSlot) {
      const activeParsed = parseSlotId(getActiveSlotId());
      const kind = activeParsed?.scope === "character" ? activeParsed.kind : "prompt";
      selectorState.activeSlotId = makeCharacterSlotId(numericIndex, kind);
      ensureSlot(selectorState.activeSlotId);
    }
  }

  function swapCharacterSlotPairs(leftIndex, rightIndex) {
    for (const kind of ["prompt", "uc"]) {
      const leftSlotId = makeCharacterSlotId(leftIndex, kind);
      const rightSlotId = makeCharacterSlotId(rightIndex, kind);
      const leftData = cloneSlotData(leftSlotId, selectorState.slots[leftSlotId]);
      const rightData = cloneSlotData(rightSlotId, selectorState.slots[rightSlotId]);
      selectorState.slots[leftSlotId] = cloneSlotData(leftSlotId, rightData);
      selectorState.slots[rightSlotId] = cloneSlotData(rightSlotId, leftData);
    }
  }

  function removeCharacterSlotPair(index) {
    delete selectorState.slots[makeCharacterSlotId(index, "prompt")];
    delete selectorState.slots[makeCharacterSlotId(index, "uc")];
  }

  function shiftCharacterSlotPairsAfterDelete(deletedIndex, previousMaxIndex) {
    for (let index = deletedIndex; index < previousMaxIndex; index += 1) {
      for (const kind of ["prompt", "uc"]) {
        const currentSlotId = makeCharacterSlotId(index, kind);
        const nextSlotId = makeCharacterSlotId(index + 1, kind);
        selectorState.slots[currentSlotId] = cloneSlotData(currentSlotId, selectorState.slots[nextSlotId]);
      }
    }
    removeCharacterSlotPair(previousMaxIndex);
    shiftCharacterLabelsAfterDelete(deletedIndex, previousMaxIndex);

    const activeParsed = parseSlotId(getActiveSlotId());
    if (activeParsed?.scope === "character") {
      if (activeParsed.index === deletedIndex) {
        selectorState.activeSlotId = deletedIndex < previousMaxIndex
          ? makeCharacterSlotId(deletedIndex, activeParsed.kind)
          : MAIN_BASE_SLOT_ID;
      } else if (activeParsed.index > deletedIndex) {
        selectorState.activeSlotId = makeCharacterSlotId(activeParsed.index - 1, activeParsed.kind);
      }
    }
  }

  async function getMainEditorForKind(kind) {
    let scan = scanNovelAiPromptSlots();
    let slot = scan.main[kind];
    if (slot?.editor) {
      return slot.editor;
    }
    if (slot?.tabButton) {
      slot.tabButton.click();
      await delay(120);
      scan = scanNovelAiPromptSlots();
      slot = scan.main[kind];
      if (slot?.editor) {
        return slot.editor;
      }
    }
    return null;
  }

  function getCharacterScanByIndex(index) {
    return scanNovelAiPromptSlots().characters.find((character) => character.index === index) || null;
  }

  async function ensureCharacterTabsVisible(index) {
    let character = getCharacterScanByIndex(index);
    if (!character) {
      return null;
    }
    if (character.prompt.tabButton && character.uc.tabButton) {
      return character;
    }

    const bodyToggle = character.bodyToggle || findCharacterBodyToggle(character.root);
    if (bodyToggle) {
      bodyToggle.click();
    } else {
      character.root.click();
    }
    await delay(180);
    character = getCharacterScanByIndex(index);
    if (character?.prompt.tabButton && character?.uc.tabButton) {
      return character;
    }

    return character;
  }

  async function getCharacterEditorForKind(index, kind) {
    let character = await ensureCharacterTabsVisible(index);
    if (!character) {
      return null;
    }

    const target = character[kind];
    if (!target?.tabButton) {
      return null;
    }

    target.tabButton.click();
    await delay(120);
    character = getCharacterScanByIndex(index);
    return character?.activeEditor || null;
  }

  async function applySlotToNovelAi(slotId, { skipEmpty = false, silent = false } = {}) {
    const parsed = parseSlotId(slotId);
    if (!parsed) {
      return { ok: false, error: `알 수 없는 슬롯입니다: ${slotId}` };
    }

    const prompt = buildSlotPrompt(slotId);
    if (!prompt.trim()) {
      if (skipEmpty) {
        return { ok: true, skipped: true, reason: "empty" };
      }
      const message = `${getSlotLabel(slotId)} 슬롯에 적용할 프롬프트가 없습니다.`;
      if (!silent) {
        setStatus(message, "warn");
      }
      return { ok: false, error: message };
    }

    let editor = null;
    if (parsed.scope === "main") {
      editor = await getMainEditorForKind(parsed.kind);
    } else if (parsed.scope === "character") {
      editor = await getCharacterEditorForKind(parsed.index, parsed.kind);
    }

    if (!editor) {
      const message = `${getSlotLabel(slotId)}에 대응하는 NovelAI 입력 영역을 찾지 못했습니다.`;
      if (!silent) {
        setStatus(message, "warn");
      }
      return { ok: false, error: message, missing: true };
    }

    setEditablePlainText(editor, prompt);
    if (!silent) {
      setStatus(`${getSlotLabel(slotId)} 슬롯을 NovelAI에 적용했습니다.`, "ok");
    }
    return { ok: true, prompt };
  }

  async function applyActiveSlotToNovelAi({ silent = false } = {}) {
    ensurePanel();
    return applySlotToNovelAi(getActiveSlotId(), { skipEmpty: false, silent });
  }

  async function applyAllSlotsToNovelAi({ silent = false } = {}) {
    ensurePanel();
    const scan = scanNovelAiPromptSlots();
    const slotIds = [
      MAIN_BASE_SLOT_ID,
      MAIN_UC_SLOT_ID,
      ...scan.characters.flatMap((character) => [
        makeCharacterSlotId(character.index, "prompt"),
        makeCharacterSlotId(character.index, "uc"),
      ]),
    ];

    let appliedCount = 0;
    const errors = [];
    for (const slotId of slotIds) {
      const result = await applySlotToNovelAi(slotId, { skipEmpty: true, silent: true });
      if (result.ok && !result.skipped) {
        appliedCount += 1;
      } else if (!result.ok && !result.missing) {
        errors.push(result.error);
      }
    }

    if (appliedCount > 0) {
      setStatus(`총 ${appliedCount}개 슬롯을 NovelAI에 적용했습니다.`, "ok");
      return { ok: true, appliedCount };
    }

    const message = errors[0] || "적용할 슬롯 프롬프트가 없습니다.";
    if (!silent) {
    setStatus(message, "warn");
    }
    return { ok: false, error: message, appliedCount };
  }

  async function addNovelAiCharacter(kind = "Female") {
    ensurePanel();
    const addButton = findAddCharacterButton();
    if (!addButton) {
      const message = "Add Character 버튼을 찾지 못했습니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }

    const beforeIndices = getCurrentCharacterIndices();
    addButton.click();
    await delay(160);

    const optionButton = findButtonByText(document, (text) => text.toLowerCase() === String(kind).toLowerCase());
    if (!optionButton) {
      const message = `${kind} 캐릭터 선택 버튼을 찾지 못했습니다.`;
      setStatus(message, "warn");
      return { ok: false, error: message };
    }

    optionButton.click();
    suppressCharacterReconcile();
    await delay(500);
    const afterIndices = getCurrentCharacterIndices();
    const newIndex = afterIndices.find((index) => !beforeIndices.includes(index)) || afterIndices[afterIndices.length - 1] || null;

    syncSlotsWithDom({ pruneMissingCharacters: true });
    if (newIndex) {
      setSelectedCharacterIndex(newIndex, { selectPromptSlot: true });
      selectorState.activePanelTab = getCharacterPanelTabId(newIndex);
      pendingDeleteCharacterIndex = null;
    }
    await saveSelectorState();
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
    setStatus(`Character ${newIndex || ""}를 추가했습니다.`, "ok");
    return { ok: true, characterIndex: newIndex };
  }

  async function moveNovelAiCharacter(direction) {
    ensurePanel();
    const scan = scanNovelAiPromptSlots();
    const indices = getCurrentCharacterIndices(scan);
    const selectedIndex = getSelectedCharacterIndex(scan);
    if (!selectedIndex || !indices.includes(selectedIndex)) {
      const message = "이동할 캐릭터가 없습니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }

    const nextIndex = selectedIndex + (direction === "up" ? -1 : 1);
    if (!indices.includes(nextIndex)) {
      const message = direction === "up" ? "이미 첫 번째 캐릭터입니다." : "이미 마지막 캐릭터입니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }

    const actionButton = getCharacterActionButton(selectedIndex, direction);
    if (!actionButton) {
      const message = "NovelAI의 캐릭터 이동 버튼을 찾지 못했습니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }

    suppressCharacterActionTracking();
    actionButton.click();
    suppressCharacterReconcile();
    swapCharacterSlotPairs(selectedIndex, nextIndex);
    swapCharacterLabels(selectedIndex, nextIndex);
    const activeParsed = parseSlotId(getActiveSlotId());
    if (activeParsed?.scope === "character" && activeParsed.index === selectedIndex) {
      selectorState.activeSlotId = makeCharacterSlotId(nextIndex, activeParsed.kind);
    }
    setSelectedCharacterIndex(nextIndex);
    selectorState.activePanelTab = getCharacterPanelTabId(nextIndex);
    await delay(350);
    syncSlotsWithDom();
    await saveSelectorState();
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
    setStatus(`Character ${selectedIndex}를 ${direction === "up" ? "위로" : "아래로"} 이동했습니다.`, "ok");
    return { ok: true, from: selectedIndex, to: nextIndex };
  }

  async function clickNovelAiCharacterDelete(index, previousCount) {
    let candidates = getCharacterDeleteButtonCandidates(index);
    if (!candidates.length) {
      await ensureCharacterTabsVisible(index);
      candidates = getCharacterDeleteButtonCandidates(index);
    }

    if (!candidates.length) {
      return { ok: false, missing: true };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tried = new Set();
      for (const button of candidates) {
        if (
          tried.has(button)
          || !button.isConnected
          || button.disabled
          || !hasRenderedBox(button, { minWidth: 1, minHeight: 1 })
        ) {
          continue;
        }
        tried.add(button);
        suppressCharacterActionTracking();
        button.click();
        suppressCharacterReconcile();
        await delay(550);
        if (getCurrentCharacterIndices().length < previousCount) {
          return { ok: true, button };
        }
      }

      await ensureCharacterTabsVisible(index);
      candidates = getCharacterDeleteButtonCandidates(index);
      if (!candidates.length) {
        break;
      }
    }

    return { ok: false, missing: false };
  }

  async function deleteNovelAiCharacter() {
    ensurePanel();
    const scan = scanNovelAiPromptSlots();
    const indices = getCurrentCharacterIndices(scan);
    const selectedIndex = getActiveCharacterIndexFromPanelTab() || getSelectedCharacterIndex(scan);
    if (!selectedIndex || !indices.includes(selectedIndex)) {
      const message = "삭제할 캐릭터가 없습니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }

    const previousMaxIndex = Math.max(...indices);
    const previousCount = indices.length;
    const deleteResult = await clickNovelAiCharacterDelete(selectedIndex, previousCount);
    if (!deleteResult.ok && deleteResult.missing) {
      const message = "NovelAI의 캐릭터 삭제 버튼을 찾지 못했습니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }
    const afterIndices = getCurrentCharacterIndices();
    if (!deleteResult.ok || afterIndices.length >= previousCount) {
      const message = "캐릭터 삭제 버튼을 눌렀지만 NovelAI의 캐릭터 수가 변하지 않았습니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }

    shiftCharacterSlotPairsAfterDelete(selectedIndex, previousMaxIndex);
    syncSlotsWithDom({ pruneMissingCharacters: true, forcePruneMissingCharacters: true });
    const nextTarget = Math.min(selectedIndex, Math.max(...afterIndices, 0));
    if (nextTarget > 0) {
      setSelectedCharacterIndex(nextTarget, { selectPromptSlot: true });
      selectorState.activePanelTab = getCharacterPanelTabId(nextTarget);
    } else {
      selectorState.activeCharacterIndex = null;
      selectorState.activeSlotId = MAIN_BASE_SLOT_ID;
      selectorState.activePanelTab = "main";
    }
    pendingDeleteCharacterIndex = null;
    await saveSelectorState();
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
    setStatus(`Character ${selectedIndex}를 삭제했습니다.`, "ok");
    return { ok: true, deletedIndex: selectedIndex };
  }

  async function toggleNovelAiCharacterEnabled(index = getActiveCharacterIndexFromPanelTab()) {
    ensurePanel();
    const numericIndex = Number.parseInt(index, 10);
    if (!Number.isFinite(numericIndex) || numericIndex < 1) {
      const message = "활성화 상태를 바꿀 캐릭터가 없습니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }

    const beforeCharacter = getCharacterScanByIndex(numericIndex);
    const toggleButton = beforeCharacter?.enabledToggleButton || getCharacterEnabledToggleButton(numericIndex);
    if (!toggleButton || toggleButton.disabled) {
      const message = "NovelAI의 캐릭터 활성화 버튼을 찾지 못했습니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }

    const previousEnabled = beforeCharacter?.enabled !== false;
    toggleButton.click();
    characterEnabledMemory[numericIndex] = !previousEnabled;
    await delay(220);

    const afterCharacter = getCharacterScanByIndex(numericIndex);
    const nextEnabled = afterCharacter?.enabled ?? characterEnabledMemory[numericIndex];
    characterEnabledMemory[numericIndex] = nextEnabled;
    renderSlotButtons();
    setStatus(`${getCharacterLabel(numericIndex)} ${nextEnabled ? "활성화" : "비활성화"} 상태입니다.`, "ok");
    return { ok: true, enabled: nextEnabled };
  }

  function updateActiveCharacterAfterDelete(deletedIndex, previousMaxIndex, afterIndices) {
    const nextTarget = Math.min(deletedIndex, Math.max(...afterIndices, 0));
    if (nextTarget > 0) {
      setSelectedCharacterIndex(nextTarget, { selectPromptSlot: true });
      selectorState.activePanelTab = getCharacterPanelTabId(nextTarget);
    } else {
      selectorState.activeCharacterIndex = null;
      selectorState.activeSlotId = MAIN_BASE_SLOT_ID;
      selectorState.activePanelTab = "main";
    }

    const activeParsed = parseSlotId(getActiveSlotId());
    if (activeParsed?.scope === "character" && activeParsed.index > previousMaxIndex) {
      selectorState.activeSlotId = MAIN_BASE_SLOT_ID;
    }
  }

  function refreshAfterExternalCharacterAction(message) {
    suppressCharacterReconcile();
    syncSlotsWithDom({ pruneMissingCharacters: true, forcePruneMissingCharacters: true });
    void saveSelectorState();
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
    if (message) {
      setStatus(message, "ok");
    }
  }

  function scheduleExternalCharacterDelete(index, previousMaxIndex, previousCount) {
    const deletedLabel = getCharacterLabel(index);
    window.setTimeout(() => {
      const afterIndices = getCurrentCharacterIndices();
      if (afterIndices.length >= previousCount) {
        return;
      }
      shiftCharacterSlotPairsAfterDelete(index, previousMaxIndex);
      updateActiveCharacterAfterDelete(index, previousMaxIndex, afterIndices);
      pendingDeleteCharacterIndex = null;
      refreshAfterExternalCharacterAction(`웹페이지에서 삭제된 ${deletedLabel} 상태를 동기화했습니다.`);
    }, 650);
  }

  function scheduleExternalCharacterMove(index, direction, indices) {
    const nextIndex = index + (direction === "up" ? -1 : 1);
    if (!indices.includes(nextIndex)) {
      return;
    }
    window.setTimeout(() => {
      const afterIndices = getCurrentCharacterIndices();
      if (!afterIndices.includes(index) || !afterIndices.includes(nextIndex)) {
        return;
      }
      swapCharacterSlotPairs(index, nextIndex);
      swapCharacterLabels(index, nextIndex);
      const activeParsed = parseSlotId(getActiveSlotId());
      if (activeParsed?.scope === "character" && activeParsed.index === index) {
        selectorState.activeSlotId = makeCharacterSlotId(nextIndex, activeParsed.kind);
        selectorState.activePanelTab = getCharacterPanelTabId(nextIndex);
        setSelectedCharacterIndex(nextIndex);
      }
      refreshAfterExternalCharacterAction("웹페이지의 캐릭터 순서 변경을 동기화했습니다.");
    }, 420);
  }

  function trackNovelAiCharacterActionClick(event) {
    if (Date.now() < suppressCharacterActionTrackingUntil) {
      return;
    }
    const button = event.target?.closest?.("button");
    const root = button?.closest?.(".character-prompt-input");
    if (!button || !root || root.closest("#nai-prompt-selector-host")) {
      return;
    }
    const index = getCharacterIndexFromBlock(root);
    if (!index) {
      return;
    }
    const action = getNovelAiCharacterActionFromButton(root, button);
    if (!action) {
      return;
    }
    const indices = getCurrentCharacterIndices();
    const previousMaxIndex = Math.max(...indices, 0);
    const previousCount = indices.length;
    if (action === "delete") {
      scheduleExternalCharacterDelete(index, previousMaxIndex, previousCount);
    } else {
      scheduleExternalCharacterMove(index, action, indices);
    }
  }

  function checkUndesiredContent() {
    return "";
  }

  function checkGenerationCost() {
    const genButton = findGenerateButton();
    if (!genButton) {
      return "";
    }

    const costElement = genButton.querySelector(".sc-1ef8cd01-4 span");
    const costText = (costElement?.textContent || "").trim()
      || (genButton.textContent || "").match(/(\d+)\s*Anlas/i)?.[1]
      || "";
    const numericCost = Number.parseInt(costText, 10);
    if (Number.isFinite(numericCost) && numericCost > 0) {
      return `경고: 생성 비용이 ${numericCost} Anlas입니다. 비용이 0이 아니면 자동 생성을 시작하지 않습니다.`;
    }
    return "";
  }

  function runSafetyChecks({ alertUser = true } = {}) {
    if (!location.href.startsWith("https://novelai.net/image")) {
      const message = "NovelAI 이미지 페이지에서만 사용할 수 있습니다.";
      setStatus(message, "warn");
      if (alertUser) {
        alert(message);
      }
      return false;
    }

    const warning = checkUndesiredContent() || checkGenerationCost();
    if (warning) {
      setStatus(warning, "warn");
      if (alertUser) {
        alert(warning);
      }
      return false;
    }

    return true;
  }

  function escapeHTML(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function plainTextToHTML(text) {
    return String(text).split(/\r?\n/).map((line) => {
      if (!line) {
        return '<p><br class="ProseMirror-trailingBreak"></p>';
      }
      return `<p>${escapeHTML(line)}</p>`;
    }).join("");
  }

  function htmlToPlainText(html) {
    const container = document.createElement("div");
    container.innerHTML = html || "";
    const lines = [];
    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        lines.push(child.textContent || "");
      } else if (child.nodeType === Node.TEXT_NODE) {
        lines.push(child.textContent || "");
      }
    }
    return lines.join("\n").trim();
  }

  function setEditablePlainText(editor, value) {
    editor.focus();
    editor.innerHTML = plainTextToHTML(value);
    try {
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value,
      }));
    } catch (error) {
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getBasePromptText() {
    const mainBasePrompt = buildSlotPrompt(MAIN_BASE_SLOT_ID);
    if (mainBasePrompt.trim()) {
      return mainBasePrompt;
    }
    const scan = scanNovelAiPromptSlots();
    const editor = scan.main.base.editor || findPromptEditors()[0];
    return editor ? htmlToPlainText(editor.innerHTML) : "";
  }

  async function applySelectorPrompt({ silent = false } = {}) {
    return applyAllSlotsToNovelAi({ silent });
  }

  function findHistoryContainer() {
    return document.getElementById("historyContainer")
      || Array.from(document.querySelectorAll('[id*="history" i], [class*="history" i]')).find(isVisible)
      || null;
  }

  function findHistoryItems() {
    const container = findHistoryContainer();
    const root = container || document;
    const candidates = Array.from(root.querySelectorAll('div[role="button"][draggable="true"], div[role="button"], button, [draggable="true"]'))
      .filter((element) => element instanceof HTMLElement)
      .filter(isVisible)
      .filter((element) => element.querySelector("img"));

    const seen = new Set();
    const items = [];
    for (const candidate of candidates) {
      const key = candidate;
      if (!seen.has(key)) {
        seen.add(key);
        items.push(candidate);
      }
    }
    return items;
  }

  function findCurrentImage() {
    const images = Array.from(document.images)
      .filter(isVisible)
      .filter((image) => image.src && !image.src.startsWith("chrome-extension://"))
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
      });
    return images[0] || null;
  }

  function clearAllHighlights() {
    document.querySelectorAll(".nai-pm-highlight-marker").forEach((marker) => marker.remove());
    document.querySelectorAll(".nai-pm-history-highlight").forEach((item) => {
      item.classList.remove("nai-pm-history-highlight");
      if (item.dataset.naiPmOriginalPosition) {
        item.style.position = item.dataset.naiPmOriginalPosition === "static" ? "" : item.dataset.naiPmOriginalPosition;
        delete item.dataset.naiPmOriginalPosition;
      }
    });
  }

  function highlightRecentHistory(count) {
    clearAllHighlights();
    const items = findHistoryItems();
    for (let index = 0; index < count && index < items.length; index += 1) {
      const item = items[index];
      const computedStyle = window.getComputedStyle(item);
      if (computedStyle.position === "static") {
        item.dataset.naiPmOriginalPosition = "static";
        item.style.position = "relative";
      } else if (!item.dataset.naiPmOriginalPosition) {
        item.dataset.naiPmOriginalPosition = computedStyle.position;
      }

      const marker = document.createElement("div");
      marker.className = "nai-pm-highlight-marker";
      item.appendChild(marker);
      item.classList.add("nai-pm-history-highlight");
    }
  }

  function showCompletionOverlay(count) {
    document.getElementById("nai-pm-completion-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "nai-pm-completion-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "background:rgba(7,10,14,0.72)",
      "font-family:Arial,sans-serif",
    ].join(";");

    const dialog = document.createElement("div");
    dialog.style.cssText = [
      "width:min(360px,calc(100vw - 32px))",
      "background:#171b22",
      "color:#f4f7f8",
      "border:1px solid rgba(39,214,196,0.42)",
      "border-radius:8px",
      "box-shadow:0 18px 48px rgba(0,0,0,0.45)",
      "padding:24px",
      "text-align:center",
    ].join(";");

    const title = document.createElement("h2");
    title.textContent = "자동 생성 완료";
    title.style.cssText = "margin:0 0 10px;font-size:22px";

    const message = document.createElement("p");
    message.textContent = `총 ${count}장의 이미지 생성이 완료되었습니다.`;
    message.style.cssText = "margin:0 0 18px;color:#c9d2d4;font-size:14px";

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "확인";
    button.style.cssText = [
      "border:0",
      "border-radius:6px",
      "background:#27d6c4",
      "color:#061012",
      "font-weight:700",
      "padding:10px 18px",
      "cursor:pointer",
    ].join(";");
    button.addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        overlay.remove();
      }
    });

    dialog.append(title, message, button);
    overlay.append(dialog);
    document.body.append(overlay);
  }

  async function playSound(filename) {
    const { volume = 0.5 } = await storageGet("sync", ["volume"]);
    const audio = new Audio(chrome.runtime.getURL(`assets/${filename}`));
    audio.volume = Math.max(0, Math.min(1, Number(volume)));
    audio.play().catch(() => {});
  }

  async function maybeDownloadCurrentImage() {
    const { autoSaveEnabled = false } = await storageGet("sync", ["autoSaveEnabled"]);
    if (!autoSaveEnabled) {
      return;
    }

    const image = findCurrentImage();
    if (!image?.src) {
      setStatus("자동 저장할 현재 이미지를 찾지 못했습니다.", "warn");
      return;
    }

    chrome.runtime.sendMessage({
      action: "downloadImage",
      imageUrl: image.src,
      promptText: getBasePromptText().slice(0, 48),
    });
  }

  async function clickGenerate({ useSelector = false, silent = false } = {}) {
    if (!runSafetyChecks({ alertUser: !silent })) {
      return { ok: false, error: "Safety check failed." };
    }

    if (useSelector) {
      const applied = await applyAllSlotsToNovelAi({ silent });
      if (!applied.ok) {
        return applied;
      }
      await delay(120);
    }

    const button = findGenerateButton();
    if (!button) {
      const message = "Generate 버튼을 찾지 못했습니다.";
      setStatus(message, "warn");
      if (!silent) {
        alert(message);
      }
      return { ok: false, error: message };
    }
    if (button.disabled) {
      const message = "Generate 버튼이 아직 비활성화 상태입니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }

    clearAllHighlights();
    button.click();
    return { ok: true };
  }

  function waitForOneClickCompletion() {
    const startedAt = Date.now();
    let sawDisabled = false;
    const intervalId = setInterval(async () => {
      const button = findGenerateButton();
      if (button?.disabled) {
        sawDisabled = true;
      }
      if (sawDisabled && button && !button.disabled) {
        clearInterval(intervalId);
        await maybeDownloadCurrentImage();
        setStatus("1회 생성이 완료되었습니다.", "ok");
      }
      if (Date.now() - startedAt > ONE_CLICK_TIMEOUT_MS) {
        clearInterval(intervalId);
        setStatus("1회 생성 완료 대기 시간이 초과되었습니다.", "warn");
      }
    }, AUTO_REFRESH_MS);
  }

  async function generateOnce({ useSelector = false } = {}) {
    await playSound("start.mp3");
    const result = await clickGenerate({ useSelector });
    if (result.ok) {
      chrome.runtime.sendMessage({ action: "closePopup" });
      setStatus("1회 생성을 시작했습니다.", "ok");
      waitForOneClickCompletion();
    }
    return result;
  }

  function clearAutoTimers() {
    if (autoRun.timerId) {
      clearInterval(autoRun.timerId);
      autoRun.timerId = null;
    }
    if (autoRun.timeoutId) {
      clearTimeout(autoRun.timeoutId);
      autoRun.timeoutId = null;
    }
  }

  async function stopAutoGenerate({ playAudio = false } = {}) {
    const wasActive = autoRun.active;
    clearAutoTimers();
    autoRun.active = false;
    autoRun.waitingForCompletion = false;
    await storageSet("sync", { autoClickEnabled: false });
    renderAutoRunControls();
    if (playAudio && wasActive) {
      await playSound("stop.mp3");
    }
    setStatus(wasActive ? "자동 생성을 중지했습니다." : "자동 생성이 실행 중이 아닙니다.", wasActive ? "ok" : "warn");
    return { ok: true };
  }

  async function clickForAutoRun() {
    const result = await clickGenerate({ useSelector: autoRun.useSelector, silent: true });
    if (!result.ok) {
      return result;
    }
    autoRun.count += 1;
    autoRun.waitingForCompletion = true;
    autoRun.ignoreReadyUntil = Date.now() + 900;
    renderAutoRunControls();
    setStatus(`자동 생성 진행 중: ${autoRun.count}${autoRun.target ? ` / ${autoRun.target}` : ""}`, "ok");
    return result;
  }

  async function completeAutoRun() {
    const count = autoRun.completedCount || autoRun.count;
    clearAutoTimers();
    autoRun.active = false;
    autoRun.waitingForCompletion = false;
    await storageSet("sync", { autoClickEnabled: false });
    renderAutoRunControls();

    const waitForHistory = setInterval(() => {
      const currentCount = findHistoryItems().length;
      if (currentCount >= autoRun.initialHistoryCount + count) {
        clearInterval(waitForHistory);
        highlightRecentHistory(count);
      }
    }, 200);
    setTimeout(() => {
      clearInterval(waitForHistory);
      highlightRecentHistory(count);
    }, 10000);

    showCompletionOverlay(count);
    chrome.runtime.sendMessage({ action: "showCompletionNotification", count });
    setStatus(`자동 생성 완료: ${count}장`, "ok");
  }

  async function handleAutoProgress() {
    if (!autoRun.active || !autoRun.waitingForCompletion || Date.now() < autoRun.ignoreReadyUntil) {
      return;
    }

    const button = findGenerateButton();
    if (!button || button.disabled) {
      return;
    }

    autoRun.waitingForCompletion = false;
    await maybeDownloadCurrentImage();
    autoRun.completedCount = autoRun.count;
    renderAutoRunControls();

    if (autoRun.target > 0 && autoRun.count >= autoRun.target) {
      await completeAutoRun();
      return;
    }

    const { intervalTime = 3 } = await storageGet("sync", ["intervalTime"]);
    const intervalSeconds = Math.max(0.1, Number.parseFloat(intervalTime) || 3);
    autoRun.timeoutId = setTimeout(async () => {
      if (!autoRun.active) {
        return;
      }
      if (!runSafetyChecks({ alertUser: true })) {
        await stopAutoGenerate({ playAudio: true });
        chrome.runtime.sendMessage({ action: "resetPopupButtons" });
        return;
      }
      const result = await clickForAutoRun();
      if (!result.ok) {
        await stopAutoGenerate({ playAudio: true });
      }
    }, intervalSeconds * 1000);
  }

  async function startAutoGenerate({ useSelector = false } = {}) {
    if (!runSafetyChecks({ alertUser: true })) {
      return { ok: false, error: "Safety check failed." };
    }

    await stopAutoGenerate({ playAudio: false });
    const { gcount = "" } = await storageGet("sync", ["gcount"]);
    if (ui.countInput) {
      ui.countInput.value = gcount;
    }
    autoRun.active = true;
    autoRun.count = 0;
    autoRun.completedCount = 0;
    autoRun.target = Math.max(0, Number.parseInt(gcount, 10) || 0);
    autoRun.initialHistoryCount = findHistoryItems().length;
    autoRun.useSelector = Boolean(useSelector);
    autoRun.waitingForCompletion = false;
    autoRun.ignoreReadyUntil = 0;
    renderAutoRunControls();
    setPanelCollapsed(true);

    await storageSet("sync", { autoClickEnabled: true });
    await playSound("start.mp3");
    chrome.runtime.sendMessage({ action: "closePopup" });

    const result = await clickForAutoRun();
    if (!result.ok) {
      await stopAutoGenerate({ playAudio: true });
      return result;
    }

    autoRun.timerId = setInterval(() => {
      void handleAutoProgress();
    }, AUTO_REFRESH_MS);
    return { ok: true };
  }

  function setStatus(message, tone = "neutral") {
    if (!ui.status) {
      return;
    }
    ui.status.textContent = message || "";
    ui.status.dataset.tone = tone;
  }

  function getConfiguredAutoTarget() {
    if (autoRun.active) {
      return autoRun.target;
    }
    const rawCount = Number.parseInt(ui.countInput?.value, 10);
    return Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 0;
  }

  function formatAutoTarget(target) {
    return target > 0 ? String(target) : "∞";
  }

  function renderAutoRunControls() {
    const target = getConfiguredAutoTarget();
    const completedCount = Math.max(0, Number.parseInt(autoRun.completedCount, 10) || 0);
    if (ui.collapsedCount) {
      ui.collapsedCount.textContent = `${completedCount} / ${formatAutoTarget(target)}`;
    }
    if (ui.collapsedAutoButton) {
      ui.collapsedAutoButton.textContent = autoRun.active ? "중지" : "시작";
      ui.collapsedAutoButton.dataset.active = autoRun.active ? "true" : "false";
      ui.collapsedAutoButton.title = autoRun.active ? "자동 생성 중지" : "자동 생성 시작";
    }
    if (ui.autoButton) {
      ui.autoButton.textContent = autoRun.active ? "자동 생성 중지" : "자동 생성";
      ui.autoButton.dataset.active = autoRun.active ? "true" : "false";
    }
  }

  function renderPromptPreview() {
    if (!ui.preview) {
      return;
    }
    const prompt = buildCurrentPrompt();
    ui.preview.textContent = prompt || "No prompt selected.";
    ui.preview.classList.toggle("is-empty", !prompt);
    if (ui.copyButton) {
      ui.copyButton.disabled = !prompt;
    }
    if (ui.promptMeta) {
      const lines = prompt ? prompt.split(/\r?\n/).length : 0;
      ui.promptMeta.textContent = prompt ? `${prompt.length} chars / ${lines} lines` : "empty";
    }
  }

  function getPromptSelectionTargets(mode = "leading") {
    if (mode === "suffix") {
      return {
        groupList: ui.suffixGroupList,
        summary: ui.suffixSummary,
      };
    }
    return {
      groupList: ui.groupList,
      summary: ui.summary,
    };
  }

  function commitSelection(groupName, groupSelection, mode = "leading") {
    const slotId = getActiveSlotId();
    if (mode === "suffix" && slotId !== MAIN_BASE_SLOT_ID) {
      return;
    }
    const slotData = ensureSlot(slotId);
    const { groups, selectionState, weightMemoryState } = parseSlotSelectorState(slotId, mode);
    const nextSelectionState = { ...selectionState };
    const cleaned = {};

    for (const [item, weight] of Object.entries(groupSelection || {})) {
      const normalizedItem = Core.normalizePromptItem(item);
      if (normalizedItem) {
        cleaned[normalizedItem] = Core.normalizePromptWeight(weight);
      }
    }

    if (Object.keys(cleaned).length) {
      nextSelectionState[groupName] = cleaned;
    } else {
      delete nextSelectionState[groupName];
    }

    const normalized = Core.normalizeStoredPromptState(groups, nextSelectionState, weightMemoryState);
    if (mode === "suffix") {
      slotData.suffixSelectionState = JSON.stringify(normalized.selectionState);
      slotData.suffixWeightMemory = JSON.stringify(normalized.weightMemoryState);
    } else {
      slotData.selectionState = JSON.stringify(normalized.selectionState);
      slotData.weightMemory = JSON.stringify(normalized.weightMemoryState);
    }
    void saveSelectorState();
    renderPromptSelector();
  }

  function togglePromptSelection(groupName, item, mode = "leading") {
    const { selectionState, weightMemoryState } = parseSlotSelectorState(getActiveSlotId(), mode);
    const currentSelection = { ...(selectionState[groupName] || {}) };
    if (Object.prototype.hasOwnProperty.call(currentSelection, item)) {
      delete currentSelection[item];
    } else {
      currentSelection[item] = Core.getRememberedPromptWeight(weightMemoryState, groupName, item);
    }
    commitSelection(groupName, currentSelection, mode);
  }

  function adjustPromptWeight(groupName, item, delta, mode = "leading") {
    const { selectionState, weightMemoryState } = parseSlotSelectorState(getActiveSlotId(), mode);
    const currentSelection = { ...(selectionState[groupName] || {}) };
    const currentWeight = Object.prototype.hasOwnProperty.call(currentSelection, item)
      ? currentSelection[item]
      : Core.getRememberedPromptWeight(weightMemoryState, groupName, item);
    currentSelection[item] = Core.normalizePromptWeight(currentWeight + delta);
    commitSelection(groupName, currentSelection, mode);
  }

  function selectAllGroup(group, mode = "leading") {
    const { weightMemoryState } = parseSlotSelectorState(getActiveSlotId(), mode);
    const nextSelection = {};
    for (const item of group.items) {
      nextSelection[item] = Core.getRememberedPromptWeight(weightMemoryState, group.name, item);
    }
    commitSelection(group.name, nextSelection, mode);
  }

  function getPromptWeightTone(weight) {
    const normalizedWeight = Core.normalizePromptWeight(weight);
    if (normalizedWeight === Core.DEFAULT_PROMPT_WEIGHT) {
      return null;
    }

    const boosted = normalizedWeight > Core.DEFAULT_PROMPT_WEIGHT;
    const saturationLimit = boosted ? 2 : 0;
    const rawIntensity = boosted
      ? (Math.min(normalizedWeight, saturationLimit) - Core.DEFAULT_PROMPT_WEIGHT)
        / (saturationLimit - Core.DEFAULT_PROMPT_WEIGHT)
      : (Core.DEFAULT_PROMPT_WEIGHT - Math.max(normalizedWeight, saturationLimit))
        / (Core.DEFAULT_PROMPT_WEIGHT - saturationLimit);
    const intensity = Math.min(1, Math.max(0, rawIntensity));
    const baseSaturation = boosted ? 36 : 34;
    const maxSaturationGain = boosted ? 50 : 48;
    const hue = boosted ? 8 : 210;
    const saturation = Math.round(baseSaturation + (intensity * maxSaturationGain));
    const backgroundLightness = Math.round(23 + (intensity * 2));
    const borderLightness = Math.round(48 + (intensity * 8));
    const shadowAlpha = (0.12 + (intensity * 0.16)).toFixed(3);

    return {
      className: boosted ? "is-boosted" : "is-weakened",
      foreground: boosted ? "#fff7f5" : "#f3f9ff",
      weightColor: boosted ? "#ffd8d0" : "#d5ecff",
      hue,
      saturation: `${saturation}%`,
      backgroundLightness: `${backgroundLightness}%`,
      borderLightness: `${borderLightness}%`,
      shadowAlpha,
      background: `hsl(${hue}, ${saturation}%, ${backgroundLightness}%)`,
      borderColor: `hsla(${hue}, ${saturation}%, ${borderLightness}%, 0.88)`,
      shadowColor: `hsla(${hue}, ${saturation}%, 58%, ${shadowAlpha})`,
      shadowRing: `hsla(${hue}, ${saturation}%, 58%, 0.12)`,
      weightBackground: `hsla(${hue}, ${saturation}%, 11%, 0.46)`,
    };
  }

  function applyPromptWeightTone(chip, weight) {
    const tone = getPromptWeightTone(weight);
    if (!tone) {
      return null;
    }
    chip.classList.add(tone.className);
    chip.style.setProperty("--nps-chip-tone-saturation", tone.saturation);
    chip.style.setProperty("--nps-chip-tone-bg-lightness", tone.backgroundLightness);
    chip.style.setProperty("--nps-chip-tone-border-lightness", tone.borderLightness);
    chip.style.setProperty("--nps-chip-tone-shadow-alpha", tone.shadowAlpha);
    chip.style.background = tone.background;
    chip.style.borderColor = tone.borderColor;
    chip.style.color = tone.foreground;
    chip.style.boxShadow = `0 0 0 1px ${tone.shadowRing}, 0 0 14px ${tone.shadowColor}`;
    return tone;
  }

  function applyPromptWeightLabelTone(weightLabel, tone) {
    if (!tone) {
      return;
    }
    weightLabel.style.background = tone.weightBackground;
    weightLabel.style.color = tone.weightColor;
  }

  function renderPromptSelectionList(mode = "leading") {
    const { groupList, summary } = getPromptSelectionTargets(mode);
    if (!groupList) {
      return;
    }
    const isSuffix = mode === "suffix";
    const isBaseSlot = getActiveSlotId() === MAIN_BASE_SLOT_ID;
    if (isSuffix && ui.suffixSection) {
      ui.suffixSection.hidden = !isBaseSlot;
    }
    if (isSuffix && !isBaseSlot) {
      groupList.replaceChildren();
      if (summary) {
        summary.textContent = "Base only";
      }
      return;
    }

    const { groups, selectionState } = parseSlotSelectorState(getActiveSlotId(), mode);
    groupList.replaceChildren();
    if (summary) {
      summary.textContent = `${groups.length} group(s)`;
    }

    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "nps-empty";
      empty.textContent = "Group format example:\n\n[Quality]\nnewest\nbest quality\n\n[Character]\n1girl";
      groupList.append(empty);
      return;
    }

    for (const group of groups) {
      const groupSelection = selectionState[group.name] || {};
      const selectedCount = Object.keys(groupSelection).length;

      const section = document.createElement("section");
      section.className = "nps-group";

      const header = document.createElement("div");
      header.className = "nps-group-header";

      const titleWrap = document.createElement("div");
      const title = document.createElement("div");
      title.className = "nps-group-title";
      title.textContent = group.name;
      const meta = document.createElement("div");
      meta.className = "nps-group-meta";
      meta.textContent = `${selectedCount} selected / ${group.items.length}`;
      titleWrap.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "nps-group-actions";
      const selectAll = document.createElement("button");
      selectAll.type = "button";
      selectAll.textContent = "All";
      selectAll.addEventListener("click", () => selectAllGroup(group, mode));
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "Clear";
      clear.addEventListener("click", () => commitSelection(group.name, {}, mode));
      actions.append(selectAll, clear);

      header.append(titleWrap, actions);
      section.append(header);

      const chips = document.createElement("div");
      chips.className = "nps-chips";
      for (const item of group.items) {
        const selected = Object.prototype.hasOwnProperty.call(groupSelection, item);
        const weight = selected ? Core.normalizePromptWeight(groupSelection[item]) : Core.DEFAULT_PROMPT_WEIGHT;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "nps-chip";
        chip.classList.toggle("is-active", selected);
        const weightTone = selected ? applyPromptWeightTone(chip, weight) : null;
        chip.title = `Click: toggle, Ctrl + wheel: weight ${Core.formatPromptWeightValue(Core.MIN_PROMPT_WEIGHT)} to +${Core.formatPromptWeightValue(Core.MAX_PROMPT_WEIGHT)}`;
        chip.addEventListener("click", () => togglePromptSelection(group.name, item, mode));
        chip.addEventListener("wheel", (event) => {
          if (!event.ctrlKey) {
            return;
          }
          event.preventDefault();
          adjustPromptWeight(group.name, item, event.deltaY < 0 ? Core.PROMPT_WEIGHT_STEP : -Core.PROMPT_WEIGHT_STEP, mode);
        }, { passive: false });

        const label = document.createElement("span");
        label.className = "nps-chip-label";
        label.textContent = item;
        chip.append(label);

        if (selected && weight !== Core.DEFAULT_PROMPT_WEIGHT) {
          const weightLabel = document.createElement("span");
          weightLabel.className = "nps-chip-weight";
          weightLabel.textContent = Core.formatPromptWeightLabel(weight);
          applyPromptWeightLabelTone(weightLabel, weightTone);
          chip.append(weightLabel);
        }
        chips.append(chip);
      }

      section.append(chips);
      groupList.append(section);
    }
  }

  function renderPromptSelector() {
    renderPromptSelectionList("leading");
    renderPromptSelectionList("suffix");
    renderPromptPreview();
  }

  function syncEditorLineNumbersScroll() {
    if (!ui.editor || !ui.editorLineNumbers) {
      return;
    }
    ui.editorLineNumbers.scrollTop = ui.editor.scrollTop;
  }

  function measureEditorLineHeights(lines) {
    if (!ui.editor || !ui.editorLineMeasurer) {
      return lines.map(() => null);
    }

    ui.editorLineMeasurer.style.width = `${ui.editor.clientWidth}px`;
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = "nps-editor-measure-line";
      row.textContent = line || " ";
      fragment.append(row);
    }

    ui.editorLineMeasurer.replaceChildren(fragment);
    const editorStyle = getComputedStyle(ui.editor);
    const minLineHeight = Number.parseFloat(editorStyle.lineHeight) || 0;
    return Array.from(ui.editorLineMeasurer.children).map((row) => (
      Math.max(minLineHeight, row.getBoundingClientRect().height)
    ));
  }

  function renderEditorLineNumbers() {
    if (!ui.editor || !ui.editorLineNumbers) {
      return;
    }
    const lines = String(ui.editor.value || "").split(/\r\n|\r|\n/);
    const lineHeights = measureEditorLineHeights(lines);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = document.createElement("span");
      lineNumber.className = "nps-editor-line-number";
      lineNumber.textContent = String(index + 1);
      if (lineHeights[index]) {
        lineNumber.style.height = `${lineHeights[index]}px`;
      }
      fragment.append(lineNumber);
    }
    ui.editorLineNumbers.replaceChildren(fragment);
    syncEditorLineNumbersScroll();
  }

  function updateEditorFieldsFromActiveSlot() {
    if (!ui.editor || !ui.quickInput) {
      return;
    }
    const slotData = getActiveSlotData();
    ui.editor.value = slotData.groupsDefinition;
    ui.quickInput.value = slotData.quickPrompt;
    renderEditorLineNumbers();
    if (ui.activeSlotLabel) {
      ui.activeSlotLabel.textContent = getSlotLabel(getActiveSlotId());
    }
  }

  async function loadAutoSettingsIntoPanel() {
    if (!ui.intervalInput || !ui.countInput) {
      return;
    }
    const { intervalTime = 3, gcount = "" } = await storageGet("sync", ["intervalTime", "gcount"]);
    ui.intervalInput.value = intervalTime;
    ui.countInput.value = gcount;
    renderAutoRunControls();
  }

  function saveAutoSettingsFromPanel() {
    const intervalSeconds = Math.max(0.1, Number.parseFloat(ui.intervalInput?.value) || 3);
    const rawCount = Number.parseInt(ui.countInput?.value, 10);
    const count = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : "";
    if (ui.intervalInput) {
      ui.intervalInput.value = String(intervalSeconds);
    }
    if (ui.countInput) {
      ui.countInput.value = count;
    }
    renderAutoRunControls();
    return storageSet("sync", {
      intervalTime: intervalSeconds,
      gcount: count,
    });
  }

  function getActiveCharacterIndexFromPanelTab() {
    const panelTab = parsePanelTab(selectorState.activePanelTab);
    return panelTab?.kind === "character" ? panelTab.index : null;
  }

  function getValidPanelTab(indices = getCurrentCharacterIndices()) {
    const panelTab = parsePanelTab(selectorState.activePanelTab);
    if (!panelTab) {
      return "auto";
    }
    if (panelTab.kind !== "character") {
      return selectorState.activePanelTab;
    }
    if (indices.includes(panelTab.index)) {
      return selectorState.activePanelTab;
    }

    const activeSlot = parseSlotId(getActiveSlotId());
    if (activeSlot?.scope === "character" && indices.includes(activeSlot.index)) {
      return getCharacterPanelTabId(activeSlot.index);
    }
    return indices.length ? getCharacterPanelTabId(indices[0]) : "main";
  }

  function syncActiveSlotToPanelTab({ preferredKind = null } = {}) {
    const panelTab = parsePanelTab(selectorState.activePanelTab);
    if (!panelTab) {
      selectorState.activePanelTab = "auto";
      return;
    }
    if (panelTab.kind === "auto") {
      return;
    }
    if (panelTab.kind === "main") {
      const activeSlot = parseSlotId(getActiveSlotId());
      const kind = preferredKind || (activeSlot?.scope === "main" ? activeSlot.kind : "base");
      selectorState.activeSlotId = kind === "uc" ? MAIN_UC_SLOT_ID : MAIN_BASE_SLOT_ID;
      ensureSlot(selectorState.activeSlotId);
      return;
    }

    const activeSlot = parseSlotId(getActiveSlotId());
    const kind = preferredKind || (
      activeSlot?.scope === "character" && activeSlot.index === panelTab.index
        ? activeSlot.kind
        : "prompt"
    );
    setSelectedCharacterIndex(panelTab.index);
    selectorState.activeSlotId = makeCharacterSlotId(panelTab.index, kind === "uc" ? "uc" : "prompt");
    ensureSlot(selectorState.activeSlotId);
  }

  function setActivePanelTab(tabId, { preferredKind = null } = {}) {
    const normalizedTab = sanitizePanelTab(tabId);
    selectorState.activePanelTab = normalizedTab;
    pendingDeleteCharacterIndex = null;
    syncActiveSlotToPanelTab({ preferredKind });
    void saveSelectorState();
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
  }

  function setActiveSlotKind(kind) {
    const panelTab = parsePanelTab(selectorState.activePanelTab);
    if (panelTab?.kind === "main") {
      selectorState.activeSlotId = kind === "uc" ? MAIN_UC_SLOT_ID : MAIN_BASE_SLOT_ID;
    } else if (panelTab?.kind === "character") {
      selectorState.activeSlotId = makeCharacterSlotId(panelTab.index, kind === "uc" ? "uc" : "prompt");
      setSelectedCharacterIndex(panelTab.index);
    }
    ensureSlot(selectorState.activeSlotId);
    pendingDeleteCharacterIndex = null;
    void saveSelectorState();
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
  }

  function renderSlotModeTabs() {
    if (!ui.slotModeTabs) {
      return;
    }
    const panelTab = parsePanelTab(selectorState.activePanelTab);
    const activeSlot = parseSlotId(getActiveSlotId());
    const modes = panelTab?.kind === "character"
      ? [
          { kind: "prompt", label: "Prompt" },
          { kind: "uc", label: "UC" },
        ]
      : [
          { kind: "base", label: "Base Prompt" },
          { kind: "uc", label: "Main UC" },
        ];

    ui.slotModeTabs.replaceChildren();
    for (const mode of modes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nps-segment";
      button.textContent = mode.label;
      button.classList.toggle("is-active", activeSlot?.kind === mode.kind);
      button.addEventListener("click", () => setActiveSlotKind(mode.kind));
      ui.slotModeTabs.append(button);
    }
  }

  function renderActivePanelView() {
    const panelTab = parsePanelTab(selectorState.activePanelTab);
    const isAuto = panelTab?.kind === "auto";
    if (ui.autoView) {
      ui.autoView.hidden = !isAuto;
    }
    if (ui.editorView) {
      ui.editorView.hidden = isAuto;
    }
    if (ui.slotModeTitle) {
      ui.slotModeTitle.textContent = panelTab?.kind === "character"
        ? `${getCharacterLabel(panelTab.index)} 편집`
        : "Base / Main UC";
    }
    renderSlotModeTabs();
  }

  function renderCharacterControls() {
    const scan = scanNovelAiPromptSlots();
    const indices = getCurrentCharacterIndices(scan);
    const panelCharacterIndex = getActiveCharacterIndexFromPanelTab();
    const selectedPosition = indices.indexOf(panelCharacterIndex);
    const character = scan.characters.find((entry) => entry.index === panelCharacterIndex) || null;
    const isEnabled = character?.enabled !== false;
    if (ui.activeCharacterLabel) {
      ui.activeCharacterLabel.textContent = selectedPosition >= 0 ? getCharacterLabel(panelCharacterIndex) : "none";
    }
    const isCharacterTab = selectedPosition >= 0;
    if (ui.characterEditorTools) {
      ui.characterEditorTools.hidden = !isCharacterTab;
      ui.characterEditorTools.classList.toggle("is-disabled", isCharacterTab && !isEnabled);
    }
    if (ui.editorView) {
      ui.editorView.classList.toggle("is-character-disabled", isCharacterTab && !isEnabled);
    }
    if (ui.characterNameInput && isCharacterTab) {
      const nextLabel = getCharacterLabel(panelCharacterIndex);
      if (ui.characterNameInput.value !== nextLabel) {
        ui.characterNameInput.value = nextLabel;
      }
    }
    if (ui.characterEnabledButton) {
      ui.characterEnabledButton.hidden = !isCharacterTab;
      ui.characterEnabledButton.textContent = isEnabled ? "비활성화" : "활성화";
      ui.characterEnabledButton.dataset.enabled = isEnabled ? "true" : "false";
      ui.characterEnabledButton.title = isEnabled ? "NovelAI 캐릭터 비활성화" : "NovelAI 캐릭터 활성화";
    }
    if (ui.characterDisabledBanner) {
      ui.characterDisabledBanner.hidden = !isCharacterTab || isEnabled;
    }
    if (ui.deleteCharacterButton) {
      ui.deleteCharacterButton.disabled = !isCharacterTab;
    }
    const isConfirming = isCharacterTab && pendingDeleteCharacterIndex === panelCharacterIndex;
    if (ui.deleteConfirm) {
      ui.deleteConfirm.hidden = !isConfirming;
    }
    if (ui.deleteCharacterButton) {
      ui.deleteCharacterButton.hidden = isConfirming;
    }
  }

  function clearCharacterDropSpace() {
    characterDropTargetIndex = null;
    ui.characterTabList?.querySelectorAll(".nps-character-drop-space").forEach((element) => element.remove());
    ui.characterTabList?.querySelectorAll(".nps-character-tab.is-drop-target").forEach((element) => {
      element.classList.remove("is-drop-target");
    });
  }

  function renderCharacterDropSpace(targetButton, sourceIndex, targetIndex) {
    if (!ui.characterTabList || !targetButton || sourceIndex === targetIndex) {
      return;
    }
    clearCharacterDropSpace();
    characterDropTargetIndex = targetIndex;

    const placeholder = document.createElement("div");
    placeholder.className = "nps-character-drop-space";
    placeholder.dataset.targetIndex = String(targetIndex);
    placeholder.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    placeholder.addEventListener("drop", (event) => {
      event.preventDefault();
      const draggedIndex = Number.parseInt(event.dataTransfer.getData("text/plain") || draggingCharacterIndex, 10);
      if (!Number.isFinite(draggedIndex) || draggedIndex === characterDropTargetIndex) {
        clearCharacterDropSpace();
        return;
      }
      const nextTargetIndex = characterDropTargetIndex;
      clearCharacterDropSpace();
      void moveCharacterToIndex(draggedIndex, nextTargetIndex);
    });

    targetButton.classList.add("is-drop-target");
    if (sourceIndex < targetIndex) {
      targetButton.after(placeholder);
    } else {
      targetButton.before(placeholder);
    }
  }

  function renderSlotButtons() {
    const previousActiveSlotId = selectorState.activeSlotId;
    const previousPanelTab = selectorState.activePanelTab;
    const slotIds = getKnownSlotIds();
    const scan = scanNovelAiPromptSlots();
    const indices = getCurrentCharacterIndices(scan);
    selectorState.activePanelTab = getValidPanelTab(indices);
    syncActiveSlotToPanelTab();
    if (selectorState.activeSlotId !== previousActiveSlotId) {
      updateEditorFieldsFromActiveSlot();
    }
    if (
      selectorState.activeSlotId !== previousActiveSlotId
      || selectorState.activePanelTab !== previousPanelTab
    ) {
      void saveSelectorState();
    }

    for (const slotId of slotIds) {
      ensureSlot(slotId);
    }

    if (ui.sidebarAutoTab) {
      ui.sidebarAutoTab.classList.toggle("is-active", selectorState.activePanelTab === "auto");
    }
    if (ui.sidebarMainTab) {
      ui.sidebarMainTab.classList.toggle("is-active", selectorState.activePanelTab === "main");
    }

    if (ui.characterTabList) {
      ui.characterTabList.replaceChildren();
      if (!indices.length) {
        const empty = document.createElement("div");
        empty.className = "nps-sidebar-empty";
        empty.textContent = "No character";
        ui.characterTabList.append(empty);
      }

      for (const index of indices) {
        const character = scan.characters.find((entry) => entry.index === index) || null;
        const isEnabled = character?.enabled !== false;
        const tabId = getCharacterPanelTabId(index);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "nps-sidebar-tab nps-character-tab";
        button.textContent = getCharacterLabel(index);
        button.draggable = true;
        button.dataset.index = String(index);
        button.classList.toggle("is-active", selectorState.activePanelTab === tabId);
        button.classList.toggle("is-disabled", !isEnabled);
        button.title = isEnabled ? getCharacterLabel(index) : `${getCharacterLabel(index)} (비활성화)`;
        button.addEventListener("click", () => {
          setActivePanelTab(tabId);
          setStatus(`${getCharacterLabel(index)} 탭을 편집합니다.`, "ok");
        });
        button.addEventListener("dragstart", (event) => {
          draggingCharacterIndex = index;
          characterDropTargetIndex = null;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", String(index));
          button.classList.add("is-dragging");
        });
        button.addEventListener("dragend", () => {
          draggingCharacterIndex = null;
          button.classList.remove("is-dragging");
          clearCharacterDropSpace();
          renderSlotButtons();
        });
        button.addEventListener("dragover", (event) => {
          if (!draggingCharacterIndex || draggingCharacterIndex === index) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          renderCharacterDropSpace(button, draggingCharacterIndex, index);
        });
        button.addEventListener("dragleave", () => {
          button.classList.remove("is-drop-target");
        });
        button.addEventListener("drop", (event) => {
          event.preventDefault();
          const sourceIndex = Number.parseInt(event.dataTransfer.getData("text/plain") || draggingCharacterIndex, 10);
          const targetIndex = characterDropTargetIndex || index;
          clearCharacterDropSpace();
          if (!Number.isFinite(sourceIndex) || sourceIndex === targetIndex) {
            return;
          }
          void moveCharacterToIndex(sourceIndex, targetIndex);
        });
        ui.characterTabList.append(button);
      }
    }
    renderActivePanelView();
    renderCharacterControls();
    renderAutoRunControls();
  }

  async function moveCharacterToIndex(sourceIndex, targetIndex) {
    const indices = getCurrentCharacterIndices();
    if (!indices.includes(sourceIndex) || !indices.includes(targetIndex)) {
      setStatus("이동할 캐릭터를 찾지 못했습니다.", "warn");
      return { ok: false };
    }
    let currentIndex = sourceIndex;
    while (currentIndex < targetIndex) {
      setSelectedCharacterIndex(currentIndex, { selectPromptSlot: true });
      const result = await moveNovelAiCharacter("down");
      if (!result.ok) {
        return result;
      }
      currentIndex += 1;
    }
    while (currentIndex > targetIndex) {
      setSelectedCharacterIndex(currentIndex, { selectPromptSlot: true });
      const result = await moveNovelAiCharacter("up");
      if (!result.ok) {
        return result;
      }
      currentIndex -= 1;
    }
    selectorState.activePanelTab = getCharacterPanelTabId(targetIndex);
    setSelectedCharacterIndex(targetIndex, { selectPromptSlot: true });
    pendingDeleteCharacterIndex = null;
    await saveSelectorState();
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
    setStatus(`${getCharacterLabel(targetIndex)} 위치를 변경했습니다.`, "ok");
    return { ok: true };
  }

  function refreshSlotsFromDom({ pruneMissingCharacters = false, forcePruneMissingCharacters = false } = {}) {
    syncSlotsWithDom({ pruneMissingCharacters, forcePruneMissingCharacters });
    void saveSelectorState();
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
  }

  function getPanelFallbackSize(collapsed = selectorState.panelCollapsed) {
    const fallbackWidth = collapsed ? 224 : 720;
    const fallbackHeight = collapsed ? 64 : Math.min(680, Math.max(64, window.innerHeight - 24));
    return { width: fallbackWidth, height: fallbackHeight };
  }

  function getPanelDomCollapsed() {
    if (ui.shell?.dataset?.collapsed === "true") {
      return true;
    }
    if (ui.shell?.dataset?.collapsed === "false") {
      return false;
    }
    return selectorState.panelCollapsed;
  }

  function getPanelSize(collapsed = selectorState.panelCollapsed) {
    const fallbackSize = getPanelFallbackSize(collapsed);
    const rect = Boolean(collapsed) === getPanelDomCollapsed()
      ? panelHost?.getBoundingClientRect?.()
      : null;
    return {
      width: Math.max(1, rect?.width || fallbackSize.width),
      height: Math.max(1, rect?.height || fallbackSize.height),
    };
  }

  function clampPanelPositionForSize(position, size = getPanelSize()) {
    const margin = PANEL_POSITION_MARGIN;
    const width = Math.max(1, size?.width || 1);
    const height = Math.max(1, size?.height || 1);
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    const left = Number.parseFloat(position?.left);
    const top = Number.parseFloat(position?.top);
    return {
      left: Math.min(maxLeft, Math.max(margin, Number.isFinite(left) ? left : margin)),
      top: Math.min(maxTop, Math.max(margin, Number.isFinite(top) ? top : margin)),
    };
  }

  function setPanelHostPosition(position) {
    if (!panelHost || !position) {
      return;
    }
    panelHost.style.left = `${position.left}px`;
    panelHost.style.top = `${position.top}px`;
    panelHost.style.right = "auto";
  }

  function createPanelFrameFromRect(rect) {
    const left = Number.parseFloat(rect?.left);
    const top = Number.parseFloat(rect?.top);
    const width = Math.max(1, Number.parseFloat(rect?.width) || 1);
    const height = Math.max(1, Number.parseFloat(rect?.height) || 1);
    const right = Number.parseFloat(rect?.right);
    const bottom = Number.parseFloat(rect?.bottom);
    const safeLeft = Number.isFinite(left) ? left : PANEL_POSITION_MARGIN;
    const safeTop = Number.isFinite(top) ? top : PANEL_POSITION_MARGIN;
    const rightGap = window.innerWidth - (Number.isFinite(right) ? right : safeLeft + width);
    const bottomGap = window.innerHeight - (Number.isFinite(bottom) ? bottom : safeTop + height);
    return {
      left: safeLeft,
      top: safeTop,
      width,
      height,
      rightGap,
      bottomGap,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      anchorRight: rightGap <= PANEL_EDGE_ANCHOR_DISTANCE && rightGap <= safeLeft,
      anchorBottom: bottomGap <= PANEL_EDGE_ANCHOR_DISTANCE && bottomGap <= safeTop,
    };
  }

  function createPanelFrameFromPosition(position, size = getPanelFallbackSize(true)) {
    const width = Math.max(1, size?.width || 1);
    const height = Math.max(1, size?.height || 1);
    const clamped = clampPanelPositionForSize(position, { width, height });
    const rightGap = window.innerWidth - clamped.left - width;
    const bottomGap = window.innerHeight - clamped.top - height;
    return {
      left: clamped.left,
      top: clamped.top,
      width,
      height,
      rightGap,
      bottomGap,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      anchorRight: rightGap <= PANEL_EDGE_ANCHOR_DISTANCE && rightGap <= clamped.left,
      anchorBottom: bottomGap <= PANEL_EDGE_ANCHOR_DISTANCE && bottomGap <= clamped.top,
    };
  }

  function rememberCollapsedPanelFrame(frame) {
    if (!frame) {
      return null;
    }
    const fallbackSize = getPanelFallbackSize(true);
    const size = {
      width: Math.max(1, Number.parseFloat(frame.width) || fallbackSize.width),
      height: Math.max(1, Number.parseFloat(frame.height) || fallbackSize.height),
    };
    const nextFrame = createPanelFrameFromPosition(frame, size);
    selectorState.panelCollapsedPosition = {
      left: nextFrame.left,
      top: nextFrame.top,
    };
    selectorState.panelCollapsedFrame = nextFrame;
    return nextFrame;
  }

  function applyPanelPosition({ save = false, size = getPanelSize() } = {}) {
    if (!panelHost || !selectorState.panelPosition) {
      return;
    }
    selectorState.panelPosition = clampPanelPositionForSize(selectorState.panelPosition, size);
    setPanelHostPosition(selectorState.panelPosition);
    panelCurrentFrame = createPanelFrameFromPosition(selectorState.panelPosition, size);
    if (selectorState.panelCollapsed) {
      rememberCollapsedPanelFrame(panelCurrentFrame);
    }
    if (save) {
      void saveSelectorState();
    }
  }

  function captureCurrentPanelFrame() {
    if (!panelHost?.isConnected) {
      return null;
    }
    const rect = panelHost.getBoundingClientRect();
    const frame = createPanelFrameFromRect(rect);
    selectorState.panelPosition = {
      left: frame.left,
      top: frame.top,
    };
    setPanelHostPosition(selectorState.panelPosition);
    panelCurrentFrame = frame;
    if (selectorState.panelCollapsed) {
      rememberCollapsedPanelFrame(frame);
    }
    return frame;
  }

  function getPanelPositionFromAnchor(previousFrame, size = getPanelSize()) {
    if (!previousFrame) {
      return selectorState.panelPosition
        ? clampPanelPositionForSize(selectorState.panelPosition, size)
        : null;
    }
    const rightGap = Number.parseFloat(previousFrame.rightGap);
    const bottomGap = Number.parseFloat(previousFrame.bottomGap);
    const frameLeft = Number.parseFloat(previousFrame.left);
    const frameTop = Number.parseFloat(previousFrame.top);
    const frameWidth = Number.parseFloat(previousFrame.width);
    const frameHeight = Number.parseFloat(previousFrame.height);
    const frameViewportWidth = Number.parseFloat(previousFrame.viewportWidth);
    const frameViewportHeight = Number.parseFloat(previousFrame.viewportHeight);
    const frameDevicePixelRatio = Number.parseFloat(previousFrame.devicePixelRatio);
    const currentDevicePixelRatio = window.devicePixelRatio || 1;
    const didHorizontalViewportChange = Number.isFinite(frameViewportWidth)
      && (
        Math.abs(frameViewportWidth - window.innerWidth) > 1
        || (Number.isFinite(frameDevicePixelRatio) && Math.abs(frameDevicePixelRatio - currentDevicePixelRatio) > 0.001)
      );
    const didVerticalViewportChange = Number.isFinite(frameViewportHeight)
      && (
        Math.abs(frameViewportHeight - window.innerHeight) > 1
        || (Number.isFinite(frameDevicePixelRatio) && Math.abs(frameDevicePixelRatio - currentDevicePixelRatio) > 0.001)
      );
    const scaleAxisPosition = (value, previousViewportSize, currentViewportSize, previousSize, currentSize) => {
      const oldMax = Math.max(PANEL_POSITION_MARGIN, previousViewportSize - previousSize - PANEL_POSITION_MARGIN);
      const newMax = Math.max(PANEL_POSITION_MARGIN, currentViewportSize - currentSize - PANEL_POSITION_MARGIN);
      const oldRange = Math.max(1, oldMax - PANEL_POSITION_MARGIN);
      const newRange = Math.max(0, newMax - PANEL_POSITION_MARGIN);
      const ratio = Math.min(1, Math.max(0, (value - PANEL_POSITION_MARGIN) / oldRange));
      return PANEL_POSITION_MARGIN + ratio * newRange;
    };
    return clampPanelPositionForSize({
      left: previousFrame.anchorRight && Number.isFinite(rightGap)
        ? window.innerWidth - previousFrame.rightGap - size.width
        : (didHorizontalViewportChange && Number.isFinite(frameLeft)
          ? scaleAxisPosition(
            frameLeft,
            frameViewportWidth,
            window.innerWidth,
            Number.isFinite(frameWidth) ? frameWidth : size.width,
            size.width,
          )
          : previousFrame.left),
      top: previousFrame.anchorBottom && Number.isFinite(bottomGap)
        ? window.innerHeight - previousFrame.bottomGap - size.height
        : (didVerticalViewportChange && Number.isFinite(frameTop)
          ? scaleAxisPosition(
            frameTop,
            frameViewportHeight,
            window.innerHeight,
            Number.isFinite(frameHeight) ? frameHeight : size.height,
            size.height,
          )
          : previousFrame.top),
    }, size);
  }

  function setPanelCollapsed(collapsed) {
    const nextCollapsed = Boolean(collapsed);
    const wasCollapsed = selectorState.panelCollapsed;
    const previousFrame = captureCurrentPanelFrame();
    if (wasCollapsed && previousFrame) {
      rememberCollapsedPanelFrame(previousFrame);
    }

    const restoreFrame = nextCollapsed
      ? selectorState.panelCollapsedFrame || previousFrame
      : previousFrame || selectorState.panelCollapsedFrame;
    selectorState.panelCollapsed = nextCollapsed;
    if (ui.shell) {
      ui.shell.dataset.collapsed = selectorState.panelCollapsed ? "true" : "false";
    }
    const requestId = ++panelLayoutRequestId;
    requestAnimationFrame(() => {
      if (requestId !== panelLayoutRequestId) {
        return;
      }
      const size = getPanelSize(nextCollapsed);
      selectorState.panelPosition = getPanelPositionFromAnchor(restoreFrame, size);
      applyPanelPosition({ size });
      void saveSelectorState();
    });
  }

  function realignPanelForViewportChange({ save = true } = {}) {
    if (!panelHost?.isConnected || !selectorState.panelPosition) {
      return;
    }
    const size = getPanelSize();
    const sourceFrame = panelCurrentFrame || createPanelFrameFromPosition(selectorState.panelPosition, size);
    selectorState.panelPosition = getPanelPositionFromAnchor(sourceFrame, size);
    applyPanelPosition({ size });
    if (save) {
      void saveSelectorState();
    }
  }

  function schedulePanelViewportRealign({ save = true } = {}) {
    if (panelViewportRealignRequestId) {
      return;
    }
    panelViewportRealignRequestId = requestAnimationFrame(() => {
      panelViewportRealignRequestId = 0;
      realignPanelForViewportChange({ save });
    });
  }

  function removePanelResolutionWatcher() {
    if (!panelResolutionWatcher) {
      return;
    }
    const { media, handler } = panelResolutionWatcher;
    if (media?.removeEventListener) {
      media.removeEventListener("change", handler);
    } else if (media?.removeListener) {
      media.removeListener(handler);
    }
    panelResolutionWatcher = null;
  }

  function bindPanelResolutionWatcher() {
    if (!window.matchMedia) {
      return;
    }
    removePanelResolutionWatcher();
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const handler = () => {
      schedulePanelViewportRealign({ save: true });
      bindPanelResolutionWatcher();
    };
    if (media.addEventListener) {
      media.addEventListener("change", handler);
    } else if (media.addListener) {
      media.addListener(handler);
    }
    panelResolutionWatcher = { media, handler };
  }

  function bindPanelViewportEvents() {
    window.addEventListener("resize", () => schedulePanelViewportRealign({ save: true }));
    window.visualViewport?.addEventListener?.("resize", () => schedulePanelViewportRealign({ save: true }));
    bindPanelResolutionWatcher();
  }

  function blockPanelCtrlWheelZoom(event) {
    if (!event.ctrlKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function getTextareaLineInfo(value, offset) {
    const caret = Math.max(0, Math.min(value.length, Number.parseInt(offset, 10) || 0));
    const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
    const nextBreak = value.indexOf("\n", caret);
    const lineEnd = nextBreak === -1 ? value.length : nextBreak;
    return {
      start: lineStart,
      end: lineEnd,
      column: caret - lineStart,
    };
  }

  function getAdjacentTextareaLine(value, lineInfo, direction) {
    if (direction < 0) {
      if (lineInfo.start <= 0) {
        return null;
      }
      const end = lineInfo.start - 1;
      const start = value.lastIndexOf("\n", end - 1) + 1;
      return { start, end };
    }

    if (lineInfo.end >= value.length) {
      return null;
    }
    const start = lineInfo.end + 1;
    const nextBreak = value.indexOf("\n", start);
    return {
      start,
      end: nextBreak === -1 ? value.length : nextBreak,
    };
  }

  function moveTextareaCaretVertically(textarea, direction, { extendSelection = false } = {}) {
    const value = textarea.value || "";
    const selectionStart = textarea.selectionStart || 0;
    const selectionEnd = textarea.selectionEnd || selectionStart;
    const selectionDirection = textarea.selectionDirection || "none";
    const focusOffset = extendSelection
      ? (selectionDirection === "backward" ? selectionStart : selectionEnd)
      : (direction < 0 ? selectionStart : selectionEnd);
    const lineInfo = getTextareaLineInfo(value, focusOffset);
    const remembered = textareaVerticalCaretMemory.get(textarea);
    const desiredColumn = remembered?.offset === focusOffset ? remembered.column : lineInfo.column;
    const adjacentLine = getAdjacentTextareaLine(value, lineInfo, direction);
    const targetOffset = adjacentLine
      ? adjacentLine.start + Math.min(desiredColumn, adjacentLine.end - adjacentLine.start)
      : focusOffset;

    if (extendSelection) {
      const anchorOffset = selectionDirection === "backward" ? selectionEnd : selectionStart;
      const start = Math.min(anchorOffset, targetOffset);
      const end = Math.max(anchorOffset, targetOffset);
      const nextDirection = targetOffset < anchorOffset ? "backward" : "forward";
      textarea.setSelectionRange(start, end, nextDirection);
    } else {
      textarea.setSelectionRange(targetOffset, targetOffset, "none");
    }
    textareaVerticalCaretMemory.set(textarea, { column: desiredColumn, offset: targetOffset });
  }

  function handlePanelTextareaKeydown(event) {
    const textarea = event.currentTarget;
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      textareaVerticalCaretMemory.delete(textarea);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) {
      return;
    }

    event.stopPropagation();
    if (event.defaultPrevented) {
      event.preventDefault();
      moveTextareaCaretVertically(textarea, event.key === "ArrowUp" ? -1 : 1, {
        extendSelection: event.shiftKey,
      });
    }
  }

  function bindPanelTextareaKeyboard(textarea) {
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return;
    }
    textarea.addEventListener("keydown", handlePanelTextareaKeydown, true);
    textarea.addEventListener("input", () => textareaVerticalCaretMemory.delete(textarea));
    textarea.addEventListener("pointerdown", () => textareaVerticalCaretMemory.delete(textarea));
  }

  function bindCollapsedCardDrag() {
    if (!ui.collapsedCard) {
      return;
    }

    let dragState = null;
    ui.collapsedCard.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target?.closest?.("button, input, textarea, select")) {
        return;
      }
      const frame = captureCurrentPanelFrame();
      const size = {
        width: Math.max(1, frame?.width || getPanelFallbackSize(true).width),
        height: Math.max(1, frame?.height || getPanelFallbackSize(true).height),
      };
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: frame?.left ?? PANEL_POSITION_MARGIN,
        top: frame?.top ?? PANEL_POSITION_MARGIN,
        frame,
        size,
        moved: false,
      };
      ui.collapsedCard.setPointerCapture(event.pointerId);
    });

    ui.collapsedCard.addEventListener("pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (Math.abs(deltaX) + Math.abs(deltaY) > 3) {
        dragState.moved = true;
      }
      selectorState.panelPosition = clampPanelPositionForSize({
        left: dragState.left + deltaX,
        top: dragState.top + deltaY,
      }, dragState.size);
      applyPanelPosition({ size: dragState.size });
    });

    ui.collapsedCard.addEventListener("pointerup", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      ui.collapsedCard.releasePointerCapture(event.pointerId);
      const wasMoved = dragState.moved;
      dragState = null;
      if (wasMoved) {
        void saveSelectorState();
        return;
      }
      setPanelCollapsed(false);
    });

    ui.collapsedCard.addEventListener("pointercancel", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      if (ui.collapsedCard.hasPointerCapture?.(event.pointerId)) {
        ui.collapsedCard.releasePointerCapture(event.pointerId);
      }
      if (dragState.frame) {
        selectorState.panelPosition = {
          left: dragState.frame.left,
          top: dragState.frame.top,
        };
        rememberCollapsedPanelFrame(dragState.frame);
        applyPanelPosition({ size: dragState.size });
      }
      dragState = null;
    });
  }

  function bindPanelEvents() {
    ui.shell.addEventListener("wheel", blockPanelCtrlWheelZoom, { passive: false });

    bindCollapsedCardDrag();
    bindPanelTextareaKeyboard(ui.editor);
    bindPanelTextareaKeyboard(ui.quickInput);
    ui.collapseButton.addEventListener("click", () => setPanelCollapsed(true));

    ui.editor.addEventListener("input", () => {
      const slotData = getActiveSlotData();
      slotData.groupsDefinition = ui.editor.value;
      renderEditorLineNumbers();
      pruneAndStoreSelectorState();
      void saveSelectorState();
      renderPromptSelector();
    });

    ui.editor.addEventListener("scroll", syncEditorLineNumbersScroll);

    if (window.ResizeObserver && ui.editorShell) {
      ui.editorResizeObserver = new ResizeObserver(() => renderEditorLineNumbers());
      ui.editorResizeObserver.observe(ui.editorShell);
    }

    ui.quickInput.addEventListener("input", () => {
      const slotData = getActiveSlotData();
      slotData.quickPrompt = ui.quickInput.value;
      void saveSelectorState();
      renderPromptPreview();
    });

    ui.clearAllButton.addEventListener("click", () => {
      const slotData = getActiveSlotData();
      slotData.selectionState = "{}";
      void saveSelectorState();
      renderPromptSelector();
      setStatus("선행 프롬프트 선택을 모두 해제했습니다.", "ok");
    });

    ui.suffixClearAllButton.addEventListener("click", () => {
      const slotData = getActiveSlotData();
      slotData.suffixSelectionState = "{}";
      void saveSelectorState();
      renderPromptSelector();
      setStatus("후행 프롬프트 선택을 모두 해제했습니다.", "ok");
    });

    ui.sampleButton.addEventListener("click", () => {
      const slotData = getActiveSlotData();
      slotData.groupsDefinition = Core.DEFAULT_GROUPS_DEFINITION;
      slotData.selectionState = "{}";
      slotData.weightMemory = "{}";
      slotData.suffixSelectionState = "{}";
      slotData.suffixWeightMemory = "{}";
      ui.editor.value = slotData.groupsDefinition;
      renderEditorLineNumbers();
      void saveSelectorState();
      renderPromptSelector();
      setStatus("샘플 그룹을 불러왔습니다.", "ok");
    });

    ui.copyButton.addEventListener("click", async () => {
      const prompt = buildCurrentPrompt();
      if (!prompt) {
        return;
      }
      try {
        await navigator.clipboard.writeText(prompt);
        setStatus("프롬프트를 클립보드에 복사했습니다.", "ok");
      } catch (error) {
        setStatus("클립보드 복사에 실패했습니다.", "warn");
      }
    });

    ui.applyButton.addEventListener("click", () => {
      void applyActiveSlotToNovelAi();
    });

    ui.applyAllButton.addEventListener("click", () => {
      void applyAllSlotsToNovelAi();
    });

    ui.generateButton.addEventListener("click", () => {
      void generateOnce({ useSelector: false });
    });

    ui.autoButton.addEventListener("click", () => {
      if (autoRun.active) {
        void stopAutoGenerate({ playAudio: true });
      } else {
        void startAutoGenerate({ useSelector: false });
      }
    });

    ui.collapsedAutoButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (autoRun.active) {
        void stopAutoGenerate({ playAudio: true });
      } else {
        void startAutoGenerate({ useSelector: false });
      }
    });

    ui.sidebarAutoTab.addEventListener("click", () => {
      setActivePanelTab("auto");
    });

    ui.sidebarMainTab.addEventListener("click", () => {
      setActivePanelTab("main");
    });

    ui.refreshSlotsButton.addEventListener("click", () => {
      refreshSlotsFromDom({ pruneMissingCharacters: true });
      setStatus("NovelAI의 현재 캐릭터 슬롯을 새로고침했습니다.", "ok");
    });

    ui.addCharacterButtons.forEach((button) => {
      button.addEventListener("click", () => {
        void addNovelAiCharacter(button.dataset.kind || "Female");
      });
    });

    ui.deleteCharacterButton.addEventListener("click", () => {
      const index = getActiveCharacterIndexFromPanelTab();
      if (!index) {
        return;
      }
      pendingDeleteCharacterIndex = index;
      renderCharacterControls();
    });

    ui.characterEnabledButton.addEventListener("click", () => {
      void toggleNovelAiCharacterEnabled();
    });

    ui.confirmDeleteButton.addEventListener("click", () => {
      void deleteNovelAiCharacter();
    });

    ui.cancelDeleteButton.addEventListener("click", () => {
      pendingDeleteCharacterIndex = null;
      renderCharacterControls();
    });

    ui.characterNameInput.addEventListener("input", () => {
      const index = getActiveCharacterIndexFromPanelTab();
      if (!index) {
        return;
      }
      setCharacterLabel(index, ui.characterNameInput.value);
      void saveSelectorState();
      renderSlotButtons();
    });

    ui.intervalInput.addEventListener("change", () => {
      void saveAutoSettingsFromPanel().then(() => setStatus("자동 생성 주기를 저장했습니다.", "ok"));
    });

    ui.countInput.addEventListener("change", () => {
      void saveAutoSettingsFromPanel().then(() => setStatus("자동 생성 횟수를 저장했습니다.", "ok"));
    });

    ui.countPresetButtons.forEach((button) => {
      button.addEventListener("click", () => {
        ui.countInput.value = button.dataset.count || "";
        void saveAutoSettingsFromPanel().then(() => setStatus("자동 생성 횟수를 저장했습니다.", "ok"));
      });
    });

    bindPanelViewportEvents();
  }

  function ensurePanel() {
    if (panelHost?.isConnected) {
      return;
    }

    panelHost = document.createElement("div");
    panelHost.id = "nai-prompt-selector-host";
    panelShadow = panelHost.attachShadow({ mode: "open" });
    panelShadow.innerHTML = `
      <style>
        :host {
          position: fixed;
          top: 84px;
          right: 16px;
          z-index: 2147483200;
          max-width: calc(100vw - 16px);
          color-scheme: dark;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        * { box-sizing: border-box; }
        button,
        input,
        textarea {
          font: inherit;
        }
        .nps-shell[data-collapsed="true"] .nps-panel { display: none; }
        .nps-shell[data-collapsed="false"] .nps-collapsed-card { display: none; }
        .nps-collapsed-card {
          width: 224px;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: center;
          gap: 10px;
          padding: 9px;
          border: 1px solid rgba(39, 214, 196, 0.48);
          border-radius: 8px;
          background: #111820;
          color: #eafffb;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
          cursor: grab;
          touch-action: none;
          user-select: none;
        }
        .nps-collapsed-card:active {
          cursor: grabbing;
        }
        .nps-collapsed-title {
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0;
        }
        .nps-collapsed-meta {
          margin-top: 2px;
          color: #aab8ba;
          font-size: 11px;
          line-height: 1.25;
        }
        .nps-collapsed-auto {
          min-width: 48px;
          border: 1px solid rgba(39, 214, 196, 0.48);
          border-radius: 6px;
          background: #243f3f;
          color: #f2fffd;
          padding: 7px 8px;
          font-size: 12px;
          font-weight: 800;
          cursor: pointer;
        }
        .nps-collapsed-auto[data-active="true"] {
          border-color: rgba(255, 149, 118, 0.58);
          background: #3d2528;
        }
        .nps-panel {
          width: min(720px, calc(100vw - 24px));
          max-height: calc(100vh - 108px);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid rgba(151, 170, 174, 0.34);
          border-radius: 8px;
          background: #111820;
          color: #edf5f4;
          box-shadow: 0 18px 56px rgba(0, 0, 0, 0.42);
        }
        .nps-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px;
          border-bottom: 1px solid rgba(151, 170, 174, 0.18);
          background: #17212a;
        }
        .nps-title { font-size: 14px; font-weight: 800; }
        .nps-subtitle { color: #aab8ba; font-size: 11px; margin-top: 2px; }
        .nps-header button,
        .nps-actions button,
        .nps-group-actions button,
        .nps-section-head button,
        .nps-character-name-row button,
        .nps-segment,
        .nps-delete-confirm button {
          border: 1px solid rgba(151, 170, 174, 0.35);
          border-radius: 6px;
          background: #222d37;
          color: #edf5f4;
          padding: 6px 9px;
          font-size: 12px;
          cursor: pointer;
        }
        .nps-header button:hover,
        .nps-actions button:hover,
        .nps-group-actions button:hover,
        .nps-section-head button:hover,
        .nps-character-name-row button:hover,
        .nps-segment:hover,
        .nps-delete-confirm button:hover {
          border-color: rgba(39, 214, 196, 0.7);
          background: #293743;
        }
        .nps-actions {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(151, 170, 174, 0.14);
        }
        .nps-actions button:first-child {
          background: #243f3f;
          border-color: rgba(39, 214, 196, 0.55);
        }
        .nps-status {
          min-height: 28px;
          padding: 7px 12px;
          color: #b8c7ca;
          font-size: 12px;
          line-height: 1.25;
          border-bottom: 1px solid rgba(151, 170, 174, 0.14);
        }
        .nps-status[data-tone="ok"] { color: #91f1d8; }
        .nps-status[data-tone="warn"] { color: #ffbe79; }
        .nps-panel-grid {
          min-height: 0;
          display: grid;
          grid-template-columns: 144px minmax(0, 1fr);
          overflow: hidden;
        }
        .nps-sidebar {
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: 7px;
          padding: 12px 8px 12px 10px;
          border-right: 1px solid rgba(151, 170, 174, 0.18);
          background: #151e27;
          overflow-x: hidden;
        }
        .nps-sidebar-label {
          margin: 5px 10px 0 2px;
          color: #7f9094;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .nps-sidebar-tab,
        .nps-sidebar-add {
          width: 100%;
          max-width: 100%;
          min-height: 34px;
          border: 1px solid rgba(151, 170, 174, 0.24);
          border-radius: 7px;
          background: #202a34;
          color: #dce8e8;
          padding: 7px 9px;
          font-size: 12px;
          line-height: 1.2;
          text-align: left;
          cursor: pointer;
        }
        .nps-sidebar-tab:hover,
        .nps-sidebar-add:hover {
          border-color: rgba(39, 214, 196, 0.55);
          background: #263441;
        }
        .nps-sidebar-tab.is-active {
          position: relative;
          z-index: 1;
          background: #111820;
          border-color: rgba(39, 214, 196, 0.68);
          color: #f2fffd;
          font-weight: 800;
          box-shadow: inset -3px 0 0 rgba(39, 214, 196, 0.26);
        }
        .nps-character-tabs {
          min-width: 0;
          min-height: 0;
          display: flex;
          flex: 0 1 auto;
          flex-direction: column;
          gap: 7px;
          max-height: min(360px, calc(100vh - 330px));
          overflow-y: auto;
          overflow-x: hidden;
          padding-right: 0;
        }
        .nps-character-tab {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          transition:
            margin 140ms ease,
            transform 140ms ease,
            opacity 140ms ease,
            background 140ms ease,
            border-color 140ms ease;
        }
        .nps-character-tab.is-disabled {
          color: #809094;
          border-style: dashed;
          background: #18222b;
        }
        .nps-character-tab.is-disabled::after {
          content: " off";
          color: #ffbe79;
          font-size: 10px;
          font-weight: 800;
        }
        .nps-character-tab.is-dragging {
          opacity: 0.5;
        }
        .nps-character-tab.is-drop-target {
          border-color: rgba(255, 190, 121, 0.82);
          background: #2f3540;
        }
        .nps-character-drop-space {
          flex: 0 0 34px;
          min-height: 34px;
          border: 1px dashed rgba(255, 190, 121, 0.85);
          border-radius: 7px;
          background: rgba(255, 190, 121, 0.1);
          box-shadow: inset 0 0 0 1px rgba(255, 190, 121, 0.08);
          transition:
            flex-basis 140ms ease,
            min-height 140ms ease,
            opacity 140ms ease;
        }
        .nps-sidebar-empty {
          color: #7f9094;
          font-size: 11px;
          padding: 6px 10px 6px 2px;
        }
        .nps-sidebar-add {
          min-height: 34px;
          align-self: stretch;
          border-radius: 7px;
          border-color: rgba(39, 214, 196, 0.5);
          background: #173d3c;
          color: #dffff9;
          text-align: center;
          font-size: 16px;
          font-weight: 800;
          line-height: 1;
        }
        .nps-sidebar-add:hover {
          border-color: rgba(39, 214, 196, 0.82);
          background: #1d4b49;
        }
        .nps-body {
          min-height: 0;
          overflow: auto;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .nps-tab-view {
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .nps-tab-view[hidden] {
          display: none;
        }
        .nps-section {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .nps-section[hidden] {
          display: none;
        }
        .nps-section-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .nps-section-title {
          font-size: 12px;
          font-weight: 800;
          color: #dce8e8;
        }
        .nps-section-meta {
          font-size: 11px;
          color: #94a3a6;
        }
        .nps-segments {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .nps-segment.is-active {
          background: #24413f;
          border-color: rgba(39, 214, 196, 0.82);
          color: #f2fffd;
          font-weight: 800;
        }
        .nps-character-editor-tools {
          border: 1px solid rgba(151, 170, 174, 0.23);
          border-radius: 8px;
          background: #151e27;
          padding: 10px;
        }
        .nps-character-editor-tools.is-disabled {
          border-color: rgba(255, 190, 121, 0.54);
          background:
            linear-gradient(135deg, rgba(255, 190, 121, 0.08), rgba(21, 30, 39, 0) 44%),
            #151e27;
        }
        .nps-editor-view.is-character-disabled .nps-editor-shell,
        .nps-editor-view.is-character-disabled .nps-quick,
        .nps-editor-view.is-character-disabled .nps-group,
        .nps-editor-view.is-character-disabled .nps-preview {
          opacity: 0.58;
          filter: saturate(0.6);
        }
        .nps-character-editor-tools[hidden],
        .nps-character-disabled-banner[hidden],
        .nps-delete-confirm[hidden],
        .nps-delete-character[hidden] {
          display: none;
        }
        .nps-character-name-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto auto;
          gap: 8px;
          align-items: end;
        }
        .nps-character-name-row .nps-field {
          min-width: 0;
        }
        .nps-delete-confirm {
          grid-column: 1 / -1;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          color: #ffceaa;
          font-size: 12px;
        }
        .nps-delete-confirm span {
          flex: 1 1 100%;
        }
        .nps-character-disabled-banner {
          margin-top: 8px;
          border: 1px dashed rgba(255, 190, 121, 0.64);
          border-radius: 7px;
          background: rgba(255, 190, 121, 0.08);
          color: #ffceaa;
          padding: 7px 8px;
          font-size: 12px;
          font-weight: 800;
          line-height: 1.25;
        }
        .nps-character-enabled {
          min-width: 72px;
        }
        .nps-character-enabled[data-enabled="false"] {
          background: #243f3f !important;
          border-color: rgba(39, 214, 196, 0.55) !important;
        }
        .nps-confirm-delete,
        .nps-delete-character {
          background: #3d2528 !important;
          border-color: rgba(255, 149, 118, 0.5) !important;
        }
        .nps-editor-shell {
          position: relative;
          width: 100%;
          height: 132px;
          min-height: 132px;
          display: grid;
          grid-template-columns: 42px minmax(0, 1fr);
          resize: vertical;
          overflow: hidden;
          border: 1px solid rgba(151, 170, 174, 0.3);
          border-radius: 6px;
          background: #0b1117;
        }
        .nps-editor-line-numbers {
          overflow: hidden;
          border-right: 1px solid rgba(151, 170, 174, 0.2);
          background: #101820;
          color: #67787c;
          padding: 10px 8px 10px 6px;
          line-height: 1.45;
          font-size: 12px;
          font-family: Consolas, "Courier New", monospace;
          text-align: right;
          white-space: normal;
          user-select: none;
          pointer-events: none;
        }
        .nps-editor-line-number {
          display: block;
          min-height: calc(12px * 1.45);
        }
        .nps-editor {
          width: 100%;
          height: 100%;
          min-height: 0;
          resize: none;
          border: 0;
          border-radius: 0;
          background: transparent;
          color: #eef7f7;
          padding: 10px;
          line-height: 1.45;
          font-size: 12px;
          font-family: Consolas, "Courier New", monospace;
          overflow-x: hidden;
          overflow-y: auto;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .nps-editor-line-measurer {
          position: absolute;
          top: 0;
          left: -10000px;
          height: auto;
          visibility: hidden;
          pointer-events: none;
          overflow: hidden;
          color: transparent;
          padding: 10px;
          line-height: 1.45;
          font-size: 12px;
          font-family: Consolas, "Courier New", monospace;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .nps-editor-measure-line {
          min-height: calc(12px * 1.45);
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .nps-quick {
          width: 100%;
          min-height: 132px;
          resize: vertical;
          border: 1px solid rgba(151, 170, 174, 0.3);
          border-radius: 6px;
          background: #0b1117;
          color: #eef7f7;
          padding: 10px;
          line-height: 1.45;
          font-size: 12px;
          font-family: Consolas, "Courier New", monospace;
        }
        .nps-quick { min-height: 86px; }
        .nps-editor:focus {
          outline: none;
        }
        .nps-editor-shell:focus-within,
        .nps-quick:focus {
          outline: 1px solid rgba(39, 214, 196, 0.75);
          border-color: rgba(39, 214, 196, 0.75);
        }
        .nps-groups,
        .nps-suffix-groups {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .nps-count-presets {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .nps-count-presets button {
          flex: 1 1 auto;
          min-width: 72px;
          border: 1px solid rgba(151, 170, 174, 0.28);
          border-radius: 6px;
          background: #202a34;
          color: #e6eeee;
          padding: 6px 8px;
          font-size: 12px;
          cursor: pointer;
        }
        .nps-character-delete {
          background: #3d2528 !important;
          border-color: rgba(255, 149, 118, 0.45) !important;
        }
        .nps-settings-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .nps-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .nps-field label {
          color: #94a3a6;
          font-size: 11px;
        }
        .nps-field input {
          width: 100%;
          border: 1px solid rgba(151, 170, 174, 0.3);
          border-radius: 6px;
          background: #0b1117;
          color: #eef7f7;
          padding: 7px 8px;
          font-size: 12px;
        }
        .nps-field input:focus {
          outline: 1px solid rgba(39, 214, 196, 0.75);
          border-color: rgba(39, 214, 196, 0.75);
        }
        .nps-empty-inline {
          color: #94a3a6;
          font-size: 12px;
          padding: 6px 0;
        }
        .nps-group {
          border: 1px solid rgba(151, 170, 174, 0.23);
          border-radius: 8px;
          background: #151e27;
          padding: 10px;
        }
        .nps-group-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
        }
        .nps-group-title {
          font-size: 12px;
          font-weight: 800;
          color: #f2f7f7;
        }
        .nps-group-meta {
          color: #91a1a5;
          font-size: 11px;
          margin-top: 2px;
        }
        .nps-group-actions {
          display: flex;
          gap: 6px;
        }
        .nps-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .nps-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          max-width: 100%;
          border: 1px solid rgba(151, 170, 174, 0.26);
          border-radius: 6px;
          background: #202a34;
          color: #e6eeee;
          padding: 5px 8px;
          font-size: 12px;
          line-height: 1.2;
          cursor: pointer;
        }
        .nps-chip:hover {
          border-color: rgba(39, 214, 196, 0.65);
        }
        .nps-chip.is-active {
          background: #24413f;
          border-color: rgba(39, 214, 196, 0.82);
          color: #f2fffd;
          box-shadow: 0 0 0 1px rgba(39, 214, 196, 0.1), 0 0 14px rgba(39, 214, 196, 0.18);
        }
        .nps-chip.is-active.is-boosted {
          --nps-chip-tone-hue: 8;
          --nps-chip-tone-foreground: #fff7f5;
          --nps-chip-tone-weight-color: #ffd8d0;
        }
        .nps-chip.is-active.is-weakened {
          --nps-chip-tone-hue: 210;
          --nps-chip-tone-foreground: #f3f9ff;
          --nps-chip-tone-weight-color: #d5ecff;
        }
        .nps-chip.is-active.is-boosted,
        .nps-chip.is-active.is-weakened {
          background: hsl(
            var(--nps-chip-tone-hue),
            var(--nps-chip-tone-saturation, 60%),
            var(--nps-chip-tone-bg-lightness, 24%)
          );
          border-color: hsla(
            var(--nps-chip-tone-hue),
            var(--nps-chip-tone-saturation, 60%),
            var(--nps-chip-tone-border-lightness, 54%),
            0.88
          );
          color: var(--nps-chip-tone-foreground);
          box-shadow:
            0 0 0 1px hsla(
              var(--nps-chip-tone-hue),
              var(--nps-chip-tone-saturation, 60%),
              58%,
              0.12
            ),
            0 0 14px hsla(
              var(--nps-chip-tone-hue),
              var(--nps-chip-tone-saturation, 60%),
              58%,
              var(--nps-chip-tone-shadow-alpha, 0.18)
            );
        }
        .nps-chip-label {
          min-width: 0;
          overflow-wrap: anywhere;
          text-align: left;
        }
        .nps-chip-weight {
          flex: 0 0 auto;
          border-radius: 5px;
          background: rgba(7, 10, 14, 0.42);
          color: #b8fff2;
          padding: 1px 5px;
          font-size: 11px;
          font-weight: 800;
        }
        .nps-chip.is-active.is-boosted .nps-chip-weight,
        .nps-chip.is-active.is-weakened .nps-chip-weight {
          background: hsla(
            var(--nps-chip-tone-hue),
            var(--nps-chip-tone-saturation, 60%),
            11%,
            0.46
          );
          color: var(--nps-chip-tone-weight-color);
        }
        .nps-preview {
          min-height: 96px;
          max-height: 220px;
          overflow: auto;
          margin: 0;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          border: 1px solid rgba(151, 170, 174, 0.3);
          border-radius: 6px;
          background: #0b1117;
          color: #eef7f7;
          padding: 10px;
          font-size: 12px;
          line-height: 1.45;
          font-family: Consolas, "Courier New", monospace;
        }
        .nps-preview.is-empty,
        .nps-empty {
          color: #94a3a6;
        }
        .nps-empty {
          white-space: pre-wrap;
          border: 1px dashed rgba(151, 170, 174, 0.32);
          border-radius: 8px;
          padding: 12px;
          font-size: 12px;
          line-height: 1.45;
        }
        @media (max-width: 520px) {
          :host {
            right: 8px;
            top: 64px;
          }
          .nps-actions {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .nps-panel {
            width: calc(100vw - 16px);
          }
          .nps-panel-grid {
            grid-template-columns: 112px minmax(0, 1fr);
          }
          .nps-sidebar {
            padding-left: 8px;
            padding-right: 6px;
          }
          .nps-sidebar-tab {
            padding: 7px 7px;
            font-size: 11px;
          }
          .nps-settings-grid {
            grid-template-columns: 1fr;
          }
          .nps-character-name-row {
            grid-template-columns: 1fr;
          }
        }
      </style>
      <div class="nps-shell" data-collapsed="true">
        <div class="nps-collapsed-card" title="드래그로 이동, 클릭으로 열기">
          <div>
            <div class="nps-collapsed-title">NAI Auto</div>
            <div class="nps-collapsed-meta">완료/설정: <span class="nps-collapsed-count">0 / ∞</span></div>
          </div>
          <button class="nps-collapsed-auto" type="button">시작</button>
        </div>
        <aside class="nps-panel">
          <header class="nps-header">
            <div>
              <div class="nps-title">NAI-Prompt-Selector</div>
              <div class="nps-subtitle">PromptSelector + auto generation</div>
            </div>
            <button class="nps-collapse" type="button">접기</button>
          </header>
          <div class="nps-actions">
            <button class="nps-apply" type="button">현재 슬롯 적용</button>
            <button class="nps-apply-all" type="button">전체 슬롯 적용</button>
            <button class="nps-generate" type="button">1회 생성</button>
            <button class="nps-auto" type="button">자동 생성</button>
          </div>
          <div class="nps-status" data-tone="neutral"></div>
          <div class="nps-panel-grid">
            <nav class="nps-sidebar" aria-label="NAI-Prompt-Selector tabs">
              <button class="nps-sidebar-tab nps-sidebar-auto" type="button">자동 생성 설정</button>
              <button class="nps-sidebar-tab nps-sidebar-main" type="button">Base / Main UC</button>
              <div class="nps-sidebar-label">Characters</div>
              <div class="nps-character-tabs"></div>
              <button class="nps-add-character nps-sidebar-add" type="button" data-kind="Other" title="Other 캐릭터 추가">+</button>
            </nav>
            <div class="nps-body">
              <section class="nps-tab-view nps-auto-view">
                <section class="nps-section">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">Auto Generation</div>
                      <div class="nps-section-meta">횟수 비우기 또는 0 = 무제한</div>
                    </div>
                  </div>
                  <div class="nps-settings-grid">
                    <div class="nps-field">
                      <label for="nps-count-input">횟수</label>
                      <input id="nps-count-input" class="nps-count-input" type="number" min="0" step="1" placeholder="0">
                    </div>
                    <div class="nps-field">
                      <label for="nps-interval-input">주기(초)</label>
                      <input id="nps-interval-input" class="nps-interval-input" type="number" min="0.1" step="0.1" placeholder="3">
                    </div>
                  </div>
                  <div class="nps-count-presets">
                    <button type="button" data-count="5">5</button>
                    <button type="button" data-count="10">10</button>
                    <button type="button" data-count="20">20</button>
                    <button type="button" data-count="30">30</button>
                    <button type="button" data-count="50">50</button>
                    <button type="button" data-count="">∞</button>
                  </div>
                </section>
              </section>
              <section class="nps-tab-view nps-editor-view" hidden>
                <section class="nps-section">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title nps-slot-mode-title">Base / Main UC</div>
                      <div class="nps-section-meta">현재 편집: <span class="nps-active-slot">Base</span></div>
                    </div>
                    <button class="nps-refresh-slots" type="button">Refresh</button>
                  </div>
                  <div class="nps-segments nps-slot-mode-tabs"></div>
                </section>
                <section class="nps-section nps-character-editor-tools" hidden>
                  <div class="nps-character-name-row">
                    <div class="nps-field">
                      <label for="nps-character-name-input">캐릭터 이름</label>
                      <input id="nps-character-name-input" class="nps-character-name-input" type="text" maxlength="48" placeholder="Char">
                    </div>
                    <button class="nps-character-enabled" type="button">비활성화</button>
                    <button class="nps-delete-character nps-character-delete" type="button">삭제</button>
                    <div class="nps-delete-confirm" hidden>
                      <span>정말 삭제할까요?</span>
                      <button class="nps-confirm-delete" type="button">삭제 확정</button>
                      <button class="nps-cancel-delete" type="button">취소</button>
                    </div>
                  </div>
                  <div class="nps-character-disabled-banner" hidden>이 캐릭터는 NovelAI에서 비활성화되어 있습니다.</div>
                  <div class="nps-section-meta">대상: <span class="nps-active-character">none</span></div>
                </section>
                <section class="nps-section">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">Group Definition</div>
                      <div class="nps-section-meta">[Group] 아래에 프롬프트를 한 줄씩 입력</div>
                    </div>
                    <button class="nps-sample" type="button">Sample</button>
                  </div>
                  <div class="nps-editor-shell">
                    <div class="nps-editor-line-numbers" aria-hidden="true">1</div>
                    <textarea class="nps-editor" spellcheck="false" wrap="soft"></textarea>
                    <div class="nps-editor-line-measurer" aria-hidden="true"></div>
                  </div>
                </section>
                <section class="nps-section">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">선행 프롬프트</div>
                      <div class="nps-section-meta nps-summary">0 group(s)</div>
                    </div>
                    <button class="nps-clear-all" type="button">Clear All</button>
                  </div>
                  <div class="nps-groups"></div>
                </section>
                <section class="nps-section">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">Quick Prompt</div>
                      <div class="nps-section-meta">선행 뒤, 후행 앞에 병합됩니다</div>
                    </div>
                  </div>
                  <textarea class="nps-quick" spellcheck="false" placeholder="Write prompt text here"></textarea>
                </section>
                <section class="nps-section nps-suffix-section" hidden>
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">후행 프롬프트</div>
                      <div class="nps-section-meta nps-suffix-summary">0 group(s)</div>
                    </div>
                    <button class="nps-suffix-clear-all" type="button">Clear All</button>
                  </div>
                  <div class="nps-suffix-groups"></div>
                </section>
                <section class="nps-section">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">Preview</div>
                      <div class="nps-section-meta nps-prompt-meta">empty</div>
                    </div>
                    <button class="nps-copy" type="button" disabled>Copy</button>
                  </div>
                  <pre class="nps-preview is-empty">No prompt selected.</pre>
                </section>
              </section>
            </div>
          </div>
        </aside>
      </div>
    `;

    document.documentElement.append(panelHost);
    ui = {
      shell: panelShadow.querySelector(".nps-shell"),
      collapsedCard: panelShadow.querySelector(".nps-collapsed-card"),
      collapsedCount: panelShadow.querySelector(".nps-collapsed-count"),
      collapsedAutoButton: panelShadow.querySelector(".nps-collapsed-auto"),
      collapseButton: panelShadow.querySelector(".nps-collapse"),
      sidebarAutoTab: panelShadow.querySelector(".nps-sidebar-auto"),
      sidebarMainTab: panelShadow.querySelector(".nps-sidebar-main"),
      characterTabList: panelShadow.querySelector(".nps-character-tabs"),
      autoView: panelShadow.querySelector(".nps-auto-view"),
      editorView: panelShadow.querySelector(".nps-editor-view"),
      slotModeTitle: panelShadow.querySelector(".nps-slot-mode-title"),
      slotModeTabs: panelShadow.querySelector(".nps-slot-mode-tabs"),
      characterEditorTools: panelShadow.querySelector(".nps-character-editor-tools"),
      characterNameInput: panelShadow.querySelector(".nps-character-name-input"),
      characterEnabledButton: panelShadow.querySelector(".nps-character-enabled"),
      characterDisabledBanner: panelShadow.querySelector(".nps-character-disabled-banner"),
      deleteConfirm: panelShadow.querySelector(".nps-delete-confirm"),
      confirmDeleteButton: panelShadow.querySelector(".nps-confirm-delete"),
      cancelDeleteButton: panelShadow.querySelector(".nps-cancel-delete"),
      editorShell: panelShadow.querySelector(".nps-editor-shell"),
      editor: panelShadow.querySelector(".nps-editor"),
      editorLineNumbers: panelShadow.querySelector(".nps-editor-line-numbers"),
      editorLineMeasurer: panelShadow.querySelector(".nps-editor-line-measurer"),
      quickInput: panelShadow.querySelector(".nps-quick"),
      groupList: panelShadow.querySelector(".nps-groups"),
      suffixSection: panelShadow.querySelector(".nps-suffix-section"),
      suffixGroupList: panelShadow.querySelector(".nps-suffix-groups"),
      summary: panelShadow.querySelector(".nps-summary"),
      suffixSummary: panelShadow.querySelector(".nps-suffix-summary"),
      preview: panelShadow.querySelector(".nps-preview"),
      promptMeta: panelShadow.querySelector(".nps-prompt-meta"),
      status: panelShadow.querySelector(".nps-status"),
      copyButton: panelShadow.querySelector(".nps-copy"),
      applyButton: panelShadow.querySelector(".nps-apply"),
      applyAllButton: panelShadow.querySelector(".nps-apply-all"),
      generateButton: panelShadow.querySelector(".nps-generate"),
      autoButton: panelShadow.querySelector(".nps-auto"),
      clearAllButton: panelShadow.querySelector(".nps-clear-all"),
      suffixClearAllButton: panelShadow.querySelector(".nps-suffix-clear-all"),
      sampleButton: panelShadow.querySelector(".nps-sample"),
      refreshSlotsButton: panelShadow.querySelector(".nps-refresh-slots"),
      activeSlotLabel: panelShadow.querySelector(".nps-active-slot"),
      activeCharacterLabel: panelShadow.querySelector(".nps-active-character"),
      addCharacterButtons: Array.from(panelShadow.querySelectorAll(".nps-add-character")),
      deleteCharacterButton: panelShadow.querySelector(".nps-delete-character"),
      countInput: panelShadow.querySelector(".nps-count-input"),
      intervalInput: panelShadow.querySelector(".nps-interval-input"),
      countPresetButtons: Array.from(panelShadow.querySelectorAll(".nps-count-presets button")),
    };

    refreshSlotsFromDom();
    void loadAutoSettingsIntoPanel();
    updateEditorFieldsFromActiveSlot();
    applyPanelPosition();
    setPanelCollapsed(selectorState.panelCollapsed);
    bindPanelEvents();
    renderSlotButtons();
    renderPromptSelector();
    refreshPageStatus();
  }

  function refreshPageStatus() {
    if (!ui.status) {
      return;
    }
    const scan = scanNovelAiPromptSlots();
    renderSlotButtons();
    const generateButton = findGenerateButton();
    const warning = checkUndesiredContent() || checkGenerationCost();
    if (warning) {
      setStatus(warning, "warn");
    } else if (!generateButton) {
      setStatus("Generate 버튼을 기다리는 중입니다.", "warn");
    } else if (!scan.main.root) {
      setStatus("Base Prompt 입력 영역을 기다리는 중입니다.", "warn");
    } else if (autoRun.active) {
      setStatus(`자동 생성 진행 중: 완료 ${autoRun.completedCount} / ${formatAutoTarget(autoRun.target)}`, "ok");
    } else {
      setStatus(`NovelAI 페이지와 연결되었습니다. 캐릭터 ${scan.characters.length}개 감지.`, "ok");
    }
  }

  function startStatusTimer() {
    if (statusTimer) {
      return;
    }
    statusTimer = setInterval(refreshPageStatus, 1800);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }
    if (changes.intervalTime && ui.intervalInput && !autoRun.active) {
      ui.intervalInput.value = changes.intervalTime.newValue ?? "";
    }
    if (changes.gcount && ui.countInput && !autoRun.active) {
      ui.countInput.value = changes.gcount.newValue ?? "";
    }
    if (changes.intervalTime || changes.gcount) {
      renderAutoRunControls();
    }
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action === "ping" || request?.action === "getContentStatus") {
      ensurePanel();
      sendResponse({
        ok: true,
        autoActive: autoRun.active,
        promptEditorCount: findPromptEditors().length,
        promptSlotCount: getKnownSlotIds().length,
        characterCount: scanNovelAiPromptSlots().characters.length,
        hasGenerateButton: Boolean(findGenerateButton()),
      });
      return false;
    }

    if (request?.action === "togglePanel") {
      ensurePanel();
      setPanelCollapsed(!selectorState.panelCollapsed);
      sendResponse({ ok: true, collapsed: selectorState.panelCollapsed });
      return false;
    }

    if (request?.action === "openPanel") {
      ensurePanel();
      setPanelCollapsed(false);
      sendResponse({ ok: true });
      return false;
    }

    if (request?.action === "applySelectorPrompt") {
      applySelectorPrompt().then(sendResponse);
      return true;
    }

    if (request?.action === "generateOnce") {
      generateOnce({ useSelector: Boolean(request.useSelector) }).then(sendResponse);
      return true;
    }

    if (request?.action === "startAutoGenerate") {
      startAutoGenerate({ useSelector: Boolean(request.useSelector) }).then(sendResponse);
      return true;
    }

    if (request?.action === "cancelAutoGenerate") {
      stopAutoGenerate({ playAudio: true }).then(sendResponse);
      return true;
    }

    return false;
  });

  document.addEventListener("click", (event) => {
    trackNovelAiCharacterActionClick(event);
    const button = event.target?.closest?.("button");
    if (button && /Generate\s+\d+\s+Image(s)?/i.test(button.textContent || "")) {
      clearAllHighlights();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void startAutoGenerate({ useSelector: false });
    }
    if (event.ctrlKey && event.shiftKey && event.code === "KeyX") {
      event.preventDefault();
      event.stopPropagation();
      void stopAutoGenerate({ playAudio: true });
    }
  }, true);

  window.addEventListener("beforeunload", () => {
    clearAutoTimers();
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  });

  void (async function initialize() {
    await loadSelectorState();
    ensurePanel();
    startStatusTimer();
  })();
})();
