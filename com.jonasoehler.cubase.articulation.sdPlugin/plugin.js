/* eslint-disable no-console */
const WebSocket = require("ws");
const easymidi = require("easymidi");
const fs = require("fs");
const path = require("path");

// ---- Args von Stream Deck: -port -pluginUUID -registerEvent -info ----
// (siehe SDK: WebSocket Registrierung & Events)  // :contentReference[oaicite:2]{index=2}
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
};

const port = getArg("-port");
const pluginUUID = getArg("-pluginUUID");
const registerEvent = getArg("-registerEvent");
const info = JSON.parse(getArg("-info") || "{}");

if (!port || !pluginUUID || !registerEvent) {
  console.error(
    "Fehlende Startparameter von Stream Deck (-port/-pluginUUID/-registerEvent)."
  );
  process.exit(1);
}

// ---- MIDI Setup ---------------------------------------------------------
const TARGET_MIDI_OUT = "NodeToCubase";
const TARGET_MIDI_IN = "CubaseToNode";

let midiOut = null;
let midiIn = null;

function setupMidi() {
  try {
    const outs = easymidi.getOutputs();
    const ins = easymidi.getInputs();

    const outName = outs.find((n) => n.includes(TARGET_MIDI_OUT));
    const inName = ins.find((n) => n.includes(TARGET_MIDI_IN));

    if (!outName)
      console.warn(
        `Kein MIDI Out mit "${TARGET_MIDI_OUT}" gefunden. Verfügbar: ${outs.join(
          ", "
        )}`
      );
    if (!inName)
      console.warn(
        `Kein MIDI In mit "${TARGET_MIDI_IN}" gefunden. Verfügbar: ${ins.join(
          ", "
        )}`
      );

    if (outName) midiOut = new easymidi.Output(outName);
    if (inName) midiIn = new easymidi.Input(inName);

    if (midiIn) {
      midiIn.on("sysex", (msg) => onSysexFromCubase(msg.bytes));
    }
  } catch (e) {
    console.error("MIDI Setup Fehler:", e);
  }
}

function sendNote(noteNumber, channel = 0, velocity = 127, lengthMs = 100) {
  if (!midiOut) return console.error("Kein MIDI Out aktiv.");
  midiOut.send("noteon", { note: noteNumber, velocity, channel });
  setTimeout(
    () => midiOut.send("noteoff", { note: noteNumber, velocity: 0, channel }),
    lengthMs
  );
}

// ---- Profile / Articulations -------------------------------------------
const profilesPath = path.join(__dirname, "profiles.json");
let profiles = {};
try {
  profiles = JSON.parse(fs.readFileSync(profilesPath, "utf-8"));
} catch (e) {
  console.warn(
    "profiles.json konnte nicht gelesen werden, verwende leeres Mapping."
  );
  profiles = {};
}

// Gerätespezifischer Zustand
const deviceState = new Map(); // deviceId -> { contextsByCoord: Map("c,r"->context), currentProfileKey, articulations[] }

function ensureDeviceState(deviceId) {
  if (!deviceState.has(deviceId)) {
    deviceState.set(deviceId, {
      contextsByCoord: new Map(),
      currentProfileKey: null,
      articulations: [],
    });
  }
  return deviceState.get(deviceId);
}

// ---- Stream Deck WebSocket Verbindung ----------------------------------
const ws = new WebSocket(`ws://127.0.0.1:${port}`);

ws.on("open", () => {
  // Registrierung gemäß SDK („event“ und „uuid“)  // :contentReference[oaicite:3]{index=3}
  ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
  console.log("Stream Deck: verbunden & registriert.");
  setupMidi();
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data);
    handleMessage(msg);
  } catch (e) {
    console.error("Ungültige WS-Nachricht", e);
  }
});

