/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------
// Logging (Konsole + Datei)
// ---------------------------------------
const LOG_PATH = path.join(__dirname, "plugin.log");
function ts() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
    d.getSeconds()
  )}.${String(d.getMilliseconds()).padStart(3, "0")}]`;
}
function w(line) {
  const s = `${ts()} ${line}\n`;
  try {
    fs.appendFileSync(LOG_PATH, s);
  } catch (_) {}
  try {
    console.log(line);
  } catch (_) {}
}
w("==== Cubase Articulations Plugin START ====");

// ---------------------------------------
// Cubase Remote Script Auto-Install (once)
// ---------------------------------------
function getDocumentsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || null;
  // Windows: OneDrive "Documents" bevorzugen
  if (process.platform === "win32") {
    const od = process.env.OneDrive || process.env.ONEDRIVE;
    if (od) {
      const cand = path.join(od, "Documents");
      if (fs.existsSync(cand)) return cand;
    }
  }
  return home ? path.join(home, "Documents") : null;
}

function installCubaseRemoteScriptOnce() {
  try {
    const docs = getDocumentsDir();
    if (!docs) return;

    const src = path.join(__dirname, "remote", "Elgato_StreamDeckXL.js");
    if (!fs.existsSync(src)) {
      w("[INFO] Remote script source not found: " + src);
      return;
    }

    const APPS = ["Cubase"]; // bei Bedarf: "Nuendo" ergänzen
    for (const app of APPS) {
      const dstDir = path.join(
        docs,
        "Steinberg",
        app,
        "MIDI Remote",
        "Driver Scripts",
        "Local",
        "Elgato",
        "StreamDeckXL"
      );
      const dst = path.join(dstDir, "Elgato_StreamDeckXL.js");

      if (!fs.existsSync(dst)) {
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(src, dst);
        w(`[INFO] Installed Cubase Remote Script: ${dst}`);
      } else {
        w(`[INFO] Cubase Remote Script already present: ${dst}`);
      }
    }
  } catch (e) {
    w(`[WRN] Could not install Remote Script: ${e && e.message}`);
  }
}
installCubaseRemoteScriptOnce();

// ---------------------------------------
// Requires (WS, MIDI, Canvas)
// ---------------------------------------
const WebSocket = require("ws");
const easymidi = require("easymidi");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

// ---------------------------------------
// Fonts (optional)
// ---------------------------------------
try {
  const fontSemiBold = path.join(
    __dirname,
    "assets",
    "fonts",
    "Inter-SemiBold.ttf"
  );
  const fontMedium = path.join(
    __dirname,
    "assets",
    "fonts",
    "Inter-Medium.ttf"
  );
  if (fs.existsSync(fontSemiBold)) {
    GlobalFonts.registerFromPath(fontSemiBold, "Inter-SemiBold");
    w(`[DBG] Font registered: ${fontSemiBold}`);
  }
  if (fs.existsSync(fontMedium)) {
    GlobalFonts.registerFromPath(fontMedium, "Inter-Medium");
    w(`[DBG] Font registered: ${fontMedium}`);
  }
} catch (e) {
  w(`[WRN] Could not register fonts: ${e && e.message}`);
}

// ---------------------------------------
// SDK Start-Parameter
// ---------------------------------------
const args = process.argv.slice(2);
const getArg = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
const port = getArg("-port");
const pluginUUID = getArg("-pluginUUID");
const registerEvent = getArg("-registerEvent");
const info = safeJson(getArg("-info")) || {};
w(
  `[DBG] Start-Args: ${JSON.stringify({
    port,
    pluginUUID,
    registerEvent,
    infoVersion: info.application?.version || "",
  })}`
);

if (!port || !pluginUUID || !registerEvent) {
  w("[ERR] Missing start parameters (-port/-pluginUUID/-registerEvent).");
  process.exit(1);
}

// ---------------------------------------
// MIDI I/O
// ---------------------------------------
const TARGET_MIDI_OUT = "NodeToCubase";
const TARGET_MIDI_IN = "CubaseToNode";

// CC mapping & channel for color
const COLOR_CC = { R: 20, G: 21, B: 22 };
const COLOR_CH = 14; // 0..15 => channel 15

let midiOut = null,
  midiIn = null;

function setupMidi() {
  try {
    const outs = easymidi.getOutputs();
    const ins = easymidi.getInputs();
    w(`[DBG] [MIDI] Outputs: ${JSON.stringify(outs)}`);
    w(`[DBG] [MIDI] Inputs : ${JSON.stringify(ins)}`);

    const outName = outs.find((n) => n.includes(TARGET_MIDI_OUT));
    const inName = ins.find((n) => n.includes(TARGET_MIDI_IN));

    if (!outName)
      w(
        `[WRN] No MIDI Out "${TARGET_MIDI_OUT}". Available: ${outs.join(", ")}`
      );
    if (!inName)
      w(`[WRN] No MIDI In  "${TARGET_MIDI_IN}". Available: ${ins.join(", ")}`);

    if (outName) {
      midiOut = new easymidi.Output(outName);
      w(`MIDI Out connected: ${outName}`);
    }
    if (inName) {
      midiIn = new easymidi.Input(inName);
      w(`MIDI In  connected: ${inName}`);
    }

    if (midiIn) {
      midiIn.on("sysex", (msg) => {
        w(`[DBG] [MIDI<-Cubase] SysEx bytes: [${msg.bytes.join(",")}]`);
        onSysexFromCubase(msg.bytes);
      });
      midiIn.on("cc", (msg) => {
        w(
          `[DBG] [MIDI<-Cubase] CC ${msg.controller} = ${msg.value} ch ${msg.channel}`
        );
        const isColorCC =
          msg.controller === COLOR_CC.R ||
          msg.controller === COLOR_CC.G ||
          msg.controller === COLOR_CC.B;
        if (!isColorCC) return;
        if (msg.channel !== COLOR_CH) {
          w(`[DBG] [MIDI<-Cubase] Ignored (expected channel ${COLOR_CH + 1})`);
          return;
        }
        onCcFromCubase(msg);
      });
    }
  } catch (e) {
    w(`[ERR] MIDI setup error: ${e && e.message}`);
  }
}

function sendNote(noteNumber, channel = 0, velocity = 127, lengthMs = 110) {
  if (!midiOut) return w("[ERR] No MIDI Out active.");
  midiOut.send("noteon", { note: noteNumber, velocity, channel });
  setTimeout(
    () => midiOut.send("noteoff", { note: noteNumber, velocity: 0, channel }),
    lengthMs
  );
}

// ---------------------------------------
// Profiles laden + Live-Reload
// ---------------------------------------
const profilesPath = path.join(__dirname, "profiles.json");
let profiles = {};
try {
  profiles = JSON.parse(fs.readFileSync(profilesPath, "utf-8"));
  w(`Profiles loaded: ${profilesPath}`);
} catch {
  w("[WRN] profiles.json missing/unreadable – using empty mapping.");
  profiles = {};
}

// Live-Reload: Watcher mit Debounce
let profilesWatch = null;
let profilesReloadTimer = null;

function loadProfilesFromDisk() {
  try {
    const txt = fs.readFileSync(profilesPath, "utf-8");
    const next = JSON.parse(txt);
    profiles = next || {};
    w(
      `[INFO] profiles.json reloaded (${
        Object.keys(profiles).length
      } profiles).`
    );
    // Sofort anwenden: aktuellen Track re-berechnen oder alles rendern
    if (lastTrackName) {
      applyProfileForTrack(lastTrackName);
    } else {
      for (const [deviceId] of deviceState) renderProfileForDevice(deviceId);
    }
  } catch (e) {
    w(`[WRN] Could not reload profiles.json: ${e && e.message}`);
  }
}

function startProfilesWatcher() {
  const dir = path.dirname(profilesPath);
  try {
    profilesWatch && profilesWatch.close();
  } catch {}
  try {
    profilesWatch = fs.watch(dir, (eventType, filename) => {
      if (!filename) return;
      const isProfiles =
        filename.toString().toLowerCase() ===
        path.basename(profilesPath).toLowerCase();
      if (!isProfiles) return;
      if (profilesReloadTimer) clearTimeout(profilesReloadTimer);
      profilesReloadTimer = setTimeout(() => {
        w("[DBG] profiles.json change detected -> reloading …");
        loadProfilesFromDisk();
      }, 150);
    });
    w(`[INFO] Watching profiles.json for changes: ${profilesPath}`);
  } catch (e) {
    w(`[WRN] Could not watch profiles.json: ${e && e.message}`);
  }
}
startProfilesWatcher();

// ---------------------------------------
// State je Gerät
// ---------------------------------------
const deviceState = new Map();
/**
 * deviceState: Map<deviceId, {
 *   contextsByCoord: Map<'c,r', context>,
 *   articulations: Array<{ name, note }>,
 *   color: string,
 *   profileKey: string|null,
 *   selectedArtIdx: number|null,
 *   instrumentTitle: string
 * }>
 */
const COLS = 8; // Stream Deck XL
const TITLE_POS = { col: 1, row: 0 };
const START_ROW_FOR_ARTS = 1;

// ---------------------------------------
// WebSocket zur Stream Deck App
// ---------------------------------------
const ws = new WebSocket(`ws://127.0.0.1:${port}`);

