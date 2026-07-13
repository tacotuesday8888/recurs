import Foundation
import RecursBrokerXPC
import Testing

@Suite
struct BrokerCredentialLifecycleCodecTests {
  private let connectionID = UUID(
    uuidString: "11111111-2222-4333-8444-555555555555"
  )!
  private let operationID = UUID(
    uuidString: "66666666-7777-4888-8999-aaaaaaaaaaaa"
  )!
  private let attemptID = UUID(
    uuidString: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
  )!

  @Test
  func stageRequestUsesTheFrozenFrameAndRoundTrips() throws {
    let request = try BrokerCredentialStageRequest(
      requestID: 1,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 9,
      providerBinding: try builtInStageBinding()
    )

    let encoded = try request.encode()

    #expect(encoded.count == 77)
    #expect(
      Array(encoded.prefix(12))
        == [
          0x52, 0x43, 0x43, 0x4c,
          0x00, 0x01,
          0x00, 0x01,
          0x00, 0x00, 0x00, 0x41,
        ]
    )
    #expect(Array(encoded[12..<20]) == Array(uint64(1)))
    #expect(Array(encoded[20..<36]) == Array(uuidBytes(connectionID)))
    #expect(Array(encoded[36..<52]) == Array(uuidBytes(operationID)))
    #expect(Array(encoded[52..<60]) == Array(uint64(9)))
    #expect(encoded[60] == 13)
    #expect(Data(encoded[61..<74]) == Data("openai_api_v1".utf8))
    #expect(Array(encoded[74..<76]) == [0, 0])
    #expect(encoded[76] == 0)
    #expect(try BrokerCredentialStageRequest.decode(encoded) == request)
  }

  @Test
  func stageBindingDescriptorRoundTripsBuiltInAndBothCustomCatalogs() throws {
    let descriptors = [
      try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "openai_api_v1"
      ),
      try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "custom_openai_compatible_v1",
        customBaseURL: "https://api.example.com/v1",
        customModelCatalogBehavior: .modelsRoute
      ),
      try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "custom_openai_compatible_v1",
        customBaseURL: "https://catalogless.example.com/base",
        customModelCatalogBehavior: .unavailable
      ),
    ]

    for (offset, descriptor) in descriptors.enumerated() {
      let request = try BrokerCredentialStageRequest(
        requestID: UInt64(offset + 20),
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 9,
        providerBinding: descriptor
      )
      let encoded = try request.encode()
      #expect(encoded.last == UInt8(offset))
      #expect(try BrokerCredentialStageRequest.decode(encoded) == request)
    }
  }

  @Test
  func stageBindingDescriptorEnforcesExactASCIIAndByteBounds() throws {
    let minimum = try BrokerCredentialStageRequest(
      requestID: 22,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0,
      providerBinding: try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "p",
        customBaseURL: "b",
        customModelCatalogBehavior: .unavailable
      )
    )
    #expect(try BrokerCredentialStageRequest.decode(minimum.encode()) == minimum)

    let maximumProfile = String(repeating: "p", count: 64)
    let maximumBase = String(repeating: "b", count: 2_048)
    let maximum = try BrokerCredentialStageRequest(
      requestID: 23,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0,
      providerBinding: try BrokerCredentialStageBindingDescriptor(
        activationProfileID: maximumProfile,
        customBaseURL: maximumBase,
        customModelCatalogBehavior: .modelsRoute
      )
    )
    let maximumFrame = try maximum.encode()
    #expect(maximumFrame.count == 2_176)
    #expect(try BrokerCredentialStageRequest.decode(maximumFrame) == maximum)

    let invalidProfiles = [
      "",
      String(repeating: "p", count: 65),
      "openai api v1",
      "openai\u{7f}api",
      "openai\napi",
      "opénai_api_v1",
    ]
    for profile in invalidProfiles {
      expectFailure {
        _ = try BrokerCredentialStageBindingDescriptor(activationProfileID: profile)
      }
    }

    let invalidBases = [
      "",
      String(repeating: "b", count: 2_049),
      "https://api.example.com/v 1",
      "https://api.example.com/\u{7f}",
      "https://api.example.com/\n",
      "https://api.exämple.com/v1",
    ]
    for base in invalidBases {
      expectFailure {
        _ = try BrokerCredentialStageBindingDescriptor(
          activationProfileID: "custom_openai_compatible_v1",
          customBaseURL: base,
          customModelCatalogBehavior: .modelsRoute
        )
      }
    }

    expectFailure {
      _ = try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "custom_openai_compatible_v1",
        customBaseURL: "https://api.example.com/v1"
      )
    }
    expectFailure {
      _ = try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "custom_openai_compatible_v1",
        customModelCatalogBehavior: .modelsRoute
      )
    }
  }

  @Test
  func stageDecoderRejectsEveryDescriptorTruncationAndMalformedField() throws {
    let requestID: UInt64 = 29
    let profile = "custom_openai_compatible_v1"
    let base = "https://api.example.com/v1"
    let valid = try BrokerCredentialStageRequest(
      requestID: requestID,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0,
      providerBinding: try BrokerCredentialStageBindingDescriptor(
        activationProfileID: profile,
        customBaseURL: base,
        customModelCatalogBehavior: .modelsRoute
      )
    ).encode()

    for end in 60..<valid.count {
      var truncated = Data(valid.prefix(end))
      replaceUInt32(&truncated, at: 8, with: UInt32(end - 12))
      expectFailure { _ = try BrokerCredentialStageRequest.decode(truncated) }
    }

    let profileStart = 61
    let baseLengthOffset = profileStart + profile.utf8.count
    let baseStart = baseLengthOffset + 2
    let catalogOffset = baseStart + base.utf8.count
    var malformed: [Data] = []

    var emptyProfile = valid
    emptyProfile[60] = 0
    malformed.append(emptyProfile)
    var longProfile = valid
    longProfile[60] = 65
    malformed.append(longProfile)
    var invalidProfileASCII = valid
    invalidProfileASCII[profileStart] = 0x20
    malformed.append(invalidProfileASCII)
    var invalidProfileUTF8 = valid
    invalidProfileUTF8[profileStart] = 0x80
    malformed.append(invalidProfileUTF8)
    var invalidBaseASCII = valid
    invalidBaseASCII[baseStart] = 0x7f
    malformed.append(invalidBaseASCII)
    var invalidBaseUTF8 = valid
    invalidBaseUTF8[baseStart] = 0x80
    malformed.append(invalidBaseUTF8)
    var longBase = valid
    replaceUInt16(&longBase, at: baseLengthOffset, with: 2_049)
    malformed.append(longBase)
    var unknownCatalog = valid
    unknownCatalog[catalogOffset] = 3
    malformed.append(unknownCatalog)
    var missingCatalog = valid
    missingCatalog[catalogOffset] = 0
    malformed.append(missingCatalog)
    var missingBase = valid
    replaceUInt16(&missingBase, at: baseLengthOffset, with: 0)
    malformed.append(missingBase)

    for bytes in malformed {
      do {
        _ = try BrokerCredentialStageRequest.decode(bytes)
        Issue.record("Expected malformed provider descriptor to fail")
      } catch let error as BrokerCredentialLifecycleCodecError {
        #expect(error.requestID == requestID)
        #expect(error.description == "invalid credential lifecycle frame")
      } catch {
        Issue.record("Expected the fixed credential lifecycle codec error")
      }
    }
  }

  @Test
  func codecPreservesUnknownButSyntacticallyValidProfileForServiceValidation() throws {
    let request = try BrokerCredentialStageRequest(
      requestID: 31,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0,
      providerBinding: try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "future_profile_v1"
      )
    )
    #expect(try BrokerCredentialStageRequest.decode(request.encode()) == request)
  }

  @Test
  func everyControlRequestUsesItsFrozenKindLengthAndRoundTrips() throws {
    let cases: [(BrokerCredentialControlRequest, UInt16, Int)] = [
      (.projection(requestID: 2, connectionID: connectionID), 2, 36),
      (
        .resumeStage(
          requestID: 3,
          connectionID: connectionID,
          operationID: operationID,
          expectedFence: 4
        ),
        3,
        60
      ),
      (.reservedOperation(requestID: 4), 4, 20),
      (
        .abort(
          requestID: 5,
          connectionID: connectionID,
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 6
        ),
        5,
        76
      ),
      (
        .disconnect(
          requestID: 6,
          connectionID: connectionID,
          operationID: operationID,
          expectedFence: 7
        ),
        6,
        60
      ),
    ]

    for (request, kind, length) in cases {
      let encoded = try request.encode()
      #expect(encoded.count == length)
      #expect(readUInt16(encoded, at: 6) == kind)
      #expect(readUInt32(encoded, at: 8) == UInt32(length - 12))
      #expect(try BrokerCredentialControlRequest.decode(encoded) == request)
    }
  }

  @Test
  func projectionRepliesUseTheFrozenKindsLengthsAndRoundTrip() throws {
    let missing = try BrokerCredentialRedactedProjection(
      state: .missing,
      fence: 0,
      hasUsableReady: false,
      attemptID: nil
    )
    let staging = try BrokerCredentialRedactedProjection(
      state: .staging,
      fence: 8,
      hasUsableReady: true,
      attemptID: attemptID
    )
    let vacant = try BrokerCredentialRedactedProjection(
      state: .vacant,
      fence: 0,
      hasUsableReady: false,
      attemptID: nil
    )
    let ready = try BrokerCredentialRedactedProjection(
      state: .ready,
      fence: 9,
      hasUsableReady: true,
      attemptID: nil
    )
    let tombstoned = try BrokerCredentialRedactedProjection(
      state: .tombstoned,
      fence: 10,
      hasUsableReady: false,
      attemptID: nil
    )
    let replies: [(BrokerCredentialLifecycleReply, UInt16, Int)] = [
      (.projection(requestID: 1, missing), 101, 30),
      (.projection(requestID: 2, staging), 101, 46),
      (.projection(requestID: 3, vacant), 101, 30),
      (.projection(requestID: 4, ready), 101, 30),
      (.projection(requestID: 5, tombstoned), 101, 30),
      (.staged(requestID: 6, staging), 102, 46),
      (.mutation(requestID: 7, vacant), 103, 30),
      (.mutation(requestID: 8, ready), 103, 30),
      (.mutation(requestID: 9, tombstoned), 103, 30),
    ]

    for (reply, kind, length) in replies {
      let encoded = try reply.encode()
      #expect(encoded.count == length)
      #expect(readUInt16(encoded, at: 6) == kind)
      #expect(readUInt32(encoded, at: 8) == UInt32(length - 12))
      #expect(try BrokerCredentialLifecycleReply.decode(encoded) == reply)
    }
  }

  @Test
  func everyFixedFailureCodeRoundTripsWithoutText() throws {
    let codes: [BrokerCredentialLifecycleFailureCode] = [
      .invalidRequest,
      .sessionNotReady,
      .capacityExceeded,
      .cancelled,
      .notFound,
      .disconnected,
      .staleFence,
      .conflict,
      .busy,
      .credentialStoreUnavailable,
      .cleanupPending,
      .operationUnavailable,
      .authorityUnavailable,
    ]

    for (offset, code) in codes.enumerated() {
      let reply = BrokerCredentialLifecycleReply.failure(
        requestID: UInt64(offset + 1),
        code
      )
      let encoded = try reply.encode()
      #expect(encoded.count == 22)
      #expect(readUInt16(encoded, at: 6) == 255)
      #expect(readUInt32(encoded, at: 8) == 10)
      #expect(readUInt16(encoded, at: 20) == UInt16(offset + 1))
      #expect(try BrokerCredentialLifecycleReply.decode(encoded) == reply)
    }
  }

  @Test
  func requestValuesRejectReservedIDsAndZeroUUIDs() throws {
    expectFailure {
      _ = try BrokerCredentialStageRequest(
        requestID: 0,
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0,
        providerBinding: try builtInStageBinding()
      )
    }
    expectFailure {
      _ = try BrokerCredentialStageRequest(
        requestID: brokerCredentialMalformedRequestID,
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0,
        providerBinding: try builtInStageBinding()
      )
    }
    expectFailure {
      _ = try BrokerCredentialStageRequest(
        requestID: 1,
        connectionID: zeroUUID,
        operationID: operationID,
        expectedFence: 0,
        providerBinding: try builtInStageBinding()
      )
    }
    expectFailure {
      _ = try BrokerCredentialStageRequest(
        requestID: 1,
        connectionID: connectionID,
        operationID: zeroUUID,
        expectedFence: 0,
        providerBinding: try builtInStageBinding()
      )
    }

    let invalidControls: [BrokerCredentialControlRequest] = [
      .projection(requestID: 0, connectionID: connectionID),
      .projection(
        requestID: brokerCredentialMalformedRequestID,
        connectionID: connectionID
      ),
      .projection(requestID: 1, connectionID: zeroUUID),
      .resumeStage(
        requestID: 1,
        connectionID: zeroUUID,
        operationID: operationID,
        expectedFence: 0
      ),
      .resumeStage(
        requestID: 1,
        connectionID: connectionID,
        operationID: zeroUUID,
        expectedFence: 0
      ),
      .reservedOperation(requestID: 0),
      .abort(
        requestID: 1,
        connectionID: connectionID,
        attemptID: zeroUUID,
        operationID: operationID,
        expectedFence: 0
      ),
      .abort(
        requestID: 1,
        connectionID: connectionID,
        attemptID: attemptID,
        operationID: zeroUUID,
        expectedFence: 0
      ),
      .disconnect(
        requestID: 1,
        connectionID: connectionID,
        operationID: zeroUUID,
        expectedFence: 0
      ),
    ]
    for request in invalidControls {
      expectFailure { _ = try request.encode() }
    }

    let maximumClientID = brokerCredentialMalformedRequestID - 1
    let maximum = BrokerCredentialControlRequest.reservedOperation(
      requestID: maximumClientID
    )
    #expect(try BrokerCredentialControlRequest.decode(maximum.encode()) == maximum)
  }

  @Test
  func decodersRejectInvalidRequestIDsAndEveryZeroUUIDPosition() throws {
    let validStage = try BrokerCredentialStageRequest(
      requestID: 1,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0,
      providerBinding: try builtInStageBinding()
    ).encode()
    for invalidID in [UInt64(0), brokerCredentialMalformedRequestID] {
      var bytes = validStage
      replaceUInt64(&bytes, at: 12, with: invalidID)
      expectFailure { _ = try BrokerCredentialStageRequest.decode(bytes) }
    }
    for range in [20..<36, 36..<52] {
      var bytes = validStage
      bytes.replaceSubrange(range, with: repeatElement(UInt8(0), count: 16))
      expectFailure { _ = try BrokerCredentialStageRequest.decode(bytes) }
    }

    let abort = try BrokerCredentialControlRequest.abort(
      requestID: 2,
      connectionID: connectionID,
      attemptID: attemptID,
      operationID: operationID,
      expectedFence: 0
    ).encode()
    for range in [20..<36, 36..<52, 52..<68] {
      var bytes = abort
      bytes.replaceSubrange(range, with: repeatElement(UInt8(0), count: 16))
      expectFailure { _ = try BrokerCredentialControlRequest.decode(bytes) }
    }
  }

  @Test
  func decodeFailuresExposeOnlyAnAlreadyValidatedRequestID() throws {
    let valid = try BrokerCredentialStageRequest(
      requestID: 19,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0,
      providerBinding: try builtInStageBinding()
    ).encode()
    var badMagic = valid
    badMagic[0] = 0
    var zeroRequestID = valid
    replaceUInt64(&zeroRequestID, at: 12, with: 0)
    var zeroConnectionID = valid
    zeroConnectionID.replaceSubrange(
      20..<36,
      with: repeatElement(UInt8(0), count: 16)
    )
    let lateLengthFailure = frame(
      kind: 4,
      body: body(requestID: 19) + Data([0])
    )
    let ready = try BrokerCredentialRedactedProjection(
      state: .ready,
      fence: 1,
      hasUsableReady: true,
      attemptID: nil
    )
    var lateStateFailure = try BrokerCredentialLifecycleReply.projection(
      requestID: 19,
      ready
    ).encode()
    lateStateFailure[20] = 99

    for bytes in [Data(valid.prefix(11)), badMagic, zeroRequestID] {
      do {
        _ = try BrokerCredentialStageRequest.decode(bytes)
        Issue.record("Expected malformed frame to fail")
      } catch let error as BrokerCredentialLifecycleCodecError {
        #expect(error.requestID == nil)
        #expect(error.description == "invalid credential lifecycle frame")
      } catch {
        Issue.record("Expected the fixed credential lifecycle codec error")
      }
    }

    do {
      _ = try BrokerCredentialStageRequest.decode(zeroConnectionID)
      Issue.record("Expected invalid UUID to fail")
    } catch let error as BrokerCredentialLifecycleCodecError {
      #expect(error.requestID == 19)
      #expect(error.description == "invalid credential lifecycle frame")
    } catch {
      Issue.record("Expected the fixed credential lifecycle codec error")
    }

    do {
      _ = try BrokerCredentialControlRequest.decode(lateLengthFailure)
      Issue.record("Expected invalid kind-specific length to fail")
    } catch let error as BrokerCredentialLifecycleCodecError {
      #expect(error.requestID == 19)
      #expect(error.description == "invalid credential lifecycle frame")
    } catch {
      Issue.record("Expected the fixed credential lifecycle codec error")
    }

    do {
      _ = try BrokerCredentialLifecycleReply.decode(lateStateFailure)
      Issue.record("Expected invalid reply state to fail")
    } catch let error as BrokerCredentialLifecycleCodecError {
      #expect(error.requestID == 19)
      #expect(error.description == "invalid credential lifecycle frame")
    } catch {
      Issue.record("Expected the fixed credential lifecycle codec error")
    }

    do {
      _ = try BrokerCredentialControlRequest.projection(
        requestID: 19,
        connectionID: zeroUUID
      ).encode()
      Issue.record("Expected encoder validation to fail")
    } catch let error as BrokerCredentialLifecycleCodecError {
      #expect(error.requestID == nil)
      #expect(error.description == "invalid credential lifecycle frame")
    } catch {
      Issue.record("Expected the fixed credential lifecycle codec error")
    }
  }

  @Test
  func stageDecoderRejectsNoncanonicalHeadersLengthsAndBodies() throws {
    let valid = try BrokerCredentialStageRequest(
      requestID: 7,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 8,
      providerBinding: try builtInStageBinding()
    ).encode()
    var malformed: [Data] = [Data(), Data(valid.prefix(11)), Data(valid.dropLast())]

    var badMagic = valid
    badMagic[0] = 0
    malformed.append(badMagic)
    var badVersion = valid
    badVersion[5] = 2
    malformed.append(badVersion)
    var wrongKind = valid
    replaceUInt16(&wrongKind, at: 6, with: 2)
    malformed.append(wrongKind)
    var badLength = valid
    replaceUInt32(&badLength, at: 8, with: 47)
    malformed.append(badLength)
    var trailing = valid
    trailing.append(0)
    malformed.append(trailing)
    malformed.append(frame(kind: 1, body: Data(repeating: 0, count: 2_165)))

    for bytes in malformed {
      expectFailure { _ = try BrokerCredentialStageRequest.decode(bytes) }
    }
  }

  @Test
  func controlDecoderAcceptsOnlyExactKnownControlFrames() throws {
    let reserved = try BrokerCredentialControlRequest.reservedOperation(
      requestID: 4
    ).encode()
    #expect(
      try BrokerCredentialControlRequest.decode(reserved)
        == .reservedOperation(requestID: 4)
    )

    let invalidFrames = [
      frame(kind: 4, body: body(requestID: 4) + Data([0])),
      frame(kind: 4, body: Data()),
      frame(kind: 4, body: body(requestID: 0)),
      frame(kind: 4, body: body(requestID: brokerCredentialMalformedRequestID)),
      frame(kind: 7, body: body(requestID: 4)),
      frame(kind: 3, body: Data(repeating: 0, count: 47)),
      frame(kind: 5, body: Data(repeating: 0, count: 65)),
      frame(kind: 6, body: Data(repeating: 0, count: 257)),
    ]
    for bytes in invalidFrames {
      expectFailure { _ = try BrokerCredentialControlRequest.decode(bytes) }
    }

    let stage = try BrokerCredentialStageRequest(
      requestID: 1,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0,
      providerBinding: try builtInStageBinding()
    ).encode()
    expectFailure { _ = try BrokerCredentialControlRequest.decode(stage) }
    expectFailure { _ = try BrokerCredentialStageRequest.decode(reserved) }
  }

  @Test
  func projectionConstructorEnforcesEveryStateInvariant() throws {
    let valid: [BrokerCredentialRedactedProjection] = [
      try BrokerCredentialRedactedProjection(
        state: .missing,
        fence: 0,
        hasUsableReady: false,
        attemptID: nil
      ),
      try BrokerCredentialRedactedProjection(
        state: .vacant,
        fence: 0,
        hasUsableReady: false,
        attemptID: nil
      ),
      try BrokerCredentialRedactedProjection(
        state: .vacant,
        fence: 2,
        hasUsableReady: false,
        attemptID: nil
      ),
      try BrokerCredentialRedactedProjection(
        state: .staging,
        fence: 3,
        hasUsableReady: false,
        attemptID: attemptID
      ),
      try BrokerCredentialRedactedProjection(
        state: .staging,
        fence: 3,
        hasUsableReady: true,
        attemptID: attemptID
      ),
      try BrokerCredentialRedactedProjection(
        state: .ready,
        fence: 4,
        hasUsableReady: true,
        attemptID: nil
      ),
      try BrokerCredentialRedactedProjection(
        state: .tombstoned,
        fence: 5,
        hasUsableReady: false,
        attemptID: nil
      ),
    ]
    #expect(valid.count == 7)

    let invalid: [() throws -> BrokerCredentialRedactedProjection] = [
      { try .init(state: .missing, fence: 1, hasUsableReady: false, attemptID: nil) },
      { try .init(state: .missing, fence: 0, hasUsableReady: true, attemptID: nil) },
      { try .init(state: .missing, fence: 0, hasUsableReady: false, attemptID: self.attemptID) },
      { try .init(state: .vacant, fence: 0, hasUsableReady: true, attemptID: nil) },
      { try .init(state: .vacant, fence: 1, hasUsableReady: false, attemptID: self.attemptID) },
      { try .init(state: .staging, fence: 0, hasUsableReady: false, attemptID: self.attemptID) },
      { try .init(state: .staging, fence: 1, hasUsableReady: false, attemptID: nil) },
      { try .init(state: .ready, fence: 0, hasUsableReady: true, attemptID: nil) },
      { try .init(state: .ready, fence: 1, hasUsableReady: false, attemptID: nil) },
      { try .init(state: .ready, fence: 1, hasUsableReady: true, attemptID: self.attemptID) },
      { try .init(state: .tombstoned, fence: 0, hasUsableReady: false, attemptID: nil) },
      { try .init(state: .tombstoned, fence: 1, hasUsableReady: true, attemptID: nil) },
      { try .init(state: .tombstoned, fence: 1, hasUsableReady: false, attemptID: self.attemptID) },
    ]
    for makeProjection in invalid {
      expectFailure { _ = try makeProjection() }
    }
  }

  @Test
  func replyEncoderRejectsKindStateMismatchesAndInvalidRequestIDs() throws {
    let missing = try BrokerCredentialRedactedProjection(
      state: .missing,
      fence: 0,
      hasUsableReady: false,
      attemptID: nil
    )
    let staging = try BrokerCredentialRedactedProjection(
      state: .staging,
      fence: 1,
      hasUsableReady: false,
      attemptID: attemptID
    )
    let vacant = try BrokerCredentialRedactedProjection(
      state: .vacant,
      fence: 0,
      hasUsableReady: false,
      attemptID: nil
    )
    let ready = try BrokerCredentialRedactedProjection(
      state: .ready,
      fence: 1,
      hasUsableReady: true,
      attemptID: nil
    )
    let tombstoned = try BrokerCredentialRedactedProjection(
      state: .tombstoned,
      fence: 2,
      hasUsableReady: false,
      attemptID: nil
    )
    let invalid: [BrokerCredentialLifecycleReply] = [
      .projection(requestID: 0, missing),
      .projection(requestID: brokerCredentialMalformedRequestID, missing),
      .staged(requestID: 1, missing),
      .staged(requestID: 1, vacant),
      .staged(requestID: 1, ready),
      .staged(requestID: 1, tombstoned),
      .mutation(requestID: 1, missing),
      .mutation(requestID: 1, staging),
    ]
    for reply in invalid {
      expectFailure { _ = try reply.encode() }
    }
  }

  @Test
  func replyDecoderRejectsMalformedBodiesStatesBooleansAndKindMismatches() throws {
    let staging = try BrokerCredentialRedactedProjection(
      state: .staging,
      fence: 8,
      hasUsableReady: true,
      attemptID: attemptID
    )
    let ready = try BrokerCredentialRedactedProjection(
      state: .ready,
      fence: 9,
      hasUsableReady: true,
      attemptID: nil
    )
    var unknownState = try BrokerCredentialLifecycleReply.projection(
      requestID: 1,
      ready
    ).encode()
    unknownState[20] = 99
    var invalidBoolean = unknownState
    invalidBoolean[20] = BrokerCredentialRedactedState.ready.rawValue
    invalidBoolean[29] = 2
    var stagingWithoutAttempt = try BrokerCredentialLifecycleReply.projection(
      requestID: 1,
      staging
    ).encode()
    stagingWithoutAttempt.removeLast(16)
    replaceUInt32(&stagingWithoutAttempt, at: 8, with: 18)
    var readyWithAttempt = try BrokerCredentialLifecycleReply.projection(
      requestID: 1,
      ready
    ).encode()
    readyWithAttempt.append(contentsOf: uuidBytes(attemptID))
    replaceUInt32(&readyWithAttempt, at: 8, with: 34)
    var stagedReady = try BrokerCredentialLifecycleReply.projection(
      requestID: 1,
      ready
    ).encode()
    replaceUInt16(&stagedReady, at: 6, with: 102)
    var mutationStaging = try BrokerCredentialLifecycleReply.projection(
      requestID: 1,
      staging
    ).encode()
    replaceUInt16(&mutationStaging, at: 6, with: 103)
    var mutationMissing = try BrokerCredentialLifecycleReply.projection(
      requestID: 1,
      try BrokerCredentialRedactedProjection(
        state: .missing,
        fence: 0,
        hasUsableReady: false,
        attemptID: nil
      )
    ).encode()
    replaceUInt16(&mutationMissing, at: 6, with: 103)

    let invalid = [
      unknownState,
      invalidBoolean,
      stagingWithoutAttempt,
      readyWithAttempt,
      stagedReady,
      mutationStaging,
      mutationMissing,
      frame(kind: 104, body: Data(repeating: 0, count: 18)),
      frame(kind: 101, body: Data(repeating: 0, count: 257)),
    ]
    for bytes in invalid {
      expectFailure { _ = try BrokerCredentialLifecycleReply.decode(bytes) }
    }
  }

  @Test
  func failureRepliesReserveTheMalformedSentinelOnlyForInvalidRequest() throws {
    let malformed = BrokerCredentialLifecycleReply.failure(
      requestID: brokerCredentialMalformedRequestID,
      .invalidRequest
    )
    #expect(try BrokerCredentialLifecycleReply.decode(malformed.encode()) == malformed)

    let ordinaryInvalid = BrokerCredentialLifecycleReply.failure(
      requestID: 17,
      .invalidRequest
    )
    #expect(
      try BrokerCredentialLifecycleReply.decode(ordinaryInvalid.encode())
        == ordinaryInvalid
    )

    expectFailure {
      _ = try BrokerCredentialLifecycleReply.failure(
        requestID: 0,
        .invalidRequest
      ).encode()
    }
    expectFailure {
      _ = try BrokerCredentialLifecycleReply.failure(
        requestID: brokerCredentialMalformedRequestID,
        .cancelled
      ).encode()
    }

    expectFailure {
      _ = try BrokerCredentialLifecycleReply.decode(
        frame(
          kind: 255,
          body: body(requestID: brokerCredentialMalformedRequestID)
            + uint16(BrokerCredentialLifecycleFailureCode.cancelled.rawValue)
        )
      )
    }
    expectFailure {
      _ = try BrokerCredentialLifecycleReply.decode(
        frame(kind: 255, body: body(requestID: 1) + uint16(14))
      )
    }
  }

  @Test
  func encodedRepliesContainNoCredentialOrIdentifierMaterial() throws {
    let staging = try BrokerCredentialRedactedProjection(
      state: .staging,
      fence: 1,
      hasUsableReady: true,
      attemptID: attemptID
    )
    let vacant = try BrokerCredentialRedactedProjection(
      state: .vacant,
      fence: 0,
      hasUsableReady: false,
      attemptID: nil
    )
    let replies: [BrokerCredentialLifecycleReply] = [
      .projection(requestID: 1, vacant),
      .staged(requestID: 2, staging),
      .mutation(
        requestID: 3,
        try BrokerCredentialRedactedProjection(
          state: .tombstoned,
          fence: 2,
          hasUsableReady: false,
          attemptID: nil
        )
      ),
      .failure(requestID: 4, .credentialStoreUnavailable),
    ]
    let forbidden = [
      "recurs-test-secret-canary-do-not-leak",
      "generationid",
      "generation_id",
      "ordinal",
      "keychain",
      "account",
      "credentialreference",
      "credential_reference",
      "storekey",
      "store_key",
      "fingerprint",
      "secret",
      "filepath",
      "file_path",
      "journalrecord",
      "journal_record",
      "openai_api_v1",
      "custom_openai_compatible_v1",
      "https://api.example.com/v1",
    ]

    for reply in replies {
      let text = String(decoding: try reply.encode(), as: UTF8.self).lowercased()
      for identifier in forbidden {
        #expect(!text.contains(identifier))
      }
    }
  }
}

