"""Aggregate the configured sensors behind one state dictionary."""

import logging

from . import sonicsensor, touchsensor

logger = logging.getLogger(__name__)

_SENSORS = (sonicsensor, touchsensor)
_initialized = False


def init():
    """Initialise every sensor, cleaning up if one fails."""
    global _initialized

    initialized = []
    try:
        for sensor in _SENSORS:
            sensor.init()
            initialized.append(sensor)
    except Exception:
        for sensor in reversed(initialized):
            try:
                sensor.cleanup()
            except Exception:
                logger.exception("Failed to clean up %s", sensor.__name__)
        raise

    _initialized = True
    logger.info(
        "Sensor controller ready: %s",
        ", ".join(sensor.__name__ for sensor in _SENSORS),
    )


def cleanup():
    """Clean up every sensor in reverse order."""
    global _initialized

    _initialized = False
    for sensor in reversed(_SENSORS):
        try:
            sensor.cleanup()
        except Exception:
            logger.exception("Failed to clean up %s", sensor.__name__)


def get_sensor_state():
    """Return every sensor's current state in one dictionary."""
    if not _initialized:
        raise RuntimeError("Sensors have not been initialised")

    state = {}
    for sensor in _SENSORS:
        state.update(sensor.read())
    return state
