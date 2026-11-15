"""Standalone joystick check.

Run on the Pi with:
    python backend/tests/check_joystick.py

Prints raw ADC values and the switch state several times per second.
Stop with Ctrl+C.
"""

import sys
import time
from pathlib import Path

# Allow this script to import config.py and the sensors package from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config
from sensors import joysticksensor


def main():
    config.validate()
    joysticksensor.init()

    print(
        f"Joystick: ADS7830 at 0x{config.JOYSTICK_I2C_ADDRESS:02X} "
        f"on I2C bus {config.JOYSTICK_I2C_BUS}, "
        f"SW=GPIO{config.JOYSTICK_BUTTON_PIN}; Ctrl+C to stop."
    )

    try:
        while True:
            state = joysticksensor.read()["joystick"]
            button = "pressed" if state["button"] else "released"
            print(
                f"x={state['x']:3d}  y={state['y']:3d}  button={button}",
                flush=True,
            )
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        joysticksensor.cleanup()


if __name__ == "__main__":
    main()
