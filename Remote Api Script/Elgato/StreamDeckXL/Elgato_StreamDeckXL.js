// Cubase MIDI Remote Script – Jonas Oehler (StreamDeckXL)
// Hört auf Track-Selection, sendet Trackname (SysEx) + Spurfarbe (CC20/21/22)
// Kanal 15 (zero-based 14) für Farb-CCs, robustes Logging.

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
// Logging Helper (erscheint in MIDI-Remote „Script Console“)
// ---------------------------------------------------------------------
function log(msg) {
  var s = String(msg);
  try {
    console.log(s);
  } catch (_) {}
  try {
    var g = /** @type {any} */ (globalThis);
    if (g && typeof g.trace === "function") g.trace(s);
  } catch (_) {}
}

// ---------------------------------------------------------------------
// Track-Name & -Farbe anhören (kompatibel zum Plugin)
// ---------------------------------------------------------------------
var trackMeta = deviceDriver.mSurface.makeCustomValueVariable("trackMeta");

// Bei Trackwechsel feuern
page.makeValueBinding(trackMeta, hostSelectedTrackChannel.mValue.mSelected);

// Trackname -> SysEx (unverändert)
trackMeta.mOnTitleChange = function (
  activeDevice,
  objectTitle /* Trackname */,
  valueTitle
) {
  var bytes = [];
  for (var i = 0; i < objectTitle.length; i++)
    bytes.push(objectTitle.charCodeAt(i) & 0x7f);
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

// Spurfarbe -> CC20/21/22 auf Kanal 15 (zero-based 14)
var CC_R = 20,
  CC_G = 21,
  CC_B = 22;
var COLOR_CHANNEL = 14; // 0..15 => Kanal 15

trackMeta.mOnColorChange = function (activeDevice, r, g, b, a, isActive) {
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

  // 0..1 (float) oder 0..255 (int) erkennen
  var unit = r <= 1 && g <= 1 && b <= 1;
  var r7 =
    Math.max(0, Math.min(127, Math.round((unit ? r : r / 255) * 127))) & 0x7f;
  var g7 =
    Math.max(0, Math.min(127, Math.round((unit ? g : g / 255) * 127))) & 0x7f;
  var b7 =
    Math.max(0, Math.min(127, Math.round((unit ? b : b / 255) * 127))) & 0x7f;

  midiOutput.sendMidi(activeDevice, [
    0xb0 | (COLOR_CHANNEL & 0x0f),
    CC_R & 0x7f,
    r7,
  ]);
  midiOutput.sendMidi(activeDevice, [
    0xb0 | (COLOR_CHANNEL & 0x0f),
    CC_G & 0x7f,
    g7,
  ]);
  midiOutput.sendMidi(activeDevice, [
    0xb0 | (COLOR_CHANNEL & 0x0f),
    CC_B & 0x7f,
    b7,
  ]);

  log(
    "[REMOTE] Color sent CC(ch=" +
      (COLOR_CHANNEL + 1) +
      ") -> R:" +
      r7 +
      " G:" +
      g7 +
      " B:" +
      b7 +
      " (scale=" +
      (unit ? "0..1" : "0..255") +
      ")"
  );
};
