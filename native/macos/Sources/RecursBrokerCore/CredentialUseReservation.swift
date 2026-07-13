import Foundation

final class CredentialUseLifetime: @unchecked Sendable {
  typealias AbandonHandler = @Sendable (CredentialUseLifetime) -> Void

  private let lock = NSLock()
  private var secret: SecretBytes?
  private var isReleased = false
  private var onAbandon: AbandonHandler?

  init(onAbandon: @escaping AbandonHandler) {
    self.onAbandon = onAbandon
  }

  func install(_ secret: SecretBytes) -> Bool {
    lock.lock()
    guard !isReleased, self.secret == nil else {
      lock.unlock()
      secret.erase()
      return false
    }
    self.secret = secret
    lock.unlock()
    return true
  }

  func withSecret<Result>(_ body: (SecretBytes) -> Result) -> Result? {
    lock.lock()
    defer { lock.unlock() }
    guard !isReleased, let secret else { return nil }
    return body(secret)
  }

  func contains(_ candidate: SecretBytes) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return !isReleased && secret === candidate
  }

  func eraseSecret() {
    lock.lock()
    let selected = secret
    secret = nil
    lock.unlock()
    selected?.erase()
  }

  func release() {
    lock.lock()
    isReleased = true
    let selected = secret
    secret = nil
    onAbandon = nil
    lock.unlock()
    selected?.erase()
  }

  func abandon() {
    lock.lock()
    guard !isReleased else {
      lock.unlock()
      return
    }
    isReleased = true
    let selected = secret
    secret = nil
    let handler = onAbandon
    onAbandon = nil
    lock.unlock()

    selected?.erase()
    handler?(self)
  }

  deinit {
    release()
  }
}

package final class CredentialUseReservation:
  Sendable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  CustomReflectable
{
  let lifetime: CredentialUseLifetime

  init(lifetime: CredentialUseLifetime) {
    self.lifetime = lifetime
  }

  deinit {
    lifetime.abandon()
  }

  package var description: String { "<credential-use-reservation>" }
  package var debugDescription: String { description }

  package var customMirror: Mirror {
    let children: [(label: String?, value: Any)] = []
    return Mirror(self, children: children, displayStyle: .class)
  }
}

package enum CredentialUseError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError
{
  case cancelled
  case connectionNotFound
  case connectionTombstoned
  case noUsableCredential
  case operationInProgress
  case authorityUnavailable
  case credentialUnavailable
  case invalidReservation
  case invalidDeliveryTransition

  private var fixedDescription: String {
    switch self {
    case .cancelled:
      "The credential use was cancelled."
    case .connectionNotFound:
      "The credential connection was not found."
    case .connectionTombstoned:
      "The credential connection has been disconnected."
    case .noUsableCredential:
      "The connection has no usable credential."
    case .operationInProgress:
      "A credential lifecycle operation is in progress."
    case .authorityUnavailable:
      "Credential authority is unavailable."
    case .credentialUnavailable:
      "The credential is unavailable."
    case .invalidReservation:
      "The credential-use reservation is invalid."
    case .invalidDeliveryTransition:
      "The credential delivery transition is invalid."
    }
  }

  package var description: String { fixedDescription }
  package var debugDescription: String { fixedDescription }
  package var errorDescription: String? { fixedDescription }
}
