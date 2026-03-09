"""
Train a lightweight CNN to classify champion icons from minimap blob crops.

Usage:
    python scripts/train_champion_classifier.py

Input: assets/champion-circles/<ChampionName>/<skin_variant>.png (120x120 RGBA)
Output: models/champion_classifier.onnx (~1-5MB)

The model takes a 32x32 RGB crop (the interior of a detected minimap blob)
and predicts which champion it is. At runtime, we only need to check if a
blob matches the LOCAL player's champion (known from GEP), so even moderate
per-class accuracy is sufficient -- we just need "self" to score highest
among the ~5 detected ally blobs.

Training augmentations simulate real minimap conditions:
  - Downscale from 120px to 32px (simulates minimap icon size)
  - Circular crop (minimap icons are circles)
  - Teal border ring overlay (ally border color)
  - Fog of war darkening (random brightness reduction)
  - Color jitter (gamma, saturation, hue shifts)
  - Gaussian noise
  - Random minimap terrain background bleed
"""

import os
import sys
import random
import math
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
import torchvision.transforms as T

# -- Config --

ICONS_DIR = Path("assets/champion-circles")
OUTPUT_DIR = Path("models")
MODEL_PATH = OUTPUT_DIR / "champion_classifier.onnx"
LABEL_MAP_PATH = OUTPUT_DIR / "champion_labels.json"

IMG_SIZE = 32          # Input size for the classifier
BATCH_SIZE = 64
NUM_EPOCHS = 30
LR = 0.001
NUM_WORKERS = 0        # Windows compat (0 = main thread)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# -- Dataset --

