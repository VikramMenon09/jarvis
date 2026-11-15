// Jarvis.app: a native window onto the local Jarvis service, plus its ears and voice.
import Cocoa
import WebKit
import AVFoundation
import Speech

let serviceURL = URL(string: "http://127.0.0.1:4747/app")!

/// The invisible title bar: drag it to move the window, double-click to zoom, like any Mac app.
final class DragStrip: NSView {
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { window?.zoom(nil) } else { window?.performDrag(with: event) }
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, AVSpeechSynthesizerDelegate {
    var window: NSWindow!
    var web: WKWebView!

    // voice out
    let synth = AVSpeechSynthesizer()
    let probe = AVSpeechSynthesizer()      // renders the same sentence silently to measure its loudness curve
    var envelope: [Float] = []
    var envTimer: Timer?
    var speakStart = Date()
    var speakToken = 0

    // voice in
    let engine = AVAudioEngine()
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var listening = false
    var heard = ""
    var silence: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "jarvis")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 700),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 720, height: 540)
        let root = NSView(frame: window.contentLayoutRect)
        web.frame = root.bounds
        web.autoresizingMask = [.width, .height]
        root.addSubview(web)
        let strip = DragStrip(frame: NSRect(x: 0, y: root.bounds.height - 44, width: root.bounds.width, height: 44))
        strip.autoresizingMask = [.width, .minYMargin]
        root.addSubview(strip)
        window.contentView = root
        window.center()
        window.setFrameAutosaveName("JarvisWindow2")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        synth.delegate = self
        buildMenu()
        load()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "New Conversation", action: #selector(newChat), keyEquivalent: "n")
        appMenu.addItem(withTitle: "Recentre", action: #selector(recentre), keyEquivalent: "0")
        appMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Jarvis", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Jarvis", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winItem.submenu = win
        NSApp.mainMenu = main
    }
    @objc func reload() { load() }
    @objc func newChat() { web.evaluateJavaScript("window.jarvisCmd && window.jarvisCmd('new')", completionHandler: nil) }
    @objc func recentre() { web.evaluateJavaScript("window.jarvisCmd && window.jarvisCmd('center')", completionHandler: nil) }
    func load() { web.load(URLRequest(url: serviceURL, cachePolicy: .reloadIgnoringLocalCacheData)) }
    func retry() { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.load() } }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { retry() }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { retry() }

    func send(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.web.evaluateJavaScript("window.native && window.native(\(s))", completionHandler: nil) }
    }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "listen": startListening()
        case "stopListen": finishListening()
        case "speak":
            voiceName = body["voice"] as? String ?? ""
            speak(body["text"] as? String ?? "")
        case "stopSpeak": stopSpeaking()
        default: break
        }
    }

    // MARK: voice out
    var voiceName = ""
    func voice() -> AVSpeechSynthesisVoice? {
        if !voiceName.isEmpty {
            let q: (AVSpeechSynthesisVoice) -> Int = { $0.quality == .premium ? 2 : $0.quality == .enhanced ? 1 : 0 }
            let named = AVSpeechSynthesisVoice.speechVoices().filter { $0.name.lowercased().contains(self.voiceName.lowercased()) }
            if let v = named.max(by: { q($0) < q($1) }) { return v }
        }
        let gb = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "en-GB" }
        let rank: (AVSpeechSynthesisVoice) -> Int = { v in
            (v.quality == .premium ? 300 : v.quality == .enhanced ? 200 : 0) + (v.gender == .male ? 50 : 0) + (v.name.contains("Daniel") ? 10 : 0)
                - (["Grandpa", "Grandma", "Rocko", "Eddy", "Flo", "Sandy", "Shelley", "Reed"].contains { v.name.contains($0) } ? 40 : 0)
        }
        return gb.max { rank($0) < rank($1) } ?? AVSpeechSynthesisVoice(language: "en-GB")
    }
    func utterance(_ text: String) -> AVSpeechUtterance {
        let u = AVSpeechUtterance(string: text)
        u.voice = voice()
        u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.04
        return u
    }
    func speak(_ text: String) {
        stopSpeaking()
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { send(["type": "speakEnd"]); return }
        speakToken += 1
        let token = speakToken
        envelope = []
        var acc: Float = 0, count = 0
        probe.write(utterance(text)) { [weak self] buf in
            guard let self = self, let b = buf as? AVAudioPCMBuffer, b.frameLength > 0 else { return }
            let chunk = max(1, Int(b.format.sampleRate / 30))
            var out: [Float] = []
            let n = Int(b.frameLength)
            for i in 0..<n {
                var v: Float = 0
                if let f = b.floatChannelData { v = f[0][i] }
                else if let s = b.int16ChannelData { v = Float(s[0][i]) / 32768 }
                else if let s = b.int32ChannelData { v = Float(s[0][i]) / 2147483648 }
                acc += v * v; count += 1
                if count >= chunk { out.append(min(1, (acc / Float(count)).squareRoot() * 5)); acc = 0; count = 0 }
            }
            DispatchQueue.main.async { if token == self.speakToken { self.envelope.append(contentsOf: out) } }
        }
        synth.speak(utterance(text))
    }
    func stopSpeaking() {
        speakToken += 1
        if probe.isSpeaking { probe.stopSpeaking(at: .immediate) }
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        envTimer?.invalidate(); envTimer = nil
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        speakStart = Date()
        send(["type": "speakStart"])
        envTimer?.invalidate()
        envTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let i = Int(Date().timeIntervalSince(self.speakStart) * 30)
            let v: Float = i < self.envelope.count ? self.envelope[i] : 0.25 + 0.2 * Float(sin(Date().timeIntervalSince(self.speakStart) * 9))
            self.send(["type": "level", "v": v])
        }
    }
    func ended() { envTimer?.invalidate(); envTimer = nil; send(["type": "level", "v": 0]); send(["type": "speakEnd"]) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { ended() }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { ended() }

    // MARK: voice in
    func startListening() {
        guard !listening else { return }
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                self.send(["type": "error", "text": "Speech recognition is off for Jarvis. Turn it on in System Settings, Privacy & Security, Speech Recognition."]); return
            }
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async {
                    if ok { self.beginCapture() }
                    else { self.send(["type": "error", "text": "The microphone is off for Jarvis. Turn it on in System Settings, Privacy & Security, Microphone."]) }
                }
            }
        }
    }
    func beginCapture() {
        guard !listening, let recognizer = recognizer, recognizer.isAvailable else {
            send(["type": "error", "text": "Speech recognition is not available right now."]); return
        }
        stopSpeaking()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        heard = ""
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { send(["type": "error", "text": "No microphone found."]); return }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in
            req.append(buf)
            guard let f = buf.floatChannelData else { return }
            var acc: Float = 0
            let n = Int(buf.frameLength)
            for i in 0..<n { acc += f[0][i] * f[0][i] }
            let rms = n > 0 ? (acc / Float(n)).squareRoot() : 0
            self?.send(["type": "level", "v": min(1, rms * 9)])
        }
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            send(["type": "error", "text": "I could not open the microphone."]); return
        }
        listening = true
        armSilence(8)
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, self.listening else { return }
                if let r = result {
                    self.heard = r.bestTranscription.formattedString
                    self.send(["type": "partial", "text": self.heard])
                    if r.isFinal { self.finishListening() } else { self.armSilence(1.5) }
                } else if error != nil { self.finishListening() }
            }
        }
    }
    func armSilence(_ seconds: TimeInterval) {
        silence?.invalidate()
        silence = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in self?.finishListening() }
    }
    func finishListening() {
        guard listening else { return }
        listening = false
        silence?.invalidate(); silence = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        task = nil; request = nil
        send(["type": "level", "v": 0])
        send(["type": "final", "text": heard])
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
