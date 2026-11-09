import SwiftUI

struct LiveRadioView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var model: LiveRadioModel
    let stationId: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("TrackZero live radio").font(.title)
            Text("Join the current broadcast. Songs cannot be selected or skipped.")
            Button("Play live station") {
                if let stationId { model.play(stationId: stationId) }
            }
            .disabled(stationId == nil || model.state == .connecting || model.state == .playing)
            Button("Stop") { model.stop() }.disabled(model.state == .stopped)
            Text(stationId == nil ? "Choose a station" : model.state.label)
                .accessibilityAddTraits(.updatesFrequently)
        }
        .padding()
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { phase in if phase != .active { model.stop() } }
    }
}
