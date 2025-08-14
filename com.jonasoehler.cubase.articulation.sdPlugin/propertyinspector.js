/* global window, document */
let websocket = null;
let uuid = null;
let action = null;
let context = null;

window.connectElgatoStreamDeckSocket = (
  inPort,
  inUUID,
  inEvent,
  inInfo,
  inActionInfo
) => {
  uuid = inUUID;
  action = JSON.parse(inActionInfo).action;
  context = JSON.parse(inActionInfo).context;

  websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);
  websocket.onopen = function () {
    websocket.send(JSON.stringify({ event: inEvent, uuid }));
    // Settings laden
    websocket.send(JSON.stringify({ event: "getSettings", context })); // :contentReference[oaicite:10]{index=10}
  };

  websocket.onmessage = function (evt) {
    const msg = JSON.parse(evt.data);
    if (msg.event === "didReceiveSettings") {
      const s = msg.payload.settings || {};
      document.getElementById("title").value = s.title || "";
    }
  };
};

function save() {
  const title = document.getElementById("title").value || "";
  websocket &&
    websocket.send(
      JSON.stringify({
        event: "setSettings", // :contentReference[oaicite:11]{index=11}
        context,
        payload: { title },
      })
    );
}

document.getElementById("save").addEventListener("click", save);
