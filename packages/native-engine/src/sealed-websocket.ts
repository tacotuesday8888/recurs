const UNAVAILABLE_MESSAGE =
  "Public WebSocket transport is unavailable in the sealed native engine";

export default class SealedWebSocket {
  constructor() {
    throw new Error(UNAVAILABLE_MESSAGE);
  }
}
