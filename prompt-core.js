(function attachPromptCore(global) {
  "use strict";

  const DEFAULT_MAIN_GROUPS_DEFINITION = `[Style]
artist: (아티스트 입력)

[Background]
location
indoors
outdoors
blurry background
simple background

[Quality]
-3::artist collaboration ::, anime coloring, pastel colors, detailed shading, expert shading, best illustration, -1::multiple views ::, 2::Masterpiece, best quality, amazing quality, highres, absurdres ::, no text, -2::upscaled::, -1::flat color::, -1::border::, -1::greyscale character::, very aesthetic, masterpiece, no text, -2::blurry::`;
  const DEFAULT_NEGATIVE_GROUPS_DEFINITION = `[Negatives]
blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, too many watermarks, {{worst quality, bad quality}}, bad pupils, bad glabella, {{{{bad hands}}}}, {{{bad eyes}}}, {{{{{displeasing, very displeasing}}}}}, {{{{{bad anatomy, bad hands, missing finger, bad face, duplicate, mutation, deformed, disfigured, extra arms, extra legs, long neck, bad feet, bad proportions, missing}}}}}, {{{undetailed eyes}}}, bb (baalbuddy), bkub, gaoo (frpjx283), milkpanda, nameo (judgemasterkou), yuno385, multiple views`;
  const DEFAULT_CHARACTER_LABEL = "샘플";
  const DEFAULT_CHARACTER_PROMPT_GROUPS_DEFINITION = `[Appearance]
girl
large breasts
curvy
black hair
long hair
blunt bangs
tareme
freckles
thick thighs
wavy mouth

[Upper Attire]
oversized jacket
black track jacket

[Lower Attire]
tight pants
black gym shorts
skindentation`;
  const DEFAULT_GROUPS_DEFINITION = DEFAULT_MAIN_GROUPS_DEFINITION;

  const DEFAULT_PROMPT_WEIGHT = 1.0;
  const MIN_PROMPT_WEIGHT = -3.0;
  const MAX_PROMPT_WEIGHT = 3.0;
  const PROMPT_WEIGHT_STEP = 0.05;

  function normalizePromptItem(value) {
    if (value == null) {
      return "";
    }
    return String(value).trim().replace(/[,\s]+$/g, "").trim();
  }

  function normalizePromptWeight(value) {
    const numericValue = Number.parseFloat(value);
    const safeValue = Number.isFinite(numericValue) ? numericValue : DEFAULT_PROMPT_WEIGHT;
    const clampedValue = Math.min(MAX_PROMPT_WEIGHT, Math.max(MIN_PROMPT_WEIGHT, safeValue));
    const stepCount = clampedValue / PROMPT_WEIGHT_STEP;
    const roundedStepCount = stepCount < 0 ? -Math.round(Math.abs(stepCount)) : Math.round(stepCount);
    const roundedValue = Number((roundedStepCount * PROMPT_WEIGHT_STEP).toFixed(2));
    return Object.is(roundedValue, -0) ? 0 : roundedValue;
  }

  function formatPromptWeightValue(weight) {
    const rounded = normalizePromptWeight(weight);
    return Number(rounded.toFixed(2)).toString();
  }

  function formatPromptWeightLabel(weight) {
    return `${formatPromptWeightValue(weight)}x`;
  }

  function formatPromptItemWithWeight(item, weight) {
    const normalizedItem = normalizePromptItem(item);
    const normalizedWeight = normalizePromptWeight(weight);
    if (!normalizedItem) {
      return "";
    }
    if (normalizedWeight === DEFAULT_PROMPT_WEIGHT) {
      return normalizedItem;
    }
    return `${formatPromptWeightValue(normalizedWeight)}::${normalizedItem}::`;
  }

  function unwrapNovelAiWeightSyntax(value) {
    const normalized = normalizePromptItem(value);
    const match = normalized.match(/^(?:[+-]?(?:\d+\.?\d*|\.\d+))::([\s\S]+)::$/);
    if (!match) {
      return normalized;
    }
    return normalizePromptItem(match[1]);
  }

  function normalizePromptIdentity(value) {
    return unwrapNovelAiWeightSyntax(value).toLowerCase();
  }

  function getNextCharacterLabel(existingLabels = []) {
    const usedNumbers = new Set();
    for (const label of Array.isArray(existingLabels) ? existingLabels : []) {
      const match = String(label || "").trim().match(/^char\s+(\d+)$/i);
      if (!match) {
        continue;
      }
      const labelNumber = Number.parseInt(match[1], 10);
      if (Number.isFinite(labelNumber) && labelNumber > 0) {
        usedNumbers.add(labelNumber);
      }
    }

    let nextNumber = 1;
    while (usedNumbers.has(nextNumber)) {
      nextNumber += 1;
    }
    return `Char ${nextNumber}`;
  }

  function normalizeQuickPrompt(value) {
    if (value == null) {
      return "";
    }
    return String(value);
  }

  function hasQuickPromptContent(value) {
    return normalizeQuickPrompt(value).trim().length > 0;
  }

  function mergeQuickPrompts(...values) {
    let mergedText = "";
    for (const value of values) {
      const normalizedValue = normalizeQuickPrompt(value);
      if (!hasQuickPromptContent(normalizedValue)) {
        continue;
      }
      if (!mergedText) {
        mergedText = normalizedValue;
        continue;
      }
      mergedText = `${mergedText.replace(/[,\s]+$/g, "")},\n${normalizedValue.replace(/^[,\s]+/g, "")}`;
    }
    return mergedText;
  }

  function parseGroupsDefinition(groupsDefinition) {
    const groups = [];
    const groupMap = new Map();
    let currentGroup = null;

    for (const rawLine of String(groupsDefinition || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const bracketMatch = line.match(/^\[(.+?)\]\s*$/);
      const colonMatch = line.match(/^([^:\[\]][^:]*)\s*:\s*$/);
      const groupName = bracketMatch?.[1]?.trim() || colonMatch?.[1]?.trim() || "";
      if (groupName) {
        currentGroup = groupName;
        if (!groupMap.has(groupName)) {
          const entry = { name: groupName, items: [] };
          groupMap.set(groupName, entry);
          groups.push(entry);
        }
        continue;
      }

      if (!currentGroup) {
        continue;
      }

      const item = normalizePromptItem(line);
      const group = groupMap.get(currentGroup);
      if (item && group && !group.items.includes(item)) {
        group.items.push(item);
      }
    }

    return groups;
  }

  function parseSelectionState(value) {
    if (!value) {
      return {};
    }
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }

      const normalized = {};
      for (const [groupName, items] of Object.entries(parsed)) {
        const cleaned = {};
        if (Array.isArray(items)) {
          for (const item of items) {
            const normalizedItem = normalizePromptItem(item);
            if (normalizedItem) {
              cleaned[normalizedItem] = DEFAULT_PROMPT_WEIGHT;
            }
          }
        } else if (typeof items === "string") {
          const normalizedItem = normalizePromptItem(items);
          if (normalizedItem) {
            cleaned[normalizedItem] = DEFAULT_PROMPT_WEIGHT;
          }
        } else if (items && typeof items === "object") {
          for (const [item, weight] of Object.entries(items)) {
            const normalizedItem = normalizePromptItem(item);
            if (normalizedItem) {
              cleaned[normalizedItem] = normalizePromptWeight(weight);
            }
          }
        }

        if (Object.keys(cleaned).length) {
          normalized[groupName] = cleaned;
        }
      }
      return normalized;
    } catch (error) {
      return {};
    }
  }

  function parseWeightMemoryState(value) {
    if (!value) {
      return {};
    }
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }

      const normalized = {};
      for (const [groupName, items] of Object.entries(parsed)) {
        if (!items || typeof items !== "object" || Array.isArray(items)) {
          continue;
        }

        const cleaned = {};
        for (const [item, weight] of Object.entries(items)) {
          const normalizedItem = normalizePromptItem(item);
          const normalizedWeight = normalizePromptWeight(weight);
          if (normalizedItem && normalizedWeight !== DEFAULT_PROMPT_WEIGHT) {
            cleaned[normalizedItem] = normalizedWeight;
          }
        }

        if (Object.keys(cleaned).length) {
          normalized[groupName] = cleaned;
        }
      }
      return normalized;
    } catch (error) {
      return {};
    }
  }

  function getRememberedPromptWeight(weightMemoryState, groupName, item) {
    const groupMemory = weightMemoryState?.[groupName];
    if (!groupMemory || !Object.prototype.hasOwnProperty.call(groupMemory, item)) {
      return DEFAULT_PROMPT_WEIGHT;
    }
    return normalizePromptWeight(groupMemory[item]);
  }

  function dedupeQuickPromptLines(quickPrompt, selectedItems) {
    const selectedLookup = new Set(
      selectedItems
        .map((item) => normalizePromptIdentity(item))
        .filter(Boolean),
    );
    const keptLines = [];

    for (const rawLine of String(quickPrompt || "").split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        keptLines.push("");
        continue;
      }
      const normalized = normalizePromptIdentity(trimmed);
      if (normalized && selectedLookup.has(normalized)) {
        continue;
      }
      keptLines.push(rawLine);
    }

    const dedupedText = keptLines.join("\n");
    return dedupedText.trim() ? dedupedText : "";
  }

  function normalizeStoredPromptState(groups, nextSelectionState, nextWeightMemoryState) {
    const prunedSelectionState = {};
    const prunedWeightMemoryState = {};

    for (const group of groups) {
      const selectedItems = nextSelectionState?.[group.name];
      const rememberedItems = nextWeightMemoryState?.[group.name];
      const validSelectedItems = {};
      const validRememberedItems = {};

      for (const item of group.items) {
        const hasSelectedItem = Boolean(
          selectedItems
            && typeof selectedItems === "object"
            && !Array.isArray(selectedItems)
            && Object.prototype.hasOwnProperty.call(selectedItems, item),
        );

        if (
          !hasSelectedItem
          && rememberedItems
          && typeof rememberedItems === "object"
          && !Array.isArray(rememberedItems)
          && Object.prototype.hasOwnProperty.call(rememberedItems, item)
        ) {
          const rememberedWeight = normalizePromptWeight(rememberedItems[item]);
          if (rememberedWeight !== DEFAULT_PROMPT_WEIGHT) {
            validRememberedItems[item] = rememberedWeight;
          }
        }

        if (hasSelectedItem) {
          const selectedWeight = normalizePromptWeight(selectedItems[item]);
          validSelectedItems[item] = selectedWeight;
          if (selectedWeight !== DEFAULT_PROMPT_WEIGHT) {
            validRememberedItems[item] = selectedWeight;
          }
        }
      }

      if (Object.keys(validSelectedItems).length) {
        prunedSelectionState[group.name] = validSelectedItems;
      }
      if (Object.keys(validRememberedItems).length) {
        prunedWeightMemoryState[group.name] = validRememberedItems;
      }
    }

    return {
      selectionState: prunedSelectionState,
      weightMemoryState: prunedWeightMemoryState,
    };
  }

  function canPruneMissingCharacterSlots({
    forcePruneMissingCharacters = false,
    hasStoredCharacterSlots = false,
    hasPromptMain = false,
    currentCharacterCount = 0,
    hasObservedCharacterDom = false,
  } = {}) {
    if (forcePruneMissingCharacters) {
      return true;
    }
    if (!hasStoredCharacterSlots) {
      return true;
    }
    if (!hasPromptMain) {
      return false;
    }
    return currentCharacterCount > 0 || hasObservedCharacterDom;
  }

  function buildSelectedPromptSections(groups, selectionState) {
    const sections = [];
    const selectedItems = [];

    for (const group of groups) {
      const groupSelectedItems = selectionState[group.name] || {};
      const validItems = group.items.filter((item) => Object.prototype.hasOwnProperty.call(groupSelectedItems, item));
      if (!validItems.length) {
        continue;
      }

      selectedItems.push(...validItems);
      const weightedItems = validItems.map((item) => formatPromptItemWithWeight(item, groupSelectedItems[item]));
      sections.push(`${weightedItems.filter(Boolean).join(", ")},`);
    }

    return { sections, selectedItems };
  }

  function buildPrompt(groups, selectionState, quickPrompt = "", options = {}) {
    const leading = buildSelectedPromptSections(groups, selectionState);
    const suffixSelectionState = options?.suffixSelectionState || {};
    const suffix = buildSelectedPromptSections(groups, suffixSelectionState);
    const sections = [...leading.sections];
    const quickPromptText = dedupeQuickPromptLines(
      normalizeQuickPrompt(quickPrompt),
      [...leading.selectedItems, ...suffix.selectedItems],
    );
    if (quickPromptText) {
      sections.push(quickPromptText);
    }
    sections.push(...suffix.sections);

    return sections.join("\n\n");
  }

  const api = {
    DEFAULT_CHARACTER_LABEL,
    DEFAULT_CHARACTER_PROMPT_GROUPS_DEFINITION,
    DEFAULT_GROUPS_DEFINITION,
    DEFAULT_MAIN_GROUPS_DEFINITION,
    DEFAULT_NEGATIVE_GROUPS_DEFINITION,
    DEFAULT_PROMPT_WEIGHT,
    MIN_PROMPT_WEIGHT,
    MAX_PROMPT_WEIGHT,
    PROMPT_WEIGHT_STEP,
    buildPrompt,
    canPruneMissingCharacterSlots,
    dedupeQuickPromptLines,
    formatPromptItemWithWeight,
    formatPromptWeightLabel,
    formatPromptWeightValue,
    getNextCharacterLabel,
    getRememberedPromptWeight,
    hasQuickPromptContent,
    mergeQuickPrompts,
    normalizePromptIdentity,
    normalizePromptItem,
    normalizePromptWeight,
    normalizeQuickPrompt,
    normalizeStoredPromptState,
    parseGroupsDefinition,
    parseSelectionState,
    parseWeightMemoryState,
    unwrapNovelAiWeightSyntax,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.NAIPromptCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
