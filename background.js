"use strict";

const TAB_ACTIONS = new Set([
  "ping",
  "togglePanel",
  "openPanel",
  "applySelectorPrompt",
  "generateOnce",
  "startAutoGenerate",
  "cancelAutoGenerate",
  "getContentStatus",
]);

function sanitizeFilenamePart(value) {
  return String(value || "prompt")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48) || "prompt";
}

function sendMessageToActiveNovelAiTab(request, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id || !tab.url?.startsWith("https://novelai.net/image")) {
      sendResponse({ ok: false, error: "NovelAI image page is not active." });
      return;
    }

    chrome.tabs.sendMessage(tab.id, request, (response) => {
      if (!chrome.runtime.lastError) {
        sendResponse(response);
        return;
      }

      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] }, () => {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["prompt-core.js", "prompt-storage.js", "content.js"] }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          chrome.tabs.sendMessage(tab.id, request, (retryResponse) => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            sendResponse(retryResponse);
          });
        });
      });
    });
  });
}

function createCompletionNotification(count) {
  const message = count && count > 0
    ? `총 ${count}장의 이미지 생성이 완료되었습니다.`
    : "설정된 자동 생성 작업이 완료되었습니다.";

  chrome.storage.sync.get(["autoCompletionNotificationEnabled"], (result = {}) => {
    if (result.autoCompletionNotificationEnabled !== false) {
      chrome.notifications.create(`nai-prompt-selector-complete-${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon48.png"),
        title: "자동 생성 완료",
        message,
        priority: 0,
        requireInteraction: false,
      });
    }

    resetPopupButtons();
  });
}

function resetPopupButtons() {
  chrome.runtime.sendMessage({ action: "resetPopupButtons" }, () => {
    void chrome.runtime.lastError;
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (TAB_ACTIONS.has(request?.action)) {
    sendMessageToActiveNovelAiTab(request, sendResponse);
    return true;
  }

  if (request?.action === "showCompletionNotification") {
    createCompletionNotification(request.count);
    sendResponse({ ok: true });
    return false;
  }

  if (request?.action === "resetPopupButtons") {
    resetPopupButtons();
    sendResponse({ ok: true });
    return false;
  }

  if (request?.action === "downloadImage" && request.imageUrl) {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    const filename = `NovelAI/${stamp}_${sanitizeFilenamePart(request.promptText)}.png`;

    chrome.downloads.download({ url: request.imageUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, downloadId });
    });
    return true;
  }

  if (request?.action === "closePopup") {
    chrome.runtime.sendMessage({ action: "closePopup" }, () => {
      void chrome.runtime.lastError;
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
