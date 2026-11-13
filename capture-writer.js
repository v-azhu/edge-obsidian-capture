import { getCaptureSettings, getSetting } from "./storage.js";

// 每种保存方式对应的设置项名称。
const MODE_SETTINGS = {
  page: { path: "pagePath", header: "pageHeader", template: "pageTemplate" },
  selection: { path: "selectionPath", header: "selectionHeader", template: "selectionTemplate" },
  screenshot: { path: "screenshotPath", header: "screenshotHeader", template: "screenshotTemplate" },
  region: { path: "screenshotPath", header: "screenshotHeader", template: "screenshotTemplate" },
};

// 截图文件名前缀。
const SCREENSHOT_NAME_PREFIXES = {
  screenshot: "screenshot",
  region: "screenshot-region",
};

const IMAGE_EXTENSIONS_BY_TYPE = {
  "image/png": "png",
  "image/apng": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

// 连续保存时按顺序写入，避免两次追加同时读取同一个文件大小而互相覆盖。
let writeQueue = Promise.resolve();

export function writeCapture(capture) {
  const run = writeQueue.then(() => performWrite(capture));
  writeQueue = run.catch(() => {});
  return run;
}

async function performWrite(capture) {
  const directory = await getSetting("vaultDirectory");
  if (!directory) {
    throw new Error("请先在扩展设置中选择 Obsidian Vault 文件夹。");
  }

  if (await directory.queryPermission({ mode: "readwrite" }) !== "granted") {
    throw new Error("Vault 文件夹授权已失效，请在扩展设置中重新选择文件夹。");
  }

  const settings = await getCaptureSettings();
  const mode = capture.mode;
  const names = MODE_SETTINGS[mode];
  if (!names) {
    throw new Error(`未知的保存方式：${mode}`);
  }

  const isAttachment = mode in SCREENSHOT_NAME_PREFIXES;
  const now = new Date();
  const values = {
    title: capture.title ?? "",
    url: capture.url ?? "",
    date: formatDate(now, "YYYY-MM-DD HH:mm"),
    content: "",
    filename: "",
    filepath: "",
  };

  const configuredPath = settings[names.path];
  splitVaultPath(configuredPath);

  let attachmentPath = "";
  const attachmentPaths = [];
  if (isAttachment) {
    if (!capture.blob?.size) {
      throw new Error("没有可保存的图片数据。");
    }
    const saved = await saveAttachment(
      directory,
      settings.attachmentFolder,
      capture.blob,
      `${SCREENSHOT_NAME_PREFIXES[mode]}-${formatDate(now, "YYYYMMDD-HHmmss")}`,
    );
    attachmentPath = saved.path;
    values.filename = saved.name;
    values.filepath = saved.path;
  } else {
    let content = mode === "selection" ? capture.selection : capture.pageText;
    if (!content?.trim()) {
      throw new Error("没有可保存的文字内容。");
    }
    if (mode === "selection") {
      for (const [index, attachment] of (capture.attachments ?? []).entries()) {
        if (!attachment.token || !content.includes(attachment.token)) {
          throw new Error("选区图片标记无效，未能保存选中内容。");
        }
        if (!attachment.blob?.size) {
          throw new Error(`选区中的第 ${index + 1} 张图片没有可保存的数据。`);
        }
        const saved = await saveAttachment(
          directory,
          settings.attachmentFolder,
          attachment.blob,
          `selection-image-${formatDate(now, "YYYYMMDD-HHmmss")}-${index + 1}`,
        );
        content = content.replace(attachment.token, `![[${saved.path}]]`);
        attachmentPaths.push(saved.path);
      }
    }
    values.content = content.trim();
  }

  const path = mode === "page" && settings.pageCreateNewNote
    ? await createUniquePagePath(directory, configuredPath, capture.title)
    : configuredPath;

  await appendEntry(directory, path, {
    header: settings[names.header],
    template: settings[names.template],
    separator: settings.appendSeparator,
    values,
  });

  return { path, attachmentPath, attachmentPaths, vaultName: directory.name };
}

async function appendEntry(directory, path, { header, template, separator, values }) {
  let file;
  let existing;
  try {
    file = await getFileAtPath(directory, path, false);
    existing = await file.getFile();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) {
      throw error;
    }
  }

  const isNewFile = !existing;
  const isEmptyFile = isNewFile || existing.size === 0;
  let legacyHeaderPrefix = "";
  if (!isEmptyFile && looksLikeTemplatePath(header.trim())) {
    const existingText = await existing.text();
    legacyHeaderPrefix = [`${header.trim()}\n\n`, `${header.trim()}\r\n\r\n`]
      .find((prefix) => existingText.startsWith(prefix)) ?? "";
  }
  const renderedHeader = isEmptyFile || legacyHeaderPrefix
    ? await renderHeader(directory, header, path, values)
    : "";
  const entry = renderTemplate(template, values);

  if (isNewFile) {
    file = await getFileAtPath(directory, path);
  }
  const writable = await file.createWritable({ keepExistingData: true });

  try {
    if (isEmptyFile) {
      await writable.write([renderedHeader, entry].filter(Boolean).join("\n\n"));
    } else if (legacyHeaderPrefix) {
      const existingText = await existing.text();
      const migratedText = [
        renderedHeader,
        existingText.slice(legacyHeaderPrefix.length),
      ].filter(Boolean).join("\n\n");
      await writable.seek(0);
      await writable.write(`${migratedText}${separator}${entry}`);
    } else {
      await writable.seek(existing.size);
      await writable.write(`${separator}${entry}`);
    }

    await writable.close();
  } catch (error) {
    await abortQuietly(writable);
    throw error;
  }
}

