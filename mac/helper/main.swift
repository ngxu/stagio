// Stagio Mac helper: the Mac counterpart of what ps/helper.ps1 does on Windows with Windows APIs.
// One long-running process; JSON lines on stdin/stdout:
//   in:  {"id":1,"cmd":"displays","args":{}}
//   out: {"id":1,"ok":true,"data":...}   or   {"id":1,"ok":false,"error":"..."}
// Commands run one at a time on a background queue; Bluetooth runs on its own queue.
//
//   ping                          -> "pong"
//   displays                      -> [{id,name,width,height,x,y,scale,main,builtin,mirrorOf}]
//   mirror {on}                   -> "ok"       (Duplicate = every other screen mirrors the main one)
//   audio.devices                 -> {devices:[{id,name,isDefault}]}
//   audio.setDefault {id}         -> "ok"
//   show.capture {out,width,ratio}            -> "ok" | "none" | "permission" | "unsupported" | "error"
//   show.captureSlide {out,ratio,ref}         -> "ok" | "unstable" | "pointer" | "mismatch" | as above
//   ble.start / ble.stop / ble.status / ble.take / ble.publish {state,cues}   (see Ble below)
//
// Built by build/make-mac-helper.sh (swiftc, Apple silicon + Intel) on a Mac, e.g. GitHub's.

import Foundation
import AppKit
import CoreGraphics
import CoreAudio
import CoreBluetooth
import ImageIO
import ScreenCaptureKit

struct Fail: Error, CustomStringConvertible { let description: String; init(_ s: String) { description = s } }

// ---------------------------------------------------------------- output

let outLock = NSLock()
func reply(_ id: Any, ok: Bool, data: Any? = nil, error: String? = nil) {
  var obj: [String: Any] = ["id": id, "ok": ok]
  if let d = data { obj["data"] = d }
  if let e = error { obj["error"] = e }
  guard let json = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
  outLock.lock()
  FileHandle.standardOutput.write(json)
  FileHandle.standardOutput.write(Data([0x0A]))
  outLock.unlock()
}

// ---------------------------------------------------------------- screens

func displayList() -> [[String: Any]] {
  var count: UInt32 = 0
  CGGetOnlineDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetOnlineDisplayList(count, &ids, &count)
  var names: [CGDirectDisplayID: String] = [:]
  for s in NSScreen.screens {
    if let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
      names[CGDirectDisplayID(n.uint32Value)] = s.localizedName
    }
  }
  return ids.prefix(Int(count)).map { d -> [String: Any] in
    let b = CGDisplayBounds(d)
    let mode = CGDisplayCopyDisplayMode(d)
    let pw = mode?.pixelWidth ?? Int(b.width), ph = mode?.pixelHeight ?? Int(b.height)
    let scale = b.width > 0 ? Double(pw) / Double(b.width) : 1
    let mirrorOf = CGDisplayMirrorsDisplay(d)
    return [
      "id": Int(d), "name": names[d] ?? (CGDisplayIsBuiltin(d) != 0 ? "Built-in display" : "External display"),
      "width": pw, "height": ph, "x": Int(b.minX), "y": Int(b.minY), "scale": Int((scale * 100).rounded()),
      "main": CGDisplayIsMain(d) != 0, "builtin": CGDisplayIsBuiltin(d) != 0,
      "mirrorOf": mirrorOf == kCGNullDirectDisplay ? 0 : Int(mirrorOf),
    ]
  }
}

/// Duplicate (on) or Extend (off): every screen other than the main one mirrors it, or none does.
func mirror(_ on: Bool) throws -> String {
  var count: UInt32 = 0
  CGGetOnlineDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetOnlineDisplayList(count, &ids, &count)
  if count < 2 { throw Fail("Only one screen is connected") }
  var config: CGDisplayConfigRef?
  guard CGBeginDisplayConfiguration(&config) == .success, let cfg = config else { throw Fail("macOS refused to change the screens") }
  let main = CGMainDisplayID()
  for d in ids.prefix(Int(count)) where d != main {
    CGConfigureDisplayMirrorOfDisplay(cfg, d, on ? main : kCGNullDirectDisplay)
  }
  let err = CGCompleteDisplayConfiguration(cfg, .permanently)
  if err != .success { throw Fail("macOS refused to change the screens (\(err.rawValue))") }
  return "ok"
}

