// 这里的函数会被序列化后注入网页执行，必须自包含，不能引用本文件里的其他变量。

export function extractCaptureContent(mode, useReaderMode = false) {
  const page = { title: document.title, url: location.href };
  let root;
  let selectedImages = [];

  if (mode === "selection") {
    const selection = window.getSelection();
    if (!selection?.rangeCount) {
      return { ...page, content: selection?.toString().trim() ?? "", images: [] };
    }

    const range = selection.getRangeAt(0);
    const container = document.createElement("div");
    container.append(range.cloneContents());
    selectedImages = Array.from(document.images)
      .filter((image) => {
        try {
          return range.intersectsNode(image);
        } catch {
          return false;
        }
      })
      .map((image) =>
        image.currentSrc || image.src || image.getAttribute("data-src") || image.getAttribute("data-original") || "",
      );
    for (const [index, image] of Array.from(container.querySelectorAll("img")).entries()) {
      if (selectedImages[index]) {
        image.dataset.captureSource = selectedImages[index];
      }
    }
    root = container;
  } else {
    root = document.body;
    if (useReaderMode) {
      const candidates = Array.from(
        document.querySelectorAll("article, main, [role='main'], [itemprop='articleBody']"),
      );
      const scored = candidates
        .map((element) => {
          const text = element.innerText?.trim() ?? "";
          const paragraphs = Array.from(element.querySelectorAll("p"))
            .filter((paragraph) => (paragraph.innerText?.trim().length ?? 0) > 40);
          const paragraphTextLength = paragraphs.reduce(
            (total, paragraph) => total + (paragraph.innerText?.trim().length ?? 0),
            0,
          );
          const linkTextLength = Array.from(element.querySelectorAll("a"))
            .reduce((total, link) => total + (link.innerText?.length ?? 0), 0);
          const linkDensity = text.length ? linkTextLength / text.length : 1;
          return {
            element,
            score: paragraphTextLength + paragraphs.length * 100 - linkDensity * text.length,
          };
        })
        .filter((candidate) => (candidate.element.innerText?.trim().length ?? 0) >= 200)
        .sort((left, right) => right.score - left.score);
      root = scored[0]?.element ?? root;
    }
  }

  const contentRoot = root.cloneNode(true);
  const sourceNodes = mode === "page" ? [root, ...root.querySelectorAll("*")] : [];
  const clonedNodes = mode === "page"
    ? [contentRoot, ...contentRoot.querySelectorAll("*")]
    : [];
  for (let index = 0; index < sourceNodes.length; index += 1) {
    const style = getComputedStyle(sourceNodes[index]);
    if (
      sourceNodes[index].hidden ||
      sourceNodes[index].getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden"
    ) {
      clonedNodes[index].remove();
    }
  }
  for (const element of contentRoot.querySelectorAll(
    "nav, aside, footer, script, style, noscript, template, form, button, input, select, textarea, dialog",
  )) {
    element.remove();
  }

  const images = [];
  function safeLink(value) {
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }
  function renderChildren(element) {
    return Array.from(element.childNodes, renderNode).join("");
  }
  function block(value) {
    const content = value.trim();
    return content ? `\n\n${content}\n\n` : "";
  }
  function renderList(list) {
    const ordered = list.tagName === "OL";
    const start = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
    const items = Array.from(list.children).filter((child) => child.tagName === "LI");
    return block(items.map((item, index) => {
      const marker = ordered ? `${start + index}. ` : "- ";
      const lines = renderChildren(item).trim().split("\n");
      return `${marker}${lines[0] ?? ""}${lines.length > 1
        ? `\n${lines.slice(1).map((line) => `  ${line}`).join("\n")}`
        : ""}`;
    }).join("\n"));
  }
  function renderTable(table) {
    const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.children)
        .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
        .map((cell) => renderChildren(cell).trim().replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|")),
    ).filter((row) => row.length);
    if (!rows.length) return "";
    const columns = Math.max(...rows.map((row) => row.length));
    const formatRow = (row) => `| ${Array.from({ length: columns }, (_, index) => row[index] ?? "").join(" | ")} |`;
    const header = rows[0];
    return block([
      formatRow(header),
      formatRow(Array(columns).fill("---")),
      ...rows.slice(1).map(formatRow),
    ].join("\n"));
  }
  function renderNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue.replace(/\s+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const tag = node.tagName;
    if (tag === "BR") return "\n";
    if (tag === "IMG") {
      const alt = node.getAttribute("alt")?.trim();
      if (mode !== "selection") {
        return `[图片${alt ? `：${alt}` : ""}]`;
      }
      const source = node.dataset.captureSource || node.getAttribute("src") || "";
      if (!source) return `[图片${alt ? `：${alt}` : ""}]`;
      const index = images.push({ source, alt: alt ?? "" }) - 1;
      return `\u0000OBSIDIAN_IMAGE_${index}\u0000`;
    }
    if (tag === "VIDEO" || tag === "AUDIO" || tag === "IFRAME" || tag === "EMBED" || tag === "OBJECT") {
      const label = tag === "VIDEO" ? "视频" : tag === "AUDIO" ? "音频" : "嵌入内容";
      const title = node.getAttribute("title") || node.getAttribute("aria-label") || "";
      const source = node.getAttribute("src") || node.querySelector("source")?.getAttribute("src");
      const description = `${label}${title ? `：${title}` : ""}`;
      const href = source ? safeLink(source) : "";
      if (mode !== "selection" || !href) return `[${description}]`;
      return `[${description}](${href})`;
    }
    if (tag === "CANVAS" || tag === "SVG") {
      return `[图片${node.getAttribute("aria-label") ? `：${node.getAttribute("aria-label")}` : ""}]`;
    }
    if (tag === "UL" || tag === "OL") return renderList(node);
    if (tag === "TABLE") return renderTable(node);
    if (tag === "PRE") {
      const code = node.querySelector("code");
      const language = code?.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? "";
      return block(`\`\`\`${language}\n${(code ?? node).textContent.trim()}\n\`\`\``);
    }

    const content = renderChildren(node);
    if (/^H[1-6]$/.test(tag)) {
      return block(`${"#".repeat(Number(tag[1]))} ${content.trim()}`);
    }
    if (tag === "BLOCKQUOTE") {
      return block(content.trim().split("\n").map((line) => `> ${line}`).join("\n"));
    }
    if (tag === "A") {
      const href = safeLink(node.getAttribute("href") ?? "");
      return href && content.trim()
        ? `[${content.trim()}](${href})`
        : content;
    }
    if (tag === "STRONG" || tag === "B") return `**${content.trim()}**`;
    if (tag === "EM" || tag === "I") return `*${content.trim()}*`;
    if (tag === "DEL" || tag === "S" || tag === "STRIKE") return `~~${content.trim()}~~`;
    if (tag === "CODE") return `\`${content.trim().replaceAll("`", "\\`")}\``;
    if (tag === "U") return `<u>${content.trim()}</u>`;
    if (tag === "HR") return block("---");
    if (/^(ADDRESS|ARTICLE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|HEADER|LI|MAIN|P|SECTION)$/.test(tag)) {
      return block(content);
    }
    return content;
  }

  const content = renderNode(contentRoot)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return mode === "selection"
    ? { ...page, content, images }
    : { ...page, content };
}

