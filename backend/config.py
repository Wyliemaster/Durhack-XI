"""Configuration for the sensor backend.

Values are read from environment variables when the module is imported. The
defaults match the wiring described in README.md.
"""

import logging
import os


def _env_int(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from None


def _env_float(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {raw!r}") from None


def _env_bool(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(
        f"{name} must be a boolean (1/0, true/false, yes/no, on/off), got {raw!r}"
    )


def _env_hex(name, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw, 16)
    except ValueError:
        raise ValueError(
            f"{name} must be a hexadecimal integer like 0x68, got {raw!r}"
        ) from None


HOST = os.environ.get("SENSOR_HOST", "0.0.0.0").strip()
PORT = _env_int("SENSOR_PORT", 5001)

SONIC_TRIG_PIN = _env_int("SONIC_TRIG_PIN", 23)
SONIC_ECHO_PIN = _env_int("SONIC_ECHO_PIN", 24)
TOUCH_PIN = _env_int("TOUCH_PIN", 17)

SONIC_TRIGGER_CM = _env_float("SONIC_TRIGGER_CM", 30.0)
SONIC_RELEASE_CM = _env_float("SONIC_RELEASE_CM", 35.0)
SONIC_MAX_DISTANCE_M = _env_float("SONIC_MAX_DISTANCE_M", 1.0)

TOUCH_ACTIVE_LOW = _env_bool("TOUCH_ACTIVE_LOW", False)
TOUCH_BOUNCE_S = _env_float("TOUCH_BOUNCE_S", 0.02)

GYRO_I2C_BUS = _env_int("GYRO_I2C_BUS", 1)
GYRO_I2C_ADDRESS = _env_hex("GYRO_I2C_ADDRESS", 0x68)
GYRO_RANGE_DPS = _env_int("GYRO_RANGE_DPS", 500)
GYRO_CALIBRATE = _env_bool("GYRO_CALIBRATE", True)
GYRO_CALIBRATION_SAMPLES = _env_int("GYRO_CALIBRATION_SAMPLES", 200)

LOG_LEVEL_NAME = os.environ.get("LOG_LEVEL", "INFO").strip().upper()
LOG_LEVEL = getattr(logging, LOG_LEVEL_NAME, None)
if not isinstance(LOG_LEVEL, int):
    raise ValueError(f"LOG_LEVEL must be a standard logging level, got {LOG_LEVEL_NAME!r}")


def validate():
    """Validate related settings before the sensors are initialised."""
    if not HOST:
        raise ValueError("SENSOR_HOST must not be empty")

    if not 1 <= PORT <= 65535:
        raise ValueError(f"SENSOR_PORT must be between 1 and 65535, got {PORT}")

    pins = {
        "SONIC_TRIG_PIN": SONIC_TRIG_PIN,
        "SONIC_ECHO_PIN": SONIC_ECHO_PIN,
        "TOUCH_PIN": TOUCH_PIN,
    }
    for name, pin in pins.items():
        if not 0 <= pin <= 27:
            raise ValueError(
                f"{name} must be a BCM GPIO number between 0 and 27, got {pin}"
            )
    if len(set(pins.values())) != len(pins):
        raise ValueError(
            "SONIC_TRIG_PIN, SONIC_ECHO_PIN and TOUCH_PIN must all be different"
        )

    if SONIC_TRIGGER_CM <= 0:
        raise ValueError(
            f"SONIC_TRIGGER_CM must be greater than 0, got {SONIC_TRIGGER_CM}"
        )
    if SONIC_RELEASE_CM < SONIC_TRIGGER_CM:
        raise ValueError(
            "SONIC_RELEASE_CM must be greater than or equal to SONIC_TRIGGER_CM"
        )
    if SONIC_MAX_DISTANCE_M <= 0:
        raise ValueError(
            f"SONIC_MAX_DISTANCE_M must be greater than 0, got {SONIC_MAX_DISTANCE_M}"
        )
    if SONIC_MAX_DISTANCE_M > 5.0:
        raise ValueError(
            "SONIC_MAX_DISTANCE_M must be at most 5.0; "
            f"got {SONIC_MAX_DISTANCE_M}"
        )
    if SONIC_MAX_DISTANCE_M * 100.0 <= SONIC_RELEASE_CM:
        raise ValueError(
            "SONIC_MAX_DISTANCE_M must be greater than SONIC_RELEASE_CM; "
            f"got {SONIC_MAX_DISTANCE_M} m and {SONIC_RELEASE_CM} cm"
        )

    if TOUCH_BOUNCE_S < 0:
        raise ValueError(
            f"TOUCH_BOUNCE_S must be zero or greater, got {TOUCH_BOUNCE_S}"
        )

    if not 0 <= GYRO_I2C_BUS <= 10:
        raise ValueError(
            f"GYRO_I2C_BUS must be between 0 and 10, got {GYRO_I2C_BUS}"
        )
    if not 0x08 <= GYRO_I2C_ADDRESS <= 0x77:
        raise ValueError(
            "GYRO_I2C_ADDRESS must be between 0x08 and 0x77, "
            f"got 0x{GYRO_I2C_ADDRESS:02X}"
        )
    if GYRO_RANGE_DPS not in {250, 500, 1000, 2000}:
        raise ValueError(
            "GYRO_RANGE_DPS must be one of 250, 500, 1000 or 2000, "
            f"got {GYRO_RANGE_DPS}"
        )
    if not 1 <= GYRO_CALIBRATION_SAMPLES <= 2000:
        raise ValueError(
            "GYRO_CALIBRATION_SAMPLES must be between 1 and 2000, "
            f"got {GYRO_CALIBRATION_SAMPLES}"
        )
