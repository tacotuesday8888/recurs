import Foundation

package struct BrokerJournalPreparedEntry: Sendable, Hashable {
  package let snapshot: BrokerJournalSnapshot
  package let plan: BrokerJournalRecoveryPlan

  package init(
    snapshot: BrokerJournalSnapshot,
    plan: BrokerJournalRecoveryPlan
  ) {
    self.snapshot = snapshot
    self.plan = plan
  }
}

package enum BrokerJournalRecovery {
  private static let maximumConnectionCount = 1_024

  package static func prepare(
    journal: any BrokerJournalStore,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) async throws(BrokerJournalError) -> [BrokerJournalPreparedEntry] {
    let snapshots = try await journal.list()
    try validateCanonicalList(snapshots)
    guard !snapshots.isEmpty else {
      return []
    }

    let recoveryTime = try BrokerJournalRecordAdapter.captureTimestamp(from: clock())
    var planned:
      [(
        snapshot: BrokerJournalSnapshot,
        transitionPlan: BrokerJournalRecoveryPlan,
        selectedPlan: BrokerJournalRecoveryPlan
      )] = []
    planned.reserveCapacity(snapshots.count)
    for snapshot in snapshots {
      let transitionPlan = try BrokerJournalRecordAdapter.recoveryPlan(
        for: snapshot.record,
        recoveryChangedAt: recoveryTime
      )
      let selectedPlan: BrokerJournalRecoveryPlan
      if let intended = transitionPlan.preparation {
        let recomputed = try BrokerJournalRecordAdapter.recoveryPlan(
          for: intended,
          recoveryChangedAt: recoveryTime
        )
        guard
          recomputed.preparation == nil,
          recomputed.bootstrap == transitionPlan.bootstrap,
          recomputed.projection == transitionPlan.projection,
          recomputed.cleanup == transitionPlan.cleanup
        else {
          throw .invalidRecord
        }
        selectedPlan = recomputed
      } else {
        selectedPlan = transitionPlan
      }
      planned.append((snapshot, transitionPlan, selectedPlan))
    }

    var prepared: [BrokerJournalPreparedEntry] = []
    prepared.reserveCapacity(planned.count)
    for (snapshot, transitionPlan, selectedPlan) in planned {
      guard let intended = transitionPlan.preparation else {
        prepared.append(BrokerJournalPreparedEntry(snapshot: snapshot, plan: selectedPlan))
        continue
      }
      let selected = try await prepare(
        predecessor: snapshot,
        intended: intended,
        journal: journal
      )
      prepared.append(BrokerJournalPreparedEntry(snapshot: selected, plan: selectedPlan))
    }
    return prepared
  }

  private static func validateCanonicalList(
    _ snapshots: [BrokerJournalSnapshot]
  ) throws(BrokerJournalError) {
    guard snapshots.count <= maximumConnectionCount else {
      throw .rollbackDetected
    }
    var previousID: String?
    for snapshot in snapshots {
      let connectionID = snapshot.record.connectionID.uuidString.lowercased()
      if let previousID, previousID >= connectionID {
        throw .rollbackDetected
      }
      previousID = connectionID
    }
  }

  private static func prepare(
    predecessor: BrokerJournalSnapshot,
    intended: BrokerJournalRecord,
    journal: any BrokerJournalStore
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot {
    let selected = try await journal.compareAndSwap(
      expected: predecessor,
      replacement: intended
    )
    guard selected.record == intended else {
      throw .casConflict
    }
    return selected
  }
}