private let zeroUUID = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))

private func expectFailure(_ operation: () throws -> Void) {
  do {
    try operation()
    Issue.record("Expected credential lifecycle codec operation to fail")
  } catch {}
}

private func builtInStageBinding() throws -> BrokerCredentialStageBindingDescriptor {
  try BrokerCredentialStageBindingDescriptor(activationProfileID: "openai_api_v1")
}

private func frame(kind: UInt16, body: Data) -> Data {
  uint32(0x5243_434c) + uint16(1) + uint16(kind) + uint32(UInt32(body.count)) + body
}

private func body(requestID: UInt64) -> Data {
  uint64(requestID)
}

private func uint16(_ value: UInt16) -> Data {
  Data([UInt8(value >> 8), UInt8(value & 0xff)])
}

private func uint32(_ value: UInt32) -> Data {
  Data([
    UInt8(value >> 24),
    UInt8((value >> 16) & 0xff),
    UInt8((value >> 8) & 0xff),
    UInt8(value & 0xff),
  ])
}

private func uint64(_ value: UInt64) -> Data {
  Data((0..<8).map { shift in UInt8((value >> UInt64(56 - (shift * 8))) & 0xff) })
}

private func uuidBytes(_ value: UUID) -> Data {
  var uuid = value.uuid
  return withUnsafeBytes(of: &uuid) { Data($0) }
}

private func readUInt16(_ data: Data, at offset: Int) -> UInt16 {
  (UInt16(data[offset]) << 8) | UInt16(data[offset + 1])
}

private func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
  (UInt32(data[offset]) << 24)
    | (UInt32(data[offset + 1]) << 16)
    | (UInt32(data[offset + 2]) << 8)
    | UInt32(data[offset + 3])
}

private func replaceUInt16(_ data: inout Data, at offset: Int, with value: UInt16) {
  data.replaceSubrange(offset..<(offset + 2), with: uint16(value))
}

private func replaceUInt32(_ data: inout Data, at offset: Int, with value: UInt32) {
  data.replaceSubrange(offset..<(offset + 4), with: uint32(value))
}

private func replaceUInt64(_ data: inout Data, at offset: Int, with value: UInt64) {
  data.replaceSubrange(offset..<(offset + 8), with: uint64(value))
}