// ---------------------------------------------------------------- audio output devices

func audioProp<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ value: inout T) -> Bool {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr
}

func outputChannels(_ dev: AudioObjectID) -> Int {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  if AudioObjectGetPropertyDataSize(dev, &addr, 0, nil, &size) != noErr || size == 0 { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  if AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, raw) != noErr { return 0 }
  let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func audioDevices() -> [String: Any] {
  let sys = AudioObjectID(kAudioObjectSystemObject)
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size)
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &ids)
  var def = AudioObjectID(0)
  _ = audioProp(sys, kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, &def)
  var out: [[String: Any]] = []
  for d in ids where outputChannels(d) > 0 {
    var name: Unmanaged<CFString>? = nil
    var naddr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var nsize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let ok = AudioObjectGetPropertyData(d, &naddr, 0, nil, &nsize, &name) == noErr
    let n = ok ? (name?.takeRetainedValue() as String? ?? "Output \(d)") : "Output \(d)"
    out.append(["id": String(d), "name": n, "isDefault": d == def])
  }
  return ["devices": out]
}

func setDefaultOutput(_ id: AudioObjectID) throws -> String {
  let sys = AudioObjectID(kAudioObjectSystemObject)
  var dev = id
  for sel in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDefaultSystemOutputDevice] {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let err = AudioObjectSetPropertyData(sys, &addr, 0, nil, UInt32(MemoryLayout<AudioObjectID>.size), &dev)
    if err != noErr && sel == kAudioHardwarePropertyDefaultOutputDevice { throw Fail("macOS refused to switch the output (\(err))") }
  }
  return "ok"
}

// ---------------------------------------------------------------- images

func resized(_ img: CGImage, _ w: Int, _ h: Int) -> CGImage? {
  guard w > 0, h > 0, let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
  ctx.interpolationQuality = .high
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  return ctx.makeImage()
}

func saveJpeg(_ img: CGImage, _ path: String, _ quality: Double) -> Bool {
  guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.jpeg" as CFString, 1, nil) else { return false }
  CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  return CGImageDestinationFinalize(dest)
}

func loadImage(_ path: String) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// Brightness at 48 x 27, for comparing two pictures of the same thing.
func grey(_ img: CGImage) -> [Double] {
  let w = 48, h = 27
  var px = [UInt8](repeating: 0, count: w * h * 4)
  // The pixels are drawn while the buffer is held, so the context never writes into freed memory.
  let drawn: Bool = px.withUnsafeMutableBytes { buf -> Bool in
    guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
    ctx.interpolationQuality = .medium
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return true
  }
  if !drawn { return [] }
  var out = [Double](repeating: 0, count: w * h)
  for i in 0..<(w * h) {
    let r = Double(px[i * 4])
    let g = Double(px[i * 4 + 1])
    let b = Double(px[i * 4 + 2])
    out[i] = (r + g + b) / 3
  }
  return out
}

/// Average brightness difference (0-255) of two pictures.
func difference(_ a: CGImage, _ b: CGImage) -> Double {
  let x = grey(a), y = grey(b)
  if x.isEmpty || x.count != y.count { return 255 }
  return zip(x, y).reduce(0) { $0 + abs($1.0 - $1.1) } / Double(x.count)
}

/// The slide's part of a picture (a 4:3 slide on a 16:9 screen has black bars).
func slideArea(_ img: CGImage, _ ratio: Double) -> CGImage {
  let w = Double(img.width), h = Double(img.height)
  if ratio <= 0 || w <= 0 || h <= 0 { return img }
  var cw = w, ch = h
  if w / h > ratio { cw = (h * ratio).rounded() } else { ch = (w / ratio).rounded() }
  let r = CGRect(x: ((w - cw) / 2).rounded(), y: ((h - ch) / 2).rounded(), width: cw, height: ch)
  return img.cropping(to: r) ?? img
}

