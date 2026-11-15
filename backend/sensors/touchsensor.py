"""Touch sensor access."""

import logging
import os
import threading
import time

import config

# Must be set before gpiozero is imported. This also lets the user override it.
os.environ.setdefault("GPIOZERO_PIN_FACTORY", "lgpio")

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_touch = None
_last_error_log = 0.0


def init():
    """Create the touch sensor GPIO device."""
    global _touch

    if _touch is not None:
        return

    from gpiozero import Button

    touch = None
    try:
        touch = Button(
            config.TOUCH_PIN,
            pull_up=config.TOUCH_ACTIVE_LOW,
            bounce_time=config.TOUCH_BOUNCE_S,
        )
    except Exception as exc:
        if touch is not None:
            try:
                touch.close()
            except Exception:
                pass
        raise RuntimeError(
            "Could not initialise the touch sensor. Check the wiring and pin "
            "number, and make sure lgpio is available."
        ) from exc

    with _lock:
        _touch = touch

    logger.info(
        "Touch sensor ready: GPIO%d (%s)",
        config.TOUCH_PIN,
        "active-low" if config.TOUCH_ACTIVE_LOW else "active-high",
    )


def cleanup():
    """Close the touch sensor GPIO device."""
    global _touch

    with _lock:
        if _touch is not None:
            try:
                _touch.close()
            except Exception:
                logger.exception("Failed to close the touch sensor")
        _touch = None

    logger.info("Touch sensor released")


def is_pressed():
    """Return True while the touch sensor is pressed."""
    with _lock:
        if _touch is None:
            raise RuntimeError("Touch sensor has not been initialised")
        return bool(_touch.is_pressed)


def read():
    """Return {'touch': bool}."""
    with _lock:
        if _touch is None:
            raise RuntimeError("Touch sensor has not been initialised")

        try:
            pressed = bool(_touch.is_pressed)
        except Exception:
            _log_read_error()
            return {"touch": False}

        logger.debug("touch=%s", pressed)
        return {"touch": pressed}


def _log_read_error():
    global _last_error_log

    now = time.monotonic()
    if now - _last_error_log >= 1.0:
        logger.exception("Touch sensor read failed; reporting false")
        _last_error_log = now