async function saveAttachment(directory, folder, blob, baseName) {
  const extension = await detectImageExtension(blob);
  if (!extension) {
    throw new Error("内容不是可识别的图片格式。");
  }

  const folderPath = (folder ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "");

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const name = `${baseName}${attempt === 0 ? "" : `-${attempt}`}.${extension}`;
    const path = folderPath ? `${folderPath}/${name}` : name;
    try {
      await getFileAtPath(directory, path, false);
      continue; // 已存在同名文件，换一个名字。
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) {
        throw error;
      }
    }

    const handle = await getFileAtPath(directory, path);
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await abortQuietly(writable);
      throw error;
    }
    return { name, path };
  }

  throw new Error("无法为图片生成不重复的文件名。");
}

async function abortQuietly(writable) {
  try {
    await writable.abort();
  } catch (abortError) {
    console.error("Could not abort the failed Obsidian write:", abortError);
  }
}

// 先按文件内容判断格式（有些网站返回错误的 Content-Type），再看响应类型，最后看网址后缀。
async function detectImageExtension(blob) {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const startsWith = (...bytes) => bytes.every((byte, index) => head[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (startsWith(0xff, 0xd8, 0xff)) return "jpg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    return "webp";
  }

  const fromType = IMAGE_EXTENSIONS_BY_TYPE[(blob.type ?? "").split(";")[0].trim().toLowerCase()];
  if (fromType) return fromType;

  return undefined;
}

function sanitizeFileName(value) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f[\]#^]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim()
    .slice(0, 120);
}

async function createUniquePagePath(directory, configuredPath, title) {
  const normalizedPath = configuredPath.trim().replaceAll("\\", "/");
  const separator = normalizedPath.lastIndexOf("/");
  const folder = separator < 0 ? "" : normalizedPath.slice(0, separator + 1);
  const baseName = sanitizeFileName(title || "Web clip") || "Web clip";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0
      ? ""
      : attempt === 1
        ? ` - ${timestamp}`
        : ` - ${timestamp} (${attempt})`;
    const candidate = `${folder}${baseName}${suffix}.md`;
    try {
      await getFileAtPath(directory, candidate, false);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return candidate;
      }
      throw error;
    }
  }

  throw new Error("无法为这篇网页生成不重复的文件名。");
}

