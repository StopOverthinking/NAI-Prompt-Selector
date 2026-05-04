"use strict";

const refs = {};

function $(id) {
  return document.getElementById(id);
}

function runtimeSend(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: true });
    });
  });
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (result) => resolve(result || {}));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(values, () => resolve());
  });
}

function setStatus(message, tone = "neutral") {
  refs.pageStatus.textContent = message || "";
  refs.pageStatus.dataset.tone = tone;
}

function setInteractiveDisabled(disabled) {
  for (const element of document.querySelectorAll("button, input")) {
    element.disabled = disabled;
  }
}

function updateAutoButtons(isActive) {
  refs.oneClickBtn.disabled = isActive;
  refs.autoStartBtn.disabled = isActive;
  refs.cancelAutoBtn.disabled = !isActive;
  refs.intervalInput.disabled = isActive;
  refs.gcountInput.disabled = isActive;
}

async function refreshPageState() {
  const response = await runtimeSend({ action: "ping" });
  if (!response?.ok) {
    setInteractiveDisabled(true);
    setStatus("NovelAI 이미지 페이지에서만 사용 가능합니다.", "warn");
    return false;
  }

  setInteractiveDisabled(false);
  const { autoClickEnabled = false } = await storageGet(["autoClickEnabled"]);
  updateAutoButtons(Boolean(response.autoActive || autoClickEnabled));

  if (!response.hasGenerateButton) {
    setStatus("Generate 버튼을 기다리는 중입니다.", "warn");
  } else if (!response.promptEditorCount) {
    setStatus("Base Prompt 입력 영역을 기다리는 중입니다.", "warn");
  } else {
    setStatus("NovelAI 페이지와 연결되었습니다.", "ok");
  }
  return true;
}

async function loadSettings() {
  const {
    intervalTime = 3,
    gcount = "",
    autoSaveEnabled = false,
    volume = 0.5,
  } = await storageGet(["intervalTime", "gcount", "autoSaveEnabled", "volume"]);

  refs.intervalInput.value = intervalTime;
  refs.gcountInput.value = gcount;
  refs.autoSaveCheckbox.checked = Boolean(autoSaveEnabled);
  refs.volumeSlider.value = Math.round(Number(volume) * 100);
  refs.volumeValue.textContent = `${refs.volumeSlider.value}%`;
}

async function handleAction(message, successText) {
  const response = await runtimeSend(message);
  if (response?.ok) {
    setStatus(successText, "ok");
    await refreshPageState();
  } else {
    setStatus(response?.error || "명령 실행에 실패했습니다.", "warn");
  }
}

function bindEvents() {
  refs.openPanelBtn.addEventListener("click", () => {
    void handleAction({ action: "openPanel" }, "페이지 패널을 열었습니다.");
  });

  refs.applySelectorBtn.addEventListener("click", () => {
    void handleAction({ action: "applySelectorPrompt" }, "전체 슬롯을 적용했습니다.");
  });

  refs.oneClickBtn.addEventListener("click", () => {
    void handleAction({ action: "generateOnce", useSelector: false }, "1회 생성을 시작했습니다.");
  });

  refs.autoStartBtn.addEventListener("click", () => {
    void handleAction({ action: "startAutoGenerate", useSelector: false }, "자동 생성을 시작했습니다.");
  });

  refs.cancelAutoBtn.addEventListener("click", () => {
    void handleAction({ action: "cancelAutoGenerate" }, "자동 생성을 취소했습니다.");
  });

  refs.intervalInput.addEventListener("change", () => {
    void storageSet({ intervalTime: refs.intervalInput.value });
  });

  refs.gcountInput.addEventListener("change", () => {
    void storageSet({ gcount: refs.gcountInput.value });
  });

  document.querySelectorAll(".gcountPresetBtn").forEach((button) => {
    button.addEventListener("click", () => {
      refs.gcountInput.value = button.dataset.gcount || "";
      void storageSet({ gcount: refs.gcountInput.value });
    });
  });

  refs.autoSaveCheckbox.addEventListener("change", () => {
    void storageSet({ autoSaveEnabled: refs.autoSaveCheckbox.checked });
  });

  refs.volumeSlider.addEventListener("input", () => {
    refs.volumeValue.textContent = `${refs.volumeSlider.value}%`;
    void storageSet({ volume: Number(refs.volumeSlider.value) / 100 });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === "resetPopupButtons") {
      updateAutoButtons(false);
      void storageSet({ autoClickEnabled: false });
      setStatus("자동 생성이 완료되었습니다.", "ok");
    }
    if (message?.action === "closePopup") {
      window.close();
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  Object.assign(refs, {
    pageStatus: $("pageStatus"),
    openPanelBtn: $("openPanelBtn"),
    applySelectorBtn: $("applySelectorBtn"),
    intervalInput: $("intervalInput"),
    gcountInput: $("gcountInput"),
    autoSaveCheckbox: $("autoSaveCheckbox"),
    volumeSlider: $("volumeSlider"),
    volumeValue: $("volumeValue"),
    oneClickBtn: $("oneClickBtn"),
    autoStartBtn: $("autoStartBtn"),
    cancelAutoBtn: $("cancelAutoBtn"),
  });

  setInteractiveDisabled(true);
  bindEvents();
  await loadSettings();
  await refreshPageState();
});