ws.on("open", () => {
  ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
  w(
    `Stream Deck connected & registered. ${JSON.stringify({
      port,
      pluginUUID,
    })}`
  );
  setupMidi();
});

ws.on("message", (data) => {
  const msg = safeJson(data);
  if (msg) handleMessage(msg);
});

function handleMessage(msg) {
  const { event } = msg;
  w(`[DBG] [WS<-SD] event: ${event}`);

  if (event === "deviceDidConnect") {
    ensureDeviceState(msg.device);
    w(`Device connected: ${msg.device}`);
  }
  if (event === "deviceDidDisconnect") deviceState.delete(msg.device);

  if (event === "willAppear") {
    const st = ensureDeviceState(msg.device);
    const ck = coordKey(msg.payload.coordinates);
    st.contextsByCoord.set(ck, msg.context);
    w(`[DBG] willAppear @ ${ck} context: ${String(msg.context).slice(0, 8)}…`);
    initialRenderForKey(msg.device, msg.payload.coordinates, msg.context);
  }

  if (event === "willDisappear") {
    const st = ensureDeviceState(msg.device);
    const ck = coordKey(msg.payload.coordinates);
    st.contextsByCoord.delete(ck);
  }

  if (event === "keyDown") onKeyDown(msg);
  if (event === "keyUp") onKeyUp(msg);
}

