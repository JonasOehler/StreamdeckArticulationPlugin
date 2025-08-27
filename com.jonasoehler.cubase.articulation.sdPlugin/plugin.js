/* eslint-disable no-console */
"use strict";

/**
 * Cubase Articulations – robuste Version
 * - Native Module (@napi-rs/canvas, easymidi) OPTIONAL & LAZY
 * - Fallbacks: Rendering via setTitle, Betrieb ohne MIDI
 * - Frühes Logging vor externen require()s
 */

const fs = require("fs");
const path = require("path");

/* -------------------------
   Mini-Logger: ganz früh!
-------------------------- */
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
function fatal(msg, err) {
  w(`[FATAL] ${msg}: ${err && (err.stack || err.message || err)}`);
  process.exit(1);
}
w("==== Cubase Articulations Plugin START (safe requires) ====");

/* -------------------------
   Externe Module sicher laden
-------------------------- */
let WebSocket;
try {
  WebSocket = require("ws");
  w("[DBG] ws module geladen");
} catch (e) {
  fatal("ws module konnte nicht geladen werden", e);
}

let easymidi = null;
try {
  easymidi = require("easymidi");
  w("[DBG] easymidi geladen");
} catch (e) {
  w(`[WRN] easymidi NICHT verfügbar: ${e && e.message}`);
}

let createCanvas = null;
let GlobalFonts = { has: () => false, registerFromPath: () => {} };
try {
  ({ createCanvas, GlobalFonts } = require("@napi-rs/canvas"));
  w("[DBG] @napi-rs/canvas geladen");
} catch (e) {
  w(
    `[WRN] @napi-rs/canvas NICHT verfügbar – Fallback auf setTitle: ${
      e && e.message
    }`
  );
}

/* -------------------------
   Schutznetze für Laufzeit
-------------------------- */
process.on("uncaughtException", (err) => {
  w(`[UNCAUGHT] ${err && (err.stack || err)}`);
});
process.on("unhandledRejection", (reason) => {
  w(`[UNHANDLED REJECTION] ${reason && (reason.stack || reason)}`);
});

/* ---------------------------------------
   Fonts (optional)
---------------------------------------- */
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
  if (
    fs.existsSync(fontSemiBold) &&
    GlobalFonts &&
    GlobalFonts.registerFromPath
  ) {
    GlobalFonts.registerFromPath(fontSemiBold, "Inter-SemiBold");
    w(`[DBG] Font registriert: ${fontSemiBold}`);
  }
  if (
    fs.existsSync(fontMedium) &&
    GlobalFonts &&
    GlobalFonts.registerFromPath
  ) {
    GlobalFonts.registerFromPath(fontMedium, "Inter-Medium");
    w(`[DBG] Font registriert: ${fontMedium}`);
  }
} catch (e) {
  w(`[WRN] Konnte Fonts nicht registrieren: ${e && e.message}`);
}

/* ---------------------------------------
   Utils
---------------------------------------- */
function safeJson(x) {
  try {
    return typeof x === "string" ? JSON.parse(x) : JSON.parse(String(x));
  } catch {
    return null;
  }
}

/* ---------------------------------------
   SDK Start-Parameter
---------------------------------------- */
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
  w("[ERR] Fehlende Startparameter (-port/-pluginUUID/-registerEvent).");
  process.exit(1);
}

/* ---------------------------------------
   MIDI I/O (optional)
---------------------------------------- */
const TARGET_MIDI_OUT = "NodeToCubase";
const TARGET_MIDI_IN = "CubaseToNode";

const COLOR_CC = { R: 20, G: 21, B: 22 };
const COLOR_CH = 14; // 0..15 => Kanal 15

let midiOut = null,
  midiIn = null;

