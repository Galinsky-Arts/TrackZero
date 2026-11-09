// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "TrackZero", platforms: [.macOS(.v14), .iOS(.v16)],
    products: [.library(name: "TrackZero", targets: ["TrackZero"])],
    targets: [.target(name: "TrackZero", path: "TrackZero"),
              .testTarget(name: "TrackZeroTests", dependencies: ["TrackZero"], path: "TrackZeroTests")])
