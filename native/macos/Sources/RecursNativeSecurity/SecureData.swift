import Foundation

func eraseData(_ data: inout Data) {
  guard !data.isEmpty else {
    data.removeAll(keepingCapacity: false)
    return
  }
  _ = data.withUnsafeMutableBytes { bytes in
    bytes.initializeMemory(as: UInt8.self, repeating: 0)
  }
  data.removeAll(keepingCapacity: false)
}
