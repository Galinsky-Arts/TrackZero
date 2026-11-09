import Foundation
import SwiftUI

/// DAE-10 must supply endpoint-encrypted playback; this boundary never receives a raw URL.
protocol LiveRadioSession: AnyObject {
    func start() async throws
    func close() async throws
}
protocol LiveRadioEngine {
    func joinLive(stationId: String) async throws -> any LiveRadioSession
}

@MainActor final class LiveRadioModel: ObservableObject {
    enum State: Equatable {
        case stopped, connecting, playing, interrupted
        var label: String {
            switch self {
            case .stopped: "Stopped"
            case .connecting: "Connecting to live radio"
            case .playing: "Playing live radio"
            case .interrupted: "Playback interrupted"
            }
        }
    }
    @Published private(set) var state: State = .stopped
    private let engine: any LiveRadioEngine
    private var operation: Task<Void, Never>?
    private var previousOperation: Task<Void, Never>?
    private var closing: Task<Void, Never>?
    private var session: (any LiveRadioSession)?
    private var generation: UInt64 = 0
    private var cleanupFailed = false
    init(engine: any LiveRadioEngine) { self.engine = engine }

    /// Only a deliberate user action starts the current linear station; no seek/item API exists.
    func play(stationId: String) {
        guard stationId.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"#,
                              options: .regularExpression) != nil else {
            state = .interrupted
            return
        }
        guard !cleanupFailed else { state = .interrupted; return }
        stop()
        let request = generation
        let predecessor = previousOperation
        let priorClose = closing
        state = .connecting
        operation = Task { [engine] in
            do {
                await predecessor?.value
                await priorClose?.value
                guard request == generation else { return }
                guard !cleanupFailed else { state = .interrupted; return }
                let joined = try await engine.joinLive(stationId: stationId)
                guard request == generation else {
                    do { try await joined.close() } catch { cleanupFailed = true; state = .interrupted }
                    return
                }
                session = joined
                try await joined.start()
                guard request == generation else { return }
                state = .playing
            } catch {
                guard request == generation else { return }
                if let session {
                    do { try await session.close() } catch { cleanupFailed = true }
                }
                session = nil
                state = .interrupted
            }
        }
    }
    func stop() {
        guard generation < UInt64.max else { cleanupFailed = true; state = .interrupted; return }
        generation += 1
        operation?.cancel(); previousOperation = operation ?? previousOperation; operation = nil
        let old = session; session = nil
        if let old {
            let priorClose = closing
            closing = Task {
                await priorClose?.value
                do { try await old.close() }
                catch { cleanupFailed = true; state = .interrupted }
            }
        }
        state = cleanupFailed ? .interrupted : .stopped
    }
}
