const channelList = document.querySelector("#channel-list");
const emptyState = document.querySelector("#empty-state");
const channelCount = document.querySelector("#channel-count");
const addForm = document.querySelector("#add-form");
const addButton = document.querySelector("#add-button");
const channelUrlInput = document.querySelector("#channel-url");
const addMessage = document.querySelector("#add-message");
const settingsForm = document.querySelector("#settings-form");
const apiKeyInput = document.querySelector("#api-key");
const dashboardTokenInput = document.querySelector("#dashboard-token");
const settingsMessage = document.querySelector("#settings-message");
const checkAllButton = document.querySelector("#check-all");

addForm.addEventListener("submit", addChannel);
settingsForm.addEventListener("submit", saveSettings);
checkAllButton.addEventListener("click", checkAllChannels);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.channels || changes.settings)) void render();
});

void render();

async function render() {
  const { channels = [], settings = {} } = await chrome.storage.local.get({
    channels: [],
    settings: {}
  });

  apiKeyInput.value = settings.apiKey || "";
  dashboardTokenInput.value = settings.dashboardToken || "";
  channelCount.textContent = channels.length;
  emptyState.hidden = channels.length > 0;
  channelList.replaceChildren(...channels.map((channel, index) => renderChannel(channel, index, channels.length)));
}

function renderChannel(channel, index, total) {
  const item = document.createElement("li");
  item.className = `channel-row${index === 0 ? " priority" : ""}`;
  item.tabIndex = 0;
  item.setAttribute("role", "button");
  item.setAttribute("aria-label", `Open ${channel.title} if live`);

  const status = channel.lastError
    ? `Check failed: ${channel.lastError}`
    : channel.isLive
      ? `● Live${channel.activeVideoId ? " now" : ""}`
      : channel.lastCheckedAt
        ? `Offline · checked ${relativeTime(channel.lastCheckedAt)}`
        : "Waiting for first check";

  item.innerHTML = `
    <div class="rank ${index === 0 ? "top" : ""}">#${index + 1}</div>
    <img class="avatar" src="${escapeHtml(channel.avatarUrl || "icons/icon-48.png")}" alt="" />
    <div class="channel-main">
      <div class="channel-info">
        <div class="channel-name" title="${escapeHtml(channel.title)}">${escapeHtml(channel.title)}</div>
        <div class="channel-status ${channel.isLive ? "live" : ""}">${escapeHtml(status)}</div>
      </div>
    </div>
    <div class="channel-actions">
      <button class="small-button" data-action="up" data-id="${channel.id}" title="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
      <button class="small-button" data-action="down" data-id="${channel.id}" title="Move down" ${index === total - 1 ? "disabled" : ""}>↓</button>
      <button class="small-button remove" data-action="remove" data-id="${channel.id}" title="Remove">×</button>
    </div>
  `;

  item.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => handleChannelAction(button.dataset.action, button.dataset.id));
  });
  item.addEventListener("click", (event) => {
    if (!event.target.closest("button")) void openChannel(channel);
  });
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void openChannel(channel);
    }
  });
  return item;
}

async function openChannel(channel) {
  setMessage(addMessage, `Checking ${channel.title}…`);
  try {
    const response = await chrome.runtime.sendMessage({ type: "open-channel", channelId: channel.id });
    if (!response?.ok) throw new Error(response?.error || "Could not check channel.");
    setMessage(
      addMessage,
      response.result.isLive ? `Opened ${channel.title}.` : `${channel.title} is not live.`,
      response.result.isLive ? "success" : ""
    );
  } catch (error) {
    setMessage(addMessage, error.message, "error");
  }
}

