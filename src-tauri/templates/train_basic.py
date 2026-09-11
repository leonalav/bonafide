"""
train_basic.py — Minimal PyTorch training loop.

Usage:
    python train_basic.py --max_steps N --lr LR --batch_size BS

Supports:
    --max_steps  Maximum gradient steps (default: 100)
    --lr        Learning rate (default: 1e-3)
    --batch_size Batch size (default: 32)
    --output_dir Directory to save model checkpoints (default: ./checkpoints)

On exit(0): all steps completed successfully.
On exit(1): error during training.
"""

import argparse
import sys
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset


# ── Tiny MLP for demo ────────────────────────────────────────────────────────

class TinyMLP(nn.Module):
    def __init__(self, in_dim=784, hidden=256, out_dim=10):
        super().__init__()
        self.net = nn.Sequential(
            nn.Flatten(),
            nn.Linear(in_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, out_dim),
        )

    def forward(self, x):
        return self.net(x)


def makeSyntheticDataset(n_samples=1000, in_dim=784, out_dim=10, batch_size=32):
    """Create a synthetic dataset for smoke testing."""
    X = torch.randn(n_samples, in_dim)
    y = torch.randint(0, out_dim, (n_samples,))
    dataset = TensorDataset(X, y)
    return DataLoader(dataset, batch_size=batch_size, shuffle=True)


def main():
    parser = argparse.ArgumentParser(description="Basic PyTorch training loop")
    parser.add_argument("--max_steps", type=int, default=100)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--batch_size", type=int, default=32)
    parser.add_argument("--output_dir", type=str, default="./checkpoints")
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[train_basic] device={device}, max_steps={args.max_steps}, lr={args.lr}")

    model = TinyMLP().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    loss_fn = nn.CrossEntropyLoss()
    train_loader = makeSyntheticDataset(
        n_samples=max(100, args.batch_size * 4),
        batch_size=args.batch_size,
    )

    model.train()
    step = 0
    for epoch in range(1, 1000):  # cap epochs to bound runtime
        for X_batch, y_batch in train_loader:
            X_batch, y_batch = X_batch.to(device), y_batch.to(device)
            logits = model(X_batch)
            loss = loss_fn(logits, y_batch)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            step += 1
            if step % 10 == 0:
                print(f"[train_basic] step={step}, loss={loss.item():.4f}")
            if step >= args.max_steps:
                print(f"[train_basic] Completed {step} steps — exiting.")
                sys.exit(0)
        if step >= args.max_steps:
            break

    print(f"[train_basic] Completed {step} steps — exiting.")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[train_basic] ERROR: {e}", file=sys.stderr)
        sys.exit(1)
