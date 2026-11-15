"""Standalone MPU6050 gyroscope check.

Run on the Pi with:
    python backend/tests/check_gyro.py

Prints angular rates once per second. Stop with Ctrl+C.
"""

import sys
import time
from pathlib import Path

# Allow this script to import config.py and the sensors package from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
from sensors import gyrosensor


def main():
    config.validate()

    if config.GYRO_CALIBRATE:
        print("Initialising MPU6050; keep it still for calibration...")
    else:
        print("Initialising MPU6050...")

    gyrosensor.init()

    print(
        f"MPU6050 on I2C bus {config.GYRO_I2C_BUS} "
        f"address 0x{config.GYRO_I2C_ADDRESS:02X}; Ctrl+C to stop."
    )

    try:
        while True:
            values = gyrosensor.read_gyro_dps()
            print(
                f"x={values['x']:7.2f}  "
                f"y={values['y']:7.2f}  "
                f"z={values['z']:7.2f} °/s",
                flush=True,
            )
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        gyrosensor.cleanup()


if __name__ == "__main__":
    main()
