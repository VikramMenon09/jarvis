import Cocoa
// Draws the Jarvis icon: a ring of dots around a dotted core, white on black.
let size = 1024.0
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
NSColor.black.setFill()
NSBezierPath(roundedRect: NSRect(x: 60, y: 60, width: size - 120, height: size - 120), xRadius: 200, yRadius: 200).fill()
func dot(_ x: Double, _ y: Double, _ r: Double, _ a: Double) {
    NSColor(white: 1, alpha: a).setFill()
    NSBezierPath(ovalIn: NSRect(x: x - r, y: y - r, width: r * 2, height: r * 2)).fill()
}
let c = size / 2
for i in 0..<48 { let a = Double(i) / 48 * 2 * .pi; dot(c + cos(a) * 330, c + sin(a) * 330, 9, 0.9) }
for i in 0..<28 { let a = Double(i) / 28 * 2 * .pi + 0.1; dot(c + cos(a) * 260, c + sin(a) * 260, 5, 0.45) }
for i in 0..<420 {
    let y = 1 - 2 * (Double(i) + 0.5) / 420, r = (1 - y * y).squareRoot(), t = Double(i) * 2.399963
    let x = cos(t) * r, z = sin(t) * r
    dot(c + x * 170, c + y * 170, 3 + (z + 1) * 3, 0.2 + (z + 1) * 0.4)
}
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
