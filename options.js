import { DEFAULT_SETTINGS, getCaptureSettings, getSetting, setSetting } from "./storage.js";

const fields = Object.keys(DEFAULT_SETTINGS);
const folderStatus = document.querySelector("#folder-status");
const saveStatus = document.querySelector("#save-status");

document.querySelector("#choose-folder").addEventListener("click", () => {
  void chooseFolder();
});
document.querySelector("#save-settings").addEventListener("click", () => {
  void saveSettings();
});

await loadSettings();

function fieldElement(field) {
  return document.querySelector(
    `#${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
  );
}

async function loadSettings() {
  const settings = await getCaptureSettings();
  for (const field of fields) {
    const input = fieldElement(field);
    if (input.type === "checkbox") {
      input.checked = settings[field];
    } else {
      input.value = settings[field];
    }
  }

  const directory = await getSetting("vaultDirectory");
  folderStatus.textContent = directory ? await describeFolder(directory) : "尚未选择文件夹。";
}

async function describeFolder(directory) {
  let status = `已选择文件夹：${directory.name}`;
  try {
    if (await directory.queryPermission({ mode: "readwrite" }) !== "granted") {
      return `${status}（授权已失效，请重新选择文件夹）`;
    }
    await directory.getDirectoryHandle(".obsidian");
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      status += "（没有找到 .obsidian 文件夹，请确认选择的是 Vault 根目录）";
    }
  }
  return status;
}

async function chooseFolder() {
  try {
    const directory = await window.showDirectoryPicker({ mode: "readwrite" });
    await setSetting("vaultDirectory", directory);
    folderStatus.textContent = await describeFolder(directory);
    saveStatus.textContent = "文件夹授权已保存。";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }
    saveStatus.textContent = errorMessage(error);
  }
}

async function saveSettings() {
  const settings = {};
  for (const field of fields) {
    const input = fieldElement(field);
    settings[field] = input.type === "checkbox" ? input.checked : input.value;
  }

  const filePaths = [
    settings.pagePath,
    settings.selectionPath,
    settings.screenshotPath,
  ];
  if (
    !filePaths.every((path) => isVaultRelativePath(path)) ||
    !isVaultRelativePath(settings.attachmentFolder, { allowEmpty: true })
  ) {
    saveStatus.textContent = "请输入 Vault 文件夹内的相对路径，不能包含 . 或 .. 路径段。";
    return;
  }

  try {
    await setSetting("captureSettings", settings);
    saveStatus.textContent = "设置已保存。";
  } catch (error) {
    saveStatus.textContent = errorMessage(error);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isVaultRelativePath(path, { allowEmpty = false } = {}) {
  const normalizedPath = path.trim().replaceAll("\\", "/");
  if (!normalizedPath) {
    return allowEmpty;
  }
  return !normalizedPath.startsWith("/") &&
    !/^[a-z]:/i.test(normalizedPath) &&
    !normalizedPath.split("/").some((segment) => segment === "." || segment === "..");
}
