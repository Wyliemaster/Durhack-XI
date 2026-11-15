"""Check the aggregated sensor controller state.

Run on the Pi with:
    python backend/tests/check_sensor_state.py

Prints sensor_controller.get_sensor_state() as JSON once per second.
Stop with Ctrl+C.
"""

import json
import sys
import time
from pathlib import Path

# Allow this script to import config.py and the sensors package from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
from sensors import sensor_controller


def main():
    config.validate()

    if config.GYRO_CALIBRATE:
        print("Initialising sensors; keep the gyro still for calibration...")
    else:
        print("Initialising sensors...")

    sensor_controller.init()

    print("Aggregated sensor state; Ctrl+C to stop.")

    try:
        while True:
            state = sensor_controller.get_sensor_state()
            print(json.dumps(state, indent=2), flush=True)
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        sensor_controller.cleanup()


if __name__ == "__main__":
    main()