async function renderHeader(directory, header, capturePath, values) {
  const reference = header.trim();
  if (!reference || reference.includes("\n") || !looksLikeTemplatePath(reference)) {
    return renderTemplater(header, values, capturePath).trim();
  }

  const templatePath = reference.endsWith(".md") ? reference : `${reference}.md`;
  let template;
  try {
    const file = await getFileAtPath(directory, templatePath, false);
    template = await file.getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      throw new Error(`找不到头部模板文件：${templatePath}`);
    }
    throw error;
  }
  return renderTemplater(await template.text(), values, capturePath).trim();
}

function looksLikeTemplatePath(value) {
  return value.includes("/") || value.includes("\\") || /\.md$/i.test(value);
}

function splitVaultPath(path) {
  const normalizedPath = (path ?? "").trim().replaceAll("\\", "/");
  const segments = normalizedPath.split("/").filter(Boolean);
  if (
    !segments.length ||
    normalizedPath.startsWith("/") ||
    /^[a-z]:/i.test(normalizedPath) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("目标路径必须是 Vault 文件夹内的相对路径。");
  }
  return segments;
}

async function getFileAtPath(directory, path, create = true) {
  const segments = splitVaultPath(path);
  let currentDirectory = directory;
  for (const segment of segments.slice(0, -1)) {
    currentDirectory = await currentDirectory.getDirectoryHandle(segment, { create });
  }
  return currentDirectory.getFileHandle(segments.at(-1), { create });
}

function renderTemplate(template, values) {
  return template.replace(
    /\{\{(title|url|date|content|filename|filepath)\}\}/g,
    (_, key, offset) => {
      const value = values[key] ?? "";
      if (key !== "content") {
        return value;
      }

      // 多行内容沿用占位符所在行的引用前缀（例如 "> "），让每一行都保持引用格式；
      // 模板没有引用前缀时原样插入，不再强行加 "> "。
      const lineStart = template.lastIndexOf("\n", offset - 1) + 1;
      const prefix = template.slice(lineStart, offset);
      return /^[ \t>]*$/.test(prefix) && prefix.includes(">")
        ? value.replace(/\r?\n/g, `\n${prefix}`)
        : value;
    },
  );
}

function renderTemplater(template, values, capturePath) {
  const title = capturePath.split(/[\\/]/).at(-1).replace(/\.md$/i, "");
  const renderDate = (format) => formatDate(new Date(), format);

  const rendered = template
    .replace(
      /<%\s*tp\.file\.creation_date\(\s*(?:(["'])(.*?)\1)?\s*\)\s*%>/g,
      (_, quote, format) => renderDate(format || "YYYY-MM-DD HH:mm"),
    )
    .replace(
      /<%\s*tp\.date\.now\(\s*(?:(["'])(.*?)\1)?\s*\)\s*%>/g,
      (_, quote, format) => renderDate(format || "YYYY-MM-DD"),
    )
    .replace(/<%\s*tp\.file\.title\s*%>/g, title);

  if (/<%[\s\S]*?%>/.test(rendered)) {
    throw new Error(
      "模板中有尚未支持的 Templater 语法。目前支持 tp.file.creation_date(...)、tp.date.now(...) 和 tp.file.title。",
    );
  }
  return rendered;
}

function formatDate(date, format) {
  const values = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MM: String(date.getMonth() + 1).padStart(2, "0"),
    DD: String(date.getDate()).padStart(2, "0"),
    HH: String(date.getHours()).padStart(2, "0"),
    mm: String(date.getMinutes()).padStart(2, "0"),
    ss: String(date.getSeconds()).padStart(2, "0"),
  };
  return format.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (token) => values[token]);
}