// ---------------------------------------------------------------- the slide show window

/// Waits for a callback-style API (ScreenCaptureKit) from this background queue.
func wait<T>(_ seconds: Double = 5, _ start: (@escaping (T?, Error?) -> Void) -> Void) -> (T?, Error?) {
  let sem = DispatchSemaphore(value: 0)
  var value: T? = nil, failure: Error? = nil
  start { v, e in value = v; failure = e; sem.signal() }
  if sem.wait(timeout: .now() + seconds) == .timedOut { return (nil, Fail("timed out")) }
  return (value, failure)
}

/// Tests only: capture the largest window of this app instead of PowerPoint's slide show.
var testBundle: String? = nil

/// PowerPoint's slide-show window: it fills a whole screen, and isn't the Presenter View.
@available(macOS 14.0, *)
func showWindow() -> (SCWindow?, String) {
  let (content, err) = wait { (done: @escaping (SCShareableContent?, Error?) -> Void) in
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { c, e in done(c, e) }
  }
  guard let c = content else {
    // No permission yet: macOS shows its question the first time, then System Settings decides.
    return (nil, err == nil ? "error" : "permission")
  }
  if let tb = testBundle?.lowercased() {
    let mine = c.windows.filter { $0.owningApplication?.bundleIdentifier.lowercased() == tb && $0.frame.width >= 100 }
    let largest = mine.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    return (largest, largest == nil ? "none" : "ok")
  }
  let ppt = c.windows.filter { $0.owningApplication?.bundleIdentifier.lowercased() == "com.microsoft.powerpoint" && $0.isOnScreen && $0.frame.width >= 320 }
  let screens = c.displays.map { $0.frame }
  let fills: (SCWindow) -> Bool = { w in screens.contains { abs($0.minX - w.frame.minX) < 2 && abs($0.minY - w.frame.minY) < 2 && abs($0.width - w.frame.width) < 2 && abs($0.height - w.frame.height) < 2 } }
  let title: (SCWindow) -> String = { ($0.title ?? "").lowercased() }
  let notPresenter = ppt.filter { !title($0).contains("presenter") }
  if let w = notPresenter.first(where: { title($0).contains("slide show") || title($0).contains("slideshow") }) { return (w, "ok") }
  if let w = notPresenter.first(where: fills) { return (w, "ok") }
  return (nil, "none")
}

@available(macOS 14.0, *)
func grab(_ w: SCWindow) -> CGImage? {
  let filter = SCContentFilter(desktopIndependentWindow: w)
  let cfg = SCStreamConfiguration()
  let scale = Double(filter.pointPixelScale)
  cfg.width = max(1, Int((Double(w.frame.width) * scale).rounded()))
  cfg.height = max(1, Int((Double(w.frame.height) * scale).rounded()))
  cfg.showsCursor = false
  cfg.ignoreShadowsSingleWindow = true
  let (img, _) = wait { (done: @escaping (CGImage?, Error?) -> Void) in
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { i, e in done(i, e) }
  }
  return img
}

/// Live PROGRAM picture: the slide (without bars), at most `width` pixels wide. The window is
/// captured itself, so it works even when Stagio or anything else is in front of it.
func captureShow(_ out: String, _ width: Int, _ ratio: Double) -> String {
  guard #available(macOS 14.0, *) else { return "unsupported" }
  let (w, why) = showWindow()
  guard let win = w else { return why }
  guard let img = grab(win) else { return "error" }
  let slide = slideArea(img, ratio)
  let ow = min(width, slide.width), oh = max(1, Int((Double(ow) * Double(slide.height) / Double(slide.width)).rounded()))
  guard let small = resized(slide, ow, oh), saveJpeg(small, out, 0.8) else { return "error" }
  return "ok"
}

