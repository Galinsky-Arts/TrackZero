import Foundation
import SwiftUI

/// DAE-10 must supply endpoint-encrypted playback; this boundary never receives a raw URL.
protocol LiveRadioSession {
    func start() async throws
    func close() async
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
    init(engine: any LiveRadioEngine) { self.engine = engine }

    /// Only a deliberate user action starts the current linear station; no seek/item API exists.
    func play(stationId: String) {
        guard stationId.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"#,
                              options: .regularExpression) != nil else {
            state = .interrupted
            return
        }
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
                let joined = try await engine.joinLive(stationId: stationId)
                guard request == generation else { await joined.close(); return }
                session = joined
                try await joined.start()
                guard request == generation else { await joined.close(); return }
                state = .playing
            } catch {
                guard request == generation else { return }
                if let session { await session.close() }
                session = nil
                state = .interrupted
            }
        }
    }
    func stop() {
        generation &+= 1
        operation?.cancel(); previousOperation = operation ?? previousOperation; operation = nil
        let old = session; session = nil
        if let old {
            let priorClose = closing
            closing = Task { await priorClose?.value; await old.close() }
        }
        state = .stopped
    }
}