function handleMessage(msg) {
  const { event } = msg;

  // Device-Verwaltung (deviceDidConnect/Disconnect)  // :contentReference[oaicite:4]{index=4}
  if (event === "deviceDidConnect") {
    ensureDeviceState(msg.device);
  } else if (event === "deviceDidDisconnect") {
    deviceState.delete(msg.device);
  }

  // Action erscheint: Kontext & Koordinate merken  // :contentReference[oaicite:5]{index=5}
  if (event === "willAppear") {
    const dev = ensureDeviceState(msg.device);
    const coord = coordKey(msg.payload.coordinates);
    dev.contextsByCoord.set(coord, msg.context);

    // ggf. initialen Titel aus Settings setzen
    const s = msg.payload.settings || {};
    if (s.title) setTitle(msg.context, s.title);
  }

  // Key gedrückt -> Note senden
  if (event === "keyDown") {
    const dev = ensureDeviceState(msg.device);
    const idx = indexFromCoordinates(
      msg.payload.coordinates,
      info?.devicePixelRatio,
      info
    ); // grid-basiert
    const art = dev.articulations[idx];
    if (art?.note != null) {
      sendNote(art.note);
      showOk(msg.context); // visuelles Feedback  // :contentReference[oaicite:6]{index=6}
    } else {
      showAlert(msg.context);
    }
  }

  // Optional: Titeländerungen vom UI/Inspector
  if (event === "didReceiveSettings") {
    const s = msg.payload.settings || {};
    if (s.title) setTitle(msg.context, s.title);
  }
}

// ---- Hilfen für Stream Deck Kommandos ----------------------------------
function setTitle(context, title) {
  ws.send(
    JSON.stringify({
      event: "setTitle", // Command laut SDK  // :contentReference[oaicite:7]{index=7}
      context,
      payload: { title, target: 0 },
    })
  );
}

function showOk(context) {
  ws.send(JSON.stringify({ event: "showOk", context })); // :contentReference[oaicite:8]{index=8}
}

function showAlert(context) {
  ws.send(JSON.stringify({ event: "showAlert", context })); // :contentReference[oaicite:9]{index=9}
}

function coordKey(c) {
  return `${c.column},${c.row}`;
}

// XL = 8x4 -> 32 Keys; Index flach aus Koordinaten ableiten
function indexFromCoordinates(c /*, dpr, info*/) {
  // columns/rows stehen auch in deviceInfo, hier reicht Standard (XL 8x4)
  return c.row * 8 + c.column;
}

// ---- Cubase Sysex -> Profilwechsel/Rendern ------------------------------
let lastTrackName = "";
let debounceTimer = null;

function onSysexFromCubase(bytes) {
  if (bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return;
  const trackName = String.fromCharCode(...bytes.slice(1, -1)).trim();
  if (!trackName || trackName.toLowerCase() === lastTrackName.toLowerCase())
    return;

  lastTrackName = trackName;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => applyProfileForTrack(trackName), 120);
}

function applyProfileForTrack(trackName) {
  if (!/ks/i.test(trackName)) {
    console.log(`Überspringe Spur ohne "KS": "${trackName}"`);
    return;
  }

  const key = Object.keys(profiles).find((k) =>
    new RegExp(k, "i").test(trackName)
  );
  if (!key) {
    console.log(`Kein Profil für "${trackName}" gefunden.`);
    return;
  }

  // Für ALLE Geräte das Mapping aktualisieren
  for (const [deviceId, state] of deviceState) {
    state.currentProfileKey = key;
    state.articulations = profiles[key]?.articulations || [];
    renderTitlesForDevice(deviceId);
  }
}

function renderTitlesForDevice(deviceId) {
  const state = deviceState.get(deviceId);
  if (!state) return;
  // Titel anhand der aktuellen Articulations setzen
  state.contextsByCoord.forEach((context, coordStr) => {
    const [c, r] = coordStr.split(",").map(Number);
    const idx = r * 8 + c;
    const art = state.articulations[idx];
    setTitle(context, art?.name || "");
  });
}

// Aufräumen bei Exit
process.on("exit", () => {
  try {
    midiOut && midiOut.close();
  } catch {}
  try {
    midiIn && midiIn.close();
  } catch {}
});
