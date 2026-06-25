const bridgeStatus = document.querySelector("#bridge-status");
const liveStreams = document.querySelector("#live-streams");
const liveCount = document.querySelector("#live-count");
const upcomingStreams = document.querySelector("#upcoming-streams");
const upcomingCount = document.querySelector("#upcoming-count");
const noScheduleStreams = document.querySelector("#no-schedule-streams");
const noScheduleCount = document.querySelector("#no-schedule-count");
const noScheduleSection = document.querySelector("#no-schedule-section");
const errorBox = document.querySelector("#error");
const settingsForm = document.querySelector("#settings-form");
const holodexKey = document.querySelector("#holodex-key");
const channelIds = document.querySelector("#channel-ids");
const hideMemberStreams = document.querySelector("#hide-member-streams");
const bridgeToken = document.querySelector("#bridge-token");

let state = null;
let settingsDirty = false;

[holodexKey, channelIds].forEach((input) => input.addEventListener("input", () => {
  settingsDirty = true;
}));
hideMemberStreams.addEventListener("change", () => { settingsDirty = true; });

document.querySelector("#refresh-upcoming").addEventListener("click", async () => {
  try {
    await window.dashboard.refreshUpcoming();
  } catch (error) {
    showError(error.message);
  }
});
document.querySelector("#check-all").addEventListener("click", async () => {
  try {
    await window.dashboard.checkAll();
  } catch (error) {
    showError(error.message);
  }
});
document.querySelector("#copy-token").addEventListener("click", () => navigator.clipboard.writeText(bridgeToken.textContent));
document.querySelector("#holodex-link").addEventListener("click", (event) => {
  event.preventDefault();
  window.dashboard.openExternal("https://holodex.net/");
});
settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await window.dashboard.saveSettings({
      holodexApiKey: holodexKey.value,
      extraChannelIds: channelIds.value,
      hideMemberStreams: hideMemberStreams.checked
    });
    settingsDirty = false;
  } catch (error) {
    showError(error.message);
  }
});

window.dashboard.onState((nextState) => render(nextState));
window.dashboard.getState().then(render);
setInterval(() => state && render(state), 1_000);

function render(nextState) {
  state = nextState;
  bridgeStatus.textContent = state.extensionConnected ? "Extension connected" : "Extension offline";
  bridgeStatus.className = `status ${state.extensionConnected ? "online" : "offline"}`;
  bridgeToken.textContent = state.bridgeToken;
  if (!settingsDirty) {
    holodexKey.value = state.settings.holodexApiKey || "";
    channelIds.value = state.settings.extraChannelIds.join("\n");
    hideMemberStreams.checked = Boolean(state.settings.hideMemberStreams);
  }
  renderFeed();
  if (state.lastError) showError(state.lastError);
  else errorBox.hidden = true;
}

function renderFeed() {
  const channels = state.extensionChannels || [];
  const events = state.holodexEvents || [];
  const eventById = new Map(events.map((event) => [event.id, event]));
  const hideMembers = Boolean(state.settings.hideMemberStreams);
  const memberVideoIds = new Set(events.filter(isMemberStream).map((event) => event.id));
  const liveChannels = channels.filter((channel) => channel.isLive && channel.activeVideoId && (!hideMembers || !memberVideoIds.has(channel.activeVideoId)));
  const liveCards = liveChannels.map((channel) => makeLiveCard(channel, eventById.get(channel.activeVideoId)));

  const liveIds = new Set(liveChannels.map((channel) => channel.activeVideoId));
  const upcomingEvents = events.filter((event) => event.status === "upcoming" && !liveIds.has(event.id) && (!hideMembers || !isMemberStream(event)));
  const scheduledChannelIds = new Set(events.map((event) => event.channel_id));
  const noScheduleChannels = channels.filter((channel) => !channel.isLive && !scheduledChannelIds.has(channel.id));

  liveCount.textContent = liveCards.length;
  upcomingCount.textContent = upcomingEvents.length;
  noScheduleCount.textContent = noScheduleChannels.length;
  noScheduleSection.hidden = !channels.length || !noScheduleChannels.length;

  liveStreams.replaceChildren(...(liveCards.length ? liveCards : [empty("No watchlist streams live now.")]));
  if (!state.settings.holodexApiKey) {
    upcomingStreams.replaceChildren(empty("Add Holodex API key for upcoming watchlist streams."));
  } else {
    upcomingStreams.replaceChildren(...(upcomingEvents.length ? upcomingEvents.map(makeUpcomingCard) : [empty("No Holodex streams scheduled within next 30 days.")]));
  }
  noScheduleStreams.replaceChildren(...noScheduleChannels.map(makeNoScheduleRow));
}

