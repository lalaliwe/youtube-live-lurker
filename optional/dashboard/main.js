const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const { WebSocket, WebSocketServer } = require("ws");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 38517;
const HOLODEX_LIVE_URL = "https://holodex.net/api/v2/live";
const UPCOMING_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const APP_ICON_PATH = path.join(__dirname, "..", "..", "icons", "icon-128.png");

let windowRef = null;
let bridgeServer = null;
let bridgePingTimer = null;
let settingsPath = "";
let refreshTimer = null;

Menu.setApplicationMenu(null);

const state = {
  settings: {
    holodexApiKey: "",
    extraChannelIds: [],
    hideMemberStreams: false
  },
  bridgeToken: "",
  extensionConnected: false,
  extensionChannels: [],
  extensionWatchlistSignature: "",
  holodexEvents: [],
  lastUpcomingRefreshAt: null,
  lastError: null
};

app.whenReady().then(async () => {
  settingsPath = path.join(app.getPath("userData"), "dashboard-settings.json");
  loadSettings();
  startBridge();
  createWindow();

  refreshTimer = setInterval(() => void refreshUpcoming(), 60_000);
  if (state.settings.holodexApiKey) void refreshUpcoming();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (bridgePingTimer) clearInterval(bridgePingTimer);
  bridgeServer?.close();
});

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#111214",
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  windowRef.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function loadSettings() {
  try {
    const stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    state.settings.holodexApiKey = stored.holodexApiKey || "";
    state.settings.extraChannelIds = Array.isArray(stored.extraChannelIds) ? stored.extraChannelIds : [];
    state.settings.hideMemberStreams = Boolean(stored.hideMemberStreams);
    state.bridgeToken = stored.bridgeToken || "";
  } catch {
    // First launch has no settings file.
  }

  if (!state.bridgeToken) state.bridgeToken = crypto.randomBytes(24).toString("hex");
  persistSettings();
}

function persistSettings() {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        ...state.settings,
        bridgeToken: state.bridgeToken
      },
      null,
      2
    ),
    "utf8"
  );
}