// ---------------------------------------
// Mapping Helpers
// ---------------------------------------
function ensureDeviceState(deviceId) {
  if (!deviceState.has(deviceId)) {
    deviceState.set(deviceId, {
      contextsByCoord: new Map(),
      articulations: [],
      color: "#4B5563",
      profileKey: null,
      selectedArtIdx: null,
      instrumentTitle: "",
    });
    w(`[DBG] deviceState init: ${deviceId}`);
  }
  return deviceState.get(deviceId);
}
function coordKey(c) {
  return `${c.column},${c.row}`;
}
function articulationIndexForCoord(c) {
  if (c.row < START_ROW_FOR_ARTS) return null;
  return (c.row - START_ROW_FOR_ARTS) * COLS + c.column;
}
function hasArt(art) {
  return !!(
    art &&
    ((art.name && art.name.trim().length) || Number.isInteger(art.note))
  );
}

function initialRenderForKey(deviceId, coord, context) {
  const st = ensureDeviceState(deviceId);
  if (coord.row === TITLE_POS.row && coord.column === TITLE_POS.col) {
    renderTitleKey(context, st.instrumentTitle || "", st.color);
  } else if (coord.row >= START_ROW_FOR_ARTS) {
    const artIdx = articulationIndexForCoord(coord);
    const art = st.articulations[artIdx];
    if (hasArt(art)) {
      const isSel = st.selectedArtIdx === artIdx;
      renderArtKey(context, art, st.color, isSel);
    } else {
      renderEmptyKey(context);
    }
  } else {
    renderEmptyKey(context);
  }
}