class ChampionIconDataset(Dataset):
    """
    Loads all champion skin icons, assigns a class index per champion name.
    Each __getitem__ returns an augmented 32x32 RGB tensor + class label.
    """
    def __init__(self, icons_dir: Path, img_size: int = 32, augment: bool = True):
        self.img_size = img_size
        self.augment = augment
        self.samples: list[tuple[Path, int]] = []  # (path, class_idx)
        self.class_names: list[str] = []
        self.class_to_idx: dict[str, int] = {}

        # Build class list from directory names
        champ_dirs = sorted([
            d for d in icons_dir.iterdir()
            if d.is_dir() and any(d.glob("*.png"))
        ])
        for idx, champ_dir in enumerate(champ_dirs):
            name = champ_dir.name
            self.class_names.append(name)
            self.class_to_idx[name] = idx
            for png in champ_dir.glob("*.png"):
                self.samples.append((png, idx))

        print(f"Loaded {len(self.samples)} icons across {len(self.class_names)} champions")

        # Pre-generate some terrain color patches for background bleed augmentation
        self.terrain_colors = [
            (58, 68, 52),    # dark green (jungle)
            (72, 78, 58),    # olive (lane)
            (42, 48, 38),    # very dark (fog)
            (85, 90, 70),    # lighter terrain
            (55, 55, 45),    # neutral
        ]

    def __len__(self):
        # Oversample: each icon generates multiple augmented views per epoch
        return len(self.samples) * (4 if self.augment else 1)

    def __getitem__(self, idx):
        real_idx = idx % len(self.samples)
        path, label = self.samples[real_idx]

        img = Image.open(path).convert("RGBA")
        img = self._augment(img) if self.augment else self._basic_transform(img)

        # Convert to tensor (C, H, W), normalized to [0, 1]
        arr = np.array(img, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(arr).permute(2, 0, 1)  # HWC -> CHW
        return tensor, label

    def _basic_transform(self, img: Image.Image) -> Image.Image:
        """Minimal transform for validation: resize + circular crop + RGB."""
        img = img.resize((self.img_size, self.img_size), Image.LANCZOS)
        img = self._apply_circular_mask(img)
        return img.convert("RGB")

    def _augment(self, img: Image.Image) -> Image.Image:
        """Full augmentation simulating real minimap conditions."""
        size = self.img_size

        # 1. Random zoom-crop: real minimap icons are slightly more zoomed-in
        #    than the full circle art.  Crop a random 70-95% region, then resize.
        if random.random() < 0.6:
            crop_frac = random.uniform(0.70, 0.95)
            orig_w, orig_h = img.size
            crop_sz = int(min(orig_w, orig_h) * crop_frac)
            max_off_x = orig_w - crop_sz
            max_off_y = orig_h - crop_sz
            off_x = random.randint(0, max_off_x) if max_off_x > 0 else 0
            off_y = random.randint(0, max_off_y) if max_off_y > 0 else 0
            img = img.crop((off_x, off_y, off_x + crop_sz, off_y + crop_sz))

        # 2. Resize to target (simulates minimap downscale)
        img = img.resize((size, size), Image.LANCZOS)

        # 3. Apply circular mask (real minimap icons are circles)
        img = self._apply_circular_mask(img)

        # 4. Dark background behind transparent areas (real minimap bg is dark)
        bg_color = random.choice(self.terrain_colors)
        bg_var = tuple(c + random.randint(-10, 10) for c in bg_color)
        background = Image.new("RGBA", (size, size), bg_var + (255,))
        background.paste(img, (0, 0), img)
        img = background

        # 5. Add teal ally border ring
        img = self._add_teal_border(img, size)

        # Convert to RGB before further augmentations
        img = img.convert("RGB")

        # 6. Overall darkening (real minimap icons are consistently darker
        #    than source art — apply more aggressively than before)
        if random.random() < 0.7:
            factor = random.uniform(0.45, 0.85)
            arr = np.array(img, dtype=np.float32)
            arr *= factor
            img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))

        # 7. Brightness/contrast jitter (gamma)
        if random.random() < 0.5:
            gamma = random.uniform(0.7, 1.4)
            arr = np.array(img, dtype=np.float32) / 255.0
            arr = np.power(arr, gamma) * 255.0
            img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))

        # 8. Downscale-then-upscale (simulates small minimap icons at min scaling
        #    where the real icon is ~16-20px, then blob detector resizes to 32x32)
        if random.random() < 0.35:
            small = random.randint(12, 22)  # simulate 12-22px real icon size
            img = img.resize((small, small), Image.LANCZOS)
            img = img.resize((size, size), Image.BILINEAR)  # bilinear = blurry upscale

        # 9. Gaussian blur (wider range to cover both min and max minimap scaling)
        if random.random() < 0.4:
            img = img.filter(ImageFilter.GaussianBlur(radius=random.uniform(0.3, 1.5)))

        # 10. Gaussian noise
        if random.random() < 0.4:
            arr = np.array(img, dtype=np.float32)
            noise = np.random.normal(0, random.uniform(3, 12), arr.shape)
            arr += noise
            img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))

        # 10. Random small rotation (icons aren't perfectly aligned)
        if random.random() < 0.3:
            angle = random.uniform(-5, 5)
            img = img.rotate(angle, resample=Image.BILINEAR, fillcolor=(0, 0, 0))

        return img

    def _apply_circular_mask(self, img: Image.Image) -> Image.Image:
        """Mask to circle (minimap icons are circular)."""
        size = img.size[0]
        mask = Image.new("L", (size, size), 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse([0, 0, size - 1, size - 1], fill=255)
        img.putalpha(mask)
        return img

    def _add_teal_border(self, img: Image.Image, size: int) -> Image.Image:
        """Draw a teal circular border ring (simulates ally border)."""
        r = random.randint(0, 30)
        g = random.randint(160, 220)
        b = random.randint(160, 220)
        border_width = max(2, size // 8)  # thicker than before to match real minimap

        draw = ImageDraw.Draw(img)
        for i in range(border_width):
            # Solid outer rings, fading inward
            alpha = 220 - i * 25
            draw.ellipse(
                [i, i, size - 1 - i, size - 1 - i],
                outline=(r, g, b, max(80, alpha)),
            )
        return img


# -- Model --

class ChampionClassifier(nn.Module):
    """
    Lightweight CNN for champion icon classification.
    Input: 3x32x32 RGB, Output: num_classes logits.

    Architecture: 4 conv blocks + global avg pool + FC.
    ~300K-500K params depending on num_classes.
    """
    def __init__(self, num_classes: int):
        super().__init__()
        self.features = nn.Sequential(
            # Block 1: 32x32 -> 16x16
            nn.Conv2d(3, 32, 3, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),

            # Block 2: 16x16 -> 8x8
            nn.Conv2d(32, 64, 3, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),

            # Block 3: 8x8 -> 4x4
            nn.Conv2d(64, 128, 3, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),

            # Block 4: 4x4 -> 2x2
            nn.Conv2d(128, 256, 3, padding=1),
            nn.BatchNorm2d(256),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
        )
        self.classifier = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Dropout(0.3),
            nn.Linear(256, num_classes),
        )

    def forward(self, x):
        x = self.features(x)
        x = self.classifier(x)
        return x


# -- Training --

def train():
    print(f"Device: {DEVICE}")
    print(f"Icons dir: {ICONS_DIR}")

    # Create dataset
    full_dataset = ChampionIconDataset(ICONS_DIR, IMG_SIZE, augment=True)
    num_classes = len(full_dataset.class_names)
    print(f"Classes: {num_classes}")

    # Split: 90% train, 10% val (stratified would be ideal but random is fine here)
    val_size = max(1, len(full_dataset) // 10)
    train_size = len(full_dataset) - val_size
    train_set, val_set = torch.utils.data.random_split(full_dataset, [train_size, val_size])

    train_loader = DataLoader(train_set, batch_size=BATCH_SIZE, shuffle=True, num_workers=NUM_WORKERS)
    val_loader = DataLoader(val_set, batch_size=BATCH_SIZE, shuffle=False, num_workers=NUM_WORKERS)

    # Create model
    model = ChampionClassifier(num_classes).to(DEVICE)
    param_count = sum(p.numel() for p in model.parameters())
    print(f"Model params: {param_count:,}")

    optimizer = optim.Adam(model.parameters(), lr=LR, weight_decay=1e-4)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=NUM_EPOCHS)
    criterion = nn.CrossEntropyLoss()

    best_val_acc = 0.0
    best_state = None

    for epoch in range(NUM_EPOCHS):
        # Train
        model.train()
        total_loss = 0
        correct = 0
        total = 0
        for images, labels in train_loader:
            images, labels = images.to(DEVICE), labels.to(DEVICE)
            optimizer.zero_grad()
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

            total_loss += loss.item() * images.size(0)
            _, predicted = outputs.max(1)
            correct += predicted.eq(labels).sum().item()
            total += labels.size(0)

        train_acc = correct / total
        avg_loss = total_loss / total

        # Validate
        model.eval()
        val_correct = 0
        val_total = 0
        with torch.no_grad():
            for images, labels in val_loader:
                images, labels = images.to(DEVICE), labels.to(DEVICE)
                outputs = model(images)
                _, predicted = outputs.max(1)
                val_correct += predicted.eq(labels).sum().item()
                val_total += labels.size(0)

        val_acc = val_correct / val_total if val_total > 0 else 0
        scheduler.step()

        print(f"Epoch {epoch+1:>2}/{NUM_EPOCHS} | loss={avg_loss:.4f} | "
              f"train_acc={train_acc:.3f} | val_acc={val_acc:.3f} | "
              f"lr={scheduler.get_last_lr()[0]:.6f}")

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    print(f"\nBest validation accuracy: {best_val_acc:.3f}")

    # Restore best model
    if best_state:
        model.load_state_dict(best_state)
    model = model.to(DEVICE)

    # Save label map
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    label_map = {str(i): name for i, name in enumerate(full_dataset.class_names)}
    with open(LABEL_MAP_PATH, "w") as f:
        json.dump(label_map, f, indent=2)
    print(f"Saved label map: {LABEL_MAP_PATH} ({num_classes} classes)")

    # Export to ONNX
    export_onnx(model, num_classes)

    # Save PyTorch checkpoint too
    torch.save({
        "model_state_dict": model.state_dict(),
        "class_names": full_dataset.class_names,
        "num_classes": num_classes,
        "img_size": IMG_SIZE,
        "best_val_acc": best_val_acc,
    }, OUTPUT_DIR / "champion_classifier.pt")
    print(f"Saved PyTorch checkpoint: {OUTPUT_DIR / 'champion_classifier.pt'}")


def export_onnx(model: nn.Module, num_classes: int):
    """Export trained model to ONNX format for browser inference."""
    import onnx

    model.cpu()
    model.eval()
    dummy_input = torch.randn(1, 3, IMG_SIZE, IMG_SIZE)

    torch.onnx.export(
        model,
        dummy_input,
        str(MODEL_PATH),
        opset_version=18,
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes={
            "input": {0: "batch_size"},
            "logits": {0: "batch_size"},
        },
        dynamo=False,
    )

    # Verify
    onnx_model = onnx.load(str(MODEL_PATH))
    onnx.checker.check_model(onnx_model)

    size_mb = MODEL_PATH.stat().st_size / (1024 * 1024)
    print(f"Exported ONNX model: {MODEL_PATH} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    train()
