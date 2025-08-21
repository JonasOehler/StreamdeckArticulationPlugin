"use strict";

// Cubase MIDI Remote Script – Jonas Oehler (StreamDeckXL)
// - Trackname -> SysEx an Plugin
// - Spurfarbe -> CC20/21/22 auf Kanal 15 (zero-based 14) an Plugin
// - 32 neutrale CC-Slots (CC 10..41) auf Kanal 14 (zero-based 13)
//   -> KEINE hart codierten Commands; alles per Mapping-Assistent lernbar.
// - Feedback: Jeder Slot hat MIDI-OUTPUT (0/127) zurück ans Plugin.

var midiremote_api = require("midiremote_api_v1");

// -------------------------------------------------
// Device/Ports
// -------------------------------------------------
var deviceDriver = midiremote_api.makeDeviceDriver(
  "Elgato",
  "StreamDeckXL",
  "JonasOehler"
);

var midiInput = deviceDriver.mPorts.makeMidiInput("NodeToCubase"); // vom Plugin -> Cubase
var midiOutput = deviceDriver.mPorts.makeMidiOutput("CubaseToNode"); // von Cubase -> Plugin

deviceDriver
  .makeDetectionUnit()
  .detectPortPair(midiInput, midiOutput)
  .expectInputNameEquals("NodeToCubase")
  .expectOutputNameEquals("CubaseToNode");

// -------------------------------------------------
// Page & Host
// -------------------------------------------------
var page = deviceDriver.mMapping.makePage("SinglePage");
var host = page.mHostAccess;
var sel = host.mTrackSelection.mMixerChannel;

// -------------------------------------------------
// Logging
// -------------------------------------------------
function log(s) {
  try {
    console.log(String(s));
  } catch (_) {}
  try {
    var g = globalThis;
    if (g && g.trace) g.trace(String(s));
  } catch (_) {}
}

// -------------------------------------------------
// Trackname + Farbe -> Plugin
// -------------------------------------------------
var COLOR_CC_CHANNEL = 14; // 0..15 => "Kanal 15" in UI
var CC_R = 20,
  CC_G = 21,
  CC_B = 22;

var trackMeta = deviceDriver.mSurface.makeCustomValueVariable("trackMeta");

// feuert bei Trackwechsel zuverlässig
page.makeValueBinding(trackMeta, sel.mValue.mSelected);

// Trackname als SysEx
trackMeta.mOnTitleChange = function (
  activeDevice,
  objectTitle /* Trackname */
) {
  var bytes = [];
  for (var i = 0; i < objectTitle.length; i++)
    bytes.push(objectTitle.charCodeAt(i) & 0x7f);
  midiOutput.sendMidi(activeDevice, [0xf0].concat(bytes, [0xf7]));
  log('[REMOTE] Trackname -> SysEx: "' + objectTitle + '"');
};

// Spurfarbe als 3x CC (0..127)
trackMeta.mOnColorChange = function (activeDevice, r, g, b /*, a, isActive */) {
  if (r == null || g == null || b == null) return;
  var unit = r <= 1 && g <= 1 && b <= 1; // 0..1 oder 0..255
  var r7 = (unit ? Math.round(r * 127) : Math.round((r / 255) * 127)) & 0x7f;
  var g7 = (unit ? Math.round(g * 127) : Math.round((g / 255) * 127)) & 0x7f;
  var b7 = (unit ? Math.round(b * 127) : Math.round((b / 255) * 127)) & 0x7f;

  midiOutput.sendMidi(activeDevice, [
    0xb0 | (COLOR_CC_CHANNEL & 0x0f),
    CC_R & 0x7f,
    r7,
  ]);
  midiOutput.sendMidi(activeDevice, [
    0xb0 | (COLOR_CC_CHANNEL & 0x0f),
    CC_G & 0x7f,
    g7,
  ]);
  midiOutput.sendMidi(activeDevice, [
    0xb0 | (COLOR_CC_CHANNEL & 0x0f),
    CC_B & 0x7f,
    b7,
  ]);

  log(
    "[REMOTE] Color -> CC(ch=" +
      (COLOR_CC_CHANNEL + 1) +
      ") R:" +
      r7 +
      " G:" +
      g7 +
      " B:" +
      b7
  );
};

// -------------------------------------------------
// 32 neutrale CC-Slots (alles per Mapping-Assistent)
// -------------------------------------------------
var CONTROL_CH = 13; // 0..15 => "Kanal 14"
var CC_FIRST = 10,
  CC_LAST = 41; // inkl. -> 32 Stück
var COLS = 8;

// Ein Button = ein Slot (CC auf CONTROL_CH) – mit Input+Output für Feedback
function makeCcButton(x, y, w, h, cc) {
  var btn = deviceDriver.mSurface.makeButton(x, y, w, h);

  var ccBind = btn.mSurfaceValue.mMidiBinding
    .setInputPort(midiInput) // vom Plugin kommend
    .setOutputPort(midiOutput) // Feedback zurück ans Plugin
    .setIsConsuming(true) // verhindert Durchreichen ins Projekt
    .bindToControlChange(CONTROL_CH, cc);

  // Host 0..1 ↔ MIDI 0..127 (saubere 0/127 Rückmeldung)
  ccBind.setValueRange(0, 127);

  // Optional: Log
  btn.mSurfaceValue.mOnProcessValueChange = function (_, val) {
    if (val > 0) log("[REMOTE] CC " + cc + " pressed");
  };

  // KEINE Host/Command-Bindings hier – das macht der Mapping-Assistent!
  return btn;
}

// Layout 8x4 (CC 10..41)
var idx = 0;
for (var cc = CC_FIRST; cc <= CC_LAST; cc++) {
  var x = idx % COLS;
  var y = Math.floor(idx / COLS);
  makeCcButton(x, y, 1, 1, cc);
  idx++;
}

module.exports = deviceDriver;
