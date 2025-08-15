/* global window, document */
let websocket = null;
let uuid = null;
let context = null;
let registerEvent = null;

window.connectElgatoStreamDeckSocket = (
  inPort,
  inUUID,
  inEvent,
  inInfo,
  inActionInfo
) => {
  uuid = inUUID;
  registerEvent = inEvent;

  const ai = JSON.parse(inActionInfo);
  context = ai.context;

  websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);
  websocket.onopen = function () {
    websocket.send(JSON.stringify({ event: registerEvent, uuid }));
    // kleiner Delay hilft gegen "wrong context" Warnungen
    setTimeout(
      () => websocket.send(JSON.stringify({ event: "getSettings", context })),
      100
    );
  };

  websocket.onmessage = function (evt) {
    const msg = JSON.parse(evt.data);
    if (msg.event === "didReceiveSettings") {
      const s = msg.payload.settings || {};
      document.getElementById("title").value = s.title ?? "";
      document.getElementById("note").value = Number.isInteger(s.note)
        ? s.note
        : "";
      document.getElementById("family").value = s.family ?? "";
    }
  };
};

function save() {
  const title = document.getElementById("title").value || "";
  const note = Number(document.getElementById("note").value);
  const family = document.getElementById("family").value || "";

  const payload = { title, family };
  if (Number.isFinite(note))
    payload.note = Math.max(0, Math.min(127, Math.round(note)));

  websocket &&
    websocket.send(
      JSON.stringify({
        event: "setSettings",
        context,
        payload,
      })
    );
}

document.getElementById("save").addEventListener("click", save);