function setupMidi() {
  if (!easymidi) {
    w("[WRN] MIDI deaktiviert (easymidi nicht geladen)");
    return;
  }
  try {
    const outs = easymidi.getOutputs();
    const ins = easymidi.getInputs();
    w(`[DBG] [MIDI] Outputs: ${JSON.stringify(outs)}`);
    w(`[DBG] [MIDI] Inputs : ${JSON.stringify(ins)}`);

    const outName = outs.find((n) => n.includes(TARGET_MIDI_OUT));
    const inName = ins.find((n) => n.includes(TARGET_MIDI_IN));

    if (!outName)
      w(
        `[WRN] Kein MIDI Out "${TARGET_MIDI_OUT}". Verfügbar: ${outs.join(
          ", "
        )}`
      );
    if (!inName)
      w(`[WRN] Kein MIDI In "${TARGET_MIDI_IN}". Verfügbar: ${ins.join(", ")}`);

    if (outName) {
      midiOut = new easymidi.Output(outName);
      w(`MIDI Out verbunden: ${outName}`);
    }
    if (inName) {
      midiIn = new easymidi.Input(inName);
      w(`MIDI In  verbunden: ${inName}`);
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
          w(
            `[DBG] [MIDI<-Cubase] Ignoriert (falscher Kanal, erwartet ${
              COLOR_CH + 1
            })`
          );
          return;
        }
        onCcFromCubase(msg);
      });
    }
  } catch (e) {
    w(`[ERR] MIDI Setup Fehler: ${e && e.message}`);
  }
}

function sendNote(noteNumber, channel = 0, velocity = 127, lengthMs = 110) {
  if (!midiOut) return w("[ERR] Kein MIDI Out aktiv oder MIDI deaktiviert.");
  w(`[DBG] sendNote ${noteNumber} ch=${channel} vel=${velocity}`);
  midiOut.send("noteon", { note: noteNumber, velocity, channel });
  setTimeout(
    () => midiOut.send("noteoff", { note: noteNumber, velocity: 0, channel }),
    lengthMs
  );
}

/* ---------------------------------------
   Profiles laden
---------------------------------------- */
const profilesPath = path.join(__dirname, "profiles.json");
let profiles = {};
try {
  profiles = JSON.parse(fs.readFileSync(profilesPath, "utf-8"));
  w(`Profiles geladen: ${profilesPath}`);
} catch {
  w("[WRN] profiles.json nicht gefunden/lesbar – verwende leeres Mapping.");
  profiles = {};
}

/* ---------------------------------------
   State je Gerät
---------------------------------------- */
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
const TITLE_POS = { col: 1, row: 0 }; // Titel-Key (Zeile 1, Taste 2)
const START_ROW_FOR_ARTS = 1; // Artikulationen ab Zeile 2

/* ---------------------------------------
   WebSocket zur Stream Deck App
---------------------------------------- */
const ws = new WebSocket(`ws://127.0.0.1:${port}`);

