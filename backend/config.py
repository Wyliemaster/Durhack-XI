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
