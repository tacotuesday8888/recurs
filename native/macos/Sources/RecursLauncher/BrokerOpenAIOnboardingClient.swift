import Foundation
import RecursBrokerXPC

package enum BrokerOpenAIOnboardingClientError: Error, Equatable, Sendable {
  case invalidRequest
  case sessionNotReady
  case busy
  case cancelled
  case expired
  case verificationFailed
  case invalidModel
  case noCompatibleModels
  case commitFailed
  case credentialStoreUnavailable
  case cleanupFailed
  case reconciliationRequired
  case authorityUnavailable
  case operationUnavailable
  case brokerUnavailable
  case protocolMismatch
  case closed

  init(_ code: BrokerOpenAIOnboardingFailureCode) {
    self =
      switch code {
      case .invalidRequest: .invalidRequest
      case .sessionNotReady: .sessionNotReady
      case .busy: .busy
      case .cancelled: .cancelled
      case .expired: .expired
      case .verificationFailed: .verificationFailed
      case .invalidModel: .invalidModel
      case .noCompatibleModels: .noCompatibleModels
      case .commitFailed: .commitFailed
      case .credentialStoreUnavailable: .credentialStoreUnavailable
      case .cleanupFailed: .cleanupFailed
      case .reconciliationRequired: .reconciliationRequired
      case .authorityUnavailable: .authorityUnavailable
      case .operationUnavailable: .operationUnavailable
      }
  }
}

package struct BrokerOpenAIOnboardingBegun:
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  CustomReflectable,
  CustomPlaygroundDisplayConvertible
{
  package let connectionID: UUID
  package let recoveryTokens: BrokerOpenAIOnboardingRecoveryTokens
  package let credentialIdentityFingerprint: String

  package var description: String { "<openai-onboarding-begun>" }
  package var debugDescription: String { description }
  package var customMirror: Mirror {
    Mirror(
      self,
      children: EmptyCollection<(label: String?, value: Any)>(),
      displayStyle: .struct
    )
  }
  package var playgroundDescription: Any { description }
}

package enum BrokerOpenAIOnboardingControl: Sendable, Equatable {
  case verify
  case catalogPage(cursor: UInt16)
  case finalize(exactModelID: String)
  case abort

  enum ExpectedReply: Sendable, Equatable {
    case catalogPage
    case committed
    case aborted
  }

  var expectedReply: ExpectedReply {
    switch self {
    case .verify, .catalogPage:
      .catalogPage
    case .finalize:
      .committed
    case .abort:
      .aborted
    }
  }

  var isTerminal: Bool {
    switch self {
    case .verify, .catalogPage: false
    case .finalize, .abort: true
    }
  }

  func request(requestID: UInt64) -> BrokerOpenAIOnboardingRequest {
    switch self {
    case .verify:
      .verify(requestID: requestID)
    case .catalogPage(let cursor):
      .catalogPage(requestID: requestID, cursor: cursor)
    case .finalize(let exactModelID):
      .finalize(requestID: requestID, exactModelID: exactModelID)
    case .abort:
      .abort(requestID: requestID)
    }
  }
}

package enum BrokerOpenAIOnboardingControlResult: Sendable, Equatable {
  case catalogPage(BrokerOpenAIOnboardingCatalogPage)
  case committed(BrokerOpenAIOnboardingCommitReceipt)
  case aborted
}