/// Saves the projected slide as that slide's image (<out>.s.jpg 256 px, <out>.jpg 640 px): two
/// pictures 0.4 s apart must match (no transition or video), the pointer must be still or
/// elsewhere, and if PowerPoint's own image of the slide exists (ref), the picture must look like it.
func captureSlide(_ outBase: String, _ ratio: Double, _ ref: String) -> String {
  guard #available(macOS 14.0, *) else { return "unsupported" }
  let (w, why) = showWindow()
  guard let win = w else { return why }
  if let loc = CGEvent(source: nil)?.location, win.frame.contains(loc) {
    let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .mouseMoved)
    if idle < 4 { return "pointer" }
  }
  guard let a = grab(win) else { return "error" }
  Thread.sleep(forTimeInterval: 0.4)
  guard let b = grab(win) else { return "error" }
  if difference(a, b) > 1.5 { return "unstable" }
  let slide = slideArea(b, ratio)
  if !ref.isEmpty, let r = loadImage(ref), difference(slide, r) > 12 { return "mismatch" }
  let ratioWH = Double(slide.height) / Double(slide.width)
  guard let sm = resized(slide, 256, max(1, Int((256 * ratioWH).rounded()))), saveJpeg(sm, outBase + ".s.jpg", 0.8),
        let lg = resized(slide, 640, max(1, Int((640 * ratioWH).rounded()))), saveJpeg(lg, outBase + ".jpg", 0.85) else { return "error" }
  return "ok"
}

// ---------------------------------------------------------------- Bluetooth remote

/// The same Bluetooth service as the Windows version (see "Bluetooth remote" in ps/helper.ps1),
/// so the one remote page works with both: command (write), state (read + notify), cues (read).
final class Ble: NSObject, CBPeripheralManagerDelegate {
  static let shared = Ble()
  let serviceId = CBUUID(string: "6F6E6564-6573-6B00-0000-000000000001")
  let commandId = CBUUID(string: "6F6E6564-6573-6B00-0000-000000000002")
  let stateId = CBUUID(string: "6F6E6564-6573-6B00-0000-000000000003")
  let cuesId = CBUUID(string: "6F6E6564-6573-6B00-0000-000000000004")
  let queue = DispatchQueue(label: "stagio.ble")
  let lock = NSLock()
  var manager: CBPeripheralManager?
  var stateChar: CBMutableCharacteristic?
  var stateValue = Data("{}".utf8)
  var cuesValue = Data("[]".utf8)
  var inbox: [String] = []
  var listeners = Set<UUID>()
  var status = "off"

  func start() -> String {
    lock.lock(); let running = manager != nil; lock.unlock()
    if !running {
      let m = CBPeripheralManager(delegate: self, queue: queue)
      lock.lock(); manager = m; status = "starting"; lock.unlock()
    }
    for _ in 0..<60 {                                  // up to 6 s for Bluetooth to come up and advertise
      lock.lock(); let s = status; lock.unlock()
      if s == "Started" || s.hasPrefix("Error") || s == "unsupported" || s == "off" || s == "unauthorized" { return s }
      Thread.sleep(forTimeInterval: 0.1)
    }
    lock.lock(); let s = status; lock.unlock()
    return s
  }

  func stop() {
    lock.lock(); let m = manager; manager = nil; stateChar = nil; listeners.removeAll(); inbox.removeAll(); status = "off"; lock.unlock()
    queue.async { m?.stopAdvertising(); m?.removeAllServices() }
  }

  func statusText() -> String {
    lock.lock(); defer { lock.unlock() }
    return manager == nil ? "off" : status == "Started" ? "Started|\(listeners.count)" : status
  }

  func take() -> [String] { lock.lock(); defer { lock.unlock() }; let a = inbox; inbox.removeAll(); return a }

  func publish(_ state: String, _ cues: String?) -> Int {
    lock.lock()
    stateValue = Data(state.utf8)
    if let c = cues { cuesValue = Data(c.utf8) }
    let m = manager, ch = stateChar, value = stateValue, n = listeners.count
    lock.unlock()
    if let m = m, let ch = ch, n > 0 { queue.async { _ = m.updateValue(value, for: ch, onSubscribedCentrals: nil) } }
    return n
  }