function startBridge() {
  bridgeServer = new WebSocketServer({ host: BRIDGE_HOST, port: BRIDGE_PORT });
  bridgeServer.on("connection", (socket, request) => {
    const url = new URL(request.url, `http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
    if (url.searchParams.get("token") !== state.bridgeToken) {
      socket.close(1008, "Invalid bridge token");
      return;
    }

    socket.isExtension = false;
    socket.on("message", (raw) => handleBridgeMessage(socket, raw));
    socket.on("close", () => {
      if (socket.isExtension) {
        state.extensionConnected = false;
        emitState();
      }
    });
  });

  bridgeServer.on("error", (error) => {
    state.lastError = `Dashboard bridge failed: ${error.message}`;
    emitState();
  });

  bridgePingTimer = setInterval(() => {
    for (const socket of bridgeServer.clients) {
      if (socket.isExtension && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "dashboard:ping" }));
      }
    }
  }, 20_000);
}

function handleBridgeMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (message.type === "extension:hello") {
    socket.isExtension = true;
    state.extensionConnected = true;
    state.lastError = null;
    emitState();
    syncDashboardChannelsToExtension();
    return;
  }

  if (message.type === "extension:snapshot") {
    socket.isExtension = true;
    state.extensionConnected = true;
    const nextChannels = Array.isArray(message.channels) ? message.channels : [];
    const nextSignature = nextChannels.map((channel) => channel.id).sort().join(",");
    const watchlistChanged = nextSignature !== state.extensionWatchlistSignature;
    state.extensionChannels = nextChannels;
    state.extensionWatchlistSignature = nextSignature;
    state.lastError = null;
    emitState();
    if (watchlistChanged && state.settings.holodexApiKey) void refreshUpcoming();
  }
}

function sendExtensionCommand(command) {
  let sent = false;
  for (const socket of bridgeServer.clients) {
    if (socket.isExtension && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(command));
      sent = true;
    }
  }
  if (!sent) throw new Error("Extension is not connected. Paste this dashboard token into extension settings.");
}

function syncDashboardChannelsToExtension() {
  try {
    sendExtensionCommand({ type: "dashboard:configure-holodex", apiKey: state.settings.holodexApiKey });
    if (state.settings.extraChannelIds.length) {
      sendExtensionCommand({ type: "dashboard:sync-channel-ids", channelIds: state.settings.extraChannelIds });
    }
  } catch {
    // Extension will retry this after its next connection.
  }
}

async function refreshUpcoming() {
  if (!state.settings.holodexApiKey) {
    state.holodexEvents = [];
    state.lastUpcomingRefreshAt = null;
    emitState();
    return [];
  }

  const channelIds = [...new Set([...state.extensionChannels.map((channel) => channel.id), ...state.settings.extraChannelIds])];
  if (!channelIds.length) {
    state.holodexEvents = [];
    state.lastError = null;
    emitState();
    return [];
  }

  try {
    const responses = await Promise.all(channelIds.map(fetchChannelUpcoming));
    const records = responses.flat();
    const now = Date.now();
    const windowEnd = now + UPCOMING_WINDOW_MS;
    state.holodexEvents = [...new Map(records.map((video) => [video.id, video])).values()]
      .filter((video) => {
        if (video.status === "live") return true;
        const availableAt = Date.parse(video.available_at);
        return video.status === "upcoming" && Number.isFinite(availableAt) && availableAt >= now && availableAt <= windowEnd;
      })
      .sort((a, b) => {
        if (a.status === "live" && b.status !== "live") return -1;
        if (a.status !== "live" && b.status === "live") return 1;
        return Date.parse(a.available_at || 0) - Date.parse(b.available_at || 0);
      });
    state.lastUpcomingRefreshAt = Date.now();
    state.lastError = null;
  } catch (error) {
    state.lastError = error.message;
  }

  emitState();
  return state.holodexEvents;
}

async function fetchChannelUpcoming(channelId) {
  const url = new URL(HOLODEX_LIVE_URL);
  url.search = new URLSearchParams({
    channel_id: channelId,
    status: "live,upcoming",
    max_upcoming_hours: "720",
    include: "live_info",
    limit: "50",
    order: "asc"
  });
  const response = await fetch(url, {
    headers: { "X-APIKEY": state.settings.holodexApiKey }
  });
  if (!response.ok) throw new Error(`Holodex returned HTTP ${response.status}. Check API key and channel coverage.`);
  return response.json();
}

function rendererState() {
  return {
    settings: state.settings,
    bridgeToken: state.bridgeToken,
    extensionConnected: state.extensionConnected,
    extensionChannels: state.extensionChannels,
    holodexEvents: state.holodexEvents,
    lastUpcomingRefreshAt: state.lastUpcomingRefreshAt,
    lastError: state.lastError
  };
}

function emitState() {
  if (!windowRef || windowRef.isDestroyed()) return;
  windowRef.webContents.send("dashboard:state", rendererState());
}

ipcMain.handle("dashboard:get-state", () => rendererState());
ipcMain.handle("dashboard:save-settings", async (_event, settings) => {
  state.settings.holodexApiKey = settings.holodexApiKey?.trim() || "";
  state.settings.extraChannelIds = String(settings.extraChannelIds || "")
    .split(/[\n,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  state.settings.hideMemberStreams = Boolean(settings.hideMemberStreams);
  persistSettings();
  syncDashboardChannelsToExtension();
  return refreshUpcoming();
});
ipcMain.handle("dashboard:refresh-upcoming", () => refreshUpcoming());
ipcMain.handle("dashboard:open-link", async (_event, videoId) => {
  if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) throw new Error("Invalid YouTube video ID.");
  await shell.openExternal(`https://www.youtube.com/watch?v=${videoId}`);
});
ipcMain.handle("dashboard:open-external", async (_event, url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS links allowed.");
  await shell.openExternal(parsed.href);
});
ipcMain.handle("dashboard:open-channel", (_event, channelId) => sendExtensionCommand({ type: "dashboard:open-channel", channelId }));
ipcMain.handle("dashboard:check-all", () => sendExtensionCommand({ type: "dashboard:check-all" }));