function onKeyDown(msg) {
  const st = ensureDeviceState(msg.device);
  const c = msg.payload.coordinates;
  if (c.row === TITLE_POS.row && c.column === TITLE_POS.col) return;

  const artIdx = articulationIndexForCoord(c);
  if (artIdx == null) return;
  const art = st.articulations[artIdx];
  if (!hasArt(art)) return;

  if (Number.isInteger(art?.note)) {
    sendNote(art.note);

    const prevIdx = st.selectedArtIdx;
    st.selectedArtIdx = artIdx;

    const jobs = [];
    const currentCtx = st.contextsByCoord.get(coordKey(c));
    if (currentCtx) jobs.push(renderArtKey(currentCtx, art, st.color, true));

    if (prevIdx != null && prevIdx !== artIdx) {
      for (const [coordStr, ctx] of st.contextsByCoord) {
        const [col, row] = coordStr.split(",").map(Number);
        const idx = articulationIndexForCoord({ column: col, row });
        if (idx === prevIdx) {
          const prevArt = st.articulations[prevIdx];
          if (hasArt(prevArt))
            jobs.push(renderArtKey(ctx, prevArt, st.color, false));
          else jobs.push(renderEmptyKey(ctx));
          break;
        }
      }
    }
    Promise.allSettled(jobs);
  }
}
function onKeyUp(/* msg */) {}

// ---------------------------------------
// Cubase: Trackname (SysEx) & Farbe (CC 20/21/22 auf Kanal 15)
// ---------------------------------------
let lastTrackName = "";
let debounceTimer = null;

function onSysexFromCubase(bytes) {
  if (bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return;
  const trackName = String.fromCharCode(...bytes.slice(1, -1)).trim();
  w(`[DBG] [TRACK] Name (SysEx): "${trackName}"`);
  if (!trackName || trackName.toLowerCase() === lastTrackName.toLowerCase())
    return;

  lastTrackName = trackName;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => applyProfileForTrack(trackName), 120);
}

// Farbe via CC#20 (R), #21 (G), #22 (B) [0..127] – nur auf Kanal 15
const colorState = { r: null, g: null, b: null, timer: null };
function onCcFromCubase({ controller, value, channel }) {
  if (controller === COLOR_CC.R) colorState.r = value;
  else if (controller === COLOR_CC.G) colorState.g = value;
  else if (controller === COLOR_CC.B) colorState.b = value;
  else return;

  if (colorState.timer) clearTimeout(colorState.timer);
  colorState.timer = setTimeout(() => {
    const r = to255(colorState.r),
      g = to255(colorState.g),
      b = to255(colorState.b);
    if ([r, g, b].some((x) => x == null)) return;
    const hex = rgbToHex(r, g, b);
    w(`[COLOR] Track color set: ${hex} (R${r} G${g} B${b})`);

    for (const [deviceId, st] of deviceState) {
      st.color = hex;
      renderProfileForDevice(deviceId);
    }
  }, 25);
}
function to255(v) {
  return typeof v === "number" ? Math.round((v / 127) * 255) : null;
}
function rgbToHex(r, g, b) {
  const toHex = (x) => x.toString(16).padStart(2, "0");
  return `#${toHex(Math.max(0, Math.min(255, r)))}${toHex(
    Math.max(0, Math.min(255, g))
  )}${toHex(Math.max(0, Math.min(255, b)))}`;
}

// Titel immer setzen; Arts nur wenn "KS" vorhanden
function applyProfileForTrack(trackName) {
  const raw = String(trackName || "").trim();
  const hasKS = /\bKS\b$/i.test(raw);
  const title = extractInstrumentTitle(raw);

  let key = null;
  let arts = [];
  if (hasKS) {
    key =
      Object.keys(profiles).find((k) => new RegExp(k, "i").test(raw)) || null;
    const profile = key ? profiles[key] || {} : {};

    // <<------- HIER: note kann Zahl ODER String (z. B. "D#-1") sein
    arts = (profile.articulations || []).map((a) => ({
      name: a.name || "",
      note: parseNoteToMidi(a.note), // konvertiert z. B. "Db0" -> 13 etc.
    }));
  } else {
    w(
      `⏭ Track without "KS": clearing articulation keys; setting title "${title}"`
    );
  }

  for (const [deviceId, st] of deviceState) {
    st.profileKey = hasKS ? key : null;
    st.articulations = hasKS ? arts : [];
    st.instrumentTitle = title;
    st.selectedArtIdx = null;
    w(
      `[PROFILE] KS=${hasKS ? "yes" : "no"} | Match: ${
        key || "(none)"
      } | Arts: ${st.articulations.length} | Title: "${title}"`
    );
    renderProfileForDevice(deviceId);
  }
}

