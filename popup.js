import { getSetting } from "./storage.js";

document.querySelector("#open-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

const directory = await getSetting("vaultDirectory");
document.querySelector("#folder-status").textContent = directory
  ? `Vault 文件夹：${directory.name}`
  : "请先选择 Vault 文件夹。";
