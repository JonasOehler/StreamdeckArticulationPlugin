// Cubase MIDI Remote Script – Jonas Oehler (StreamDeckXL)
// Hört auf Track-Selection, sendet Trackname (SysEx) + Spurfarbe (CC20/21/22)
// mit robuster 0..1 / 0..255 Erkennung + Logging.

var midiremote_api = require("midiremote_api_v1");

// ---------------------------------------------------------------------
// Device/Ports
// ---------------------------------------------------------------------
var deviceDriver = midiremote_api.makeDeviceDriver(
  "Elgato",
  "StreamDeckXL",
  "JonasOehler"
);

var midiInput = deviceDriver.mPorts.makeMidiInput("NodeToCubase");
var midiOutput = deviceDriver.mPorts.makeMidiOutput("CubaseToNode");

deviceDriver
  .makeDetectionUnit()
  .detectPortPair(midiInput, midiOutput)
  .expectInputNameEquals("NodeToCubase")
  .expectOutputNameEquals("CubaseToNode");

// ---------------------------------------------------------------------
// Page & Host Access
// ---------------------------------------------------------------------
var page = deviceDriver.mMapping.makePage("SinglePage");
var hostSelectedTrackChannel = page.mHostAccess.mTrackSelection.mMixerChannel;

// ---------------------------------------------------------------------
// Logging Helpers
// (In Cubase: Studio > MIDI Remote-Manager > "Script Console" öffnen)
// ---------------------------------------------------------------------
function log(msg) {
  const s = String(msg);
  try {
    console.log(s);
  } catch (_) {}
  try {
    const g = /** @type {any} */ (globalThis);
    if (g && typeof g.trace === "function") g.trace(s);
  } catch (_) {}
}

// ---------------------------------------------------------------------
// Track-Name & -Farbe anhören (kompatibel zu bestehendem Plugin)
// ---------------------------------------------------------------------

// 1) Custom-Variable, an die wir den selektierten Kanal "anhängen"
var trackMeta = deviceDriver.mSurface.makeCustomValueVariable("trackMeta");

// 2) Bindung auf den SELECTED-State des aktuell gewählten Mixer-Kanals.
//    Das triggert die Title/Color-Callbacks bei Trackwechsel zuverlässig.
page.makeValueBinding(trackMeta, hostSelectedTrackChannel.mValue.mSelected);

// 3) Trackname -> SysEx (unverändert), damit dein Plugin es wie gehabt liest
trackMeta.mOnTitleChange = function (
  activeDevice,
  objectTitle /* Trackname */,
  valueTitle
) {
  var bytes = [];
  for (var i = 0; i < objectTitle.length; i++) {
    // 7-bit absichern
    bytes.push(objectTitle.charCodeAt(i) & 0x7f);
  }
  var sysex = [0xf0].concat(bytes, [0xf7]);
  midiOutput.sendMidi(activeDevice, sysex);
  log(
    '[REMOTE] Trackname -> SysEx: "' +
      objectTitle +
      '" (' +
      bytes.length +
      " bytes)"
  );
};

// 4) Spurfarbe -> drei CCs (R/G/B), skaliert auf 0..127
//    Erkennt automatisch 0..1 (Float) oder 0..255 (Int)
trackMeta.mOnColorChange = function (
  activeDevice,
  r,
  g,
  b,
  a,
  isActive,
  activeMapping
) {
  // Rohwerte loggen
  log(
    "[REMOTE] Color raw: r=" +
      r +
      " g=" +
      g +
      " b=" +
      b +
      " a=" +
      a +
      " active=" +
      isActive
  );

  if (r == null || g == null || b == null) {
    log("[REMOTE] Color missing -> übersprungen");
    return;
  }

  // Skala erkennen
  var looksLikeUnit = r <= 1 && g <= 1 && b <= 1;
  var r7 = looksLikeUnit ? Math.round(r * 127) : Math.round((r / 255) * 127);
  var g7 = looksLikeUnit ? Math.round(g * 127) : Math.round((g / 255) * 127);
  var b7 = looksLikeUnit ? Math.round(b * 127) : Math.round((b / 255) * 127);

  // clamp + 7-bit
  r7 = Math.max(0, Math.min(127, r7)) & 0x7f;
  g7 = Math.max(0, Math.min(127, g7)) & 0x7f;
  b7 = Math.max(0, Math.min(127, b7)) & 0x7f;

  var CC_R = 20,
    CC_G = 21,
    CC_B = 22;
  var channel = 0;

  midiOutput.sendMidi(activeDevice, [0xb0 | (channel & 0x0f), CC_R & 0x7f, r7]);
  midiOutput.sendMidi(activeDevice, [0xb0 | (channel & 0x0f), CC_G & 0x7f, g7]);
  midiOutput.sendMidi(activeDevice, [0xb0 | (channel & 0x0f), CC_B & 0x7f, b7]);

  log(
    "[REMOTE] Color sent as CC -> R:" +
      r7 +
      " G:" +
      g7 +
      " B:" +
      b7 +
      " (scale=" +
      (looksLikeUnit ? "0..1" : "0..255") +
      ")"
  );
};