async function renderProfileForDevice(deviceId) {
  const st = deviceState.get(deviceId);
  if (!st) return;

  w(
    `[DBG] [render] device: ${deviceId} | title: "${
      st.instrumentTitle || ""
    }" | color: ${st.color} | arts: ${st.articulations.length}`
  );
  const tasks = [];
  st.contextsByCoord.forEach((context, coordStr) => {
    const [col, row] = coordStr.split(",").map(Number);
    if (row === TITLE_POS.row && col === TITLE_POS.col) {
      tasks.push(renderTitleKey(context, st.instrumentTitle || "", st.color));
    } else if (row >= START_ROW_FOR_ARTS) {
      const idx = articulationIndexForCoord({ column: col, row });
      const art = st.articulations[idx];
      if (hasArt(art)) {
        const sel = st.selectedArtIdx === idx;
        tasks.push(renderArtKey(context, art, st.color, sel));
      } else {
        tasks.push(renderEmptyKey(context));
      }
    } else {
      tasks.push(renderEmptyKey(context));
    }
  });
  await Promise.allSettled(tasks);
}

// ---------------------------------------
// Rendering
// ---------------------------------------
const IMG_SIZE = 96;
const HEADER_H = 8;
const MAIN_FONT_SIZE = 16;
const BADGE_FONT_SIZE = 10;
const TITLE_FONT_SIZE = 18;
const TITLE_LINE_HEIGHT = 1.22;

// --- Anzeige-Basis für Oktaven (Cubase-Default -2 = C-2 ist Note 0)
const DISPLAY_OCTAVE_BASE = Number(process.env.MIDI_OCTAVE_BASE ?? "-2");