  func peripheralManagerDidUpdateState(_ p: CBPeripheralManager) {
    switch p.state {
    case .poweredOn:
      let cmd = CBMutableCharacteristic(type: commandId, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
      let st = CBMutableCharacteristic(type: stateId, properties: [.read, .notify], value: nil, permissions: [.readable])
      let cues = CBMutableCharacteristic(type: cuesId, properties: [.read], value: nil, permissions: [.readable])
      let svc = CBMutableService(type: serviceId, primary: true)
      svc.characteristics = [cmd, st, cues]
      lock.lock(); stateChar = st; lock.unlock()
      p.removeAllServices()
      p.add(svc)
    case .unauthorized: set("unauthorized")
    case .unsupported: set("unsupported")
    case .poweredOff: set("Error: Bluetooth is switched off")
    default: break
    }
  }
  func set(_ s: String) { lock.lock(); status = s; lock.unlock() }

  func peripheralManager(_ p: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let e = error { set("Error: \(e.localizedDescription)"); return }
    p.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [serviceId], CBAdvertisementDataLocalNameKey: "Stagio"])
  }
  func peripheralManagerDidStartAdvertising(_ p: CBPeripheralManager, error: Error?) {
    set(error == nil ? "Started" : "Error: \(error!.localizedDescription)")
  }
  func peripheralManager(_ p: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    lock.lock(); let all = request.characteristic.uuid == stateId ? stateValue : cuesValue; lock.unlock()
    if request.offset > all.count { p.respond(to: request, withResult: .invalidOffset); return }
    request.value = all.subdata(in: request.offset..<all.count)       // long reads come in pieces
    p.respond(to: request, withResult: .success)
  }
  func peripheralManager(_ p: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    lock.lock()
    for r in requests { if let v = r.value, let s = String(data: v, encoding: .utf8), inbox.count < 200 { inbox.append("\(r.central.identifier.uuidString)\t\(s)") } }
    lock.unlock()
    if let first = requests.first { p.respond(to: first, withResult: .success) }
  }
  func peripheralManager(_ p: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
    lock.lock(); listeners.insert(central.identifier); lock.unlock()
  }
  func peripheralManager(_ p: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
    lock.lock(); listeners.remove(central.identifier); lock.unlock()
  }
}

// ---------------------------------------------------------------- commands

func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? Double(v as? String ?? "") ?? 0 }

func handle(_ cmd: String, _ a: [String: Any]) throws -> Any {
  switch cmd {
  case "ping": return "pong"
  case "displays": return displayList()
  case "mirror": return try mirror((a["on"] as? Bool) ?? false)
  case "audio.devices": return audioDevices()
  case "audio.setDefault":
    guard let id = AudioObjectID(String(describing: a["id"] ?? "")) else { throw Fail("Unknown device") }
    return try setDefaultOutput(id)
  case "test.useApp": testBundle = (a["bundle"] as? String).flatMap { $0.isEmpty ? nil : $0 }; return "ok"
  case "show.capture": return captureShow(a["out"] as? String ?? "", Int(num(a["width"])) > 0 ? Int(num(a["width"])) : 960, num(a["ratio"]))
  case "show.captureSlide": return captureSlide(a["out"] as? String ?? "", num(a["ratio"]), a["ref"] as? String ?? "")
  case "ble.start": return Ble.shared.start()
  case "ble.stop": Ble.shared.stop(); return true
  case "ble.status": return Ble.shared.statusText()
  case "ble.take": return Ble.shared.take()
  case "ble.publish": return Ble.shared.publish(a["state"] as? String ?? "{}", a["cues"] as? String)
  default: throw Fail("Unknown command: \(cmd)")
  }
}

let work = DispatchQueue(label: "stagio.commands")
DispatchQueue.global().async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    let id = obj["id"] ?? 0
    let cmd = obj["cmd"] as? String ?? ""
    let args = obj["args"] as? [String: Any] ?? [:]
    work.async {
      do { reply(id, ok: true, data: try handle(cmd, args)) } catch { reply(id, ok: false, error: "\(error)") }
    }
  }
  exit(0) // Stagio closed our input: it has quit
}
RunLoop.main.run()
