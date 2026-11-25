#!/usr/bin/env python3
"""
Convert a Real-ESRGAN *compact* checkpoint (.pth) to an ONNX model Lumen VR Player can load.

Supported checkpoints (from https://github.com/xinntao/Real-ESRGAN/releases):
  realesr-general-x4v3.pth        – general video / photos, 4x   (--feat 64 --conv 32)
  realesr-general-wdn-x4v3.pth    – same, with more denoising, 4x (--feat 64 --conv 32)
  realesr-animevideov3.pth        – anime / cartoons, 4x        (--feat 64 --conv 16)

Usage:
  pip install torch onnx
  python tools/export_onnx.py realesr-general-x4v3.pth models/realesr-general-x4v3.onnx --conv 32
  python tools/export_onnx.py realesr-animevideov3.pth  models/realesr-animevideov3.onnx --conv 16 --fp16

The exported graph takes float32 (or float16) NCHW RGB in [0,1] with dynamic height/width
and returns the image at 4x — exactly what the player expects. Put the .onnx file in the
app's models folder (Settings → AI model → Models folder) and it appears in the list.
"""
import argparse

import torch
import torch.nn as nn
import torch.nn.functional as F


class SRVGGNetCompact(nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=16, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
        self.body.append(nn.PReLU(num_parameters=num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        return out + F.interpolate(x, scale_factor=self.upscale, mode="nearest")


class Clamp(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        return self.net(x).clamp(0.0, 1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("weights")
    ap.add_argument("output")
    ap.add_argument("--feat", type=int, default=64)
    ap.add_argument("--conv", type=int, default=32)
    ap.add_argument("--scale", type=int, default=4)
    ap.add_argument("--fp16", action="store_true", help="export half precision (faster on most GPUs)")
    ap.add_argument("--opset", type=int, default=17)
    a = ap.parse_args()

    net = SRVGGNetCompact(num_feat=a.feat, num_conv=a.conv, upscale=a.scale)
    ckpt = torch.load(a.weights, map_location="cpu")
    state = ckpt.get("params_ema") or ckpt.get("params") or ckpt
    net.load_state_dict(state, strict=True)
    model = Clamp(net).eval()

    dummy = torch.rand(1, 3, 64, 64)
    if a.fp16:
        model = model.half()
        dummy = dummy.half()

    torch.onnx.export(
        model, dummy, a.output,
        input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {2: "height", 3: "width"}, "output": {2: "height_out", 3: "width_out"}},
        opset_version=a.opset, do_constant_folding=True,
    )
    print(f"Wrote {a.output}  ({a.scale}x, {'fp16' if a.fp16 else 'fp32'})")


if __name__ == "__main__":
    main()
