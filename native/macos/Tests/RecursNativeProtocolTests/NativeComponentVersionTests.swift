import RecursNativeProtocol
import Testing

@Test func generatedNativeComponentVersionIsCanonical() {
  #expect(NativeComponentVersion.current == "0.2.0")
  #expect(!NativeComponentVersion.current.isEmpty)
  #expect(NativeComponentVersion.current.utf8.count <= 256)
}
