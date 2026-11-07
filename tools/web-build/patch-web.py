# -*- coding: utf-8 -*-
"""Patch the Cocos web-desktop build so its canvas matches the project.

The stock build template emits a 1280x960 (4:3) canvas while the project is
1280x720 (16:9) with ResolutionPolicy=FIXED_HEIGHT(3). With a 4:3 canvas the
visible design width is only 720*(1280/960)=960 px (x in [-480, 480]), but
EVERY panel's close button sits at design x=590 -> it is cropped off-screen.
Force the canvas/container to 16:9 so the in-game X buttons are visible again.

No overlay UI is injected: once the canvas ratio is fixed, the game's own
close buttons work. An earlier revision added a floating Back button; the
cleanup below also removes those old blocks from previously patched pages.

Usage:
    python tools/web-build/patch-web.py [web-desktop-dir | index.html]

Default target when no argument is given:
    <repo>/../runtime/client-src/build/web-desktop/index.html
    (override with the SLG_WEB_BUILD_DIR environment variable)

Idempotent: safe to re-run after every rebuild.
"""
import os
import re
import sys
from pathlib import Path

STYLE = """<!-- SLG_STYLE_START -->
<style>
  html, body { width:100%; height:100%; margin:0; padding:0; overflow:hidden; background:#14161a; }
  body { display:flex; align-items:center; justify-content:center; text-align:center; }
  h1.header, p.footer { display:none !important; }
  #GameDiv {
    width: min(100vw, 177.7778vh) !important;
    height: auto !important;
    aspect-ratio: 16 / 9;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    flex: none;
  }
  #Cocos3dGameContainer, #GameCanvas { width:100% !important; height:100% !important; }
</style>
<!-- SLG_STYLE_END -->"""


def locate_index():
    if len(sys.argv) > 1:
        p = Path(sys.argv[1])
    else:
        env = os.environ.get("SLG_WEB_BUILD_DIR")
        if env:
            p = Path(env)
        else:
            # tools/web-build/patch-web.py -> tools -> slgclient -> slg
            slg_root = Path(__file__).resolve().parents[3]
            p = slg_root / "runtime" / "client-src" / "build" / "web-desktop"
    return p / "index.html" if p.is_dir() else p


def main():
    index = locate_index()
    if not index.is_file():
        raise SystemExit("index.html not found: %s" % index)
    html = index.read_text(encoding="utf-8")

    # Remove previously injected blocks (idempotent, also cleans up the old
    # floating back button from earlier revisions)
    html = re.sub(r"<!-- SLG_STYLE_START -->[\s\S]*?<!-- SLG_STYLE_END -->\s*", "", html)
    html = re.sub(r"<!-- SLG_UI_START -->[\s\S]*?<!-- SLG_UI_END -->\s*", "", html)

    # Force a 16:9 canvas (template default is 1280x960 / 4:3)
    html, n1 = re.subn(r'<div id="GameDiv"[^>]*>', '<div id="GameDiv">', html, count=1)
    html, n2 = re.subn(
        r'(<canvas id="GameCanvas"[^>]*?)width="\d+"\s+height="\d+"',
        r'\1width="1280" height="720"', html, count=1)

    html = html.replace("</head>", STYLE + "\n</head>", 1)
    index.write_text(html, encoding="utf-8")

    print("patched:", index)
    print("  GameDiv normalized:", bool(n1), "| canvas 16:9:", bool(n2))
    print("  16:9 style injected; no overlay button")


if __name__ == "__main__":
    main()
