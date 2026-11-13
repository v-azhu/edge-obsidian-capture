import { getCaptureSettings, getSetting } from "./storage.js";
import { writeCapture } from "./capture-writer.js";
import {
  extractCaptureContent,
  hideFixedElements,
  readScrollMetrics,
  restoreAfterCapture,
  scrollToPosition,
  startRegionSelection,
} from "./page-scripts.js";

const MENU_ITEMS = [
  { id: "obsidian-capture-page", mode: "page", title: "保存页面文字到 Obsidian", contexts: ["page"] },
  { id: "obsidian-capture-selection", mode: "selection", title: "保存选中文字到 Obsidian", contexts: ["selection"] },
  {
    id: "obsidian-capture-screenshot",
    mode: "screenshot",
    title: "保存可见区域截图到 Obsidian",
    contexts: ["page", "selection", "image"],
  },
  {
    id: "obsidian-capture-region",
    mode: "region",
    title: "保存滚动区域截图到 Obsidian",
    contexts: ["page", "selection", "image"],
  },
];

// 区域截图的单边上限（设备像素），超过浏览器的纹理上限会失败。
const MAX_CAPTURE_EDGE_PIXELS = 16000;
// 浏览器限制 captureVisibleTab 每秒最多调用 2 次。
const CAPTURE_INTERVAL_MS = 600;

const RESULT_WINDOW_WIDTH = 380;
const RESULT_WINDOW_HEIGHT = 300;
const RESULT_WINDOW_TOP_OFFSET = 48;
const RESULT_WINDOW_RIGHT_MARGIN = 24;
// 位置由结果窗口自己在被拖动时写入（见 result.js）。
const RESULT_WINDOW_POSITION_KEY = "resultWindowPosition";
// 窗口 ID 只在本次浏览器会话内有效，所以放在 session 存储里。
// 以前放在 IndexedDB，浏览器重启后窗口 ID 会被复用，可能误关用户的普通窗口。
const RESULT_WINDOW_ID_KEY = "resultWindowId";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.error("Could not reset capture menus:", chrome.runtime.lastError.message);
      return;
    }

    for (const { id, title, contexts } of MENU_ITEMS) {
      chrome.contextMenus.create({ id, title, contexts });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const item = MENU_ITEMS.find((candidate) => candidate.id === info.menuItemId);
  if (item) {
    void captureAndSave(info, tab, item.mode);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  void clearResultWindowId(windowId).catch((error) => {
    console.error("Could not clear the capture result window ID:", error);
  });
});

async function captureAndSave(info, tab, mode) {
  if (!tab?.id) {
    await showResult("error", "无法识别当前标签页。");
    return;
  }

  if (mode === "region") {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: startRegionSelection,
      });
    } catch (error) {
      console.error("Could not start region selection:", error);
      await showResult("error", `无法在此页面选择截图区域：${errorMessage(error)}`);
    }
    return; // 用户选完区域后，由 "region-selected" 消息继续。
  }

  await runCapture(tab, mode, async (capture) => {
    if (mode === "selection") {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
        func: extractCaptureContent,
        args: ["selection"],
      });
      const selected = injected?.result;
      capture.selection = selected?.content || info.selectionText?.trim() || "";
      if (!capture.selection) {
        throw new Error("无法读取选中的内容。请重新选择文字或图片后再试。");
      }

      capture.attachments = [];
      for (const [index, image] of (selected?.images ?? []).entries()) {
        try {
          capture.attachments.push({
            token: `\u0000OBSIDIAN_IMAGE_${index}\u0000`,
            blob: await fetchImageBlob(image.source, tab.id, info.frameId),
          });
        } catch (error) {
          throw new Error(
            `无法保存选区中的第 ${index + 1} 张图片（${image.alt || image.source}）：${errorMessage(error)}`,
          );
        }
      }
      if (capture.attachments.length) {
        return `已保存选区中的 ${capture.attachments.length} 张图片。`;
      }
    } else if (mode === "page") {
      Object.assign(capture, await readPage(tab.id));
    } else if (mode === "screenshot") {
      capture.blob = await captureScreenshot(tab);
    }
    return "";
  });
}

// 统一的“取得内容 → 写入 Vault → 显示结果”流程。build 可以返回一段附加提示。
async function runCapture(tab, mode, build) {
  const capture = { mode, title: tab.title ?? "", url: tab.url ?? "" };
  try {
    const notice = await build(capture);
    const { path, attachmentPath, attachmentPaths, vaultName } = await writeCapture(capture);
    const lines = [path];
    if (attachmentPath) lines.push(`截图：${attachmentPath}`);
    if (attachmentPaths?.length) lines.push(`图片附件：${attachmentPaths.length} 张`);
    if (notice) lines.push(notice);
    lines.push(`Vault 文件夹：${vaultName}`);
    await showResult("success", lines.join("\n"));
  } catch (error) {
    console.error("Could not save the Obsidian capture:", error);
    await showResult("error", errorMessage(error));
  }
}

