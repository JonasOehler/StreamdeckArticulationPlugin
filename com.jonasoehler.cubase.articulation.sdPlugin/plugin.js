/* eslint-disable no-console */
"use strict";

const WebSocket = require("ws");
const easymidi = require("easymidi");
const fs = require("fs");
const path = require("path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

/* ---------------------------------------
   Konfiguration (optional)
---------------------------------------- */
// CMD-Cache-Strategie: "perTrack" (empfohlen) oder "clearOnTrackChange"
const CMD_CACHE_MODE = "perTrack";
// Sichtbarkeits-Logging an/aus (steuert [VIS]-Meldungen und eng verwandte)
const LOG_VIS = false;
// Cache-Alter, ab dem beim Erscheinen eines CMD-Keys kein UI-State mehr restored wird
const CACHE_STALE_MS = 3500;
// Bei identischem Feedback-Zustand zusätzlich ein setState senden (sanfter Resync)
const FORCE_SETSTATE_ON_SAME = true;
// Zeitfenster, in dem Feedback „stabilisiert“ (entprellt) wird
const FEEDBACK_SETTLE_MS = 160;
// Beim Sichtbarwerden der CMD-Seite einen Resync ausführen
const RESYNC_ON_CMD_VISIBLE = true;
// Verzögerung, bis alle didReceiveSettings durch sind, dann Resync
const RESYNC_VISIBLE_DELAY_MS = 260;

/* ---------------------------------------
   Logging (Konsole + Datei)
---------------------------------------- */
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
  } catch {}
  try {
    console.log(line);
  } catch {}
}
function v(line) {
  if (LOG_VIS) w(line);
}

w("==== Cubase Articulations Plugin START ====");

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
    w(`[DBG] Font registriert: ${fontSemiBold}`);
  }
  if (fs.existsSync(fontMedium)) {
    GlobalFonts.registerFromPath(fontMedium, "Inter-Medium");
    w(`[DBG] Font registriert: ${fontMedium}`);
  }
} catch (e) {
  w(`[WRN] Konnte Fonts nicht registrieren: ${e && e.message}`);
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
   MIDI I/O
---------------------------------------- */
const TARGET_MIDI_OUT = "NodeToCubase";
const TARGET_MIDI_IN = "CubaseToNode";

// Farbe kommt als CC20/21/22 auf Kanal 15 (zero-based 14)
const COLOR_CC = { R: 20, G: 21, B: 22 };
const COLOR_CH = 14; // 0..15

// Command-Slots (Feedback) standardmäßig Kanal 14 (zero-based 13), CC 10..41
const CONTROL_DEFAULT_CH = 13;
const CONTROL_CC_MIN = 10;
const CONTROL_CC_MAX = 41;

// --- Anti-Drift & Anti-Spam ---
const TX_GUARD_MS = 200; // Eigenes Echo-Fenster
const ACK_TIMEOUT_MS = 900; // Wartezeit auf Host-Antwort
const TAP_DEBOUNCE_MS = 220; // Debounce pro Button-Kontext
const KEY_COOLDOWN_MS = 220; // Cooldown pro (Kanal, CC)

// Karten
const lastTxByKey = new Map(); // "ch:cc" -> { ts, val }
const lastLevelByKey = new Map(); // "ch:cc" -> { ts, state:boolean } (global Fallback)
const cmdLevelByTrack = new Map(); // trackLower -> Map(keyId -> {ts,state})
const awaitingAckByKey = new Map(); // "ch:cc" -> true
const ackTimerByKey = new Map(); // "ch:cc" -> timeout
const lastTapByContext = new Map(); // context -> ts
const nextAllowedTsByKey = new Map(); // "ch:cc" -> ts (Cooldown)

// Feedback-„Settle“-Puffer
const feedbackTimerByKey = new Map(); // keyId -> timeout
const pendingActiveByKey = new Map(); // keyId -> {active, ts}

// Sichtbarkeits-/Kontext-Tracking
const contextToDevice = new Map(); // context -> deviceId
const cmdVisibleSince = new Map(); // deviceId -> ts
const pendingResyncTimerByDevice = new Map(); // deviceId -> timeout

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
        if (
          msg.channel === COLOR_CH &&
          (msg.controller === COLOR_CC.R ||
            msg.controller === COLOR_CC.G ||
            msg.controller === COLOR_CC.B)
        ) {
          w(
            `[DBG] [MIDI<-Cubase] COLOR CC ${msg.controller} = ${msg.value} ch ${msg.channel}`
          );
          onCcFromCubaseColor(msg);
          return;
        }
        handleCommandFeedback(msg);
      });
    }
  } catch (e) {
    w(`[ERR] MIDI Setup Fehler: ${e && e.message}`);
  }
}

