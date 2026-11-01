import XCTest
@testable import TrackZero

private final class FakeSession: LiveRadioSession {
    var starts = 0
    var closes = 0
    var onClose: (() async -> Void)?
    func start() async throws { starts += 1 }
    func close() async { closes += 1; await onClose?() }
}
private actor CloseGate {
    private var released = false
    private var waiter: CheckedContinuation<Void, Never>?
    func wait() async {
        if released { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func release() { released = true; waiter?.resume(); waiter = nil }
}
private struct FakeEngine: LiveRadioEngine {
    let join: (String) async throws -> any LiveRadioSession
    func joinLive(stationId: String) async throws -> any LiveRadioSession {
        try await join(stationId)
    }
}

@MainActor final class LiveRadioModelTests: XCTestCase {
    func testExplicitStartAndStop() async {
        let session = FakeSession()
        let model = LiveRadioModel(engine: FakeEngine(join: { _ in session }))
        XCTAssertEqual(model.state, .stopped)
        model.play(stationId: "s1")
        await Task.yield()
        await Task.yield()
        XCTAssertEqual(model.state, .playing)
        model.stop()
        await Task.yield()
        XCTAssertEqual(model.state, .stopped)
        XCTAssertEqual(session.starts, 1)
        XCTAssertEqual(session.closes, 1)
    }
    func testInvalidStationDoesNotJoin() async {
        var joins = 0
        let model = LiveRadioModel(engine: FakeEngine(join: { _ in
            joins += 1; return FakeSession()
        }))
        model.play(stationId: "../other")
        XCTAssertEqual(model.state, .interrupted)
        XCTAssertEqual(joins, 0)
    }
    func testInterruptedJoinDoesNotClaimPlayback() async {
        enum Offline: Error { case unavailable }
        let model = LiveRadioModel(engine: FakeEngine(join: { _ in throw Offline.unavailable }))
        model.play(stationId: "s1")
        await Task.yield()
        XCTAssertNotEqual(model.state, .playing)
    }
    func testNextStationWaitsForPreviousSessionClose() async {
        let first = FakeSession(), second = FakeSession(), gate = CloseGate()
        first.onClose = { await gate.wait() }
        var joins = 0
        let model = LiveRadioModel(engine: FakeEngine(join: { _ in
            joins += 1
            return joins == 1 ? first : second
        }))
        model.play(stationId: "station-a")
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(joins, 1)
        model.play(stationId: "station-b")
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(joins, 1)
        await gate.release()
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(joins, 2)
        XCTAssertEqual(first.closes, 1)
    }
}
