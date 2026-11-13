const DATABASE_NAME = "obsidian-web-capture";
const DATABASE_VERSION = 2;
const SETTINGS_STORE = "settings";

const SCREENSHOT_TEMPLATE = "![[{{filepath}}]]\n\n— [{{title}}]({{url}}) · {{date}}";
const SELECTION_TEMPLATE = "{{content}}\n\n— [{{title}}]({{url}}) · {{date}}";
const LEGACY_SELECTION_TEMPLATE = "> {{content}}\n\n— [{{title}}]({{url}}) · {{date}}";

// 所有默认设置集中放在这里，设置页和写入逻辑共用，避免两处各写一份而不一致。
export const DEFAULT_SETTINGS = {
  pagePath: "00-inbox/Web Clips.md",
  pageCreateNewNote: false,
  pageUseReaderMode: false,
  selectionPath: "00-inbox/Quotes.md",
  screenshotPath: "00-inbox/Screenshots.md",
  attachmentFolder: "00-inbox/attachments",
  screenshotFormat: "png",
  pageHeader: "---\ntype: web-clip\n---",
  selectionHeader: "---\ntype: quote\n---",
  screenshotHeader: "---\ntype: screenshot\n---",
  pageTemplate: "## {{title}}\n\nSource: {{url}}\nCaptured: {{date}}\n\n{{content}}",
  selectionTemplate: SELECTION_TEMPLATE,
  screenshotTemplate: SCREENSHOT_TEMPLATE,
  appendSeparator: "\n\n---\n\n",
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
      if (database.objectStoreNames.contains("pending")) {
        database.deleteObjectStore("pending");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, action) {
  const database = await openDatabase();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      let result;

      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export function getSetting(key) {
  return withStore(SETTINGS_STORE, "readonly", (store) => store.get(key))
    .then((record) => record?.value);
}

export function setSetting(key, value) {
  return withStore(SETTINGS_STORE, "readwrite", (store) =>
    store.put({ key, value }),
  );
}

export async function getCaptureSettings() {
  const saved = await getSetting("captureSettings") ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    selectionTemplate: saved.selectionTemplate === LEGACY_SELECTION_TEMPLATE
      ? SELECTION_TEMPLATE
      : saved.selectionTemplate ?? SELECTION_TEMPLATE,
  };
}