const CACHE_ART = new Map();
const CACHE_TTL = new Map();
const CACHE_EMP = new Map();

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}
function relLuminance({ r, g, b }) {
  const srgb = [r, g, b].map((v) => v / 255);
  const lin = srgb.map((v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrastOn(hexColor) {
  const L = relLuminance(hexToRgb(hexColor));
  return L > 0.53 ? "#111111" : "#FFFFFF";
}

function renderEmptyKey(context) {
  const k = "empty";
  if (CACHE_EMP.has(k)) return setImage(context, CACHE_EMP.get(k));
  const canvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, IMG_SIZE, IMG_SIZE);
  const dataUrl = canvas.toDataURL("image/png");
  CACHE_EMP.set(k, dataUrl);
  setImage(context, dataUrl);
}

function renderTitleKey(context, titleText, color = "#4B5563") {
  const key = JSON.stringify({
    t: titleText || "",
    c: color || "",
    fs: TITLE_FONT_SIZE,
  });
  const cached = CACHE_TTL.get(key);
  if (cached) return setImage(context, cached);

  const canvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);

  const hasInterMed = GlobalFonts.has("Inter-Medium");
  const baseFamily = hasInterMed ? "Inter-Medium" : "Segoe UI";
  ctx.font = `${TITLE_FONT_SIZE}px "${baseFamily}"`;
  ctx.fillStyle = contrastOn(color);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  const maxWidth = IMG_SIZE - 10;
  const words = String(titleText || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) words.push("");

  const lines = words.map((w) =>
    ctx.measureText(w).width <= maxWidth
      ? w
      : ellipsizeToWidth(ctx, w, maxWidth)
  );

  const lineMetrics = lines.map((line) => {
    const m = ctx.measureText(line || " ");
    const asc = Number.isFinite(m.actualBoundingBoxAscent)
      ? m.actualBoundingBoxAscent
      : TITLE_FONT_SIZE * 0.8;
    const desc = Number.isFinite(m.actualBoundingBoxDescent)
      ? m.actualBoundingBoxDescent
      : TITLE_FONT_SIZE * 0.2;
    const gap = Math.max(0, TITLE_FONT_SIZE * (TITLE_LINE_HEIGHT - 1));
    return { asc, desc, gap, width: m.width };
  });

  let totalH = 0;
  for (let i = 0; i < lineMetrics.length; i++) {
    totalH += lineMetrics[i].asc + lineMetrics[i].desc;
    if (i < lineMetrics.length - 1) totalH += lineMetrics[i].gap;
  }
  let cursorY = (IMG_SIZE - totalH) / 2;

  for (let i = 0; i < lines.length; i++) {
    const lm = lineMetrics[i];
    let text = lines[i];
    if (lm.width > maxWidth) text = ellipsizeToWidth(ctx, text, maxWidth);
    const baselineY = cursorY + lm.asc;
    ctx.fillText(text, IMG_SIZE / 2, Math.round(baselineY));
    cursorY += lm.asc + lm.desc + lm.gap;
    if (cursorY > IMG_SIZE) break;
  }

  const dataUrl = canvas.toDataURL("image/png");
  CACHE_TTL.set(key, dataUrl);
  setImage(context, dataUrl);
}

function renderArtKey(context, art, color = "#4B5563", selected = false) {
  if (!hasArt(art)) return renderEmptyKey(context);

  const key = JSON.stringify({
    n: art?.name || "",
    m: art?.note ?? "",
    c: color || "",
    s: !!selected,
    mf: MAIN_FONT_SIZE,
    bf: BADGE_FONT_SIZE,
    ob: DISPLAY_OCTAVE_BASE,
  });
  const cached = CACHE_ART.get(key);
  if (cached) return setImage(context, cached);

  const canvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, IMG_SIZE, IMG_SIZE);

  const headerColor = selected ? "#FFFFFF" : color;
  const textColor = selected ? color : "#FFFFFF";

  ctx.fillStyle = headerColor;
  ctx.fillRect(0, 0, IMG_SIZE, HEADER_H);

  const hasInterSemi = GlobalFonts.has("Inter-SemiBold");
  const mainFamily = hasInterSemi ? "Inter-SemiBold" : "Segoe UI Semibold";

  // Zwei-Zeilen-Layout bei Leerzeichen
  const rawLabel = art?.name || "";
  const label = rawLabel.toUpperCase();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = textColor;
  ctx.font = `${MAIN_FONT_SIZE}px "${mainFamily}"`;

  const maxWidth = IMG_SIZE - 12;

  const areaTop = HEADER_H + 18;
  const areaCenterY = areaTop + 18;

  if (/\s+/.test(rawLabel)) {
    // 1. Wort in Zeile 1, Rest in Zeile 2
    const parts = label.trim().split(/\s+/);
    const line1 = ellipsizeToWidth(ctx, parts[0] || "", maxWidth);
    const line2 = ellipsizeToWidth(ctx, parts.slice(1).join(" "), maxWidth);

    const lineH = Math.round(MAIN_FONT_SIZE * 1.15);
    ctx.fillText(line1, IMG_SIZE / 2, areaCenterY - lineH / 2);
    ctx.fillText(line2, IMG_SIZE / 2, areaCenterY + lineH / 2);
  } else {
    // Einzeilig
    const fitted = ellipsizeToWidth(ctx, label, maxWidth);
    ctx.fillText(fitted, IMG_SIZE / 2, areaCenterY);
  }

  if (Number.isInteger(art?.note)) {
    const badgeText = noteBadgeText(art.note);
    ctx.font = `${BADGE_FONT_SIZE}px "${mainFamily}"`;
    const padX = 6,
      padY = 3,
      h = 16;
    const wText = Math.ceil(ctx.measureText(badgeText).width);
    const wBox = wText + padX * 2;
    const x = IMG_SIZE - 8 - wBox;
    const y = IMG_SIZE - 8 - h;

    if (selected) {
      roundRect(ctx, x, y, wBox, h, 4, "#FFFFFF", 1);
      ctx.fillStyle = color;
    } else {
      roundRect(ctx, x, y, wBox, h, 4, "#111827", 0.9);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(badgeText, x + padX, y + padY);
  }

  const dataUrl = canvas.toDataURL("image/png");
  CACHE_ART.set(key, dataUrl);
  setImage(context, dataUrl);
}

// Draw helpers
function setImage(context, base64) {
  ws.send(
    JSON.stringify({
      event: "setImage",
      context,
      payload: { image: base64, target: 0 },
    })
  );
}
function roundRect(ctx, x, y, w, h, r, fill = "#000", opacity = 1) {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

// === Badge-Text: nutzt DISPLAY_OCTAVE_BASE für die Oktaven-Anzeige ===
function noteBadgeText(n) {
  const names = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
  ];
  const name = names[((n % 12) + 12) % 12];
  const octave = Math.floor(n / 12) + DISPLAY_OCTAVE_BASE;
  return `${name}${octave} / ${n}`;
}

// === Parser: Profile-"note" als Zahl ODER String (z. B. "Db-1", "C#0", "12") ===
// - Oktavangabe wird in derselben Logik interpretiert wie Anzeige (DISPLAY_OCTAVE_BASE).
//   Beispiel (Default -2):
//   "C-2" -> 0, "C-1" -> 12, "D#-1" -> 15 usw.
function parseNoteToMidi(v) {
  if (v == null) return null;

  // Zahl oder Zahl-String (z. B. "14")
  if (typeof v === "number" && Number.isFinite(v)) {
    return clampMidi(v);
  }
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) {
    return clampMidi(parseInt(v.trim(), 10));
  }

  if (typeof v !== "string") {
    w(`[WRN] Unsupported note type: ${typeof v}`);
    return null;
  }

  const s = v.trim().replace(/♯/g, "#").replace(/♭/g, "b").replace(/\s+/g, "");

  // Allow letters A..G or H (H == B)
  const m = /^([A-Ga-gHh])([#b]?)(-?\d+)$/.exec(s);
  if (!m) {
    w(
      `[WRN] Could not parse note string "${v}" – expected like C#-1, Db0, A3, 12`
    );
    return null;
  }

  let [, noteLetter, accidental, octaveStr] = m;
  noteLetter = noteLetter.toUpperCase();
  const octave = parseInt(octaveStr, 10);

  // pitch class base (English + optional 'H' alias to B)
  const basePcMap = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 };
  let pc = basePcMap[noteLetter];
  if (pc == null) {
    w(`[WRN] Unknown note letter "${noteLetter}"`);
    return null;
  }
  if (accidental === "#") pc += 1;
  else if (accidental === "b") pc -= 1;

  pc = ((pc % 12) + 12) % 12;

  // inverse der Anzeige-Formel:
  // badge: octave = floor(n/12) + DISPLAY_OCTAVE_BASE
  // -> n soll so sein, dass C(octave) = 12*(octave - DISPLAY_OCTAVE_BASE)
  const midi = 12 * (octave - DISPLAY_OCTAVE_BASE) + pc;
  return clampMidi(midi);
}

function clampMidi(n) {
  const x = Math.max(0, Math.min(127, Math.round(n)));
  if (x !== n) w(`[WRN] MIDI note clamped to ${x} (from ${n})`);
  return x;
}

function ellipsizeToWidth(ctx, text, maxWidth) {
  if (!text) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length && ctx.measureText(t + "…").width > maxWidth)
    t = t.slice(0, -1);
  return t ? t + "…" : "";
}