ws.on("open", () => {
  ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
  w(
    `Stream Deck verbunden & registriert. ${JSON.stringify({
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
    w(`Device verbunden: ${msg.device}`);
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

/* ---------------------------------------
   Mapping Helpers
---------------------------------------- */
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

  // Titel-Key ignorieren
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

function onKeyUp(/* msg */) {
  // nichts nötig
}

/* ---------------------------------------
   Cubase: Trackname (SysEx) & Farbe (CC 20/21/22 auf Kanal 15)
---------------------------------------- */
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
function onCcFromCubase({ controller, value /*, channel */ }) {
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
    w(`[COLOR] Spurfarbe gesetzt: ${hex} (R${r} G${g} B${b})`);

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

// Titel immer setzen; Arts nur wenn Trackname auf „... KS“ endet
function applyProfileForTrack(trackName) {
  const trimmed = String(trackName || "").trim();
  const hasKS = /\bKS\b$/i.test(trimmed);

  const title = extractInstrumentTitle(trimmed);

  let key = null;
  let arts = [];
  if (hasKS) {
    // Robuster: Substring-Match statt Regex
    key =
      Object.keys(profiles).find((k) =>
        trimmed.toLowerCase().includes(k.toLowerCase())
      ) || null;
    const profile = key ? profiles[key] || {} : {};
    arts = (profile.articulations || []).map((a) => ({
      name: a.name || "",
      note: a.note,
    }));
  } else {
    w(
      `⏭ Spur ohne "KS": Articulation-Keys werden geleert. Titel wird gesetzt: "${title}"`
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

/* ---------------------------------------
   Rendering (Canvas oder Fallback)
---------------------------------------- */
const IMG_SIZE = 96;
const HEADER_H = 8;
const MAIN_FONT_SIZE = 16;
const BADGE_FONT_SIZE = 10;
const TITLE_FONT_SIZE = 18;
const TITLE_LINE_HEIGHT = 1.22;

// Caches
const CACHE_ART = new Map();
const CACHE_TTL = new Map();
const CACHE_EMP = new Map();

/* ---------- Helpers für Farben/Text-Kontrast ---------- */
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

/* ---------- setImage / setTitle helpers ---------- */
function setImage(context, base64) {
  ws.send(
    JSON.stringify({
      event: "setImage",
      context,
      payload: { image: base64, target: 0 },
    })
  );
}
function setTitle(context, title) {
  ws.send(
    JSON.stringify({
      event: "setTitle",
      context,
      payload: { title: String(title || ""), target: 0 },
    })
  );
}

/* ---------- Leerer Key ---------- */
function renderEmptyKey(context) {
  if (!createCanvas) {
    // Fallback: Bild leeren
    return setImage(context, "");
  }
  const k = "empty";
  if (CACHE_EMP.has(k)) return setImage(context, CACHE_EMP.get(k));
  const canvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, IMG_SIZE, IMG_SIZE);
  const dataUrl = canvas.toDataURL("image/png");
  CACHE_EMP.set(k, dataUrl);
  setImage(context, dataUrl);
}

/* ---------- Titel-Key ---------- */
function renderTitleKey(context, titleText, color = "#4B5563") {
  if (!createCanvas) {
    // Fallback: Nur Text setzen
    return setTitle(context, titleText || "");
  }
  const key = JSON.stringify({
    t: titleText || "",
    c: color || "",
    fs: TITLE_FONT_SIZE,
  });
  const cached = CACHE_TTL.get(key);
  if (cached) return setImage(context, cached);

  const canvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d");

  // Hintergrund = Spurfarbe
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);

  const hasInterMed = GlobalFonts.has && GlobalFonts.has("Inter-Medium");
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

/* ---------- Artikulations-Key ---------- */
function renderArtKey(context, art, color = "#4B5563", selected = false) {
  if (!hasArt(art)) return renderEmptyKey(context);

  // Fallback ohne Canvas: setTitle (inkl. Noten-Badge)
  if (!createCanvas) {
    const label = (art?.name || "").toUpperCase();
    const badge = Number.isInteger(art?.note)
      ? `  (${noteBadgeText(art.note)})`
      : "";
    return setTitle(context, label + badge);
  }

  const key = JSON.stringify({
    n: art?.name || "",
    m: art?.note ?? "",
    c: color || "",
    s: !!selected,
    mf: MAIN_FONT_SIZE,
    bf: BADGE_FONT_SIZE,
  });
  const cached = CACHE_ART.get(key);
  if (cached) return setImage(context, cached);

  const canvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, IMG_SIZE, IMG_SIZE);

  const headerColor = selected ? "#FFFFFF" : color;
  const textColor = selected ? color : "#FFFFFF";

  // Header-Balken
  ctx.fillStyle = headerColor;
  ctx.fillRect(0, 0, IMG_SIZE, HEADER_H);

  // Fonts
  const hasInterSemi = GlobalFonts.has && GlobalFonts.has("Inter-SemiBold");
  const mainFamily = hasInterSemi ? "Inter-SemiBold" : "Segoe UI Semibold";

  // Haupt-Label
  const label = (art?.name || "").toUpperCase();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = textColor;
  ctx.font = `${MAIN_FONT_SIZE}px "${mainFamily}"`;

  const maxWidth = IMG_SIZE - 12;
  const fitted = ellipsizeToWidth(ctx, label, maxWidth);

  const areaTop = HEADER_H + 18;
  const areaCenterY = areaTop + 18;
  ctx.fillText(fitted, IMG_SIZE / 2, areaCenterY);

  // Note-Badge
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
      // invertiert
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

/* ---------------------------------------
   Draw Helpers
---------------------------------------- */
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
  const octave = Math.floor(n / 12) - 1;
  return `${name}${octave} / ${n}`;
}

function ellipsizeToWidth(ctx, text, maxWidth) {
  if (!text) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length && ctx.measureText(t + "…").width > maxWidth)
    t = t.slice(0, -1);
  return t ? t + "…" : "";
}

function extractInstrumentTitle(trackName) {
  if (!trackName) return "";
  return trackName
    .replace(/\bKS\b\s*$/i, "")
    .replace(/\s*-\s*.*/g, "")
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ---------------------------------------
   Cleanup
---------------------------------------- */
process.on("exit", () => {
  try {
    midiOut && midiOut.close();
  } catch {}
  try {
    midiIn && midiIn.close();
  } catch {}
});