async function addChannel(event) {
  event.preventDefault();
  setMessage(addMessage, "Resolving channel…");
  addButton.disabled = true;

  try {
    const { settings = {}, channels = [] } = await chrome.storage.local.get({ settings: {}, channels: [] });
    const channel = await resolveChannel(channelUrlInput.value, settings.apiKey);
    if (channels.some((existing) => existing.id === channel.id)) {
      throw new Error("Channel already in watchlist.");
    }

    await chrome.storage.local.set({ channels: [...channels, channel] });
    channelUrlInput.value = "";
    setMessage(addMessage, `${channel.title} added.`, "success");
    void chrome.runtime.sendMessage({ type: "check-now", scope: channels.length ? "watchlist" : "priority" });
  } catch (error) {
    setMessage(addMessage, error.message, "error");
  } finally {
    addButton.disabled = false;
  }
}

async function resolveChannel(rawUrl, apiKey) {
  const url = normalizeYouTubeUrl(rawUrl);
  const response = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error(`YouTube returned HTTP ${response.status}.`);

  const html = await response.text();
  const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/i);
  const canonical = canonicalMatch?.[1]?.replace(/&amp;/g, "&");
  const channelId = canonical?.match(/youtube\.com\/channel\/([^?&#"/]+)/i)?.[1];
  if (!channelId) throw new Error("Could not find a YouTube channel from that URL.");

  const fallbackTitle = getMetaContent(html, "og:title") || channelId;
  const fallbackAvatar = getMetaContent(html, "og:image") || "";
  const metadata = apiKey ? await getApiMetadata(channelId, apiKey).catch(() => null) : null;

  return {
    id: channelId,
    title: metadata?.title || fallbackTitle,
    avatarUrl: metadata?.avatarUrl || fallbackAvatar,
    isLive: false,
    activeVideoId: null,
    lastHandledVideoId: null,
    lastCheckedAt: null,
    lastError: null,
    failureCount: 0,
    nextCheckAt: null
  };
}

function normalizeYouTubeUrl(value) {
  let input = value.trim();
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;

  const url = new URL(input);
  const host = url.hostname.replace(/^www\./, "");
  if (!host.endsWith("youtube.com")) throw new Error("Paste a YouTube channel URL.");
  return url.href;
}

async function getApiMetadata(channelId, apiKey) {
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/channels");
  endpoint.search = new URLSearchParams({ part: "snippet", id: channelId, key: apiKey });
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error("Metadata API lookup failed.");

  const payload = await response.json();
  const snippet = payload.items?.[0]?.snippet;
  if (!snippet) return null;
  return {
    title: snippet.title,
    avatarUrl: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || ""
  };
}

function getMetaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property="${escaped}"[^>]+content="([^"]*)"`, "i"),
    new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${escaped}"`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function decodeHtml(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

async function handleChannelAction(action, channelId) {
  const { channels = [] } = await chrome.storage.local.get({ channels: [] });
  const index = channels.findIndex((channel) => channel.id === channelId);
  if (index === -1) return;

  if (action === "remove") {
    await chrome.storage.local.set({ channels: channels.filter((channel) => channel.id !== channelId) });
    return;
  }

  const newIndex = action === "up" ? index - 1 : index + 1;
  if (newIndex < 0 || newIndex >= channels.length) return;
  [channels[index], channels[newIndex]] = [channels[newIndex], channels[index]];
  await chrome.storage.local.set({ channels });
  void chrome.runtime.sendMessage({ type: "check-now", scope: "priority" });
}

async function saveSettings(event) {
  event.preventDefault();
  const { settings = {} } = await chrome.storage.local.get({ settings: {} });
  await chrome.storage.local.set({
    settings: {
      ...settings,
      apiKey: apiKeyInput.value.trim(),
      dashboardToken: dashboardTokenInput.value.trim()
    }
  });
  setMessage(settingsMessage, "Saved on this browser.", "success");
}

async function checkAllChannels() {
  checkAllButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "check-now", scope: "all" });
    if (!response?.ok) throw new Error(response?.error || "Check failed.");
  } catch (error) {
    setMessage(addMessage, error.message, "error");
  } finally {
    checkAllButton.disabled = false;
  }
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function setMessage(element, text, kind = "") {
  element.textContent = text;
  element.className = `message ${kind}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