// 在页面上显示选框：拖动选择区域，Esc 取消。选完先移除选框，再把区域坐标发给后台，
// 这样截图里不会带上选框本身。
export function startRegionSelection() {
  if (window.__obsidianRegionSelecting) {
    return;
  }
  window.__obsidianRegionSelecting = true;

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;user-select:none;";
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;display:none;box-sizing:border-box;border:2px solid #3478c8;" +
    "box-shadow:0 0 0 100vmax rgba(0,0,0,.35);pointer-events:none;";
  const hint = document.createElement("div");
  hint.textContent = "按住左键从左上向右下拖动；按住左键滚动滚轮延伸长截图，松开保存，Esc 取消";
  hint.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);" +
    "padding:6px 12px;border-radius:6px;background:rgba(0,0,0,.8);color:#fff;" +
    "font:14px/1.4 system-ui,sans-serif;text-align:center;pointer-events:none;";
  overlay.append(box, hint);
  document.documentElement.append(overlay);

  let start;
  let current;
  let startedAtScrollX;
  let startedAtScrollY;

  const clampPoint = (event) => ({
    x: Math.min(Math.max(0, event.clientX), window.innerWidth),
    y: Math.min(Math.max(0, event.clientY), window.innerHeight),
  });
  const documentPoint = (point) => ({
    x: window.scrollX + point.x,
    y: window.scrollY + point.y,
  });
  const currentRect = () => {
    const end = documentPoint(current);
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  };

  function cleanup() {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    window.removeEventListener("wheel", onWheel, true);
    window.removeEventListener("scroll", onScroll, true);
    overlay.remove();
    window.__obsidianRegionSelecting = false;
  }

  function updateSelection() {
    if (!start || !current) return;
    const rect = currentRect();
    const screenRect = {
      x: Math.min(start.screenX, current.x),
      y: Math.min(start.screenY, current.y),
      width: Math.abs(current.x - start.screenX),
      height: Math.abs(current.y - start.screenY),
    };

    box.style.display = "block";
    box.style.left = `${screenRect.x}px`;
    box.style.top = `${screenRect.y}px`;
    box.style.width = `${screenRect.width}px`;
    box.style.height = `${screenRect.height}px`;
    hint.textContent =
      `截图区域 ${Math.round(rect.width)} × ${Math.round(rect.height)} CSS 像素 · ` +
      "按住左键滚轮延伸，松开保存，Esc 取消";
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    }
  }

  function onMouseMove(event) {
    if (!start) return;
    current = clampPoint(event);
    updateSelection();
  }

  function onWheel(event) {
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    current = clampPoint(event);
    window.scrollBy({
      left: 0,
      top: event.deltaY,
      behavior: "instant",
    });
    updateSelection();
  }

  function onScroll() {
    if (start && current) {
      updateSelection();
    }
  }

  function onMouseUp(event) {
    if (!start) return;
    current = clampPoint(event);
    const rect = currentRect();
    cleanup();
    if (rect.width < 5 || rect.height < 5) {
      return;
    }

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: "region-selected",
        rect,
        viewportX: startedAtScrollX,
        viewportY: startedAtScrollY,
        viewportWidth: window.innerWidth,
      });
    }, 150);
  }

  overlay.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = clampPoint(event);
    startedAtScrollX = window.scrollX;
    startedAtScrollY = window.scrollY;
    start = {
      x: startedAtScrollX + point.x,
      y: startedAtScrollY + point.y,
      screenX: point.x,
      screenY: point.y,
    };
    current = clampPoint(event);
    updateSelection();
  });
  overlay.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("scroll", onScroll, true);
}

// ---- 以下四个函数用于滚动区域截图 ----

export function readScrollMetrics() {
  return {
    totalHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
    ),
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

// 滚动到指定位置，稍等页面渲染（以及触发懒加载），返回实际滚动到的位置。
export async function scrollToPosition(top) {
  window.scrollTo({ top, left: 0, behavior: "instant" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return window.scrollY;
}

// 隐藏固定/吸顶元素，避免它们在每一屏里重复出现。
export function hideFixedElements() {
  const hidden = [];
  for (const element of document.querySelectorAll("*")) {
    const position = getComputedStyle(element).position;
    if (position === "fixed" || position === "sticky") {
      hidden.push([
        element,
        element.style.getPropertyValue("visibility"),
        element.style.getPropertyPriority("visibility"),
      ]);
      element.style.setProperty("visibility", "hidden", "important");
    }
  }
  window.__obsidianHiddenElements = hidden;
}

export function restoreAfterCapture(scrollX, scrollY) {
  for (const [element, value, priority] of window.__obsidianHiddenElements ?? []) {
    if (value) {
      element.style.setProperty("visibility", value, priority);
    } else {
      element.style.removeProperty("visibility");
    }
  }
  window.__obsidianHiddenElements = [];
  window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
}
