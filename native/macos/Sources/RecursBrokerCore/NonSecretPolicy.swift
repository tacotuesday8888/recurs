import Foundation

package enum NonSecretPolicy {
  private static func isASCIIAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
    (scalar.value >= 48 && scalar.value <= 57)
      || (scalar.value >= 65 && scalar.value <= 90)
      || (scalar.value >= 97 && scalar.value <= 122)
  }

  private static func isTokenCharacter(_ character: Character) -> Bool {
    guard character.unicodeScalars.count == 1, let scalar = character.unicodeScalars.first else {
      return false
    }
    return isASCIIAlphanumeric(scalar) || scalar == "_" || scalar == "-"
  }

  private static func isMixedEntropyCharacter(_ scalar: Unicode.Scalar) -> Bool {
    isASCIIAlphanumeric(scalar)
      || scalar == "_" || scalar == "+" || scalar == "/"
      || scalar == "=" || scalar == "-"
  }

  private static func isFrozenAssignedKeyScalar(_ scalar: Unicode.Scalar) -> Bool {
    var lowerIndex = 0
    var upperIndex = GeneratedNonSecretPolicy.keyAssignedCodePointRanges.count - 1
    while lowerIndex <= upperIndex {
      let middle = lowerIndex + (upperIndex - lowerIndex) / 2
      let range = GeneratedNonSecretPolicy.keyAssignedCodePointRanges[middle]
      if scalar.value < range.lower {
        upperIndex = middle - 1
      } else if scalar.value > range.upper {
        lowerIndex = middle + 1
      } else {
        return true
      }
    }
    return false
  }

  private static func hasOnlyFrozenAssignedKeyScalars(_ value: String) -> Bool {
    var count = 0
    for scalar in value.unicodeScalars {
      count += 1
      guard
        count <= GeneratedNonSecretPolicy.keyMaximumUnicodeScalars,
        isFrozenAssignedKeyScalar(scalar)
      else {
        return false
      }
    }
    return true
  }

  private static func normalizeFrozenAssignedKey(_ value: String) -> String {
    let normalized = value.precomposedStringWithCompatibilityMapping
    let scalars = normalized.unicodeScalars.compactMap { scalar -> Unicode.Scalar? in
      guard isASCIIAlphanumeric(scalar) else { return nil }
      if scalar.value >= 65, scalar.value <= 90 {
        return Unicode.Scalar(scalar.value + 32)
      }
      return scalar
    }
    return String(String.UnicodeScalarView(scalars))
  }

  package static func normalizedKey(_ value: String) -> String {
    hasOnlyFrozenAssignedKeyScalars(value) ? normalizeFrozenAssignedKey(value) : ""
  }

  package static func isForbiddenKey(_ value: String) -> Bool {
    !hasOnlyFrozenAssignedKeyScalars(value)
      || GeneratedNonSecretPolicy.forbiddenNormalizedKeys.contains(
        normalizeFrozenAssignedKey(value)
      )
  }

  private static func hasPrivateKeyMarker(_ value: String) -> Bool {
    var search = value.startIndex
    while let begin = value.range(
      of: GeneratedNonSecretPolicy.privateKeyBegin,
      range: search..<value.endIndex
    ) {
      if value[begin.upperBound...].hasPrefix(GeneratedNonSecretPolicy.privateKeySuffix) {
        return true
      }
      var labelEnd = begin.upperBound
      while labelEnd < value.endIndex {
        let character = value[labelEnd]
        guard
          character.unicodeScalars.count == 1,
          let scalar = character.unicodeScalars.first,
          scalar.value >= 65,
          scalar.value <= 90
        else {
          break
        }
        labelEnd = value.index(after: labelEnd)
      }
      if labelEnd > begin.upperBound,
        value[labelEnd...].hasPrefix(GeneratedNonSecretPolicy.privateKeyLabelSeparator)
      {
        let suffixStart = value.index(
          labelEnd,
          offsetBy: GeneratedNonSecretPolicy.privateKeyLabelSeparator.count
        )
        if value[suffixStart...].hasPrefix(GeneratedNonSecretPolicy.privateKeySuffix) {
          return true
        }
      }
      search = value.index(after: begin.lowerBound)
    }
    return false
  }

  private static func hasPrefixedToken(_ value: String) -> Bool {
    for prefix in GeneratedNonSecretPolicy.tokenPrefixes {
      var search = value.startIndex
      while let match = value.range(of: prefix, range: search..<value.endIndex) {
        var index = match.upperBound
        var length = 0
        while index < value.endIndex, isTokenCharacter(value[index]) {
          length += 1
          index = value.index(after: index)
        }
        if length >= GeneratedNonSecretPolicy.tokenMinimumSuffixLength {
          return true
        }
        search = value.index(after: match.lowerBound)
      }
    }
    return false
  }

  private static func isJWT(_ value: String) -> Bool {
    let segments = value.split(separator: ".", omittingEmptySubsequences: false)
    guard segments.count == GeneratedNonSecretPolicy.jwtSegmentCount else {
      return false
    }
    let first = String(segments[0])
    guard first.hasPrefix(GeneratedNonSecretPolicy.jwtFirstSegmentPrefix) else {
      return false
    }
    let remainder = first.dropFirst(GeneratedNonSecretPolicy.jwtFirstSegmentPrefix.count)
    guard
      remainder.count >= GeneratedNonSecretPolicy.jwtMinimumFirstRemainderLength,
      segments[1].count >= GeneratedNonSecretPolicy.jwtMinimumOtherSegmentLength,
      segments[2].count >= GeneratedNonSecretPolicy.jwtMinimumOtherSegmentLength
    else {
      return false
    }
    return [Substring(remainder), segments[1], segments[2]].allSatisfy { segment in
      !segment.isEmpty && segment.allSatisfy(isTokenCharacter)
    }
  }

  private static func isAuthorization(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)
    guard
      let separator = scalars.firstIndex(where: {
        GeneratedNonSecretPolicy.authorizationWhitespaceCodePoints.contains($0.value)
      }),
      separator > 0
    else {
      return false
    }
    let scheme = String(String.UnicodeScalarView(scalars[..<separator]))
    guard
      GeneratedNonSecretPolicy.authorizationSchemes.contains(where: {
        $0.lowercased() == scheme.lowercased()
      })
    else {
      return false
    }
    var payloadStart = separator
    while payloadStart < scalars.count,
      GeneratedNonSecretPolicy.authorizationWhitespaceCodePoints.contains(
        scalars[payloadStart].value
      )
    {
      payloadStart += 1
    }
    let payload = scalars[payloadStart...]
    return payload.count >= GeneratedNonSecretPolicy.authorizationMinimumPayloadLength
      && payload.allSatisfy {
        !GeneratedNonSecretPolicy.authorizationWhitespaceCodePoints.contains($0.value)
      }
  }

  package static func looksLikeSecretValue(_ value: String) -> Bool {
    if hasPrivateKeyMarker(value) || hasPrefixedToken(value) || isJWT(value) {
      return true
    }
    if isAuthorization(value) {
      return true
    }

    let scalars = Array(value.unicodeScalars)
    if scalars.count >= GeneratedNonSecretPolicy.longHexMinimumLength,
      scalars.allSatisfy({ scalar in
        (scalar.value >= 48 && scalar.value <= 57)
          || (scalar.value >= 65 && scalar.value <= 70)
          || (scalar.value >= 97 && scalar.value <= 102)
      })
    {
      return true
    }

    guard
      scalars.count >= GeneratedNonSecretPolicy.mixedEntropyMinimumLength,
      scalars.allSatisfy(isMixedEntropyCharacter),
      scalars.contains(where: { $0.value >= 97 && $0.value <= 122 }),
      scalars.contains(where: { $0.value >= 65 && $0.value <= 90 }),
      scalars.contains(where: { $0.value >= 48 && $0.value <= 57 })
    else {
      return false
    }
    return Set(scalars.map(\.value)).count
      >= GeneratedNonSecretPolicy.mixedEntropyMinimumDistinctCharacters
  }
}
