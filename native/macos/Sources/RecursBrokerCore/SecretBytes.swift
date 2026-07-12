import Foundation

package final class SecretBytes: CustomStringConvertible, CustomDebugStringConvertible {
  private var storage: Data

  package init(_ bytes: consuming Data) {
    storage = bytes
  }

  deinit {
    erase()
  }

  package func withUnsafeBytes<Result>(
    _ body: (UnsafeRawBufferPointer) throws -> Result
  ) rethrows -> Result {
    try storage.withUnsafeBytes(body)
  }

  package func erase() {
    guard !storage.isEmpty else {
      storage.removeAll(keepingCapacity: false)
      return
    }

    _ = storage.withUnsafeMutableBytes { bytes in
      bytes.initializeMemory(as: UInt8.self, repeating: 0)
    }
    storage.removeAll(keepingCapacity: false)
  }

  package var description: String {
    "<redacted>"
  }

  package var debugDescription: String {
    "<redacted>"
  }
}
