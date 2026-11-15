"""Standalone HC-SR04 check.

Run on the Pi with:
    python backend/tests/check_sonic.py

Prints the measured distance once per second. Stop with Ctrl+C.
"""

import sys
import time
from pathlib import Path

# Allow this script to import config.py and the sensors package from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
from sensors import sonicsensor


def main():
    config.validate()
    sonicsensor.init()

    print(
        f"HC-SR04 on TRIG=GPIO{config.SONIC_TRIG_PIN} "
        f"ECHO=GPIO{config.SONIC_ECHO_PIN}; Ctrl+C to stop."
    )

    try:
        while True:
            distance_cm = sonicsensor.read_distance_cm()
            if distance_cm is None:
                print("no echo / out of range", flush=True)
            else:
                print(f"{distance_cm:7.1f} cm", flush=True)
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        sonicsensor.cleanup()


if __name__ == "__main__":
    main()
