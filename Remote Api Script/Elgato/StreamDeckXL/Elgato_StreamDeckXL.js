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

module.exports = deviceDriver;
