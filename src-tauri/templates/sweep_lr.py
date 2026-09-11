"""
sweep_lr.py — Grid-search learning rate sweep.

Usage:
    python sweep_lr.py --max_steps N --output_dir ./sweep_output

Supports:
    --max_steps   Maximum steps per configuration (default: 50)
    --output_dir  Directory to save sweep results (default: ./sweep_output)

Searches over: lr in [1e-5, 1e-4, 1e-3, 1e-2]
             batch_size in [16, 32, 64]

On exit(0): sweep completed successfully.
On exit(1): error during sweep.
"""

import argparse
import json
import os
import sys
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset


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


def makeSyntheticDataset(n_samples=200, in_dim=784, out_dim=10, batch_size=32):
    X = torch.randn(n_samples, in_dim)
    y = torch.randint(0, out_dim, (n_samples,))
    return DataLoader(
        TensorDataset(X, y), batch_size=batch_size, shuffle=True
    )


def train_for_steps(model, train_loader, optimizer, loss_fn, max_steps, device):
    model.train()
    step = 0
    total_loss = 0.0
    for epoch in range(1, 1000):
        for X_batch, y_batch in train_loader:
            X_batch, y_batch = X_batch.to(device), y_batch.to(device)
            logits = model(X_batch)
            loss = loss_fn(logits, y_batch)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
            step += 1
            if step >= max_steps:
                return total_loss / step
        if step >= max_steps:
            break
    return total_loss / max(step, 1)


def main():
    parser = argparse.ArgumentParser(description="LR sweep")
    parser.add_argument("--max_steps", type=int, default=50)
    parser.add_argument("--output_dir", type=str, default="./sweep_output")
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    os.makedirs(args.output_dir, exist_ok=True)

    lr_candidates = [1e-5, 1e-4, 1e-3, 1e-2]
    bs_candidates = [16, 32, 64]

    results = []
    for lr in lr_candidates:
        for bs in bs_candidates:
            print(f"[sweep_lr] Trying lr={lr}, bs={bs}")
            model = TinyMLP().to(device)
            optimizer = torch.optim.Adam(model.parameters(), lr=lr)
            loss_fn = nn.CrossEntropyLoss()
            train_loader = makeSyntheticDataset(batch_size=bs)
            avg_loss = train_for_steps(
                model, train_loader, optimizer, loss_fn, args.max_steps, device
            )
            result = {"lr": lr, "batch_size": bs, "avg_loss": avg_loss}
            results.append(result)
            print(f"[sweep_lr]   avg_loss={avg_loss:.4f}")

    # Save results
    out_path = os.path.join(args.output_dir, "sweep_results.json")
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"[sweep_lr] Results saved to {out_path}")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[sweep_lr] ERROR: {e}", file=sys.stderr)
        sys.exit(1)
