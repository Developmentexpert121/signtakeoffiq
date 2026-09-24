#!/bin/bash
# Ensures Python dependencies are installed, then starts the PDF sidecar.
# Use this instead of `python3 main.py` directly so packages are
# auto-restored if uv sync ever clears .pythonlibs.
set -e
cd "$(dirname "$0")"
uv pip install -q -r requirements.txt 2>/dev/null || true
exec python3 main.py
