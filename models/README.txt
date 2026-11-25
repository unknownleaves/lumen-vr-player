Put ONNX super-resolution models (*.onnx) in this folder to bundle them with the app.

Users can also drop models into their personal models folder:
  Windows: %APPDATA%\Lumen VR Player\models
  macOS:   ~/Library/Application Support/Lumen VR Player/models
  Linux:   ~/.config/Lumen VR Player/models
(Settings → AI model → "Models folder" opens it.)

Model requirements: input [1,3,H,W] RGB in 0..1 (float32 or float16), output [1,3,H*s,W*s].
Real-ESRGAN compact models work well — see tools/export_onnx.py.
