import Foundation
import Testing

@testable import RecursBrokerCore

private struct NonSecretPolicyCase: Decodable {
  let name: String
  let value: String
  let forbidden: Bool
}

private struct NonSecretPolicyCases: Decodable {
  let schemaVersion: Int
  let keyCases: [NonSecretPolicyCase]
  let valueCases: [NonSecretPolicyCase]
}

@Suite("Shared non-secret policy")
struct NonSecretPolicyTests {
  @Test
  func appliesEverySharedKeyAndValueBoundary() throws {
    let url = try #require(
      Bundle.module.url(
        forResource: "non-secret-policy-cases",
        withExtension: "json"
      )
    )
    let fixture = try JSONDecoder().decode(
      NonSecretPolicyCases.self,
      from: Data(contentsOf: url)
    )
    #expect(fixture.schemaVersion == 1)

    for testCase in fixture.keyCases {
      #expect(
        NonSecretPolicy.isForbiddenKey(testCase.value) == testCase.forbidden,
        Comment(rawValue: testCase.name)
      )
    }
    for testCase in fixture.valueCases {
      #expect(
        NonSecretPolicy.looksLikeSecretValue(testCase.value) == testCase.forbidden,
        Comment(rawValue: testCase.name)
      )
    }
  }

  @Test
  func appliesEveryGeneratedKeyTokenPrefixAndWhitespaceScalar() throws {
    for key in GeneratedNonSecretPolicy.forbiddenNormalizedKeys {
      #expect(NonSecretPolicy.isForbiddenKey(key), Comment(rawValue: key))
    }
    for prefix in GeneratedNonSecretPolicy.tokenPrefixes {
      #expect(
        NonSecretPolicy.looksLikeSecretValue(prefix + String(repeating: "A", count: 16)),
        Comment(rawValue: prefix)
      )
    }
    for codePoint in GeneratedNonSecretPolicy.authorizationWhitespaceCodePoints {
      let scalar = try #require(Unicode.Scalar(codePoint))
      let value = "Bearer" + String(scalar) + "abcdefghijkl"
      #expect(
        NonSecretPolicy.looksLikeSecretValue(value),
        Comment(rawValue: "U+\(String(codePoint, radix: 16))")
      )
    }
  }
}
