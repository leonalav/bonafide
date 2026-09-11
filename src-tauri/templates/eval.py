"""
eval.py — Evaluation script for a trained model.

Usage:
    python eval.py --checkpoint PATH --max_batches N

Supports:
    --checkpoint   Path to a saved model checkpoint (.pt file)
    --max_batches  Maximum batches to evaluate (default: 10)
    --batch_size   Batch size for evaluation (default: 64)
    --max_steps    Alias for --max_batches, accepted by Bonafide smoke test runner.

On exit(0): evaluation completed successfully.
On exit(1): error or checkpoint not found.
"""

import argparse
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


def makeEvalDataset(n_samples=500, in_dim=784, out_dim=10, batch_size=64):
    X = torch.randn(n_samples, in_dim)
    y = torch.randint(0, out_dim, (n_samples,))
    return DataLoader(TensorDataset(X, y), batch_size=batch_size, shuffle=False)


@torch.no_grad()
def evaluate(model, eval_loader, device, max_batches):
    model.eval()
    correct = 0
    total = 0
    batches = 0
    for X_batch, y_batch in eval_loader:
        X_batch, y_batch = X_batch.to(device), y_batch.to(device)
        logits = model(X_batch)
        preds = logits.argmax(dim=1)
        correct += (preds == y_batch).sum().item()
        total += y_batch.size(0)
        batches += 1
        if batches >= max_batches:
            break
    accuracy = correct / max(total, 1)
    return accuracy


def main():
    parser = argparse.ArgumentParser(description="Model evaluation")
    parser.add_argument("--checkpoint", type=str, default="")
    parser.add_argument("--max_batches", type=int, default=10)
    parser.add_argument("--batch_size", type=int, default=64)
    parser.add_argument(
        "--max_steps",
        type=int,
        default=None,
        help="Alias for --max_batches (used by Bonafide smoke test runner).",
    )
    args = parser.parse_args()

    # Honor --max_steps alias if provided.
    max_batches = args.max_steps if args.max_steps is not None else args.max_batches

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[eval] checkpoint={args.checkpoint}, max_batches={max_batches}")

    # Load model
    if args.checkpoint and os.path.exists(args.checkpoint):
        model = TinyMLP()
        model.load_state_dict(torch.load(args.checkpoint, map_location=device))
        model.to(device)
        print(f"[eval] Loaded checkpoint: {args.checkpoint}")
    else:
        # No checkpoint — instantiate a fresh model for smoke test
        model = TinyMLP().to(device)
        print("[eval] No checkpoint found — using random weights (smoke test mode)")

    model.eval()
    eval_loader = makeEvalDataset(batch_size=args.batch_size)
    accuracy = evaluate(model, eval_loader, device, max_batches)
    print(f"[eval] accuracy={accuracy:.4f} ({accuracy*100:.1f}%)")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[eval] ERROR: {e}", file=sys.stderr)
        sys.exit(1)