async function readPage(tabId) {
  const settings = await getCaptureSettings();
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractCaptureContent,
    args: ["page", settings.pageUseReaderMode === true],
  });

  if (!injected?.result) {
    throw new Error("网页没有返回可读取的内容。");
  }
  return {
    title: injected.result.title,
    url: injected.result.url,
    pageText: injected.result.content,
  };
}

async function fetchImageBlob(sourceUrl, tabId, frameId) {
  if (!sourceUrl) {
    throw new Error("图片没有可读取的网址。");
  }

  if (!sourceUrl.startsWith("blob:")) {
    try {
      const response = await fetch(sourceUrl, { credentials: "include" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.blob();
    } catch (error) {
      if (sourceUrl.startsWith("data:")) {
        throw error;
      }
    }
  }

  const [injected] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId ?? 0] },
    func: async (url) => {
      try {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) {
          return { error: `HTTP ${response.status}` };
        }
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        return { dataUrl };
      } catch (error) {
        return { error: String(error?.message ?? error) };
      }
    },
    args: [sourceUrl],
  });
  if (!injected?.result?.dataUrl) {
    throw new Error(injected?.result?.error ?? "网页没有返回图片数据");
  }
  return (await fetch(injected.result.dataUrl)).blob();
}

async function grabVisibleTab(tab, options) {
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, options);
  } catch (error) {
    throw new Error(`无法截取当前页面（浏览器内置页面和应用商店页面不支持截图）：${errorMessage(error)}`);
  }
}

async function getScreenshotFormat() {
  const settings = await getCaptureSettings();
  return settings.screenshotFormat === "jpeg" ? "jpeg" : "png";
}

// 截取当前标签页的可见区域。
async function captureScreenshot(tab) {
  const format = await getScreenshotFormat();
  const dataUrl = await grabVisibleTab(
    tab,
    format === "jpeg" ? { format, quality: 92 } : { format },
  );
  return (await fetch(dataUrl)).blob();
}

// 区域截图可跨越多屏：优先让浏览器直接渲染文档坐标的裁剪区域，
// 调试接口不可用时再逐屏滚动、裁剪并拼接。
async function captureRegion(message, tab) {
  const rect = message?.rect;
  const viewportWidth = message?.viewportWidth;
  if (!(rect?.width > 0) || !(rect?.height > 0) || !(viewportWidth > 0)) {
    throw new Error("没有收到有效的截图区域。");
  }

  const format = await getScreenshotFormat();
  const [pageMetrics] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readScrollMetrics,
  });
  const metrics = pageMetrics?.result;
  if (!metrics?.viewportHeight) {
    throw new Error("无法读取页面尺寸。");
  }

  const selectionViewportY = message.viewportY ?? metrics.scrollY;
  const extendsBeyondViewport =
    rect.y < selectionViewportY ||
    rect.y + rect.height > selectionViewportY + metrics.viewportHeight;
  if (extendsBeyondViewport) {
    // Edge 的 CDP 截图在捕获超出当前视口的 clip 时会重复当前视口画面。
    // 长区域改用真实滚动并逐屏裁剪拼接，避免把同一屏内容重复写入。
    return captureRegionByScrolling(rect, message, tab, format, metrics);
  }

  let debuggerFailure;
  try {
    return await captureRegionWithDebugger(rect, tab, format);
  } catch (error) {
    debuggerFailure = errorMessage(error);
    console.error("Long-region capture through the debugger failed:", error);
  }

  try {
    const result = await captureRegionByScrolling(rect, message, tab, format, metrics);
    return {
      blob: result.blob,
      notice: `已改用滚动拼接截图（调试接口失败：${debuggerFailure}）。`,
    };
  } catch (error) {
    console.error("Long-region capture by scrolling failed:", error);
    throw new Error(`长区域截图失败。调试接口：${debuggerFailure}；滚动拼接：${errorMessage(error)}`);
  }
}

