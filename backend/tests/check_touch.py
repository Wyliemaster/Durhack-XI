"""Standalone touch sensor check.

Run on the Pi with:
    python backend/tests/check_touch.py

Prints the touch state once per second. Stop with Ctrl+C.
"""

import sys
import time
from pathlib import Path

# Allow this script to import config.py and sensors.py from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
import sensors


def main():
    config.validate()
    sensors.init()

    print(
        f"Touch sensor on GPIO{config.TOUCH_PIN} "
        f"({'active-low' if config.TOUCH_ACTIVE_LOW else 'active-high'}); "
        "Ctrl+C to stop."
    )

    try:
        while True:
            state = "touched" if sensors.read_touch() else "not touched"
            print(state, flush=True)
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        sensors.cleanup()


if __name__ == "__main__":
    main()
