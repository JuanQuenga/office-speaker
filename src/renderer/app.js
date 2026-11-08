const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  starting: "Starting…",
  ready: "Ready. Waiting for someone to pick it in Spotify",
  connecting: "Connecting to Spotify…",
  connected: "Playing from Spotify",
  offline: "Waiting for a network connection…",
  error: "Something went wrong",
};

let current = null;
let outputsLoaded = false;
let volumeDragging = false;

function formValues() {
  return {
    name: $("name").value.trim(),
    output: $("output").value,
    bitrate: $("bitrate").value,
    normalize: $("normalize").checked,
    openAtLogin: $("login").checked,
  };
}

function isDirty() {
  if (!current) return false;
  const s = current.settings;
  const f = formValues();
  return (
    f.name !== s.name ||
    f.output !== s.output ||
    f.bitrate !== s.bitrate ||
    f.normalize !== s.normalize ||
    f.openAtLogin !== s.openAtLogin
  );
}

function fillForm(settings) {
  $("name").value = settings.name;
  $("bitrate").value = settings.bitrate;
  $("normalize").checked = settings.normalize;
  $("login").checked = settings.openAtLogin;
  if ([...$("output").options].some((o) => o.value === settings.output)) {
    $("output").value = settings.output;
  }
  $("save").disabled = true;
}

function render(state) {
  const firstRender = !current;
  const settingsChanged =
    !firstRender && JSON.stringify(current.settings) !== JSON.stringify(state.settings);
  current = state;

  $("status").dataset.status = state.status;
  $("status-text").textContent =
    state.status === "connected" && !state.playing ? "Connected, paused" : STATUS_TEXT[state.status] ?? state.status;

  const connected = state.status === "connected" || (state.status === "connecting" && state.track);
  $("idle").hidden = connected;
  $("playing").hidden = !connected;
  $("idle-name").textContent = state.settings.name;
  $("idle-name-inline").textContent = state.settings.name;

  const track = state.track;
  $("title").textContent = track?.title || "Nothing playing yet";
  $("artist").textContent = track ? [track.artist, track.album].filter(Boolean).join(" · ") : "";
  $("client").textContent = state.client ? `From ${state.client}` : "";
  if (track?.cover) $("cover").src = track.cover;
  else $("cover").removeAttribute("src");
  // SVG elements have no .hidden property; toggle the attribute instead.
  $("icon-play").toggleAttribute("hidden", state.playing);
  $("icon-pause").toggleAttribute("hidden", !state.playing);
  if (!volumeDragging && typeof state.volume === "number") $("volume").value = state.volume;

  $("message").hidden = !state.message;
  $("message").textContent = state.message;

  $("version").textContent = `Version ${state.version}`;
  // Start-at-login only works in the installed app, not from a dev checkout.
  $("login").disabled = !state.packaged;

  if (firstRender || (settingsChanged && !isDirty())) fillForm(state.settings);
}

async function loadOutputs() {
  const { default: systemDefault, outputs } = await window.speaker.listOutputs();
  const select = $("output");
  select.replaceChildren();
  const label = systemDefault && systemDefault !== "default" ? `System default (${systemDefault})` : "System default";
  const def = new Option(label, "");
  select.add(def);
  for (const name of outputs) {
    if (name === systemDefault) continue;
    select.add(new Option(name, name));
  }
  // Keep a saved device visible even when it's currently disconnected (e.g. Bluetooth off).
  const saved = current?.settings.output;
  if (saved && !outputs.includes(saved)) select.add(new Option(`${saved} (not connected)`, saved));
  select.value = saved ?? "";
  outputsLoaded = true;
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-command]");
  if (button) window.speaker.command(button.dataset.command);
});

$("toggle").addEventListener("click", () => {
  window.speaker.command(current?.playing ? "pause" : "play");
});

$("rename").addEventListener("click", () => {
  $("settings-panel").open = true;
  $("name").focus();
  $("name").select();
  $("settings-panel").scrollIntoView({ behavior: "smooth", block: "end" });
});

$("disconnect").addEventListener("click", () => window.speaker.command("disconnect"));

$("volume").addEventListener("input", (event) => {
  volumeDragging = true;
  window.speaker.setVolume(Number(event.target.value));
});
$("volume").addEventListener("change", () => {
  volumeDragging = false;
});

$("settings").addEventListener("input", () => {
  $("save").disabled = !isDirty();
  $("save-note").textContent = "";
});

$("output").addEventListener("focus", () => {
  // Refresh the list so a speaker paired a moment ago shows up.
  if (outputsLoaded) loadOutputs();
});

$("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("save").disabled = true;
  const result = await window.speaker.saveSettings(formValues());
  $("save-note").textContent = result.ok ? "Saved" : result.error;
  if (!result.ok) $("save").disabled = false;
});

$("logs").addEventListener("click", async () => {
  await window.speaker.copyLogs();
  $("logs").textContent = "Copied";
  setTimeout(() => ($("logs").textContent = "Copy logs"), 1500);
});

window.speaker.onState(render);
window.speaker.getState().then(async (state) => {
  render(state);
  await loadOutputs();
  fillForm(current.settings);
});