async function captureRegionWithDebugger(rect, tab, format) {
  const target = { tabId: tab.id };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (error) {
    throw new Error(`attach：${errorMessage(error)}`);
  }

  try {
    const metrics = await sendDebuggerCommand(target, "Page.getLayoutMetrics");
    const content = metrics.cssContentSize ?? metrics.contentSize;
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    const width = Math.min(rect.width, content.width - x);
    const height = Math.min(rect.height, content.height - y);
    if (!(width > 0) || !(height > 0)) {
      throw new Error("选区超出了网页内容范围。");
    }

    const ratio = await sendDebuggerCommand(target, "Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true,
    });
    const deviceScale = Math.min(Math.max(Number(ratio?.result?.value) || 1, 1), 2);
    const scale = Math.min(
      deviceScale,
      MAX_CAPTURE_EDGE_PIXELS / width,
      MAX_CAPTURE_EDGE_PIXELS / height,
    );
    const shot = await sendDebuggerCommand(target, "Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: 92 } : {}),
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x, y, width, height, scale },
    });
    return {
      blob: base64ToBlob(shot.data, `image/${format}`),
      notice: scale < deviceScale ? "选区较大，截图已自动降低分辨率。" : "",
    };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function captureRegionByScrolling(rect, message, tab, format, initialMetrics) {
  const run = async (func, args = []) => {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args,
    });
    return injected?.result;
  };
  const metrics = initialMetrics ?? await run(readScrollMetrics);
  if (!metrics?.viewportHeight || !metrics?.viewportWidth) {
    throw new Error("无法读取页面尺寸。");
  }

  const startX = Math.max(rect.x, message.viewportX ?? metrics.scrollX);
  const endX = Math.min(
    rect.x + rect.width,
    (message.viewportX ?? metrics.scrollX) + message.viewportWidth,
  );
  const startY = Math.max(0, rect.y);
  const endY = Math.min(rect.y + rect.height, metrics.totalHeight);
  const regionWidth = endX - startX;
  const regionHeight = endY - startY;
  if (!(regionWidth > 0) || !(regionHeight > 0)) {
    throw new Error("选区超出了网页内容范围。");
  }

  const maxCssHeight = Math.floor(
    MAX_CAPTURE_EDGE_PIXELS /
      Math.min(Math.max(metrics.devicePixelRatio, 1), 2),
  );
  const capturedEndY = Math.min(endY, startY + maxCssHeight);
  let canvas;
  let context;
  let scale = 1;
  let lastCaptureAt = 0;
  let nextY = startY;
  let fixedElementsHidden = false;

  try {
    while (nextY < capturedEndY) {
      const top = Math.min(
        nextY,
        Math.max(0, metrics.totalHeight - metrics.viewportHeight),
      );
      const actualTop = await run(scrollToPosition, [top]);
      const visibleTop = actualTop ?? top;
      const sliceTop = Math.max(startY, visibleTop);
      const sliceBottom = Math.min(
        capturedEndY,
        visibleTop + metrics.viewportHeight,
      );
      if (sliceBottom <= nextY) {
        throw new Error("页面滚动没有前进，无法继续拼接截图。");
      }

      if (nextY > startY && !fixedElementsHidden) {
        await run(hideFixedElements);
        fixedElementsHidden = true;
      }

      const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      const dataUrl = await grabVisibleTab(tab, { format: "png" });
      lastCaptureAt = Date.now();
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
      try {
        if (!canvas) {
          scale = bitmap.width / metrics.viewportWidth;
          canvas = new OffscreenCanvas(
            Math.round(regionWidth * scale),
            Math.round((capturedEndY - startY) * scale),
          );
          context = canvas.getContext("2d");
        }

        const sourceX = Math.round((startX - metrics.scrollX) * scale);
        const sourceY = Math.round((sliceTop - visibleTop) * scale);
        const sourceWidth = Math.min(
          bitmap.width - sourceX,
          Math.round(regionWidth * scale),
        );
        const sourceHeight = Math.min(
          bitmap.height - sourceY,
          Math.round((sliceBottom - sliceTop) * scale),
        );
        const destinationY = Math.round((sliceTop - startY) * scale);
        if (sourceWidth < 1 || sourceHeight < 1) {
          throw new Error("截图区域超出了页面可见范围。");
        }
        context.drawImage(
          bitmap,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          destinationY,
          sourceWidth,
          sourceHeight,
        );
      } finally {
        bitmap.close();
      }
      nextY = sliceBottom;
    }
  } finally {
    await run(restoreAfterCapture, [metrics.scrollX, metrics.scrollY]).catch(() => {});
  }

  const blob = await canvas.convertToBlob(
    format === "jpeg"
      ? { type: "image/jpeg", quality: 0.92 }
      : { type: "image/png" },
  );
  return {
    blob,
    notice: capturedEndY < endY
      ? `选区过长，只截取前 ${capturedEndY - startY} CSS 像素。`
      : "",
  };
}

