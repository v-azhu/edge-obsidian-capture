import { setSetting } from "./storage.js";

const parameters = new URLSearchParams(location.search);
const succeeded = parameters.get("status") === "success";
// 保存成功 3 秒后自动关闭；失败时要留出时间读错误原因，所以是 10 秒。
const AUTO_CLOSE_MS = succeeded ? 3000 : 10000;
const TICK_MS = 200;
const POSITION_KEY = "resultWindowPosition";

const title = document.querySelector("#title");
const message = document.querySelector("#message");
const countdown = document.querySelector("#countdown");
const settingsButton = document.querySelector("#settings");

let deadline = 0;
let tickId;
let lastPosition;

title.textContent = succeeded ? "已保存到 Obsidian" : "保存失败";
message.textContent = parameters.get("message") || "没有收到保存结果。";
if (!succeeded) {
  message.classList.add("error");
}

startAutoClose();
const positionId = setInterval(() => {
  void watchPosition();
}, TICK_MS);

settingsButton.addEventListener("click", async () => {
  stopAutoClose();
  settingsButton.disabled = true;
  countdown.textContent = "正在打开设置…";
  if (!(await sendAction("open-settings"))) {
    settingsButton.disabled = false;
    countdown.textContent = "打开设置失败，请重试。";
    startAutoClose();
  }
});

// 每次（重新）开始都从完整的 3 秒算起。
function startAutoClose() {
  stopAutoClose();
  deadline = Date.now() + AUTO_CLOSE_MS;
  renderCountdown();
  tickId = setInterval(() => {
    if (Date.now() >= deadline) {
      stopAutoClose();
      clearInterval(positionId);
      void sendAction("close-result-window");
      return;
    }
    renderCountdown();
  }, TICK_MS);
}

function stopAutoClose() {
  clearInterval(tickId);
  tickId = undefined;
}

function renderCountdown() {
  const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  countdown.textContent = `${seconds} 秒后自动关闭`;
}

// 用户拖动窗口时：记住新位置（下次就出现在这里），并重新计时，
// 否则 3 秒的倒计时根本不够把窗口拖到想要的位置。
async function watchPosition() {
  try {
    const current = await chrome.windows.getCurrent();
    if (!Number.isFinite(current.left) || !Number.isFinite(current.top)) {
      return;
    }

    const position = { left: current.left, top: current.top };
    const moved = lastPosition !== undefined &&
      (position.left !== lastPosition.left || position.top !== lastPosition.top);
    lastPosition = position;

    if (moved) {
      if (tickId !== undefined) {
        startAutoClose();
      }
      await setSetting(POSITION_KEY, position);
    }
  } catch (error) {
    console.error("Could not track the capture result window position:", error);
  }
}

async function sendAction(type) {
  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) {
      throw new Error(response?.error ?? "操作失败。");
    }
    return true;
  } catch (error) {
    console.error("Could not complete the capture result action:", error);
    if (type !== "open-settings") {
      countdown.textContent = error instanceof Error ? error.message : String(error);
    }
    return false;
  }
}