function sendNote(noteNumber, channel = 0, velocity = 127, lengthMs = 110) {
  if (!midiOut) return w("[ERR] Kein MIDI Out aktiv.");
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
  w(`Profiles geladen: ${profilesPath}`);
} catch {
  w("[WRN] profiles.json nicht gefunden/lesbar – verwende leeres Mapping.");
  profiles = {};
}

/* ---------------------------------------
   Visibility-Tracking (pro Gerät)
---------------------------------------- */
const visibility = new Map(); // deviceId -> { art: number, cmd: number }
function ensureVis(deviceId) {
  if (!visibility.has(deviceId)) visibility.set(deviceId, { art: 0, cmd: 0 });
  return visibility.get(deviceId);
}
function isArtVisible(deviceId) {
  return (visibility.get(deviceId)?.art || 0) > 0;
}
function isCmdVisible(deviceId) {
  return (visibility.get(deviceId)?.cmd || 0) > 0;
}
function anyCmdVisible() {
  for (const v of visibility.values()) if ((v.cmd || 0) > 0) return true;
  return false;
}

/* ---------------------------------------
   State: Artikulationen (pro Gerät)
---------------------------------------- */
const deviceState = new Map();
const COLS = 8;
const TITLE_POS = { col: 1, row: 0 };
const START_ROW_FOR_ARTS = 1;

