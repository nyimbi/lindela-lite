import Foundation
import UIKit

/// A camera capture that returns a data URL the page can attach to a report.
///
/// Native rather than `getUserMedia` for one reason that matters in the field: a
/// village handset's browser camera is frequently blocked, permission-prompted
/// per origin, or pointed at a browser tab that is in the background because the
/// person switched away for a second. The native picker asks once, at the OS
/// level, and the page gets a JPEG whether or not the web path would have.
enum CameraPicker {
    static func capture(from presenter: UIViewController, completion: @escaping ([String: Any]?) -> Void) {
        let finished = Once(completion)
        DispatchQueue.main.async {
            guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                // No camera. `nil` is the answer, and the report is filed without
                // a photo, which the app states rather than leaving blank.
                finished.call(nil)
                return
            }
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            picker.delegate = CameraDelegate(completion: finished)
            presenter.present(picker, animated: true)
        }
    }
}

final class CameraDelegate: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private let completion: Once

    init(completion: Once) { self.completion = completion }

    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage,
              let data = image.jpegData(compressionQuality: 0.7) else {
            completion.call(nil)
            return
        }
        completion.call(["dataUrl": "data:image/jpeg;base64,\(data.base64EncodedString())"])
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        completion.call(nil)
    }
}

/// Runs a completion exactly once.
///
/// A picker can report both "picked" and "cancelled" in a session, and a
/// continuation that resumes twice is a crash rather than a double callback.
final class Once {
    private var done = false
    private let body: ([String: Any]?) -> Void

    init(_ body: @escaping ([String: Any]?) -> Void) { self.body = body }

    func call(_ value: [String: Any]?) {
        guard !done else { return }
        done = true
        body(value)
    }
}
