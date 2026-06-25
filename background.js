const PRIORITY_ALARM = "priority-live-check";
const WATCHLIST_ALARM = "watchlist-live-check";
const PRIORITY_INTERVAL_MINUTES = 5 / 60;
const WATCHLIST_INTERVAL_MINUTES = 0.5;
const NOTIFICATION_PREFIX = "youtube-live:";
const STATE_VERSION = 2;
const DASHBOARD_SOCKET_URL = "ws://127.0.0.1:38517";
const DASHBOARD_RECONNECT_DELAY_MS = 5_000;
const DASHBOARD_PING_INTERVAL_MS = 20_000;

let channelWriteQueue = Promise.resolve();
let dashboardSocket = null;
let dashboardToken = null;
let dashboardReconnectTimer = null;
let dashboardPingTimer = null;

chrome.runtime.onInstalled.addListener(async () => {
  await migrateState();
  await ensureAlarms();
  await checkChannels("priority");
  void refreshDashboardBridge();
});

chrome.runtime.onStartup.addListener(async () => {
  await migrateState();
  await ensureAlarms();
  await checkChannels("priority");
  void refreshDashboardBridge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) void refreshDashboardBridge();
  if (changes.channels) void sendDashboardSnapshot();
});

void refreshDashboardBridge();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRIORITY_ALARM) {
    void checkChannels("priority");
  }

  if (alarm.name === WATCHLIST_ALARM) {
    void checkChannels("watchlist");
  }
});

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  const target = parseNotificationTarget(notificationId);
  if (target) void openOrFocusStream(target.channelId, target.videoId);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const target = parseNotificationTarget(notificationId);
  if (target) void openOrFocusStream(target.channelId, target.videoId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "check-now") {
    void checkChannels(message.scope || "all")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "open-channel") {
    void openChannelOnDemand(message.channelId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function openChannelOnDemand(channelId) {
  await migrateState();
  const { channels = [] } = await chrome.storage.local.get({ channels: [] });
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) throw new Error("Channel no longer exists.");

  const checkedAt = Date.now();
  const live = await getCurrentLiveStream(channel.id);

  if (!live) {
    await updateChannelState(channel.id, {
      isLive: false,
      activeVideoId: null,
      lastCheckedAt: checkedAt,
      lastError: null,
      failureCount: 0,
      nextCheckAt: null
    });
    return { isLive: false };
  }

  await openOrFocusStream(channel.id, live.videoId);
  await chrome.notifications.clear(`${NOTIFICATION_PREFIX}${channel.id}:${live.videoId}`);
  await updateChannelState(channel.id, {
    isLive: true,
    activeVideoId: live.videoId,
    lastHandledVideoId: live.videoId,
    lastCheckedAt: checkedAt,
    lastError: null,
    failureCount: 0,
    nextCheckAt: null
  });

  return { isLive: true, videoId: live.videoId };
}

async function refreshDashboardBridge() {
  const { settings = {} } = await chrome.storage.local.get({ settings: {} });
  const nextToken = settings.dashboardToken?.trim() || null;

  if (nextToken === dashboardToken && dashboardSocket?.readyState === WebSocket.OPEN) {
    await sendDashboardSnapshot();
    return;
  }

  dashboardToken = nextToken;
  clearDashboardTimers();
  if (dashboardSocket) {
    dashboardSocket.close();
    dashboardSocket = null;
  }
  if (!dashboardToken) return;

  const socket = new WebSocket(`${DASHBOARD_SOCKET_URL}/?token=${encodeURIComponent(dashboardToken)}`);
  dashboardSocket = socket;

  socket.addEventListener("open", () => {
    if (socket !== dashboardSocket) return;
    sendDashboardMessage({ type: "extension:hello", version: chrome.runtime.getManifest().version });
    void sendDashboardSnapshot();
    dashboardPingTimer = setInterval(() => sendDashboardMessage({ type: "extension:ping" }), DASHBOARD_PING_INTERVAL_MS);
  });

  socket.addEventListener("message", (event) => {
    void handleDashboardMessage(event.data);
  });

  socket.addEventListener("close", () => {
    if (socket !== dashboardSocket) return;
    clearDashboardTimers();
    dashboardSocket = null;
    scheduleDashboardReconnect();
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

function clearDashboardTimers() {
  if (dashboardReconnectTimer) clearTimeout(dashboardReconnectTimer);
  if (dashboardPingTimer) clearInterval(dashboardPingTimer);
  dashboardReconnectTimer = null;
  dashboardPingTimer = null;
}

function scheduleDashboardReconnect() {
  if (!dashboardToken || dashboardReconnectTimer) return;
  dashboardReconnectTimer = setTimeout(() => {
    dashboardReconnectTimer = null;
    void refreshDashboardBridge();
  }, DASHBOARD_RECONNECT_DELAY_MS);
}

function sendDashboardMessage(message) {
  if (dashboardSocket?.readyState !== WebSocket.OPEN) return false;
  dashboardSocket.send(JSON.stringify(message));
  return true;
}

async function sendDashboardSnapshot() {
  const { channels = [] } = await chrome.storage.local.get({ channels: [] });
  sendDashboardMessage({
    type: "extension:snapshot",
    sentAt: Date.now(),
    channels: channels.map((channel, index) => ({
      id: channel.id,
      title: channel.title,
      avatarUrl: channel.avatarUrl,
      rank: index + 1,
      isLive: Boolean(channel.isLive),
      activeVideoId: channel.activeVideoId || null,
      lastCheckedAt: channel.lastCheckedAt || null,
      lastError: channel.lastError || null
    }))
  });
}

async function handleDashboardMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }

  if (message.type === "dashboard:ping") {
    sendDashboardMessage({ type: "extension:pong" });
    return;
  }

  if (message.type === "dashboard:open-channel" && typeof message.channelId === "string") {
    try {
      const result = await openChannelOnDemand(message.channelId);
      sendDashboardMessage({ type: "extension:command-result", command: "open-channel", channelId: message.channelId, result });
    } catch (error) {
      sendDashboardMessage({ type: "extension:command-error", command: "open-channel", channelId: message.channelId, error: error.message });
    }
  }

  if (message.type === "dashboard:check-all") {
    const result = await checkChannels("all");
    sendDashboardMessage({ type: "extension:command-result", command: "check-all", result });
  }

  if (message.type === "dashboard:sync-channel-ids" && Array.isArray(message.channelIds)) {
    try {
      const result = await syncDashboardChannelIds(message.channelIds);
      sendDashboardMessage({ type: "extension:command-result", command: "sync-channel-ids", result });
    } catch (error) {
      sendDashboardMessage({ type: "extension:command-error", command: "sync-channel-ids", error: error.message });
    }
  }

  if (message.type === "dashboard:configure-holodex" && typeof message.apiKey === "string") {
    const { settings = {} } = await chrome.storage.local.get({ settings: {} });
    await chrome.storage.local.set({ settings: { ...settings, holodexApiKey: message.apiKey.trim() } });
    sendDashboardMessage({ type: "extension:command-result", command: "configure-holodex", enabled: Boolean(message.apiKey.trim()) });
  }
}

async function syncDashboardChannelIds(channelIds) {
  const wantedIds = [...new Set(channelIds.filter((id) => /^UC[A-Za-z0-9_-]{20,}$/.test(id)))];
  const { settings = {} } = await chrome.storage.local.get({ settings: {} });

  return queueChannelMutation(async (channels) => {
    const wanted = new Set(wantedIds);
    const existingIds = new Set(channels.map((channel) => channel.id));
    const removed = channels.filter((channel) => channel.dashboardManaged && !wanted.has(channel.id)).map((channel) => channel.id);
    const nextChannels = channels.filter((channel) => !channel.dashboardManaged || wanted.has(channel.id));
    const added = [];

    for (const channelId of wantedIds) {
      if (existingIds.has(channelId)) {
        const existingIndex = nextChannels.findIndex((channel) => channel.id === channelId);
        const existing = nextChannels[existingIndex];
        if (existing?.dashboardManaged && (existing.title === channelId || !existing.avatarUrl)) {
          const metadata = await getDashboardChannelMetadata(channelId, settings.apiKey);
          nextChannels[existingIndex] = { ...existing, title: metadata.title, avatarUrl: metadata.avatarUrl };
        }
        continue;
      }
      const metadata = await getDashboardChannelMetadata(channelId, settings.apiKey);
      nextChannels.push({
        id: channelId,
        title: metadata.title,
        avatarUrl: metadata.avatarUrl,
        isLive: false,
        activeVideoId: null,
        lastHandledVideoId: null,
        lastCheckedAt: null,
        lastError: null,
        failureCount: 0,
        nextCheckAt: null,
        dashboardManaged: true
      });
      added.push(channelId);
    }

    return { nextChannels, value: { added, removed } };
  });
}

async function getDashboardChannelMetadata(channelId, apiKey) {
  let title = channelId;
  let avatarUrl = "";

  try {
    const response = await fetch(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}`, {
      cache: "no-store",
      credentials: "omit"
    });
    if (response.ok) {
      const html = await response.text();
      title = getOpenGraphContent(html, "og:title") || title;
      avatarUrl = getOpenGraphContent(html, "og:image") || avatarUrl;
    }
  } catch {
    // Fallback to channel ID. Live checks can still work.
  }

  if (apiKey) {
    try {
      const endpoint = new URL("https://www.googleapis.com/youtube/v3/channels");
      endpoint.search = new URLSearchParams({ part: "snippet", id: channelId, key: apiKey });
      const response = await fetch(endpoint);
      if (response.ok) {
        const snippet = (await response.json()).items?.[0]?.snippet;
        title = snippet?.title || title;
        avatarUrl = snippet?.thumbnails?.medium?.url || snippet?.thumbnails?.default?.url || avatarUrl;
      }
    } catch {
      // Public page metadata remains usable.
    }
  }

  return { title, avatarUrl };
}

function getOpenGraphContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property="${escaped}"[^>]+content="([^"]*)"`, "i"),
    new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${escaped}"`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1].replace(/&amp;/g, "&").replace(/&#039;/g, "'");
  }
  return "";
}

async function ensureAlarms() {
  await chrome.alarms.create(PRIORITY_ALARM, {
    periodInMinutes: PRIORITY_INTERVAL_MINUTES
  });

  await chrome.alarms.create(WATCHLIST_ALARM, {
    periodInMinutes: WATCHLIST_INTERVAL_MINUTES
  });
}

async function migrateState() {
  const { stateVersion = 0, channels = [] } = await chrome.storage.local.get({
    stateVersion: 0,
    channels: []
  });
  if (stateVersion >= STATE_VERSION) return;

  await chrome.storage.local.set({
    stateVersion: STATE_VERSION,
    channels: channels.map((channel) => ({
      ...channel,
      // Version 1 marked a stream handled before its notification completed.
      // Reset once so failed old notifications can be delivered.
      lastHandledVideoId: null
    }))
  });
}

async function checkChannels(scope) {
  await migrateState();
  const { channels = [] } = await chrome.storage.local.get({ channels: [] });
  if (!channels.length) return [];

  const targets =
    scope === "priority"
      ? channels.slice(0, 1).map((channel) => ({ channel, isPriority: true }))
      : scope === "watchlist"
        ? channels.slice(1).map((channel) => ({ channel, isPriority: false }))
        : channels.map((channel, index) => ({ channel, isPriority: index === 0 }));

  const results = [];
  for (const target of targets) {
    results.push(await checkChannel(target.channel, target.isPriority));
  }
  return results;
}

async function checkChannel(channel, isPriority) {
  const checkedAt = Date.now();

  if (channel.nextCheckAt && channel.nextCheckAt > checkedAt) {
    return { channelId: channel.id, skipped: true };
  }

  try {
    const live = await getCurrentLiveStream(channel.id);

    if (!live) {
      await updateChannelState(channel.id, {
        isLive: false,
        activeVideoId: null,
        lastCheckedAt: checkedAt,
        lastError: null,
        failureCount: 0,
        nextCheckAt: null
      });
      return { channelId: channel.id, isLive: false };
    }

    const firstDetection = channel.lastHandledVideoId !== live.videoId;
    await updateChannelState(channel.id, {
      isLive: true,
      activeVideoId: live.videoId,
      lastCheckedAt: checkedAt,
      lastError: null,
      failureCount: 0,
      nextCheckAt: null
    });

    if (isPriority) {
      if (firstDetection) {
        await openOrFocusStream(channel.id, live.videoId);
      } else {
        await ensureStreamOpen(channel.id, live.videoId);
      }
    } else if (firstDetection) {
        await showLiveNotification(channel, live.videoId);
    }

    if (firstDetection) {
      await updateChannelState(channel.id, { lastHandledVideoId: live.videoId });
    }

    return { channelId: channel.id, isLive: true, videoId: live.videoId };
  } catch (error) {
    const failureCount = (channel.failureCount || 0) + 1;
    const retryDelay = Math.min(5 * 60_000, 30_000 * 2 ** (failureCount - 1));
    await updateChannelState(channel.id, {
      lastCheckedAt: checkedAt,
      lastError: error.message,
      failureCount,
      nextCheckAt: checkedAt + retryDelay
    });
    return { channelId: channel.id, isLive: false, error: error.message };
  }
}

async function getCurrentLiveStream(channelId) {
  try {
    return await getYouTubeCurrentLiveStream(channelId);
  } catch (youtubeError) {
    const { settings = {} } = await chrome.storage.local.get({ settings: {} });
    if (!settings.holodexApiKey) throw youtubeError;

    const fallback = await getHolodexCurrentLiveStream(channelId, settings.holodexApiKey).catch(() => null);
    if (fallback) return fallback;
    throw youtubeError;
  }
}

async function getYouTubeCurrentLiveStream(channelId) {
  const response = await fetch(
    `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`,
    {
      cache: "no-store",
      credentials: "omit"
    }
  );

  if (!response.ok) {
    throw new Error(`YouTube returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const isLive = /"isLiveContent"\s*:\s*true/.test(html);
  const isPlaybackReady = /"playabilityStatus"\s*:\s*\{\s*"status"\s*:\s*"OK"/.test(html);
  const hasStreamingData = /"streamingData"\s*:/.test(html);
  const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/i);

  // Upcoming broadcasts can have isLiveContent=true. They are not playable yet.
  if (!isLive || !isPlaybackReady || !hasStreamingData || !canonicalMatch) return null;

  const canonicalUrl = canonicalMatch[1].replace(/&amp;/g, "&");
  const url = new URL(canonicalUrl);
  const videoId = url.pathname === "/watch" ? url.searchParams.get("v") : null;

  return videoId ? { videoId } : null;
}

async function getHolodexCurrentLiveStream(channelId, apiKey) {
  const endpoint = new URL("https://holodex.net/api/v2/live");
  endpoint.search = new URLSearchParams({ channel_id: channelId, status: "live", limit: "1" });
  const response = await fetch(endpoint, { headers: { "X-APIKEY": apiKey } });
  if (!response.ok) throw new Error(`Holodex returned HTTP ${response.status}`);

  const videos = await response.json();
  const video = Array.isArray(videos) ? videos.find((item) => item?.id) : null;
  return video ? { videoId: video.id } : null;
}

async function openOrFocusStream(channelId, videoId) {
  const streamUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const existing = await findStreamTab(channelId, videoId);

  if (existing?.id !== undefined) {
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    await chrome.tabs.update(existing.id, { active: true });
    return;
  }

  await chrome.tabs.create({ url: streamUrl, active: true });
}

async function ensureStreamOpen(channelId, videoId) {
  const existing = await findStreamTab(channelId, videoId);
  if (existing) return;

  const streamUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  await chrome.tabs.create({ url: streamUrl, active: true });
}

async function findStreamTab(channelId, videoId) {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => isStreamTab(tab.url, channelId, videoId));
}

function isStreamTab(tabUrl, channelId, videoId) {
  if (!tabUrl) return false;

  try {
    const url = new URL(tabUrl);
    if (url.hostname !== "www.youtube.com") return false;
    if (url.pathname === "/watch" && url.searchParams.get("v") === videoId) return true;
    return url.pathname === `/channel/${channelId}/live`;
  } catch {
    return false;
  }
}

async function showLiveNotification(channel, videoId) {
  const notificationId = `${NOTIFICATION_PREFIX}${channel.id}:${videoId}`;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: channel.avatarUrl || chrome.runtime.getURL("icons/icon-128.png"),
    title: `${channel.title} is live`,
    message: "Open stream?",
    priority: 2,
    buttons: [{ title: "Open stream" }]
  });
}

function parseNotificationTarget(notificationId) {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return null;
  const target = notificationId.slice(NOTIFICATION_PREFIX.length);
  const separator = target.indexOf(":");
  if (separator === -1) return null;

  return {
    channelId: target.slice(0, separator),
    videoId: target.slice(separator + 1)
  };
}

function updateChannelState(channelId, patch) {
  return queueChannelMutation((channels) => {
    const nextChannels = channels.map((channel) => (channel.id === channelId ? { ...channel, ...patch } : channel));
    return { nextChannels };
  });
}

function queueChannelMutation(mutator) {
  const task = channelWriteQueue.then(async () => {
    const { channels = [] } = await chrome.storage.local.get({ channels: [] });
    const { nextChannels, value } = await mutator(channels);
    await chrome.storage.local.set({ channels: nextChannels });
    return value;
  });
  channelWriteQueue = task.catch(() => undefined);
  return task;
}
