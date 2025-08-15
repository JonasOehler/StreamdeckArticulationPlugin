/* eslint-disable no-console */
"use strict";

const WebSocket = require("ws");
const easymidi = require("easymidi");
const fs = require("fs");
const path = require("path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

/* ---------------------------------------
   Logging
---------------------------------------- */
const LOG_PATH = path.join(__dirname, "plugin.log");
function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function _write(level, msg) {
  const line = `[${ts()}] ${level} ${msg}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line, "utf8");
  } catch {}
  // auch in die Stream Deck Logcat
  if (level.startsWith("[ERR]")) console.error(line.trim());
  else if (level.startsWith("[WRN]")) console.warn(line.trim());
  else console.log(line.trim());
}
const log = (m) => _write("     ", m);
const dbg = (m) => _write("[DBG]", m);
const wrn = (m) => _write("[WRN]", m);
const err = (m) => _write("[ERR]", m);

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
  if (fs.existsSync(fontSemiBold)) {
    GlobalFonts.registerFromPath(fontSemiBold, "Inter-SemiBold");
    dbg(`Font registriert: ${fontSemiBold}`);
  }
  if (fs.existsSync(fontMedium)) {
    GlobalFonts.registerFromPath(fontMedium, "Inter-Medium");
    dbg(`Font registriert: ${fontMedium}`);
  }
} catch (e) {
  wrn(`Konnte Fonts nicht registrieren: ${e && e.message}`);
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
const infoVersion =
  (info.application && info.application.version) ||
  (info && info.version) ||
  "unknown";

log("==== Cubase Articulations Plugin START ====");
dbg(
  `Start-Args: ${JSON.stringify({
    port,
    pluginUUID,
    registerEvent,
    infoVersion,
  })}`
);

if (!port || !pluginUUID || !registerEvent) {
  err("Fehlende Startparameter (-port/-pluginUUID/-registerEvent).");
  process.exit(1);
}

/* ---------------------------------------
   MIDI I/O
---------------------------------------- */
const TARGET_MIDI_OUT = "NodeToCubase";
const TARGET_MIDI_IN = "CubaseToNode";
let midiOut = null,
  midiIn = null;

function setupMidi() {
  try {
    const outs = easymidi.getOutputs();
    const ins = easymidi.getInputs();
    dbg(`[MIDI] Outputs: ${JSON.stringify(outs)}`);
    dbg(`[MIDI] Inputs : ${JSON.stringify(ins)}`);

    const outName = outs.find((n) => n.includes(TARGET_MIDI_OUT));
    const inName = ins.find((n) => n.includes(TARGET_MIDI_IN));

    if (!outName)
      wrn(`Kein MIDI Out "${TARGET_MIDI_OUT}". Verfügbar: ${outs.join(", ")}`);
    if (!inName)
      wrn(`Kein MIDI In "${TARGET_MIDI_IN}". Verfügbar: ${ins.join(", ")}`);

    if (outName) {
      midiOut = new easymidi.Output(outName);
      log(`MIDI Out verbunden: ${outName}`);
    }
    if (inName) {
      midiIn = new easymidi.Input(inName);
      log(`MIDI In  verbunden: ${inName}`);
    }

    if (midiIn) {
      midiIn.on("sysex", (msg) => {
        dbg(`[MIDI<-Cubase] SysEx bytes: [${msg.bytes.join(",")}]`);
        onSysexFromCubase(msg.bytes);
      });
      midiIn.on("cc", (msg) => {
        dbg(
          `[MIDI<-Cubase] CC ${msg.controller} = ${msg.value} ch ${msg.channel}`
        );
        onCcFromCubase(msg);
      });
    }
  } catch (e) {
    err(`MIDI Setup Fehler: ${e && e.stack ? e.stack : e}`);
  }
}

function sendNote(noteNumber, channel = 0, velocity = 127, lengthMs = 110) {
  if (!midiOut) return err("Kein MIDI Out aktiv.");
  midiOut.send("noteon", { note: noteNumber, velocity, channel });
  setTimeout(
    () => midiOut.send("noteoff", { note: noteNumber, velocity: 0, channel }),
    lengthMs
  );
}

/* ---------------------------------------
   Profiles laden (ohne Farben!)
---------------------------------------- */
const profilesPath = path.join(__dirname, "profiles.json");
let profiles = {};
try {
  profiles = JSON.parse(fs.readFileSync(profilesPath, "utf-8"));
  log(`Profiles geladen: ${profilesPath}`);
} catch {
  wrn("profiles.json nicht gefunden/lesbar – verwende leeres Mapping.");
  profiles = {};
}

/* ---------------------------------------
   State je Gerät
---------------------------------------- */
/**
 * deviceState: Map<deviceId, {
 *   contextsByCoord: Map<'c,r', context>,
 *   articulations: Array<{ name, note }>,
 *   color: string,                        // immer: Spurfarbe aus Cubase
 *   profileKey: string|null,
 *   selectedArtIdx: number|null,
 *   instrumentTitle: string
 * }>
 */
const deviceState = new Map();

const COLS = 8; // Stream Deck XL
const TITLE_POS = { col: 1, row: 0 }; // Titel-Key: Zeile 1, Taste 2 (Row 0, Col 1)
const START_ROW_FOR_ARTS = 1; // Artikulationen ab Zeile 2 (Row 1)

/* ---------------------------------------
   WebSocket zur Stream Deck App
---------------------------------------- */
const ws = new WebSocket(`ws://127.0.0.1:${port}`);

ws.on("open", () => {
  ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
  log(
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
  dbg(`[WS<-SD] event: ${event}`);

  if (event === "deviceDidConnect") {
    ensureDeviceState(msg.device);
    log(`Device verbunden: ${msg.device}`);
  }
  if (event === "deviceDidDisconnect") {
    deviceState.delete(msg.device);
    log(`Device getrennt: ${msg.device}`);
  }

  if (event === "willAppear") {
    const st = ensureDeviceState(msg.device);
    const ck = coordKey(msg.payload.coordinates);
    dbg(`willAppear @ ${ck} context: ${String(msg.context).slice(0, 8)}…`);
    st.contextsByCoord.set(ck, msg.context);
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
    dbg(`deviceState init: ${deviceId}`);
    deviceState.set(deviceId, {
      contextsByCoord: new Map(),
      articulations: [],
      color: "#4B5563", // neutral grau, bis Cubase-Farbe kommt
      profileKey: null,
      selectedArtIdx: null,
      instrumentTitle: "",
    });
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
      renderEmptyKey(context); // absolut leer
    }
  } else {
    renderEmptyKey(context);
  }
}

function onKeyDown(msg) {
  const st = ensureDeviceState(msg.device);
  const c = msg.payload.coordinates;

  // Titel-Key komplett ignorieren
  if (c.row === TITLE_POS.row && c.column === TITLE_POS.col) return;

  // Nur Artikulationen
  const artIdx = articulationIndexForCoord(c);
  if (artIdx == null) return;
  const art = st.articulations[artIdx];
  if (!hasArt(art)) return;

  if (Number.isInteger(art?.note)) {
    sendNote(art.note);

    const prevIdx = st.selectedArtIdx;
    st.selectedArtIdx = artIdx;

    const jobs = [];

    // aktiver Key (invertiert)
    const currentCtx = st.contextsByCoord.get(coordKey(c));
    if (currentCtx) jobs.push(renderArtKey(currentCtx, art, st.color, true));

    // vorherigen Key zurücksetzen
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
   Cubase: Trackname (SysEx) & Farbe (CC)
---------------------------------------- */
let lastTrackName = "";
let debounceTimer = null;

function onSysexFromCubase(bytes) {
  if (bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return;
  const trackName = String.fromCharCode(...bytes.slice(1, -1)).trim();
  dbg(`[TRACK] Name (SysEx): "${trackName}"`);
  if (!trackName || trackName.toLowerCase() === lastTrackName.toLowerCase())
    return;

  lastTrackName = trackName;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => applyProfileForTrack(trackName), 120);
}

// Farbe via CC#20 (R), #21 (G), #22 (B) [0..127]
const colorState = { r: null, g: null, b: null, timer: null };
function onCcFromCubase({ controller, value /* 0..127 */ }) {
  if (controller === 20) colorState.r = value;
  else if (controller === 21) colorState.g = value;
  else if (controller === 22) colorState.b = value;
  else return;

  if (colorState.timer) clearTimeout(colorState.timer);
  colorState.timer = setTimeout(() => {
    const r = to255(colorState.r),
      g = to255(colorState.g),
      b = to255(colorState.b);
    if ([r, g, b].some((x) => x == null)) return;

    const hexRaw = rgbToHex(r, g, b);
    const hexUsed = compensateDeviceColor(hexRaw);
    log(
      `[COLOR] Spurfarbe gesetzt: ${hexUsed} (raw ${hexRaw}) (R${r} G${g} B${b})`
    );

    for (const [deviceId, st] of deviceState) {
      st.color = hexUsed; // **einzige** Farbquelle
      dbg(
        `[render] device: ${deviceId} | title: "${st.instrumentTitle}" | color: ${st.color} | arts: ${st.articulations.length}`
      );
      renderProfileForDevice(deviceId);
    }
  }, 30);
}

function to255(v) {
  return typeof v === "number" ? Math.round((v / 127) * 255) : null;
}

function applyProfileForTrack(trackName) {
  // Nur laden, wenn der Name **am Ende** „KS“ hat (z. B. „… Violin KS“)
  if (!/\bKS\b$/i.test(trackName.trim())) {
    log(`⏭ Überspringe Spur ohne 'KS' am Ende: "${trackName}"`);
    return;
  }

  const key = Object.keys(profiles).find((k) =>
    new RegExp(k, "i").test(trackName)
  );
  const profile = key ? profiles[key] || {} : {};

  // **keine** Farbe mehr aus dem Profil
  const arts = (profile.articulations || []).map((a) => ({
    name: a.name || "",
    note: a.note,
  }));

  // Titel aus Trackname ableiten (trailing „KS“ entfernen)
  const title = extractInstrumentTitle(trackName);

  log(
    `[PROFILE] Match: ${key || "(none)"} | Arts: ${
      arts.length
    } | Title: "${title}"`
  );

  for (const [deviceId, st] of deviceState) {
    st.profileKey = key || null;
    st.articulations = arts;
    // st.color bleibt unangetastet – wird nur durch CC gesetzt
    st.instrumentTitle = title;
    st.selectedArtIdx = null; // Reset Auswahl
    dbg(
      `[render] device: ${deviceId} | title: "${st.instrumentTitle}" | color: ${st.color} | arts: ${st.articulations.length}`
    );
    renderProfileForDevice(deviceId);
  }
}

async function renderProfileForDevice(deviceId) {
  const st = deviceState.get(deviceId);
  if (!st) return;

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
   Rendering
---------------------------------------- */
const IMG_SIZE = 96;
const HEADER_H = 8; // Artikulations-Headerhöhe (sichtbar nur bei Art)
const MAIN_FONT_SIZE = 16; // Artikulations-Label
const BADGE_FONT_SIZE = 10; // Badge-Schriftgröße
const TITLE_FONT_SIZE = 18; // Titel
const TITLE_LINE_HEIGHT = 1.22;

// Caches
const CACHE_ART = new Map();
const CACHE_TTL = new Map();
const CACHE_EMP = new Map();

/* ---------- Leerer Key ---------- */
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

/* ---------- Titel-Key: volle Fläche + exakte Zentrierung + Kontrast ---------- */
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

  // Hintergrund = Spurfarbe
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);

  // Kontrastabhängige Textfarbe
  const textFill = pickTextForBg(color);
  ctx.fillStyle = textFill;
  if (textFill === "#FFFFFF") {
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 2.0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  } else {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
  }

  // Typo
  const hasInterMed = GlobalFonts.has("Inter-Medium");
  const baseFamily = hasInterMed ? "Inter-Medium" : "Segoe UI";
  ctx.font = `${TITLE_FONT_SIZE}px "${baseFamily}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Split bei Spaces, zu lange Wörter ellipsen
  const maxWidth = IMG_SIZE - 10; // 5px links/rechts
  const wordsRaw = String(titleText || "").trim();
  const words = wordsRaw.split(/\s+/).filter(Boolean);
  if (words.length === 0) words.push("");

  const lines = words.map((w) =>
    ctx.measureText(w).width <= maxWidth
      ? w
      : ellipsizeToWidth(ctx, w, maxWidth)
  );

  // Zeilenmetriken
  const lineMetrics = lines.map((line) => {
    const m = ctx.measureText(line || " ");
    const asc = Number.isFinite(m.actualBoundingBoxAscent)
      ? m.actualBoundingBoxAscent
      : TITLE_FONT_SIZE * 0.8;
    const desc = Number.isFinite(m.actualBoundingBoxDescent)
      ? m.actualBoundingBoxDescent
      : TITLE_FONT_SIZE * 0.2;
    const lineGap = Math.max(0, TITLE_FONT_SIZE * (TITLE_LINE_HEIGHT - 1));
    return { asc, desc, lineGap, width: m.width };
  });

  // Gesamtblock-Höhe
  let totalHeight = 0;
  for (let i = 0; i < lineMetrics.length; i++) {
    totalHeight += lineMetrics[i].asc + lineMetrics[i].desc;
    if (i < lineMetrics.length - 1) totalHeight += lineMetrics[i].lineGap;
  }

  // Vertikal exakt zentrieren
  let yTop = (IMG_SIZE - totalHeight) / 2;
  let cursorY = yTop;

  for (let i = 0; i < lines.length; i++) {
    const lm = lineMetrics[i];
    let text = lines[i];
    if (lm.width > maxWidth) text = ellipsizeToWidth(ctx, text, maxWidth);

    const baselineY = cursorY + lm.asc; // alphabetic baseline
    ctx.fillText(text, IMG_SIZE / 2, Math.round(baselineY));

    cursorY += lm.asc + lm.desc + lm.lineGap;
    if (cursorY > IMG_SIZE) break;
  }

  const dataUrl = canvas.toDataURL("image/png");
  CACHE_TTL.set(key, dataUrl);
  setImage(context, dataUrl);
}

/* ---------- Artikulations-Key ---------- */
/*  Unselected:  BG transparent, Header = Spurfarbe, Text = Weiß, Badge dunkel
    Selected  :  BG transparent, Header = Weiß, Text = Spurfarbe, Badge invertiert (lesbar) */
function renderArtKey(context, art, color = "#4B5563", selected = false) {
  if (!hasArt(art)) return renderEmptyKey(context);

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

  // Hintergrund transparent
  ctx.clearRect(0, 0, IMG_SIZE, IMG_SIZE);

  // Farben je nach Auswahl
  const headerColor = selected ? "#FFFFFF" : color;
  const textColor = selected ? color : "#FFFFFF";

  // Header-Balken
  ctx.fillStyle = headerColor;
  ctx.fillRect(0, 0, IMG_SIZE, HEADER_H);

  // Fonts
  const hasInterSemi = GlobalFonts.has("Inter-SemiBold");
  const mainFamily = hasInterSemi ? "Inter-SemiBold" : "Segoe UI Semibold";

  // Haupt-Label (fixe Größe, Ellipsis)
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

  // Note-Badge (invertiert bei Auswahl)
  if (Number.isInteger(art?.note)) {
    const badgeText = noteBadgeText(art.note);
    ctx.font = `${BADGE_FONT_SIZE}px "${mainFamily}"`;
    const padX = 6,
      padY = 3,
      h = 16;
    const w = Math.ceil(ctx.measureText(badgeText).width) + padX * 2;
    const x = IMG_SIZE - 8 - w;
    const y = IMG_SIZE - 8 - h;

    if (selected) {
      // invertiert: weißer Hintergrund, farbiger Text (ggf. abdunkeln)
      roundRect(ctx, x, y, w, h, 4, "#FFFFFF", 1);
      const readable = ensureReadableOnWhite(color);
      ctx.fillStyle = readable;
    } else {
      // normal: dunkles Badge, weißer Text
      roundRect(ctx, x, y, w, h, 4, "#111827", 0.9);
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
   Draw & Color Helpers
---------------------------------------- */
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

// Trackname → Titel (trailing „KS“ & Klammern/Suffixe entfernen)
function extractInstrumentTitle(trackName) {
  if (!trackName) return "";
  return trackName
    .replace(/\bKS\b\s*$/i, "") // nur am Ende entfernen
    .replace(/\s*-\s*.*/g, "") // alles nach " - " entfernen
    .replace(/\s*\(.*?\)\s*/g, "") // Klammerzusätze
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ---------- Color/Contrast utils ---------- */
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}
function rgbToHex(r, g, b) {
  const h = (x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relativeLuminance({ r, g, b }) {
  const R = srgbToLinear(r),
    G = srgbToLinear(g),
    B = srgbToLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatioHex(bgHex, fgHex) {
  const L1 = relativeLuminance(hexToRgb(bgHex));
  const L2 = relativeLuminance(hexToRgb(fgHex));
  const lighter = Math.max(L1, L2),
    darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}
function pickTextForBg(bgHex) {
  // wähle Weiß, außer der Kontrast ist schlecht -> Schwarz
  return contrastRatioHex(bgHex, "#FFFFFF") >= 3.0 ? "#FFFFFF" : "#111111";
}
function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h,
    s,
    l = (max + min) / 2;
  if (max === min) {
    h = 0;
    s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h, s, l };
}
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}
function darkenHex(hex, amt /*0..1*/) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const l2 = Math.max(0, l - amt);
  const nrgb = hslToRgb(h, s, l2);
  return rgbToHex(nrgb.r, nrgb.g, nrgb.b);
}
function ensureReadableOnWhite(colorHex) {
  if (contrastRatioHex("#FFFFFF", colorHex) >= 4.5) return colorHex;
  let c = colorHex;
  for (let i = 0; i < 6; i++) {
    c = darkenHex(c, 0.06);
    if (contrastRatioHex("#FFFFFF", c) >= 4.5) return c;
  }
  return "#111827";
}
// (Optional) kleine Sättigungs-/Helligkeitskorrektur fürs Panel
const COLOR_COMP = { enable: false, satBoost: 0.1, lightShift: -0.02 };
function compensateDeviceColor(hex) {
  if (!COLOR_COMP.enable) return hex;
  const { r, g, b } = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  const s = Math.max(0, Math.min(1, hsl.s + COLOR_COMP.satBoost));
  const l = Math.max(0, Math.min(1, hsl.l + COLOR_COMP.lightShift));
  const nrgb = hslToRgb(hsl.h, s, l);
  return rgbToHex(nrgb.r, nrgb.g, nrgb.b);
}

/* ---------------------------------------
   Utils & Cleanup
---------------------------------------- */
function safeJson(x) {
  try {
    return typeof x === "string" ? JSON.parse(x) : JSON.parse(String(x));
  } catch {
    return null;
  }
}

process.on("uncaughtException", (e) => {
  err(`uncaughtException: ${e && e.stack ? e.stack : e}`);
});
process.on("exit", () => {
  try {
    midiOut && midiOut.close();
  } catch {}
  try {
    midiIn && midiIn.close();
  } catch {}
});