// 调用调试接口命令；失败时在错误信息里标明是哪一步。
async function sendDebuggerCommand(target, method, params) {
  try {
    return await chrome.debugger.sendCommand(target, method, params);
  } catch (error) {
    throw new Error(`${method}：${errorMessage(error)}`);
  }
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function showResult(status, message) {
  const query = new URLSearchParams({ status, message });
  try {
    await closePreviousResultWindow();

    const bounds = await getResultWindowBounds();
    const resultWindow = await chrome.windows.create({
      url: chrome.runtime.getURL(`result.html?${query}`),
      type: "popup",
      ...bounds,
      focused: true,
    });
    if (resultWindow.id !== undefined) {
      await chrome.storage.session.set({ [RESULT_WINDOW_ID_KEY]: resultWindow.id });
    }
  } catch (error) {
    console.error("Could not open the capture result window:", error);
  }
}

async function closePreviousResultWindow() {
  const stored = await chrome.storage.session.get(RESULT_WINDOW_ID_KEY);
  const previousWindowId = stored[RESULT_WINDOW_ID_KEY];
  if (previousWindowId === undefined) {
    return;
  }
  await chrome.storage.session.remove(RESULT_WINDOW_ID_KEY);

  try {
    // 关闭前确认它确实是结果窗口，绝不误关普通浏览器窗口。
    const previous = await chrome.windows.get(previousWindowId, { populate: true });
    const resultPageUrl = chrome.runtime.getURL("result.html");
    const isResultWindow = previous.type === "popup" &&
      (previous.tabs ?? []).every((tab) => !tab.url || tab.url.startsWith(resultPageUrl));
    if (isResultWindow) {
      await chrome.windows.remove(previousWindowId);
    }
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("No window with id"))) {
      console.error("Could not close the previous capture result window:", error);
    }
  }
}

async function getResultWindowBounds() {
  const savedPosition = await getSetting(RESULT_WINDOW_POSITION_KEY);
  if (
    Number.isFinite(savedPosition?.left) &&
    Number.isFinite(savedPosition?.top)
  ) {
    return {
      left: savedPosition.left,
      top: savedPosition.top,
      width: RESULT_WINDOW_WIDTH,
      height: RESULT_WINDOW_HEIGHT,
    };
  }

  // 第一次显示：放在当前浏览器窗口的右上角，不遮挡页面主体内容。
  const browserWindow = await chrome.windows.getLastFocused();
  const left = Number.isFinite(browserWindow.left) && Number.isFinite(browserWindow.width)
    ? browserWindow.left + browserWindow.width - RESULT_WINDOW_WIDTH - RESULT_WINDOW_RIGHT_MARGIN
    : undefined;
  const top = Number.isFinite(browserWindow.top)
    ? browserWindow.top + RESULT_WINDOW_TOP_OFFSET
    : undefined;

  return {
    ...(left === undefined ? {} : { left: Math.max(0, left) }),
    ...(top === undefined ? {} : { top: Math.max(0, top) }),
    width: RESULT_WINDOW_WIDTH,
    height: RESULT_WINDOW_HEIGHT,
  };
}

async function clearResultWindowId(windowId) {
  const stored = await chrome.storage.session.get(RESULT_WINDOW_ID_KEY);
  if (stored[RESULT_WINDOW_ID_KEY] === windowId) {
    await chrome.storage.session.remove(RESULT_WINDOW_ID_KEY);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "region-selected") {
    if (sender.id === chrome.runtime.id && sender.tab?.id !== undefined) {
      const tab = sender.tab;
      void runCapture(tab, "region", async (capture) => {
        const { blob, notice } = await captureRegion(message, tab);
        capture.blob = blob;
        return notice;
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== "close-result-window" && message?.type !== "open-settings") {
    return false;
  }

  if (message.type === "open-settings") {
    chrome.runtime.openOptionsPage()
      .then(() => {
        sendResponse({ ok: true });
        void closeResultWindow(sender);
      })
      .catch((error) => {
        console.error("Could not open capture settings:", error);
        sendResponse({ ok: false, error: errorMessage(error) });
      });
    return true;
  }

  sendResponse({ ok: true });
  void closeResultWindow(sender);
  return false;
});

async function closeResultWindow(sender) {
  try {
    const windowId = sender.tab?.windowId;
    if (windowId === undefined) {
      throw new Error("Could not identify the capture result window.");
    }
    await chrome.windows.remove(windowId);
  } catch (error) {
    console.error("Could not close the capture result window:", error);
  }
}