function ensureDeviceState(deviceId) {
  if (!deviceState.has(deviceId)) {
    deviceState.set(deviceId, {
      contextsByCoord: new Map(),
      articulations: [],
      color: "#4B5563",
      profileKey: null,
      selectedArtIdx: null,
      instrumentTitle: "",
      profilePending: false,
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

/* ---------------------------------------
   State: Command-Keys (pro Kontext)
---------------------------------------- */
const commandKeys = new Map(); // context -> cfg
function defaultCommandSettings() {
  return {
    channel: CONTROL_DEFAULT_CH,
    controller: CONTROL_CC_MIN,
    mode: "momentary",
    active: false,
  };
}
function keyIdFromCfg(cfg) {
  return `${cfg.channel}:${cfg.controller}`;
}

/* ---------------------------------------
   WebSocket zur Stream Deck App
---------------------------------------- */
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
ws.on("open", () => {
  safeSendToSD({ event: registerEvent, uuid: pluginUUID });
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

/* ---------------------------------------
   UI-State aus Cache anwenden (mit Stale-Schutz, optional „force“)
---------------------------------------- */
function applyCachedStateToContext(context, opts = {}) {
  const { forceAge = false, reason = "" } = opts;
  const cfg = commandKeys.get(context);
  if (!cfg) return;
  const keyId = keyIdFromCfg(cfg);
  const now = Date.now();

  // bevorzugt: per-Track-Cache
  let cached = null;
  if (CMD_CACHE_MODE === "perTrack") {
    const t = (lastTrackName || "").toLowerCase();
    const per = cmdLevelByTrack.get(t);
    cached = per ? per.get(keyId) : null;
  } else {
    cached = lastLevelByKey.get(keyId);
  }

  if (!cached) {
    // Kein Cache für diese Spur -> neutralisieren, damit keine alten Zustände hängen bleiben
    commandKeys.set(context, { ...cfg, active: false });
    setState(context, 0);
    w(
      `[RESYNC] No cache -> neutral ch=${cfg.channel + 1} cc=${
        cfg.controller
      } (reason=${reason || "-"})`
    );
    return;
  }

  const age = now - (cached.ts || 0);
  if (!forceAge && !(cached.ts && age <= CACHE_STALE_MS)) {
    w(
      `[CMD] Skip stale cache (age=${age}ms>${CACHE_STALE_MS}ms) ch=${
        cfg.channel + 1
      } cc=${cfg.controller}`
    );
    return;
  }

  commandKeys.set(context, { ...cfg, active: cached.state });
  setState(context, cached.state ? 1 : 0);
  w(
    `[CMD] Restore UI from ${CMD_CACHE_MODE} cache ch=${cfg.channel + 1} cc=${
      cfg.controller
    } -> state=${cached.state ? 1 : 0} age=${age}ms${
      forceAge ? " [force]" : ""
    }${reason ? ` reason=${reason}` : ""}`
  );
}

/* ---------------------------------------
   Seiten-Resync (pro Gerät)
---------------------------------------- */
function scheduleDeviceCmdResync(deviceId, reason = "visible") {
  const prev = pendingResyncTimerByDevice.get(deviceId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    pendingResyncTimerByDevice.delete(deviceId);
    resyncCmdPageUI(deviceId, reason);
  }, RESYNC_VISIBLE_DELAY_MS);
  pendingResyncTimerByDevice.set(deviceId, t);
}

function resyncCmdPageUI(deviceId, reason = "visible") {
  const now = Date.now();
  v(
    `[RESYNC] Run for device=${deviceId} reason=${reason} at ${new Date(
      now
    ).toLocaleTimeString()}`
  );

  for (const [context, cfg] of commandKeys.entries()) {
    const dev = contextToDevice.get(context);
    if (dev !== deviceId) continue;
    // Forciert, und wenn es keinen Cache gibt -> neutralisieren
    applyCachedStateToContext(context, { forceAge: true, reason });
  }
}

/* ---------------------------------------
   Stream Deck Events
---------------------------------------- */
function handleMessage(msg) {
  const { event, action, device, context } = msg;

  if (event === "deviceDidConnect") {
    ensureDeviceState(device);
    ensureVis(device);
  }
  if (event === "deviceDidDisconnect") {
    deviceState.delete(device);
    visibility.delete(device);
  }

  if (event === "willAppear") {
    if (action === "com.jonasoehler.cubase.articulation.key") {
      const st = ensureDeviceState(device);
      const ck = coordKey(msg.payload.coordinates);
      st.contextsByCoord.set(ck, context);

      const vstate = ensureVis(device);
      const before = vstate.art;
      vstate.art++;
      v(
        `[VIS] willAppear ART device=${device} count ${before}->${
          vstate.art
        } first=${before === 0}`
      );
      if (before === 0) {
        v(`[RENDER] full render (art became visible) device=${device}`);
        renderProfileForDevice(device);
      }

      initialRenderForKey(device, msg.payload.coordinates, context);
    } else if (action === "com.jonasoehler.cubase.command") {
      // Map Kontext->Gerät
      contextToDevice.set(context, device);

      commandKeys.set(context, { ...defaultCommandSettings() });
      safeSendToSD({ event: "getSettings", context });

      const vstate = ensureVis(device);
      const before = vstate.cmd;
      vstate.cmd++;
      v(
        `[VIS] willAppear CMD device=${device} count ${before}->${
          vstate.cmd
        } first=${before === 0}`
      );

      // Bei 1->> sichtbarer CMD-Seite: Resync nach kurzer Verzögerung
      if (RESYNC_ON_CMD_VISIBLE && before === 0) {
        cmdVisibleSince.set(device, Date.now());
        scheduleDeviceCmdResync(device, "visible");
      }
    }
  }

  if (event === "willDisappear") {
    if (action === "com.jonasoehler.cubase.articulation.key") {
      const st = ensureDeviceState(device);
      const ck = coordKey(msg.payload.coordinates);
      st.contextsByCoord.delete(ck);

      const vstate = ensureVis(device);
      const before = vstate.art;
      vstate.art = Math.max(0, vstate.art - 1);
      v(
        `[VIS] willDisappear ART device=${device} count ${before}->${
          vstate.art
        } last=${vstate.art === 0}`
      );
    } else if (action === "com.jonasoehler.cubase.command") {
      const cfg = commandKeys.get(context);
      if (cfg) {
        const id = keyIdFromCfg(cfg);
        clearAckTimer(id);
        awaitingAckByKey.delete(id);
      }
      commandKeys.delete(context);
      lastTapByContext.delete(context);
      contextToDevice.delete(context);

      const vstate = ensureVis(device);
      const before = vstate.cmd;
      vstate.cmd = Math.max(0, vstate.cmd - 1);
      v(
        `[VIS] willDisappear CMD device=${device} count ${before}->${
          vstate.cmd
        } last=${vstate.cmd === 0}`
      );
    }
  }

  if (event === "keyDown") {
    if (action === "com.jonasoehler.cubase.articulation.key") onKeyDownArt(msg);
    else if (action === "com.jonasoehler.cubase.command")
      onKeyDownCommand(context);
  }

  if (event === "keyUp") {
    if (action === "com.jonasoehler.cubase.articulation.key") {
      // none
    } else if (action === "com.jonasoehler.cubase.command") {
      onKeyUpCommand(context);
    }
  }

  if (event === "didReceiveSettings") {
    if (action === "com.jonasoehler.cubase.command") {
      const s = msg.payload?.settings || {};
      const cur = commandKeys.get(context) || defaultCommandSettings();
      const next = {
        ...cur,
        channel:
          typeof s.channel === "number"
            ? clamp(s.channel, 0, 15)
            : CONTROL_DEFAULT_CH,
        controller:
          typeof s.controller === "number"
            ? clamp(s.controller, 0, 127)
            : CONTROL_CC_MIN,
        mode: s.mode === "toggle" ? "toggle" : "momentary",
      };
      commandKeys.set(context, next);

      // Wenn Seite gerade sichtbar wurde, forciert aus Cache wiederherstellen
      const dev = contextToDevice.get(context);
      const since = dev ? cmdVisibleSince.get(dev) || 0 : 0;
      const within = Date.now() - since < 1500; // großzügiges Fenster
      applyCachedStateToContext(context, {
        forceAge: within,
        reason: within ? "didReceiveSettings+visible" : "didReceiveSettings",
      });
    }
  }
}

/* ---------------------------------------
   Artikulationen
---------------------------------------- */
function initialRenderForKey(deviceId, coord, context) {
  const st = ensureDeviceState(deviceId);
  if (coord.row === TITLE_POS.row && coord.column === TITLE_POS.col) {
    renderTitleKey(context, st.instrumentTitle || "", st.color);
  } else if (coord.row >= START_ROW_FOR_ARTS) {
    const artIdx = articulationIndexForCoord(coord);
    const art = st.articulations[artIdx];
    if (hasArt(art))
      renderArtKey(context, art, st.color, st.selectedArtIdx === artIdx);
    else renderEmptyKey(context);
  } else {
    renderEmptyKey(context);
  }
}

function onKeyDownArt(msg) {
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

/* ---------------------------------------
   Commands + Anti-Spam
---------------------------------------- */
function onKeyDownCommand(context) {
  const now = Date.now();
  const cfg = commandKeys.get(context) || defaultCommandSettings();
  if (!midiOut) return;

  const lastTap = lastTapByContext.get(context) || 0;
  if (now - lastTap < TAP_DEBOUNCE_MS) {
    w(
      `[CMD] Debounced tap (context) ch=${cfg.channel + 1} cc=${cfg.controller}`
    );
    return;
  }
  lastTapByContext.set(context, now);

  const keyId = keyIdFromCfg(cfg);

  const nextAllowed = nextAllowedTsByKey.get(keyId) || 0;
  if (now < nextAllowed) {
    w(`[CMD] Cooldown block ch=${cfg.channel + 1} cc=${cfg.controller}`);
    return;
  }

  if (cfg.mode === "momentary") {
    if (awaitingAckByKey.get(keyId)) {
      w(
        `[CMD] Blocked resend (awaiting ack) ch=${cfg.channel + 1} cc=${
          cfg.controller
        }`
      );
      return;
    }
    midiOut.send("cc", {
      controller: cfg.controller,
      value: 127,
      channel: cfg.channel,
    });
    lastTxByKey.set(keyId, { ts: now, val: 127 });
    awaitingAckByKey.set(keyId, true);
    startAckTimer(keyId, cfg);
    nextAllowedTsByKey.set(keyId, now + KEY_COOLDOWN_MS);
    w(
      `[CMD] Send ch=${cfg.channel + 1} cc=${
        cfg.controller
      } val=127 mode=momentary`
    );
    return;
  }

  const nextActive = !cfg.active;
  commandKeys.set(context, { ...cfg, active: nextActive });
  midiOut.send("cc", {
    controller: cfg.controller,
    value: nextActive ? 127 : 0,
    channel: cfg.channel,
  });
  lastTxByKey.set(keyId, { ts: now, val: nextActive ? 127 : 0 });
  setState(context, nextActive ? 1 : 0);
  nextAllowedTsByKey.set(keyId, now + KEY_COOLDOWN_MS);
  w(
    `[CMD] Send ch=${cfg.channel + 1} cc=${cfg.controller} val=${
      nextActive ? 127 : 0
    } mode=toggle`
  );
}

function onKeyUpCommand(context) {
  // Hold-Modus entfernt: kein explizites "Off" mehr beim Loslassen.
  // Momentary vertraut auf Host-Feedback; Toggle macht auf keyUp nichts.
  return;
}

function startAckTimer(keyId, cfg) {
  clearAckTimer(keyId);
  const t = setTimeout(() => {
    awaitingAckByKey.delete(keyId);
    ackTimerByKey.delete(keyId);
    w(
      `[CMD] Ack timeout ch=${cfg.channel + 1} cc=${
        cfg.controller
      } – allowing next tap`
    );
  }, ACK_TIMEOUT_MS);
  ackTimerByKey.set(keyId, t);
}
function clearAckTimer(keyId) {
  const t = ackTimerByKey.get(keyId);
  if (t) {
    clearTimeout(t);
    ackTimerByKey.delete(keyId);
  }
}

/* ---------------------------------------
   Feedback aus Cubase → Level-Modus
   Echo akzeptieren, UI erst nach Settle anwenden
---------------------------------------- */
function handleCommandFeedback(msg) {
  const keyId = `${msg.channel}:${msg.controller}`;
  const val = msg.value | 0;
  const now = Date.now();

  // Alle passenden Kontexte einsammeln
  const matches = [];
  for (const [ctx, cfg] of commandKeys.entries()) {
    if (msg.channel === cfg.channel && msg.controller === cfg.controller) {
      matches.push([ctx, cfg]);
    }
  }
  if (!matches.length) return;

  // ACK beenden, sobald irgendwas zum Key kommt
  if (awaitingAckByKey.get(keyId)) {
    clearAckTimer(keyId);
    awaitingAckByKey.delete(keyId);
  }

  // Echo-Hinweis (nicht abbrechen!)
  const tx = lastTxByKey.get(keyId);
  if (tx && now - tx.ts <= TX_GUARD_MS && tx.val === val) {
    w(
      `[CMD] Echo within guard (accepting for UI) ch=${msg.channel + 1} cc=${
        msg.controller
      } val=${val}`
    );
  }

  const active = val >= 64;

  // Globaler Fallback-Cache
  lastLevelByKey.set(keyId, { ts: now, state: active });

  // Per-Track-Cache
  const t = (lastTrackName || "").toLowerCase();
  if (!cmdLevelByTrack.has(t)) cmdLevelByTrack.set(t, new Map());
  cmdLevelByTrack.get(t).set(keyId, { ts: now, state: active });

  // Settle planen/anwenden
  scheduleFeedbackApply(keyId, active, now);

  w(
    `[CMD] Level rx ch=${msg.channel + 1} cc=${msg.controller} -> state=${
      active ? 1 : 0
    } (settle ${FEEDBACK_SETTLE_MS}ms)`
  );
}

function scheduleFeedbackApply(keyId, active, tsNow) {
  pendingActiveByKey.set(keyId, { active, ts: tsNow });
  const prev = feedbackTimerByKey.get(keyId);
  if (prev) clearTimeout(prev);

  const t = setTimeout(() => {
    feedbackTimerByKey.delete(keyId);
    const pending = pendingActiveByKey.get(keyId);
    if (!pending) return;
    const curActive = pending.active;

    // aktuelle Matches ermitteln (Tasten könnten verschwunden sein)
    for (const [ctx, cfg] of commandKeys.entries()) {
      if (keyIdFromCfg(cfg) !== keyId) continue;
      const changed = cfg.active !== curActive;
      if (changed) {
        commandKeys.set(ctx, { ...cfg, active: curActive });
        setState(ctx, curActive ? 1 : 0);
        w(
          `[CMD] Level (settled) ch=${cfg.channel + 1} cc=${
            cfg.controller
          } -> state=${curActive ? 1 : 0}`
        );
      } else if (FORCE_SETSTATE_ON_SAME) {
        setState(ctx, curActive ? 1 : 0);
        w(
          `[CMD] UI resync (same state, settled) ch=${cfg.channel + 1} cc=${
            cfg.controller
          } state=${curActive ? 1 : 0}`
        );
      }
    }
  }, FEEDBACK_SETTLE_MS);

  feedbackTimerByKey.set(keyId, t);
}

/* ---------------------------------------
   Trackname (SysEx) & Farbe (CC20/21/22)
---------------------------------------- */
let lastTrackName = "";
let debounceTimer = null;

function onSysexFromCubase(bytes) {
  if (!bytes || bytes.length < 2) return;
  if (bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return;
  const trackName = String.fromCharCode(...bytes.slice(1, -1)).trim();
  w(`[DBG] [TRACK] Name (SysEx): "${trackName}"`);
  if (!trackName || trackName.toLowerCase() === lastTrackName.toLowerCase())
    return;

  lastTrackName = trackName;

  for (const [, st] of deviceState) st.profilePending = true;

  if (anyCmdVisible()) {
    clearAllAcksAndCooldowns();
    // CMD-Seite ist sichtbar -> nach Trackwechsel Resync anstoßen
    for (const [dev, vis] of visibility.entries()) {
      if ((vis.cmd || 0) > 0) scheduleDeviceCmdResync(dev, "trackChange");
    }
  } else {
    v("[CMD] Skip clearing ACKs: no visible CMD page");
  }

  if (CMD_CACHE_MODE === "clearOnTrackChange") {
    lastLevelByKey.clear();
    w("[CMD] Cleared global CMD cache (clearOnTrackChange)");
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => applyProfileForTrack(trackName), 120);
}

function clearAllAcksAndCooldowns() {
  awaitingAckByKey.forEach((_, keyId) => clearAckTimer(keyId));
  awaitingAckByKey.clear();
  nextAllowedTsByKey.clear();
  w("[CMD] Cleared all pending ACKs (track/context change)");
}

// Farbe via CC#20 (R), #21 (G), #22 (B) [0..127] – nur auf Kanal 15
const colorState = { r: null, g: null, b: null, timer: null };
function onCcFromCubaseColor({ controller, value }) {
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

      if (!isArtVisible(deviceId)) {
        w(`[COLOR] cache only (art hidden) device=${deviceId}`);
        continue;
      }
      if (st.profilePending) {
        w(`[COLOR] profile pending -> skip render on device=${deviceId}`);
        continue;
      }
      w(`[COLOR] apply & render device=${deviceId}`);
      renderProfileForDevice(deviceId);
    }
  }, 20);
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

function applyProfileForTrack(trackName) {
  if (!/\bKS\b$/i.test(trackName.trim())) {
    w(`⏭ Überspringe Spur ohne 'KS' am Ende: "${trackName}"`);
    for (const [, st] of deviceState) st.profilePending = false;
    return;
  }

  const key = Object.keys(profiles).find((k) =>
    new RegExp(k, "i").test(trackName)
  );
  const profile = key ? profiles[key] || {} : {};
  const arts = (profile.articulations || []).map((a) => ({
    name: a.name || "",
    note: a.note,
  }));
  const title = extractInstrumentTitle(trackName);

  for (const [deviceId, st] of deviceState) {
    st.profileKey = key || null;
    st.articulations = arts;
    st.instrumentTitle = title;
    st.selectedArtIdx = null;
    st.profilePending = false;

    w(
      `[PROFILE] set for device=${deviceId} key=${key || "(none)"} arts=${
        arts.length
      } title="${title}"`
    );

    if (isArtVisible(deviceId)) {
      w(`[RENDER] profile render (art visible) device=${deviceId}`);
      renderProfileForDevice(deviceId);
    } else {
      w(`[RENDER] profile cached (art hidden) device=${deviceId}`);
    }
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
      if (hasArt(art))
        tasks.push(
          renderArtKey(context, art, st.color, st.selectedArtIdx === idx)
        );
      else tasks.push(renderEmptyKey(context));
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
const HEADER_H = 8;
const MAIN_FONT_SIZE = 16;
const BADGE_FONT_SIZE = 10;
const TITLE_FONT_SIZE = 18;
const TITLE_LINE_HEIGHT = 1.22;

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
  const s = [r, g, b].map((v) => v / 255);
  const l = s.map((v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
}
function contrastOn(hexColor) {
  return relLuminance(hexToRgb(hexColor)) > 0.53 ? "#111111" : "#FFFFFF";
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

/* ---------------------------------------
   Draw & Text Helpers
---------------------------------------- */
function setImage(context, base64) {
  safeSendToSD({
    event: "setImage",
    context,
    payload: { image: base64, target: 0 },
  });
}
function setState(context, stateIndex) {
  safeSendToSD({
    event: "setState",
    context,
    payload: { state: stateIndex | 0 },
  });
}
function safeSendToSD(obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) {
    w(`[ERR] ws send: ${e && e.message}`);
  }
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
  const idx = ((n % 12) + 12) % 12;
  const name = names[idx];
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
   Utils & Cleanup
---------------------------------------- */
function clamp(n, a, b) {
  n = Number.isFinite(n) ? n : a;
  return Math.max(a, Math.min(b, n));
}
function safeJson(x) {
  try {
    return typeof x === "string" ? JSON.parse(x) : JSON.parse(String(x));
  } catch {
    return null;
  }
}

process.on("exit", () => {
  try {
    midiOut && midiOut.close();
  } catch {}
  try {
    midiIn && midiIn.close();
  } catch {}
});