/**
 * Extrahiert den reinen Instrumentennamen für den Titel-Button.
 * - entfernt führenden Präfix "[a]" .. "[z]" (Groß/Kleinschreibung egal)
 * - entfernt ein finales "KS"
 * - entfernt optionale Zusätze nach " - " sowie Klammern
 * - normalisiert Mehrfach-Leerzeichen
 */
function extractInstrumentTitle(trackName) {
  if (!trackName) return "";
  let t = String(trackName).trim();

  // [a] / [B] Präfix am Anfang entfernen
  t = t.replace(/^\s*\[[a-z]\]\s*/i, "");

  // finales "KS" (optional mit Leerzeichen davor) entfernen
  t = t.replace(/\bKS\b\s*$/i, "");

  // Suffixe " - ..." oder " – ..." kappen (U-HE bleibt unangetastet)
  t = t.replace(/\s+[-–]\s+.*$/, "");

  // optionale Klammern am Ende entfernen
  t = t.replace(/\s*\([^)]*\)\s*$/, "");

  // Mehrfach-Leerzeichen normalisieren
  t = t.replace(/\s{2,}/g, " ").trim();

  return t;
}

function safeJson(x) {
  try {
    return typeof x === "string" ? JSON.parse(x) : JSON.parse(String(x));
  } catch {
    return null;
  }
}

// Cleanup
process.on("exit", () => {
  try {
    profilesWatch && profilesWatch.close();
  } catch {}
  try {
    midiOut && midiOut.close();
  } catch {}
  try {
    midiIn && midiIn.close();
  } catch {}
});
