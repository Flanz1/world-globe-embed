/** Sends this slot's pins to a same-origin preview iframe, so the preview shows what the embed will (the pins aren't deployed yet). */
import { mapsOfSlot } from "../shared/pinmaps.ts";
import { pinsJson, type PinFeature } from "../shared/pins.ts";
import { SITE } from "./dom.ts";
import { pinEntries } from "./pins.ts";
import { pinMaps } from "./pinmaps.ts";

/**
 * `show` is what ?pins= would say: pin map ids, comma separated ("" shows none).
 * The pins are the ones in the admin page's memory, saved or still being saved.
 */
export function sendPins(frame: HTMLIFrameElement, slot: string, show: string): void {
  const pins = pinEntries()
    .map((e) => e.feature)
    .filter((f): f is PinFeature => !!f && f.properties.slot === slot);
  const file = JSON.parse(pinsJson(pins, mapsOfSlot(pinMaps(), slot), pinMaps().legends?.[slot]));
  frame.contentWindow?.postMessage({ type: "wge-pins", file, show }, SITE.origin);
}

/** Sends the pins again whenever the preview says its viewer has started listening (it does, once it's up). */
export function keepPinsSent(frame: HTMLIFrameElement, slot: string, show: () => string): void {
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.origin === location.origin && e.source === frame.contentWindow && e.data?.type === "wge-pins-wanted") sendPins(frame, slot, show());
  });
}
