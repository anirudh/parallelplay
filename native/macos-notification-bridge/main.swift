import AppKit
import Foundation
import UserNotifications

final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    guard
      response.actionIdentifier == UNNotificationDefaultActionIdentifier,
      let raw = response.notification.request.content.userInfo["deepLink"] as? String,
      let url = URL(string: raw),
      ["127.0.0.1", "localhost"].contains(url.host ?? ""),
      ["http", "https"].contains(url.scheme ?? ""),
      url.user == nil,
      url.password == nil,
      url.path.hasPrefix("/decisions/"),
      URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.allSatisfy({
        $0.name == "revision"
      }) == true
    else { return }
    NSWorkspace.shared.open(url)
  }
}

final class Bridge {
  private let center = UNUserNotificationCenter.current()
  private let delegate = NotificationDelegate()
  private let output = FileHandle.standardOutput

  init() {
    center.delegate = delegate
  }

  private func respond(
    requestId: String,
    result: [String: Any]? = nil,
    error: String? = nil
  ) {
    var value: [String: Any] = [
      "schemaVersion": 1,
      "requestId": requestId,
      "ok": error == nil,
    ]
    if let result { value["result"] = result }
    if let error { value["error"] = ["code": error] }
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
      return
    }
    output.write(data)
    output.write(Data([0x0A]))
  }

  func handle(_ line: String) {
    guard
      let data = line.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      value.keys.allSatisfy({ ["schemaVersion", "requestId", "operation", "input"].contains($0) }),
      value["schemaVersion"] as? Int == 1,
      let requestId = value["requestId"] as? String,
      UUID(uuidString: requestId) != nil,
      let operation = value["operation"] as? String,
      let input = value["input"] as? [String: Any]
    else {
      respond(requestId: "00000000-0000-4000-8000-000000000000", error: "protocol_invalid")
      return
    }

    switch operation {
    case "deliver":
      deliver(requestId: requestId, input: input)
    case "query":
      query(requestId: requestId, input: input)
    case "close":
      guard input.isEmpty else {
        respond(requestId: requestId, error: "protocol_invalid")
        return
      }
      respond(requestId: requestId, result: ["closed": true])
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exit(EXIT_SUCCESS) }
    default:
      respond(requestId: requestId, error: "unsupported_operation")
    }
  }

  private func deliver(requestId: String, input: [String: Any]) {
    guard
      Set(input.keys) == Set(["identifier", "title", "body", "deepLink"]),
      let identifier = input["identifier"] as? String,
      identifier.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      let title = input["title"] as? String,
      !title.isEmpty,
      title.utf8.count <= 120,
      let body = input["body"] as? String,
      !body.isEmpty,
      body.utf8.count <= 1000,
      let deepLink = input["deepLink"] as? String,
      let url = URL(string: deepLink),
      ["127.0.0.1", "localhost"].contains(url.host ?? ""),
      ["http", "https"].contains(url.scheme ?? ""),
      url.user == nil,
      url.password == nil,
      url.path.hasPrefix("/decisions/")
    else {
      respond(requestId: requestId, error: "protocol_invalid")
      return
    }
    center.requestAuthorization(options: [.alert]) { [weak self] granted, _ in
      guard let self else { return }
      guard granted else {
        self.respond(requestId: requestId, error: "notification_permission_denied")
        return
      }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.userInfo = ["deepLink": deepLink]
      self.center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) {
        [weak self] error in
        guard let self else { return }
        if error != nil {
          self.respond(requestId: requestId, error: "notification_delivery_failed")
        } else {
          self.respond(requestId: requestId, result: ["systemId": identifier])
        }
      }
    }
  }

  private func query(requestId: String, input: [String: Any]) {
    guard
      Set(input.keys) == Set(["identifier"]),
      let identifier = input["identifier"] as? String,
      identifier.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    else {
      respond(requestId: requestId, error: "protocol_invalid")
      return
    }
    center.getDeliveredNotifications { [weak self] notifications in
      guard let self else { return }
      let delivered = notifications.contains { $0.request.identifier == identifier }
      self.respond(
        requestId: requestId,
        result: ["status": delivered ? "delivered" : "not_delivered"]
      )
    }
  }
}

let bridge = Bridge()
DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine(strippingNewline: true) {
    DispatchQueue.main.async { bridge.handle(line) }
  }
  DispatchQueue.main.async { exit(EXIT_SUCCESS) }
}
RunLoop.main.run()