function makeLiveCard(channel, event) {
  const videoId = channel.activeVideoId;
  return makeStreamCard({
    kind: "live",
    thumbnail: event?.thumbnail || youtubeThumbnail(videoId),
    avatar: event?.channel?.photo || channel.avatarUrl,
    title: event?.title || `${channel.title} is live`,
    channelName: event?.channel?.name || channel.title,
    label: "LIVE NOW",
    rank: channel.rank,
    onClick: () => openExtensionChannel(channel.id)
  });
}

function makeUpcomingCard(event) {
  const extensionChannel = state.extensionChannels.find((channel) => channel.id === event.channel_id);
  return makeStreamCard({
    kind: "upcoming",
    thumbnail: event.thumbnail || youtubeThumbnail(event.id),
    avatar: event.channel?.photo || extensionChannel?.avatarUrl,
    title: event.title || "Untitled stream",
    channelName: event.channel?.name || extensionChannel?.title || event.channel_id,
    label: formatCountdown(event.available_at),
    rank: extensionChannel?.rank,
    onClick: () => window.dashboard.openLink(event.id)
  });
}

function makeStreamCard({ kind, thumbnail, avatar, title, channelName, label, rank, onClick }) {
  const card = document.createElement("button");
  card.className = `stream-card ${kind}`;
  card.innerHTML = `
    <span class="thumbnail-wrap"><img class="thumbnail" src="${escapeHtml(thumbnail)}" alt="" /><span class="status-tag ${kind}">${escapeHtml(label)}</span></span>
    <span class="stream-copy">
      <img class="avatar" src="${escapeHtml(avatar || "")}" alt="" />
      <span class="stream-text"><h3>${escapeHtml(title)}</h3><span class="stream-meta"><span>${escapeHtml(channelName)}</span><strong>${kind === "live" ? "Open" : "Watch"}</strong></span></span>
      ${rank ? `<span class="rank">#${rank}</span>` : ""}
    </span>
  `;
  card.addEventListener("click", () => Promise.resolve(onClick()).catch((error) => showError(error.message)));
  return card;
}

function makeNoScheduleRow(channel) {
  const row = document.createElement("button");
  row.className = "no-schedule-row";
  row.innerHTML = `<img class="avatar" src="${escapeHtml(channel.avatarUrl || "")}" alt="" /><span>#${channel.rank} · ${escapeHtml(channel.title)}</span><small>No schedule</small>`;
  row.addEventListener("click", () => openExtensionChannel(channel.id));
  return row;
}

function isMemberStream(event) {
  const topicId = String(event?.topic_id || event?.topic || "").toLowerCase();
  return Boolean(
    topicId === "membersonly" ||
    event?.is_member ||
    event?.isMember ||
    event?.member_only ||
    event?.memberOnly ||
    event?.live_info?.is_member ||
    event?.live_info?.isMember ||
    event?.live_info?.member_only ||
    event?.live_info?.memberOnly
  );
}

async function openExtensionChannel(channelId) {
  await window.dashboard.openChannel(channelId);
}

function empty(message) {
  const element = document.createElement("p");
  element.className = "empty";
  element.textContent = message;
  return element;
}

function youtubeThumbnail(videoId) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

function formatCountdown(date) {
  const distance = Date.parse(date) - Date.now();
  if (distance <= 0) return "Starting now";
  const totalSeconds = Math.floor(distance / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return days ? `Starts in ${days}d ${hours}h` : hours ? `Starts in ${hours}h ${minutes}m` : `Starts in ${minutes}m`;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
