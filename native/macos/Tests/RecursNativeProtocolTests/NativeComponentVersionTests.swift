import RecursNativeProtocol
import Testing

@Test func generatedNativeComponentVersionIsCanonical() {
  #expect(!NativeComponentVersion.current.isEmpty)
  #expect(NativeComponentVersion.current.utf8.count <= 256)
}
