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
  const Store = window.NAIPromptStorage;
  if (!Store) {
    console.error("[NAI-Prompt-Selector] prompt-storage.js was not loaded.");
    return;
  }

  const SELECTOR_STORAGE_KEY = "naiPromptSelector.selector";
  const LEGACY_SELECTOR_STORAGE_KEY = "naiPromptManager.selector";
  const SELECTOR_BACKUPS_STORAGE_KEY = "naiPromptSelector.selectorBackups";
  const SELECTOR_LAST_GOOD_STORAGE_KEY = "naiPromptSelector.selectorLastGood";
  const AUTO_REFRESH_MS = 500;
  const ONE_CLICK_TIMEOUT_MS = 10 * 60 * 1000;
  const PROMPT_APPLY_TIMEOUT_MS = 3000;
  const PROMPT_APPLY_STABLE_MS = 160;
  const PROMPT_APPLY_POLL_MS = 50;
  const PROMPT_APPLY_FLUSH_MS = 180;
  const PANEL_POSITION_MARGIN = 8;
  const PANEL_EDGE_ANCHOR_DISTANCE = 24;
  const EDITOR_HEIGHT_SAVE_DELAY_MS = 250;
  const MIN_EDITOR_HEIGHT_PX = 48;
  const MAX_EDITOR_HEIGHT_PX = 2000;
  const EDITOR_RESIZE_CLICK_SUPPRESS_MS = 450;
  const EDITOR_RESIZE_HEIGHT_THRESHOLD_PX = 1;
  const HISTORY_ITEM_SELECTOR = 'div[role="button"][draggable="true"]';
  const ENHANCE_SOURCE_REAPPLY_DELAYS_MS = [0, 300, 1000];
  const ENHANCE_SOURCE_OBSERVE_MS = 2000;
  const AUTO_SETTINGS_KEYS = [
    "intervalTime",
    "gcount",
    "autoSaveEnabled",
    "volume",
    "autoCompletionNotificationEnabled",
  ];

  const MAIN_BASE_SLOT_ID = "main.base";
  const MAIN_UC_SLOT_ID = "main.uc";

  const DEFAULT_SELECTOR_STATE = {
    version: 6,
    activeSlotId: MAIN_BASE_SLOT_ID,
    activeCharacterIndex: null,
    activePanelTab: "auto",
    panelCollapsed: true,
    panelPosition: null,
    panelCollapsedPosition: null,
    panelCollapsedFrame: null,
    editorHeights: {
      groupsDefinition: null,
      quickPrompt: null,
    },
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
  let lastClickedHistoryItem = null;
  let lastKnownHistorySource = null;
  let enhanceHighlightToken = 0;
  let enhanceHistoryObserver = null;

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
    waitingForExistingGeneration: false,
    ignoreReadyUntil: 0,
    token: 0,
  };
  const autoHistoryHighlightWait = {
    token: 0,
    intervalId: null,
  };
  let pendingDeleteCharacterIndex = null;
  let pendingStorageNotice = null;
  let selectorSaveQueue = Promise.resolve();
  let pendingPromptApply = null;
  let editingCharacterNameIndex = null;
  let draggingCharacterIndex = null;
  let characterDropTargetIndex = null;
  let panelLayoutRequestId = 0;
  let panelViewportRealignRequestId = 0;
  let panelCurrentFrame = null;
  let panelResolutionWatcher = null;
  let editorHeightSaveTimer = null;
  let editorResizeInteraction = null;
  let suppressEditorResizeClickUntil = 0;

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForAnimationFrame() {
    return new Promise((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => resolve());
        return;
      }
      window.setTimeout(resolve, 16);
    });
  }

  function normalizeStoredText(value) {
    return String(value || "").replace(/\r\n?/g, "\n").trim();
  }

  function normalizePromptApplyText(value) {
    return normalizeStoredText(String(value || "").replace(/\u00a0/g, " "));
  }

  function getPromptApplyErrorMessage(error) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error || "프롬프트 적용 중 오류가 발생했습니다.");
  }

  async function waitForPromptApplyFlush() {
    await waitForAnimationFrame();
    await waitForAnimationFrame();
    await delay(PROMPT_APPLY_FLUSH_MS);
  }

  async function waitForEditableTextSettled(editor, expectedText, { resolveEditor = null } = {}) {
    const expected = normalizePromptApplyText(expectedText);
    const startedAt = Date.now();
    let matchedSince = 0;
    let actual = "";
    let currentEditor = editor;

    while (Date.now() - startedAt <= PROMPT_APPLY_TIMEOUT_MS) {
      const editorReady = currentEditor?.isConnected
        && currentEditor instanceof HTMLElement
        && isVisible(currentEditor);
      if (!editorReady && typeof resolveEditor === "function") {
        currentEditor = await resolveEditor();
      }

      if (currentEditor?.isConnected && currentEditor instanceof HTMLElement && isVisible(currentEditor)) {
        actual = normalizePromptApplyText(htmlToPlainText(currentEditor.innerHTML));
        if (actual === expected) {
          if (!matchedSince) {
            matchedSince = Date.now();
          }
          if (Date.now() - matchedSince >= PROMPT_APPLY_STABLE_MS) {
            return { ok: true };
          }
        } else {
          matchedSince = 0;
        }
      } else {
        matchedSince = 0;
        actual = "";
      }
      await delay(PROMPT_APPLY_POLL_MS);
    }

    return { ok: false, expected, actual };
  }

  function trackPromptApply(operation) {
    const previousPromptApply = pendingPromptApply;
    const promptApply = (async () => {
      if (previousPromptApply) {
        await previousPromptApply.catch(() => null);
      }
      return operation();
    })()
      .catch((error) => ({
        ok: false,
        error: getPromptApplyErrorMessage(error),
      }))
      .finally(() => {
        if (pendingPromptApply === promptApply) {
          pendingPromptApply = null;
        }
      });

    pendingPromptApply = promptApply;
    return promptApply;
  }

  async function waitForPendingPromptApply({ silent = false } = {}) {
    let waited = false;
    while (pendingPromptApply) {
      const promptApply = pendingPromptApply;
      if (!waited && !silent) {
        setStatus("프롬프트 적용 완료를 기다린 뒤 생성을 시작합니다.", "ok");
      }

      const result = await promptApply;
      waited = true;
      if (!result?.ok) {
        const message = result?.error || "프롬프트 적용이 완료되지 않아 생성을 시작하지 않았습니다.";
        if (!silent) {
          setStatus(message, "warn");
        }
        return { ok: false, error: message };
      }
    }

    if (waited) {
      await waitForPromptApplyFlush();
    }
    return { ok: true, waited };
  }

  function parseStoredObject(value) {
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

  function hasStoredObjectKeys(value) {
    return Object.keys(parseStoredObject(value)).length > 0;
  }

  function hasSlotPromptData(slot) {
    return Boolean(
      slot
      && (
        normalizeStoredText(slot.groupsDefinition)
        || normalizeStoredText(slot.quickPrompt)
        || hasStoredObjectKeys(slot.selectionState)
        || hasStoredObjectKeys(slot.weightMemory)
        || hasStoredObjectKeys(slot.suffixSelectionState)
        || hasStoredObjectKeys(slot.suffixWeightMemory)
      )
    );
  }

  function getDefaultGroupsDefinitionForSlot(slotId) {
    const parsed = parseSlotId(slotId);
    if (parsed?.scope === "main") {
      return parsed.kind === "uc"
        ? Core.DEFAULT_NEGATIVE_GROUPS_DEFINITION
        : Core.DEFAULT_GROUPS_DEFINITION;
    }
    return "";
  }

  function getSampleGroupsDefinitionForSlot(slotId) {
    const parsed = parseSlotId(slotId);
    if (parsed?.scope === "character") {
      return parsed.kind === "prompt" ? Core.DEFAULT_CHARACTER_PROMPT_GROUPS_DEFINITION : "";
    }
    return getDefaultGroupsDefinitionForSlot(slotId);
  }

  function getDefaultGroupsDefinitionsBySlot() {
    return {
      [MAIN_BASE_SLOT_ID]: Core.DEFAULT_GROUPS_DEFINITION,
      [MAIN_UC_SLOT_ID]: Core.DEFAULT_NEGATIVE_GROUPS_DEFINITION,
      [makeCharacterSlotId(1, "prompt")]: Core.DEFAULT_CHARACTER_PROMPT_GROUPS_DEFINITION,
      [makeCharacterSlotId(1, "uc")]: "",
    };
  }

  function storageGet(area, keys) {
    return new Promise((resolve) => {
      chrome.storage[area].get(keys, (result) => {
        if (chrome.runtime.lastError) {
          console.warn("[NAI-Prompt-Selector] storage get failed:", chrome.runtime.lastError.message);
          resolve({});
          return;
        }
        resolve(result || {});
      });
    });
  }

  function storageSet(area, values) {
    return new Promise((resolve) => {
      chrome.storage[area].set(values, () => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true });
      });
    });
  }

  function createSlotData(slotId, overrides = {}) {
    return {
      groupsDefinition: getDefaultGroupsDefinitionForSlot(slotId),
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
      groupsDefinition: String(value.groupsDefinition ?? getDefaultGroupsDefinitionForSlot(slotId)),
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

  function sanitizeEditorHeight(value) {
    const height = Number.parseFloat(value);
    if (!Number.isFinite(height) || height < MIN_EDITOR_HEIGHT_PX || height > MAX_EDITOR_HEIGHT_PX) {
      return null;
    }
    return Math.round(height);
  }

  function sanitizeEditorHeights(value = {}) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      groupsDefinition: sanitizeEditorHeight(source.groupsDefinition),
      quickPrompt: sanitizeEditorHeight(source.quickPrompt),
    };
  }

  function sanitizeCharacterLabels(value) {
    const labels = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return labels;
    }

    for (const [index, label] of Object.entries(value)) {
      const numericIndex = Number.parseInt(index, 10);
      const normalizedLabel = normalizeCharacterLabelValue(label);
      if (Number.isFinite(numericIndex) && numericIndex > 0 && normalizedLabel) {
        labels[numericIndex] = normalizedLabel;
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
      editorHeights: sanitizeEditorHeights(stored.editorHeights),
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

  function getSelectorMeaningfulOptions(options = {}) {
    return {
      ...options,
      defaultGroupsDefinition: Core.DEFAULT_GROUPS_DEFINITION,
      defaultCharacterPromptGroupsDefinition: Core.DEFAULT_CHARACTER_PROMPT_GROUPS_DEFINITION,
      defaultGroupsDefinitions: getDefaultGroupsDefinitionsBySlot(),
    };
  }

  function migrateOptionalSelectorState(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? migrateStoredSelectorState(value)
      : null;
  }

  function reportStorageNotice(message, tone = "warn") {
    pendingStorageNotice = message;
    setStatus(message, tone);
  }

  async function loadSelectorState() {
    const result = await storageGet("local", [
      SELECTOR_STORAGE_KEY,
      LEGACY_SELECTOR_STORAGE_KEY,
      SELECTOR_LAST_GOOD_STORAGE_KEY,
    ]);
    const storedState = result[SELECTOR_STORAGE_KEY] || result[LEGACY_SELECTOR_STORAGE_KEY] || {};
    const migratedState = migrateStoredSelectorState(storedState);
    const migratedLastGood = migrateOptionalSelectorState(result[SELECTOR_LAST_GOOD_STORAGE_KEY]);
    const meaningfulOptions = getSelectorMeaningfulOptions();

    if (
      migratedLastGood
      && !Store.isMeaningfulSelectorState(migratedState, meaningfulOptions)
      && Store.isMeaningfulSelectorState(migratedLastGood, meaningfulOptions)
    ) {
      selectorState = migratedLastGood;
      pendingStorageNotice = "현재 저장값이 비어 있어 마지막 정상 프롬프트 상태를 복구했습니다.";
      await saveSelectorState({ reason: "recover-last-good", explicit: true, skipBackup: true });
      return;
    }

    selectorState = migratedState;
    if (!result[SELECTOR_STORAGE_KEY] && result[LEGACY_SELECTOR_STORAGE_KEY]) {
      await saveSelectorState({ reason: "migrate-legacy-selector", explicit: true, skipBackup: true });
    }
  }

  async function commitSelectorState(options = {}) {
    const {
      explicit = false,
      forceBackup = false,
      reason = "autosave",
      skipBackup = false,
    } = options;
    const result = await storageGet("local", [
      SELECTOR_STORAGE_KEY,
      SELECTOR_BACKUPS_STORAGE_KEY,
      SELECTOR_LAST_GOOD_STORAGE_KEY,
    ]);
    const previousSelector = migrateStoredSelectorState(result[SELECTOR_STORAGE_KEY] || {});
    const previousLastGood = migrateOptionalSelectorState(result[SELECTOR_LAST_GOOD_STORAGE_KEY]);
    const meaningfulOptions = getSelectorMeaningfulOptions({ explicit });
    let nextSelector = Store.cloneJson(selectorState);

    if (Store.shouldBlockEmptyRegression(previousSelector, nextSelector, meaningfulOptions)) {
      if (previousLastGood && Store.isMeaningfulSelectorState(previousLastGood, meaningfulOptions)) {
        selectorState = previousLastGood;
        nextSelector = Store.cloneJson(selectorState);
        reportStorageNotice("빈 프롬프트 상태로 덮어쓰려는 저장을 막고 마지막 정상 상태를 복구했습니다.");
        updateEditorFieldsFromActiveSlot();
        renderSlotButtons();
        renderPromptSelector();
      } else {
        reportStorageNotice("빈 프롬프트 상태로 덮어쓰려는 저장을 막았습니다. JSON 내보내기나 백업 복구를 확인하세요.");
        return { ok: false, error: "빈 프롬프트 상태로의 후퇴를 차단했습니다." };
      }
    }

    let backups = Array.isArray(result[SELECTOR_BACKUPS_STORAGE_KEY])
      ? result[SELECTOR_BACKUPS_STORAGE_KEY]
      : [];
    const shouldBackup = !skipBackup && (
      forceBackup
      || Store.shouldCreateAutomaticBackup(previousSelector, nextSelector, meaningfulOptions)
    );
    if (shouldBackup && Store.isMeaningfulSelectorState(previousSelector, meaningfulOptions)) {
      backups = Store.appendBackup(
        backups,
        Store.createBackupSnapshot(previousSelector, { reason }),
        { limit: Store.DEFAULT_BACKUP_LIMIT },
      );
    }

    const nextLastGood = Store.selectLastGoodSelector(nextSelector, previousLastGood, meaningfulOptions);
    const values = {
      [SELECTOR_STORAGE_KEY]: nextSelector,
      [SELECTOR_BACKUPS_STORAGE_KEY]: backups,
    };
    if (nextLastGood) {
      values[SELECTOR_LAST_GOOD_STORAGE_KEY] = nextLastGood;
    }

    const saveResult = await storageSet("local", values);
    if (!saveResult.ok) {
      reportStorageNotice(`프롬프트 저장에 실패했습니다: ${saveResult.error}`);
      return saveResult;
    }
    return { ok: true };
  }

  function saveSelectorState(options = {}) {
    const nextSave = selectorSaveQueue
      .catch(() => {})
      .then(() => commitSelectorState(options));
    selectorSaveQueue = nextSave;
    return nextSave;
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
      return { scope: "main", kind: "base", label: "메인 프롬프트" };
    }
    if (slotId === MAIN_UC_SLOT_ID) {
      return { scope: "main", kind: "uc", label: "네거티브 프롬프트" };
    }
    const match = String(slotId || "").match(/^character\.(\d+)\.(prompt|uc)$/);
    if (match) {
      const index = Number.parseInt(match[1], 10);
      const kind = match[2];
      return {
        scope: "character",
        index,
        kind,
        label: `캐릭터 ${index} ${kind === "prompt" ? "프롬프트" : "네거티브"}`,
      };
    }
    return null;
  }

  function makeCharacterSlotId(index, kind) {
    return `character.${index}.${kind}`;
  }

  function normalizeCharacterLabelValue(value) {
    const label = String(value ?? "").slice(0, 48);
    return label.trim() ? label : "";
  }

  function getCharacterLabel(index) {
    const numericIndex = Number.parseInt(index, 10);
    const label = getExplicitCharacterLabel(numericIndex);
    return label || Core.getNextCharacterLabel(getCharacterLabelValues());
  }

  function setCharacterLabel(index, value) {
    const numericIndex = Number.parseInt(index, 10);
    if (!Number.isFinite(numericIndex) || numericIndex < 1) {
      return;
    }
    if (!selectorState.characterLabels || typeof selectorState.characterLabels !== "object") {
      selectorState.characterLabels = {};
    }
    const label = normalizeCharacterLabelValue(value);
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
    return normalizeCharacterLabelValue(label);
  }

  function copyExplicitCharacterLabel(index, label) {
    if (!selectorState.characterLabels || typeof selectorState.characterLabels !== "object") {
      selectorState.characterLabels = {};
    }
    const numericIndex = Number.parseInt(index, 10);
    const normalizedLabel = normalizeCharacterLabelValue(label);
    if (normalizedLabel) {
      selectorState.characterLabels[numericIndex] = normalizedLabel;
    } else {
      delete selectorState.characterLabels[numericIndex];
    }
  }

  function getCharacterLabelValues() {
    return Object.values(selectorState.characterLabels || {})
      .map((label) => String(label || "").trim())
      .filter(Boolean);
  }

  function materializeCharacterLabels(characters = []) {
    if (!selectorState.characterLabels || typeof selectorState.characterLabels !== "object") {
      selectorState.characterLabels = {};
    }

    const indices = [...new Set(
      characters.map((character) => {
        const index = typeof character === "object" ? character?.index : character;
        const numericIndex = Number.parseInt(index, 10);
        return Number.isFinite(numericIndex) && numericIndex > 0 ? numericIndex : null;
      }).filter(Boolean),
    )].sort((a, b) => a - b);
    const firstKnownIndex = collectKnownCharacterIndices(characters)[0] || indices[0];

    let changed = false;
    for (const index of indices) {
      if (getExplicitCharacterLabel(index)) {
        continue;
      }
      selectorState.characterLabels[index] = index === firstKnownIndex
        ? Core.DEFAULT_CHARACTER_LABEL
        : Core.getNextCharacterLabel(getCharacterLabelValues());
      changed = true;
    }
    return changed;
  }

  function ensureFirstCharacterPromptDefault(characters = []) {
    const indices = [...new Set(
      characters.map((character) => {
        const numericIndex = Number.parseInt(character?.index, 10);
        return Number.isFinite(numericIndex) && numericIndex > 0 ? numericIndex : null;
      }).filter(Boolean),
    )].sort((a, b) => a - b);
    const firstIndex = indices[0];
    if (!firstIndex) {
      return false;
    }

    const slotId = makeCharacterSlotId(firstIndex, "prompt");
    const slotData = ensureSlot(slotId);
    if (hasSlotPromptData(slotData)) {
      return false;
    }

    slotData.groupsDefinition = Core.DEFAULT_CHARACTER_PROMPT_GROUPS_DEFINITION;
    return true;
  }

  function getSlotLabel(slotId) {
    const parsed = parseSlotId(slotId);
    if (parsed?.scope === "character") {
      return `${getCharacterLabel(parsed.index)} ${parsed.kind === "prompt" ? "프롬프트" : "네거티브"}`;
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
    scan.defaultedCharacterPrompt = ensureFirstCharacterPromptDefault(scan.characters);

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
    let materializedCharacterLabels = false;
    if (!pruneMissingCharacters && !forcePruneMissingCharacters) {
      materializedCharacterLabels = materializeCharacterLabels(scan.characters);
    }
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
          materializedCharacterLabels = true;
        }
      }
    }
    materializedCharacterLabels = materializeCharacterLabels(scan.characters) || materializedCharacterLabels;

    if (!currentSlotIds.has(selectorState.activeSlotId)) {
      const activeSlot = parseSlotId(selectorState.activeSlotId);
      if (activeSlot?.scope !== "character" || shouldPruneMissingCharacters) {
        selectorState.activeSlotId = MAIN_BASE_SLOT_ID;
      }
    }

    if (reconciledCharacters || materializedCharacterLabels || scan.defaultedCharacterPrompt) {
      void saveSelectorState();
    }

    return {
      scan,
      currentSlotIds,
      prunedMissingCharacters: shouldPruneMissingCharacters,
      materializedCharacterLabels,
    };
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

  async function getEditorForParsedSlot(parsed) {
    if (parsed?.scope === "main") {
      return getMainEditorForKind(parsed.kind);
    }
    if (parsed?.scope === "character") {
      return getCharacterEditorForKind(parsed.index, parsed.kind);
    }
    return null;
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

    const editor = await getEditorForParsedSlot(parsed);
    if (!editor) {
      const message = `${getSlotLabel(slotId)}에 대응하는 NovelAI 입력 영역을 찾지 못했습니다.`;
      if (!silent) {
        setStatus(message, "warn");
      }
      return { ok: false, error: message, missing: true };
    }

    setEditablePlainText(editor, prompt);
    const settled = await waitForEditableTextSettled(editor, prompt, {
      resolveEditor: () => getEditorForParsedSlot(parsed),
    });
    if (!settled.ok) {
      const message = `${getSlotLabel(slotId)} 슬롯 적용이 NovelAI 입력 영역에 안정적으로 반영되지 않았습니다.`;
      if (!silent) {
        setStatus(message, "warn");
      }
      return { ok: false, error: message, timeout: true };
    }
    if (!silent) {
      setStatus(`${getSlotLabel(slotId)} 슬롯을 NovelAI에 적용했습니다.`, "ok");
    }
    return { ok: true, prompt };
  }

  async function applyActiveSlotToNovelAi({ silent = false } = {}) {
    return trackPromptApply(async () => {
      ensurePanel();
      const result = await applySlotToNovelAi(getActiveSlotId(), { skipEmpty: false, silent });
      if (result.ok) {
        await waitForPromptApplyFlush();
      }
      return result;
    });
  }

  async function applyAllSlotsToNovelAi({ silent = false } = {}) {
    return trackPromptApply(async () => {
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

      if (errors.length > 0) {
        const message = errors[0];
        if (!silent) {
          setStatus(message, "warn");
        }
        return { ok: false, error: message, appliedCount };
      }

      if (appliedCount > 0) {
        await waitForPromptApplyFlush();
        setStatus(`총 ${appliedCount}개 슬롯을 NovelAI에 적용했습니다.`, "ok");
        return { ok: true, appliedCount };
      }

      const message = "적용할 슬롯 프롬프트가 없습니다.";
      if (!silent) {
        setStatus(message, "warn");
      }
      return { ok: false, error: message, appliedCount };
    });
  }

  async function addNovelAiCharacter(kind = "Female") {
    ensurePanel();
    const addButton = findAddCharacterButton();
    if (!addButton) {
      const message = "캐릭터 추가 버튼을 찾지 못했습니다.";
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
      materializeCharacterLabels([{ index: newIndex }]);
      setSelectedCharacterIndex(newIndex, { selectPromptSlot: true });
      selectorState.activePanelTab = getCharacterPanelTabId(newIndex);
      pendingDeleteCharacterIndex = null;
    }
    await saveSelectorState({ reason: "add-character", explicit: true });
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
    setStatus(`Character ${newIndex || ""}를 추가했습니다.`, "ok");
    return { ok: true, characterIndex: newIndex };
  }

  async function moveNovelAiCharacter(direction) {
    ensurePanel();
    const scan = scanNovelAiPromptSlots();
    materializeCharacterLabels(scan.characters);
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
    await saveSelectorState({ reason: "move-character", explicit: true });
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
    materializeCharacterLabels(scan.characters);
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
    await saveSelectorState({ reason: "delete-character", explicit: true, forceBackup: true });
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
    void saveSelectorState({ reason: "external-character-prune", explicit: true, forceBackup: true });
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
    const scan = scanNovelAiPromptSlots();
    materializeCharacterLabels(scan.characters);
    const indices = getCurrentCharacterIndices(scan);
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
      return `경고: 현재 생성 비용이 ${numericCost} Anlas입니다.`;
    }
    return "";
  }

  function confirmAutoGenerationCost() {
    const warning = checkGenerationCost();
    if (!warning) {
      return true;
    }

    setStatus(warning, "warn");
    return confirm(`${warning}\n\n이 비용으로 자동 생성을 시작할까요?`);
  }

  function runSafetyChecks({ alertUser = true, allowNonZeroGenerationCost = false } = {}) {
    if (!location.href.startsWith("https://novelai.net/image")) {
      const message = "NovelAI 이미지 페이지에서만 사용할 수 있습니다.";
      setStatus(message, "warn");
      if (alertUser) {
        alert(message);
      }
      return false;
    }

    const warning = checkUndesiredContent() || (allowNonZeroGenerationCost ? "" : checkGenerationCost());
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
    const historyContainer = findHistoryContainer();
    const root = historyContainer || document;
    const primaryItems = historyContainer
      ? Array.from(historyContainer.querySelectorAll(HISTORY_ITEM_SELECTOR))
      : [];
    if (primaryItems.length) {
      return primaryItems;
    }

    const candidates = Array.from(root.querySelectorAll(`${HISTORY_ITEM_SELECTOR}, [role="button"], button, [draggable="true"]`))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => !element.closest("#nai-prompt-selector-host"))
      .filter(isVisible)
      .filter((element) => element.querySelector("img") || getImageUrlCandidates(element).length > 0);

    return candidates.filter((item, index) => candidates.indexOf(item) === index);
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

  function isPromptSelectorEvent(event) {
    if (!panelHost) {
      return false;
    }
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.includes(panelHost) || panelHost.contains(event.target);
  }

  function normalizeImageUrl(url) {
    const value = String(url || "").trim();
    if (!value) {
      return "";
    }
    try {
      return new URL(value, location.href).href;
    } catch (error) {
      return value;
    }
  }

  function addCssImageUrls(value, urls) {
    const text = String(value || "");
    const pattern = /url\((['"]?)(.*?)\1\)/g;
    let match = pattern.exec(text);
    while (match) {
      const normalized = normalizeImageUrl(match[2]);
      if (normalized) {
        urls.add(normalized);
      }
      match = pattern.exec(text);
    }
  }

  function getImageUrlCandidates(root) {
    const urls = new Set();
    const addImage = (image) => {
      const currentSrc = normalizeImageUrl(image.currentSrc);
      const src = normalizeImageUrl(image.src);
      if (currentSrc) {
        urls.add(currentSrc);
      }
      if (src) {
        urls.add(src);
      }
    };

    if (root instanceof HTMLImageElement) {
      addImage(root);
    }
    if (root instanceof Element) {
      root.querySelectorAll("img").forEach(addImage);
      [root, ...Array.from(root.querySelectorAll("*"))].forEach((element) => {
        addCssImageUrls(window.getComputedStyle(element).backgroundImage, urls);
      });
    }

    return Array.from(urls);
  }

  function historyItemHasAnyUrl(item, sourceUrls) {
    if (!sourceUrls?.size) {
      return false;
    }
    return getImageUrlCandidates(item).some((url) => sourceUrls.has(url));
  }

  function findHistoryItemByImageUrls(items, urls) {
    const sourceUrls = new Set((urls || []).map(normalizeImageUrl).filter(Boolean));
    if (!sourceUrls.size) {
      return null;
    }
    return items.find((item) => historyItemHasAnyUrl(item, sourceUrls)) || null;
  }

  function isSelectedHistoryItem(item) {
    const ariaSelected = item.getAttribute("aria-selected");
    const ariaCurrent = item.getAttribute("aria-current");
    const dataSelected = item.getAttribute("data-selected");
    const className = typeof item.className === "string" ? item.className : "";
    return ariaSelected === "true"
      || (ariaCurrent && ariaCurrent !== "false")
      || (dataSelected && dataSelected !== "false")
      || /\b(selected|active|current)\b/i.test(className);
  }

  function findSelectedHistoryItem(items = findHistoryItems()) {
    return items.find(isSelectedHistoryItem) || null;
  }

  function isAvailableHistoryItem(item) {
    return item instanceof HTMLElement
      && findHistoryItems().includes(item)
      && isVisible(item);
  }

  function createHistorySourceSnapshot(item, items = findHistoryItems()) {
    if (!item) {
      return null;
    }
    const index = items.indexOf(item);
    return {
      item,
      urls: getImageUrlCandidates(item),
      index,
      historyCount: items.length,
    };
  }

  function findHistoryItemFromTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    const directItem = target.closest(HISTORY_ITEM_SELECTOR);
    const items = findHistoryItems();
    if (directItem && items.includes(directItem)) {
      return directItem;
    }
    return items.find((item) => item === target || item.contains(target)) || null;
  }

  function rememberHistoryItemClick(event) {
    const item = findHistoryItemFromTarget(event.target);
    if (item) {
      lastClickedHistoryItem = item;
      lastKnownHistorySource = createHistorySourceSnapshot(item);
    }
  }

  function createEnhanceSourceDescriptor() {
    const items = findHistoryItems();
    const currentImageUrls = getImageUrlCandidates(findCurrentImage());
    let sourceItem = findHistoryItemByImageUrls(items, currentImageUrls);
    if (!sourceItem) {
      sourceItem = findSelectedHistoryItem(items);
    }
    if (!sourceItem && isAvailableHistoryItem(lastClickedHistoryItem)) {
      sourceItem = lastClickedHistoryItem;
    }
    if (!sourceItem && lastKnownHistorySource) {
      sourceItem = findHistoryItemByImageUrls(items, lastKnownHistorySource.urls)
        || (lastKnownHistorySource.item && items.includes(lastKnownHistorySource.item) ? lastKnownHistorySource.item : null);
    }

    const sourceSnapshot = createHistorySourceSnapshot(sourceItem, items) || lastKnownHistorySource;
    return {
      item: sourceSnapshot?.item || sourceItem,
      currentImageUrls,
      sourceItemUrls: sourceSnapshot?.urls || [],
      sourceIndex: Number.isFinite(sourceSnapshot?.index) ? sourceSnapshot.index : -1,
      initialHistoryCount: sourceSnapshot?.historyCount || items.length,
    };
  }

  function findHistoryItemByShiftedIndex(items, descriptor) {
    const sourceIndex = Number.parseInt(descriptor?.sourceIndex, 10);
    const initialHistoryCount = Number.parseInt(descriptor?.initialHistoryCount, 10);
    if (!Number.isFinite(sourceIndex) || sourceIndex < 0 || !Number.isFinite(initialHistoryCount) || initialHistoryCount <= 0) {
      return null;
    }
    const insertedBeforeCount = Math.max(0, items.length - initialHistoryCount);
    return items[sourceIndex + insertedBeforeCount] || items[sourceIndex] || null;
  }

  function resolveEnhanceSourceItem(descriptor) {
    const items = findHistoryItems();
    return findHistoryItemByImageUrls(items, descriptor.currentImageUrls)
      || findHistoryItemByImageUrls(items, descriptor.sourceItemUrls)
      || (descriptor.item && items.includes(descriptor.item) && isVisible(descriptor.item) ? descriptor.item : null)
      || findHistoryItemByShiftedIndex(items, descriptor);
  }

  function ensureHighlightPosition(item) {
    const computedStyle = window.getComputedStyle(item);
    if (computedStyle.position === "static" && !item.dataset.originalPosition) {
      item.dataset.originalPosition = "static";
      item.style.position = "relative";
    }
  }

  function applyEnhanceSourceHighlight(descriptor, token) {
    if (token !== enhanceHighlightToken) {
      return false;
    }
    const item = resolveEnhanceSourceItem(descriptor);
    if (!item) {
      return false;
    }
    const currentMarkedItem = document.querySelector(".nai-pm-enhance-source-highlight");
    if (currentMarkedItem === item && item.querySelector(".nai-pm-enhance-source-marker")) {
      return true;
    }

    clearAllHighlights({ preserveEnhanceToken: true });
    ensureHighlightPosition(item);

    const marker = document.createElement("div");
    marker.className = "nai-pm-enhance-source-marker";
    marker.title = "Enhance source image";
    item.appendChild(marker);
    item.classList.add("nai-pm-enhance-source-highlight");
    return true;
  }

  function stopEnhanceHistoryObserver() {
    if (!enhanceHistoryObserver) {
      return;
    }
    enhanceHistoryObserver.observer?.disconnect();
    if (enhanceHistoryObserver.timeoutId) {
      window.clearTimeout(enhanceHistoryObserver.timeoutId);
    }
    enhanceHistoryObserver = null;
  }

  function startEnhanceHistoryObserver(descriptor, token) {
    if (!window.MutationObserver) {
      return;
    }
    const historyContainer = findHistoryContainer();
    if (!historyContainer) {
      return;
    }

    stopEnhanceHistoryObserver();
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (token !== enhanceHighlightToken) {
        stopEnhanceHistoryObserver();
        return;
      }
      if (scheduled) {
        return;
      }
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        applyEnhanceSourceHighlight(descriptor, token);
      });
    });
    observer.observe(historyContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-selected", "aria-current", "data-selected", "style"],
    });

    const timeoutId = window.setTimeout(() => {
      if (enhanceHistoryObserver?.observer === observer) {
        stopEnhanceHistoryObserver();
      }
    }, ENHANCE_SOURCE_OBSERVE_MS);
    enhanceHistoryObserver = { observer, timeoutId };
  }

  function isEnhanceButton(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const values = [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ].map((value) => String(value || "").trim().replace(/\s+/g, " "));
    return values.some((value) => /\bEnhance\b/i.test(value));
  }

  function handleEnhanceClick(event) {
    if (isPromptSelectorEvent(event)) {
      return false;
    }
    const button = event.target instanceof Element
      ? event.target.closest('button, [role="button"]')
      : null;
    if (!isEnhanceButton(button)) {
      return false;
    }

    const descriptor = createEnhanceSourceDescriptor();
    stopEnhanceHistoryObserver();
    enhanceHighlightToken += 1;
    const token = enhanceHighlightToken;
    let hasHighlighted = false;
    clearAllHighlights({ preserveEnhanceToken: true });
    startEnhanceHistoryObserver(descriptor, token);

    ENHANCE_SOURCE_REAPPLY_DELAYS_MS.forEach((delayMs, index) => {
      const run = () => {
        if (token !== enhanceHighlightToken) {
          return;
        }
        if (applyEnhanceSourceHighlight(descriptor, token)) {
          hasHighlighted = true;
        } else if (index === ENHANCE_SOURCE_REAPPLY_DELAYS_MS.length - 1 && !hasHighlighted) {
          setStatus("Enhance 원본 히스토리 항목을 찾지 못했습니다.", "warn");
        }
      };
      if (delayMs > 0) {
        window.setTimeout(run, delayMs);
      } else {
        run();
      }
    });
    return true;
  }

  function clearAllHighlights({ preserveEnhanceToken = false } = {}) {
    if (!preserveEnhanceToken) {
      enhanceHighlightToken += 1;
      stopEnhanceHistoryObserver();
    }
    const markers = document.querySelectorAll(".nai-toolbar-highlight-marker, .nai-pm-highlight-marker, .nai-pm-enhance-source-marker");
    markers.forEach((element) => element.remove());

    const previousHighlights = document.querySelectorAll(".nai-toolbar-highlight, .nai-pm-history-highlight, .nai-pm-enhance-source-highlight");
    previousHighlights.forEach((element) => {
      element.classList.remove("nai-toolbar-highlight", "nai-pm-history-highlight", "nai-pm-enhance-source-highlight");
      if (element.dataset.originalPosition) {
        element.style.position = element.dataset.originalPosition;
        delete element.dataset.originalPosition;
      }
      if (element.dataset.naiPmOriginalPosition) {
        element.style.position = element.dataset.naiPmOriginalPosition === "static" ? "" : element.dataset.naiPmOriginalPosition;
        delete element.dataset.naiPmOriginalPosition;
      }
    });
  }

  function highlightRecentHistory(count) {
    const safeCount = Math.max(0, Number.parseInt(count, 10) || 0);
    clearAllHighlights();
    if (!safeCount) {
      return;
    }

    const historyContainer = document.getElementById("historyContainer");
    if (!historyContainer) {
      return;
    }

    const items = Array.from(historyContainer.querySelectorAll(HISTORY_ITEM_SELECTOR));
    for (let index = 0; index < safeCount && index < items.length; index += 1) {
      const item = items[index];
      ensureHighlightPosition(item);

      const marker = document.createElement("div");
      marker.className = "nai-toolbar-highlight-marker";
      marker.style.cssText = [
        "position:absolute",
        "top:0",
        "left:0",
        "width:0",
        "height:0",
        "border-top:20px solid #00b0f4",
        "border-right:20px solid transparent",
        "z-index:10",
        "pointer-events:none",
      ].join(";");
      item.appendChild(marker);
      item.classList.add("nai-toolbar-highlight");
    }
  }

  function showAutoCompletionFeedback(count) {
    highlightRecentHistory(count);
    showCompletionOverlay(count);
    chrome.runtime.sendMessage({ action: "showCompletionNotification", count });
    setStatus(`자동 생성 완료: ${count}장`, "ok");
  }

  function cancelAutoHistoryHighlightWait() {
    autoHistoryHighlightWait.token += 1;
    if (autoHistoryHighlightWait.intervalId) {
      clearInterval(autoHistoryHighlightWait.intervalId);
      autoHistoryHighlightWait.intervalId = null;
    }
  }

  function waitForAutoHistoryThenRun(count, initialHistoryCount, callback) {
    const safeCount = Math.max(0, Number.parseInt(count, 10) || 0);
    cancelAutoHistoryHighlightWait();
    const token = autoHistoryHighlightWait.token;
    if (!safeCount) {
      callback(0);
      return;
    }

    let attempts = 0;
    const safeInitialHistoryCount = Math.max(0, Number.parseInt(initialHistoryCount, 10) || 0);
    const checkInterval = setInterval(() => {
      if (token !== autoHistoryHighlightWait.token) {
        clearInterval(checkInterval);
        return;
      }
      attempts += 1;
      const historyContainer = document.getElementById("historyContainer");
      const currentCount = historyContainer
        ? historyContainer.querySelectorAll(HISTORY_ITEM_SELECTOR).length
        : 0;
      if (currentCount >= safeInitialHistoryCount + safeCount || attempts > 50) {
        clearInterval(checkInterval);
        if (autoHistoryHighlightWait.intervalId === checkInterval) {
          autoHistoryHighlightWait.intervalId = null;
        }
        callback(safeCount);
      }
    }, 200);
    autoHistoryHighlightWait.intervalId = checkInterval;
  }

  function waitForHistoryThenShowCompletion(count, initialHistoryCount = autoRun.initialHistoryCount) {
    waitForAutoHistoryThenRun(count, initialHistoryCount, (readyCount) => {
      if (!readyCount) {
        clearAllHighlights();
      }
      showAutoCompletionFeedback(readyCount);
    });
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

  function isGenerationCancelled(shouldContinue) {
    return typeof shouldContinue === "function" && !shouldContinue();
  }

  function getGenerationCancelledResult() {
    return { ok: false, cancelled: true, error: "생성이 취소되었습니다." };
  }

  async function clickGenerate({
    useSelector = false,
    silent = false,
    allowNonZeroGenerationCost = false,
    shouldContinue = null,
  } = {}) {
    const pendingApply = await waitForPendingPromptApply({ silent });
    if (!pendingApply.ok) {
      return pendingApply;
    }
    if (isGenerationCancelled(shouldContinue)) {
      return getGenerationCancelledResult();
    }

    if (!runSafetyChecks({ alertUser: !silent, allowNonZeroGenerationCost })) {
      return { ok: false, error: "Safety check failed." };
    }

    if (useSelector) {
      const applied = await applyAllSlotsToNovelAi({ silent });
      if (!applied.ok) {
        return applied;
      }
      await waitForPromptApplyFlush();
    } else {
      const promptReady = await waitForPendingPromptApply({ silent });
      if (!promptReady.ok) {
        return promptReady;
      }
    }
    if (isGenerationCancelled(shouldContinue)) {
      return getGenerationCancelledResult();
    }

    const button = findGenerateButton();
    if (!button) {
      const message = "생성 버튼을 찾지 못했습니다.";
      setStatus(message, "warn");
      if (!silent) {
        alert(message);
      }
      return { ok: false, error: message };
    }
    if (button.disabled) {
      const message = "생성 버튼이 아직 비활성화 상태입니다.";
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

  function createStoppedAutoHighlightSnapshot() {
    const count = Math.max(0, Number.parseInt(autoRun.count, 10) || 0);
    const completedCount = Math.max(0, Number.parseInt(autoRun.completedCount, 10) || 0);
    return {
      count: autoRun.waitingForCompletion ? count : completedCount,
      initialHistoryCount: Math.max(0, Number.parseInt(autoRun.initialHistoryCount, 10) || 0),
    };
  }

  function highlightStoppedAutoHistory(snapshot) {
    const count = Math.max(0, Number.parseInt(snapshot?.count, 10) || 0);
    if (!count) {
      return false;
    }

    waitForAutoHistoryThenRun(count, snapshot.initialHistoryCount, (readyCount) => {
      highlightRecentHistory(readyCount);
      setStatus(`자동 생성을 중지했습니다. 생성된 ${readyCount}장을 히스토리에서 강조했습니다.`, "ok");
    });
    return true;
  }

  async function stopAutoGenerate({ playAudio = false, highlightGenerated = true } = {}) {
    const wasActive = autoRun.active;
    const stoppedHighlightSnapshot = highlightGenerated && wasActive
      ? createStoppedAutoHighlightSnapshot()
      : null;
    if (wasActive || !highlightGenerated) {
      cancelAutoHistoryHighlightWait();
    }
    clearAutoTimers();
    autoRun.token += 1;
    autoRun.active = false;
    autoRun.waitingForCompletion = false;
    autoRun.waitingForExistingGeneration = false;
    await storageSet("sync", { autoClickEnabled: false });
    renderAutoRunControls();
    if (playAudio && wasActive) {
      await playSound("stop.mp3");
    }
    setStatus(wasActive ? "자동 생성을 중지했습니다." : "자동 생성이 실행 중이 아닙니다.", wasActive ? "ok" : "warn");
    if (stoppedHighlightSnapshot) {
      highlightStoppedAutoHistory(stoppedHighlightSnapshot);
    }
    return { ok: true };
  }

  async function clickForAutoRun() {
    const token = autoRun.token;
    const result = await clickGenerate({
      useSelector: autoRun.useSelector,
      silent: true,
      allowNonZeroGenerationCost: true,
      shouldContinue: () => autoRun.active && token === autoRun.token,
    });
    if (!result.ok) {
      return result;
    }
    autoRun.count += 1;
    autoRun.waitingForCompletion = true;
    autoRun.waitingForExistingGeneration = false;
    autoRun.ignoreReadyUntil = Date.now() + 900;
    renderAutoRunControls();
    setStatus(`자동 생성 진행 중: ${autoRun.count}${autoRun.target ? ` / ${autoRun.target}` : ""}`, "ok");
    return result;
  }

  async function completeAutoRun() {
    const count = autoRun.completedCount || autoRun.count;
    const initialHistoryCount = autoRun.initialHistoryCount;
    clearAutoTimers();
    autoRun.active = false;
    autoRun.waitingForCompletion = false;
    autoRun.waitingForExistingGeneration = false;
    await storageSet("sync", { autoClickEnabled: false });
    renderAutoRunControls();

    waitForHistoryThenShowCompletion(count, initialHistoryCount);
  }

  async function scheduleNextAutoClick({ afterExistingGeneration = false } = {}) {
    const token = autoRun.token;
    const { intervalTime = 3 } = await storageGet("sync", ["intervalTime"]);
    const intervalSeconds = Math.max(0.1, Number.parseFloat(intervalTime) || 3);
    if (!autoRun.active || token !== autoRun.token) {
      return;
    }
    if (autoRun.timeoutId) {
      clearTimeout(autoRun.timeoutId);
      autoRun.timeoutId = null;
    }
    if (afterExistingGeneration) {
      setStatus(`현재 생성 완료: ${intervalSeconds}초 후 자동 생성을 시작합니다.`, "ok");
    }
    autoRun.timeoutId = setTimeout(async () => {
      autoRun.timeoutId = null;
      if (!autoRun.active || token !== autoRun.token) {
        return;
      }
      if (!runSafetyChecks({ alertUser: true, allowNonZeroGenerationCost: true })) {
        await stopAutoGenerate({ playAudio: true });
        chrome.runtime.sendMessage({ action: "resetPopupButtons" });
        return;
      }
      const result = await clickForAutoRun();
      if (!result.ok && !result.cancelled) {
        await stopAutoGenerate({ playAudio: true });
      }
    }, intervalSeconds * 1000);
  }

  async function handleAutoProgress() {
    const waitsForReadyButton = autoRun.waitingForCompletion || autoRun.waitingForExistingGeneration;
    if (!autoRun.active || !waitsForReadyButton || Date.now() < autoRun.ignoreReadyUntil) {
      return;
    }

    const button = findGenerateButton();
    if (!button || button.disabled) {
      return;
    }

    if (autoRun.waitingForExistingGeneration) {
      autoRun.waitingForExistingGeneration = false;
      renderAutoRunControls();
      await scheduleNextAutoClick({ afterExistingGeneration: true });
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

    await scheduleNextAutoClick();
  }

  async function startAutoGenerate({ useSelector = false } = {}) {
    const pendingApply = await waitForPendingPromptApply();
    if (!pendingApply.ok) {
      return pendingApply;
    }

    if (!runSafetyChecks({ alertUser: true, allowNonZeroGenerationCost: true })) {
      return { ok: false, error: "Safety check failed." };
    }
    if (!confirmAutoGenerationCost()) {
      const message = "자동 생성을 취소했습니다.";
      setStatus(message, "warn");
      return { ok: false, cancelled: true, error: message };
    }

    await stopAutoGenerate({ playAudio: false, highlightGenerated: false });
    autoRun.token += 1;
    const { gcount = "", intervalTime = ui.intervalInput?.value ?? 3 } = await storageGet("sync", ["gcount", "intervalTime"]);
    setAutoTimingInputs({ intervalTime, gcount });
    autoRun.active = true;
    autoRun.count = 0;
    autoRun.completedCount = 0;
    autoRun.target = Math.max(0, Number.parseInt(gcount, 10) || 0);
    autoRun.initialHistoryCount = findHistoryItems().length;
    autoRun.useSelector = Boolean(useSelector);
    autoRun.waitingForCompletion = false;
    autoRun.waitingForExistingGeneration = false;
    autoRun.ignoreReadyUntil = 0;
    renderAutoRunControls();
    setPanelCollapsed(true);

    await storageSet("sync", { autoClickEnabled: true });
    await playSound("start.mp3");
    chrome.runtime.sendMessage({ action: "closePopup" });

    autoRun.timerId = setInterval(() => {
      void handleAutoProgress();
    }, AUTO_REFRESH_MS);

    const generateButton = findGenerateButton();
    if (generateButton?.disabled) {
      autoRun.waitingForExistingGeneration = true;
      autoRun.ignoreReadyUntil = Date.now() + 900;
      renderAutoRunControls();
      setStatus("현재 생성 완료를 기다린 뒤 자동 생성을 시작합니다.", "ok");
      return { ok: true, delayed: true };
    }

    const result = await clickForAutoRun();
    if (!result.ok) {
      if (!result.cancelled) {
        await stopAutoGenerate({ playAudio: true });
      }
      return result;
    }

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
      const label = ui.collapsedAutoButton.querySelector(".nps-btn-label");
      const icon = ui.collapsedAutoButton.querySelector(".nps-icon");
      if (icon) {
        icon.classList.toggle("nps-icon-play", !autoRun.active);
        icon.classList.toggle("nps-icon-stop", autoRun.active);
      }
      if (label) {
        label.textContent = autoRun.active ? "중지" : "시작";
      } else {
        ui.collapsedAutoButton.textContent = autoRun.active ? "중지" : "시작";
      }
      ui.collapsedAutoButton.dataset.active = autoRun.active ? "true" : "false";
      ui.collapsedAutoButton.title = autoRun.active ? "자동 생성 중지" : "자동 생성 시작";
    }
    if (ui.autoButton) {
      const label = ui.autoButton.querySelector(".nps-btn-label");
      if (label) {
        label.textContent = autoRun.active ? "자동 중지" : "자동";
      } else {
        ui.autoButton.textContent = autoRun.active ? "자동 중지" : "자동";
      }
      ui.autoButton.dataset.active = autoRun.active ? "true" : "false";
    }
  }

  function renderPromptPreview() {
    if (!ui.preview) {
      return;
    }
    const prompt = buildCurrentPrompt();
    ui.preview.textContent = prompt || "선택된 프롬프트가 없습니다.";
    ui.preview.classList.toggle("is-empty", !prompt);
    if (ui.copyButton) {
      ui.copyButton.disabled = !prompt;
    }
    if (ui.promptMeta) {
      const lines = prompt ? prompt.split(/\r?\n/).length : 0;
      ui.promptMeta.textContent = prompt ? `${prompt.length}자 / ${lines}줄` : "비어 있음";
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
        summary.textContent = "메인 프롬프트 전용";
      }
      return;
    }

    const { groups, selectionState } = parseSlotSelectorState(getActiveSlotId(), mode);
    groupList.replaceChildren();
    if (summary) {
      summary.textContent = `${groups.length}개 그룹`;
    }

    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "nps-empty";
        empty.textContent = "그룹 형식 예시:\n\n[Quality]\nnewest\nbest quality\n\n[Character]\n1girl";
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
      meta.textContent = `${selectedCount}개 선택 / ${group.items.length}개`;
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

  function getPanelBodyScrollTop() {
    return Number.parseFloat(ui.body?.scrollTop) || 0;
  }

  function restorePanelBodyScrollTop(scrollTop) {
    if (!ui.body) {
      return;
    }
    ui.body.scrollTop = Math.max(0, Number.parseFloat(scrollTop) || 0);
  }

  function preservePanelBodyScroll(callback) {
    const scrollTop = getPanelBodyScrollTop();
    callback();
    restorePanelBodyScrollTop(scrollTop);
    requestAnimationFrame(() => restorePanelBodyScrollTop(scrollTop));
  }

  function setResizableEditorHeight(element, height) {
    if (!element) {
      return;
    }
    const normalizedHeight = sanitizeEditorHeight(height);
    if (normalizedHeight) {
      element.style.height = `${normalizedHeight}px`;
    } else {
      element.style.removeProperty("height");
    }
  }

  function applyEditorHeightsFromState() {
    const heights = sanitizeEditorHeights(selectorState.editorHeights);
    selectorState.editorHeights = heights;
    preservePanelBodyScroll(() => {
      setResizableEditorHeight(ui.editorShell, heights.groupsDefinition);
      setResizableEditorHeight(ui.quickInput, heights.quickPrompt);
      renderEditorLineNumbers();
    });
  }

  function getVisibleResizableHeight(element) {
    if (!element?.isConnected || !element.getClientRects?.().length) {
      return null;
    }
    const height = element.getBoundingClientRect?.().height;
    return sanitizeEditorHeight(height);
  }

  function scheduleEditorHeightSave() {
    if (editorHeightSaveTimer) {
      clearTimeout(editorHeightSaveTimer);
    }
    editorHeightSaveTimer = window.setTimeout(() => {
      editorHeightSaveTimer = null;
      void saveSelectorState({ reason: "resize-editor-heights" });
    }, EDITOR_HEIGHT_SAVE_DELAY_MS);
  }

  function captureEditorHeightsFromDom({ save = true, fields = null } = {}) {
    const scrollTop = getPanelBodyScrollTop();
    const previous = sanitizeEditorHeights(selectorState.editorHeights);
    const next = { ...previous };
    const shouldCaptureGroupsDefinition = !fields || fields.includes("groupsDefinition");
    const shouldCaptureQuickPrompt = !fields || fields.includes("quickPrompt");
    const groupsDefinitionHeight = shouldCaptureGroupsDefinition
      ? getVisibleResizableHeight(ui.editorShell)
      : null;
    const quickPromptHeight = shouldCaptureQuickPrompt
      ? getVisibleResizableHeight(ui.quickInput)
      : null;

    if (groupsDefinitionHeight) {
      next.groupsDefinition = groupsDefinitionHeight;
    }
    if (quickPromptHeight) {
      next.quickPrompt = quickPromptHeight;
    }
    if (
      next.groupsDefinition === previous.groupsDefinition
      && next.quickPrompt === previous.quickPrompt
    ) {
      return;
    }

    selectorState.editorHeights = next;
    restorePanelBodyScrollTop(scrollTop);
    if (save) {
      scheduleEditorHeightSave();
    }
  }

  function getEditorResizeTargetFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(ui.editorShell)) {
      return { field: "groupsDefinition", element: ui.editorShell };
    }
    if (path.includes(ui.quickInput)) {
      return { field: "quickPrompt", element: ui.quickInput };
    }
    return null;
  }

  function startEditorResizeInteraction(event) {
    if (event.button != null && event.button !== 0) {
      return;
    }
    const target = getEditorResizeTargetFromEvent(event);
    const height = getVisibleResizableHeight(target?.element);
    if (!target || !height) {
      return;
    }
    editorResizeInteraction = {
      field: target.field,
      element: target.element,
      startHeight: height,
    };
  }

  function finishEditorResizeInteraction() {
    const interaction = editorResizeInteraction;
    editorResizeInteraction = null;
    if (!interaction?.element) {
      return;
    }
    const nextHeight = getVisibleResizableHeight(interaction.element);
    if (!nextHeight || Math.abs(nextHeight - interaction.startHeight) <= EDITOR_RESIZE_HEIGHT_THRESHOLD_PX) {
      return;
    }

    suppressEditorResizeClickUntil = Date.now() + EDITOR_RESIZE_CLICK_SUPPRESS_MS;
    captureEditorHeightsFromDom({ fields: [interaction.field] });
  }

  function suppressClickAfterEditorResize(event) {
    if (Date.now() > suppressEditorResizeClickUntil) {
      return;
    }
    suppressEditorResizeClickUntil = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
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

  function normalizeAutoInterval(value) {
    return Math.max(0.1, Number.parseFloat(value) || 3);
  }

  function normalizeAutoCount(value) {
    const rawCount = Number.parseInt(value, 10);
    return Number.isFinite(rawCount) && rawCount > 0 ? rawCount : "";
  }

  function normalizeAutoVolume(value) {
    const rawVolume = Number(value);
    return Number.isFinite(rawVolume) ? Math.max(0, Math.min(1, rawVolume)) : 0.5;
  }

  function setAutoTimingInputs({ intervalTime = 3, gcount = "" } = {}) {
    const intervalSeconds = normalizeAutoInterval(intervalTime);
    const count = normalizeAutoCount(gcount);
    const intervalText = String(intervalSeconds);
    const countText = String(count);
    for (const input of [ui.intervalInput, ui.collapsedIntervalInput]) {
      if (input) {
        input.value = intervalText;
      }
    }
    for (const input of [ui.countInput, ui.collapsedCountInput]) {
      if (input) {
        input.value = countText;
      }
    }
  }

  function setAutoPreferenceInputs(settings = {}) {
    if (Object.prototype.hasOwnProperty.call(settings, "autoSaveEnabled") && ui.autoSaveToggle) {
      const { autoSaveEnabled = false } = settings;
      ui.autoSaveToggle.checked = Boolean(autoSaveEnabled);
    }
    if (
      Object.prototype.hasOwnProperty.call(settings, "autoCompletionNotificationEnabled")
      && ui.autoNotificationToggle
    ) {
      const { autoCompletionNotificationEnabled = true } = settings;
      ui.autoNotificationToggle.checked = autoCompletionNotificationEnabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(settings, "volume")) {
      const volumePercent = Math.round(normalizeAutoVolume(settings.volume) * 100);
      if (ui.autoVolumeSlider) {
        ui.autoVolumeSlider.value = String(volumePercent);
      }
      if (ui.autoVolumeValue) {
        ui.autoVolumeValue.textContent = `${volumePercent}%`;
      }
    }
  }

  function setAutoSettingsInputs(settings = {}, { updateTiming = true } = {}) {
    if (updateTiming) {
      setAutoTimingInputs(settings);
    }
    setAutoPreferenceInputs(settings);
    renderAutoRunControls();
  }

  function readAutoTimingInputs(source = "expanded") {
    const countInput = source === "collapsed" ? ui.collapsedCountInput : ui.countInput;
    const intervalInput = source === "collapsed" ? ui.collapsedIntervalInput : ui.intervalInput;
    return {
      intervalTime: normalizeAutoInterval(intervalInput?.value),
      gcount: normalizeAutoCount(countInput?.value),
    };
  }

  async function loadAutoSettingsIntoPanel() {
    const {
      intervalTime = 3,
      gcount = "",
      autoSaveEnabled = false,
      volume = 0.5,
      autoCompletionNotificationEnabled = true,
    } = await storageGet("sync", AUTO_SETTINGS_KEYS);
    setAutoSettingsInputs({
      intervalTime,
      gcount,
      autoSaveEnabled,
      volume,
      autoCompletionNotificationEnabled,
    });
  }

  function saveAutoSettingsFromPanel({ source = "expanded" } = {}) {
    const settings = readAutoTimingInputs(source);
    setAutoTimingInputs(settings);
    renderAutoRunControls();
    return storageSet("sync", settings);
  }

  function saveAutoPreferencesFromPanel() {
    const volume = normalizeAutoVolume(Number(ui.autoVolumeSlider?.value) / 100);
    const settings = {
      autoSaveEnabled: Boolean(ui.autoSaveToggle?.checked),
      volume,
      autoCompletionNotificationEnabled: ui.autoNotificationToggle?.checked !== false,
    };
    setAutoPreferenceInputs(settings);
    return storageSet("sync", settings);
  }

  function getActiveCharacterIndexFromPanelTab() {
    const panelTab = parsePanelTab(selectorState.activePanelTab);
    return panelTab?.kind === "character" ? panelTab.index : null;
  }

  function hasStoredCharacterSlot(index) {
    const numericIndex = Number.parseInt(index, 10);
    if (!Number.isFinite(numericIndex) || numericIndex < 1) {
      return false;
    }
    return Boolean(
      selectorState.slots[makeCharacterSlotId(numericIndex, "prompt")]
      || selectorState.slots[makeCharacterSlotId(numericIndex, "uc")]
    );
  }

  function canKeepCharacterPanelTab(index, indices = getCurrentCharacterIndices()) {
    const numericIndex = Number.parseInt(index, 10);
    if (!Number.isFinite(numericIndex) || numericIndex < 1) {
      return false;
    }
    return indices.includes(numericIndex) || (!indices.length && hasStoredCharacterSlot(numericIndex));
  }

  function getValidPanelTab(indices = getCurrentCharacterIndices()) {
    const panelTab = parsePanelTab(selectorState.activePanelTab);
    if (!panelTab) {
      return "auto";
    }

    const activeSlot = parseSlotId(getActiveSlotId());
    if (
      panelTab.kind === "main"
      && activeSlot?.scope === "character"
      && canKeepCharacterPanelTab(activeSlot.index, indices)
    ) {
      return getCharacterPanelTabId(activeSlot.index);
    }

    if (panelTab.kind !== "character") {
      return selectorState.activePanelTab;
    }
    if (canKeepCharacterPanelTab(panelTab.index, indices)) {
      return selectorState.activePanelTab;
    }

    if (activeSlot?.scope === "character" && canKeepCharacterPanelTab(activeSlot.index, indices)) {
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
          { kind: "prompt", label: "프롬프트" },
          { kind: "uc", label: "네거티브" },
        ]
      : [
          { kind: "base", label: "메인 프롬프트" },
          { kind: "uc", label: "네거티브" },
        ];

    ui.slotModeTabs.replaceChildren();
    ui.slotModeTabs.hidden = panelTab?.kind !== "character";
    if (ui.slotModeTabs.hidden) {
      return;
    }
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

  function getPromptChipTitle(slotId = getActiveSlotId()) {
    const parsed = parseSlotId(slotId);
    if (slotId === MAIN_BASE_SLOT_ID) {
      return "선행 칩";
    }
    return parsed?.kind === "uc" ? "네거티브 칩" : "프롬프트 칩";
  }

  function renderEditorPromptCopy() {
    const slotId = getActiveSlotId();
    const parsed = parseSlotId(slotId);
    const isCharacterSlot = parsed?.scope === "character";
    const isBaseSlot = slotId === MAIN_BASE_SLOT_ID;

    if (ui.leadingTitle) {
      ui.leadingTitle.textContent = getPromptChipTitle(slotId);
    }
    if (ui.quickMeta) {
      ui.quickMeta.hidden = isCharacterSlot;
      ui.quickMeta.textContent = isCharacterSlot
        ? ""
        : isBaseSlot
          ? "선행 칩과 후행 칩 사이에 병합됩니다"
          : "직접 입력한 프롬프트를 함께 병합합니다";
    }
  }

  function getPromptSelectionClearLabel(slotId = getActiveSlotId()) {
    if (slotId === MAIN_BASE_SLOT_ID) {
      return "선행 프롬프트 선택";
    }
    const parsed = parseSlotId(slotId);
    return parsed?.kind === "uc" ? "네거티브 프롬프트 선택" : "프롬프트 선택";
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
        ? `${getSlotLabel(getActiveSlotId())} 편집`
        : `${getSlotLabel(getActiveSlotId())} 편집`;
    }
    renderSlotModeTabs();
    renderEditorPromptCopy();
  }

  function renderCharacterControls() {
    const scan = scanNovelAiPromptSlots();
    const indices = getCurrentCharacterIndices(scan);
    const panelCharacterIndex = getActiveCharacterIndexFromPanelTab();
    const selectedPosition = indices.indexOf(panelCharacterIndex);
    const character = scan.characters.find((entry) => entry.index === panelCharacterIndex) || null;
    const isEnabled = character?.enabled !== false;
    if (ui.activeCharacterLabel) {
      ui.activeCharacterLabel.textContent = selectedPosition >= 0 ? getCharacterLabel(panelCharacterIndex) : "없음";
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
      const isEditingCurrentName = editingCharacterNameIndex === panelCharacterIndex
        && panelShadow?.activeElement === ui.characterNameInput;
      if (!isEditingCurrentName && ui.characterNameInput.value !== nextLabel) {
        ui.characterNameInput.value = nextLabel;
      }
    } else if (!isCharacterTab) {
      editingCharacterNameIndex = null;
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
      const activeSlot = parseSlotId(getActiveSlotId());
      ui.sidebarMainTab.classList.toggle(
        "is-active",
        selectorState.activePanelTab === "main" && activeSlot?.scope === "main" && activeSlot.kind !== "uc",
      );
    }
    if (ui.sidebarNegativeTab) {
      const activeSlot = parseSlotId(getActiveSlotId());
      ui.sidebarNegativeTab.classList.toggle(
        "is-active",
        selectorState.activePanelTab === "main" && activeSlot?.scope === "main" && activeSlot.kind === "uc",
      );
    }

    if (ui.characterTabList) {
      ui.characterTabList.replaceChildren();
      if (!indices.length) {
        const empty = document.createElement("div");
        empty.className = "nps-sidebar-empty";
        empty.textContent = "캐릭터 없음";
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
    await saveSelectorState({ reason: "drag-reorder-character", explicit: true });
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
    setStatus(`${getCharacterLabel(targetIndex)} 위치를 변경했습니다.`, "ok");
    return { ok: true };
  }

  function refreshSlotsFromDom({ pruneMissingCharacters = false, forcePruneMissingCharacters = false } = {}) {
    syncSlotsWithDom({ pruneMissingCharacters, forcePruneMissingCharacters });
    void saveSelectorState({
      reason: pruneMissingCharacters || forcePruneMissingCharacters ? "refresh-slots-prune" : "refresh-slots",
      explicit: pruneMissingCharacters || forcePruneMissingCharacters,
      forceBackup: pruneMissingCharacters || forcePruneMissingCharacters,
    });
    updateEditorFieldsFromActiveSlot();
    renderSlotButtons();
    renderPromptSelector();
  }

  function getPanelFallbackSize(collapsed = selectorState.panelCollapsed) {
    const fallbackWidth = collapsed ? 116 : 720;
    const fallbackHeight = collapsed ? 185 : Math.min(680, Math.max(64, window.innerHeight - 24));
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

  function refreshPanelFromSelectorState() {
    updateEditorFieldsFromActiveSlot();
    applyEditorHeightsFromState();
    renderSlotButtons();
    renderPromptSelector();
  }

  function getTimestampForFilename(date = new Date()) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0"),
    ].join("");
  }

  function downloadTextFile(filename, text, mimeType = "application/json") {
    const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.documentElement.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSelectorState() {
    const envelope = Store.createExportEnvelope(selectorState, {
      extensionId: chrome.runtime.id,
    });
    const filename = `nai-prompt-selector-backup-${getTimestampForFilename()}.json`;
    downloadTextFile(filename, `${JSON.stringify(envelope, null, 2)}\n`);
    setStatus("프롬프트 백업 JSON을 내보냈습니다.", "ok");
  }

  async function importSelectorFromText(text) {
    const parsed = Store.parseExportEnvelope(text);
    if (!parsed.ok) {
      setStatus(parsed.error, "warn");
      return { ok: false, error: parsed.error };
    }

    const nextState = migrateStoredSelectorState(parsed.envelope.selector);
    await saveSelectorState({ reason: "before-import", explicit: true, forceBackup: true });
    selectorState = nextState;
    await saveSelectorState({ reason: "import-json", explicit: true, skipBackup: true });
    refreshPanelFromSelectorState();
    setStatus("프롬프트 백업 JSON을 가져왔습니다.", "ok");
    return { ok: true };
  }

  async function importSelectorFromFile(file) {
    if (!file) {
      return;
    }
    try {
      await importSelectorFromText(await file.text());
    } catch (error) {
      setStatus("프롬프트 백업 JSON을 가져오지 못했습니다.", "warn");
    }
  }

  async function restoreLatestSelectorBackup() {
    const result = await storageGet("local", [
      SELECTOR_BACKUPS_STORAGE_KEY,
      SELECTOR_LAST_GOOD_STORAGE_KEY,
    ]);
    const meaningfulOptions = getSelectorMeaningfulOptions();
    const backup = Store.getLatestRestorableBackup(result[SELECTOR_BACKUPS_STORAGE_KEY], meaningfulOptions);
    const lastGood = migrateOptionalSelectorState(result[SELECTOR_LAST_GOOD_STORAGE_KEY]);
    const restoreSelector = backup?.selector
      || (
        lastGood && Store.isMeaningfulSelectorState(lastGood, meaningfulOptions)
          ? lastGood
          : null
      );

    if (!restoreSelector) {
      setStatus("복구할 수 있는 내부 백업이 없습니다.", "warn");
      return { ok: false, error: "No restorable backup." };
    }

    await saveSelectorState({ reason: "before-restore", explicit: true, forceBackup: true });
    selectorState = migrateStoredSelectorState(restoreSelector);
    await saveSelectorState({ reason: "restore-backup", explicit: true, skipBackup: true });
    refreshPanelFromSelectorState();
    const createdAt = backup?.createdAt ? ` (${backup.createdAt})` : "";
    setStatus(`내부 백업을 복구했습니다${createdAt}.`, "ok");
    return { ok: true };
  }

  function bindPanelEvents() {
    panelShadow.addEventListener("click", suppressClickAfterEditorResize, true);
    ui.shell.addEventListener("wheel", blockPanelCtrlWheelZoom, { passive: false });

    bindCollapsedCardDrag();
    if (ui.collapsedControls) {
      for (const eventName of ["pointerdown", "click"]) {
        ui.collapsedControls.addEventListener(eventName, (event) => event.stopPropagation());
      }
    }
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
    ui.editorShell.addEventListener("pointerdown", startEditorResizeInteraction, true);
    ui.editorShell.addEventListener("mousedown", startEditorResizeInteraction, true);
    ui.editorShell.addEventListener("pointerup", () => {
      captureEditorHeightsFromDom({ fields: ["groupsDefinition"] });
    });
    ui.quickInput.addEventListener("pointerdown", startEditorResizeInteraction, true);
    ui.quickInput.addEventListener("mousedown", startEditorResizeInteraction, true);
    ui.quickInput.addEventListener("pointerup", () => {
      captureEditorHeightsFromDom({ fields: ["quickPrompt"] });
    });
    window.addEventListener("pointerup", finishEditorResizeInteraction, true);
    window.addEventListener("mouseup", finishEditorResizeInteraction, true);
    window.addEventListener("pointercancel", () => {
      editorResizeInteraction = null;
    }, true);

    if (window.ResizeObserver && ui.editorShell) {
      let editorShellResizePrimed = false;
      ui.editorResizeObserver = new ResizeObserver(() => {
        preservePanelBodyScroll(() => {
          renderEditorLineNumbers();
          if (!editorShellResizePrimed) {
            editorShellResizePrimed = true;
            return;
          }
          captureEditorHeightsFromDom({ fields: ["groupsDefinition"] });
        });
      });
      ui.editorResizeObserver.observe(ui.editorShell);
    }
    if (window.ResizeObserver && ui.quickInput) {
      let quickResizePrimed = false;
      ui.quickResizeObserver = new ResizeObserver(() => {
        preservePanelBodyScroll(() => {
          if (!quickResizePrimed) {
            quickResizePrimed = true;
            return;
          }
          captureEditorHeightsFromDom({ fields: ["quickPrompt"] });
        });
      });
      ui.quickResizeObserver.observe(ui.quickInput);
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
      void saveSelectorState({ reason: "clear-leading-selection", explicit: true, forceBackup: true });
      renderPromptSelector();
      setStatus(`${getPromptSelectionClearLabel()}을 모두 해제했습니다.`, "ok");
    });

    ui.suffixClearAllButton.addEventListener("click", () => {
      const slotData = getActiveSlotData();
      slotData.suffixSelectionState = "{}";
      void saveSelectorState({ reason: "clear-suffix-selection", explicit: true, forceBackup: true });
      renderPromptSelector();
      setStatus("후행 프롬프트 선택을 모두 해제했습니다.", "ok");
    });

    ui.sampleButton.addEventListener("click", () => {
      const slotData = getActiveSlotData();
      slotData.groupsDefinition = getSampleGroupsDefinitionForSlot(getActiveSlotId());
      slotData.selectionState = "{}";
      slotData.weightMemory = "{}";
      slotData.suffixSelectionState = "{}";
      slotData.suffixWeightMemory = "{}";
      ui.editor.value = slotData.groupsDefinition;
      renderEditorLineNumbers();
      void saveSelectorState({ reason: "load-sample-groups", explicit: true, forceBackup: true });
      renderPromptSelector();
      setStatus("샘플 그룹을 불러왔습니다.", "ok");
    });

    ui.exportButton.addEventListener("click", exportSelectorState);

    ui.importButton.addEventListener("click", () => {
      ui.importFileInput?.click();
    });

    ui.importFileInput.addEventListener("change", () => {
      const file = ui.importFileInput.files?.[0] || null;
      ui.importFileInput.value = "";
      void importSelectorFromFile(file);
    });

    ui.restoreButton.addEventListener("click", () => {
      void restoreLatestSelectorBackup();
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

    ui.collapsedOpenButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setPanelCollapsed(false);
    });

    ui.sidebarAutoTab.addEventListener("click", () => {
      setActivePanelTab("auto");
    });

    ui.sidebarMainTab.addEventListener("click", () => {
      setActivePanelTab("main", { preferredKind: "base" });
    });

    ui.sidebarNegativeTab.addEventListener("click", () => {
      setActivePanelTab("main", { preferredKind: "uc" });
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

    ui.characterNameInput.addEventListener("focus", () => {
      editingCharacterNameIndex = getActiveCharacterIndexFromPanelTab();
    });

    ui.characterNameInput.addEventListener("input", () => {
      const index = getActiveCharacterIndexFromPanelTab();
      if (!index) {
        return;
      }
      editingCharacterNameIndex = index;
    });

    ui.characterNameInput.addEventListener("blur", () => {
      const index = editingCharacterNameIndex || getActiveCharacterIndexFromPanelTab();
      editingCharacterNameIndex = null;
      if (!index) {
        return;
      }
      setCharacterLabel(index, ui.characterNameInput.value);
      void saveSelectorState();
      renderSlotButtons();
    });

    ui.intervalInput.addEventListener("change", () => {
      void saveAutoSettingsFromPanel({ source: "expanded" }).then(() => setStatus("자동 생성 주기를 저장했습니다.", "ok"));
    });

    ui.countInput.addEventListener("change", () => {
      void saveAutoSettingsFromPanel({ source: "expanded" }).then(() => setStatus("자동 생성 횟수를 저장했습니다.", "ok"));
    });

    ui.countPresetButtons.forEach((button) => {
      button.addEventListener("click", () => {
        ui.countInput.value = button.dataset.count || "";
        void saveAutoSettingsFromPanel({ source: "expanded" }).then(() => setStatus("자동 생성 횟수를 저장했습니다.", "ok"));
      });
    });

    ui.collapsedIntervalInput.addEventListener("change", () => {
      void saveAutoSettingsFromPanel({ source: "collapsed" }).then(() => setStatus("자동 생성 주기를 저장했습니다.", "ok"));
    });

    ui.collapsedCountInput.addEventListener("change", () => {
      void saveAutoSettingsFromPanel({ source: "collapsed" }).then(() => setStatus("자동 생성 횟수를 저장했습니다.", "ok"));
    });

    ui.collapsedCountPresetButtons.forEach((button) => {
      button.addEventListener("click", () => {
        ui.collapsedCountInput.value = button.dataset.count || "";
        void saveAutoSettingsFromPanel({ source: "collapsed" }).then(() => setStatus("자동 생성 횟수를 저장했습니다.", "ok"));
      });
    });

    ui.autoSaveToggle.addEventListener("change", () => {
      void saveAutoPreferencesFromPanel().then(() => setStatus("자동 저장 설정을 저장했습니다.", "ok"));
    });

    ui.autoNotificationToggle.addEventListener("change", () => {
      void saveAutoPreferencesFromPanel().then(() => setStatus("자동 생성 완료 알림 설정을 저장했습니다.", "ok"));
    });

    ui.autoVolumeSlider.addEventListener("input", () => {
      setAutoPreferenceInputs({ volume: Number(ui.autoVolumeSlider.value) / 100 });
      void saveAutoPreferencesFromPanel();
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
          width: min(116px, calc(100vw - 16px));
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          align-items: stretch;
          gap: 5px;
          padding: 6px;
          border: 1px solid rgba(39, 214, 196, 0.48);
          border-radius: 7px;
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
        .nps-collapsed-open {
          width: 100%;
          min-height: 24px;
          display: grid;
          place-items: center;
          border: 1px solid rgba(39, 214, 196, 0.38);
          border-radius: 5px;
          background: #172330;
          color: #cffaf7;
          padding: 0;
          cursor: pointer;
        }
        .nps-collapsed-open:hover {
          border-color: rgba(39, 214, 196, 0.68);
          background: #20313f;
          color: #f2fffd;
        }
        .nps-collapsed-open .nps-icon {
          width: 15px;
          height: 15px;
        }
        .nps-collapsed-main {
          min-width: 0;
          display: grid;
          gap: 5px;
        }
        .nps-collapsed-summary {
          display: none;
        }
        .nps-collapsed-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 10px;
          font-weight: 800;
          line-height: 1;
          letter-spacing: 0;
        }
        .nps-collapsed-meta {
          min-width: 0;
          margin-top: 0;
          color: #aab8ba;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 10px;
          line-height: 1;
        }
        .nps-collapsed-controls {
          display: grid;
          gap: 5px;
          cursor: default;
          touch-action: auto;
        }
        .nps-collapsed-fields {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 4px;
        }
        .nps-collapsed-field {
          min-width: 0;
          min-height: 22px;
          display: grid;
          grid-template-columns: 28px minmax(0, 1fr);
          align-items: center;
          gap: 4px;
          color: #93a7ad;
          font-size: 10px;
          font-weight: 800;
          line-height: 1;
        }
        .nps-collapsed-field span {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nps-collapsed-field input {
          width: 100%;
          min-height: 22px;
          height: 22px;
          border: 1px solid rgba(151, 170, 174, 0.32);
          border-radius: 4px;
          background: #0a1019;
          color: #eef7f7;
          padding: 2px 4px;
          font-size: 11px;
          line-height: 1;
        }
        .nps-collapsed-field input::-webkit-outer-spin-button,
        .nps-collapsed-field input::-webkit-inner-spin-button {
          margin: 0;
          -webkit-appearance: none;
        }
        .nps-collapsed-field input:focus {
          outline: 1px solid rgba(39, 214, 196, 0.75);
          border-color: rgba(39, 214, 196, 0.75);
        }
        .nps-collapsed-presets {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 3px;
        }
        .nps-collapsed-presets button {
          min-width: 0;
          min-height: 22px;
          height: 22px;
          border: 1px solid rgba(151, 170, 174, 0.28);
          border-radius: 4px;
          background: #202a34;
          color: #dce8ea;
          padding: 1px 2px;
          font-size: 10px;
          font-weight: 800;
          line-height: 1;
          cursor: pointer;
        }
        .nps-collapsed-presets button:hover {
          border-color: rgba(39, 214, 196, 0.56);
          color: #f2fffd;
        }
        .nps-collapsed-auto {
          min-width: 0;
          min-height: 38px;
          display: grid;
          grid-template-columns: 14px minmax(0, 1fr);
          grid-template-rows: auto auto;
          align-items: center;
          justify-content: stretch;
          column-gap: 5px;
          row-gap: 2px;
          border: 1px solid rgba(39, 214, 196, 0.48);
          border-radius: 5px;
          background: #243f3f;
          color: #f2fffd;
          padding: 5px 6px;
          font-size: 10px;
          font-weight: 800;
          line-height: 1;
          cursor: pointer;
        }
        .nps-collapsed-auto .nps-icon {
          width: 13px;
          height: 13px;
          grid-row: 1 / 3;
        }
        .nps-collapsed-auto .nps-btn-label,
        .nps-collapsed-auto .nps-collapsed-count {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nps-collapsed-auto .nps-btn-label {
          font-size: 11px;
        }
        .nps-collapsed-auto .nps-collapsed-count {
          color: #aab8ba;
          font-size: 9px;
        }
        .nps-collapsed-auto[data-active="true"] {
          border-color: rgba(255, 149, 118, 0.58);
          background: #3d2528;
        }
        .nps-icon-expand::before,
        .nps-icon-expand::after {
          content: "";
          position: absolute;
          width: 7px;
          height: 7px;
          border-color: currentColor;
          border-style: solid;
        }
        .nps-icon-expand::before {
          top: 1px;
          right: 1px;
          border-width: 1.6px 1.6px 0 0;
        }
        .nps-icon-expand::after {
          left: 1px;
          bottom: 1px;
          border-width: 0 0 1.6px 1.6px;
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
        .nps-storage-actions button,
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
        .nps-storage-actions button:hover,
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
        .nps-storage-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .nps-storage-actions button {
          flex: 1 1 120px;
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
          content: none;
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
          overflow-anchor: none;
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
          overflow-anchor: none;
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
          overflow-anchor: none;
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
        .nps-panel {
          width: min(728px, calc(100vw - 24px));
          border-color: rgba(132, 151, 167, 0.28);
          border-radius: 7px;
          background: #0c121c;
          box-shadow: 0 22px 70px rgba(0, 0, 0, 0.5);
        }
        .nps-header {
          min-height: 58px;
          padding: 13px 18px;
          background: linear-gradient(180deg, #131a25 0%, #101722 100%);
        }
        .nps-header-main {
          display: grid;
          grid-template-columns: minmax(0, auto) auto;
          align-items: center;
          gap: 22px;
          min-width: 0;
        }
        .nps-title {
          color: #f4f7fb;
          font-size: 17px;
          font-weight: 750;
          line-height: 1.1;
        }
        .nps-header-state {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          color: #d7e0e6;
          font-size: 12px;
          white-space: nowrap;
        }
        .nps-state-dot {
          width: 8px;
          height: 8px;
          flex: 0 0 auto;
          border-radius: 999px;
          background: #35d676;
          box-shadow: 0 0 0 3px rgba(53, 214, 118, 0.12);
        }
        .nps-shortcuts-menu {
          position: relative;
          display: inline-flex;
          align-items: center;
          margin-left: 1px;
        }
        .nps-shortcuts-menu summary {
          width: 22px;
          height: 22px;
          display: grid;
          place-items: center;
          list-style: none;
          border: 1px solid rgba(132, 151, 167, 0.18);
          border-radius: 5px;
          background: transparent;
          color: #87939e;
          cursor: pointer;
          user-select: none;
        }
        .nps-shortcuts-menu summary::-webkit-details-marker {
          display: none;
        }
        .nps-shortcuts-menu summary:hover,
        .nps-shortcuts-menu[open] summary {
          border-color: rgba(132, 151, 167, 0.38);
          background: rgba(132, 151, 167, 0.1);
          color: #c1ccd4;
        }
        .nps-shortcuts-panel {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          z-index: 2147483203;
          width: min(260px, calc(100vw - 40px));
          display: grid;
          gap: 7px;
          padding: 9px;
          border: 1px solid rgba(132, 151, 167, 0.3);
          border-radius: 7px;
          background: #0e1520;
          box-shadow: 0 18px 42px rgba(0, 0, 0, 0.46);
        }
        .nps-shortcuts-menu:not([open]) .nps-shortcuts-panel {
          display: none;
        }
        .nps-shortcut-row {
          display: grid;
          grid-template-columns: max-content minmax(0, 1fr);
          align-items: center;
          gap: 10px;
          font-size: 12px;
          line-height: 1.25;
        }
        .nps-shortcut-keys {
          padding: 3px 5px;
          border: 1px solid rgba(132, 151, 167, 0.22);
          border-radius: 4px;
          background: rgba(132, 151, 167, 0.1);
          color: #d8e0e6;
          font-family: Consolas, "Courier New", monospace;
          font-size: 11px;
          white-space: nowrap;
        }
        .nps-shortcut-label {
          min-width: 0;
          color: #d7e0e6;
          overflow-wrap: anywhere;
        }
        .nps-collapse {
          width: 28px;
          height: 28px;
          display: grid;
          place-items: center;
          padding: 0 !important;
          border-color: transparent !important;
          background: transparent !important;
        }
        .nps-actions {
          grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(110px, 0.9fr);
          gap: 9px;
          padding: 10px 18px;
          background: #0f1622;
        }
        .nps-actions button,
        .nps-more-menu summary {
          min-height: 34px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 9px;
          border: 1px solid rgba(132, 151, 167, 0.28);
          border-radius: 6px;
          background: rgba(19, 27, 39, 0.82);
          color: #edf3f7;
          padding: 7px 11px;
          font-size: 13px;
          font-weight: 650;
          line-height: 1;
          cursor: pointer;
        }
        .nps-actions button:hover,
        .nps-more-menu summary:hover {
          border-color: rgba(54, 205, 224, 0.56);
          background: rgba(26, 37, 52, 0.95);
        }
        .nps-actions button:first-child {
          background: rgba(19, 27, 39, 0.82);
          border-color: rgba(132, 151, 167, 0.28);
        }
        .nps-auto[data-active="true"] {
          border-color: rgba(255, 127, 99, 0.58);
          background: rgba(70, 30, 32, 0.78);
          color: #ffd5cc;
        }
        .nps-more-menu {
          position: relative;
          min-width: 0;
        }
        .nps-more-menu summary {
          width: 100%;
          list-style: none;
          user-select: none;
        }
        .nps-more-menu summary::-webkit-details-marker {
          display: none;
        }
        .nps-more-panel {
          position: absolute;
          top: calc(100% + 7px);
          right: 0;
          z-index: 2147483202;
          width: 238px;
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 7px;
          border: 1px solid rgba(132, 151, 167, 0.3);
          border-radius: 7px;
          background: #0e1520;
          box-shadow: 0 18px 42px rgba(0, 0, 0, 0.46);
        }
        .nps-more-menu:not([open]) .nps-more-panel {
          display: none;
        }
        .nps-more-panel button,
        .nps-storage-actions button {
          width: 100%;
          flex: 0 0 auto;
          justify-content: flex-start;
          min-height: 28px;
          padding: 6px 8px;
          font-size: 12px;
          font-weight: 600;
        }
        .nps-more-settings {
          display: grid;
          gap: 7px;
          padding: 7px 0;
          border-top: 1px solid rgba(132, 151, 167, 0.16);
          border-bottom: 1px solid rgba(132, 151, 167, 0.16);
        }
        .nps-more-title {
          color: #91a4b0;
          font-size: 11px;
          font-weight: 800;
        }
        .nps-menu-check {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          gap: 7px;
          min-height: 28px;
          border: 1px solid rgba(132, 151, 167, 0.18);
          border-radius: 6px;
          background: rgba(18, 26, 37, 0.58);
          color: #dce6eb;
          padding: 6px 7px;
          font-size: 12px;
          font-weight: 650;
          line-height: 1.2;
          cursor: pointer;
        }
        .nps-menu-check input {
          width: 14px;
          height: 14px;
          margin: 0;
          accent-color: #27d6c4;
        }
        .nps-menu-range {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: center;
          gap: 6px;
          border: 1px solid rgba(132, 151, 167, 0.18);
          border-radius: 6px;
          background: rgba(18, 26, 37, 0.58);
          color: #dce6eb;
          padding: 6px 7px;
          font-size: 12px;
          font-weight: 650;
        }
        .nps-menu-range input {
          grid-column: 1 / -1;
          width: 100%;
          accent-color: #27d6c4;
        }
        .nps-volume-value {
          color: #91a4b0;
          font-size: 11px;
          font-weight: 800;
        }
        .nps-storage-actions {
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding-top: 0;
          margin-top: 0;
          border-top: 0;
        }
        .nps-status {
          min-height: 0;
          padding: 8px 18px;
          background: #0d141f;
          color: #92a5b2;
          font-size: 11px;
          border-bottom-color: rgba(132, 151, 167, 0.14);
        }
        .nps-status:empty {
          display: none;
        }
        .nps-status[data-tone="ok"] { color: #82e7ca; }
        .nps-status[data-tone="warn"] { color: #f5bf75; }
        .nps-panel-grid {
          grid-template-columns: 180px minmax(0, 1fr);
        }
        .nps-sidebar {
          gap: 6px;
          padding: 16px 10px;
          background: linear-gradient(180deg, #101824 0%, #0e151f 100%);
          border-right-color: rgba(132, 151, 167, 0.18);
        }
        .nps-sidebar-label {
          margin: 10px 8px 4px;
          color: #7d8c98;
          font-size: 11px;
          font-weight: 650;
          text-transform: none;
        }
        .nps-sidebar-label:first-child {
          margin-top: 0;
        }
        .nps-sidebar-tab,
        .nps-sidebar-add {
          display: flex;
          align-items: center;
          gap: 9px;
          min-height: 31px;
          border-color: transparent;
          border-radius: 6px;
          background: transparent;
          color: #cbd5dc;
          padding: 7px 9px;
          font-size: 12px;
          font-weight: 570;
        }
        .nps-sidebar-tab > span:last-child,
        .nps-sidebar-add > span:last-child {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nps-sidebar-tab:hover,
        .nps-sidebar-add:hover {
          border-color: rgba(132, 151, 167, 0.2);
          background: rgba(255, 255, 255, 0.035);
        }
        .nps-sidebar-tab.is-active {
          background: rgba(53, 205, 226, 0.08);
          border-color: rgba(53, 205, 226, 0.18);
          color: #8df2ff;
          font-weight: 700;
          box-shadow: inset 3px 0 0 #35cde2;
        }
        .nps-character-tabs {
          gap: 5px;
          max-height: min(330px, calc(100vh - 350px));
        }
        .nps-character-tab {
          position: relative;
          padding-left: 25px;
        }
        .nps-character-tab::before {
          content: "";
          position: absolute;
          left: 9px;
          top: 50%;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #6f7f8b;
          transform: translateY(-50%);
        }
        .nps-character-tab.is-active::before {
          background: #61def2;
          box-shadow: 0 0 0 3px rgba(97, 222, 242, 0.12);
        }
        .nps-character-tab.is-disabled {
          color: #75828d;
          border-style: solid;
          background: transparent;
        }
        .nps-character-tab.is-disabled::before {
          left: 8px;
          width: 10px;
          height: 10px;
          border: 1.3px solid #74828d;
          border-radius: 75% 15%;
          background: radial-gradient(circle at 50% 50%, #74828d 0 1.8px, transparent 2.1px);
          box-shadow: none;
          transform: translateY(-50%) rotate(45deg);
        }
        .nps-character-tab.is-disabled::after {
          content: "";
          position: absolute;
          left: 6px;
          top: 50%;
          width: 16px;
          height: 1.7px;
          margin-left: 0;
          border-radius: 999px;
          background: #ffbe79;
          box-shadow: 0 0 0 1px rgba(15, 22, 34, 0.72);
          transform: translateY(-50%) rotate(-45deg);
          pointer-events: none;
        }
        .nps-sidebar-add {
          margin-top: auto;
          min-height: 32px;
          justify-content: flex-start;
          border-color: rgba(132, 151, 167, 0.24);
          background: transparent;
          color: #d8e1e7;
          font-size: 12px;
          font-weight: 600;
        }
        .nps-sidebar-add span:first-child {
          color: #8df2ff;
          font-size: 18px;
          line-height: 1;
        }
        .nps-body {
          gap: 11px;
          padding: 16px 18px 18px;
          background: #0c121c;
        }
        .nps-tab-view {
          gap: 13px;
        }
        .nps-section {
          gap: 7px;
        }
        .nps-editor-context {
          padding-bottom: 3px;
        }
        .nps-section-head {
          min-height: 24px;
        }
        .nps-section-title {
          color: #eef4f8;
          font-size: 13px;
          font-weight: 720;
        }
        .nps-section-meta {
          color: #8c9ba7;
          font-size: 11px;
        }
        .nps-segments[hidden] {
          display: none;
        }
        .nps-segments {
          flex: 0 0 auto;
          flex-wrap: nowrap;
          padding: 2px;
          border: 1px solid rgba(132, 151, 167, 0.22);
          border-radius: 6px;
          background: rgba(8, 13, 20, 0.5);
        }
        .nps-segment {
          min-height: 26px;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: #cbd5dc;
          padding: 5px 10px;
          font-size: 12px;
        }
        .nps-segment.is-active {
          background: rgba(53, 205, 226, 0.13);
          border-color: transparent;
          color: #96f3ff;
          box-shadow: inset 0 0 0 1px rgba(53, 205, 226, 0.32);
        }
        .nps-flow-section {
          position: relative;
          padding-left: 31px;
        }
        .nps-flow-section::before {
          content: attr(data-step);
          position: absolute;
          left: 0;
          top: 1px;
          width: 20px;
          height: 20px;
          display: grid;
          place-items: center;
          border: 1px solid rgba(132, 151, 167, 0.34);
          border-radius: 999px;
          color: #c5d0d8;
          background: #111925;
          font-size: 11px;
          font-weight: 700;
        }
        .nps-flow-section:not(:last-child)::after {
          content: "";
          position: absolute;
          left: 9px;
          top: 28px;
          bottom: -8px;
          width: 1px;
          background: linear-gradient(180deg, rgba(132, 151, 167, 0.26), rgba(132, 151, 167, 0));
        }
        .nps-editor-view .nps-flow-section:last-child {
          margin-bottom: 16px;
        }
        .nps-editor-view {
          padding-bottom: 18px;
        }
        .nps-editor-view::after {
          content: "";
          display: block;
          flex: 0 0 18px;
        }
        .nps-editor-shell {
          height: 96px;
          min-height: 96px;
          grid-template-columns: 38px minmax(0, 1fr);
          border-color: rgba(132, 151, 167, 0.26);
          border-radius: 6px;
          background: #0a1019;
        }
        .nps-editor-line-numbers {
          background: rgba(255, 255, 255, 0.025);
          color: #667584;
          font-size: 11px;
          padding: 8px 7px 8px 5px;
        }
        .nps-editor,
        .nps-quick,
        .nps-preview {
          color: #e8eef3;
          font-size: 12px;
          line-height: 1.5;
          font-family: Consolas, "Courier New", monospace;
        }
        .nps-editor {
          padding: 8px 10px;
        }
        .nps-quick {
          min-height: 72px;
          border-color: rgba(132, 151, 167, 0.26);
          border-radius: 6px;
          background: #0a1019;
        }
        .nps-group {
          border-color: transparent;
          border-radius: 0;
          background: transparent;
          padding: 0;
        }
        .nps-group + .nps-group {
          padding-top: 7px;
          border-top: 1px solid rgba(132, 151, 167, 0.14);
        }
        .nps-group-header {
          align-items: center;
          margin-bottom: 7px;
        }
        .nps-group-title {
          color: #e9f0f4;
          font-size: 12px;
        }
        .nps-group-meta {
          color: #8796a2;
          font-size: 11px;
        }
        .nps-group-actions button,
        .nps-section-head button {
          min-height: 24px;
          border-color: transparent;
          background: transparent;
          color: #aab7c1;
          padding: 3px 6px;
          font-size: 11px;
        }
        .nps-group-actions button:hover,
        .nps-section-head button:hover {
          color: #91f2ff;
          border-color: rgba(53, 205, 226, 0.22);
          background: rgba(53, 205, 226, 0.06);
        }
        .nps-chips {
          gap: 7px;
        }
        .nps-chip {
          min-height: 29px;
          border-color: rgba(132, 151, 167, 0.28);
          border-radius: 5px;
          background: rgba(18, 26, 37, 0.84);
          color: #dbe4ea;
          padding: 6px 9px;
          font-size: 12px;
        }
        .nps-chip.is-active {
          background: rgba(33, 77, 89, 0.48);
          border-color: rgba(53, 205, 226, 0.72);
          color: #aef6ff;
          box-shadow: none;
        }
        .nps-chip.is-active.is-boosted,
        .nps-chip.is-active.is-weakened {
          background: rgba(33, 77, 89, 0.36);
          border-color: rgba(53, 205, 226, 0.52);
          color: #d9f8ff;
          box-shadow: none;
        }
        .nps-chip-weight {
          border-radius: 999px;
          padding: 1px 6px;
          font-size: 10px;
          font-weight: 800;
        }
        .nps-chip.is-active.is-boosted .nps-chip-weight {
          background: rgba(224, 89, 69, 0.28) !important;
          color: #ffb5aa !important;
        }
        .nps-chip.is-active.is-weakened .nps-chip-weight {
          background: rgba(77, 132, 226, 0.24) !important;
          color: #b6d4ff !important;
        }
        .nps-preview {
          min-height: 74px;
          max-height: 130px;
          border-color: rgba(132, 151, 167, 0.24);
          border-radius: 6px;
          background: #0a1019;
          padding: 10px;
        }
        .nps-character-editor-tools {
          border-color: rgba(132, 151, 167, 0.2);
          background: rgba(16, 24, 36, 0.62);
          padding: 9px;
        }
        .nps-settings-grid {
          gap: 10px;
        }
        .nps-field label {
          color: #8c9ba7;
        }
        .nps-field input {
          border-color: rgba(132, 151, 167, 0.26);
          background: #0a1019;
        }
        .nps-count-presets button {
          min-width: 56px;
          border-color: rgba(132, 151, 167, 0.24);
          background: rgba(18, 26, 37, 0.84);
        }
        .nps-icon {
          position: relative;
          width: 15px;
          height: 15px;
          display: inline-block;
          flex: 0 0 auto;
          color: currentColor;
        }
        .nps-icon-check::before {
          content: "";
          position: absolute;
          left: 2px;
          top: 3px;
          width: 11px;
          height: 8px;
          border: solid currentColor;
          border-width: 0 0 2px 2px;
          border-radius: 0 0 0 2px;
          transform: rotate(-45deg);
        }
        .nps-icon-check::after {
          content: none;
        }
        .nps-icon-play::before {
          content: "";
          position: absolute;
          left: 4px;
          top: 2px;
          border-left: 9px solid currentColor;
          border-top: 6px solid transparent;
          border-bottom: 6px solid transparent;
        }
        .nps-icon-stop::before {
          content: "";
          position: absolute;
          inset: 3px;
          border-radius: 2px;
          background: currentColor;
        }
        .nps-icon-minus::before {
          content: "";
          position: absolute;
          left: 2px;
          right: 2px;
          top: 7px;
          height: 1.7px;
          background: currentColor;
          border-radius: 999px;
        }
        .nps-icon-more::before {
          content: "";
          position: absolute;
          left: 1px;
          top: 6px;
          width: 3px;
          height: 3px;
          border-radius: 999px;
          background: currentColor;
          box-shadow: 5px 0 currentColor, 10px 0 currentColor;
        }
        .nps-icon-chevron::before {
          content: "";
          position: absolute;
          left: 4px;
          top: 4px;
          width: 6px;
          height: 6px;
          border: solid currentColor;
          border-width: 0 1.6px 1.6px 0;
          transform: rotate(45deg);
        }
        .nps-icon-keyboard {
          width: 14px;
          height: 14px;
        }
        .nps-icon-keyboard::before {
          content: "";
          position: absolute;
          inset: 2px 1px 3px;
          border: 1.4px solid currentColor;
          border-radius: 2.5px;
        }
        .nps-icon-keyboard::after {
          content: "";
          position: absolute;
          left: 4px;
          top: 5px;
          width: 1.5px;
          height: 1.5px;
          border-radius: 999px;
          background: currentColor;
          box-shadow: 3px 0 currentColor, 6px 0 currentColor, -1.5px 3px currentColor, 1.5px 3px currentColor, 4.5px 3px currentColor, 7.5px 3px currentColor;
          opacity: 0.82;
        }
        .nps-icon-auto::before {
          content: "";
          position: absolute;
          left: 4px;
          top: 1px;
          width: 8px;
          height: 13px;
          background: currentColor;
          clip-path: polygon(58% 0, 16% 52%, 45% 52%, 33% 100%, 86% 39%, 56% 39%);
        }
        .nps-icon-auto::after {
          content: none;
        }
        .nps-icon-prompt::before,
        .nps-icon-doc::before {
          content: "";
          position: absolute;
          inset: 2px 3px;
          border: 1.5px solid currentColor;
          border-radius: 2px;
        }
        .nps-icon-prompt::after {
          content: "";
          position: absolute;
          left: 5px;
          right: 5px;
          top: 6px;
          height: 1.3px;
          background: currentColor;
          box-shadow: 0 4px currentColor;
        }
        .nps-icon-doc::after {
          content: "";
          position: absolute;
          left: 5px;
          right: 4px;
          top: 5px;
          height: 1.2px;
          background: currentColor;
          box-shadow: 0 3px currentColor, 0 6px currentColor;
          opacity: 0.75;
        }
        .nps-auto-dot {
          width: 18px;
          height: 18px;
          border: 1px solid rgba(132, 151, 167, 0.42);
          border-radius: 999px;
          background: rgba(132, 151, 167, 0.22);
          box-shadow: inset 0 0 0 3px #0f1622;
        }
        .nps-auto[data-active="true"] .nps-auto-dot {
          border-color: rgba(255, 127, 99, 0.8);
          background: #ff7f63;
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
          <button class="nps-collapsed-open" type="button" aria-label="패널 열기" title="패널 열기">
            <span class="nps-icon nps-icon-expand" aria-hidden="true"></span>
          </button>
          <div class="nps-collapsed-main">
            <div class="nps-collapsed-summary">
              <div class="nps-collapsed-title">NAI 자동</div>
              <div class="nps-collapsed-meta">완료 <span>0 / ∞</span></div>
            </div>
            <div class="nps-collapsed-controls">
              <div class="nps-collapsed-fields">
                <label class="nps-collapsed-field">
                  <span>주기</span>
                  <input class="nps-collapsed-interval-input" type="number" min="0.1" step="0.1" placeholder="초" aria-label="자동 생성 주기(초)">
                </label>
                <label class="nps-collapsed-field">
                  <span>횟수</span>
                  <input class="nps-collapsed-count-input" type="number" min="0" step="1" placeholder="횟수" aria-label="자동 생성 횟수">
                </label>
              </div>
              <div class="nps-collapsed-presets" aria-label="접힌 패널 자동 생성 횟수">
                <button type="button" data-count="5">5</button>
                <button type="button" data-count="10">10</button>
                <button type="button" data-count="20">20</button>
                <button type="button" data-count="30">30</button>
                <button type="button" data-count="50">50</button>
                <button type="button" data-count="">∞</button>
              </div>
            </div>
          </div>
          <button class="nps-collapsed-auto" type="button">
            <span class="nps-icon nps-icon-play" aria-hidden="true"></span>
            <span class="nps-btn-label">시작</span>
            <span class="nps-collapsed-count">0 / ∞</span>
          </button>
        </div>
        <aside class="nps-panel">
          <header class="nps-header">
            <div class="nps-header-main">
              <div class="nps-title">NAI-Prompt-Selector</div>
              <div class="nps-header-state">
                <span class="nps-state-dot" aria-hidden="true"></span>
                <span>연결됨</span>
                <details class="nps-shortcuts-menu">
                  <summary aria-label="단축키 목록 보기" title="단축키 목록">
                    <span class="nps-icon nps-icon-keyboard" aria-hidden="true"></span>
                  </summary>
                  <div class="nps-shortcuts-panel" role="list" aria-label="페이지 단축키">
                    <div class="nps-shortcut-row" role="listitem">
                      <span class="nps-shortcut-keys">Ctrl + Space</span>
                      <span class="nps-shortcut-label">현재 슬롯 적용</span>
                    </div>
                    <div class="nps-shortcut-row" role="listitem">
                      <span class="nps-shortcut-keys">Ctrl + Shift + Space</span>
                      <span class="nps-shortcut-label">전체 슬롯 적용</span>
                    </div>
                    <div class="nps-shortcut-row" role="listitem">
                      <span class="nps-shortcut-keys">Ctrl + Enter</span>
                      <span class="nps-shortcut-label">자동 생성 시작</span>
                    </div>
                    <div class="nps-shortcut-row" role="listitem">
                      <span class="nps-shortcut-keys">Ctrl + Alt + Enter</span>
                      <span class="nps-shortcut-label">자동 생성 취소</span>
                    </div>
                    <div class="nps-shortcut-row" role="listitem">
                      <span class="nps-shortcut-keys">Ctrl + \`</span>
                      <span class="nps-shortcut-label">패널 접기/펼치기</span>
                    </div>
                    <div class="nps-shortcut-row" role="listitem">
                      <span class="nps-shortcut-keys">Ctrl + Wheel</span>
                      <span class="nps-shortcut-label">프롬프트 칩 가중치 조절</span>
                    </div>
                  </div>
                </details>
              </div>
            </div>
            <button class="nps-collapse" type="button" aria-label="패널 접기">
              <span class="nps-icon nps-icon-minus" aria-hidden="true"></span>
            </button>
          </header>
          <div class="nps-actions">
            <button class="nps-apply" type="button">
              <span class="nps-icon nps-icon-check" aria-hidden="true"></span>
              <span>적용</span>
            </button>
            <button class="nps-generate" type="button">
              <span class="nps-icon nps-icon-play" aria-hidden="true"></span>
              <span>생성</span>
            </button>
            <button class="nps-auto" type="button">
              <span class="nps-auto-dot" aria-hidden="true"></span>
              <span class="nps-btn-label">자동</span>
            </button>
            <details class="nps-more-menu">
              <summary>
                <span class="nps-icon nps-icon-more" aria-hidden="true"></span>
                <span>더보기</span>
                <span class="nps-icon nps-icon-chevron" aria-hidden="true"></span>
              </summary>
              <div class="nps-more-panel">
                <button class="nps-apply-all" type="button">전체 슬롯 적용</button>
                <button class="nps-refresh-slots" type="button">슬롯 새로고침</button>
                <button class="nps-sample" type="button">샘플 그룹 불러오기</button>
                <div class="nps-more-settings">
                  <div class="nps-more-title">자동 생성 설정</div>
                  <label class="nps-menu-check">
                    <input class="nps-auto-save-toggle" type="checkbox">
                    <span>완료 이미지 자동 저장</span>
                  </label>
                  <label class="nps-menu-range">
                    <span>시작/중지 볼륨</span>
                    <span class="nps-volume-value">50%</span>
                    <input class="nps-volume-slider" type="range" min="0" max="100" step="1">
                  </label>
                  <label class="nps-menu-check">
                    <input class="nps-auto-notification-toggle" type="checkbox">
                    <span>자동생성 완료 알림</span>
                  </label>
                </div>
                <div class="nps-storage-actions">
                  <button class="nps-export" type="button">JSON 내보내기</button>
                  <button class="nps-import" type="button">JSON 가져오기</button>
                  <button class="nps-restore" type="button">백업 복구</button>
                  <input class="nps-import-file" type="file" accept="application/json,.json" hidden>
                </div>
              </div>
            </details>
          </div>
          <div class="nps-status" data-tone="neutral"></div>
          <div class="nps-panel-grid">
            <nav class="nps-sidebar" aria-label="NAI-Prompt-Selector 탭">
              <div class="nps-sidebar-label">모드</div>
              <button class="nps-sidebar-tab nps-sidebar-auto" type="button">
                <span class="nps-icon nps-icon-auto" aria-hidden="true"></span>
                <span>자동 생성</span>
              </button>
              <div class="nps-sidebar-label">슬롯</div>
              <button class="nps-sidebar-tab nps-sidebar-main" type="button">
                <span class="nps-icon nps-icon-prompt" aria-hidden="true"></span>
                <span>메인 프롬프트</span>
              </button>
              <button class="nps-sidebar-tab nps-sidebar-negative" type="button">
                <span class="nps-icon nps-icon-doc" aria-hidden="true"></span>
                <span>네거티브 프롬프트</span>
              </button>
              <div class="nps-sidebar-label">캐릭터</div>
              <div class="nps-character-tabs"></div>
            <button class="nps-add-character nps-sidebar-add" type="button" data-kind="Other" title="기타 캐릭터 추가">
                <span aria-hidden="true">+</span>
                <span>캐릭터 추가</span>
              </button>
            </nav>
            <div class="nps-body">
              <section class="nps-tab-view nps-auto-view">
                <section class="nps-section">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">자동 생성</div>
                      <div class="nps-section-meta">횟수를 비우거나 0으로 두면 무제한으로 생성합니다</div>
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
                <section class="nps-section nps-editor-context">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title nps-slot-mode-title">메인 프롬프트 편집</div>
                      <div class="nps-section-meta">현재 슬롯: <span class="nps-active-slot">메인 프롬프트</span></div>
                    </div>
                    <div class="nps-segments nps-slot-mode-tabs"></div>
                  </div>
                </section>
                <section class="nps-section nps-character-editor-tools" hidden>
                  <div class="nps-character-name-row">
                    <div class="nps-field">
                      <label for="nps-character-name-input">캐릭터 이름</label>
                      <input id="nps-character-name-input" class="nps-character-name-input" type="text" maxlength="48" placeholder="캐릭터">
                    </div>
                    <button class="nps-character-enabled" type="button">비활성화</button>
                    <button class="nps-delete-character nps-character-delete" type="button">삭제</button>
                    <div class="nps-delete-confirm" hidden>
                      <span>이 캐릭터를 삭제할까요?</span>
                      <button class="nps-confirm-delete" type="button">삭제 확정</button>
                      <button class="nps-cancel-delete" type="button">취소</button>
                    </div>
                  </div>
                  <div class="nps-character-disabled-banner" hidden>이 캐릭터는 NovelAI에서 비활성화되어 있습니다.</div>
                  <div class="nps-section-meta">대상: <span class="nps-active-character">없음</span></div>
                </section>
                <section class="nps-section nps-flow-section" data-step="1">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">그룹 정의</div>
                      <div class="nps-section-meta">[그룹] 아래에 프롬프트를 한 줄씩 입력합니다</div>
                    </div>
                  </div>
                  <div class="nps-editor-shell">
                    <div class="nps-editor-line-numbers" aria-hidden="true">1</div>
                    <textarea class="nps-editor" spellcheck="false" wrap="soft"></textarea>
                    <div class="nps-editor-line-measurer" aria-hidden="true"></div>
                  </div>
                </section>
                <section class="nps-section nps-flow-section" data-step="2">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title nps-leading-title">선행 칩</div>
                      <div class="nps-section-meta nps-summary">0개 그룹</div>
                    </div>
                    <button class="nps-clear-all" type="button">전체 해제</button>
                  </div>
                  <div class="nps-groups"></div>
                </section>
                <section class="nps-section nps-flow-section" data-step="3">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">빠른 프롬프트</div>
                      <div class="nps-section-meta nps-quick-meta">선행 칩과 후행 칩 사이에 병합됩니다</div>
                    </div>
                  </div>
                  <textarea class="nps-quick" spellcheck="false" placeholder="프롬프트를 입력하세요"></textarea>
                </section>
                <section class="nps-section nps-flow-section nps-suffix-section" data-step="4" hidden>
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">후행 칩</div>
                      <div class="nps-section-meta nps-suffix-summary">0개 그룹</div>
                    </div>
                    <button class="nps-suffix-clear-all" type="button">전체 해제</button>
                  </div>
                  <div class="nps-suffix-groups"></div>
                </section>
                <section class="nps-section nps-flow-section" data-step="5">
                  <div class="nps-section-head">
                    <div>
                      <div class="nps-section-title">미리보기</div>
                      <div class="nps-section-meta nps-prompt-meta">비어 있음</div>
                    </div>
                    <button class="nps-copy" type="button" disabled>복사</button>
                  </div>
                  <pre class="nps-preview is-empty">선택된 프롬프트가 없습니다.</pre>
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
      collapsedOpenButton: panelShadow.querySelector(".nps-collapsed-open"),
      collapsedCount: panelShadow.querySelector(".nps-collapsed-count"),
      collapsedControls: panelShadow.querySelector(".nps-collapsed-controls"),
      collapsedCountInput: panelShadow.querySelector(".nps-collapsed-count-input"),
      collapsedIntervalInput: panelShadow.querySelector(".nps-collapsed-interval-input"),
      collapsedCountPresetButtons: Array.from(panelShadow.querySelectorAll(".nps-collapsed-presets button")),
      collapsedAutoButton: panelShadow.querySelector(".nps-collapsed-auto"),
      collapseButton: panelShadow.querySelector(".nps-collapse"),
      sidebarAutoTab: panelShadow.querySelector(".nps-sidebar-auto"),
      sidebarMainTab: panelShadow.querySelector(".nps-sidebar-main"),
      sidebarNegativeTab: panelShadow.querySelector(".nps-sidebar-negative"),
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
      quickMeta: panelShadow.querySelector(".nps-quick-meta"),
      groupList: panelShadow.querySelector(".nps-groups"),
      leadingTitle: panelShadow.querySelector(".nps-leading-title"),
      suffixSection: panelShadow.querySelector(".nps-suffix-section"),
      suffixGroupList: panelShadow.querySelector(".nps-suffix-groups"),
      summary: panelShadow.querySelector(".nps-summary"),
      suffixSummary: panelShadow.querySelector(".nps-suffix-summary"),
      preview: panelShadow.querySelector(".nps-preview"),
      promptMeta: panelShadow.querySelector(".nps-prompt-meta"),
      status: panelShadow.querySelector(".nps-status"),
      body: panelShadow.querySelector(".nps-body"),
      copyButton: panelShadow.querySelector(".nps-copy"),
      applyButton: panelShadow.querySelector(".nps-apply"),
      applyAllButton: panelShadow.querySelector(".nps-apply-all"),
      generateButton: panelShadow.querySelector(".nps-generate"),
      autoButton: panelShadow.querySelector(".nps-auto"),
      exportButton: panelShadow.querySelector(".nps-export"),
      importButton: panelShadow.querySelector(".nps-import"),
      importFileInput: panelShadow.querySelector(".nps-import-file"),
      restoreButton: panelShadow.querySelector(".nps-restore"),
      autoSaveToggle: panelShadow.querySelector(".nps-auto-save-toggle"),
      autoVolumeSlider: panelShadow.querySelector(".nps-volume-slider"),
      autoVolumeValue: panelShadow.querySelector(".nps-volume-value"),
      autoNotificationToggle: panelShadow.querySelector(".nps-auto-notification-toggle"),
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
    applyEditorHeightsFromState();
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
    if (pendingStorageNotice) {
      const notice = pendingStorageNotice;
      pendingStorageNotice = null;
      setStatus(notice, "warn");
      return;
    }
    const scan = scanNovelAiPromptSlots();
    renderSlotButtons();
    const generateButton = findGenerateButton();
    const warning = checkUndesiredContent();
    const costWarning = checkGenerationCost();
    if (warning) {
      setStatus(warning, "warn");
    } else if (!generateButton) {
      setStatus("생성 버튼을 기다리는 중입니다.", "warn");
    } else if (!scan.main.root) {
      setStatus("메인 프롬프트 입력 영역을 기다리는 중입니다.", "warn");
    } else if (pendingPromptApply) {
      setStatus("프롬프트 적용 완료를 기다리는 중입니다.", "ok");
    } else if (autoRun.waitingForExistingGeneration) {
      setStatus("현재 생성 완료를 기다린 뒤 자동 생성을 시작합니다.", "ok");
    } else if (autoRun.active) {
      setStatus(`자동 생성 진행 중: 완료 ${autoRun.completedCount} / ${formatAutoTarget(autoRun.target)}`, "ok");
    } else if (costWarning) {
      setStatus(costWarning, "warn");
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
    if (!ui) {
      return;
    }
    if (changes.intervalTime || changes.gcount) {
      if (!autoRun.active) {
        setAutoTimingInputs({
          intervalTime: changes.intervalTime?.newValue ?? ui.intervalInput?.value ?? 3,
          gcount: changes.gcount?.newValue ?? ui.countInput?.value ?? "",
        });
      }
      renderAutoRunControls();
    }
    const preferenceUpdates = {};
    if (changes.autoSaveEnabled) {
      preferenceUpdates.autoSaveEnabled = changes.autoSaveEnabled.newValue;
    }
    if (changes.volume) {
      preferenceUpdates.volume = changes.volume.newValue;
    }
    if (changes.autoCompletionNotificationEnabled) {
      preferenceUpdates.autoCompletionNotificationEnabled = changes.autoCompletionNotificationEnabled.newValue;
    }
    setAutoPreferenceInputs(preferenceUpdates);
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

  document.addEventListener("pointerdown", (event) => {
    rememberHistoryItemClick(event);
  }, true);

  document.addEventListener("click", (event) => {
    rememberHistoryItemClick(event);
    trackNovelAiCharacterActionClick(event);
    if (handleEnhanceClick(event)) {
      return;
    }
    const button = event.target?.closest?.("button");
    if (button && /Generate\s+\d+\s+Image(s)?/i.test(button.textContent || "")) {
      clearAllHighlights();
    }
  }, true);

  function isShortcutEnter(event) {
    return event.key === "Enter" && !event.shiftKey && !event.metaKey;
  }

  function isCtrlEnterShortcut(event) {
    return event.ctrlKey && !event.altKey && isShortcutEnter(event);
  }

  function isCtrlAltEnterShortcut(event) {
    return event.ctrlKey && event.altKey && isShortcutEnter(event);
  }

  function isShortcutSpace(event) {
    return event.code === "Space" || event.key === " " || event.key === "Spacebar";
  }

  function isCtrlSpaceShortcut(event) {
    return event.ctrlKey
      && !event.altKey
      && !event.shiftKey
      && !event.metaKey
      && isShortcutSpace(event);
  }

  function isCtrlShiftSpaceShortcut(event) {
    return event.ctrlKey
      && !event.altKey
      && event.shiftKey
      && !event.metaKey
      && isShortcutSpace(event);
  }

  function isCtrlBackquoteShortcut(event) {
    return event.ctrlKey
      && !event.altKey
      && !event.shiftKey
      && !event.metaKey
      && (event.code === "Backquote" || event.key === "`");
  }

  function consumeGlobalShortcut(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function captureGlobalShortcut(event) {
    if (isCtrlShiftSpaceShortcut(event)) {
      consumeGlobalShortcut(event);
      if (!event.repeat) {
        void applyAllSlotsToNovelAi();
      }
      return;
    }

    if (isCtrlSpaceShortcut(event)) {
      consumeGlobalShortcut(event);
      if (!event.repeat) {
        void applyActiveSlotToNovelAi();
      }
      return;
    }

    if (isCtrlAltEnterShortcut(event)) {
      consumeGlobalShortcut(event);
      void stopAutoGenerate({ playAudio: true });
      return;
    }

    if (isCtrlEnterShortcut(event)) {
      consumeGlobalShortcut(event);
      void startAutoGenerate({ useSelector: false });
      return;
    }

    if (isCtrlBackquoteShortcut(event)) {
      consumeGlobalShortcut(event);
      ensurePanel();
      setPanelCollapsed(!selectorState.panelCollapsed);
    }
  }

  window.addEventListener("keydown", captureGlobalShortcut, true);

  window.addEventListener("beforeunload", () => {
    clearAutoTimers();
    cancelAutoHistoryHighlightWait();
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    if (editorHeightSaveTimer) {
      clearTimeout(editorHeightSaveTimer);
      editorHeightSaveTimer = null;
      captureEditorHeightsFromDom({ save: false });
      void saveSelectorState({ reason: "resize-editor-heights" });
    }
  });

  void (async function initialize() {
    await loadSelectorState();
    ensurePanel();
    startStatusTimer();
  })();
})();
