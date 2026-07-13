import { Buffer } from "node:buffer";
import { Socket } from "node:net";
import { TextDecoder } from "node:util";

const FRAME_MAGIC = 0x52_43_55_52;
const PROTOCOL_VERSION = 1;
const HEADER_BYTES = 16;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const HELLO = 1;
const HELLO_RESULT = 2;
const HEALTH = 3;
const HEALTH_RESULT = 4;
const CANCEL = 5;
const SAFE_FAILURE = 255;

const socket = new Socket({
  fd: 3,
  readable: true,
  writable: true,
  allowHalfOpen: false,
});
let buffered = Buffer.alloc(0);
let handshaken = false;
let greatestRequestId = 0;

socket.on("error", () => {
  // The fixture has no diagnostic channel by design.
});

socket.on("data", (chunk) => {
  try {
    buffered = Buffer.concat([buffered, chunk], buffered.length + chunk.length);
    if (buffered.length > HEADER_BYTES + MAX_PAYLOAD_BYTES) {
      throw new Error();
    }
    while (buffered.length >= HEADER_BYTES) {
      const magic = buffered.readUInt32BE(0);
      const version = buffered.readUInt16BE(4);
      const type = buffered.readUInt16BE(6);
      const payloadLength = buffered.readUInt32BE(8);
      const requestId = buffered.readUInt32BE(12);
      if (
        magic !== FRAME_MAGIC ||
        version !== PROTOCOL_VERSION ||
        payloadLength > MAX_PAYLOAD_BYTES ||
        requestId === 0
      ) {
        throw new Error();
      }
      const frameLength = HEADER_BYTES + payloadLength;
      if (buffered.length < frameLength) {
        return;
      }
      const payload = Buffer.from(buffered.subarray(HEADER_BYTES, frameLength));
      buffered = Buffer.from(buffered.subarray(frameLength));
      if (requestId <= greatestRequestId) {
        throw new Error();
      }
      greatestRequestId = requestId;
      handleFrame(type, requestId, payload);
    }
  } catch {
    socket.destroy();
  }
});

function handleFrame(type, requestId, payload) {
  if (type === HELLO && !handshaken) {
    const fields = decodeFields(payload);
    if (fields.length !== 2 || fields[0].tag !== 1 || fields[1].tag !== 2) {
      throw new Error();
    }
    new TextDecoder("utf-8", { fatal: true }).decode(fields[0].value);
    if (fields[1].value.length !== 32) {
      throw new Error();
    }
    handshaken = true;
    socket.write(encodeFrame(HELLO_RESULT, requestId, encodeFields([
      { tag: 1, value: text("0.1.0") },
      { tag: 2, value: text("0.1.0") },
      { tag: 3, value: fields[1].value },
      { tag: 4, value: Buffer.from([1]) },
      { tag: 5, value: Buffer.from([1]) },
      { tag: 6, value: text("14.4") },
    ])));
    return;
  }
  if (type === HEALTH && handshaken) {
    if (payload.length !== 2 || payload.readUInt16BE(0) !== 0) {
      throw new Error();
    }
    socket.write(encodeFrame(HEALTH_RESULT, requestId, encodeFields([
      { tag: 1, value: uint16(1) },
      { tag: 2, value: Buffer.from([1]) },
    ])));
    return;
  }
  if (type === CANCEL && handshaken) {
    return;
  }
  socket.write(encodeFrame(SAFE_FAILURE, requestId, encodeFields([
    { tag: 1, value: uint16(9) },
  ])));
}

function decodeFields(payload) {
  if (payload.length < 2) {
    throw new Error();
  }
  const count = payload.readUInt16BE(0);
  const fields = [];
  let offset = 2;
  let previousTag = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 6 > payload.length) {
      throw new Error();
    }
    const tag = payload.readUInt16BE(offset);
    const length = payload.readUInt32BE(offset + 2);
    offset += 6;
    if (tag <= previousTag || offset + length > payload.length) {
      throw new Error();
    }
    fields.push({ tag, value: Buffer.from(payload.subarray(offset, offset + length)) });
    previousTag = tag;
    offset += length;
  }
  if (offset !== payload.length) {
    throw new Error();
  }
  return fields;
}

function encodeFrame(type, requestId, payload) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(FRAME_MAGIC, 0);
  header.writeUInt16BE(PROTOCOL_VERSION, 4);
  header.writeUInt16BE(type, 6);
  header.writeUInt32BE(payload.length, 8);
  header.writeUInt32BE(requestId, 12);
  return Buffer.concat([header, payload], HEADER_BYTES + payload.length);
}

function encodeFields(fields) {
  const count = uint16(fields.length);
  const encoded = [count];
  for (const field of fields) {
    const header = Buffer.alloc(6);
    header.writeUInt16BE(field.tag, 0);
    header.writeUInt32BE(field.value.length, 2);
    encoded.push(header, field.value);
  }
  return Buffer.concat(encoded);
}

function uint16(value) {
  const encoded = Buffer.alloc(2);
  encoded.writeUInt16BE(value, 0);
  return encoded;
}

function text(value) {
  return Buffer.from(value, "utf8");
}
